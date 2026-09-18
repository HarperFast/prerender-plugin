import { config } from '../config.js';
import { epochMsOf } from './time.js';

/**
 * Whether one sitemap document can be fetched CONDITIONALLY, and with what validator.
 *
 * Lives here rather than in `resources/Sitemap.js` for the usual reason: that module subclasses a
 * table at import time and cannot be loaded without a live Harper, so a decision left inside it is
 * untestable.
 *
 * ── WHY `Last-Modified` AND NOT `ETag` ───────────────────────────────────────────────────────
 *
 * Measured against a production edge: `If-Modified-Since` returned a clean 304 with no body, while
 * `If-None-Match` — sent back with the exact ETag that same edge had just served — returned 200 and
 * the full multi-megabyte document. An origin that advertises a validator is not promising to
 * honour it, and an ETag-based conditional fetch fails in the worst possible way: it looks correct,
 * returns 200 every time, and silently re-transfers the whole corpus on every pass. Hence the stored
 * validator is the `Last-Modified` string, echoed back verbatim.
 *
 * ── WHAT A 304 SKIPS, AND WHY THAT IS THE POINT ──────────────────────────────────────────────
 *
 * Not just the download. A pass scans the `sitemapUrl` index once per child, and that prune scan
 * holds a read cursor whose seconds scale linearly with refresh frequency — it is the cost that
 * decides how often a corpus can afford to be refreshed. A 304 skips the body, the parse, the scan
 * and every write, so an unchanged pass costs one request per document and no database work.
 */
export const conditionalValidatorFor = (stored, revalidate) => {
	const { enabled, fullPassInterval } = config.sitemap.conditional;
	if (!enabled || revalidate) return null;

	// No validator: first walk of this document, or an origin that sends none. Conditional
	// fetching degrades to unconditional rather than to broken.
	if (!stored?.lastModified) return null;

	// THE REPAIR NET. A 304 skips the reconcile, and the reconcile is also what re-CREATES targets
	// lost to anything else — a bad purge, a half-applied delete, a botched migration. Without a
	// periodic unconditional pass a corpus could drift for as long as the origin left its sitemaps
	// untouched, with nothing noticing. `lastRefreshed` means "entries last INGESTED" precisely so
	// it can be measured against here; a 304 deliberately does not update it.
	//
	// Written as `!(elapsed < interval)` rather than `elapsed >= interval` so that a NaN — an
	// unreadable or absent date — takes the unconditional branch instead of silently reading as
	// "ingested at the epoch" or, worse, passing the comparison.
	if (!(Date.now() - epochMsOf(stored.lastRefreshed) < fullPassInterval)) return null;

	return stored.lastModified;
};
