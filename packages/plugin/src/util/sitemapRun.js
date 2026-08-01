/**
 * The decision logic and the running tally for one sitemap refresh.
 *
 * Both live here rather than in `resources/Sitemap.js` for the same reason
 * `partitionSitemapEntries` does: that module subclasses `databases.sitemaps.Sitemap` at import
 * time and cannot be loaded without a live Harper, so anything left inside it is untestable.
 */

import { PASSTHROUGH, UNCLASSIFIED } from './routeClass.js';
import { describeError } from './errors.js';

/**
 * What to do with one incoming sitemap entry × device.
 *
 *   CREATE   — no target yet. `put`, which also creates the jittered schedule row.
 *   REATTACH — the target exists but is attributed to a different sitemap. Update attribution
 *              only; do NOT touch the schedule (see `actionForExisting`).
 *   SKIP     — already correct. No write.
 *   RENDER   — explicit revalidate: `put` with an immediate render time.
 */
export const TargetAction = {
	CREATE: 'create',
	REATTACH: 'reattach',
	SKIP: 'skip',
	RENDER: 'render',
};

/**
 * Can this entry be decided WITHOUT a point read?
 *
 * The prune scan immediately above the entry loop already walked every target whose
 * `sitemapUrl` equals the sitemap being processed. A key it returned is, by construction,
 * both present and correctly attributed — the exact condition `SKIP` needs — so re-asking the
 * database is a wasted round trip. At 1.6M targets that redundant read WAS the bulk of the
 * refresh: one sequential `RenderTarget.get` per entry × device, every pass, forever.
 *
 * `knownKeys` is a fast path, never an authority: a miss falls through to the point read, so a
 * set that was capped or is otherwise incomplete costs latency and never correctness.
 */
export const canSkipLookup = ({ revalidate, knownKeys, cacheKey }) => !revalidate && !!knownKeys?.has(cacheKey);

/**
 * Decide from the point-read result.
 *
 * REATTACH is deliberately NOT a `put`. `RenderTarget.put` recomputes `getInitialRenderTime`
 * whenever no explicit `nextRenderTime` is supplied, so re-putting a target merely to correct
 * its attribution pushes its next render forward by a fresh jitter. That is the same mechanism
 * that made weekly/monthly targets never render at all (see `sitemapTargetNeedsUpdate`), and
 * it fires routinely: a URL listed in two sitemaps flip-flops between them on every pass, and
 * fixed-size paginated product sitemaps shuffle URLs across child boundaries whenever the
 * catalog changes. Patching attribution leaves the schedule — and therefore the render
 * cadence — exactly where it was.
 *
 * The tradeoff: `put` would incidentally recreate a missing schedule row, and `patch` will not.
 * That repair was never systematic here anyway (a correctly-attributed target is skipped
 * outright, so it was only ever reached for re-attached URLs) and it is `util/reconcile.js`
 * that actually owns the schedule-gap sweep.
 */
export const actionForExisting = (existingTarget, sitemapUrl) => {
	if (!existingTarget) return TargetAction.CREATE;
	return existingTarget.sitemapUrl === sitemapUrl ? TargetAction.SKIP : TargetAction.REATTACH;
};

/**
 * Accumulator for a whole walk, including the parts the old shape lost.
 *
 * Three things it deliberately does differently from the array-of-records it replaces:
 *
 *  - `removed` is a COUNT plus a capped sample. The previous result pushed every unlinked
 *    target record from every child into one array and returned it in the HTTP body; across 30
 *    children each able to contribute up to `scan.collectCap` rows, that is an unbounded
 *    response and an unbounded retention.
 *  - `truncatedScans` is reported. `collectFromScan` computes `truncated` precisely so a caller
 *    cannot act on a partial set while claiming success, and the only caller was discarding it.
 *  - `failed` exists at all. One unreachable child used to abort the entire walk.
 */
export const createRefreshRun = ({ removedSampleCap = 20, failedCap = 100 } = {}) => {
	const totals = {
		created: 0,
		updated: 0,
		skipped: 0,
		deferred: 0,
		removed: 0,
		sitemapsProcessed: 0,
		sitemapsDiscovered: 0,
	};
	const filtered = { [PASSTHROUGH]: 0, [UNCLASSIFIED]: 0 };
	const removedSample = [];
	const failed = [];
	const truncatedScans = [];
	let failedOverflow = 0;

	return {
		count(key, by = 1) {
			totals[key] += by;
		},

		addFiltered(counts) {
			filtered[PASSTHROUGH] += counts[PASSTHROUGH];
			filtered[UNCLASSIFIED] += counts[UNCLASSIFIED];
		},

		/** Record unlinked targets: the full count always, a bounded sample of the keys. */
		addRemoved(targets) {
			totals.removed += targets.length;
			for (const target of targets) {
				if (removedSample.length >= removedSampleCap) break;
				removedSample.push(target.cacheKey);
			}
		},

		/** A child sitemap threw. The walk continues; the failure is reported, not swallowed. */
		addFailure(url, error) {
			if (failed.length < failedCap) failed.push({ url, error: describeError(error) });
			else failedOverflow++;
		},

		/** A prune scan hit `scan.collectCap`, so only part of the departed set was unlinked. */
		addTruncatedScan(sitemapUrl, examined, collected) {
			truncatedScans.push({ sitemapUrl, examined, collected });
		},

		/** Point-in-time view, safe to persist mid-walk as progress. */
		snapshot() {
			return {
				...totals,
				filtered: { ...filtered },
				removedSample: [...removedSample],
				failed: [...failed],
				failedOverflow,
				truncatedScans: [...truncatedScans],
			};
		},
	};
};
