import { config } from '../config.js';

/**
 * Whether a request is an authorized on-demand render ("render now") request.
 *
 * The feature must be enabled and a header name configured; the request must
 * carry that header. When a `token` is configured the header value must equal it
 * (the shared secret gate). When no token is configured, mere presence of the
 * header authorizes — the feature is then unauthenticated (see config warning).
 *
 * `headers` is anything with a `.get(name)` accessor (Harper request headers or a
 * `Headers` instance). An unauthorized-but-present header returns false so the
 * caller silently falls through to normal serving rather than leaking that the
 * feature exists.
 */
export const isRenderNowAuthorized = (headers) => {
	const { enabled, header, token } = config.renderNow;
	if (!enabled || !header) return false;
	const value = headers.get(header);
	if (value === null || value === undefined) return false;
	return token ? value === token : true;
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
