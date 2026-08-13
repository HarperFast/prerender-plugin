import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	CLUSTER,
	MERGED_GET,
	mergeAnalytics,
	mergeConfig,
	mergerFor,
	mergeOverview,
	mergeUnrouted,
	NODE_LOCAL_POST,
	SHARED_NOTE,
	sourcesOf,
} from '../src/util/aggregate.js';
import { PROXIED_GET, PROXIED_POST, resolveScope } from '../src/util/proxy.js';

const NODES = ['https://a.example.com:9926', 'https://b.example.com:9926', 'https://c.example.com:9926'];

/** One successful fan-out result. */
const ok = (host, body, ms = 10) => ({
	origin: `https://${host}.example.com:9926`,
	hostname: `${host}.example.com:9926`,
	ok: true,
	status: 200,
	error: null,
	ms,
	body,
});

const down = (host, error = 'unreachable: socket hang up') => ({
	origin: `https://${host}.example.com:9926`,
	hostname: `${host}.example.com:9926`,
	ok: false,
	status: 0,
	error,
	ms: 5,
});

// ------------------------------------------------------------------ classification

test('every proxied GET route is classified: merged, or shared with a stated reason', () => {
	// The classification is the whole safety property — a route that is neither merged nor
	// explicitly declared shared would be answered by one node while the console said
	// "all nodes", which is exactly the silent quartering this feature exists to end. Adding a
	// route to the proxy without deciding how it aggregates has to fail here, not in a browser.
	for (const route of PROXIED_GET) {
		if (route === 'session') continue; // handled by the resource itself, never merged
		const classified = MERGED_GET.includes(route) || route in SHARED_NOTE;
		assert.ok(classified, `GET "${route}" has no cluster classification (add it to MERGED_GET or SHARED_NOTE)`);
	}
	for (const route of MERGED_GET) {
		assert.ok(PROXIED_GET.includes(route), `MERGED_GET lists "${route}", which the proxy does not forward`);
		assert.ok(typeof mergerFor(route) === 'function', `no merge function for "${route}"`);
	}
	for (const route of Object.keys(SHARED_NOTE)) {
		assert.ok(PROXIED_GET.includes(route), `SHARED_NOTE describes "${route}", which the proxy does not forward`);
	}
});

test('node-local POST routes are refused under cluster scope, and are real routes', () => {
	for (const route of Object.keys(NODE_LOCAL_POST)) {
		assert.ok(PROXIED_POST.includes(route), `NODE_LOCAL_POST names "${route}", which the proxy does not forward`);
	}
	// `queue` must NOT be here: a control write is replicated intent and carries its own scope.
	assert.equal('queue' in NODE_LOCAL_POST, false);
});

test('resolveScope: cluster is the default, a node is opt-in, anything else is refused', () => {
	assert.deepEqual(resolveScope(undefined, NODES), { cluster: true });
	assert.deepEqual(resolveScope('', NODES), { cluster: true });
	assert.deepEqual(resolveScope(CLUSTER, NODES), { cluster: true });
	assert.deepEqual(resolveScope('CLUSTER', NODES), { cluster: true });
	assert.deepEqual(resolveScope('b.example.com:9926', NODES), { cluster: false, origin: NODES[1] });
	assert.deepEqual(resolveScope(NODES[2], NODES), { cluster: false, origin: NODES[2] });
	// The SSRF gate is untouched by the sentinel.
	assert.equal(resolveScope('evil.example.net', NODES), null);
	assert.equal(resolveScope('https://evil.example.net', NODES), null);
	assert.equal(resolveScope(CLUSTER, []), null);
	// One node is not a cluster: the sentinel collapses to it rather than fanning out to one.
	assert.deepEqual(resolveScope(CLUSTER, [NODES[0]]), { cluster: false, origin: NODES[0] });
});

