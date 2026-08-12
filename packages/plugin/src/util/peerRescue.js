/**
 * Serve-path peer rescue: when a servable cached page's LOCAL blob fails the bounded read —
 * gone (a dangling reference, harper#2134) or still arriving past `page.blobReadBudgetMs`
 * (a base copy is streaming it, harper-pro#683) — fetch the bytes from the URL's residency
 * owner instead of proxying the origin.
 *
 * WHY THE OWNER. Render claims are owner-scoped (`RenderSchedule` is residency-pinned and each
 * node claims only its own rows) and `callbackOrigin` points the render result back at the
 * granting node, so the owner WROTE every version of this key's blob. Its copy is a local
 * original, never a received replica — and both failure modes this rescues are receive-side.
 * The win is content as much as latency: the rescue serves the real prerendered snapshot where
 * the origin proxy serves raw un-prerendered markup, and an intra-cluster fetch is a few ms
 * against ~500ms to the origin.
 *
 * Safety properties (same posture as util/peer.js, which established this pattern for the
 * explainer):
 *   - The destination is computed from our own residency function and validated against the
 *     cluster's node list — never a value derived from the request, so this cannot be pointed
 *     at an arbitrary host.
 *   - Authenticated by a shared cluster token (`peerRescue.token`), compared timing-safely on
 *     the peer. A bot request carries no user credentials to forward, which is why this is a
 *     configured secret rather than the credential forwarding the management peer call uses.
 *   - Bounded by `peerRescue.timeoutMs`; a slow peer costs one bounded wait, then the request
 *     takes the origin path it would have taken anyway.
 *   - The endpoint it calls (`/prerender_peer/page`) answers strictly from its local cache and
 *     never proxies onward — no recursion regardless of residency disagreement between nodes.
 *
 * Fails CLOSED: with `enabled: false` or an empty token this module answers 'disabled' without
 * touching the network, and the endpoint (http_handlers/peer_page.js) refuses to serve.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { Agent } from 'undici';
import { config } from '../config.js';
import { getResidencyByUrl } from './residency.js';
import { peerOrigin, isKnownNode } from './peer.js';

/** Both halves ON and a non-empty secret — the single gate for the client AND the endpoint. */
export const isPeerRescueActive = () =>
	Boolean(config.peerRescue.enabled && config.peerRescue.token && config.peerRescue.header);

// Compare via fixed-size digests: `timingSafeEqual` THROWS on length mismatch, so comparing the
// raw strings would leak the token length and turn a wrong-length probe into an exception on a
// public-facing worker. Hashing first makes every comparison the same size and the same cost.
const digest = (value) => createHash('sha256').update(String(value)).digest();

/** Does `provided` match the configured shared token? Timing-safe; empty never matches. */
export const peerTokenMatches = (provided) => {
	const expected = config.peerRescue.token;
	if (!provided || !expected) return false;
	return timingSafeEqual(digest(provided), digest(expected));
};

// Pooled keep-alive connections to peers (peers are a handful of fixed origins, so the pool
// stays warm between bursts). Deliberately UNCAPPED (undici's default): v0.41.0 capped this at
// 4 connections per owner to bound sockets during a copy storm, and production showed that to
// be exactly backwards — rescue demand arrives in bursts (12-15/min measured mid-copy), the
// queued requests burned their `timeoutMs` deadline waiting for a pool slot, and the misses
// surfaced as "peer timed out" origin fallbacks. A rescue that queues is a rescue that fails;
// an extra socket to our own cluster node is cheap. Concurrency stays bounded in practice by
// the serve path itself (only blob-failure requests reach here, each bounded by `timeoutMs`).
// Lazily built: config is not applied at import time.
let agent;
const dispatcher = () => (agent ??= new Agent());

/**
 * Fetch `cacheKey`'s stored page from the residency owner of `cacheUrl`.
 *
 * Returns `{ ok: true, owner, page, body }` — `page` is the OWNER's record metadata
 * (statusCode, headers, lastCached, expiresAt, isIndexable) and `body` its stored bytes, one
 * consistent version — or `{ ok: false, reason, owner? }` so the caller can fall back to the
 * origin and say why. Never throws.
 */
export const rescueFromOwner = async ({ cacheKey, cacheUrl }) => {
	if (!isPeerRescueActive()) return { ok: false, reason: 'disabled' };

	// `cacheUrl` IS the url half of the cache key, and hashing it matches RenderSchedule's own
	// `setResidencyById` (which hashes `CacheKey.extractUrl(cacheKey)`) — the owner computed here
	// is the node whose claims rendered this key.
	const owner = getResidencyByUrl(cacheUrl);
	if (owner === server.hostname) return { ok: false, reason: 'self-owned' };
	// Defense in depth, as in util/peer.js: the owner comes from our own residency function, but
	// validating it against the node list keeps a bug from turning this into an arbitrary-host request.
	if (!isKnownNode(owner)) return { ok: false, reason: `unknown node "${owner}"` };

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), config.peerRescue.timeoutMs);
	timer.unref?.();

	// Timed because nothing else measures the client side of a rescue: the owner's
	// Server-Timing covers only its handler, and the network hop (cross-region TLS + a
	// ~200KB body) is most of the cost. The caller logs it, which is what makes a slow
	// peer visible BEFORE it becomes a "peer timed out" miss.
	const started = performance.now();
	try {
		// undici.request rather than fetch: it sends no implicit accept-encoding, so the stored
		// bytes cross the wire exactly as written — they must stay paired with the stored
		// content-encoding header in the metadata, and a transparent decompression on this hop
		// would silently break that pairing.
		const response = await dispatcher().request({
			origin: peerOrigin(owner),
			path: `/prerender_peer/page?key=${encodeURIComponent(cacheKey)}`,
			method: 'GET',
			headers: { [config.peerRescue.header]: config.peerRescue.token },
			signal: controller.signal,
		});

		if (response.statusCode !== 200) {
			// Drain so the pooled connection is reusable rather than torn down.
			await response.body.dump();
			return { ok: false, owner, reason: `peer responded ${response.statusCode}` };
		}

		const page = parsePageMetadata(response.headers['x-prerender-page']);
		if (!page) {
			await response.body.dump();
			return { ok: false, owner, reason: 'peer response missing page metadata' };
		}

		const body = Buffer.from(await response.body.arrayBuffer());
		return { ok: true, owner, page, body, ms: performance.now() - started };
	} catch (e) {
		// Read with `?.` rather than gated on instanceof — anything can be thrown, and an abort's
		// prototype chain differs across runtimes (see the same handling in util/peer.js).
		const reason = e?.name === 'AbortError' ? 'peer timed out' : `peer fetch failed: ${e?.message ?? e}`;
		return { ok: false, owner, reason };
	} finally {
		clearTimeout(timer);
	}
};

// The peer's record metadata, validated just enough that the serve path can trust its shape:
// a rescued response commits the peer's statusCode, so a malformed header must read as a failed
// rescue (origin fallback), never as a served `undefined`.
const parsePageMetadata = (headerValue) => {
	if (!headerValue) return null;
	let meta;
	try {
		meta = JSON.parse(String(headerValue));
	} catch {
		return null;
	}
	if (!meta || typeof meta.statusCode !== 'number') return null;
	return meta;
};
