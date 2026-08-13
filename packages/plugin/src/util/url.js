import { config, onConfigApplied } from '../config.js';

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
 *  3. Apply `cacheKey.trailingSlash`: `strip` (default) drops a trailing slash on a non-root path
 *     so `/a` and `/a/` collapse; `preserve` keeps them apart. Configurable because no standard
 *     makes them one resource — it is a per-site, even per-route fact (an origin that 404s or
 *     403s the slashed form is serving a DIFFERENT answer, and stripping would have us reply on
 *     its behalf with a page it refused).
 *  4. Decode the UNRESERVED escapes — `ALPHA / DIGIT / - . _ ~`. This is RFC 3986 §6.2.2.2
 *     percent-encoding normalization: those escapes denote the same character by definition, so
 *     `/%68ello` and `/hello` are one resource for every origin that exists. It is what a CDN
 *     does, it is not configurable, and it is the only decoding this function does that needs no
 *     justification from the site.
 *  5. Decode the characters in `cacheKey.decodeReserved` (default `:` `,` `@`). Those are
 *     RESERVED, so this is a claim about how one origin parses URLs rather than a standards
 *     truth — hence configurable. The default set is the one WHATWG `new URL()` / Chrome
 *     `page.url()` emit literally in a query, so decoding it collapses the spellings that
 *     independent sources (sitemap loc, CDN-forwarded request, Chrome redirect target) produce
 *     for one logical URL. Everything STRUCTURAL — `%` `&` `=` `+` `#` `/` and the `|`
 *     delimiter — is refused by the schema, because decoding those reparses the URL into a
 *     different shape (or corrupts it).
 *  6. Upper-case the remaining percent-escape hex (`%2f`→`%2F`) — RFC 3986 §6.2.2.1.
 *  7. Percent-encode any literal `|` → `%7C` so the cache-key delimiter can never appear in
 *     the URL-half (keeps `CacheKey.parse`/`extractUrl` unambiguous with an index split).
 *
 *  8. Apply `cacheKey.plusIsSpace`: when on, `%20` folds to `+` in the QUERY, so the two
 *     spellings of a space are one key. Off by default and query-scoped, because the equivalence
 *     holds only where the origin form-decodes (`+` → space) — true of most server stacks, false
 *     of an RFC-3986 reader, and never true in a path. `%2B` is untouched either way: a literal
 *     plus inside a value is a different value, not a separator.
 *
 * What this deliberately does NOT do: collapse duplicate slashes (an empty path segment is legal
 * and a site may route on it), or decode structural escapes. Both are claims no standard supports
 * and no CDN makes by default.
 *
 * `queryParams` is the allowlist of params to keep: `['*']` keeps all, `[]` drops all,
 * `['CN']` keeps only `CN`. Callers pass the per-route allowlist (forwarded mode) or the
 * global `config.cacheKey.queryParams` (native/prefix mode); see `queryAllowlistFor` in ingress.
 *
 * `new URL(canonicalizeUrl(x)).href === canonicalizeUrl(x)` for every input, so callers may
 * build the origin-fetch / navigation URL object straight from the returned half without a
 * second normalization pass.
 */
const UNRESERVED = /[A-Za-z0-9\-._~]/;

/**
 * Rewrite every percent-escape in one pass: decode what the STANDARD says is the same URL,
 * decode the deployment's declared extras, upper-case whatever is left.
 *
 * The unreserved set (`ALPHA / DIGIT / - . _ ~`) is RFC 3986 §6.2.2.2 percent-encoding
 * normalization: those escapes are equivalent to their characters *by definition*, for every
 * origin, so `/%68ello` and `/hello` are one resource and must not be two cache keys. This is
 * the same normalization a CDN performs, and it needs no configuration because there is no
 * site for which it could be wrong.
 *
 * `%2E` needs no special case, which is worth recording because it looks like it should: the
 * fear is that decoding it manufactures a `.`/`..` segment and silently re-points the path. It
 * cannot, because WHATWG `new URL()` resolves dot segments in their ENCODED spellings too —
 * `/%2E%2E/x` and `/%2e/x` are already `/x` by the time this runs, while a `%2E` inside a longer
 * segment (`/a%2Eb`) is left alone and is safe to decode. That is RFC 3986 §6.2.2.3 (path segment
 * normalization) happening in the parser, one step ahead of §6.2.2.2 happening here.
 *
 * `extra` is the deployment's `cacheKey.decodeReserved`. Those characters are RESERVED, so
 * decoding them is a claim about how one origin parses its URLs, not a standards truth — see
 * the option's description.
 */
// Rebuilt on config apply rather than per call: this runs on the bot read path and on sitemap
// ingestion, where one allocation per URL is one allocation per million.
let decodeReserved = null;
onConfigApplied(() => {
	decodeReserved = new Set(config.cacheKey.decodeReserved);
});

const normalizeEscapes = (s, extra) =>
	s.replace(/%[0-9A-Fa-f]{2}/g, (m) => {
		const char = String.fromCharCode(parseInt(m.slice(1), 16));
		if (UNRESERVED.test(char)) return char;
		return extra.has(char) ? char : m.toUpperCase();
	});

export const canonicalizeUrl = (url, queryParams = config.cacheKey.queryParams) => {
	const parsed = url instanceof URL ? new URL(url.href) : new URL(url);
	parsed.hash = '';

	const rawQuery = parsed.search.startsWith('?') ? parsed.search.slice(1) : parsed.search;
	let query = '';
	if (rawQuery) {
		const keepAll = queryParams.includes('*');
		const keep = keepAll ? null : new Set(queryParams);
		// The fold runs BEFORE the sort, or it defeats itself: `%20` and `+` sort to different
		// positions (0x25 vs 0x2B), so folding afterwards would order two spellings of one query
		// differently and hand them different keys.
		const foldSpace = config.cacheKey.plusIsSpace;
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
		if (foldSpace) {
			for (let i = 0; i < segments.length; i++) segments[i] = segments[i].replace(/%20/gi, '+');
		}
		segments.sort();
		if (segments.length) query = `?${segments.join('&')}`;
	}

	const path =
		config.cacheKey.trailingSlash === 'strip' && parsed.pathname !== '/' && parsed.pathname.endsWith('/')
			? parsed.pathname.slice(0, -1)
			: parsed.pathname;

	// Reconstruct by hand so no serialization step re-touches the (already filtered and sorted)
	// query, then rewrite every escape in a single pass. The `??=` covers the window before the
	// first applyOptions, since this module can be imported before config is applied.
	const extra = (decodeReserved ??= new Set(config.cacheKey.decodeReserved));
	let half = normalizeEscapes(`${parsed.protocol}//${parsed.host}${path}${query}`, extra);
	half = half.replace(/\|/g, '%7C');
	return half;
};
