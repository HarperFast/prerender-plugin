/**
 * Cache-key explanation for the management API.
 *
 * Answers "what key does this URL resolve to, and why" — the question behind almost every
 * permanent-cache-miss investigation. A miss of that kind is a *key disagreement*: the
 * serving read computes one key while the sitemap write / discovery / redirect re-key
 * computed another, so the rendered page is stored where nothing ever looks for it.
 *
 * All of those paths now share `canonicalizeUrl(url, queryAllowlistFor(url))`, so the
 * remaining way to get a disagreement is the *allowlist*: in forwarded mode it comes from
 * the matched route, and a URL that matches no route keeps all params. This therefore
 * reports the resolved key alongside the key under the global `url.queryParams`, and flags
 * when they differ — that difference is the fingerprint of a missing/misordered route.
 *
 * Pure with respect to the database: it only reads `config`. The resource layer adds the
 * live row lookups.
 */

import { config } from '../config.js';
import { CacheKey } from './cacheKey.js';
import { canonicalizeUrl } from './url.js';
import { classifyPath, isForwardedMode, PRERENDER } from './routeClass.js';
import { sanitizeDeviceType } from './device_type.js';

// `source` is included deliberately: an entry folded in from `excludePathPatterns` looks
// identical to a hand-written passthrough route otherwise, and "which config key produced
// this" is the difference between two very different fixes.
const summarizeRoute = (route) =>
	route
		? { match: route.match, path: route.path, mode: route.mode, queryParams: route.queryParams, source: route.source }
		: null;

/**
 * Explain how `rawUrl` + `requestedDeviceType` map to a cache key.
 *
 * Throws a TypeError for an unparseable URL (the caller turns that into a 400) rather than
 * silently falling back, so a typo doesn't come back looking like a legitimate key.
 */
export const explainCacheKey = (rawUrl, requestedDeviceType) => {
	const url = new URL(rawUrl); // throws on garbage input

	const deviceType = sanitizeDeviceType(requestedDeviceType);
	const forwarded = isForwardedMode();

	// The same classifier the read path uses, so this can never explain a key the serving path
	// wouldn't actually compute.
	const { routeClass, queryParams: allowlist, entry: route } = classifyPath(url.pathname);
	const allowlistSource = !forwarded
		? 'url.queryParams'
		: routeClass === PRERENDER
			? 'ingress.routes[matched].queryParams'
			: `${routeClass} — all params kept`;

	const canonicalUrl = canonicalizeUrl(rawUrl, allowlist);
	const cacheKey = CacheKey.toCacheKey({ url: canonicalUrl, deviceType });

	// The same URL keyed under the global allowlist. In prefix mode this is by definition
	// the same thing; in forwarded mode a difference means the route allowlist is what
	// decides this URL's identity — the thing to check first when a URL never hits cache.
	const globalCanonicalUrl = canonicalizeUrl(rawUrl, config.url.queryParams);
	const globalCacheKey = CacheKey.toCacheKey({ url: globalCanonicalUrl, deviceType });

	// Empty allowlist = allow all hosts (same rule as processJobResult).
	const domainAllowed = config.domains.length === 0 || config.domains.includes(url.hostname);

	return {
		input: { url: rawUrl, deviceType: requestedDeviceType ?? null },
		resolved: {
			deviceType,
			// True when an explicit device type was unsupported and silently fell back to the
			// first supported one — otherwise the key looks inexplicably wrong. Case-only
			// differences ('Mobile') are normal normalization, not a fallback.
			deviceTypeFellBack:
				!!requestedDeviceType && !config.deviceTypes.supported.includes(String(requestedDeviceType).toLowerCase()),
			hostname: url.hostname,
			canonicalUrl,
			cacheKey,
		},
		ingress: {
			mode: config.ingress.mode,
			deviceTypeSource: config.ingress.deviceTypeSource,
			// The headline answer to "will this URL be prerendered". Sole home for the class —
			// `eligibility.prerendered` below is the derived boolean, not a second copy of it.
			routeClass,
			route: summarizeRoute(route),
		},
		allowlist: { used: allowlist, source: allowlistSource },
		underGlobalAllowlist: {
			allowlist: config.url.queryParams,
			canonicalUrl: globalCanonicalUrl,
			cacheKey: globalCacheKey,
			differs: globalCacheKey !== cacheKey,
		},
		eligibility: {
			// Only a `prerender` path is cached and scheduled; the other two classes are proxied
			// live and never enter the cache.
			prerendered: routeClass === PRERENDER,
			// Set when the classification came from a folded `excludePathPatterns` entry rather
			// than a route the operator wrote — a different config key to go and change.
			excludedByPattern: route && route.source === 'excludePathPatterns' ? route.path : null,
			// A host outside the allowlist is rendered but force-marked non-indexable.
			domainAllowed,
			domains: config.domains,
		},
	};
};
