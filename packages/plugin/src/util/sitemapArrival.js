import { config } from '../config.js';
import { anyRouteArrives, ArrivalAction, classifyUrl, PRERENDER } from './routeClass.js';
import { departureLimit } from './sitemapDeparture.js';
import { dateColumnMs } from './time.js';

/**
 * What a URL REJOINING a sitemap means, and what to do about it — the other half of
 * util/sitemapDeparture.js.
 *
 * On a catalog whose product sitemap is its availability feed, a product leaves the sitemap the day
 * it sells out and comes back the day it is restocked. The departure check already re-renders the
 * page on the way out, so what is cached for it is the OUT-OF-STOCK snapshot. When the product
 * rejoins, the walk re-attributes the target and nothing else notices: that snapshot keeps serving
 * until the page's next cadence render, which on a slow cadence is most of a day of telling bots an
 * available product is unavailable. `arrivalAction: render` on the route files it to render now.
 *
 * ── TELLING A REJOIN FROM SHEAR ──────────────────────────────────────────────────────────────
 *
 * A paginated corpus shears across child boundaries (see sitemapDeparture.js): a URL that moves to
 * a LATER child is unlinked by the child it left and re-attached by the child that now claims it,
 * inside ONE walk. Seen from the re-attach alone that is indistinguishable from a rejoin, and acting
 * on it would render every URL that shifted forward.
 *
 * `Target.unlistedAt` is what tells them apart. The prune stamps it with THE START OF THE WALK doing
 * the unlinking — not the prune's own clock — so a same-walk unlink carries exactly this walk's
 * start, and "unlinked before this walk began" is an exact comparison rather than a race against the
 * clock. Only a stamp from an EARLIER walk is a rejoin (`isRejoin`). That also means, unlike a
 * departure, a rejoin is decided at re-attach time without waiting for the walk to finish — but it is
 * still ACTED on after the walk, by the same executor as departures, so both checks share one set of
 * caps, one dry-run shape and one tally.
 *
 * ── WHAT IT DOES NOT SEE ─────────────────────────────────────────────────────────────────────
 *
 *  - Targets unlinked before the stamp existed (v0.89.0) carry none, so their rejoin is invisible
 *    and they re-render on their cadence exactly as before. A discovered target a sitemap lists for
 *    the first time carries none either, which is correct: it never left anything.
 *  - A URL that moves between two ROOT sitemaps walked in sequence looks like a departure in the
 *    first walk and a rejoin in the second — each root is its own walk. The departure check has the
 *    same limitation; the cost is one extra render per such URL, inside the caps.
 *  - A `revalidate: true` walk files every listed URL due now without reading the target, so it
 *    detects nothing — and needs to detect nothing.
 *
 * ── WHY A CAPPED ARRIVAL IS GONE FOR GOOD ─────────────────────────────────────────────────────
 *
 * The re-attach clears `unlistedAt` in the same patch that restores the attribution, so the next
 * walk sees an ordinary listed target. A rejoin past either ceiling keeps its target, its attribution
 * and its cadence; it just never gets its route's arrival action. Same shape, and the same reason, as
 * a capped departure.
 */

// Re-exported for the same reason sitemapDeparture.js re-exports its enum: one module to reason
// through, one definition (in routeClass.js, which validates the route field).
export { ArrivalAction };

/**
 * How many rejoined URLs one walk may hold for the post-walk action. Zero unless the check is on AND
 * some route opts in — so the walk's `addArrival` does nothing for every deployment that has not asked
 * for this — and Infinity for `maxCandidates: -1`. Resolved once per walk.
 */
export const arrivalCandidateCap = () =>
	config.sitemap.arrival.enabled && anyRouteArrives() ? departureLimit(config.sitemap.arrival.maxCandidates) : 0;

/**
 * Is re-attaching this target a REJOIN — did an earlier walk unlink it?
 *
 * `existing` is the row the walk's point read returned (`sitemapUrl`, `unlistedAt`). A target that is
 * still attributed somewhere is moving between sitemaps, not rejoining, whatever its stamp says; one
 * with no stamp was never unlinked by a walk that recorded it. And a stamp equal to this walk's start
 * is this walk's own prune — the shear case — which is why the comparison is strict.
 *
 * @param {{ sitemapUrl?: string|null, unlistedAt?: unknown }|null|undefined} existing
 * @param {number} walkStartedAt  epoch ms — the same value this walk's prune stamps
 */
export const isRejoin = (existing, walkStartedAt) => {
	if (!existing || existing.sitemapUrl) return false;
	const unlistedAt = dateColumnMs(existing.unlistedAt);
	return Number.isFinite(unlistedAt) && unlistedAt < walkStartedAt;
};

/**
 * The action a route declares for URLs that rejoin a sitemap. Prerender routes only, and the field is
 * already normalized by `compileEntry` — see `departureActionFor`, which this mirrors.
 */
export const arrivalActionFor = (url) => {
	if (!config.sitemap.arrival.enabled) return ArrivalAction.NONE;

	const { routeClass, entry } = classifyUrl(url);
	if (routeClass !== PRERENDER || !entry) return ArrivalAction.NONE;

	return entry.arrivalAction ?? ArrivalAction.NONE;
};

/**
 * Decide one rejoined candidate, given what the post-walk re-read found. Pure, like
 * `decideDeparture`; every skip is a named reason so a dry run can say why.
 *
 * The rejoin itself was established during the walk (`isRejoin`) — by now the re-attach has cleared
 * the stamp — so this only re-checks what could have changed since.
 *
 * @param {object} candidate
 * @param {string} candidate.url
 * @param {object|null} candidate.target  the target as re-read AFTER the walk, or null if absent
 * @returns {{ action: string, reason: string }}
 */
export const decideArrival = ({ url, target }) => {
	// Retired between the re-attach and now — by the gone path, an operator, or a purge.
	if (!target) return { action: ArrivalAction.NONE, reason: 'target-gone' };

	// Unlinked again before the walk ended (a concurrent walk of another root, or an operator). It is
	// not listed, so it is not an arrival any more.
	if (!target.sitemapUrl) return { action: ArrivalAction.NONE, reason: 'unlinked' };

	// Suppression owns a suppressed target's schedule — the same reason `decideDeparture` skips it.
	if (target.state === 'suppressed') return { action: ArrivalAction.NONE, reason: 'suppressed' };

	const action = arrivalActionFor(url);
	return { action, reason: action === ArrivalAction.NONE ? 'route-opted-out' : 'rejoined' };
};
