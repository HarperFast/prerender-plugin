/**
 * WHEN A CACHED PAGE WAS LAST CHECKED AGAINST THE ORIGIN, AND WHAT THE CHECK FOUND — the `PageCheck`
 * table (see its schema comment for why this is not `PageVerification`).
 *
 * Writers: the serve-time check (util/serveCheck.js), on every DECIDED check — agreed, acted on, held, or
 * nothing comparable — so a URL is asked once per window cluster-wide whatever the verdict; and the
 * change-probe sweep, on a comparison that HAPPENED and agreed. Readers: the serve path's check gate, and
 * the sweep's skip of a row a check observed exactly as its baseline stands.
 *
 * Every failure reads as "not checked", which costs one request at worst; nothing here can serve a page
 * that would otherwise be refused, because a check exempts nothing.
 */

import { metrics } from '../metrics.js';
import { dateColumnMs } from './time.js';

const table = () => databases.verification.PageCheck;

/** No usable check. Shared frozen object so the common path allocates nothing. */
export const NO_CHECK = Object.freeze({
	checkedAtMs: NaN,
	basisAtMs: NaN,
	outcome: null,
	field: null,
	evidence: null,
	signature: null,
});

const SELECT = ['url', 'checkedAt', 'basisAt', 'outcome', 'field', 'evidence', 'signature'];
const stringOrNull = (value) => (typeof value === 'string' && value !== '' ? value : null);

/**
 * `url`'s last check: when it ran and the `lastCached` it covered (ms, NaN when never, unreadable, or the
 * read failed), its outcome, the field a disagreement named and the digest of what the origin said for it,
 * and an agreeing endpoint check's signature.
 * A row written before `outcome` existed was an agreement. `select` is an array: a string projects to a
 * bare scalar.
 */
export const readPageCheck = async (url) => {
	try {
		const row = await table().get({ id: url, select: SELECT });
		if (!row) return NO_CHECK;
		return {
			checkedAtMs: dateColumnMs(row.checkedAt),
			basisAtMs: dateColumnMs(row.basisAt),
			outcome: stringOrNull(row.outcome) ?? 'agree',
			field: stringOrNull(row.field),
			evidence: stringOrNull(row.evidence),
			signature: stringOrNull(row.signature),
		};
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

/**
 * May the sweep skip a row whose stored baseline is `stored` (`ProbeState`: `signature`, `fingerprint`)
 * under `rule`, given `check`, for a pass that began at `sinceMs`? Only when a check since then AGREED and
 * observed exactly that baseline, under this rule: then the probe would find the row unchanged on every
 * slot, mapped or not. A check that agreed on the mapped fields alone says nothing about the rest.
 */
export const checkSparesProbe = (check, stored, rule, sinceMs) =>
	check.outcome === 'agree' &&
	check.checkedAtMs >= sinceMs &&
	check.signature !== null &&
	typeof stored?.signature === 'string' &&
	check.signature === stored.signature &&
	stored.fingerprint === rule.fingerprint;

/**
 * Record a check of the page whose `lastCached` was `basisAtMs`: `outcome` 'agree' (with the endpoint's
 * `signature` when there was one), 'mismatch' or 'held' (with the `field` and the digest of what the
 * origin said for it, `evidence`), 'inconclusive' or 'failed'. Never throws.
 */
export const writePageCheck = async (
	url,
	basisAtMs,
	{ outcome = 'agree', field = null, evidence = null, signature = null } = {}
) => {
	if (!Number.isFinite(basisAtMs)) return;
	try {
		await table().put(url, {
			url,
			checkedAt: new Date(),
			basisAt: new Date(basisAtMs),
			outcome,
			field: stringOrNull(field),
			evidence: stringOrNull(evidence),
			signature: stringOrNull(signature),
		});
	} catch (e) {
		metrics.serveCheck('write-error', null);
		logger.warn?.(`[prerender] page check write failed for ${url}: ${e?.message ?? String(e)}`);
	}
};
