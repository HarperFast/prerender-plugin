/**
 * Change probe: whether re-rendering is being driven by what the origin actually says, and what
 * it is costing to find out.
 *
 * WHY IT IS ITS OWN VIEW. Every other freshness surface in this console measures a page against a
 * CADENCE — the interval someone guessed and the fleet then keeps. The probe replaces the guess:
 * it asks a cheap endpoint (or the page's own JSON-LD offers) whether the fields bots care about
 * moved, and files a re-render only when they did. That makes it the one subsystem whose health
 * question is not "are we keeping up" but "is what we are detecting real" — a probe that quietly
 * stopped extracting anything reports zero changes, triggers nothing, and looks exactly like a
 * catalogue that is not moving. So the failure share sits beside the change rate on the same card,
 * because one is only readable next to the other.
 *
 * TWO CADENCES, AND THE PANELS KEEP THEM APART. The SWEEP walks this node's whole owned slice on
 * a long interval and catches per-URL drift; the CANARY probes a small fixed cohort every few
 * minutes and exists for the event a sweep structurally cannot see in time — a promotion that
 * reprices most of a catalogue at once. Their numbers are never added together: a sweep pass and a
 * canary pass have different denominators, different populations, and different consequences (a
 * per-URL revalidate versus one bulk invalidation row).
 *
 * EVERYTHING HERE IS OWNER-SCOPED. A node probes only the URLs it owns, so a cluster figure is
 * the sum of every node's own slice and a node that has not swept contributes zero to it — which
 * looks precisely like a node that swept and found nothing. The merge names the unswept nodes and
 * this view prints them, for the same reason the orphan sweep does.
 */

import {
	ago,
	card,
	duration,
	el,
	ICONS,
	kv,
	link,
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
 * How the sweep is scheduled, in one phrase.
 *
 * `armedInterval` is a number in interval mode and the literal 'continuous' in continuous mode —
 * the plugin tags the mode into that field precisely so a mode switch re-arms — so every reader
 * of it has to branch. Formatting the string through `duration()` would print nonsense, which is
 * the failure this helper exists to make impossible rather than to remember not to cause.
 *
 * Continuous mode reports the TARGET and, when a cycle has measured it, the slice being paced
 * against. A missing slice is not a blank: it means no cycle has finished counting yet, which is
 * exactly when the pass runs flat out at the rate ceiling — worth saying, because "measuring" and
 * "behind" look identical from the outside otherwise.
 */
const sweepCadence = (sweep) => {
	if (!sweep?.armedInterval) return null;
	if (sweep.armedInterval !== 'continuous') return `every ${duration(sweep.armedInterval)}`;
	const target = sweep.cycleTarget ? `target ${duration(sweep.cycleTarget)}` : 'no target';
	// `typeof`, not truthiness: ZERO IS A MEASURED ANSWER — a node that owns nothing, or whose
	// rows no rule matches — and rendering it as "measuring" would describe a cycle that has
	// finished counting as one that has not started.
	const slice = typeof sweep.sliceSize === 'number' ? `${num(sweep.sliceSize)} rows` : 'measuring the slice';
	return `continuous · ${target} · ${slice}`;
};

/**
 * Nodes whose probe state row could not be read (plugin v0.62.0's `stateAvailable: false`),
 * normalized over the node and cluster payload shapes. Empty for an older plugin, which has no
 * such row and no such field.
 */
const stateUnavailableOn = (status) =>
	status.stateUnavailableOn ?? (status.stateAvailable === false ? [status.node ?? 'this node'] : []);

/**
 * "sweep running", with how far it has got when the plugin says. `examinedApprox` is the pass's
 * heartbeat counter — rows walked so far, rounded to the yield interval — and it is the one number
 * that separates a sweep that is moving from one that merely claims to be. Summed across the
 * nodes running, because each walks its own disjoint slice.
 */
const sweepProgress = (status) => {
	// One object at node scope, a per-node list under the cluster merge.
	const progress = status.sweep?.progress;
	const list = Array.isArray(progress) ? progress : progress ? [progress] : [];
	const examined = list.reduce((acc, p) => acc + (Number.isFinite(p?.examinedApprox) ? p.examinedApprox : 0), 0);
	return examined > 0 ? ` · ~${num(examined)} rows examined` : '';
};
const sweepRunningLabel = (status) => `sweep running${sweepProgress(status)}`;

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
	const [statusRes, analyticsRes] = await Promise.all([
		ctx.get('change-probe'),
		ctx.get('analytics', { range: ctx.data.rangeMs }),
		loadConfig(ctx),
	]);
	ctx.data.status = statusRes.ok ? statusRes.body : null;
	ctx.data.analytics = analyticsRes.ok ? analyticsRes.body : null;
	ctx.data.error = statusRes.ok ? null : (statusRes.body?.error ?? `Could not read probe status (${statusRes.status})`);
}

