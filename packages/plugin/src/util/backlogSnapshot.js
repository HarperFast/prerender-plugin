/**
 * The dashboard's periodic snapshot: overdue-backlog count, next-24h render histogram, and the
 * table counts — everything the overview needs that is not a point read, computed on a
 * background cadence instead of on page load.
 *
 * WHY NOT ON PAGE LOAD. The histogram scan is a sorted, capped range read over
 * `RenderSchedule.nextRenderTime` — the index every completed render writes back to. The table
 * counts (`getRecordCount`) are time-bounded, but four of them is still up to ~2s of scanning per
 * refresh on 1M-row tables. This plugin shares its workers with bot traffic; a dashboard
 * refresh must never put either kind of work in front of a bot request, so the overview serves
 * the LAST snapshot with its timestamp, a timer on worker 0 recomputes it on a slow cadence,
 * and recomputing right now is an explicit admin action.
 *
 * SINCE v0.34.0 THIS IS THE ONLY SCAN THAT STILL SEEKS THE ABSOLUTE MINIMUM of that index —
 * `claim` starts from the claim floor instead (`util/renderSchedule.js`) — and it is kept that
 * way DELIBERATELY. It is therefore the only reader in the system that can see a row filed BELOW
 * the floor, which is a row nothing will ever claim: the same terminal, silent state
 * `util/reconcile.js` exists for, reachable now through a due time written by the operations API
 * or the exported REST surface. Narrowing this query to the floor (a two-sided range would be the
 * obvious "optimisation") would make that failure mode invisible again. Do not.
 *
 * `overdue` ALSO CHANGED MEANING. A leased job's row keeps its past due time until its result
 * lands, so `overdue` now includes every in-flight render and acquires a permanent floor equal to
 * the in-flight count. It is no longer comparable with numbers recorded before v0.34.0, and
 * "backlog returns to zero" is no longer the capacity test — "backlog returns to the in-flight
 * count" is. The snapshot reports `inFlight` beside it so the console can show both rather than
 * subtract a live gauge from a 15-minute-old scan and present the difference as one figure.
 *
 * WHY THE RESULT LIVES IN THE `coordination` DATABASE, NOT MODULE STATE. The timer runs on
 * worker 0, but overview requests are served by every worker — module state would leave the
 * snapshot visible only to the worker that computed it. The `SharedBuffer` table is node-local
 * (`replicate: false`), which is exactly the scope a per-node snapshot has: this node's slice
 * of a residency-pinned table, labelled with whose it is.
 *
 * The in-flight guard is the same advisory claim `claimRefreshRun` uses for sitemap walks: a
 * `running` marker with a staleness takeover, not a lock. Two racing workers at worst run one
 * redundant capped scan; a crashed worker can never wedge the snapshot forever.
 */

import { setImmediate as yieldNow } from 'node:timers/promises';
import { config, onConfigApplied } from '../config.js';
import { fnv1a32 } from './hash.js';
import { HOUR, MINUTE, numberOf } from './time.js';
import { currentFloorMs, inFlightLeases, floorState } from './renderSchedule.js';

// Rows scanned between event-loop yields, matching util/reconcile.js — a background scan on a
// worker that also serves bot traffic must never monopolize the loop between rows.
const YIELD_EVERY = 200;

export const HISTOGRAM_HOURS = 24;

const ROW_KEY = 'backlog_snapshot';

// A `running` marker older than this is a dead run (crashed worker, killed process) and is
// taken over. Generous next to a real scan, which is a single capped index walk.
const STALE_RUN_MS = 5 * MINUTE;

const table = () => databases.coordination.SharedBuffer;

/**
 * One capped, index-ordered walk of `RenderSchedule` over everything due within the next
 * `HISTOGRAM_HOURS`, bucketed by hour (plus an `overdue` count for anything already due).
 *
 * A single ascending scan gives both the backlog count and the upcoming shape. Because it is
 * ascending, a backlog larger than the cap consumes the whole budget and the histogram comes
 * back empty — which is the correct signal, not a defect: when you are that far behind, the
 * next-24h distribution is not the problem.
 *
 * Counting is capped because there is no cheap exact count for a range in the underlying
 * store; `truncated` says so explicitly rather than presenting a short count as the total.
 */
