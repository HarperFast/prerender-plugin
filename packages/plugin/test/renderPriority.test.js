import { test, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Priority ordering of the due set — `util/renderPriority.js` on its own, and then driven through
 * `runClaimPass` so the interaction with the claim floor is pinned rather than assumed.
 *
 * What is pinned here, and why each one is a bug that no other test in this package would catch:
 *
 *   - THE FLOOR IS STILL DERIVED IN INDEX ORDER. This is the whole hazard of the change. The floor
 *     is "the due minute of the first due row the pass observed", and if that observation moves to
 *     the PRIORITY-ordered walk it becomes the minute of the most-overdue-by-ratio row instead of
 *     the minimum — and every row below it is stranded forever, silently. So: a pass whose priority
 *     order is the exact reverse of its index order must still advance the floor to the earliest
 *     due minute in the window.
 *   - LATENESS, NOT AGE. A 7-day suppression recheck coming due on a 48h route must NOT outrank a
 *     genuinely late page. This is the one formula error that would quietly invert the release's
 *     whole purpose, promoting exactly the rechecks it exists to make cheaper.
 *   - THE STORED CADENCE BEATS THE ROUTE FALLBACK. Without it a demand-ladder promotion is invisible
 *     to ordering, so the pages the ladder singled out as most-visited are ranked at their route's
 *     ceiling — the opposite of promoting them.
 *   - A DISABLED PASS IS THE OLD PASS, EXACTLY. Same grants, same order, same early stop at
 *     `grantLimit`. The kill switch has to be a revert, not a re-weighting.
 *   - THE BOOST CANNOT BECOME A LANE. A discovered row that is far enough behind must beat a
 *     sitemap row that is not, or `sitemapBoost` is a starvation mechanism.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = 1_700_000_400_000; // a whole minute
const minuteOf = (ms) => Math.floor(ms / MINUTE);

let priority, funnel, lease;

const sabs = new Map();

before(async () => {
	globalThis.server = { hostname: 'test-node', nodes: [], config: { http: { port: 9926 } } };
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {} };
	globalThis.databases = {
		coordination: {
			SharedBuffer: {
				primaryStore: {
					getUserSharedBuffer: (key, buffer) => {
						if (!sabs.has(key)) sabs.set(key, buffer);
						return sabs.get(key);
					},
					tryLock: () => true,
					unlock() {},
				},
			},
		},
		render_schedule: { RenderSchedule: { put: async () => {}, delete: async () => {}, search: () => [] } },
	};

	priority = await import('../src/util/renderPriority.js');
	funnel = await import('../src/util/renderSchedule.js');
	lease = await import('../src/util/renderLease.js');
});

// ---- the scoring function ----------------------------------------------------------------------

test('a page late by one of its own intervals scores 1, whatever that interval is', () => {
	const home = priority.overdueRatio(
		{ nextRenderTime: T0 - HOUR, fromSitemap: false },
		{ nowMs: T0, intervalMs: HOUR }
	);
	const pdp = priority.overdueRatio(
		{ nextRenderTime: T0 - 48 * HOUR, fromSitemap: false },
		{ nowMs: T0, intervalMs: 48 * HOUR }
	);
	assert.equal(home, 1);
	assert.equal(pdp, 1);
});

test('the config-documented inversion: a 1h page 2h late outranks a 48h page 3h late', () => {
	const home = priority.overdueRatio(
		{ nextRenderTime: T0 - 2 * HOUR, fromSitemap: false },
		{ nowMs: T0, intervalMs: HOUR }
	);
	const pdp = priority.overdueRatio(
		{ nextRenderTime: T0 - 3 * HOUR, fromSitemap: false },
		{ nowMs: T0, intervalMs: 48 * HOUR }
	);
	// Absolute due time says the PDP (3h > 2h). The ratio says the homepage, by ~32x.
	assert.ok(home > pdp, `${home} should beat ${pdp}`);
	assert.equal(home, 2);
});

