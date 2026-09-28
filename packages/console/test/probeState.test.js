/**
 * The change probe's derived state (views/_probeState.js): what each node is doing NOW, when it runs
 * next, and which health conditions hold — the logic behind the "Probe now" card.
 *
 * The properties pinned here are the ones whose absence made the old panel confusing:
 *
 *   - The RUNNING pass and the LAST pass that ended are separate things, and nothing about one is
 *     ever read from the other (the old panel showed yesterday's counters beside "running").
 *   - A node on a plugin older than v0.91.0 is described with what it CAN say; what it cannot say is
 *     unavailable, never zero — and its next anchored run is computed from the anchor setting, since
 *     that plugin publishes it as null (#176).
 *   - Every health flag fires on the condition it names and stays quiet on a healthy node.
 *
 * The older-plugin cases use a redacted capture of four live nodes on plugin 0.83.0
 * (fixtures/change-probe-live-0.83.0.json), idle between two anchored passes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { clusterFlags, describeNode, fmtUtc, groupFlags, nextAnchorAt, nodeBodies, nodeClock, nodeFlags } = await import(
	'../src/admin/views/_probeState.js'
);

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.parse('2026-09-24T23:57:00Z');

const LIVE = JSON.parse(readFileSync(new URL('./fixtures/change-probe-live-0.83.0.json', import.meta.url)));
const LIVE_SETTINGS = {
	mode: LIVE.config.changeProbe.mode,
	anchorTime: LIVE.config.changeProbe.anchorTime,
	anchorTimezone: LIVE.config.changeProbe.anchorTimezone,
	trigger: LIVE.config.changeProbe.trigger,
};
const liveNode = (i) => LIVE.nodes[i];

/** A healthy finished pass record — the shape plugin v0.94.0 writes. */
const lastRun = (over = {}) => ({
	examined: 1_688_000,
	owned: 421_000,
	matched: 290_000,
	outOfScope: 0,
	probed: 289_990,
	seeded: 3000,
	rebaselined: 0,
	extended: 0,
	unchanged: 274_000,
	changed: 12_980,
	caughtUp: 0,
	ignored: 0,
	triggered: 13_300,
	failed: 10,
	errors: 0,
	fresh: 5,
	pageMismatch: 3400,
	throttled: 0,
	throttleLevel: 1,
	loadThrottleLevel: 1,
	behindBatches: 0,
	maxActionsInFlight: 8,
	actionWaitMs: 0,
	unreadable: 0,
	failureSamples: [],
	dryRun: false,
	startedBy: 'anchor',
	resumedFrom: null,
	resumeCursor: null,
	startedAt: NOW - 19 * HOUR,
	finishedAt: NOW - 10 * HOUR,
	error: null,
	...over,
});

const SETTINGS = {
	mode: 'anchored',
	anchorTime: '00:05',
	anchorTimezone: 'America/Chicago',
	anchorWindow: 0,
	ratePerSecond: 10,
	concurrency: 4,
	scope: 'all',
	trigger: { concurrency: 8 },
	canary: { interval: 1_800_000, count: 500, threshold: 0.7, minSample: 50 },
};

/** A v0.94.0 node payload (statusVersion 2, as since v0.91.0), idle between anchored passes. */
const v2 = (over = {}) => ({
	statusVersion: 2,
	serverTime: NOW,
	enabled: true,
	dryRun: false,
	node: 'node-a',
	mode: 'anchored',
	settings: SETTINGS,
	heartbeat: { intervalMs: 30_000, staleAfterMs: 5 * MIN },
	rules: [{ label: 'pdp', pathPattern: '^/product/', source: 'request', fingerprint: 'aaaa1111', extract: ['price'] }],
	stateAvailable: true,
	stateUpdatedAt: NOW - 2 * MIN,
	...over,
	sweep: {
		running: false,
		current: null,
		progress: null,
		lastRun: lastRun(),
		armedInterval: 'anchored:00:05|America/Chicago',
		nextAnchoredRunAt: new Date(NOW + 5 * HOUR + 8 * MIN).toISOString(),
		nextRunAt: NOW + 5 * HOUR + 8 * MIN,
		nextRunBasis: 'anchor',
		...over.sweep,
	},
	canary: { running: false, lastRun: null, armedInterval: 1_800_000, nextRunAt: NOW + 10 * MIN, ...over.canary },
});

