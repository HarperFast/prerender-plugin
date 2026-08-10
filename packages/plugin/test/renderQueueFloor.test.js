import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The claim-floor algebra, over `runClaimPass`.
 *
 * `runClaimPass` takes its search, its lease table and its clock as arguments, so everything here
 * runs without a database. What is pinned:
 *
 *   - THE QUERY SHAPE. Exactly one condition, `greater_than_equal`, on `nextRenderTime`, with a
 *     same-attribute sort, an ARRAY select, and `replicateFrom: false`. A second condition, an
 *     exclusive comparator or a string select each breaks this in a way no unit test elsewhere
 *     would notice.
 *   - TIES. ~1,100 keys share every minute at the recorded corpus, and every "due now" writer
 *     writes the same minute. An exclusive advance would strand a whole minute per pass.
 *   - THE FLOOR RULE, against the rule it replaced. The rejected "floor = last granted" rule is
 *     driven through the SAME 1,189-row trace and must strand rows; the shipped rule must strand
 *     none. Without both halves the test does not explain itself.
 *   - WHICH WRITES LOWER THE FLOOR AND WHICH DO NOT. The negative half is where the 14× lives: a
 *     lowering on every completed render would rewind the floor continuously.
 *   - THE WRITE BUDGET: one schedule write per render, not two.
 */

const MINUTE = 60_000;
const T0 = 1_700_000_400_000; // a whole minute
const minuteOf = (ms) => Math.floor(ms / MINUTE);

let funnel, lease, config;

const sabs = new Map();

