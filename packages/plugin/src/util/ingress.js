/**
 * Forwarded (reverse-proxy / CDN) ingress for the bot request handler.
 *
 * In `forwarded` mode an upstream proxy (e.g. Akamai) routes a restricted set of
 * paths to the plugin. Unlike the native `prefix` mode — where the request path
 * IS the absolute target URL — a forwarded request carries:
 *   - the device type as the first path segment (e.g. `/mobile/product/prd-1`),
 *   - the original public host/scheme in forwarded headers, and
 *   - a relative origin path.
 *
 * This module reconstructs the absolute target URL, resolves the device type, and
 * matches the request against the configured `routes` (which also decide whether a
 * request is a prerender request at all, and which query params survive into the
 * cache key / origin fetch).
 */

import { config, getLogger } from '../config.js';
import { extractDeviceFromPath, sanitizeDeviceType } from './device_type.js';
import { canonicalizeUrl } from './url.js';

const VALID_MATCH = new Set(['exact', 'prefix']);

// A bare hostname with optional port. Guards against host-header injection (path,
// userinfo, scheme) being smuggled in via the forwarded-host header, which would
// otherwise repoint the origin fetch at an attacker-chosen host.
const HOST_PATTERN = /^[a-z0-9.-]+(:\d+)?$/i;

export const isForwardedMode = () => config.ingress.mode === 'forwarded';

// Compile + memoize the route list. applyOptions swaps in a fresh routes array on
// every change, so an identity check is enough to detect a registry change.
let compiledRoutes = null;
let compiledFrom;

const compileRoutes = (routes) => {
	if (!Array.isArray(routes)) return [];

	const valid = routes
		.filter(
			(route) => route && VALID_MATCH.has(route.match) && typeof route.path === 'string' && route.path.startsWith('/')
		)
		.map((route) => ({
			match: route.match,
			path: route.path,
			queryParams: Array.isArray(route.queryParams) ? route.queryParams.slice() : [],
		}));

	if (valid.length !== routes.length) {
		getLogger().warn?.(`[prerender] Ignoring ${routes.length - valid.length} invalid ingress route(s)`);
	}

	return valid;
};

const getRoutes = () => {
	if (config.ingress.routes !== compiledFrom) {
		compiledRoutes = compileRoutes(config.ingress.routes);
		compiledFrom = config.ingress.routes;
	}
	return compiledRoutes;
};

/**
 * Match a device-stripped path against the configured routes. First match wins, so
 * routes should be ordered most-specific first. Returns the matched route (with its
 * query allowlist) or null.
 */
export const matchRoute = (path) => {
	for (const route of getRoutes()) {
		if (route.match === 'exact' ? path === route.path : path.startsWith(route.path)) {
			return route;
		}
	}
	return null;
};

const firstHeaderValue = (raw) => (raw ? raw.split(',')[0].trim() : '');

/**
 * Resolve a forwarded request into its prerender target. Returns
 * `{ url: URL, deviceType, route }` when the request is a prerender request (`route`
 * is `null` when no configured route matched — see below), or `null` when the request
 * should be skipped: it carries no device-type prefix (path mode), it matches no route
 * in header mode, or a matched route has an unusable forwarded host. Never throws.
 *
 * A device-prefixed path-mode request that matches no route is still a prerender
 * request (the CDN only prefixes bot traffic) — it resolves with `route: null`,
 * `noCache: true`, and all query params preserved, so the handler serves a cache hit
 * if one exists but otherwise just proxies to origin without caching. A warning is
 * logged so the missing route can be configured.
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

	const route = matchRoute(path);
	if (!route) {
		// In path mode the device prefix already identifies this as bot/prerender
		// traffic the CDN forwarded, so don't block a valid bot request just because
		// the CDN forwarded a path outside the configured routes. We don't recognize
		// the route, so we don't cache it: it resolves with `noCache` (see below) and
		// keeps all query params. Log it so the missing route can be configured.
		// In header mode the route match is the only bot discriminator (no device
		// prefix to distinguish prerender traffic from the plugin's own API endpoints),
		// so a non-match there must still fall through.
		if (!fromPath) return null;
		getLogger().warn?.(
			`[prerender] forwarded request to ${path} matched no configured route; proxying uncached (all query params preserved)`
		);
	}

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
		// A matched route applies its query allowlist; an unmatched path (path mode)
		// keeps every query param ('*') and is flagged noCache so the handler proxies
		// it without populating the cache for a route we don't recognize.
		// `cacheUrl` is the canonical URL-half of the cache key; the URL object (for the
		// origin fetch / analytics) is built from it, so both share one encoding and the
		// proxy fetches the same bytes the key represents.
		const cacheUrl = canonicalizeUrl(`${proto}://${host}${path}${search}`, route ? route.queryParams : ['*']);
		return { url: new URL(cacheUrl), cacheUrl, deviceType, route, noCache: !route };
	} catch (e) {
		getLogger().warn?.(`[prerender] could not reconstruct forwarded URL for ${path}: ${e.message}`);
		return null;
	}
};

/**
 * The query-param allowlist to canonicalize a URL with, matching what a bot READ of that URL
 * would use — so the sitemap-write, discovery, and redirect-rekey keys equal the read key.
 * Forwarded mode resolves the per-route allowlist by matching the URL's path; an unmatched
 * path keeps all params ('*'), exactly like `resolveForwardedRequest`. Native (prefix) mode
 * uses the global `config.url.queryParams`.
 *
 * CONTRACT: `rawUrl` is a DEVICE-FREE public URL — a sitemap `<loc>` or the browser's final
 * `page.url()`, both of which never carry the CDN's device path-prefix. `matchRoute` matches
 * the same device-stripped path the read path feeds it (ingress resolves the device prefix
 * off separately). Do NOT strip a device prefix here: these URLs have none, and doing so
 * would wrongly consume a real first path segment that happens to equal a device-type name.
 */
export const queryAllowlistFor = (rawUrl) => {
	if (!isForwardedMode()) return config.url.queryParams;
	let pathname;
	try {
		pathname = new URL(rawUrl).pathname;
	} catch {
		return ['*'];
	}
	const route = matchRoute(pathname);
	return route ? route.queryParams : ['*'];
};
