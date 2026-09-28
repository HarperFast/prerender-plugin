/**
 * The dashboard's periodic snapshot: overdue-backlog count, next-24h render histogram, and the
 * table counts — everything the overview needs that is not a point read, computed on a
 * background cadence instead of on page load.
 *
 * THE QUEUE HALF COMES FROM THE QUEUE KEEPER (`util/queueKeeperService.js`), which holds every row
 * this node owns: counts are exact and uncapped, and the 24-hour histogram is never empty. Before
 * v0.93.0 it was a capped walk of the `nextRenderTime` index, which reported the cap instead of a count
 * whenever the backlog outgrew it. While the keeper is not live the queue half is absent
 * (`queueUnavailable`), never a guess.
 *
 * `overdue` includes every in-flight render: a leased job's row keeps its past due time until its
 * result lands. The snapshot reports `inFlight` beside it rather than subtracting a live gauge from
 * an older count and presenting the difference as one figure.
 *
 * WHY NOT ON PAGE LOAD. The table counts (`getRecordCount`) are time-bounded, but four of them is still
 * up to ~2s of scanning per refresh on 1M-row tables. This plugin shares its workers with bot traffic;
 * a dashboard refresh must never put that work in front of a bot request, so the overview serves the
 * LAST snapshot with its timestamp, a timer on worker 0 recomputes it on a slow cadence, and
 * recomputing right now is an explicit admin action.
 *
 * WHY THE RESULT LIVES IN THE `coordination` DATABASE, NOT MODULE STATE. The timer runs on
 * worker 0, but overview requests are served by every worker — module state would leave the
 * snapshot visible only to the worker that computed it. The `SharedBuffer` table is node-local
 * (`replicate: false`), which is exactly the scope a per-node snapshot has: this node's slice
 * of a residency-pinned table, labelled with whose it is.
 *
 * The in-flight guard is the same advisory claim `claimRefreshRun` uses for sitemap walks: a
 * `running` marker with a staleness takeover, not a lock. Two racing workers at worst run one
 * redundant pass; a crashed worker can never wedge the snapshot forever.
 */

import { setImmediate as yieldNow } from 'node:timers/promises';
import { config, collectConfigWarnings, onConfigApplied } from '../config.js';
import { fnv1a32 } from './hash.js';
import { HOUR, MINUTE } from './time.js';
import { inFlightLeases } from './renderSchedule.js';
import { readQueueStateDocument } from './queueKeeperService.js';
import { metrics } from '../metrics.js';

export const HISTOGRAM_HOURS = 24;

const ROW_KEY = 'backlog_snapshot';

// A `running` marker older than this is a dead run (crashed worker, killed process) and is
// taken over. Generous next to a real pass.
const STALE_RUN_MS = 5 * MINUTE;

const table = () => databases.coordination.SharedBuffer;

/**
 * The queue half of the snapshot, from the queue keeper's last state document, or null when the
 * keeper cannot answer (not live, or its document is stale). Any worker can call it: the document is
 * in shared memory.
 */
export const upcomingFromKeeper = (now) => {
	const doc = readQueueStateDocument();
	if (doc?.keeper?.phase !== 'live' || !doc.queue) return null;
	const maxAgeMs = 3 * config.queue.keeper.stateInterval + 5_000;
	if (!(now - doc.generatedAt <= maxAgeMs)) return null;
	const q = doc.queue;
	return {
		overdue: q.due,
		inFlight: inFlightLeases(),
		buckets: q.coming.byHour.map((count, hour) => ({ hour, startMs: doc.generatedAt + hour * HOUR, count })),
		scanned: q.rows,
		// a load that skipped unreadable rows, or a verification walk that had to repair rows, makes the
		// counts a lower bound until the next clean verification
		truncated: !doc.keeper.exact,
		horizonMs: doc.generatedAt + HISTOGRAM_HOURS * HOUR,
		source: 'keeper',
		asOf: doc.generatedAt,
	};
};

/**
 * `getRecordCount` for one table: time-bounded and yielding inside Harper, and it reports
 * `estimatedRange` when the number is an estimate. Surfaced as-is — an estimate labelled as
 * one beats an exact number nobody can afford to compute. A failure costs the field, never
 * the snapshot.
 */