export function render(ctx) {
	const status = ctx.data.status;

	const head = el('div', { cls: 'view-head' }, [
		el('span', { cls: 'eyebrow', text: 'Change probe' }),
		spacer(),
		rangePicker(RANGES, ctx.data.rangeMs, (ms) => {
			ctx.data.rangeMs = ms;
			ctx.reload();
		}),
		el('button', { text: 'Refresh', disabled: ctx.busy, onclick: () => ctx.reload() }),
	]);

	// The settings ride along even when the status read failed: `changeProbe.enabled` is the
	// likeliest reason this page has nothing on it, and the card that flips it belongs on the
	// screen reporting the emptiness rather than a view away.
	const knobs = [settings(ctx), editTray(ctx)];

	if (!status) {
		return [head, el('div', { cls: 'note bad', text: ctx.data.error ?? 'No probe status.' }), ...knobs];
	}

	return [
		head,
		appliedNote(ctx),
		state(ctx, status),
		drift(ctx),
		sweepCard(ctx, status),
		capacityCard(ctx, status, isMerged(status)),
		canaryCard(ctx, status),
		nodeTable(status),
		...knobs,
	];
}

// ---------------------------------------------------------------- state & actions

/**
 * What is armed, what it is probing, and the two buttons that run a pass by hand.
 *
 * THE RUN MODE IS EXPLICIT because `dryRun` is the difference between measuring and acting. The
 * plugin defaults it ON and a POST that omits it inherits the configured value, so a button
 * labelled only "Run sweep" means different things on two deployments. The picker names which of
 * the two this click will be, and the pill beside it says what the config would do on its own —
 * the timers use that value, not this one.
 */
