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
 *     (the reconcile pattern).
 *   - STREAMING: one pass, one row at a time, no in-memory grouping. The first device row
 *     seen for a URL creates the Target (absent-only); the sibling row skips. A first row
 *     missing `sitemapUrl`/`renderInterval` creates the target unattributed — the next
 *     sitemap refresh REATTACHes it (patch), so per-device drift self-heals within a pass.
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

/**
 * The pure sweep, all I/O injected (same testing discipline as reconcileSchedules).
 * Single streamed pass; `stats` is mutated in place so a caller can expose it as live
 * progress while the sweep runs.
 */
export const migrateLegacyTargets = async ({ streamLegacy, getTarget, putTarget, onYield = () => {}, stats }) => {
	stats.legacyRows = 0;
	stats.created = 0;
	stats.existing = 0;

	for await (const row of streamLegacy()) {
		stats.legacyRows++;
		if (stats.legacyRows % YIELD_EVERY === 0) await onYield();
		if (stats.legacyRows % PROGRESS_EVERY === 0) {
			logger.warn(
				`[prerender] target migration: ${stats.legacyRows} legacy rows scanned, ${stats.created} targets created`
			);
		}

		const url = row.url ?? CacheKey.extractUrl(row.cacheKey);

		// Absent-only: the sibling device row of an already-created URL, a row from a prior
		// (crashed/repeated) run, and a row racing live traffic all land here and skip.
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
			// Unconstrained streamed scan — same query rules as the reconcile sweep (no sort on
			// the primary key, no conditions, no limit). `snapshot: false` because this single
			// pass interleaves ~800k Target writes with the walk: holding one read snapshot
			// across minutes of same-database writes pins the log against reclamation (the
			// two-phase rule everywhere else in this codebase). A snapshot-free walk is EXACT
			// here because nothing mutates the legacy table anymore — the migration is additive
			// and the legacy rows are only ever dropped by a later release's drop_table.
			streamLegacy: () =>
				LegacyTable.search({ select: ['cacheKey', 'url', 'sitemapUrl', 'renderInterval'], snapshot: false }),
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
