/**
 * HTTP-response building for the bot request handler.
 *
 * Turns a resolved `resource` (a cached page or an origin/rendered result) into the
 * `{ headers, status, body, wasCacheMiss }` shape the handler returns. This module is now
 * entirely side-effect-free with respect to the cache: scheduling and eviction decisions live
 * in the handler, and a cache-served body is read to completion BEFORE it gets here, so an
 * unreadable blob never reaches the point of committing a status.
 */

import { Readable } from 'node:stream';
import { config, getLogger } from '../config.js';
import { CacheKey } from '../util/cacheKey.js';
import { headersToObject } from '../util/headers.js';
import { getAcceptedEncodings, getBestEncoding, reencode } from '../util/contentEncoding.js';
import { metrics } from '../metrics.js';
import { releaseOriginBody } from '../util/upstream.js';

// Headers preserved on a 304 response; everything else is dropped.
const allowed304Headers = ['cache-control', 'expires', 'date', 'etag', 'last-modified', 'vary', 'age'];

// A cache miss is a response we didn't serve from cache. undefined for non-2xx/304 misses
// so the caller can distinguish "miss we'd cache" from "miss we wouldn't".
const computeWasCacheMiss = (resource) => {
	if (!resource.miss) return false;
	return resource.statusCode === 200 || resource.statusCode === 304 ? true : undefined;
};

// Compact one-line description of the matched route for the x-harper-route debug header.
// `source` is included so a folded excludePathPatterns entry is distinguishable from a
// hand-written passthrough route — they behave the same but live in different config keys.
function formatRoute(route) {
	const params = Array.isArray(route.queryParams) ? route.queryParams.join(', ') : '';
	return `${route.match ?? ''} ${route.path ?? ''} [${params}] ${route.mode ?? ''} (${route.source ?? ''})`;
}

// The origin's validators, which a rendered snapshot must not carry. See `buildResponseHeaders`.
const ORIGIN_VALIDATORS = new Set(['etag', 'last-modified']);

/**
 * Append one stored or relayed header, as separate values where the source had several.
 *
 * THE RENDERER'S HEADERS COME FROM PUPPETEER, WHICH JOINS A REPEATED RESPONSE HEADER WITH `\n` — and
 * `Headers.append` throws on a newline. So a page whose origin sent two `x-robots-tag`, `vary`,
 * `cache-control` or `link` headers lost that header on every cache serve and logged an error each
 * time: one log line per served request, for as long as the page stayed cached. Split, each value is
 * appended in turn (the response then carries them as HTTP itself does). An array — undici's shape
 * for a repeated origin header — is the same case. A value that is invalid for any other reason is
 * dropped and COUNTED (`serve_error` `bad-header`); the log line is rate-limited per worker, because
 * the same stored row is served again on every request.
 */
const appendHeader = (headers, key, value) => {
	if (Array.isArray(value)) {
		for (const item of value) appendHeader(headers, key, item);
		return;
	}
	const text = typeof value === 'string' ? value : String(value);
	if (text.includes('\n')) {
		for (const line of text.split(/\r?\n/)) if (line) appendOne(headers, key, line);
		return;
	}
	appendOne(headers, key, text);
};

const BAD_HEADER_LOG_INTERVAL_MS = 60_000;
let lastBadHeaderLog = 0;
const appendOne = (headers, key, value) => {
	try {
		headers.append(key, value);
	} catch (e) {
		metrics.serveError('bad-header');
		const now = Date.now();
		if (now - lastBadHeaderLog >= BAD_HEADER_LOG_INTERVAL_MS) {
			lastBadHeaderLog = now;
			getLogger().warn?.(
				`[prerender] dropped response header "${key}": ${e?.message ?? e} (counted as serve_error bad-header; ` +
					`logged at most once a minute per worker)`
			);
		}
	}
};

