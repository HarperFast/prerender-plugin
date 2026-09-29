import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';

/**
 * visitFilter — the Bloom ring's storage contract and the read-side semantics the demand
 * ladder leans on.
 *
 * The properties pinned here:
 *   - record → flush → refreshMerged → visitedWithin roundtrips, and an unvisited URL
 *     stays invisible (no false negatives for members; effectively no false positives at
 *     this fill factor);
 *   - bitsPerSlice is normalized UP to a power of two at the storage boundary — a
 *     non-multiple-of-8 config must not truncate the byte allocation (truncation makes
 *     tail bits silently unstorable: a false-NEGATIVE source, the one error direction the
 *     filter must not have);
 *   - flush UNIONS with the stored row (read-merge-write under the mutex), never
 *     overwrites — that is what makes the node row the union of all workers;
 *   - visitedWithin anchors on the slot containing the window's START — the newest slot is
 *     partial, so a slot-counted probe under-covers the window and reads genuinely-visited
 *     pages as unvisited (the false-negative direction that demotes them);
 *   - visitedInEachWindow demands a hit in EACH consecutive window, not just any;
 *   - sweepExpired deletes rows outside the ring on BOTH sides — older than the cutoff, and
 *     past the current slot (a sliceMs increase renumbers slots downward, stranding
 *     old-numbering rows above every reachable slot);
 *   - a sizing (shape) change drops both sides of the in-memory state and holds the ladder
 *     cold rather than answering from old-shape rows.
 */

const rows = new Map();
let locks = [];
// The node's shared buffers, keyed as getUserSharedBuffer keys them. Cleared per test so one
// test's accumulated bits can never answer another's probe.
const sabs = new Map();

let recordVisit, flushSlices, refreshMerged, visitedWithin, visitedInEachWindow;
let sweepExpired, resetVisitFilter, slotOf, mergedWarm, historyFromMs, visitedSlots, unionHealth, visitProbe;
let demandOf, warmDemand;
let resetHeldSabs;
let applyOptions;

const H = 60 * 60 * 1000;

before(async () => {
	globalThis.Resource = class {};
	// workerIndex 1: rollover's worker-0 sweep must not fire mid-test; sweepExpired is
	// exercised directly instead.
	globalThis.server = { hostname: 'node-a', workerIndex: 1 };
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {} };
	globalThis.databases = {
		coordination: {
			SharedBuffer: {
				primaryStore: {
					// Named buffers, as Harper's getUserSharedBuffer provides them: the FIRST caller
					// for a key sizes it and every later caller gets that same buffer back. Sharing
					// is what lets sibling workers accumulate into one slice and only one of them
					// write it; `sabs` stands in for the cross-thread identity.
					getUserSharedBuffer(key, initial) {
						let buf = sabs.get(key);
						if (!buf) {
							buf = initial;
							sabs.set(key, buf);
						}
						return buf;
					},
					tryLock: (key) => {
						locks.push(key);
						return true;
					},
					unlock() {},
				},
			},
		},
		crawl_stats: {
			VisitFilter: {
				async get(id) {
					const row = rows.get(id);
					return row ? { ...row } : null;
				},
				async put(id, data) {
					rows.set(id, { id, ...data });
				},
				async delete(id) {
					rows.delete(id);
				},
				// Honors just enough of the search contract for refreshMerged and sweepExpired:
				// one slot condition, any direction.
				async search({ conditions = [] } = {}) {
					const out = [];
					for (const row of rows.values()) {
						const ok = conditions.every((c) =>
							c.comparator === 'less_than'
								? row.slot < c.value
								: c.comparator === 'greater_than'
									? row.slot > c.value
									: c.comparator === 'equals'
										? row.slot === c.value
										: row.slot >= c.value
						);
						if (ok) out.push({ ...row });
					}
					return out;
				},
			},
		},
	};

	({ applyOptions } = await import('../src/config.js'));
	({ resetHeldSabs } = await import('../src/util/coordination.js'));
	({
		recordVisit,
		flushSlices,
		refreshMerged,
		visitedWithin,
		visitedInEachWindow,
		sweepExpired,
		resetVisitFilter,
		slotOf,
		mergedWarm,
		historyFromMs,
		visitedSlots,
		unionHealth,
	} = await import('../src/util/visitFilter.js'));
	({ visitProbe } = await import('../src/util/demandLadder.js'));
	({ demandOf, warmDemand } = await import('../src/util/demand.js'));
});

