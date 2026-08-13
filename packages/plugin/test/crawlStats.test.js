import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';

/**
 * crawlStats — the per-thread sketch state machine and its persistence contract.
 *
 * The properties pinned here:
 *   - flush merges into the node row via read-merge-write (a second worker's flush must
 *     UNION with what's stored, never overwrite it — that is what makes the node row the
 *     union of all workers);
 *   - the flush is serialized by the cross-worker mutex;
 *   - the per-thread bot cap folds overflow into '~overflow' instead of minting sketches;
 *   - UTC day rollover persists the old day's sketches and starts clean ones;
 *   - a failed flush re-marks its bots dirty so the next cycle retries the whole
 *     (cumulative, idempotent) sketch;
 *   - computeBreadth groups by day, merges shards per bot, and reports the cross-bot
 *     union as `total` (never a sum).
 */

const rows = new Map();
let locks = [];
// The node's shared sketches, keyed as getUserSharedBuffer keys them. Cleared per test so one
// test's registers can never inflate another's estimate.
const sabs = new Map();

let recordCrawl, flushSketches, computeBreadth, resetCrawlStats, OVERFLOW_BUCKET;
let estimateSketch, createSketch, addToSketch;
let applyOptions;

before(async () => {
	globalThis.Resource = class {};
	globalThis.server = { hostname: 'node-a', workerIndex: 1 };
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {} };
	globalThis.databases = {
		coordination: {
			SharedBuffer: {
				primaryStore: {
					// Named buffers as getUserSharedBuffer provides them: the FIRST caller for a key
					// sizes it and every later caller gets that same buffer back. That sharing is what
					// lets sibling workers accumulate into one sketch and only one of them write it.
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
						return true; // granted synchronously; the callback is never called
					},
					unlock() {},
				},
			},
		},
		crawl_stats: {
			CrawlSketch: {
				async get(id) {
					const row = rows.get(id);
					return row ? { ...row } : null;
				},
				async put(id, data) {
					rows.set(id, { ...data });
				},
				async delete(id) {
					rows.delete(id);
				},
				async search() {
					return [];
				},
			},
		},
	};
	({ applyOptions } = await import('../src/config.js'));
	({ recordCrawl, flushSketches, computeBreadth, resetCrawlStats, OVERFLOW_BUCKET } = await import(
		'../src/util/crawlStats.js'
	));
	({ estimateSketch, createSketch, addToSketch } = await import('../src/util/hll.js'));
});

beforeEach(() => {
	applyOptions({});
	resetCrawlStats();
	rows.clear();
	locks = [];
	sabs.clear();
	mock.timers.reset();
});

const today = () => new Date().toISOString().slice(0, 10);

test('flush writes the node row with an accurate estimate, under the mutex', async () => {
	for (let i = 0; i < 1000; i++) recordCrawl('Googlebot', `https://site.example.com/p/${i}`);
	// Duplicates must not move it.
	for (let i = 0; i < 1000; i++) recordCrawl('Googlebot', `https://site.example.com/p/${i}`);
	await flushSketches();

	const row = rows.get(`${today()}|Googlebot|node-a`);
	assert.ok(row, 'node row written');
	assert.equal(row.bot, 'Googlebot');
	assert.equal(row.node, 'node-a');
	assert.ok(Math.abs(row.estimate - 1000) / 1000 <= 0.03, `estimate ${row.estimate}`);
	assert.ok(
		locks.some((k) => k.includes('crawlSketch/Googlebot')),
		'flush took the cross-worker mutex'
	);
});

test("flush UNIONS with the stored row — another worker's registers survive", async () => {
	// Simulate worker 1: URLs [0, 500).
	for (let i = 0; i < 500; i++) recordCrawl('Googlebot', `https://site.example.com/p/${i}`);
	await flushSketches();
	// Simulate worker 2 (fresh thread state): overlapping URLs [250, 750).
	resetCrawlStats();
	for (let i = 250; i < 750; i++) recordCrawl('Googlebot', `https://site.example.com/p/${i}`);
	await flushSketches();

	const row = rows.get(`${today()}|Googlebot|node-a`);
	// Union is 750 distinct — an overwrite would read ~500, a sum-like error ~1000.
	assert.ok(Math.abs(row.estimate - 750) / 750 <= 0.03, `estimate ${row.estimate}`);
});

test('bot cap folds overflow into the overflow bucket', async () => {
	applyOptions({ crawlStats: { maxBotsPerThread: 2 } });
	recordCrawl('Googlebot', 'https://site.example.com/a');
	recordCrawl('Bingbot', 'https://site.example.com/b');
	recordCrawl('SomeDerivedBot', 'https://site.example.com/c');
	recordCrawl('AnotherDerivedBot', 'https://site.example.com/d');
	await flushSketches();

	assert.ok(rows.has(`${today()}|Googlebot|node-a`));
	assert.ok(rows.has(`${today()}|Bingbot|node-a`));
	assert.ok(!rows.has(`${today()}|SomeDerivedBot|node-a`), 'overflow bot must not mint a sketch');
	const overflow = rows.get(`${today()}|${OVERFLOW_BUCKET}|node-a`);
	assert.ok(overflow, 'overflow bucket written');
	assert.equal(overflow.estimate, 2);
});