test('a row scored at its exact due moment is 0, not negative, even with the clock behind it', () => {
	assert.equal(priority.overdueRatio({ nextRenderTime: T0, fromSitemap: false }, { nowMs: T0, intervalMs: HOUR }), 0);
	assert.equal(
		priority.overdueRatio({ nextRenderTime: T0 + HOUR, fromSitemap: false }, { nowMs: T0, intervalMs: HOUR }),
		0
	);
});

test('a zero or negative interval degrades to raw lateness instead of Infinity or a sign flip', () => {
	assert.equal(priority.overdueRatio({ nextRenderTime: T0 - 5 }, { nowMs: T0, intervalMs: 0 }), 5);
	assert.equal(priority.overdueRatio({ nextRenderTime: T0 - 5 }, { nowMs: T0, intervalMs: -HOUR }), 5);
});

test('LATENESS, NOT AGE: a 7-day suppression recheck coming due does not outrank a late page', () => {
	// The row `Target.suppress` wrote: due now, but scheduled 7 days ago and scored against the
	// 48h route cadence. Under an age-based formula this reads as 3.5 intervals stale and wins.
	const recheck = priority.overdueRatio(
		{ nextRenderTime: T0, fromSitemap: false },
		{ nowMs: T0, intervalMs: 48 * HOUR }
	);
	const latePdp = priority.overdueRatio(
		{ nextRenderTime: T0 - 6 * HOUR, fromSitemap: false },
		{ nowMs: T0, intervalMs: 48 * HOUR }
	);
	assert.equal(recheck, 0);
	assert.ok(latePdp > recheck);
});

test('a backed-off retry enters at the back of the due set, not the front', () => {
	// `backoffWait` can push a 48h key out by `maxBackoff`. When it comes due, the gap that preceded
	// it was days — but its lateness is zero, so it queues behind anything genuinely overdue.
	const backedOff = priority.overdueRatio(
		{ nextRenderTime: T0, fromSitemap: false },
		{ nowMs: T0, intervalMs: 48 * HOUR }
	);
	const slightlyLate = priority.overdueRatio(
		{ nextRenderTime: T0 - MINUTE, fromSitemap: false },
		{ nowMs: T0, intervalMs: 48 * HOUR }
	);
	assert.ok(slightlyLate > backedOff);
});

// ---- ordering ----------------------------------------------------------------------------------

const order = (rows, { nowMs = T0, sitemapBoost = 2, intervals = {} } = {}) =>
	priority
		.orderByPriority(rows, (cacheKey) => intervals[cacheKey] ?? DAY, { nowMs, sitemapBoost })
		.map((row) => row.cacheKey);

test('short-cadence routes come first under a backlog that is late for everyone', () => {
	const rows = [
		{ cacheKey: 'pdp', nextRenderTime: T0 - 4 * HOUR, fromSitemap: false, renderInterval: 48 * HOUR },
		{ cacheKey: 'catalog', nextRenderTime: T0 - 3 * HOUR, fromSitemap: false, renderInterval: 6 * HOUR },
		{ cacheKey: 'home', nextRenderTime: T0 - 2 * HOUR, fromSitemap: false, renderInterval: HOUR },
	];
	// Index order is exactly the reverse of the right answer: pdp is the oldest in absolute terms.
	assert.deepEqual(order(rows), ['home', 'catalog', 'pdp']);
});

test('sitemap wins at equal overdue ratio, and the tiebreak still works at ratio 0', () => {
	const late = [
		{ cacheKey: 'discovered', nextRenderTime: T0 - HOUR, fromSitemap: false, renderInterval: HOUR },
		{ cacheKey: 'listed', nextRenderTime: T0 - HOUR, fromSitemap: true, renderInterval: HOUR },
	];
	assert.deepEqual(order(late), ['listed', 'discovered']);

	// At ratio 0 the multiplicative boost vanishes (0 x 2 === 0), so the preference has to come from
	// the explicit tiebreak or it disappears in exactly the caught-up case.
	const onTime = [
		{ cacheKey: 'discovered', nextRenderTime: T0, fromSitemap: false, renderInterval: HOUR },
		{ cacheKey: 'listed', nextRenderTime: T0, fromSitemap: true, renderInterval: HOUR },
	];
	assert.deepEqual(order(onTime), ['listed', 'discovered']);
});

