/**
 * Inspect: one URL — or one prefix of them — and everything this system knows about it.
 *
 * WHY THIS IS ONE VIEW. "Explain URL" and "Page cache" were the same question asked at two
 * granularities: I have a URL, or the shape of one, tell me what happened to it. Split across
 * two tabs, the path an operator actually walks — browse by prefix, spot a suspicious key, ask
 * why it looks like that — crossed a view boundary in the middle, and crossing it dropped the
 * prefix, the cursor and the filters that got you there.
 *
 * The tell that they were ONE capability rather than two: both declared the SAME missing
 * content-quality panel, in near-identical words, at explain.js:190 and pages.js:194. A gap
 * written down twice, in two files, by two views is a seam through one thing — not a boundary
 * between two. Merged, that declaration exists once (`quality` below), and drilling from a
 * browsed row into its explanation is a local state update rather than `ctx.go('explain', …)`:
 * the row fills the explainer at the top and runs it in place, and everything you browsed to
 * get there is still on screen underneath.
 *
 * THE HEDGING IN THE EXPLAINER HALF IS DELIBERATE, and carried over unchanged:
 *
 *   - A row whose read TIMED OUT is "unknown", never "absent". Rendering a degraded response
 *     with the same wording as a confirmed absence turns it into a confident false negative —
 *     exactly the wrong thing to hand someone debugging a missing page.
 *   - "Not scheduled" is only asserted from an AUTHORITATIVE read. RenderSchedule rows are
 *     residency-pinned; when this node is not the owner and the owner could not be reached, an
 *     absent local row means "not scheduled HERE", and the view says so.
 *   - The same rule covers "below the claim floor" and "leased", which are answers about the
 *     OWNER's node-local shared buffer. The owner computes both and this view consumes them
 *     verbatim; it never compares a row against the querying node's own floor.
 *
 * THE BROWSE HALF'S QUERY SHAPE, AND THE HONESTY RULE THAT FOLLOWS FROM IT. `PrerenderedPage`
 * has only its primary key. A prefix search is a primary-key range and cheap; anything else —
 * freshness, status, indexability — has no index, so the dropdown filters apply WITHIN the
 * fetched page and the UI says "filtering this page", never implying a table-wide query.
 * `content` (a multi-megabyte Blob) is never selected for the table; the *view HTML* action
 * streams it from a dedicated route, served as text/plain so stored markup can never execute
 * against this console's super-user session.
 *
 * SCRATCH KEYS, now one namespace: `input` / `result` / `revalidate` belong to the explainer,
 * `prefix` / `cursor` / `cursors` / `filters` / `browse` / `browseError` to the prefix browser.
 * The last two are renamed from the bare `page` / `error` they carried as their own view —
 * sharing a scratch, neither name said which half it belonged to, and `page` sat one glance
 * away from the explainer's own `rows.prerenderedPage`.
 */

import {
	ago,
	boolText,
	card,
	duration,
	el,
	ICONS,
	kv,
	link,
	mono,
	muted,
	num,
	pill,
	spacer,
	table,
	unwired,
} from '../ui.js';
import { pageContentUrl } from '../api.js';
import { appliedNote, editTray, loadConfig, settingsCard } from './_configEdit.js';

export const meta = { id: 'inspect', label: 'Inspect', crumb: 'inspect', icon: ICONS.explain };

const PAGE_SIZE = 50;

/**
 * Only the browse half loads up front. The explainer still fetches on demand — it needs a URL,
 * and a deep link that arrives with one (`{ input, result: null }`) deliberately pre-fills the
 * form without spending an explain the operator may not have asked for.
 */
export async function load(ctx) {
	const [res] = await Promise.all([
		ctx.get('pages', {
			prefix: ctx.data.prefix ?? '',
			cursor: ctx.data.cursor ?? '',
			limit: PAGE_SIZE,
		}),
		// Concurrent with the browse: paging through the cache must not pay for a config read it
		// almost always already has in the shared scratch.
		loadConfig(ctx),
	]);
	ctx.data.browse = res.ok ? res.body : null;
	ctx.data.browseError = res.ok ? null : (res.body?.error ?? `Could not load the page cache (${res.status})`);
}

