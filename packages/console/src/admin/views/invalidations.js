/**
 * Bulk invalidations: what is invalidated right now, and the record/clear flow.
 *
 * The API (v0.35.0) was built response-first — coverage, overlaps, precedence and the
 * things it CANNOT do are computed server-side and returned — so this view's job is mostly
 * to show that response verbatim rather than re-derive any of it. Two deliberate UX rules:
 *
 *   PREVIEW IS THE DEFAULT PATH. The primary button runs `dryRun: true` and shows exactly
 *   what would happen (`dryRun` returns the same body as the write, minus the write);
 *   recording is a second, explicit click from inside the preview. One request taking the
 *   whole corpus off the serve path should never be one click from a text field.
 *
 *   AN UNRESOLVABLE ROW IS THE LOUDEST THING ON THE PAGE. A row whose scope no longer names
 *   a configured route looks applied and matches nothing — worse than no row — so it gets
 *   the bad pill, not a footnote.
 *
 * WHAT AN INVALIDATION IS DOING is the third panel, and it is the one that needs the analytics
 * window. A row on the table says what is invalidated; it says nothing about what that costs
 * (every refused serve is an origin round trip) or what the two mechanisms built to cut that
 * cost are buying back — per-page verification (plugin v0.63.0: a page the probe has PROVED
 * current is served through the invalidation, `bot_serve` cacheStatus `verified`) and the
 * demand-driven heal (a crawled invalidated page is pulled forward in the queue, with v0.64.0
 * forwarding the heal to the key's owner instead of refusing it as `not-owner`). Those are
 * counters, they live in the analytics scan, and this is the view an operator is on when they
 * ask "is it working". The read is the same one-hour window the overview already holds, so on a
 * warm cache it costs no scan at all.
 */

import { ago, card, el, ICONS, kv, mono, muted, num, pct, pill, spacer, stat, table } from '../ui.js';
import {
	barList,
	emptyNote,
	fmtCount,
	pick,
	scanFooter,
	scopeLabel,
	SERIES,
	sumCount,
	windowEmpty,
} from '../charts.js';
import { appliedNote, configState, editTray, loadConfig, optionIndex, settingsCard } from './_configEdit.js';

export const meta = { id: 'invalidations', label: 'Invalidations', crumb: 'invalidations', icon: ICONS.invalidations };

export async function load(ctx) {
	const [res, analyticsRes] = await Promise.all([
		ctx.get('invalidations'),
		// The same range key Overview, Queue and Nodes use, so this is served from the worker's
		// cache whenever any of them loaded inside management.analytics.cacheTtl.
		ctx.get('analytics', { range: 3_600_000 }),
		loadConfig(ctx),
	]);
	ctx.data.list = res.ok ? res.body : null;
	ctx.data.analytics = analyticsRes.ok ? analyticsRes.body : null;
	ctx.data.error = res.ok ? null : (res.body?.error ?? `Could not load invalidations (${res.status})`);
}

export function render(ctx) {
	const data = ctx.data.list;
	if (!data) return el('div', { cls: 'note bad', text: ctx.data.error ?? 'No invalidation data.' });

	return [
		el('div', { cls: 'view-head' }, [
			el('span', { cls: 'eyebrow', text: 'Invalidations' }),
			spacer(),
			data.enabled ? pill('enforcement on', 'ok', true) : pill('invalidation.enabled is FALSE', 'bad', true),
			el('button', { text: 'Refresh', disabled: ctx.busy, onclick: () => ctx.reload() }),
		]),
		appliedNote(ctx),
		data.killSwitchHidingRows &&
			el('div', { cls: 'note bad' }, [
				'Rows exist but ',
				el('code', { text: 'invalidation.enabled' }),
				' is false — they are recorded and NOT enforced. Whatever those rows were protecting against is being served.',
			]),
		active(ctx, data),
		effect(ctx, data),
		record(ctx, data),
		settings(ctx),
		editTray(ctx),
	];
}

// ---- what the invalidations are doing ---------------------------------------

