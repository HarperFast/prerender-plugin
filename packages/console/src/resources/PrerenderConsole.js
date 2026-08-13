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
 *
 * THE DEFAULT SCOPE IS THE CLUSTER, not a node. A prerender deployment's numbers are node-local
 * by construction — analytics rows, the backlog snapshot's owned-key slice, the claim floor —
 * so a per-node console showed one quarter of a four-node cluster and left the operator adding
 * up four browser tabs. `node=cluster` (the default) fans the read out to every signed-in node
 * and merges the answers here; `node=<hostname>` is the drill-down. Which routes merge, which
 * are answered by one node because the data replicates, and how each merge is defined, all live
 * in util/aggregate.js. Writes are never fanned out — see the POST handler.
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
	resolveScope,
} from '../util/proxy.js';
import { CLUSTER, mergerFor, NODE_LOCAL_POST, SHARED_NOTE } from '../util/aggregate.js';

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

// ------------------------------------------------------------------ cluster fan-out

/**
 * Concurrency cap on a fan-out. Four nodes is the shape this was built for and runs fully
 * parallel; the cap only matters for a large cluster, where the point is that ONE console
 * refresh must never become twenty simultaneous scans on twenty traffic-serving nodes.
 */
const FANOUT_CONCURRENCY = 6;

async function mapLimit(items, limit, fn) {
	const out = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			out[index] = await fn(items[index], index);
		}
	});
	await Promise.all(workers);
	return out;
}

const hostOf = (origin) => {
	try {
		return new URL(origin).host;
	} catch {
		return origin;
	}
};

/**
 * Ask every configured node the same question, concurrently, and never throw.
 *
 * A node that is down, slow or signed out becomes a FAILED RESULT, not an exception: the merge
 * layer reports it in `sources` and the UI labels the aggregate incomplete. The alternative —
 * failing the whole request because one node of four is unreachable — would make the cluster
 * view useless in exactly the situation an operator opens it for.
 */
async function fanOut(route, { tokens, query = '', method = 'GET', body } = {}) {
	return mapLimit(config.nodes, FANOUT_CONCURRENCY, async (origin) => {
		const base = { origin, hostname: hostOf(origin) };
		const cookie = tokens[origin];
		if (!cookie) return { ...base, ok: false, status: 401, error: 'not signed in to this node', ms: null };

		const began = Date.now();
		try {
			const res = await upstream(origin, route + (query ? `?${query}` : ''), { method, body, cookie });
			const ms = Date.now() - began;
			const payload = await res.body.json().catch(() => null);
			if (res.statusCode !== 200) {
				return {
					...base,
					ok: false,
					status: res.statusCode,
					error: payload?.error ?? `answered ${res.statusCode}`,
					ms,
				};
			}
			return { ...base, ok: true, status: 200, error: null, ms, body: payload };
		} catch (e) {
			return {
				...base,
				ok: false,
				status: 0,
				error: `unreachable: ${e?.message ?? String(e)}`,
				ms: Date.now() - began,
			};
		}
	});
}

/**
 * A route whose data is REPLICATED, answered by one node under cluster scope.
 *
 * Fanning these out would cost N reads of N identical answers — the pages listing is a capped
 * scan on every node instead of one. Nodes are tried in configured order and only a TRANSPORT
 * failure advances to the next: an upstream 4xx/5xx is that node's real answer to a question
 * every node would answer the same way, and retrying it elsewhere would just hide it.
 */
async function firstReachable(route, { tokens, query = '', signedIn }) {
	let lastError = null;
	for (const origin of signedIn) {
		try {
			const res = await upstream(origin, route + (query ? `?${query}` : ''), { cookie: tokens[origin] });
			return { origin, res };
		} catch (e) {
			lastError = e;
			getLogger().warn(
				`[prerender-console] ${hostOf(origin)} did not answer ${route}; trying the next node: ${e?.message ?? String(e)}`
			);
		}
	}
	return { origin: null, error: lastError };
}

/**
 * Attach the provenance envelope to a shared (single-node) JSON answer, so "cluster" never
 * implies a fan-out that did not happen. A non-JSON body is passed through untouched —
 * `page-content` serves a stored page as text and must stay byte-exact.
 */
