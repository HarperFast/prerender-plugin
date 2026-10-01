/**
 * WHEN A CACHED PAGE WAS LAST CHECKED AGAINST THE ORIGIN AND AGREED — the `PageCheck` table (see its
 * schema comment for why this is not `PageVerification`).
 *
 * Writers: the serve-time check (util/serveCheck.js) and the change-probe sweep, on a comparison that
 * HAPPENED and agreed — never on the absence of a disagreement. Readers: the serve path's check gate, and
 * the sweep's skip of what demand already checked since the anchor.
 *
 * Every failure reads as "not checked", which costs one request at worst; nothing here can serve a page
 * that would otherwise be refused, because a check exempts nothing.
 */

import { metrics } from '../metrics.js';
import { dateColumnMs } from './time.js';

const table = () => databases.verification.PageCheck;

/** No usable check. Shared frozen object so the common path allocates nothing. */
export const NO_CHECK = Object.freeze({ checkedAtMs: NaN, basisAtMs: NaN });

/**
 * When `url` was last checked and agreed, and the `lastCached` that check covered, in ms — NaN when
 * never, unreadable, or the read failed. `select` is an array: a string projects to a bare scalar.
 */
export const readPageCheck = async (url) => {
	try {
		const row = await table().get({ id: url, select: ['url', 'checkedAt', 'basisAt'] });
		if (!row) return NO_CHECK;
		return { checkedAtMs: dateColumnMs(row.checkedAt), basisAtMs: dateColumnMs(row.basisAt) };
	} catch (e) {
		metrics.serveCheck('read-error', null);
		logger.warn?.(`[prerender] page check read failed for ${url}: ${e?.message ?? String(e)}`);
		return NO_CHECK;
	}
};

/**
 * Is a key whose own `lastCached` is `lastCachedMs` covered at `thresholdMs`? Its own render is recent
 * enough, or a check at or after the threshold covered a render at least as old as it. NaN-safe: every
 * unreadable value reads as "not covered".
 */
export const coveredAt = (thresholdMs, lastCachedMs, check = NO_CHECK) =>
	lastCachedMs >= thresholdMs || (check.checkedAtMs >= thresholdMs && lastCachedMs >= check.basisAtMs);

/** Record an agreeing check of the page whose `lastCached` was `basisAtMs`. Never throws. */
export const writePageCheck = async (url, basisAtMs) => {
	if (!Number.isFinite(basisAtMs)) return;
	try {
		await table().put(url, { url, checkedAt: new Date(), basisAt: new Date(basisAtMs) });
	} catch (e) {
		metrics.serveCheck('write-error', null);
		logger.warn?.(`[prerender] page check write failed for ${url}: ${e?.message ?? String(e)}`);
	}
};