// The ring's sizing is the demand TRACKER's (`demand.*`, v0.95.0); the ladder's rungs stay under
// `render.demand` and matter here only for how long a reshape holds the ladder cold.
const setDemand = (overrides = {}) =>
	applyOptions({
		demand: {
			enabled: true,
			sliceMs: H,
			slices: 16,
			bitsPerSlice: 1 << 20,
			hashes: 7,
			...overrides,
		},
		render: { demand: { enabled: true, ladder: [H, 2 * H, 4 * H] } },
	});

beforeEach(() => {
	rows.clear();
	locks = [];
	sabs.clear();
	resetHeldSabs();
	// Config FIRST, then the reset: a test that reshaped the ring leaves the next one's setDemand to
	// reshape it back, and a reshape stamps a history start that would clip every level count here.
	setDemand();
	resetVisitFilter();
});

test('record → flush → refresh → visitedWithin roundtrips; unvisited URL stays invisible', async () => {
	const now = Date.now();
	recordVisit('https://example.com/product/prd-1');
	await flushSlices();
	assert.equal(rows.size, 1, 'one node row for the current slot');

	await refreshMerged(now);
	assert.equal(visitedWithin('https://example.com/product/prd-1', H, now), true);
	assert.equal(visitedWithin('https://example.com/product/prd-2', H, now), false);
});

test('non-multiple-of-8 bitsPerSlice normalizes up: allocation cannot truncate tail bits', async () => {
	// 1025 raw bits would truncate to 128 bytes (1024 bits) under a bare `>>> 3`; the tail bit
	// would then silently never store (typed arrays ignore OOB writes) yet always read absent —
	// a false negative. Normalization rounds the modulus up to 2048 bits, so the persisted row
	// must be exactly 256 bytes and every URL must roundtrip.
	setDemand({ bitsPerSlice: 1025 });
	const now = Date.now();
	const urls = Array.from({ length: 50 }, (_, i) => `https://example.com/product/prd-${i}`);
	for (const u of urls) recordVisit(u);
	await flushSlices();

	const row = [...rows.values()][0];
	assert.equal(row.bits.length, 2048 >>> 3, 'row sized to the normalized power of two');

	await refreshMerged(now);
	for (const u of urls) assert.equal(visitedWithin(u, H, now), true, `false negative for ${u}`);
});

test('flush UNIONS with the stored row rather than overwriting it', async () => {
	const now = Date.now();
	// Another worker already persisted URL A into this node's row for the current slot.
	recordVisit('https://example.com/a');
	await flushSlices();
	const [id, stored] = [...rows.entries()][0];
	resetVisitFilter(); // "new worker": no in-memory memory of A
	setDemand();
	rows.set(id, stored);

	recordVisit('https://example.com/b');
	await flushSlices();

	await refreshMerged(now);
	assert.equal(visitedWithin('https://example.com/a', H, now), true, "the other worker's bits survived");
	assert.equal(visitedWithin('https://example.com/b', H, now), true, 'ours landed too');
	assert.ok(locks.length >= 1, 'flush went through the cross-worker mutex');
});

test('visitedInEachWindow requires a hit in EACH consecutive window, not just any', async () => {
	const now = Date.now();
	const url = 'https://example.com/product/prd-9';
	recordVisit(url);
	await flushSlices();

	// Copy the current slot's bits to the previous slot — same URL, one slot earlier (the bit
	// pattern is slot-independent, so this manufactures "visited in both windows").
	const cur = slotOf(now);
	const [, row] = [...rows.entries()][0];
	rows.set(`${cur - 1}|node-a`, { ...row, slot: cur - 1 });

	await refreshMerged(now);
	assert.equal(visitedInEachWindow(url, H, 2, now), true, 'hits in both 1h windows');
	assert.equal(visitedInEachWindow(url, H, 3, now), false, 'no hit in the third window back');
});

