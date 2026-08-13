/**
 * Sitemaps: the root list with refresh state, and a per-sitemap detail with a paged entry
 * table.
 *
 * QUERY SHAPE. The list never touches `entries` — a single sitemap row can hold tens of
 * thousands of them, and the list is roots only (children are reachable from their parent).
 * The detail fetches ONE page of entries at a time, sliced server-side; per-entry state comes
 * from bounded point reads on just that page. Text filtering below is within the fetched page
 * and is labelled as such.
 */

import { ago, card, duration, el, ICONS, kv, link, meter, muted, num, pct, pill, spacer, table } from '../ui.js';

export const meta = { id: 'sitemaps', label: 'Sitemaps', crumb: 'sitemaps', icon: ICONS.sitemaps };

const PAGE_SIZE = 50;

export async function load(ctx) {
	const [res, unroutedRes] = await Promise.all([ctx.get('sitemaps'), ctx.get('unrouted')]);
	ctx.data.unrouted = unroutedRes.ok ? unroutedRes.body : null;
	if (!res.ok) {
		ctx.data.list = null;
		ctx.data.error = res.body?.error ?? `Could not load sitemaps (${res.status})`;
		return;
	}
	ctx.data.list = res.body;
	ctx.data.error = null;

	// Keep the selection when it still exists; else select the first root.
	const roots = res.body.sitemaps ?? [];
	if (!roots.some((sitemap) => sitemap.url === ctx.data.selected)) {
		ctx.data.selected = roots[0]?.url ?? null;
	}
	await loadDetail(ctx);
}

async function loadDetail(ctx) {
	if (!ctx.data.selected) {
		ctx.data.detail = null;
		return;
	}
	const res = await ctx.post('sitemap', { url: ctx.data.selected, offset: ctx.data.offset ?? 0, limit: PAGE_SIZE });
	ctx.data.detail = res.ok ? res.body : null;
	ctx.data.detailError = res.ok ? null : (res.body?.error ?? `Could not load the sitemap (${res.status})`);
}

export function render(ctx) {
	const list = ctx.data.list;
	if (!list) return el('div', { cls: 'note bad', text: ctx.data.error ?? 'No sitemap data.' });

	const roots = list.sitemaps ?? [];

	return [
		el('div', { cls: 'view-head' }, [
			el('span', { cls: 'eyebrow', text: 'Sitemaps' }),
			list.lastFullPass && el('span', { cls: 'muted mono', text: `last full pass ${ago(list.lastFullPass)}` }),
			spacer(),
			el('button', {
				text: 'Refresh all',
				disabled: ctx.busy,
				// Roots only — the walk reaches its own children (see Sitemap.parentUrl).
				onclick: () => ctx.run(() => ctx.post('sitemap-refresh', {})),
			}),
		]),
		roots.length === 0
			? el('div', { cls: 'note' }, [
					'No sitemaps are registered. Add one by POSTing its URL to the ',
					el('code', { text: 'sitemaps' }),
					' resource, and the daily scheduler will keep it refreshed.',
				])
			: el('div', { style: { display: 'flex', gap: '16px', alignItems: 'flex-start' } }, [
					rootList(ctx, roots),
					el('div', { style: { flex: '1', minWidth: '0', display: 'flex', flexDirection: 'column', gap: '16px' } }, [
						detail(ctx),
					]),
				]),
		unroutedCard(ctx),
	];
}

/**
 * Bot traffic served without prerendering, bucketed by first path segment. Either the CDN is
 * over-forwarding or the route list is incomplete — both are fixed per prefix, which is why
 * the report is bucketed the way a CDN rule or an ingress route is written.
 */
function unroutedCard(ctx) {
	const data = ctx.data.unrouted;
	if (!data) return null;

	const rows = (routeClass) =>
		(data.report?.[routeClass] ?? []).map((row) =>
			el('tr', null, [
				el('td', { cls: 'mono', text: row.bucket }),
				el('td', null, [pill(routeClass, routeClass === 'unclassified' ? 'warn' : '')]),
				el('td', { cls: 'mono right', text: num(row.count) }),
				el('td', {
					cls: 'mono muted truncate',
					style: { maxWidth: '300px' },
					title: row.samplePath,
					text: row.samplePath,
				}),
				el('td', { cls: 'right' }, [
					link('explain →', () => ctx.go('explain', { input: { url: row.samplePath, deviceType: '' }, result: null })),
				]),
			])
		);

	return assembleUnrouted(data, [...rows('unclassified'), ...rows('passthrough')]);
}