before(async () => {
	globalThis.server = { hostname: 'test-node', nodes: [], config: { http: { port: 9926 } } };
	globalThis.logger = { info() {}, warn() {}, error() {} };
	globalThis.databases = {
		coordination: {
			SharedBuffer: {
				primaryStore: {
					// KEYED. An unkeyed fake hands every acquisition its own zeroed buffer, so nothing
					// ever observes anything and the tests pass for the wrong reason.
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

	({ config } = await import('../src/config.js'));
	funnel = await import('../src/util/renderSchedule.js');
	lease = await import('../src/util/renderLease.js');
});

/**
 * A fake schedule table plus a lease table over a fresh buffer, with the clock injected.
 *
 * `scanOpen` is tracked the way `test/scan.test.js` does it, so a write or a lease grant issued
 * while the cursor is open is CAUGHT rather than merely discouraged.
 */
const harness = ({ rows = [], slots = 256, now = T0, leaseTimeMs = 10 * MINUTE } = {}) => {
	const table = new Map(rows.map((row) => [row.cacheKey, { ...row }]));
	const clock = { now };
	const leases = lease.createLeaseTable({
		buffer: new ArrayBuffer(lease.leaseBufferBytes(slots)),
		slots,
		now: () => clock.now,
	});

	const searches = [];
	const puts = [];
	const deletes = [];
	let scanOpen = false;
	const duringScan = [];
	// Set only if the generator ran off the end of its loop. An abandoned iterator (a `break` out of
	// the `for await`) leaves this false while `finally` still runs, so it distinguishes the two.
	const exhausted = { value: false };

	const searchSchedules = ({ floorMinute, limit }) => {
		const query = {
			conditions: [{ attribute: 'nextRenderTime', comparator: 'greater_than_equal', value: floorMinute * MINUTE }],
			sort: { attribute: 'nextRenderTime' },
			select: ['cacheKey', 'nextRenderTime', 'fromSitemap'],
			limit,
		};
		searches.push({ query, options: { replicateFrom: false } });
		exhausted.value = false;
		return (async function* () {
			scanOpen = true;
			try {
				const matching = [...table.values()]
					.filter((row) => Number(row.nextRenderTime) >= floorMinute * MINUTE)
					.sort((a, b) => Number(a.nextRenderTime) - Number(b.nextRenderTime))
					.slice(0, limit);
				for (const row of matching) yield { ...row };
				exhausted.value = true;
			} finally {
				scanOpen = false;
			}
		})();
	};

	const put = (cacheKey, row) => {
		if (scanOpen) duringScan.push(`put:${cacheKey}`);
		puts.push({ cacheKey, ...row });
		table.set(cacheKey, { cacheKey, ...row });
	};

	// A lease table that records grants made while the cursor was open.
	const watchedLeases = {
		...leases,
		grant: (key, options) => {
			if (scanOpen) duringScan.push(`grant:${key}`);
			return leases.grant(key, options);
		},
	};

	const pass = (options = {}) =>
		funnel.runClaimPass({
			searchSchedules,
			leases: watchedLeases,
			nowMs: clock.now,
			grantLimit: 20,
			guardMinutes: 5,
			scanCap: 1000,
			leaseTimeMs,
			floorEnabled: true,
			...options,
		});

	return { table, clock, leases, searches, puts, deletes, duringScan, exhausted, searchSchedules, put, pass };
};

const row = (cacheKey, nextRenderTime, fromSitemap = false) => ({ cacheKey, nextRenderTime, fromSitemap });

beforeEach(() => {
	// The shared buffer outlives a `beforeEach` that clears fake tables, so the floor and the
	// leases would otherwise leak between tests in this file.
	funnel.resetRenderQueueState();
});

// ---- the query shape (I-2) ----

test('the claim search has exactly one condition, inclusive, on nextRenderTime, with replicateFrom:false', async () => {
	const h = harness({ rows: [row('a|desktop', T0 - MINUTE)] });
	await h.pass({ grantLimit: 3 });

	assert.equal(h.searches.length, 1, 'one search per pass');
	const [{ query, options }] = h.searches;

	assert.equal(query.conditions.length, 1, 'a SECOND condition is what collapses this into a filtered scan');
	assert.equal(query.conditions[0].attribute, 'nextRenderTime');
	assert.equal(
		query.conditions[0].comparator,
		'greater_than_equal',
		'INCLUSIVE — an exclusive comparator strands the whole minute at the floor (~1,100 keys)'
	);
	assert.deepEqual(query.sort, { attribute: 'nextRenderTime' });
	assert.deepEqual(
		query.select,
		['cacheKey', 'nextRenderTime', 'fromSitemap'],
		'ARRAY select — a string select returns a bare scalar'
	);
	assert.deepEqual(
		options,
		{ replicateFrom: false },
		'an unowned read without this takes Harper’s untimed replication fetch'
	);
});

test('the scan limit accommodates the in-flight pile, capped by claimScanCap', async () => {
	const h = harness({ rows: [] });
	// grantLimit + occupancy + grantLimit.
	let result = await h.pass({ grantLimit: 20 });
	assert.equal(result.scanLimit, 40);

	h.leases.grant('held|desktop', { dueMinute: 1, leaseExpiryMs: T0 + MINUTE });
	result = await h.pass({ grantLimit: 20 });
	assert.equal(result.scanLimit, 41, 'a leased row keeps its overdue index position, so the pass must read past it');

	result = await h.pass({ grantLimit: 20, scanCap: 25 });
	assert.equal(result.scanLimit, 25, 'and the cap bounds it');
});

test('a floor of 0 still sends the condition, as >= 0 — never an absent conditions array', async () => {
	// Dropping the conditions leaves Harper to inject its own primary-key full-scan condition beside
	// a sort on a secondary attribute, and whether that still walks the nextRenderTime index is
	// unverified. `>= 0` is the same seek-from-the-minimum with index use guaranteed.
	const h = harness({ rows: [row('a|desktop', 1)] });
	const result = await h.pass();

	assert.equal(result.floorFrom, 0);
	assert.equal(h.searches[0].query.conditions.length, 1);
	assert.equal(h.searches[0].query.conditions[0].value, 0);
	assert.equal(result.jobs.length, 1, 'and a row at nextRenderTime 1 is found');
});

// ---- ties: the single most likely implementation bug ----

test('THREE ROWS SHARING ONE MINUTE are granted across three passes — an exclusive advance would strand them', async () => {
	const at = T0 - 10 * MINUTE;
	const h = harness({ rows: [row('a|desktop', at), row('b|desktop', at), row('c|desktop', at)] });

	const granted = [];
	for (let i = 0; i < 3; i++) {
		const result = await h.pass({ grantLimit: 1 });
		assert.equal(result.jobs.length, 1, `pass ${i + 1} must grant one`);
		granted.push(result.jobs[0].cacheKey);
		// The floor never leaves that minute while any row in it is unfinished.
		assert.equal(result.floorTo, minuteOf(at));
	}

	assert.deepEqual([...granted].sort(), ['a|desktop', 'b|desktop', 'c|desktop'], 'three DISTINCT keys');
});

// ---- the floor rule (I-3) ----

test('the floor lands on the FIRST due row observed, not the last granted', async () => {
	const rows = Array.from({ length: 20 }, (_, i) => row(`k${i}|desktop`, T0 - (20 - i) * MINUTE));
	const h = harness({ rows });

	const result = await h.pass({ grantLimit: 20 });

	assert.equal(result.jobs.length, 20);
	assert.equal(result.floorTo, minuteOf(T0 - 20 * MINUTE), 'floor = t0, the oldest row in the batch');
	assert.notEqual(result.floorTo, minuteOf(T0 - MINUTE), 'NOT t19 — that is the rule that stranded 14%');
});

test('the floor does not move until the OLDEST in-flight job completes', async () => {
	const rows = Array.from({ length: 20 }, (_, i) => row(`k${i}|desktop`, T0 - (20 - i) * MINUTE));
	const h = harness({ rows });

	await h.pass({ grantLimit: 20 });
	assert.equal(h.leases.rawFloorMinute(), minuteOf(T0 - 20 * MINUTE));

	// Every result posts EXCEPT the oldest: rows move into the future and their leases release.
	for (let i = 1; i < 20; i++) {
		h.table.set(`k${i}|desktop`, row(`k${i}|desktop`, T0 + 60 * MINUTE));
		h.leases.release(`k${i}|desktop`);
	}
	await h.pass({ grantLimit: 20 });
	assert.equal(h.leases.rawFloorMinute(), minuteOf(T0 - 20 * MINUTE), 'k0 is still in flight — the floor is pinned');

	// k0 lands.
	h.table.set('k0|desktop', row('k0|desktop', T0 + 60 * MINUTE));
	h.leases.release('k0|desktop');
	const result = await h.pass({ grantLimit: 20 });
	assert.equal(result.sawDue, false, 'nothing is due any more');
	assert.equal(result.floorTo, minuteOf(T0) - 5, 'an empty pass parks the floor at nowMinute − guard');
	assert.ok(h.leases.rawFloorMinute() > minuteOf(T0 - 20 * MINUTE), 'and only now does the floor advance');
});

test('an empty pass parks the floor at nowMinute − guard, NEVER at nowMinute', async () => {
	// At nowMinute the floor would sit exactly where every "render this now" write from another node
	// lands, and every one of them would be stranded until the next reset.
	const h = harness({ rows: [] });
	const result = await h.pass({ guardMinutes: 5 });
	assert.equal(result.sawDue, false);
	assert.equal(result.floorTo, minuteOf(T0) - 5);
	assert.notEqual(result.floorTo, minuteOf(T0));
});

// ---- the 15% regression, against the rule it replaced ----

/**
 * 1,189 rows through repeated claim / expire / post cycles with 15% of grants never posting a
 * result — a renderer that crashed, or a lease that simply ran out. A stranded row is one that no
 * pass will ever return again.
 *
 * Both rules are driven through the SAME trace. The shipped rule must strand nothing; the rejected
 * "last granted" rule must strand roughly the failure rate, which is what it did when it was
 * measured (167 of 1,189 = 14.0% at a 15% failure rate).
 */
const strandingTrace = async (floorRule) => {
	const ROWS = 1189;
	const rows = Array.from({ length: ROWS }, (_, i) => row(`u${i}|desktop`, T0 - (ROWS - i) * MINUTE));
	const h = harness({ rows });
	const posted = new Set();

	// Deterministic 15% "never posts", so both rules see an identical trace.
	let seed = 12345;
	const nextRandom = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};

	for (let round = 0; round < 400; round++) {
		const result = await h.pass({ grantLimit: 20, floorRule });
		if (!result.sawDue) break;

		for (const job of result.jobs) {
			if (nextRandom() < 0.15) continue; // the renderer died; only the lease expiry knows
			posted.add(job.cacheKey);
			h.table.set(job.cacheKey, row(job.cacheKey, T0 + 10_000 * MINUTE));
			h.leases.release(job.cacheKey);
		}
		// Time passes: every unreleased lease expires.
		h.clock.now += 11 * MINUTE;
	}

	return { stranded: ROWS - posted.size, total: ROWS };
};

test('the shipped floor rule strands ZERO rows at a 15% renderer-failure rate', async () => {
	const { stranded } = await strandingTrace('first-due-observed');
	assert.equal(stranded, 0, 'every row must eventually render, however many renderers died');
});

test('...and the rejected "floor = last granted" rule strands rows on the SAME trace', async () => {
	// This half is the point. Without it the test above only proves the code does what it does.
	const { stranded, total } = await strandingTrace('last-granted');
	assert.ok(stranded > 0, 'the rejected rule must visibly strand rows');
	assert.ok(stranded / total > 0.05, `expected stranding on the order of the failure rate, got ${stranded}/${total}`);
});

// ---- which writes lower the floor, and which must not ----

test('every write shape lowers the floor only when it should', async () => {
	// The NEGATIVE half is where the 14× lives: a lowering on every completed render would rewind
	// the floor to the current minute continuously and the whole win would evaporate.
	const nowMinute = minuteOf(T0);
	const cases = [
		// [what writes it, the due time, must it lower a floor sitting at nowMinute?]
		['renderNow / admin revalidate / Target.revalidate / redirect adoption (currentMinuteMs)', T0, true],
		['a due time in the PAST (the ops-socket trick, replication catch-up)', 1, true],
		['processJobResult reschedule (now + interval)', T0 + 24 * 60 * MINUTE, false],
		['retryAfterFailure slow lane (now + interval)', T0 + 60 * MINUTE, false],
		['Target.suppress recheck (now + recheckInterval)', T0 + 7 * 24 * 60 * MINUTE, false],
		['Target.put / reconcile repair (getInitialRenderTime — jittered, always >= now)', T0 + 137 * MINUTE, false],
	];

	for (const [what, nextRenderTime, shouldLower] of cases) {
		funnel.resetRenderQueueState();
		assert.equal(funnel.leaseTable().advanceFloor(0, nowMinute), true, 'precondition: establish a floor');

		await funnel.writeSchedule('k|desktop', { nextRenderTime, fromSitemap: false });

		const raw = funnel.leaseTable().rawFloorMinute();
		if (shouldLower) {
			assert.ok(raw <= minuteOf(nextRenderTime), `${what} must lower the floor to cover its own row (got ${raw})`);
		} else {
			assert.equal(raw, nowMinute, `${what} must NOT rewind the floor`);
		}
	}
});

test('writeSchedules lowers ONCE, with the batch minimum', async () => {
	funnel.resetRenderQueueState();
	const nowMinute = minuteOf(T0);
	funnel.leaseTable().advanceFloor(0, nowMinute);

	await funnel.writeSchedules([
		{ cacheKey: 'a|desktop', nextRenderTime: T0 + 90 * MINUTE, fromSitemap: false },
		{ cacheKey: 'b|desktop', nextRenderTime: T0 - 3 * MINUTE, fromSitemap: false },
		{ cacheKey: 'c|desktop', nextRenderTime: T0 + 10 * MINUTE, fromSitemap: false },
	]);

	assert.equal(funnel.leaseTable().rawFloorMinute(), minuteOf(T0 - 3 * MINUTE), 'the batch minimum, not the last row');
});

test('a write BELOW the floor is claimable on the very next pass', async () => {
	// The number alone is not the property — the row has to come back.
	const h = harness({ rows: [] });
	assert.equal(h.leases.advanceFloor(0, minuteOf(T0)), true);

	h.put('late|desktop', { nextRenderTime: 1, fromSitemap: false });
	h.leases.lowerFloorTo(minuteOf(1)); // what writeSchedule does

	assert.ok(h.leases.rawFloorMinute() <= 1);
	const result = await h.pass();
	assert.deepEqual(
		result.jobs.map((job) => job.cacheKey),
		['late|desktop']
	);
});

test('a below-floor row written OUTSIDE the plugin is missed, then recovered by the floor reset', async () => {
	// The operations API and the exported RenderSchedule REST surface run no plugin code, so nothing
	// lowers the floor for them. The reset is the only recovery, and this is what bounds the damage
	// from permanent to one interval.
	const rows = Array.from({ length: 5 }, (_, i) => row(`recent${i}|desktop`, T0 - i * MINUTE));
	const h = harness({ rows });
	await h.pass({ grantLimit: 5 });
	for (const r of rows) {
		h.table.set(r.cacheKey, row(r.cacheKey, T0 + 1000 * MINUTE));
		h.leases.release(r.cacheKey);
	}
	await h.pass({ grantLimit: 5 });
	const floorBefore = h.leases.rawFloorMinute();
	assert.ok(floorBefore > 0, 'precondition: a floor is established');

	// Straight into the table — no funnel, no lowering.
	h.table.set('smuggled|desktop', row('smuggled|desktop', T0 - 10_000 * MINUTE));

	let result = await h.pass();
	assert.equal(result.jobs.length, 0, 'invisible while the floor stands');

	h.leases.resetFloor();

	result = await h.pass();
	assert.deepEqual(
		result.jobs.map((job) => job.cacheKey),
		['smuggled|desktop'],
		'and claimed on the pass after the reset'
	);
});

// ---- livelock ----

test('leased rows at the head do not block a grantable row behind them', async () => {
	const h = harness({
		rows: [
			row('held0|desktop', T0 - 5 * MINUTE),
			row('held1|desktop', T0 - 4 * MINUTE),
			row('held2|desktop', T0 - 3 * MINUTE),
			row('free|desktop', T0 - 2 * MINUTE),
		],
	});
	for (const key of ['held0|desktop', 'held1|desktop', 'held2|desktop']) {
		h.leases.grant(key, { dueMinute: minuteOf(T0 - 5 * MINUTE), leaseExpiryMs: T0 + 5 * MINUTE });
	}

	const result = await h.pass({ grantLimit: 1 });

	assert.deepEqual(
		result.jobs.map((job) => job.cacheKey),
		['free|desktop']
	);
	assert.equal(result.skippedLeased, 3);
	assert.equal(result.floorTo, minuteOf(T0 - 5 * MINUTE), 'the floor is still held at the oldest leased row');
});

test('an in-flight pile larger than the scan cap grants zero but reports QUEUED, never empty', async () => {
	// Reporting `empty` here tells every consumer in the fleet to back off to its idle interval while
	// a large backlog is entirely in flight, and nothing corrects it until the next status sync.
	const rows = Array.from({ length: 30 }, (_, i) => row(`held${i}|desktop`, T0 - (30 - i) * MINUTE));
	rows.push(row('free|desktop', T0 - MINUTE));
	const h = harness({ rows });
	for (const r of rows.slice(0, 30)) {
		h.leases.grant(r.cacheKey, { dueMinute: minuteOf(r.nextRenderTime), leaseExpiryMs: T0 + 5 * MINUTE });
	}

	const result = await h.pass({ grantLimit: 1, scanCap: 5 });

	assert.equal(result.jobs.length, 0, 'the cap is consumed by leased rows');
	assert.equal(result.scanTruncated, true);
	assert.equal(result.sawDue, true, 'and the pass KNOWS there is work');
	funnel.leaseTable().recordPassOutcome({ sawDue: result.sawDue, earliestNotYetDueMinute: 0 });
	assert.equal(funnel.deriveQueueStatus(T0), 'queued');
});

test('a FULL scan window that reached a not-yet-due row is NOT truncated — the healthy node must not warn', async () => {
	// The query is deliberately ONE-SIDED, so on any real corpus every row above the floor matches and
	// the window fills on a perfectly caught-up node: `rows.length >= scanLimit` alone was true
	// essentially always, and the warning it drove ("look for wedged renders holding the claim floor")
	// fired once per claim per worker on an IDLE node and went quiet exactly when the node was busy.
	// Reaching a not-yet-due row PROVES there was nothing more to grant beyond the window.
	const h = harness({
		rows: [
			row('due|desktop', T0 - MINUTE),
			row('soon0|desktop', T0 + MINUTE),
			row('soon1|desktop', T0 + 2 * MINUTE),
			row('soon2|desktop', T0 + 3 * MINUTE),
			row('soon3|desktop', T0 + 4 * MINUTE),
		],
	});

	const result = await h.pass({ grantLimit: 1, scanCap: 2 });

	assert.equal(result.scanned, result.scanLimit, 'the window is full');
	assert.equal(result.earliestNotYetDueMinute, minuteOf(T0 + MINUTE), 'and a not-yet-due row was reached');
	assert.equal(result.scanTruncated, false, 'so nothing was cut off');

	// The genuinely truncated case: the whole window is due work and the drain never got past it.
	const busy = harness({ rows: Array.from({ length: 10 }, (_, i) => row(`k${i}|desktop`, T0 - (10 - i) * MINUTE)) });
	const truncated = await busy.pass({ grantLimit: 1, scanCap: 3 });
	assert.equal(truncated.earliestNotYetDueMinute, 0);
	assert.equal(truncated.scanTruncated, true);
});

// ---- naming the row that holds the floor ----

test('the pass NAMES the row holding the floor, and the funnel remembers it for the console', async () => {
	// `claim` writes nothing to the table, so a row whose result never arrives keeps its due minute and
	// every later pass derives the same floor from it — not for one lease, but until something moves or
	// deletes that row. The floor reset cannot recover it either: that row IS the oldest due row it
	// would re-derive from. So the key has to be reportable, or an operator has a lag figure and no way
	// to find the URL behind it.
	const h = harness({
		rows: [row('wedged|desktop', T0 - 30 * MINUTE), row('healthy|desktop', T0 - MINUTE)],
	});
	h.leases.grant('wedged|desktop', { dueMinute: minuteOf(T0 - 30 * MINUTE), leaseExpiryMs: T0 + 5 * MINUTE });

	const result = await h.pass({ grantLimit: 5 });

	assert.equal(result.floorHeldBy, 'wedged|desktop', 'the FIRST due row observed, leased or not');
	assert.equal(result.floorTo, minuteOf(T0 - 30 * MINUTE), 'which is exactly the minute the floor sits at');
	assert.equal(result.skippedLeased, 1);

	// An empty pass names nobody rather than leaving a stale key implicating an innocent URL.
	const idle = harness({ rows: [] });
	assert.equal((await idle.pass()).floorHeldBy, null);
});

// ---- the commit-visibility grace ----

test('a released key is NOT re-granted while its reschedule is still uncommitted', async () => {
	// The result path releases from a `finally` inside the request handler; the reschedule it just
	// issued commits with the AMBIENT transaction, i.e. after the handler settles. So for one commit's
	// worth of time the committed row is still overdue and unleased, and a claim pass — on another
	// worker, not sharing the result path's mutex — would grant it a second time. On every result.
	// A duplicate render is wasted work; on a failing key it is also a second strike toward maxStrikes.
	const h = harness({ rows: [row('a|desktop', T0 - MINUTE)] });

	const first = await h.pass({ grantLimit: 5 });
	assert.equal(first.jobs.length, 1);

	// The result lands and releases the lease. The row is deliberately left as the fake table had it —
	// this IS the pre-commit state.
	h.leases.release('a|desktop');

	const second = await h.pass({ grantLimit: 5 });
	assert.equal(second.jobs.length, 0, 'no duplicate grant inside the grace');
	assert.equal(second.skippedLeased, 1);
	assert.equal(second.floorTo, minuteOf(T0 - MINUTE), 'and the row still holds the floor, which costs nothing');

	// Once the grace is out, an uncommitted-forever row (a rolled-back transaction) is claimable again.
	h.clock.now += lease.RELEASE_GRACE_MS + 1_000;
	const third = await h.pass({ grantLimit: 5 });
	assert.deepEqual(
		third.jobs.map((job) => job.cacheKey),
		['a|desktop']
	);
});

test('the scan window sizes itself off the LIVE lease count, not off a gauge drained by late releases', async () => {
	// `scanLimit` is grantLimit + occupancy + grantLimit: it exists so the pass can read PAST the
	// in-flight pile, which keeps its overdue index position now. A gauge that reads low collapses the
	// window to 2 × grantLimit and the pass grants nothing while a backlog exists — so what the gauge
	// must never do is drop below the live count when results arrive after their leases expired.
	const h = harness({ rows: [], slots: 256 });
	const live = [];
	const expired = [];
	for (let i = 0; i < 60; i++) {
		const key = `k${i}|desktop`;
		const keeps = i % 2 === 0;
		h.leases.grant(key, { dueMinute: minuteOf(T0) - 10, leaseExpiryMs: T0 + (keeps ? 10 * MINUTE : MINUTE) });
		(keeps ? live : expired).push(key);
	}

	h.clock.now = T0 + 2 * MINUTE; // half the leases have expired with no result
	// The reconciling walk — a console read, or the periodic one `syncQueueState` runs. THE OTHER
	// DIRECTION of this drift is pinned in test/queueStatusDerived.test.js: without that periodic walk
	// the gauge climbs without bound, because an expired lease has nobody to decrement it. This test is
	// the floor of the range and that one is the ceiling; neither is meaningful without the other.
	h.leases.scanLive();
	for (const key of expired) h.leases.release(key); // ...and then the late results arrive

	const result = await h.pass({ grantLimit: 20 });
	assert.equal(result.occupancy, live.length, 'the gauge still knows about every live lease');
	assert.equal(result.scanLimit, 20 + live.length + 20, 'so the window still reads past the pile');
});

// ---- absent vs. zero due times ----

test('an ABSENT nextRenderTime does not unbound the floor, but a real 0 still does', async () => {
	// `Number(null)` is 0, `0` is finite, and `lowerFloorTo(0)` means NO FLOOR. So a bare `Number`
	// coercion in the funnel would let one missing due time put the claim scan back to seeking the
	// absolute index minimum — the degraded 6.25 ms seek this release exists to remove — silently,
	// because 0 passes a finite check. The distinction the fix has to preserve is that a REAL 0 is a
	// documented value here (the `nextRenderTime = 1` priority trick, a junk `PUT`) and must still
	// unbound it.
	funnel.resetRenderQueueState();
	const established = minuteOf(T0);
	funnel.leaseTable().advanceFloor(0, established);
	assert.equal(funnel.leaseTable().rawFloorMinute(), established, 'precondition: a floor exists');

	await funnel.writeSchedule('a|desktop', { nextRenderTime: null, fromSitemap: false });
	assert.equal(funnel.leaseTable().rawFloorMinute(), established, 'a null due time lowers nothing');

	await funnel.writeSchedule('b|desktop', { nextRenderTime: undefined, fromSitemap: false });
	assert.equal(funnel.leaseTable().rawFloorMinute(), established, 'nor an undefined one');

	// The batch form is the worse case: one null row would win the minimum for the whole fan-out.
	await funnel.writeSchedules([
		{ cacheKey: 'c|desktop', nextRenderTime: null, fromSitemap: false },
		{ cacheKey: 'd|desktop', nextRenderTime: T0 + 10 * MINUTE, fromSitemap: false },
	]);
	assert.equal(funnel.leaseTable().rawFloorMinute(), established, 'and one null row cannot unbound a batch');

	// ...while an explicit epoch due time is honoured, because that is a real request.
	await funnel.writeSchedule('e|desktop', { nextRenderTime: 0, fromSitemap: false });
	assert.equal(funnel.leaseTable().rawFloorMinute(), 0, 'a due time AT the epoch unbounds the scan on purpose');
});

// ---- the tri-state status ----

test('derived status: granted > 0 → queued, granted 0 with due rows → queued, no due rows → empty', async () => {
	funnel.resetRenderQueueState();
	funnel.leaseTable().recordPassOutcome({ sawDue: true, earliestNotYetDueMinute: 0 });
	assert.equal(funnel.deriveQueueStatus(T0), 'queued');

	funnel.leaseTable().recordPassOutcome({ sawDue: false, earliestNotYetDueMinute: 0 });
	assert.equal(funnel.deriveQueueStatus(T0), 'empty');
});

test('a row that was in the future flips the status to queued with ZERO searches', async () => {
	const h = harness({ rows: [row('later|desktop', T0 + 5 * MINUTE)] });

	const result = await h.pass();
	assert.equal(result.jobs.length, 0);
	assert.equal(result.sawDue, false);
	assert.equal(result.earliestNotYetDueMinute, minuteOf(T0 + 5 * MINUTE));

	funnel.leaseTable().recordPassOutcome(result);
	assert.equal(funnel.deriveQueueStatus(T0), 'empty');

	const searchesBefore = h.searches.length;
	assert.equal(funnel.deriveQueueStatus(T0 + 5 * MINUTE), 'queued', 'the minute arrived');
	assert.equal(h.searches.length, searchesBefore, 'and nothing was scanned to find that out');
});

test('...and once that row has rendered, the status goes back to EMPTY — the mark does not latch queued', async () => {
	// The full flap, driven through two real passes. The earliest-due mark used to be CAS-MIN'd, so a
	// later horizon was discarded and the mark stayed at a minute that had already arrived: this node
	// answered `queued` forever from `deriveQueueStatus` (the status sync, twice a minute, rewriting
	// the replicated QueueStatus row) while `claim` kept answering `empty` from the same pass — and no
	// consumer in the fleet reached its idle interval again until a restart.
	// A second row further out matters: it means every pass reaches SOME not-yet-due row, so the mark is
	// never cleared by the `earliestNotYetDueMinute === 0` case and the only thing that can move it
	// later is the pass being authoritative.
	const h = harness({ rows: [row('soon|desktop', T0 + 5 * MINUTE), row('later|desktop', T0 + 1000 * MINUTE)] });

	funnel.leaseTable().recordPassOutcome(await h.pass());
	assert.equal(funnel.deriveQueueStatus(T0 + 5 * MINUTE), 'queued', 'precondition: the minute arrives');

	// It comes due, is granted, renders, and is rescheduled a day out.
	h.clock.now = T0 + 5 * MINUTE;
	const claimed = await h.pass();
	assert.deepEqual(
		claimed.jobs.map((job) => job.cacheKey),
		['soon|desktop']
	);
	funnel.leaseTable().recordPassOutcome(claimed);
	h.table.set('soon|desktop', row('soon|desktop', h.clock.now + 24 * 60 * MINUTE));
	h.leases.release('soon|desktop');

	// The next pass sees nothing due and a horizon a day out — LATER than the mark on record.
	h.clock.now += MINUTE;
	const idle = await h.pass();
	assert.equal(idle.sawDue, false);
	funnel.leaseTable().recordPassOutcome(idle);

	assert.equal(funnel.deriveQueueStatus(h.clock.now), 'empty', 'the queue really is empty, and says so');
	assert.equal(
		funnel.leaseTable().readPassOutcome().earliestNotYetDueMinute,
		idle.earliestNotYetDueMinute,
		'the mark is the LATEST pass’s own horizon, a day out — not the earliest ever recorded'
	);
});

// ---- the drain discipline ----

test('no lease is granted and no write issued while the search cursor is open, and the iterator is fully consumed', async () => {
	// A write (or an Atomics store) pending when Harper's long-transaction monitor fires gets the
	// transaction ABORTED and poisoned; an abandoned iterator leaves its read transaction unreleased.
	const rows = Array.from({ length: 5 }, (_, i) => row(`k${i}|desktop`, T0 - (5 - i) * MINUTE));
	const h = harness({ rows });

	const result = await h.pass({ grantLimit: 2 });

	assert.deepEqual(h.duringScan, [], 'nothing may happen while the cursor is open');
	assert.equal(result.jobs.length, 2);
	// The pass grants 2 but the scan window is grantLimit + in-flight + grantLimit = 4, and the
	// iterator is consumed to its END rather than abandoned once enough rows are in hand.
	assert.equal(result.scanned, 4);
	assert.equal(h.exhausted.value, true, 'the iterator ran to completion — no early break out of the for-await');
});

// ---- the app-side cut at "now" ----

test('rows straddling now: the future ones are neither granted nor leased', async () => {
	const h = harness({
		rows: [
			row('due0|desktop', T0 - 2 * MINUTE),
			row('due1|desktop', T0),
			row('soon|desktop', T0 + MINUTE),
			row('later|desktop', T0 + 9 * MINUTE),
		],
	});

	const result = await h.pass({ grantLimit: 20 });

	assert.deepEqual(
		result.jobs.map((job) => job.cacheKey),
		['due0|desktop', 'due1|desktop'],
		'a row due exactly at now IS due — the cut is `> now`, not `>= now`'
	);
	assert.equal(h.leases.isLeased('soon|desktop'), false);
	assert.equal(h.leases.isLeased('later|desktop'), false);
	assert.equal(result.earliestNotYetDueMinute, minuteOf(T0 + MINUTE), 'the FIRST of them');
});

// ---- expiresAt (I-13) ----

test('expiresAt is unfloored, absolute, and always more than 30s of lease', async () => {
	// The fleet DISCARDS any granted job with under 30s of lease left, and the plugin would see only
	// successful claims while nothing rendered. `jobLeaseTime`'s two-minute minimum is what bounds it.
	const h = harness({ rows: [row('a|desktop', T0 - MINUTE)], now: T0 + 37_123 });
	const result = await h.pass({ leaseTimeMs: config.queue.jobLeaseTime });

	const [job] = result.jobs;
	assert.equal(job.expiresAtMs, T0 + 37_123 + config.queue.jobLeaseTime, 'unfloored: not rounded to the minute');
	assert.ok(job.expiresAtMs - (T0 + 37_123) >= 30_000);
	assert.ok(config.queue.jobLeaseTime >= 2 * MINUTE, 'the schema minimum is what guarantees it');
});

// ---- the write budget ----

test('ONE schedule write per render, claim to result — the halved audit volume', async () => {
	// `claim` used to write the lease back onto the row, so a render cost two writes on the hot head
	// of the index. This is the assertion behind the ~87 → ~44 MB/day/node claim.
	funnel.resetRenderQueueState();
	const puts = [];
	globalThis.databases.render_schedule.RenderSchedule = {
		put: async (cacheKey, row) => void puts.push({ cacheKey, ...row }),
		delete: async () => {},
		search: () => [],
	};

	const h = harness({ rows: [row('a|desktop', T0 - MINUTE)] });
	const result = await h.pass({ grantLimit: 1 });
	assert.equal(result.jobs.length, 1);
	assert.equal(puts.length, 0, 'claiming writes NOTHING to the table now');

	// The result lands and reschedules.
	await funnel.writeSchedule('a|desktop', { nextRenderTime: T0 + 24 * 60 * MINUTE, fromSitemap: false });
	assert.equal(puts.length, 1, 'exactly one write for the whole cycle');
});

// ---- restart semantics ----

test('a fresh (restarted) buffer re-GRANTS everything in flight rather than losing it', async () => {
	// A behaviour change, and the correct one: the schedule row was never moved, so the job is simply
	// granted again. The cost is a duplicate-render burst, which is documented, not fixed.
	const rows = [row('a|desktop', T0 - 2 * MINUTE), row('b|desktop', T0 - MINUTE)];
	const h = harness({ rows });

	const first = await h.pass({ grantLimit: 20 });
	assert.equal(first.jobs.length, 2);
	const rowsAfterClaim = [...h.table.values()].map((r) => ({ ...r }));

	// Worker generation replaced: same schedule rows, brand-new zeroed buffer.
	const restarted = harness({ rows: rowsAfterClaim });
	const second = await restarted.pass({ grantLimit: 20 });

	assert.deepEqual(
		second.jobs.map((job) => job.cacheKey).sort(),
		['a|desktop', 'b|desktop'],
		'everything in flight is re-granted'
	);
	assert.ok(second.jobs[0].expiresAtMs > 0, 'with a fresh lease');
	assert.deepEqual([...restarted.table.values()], rowsAfterClaim, 'and every schedule row is byte-identical');
});

// ---- numeric traps ----

test('a BigInt due time is coerced, not thrown on', async () => {
	// A `Long` column can surface as BigInt. `Number.isFinite(BigInt)` is false and
	// `Math.min(bigint, number)` THROWS — inside the claim mutex, which 500s `claim` and
	// circuit-breaks the node.
	const h = harness({ rows: [{ cacheKey: 'big|desktop', nextRenderTime: BigInt(T0 - MINUTE), fromSitemap: false }] });

	const result = await h.pass();

	assert.equal(result.jobs.length, 1, 'granted, not thrown on');
	assert.equal(result.floorTo, minuteOf(T0 - MINUTE));
});

test('a null due time is skipped, not treated as due in 1970', async () => {
	// `Number(null)` is 0, which reads as infinitely overdue and would drag the floor to 0 forever.
	const h = harness({ rows: [{ cacheKey: 'null|desktop', nextRenderTime: null, fromSitemap: false }] });

	const result = await h.pass();

	assert.equal(result.jobs.length, 0);
	assert.equal(result.nonFinite, 1);
	assert.equal(result.sawDue, false);
	assert.equal(result.floorTo, minuteOf(T0) - 5, 'and it does not pull the floor to the epoch');
});

// ---- the kill switch ----

test('floorEnabled:false forces a floor of 0 and changes nothing else', async () => {
	const h = harness({ rows: [row('a|desktop', T0 - 10_000 * MINUTE)] });
	assert.equal(h.leases.advanceFloor(0, minuteOf(T0)), true);

	const result = await h.pass({ floorEnabled: false });

	assert.equal(result.floorFrom, 0, 'the scan seeks the absolute minimum, exactly as before v0.34.0');
	assert.equal(h.searches.at(-1).query.conditions[0].value, 0);
	assert.equal(h.leases.rawFloorMinute(), 0, 'and the stored floor is cleared, so re-enabling starts clean');
	assert.equal(result.jobs.length, 1);
	assert.equal(h.leases.isLeased('a|desktop'), true, 'leases still work — only the floor is switched off');
});

// ---- funnel guards ----

test('deleteSchedule lowers nothing and releases nothing', async () => {
	// Releasing on delete would let the floor advance past a row whose result may still be arriving
	// from a duplicate renderer — the same class of mistake as the rejected "last granted" floor rule.
	// (The single release point in processJobResult is what eventually frees the slot; this is about
	// the funnel primitive.)
	funnel.resetRenderQueueState();
	const nowMinute = minuteOf(T0);
	funnel.leaseTable().advanceFloor(0, nowMinute);
	funnel.leaseTable().grant('gone|desktop', { dueMinute: 1, leaseExpiryMs: Date.now() + 10 * MINUTE });

	await funnel.deleteSchedule('gone|desktop');

	assert.equal(funnel.leaseTable().rawFloorMinute(), nowMinute, 'a vanished row strands nothing — no lowering');
	assert.ok(funnel.leaseInfo('gone|desktop'), 'and the lease is untouched');
});

test('writeSchedule refuses a write with no explicit fromSitemap (put REPLACES the record)', async () => {
	await assert.rejects(() => funnel.writeSchedule('a|desktop', { nextRenderTime: T0 }), /fromSitemap/);
	await assert.rejects(() => funnel.writeSchedules([{ cacheKey: 'a|desktop', nextRenderTime: T0 }]), /fromSitemap/);
});

test('maybeResetFloor honours its interval and is a no-op at 0', () => {
	funnel.resetRenderQueueState();
	const original = config.queue.claimFloor.resetInterval;
	try {
		config.queue.claimFloor.resetInterval = 5 * MINUTE;
		assert.equal(funnel.maybeResetFloor(T0), true, 'the first call resets');
		assert.equal(funnel.maybeResetFloor(T0 + MINUTE), false, 'and not again within the interval');
		assert.equal(funnel.maybeResetFloor(T0 + 5 * MINUTE), true);

		config.queue.claimFloor.resetInterval = 0;
		assert.equal(funnel.maybeResetFloor(T0 + 100 * MINUTE), false, '0 disables the reset entirely');
	} finally {
		config.queue.claimFloor.resetInterval = original;
	}
});

// ---- what the console reads ----

// LAST IN THE FILE: it installs its own RenderSchedule over the global one, like the write-budget
// test above, and does not put it back.
test('claimSchedules records the floor-holding key where floorState (and so the console) reads it', async () => {
	funnel.resetRenderQueueState();
	const at = Date.now() - 5 * MINUTE;
	globalThis.databases.render_schedule.RenderSchedule = {
		put: async () => {},
		delete: async () => {},
		search: async function* ({ limit }) {
			for (const cacheKey of ['wedged|desktop', 'next|desktop'].slice(0, limit)) {
				yield { cacheKey, nextRenderTime: at, fromSitemap: false };
			}
		},
	};

	const pass = await funnel.claimSchedules({ grantLimit: 1 });
	assert.equal(pass.floorHeldBy, 'wedged|desktop');

	const state = funnel.floorState(Date.now());
	assert.equal(state.floorHeldBy, 'wedged|desktop', 'the overview payload can name the row pinning the queue');
	assert.ok(state.floorHeldByAt > 0, 'with the pass it came from timestamped, since it is per worker');
});
