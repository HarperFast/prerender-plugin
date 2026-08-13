/**
 * Metrics reference: the live catalog (`GET /prerender_admin/metrics`), rendered.
 *
 * The catalog exists so a dashboard author asks a RUNNING node what it emits instead of
 * matching a doc against a deployed version — this view is that, without curl. It is the
 * closing move of "one-stop console": the charts one tab over are built on these exact
 * names and slots, and when someone wants a panel that doesn't exist yet, this page says
 * what the emitted data can support. Static data, one fetch, no table touched.
 */

import { card, el, ICONS, mono, muted, pill, spacer, table } from '../ui.js';

export const meta = { id: 'metrics', label: 'Metrics', crumb: 'metrics', icon: ICONS.metrics };

export async function load(ctx) {
	// The catalog is version-static: one fetch per session is plenty.
	if (ctx.data.catalog) return;
	const res = await ctx.get('metrics');
	ctx.data.catalog = res.ok ? res.body : null;
	ctx.data.error = res.ok ? null : (res.body?.error ?? `Could not load the catalog (${res.status})`);
}

export function render(ctx) {
	const data = ctx.data.catalog;
	if (!data) return el('div', { cls: 'note bad', text: ctx.data.error ?? 'No catalog.' });

	const plugin = data.metrics?.plugin ?? [];
	const builtIn = data.metrics?.builtIn ?? [];

	return [
		el('div', { cls: 'view-head' }, [el('span', { cls: 'eyebrow', text: 'Metric catalog' }), spacer()]),
		el('div', { cls: 'note info' }, [
			'What this deployed version emits, served by the node itself (',
			el('code', { text: 'GET /prerender_admin/metrics' }),
			'). Values live in each node’s ',
			el('code', { text: 'system.hdb_analytics' }),
			' — a metric name is a scan, a series is a row, and rows are per node: fan out and sum. ',
			'The Traffic and Queue panels chart these via one bounded scan per refresh.',
		]),
		...plugin.map((metric) => metricCard(metric)),
		el('div', { cls: 'view-head', style: { marginTop: '20px' } }, [
			el('span', { cls: 'eyebrow', text: 'Harper built-ins, as this plugin’s traffic uses them' }),
			spacer(),
		]),
		...builtIn.map((metric) => metricCard(metric)),
	];
}

function metricCard(metric) {
	const dims = Object.entries(metric.dimensions ?? {}).map(([slot, dim]) =>
		el('tr', null, [
			el('td', { cls: 'mono muted', text: slot }),
			el('td', { cls: 'mono', text: dim.name ?? '—' }),
			el('td', null, [
				dim.values
					? el('span', { cls: 'mono', text: dim.values.filter((v) => v !== null).join(' · ') })
					: muted('open (bounded by construction)'),
			]),
			el('td', { cls: 'break muted', text: dim.description ?? '' }),
		])
	);

	return card(metric.name, {
		head: [
			pill(metric.kind, metric.kind === 'value' ? 'info' : ''),
			metric.unit && mono(metric.unit),
			spacer(),
			metric.emittedBy && el('span', { cls: 'muted mono truncate', text: metric.emittedBy }),
		],
		body: [
			el('p', { style: { margin: '0 0 6px' }, text: metric.summary }),
			metric.usefulFor && el('p', { cls: 'muted', style: { margin: '0 0 10px' }, text: metric.usefulFor }),
			metric.caveats && el('div', { cls: 'note warn', text: metric.caveats }),
			table(['slot', 'meaning', 'values', ''], dims),
		],
	});
}
