import { settings } from '../settings.js';

/**
 * URL normalization for the renderer's equality checks. Kept here — not inlined in a
 * `page.evaluate()` function — so it is unit-tested and single-source. The bug this guards
 * against was two copies of "normalize a URL" drifting apart: the page URL was run through
 * `searchParams.sort()` (which form-encodes a `:` to `%3A`) while the canonical was not, so a
 * self-canonical page whose canonical used a literal `:` never matched the request's `%3A`
 * and was wrongly marked non-indexable.
 */

/**
 * Normalize a URL for redirect detection (page.url() vs the requested job URL): sort the
 * query so param order is insignificant, and decode non-reserved percent-escapes.
 */
/** decodeURI that never throws: a malformed %-sequence (e.g. `%E0%A0`, `%9`) falls back to
 *  the raw string, so a bad URL degrades to a byte comparison instead of throwing URIError
 *  out of a normalizer that runs on every render job. */
const safeDecodeURI = (s: string): string => {
	try {
		return decodeURI(s);
	} catch {
		return s;
	}
};

/**
 * Canonical URL-half of a cache key. This MUST stay byte-for-byte identical to the plugin's
 * `canonicalizeUrl` (packages/plugin/src/util/url.js) — the two are pinned by the shared test
 * vector at repo root (`test-vectors/canonicalize-url.json`), asserted by both packages' test
 * suites, so the copies cannot drift. The browser uses it ONLY to detect a genuine redirect
 * (does the final page URL canonicalize to a different key than the job URL?); it forms no
 * cache key itself and posts the RAW page URL back for the plugin to canonicalize with the
 * route allowlist. See that file for the full rule list.
 *
 * `queryParams` defaults to `['*']` (keep all) — the browser has no route config, and for
 * redirect detection keeping every param is the conservative choice; the plugin re-keys with
 * the real per-route allowlist.
 */
const UNRESERVED = /[A-Za-z0-9\-._~]/;

// Read lazily off the live settings object so a worker that resolves config after this module is
// imported still gets the right policy. See CacheKeyConfig for why only these two are mirrored.
const cacheKeyPolicy = () => settings.config?.cacheKey ?? { plusIsSpace: false, trailingSlash: 'strip' as const };

/**
 * The plugin's `cacheKey.decodeReserved` default. Fixed here on purpose: the browser never
 * BUILDS a key, it only ever compares two URLs it normalizes itself (page.url() vs the job URL
 * for redirect detection, canonical vs page.url() for the indexability verdict), so a deployment
 * that changes the plugin's set does not have to mirror it — both sides of every comparison go
 * through this same function. An option that changes which URLs are the SAME KEY (e.g. folding
 * `+` and `%20`) is the opposite: it must be mirrored here, or a job URL keyed under the folded
 * spelling reads as a mismatch against its own canonical.
 */
const DECODE_RESERVED = new Set([':', ',', '@']);

/** See the plugin's `normalizeEscapes` for why the unreserved decode is unconditional, and why
 *  `%2E` needs no special case (the URL parser has already resolved dot segments). */
const normalizeEscapes = (s: string): string =>
	s.replace(/%[0-9A-Fa-f]{2}/g, (m) => {
		const char = String.fromCharCode(parseInt(m.slice(1), 16));
		if (UNRESERVED.test(char)) return char;
		return DECODE_RESERVED.has(char) ? char : m.toUpperCase();
	});

export const canonicalizeUrl = (url: string | URL, queryParams: string[] = ['*']): string => {
	const parsed = url instanceof URL ? new URL(url.href) : new URL(url);
	parsed.hash = '';

	const rawQuery = parsed.search.startsWith('?') ? parsed.search.slice(1) : parsed.search;
	let query = '';
	if (rawQuery) {
		const keepAll = queryParams.includes('*');
		const keep = keepAll ? null : new Set(queryParams);
		// Fold BEFORE sorting, or it defeats itself: `%20` and `+` sort to different positions.
		const { plusIsSpace } = cacheKeyPolicy();
		const segments = rawQuery.split('&').filter((seg) => {
			if (seg === '') return false;
			if (keepAll) return true;
			const rawKey = seg.split('=')[0];
			let key: string;
			try {
				key = decodeURIComponent(rawKey);
			} catch {
				key = rawKey;
			}
			return keep!.has(key);
		});
		if (plusIsSpace) {
			for (let i = 0; i < segments.length; i++) segments[i] = segments[i].replace(/%20/gi, '+');
		}
		segments.sort();
		if (segments.length) query = `?${segments.join('&')}`;
	}

	const path =
		cacheKeyPolicy().trailingSlash === 'strip' && parsed.pathname !== '/' && parsed.pathname.endsWith('/')
			? parsed.pathname.slice(0, -1)
			: parsed.pathname;

	let half = normalizeEscapes(`${parsed.protocol}//${parsed.host}${path}${query}`);
	half = half.replace(/\|/g, '%7C');
	return half;
};