test('sweepExpired deletes rows outside the ring on both sides and nothing inside', async () => {
	const cur = slotOf(Date.now());
	const bits = Buffer.alloc(8, 0xff);
	rows.set(`${cur}|node-a`, { id: `${cur}|node-a`, slot: cur, node: 'node-a', bits });
	rows.set(`${cur - 20}|node-a`, { id: `${cur - 20}|node-a`, slot: cur - 20, node: 'node-a', bits });
	rows.set(`${cur - 40}|node-b`, { id: `${cur - 40}|node-b`, slot: cur - 40, node: 'node-b', bits });
	// Boundary skew is legitimate; an old-numbering orphan (sliceMs was increased) is not —
	// without the future sweep it can never age out and rides every union refresh forever.
	rows.set(`${cur + 1}|node-b`, { id: `${cur + 1}|node-b`, slot: cur + 1, node: 'node-b', bits });
	rows.set(`${cur + 500}|node-a`, { id: `${cur + 500}|node-a`, slot: cur + 500, node: 'node-a', bits });

	await sweepExpired(cur - 16);
	await tick();

	assert.equal(rows.has(`${cur}|node-a`), true, 'live slot kept');
	assert.equal(rows.has(`${cur - 20}|node-a`), false, 'aged-out slot deleted');
	assert.equal(rows.has(`${cur - 40}|node-b`), false, "other node's aged-out slot deleted too");
	assert.equal(rows.has(`${cur + 1}|node-b`), true, 'boundary-skew slot kept');
	assert.equal(rows.has(`${cur + 500}|node-a`), false, 'old-numbering orphan deleted');
});

test('a visit late in the previous slot is seen by a probe early in the current one', async () => {
	// The newest slot is PARTIAL. A slot-counted probe (`ceil(window/slice)` slots back)
	// covers only the elapsed part of the current slot for a one-slice window — a visit 50
	// minutes ago read as "not visited" when probed 10 minutes into the next slot. That is a
	// false negative, the one error direction the filter must not have: it demotes a
	// genuinely-visited page. Anchoring on the slot containing the window's START over-covers
	// by up to one slice instead (the safe, documented direction).
	const now = Date.now();
	const url = 'https://example.com/product/prd-7';
	recordVisit(url);
	await flushSlices();
	// Move the row to the previous slot: the bit pattern is slot-independent.
	const [id, row] = [...rows.entries()][0];
	rows.delete(id);
	const prev = slotOf(now) - 1;
	rows.set(`${prev}|node-a`, { ...row, id: `${prev}|node-a`, slot: prev });

	await refreshMerged(now);
	const earlyInSlot = slotOf(now) * H + 10 * 60 * 1000; // 10 minutes into the current slot
	assert.equal(visitedWithin(url, H, earlyInSlot), true);
});

test('a sizing change drops both sides of the in-memory state and holds the ladder cold', async () => {
	const now = Date.now();
	recordVisit('https://example.com/a');
	await flushSlices();
	await refreshMerged(now);
	assert.equal(mergedWarm(), true);
	assert.equal(visitProbe.ready(now), true, 'no reshape: the ladder may decide as soon as the union is warm');
	assert.equal(visitedWithin('https://example.com/a', H, now), true);

	// Reshape: the slot numbering changes, so every old-shape answer is garbage. The union
	// must stop answering (cold hold) rather than demote the corpus off near-empty data.
	setDemand({ sliceMs: 2 * H });
	assert.equal(mergedWarm(), false, 'union no longer claims to be warm');
	assert.equal(visitedWithin('https://example.com/a', H, now), false, 'old-shape union dropped');
	const since = historyFromMs();
	assert.ok(since > 0, 'the new shape records when its history began');

	// A refresh warms the union again, but the LADDER stays cold until a full slowest-rung window of
	// new-shape history exists (4h here) — the pre-split behaviour, now derived from the history start.
	await refreshMerged(Date.now());
	assert.equal(mergedWarm(), true);
	assert.equal(visitProbe.ready(since + 4 * H - 1), false, 'still inside the slowest rung');
	assert.equal(visitProbe.ready(since + 4 * H), true, 'a full slowest-rung window of new history');
});

