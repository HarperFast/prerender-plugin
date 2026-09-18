/**
 * THE RAW-DOCUMENT CACHE: keeping the origin document a miss already fetched, for URLs that are
 * not in the render rotation.
 *
 * ── WHAT THIS IS FOR ─────────────────────────────────────────────────────────────────────────
 *
 * On a large catalog the crawlable URL space is far bigger than the corpus worth rendering. Facet
 * and parameter combinations a bot invents by following links own no Target, are never scheduled,
 * and therefore MISS ON EVERY REQUEST — measured at 89.8% of requests to one deployment's listing
 * route. Every one of those is an origin fetch for a document the origin had already served,
 * minutes earlier, to a different crawler.
 *
 * So the fetch is not the thing to optimise away; the REPEAT of it is. This module keeps the bytes
 * that fetch produced, and the next crawler asking for the same URL is answered from storage.
 * Marginal cost: one write. No render capacity, no second origin request, no scheduling.
 *
 * ── WHAT IT MUST NEVER DO ────────────────────────────────────────────────────────────────────
 *
 * It only ever replaces an ORIGIN PROXY. A raw page is read when `PrerenderedPage` held nothing at
 * all — a true miss — and never when it held a stale or invalidated row, because those mean a
 * render exists for this URL and is coming, and the LIVE origin is a better answer than a stored
 * copy of it. Getting that backwards would trade a live document for one up to a day old on
 * precisely the URLs that have a render scheduled.
 *
 * A raw document is also NOT a prerendered snapshot, and nothing downstream may blur them: raw
 * serves carry their own cache status so `bot_serve` and `page_age` keep meaning what they meant,
 * and a raw row carries no indexability verdict because nothing rendered it.
 *
 * ── THE ENCODING RULE ────────────────────────────────────────────────────────────────────────
 *
 * The bytes are stored EXACTLY as the origin sent them, with the origin's own `content-encoding`
 * (gzip — see `resolveUpstreamHeaders`). `http_handlers/response.js` re-encodes from the stored
 * header at serve time, so decoding on the way in would cost a decompress on the miss branch and
 * buy nothing. The one header that must NOT survive is `content-length`: a re-encoded body has a
 * different length, and a stored one would contradict the bytes actually written.
 */

import { config } from '../config.js';
import { metrics } from '../metrics.js';
import { getNextTimeOfDay } from './time.js';

const table = () => databases.raw_cache.RawPage;

/**
 * The route's raw-cache policy for this request, or null when nothing should happen.
 *
 * BOTH SWITCHES, deliberately: the feature's master switch and the route's own opt-in. A route
 * carrying `rawCache: true` through a deployment where `render.raw.enabled` is false must mean
 * exactly nothing, so that turning the feature off is one edit and not a sweep of the route list.
 */
export const rawCachePolicy = (entry) => {
	const raw = config.render.raw;
	if (!raw?.enabled) return null;
	if (!entry?.rawCache) return null;
	return raw;
};

/**
 * When a document fetched now should stop being served.
 *
 * `midnight` is not a convenience spelling of "24h". It exists for origins whose content STEPS at
 * a fixed hour rather than drifting continuously: there, an interval is the wrong shape entirely —
 * a document fetched at 23:00 with a 6h TTL serves post-change content for five hours, while one
 * fetched at 01:00 expires long before anything about it has changed. Aligning to the boundary
 * makes a stored document correct for exactly as long as it is correct.
 *
 * `getNextTimeOfDay` rather than a second time implementation: it is already the DST-aware
 * next-occurrence-of-HH:MM in this codebase, and two of those would drift apart.
 */
export const rawExpiresAt = (policy, nowMs = Date.now()) => {
	if (policy.expiry === 'interval') {
		const ms = Number(policy.expiryMs);
		// Fall back to the boundary rather than to `NaN`, which would store an expiry every comparison
		// reads as "not servable" — a feature that silently stores everything and serves none of it.
		if (Number.isFinite(ms) && ms > 0) return nowMs + ms;
	}
	return getNextTimeOfDay('00:00', policy.expiryTimezone);
};

/** The leading media type of a `content-type` value, lowercased, parameters dropped. */
const mediaTypeOf = (contentType) =>
	String(contentType ?? '')
		.split(';')[0]
		.trim()
		.toLowerCase();

/**
 * May this origin response be stored? Returns the reason it may not, or null when it may.
 *
 * Ordered cheapest-first, and every branch names itself so `rawCache{outcome}` reports WHY a route
 * is not filling rather than merely that it isn't.
 */
