import { config } from '../config.js';
import { PRERENDER } from './routeClass.js';

/**
 * The serving policy for one request: `{ skipCache, missMode }`.
 *
 * Composed here rather than inline in the handler because the interaction of route class,
 * method and the two on-demand levers is the part that is easy to get subtly wrong, and this
 * way it is a pure function of (class, method, headers, config) that can be tested directly.
 *
 * `skipCache` NEVER means "don't read the cache because of the class". A non-prerender path is
 * still served from cache when a fresh entry exists — it just never populates one (the
 * handler's `maybeSchedule` is what enforces that). Cutting the read would take a URL that is
 * cached today and drop it to the origin the moment its route stopped being declared: a silent
 * loss of prerendered output rather than a graceful one.
 *
 * What the class DOES decide is the on-demand levers, which only make sense for a URL we would
 * actually store: a non-prerender class can neither skip the cache nor force a render, so its
 * miss always proxies.
 */
export const resolveServingPolicy = (routeClass, method, headers) => {
	const authorized = routeClass === PRERENDER && method === 'GET' && isRenderNowAuthorized(headers);
	return {
		skipCache: authorized && wantsCacheSkip(headers),
		missMode: authorized ? resolveMissMode(headers) : 'origin',
	};
};

/**
 * Whether a request is an authorized on-demand render ("render now") request.
 *
 * Requires the feature enabled, a header name configured, AND a non-empty token;
 * the request must carry that header with a value equal to the token.
 *
 * This fails CLOSED on a missing token rather than treating "no token" as
 * "authorize anyone". The levers bypass the served cache and can occupy a request
 * for up to `timeoutMs` forcing a synchronous render, so on a path that takes
 * public crawler traffic the unauthenticated reading is a DoS lever, not a
 * convenience. It is also the state a misconfiguration lands in: `valueEnv`
 * pointing at an unset variable leaves `token` at its empty default, so the
 * permissive reading would turn a typo in a variable name into an open door.
 *
 * `headers` is anything with a `.get(name)` accessor (Harper request headers or a
 * `Headers` instance). An unauthorized-but-present header returns false so the
 * caller silently falls through to normal serving rather than leaking that the
 * feature exists.
 */
export const isRenderNowAuthorized = (headers) => {
	const { enabled, header, token } = config.renderNow;
	if (!enabled || !header || !token) return false;
	const value = headers.get(header);
	if (value === null || value === undefined) return false;
	return value === token;
};

/**
 * Whether a request opts out of the served cache via a standard Cache-Control
 * directive (`no-cache` or `no-store`). Only honored for authorized on-demand
 * requests (the caller gates on `isRenderNowAuthorized` first), so it never lets
 * anonymous traffic bypass the cache. `no-cache`/`no-store` are matched as whole
 * directive tokens (a `max-age=...` param is ignored).
 */
export const wantsCacheSkip = (headers) => {
	const cacheControl = headers.get('cache-control');
	if (!cacheControl) return false;
	const directives = cacheControl
		.toLowerCase()
		.split(',')
		.map((directive) => directive.split('=')[0].trim());
	return directives.includes('no-cache') || directives.includes('no-store');
};

/**
 * Resolve the cache-miss behavior for an authorized on-demand request from the
 * configured `missHeader`: 'origin' (proxy the origin) or 'prerender' (render now
 * and wait). An absent/empty/unrecognized value falls back to `defaultMissMode`.
 */
export const resolveMissMode = (headers) => {
	const { missHeader, defaultMissMode } = config.renderNow;
	const value = missHeader ? headers.get(missHeader) : null;
	if (!value) return defaultMissMode;
	const normalized = value.trim().toLowerCase();
	if (normalized === 'origin') return 'origin';
	if (normalized === 'prerender') return 'prerender';
	return defaultMissMode;
};

/**
 * Poll `get(cacheKey)` until it returns a page rendered at/after `since` (epoch
 * ms), or `timeoutMs` elapses. Returns the fresh page, or null on timeout.
 *
 * A pre-existing (stale) cache entry has `lastCached < since`, so it is skipped —
 * only a genuinely fresh render (the one this request triggered) resolves the
 * wait. `get`, `sleep`, and `now` are injected so this is unit-testable without
 * Harper globals or real timers.
 */
export const pollForFreshRender = async ({
	get,
	cacheKey,
	since,
	timeoutMs,
	pollIntervalMs,
	sleep,
	now = Date.now,
}) => {
	const deadline = now() + timeoutMs;
	for (;;) {
		const page = await get(cacheKey);
		// Number() handles both a Date (via valueOf) and a numeric timestamp without
		// allocating, and coerces a missing lastCached to NaN (undefined) or 0 (null) —
		// neither is >= a real `since`, so no explicit null-guard is needed.
		if (page && Number(page.lastCached) >= since) return page;
		if (now() >= deadline) return null;
		await sleep(pollIntervalMs);
	}
};
