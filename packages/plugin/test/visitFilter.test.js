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
 *   - visitedInEachWindow demands a hit in EACH consecutive window, not just any;
 *   - sweepExpired deletes rows older than the ring and nothing newer.
 */

const rows = new Map();
let locks = [];

let recordVisit, flushSlices, refreshMerged, visitedWithin, visitedInEachWindow;
let sweepExpired, resetVisitFilter, slotOf;
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
				// one slot condition, either direction.
				async search({ conditions = [] } = {}) {
					const out = [];
					for (const row of rows.values()) {
						const ok = conditions.every((c) =>
							c.comparator === 'less_than' ? row.slot < c.value : row.slot >= c.value
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

test('sweepExpired deletes rows older than the ring and nothing newer', async () => {
	const cur = slotOf(Date.now());
	const bits = Buffer.alloc(8, 0xff);
	rows.set(`${cur}|node-a`, { id: `${cur}|node-a`, slot: cur, node: 'node-a', bits });
	rows.set(`${cur - 20}|node-a`, { id: `${cur - 20}|node-a`, slot: cur - 20, node: 'node-a', bits });
	rows.set(`${cur - 40}|node-b`, { id: `${cur - 40}|node-b`, slot: cur - 40, node: 'node-b', bits });

	await sweepExpired(cur - 16);
	await tick();

	assert.equal(rows.has(`${cur}|node-a`), true, 'live slot kept');
	assert.equal(rows.has(`${cur - 20}|node-a`), false, 'aged-out slot deleted');
	assert.equal(rows.has(`${cur - 40}|node-b`), false, "other node's aged-out slot deleted too");
});

test('a cold union answers false rather than throwing or inventing traffic', () => {
	assert.equal(visitedWithin('https://example.com/x', H, Date.now()), false);
});
