/**
 * Console entry point: session handling, the app shell, and the view router.
 *
 * Views are modules with a uniform contract (see VIEWS below):
 *   meta   { id, label, icon, ranged? } — sidebar entry; `ranged` puts the time-range picker in
 *                                          the top bar while that view is open
 *   load   (ctx) => Promise             — fetch what the view needs into ctx.data
 *   render (ctx) => Node                — build the DOM, synchronously, from ctx.data
 *
 * Rendering is a full rebuild of `#app` on every state change. That is not a performance
 * problem here (an operator console with tens of rows, not a bot read path) and it removes a
 * whole class of stale-DOM bugs that a partial-update scheme would introduce.
 *
 * LOADS ARE SEQUENCED. Every load takes a number, and a response that arrives after a newer load
 * started is dropped before it can be written. Without that, clicking 24h and then 15m let the slow
 * 24h scan land last and overwrite the 15m answer under a picker reading "15m" — and because
 * `ctx.data` used to resolve to whichever view was current when the RESPONSE arrived, a load for
 * one view could even write into another. A load's context is now pinned to the view that started it.
 */

import { el, harperMark, icon, pill, skeleton, spacer } from './ui.js';
import { CLUSTER, get, post, setExpiredHandler, setNode } from './api.js';
import { hideTip, segmented } from './charts.js';
import * as health from './views/health.js';
import * as traffic from './views/traffic.js';
import * as queue from './views/queue.js';
import * as sitemaps from './views/sitemaps.js';
import * as corpus from './views/corpus.js';
import * as invalidations from './views/invalidations.js';
import * as probe from './views/probe.js';
import * as inspect from './views/inspect.js';
import * as metricsref from './views/metricsref.js';
import * as config from './views/config.js';
import { configState, discardEdit, optionIndex } from './views/_configEdit.js';

// Ordered as an operator triages: is anything wrong (health), what crawlers are getting (traffic),
// whether the machinery is keeping up (queue), what it is working on (sitemaps, corpus), then the
// two change mechanisms. Below the divider: the drill-down every other view hands a URL to, and
// reference.
const VIEWS = [
	health,
	traffic,
	queue,
	sitemaps,
	corpus,
	invalidations,
	probe,
	null /* divider */,
	inspect,
	config,
	metricsref,
];
const BY_ID = new Map(VIEWS.filter(Boolean).map((view) => [view.meta.id, view]));
const DEFAULT_VIEW = health.meta.id;

/**
 * Retired view ids, mapped to the view that absorbed them — so a bookmarked hash, a stored
 * selection or an old call site lands somewhere meaningful rather than silently on the default.
 *
 *   overview → health    replaced by a page of checks with verdicts; its serve strip was a subset
 *                        of Traffic, its backlog moved to Queue, its maintenance actions to Corpus
 *   nodes    → queue     the per-node table is about the queue; config agreement lives on Config
 *   explain, pages → inspect
 */
const ALIAS = new Map([
	['overview', 'health'],
	['nodes', 'queue'],
	['explain', 'inspect'],
	['pages', 'inspect'],
]);

/** The time ranges every analytics-charting view shares. Capped by `management.analytics.maxRange`. */
export const RANGES = [
	{ label: '15m', ms: 15 * 60_000 },
	{ label: '1h', ms: 3_600_000 },
	{ label: '3h', ms: 3 * 3_600_000 },
	{ label: '6h', ms: 6 * 3_600_000 },
	{ label: '12h', ms: 12 * 3_600_000 },
	{ label: '24h', ms: 24 * 3_600_000 },
];
const RANGE_KEY = 'prerender-console-range';
const readRange = () => {
	try {
		const stored = Number(localStorage.getItem(RANGE_KEY));
		if (RANGES.some((range) => range.ms === stored)) return stored;
	} catch {
		/* storage unavailable; the default is fine */
	}
	return 3_600_000;
};

const resolveId = (id) => {
	const target = ALIAS.get(id) ?? id;
	return BY_ID.has(target) ? target : DEFAULT_VIEW;
};

const hashView = () => {
	try {
		return location.hash ? resolveId(decodeURIComponent(location.hash.slice(1))) : DEFAULT_VIEW;
	} catch {
		return DEFAULT_VIEW;
	}
};

