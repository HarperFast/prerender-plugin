/**
 * THE ONLY MODULE IN `src/` THAT TOUCHES THE `RenderSchedule` TABLE.
 *
 * "One concept, one home" is not a style preference here, it is the safety mechanism. The claim
 * scan now starts from a FLOOR (`util/renderLease.js` explains why: seeking the absolute minimum
 * of the `nextRenderTime` index degraded 0.36 ms → 6.25 ms over 40,000 reschedules and did not
 * self-heal). A floor silently breaks any writer that files a row BELOW it — the row is inserted
 * behind the seek point and is never read again. That is the terminal render gap: a URL that
 * stops rendering forever, reports nothing, and is diagnosable only by hand. Read the module
 * comment at the top of `util/reconcile.js` for what that state cost the last time it existed.
 *
 * Before this module there were eight `RenderSchedule.put`/`delete` call sites across five
 * files, several of them writing `currentMinuteMs()` — i.e. exactly the writes a floor strands.
 * "Remember to lower the floor" cannot be the invariant; sixteen call sites do not remember.
 * So the due-time write and the floor lowering happen together, in one function, and a source
 * scan test (`test/queueFunnel.test.js`) fails the build if any other file in `src/` writes the
 * table.
 *
 * ── THE FLOOR RULE, WHICH IS THE WHOLE DESIGN ────────────────────────────────────────────────
 *
 *   floor_new = the due minute of the FIRST DUE ROW THE PASS OBSERVED — granted, skipped as
 *               already-leased, or refused for any other reason. If the pass observed no due
 *               row at all: `nowMinute - guard`.
 *
 * The obvious alternative — "floor = the last row I granted" — is WRONG, and wrong in the worst
 * possible way. Simulated over 1,189 rows with a 15% renderer-failure rate it stranded 167 rows
 * (14.0%, matching the failure rate exactly): every lease that expired without a posted result
 * sat BEHIND the advanced floor forever. The rule above stranded zero. The floor, not lease
 * expiry, is what guarantees a row gets re-read; a lease that expires below the floor expires
 * into nothing.
 *
 * Stating it as "the first due row observed" rather than as "min(last granted, oldest in-flight
 * lease)" — which is the same number — is deliberate: the first form cannot be computed from the
 * lease table, so it cannot be got wrong by walking the lease slots, and it can never advance
 * past something the pass saw. The `dueMinute` recorded in a lease slot is observability only;
 * the floor derivation never reads it.
 *
 * ── THE COMPARATOR IS INCLUSIVE, AND ON THE VALUE ───────────────────────────────────────────
 *
 * `greater_than_equal` on the due-time VALUE, single condition. Not exclusive, not `value + 1`,
 * not a rank, not "the next distinct index value". Ties are the NORM, not an edge case: at the
 * recorded corpus (~1.6M keys spread over a 24h interval) roughly 1,100 keys share every single
 * minute, and every one of the writers that files "due now" files the same minute. An exclusive
 * advance strands a whole minute — ~1,100 URLs — per pass. This is the single most likely
 * implementation bug in the change, and `test/renderQueueFloor.test.js` pins it with three rows
 * sharing one minute and `grantLimit: 1`.
 *
 * ── THE GUARD BAND ──────────────────────────────────────────────────────────────────────────
 *
 * `readFloorMinute` clamps the floor to `nowMinute - queue.claimFloor.guard` on every read. That
 * is what makes a "render this URL now" write safe from ANY node with no cross-node
 * coordination: the row is written at the current minute, and every node's floor is behind it by
 * construction. It costs one re-walk of the index entries in that window, which are created by
 * rows moving away from it at the render rate: 5 min × 200 renders/min × 0.15 µs ≈ 0.15 ms.
 * Self-limiting, because the window slides.
 *
 * ── THE PERIODIC RESET ──────────────────────────────────────────────────────────────────────
 *
 * `RenderSchedule` is `@export`ed and the Harper operations API reaches any table regardless, so
 * `PUT /RenderSchedule/<key>` and a UDS `update`/`upsert` write arbitrary due times with NO
 * PLUGIN CODE IN THE PATH. A funnel is necessary and not sufficient, and presenting it as the
 * invariant would be the trap. So worker 0 zeroes the floor every
 * `queue.claimFloor.resetInterval` (inside `syncQueueState`, under the claim mutex); the next
 * pass pays one seek from the absolute index minimum (measured 6.25 ms on an aged node) and
 * re-derives the true floor. That bounds stranding from PERMANENT to at most one interval — for
 * the documented `nextRenderTime = 1` trick, for replication catch-up delivering old due times
 * to a long-running node, and for a backwards clock step that outlasts the guard band. The
 * budget is 6.25 ms / 5 min per node, strictly cheaper than the `syncQueueState` head-seek this
 * change deletes (~700 ms/min on an aged node).
 *
 * `render.reconcile` is NOT a backstop for any of this: it tests row EXISTENCE only, so a
 * present-but-below-floor row is invisible to it, and it ships disabled in production.
 *
 * ── DELETES LOWER NOTHING AND RELEASE NOTHING ───────────────────────────────────────────────
 *
 * A vanished row strands nothing, because the floor is a VALUE and not a cursor. And a delete
 * deliberately does not release the key's lease: every delete here removes a row that was
 * claimed seconds ago, and releasing would let the floor advance past a row whose result may
 * still be arriving. The slot pins the floor for the remainder of the lease and then expires.
 *
 * ── THE ACCEPTED COST, STATED PLAINLY ───────────────────────────────────────────────────────
 *
 * The floor advances only as fast as the OLDEST DUE ROW leaves the due window, and the only thing
 * that moves a row is its own result. So the pin lasts until that row is written forward or deleted —
 * NOT "for one lease", which is the easy thing to assume and is wrong. A lease expiring changes
 * nothing here: `claim` writes nothing to the table, so the row is still due at the same minute and
 * the next pass derives the same floor from it. The periodic reset cannot recover it either — the row
 * IS the oldest due row, so re-deriving from the absolute minimum lands on the same value.
 *
 * The bounded cases: any result that reschedules (success, the slow retry lane, a redirect verdict,
 * a suppression recheck) moves its row, and the fast-retry lane holds its lease for at most
 * `render.failureRetry.fastRetries × queue.jobLeaseTime` before the slow lane writes the row forward.
 * The case that bounds NOTHING BY ITSELF is a row whose result never reschedules it: the
 * generic-failure branch in `resources/RenderQueue.js` (target exists → hold the lease, no schedule
 * write, no strike) is exactly that shape, and it is where every renderer crash, navigation timeout
 * and settle failure lands. One permanently failing URL in an 803k corpus would hold the floor at its
 * own minute forever, and dead index entries would then accumulate above that point at the full render
 * rate — the same degradation this design exists to remove (~43 ms/pass after a day at 200
 * renders/min), only worse than the 6.25 ms it replaces.
 *
 * So the pin is bounded HERE instead, by `maybeUnpinFloor`: a row that has held the floor for longer
 * than `queue.claimFloor.unpinAfter` is written forward one render interval by the claim path itself,
 * and named in a warning. That is deliberately a much smaller change than routing the branch through
 * `retryAfterFailure`'s lanes, and the reason is `strikes` — the SHARED target counter that suppression
 * and redirect verdicts delete targets on. Feeding the highest-volume failure path into it means a
 * broad origin outage walks the corpus toward deletion, which is the mass deletion the 401/403 guard
 * exists to prevent. The escape hatch touches `strikes` nowhere and changes no retry semantics: it
 * moves ONE row so the index can breathe, at a ceiling of one write per `unpinAfter` per node, because
 * unpinning one row promotes the next which must then hold for a full interval of its own.
 *
 * The pin is also NAMED throughout while it lasts: the pass reports `floorHeldBy` and
 * `floorPinnedForMs`, `claim` warns once the pin outlives what the retry lanes can explain, and the
 * console shows both beside the floor lag.
 *
 * `jobLeaseTime` is a LATENCY knob either way, not just a retry knob: during a broad origin 5xx event
 * or a bot-mitigation rule change EVERY job takes the fast-retry lane, which holds its lease on
 * purpose, so no lease is released at all for that window — the 14× win degrades back toward today's
 * cost exactly when the node is busiest. That is why the scan limit accommodates the in-flight pile
 * instead of trusting `limit: 20`.
 *
 * Downstream, a pinned floor shifts served-page age right for EVERY page type at once (a rising
 * stale-while-revalidate share and a right-shifted per-page-type age with no config change).
 * That simultaneity is the signature that distinguishes it from one template's cadence being
 * mis-set — without it an operator will spend the incident tuning `renderInterval`.
 */

