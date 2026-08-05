/**
 * Route classification — the single answer to "do we prerender this path?"
 *
 * Every path the plugin sees resolves to exactly one of three classes:
 *
 *   prerender    — cache it, schedule it, serve it from cache. The CDN forwards it and we
 *                  own its rendered output.
 *   passthrough  — proxy it live, never cache it, never schedule it, and stay quiet about
 *                  it. A declaration that we know the CDN forwards this path and have
 *                  deliberately chosen not to prerender it.
 *   unclassified — proxy it live, never cache it, never schedule it, and COUNT it. Nobody
 *                  declared this path, so either the CDN is over-forwarding or the route
 *                  list is incomplete. Reported via util/unrouted.js.
 *
 * No class blocks a request. The difference between passthrough and unclassified is purely
 * whether an operator has declared the path — it changes what gets reported, not what the
 * visitor receives.
 *
 * WHY THIS IS ONE MODULE. The allowlist a URL is canonicalized with decides its cache key,
 * and four independent paths compute keys for the same URL: the bot read, the sitemap write,
 * traffic discovery, and the render-result redirect re-key. If any two disagree the rendered
 * page is stored where nothing looks for it — a permanent cache miss with no error anywhere.
 * They all route through `queryAllowlistFor` here, so there is one place for them to agree.
 *
 * WHY PASSTHROUGH IS ALWAYS `['*']`. `queryParams` does double duty: the canonical URL it
 * produces is both the cache key AND the URL fetched from the origin (see
 * `resolveForwardedRequest`). On a prerender route that coupling is required — the fetch must
 * retrieve exactly what the key represents, or one bot's `?pg=3` gets cached as everyone's
 * page 1. A passthrough route has no cache and therefore no key, so the only thing an
 * allowlist could still do there is silently strip params from the proxied request and hand
 * the visitor the wrong page — with no cached entry and no `x-harper-cache-key` to explain
 * it. So an allowlist on a passthrough entry is rejected at compile time, not honored.
 */

import { config, getLogger } from '../config.js';

export const PRERENDER = 'prerender';
export const PASSTHROUGH = 'passthrough';
export const UNCLASSIFIED = 'unclassified';

const VALID_MATCH = new Set(['exact', 'prefix', 'contains']);
const VALID_MODE = new Set([PRERENDER, PASSTHROUGH]);

// The allowlist every non-prerender class resolves to: keep every query param, so a proxied
// request reaches the origin with the query the visitor actually sent. (`['*']` still
// canonicalizes — params are sorted, the fragment and a trailing slash are dropped — it just
// drops nothing.) This is also what an unmatched path has always resolved to, so declaring a
// previously-unmatched path as `passthrough` changes no cache key.
const KEEP_ALL = ['*'];

export const isForwardedMode = () => config.ingress.mode === 'forwarded';

/**
 * Validate + normalize one raw config entry. Returns null for an entry that can't be used,
 * so a single typo drops one route rather than breaking the list.
 */
const compileEntry = (raw, source, warn) => {
	if (!raw || typeof raw.path !== 'string' || raw.path === '') return null;
	if (!VALID_MATCH.has(raw.match)) return null;
	// `exact`/`prefix` are anchored at the path root; `contains` is a free substring, so it
	// carries no such requirement.
	if (raw.match !== 'contains' && !raw.path.startsWith('/')) return null;

	const mode = raw.mode === undefined ? PRERENDER : raw.mode;
	if (!VALID_MODE.has(mode)) return null;

	let queryParams;
	if (mode === PASSTHROUGH) {
		if (Array.isArray(raw.queryParams) && raw.queryParams.length > 0) {
			warn(
				`ignoring queryParams on passthrough route "${raw.match} ${raw.path}" — a passthrough route is never ` +
					`cached, so an allowlist there would only strip params from the proxied origin fetch`
			);
		}
		queryParams = KEEP_ALL;
	} else {
		queryParams = Array.isArray(raw.queryParams) ? raw.queryParams.slice() : [];
	}

	// Optional per-route render cadence (ms). A bad value drops the FIELD, never the route —
	// rejecting the whole entry over a cadence typo would silently change how the path is
	// SERVED (prerender → unclassified), a far worse failure than falling back to the
	// default interval.
	let renderInterval = null;
	// `null` is treated as "not set", not as a bad value — it's the conventional way to
	// explicitly clear a setting, so it shouldn't warn.
	if (raw.renderInterval !== undefined && raw.renderInterval !== null) {
		if (mode === PASSTHROUGH) {
			warn(
				`ignoring renderInterval on passthrough route "${raw.match} ${raw.path}" — a passthrough route is ` +
					`never scheduled, so it has no render cadence`
			);
		} else if (Number.isFinite(raw.renderInterval) && raw.renderInterval > 0) {
			renderInterval = raw.renderInterval;
		} else {
			// String(), not JSON.stringify(): the latter THROWS on a BigInt, and a warning
			// path must never be able to crash config compilation.
			warn(
				`ignoring renderInterval on route "${raw.match} ${raw.path}" — expected a positive number of ` +
					`milliseconds, got ${String(raw.renderInterval)}`
			);
		}
	}

	return { match: raw.match, path: raw.path, mode, queryParams, renderInterval, source };
};

