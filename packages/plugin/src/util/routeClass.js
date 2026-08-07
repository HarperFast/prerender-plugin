/**
 * Route classification — the single answer to "do we prerender this path?" and "what KIND of
 * page is this?"
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
 *
 * PAGE TYPES (templates) are the SECOND thing a path resolves to, and the reason they live here
 * rather than beside the metrics that consume them: a page type is a property of the ROUTE, and
 * the route match is already computed on every request. A type is a name — `home`, `category`,
 * `pdp` — that several routes may share, which is the whole point. A site whose category pages
 * are reachable by two URL shapes has ONE category template and wants one set of numbers for
 * it; labelling metrics by the matched route's PATH (what this module used to expose) split that
 * template into two unrelated rows only a reader who knew the route list could add back
 * together. Types also give per-template settings a single home, so two routes sharing a
 * template cannot drift apart on cadence, and they travel to the renderer on the queue job so
 * browser-side rules can be scoped by template name instead of by a second, independently
 * maintained set of URL patterns in another repository.
 *
 * The type is deliberately NOT derived from the path (first segment, a regex, a heuristic).
 * Those all re-encode routing knowledge the route list already holds, and they drift from it
 * silently. Declaring `pageType` on the route keeps one list authoritative.
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

	// Optional template name. Like renderInterval, a bad value drops the FIELD, never the route:
	// losing a name costs a metrics label, while dropping the entry would change how the path is
	// SERVED. An unknown name is NOT rejected — `pageTypes` only has to declare a type that
	// carries settings, so requiring a declaration here would make naming a type for metrics
	// alone impossible.
	let pageType = null;
	if (raw.pageType !== undefined && raw.pageType !== null) {
		if (mode === PASSTHROUGH) {
			warn(
				`ignoring pageType on passthrough route "${raw.match} ${raw.path}" — a passthrough route is never ` +
					`rendered or cached, so it has no template to configure or report on`
			);
		} else if (typeof raw.pageType === 'string' && raw.pageType !== '') {
			pageType = raw.pageType;
		} else {
			warn(
				`ignoring pageType on route "${raw.match} ${raw.path}" — expected a non-empty string, got ` +
					`${String(raw.pageType)}`
			);
		}
	}

	return { match: raw.match, path: raw.path, mode, queryParams, pageType, renderInterval, source };
};

/**
 * Compile the top-level `pageTypes` list into a name → settings map.
 *
 * Last declaration of a duplicated name wins, and says so. Silently keeping the first would
 * leave an operator staring at a cadence that plainly does not match the config they are
 * reading.
 */