import { setImmediate as yieldNow } from 'node:timers/promises';
import { config } from '../config.js';
import { getSab } from './coordination.js';
import { CacheKey } from './cacheKey.js';
import { resolveRenderInterval } from './routeClass.js';
import { MINUTE, numberOf } from './time.js';
import { LEASE_SAB_KEY, createLeaseTable, leaseBufferBytes, leaseSlotsIn } from './renderLease.js';
import { READY_SAB_KEY, createReadyQueue, readyBufferBytes, readyCapacityIn } from './readyQueue.js';
import { createTopK, scoreOf } from './renderPriority.js';

/**
 * The live lease table + claim floor, over one named buffer shared by every worker on this node.
 *
 * ALLOCATED ON FIRST USE, NEVER AT MODULE SCOPE. `queue.maxLeases` sizes the buffer, and module
 * scope is too early to read it: `extension.js` imports this module chain (RenderQueue → Target →
 * Sitemap → …) BEFORE it calls `applyOptions(scope.options.getAll())`, which is the rule stated at
 * the top of `src/config.js` — read `config.*` lazily, at request/timer time. Sized at module scope
 * it read the DEFAULT, so an operator who set `queue.maxLeases: 16384` still got 4,096 slots after a
 * restart, and the size assert below could not fire either, because both sides of its comparison
 * came from that same stale number. First use is a claim or a lease operation, always after options
 * are applied.
 *
 * The buffer is STILL sized once per process — the size of a named `getUserSharedBuffer` is fixed by
 * the first allocation, so a later worker asking for a different size gets a view of the first size.
 * That is why `queue.maxLeases` stays restart-scoped, and why a mismatch is logged loudly and then
 * honoured: indexing past a short buffer would be silent memory corruption, whereas deriving the slot
 * count from the buffer we actually got is merely a smaller table.
 *
 * It lives HERE rather than in `renderLease.js` so that module stays free of Harper globals and its
 * tests can run against a plain ArrayBuffer.
 */
let liveLeaseTable = null;

export const leaseTable = () => {
	if (liveLeaseTable) return liveLeaseTable;

	const wantedSlots = Math.max(1, config.queue.maxLeases | 0);
	// `getSab` is synchronous — `getUserSharedBuffer` hands back the buffer itself, not a promise —
	// which is what lets this be a plain accessor. An async one would have to be awaited from
	// `isLeased`, from the release path and from the console's O(1) reads, and the `await` it used to
	// carry at module scope was awaiting a non-promise.
	const buffer = getSab(LEASE_SAB_KEY, leaseBufferBytes(wantedSlots));

	if (buffer.byteLength !== leaseBufferBytes(wantedSlots)) {
		logger.error(
			`[prerender] render-lease buffer is ${buffer.byteLength} bytes but queue.maxLeases=${wantedSlots} wants ` +
				`${leaseBufferBytes(wantedSlots)}. The named shared buffer was sized by an earlier worker generation — ` +
				`this node runs with ${leaseSlotsIn(buffer.byteLength)} lease slots until it restarts. ` +
				`queue.maxLeases is restart-scoped for exactly this reason.`
		);
	}

	// `now` is passed as a wrapper rather than as the bare `Date.now` reference so the clock stays
	// LATE-BOUND: `createLeaseTable`'s default would capture the function object at this line, and a
	// test that swaps `Date.now` to walk past a lease expiry would then move the queue's clock but not
	// the lease table's — the two would silently disagree.
	liveLeaseTable = createLeaseTable({ buffer, slots: wantedSlots, now: () => Date.now() });
	return liveLeaseTable;
};

// Resolved per call rather than destructured at module load, matching `util/reconcile.js` and
// `util/backlogSnapshot.js`. This module is imported by almost everything (Target → Sitemap →
// RenderQueue → the handlers), so a module-scope capture would make the import order of the whole
// package depend on when `databases` was populated.
const scheduleTable = () => databases.render_schedule.RenderSchedule;

/**
 * The node's ready set, over one named buffer shared by every worker.
 *
 * Allocated on first use for the same reason `leaseTable` is: `queue.ready.capacity` sizes it, and
 * module scope precedes the host applying its options. Restart-scoped for the same reason too — a
 * named shared buffer's size is fixed by its first allocation, so a later worker asking for a
 * different size gets a view of the first size. A mismatch is logged loudly and then honoured, since
 * deriving the capacity from the buffer we actually got is merely a smaller set, and a smaller set
 * degrades to the fallback scan rather than to anything unsafe.
 */
let liveReadyQueue = null;

export const readyQueue = () => {
	if (liveReadyQueue) return liveReadyQueue;
	const wanted = Math.max(0, config.queue.ready.capacity | 0);
	const buffer = getSab(READY_SAB_KEY, readyBufferBytes(Math.max(1, wanted)));
	if (wanted > 0 && readyCapacityIn(buffer.byteLength) < wanted) {
		logger.error(
			`[prerender] ready-set buffer holds ${readyCapacityIn(buffer.byteLength)} entries but ` +
				`queue.ready.capacity=${wanted}. The named shared buffer was sized by an earlier worker generation — ` +
				`this node runs with the smaller set until it restarts. queue.ready.capacity is restart-scoped for ` +
				`exactly that reason; the only effect is that more claims fall through to the index scan.`
		);
	}
	liveReadyQueue = createReadyQueue({ buffer, now: () => Date.now() });
	return liveReadyQueue;
};

/** Minutes since the epoch. Every due time in the system is already minute-floored. */
export const minuteOf = (ms) => Math.floor(ms / MINUTE);

const guardMinutes = () => Math.max(0, Math.round(config.queue.claimFloor.guard / MINUTE));

/**
 * Lower the floor to cover `nextRenderTime`. Called by every write in this module, AFTER the row
 * has committed (see the ordering note on `writeSchedule`).
 *
 * A CAS-min, so the high-volume caller — `processJobResult` writing `now + interval` on every
 * completed render — costs one atomic load and changes nothing. That negative half is where the
 * 14× actually lives: a lowering on every completed render would rewind the floor to the current
 * minute continuously and the whole win would evaporate.
 */
const lowerFloorFor = (nextRenderTime) => {
	// `numberOf`, not `Number`: `Number(null)` is 0, 0 is finite, and `lowerFloorTo(0)` means NO FLOOR
	// — so a single missing due time would silently put the scan back to seeking the absolute index
	// minimum, which is the degraded 6.25 ms seek this whole release exists to remove. A REAL 0 still
	// unbounds it, on purpose (see `lowerFloorTo`); only absence is the bug.
	const at = numberOf(nextRenderTime);
	if (!Number.isFinite(at)) {
		// Not throwing: the row is already written, and a floor that stays where it is can only
		// strand THIS key, whereas throwing here would fail a caller that has committed.
		logger.warn(`[prerender] schedule write with a non-numeric nextRenderTime (${nextRenderTime}) — floor not lowered`);
		return;
	}
	leaseTable().lowerFloorTo(minuteOf(at));
};

