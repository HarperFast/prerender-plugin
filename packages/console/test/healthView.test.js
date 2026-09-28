/**
 * The Health view, executed against realistic payloads.
 *
 * What it promises, and what these pin:
 *
 *   - Every tile is a CHECK with a verdict, and every check that is not ok is repeated in the
 *     banner — a healthy cluster reads as one green line, an unhealthy one lists what to look at.
 *   - The backlog is judged by how long it takes to CLEAR at the observed render rate, not by its
 *     size: a few hundred rows on a fleet doing thousands an hour is fine, and any backlog with no
 *     renders at all is not.
 *   - System vitals are per node and the tile names the WORST node; on a plugin without them the
 *     section says so once, never as a row of zeroes.
 *   - Net offload keeps the gross figure beside it, from the same arithmetic as Traffic.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { installDom, find } from './domShim.js';

installDom();

const { el } = await import('../src/admin/ui.js');
const { load, render } = await import('../src/admin/views/health.js');
const { drain } = await import('../src/admin/views/queue.js');
const { mergeQueueState } = await import('../src/util/aggregate.js');

// Real plugin 0.93.0 answers (harperfast/harper:5.2.13, 300k seeded rows, renders that never report).
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/plugin-0.93.0-${name}.json`, import.meta.url)));
const LIVE_STATE = fixture('queue-state-live');
const LOADING_STATE = fixture('queue-state-503-loading');
const STARTING_STATE = fixture('queue-state-503-starting');

const HOUR = 3_600_000;
const BUCKETS = 4;

const combo = (metric, path, method, type, count, value) => ({
	metric,
	path,
	method,
	type,
	count,
	total: 0,
	counts: new Array(BUCKETS).fill(count / BUCKETS),
	...(value === undefined
		? {}
		: {
				mean: value,
				median: value,
				p95: value,
				means: new Array(BUCKETS).fill(value),
				medians: new Array(BUCKETS).fill(value),
				p95s: new Array(BUCKETS).fill(value),
			}),
});

const OVERVIEW = {
	generatedAt: Date.now(),
	node: 'node-a',
	control: { cluster: { paused: false, updatedBy: 'ops' }, knownScopes: [] },
	nodes: [
		{ hostname: 'node-a', status: 'queued', statusChangedTime: Date.now() - HOUR, responding: true },
		{ hostname: 'node-b', status: 'queued', statusChangedTime: Date.now() - HOUR, responding: true },
	],
	backlog: {
		enabled: true,
		interval: 60_000,
		running: false,
		lastRun: { overdue: 300, inFlight: 40, finishedAt: Date.now() - 60_000, buckets: [], source: 'keeper' },
	},
	intervals: { statusSyncInterval: 1000, jobLeaseTime: 120_000, defaultRenderInterval: 24 * HOUR },
	leases: {
		occupancy: 40,
		oldestLeaseExpiresAt: null,
		oldestLeaseDueMinute: null,
		maxLeases: 4096,
		oldestLeaseAgeMs: 60_000,
	},
	reconcile: {
		enabled: true,
		interval: HOUR,
		running: false,
		lastRun: { finishedAt: Date.now() - 600_000, restored: 2 },
	},
	orphanSweep: { running: false, lastRun: null },
	sources: { mode: 'merged', answered: 2, configured: 2, complete: true, nodes: [] },
};

// A healthy hour: 90% cache-served, a small miss share, renders flowing, a keeper publishing in ms.
const ANALYTICS = {
	available: true,
	scope: 'node',
	node: 'node-a',
	rangeMs: HOUR,
	startMs: 0,
	endMs: HOUR,
	bucketMs: HOUR / BUCKETS,
	bucketCount: BUCKETS,
	intervals: { defaultRenderInterval: 24 * HOUR },
	series: [
		combo('bot_serve', 'cache', 'hit', 'googlebot', 9000),
		combo('bot_serve', 'origin', 'miss', 'googlebot', 1000),
		combo('bot_request', 'www.example.com', 'googlebot', 'desktop', 10_000),
		combo('page_age', 'googlebot', null, null, 9000, 10 * HOUR),
		combo('response_200', null, null, null, 10_000),
		combo('duration', 'p', null, 'cache-hit', 9000, 2),
		combo('origin_fetch', '200', 'miss', null, 1000, 400),
		combo('render', 'outcome', 'rendered', null, 2000),
		combo('render', 'time_ms', null, 'candidate', 2000, 9000),
		combo('queue_health', 'claim_granted', 'ready', null, 400, 5),
		combo('queue_health', 'claim_stale', null, null, 2, 3),
		combo('queue_health', 'keeper_publish_ms', null, null, 3000, 4),
		combo('queue_health', 'keeper_verify_ms', null, null, 1, 1300),
		combo('queue_health', 'keeper_live', null, null, 4, 1),
	],
};

// The real live answer, shrunk to a healthy queue: 300 due, nothing a cadence late.
const HEALTHY_STATE = {
	...LIVE_STATE,
	now: { ...LIVE_STATE.now, due: 300, dueSitemap: 200, dueDiscovered: 100, inFlight: 40, unclaimed: 260 },
	lateness: {
		...LIVE_STATE.lateness,
		sitemap: [150, 50, 0, 0, 0],
		discovered: [80, 20, 0, 0, 0],
		classes: [],
		byRoute: [],
	},
};
const stateOf = (...answers) => ({ ok: true, status: 200, body: mergeQueueState(answers).body });
const answer = (host, body, status = 200) => ({
	origin: `https://${host}:9926`,
	hostname: `${host}:9926`,
	ok: status === 200,
	status,
	error: status === 200 ? null : body.error,
	...(status === 200 ? { body } : { errorBody: body }),
});
const HEALTHY_QUEUE = stateOf(answer('node-a', HEALTHY_STATE), answer('node-b', HEALTHY_STATE));

function makeCtx({ overview = OVERVIEW, analytics = ANALYTICS, config = null, queueState = HEALTHY_QUEUE } = {}) {
	const views = {};
	const scratch = (id) => (views[id] ??= {});
	return {
		scratch,
		busy: false,
		rangeMs: HOUR,
		get data() {
			return scratch('health');
		},
		async get(route) {
			if (route === 'overview') return { ok: true, body: overview };
			if (route === 'analytics') return { ok: true, body: analytics };
			if (route === 'config') return config ? { ok: true, body: config } : { ok: false, status: 404, body: {} };
			if (route === 'invalidations') return { ok: true, body: { invalidations: [] } };
			if (route === 'queue-state') return queueState;
			return { ok: true, body: null };
		},
		async post() {
			return { ok: true, body: {} };
		},
		render() {},
		go() {},
	};
}

const ready = async (options) => {
	const ctx = makeCtx(options);
	await load(ctx);
	return ctx;
};
const draw = (ctx) => el('div', null, render(ctx));
const vital = (root, label) =>
	find(root, (n) => /(^| )vital( |$)/.test(n.attributes?.class ?? '') && n.textContent.includes(label));
const verdictOf = (node) => node?.attributes?.class?.split(' ')[1];

test('a healthy cluster reads as one green line', async () => {
	const root = draw(await ready());
	const banner = find(root, (n) => (n.attributes?.class ?? '').startsWith('health-banner'));
	assert.equal(banner.attributes.class, 'health-banner ok');
	assert.match(banner.textContent, /All clear/);
});

test('anything not ok is listed in the banner, bad before watch', async () => {
	const analytics = {
		...ANALYTICS,
		series: [
			...ANALYTICS.series,
			// 30% render failures: bad (past 25%).
			combo('render', 'outcome', 'failed', null, 900),
			// keeper publish p95 at 100ms: watch (past 50ms).
			combo('queue_health', 'keeper_publish_ms', null, null, 3000, 100),
		],
	};
	const root = draw(await ready({ analytics }));
	const banner = find(root, (n) => (n.attributes?.class ?? '').startsWith('health-banner'));
	assert.equal(banner.attributes.class, 'health-banner bad');
	const items = banner.children.at(-1).children.map((li) => ({ verdict: li.attributes.class, text: li.textContent }));
	assert.ok(items.some((i) => i.verdict === 'bad' && /Render failures/.test(i.text)));
	assert.ok(items.some((i) => i.verdict === 'warn' && /Keeper publish p95/.test(i.text)));
	assert.equal(items[0].verdict, 'bad', 'bad checks come first');
});

test('net offload keeps the gross figure beside it and warns below half', async () => {
	// 900 of 1,000 serves from cache (90% gross); 500 renders and a 100-probe pass mean the origin
	// answered 700 of 1,000 crawler requests — 30% net. Same arithmetic as Traffic (originLoad).
	const analytics = {
		...ANALYTICS,
		series: [
			combo('bot_serve', 'cache', 'hit', 'googlebot', 900),
			combo('bot_serve', 'origin', 'miss', 'googlebot', 100),
			combo('bot_request', 'www.example.com', 'googlebot', 'desktop', 1000),
			combo('render', 'outcome', 'rendered', null, 500),
			combo('prerender_ops', 'probe_probed', null, null, 1, 100),
		],
	};
	const tile = vital(draw(await ready({ analytics })), 'Net offload');
	assert.match(tile.textContent, /30%/);
	assert.match(tile.textContent, /gross 90%/);
	assert.equal(verdictOf(tile), 'warn');
});

test('the backlog is judged by drain time, not by size', () => {
	// 300 due, 40 in flight, 2,000 renders/h: the 260 waiting clear in ~8 minutes.
	const quick = drain(300, 40, 2000);
	assert.equal(quick.verdict, 'ok');
	assert.ok(Math.abs(quick.ms - (260 / 2000) * HOUR) < 1);
	// Everything due is already in flight.
	assert.deepEqual(drain(40, 40, 2000), { ms: 0, verdict: 'ok' });
	// Three hours of work: watch. Ten: bad.
	assert.equal(drain(6040, 40, 2000).verdict, 'warn');
	assert.equal(drain(20_040, 40, 2000).verdict, 'bad');
	// Rows waiting and nothing rendering is bad whatever the size.
	assert.equal(drain(100, 0, 0).verdict, 'bad');
	assert.equal(drain(null, 0, 100).verdict, 'na');
	// No analytics means no rate, which is unknown — not "nothing rendered".
	assert.equal(drain(100, 0, null).verdict, 'na');
});

test('a backlog tile names the time to clear, and goes bad when nothing renders', async () => {
	const healthy = vital(draw(await ready()), 'Backlog');
	assert.equal(verdictOf(healthy), 'ok');
	assert.match(healthy.textContent, /to clear/);

	const stalled = {
		...ANALYTICS,
		series: ANALYTICS.series.filter((s) => !(s.metric === 'render' && s.path === 'outcome')),
	};
	assert.equal(verdictOf(vital(draw(await ready({ analytics: stalled })), 'Backlog')), 'bad');
});

test('on a plugin without system vitals the section says so once, instead of zeroes', async () => {
	const root = draw(await ready());
	assert.match(root.textContent, /System vitals need plugin v0\.92\.0/);
	assert.equal(vital(root, 'CPU'), null);
});

test('system tiles name the worst node, and the node table joins host and series by hostname', async () => {
	const series = (value) => new Array(BUCKETS).fill(value);
	const system = (hostname, cpu, elu) => ({
		nodes: [
			{
				nodeId: 1,
				hostname,
				cpu: series(cpu),
				rss: series(8 * 2 ** 30),
				elu: series(elu),
				taskQueueLatency: series(5),
				majorFaults: series(0),
				latest: {
					at: HOUR - 20_000,
					cpu,
					rss: 8 * 2 ** 30,
					elu,
					taskQueueLatency: 5,
					diskAvailable: 400 * 2 ** 30,
					diskSize: 1000 * 2 ** 30,
				},
			},
		],
	});
	const analytics = {
		...ANALYTICS,
		byNode: [
			// Configured-origin host carries a port and a different case: the join must still land.
			{ node: 'node-a', hostname: 'NODE-A:9926', totals: [], buckets: [], system: system('node-a', 4, 0.3) },
			{ node: 'node-b', hostname: 'node-b:9926', totals: [], buckets: [], system: system('node-b', 15.6, 0.4) },
		],
	};
	const host = (hostname, pluginVersion) => ({
		hostname,
		cpus: 16,
		totalMemory: 64 * 2 ** 30,
		availableMemory: 20 * 2 ** 30,
		uptimeSec: 86_400,
		pluginVersion,
	});
	const overview = {
		...OVERVIEW,
		hosts: [
			{ node: 'node-a', hostname: 'node-a:9926', host: host('node-a', '0.92.0') },
			{ node: 'node-b', hostname: 'node-b:9926', host: host('node-b', '0.92.0') },
		],
	};
	const root = draw(await ready({ overview, analytics }));

	const cpu = vital(root, 'CPU');
	assert.match(cpu.textContent, /98%/, '15.6 of 16 cores');
	assert.match(cpu.textContent, /worst: node-b/);
	assert.equal(verdictOf(cpu), 'bad');

	const table = find(root, (n) => n.tagName === 'TABLE');
	const rowFor = (name) => table.children[1].children.find((tr) => tr.textContent.startsWith(name));
	assert.match(rowFor('node-a').textContent, /25%/, 'node-a CPU joined across case and port');
	assert.match(rowFor('node-b').textContent, /0\.92\.0/);
});

test('nodes on different plugin versions are a bad check — a deploy skipped a node', async () => {
	const overview = {
		...OVERVIEW,
		hosts: [
			{ node: 'node-a', host: { hostname: 'node-a', pluginVersion: '0.92.0' } },
			{ node: 'node-b', host: { hostname: 'node-b', pluginVersion: '0.91.0' } },
		],
	};
	const tile = vital(draw(await ready({ overview })), 'Plugin version');
	assert.equal(verdictOf(tile), 'bad');
	assert.match(tile.textContent, /2 versions/);
});

test('a node that did not answer turns the responding check bad and names it', async () => {
	// Liveness comes from the fan-out's own record — not from joining QueueStatus rows by hostname,
	// which misses a node whose configured origin is an IP or alias.
	const overview = {
		...OVERVIEW,
		sources: {
			mode: 'merged',
			answered: 2,
			configured: 3,
			complete: false,
			nodes: [
				{ hostname: 'node-a:9926', ok: true },
				{ hostname: 'node-b:9926', ok: true },
				{ hostname: '192.0.2.7:9926', ok: false },
			],
		},
	};
	const tile = vital(draw(await ready({ overview })), 'Nodes responding');
	assert.equal(verdictOf(tile), 'bad');
	assert.match(tile.textContent, /2\/3/);
	assert.match(tile.textContent, /192\.0\.2\.7/);
});

// ---- the review's findings: a false "All clear" is worse than a false alarm ----------------------

test('a failed analytics read is a bad check, never a quiet gap under an "All clear"', async () => {
	const ctx = makeCtx();
	const base = ctx.get;
	ctx.get = async (route, params) =>
		route === 'analytics' ? { ok: false, status: 502, body: { error: 'Bad gateway' } } : base(route, params);
	await load(ctx);
	const root = draw(ctx);
	const banner = find(root, (n) => (n.attributes?.class ?? '').startsWith('health-banner'));
	assert.equal(banner.attributes.class, 'health-banner bad');
	assert.match(banner.textContent, /Analytics/);
	assert.match(root.textContent, /Bad gateway — serving and rendering checks are missing/);
	// And with no render rate the backlog is UNKNOWN — not "nothing rendered".
	const backlog = vital(root, 'Backlog');
	assert.equal(verdictOf(backlog), 'na');
	assert.doesNotMatch(backlog.attributes.title ?? '', /nothing rendered/);
});

test('with nothing judged the banner says so, rather than "All clear"', async () => {
	const ctx = makeCtx();
	ctx.get = async () => ({ ok: false, status: 0, body: { error: 'Request failed' } });
	await load(ctx);
	const banner = find(draw(ctx), (n) => (n.attributes?.class ?? '').startsWith('health-banner'));
	assert.doesNotMatch(banner.textContent, /All clear/);
});

test('config agreement is re-read on every load, not answered from the first one', async () => {
	let reads = 0;
	const ctx = makeCtx({ config: { configFrom: 'node-a', divergences: [], sources: { answered: 2 } } });
	const base = ctx.get;
	ctx.get = async (route, params) => {
		if (route === 'config') reads++;
		return base(route, params);
	};
	await load(ctx);
	await load(ctx);
	assert.equal(reads, 2, 'a deploy that skips a node after the console opened must show up on Refresh');
});

test('a node on a plugin without a version counts as skew — the half-rolled deploy', async () => {
	const overview = {
		...OVERVIEW,
		hosts: [
			{ node: 'node-a', host: { hostname: 'node-a', pluginVersion: '0.92.0' } },
			{ node: 'node-b', host: null },
		],
	};
	const tile = vital(draw(await ready({ overview })), 'Plugin version');
	assert.equal(verdictOf(tile), 'bad');
	assert.match(tile.textContent, /< 0\.92\.0/);
});

test('stale vitals are left out of the tiles and named, never shown as current', async () => {
	const series = (value) => new Array(BUCKETS).fill(value);
	const node = (hostname, cpu, at) => ({
		nodeId: 1,
		hostname,
		cpu: series(cpu),
		elu: series(0.3),
		majorFaults: series(0),
		taskQueueLatency: series(5),
		latest: { at, cpu, elu: 0.3, taskQueueLatency: 5, diskAvailable: 1, diskSize: 2 },
	});
	const analytics = {
		...ANALYTICS,
		byNode: [
			// node-a wrote a resource row 20s before the window ended; node-b's newest is 40 minutes old.
			{ node: 'node-a', totals: [], buckets: [], system: { nodes: [node('node-a', 4, HOUR - 20_000)] } },
			{ node: 'node-b', totals: [], buckets: [], system: { nodes: [node('node-b', 15.9, HOUR - 40 * 60_000)] } },
		],
	};
	const overview = {
		...OVERVIEW,
		hosts: ['node-a', 'node-b'].map((hostname) => ({
			node: hostname,
			host: { hostname, cpus: 16, totalMemory: 1, availableMemory: 0.5, pluginVersion: '0.92.0' },
		})),
	};
	const root = draw(await ready({ overview, analytics }));
	const cpu = vital(root, 'CPU');
	assert.match(cpu.textContent, /25%/, 'the stale node’s 99% is not the current worst');
	const coverage = vital(root, 'Vitals coverage');
	assert.equal(verdictOf(coverage), 'warn');
	assert.match(coverage.textContent, /stale: node-b/);
});

test('a truncated backlog never softens a bad drain', async () => {
	// From the snapshot (no queue state answered)…
	const overview = {
		...OVERVIEW,
		backlog: { ...OVERVIEW.backlog, lastRun: { ...OVERVIEW.backlog.lastRun, overdue: 50_000, truncated: true } },
	};
	const noState = { ok: false, status: 0, body: { error: 'Request failed' } };
	assert.equal(verdictOf(vital(draw(await ready({ overview, queueState: noState })), 'Backlog')), 'bad');
	// …and from keepers that are live but not exact.
	const inexact = {
		...HEALTHY_STATE,
		now: { ...HEALTHY_STATE.now, due: 25_000 },
		trust: { ...HEALTHY_STATE.trust, exact: false },
	};
	const queueState = stateOf(answer('node-a', inexact), answer('node-b', inexact));
	const tile = vital(draw(await ready({ queueState })), 'Backlog');
	assert.equal(verdictOf(tile), 'bad');
	assert.match(tile.textContent, /50,000\+/, 'a lower bound is marked as one');
});

test('table counts that disagree across nodes are a bad check — the replication gap', async () => {
	const overview = {
		...OVERVIEW,
		counts: {
			targets: { recordCount: 1000, divergent: true, spread: { low: 900, high: 1000 } },
			pages: { recordCount: 5 },
		},
	};
	const tile = vital(draw(await ready({ overview })), 'Table counts');
	assert.equal(verdictOf(tile), 'bad');
	assert.match(tile.textContent, /targets 900–1,000/);
});

// ---- the queue keeper (plugin v0.93.0) ----------------------------------------------------------

test('the backlog is the keepers’ live total when every node can vouch, and the snapshot otherwise', async () => {
	const live = vital(draw(await ready()), 'Backlog');
	assert.match(live.textContent, /600/, 'two healthy nodes of 300 each');
	assert.doesNotMatch(live.textContent, /snapshot/);

	// One node loading: the cluster total is withheld, so the backlog falls back to the snapshot and says so.
	const queueState = stateOf(answer('node-a', HEALTHY_STATE), answer('node-b', LOADING_STATE, 503));
	const fallback = vital(draw(await ready({ queueState })), 'Backlog');
	assert.match(fallback.textContent, /300/);
	assert.match(fallback.textContent, /snapshot/);
});

test('a node whose keeper is starting makes the Queue keeper check bad, and the banner names it', async () => {
	const queueState = stateOf(answer('node-a', HEALTHY_STATE), answer('node-b', STARTING_STATE, 503));
	const root = draw(await ready({ queueState }));
	const keeper = vital(root, 'Queue keeper');
	assert.equal(verdictOf(keeper), 'bad');
	assert.match(keeper.textContent, /1\/2 live/);
	assert.match(keeper.textContent, /node-b:9926: starting/);
	const banner = find(root, (n) => (n.attributes?.class ?? '').startsWith('health-banner'));
	assert.match(banner.textContent, /this node grants no claims/);
});

test('a loading node is a watch — it grants from a partial queue — never "All clear"', async () => {
	const queueState = stateOf(answer('node-a', HEALTHY_STATE), answer('node-b', LOADING_STATE, 503));
	const root = draw(await ready({ queueState }));
	assert.equal(verdictOf(vital(root, 'Queue keeper')), 'warn');
	const banner = find(root, (n) => (n.attributes?.class ?? '').startsWith('health-banner'));
	assert.doesNotMatch(banner.textContent, /All clear/);
});

test('mid-rollout, a node without a keeper (plugin 0.92) is a watch on the keeper check', async () => {
	const old = {
		...answer('node-b', { error: 'Unknown route: queue-state' }, 404),
		error: 'Unknown route: queue-state',
	};
	const keeper = vital(
		draw(await ready({ queueState: stateOf(answer('node-a', HEALTHY_STATE), old) })),
		'Queue keeper'
	);
	assert.equal(verdictOf(keeper), 'warn');
	assert.match(keeper.textContent, /node-b:9926: no keeper/);
});

test('a failed queue-state read is a bad input check, never a quiet gap under "All clear"', async () => {
	const root = draw(await ready({ queueState: { ok: false, status: 502, body: { error: 'Bad gateway' } } }));
	const banner = find(root, (n) => (n.attributes?.class ?? '').startsWith('health-banner'));
	assert.equal(banner.attributes.class, 'health-banner bad');
	const item = banner.children.at(-1).children.find((li) => /Queue state/.test(li.textContent));
	assert.ok(item, 'the missing input is listed');
	assert.equal(item.attributes.class, 'bad');
	assert.match(item.textContent, /Bad gateway/);
	// And the keeper checks it would have fed are absent, not green.
	assert.equal(vital(root, 'Queue keeper'), null);
});

test('with no queue state, a node the replicated status calls unready is still flagged', async () => {
	const overview = {
		...OVERVIEW,
		nodes: [...OVERVIEW.nodes.slice(0, 1), { hostname: 'node-b', status: 'unready', responding: true }],
	};
	const root = draw(await ready({ overview, queueState: { ok: false, status: 0, body: { error: 'Request failed' } } }));
	const keeper = vital(root, 'Queue keeper');
	assert.equal(verdictOf(keeper), 'bad');
	assert.match(keeper.textContent, /1 unready/);
});

test('a keeper repair is bad — its subscription is missing writes', async () => {
	const analytics = {
		...ANALYTICS,
		series: [...ANALYTICS.series, combo('queue_health', 'keeper_repaired', null, null, 1, 4)],
	};
	const tile = vital(draw(await ready({ analytics })), 'Keeper repairs');
	assert.equal(verdictOf(tile), 'bad');
	assert.match(tile.textContent, /^.*Keeper repairs.*4/);
});

test('zero repairs with no verification anywhere is unknown, not ok', async () => {
	const analytics = { ...ANALYTICS, series: ANALYTICS.series.filter((s) => s.path !== 'keeper_verify_ms') };
	const noWalk = {
		...HEALTHY_STATE,
		trust: { ...HEALTHY_STATE.trust, keeper: { ...HEALTHY_STATE.trust.keeper, verify: null } },
	};
	const queueState = stateOf(answer('node-a', noWalk), answer('node-b', noWalk));
	assert.equal(verdictOf(vital(draw(await ready({ analytics, queueState })), 'Keeper repairs')), 'na');
});

test('render holds: a few is a watch, past 5% of grants is bad', async () => {
	const few = { ...ANALYTICS, series: [...ANALYTICS.series, combo('queue_health', 'claim_wedged', null, null, 1, 3)] };
	assert.equal(verdictOf(vital(draw(await ready({ analytics: few })), 'Render holds')), 'warn');
	const many = {
		...ANALYTICS,
		series: [...ANALYTICS.series, combo('queue_health', 'claim_wedged', null, null, 20, 10)],
	};
	assert.equal(verdictOf(vital(draw(await ready({ analytics: many })), 'Render holds')), 'bad');
});

test('a nearly full lease table is bad on the fullest node, however empty the others are', async () => {
	const overview = {
		...OVERVIEW,
		leases: { occupancy: 4000, maxLeases: 8192, fullestShare: 3990 / 4096, fullestNode: 'node-b' },
	};
	const tile = vital(draw(await ready({ overview })), 'Lease slots');
	assert.equal(verdictOf(tile), 'bad');
	assert.match(tile.textContent, /fullest: node-b/);
});

test('the real 0.93.0 payloads: keeper live, but renders that never report are bad twice over', async () => {
	// The capture posted no results at all, so every lease expired: the keeper is healthy, keys wedge
	// (190 held of 725 granted), and 152k due rows with no render rate is a backlog that will not clear.
	const queueState = { ok: true, status: 200, body: LIVE_STATE };
	const root = draw(await ready({ overview: fixture('overview'), analytics: fixture('analytics'), queueState }));
	assert.equal(verdictOf(vital(root, 'Queue keeper')), 'ok');
	assert.equal(verdictOf(vital(root, 'Render holds')), 'bad');
	assert.equal(verdictOf(vital(root, 'Backlog')), 'bad');
	assert.equal(verdictOf(vital(root, 'Keeper repairs')), 'ok');
	assert.equal(verdictOf(vital(root, 'Keeper publish p95')), 'ok');
	assert.equal(verdictOf(vital(root, 'Lease slots')), 'ok');
	assert.doesNotMatch(root.textContent, /claim floor|Claim scan|Prioriti[sz]ed/i);
});

// ---- review findings: one routine event is one watch, never three alarms with the wrong cause ----

/** A live node whose keeper just resynced for `why`, its walk having counted `repaired` rows. */
const resynced = (why, repaired, { walkRepaired = repaired } = {}) => {
	const at = Date.now() - 60_000;
	return {
		...HEALTHY_STATE,
		trust: {
			...HEALTHY_STATE.trust,
			exact: false,
			keeper: {
				...HEALTHY_STATE.trust.keeper,
				exact: false,
				verify: { ...HEALTHY_STATE.trust.keeper.verify, at: at - 1_300, repaired: walkRepaired, missing: walkRepaired },
				lastResync: { at, why, ms: 1_400, kept: 1000, dropped: 0, repaired },
			},
		},
	};
};
const MEMBERSHIP_WHY = "the cluster's node list changed (node-a -> node-a,node-b)";