test('the boost is a multiplier, not a lane: a far-behind discovered row beats a fresher sitemap one', () => {
	const rows = [
		{ cacheKey: 'listed', nextRenderTime: T0 - HOUR, fromSitemap: true, renderInterval: HOUR }, // 1 x 2 = 2
		{ cacheKey: 'discovered', nextRenderTime: T0 - 3 * HOUR, fromSitemap: false, renderInterval: HOUR }, // 3
	];
	assert.deepEqual(order(rows), ['discovered', 'listed']);
});

test('sitemapBoost: 1 leaves ordering on overdue ratio alone', () => {
	const rows = [
		{ cacheKey: 'listed', nextRenderTime: T0 - HOUR, fromSitemap: true, renderInterval: HOUR },
		{ cacheKey: 'discovered', nextRenderTime: T0 - 2 * HOUR, fromSitemap: false, renderInterval: HOUR },
	];
	assert.deepEqual(order(rows, { sitemapBoost: 1 }), ['discovered', 'listed']);
});

test('equal priority keeps FIFO, so a caught-up node orders exactly as the index delivered it', () => {
	const rows = [
		{ cacheKey: 'a', nextRenderTime: T0 - 3 * MINUTE, fromSitemap: false, renderInterval: HOUR },
		{ cacheKey: 'b', nextRenderTime: T0 - 2 * MINUTE, fromSitemap: false, renderInterval: HOUR },
		{ cacheKey: 'c', nextRenderTime: T0 - MINUTE, fromSitemap: false, renderInterval: HOUR },
	];
	assert.deepEqual(order(rows), ['a', 'b', 'c']);
});

test('THE STORED CADENCE BEATS THE ROUTE FALLBACK, which is what makes a ladder promotion visible', () => {
	// Both rows are 3h late on a route declaring a 24h ceiling. One has been promoted by the demand
	// ladder to 6h and carries that on its row; the other has never been evaluated.
	const rows = [
		{ cacheKey: 'ceiling', nextRenderTime: T0 - 3 * HOUR, fromSitemap: false },
		{ cacheKey: 'promoted', nextRenderTime: T0 - 3 * HOUR, fromSitemap: false, renderInterval: 6 * HOUR },
	];
	assert.deepEqual(order(rows, { intervals: { ceiling: 24 * HOUR, promoted: 24 * HOUR } }), ['promoted', 'ceiling']);
});

test('an absent, NaN or non-positive stored cadence falls back to the resolver rather than scoring wrong', () => {
	for (const stored of [undefined, Number.NaN, 0, -1]) {
		const rows = [
			{ cacheKey: 'slow', nextRenderTime: T0 - HOUR, fromSitemap: false, renderInterval: 48 * HOUR },
			{ cacheKey: 'unstamped', nextRenderTime: T0 - HOUR, fromSitemap: false, renderInterval: stored },
		];
		// The fallback says `unstamped` is an hourly page, so one hour late outranks the 48h row.
		assert.deepEqual(order(rows, { intervals: { unstamped: HOUR } }), ['unstamped', 'slow'], `stored=${stored}`);
	}
});

// ---- through the claim pass, against the floor -------------------------------------------------

