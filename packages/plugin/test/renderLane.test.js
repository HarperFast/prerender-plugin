import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Render lanes — the encoding, the taxonomy, the fairness allocator, the per-lane watermarks, and
 * the claim pass over all of it.
 *
 * What is pinned here, and why each one is a bug nothing else in this package would catch:
 *
 *   - THE ENCODING ROUND-TRIPS EXACTLY, including at `Long` magnitudes. A due time recovered one
 *     millisecond wrong is a due time; recovered 139 years wrong it is a page that never renders.
 *   - AN ABSENT DUE TIME SURVIVES THE ENCODING. `Number(null)` is 0 and 0 is finite, so a bare
 *     coercion turns "no due time" into "due at the epoch", and a floor of 0 means NO FLOOR — one
 *     null row would put the whole claim scan back to seeking the absolute index minimum.
 *   - A LANE'S WATERMARK CANNOT STRAND ANOTHER LANE. This is the whole point: the failure the design
 *     replaces is one wedged row holding the scan position for every other route.
 *   - THE FLOOR RULE STILL HOLDS PER LANE. Same rule, same hazard — a floor advanced past a row the
 *     pass observed is a permanently unclaimable row, and it is silent.
 *   - SPILL IS DROPPED, NOT GRANTED. The lane seek has one condition and no upper bound (a two-sided
 *     range costs 1,128-2,977 ms on this index), so a sparse lane reads into the next lane's rows.
 *     Granting one would render a job under another lane's budget.
 *   - FLOORS ARE MINIMUMS, NOT ENTITLEMENTS. An unclaimed reservation has to come back, or a class
 *     with nothing due silently shrinks every batch.
 *   - `urgentMaxShare` IS A CAP THAT HOLDS EVEN WHEN NOTHING ELSE WANTS THE CAPACITY. It is the only
 *     structural bound stopping a bulk force-render from becoming a queue-wide outage.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = 1_700_000_400_000; // a whole minute
const minuteOf = (ms) => Math.floor(ms / MINUTE);

let lane, floors, funnel, leaseMod, config;

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

	({ config } = await import('../src/config.js'));
	lane = await import('../src/util/renderLane.js');
	floors = await import('../src/util/laneFloor.js');
	funnel = await import('../src/util/renderSchedule.js');
	leaseMod = await import('../src/util/renderLease.js');
});

beforeEach(() => {
	// The defaults this file reasons about: two cuts -> three bands per banded class, so
	// urgent(0) submitted(1,2,3) discovered(4,5,6) cold(7).
	config.queue.lanes.ttlBands = [HOUR, 12 * HOUR];
});

// ---- the encoding ------------------------------------------------------------------------------

test('encode/decode round-trips every lane exactly', () => {
	for (const l of [0, 1, 3, 7, 12]) {
		const encoded = lane.encodeDueAt(T0, l);
		assert.equal(lane.laneOf(encoded), l, `lane ${l}`);
		assert.equal(lane.dueAtOf(encoded), T0, `dueAt in lane ${l}`);
	}
});

test('lane 0 is the IDENTITY, which is what makes every pre-existing row a valid lane-0 row', () => {
	assert.equal(lane.encodeDueAt(T0, 0), T0);
	assert.equal(lane.laneOf(T0), 0);
	assert.equal(lane.dueAtOf(T0), T0);
});

test('lower encoded value is claimed first, so lane order IS priority order', () => {
	// The property the whole design rests on: every row of lane N sorts before every row of N+1,
	// however overdue the later lane's rows are. A three-day-overdue product page cannot outrank a
	// homepage in a faster lane.
	const threeDaysOverdue = lane.encodeDueAt(T0 - 3 * 24 * HOUR, 3);
	const onTimeFastLane = lane.encodeDueAt(T0, 1);
	assert.ok(onTimeFastLane < threeDaysOverdue);
});

