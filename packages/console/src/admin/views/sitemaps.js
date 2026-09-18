/**
 * Sitemaps: the root list with refresh state, and a per-sitemap detail with a paged entry
 * table.
 *
 * QUERY SHAPE. The list never touches `entries` — a single sitemap row can hold tens of
 * thousands of them, and the list is roots only (children are reachable from their parent).
 * The detail fetches ONE page of entries at a time, sliced server-side; per-entry state comes
 * from bounded point reads on just that page. Text filtering below is within the fetched page
 * and is labelled as such.
 *
 * INGESTED IS NOT CHECKED, and conflating the two misreports a healthy corpus as a stale one.
 * Since plugin v0.69.0 a walk sends `If-Modified-Since`, and a `304` writes NOTHING — the stored
 * row, its validator and its `lastRefreshed` are all still current, so they are deliberately left
 * untouched. That makes `Sitemap.lastRefreshed` the time this document's ENTRIES were last
 * INGESTED, which on a corpus that rebuilds nightly is hours old by design and says nothing about
 * when it was last looked at. When it was last looked at lives on the run row (`SitemapRefresh`),
 * per root. Both are shown, named for what they are: "ingested" on the document, "checked" from
 * the run. A console that prints one under the other's label turns the feature working into an
 * operator chasing a sitemap that is not stale.
 *
 * THE ANALYTICS WINDOW IS 24h AND SHARED. A refresh pass is daily, so an hour-wide window would
 * almost never contain one; 24h is also the key the Change probe view uses, so whichever loaded
 * first inside `management.analytics.cacheTtl` serves the other from the worker's cache. The walk
 * counters are the only cluster-wide view of pass outcomes — the run row above is one root on one
 * node — and `sitemap_not_modified` in particular is the ONLY evidence that conditional fetching
 * is working at all.
 */

import { ago, card, el, ICONS, kv, link, meter, muted, num, pct, pill, spacer, stat, table } from '../ui.js';
import { emptyNote, fmtCount, pick, scanFooter, scopeLabel, sumValues, windowEmpty } from '../charts.js';
import { appliedNote, editTray, loadConfig, settingsCard } from './_configEdit.js';

export const meta = { id: 'sitemaps', label: 'Sitemaps', crumb: 'sitemaps', icon: ICONS.sitemaps };

const PAGE_SIZE = 50;

/** The window the walk counters are read over — a day, because a pass is daily. See the header. */
const WALK_RANGE_MS = 24 * 3_600_000;

export async function load(ctx) {
	const [res, analyticsRes] = await Promise.all([
		ctx.get('sitemaps'),
		ctx.get('analytics', { range: WALK_RANGE_MS }),
		loadConfig(ctx),
	]);
	ctx.data.analytics = analyticsRes.ok ? analyticsRes.body : null;
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
		walkActivity(ctx),
		settings(ctx),
		editTray(ctx),
	];
}

/**
 * When this root was last WALKED, from its run row — as distinct from when its document was last
 * ingested. Null for a child sitemap, which has no run row of its own: `SitemapRefresh` holds one
 * row per root plus the `all` marker, so a child's only timestamp is its ingest.
 */