test('sourcesOf reports completeness, and a node that failed is named with its reason', () => {
	const sources = sourcesOf([ok('a', {}), down('b', 'timed out')], { mode: 'merged' });
	assert.equal(sources.answered, 1);
	assert.equal(sources.configured, 2);
	assert.equal(sources.complete, false);
	assert.equal(sources.nodes.find((n) => !n.ok).error, 'timed out');
	assert.equal(sourcesOf([], { mode: 'merged' }).complete, false, 'zero nodes is never "complete"');
});

// ------------------------------------------------------------------ analytics

const series = (over) => ({
	metric: 'bot_serve',
	path: 'cache',
	method: 'hit',
	type: null,
	count: 0,
	total: 0,
	counts: [0, 0],
	...over,
});

const analyticsBody = (node, over = {}) => ({
	available: true,
	scope: 'node',
	node,
	rangeMs: 3_600_000,
	startMs: 1000,
	endMs: 3_601_000,
	bucketMs: 1_800_000,
	bucketCount: 2,
	coveredFromMs: 1000,
	coveredToMs: 3_601_000,
	truncated: false,
	intervals: { defaultRenderInterval: 86_400_000, jobLeaseTime: 300_000 },
	scan: { ms: 20, scanned: 500, kept: 100, cap: 50_000 },
	cacheAgeMs: 0,
	series: [],
	...over,
});

test('analytics: counts sum element-wise across nodes and the window is preserved', () => {
	const merged = mergeAnalytics([
		ok('a', analyticsBody('a', { series: [series({ count: 30, total: 30, counts: [10, 20] })] })),
		ok('b', analyticsBody('b', { series: [series({ count: 7, total: 7, counts: [3, 4] })] })),
	]);

	assert.equal(merged.status, 200);
	assert.equal(merged.body.scope, 'cluster');
	assert.equal(merged.body.series.length, 1);
	assert.equal(merged.body.series[0].count, 37);
	assert.deepEqual(merged.body.series[0].counts, [13, 24]);
	assert.equal(merged.body.scan.scans, 2);
	assert.equal(merged.body.scan.scanned, 1000);
	assert.equal(merged.body.sources.complete, true);
	assert.equal(merged.body.bucketMs, 1_800_000, 'the bucket width must survive the merge');
});

test('analytics: distinct combos stay distinct, and a combo only one node has still lands', () => {
	const merged = mergeAnalytics([
		ok('a', analyticsBody('a', { series: [series({ count: 5, counts: [5, 0] })] })),
		ok('b', {
			...analyticsBody('b'),
			series: [series({ method: 'miss', count: 2, counts: [2, 0] }), series({ count: 1, counts: [1, 0] })],
		}),
	]);

	const byMethod = Object.fromEntries(merged.body.series.map((s) => [s.method, s.count]));
	assert.deepEqual(byMethod, { hit: 6, miss: 2 });
	// Biggest series first, so a reader sees the traffic before the tail.
	assert.equal(merged.body.series[0].method, 'hit');
});

test('analytics: percentiles merge count-weighted, not averaged', () => {
	// 1000 requests at p95 100ms and 10 at p95 5000ms is ~148ms, NOT the 2550ms a plain mean of
	// the two p95s would give. Getting this wrong makes one idle node dominate the latency chart.
	const merged = mergeAnalytics([
		ok(
			'a',
			analyticsBody('a', {
				series: [
					series({
						metric: 'duration',
						count: 1000,
						counts: [1000, 0],
						mean: 90,
						median: 80,
						p95: 100,
						means: [90, null],
						p95s: [100, null],
					}),
				],
			})
		),
		ok(
			'b',
			analyticsBody('b', {
				series: [
					series({
						metric: 'duration',
						count: 10,
						counts: [10, 0],
						mean: 4000,
						median: 3000,
						p95: 5000,
						means: [4000, null],
						p95s: [5000, null],
					}),
				],
			})
		),
	]);

	const merged95 = merged.body.series[0].p95;
	assert.equal(Math.round(merged95), Math.round((100 * 1000 + 5000 * 10) / 1010));
	assert.ok(merged95 < 200, `count-weighted p95 should stay near the busy node's, got ${merged95}`);
	// Per-bucket too, and a bucket no node had stats for stays null rather than becoming 0.
	assert.equal(Math.round(merged.body.series[0].p95s[0]), Math.round(merged95));
	assert.equal(merged.body.series[0].p95s[1], null);
});

