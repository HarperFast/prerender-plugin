/**
 * REOPENING A GONE TARGET ON EVIDENCE OF LIFE (`render.suppression.gone.reopen`).
 *
 * A 404/410 verdict suppresses a target, deletes its pages and parks it for `gone.recheckInterval` —
 * 14 days by default — and until then every other signal treats the row as settled: the sitemap walk
 * skips it, the arrival check skips it, the change probe skips it, and discovery ignores any URL that
 * already has a row. So a product that comes back waits the whole recheck to be rendered again, while
 * crawlers are served the live origin page meanwhile: correct, but prerendered for nobody.
 *
 * The evidence is an origin 200 this plugin already saw, for free — a bot request it proxied, or a
 * negative-cache re-check. Either files the target's recheck due now, and the RENDER decides: an
 * indexable result reactivates the target (RenderQueue), a 404 suppresses it again. Nothing here flips
 * the target's state on the word of one proxied fetch; the renderer confirms it with its own request.
 *
 * GONE VERDICTS ONLY. A noindex or canonical-mismatch page answers 200 by definition, so a 200 says
 * nothing about it, and reopening one would loop: render, suppress, the next bot request, render again.
 */

import { config } from '../config.js';
import { metrics } from '../metrics.js';
import { Target } from '../resources/Target.js';
import { QueueState } from '../resources/QueueState.js';
import { fileDueNow } from './renderSchedule.js';
import { resolveEffectiveInterval } from './routeClass.js';
import { isGoneSuppressed } from './suppression.js';
import { demandOf } from './demand.js';

// Re-exported so the serve path has one module to reach for.
export { isGoneSuppressed };

/** Everything a reopen needs, read in one point read — and all a caller holding the row must pass. */
export const REOPEN_SELECT = Object.freeze([
	'url',
	'state',
	'suppressedReason',
	'sitemapUrl',
	'renderInterval',
	'demandInterval',
]);

const MINUTE = 60_000;

// Per worker. The dedupe map is bounded so a crawler walking a large dead set cannot grow it without
// limit; evicting the oldest entry only means that URL could be reopened again sooner, which the render
// verdict makes harmless.
const RECENT_CAP = 50_000;
const recent = new Map();
let windowStartMs = 0;
let filedInWindow = 0;

const remember = (url, nowMs) => {
	recent.delete(url);
	recent.set(url, nowMs);
	if (recent.size > RECENT_CAP) recent.delete(recent.keys().next().value);
};

/** For tests: forget every dedupe entry and reset the rate window. */
export const resetReopenState = () => {
	recent.clear();
	windowStartMs = 0;
	filedInWindow = 0;
};

/**
 * The origin answered 200 for `url`. If its target is gone-suppressed, file the recheck due now.
 *
 * `target` is the row when the caller already read it (with at least `REOPEN_SELECT`); otherwise it is
 * read here. `via` says what saw the 200: 'traffic' (a proxied bot request) or 'recheck' (a negative-cache
 * re-check). Returns the outcome for tests; every outcome but 'disabled' and 'not-gone' is counted — those
 * two are the overwhelming majority on the traffic path and say nothing.
 */
export const maybeReopenGone = async ({ url, target, via, nowMs = Date.now() }) => {
	const reopen = config.render.suppression.gone.reopen;
	if (!reopen?.enabled) return 'disabled';
	try {
		const row = target ?? (await Target.get({ id: url, select: [...REOPEN_SELECT] }));
		if (!isGoneSuppressed(row)) return 'not-gone';

		const last = recent.get(url);
		if (last !== undefined && nowMs - last < reopen.dedupeMs) {
			metrics.goneReopen('deduped', via);
			return 'deduped';
		}
		if (nowMs - windowStartMs >= MINUTE) {
			windowStartMs = nowMs;
			filedInWindow = 0;
		}
		if (filedInWindow >= reopen.maxPerMinute) {
			metrics.goneReopen('capped', via);
			return 'capped';
		}
		remember(url, nowMs);
		filedInWindow++;

		if (reopen.dryRun) {
			metrics.goneReopen('would-file', via);
			return 'would-file';
		}

		// `fileDueNow` never demotes a row already due, and the change mark gives the recheck the same
		// standing as a probe-detected change — a page that came back is a page that changed — including
		// its demand, so a reopened page is ordered among changed pages by how often bots ask for it.
		const demand = demandOf(url, nowMs);
		await fileDueNow(url, {
			fromSitemap: !!row.sitemapUrl,
			effectiveInterval: resolveEffectiveInterval(url, row),
			changedAt: nowMs,
			demandPeriod: demand.known ? demand.periodMs : undefined,
		});
		// Wake idle consumers rather than waiting out the status sync, as a render-now does.
		await QueueState.noteWork();
		logger.info?.(`Prerendered url ${url} answers 200 at the origin (${via}) — filing its gone recheck now`);
		metrics.goneReopen('filed', via);
		return 'filed';
	} catch (e) {
		metrics.goneReopen('error', via);
		logger.warn?.(`[prerender] could not reopen ${url}: ${e?.message ?? String(e)}`);
		return 'error';
	}
};
