/**
 * One-shot migration: rebuild the url-keyed `Target` registry from the legacy per-device
 * `RenderTarget` table (pre-v0.19, one row per url|deviceType).
 *
 * WHAT IT MUST NOT DO is re-render anything. The RenderSchedule and PrerenderedPage tables
 * did not change shape — every existing schedule row (with its accumulated jitter and
 * cadence) and every cached page stays exactly where it is. Without this migration the
 * rotation would drain itself through wasted work: `claim` keeps rendering the old schedule
 * rows, each result finds no Target row, is treated as a render-now one-off, and its
 * schedule is DELETED — one full render per URL per device, spent on emptying the queue.
 *
 * So the migration writes ONLY Target rows, via the RAW table class — never `Target.put`,
 * whose fan-out would rewrite every schedule row with a fresh jitter and shove the whole
 * rotation's cadence around.
 *
 * SIZED FOR THE REAL REGISTRY (~1.6M legacy rows), which forces three properties:
 *   - DETACHED: the sweep takes minutes, far past any HTTP timeout, so the admin action
 *     starts it and returns; progress and the final summary are polled from the same action
 *     (the reconcile pattern). Re-running after completion requires an explicit
 *     `{"restart": true}`, so a poll can never accidentally start a fresh sweep.
 *   - PAGED, not held open: keyset pagination on the primary key (`cacheKey greater_than
 *     <last seen>`, bounded pages), each page's cursor fully drained BEFORE its writes —
 *     the same no-write-under-an-open-cursor rule as util/scan.js, without collecting 1.6M
 *     rows in memory. (`snapshot: false` is NOT the answer: Harper's search path does not
 *     consume it — the option only exists on internal store-level getRange calls.) Keyset
 *     order is the primary store's native range order, and the walk is exact because the
 *     legacy table is immutable throughout; a re-seen row is absorbed by absent-only.
 *     The first device row seen for a URL creates the Target; the sibling row skips. A
 *     first row missing `sitemapUrl`/`renderInterval` creates the target unattributed —
 *     the next sitemap refresh REATTACHes it (patch), so per-device drift self-heals.
 *   - PURE-ADDITIVE: legacy rows are NOT deleted, so rolling back to pre-v0.19 still finds
 *     its registry intact — the clean-rollback window stays open until the follow-up
 *     release drops the legacy table (`drop_table` reclaims the files; the new code never
 *     reads it outside this module).
 *
 * MANUALLY TRIGGERED — `POST /prerender_admin/migrate-targets` on ONE node (super_user), so
 * there is exactly one writer and no duplicated creates across nodes. The recommended deploy
 * is: operator pauses the cluster queue (`scope: 'all'`) → roll the nodes → trigger this
 * once → poll until done → verify → resume. Absent-only writes make a crashed or repeated
 * trigger converge instead of clobbering.
 *
 * While the sweep runs, the queue must stay paused: a result processed mid-rebuild for a URL
 * whose Target row hasn't been written yet is treated as a one-off and its schedule dropped
 * (util/reconcile.js repairs such gaps, but the pause makes them non-events). The run pauses
 * the cluster itself if the operator hasn't already — their intent outranks ours and is
 * never resumed on their behalf.
 *
 * The old NonIndexable table is deliberately NOT migrated: it was self-expiring (7d), so its
 * loss costs at most one render per noindex URL, after which the verdict is re-recorded as
 * target suppression.
 */

import { setImmediate } from 'node:timers/promises';
import { CacheKey } from './cacheKey.js';
import { getResidencyByUrl } from './residency.js';
import { CLUSTER_SCOPE } from './queueControl.js';
import { RenderQueue } from '../resources/RenderQueue.js';

// Rows scanned between event-loop yields, same courtesy as the reconcile sweep.
const YIELD_EVERY = 200;

// Progress-log cadence: frequent enough that a stalled 15-minute sweep is visibly stalled,
// quiet enough not to flood the log.
const PROGRESS_EVERY = 100_000;

// Keyset page size: bounds both the memory held (one page of skinny rows) and how long any
// single read cursor stays open.
const PAGE_SIZE = 5000;

/**
 * The pure sweep, all I/O injected (same testing discipline as reconcileSchedules).
 * `pageLegacy(afterKey, limit)` returns the next page of legacy rows in primary-key order
 * (afterKey === undefined asks for the first page); each page is fully materialized before
 * its writes, so no read cursor is ever open across a write. `stats` is mutated in place so
 * a caller can expose it as live progress while the sweep runs.
 */