test('an ABSENT due time survives encoding unchanged — 0 is finite and a floor of 0 means NO floor', () => {
	assert.equal(lane.encodeDueAt(null, 3), null);
	assert.equal(lane.encodeDueAt(undefined, 3), undefined);
	assert.equal(lane.dueAtOf(null), null);
	assert.equal(lane.dueAtOf(undefined), undefined);
	// ...while a REAL 0 still encodes. It is the documented `nextRenderTime = 1` shape and must work.
	assert.equal(lane.dueAtOf(lane.encodeDueAt(1, 2)), 1);
	assert.equal(lane.laneOf(lane.encodeDueAt(1, 2)), 2);
});

test('a BigInt from a Long column decodes rather than throwing', () => {
	const encoded = BigInt(lane.encodeDueAt(T0, 4));
	assert.equal(lane.laneOf(encoded), 4);
	assert.equal(lane.dueAtOf(encoded), T0);
});

test('the stride leaves room for every lane the taxonomy can produce, inside a 52-bit Long', () => {
	assert.ok(lane.laneCount() < lane.MAX_LANES, `${lane.laneCount()} lanes must fit in ${lane.MAX_LANES}`);
	const highest = lane.encodeDueAt(T0, lane.laneCount() - 1);
	assert.ok(Number.isSafeInteger(highest), 'the highest encodable due time must stay a safe integer');
});

// ---- the taxonomy -----------------------------------------------------------------------------

test('TTL bands split a class so EDF inside a lane approximates relative lateness', () => {
	const submitted = (interval) => lane.laneFor({ fromSitemap: true, renderInterval: interval });
	// The three cadences this deployment actually runs must land in three different lanes, or the
	// homepage goes on losing to product pages that are older in absolute terms.
	assert.notEqual(submitted(HOUR), submitted(6 * HOUR));
	assert.notEqual(submitted(6 * HOUR), submitted(48 * HOUR));
	assert.ok(submitted(HOUR) < submitted(6 * HOUR));
	assert.ok(submitted(6 * HOUR) < submitted(48 * HOUR));
});

test('submitted outranks discovered at the same cadence, and both outrank cold', () => {
	const s = lane.laneFor({ fromSitemap: true, renderInterval: HOUR });
	const d = lane.laneFor({ fromSitemap: false, renderInterval: HOUR });
	const c = lane.laneFor({ fromSitemap: true, renderInterval: HOUR, cold: true });
	assert.ok(s < d, 'submitted before discovered');
	assert.ok(d < c, 'discovered before cold');
	assert.equal(lane.laneFor({ fromSitemap: false, renderInterval: 48 * HOUR, urgent: true }), 0);
});

test('an ABSENT cadence takes the SLOWEST band, never the fastest', () => {
	// The safe direction: an absent interval is an absent claim to urgency. Defaulting to band 0
	// would let any row that lost its cadence jump ahead of the homepage.
	const slowest = lane.laneFor({ fromSitemap: true, renderInterval: 999 * HOUR });
	for (const missing of [undefined, null, 0, -1, Number.NaN, 'x']) {
		assert.equal(lane.laneFor({ fromSitemap: true, renderInterval: missing }), slowest, `interval=${missing}`);
	}
});

test('an unsorted or duplicated band list still produces a monotonic order', () => {
	// The band index IS part of the stored key, so an unsorted list would file a shorter interval in
	// a later lane and quietly invert the ordering it exists to create.
	config.queue.lanes.ttlBands = [12 * HOUR, HOUR, HOUR, -5, Number.NaN];
	const submitted = (i) => lane.laneFor({ fromSitemap: true, renderInterval: i });
	assert.ok(submitted(HOUR) < submitted(6 * HOUR));
	assert.ok(submitted(6 * HOUR) < submitted(48 * HOUR));
});

test('classOfLane and laneLabel name every lane the taxonomy produces', () => {
	const seen = new Set();
	for (let l = 0; l < lane.laneCount(); l++) seen.add(lane.classOfLane(l));
	assert.deepEqual([...seen].sort(), ['cold', 'discovered', 'submitted', 'urgent']);
	assert.equal(lane.laneLabel(0), 'urgent');
	assert.equal(lane.laneLabel(lane.laneCount() - 1), 'cold');
	assert.equal(lane.laneLabel(1), 'submitted/b0');
});

