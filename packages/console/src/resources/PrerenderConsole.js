/**
 * The prerender console, exported at `/prerender_console`: serves the UI shell and assets,
 * and proxies the console's API calls to a prerender deployment's `/prerender_admin`
 * endpoints on whichever configured node the operator has picked.
 *
 * WHY A SERVER-SIDE PROXY AND NOT BROWSER-DIRECT. The UI's security model is built on
 * being same-origin with its API: cookie sessions, CSP `connect-src 'self'`, no CORS
 * anywhere. Pointing the browser at another cluster would surrender all three — the
 * prerender API would need CORS plus cross-site cookies, and every prerender deployment's
 * attack surface would widen for the benefit of one console. The proxy keeps the browser
 * story identical to the embedded console it replaced, and the cross-cluster hop becomes a
 * bounded server-to-server request this component controls end to end.
 *
 * AUTH FORWARDS THE OPERATOR, NOT A SERVICE ACCOUNT. Sign-in is fanned out to every
 * configured node; each node authenticates the operator against ITS OWN Harper users and
 * issues its own session (Harper sessions are per instance — hence the fan-out, hence the
 * per-node token map in the console cookie, see util/proxy.js). This component stores no
 * credentials anywhere: the password passes through login and is gone, and what persists —
 * in an HttpOnly, SameSite=Strict, path-scoped cookie — are the upstreams' own session
 * tokens. Every action lands on the prerender cluster as the operator who clicked it.
 *
 * THE PROXY IS AN ALLOWLIST TWICE OVER. Routes: only the fixed set the console UI actually
 * calls (a test pins this list against PrerenderAdmin's dispatch, so drift fails CI).
 * Hosts: the `node` parameter is matched against the CONFIGURED node list and never
 * becomes a URL (util/proxy.js resolveNode) — the browser picks from the list, it cannot
 * steer the proxy anywhere else. Nothing else is forwarded: not the console cluster's own
 * cookies, not arbitrary headers, not upstream set-cookie beyond login's capture.
 */

import { request as undiciRequest, Agent } from 'undici';
import { config, getLogger } from '../config.js';
import { getAdminAsset, renderAdminPage } from '../admin/index.js';
import {
	cookiePairsFrom,
	decodeSessionCookie,
	encodeSessionCookie,
	forwardedQuery,
	PROXIED_GET as PROXIED_GET_LIST,
	PROXIED_POST as PROXIED_POST_LIST,
	readCookie,
	resolveNode,
} from '../util/proxy.js';

// GET routes forwarded upstream (everything else under GET is shell/assets or a 404), and
// POST routes likewise — `login`/`logout` are handled here, never forwarded blind. The
// lists live in util/proxy.js so the tests can pin them without Harper globals.
const PROXIED_GET = new Set(PROXIED_GET_LIST);
const PROXIED_POST = new Set(PROXIED_POST_LIST);

const noStore = (extra = {}) => ({ 'cache-control': 'no-store', ...extra });

const json = (data, status = 200, extraHeaders = {}) =>
	new Response(JSON.stringify(data), {
		status,
		headers: noStore({ 'content-type': 'application/json; charset=utf-8', ...extraHeaders }),
	});

const html = (body) =>
	new Response(body, {
		status: 200,
		headers: noStore({
			'content-type': 'text/html; charset=utf-8',
			'x-content-type-options': 'nosniff',
			'referrer-policy': 'no-referrer',
			// Same CSP as the embedded console this replaces: fully self-contained, and the
			// proxy is same-origin so connect-src 'self' still covers every API call.
			'content-security-policy':
				"default-src 'none'; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; img-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
		}),
	});

const assetResponse = (asset, requestHeaders) => {
	const headers = {
		'content-type': asset.contentType,
		'etag': asset.etag,
		'cache-control': asset.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
		'x-content-type-options': 'nosniff',
	};
	if (requestHeaders?.get?.('if-none-match') === asset.etag) {
		return new Response(null, { status: 304, headers });
	}
	return new Response(asset.body, { status: 200, headers });
};

const routeOf = (target) => {
	const id = target?.id;
	return id === null || id === undefined ? '' : String(id);
};

/**
 * The console cookie, as a set-cookie header value. Path-scoped to this resource, Strict
 * (nothing legitimate ever navigates INTO an API route cross-site), HttpOnly (the page
 * never needs to read it — it only rides requests). `Secure` is omitted only for a plain
 * http origin, which in practice means local development.
 */
