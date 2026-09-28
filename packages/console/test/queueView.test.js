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
const { load, render, keeperVerdict, queueStateOf, behind, backlogReading, drainOf } = await import(
	'../src/admin/views/queue.js'
);
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

test('mid-rollout, a node still on 0.92 is a watch, not an outage — it claims from its own index', async () => {
	// The plugin PR supports a mixed cluster (one node first). That node answers queue-state 404.
	const old = {
		...answer('b', { error: 'Unknown route: queue-state' }, 404),
		error: 'Unknown route: queue-state',
	};
	const ctx = makeCtx(ANALYTICS, { queueState: merged(answer('a', LIVE_STATE), old) });
	await load(ctx);
	const root = draw(ctx);
	const b = rowOf(keeperTable(ctx), 'b.example.com');
	assert.ok(find(b, (n) => n.attributes?.class === 'pill warn' && n.textContent === 'no keeper'));
	assert.equal(
		find(root, (n) => n.attributes?.class === 'note bad' && /grants no claims/.test(n.textContent)),
		null,
		'no outage alarm for a node that is still claiming'
	);
	assert.match(root.textContent, /Cluster totals withheld: b\.example\.com:9926/);
});

test('with no queue state at all, the card says what each node answered', async () => {
	const failed = {
		ok: false,
		status: 502,
		body: {
			error: 'No prerender node answered.',
			sources: {
				nodes: [
					{ hostname: 'a.example.com:9926', ok: false, status: 404, error: 'Management API is disabled' },
					{ hostname: 'b.example.com:9926', ok: false, status: 0, error: 'unreachable: timeout' },
				],
			},
		},
	};
	const ctx = makeCtx(ANALYTICS, { queueState: failed });
	await load(ctx);
	const text = draw(ctx).textContent;
	assert.match(text, /No prerender node answered\. a\.example\.com:9926 \(Management API is disabled\)/);
	assert.match(text, /b\.example\.com:9926 \(unreachable: timeout\)/);
});

