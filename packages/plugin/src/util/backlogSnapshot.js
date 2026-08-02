/**
 * The overdue-backlog count and next-24h render histogram, computed on a background cadence
 * instead of on page load.
 *
 * WHY NOT ON PAGE LOAD. The scan is a sorted, capped range read over
 * `RenderSchedule.nextRenderTime` — the same index `claim` walks from every worker every few
 * seconds, and the one every completed render writes back to. Running it whenever someone
 * looks at the dashboard puts an operator's browser refresh in direct competition with
 * rendering; during a real incident it was deliberately refused for exactly that reason. So
 * the overview serves the LAST snapshot with its timestamp, a timer on worker 0 recomputes it
 * on a slow cadence, and recomputing right now is an explicit admin action.
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

import { config } from '../config.js';
import { fnv1a32 } from './hash.js';
import { HOUR, MINUTE } from './time.js';

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

	const rows = await Array.fromAsync(
		RenderSchedule.search(
			{
				conditions: [{ attribute: 'nextRenderTime', comparator: 'less_than_equal', value: horizon }],
				sort: { attribute: 'nextRenderTime' },
				select: ['nextRenderTime'],
				limit: cap,
			},
			{ replicateFrom: false }
		)
	);

	const buckets = Array.from({ length: HISTOGRAM_HOURS }, (_, hour) => ({
		hour,
		startMs: now + hour * HOUR,
		count: 0,
	}));

	let overdue = 0;

	for (const row of rows) {
		const at = Number(row.nextRenderTime);
		if (!Number.isFinite(at)) continue;
		if (at <= now) {
			overdue++;
			continue;
		}
		const hour = Math.floor((at - now) / HOUR);
		if (hour >= 0 && hour < HISTOGRAM_HOURS) buckets[hour].count++;
	}

	return {
		overdue,
		buckets,
		scanned: rows.length,
		cap,
		truncated: rows.length >= cap,
		horizonMs: horizon,
	};
}

const readRow = async () => {
	try {
		return (await table().get(ROW_KEY)) ?? null;
	} catch (e) {
		logger.warn?.(`[prerender] could not read the backlog snapshot row: ${e?.message ?? e}`);
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
		lastRun = { ...stats, node: server.hostname, startedAt, finishedAt: Date.now(), error: null };
	} catch (e) {
		lastRun = { node: server.hostname, startedAt, finishedAt: Date.now(), error: e?.message ?? String(e) };
	}

	await table().put(ROW_KEY, { running: false, startedAt, node: server.hostname, lastRun });
	return lastRun;
};

let snapshotterStarted = false;

/**
 * Start the periodic snapshot on worker 0 of every node. Idempotent; called from
 * handleApplication after config is applied. `backlogSnapshotInterval: 0` disables the timer
 * and leaves the panel manual-only (the console's Recompute button still works).
 */
export function startBacklogSnapshotter() {
	if (server.workerIndex !== 0 || snapshotterStarted) return;
	if (!config.management.enabled || !config.management.backlogSnapshotInterval) return;

	snapshotterStarted = true;

	const run = () => {
		runBacklogSnapshotOnce().catch((e) => logger.error(e));
	};

	// Stagger per node for the same reason the reconciler does: every node scans its own slice,
	// and a rolling restart would otherwise sync them all onto the shared render index at the
	// same moment. Seeded differently than the reconciler so the two sweeps don't coincide.
	const interval = config.management.backlogSnapshotInterval;
	const stagger = fnv1a32(`backlog:${server.hostname}`) % Math.max(1, Math.min(interval, 5 * MINUTE));

	setTimeout(() => {
		run();
		setInterval(run, interval).unref?.();
	}, stagger).unref?.();
}
