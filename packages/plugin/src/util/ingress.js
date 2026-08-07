/**
 * Forwarded (reverse-proxy / CDN) ingress for the bot request handler.
 *
 * In `forwarded` mode an upstream proxy (a reverse proxy or CDN) routes a restricted set of
 * paths to the plugin. Unlike the native `prefix` mode — where the request path
 * IS the absolute target URL — a forwarded request carries:
 *   - the device type as the first path segment (e.g. `/mobile/product/prd-1`),
 *   - the original public host/scheme in forwarded headers, and
 *   - a relative origin path.
 *
 * This module reconstructs the absolute target URL and resolves the device type. What to DO
 * with the resulting path — prerender it, proxy it quietly, or proxy it and report it — is
 * decided by util/routeClass.js, which owns that judgement for every ingress mode.
 */

import { config, getLogger } from '../config.js';
import { extractDeviceFromPath, sanitizeDeviceType } from './device_type.js';
import { canonicalizeUrl } from './url.js';
import { classifyPath, PRERENDER, UNCLASSIFIED } from './routeClass.js';
import { recordUnroutedPath } from './unrouted.js';

// A bare hostname with optional port. Guards against host-header injection (path,
// userinfo, scheme) being smuggled in via the forwarded-host header, which would
// otherwise repoint the origin fetch at an attacker-chosen host.
const HOST_PATTERN = /^[a-z0-9.-]+(:\d+)?$/i;

const firstHeaderValue = (raw) => (raw ? raw.split(',')[0].trim() : '');

/**
 * Resolve a forwarded request into its prerender target:
 * `{ url: URL, cacheUrl, deviceType, route, routeClass, pageType, pageTypeLabel }`, or `null`
 * when the request should be skipped entirely. Never throws.
 *
 * `routeClass` is the single source of truth for how the handler treats this request — there
 * is deliberately no separate `noCache` flag that could fall out of step with it. Only
 * `prerender` is cached and scheduled. `route` is the matched compiled entry, or null.
 * `pageType`/`pageTypeLabel` are that route's template name and its metrics label; both are
 * carried from the single `classifyPath` call below so nothing downstream re-derives them.
 *
 * Skipped (`null`) means: no device-type prefix in path mode, an unusable forwarded host, or
 * an unclassified path in HEADER mode. That last case is a mode asymmetry worth stating. In
 * path mode the device prefix already proves the CDN tagged this as bot traffic, so an
 * unclassified path is still a real bot request and gets proxied. In header mode a route
 * match is the only bot discriminator, so an unclassified path is indistinguishable from a
 * request to the plugin's own REST endpoints (`/render_queue`, `/queue_status`) and must fall
 * through to them — which makes a `passthrough` route the only way to proxy a non-prerendered
 * path in header mode.
 */
export const resolveForwardedRequest = (request) => {
	const target = request.url;
	const queryIndex = target.indexOf('?');
	const rawPath = queryIndex === -1 ? target : target.slice(0, queryIndex);
	const search = queryIndex === -1 ? '' : target.slice(queryIndex);

	let deviceType;
	let path;
	let fromPath = false;
	if (config.ingress.deviceTypeSource === 'path') {
		({ deviceType, path } = extractDeviceFromPath(rawPath));
		// No device prefix => upstream didn't tag this as bot/prerender traffic. Skip it.
		if (deviceType === null) return null;
		fromPath = true;
	} else {
		deviceType = sanitizeDeviceType(request.headers.get(config.ingress.deviceTypeHeader));
		path = rawPath;
	}

	const { routeClass, pageType, pageTypeLabel, queryParams, entry } = classifyPath(path);

	// See the header-mode asymmetry above.
	if (routeClass === UNCLASSIFIED && !fromPath) return null;

	const host = firstHeaderValue(request.headers.get(config.ingress.forwardedHostHeader));
	if (!host || !HOST_PATTERN.test(host)) {
		getLogger().warn?.(
			`[prerender] forwarded request to ${path} has missing/invalid ${config.ingress.forwardedHostHeader}`
		);
		return null;
	}

	const proto =
		firstHeaderValue(request.headers.get(config.ingress.forwardedProtoHeader)) || config.ingress.defaultProtocol;

	try {
		// `cacheUrl` is the canonical URL-half of the cache key; the URL object (for the origin
		// fetch / analytics) is built from it, so both share one encoding and the proxy fetches
		// the same bytes the key represents. For every non-prerender class the allowlist is
		// `['*']`, so a proxied request reaches the origin with the query the visitor sent.
		const cacheUrl = canonicalizeUrl(`${proto}://${host}${path}${search}`, queryParams);

		// Counted only once we know we are actually serving it — a request rejected for a bad
		// forwarded host above is not a routing gap. Aggregated rather than logged per request;
		// see util/unrouted.js for why.
		if (routeClass !== PRERENDER) recordUnroutedPath(routeClass, path, 'cdn');

		return { url: new URL(cacheUrl), cacheUrl, deviceType, route: entry, routeClass, pageType, pageTypeLabel };
	} catch (e) {
		// `e?.message ?? String(e)` rather than `e.message`: anything can be thrown, and a
		// non-Error rejection must not turn a skipped request into a TypeError in the logger.
		getLogger().warn?.(`[prerender] could not reconstruct forwarded URL for ${path}: ${e?.message ?? String(e)}`);
		return null;
	}
};
