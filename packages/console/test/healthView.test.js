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

import { installDom, find } from './domShim.js';

installDom();

const { el } = await import('../src/admin/ui.js');
const { load, render } = await import('../src/admin/views/health.js');
const { drain } = await import('../src/admin/views/queue.js');

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
		lastRun: { overdue: 300, inFlight: 40, finishedAt: Date.now() - 60_000, buckets: [], belowFloor: 0 },
	},
	intervals: { statusSyncInterval: 1000, jobLeaseTime: 120_000, defaultRenderInterval: 24 * HOUR },
	claimFloor: { enabled: true, lagMs: 30_000, occupancy: 40 },
	reconcile: {
		enabled: true,
		interval: HOUR,
		running: false,
		lastRun: { finishedAt: Date.now() - 600_000, restored: 2 },
	},
	orphanSweep: { running: false, lastRun: null },
	sources: { mode: 'merged', answered: 2, configured: 2, complete: true, nodes: [] },
};

// A healthy hour: 90% cache-served, a small miss share, renders flowing, fast claim scans.
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
		combo('queue_health', 'claim_scan_ms', null, null, 400, 12),
	],
};

function makeCtx({ overview = OVERVIEW, analytics = ANALYTICS, config = null } = {}) {
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
			// claim scan p95 at 400ms: watch.
			combo('queue_health', 'claim_scan_ms', null, null, 400, 400),
		],
	};
	const root = draw(await ready({ analytics }));
	const banner = find(root, (n) => (n.attributes?.class ?? '').startsWith('health-banner'));
	assert.equal(banner.attributes.class, 'health-banner bad');
	const items = banner.children.at(-1).children.map((li) => ({ verdict: li.attributes.class, text: li.textContent }));
	assert.ok(items.some((i) => i.verdict === 'bad' && /Render failures/.test(i.text)));
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
	const overview = {
		...OVERVIEW,
		nodes: [...OVERVIEW.nodes, { hostname: 'node-c', status: 'queued', responding: false }],
	};
	const tile = vital(draw(await ready({ overview })), 'Nodes responding');
	assert.equal(verdictOf(tile), 'bad');
	assert.match(tile.textContent, /2\/3/);
	assert.match(tile.textContent, /node-c/);
});