test('rows gained in a membership change are ONE watch, named as such — not missed writes', async () => {
	// The verification walk counts a newly owned row as "missing", emits keeper_repaired and turns
	// `exact` false. Before: Keeper repairs BAD ("missing writes"), Queue keeper "inexact", Backlog 600+.
	const analytics = {
		...ANALYTICS,
		series: [...ANALYTICS.series, combo('queue_health', 'keeper_repaired', null, null, 1, 12)],
	};
	const queueState = stateOf(answer('node-a', resynced(MEMBERSHIP_WHY, 12)), answer('node-b', HEALTHY_STATE));
	const root = draw(await ready({ analytics, queueState }));
	const repairs = vital(root, 'Keeper repairs');
	assert.equal(verdictOf(repairs), 'warn');
	assert.match(repairs.textContent, /12 rows gained after a membership change/);
	assert.doesNotMatch(repairs.attributes.title ?? '', /missing writes/);
	assert.equal(verdictOf(vital(root, 'Queue keeper')), 'ok');
	const backlog = vital(root, 'Backlog');
	assert.equal(verdictOf(backlog), 'ok');
	assert.doesNotMatch(backlog.textContent, /\+/, 'the counts are complete: the gained rows are held');
});

test('a repair NOT explained by a membership change is still bad, and still a lower bound', async () => {
	const analytics = {
		...ANALYTICS,
		series: [...ANALYTICS.series, combo('queue_health', 'keeper_repaired', null, null, 1, 12)],
	};
	for (const state of [
		resynced('an event could not be applied', 12),
		// A membership resync, but the node's last walk is a later one that repaired rows of its own.
		resynced(MEMBERSHIP_WHY, 12, { walkRepaired: 3 }),
	]) {
		const queueState = stateOf(answer('node-a', state), answer('node-b', HEALTHY_STATE));
		const root = draw(await ready({ analytics, queueState }));
		assert.equal(verdictOf(vital(root, 'Keeper repairs')), 'bad');
		assert.equal(verdictOf(vital(root, 'Queue keeper')), 'warn');
		assert.match(vital(root, 'Backlog').textContent, /600\+/);
	}
});

