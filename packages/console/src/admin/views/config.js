/**
 * Config: divergence first, then warnings, then the effective (redacted) merge of defaults and
 * host overrides.
 *
 * DIVERGENCE IS THE HEADLINE UNDER CLUSTER SCOPE. Every node of a prerender cluster runs the
 * same component with the same options, so a difference between nodes is never a preference —
 * it is a deploy that did not land everywhere. That failure is otherwise invisible: the skipped
 * node keeps serving traffic, keeps reporting queue status, keeps answering this API, and only
 * its options give it away. So the comparison is rendered before the config itself, and the
 * config dump names the node it came from rather than posing as "the cluster's".
 */

import { card, el, ICONS, muted, spacer } from '../ui.js';

export const meta = { id: 'config', label: 'Config', crumb: 'config', icon: ICONS.config };

export async function load(ctx) {
	const res = await ctx.get('config');
	ctx.data.config = res.ok ? res.body : null;
	ctx.data.error = res.ok ? null : (res.body?.error ?? `Could not load config (${res.status})`);
}

export function render(ctx) {
	const data = ctx.data.config;
	if (!data) return el('div', { cls: 'note bad', text: ctx.data.error ?? 'No config data.' });

	const warnings = (data.warnings ?? []).map((warning) =>
		el('div', { cls: `note ${warning.severity === 'warn' ? 'warn' : 'info'}` }, [
			el('strong', { cls: 'mono', text: `${warning.key}: ` }),
			warning.hostname ? muted(`${warning.hostname} · `) : null,
			warning.message,
		])
	);

	const from = data.configFrom ?? data.node;
	return [
		el('div', { cls: 'view-head' }, [
			el('span', { cls: 'eyebrow', text: 'Config' }),
			el('span', {
				cls: 'muted mono',
				text: data.configFrom
					? `${data.sources?.answered ?? '?'} nodes compared`
					: `${data.node} · worker ${data.workerIndex}`,
			}),
			spacer(),
		]),
		divergence(data),
		warnings.length ? warnings : el('div', { cls: 'note ok', text: 'No configuration warnings.' }),
		card('Effective config', {
			head: [spacer(), muted('secrets show only whether they are set')],
			body: [
				el('p', { cls: 'muted', style: { margin: '0 0 12px' } }, [
					`The live merge of defaults and host overrides on ${from ?? 'this node'}` +
						(data.configFrom ? ' — the node the comparison above is against.' : ' and worker.'),
				]),
				el('pre', { text: JSON.stringify(data.config, null, 2) }),
			],
		}),
	];
}

function divergence(data) {
	// Only meaningful once more than one node has been compared. A single-node read has nothing
	// to disagree with, and an "all nodes agree" banner there would be a claim about one node.
	if (!data.configFrom) return null;
	const rows = data.divergences ?? [];

	if (rows.length === 0) {
		return el('div', {
			cls: 'note ok',
			text: `All ${data.sources?.answered ?? 0} nodes report identical effective config.`,
		});
	}

	return card('Nodes disagree', {
		head: [spacer(), muted(`${rows.length} option${rows.length === 1 ? '' : 's'} differ`)],
		body: [
			el('div', { cls: 'note bad' }, [
				'These options are not the same on every node. A prerender cluster runs one component ' +
					'with one set of options, so this is a deploy that did not reach every node (or a node ' +
					'that has not restarted into it) — not a configuration choice. Every other panel will ' +
					'keep looking healthy while it is true.',
			]),
			el('div', { cls: 'scroll' }, [
				el('table', null, [
					el('tbody', null, [
						...rows.map((row) =>
							el('tr', null, [
								el('td', { cls: 'mono', text: row.path }),
								el(
									'td',
									null,
									row.values.map((value) =>
										el('div', { cls: 'mono' }, [muted(`${value.hostname}: `), String(value.value)])
									)
								),
							])
						),
					]),
				]),
			]),
			data.divergencesTruncated
				? el('div', {
						cls: 'note warn',
						text: 'The list was capped — the nodes differ in more options than are shown, which usually means one is on an entirely different release.',
					})
				: null,
		],
	});
}