/** The same node four hours into tonight's pass. */
const midPass = (over = {}) =>
	v2({
		...over,
		sweep: {
			running: true,
			current: {
				startedAt: NOW - 4 * HOUR,
				heartbeatAt: NOW - 20_000,
				stale: false,
				startedBy: 'anchor',
				reseed: false,
				originStartedAt: NOW - 4 * HOUR,
				dryRun: false,
				label: null,
				phase: 'walking',
				sliceEstimate: 290_000,
			},
			progress: {
				examinedApprox: 880_000,
				examined: 880_123,
				owned: 220_000,
				matched: 145_000,
				probed: 144_990,
				changed: 6000,
				failed: 4,
				throttled: 0,
				rebaselined: 0,
				triggered: 5800,
				errors: 0,
				actionsInFlight: 3,
				actionWaitMs: 0,
				cursor: 'https://www.example.com/product/k',
				throttleLevel: 1,
				recentRate: 9.9,
				phase: 'walking',
			},
			...over.sweep,
		},
	});

const flagIds = (desc) => nodeFlags(desc).map((f) => f.id);

// ---------------------------------------------------------------- now vs last

test('mid-pass: the RUNNING pass is described from its own counters, the last pass from its record', () => {
	const d = describeNode(midPass(), { hostname: 'node-a', now: NOW });
	assert.equal(d.state, 'running');
	assert.equal(d.running.startedAt, NOW - 4 * HOUR);
	assert.equal(d.running.startedBy, 'anchor');
	assert.equal(d.running.matched, 145_000, 'tonight’s count…');
	assert.equal(d.last.record.matched, 290_000, '…and last night’s, never mixed');
	assert.equal(d.running.slice, 290_000);
	assert.equal(d.running.sliceSource, 'node');
	assert.ok(Math.abs(d.running.fraction - 0.5) < 1e-9);
	// Half the slice in (4h - 20s): the other half takes as long again, from the pass start.
	assert.equal(d.running.etaAt, NOW - 4 * HOUR + 2 * (4 * HOUR - 20_000));
	assert.equal(d.running.recentRate, 9.9);
	assert.ok(d.running.avgRate > 10 && d.running.avgRate < 10.1);
	assert.equal(d.next.at, NOW + 5 * HOUR + 8 * MIN, 'the next anchor is still reported while a pass runs');
});

test('idle anchored node: the next run is the published anchor, in both clocks', () => {
	const d = describeNode(v2(), { hostname: 'node-a', now: NOW });
	assert.equal(d.state, 'idle');
	assert.equal(d.running, null);
	assert.deepEqual(d.next, { at: NOW + 5 * HOUR + 8 * MIN, basis: 'anchor', source: 'node' });
	assert.equal(fmtUtc(d.next.at, NOW), '05:05 UTC');
	assert.deepEqual(flagIds(d), [], 'a healthy idle node raises nothing');
});

test('draining: the walk is over and there is no ETA to give — the actions still in flight say what is left', () => {
	const node = midPass();
	node.sweep.current.phase = 'draining';
	const d = describeNode(node, { hostname: 'node-a', now: NOW });
	assert.equal(d.running.etaBasis, 'draining');
	assert.equal(d.running.etaAt, null, 'at most trigger.concurrency actions settling — no queue to extrapolate');
	assert.equal(d.running.actionsInFlight, 3);
	// A plugin before v0.94.0 reports no such field: unknown, not zero.
	delete node.sweep.progress.actionsInFlight;
	assert.equal(describeNode(node, { now: NOW }).running.actionsInFlight, null);
	assert.equal(flagOf(node, 'will-overrun'), undefined, 'no ETA, so nothing is projected past the anchor');
});

// ---------------------------------------------------------------- older plugins

test('older plugin (live 0.83.0 capture): idle, and the next anchored run is computed from the setting', () => {
	const { hostname, body } = liveNode(0);
	const d = describeNode(body, { hostname, now: LIVE.capturedAt, fallbackSettings: LIVE_SETTINGS });
	assert.equal(d.version, 1);
	assert.equal(d.state, 'idle');
	assert.equal(body.sweep.nextAnchoredRunAt, null, 'the plugin published null (#176)…');
	assert.equal(d.next.source, 'config', '…so the console computed it from the anchor');
	assert.equal(new Date(d.next.at).toISOString(), '2026-09-25T05:05:00.000Z', '00:05 America/Chicago');
	assert.equal(d.settings.source, 'config');
	assert.equal(d.last.outcome, 'complete');
	assert.equal(d.last.record.extended, undefined, 'a counter this plugin predates stays absent, not 0');
});

