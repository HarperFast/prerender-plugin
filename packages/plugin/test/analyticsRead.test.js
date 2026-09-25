import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bucketize, bucketWidthFor, clampRange, readAnalyticsWindow, systemSeries } from '../src/util/analyticsRead.js';

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

// ------------------------------------------------------------------ Harper's system rows

// A system row as Harper's main thread writes it: the PK carries the node id, the columns are the
// metric's own (no path/method/type, no count except on the merged worker `utilization` row).
const sys = (ts, metric, columns = {}, nodeId = 7) => ({ id: [ts, nodeId], metric, ...columns });

test('system: CPU and memory are per-bucket means, and an empty bucket is null, never 0', () => {
	const [node, ...rest] = systemSeries(
		[
			sys(10_000, 'resource-usage', { cpuUtilization: 0.5, majorPageFault: 2 }),
			sys(50_000, 'resource-usage', { cpuUtilization: 1.5, majorPageFault: 3 }),
			// bucket 1 has nothing at all; bucket 2 does
			sys(130_000, 'resource-usage', { cpuUtilization: 0.25, majorPageFault: 0 }),
			sys(20_000, 'main-thread-utilization', { rss: 1000, heapUsed: 100, taskQueueLatency: 4, active: 1, idle: 9 }),
			sys(40_000, 'main-thread-utilization', { rss: 3000, heapUsed: 300, taskQueueLatency: 8, active: 1, idle: 9 }),
		],
		WINDOW
	);
	assert.equal(rest.length, 0);
	assert.equal(node.nodeId, 7);
	assert.equal(node.cpu.length, 10);
	assert.equal(node.cpu[0], 1); // (0.5 + 1.5) / 2 — a fraction of ONE core, so above 1 is legal
	// A gap is absence, not idleness: a 0 here would draw a quiet node where there is no data.
	assert.equal(node.cpu[1], null);
	assert.equal(node.cpu[2], 0.25);
	assert.equal(node.rss[0], 2000);
	assert.equal(node.heapUsed[0], 200);
	assert.equal(node.taskQueueLatency[0], 6);
	assert.equal(node.rss[2], null);
	// Every array shares the window's bucket geometry.
	for (const key of ['cpu', 'majorFaults', 'rss', 'heapUsed', 'elu', 'taskQueueLatency', 'workerElu']) {
		assert.equal(node[key].length, 10, key);
	}
});

test('system: major faults are SUMMED per bucket (each row is already a per-pass count), null where unsampled', () => {
	const [node] = systemSeries(
		[
			sys(10_000, 'resource-usage', { cpuUtilization: 0.1, majorPageFault: 2 }),
			sys(50_000, 'resource-usage', { cpuUtilization: 0.1, majorPageFault: 3 }),
			sys(130_000, 'resource-usage', { cpuUtilization: 0.1, majorPageFault: 0 }),
		],
		WINDOW
	);
	assert.equal(node.majorFaults[0], 5);
	// A sampled zero stays a zero; an unsampled bucket is null — the two must not look alike.
	assert.equal(node.majorFaults[2], 0);
	assert.equal(node.majorFaults[1], null);
});

test('system: event-loop utilization is the ratio of SUMS over the bucket, not a mean of ratios', () => {
	const [node] = systemSeries(
		[
			// Main thread: a busy 60 s pass (50%) and a quiet 100 s one (10%) in the same bucket.
			sys(10_000, 'main-thread-utilization', { active: 30_000, idle: 30_000 }),
			sys(50_000, 'main-thread-utilization', { active: 10_000, idle: 90_000 }),
			// Workers: Harper merges one sample per worker report into means, `count` = reports
			// merged. A row with no count is one report.
			sys(20_000, 'utilization', { active: 900, idle: 100, count: 3 }),
			sys(40_000, 'utilization', { active: 100, idle: 900 }),
		],
		WINDOW
	);
	// 40 s busy of 160 s wall = 0.25. The mean of the two ratios would say 0.30.
	assert.equal(node.elu[0], 40_000 / 160_000);
	// (900×3 + 100) / ((900+100)×3 + 1000) = 2800 / 4000
	assert.equal(node.workerElu[0], 0.7);
	assert.equal(node.elu[1], null);
	assert.equal(node.workerElu[1], null);
	// latest.* is the newest row's own ratio.
	assert.equal(node.latest.elu, 0.1);
	assert.equal(node.latest.workerElu, 0.1);
});

