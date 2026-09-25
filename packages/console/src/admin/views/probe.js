/**
 * Change probe: what the probe is doing RIGHT NOW, whether it is healthy, and — separately — what
 * its finished passes found.
 *
 * THE QUESTION THIS PAGE ANSWERS FIRST is "what is the probe doing now, and is it healthy?", and
 * the page before this one could not answer it. It showed the last pass that ENDED next to a bare
 * "running" — so for the nine hours an anchored pass runs, every number on it was yesterday's, and
 * an operator once attributed a pre-deploy pass's failures to a new release that way. Its cluster
 * merge dropped `mode`, `nextAnchoredRunAt` and every counter added after it was written, and
 * called an anchored cluster "not armed". So the page now leads with one state line per node
 * (running since / progress / ETA, or idle with the next run in local and UTC time), a list of
 * health flags that need no interpretation, and the running pass's own partial counts — and keeps
 * the last completed pass in a card of its own that says, while a pass runs, that it is the one
 * BEFORE it. Every time is shown with its age on the node's clock (see _probeState.js).
 *
 * WHY IT IS ITS OWN VIEW. Every other freshness surface in this console measures a page against a
 * CADENCE — the interval someone guessed and the fleet then keeps. The probe replaces the guess:
 * it asks a cheap endpoint (or the page's own JSON-LD offers) whether the fields bots care about
 * moved, and files a re-render only when they did. That makes it the one subsystem whose health
 * question is not "are we keeping up" but "is what we are detecting real" — a probe that quietly
 * stopped extracting anything reports zero changes, triggers nothing, and looks exactly like a
 * catalogue that is not moving. So the failure share is a health flag, not a number to go find.
 *
 * TWO CADENCES, AND THE PANELS KEEP THEM APART. The SWEEP walks this node's whole owned slice on
 * a long interval and catches per-URL drift; the CANARY probes a small fixed cohort every few
 * minutes and exists for the event a sweep structurally cannot see in time — a promotion that
 * reprices most of a catalogue at once. Their numbers are never added together.
 *
 * EVERYTHING HERE IS OWNER-SCOPED. A node probes only the URLs it owns, so a cluster figure is
 * the sum of every node's own slice and a node that has not swept contributes zero to it — which
 * looks precisely like a node that swept and found nothing. Every node therefore gets its own
 * column, and a sum says how many nodes it covers.
 */

import {
	ago,
	card,
	duration,
	el,
	ICONS,
	kv,
	link,
	meter,
	mono,
	muted,
	note,
	num,
	pct,
	pill,
	spacer,
	stat,
	table,
} from '../ui.js';
import {
	emptyNote,
	fmtCount,
	isMerged,
	legend,
	pick,
	rangePicker,
	ratioOf,
	scanFooter,
	scopeLabel,
	segmented,
	stackBy,
	stackedBars,
	sumValues,
	windowEmpty,
} from '../charts.js';
import { appliedNote, configState, editTray, loadConfig, optionIndex, settingsCard } from './_configEdit.js';
import {
	SINCE,
	STARTED_BY,
	clusterFlags,
	describeNode,
	fmtUtc,
	fmtWhen,
	groupFlags,
	nodeBodies,
	nodeClock,
	nodeFlags,
	relative,
} from './_probeState.js';

export const meta = { id: 'probe', label: 'Change probe', crumb: 'change probe', icon: ICONS.probe };

// A sweep interval's worth by default. The pass counters are emitted ONCE PER FINISHED PASS, so
// the 1h window every other view shares would usually contain canary passes and no sweep at all —
// and an empty panel on a healthy deployment is how a signal stops being read.
const RANGES = [
	{ label: '1h', ms: 3_600_000 },
	{ label: '6h', ms: 6 * 3_600_000 },
	{ label: '24h', ms: 24 * 3_600_000 },
];

/**
 * How often the page re-reads the probe's STATUS on its own. Only the status: it is one node-local
 * row read per node (the plugin keeps that endpoint cheap because it is polled), while the analytics
 * window is a scan and refreshes only on demand. A page that answers "what is it doing now" and never
 * refreshes is how "it seems to not have the latest data" happened.
 */
const REFRESH_MS = 30_000;

/**
 * How the sweep is scheduled, in one phrase.
 *
 * `armedInterval` is a number in interval mode, the literal 'continuous' in continuous mode, and
 * 'anchored:<time>|<zone>' in anchored mode — the plugin tags the mode into that field precisely so
 * a mode switch re-arms — so every reader of it has to branch. Formatting either string through
 * `duration()` prints nonsense, which is the failure this helper exists to make impossible rather
 * than to remember not to cause.
 *
 * Continuous mode reports the TARGET and, when a cycle has measured it, the slice being paced
 * against. A missing slice is not a blank: it means no cycle has finished counting yet, which is
 * exactly when the pass runs flat out at the rate ceiling — worth saying, because "measuring" and
 * "behind" look identical from the outside otherwise.
 */
const sweepCadence = (sweep) => {
	const armed = sweep?.armedInterval;
	if (!armed) return null;
	if (typeof armed === 'string' && armed.startsWith('anchored:')) {
		const [time, zone] = armed.slice('anchored:'.length).split('|');
		return `daily at ${time} ${zone}`;
	}
	if (armed !== 'continuous') return `every ${duration(armed)}`;
	const target = sweep.cycleTarget ? `target ${duration(sweep.cycleTarget)}` : 'no target';
	// `typeof`, not truthiness: ZERO IS A MEASURED ANSWER — a node that owns nothing, or whose
	// rows no rule matches — and rendering it as "measuring" would describe a cycle that has
	// finished counting as one that has not started.
	const slice = typeof sweep.sliceSize === 'number' ? `${num(sweep.sliceSize)} rows` : 'measuring the slice';
	return `continuous · ${target} · ${slice}`;
};

/**
 * The pass counters, in the order a pass produces them.
 *
 * THESE ARE SERIES SIDE BY SIDE, NOT A PARTITION, and three of them are deliberately not
 * disjoint: `probed` is the total the four outcome counters divide up, `throttled` is the slice
 * of `failed` the ORIGIN caused rather than the rule, and `page_mismatch` OVERLAYS the outcome
 * buckets entirely — a row whose cached page disagreed with the origin is also inside `changed`
 * or the unchanged count, because the plugin buckets by signature outcome alone. `fresh` is the
 * one that is disjoint from everything — a skipped URL was never attempted, so it is not inside
 * `probed` at all. The chart note under the bars says this, because a reader who assumes a
 * partition here reads every share on the card wrong.
 */
const OUTCOMES = [
	['fresh', 'Skipped (fresh)', '#6b7488'],
	['probed', 'Probes', '#3d8cff'],
	['seeded', 'Seeded', '#8a93a6'],
	['rebaselined', 'Re-baselined', '#7c8cc4'],
	['changed', 'Changed', '#f0a02a'],
	['page_mismatch', 'Page mismatch', '#22b8cf'],
	['triggered', 'Triggered', '#10a87e'],
	['deferred', 'Deferred', '#9d6bff'],
	['failed', 'Failed', '#e0566f'],
	['throttled', 'Throttled', '#a32438'],
];

const OUTCOME_COLOR = Object.fromEntries(OUTCOMES.map(([key, , color]) => [`probe_${key}`, color]));
const OUTCOME_LABEL = Object.fromEntries(OUTCOMES.map(([key, label]) => [`probe_${key}`, label]));

/** >50% of probes failing is the endpoint-changed-shape signature the plugin logs loudly about. */
const FAILURE_ALARM = 0.5;

/**
 * A pass that skipped this share of its matched rows is not keeping the cadence it appears to.
 *
 * `reprobeAfter` exists so a RESTARTED sweep does not re-probe ground the interrupted pass had
 * already covered, and right after a restart a large skip share is the feature working. In a
 * settled deployment it means `reprobeAfter` has been set too close to `sweepInterval`: the URLs
 * probed late in one pass fall inside the next pass's skip window, so their real re-probe cadence
 * is two sweep intervals rather than one, and nothing else on this page shows it — `probed` just
 * looks like a smaller corpus.
 */
const FRESH_NOTICE = 0.5;

export async function load(ctx) {
	ctx.data.rangeMs ??= 24 * 3_600_000;
	ctx.data.runMode ??= 'config';
	ctx.data.autoRefresh ??= true;
	// Marks this scratch as the probe view's, so a refresh timer that fires after the operator has
	// moved on can tell (`ctx.data` is always the CURRENT view's scratch).
	ctx.data.isProbeView = true;
	const [statusRes, analyticsRes] = await Promise.all([
		ctx.get('change-probe'),
		ctx.get('analytics', { range: ctx.data.rangeMs }),
		loadConfig(ctx),
	]);
	applyStatus(ctx, statusRes);
	ctx.data.analytics = analyticsRes.ok ? analyticsRes.body : null;
}

/** Take a status read, stamped with when it arrived — every age on the page is measured from it. */
const applyStatus = (ctx, res) => {
	ctx.data.status = res.ok ? res.body : null;
	ctx.data.error = res.ok ? null : (res.body?.error ?? `Could not read probe status (${res.status})`);
	ctx.data.fetchedAt = Date.now();
};

let refreshTimer = null;

/**
 * Re-arm the status refresh. Called on every render, so there is exactly one pending timer and it
 * always belongs to the page as last drawn; a render with auto-refresh off cancels it.
 */
function scheduleRefresh(ctx) {
	if (refreshTimer) clearTimeout(refreshTimer);
	refreshTimer = null;
	if (!ctx.data.autoRefresh || typeof setTimeout !== 'function') return;
	refreshTimer = setTimeout(async () => {
		refreshTimer = null;
		if (!ctx.data?.isProbeView || !ctx.data.autoRefresh || ctx.busy) return;
		const res = await ctx.get('change-probe');
		// The operator may have navigated away while the read was in flight.
		if (!ctx.data?.isProbeView) return;
		applyStatus(ctx, res);
		ctx.render();
	}, REFRESH_MS);
	refreshTimer.unref?.();
}

