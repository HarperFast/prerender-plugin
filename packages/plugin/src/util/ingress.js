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
import { normalizeUrl } from './url.js';

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
 * `{ url: URL, deviceType, route }` when the request is a prerender request, or
 * `null` when its (device-stripped) path matches no route, or when a matched route
 * has an unusable forwarded host. Never throws.
 */
export const resolveForwardedRequest = (request) => {
	const target = request.url;
	const queryIndex = target.indexOf('?');
	const rawPath = queryIndex === -1 ? target : target.slice(0, queryIndex);
	const search = queryIndex === -1 ? '' : target.slice(queryIndex);

	let deviceType;
	let path;
	if (config.ingress.deviceTypeSource === 'path') {
		({ deviceType, path } = extractDeviceFromPath(rawPath));
	} else {
		deviceType = sanitizeDeviceType(request.headers.get(config.ingress.deviceTypeHeader));
		path = rawPath;
	}

	const route = matchRoute(path);
	if (!route) return null;

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
		const url = normalizeUrl(`${proto}://${host}${path}${search}`, true, route.queryParams);
		return { url, deviceType, route };
	} catch (e) {
		getLogger().warn?.(`[prerender] could not reconstruct forwarded URL for ${path}: ${e.message}`);
		return null;
	}
};