export async function scanUpcoming(now, cap) {
	const { RenderSchedule } = databases.render_schedule;
	const horizon = now + HISTOGRAM_HOURS * HOUR;

	const buckets = Array.from({ length: HISTOGRAM_HOURS }, (_, hour) => ({
		hour,
		startMs: now + hour * HOUR,
		count: 0,
	}));

	let overdue = 0;
	let scanned = 0;
	// The claim floor as `claim` would read it right now, captured ONCE so every row in this pass
	// is judged against the same value. Null = no floor, in which case nothing can be below it.
	const floorMs = currentFloorMs(now);
	let belowFloor = 0;
	let oldestBelowFloorMs = null;

	// Streamed and bucketed incrementally — never buffered (`cap` rows of nothing but a
	// timestamp is still cap rows of garbage), yielding between batches so the loop stays
	// available to bot requests. The walk is `cap`-bounded, which is what actually bounds how
	// long its read snapshot lives — a `snapshot: false` query option is NOT consumed by
	// Harper's search path (it exists only on internal store-level getRange calls).
	for await (const row of RenderSchedule.search(
		{
			conditions: [{ attribute: 'nextRenderTime', comparator: 'less_than_equal', value: horizon }],
			sort: { attribute: 'nextRenderTime' },
			select: ['nextRenderTime'],
			limit: cap,
		},
		{ replicateFrom: false }
	)) {
		scanned++;
		if (scanned % YIELD_EVERY === 0) await yieldNow();

		// `numberOf`, not `Number`: `Number(null)` is 0, which is finite and below any floor, so an
		// absent due time would count as `belowFloor` with an `oldest` of 1970 — a permanent false
		// alarm on the ONE metric that reports rows filed where no claim will look again.
		const at = numberOf(row.nextRenderTime);
		if (!Number.isFinite(at)) continue;
		// THE ALARM FOR THE NEW FAILURE MODE. A row below the floor is invisible to `claim` and to
		// the reconcile sweep (which tests existence, and the row exists), so this count is the
		// only automatic evidence that it happened. The floor comparator is inclusive, so a row AT
		// the floor is claimable and must not be counted.
		if (floorMs !== null && at < floorMs) {
			belowFloor++;
			if (oldestBelowFloorMs === null || at < oldestBelowFloorMs) oldestBelowFloorMs = at;
		}
		if (at <= now) {
			overdue++;
			continue;
		}
		const hour = Math.floor((at - now) / HOUR);
		if (hour >= 0 && hour < HISTOGRAM_HOURS) buckets[hour].count++;
	}

	return {
		overdue,
		// The live in-flight lease count, reported beside `overdue` rather than subtracted from it:
		// one is a scan that may be minutes old and the other is a gauge read right now, and
		// presenting their difference as a single number would be arithmetic across two clocks.
		inFlight: inFlightLeases(),
		belowFloor,
		oldestBelowFloorMs,
		floorMs,
		buckets,
		scanned,
		cap,
		truncated: scanned >= cap,
		horizonMs: horizon,
	};
}

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
		const stats = await scanUpcoming(startedAt, Math.max(1, config.management.scanCap | 0));

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
		// drop the counts while keeping the capped backlog walk and the queue_health gauges. The
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

		// Alertable gauges off numbers this pass already computed — until here they existed only in
		// the admin console, so "a row sits below the claim floor" (the silent render gap) and "the
		// floor has been pinned for hours" were facts nobody could page on. Emitted from the same
		// one-worker-per-node cadence as the snapshot itself; value metrics, same buffered
		// recordAnalytics path as page_age. Guarded separately: losing a gauge must never cost the
		// snapshot.
		try {
			const floor = floorState(startedAt);
			server.recordAnalytics(stats.overdue, 'queue_health', 'overdue', null, null);
			server.recordAnalytics(stats.inFlight, 'queue_health', 'lease_occupancy', null, null);
			server.recordAnalytics(stats.belowFloor, 'queue_health', 'below_floor', null, null);
			if (stats.oldestBelowFloorMs !== null) {
				server.recordAnalytics(startedAt - stats.oldestBelowFloorMs, 'queue_health', 'below_floor_age_ms', null, null);
			}
			server.recordAnalytics(floor.floorPinnedForMs, 'queue_health', 'floor_pin_age_ms', null, null);
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

	// Stagger per node for the same reason the reconciler does: every node scans its own slice,
	// and a rolling restart (or a config change, which reaches every node at once) would
	// otherwise sync them all onto the shared render index at the same moment. Seeded
	// differently than the reconciler so the two sweeps don't coincide.
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
