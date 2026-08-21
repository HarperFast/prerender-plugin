import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketize, bucketWidthFor, clampRange } from '../src/util/analyticsRead.js';

// Rows as they come off system.hdb_analytics directly: the PK is the raw composite
// [epochMs, nodeId] — get_analytics flattens it, the console reader must do its own.
const row = (ts, metric, dims = {}, stats = {}) => ({
	id: [ts, 1],
	metric,
	path: dims.path ?? null,
	method: dims.method ?? null,
	type: dims.type ?? null,
	count: 'count' in stats ? stats.count : 1,
	total: 'total' in stats ? stats.total : 'count' in stats ? stats.count : 1,
	mean: stats.mean,
	median: stats.median,
	p95: stats.p95,
});

const WINDOW = { startMs: 0, endMs: 600_000, bucketMs: 60_000 }; // 10 one-minute buckets

test('bucket width: whole minutes, at most ~48 buckets per window', () => {
	assert.equal(bucketWidthFor(15 * 60_000), 60_000); // 15m -> 1m
	assert.equal(bucketWidthFor(3_600_000), 120_000); // 1h -> 2m (30 buckets)
	assert.equal(bucketWidthFor(24 * 3_600_000), 30 * 60_000); // 24h -> 30m (48 buckets)
	// Never below the aggregate period, however narrow the window.
	assert.equal(bucketWidthFor(60_000), 60_000);
});

test('counter combos: counts land in the right buckets, split by dimension combo', () => {
	const { series, bucketCount } = bucketize(
		[
			row(30_000, 'bot_serve', { path: 'cache', method: 'hit', type: 'Googlebot' }, { count: 5 }),
			row(90_000, 'bot_serve', { path: 'cache', method: 'hit', type: 'Googlebot' }, { count: 7 }),
			row(90_000, 'bot_serve', { path: 'origin', method: 'miss', type: 'Googlebot' }, { count: 2 }),
		],
		WINDOW
	);
	assert.equal(bucketCount, 10);
	assert.equal(series.length, 2);

	const hits = series.find((s) => s.method === 'hit');
	assert.equal(hits.count, 12);
	assert.deepEqual(hits.counts.slice(0, 3), [5, 7, 0]);
	// Counters carry no distribution arrays — nothing pretends to be a percentile.
	assert.equal(hits.means, undefined);

	// Ordered biggest-first, so a payload reader sees the traffic before the tail.
	assert.equal(series[0], hits);
});

test('value combos: count-weighted mean/p95, gaps stay null (never zero)', () => {
	const { series } = bucketize(
		[
			row(30_000, 'page_age', { path: 'Googlebot' }, { count: 3, mean: 100, median: 90, p95: 200 }),
			row(45_000, 'page_age', { path: 'Googlebot' }, { count: 1, mean: 500, median: 480, p95: 800 }),
			// bucket 2 has no rows; bucket 3 does
			row(200_000, 'page_age', { path: 'Googlebot' }, { count: 2, mean: 50, median: 40, p95: 60 }),
		],
		WINDOW
	);
	const ages = series[0];
	assert.equal(ages.count, 6);
	// Bucket 0 merges two rows: (100*3 + 500*1) / 4 = 200
	assert.equal(ages.means[0], 200);
	assert.equal(ages.p95s[0], (200 * 3 + 800 * 1) / 4);
	// An empty minute is absence of data, not zero latency.
	assert.equal(ages.means[1], null);
	assert.equal(ages.means[3], 50);
	// Overall stats are weighted across the whole window.
	assert.equal(ages.mean, (100 * 3 + 500 * 1 + 50 * 2) / 6);

	// The MEDIAN is bucketed too, not only summarized. A console that can put a median in a tile
	// but never in a trend line ends up charting p95s and calling them typical.
	assert.equal(ages.medians[0], (90 * 3 + 480 * 1) / 4);
	assert.equal(ages.medians[1], null);
	assert.equal(ages.medians[3], 40);
	assert.equal(ages.median, (90 * 3 + 480 * 1 + 40 * 2) / 6);
});

test('rows outside the window and rows with junk are dropped, not misfiled', () => {
	const { series } = bucketize(
		[
			row(-5_000, 'bot_serve', { method: 'hit' }, { count: 100 }), // before the window
			row(600_000, 'bot_serve', { method: 'hit' }, { count: 100 }), // at endMs — exclusive
			{ id: 'not-a-pk', metric: 'bot_serve', method: 'hit', count: 100 }, // unparseable ts
			row(60_000, 'bot_serve', { method: 'hit' }, { count: 4 }),
			// A row with a null count contributes nothing rather than NaN-poisoning the series
			// (numberOf(null) is NaN by design).
			row(60_000, 'bot_serve', { method: 'hit' }, { count: null, total: null }),
		],
		WINDOW
	);
	assert.equal(series.length, 1);
	assert.equal(series[0].count, 4);
	assert.equal(series[0].counts[1], 4);
	assert.ok(series[0].counts.every(Number.isFinite));
});

test('a null mean is excluded from the weighting entirely, not counted as zero', () => {
	const { series } = bucketize(
		[
			row(30_000, 'page_age', {}, { count: 2, mean: null, median: null, p95: null }),
			row(40_000, 'page_age', {}, { count: 2, mean: 300, median: 300, p95: 400 }),
		],
		WINDOW
	);
	// The null-mean row still counts toward `count` (it happened) but carries no weight in
	// the distribution merge: dividing by the full count would floor the average (150), and
	// treating null as 0 would halve it — both plausible-looking and wrong.
	assert.equal(series[0].count, 4);
	assert.equal(series[0].mean, 300);
	assert.equal(series[0].p95, 400);
	assert.equal(series[0].means[0], 300);
});

test('clampRange: absence means the one-hour default, never the one-minute floor', () => {
	const MAX = 24 * 3_600_000;
	// The Number(null)-is-0 trap: an absent parameter must not clamp to the floor.
	assert.equal(clampRange(null, MAX), 3_600_000);
	assert.equal(clampRange(undefined, MAX), 3_600_000);
	assert.equal(clampRange('', MAX), 3_600_000);
	assert.equal(clampRange('garbage', MAX), 3_600_000);
	// Explicit values clamp to [1 minute, maxRange].
	assert.equal(clampRange('900000', MAX), 900_000);
	assert.equal(clampRange('5', MAX), 60_000);
	assert.equal(clampRange(String(48 * 3_600_000), MAX), MAX);
});