test('Health and Queue read repairs from ONE helper: a last walk outside the range still counts', async () => {
	// A 15-minute range holds no hourly walk, but a node's last walk repaired 5 rows. Health once took
	// max(range, last walk) while the Queue tile took the range alone and read 0.
	const state = {
		...HEALTHY_STATE,
		trust: {
			...HEALTHY_STATE.trust,
			exact: false,
			keeper: {
				...HEALTHY_STATE.trust.keeper,
				exact: false,
				verify: { ...HEALTHY_STATE.trust.keeper.verify, repaired: 5 },
			},
		},
	};
	const analytics = { ...ANALYTICS, series: ANALYTICS.series.filter((s) => s.path !== 'keeper_verify_ms') };
	const queueState = stateOf(answer('node-a', state), answer('node-b', HEALTHY_STATE));
	const health = vital(draw(await ready({ analytics, queueState })), 'Keeper repairs');
	assert.equal(verdictOf(health), 'bad');
	assert.match(health.textContent, /5/);
	assert.match(health.textContent, /last walk on 2\/2 nodes/);

	const { load: loadQueue, render: renderQueue } = await import('../src/admin/views/queue.js');
	const ctx = makeCtx({ analytics, queueState });
	await loadQueue(ctx);
	const repaired = find(
		el('div', null, renderQueue(ctx)),
		(n) => n.attributes?.class === 'stat' && n.children[0]?.textContent === 'Repaired'
	);
	assert.match(repaired.textContent, /^Repaired5/);
	assert.ok(find(repaired, (n) => n.attributes?.class === 'value bad'));
});

