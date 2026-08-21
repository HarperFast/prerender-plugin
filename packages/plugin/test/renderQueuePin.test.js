import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * THE WEDGED ROW: a due row whose render never posts a result, on an otherwise healthy node.
 *
 * This is the accepted cost of the claim floor, and the shape it takes in production. The floor
 * cannot advance past the oldest DUE row, and the only thing that moves a row is its own result — a
 * lease expiring does not, because claiming writes nothing. The generic-failure branch in
 * `processDecodedJobResult` (target exists → hold the lease, write no schedule row, count no strike)
 * is where every renderer crash, navigation timeout and settle failure lands, so one such URL used
 * to pin the floor at its own minute FOREVER while dead index entries piled up above it at the full
 * render rate: ~43ms per claim after a day, worse than the 6.25ms unfloored scan the floor replaces.
 *
 * Two things are pinned here, and each of them failed a review round before it worked:
 *
 *   - IT IS REPORTED. The `floorHeldBy` warning used to be chained onto the scan-cap branch
 *     (`scanTruncated && jobs.length < limit`), which requires the whole scan window to be consumed
 *     by due rows. On a healthy node with ONE wedged row the pass reaches a not-yet-due row every
 *     time, so that condition is false forever and the single scenario the report was written for
 *     was the one scenario it could never print. The test below therefore asserts the warning fires
 *     while the scan-cap warning does NOT.
 *   - IT IS BOUNDED. Past `queue.claimFloor.unpinAfter` the claim path writes that one row forward
 *     itself. It must do so through the funnel (so `fromSitemap` survives — `put` REPLACES the
 *     record) and it must NOT touch `strikes`, which is the target's one shared counter that
 *     suppression and redirect verdicts delete targets on.
 *
 * The clock is stubbed rather than waited out, which works because `util/renderSchedule.js` hands
 * the lease table a late-bound `() => Date.now()` wrapper for exactly this reason. Everything else —
 * the config, the thresholds, the intervals — is left at its shipped default, so this also asserts
 * that the defaults are coherent: the warning must fire before the push, and the push must be later
 * than the retry lanes' legitimate pin.
 */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const T0 = 1_700_000_400_000;

const WEDGED = 'https://www.example.com/wedged|desktop';
const LATER = 'https://www.example.com/later|desktop';

let RenderQueue, QueueState, funnel, config;

const schedule = new Map();
const targets = new Map();
const sabs = new Map();
let warns = [];
let errors = [];
let nowMs = T0;
const realDateNow = Date.now;

/** Enough of a Harper resource for the queue: static get/put/delete, plus the claim search. */
const makeTable = (rows) =>
	class FakeTable {
		static async get(query) {
			const id = typeof query === 'object' ? query.id : query;
			const row = rows.get(id);
			if (!row) return null;
			const select = typeof query === 'object' ? query.select : undefined;
			if (typeof select === 'string') return row[select];
			if (Array.isArray(select)) return Object.fromEntries(select.map((name) => [name, row[name]]));
			return { ...row };
		}
		static async put(id, data) {
			rows.set(id, { ...data });
		}
		static async patch(id, data) {
			rows.set(id, { ...(rows.get(id) ?? {}), ...data });
		}
		static async delete(id) {
			return rows.delete(id);
		}
		/** The one-sided `nextRenderTime >= value` condition, the sort, and the limit. */
		static async *search(query = {}) {
			const [condition] = query.conditions ?? [];
			const floor = condition ? Number(condition.value) : Number.NEGATIVE_INFINITY;
			const matching = [...rows.entries()]
				.map(([cacheKey, row]) => ({ cacheKey, ...row }))
				.filter((row) => Number(row.nextRenderTime) >= floor)
				.sort((a, b) => Number(a.nextRenderTime) - Number(b.nextRenderTime))
				.slice(0, query.limit ?? Infinity);
			for (const row of matching) yield row;
		}
	};

