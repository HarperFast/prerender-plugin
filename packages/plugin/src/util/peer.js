/**
 * Intra-cluster peer calls for the management API.
 *
 * `RenderSchedule` is residency-pinned, and a point `get` for a row owned by another node
 * takes Harper's cross-node `sourceLoad` path, which awaits a replication `getRecord` with
 * NO timeout — an unanswered peer hangs the request forever. Every read in this plugin
 * therefore passes `replicateFrom: false` and stays node-local.
 *
 * That keeps the explainer responsive but leaves it unable to answer authoritatively: with
 * rendezvous hashing over N nodes, (N-1)/N of all URLs are owned elsewhere (~75% on a
 * four-node cluster), so "the row lives on another node" would be the usual answer. This
 * module closes that gap by asking the owner over plain HTTPS instead — a bounded request we
 * control, rather than an unbounded one we don't.
 *
 * Safety properties:
 *   - The destination is always a hostname from the cluster's own node list (`nodes`), never
 *     a value derived from the request, so this cannot be pointed at an arbitrary host.
 *   - Only the caller's own credentials are forwarded; the peer re-runs its own super-user
 *     check. This proxy grants no authority the caller didn't already have.
 *   - Bounded by `management.peerTimeoutMs`; a slow peer degrades the field, never the page.
 *   - The endpoint it calls (`/prerender_admin/schedule`) never proxies onward, so there is
 *     no recursion regardless of residency disagreement between nodes.
 */

import { config } from '../config.js';
import { nodes } from './residency.js';

// Peers are reached over TLS: the Harper HTTP port serves TLS in every real deployment, and
// the node certificates chain to a publicly-trusted CA, so standard validation applies (no
// custom CA, no disabled verification). Only a localhost origin speaks plain http.
const isLocalHost = (hostname) => hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';

// An IPv6 literal must be bracketed before a port can be appended, or the result isn't a
// parseable URL (`https://::1:9926`). Worth handling rather than assuming DNS names: this
// module's own `isLocalHost` already contemplates `::1`, so the unbracketed form was reachable
// by the code as written.
const formatHost = (hostname) => (hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname);

/**
 * Base origin for a peer node. Mirrors the `callbackOrigin` logic in RenderQueue: prefer the
 * secure port, fall back to the plain port for a localhost origin.
 */
export const peerOrigin = (hostname) => {
	const httpConfig = server.config?.http ?? {};
	const secure = !isLocalHost(hostname);
	const port = secure ? httpConfig.securePort || httpConfig.port : httpConfig.port || httpConfig.securePort;
	return `${secure ? 'https' : 'http'}://${formatHost(hostname)}:${port}`;
};

/**
 * Is `hostname` a node this cluster knows about? Guards the fetch destination: the owner comes
 * from our own residency function, but validating it against the node list keeps a bug or a
 * config change from turning this into an arbitrary-host request.
 *
 * Compared case-insensitively, since hostnames are: a casing difference between Harper's
 * configured node name and the resolved one would otherwise fail a legitimate peer. This does
 * not weaken the guard — membership in the known set is still required.
 */
export const isKnownNode = (hostname) =>
	typeof hostname === 'string' && nodes.some((node) => node.toLowerCase() === hostname.toLowerCase());

/**
 * The subset of the caller's headers to forward. Only credentials, nothing else — the peer
 * authenticates the ORIGINAL user and applies its own super-user gate.
 *
 * Both forms work cluster-wide: Harper users are replicated, and the session cookie is issued
 * for the shared parent domain (`authentication.cookie.domains`), so the browser already holds
 * one valid for every node.
 */
export const credentialHeaders = (headers) => {
	const out = {};
	const authorization = headers?.get?.('authorization');
	const cookie = headers?.get?.('cookie');
	if (authorization) out.authorization = authorization;
	if (cookie) out.cookie = cookie;
	return out;
};

/**
 * Ask `hostname` for its local RenderSchedule row for `cacheKey`.
 *
 * Returns `{ ok: true, row }` on success (`row` may be null — an authoritative "no schedule"),
 * or `{ ok: false, reason }` so the caller can fall back to its node-local answer and say why
 * rather than presenting a failure as an absence.
 */
export const fetchScheduleFromPeer = async ({ hostname, cacheKey, headers }) => {
	if (!isKnownNode(hostname)) return { ok: false, reason: `unknown node "${hostname}"` };

	const credentials = credentialHeaders(headers);
	if (!credentials.authorization && !credentials.cookie) {
		return { ok: false, reason: 'no forwardable credentials on this request' };
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.management.peerTimeoutMs);
	timer.unref?.();

	try {
		const response = await fetch(`${peerOrigin(hostname)}/prerender_admin/schedule`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', ...credentials },
			body: JSON.stringify({ cacheKey }),
			signal: controller.signal,
		});

		if (!response.ok) {
			return { ok: false, reason: `peer responded ${response.status}` };
		}

		const body = await response.json();
		// `claimFloor` comes back too, and it is the OWNER's — the only copy that means anything
		// for this key. The claim floor and the lease table are node-local, so the querying node's
		// own numbers would be an answer to a different question.
		return { ok: true, row: body?.renderSchedule ?? null, claimFloor: body?.claimFloor ?? null };
	} catch (e) {
		// AbortError included — a peer that doesn't answer costs one field, not the request.
		//
		// Properties are read with `?.` rather than gated on `instanceof Error`: anything can be
		// thrown, and `null`/`undefined` would make a direct property access throw. `instanceof`
		// would be the wrong guard here — an abort rejects with a DOMException, whose prototype
		// chain differs across runtimes, so testing for Error risks misreporting a timeout as a
		// generic failure. Reading the name directly classifies it correctly either way.
		const name = e?.name;
		const message = e?.message ?? String(e);
		return { ok: false, reason: name === 'AbortError' ? 'peer timed out' : `peer fetch failed: ${message}` };
	} finally {
		clearTimeout(timer);
	}
};
