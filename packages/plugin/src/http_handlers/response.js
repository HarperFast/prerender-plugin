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

// Compact one-line description of a matched forwarded-mode route for the x-harper-route
// debug header.
function formatRoute(route) {
	const params = Array.isArray(route.queryParams) ? route.queryParams.join(', ') : '';
	return `${route.match ?? ''} ${route.path ?? ''} [${params}]`;
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
		const ageSec = Math.max(0, Math.floor((Date.now() - resource.lastCached.valueOf()) / 1000));
		headers.set('age', String(ageSec));
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
		headers.set('x-harper-cache-timestamp', new Date(resource.lastCached).toISOString());
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
	if (info.route) {
		headers.set('x-harper-route', formatRoute(info.route));
	}
	if (resource.isIndexable === true || resource.isIndexable === false) {
		headers.set('x-harper-indexable', String(resource.isIndexable));
	}
}

/**
 * Apply conditional-request handling to a 200: if the request's `if-none-match` /
 * `if-modified-since` matches, downgrade to a 304 carrying only `allowed304Headers` and no
 * body. Non-200 responses pass through untouched. Returns `{ status, headers, body }`.
 */
export function applyConditional(status, headers, request, body) {
	if (status !== 200) return { status, headers, body };

	let return304 = false;

	const etag = request.headers.get('if-none-match');
	if (etag && etag === headers.get('etag')) {
		return304 = true;
	}

	if (!return304) {
		const ifModifiedSince = request.headers.get('if-modified-since');
		const lastModified = headers.get('last-modified');
		if (ifModifiedSince && lastModified) {
			const ifModifiedSinceTime = new Date(ifModifiedSince).getTime();
			const lastModifiedTime = new Date(lastModified).getTime();
			if (!isNaN(ifModifiedSinceTime) && !isNaN(lastModifiedTime) && lastModifiedTime <= ifModifiedSinceTime) {
				return304 = true;
			}
		}
	}

	if (!return304) return { status, headers, body };

	const headers304 = new Headers();
	for (const headerName of allowed304Headers) {
		const headerValue = headers.get(headerName);
		if (headerValue !== null) {
			headers304.set(headerName, headerValue);
		}
	}
	return { status: 304, headers: headers304, body: undefined };
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

	// A cached (non-miss) Blob body streams; a delivery error evicts the entry.
	if (!resource.miss && body instanceof Blob) {
		body.on('error', (e) => {
			getLogger().error('blob delivery error', e);
			PrerenderedPage.delete(resource.cacheKey);
		});
		body = body.stream();
	}

	let headers = buildResponseHeaders(resource);

	if (request.headers.get(config.debugHeader.key)) {
		applyDebugHeaders(headers, request, resource, info);
	}

	({ status, headers, body } = applyConditional(status, headers, request, body));

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
