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
import { isDueNowForwardActive, isPeerHealActive, PEER_DUE_NOW_PATH } from '../util/peerHeal.js';
import { peerTokenMatches } from '../util/peerRescue.js';
import { accelerateHeal } from '../util/invalidationReenqueue.js';
import { resolveInvalidation } from '../util/invalidation.js';
import { routeScopeForUrl } from '../util/routeClass.js';
import { CacheKey } from '../util/cacheKey.js';
import { getResidencyByUrl } from '../util/residency.js';
import { fileDueNow } from '../util/renderSchedule.js';
import { QueueState } from '../resources/QueueState.js';

export const PEER_HEAL_PATH = '/prerender_peer/heal';
export { PEER_DUE_NOW_PATH };

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

/**
 * One already-materialised body value as a Buffer, or null when it is not one.
 *
 * `Buffer.isBuffer` IS NOT ENOUGH, and the difference is a real hazard rather than pedantry: a
 * `Buffer` is a `Uint8Array` subclass, but a plain `Uint8Array` is not a Buffer, so a bare
 * `Buffer.isBuffer` check lets one fall through to the streaming branch below — where, because a
 * `Uint8Array` is a SYNCHRONOUS iterable, `for await` walks it BYTE BY BYTE and hands `Buffer.from`
 * a number. `ArrayBuffer.isView` covers Buffer, Uint8Array and every other typed-array view in one
 * test, and the (buffer, byteOffset, byteLength) form is what makes it correct for a view onto a
 * larger allocation rather than copying the whole backing store.
 */
const asBuffer = (value) => {
	if (Buffer.isBuffer(value)) return value;
	if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
	if (value instanceof ArrayBuffer) return Buffer.from(value);
	if (typeof value === 'string') return Buffer.from(value, 'utf8');
	return null;
};

