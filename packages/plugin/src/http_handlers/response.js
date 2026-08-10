/**
 * HTTP-response building for the bot request handler.
 *
 * Turns a resolved `resource` (a cached page or an origin/rendered result) into the
 * `{ headers, status, body, wasCacheMiss }` shape the handler returns. This module is
 * side-effect-free with respect to the cache — scheduling/eviction decisions live in the
 * handler; the only cache touch here is evicting a page whose Blob body fails to stream.
 */

import { Readable } from 'node:stream';
import { config, getLogger } from '../config.js';
import { CacheKey } from '../util/cacheKey.js';
import { headersToObject } from '../util/headers.js';
import { getAcceptedEncodings, getBestEncoding, reencode } from '../util/contentEncoding.js';
import { PrerenderedPage } from '../resources/PrerenderedPage.js';

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

/**
 * Build the base response headers from the upstream/cached resource: copy every upstream
 * header except `link`, and set `age` for a cached 200.
 */
export function buildResponseHeaders(resource) {
	const headers = new Headers();
	const upstreamHeaders = headersToObject(resource.headers);

	for (const [key, value] of Object.entries(upstreamHeaders)) {
		try {
			if (key !== 'link') {
				headers.append(key, value);
			}
		} catch (e) {
			getLogger().error(e);
		}
	}

	if (resource.statusCode === 200 && resource.lastCached) {
		// lastCached is a schema `Date`; read it robustly (Date | number | string) so a bad
		// value yields no age header rather than "NaN".
		const lastCachedMs = new Date(resource.lastCached).getTime();
		if (!isNaN(lastCachedMs)) {
			const ageSec = Math.max(0, Math.floor((Date.now() - lastCachedMs) / 1000));
			headers.set('age', String(ageSec));
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

	return reencode(Readable.fromWeb(body), contentEncoding, bestEncoding, false);
}

/**
 * Assemble the final HTTP response for a resolved resource: stream a cached Blob body,
 * copy/annotate headers, apply debug + conditional + render-now-status headers, and
 * negotiate content-encoding. Returns `{ headers, status, body, wasCacheMiss }`.
 */
export function deliverResource(resource, request, info = {}) {
	let status = resource.statusCode;
	let body = request.method === 'HEAD' ? undefined : resource.content;
	const wasCacheMiss = computeWasCacheMiss(resource);

	// A cached (non-miss) Blob body streams; a delivery error evicts the entry. Harper's
	// cached-content Blob is EventEmitter-like (.on); guard in case a standard web Blob
	// (which has .stream() but no .on) ever flows through.
	if (!resource.miss && body instanceof Blob) {
		if (typeof body.on === 'function') {
			body.on('error', (e) => {
				getLogger().error('blob delivery error', e);
				PrerenderedPage.delete(resource.cacheKey);
			});
		}
		body = body.stream();
	}

	let headers = buildResponseHeaders(resource);

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
	// half. `invalidated` is the only verdict that skips it, so ordinary 304 handling is untouched.
	const suppressConditional = info.cacheStatus === 'invalidated';

	if (!suppressConditional) {
		({ status, headers, body } = applyConditional(status, headers, request, body));
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