const state = {
	view: hashView(),
	session: null,
	busy: false,
	error: null,
	rangeMs: readRange(),
	// Per-view scratch: fetched data and any local UI state (inputs, cursors, selection).
	// Keyed by view id so switching views never leaks one view's state into another.
	views: {},
	// Views whose first load has finished in the current scope. Until then the view renders a
	// skeleton — never its "no data" state, which is a claim about the cluster, not about the fetch.
	loaded: new Set(),
	loadedAt: null,
};

const scratch = (id) => (state.views[id] ??= {});

const currentView = () => BY_ID.get(state.view) ?? health;

// ---- context handed to every view ----

const ctx = {
	get data() {
		return scratch(state.view);
	},
	get busy() {
		return state.busy;
	},
	get session() {
		return state.session;
	},
	/** The shared analytics window every ranged view reads. */
	get rangeMs() {
		return state.rangeMs;
	},
	scratch,
	get,
	post,
	render,

	/** Switch views. The target's `load` runs before anything is drawn for it. */
	go(id, patch) {
		// The patch still lands in whatever view actually renders, so an aliased call site's
		// scratch (a pre-filled URL, a selected sitemap) reaches the merged view unchanged.
		state.view = resolveId(id);
		state.error = null;
		if (patch) Object.assign(scratch(state.view), patch);
		setHash(state.view);
		load();
	},

	/** Re-run the current view's load. */
	reload: () => load(),

	/**
	 * Run a mutation, then reload. Every action in this console goes through here so a failed
	 * write always surfaces as a banner instead of a silently ignored click, and so the reloaded
	 * server state — not an optimistic guess — is what the operator ends up looking at.
	 */
	async run(fn) {
		state.busy = true;
		state.error = null;
		render();
		const res = await fn();
		state.busy = false;
		if (res && res.ok === false) {
			state.error = res.body?.error ?? `Request failed (${res.status})`;
			render();
			return res;
		}
		await load();
		return res;
	},

	/** Set the banner without running anything (for client-side validation). */
	fail(message) {
		state.error = message;
		render();
	},
};

const setHash = (id) => {
	try {
		if (location.hash.slice(1) !== id) globalThis.history?.replaceState?.(null, '', `#${id}`);
	} catch {
		/* no history API (tests); the view still switches */
	}
};

// ---- shell ----

/**
 * Where the operator was looking, carried across the rebuild. The scroll lives on `.main` (the
 * shell is a `100vh` flex column), so without this every click silently teleported the page back
 * to the top. A view CHANGE still starts at the top.
 */
let scrollTop = 0;
let scrolledView = null;

function render() {
	const app = document.getElementById('app');
	// Read before the tree goes away. `querySelector` is guarded because the DOM shim the tests
	// render through implements only what `el()` needs.
	const live = app.querySelector?.('.main');
	if (live) scrollTop = live.scrollTop;
	app.textContent = '';
	// The chart under the pointer is about to be replaced, and a removed node gets no mouseleave — the
	// tooltip would otherwise stay up showing the previous data.
	hideTip();

	if (!state.session)
		return void app.appendChild(el('main', { cls: 'main' }, [el('div', { cls: 'view' }, [skeleton()])]));
	if (!state.session.authenticated || !state.session.superUser) return void app.appendChild(renderSignIn());

	const view = currentView();
	const ready = state.loaded.has(state.view);
	const main = el('main', { cls: 'main' }, [
		el('div', { cls: 'view' }, [
			state.error && el('div', { cls: 'note bad', text: state.error }),
			...incompleteSources(),
			ready ? renderView(view) : skeleton(),
		]),
	]);
	app.appendChild(
		el('div', { cls: `app${state.busy ? ' busy' : ''}` }, [
			renderSidebar(),
			el('div', { cls: 'content' }, [renderTopbar(view), main]),
		])
	);

	if (state.view !== scrolledView) scrollTop = 0;
	scrolledView = state.view;
	// Assigning past the new content's height clamps, so a rebuild that produced a shorter page
	// lands at its bottom rather than throwing.
	main.scrollTop = scrollTop;
}