async function sharedResponse(route, origin, res, tokens) {
	if (res.statusCode !== 200) return passThrough(res);
	const payload = await res.body.json().catch(() => null);
	if (!payload || typeof payload !== 'object')
		return json({ error: 'The prerender node sent an unreadable body' }, 502);
	return json({
		...payload,
		scope: 'cluster',
		// `complete: true` because for replicated data one node IS the whole answer — this
		// envelope exists to name the node and the reason, not to confess a shortfall.
		sources: {
			mode: 'shared',
			scope: 'cluster',
			servedBy: hostOf(origin),
			note: SHARED_NOTE[route] ?? 'this data is the same on every node',
			answered: 1,
			configured: config.nodes.length,
			complete: true,
			nodes: config.nodes.map((node) => ({
				origin: node,
				hostname: hostOf(node),
				ok: node === origin,
				status: node === origin ? 200 : 0,
				error: node === origin ? null : tokens[node] ? 'not queried (replicated data)' : 'not signed in to this node',
				ms: null,
			})),
		},
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
		const scope = resolveScope(target?.get?.('node'), config.nodes);

		// `session` answers even with nothing configured or nobody signed in: it is what the
		// UI boots from, and it must describe the situation rather than 401 into a blank page.
		if (route === 'session') return PrerenderConsole.session(scope, tokens);

		if (!scope) {
			return json({ error: 'Unknown node — pick one of the configured nodes.', nodes: nodesFor(tokens) }, 400);
		}

		const query = forwardedQuery(target);
		if (scope.cluster) return PrerenderConsole.clusterGet(route, query, tokens);

		const node = scope.origin;
		if (!tokens[node]) return json({ error: 'Not signed in to this node', authenticated: false }, 401);

		try {
			const res = await upstream(node, route + (query ? `?${query}` : ''), { cookie: tokens[node] });
			return await passThrough(res);
		} catch (e) {
			return PrerenderConsole.upstreamError(node, e);
		}
	}

	/**
	 * One cluster-scoped read: fan out and merge, or read one node for replicated data.
	 *
	 * The signed-in set is the fan-out set. A node the operator never authenticated to is a
	 * failed source with that reason — a merged number is not allowed to quietly omit a node
	 * just because the sign-in fan-out missed it.
	 */
	static async clusterGet(route, query, tokens) {
		const signedIn = config.nodes.filter((origin) => tokens[origin]);
		if (!signedIn.length) return json({ error: 'Not signed in to any node', authenticated: false }, 401);

		const merge = mergerFor(route);
		if (merge) {
			const results = await fanOut(route, { tokens, query });
			const { status, body } = merge(results);
			return json(body, status);
		}

		// Replicated or static: one node answers for the cluster.
		const { origin, res, error } = await firstReachable(route, { tokens, query, signedIn });
		if (!origin) return PrerenderConsole.upstreamError(signedIn[0], error ?? new Error('no node answered'));
		// A stored page is served as text and downloaded, not parsed — it must stay byte-exact,
		// so it never gets the JSON envelope.
		return route === 'page-content' ? passThrough(res) : sharedResponse(route, origin, res, tokens);
	}

	async post(target, data) {
		const route = routeOf(target);
		const context = this.getContext();

		if (route === 'login') return PrerenderConsole.login(context, data);
		if (route === 'logout') return PrerenderConsole.logout(context);

		if (!PROXIED_POST.has(route)) return json({ error: `Unknown route: ${route}` }, 404);

		const tokens = tokensFrom(context);
		const scope = resolveScope(target?.get?.('node'), config.nodes);
		if (!scope) {
			return json({ error: 'Unknown node — pick one of the configured nodes.', nodes: nodesFor(tokens) }, 400);
		}

		/**
		 * ACTIONS ARE NEVER FANNED OUT. A read can be summed; a write cannot be "summed", and
		 * running one four times is a different act from running it once.
		 *
		 * Under cluster scope a write lands on ONE node, which is correct for everything that
		 * writes a replicated table (an invalidation, a revalidation, a queue-control row — the
		 * write replicates and the `scope` field inside it already says who it applies to). The
		 * exceptions are the routes that act on a single node's OWN state; those refuse and say
		 * to pick a node, because a "Run repair sweep" button that silently swept one node of
		 * four while the console read "all nodes" is a lie an operator would only catch later.
		 */
		let node = scope.origin;
		if (scope.cluster) {
			const refusal = NODE_LOCAL_POST[route];
			if (refusal) return json({ error: refusal, needsNode: true, nodes: nodesFor(tokens) }, 409);
			node = config.nodes.find((origin) => tokens[origin]) ?? null;
			if (!node) return json({ error: 'Not signed in to any node', authenticated: false }, 401);
		}
		if (!tokens[node]) return json({ error: 'Not signed in to this node', authenticated: false }, 401);

		try {
			const res = await upstream(node, route, { method: 'POST', body: data ?? {}, cookie: tokens[node] });
			return await passThrough(res);
		} catch (e) {
			return PrerenderConsole.upstreamError(node, e);
		}
	}

	/**
	 * The session, from the picked scope's point of view, plus the picker metadata the shell
	 * needs. An unreachable or signed-out node answers `authenticated: false` rather than an
	 * error: the sign-in form IS the correct rendering of both states.
	 *
	 * UNDER CLUSTER SCOPE, ANY signed-in node is a session. The console is authenticated as
	 * long as it can read somewhere — dropping an operator to the sign-in form because the
	 * first configured node went down, while three others hold valid sessions, would be a
	 * self-inflicted outage of the tool you open during an outage. The identity comes from a
	 * node that answered, and the picker's per-node flags carry the rest of the story.
	 */
	static async session(scope, tokens) {
		const clusterScope = !!scope?.cluster;
		const base = {
			nodes: nodesFor(tokens),
			selected: clusterScope ? CLUSTER : (scope?.origin ?? null),
			clusterAvailable: config.nodes.length > 1,
			proxied: true,
		};
		if (!scope) {
			return json({ authenticated: false, sessionsEnabled: config.nodes.length > 0, ...base });
		}

		if (clusterScope) {
			const signedIn = config.nodes.filter((origin) => tokens[origin]);
			if (!signedIn.length) return json({ authenticated: false, sessionsEnabled: true, ...base });

			// SEQUENTIAL, not a fan-out. This runs before EVERY view load, so it is the one
			// cluster-scoped read that must not multiply: the first node to confirm the operator
			// ends it, and the walk continues only past a node that is down or has expired the
			// session — which is precisely the case a single hardcoded node would fail on.
			const failed = [];
			for (const origin of signedIn) {
				try {
					const res = await upstream(origin, 'session', { cookie: tokens[origin] });
					const body = await res.body.json().catch(() => null);
					if (body?.authenticated) {
						return json({ ...body, node: null, scope: 'cluster', checkedNode: hostOf(origin), ...base });
					}
					failed.push(hostOf(origin));
				} catch (e) {
					getLogger().warn(`[prerender-console] session check against ${origin} failed: ${e?.message ?? String(e)}`);
					failed.push(hostOf(origin));
				}
			}
			return json({
				authenticated: false,
				sessionsEnabled: true,
				...(failed.length ? { unreachable: failed.join(', ') } : {}),
				...base,
			});
		}

		const node = scope.origin;
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