export const normalizeUrlForCompare = (url: string | URL): string => {
	const parsed = new URL(url);
	parsed.searchParams.sort();
	return safeDecodeURI(parsed.href);
};

/**
 * Normalize a URL down to the DOCUMENT it names, ignoring how that name is spelled. Like
 * {@link normalizeUrlForCompare} but also drops the hash and a trailing slash — neither changes
 * which document a canonical names. Sorting re-serializes the query with uniform (form)
 * encoding, so a reserved char that is percent-encoded in the request (`%3A`) and literal in
 * the canonical (`:`) compare equal; `decodeURI` alone can't do that, as it leaves
 * reserved-char escapes intact.
 *
 * That form-encoding round-trip also collapses `%20` and `+` — which makes this the wrong
 * question for indexability (see {@link canonicalVerdict}) and exactly the right one for
 * telling a re-spelling of one document apart from a pointer at a different document.
 */
export const normalizeCanonicalUrl = (url: string | URL): string => {
	const parsed = new URL(url);
	parsed.hash = '';
	parsed.searchParams.sort();
	// Drop a trailing slash on the path (but not the root "/") so "/a/" and "/a" match even
	// when a query follows — a plain `href.endsWith('/')` check wouldn't catch "/a/?x=1".
	if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) {
		parsed.pathname = parsed.pathname.slice(0, -1);
	}
	return safeDecodeURI(parsed.href);
};

/** What a page's `<link rel="canonical">` says about the URL that was rendered. */
export type CanonicalVerdict = 'self' | 'variant' | 'elsewhere';

/**
 * Read a page's canonical link in the only unit the plugin can act on: the CACHE KEY.
 *
 *   'self'      — no canonical, or it canonicalizes to this very key. Indexable.
 *   'variant'   — it names the same document RE-SPELLED as a different key: `%20` where the
 *                 canonical writes `+`, or any other difference that survives the cache key but
 *                 vanishes under form-encoding. Rendering it fills a second key with bytes
 *                 identical to the first.
 *   'elsewhere' — it names a different URL outright (different path, different params, values
 *                 in a different order). Often still the same page — a faceted origin ignores a
 *                 decorative slug and reorders facets for you — but nothing about the URLs says
 *                 so, and the answer is the same either way: don't index this one.
 *
 * Both non-self verdicts are non-indexable and the plugin suppresses them identically; they
 * are separated only so an operator can read "N duplicate spellings" apart from "N pages that
 * canonicalize to another page". An origin that writes canonicals in a different encoding from
 * its own sitemap would surface as a wave of 'variant' — that is the signal to investigate,
 * not a reason to loosen the comparison back. What such an origin CANNOT lose is its declared
 * corpus: a sitemap-listed url is serialized even when non-indexable, so its result posts with
 * content and `rendered` wins in {@link RenderJob.outcome}, which keeps it out of the plugin's
 * suppression branch entirely. Only urls the plugin discovered are retirable this way.
 *
 * WHY THE KEY, NOT THE DOCUMENT. The consequence of this verdict is `Target.suppress`, and a
 * Target IS a cache key: two spellings of one document that key differently are two targets,
 * two recurring render slots, and two copies of the same bytes, forever. So "does this name
 * the same document" is not the question worth asking here — "does this name the same key" is.
 * Asking it through `canonicalizeUrl` also means the answer cannot drift from what the plugin
 * actually stores, since that is the same function the key is built with.
 *
 * The current URL's own param NAMES are the allowlist for both sides. The rendered URL is
 * already route-filtered (it is a canonical half), so a param the route drops must never be
 * able to manufacture a mismatch, while a param the route keeps is compared byte-for-byte.
 *
 * A relative canonical resolves against the current URL. A malformed one fails open ('self'):
 * a broken tag must not cost a page its indexability.
 */
export const canonicalVerdict = (canonicalHref: string | null | undefined, currentUrl: string): CanonicalVerdict => {
	if (!canonicalHref) return 'self';
	try {
		const current = new URL(currentUrl);
		const canonical = new URL(canonicalHref, current);
		const allowlist = [...current.searchParams.keys()];
		if (canonicalizeUrl(canonical, allowlist) === canonicalizeUrl(current, allowlist)) return 'self';
		return normalizeCanonicalUrl(canonical) === normalizeCanonicalUrl(current) ? 'variant' : 'elsewhere';
	} catch {
		return 'self';
	}
};
