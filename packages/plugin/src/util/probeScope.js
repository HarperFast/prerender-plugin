import { dateColumnMs } from './time.js';

/**
 * WHICH TARGETS THE CHANGE PROBE WATCHES (`changeProbe.scope`).
 *
 * The sweep walks every owned target and spends one origin request on each one a rule matches. On a
 * catalog whose product sitemap is its availability feed, a large share of those are products that
 * LEFT the sitemap — measured at ~25% of probed product targets on one deployment — and for those the
 * sitemap-departure check (`departureAction: render`) has already expired and re-rendered the page on
 * the way out. Probing that long tail every night buys little and costs the origin a request per URL.
 *
 *   all     — every owned, rule-matched target (the behaviour before this option existed).
 *   listed  — only a target a sitemap lists now (`sitemapUrl`), or one a walk unlinked within
 *             `unlistedGrace` (`Target.unlistedAt`). Never-listed targets (discovered from traffic),
 *             targets unlinked longer ago, and targets unlinked before the stamp existed are skipped.
 *
 * The grace is what makes the transition safe rather than abrupt: a URL briefly missing from one walk
 * (a truncated child sitemap, an origin rebuilding its sitemaps) keeps being watched while later walks
 * decide whether it really left, and a real departure is still probed while its re-render lands.
 *
 * A FAILED walk cannot shrink the scope: the prune runs only after a child is fetched and parsed, a
 * root that fails aborts before any prune, a failing child is skipped, and an empty urlset is never
 * reconciled. What can is a child that parses but is TRUNCATED, and stays truncated past the grace —
 * the same event `sitemap.departure.maxActions` guards against, and one that shows up first as a
 * `sitemap_removed` spike and in the departure tally.
 *
 * Pure, and kept out of util/changeProbe.js on purpose: the selection is the whole feature on the probe
 * side, and it is testable without the probe's I/O.
 */

export const ProbeScope = Object.freeze({ ALL: 'all', LISTED: 'listed' });

/**
 * Is this target inside the `listed` scope at `nowMs`?
 *
 * Listed wins outright, whatever the stamp says: a stale `unlistedAt` on an attributed row can only
 * come from a write outside the walk, and the attribution is the fact that matters. An unreadable or
 * absent stamp reads as never listed. A stamp in the FUTURE (a walk on a node whose clock runs ahead)
 * reads as recent — the direction that keeps probing. A grace of 0 is exactly "listed only".
 */
export const inListedScope = (row, { unlistedGrace, nowMs }) => {
	if (row?.sitemapUrl) return true;
	if (!(unlistedGrace > 0)) return false;
	const unlistedAt = dateColumnMs(row?.unlistedAt);
	return Number.isFinite(unlistedAt) && nowMs - unlistedAt < unlistedGrace;
};

/**
 * The row predicate a pass filters with, or `null` for `all`.
 *
 * `null` rather than a predicate that always answers true, so the default pass never calls anything per
 * row and its counters are exactly the pre-option ones. The clock is read per row: a paced pass runs
 * for hours, and a grace judged against its start would keep probing targets that aged out mid-pass.
 *
 * @param {{ scope?: string, unlistedGrace?: number }} options  `config.changeProbe`
 * @param {() => number} [now]
 * @returns {((row: object) => boolean) | null}
 */
export const probeScopeFilter = ({ scope, unlistedGrace } = {}, now = Date.now) =>
	scope === ProbeScope.LISTED ? (row) => inListedScope(row, { unlistedGrace, nowMs: now() }) : null;