// Series and outcome names as constants: the route-contract test in adminAssets.test.js reads a
// quoted name inside a Map lookup as a call to an admin route of that name.
const PAGE_VERIFICATION = 'page_verification';
const REENQUEUE = 'invalidation_reenqueue';
const INVALIDATION_ERROR = 'invalidation_error';
const VERIFIED = 'verified';
const INVALIDATED = 'invalidated';
const WRITTEN = 'written';
const LOWERED = 'lowered';
const NOT_OWNER = 'not-owner';
const LKG_EXPIRED = 'lkg-expired';

/**
 * Every outcome the heal can record, with what it means — the closed set the plugin exports as
 * `REENQUEUE_OUTCOMES`. Order is the order an operator should read them in: what worked, what was
 * handed on, then why the rest did not, most actionable first.
 *
 * `forwarded` and `lowered` are deliberately never added together: a forwarded heal is counted
 * again by the OWNER under its own verdict in this same series, so under cluster scope `lowered`
 * already includes the forwarded heals that landed and adding `forwarded` would double-count them.
 */
const HEAL_OUTCOMES = [
	{
		key: 'lowered',
		label: 'lowered',
		tone: 'ok',
		means: 'the URL’s due time was pulled forward — it heals ahead of its cadence',
	},
	{
		key: 'forwarded',
		label: 'forwarded',
		tone: 'info',
		means: 'this node did not own the key and handed the heal to the owner, which counts its own verdict here',
	},
	{
		key: 'not-owner',
		label: 'not-owner',
		tone: 'warn',
		means: 'this node did not own the key and cross-node forwarding is off — the heal was dropped',
	},
	{
		key: 'forward-failed',
		label: 'forward-failed',
		tone: 'bad',
		means: 'the owner could not be reached in time — a transport fault, not a refusal',
	},
	{ key: 'throttled', label: 'throttled', tone: 'warn', means: 'invalidation.reenqueue.maxPerMinute was spent' },
	{ key: 'not-sooner', label: 'not-sooner', tone: '', means: 'already due at least as soon — nothing to pull forward' },
	{
		key: 'unhealable',
		label: 'unhealable',
		tone: '',
		means: 'already rendered after the epoch, or striking out — a re-render would not help',
	},
	{ key: 'leased', label: 'leased', tone: '', means: 'a render is in flight for this key right now' },
	{ key: 'paused', label: 'paused', tone: '', means: 'the queue is paused on this node' },
	{
		key: 'no-schedule',
		label: 'no-schedule',
		tone: 'bad',
		means: 'a live URL with no schedule row — the terminal gap render.reconcile repairs',
	},
	{ key: 'no-target', label: 'no-target', tone: '', means: 'no Target for the URL — nothing to schedule' },
	{ key: 'error', label: 'error', tone: 'bad', means: 'the schedule write threw' },
];

/** Total per `dim` value over the given combos, as an ordered list. */
function tally(combos, dim) {
	const totals = new Map();
	for (const s of combos) totals.set(s[dim] ?? 'unknown', (totals.get(s[dim] ?? 'unknown') ?? 0) + s.count);
	return totals;
}