test('one node walked of two is said, not passed off as the whole cluster checked', async () => {
	const unwalked = {
		...HEALTHY_STATE,
		trust: { ...HEALTHY_STATE.trust, keeper: { ...HEALTHY_STATE.trust.keeper, verify: null } },
	};
	const analytics = { ...ANALYTICS, series: ANALYTICS.series.filter((s) => s.path !== 'keeper_verify_ms') };
	const queueState = stateOf(answer('node-a', HEALTHY_STATE), answer('node-b', unwalked));
	const repairs = vital(draw(await ready({ analytics, queueState })), 'Keeper repairs');
	assert.equal(verdictOf(repairs), 'ok');
	assert.match(repairs.textContent, /last walk on 1\/2 nodes/);
});

test('a routine restart is not a watch for the whole range: one not-live snapshot per load is the restart', async () => {
	// 4 snapshots, one of them during the restart's load (mean 0.75), and one keeper load in the range.
	const withGauge = (loads) => ({
		...ANALYTICS,
		series: [
			...ANALYTICS.series.filter((s) => s.path !== 'keeper_live'),
			combo('queue_health', 'keeper_live', null, null, 4, 0.75),
			...(loads ? [combo('queue_health', 'keeper_load_ms', null, null, loads, 900)] : []),
		],
	});
	const restart = vital(draw(await ready({ analytics: withGauge(1) })), 'Queue keeper');
	assert.equal(verdictOf(restart), 'ok');
	assert.match(restart.textContent, /restarted 1× in range/);
	// The same not-live snapshot with no load to explain it is a keeper that went down while running.
	assert.equal(verdictOf(vital(draw(await ready({ analytics: withGauge(0) })), 'Queue keeper')), 'warn');
});

