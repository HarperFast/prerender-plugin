import { config } from '../config.js';
import { MINUTE } from './time.js';

/**
 * How long a failing key waits before it is due again, once it has exhausted the fast-retry lane.
 *
 * Priority here is expressed ENTIRELY as a due time. `claim` orders by `nextRenderTime` and nothing
 * else, so "deprioritize this" and "make it due later" are the same statement — which is why none of
 * this needs a priority column or a second index. `fromSitemap` is already denormalized onto the
 * schedule row, so the caller has it without an extra read.
 *
 * @param {number} interval  the target's normal cadence (ms), already route-resolved
 * @param {number} strikes   the strike this failure just recorded (> fastRetries here)
 * @param {boolean} fromSitemap  whether the target came from a sitemap
 * @returns {number} ms to wait
 */
export function backoffWait(interval, strikes, fromSitemap) {
	const { fastRetries, backoffFactor, maxBackoff, nonSitemapPenalty } = config.render.failureRetry;

	// First escalation (the strike right after the fast lane) waits exactly one interval, matching
	// the pre-0.37.0 behaviour; each strike after that multiplies. The non-sitemap penalty rides
	// the same curve rather than being a flat multiplier: EVERY target — sitemap or not — gets one
	// honest retry at its normal cadence, and only a target that fails again is deprioritized.
	// A flat penalty would push a discovered URL's very first slow retry out by 4x on the strength
	// of a single failure, which is a verdict the first failure has not earned.
	const escalations = Math.max(0, strikes - fastRetries - 1);
	const penalty = fromSitemap || escalations === 0 ? 1 : nonSitemapPenalty;
	const capped = Math.min(interval * backoffFactor ** escalations * penalty, maxBackoff);

	// `nextRenderTime` is a `Long @indexed` and the claim floor compares WHOLE MINUTES (`minuteOf`
	// in util/renderSchedule.js), so a fractional wait — which a float-valued `backoffFactor` or
	// `nonSitemapPenalty` produces, both being `min: 1` with no integer constraint — has no
	// business reaching the row. Floor to a whole minute so the value is an integer AND aligned
	// like every other schedule write; flooring (not rounding) also keeps it under `maxBackoff`.
	//
	// THE OTHER TRAP: `maxBackoff` is a ceiling on the BACKOFF, and a ceiling below the target's
	// own cadence would make a persistently failing page come due MORE often than a healthy one (a
	// 48h PDP against a 24h ceiling). The cadence is the floor; the ceiling only pushes further
	// out. It is applied last, and rounded, because `interval` itself need not be minute-aligned.
	return Math.max(Math.round(interval), Math.floor(capped / MINUTE) * MINUTE);
}