before(async () => {
	Date.now = () => nowMs;
	globalThis.Resource = class {};
	globalThis.server = {
		hostname: 'test-node',
		nodes: [],
		config: { http: { port: 9926 } },
		recordAnalytics: () => {},
	};
	globalThis.logger = {
		info() {},
		warn: (msg) => warns.push(String(msg)),
		error: (msg) => errors.push(String(msg)),
	};
	globalThis.createBlob = (buf) => buf;
	globalThis.databases = {
		coordination: {
			SharedBuffer: {
				primaryStore: {
					// KEYED. QueueState and the render-lease table acquire from this store under different
					// names; an unkeyed fake hands each one its own zeroed buffer and every lease
					// assertion here would pass for the wrong reason.
					getUserSharedBuffer: (key, buf) => {
						if (!sabs.has(key)) sabs.set(key, buf);
						return sabs.get(key);
					},
					tryLock: () => true,
					unlock() {},
				},
			},
		},
		render_service: {
			Target: makeTable(targets),
			QueueControl: makeTable(new Map()),
			QueueStatus: makeTable(new Map()),
		},
		render_schedule: { RenderSchedule: makeTable(schedule) },
		page_cache: { PrerenderedPage: makeTable(new Map()) },
	};

	({ config } = await import('../src/config.js'));
	({ QueueState } = await import('../src/resources/QueueState.js'));
	({ RenderQueue } = await import('../src/resources/RenderQueue.js'));
	funnel = await import('../src/util/renderSchedule.js');
});

after(() => {
	Date.now = realDateNow;
});

beforeEach(() => {
	schedule.clear();
	targets.clear();
	warns = [];
	errors = [];
	// Well past the previous test's warning window, so this file's per-worker warning rate limiter
	// cannot swallow the line a test is asserting on.
	nowMs += 7 * DAY;
	// The shared buffer outlives the map clears above: without this the floor, the leases and the
	// recorded pin all leak into the next test.
	funnel.resetRenderQueueState();
	QueueState.reportStatus('empty', true);
});

/**
 * One wedged row, plus a row that is not due for a week.
 *
 * The second row is the whole point of the arrangement: it makes the pass reach a not-yet-due row,
 * which is what sets `scanTruncated` false and made the old warning unreachable. Seeded straight
 * into the fake table, which bypasses the funnel and so lowers no floor — fine only because
 * `beforeEach` has just reset the floor to 0.
 */
const seed = ({ fromSitemap = true } = {}) => {
	targets.set('https://www.example.com/wedged', { url: 'https://www.example.com/wedged', renderInterval: DAY });
	schedule.set(WEDGED, { nextRenderTime: nowMs - MINUTE, fromSitemap });
	schedule.set(LATER, { nextRenderTime: nowMs + 7 * DAY, fromSitemap: false });
};

const pinWarnings = () => warns.filter((line) => line.includes('has held the claim floor'));
const scanCapWarnings = () => warns.filter((line) => line.includes('scan cap'));
const unpinWarnings = () => warns.filter((line) => line.includes("held the claim queue's floor"));

test('a wedged row on a HEALTHY node is warned about — the case the old gate could never report', async () => {
	seed();

	// The row is granted and its renderer never posts anything. Nothing else moves it, so it stays
	// the oldest due row for as long as the node runs.
	assert.equal((await RenderQueue.claim({ limit: 5 })).length, 1, 'the wedged row is granted');
	assert.equal(pinWarnings().length, 0, 'nothing is wrong yet — a pin only matters once it lasts');

	// `render.failureRetry.fastRetries` fast retries hold the lease, and therefore the floor,
	// legitimately. Just inside that window there must still be no warning, or every origin blip
	// pages somebody.
	const explainable = config.queue.jobLeaseTime * (config.render.failureRetry.fastRetries + 1);
	nowMs += explainable - MINUTE;
	await RenderQueue.claim({ limit: 5 });
	assert.equal(pinWarnings().length, 0, 'a pin the retry lanes can account for is not an anomaly');

	// Past it, the pin is no longer explainable by any lane.
	nowMs += 2 * MINUTE;
	await RenderQueue.claim({ limit: 5 });

	const [warning] = pinWarnings();
	assert.ok(warning, 'the wedged row is reported');
	assert.ok(warning.includes(WEDGED), 'BY NAME — a floor lag on its own does not say which row');
	assert.equal(
		scanCapWarnings().length,
		0,
		'and the branch this used to hang off never fired: the scan reached a not-yet-due row every pass, ' +
			'which is exactly why one wedged row on a healthy node used to be reported by nothing at all'
	);
});

