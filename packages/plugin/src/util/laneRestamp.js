/**
 * THE ONE-TIME MIGRATION, and the reason it is needed at all.
 *
 * A lane is DERIVED AT WRITE TIME, which is what makes a config change retroactive with no sweep of
 * the corpus — every row picks up the new banding on its next render. That property is real and it
 * is why the design avoids a lane column. It also has one hole, and the hole is exactly the
 * situation lanes exist to fix:
 *
 *   A ROW THAT IS STUCK NEVER GETS A NEXT WRITE. Nothing rewrites a schedule row except its own
 *   render result, so a homepage sitting behind three days of backlog cannot be promoted by a
 *   write-time rule — it is not being written. Deploying lanes and waiting would mean waiting for
 *   the very backlog the lanes are supposed to clear.
 *
 * So enabling lanes on an existing corpus takes one pass that rewrites each due time into its
 * derived lane. It changes NO due time: `dueAt` is preserved exactly and only the high bits move,
 * so nothing renders sooner or later than it would have — the pass changes the ORDER and nothing
 * else. That is also what makes it safe to run on a live node.
 *
 * ── WHAT IT CAN AND CANNOT DERIVE ──────────────────────────────────────────────────────────────
 *
 * The row carries `fromSitemap`; the cadence is route-resolved from the URL half of the cache key.
 * It deliberately does NOT read the Target, which would be one cross-database point read per row on
 * an 814k-target corpus. Two consequences, both bounded and both self-correcting on each row's next
 * render:
 *
 *   - A stored `changefreq` interval or a demand-ladder rung is invisible, so a catalog page the
 *     ladder promoted to 6h is stamped at its route's 24h ceiling and lands one band slower than it
 *     belongs. It re-bands correctly the first time it renders.
 *   - `cold` cannot be derived — suppression state and strike counts live on the Target — so a
 *     suppressed URL is stamped into its provenance lane rather than into `cold`. It moves to `cold`
 *     on its next recheck, which is the write that knows.
 *
 * Being one band optimistic for one cycle is the right direction to be wrong in: the alternative is
 * being pessimistic, and a row parked in a slow lane it does not belong in is a row that waits.
 *
 * ── WHY IT ONLY LOOKS AT LANE 0 ───────────────────────────────────────────────────────────────
 *
 * Unencoded and "urgent" are the same number — that is what makes the encoding migration-free, and
 * it means this pass cannot tell a row nobody has stamped yet from a row an operator deliberately
 * put in lane 0. While `queue.lanes.enabled` is false no legitimate lane-0 row can exist (writes
 * file lane 0 unconditionally and the claim path ignores lanes), so running the pass BEFORE flipping
 * the switch makes the ambiguity disappear rather than managed. That ordering is the documented
 * rollout, and this refuses to run once the switch is on unless explicitly forced.
 *
 * Selecting on lane 0 is also what makes the pass idempotent and resumable with no cursor: a
 * restamped row leaves the range being queried, so calling it repeatedly makes progress and
 * eventually finds nothing. There is no progress row to go stale and no partial state to resume
 * from.
 */

import { config } from '../config.js';
import { CacheKey } from './cacheKey.js';
import { LANE_STRIDE, laneFor, laneLabel } from './renderLane.js';
import { resolveRenderInterval } from './routeClass.js';
import { numberOf } from './time.js';

/**
 * One bounded pass. Returns what it did, and `done` when a pass examined rows and found nothing
 * left to move.
 *
 * ALL I/O INJECTED, for the same reason `runClaimPass` takes its search as an argument: the lane
 * derivation and the batching are the parts worth testing, and they should be testable without a
 * database.
 *
 * @param {object} io
 * @param {(opts: {limit: number}) => AsyncIterable} io.searchUnstamped  lane-0 rows, ascending
 * @param {(cacheKey: string, row: object) => Promise<unknown>} io.writeRow  the funnel's batch write
 * @param {number} [limit]  ceiling on rows examined in this pass
 */
