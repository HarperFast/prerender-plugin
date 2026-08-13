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

// ---- node selection ----
//
// The console proxies to ONE prerender node at a time (analytics, queue state and the
// unrouted tally are all node-local, so mixing nodes would be incoherent). The selection
// rides every request as a `node` query parameter; the server validates it against its
// CONFIGURED list, so this value is a preference, never an address. Persisted so a reload
// keeps the operator on the node they were investigating.

const NODE_KEY = 'prerender-console-node';

let node = '';
try {
	node = localStorage.getItem(NODE_KEY) ?? '';
} catch {
	/* storage may be unavailable; the default node is fine */
}

export const getNode = () => node;

export const setNode = (value) => {
	node = value ?? '';
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

export const get = (path, params) =>
	request(path + (params && Object.keys(params).length ? `?${new URLSearchParams(params)}` : ''));

export const post = (path, data) =>
	request(path, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(data ?? {}),
	});

/** The URL of a stored page's HTML. Opened in a tab; served as text/plain, never text/html. */
export const pageContentUrl = (cacheKey) => withNode(`${BASE}/page-content?cacheKey=${encodeURIComponent(cacheKey)}`);