export function render(ctx) {
	const data = ctx.data.browse;

	return [
		el('div', { cls: 'view-head' }, [
			el('span', { cls: 'eyebrow', text: 'Inspect' }),
			data &&
				el('span', {
					cls: 'muted mono',
					text: `${num(data.total?.recordCount)} pages${data.total?.estimatedRange ? ` (±${num(data.total.estimatedRange)})` : ''}`,
				}),
			spacer(),
		]),
		appliedNote(ctx),
		...explainer(ctx),
		// A dead page-cache read must not take the explainer down with it. As its own view a
		// failed browse could early-return the whole screen; here that same return would also
		// remove the one panel that still works — and the explainer reads different rows through
		// a different route, so it is very often the half that survives.
		data ? browser(ctx, data) : el('div', { cls: 'note bad', text: ctx.data.browseError ?? 'No page-cache data.' }),
		quality(),
		...settings(ctx),
		editTray(ctx),
	];
}

/**
 * Explain one URL and redraw. THE MERGE POINT: the form's own button and a browsed row's
 * "explain" action both land here. That is what makes drilling into a row a state update
 * instead of the view switch it used to be — the prefix, the cursor and the filters below
 * survive it, so the next key you want to look at is still one click away.
 *
 * `input` is stored BEFORE the await so a failed or slow explain still leaves the form showing
 * what was asked.
 */
async function runExplain(ctx, input) {
	ctx.data.input = input;
	const res = await ctx.post('explain', { url: input.url, deviceType: input.deviceType || undefined });
	ctx.data.result = res;
	ctx.render();
}

function explainer(ctx) {
	const saved = ctx.data.input ?? { url: '', deviceType: '' };

	const url = el('input', {
		cls: 'mono',
		type: 'text',
		value: saved.url,
		placeholder: 'https://www.example.com/catalog/x.jsp?CN=a',
		style: { flex: '1', minWidth: '260px' },
	});
	const device = el(
		'select',
		null,
		['', 'desktop', 'mobile', 'tablet'].map((option) =>
			el('option', { value: option, text: option || '(default)', selected: option === saved.deviceType || null })
		)
	);
	const button = el('button', { cls: 'primary', text: 'Explain', disabled: ctx.busy });

	function submit() {
		button.disabled = true;
		return runExplain(ctx, { url: url.value, deviceType: device.value });
	}

	button.addEventListener('click', submit);
	url.addEventListener('keydown', (event) => {
		if (event.key === 'Enter') submit();
	});

	const result = ctx.data.result;

	return [
		// Built by hand rather than with `card()`: that helper decides whether to draw a head with
		// `(title || head.length)`, which for a title-less, head-less card is the NUMBER 0 — and 0 is
		// not one of the falsy holes `append` skips, so it lands in the card as a literal "0" above
		// the form. The explainer is the only card in the console with neither, and ui.js is not this
		// file's to fix.
		el('div', { cls: 'card' }, [
			el('div', { cls: 'card-body' }, [
				el('div', { cls: 'toolbar' }, [url, device, button]),
				el('p', { cls: 'muted', style: { margin: '12px 0 0' } }, [
					'Shows the cache key this URL resolves to and the live rows stored under it — the fastest ' +
						'way to explain a page that never seems to hit cache. Browsing by prefix below fills this in.',
				]),
			]),
		]),
		result && !result.ok && el('div', { cls: 'note bad', text: result.body?.error ?? 'Explain failed' }),
		result?.ok && explanation(ctx, result.body),
	];
}

// Did this row's read time out? See the module comment: unknown, never absent.
const timedOut = (data, name) => !!data.degraded?.timedOutReads?.includes(name);

const emptyState = (data, name, absentText) =>
	muted(timedOut(data, name) ? 'Read timed out — status unknown, not necessarily absent.' : absentText);

/** One line for the target card: why, how many strikes, and since when. */
const suppressionSummary = (s) =>
	[
		s.reason ?? 'non-indexable',
		Number.isFinite(s.strikes) ? `${s.strikes}/${s.maxStrikes} strikes` : null,
		s.suppressedAt ? ago(s.suppressedAt) : null,
	]
		.filter(Boolean)
		.join(' · ');

