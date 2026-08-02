/**
 * Queue & nodes: cluster-wide pause/resume plus per-node overrides.
 *
 * The wording here is load-bearing. `QueueControl` is replicated INTENT; `QueueStatus` is what
 * each node last OBSERVED. Per-node overrides win over the cluster scope in both directions,
 * and a control write converges within one statusSyncInterval — so the table shows both columns
 * separately, or operators conclude a pause failed and click it repeatedly.
 */

import { ago, card, duration, el, ICONS, muted, pill, spacer, table, unwired } from '../ui.js';
import { statusPill } from './overview.js';

export const meta = { id: 'queue', label: 'Queue & nodes', crumb: 'queue', icon: ICONS.queue };

export async function load(ctx) {
	const res = await ctx.get('overview');
	ctx.data.overview = res.ok ? res.body : null;
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
	];
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
	const rows = data.nodes.map((node) =>
		el('tr', null, [
			el('td', { cls: 'mono' }, [node.hostname, node.isThisNode && muted(' (this node)')]),
			el('td', null, [statusPill(node.status)]),
			// Placeholder column, not fake zeros: render throughput per node has no data path
			// into Harper yet, and a real-looking 0/min would read as "this node is idle".
			el('td', { cls: 'mono muted', text: '—' }),
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
			unwired(
				'Per-node render throughput and latency percentiles.',
				'a transport for render-worker stats into Harper — the workers emit them to stdout only'
			),
		]),
	]);
}
