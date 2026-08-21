/**
 * Queue: cluster-wide pause/resume, the supply side — render outcomes, render time and claim-scan
 * health from the shared analytics window (the same cached scan the Traffic view reads) — and the
 * options that shape all three.
 *
 * The pause wording is load-bearing. `QueueControl` is replicated INTENT; `QueueStatus` is what
 * each node last OBSERVED. A control write converges within one statusSyncInterval, so the two are
 * never conflated, or operators conclude a pause failed and click it repeatedly. The per-node half
 * of that — observed status, per-node intent, throughput, liveness — moved to Nodes, which is where
 * every other per-node answer already had to be read from.
 *
 * THE DATA COMES FIRST AND THE KNOBS SECOND. `queue`, `render` and `scan` are edited here rather
 * than on a settings screen because an option is only intelligible beside the numbers it moves: a
 * lease time means nothing until you are looking at the claim-scan trend it feeds. The staged set
 * is shared with every other config surface (see _configEdit.js), so the tray at the bottom shows
 * changes staged under Sitemaps too — one document, one write.
 */

import { ago, card, duration, el, ICONS, link, muted, num, pill, spacer, stat } from '../ui.js';
import {
	barList,
	colorFor,
	emptyNote,
	fmtCount,
	fmtMs,
	legend,
	lineChart,
	OUTCOME_COLORS,
	pick,
	scanFooter,
	scopeLabel,
	SERIES,
	stackBy,
	stackedBars,
	sumCount,
	weighted,
	weightedBuckets,
	windowEmpty,
} from '../charts.js';
import { appliedNote, editTray, loadConfig, settingsCard } from './_configEdit.js';

export const meta = { id: 'queue', label: 'Queue', crumb: 'queue', icon: ICONS.queue };

export async function load(ctx) {
	const [res, analyticsRes] = await Promise.all([
		ctx.get('overview'),
		// Same range key the Traffic view defaults to, so the two views share the worker cache.
		ctx.get('analytics', { range: 3_600_000 }),
		// The settings cards below render from this. It goes through the shared config scratch, so
		// arriving here from another settings surface reuses the payload rather than re-fanning out.
		loadConfig(ctx),
	]);
	ctx.data.overview = res.ok ? res.body : null;
	ctx.data.analytics = analyticsRes.ok ? analyticsRes.body : null;
	ctx.data.error = res.ok ? null : (res.body?.error ?? `Could not load queue state (${res.status})`);
}

export function render(ctx) {
	const data = ctx.data.overview;
	if (!data) return el('div', { cls: 'note bad', text: ctx.data.error ?? 'No queue data.' });

	const setPause = (scope, paused) => ctx.run(() => ctx.post('queue', { scope, paused }));

	return [
		el('div', { cls: 'view-head' }, [el('span', { cls: 'eyebrow', text: 'Queue' }), spacer()]),
		// Near the top, because it explains a value further down that may still read as the old one.
		appliedNote(ctx),
		cluster(ctx, data, setPause),
		nodesPointer(ctx),
		supply(ctx),
		settings(ctx),
		// The tray shows the WHOLE staged set, including anything staged on another view.
		editTray(ctx),
	];
}

/** Where the per-node table went. One line, because the answer is a click and not a summary. */
const nodesPointer = (ctx) =>
	el('div', { cls: 'note' }, [
		'Per-node observed status, pause intent, throughput and liveness are on ',
		link('Nodes →', () => ctx.go('nodes')),
	]);