function effect(ctx, list) {
	const data = ctx.data.analytics;
	const title = data
		? `What the invalidations are doing — ${scopeLabel(data)}, last hour`
		: 'What the invalidations are doing';
	const options = optionIndex(configState(ctx).payload);
	const on = (path) => options.get(path)?.effective === true;
	const verificationOn = on('invalidation.verification.enabled');
	const reenqueueOn = on('invalidation.reenqueue.enabled');
	const crossNodeOn = on('invalidation.reenqueue.crossNode.enabled');

	if (!data || data.available === false || windowEmpty(data)) {
		return card(title, { body: [emptyNote('bot_serve', data)] });
	}

	const serves = pick(data, 'bot_serve');
	const refused = sumCount(serves.filter((s) => s.method === INVALIDATED));
	const rescued = sumCount(serves.filter((s) => s.method === VERIFIED));
	const touched = refused + rescued;

	const writes = tally(
		pick(data, 'prerender_ops', (s) => s.path === PAGE_VERIFICATION),
		'method'
	);
	const written = writes.get(WRITTEN) ?? 0;
	const writeFaults = [...writes.entries()].filter(([outcome]) => outcome !== WRITTEN);

	const heals = tally(
		pick(data, 'prerender_ops', (s) => s.path === REENQUEUE),
		'method'
	);
	const healTotal = [...heals.values()].reduce((acc, n) => acc + n, 0);
	const healRows = HEAL_OUTCOMES.filter((o) => heals.has(o.key)).map((o) => ({ ...o, count: heals.get(o.key) }));
	// An outcome this console has no entry for still gets a row, uncoloured, rather than vanishing
	// from a list whose whole point is that it sums to the attempts.
	for (const [outcome, count] of heals) {
		if (!HEAL_OUTCOMES.some((o) => o.key === outcome)) {
			healRows.push({
				key: outcome,
				label: outcome,
				tone: '',
				means: 'an outcome this console does not know about',
				count,
			});
		}
	}
	const notOwner = heals.get(NOT_OWNER) ?? 0;

	const errors = tally(
		pick(data, 'prerender_ops', (s) => s.path === INVALIDATION_ERROR),
		'method'
	);
	const lkgExpired = errors.get(LKG_EXPIRED) ?? 0;
	const errorTotal = [...errors.values()].reduce((acc, n) => acc + n, 0);

	const nothingActive = !(list.invalidations?.length > 0);

	return card(title, {
		head: [
			spacer(),
			verificationOn ? pill('verification on', 'ok') : pill('verification off', ''),
			reenqueueOn ? pill(crossNodeOn ? 'heal on · cross-node' : 'heal on', 'ok') : pill('heal off', ''),
		],
		body: [
			el('div', { cls: 'stat-grid tight' }, [
				stat(
					'Refused',
					num(refused),
					touched
						? `${pct(refused, touched)} of touched serves · each an origin round trip`
						: 'serves an invalidation cost',
					{ warn: refused > 0 && rescued === 0 && verificationOn }
				),
				stat(
					'Rescued',
					num(rescued),
					touched
						? `${pct(rescued, touched)} · served on the probe’s evidence (verified)`
						: 'served through an invalidation on evidence'
				),
				stat(
					'Verifications recorded',
					num(written),
					writeFaults.length
						? `${writeFaults.map(([outcome, count]) => `${num(count)} ${outcome}`).join(' · ')}`
						: 'by the probe sweep, while a scope is invalidated',
					{ warn: writeFaults.length > 0 }
				),
				stat(
					'Heals attempted',
					num(healTotal),
					healTotal
						? `${num(heals.get(LOWERED) ?? 0)} lowered · ${pct(notOwner, healTotal)} not-owner`
						: 'crawled invalidated pages pulled forward',
					// The accelerator's real ceiling: traffic lands where the CDN sends it while residency
					// is hashed, so on a concentrated deployment most heals arrive off-owner. Past half,
					// cross-node forwarding is the lever.
					{ warn: healTotal > 0 && notOwner > healTotal / 2 && !crossNodeOn }
				),
			]),
			healRows.length
				? barList(
						healRows.map((row) => ({
							label: row.label,
							value: row.count,
							color:
								row.tone === 'ok'
									? 'var(--ok)'
									: row.tone === 'bad'
										? 'var(--bad)'
										: row.tone === 'warn'
											? 'var(--warn)'
											: row.tone === 'info'
												? 'var(--info)'
												: SERIES[0],
							sub: pct(row.count, healTotal),
							title: `${row.label}: ${num(row.count)} — ${row.means}`,
						})),
						{ format: fmtCount }
					)
				: null,
			errorTotal > 0 &&
				el('div', { cls: lkgExpired > 0 ? 'note bad' : 'note warn' }, [
					el('strong', { text: `${num(errorTotal)} epoch resolution failure(s) this hour: ` }),
					[...errors.entries()].map(([kind, count]) => `${kind} ${num(count)}`).join(' · '),
					lkgExpired > 0
						? '. lkg-expired means the row read threw AND the last-known-good memory was older than invalidation.lkgMaxAge, so those requests failed OPEN — content someone deliberately invalidated may have been served.'
						: '. read-error means a live last-known-good answered; invalid-row and unknown-mode were treated as hard invalidations.',
				]),
			nothingActive &&
				!touched &&
				el('div', { cls: 'note' }, [
					'Nothing is invalidated right now, so none of this is expected to move: a verification is only ',
					'written while a scope is invalidated, and a heal only fires on a serve an invalidation refused. ',
					'Zeros here are the steady state, not a fault.',
				]),
			!nothingActive &&
				touched > 0 &&
				!verificationOn &&
				el('div', { cls: 'note' }, [
					'Every touched serve was refused because ',
					el('code', { text: 'invalidation.verification.enabled' }),
					' is off. With it on, a page the change probe has re-confirmed against the origin since the epoch is ',
					'served from cache instead of proxied — measured at 71-78% of a route-wide invalidation’s scope on ',
					'one deployment. It requires ',
					el('code', { text: 'changeProbe.pageCheck' }),
					' on the rule whose scope was invalidated.',
				]),
			el('p', { cls: 'muted chart-note' }, [
				'Refused and rescued are the population an invalidation touched — pages rendered before the epoch that ',
				'a crawler asked for — split by what happened next. A refused serve is proxied to the origin (it is ',
				'also inside the miss/origin figures on Traffic); a rescued one is served from cache because the probe ',
				'proved its price and availability current, which is all “verified” asserts. The heal outcomes sum to ',
				'attempts; “forwarded” is a hand-off whose result the owner counts under its own verdict, so it is ',
				'never added to “lowered”. Counters, node-local, summed under cluster scope.',
			]),
		],
		foot: [scanFooter(data)],
	});
}