/**
 * Write one schedule row and lower the floor to match.
 *
 * `fromSitemap` is REQUIRED, not optional: `put` REPLACES the record, so omitting it clears the
 * flag. `Target.revalidate` omitted it for as long as it has existed, which silently made every
 * revalidated key report `isFromSitemap: false` to the renderer — and the renderer skips
 * serializing a non-indexable sitemap-listed page. A required argument is how that stops being
 * possible.
 *
 * ORDER: row first, floor second — but be honest about what that does and does not buy. It does NOT
 * guarantee the row is visible before the floor invites a scan to look for it: `put` with no explicit
 * context joins the ambient transaction, which commits after the calling handler settles, so the row
 * becomes visible AFTER this function returns either way. What actually covers the hazard is the
 * GUARD BAND — the floor is clamped `queue.claimFloor.guard` behind the current minute on every read,
 * and every caller here writes the current minute or later, so the row is above the floor by
 * construction and stays claimable however late it lands. A floor lowered for a row not yet visible
 * costs at most one pass that finds nothing at that minute. The order stays this way because it is
 * the free direction, not because it is the invariant.
 *
 * NOT wrapped in a deadline, ever. See the module comment in `resources/Target.js`: a write to a
 * residency-pinned key this node does not own does NOT block on the owner (measured: 500 writes
 * in 10.7 ms, mean 0.021 ms, against residency pinned to a node that does not exist). v0.15.0
 * assumed the read/write symmetry and wrapped these in a deadline that could never fire.
 */
export const writeSchedule = async (cacheKey, { nextRenderTime, fromSitemap, effectiveInterval } = {}) => {
	if (fromSitemap === undefined) {
		throw new Error(`writeSchedule(${cacheKey}) needs an explicit fromSitemap — put replaces the record`);
	}
	// REQUIRED FOR THE SAME REASON, AND IT IS THE SAME HAZARD. `put` replaces the record, so a writer
	// that omits this does not leave the old value alone — it ERASES a correct cadence off a row that
	// had one, and the ready-set sweep then scores that page against its route ceiling instead of its
	// ladder rung. `null` is the legitimate explicit answer for a writer with no cadence in hand (a
	// render-now one-off has no cadence at all); what must not be possible is forgetting.
	if (effectiveInterval === undefined) {
		throw new Error(`writeSchedule(${cacheKey}) needs an explicit effectiveInterval — put replaces the record`);
	}
	await scheduleTable().put(cacheKey, { nextRenderTime, fromSitemap, effectiveInterval });
	lowerFloorFor(nextRenderTime);
};

/**
 * The batch form, for the fan-out writers (a target's device variants, `Target.revalidate`,
 * sitemap ingest, a reconcile repair pass). Writes every row, then lowers the floor ONCE with
 * the batch minimum — a per-row atomic inside the very loop that exists to keep transactions
 * short would be the wrong shape even though it is cheap.
 *
 * Sequential, matching the call sites it replaces: `Target.put`'s device loop awaited each row,
 * and `reconcile`'s phase 2 does too. Rows are independent, so a rejection propagates with the
 * earlier rows applied — the same semantics as before, and deletes/puts here are idempotent.
 */
export const writeSchedules = async (rows = []) => {
	let lowest = Number.POSITIVE_INFINITY;
	for (const { cacheKey, nextRenderTime, fromSitemap, effectiveInterval } of rows) {
		if (fromSitemap === undefined) {
			throw new Error(`writeSchedules(${cacheKey}) needs an explicit fromSitemap — put replaces the record`);
		}
		if (effectiveInterval === undefined) {
			throw new Error(`writeSchedules(${cacheKey}) needs an explicit effectiveInterval — put replaces the record`);
		}
		await scheduleTable().put(cacheKey, { nextRenderTime, fromSitemap, effectiveInterval });
		// Same trap as `lowerFloorFor`, and WORSE here: with a bare `Number` a single null row anywhere
		// in the batch becomes 0, wins the minimum, and unbounds the floor for the whole fan-out.
		const at = numberOf(nextRenderTime);
		if (Number.isFinite(at) && at < lowest) lowest = at;
	}
	if (lowest !== Number.POSITIVE_INFINITY) lowerFloorFor(lowest);
};

/** Drop a schedule row. Lowers nothing, releases nothing — see the module comment. */
export const deleteSchedule = async (cacheKey) => {
	await scheduleTable().delete(cacheKey);
};

/**
 * A node-local point read. `replicateFrom: false` is not optional on this table: it is
 * residency-pinned, so a point read of a key this node does not own takes Harper's replication
 * fetch, which has NO TIMEOUT and can hang the caller forever.
 */
export const getScheduleRow = (cacheKey, select) =>
	scheduleTable().get({ id: cacheKey, select }, { replicateFrom: false });

// ---- the claim pass -------------------------------------------------------------------------

/**
 * ONE claim pass, with all I/O injected so the floor algebra is testable with no Harper at all.
 *
 * `searchSchedules({ floorMinute, limit })` returns an async iterable of rows projected to
 * `{ cacheKey, nextRenderTime, fromSitemap }`.
 *
 * `floorRule` exists solely so the regression test can drive the SAME trace through the rejected
 * `'last-granted'` rule and assert that it strands rows. Production never sets it.
 */
