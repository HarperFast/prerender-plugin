/**
 * Pure helpers for the console's upstream proxy: the session-cookie codec, node
 * resolution, and set-cookie capture. No I/O — everything here is unit-tested directly.
 */

/**
 * The routes the proxy will forward — nothing else leaves this component. Lives here (not
 * in the resource, which needs Harper globals to even import) so the test suite can pin
 * these lists against BOTH the client's calls and the plugin's dispatch.
 */
export const PROXIED_GET = Object.freeze([
	'session',
	'overview',
	'config',
	'invalidations',
	'sitemaps',
	'pages',
	'page-content',
	'unrouted',
	'analytics',
	'crawl-breadth',
	'metrics',
]);

export const PROXIED_POST = Object.freeze([
	'explain',
	'schedule',
	'queue',
	'invalidate',
	'revalidate',
	'reconcile',
	'backlog',
	'sitemap',
	'sitemap-refresh',
]);

/**
 * The console cookie holds ONE upstream session token per node, because Harper sessions
 * are per instance: a token issued by node A authenticates nowhere else, and a console
 * with a node picker that forced a fresh login per switch would teach operators to stop
 * switching. Login fans out once; this map is the result.
 *
 * Shape: `{ v: 1, nodes: { "<origin>": "<cookie-pair;cookie-pair>" } }`, base64url-encoded.
 * The values are the upstream's own `name=value` pairs, captured verbatim from login's
 * set-cookie headers — the console does not assume the cookie's name, so a Harper that
 * renames its session cookie keeps working.
 */
export const encodeSessionCookie = (tokensByNode) =>
	Buffer.from(JSON.stringify({ v: 1, nodes: tokensByNode })).toString('base64url');

// Bound on the decoded payload. Real payloads are ~100 bytes per node; anything near this
// is not ours.
const MAX_COOKIE_JSON = 8192;

/** Decode, or null for anything malformed — a bad cookie is "signed out", never a throw. */
export function decodeSessionCookie(value) {
	if (typeof value !== 'string' || !value || value.length > MAX_COOKIE_JSON) return null;
	try {
		const json = Buffer.from(value, 'base64url').toString('utf8');
		if (json.length > MAX_COOKIE_JSON) return null;
		const parsed = JSON.parse(json);
		if (parsed?.v !== 1 || typeof parsed.nodes !== 'object' || parsed.nodes === null) return null;
		const nodes = {};
		for (const [origin, token] of Object.entries(parsed.nodes)) {
			if (typeof token === 'string' && token) nodes[origin] = token;
		}
		return nodes;
	} catch {
		return null;
	}
}

/** The console cookie's value in a request's Cookie header, or null. */
export function readCookie(cookieHeader, name) {
	if (typeof cookieHeader !== 'string' || !cookieHeader) return null;
	for (const pair of cookieHeader.split(';')) {
		const eq = pair.indexOf('=');
		if (eq === -1) continue;
		if (pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
	}
	return null;
}

/**
 * Resolve the browser-supplied node parameter to a configured origin.
 *
 * THE PARAMETER NEVER BECOMES A URL. It is matched — as a full origin or a bare hostname —
 * against the configured list, and anything else resolves to null (answered 400 upstream of
 * any fetch). This is the SSRF gate: the browser picks FROM the list, it cannot extend it.
 * Absent parameter = the first configured node, so a fresh session lands somewhere stable.
 */
export function resolveNode(param, nodes) {
	if (!nodes?.length) return null;
	if (param === null || param === undefined || param === '') return nodes[0];
	const wanted = String(param);
	for (const origin of nodes) {
		if (origin === wanted) return origin;
		try {
			// Match host (hostname:port) before bare hostname: two nodes can share a hostname
			// and differ by port, and the bare-hostname match would silently pick the first.
			const url = new URL(origin);
			if (url.host === wanted || url.hostname === wanted) return origin;
		} catch {
			/* a malformed configured entry was already dropped by applyOptions */
		}
	}
	return null;
}

/**
 * The `name=value` pairs from a login response's set-cookie headers, joined ready for a
 * Cookie request header. Attributes (Path, HttpOnly, …) are the upstream telling its OWN
 * browser story; the proxy keeps only the pairs.
 */
export function cookiePairsFrom(setCookie) {
	const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
	const pairs = [];
	for (const header of headers) {
		const pair = String(header).split(';', 1)[0].trim();
		if (pair && pair.includes('=')) pairs.push(pair);
	}
	return pairs.join('; ');
}

/**
 * The query string to forward upstream: everything the client sent except the console's
 * own `node` selector. Tries the standard iteration surfaces a RequestTarget may expose
 * and falls back to the known parameter names, so an exotic target shape degrades to
 * "forward the documented params" rather than dropping the query silently.
 */
const KNOWN_PARAMS = ['prefix', 'cursor', 'limit', 'cacheKey', 'days', 'range'];

export function forwardedQuery(target) {
	const out = new URLSearchParams();
	const searchParams =
		typeof target?.searchParams?.entries === 'function'
			? target.searchParams
			: typeof target?.entries === 'function'
				? target
				: null;
	if (searchParams) {
		try {
			for (const [key, value] of searchParams.entries()) {
				if (key !== 'node') out.append(key, value);
			}
			return out.toString();
		} catch {
			/* fall through to the known-name probe */
		}
	}
	for (const key of KNOWN_PARAMS) {
		const value = target?.get?.(key);
		if (value !== null && value !== undefined && value !== '') out.append(key, String(value));
	}
	return out.toString();
}