test('in flight is never silently short: a lease sum missing a node yields to the keepers’ complete sum', async () => {
	const overview = {
		...OVERVIEW,
		leases: { occupancy: 40, maxLeases: 8192, fullestShare: 0.01, fullestNode: 'node-a', missing: ['node-b:9926'] },
	};
	// Keepers complete (80 in flight across both): theirs wins, unmarked.
	const complete = vital(draw(await ready({ overview })), 'Backlog');
	assert.match(complete.textContent, /80 in flight/);
	assert.doesNotMatch(complete.textContent, /\+ in flight/);
	// No keeper total: the short sum is shown, and marked as a floor.
	const noState = { ok: false, status: 0, body: { error: 'Request failed' } };
	assert.match(vital(draw(await ready({ overview, queueState: noState })), 'Backlog').textContent, /40\+ in flight/);
});

test('at node scope a keeper that is not live is ONE bad check: the snapshot’s missing count is n/a', async () => {
	const overview = {
		...OVERVIEW,
		sources: undefined,
		backlog: {
			...OVERVIEW.backlog,
			lastRun: {
				overdue: null,
				inFlight: 0,
				buckets: [],
				source: 'keeper',
				queueUnavailable: 'the queue keeper is not live',
				finishedAt: Date.now(),
				error: null,
			},
		},
	};
	const root = draw(await ready({ overview, queueState: { ok: false, status: 503, body: STARTING_STATE } }));
	// By exact label: the Backlog tile's own text now points at "Queue keeper".
	const byLabel = (label) =>
		find(
			root,
			(n) => /(^| )vital( |$)/.test(n.attributes?.class ?? '') && n.children[0]?.children[1]?.textContent === label
		);
	assert.equal(verdictOf(byLabel('Queue keeper')), 'bad');
	const backlog = byLabel('Backlog');
	assert.equal(verdictOf(backlog), 'na');
	assert.match(backlog.textContent, /see Queue keeper/);
});