function explanation(ctx, data) {
	const page = data.rows.prerenderedPage;
	const schedule = data.rows.renderSchedule;
	const target = data.rows.renderTarget;

	return [
		card('Resolved key', {
			body: [
				notes(data),
				kv([
					['Cache key', el('code', { cls: 'break', text: data.resolved.cacheKey })],
					['Canonical URL', el('code', { cls: 'break', text: data.resolved.canonicalUrl })],
					['Device type', data.resolved.deviceType],
					['Ingress mode', data.ingress.mode],
					[
						'Route class',
						el('span', null, [
							el('code', { text: data.ingress.routeClass }),
							muted(data.eligibility.prerendered ? '  cached + scheduled' : '  proxied live, never cached'),
						]),
					],
					[
						'Query allowlist',
						el('span', null, [
							el('code', { text: `[${data.allowlist.used.join(', ')}]` }),
							muted(`  ${data.allowlist.source}`),
						]),
					],
					data.ingress.route && [
						'Matched route',
						el('span', null, [
							el('code', { text: `${data.ingress.route.match} ${data.ingress.route.path}` }),
							muted(`  ${data.ingress.route.source}`),
						]),
					],
				]),
				verdictPills(data, page),
			],
		}),
		card('Stored rows', {
			body: [
				el('h3', { cls: 'subhead', text: 'PrerenderedPage' }),
				page
					? kv([
							['Status code', mono(page.statusCode)],
							['Last cached', ago(page.lastCached)],
							['Expires', page.expiresAt ? ago(page.expiresAt) : '—'],
							['Fresh', page.fresh ? pill('yes', 'ok') : pill('no', 'warn')],
							['Indexable', page.isIndexable === null ? 'unknown' : String(page.isIndexable)],
							// Same route the browse table's action uses, so the stored body is one click
							// from the explanation of it rather than only from a table row.
							[
								'Stored HTML',
								el('a', {
									cls: 'mono',
									style: { fontSize: '11px', color: 'var(--teal-300)' },
									href: pageContentUrl(data.resolved.cacheKey),
									target: '_blank',
									rel: 'noopener',
									text: 'view HTML',
								}),
							],
						])
					: emptyState(data, 'prerenderedPage', 'No cached page under this key.'),

				el('h3', { cls: 'subhead', text: 'RenderSchedule' }),
				schedule
					? kv([
							// A LEASED ROW IS NOT A LATE ROW. Since the lease left `nextRenderTime`, a row
							// keeps its past due time for the whole time it is being rendered, so
							// `overdue` is true for every in-flight job and "overdue by 9m" alone stops
							// meaning "the queue is behind on this key". Say which it is.
							[
								'Next render',
								schedule.leased
									? // SIGNED. `duration()` takes an absolute value, so a hard-coded " ago" printed
										// "was due 9h ago" for a row due in nine hours — which a leased row genuinely
										// can be, since the slow retry lane and a redirect reschedule move the row
										// while the lease is still held.
										`claimed, lease expires ${ago(schedule.leaseExpiresAt)} (${
											schedule.overdue
												? `was due ${duration(schedule.dueInMs)} ago`
												: `due in ${duration(schedule.dueInMs)}`
										})`
									: (schedule.overdue ? 'overdue by ' : 'in ') + duration(schedule.dueInMs),
							],
							['From sitemap', boolText(schedule.fromSitemap)],
						])
					: emptyState(
							data,
							'renderSchedule',
							data.residency && !data.residency.scheduleAuthoritative
								? `No schedule row on this node — inconclusive, since ${data.residency.scheduleOwnedBy} owns it.`
								: 'Not scheduled — nothing will render this URL.'
						),

				el('h3', { cls: 'subhead', text: 'Target' }),
				target
					? kv([
							[
								'Sitemap',
								target.sitemapUrl
									? link(`${target.sitemapUrl} →`, () => ctx.go('sitemaps', { selected: target.sitemapUrl }))
									: '—',
							],
							['Scheduler node', mono(target.schedulerNode ?? '—')],
							['Render interval', target.renderInterval ? duration(Number(target.renderInterval)) : 'default'],
							['State', target.state === 'suppressed' ? pill('suppressed', 'warn') : pill('active', 'ok')],
							data.rows.suppression && ['Suppressed', suppressionSummary(data.rows.suppression)],
						])
					: emptyState(data, 'renderTarget', 'No target — not in the recurring rotation.'),

				revalidate(ctx, data, target, schedule),
			],
		}),
	];
}