test('analytics: a node that did not answer is excluded and the payload says so', () => {
	const merged = mergeAnalytics([
		ok('a', analyticsBody('a', { series: [series({ count: 30, counts: [30, 0] })] })),
		down('b'),
	]);

	assert.equal(merged.body.series[0].count, 30);
	assert.equal(merged.body.sources.complete, false);
	assert.equal(merged.body.sources.answered, 1);
	assert.equal(merged.body.sources.configured, 2);
});

test('analytics: a replicated analytics table is NOT summed — that would multiply the cluster', () => {
	const body = analyticsBody('a', { scope: 'cluster', series: [series({ count: 40, counts: [40, 0] })] });
	const merged = mergeAnalytics([ok('a', body), ok('b', { ...body, node: 'b' })]);

	assert.equal(merged.body.series[0].count, 40, 'replicated rows must be read once, not summed');
	assert.equal(merged.body.sources.mode, 'shared');
	assert.match(merged.body.sources.note, /replicate/);
});

test('analytics: a node with a different bucket width is dropped from the merge, with the reason', () => {
	// Index alignment is only valid at one bucket width. A peer on an older plugin (or a smaller
	// maxRange) clamps the range differently; smearing its buckets into the others' would be an
	// invisible corruption of every chart.
	const merged = mergeAnalytics([
		ok('a', analyticsBody('a', { series: [series({ count: 10, counts: [10, 0] })] })),
		ok('b', analyticsBody('b', { series: [series({ count: 10, counts: [10, 0] })] })),
		ok('c', analyticsBody('c', { bucketMs: 60_000, bucketCount: 60, series: [series({ count: 999, counts: [999] })] })),
	]);

	assert.equal(merged.body.series[0].count, 20, 'the mismatched node must not contribute counts');
	assert.equal(merged.body.bucketMs, 1_800_000);
	assert.equal(merged.body.sources.complete, false);
	const excluded = merged.body.sources.nodes.find((n) => n.hostname.startsWith('c.'));
	assert.equal(excluded.ok, false);
	assert.match(excluded.error, /bucket width/);
});

test('analytics: truncation is contagious and the covered window is the intersection', () => {
	const merged = mergeAnalytics([
		ok('a', analyticsBody('a', { truncated: true, coveredFromMs: 2000, coveredToMs: 3_000_000 })),
		ok('b', analyticsBody('b', { truncated: false })),
	]);

	assert.equal(merged.body.truncated, true);
	assert.equal(merged.body.coveredFromMs, 2000, 'the least-covered node bounds the honest claim');
	assert.equal(merged.body.coveredToMs, 3_000_000);
});

test('analytics: per-node totals ride along so every node gets a throughput number', () => {
	const merged = mergeAnalytics([
		ok(
			'a',
			analyticsBody('a', { series: [series({ metric: 'render', path: 'outcome', count: 60, counts: [60, 0] })] })
		),
		ok(
			'b',
			analyticsBody('b', { series: [series({ metric: 'render', path: 'outcome', count: 20, counts: [20, 0] })] })
		),
	]);

	assert.equal(merged.body.byNode.length, 2);
	// Keyed by the node's OWN hostname — the join key for QueueStatus rows, which carry no port.
	assert.deepEqual(
		merged.body.byNode.map((n) => n.node),
		['a', 'b']
	);
	assert.equal(merged.body.byNode[0].totals[0].count, 60);
	assert.equal(merged.body.byNode[1].totals[0].count, 20);
});

test('analytics: divergent reference intervals are flagged, never silently taken from node one', () => {
	const merged = mergeAnalytics([
		ok('a', analyticsBody('a')),
		ok('b', analyticsBody('b', { intervals: { defaultRenderInterval: 3600_000, jobLeaseTime: 300_000 } })),
	]);
	assert.equal(merged.body.intervalsDiverge, true);
});