const readJsonBody = async (request) => {
	const source = request.body;
	// A body-less POST reads as absent rather than as an empty parse error, so the caller gets the
	// field-validation message below instead of a misleading "must be JSON".
	if (!source) return null;
	// Already materialised (string, Buffer, Uint8Array, ArrayBuffer) — parse it directly and never
	// iterate it. See `asBuffer`.
	const whole = asBuffer(source);
	if (whole) {
		if (whole.length > MAX_BODY_BYTES) throw new Error(TOO_LARGE);
		return whole.length ? JSON.parse(whole.toString('utf8')) : null;
	}

	const chunks = [];
	let total = 0;
	for await (const chunk of source) {
		// A chunk that is neither text nor bytes means this is not a body stream at all — refuse
		// explicitly rather than letting `Buffer.from` throw something opaque.
		const buf = asBuffer(chunk);
		if (!buf) throw new Error('body must be JSON');
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
		// 413 for the size refusal, 400 for an unparseable one. The caller folds every non-2xx into
		// `forward-failed`, but its reason string carries the status verbatim — so "peer responded 413"
		// names the cause in a log line where a second 400 would be indistinguishable from a malformed
		// body.
		if (e?.message === TOO_LARGE) return json({ error: TOO_LARGE }, 413);
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

/** A forwarded number: absent, or a positive finite value. `undefined` means absent, `NaN` unusable. */
const optionalPositive = (value) => {
	if (value === undefined || value === null) return undefined;
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : Number.NaN;
};

/**
 * `POST /prerender_peer/due-now { cacheKey, fromSitemap, effectiveInterval, changedAt?, demandPeriod? }`
 * asks THIS node — the row's residency owner — to file the row due now with its own `fileDueNow`,
 * because only here does the read that keeps an earlier due time and a change mark see the row (see
 * `queue.dueNowForward` and `fileDueNow` in util/renderSchedule.js).
 *
 * Deliberately dumb in the same directions as the heal endpoint above: it NEVER FORWARDS ONWARD — a node
 * that does not consider itself the owner answers `not-owner` and the caller files the row itself — and
 * it re-derives what it can rather than trusting it (the owner, the host allowlist).
 *
 * WHAT THIS ENDPOINT CAN DO, for anyone auditing the surface: file one schedule row due now, for a URL
 * this node owns whose host passes `domains` — exactly what a render-now does, and a render-now for a
 * URL nothing tracks also creates a row that renders once and is dropped. It never raises a due time,
 * never clears a mark, creates no Target, reads no page content, and returns only an outcome and a due
 * time. The worst a valid token buys is one render of an allowed URL.
 */
export async function handlePeerDueNowRequest(request) {
	if (!isDueNowForwardActive()) return { status: 404, headers: EMPTY_HEADERS };
	if (!peerTokenMatches(request.headers.get(config.peerRescue.header))) {
		return { status: 403, headers: EMPTY_HEADERS };
	}
	if (request.method !== 'POST') return { status: 405, headers: EMPTY_HEADERS };

	let body;
	try {
		body = await readJsonBody(request);
	} catch (e) {
		if (e?.message === TOO_LARGE) return json({ error: TOO_LARGE }, 413);
		return json({ error: 'body must be JSON' }, 400);
	}
	const cacheKey = typeof body?.cacheKey === 'string' && body.cacheKey.length <= 4096 ? body.cacheKey : null;
	const url = cacheKey ? CacheKey.urlOf(cacheKey) : null;
	const host = url ? URL.parse(url)?.hostname : null;
	const effectiveInterval = body?.effectiveInterval === null ? null : optionalPositive(body?.effectiveInterval);
	// ON THE OWNER'S CLOCK. A mark later than now — a caller whose clock runs ahead — would read as newer
	// than any lease this node grants for the next while, and every render granted before the caller's
	// "now" would be dropped as changed-during-render (resources/RenderQueue.js).
	const forwardedChangedAt = optionalPositive(body?.changedAt);
	const changedAt = Number.isFinite(forwardedChangedAt) ? Math.min(forwardedChangedAt, Date.now()) : forwardedChangedAt;
	const demandPeriod = optionalPositive(body?.demandPeriod);
	if (
		!host ||
		typeof body.fromSitemap !== 'boolean' ||
		(body.urgent !== undefined && typeof body.urgent !== 'boolean') ||
		effectiveInterval === undefined ||
		Number.isNaN(effectiveInterval) ||
		Number.isNaN(changedAt) ||
		Number.isNaN(demandPeriod)
	) {
		return json(
			{ error: 'cacheKey (a URL), fromSitemap (boolean) and effectiveInterval (ms or null) are required' },
			400
		);
	}
	if (config.domains.length && !config.domains.includes(host)) return json({ outcome: 'not-allowed' });
	// A LEAF, whatever residency says elsewhere: a node that does not think it owns the row refuses, and the
	// caller files it itself — never two nodes bouncing one filing between them.
	if (getResidencyByUrl(url) !== server.hostname) return json({ outcome: 'not-owner' });

	try {
		const nextRenderTime = await fileDueNow(cacheKey, {
			fromSitemap: body.fromSitemap,
			effectiveInterval,
			changedAt,
			demandPeriod,
			urgent: body.urgent !== false,
			forwarded: true,
		});
		// Wake this node's idle consumers, as a local render-now does: the claim reads a node-local flag,
		// which the forwarding node could not reach. Best-effort: the row IS filed, and answering anything
		// but `filed` would make the caller write it again locally — the whole-row replace this avoids.
		try {
			await QueueState.noteWork();
		} catch (e) {
			logger.warn(`[prerender] filed ${cacheKey} for a peer but could not wake consumers: ${e?.message ?? String(e)}`);
		}
		return json({ outcome: 'filed', nextRenderTime });
	} catch (e) {
		// ANSWER, never reject: the caller is holding a render-now or a revalidate, and a 500 lets it file the
		// row itself at once instead of waiting out its deadline.
		logger.error(e, `[prerender] forwarded due-now filing failed for ${cacheKey}`);
		return json({ error: 'filing failed' }, 500);
	}
}