/** The render fleet as this node sees it, from the shared analytics window. */
function supply(ctx) {
	const data = ctx.data.analytics;
	if (!data || data.available === false || windowEmpty(data)) {
		return card(`Renders & claim health — ${scopeLabel(data)}, last hour`, {
			body: [emptyNote('render / queue_health', data)],
		});
	}

	const outcomes = pick(data, 'render', (s) => s.path === 'outcome');
	const times = pick(data, 'render', (s) => s.path === 'time_ms');
	const claims = pick(data, 'queue_health', (s) => s.path === 'claim_scan_ms');
	// `candidate` is a render whose result was actually stored — the work that produces a cached
	// page, as opposed to a settle-skipping bail on a page we were never going to keep.
	const candidateTimes = pick(data, 'render', (s) => s.path === 'time_ms' && s.type === 'candidate');

	const total = sumCount(outcomes);
	const failedLike = sumCount(outcomes.filter((s) => s.method === 'failed' || s.method === 'auth-failure'));
	const rangeHours = data.rangeMs / 3_600_000;

	const kpis = el('div', { cls: 'stat-grid' }, [
		stat('Results processed', num(total), `≈ ${fmtCount(total / rangeHours)}/h across ${scopeLabel(data)}`),
		stat('Failed or auth-failed', num(failedLike), 'kept and retried — watch for a step', {
			// One-in-ten failing is past tail noise for any healthy corpus.
			warn: total > 0 && failedLike > total / 10,
		}),
		// THE MEAN, because this tile is the capacity number and capacity is governed by the mean:
		// renders/hour is concurrency ÷ MEAN render time (a queue's throughput follows the average
		// service time, not its tail). Sizing off the p95 understates the fleet by whatever the tail
		// is worth — measured here, 16.0s against a mean of 11.0s, a third of the fleet's capacity
		// argued away.
		//
		// AND THE POOLED MEAN IS NOW TWO MODES. Since browser v1.18.0,
		// `navigation.skipSettleWhenNonIndexable` returns a page that already disowns itself at
		// DOMContentLoaded without settling — ~1.7s against ~10.9s — so the fleet runs cheap bails
		// beside full renders. Pooled, that mean falls as the BAIL RATE rises, which is a real
		// throughput gain and not a faster settle; read alone it looks like the renderer got quicker.
		// The candidacy slot already separates them (a bail posts a non-indexable verdict), so the
		// subtitle carries the mean of the renders that actually produced a stored page. Capacity
		// still uses the pooled mean: a bail occupies a worker slot like anything else.
		stat(
			'Render time',
			fmtMs(weighted(times, 'mean')),
			`mean, all renders — capacity is concurrency ÷ this${
				candidateTimes.length && candidateTimes.length !== times.length
					? ` · stored ${fmtMs(weighted(candidateTimes, 'mean'))}`
					: ''
			} · p95 ${fmtMs(weighted(times, 'p95'))}`
		),
		stat(
			'Claim scan p95',
			fmtMs(weighted(claims, 'p95')),
			`the leading indicator — watch the trend ≈ · median ${fmtMs(weighted(claims, 'median'))}`
		),
	]);

	// Outcomes stacked over time: the shape of "renders are failing" as it develops.
	const { keys, stacks } = stackBy(outcomes, 'method', data.bucketCount);
	const outcomeChart = card('Render outcomes', {
		head: [spacer(), legend(keys.map((k) => ({ label: k, color: colorFor(OUTCOME_COLORS, k) })))],
		body: [
			outcomes.length ? stackedBars(data, keys, stacks, (k) => colorFor(OUTCOME_COLORS, k)) : emptyNote('render', data),
			el('p', { cls: 'muted chart-note' }, [
				'One row per posted result. A rising auth-failure share with steady suppressed is the broken-',
				'bypass-token signature; suppressed climbing on its own is the corpus being mass-suppressed.',
			]),
		],
	});

	const timeSeries = [
		{ label: 'render p95', color: SERIES[2], points: weightedBuckets(times, 'p95s', data.bucketCount) },
		{ label: 'claim scan p95', color: SERIES[0], points: weightedBuckets(claims, 'p95s', data.bucketCount) },
	];
	const timesChart = card('Render time & claim scan (p95 ≈)', {
		head: [spacer(), legend(timeSeries.map(({ label, color }) => ({ label, color })))],
		body: [
			timeSeries.some((s) => s.points.some((p) => Number.isFinite(p)))
				? lineChart(data, timeSeries)
				: emptyNote('render time / claim_scan_ms', data),
			el('p', { cls: 'muted chart-note' }, [
				'These are TAILS, not the capacity figure: renders/hour is concurrency ÷ the MEAN render time, ',
				'which is the tile above — a p95 line answers "are some renders pathological", never "how many ',
				'can the fleet do". The claim scan degrades BEFORE any backlog shows — measured 17× once — so ',
				'its trend matters more than its level.',
			]),
		],
	});

	// The reconcile/below-floor series are already surfaced on the overview from the snapshot;
	// what belongs here is the failure detail: outcome reasons ranked.
	const details = new Map();
	for (const s of outcomes) {
		const key = `${s.method}${s.type && s.type !== 'unspecified' ? ` · ${s.type}` : ''}`;
		details.set(key, { count: (details.get(key)?.count ?? 0) + s.count, method: s.method });
	}
	const ranked = [...details.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 12);
	const reasons = card('Outcome detail', {
		body: [
			ranked.length
				? barList(
						ranked.map(([label, { count, method }]) => ({
							label,
							value: count,
							color: colorFor(OUTCOME_COLORS, method),
						}))
					)
				: emptyNote('render outcomes', data),
		],
	});

	return el('div', null, [
		el('div', { cls: 'view-head', style: { marginTop: '20px' } }, [
			el('span', { cls: 'eyebrow', text: `${scopeLabel(data)} · last hour` }),
			spacer(),
			scanFooter(data),
		]),
		kpis,
		el('div', { cls: 'cols' }, [outcomeChart, timesChart]),
		reasons,
	]);
}

