/**
 * The Queue view's capacity reading.
 *
 * Two things have to stay true here and neither is obvious from the code:
 *
 *   - Capacity is the MEAN. A queue's throughput follows the average service time, so
 *     renders/hour is concurrency ÷ mean render time. The tile charted p95 for a long time,
 *     directly under a note saying it was the capacity figure, which understated the fleet by
 *     whatever the tail was worth.
 *   - Since browser v1.18.0 that mean covers TWO MODES. `navigation.skipSettleWhenNonIndexable`
 *     returns a page that already disowns itself without settling (~1.7s against ~10.9s), so the
 *     pooled mean now falls as the bail rate rises — a real throughput gain, but not a faster
 *     settle. Read alone it looks like the renderer got quicker, so the tile also carries the mean
 *     of the renders that actually produced a stored page.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installDom, find } from './domShim.js';

installDom();

const { el } = await import('../src/admin/ui.js');
const { load, render } = await import('../src/admin/views/queue.js');

const BUCKETS = 4;

function combo(metric, path, method, type, count, value, p95 = value) {
	return {
		metric,
		path,
		method,
		type,
		count,
		total: 0,
		counts: new Array(BUCKETS).fill(count / BUCKETS),
		mean: value,
		median: value,
		p95,
		means: new Array(BUCKETS).fill(value),
		p95s: new Array(BUCKETS).fill(p95),
	};
}

// 300 full renders at 11s and 200 settle-skipping bails at 1.7s: pooled mean 7.28s, but the work
// that produced a cached page still averages 11s.
const ANALYTICS = {
	available: true,
	scope: 'node',
	node: 'node-a',
	rangeMs: 3_600_000,
	startMs: 0,
	endMs: 3_600_000,
	bucketMs: 900_000,
	bucketCount: BUCKETS,
	coveredFromMs: 0,
	coveredToMs: 3_600_000,
	truncated: false,
	scan: { ms: 4, scanned: 10, kept: 10, cap: 20_000 },
	intervals: { statusSyncInterval: 1000, jobLeaseTime: 120_000, defaultRenderInterval: 21_600_000 },
	series: [
		combo('render', 'time_ms', '200', 'candidate', 300, 11_000, 16_000),
		combo('render', 'time_ms', '200', 'non-candidate', 200, 1_700, 2_400),
		combo('render', 'outcome', 'rendered', 'stored', 300),
		combo('render', 'outcome', 'suppressed', 'noindex', 200),
		combo('queue_health', 'claim_scan_ms', 'granted', null, 500, 3, 7),
		// v0.50.0's ready set: 420 of 500 grants prioritised, sweeps complete, cadence mostly carried.
		// 100 claim passes granting 4.2 jobs each = 420 prioritised jobs, and 20 passes granting 4 =
		// 80 from the index. Count and value differ on purpose: summing emits would say "100 of 120".
		combo('queue_health', 'claim_granted', 'ready', null, 100, 4.2),
		combo('queue_health', 'claim_granted', 'index', null, 20, 4),
		combo('queue_health', 'ready_sweep_ms', 'complete', null, 12, 340, 500),
		combo('queue_health', 'ready_published', null, null, 12, 4800),
		combo('queue_health', 'ready_cadence', 'carried', null, 12, 4500),
		combo('queue_health', 'ready_cadence', 'resolved', null, 12, 300),
	],
};

const OVERVIEW = {
	generatedAt: Date.now(),
	node: 'node-a',
	workerIndex: 0,
	localQueueStatus: 'active',
	control: { cluster: null, knownScopes: [] },
	nodes: [],
	counts: null,
	countsAsOf: null,
	backlog: { enabled: true, interval: 60_000, running: false, lastRun: null },
	intervals: { statusSyncInterval: 1000, jobLeaseTime: 120_000, defaultRenderInterval: 21_600_000 },
	claimFloor: { floorMinute: 0, lagMs: null, oldestLeaseAgeMs: null },
	reconcile: { enabled: true, interval: 1, running: false, lastRun: null },
	orphanSweep: { dryRunDefault: true, maxDeletes: 1, running: false, lastRun: null },
};

function makeCtx(analytics = ANALYTICS) {
	const views = {};
	const scratch = (id) => (views[id] ??= {});
	return {
		scratch,
		busy: false,
		get data() {
			return scratch('queue');
		},
		async get(route) {
			if (route === 'overview') return { ok: true, body: OVERVIEW };
			if (route === 'analytics') return { ok: true, body: analytics };
			return { ok: true, body: null };
		},
		async post() {
			return { ok: true };
		},
		render() {},
		reload() {},
		go() {},
	};
}

const draw = (ctx) => el('div', null, render(ctx));
const tile = (ctx, label) =>
	find(draw(ctx), (n) => n.attributes?.class === 'stat' && n.children[0]?.textContent === label);

const ready = async () => {
	const ctx = makeCtx();
	await load(ctx);
	return ctx;
};

test('the capacity tile is the MEAN, not the tail', async () => {
	const ctx = await ready();
	const render = tile(ctx, 'Render time');
	assert.ok(render, 'expected a Render time tile');
	// (300×11,000 + 200×1,700) / 500 = 7,280ms. The p95 over the same population is 10.6s.
	assert.match(render.textContent, /7\.3s/);
	// The capacity rule rides the tooltip now, beside the number it governs.
	assert.match(render.attributes.title, /Capacity is concurrency ÷ this mean/);
});

test('the tail is still reported — it just is not the capacity number', async () => {
	const ctx = await ready();
	assert.match(tile(ctx, 'Render time').textContent, /p95 11s/);
});

test('a settle-skipping bail does not read as the renderer getting faster', async () => {
	const ctx = await ready();
	// The renders that actually produced a stored page still average 11s; only the pooled figure
	// moved, because 40% of the fleet's work is now cheap bails.
	assert.match(tile(ctx, 'Render time').textContent, /stored 11s/);
});

test('with no bails there is nothing to separate, and the tile does not invent a split', async () => {
	const ctx = makeCtx({
		...ANALYTICS,
		series: ANALYTICS.series.filter((s) => s.type !== 'non-candidate'),
	});
	await load(ctx);
	const render = tile(ctx, 'Render time');
	assert.match(render.textContent, /11s/);
	assert.doesNotMatch(render.textContent, /stored/, 'every render was stored — saying so twice is noise');
});

// ---- render prioritisation (plugin v0.50.0) ---------------------------------
//
// The ready set reorders a fixed amount of work and moves NO total, so every other number on this
// page reads the same whether prioritisation is working or switched off entirely. These are the
// assertions that make the difference visible.

test('the prioritised share counts JOBS, not the claim passes that granted them', async () => {
	const ctx = await ready();
	const grants = tile(ctx, 'Prioritised');
	assert.ok(grants, 'expected a Prioritised tile');
	// 420 of 500 jobs. Counting emits instead would report 100 of 120 — 83%, close enough to the
	// right answer to look correct and wrong for a reason nobody would go looking for.
	assert.match(grants.textContent, /84%/);
	assert.match(grants.textContent, /420 of 500/);
});

test('every grant coming from the fallback index is called out as the failure it is', async () => {
	const ctx = makeCtx({
		...ANALYTICS,
		series: ANALYTICS.series.filter((s) => !(s.path === 'claim_granted' && s.method === 'ready')),
	});
	await load(ctx);
	const text = draw(ctx).textContent;
	assert.match(text, /nothing is being prioritised/);
	assert.match(text, /restart-scoped/, 'capacity cannot be changed live — say so where it matters');
	assert.ok(
		find(draw(ctx), (n) => n.attributes?.class === 'value warn'),
		'and it should read as a warning'
	);
});

test('a capped sweep says which end of the backlog went unordered', async () => {
	const ctx = makeCtx({
		...ANALYTICS,
		series: ANALYTICS.series.map((s) => (s.method === 'complete' ? { ...s, method: 'capped' } : s)),
	});
	await load(ctx);
	assert.match(draw(ctx).textContent, /skips the recently-due rows it exists to protect/);
});

test('ready supply is per sweep, not summed across them', async () => {
	const ctx = await ready();
	// 12 sweeps publishing 4,800 entries each. Summing would report 57.6k entries that never existed.
	assert.match(tile(ctx, 'Ready supply').textContent, /4\.8k/);
});

test('cadence carried is a migration gauge and reads as one', async () => {
	const ctx = await ready();
	assert.match(tile(ctx, 'Cadence carried').textContent, /94%/); // 4500 of 4800
	assert.match(draw(ctx).textContent, /Cadence carried" is a migration gauge/);
});

test('an older plugin that emits none of this renders no panel at all', async () => {
	const ctx = makeCtx({
		...ANALYTICS,
		series: ANALYTICS.series.filter((s) => !String(s.path).startsWith('ready_') && s.path !== 'claim_granted'),
	});
	await load(ctx);
	assert.doesNotMatch(draw(ctx).textContent, /Render prioritisation/);
});

/**
 * `prerender_ops.legacy_renderer` — a fleet pod older than browser 1.23.0 posting a single-device
 * result for a URL job. It shipped with plugin v0.66.0 and no console view read it, which the
 * metric-coverage guard in adminAssets.test.js caught; these pin the reading rather than its
 * mere presence.
 *
 * The silence is the point. An old pod's result is well-formed, so the outcome chart stays clean,
 * render time stays normal, and the devices it never rendered just go unwritten — the first
 * visible symptom is a serve-side one, days later, on a different view.
 */

