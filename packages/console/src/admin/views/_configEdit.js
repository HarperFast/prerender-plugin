/**
 * Shared config-editing behaviour, so every surface that edits an option behaves identically.
 *
 * Config editing is deliberately NOT confined to one settings screen: an option is most
 * intelligible next to the data it governs, so `sitemap.*` lives under Sitemaps and `queue.*`
 * under Queue. The cost of that is five places where the same three mistakes could be made
 * differently — staging a value without saying it is unwritten, applying without a preview, and
 * showing a rejected override as though it were in force. This module is the one implementation
 * of all three; a view supplies a title and a set of option paths and gets the rest.
 *
 * ONE FETCH, ONE STAGING AREA, SHARED ACROSS VIEWS. The payload is per-view scratch everywhere
 * else in this console, but config is a single document: staging `queue.jobLeaseTime` under Queue
 * and `sitemap.refreshTime` under Sitemaps has to produce ONE preview and ONE write, or an
 * operator making a coherent change to two related options gets two half-applied ones. So the
 * staged set and the loaded config live in the `config` view's scratch and every surface reaches
 * into it (`ctx.scratch('config')`).
 */

import { card, el, muted, note, settingRow, spacer, stagedTray } from '../ui.js';

/** The scratch every config surface shares, whichever view is on screen. */
export const configState = (ctx) => {
	const state = ctx.scratch('config');
	state.staged ??= {};
	state.invalid ??= {};
	return state;
};

/**
 * Fetch the config payload into the shared scratch, unless another view already did this load.
 *
 * `force` is for the config view itself, which must always show current data; a domain view
 * opening after a config edit reuses what is there rather than spending a fan-out to redraw one
 * card.
 */
export async function loadConfig(ctx, { force = false } = {}) {
	const state = configState(ctx);
	if (state.payload && !force) return state.payload;

	const res = await ctx.get('config');
	state.payload = res.ok ? res.body : null;
	state.error = res.ok ? null : (res.body?.error ?? `Could not load config (${res.status})`);
	return state.payload;
}

/** Every option row the server described, flattened out of the schema tree and indexed by path. */
export function optionIndex(payload) {
	const index = new Map();
	if (!payload) return index;

	const walk = (node, path) => {
		if (!node || typeof node !== 'object') return;
		if (node.kind === 'option') {
			index.set(path, { ...node, path });
			return;
		}
		for (const [key, child] of Object.entries(node.children ?? {})) walk(child, path ? `${path}.${key}` : key);
	};
	walk(payload.schema, '');

	// The layers carry provenance and the effective value; the schema carries type, description and
	// constraints. A row needs both, and only the layers know which one won.
	for (const layer of payload.layers ?? []) {
		const option = index.get(layer.path);
		if (option) Object.assign(option, layer);
	}
	return index;
}

/** Paths under a dotted group prefix, in schema declaration order. */
export const pathsUnder = (index, prefix) =>
	[...index.keys()].filter((path) => path === prefix || path.startsWith(`${prefix}.`));

const pendingRestartPaths = (payload) => new Set((payload?.pendingRestart ?? []).map((entry) => entry.key));

// A divergence the server tagged `overridden` is the override layer converging across nodes, not a
// deploy that skipped one — the console's own write path produces it on every edit, and rendering
// it as the deploy alarm is how that alarm stops being read.
const divergentPaths = (payload) =>
	new Set((payload?.divergences ?? []).filter((entry) => !entry.overridden).map((entry) => entry.path));

/**
 * A card of settings for one group.
 *
 * `paths` wins over `prefix` when both are given, for the handful of cards that own a hand-picked
 * set rather than a whole group.
 */
export function settingsCard(ctx, { title, prefix, paths, description, head = [] }) {
	const state = configState(ctx);
	const payload = state.payload;
	if (!payload) return null;

	const index = optionIndex(payload);
	const restartPending = pendingRestartPaths(payload);
	const divergent = divergentPaths(payload);
	const wanted = paths ?? pathsUnder(index, prefix);
	const rows = wanted.map((path) => index.get(path)).filter(Boolean);
	if (!rows.length) return null;

	const editable = rows.filter((option) => option.uiEditable !== false).length;

	return card(title, {
		head: [...head, spacer(), muted(`${rows.length} option${rows.length === 1 ? '' : 's'}, ${editable} editable`)],
		body: [
			description && el('p', { cls: 'muted chart-note', text: description }),
			...rows.map((option) =>
				settingRow(option, {
					staged: Object.hasOwn(state.staged, option.path) ? state.staged[option.path] : undefined,
					invalid: state.invalid[option.path],
					pendingRestart: restartPending.has(option.path),
					divergent: divergent.has(option.path),
					busy: ctx.busy,
					onStage: (path, value) => stage(ctx, path, value),
					onRevert: (path) => revert(ctx, path),
				})
			),
		],
	});
}

