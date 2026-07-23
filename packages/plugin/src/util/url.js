import { config } from '../config.js';

/**
 * Build the canonical URL-half of a cache key.
 *
 * There is exactly ONE normalization for the whole flow (sitemap ingest, bot-read lookup,
 * discovery, redirect re-key, and — mirrored byte-for-byte — the browser's redirect
 * detection). Given the same `(url, queryParams)` it MUST return the same string at every
 * stage; that invariant is what makes a rendered page findable. The exact bytes are a free
 * choice, but the rules are fixed below and pinned by the shared test vector at repo root
 * (`test-vectors/canonicalize-url.json`), asserted by both the plugin and browser suites so
 * this JS copy and the browser's TS copy cannot drift.
 *
 * Rules:
 *  1. Parse with WHATWG `new URL()` and drop the hash.
 *  2. Filter + sort the query on the RAW query string — NOT via `URLSearchParams`. The
 *     form-urlencoded serializer `URLSearchParams` uses collapses `+` and `%20` both to a
 *     space and re-emits every space as `+`, which destroys faceted-query grammars where
 *     `+` is a value SEPARATOR and `%20` a literal space. Splitting the raw query keeps
 *     each value byte-for-byte, so the key stays losslessly navigable.
 *  3. Drop a trailing slash on a non-root path so `/a` and `/a/` collapse.
 *  4. Decode the pure-DATA sub-delimiters `%3A→:`, `%2C→,`, `%40→@`. These are generic
 *     RFC-3986 sub-delimiters (not app-specific) that WHATWG `new URL()` / Chrome `page.url()`
 *     already emit LITERALLY in a query — so decoding them collapses the encoding variants
 *     that independent sources (sitemap loc, CDN-forwarded request, Chrome redirect target)
 *     produce for one logical URL into a single key. Everything STRUCTURAL — `%` `&` `=` `;`
 *     `+` `#` `/` and the `|` delimiter — must stay encoded, or the URL reparses into a
 *     different shape (or corrupts). That's why this is a small allowlist, not a blanket decode.
 *  5. Upper-case the remaining percent-escape hex (`%2f`→`%2F`) for a stable form.
 *  6. Percent-encode any literal `|` → `%7C` so the cache-key delimiter can never appear in
 *     the URL-half (keeps `CacheKey.parse`/`extractUrl` unambiguous with an index split).
 *
 * `queryParams` is the allowlist of params to keep: `['*']` keeps all, `[]` drops all,
 * `['CN']` keeps only `CN`. Callers pass the per-route allowlist (forwarded mode) or the
 * global `config.url.queryParams` (native/prefix mode); see `queryAllowlistFor` in ingress.
 *
 * `new URL(canonicalizeUrl(x)).href === canonicalizeUrl(x)` for every input, so callers may
 * build the origin-fetch / navigation URL object straight from the returned half without a
 * second normalization pass.
 */
const FIXED_DECODE = { '%3a': ':', '%2c': ',', '%40': '@' };

export const canonicalizeUrl = (url, queryParams = config.url.queryParams) => {
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
			// Decode ONLY the key for the membership test; the value stays byte-verbatim.
			const rawKey = seg.split('=')[0];
			let key;
			try {
				key = decodeURIComponent(rawKey);
			} catch {
				key = rawKey;
			}
			return keep.has(key);
		});
		segments.sort();
		if (segments.length) query = `?${segments.join('&')}`;
	}

	const path =
		parsed.pathname !== '/' && parsed.pathname.endsWith('/') ? parsed.pathname.slice(0, -1) : parsed.pathname;

	// Reconstruct by hand so no serialization step re-touches the (raw) query.
	let half = `${parsed.protocol}//${parsed.host}${path}${query}`;
	half = half.replace(/%(?:3a|2c|40)/gi, (m) => FIXED_DECODE[m.toLowerCase()]);
	half = half.replace(/%[0-9a-f]{2}/gi, (m) => m.toUpperCase());
	half = half.replace(/\|/g, '%7C');
	return half;
};
