/**
 * The peer-rescue endpoint: `GET /prerender_peer/page?key=<cacheKey>` answers with this node's
 * stored copy of that page — raw blob bytes as the body, the record's metadata in one
 * `x-prerender-page` response header — so a peer whose local blob failed the serve-path read
 * can serve the owner's copy instead of proxying the origin (see util/peerRescue.js for why
 * the owner's copy is the one worth asking for).
 *
 * Deliberately dumb, in both directions:
 *   - It answers STRICTLY from the local cache and never proxies onward — no recursion is
 *     possible regardless of residency disagreement between nodes, the same property the
 *     explainer's `/prerender_admin/schedule` endpoint keeps.
 *   - It applies no freshness verdict. The caller already proved ITS record servable, and this
 *     node — the residency owner — writes every render for the key, so its version is never
 *     older than the caller's. Metadata and bytes are returned as one consistent version and
 *     the caller serves exactly that.
 *
 * Gated on the shared cluster token (`peerRescue.token`, compared timing-safely), because a bot
 * request carries no user credentials a peer could forward. The endpoint discloses nothing the
 * public bot path doesn't already serve, so the token is surface hygiene rather than
 * load-bearing security — but it fails CLOSED: unconfigured means 404, not open.
 *
 * The read itself goes through the same bounded `materializeCachedBody` as the serve path: an
 * owner that is ALSO mid-copy answers 504 inside its own budget instead of hanging the caller
 * into its `peerRescue.timeoutMs` deadline.
 */

import { config } from '../config.js';
import { PrerenderedPage } from '../resources/PrerenderedPage.js';
import { materializeCachedBody } from '../util/cachedBody.js';
import { isPeerRescueActive, peerTokenMatches } from '../util/peerRescue.js';

export const PEER_PAGE_PATH = '/prerender_peer/page';

const EMPTY_HEADERS = Object.freeze({});

export async function handlePeerPageRequest(request) {
	// Order matters: existence is not revealed until the caller is authenticated. An unconfigured
	// node answers 404 (the feature does not exist here); a wrong token answers 403.
	if (!isPeerRescueActive()) return { status: 404, headers: EMPTY_HEADERS };
	if (!peerTokenMatches(request.headers.get(config.peerRescue.header))) {
		return { status: 403, headers: EMPTY_HEADERS };
	}
	if (request.method !== 'GET') return { status: 405, headers: EMPTY_HEADERS };

	const queryAt = request.url.indexOf('?');
	const cacheKey = queryAt === -1 ? null : new URLSearchParams(request.url.slice(queryAt + 1)).get('key');
	if (!cacheKey) return { status: 400, headers: EMPTY_HEADERS };

	const page = await PrerenderedPage.get(cacheKey);
	if (!page) return { status: 404, headers: EMPTY_HEADERS };

	const read = await materializeCachedBody(page, 'GET');
	// Distinct codes purely for the peer's logs/curl — the caller folds every non-200 into
	// "rescue missed": 504 = this node's read tripped its own budget (both nodes mid-copy),
	// 410 = this node's blob is unreadable too (the dangling reference replicated everywhere).
	if (!read.ok) return { status: read.reason === 'timeout' ? 504 : 410, headers: EMPTY_HEADERS };

	return {
		status: 200,
		headers: {
			// One consistent version: these fields describe exactly the bytes in the body. `headers`
			// is the record's stored JSON string (it carries the content-encoding the bytes are in);
			// dates go as epoch ms so the wire shape is unambiguous. Stored response heads are the
			// render path's small allowlist, so this header stays well under any header-size cap.
			'x-prerender-page': JSON.stringify({
				statusCode: page.statusCode,
				headers: page.headers,
				lastCached: page.lastCached ? new Date(page.lastCached).getTime() : undefined,
				expiresAt: page.expiresAt ? new Date(page.expiresAt).getTime() : undefined,
				isIndexable: page.isIndexable,
			}),
			// The body is the stored blob verbatim — already content-encoded per the metadata above,
			// opaque on this hop (the client sends no accept-encoding, so nothing re-encodes it).
			'content-type': 'application/octet-stream',
		},
		body: read.body ?? Buffer.alloc(0),
	};
}