/**
 * Stage an edit locally. Nothing is written until the tray's preview-then-apply.
 *
 * A value staged back to what the cluster is already running is UNSTAGED rather than recorded as a
 * change: otherwise typing a value and undoing it leaves a phantom entry in the tray, and the
 * operator applies a write they no longer want.
 */
function stage(ctx, path, value) {
	const state = configState(ctx);
	const option = optionIndex(state.payload).get(path);
	const unchanged = JSON.stringify(value) === JSON.stringify(option?.effective);

	if (unchanged) delete state.staged[path];
	else state.staged[path] = value;
	delete state.invalid[path];

	// A control re-rendered from scratch on every keystroke would lose the caret, so only the tray
	// (whose count and buttons changed) is redrawn — the control already holds the value the
	// operator typed.
	ctx.render();
}

/** Clearing an override is a write, so it goes through the same preview-then-apply path. */
function revert(ctx, path) {
	const state = configState(ctx);
	state.cleared ??= {};
	state.cleared[path] = true;
	delete state.staged[path];
	ctx.render();
}

/**
 * The tray. Render it once per view, below the settings cards.
 *
 * It shows the WHOLE staged set, not just this view's slice, because the write is one request:
 * an operator who staged something under Sitemaps and then navigated to Queue must not apply a
 * change they can no longer see.
 */
export function editTray(ctx) {
	const state = configState(ctx);
	const staged = state.staged ?? {};
	const cleared = state.cleared ?? {};
	const count = Object.keys(staged).length + Object.keys(cleared).length;

	const body = () => ({
		set: Object.entries(staged).map(([path, value]) => ({ path, value })),
		clear: Object.keys(cleared),
	});

	return stagedTray({
		count,
		invalid: Object.keys(state.invalid ?? {}).length,
		preview: state.preview,
		busy: ctx.busy,
		onDiscard: () => {
			state.staged = {};
			state.cleared = {};
			state.invalid = {};
			state.preview = null;
			ctx.render();
		},
		onPreview: async () => {
			const res = await ctx.post('config-override', { ...body(), dryRun: true });
			if (!res.ok) {
				// A per-entry rejection is the useful half of a failed preview: it names the option and
				// the rule, which is what the operator fixes. A bare status code is not.
				state.invalid = Object.fromEntries((res.body?.invalid ?? []).map((entry) => [entry.path, entry.reason]));
				state.preview = { error: res.body?.error ?? `Preview failed (${res.status})` };
			} else {
				state.invalid = {};
				state.preview = res.body;
			}
			ctx.render();
		},
		onApply: async () => {
			const res = await ctx.run(() => ctx.post('config-override', body()));
			if (res?.ok) {
				state.staged = {};
				state.cleared = {};
				state.invalid = {};
				state.preview = null;
				// The write lands on ONE node and replicates, so the config this console reads back a
				// moment later may still be the pre-write one on whichever node answers. Re-fetching is
				// the honest redraw; the applied banner says why a value may lag for a second.
				state.payload = null;
				state.applied = res.body;
				await loadConfig(ctx, { force: true });
				ctx.render();
			}
		},
	});
}

/** The banner shown after an apply, explaining why a value may still read as the old one. */
export function appliedNote(ctx) {
	const state = configState(ctx);
	if (!state.applied) return null;
	const seconds = Math.round((state.applied.appliesRemotelyWithinMs ?? 30000) / 1000);
	return note('ok', [
		el('strong', { text: 'Applied. ' }),
		`${state.applied.servedBy ? `${state.applied.servedBy} took the write; ` : ''}` +
			`the rows replicate, so every node converges in about a second — or within ${seconds}s if a node's ` +
			`override subscription is not live. A value that still reads as the old one here is a node that has ` +
			`not caught up yet, not a write that failed.`,
	]);
}
