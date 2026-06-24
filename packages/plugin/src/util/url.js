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
