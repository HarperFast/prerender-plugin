import { config } from '../config.js';
import { fnv1a32 } from './hash.js';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const currentMinuteMs = (ts = Date.now()) => Math.floor(ts / MINUTE) * MINUTE;

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