export const restampPass = async ({ searchUnstamped, writeRow, limit = 5000 } = {}) => {
	const rows = [];
	// Drained before any write, exactly like the claim pass: Harper's long-transaction monitor aborts
	// a transaction that has pending writes when it fires, and a cursor left open across writes is
	// that shape. No `break` either — an abandoned iterator leaves its read transaction unreleased.
	for await (const row of searchUnstamped({ limit })) rows.push(row);

	const byLane = new Map();
	let examined = 0;
	let restamped = 0;
	let skipped = 0;

	for (const row of rows) {
		examined++;
		const dueAt = numberOf(row.nextRenderTime);
		// A row with no usable due time is left alone. It is not this pass's job to invent one, and
		// re-filing it under a lane would move a broken row without fixing it — `util/reconcile.js` and
		// the backlog snapshot are what report those.
		if (!Number.isFinite(dueAt)) {
			skipped++;
			continue;
		}

		const url = CacheKey.extractUrl(row.cacheKey);
		const fromSitemap = !!row.fromSitemap;
		const renderInterval = resolveRenderInterval(url, null);
		const lane = laneFor({ fromSitemap, renderInterval });

		// Lane 0 rows that DERIVE to lane 0 are already where they belong, so no write. On this corpus
		// that is only the fastest submitted band when it is also the first band, so it is a small
		// share — but writing them anyway would double the pass's write volume for no change.
		if (lane === 0) {
			skipped++;
			continue;
		}

		if (!byLane.has(lane)) byLane.set(lane, []);
		byLane.get(lane).push({ cacheKey: row.cacheKey, nextRenderTime: dueAt, fromSitemap, renderInterval });
		restamped++;
	}

	// Grouped by lane so each batch lowers ONE lane's watermark once, with that lane's minimum. A
	// single mixed batch would lower whichever lane owned the earliest row and leave the others'
	// watermarks above rows they now have to find — which is the stranding the funnel exists to
	// prevent, and it would be invisible until those lanes reported nothing due.
	for (const rowsForLane of byLane.values()) await writeRow(rowsForLane);

	return {
		examined,
		restamped,
		skipped,
		lanes: [...byLane.entries()].map(([lane, rowsForLane]) => ({
			lane,
			label: laneLabel(lane),
			rows: rowsForLane.length,
		})),
		// `examined < limit` is what proves the range is exhausted rather than merely capped: a full
		// window says only that more may remain. A pass that restamped nothing AND filled its window
		// is not done — it means every row it saw was already correct, and the next pass starts past
		// them only because they are no longer in the queried range.
		done: examined < limit,
	};
};

/** The one-condition query for rows nobody has stamped: everything below the first lane boundary. */
export const unstampedQuery = (limit) => ({
	// ONE CONDITION, matching the claim path's reasoning: a two-sided range on this index degrades to
	// a post-filter (measured 1,128-2,977 ms). `less_than` alone is a clean index range, and it is
	// sufficient because lane 0 is the bottom of the space.
	conditions: [{ attribute: 'nextRenderTime', comparator: 'less_than', value: LANE_STRIDE }],
	sort: { attribute: 'nextRenderTime' },
	// ARRAY select — a string `select` returns the bare scalar rather than a record.
	select: ['cacheKey', 'nextRenderTime', 'fromSitemap'],
	limit,
});

/** Whether a restamp is allowed to run right now, and why not if it is not. */
export const restampGuard = ({ force = false } = {}) => {
	if (force || !config.queue.lanes.enabled) return { allowed: true };
	return {
		allowed: false,
		reason:
			'queue.lanes.enabled is true, so a lane-0 row can no longer be told apart from a row an operator ' +
			'deliberately marked urgent — this pass would demote them. Run the restamp BEFORE enabling lanes ' +
			'(that is the documented rollout), or pass force: true if you accept that any in-flight urgent ' +
			'request loses its priority and renders on its normal cadence instead.',
	};
};