export function render(ctx) {
	const status = ctx.data.status;
	scheduleRefresh(ctx);

	const fetchedAt = ctx.data.fetchedAt;
	const head = el('div', { cls: 'view-head' }, [
		el('span', { cls: 'eyebrow', text: 'Change probe' }),
		spacer(),
		fetchedAt
			? muted(
					`status read at ${new Date(fetchedAt).toLocaleTimeString()} (${ago(fetchedAt)})` +
						(ctx.data.autoRefresh ? ` · re-read every ${duration(REFRESH_MS)}` : ' · auto-refresh paused')
				)
			: null,
		segmented(
			[
				{ label: 'auto-refresh', value: true, title: `Re-read the probe status every ${duration(REFRESH_MS)}.` },
				{ label: 'paused', value: false, title: 'Only re-read on Refresh.' },
			],
			ctx.data.autoRefresh,
			(value) => {
				ctx.data.autoRefresh = value;
				ctx.render();
			}
		),
		el('button', { text: 'Refresh', disabled: ctx.busy, onclick: () => ctx.reload() }),
	]);

	// The settings ride along even when the status read failed: `changeProbe.enabled` is the
	// likeliest reason this page has nothing on it, and the card that flips it belongs on the
	// screen reporting the emptiness rather than a view away.
	const knobs = [settings(ctx), editTray(ctx)];

	if (!status) {
		return [head, el('div', { cls: 'note bad', text: ctx.data.error ?? 'No probe status.' }), ...knobs];
	}

	const model = buildModel(ctx, status);
	return [
		head,
		appliedNote(ctx),
		nowCard(ctx, status, model),
		currentPassCard(model),
		lastPassCard(status, model),
		canaryCard(ctx, status, model),
		configCard(status, model),
		drift(ctx),
		capacityCard(ctx, status, model.cluster),
		...knobs,
	];
}

// ---------------------------------------------------------------- the model

/**
 * The config endpoint's view of the probe settings — used ONLY for nodes whose plugin predates
 * v0.91.0 and so does not report its own (the next anchored run, the trigger queue's ceiling).
 */
function settingsFromConfig(ctx) {
	const options = optionIndex(configState(ctx).payload);
	if (!options.size) return null;
	const setting = (path) => options.get(`changeProbe.${path}`)?.effective ?? null;
	return {
		mode: setting('mode'),
		anchorTime: setting('anchorTime'),
		anchorTimezone: setting('anchorTimezone'),
		anchorWindow: setting('anchorWindow'),
		sweepInterval: setting('sweepInterval'),
		cycleTarget: setting('cycleTarget'),
		ratePerSecond: setting('ratePerSecond'),
		concurrency: setting('concurrency'),
		scope: setting('scope'),
		reprobeAfter: setting('reprobeAfter'),
		maxTriggersPerSweep: setting('maxTriggersPerSweep'),
		trigger: { maxPending: setting('trigger.maxPending'), ratePerSecond: setting('trigger.ratePerSecond') },
		canary: {
			interval: setting('canary.interval'),
			count: setting('canary.count'),
			threshold: setting('canary.threshold'),
		},
		rules: setting('rules'),
	};
}

function buildModel(ctx, status) {
	const bodies = nodeBodies(status);
	const fallback = bodies.some(({ body }) => !body?.settings) ? settingsFromConfig(ctx) : null;
	const descs = bodies.map(({ hostname, body }) =>
		describeNode(body, { hostname, now: nodeClock(body, ctx.data.fetchedAt), fallbackSettings: fallback })
	);
	const flags = groupFlags([...descs.flatMap(nodeFlags), ...clusterFlags(status, descs)]);
	return { cluster: isMerged(status), descs, flags, fallback };
}

const nodeList = (descs) => descs.map((d) => d.hostname).join(', ');
const olderThan = (descs, version = 2) => descs.filter((d) => d.version < version);

// ---------------------------------------------------------------- probe now

const STATE_PILL = {
	'running': ['sweeping', 'info'],
	'stalled': ['stalled', 'bad'],
	'idle': ['idle', 'ok'],
	'disabled': ['disabled', 'bad'],
	'no-rules': ['no rules — nothing armed', 'warn'],
	'unreadable': ['state unreadable', 'bad'],
};

const FLAG_TITLE = {
	'state-unreadable': 'State unreadable.',
	'stalled': 'Pass stalled.',
	'heartbeat-late': 'Heartbeat late.',
	'failures-dominate': 'Probe failures dominate.',
	'failures-high': 'Probe failures high.',
	'pushback': 'Origin pushing back.',
	'pushback-trace': 'Origin pushback (trace).',
	'backoff': 'Backoff engaged.',
	'rebaselined': 'Rule edit re-baselined rows.',
	'deferred': 'Changes deferred.',
	'queue-near-full': 'Trigger queue near full.',
	'cycle-behind': 'Behind the cycle target.',
	'pass-error': 'Last sweep failed.',
	'gave-up': 'Gave up on a refusing origin.',
	'unreadable-rows': 'Unreadable registry rows.',
	'field-disarmed': 'Mapped field disarmed.',
	'no-next-run': 'No next run.',
	'overran-anchor': 'Overran the anchor.',
	'will-overrun': 'Projected to overrun the anchor.',
	'last-pass-old': 'Last sweep overdue.',
	'never-swept': 'Never swept.',
	'canary-tripped': 'Canary tripped.',
	'disabled-some': 'Disabled on some nodes.',
	'rules-diverge': 'Rules differ between nodes.',
	'mode-diverge': 'Modes differ between nodes.',
	'settings-diverge': 'Settings differ between nodes.',
	'dry-run-split': 'Live on some nodes only.',
};

/**
 * The answer to "what is the probe doing right now, and is it healthy?" — one line for the whole
 * scope, one row per node, and the health flags. The run buttons live here because they change
 * exactly what this card reports.
 *
 * THE RUN MODE IS EXPLICIT because `dryRun` is the difference between measuring and acting. The
 * plugin defaults it ON and a POST that omits it inherits the configured value, so a button
 * labelled only "Run sweep" means different things on two deployments. The picker names which of
 * the two this click will be; the timers use the configured value, not this one.
 */
function nowCard(ctx, status, model) {
	const { descs, flags, cluster } = model;
	const forcedDryRun = ctx.data.runMode === 'dry';
	const run = (action) => ctx.run(() => ctx.post('change-probe', forcedDryRun ? { action, dryRun: true } : { action }));
	const sweeping = descs.some((d) => d.state === 'running');
	const canaryRunning = descs.some((d) => d.canary?.running);
	const enabled = status.enabled !== false;
	const cadence = sweepCadence(status.sweep);
	const body = [summaryLine(model)];

	if (descs.length && descs.every((d) => d.enabled === false)) {
		body.push(
			note('bad', [
				el('code', { text: 'changeProbe.enabled' }),
				` is false${cluster ? ' on every node' : ''}. Nothing is probed and nothing here will move; the settings ` +
					'card below turns it on.',
			])
		);
	} else if (!(status.rules ?? []).length) {
		body.push(
			note('warn', [
				'The probe is enabled and no ',
				el('code', { text: 'changeProbe.rules' }),
				' match anything, so no timer is armed. A rule names the path pattern to claim and where to read ' +
					'the fields that matter; without one there is nothing to compare.',
			])
		);
	}

	body.push(stateTable(model));

	const older = olderThan(descs);
	if (older.length) {
		body.push(
			note('', [
				`${nodeList(older)} ${older.length === 1 ? 'runs' : 'run'} a plugin older than 0.91.0, which does not report ` +
					'the running pass’s own counts or start time, or its next run. Where a column says ' +
					'“n/a” the value is UNAVAILABLE on that node, not zero; the next anchored run shown for it is computed ' +
					'here from the anchor setting.',
			])
		);
	}

	body.push(flagsBlock(flags));

	return card(`Probe now — ${scopeLabel(status)}`, {
		head: [
			enabled ? pill(cadence ?? 'not armed', cadence ? 'ok' : 'bad') : pill('disabled', 'bad'),
			status.dryRun
				? pill('dry run — detects, triggers nothing', 'warn')
				: pill(status.liveOn?.length && status.liveOn.length < descs.length ? 'live on some nodes' : 'live', 'ok'),
			canaryRunning && pill('canary running', 'info'),
			spacer(),
			segmented(
				[
					{ label: 'as configured', value: 'config', title: 'Inherit changeProbe.dryRun — what the timers use.' },
					{ label: 'force dry run', value: 'dry', title: 'Probe and re-baseline without triggering or invalidating.' },
				],
				ctx.data.runMode,
				(value) => {
					ctx.data.runMode = value;
					ctx.render();
				}
			),
			el('button', {
				text: cluster ? 'Sweep (pick a node)' : sweeping ? 'Sweep running…' : 'Run sweep',
				disabled: ctx.busy || cluster || !enabled || sweeping,
				title: cluster
					? 'A pass covers the URLs one node owns, at that node’s probe rate. Switch to a node to run it there.'
					: null,
				onclick: () => run('sweep'),
			}),
			el('button', {
				text: cluster ? 'Canary (pick a node)' : canaryRunning ? 'Canary running…' : 'Run canary',
				disabled: ctx.busy || cluster || !enabled || canaryRunning,
				title: cluster ? 'The cohort is built from the keys one node owns. Switch to a node.' : null,
				onclick: () => run('canary'),
			}),
		],
		body,
		foot: [
			muted(
				status.ownerScopeNote ??
					'Probes only the URLs this node owns; every node sweeps its own slice. A probe is origin backend ' +
						'work — the rate cap is a promise to whoever runs it, per node.'
			),
		],
	});
}

const sumOf = (values) => values.reduce((acc, value) => acc + (Number.isFinite(value) ? value : 0), 0);