// ── the demand LEVEL (util/demand.js reads it) ──────────────────────────────────────────────

test('visitedSlots counts the slots with a visit, over the slots the union can answer for', async () => {
	const base = slotOf(Date.now()) * H;
	const url = 'https://example.com/hot';
	// Visits in three distinct slots: 5h ago, 3h ago, now. Recording is clocked by Date.now(), so move
	// the clock for each and flush it as its own slot.
	const realNow = Date.now;
	try {
		for (const hoursAgo of [5, 3, 0]) {
			Date.now = () => base - hoursAgo * H + 60_000;
			recordVisit(url);
			await flushSlices();
		}
	} finally {
		Date.now = realNow;
	}
	const at = base + 30 * 60_000;
	await refreshMerged(at);
	const hot = visitedSlots(url, at);
	assert.equal(hot.level, 3);
	// Only six slots have ever been written (5h ago through now): an empty slot before the first row
	// anywhere is not evidence of no visit, so the window is those six, not the ring's sixteen.
	assert.equal(hot.covered, 6);
	assert.deepEqual(visitedSlots('https://example.com/never', at), { level: 0, covered: 6 });
});

test('visitedSlots is cold (covered 0) before the union loads', () => {
	assert.deepEqual(visitedSlots('https://example.com/x', Date.now()), { level: 0, covered: 0 });
});

test('unionHealth measures fill and fill^k over FULL slots, not the partial newest one', async () => {
	setDemand({ bitsPerSlice: 1024, hashes: 2 });
	const base = slotOf(Date.now()) * H;
	const realNow = Date.now;
	try {
		// A full slot one hour ago with plenty of URLs, and a light newest slot.
		Date.now = () => base - H + 60_000;
		for (let i = 0; i < 400; i++) recordVisit(`https://example.com/p${i}`);
		await flushSlices();
		Date.now = () => base + 60_000;
		recordVisit('https://example.com/only-one');
		await flushSlices();
	} finally {
		Date.now = realNow;
	}
	await refreshMerged(base + 2 * 60_000);
	const { newestFill, worstFill, worstFalsePositive } = unionHealth();
	assert.ok(newestFill > 0 && newestFill < 0.01, `newest slot barely filled (${newestFill})`);
	assert.ok(worstFill > 0.25, `the full slot is well filled (${worstFill})`);
	assert.ok(Math.abs(worstFalsePositive - worstFill ** 2) < 1e-12, 'false-positive rate is fill^k');
});

test('a cold union answers false rather than throwing or inventing traffic', () => {
	assert.equal(visitedWithin('https://example.com/x', H, Date.now()), false);
});

// ── one writer per node (#87) ────────────────────────────────────────────────────────────────
// The row is bitsPerSlice/8 bytes (128 KB at the default) and it replicates, so every worker
// rewriting it per interval put ~2 MB per slot per interval into the replicated transaction log
// for one row's worth of state — measured as 1.2 GB of logs behind 18 MB of live data. Workers
// now merge into a node-shared buffer and one of them writes. These pin the two properties that
// makes safe: nothing is lost by NOT writing, and nothing already stored is erased by writing.