test('disabled config records nothing', async () => {
	applyOptions({ crawlStats: { enabled: false } });
	recordCrawl('Googlebot', 'https://site.example.com/a');
	await flushSketches();
	assert.equal(rows.size, 0);
});

test('UTC day rollover persists the old day and starts clean', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-08-04T23:59:00Z') });
	recordCrawl('Googlebot', 'https://site.example.com/old-day');

	t.mock.timers.setTime(Date.parse('2026-08-05T00:00:01Z'));
	recordCrawl('Googlebot', 'https://site.example.com/new-day');
	await tick(); // rollover persists the previous day via setImmediate
	await flushSketches();

	const oldRow = rows.get('2026-08-04|Googlebot|node-a');
	const newRow = rows.get('2026-08-05|Googlebot|node-a');
	assert.ok(oldRow, 'old day persisted at rollover');
	assert.ok(newRow, 'new day written by the next flush');
	assert.equal(oldRow.estimate, 1);
	assert.equal(newRow.estimate, 1, 'new day must not inherit the old sketch');
});

test('a failed flush re-marks its bots dirty and the retry succeeds', async () => {
	recordCrawl('Googlebot', 'https://site.example.com/a');
	const put = databases.crawl_stats.CrawlSketch.put;
	databases.crawl_stats.CrawlSketch.put = async () => {
		throw new Error('storage hiccup');
	};
	await assert.rejects(flushSketches());
	databases.crawl_stats.CrawlSketch.put = put;
	await flushSketches(); // must retry without new traffic
	assert.ok(rows.has(`${today()}|Googlebot|node-a`));
});

test('computeBreadth merges shards per bot and reports the cross-bot union', () => {
	const urls = (from, to) => {
		const s = createSketch();
		for (let i = from; i < to; i++) addToSketch(s, `https://site.example.com/p/${i}`);
		return s;
	};
	const breadth = computeBreadth([
		// Googlebot, two node shards with overlap: union 1500 distinct.
		{ day: '2026-08-04', bot: 'Googlebot', registers: urls(0, 1000) },
		{ day: '2026-08-04', bot: 'Googlebot', registers: urls(500, 1500) },
		// GPTBot crawled a subset Googlebot also crawled: cross-bot union stays 1500.
		{ day: '2026-08-04', bot: 'GPTBot', registers: urls(0, 300) },
		{ day: '2026-08-03', bot: 'Googlebot', registers: urls(0, 100) },
	]);

	assert.equal(breadth.length, 2);
	assert.equal(breadth[0].day, '2026-08-04', 'sorted newest first');
	const [google, gpt] = breadth[0].bots;
	assert.equal(google.bot, 'Googlebot');
	assert.equal(google.shards, 2);
	assert.ok(Math.abs(google.distinctUrls - 1500) / 1500 <= 0.03);
	assert.equal(gpt.bot, 'GPTBot');
	// Union across bots, not a sum: 1500 + 300 overlapping = 1500.
	assert.ok(Math.abs(breadth[0].total - 1500) / 1500 <= 0.03, `total ${breadth[0].total}`);
	assert.equal(breadth[1].bots[0].distinctUrls, 100);
	// estimateSketch sanity on the exported surface used by the admin route.
	assert.equal(estimateSketch(createSketch()), 0);
	assert.equal(breadth[0].mismatchedShards, 0);
});

test('computeBreadth reads rows written at a NON-DEFAULT precision', () => {
	// The field failure this pins (#102). Every read-side accumulator used to be built at the
	// module default, and `mergeSketch` refuses to merge across register spaces — so a
	// deployment running `crawlStats.precision: 12` merged nothing, and a sketch that merged
	// nothing estimates as exactly 0. The panel showed the rows, their shard counts, and zero
	// distinct URLs for every bot: indistinguishable from a day no crawler visited.
	const urls = (p, from, to) => {
		const s = createSketch(p);
		for (let i = from; i < to; i++) addToSketch(s, `https://site.example.com/p/${i}`);
		return s;
	};
	const breadth = computeBreadth([
		{ day: '2026-08-13', bot: 'Googlebot', registers: urls(12, 0, 1000) },
		{ day: '2026-08-13', bot: 'Googlebot', registers: urls(12, 500, 1500) },
		{ day: '2026-08-13', bot: 'GPTBot', registers: urls(12, 0, 300) },
	]);

	const [google, gpt] = breadth[0].bots;
	assert.equal(google.shards, 2);
	assert.ok(Math.abs(google.distinctUrls - 1500) / 1500 <= 0.05, `distinctUrls ${google.distinctUrls}`);
	assert.ok(gpt.distinctUrls > 0, 'every bot estimated, not just the first');
	// The union is the other accumulator that was pinned to the default: it zeroed the day
	// total even when the per-bot numbers were right.
	assert.ok(Math.abs(breadth[0].total - 1500) / 1500 <= 0.05, `total ${breadth[0].total}`);
	assert.equal(breadth[0].mismatchedShards, 0);
});