/** The whole scope in one sentence: what is running, how far along, and when anything runs next. */
function summaryLine(model) {
	const { descs } = model;
	const total = descs.length;
	const now = descs[0]?.now ?? Date.now();
	const where = (k) => (total <= 1 ? '' : k === total ? ` on all ${total} nodes` : ` on ${k} of ${total} nodes`);
	const byState = (...states) => descs.filter((d) => states.includes(d.state));
	const parts = [];

	const running = byState('running');
	if (running.length) {
		let text = `Sweeping${where(running.length)}`;
		const measured = running.filter((d) => d.running.fraction !== null);
		if (measured.length) {
			// Disjoint slices, so both terms add — over the nodes that report both.
			const done = sumOf(measured.map((d) => d.running.matched)) / sumOf(measured.map((d) => d.running.slice));
			text += ` · ~${Math.round(Math.min(0.999, done) * 100)}% through`;
			if (measured.length < running.length) text += ` (${measured.length} reporting)`;
			const etas = measured.map((d) => d.running.etaAt).filter(Number.isFinite);
			if (etas.length)
				text += ` · ${measured.length > 1 ? 'last node done' : 'done'} ~${fmtWhen(Math.max(...etas), now)}`;
		} else {
			const examined = sumOf(running.map((d) => d.running.examined));
			if (examined > 0) text += ` · ~${num(examined)} rows examined${running.length > 1 ? ' across them' : ''}`;
		}
		parts.push(text);
	}
	const stalled = byState('stalled');
	if (stalled.length) parts.push(`${parts.length ? 'stalled' : 'Stalled'}${where(stalled.length)}`);
	const idle = byState('idle');
	if (idle.length) {
		let text = `${parts.length ? 'idle' : 'Idle'}${where(idle.length)}`;
		const nexts = idle.map((d) => d.next.at).filter(Number.isFinite);
		if (nexts.length) text += ` · next sweep ${fmtWhen(Math.min(...nexts), now)}`;
		else if (idle.every((d) => d.next.basis === 'continuous'))
			text += ' · continuous: each cycle starts as the last ends';
		parts.push(text);
	}
	const off = byState('disabled', 'no-rules');
	if (off.length) parts.push(`${parts.length ? 'off' : 'Off'}${where(off.length)}`);
	const unknown = byState('unreadable');
	if (unknown.length) parts.push(`${parts.length ? 'unknown' : 'Unknown'}${where(unknown.length)} (state unreadable)`);
	return el('p', { cls: 'probe-summary' }, [parts.join(' · ') || 'No node answered.']);
}

const NA = (why) => el('span', { cls: 'muted', text: 'n/a', title: why });

function stateTable(model) {
	return table(
		['node', 'state', 'progress', 'rate', 'finishes / next run', 'state row'],
		model.descs.map((d) =>
			el('tr', null, [
				el('td', { cls: 'mono nowrap', text: d.hostname }),
				el('td', null, stateCell(d)),
				el('td', null, progressCell(d)),
				el('td', null, rateCell(d)),
				el('td', null, whenCell(d)),
				el('td', null, rowCell(d)),
			])
		)
	);
}

const line = (children) => el('div', { cls: 'cell-line' }, children);

function stateCell(d) {
	const [text, kind] = STATE_PILL[d.state] ?? [d.state, ''];
	const out = [pill(text, kind)];
	if (d.state === 'running' || d.state === 'stalled') {
		const r = d.running;
		if (r.phase === 'draining') out.push(pill('draining triggers', 'info'));
		const runMode = r.dryRun ?? (d.dryRun === false ? false : d.dryRun === true ? true : null);
		if (runMode !== null) out.push(runMode ? pill('dry run', 'warn') : pill('live', 'ok'));
		out.push(
			line([
				r.startedAt !== null
					? muted(`since ${fmtUtc(r.startedAt, d.now)} (${relative(r.startedAt, d.now)})`)
					: NA('This node’s plugin (< 0.91.0) does not report when the running pass started.'),
			])
		);
		if (r.startedBy) out.push(line([muted(`started by ${STARTED_BY[r.startedBy] ?? r.startedBy}`)]));
	} else {
		if (d.state !== 'unreadable') out.push(d.dryRun === false ? pill('live', 'ok') : pill('dry run', 'warn'));
		if (d.last?.finishedAt) out.push(line([muted(`last sweep ended ${relative(d.last.finishedAt, d.now)}`)]));
		else if (d.state === 'idle') out.push(line([muted('no sweep has finished yet')]));
	}
	if (d.canary?.running) out.push(pill('canary', 'info'));
	return out;
}

function progressCell(d) {
	const r = d.running;
	if (!r) return [muted('—')];
	if (!r.hasCounters) {
		return [
			r.examined !== null ? mono(`~${num(r.examined)} rows examined`) : muted('no heartbeat count yet'),
			line([muted('the pass’s own counts: n/a on plugin < 0.91.0')]),
		];
	}
	if (r.slice !== null && r.matched !== null) {
		return [
			meter(r.fraction),
			line([mono(`${num(r.matched)} of ~${num(r.slice)} matched (${Math.round(r.fraction * 100)}%)`)]),
			line([muted(`${num(r.examined)} rows examined · ${num(r.probed)} probed`)]),
		];
	}
	return [
		mono(`${num(r.matched ?? 0)} matched so far`),
		line([muted(`${num(r.examined)} rows examined — no slice estimate yet, so no percentage`)]),
	];
}

function rateCell(d) {
	const r = d.running;
	if (!r) return [muted('—')];
	if (!r.hasCounters) return [NA('This node’s plugin (< 0.91.0) does not report the running pass’s rate.')];
	return [
		r.recentRate !== null ? mono(`${r.recentRate.toFixed(1)}/s now`) : muted('—'),
		r.avgRate !== null ? line([muted(`${r.avgRate.toFixed(1)}/s average`)]) : null,
	];
}

const BASIS = {
	anchor: 'the daily anchor',
	interval: 'the sweep interval',
	startup: 'the startup sweep',
	continuous: 'continuous',
};

function whenCell(d) {
	const out = [];
	if (d.running) {
		const r = d.running;
		if (r.etaAt !== null) {
			out.push(mono(`done ~${fmtWhen(r.etaAt, d.now)}`));
			out.push(
				line([
					muted(
						r.etaBasis === 'draining'
							? 'walk finished; draining the trigger queue'
							: `estimate: ${num(r.slice)}-row slice (${r.sliceSource === 'node' ? 'measured by the node' : 'the last complete pass'})`
					),
				])
			);
		} else {
			out.push(
				NA(
					!r.hasCounters
						? 'This node’s plugin (< 0.91.0) reports no counts to extrapolate from.'
						: r.slice === null
							? 'No slice estimate yet — the first complete pass measures it.'
							: 'Not enough of the pass has run to extrapolate.'
				)
			);
			out.push(line([muted('ETA unavailable')]));
		}
	}
	if (d.state === 'disabled' || d.state === 'no-rules' || d.state === 'unreadable')
		return out.length ? out : [muted('—')];
	const next = d.next;
	if (next.basis === 'continuous') {
		out.push(line([muted('continuous — the next cycle starts as this one ends')]));
	} else if (next.at !== null) {
		out.push(
			line([d.running ? muted(`next ${BASIS[next.basis] ?? 'run'}: `) : muted('next: '), mono(fmtWhen(next.at, d.now))])
		);
		if (!d.running && next.basis) out.push(line([muted(`by ${BASIS[next.basis] ?? next.basis}`)]));
		if (next.source === 'config') out.push(line([muted('computed here from the anchor setting (plugin < 0.91.0)')]));
		if (next.source === 'estimate') out.push(line([muted('estimated from the last pass’s start (plugin < 0.91.0)')]));
	} else if (next.basis === 'anchor') {
		out.push(pill('no next run', 'bad'));
	} else if (!d.running) {
		out.push(muted(d.armed === null ? 'not armed' : 'unknown'));
	}
	return out;
}

function rowCell(d) {
	const out = [];
	if (d.rowAgeMs !== null) out.push(muted(`updated ${duration(d.rowAgeMs)} ago`));
	else out.push(muted('—'));
	if (d.running?.heartbeatAt !== null && d.running?.heartbeatAt !== undefined && d.version >= 2) {
		out.push(line([muted(`heartbeat ${relative(d.running.heartbeatAt, d.now)}`)]));
	}
	if (d.state === 'stalled') out.push(pill('heartbeat stopped', 'bad'));
	else if (d.running?.heartbeatLate) out.push(pill('heartbeat late', 'warn'));
	return out;
}

/** The health flags, worst first, each naming the nodes it holds on and each node's own figure. */
function flagsBlock(groups) {
	if (!groups.length) {
		return note('ok', [
			'No health flags: nothing failing, backing off, stalled, overdue, or disagreeing between nodes.',
		]);
	}
	const counts = ['bad', 'warn', 'info']
		.map((severity) => [severity, groups.filter((g) => g.severity === severity).length])
		.filter(([, n]) => n)
		.map(
			([severity, n]) =>
				`${n} ${severity === 'bad' ? 'fault' : severity === 'warn' ? 'warning' : 'note'}${n === 1 ? '' : 's'}`
		);
	return el('div', { cls: 'probe-flags' }, [
		el('div', { cls: 'subhead', text: `Health — ${counts.join(', ')}` }),
		...groups.map((group) =>
			note(group.severity, [
				el('strong', { text: FLAG_TITLE[group.id] ?? group.id }),
				' ',
				group.text,
				group.details.length
					? el(
							'ul',
							{ cls: 'flag-details' },
							group.details.map((detail) => el('li', { cls: 'mono', text: detail }))
						)
					: null,
			])
		),
	]);
}

// ---------------------------------------------------------------- the running pass

/** Counter rows shared by the running-pass and last-pass tables: [key, label, sub-label, options]. */
const COUNT_ROWS = [
	['examined', 'Rows examined', 'every registry row walked'],
	['owned', 'Owned by this node', null],
	['matched', 'Matched a rule', null],
	['outOfScope', 'Left out by changeProbe.scope', 'matched, not probed'],
	['fresh', 'Skipped — baseline still fresh', 'outside Probed'],
	['probed', 'Probed', 'seeded + re-baselined + unchanged + changed + failed'],
	['seeded', 'Seeded', 'first observation'],
	['rebaselined', 'Re-baselined', 'other rule’s baseline: stored, not compared'],
	['unchanged', 'Unchanged', null],
	['changed', 'Changed', null],
	['extended', 'Compared on appended paths', 'overlays unchanged/changed'],
	['caughtUp', 'Caught up — page already right', 'overlays Changed; no render'],
	['ignored', 'Ignored — ignoreChanges slots', 'overlays Unchanged'],
	['pageMismatch', 'Pages disagreeing with the origin', 'overlays the buckets', { hideWhenZero: true }],
	['queued', 'Queued re-renders', 'handed to the trigger queue'],
	['triggered', 'Re-renders filed', null],
	['deferred', 'Deferred', 'retried next pass'],
	['failed', 'Failed probes', null],
	['throttled', '— of those, origin pushback', 'inside Failed'],
	['errors', 'Trigger write errors', null],
];

const countCell = (run, key) => {
	if (!run) return el('td', { cls: 'right muted', text: '—' });
	const value = run[key];
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		const since = SINCE[key];
		return el('td', {
			cls: 'right muted',
			text: 'n/a',
			title: since ? `not reported by this node’s plugin (added in ${since})` : 'not reported by this node',
		});
	}
	return el('td', { cls: 'right mono', text: num(value) });
};

/**
 * A metric-by-node table. `columns` are `{ label, run, version }`; a Σ column is added for more
 * than one node, summing only the nodes that report the counter and saying so when that is fewer.
 */
