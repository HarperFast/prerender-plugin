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
	assert.match(render.textContent, /capacity is concurrency ÷ this/);
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
