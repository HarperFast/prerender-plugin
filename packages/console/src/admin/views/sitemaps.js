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

import { ago, card, el, ICONS, kv, link, meter, muted, num, pct, pill, spacer, table } from '../ui.js';
import { appliedNote, editTray, loadConfig, settingsCard } from './_configEdit.js';

export const meta = { id: 'sitemaps', label: 'Sitemaps', crumb: 'sitemaps', icon: ICONS.sitemaps };

const PAGE_SIZE = 50;

export async function load(ctx) {
	const [res] = await Promise.all([ctx.get('sitemaps'), loadConfig(ctx)]);
	if (!res.ok) {
		ctx.data.list = null;
		ctx.data.error = res.body?.error ?? `Could not load sitemaps (${res.status})`;
		return;
	}
	ctx.data.list = res.body;
	ctx.data.error = null;

	// KEEP THE SELECTION EVEN WHEN IT IS NOT A ROOT. The list is roots only, but a child sitemap is
	// a perfectly good selection — it is how an index is explored, and the detail endpoint reads any
	// stored sitemap by URL. Requiring the selection to appear in the root list snapped every
	// drill-into-a-child straight back to the first root on the reload that followed the click.
	const roots = res.body.sitemaps ?? [];
	ctx.data.selected ??= roots[0]?.url ?? null;
	await loadDetail(ctx);

	// A selection that no longer resolves (a child that left its index between walks, a sitemap
	// removed) falls back to the first root rather than leaving a dead pane with a stale URL in it.
	if (!ctx.data.detail && ctx.data.selected && ctx.data.selected !== roots[0]?.url) {
		ctx.data.selected = roots[0]?.url ?? null;
		ctx.data.offset = 0;
		await loadDetail(ctx);
	}
}

/** Select a sitemap — a root from the list, or a child reached from its parent index. */
function open(ctx, url) {
	ctx.data.selected = url;
	ctx.data.offset = 0;
	ctx.data.filter = '';
	ctx.reload();
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
		appliedNote(ctx),
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
		settings(ctx),
		editTray(ctx),
	];
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
					onclick: () => open(ctx, sitemap.url),
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
			// A child sitemap is only reachable through its parent, so it is the one place in this
			// console that needs a way back — the root list cannot select it and cannot show it as
			// selected either.
			sitemap.parentUrl &&
				el('div', { style: { marginBottom: '10px' } }, [
					link(`↑ ${shortPath(sitemap.parentUrl)}`, () => open(ctx, sitemap.parentUrl)),
					muted(' — the index that lists this sitemap'),
				]),
			el('div', { cls: 'toolbar' }, [
				el('div', {
					cls: 'mono break',
					style: { fontSize: '14px', color: 'var(--fg-0)', minWidth: '0' },
					text: sitemap.url,
				}),
				sitemap.isIndex && pill('index', 'info'),
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

	// AN INDEX HAS NO TARGETS OF ITS OWN, structurally: a walk attributes each Target to the
	// sitemap that actually listed the URL, which is always a child. So "Targets 0 / Coverage 0%"
	// on an index is not a finding, it is the shape of the data — and it reads as a total failure
	// of the largest sitemap in the deployment. Count what an index does have instead.
	if (sitemap.isIndex) {
		return el('div', { style: STATS_GRID }, [
			statCell('Child sitemaps', num(entryCount), muted('listed by this index')),
			statCell(
				'Last walked',
				sitemap.lastRefreshed ? ago(new Date(sitemap.lastRefreshed).getTime()) : 'never',
				muted('this document, not its children')
			),
			statCell('Entries', '—', muted('an index lists sitemaps, not URLs — open one below')),
		]);
	}

	return el('div', { style: STATS_GRID }, [
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
	]);
}

const STATS_GRID = {
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
	gap: '16px',
	marginTop: '16px',
};

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
		placeholder: `Filter the ${entries.length} ${detail.sitemap.isIndex ? 'child sitemaps' : 'entries'} on this page`,
	});
	search.addEventListener('input', () => {
		ctx.data.filter = search.value;
		ctx.render();
	});

	// AN INDEX'S ENTRIES ARE SITEMAPS, NOT PAGES, and almost nothing on the URL table means
	// anything for one. `<changefreq>` and `<priority>` are not part of the sitemapindex schema at
	// all, so those columns are structurally empty. The state pill is worse than empty: it is the
	// answer to "is this URL cached and scheduled", asked of an XML document that is never
	// prerendered — so every row reads `no target` or `filtered`, which looks like a fault and is
	// not one. And `explain` explains the cache key of a sitemap file nobody will ever request.
	//
	// What an operator actually wants from an index row is to open that child, which until now was
	// impossible from this console: the list is roots only, so children were reachable in the
	// comments and nowhere else.
	const isIndex = !!detail.sitemap.isIndex;
	// `lastmod` is the one field the index schema does carry. The plugin does not return it yet, so
	// the column appears only if it is there — it lights up on its own when that lands, rather than
	// standing as a permanently empty column now.
	const anyLastmod = isIndex && visible.some((entry) => entry.lastmod);

	const rows = visible.map((entry) =>
		isIndex
			? el('tr', null, [
					el('td', {
						cls: 'mono truncate',
						style: { maxWidth: '460px' },
						title: entry.loc,
						text: shortPath(entry.loc),
					}),
					anyLastmod && el('td', { cls: 'mono muted', text: entry.lastmod ?? '—' }),
					el('td', { cls: 'right' }, [link('open →', () => open(ctx, entry.loc))]),
				])
			: el('tr', null, [
					el('td', {
						cls: 'mono truncate',
						style: { maxWidth: '380px' },
						title: entry.loc,
						text: shortPath(entry.loc),
					}),
					el('td', { cls: 'muted', text: entry.changefreq ?? '—' }),
					el('td', { cls: 'mono muted', text: entry.priority ?? '—' }),
					el('td', null, [entryState(entry)]),
					el('td', { cls: 'right' }, [
						link('explain →', () => ctx.go('explain', { input: { url: entry.loc, deviceType: '' }, result: null })),
					]),
				])
	);

	const headers = isIndex
		? ['child sitemap', anyLastmod && 'lastmod', { text: '', right: true }].filter(Boolean)
		: ['url', 'changefreq', 'priority', 'state', { text: '', right: true }];

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
			headers,
			rows,
			filter
				? `No ${isIndex ? 'child sitemaps' : 'entries'} on this page match the filter.`
				: `This ${isIndex ? 'index lists no sitemaps' : 'sitemap has no entries'}.`
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

/**
 * Ingestion settings, below the state they produce.
 *
 * The distinction worth stating on this view is SCHEDULE versus WALK: everything here changes when
 * or how the next pass runs, and nothing here runs one — the buttons above are still the only way
 * to make a walk happen now.
 */
const settings = (ctx) =>
	settingsCard(ctx, {
		title: 'Sitemap ingestion',
		prefix: 'sitemap',
		description:
			'When the daily pass runs and how a walk behaves. refreshTime, timezone, node and workerIndex move ' +
			'only the schedule — an empty node disables the periodic refresh entirely and leaves the Refresh ' +
			'buttons above as the only trigger — and changing any of them never starts a walk now. ' +
			'filteredWarnPercent changes the severity a refresh REPORTS when most of a sitemap is filtered out, ' +
			'not what gets filtered: that is ingress.routes, and the Served without prerendering panel above is ' +
			'the other half of the same question.',
	});