test('drilled to a node on plugin 0.92, Health reads "no keeper" — a watch, not a failed input', async () => {
	const root = draw(
		await ready({ queueState: { ok: false, status: 404, body: { error: 'Unknown route: queue-state' } } })
	);
	assert.equal(vital(root, 'Queue state'), null, 'not the bad input check');
	const keeper = vital(root, 'Queue keeper');
	assert.equal(verdictOf(keeper), 'warn');
	assert.match(keeper.textContent, /this node: no keeper/);
});

// Plugin v0.94.0: pages the change probe expired, waiting on their render — served from the origin until
// then. Judged like the backlog, by the time the render rate takes to reach them; absent before v0.94.0.
test('changed pages waiting: a Queue check judged by time to re-render, and absent on an older plugin', async () => {
	const changed = (n) => ({ ...HEALTHY_STATE, now: { ...HEALTHY_STATE.now, dueChanged: n } });
	const at = async (a, b) =>
		vital(
			draw(await ready({ queueState: stateOf(answer('node-a', changed(a)), answer('node-b', changed(b))) })),
			'Changed pages waiting'
		);
	// 2,000 renders in the hour.
	const quiet = await at(100, 200);
	assert.equal(verdictOf(quiet), 'ok');
	assert.match(quiet.textContent, /300/);
	assert.match(quiet.textContent, /~9m to re-render/);
	assert.equal(verdictOf(await at(3000, 2000)), 'warn', '5,000 is 2.5h of renders');
	assert.equal(verdictOf(await at(12_000, 8000)), 'bad', '20,000 is 10h');
	// The real 0.93.0 answer carries no count: no check at all, never a green 0.
	assert.equal(vital(draw(await ready()), 'Changed pages waiting'), null);
	// Mixed versions: shown, but with no total and no verdict.
	const mixed = vital(
		draw(await ready({ queueState: stateOf(answer('node-a', changed(40)), answer('node-b', HEALTHY_STATE)) })),
		'Changed pages waiting'
	);
	assert.match(mixed.textContent, /not reported by node-b:9926/);
	assert.equal(verdictOf(mixed), 'na');
	// The same verdict as the Queue view: the oldest changed page's actual wait is judged too.
	const aged = (n, agoMs) => ({ ...changed(n), now: { ...changed(n).now, oldestChangedAt: Date.now() - agoMs } });
	const old = vital(
		draw(
			await ready({ queueState: stateOf(answer('node-a', aged(100, 3 * HOUR)), answer('node-b', aged(200, HOUR))) })
		),
		'Changed pages waiting'
	);
	assert.equal(verdictOf(old), 'warn', '300 rows is 9m of renders, but one has waited 3h');
	assert.match(old.textContent, /oldest 3h · ~9m to re-render/);
});