// Assembled explicitly so the table sits between head and foot.
function assembleUnrouted(data, all) {
	return el('div', { cls: 'card' }, [
		el('div', { cls: 'card-head' }, [
			el('div', { cls: 'title', text: 'Served without prerendering' }),
			spacer(),
			el('span', {
				cls: 'muted mono',
				text: data.workers
					? `one worker on each of ${data.workers} nodes · since their last flush (every ${duration(data.interval)})`
					: `worker ${data.workerIndex} on ${data.node} · since its last flush (every ${duration(data.interval)})`,
			}),
		]),
		el('div', { cls: 'card-body' }, [
			all.length === 0
				? el('div', {
						cls: 'note ok',
						text: data.workers
							? `No unrouted traffic on the ${data.workers} sampled workers since their last flush.`
							: 'This worker has served nothing unrouted since its last flush.',
					})
				: null,
			el('p', { cls: 'muted', style: { margin: '12px 0 0' } }, [
				'Counters are per-worker and reset on every flush, so this is a SAMPLE — one worker per node, ' +
					'not a cluster total. It answers “is anything hitting a route we don’t classify”, never ' +
					'“how much”. unclassified = the CDN forwarded a path no route declares; passthrough = ' +
					'declared, deliberately proxied live.',
			]),
		]),
		all.length > 0 &&
			table(['path bucket', 'class', { text: 'requests', right: true }, 'sample', { text: '', right: true }], all),
		data.report?.overflowed
			? el('div', { cls: 'card-foot' }, [
					`${num(data.report.overflowed)} request(s) fell outside the bucket cap and are not broken down above.`,
				])
			: null,
	]);
}

function rootList(ctx, roots) {
	return el(
		'div',
		{
			style: {
				width: '250px',
				minWidth: '190px',
				flex: '0 1 auto',
				display: 'flex',
				flexDirection: 'column',
				gap: '8px',
			},
		},
		roots.map((sitemap) => {
			const selected = sitemap.url === ctx.data.selected;
			const failed = sitemap.refresh?.state === 'failed' || sitemap.refresh?.error;
			const running = sitemap.refresh?.state === 'running';

			return el(
				'div',
				{
					cls: 'card',
					style: {
						padding: '12px 14px',
						cursor: 'pointer',
						borderColor: selected ? 'rgba(45,212,160,0.35)' : undefined,
						background: selected ? 'rgba(45,212,160,0.08)' : undefined,
					},
					onclick: () => {
						ctx.data.selected = sitemap.url;
						ctx.data.offset = 0;
						ctx.reload();
					},
				},
				[
					el('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
						el('span', { cls: 'mono truncate', style: { fontSize: '12px', flex: '1' }, text: shortPath(sitemap.url) }),
						failed ? pill('✗', 'bad') : running ? pill('…', 'info') : pill('✓', 'ok'),
					]),
					el('div', { cls: 'mono muted', style: { fontSize: '11px', marginTop: '4px' } }, [
						`${num(sitemap.entryCount)} entries · ${sitemap.lastRefreshed ? ago(new Date(sitemap.lastRefreshed).getTime()) : 'never refreshed'}`,
					]),
				]
			);
		})
	);
}

function detail(ctx) {
	const detail = ctx.data.detail;
	if (!detail) return el('div', { cls: 'note bad', text: ctx.data.detailError ?? 'Select a sitemap.' });

	const { sitemap, refresh, entries } = detail;
	const failed = refresh?.state === 'failed' || refresh?.error;

	const header = card(null, {
		body: [
			el('div', { cls: 'toolbar' }, [
				el('div', {
					cls: 'mono break',
					style: { fontSize: '14px', color: 'var(--fg-0)', minWidth: '0' },
					text: sitemap.url,
				}),
				spacer(),
				el('button', {
					text: 'Refresh now',
					disabled: ctx.busy,
					onclick: () => ctx.run(() => ctx.post('sitemap-refresh', { url: sitemap.url })),
				}),
			]),
			failed &&
				el('div', { cls: 'note bad', style: { marginTop: '12px' } }, [
					`Last refresh failed: ${refresh.error ?? 'see the failure list below'}.`,
				]),
			refresh?.state === 'running' &&
				el('div', { cls: 'note info', style: { marginTop: '12px' } }, [
					`A walk is running on ${refresh.node ?? 'another node'} — ${num(refresh.sitemapsProcessed)} of ` +
						`${num(refresh.sitemapsDiscovered)} sitemaps processed, last progress ${ago(new Date(refresh.updatedAt).getTime())}.`,
				]),
			(refresh?.failed?.length ?? 0) > 0 &&
				el('div', { cls: 'note warn', style: { marginTop: '12px' } }, [
					`${refresh.failed.length} child sitemap(s) failed during the last walk: `,
					el('span', { cls: 'mono', text: refresh.failed.map((failure) => failure.url).join(', ') }),
				]),
			statsRow(detail),
			refresh &&
				el('div', { style: { marginTop: '14px' } }, [
					kv([
						['Last walk', refresh.finishedAt ? ago(new Date(refresh.finishedAt).getTime()) : '—'],
						refresh.created !== undefined && [
							'Created / updated / removed',
							`${num(refresh.created)} / ${num(refresh.updated)} / ${num(refresh.removed)}`,
						],
						refresh.duplicates ? ['Duplicates (overlapping sitemaps)', num(refresh.duplicates)] : null,
					]),
				]),
		],
	});

	return [header, entryTable(ctx, detail, entries)];
}