const harness = ({ rows, slots = 256, now = T0, leaseTimeMs = 10 * MINUTE } = {}) => {
	const leases = lease.createLeaseTable({
		buffer: new ArrayBuffer(lease.leaseBufferBytes(slots)),
		slots,
		now: () => now,
	});
	const searchSchedules = ({ floorMinute, limit }) =>
		(async function* () {
			const matching = rows
				.filter((row) => Number(row.nextRenderTime) >= floorMinute * MINUTE)
				.sort((a, b) => Number(a.nextRenderTime) - Number(b.nextRenderTime))
				.slice(0, limit);
			for (const row of matching) yield { ...row };
		})();

	return {
		leases,
		pass: (options = {}) =>
			funnel.runClaimPass({
				searchSchedules,
				leases,
				nowMs: now,
				grantLimit: 20,
				guardMinutes: 5,
				scanCap: 1000,
				leaseTimeMs,
				floorEnabled: true,
				...options,
			}),
	};
};

// The orderer production passes, with every row's cadence supplied inline so this needs no config.
const prioritizeWith =
	(intervals, sitemapBoost = 2) =>
	(candidates, nowMs) =>
		priority.orderByPriority(candidates, (cacheKey) => intervals[cacheKey] ?? DAY, { nowMs, sitemapBoost });

test('THE FLOOR IS STILL THE EARLIEST DUE MINUTE when priority reverses the grant order', async () => {
	// Three rows, all due, and the priority order is the exact reverse of the index order. If the
	// floor were derived from the granted order it would land on `home`'s minute and strand the
	// other two — permanently, because a floor is a value and nothing re-reads below it.
	const rows = [
		{ cacheKey: 'pdp', nextRenderTime: T0 - 4 * HOUR, fromSitemap: false },
		{ cacheKey: 'catalog', nextRenderTime: T0 - 3 * HOUR, fromSitemap: false },
		{ cacheKey: 'home', nextRenderTime: T0 - 2 * HOUR, fromSitemap: false },
	];
	const { pass } = harness({ rows });
	const result = await pass({
		prioritize: prioritizeWith({ pdp: 48 * HOUR, catalog: 6 * HOUR, home: HOUR }),
	});

	assert.deepEqual(
		result.jobs.map((j) => j.cacheKey),
		['home', 'catalog', 'pdp']
	);
	assert.equal(result.floorTo, minuteOf(T0 - 4 * HOUR), 'floor must be the earliest due minute, not the first granted');
	assert.equal(result.floorHeldBy, 'pdp', 'the row NAMED as holding the floor is the earliest due one');
});

test('priority chooses which rows get the leases when the window holds more than grantLimit', async () => {
	// 6 due rows, 2 leases to give. Index order would hand them to the two oldest-in-absolute-terms
	// (the PDPs); priority hands them to the two most overdue relative to their own cadence.
	const rows = [
		{ cacheKey: 'pdp-1', nextRenderTime: T0 - 6 * HOUR, fromSitemap: false },
		{ cacheKey: 'pdp-2', nextRenderTime: T0 - 5 * HOUR, fromSitemap: false },
		{ cacheKey: 'catalog-1', nextRenderTime: T0 - 4 * HOUR, fromSitemap: false },
		{ cacheKey: 'catalog-2', nextRenderTime: T0 - 3 * HOUR, fromSitemap: false },
		{ cacheKey: 'home-1', nextRenderTime: T0 - 2 * HOUR, fromSitemap: false },
		{ cacheKey: 'home-2', nextRenderTime: T0 - MINUTE, fromSitemap: false },
	];
	const intervals = {
		'pdp-1': 48 * HOUR,
		'pdp-2': 48 * HOUR,
		'catalog-1': 6 * HOUR,
		'catalog-2': 6 * HOUR,
		'home-1': HOUR,
		'home-2': HOUR,
	};

	// `candidatePool` is the whole reason this test can pass: the default window is `grantLimit` past
	// the lease pile, so at grantLimit 2 the pass would drain 4 rows and never see the homepages.
	const prioritized = await harness({ rows }).pass({
		grantLimit: 2,
		candidatePool: 6,
		prioritize: prioritizeWith(intervals),
	});
	assert.deepEqual(
		prioritized.jobs.map((j) => j.cacheKey),
		['home-1', 'catalog-1']
	);

	// The same trace with the kill switch: index order, and it stops after two rows.
	const indexOrder = await harness({ rows }).pass({ grantLimit: 2 });
	assert.deepEqual(
		indexOrder.jobs.map((j) => j.cacheKey),
		['pdp-1', 'pdp-2']
	);
	// Both derive the same floor. That is the invariant the reordering must not be able to touch.
	assert.equal(prioritized.floorTo, indexOrder.floorTo);
});