test('bits from a worker that did not write are carried by the worker that does', async () => {
	const now = Date.now();

	// A worker that loses the interval's turn: it merges into the node-shared slice and returns.
	recordVisit('https://example.com/product/prd-loser');
	await flushSlices({ write: false });
	assert.equal(rows.size, 0, 'losing the turn must not write a row');

	// The worker that wins the turn writes ONE row, and it must carry the other worker's bits.
	recordVisit('https://example.com/product/prd-winner');
	await flushSlices({ write: true });
	assert.equal(rows.size, 1, 'one row per node per slot, however many workers contributed');

	await refreshMerged(now);
	assert.equal(
		visitedWithin('https://example.com/product/prd-loser', H, now),
		true,
		'a visit observed by a non-writing worker must still be visible — dropping it would be a false negative'
	);
	assert.equal(visitedWithin('https://example.com/product/prd-winner', H, now), true);
});

test('a shared buffer the store would free between uses is held, so a merge reaches its store', async () => {
	// Harper 5.2's RocksDB store frees a `getUserSharedBuffer` buffer once no ArrayBuffer references
	// it, and the next call for the key returns a NEW zeroed one. A caller that re-fetched by name on
	// every use lost what it had merged whenever a GC ran in between — measured in Docker: six merged
	// registers read back empty 11 ms later. Model the worst case, a GC between every call.
	const store = globalThis.databases.coordination.SharedBuffer.primaryStore;
	const original = store.getUserSharedBuffer;
	store.getUserSharedBuffer = (_key, fresh) => fresh; // forgets everything it hands out
	try {
		resetHeldSabs();
		const now = Date.now();
		recordVisit('https://example.com/product/prd-held');
		await flushSlices({ write: true, nowMs: now });
		await refreshMerged(now);
		assert.equal(
			visitedWithin('https://example.com/product/prd-held', H, now),
			true,
			'the merge survived to the store'
		);
	} finally {
		store.getUserSharedBuffer = original;
	}
});

// ── one copy per node (v0.95.1) ────────────────────────────────────────────────────────────
// Every worker sets its bits straight into the node-shared live slice, and whichever worker holds the
// flush turn stores every slot that changed since its last store. Nobody owes anything, so none of the
// per-worker debts the merge design needed exist to be lost.

const countCalls = (method) => {
	const VisitFilter = globalThis.databases.crawl_stats.VisitFilter;
	const original = VisitFilter[method];
	const calls = [];
	VisitFilter[method] = async (...args) => {
		calls.push(args);
		return original.apply(VisitFilter, args);
	};
	return { calls, restore: () => (VisitFilter[method] = original) };
};

test('only the worker holding the turn stores; the others set bits and write nothing', async () => {
	recordVisit('https://example.com/product/prd-a');
	await flushSlices({ write: false });
	assert.equal(rows.size, 0, 'no turn, no write — however many workers record');
	recordVisit('https://example.com/product/prd-b'); // "another worker": the same shared slice
	await flushSlices({ write: true });
	assert.equal(rows.size, 1, 'one row per node per slot');
	await refreshMerged(Date.now());
	assert.equal(visitedWithin('https://example.com/product/prd-a', H, Date.now()), true);
	assert.equal(visitedWithin('https://example.com/product/prd-b', H, Date.now()), true);
});

test('a slot nothing changed in since its last store is not stored again', async () => {
	const puts = countCalls('put');
	try {
		recordVisit('https://example.com/product/prd-once');
		await flushSlices();
		await flushSlices();
		recordVisit('https://example.com/product/prd-once'); // a repeat visit sets no new bit
		await flushSlices();
		assert.equal(puts.calls.length, 1, 'one store: a repeat visit is not a change');
		recordVisit('https://example.com/product/prd-new');
		await flushSlices();
		assert.equal(puts.calls.length, 2, 'a new URL is');
	} finally {
		puts.restore();
	}
});