test('the pin warning is rate-limited, not emitted once per claim', async () => {
	seed();
	const explainable = config.queue.jobLeaseTime * (config.render.failureRetry.fastRetries + 1);

	await RenderQueue.claim({ limit: 5 });
	nowMs += explainable + MINUTE;

	for (let i = 0; i < 5; i++) await RenderQueue.claim({ limit: 5 });
	assert.equal(pinWarnings().length, 1, 'five claims inside one window produce one line');

	nowMs += explainable + MINUTE;
	await RenderQueue.claim({ limit: 5 });
	assert.equal(pinWarnings().length, 2, 'and the next window says so again, since nothing has been fixed');
});

test('past unpinAfter the row is written forward, preserving fromSitemap and counting NO strike', async () => {
	seed({ fromSitemap: true });

	await RenderQueue.claim({ limit: 5 });
	const dueBefore = schedule.get(WEDGED).nextRenderTime;

	nowMs += config.queue.claimFloor.unpinAfter + MINUTE;
	await RenderQueue.claim({ limit: 5 });

	const row = schedule.get(WEDGED);
	assert.ok(Number(row.nextRenderTime) > Number(dueBefore), 'the wedged row moved');
	assert.equal(
		Number(row.nextRenderTime),
		nowMs + config.render.defaultInterval,
		'forward by one render interval — enough to unpin the floor, not a suppression'
	);
	assert.equal(row.fromSitemap, true, 'through the funnel, so `put` replacing the record cannot clear this');

	const target = targets.get('https://www.example.com/wedged');
	assert.equal(target.strikes, undefined, 'NO strike: that counter is what suppression deletes targets on');
	assert.equal(target.state, undefined, 'and the target is not suppressed either');

	const [warning] = unpinWarnings();
	assert.ok(warning?.includes(WEDGED), 'the push is reported by name');
});

test('the push is ONE RENDER INTERVAL as every other writer resolves it — route beats stored beats default', async () => {
	// Two properties, and the second is the one worth a test. The push must be the row's OWN cadence,
	// so a 1h page is not parked for a day and a 48h page does not come back due long before its
	// cadence. And because every other schedule writer files `completionMinute + interval`, the value
	// filed here is also what any reader inferring "when did this last render" gets back via
	// `nextRenderTime - interval` — a flat `render.defaultInterval` made this the one writer whose rows
	// lied to that arithmetic, reading as a completion 24h in the past on this 48h route.
	const routes = config.ingress.routes;
	// The seeded target ALSO carries a stored interval of DAY, so this pins the precedence too.
	config.ingress.routes = [{ match: 'prefix', path: '/wedged', renderInterval: 2 * DAY }];
	try {
		seed();
		await RenderQueue.claim({ limit: 5 });

		nowMs += config.queue.claimFloor.unpinAfter + MINUTE;
		await RenderQueue.claim({ limit: 5 });

		const filed = Number(schedule.get(WEDGED).nextRenderTime);
		assert.equal(filed, nowMs + 2 * DAY, 'the route’s cadence, not render.defaultInterval');
		const { resolveRenderInterval } = await import('../src/util/routeClass.js');
		assert.equal(
			filed - resolveRenderInterval('https://www.example.com/wedged', DAY),
			nowMs,
			'so a reader inferring "the minute the last render completed" from the row gets NOW, not a fake past'
		);
	} finally {
		config.ingress.routes = routes;
	}
});

test('once the row moves, the floor advances past it and the next row starts its own clock', async () => {
	seed();
	await RenderQueue.claim({ limit: 5 });

	nowMs += config.queue.claimFloor.unpinAfter + MINUTE;
	await RenderQueue.claim({ limit: 5 });
	assert.equal(unpinWarnings().length, 1);

	// The pin is cleared with the write. Without that the promoted row would inherit this one's age
	// and be pushed forward on the very next pass, which is how an escape hatch turns into a sweep.
	assert.equal(funnel.floorState(nowMs).floorPinnedForMs, 0);

	// Nothing is due any more, so the pass has no floor holder at all.
	const jobs = await RenderQueue.claim({ limit: 5 });
	assert.deepEqual(jobs, [], 'the wedged row is no longer due and the later row is still in the future');
	assert.equal(unpinWarnings().length, 1, 'and the hatch does not fire again on an empty queue');
});

