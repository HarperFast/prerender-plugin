/**
 * Pure helpers for the console's upstream proxy: the session-cookie codec, scope/node
 * resolution, and set-cookie capture. No I/O — everything here is unit-tested directly.
 *
 * The cluster MERGE math lives next door in aggregate.js; this module only decides WHICH
 * upstream(s) a request is allowed to reach.
 */

import { CLUSTER } from './aggregate.js';

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
	'sweep-orphans',
	'backlog',
	'sitemap',
	'sitemap-refresh',
	'config-override',
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
 * Resolve the browser-supplied `node` parameter to a SCOPE: the whole cluster, or one node.
 *
 * `cluster` is the default and the sentinel — the console's headline view is the cluster, and a
 * single node is the drill-down. It is a literal, never an address: it cannot collide with a
 * configured origin (those are absolute URLs) and it never reaches `resolveNode`, so the SSRF
 * gate below is untouched by it. With one node configured there is no cluster to aggregate, so
 * the sentinel collapses to that node and the UI drops the picker entirely.
 *
 * Returns `{ cluster: true }`, `{ cluster: false, origin }`, or null for an unknown node.
 */
export function resolveScope(param, nodes) {
	if (!nodes?.length) return null;
	const wanted = param === null || param === undefined || param === '' ? CLUSTER : String(param).toLowerCase();
	if (wanted === CLUSTER) return nodes.length > 1 ? { cluster: true } : { cluster: false, origin: nodes[0] };
	const origin = resolveNode(param, nodes);
	return origin ? { cluster: false, origin } : null;
}

/**
 * Resolve the browser-supplied node parameter to a configured origin.
 *
 * THE PARAMETER NEVER BECOMES A URL. It is matched — as a full origin or a bare hostname —
 * against the configured list, and anything else resolves to null (answered 400 upstream of
 * any fetch). This is the SSRF gate: the browser picks FROM the list, it cannot extend it.
 * Absent parameter = the first configured node, so a caller that resolved a node directly
 * (rather than through `resolveScope`) still lands somewhere stable.
 */
export function resolveNode(param, nodes) {
	if (!nodes?.length) return null;
	if (param === null || param === undefined || param === '') return nodes[0];
	// Hostnames are case-insensitive, and `new URL()` already lowercased the configured
	// origins in applyOptions — lowercase the parameter too, or a mixed-case hostname from
	// the client would never match anything.
	const wanted = String(param).toLowerCase();
	for (const origin of nodes) {
		if (origin.toLowerCase() === wanted) return origin;
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
 * The ONE node a write goes to. Never a list — this is the whole of the console's write routing.
 *
 * Under node scope it is the node the operator picked. Under CLUSTER scope it is the first
 * configured node holding a session, and the significant word is "first": the cluster-scoped
 * writes this console forwards all land in REPLICATED tables (an invalidation, a queue-control
 * row, a config override), so one node's commit reaches every node on its own. Fanning the write
 * out would be N racing writes to the same rows — and worse, a partial failure would report an
 * error for a write that in fact succeeded and replicated, which is the report an operator acts
 * on by writing it again.
 *
 * Configured order also makes the choice STABLE: the same node takes every cluster-scoped write
 * for as long as it holds a session, so a sequence of edits lands in one place in one order
 * rather than racing itself across the cluster.
 *
 * Null means nowhere to send it — no session anywhere (the caller answers 401). A node that is
 * signed in but unreachable is NOT stepped over: unlike a read, a write that failed in transit
 * may still have been committed and replicated before the connection dropped, so retrying it
 * elsewhere is a decision about a write of unknown status, not a fallback. The operator gets the
 * 502 naming the node and can pick another one deliberately.
 */
export function writeNode(scope, tokens, nodes) {
	if (!scope) return null;
	if (!scope.cluster) return scope.origin;
	return nodes?.find((origin) => tokens?.[origin]) ?? null;
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