async function countTable(table) {
	try {
		const { recordCount, estimatedRange } = await table.getRecordCount();
		return { recordCount, estimatedRange: estimatedRange ?? null };
	} catch (e) {
		logger.error(e);
		return { recordCount: null, error: 'unavailable' };
	}
}

/**
 * Capped count of suppressed targets (`state` is indexed, so this is an equality walk, not a
 * table scan). Reported with the cap so a truncated count reads as "≥ cap", never as exact.
 */
async function countSuppressed(Target) {
	const cap = Math.max(1, config.management.scanCap | 0);
	try {
		let count = 0;
		for await (const row of Target.search({
			conditions: [{ attribute: 'state', value: 'suppressed' }],
			select: ['url'],
			limit: cap,
		})) {
			void row;
			count++;
			if (count % 200 === 0) await yieldNow();
		}
		return { recordCount: count, truncated: count >= cap };
	} catch (e) {
		logger.error(e);
		return { recordCount: null, error: 'unavailable' };
	}
}

const readRow = async () => {
	try {
		return (await table().get(ROW_KEY)) ?? null;
	} catch (e) {
		logger.warn?.(`[prerender] could not read the backlog snapshot row: ${e?.message ?? String(e)}`);
		return null;
	}
};

const isRunning = (row) => !!row?.running && Date.now() - Number(row.startedAt) < STALE_RUN_MS;

/** `{ running, lastRun }` for this node, readable from any worker. */
export const getBacklogSnapshotState = async () => {
	const row = await readRow();
	return { running: isRunning(row), lastRun: row?.lastRun ?? null };
};

/**
 * Compute one snapshot, guarded by the advisory claim described above. Returns the new
 * snapshot, or `{ skipped: true }` when a live run already holds the claim — the timer and the
 * console's Recompute button share this, so a click can never stack a second scan onto the
 * scheduled one.
 */
export const runBacklogSnapshotOnce = async () => {
	const existing = await readRow();
	if (isRunning(existing)) {
		return { skipped: true, reason: 'a backlog scan is already running', lastRun: existing?.lastRun ?? null };
	}

	const startedAt = Date.now();
	// Claim first, keeping the previous result readable while the new scan runs.
	await table().put(ROW_KEY, { running: true, startedAt, node: server.hostname, lastRun: existing?.lastRun ?? null });

	let lastRun;
	try {
		const stats = upcomingFromKeeper(startedAt) ?? {
			overdue: null,
			inFlight: inFlightLeases(),
			buckets: [],
			source: 'keeper',
			queueUnavailable: 'the queue keeper is not live',
		};

		// The table counts ride in the same snapshot for the same reason as the histogram:
		// getRecordCount is bounded (and yields internally), but it is still scanning work, and
		// dashboard page load must cost point reads only. SEQUENTIAL on purpose — this runs
		// beside bot traffic, and there is nothing to win by stacking four scans at once.
		const {
			render_service: { Target },
			page_cache: { PrerenderedPage },
			sitemaps: { Sitemap },
		} = databases;
		// `snapshotTableCounts: false` is the #664 dodge: getRecordCount's native full-key walk is
		// the ONLY part of this pass that can stall a traffic-serving worker, so a deployment can
		// drop the counts while keeping the queue half and the queue_health gauges. The
		// shape matches countTable's own failure value, which the console already renders.
		const skipped = { recordCount: null, error: 'disabled' };
		const counts = !config.management.snapshotTableCounts
			? { targets: skipped, pages: skipped, sitemaps: skipped, suppressed: skipped }
			: {
					targets: await countTable(Target),
					pages: await countTable(PrerenderedPage),
					sitemaps: await countTable(Sitemap),
					// Suppressed targets replaced the NonIndexable table: an indexed-equality walk,
					// capped like every other management scan, so a runaway suppression count can't
					// turn the snapshot into a full table scan.
					suppressed: await countSuppressed(Target),
				};

		lastRun = { ...stats, counts, node: server.hostname, startedAt, finishedAt: Date.now(), error: null };

		// Alertable gauges off numbers this pass already computed, emitted from the same
		// one-worker-per-node cadence as the snapshot itself; value metrics, same buffered
		// recordAnalytics path as page_age. Guarded separately: losing a gauge must never cost the
		// snapshot.
		try {
			// Dynamic import, not top-level: QueueState's module load touches Harper globals (a
			// shared status buffer) that plain unit-test imports of this module don't have.
			const { QueueState } = await import('../resources/QueueState.js');
			metrics.queueHealth(QueueState.status === 'paused' ? 1 : 0, 'paused');
			// The warning COUNT rides the same per-node gauge pass; the findings themselves are on
			// GET /prerender_admin/config. Alert on change, not on level.
			metrics.configWarnings(collectConfigWarnings().length);
			// 1 while the queue keeper is live: a node whose keeper is not grants no claims at all.
			metrics.queueHealth(stats.queueUnavailable ? 0 : 1, 'keeper_live');
			if (stats.overdue !== null) metrics.queueHealth(stats.overdue, 'overdue');
			metrics.queueHealth(stats.inFlight, 'lease_occupancy');
		} catch (e) {
			logger.warn?.(`[prerender] queue_health gauges not recorded: ${e?.message ?? String(e)}`);
		}
	} catch (e) {
		lastRun = { node: server.hostname, startedAt, finishedAt: Date.now(), error: e?.message ?? String(e) };
	}

	await table().put(ROW_KEY, { running: false, startedAt, node: server.hostname, lastRun });
	return lastRun;
};

