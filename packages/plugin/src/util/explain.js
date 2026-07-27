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
import { isForwardedMode, matchRoute } from './ingress.js';
import { sanitizeDeviceType } from './device_type.js';

const summarizeRoute = (route) =>
	route ? { match: route.match, path: route.path, queryParams: route.queryParams } : null;

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
	const route = forwarded ? matchRoute(url.pathname) : null;

	// Mirror queryAllowlistFor's resolution, but keep the reason visible.
	const allowlist = forwarded ? (route ? route.queryParams : ['*']) : config.url.queryParams;
	const allowlistSource = forwarded
		? route
			? 'ingress.routes[matched].queryParams'
			: 'unmatched route — all params kept'
		: 'url.queryParams';

	const canonicalUrl = canonicalizeUrl(rawUrl, allowlist);
	const cacheKey = CacheKey.toCacheKey({ url: canonicalUrl, deviceType });

	// The same URL keyed under the global allowlist. In prefix mode this is by definition
	// the same thing; in forwarded mode a difference means the route allowlist is what
	// decides this URL's identity — the thing to check first when a URL never hits cache.
	const globalCanonicalUrl = canonicalizeUrl(rawUrl, config.url.queryParams);
	const globalCacheKey = CacheKey.toCacheKey({ url: globalCanonicalUrl, deviceType });

	const excludedBy = config.excludePathPatterns.filter((pattern) => rawUrl.includes(pattern));
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
			route: summarizeRoute(route),
			matchedRoute: forwarded ? !!route : null,
		},
		allowlist: { used: allowlist, source: allowlistSource },
		underGlobalAllowlist: {
			allowlist: config.url.queryParams,
			canonicalUrl: globalCanonicalUrl,
			cacheKey: globalCacheKey,
			differs: globalCacheKey !== cacheKey,
		},
		eligibility: {
			// A URL matching an exclude pattern is proxied but never scheduled for rendering.
			excluded: excludedBy.length > 0,
			excludedBy,
			// A host outside the allowlist is rendered but force-marked non-indexable.
			domainAllowed,
			domains: config.domains,
		},
	};
};
