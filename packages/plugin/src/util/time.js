import { config } from '../config.js';
import { fnv1a32 } from './hash.js';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const currentMinuteMs = (ts = Date.now()) => Math.floor(ts / MINUTE) * MINUTE;

/**
 * Epoch milliseconds from a Harper `Date` column, or `NaN` when there isn't one.
 *
 * A Date column does not arrive in one predictable shape: it can be a `Date`, an epoch number,
 * or an ISO string depending on how the row was written and whether it crossed a serialization
 * boundary. `Number(value)` handles only the second and yields `NaN` for an ISO string, while
 * `new Date(value)` handles all three.
 *
 * The empty check is not decoration: `new Date(null).getTime()` is 0, not `NaN`, so a missing
 * column would otherwise read as 1970 — an infinitely old timestamp — rather than as absent.
 * Callers comparing an age against a staleness threshold get the opposite answer from the one
 * they want.
 */
export const epochMsOf = (value) => (value || value === 0 ? new Date(value).getTime() : Number.NaN);

/**
 * A NUMERIC column as a number, or `NaN` when the column is absent — the guard every reader of
 * `nextRenderTime` (and of any other numeric column) needs before comparing it to anything.
 *
 * IT REJECTS `null`/`undefined` EXPLICITLY, and that is the entire reason it exists: `Number(null)`
 * is `0`, and `0` is finite, so a bare `Number.isFinite(Number(x))` accepts a MISSING value as the
 * epoch — the most plausible-looking wrong answer available. On the claim-floor paths that has real
 * teeth. A null due time reaching `lowerFloorFor` drives the floor to 0, which is "no floor", so the
 * scan silently goes back to seeking the absolute index minimum — the degraded 6.25 ms seek the floor
 * exists to remove, with no warning because 0 passed the finite check. In the backlog snapshot the
 * same null counts the row as below-floor with an oldest of 1970, falsifying the one alarm that
 * reports that failure mode.
 *
 * A REAL `0` IS STILL ACCEPTED, deliberately. A due time at or before the epoch minute is a
 * legitimate value with a defined meaning here — the documented `nextRenderTime = 1` priority trick,
 * or a junk `PUT` — and it unbounds the floor ON PURPOSE. Only the ABSENCE of a value is the bug, so
 * only absence is rejected.
 *
 * Distinct from `epochMsOf` above, which is for genuinely `Date`-typed columns and has to round-trip
 * through `new Date` to accept an ISO string. This one never allocates, because it runs once per
 * scanned row on the claim path and once per row of a 20,000-row backlog sweep.
 *
 * IT IS NOT A BigInt DEFENCE, and should not be described as one. A `Long` in a Harper schema is a
 * 52-bit integer, so it always arrives as a JS number and `Number.isFinite` on one is safe by itself.
 */
export const numberOf = (value) => (value === null || value === undefined ? Number.NaN : Number(value));

export const hrToMs = (numHours) => Math.floor(numHours * HOUR);

const parseTimeOfDay = (timeStr) => {
	const [h, m] = String(timeStr).split(':');
	const hours = Number.parseInt(h, 10);
	const minutes = Number.parseInt(m ?? '0', 10);
	return {
		hours: Number.isFinite(hours) ? hours : 0,
		minutes: Number.isFinite(minutes) ? minutes : 0,
	};
};

/**
 * Returns the next occurrence (epoch ms, floored to the minute) of `timeStr`
 * ("HH:MM") in the given IANA `timezone`. DST-aware: the offset is recomputed at
 * the target instant.
 */
export const getNextTimeOfDay = (timeStr, timezone) => {
	const { hours, minutes } = parseTimeOfDay(timeStr);

	const now = new Date();
	const tzNow = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
	const offset = now.getTime() - tzNow.getTime();

	tzNow.setHours(hours, minutes, 0, 0);

	// If the target time has already passed today (in the target tz), go to tomorrow.
	if (tzNow.getTime() + offset <= now.getTime()) tzNow.setDate(tzNow.getDate() + 1);

	// Recompute the offset at the target instant to handle DST transitions.
	const target = new Date(tzNow.getTime() + offset);
	const tzTarget = new Date(target.toLocaleString('en-US', { timeZone: timezone }));
	const targetOffset = target.getTime() - tzTarget.getTime();

	return currentMinuteMs(tzNow.getTime() + targetOffset);
};

/**
 * The jitter offset is seeded off the URL half of a cache key, NOT the whole key, so every
 * device-type variant of one URL lands on the SAME minute. Seeded off the full key, `desktop`
 * and `mobile` hash to unrelated offsets and drift up to a whole interval apart, which means
 * the two copies of a page can differ in age by up to 24h — a content change shows on one
 * device and not the other, and every render pays a cold origin/CDN fetch. Aligned, the pair
 * sorts adjacently in `RenderQueue.claim`'s nextRenderTime order and is rendered back-to-back
 * by one worker off a warm origin. Residency already groups them this way (`schedulerNode`
 * comes from the URL alone), so the seed now agrees with the routing.
 *
 * Alignment persists cycle over cycle because `processJobResult` reschedules from
 * `currentMinuteMs() + interval` — both variants completing within the same minute get an
 * identical next time, so the pair stays locked instead of drifting.
 */
const jitterSeed = (key) => {
	const str = String(key ?? '');
	const at = str.indexOf(config.cacheKey.delimiter);
	// No delimiter → not a cache key. Seed off the whole string rather than the empty prefix
	// `CacheKey.extractUrl` would return, which would collapse every such key onto a single
	// minute — precisely the herd this jitter exists to prevent.
	return at === -1 ? str : str.slice(0, at);
};

/**
 * Deterministic first-render time: `now` plus a per-URL offset in `[0, interval)`,
 * floored to the minute. Spreads the initial render of freshly-scheduled targets
 * across the render interval instead of firing them all at once (the thundering
 * herd on bulk sitemap population / crawl spikes). The offset is keyed off the URL
 * half of the cacheKey (see `jitterSeed`) so it's stable, reproducible, and shared
 * by a URL's device variants. Recurring re-renders are scheduled relative to render
 * completion (see RenderQueue.processJobResult), so this initial spread is preserved
 * cycle over cycle rather than realigning to a fixed instant.
 */
export const getInitialRenderTime = (key, interval) => {
	// Guard against a zero/negative/NaN interval (which would make the modulo NaN and
	// schedule an invalid time) so the helper is safe to call with unvalidated inputs.
	const safeInterval = Number.isFinite(interval) && interval > 0 ? interval : config.render.defaultInterval;
	return currentMinuteMs(Date.now() + (fnv1a32(jitterSeed(key)) % safeInterval));
};

export const getNextSitemapRefreshTime = () => getNextTimeOfDay(config.sitemap.refreshTime, config.sitemap.timezone);
