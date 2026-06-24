import { config } from '../config.js';

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

export const getNextRenderTime = () => getNextTimeOfDay(config.render.time, config.render.timezone);

export const getNextSitemapRefreshTime = () => getNextTimeOfDay(config.sitemap.refreshTime, config.sitemap.timezone);