const sessionSetCookie = (context, value, { clear = false } = {}) => {
	const secure = context?.headers?.get?.('x-forwarded-proto') !== 'http';
	return (
		`${config.cookieName}=${clear ? '' : value}; Path=/prerender_console; HttpOnly; SameSite=Strict` +
		(secure ? '; Secure' : '') +
		(clear ? '; Max-Age=0' : '')
	);
};

const tokensFrom = (context) =>
	decodeSessionCookie(readCookie(context?.headers?.get?.('cookie') ?? '', config.cookieName)) ?? {};

// One Agent per TLS mode, created lazily and kept: undici Agents pool connections, and the
// per-request alternative would re-handshake TLS to the same four nodes on every click.
const agents = new Map();
const agentFor = (rejectUnauthorized) => {
	let agent = agents.get(rejectUnauthorized);
	if (!agent) {
		agent = new Agent({ connect: { rejectUnauthorized } });
		agents.set(rejectUnauthorized, agent);
	}
	return agent;
};

/** One bounded upstream request. Throws on network failure/timeout; callers translate. */
async function upstream(origin, path, { method = 'GET', body, cookie } = {}) {
	const headers = { accept: 'application/json, text/plain' };
	if (cookie) headers.cookie = cookie;
	if (body !== undefined) headers['content-type'] = 'application/json';
	return undiciRequest(`${origin}/prerender_admin/${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
		dispatcher: agentFor(config.rejectUnauthorized),
		headersTimeout: config.requestTimeout,
		bodyTimeout: config.requestTimeout,
	});
}

/** Pass an upstream response through: status + content-type + body, nothing else. */
async function passThrough(res) {
	const contentType = String(res.headers['content-type'] ?? 'application/json; charset=utf-8');
	const body = Buffer.from(await res.body.arrayBuffer());
	return new Response(body, {
		status: res.statusCode,
		headers: noStore({ 'content-type': contentType, 'x-content-type-options': 'nosniff' }),
	});
}

/**
 * The picker metadata merged into session responses: what exists, what is signed in.
 * `hostname` is the URL's HOST (port included when non-default) — two nodes can share a
 * hostname and differ by port, and a picker showing two identical labels is unusable.
 */
const nodesFor = (tokens) =>
	config.nodes.map((origin) => ({
		origin,
		hostname: new URL(origin).host,
		signedIn: !!tokens[origin],
	}));

export class PrerenderConsole extends Resource {
	static loadAsInstance = false;

	async get(target) {
		const route = routeOf(target);
		const context = this.getContext();

		if (route === '') {
			if (!target?.isCollection) {
				return new Response(null, { status: 308, headers: noStore({ location: 'prerender_console/' }) });
			}
			return html(renderAdminPage());
		}

		const asset = getAdminAsset(route);
		if (asset) return assetResponse(asset, context?.headers);

		if (!PROXIED_GET.has(route)) return json({ error: `Unknown route: ${route}` }, 404);

		const tokens = tokensFrom(context);
		const node = resolveNode(target?.get?.('node'), config.nodes);

		// `session` answers even with nothing configured or nobody signed in: it is what the
		// UI boots from, and it must describe the situation rather than 401 into a blank page.
		if (route === 'session') return PrerenderConsole.session(node, tokens);

		if (!node) return json({ error: 'Unknown node — pick one of the configured nodes.', nodes: nodesFor(tokens) }, 400);
		if (!tokens[node]) return json({ error: 'Not signed in to this node', authenticated: false }, 401);

		try {
			const query = forwardedQuery(target);
			const res = await upstream(node, route + (query ? `?${query}` : ''), { cookie: tokens[node] });
			return await passThrough(res);
		} catch (e) {
			return PrerenderConsole.upstreamError(node, e);
		}
	}

	async post(target, data) {
		const route = routeOf(target);
		const context = this.getContext();

		if (route === 'login') return PrerenderConsole.login(context, data);
		if (route === 'logout') return PrerenderConsole.logout(context);

		if (!PROXIED_POST.has(route)) return json({ error: `Unknown route: ${route}` }, 404);

		const tokens = tokensFrom(context);
		const node = resolveNode(target?.get?.('node'), config.nodes);
		if (!node) return json({ error: 'Unknown node — pick one of the configured nodes.', nodes: nodesFor(tokens) }, 400);
		if (!tokens[node]) return json({ error: 'Not signed in to this node', authenticated: false }, 401);

		try {
			const res = await upstream(node, route, { method: 'POST', body: data ?? {}, cookie: tokens[node] });
			return await passThrough(res);
		} catch (e) {
			return PrerenderConsole.upstreamError(node, e);
		}
	}

	/**
	 * The session, from the picked node's point of view, plus the picker metadata the shell
	 * needs. An unreachable or signed-out node answers `authenticated: false` rather than an
	 * error: the sign-in form IS the correct rendering of both states.
	 */
	static async session(node, tokens) {
		const base = { nodes: nodesFor(tokens), selected: node, proxied: true };
		if (!node) {
			return json({ authenticated: false, sessionsEnabled: config.nodes.length > 0, ...base });
		}
		if (!tokens[node]) return json({ authenticated: false, sessionsEnabled: true, ...base });
		try {
			const res = await upstream(node, 'session', { cookie: tokens[node] });
			const body = await res.body.json();
			return json({ ...body, ...base });
		} catch (e) {
			getLogger().warn(`[prerender-console] session check against ${node} failed: ${e?.message ?? String(e)}`);
			return json({ authenticated: false, sessionsEnabled: true, unreachable: node, ...base });
		}
	}

	/**
	 * Fan the sign-in out to every configured node and keep each node's session token.
	 *
	 * Partial success is SUCCESS: three healthy nodes must not become unusable because the
	 * fourth is down — the per-node outcome rides back in the response and in `session`'s
	 * `signedIn` flags, and picking a failed node later simply lands on the sign-in form
	 * again. All-fail is a 403 carrying the first node's story (they will overwhelmingly be
	 * the same story: bad credentials).
	 */
	static async login(context, data) {
		const username = data?.username;
		const password = data?.password;
		if (typeof username !== 'string' || !username || typeof password !== 'string' || !password) {
			return json({ error: 'username and password are required' }, 400);
		}
		if (config.nodes.length === 0) {
			return json({ error: 'No prerender nodes are configured — set `nodes` in this component’s options.' }, 501);
		}

		const results = await Promise.all(
			config.nodes.map(async (origin) => {
				try {
					const res = await upstream(origin, 'login', { method: 'POST', body: { username, password } });
					const body = await res.body.json().catch(() => ({}));
					const cookie = cookiePairsFrom(res.headers['set-cookie']);
					if (res.statusCode === 200 && cookie) return { origin, ok: true, cookie };
					return {
						origin,
						ok: false,
						status: res.statusCode,
						error: body?.error ?? `login answered ${res.statusCode}`,
					};
				} catch (e) {
					return { origin, ok: false, status: 0, error: `unreachable: ${e?.message ?? String(e)}` };
				}
			})
		);

		const tokens = {};
		for (const result of results) if (result.ok) tokens[result.origin] = result.cookie;
		const outcomes = results.map(({ origin, ok, status, error }) => ({
			origin,
			ok,
			status: status ?? 200,
			error: error ?? null,
		}));

		if (Object.keys(tokens).length === 0) {
			const first = results[0];
			return json(
				{ error: first?.error ?? 'Sign-in failed on every node', nodes: outcomes },
				first?.status === 403 ? 403 : 502
			);
		}

		const failed = outcomes.filter((o) => !o.ok);
		if (failed.length) {
			getLogger().warn(
				`[prerender-console] login for ${username} succeeded on ${Object.keys(tokens).length}/${results.length} nodes; ` +
					failed.map((f) => `${f.origin}: ${f.error}`).join(' · ')
			);
		}

		return json({ authenticated: true, nodes: outcomes }, 200, {
			'set-cookie': sessionSetCookie(context, encodeSessionCookie(tokens)),
		});
	}

	/** Best-effort upstream logouts, then drop the console cookie — the part that matters. */
	static async logout(context) {
		const tokens = tokensFrom(context);
		await Promise.all(
			Object.entries(tokens).map(([origin, cookie]) =>
				upstream(origin, 'logout', { method: 'POST', body: {}, cookie }).then(
					(res) => res.body.dump(),
					() => {}
				)
			)
		);
		return json({ authenticated: false }, 200, { 'set-cookie': sessionSetCookie(context, '', { clear: true }) });
	}

	static upstreamError(node, e) {
		getLogger().warn(`[prerender-console] upstream request to ${node} failed: ${e?.message ?? String(e)}`);
		return json({ error: `The prerender node did not answer: ${e?.message ?? String(e)}`, node }, 502);
	}
}