test('older plugin, mid-pass: rows walked is all there is — no start time, no counts, no ETA', () => {
	const { hostname, body } = liveNode(1);
	const running = {
		...body,
		stateUpdatedAt: LIVE.capturedAt - 40_000,
		sweep: { ...body.sweep, running: true, progress: { examinedApprox: 400_000 } },
	};
	const d = describeNode(running, { hostname, now: LIVE.capturedAt, fallbackSettings: LIVE_SETTINGS });
	assert.equal(d.state, 'running');
	assert.equal(d.running.hasCounters, false);
	assert.equal(d.running.examined, 400_000);
	assert.equal(d.running.examinedApprox, true);
	assert.equal(d.running.startedAt, null);
	assert.equal(d.running.matched, null);
	assert.equal(d.running.etaAt, null);
	assert.equal(d.running.heartbeatAt, LIVE.capturedAt - 40_000, 'the row’s updatedAt stands in for the heartbeat');
	assert.equal(d.running.heartbeatLate, false);
	// The previous complete pass is still there to size an estimate — it is just not used for counts.
	assert.equal(d.last.record.matched, body.sweep.lastRun.matched);
});

test('the four live nodes raise only what is actually there: unreadable rows and a trace of timeouts', () => {
	const descs = LIVE.nodes.map(({ hostname, body }) =>
		describeNode(body, { hostname, now: LIVE.capturedAt, fallbackSettings: LIVE_SETTINGS })
	);
	const groups = groupFlags(descs.flatMap(nodeFlags));
	assert.deepEqual(
		groups.map((g) => [g.id, g.severity]),
		[
			['unreadable-rows', 'warn'],
			['pushback-trace', 'info'],
		]
	);
	assert.deepEqual(groups[0].nodes, ['node-2.example.com', 'node-3.example.com', 'node-4.example.com']);
});

// ---------------------------------------------------------------- liveness

test('a heartbeat older than a few intervals while running is flagged late; a fresh one is not', () => {
	const late = midPass();
	late.sweep.current.heartbeatAt = NOW - 3 * MIN;
	assert.ok(flagIds(describeNode(late, { now: NOW })).includes('heartbeat-late'));
	assert.ok(!flagIds(describeNode(midPass(), { now: NOW })).includes('heartbeat-late'));
});

test('a claim whose heartbeat stopped is STALLED — not idle, not running', () => {
	const node = midPass();
	node.sweep.running = false;
	node.sweep.current = { ...node.sweep.current, heartbeatAt: NOW - 12 * MIN, stale: true };
	const d = describeNode(node, { now: NOW });
	assert.equal(d.state, 'stalled');
	assert.deepEqual(
		nodeFlags(d).map((f) => [f.id, f.severity]),
		[['stalled', 'bad']]
	);
});

test('an older plugin’s running pass with a quiet row is flagged late from the row age', () => {
	const { body } = liveNode(0);
	const node = {
		...body,
		stateUpdatedAt: NOW - 4 * MIN,
		sweep: { ...body.sweep, running: true, progress: { examinedApprox: 1 } },
	};
	assert.ok(flagIds(describeNode(node, { now: NOW, fallbackSettings: LIVE_SETTINGS })).includes('heartbeat-late'));
});

test('an unreadable state row says unknown — and nothing else, because nothing else is known', () => {
	const d = describeNode(v2({ stateAvailable: false }), { now: NOW });
	assert.equal(d.state, 'unreadable');
	const flags = nodeFlags(d);
	assert.deepEqual(
		flags.map((f) => f.id),
		['state-unreadable']
	);
	assert.match(flags[0].summary(['node-a']), /unknown, not idle/);
});

test('nodeClock carries the node’s own time forward by the time since the read', () => {
	assert.equal(nodeClock({ serverTime: 1_000_000 }, 5_000, 65_000), 1_060_000);
	assert.equal(nodeClock({}, 5_000, 65_000), 65_000, 'an older plugin falls back to the reader’s clock');
});

// ---------------------------------------------------------------- each health flag

const withLast = (over) => v2({ sweep: { lastRun: lastRun(over) } });
const flagOf = (node, id) => nodeFlags(describeNode(node, { hostname: 'node-a', now: NOW })).find((f) => f.id === id);