export const runClaimPass = async ({
	searchSchedules,
	leases,
	nowMs = Date.now(),
	grantLimit = 20,
	guardMinutes: guard = 5,
	scanCap = 1000,
	leaseTimeMs,
	floorEnabled = true,
	floorRule = 'first-due-observed',
} = {}) => {
	const nowMinute = minuteOf(nowMs);
	const floorFrom = floorEnabled ? leases.readFloorMinute(nowMinute, guard) : 0;

	// A leased row keeps its overdue position in the index now, so the pass must read PAST the
	// in-flight pile to find grantable rows: grantLimit to cover the pile's own head, the pile
	// itself, and grantLimit to actually grant. Capped, because during a broad failure event the
	// pile is the entire fleet's worth of jobs and this must not become an unbounded read.
	const scanLimit = Math.min(grantLimit + leases.occupancy() + grantLimit, scanCap);

	// DRAIN THE WHOLE ITERABLE FIRST. No write, no Atomics store and no lease grant while the
	// cursor is open: Harper's long-transaction monitor ABORTS (and poisons) a transaction that
	// has pending writes when it fires, and a cursor left open across writes is exactly that
	// shape (see util/scan.js). And no `break` out of the `for await` either — an abandoned
	// iterator leaves its read transaction unreleased (util/reconcile.js:60-64). The app-side cut
	// at "past now" is applied to the drained array below, not by walking away from the cursor.
	const rows = [];
	for await (const row of searchSchedules({ floorMinute: floorFrom, limit: scanLimit })) rows.push(row);

	const jobs = [];
	let sawDue = false;
	let firstDueMinute = null;
	// The key of that first due row. The floor rule is defined by which ROW the pass saw first, and
	// nothing else in the system can name it: `claim` writes nothing, so a row that never completes
	// holds the floor at its own minute indefinitely and the only evidence is this. Reported so the
	// warning and the console can say WHICH URL, instead of "something is wedged".
	let floorHeldBy = null;
	// ...and the row itself, because the unpin escape hatch has to REWRITE it, and `put` replaces the
	// record — so it needs the `fromSitemap` flag this pass already projected. Re-reading the row to
	// recover a flag that was in hand is how `Target.revalidate` silently cleared it for a year.
	let floorHeldByRow = null;
	let lastGrantedMinute = null;
	let earliestNotYetDueMinute = 0;
	let leaseRefused = false;
	let skippedLeased = 0;
	let nonFinite = 0;

	for (const row of rows) {
		// `numberOf` because `Number(null)` is 0, which reads as "due since 1970" and would make an
		// absent due time the oldest due row in the corpus — pinning the floor at the epoch and naming
		// the wrong key as the row holding it. A missing due time is skipped and counted, not coerced.
		const at = numberOf(row.nextRenderTime);
		if (!Number.isFinite(at)) {
			nonFinite++;
			continue;
		}

		if (at > nowMs) {
			earliestNotYetDueMinute = minuteOf(at);
			break;
		}

		sawDue = true;
		const dueMinute = minuteOf(at);
		// Recorded for the FIRST due row regardless of what happens to it — that is the floor rule.
		if (firstDueMinute === null) {
			firstDueMinute = dueMinute;
			floorHeldBy = row.cacheKey;
			floorHeldByRow = {
				cacheKey: row.cacheKey,
				dueMinute,
				fromSitemap: !!row.fromSitemap,
				// Carried so the unpin hatch can PRESERVE it: `put` replaces the record, so a push that
				// rewrote this row without the field would strip the cadence off the one row already known
				// to be in trouble.
				effectiveInterval: row.effectiveInterval,
			};
		}

		if (leases.isLeased(row.cacheKey)) {
			skippedLeased++;
			continue;
		}
		if (jobs.length >= grantLimit) break;

		const expiresAtMs = nowMs + leaseTimeMs;
		if (!leases.grant(row.cacheKey, { dueMinute, leaseExpiryMs: expiresAtMs })) {
			// No slot, no job. A granted-but-unrecorded job is a double render AND an untracked
			// hold on the floor; refusing to hand it out is the only safe answer.
			//
			// "Refused", not "table full": `grant` also returns false when its publish CAS lost a race
			// for the slot, and reporting that as "every lease slot is in use" sends the operator to
			// raise `queue.maxLeases` over a full probe window (8 slots) or a lost CAS.
			leaseRefused = true;
			break;
		}
		lastGrantedMinute = dueMinute;
		jobs.push({ cacheKey: row.cacheKey, dueMinute, expiresAtMs, fromSitemap: !!row.fromSitemap });
	}

	const observed = floorRule === 'last-granted' ? lastGrantedMinute : firstDueMinute;
	const floorTo = Math.max(0, observed ?? nowMinute - guard);

	let floorAdvanced = false;
	if (floorEnabled) {
		// CAS against the value this pass started from, and ABANDON on conflict — a conflict means
		// a funnel write lowered the floor for a row this pass never saw. The next pass re-advances.
		floorAdvanced = leases.advanceFloor(floorFrom, floorTo);
	} else {
		// The kill switch forces the floor to 0 and changes nothing else, so re-enabling it starts
		// from a full seek rather than from a value that has been going stale.
		leases.resetFloor();
	}

	leases.recordPassOutcome({ sawDue, earliestNotYetDueMinute });

	// How long the SAME row has been holding the floor, node-wide. Recorded here rather than derived
	// by a caller because this is the only place that knows which row the floor rule actually picked,
	// and it is what both the wedged-row warning and the unpin escape hatch key off. `null` clears it,
	// so a pass that finds nothing due does not leave a stale pin ageing forever.
	const floorPinnedForMs = leases.notePinnedBy(floorHeldBy);

	return {
		jobs,
		sawDue,
		granted: jobs.length,
		skippedLeased,
		nonFinite,
		earliestNotYetDueMinute,
		floorFrom,
		floorTo,
		floorHeldBy,
		floorHeldByRow,
		floorPinnedForMs,
		floorAdvanced,
		scanned: rows.length,
		scanLimit,
		// BOTH HALVES. A full window on its own says nothing: the query is deliberately ONE-SIDED, so
		// on any real corpus every row above the floor matches and the window fills on a perfectly
		// healthy, caught-up node — `rows.length >= scanLimit` alone is true essentially always, and
		// the warning it drove fired when the node was IDLE and went quiet when it was busy. The window
		// is only genuinely truncated if the drain never reached a not-yet-due row; reaching one proves
		// there was nothing more to grant beyond it.
		scanTruncated: rows.length >= scanLimit && earliestNotYetDueMinute === 0,
		leaseRefused,
		occupancy: leases.occupancy(),
	};
};

/**
 * The cacheKey of the row the claim floor is being held at, as observed by the last claim pass ON
 * THIS WORKER, with when that pass ran.
 *
 * Per worker, deliberately, and labelled as such wherever it is shown: the pass result is not shared
 * across workers (only the buffer is), so a worker that has not claimed recently reports `null`
 * rather than somebody else's answer. `null` also legitimately means "the last pass saw no due row",
 * i.e. nothing is holding the floor.
 */
/**
 * The cadence a schedule row carries, or `null` when it carries none.
 *
 * One helper rather than the check inlined twice, because the two callers must agree: the sweep
 * divides lateness by this to score, and `maybeUnpinFloor` pushes a wedged row forward by it. If
 * they resolved a cadence differently the push distance would stop matching the number the row was
 * ranked by. `Number` first for the BigInt-from-`Long` coercion; `> 0` rejects null/NaN/negatives.
 */
/**
 * How often the walk consults the clock. Not a tuning knob — it only bounds the OVERSHOOT past the
 * time budget: at ~55us/row, 32 rows is ~1.8ms of granularity, so a 2ms budget yields somewhere in
 * 2-4ms. Lowering it buys precision nobody needs; raising it makes the budget a suggestion.
 */
const YIELD_CHECK_ROWS = 32;

const carriedCadence = (effectiveInterval) => {
	const ms = Number(effectiveInterval);
	return Number.isFinite(ms) && ms > 0 ? ms : null;
};

let lastFloorHeldBy = null;
let lastFloorHeldByAt = 0;

/**
 * THE UNPIN ESCAPE HATCH. Write the row that has held the claim floor for longer than
 * `queue.claimFloor.unpinAfter` forward by one render interval, so the floor can finally advance
 * past it. Returns what it did, or `null`.
 *
 * WHY THIS EXISTS. The floor cannot advance past the oldest DUE ROW, and the only thing that moves a
 * row is its own result — a lease expiring does not, because claiming writes nothing. The
 * generic-failure branch in `resources/RenderQueue.js` (target exists → hold the lease, write no row,
 * no strike) is therefore genuinely unbounded: every renderer crash, navigation timeout and settle
 * failure lands there, and one such URL in an 803k corpus pins the floor at its own minute forever
 * while dead index entries pile up above it at the full render rate — measured at ~43 ms/pass after a
 * day, i.e. WORSE than the 6.25 ms unfloored scan this whole design replaces. The periodic reset
 * cannot help: that row IS the oldest due row, so re-deriving from the absolute minimum lands on the
 * same value.
 *
 * WHY IT DOES NOT GO THROUGH `retryAfterFailure`, WHICH IS THE OBVIOUS FIX. Those lanes are counted
 * by `strikes`, and `strikes` is the target's ONE SHARED counter that `Target.suppress` and the
 * redirect verdicts delete targets on at `maxStrikes`. Feeding the highest-volume failure path into it
 * means a broad origin outage — where every job fails at once — walks the whole corpus toward
 * deletion, which is the exact mass-deletion the 401/403 guard exists to prevent. So this touches
 * `strikes` nowhere, changes no retry semantics, and does one thing only: moves ONE row so the index
 * can breathe.
 *
 * IT IS SELF-RATE-LIMITING, which is why it needs no throttle of its own. It fires on the floor
 * HOLDER, and only after that holder has held for `unpinAfter`; unpinning row A promotes row B, which
 * must then hold for another full `unpinAfter` before it qualifies. So the ceiling is one write per
 * `unpinAfter` per node — 24/day at the default — even during a sustained outage in which every single
 * job takes the unbounded branch. It is a fix for index degradation, not a throughput rescue.
 *
 * The write goes through `writeSchedule`, so `fromSitemap` is preserved from the row the pass already
 * projected (`put` REPLACES the record) and the floor lowering rides along — a CAS-min against a
 * future minute, so it changes nothing. A failure here is logged and swallowed: the claim must not 500
 * because a repair could not be written, and the next pass simply tries again.
 */
