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
const FIXED_DECODE: Record<string, string> = { '%3a': ':', '%2c': ',', '%40': '@' };

export const canonicalizeUrl = (url: string | URL, queryParams: string[] = ['*']): string => {
	const parsed = url instanceof URL ? new URL(url.href) : new URL(url);
	parsed.hash = '';

	const rawQuery = parsed.search.startsWith('?') ? parsed.search.slice(1) : parsed.search;
	let query = '';
	if (rawQuery) {
		const keepAll = queryParams.includes('*');
		const keep = keepAll ? null : new Set(queryParams);
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
		segments.sort();
		if (segments.length) query = `?${segments.join('&')}`;
	}

	const path =
		parsed.pathname !== '/' && parsed.pathname.endsWith('/') ? parsed.pathname.slice(0, -1) : parsed.pathname;

	let half = `${parsed.protocol}//${parsed.host}${path}${query}`;
	half = half.replace(/%(?:3a|2c|40)/gi, (m) => FIXED_DECODE[m.toLowerCase()]);
	half = half.replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase());
	half = half.replace(/\|/g, '%7C');
	return half;
};

export const normalizeUrlForCompare = (url: string | URL): string => {
	const parsed = new URL(url);
	parsed.searchParams.sort();
	return safeDecodeURI(parsed.href);
};

/**
 * Normalize a URL for canonical self-reference comparison. Like {@link normalizeUrlForCompare}
 * but also drops the hash and a trailing slash — neither changes which document a canonical
 * names. Sorting re-serializes the query with uniform (form) encoding, so a reserved char
 * that is percent-encoded in the request (`%3A`) and literal in the canonical (`:`) compare
 * equal; `decodeURI` alone can't do that, as it leaves reserved-char escapes intact.
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

/**
 * Whether a page's canonical link permits indexing: true when there is no canonical, or the
 * canonical resolves to the same URL as the page. A relative canonical is resolved against
 * the current URL. Comparison is on the normalized form, so encoding, param order, hash, and
 * trailing-slash differences are not treated as a mismatch. A malformed canonical fails open
 * (does not drop indexability over a broken tag).
 */
export const canonicalAllowsIndex = (canonicalHref: string | null | undefined, currentUrl: string): boolean => {
	if (!canonicalHref) return true;
	try {
		return normalizeCanonicalUrl(new URL(canonicalHref, currentUrl)) === normalizeCanonicalUrl(currentUrl);
	} catch {
		return true;
	}
};