test('a healthy fleet draws no legacy-renderer panel at all — zero is the steady state', async () => {
	const ctx = await ready();
	assert.doesNotMatch(draw(ctx).textContent, /older than browser 1\.23\.0/);
});

test('a legacy renderer is called out with its count and the device it did render', async () => {
	const ctx = makeCtx({
		...ANALYTICS,
		series: [
			...ANALYTICS.series,
			combo('prerender_ops', 'legacy_renderer', 'mobile', null, 37),
			combo('prerender_ops', 'legacy_renderer', 'desktop', null, 5),
		],
	});
	await load(ctx);
	const text = draw(ctx).textContent;

	assert.match(text, /older than browser 1\.23\.0/);
	assert.match(text, /42 results/, 'counts sum across the device slot');
	assert.match(text, /desktop, mobile/, 'names what DID render, so a pod is recognisable');
	// The consequence is the part an operator cannot get from any other panel.
	assert.match(text, /never being written/);
});

test('one legacy result is singular, and still shown — a single old pod is the whole finding', async () => {
	const ctx = makeCtx({
		...ANALYTICS,
		series: [...ANALYTICS.series, combo('prerender_ops', 'legacy_renderer', 'mobile', null, 1)],
	});
	await load(ctx);
	assert.match(draw(ctx).textContent, /1 result came from/);
});