test('analytics: nothing answering is a 502, never an empty window', () => {
	// An empty window renders as "zero traffic", which on a live cluster is the most dangerous
	// number this console could print.
	const merged = mergeAnalytics([down('a'), down('b')]);
	assert.equal(merged.status, 502);
	assert.equal(merged.body.sources.answered, 0);
});

// ------------------------------------------------------------------ overview

const overviewBody = (node, over = {}) => ({
	generatedAt: 1_000_000,
	node,
	localQueueStatus: 'queued',
	control: { cluster: null, knownScopes: ['all', node] },
	nodes: [{ hostname: node, status: 'queued', updatedTime: 900_000, stale: false, isThisNode: true, override: null }],
	counts: { targets: { recordCount: 1000 }, pages: { recordCount: 900 } },
	countsAsOf: 950_000,
	backlog: {
		enabled: true,
		interval: 3_600_000,
		running: false,
		lastRun: {
			overdue: 10,
			inFlight: 2,
			belowFloor: 0,
			buckets: [
				{ hour: 0, count: 5 },
				{ hour: 1, count: 7 },
			],
			scanned: 100,
			cap: 2000,
			truncated: false,
			finishedAt: 990_000,
			error: null,
		},
	},
	intervals: { statusSyncInterval: 30_000, jobLeaseTime: 300_000, defaultRenderInterval: 86_400_000 },
	claimFloor: { enabled: true, lagMs: 60_000, occupancy: 2, floorHeldBy: 'https://x.example.com/a' },
	reconcile: {
		enabled: true,
		interval: 3_600_000,
		running: false,
		lastRun: { examined: 10, owned: 3, restored: 0, finishedAt: 980_000 },
	},
	...over,
});

test('overview: the backlog SUMS across nodes — the number no single node can report', () => {
	// Each node snapshots only the residency-pinned keys it owns, so this sum is the cluster's
	// real render backlog. Before cluster scope an operator had to open four tabs and add up.
	const merged = mergeOverview([ok('a', overviewBody('a')), ok('b', overviewBody('b')), ok('c', overviewBody('c'))]);

	const run = merged.body.backlog.lastRun;
	assert.equal(run.overdue, 30);
	assert.equal(run.inFlight, 6);
	assert.deepEqual(run.buckets, [
		{ hour: 0, count: 15 },
		{ hour: 1, count: 21 },
	]);
	assert.equal(run.nodes, 3);
});

test('overview: replicated table counts are NOT summed, and disagreement is surfaced', () => {
	const merged = mergeOverview([
		ok('a', overviewBody('a')),
		ok('b', overviewBody('b', { counts: { targets: { recordCount: 1000 }, pages: { recordCount: 900 } } })),
	]);
	assert.equal(merged.body.counts.targets.recordCount, 1000, 'a replicated count must not add up');
	assert.equal(merged.body.counts.targets.divergent, false);

	const diverged = mergeOverview([
		ok('a', overviewBody('a')),
		ok('b', overviewBody('b', { counts: { targets: { recordCount: 400 }, pages: { recordCount: 900 } } })),
	]);
	assert.equal(diverged.body.counts.targets.divergent, true, 'a 60% spread is a replication gap, not jitter');
	assert.equal(diverged.body.counts.targets.spread.low, 400);
	assert.equal(diverged.body.counts.targets.spread.high, 1000);
	assert.equal(diverged.body.counts.pages.divergent, false, 'agreeing tables stay unflagged');
});

test('overview: the claim floor reports the WORST node and names it, but sums in-flight leases', () => {
	const merged = mergeOverview([
		ok('a', overviewBody('a', { claimFloor: { enabled: true, lagMs: 60_000, occupancy: 2 } })),
		ok('b', overviewBody('b', { claimFloor: { enabled: true, lagMs: 7_200_000, occupancy: 5 } })),
	]);

	assert.equal(merged.body.claimFloor.lagMs, 7_200_000, 'the queue is as healthy as its most-pinned node');
	assert.equal(merged.body.claimFloor.worstNode, 'b.example.com:9926');
	assert.equal(merged.body.claimFloor.occupancy, 7, 'leases in flight add up — that is cluster concurrency');
	assert.equal(merged.body.claimFloor.byNode.length, 2);
});