test('system: disk is the lowest available/size among the NEWEST pass, whatever the row order', () => {
	const rows = [
		// An older pass that looked worse — it must not win on age alone.
		sys(100_000, 'storage-volume', { available: 1, size: 100 }),
		sys(100_001, 'storage-volume', { available: 1, size: 100 }),
		// The newest pass: two databases, two volumes. `system` is the fuller one (5% vs 50%).
		sys(400_000, 'storage-volume', { available: 50, size: 100 }),
		sys(400_002, 'storage-volume', { available: 10, size: 200 }),
		// Junk never becomes a disk: no size, or a zero size, is skipped rather than divided by.
		sys(400_003, 'storage-volume', { available: 0, size: 0 }),
		sys(400_004, 'storage-volume', { available: null, size: 100 }),
	];
	for (const order of [rows, [...rows].reverse(), [rows[3], rows[0], rows[5], rows[2], rows[4], rows[1]]]) {
		const [node] = systemSeries(order, WINDOW);
		assert.equal(node.latest.diskAvailable, 10);
		assert.equal(node.latest.diskSize, 200);
	}
});

test('system: latest takes each field from its own newest row, and absent fields are null', () => {
	const [node] = systemSeries(
		[
			sys(10_000, 'resource-usage', { cpuUtilization: 0.9 }),
			sys(70_000, 'resource-usage', { cpuUtilization: 0.3 }),
			// main-thread rows are skipped on quiet passes, so their newest can be older than the CPU's
			sys(20_000, 'main-thread-utilization', { rss: 5000, heapUsed: 50, taskQueueLatency: 2, active: 1, idle: 3 }),
			// a newer row missing a column does not blank the older value out
			sys(80_000, 'resource-usage', {}),
		],
		WINDOW
	);
	assert.equal(node.latest.at, 80_000); // the newest system row of any kind
	assert.equal(node.latest.cpu, 0.3);
	assert.equal(node.latest.rss, 5000);
	assert.equal(node.latest.heapUsed, 50);
	assert.equal(node.latest.taskQueueLatency, 2);
	assert.equal(node.latest.elu, 0.25);
	assert.equal(node.latest.workerElu, null);
	assert.equal(node.latest.diskAvailable, null);
	assert.equal(node.latest.diskSize, null);
	assert.equal(node.hostname, null); // resolved by the scan, not by this pure fold
});

test('system: several node ids (a replicated hdb_analytics) fold into separate nodes', () => {
	const nodes = systemSeries(
		[
			sys(10_000, 'resource-usage', { cpuUtilization: 0.2 }, 222),
			sys(10_000, 'resource-usage', { cpuUtilization: 0.8 }, 111),
			sys(70_000, 'resource-usage', { cpuUtilization: 0.4 }, 222),
		],
		WINDOW
	);
	assert.deepEqual(
		nodes.map((n) => n.nodeId),
		[111, 222]
	);
	assert.equal(nodes[0].cpu[0], 0.8);
	assert.equal(nodes[0].cpu[1], null);
	assert.equal(nodes[1].cpu[0], 0.2);
	assert.equal(nodes[1].cpu[1], 0.4);
	assert.equal(nodes[1].latest.cpu, 0.4);
});