test('unpinAfter: 0 leaves the row pinned, and says so instead of pretending it will heal', async () => {
	const original = config.queue.claimFloor.unpinAfter;
	try {
		config.queue.claimFloor.unpinAfter = 0;
		seed();

		await RenderQueue.claim({ limit: 5 });
		const dueBefore = schedule.get(WEDGED).nextRenderTime;

		nowMs += 3 * DAY;
		await RenderQueue.claim({ limit: 5 });

		assert.equal(schedule.get(WEDGED).nextRenderTime, dueBefore, 'the row is left exactly where it was');
		assert.equal(unpinWarnings().length, 0, 'nothing was pushed');
		const [warning] = pinWarnings();
		assert.ok(warning?.includes('will NOT resolve on its own'), 'and the warning does not promise a repair');
	} finally {
		config.queue.claimFloor.unpinAfter = original;
	}
});

test('the escape hatch is off with the floor off: an unfloored scan is not held back by any row', async () => {
	const original = config.queue.claimFloor.enabled;
	try {
		config.queue.claimFloor.enabled = false;
		seed();

		await RenderQueue.claim({ limit: 5 });
		const dueBefore = schedule.get(WEDGED).nextRenderTime;

		nowMs += config.queue.claimFloor.unpinAfter + MINUTE;
		await RenderQueue.claim({ limit: 5 });

		assert.equal(schedule.get(WEDGED).nextRenderTime, dueBefore, 'no row is rewritten');
		assert.equal(pinWarnings().length, 0, 'and nothing is warned about');
		assert.equal(errors.length, 0);
	} finally {
		config.queue.claimFloor.enabled = original;
	}
});

test('THE UPGRADE PATH: the hatch still fires for a row carrying no cadence, and files one', async () => {
	// `seed` writes rows with no `effectiveInterval`, which is the shape of EVERY row on a node until
	// it has re-rendered once — so this is the state of the whole corpus on deploy day.
	//
	// The bug this pins was invisible in every other test here: the hatch reads the cadence off the row
	// and hands it back to `writeSchedule`, whose guard REFUSES `undefined`. The refusal lands inside
	// the hatch's own try/catch, is logged and swallowed, and the hatch does nothing while reporting
	// nothing — so the one mechanism that bounds a wedged row would have been dead on arrival, on every
	// node, for a full cadence after the upgrade.
	seed();
	assert.equal(schedule.get(WEDGED).effectiveInterval, undefined, 'precondition: a pre-upgrade row');

	await RenderQueue.claim({ limit: 5 });
	nowMs += config.queue.claimFloor.unpinAfter + MINUTE;
	await RenderQueue.claim({ limit: 5 });

	assert.equal(unpinWarnings().length, 1, 'the hatch fired');
	const row = schedule.get(WEDGED);
	assert.equal(Number(row.nextRenderTime), nowMs + config.render.defaultInterval, 'pushed by the resolved cadence');
	// And the row is left self-describing, so the sweep that ranks it next does not have to resolve it
	// again — and `nextRenderTime - effectiveInterval` still reads back as "completed now".
	assert.equal(Number(row.effectiveInterval), config.render.defaultInterval, 'the push records the cadence it used');
	assert.equal(Number(row.nextRenderTime) - Number(row.effectiveInterval), nowMs);
});

test('...and a row that DOES carry a cadence is pushed by that, not by the route', async () => {
	// The residual the hatch used to have to state in a comment: it resolved route > default only, so a
	// target whose cadence came from anywhere else (a stored `changefreq`, a demand-ladder rung) was
	// pushed by the wrong distance. A carried cadence closes it — 6h here, against the target's stored
	// DAY and no route interval at all.
	seed();
	schedule.get(WEDGED).effectiveInterval = 6 * 60 * MINUTE;

	await RenderQueue.claim({ limit: 5 });
	nowMs += config.queue.claimFloor.unpinAfter + MINUTE;
	await RenderQueue.claim({ limit: 5 });

	assert.equal(unpinWarnings().length, 1);
	assert.equal(
		Number(schedule.get(WEDGED).nextRenderTime),
		nowMs + 6 * 60 * MINUTE,
		"the row's own cadence, not render.defaultInterval and not the target's stored DAY"
	);
});
