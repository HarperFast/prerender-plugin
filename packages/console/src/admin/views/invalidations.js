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
 */

import { ago, card, el, ICONS, kv, mono, muted, num, pill, spacer, table } from '../ui.js';
import { appliedNote, editTray, loadConfig, settingsCard } from './_configEdit.js';

export const meta = { id: 'invalidations', label: 'Invalidations', crumb: 'invalidations', icon: ICONS.invalidations };

export async function load(ctx) {
	const [res] = await Promise.all([ctx.get('invalidations'), loadConfig(ctx)]);
	ctx.data.list = res.ok ? res.body : null;
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
		record(ctx, data),
		settings(ctx),
		editTray(ctx),
	];
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
			'widens the comparison toward invalidating (its cost is at most one extra render per page), and the ' +
			'reenqueue options decide whether a bot request for an invalidated page pulls that URL forward in ' +
			'the queue instead of waiting out its own cadence. Nothing here rewrites a cached page.',
	});