test('system: rows outside the window, unparseable ids and non-system metrics are ignored', () => {
	const nodes = systemSeries(
		[
			sys(-1, 'resource-usage', { cpuUtilization: 9 }),
			sys(600_000, 'resource-usage', { cpuUtilization: 9 }), // at endMs — exclusive
			{ id: 'nope', metric: 'resource-usage', cpuUtilization: 9 },
			sys(10_000, 'bot_serve', { count: 5 }),
			sys(10_000, 'table-size', { size: 123 }),
		],
		WINDOW
	);
	assert.deepEqual(nodes, []);
});

// ------------------------------------------------------------------ the scan, end to end

/**
 * A fake `system.hdb_analytics` for readAnalyticsWindow: yields the given rows newest-first, as the
 * descending walk would. Each test uses its own range, because the reader caches per range.
 */
function withFakeAnalytics(rows, { hostnames = {}, replicate = false } = {}) {
	globalThis.server = { hostname: 'node-a.example.com' };
	globalThis.databases = {
		system: {
			hdb_analytics: {
				replicate,
				async *search() {
					yield* [...rows].sort((a, b) => b.id[0] - a.id[0]);
				},
			},
			hdb_analytics_hostname: {
				async get(id) {
					if (id === 'boom') throw new Error('lookup failed');
					return hostnames[id] ? { id, hostname: hostnames[id] } : undefined;
				},
			},
		},
	};
}

test('scan: system rows feed `system`, never `series`, in the same single walk', async () => {
	const now = Date.now();
	withFakeAnalytics(
		[
			sys(now - 30_000, 'bot_serve', { path: 'cache', method: 'hit', type: 'Googlebot', count: 4 }),
			sys(now - 30_000, 'resource-usage', { cpuUtilization: 0.4, majorPageFault: 1 }, 111),
			sys(now - 29_000, 'main-thread-utilization', { rss: 10, heapUsed: 5, active: 1, idle: 1 }, 111),
			sys(now - 28_000, 'utilization', { active: 1, idle: 3, count: 2 }, 111),
			sys(now - 27_000, 'storage-volume', { available: 40, size: 100 }, 111),
			sys(now - 30_000, 'resource-usage', { cpuUtilization: 0.6 }, 222),
		],
		{ hostnames: { 111: 'node-a.example.com', 222: 'node-b.example.com' }, replicate: true }
	);
	const window = await readAnalyticsWindow(11 * 60_000);

	assert.deepEqual(
		window.series.map((s) => s.metric),
		['bot_serve']
	);
	assert.equal(window.scan.scanned, 6);
	assert.equal(window.scan.system, 5);
	assert.equal(window.scan.kept, 6);
	assert.equal(window.scope, 'cluster');

	const [a, b] = window.system.nodes;
	assert.equal(a.hostname, 'node-a.example.com');
	assert.equal(b.hostname, 'node-b.example.com');
	assert.equal(a.cpu.length, window.bucketCount);
	assert.equal(a.latest.cpu, 0.4);
	assert.equal(a.latest.diskAvailable, 40);
	assert.equal(a.latest.workerElu, 0.25);
	assert.equal(b.latest.cpu, 0.6);
});

test('scan: an unresolved hostname falls back to this server only when the window holds one node', async () => {
	const now = Date.now();
	withFakeAnalytics([sys(now - 30_000, 'resource-usage', { cpuUtilization: 0.4 }, 111)]);
	const single = await readAnalyticsWindow(12 * 60_000);
	assert.equal(single.system.nodes[0].hostname, 'node-a.example.com');

	// Two unnamed nodes: which one is local is unknowable from the rows, so neither is guessed —
	// and a lookup that throws costs its own node's name, not the payload.
	withFakeAnalytics([
		sys(now - 30_000, 'resource-usage', { cpuUtilization: 0.4 }, 111),
		sys(now - 30_000, 'resource-usage', { cpuUtilization: 0.4 }, 'boom'),
	]);
	const several = await readAnalyticsWindow(13 * 60_000);
	assert.deepEqual(
		several.system.nodes.map((n) => n.hostname),
		[null, null]
	);
});