test('flag: failures over half is the endpoint alarm; over a tenth is a warning; the floor is quiet', () => {
	assert.equal(flagOf(withLast({ probed: 1000, failed: 600 }), 'failures-dominate').severity, 'bad');
	assert.equal(flagOf(withLast({ probed: 1000, failed: 150 }), 'failures-high').severity, 'warn');
	assert.equal(flagOf(withLast({ probed: 1000, failed: 15 }), 'failures-high'), undefined);
	assert.equal(flagOf(withLast({ probed: 1000, failed: 15 }), 'failures-dominate'), undefined);
});

test('flag: the RUNNING pass’s failure share is judged too — once it has a sample', () => {
	const failing = midPass();
	failing.sweep.progress.failed = 90_000;
	const f = flagOf(failing, 'failures-dominate');
	assert.ok(f);
	assert.match(f.detail, /running sweep/);
	const tiny = midPass();
	Object.assign(tiny.sweep.progress, { probed: 50, failed: 50 });
	assert.equal(flagOf(tiny, 'failures-dominate'), undefined, '50 probes decide nothing');
});

test('flag: pushback over 1% warns; a trace of timeouts is a note, not an alarm', () => {
	assert.equal(flagOf(withLast({ probed: 1000, failed: 30, throttled: 30 }), 'pushback').severity, 'warn');
	assert.equal(flagOf(withLast({ probed: 289_000, throttled: 7, failed: 7 }), 'pushback-trace').severity, 'info');
	assert.equal(flagOf(withLast({ throttled: 0 }), 'pushback-trace'), undefined);
});

test('flag: backoff engaged — now, or still engaged when the last pass ended', () => {
	const now = midPass();
	now.sweep.progress.throttleLevel = 8;
	assert.match(flagOf(now, 'backoff').detail, /8× the normal window right now/);
	assert.match(flagOf(withLast({ throttleLevel: 4 }), 'backoff').detail, /ended still backed off \(4× normal\)/);
});

test('flag: a pass that gave up on a refusing origin, and a pass that threw', () => {
	assert.equal(flagOf(withLast({ aborted: true, abortedOnDistress: true }), 'gave-up').severity, 'bad');
	assert.equal(flagOf(withLast({ error: 'boom' }), 'pass-error').detail, 'node-a: boom');
});

test('flag: a large re-baselined share is a rule edit; a handful of legacy rows is not', () => {
	assert.equal(flagOf(withLast({ probed: 10_000, rebaselined: 9000 }), 'rebaselined').severity, 'warn');
	assert.equal(flagOf(withLast({ probed: 290_000, rebaselined: 40 }), 'rebaselined'), undefined);
});

test('flag: a DISARMED mapped field names the rule and field', () => {
	const f = flagOf(
		withLast({
			fieldGuard: {
				pdp: {
					'2:price': { witnessed: 400, disagreed: 380, armed: false },
					'3:title': { witnessed: 9, disagreed: 0, armed: true },
				},
			},
		}),
		'field-disarmed'
	);
	assert.equal(f.severity, 'bad');
	assert.equal(f.detail, 'node-a: pdp 2:price');
});

test('flag: actions that threw are a watch on ANY count, for the last pass and the running one', () => {
	const last = flagOf(withLast({ errors: 7 }), 'action-errors');
	assert.equal(last.severity, 'warn');
	assert.equal(last.detail, 'node-a (last sweep): 7 failed of 13,307');
	assert.match(last.summary(['node-a']), /next probe of each URL finds the change again/);
	assert.equal(flagOf(withLast({ errors: 0 }), 'action-errors'), undefined);
	// The running pass is judged before it has a failure sample: each error is a page still serving.
	const early = midPass();
	Object.assign(early.sweep.progress, { probed: 40, triggered: 2, errors: 1 });
	assert.equal(flagOf(early, 'action-errors').detail, 'node-a (running sweep): 1 failed of 3');
	// A record without `triggered` still names the count, without a made-up denominator.
	assert.equal(
		flagOf(withLast({ errors: 2, triggered: undefined }), 'action-errors').detail,
		'node-a (last sweep): 2 failed'
	);
});

test('the trigger-queue era is gone: deferrals and queue depth an older plugin reports raise nothing', () => {
	// A plugin before v0.94.0 still sends these; the fields and the settings behind them no longer exist.
	const old = withLast({ deferred: 120, queued: 13_420, triggerQueueDepth: 49_000 });
	old.settings = { ...SETTINGS, trigger: { maxPending: 50_000, ratePerSecond: 3, concurrency: 4 } };
	assert.deepEqual(flagIds(describeNode(old, { hostname: 'node-a', now: NOW })), []);
});