function state(ctx, status) {
	const clusterScope = isMerged(status);
	const forcedDryRun = ctx.data.runMode === 'dry';
	const run = (action) => ctx.run(() => ctx.post('change-probe', forcedDryRun ? { action, dryRun: true } : { action }));

	const rules = status.rules ?? [];
	const body = [];

	if (!status.enabled) {
		body.push(
			note('bad', [
				el('code', { text: 'changeProbe.enabled' }),
				status.disabledOn?.length
					? ` is false on ${status.disabledOn.join(', ')}. The URLs those nodes own are never probed, so ` +
						'their pages fall back to interval-only freshness while every number on this page keeps ' +
						'looking healthy — the counters below simply do not include them.'
					: ' is false. Nothing is probed and nothing here will move; the settings card below turns it on.',
			])
		);
	} else if (!rules.length) {
		body.push(
			note('warn', [
				'The probe is enabled and no ',
				el('code', { text: 'changeProbe.rules' }),
				' match anything, so no timer is armed. A rule names the path pattern to claim and where to read ' +
					'the fields that matter; without one there is nothing to compare.',
			])
		);
	}

	if (status.rulesDiverge) {
		body.push(
			note('bad', [
				'The nodes do not agree on the rule list — this is a deploy or an override that did not reach every ' +
					'node, and the rules shown are one node’s. ',
				link('Config →', () => ctx.go('config')),
			])
		);
	}

	// Plugin v0.62.0 publishes the probe's state to a node-local row so any worker can answer for
	// the node; before it, 15 of 16 workers answered "not running, never ran" — indistinguishable
	// from the probe being off. `stateAvailable: false` is the row failing to READ, and everything
	// this page says about that node's sweep and canary is then untrustworthy rather than
	// reassuring. Above the counters, because it changes what they mean.
	const stateUnavailable = stateUnavailableOn(status);
	if (stateUnavailable.length) {
		body.push(
			note('bad', [
				`The change-probe state row could not be read on ${stateUnavailable.join(', ')}. `,
				'Everything this page reports for ',
				stateUnavailable.length > 1 ? 'those nodes' : 'that node',
				' — running or not, last pass, armed cadence — is unknown, not idle: the sweep may well be running. ',
				'The node’s log says why the read failed (a coordination database problem, usually).',
			])
		);
	}

	body.push(
		kv([
			['Sweep', sweepCadence(status.sweep) ?? 'not armed'],
			[
				'Canary',
				status.canary?.armedInterval
					? `every ${duration(status.canary.armedInterval)}`
					: status.enabled
						? 'disabled (canary.interval is 0)'
						: 'not armed',
			],
			['Rules', num(rules.length)],
		])
	);

	if (rules.length) {
		body.push(
			table(
				['rule', 'path pattern', 'source', 'invalidate scope on a canary trip'],
				rules.map((rule) =>
					el('tr', null, [
						el('td', { cls: 'mono', text: rule.label ?? '—' }),
						el('td', { cls: 'mono truncate', text: rule.pathPattern ?? '—', title: rule.pathPattern ?? '' }),
						el('td', null, [pill(rule.source ?? 'document', rule.source === 'request' ? 'info' : '')]),
						el('td', null, [
							rule.invalidateScope ? el('span', { cls: 'mono', text: rule.invalidateScope }) : muted('detection only'),
						]),
					])
				)
			)
		);
	}

	body.push(
		el('p', { cls: 'muted chart-note' }, [
			status.ownerScopeNote ??
				'Probes only the URLs this node owns; every node sweeps its own slice. ' +
					'A probe is origin backend work — the rate cap is a promise to whoever runs it, per node, which ' +
					'is why a pass cannot be started for the whole cluster at once.',
		])
	);

	return card(`Probe state — ${scopeLabel(status)}`, {
		head: [
			status.enabled ? pill('enabled', 'ok') : pill('disabled', 'bad'),
			status.dryRun
				? pill('dry run — detects, triggers nothing', 'warn')
				: pill(
						status.liveOn?.length && status.liveOn.length < (status.byNode?.length ?? 0)
							? 'live on some nodes'
							: 'live',
						'ok'
					),
			status.sweep?.running && pill(sweepRunningLabel(status), 'info'),
			status.canary?.running && pill('canary running', 'info'),
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
				text: clusterScope ? 'Sweep (pick a node)' : status.sweep?.running ? 'Sweep running…' : 'Run sweep',
				disabled: ctx.busy || clusterScope || !status.enabled || !!status.sweep?.running,
				title: clusterScope
					? 'A pass covers the URLs one node owns, at that node’s probe rate. Switch to a node to run it there.'
					: null,
				onclick: () => run('sweep'),
			}),
			el('button', {
				text: clusterScope ? 'Canary (pick a node)' : status.canary?.running ? 'Canary running…' : 'Run canary',
				disabled: ctx.busy || clusterScope || !status.enabled || !!status.canary?.running,
				title: clusterScope ? 'The cohort is built from the keys one node owns. Switch to a node.' : null,
				onclick: () => run('canary'),
			}),
		],
		body,
	});
}

// ---------------------------------------------------------------- the measured drift