const maybeUnpinFloor = async (pass) => {
	const unpinAfter = config.queue.claimFloor.unpinAfter;
	if (!(unpinAfter > 0)) return null;
	if (!config.queue.claimFloor.enabled) return null;
	if (!pass.floorHeldByRow || !(pass.floorPinnedForMs >= unpinAfter)) return null;

	const { cacheKey, fromSitemap, effectiveInterval } = pass.floorHeldByRow;
	// ONE RENDER INTERVAL, RESOLVED THE WAY EVERY OTHER SCHEDULE WRITER RESOLVES IT — not a flat
	// `render.defaultInterval`. Two reasons, and the second one is a bug this used to cause:
	//
	//   - It is the right distance. A 1h-cadence row pushed a full day is a day of that URL not
	//     rendering; a 48h-cadence row pushed only 24h comes back due long before its own cadence.
	//   - `nextRenderTime - interval` IS HOW A COMPLETION IS READ BACK OUT OF A ROW, because every
	//     other writer files `completionMinute + interval`. A flat `now + defaultInterval` here
	//     manufactured a completion that never happened — on a 48h route the row read as "rendered 24h
	//     ago", on a 1h route as "rendered in the future" — so this was the one writer whose rows lied
	//     to that arithmetic. Nothing on this branch performs it yet, which is exactly why it is worth
	//     fixing now: the row is the only record, it outlives the pass that wrote it, and a later
	//     reader has no way to know this particular value was synthetic.
	//
	// THE ROW'S OWN CADENCE FIRST, which closes a residual this comment used to have to state. Reading
	// the Target from the funnel is still out of the question — a point read on the claim path, and an
	// import cycle (`resources/Target.js` imports this module) — but the cadence now travels ON the row,
	// so the push distance matches what the writer actually scheduled by, including a demand-ladder rung
	// that config cannot see at all. Falling back to route > default leaves the old residual only for
	// rows written before this field existed: a target whose STORED interval differs from the default
	// with no route interval to override it is pushed by that difference. Cost of that residual is one
	// extra render per crawl of one URL, rate-limited by the accelerator's own budget.
	const interval = carriedCadence(effectiveInterval) ?? resolveRenderInterval(CacheKey.extractUrl(cacheKey), null);
	const nextRenderTime = Date.now() + interval;
	try {
		// `interval`, NOT the raw `effectiveInterval` off the row — and the difference is a silent
		// regression that only shows up on the first deploy. Every row written before this field existed
		// carries `undefined`, which the funnel now REFUSES; the refusal lands inside this try, is logged
		// and swallowed, and the hatch does nothing while looking healthy. So on a node where no row has
		// re-rendered yet — i.e. every node, for one full cadence after an upgrade — the one mechanism
		// that bounds a wedged row would have been dead. Filing the resolved cadence instead also keeps
		// `nextRenderTime - effectiveInterval === now`, the arithmetic the comment above is about, and
		// leaves the row self-describing for the next sweep.
		await writeSchedule(cacheKey, { nextRenderTime, fromSitemap, effectiveInterval: interval });
	} catch (e) {
		logger.error(e, `[prerender] could not unpin the claim floor from ${cacheKey}`);
		return null;
	}

	// Clear the pin so the promoted row starts its own clock from this pass rather than inheriting
	// this one's age — without it the next pass would qualify immediately and unpin a healthy row.
	leaseTable().notePinnedBy(null);

	logger.warn(
		`[prerender] ${cacheKey} held the claim queue's floor for ${Math.round(pass.floorPinnedForMs / 60_000)} minute(s) ` +
			`without ever being rescheduled — rendering it is failing in a way that posts no result (crash, navigation ` +
			`timeout or settle failure), so it has been pushed to ${new Date(nextRenderTime).toISOString()} to let the ` +
			`queue advance. Nothing behind it was rendering while it was pinned. Investigate this URL: the push repeats ` +
			`every render interval until it renders or is deleted, and no strike was counted against it.`
	);
	return { cacheKey, pinnedForMs: pass.floorPinnedForMs, nextRenderTime };
};

/**
 * THE ONE QUERY SHAPE, shared by the claim scan and the ready-set sweep.
 *
 * Extracted rather than written twice because the two callers must agree about it exactly: they read
 * the same index for the same rows, and a difference between them would show up as the sweep and the
 * fallback disagreeing about what is due — which is unfalsifiable from either site.
 */
const searchSchedulesFrom = ({ floorMinute, limit }) =>
	scheduleTable().search(
		{
			// EXACTLY ONE CONDITION, and it stays present even at floorMinute 0 (`>= 0` is the
			// same seek-from-the-absolute-minimum). Dropping the conditions array entirely
			// would leave Harper to inject its own primary-key full-scan condition beside a
			// sort on a secondary attribute, and whether that still resolves to an
			// index-ordered walk of `nextRenderTime` is unverified — on 1.6M rows a wrong
			// answer there is a full table scan plus a sort on the claim path.
			//
			// ONE-SIDED, AND A TWO-SIDED RANGE IS NOT A SAFE ALTERNATIVE HERE. Adding the
			// `<= now` half measures fine (0.74 ms) only while the window can FILL the limit.
			// Measured on 400k rows when it cannot — which is the normal steady state, "nothing
			// is due" — it costs 1,128–2,977 ms: only the FIRST condition becomes the index
			// range and the second is applied as a post-filter, so the cost is O(rows above the
			// lower bound) rather than O(window), and the limit can never short-circuit it.
			// That is a ~480× regression on the claim path, in the state the queue spends most
			// of its time in. The `<= now` half stays in application code, where it is free.
			// (On a PRIMARY key a two-sided range collapses to a filtered intersection —
			// 289–1490 ms — which is why the shape of this query is worth a comment at all.)
			conditions: [{ attribute: 'nextRenderTime', comparator: 'greater_than_equal', value: floorMinute * MINUTE }],
			sort: { attribute: 'nextRenderTime' },
			// ARRAY select. A string `select` returns the bare scalar rather than a record —
			// the trap that has caused two silent bugs in this package already.
			//
			// `effectiveInterval` rides along so the sweep can score a row without a per-row read of
			// RenderTarget — which on a residency-pinned table would be a replication fetch for ~75% of
			// keys, over the whole due set. The claim path shares this select and ignores the field: one
			// more decoded Long across `queue.claimScanCap` rows, against the guarantee that the two
			// paths cannot drift onto different queries.
			select: ['cacheKey', 'nextRenderTime', 'fromSitemap', 'effectiveInterval'],
			limit,
		},
		{ replicateFrom: false }
	);

/** `runClaimPass` bound to the live table and config — the FALLBACK path behind the ready set. */
const claimFromIndex = async ({ grantLimit } = {}) => {
	const pass = await runClaimPass({
		searchSchedules: searchSchedulesFrom,
		leases: leaseTable(),
		nowMs: Date.now(),
		grantLimit,
		guardMinutes: guardMinutes(),
		scanCap: Math.max(1, config.queue.claimScanCap | 0),
		leaseTimeMs: config.queue.jobLeaseTime,
		floorEnabled: config.queue.claimFloor.enabled,
	});

	// Whatever this pass saw, including `null` for "nothing is due": a stale key here would name an
	// innocent URL as the thing pinning the queue.
	lastFloorHeldBy = pass.floorHeldBy;
	lastFloorHeldByAt = Date.now();

	// AFTER the pass, never inside it: `runClaimPass` takes all its I/O as arguments precisely so the
	// floor algebra has no database in it, and a write issued mid-pass would also be a write with the
	// scan cursor still open (see the drain note above).
	const floorUnpinned = await maybeUnpinFloor(pass);
	return floorUnpinned ? { ...pass, floorUnpinned } : pass;
};

