/**
 * The cross-node heal endpoint: `POST /prerender_peer/heal { url, cacheKey }` asks THIS node — the
 * key's residency owner — to run its own `accelerateHeal`, because the node that received the
 * crawler request cannot evaluate the owner-only guards (see util/peerHeal.js for which three and
 * why they matter).
 *
 * Deliberately dumb, in the same two directions as `/prerender_peer/page`:
 *
 *   - IT NEVER PROXIES ONWARD. If this node is not in fact the owner — residency disagreement
 *     during a topology change — `accelerateHeal` returns `not-owner` and that is the answer. No
 *     recursion is possible regardless of what any node believes about residency, which is the
 *     property that makes a peer endpoint safe to add at all.
 *   - IT RE-RESOLVES THE EPOCH ITSELF and accepts none from the caller. A forwarded epoch would be
 *     a value one node takes from another to decide what to stop serving; re-resolving costs two
 *     point reads this node would have made anyway. It also means a caller whose invalidation view
 *     is stale cannot cause work here for a scope that is no longer invalidated.
 *
 * Gated on the shared cluster token (`peerRescue.token`, compared timing-safely) because a bot
 * request carries no user credentials a peer could forward. Fails CLOSED: unconfigured is 404, not
 * open.
 *
 * WHAT THIS ENDPOINT CAN DO, stated plainly for anyone auditing the surface: lower a render due time
 * for a URL already in this node's rotation, at most `maxPerMinute` times a minute, and only while
 * an invalidation covering that URL is active here. It creates no Target, creates no schedule row
 * (`accelerateHeal`'s `no-target`/`no-schedule` guards), reads no page content, and returns only an
 * outcome string. The worst a valid token buys is a slightly earlier re-render.
 */

import { config } from '../config.js';
import { isPeerHealActive } from '../util/peerHeal.js';
import { peerTokenMatches } from '../util/peerRescue.js';
import { accelerateHeal } from '../util/invalidationReenqueue.js';
import { resolveInvalidation } from '../util/invalidation.js';
import { routeScopeForUrl } from '../util/routeClass.js';

export const PEER_HEAL_PATH = '/prerender_peer/heal';

const EMPTY_HEADERS = Object.freeze({});
const json = (body, status = 200) => ({
	status,
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body),
});

export async function handlePeerHealRequest(request) {
	// Order matters, exactly as in peer_page.js: existence is not revealed until the caller is
	// authenticated. Unconfigured answers 404 (the feature does not exist here); a wrong token 403.
	if (!isPeerHealActive()) return { status: 404, headers: EMPTY_HEADERS };
	if (!peerTokenMatches(request.headers.get(config.peerRescue.header))) {
		return { status: 403, headers: EMPTY_HEADERS };
	}
	if (request.method !== 'POST') return { status: 405, headers: EMPTY_HEADERS };

	let body;
	try {
		body = await request.json();
	} catch {
		return json({ error: 'body must be JSON' }, 400);
	}
	const url = typeof body?.url === 'string' ? body.url : null;
	const cacheKey = typeof body?.cacheKey === 'string' ? body.cacheKey : null;
	if (!url || !cacheKey) return json({ error: 'url and cacheKey are required' }, 400);

	try {
		// OUR view of the invalidation, never the caller's. `routeScopeForUrl` re-classifies here rather
		// than trusting a forwarded scope, for the same reason: a scope is what decides whether a page
		// stops being served, and it is cheap to derive.
		const invalidatedBy = await resolveInvalidation(routeScopeForUrl(url));
		if (!invalidatedBy) return json({ outcome: 'not-invalidated' });

		// `accelerateHeal` counts its own outcome, so a forwarded heal lands in exactly the same
		// `invalidation_reenqueue` series as a local one — the owner's metrics stay a complete account of
		// what it did, regardless of which node the crawler happened to hit.
		// `forwarded: true` is what enforces the leaf property described above — it stops this node
		// forwarding onward if it does not consider itself the owner.
		const result = await accelerateHeal({ url, cacheKey, invalidatedBy, forwarded: true });
		return json({ outcome: result?.outcome ?? 'unknown' });
	} catch (e) {
		// ANSWER, never reject. Both calls above already swallow their own faults, so reaching here means
		// something genuinely unexpected — but an HTTP handler that rejects leaves the caller a hanging
		// socket to burn its deadline on instead of a verdict, and that caller is a peer holding a
		// rate-limit slot. A 500 costs it one counted `forward-failed` and frees the slot immediately.
		logger.error(e, `[prerender] peer heal failed for ${cacheKey}`);
		return json({ error: 'heal failed' }, 500);
	}
}
