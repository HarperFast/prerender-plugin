/**
 * Intra-cluster peer calls for the management API.
 *
 * `RenderSchedule` is residency-pinned, and a point `get` for a row owned by another node
 * takes Harper's cross-node `sourceLoad` path, which awaits a replication `getRecord` with
 * NO timeout — an unanswered peer hangs the request forever. Every read in this plugin
 * therefore passes `replicateFrom: false` and stays node-local.
 *
 * That keeps the explainer responsive but leaves it unable to answer authoritatively: with
 * rendezvous hashing over N nodes, (N-1)/N of all URLs are owned elsewhere (~75% on the
 * 4-node kohls cluster), so "the row lives on another node" would be the usual answer. This
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

/**
 * Base origin for a peer node. Mirrors the `callbackOrigin` logic in RenderQueue: prefer the
 * secure port, fall back to the plain port for a localhost origin.
 */
export const peerOrigin = (hostname) => {
	const httpConfig = server.config?.http ?? {};
	const secure = !isLocalHost(hostname);
	const port = secure ? httpConfig.securePort || httpConfig.port : httpConfig.port || httpConfig.securePort;
	return `${secure ? 'https' : 'http'}://${hostname}:${port}`;
};

/**
 * Is `hostname` a node this cluster knows about? Guards the fetch destination: the owner comes
 * from our own residency function, but validating it against the node list keeps a bug or a
 * config change from turning this into an arbitrary-host request.
 */
export const isKnownNode = (hostname) => typeof hostname === 'string' && nodes.includes(hostname);

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
		return { ok: true, row: body?.renderSchedule ?? null };
	} catch (e) {
		// AbortError included — a peer that doesn't answer costs one field, not the request.
		return { ok: false, reason: e.name === 'AbortError' ? 'peer timed out' : `peer fetch failed: ${e.message}` };
	} finally {
		clearTimeout(timer);
	}
};