function active(ctx, data) {
	const rows = (data.invalidations ?? []).map((row) =>
		el('tr', null, [
			el('td', { cls: 'mono', text: row.scope }),
			el('td', null, [row.resolvable ? pill('active', 'ok') : pill('unresolvable — matches nothing', 'bad')]),
			el('td', { cls: 'mono', text: row.invalidatedAt ? ago(new Date(row.invalidatedAt).getTime()) : '—' }),
			el('td', { cls: 'break', text: row.reason ?? '' }),
			el('td', { cls: 'mono muted', text: row.updatedBy ?? '' }),
			el('td', { cls: 'right' }, [
				el('button', {
					cls: 'danger small',
					text: 'Clear',
					disabled: ctx.busy,
					onclick: () => clearScope(ctx, row.scope),
				}),
			]),
		])
	);

	return card('Active invalidations', {
		head: [spacer(), muted(`${num(data.invalidations?.length ?? 0)} of ${num(data.maxScopes)} scope slots`)],
		body: [
			table(
				['scope', 'state', 'since', 'reason', 'by', { text: '', right: true }],
				rows,
				'Nothing is invalidated. Pages serve on their own expiry/SWR windows.'
			),
			el('p', { cls: 'muted chart-note' }, [
				'An invalidation is one row naming a scope and an instant: cached pages in that scope rendered ',
				'before the instant stop being served (bots get the origin) until they re-render on their own ',
				'cadence. Nothing is rewritten, so clearing is instant for pages still inside their windows. ',
				'The LATEST instant among overlapping scopes wins — max, not most-specific.',
			]),
		],
	});
}

/**
 * Clear runs immediately (it is the safe direction and the remediation path for unresolvable
 * rows), then shows the server's own partial-undo warning — the part operators get wrong.
 */
async function clearScope(ctx, scope) {
	const res = await ctx.run(() => ctx.post('invalidate', { scope, mode: null }));
	if (res?.ok && res.body?.warning) {
		ctx.data.cleared = { scope, warning: res.body.warning };
		ctx.render();
	}
}