export const storeRefusal = (resource, policy) => {
	if (resource.statusCode !== 200) return 'not-200';
	if (resource.viaStaging) return 'staging';
	// The origin tried to set a cookie, which is the best hint available that this document was
	// personalized. The sanitizer already dropped the header, so this is the only place that can
	// still see it — see `fetchOriginResource`. A personalized document stored here would be
	// replayed to every crawler that asks.
	if (resource.hadSetCookie) return 'has-cookie';
	const headers = resource.headers ?? {};
	if (!policy.contentTypes.includes(mediaTypeOf(headers['content-type']))) return 'content-type';
	// `private` and `no-store` are the origin saying this response is not a shared-cache artifact.
	// `no-cache` is deliberately NOT refused: it means revalidate-before-use, not do-not-store, and
	// refusing it would exclude most correctly-configured HTML.
	const cacheControl = String(headers['cache-control'] ?? '').toLowerCase();
	if (cacheControl.includes('private') || cacheControl.includes('no-store')) return 'no-store';
	return null;
};

/**
 * Split an origin body so it can be both served and captured.
 *
 * TWO THINGS ABOUT `tee()` THAT DECIDE WHETHER THIS IS SAFE.
 *
 * It buffers for the SLOWER branch. The capture branch below reads in a tight loop with nothing to
 * wait on, so it is always the faster one and can never hold the crawler's response back. The
 * converse is what actually costs memory: the capture runs ahead, so chunks the crawler has not
 * read yet are retained. That is bounded by `maxBytes` per in-flight capture, because past the cap
 * the capture is cancelled and the tee stops retaining anything for it.
 *
 * Cancelling ONE branch does not cancel the source — per spec a tee's source is cancelled only
 * when both branches are — so abandoning an oversize capture leaves the response untouched.
 *
 * NEVER REJECTS. A capture failure resolves to `{ bytes: null }`: this is an optimisation on the
 * miss path, and a crawler's response must not be able to fail because storing a copy of it did.
 */
export const teeForCapture = (stream, maxBytes) => {
	const [downstream, capture] = stream.tee();
	return { downstream, captured: collect(capture, maxBytes) };
};

/**
 * In-flight captures, and the cap that bounds what they can hold.
 *
 * THE MEASURED COST IS ~2x `maxBytes` PER CAPTURE, NOT `maxBytes` — one copy in `chunks`, and one
 * more retained by the tee for the branch the crawler has not read yet. Measured with a stalled
 * reader: a 768 KB document held 768 KB queued for the crawler plus 768 KB captured, 1.5 MB for one
 * request.
 *
 * WORSE THAN THE FACTOR OF TWO IS WHAT IT DOES TO BACKPRESSURE. Without a capture, a slow crawler
 * costs socket buffers: undici stops reading, the TCP window closes, and the ORIGIN holds the data.
 * The capture reads in a tight loop, so it drains the origin at full speed no matter how slowly the
 * crawler reads — and this worker's heap becomes the buffer instead. On a route that is ~90% misses,
 * a client that opens many connections and reads slowly would otherwise be pulling a heap lever it
 * controls.
 *
 * So the number of SIMULTANEOUS captures is capped, and past it a response is served without being
 * captured. Degrading to "this one is not stored" is free — the next crawler stores it — whereas
 * degrading to heap pressure takes the node down with the serve path on it.
 */
let inFlightCaptures = 0;
export const captureSlotsInUse = () => inFlightCaptures;

const collect = async (stream, maxBytes) => {
	const reader = stream.getReader();
	const chunks = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			// `?? 0` because a chunk without a numeric byteLength would make `size` NaN, and `NaN > maxBytes`
			// is FALSE — the cap would silently stop existing. Unreachable through `Readable.toWeb`, but
			// `teeForCapture` is exported and the failure is unbounded retention.
			size += value?.byteLength ?? 0;
			if (size > maxBytes) {
				// Drop what we have and stop reading. Holding the chunks to report an exact size would
				// keep the very bytes the cap exists to not keep.
				chunks.length = 0;
				// NOT AWAITED. A tee branch's `cancel()` returns the SHARED cancel promise, which settles
				// only when both branches cancel or the source closes — so when the crawler's branch is
				// never drained (client disconnect, HEAD, a 304 from `applyConditional`) awaiting it never
				// returns. That silently swallowed the `oversize` metric for exactly the aborted requests,
				// which is the one counter METRICS.md tells operators to watch, and pinned a frame and a
				// reader per such request. The cancel still takes effect; only the wait was wrong.
				reader.cancel().catch(() => {});
				return { bytes: null, outcome: 'oversize' };
			}
			chunks.push(value);
		}
		return { bytes: Buffer.concat(chunks, size), outcome: 'ok' };
	} catch {
		// A truncated or errored origin body. The crawler's own branch fails on its own terms; here
		// it just means there is nothing worth storing.
		return { bytes: null, outcome: 'capture-failed' };
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// Already released by `cancel()`. Nothing to do, and nothing worth logging.
		}
	}
};