test('a visit set while a store is in flight is stored by the next store', async () => {
	const VisitFilter = globalThis.databases.crawl_stats.VisitFilter;
	const put = VisitFilter.put;
	let release;
	const stalled = new Promise((resolve) => (release = resolve));
	let first = true;
	VisitFilter.put = async (id, data) => {
		if (first) {
			first = false;
			await stalled;
		}
		return put.call(VisitFilter, id, data);
	};
	try {
		const now = Date.now();
		recordVisit('https://example.com/product/prd-early');
		const storing = flushSlices({ write: true, nowMs: now }); // stalls inside the put
		await new Promise((resolve) => setImmediate(resolve));
		recordVisit('https://example.com/product/prd-during');
		release();
		await storing;
		await flushSlices({ write: true, nowMs: now + 1 });
		await refreshMerged(now + 2);
		assert.equal(visitedWithin('https://example.com/product/prd-during', H, now), true);
	} finally {
		VisitFilter.put = put;
	}
});

test('only the first store of a slot in a process reads the row back', async () => {
	const gets = countCalls('get');
	try {
		recordVisit('https://example.com/product/prd-1');
		await flushSlices();
		recordVisit('https://example.com/product/prd-2');
		await flushSlices();
		recordVisit('https://example.com/product/prd-3');
		await flushSlices();
		assert.equal(gets.calls.length, 1, 'the fold of pre-restart history, once; later stores write blind');
	} finally {
		gets.restore();
	}
});

test('a refresh fetches the bits only of slots with a row it has not seen at that version', async () => {
	const base = slotOf(Date.now()) * H;
	const realNow = Date.now;
	try {
		for (const hoursAgo of [3, 2, 0]) {
			Date.now = () => base - hoursAgo * H + 60_000;
			recordVisit(`https://example.com/product/prd-${hoursAgo}`);
			await flushSlices();
		}
	} finally {
		Date.now = realNow;
	}
	const VisitFilter = globalThis.databases.crawl_stats.VisitFilter;
	const search = VisitFilter.search;
	const bitReads = [];
	VisitFilter.search = async (query) => {
		if (query.select?.includes('bits')) bitReads.push(query.conditions[0].value);
		return search.call(VisitFilter, query);
	};
	try {
		const at = base + 30 * 60_000;
		await refreshMerged(at);
		assert.equal(bitReads.length, 3, 'first refresh: every slot with a row');
		bitReads.length = 0;
		await refreshMerged(at + 1);
		assert.deepEqual(bitReads, [], 'nothing changed: no bits read');
		recordVisit('https://example.com/product/prd-late');
		await flushSlices({ nowMs: at });
		await refreshMerged(at + 2);
		assert.deepEqual(bitReads, [slotOf(at)], 'only the slot whose row moved');
		assert.equal(visitedWithin('https://example.com/product/prd-late', H, at + 2), true);
	} finally {
		VisitFilter.search = search;
	}
});

test('a live slice is let go only once stored — an unstored one survives two rollovers', async () => {
	// Model Harper 5.2: a store that forgets any buffer nobody holds. Releasing an unstored live slice
	// would free its bits.
	const store = globalThis.databases.coordination.SharedBuffer.primaryStore;
	const original = store.getUserSharedBuffer;
	store.getUserSharedBuffer = (_key, fresh) => fresh;
	resetHeldSabs();
	const realNow = Date.now;
	try {
		const base = slotOf(realNow()) * H;
		Date.now = () => base - 3 * H + 60_000;
		recordVisit('https://example.com/product/prd-unstored'); // three slots back, never stored
		Date.now = () => base + 60_000;
		recordVisit('https://example.com/product/prd-now'); // rollover: slot -3 is two+ back, unstored
		await flushSlices({ nowMs: base + 60_000 });
		await refreshMerged(base + 120_000);
		assert.equal(
			visitedWithin('https://example.com/product/prd-unstored', 4 * H, base + 120_000),
			true,
			'kept until stored'
		);
	} finally {
		Date.now = realNow;
		store.getUserSharedBuffer = original;
	}
});

