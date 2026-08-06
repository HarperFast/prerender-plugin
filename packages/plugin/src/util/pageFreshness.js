/**
 * The ONE definition of whether a cached page is servable, and under which status. Every
 * consumer — the bot serve path, the admin explain/pages views — must call this rather than
 * re-deriving the comparison, so the admin can never disagree with what a bot actually gets,
 * and a future change (per-route swrTtl) lands everywhere at once.
 */

/**
 * Can this cached page be served, and under which status? 'hit' = within the page's own
 * renderInterval (expiresAt is still ahead); 'swr' = past expiresAt but inside the
 * stale-while-revalidate window (the re-render is late or still in flight); null = not
 * servable from cache (stale/miss — fall through to the miss mode). The serve is identical
 * either way; the split exists because folding both into 'hit' made the headline hit rate
 * unreadable as a freshness signal: at one measured point 71.9% "hit" quietly included ~13%
 * of the corpus being served past expiry. A NaN expiresAtMs fails both comparisons => null.
 */
export function cacheServeStatus(expiresAtMs, swrTtl, now) {
	if (expiresAtMs > now) return 'hit';
	if (expiresAtMs + swrTtl > now) return 'swr';
	return null;
}