test('a disabled pass stops at grantLimit and never reads past it — the switch is a revert', async () => {
	const rows = Array.from({ length: 40 }, (_, i) => ({
		cacheKey: `k${String(i).padStart(2, '0')}`,
		nextRenderTime: T0 - (40 - i) * MINUTE,
		fromSitemap: false,
	}));

	const off = await harness({ rows }).pass({ grantLimit: 5 });
	assert.deepEqual(
		off.jobs.map((j) => j.cacheKey),
		['k00', 'k01', 'k02', 'k03', 'k04']
	);
	// Reaching a not-yet-due row is what proves the window was not truncated; a pass that stopped at
	// grantLimit never reaches one, and `scanTruncated` reads off exactly that pair.
	assert.equal(off.earliestNotYetDueMinute, 0);

	// With priority on, the same window is walked to the end — so it now knows there was no
	// not-yet-due row to reach either, and still grants only 5.
	const on = await harness({ rows }).pass({ grantLimit: 5, prioritize: prioritizeWith({}) });
	assert.equal(on.jobs.length, 5);
});

test('leased rows are skipped, still pin the floor, and are never granted twice', async () => {
	const rows = [
		{ cacheKey: 'stuck', nextRenderTime: T0 - 10 * HOUR, fromSitemap: false },
		{ cacheKey: 'home', nextRenderTime: T0 - 2 * HOUR, fromSitemap: false },
	];
	const { pass, leases } = harness({ rows });
	leases.grant('stuck', { dueMinute: minuteOf(T0 - 10 * HOUR), leaseExpiryMs: T0 + HOUR });

	const result = await pass({ prioritize: prioritizeWith({ stuck: 48 * HOUR, home: HOUR }) });
	assert.deepEqual(
		result.jobs.map((j) => j.cacheKey),
		['home']
	);
	assert.equal(result.skippedLeased, 1);
	// The in-flight row is the earliest due row the pass observed, so it holds the floor — priority
	// ordering must not let the floor skip past a row whose result may still be arriving.
	assert.equal(result.floorTo, minuteOf(T0 - 10 * HOUR));
});

test('not-yet-due rows are never granted however urgent their cadence would make them', async () => {
	const rows = [
		{ cacheKey: 'due', nextRenderTime: T0 - MINUTE, fromSitemap: false },
		{ cacheKey: 'future', nextRenderTime: T0 + HOUR, fromSitemap: false },
	];
	const { pass } = harness({ rows });
	const result = await pass({ prioritize: prioritizeWith({ due: 48 * HOUR, future: MINUTE }) });
	assert.deepEqual(
		result.jobs.map((j) => j.cacheKey),
		['due']
	);
	assert.equal(result.earliestNotYetDueMinute, minuteOf(T0 + HOUR));
});

test('a BigInt due time from a Long column scores rather than throwing on the subtraction', async () => {
	const rows = [
		{ cacheKey: 'big', nextRenderTime: BigInt(T0 - 3 * HOUR), fromSitemap: false, renderInterval: BigInt(HOUR) },
		{ cacheKey: 'small', nextRenderTime: T0 - 2 * HOUR, fromSitemap: false, renderInterval: HOUR },
	];
	const { pass } = harness({ rows });
	const result = await pass({ prioritize: prioritizeWith({}) });
	assert.deepEqual(
		result.jobs.map((j) => j.cacheKey),
		['big', 'small']
	);
});