/**
 * THE SWEEP — score the whole due set and publish the best of it.
 *
 * This is the part that makes priority possible at all, and the reason it can exist is one measured
 * fact — CORPUS-DEPENDENT, see `util/renderPriority.js`: a projected one-sided read is ~2.4 us/row on
 * a fresh bench corpus but ~55 us/row on production's churned one, and yielding
 * every 200 rows costs nothing. So 200,000 rows cost ~480 ms and a 500k-row overdue set ~1.2 s — on a
 * timer, off the claim path, with zero writes. The claim path meanwhile stops reading the index at
 * all. Reads are 2.4 us and writes are 76-89 us; reading liberally and writing not at all is the
 * cheap direction.
 *
 * ── IT OWNS THE FLOOR NOW, AND THAT IS NOT INCIDENTAL ─────────────────────────────────────────
 *
 * The claim floor only advances when something OBSERVES the head of the index. Once claims are served
 * from memory they observe nothing, so a floor left to the claim path would freeze — and a frozen
 * floor is precisely the degradation it exists to prevent: measured, an unfloored seek goes 0.073 ->
 * 5.60 ms over 40,000 reschedules while a floored one stays flat at 0.07 ms. So the sweep applies the
 * same floor rule the claim pass applies, and it is strictly better informed while doing it: it
 * observes EVERY due row rather than a window, so "the first due row observed" is the true minimum
 * rather than the minimum of a window.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────────────────────
 *
 * No writes, no lease grants, and no `<= now` in the query. The cut at "past now" is applied in
 * application code because the two-sided form is 256x slower when its limit cannot fill (739 ms
 * against 2.89 ms, measured) — which is the state a caught-up queue is in essentially always.
 *
 * It also does not skip leased rows. A row being rendered right now is still a row that is due, and
 * excluding it would let the floor advance past a lease whose result has not landed. It is scored,
 * published, and refused at grant time by the lease CAS — one wasted array slot, versus a floor rule
 * that no longer holds.
 */
export const sweepReadySet = async ({ nowMs = Date.now() } = {}) => {
	const { enabled, capacity, sweepCap, sitemapBoost } = config.queue.ready;
	if (!enabled || capacity <= 0) return { skipped: 'disabled' };

	const queue = readyQueue();
	if (queue.capacity === 0) return { skipped: 'no-capacity' };

	const leases = leaseTable();
	const nowMinute = minuteOf(nowMs);
	const floorEnabled = config.queue.claimFloor.enabled;
	const floorFrom = floorEnabled ? leases.readFloorMinute(nowMinute, guardMinutes()) : 0;
	const cap = Math.max(1, sweepCap | 0);

	const heap = createTopK(queue.capacity);
	// THE FALLBACK PATH ONLY. A row that carries its own `effectiveInterval` never reaches this — no URL
	// parse, no route walk — so once the corpus has re-rendered once this memo serves the remainder:
	// pre-upgrade rows and the writers with no cadence in hand.
	//
	// Route resolution parses a URL and walks the route list, and a URL's device variants share both —
	// so this memo halves the work at minimum, on the one loop that sees every due row on the node.
	// Per sweep rather than process-lifetime: the route list is live-reloadable, and a cache keyed by
	// URL over an 814k-target corpus to serve one sweep is the unbounded-structure mistake this node
	// has already been taken down by twice.
	const intervals = new Map();
	const intervalFor = (url) => {
		let interval = intervals.get(url);
		if (interval === undefined) {
			interval = resolveRenderInterval(url, null);
			intervals.set(url, interval);
		}
		return interval;
	};

	// Time budget for one uninterrupted slice of the walk. Read once per sweep: a live change applies
	// to the next sweep, and re-reading config inside the loop is work per row for no benefit.
	const yieldBudgetMs = Math.max(1, config.queue.ready.yieldBudget | 0);
	let lastYieldAt = performance.now();
	let scanned = 0;
	let due = 0;
	let nonFinite = 0;
	// How much of the due set could be scored against its REAL cadence. Reported because it is the only
	// way to see the backfill land: this reads 0 on the first sweep after an upgrade and climbs toward
	// `due` as rows re-render, and a value that stays low means writers are filing rows without a
	// cadence rather than that the field is not working.
	let cadenceCarried = 0;
	let firstDueMinute = null;
	let firstDueKey = null;
	let firstDueRow = null;
	let earliestNotYetDueMinute = 0;
	let reachedNotYetDue = false;

	// NO WRITES AND NO ATOMICS INSIDE THE LOOP. Harper's long-transaction monitor aborts a transaction
	// that has pending writes when it fires, and a cursor left open across writes is that shape; the
	// publish below is atomics-only and happens after the cursor is done.
	//
	// IT DOES BREAK EARLY, and the comment this replaces said it must not. That claim conflated two
	// different things. An ABANDONED iterator — one driven by hand with `.next()` and never returned —
	// does hold its read transaction open: Harper's own long-transaction test
	// (`integrationTests/database/longtxn-secondary-index`) uses exactly that as its mechanism, and
	// states the contract: a `search()` iterator marks the read txn in use and releases it only when
	// FULLY CONSUMED. But `for await ... of` is not that. On `break` the language calls
	// `iterator.return()`, and Harper's search iterator implements it (`resources/Table.ts`):
	//
	//     return() { if (results.onDone) results.onDone(); return dbIterator.return(); }
	//
	// where `onDone` is what calls `txn.doneReadTxn()`. `throw()` does the same. So breaking releases
	// the transaction on the same path a full drain does.
	//
	// WHY IT MATTERS ENOUGH TO REVISIT: the query is one-sided (`>= floor`), so after the due rows it
	// keeps returning rows that are NOT yet due, and the old code read every one of them to the cap
	// and discarded them. Measured on the production corpus (RocksDB, 4 nodes, 2026-08-21): ~300k due
	// rows against a 500k cap, so ~198k rows — 40% of the scan — were read to be thrown away, about
	// 11s of a 27s sweep. At the ~2.4us/row the bench measured on a FRESH corpus that waste was ~0.5s
	// and draining was the free, obviously-safe choice; at the ~55us/row a churned 1.3M-row corpus
	// actually costs, it is the single largest cost in the sweep. And the
	// caught-up case, which is where the queue spends most of its time, goes from reading `cap` rows to
	// reading one.
	for await (const row of searchSchedulesFrom({ floorMinute: floorFrom, limit: cap })) {
		scanned++;
		const dueAt = numberOf(row.nextRenderTime);
		if (!Number.isFinite(dueAt)) {
			nonFinite++;
			continue;
		}
		if (dueAt > nowMs) {
			// Rows arrive ascending, so the FIRST not-yet-due row means the due set is exhausted and
			// every remaining row in the window is also not due. Nothing after this point can change
			// the ranking, the floor, or any counter — so stop reading.
			//
			// ITS MINUTE IS CARRIED, not discarded. `deriveQueueStatus` uses it to flip a node from
			// `empty` to `queued` the moment that minute arrives, with zero database cost — so a sweep
			// that reported 0 here would WIPE that (it runs every minute and overwrites whatever the
			// claim pass recorded), and a node with nothing due but a row due in thirty seconds would
			// tell the whole fleet to go idle. Breaking on the first such row is what makes this the
			// EARLIEST one, which is the value that flip needs.
			earliestNotYetDueMinute = minuteOf(dueAt);
			reachedNotYetDue = true;
			break;
		}
		due++;
		if (firstDueMinute === null) {
			firstDueMinute = minuteOf(dueAt);
			firstDueKey = row.cacheKey;
			// The row itself, because `maybeUnpinFloor` has to REWRITE it and `put` replaces the record —
			// so it needs the `fromSitemap` flag this sweep already has in hand. Re-reading the row to
			// recover a flag that was in hand is how `Target.revalidate` silently cleared it for a year.
			firstDueRow = {
				cacheKey: row.cacheKey,
				dueMinute: firstDueMinute,
				fromSitemap: !!row.fromSitemap,
				effectiveInterval: row.effectiveInterval,
			};
		}
		// THE ROW'S OWN CADENCE, NOT THE ROUTE'S. They differ wherever the demand ladder has promoted a
		// target beneath its route ceiling — a `/catalog/` page on the 6h rung is scheduled 6h out while
		// the route still grants 24h, so resolving from config alone would divide by 24h and report a
		// quarter of its true lateness, on exactly the pages the ladder singled out as worth rendering
		// more often. Config resolution stays as the fallback for rows that carry nothing.
		const carried = carriedCadence(row.effectiveInterval);
		if (carried !== null) cadenceCarried++;
		const intervalMs = carried ?? intervalFor(CacheKey.extractUrl(row.cacheKey));
		const score = scoreOf({ dueAt, fromSitemap: !!row.fromSitemap }, { nowMs, intervalMs, sitemapBoost });
		heap.offer(score, { cacheKey: row.cacheKey, dueAt, fromSitemap: !!row.fromSitemap });
		// YIELD ON ELAPSED TIME, NOT ON A ROW COUNT — and the difference is the whole point of this
		// clause. It used to yield every 200 rows, chosen when `bench/queue-index` said a row cost
		// ~2.4us: 200 rows was ~0.5ms of held loop, invisible next to a ~1.6ms cache hit. On the real
		// corpus a row costs ~55us, so the same 200 rows hold the loop for ~11ms — and this worker also
		// serves bot traffic, so every request landing inside that slice waits for it. A row count
		// cannot express "do not stall a request"; a time budget can, and it re-derives itself when the
		// per-row cost moves instead of needing a constant re-tuned by hand.
		//
		// The clock is read every `YIELD_CHECK_ROWS` rows rather than every row. `performance.now()` is
		// tens of nanoseconds against ~55us of work, so per-row would be free TODAY — but the reason
		// this clause is being rewritten at all is that a per-row cost moved 20x, and at 2.4us/row a
		// per-row clock read would be ~2%. Sampling costs nothing and does not care.
		if (scanned % YIELD_CHECK_ROWS === 0 && performance.now() - lastYieldAt >= yieldBudgetMs) {
			await yieldNow();
			lastYieldAt = performance.now();
		}
	}

	const published = queue.publish(heap.drainDescending(), { scannedRows: scanned });

	// THE FLOOR, on the same rule the claim pass uses: the due minute of the first due row observed,
	// or `nowMinute - guard` when nothing was due. CAS against the value this sweep started from and
	// abandon on conflict — a conflict means a funnel write lowered the floor for a row this sweep
	// never saw, and re-advancing over it would strand that row until the next sweep.
	let floorAdvanced = false;
	if (floorEnabled) {
		floorAdvanced = leases.advanceFloor(floorFrom, Math.max(0, firstDueMinute ?? nowMinute - guardMinutes()));
	}
	leases.recordPassOutcome({ sawDue: due > 0, earliestNotYetDueMinute });

	// THE SWEEP TOOK OVER OBSERVING THE INDEX, SO IT HAS TO TAKE OVER THE REPORTING THAT DEPENDS ON
	// OBSERVING IT. The pin age only advances when something calls `notePinnedBy`, and the wedged-row
	// warning and `maybeUnpinFloor` both key off it — so on a node serving every claim from the ready
	// set, neither would ever fire and a permanently failing URL would pin the floor with no warning
	// and no automatic push. That is precisely the unbounded case `queue.claimFloor.unpinAfter` exists
	// to bound, so it cannot be allowed to depend on which path served the last claim.
	const floorPinnedForMs = leases.notePinnedBy(firstDueKey);
	// ...and the KEY, for the same reason. `floorState` reads this, so a stale value would name an
	// innocent URL as the thing pinning the queue.
	lastFloorHeldBy = firstDueKey;
	lastFloorHeldByAt = Date.now();

	// AFTER the cursor is closed, never inside the drain: the hatch WRITES, and a write issued with a
	// scan cursor still open is the shape Harper's long-transaction monitor aborts.
	const floorUnpinned = await maybeUnpinFloor({
		floorHeldByRow: firstDueRow,
		floorPinnedForMs,
		floorTo: firstDueMinute,
	});

	return {
		scanned,
		due,
		nonFinite,
		cadenceCarried,
		published,
		capacity: queue.capacity,
		floorFrom,
		floorAdvanced,
		floorPinnedForMs,
		floorUnpinned,
		earliestNotYetDueMinute,
		firstDueKey,
		// `scanned >= cap` alone says nothing — the query is one-sided, so on any real corpus the window
		// fills. Reaching a not-yet-due row is what proves the due set was seen to its end, and only its
		// absence means the sweep was truncated and the ordering is over a prefix of the backlog.
		truncated: scanned >= cap && !reachedNotYetDue,
	};
};

