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

// Harper's raw `server.http` request exposes its body as `request.body`, a Readable — it has NO
// `.json()`. The first cut of this handler called `request.json()`, which threw on every request and
// was converted by the catch below into a 400, so 100% of forwarded heals failed while the endpoint
// looked healthy from outside (the route answered, auth gated correctly, only the body read was
// broken). `peer_page.js`, the endpoint this was modelled on, never reads a body, so there was no
// precedent in this plugin to copy — core reads it this way (`core/server/REST.ts`, and the comment
// on `graphqlQuerying.ts`'s deserialize: "Read the body through request.body ... it is a
// Readable-compatible").
//
// BOUNDED, because this is a network-facing read: the only legitimate body here is
// `{ url, cacheKey }`, a few hundred bytes. Anything past the cap is refused rather than buffered,
// so a bad or hostile caller with a valid token cannot make a worker hold an arbitrary payload.
const MAX_BODY_BYTES = 8192;
const TOO_LARGE = 'body too large';

const readJsonBody = async (request) => {
	const source = request.body;
	// A body-less POST reads as absent rather than as an empty parse error, so the caller gets the
	// field-validation message below instead of a misleading "must be JSON".
	if (!source) return null;
	if (typeof source === 'string') return JSON.parse(source);
	if (Buffer.isBuffer(source)) return JSON.parse(source.toString('utf8'));

	const chunks = [];
	let total = 0;
	for await (const chunk of source) {
		const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buf.length;
		if (total > MAX_BODY_BYTES) throw new Error(TOO_LARGE);
		chunks.push(buf);
	}
	if (!total) return null;
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

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
		body = await readJsonBody(request);
	} catch (e) {
		return json({ error: e?.message === TOO_LARGE ? TOO_LARGE : 'body must be JSON' }, 400);
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