function passTable(columns, extraRows, { withSum = false } = {}) {
	const header = [{ text: '' }, ...columns.map((c) => ({ text: c.label, right: true }))];
	if (withSum) header.push({ text: `Σ ${columns.length} nodes`, right: true });
	const rows = [...extraRows.map((row) => row(columns))];
	for (const [key, label, sub, options] of COUNT_ROWS) {
		const reported = columns.filter((c) => typeof c.run?.[key] === 'number' && Number.isFinite(c.run[key]));
		if (options?.hideWhenZero && !reported.some((c) => c.run[key] > 0)) continue;
		// A counter no column reports at all is left out rather than drawn as a row of n/a.
		if (!reported.length && !columns.some((c) => c.run && SINCE[key])) continue;
		if (!reported.length && columns.every((c) => !c.run)) continue;
		const cells = [
			el('td', null, [el('span', { text: label }), sub ? el('div', { cls: 'sub muted', text: sub }) : null]),
			...columns.map((c) => countCell(c.run, key)),
		];
		if (withSum) {
			const total = reported.reduce((acc, c) => acc + c.run[key], 0);
			const partial = reported.length < columns.length;
			cells.push(
				el('td', {
					cls: `right mono${partial ? ' muted' : ''}`,
					text: reported.length ? `${num(total)}${partial ? '*' : ''}` : 'n/a',
					title: partial ? `sum of ${reported.length} of ${columns.length} nodes — the others do not report it` : null,
				})
			);
		}
		rows.push(el('tr', null, cells));
	}
	return table(header, rows);
}

/** A labelled row whose cells come from each column. */
const infoRow =
	(label, cellOf, sumCell = null) =>
	(columns) =>
		el('tr', null, [
			el('td', { text: label }),
			...columns.map((c) => el('td', { cls: 'right' }, [cellOf(c)])),
			...(sumCell ? [el('td', { cls: 'right' }, [sumCell(columns)])] : columns.length > 1 ? [el('td', null, [])] : []),
		]);

/**
 * THE PASS IN FLIGHT, and only it. These are the running pass's own counters as of its last
 * heartbeat (plugin v0.91.0). Before, the only number a running pass published was rows walked, so
 * the page showed the previous pass's counters instead — the confusion this card exists to end.
 */
function currentPassCard(model) {
	const live = model.descs.filter((d) => d.running);
	if (!live.length) return null;
	const columns = live.map((d) => ({
		label: d.hostname,
		run: d.running.hasCounters ? d.running.progress : null,
		version: d.version,
		d,
	}));
	const older = live.filter((d) => !d.running.hasCounters);
	const rows = [
		infoRow('Started', ({ d }) =>
			d.running.startedAt !== null ? mono(fmtUtc(d.running.startedAt, d.now)) : NA('plugin < 0.91.0')
		),
		infoRow('Started by', ({ d }) =>
			d.running.startedBy ? muted(STARTED_BY[d.running.startedBy] ?? d.running.startedBy) : NA('plugin < 0.91.0')
		),
		infoRow('Run mode', ({ d }) =>
			d.running.dryRun === null
				? NA('plugin < 0.91.0')
				: d.running.dryRun
					? pill('dry run', 'warn')
					: pill('live', 'ok')
		),
		infoRow('Phase', ({ d }) =>
			d.running.phase
				? muted(d.running.phase === 'draining' ? 'draining triggers' : 'walking the registry')
				: NA('plugin < 0.91.0')
		),
		infoRow('Counts as of', ({ d }) =>
			d.running.hasCounters && d.running.heartbeatAt !== null
				? muted(`heartbeat ${relative(d.running.heartbeatAt, d.now)}`)
				: NA('plugin < 0.91.0')
		),
		infoRow('Trigger queue now', ({ run }) =>
			typeof run?.triggerQueueDepth === 'number' ? mono(num(run.triggerQueueDepth)) : NA('plugin < 0.91.0')
		),
		infoRow('Pacing window now', ({ run }) =>
			typeof run?.throttleLevel === 'number'
				? run.throttleLevel > 1
					? pill(`${num(run.throttleLevel)}× normal — backed off`, 'bad')
					: mono('1× (normal)')
				: NA('plugin < 0.91.0')
		),
	];
	return card('Current pass — in progress', {
		head: [pill('partial counts, so far', 'info'), spacer(), muted('each node’s own running pass')],
		body: [
			note('info', [
				'These are the RUNNING pass’s own counts, as of its last heartbeat — a pass part-way through its slice, ' +
					'not a result. The last pass that finished is in its own card below and is never mixed into these.',
			]),
			passTable(columns, rows, { withSum: columns.length > 1 }),
			older.length
				? muted(
						`${nodeList(older)}: only rows walked are reported by plugin < 0.91.0 — the rest of that column is ` +
							'unavailable, not zero.'
					)
				: null,
		],
	});
}

// ---------------------------------------------------------------- the last completed pass

const OUTCOME_PILL = {
	'complete': () => pill('complete', 'ok'),
	'interrupted': () => pill('stood down for a reseed, or the probe was disabled', ''),
	'gave-up': (run) =>
		pill(
			run.distressedOn?.length
				? `gave up on a refusing origin (${run.distressedOn.join(', ')})`
				: 'gave up on a refusing origin',
			'bad'
		),
	'error': () => pill('failed', 'bad'),
};

const hasCounts = (run) => typeof run?.probed === 'number' && Number.isFinite(run.probed);

/**
 * THE LAST PASS THAT FINISHED, per node, labelled as such — and while a pass is running, labelled
 * as the pass BEFORE it. One column per node, because nodes finish at different times and a summed
 * column is only honest when it says how many nodes it covers.
 */
function lastPassCard(status, model) {
	const { descs, cluster } = model;
	const withRuns = descs.filter((d) => d.last);
	const counted = withRuns.filter((d) => hasCounts(d.last.record));
	const anyRunning = descs.some((d) => d.running);
	const body = [];

	const unswept = descs
		.filter((d) => !d.last && d.state !== 'disabled' && d.state !== 'no-rules' && d.state !== 'unreadable')
		.map((d) => d.hostname);
	if (cluster && unswept.length) {
		body.push(
			note('warn', [
				`No sweep has finished on ${unswept.join(', ')} since startup — the URLs those nodes own are not in the ` +
					'figures below, so every sum here covers less of the corpus than it appears to.',
			])
		);
	}

	for (const d of withRuns.filter((x) => x.last.outcome === 'error')) {
		body.push(
			note('bad', [
				`Last sweep failed${cluster ? ` on ${d.hostname}` : ''}: ${d.last.record.error}`,
				counted.length && !hasCounts(d.last.record) ? ' — the counts below cover only the passes that did finish.' : '',
			])
		);
	}
	// Above the counts, because it changes what they mean: that pass did not cover its slice.
	for (const d of withRuns.filter((x) => x.last.outcome === 'gave-up')) {
		body.push(
			note('bad', [
				`The last sweep${cluster ? ` on ${d.hostname}` : ''} STOPPED EARLY because the origin refused `,
				el('code', { text: 'changeProbe.abortAfterDistress' }),
				' probes in a row — an origin that is down rather than busy. It covered only part of the owned slice, so ' +
					'its column is a partial count and the rest of the slice keeps whatever baselines it had. The next ' +
					'scheduled pass is the retry and it starts clean; nothing needs restarting here.',
			])
		);
	}

	if (!withRuns.length) {
		body.push(
			muted('No sweep has finished since startup. The first one runs at the next scheduled start (see Probe now).')
		);
	}

	if (counted.length) {
		const columns = counted.map((d) => ({ label: d.hostname, run: d.last.record, version: d.version, d }));
		const withSum = columns.length > 1;
		const oldest = (cols) => {
			const at = Math.min(...cols.map((c) => c.d.last.finishedAt ?? Infinity));
			return Number.isFinite(at) ? muted(`oldest ${relative(at, cols[0].d.now)}`) : muted('—');
		};
		const rows = [
			infoRow(
				'Finished',
				({ d }) =>
					el('span', null, [
						mono(fmtUtc(d.last.finishedAt, d.now)),
						el('div', { cls: 'sub muted', text: relative(d.last.finishedAt, d.now) }),
					]),
				withSum ? oldest : null
			),
			infoRow('Started', ({ d }) => mono(fmtUtc(d.last.startedAt, d.now))),
			infoRow('Duration', ({ d }) => mono(d.last.durationMs !== null ? duration(d.last.durationMs) : '—')),
			infoRow('Started by', ({ run }) =>
				run.startedBy ? muted(STARTED_BY[run.startedBy] ?? run.startedBy) : NA('not reported by plugin < 0.91.0')
			),
			infoRow('Run mode', ({ run }) =>
				run.dryRun === false ? pill('live', 'ok') : pill('dry run — nothing triggered', 'warn')
			),
			infoRow('Outcome', ({ d, run }) => (OUTCOME_PILL[d.last.outcome] ?? OUTCOME_PILL.complete)(run)),
		];
		// The pass's END state, not its worst moment: the window halves back on every clean batch,
		// so a value above 1 means the pass was STILL backed off when it finished.
		if (columns.some((c) => c.run.throttleLevel > 1)) {
			rows.push(
				infoRow('Pacing window at the end — origin', ({ run }) =>
					run.throttleLevel > 1 ? pill(`${num(run.throttleLevel)}× normal — still backed off`, 'bad') : mono('1×')
				)
			);
		}
		// The LOCAL governor, apart from the origin one on purpose: a pass crawling because the origin
		// is shedding load and one crawling because this node is losing its event loop to the serve
		// path share a symptom and nothing else, and the fixes point in opposite directions.
		if (columns.some((c) => c.run.loadThrottleLevel > 1)) {
			rows.push(
				infoRow('Pacing window at the end — local load', ({ run }) =>
					run.loadThrottleLevel > 1
						? pill(
								`${num(run.loadThrottleLevel)}× normal${typeof run.loopLagMs === 'number' ? ` — event loop ${Math.round(run.loopLagMs)}ms behind` : ''}`,
								'warn'
							)
						: mono('1×')
				)
			);
		}
		rows.push(
			infoRow('Trigger queue high-water', ({ run }) =>
				typeof run.triggerQueueDepth === 'number'
					? mono(num(run.triggerQueueDepth))
					: NA(`added in ${SINCE.triggerQueueDepth}`)
			)
		);
		if (columns.some((c) => c.run.unreadable > 0)) {
			rows.push(
				infoRow('Unreadable rows stepped over', ({ run }) =>
					run.unreadable > 0 ? pill(num(run.unreadable), 'bad') : mono('0')
				)
			);
		}
		body.push(passTable(columns, rows, { withSum }));
		body.push(semanticsNote(counted));
		body.push(...detailsOf(status, counted, model));
	}

	return card(anyRunning ? 'Last completed sweep — the pass BEFORE the one running now' : 'Last completed sweep', {
		head: [
			anyRunning ? pill('previous pass — not the running one', 'warn') : null,
			spacer(),
			muted(counted.length > 1 ? `each node’s own slice; Σ adds ${counted.length} nodes` : ''),
		],
		body,
		foot: [
			muted(
				'The sweep catches per-URL drift — an item selling out, one price moving. It walks the whole owned ' +
					'slice at the configured rate, so a large corpus takes hours per pass by design; that is what the ' +
					'canary exists to cover.'
			),
		],
	});
}