/**
 * Grant up to `grantLimit` jobs — the ready set first, the index scan for whatever is left.
 *
 * THE FALLBACK IS THE WHOLE SAFETY ARGUMENT. A cold set (a fresh worker generation), an exhausted one
 * (claims outrunning the sweep), a disabled one, or a buffer sized to nothing all land on
 * `claimFromIndex`, which is the path this queue has always used. So every failure mode of the ready
 * set degrades to TODAY'S ORDERING rather than to a stalled queue — which is also why it can ship on
 * by default.
 *
 * The ready set is a CACHE, never a source of truth. An entry naming a row that has since been
 * rescheduled or deleted costs at most one redundant render: the lease CAS refuses a duplicate, and
 * `processJobResult` already drops a result whose target is gone. Nothing here can lose a page,
 * because the next sweep re-reads the table — which is a categorically weaker invariant than the
 * claim floor's, where a row filed below it is never read again, silently and terminally.
 */
export const claimSchedules = async ({ grantLimit } = {}) => {
	const wanted = Math.max(0, grantLimit | 0);
	if (!config.queue.ready.enabled || wanted === 0) return claimFromIndex({ grantLimit });

	const queue = readyQueue();
	const leases = leaseTable();
	const nowMs = Date.now();
	const leaseTimeMs = config.queue.jobLeaseTime;

	const jobs = [];
	let skippedLeased = 0;
	let leaseRefused = false;

	// Over-take, because an entry may name a row that is already leased — the set does not exclude
	// leased rows on purpose (see `sweepReadySet`), so a run of them must not end the attempt while the
	// set still holds grantable work. Bounded, so an entirely-leased set costs a fixed number of
	// atomic loads rather than draining the whole thing.
	const attempts = Math.min(queue.capacity, wanted * 4);
	for (let taken = 0; jobs.length < wanted && taken < attempts; ) {
		const batch = queue.take(Math.min(wanted - jobs.length, attempts - taken));
		if (batch.length === 0) break;
		taken += batch.length;
		for (const entry of batch) {
			if (jobs.length >= wanted) break;
			if (leases.isLeased(entry.cacheKey)) {
				skippedLeased++;
				continue;
			}
			const expiresAtMs = nowMs + leaseTimeMs;
			if (!leases.grant(entry.cacheKey, { dueMinute: minuteOf(entry.dueAt), leaseExpiryMs: expiresAtMs })) {
				// No slot, no job — a granted-but-unrecorded job is a double render.
				leaseRefused = true;
				break;
			}
			jobs.push({
				cacheKey: entry.cacheKey,
				dueMinute: minuteOf(entry.dueAt),
				expiresAtMs,
				// Carried through from the sweep, NOT left absent. The renderer serializes a non-indexable
				// page only when the url is sitemap-listed, so a job reporting `false` for a listed page
				// silently stops it being cached — the bug this package has shipped twice.
				fromSitemap: entry.fromSitemap,
				score: entry.score,
			});
		}
		if (leaseRefused) break;
	}

	if (jobs.length >= wanted) {
		// Filled entirely from memory: no index read at all on this claim. The floor is not advanced
		// here and does not need to be — `sweepReadySet` owns it precisely because this path observes
		// nothing.
		const floor = floorState(nowMs);
		return {
			jobs,
			sawDue: true,
			granted: jobs.length,
			skippedLeased,
			nonFinite: 0,
			earliestNotYetDueMinute: 0,
			floorFrom: floor.floorMinute,
			floorTo: floor.floorMinute,
			floorHeldBy: lastFloorHeldBy,
			floorHeldByRow: null,
			floorPinnedForMs: floor.floorPinnedForMs ?? 0,
			floorAdvanced: false,
			scanned: 0,
			scanLimit: 0,
			scanTruncated: false,
			leaseRefused,
			occupancy: leases.occupancy(),
			fromReady: jobs.length,
			ready: queue.state(),
		};
	}

	// Short. Take the remainder from the index, which also lets the floor advance and the wedged-row
	// warning fire on a node whose ready set is doing most of the work.
	const pass = await claimFromIndex({ grantLimit: wanted - jobs.length });
	return {
		...pass,
		jobs: [...jobs, ...pass.jobs],
		granted: jobs.length + pass.granted,
		skippedLeased: skippedLeased + pass.skippedLeased,
		leaseRefused: leaseRefused || pass.leaseRefused,
		sawDue: jobs.length > 0 || pass.sawDue,
		fromReady: jobs.length,
		ready: queue.state(),
	};
};