test('an empty band list degrades to provenance-only priority rather than breaking', () => {
	config.queue.lanes.ttlBands = [];
	assert.equal(lane.bandCount(), 1);
	assert.equal(lane.laneCount(), 4);
	assert.equal(lane.laneFor({ fromSitemap: true, renderInterval: HOUR }), 1);
	assert.equal(lane.laneFor({ fromSitemap: true, renderInterval: 48 * HOUR }), 1);
	assert.equal(lane.laneFor({ fromSitemap: false, renderInterval: HOUR }), 2);
});

// ---- the fairness allocator -------------------------------------------------------------------

const budgetWith = (opts) => lane.createLaneBudget({ grantLimit: 20, ...opts });

test('urgentMaxShare caps the urgent lane even when nothing else wants the capacity', () => {
	const budget = budgetWith({ urgentMaxShare: 0.2 });
	assert.equal(budget.allowanceFor(0), 4, '20% of 20');
	budget.record(0, 4);
	assert.equal(budget.allowanceFor(0), 0, 'and it does not refill within the pass');
	// The rest of the batch is still available to the lanes below — that is the structural bound.
	assert.equal(budget.remaining, 16);
});

test('a share too small to floor to a whole job still admits one', () => {
	// A cap of zero would make an operator's force-render silently never run, with nothing to say why.
	assert.equal(budgetWith({ grantLimit: 3, urgentMaxShare: 0.2 }).allowanceFor(0), 1);
	// ...and an explicit 0 really does disable the lane.
	assert.equal(budgetWith({ urgentMaxShare: 0 }).allowanceFor(0), 0);
});

test('a protected class floor is held back from the lanes above it', () => {
	const budget = budgetWith({ urgentMaxShare: 0, minShare: { discovered: 0.1, cold: 0.05 } });
	// discovered reserves 2, cold reserves 1, so the submitted lanes may take at most 17.
	const submitted = lane.laneFor({ fromSitemap: true, renderInterval: HOUR });
	assert.equal(budget.allowanceFor(submitted), 17);
	budget.record(submitted, 17);
	// ...and the reservations are then exactly what is left, for the classes they were held for.
	const discovered = lane.laneFor({ fromSitemap: false, renderInterval: HOUR });
	assert.equal(budget.allowanceFor(discovered), 2);
});

test('a class is never held back by its OWN floor', () => {
	// Its siblings' reservations must not be able to starve it on the mechanism meant to protect it.
	const budget = budgetWith({ urgentMaxShare: 0, minShare: { discovered: 1 } });
	const discovered = lane.laneFor({ fromSitemap: false, renderInterval: HOUR });
	assert.equal(budget.allowanceFor(discovered), 20);
});

test('FLOORS ARE MINIMUMS: an unclaimed reservation comes back to lane order', () => {
	const budget = budgetWith({ urgentMaxShare: 0, minShare: { discovered: 0.5 } });
	const submitted = lane.laneFor({ fromSitemap: true, renderInterval: HOUR });
	assert.equal(budget.allowanceFor(submitted), 10, 'half the batch is reserved');
	budget.record(submitted, 10);
	// Discovery had nothing due. Without the top-up, half of every batch would go unspent forever.
	budget.topUp();
	assert.equal(budget.allowanceFor(submitted), 10);
});

test('the top-up does NOT release the urgent cap — a cap is not a reservation', () => {
	const budget = budgetWith({ urgentMaxShare: 0.2, minShare: {} });
	budget.record(0, 4);
	budget.topUp();
	assert.equal(budget.allowanceFor(0), 0, 'still capped after the top-up');
});

// ---- the per-lane watermarks ------------------------------------------------------------------

const laneFloorTable = (lanes = 8, now = T0) =>
	floors.createLaneFloors({ buffer: new ArrayBuffer(floors.laneFloorBufferBytes(lanes)), lanes, now: () => now });