/**
 * Build the base response headers from the upstream/cached resource: copy every upstream
 * header (`link` only under `page.serveLinkHeader`), and set `age` for a cached 200.
 *
 * `snapshot` — the body is a RENDERED page (a cache serve, a peer rescue, a render-now result),
 * not the origin's own bytes. Its stored `etag`/`last-modified` are the ORIGIN DOCUMENT's, which
 * the renderer kept from the response it rendered, and they describe that raw document, not the
 * snapshot: a re-render that changed client-rendered content (prices, reviews, stock) under an
 * unchanged origin ETag answered the crawler's next conditional request 304, and the crawler kept
 * the old snapshot while every signal said a fresh page was being served. So a snapshot carries
 * validators derived from ITSELF: `Last-Modified` is the render's `lastCached`, and the ETag is a
 * weak tag of that same instant and the device, `W/"<lastCachedMs>-<deviceType>"` — both move on
 * every render. (No content hash
 * is stored, and hashing ~220 KB per request is not cheap; a render stamp is exact for "is this the
 * render you hold".) A raw-cache document is the origin's bytes verbatim, so it keeps the origin's
 * validators.
 */
export function buildResponseHeaders(resource, snapshot = false, deviceType = resource.deviceType) {
	const headers = new Headers();
	const upstreamHeaders = headersToObject(resource.headers);
	const serveLink = config.page.serveLinkHeader;

	for (const [key, value] of Object.entries(upstreamHeaders)) {
		if (key === 'link' && !serveLink) continue;
		if (snapshot && ORIGIN_VALIDATORS.has(key)) continue;
		appendHeader(headers, key, value);
	}

	// lastCached is a schema `Date`; read it robustly (Date | number | string) so a bad value yields
	// no header rather than "NaN" or an "Invalid Date" validator.
	const lastCachedMs = resource.lastCached ? new Date(resource.lastCached).getTime() : NaN;
	if (!isNaN(lastCachedMs)) {
		if (resource.statusCode === 200) {
			const ageSec = Math.max(0, Math.floor((Date.now() - lastCachedMs) / 1000));
			headers.set('age', String(ageSec));
		}
		if (snapshot) {
			headers.set('last-modified', new Date(lastCachedMs).toUTCString());
			// A version tag, weak because it names the render rather than hashing its bytes: it changes on
			// every render and on nothing else. `If-None-Match` takes precedence over `If-Modified-Since`,
			// so a crawler holding it revalidates against the exact render, not a one-second HTTP date that
			// two renders can share and that another node's clock stamped. THE DEVICE IS PART OF IT: one
			// render job stamps the same `lastCached` on every device variant it writes, so without it the
			// desktop and mobile snapshots of a URL — different bytes — would carry the same tag.
			// A stored page row carries its cache key but no device column, so that is the fallback.
			const device = deviceType ?? (resource.cacheKey ? CacheKey.parse(resource.cacheKey).deviceType : undefined) ?? '';
			headers.set('etag', `W/"${lastCachedMs}-${device}"`);
		}
	}

	return headers;
}

/**
 * Set the `x-harper-*` observability headers. Caller gates this on the debug header being
 * present. Mutates `headers`.
 */
export function applyDebugHeaders(headers, request, resource, info) {
	headers.set('x-harper-device-type', resource.deviceType || CacheKey.parse(resource.cacheKey).deviceType);
	if (resource.lastCached) {
		// Guard toISOString against an invalid date, which would otherwise throw.
		const date = new Date(resource.lastCached);
		if (!isNaN(date.getTime())) {
			headers.set('x-harper-cache-timestamp', date.toISOString());
		}
	}
	if (resource.viaStaging) {
		headers.set('x-harper-origin', 'staging');
	}
	if (info.cacheStatus) {
		headers.set('x-harper-cache', info.cacheStatus);
	}
	if (info.source) {
		headers.set('x-harper-source', info.source);
	}
	if (info.cacheKey) {
		headers.set('x-harper-cache-key', info.cacheKey);
	}
	if (info.url) {
		headers.set('x-harper-url', info.url);
	}
	// The class is the answer to "why wasn't this served from cache" — emitted even with no
	// matched route, which is exactly the unclassified case worth seeing.
	if (info.routeClass) {
		headers.set('x-harper-route-class', info.routeClass);
	}
	if (info.route) {
		headers.set('x-harper-route', formatRoute(info.route));
	}
	if (resource.isIndexable === true || resource.isIndexable === false) {
		headers.set('x-harper-indexable', String(resource.isIndexable));
	}
}