/**
 * Compile `excludePathPatterns` + `ingress.routes` into one ordered list.
 *
 * The excludes come FIRST, deliberately. They used to be a separate, later gate — a URL
 * matching one was proxied but never scheduled regardless of which route it matched — so
 * prepending them as `contains`/`passthrough` entries preserves that "an exclude always
 * wins" precedence without asking config authors to get the ordering right by hand.
 *
 * One behavior change comes with the fold: excludes were matched against the whole URL
 * string, and route matching is path-only. A pattern that only makes sense against a query
 * string is warned about rather than silently never matching.
 */
const compileRoutes = (routes, excludePatterns) => {
	const log = getLogger();
	const warn = (message) => log.warn?.(`[prerender] ${message}`);
	const compiled = [];
	// Both loops push through this, so a `null` from `compileEntry` can never reach the
	// compiled list. Not currently reachable from the exclude loop (the guard below leaves
	// nothing for compileEntry to reject), but it is the kind of thing a later tweak to either
	// side would quietly break, and a null in here throws on EVERY bot request in `matchRoute`.
	const add = (raw, source) => {
		const entry = compileEntry(raw, source, warn);
		if (entry) compiled.push(entry);
		return !!entry;
	};

	for (const pattern of Array.isArray(excludePatterns) ? excludePatterns : []) {
		if (typeof pattern !== 'string' || pattern === '') continue;
		if (pattern.includes('?') || pattern.includes('=')) {
			warn(
				`excludePathPatterns entry "${pattern}" looks like it matches a query string, but exclude patterns are ` +
					`now matched against the PATH only — it will never match`
			);
		}
		add({ match: 'contains', path: pattern, mode: PASSTHROUGH }, 'excludePathPatterns');
	}

	let dropped = 0;
	for (const raw of Array.isArray(routes) ? routes : []) {
		if (!add(raw, 'ingress.routes')) dropped++;
	}
	if (dropped > 0) warn(`Ignoring ${dropped} invalid ingress route(s)`);

	return compiled;
};

// Compile + memoize. `applyOptions` rebuilds the whole config from defaults on every change,
// so both source arrays are fresh objects and an identity check detects a reload. Both are
// tracked: an `excludePathPatterns` edit has to recompile too, now that it feeds the list.
let compiled = null;
let compiledFromRoutes;
let compiledFromExcludes;

const getRoutes = () => {
	if (config.ingress.routes !== compiledFromRoutes || config.ingress.excludePathPatterns !== compiledFromExcludes) {
		compiled = compileRoutes(config.ingress.routes, config.ingress.excludePathPatterns);
		compiledFromRoutes = config.ingress.routes;
		compiledFromExcludes = config.ingress.excludePathPatterns;
	}
	return compiled;
};

/**
 * First matching compiled entry for `path`, or null. First match wins, so entries should be
 * ordered most-specific first — which is what lets a passthrough carve-out sit inside a
 * prerendered prefix (`/products/clearance/` above `/products/`).
 */
export const matchRoute = (path) => {
	for (const entry of getRoutes()) {
		const hit =
			entry.match === 'exact'
				? path === entry.path
				: entry.match === 'contains'
					? path.includes(entry.path)
					: path.startsWith(entry.path);
		if (hit) return entry;
	}
	return null;
};

/** How many prerender routes are configured. Config validation uses this — see below. */
export const prerenderRouteCount = () => {
	let count = 0;
	for (const entry of getRoutes()) if (entry.mode === PRERENDER) count++;
	return count;
};