export const migrateLegacyTargets = async ({
	pageLegacy,
	getTarget,
	putTarget,
	onYield = () => {},
	stats,
	pageSize = PAGE_SIZE,
}) => {
	stats.legacyRows = 0;
	stats.created = 0;
	stats.existing = 0;

	let afterKey;
	for (;;) {
		// Phase 1 (per page) — read only, cursor drained by materializing the page.
		const page = await pageLegacy(afterKey, pageSize);
		if (page.length === 0) break;

		// Phase 2 (per page) — writes, with no cursor open.
		for (const row of page) {
			stats.legacyRows++;
			if (stats.legacyRows % YIELD_EVERY === 0) await onYield();
			if (stats.legacyRows % PROGRESS_EVERY === 0) {
				logger.warn(
					`[prerender] target migration: ${stats.legacyRows} legacy rows scanned, ${stats.created} targets created`
				);
			}

			const url = row.url ?? CacheKey.extractUrl(row.cacheKey);

			// Absent-only: the sibling device row of an already-created URL, a row from a prior
			// (crashed/repeated) run, and a row re-seen across a page boundary all land here and
			// skip.
			if (await getTarget(url)) {
				stats.existing++;
				continue;
			}

			// Long can arrive as BigInt (Number.isFinite rejects it) — coerce before the check.
			const interval = Number(row.renderInterval);
			await putTarget(url, {
				url,
				sitemapUrl: row.sitemapUrl ?? null,
				renderInterval: Number.isFinite(interval) && interval > 0 ? interval : null,
				schedulerNode: getResidencyByUrl(url),
			});
			stats.created++;
		}

		afterKey = page[page.length - 1].cacheKey;
	}

	return stats;
};

let running = false;
let lastRun = null;
// Mutated in place by the sweep, so the admin action can report live progress.
const progress = { legacyRows: 0, created: 0, existing: 0 };

/** Live status for the admin action: whether a sweep is running, how far it is, and the
 *  last completed run's summary. */
export const getMigrationStatus = () => ({ running, progress: { ...progress }, lastRun });

/**
 * Run the sweep against the live tables, wrapped in the cluster pause. Guarded against
 * overlap on this node; the operator triggers it on ONE node, so there is exactly one
 * writer — the absent-only semantics are a safety net, not the mechanism.
 */
export const runTargetMigration = async () => {
	if (running) return { skipped: true, reason: 'a migration is already running on this node', ...getMigrationStatus() };
	running = true;
	const startedAt = Date.now();

	try {
		const outcome = await runTargetMigrationInner();
		lastRun = { ...outcome, node: server.hostname, startedAt, finishedAt: Date.now(), error: null };
		return lastRun;
	} catch (e) {
		lastRun = {
			...getMigrationStatus().progress,
			node: server.hostname,
			startedAt,
			finishedAt: Date.now(),
			error: e?.message ?? String(e),
		};
		throw e;
	} finally {
		running = false;
	}
};

const runTargetMigrationInner = async () => {
	const {
		render_service: { Target: TargetTable, RenderTarget: LegacyTable, QueueControl },
	} = databases;

	// Nothing in the legacy table (a fresh deployment) means nothing to migrate.
	const [firstLegacy] = await Array.fromAsync(LegacyTable.search({ select: ['cacheKey'], limit: 1 }));
	if (!firstLegacy) return { skipped: true, reason: 'legacy table is empty — nothing to migrate' };

	// Pause the WHOLE cluster's claiming while the registry is rebuilt — a replicated intent
	// every node resolves within one statusSyncInterval. Left alone if an operator already
	// paused: their intent outranks ours, and resuming on their behalf would be worse than
	// any migration race.
	const existingIntent = await QueueControl.get({ id: CLUSTER_SCOPE, select: ['paused'] });
	const pausedByUs = existingIntent?.paused !== true;
	if (pausedByUs) {
		logger.warn('[prerender] target migration: pausing the render queue while the registry is rebuilt');
		await RenderQueue.setPause({ scope: CLUSTER_SCOPE, paused: true, updatedBy: 'target-migration' });
	}

	try {
		const stats = await migrateLegacyTargets({
			// Keyset pagination on the primary key. No `sort` (rejected on an unindexed PK —
			// the v0.10.0 trap); the ordering comes from the primary store's native range scan.
			// `value: true` is Harper's own start-of-range form (what it injects for a full
			// scan); subsequent pages continue strictly after the last key seen. Each page is
			// drained via Array.fromAsync BEFORE its writes, so no read cursor is ever open
			// across a write and no snapshot outlives one page.
			pageLegacy: (afterKey, limit) =>
				Array.fromAsync(
					LegacyTable.search({
						conditions: [{ attribute: 'cacheKey', comparator: 'greater_than', value: afterKey ?? true }],
						select: ['cacheKey', 'url', 'sitemapUrl', 'renderInterval'],
						limit,
					})
				),
			getTarget: (url) => TargetTable.get({ id: url, select: ['url'] }),
			// The RAW table class ON PURPOSE: resources/Target.js `put` fans out fresh jittered
			// schedule rows, and preserving the existing schedules untouched is the entire point.
			putTarget: (url, row) => TargetTable.put(url, row),
			onYield: () => setImmediate(),
			stats: progress,
		});

		logger.warn(
			`[prerender] target migration: done — ${stats.legacyRows} legacy rows scanned, ` +
				`${stats.created} targets created, ${stats.existing} rows already covered; legacy rows left ` +
				`in place for rollback (a later release drops the table)`
		);
		return { ...stats };
	} finally {
		if (pausedByUs) {
			logger.warn('[prerender] target migration: resuming the render queue');
			await RenderQueue.setPause({ scope: CLUSTER_SCOPE, paused: null, updatedBy: 'target-migration' });
		}
	}
};