const checkedAt = (refresh) => {
	const at = refresh?.finishedAt ?? refresh?.lastRefreshed ?? null;
	if (!at) return null;
	const ms = new Date(at).getTime();
	return Number.isFinite(ms) ? ms : null;
};

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
						`${num(sitemap.entryCount)} entries · ingested ${
							sitemap.lastRefreshed ? ago(new Date(sitemap.lastRefreshed).getTime()) : 'never'
						}`,
					]),
					// The run row, not the document row — see the header. A 304 leaves the document's own
					// timestamp alone, so this is the only line that says the sitemap was looked at.
					checkedAt(sitemap.refresh) &&
						el('div', { cls: 'mono muted', style: { fontSize: '11px' } }, [
							`checked ${ago(checkedAt(sitemap.refresh))}`,
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
						['Last walk', checkedAt(refresh) ? ago(checkedAt(refresh)) : '—'],
						refresh.created !== undefined && [
							'Created / updated / removed',
							el('span', null, [
								`${num(refresh.created)} / ${num(refresh.updated)} / ${num(refresh.removed)}`,
								// A SUBSET of `created`, never a fourth number: these are the new targets whose FIRST
								// render was pulled into `sitemap.newTargets.window` instead of waiting out a full
								// interval of jitter. `created - createdSoon` is the bulk-population overflow that
								// fell back to the old behaviour, which is why the denominator is stated.
								refresh.createdSoon !== undefined && refresh.created
									? muted(`  ${num(refresh.createdSoon)} of the creates rendered soon`)
									: null,
							]),
						],
						// THE ONLY PROOF CONDITIONAL FETCHING IS WORKING, per root. A steady zero where the
						// walk sends If-Modified-Since means the origin is not honouring it and every pass is
						// re-parsing and re-scanning documents that did not change.
						refresh.notModified !== undefined && [
							'Not modified (304)',
							el('span', null, [
								`${num(refresh.notModified)} of ${num(refresh.sitemapsProcessed)} documents`,
								refresh.sitemapsProcessed
									? muted(`  ${pct(refresh.notModified, refresh.sitemapsProcessed)} skipped the re-parse`)
									: null,
							]),
						],
						refresh.duplicates ? ['Duplicates (overlapping sitemaps)', num(refresh.duplicates)] : null,
					]),
				]),
		],
	});

	return [header, entryTable(ctx, detail, entries)];
}

