/**
 * Console entry point: session handling, the app shell, and the view router.
 *
 * Views are modules with a uniform contract (see VIEWS below):
 *   meta   { id, label, crumb, icon }   — sidebar entry and breadcrumb
 *   load   (ctx) => Promise             — fetch what the view needs into ctx.data
 *   render (ctx) => Node                — build the DOM, synchronously, from ctx.data
 *
 * Rendering is a full rebuild of `#app` on every state change. That is not a performance
 * problem here (an operator console with tens of rows, not a bot read path) and it removes a
 * whole class of stale-DOM bugs that a partial-update scheme would introduce.
 */

import { el, harperMark, icon, muted, pill, spacer } from './ui.js';
import { CLUSTER, get, post, setExpiredHandler, setNode } from './api.js';
import * as overview from './views/overview.js';
import * as traffic from './views/traffic.js';
import * as queue from './views/queue.js';
import * as nodes from './views/nodes.js';
import * as sitemaps from './views/sitemaps.js';
import * as pages from './views/pages.js';
import * as invalidations from './views/invalidations.js';
import * as explain from './views/explain.js';
import * as metricsref from './views/metricsref.js';
import * as config from './views/config.js';

// Ordered as an operator triages: is it working (overview, traffic), what is it working on
// (sitemaps, pages), is the machinery healthy (queue, then the nodes running it), then actions
// and reference.
const VIEWS = [
	overview,
	traffic,
	sitemaps,
	pages,
	queue,
	nodes,
	invalidations,
	null /* divider */,
	explain,
	metricsref,
	config,
];
const BY_ID = new Map(VIEWS.filter(Boolean).map((view) => [view.meta.id, view]));

const state = {
	view: 'overview',
	session: null,
	busy: false,
	error: null,
	// Per-view scratch: fetched data and any local UI state (inputs, cursors, selection).
	// Keyed by view id so switching views never leaks one view's state into another.
	views: {},
};

const scratch = (id) => (state.views[id] ??= {});

const currentView = () => BY_ID.get(state.view) ?? overview;

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
	scratch,
	get,
	post,
	render,

	/** Switch views. The target's `load` runs before anything is drawn for it. */
	go(id, patch) {
		state.view = BY_ID.has(id) ? id : 'overview';
		state.error = null;
		if (patch) Object.assign(scratch(state.view), patch);
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

// ---- shell ----

function render() {
	const app = document.getElementById('app');
	app.textContent = '';

	if (!state.session)
		return void app.appendChild(el('main', { cls: 'main' }, [el('p', { cls: 'muted', text: 'Loading…' })]));
	if (!state.session.authenticated || !state.session.superUser) return void app.appendChild(renderSignIn());

	const view = currentView();
	app.appendChild(
		el('div', { cls: 'app' }, [
			renderSidebar(),
			el('div', { cls: 'content' }, [
				renderTopbar(view),
				el('main', { cls: 'main' }, [
					el('div', { cls: 'view' }, [
						state.error && el('div', { cls: 'note bad', text: state.error }),
						...incompleteSources(),
						view.render(ctx),
					]),
				]),
			]),
		])
	);
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
			el('div', { cls: 'who' }, [
				el('div', { cls: 'name truncate', text: username }),
				el('div', { cls: 'role', text: 'super_user' }),
			]),
			el('button', { cls: 'link', text: 'Sign out', onclick: signOut }),
		]),
	]);
}

function renderTopbar(view) {
	// The cluster pill reads from whatever the overview last fetched. It is deliberately absent
	// rather than assumed "running" when that data hasn't been loaded in this session — an
	// unknown pause state must never render as a green light.
	const cluster = scratch('overview').overview?.control?.cluster;

	return el('div', { cls: 'topbar' }, [
		el('div', { cls: 'crumbs' }, [
			muted('prerender'),
			el('span', { cls: 'sep', text: '/' }),
			el('span', { cls: 'here', text: view.meta.crumb }),
		]),
		spacer(),
		nodePicker(),
		cluster ? (cluster.paused ? pill('queue paused · cluster', 'bad', true) : pill('queue running', 'ok', true)) : null,
	]);
}

/**
 * What this console is looking at: the whole cluster (the default) or one node.
 *
 * CLUSTER IS FIRST AND IS THE DEFAULT because it is the question an operator actually has.
 * Almost everything here is node-local — analytics rows, the backlog snapshot's owned-key
 * slice, the claim floor — so a per-node console answered "how is one quarter of the cluster",
 * and the cluster answer had to be assembled by hand across four browser tabs. The proxy fans
 * the read out and merges it (util/aggregate.js); a single node stays one click away for the
 * drill-down, and for the panels that are genuinely per-node.
 *
 * Switching scope DROPS all per-view state: stale data from the previous scope must never
 * render under the new scope's name. A node the sign-in didn't reach is still offered (picking
 * it lands on the sign-in form, which is the honest next step), but labelled.
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
			title:
				'What this console reads. “All nodes” merges every node’s answer server-side; ' +
				'a single node shows that node’s own slice.',
			onchange: (event) => {
				setNode(event.target.value);
				state.views = {};
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
 * MISSING A NODE.
 *
 * A sum short by one node is not a smaller number, it is a wrong one — and it is
 * indistinguishable from a genuine drop in traffic, a shrinking backlog, or a cluster that
 * quietly stopped rendering. Rather than making every view remember to check, this walks
 * whatever the current view loaded and surfaces any incomplete `sources` envelope it finds; a
 * view that adds a new fetch is covered automatically.
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
				el('strong', { text: `${sources.answered} of ${sources.configured} nodes answered. ` }),
				'Every cluster total on this page is missing ' +
					missing.map((node) => `${node.hostname} (${node.error ?? `HTTP ${node.status}`})`).join(', ') +
					'. Treat the numbers as a floor, not a measurement — a missing node looks exactly like a drop.',
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
					el('div', {
						cls: 'sub',
						text: 'super_user on the prerender cluster — credentials are forwarded, never stored',
					}),
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
	await post('logout', {});
	state.views = {};
	load();
}

// ---- loading ----

async function load() {
	state.busy = true;
	render();

	const session = await get('session');
	state.session = session.body;
	if (!session.body?.authenticated || !session.body?.superUser) {
		state.busy = false;
		return render();
	}

	try {
		await currentView().load(ctx);
	} catch (e) {
		// A view's own fetch layer never throws (see api.js), so this is a bug in the view, not a
		// transport failure. Surface it rather than leaving the console stuck on "Loading…".
		state.error = `Failed to load ${state.view}: ${e?.message ?? String(e)}`;
	}

	state.busy = false;
	render();
}

setExpiredHandler(() => {
	state.session = { authenticated: false };
	state.views = {};
});

load();