test('a resume is described, never flagged: what it continues, where it walks from, and no share of the whole slice', () => {
	// Plugin v0.94.0 resumes from the interrupted walk's cursor, so a resumed pass's counts cover only the
	// tail of the key range: there is no large skipped share to explain, and matched ÷ slice would under-read
	// it and project an end hours late.
	const resuming = midPass();
	Object.assign(resuming.sweep.current, {
		startedBy: 'resume',
		startedAt: NOW - HOUR,
		originStartedAt: NOW - 22 * HOUR,
		reseed: true,
	});
	resuming.sweep.nextRunAt = NOW + 30 * MIN;
	const d = describeNode(resuming, { hostname: 'node-a', now: NOW });
	assert.equal(d.running.resumed, true);
	assert.equal(d.running.originStartedAt, NOW - 22 * HOUR);
	assert.equal(d.running.reseed, true);
	assert.equal(d.running.cursor, 'https://www.example.com/product/k');
	assert.equal(d.running.fraction, null, 'no percentage of a slice it did not start at the beginning of');
	assert.equal(d.running.etaAt, null);
	assert.deepEqual(flagIds(d), [], 'no resumed note, and no will-overrun from a bogus ETA');

	const resumed = withLast({
		startedBy: 'resume',
		resumedFrom: NOW - 22 * HOUR,
		resumeCursor: 'https://www.example.com/product/k',
	});
	const last = describeNode(resumed, { now: NOW }).last;
	assert.equal(last.resumed, true);
	assert.equal(last.resumedFrom, NOW - 22 * HOUR);
	assert.equal(last.resumeCursor, 'https://www.example.com/product/k');
	assert.deepEqual(flagIds(describeNode(resumed, { now: NOW })), []);
	assert.equal(describeNode(v2(), { now: NOW }).last.resumed, false, 'an ordinary pass is not a resume');
	assert.equal(describeNode(midPass(), { now: NOW }).running.resumed, false);
});