function cluster(ctx, data, setPause) {
	const control = data.control.cluster;

	return card('Cluster-wide', {
		head: [
			control ? (control.paused ? pill('paused', 'bad') : pill('running', 'ok')) : pill('not set (running)'),
			control?.updatedBy && muted(`set by ${control.updatedBy}, ${ago(new Date(control.updatedTime).getTime())}`),
			spacer(),
			el('button', { cls: 'danger', text: 'Pause cluster', disabled: ctx.busy, onclick: () => setPause('all', true) }),
			el('button', { text: 'Resume cluster', disabled: ctx.busy, onclick: () => setPause('all', false) }),
		],
		body: [
			el('div', { cls: 'note info' }, [
				'A control write is replicated, and each node applies it on its own status sync — expect up ' +
					`to ${duration(data.intervals.statusSyncInterval)} before a remote node stops claiming. ` +
					'"Observed status" is what each node last reported, not the intent.',
			]),
		],
	});
}

/**
 * The options that shape everything above, in the order an operator reaches for them: the queue
 * mechanics, then what feeds the queue, then the budgets the scans behind these panels run under.
 *
 * Every card is rendered by the shared editor, so a value here is never shown as though it took
 * effect when it did not — deployed, overridden, staged and running are four distinct states, and
 * telling them apart is the whole job (see _configEdit.js and ui.js's settingRow).
 */
function settings(ctx) {
	return el('div', null, [
		el('div', { cls: 'view-head', style: { marginTop: '20px' } }, [
			el('span', { cls: 'eyebrow', text: 'Settings' }),
			spacer(),
			muted('staged in this browser until you preview and apply'),
		]),
		settingsCard(ctx, {
			title: 'Queue mechanics',
			prefix: 'queue',
			description:
				'How work is handed to the render fleet: lease length, claim batch size, and the claim floor. ' +
				'These move the claim-scan and throughput numbers above; none of them changes what is in the ' +
				'corpus, only how fast it is worked through.',
		}),
		settingsCard(ctx, {
			title: 'Render scheduling',
			prefix: 'render',
			description:
				'What arrives in the queue at all: the render cadence, how a failure is retried or suppressed, ' +
				'and the repair sweep that restores a target whose schedule row went missing. A cadence change ' +
				'reshapes the "renders due" histogram on the overview, not this page.',
		}),
		settingsCard(ctx, {
			title: 'Scan budgets',
			prefix: 'scan',
			description:
				'The bounds every registry walk runs under. The backlog snapshot and both sweeps use them, so a ' +
				'cap set below the real backlog makes those panels report a floor rather than a count — which ' +
				'reads as a healthy number.',
		}),
	]);
}
