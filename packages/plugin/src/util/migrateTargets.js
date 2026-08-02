/**
 * One-shot startup migration: rebuild the url-keyed `Target` registry from the legacy
 * per-device `RenderTarget` table (pre-v0.19, one row per url|deviceType).
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
 * MANUALLY TRIGGERED — `POST /prerender_admin/migrate-targets` on ONE node (super_user), so
 * there is exactly one writer and no duplicated creates/deletes across nodes. The recommended
 * deploy is: operator pauses the cluster queue (`scope: 'all'`) → roll the nodes → trigger
 * this once → verify → resume. Every step is still idempotent (absent-only writes, idempotent
 * deletes), so a crashed or accidentally repeated run converges instead of corrupting.
 *
 * Sequence:
 *   1. Skip unless the legacy table has rows (self-limiting: step 4 empties it).
 *   2. PAUSE the cluster queue if the operator hasn't already — their intent outranks ours
 *      and is never resumed on their behalf. The pause keeps in-flight results from hitting
 *      the targetless-schedule drain path mid-rebuild; anything that slips in from a
 *      pre-pause claim costs at most a schedule gap, which util/reconcile.js repairs.
 *   3. Group legacy rows by URL and write each Target row that does not already exist.
 *   4. Delete the legacy rows, so a re-trigger is a no-op and the next release can drop
 *      the type from the schema entirely.
 *   5. Resume the queue (only if step 2 was ours to pause).
 *
 * The old NonIndexable table is deliberately NOT migrated: it was self-expiring (7d), so its
 * loss costs at most one render per noindex URL, after which the verdict is re-recorded as
 * target suppression.
 *
 * The URL grouping is held in memory — fine at staging scale; a production-sized registry
 * would want the phased dual-write migration instead (see PR #53's discussion).
 */

import { setImmediate } from 'node:timers/promises';
import { CacheKey } from './cacheKey.js';
import { getResidencyByUrl } from './residency.js';
import { CLUSTER_SCOPE } from './queueControl.js';
import { applyInBatches } from './scan.js';
import { RenderQueue } from '../resources/RenderQueue.js';

// Rows scanned between event-loop yields, same courtesy as the reconcile sweep.
const YIELD_EVERY = 200;

/**
 * The pure sweep, all I/O injected (same testing discipline as reconcileSchedules).
 * Two-phase: the legacy scan is fully drained before any write is issued, so no write is
 * ever pending while the read cursor is open.
 */
export const migrateLegacyTargets = async ({
	streamLegacy,
	getTarget,
	putTarget,
	deleteLegacy,
	onYield = () => {},
}) => {
	const stats = { legacyRows: 0, urls: 0, created: 0, existing: 0 };

	// Phase 1 — read only. Group per-device rows into one URL row: URL-level facts are taken
	// from the first row that has them (device siblings were written by the same producer, so
	// disagreements are drift — first-seen is as principled as any and deterministic here).
	const byUrl = new Map();
	const legacyKeys = [];
	for await (const row of streamLegacy()) {
		stats.legacyRows++;
		if (stats.legacyRows % YIELD_EVERY === 0) await onYield();

		legacyKeys.push(row.cacheKey);
		const url = row.url ?? CacheKey.extractUrl(row.cacheKey);
		const agg = byUrl.get(url) ?? {};
		if (!agg.sitemapUrl && row.sitemapUrl) agg.sitemapUrl = row.sitemapUrl;
		// Long can arrive as BigInt (Number.isFinite rejects it) — coerce before the checks.
		const interval = Number(row.renderInterval);
		if (agg.renderInterval === undefined && Number.isFinite(interval) && interval > 0) {
			agg.renderInterval = interval;
		}
		byUrl.set(url, agg);
	}
	stats.urls = byUrl.size;

	// Phase 2 — absent-only Target writes, cursor closed. Absent-only is what makes crashed or
	// concurrent runs (every node's worker 0 runs this) converge instead of clobbering: a row
	// written by a parallel run — or by live traffic while we ran — always wins.
	let considered = 0;
	for (const [url, agg] of byUrl) {
		if (++considered % YIELD_EVERY === 0) await onYield();
		if (await getTarget(url)) {
			stats.existing++;
			continue;
		}
		await putTarget(url, {
			url,
			sitemapUrl: agg.sitemapUrl ?? null,
			renderInterval: agg.renderInterval ?? null,
			schedulerNode: getResidencyByUrl(url),
		});
		stats.created++;
	}

	// Phase 3 — consume the legacy rows, so the next boot skips at step 1 and the next
	// release can drop the table.
	await deleteLegacy(legacyKeys);

	return stats;
};

let running = false;
let lastRun = null;

/** Summary of the most recent migration run on this node, for the admin action. */
export const getLastMigration = () => lastRun;

/** The sweep bound to the live tables, wrapped in the cluster pause. Guarded against
 *  overlap on this node; the operator triggers it on ONE node, so there is exactly one
 *  writer — the absent-only semantics below are a safety net, not the mechanism. */
export const runTargetMigration = async () => {
	if (running) return { skipped: true, reason: 'a migration is already running on this node', lastRun };
	running = true;
	const startedAt = Date.now();

	try {
		const outcome = await runTargetMigrationInner();
		lastRun = { ...outcome, node: server.hostname, startedAt, finishedAt: Date.now(), error: null };
		return lastRun;
	} catch (e) {
		lastRun = { node: server.hostname, startedAt, finishedAt: Date.now(), error: e?.message ?? String(e) };
		throw e;
	} finally {
		running = false;
	}
};

const runTargetMigrationInner = async () => {
	const {
		render_service: { Target: TargetTable, RenderTarget: LegacyTable, QueueControl },
	} = databases;

	// Anything at all in the legacy table means a pre-v0.19 deployment's registry is waiting.
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
			// the primary key, no conditions, no limit).
			streamLegacy: () => LegacyTable.search({ select: ['cacheKey', 'url', 'sitemapUrl', 'renderInterval'] }),
			getTarget: (url) => TargetTable.get({ id: url, select: ['url'] }),
			// The RAW table class ON PURPOSE: resources/Target.js `put` fans out fresh jittered
			// schedule rows, and preserving the existing schedules untouched is the entire point.
			putTarget: (url, row) => TargetTable.put(url, row),
			deleteLegacy: (cacheKeys) =>
				applyInBatches({ items: cacheKeys, apply: (cacheKey) => LegacyTable.delete(cacheKey) }),
			onYield: () => setImmediate(),
		});

		logger.warn(
			`[prerender] target migration: ${stats.legacyRows} legacy rows → ${stats.urls} urls ` +
				`(${stats.created} created, ${stats.existing} already present); legacy rows consumed`
		);
		return stats;
	} finally {
		if (pausedByUs) {
			logger.warn('[prerender] target migration: resuming the render queue');
			await RenderQueue.setPause({ scope: CLUSTER_SCOPE, paused: null, updatedBy: 'target-migration' });
		}
	}
};