const compilePageTypes = (pageTypes) => {
	const log = getLogger();
	const byName = new Map();

	for (const raw of Array.isArray(pageTypes) ? pageTypes : []) {
		if (!raw || typeof raw.name !== 'string' || raw.name === '') continue;

		let renderInterval = null;
		if (raw.renderInterval !== undefined && raw.renderInterval !== null) {
			if (Number.isFinite(raw.renderInterval) && raw.renderInterval > 0) {
				renderInterval = raw.renderInterval;
			} else {
				// String(), never JSON.stringify() — the latter throws on a BigInt, and config
				// compilation must not be crashable from a warning path.
				log.warn?.(
					`[prerender] ignoring renderInterval on pageType "${raw.name}" — expected a positive number of ` +
						`milliseconds, got ${String(raw.renderInterval)}`
				);
			}
		}

		if (byName.has(raw.name)) {
			log.warn?.(`[prerender] pageType "${raw.name}" is declared more than once — using the last declaration`);
		}
		byName.set(raw.name, { name: raw.name, renderInterval });
	}

	return byName;
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

// Same compile-and-memoize treatment for the page-type table, tracked independently: a
// `pageTypes` edit must not force the route list to recompile, and vice versa.
let compiledTypes = null;
let compiledFromPageTypes;

const getPageTypes = () => {
	if (config.pageTypes !== compiledFromPageTypes) {
		compiledTypes = compilePageTypes(config.pageTypes);
		compiledFromPageTypes = config.pageTypes;
	}
	return compiledTypes;
};

/** Declared settings for a page-type name, or null when the name carries none. */
export const pageTypeSettings = (name) => (name ? (getPageTypes().get(name) ?? null) : null);

/** Every declared page-type name, for config reporting and the admin UI. */
export const declaredPageTypes = () => [...getPageTypes().keys()];

/** Every page-type name actually referenced by a compiled route. */
export const routePageTypes = () => {
	const names = new Set();
	for (const entry of getRoutes()) if (entry.pageType) names.add(entry.pageType);
	return names;
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
 * Build the classification result every `classify*` returns, including the metrics label.
 *
 * The label is computed HERE rather than offered as a `pageTypeLabel(x)` helper callers apply
 * themselves. Every caller that labels a metric already holds a classification, and a helper
 * would have to agree with each of them about what its argument is called — the read path calls
 * the matched route `route`, this module calls it `entry` — which is exactly the kind of drift
 * this module exists to prevent. It is a `??` chain over values already in hand: no allocation,
 * nothing worth making lazy.
 *
 * WHY THE FALLBACK CHAIN (name → route path → class). Every request must produce a label or the
 * metric develops holes that read as traffic disappearing. Falling back to the route path
 * (rather than one 'other' bucket) means a deployment that declares no `pageTypes` emits exactly
 * the label values it emitted before types existed — so adoption is incremental, one route at a
 * time, instead of a flag day that resets every dashboard.
 *
 * CARDINALITY is bounded by construction and must stay that way: every arm resolves to a
 * configured name, a configured path, or one of three class constants. Nothing here may ever
 * derive a label from the REQUEST (its path, query, or headers) — an unbounded metrics label is
 * how a monitoring backend gets taken down by a crawler walking a faceted URL space.
 */
const classification = (routeClass, pageType, queryParams, entry) => ({
	routeClass,
	pageType,
	pageTypeLabel: pageType ?? entry?.path ?? routeClass,
	queryParams,
	entry,
});

/**
 * Classify a device-stripped path into
 * `{ routeClass, pageType, pageTypeLabel, queryParams, entry }`.
 *
 * `queryParams` is the allowlist to canonicalize this path's URL with; `entry` is the
 * matched compiled route (null when nothing matched) and carries `source`, so a caller can
 * report WHERE a classification came from.
 *
 * `pageType` is the declared template name, or null — never a fallback — while `pageTypeLabel`
 * is always a string. The two are separate on purpose. A caller labelling a metric needs a
 * value for every request, so it takes the label. A caller telling the renderer which template
 * it is about to render (the queue job) must send the real name or nothing: were it to send the
 * label's fallback, a browser-side rule scoped to a template would fire on a route that was
 * never declared to be one.
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
		const routeClass = entry && entry.mode === PASSTHROUGH ? PASSTHROUGH : PRERENDER;
		// Prefix mode reaches here with `entry` set only for a folded exclude (always
		// passthrough), so a named type can only ever come from a real prerender route.
		const pageType = routeClass === PRERENDER ? (entry?.pageType ?? null) : null;
		return classification(routeClass, pageType, config.cacheKey.queryParams, entry ?? null);
	}

	if (!entry) return classification(UNCLASSIFIED, null, KEEP_ALL, null);
	if (entry.mode === PASSTHROUGH) return classification(PASSTHROUGH, null, KEEP_ALL, entry);
	return classification(PRERENDER, entry.pageType, entry.queryParams, entry);
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
		return classification(UNCLASSIFIED, null, isForwardedMode() ? KEEP_ALL : config.cacheKey.queryParams, null);
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
 * that route's `pageType` cadence, else the target's stored interval (sitemap `<changefreq>` or
 * an explicit API write), else `render.defaultInterval`.
 *
 * ROUTE BEATS ITS PAGE TYPE so a single URL can carve itself out of its template's cadence
 * (an `exact` route above the template's prefix) without inventing a one-member type. The
 * template level is where a cadence shared by several routes belongs — set on each route
 * instead, the two copies drift and only the first-matching one is ever observed.
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
	const { pageType, entry } = classifyUrl(url);
	if (entry && entry.renderInterval !== null && entry.renderInterval !== undefined) return entry.renderInterval;
	const typeInterval = pageTypeSettings(pageType)?.renderInterval;
	if (typeInterval !== null && typeInterval !== undefined) return typeInterval;
	// Coerce before the finite check: `Long` columns can surface the stored interval as a
	// BigInt, which `Number.isFinite` rejects outright — without this, every such target
	// would silently fall back to the default cadence. `Number(null)` is 0 and
	// `Number(undefined)` is NaN, so absent values still fall through to the default.
	const stored = Number(storedInterval);
	return Number.isFinite(stored) && stored > 0 ? stored : config.render.defaultInterval;
};