// Strip a weak-validator prefix so `W/"x"` and `"x"` compare equal (RFC 7232 §2.3.2 —
// weak comparison is what a conditional GET/HEAD needs).
const normalizeEtag = (tag) => tag.trim().replace(/^W\//i, '');

// Does the `If-None-Match` header (a `*`, or a comma-separated tag list) match `etag`?
const ifNoneMatchMatches = (ifNoneMatch, etag) => {
	if (ifNoneMatch === '*') return true;
	if (!etag) return false;
	const target = normalizeEtag(etag);
	return ifNoneMatch.split(',').some((tag) => normalizeEtag(tag) === target);
};

// Build the 304 response: only the headers allowed on a Not-Modified reply, no body.
const downgradeTo304 = (headers) => {
	const headers304 = new Headers();
	for (const headerName of allowed304Headers) {
		const headerValue = headers.get(headerName);
		if (headerValue !== null) {
			headers304.set(headerName, headerValue);
		}
	}
	return { status: 304, headers: headers304, body: undefined };
};

/**
 * Apply conditional-request handling to a 200: if the request's validators match,
 * downgrade to a 304 carrying only `allowed304Headers` and no body. Non-200 responses pass
 * through untouched. Returns `{ status, headers, body }`.
 *
 * Follows RFC 7232: `If-None-Match` (weak comparison, comma lists, `*`) takes precedence
 * and, when present, `If-Modified-Since` is ignored entirely.
 */
export function applyConditional(status, headers, request, body) {
	if (status !== 200) return { status, headers, body };

	const ifNoneMatch = request.headers.get('if-none-match');
	if (ifNoneMatch) {
		return ifNoneMatchMatches(ifNoneMatch, headers.get('etag')) ? downgradeTo304(headers) : { status, headers, body };
	}

	const ifModifiedSince = request.headers.get('if-modified-since');
	const lastModified = headers.get('last-modified');
	if (ifModifiedSince && lastModified) {
		const ifModifiedSinceTime = new Date(ifModifiedSince).getTime();
		const lastModifiedTime = new Date(lastModified).getTime();
		if (!isNaN(ifModifiedSinceTime) && !isNaN(lastModifiedTime) && lastModifiedTime <= ifModifiedSinceTime) {
			return downgradeTo304(headers);
		}
	}

	return { status, headers, body };
}

/**
 * Re-encode the body to the client's best accepted encoding when it differs from what the
 * upstream sent. Mutates `content-encoding`/`content-length` on `headers` and returns the
 * (possibly re-encoded) body.
 */
export function negotiateEncoding(body, headers, request) {
	const contentEncoding = headers.get('content-encoding') || null;
	const bestEncoding = getBestEncoding(getAcceptedEncodings(request.headers.get('accept-encoding')), contentEncoding);

	if (bestEncoding === contentEncoding) return body;

	if (bestEncoding) {
		headers.set('content-encoding', bestEncoding);
	} else {
		headers.delete('content-encoding');
	}
	headers.delete('content-length');

	// Normalize the body to a Node stream before re-encoding. Three shapes reach here and each
	// needs different handling — getting this wrong corrupts the response SILENTLY:
	//   - web ReadableStream (the origin path, `originBodyStream(response.body)`) → convert
	//   - Node Readable → pass through; `Readable.from([stream])` would emit the stream OBJECT as
	//     a single chunk. Not currently reachable (upstream.js hands over a web stream), but
	//     upstream.js holds a Node Readable and only converts it for this call, so anyone dropping
	//     that round-trip would land here.
	//   - Buffer (the cache path, materialized before the response commits — see resolveResource)
	//     → wrap in an array; `Readable.from(buffer)` iterates a Buffer as individual BYTES.
	// Only reached when the client's accepted encodings exclude what we stored, which for a
	// gzip-accepting crawler never happens.
	const source =
		typeof body?.getReader === 'function'
			? Readable.fromWeb(body)
			: body instanceof Readable
				? body
				: Readable.from([body]);

	return reencode(source, contentEncoding, bestEncoding, false);
}

/**
 * Assemble the final HTTP response for a resolved resource: stream a cached Blob body,
 * copy/annotate headers, apply debug + conditional + render-now-status headers, and
 * negotiate content-encoding. Returns `{ headers, status, body, wasCacheMiss }`.
 */
export function deliverResource(resource, request, info = {}) {
	let status = resource.statusCode;
	// `info.cachedBody` is a cache-served body already read to completion, so an unreadable blob
	// was turned into an origin serve BEFORE this function committed a status (see
	// `resolveResource`). The fallback to `resource.content` covers the origin path and the
	// render-now timeout fallback, which can hand back a cached page nobody materialized.
	const isHead = request.method === 'HEAD';
	let body = isHead ? undefined : (info.cachedBody ?? resource.content);
	// A HEAD is forwarded upstream as a HEAD, so this body is normally already empty — but it is
	// still a live stream on an open socket until someone ends it.
	if (isHead) releaseOriginBody(resource);
	const wasCacheMiss = computeWasCacheMiss(resource);

	// RESIDUAL PATH ONLY: a cached Blob that arrived unmaterialized. It still streams, and a
	// mid-stream failure is still counted — but the entry is deliberately NOT deleted any more.
	// `PrerenderedPage` replicates (no `replicate: false`, and all nodes hold full copies), so the
	// delete evicted the page on EVERY node — including peers whose blob was perfectly readable,
	// which is the common shape when replication is what dropped the bytes on one node. Nothing
	// rescheduled a render either (`maybeSchedule` only fires on a miss, and creates a Target at
	// most), so the key then served origin cluster-wide until its next scheduled render — up to the
	// route interval, 48h for a PDP. One truncated response is far cheaper than that, and the
	// scheduled re-render restores the blob regardless.
	if (!resource.miss && body instanceof Blob) {
		if (typeof body.on === 'function') {
			body.on('error', (e) => {
				// The 200 and the bot_serve cache-hit row were committed before the body streamed, so
				// without this counter a truncated serve is recorded as a SUCCESS everywhere.
				metrics.serveError('blob-stream');
				getLogger().error('blob delivery error', e);
			});
		}
		body = body.stream();
	}

	// 'cache' and 'rendered' are the sources whose body is a rendered snapshot; 'raw' and 'negative'
	// are the origin's own stored bytes, and 'origin' its live ones.
	const snapshot = info.source === 'cache' || info.source === 'rendered';
	let headers = buildResponseHeaders(resource, snapshot, resource.deviceType ?? info.deviceType);

	// A CONDITIONAL REQUEST MUST NOT BE ABLE TO UNDO AN INVALIDATION, and it could, by two
	// independent routes. The crawler's validators are ones this plugin handed it off the
	// PRE-INVALIDATION snapshot, and (a) they are forwarded to the origin, whose ETag may be a
	// publish-date rather than a content hash, so it answers 304; (b) `applyConditional` compares them
	// against the RESPONSE headers, which on an origin proxy are the origin's, and can produce the 304
	// locally. Either way `computeWasCacheMiss` reports true, so the request records
	// `bot_serve(source: 'origin', cacheStatus: 'invalidated')` — every signal says the invalidation
	// worked while the crawler keeps the pre-change bytes.
	//
	// This is NOT the documented "the edge keeps its own TTL" caveat. A TTL expires; a 304 loop does
	// not. The origin-side half is closed in util/upstream.js (`stripValidators`); this is the local
	// half. It covers every proxy that found a page row it would not serve (`info.stripConditionals`,
	// set in resolveResource: stale, blob faults, a render-now fallback over a page) — not only an
	// invalidation — because the crawler's `If-Modified-Since` is then this plugin's render time, and
	// the origin's `Last-Modified` is usually older than it whether or not the content changed.
	const suppressConditional = info.cacheStatus === 'invalidated' || info.stripConditionals === true;

	if (!suppressConditional) {
		const unconditional = body;
		({ status, headers, body } = applyConditional(status, headers, request, body));
		// A 304 made HERE out of an origin 200 abandons the origin's body — the same pinned socket as a
		// HEAD, on every conditional request the origin itself did not answer 304.
		if (body === undefined && unconditional !== undefined) releaseOriginBody(resource);
	}

	// AFTER `applyConditional`, not before — the same treatment `x-harper-render-now` already gets
	// below, and for the same reason. `downgradeTo304` REPLACES the header set, so debug headers
	// applied earlier were dropped by any 304: "one curl from a render pod is a complete diagnosis"
	// was false the moment that curl carried a validator, on every path, not just this feature's.
	if (request.headers.get(config.debugHeader.key)) {
		applyDebugHeaders(headers, request, resource, info);
	}

	// Always surface the on-demand render outcome so the caller knows whether it got a
	// fresh render ('hit') or the fallback ('timeout'). Set after 304 handling so it
	// survives the header reset on a conditional response.
	if (info.renderNowStatus) {
		headers.set('x-harper-render-now', info.renderNowStatus);
	}

	if (body) {
		body = negotiateEncoding(body, headers, request);
	}

	return { headers, status, body, wasCacheMiss };
}