// ---- lease lifecycle exposed to the result path ---------------------------------------------

export const releaseLease = (cacheKey) => leaseTable().release(cacheKey);

export const leaseInfo = (cacheKey) => leaseTable().leaseOf(cacheKey);

// ---- status derivation (zero DB ops) --------------------------------------------------------

/**
 * `empty` or `queued`, derived from the floor state and the last claim outcome. NO DATABASE
 * OPERATIONS — this replaces a second head-seeking scan (`nextRenderTime <= now`, limit 1) that
 * `syncQueueState` ran on worker 0 every `queue.statusSyncInterval`: ~700 ms of synchronous
 * native iteration per minute on an aged node, on the worker that also serves bot traffic.
 *
 * The tri-state matters: "granted zero but there ARE due rows" must report `queued`, never
 * `empty`. Reporting `empty` there tells every consumer in the fleet to back off to its idle
 * interval while a large backlog is entirely in flight.
 */
export const deriveQueueStatus = (nowMs = Date.now()) => {
	const { sawDue, earliestNotYetDueMinute } = leaseTable().readPassOutcome();
	// A row that was in the future when the last pass saw it, and whose minute has since arrived,
	// makes the queue non-empty without anything having to scan for it.
	if (earliestNotYetDueMinute && earliestNotYetDueMinute <= minuteOf(nowMs)) return 'queued';
	return sawDue ? 'queued' : 'empty';
};

// ---- the floor reset ------------------------------------------------------------------------

let lastFloorReset = 0;

/**
 * Zero the floor if `queue.claimFloor.resetInterval` has elapsed. Called from `syncQueueState`,
 * which already holds the claim mutex — exactly the serialization this needs against a
 * concurrent `advanceFloor`. `resetInterval: 0` disables it (and makes an out-of-plugin write
 * below the floor strand its URL permanently and silently).
 */
export const maybeResetFloor = (nowMs = Date.now()) => {
	const interval = config.queue.claimFloor.resetInterval;
	if (!(interval > 0)) return false;
	if (lastFloorReset && nowMs - lastFloorReset < interval) return false;
	lastFloorReset = nowMs;
	leaseTable().resetFloor();
	return true;
};

/**
 * Walk the lease slots and reconcile the occupancy gauge to what is actually live. Called from
 * `syncQueueState` beside `maybeResetFloor` — same worker, same claim mutex, once per
 * `queue.statusSyncInterval`.
 *
 * NOT COSMETIC, AND NOT OPTIONAL. The gauge has no other way back down. `grant`/`release` are exact
 * about every lease that ends in a RESULT, but a lease that merely EXPIRES leaves its +1 behind
 * forever: the grant counted it, and the late release (or the release that never comes) sees a dead
 * slot and correctly declines to decrement. Every expiry leaks one.
 *
 * And the gauge is not just a display: it SIZES the claim pass's read, `grantLimit + occupancy +
 * grantLimit`, capped at `queue.claimScanCap`. Measured against the real pass, the drift reached 820
 * against 20 genuinely in flight by pass 40 (~80 minutes), crossed a 1,000-row cap around pass 49 and
 * stayed there — after which every claim drains the full cap of projected rows, under the claim mutex,
 * on a worker that also serves bot traffic. That is the exact regression the floor exists to remove,
 * reached by drift instead of by index decay. Under a broad origin outage, where every lease expires
 * unreleased, it saturates in minutes. It also feeds `inFlightLeases()` into the persisted backlog
 * snapshot, and makes the lease-refused warning report "8000 of 4096 slots occupied".
 *
 * The buffer is shared, so ONE walk on ONE worker fixes the number every worker reads.
 */
export const reconcileLeaseGauge = () => leaseTable().scanLive();

/** The operator escape hatch: reset now instead of waiting out the interval. */
export const resetFloorNow = () => {
	const previousFloorMinute = leaseTable().rawFloorMinute();
	leaseTable().resetFloor();
	lastFloorReset = Date.now();
	return { previousFloorMinute, floorMinute: 0, lastResetAt: lastFloorReset };
};

/** Everything the console needs about the floor and the lease table. All O(1) except `oldestLease`. */
export const floorState = (nowMs = Date.now()) => {
	const guard = guardMinutes();
	const live = leaseTable().scanLive();
	return {
		enabled: config.queue.claimFloor.enabled,
		floorMinute: config.queue.claimFloor.enabled ? leaseTable().readFloorMinute(minuteOf(nowMs), guard) : 0,
		rawFloorMinute: leaseTable().rawFloorMinute(),
		guardMinutes: guard,
		resetInterval: config.queue.claimFloor.resetInterval,
		lastResetAt: lastFloorReset || null,
		occupancy: live.count,
		oldestLeaseExpiresAt: live.oldestExpiresAtMs,
		oldestLeaseDueMinute: live.oldestDueMinute,
		maxLeases: leaseTable().slots,
		// WHICH ROW IS HOLDING THE FLOOR — the one thing a floor lag does not tell you, and the only
		// place it is recorded. This worker's last claim pass; see `lastFloorHeldBy`.
		floorHeldBy: lastFloorHeldBy,
		floorHeldByAt: lastFloorHeldByAt || null,
		// HOW LONG that pin has lasted, and unlike the key beside it this one is NODE-WIDE: it comes
		// from the shared header, so it is the whole node's answer even on a worker that has never
		// claimed. Compare it against `queue.claimFloor.unpinAfter` — past that, the pass pushes the row
		// forward itself rather than leaving the queue wedged behind it.
		floorPinnedForMs: leaseTable().readPinAgeMs(),
		unpinAfter: config.queue.claimFloor.unpinAfter,
	};
};

/**
 * The floor as the claim pass would read it right now, in epoch ms — the number the console and
 * the backlog snapshot compare a row against. `null` when there is no floor.
 */
export const currentFloorMs = (nowMs = Date.now()) => {
	const floorMinute = config.queue.claimFloor.enabled
		? leaseTable().readFloorMinute(minuteOf(nowMs), guardMinutes())
		: 0;
	return floorMinute > 0 ? floorMinute * MINUTE : null;
};

/** In-flight lease count, for the backlog snapshot and the console. O(1). */
export const inFlightLeases = () => leaseTable().occupancy();

/**
 * Zero the whole shared buffer. TESTS ONLY (precedent: `resetCrawlStats`). The buffer outlives
 * a `beforeEach` that clears the fake tables, so without this the floor and the leases leak
 * between tests in one file and the second test in a file mysteriously claims nothing.
 */
export const resetRenderQueueState = () => {
	leaseTable().resetAll();
	lastFloorReset = 0;
};
