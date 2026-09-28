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
import { readFileSync } from 'node:fs';

import { installDom, find } from './domShim.js';

installDom();

const { el } = await import('../src/admin/ui.js');
const { load, render, keeperVerdict, queueStateOf, behind } = await import('../src/admin/views/queue.js');
const { mergeQueueState } = await import('../src/util/aggregate.js');

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
		// The queue keeper (v0.93.0). 100 claim passes granting 4.2 jobs each = 420 jobs; 4 passes that
		// skipped 5 stale entries each = 20. Count and value differ on purpose: summing EMITS would say
		// "4 stale of 104", which looks plausible and is wrong.
		combo('queue_health', 'claim_granted', 'ready', null, 100, 4.2),
		combo('queue_health', 'claim_stale', null, null, 4, 5),
		combo('queue_health', 'keeper_publish_ms', null, null, 3000, 4, 9),
		combo('queue_health', 'keeper_verify_ms', null, null, 1, 1300),
		combo('queue_health', 'keeper_live', null, null, 4, 1),
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
	leases: {
		occupancy: 0,
		oldestLeaseExpiresAt: null,
		oldestLeaseDueMinute: null,
		maxLeases: 4096,
		oldestLeaseAgeMs: null,
	},
	reconcile: { enabled: true, interval: 1, running: false, lastRun: null },
	orphanSweep: { dryRunDefault: true, maxDeletes: 1, running: false, lastRun: null },
};

// Real plugin 0.93.0 answers, captured from harperfast/harper:5.2.13 (300k seeded rows, 2 threads,
// renders that never report so leases expire and keys wedge).
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/plugin-0.93.0-${name}.json`, import.meta.url)));
const LIVE_STATE = fixture('queue-state-live');
const LOADING_STATE = fixture('queue-state-503-loading');
const STARTING_STATE = fixture('queue-state-503-starting');

function makeCtx(
	analytics = ANALYTICS,
	{ overview = OVERVIEW, queueState = { ok: true, status: 200, body: LIVE_STATE } } = {}
) {
	const views = {};
	const scratch = (id) => (views[id] ??= {});
	return {
		scratch,
		busy: false,
		get data() {
			return scratch('queue');
		},
		async get(route) {
			if (route === 'overview') return { ok: true, body: overview };
			if (route === 'analytics') return { ok: true, body: analytics };
			if (route === 'queue-state') return queueState;
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

// ---- the queue keeper (plugin v0.93.0) ---------------------------------------
//
// The queue is each node's keeper now. What has to stay true: a node whose keeper cannot vouch for
// its numbers is SHOWN (its 503 reason), never hidden or read as an empty queue; the cluster total is
// withheld rather than floored; and the per-emit series are read as sums of VALUES.

const merged = (...answers) => ({ ok: true, status: 200, body: mergeQueueState(answers).body });
const answer = (host, body, status = 200) => ({
	origin: `https://${host}.example.com:9926`,
	hostname: `${host}.example.com:9926`,
	ok: status === 200,
	status,
	error: status === 200 ? null : body.error,
	...(status === 200 ? { body } : { errorBody: body }),
});
const keeperTable = (ctx) => find(draw(ctx), (n) => n.tagName === 'TABLE' && n.textContent.includes('publish'));
const rowOf = (table, host) => table.children[1].children.find((tr) => tr.textContent.startsWith(host));

test('due now reads the keepers live and exact when every node can vouch', async () => {
	const ctx = await ready();
	const due = tile(ctx, 'Due now');
	assert.match(due.textContent, /152,515/);
	assert.match(due.textContent, /live/);
	assert.doesNotMatch(due.textContent, /snapshot/);
});

