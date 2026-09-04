/**
 * What a page load asks of its own origin beyond the document — and how much of it a shared cache
 * would have absorbed.
 *
 * WHY THIS IS MEASURED HERE. The prerender system's offload figure counts documents: bot requests
 * the origin never saw, less the renders/probes/sitemap fetches this system made. It cannot see
 * the other half of a page-view — the XHR/fetch calls the page's OWN scripts make once a crawler
 * that executes JavaScript runs it — because those go crawler → CDN → origin and never pass
 * through the plugin. But this process runs the same page in the same kind of browser, watches
 * every request it makes, and reads every response's cache headers. So the per-page factor is
 * measurable exactly once, here, and posted with the render for the plugin to apply at serve time
 * (HarperFast/prerender-plugin#153). The arithmetic downstream needs one number per page — how
 * many same-origin requests reach the origin whoever runs the page — which is the `uncacheable`
 * count below.
 *
 * THE CLASSIFICATION IS ABOUT A SHARED CACHE, NOT OUR OWN. `ResourceCache.getCachePolicy` decides
 * what THIS fleet may replay across renders and is deliberately narrow (scripts and stylesheets,
 * private refused). The question here is what a CDN in front of the origin would serve without
 * an origin round trip, for any request the page makes, so it follows RFC 9111's shared-cache
 * rules and reports three verdicts rather than two:
 *
 *   uncacheable  — explicitly reaches the origin every time: a non-GET method, a status a cache
 *                  may not store, `Set-Cookie`, `no-store` / `private` / `no-cache`, a zero max-age,
 *                  `Vary: *`, or an `Expires` already in the past. Only this class is counted as
 *                  origin load.
 *   cacheable    — explicit positive freshness (`s-maxage`, `max-age`, or a future `Expires`).
 *   unspecified  — no freshness information at all. A CDN may apply heuristic freshness or a
 *                  configured default TTL, or may not; that is a deployment fact this process
 *                  cannot see, so these are reported and counted on neither side.
 *
 * Nothing about the REQUEST's cookies or authorization is consulted: this fleet sends a bypass
 * token the crawler would not, and a crawler's renderer starts with no cookies — the response is
 * what decides shared cacheability, and `Set-Cookie` is the request-specific case it covers.
 *
 * Blocked requests are counted separately. `block.resourceTypes` / `block.urlPatterns` abort a
 * request before any response exists, so a same-origin request this fleet refused to make is a
 * request a crawler WOULD make whose class is unknown — the visible bound on the undercount. Static
 * media (images, fonts, audio/video) is left out of that count: a fleet blocks those by the
 * hundred, a CDN caches them as a matter of course, and counting them would make the bound read as
 * an alarm about requests that say nothing about k. What remains — blocked scripts, XHR/fetch,
 * documents, "other" — is exactly the class that might.
 */

export type SubrequestClass = 'uncacheable' | 'cacheable' | 'unspecified';

export type SubrequestTally = {
	/** Responses from the navigation origin, the document itself excluded. */
	sameOrigin: number;
	cacheable: number;
	uncacheable: number;
	unspecified: number;
	/** Same-origin requests this fleet's block list aborted before a response existed — static media excluded. */
	blocked: number;
};

// Resource types whose blocked requests are NOT counted as an unknown: static media a CDN caches.
const STATIC_MEDIA = new Set(['image', 'font', 'media']);

/** Does a blocked same-origin request of this resource type count toward the `blocked` bound? */
export const countsAsBlocked = (resourceType: string): boolean => !STATIC_MEDIA.has(resourceType);

export const emptyTally = (): SubrequestTally => ({
	sameOrigin: 0,
	cacheable: 0,
	uncacheable: 0,
	unspecified: 0,
	blocked: 0,
});

// Status codes a cache may store without explicit freshness (RFC 9110 §15.1 "heuristically
// cacheable"), plus 308. Anything else — every 5xx, 401/403, 429 — reached the origin and will
// again.
const CACHEABLE_STATUSES = new Set([200, 203, 204, 206, 300, 301, 308, 404, 405, 410, 414, 501]);

// Lenient on purpose: the ABNF has no whitespace around `=` and no quotes on a delta-seconds value,
// but origins emit both (`max-age = 60`, `max-age="60"`) and the caches this classifier stands in
// for accept them. Strictness here would push a response a CDN happily caches into `unspecified`.
const directiveSeconds = (cc: string, name: string): number | null => {
	const m = cc.match(new RegExp(`(?:^|[,\\s])${name}\\s*=\\s*"?(\\d+)"?`));
	return m ? parseInt(m[1], 10) : null;
};

/**
 * Would a shared cache have answered this response without going to the origin?
 *
 * `headers` as puppeteer's `HTTPResponse.headers()` hands them: lower-cased keys, multi-valued
 * headers joined. Pure, so the rules above are testable without a browser.
 */
export function classifySubresponse(method: string, status: number, headers: Record<string, string>): SubrequestClass {
	const verb = method.toUpperCase();
	if (verb !== 'GET' && verb !== 'HEAD') return 'uncacheable';
	if (!CACHEABLE_STATUSES.has(status)) return 'uncacheable';
	if (headers['set-cookie']) return 'uncacheable';

	const cc = (headers['cache-control'] ?? '').toLowerCase();
	if (/(?:^|[,\s])(?:no-store|private|no-cache)(?:$|[,\s=])/.test(cc)) return 'uncacheable';
	if ((headers['vary'] ?? '').trim() === '*') return 'uncacheable';

	// Shared caches honour s-maxage over max-age; a zero in either is "stale on arrival", i.e. a
	// revalidation against the origin on every use — origin load, however the response is labelled.
	const sMaxAge = directiveSeconds(cc, 's-maxage');
	if (sMaxAge !== null) return sMaxAge > 0 ? 'cacheable' : 'uncacheable';
	const maxAge = directiveSeconds(cc, 'max-age');
	if (maxAge !== null) return maxAge > 0 ? 'cacheable' : 'uncacheable';

	if (headers['expires'] !== undefined) {
		// Measured against the origin's own clock when it says what time it is; an unparseable
		// Expires is "already expired" by specification.
		const expires = Date.parse(headers['expires']);
		if (Number.isNaN(expires)) return 'uncacheable';
		const dateHeader = headers['date'] !== undefined ? Date.parse(headers['date']) : NaN;
		const now = Number.isNaN(dateHeader) ? Date.now() : dateHeader;
		return expires > now ? 'cacheable' : 'uncacheable';
	}

	return 'unspecified';
}

/** Record one same-origin, non-navigation response in the tally. Mutates in place. */
export function tallySubresponse(
	tally: SubrequestTally,
	method: string,
	status: number,
	headers: Record<string, string>,
	{ replayedFromOwnCache = false } = {}
): void {
	tally.sameOrigin++;
	// A response this fleet replayed from its own resource cache passed getCachePolicy, which is
	// stricter than the shared-cache rules here — so it is cacheable by construction, and its
	// replayed headers (some stripped) are not the evidence to re-judge it on.
	const verdict = replayedFromOwnCache ? 'cacheable' : classifySubresponse(method, status, headers);
	tally[verdict]++;
}