/**
 * Which counts are per pass and which are not. Stated, because it has changed: a plugin that keeps
 * one trigger queue across passes reports `triggered`/`errors` cumulatively (it carries
 * `triggerQueuePending`), and a reader summing those per pass would count every re-render twice.
 */
function semanticsNote(counted) {
	const cumulative = counted.filter((d) => 'triggerQueuePending' in d.last.record);
	return el('p', { cls: 'muted chart-note' }, [
		'Every count here is for that one pass on that node. “Queued re-renders” is what the pass handed to the ' +
			'trigger queue; “Re-renders filed” is how many of those it saw land before it ended',
		cumulative.length
			? ` — except on ${nodeList(cumulative)}, whose plugin keeps one trigger queue across passes: there “Re-renders ` +
				'filed” and “Trigger write errors” are CUMULATIVE since the process started, and “Queued” is the per-pass figure.'
			: ' (the queue drains before the pass ends, so it is per pass too).',
		' The overlay rows — pages disagreeing, caught up, ignored, appended paths — are not buckets: a row counted ' +
			'there is also inside Changed or Unchanged. “n/a” is a counter the node’s plugin does not report; Σ marked * ' +
			'sums only the nodes that do.',
	]);
}

/** Slot index → extract path, from the node-reported rules (v0.91.0) or the configured rules. */
function extractPaths(status, model) {
	const paths = new Map();
	for (const rule of status.rules ?? []) if (Array.isArray(rule.extract)) paths.set(rule.label, rule.extract);
	for (const rule of Array.isArray(model.fallback?.rules) ? model.fallback.rules : []) {
		if (rule?.label && Array.isArray(rule.extract) && !paths.has(rule.label)) paths.set(rule.label, rule.extract);
	}
	return paths;
}

/** `{ rule: { key: n } }` summed over the nodes' pass records, or null when no node reports it. */
const sumMaps = (runs, key) => {
	let seen = false;
	const out = {};
	for (const run of runs) {
		if (!run?.[key] || typeof run[key] !== 'object') continue;
		seen = true;
		for (const [rule, counts] of Object.entries(run[key])) {
			for (const [leaf, n] of Object.entries(counts ?? {})) {
				out[rule] ??= {};
				out[rule][leaf] = (out[rule][leaf] ?? 0) + (Number(n) || 0);
			}
		}
	}
	return seen ? out : null;
};

const details = (summary, children) =>
	el('details', { cls: 'probe-details' }, [el('summary', { text: summary }), ...children.filter(Boolean)]);

/** Detail on demand: where the changes were, which page fields disagreed, the guard, the failures. */
function detailsOf(status, counted, model) {
	const runs = counted.map((d) => d.last.record);
	const paths = extractPaths(status, model);
	const pathOf = (rule, slot) =>
		slot === 'signal' ? 'a status-signal literal (no slot)' : (paths.get(rule)?.[Number(slot)] ?? '—');
	const out = [];
	const unreportedBy = (key) => counted.filter((d) => !(key in d.last.record)).map((d) => d.hostname);

	const slots = sumMaps(runs, 'slotChanges');
	const slotRows = Object.entries(slots ?? {}).flatMap(([rule, counts]) =>
		Object.entries(counts)
			.sort(([, a], [, b]) => b - a)
			.map(([slot, n]) =>
				el('tr', null, [
					el('td', { cls: 'mono', text: rule }),
					el('td', { cls: 'mono', text: slot }),
					el('td', { cls: 'mono truncate', text: pathOf(rule, slot), title: pathOf(rule, slot) }),
					el('td', { cls: 'right mono', text: num(n) }),
				])
			)
	);
	out.push(
		details(`Where the origin changed — per extract slot${slots ? '' : ' (not reported)'}`, [
			slots
				? table(['rule', 'slot', 'extract path', { text: 'changes', right: true }], slotRows, 'No slot changed.')
				: muted(`Not reported by plugin < ${SINCE.slotChanges} (${unreportedBy('slotChanges').join(', ')}).`),
			slots && unreportedBy('slotChanges').length
				? muted(`${unreportedBy('slotChanges').join(', ')} do not report it; the counts cover the other nodes.`)
				: null,
			slots
				? muted('Decomposes Changed, Caught up and Ignored by the slot that moved; one change can move several slots.')
				: null,
		])
	);

	const fields = sumMaps(runs, 'fieldMismatch');
	const fieldRows = Object.entries(fields ?? {}).flatMap(([rule, counts]) =>
		Object.entries(counts)
			.sort(([, a], [, b]) => b - a)
			.map(([field, n]) => {
				const slot = String(field).split(':')[0];
				return el('tr', null, [
					el('td', { cls: 'mono', text: rule }),
					el('td', { cls: 'mono', text: field }),
					el('td', { cls: 'mono truncate', text: pathOf(rule, slot), title: pathOf(rule, slot) }),
					el('td', { cls: 'right mono', text: num(n) }),
				]);
			})
	);
	out.push(
		details(`Page fields that disagreed with the origin${fields ? '' : ' (not reported)'}`, [
			fields
				? table(
						['rule', 'field (slot:fact)', 'extract path', { text: 'mismatches', right: true }],
						fieldRows,
						'No mapped field disagreed.'
					)
				: muted(`Not reported by plugin < ${SINCE.fieldMismatch} (${unreportedBy('fieldMismatch').join(', ')}).`),
			fields
				? muted('Counted for every mapped field, armed or disarmed — a disarmed field counts here and only here.')
				: null,
		])
	);

	const guardRows = [];
	for (const d of counted) {
		for (const [rule, entries] of Object.entries(d.last.record.fieldGuard ?? {})) {
			for (const [field, entry] of Object.entries(entries ?? {})) {
				guardRows.push(
					el('tr', null, [
						el('td', { cls: 'mono', text: d.hostname }),
						el('td', { cls: 'mono', text: `${rule} ${field}` }),
						el('td', { cls: 'right mono', text: num(entry?.witnessed) }),
						el('td', { cls: 'right mono', text: num(entry?.disagreed) }),
						el('td', { cls: 'right mono', text: pct(entry?.disagreed ?? 0, entry?.witnessed ?? 0) }),
						el('td', null, [entry?.armed === false ? pill('DISARMED', 'bad') : pill('armed', 'ok')]),
					])
				);
			}
		}
	}
	if (guardRows.length || counted.some((d) => 'fieldGuard' in d.last.record)) {
		out.push(
			details('Mapping guard — recent witnessed comparisons per mapped field', [
				table(
					[
						'node',
						'field',
						{ text: 'witnessed', right: true },
						{ text: 'disagreed', right: true },
						{ text: 'rate', right: true },
						'state',
					],
					guardRows,
					'No mapped fields.'
				),
				muted(
					'Per node (the guard is per process). A disarmed field stops triggering until its mapping changes or the process restarts.'
				),
			])
		);
	}

	const samples = counted.flatMap((d) =>
		(d.last.record.failureSamples ?? []).map((sample) => ({ node: d.hostname, ...sample }))
	);
	if (samples.length) {
		out.push(
			details(`Failure samples (${samples.length})`, [
				muted(
					'The first few failures of each pass. A failure leaves the stored signature untouched and triggers ' +
						'nothing, so these are pages back on interval-only freshness until the rule fits again.'
				),
				table(
					['node', 'url', 'rule', 'error'],
					samples.map((sample) =>
						el('tr', null, [
							el('td', { cls: 'mono', text: sample.node }),
							el('td', { cls: 'mono truncate', text: sample.url ?? '—', title: sample.url ?? '' }),
							el('td', { cls: 'mono', text: sample.rule ?? '—' }),
							el('td', { cls: 'mono truncate', text: sample.error ?? '—', title: sample.error ?? '' }),
						])
					)
				),
			])
		);
	}
	return out;
}

// ---------------------------------------------------------------- configuration

/** An older plugin's rule, completed from the configured rules: the probed endpoint's method and path. */
function configuredEndpoint(rule, model) {
	const configured = (Array.isArray(model.fallback?.rules) ? model.fallback.rules : []).find(
		(r) => r?.label === rule.label
	);
	const template = configured?.request?.urlTemplate;
	if (typeof template !== 'string') return null;
	try {
		return `${configured.request.method ?? 'GET'} ${new URL(template).pathname}`;
	} catch {
		return null;
	}
}

const settingRows = [
	['Mode', (s) => s?.mode],
	['Anchor', (s) => (s?.mode === 'anchored' ? `${s.anchorTime} ${s.anchorTimezone}` : null)],
	[
		'Anchor window',
		(s) => (s?.mode === 'anchored' ? (s.anchorWindow ? duration(s.anchorWindow) : '0 — at the rate ceiling') : null),
	],
	['Sweep interval', (s) => (s?.mode === 'interval' && s.sweepInterval ? duration(s.sweepInterval) : null)],
	['Cycle target', (s) => (s?.mode === 'continuous' && s.cycleTarget ? duration(s.cycleTarget) : null)],
	['Rate ceiling', (s) => (s?.ratePerSecond ? `${s.ratePerSecond}/s` : null)],
	['Concurrency', (s) => s?.concurrency],
	['Scope', (s) => s?.scope],
	['Re-probe after', (s) => (s?.reprobeAfter ? duration(s.reprobeAfter) : null)],
	[
		'Trigger queue',
		(s) => (s?.trigger?.maxPending ? `max ${num(s.trigger.maxPending)} · drains ${s.trigger.ratePerSecond}/s` : null),
	],
	['Triggers per sweep', (s) => (s?.maxTriggersPerSweep ? num(s.maxTriggersPerSweep) : null)],
	[
		'Canary',
		(s) =>
			s?.canary?.interval
				? `every ${duration(s.canary.interval)} · ${num(s.canary.count)} URLs · trips at ${Math.round((s.canary.threshold ?? 0) * 100)}%`
				: null,
	],
];

