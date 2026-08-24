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
	REPLICATED_POST_NOTE,
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

test('a replicated POST is routed to one node and says so, and is never also node-local', () => {
	for (const [route, note] of Object.entries(REPLICATED_POST_NOTE)) {
		assert.ok(PROXIED_POST.includes(route), `REPLICATED_POST_NOTE names "${route}", which the proxy does not forward`);
		// The two maps are opposite verdicts on the same question. A route in both would be
		// refused under cluster scope by one and given a "the whole cluster has it" envelope by
		// the other, and which one won would depend on statement order.
		assert.equal(route in NODE_LOCAL_POST, false, `"${route}" cannot be both node-local and replicated`);
		assert.ok(note && note.length > 20, `"${route}" needs a reason an operator can read`);
	}
	// A config override is a row in a REPLICATED table. Fanning that write out would be N racing
	// writes to the same rows, and a partial failure would report an error for a write that in fact
	// succeeded and replicated — the report an operator acts on by writing it again.
	assert.ok('config-override' in REPLICATED_POST_NOTE);
	assert.equal('config-override' in NODE_LOCAL_POST, false, 'a cluster-scoped config edit must not be refused');
	assert.ok(PROXIED_POST.includes('config-override'));
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

// ---- the override layer: the second, benign reason nodes can disagree about config ----

const overrideRow = (path, value, over = {}) => ({
	path,
	value,
	updatedTime: 1_700_000_000_000,
	updatedBy: 'operator',
	note: null,
	...over,
});

/** Per node and per worker, and the only place a node that stopped honouring edits shows up. */
const watchState = (over = {}) => ({
	enabled: true,
	subscribed: true,
	subscribeError: null,
	syncInterval: 30_000,
	lastReadAt: 1_700_000_000_000,
	lastError: null,
	...over,
});

const overrideBlock = (over = {}) => ({
	enabled: true,
	rows: [],
	degraded: false,
	truncated: false,
	error: null,
	watch: watchState(),
	...over,
});

const configBody = (node, over = {}) => ({
	config: { page: { swrTtl: 21_600_000 }, render: { defaultInterval: 86_400_000 } },
	layers: [],
	overrides: overrideBlock(),
	warnings: [],
	pendingRestart: [],
	node,
	workerIndex: 0,
	...over,
});

test('config: an override still landing is tagged, so the deploy alarm keeps its meaning', () => {
	// The write commits on one node and reaches the rest by replication, so for a second or so the
	// cluster genuinely disagrees about that path. Unclassified, every config edit made from this
	// console raises the alarm that means "a deploy skipped a node" — and an alarm that fires on
	// its own console's normal operation stops being read.
	const a = configBody('a', {
		config: { page: { swrTtl: 3_600_000 }, render: { defaultInterval: 86_400_000 } },
		layers: [{ path: 'page.swrTtl', overridden: true, source: 'override' }],
		overrides: overrideBlock({ rows: [overrideRow('page.swrTtl', 3_600_000)] }),
	});
	const b = configBody('b', {
		// Neither the row nor the applied value has reached b yet — and its render interval is a
		// genuinely different deployed value.
		config: { page: { swrTtl: 21_600_000 }, render: { defaultInterval: 3_600_000 } },
		layers: [{ path: 'page.swrTtl', overridden: false, source: 'file' }],
	});
	const merged = mergeConfig([ok('a', a), ok('b', b)]);

	const byPath = new Map(merged.body.divergences.map((d) => [d.path, d]));
	assert.equal(byPath.size, 2);
	assert.equal(byPath.get('page.swrTtl').overridden, true, 'the console just wrote this — it is converging');
	assert.equal(
		byPath.get('render.defaultInterval').overridden,
		false,
		'nobody overrode this one: it is still a deploy that did not reach every node'
	);
	assert.deepEqual(merged.body.overrides.rows[0].missingOn, ['b.example.com:9926'], 'names who is behind');
});

test('config: a CLEAR still in flight is read from the node that still applies it', () => {
	// The row is already deleted, so the TABLE says nothing on any node. The only trace that this
	// disagreement is the override layer converging — rather than a deploy that skipped a node —
	// is that one node still carries the path in its APPLIED layer. Reading only the rows would
	// misfile every clear as a failed deploy.
	const a = configBody('a', {
		config: { page: { swrTtl: 21_600_000 } },
		layers: [{ path: 'page.swrTtl', overridden: false, source: 'file' }],
	});
	const b = configBody('b', {
		config: { page: { swrTtl: 3_600_000 } },
		layers: [{ path: 'page.swrTtl', overridden: true, source: 'override' }],
	});
	const merged = mergeConfig([ok('a', a), ok('b', b)]);

	assert.equal(merged.body.divergences.length, 1);
	assert.equal(merged.body.divergences[0].path, 'page.swrTtl');
	assert.equal(merged.body.divergences[0].overridden, true);
	assert.deepEqual(merged.body.overrides.rows, [], 'the row is gone from the table — that is the whole point');
});

test('config: the override layer unions the rows and never hides a node whose watch has died', () => {
	const a = configBody('a', { overrides: overrideBlock({ rows: [overrideRow('page.swrTtl', 3_600_000)] }) });
	const b = configBody('b', {
		overrides: overrideBlock({
			// The kill switch is off on THIS node only: it runs the deployed file while the console
			// lists rows it believes are in force.
			enabled: false,
			rows: [overrideRow('page.swrTtl', 3_600_000), overrideRow('queue.jobLeaseTime', 90_000)],
			degraded: true,
			truncated: true,
			error: 'ConfigOverride read timed out',
			watch: watchState({ subscribed: false, subscribeError: 'subscribe failed', lastError: 'read timed out' }),
		}),
	});
	const merged = mergeConfig([ok('a', a), ok('b', b)]);
	const overrides = merged.body.overrides;

	assert.deepEqual(
		overrides.rows.map((row) => row.path),
		['page.swrTtl', 'queue.jobLeaseTime']
	);
	assert.deepEqual(overrides.rows[0].missingOn, []);
	assert.deepEqual(overrides.rows[1].missingOn, ['a.example.com:9926'], 'a has not seen this row yet');

	// Every rollup takes the pessimistic reading: one node not honouring the layer is the cluster
	// not honouring it, and a cheerful aggregate would be the last thing an operator sees before
	// wondering why their edit did nothing on one node.
	assert.equal(overrides.enabled, false);
	assert.equal(overrides.degraded, true);
	assert.equal(overrides.truncated, true);
	assert.equal(overrides.error, 'ConfigOverride read timed out');

	// The watch state does not replicate. A single one here would be node a's — healthy — while b
	// silently stops honouring every edit made from this console, so it is per node or nothing.
	assert.equal('watch' in overrides, false);
	assert.deepEqual(
		overrides.nodes.map((n) => [n.hostname, n.enabled, n.degraded, n.rowCount, n.watch.subscribed]),
		[
			['a.example.com:9926', true, false, 1, true],
			['b.example.com:9926', false, true, 2, false],
		]
	);
});

test('config: a plugin with no override layer gets no override section invented for it', () => {
	// The console and the plugin are separately versioned packages, so a console can always be
	// ahead. An empty section here would read as "nobody has set any overrides", which is a claim
	// about a feature the node does not have.
	const body = (node) => ({
		config: { page: { swrTtl: 100 } },
		warnings: [],
		pendingRestart: [],
		node,
		workerIndex: 0,
	});
	const merged = mergeConfig([ok('a', body('a')), ok('b', body('b'))]);

	assert.equal('overrides' in merged.body, false);
	assert.deepEqual(merged.body.divergences, []);
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

// ---- node rows: liveness from the fan-out, replication gaps from the disagreement ----

test('mergeOverview reads liveness from who ANSWERED, not from the row timestamp', () => {
	// The row says when the status last CHANGED, and a busy node holding `queued` legitimately
	// never changes — so an age threshold over it cannot tell healthy-and-steady from dead. The
	// console just asked every node for this payload, so it knows which ones answered right now.
	const body = (nodes) => ({ generatedAt: 1000, nodes, counts: {}, backlog: {}, control: {} });
	const row = (hostname, statusChangedTime) => ({ hostname, status: 'queued', statusChangedTime });

	const merged = mergeOverview([
		{
			ok: true,
			status: 200,
			origin: 'https://a:9926',
			hostname: 'a',
			body: { ...body([row('a', 1000), row('b', 5)]), node: 'a' },
		},
		{ ok: false, status: 0, origin: 'https://b:9926', hostname: 'b', error: 'connect ECONNREFUSED' },
	]).body.nodes;

	const [a, b] = merged;
	assert.equal(a.responding, true);
	// `b`'s row is ancient AND b is genuinely down — but those are two independent facts, and only
	// the fan-out establishes the second one.
	assert.equal(b.responding, false, 'b never answered, so it is not responding');
	assert.equal(a.statusChangedTime, 1000, 'an old change time is not evidence of anything by itself');
});

test('mergeOverview surfaces a node whose row every PEER holds an older copy of', () => {
	// The field signature of a one-way replication gap: the node's own copy of its row is hours
	// newer than every peer's, because its outbound replication for that database has stopped
	// while everything else on the link keeps flowing. Taking the freshest copy — which is what
	// this merge used to do — hides exactly this.
	const body = (reporter, v3tAt) => ({
		generatedAt: 1000,
		node: reporter,
		nodes: [
			{ hostname: 'yc0', status: 'queued', statusChangedTime: 900 },
			{ hostname: 'v3t', status: 'queued', statusChangedTime: v3tAt },
		],
		counts: {},
		backlog: {},
		control: {},
	});
	const ok = (hostname, v3tAt) => ({
		ok: true,
		status: 200,
		origin: `https://${hostname}:9926`,
		hostname,
		body: body(hostname, v3tAt),
	});

	const merged = mergeOverview([ok('yc0', 100), ok('v3t', 20_000)]).body.nodes;
	const v3t = merged.find((n) => n.hostname === 'v3t');
	const yc0 = merged.find((n) => n.hostname === 'yc0');

	assert.equal(v3t.spreadMs, 19_900, "v3t's own copy is far newer than yc0's");
	assert.deepEqual(
		v3t.behind.map((x) => x.reporter),
		['yc0'],
		'and the reporter holding the stale copy is NAMED — that points at a link, not at a node'
	);
	assert.equal(v3t.responding, true, 'v3t is answering fine; this is replication, not liveness');
	assert.equal(yc0.spreadMs, 0, 'a healthy row: every copy agrees');
	assert.equal(yc0.behind.length, 0);
});

// ------------------------------------------------------------------ change probe

const probeStats = (over = {}) => ({
	examined: 10_000,
	owned: 2500,
	matched: 1000,
	probed: 1000,
	seeded: 200,
	unchanged: 700,
	changed: 100,
	triggered: 90,
	deferred: 10,
	failed: 100,
	errors: 0,
	failureSamples: [],
	...over,
});

const probeBody = (node, over = {}) => ({
	enabled: true,
	dryRun: true,
	node: `${node}.example.com:9926`,
	ownerScopeNote: 'Probes only the URLs this node owns; every node sweeps its own slice.',
	rules: [{ label: 'price', pathPattern: '^/product/', source: 'request', invalidateScope: 'route:prefix:/product/' }],
	sweep: {
		running: false,
		armedInterval: 86_400_000,
		lastRun: { ...probeStats(), dryRun: true, node, startedAt: 1000, finishedAt: 2000, error: null },
	},
	canary: { running: false, armedInterval: 1_800_000, cohortSizes: { price: 500 }, lastRun: null },
	...over,
});

test('change probe: pass counters SUM, because each node probes a disjoint slice of the keyspace', () => {
	const { body } = mergerFor('change-probe')([ok('a', probeBody('a')), ok('b', probeBody('b'))]);
	assert.equal(body.sweep.lastRun.probed, 2000);
	assert.equal(body.sweep.lastRun.changed, 200);
	assert.equal(body.sweep.lastRun.nodes, 2);
	assert.equal(body.scope, 'cluster');
});

test('change probe: the summary is stamped with the OLDEST pass, never the freshest', () => {
	const { body } = mergerFor('change-probe')([
		ok('a', probeBody('a')),
		ok(
			'b',
			probeBody('b', {
				sweep: {
					running: false,
					armedInterval: 86_400_000,
					lastRun: { ...probeStats(), dryRun: true, startedAt: 500_000, finishedAt: 900_000, error: null },
				},
			})
		),
	]);
	// b's pass is much newer. Stamping the sum with it would present a figure that is stale on
	// every other node as current.
	assert.equal(body.sweep.lastRun.finishedAt, 2000);
});

test('change probe: a node that has not swept is NAMED, not folded into the totals as a zero', () => {
	const { body } = mergerFor('change-probe')([
		ok('a', probeBody('a')),
		ok('b', probeBody('b', { sweep: { running: false, armedInterval: 86_400_000, lastRun: null } })),
	]);
	assert.deepEqual(body.sweep.unsweptNodes, ['b.example.com:9926']);
	assert.equal(body.sweep.lastRun.nodes, 1);
	assert.equal(body.sweep.lastRun.probed, 1000);
});

test('change probe: ONE node running live makes the cluster "not a dry run"', () => {
	const { body } = mergerFor('change-probe')([ok('a', probeBody('a')), ok('b', probeBody('b', { dryRun: false }))]);
	assert.equal(body.dryRun, false);
	assert.deepEqual(body.liveOn, ['b.example.com:9926']);
});

test('change probe: ONE node with the probe off is the finding, not "the cluster has it on"', () => {
	const { body } = mergerFor('change-probe')([ok('a', probeBody('a')), ok('b', probeBody('b', { enabled: false }))]);
	assert.equal(body.enabled, true);
	assert.deepEqual(body.disabledOn, ['b.example.com:9926']);
});

test('change probe: a canary TRIP names the nodes that tripped — a verdict is per cohort', () => {
	const canaryRun = (tripped, changed) => ({
		running: false,
		armedInterval: 1_800_000,
		cohortSizes: { price: 500 },
		lastRun: {
			perRule: [
				{
					rule: 'price',
					cohort: 500,
					...probeStats({ changed, unchanged: 500 - changed, probed: 500, seeded: 0, failed: 0 }),
					compared: 500,
					fraction: changed / 500,
					tripped,
					action: tripped ? { acted: true, scope: 'route:prefix:/product/' } : null,
				},
			],
			dryRun: false,
			startedAt: 1000,
			finishedAt: 2000,
			error: null,
		},
	});
	const { body } = mergerFor('change-probe')([
		ok('a', probeBody('a', { canary: canaryRun(true, 250) })),
		ok('b', probeBody('b', { canary: canaryRun(false, 10) })),
	]);
	const [rule] = body.canary.lastRun.perRule;
	assert.deepEqual(rule.trippedOn, ['a.example.com:9926']);
	// Pooled over the union of the two cohorts: 260 of 1000, not the average of 50% and 2%.
	assert.equal(rule.compared, 1000);
	assert.equal(rule.fraction, 0.26);
	assert.deepEqual(
		rule.actions.map((action) => action.hostname),
		['a.example.com:9926']
	);
});

test('change probe: rules disagreeing is flagged — the rest of the page is one node’s list', () => {
	const { body } = mergerFor('change-probe')([ok('a', probeBody('a')), ok('b', probeBody('b', { rules: [] }))]);
	assert.equal(body.rulesDiverge, true);
	assert.equal(body.rules.length, 1);
});

test('change probe: nothing answering is a 502, never an idle-looking probe', () => {
	const { status, body } = mergerFor('change-probe')([down('a'), down('b')]);
	assert.equal(status, 502);
	assert.equal(body.sources.answered, 0);
});

// ------------------------------------------------------------------ discovery purge

const purgeBody = (node, over = {}) => ({
	node: `${node}.example.com:9926`,
	running: false,
	urlPrefix: 'https://www.example.com/catalog/',
	dryRun: true,
	ratePerSecond: 200,
	startedAt: 1000,
	finishedAt: 5000,
	error: null,
	examined: 100_000,
	owned: 25_000,
	discovered: 9000,
	leaseSkipped: 12,
	deleted: 9000,
	canceled: false,
	...over,
});

test('discovery purge: the per-node rows are the answer, and the totals are only a tally', () => {
	const { body } = mergerFor('discovery-purge')([ok('a', purgeBody('a')), ok('b', purgeBody('b'))]);
	assert.equal(body.totals.discovered, 18_000);
	assert.equal(body.byNode.length, 2);
	assert.equal(body.ranNodes, 2);
	assert.equal(body.urlPrefix, 'https://www.example.com/catalog/');
});

test('discovery purge: a node that has never run is named — its targets are still rendering', () => {
	const { body } = mergerFor('discovery-purge')([ok('a', purgeBody('a')), ok('b', { node: 'b', running: false })]);
	assert.deepEqual(body.unrunNodes, ['b.example.com:9926']);
	assert.equal(body.totals.deleted, 9000);
});

test('discovery purge: ONE node that actually deleted makes "nothing was deleted" false', () => {
	const { body } = mergerFor('discovery-purge')([ok('a', purgeBody('a')), ok('b', purgeBody('b', { dryRun: false }))]);
	assert.equal(body.dryRun, false);
});

test('discovery purge: two prefixes are not silently added together', () => {
	const { body } = mergerFor('discovery-purge')([
		ok('a', purgeBody('a')),
		ok('b', purgeBody('b', { urlPrefix: 'https://www.example.com/deals/' })),
	]);
	assert.equal(body.urlPrefix, null);
	assert.equal(body.urlPrefixes.length, 2);
});

test('discovery purge: a pass still running has no finish time, on any node', () => {
	const { body } = mergerFor('discovery-purge')([
		ok('a', purgeBody('a')),
		ok('b', purgeBody('b', { running: true, finishedAt: null })),
	]);
	assert.equal(body.running, true);
	assert.deepEqual(body.runningOn, ['b.example.com:9926']);
	assert.equal(body.finishedAt, null);
});