function statsRow(detail) {
	const { sitemap, targetCount, refresh } = detail;
	const entryCount = sitemap.entryCount ?? 0;
	const ingested = sitemap.lastRefreshed ? ago(new Date(sitemap.lastRefreshed).getTime()) : 'never';
	const checked = checkedAt(refresh);

	// AN INDEX HAS NO TARGETS OF ITS OWN, structurally: a walk attributes each Target to the
	// sitemap that actually listed the URL, which is always a child. So "Targets 0 / Coverage 0%"
	// on an index is not a finding, it is the shape of the data — and it reads as a total failure
	// of the largest sitemap in the deployment. Count what an index does have instead.
	if (sitemap.isIndex) {
		return el('div', { style: STATS_GRID }, [
			statCell('Child sitemaps', num(entryCount), muted('listed by this index')),
			statCell(
				'Child list ingested',
				ingested,
				// NOT "last walked". A 304 on an index says its CHILD LIST is unchanged, and the walk
				// still descends into every child — so this document can be hours old while the corpus
				// behind it was rebuilt minutes ago.
				muted(checked ? `this document, not its children · checked ${ago(checked)}` : 'this document, not its children')
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
		// A CHILD HAS NO RUN ROW, so this is usually the only timestamp it carries — and it is an
		// INGEST, not a check. Under conditional fetching a child that has not changed is fetched on
		// every pass and written on none of them, so an hours-old figure here is the normal steady
		// state rather than a walk that stopped reaching it.
		statCell(
			'Entries ingested',
			ingested,
			muted(checked ? `checked ${ago(checked)}` : 'when this document last changed — not when it was checked')
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
 * Every walk that finished in the last day, across every root and every node.
 *
 * WHY IT IS NOT THE RUN ROW ABOVE. `SitemapRefresh` holds the LAST run per root, on whichever node
 * claimed it. These counters are one emit per finished run, so they sum passes — which is the only
 * way to see a root that ran three times, or a node whose walks are failing while another node's
 * succeed. They are also the only home for the two numbers a rollout is judged on:
 *
 *   not modified   documents the origin answered `304` to, so their entries were never re-parsed
 *                  and their prune scan never ran. On a healthy corpus this is most of every pass
 *                  between rebuilds. A steady ZERO where conditional fetching is enabled means the
 *                  origin is not honouring `If-Modified-Since` and every pass is doing full work —
 *                  and nothing else anywhere reports that, because the walk still succeeds.
 *   rendered soon  new targets whose first render was pulled into `sitemap.newTargets.window`
 *                  instead of waiting out a full interval of jitter. A SUBSET of created, so the
 *                  gap between the two is the per-run cap sending the overflow back to the old
 *                  behaviour — which is what a bulk first ingest is supposed to look like.
 *
 * VALUE SEMANTICS: each row is one emit per RUN carrying that run's count, so the sum is
 * Σ(mean × count) — `sumValues`, never `sumCount`, which would count runs.
 */
function walkActivity(ctx) {
	const data = ctx.data.analytics;
	if (!data || data.available === false) return null;

	const combos = pick(data, 'prerender_ops', (s) => typeof s.path === 'string' && s.path.startsWith('sitemap_'));
	const totalOf = (series) => sumValues(combos.filter((s) => s.path === `sitemap_${series}`));
	const documents = totalOf('sitemaps');
	const notModified = totalOf('not_modified');
	const created = totalOf('created');
	const createdSoon = totalOf('created_soon');
	const updated = totalOf('updated');
	const skipped = totalOf('skipped');
	const removed = totalOf('removed');
	const failed = totalOf('failed');

	const title = `Walk activity — ${scopeLabel(data)}, last 24h`;
	if (windowEmpty(data) || !combos.length) {
		return card(title, {
			body: [
				emptyNote('sitemap walk', data),
				el('p', { cls: 'muted chart-note' }, [
					'These counters are emitted once per FINISHED walk. A refresh pass is daily, so an empty panel ',
					'most often means no walk completed inside the window — press Refresh all above, or check that ',
					el('code', { text: 'sitemap.node' }),
					' names a node that is still in the cluster.',
				]),
			],
			foot: [scanFooter(data)],
		});
	}

	// Zero 304s across a day of walks is the conditional-fetch rollout not working. It is not an
	// error anywhere — the walks succeed, the corpus is correct — it just costs a full re-parse and
	// a prune scan per document, forever, which is the entire saving the feature was for.
	const conditionalDead = documents > 0 && notModified === 0;

	return card(title, {
		head: [failed > 0 ? pill(`${fmtCount(failed)} failed`, 'bad') : null, spacer()],
		body: [
			conditionalDead &&
				el('div', { cls: 'note warn' }, [
					el('strong', { text: 'No document was answered 304 in this window. ' }),
					'Every walk re-parsed every sitemap and re-ran its prune scan. Conditional fetching sends ',
					el('code', { text: 'If-Modified-Since' }),
					' from the stored validator, so a flat zero means either the origin ignores it or nothing has ',
					'a stored validator yet — the first pass after an upgrade is legitimately all-zero here, a ',
					'week of them is not.',
				]),
			el('div', { cls: 'stats' }, [
				stat('Documents fetched', fmtCount(documents), 'attempts across every finished walk, failures included'),
				stat(
					'Not modified',
					documents ? pct(notModified, documents) : '—',
					`${fmtCount(notModified)} skipped the re-parse and the prune scan`,
					{ warn: conditionalDead }
				),
				stat(
					'Targets created',
					fmtCount(created),
					created
						? `${pct(createdSoon, created)} rendered soon rather than waiting out the jitter`
						: 'nothing new was declared'
				),
				stat('Re-attributed', fmtCount(updated), 'moved between sitemaps — the page did not change'),
				stat('Unchanged', fmtCount(skipped), 'already correct, no write'),
				stat('Unlinked', fmtCount(removed), 'left the sitemap that declared them'),
				stat('Failed', fmtCount(failed), 'child sitemaps a walk could not read', { warn: failed > 0 }),
			]),
			el('p', { cls: 'muted chart-note' }, [
				'One emit per finished walk, summed across roots and nodes — so these are passes, not the state ',
				'of any one sitemap; the panel above is that. “Rendered soon” is a SUBSET of created, capped per ',
				'run by ',
				el('code', { text: 'sitemap.newTargets.maxPerRun' }),
				', and the overflow falls back to full-interval jitter, which is what a bulk first ingest is ',
				'meant to look like. A 304 is still an origin request; what it saves is this side’s work.',
			]),
		],
		foot: [scanFooter(data)],
	});
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