// ---- backlog and nodes (moved here from the overview and the Nodes view) -----------

const withBacklog = (overview) => {
	const ctx = makeCtx();
	ctx.get = async (route) =>
		route === 'overview'
			? { ok: true, body: overview }
			: route === 'analytics'
				? { ok: true, body: ANALYTICS }
				: { ok: true, body: null };
	return ctx;
};

test('due now says how long the backlog takes to clear at the observed render rate', async () => {
	// 500 results in the hour; 1,040 due with 40 in flight is 1,000 waiting — two hours of work.
	const ctx = withBacklog({
		...OVERVIEW,
		backlog: { ...OVERVIEW.backlog, lastRun: { overdue: 1040, inFlight: 40, finishedAt: Date.now(), buckets: [] } },
		claimFloor: { ...OVERVIEW.claimFloor, occupancy: 40 },
	});
	await load(ctx);
	const due = tile(ctx, 'Due now');
	assert.match(due.textContent, /~2h to clear/);
	assert.ok(
		find(due, (n) => n.attributes?.class === 'value'),
		'two hours exactly is not yet past the watch line'
	);
});

test('the node table carries each node’s status, throughput and pause controls', async () => {
	const ctx = withBacklog({
		...OVERVIEW,
		nodes: [
			{ hostname: 'node-a', status: 'queued', statusChangedTime: Date.now() - 3_600_000, override: null },
			{ hostname: 'node-b', status: 'paused', statusChangedTime: Date.now(), override: { paused: true } },
		],
	});
	await load(ctx);
	const root = draw(ctx);
	const table = find(root, (n) => n.tagName === 'TABLE' && n.textContent.includes('renders/h'));
	assert.ok(table, 'expected the node table on Queue');
	assert.match(table.textContent, /node-a/);
	assert.match(table.textContent, /paused here/, 'a per-node override is shown as intent, apart from status');
	// Under node scope only this node's row has a rate; the other is a blank, never a zero.
	assert.match(table.textContent, /node-a.*500/s);
});
