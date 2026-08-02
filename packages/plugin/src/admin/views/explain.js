/**
 * URL explainer: the cache key a URL resolves to and the live rows stored under it.
 *
 * The hedging in this view is deliberate and carried over from the page it replaces:
 *
 *   - A row whose read TIMED OUT is "unknown", never "absent". Rendering a degraded response
 *     with the same wording as a confirmed absence turns it into a confident false negative —
 *     exactly the wrong thing to hand someone debugging a missing page.
 *   - "Not scheduled" is only asserted from an AUTHORITATIVE read. RenderSchedule rows are
 *     residency-pinned; when this node is not the owner and the owner could not be reached, an
 *     absent local row means "not scheduled HERE", and the view says so.
 */

import { ago, boolText, card, duration, el, ICONS, kv, link, mono, muted, pill, spacer, unwired } from '../ui.js';

export const meta = { id: 'explain', label: 'Explain URL', crumb: 'explain', icon: ICONS.explain };

// Explain fetches on demand, not on view load.
export async function load() {}

export function render(ctx) {
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

	async function submit() {
		ctx.data.input = { url: url.value, deviceType: device.value };
		button.disabled = true;
		const res = await ctx.post('explain', { url: url.value, deviceType: device.value || undefined });
		ctx.data.result = res;
		ctx.render();
	}

	button.addEventListener('click', submit);
	url.addEventListener('keydown', (event) => {
		if (event.key === 'Enter') submit();
	});

	const result = ctx.data.result;

	return [
		el('div', { cls: 'view-head' }, [el('span', { cls: 'eyebrow', text: 'Explain URL' }), spacer()]),
		card(null, {
			body: [
				el('div', { cls: 'toolbar' }, [url, device, button]),
				el('p', { cls: 'muted', style: { margin: '12px 0 0' } }, [
					'Shows the cache key this URL resolves to and the live rows stored under it — the fastest ' +
						'way to explain a page that never seems to hit cache.',
				]),
			],
		}),
		result && !result.ok && el('div', { cls: 'note bad', text: result.body?.error ?? 'Explain failed' }),
		result?.ok && explanation(ctx, result.body),
	];
}

// Did this row's read time out? See the module comment: unknown, never absent.
const timedOut = (data, name) => !!data.degraded?.timedOutReads?.includes(name);

const emptyState = (data, name, absentText) =>
	muted(timedOut(data, name) ? 'Read timed out — status unknown, not necessarily absent.' : absentText);

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
						])
					: emptyState(data, 'prerenderedPage', 'No cached page under this key.'),

				el('h3', { cls: 'subhead', text: 'RenderSchedule' }),
				schedule
					? kv([
							['Next render', (schedule.overdue ? 'overdue by ' : 'in ') + duration(schedule.dueInMs)],
							['From sitemap', boolText(schedule.fromSitemap)],
						])
					: emptyState(
							data,
							'renderSchedule',
							data.residency && !data.residency.scheduleAuthoritative
								? `No schedule row on this node — inconclusive, since ${data.residency.scheduleOwnedBy} owns it.`
								: 'Not scheduled — nothing will render this URL.'
						),

				el('h3', { cls: 'subhead', text: 'RenderTarget' }),
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
						])
					: emptyState(data, 'renderTarget', 'No target — not in the recurring rotation.'),

				el('h3', { cls: 'subhead', text: 'Content quality' }),
				unwired(
					'Visible-text length vs the route-class median, hydration-marker checks, link and image counts for the stored HTML.',
					'content-quality fields persisted at render-result time, and the audit detectors shared into this package'
				),

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
	if (data.verdict.suppressedByNonIndexable) {
		note('bad', [
			'A NonIndexable row suppresses this URL: a render judged it non-indexable, which deleted its ' +
				'render target and blocks re-discovery until the row expires. If that verdict was wrong, ' +
				'this page is silently out of SEO rotation.',
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
	}

	return children;
}