function verdictPills(data, page) {
	return el('div', { cls: 'toolbar', style: { marginTop: '14px' } }, [
		// A timed-out read must never render as a confident verdict: an unread page row is
		// "unknown", not "miss".
		timedOut(data, 'prerenderedPage')
			? pill('unknown — cache read timed out')
			: page?.fresh
				? pill('cache hit', 'ok')
				: pill(page ? 'stale — origin or render' : 'miss — origin or render', 'warn'),
		page?.inStaleWhileRevalidate && pill('serving stale-while-revalidate'),
		timedOut(data, 'renderTarget')
			? pill('unknown — target read timed out')
			: data.verdict.recurring
				? pill('recurring target', 'ok')
				: pill('no render target', 'warn'),
	]);
}

function notes(data) {
	const out = [];
	const note = (kind, children) =>
		out.push(el('div', { cls: `note ${kind}`.trim(), style: { marginBottom: '10px' } }, children));

	if (data.underGlobalAllowlist.differs) {
		note('warn', [
			`This URL keys differently under the matched route allowlist (${data.allowlist.used.join(', ')}) ` +
				`than under the global url.queryParams (${data.underGlobalAllowlist.allowlist.join(', ')}). ` +
				'That difference is the usual cause of a permanent cache miss — check that the route is ' +
				'present and ordered correctly.',
		]);
	}
	if (data.ingress.routeClass === 'unclassified') {
		note('warn', [
			'No route matched this path, so all query params are kept and the page is proxied but never ' +
				'cached. Either add a prerender route for it, declare it as a passthrough route if it is ' +
				'deliberately not prerendered, or stop the CDN forwarding it here.',
		]);
	}
	if (data.verdict.suppressed) {
		const s = data.rows.suppression;
		note('bad', [
			`This target is suppressed: a render judged it non-indexable` +
				(s?.reason ? ` (${s.reason})` : '') +
				(s?.strikes ? `, ${s.strikes}/${s.maxStrikes} strikes` : '') +
				'. It blocks re-discovery and re-checks itself on its own schedule — the next render lifts ' +
				'the suppression if the page is indexable again, or deletes the target at the strike limit.',
		]);
	}
	if (data.ingress.routeClass === 'passthrough') {
		note('', [
			data.eligibility.excludedByPattern
				? `Matches excludePathPatterns (${data.eligibility.excludedByPattern}) — proxied live, never scheduled for rendering.`
				: 'Declared as a passthrough route — proxied live and deliberately never prerendered.',
		]);
	}
	if (!data.eligibility.domainAllowed) {
		note('warn', ['Host is outside the domains allowlist — it will be rendered but force-marked non-indexable.']);
	}
	if (data.resolved.deviceTypeFellBack) {
		note('', [
			`The requested device type is not in deviceTypes.supported and fell back to "${data.resolved.deviceType}".`,
		]);
	}
	if (data.degraded) {
		note('bad', [
			`These reads timed out and are shown as empty: ${data.degraded.timedOutReads.join(', ')}. ` +
				'Treat those rows as unknown, not absent.',
		]);
	}
	if (data.residency && !data.residency.scheduleReadIsAuthoritative) {
		if (data.residency.scheduleAuthoritative) {
			// The owner answered — say so, since the row came from a different node than the rest
			// of the response.
			note('ok', [
				`The schedule row is owned by ${data.residency.scheduleOwnedBy} and was fetched from it, so it ` +
					`is authoritative. Everything else was read on ${data.residency.queriedNode}.`,
			]);
		} else {
			note('warn', [
				'RenderSchedule rows are pinned to the node owning the URL, and this node ' +
					`(${data.residency.queriedNode}) is not the owner — ${data.residency.scheduleOwnedBy} is. ` +
					'Could not reach the owner' +
					(data.residency.peerError ? ` (${data.residency.peerError})` : '') +
					', so the row below is this node’s local copy: an absent one means "not scheduled on ' +
					'this node", not "not scheduled".',
			]);
		}
	}
	return out;
}