/**
 * What the probe runs on: schedule, pacing, and the rules — per node when nodes disagree, once when
 * they agree. A node older than v0.91.0 reports no settings; its column is the config endpoint's
 * answer and says so.
 */
function configCard(status, model) {
	const { descs } = model;
	const columns = descs.map((d) => ({ d, s: d.settings }));
	const valuesOf = (read) => columns.map(({ s }) => (s ? (read(s) ?? null) : null));
	const rows = settingRows
		.map(([label, read]) => [label, valuesOf(read)])
		.filter(([, values]) => values.some((value) => value !== null && value !== undefined));
	const split = (values) => new Set(values.map((value) => JSON.stringify(value ?? null))).size > 1;
	const anySplit = rows.some(([, values]) => split(values));
	const fromConfig = descs.filter((d) => d.settings?.source === 'config');

	const head = [
		['Schedule', sweepCadence(status.sweep) ?? 'not armed'],
		['Run mode', status.dryRun ? pill('dry run — detects, triggers nothing', 'warn') : pill('live', 'ok')],
	];
	const body = [];
	if (anySplit) {
		body.push(kv(head));
		body.push(
			table(
				['setting', ...descs.map((d) => d.hostname)],
				rows.map(([label, values]) =>
					el('tr', null, [
						el('td', null, [el('span', { text: label }), split(values) ? pill('differs', 'bad') : null]),
						...values.map((value) => el('td', { cls: 'mono', text: value === null ? '—' : String(value) })),
					])
				)
			)
		);
	} else {
		// One list when the nodes agree — the common case, and the one that should read at a glance.
		body.push(
			kv([...head, ...rows.map(([label, values]) => [label, mono(String(values.find((value) => value !== null)))])])
		);
	}
	if (fromConfig.length) {
		body.push(
			muted(
				`Settings for ${nodeList(fromConfig)} are read from the config endpoint — their plugin (< 0.91.0) does not ` +
					'report what it is running with.'
			)
		);
	}

	const rules = status.rules ?? [];
	if (rules.length) {
		body.push(
			table(
				['rule', 'path pattern', 'probes', 'fingerprint', 'mapped page fields', 'invalidate on a canary trip'],
				rules.map((rule) =>
					el('tr', null, [
						el('td', { cls: 'mono', text: rule.label ?? '—' }),
						el('td', { cls: 'mono truncate', text: rule.pathPattern ?? '—', title: rule.pathPattern ?? '' }),
						el('td', null, [
							rule.source === 'document'
								? pill('document JSON-LD', '')
								: rule.endpoint
									? mono(`${rule.endpoint.method} ${rule.endpoint.path}`)
									: configuredEndpoint(rule, model)
										? el('span', null, [
												mono(configuredEndpoint(rule, model)),
												el('div', { cls: 'sub muted', text: 'from config (plugin < 0.91.0)' }),
											])
										: pill(rule.source ?? 'request', 'info'),
							Array.isArray(rule.extract) && rule.extract.length
								? el('div', { cls: 'sub muted', text: `${rule.extract.length} extract paths` })
								: null,
						]),
						el('td', null, [rule.fingerprint ? mono(rule.fingerprint) : NA('plugin < 0.91.0')]),
						el('td', null, [
							rule.pageFields?.length ? mono(rule.pageFields.join(', ')) : muted('—'),
							rule.ignoreChanges?.length
								? el('div', { cls: 'sub muted', text: `ignores slots ${rule.ignoreChanges.join(', ')}` })
								: null,
						]),
						el('td', null, [rule.invalidateScope ? mono(rule.invalidateScope) : muted('detection only')]),
					])
				)
			)
		);
	}
	if (status.rulesDiverge) {
		body.push(note('bad', ['The nodes do not agree on the rule list; the rules above are one node’s.']));
	}
	return card('Configuration — what the probe runs on', { body });
}

// ---------------------------------------------------------------- the measured drift

/**
 * The finished passes' trend, from the analytics window — labelled PER FINISHED PASS on the card,
 * because it is: a `probe_*` series is emitted once, when a pass ENDS, so a nine-hour pass is one
 * bar at its end and nothing before it. These charts can say what passes found; they cannot say
 * whether the probe is running, which is what "Probe now" above is for.
 *
 * The change rate the probe is actually measuring.
 *
 * THE DENOMINATOR IS `probed`, NOT the corpus. A pass probes what its rules matched among the
 * rows this node owns, and `changed / probed` is the fraction of THOSE that moved — the number a
 * dry-run week exists to produce and the one that argues for (or against) raising a route's
 * render interval. `seeded` is excluded from nothing and included in `probed`: a first
 * observation had nothing to compare against, so a pass that is mostly seeding reports a low
 * change rate that means "no baseline yet", which is why it gets its own tile.
 */