test('A LANE WATERMARK CANNOT STRAND ANOTHER LANE — the failure the design replaces', () => {
	const table = laneFloorTable();
	// Lane 3 is wedged three days back; lane 1 has caught up to now.
	table.advanceFloor(3, 0, minuteOf(T0 - 3 * 24 * HOUR));
	table.advanceFloor(1, 0, minuteOf(T0));
	assert.equal(table.readFloorMinute(1, minuteOf(T0), 0), minuteOf(T0));
	assert.equal(table.readFloorMinute(3, minuteOf(T0), 0), minuteOf(T0 - 3 * 24 * HOUR));
});

test('the guard band holds a floor behind now, but never lifts an unbounded one', () => {
	const table = laneFloorTable();
	table.advanceFloor(1, 0, minuteOf(T0));
	assert.equal(table.readFloorMinute(1, minuteOf(T0), 5), minuteOf(T0) - 5, 'clamped behind now');
	// A zero floor means "seek this lane's absolute minimum". Clamping it UP would silently turn
	// re-derive-from-the-bottom into skip-everything-older-than-the-guard, stranding what a reset
	// exists to recover.
	assert.equal(table.readFloorMinute(2, minuteOf(T0), 5), 0);
});

test('lowerFloorTo is a CAS-min and advanceFloor abandons on conflict', () => {
	const table = laneFloorTable();
	table.advanceFloor(1, 0, 500);
	assert.equal(table.lowerFloorTo(1, 600), false, 'a later minute lowers nothing');
	assert.equal(table.lowerFloorTo(1, 400), true, 'an earlier one does');
	assert.equal(table.readFloorMinute(1, 10_000, 0), 400);
	// A conflicting advance must ABANDON: a conflict means a write lowered the floor for a row the
	// pass never saw, and re-advancing over it would strand that row.
	assert.equal(table.advanceFloor(1, 500, 700), false);
	assert.equal(table.readFloorMinute(1, 10_000, 0), 400);
});

test('a pin ages per lane, and clearing one does not clear another', () => {
	let now = T0;
	const table = floors.createLaneFloors({
		buffer: new ArrayBuffer(floors.laneFloorBufferBytes(8)),
		lanes: 8,
		now: () => now,
	});
	assert.equal(table.notePinnedBy(1, 'a|desktop'), 0, 'a new pin starts at zero');
	assert.equal(table.notePinnedBy(3, 'b|desktop'), 0);
	now = T0 + 10 * MINUTE;
	assert.equal(table.notePinnedBy(1, 'a|desktop'), 10 * MINUTE, 'the same key keeps ageing');
	table.notePinnedBy(1, null);
	assert.equal(table.notePinnedBy(1, 'a|desktop'), 0, 'cleared, so it restarts');
	assert.equal(table.notePinnedBy(3, 'b|desktop'), 10 * MINUTE, 'the other lane is untouched');
});

test('a different key resets the pin clock — the pin is about a ROW, not a lane', () => {
	let now = T0;
	const table = floors.createLaneFloors({
		buffer: new ArrayBuffer(floors.laneFloorBufferBytes(4)),
		lanes: 4,
		now: () => now,
	});
	table.notePinnedBy(1, 'a|desktop');
	now = T0 + 30 * MINUTE;
	assert.equal(table.notePinnedBy(1, 'b|desktop'), 0, 'the promoted row starts its own clock');
});

test('lanes are clamped to the buffer rather than indexing past it', () => {
	const table = laneFloorTable(2);
	assert.equal(table.laneCount, 2);
	table.advanceFloor(99, 0, 400);
	// Folded onto the last lane, not written out of bounds.
	assert.equal(table.readFloorMinute(1, 10_000, 0), 400);
});

// ---- the claim pass, per lane -----------------------------------------------------------------

