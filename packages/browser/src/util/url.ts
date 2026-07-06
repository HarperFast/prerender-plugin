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
export const normalizeUrlForCompare = (url: string | URL): string => {
	const parsed = new URL(url);
	parsed.searchParams.sort();
	return decodeURI(parsed.href);
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
	return decodeURI(parsed.href);
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