test('a restart with empty shared buffers cannot erase history already in the row', async () => {
	const now = Date.now();
	recordVisit('https://example.com/product/prd-before');
	await flushSlices();

	// Restart: shared buffers and thread state are gone, the persisted row is not. The write
	// path must still read-merge, or the first post-restart flush overwrites the slot's history
	// with only what this process has seen since boot.
	sabs.clear();
	resetHeldSabs();
	resetVisitFilter();
	setDemand();

	recordVisit('https://example.com/product/prd-after');
	await flushSlices();

	await refreshMerged(now);
	assert.equal(
		visitedWithin('https://example.com/product/prd-before', H, now),
		true,
		'pre-restart visits must survive the first post-restart write'
	);
	assert.equal(visitedWithin('https://example.com/product/prd-after', H, now), true);
});

test('merging is idempotent: the same slice merged twice is indistinguishable from once', async () => {
	// OR-merging is what makes the retry path in flushSlices safe to replay after a failed write.
	const now = Date.now();
	recordVisit('https://example.com/product/prd-1');
	await flushSlices({ write: false });
	await flushSlices({ write: true });
	await flushSlices({ write: true });

	await refreshMerged(now);
	assert.equal(visitedWithin('https://example.com/product/prd-1', H, now), true);
	assert.equal(rows.size, 1);
});

// ── demandOf: the tracker's answer (util/demand.js) ─────────────────────────────────────────

const visitAt = async (url, ms) => {
	const realNow = Date.now;
	try {
		Date.now = () => ms;
		recordVisit(url);
		await flushSlices();
	} finally {
		Date.now = realNow;
	}
};

test('demandOf: unknown while the tracker is off, and while the union has not loaded', async () => {
	setDemand({ enabled: false });
	assert.deepEqual(
		{ known: demandOf('https://example.com/a').known, reason: demandOf('https://example.com/a').reason },
		{ known: false, reason: 'off' }
	);
	setDemand();
	resetVisitFilter();
	const cold = demandOf('https://example.com/a');
	assert.equal(cold.known, false);
	assert.equal(cold.reason, 'cold');
	assert.equal(cold.periodMs, null, 'an unknown answer carries no number to misuse');
});

test('demandOf: the level is slots visited, the period the covered window over it', async () => {
	const base = slotOf(Date.now()) * H;
	for (const hoursAgo of [7, 5, 3, 1]) await visitAt('https://example.com/hot', base - hoursAgo * H + 60_000);
	await visitAt('https://example.com/other', base + 60_000); // the newest slot exists too
	const at = base + 30 * 60_000;
	await refreshMerged(at);
	const hot = demandOf('https://example.com/hot', at);
	assert.equal(hot.known, true);
	assert.equal(hot.level, 4);
	assert.equal(hot.slots, 8, 'written history runs from 7h ago through the current slot');
	assert.equal(hot.windowMs, 8 * H);
	assert.equal(hot.periodMs, 2 * H, 'four visits in eight hours: one every two');

	const never = demandOf('https://example.com/never', at);
	assert.equal(never.level, 0);
	assert.equal(never.periodMs, 8 * H, 'no visit in the window: the period is AT LEAST the window, reported as it');
});

test('demandOf: past demand.maxFalsePositive the answer is unknown, not a noise-dominated number', async () => {
	const base = slotOf(Date.now()) * H;
	await visitAt('https://example.com/a', base - H + 60_000);
	await visitAt('https://example.com/b', base + 60_000);
	setDemand({ maxFalsePositive: 0 }); // any measurable fill exceeds it
	resetVisitFilter();
	await refreshMerged(base + 2 * 60_000);
	assert.ok(unionHealth().worstFalsePositive > 0);
	const r = demandOf('https://example.com/a', base + 2 * 60_000);
	assert.equal(r.known, false);
	assert.equal(r.reason, 'saturated');
});

test('warmDemand loads the union, so the first question of a pass is answered', async () => {
	const base = slotOf(Date.now()) * H;
	await visitAt('https://example.com/a', base + 60_000);
	resetVisitFilter(); // in-memory union gone, rows still stored
	assert.equal(demandOf('https://example.com/a').reason, 'cold');
	resetVisitFilter();
	await warmDemand();
	assert.equal(demandOf('https://example.com/a').known, true);
});