test('drilled to a node on plugin 0.92, it is "no keeper" — the same watch as under cluster scope', async () => {
	const ctx = makeCtx(ANALYTICS, {
		queueState: { ok: false, status: 404, body: { error: 'Unknown route: queue-state' } },
	});
	await load(ctx);
	const row = rowOf(keeperTable(ctx), 'this node');
	assert.ok(find(row, (n) => n.attributes?.class === 'pill warn' && n.textContent === 'no keeper'));
	assert.equal(
		keeperVerdict(queueStateOf({ ok: false, status: 404, body: { error: 'Unknown route' } }).nodes[0]).verdict,
		'warn'
	);
	// "Management API is disabled" is a 404 too, and is not a node without a keeper.
	assert.equal(queueStateOf({ ok: false, status: 404, body: { error: 'Management API is disabled' } }), null);
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
	// HOLDS, not keys: a key still failing when its hold ends is held and counted again.
	const holds = tile(ctx, 'Holds');
	assert.match(holds.textContent, /50/);
	assert.match(holds.textContent, /12% of grants/);
	assert.ok(find(holds, (n) => n.attributes?.class === 'value bad'));
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
	const holds = tile(ctx, 'Holds');
	assert.match(holds.textContent, /190/);
	assert.ok(
		find(holds, (n) => n.attributes?.class === 'value bad'),
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

// ---- review findings ------------------------------------------------------------

/** The live answer with a lateness breakdown and due count of its own. */
const liveWith = (over) => ({ ...LIVE_STATE, ...over });
const nodeState = (body) => ({ ok: true, status: 200, body });

test('rows gained in a membership change read as gained (watch), and the counts are not marked short', async () => {
	const at = Date.now() - 60_000;
	const keeper = {
		...LIVE_STATE.trust.keeper,
		exact: false,
		verify: { ...LIVE_STATE.trust.keeper.verify, at: at - 1_300, repaired: 12, missing: 12 },
		lastResync: { at, why: "the cluster's node list changed (a -> a,b)", ms: 1_400, repaired: 12 },
	};
	const state = liveWith({ trust: { ...LIVE_STATE.trust, exact: false, keeper } });
	const analytics = {
		...ANALYTICS,
		series: [...ANALYTICS.series, combo('queue_health', 'keeper_repaired', null, null, 1, 12)],
	};
	const ctx = makeCtx(analytics, { queueState: nodeState(state) });
	await load(ctx);
	const row = rowOf(keeperTable(ctx), 'localhost');
	assert.ok(find(row, (n) => n.attributes?.class === 'pill warn' && n.textContent === '12 gained'));
	assert.ok(find(row, (n) => n.attributes?.class === 'pill ok' && n.textContent === 'live'));
	assert.match(row.textContent, /152,515(?!\+)/, 'complete counts carry no "+"');
	const repaired = tile(ctx, 'Repaired');
	assert.match(repaired.textContent, /12 rows gained after a membership change/);
	assert.ok(find(repaired, (n) => n.attributes?.class === 'value warn'));
	assert.doesNotMatch(tile(ctx, 'Due now').textContent, /\+/);
});

test('Behind is not judged on a handful of rows: 4 late of 12 due on a quiet cluster is not bad', async () => {
	const quiet = liveWith({
		now: { ...LIVE_STATE.now, due: 12, dueSitemap: 12, dueDiscovered: 0, unclaimed: 12 },
		lateness: { ...LIVE_STATE.lateness, sitemap: [6, 2, 4, 0, 0], discovered: [0, 0, 0, 0, 0] },
	});
	const ctx = makeCtx(ANALYTICS, { queueState: nodeState(quiet) });
	await load(ctx);
	const behindTile = tile(ctx, 'Behind');
	assert.match(behindTile.textContent, /33%/);
	assert.ok(
		find(behindTile, (n) => n.attributes?.class === 'value'),
		'under the minimum late-row count: no verdict'
	);
	// Past the minimum the same share is bad.
	const busy = liveWith({
		lateness: { ...LIVE_STATE.lateness, sitemap: [600, 200, 400, 0, 0], discovered: [0, 0, 0, 0, 0] },
	});
	const ctx2 = makeCtx(ANALYTICS, { queueState: nodeState(busy) });
	await load(ctx2);
	assert.ok(find(tile(ctx2, 'Behind'), (n) => n.attributes?.class === 'value bad'));
});

test('a lease sum missing a node is marked short and names it when there is no keeper total', async () => {
	const overview = {
		...OVERVIEW,
		leases: {
			occupancy: 290,
			maxLeases: 4096,
			fullestShare: 290 / 4096,
			fullestNode: 'a.example.com:9926',
			missing: ['b.example.com:9926'],
			byNode: [{ hostname: 'a.example.com:9926', occupancy: 290, maxLeases: 4096 }],
		},
	};
	const ctx = makeCtx(ANALYTICS, {
		overview,
		queueState: merged(answer('a', LIVE_STATE), answer('b', LOADING_STATE, 503)),
	});
	await load(ctx);
	const inFlight = tile(ctx, 'In flight');
	assert.match(inFlight.textContent, /290\+/);
	assert.match(inFlight.attributes.title, /No lease count from b\.example\.com:9926/);
	assert.ok(find(inFlight, (n) => n.attributes?.class === 'value warn'));
});

test('an overview that fails still shows the keepers — the page names the overview, not "queue state"', async () => {
	const ctx = makeCtx();
	const base = ctx.get;
	ctx.get = async (route, params) =>
		route === 'overview' ? { ok: false, status: 502, body: { error: 'Bad gateway' } } : base(route, params);
	await load(ctx);
	const root = draw(ctx);
	assert.ok(find(root, (n) => n.attributes?.class === 'note bad' && n.textContent === 'Bad gateway'));
	assert.ok(keeperTable(ctx), 'the keeper card is still drawn');
	assert.match(tile(ctx, 'Due now').textContent, /152,515/);
	const fallback = makeCtx();
	fallback.get = async (route, params) =>
		route === 'overview' ? { ok: false, status: 502, body: {} } : base(route, params);
	await load(fallback);
	assert.match(draw(fallback).textContent, /Could not load the cluster overview \(502\)/);
});

test('rows waiting are summed PER NODE: one node’s spare leases never cancel another’s backlog', () => {
	// a: 10 due, 30 leased (leases can outlive a row's ownership); b: 100 due, none leased.
	// Σdue − Σleases = 80; per node it is 0 + 100 = 100.
	const qs = mergeQueueState([
		answer('a', liveWith({ now: { ...LIVE_STATE.now, due: 10, inFlight: 30, unclaimed: 0 } })),
		answer('b', liveWith({ now: { ...LIVE_STATE.now, due: 100, inFlight: 0, unclaimed: 100 } })),
	]).body;
	const overview = {
		leases: {
			occupancy: 30,
			maxLeases: 8192,
			missing: [],
			byNode: [
				{ hostname: 'a.example.com:9926', occupancy: 30, maxLeases: 4096 },
				{ hostname: 'b.example.com:9926', occupancy: 0, maxLeases: 4096 },
			],
		},
	};
	const reading = backlogReading(overview, qs);
	assert.equal(reading.overdue, 110);
	assert.equal(reading.waiting, 100);
	assert.equal(drainOf(reading, 100).ms, 3_600_000, '100 waiting at 100 renders/h is an hour');
});

test('queue flow: In, Out and Net are per-minute means of the due-set transitions, gaps kept as gaps', async () => {
	const minute = 60_000;
	const t0 = Math.floor(Date.now() / minute) * minute - 3 * minute;
	const flow = [
		{ minute: t0, cameDue: 10, triggered: 2, rescheduled: 5, added: 1, removed: 0 },
		{ minute: t0 + minute, cameDue: 20, triggered: 0, rescheduled: 5, added: 0, removed: 7 },
		{ minute: t0 + 3 * minute, cameDue: 30, triggered: 1, rescheduled: 5, added: 0, removed: 0 },
	];
	const ctx = makeCtx(ANALYTICS, { queueState: nodeState(liveWith({ flow })) });
	await load(ctx);
	// In = (12 + 20 + 31) / 3 = 21; Out = rescheduled only (removed rows may not have been due) = 5.
	assert.match(tile(ctx, 'In').textContent, /21\/min/);
	assert.match(tile(ctx, 'Out').textContent, /5\/min/);
	const net = tile(ctx, 'Net');
	assert.match(net.textContent, /\+16\/min/);
	assert.match(net.textContent, /growing/);
});

test('lateness bins carry their values: sitemap and discovered per bin, from the real payload', async () => {
	const ctx = await ready();
	const text = draw(ctx).textContent;
	// sitemap [47608, 49513, 3342, 3277, 10], discovered [23443, 23987, 669, 666, 0]
	assert.match(text, /0–0\.25× · 48k sitemap \/ 23k discovered/);
	assert.match(text, /1–2× · 3\.3k sitemap \/ 669 discovered/);
	assert.match(text, /≥ 4× · 10 sitemap \/ 0 discovered/);
	assert.doesNotMatch(text, /class lists capped/, '0.93.0 sends no listsTruncated; absence is not cut');
});

test('plugin 0.93.1’s listsTruncated is shown when present', async () => {
	const cut = liveWith({ lateness: { ...LIVE_STATE.lateness, listsTruncated: true } });
	const ctx = makeCtx(ANALYTICS, { queueState: nodeState(cut) });
	await load(ctx);
	assert.match(draw(ctx).textContent, /class lists capped at 200 per node/);
});

// ---- plugin v0.94.0: changed pages waiting -------------------------------------------------------
//
// A page the change probe found changed is hard-expired and its render filed ahead of rotation, so
// until it re-renders bots are served the origin. queue-state reports those due rows as
// `now.dueChanged`; an older plugin does not report it at all, and that must read as absent, never 0.

/**
 * The 0.93.0 capture as plugin 0.94.0 answers it: the changed count, the class flag and — unless
 * `oldestAgoMs` is `undefined`, the first 0.94.0 build's shape — the oldest changed row's due minute.
 */
const withChangedState = (dueChanged, oldestAgoMs = undefined) => ({
	...LIVE_STATE,
	now: {
		...LIVE_STATE.now,
		dueChanged,
		...(oldestAgoMs === undefined ? {} : { oldestChangedAt: oldestAgoMs === null ? null : Date.now() - oldestAgoMs }),
	},
	lateness: {
		...LIVE_STATE.lateness,
		classes: [
			{ ...LIVE_STATE.lateness.classes[0], changed: true, due: dueChanged, oldestLatenessCadences: 9 },
			...LIVE_STATE.lateness.classes.map((klass) => ({ ...klass, changed: false })),
		],
	},
});

const changedTile = async (n, oldestAgoMs) => {
	const ctx = makeCtx(ANALYTICS, { queueState: nodeState(withChangedState(n, oldestAgoMs)) });
	await load(ctx);
	return tile(ctx, 'Changed, waiting');
};
const verdictClass = (node) =>
	find(node, (n) => String(n.attributes?.class ?? '').startsWith('value'))?.attributes.class;

test('changed pages waiting: a tile beside due, judged by count ÷ render rate when no oldest wait is reported', async () => {
	// The first 0.94.0 build sent no oldestChangedAt. 500 renders in the hour: 400 changed rows are ~48m of
	// work (ok), 1,500 are 3h (watch), 5,000 are 10h (bad).
	const ok = await changedTile(400);
	assert.match(ok.textContent, /400/);
	assert.match(ok.textContent, /~48m to re-render$/);
	assert.equal(verdictClass(ok), 'value');
	assert.match(ok.attributes.title, /queue\.ready\.changedHeadStart/);
	assert.equal(verdictClass(await changedTile(1500)), 'value warn');
	assert.equal(verdictClass(await changedTile(5000)), 'value bad');
	assert.match((await changedTile(0)).textContent, /none waiting/);
});

test('changed pages waiting: the ACTUAL wait of the oldest changed page is judged too — the worse of the two wins', async () => {
	const MIN = 60_000;
	const HOUR = 60 * MIN;
	// 400 rows re-render in ~48m, and the oldest has waited 10m: ok on both counts, and both are named.
	const fresh = await changedTile(400, 10 * MIN);
	assert.equal(verdictClass(fresh), 'value');
	assert.match(fresh.textContent, /oldest 10m · ~48m to re-render/);
	// Few rows, but one has been served from the origin for 3h — the count alone would have read ok.
	assert.equal(verdictClass(await changedTile(400, 3 * HOUR)), 'value warn');
	assert.equal(verdictClass(await changedTile(400, 9 * HOUR)), 'value bad');
	// A fresh wave the fleet will take 3h to reach is a watch even though nothing has waited long yet.
	assert.equal(verdictClass(await changedTile(1500, 5 * MIN)), 'value warn');
	// Nothing due: null is an answer, and it is fine.
	assert.equal(verdictClass(await changedTile(0, null)), 'value');
});

test('changed pages waiting: each node’s own count in the keeper table, and the changed class marked', async () => {
	const ctx = makeCtx(ANALYTICS, { queueState: nodeState(withChangedState(1234)) });
	await load(ctx);
	const table = keeperTable(ctx);
	assert.ok(table.children[0].textContent.includes('changed'), 'a changed column');
	assert.match(rowOf(table, 'localhost').textContent, /152,5151,234/, 'due, then changed');
	const lateness = find(draw(ctx), (n) => n.tagName === 'TABLE' && n.textContent.includes('cadence'));
	assert.ok(find(lateness, (n) => n.attributes?.class === 'pill info' && n.textContent === 'changed'));
	assert.match(lateness.textContent, /changed/);
	assert.match(draw(ctx).textContent, /started queue\.ready\.changedHeadStart cadences ahead/, 'the help says why');
	const aged = makeCtx(ANALYTICS, { queueState: nodeState(withChangedState(1234, 2 * 3_600_000)) });
	await load(aged);
	const cell = find(rowOf(keeperTable(aged), 'localhost'), (n) =>
		/oldest has been due 2h/.test(n.attributes?.title ?? '')
	);
	assert.ok(cell, 'the node’s own oldest wait rides on its cell');
});

test('changed pages waiting: an older plugin reports none — no tile, no column, never a 0', async () => {
	const ctx = await ready(); // the real 0.93.0 answer
	assert.equal(tile(ctx, 'Changed, waiting'), null);
	const table = keeperTable(ctx);
	assert.equal(table.children[0].children[0].children.length, 10, 'the 0.93 columns only');
	assert.doesNotMatch(table.children[0].textContent, /changed/);
});

test('changed pages waiting: a mixed-version cluster withholds the sum and names the node that cannot say', async () => {
	const ctx = makeCtx(ANALYTICS, {
		queueState: merged(answer('a', withChangedState(700)), answer('b', LIVE_STATE)),
	});
	await load(ctx);
	const changed = tile(ctx, 'Changed, waiting');
	assert.match(changed.textContent, /^Changed, waiting—not reported by b\.example\.com:9926$/);
	const b = rowOf(keeperTable(ctx), 'b.example.com');
	assert.ok(find(b, (n) => n.tagName === 'TD' && /predates v0\.94\.0/.test(n.attributes?.title ?? '')));
	assert.match(rowOf(keeperTable(ctx), 'a.example.com').textContent, /700/);
});

// ---- plugin v0.95.0: changed pages by demand ------------------------------------------------------
//
// The change probe stamps a changed row with the page's demand (the tracker's estimate of the time
// between bot visits), and with `queue.ready.changedDemand` the keeper counts that row's wait in visits:
// the pages bots ask for most render first. queue-state splits the due changed rows by that estimate
// (`now.changedByDemand`); the view shows the split and whether the ordering is actually in use.

const { changedOrdering, demandPeriodText } = await import('../src/admin/views/queue.js');

const H = 3_600_000;

/** The 0.94.0 changed state plus plugin 0.95.0's split. */
const withDemandState = (split) => {
	const body = withChangedState(
		split.reduce((acc, entry) => acc + entry.due, 0),
		30 * 60_000
	);
	return { ...body, now: { ...body.now, changedByDemand: split } };
};

/** A config payload carrying the options the split is read against. */
const demandConfig = ({ changedDemand = true, tracker = true } = {}) => ({
	schema: {
		children: {
			queue: { children: { ready: { children: { changedDemand: { kind: 'option' } } } } },
			demand: {
				children: { enabled: { kind: 'option' }, sliceMs: { kind: 'option' }, slices: { kind: 'option' } },
			},
		},
	},
	layers: [
		{ path: 'queue.ready.changedDemand', effective: changedDemand },
		{ path: 'demand.enabled', effective: tracker },
		{ path: 'demand.sliceMs', effective: 6 * H },
		{ path: 'demand.slices', effective: 16 },
	],
});

const SPLIT = () => [
	{ periodMs: 6 * H, due: 300, oldestDueAt: Date.now() - 10 * 60_000 },
	{ periodMs: 24 * H, due: 100, oldestDueAt: Date.now() - 3 * H },
	{ periodMs: 96 * H, due: 50, oldestDueAt: Date.now() - H },
	{ periodMs: null, due: 50, oldestDueAt: Date.now() - 20 * 60_000 },
];

async function demandCtx(state, config) {
	const ctx = makeCtx(ANALYTICS, { queueState: state });
	const get = ctx.get;
	ctx.get = async (route, query) =>
		route === 'config'
			? config
				? { ok: true, body: config }
				: { ok: false, status: 404, body: {} }
			: get(route, query);
	await load(ctx);
	return ctx;
}
const demandCard = (ctx) =>
	find(
		draw(ctx),
		(n) => (n.attributes?.class ?? '').startsWith('card') && n.textContent.startsWith('Changed, waiting — by demand')
	);
const splitRows = (card) =>
	find(card, (n) => n.tagName === 'TBODY').children.map((tr) => tr.children.map((td) => td.textContent));

test('changed pages by demand: the split, most-asked-for first, and the ordering it is ranked by', async () => {
	const ctx = await demandCtx(nodeState(withDemandState(SPLIT())), demandConfig());
	const card = demandCard(ctx);
	assert.ok(card, 'expected the by-demand card while changed pages wait');
	assert.deepEqual(splitRows(card), [
		['every 6h', '300', '60%', '10m'],
		['every 24h', '100', '20%', '3h'],
		// The tracker's whole window (16 × 6h): a page visited once in it and one never visited read the same.
		['≥ 4d / not visited', '50', '10%', '1h'],
		['unknown', '50', '10%', '20m'],
	]);
	assert.ok(find(card, (n) => n.attributes?.class === 'pill info' && n.textContent === 'ordered by demand'));
	// A group whose oldest row has waited past the changed-wait watch is marked on its own cell.
	assert.ok(find(card, (n) => n.tagName === 'TD' && n.textContent === '3h' && /v-warn/.test(n.attributes.class)));
	// The tile carries the same split in its tooltip, with the ordering.
	const title = tile(ctx, 'Changed, waiting').attributes.title;
	assert.match(title, /By demand: every 6h 300 · every 24h 100 · ≥ 4d \/ not visited 50 · unknown 50\./);
	assert.match(title, /Ranked by the bot visits/);
});

test('changed pages by demand: with changedDemand off, or the tracker off, the rows order by cadence and it says so', async () => {
	const off = demandCard(await demandCtx(nodeState(withDemandState(SPLIT())), demandConfig({ changedDemand: false })));
	assert.ok(find(off, (n) => n.attributes?.class === 'pill' && n.textContent === 'ordered by cadence'));
	assert.match(off.textContent, /queue\.ready\.changedDemand is off: changed pages order by cadence\./);

	const blind = demandCard(await demandCtx(nodeState(withDemandState(SPLIT())), demandConfig({ tracker: false })));
	assert.match(blind.textContent, /ordered by cadence/);
	assert.match(blind.textContent, /demand\.enabled is off: no page carries a demand estimate/);
});

test('changed pages by demand: without the config the split still shows, with no ordering claimed', async () => {
	const card = demandCard(await demandCtx(nodeState(withDemandState(SPLIT())), null));
	assert.ok(card);
	assert.doesNotMatch(card.textContent, /ordered by/);
	// No window to compare against, so the longest period is just a period.
	assert.equal(splitRows(card)[2][0], 'every 4d');
});

test('changed pages by demand: hidden on an older plugin, on a mixed cluster, and with nothing waiting', async () => {
	assert.equal(demandCard(await demandCtx(nodeState(withChangedState(400, 60_000)), demandConfig())), null);
	const mixed = merged(answer('a', withDemandState(SPLIT())), answer('b', withChangedState(20, 60_000)));
	assert.equal(demandCard(await demandCtx(mixed, demandConfig())), null);
	assert.equal(demandCard(await demandCtx(nodeState(withDemandState([])), demandConfig())), null);
	// Merged from nodes that all send it, the split is the cluster's.
	const both = merged(answer('a', withDemandState(SPLIT())), answer('b', withDemandState(SPLIT())));
	assert.equal(splitRows(demandCard(await demandCtx(both, demandConfig())))[0][1], '600');
});

test('demand periods read as intervals, the window as its bound, and no estimate as unknown', () => {
	assert.equal(demandPeriodText(6 * H), 'every 6h');
	assert.equal(demandPeriodText(19.2 * H), 'every 19h');
	assert.equal(demandPeriodText(1.5 * H), 'every 1.5h');
	assert.equal(demandPeriodText(30 * 60_000), 'every 30m');
	assert.equal(demandPeriodText(48 * H, 96 * H), 'every 2d');
	assert.equal(demandPeriodText(96 * H, 96 * H), '≥ 4d / not visited');
	for (const unknown of [null, undefined, 0, -1, Number.NaN])
		assert.equal(demandPeriodText(unknown, 96 * H), 'unknown');
	// On a plugin before v0.95.0 there is no ordering to state.
	assert.equal(changedOrdering({ schema: { children: {} }, layers: [] }), null);
	assert.equal(changedOrdering(demandConfig()).windowMs, 96 * H);
});
