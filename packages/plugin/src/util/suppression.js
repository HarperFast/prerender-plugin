import { config } from '../config.js';

/**
 * Grading a non-indexable verdict: which knob set it answers to, what gets stored as its reason,
 * and how many consecutive verdicts it takes before the target is retired outright.
 *
 * Pure (config-reading, like `util/failureBackoff.js`), so the decision is unit-testable — unlike
 * `Target.suppress`, which subclasses a table at import time and cannot be loaded without a live
 * Harper.
 */

/** The origin's two "this page does not exist" answers. */
const GONE_STATUSES = new Set([404, 410]);

/**
 * Only an http-error verdict classifies by status: a noindex/canonical verdict came from a
 * document that rendered, so its status is not the statement being made.
 */
export const isGoneVerdict = (reason, statusCode) => reason === 'http-error' && GONE_STATUSES.has(statusCode);

/**
 * WHY THE CEILING DEPENDS ON SITEMAP ATTRIBUTION, AND WHY ONLY FOR `gone`.
 *
 * `maxStrikes` exists because a suppressed row is cheap and re-discovery is not: the row IS the
 * verdict memory that stops the URL being re-created, and deleting it hands that job back to
 * whatever created the target in the first place. Who that is differs, and it is the whole
 * argument:
 *
 *   - NO SITEMAP ATTRIBUTION — nothing re-creates it. Discovery mints a target only on a 200 from
 *     the origin (`maybeSchedule` in http_handlers/bot_request.js checks the status, and
 *     `isPrerenderCandidate` checks it again), so a URL the origin answers 404/410 for cannot be
 *     re-minted by a crawler hit. Retiring it is terminal, which is exactly what makes retiring it
 *     on the FIRST verdict safe: the alternative is a row plus a schedule row plus a recheck
 *     render, forever, for a URL nothing will ask about again.
 *
 *   - SITEMAP-ATTRIBUTED — the refresh re-creates it, on every pass. `actionForExisting`
 *     (util/sitemapRun.js) returns CREATE for an absent target, and a suppressed target is SKIPped
 *     because its attribution is already correct. So the suppressed row is the ONLY thing holding
 *     the walk off, and deleting one trades a recheck every `gone.recheckInterval` for a fresh
 *     render every `sitemap.refreshInterval` — on a 6h interval against a 14d recheck, ~28x MORE
 *     render work, not less. These keep counting strikes.
 *
 * AND ONLY FOR `gone`: a noindex or canonical-mismatch verdict comes from a page the origin serves
 * 200 for, so discovery re-mints it the moment a bot asks — a `<meta name="robots">` noindex is not
 * even visible to `isCandidateFromHeaders`, which reads headers. Retiring those on sight would loop
 * exactly the way the sitemap case does. The unlisted ceiling is therefore scoped to the one verdict
 * class whose own status blocks re-creation.
 *
 * @param {object} verdict
 * @param {string} [verdict.reason]      the renderer's reason ('http-error', 'noindex', …)
 * @param {number} [verdict.statusCode]  status behind an http-error verdict
 * @param {boolean} verdict.fromSitemap  whether the target is currently attributed to a sitemap
 * @returns {{ gone: boolean, storedReason: string|null, recheckInterval: number, maxStrikes: number }}
 */
export function gradeSuppression({ reason, statusCode, fromSitemap }) {
	const gone = isGoneVerdict(reason, statusCode);
	const knobs = gone ? config.render.suppression.gone : config.render.suppression;

	return {
		gone,
		// Stored as `http-gone` so the registry distinguishes "page vanished" from "page errored".
		storedReason: gone ? 'http-gone' : (reason ?? null),
		recheckInterval: knobs.recheckInterval,
		maxStrikes: gone && !fromSitemap ? knobs.maxStrikesUnlisted : knobs.maxStrikes,
	};
}