function drift(ctx) {
	const data = ctx.data.analytics;
	const range = rangePicker(RANGES, ctx.data.rangeMs, (ms) => {
		ctx.data.rangeMs = ms;
		ctx.reload();
	});
	if (!data)
		return card('Finished passes', {
			head: [spacer(), range],
			body: [note('bad', ['The analytics window did not load.'])],
		});
	if (data.available === false) {
		return card('Finished passes', {
			head: [spacer(), range],
			body: [
				note('', [
					'Analytics is not available on this node, so the finished-pass trend cannot be read. "Probe now" and ',
					'the pass cards above come from the probe’s own state and are unaffected.',
				]),
			],
		});
	}

	const combos = pick(data, 'prerender_ops', (s) => typeof s.path === 'string' && s.path.startsWith('probe_'));
	if (windowEmpty(data) || !combos.length) {
		return card(`Finished passes — ${scopeLabel(data)}`, {
			head: [pill('per finished pass — not live', ''), spacer(), range],
			body: [
				emptyNote('change-probe', data),
				note('', [
					'These counters are emitted once per FINISHED pass. With a sweep every few hours and a window ',
					'of ',
					duration(ctx.data.rangeMs),
					', an empty panel can simply mean no pass has completed inside it — widen the range before ',
					'reading it as "nothing is probing".',
				]),
			],
			foot: [scanFooter(data)],
		});
	}

	// `total` is COUNTER-ONLY in these rows and `count` is the number of PASSES, not of probes —
	// the recorded value is what a pass counted, so the sum is Σ(mean × count).
	const totalOf = (series) => sumValues(combos.filter((s) => s.path === `probe_${series}`));
	const probed = totalOf('probed');
	const changed = totalOf('changed');
	const failed = totalOf('failed');
	const seeded = totalOf('seeded');
	const rebaselined = totalOf('rebaselined');
	const deferred = totalOf('deferred');
	const triggered = totalOf('triggered');
	const trips = totalOf('canary_trip');
	const invalidated = totalOf('invalidated');
	const fresh = totalOf('fresh');
	const throttled = totalOf('throttled');
	const unreadable = totalOf('unreadable');
	const pageMismatch = totalOf('page_mismatch');
	const cycleBehind = totalOf('cycle_behind');
	// A per-pass HIGH-WATER gauge, not a counter: summing it answers nothing. The deepest reading any
	// pass in the window recorded is the question (was the queue close to trigger.maxPending?).
	const queuePeak = Math.max(
		0,
		...combos
			.filter((s) => s.path === 'probe_trigger_queue_depth')
			.flatMap((s) => [...(s.p95s ?? []), ...(s.means ?? []), s.p95, s.mean])
			.filter((v) => typeof v === 'number' && Number.isFinite(v))
	);
	const queueSeries = 'trigger_queue_depth';
	const hasQueue = combos.some((s) => s.path === `probe_${queueSeries}`);
	// What a mismatch MEANS depends on the run mode, which is the status's fact and not the
	// window's: armed, each one was hard-expired the moment it was seen (a detection rate); dry,
	// nothing expires them, so the same disagreement is re-reported every pass (a standing gauge).
	// The merged status is dry only when EVERY node is, which is exactly the reading wanted here —
	// one live node means mismatches are being acted on somewhere.
	const mismatchesStanding = pageMismatch > 0 && ctx.data.status?.dryRun !== false;
	const continuous = ctx.data.status?.mode === 'continuous';

	// Compared = probes that had a baseline to compare against. Seeds and failures had none, so
	// including them in the denominator understates the drift rate by exactly the seeding backlog.
	// RE-BASELINED rows had one and it was not comparable — it was taken under a different rule —
	// so the plugin stores the new observation and compares nothing. They belong on the same side
	// as seeds. Leaving them in is not a rounding error: the pass right after a rule edit can be
	// almost entirely re-baselined, and the card would read "0% changed" over a population that was
	// never compared at all, which is indistinguishable from a completely static origin.
	const compared = Math.max(0, probed - seeded - rebaselined - failed);
	// Through `ratioOf` like every other ÷ figure in this console, and NOT because these two can be
	// null — `sumValues` reduces from 0 over finite products, so they are always numbers. It is that
	// the guard belongs at the site by convention rather than by an argument a reader has to
	// reconstruct from the helper's contract. Compared explicitly, so nothing rests on `null > 0.5`.
	const failureShare = ratioOf(failed, probed);
	const failing = failureShare !== null && failureShare > FAILURE_ALARM;
	// Against `fresh + probed` — the rows the pass CONSIDERED — because that is the denominator the
	// question has: of everything a pass was willing to look at, how much did it decline to probe.
	const freshShare = ratioOf(fresh, fresh + probed);
	const skipping = freshShare !== null && freshShare > FRESH_NOTICE;

	const bucketCount = data.bucketCount ?? 0;
	const { keys, stacks } = stackBy(
		combos.filter((s) => OUTCOME_LABEL[s.path]),
		'path',
		bucketCount,
		{ values: true }
	);

	return card(`Finished passes — ${scopeLabel(data)}, last ${duration(data.rangeMs ?? ctx.data.rangeMs)}`, {
		head: [
			pill('per finished pass — not live', ''),
			failing ? pill('probe failures dominate', 'bad') : null,
			throttled > 0 ? pill('origin pushing back', 'bad') : null,
			unreadable > 0 ? pill('unreadable rows', 'bad') : null,
			// Only when nothing is expiring them: armed, a mismatch is the feature working and the
			// tile suffices; standing, wrong pages are being served and re-found every pass.
			mismatchesStanding ? pill('pages disagree with the origin', 'warn') : null,
			spacer(),
			legend(keys.map((key) => ({ label: OUTCOME_LABEL[key], color: OUTCOME_COLOR[key] }))),
			range,
		],
		body: [
			failing &&
				note('bad', [
					`${pct(failed, probed)} of probes failed. That is the shape a replatformed origin makes: the ` +
						'endpoint or the markup a rule was written against has changed, every failed probe leaves the ' +
						'stored signature untouched, and those pages are silently back on interval-only freshness. A ' +
						'failure never triggers and never re-baselines, so nothing else in this console will move.',
				]),
			// THE ONE ALARM ON THIS PAGE THAT IS NOT ABOUT THE PROBE. Everything else here reports a
			// probe that has stopped telling the truth; this reports a probe that is hurting someone
			// else. Probe endpoints are typically uncached, so every probe is backend work for
			// whoever runs the origin, and `ratePerSecond` was agreed with them for a HEALTHY origin.
			// Pushback means that agreement no longer fits what the origin can take — and because the
			// sweep answers by halving its own rate, the probe covers less of the corpus per pass
			// while every other number on this card keeps its shape. Nothing else surfaces it.
			throttled > 0 &&
				note('bad', [
					`The origin pushed back on ${fmtCount(throttled)} probe${throttled === 1 ? '' : 's'} ` +
						`(${pct(throttled, failed)} of all probe failures). Those are 429/502/503/504 responses and ` +
						'connect or read timeouts — the origin asking for room, not a rule that no longer fits. The ' +
						'sweep halves its pacing rate for each batch that contains one and recovers by halves, so a ' +
						'sustained count means passes are taking longer than ',
					el('code', { text: 'sweepInterval' }),
					' implies and the corpus is being re-probed more slowly than the settings say. Take it to ' +
						'whoever runs the origin before raising ',
					el('code', { text: 'changeProbe.ratePerSecond' }),
					'.',
				]),
			// The application layer cannot address these rows, so no amount of console work reaches
			// them: this is a database-layer escalation and the note says so rather than implying a
			// setting would help.
			unreadable > 0 &&
				note('bad', [
					`${fmtCount(unreadable)} registry row${unreadable === 1 ? '' : 's'} could not be decoded, and the ` +
						'walk stepped over them. Those targets are never probed, never re-rendered on change, and ' +
						'appear in no other count on this page. Stepping over them is the fix — the walk used to ' +
						'END at the first one, silently, reporting a finished pass that had covered only the ' +
						'keyspace before it — so the pass itself is sound. But a row the application layer cannot ' +
						'address is a storage-layer fault: it belongs with the database team, not with a setting ' +
						'here.',
				]),
			// THE CLASS THE SIGNATURE COMPARISON CANNOT SEE. Everything else on this card asks "did
			// the origin change since the last look", which is structurally blind to a value that
			// changed and changed BACK between two passes — and when a render landed inside that
			// window, the cached page keeps the transient value (an out-of-stock claim for something
			// the origin sells, a sale price that ended). pageCheck (plugin v0.58.0) compares the
			// origin against what the PAGE claims, so these are wrong pages found, not changes seen.
			pageMismatch > 0 &&
				note(mismatchesStanding ? 'warn' : '', [
					`${fmtCount(pageMismatch)} probe${pageMismatch === 1 ? '' : 's'} found the cached page disagreeing ` +
						'with the origin on a field it claims — a transient value the render captured and the ' +
						'signature comparison could never see, because the origin itself never looked changed. ',
					mismatchesStanding
						? 'In dry run nothing expires them, so the same disagreement is re-reported every pass: read ' +
							'this as a standing count of wrong pages being served, not a rate.'
						: 'Each one was hard-expired the moment it was seen — bots get origin content until the ' +
							're-render lands — so read this as a detection rate.',
				]),
			skipping &&
				note('warn', [
					`${pct(fresh, fresh + probed)} of the rows these passes considered were skipped because a ` +
						'stored baseline was still fresh. Right after a restart that is ',
					el('code', { text: 'reprobeAfter' }),
					' doing its job — the interrupted pass had already covered that ground. Sustained, it means ',
					el('code', { text: 'reprobeAfter' }),
					' sits too close to ',
					el('code', { text: 'sweepInterval' }),
					': a URL probed late in one pass is skipped by the next, so its real cadence is two sweep ' +
						'intervals and nothing else here shows it.',
				]),
			el('div', { cls: 'stats' }, [
				stat('Probes', fmtCount(probed), 'attempts across every finished pass'),
				stat('Changed', pct(changed, compared), `${fmtCount(changed)} of ${fmtCount(compared)} compared`),
				// Overlays the outcome buckets — a mismatched row is also inside Changed or the
				// unchanged remainder — so the sub-label names the relationship instead of a share.
				stat('Page mismatch', fmtCount(pageMismatch), 'cached page ≠ origin — overlays the buckets', {
					warn: mismatchesStanding,
				}),
				stat(
					'Triggered',
					fmtCount(triggered),
					deferred ? `${fmtCount(deferred)} deferred past the cap` : 'per-URL re-renders filed'
				),
				stat('Seeded', fmtCount(seeded), 'first observation — nothing to compare yet'),
				stat('Failed', pct(failed, probed), `${fmtCount(failed)} of ${fmtCount(probed)}`, { warn: failing }),
				// Not inside `probed`: a skipped URL was never attempted. The sub-label gives the
				// denominator explicitly so the tile cannot be read as a share of the probes.
				stat('Skipped as fresh', fmtCount(fresh), `of ${fmtCount(fresh + probed)} rows considered`, {
					warn: skipping,
				}),
				// Inside `failed`, and the sub-label says so — the two tiles are not additive.
				stat('Throttled', fmtCount(throttled), 'origin pushback — inside Failed', { warn: throttled > 0 }),
				// CONTINUOUS MODE ONLY, and hidden otherwise rather than shown as a permanent zero:
				// in interval mode no cycle target exists, so a zero here would read as "meeting the
				// target" when there is no target to meet. This is the mode's whole accountability
				// signal — the explicit replacement for a pass that used to overrun and be skipped
				// with nothing anywhere saying so.
				continuous
					? stat('Cycle behind', fmtCount(cycleBehind), 'batches that wanted more than the rate ceiling', {
							warn: cycleBehind > 0,
						})
					: null,
				stat('Canary trips', fmtCount(trips), `${fmtCount(invalidated)} recorded an invalidation`),
				hasQueue ? stat('Trigger queue peak', fmtCount(queuePeak), 'deepest a finished pass recorded') : null,
			]),
			keys.length
				? stackedBars(data, keys, stacks, (key) => OUTCOME_COLOR[key] ?? '#8a93a6', { format: fmtCount })
				: null,
			trips > invalidated &&
				note('warn', [
					`${fmtCount(trips - invalidated)} canary trip${trips - invalidated === 1 ? '' : 's'} recorded no ` +
						'invalidation. That is a dry run, a scope still inside its holdoff, or a rule whose ' +
						'invalidateScope names no configured route — the plugin log line says which of the three.',
				]),
			el('p', { cls: 'muted chart-note' }, [
				'NOT LIVE: every series here is emitted when a pass ENDS, so a pass that is running now is in none of ',
				'these numbers — a nine-hour pass appears as one bar at its end. ',
				'One emit per finished pass, sweep and canary alike, so the bars are passes and not probes — a tall ',
				'bar is a pass that landed in that bucket, not a busier minute. These are series side by side and ',
				'NOT a partition: “Probes” is the total the outcomes divide up, “Throttled” is the slice of ',
				'“Failed” the origin caused, “Page mismatch” overlays the outcome buckets (a mismatched row is ',
				'also inside “Changed” or the unchanged remainder), and “Skipped” sits outside “Probes” entirely ',
				'because those rows were never attempted. “Changed” is measured against the probes that HAD a ',
				'baseline; seeds, re-baselined rows and failures are excluded from that denominator because none ',
				'of them compared anything. “Re-baselined” is a row whose stored baseline was taken under a ',
				'DIFFERENT rule — a rule edit, not a content change — so the plugin stored the new observation ',
				'and compared nothing; expect one pass of them after any rule edit, and read a steady count as a ',
				'rule that keeps changing. “Page mismatch” stays at zero unless a rule sets pageCheck AND the render fleet posts ',
				'its pages’ offers (browser 1.20.0+) — enabled against an older fleet it records nothing, and the ',
				'plugin log says so hourly.',
			]),
		],
		foot: [scanFooter(data)],
	});
}

/** Per-rule canary verdicts, normalized over the node and cluster payload shapes. */
function perRuleRows(status) {
	const last = status.canary?.lastRun;
	const hostname = status.node ?? 'this node';
	return (last?.perRule ?? []).map((entry) => ({
		...entry,
		trippedOn: entry.trippedOn ?? (entry.tripped ? [hostname] : []),
		actions: entry.actions ?? (entry.action ? [{ hostname, ...entry.action }] : []),
		emptyCohortOn: entry.emptyCohortOn ?? (entry.skipped ? [hostname] : []),
	}));
}

/** How an action's refusal reads to someone who has to decide whether it mattered. */
const ACTION_REASON = {
	'dry-run': ['dry run — nothing invalidated', ''],
	'no-scope': ['no invalidateScope — detection only', ''],
	'holdoff': ['inside canary.holdoff — deliberately not re-stamped', ''],
	'unresolvable-scope': ['invalidateScope names no configured route — NOTHING was invalidated', 'bad'],
	'invalidation-disabled': ['invalidation.enabled is false — NOTHING was invalidated', 'bad'],
};