/**
 * A view's render, contained. A throw in one panel used to abort the whole rebuild and leave the
 * console blank — sidebar, top bar and all — which reads as "the console is down" during exactly
 * the incident it was opened for. The error is shown where the view would be, and the shell around
 * it keeps working, so the operator can still switch scope or view.
 */
function renderView(view) {
	try {
		return view.render(ctx);
	} catch (e) {
		globalThis.console?.error?.(e);
		return el('div', { cls: 'note bad', text: `This view failed to render: ${e?.message ?? String(e)}` });
	}
}

function renderSidebar() {
	const nav = el('nav', { cls: 'nav' });
	for (const view of VIEWS) {
		if (!view) {
			nav.appendChild(el('div', { cls: 'divider' }));
			continue;
		}
		const { id, label, icon: iconPaths } = view.meta;
		nav.appendChild(
			el('button', { cls: id === state.view ? 'active' : '', onclick: () => ctx.go(id) }, [
				icon(iconPaths),
				el('span', { cls: 'label', text: label }),
			])
		);
	}

	const username = state.session.username ?? '';
	return el('aside', { cls: 'sidebar' }, [
		el('div', { cls: 'brand' }, [
			harperMark(),
			el('div', null, [el('div', { cls: 'wordmark', text: 'Harper' }), el('div', { cls: 'sub', text: 'prerender' })]),
		]),
		nav,
		el('div', { cls: 'whoami' }, [
			el('div', { cls: 'avatar', text: (username.slice(0, 2) || '?').toUpperCase() }),
			el('div', { cls: 'who' }, [el('div', { cls: 'name truncate', text: username })]),
			el('button', { cls: 'link', text: 'Sign out', onclick: signOut }),
		]),
	]);
}

/** The largest window the cluster will serve, from the config payload when it is in hand. */
const maxRange = () => {
	const value = Number(optionIndex(configState(ctx).payload).get('management.analytics.maxRange')?.effective);
	return Number.isFinite(value) && value > 0 ? value : null;
};

function rangePicker() {
	const cap = maxRange();
	return segmented(
		RANGES.map(({ label, ms }) => ({
			label,
			value: ms,
			disabled: cap !== null && ms > cap,
			title: cap !== null && ms > cap ? `Above management.analytics.maxRange (${label} > cap)` : `Last ${label}`,
		})),
		state.rangeMs,
		(ms) => {
			state.rangeMs = ms;
			try {
				localStorage.setItem(RANGE_KEY, String(ms));
			} catch {
				/* the choice just won't survive a reload */
			}
			load();
		}
	);
}

function renderTopbar(view) {
	// The queue pill reads whatever the last overview payload said. Absent rather than assumed
	// "running" when no view has loaded it — an unknown pause state must never render as green.
	// The FRESHEST overview any view holds: pausing on Queue must turn the pill red even though Health
	// loaded an older payload first.
	const cluster = ['health', 'queue', 'corpus']
		.map((id) => scratch(id).overview)
		.filter(Boolean)
		.sort((a, b) => (b.generatedAt ?? 0) - (a.generatedAt ?? 0))[0]?.control?.cluster;
	const updated = state.loadedAt ? Math.round((Date.now() - state.loadedAt) / 1000) : null;

	return el('div', { cls: 'topbar' }, [
		el('h1', { cls: 'view-title', text: view.meta.label }),
		spacer(),
		view.meta.ranged && rangePicker(),
		nodePicker(),
		el(
			'button',
			{
				cls: `refresh${state.busy ? ' spinning' : ''}`,
				title: updated === null ? 'Refresh' : `Refresh — loaded ${updated}s ago`,
				disabled: state.busy,
				onclick: () => load(),
			},
			[icon(['M16.5 8A6.5 6.5 0 105 14.6', 'M16.5 3.5V8h-4.5'], 14), el('span', { text: 'Refresh' })]
		),
		cluster ? (cluster.paused ? pill('queue paused', 'bad', true) : pill('queue running', 'ok', true)) : null,
		el('div', { cls: 'progress' }),
	]);
}

