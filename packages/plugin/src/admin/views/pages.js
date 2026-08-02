/**
 * Page cache: browse `PrerenderedPage` by cache-key prefix, with cursor paging.
 *
 * QUERY SHAPE, AND THE HONESTY RULE THAT FOLLOWS FROM IT. `PrerenderedPage` has only its
 * primary key. A prefix search is a primary-key range and cheap; anything else — freshness,
 * status, indexability — has no index, so the dropdown filters apply WITHIN the fetched page
 * and the UI says "filtering this page", never implying a table-wide query. `content` (a
 * multi-megabyte Blob) is never selected for the table; the *view HTML* action streams it from
 * a dedicated route, served as text/plain so stored markup can never execute against this
 * console's super-user session.
 */

import { ago, card, el, ICONS, link, num, pill, spacer, table, unwired } from '../ui.js';
import { pageContentUrl } from '../api.js';

export const meta = { id: 'pages', label: 'Page cache', crumb: 'page cache', icon: ICONS.pages };

const PAGE_SIZE = 50;

export async function load(ctx) {
	const res = await ctx.get('pages', {
		prefix: ctx.data.prefix ?? '',
		cursor: ctx.data.cursor ?? '',
		limit: PAGE_SIZE,
	});
	ctx.data.page = res.ok ? res.body : null;
	ctx.data.error = res.ok ? null : (res.body?.error ?? `Could not load the page cache (${res.status})`);
}

export function render(ctx) {
	const data = ctx.data.page;
	if (!data) return el('div', { cls: 'note bad', text: ctx.data.error ?? 'No page-cache data.' });

	return [
		el('div', { cls: 'view-head' }, [
			el('span', { cls: 'eyebrow', text: 'Page cache' }),
			el('span', {
				cls: 'muted mono',
				text: `${num(data.total?.recordCount)} pages${data.total?.estimatedRange ? ` (±${num(data.total.estimatedRange)})` : ''}`,
			}),
			spacer(),
		]),
		browser(ctx, data),
		quality(),
	];
}

function browser(ctx, data) {
	const search = el('input', {
		cls: 'mono',
		type: 'text',
		value: ctx.data.prefix ?? '',
		placeholder: 'Cache-key prefix, e.g. www.example.com/catalog',
	});

	const go = () => {
		ctx.data.prefix = search.value;
		ctx.data.cursor = '';
		ctx.data.cursors = [];
		ctx.reload();
	};
	search.addEventListener('keydown', (event) => {
		if (event.key === 'Enter') go();
	});

	// In-page display filters. These never issue a query — see the module comment.
	const filters = ctx.data.filters ?? { fresh: '', indexable: '' };
	const filterSelect = (key, options) => {
		const select = el(
			'select',
			null,
			options.map(([value, label]) => el('option', { value, text: label, selected: filters[key] === value || null }))
		);
		select.addEventListener('change', () => {
			ctx.data.filters = { ...filters, [key]: select.value };
			ctx.render();
		});
		return select;
	};

	const rows = (data.pages ?? [])
		.filter((page) => {
			if (filters.fresh === 'fresh' && !page.fresh) return false;
			if (filters.fresh === 'stale' && page.fresh) return false;
			if (filters.indexable && String(page.isIndexable) !== filters.indexable) return false;
			return true;
		})
		.map((page) =>
			el('tr', null, [
				el('td', { cls: 'mono truncate', style: { maxWidth: '420px' }, title: page.cacheKey, text: page.cacheKey }),
				el('td', {
					cls: 'mono',
					style: { color: page.statusCode === 200 ? 'var(--ok)' : 'var(--bad)' },
					text: page.statusCode,
				}),
				el('td', null, [page.fresh ? pill('fresh', 'ok') : pill('stale', 'warn')]),
				el('td', { cls: 'muted', text: ago(page.lastCached) }),
				el('td', { cls: 'muted', text: page.expiresAt ? ago(page.expiresAt) : '—' }),
				el('td', {
					cls: 'mono',
					style: {
						color: page.isIndexable === true ? 'var(--ok)' : page.isIndexable === false ? 'var(--bad)' : 'var(--fg-2)',
					},
					text: page.isIndexable === null || page.isIndexable === undefined ? 'unknown' : String(page.isIndexable),
				}),
				el('td', null, [
					el('div', { cls: 'row-actions' }, [
						// A plain link, target _blank: the route answers text/plain with its own
						// nosniff header, so the browser shows the stored markup as text.
						el('a', {
							cls: 'mono',
							style: { fontSize: '11px', color: 'var(--teal-300)' },
							href: pageContentUrl(page.cacheKey),
							target: '_blank',
							rel: 'noopener',
							text: 'view HTML',
						}),
						link('explain →', () =>
							ctx.go('explain', { input: { url: page.url ?? '', deviceType: page.deviceType ?? '' }, result: null })
						),
					]),
				]),
			])
		);

	const filtered = (data.pages ?? []).length - rows.length;

	return el('div', { cls: 'card' }, [
		el('div', { cls: 'card-head' }, [
			el('div', { cls: 'searchbox', style: { maxWidth: '420px' } }, [search]),
			el('button', { text: 'Search', disabled: ctx.busy, onclick: go }),
			spacer(),
			filterSelect('fresh', [
				['', 'Freshness: all'],
				['fresh', 'fresh'],
				['stale', 'stale'],
			]),
			filterSelect('indexable', [
				['', 'Indexable: all'],
				['true', 'true'],
				['false', 'false'],
			]),
		]),
		filtered > 0 &&
			el('div', { style: { padding: '8px 18px' } }, [
				el('div', {
					cls: 'note info',
					text: `Filtering this fetched page only — ${filtered} of ${data.pages.length} rows hidden. The filters do not query the table (no index on those fields).`,
				}),
			]),
		table(
			['cache key', 'status', 'freshness', 'cached', 'expires', 'indexable', { text: '', right: true }],
			rows,
			data.prefix ? 'No cached pages under this prefix.' : 'The page cache is empty.'
		),
		el('div', { cls: 'card-foot' }, [
			el('span', { text: `${rows.length} shown` }),
			data.truncated && el('span', { text: '· more available' }),
			spacer(),
			(ctx.data.cursors?.length ?? 0) > 0 &&
				link('← prev', () => {
					const cursors = ctx.data.cursors;
					ctx.data.cursor = cursors.pop() ?? '';
					ctx.reload();
				}),
			data.truncated &&
				link('next →', () => {
					(ctx.data.cursors ??= []).push(ctx.data.cursor ?? '');
					ctx.data.cursor = data.nextCursor;
					ctx.reload();
				}),
		]),
	]);
}

/**
 * The panel this console most needs and cannot have yet: nothing stored describes whether a
 * cached page is any GOOD. The incident that motivated this console was a cache full of 200,
 * non-empty, indexable, fresh pages that had lost their scripts and stylesheets — every stored
 * field looked healthy while ~90% of the corpus was gutted.
 */
const quality = () =>
	card('Content quality', {
		body: [
			unwired(
				'Visible-text length, link/image counts and hydration-marker checks per page, trended against the route-class median so outliers stand out.',
				'content-quality fields persisted at render time (processJobResult) — statusCode/bytes/isIndexable cannot distinguish a healthy page from an unhydrated one'
			),
		],
	});