/**
 * Headers to store beside the bytes: the origin's own filtered set, minus `content-length`.
 *
 * See the module header on encoding. `content-length` is dropped because the serve path may hand
 * the body back under a different `content-encoding` than it was stored in, and a stored length
 * would then contradict the bytes actually sent — the class of mismatch that makes a crawler read
 * a truncated document under a 200.
 */
export const storedHeaders = (originHeaders) => {
	const { 'content-length': _dropped, ...rest } = originHeaders ?? {};
	return { ...rest };
};

/**
 * Store a captured document. Best-effort by contract: every failure is counted and swallowed,
 * because this runs detached from a response that has already been served and there is nobody left
 * to tell.
 */
export const storeRawPage = async ({ cacheKey, resource, bytes, policy }) => {
	try {
		await table().put(cacheKey, {
			statusCode: resource.statusCode,
			lastCached: new Date(),
			content: createBlob(bytes),
			headers: JSON.stringify(storedHeaders(resource.headers)),
			expiresAt: new Date(rawExpiresAt(policy)),
		});
		metrics.rawCache('stored');
	} catch (e) {
		metrics.rawCache('write-failed');
		logger.warn?.(`[prerender] raw document not stored for ${cacheKey}: ${e?.message ?? String(e)}`);
	}
};

/**
 * Attach a capture to an origin resource, returning the resource with its body replaced by the
 * branch the crawler will read.
 *
 * The store is DETACHED and never awaited on the response path — same rule as `maybeSchedule`. A
 * `page_cache`-shaped write in front of a crawler's body is latency the crawler pays for a benefit
 * only the NEXT crawler gets.
 */
export const captureForRawCache = (resource, { cacheKey, policy }) => {
	const refusal = storeRefusal(resource, policy);
	if (refusal) {
		metrics.rawCache(refusal);
		return resource;
	}
	// A body that is not a stream (a test fixture, a future caller) has nothing to tee; leave it be
	// rather than guessing at its shape.
	if (typeof resource.content?.tee !== 'function') {
		metrics.rawCache('no-body');
		return resource;
	}

	if (inFlightCaptures >= policy.maxConcurrentCaptures) {
		metrics.rawCache('capture-busy');
		return resource;
	}

	inFlightCaptures++;
	const { downstream, captured } = teeForCapture(resource.content, policy.maxBytes);
	captured
		.then((result) => {
			// `.length`, NOT truthiness. `Buffer.concat([], 0)` is an EMPTY buffer and empty buffers are
			// truthy, so a 200 with `content-type: text/html` and no body — an origin error path, some CDN
			// failure modes — stored a zero-byte document under the cache key and replayed it, with the
			// stored `content-encoding: gzip`, to every crawler until it expired.
			if (!result.bytes?.length) {
				metrics.rawCache(result.bytes ? 'empty' : result.outcome);
				return;
			}
			return storeRawPage({ cacheKey, resource, bytes: result.bytes, policy });
		})
		// The store is detached, so nothing else would observe a throw from the metric emit or the
		// logger inside `storeRawPage`'s own catch. An unhandled rejection here would be a process-level
		// event caused by an optimisation nobody is waiting on.
		.catch(() => {})
		// ALWAYS, on every path. A slot that is not returned is a permanent reduction in how many
		// documents this worker will ever capture again, and it would decay silently to zero.
		.finally(() => {
			inFlightCaptures--;
		});

	return { ...resource, content: downstream };
};

/**
 * A stored document for this key, or null when there is none or it has expired.
 *
 * Shaped like the cached-page resource the serve path already knows how to deliver, so the raw
 * branch adds a source of bytes and not a second delivery path.
 */
export const readRawPage = async (cacheKey) => {
	let row;
	try {
		row = await table().get(cacheKey);
	} catch (e) {
		// A read failure is a miss, and a miss proxies. Never a 500 for a crawler over an optimisation.
		logger.warn?.(`[prerender] raw document unreadable for ${cacheKey}: ${e?.message ?? String(e)}`);
		return null;
	}
	if (!row) return null;
	// Same robust read as the page path: a `Date` column can arrive as a Date, a number or a string,
	// and anything unreadable must land on "expired" rather than on "serve it forever".
	const expiresAtMs = row.expiresAt ? new Date(row.expiresAt).getTime() : NaN;
	if (!(expiresAtMs > Date.now())) return null;
	return row;
};