// Make this one key due now. Scoped to a single row on purpose: the collection-level revalidate
// takes a search target, and pointed at the whole registry it would queue every target at once.
function revalidate(ctx, data, target, schedule) {
	const key = data.resolved.cacheKey;
	const result = ctx.data.revalidate?.cacheKey === key ? ctx.data.revalidate : null;

	const button = el('button', {
		cls: 'primary',
		text: 'Render this URL now',
		// A key with no target has no rotation to rejoin; the server rejects it, but there is no
		// reason to offer the click. An unread (timed-out) target is still offered — the server
		// is the authority, and refusing on an unknown would be its own false negative.
		disabled: !target && !timedOut(data, 'renderTarget'),
	});

	button.addEventListener('click', async () => {
		button.disabled = true;
		const res = await ctx.post('revalidate', {
			url: data.input.url,
			deviceType: data.input.deviceType || undefined,
		});
		button.disabled = false;
		ctx.data.revalidate = {
			cacheKey: key,
			ok: res.ok,
			body: res.body,
			error: res.ok ? null : (res.body?.error ?? 'Could not mark this URL for render'),
		};
		ctx.render();
	});

	const children = [
		el(
			'div',
			{ cls: 'toolbar', style: { borderTop: '1px solid var(--border-1)', paddingTop: '14px', marginTop: '18px' } },
			[
				button,
				muted(
					!target && !timedOut(data, 'renderTarget')
						? 'No target under this key, so there is no recurring rotation to rejoin.'
						: 'Sets this one key due immediately. Never touches any other row.'
				),
			]
		),
	];

	if (result?.ok) {
		children.push(
			el('div', { cls: 'note ok', style: { marginTop: '10px' } }, [
				result.body.wokeLocalConsumers
					? 'Marked due now. This node owns the row and its consumers were woken, so the render should start shortly.'
					: `Marked due now. ${result.body.scheduleOwnedBy} owns this row and will claim it on its next ` +
						'status sync — the write is residency-routed, so it landed on that node.',
			])
		);
	} else if (result) {
		children.push(el('div', { cls: 'note bad', style: { marginTop: '10px' }, text: result.error }));
	} else if (!schedule && target && !timedOut(data, 'renderSchedule') && data.residency?.scheduleAuthoritative) {
		// The state this button exists for: a target with no schedule renders nothing, and
		// nothing else in the system will restore the row for a URL outside every sitemap.
		//
		// Gated on an AUTHORITATIVE read. If the owner could not be reached, an absent row means
		// "not here", and asserting the diagnosis off that would be the same false negative the
		// wording elsewhere is careful to avoid.
		children.push(
			el('div', { cls: 'note warn', style: { marginTop: '10px' } }, [
				'This key has a target but no schedule row, so nothing will render it. If the URL is not in ' +
					'a sitemap, no other code path re-creates that row — use the button above, or let this ' +
					'node’s periodic repair sweep pick it up.',
			])
		);
	} else if (schedule?.belowClaimFloor && data.residency?.scheduleAuthoritative) {
		// STRUCTURALLY THE SAME BUG AS THE ONE ABOVE, and it needs its own case because the row
		// EXISTS: without this the view above says "overdue by 9m" and reads as healthy-but-late,
		// when in fact no claim will ever look at this key again. The repair sweep cannot see it
		// either — it tests row existence, and the row is there.
		//
		// Gated on an authoritative read for the same reason, and doubly so here: the claim floor is
		// node-local state about the OWNER's slice of the table, so a non-owner's floor answers a
		// different question entirely.
		children.push(
			el('div', { cls: 'note bad', style: { marginTop: '10px' } }, [
				`This key is scheduled BELOW ${data.residency.scheduleOwnedBy}’s claim floor, so nothing will ` +
					'claim it and nothing will report an error. A due time written straight to the table (the ' +
					'operations API, or a PUT to the exported RenderSchedule endpoint) is the usual cause — no ' +
					'plugin code runs in those paths, so the floor is not lowered to cover the write. It clears on ' +
					'the owner’s next floor reset (queue.claimFloor.resetInterval), or immediately with the queue ' +
					'action reset-claim-floor on that node. The button above also fixes it: it writes through the ' +
					'schedule funnel, which lowers the floor with the row.',
			])
		);
	}

	return children;
}