test('overview: ONE node with the repair sweep off is the finding, not "the cluster has it on"', () => {
	// Each node repairs only the keys it owns, so a single disabled node leaves ~1/N of the
	// corpus unrepairable — while every other panel keeps looking healthy.
	const merged = mergeOverview([
		ok('a', overviewBody('a')),
		ok('b', overviewBody('b', { reconcile: { enabled: false, interval: 3_600_000, running: false, lastRun: null } })),
	]);

	assert.equal(merged.body.reconcile.enabled, false);
	assert.deepEqual(merged.body.reconcile.disabledOn, ['b.example.com:9926']);
	assert.equal(merged.body.reconcile.lastRun.examined, 10, 'the sweep that did run still counts');
});

test('overview: a node with no snapshot is named, not counted as zero backlog', () => {
	const merged = mergeOverview([
		ok('a', overviewBody('a')),
		ok('b', overviewBody('b', { backlog: { enabled: true, interval: 3_600_000, running: false, lastRun: null } })),
	]);

	assert.equal(merged.body.backlog.lastRun.overdue, 10);
	assert.deepEqual(merged.body.backlog.lastRun.missing, ['b.example.com:9926']);
	assert.equal(merged.body.backlog.lastRun.nodes, 1);
});

test('overview: aggregate freshness is the STALEST input, not the newest', () => {
	const merged = mergeOverview([
		ok('a', overviewBody('a', { generatedAt: 1_000_000 })),
		ok('b', overviewBody('b', { generatedAt: 2_000_000 })),
	]);
	assert.equal(merged.body.generatedAt, 1_000_000);
	assert.equal(merged.body.backlog.lastRun.finishedAt, 990_000);
});

test('overview: the node table is deduplicated by hostname, keeping the freshest row', () => {
	// QueueStatus replicates, so all three nodes report all three rows — and one node's copy of
	// a peer may be lagging. The freshest wins; a hostname must appear exactly once.
	const roster = [
		{ hostname: 'a', status: 'queued', updatedTime: 900_000, stale: false, isThisNode: true, override: null },
		{ hostname: 'b', status: 'empty', updatedTime: 800_000, stale: false, isThisNode: false, override: null },
	];
	const merged = mergeOverview([
		ok('a', overviewBody('a', { nodes: roster })),
		ok(
			'b',
			overviewBody('b', {
				nodes: [roster[0], { ...roster[1], status: 'paused', updatedTime: 950_000, isThisNode: true }],
			})
		),
	]);

	assert.equal(merged.body.nodes.length, 2);
	const b = merged.body.nodes.find((n) => n.hostname === 'b');
	assert.equal(b.status, 'paused', 'the freshest report wins');
	assert.equal(b.isThisNode, false, 'there is no "this node" in a cluster view');
});

// ------------------------------------------------------------------ unrouted

test('unrouted: buckets sum across nodes and stay labelled as a per-worker SAMPLE', () => {
	const body = (node, rows) => ({
		node,
		workerIndex: 0,
		perWorker: true,
		interval: 60_000,
		report: { overflowed: false, unclassified: rows, passthrough: [] },
	});
	const merged = mergeUnrouted([
		ok('a', body('a', [{ bucket: '/checkout', count: 3, samplePath: '/checkout/x' }])),
		ok(
			'b',
			body('b', [
				{ bucket: '/checkout', count: 4, samplePath: '/checkout/y' },
				{ bucket: '/account', count: 9, samplePath: '/account/z' },
			])
		),
	]);

	assert.deepEqual(
		merged.body.report.unclassified.map((r) => [r.bucket, r.count]),
		[
			['/account', 9],
			['/checkout', 7],
		]
	);
	assert.equal(merged.body.perWorker, true, 'this stays a sample of one worker per node');
	assert.equal(merged.body.workers, 2);
});