test('a node whose keeper is loading is shown with its reason, and the cluster total is withheld', async () => {
	const ctx = makeCtx(ANALYTICS, {
		queueState: merged(answer('a', LIVE_STATE), answer('b', LOADING_STATE, 503)),
	});
	await load(ctx);
	const text = draw(ctx).textContent;
	assert.match(text, /Cluster totals withheld: b\.example\.com:9926 cannot vouch/);
	const table = keeperTable(ctx);
	const b = rowOf(table, 'b.example.com');
	assert.match(b.textContent, /loading/);
	assert.ok(
		find(b, (n) => n.attributes?.class === 'pill warn'),
		'loading while granting is a watch, not an outage'
	);
	assert.match(find(b, (n) => n.tagName === 'TD' && n.attributes?.title)?.attributes.title, /partial queue/);
	// The live node's own counts are still on its row.
	assert.match(rowOf(table, 'a.example.com').textContent, /152,515/);
	// With no cluster total, "due now" falls back to the snapshot and says so — here there is none.
	assert.match(tile(ctx, 'Due now').textContent, /no queue state or snapshot/);
});

test('a node whose keeper is starting is the alarm at the top — its "empty" status is not believed', async () => {
	// Captured: before the keeper reports anything the node-local status flag reads `empty` (its zero
	// value) while the node grants nothing. Judged by phase, it is the outage it is.
	const ctx = makeCtx(ANALYTICS, { queueState: { ok: false, status: 503, body: STARTING_STATE } });
	await load(ctx);
	const alarm = find(draw(ctx), (n) => n.attributes?.class === 'note bad' && /grants no claims/.test(n.textContent));
	assert.ok(alarm, 'expected the keeper alarm');
	assert.match(alarm.textContent, /localhost: the queue keeper is starting; this node grants no claims/);
	assert.equal(keeperVerdict(queueStateOf({ ok: false, status: 503, body: STARTING_STATE }).nodes[0]).verdict, 'bad');
});

test('the keeper verdict follows the phase: live, inexact, loading, stale, unready, failed, no answer', () => {
	const row = (over) => ({ answered: true, live: false, now: { status: 'queued' }, trust: { phase: 'live' }, ...over });
	assert.equal(keeperVerdict(row({ live: true, trust: { exact: true } })).verdict, 'ok');
	const inexact = keeperVerdict(row({ live: true, trust: { exact: false, keeper: { verify: { repaired: 3 } } } }));
	assert.equal(inexact.verdict, 'warn');
	assert.match(inexact.detail, /repaired 3/);
	assert.equal(keeperVerdict(row({ trust: { phase: 'loading' } })).verdict, 'warn');
	assert.equal(keeperVerdict(row({ error: "the queue keeper's state is 40s old" })).label, 'stale');
	const unready = keeperVerdict(row({ now: { status: 'unready' } }));
	assert.equal(unready.verdict, 'bad');
	assert.equal(unready.label, 'unready');
	const failed = keeperVerdict(
		row({ trust: { phase: 'failed', keeper: { lastError: 'boom' } }, error: 'the queue keeper is failed' })
	);
	assert.equal(failed.verdict, 'bad');
	assert.match(failed.detail, /boom/);
	assert.equal(keeperVerdict({ answered: false, error: 'unreachable' }).verdict, 'bad');
});

test('an older plugin without queue-state says what it needs, instead of an empty keeper', async () => {
	const notFound = {
		ok: false,
		status: 502,
		body: { error: 'No prerender node answered.', sources: { nodes: [{ status: 404 }, { status: 404 }] } },
	};
	const ctx = makeCtx(ANALYTICS, { queueState: notFound });
	await load(ctx);
	assert.match(draw(ctx).textContent, /Queue state needs plugin v0\.93\.0/);
});

test('stale skips and grants are SUMS OF VALUES, not counts of emits', async () => {
	const ctx = await ready();
	// 20 stale of 440 looked at. Counting emits would say 4 of 104.
	const stale = tile(ctx, 'Stale skips');
	assert.match(stale.textContent, /5%/);
	assert.match(stale.textContent, /20 entries/);
	assert.match(tile(ctx, 'Publish').textContent, /9ms/);
	assert.match(tile(ctx, 'Repaired').textContent, /^Repaired0/);
});

test('a keeper repair is bad, and wedged keys past 5% of grants are too', async () => {
	const ctx = makeCtx({
		...ANALYTICS,
		series: [
			...ANALYTICS.series,
			combo('queue_health', 'keeper_repaired', null, null, 1, 7),
			combo('queue_health', 'claim_wedged', null, null, 5, 10),
		],
	});
	await load(ctx);
	assert.ok(find(tile(ctx, 'Repaired'), (n) => n.attributes?.class === 'value bad'));
	const wedged = tile(ctx, 'Wedged');
	assert.match(wedged.textContent, /50/);
	assert.match(wedged.textContent, /12% of grants/);
	assert.ok(find(wedged, (n) => n.attributes?.class === 'value bad'));
});

