/**
 * The console's fetch layer.
 *
 * The API base is derived from the page's own pathname, never hardcoded: the resource can be
 * mounted under a deployment base-URL prefix, and deriving it is what makes the console work
 * when it is. The asset URLs in page.html are built from the same base server-side.
 */

// `location.pathname` may or may not carry the trailing slash and may carry an asset path when
// the module is loaded (it never is — modules resolve against their own URL — but strip
// defensively so a future `/prerender_console/#/pages` style route can't break the base).
const BASE = location.pathname.replace(/\/+$/, '');

// ---- scope selection ----
//
// The console reads THE CLUSTER by default and one node on demand. Analytics, the backlog
// snapshot and the claim floor are all node-local, so a cluster answer is a fan-out merged
// server-side (see util/aggregate.js) — which is why this is one value, not a multi-select:
// the proxy does the work and hands back a single payload either way.
//
// The selection rides every request as a `node` query parameter; the server validates it
// against its CONFIGURED list, so this value is a preference, never an address. Persisted so a
// reload keeps the operator on the scope they were investigating.

const NODE_KEY = 'prerender-console-node';

/** The cluster sentinel, matching util/aggregate.js. Never a hostname. */
export const CLUSTER = 'cluster';

let node = CLUSTER;
try {
	// An empty stored value is a pre-cluster-scope selection: those consoles stored '' for
	// "the default node". Reading it back as the cluster is the intended upgrade.
	node = localStorage.getItem(NODE_KEY) || CLUSTER;
} catch {
	/* storage may be unavailable; the cluster default is fine */
}

export const getNode = () => node;

export const isCluster = () => node === CLUSTER;

export const setNode = (value) => {
	node = value || CLUSTER;
	try {
		localStorage.setItem(NODE_KEY, node);
	} catch {
		/* selection just won't survive a reload */
	}
};

const withNode = (url) => (node ? `${url}${url.includes('?') ? '&' : '?'}node=${encodeURIComponent(node)}` : url);

/**
 * Notified when any request comes back 401/403, so a session that lapses mid-use drops straight
 * back to the sign-in form instead of leaving every view rendering empty panels.
 *
 * Registered here rather than checked in each view: a view forgetting the check is silent, and
 * a shared callback also keeps app.js out of the views' import graph (they only import api.js,
 * so there is no cycle).
 */
let onExpired = () => {};
export const setExpiredHandler = (fn) => {
	onExpired = fn;
};

/** Never throws. A network failure comes back as `{ ok: false, status: 0 }` like any other. */
async function request(path, options) {
	let res;
	try {
		res = await fetch(withNode(`${BASE}/${path}`), options);
	} catch (e) {
		return { ok: false, status: 0, body: { error: `Request failed: ${e?.message ?? String(e)}` } };
	}
	let body = {};
	try {
		body = await res.json();
	} catch {
		/* a non-JSON error page is still a status we can report */
	}
	// `login` legitimately answers 403 for bad credentials; the sign-in form handles that itself.
	if ((res.status === 401 || res.status === 403) && path !== 'login') onExpired();
	return { ok: res.ok, status: res.status, body };
}

/**
 * Identical GETs in flight share one request.
 *
 * Views overlap in what they read — Health, Traffic and Queue all load the same analytics window —
 * and the shell drops a superseded load's RESPONSE without being able to cancel its REQUEST. So
 * switching views mid-load used to issue a second identical fetch, which the browser then held
 * behind the first (its cache lock) and which the node answered twice. Sharing the promise makes the
 * second caller ride the first. Only while in flight: a finished request is never reused, so a
 * Refresh always goes back to the server.
 */
const inflight = new Map();

export const get = (path, params) => {
	const url = path + (params && Object.keys(params).length ? `?${new URLSearchParams(params)}` : '');
	// Keyed with the scope too: the same route for another node is a different answer.
	const key = `${node}\u0000${url}`;
	let pending = inflight.get(key);
	if (!pending) {
		pending = request(url).finally(() => inflight.delete(key));
		inflight.set(key, pending);
	}
	return pending;
};

export const post = (path, data) =>
	request(path, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(data ?? {}),
	});

/** The URL of a stored page's HTML. Opened in a tab; served as text/plain, never text/html. */
export const pageContentUrl = (cacheKey) => withNode(`${BASE}/page-content?cacheKey=${encodeURIComponent(cacheKey)}`);