// ------------------------------------------------------------------ config

test('config: a half-applied deploy shows up as a divergence, with both values', () => {
	// This is the ONLY panel where a component deploy that skipped a node is visible: the
	// skipped node keeps serving traffic and answering every other route.
	const body = (node, swrTtl) => ({
		config: { page: { swrTtl, expiry: 60 }, render: { defaultInterval: 86_400_000 } },
		warnings: [],
		pendingRestart: [],
		node,
		workerIndex: 0,
	});
	const merged = mergeConfig([ok('a', body('a', 21_600_000)), ok('b', body('b', 3_600_000))]);

	assert.equal(merged.body.divergences.length, 1);
	assert.equal(merged.body.divergences[0].path, 'page.swrTtl');
	assert.deepEqual(
		merged.body.divergences[0].values.map((v) => [v.hostname, v.value]),
		[
			['a.example.com:9926', '21600000'],
			['b.example.com:9926', '3600000'],
		]
	);
	assert.equal(merged.body.configFrom, 'a.example.com:9926', 'the dump names the node it came from');
});

test('config: identical nodes report no divergence, and warnings are tagged by node', () => {
	const body = (node) => ({
		config: { page: { swrTtl: 100 } },
		warnings: [{ key: 'render.reconcile.enabled', severity: 'warn', message: 'off' }],
		pendingRestart: [],
		node,
		workerIndex: 0,
	});
	const merged = mergeConfig([ok('a', body('a')), ok('b', body('b'))]);

	assert.deepEqual(merged.body.divergences, []);
	assert.equal(merged.body.warnings.length, 2);
	assert.deepEqual(
		merged.body.warnings.map((w) => w.hostname),
		['a.example.com:9926', 'b.example.com:9926']
	);
});

// ---- orphan sweep: node-scoped like reconcile, but MANUAL, which changes the merge ----

test('mergeOverview sums orphan sweeps and names the nodes nobody has swept', () => {
	// The shortfall that matters here is the opposite of reconcile's. There is no cadence to be
	// "disabled" on — the sweep has no timer at all — so the hole is a node that has simply never
	// been swept. It contributes zero to every total, which is indistinguishable from a node that
	// came back clean, and unlike a scheduled sweep nothing will ever fill it in on its own.
	const node = (hostname, lastRun) => ({
		ok: true,
		status: 200,
		origin: `https://${hostname}:9926`,
		hostname,
		body: {
			generatedAt: 1000,
			nodes: [],
			counts: {},
			backlog: {},
			control: {},
			orphanSweep: { maxDeletes: 5000, dryRunDefault: true, running: false, lastRun },
		},
	});

	const merged = mergeOverview([
		node('a', { examined: 100, owned: 40, orphaned: 6, deleted: 6, leaseSkipped: 0, dryRun: false, finishedAt: 500 }),
		node('b', { examined: 200, owned: 60, orphaned: 4, deleted: 0, leaseSkipped: 4, dryRun: true, finishedAt: 900 }),
		node('c', null),
	]).body.orphanSweep;

	assert.equal(merged.lastRun.examined, 300);
	assert.equal(merged.lastRun.owned, 100);
	assert.equal(merged.lastRun.orphaned, 10);
	assert.equal(merged.lastRun.deleted, 6);
	assert.equal(merged.lastRun.leaseSkipped, 4);
	assert.equal(merged.lastRun.nodes, 2, 'only the nodes that actually swept');
	assert.equal(merged.lastRun.finishedAt, 500, 'as of the OLDEST sweep, not the newest');
	// One node really deleted, so the cluster figure is not a dry run — reporting "nothing was
	// deleted" because the majority were would be exactly backwards on a destructive action.
	assert.equal(merged.lastRun.dryRun, false);
	assert.deepEqual(merged.sweptNodes, 2);
	assert.deepEqual(merged.unsweptNodes, ['c']);
});