function record(ctx, data) {
	const state = (ctx.data.form ??= { scope: data.knownScopes?.[0] ?? 'all', reason: '' });
	const preview = ctx.data.preview;

	const scopeSelect = el(
		'select',
		{
			onchange: (event) => {
				state.scope = event.target.value;
				ctx.data.preview = null;
				ctx.render();
			},
		},
		(data.knownScopes ?? ['all']).map((scope) =>
			el('option', { value: scope, selected: scope === state.scope ? '' : null, text: scope })
		)
	);

	const reason = el('input', {
		type: 'text',
		style: { flex: '1', minWidth: '260px' },
		placeholder: 'why — this outlives the incident',
		value: state.reason,
		oninput: (event) => {
			state.reason = event.target.value;
		},
	});

	const runPreview = async () => {
		if (!reason.value.trim()) return ctx.fail('A reason is required before previewing.');
		state.reason = reason.value;
		const res = await ctx.post('invalidate', { scope: state.scope, reason: state.reason, dryRun: true });
		ctx.data.preview = res.ok ? res.body : { error: res.body?.error ?? `Preview failed (${res.status})` };
		ctx.render();
	};

	const apply = async () => {
		const res = await ctx.run(() => ctx.post('invalidate', { scope: state.scope, reason: state.reason }));
		if (res?.ok) ctx.data.preview = null;
	};

	const body = [
		el('div', { cls: 'toolbar' }, [
			el('label', { text: 'Scope' }),
			scopeSelect,
			el('label', { text: 'Reason' }),
			reason,
			spacer(),
			el('button', { cls: 'primary', text: 'Preview (writes nothing)', disabled: ctx.busy, onclick: runPreview }),
		]),
	];

	if (ctx.data.cleared) {
		body.push(
			el('div', { cls: 'note warn' }, [
				el('strong', { text: `Cleared ${ctx.data.cleared.scope}. ` }),
				ctx.data.cleared.warning,
			])
		);
	}

	if (preview?.error) {
		body.push(el('div', { cls: 'note bad', text: preview.error }));
	} else if (preview) {
		body.push(
			el('div', { cls: 'note info' }, [
				el('strong', { text: 'Preview — nothing has been written. ' }),
				'This is the same body the write returns.',
			]),
			kv([
				['Scope', mono(preview.scope)],
				preview.coverage && ['Coverage', describeCoverage(preview.coverage)],
				preview.overlaps?.length
					? ['Overlapping scopes', preview.overlaps.map((o) => `${o.scope} (${o.invalidatedAt ?? '?'})`).join(', ')]
					: null,
				['Precedence', preview.precedence],
				['Effect', preview.effect],
			]),
			el(
				'ul',
				{ cls: 'muted limits' },
				(preview.limits ?? []).map((limit) => el('li', { text: limit }))
			),
			el('div', { cls: 'toolbar' }, [
				spacer(),
				el('button', { cls: 'danger', text: `Invalidate ${preview.scope} now`, disabled: ctx.busy, onclick: apply }),
			])
		);
	}

	return card('Record an invalidation', { body });
}

const describeCoverage = (coverage) => (typeof coverage === 'string' ? coverage : (coverage?.covers ?? '—'));

/**
 * The knobs, deliberately BELOW the record form and outside it.
 *
 * `invalidation.enabled` is the pill in this view's header and the kill switch behind the banner
 * above, so it has to be reachable from here — but it is a config write with its own
 * preview-then-apply, not a step in recording an invalidation. Keeping it in its own card below
 * the form is what stops the two flows from reading as one.
 */
const settings = (ctx) =>
	settingsCard(ctx, {
		title: 'Invalidation behaviour',
		prefix: 'invalidation',
		description:
			'How the rows in Active invalidations above are applied. enabled is the header pill: false leaves ' +
			'every row stored and stops honouring all of them at once, so the corpus serves pre-invalidation ' +
			'bytes again — it does not clear anything. maxScopes is the slot count on that panel. pad only ' +
			'widens the comparison toward invalidating (its cost is at most one extra render per page). ' +
			'verification lets a page the change probe has PROVED current since the epoch be served through ' +
			'the invalidation (the “rescued” count above; needs pageCheck on the rule). The reenqueue options ' +
			'decide whether a bot request for an invalidated page pulls that URL forward in the queue instead of ' +
			'waiting out its own cadence, and crossNode whether a heal for a key another node owns is forwarded ' +
			'to it rather than dropped as not-owner. Nothing here rewrites a cached page.',
	});