// ---- prefix browser ---------------------------------------------------------

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
		.map((page) => {
			// Drills UP, not across: this used to be `ctx.go('explain', …)`, which threw away the
			// prefix, page and filters that found the row. Now it runs the explainer above with
			// this row's URL, and the table you were reading is still underneath the answer.
			const explainHere = link('explain ↑', () => {
				explainHere.disabled = true;
				runExplain(ctx, { url: page.url ?? '', deviceType: page.deviceType ?? '' });
			});

			return el('tr', null, [
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
						explainHere,
					]),
				]),
			]);
		});

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
 * The panel this console most needs and cannot have yet — declared ONCE, which is the whole
 * argument for this file existing. Nothing stored describes whether a cached page is any GOOD.
 * The incident that motivated this console was a cache full of 200, non-empty, indexable, fresh
 * pages that had lost their scripts and stylesheets: every stored field looked healthy while
 * ~90% of the corpus was gutted, and neither the single-URL explanation above nor the table of
 * them could have said so.
 */
const quality = () =>
	card('Content quality', {
		body: [
			unwired(
				'Visible-text length, link/image counts and hydration-marker checks — for the one stored page ' +
					'explained above, and per row in the table — trended against the route-class median so ' +
					'outliers stand out.',
				'content-quality fields persisted at render-result time (processJobResult) and the audit ' +
					'detectors shared into this package — statusCode/bytes/isIndexable cannot distinguish a ' +
					'healthy page from an unhydrated one'
			),
		],
	});

// ---- settings ---------------------------------------------------------------
//
// The lifetime and cache-key groups fail in opposite directions and the descriptions have to say
// so. A lifetime change is cheap and reversible; a cache-key change orphans the whole stored corpus
// at once, and the orphaning is INVISIBLE in the table above — the rows are still there, they are
// just under keys nothing computes any more.

const settings = (ctx) => [
	settingsCard(ctx, {
		title: 'Cached-page lifetimes',
		prefix: 'page',
		description:
			'The freshness column above is these values read against each row. ttl and minTtl are stamped onto ' +
			'a target as its render interval when a sitemap is ingested, so changing them reaches the corpus at ' +
			'the next refresh rather than now; swrTtl is applied at serve time, so it re-dates what counts as ' +
			'stale on the very next read. None of the three evicts a page or schedules a render. blobReadBudgetMs is the ' +
			'serve path only — how long a hit may spend reading the stored body before falling back to the ' +
			'origin — and has no bearing on this table.',
	}),
	settingsCard(ctx, {
		title: 'Cache-key identity',
		prefix: 'cacheKey',
		description:
			'How a URL becomes the cache key — both the one the explainer resolves at the top of this page and ' +
			'the first column of the table. A change reshapes every key at once: stored pages keep the keys they ' +
			'were written under, so they are orphaned rather than migrated — not deleted, just never found ' +
			'again — and the corpus effectively rebuilds from empty as pages re-render. The prefix search above ' +
			'is a primary-key range, so after a change it can only find the new shape.',
	}),
	settingsCard(ctx, {
		title: 'Console page size',
		prefix: 'management.pageSize',
		description:
			'A ceiling on the rows one fetch returns — this view asks for 50, and a lower value here clamps it ' +
			'(it also bounds the sitemap-entry table and the per-entry point reads a sitemap detail does). It ' +
			'changes what one browse click costs, never what is stored, and the dropdowns above still filter ' +
			'only the rows that came back.',
	}),
];
