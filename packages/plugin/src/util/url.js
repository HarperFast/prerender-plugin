import { config } from '../config.js';

/**
 * Normalize a URL for cache-key construction: drop the hash, apply the configured
 * query-parameter allowlist (`config.url.queryParams`), and sort the surviving
 * params for a stable key.
 *
 *   ['page']  keep only `?page=`
 *   ['*']     keep all query params
 *   []        drop all query params
 *
 * `queryParams` defaults to the global `config.url.queryParams` policy; callers
 * (e.g. forwarded-mode routes) may pass a per-request allowlist to override it.
 */
export const normalizeUrl = (url, returnObject = false, queryParams = config.url.queryParams) => {
	const parsed = new URL(url);
	parsed.hash = '';

	const policy = queryParams;
	if (!policy.includes('*')) {
		const keep = new Set(policy);
		// Iterate distinct keys (a key may repeat); delete() removes all of its values.
		for (const key of new Set(parsed.searchParams.keys())) {
			if (!keep.has(key)) parsed.searchParams.delete(key);
		}
	}
	parsed.searchParams.sort();

	return returnObject ? parsed : parsed.href;
};

/**
 * The cache-key form of an ALREADY-NORMALIZED URL: presents `:` decoded so keys read like
 * the canonical/sitemap form (`?CN=Gender:Mens`) instead of the form-encoded `%3A`.
 *
 * This is a pure encoding transform — it does NOT re-apply the query allowlist or re-sort.
 * The caller must pass an already-normalized URL (from `normalizeUrl` or the forwarded-mode
 * ingress resolution), because in forwarded mode that normalization used the per-ROUTE
 * allowlist, which this function can't know — re-normalizing here with the global policy
 * would wrongly drop route params like `CN`.
 *
 * Decodes only query-legal, non-separator characters — `:` (facets), `,` (lists), `@` — so
 * `:` and `%3A` (etc.) address the same resource and the keys read like the canonical. Anything
 * structural stays encoded (`&`/`=`/`+`/`#`, and `;` which some parsers treat as a separator),
 * so the URL can't reparse into a different shape. (Edit `DECODE` to change the policy in one
 * place — every cache-key site calls this.)
 */
const DECODE = { '%3a': ':', '%2c': ',', '%40': '@' };
export const cacheKeyUrl = (url) => {
	const href = typeof url === 'string' ? url : (url?.href ?? String(url));
	return href.replace(/%(?:3a|2c|40)/gi, (m) => DECODE[m.toLowerCase()]);
};