test('in flight is the exact lease walk, and slot pressure is the fullest node’s', async () => {
	// queue-state's own `inFlight` is the O(1) gauge (410 in the capture) and counts expired leases
	// until the next reconcile; the overview walks the slots (290).
	const ctx = makeCtx(ANALYTICS, {
		overview: {
			...OVERVIEW,
			leases: { occupancy: 3_900, maxLeases: 4096, fullestShare: 3_900 / 4096, fullestNode: 'b' },
		},
	});
	await load(ctx);
	const inFlight = tile(ctx, 'In flight');
	assert.match(inFlight.textContent, /3,900/);
	assert.match(inFlight.textContent, /95% of slots/);
	assert.ok(find(inFlight, (n) => n.attributes?.class === 'value bad'));
	assert.match(rowOf(keeperTable(ctx), 'localhost').textContent, /3,900/);
});

test('behind counts due rows at least one cadence late, from the lateness bins', () => {
	// Captured: sitemap [47608, 49513, 3342, 3277, 10] + discovered [23443, 23987, 669, 666, 0].
	const late = behind(LIVE_STATE.lateness);
	assert.equal(late.late, 3342 + 3277 + 10 + 669 + 666);
	assert.equal(late.all, LIVE_STATE.now.due);
	assert.equal(behind({ edges: [0.5, 2] }), null, 'no 1-cadence edge, no answer');
});

test('the real 0.93.0 payloads render: keeper live, due exact, wedged keys called out', async () => {
	const ctx = makeCtx(fixture('analytics'), { overview: fixture('overview') });
	await load(ctx);
	const root = draw(ctx);
	assert.match(tile(ctx, 'Due now').textContent, /152,515/);
	assert.match(tile(ctx, 'In flight').textContent, /290/, 'the exact walk, not the 410 gauge');
	// 19 claim passes held 10 keys each; 68 passes granted 10.66 each.
	const wedged = tile(ctx, 'Wedged');
	assert.match(wedged.textContent, /190/);
	assert.ok(
		find(wedged, (n) => n.attributes?.class === 'value bad'),
		'every render failing to report is bad'
	);
	assert.match(tile(ctx, 'Stale skips').textContent, /36 entries/);
	assert.match(tile(ctx, 'Loads').textContent, /^Loads2/);
	const row = rowOf(keeperTable(ctx), 'localhost');
	assert.match(row.textContent, /live/);
	assert.match(row.textContent, /152,515/);
	assert.match(root.textContent, /How late the due rows are/);
	assert.match(root.textContent, /route:prefix:\/catalog\//);
	assert.match(root.textContent, /Queue flow, last hour/);
	assert.match(root.textContent, /live · queue keeper/);
});

test('a unready node reads as a warning of its own, apart from empty', async () => {
	const ctx = makeCtx(ANALYTICS, {
		overview: {
			...OVERVIEW,
			nodes: [
				{ hostname: 'node-a', status: 'unready', statusChangedTime: Date.now(), override: null },
				{ hostname: 'node-b', status: 'empty', statusChangedTime: Date.now(), override: null },
			],
		},
	});
	await load(ctx);
	const table = find(draw(ctx), (n) => n.tagName === 'TABLE' && n.textContent.includes('renders/h'));
	const rowFor = (name) => table.children[1].children.find((tr) => tr.textContent.startsWith(name));
	assert.ok(find(rowFor('node-a'), (n) => n.attributes?.class === 'pill warn' && n.textContent === 'unready'));
	assert.ok(find(rowFor('node-b'), (n) => n.attributes?.class === 'pill' && n.textContent === 'empty'));
});

test('nothing on the page names the machinery v0.93.0 removed', async () => {
	const text = draw(await ready()).textContent;
	assert.doesNotMatch(text, /claim floor|Claim scan|Prioriti[sz]ed|ready sweep|Deep recompute/i);
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
		leases: { ...OVERVIEW.leases, occupancy: 40 },
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
