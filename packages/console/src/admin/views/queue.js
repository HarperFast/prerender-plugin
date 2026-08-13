/**
 * Queue & nodes: cluster-wide pause/resume plus per-node overrides, and the supply side —
 * render outcomes, render time, and claim-scan health from the shared analytics window (the
 * same cached scan the Traffic view reads).
 *
 * The wording here is load-bearing. `QueueControl` is replicated INTENT; `QueueStatus` is what
 * each node last OBSERVED. Per-node overrides win over the cluster scope in both directions,
 * and a control write converges within one statusSyncInterval — so the table shows both columns
 * separately, or operators conclude a pause failed and click it repeatedly.
 *
 * Render rows land on whichever node processed the job result, so the per-node numbers ARE real
 * per-node throughput. Under cluster scope the proxy reads every node's window and hands back
 * both the merged series (the charts) and per-node totals (the table's throughput column);
 * under node scope only that node's row is filled, because the others' rows live on them.
 */

import { ago, card, duration, el, ICONS, muted, num, pill, spacer, stat, table } from '../ui.js';
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
import { statusPill } from './overview.js';

export const meta = { id: 'queue', label: 'Queue & nodes', crumb: 'queue', icon: ICONS.queue };

export async function load(ctx) {
	const [res, analyticsRes] = await Promise.all([
		ctx.get('overview'),
		// Same range key the Traffic view defaults to, so the two views share the worker cache.
		ctx.get('analytics', { range: 3_600_000 }),
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
		el('div', { cls: 'view-head' }, [el('span', { cls: 'eyebrow', text: 'Queue & nodes' }), spacer()]),
		cluster(ctx, data, setPause),
		nodeTable(ctx, data, setPause),
		supply(ctx),
	];
}

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

	const total = sumCount(outcomes);
	const failedLike = sumCount(outcomes.filter((s) => s.method === 'failed' || s.method === 'auth-failure'));
	const rangeHours = data.rangeMs / 3_600_000;

	const kpis = el('div', { cls: 'stat-grid' }, [
		stat('Results processed', num(total), `≈ ${fmtCount(total / rangeHours)}/h across ${scopeLabel(data)}`),
		stat('Failed or auth-failed', num(failedLike), 'kept and retried — watch for a step', {
			// One-in-ten failing is past tail noise for any healthy corpus.
			warn: total > 0 && failedLike > total / 10,
		}),
		stat('Render p95', fmtMs(weighted(times, 'p95')), 'browser-reported duration ≈'),
		stat('Claim scan p95', fmtMs(weighted(claims, 'p95')), 'the leading indicator — watch the trend ≈'),
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
				'Render time is fleet capacity (renders/hour = concurrency ÷ time). The claim scan degrades ',
				'BEFORE any backlog shows — measured 17× once — so its trend matters more than its level.',
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

function nodeTable(ctx, data, setPause) {
	// PER-NODE THROUGHPUT, from the analytics window.
	//
	// Under cluster scope the proxy fans the window out and returns a per-node totals block
	// alongside the merged series, so every row here gets its own rate — the column used to be
	// '—' for every node but the one being read, because analytics rows are node-local and a
	// peer's blank rendered as zero would read as "that node is idle". Now the blank means
	// exactly one thing: that node did not answer. Reading a single node still fills only its
	// own row, for the same original reason.
	const analytics = ctx.data.analytics;
	const rateOf = (counts, rangeMs) => {
		const total = counts.reduce((acc, s) => acc + s.count, 0);
		return total > 0 && rangeMs > 0 ? `≈${fmtCount(total / (rangeMs / 3_600_000))}/h` : null;
	};

	const rates = new Map();
	if (analytics && analytics.available !== false) {
		if (analytics.byNode) {
			for (const entry of analytics.byNode) {
				const outcomes = (entry.totals ?? []).filter((s) => s.metric === 'render' && s.path === 'outcome');
				const rate = rateOf(outcomes, entry.rangeMs ?? analytics.rangeMs);
				// Key on the node's OWN hostname (what QueueStatus rows use); the configured
				// origin's host carries a port and would never match. Both are indexed so a
				// deployment whose origins happen to be bare hostnames still joins.
				if (entry.node) rates.set(entry.node, rate);
				rates.set(entry.hostname, rate);
			}
		} else if (analytics.node) {
			rates.set(
				analytics.node,
				rateOf(
					pick(analytics, 'render', (s) => s.path === 'outcome'),
					analytics.rangeMs
				)
			);
		}
	}
	const rateFor = (hostname) => rates.get(hostname) ?? null;

	const rows = data.nodes.map((node) =>
		el('tr', null, [
			el('td', { cls: 'mono' }, [node.hostname, node.isThisNode && muted(' (this node)')]),
			el('td', null, [statusPill(node.status)]),
			el('td', {
				cls: 'mono' + (rateFor(node.hostname) ? '' : ' muted'),
				text: rateFor(node.hostname) ?? '—',
			}),
			el('td', null, [el('span', { cls: node.stale ? 'pill warn' : 'muted', text: ago(node.updatedTime) })]),
			el('td', null, [
				node.override
					? node.override.paused
						? pill('override: paused', 'bad')
						: pill('override: force run', 'ok')
					: pill('inherits cluster'),
			]),
			el('td', null, [
				el('div', { cls: 'row-actions' }, [
					el('button', {
						cls: 'danger small',
						text: 'Pause',
						disabled: ctx.busy,
						onclick: () => setPause(node.hostname, true),
					}),
					el('button', {
						cls: 'small',
						text: 'Force run',
						disabled: ctx.busy,
						onclick: () => setPause(node.hostname, false),
					}),
					el('button', {
						cls: 'small',
						text: 'Inherit',
						disabled: ctx.busy,
						onclick: () => setPause(node.hostname, null),
					}),
				]),
			]),
		])
	);

	return el('div', { cls: 'card' }, [
		table(
			['node', 'observed status', 'throughput', 'last report', 'intent', { text: 'actions', right: true }],
			rows,
			'No nodes have reported queue status yet.'
		),
		el('div', { cls: 'card-foot' }, [
			muted(
				'Throughput is each node’s own processed-result rate — analytics rows are node-local, so the ' +
					'cluster view reads all of them and attributes each to its node. A blank means that node ' +
					'did not answer, never that it is idle; presenting it as zero would read as "idle".'
			),
		]),
	]);
}