test('flag: a pass paced by its actions — past 10% of its time waiting for a free slot, and at least a minute', () => {
	// The last pass ran 9h; 1h 48m of waiting is 20% of it.
	const bound = flagOf(withLast({ actionWaitMs: 108 * MIN }), 'action-bound');
	assert.equal(bound.severity, 'warn');
	assert.equal(bound.detail, 'node-a (last sweep): waited 1h 48m (20% of the pass)');
	assert.match(bound.summary(['node-a']), /not the origin/);
	assert.match(bound.summary(['node-a']), /trigger\.concurrency/);
	assert.equal(flagOf(withLast({ actionWaitMs: 27 * MIN }), 'action-bound'), undefined, '5% is not the pace');
	// A two-minute manual pass that waited 30s is a quarter of it, and still nothing to act on.
	const short = withLast({ actionWaitMs: 30_000, startedAt: NOW - 2 * MIN, finishedAt: NOW });
	assert.equal(flagOf(short, 'action-bound'), undefined);
	// The running pass, against the time its counters cover (4h less the 20s since the heartbeat).
	const running = midPass();
	running.sweep.progress.actionWaitMs = HOUR;
	assert.match(flagOf(running, 'action-bound').detail, /^node-a \(running sweep\): waited 1h \(25%/);
	// A plugin that does not report it raises nothing.
	const old = withLast({ actionWaitMs: undefined });
	assert.equal(flagOf(old, 'action-bound'), undefined);
});

test('flag: a pass still running past its next anchor has skipped it; one projected to, would', () => {
	const overran = midPass();
	overran.sweep.nextRunAt = NOW - 10 * MIN;
	assert.equal(flagOf(overran, 'overran-anchor').severity, 'bad');
	const slow = midPass();
	slow.sweep.nextRunAt = NOW + HOUR; // the ETA is ~4h out
	assert.equal(flagOf(slow, 'will-overrun').severity, 'warn');
	assert.equal(flagOf(midPass(), 'will-overrun'), undefined, 'an ETA before the anchor is fine');
});

test('flag: continuous mode behind its cycle target', () => {
	const node = v2({
		mode: 'continuous',
		sweep: { lastRun: lastRun({ behindBatches: 35 }), armedInterval: 'continuous' },
	});
	assert.equal(flagOf(node, 'cycle-behind').severity, 'warn');
	assert.equal(flagOf(withLast({ behindBatches: 35 }), 'cycle-behind'), undefined, 'never outside continuous mode');
});

test('flag: an armed anchor with no next run — but only where null now means broken (v0.91.0)', () => {
	const broken = v2({ sweep: { nextRunAt: null, nextAnchoredRunAt: null } });
	assert.equal(flagOf(broken, 'no-next-run').severity, 'bad');
	const { body } = liveNode(0);
	assert.equal(flagOf(body, 'no-next-run'), undefined, 'an older plugin’s null is the #176 bug, not a broken anchor');
});

test('flag: a last pass older than the schedule allows', () => {
	assert.ok(flagOf(withLast({ finishedAt: NOW - 50 * HOUR, startedAt: NOW - 59 * HOUR }), 'last-pass-old'));
	assert.equal(flagOf(v2(), 'last-pass-old'), undefined);
});

test('flag: unreadable rows and a canary trip', () => {
	assert.equal(flagOf(withLast({ unreadable: 16 }), 'unreadable-rows').detail, 'node-a: 16 rows');
	const tripped = v2({ canary: { lastRun: { perRule: [{ rule: 'pdp', tripped: true }] } } });
	assert.equal(flagOf(tripped, 'canary-tripped').severity, 'info');
});

test('cluster flags: nodes off, rules / mode / settings disagreeing, live on some nodes only', () => {
	const descs = [
		describeNode(v2(), { hostname: 'a', now: NOW }),
		describeNode(v2({ enabled: false, dryRun: true, mode: 'continuous' }), { hostname: 'b', now: NOW }),
	];
	const ids = clusterFlags({ rulesDiverge: true, settingsDiverge: true }, descs).map((f) => f.id);
	assert.deepEqual(ids, ['disabled-some', 'rules-diverge', 'mode-diverge', 'settings-diverge', 'dry-run-split']);
	assert.deepEqual(clusterFlags({}, [descs[0], describeNode(v2(), { hostname: 'c', now: NOW })]), []);
});

test('grouping: one entry per condition, naming every node, worst first', () => {
	const failing = withLast({ probed: 1000, failed: 600, unreadable: 3 });
	const groups = groupFlags([
		...nodeFlags(describeNode(withLast({ unreadable: 5 }), { hostname: 'a', now: NOW })),
		...nodeFlags(describeNode(failing, { hostname: 'b', now: NOW })),
	]);
	assert.deepEqual(
		groups.map((g) => g.id),
		['failures-dominate', 'unreadable-rows']
	);
	assert.deepEqual(groups[1].nodes, ['a', 'b']);
	assert.match(groups[1].text, /on a, b/);
	assert.deepEqual(groups[1].details, ['a: 5 rows', 'b: 3 rows']);
});

// ---------------------------------------------------------------- the anchor, computed

test('nextAnchorAt: the next wall-clock occurrence in the zone, across DST, and null when unusable', () => {
	// 23:57 UTC is 18:57 in Chicago (CDT): tonight's 00:05 is 05:05 UTC tomorrow.
	assert.equal(new Date(nextAnchorAt('00:05', 'America/Chicago', NOW)).toISOString(), '2026-09-25T05:05:00.000Z');
	// Across the autumn change (1 Nov 2026 in the US): the offset is taken at the anchor, not now.
	const beforeFallBack = Date.parse('2026-10-31T12:00:00Z');
	assert.equal(
		new Date(nextAnchorAt('03:00', 'America/New_York', beforeFallBack)).toISOString(),
		'2026-11-01T08:00:00.000Z'
	);
	assert.equal(nextAnchorAt('03:00', 'Not/AZone', NOW), null);
	assert.equal(nextAnchorAt('25h', 'UTC', NOW), null);
	assert.equal(new Date(nextAnchorAt('23:58', 'UTC', NOW)).toISOString(), '2026-09-24T23:58:00.000Z');
});

test('nodeBodies reads every node’s own payload under the merge, and the payload itself at node scope', () => {
	assert.deepEqual(
		nodeBodies({ perNode: [{ hostname: 'a', x: 1 }] }).map((n) => n.hostname),
		['a']
	);
	assert.equal(nodeBodies({ node: 'solo' })[0].hostname, 'solo');
	assert.deepEqual(nodeBodies(null), []);
});
