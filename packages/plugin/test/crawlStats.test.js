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
});