/**
 * Classify a device-stripped path into `{ routeClass, queryParams, entry }`.
 *
 * `queryParams` is the allowlist to canonicalize this path's URL with; `entry` is the
 * matched compiled route (null when nothing matched) and carries `source`, so a caller can
 * report WHERE a classification came from.
 *
 * The field is `routeClass`, not `class`: `class` is a reserved word, so a caller could not
 * destructure it without renaming at every call site.
 *
 * Native (prefix) mode has no route list to gate ingress — a request arriving at
 * `botPathPrefix` is a prerender request by construction, and the URL is the path itself. So
 * there, the only entries that apply are the folded excludes, and the allowlist is always the
 * global `url.queryParams` exactly as before. That keeps one classifier covering both modes
 * instead of leaving excludes as a second, mode-specific mechanism.
 */
export const classifyPath = (path) => {
	const entry = matchRoute(path);

	if (!isForwardedMode()) {
		return {
			routeClass: entry && entry.mode === PASSTHROUGH ? PASSTHROUGH : PRERENDER,
			queryParams: config.cacheKey.queryParams,
			entry: entry ?? null,
		};
	}

	if (!entry) return { routeClass: UNCLASSIFIED, queryParams: KEEP_ALL, entry: null };
	if (entry.mode === PASSTHROUGH) return { routeClass: PASSTHROUGH, queryParams: KEEP_ALL, entry };
	return { routeClass: PRERENDER, queryParams: entry.queryParams, entry };
};

/**
 * `classifyPath` for a whole URL — the form every non-request caller has. Returns the same
 * `{ routeClass, queryParams, entry }`.
 *
 * CONTRACT: `rawUrl` is a DEVICE-FREE public URL — a sitemap `<loc>` or the browser's final
 * `page.url()`, both of which never carry the CDN's device path-prefix. Classification matches
 * the same device-stripped path the read path feeds it (ingress resolves the device prefix off
 * separately). Do NOT strip a device prefix here: these URLs have none, and doing so would
 * wrongly consume a real first path segment that happens to equal a device-type name.
 */
export const classifyUrl = (rawUrl) => {
	const pathname = URL.parse(rawUrl)?.pathname;
	if (pathname === undefined) {
		// Unparseable, so unclassifiable. Keep every param exactly as an unmatched path does —
		// any caller that goes on to build a key from this URL fails on the URL itself first.
		return {
			routeClass: UNCLASSIFIED,
			queryParams: isForwardedMode() ? KEEP_ALL : config.cacheKey.queryParams,
			entry: null,
		};
	}
	return classifyPath(pathname);
};

/**
 * The query-param allowlist to canonicalize a URL with, matching what a bot READ of that URL
 * would use — so the sitemap-write, discovery, and redirect-re-key keys equal the read key.
 *
 * A thin projection of `classifyUrl` so the allowlist and the class can never be derived from
 * two different parses of the same URL. Callers that need both (sitemap ingest) should call
 * `classifyUrl` once instead of this plus a separate classification.
 */
export const queryAllowlistFor = (rawUrl) => classifyUrl(rawUrl).queryParams;

/**
 * The render cadence for a URL: the matched route's `renderInterval` when it sets one, else
 * the target's stored interval (sitemap `<changefreq>` or an explicit API write), else
 * `render.defaultInterval`.
 *
 * ROUTE BEATS STORED, deliberately. The stored interval is data written at creation time;
 * if it won, changing a route's cadence would apply only to targets discovered AFTER the
 * config change — every existing row would keep its stamped value forever, and making config
 * apply would mean sweeping the whole registry. Route-first makes a cadence change take
 * effect on each URL's next render cycle with no data migration. The expressiveness lost is
 * none: a per-URL exception to a route's cadence is an `exact` route above it (first match
 * wins), and a route that should defer to sitemap `<changefreq>` simply doesn't set
 * `renderInterval`.
 *
 * Same contract as `classifyUrl`: `url` is a device-free public URL (the Target primary key
 * / the url-half of a cacheKey).
 */
export const resolveRenderInterval = (url, storedInterval) => {
	const { entry } = classifyUrl(url);
	if (entry && entry.renderInterval !== null && entry.renderInterval !== undefined) return entry.renderInterval;
	// Coerce before the finite check: `Long` columns can surface the stored interval as a
	// BigInt, which `Number.isFinite` rejects outright — without this, every such target
	// would silently fall back to the default cadence. `Number(null)` is 0 and
	// `Number(undefined)` is NaN, so absent values still fall through to the default.
	const stored = Number(storedInterval);
	return Number.isFinite(stored) && stored > 0 ? stored : config.render.defaultInterval;
};
