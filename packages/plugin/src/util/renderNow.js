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
 * Whether the schedule row for a render-now key means a render is already in flight.
 *
 * A claimed job's schedule carries a lease-expiry `nextRenderTime` in
 * (now, now + leaseTime]. A render-now request for such a key should piggyback on
 * the running render (its fresh `lastCached` will resolve the poll) rather than
 * overwrite the lease — overwriting makes the leased job immediately re-claimable
 * and spawns a duplicate concurrent render, so spamming render-now for one URL
 * could launch many parallel Chrome renders (DoS). A far-future scheduled target
 * (nextRenderTime beyond the lease window) is NOT in flight and is still bumped to
 * now so render-now actually renders it.
 */
export const isRenderInFlight = (existing, now, leaseTime) =>
	!!existing && existing.nextRenderTime > now && existing.nextRenderTime <= now + leaseTime;

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