function statsRow(detail) {
	const { sitemap, targetCount } = detail;
	const entryCount = sitemap.entryCount ?? 0;

	return el(
		'div',
		{
			style: {
				display: 'grid',
				gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
				gap: '16px',
				marginTop: '16px',
			},
		},
		[
			statCell('Entries', num(entryCount), meter(1)),
			// targetCount is a capped count of Target rows whose sitemapUrl matches (an
			// indexed equality). Null when the count timed out — shown as unknown, not zero.
			statCell(
				'Targets',
				targetCount === null ? '—' : num(targetCount.count) + (targetCount.truncated ? '+' : ''),
				targetCount === null ? muted('count timed out') : meter(entryCount ? targetCount.count / entryCount : 0)
			),
			statCell(
				'Coverage',
				targetCount === null || !entryCount ? '—' : pct(Math.min(targetCount.count, entryCount), entryCount),
				muted('entries with a render target')
			),
		]
	);
}

const statCell = (label, value, extra) =>
	el('div', null, [
		el('div', {
			style: { fontSize: '12px', color: 'var(--fg-3)', textTransform: 'uppercase', letterSpacing: '0.12em' },
			text: label,
		}),
		el('div', { style: { fontSize: '24px', fontWeight: '500', color: 'var(--fg-0)', marginTop: '4px' }, text: value }),
		extra,
	]);

function entryTable(ctx, detail, entries) {
	const filter = ctx.data.filter ?? '';
	const visible = filter
		? entries.filter((entry) => (entry.loc ?? '').toLowerCase().includes(filter.toLowerCase()))
		: entries;

	const search = el('input', {
		type: 'text',
		value: filter,
		placeholder: `Filter the ${entries.length} entries on this page`,
	});
	search.addEventListener('input', () => {
		ctx.data.filter = search.value;
		ctx.render();
	});

	const rows = visible.map((entry) =>
		el('tr', null, [
			el('td', { cls: 'mono truncate', style: { maxWidth: '380px' }, title: entry.loc, text: shortPath(entry.loc) }),
			el('td', { cls: 'muted', text: entry.changefreq ?? '—' }),
			el('td', { cls: 'mono muted', text: entry.priority ?? '—' }),
			el('td', null, [entryState(entry)]),
			el('td', { cls: 'right' }, [
				link('explain →', () => ctx.go('explain', { input: { url: entry.loc, deviceType: '' }, result: null })),
			]),
		])
	);

	const offset = detail.offset ?? 0;
	const total = detail.sitemap.entryCount ?? entries.length;

	const page = (next) => {
		ctx.data.offset = Math.max(0, next);
		ctx.reload();
	};

	return el('div', { cls: 'card' }, [
		el('div', { cls: 'card-head' }, [
			el('div', { cls: 'searchbox', style: { maxWidth: '360px' } }, [search]),
			filter && muted(`filtering this page only — ${visible.length} of ${entries.length} shown`),
			spacer(),
		]),
		table(
			['url', 'changefreq', 'priority', 'state', { text: '', right: true }],
			rows,
			filter ? 'No entries on this page match the filter.' : 'This sitemap has no entries.'
		),
		el('div', { cls: 'card-foot' }, [
			el('span', { text: `${num(Math.min(offset + 1, total))}–${num(offset + entries.length)} of ${num(total)}` }),
			spacer(),
			offset > 0 && link('← prev', () => page(offset - PAGE_SIZE)),
			offset + entries.length < total && link('next →', () => page(offset + PAGE_SIZE)),
		]),
	]);
}

/**
 * Entry state, from the bounded per-page point reads the server did. `state: null` means the
 * lookup for this entry timed out — shown as unknown, never as "not cached".
 */
function entryState(entry) {
	if (entry.state === null || entry.state === undefined) return pill('unknown');
	const kinds = {
		'cached': 'ok',
		'stale': 'warn',
		'due now': 'warn',
		'scheduled': 'info',
		'filtered': '',
		'non-indexable': 'bad',
		'no target': 'warn',
	};
	return el('span', null, [
		pill(entry.state, kinds[entry.state] ?? ''),
		entry.stateDetail && muted(` ${entry.stateDetail}`),
	]);
}

function shortPath(url) {
	try {
		const parsed = new URL(url);
		return parsed.pathname + parsed.search;
	} catch {
		return String(url ?? '');
	}
}
