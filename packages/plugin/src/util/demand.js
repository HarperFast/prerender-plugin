/**
 * THE DEMAND TRACKER'S ANSWER for one URL: how often bots ask for it — a measurement, never a
 * decision. Consumers decide what demand is worth, each with its own settings: the cadence ladder
 * (util/demandLadder.js, `render.demand`) and the order changed pages render in
 * (`queue.ready.changedDemand`, util/renderPriority.js).
 *
 * ── WHAT IT MEASURES ──────────────────────────────────────────────────────────────────────────
 *
 * The visit ring (util/visitFilter.js) holds one Bloom slice per `demand.sliceMs`. A URL's LEVEL is
 * the number of slices in which a counted bot visited it, 0..`demand.slices`, and its estimated
 * visit PERIOD is the window those slices cover divided by that count:
 *
 *     16 of 16 slices (6h each)  ->  a visit every  6h or more often
 *      4 of 16                   ->  about one every 24h
 *      1 of 16                   ->  about one in the 4 days
 *      0 of 16                   ->  none in 4 days: the period is AT LEAST the window, reported as it
 *
 * ── WHAT IT CANNOT SEE ────────────────────────────────────────────────────────────────────────
 *
 * PRESENCE IS PER SLICE, so resolution is capped at one slice: a page asked for once in six hours
 * and one asked for every minute both read 16 of 16. What the level orders well is the long tail —
 * the difference between daily and twice-weekly — which is where a catalog's pages actually are.
 *
 * FALSE POSITIVES ONLY ADD DEMAND. A Bloom slice answers "maybe" for a URL it never saw at `fill^k`,
 * so a URL nobody visits reads about `slices x fill^k` slices of noise. While that noise is small it
 * sits under one real visit and the ordering holds; past `demand.maxFalsePositive` it does not, and
 * the answer is UNKNOWN rather than a number noise dominates. Measured on one deployment at 0.91
 * fill and k = 7 (a ~53% false-positive rate), an unvisited page would read 8 of 16 — a visit every
 * 12 hours that nobody made.
 *
 * UNKNOWN is also the answer while the tracker is off, while the union has not loaded, and when no
 * slot has any history yet. A consumer given UNKNOWN does what it did before demand existed.
 *
 * Cost: a membership test per covered slot (k byte reads each) against an in-memory union. No
 * storage touch, no await.
 */

import { config } from '../config.js';
import { visitedSlots, mergedWarm, ensureMerged, awaitMerged, unionHealth } from './visitFilter.js';

const unknown = (reason) => ({ known: false, reason, level: null, slots: null, windowMs: null, periodMs: null });

/**
 * `{ known, reason, level, slots, windowMs, periodMs }` for `url`.
 *
 * `level` is the slots with a visit, `slots` the slots the union could answer for (fewer than
 * `demand.slices` for a tracker with less history than the ring), `windowMs` their span, and
 * `periodMs` the estimated time between visits: `windowMs / level`, or `windowMs` itself for a URL
 * with no visit in the window (a lower bound — the page may never be asked for at all). Periods are
 * whole-slot fractions of the window, so they take at most `slices` distinct values per window.
 *
 * `reason` says why an answer is unknown: `off`, `cold` (no union, or no history), `saturated`.
 */
export const demandOf = (url, nowMs = Date.now()) => {
	if (!config.demand.enabled) return unknown('off');
	if (!mergedWarm()) {
		ensureMerged(nowMs);
		return unknown('cold');
	}
	const { level, covered } = visitedSlots(url, nowMs);
	if (!covered) return unknown('cold');
	if (unionHealth().worstFalsePositive > config.demand.maxFalsePositive) return unknown('saturated');
	const windowMs = covered * config.demand.sliceMs;
	return {
		known: true,
		reason: null,
		level,
		slots: covered,
		windowMs,
		periodMs: level > 0 ? Math.round(windowMs / level) : windowMs,
	};
};

/**
 * Load the union before a run of questions (a probe pass), so the first answers are not `cold`.
 * Never throws: a failed refresh just leaves the answers unknown.
 */
export const warmDemand = async () => {
	if (!config.demand.enabled) return;
	try {
		await awaitMerged();
	} catch {
		// logged by the refresh itself
	}
};

/** What the tracker can say right now, for the management API. */
export const demandStatus = () => {
	const { newestFill, worstFill, worstFalsePositive } = unionHealth();
	const enabled = config.demand.enabled;
	const warm = mergedWarm();
	return {
		enabled,
		warm,
		newestFill,
		worstFill,
		worstFalsePositive,
		maxFalsePositive: config.demand.maxFalsePositive,
		saturated: enabled && warm && worstFalsePositive > config.demand.maxFalsePositive,
	};
};