function canaryCard(ctx, status, model) {
	const canary = status.canary ?? {};
	const last = canary.lastRun;
	const rows = perRuleRows(status);
	const body = [];

	if (canary.unrunNodes?.length) {
		body.push(note('warn', [`No canary pass has finished on ${canary.unrunNodes.join(', ')} since startup.`]));
	}
	if (last?.error) body.push(note('bad', [`Last canary pass failed: ${last.error}`]));

	const empties = rows.filter((row) => row.emptyCohortOn.length);
	if (empties.length) {
		body.push(
			note('warn', [
				`No cohort yet for ${empties.map((row) => row.rule).join(', ')}. A cohort is built by the first sweep ` +
					'(or a cheaper key-order sample right after a restart), so an empty one means the mass-change ' +
					'detector is dark for that rule — the sweep still catches the change, hours later.',
			])
		);
	}

	if (rows.length) {
		body.push(
			table(
				[
					'rule',
					{ text: 'cohort', right: true },
					{ text: 'compared', right: true },
					{ text: 'changed', right: true },
					'verdict',
					'action',
				],
				rows.map((row) => {
					const tripped = row.trippedOn.length > 0;
					const acted = row.actions.filter((action) => action.acted);
					const refused = row.actions.filter((action) => !action.acted);
					return el('tr', null, [
						el('td', { cls: 'mono', text: row.rule ?? '—' }),
						el('td', { cls: 'right mono', text: num(row.cohort) }),
						el('td', { cls: 'right mono', text: num(row.compared) }),
						el('td', { cls: 'right' }, [
							el('span', {
								cls: tripped ? 'pill warn' : 'mono',
								text: row.fraction === null || row.fraction === undefined ? '—' : pct(row.changed, row.compared),
								title: `${num(row.changed)} changed of ${num(row.compared)} compared`,
							}),
						]),
						el('td', null, [
							tripped
								? pill(`tripped on ${row.trippedOn.join(', ')}`, 'warn')
								: row.compared
									? pill('below threshold', 'ok')
									: muted('nothing compared'),
						]),
						el('td', null, [
							acted.length ? pill(`invalidated ${acted[0].scope}`, 'ok') : null,
							...refused.map((action) => {
								const [text, kind] = ACTION_REASON[action.reason] ?? [action.reason ?? 'not acted', ''];
								return pill(text, kind);
							}),
							!row.actions.length && muted('—'),
						]),
					]);
				})
			)
		);
	} else {
		body.push(muted('No canary pass has finished since startup.'));
	}

	const cohortTotal = Object.values(canary.cohortSizes ?? {}).reduce((acc, size) => acc + (Number(size) || 0), 0);

	return card('Canary', {
		head: [
			canary.armedInterval ? pill(`every ${duration(canary.armedInterval)}`, 'ok') : pill('disabled', ''),
			canary.running && pill('running now', 'info'),
			last?.finishedAt && muted(`last pass ${ago(last.finishedAt)}`),
			// The soonest any node's canary fires next (plugin v0.91.0).
			canary.nextRunAt ? muted(`next ${fmtWhen(canary.nextRunAt, model.descs[0]?.now ?? Date.now())}`) : null,
			spacer(),
			muted(cohortTotal ? `${num(cohortTotal)} URLs under watch` : ''),
		],
		body,
		foot: [
			muted(
				'A trip is a threshold crossed against ONE node’s cohort, so the verdict names the nodes that ' +
					'crossed it rather than folding four independent judgements into one. The response is a bulk ' +
					'invalidation, not thousands of re-renders: pre-change snapshots stop serving at once (bots get ' +
					'origin content, correct by definition) while the fleet refills on its own cadence. '
			),
			status.dryRun
				? muted('In dry run a trip is logged and nothing is invalidated — the log line says “WOULD TRIP”.')
				: null,
			el('span', null, [' ', link('Invalidations →', () => ctx.go('invalidations'))]),
		],
	});
}

// ---------------------------------------------------------------- pacing

/**
 * WHAT IS ACTUALLY LIMITING THE SWEEP — the panel that answers a question the numbers above
 * cannot.
 *
 * A pass is paced by `wait = window - elapsed`, where `window = concurrency / ratePerSecond`. When
 * a batch's origin latency exceeds that window the wait computes to zero and never fires, so real
 * throughput is `min(concurrency / latency, ratePerSecond)` — and the two terms fail in opposite
 * directions with identical symptoms. A slice covered more slowly than expected looks the same
 * whether the rate ceiling is holding it back or the origin's latency is, and the fixes are
 * unrelated: one is a conversation with whoever runs the origin, the other is a local concurrency
 * change that does not touch the agreed peak rate at all.
 *
 * Observed throughput settles it. If it sits at the ceiling, the ceiling is binding. If it sits
 * well under the ceiling with no origin pushback, then `ratePerSecond` IS NEVER REACHED — it is
 * an inert number, and the real governor is concurrency against per-probe latency. That case is
 * invisible everywhere else on this page: every counter looks healthy, the pass simply takes
 * longer than the arithmetic on the settings card predicts, and the operator tunes the one knob
 * that cannot move it.
 *
 * PER NODE, AND ONLY PER NODE. A rate is a property of one node's pass. Merging four nodes'
 * counters over four different pass durations produces a number with no referent, so under
 * cluster scope this refuses and says to pick a node — the same discipline the run buttons above
 * already follow.
 */
function capacityCard(ctx, status, clusterScope) {
	const last = status.sweep?.lastRun;
	if (!last || !last.startedAt || !last.finishedAt) return null;

	const options = optionIndex(configState(ctx).payload);
	const numberAt = (path) => {
		const value = Number(options.get(path)?.effective);
		return Number.isFinite(value) && value > 0 ? value : null;
	};
	const ceiling = numberAt('changeProbe.ratePerSecond');
	const concurrency = numberAt('changeProbe.concurrency');
	if (!ceiling || !concurrency) return null;

	if (clusterScope) {
		return card('Pacing and capacity', {
			body: [
				note('', [
					'A probe rate is one node’s property — its own slice, its own pass duration, its own view of ' +
						'origin latency. Summing four of them would produce a number that describes no node. ' +
						'Switch to a node to see what is limiting its sweep.',
				]),
			],
		});
	}

	const seconds = (new Date(last.finishedAt).getTime() - new Date(last.startedAt).getTime()) / 1000;
	if (!(seconds > 0) || !(last.probed > 0)) return null;

	const observed = last.probed / seconds;
	// Below this share of the ceiling the gap is real rather than rounding. A pass that ends while
	// still backed off, or that saw pushback at all, is explained by the origin governor instead —
	// low throughput there is the backoff working, not a latency ceiling.
	const pushedBack = (last.throttled ?? 0) > 0 || (last.throttleLevel ?? 1) > 1;
	const ceilingBinding = observed >= ceiling * 0.9;
	// Only meaningful when concurrency is the binding term; derived by inverting
	// `throughput = concurrency / latency`.
	const latencyMs = Math.round((concurrency / observed) * 1000);

	const rows = [
		['Observed throughput', pill(`${observed.toFixed(1)}/s`, ceilingBinding ? 'ok' : '')],
		['Configured ceiling', mono(`${num(ceiling)}/s`)],
		['Concurrency', mono(num(concurrency))],
	];

	let verdict = null;
	if (pushedBack) {
		verdict = note('warn', [
			'The origin pushed back during this pass, so its throughput is the backoff doing its job rather ' +
				'than a capacity ceiling. Read this again after a pass that ends clean.',
		]);
	} else if (ceilingBinding) {
		verdict = note('', [
			'The sweep is running at its configured ceiling, so ',
			el('code', { text: 'ratePerSecond' }),
			' is what limits it. Covering the slice faster means raising that number, which is a conversation ' +
				'with whoever runs the origin — not a local change.',
		]);
	} else {
		rows.push(['Implied per-probe latency', mono(`~${num(latencyMs)}ms`)]);
		rows.push([
			'Capacity at this concurrency',
			pill(`${observed.toFixed(1)}/s — below the ${num(ceiling)}/s ceiling`, 'warn'),
		]);
		verdict = note('warn', [
			`This node tops out at ${observed.toFixed(1)}/s, well under its ${num(ceiling)}/s ceiling, with no origin `,
			'pushback to explain it — so ',
			el('code', { text: 'ratePerSecond' }),
			' is never actually reached and raising it would change nothing. Throughput here is ',
			el('code', { text: 'concurrency' }),
			` ÷ latency: ${num(concurrency)} in flight against ~${num(latencyMs)}ms per probe. Raising `,
			el('code', { text: 'concurrency' }),
			' is the lever, and it does not raise the sustained peak the origin agreed to — that stays capped ',
			'at the ceiling.',
		]);
	}

	// In continuous mode there is a required rate to compare against, which turns the diagnosis
	// above into an answer: reachable, or reachable at what concurrency.
	const target = status.sweep?.cycleTarget;
	const slice = status.sweep?.sliceSize;
	if (target > 0 && typeof slice === 'number' && slice > 0) {
		const needed = slice / (target / 1000);
		const reachable = needed <= Math.min(ceiling, ceilingBinding ? ceiling : observed);
		rows.push(['Rate the cycle target needs', pill(`${needed.toFixed(1)}/s`, reachable ? 'ok' : 'bad')]);
		if (!reachable && !pushedBack && !ceilingBinding) {
			// The concurrency that would clear it, at the latency just derived.
			const wanted = Math.ceil((needed * latencyMs) / 1000);
			rows.push(['Concurrency that would reach it', pill(`${num(wanted)} (from ${num(concurrency)})`, 'warn')]);
		}
	}

	return card('Pacing and capacity', {
		head: [muted('this node’s last finished sweep')],
		body: [kv(rows.filter(Boolean)), verdict],
	});
}

function settings(ctx) {
	return el('div', null, [
		el('div', { cls: 'view-head', style: { marginTop: '20px' } }, [
			el('span', { cls: 'eyebrow', text: 'Settings' }),
			spacer(),
			muted('staged in this browser until you preview and apply'),
		]),
		settingsCard(ctx, {
			title: 'Change probe',
			prefix: 'changeProbe',
			description:
				'What is probed, how fast, and whether a detected change is allowed to act. ratePerSecond is the ' +
				'origin-protection knob — probe endpoints are typically uncached, so every probe is backend work ' +
				'for whoever runs the origin, and it also sizes the sweep (a 200k-URL slice at 10/s is about 5.6 ' +
				'hours per pass). Leave dryRun on until the change rate above has been watched for a while: ' +
				'signatures are written either way, so a dry-run week converges on the true rate rather than ' +
				're-reporting the same delta. backoffMax and abortAfterDistress are what the sweep does when the ' +
				'origin pushes back at that rate anyway, and reprobeAfter is what makes a restarted sweep resume ' +
				'instead of re-probing ground it had already covered — keep it comfortably below sweepInterval, ' +
				'or passes start skipping work that is genuinely due. mode picks how the sweep is scheduled: ' +
				'"interval" fires a pass every sweepInterval and silently skips one that overruns, so the ' +
				'sliceSize/rate arithmetic is yours to keep re-checking; "continuous" never stops walking and ' +
				'paces itself to cycleTarget instead, reporting an unreachable target rather than missing it ' +
				'quietly. load.* slows the sweep when THIS node is struggling rather than the origin — leave it ' +
				'off in interval mode, where a slowdown can push a pass past its window and lose it.',
		}),
	]);
}
