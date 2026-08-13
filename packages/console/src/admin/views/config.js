/**
 * Config: warnings first, then the effective (redacted) merge of defaults and host overrides.
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
			warning.message,
		])
	);

	return [
		el('div', { cls: 'view-head' }, [
			el('span', { cls: 'eyebrow', text: 'Config' }),
			el('span', { cls: 'muted mono', text: `${data.node} · worker ${data.workerIndex}` }),
			spacer(),
		]),
		warnings.length ? warnings : el('div', { cls: 'note ok', text: 'No configuration warnings.' }),
		card('Effective config', {
			head: [spacer(), muted('secrets show only whether they are set')],
			body: [
				el('p', { cls: 'muted', style: { margin: '0 0 12px' } }, [
					'The live merge of defaults and host overrides on this node and worker.',
				]),
				el('pre', { text: JSON.stringify(data.config, null, 2) }),
			],
		}),
	];
}