let snapshotterStarted = false;
let snapshotterDelayTimer = null;
let snapshotterIntervalTimer = null;
let snapshotterArmed = null; // the interval the timers were armed for, or null when disabled

const clearSnapshotterTimers = () => {
	if (snapshotterDelayTimer) clearTimeout(snapshotterDelayTimer);
	if (snapshotterIntervalTimer) clearInterval(snapshotterIntervalTimer);
	snapshotterDelayTimer = snapshotterIntervalTimer = null;
};

// (Re)arm the snapshot timers to match config: `management.enabled` and
// `management.backlogSnapshotInterval` are live. `backlogSnapshotInterval: 0` disables the
// timer and leaves the panel manual-only (the console's Recompute button still works).
const syncSnapshotterTimers = () => {
	const wanted = config.management.enabled && config.management.backlogSnapshotInterval;
	const desired = wanted ? config.management.backlogSnapshotInterval : null;
	if (desired === snapshotterArmed) return;

	const wasEnabled = snapshotterArmed !== null;
	clearSnapshotterTimers();
	snapshotterArmed = desired;
	if (desired === null) return;

	const run = () => {
		runBacklogSnapshotOnce().catch((e) => logger.error(e));
	};

	if (wasEnabled) {
		// Cadence change while running: swap the interval, no immediate recompute.
		snapshotterIntervalTimer = setInterval(run, desired);
		snapshotterIntervalTimer.unref?.();
		return;
	}

	// Stagger per node for the same reason the reconciler does: a rolling restart (or a config
	// change, which reaches every node at once) would otherwise sync every node's table counts onto
	// the same moment. Seeded differently than the reconciler so the two sweeps don't coincide.
	const stagger = fnv1a32(`backlog:${server.hostname}`) % Math.max(1, Math.min(desired, 5 * MINUTE));

	snapshotterDelayTimer = setTimeout(() => {
		run();
		snapshotterIntervalTimer = setInterval(run, snapshotterArmed);
		snapshotterIntervalTimer.unref?.();
	}, stagger);
	snapshotterDelayTimer.unref?.();
};

// Introspection for tests and the management API: what the timers are currently armed
// with (`armedInterval: null` = disabled).
export const snapshotterTimerState = () => ({ started: snapshotterStarted, armedInterval: snapshotterArmed });

/**
 * Start the periodic snapshot on worker 0 of every node. Idempotent; called from
 * handleApplication after config is applied. The timers follow config changes
 * (enable/disable, interval) without a restart.
 */
export function startBacklogSnapshotter() {
	if (server.workerIndex !== 0 || snapshotterStarted) return;
	snapshotterStarted = true;

	syncSnapshotterTimers();
	onConfigApplied(syncSnapshotterTimers);
}