/**
 * What this console is looking at: the whole cluster (the default) or one node.
 *
 * Switching scope DROPS all per-view state: stale data from the previous scope must never render
 * under the new scope's name. A node the sign-in didn't reach is still offered (picking it lands on
 * the sign-in form, which is the honest next step), but labelled.
 */
function nodePicker() {
	const nodes = state.session.nodes ?? [];
	if (nodes.length === 0) return el('span', { cls: 'muted mono nowrap', text: state.session.node ?? '' });
	if (nodes.length === 1) return el('span', { cls: 'muted mono nowrap', text: nodes[0].hostname });

	const selected = state.session.selected ?? CLUSTER;
	const signedInCount = nodes.filter((node) => node.signedIn).length;

	return el(
		'select',
		{
			cls: 'node-picker mono',
			title: '“All nodes” merges every node’s answer; a single node shows its own slice.',
			onchange: (event) => {
				setNode(event.target.value);
				state.views = {};
				state.loaded = new Set();
				load();
			},
		},
		[
			el('option', {
				value: CLUSTER,
				selected: selected === CLUSTER ? '' : null,
				text: `all nodes (${signedInCount}/${nodes.length})`,
			}),
			...nodes.map(({ origin, hostname, signedIn }) =>
				el('option', {
					value: origin,
					selected: origin === selected ? '' : null,
					text: hostname + (signedIn ? '' : ' (signed out)'),
				})
			),
		]
	);
}

/**
 * The one banner that must appear no matter which view is open: a cluster answer that is
 * MISSING A NODE. A sum short by one node is not a smaller number, it is a wrong one — and it is
 * indistinguishable from a genuine drop. This walks whatever the current view loaded and surfaces
 * any incomplete `sources` envelope, so a view that adds a new fetch is covered automatically.
 */
function incompleteSources() {
	const seen = new Set();
	const banners = [];
	for (const value of Object.values(scratch(state.view))) {
		const sources = value?.sources;
		if (!sources || sources.complete !== false) continue;
		const missing = (sources.nodes ?? []).filter((node) => !node.ok);
		const key = missing.map((node) => node.hostname).join(',');
		if (seen.has(key)) continue;
		seen.add(key);
		banners.push(
			el('div', { cls: 'note warn' }, [
				el('strong', { text: `${sources.answered} of ${sources.configured} nodes answered — totals are a floor. ` }),
				'Missing: ' + missing.map((node) => `${node.hostname} (${node.error ?? `HTTP ${node.status}`})`).join(', '),
			])
		);
	}
	return banners;
}

function renderSignIn() {
	const username = el('input', { type: 'text', autocomplete: 'username', autofocus: true });
	const password = el('input', { type: 'password', autocomplete: 'current-password' });
	const error = el('div', { cls: 'err' });
	const button = el('button', { cls: 'primary', text: 'Sign in' });

	async function submit() {
		error.textContent = '';
		button.disabled = true;
		const res = await post('login', { username: username.value, password: password.value });
		button.disabled = false;
		if (!res.ok) {
			error.textContent = res.body?.error ?? 'Sign-in failed';
			return;
		}
		password.value = '';
		load();
	}

	button.addEventListener('click', submit);
	for (const input of [username, password]) {
		input.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') submit();
		});
	}

	let notice = null;
	if (state.session?.authenticated && !state.session.superUser) {
		notice = el('div', {
			cls: 'note bad',
			text: `Signed in as ${state.session.username ?? 'a user'}, but this account is not a super_user.`,
		});
	} else if ((state.session?.nodes?.length ?? -1) === 0) {
		notice = el('div', {
			cls: 'note bad',
			text: 'No prerender nodes are configured for this console — set `nodes` in the component options.',
		});
	} else if (state.session?.sessionsEnabled === false) {
		notice = el('div', {
			cls: 'note bad',
			text: 'Cookie sessions are disabled on the prerender instance. Set authentication.enableSessions: true in its Harper config.',
		});
	} else if (state.session?.unreachable) {
		notice = el('div', {
			cls: 'note warn',
			text: `${state.session.unreachable} did not answer the session check — it may be down, or you may need to sign in again.`,
		});
	}

	return el('main', { cls: 'main' }, [
		el('div', { cls: 'signin' }, [
			el('div', { cls: 'brand' }, [
				harperMark(28),
				el('div', null, [
					el('div', { cls: 'wordmark', text: 'Prerender Console' }),
					el('div', { cls: 'sub', text: 'super_user · credentials are forwarded, never stored' }),
				]),
			]),
			el('div', { cls: 'card' }, [
				el('div', { cls: 'card-body signin-form' }, [
					notice,
					el('div', { cls: 'row' }, [el('label', { text: 'Harper username' }), username]),
					el('div', { cls: 'row' }, [el('label', { text: 'Password' }), password]),
					button,
					error,
				]),
			]),
		]),
	]);
}

