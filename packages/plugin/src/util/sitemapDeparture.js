import { config } from '../config.js';
import { classifyUrl, DepartureAction, PRERENDER } from './routeClass.js';

/**
 * What a URL LEAVING a sitemap means, and what to do about it.
 *
 * A refresh already unlinks a departed target (`sitemapUrl -> null`) and leaves it rendering on
 * its own cadence. That is the right default for a URL that merely stopped being declared, but on
 * a retail catalog the departure is itself a signal: a product that sells out or is withdrawn
 * leaves the product sitemap the same day, while its page keeps serving the snapshot taken when it
 * was still available. Nothing else in the pipeline notices until that page's next scheduled
 * render, which on a slow cadence can be most of a day of serving markup the origin no longer
 * agrees with.
 *
 * ── WHY THIS IS NOT SIMPLY "RETIRE IT" ───────────────────────────────────────────────────────
 *
 * Departure is a statement about the DECLARATION, not about the page. The origin typically still
 * serves the URL — 200, with out-of-stock markup — so deleting the target would throw away a page
 * bots still request and still receive a valid document for. The action here is therefore a
 * RE-CHECK, and the render's own verdict decides what happens next: a page that is merely
 * unavailable re-renders with correct markup and stays, and one the origin has actually retired
 * answers 404/410 and is retired by `Target.suppress` — which, now that the target is unlinked,
 * happens on the first verdict (see util/suppression.js).
 *
 * ── WHY IT IS PER ROUTE ───────────────────────────────────────────────────────────────────────
 *
 * Only some URL classes carry that meaning. A product URL leaving a product sitemap says something
 * about that product; a listing or category URL leaving a paginated sitemap usually says the
 * catalog was re-bucketed, and acting on it would expire pages that are perfectly current. So the
 * action is opt-in per route entry (`departureAction`), and defaults to doing nothing.
 *
 * ── WHY THE CHECK RUNS AFTER THE WHOLE WALK ──────────────────────────────────────────────────
 *
 * A paginated corpus shears across child boundaries. Children are walked in order, so a URL that
 * moves to an EARLIER child is re-attached before the child it left is pruned and never looks
 * departed — but a URL that moves to a LATER child is pruned first and looks departed until the
 * child that now claims it is reached. Acting at prune time would therefore fire on every URL that
 * shifted forward, which on a fixed-size paginated sitemap is every URL after an insertion.
 * Candidates are collected during the walk and re-read once it has finished; anything that picked
 * up an attribution in the meantime is dropped. That is also why this cannot be folded into
 * `reconcileSitemapEntries`.
 */

// Re-exported so callers reason about departures through one module rather than reaching into the
// route compiler for the enum. It is DEFINED in routeClass.js because that is what validates the
// route field, and one definition is what keeps the validator and the consumers spelling it alike.
export { DepartureAction };

/**
 * The action a route declares for URLs that leave a sitemap.
 *
 * Prerender routes only — a passthrough or unclassified URL owns no page to expire and no
 * schedule to advance. The field is already normalized to a valid action (or `none`) by
 * `compileEntry`, which drops and warns about a bad value rather than rejecting the route, so a
 * typo in one route entry costs that route its departure check and not a refresh of a million URLs.
 */
export const departureActionFor = (url) => {
	if (!config.sitemap.departure.enabled) return DepartureAction.NONE;

	const { routeClass, entry } = classifyUrl(url);
	if (routeClass !== PRERENDER || !entry) return DepartureAction.NONE;

	return entry.departureAction ?? DepartureAction.NONE;
};

/**
 * Decide one candidate, given what the post-walk re-read found.
 *
 * Pure, so the whole decision table is testable without a database — the caller does the reads and
 * the writes. `null` means "do nothing", and every skip is a named reason so a dry run can report
 * WHY a departure was not acted on rather than just omitting it.
 *
 * @param {object} candidate
 * @param {string} candidate.url
 * @param {object|null} candidate.target  the target as re-read AFTER the walk, or null if absent
 * @returns {{ action: string, reason: string }}
 */
export const decideDeparture = ({ url, target }) => {
	// Retired between the prune and now — by the gone path, an operator, or a purge. Nothing to do.
	if (!target) return { action: DepartureAction.NONE, reason: 'target-gone' };

	// Re-attached later in the same walk: it moved between children rather than leaving. This is
	// the boundary-shear guard and it is the single most important line in this module.
	if (target.sitemapUrl) return { action: DepartureAction.NONE, reason: 'reattached' };

	// A suppressed target has no cached pages to expire and owns a recheck cadence of its own;
	// filing it due now would fight that schedule and re-prove a verdict it already holds.
	if (target.state === 'suppressed') return { action: DepartureAction.NONE, reason: 'suppressed' };

	const action = departureActionFor(url);
	return { action, reason: action === DepartureAction.NONE ? 'route-opted-out' : 'departed' };
};