/**
 * The change rate the probe is actually measuring, from the analytics window.
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
	if (!data) return card('Probe passes', { body: [note('bad', ['The analytics window did not load.'])] });
	if (data.available === false) {
		return card('Probe passes', {
			body: [
				note('', [
					'Analytics is not available on this node, so the pass counters cannot be read. The last-pass ',
					'numbers below come from the probe’s own in-memory state and are still current.',
				]),
			],
		});
	}

	const combos = pick(data, 'prerender_ops', (s) => typeof s.path === 'string' && s.path.startsWith('probe_'));
	if (windowEmpty(data) || !combos.length) {
		return card(`Probe passes — ${scopeLabel(data)}`, {
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
	const deferred = totalOf('deferred');
	const triggered = totalOf('triggered');
	const trips = totalOf('canary_trip');
	const invalidated = totalOf('invalidated');
	const fresh = totalOf('fresh');
	const throttled = totalOf('throttled');
	const unreadable = totalOf('unreadable');
	const pageMismatch = totalOf('page_mismatch');
	const cycleBehind = totalOf('cycle_behind');
	// What a mismatch MEANS depends on the run mode, which is the status's fact and not the
	// window's: armed, each one was hard-expired the moment it was seen (a detection rate); dry,
	// nothing expires them, so the same disagreement is re-reported every pass (a standing gauge).
	// The merged status is dry only when EVERY node is, which is exactly the reading wanted here —
	// one live node means mismatches are being acted on somewhere.
	const mismatchesStanding = pageMismatch > 0 && ctx.data.status?.dryRun !== false;
	const continuous = ctx.data.status?.mode === 'continuous';

	// Compared = probes that had a baseline to compare against. Seeds and failures had none, so
	// including them in the denominator understates the drift rate by exactly the seeding backlog.
	const compared = Math.max(0, probed - seeded - failed);
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

	return card(`Probe passes — ${scopeLabel(data)}, last ${duration(data.rangeMs ?? ctx.data.rangeMs)}`, {
		head: [
			failing ? pill('probe failures dominate', 'bad') : null,
			throttled > 0 ? pill('origin pushing back', 'bad') : null,
			unreadable > 0 ? pill('unreadable rows', 'bad') : null,
			// Only when nothing is expiring them: armed, a mismatch is the feature working and the
			// tile suffices; standing, wrong pages are being served and re-found every pass.
			mismatchesStanding ? pill('pages disagree with the origin', 'warn') : null,
			spacer(),
			legend(keys.map((key) => ({ label: OUTCOME_LABEL[key], color: OUTCOME_COLOR[key] }))),
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
				'One emit per finished pass, sweep and canary alike, so the bars are passes and not probes — a tall ',
				'bar is a pass that landed in that bucket, not a busier minute. These are series side by side and ',
				'NOT a partition: “Probes” is the total the outcomes divide up, “Throttled” is the slice of ',
				'“Failed” the origin caused, “Page mismatch” overlays the outcome buckets (a mismatched row is ',
				'also inside “Changed” or the unchanged remainder), and “Skipped” sits outside “Probes” entirely ',
				'because those rows were never attempted. “Changed” is measured against the probes that HAD a ',
				'baseline; seeds and failures are excluded from that denominator because neither compared ',
				'anything. “Page mismatch” stays at zero unless a rule sets pageCheck AND the render fleet posts ',
				'its pages’ offers (browser 1.20.0+) — enabled against an older fleet it records nothing, and the ',
				'plugin log says so hourly.',
			]),
		],
		foot: [scanFooter(data)],
	});
}

// ---------------------------------------------------------------- the two passes

function sweepCard(ctx, status) {
	const sweep = status.sweep ?? {};
	const last = sweep.lastRun;
	const body = [];

	if (sweep.unsweptNodes?.length) {
		body.push(
			note('warn', [
				`No sweep has finished on ${sweep.unsweptNodes.join(', ')} since startup — the URLs those nodes own ` +
					'are not represented in the counters below, so every figure here covers less of the corpus than ' +
					'it appears to.',
			])
		);
	}

	// The merge takes the FIRST error it finds across nodes, so an error and a full set of counters
	// can arrive together: three nodes swept and one threw. Treating the error as the whole answer
	// would drop the three good slices, and treating the counters as the whole answer would hide
	// that a quarter of the keyspace was not covered. Both are shown, and the error says so.
	const hasCounters = Number.isFinite(last?.probed);
	if (last?.error) {
		body.push(
			note('bad', [
				`Last sweep failed: ${last.error}`,
				hasCounters ? ' — the counters below cover only the passes that did finish.' : '',
			])
		);
	}
	// Above the counters, because it changes what they mean: this pass did not cover its slice, so
	// every figure in it is a partial count of a keyspace region and not a result for the corpus.
	if (last?.abortedOnDistress) {
		body.push(
			note('bad', [
				'This pass STOPPED EARLY because the origin refused ',
				el('code', { text: 'changeProbe.abortAfterDistress' }),
				' probes in a row — an origin that is down rather than busy. It covered only the part of the ' +
					'owned slice it had reached, so the counters below are a partial count and the rest of the ' +
					'slice keeps whatever baselines it had. The next scheduled pass is the retry and it starts ' +
					'clean; nothing needs restarting here. If it repeats, the origin is the thing to look at.',
			])
		);
	}

	if (hasCounters) {
		const compared = Math.max(0, (last.probed ?? 0) - (last.seeded ?? 0) - (last.failed ?? 0));
		body.push(
			kv([
				[
					last.nodes > 1 ? `Oldest of ${last.nodes} sweeps` : 'Last sweep',
					`${last.finishedAt ? ago(last.finishedAt) : 'unknown'}${last.dryRun ? ' (dry run — nothing triggered)' : ''}`,
				],
				['Rows examined', num(last.examined)],
				[last.nodes > 1 ? 'Owned across nodes' : 'Owned by this node', num(last.owned)],
				['Matched a rule', num(last.matched)],
				['Probed', num(last.probed)],
				[
					'Changed',
					`${num(last.changed)}${compared ? ` of ${num(compared)} compared (${pct(last.changed, compared)})` : ''}`,
				],
				// Overlays the signature buckets — a mismatch row is also inside Changed or the
				// unchanged remainder — so it joins no subtraction here. Only worth a row when there
				// were any; the run-mode pill at the top of the page says whether they were expired
				// on the spot or are still serving.
				last.pageMismatch ? ['Pages disagreeing with the origin', pill(num(last.pageMismatch), 'warn')] : null,
				['Re-renders filed', last.triggered ? pill(num(last.triggered), 'ok') : pill('0', '')],
				last.deferred ? ['Deferred past the trigger cap', pill(num(last.deferred), 'warn')] : null,
				['Failed probes', last.failed ? pill(num(last.failed), 'warn') : pill('0', 'ok')],
				// Inside "Failed probes" above, so it is only worth a row when there were any — and
				// then it is the row that matters, because it names the origin rather than the rule.
				last.throttled ? ['— of those, origin pushback', pill(num(last.throttled), 'bad')] : null,
				// The pass's END state, not its worst moment: the window halves back on every clean
				// batch, so a value above 1 here means the pass was STILL backed off when it finished.
				last.throttleLevel > 1
					? ['Pacing window at the end — origin', pill(`${num(last.throttleLevel)}× normal — still backed off`, 'bad')]
					: null,
				// The LOCAL governor, reported apart from the origin one on purpose. A pass crawling
				// because the origin is shedding load and a pass crawling because this node is losing
				// its event loop to the serve path share a symptom and nothing else, and the fixes
				// point in opposite directions — one is a conversation with the origin's operator,
				// the other is this node's own capacity.
				last.loadThrottleLevel > 1
					? [
							'Pacing window at the end — local load',
							pill(
								`${num(last.loadThrottleLevel)}× normal${
									typeof last.loopLagMs === 'number' ? ` — event loop ${Math.round(last.loopLagMs)}ms behind` : ''
								}`,
								'warn'
							),
						]
					: null,
				// Skipped rows are not in `probed`, so without this row the two numbers do not close
				// and the pass reads as having found less to do than it did.
				last.fresh ? ['Skipped — baseline still fresh', pill(num(last.fresh), '')] : null,
				last.unreadable ? ['Unreadable rows stepped over', pill(num(last.unreadable), 'bad')] : null,
				last.errors ? ['Trigger write errors', pill(num(last.errors), 'bad')] : null,
				// The three reasons a pass can stop early are not interchangeable: two are routine and
				// one is an origin that stopped answering, and a single "Interrupted" label made the
				// third indistinguishable from the first two.
				last.aborted
					? [
							'Interrupted',
							last.abortedOnDistress
								? pill(
										last.distressedOn?.length
											? `gave up on a refusing origin (${last.distressedOn.join(', ')})`
											: 'gave up on a refusing origin',
										'bad'
									)
								: pill('stood down for a reseed, or the probe was disabled', ''),
						]
					: null,
			])
		);
	}

	if (!last) {
		body.push(muted('No sweep has finished since startup. The first one runs after changeProbe.startDelay.'));
	}

	if (last?.failureSamples?.length) {
		body.push(
			el('p', { cls: 'muted chart-note' }, [
				'The first few failures of that pass. A failure leaves the stored signature untouched and triggers ',
				'nothing, so these are pages back on interval-only freshness until the rule fits again.',
			]),
			table(
				['url', 'rule', 'error'],
				last.failureSamples.map((sample) =>
					el('tr', null, [
						el('td', { cls: 'mono truncate', text: sample.url ?? '—', title: sample.url ?? '' }),
						el('td', { cls: 'mono', text: sample.rule ?? '—' }),
						el('td', { cls: 'mono truncate', text: sample.error ?? '—', title: sample.error ?? '' }),
					])
				)
			)
		);
	}

	return card('Rolling sweep', {
		head: [
			sweepCadence(sweep) ? pill(sweepCadence(sweep), 'ok') : pill('not armed', 'bad'),
			sweep.running &&
				pill(
					`${sweep.runningOn?.length ? `running on ${sweep.runningOn.join(', ')}` : 'running now'}${sweepProgress(status)}`,
					'info'
				),
			spacer(),
			muted(last?.nodes > 1 ? `summed over ${last.nodes} nodes’ own slices` : ''),
		],
		body,
		foot: [
			muted(
				'The sweep catches per-URL drift — an item selling out, one price moving. It walks the whole owned ' +
					'slice at the configured rate, so a large corpus takes hours per pass by design; that is what the ' +
					'canary below exists to cover.'
			),
		],
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

function canaryCard(ctx, status) {
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

// ---------------------------------------------------------------- per node

/** Only under cluster scope: at node scope the whole page already IS one node's answer. */
function nodeTable(status) {
	const rows = status.byNode;
	if (!rows?.length) return null;

	return card('Per node', {
		head: [spacer(), muted('unsummed — a pass is run one node at a time')],
		body: [
			table(
				[
					'node',
					'probe',
					'run mode',
					'last sweep',
					{ text: 'probed', right: true },
					{ text: 'changed', right: true },
					{ text: 'failed', right: true },
					{ text: 'throttled', right: true },
				],
				rows.map((row) =>
					el('tr', null, [
						el('td', { cls: 'mono', text: row.hostname }),
						el('td', null, [
							// An unreadable state row outranks everything else in the cell: "enabled" is read
							// from config and is true, but running/last-pass/probed are all unknown for this node.
							row.stateAvailable === false && pill('state unreadable', 'bad'),
							row.enabled === false ? pill('disabled', 'bad') : pill('enabled', 'ok'),
							row.sweepRunning &&
								pill(
									Number.isFinite(row.sweepProgress?.examinedApprox)
										? `sweeping · ~${num(row.sweepProgress.examinedApprox)} examined`
										: 'sweeping',
									'info'
								),
							row.canaryRunning && pill('canary', 'info'),
						]),
						el('td', null, [row.dryRun === false ? pill('live', 'ok') : pill('dry run', 'warn')]),
						el('td', null, [
							row.sweepFinishedAt ? muted(ago(row.sweepFinishedAt)) : muted('never'),
							row.error && pill('errored', 'bad'),
							// The pass ended without covering its slice, which no counter in this row says.
							row.abortedOnDistress && pill('gave up — origin refusing', 'bad'),
						]),
						el('td', { cls: 'right mono', text: num(row.probed) }),
						el('td', { cls: 'right mono', text: num(row.changed) }),
						el('td', { cls: 'right mono', text: num(row.failed) }),
						// Belongs in the UNSUMMED table: the probe rate is agreed per node and held per
						// node, so pushback is a fact about one node's origin conversation. This column is
						// how an operator picks which node to go and look at.
						el('td', { cls: 'right mono', text: num(row.throttled) }),
					])
				)
			),
		],
	});
}

// ---------------------------------------------------------------- settings

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