test('shards of another precision are counted as mismatched, never merged as garbage', () => {
	// The day `crawlStats.precision` changes, a node that has not rolled over yet still writes
	// the old shape. Those registers describe a different hash slice per index, so merging them
	// would be a plausible-looking wrong number — the undercount is correct, but it has to be
	// visible, which is the whole lesson of the bug above.
	const urls = (p, from, to) => {
		const s = createSketch(p);
		for (let i = from; i < to; i++) addToSketch(s, `https://site.example.com/p/${i}`);
		return s;
	};
	const breadth = computeBreadth([
		{ day: '2026-08-13', bot: 'Googlebot', registers: urls(12, 0, 1000) },
		{ day: '2026-08-13', bot: 'Googlebot', registers: urls(14, 0, 5000) }, // old-shape straggler
	]);

	const [google] = breadth[0].bots;
	assert.equal(google.shards, 1, 'only the mergeable shard counted');
	assert.equal(breadth[0].mismatchedShards, 1);
	assert.ok(
		Math.abs(google.distinctUrls - 1000) / 1000 <= 0.05,
		`distinctUrls ${google.distinctUrls} — the 5000-URL sketch of another shape must not leak in`
	);
});

// ── one writer per node (#87) + configurable precision ───────────────────────────────────────
// The row is 2^precision bytes and replicates, so every worker rewriting it per interval put
// ~256 KB per bot per interval of replicated transaction log behind one row's worth of state.
// Workers now merge into a node-shared sketch and one writes. These pin what that must not cost.

test('registers from a worker that did not write are carried by the worker that does', async () => {
	// A worker that loses the interval's turn: merges into the node-shared sketch, writes nothing.
	for (let i = 0; i < 500; i++) recordCrawl('Googlebot', `https://site.example.com/p/${i}`);
	await flushSketches({ write: false });
	assert.equal(rows.size, 0, 'losing the turn must not write a row');

	// The winner writes one row, which must account for BOTH workers' observations.
	for (let i = 500; i < 1000; i++) recordCrawl('Googlebot', `https://site.example.com/p/${i}`);
	await flushSketches({ write: true });

	const row = rows.get(`${today()}|Googlebot|node-a`);
	assert.ok(row, 'the winner wrote the row');
	assert.ok(
		Math.abs(row.estimate - 1000) / 1000 <= 0.03,
		`estimate ${row.estimate} should reflect all 1000 URLs, not just the 500 the writer saw`
	);
});

test('a restart with empty shared sketches cannot erase the registers already in the row', async () => {
	for (let i = 0; i < 800; i++) recordCrawl('Googlebot', `https://site.example.com/p/${i}`);
	await flushSketches();

	// Restart: shared buffers and thread state gone, the persisted row is not. The write path
	// must still read-merge, or the first post-restart flush replaces a full day of registers
	// with only what this process has seen since boot.
	sabs.clear();
	resetCrawlStats();

	recordCrawl('Googlebot', 'https://site.example.com/p/new');
	await flushSketches();

	const row = rows.get(`${today()}|Googlebot|node-a`);
	assert.ok(
		Math.abs(row.estimate - 801) / 801 <= 0.03,
		`estimate ${row.estimate} should still reflect the pre-restart 800, not just the 1 seen since`
	);
});

test('precision sets the row size, and a mismatched stored row is ignored rather than merged', async () => {
	// p = 10 -> 1 KB rows instead of 16 KB: the write-volume lever.
	applyOptions({ crawlStats: { precision: 10 } });
	recordCrawl('Googlebot', 'https://site.example.com/p/1');
	await flushSketches();
	const row = rows.get(`${today()}|Googlebot|node-a`);
	assert.equal(row.registers.length, 1 << 10, 'row is 2^precision bytes');

	// A row left behind at another precision describes a different register space. Merging it
	// element-wise would be meaningless, so it must be ignored — the new-shape sketch wins and
	// the day self-heals at rollover.
	sabs.clear();
	resetCrawlStats();
	applyOptions({ crawlStats: { precision: 12 } });
	recordCrawl('Googlebot', 'https://site.example.com/p/2');
	await flushSketches();

	const after = rows.get(`${today()}|Googlebot|node-a`);
	assert.equal(after.registers.length, 1 << 12, 'rewritten at the new precision');
	assert.ok(after.estimate >= 1, 'still a usable estimate rather than garbage from a bad merge');
});