const harness = ({ rows, slots = 256, now = T0 }) => {
	const leases = leaseMod.createLeaseTable({
		buffer: new ArrayBuffer(leaseMod.leaseBufferBytes(slots)),
		slots,
		now: () => now,
	});
	const laneFloors = laneFloorTable(16, now);
	const searchSchedules = ({ lane: seekLane, floorMinute, limit }) =>
		(async function* () {
			const from = seekLane * lane.LANE_STRIDE + floorMinute * MINUTE;
			const matching = rows
				.filter((r) => Number(r.nextRenderTime) >= from)
				.sort((a, b) => Number(a.nextRenderTime) - Number(b.nextRenderTime))
				.slice(0, limit);
			for (const r of matching) yield { ...r };
		})();

	const pass = (lane_, options = {}) =>
		funnel.runClaimPass({
			searchSchedules,
			leases,
			nowMs: now,
			grantLimit: 20,
			guardMinutes: 5,
			scanCap: 1000,
			leaseTimeMs: 10 * MINUTE,
			floorEnabled: true,
			lane: lane_,
			floors: {
				readFloorMinute: (nowMinute, guard) => laneFloors.readFloorMinute(lane_, nowMinute, guard),
				advanceFloor: (from, to) => laneFloors.advanceFloor(lane_, from, to),
				resetFloor: () => laneFloors.resetFloor(lane_),
				notePinnedBy: (key) => laneFloors.notePinnedBy(lane_, key),
			},
			decode: (raw) => ({ lane: lane.laneOf(raw), dueAt: lane.dueAtOf(raw) }),
			...options,
		});

	return { pass, leases, laneFloors };
};

test("A DEEP BACKLOG IN A SLOW LANE DOES NOT HIDE THE FAST LANE'S ROWS — the whole point", () => {
	// The production symptom, reproduced: 60 product rows three days overdue, and a homepage two
	// hours overdue. Un-laned, the window is anchored at the oldest row and the homepage is never
	// read at all. Laned, the fast lane's seek starts at ITS oldest row.
	const rows = [
		...Array.from({ length: 60 }, (_, i) => ({
			cacheKey: `pdp-${i}|desktop`,
			nextRenderTime: lane.encodeDueAt(T0 - 3 * 24 * HOUR + i * MINUTE, 3),
			fromSitemap: true,
		})),
		{ cacheKey: 'home|desktop', nextRenderTime: lane.encodeDueAt(T0 - 2 * HOUR, 1), fromSitemap: true },
	];
	const { pass } = harness({ rows });
	return pass(1, { grantLimit: 5 }).then((result) => {
		assert.deepEqual(
			result.jobs.map((j) => j.cacheKey),
			['home|desktop'],
			'the fast lane grants the homepage regardless of how deep the slow lane is'
		);
	});
});

test('SPILL from the next lane is dropped, never granted', async () => {
	// Lane 1 is empty, so its one-sided seek reads straight into lane 2's rows. Granting one would
	// render a job under lane 1's budget and lower lane 1's watermark for a row it does not own.
	const rows = [
		{ cacheKey: 'a|desktop', nextRenderTime: lane.encodeDueAt(T0 - HOUR, 2), fromSitemap: false },
		{ cacheKey: 'b|desktop', nextRenderTime: lane.encodeDueAt(T0 - HOUR, 2), fromSitemap: false },
	];
	const { pass, laneFloors } = harness({ rows });
	const result = await pass(1);
	assert.equal(result.jobs.length, 0);
	assert.equal(result.spilled, 2, 'counted, so a wasted scan window is visible');
	assert.equal(result.sawDue, false, 'an empty lane must not report the next lane as its own work');
	// And lane 2 still gets them.
	const next = await pass(2);
	assert.equal(next.jobs.length, 2);
	assert.equal(laneFloors.readFloorMinute(2, minuteOf(T0), 0), minuteOf(T0 - HOUR));
});

