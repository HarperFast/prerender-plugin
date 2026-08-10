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

let recordVisit, flushSlices, refreshMerged, visitedWithin, visitedInEachWindow;
let sweepExpired, resetVisitFilter, slotOf, mergedReady;
let applyOptions;

const H = 60 * 60 * 1000;

before(async () => {
	globalThis.Resource = class {};
	// workerIndex 1: rollover's worker-0 sweep must not fire mid-test; sweepExpired is
	// exercised directly instead.
	globalThis.server = { hostname: 'node-a', workerIndex: 1 };
	globalThis.logger = { info() {}, warn() {}, error() {} };
	globalThis.databases = {
		coordination: {
			SharedBuffer: {
				primaryStore: {
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
	({
		recordVisit,
		flushSlices,
		refreshMerged,
		visitedWithin,
		visitedInEachWindow,
		sweepExpired,
		resetVisitFilter,
		slotOf,
		mergedReady,
	} = await import('../src/util/visitFilter.js'));
});

const setDemand = (overrides = {}) =>
	applyOptions({
		render: {
			demand: {
				enabled: true,
				sliceMs: H,
				slices: 16,
				bitsPerSlice: 1 << 20,
				hashes: 7,
				...overrides,
			},
		},
	});

beforeEach(() => {
	rows.clear();
	locks = [];
	resetVisitFilter();
	setDemand();
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
	assert.equal(mergedReady(), true);
	assert.equal(visitedWithin('https://example.com/a', H, now), true);

	// Reshape: the slot numbering changes, so every old-shape answer is garbage. The union
	// must stop answering (cold hold) rather than demote the corpus off near-empty data.
	setDemand({ sliceMs: 2 * H });
	assert.equal(mergedReady(), false, 'union no longer claims to be warm');
	assert.equal(visitedWithin('https://example.com/a', H, now), false, 'old-shape union dropped');
});

test('a cold union answers false rather than throwing or inventing traffic', () => {
	assert.equal(visitedWithin('https://example.com/x', H, Date.now()), false);
});