async function signOut() {
	endSession();
	await post('logout', {});
	state.views = {};
	state.loaded = new Set();
	// An unwritten config edit deliberately outlives a scope switch — an override is cluster-wide.
	// It must NOT outlive the operator: the next person to sign in would apply it under their name.
	discardEdit();
	load();
}

// ---- loading ----

/** Thrown into a superseded load so it stops before writing anything. Never surfaced. */
const SUPERSEDED = Symbol('superseded');
let loadSeq = 0;

/**
 * Bumped whenever the session ENDS — sign-out or expiry. A session answer fetched under an older epoch
 * describes a session that no longer exists: written back late, it would put a signed-out operator on
 * the signed-in shell. Ending a session also supersedes every load in flight, so their 401s stop
 * writing into the fresh scratch.
 */
let authEpoch = 0;
function endSession() {
	authEpoch++;
	loadSeq++;
	state.session = { authenticated: false };
	state.busy = false;
}

/**
 * A context pinned to the view and the load that created it. `data` is that view's scratch no
 * matter what is on screen when a response lands, and a response for a load that has since been
 * superseded throws instead of resolving — so nothing downstream of it gets to write.
 */
function loadContext(viewId, seq) {
	const guard =
		(fn) =>
		async (...args) => {
			const res = await fn(...args);
			if (seq !== loadSeq) throw SUPERSEDED;
			return res;
		};
	return Object.create(ctx, {
		data: { get: () => scratch(viewId) },
		get: { value: guard(get) },
		post: { value: guard(post) },
	});
}

async function load() {
	const seq = ++loadSeq;
	const viewId = state.view;
	state.busy = true;
	render();

	// Once signed in, the session check runs CONCURRENTLY with the view's fetches and the view does not
	// wait for it: a lapsed session shows up as a 401 on those fetches anyway (the expired handler
	// catches it), and the cluster session check walks nodes one at a time — with the first node down,
	// awaiting it held every view switch and Refresh for a whole request timeout.
	const epoch = authEpoch;
	const firstLoad = !state.session?.authenticated;
	const sessionPromise = get('session').then((res) => {
		if (epoch !== authEpoch) return res.body;
		if (seq === loadSeq || firstLoad) state.session = res.body;
		// Signed out between loads, discovered after the view drew: go to the sign-in form now.
		if (!firstLoad && seq === loadSeq && (!res.body?.authenticated || !res.body?.superUser)) render();
		return res.body;
	});
	if (firstLoad) {
		const session = await sessionPromise;
		if (seq !== loadSeq) return;
		if (!session?.authenticated || !session?.superUser) {
			state.busy = false;
			return render();
		}
	}

	const view = BY_ID.get(viewId) ?? health;
	try {
		await view.load(loadContext(viewId, seq));
	} catch (e) {
		if (e === SUPERSEDED) return;
		// A view's own fetch layer never throws (see api.js), so this is a bug in the view, not a
		// transport failure. Surface it rather than leaving the console stuck on a skeleton.
		if (seq === loadSeq) state.error = `Failed to load ${viewId}: ${e?.message ?? String(e)}`;
	}
	if (seq !== loadSeq) return;

	state.loaded.add(viewId);
	state.loadedAt = Date.now();
	state.busy = false;
	render();
}

setExpiredHandler(() => {
	endSession();
	state.views = {};
	state.loaded = new Set();
	// Same reasoning as signOut: an expired session is a session that ended.
	discardEdit();
	render();
});

globalThis.addEventListener?.('hashchange', () => {
	const id = hashView();
	if (id !== state.view) ctx.go(id);
});

setHash(state.view);
load();