test('the floor rule holds per lane: the floor is the first DUE row that lane observed', async () => {
	const rows = [
		{ cacheKey: 'stuck|desktop', nextRenderTime: lane.encodeDueAt(T0 - 10 * HOUR, 2), fromSitemap: false },
		{ cacheKey: 'ok|desktop', nextRenderTime: lane.encodeDueAt(T0 - HOUR, 2), fromSitemap: false },
	];
	const { pass, leases } = harness({ rows });
	leases.grant('stuck|desktop', { dueMinute: minuteOf(T0 - 10 * HOUR), leaseExpiryMs: T0 + HOUR });

	const result = await pass(2);
	assert.deepEqual(
		result.jobs.map((j) => j.cacheKey),
		['ok|desktop']
	);
	// The in-flight row is the first due row observed, so it holds the floor — a lease whose result
	// may still be arriving must not have the floor advance past it.
	assert.equal(result.floorTo, minuteOf(T0 - 10 * HOUR));
	assert.equal(result.floorHeldBy, 'stuck|desktop');
	assert.equal(result.skippedLeased, 1);
});

test('a not-yet-due row in a fast lane is still not granted', async () => {
	const rows = [{ cacheKey: 'future|desktop', nextRenderTime: lane.encodeDueAt(T0 + HOUR, 1), fromSitemap: true }];
	const { pass } = harness({ rows });
	const result = await pass(1);
	assert.equal(result.jobs.length, 0);
	assert.equal(result.earliestNotYetDueMinute, minuteOf(T0 + HOUR));
});

// ---- the restamp ------------------------------------------------------------------------------

test('the restamp moves a row into its lane WITHOUT changing its due time', async () => {
	const { restampPass } = await import('../src/util/laneRestamp.js');
	const written = [];
	const result = await restampPass({
		limit: 10,
		searchUnstamped: () =>
			(async function* () {
				yield { cacheKey: 'https://x/a|desktop', nextRenderTime: T0 - HOUR, fromSitemap: true };
				yield { cacheKey: 'https://x/b|desktop', nextRenderTime: T0 - 2 * HOUR, fromSitemap: false };
				yield { cacheKey: 'https://x/c|desktop', nextRenderTime: null, fromSitemap: true };
			})(),
		writeRow: (rows) => written.push(rows),
	});

	assert.equal(result.examined, 3);
	assert.equal(result.restamped, 2);
	assert.equal(result.skipped, 1, 'a row with no usable due time is left alone, not given one');
	assert.equal(result.done, true, 'a pass that did not fill its window is finished');

	// THE DUE TIMES ARE UNTOUCHED. The pass changes the order and nothing else, which is what makes
	// it safe on a live node: no page renders sooner or later than it would have.
	const all = written.flat();
	assert.deepEqual(all.map((r) => r.nextRenderTime).sort(), [T0 - 2 * HOUR, T0 - HOUR].sort());
	// ...and each batch is single-lane, so its watermark is lowered with that lane's own minimum.
	for (const batch of written) {
		const lanes = new Set(
			batch.map((r) => lane.laneFor({ fromSitemap: r.fromSitemap, renderInterval: r.renderInterval }))
		);
		assert.equal(lanes.size, 1);
	}
});

test('a full window is NOT done, so the caller keeps going', async () => {
	const { restampPass } = await import('../src/util/laneRestamp.js');
	const result = await restampPass({
		limit: 2,
		searchUnstamped: () =>
			(async function* () {
				yield { cacheKey: 'https://x/a|desktop', nextRenderTime: T0, fromSitemap: false };
				yield { cacheKey: 'https://x/b|desktop', nextRenderTime: T0, fromSitemap: false };
			})(),
		writeRow: async () => {},
	});
	assert.equal(result.done, false);
});

test('the restamp refuses to run once lanes are enabled, because urgent and unstamped are one number', async () => {
	const { restampGuard } = await import('../src/util/laneRestamp.js');
	config.queue.lanes.enabled = false;
	assert.equal(restampGuard().allowed, true);
	config.queue.lanes.enabled = true;
	const guard = restampGuard();
	assert.equal(guard.allowed, false);
	assert.match(guard.reason, /urgent/);
	assert.equal(restampGuard({ force: true }).allowed, true);
	config.queue.lanes.enabled = false;
});
