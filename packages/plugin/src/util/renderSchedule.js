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

import { config } from '../config.js';
import { getSab } from './coordination.js';
import { CacheKey } from './cacheKey.js';
import { resolveRenderInterval } from './routeClass.js';
import { MINUTE, numberOf } from './time.js';
import { LEASE_SAB_KEY, createLeaseTable, leaseBufferBytes, leaseSlotsIn } from './renderLease.js';
import { LANE_FLOOR_SAB_KEY, createLaneFloors, laneFloorBufferBytes } from './laneFloor.js';
import { restampGuard, restampPass, unstampedQuery } from './laneRestamp.js';
import {
	LANE_STRIDE,
	classOfLane,
	createLaneBudget,
	dueAtOf,
	encodeDueAt,
	laneCount,
	laneFor,
	laneLabel,
	laneOf,
} from './renderLane.js';

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

/**
 * The per-lane claim watermarks, over a named buffer of their own.
 *
 * SEPARATE FROM THE LEASE BUFFER ON PURPOSE — see the module comment in `util/laneFloor.js`. In
 * short: a named shared buffer is sized by its FIRST allocation, so widening the lease header would
 * hand a new worker generation a correctly-sized-looking view of the old layout with every slot
 * shifted, in the module that decides which URLs render. A second key cannot do that.
 *
 * Allocated on first use for the same reason `leaseTable` is: `laneCount()` reads
 * `queue.lanes.ttlBands`, and module scope precedes `applyOptions`.
 *
 * SIZED FOR THE CEILING, NOT FOR THE CURRENT BAND LIST. `laneCount()` moves when an operator edits
 * `ttlBands`, and the buffer cannot be resized within a process — so it is allocated at the maximum
 * this build supports and only the first `laneCount()` entries are ever touched. That makes a live
 * band-list edit a matter of which entries are USED rather than of reallocating shared memory, and
 * it means a band added at runtime gets a zeroed (unbounded) floor, which is exactly right: a lane
 * nothing has ever scanned should re-derive from the bottom of its slice.
 */
const MAX_SUPPORTED_LANES = 64;
let liveLaneFloors = null;

export const laneFloors = () => {
	if (liveLaneFloors) return liveLaneFloors;
	const buffer = getSab(LANE_FLOOR_SAB_KEY, laneFloorBufferBytes(MAX_SUPPORTED_LANES));
	liveLaneFloors = createLaneFloors({ buffer, lanes: MAX_SUPPORTED_LANES, now: () => Date.now() });
	if (laneCount() > liveLaneFloors.laneCount) {
		logger.error(
			`[prerender] queue.lanes.ttlBands implies ${laneCount()} lanes but the lane-floor buffer holds ` +
				`${liveLaneFloors.laneCount}. Lanes above that share the last watermark and will scan from a floor ` +
				`that is not theirs. Reduce ttlBands or raise MAX_SUPPORTED_LANES.`
		);
	}
	return liveLaneFloors;
};

/**
 * `runClaimPass` wants an object with a floor; this binds one lane's watermark into that shape.
 *
 * A thin adapter rather than teaching `laneFloor.js` the interface, so that module stays a data
 * structure over lane INDICES and the coupling to the claim pass lives here, with the rest of the
 * Harper-aware code.
 */
const floorsForLane = (lane) => {
	const table = laneFloors();
	return {
		readFloorMinute: (nowMinute, guard) => table.readFloorMinute(lane, nowMinute, guard),
		advanceFloor: (from, to) => table.advanceFloor(lane, from, to),
		resetFloor: () => table.resetFloor(lane),
		notePinnedBy: (cacheKey) => table.notePinnedBy(lane, cacheKey),
		// Deliberately no `recordPassOutcome`: `sawDue` / `earliestNotYetDue` drive the node's
		// queue-status derivation, which is one answer for the whole node rather than one per lane.
		// The orchestrator ORs the lanes' results and records that once, on the lease table.
	};
};

// Resolved per call rather than destructured at module load, matching `util/reconcile.js` and
// `util/backlogSnapshot.js`. This module is imported by almost everything (Target → Sitemap →
// RenderQueue → the handlers), so a module-scope capture would make the import order of the whole
// package depend on when `databases` was populated.
const scheduleTable = () => databases.render_schedule.RenderSchedule;

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
const lowerFloorFor = (nextRenderTime, lane = 0) => {
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
	// BOTH, and the asymmetry matters. The lane watermark takes the DECODED minute (a lane's floor is
	// a due minute, so floors stay comparable across lanes); the global floor takes the ENCODED value
	// it would actually be compared against, because that is the number the un-laned seek uses. Both
	// are lowered on every write regardless of which mode is live, so flipping `queue.lanes.enabled`
	// never leaves the mode being switched TO with a floor above rows it now has to find.
	laneFloors().lowerFloorTo(lane, minuteOf(dueAtOf(at)));
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
export const writeSchedule = async (cacheKey, { nextRenderTime, fromSitemap, renderInterval, urgent, cold } = {}) => {
	if (fromSitemap === undefined) {
		throw new Error(`writeSchedule(${cacheKey}) needs an explicit fromSitemap — put replaces the record`);
	}
	const lane = laneToWrite({ fromSitemap, renderInterval, urgent, cold });
	const stored = encodeDueAt(nextRenderTime, lane);
	await scheduleTable().put(cacheKey, { nextRenderTime: stored, fromSitemap });
	lowerFloorFor(stored, lane);
};

/**
 * The lane a write should file into, or 0 when lanes are off.
 *
 * DERIVED HERE AND NOWHERE ELSE. Every schedule write in the plugin already funnels through this
 * module, which is what makes "resolve the lane at write time" a single line rather than a
 * discipline sixteen call sites have to remember — the same reason the floor lowering lives here.
 * Deriving (rather than storing a lane column) is what makes a config change — a new band cut, a
 * route moved to a different cadence — retroactive on each key's next render with no sweep.
 *
 * `renderInterval` is the EFFECTIVE cadence and it is what bands the row. A caller that does not
 * have it hands in nothing, and `bandOf` puts the row in the SLOWEST band — deliberately, because
 * an absent interval is an absent claim to urgency and the alternative would let any row that lost
 * its cadence jump ahead of the homepage.
 */
const laneToWrite = ({ fromSitemap, renderInterval, urgent, cold }) =>
	config.queue.lanes.enabled ? laneFor({ fromSitemap, renderInterval, urgent, cold }) : 0;

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
	// PER LANE, not one minimum for the batch. A fan-out can legitimately span lanes — a device pair
	// shares a lane, but `Target.revalidate` over a sitemap walk and a reconcile repair both write
	// mixed provenance — and one global minimum would lower whichever lane happened to own the
	// earliest row while leaving the others' floors above rows they now have to find. That is the
	// stranding this funnel exists to prevent, so the minimum is tracked per lane.
	const lowestByLane = new Map();
	for (const { cacheKey, nextRenderTime, fromSitemap, renderInterval, urgent, cold } of rows) {
		if (fromSitemap === undefined) {
			throw new Error(`writeSchedules(${cacheKey}) needs an explicit fromSitemap — put replaces the record`);
		}
		const lane = laneToWrite({ fromSitemap, renderInterval, urgent, cold });
		const stored = encodeDueAt(nextRenderTime, lane);
		await scheduleTable().put(cacheKey, { nextRenderTime: stored, fromSitemap });
		// Same trap as `lowerFloorFor`, and WORSE here: with a bare `Number` a single null row anywhere
		// in the batch becomes 0, wins the minimum, and unbounds the floor for the whole fan-out.
		const at = numberOf(stored);
		if (Number.isFinite(at) && at < (lowestByLane.get(lane) ?? Number.POSITIVE_INFINITY)) {
			lowestByLane.set(lane, at);
		}
	}
	for (const [lane, lowest] of lowestByLane) lowerFloorFor(lowest, lane);
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
export const getScheduleRow = async (cacheKey, select) => {
	const row = await scheduleTable().get({ id: cacheKey, select }, { replicateFrom: false });
	// DECODED ON THE WAY OUT, ALWAYS — including while `queue.lanes.enabled` is false. Every reader
	// in the plugin treats `nextRenderTime` as a timestamp (the invalidation accelerator does
	// `nextRenderTime - interval` arithmetic on it; the console renders it as a date), and an encoded
	// value used as one is a date ~139 years per lane in the future: plausible-looking, and wrong.
	// Decoding unconditionally is also what makes disabling lanes a survivable rollback rather than a
	// corpus-wide stranding — rows written while it was on still read as their real due times.
	if (!row || row.nextRenderTime === undefined || row.nextRenderTime === null) return row;
	return { ...row, nextRenderTime: dueAtOf(row.nextRenderTime), lane: laneOf(row.nextRenderTime) };
};

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
	// ---- lane awareness. Every one of these defaults to the pre-lane behaviour, so an unlaned
	// call is byte-for-byte the function that existed before `util/renderLane.js`, and every
	// existing trace through it still describes it exactly.
	//
	// `lane` is passed through to `searchSchedules` (which builds the lane-scoped seek bound) and
	// used to recognize SPILL: the seek has one condition and no upper bound — a two-sided range
	// costs 1,128-2,977 ms on this index, so the upper bound stays in application code — which
	// means a sparse lane's window runs on into the next lane's rows. Those are recognized and
	// dropped, not granted.
	//
	// `floors` is whatever owns this lane's watermark. It defaults to `leases` because the single
	// global floor lives in the lease buffer; a laned pass hands in an adapter over
	// `util/laneFloor.js` instead. The three methods used are the same either way.
	lane = 0,
	floors = null,
	decode = null,
} = {}) => {
	const watermark = floors ?? leases;
	// Identity by default: an unencoded value IS its due time, in lane 0.
	const readRow = decode ?? ((raw) => ({ lane: 0, dueAt: numberOf(raw) }));
	const nowMinute = minuteOf(nowMs);
	const floorFrom = floorEnabled ? watermark.readFloorMinute(nowMinute, guard) : 0;

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
	for await (const row of searchSchedules({ lane, floorMinute: floorFrom, limit: scanLimit })) rows.push(row);

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
	let spilled = 0;

	for (const row of rows) {
		// `numberOf` because `Number(null)` is 0, which reads as "due since 1970" and would make an
		// absent due time the oldest due row in the corpus — pinning the floor at the epoch and naming
		// the wrong key as the row holding it. A missing due time is skipped and counted, not coerced.
		const { lane: rowLane, dueAt: at } = readRow(row.nextRenderTime);
		if (!Number.isFinite(at)) {
			nonFinite++;
			continue;
		}

		// SPILL. Rows arrive ascending by the ENCODED value, so every row of this lane precedes every
		// row of the next one — the first foreign row means this lane is exhausted. Counted separately
		// from `nonFinite` because it is not a defect: it is the read cost of keeping the query to one
		// condition, and it is the number that says whether a lane's scan limit is being wasted.
		if (rowLane !== lane) {
			spilled++;
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
			floorHeldByRow = { cacheKey: row.cacheKey, dueMinute, fromSitemap: !!row.fromSitemap };
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
		floorAdvanced = watermark.advanceFloor(floorFrom, floorTo);
	} else {
		// The kill switch forces the floor to 0 and changes nothing else, so re-enabling it starts
		// from a full seek rather than from a value that has been going stale.
		watermark.resetFloor();
	}

	watermark.recordPassOutcome?.({ sawDue, earliestNotYetDueMinute });

	// How long the SAME row has been holding the floor, node-wide. Recorded here rather than derived
	// by a caller because this is the only place that knows which row the floor rule actually picked,
	// and it is what both the wedged-row warning and the unpin escape hatch key off. `null` clears it,
	// so a pass that finds nothing due does not leave a stale pin ageing forever.
	const floorPinnedForMs = watermark.notePinnedBy(floorHeldBy);

	return {
		lane,
		jobs,
		sawDue,
		granted: jobs.length,
		skippedLeased,
		nonFinite,
		spilled,
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
const maybeUnpinFloor = async (pass, lane = null) => {
	const unpinAfter = config.queue.claimFloor.unpinAfter;
	if (!(unpinAfter > 0)) return null;
	if (!config.queue.claimFloor.enabled) return null;
	if (!pass.floorHeldByRow || !(pass.floorPinnedForMs >= unpinAfter)) return null;

	const { cacheKey, fromSitemap } = pass.floorHeldByRow;
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
	// Route > default here, where `processJobResult` resolves route > the target's stored interval >
	// default: reading the Target from the funnel would mean a point read on the claim path and an
	// import cycle (`resources/Target.js` imports this module). The residual, stated because it is
	// invisible from either site: a target whose STORED interval differs from the default with no route
	// interval to override it still desynchronises the two by that difference. Cost of that residual is
	// one extra render per crawl of one URL, rate-limited by the accelerator's own budget.
	const nextRenderTime = Date.now() + resolveRenderInterval(CacheKey.extractUrl(cacheKey), null);
	try {
		await writeSchedule(cacheKey, { nextRenderTime, fromSitemap });
	} catch (e) {
		logger.error(e, `[prerender] could not unpin the claim floor from ${cacheKey}`);
		return null;
	}

	// Clear the pin so the promoted row starts its own clock from this pass rather than inheriting
	// this one's age — without it the next pass would qualify immediately and unpin a healthy row.
	// Cleared on whichever watermark the pin was recorded against: a laned pass pins per lane, and
	// clearing the global one instead would leave the lane's pin ageing forever while the hatch
	// re-fired on a healthy row every interval.
	if (lane === null) leaseTable().notePinnedBy(null);
	else laneFloors().notePinnedBy(lane, null);

	logger.warn(
		`[prerender] ${cacheKey} held the claim queue's floor for ${Math.round(pass.floorPinnedForMs / 60_000)} minute(s) ` +
			`without ever being rescheduled — rendering it is failing in a way that posts no result (crash, navigation ` +
			`timeout or settle failure), so it has been pushed to ${new Date(nextRenderTime).toISOString()} to let the ` +
			`queue advance. Nothing behind it was rendering while it was pinned. Investigate this URL: the push repeats ` +
			`every render interval until it renders or is deleted, and no strike was counted against it.`
	);
	return { cacheKey, pinnedForMs: pass.floorPinnedForMs, nextRenderTime };
};

/** `runClaimPass` bound to the live table and config. Called by `RenderQueue.claim`. */
const claimOneLane = async ({ grantLimit, lane = 0, laned = false }) => {
	const pass = await runClaimPass({
		searchSchedules: ({ lane: seekLane, floorMinute, limit }) =>
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
					// LANE-SCOPED, STILL ONE CONDITION. The lane's slice starts at `lane * LANE_STRIDE`, so
					// its seek bound is that plus the lane's own watermark. There is deliberately no upper
					// bound: adding one is the two-sided range measured above, so a sparse lane's window
					// runs on into the next lane's rows and `runClaimPass` drops them as SPILL instead.
					conditions: [
						{
							attribute: 'nextRenderTime',
							comparator: 'greater_than_equal',
							value: seekLane * LANE_STRIDE + floorMinute * MINUTE,
						},
					],
					sort: { attribute: 'nextRenderTime' },
					// ARRAY select. A string `select` returns the bare scalar rather than a record —
					// the trap that has caused two silent bugs in this package already.
					select: ['cacheKey', 'nextRenderTime', 'fromSitemap'],
					limit,
				},
				{ replicateFrom: false }
			),
		leases: leaseTable(),
		nowMs: Date.now(),
		grantLimit,
		guardMinutes: guardMinutes(),
		scanCap: Math.max(1, config.queue.claimScanCap | 0),
		leaseTimeMs: config.queue.jobLeaseTime,
		floorEnabled: config.queue.claimFloor.enabled,
		lane,
		// The un-laned path keeps the GLOBAL floor and the identity decode, so it is the function that
		// existed before lanes, byte for byte. The laned path swaps in that lane's watermark and the
		// real decoder — and note the decode is only swapped for the CLAIM; `getScheduleRow` decodes
		// unconditionally, because a reader that gets this wrong is silently 139 years out.
		floors: laned ? floorsForLane(lane) : null,
		decode: laned ? (raw) => ({ lane: laneOf(raw), dueAt: dueAtOf(raw) }) : null,
	});

	// Whatever this pass saw, including `null` for "nothing is due": a stale key here would name an
	// innocent URL as the thing pinning the queue.
	//
	// NOT SET BY A LANE PASS. A laned claim runs this function once per lane, and the last lane is
	// usually `cold` with nothing due — so recording here would overwrite a genuinely pinned lane's
	// key with the empty lane's `null` on every claim, and `floorState` (and therefore the console's
	// "Claim floor lag") would report that nothing is pinned while a lane was wedged. The laned path
	// records once, from `mergeLanePasses`, which is the only place that knows which lane's pin is the
	// one worth naming.
	if (!laned) {
		lastFloorHeldBy = pass.floorHeldBy;
		lastFloorHeldByAt = Date.now();
	}

	// AFTER the pass, never inside it: `runClaimPass` takes all its I/O as arguments precisely so the
	// floor algebra has no database in it, and a write issued mid-pass would also be a write with the
	// scan cursor still open (see the drain note above).
	const floorUnpinned = await maybeUnpinFloor(pass, laned ? lane : null);
	return floorUnpinned ? { ...pass, floorUnpinned } : pass;
};

/**
 * ONE CLAIM, ACROSS LANES.
 *
 * With `queue.lanes.enabled` false this is one call to `claimOneLane` and nothing else — the same
 * single pass, the same global floor, the same numbers. Everything below only happens when lanes
 * are on.
 *
 * ── WHY A SEEK PER LANE RATHER THAN ONE SCAN ────────────────────────────────────────────────────
 *
 * Because the whole problem is that one scan can only start in one place. The claim window is
 * anchored at the oldest due time in the corpus, and under a backlog every row in it is ancient —
 * so a homepage two of its own cadences late is nowhere near the window, and no amount of
 * re-ranking inside it can find a row it never reads. A lane is a disjoint slice of the same index
 * with a watermark of its own, so its head is ITS oldest row, not the corpus's.
 *
 * Measured (#80): three lanes interleaved in one index, each with its own watermark, 0.29-0.32 ms
 * per lane. The same lane without a watermark, 3.46 ms. Interleaving is free; the watermark is the
 * win. That is what makes N seeks cheaper than the one degraded seek this replaces.
 *
 * ── HOW THE BATCH IS DIVIDED ────────────────────────────────────────────────────────────────────
 *
 * Lane order, with `urgent` capped by its drain share and the protected classes floored — see
 * `createLaneBudget` for why floors rather than fixed shares, and why strict priority is not an
 * option at any capacity level. The TOP-UP sweep at the end is what makes a floor a minimum rather
 * than an entitlement: a class with fewer due rows than its floor releases the difference back to
 * lane order instead of leaving that slice of the batch unspent.
 *
 * The sweep is skipped whenever the first pass spent the batch, which is the backlogged case — so
 * the extra seeks happen exactly when the queue is caught up and they are cheapest.
 */
export const claimSchedules = async ({ grantLimit } = {}) => {
	if (!config.queue.lanes.enabled) return claimOneLane({ grantLimit });

	const { urgentMaxShare, minShare } = config.queue.lanes;
	const budget = createLaneBudget({ grantLimit, urgentMaxShare, minShare });
	const order = Array.from({ length: laneCount() }, (_, lane) => lane);
	const passes = [];

	for (const lane of order) {
		const allowance = budget.allowanceFor(lane);
		if (allowance <= 0) continue;
		const pass = await claimOneLane({ grantLimit: allowance, lane, laned: true });
		budget.record(lane, pass.granted);
		passes.push(pass);
	}

	// Release unclaimed reservations and sweep again, in lane order.
	if (budget.remaining > 0) {
		budget.topUp();
		for (const lane of order) {
			const allowance = budget.allowanceFor(lane);
			if (allowance <= 0) continue;
			const pass = await claimOneLane({ grantLimit: allowance, lane, laned: true });
			budget.record(lane, pass.granted);
			passes.push(pass);
		}
	}

	return mergeLanePasses(passes, grantLimit);
};

/**
 * Fold the per-lane passes into the one shape `RenderQueue.claim` consumes.
 *
 * The interesting choice is WHICH LANE'S FLOOR gets reported as "the" floor, because the console
 * shows one number and the wedged-row warning names one URL. It reports the lane that has been
 * PINNED LONGEST, not the lane with the oldest floor: an old floor on a lane that is draining is
 * normal (that is what a backlog looks like), whereas a floor that has not moved is the one failure
 * this reporting exists to catch. Ties go to the older floor. Per-lane detail rides along in
 * `lanes` so nothing is hidden behind that choice.
 */
const mergeLanePasses = (passes, grantLimit) => {
	if (passes.length === 0) {
		return {
			jobs: [],
			sawDue: false,
			granted: 0,
			skippedLeased: 0,
			nonFinite: 0,
			spilled: 0,
			earliestNotYetDueMinute: 0,
			floorFrom: 0,
			floorTo: 0,
			floorHeldBy: null,
			floorHeldByRow: null,
			floorPinnedForMs: 0,
			floorAdvanced: false,
			scanned: 0,
			scanLimit: 0,
			scanTruncated: false,
			leaseRefused: false,
			occupancy: leaseTable().occupancy(),
			lanes: [],
			grantLimit,
		};
	}

	// A pass with no due row has no pin to report, so it must not win the "longest pinned" contest
	// with a floorPinnedForMs of 0 against a lane that genuinely has one.
	const pinned = passes.filter((p) => p.floorHeldBy);
	const worst =
		pinned.length === 0
			? passes[0]
			: pinned.reduce((a, b) =>
					b.floorPinnedForMs > a.floorPinnedForMs ||
					(b.floorPinnedForMs === a.floorPinnedForMs && b.floorTo < a.floorTo)
						? b
						: a
				);

	const sum = (key) => passes.reduce((total, p) => total + (p[key] || 0), 0);

	lastFloorHeldBy = worst.floorHeldBy ?? null;
	lastFloorHeldByAt = Date.now();

	return {
		jobs: passes.flatMap((p) => p.jobs),
		sawDue: passes.some((p) => p.sawDue),
		granted: sum('granted'),
		skippedLeased: sum('skippedLeased'),
		nonFinite: sum('nonFinite'),
		spilled: sum('spilled'),
		// The soonest anything is due anywhere, ignoring lanes that saw nothing at all (0 is "unknown"
		// in this field, not "the epoch"), because it feeds the node's empty-vs-queued derivation.
		earliestNotYetDueMinute: Math.min(...passes.map((p) => p.earliestNotYetDueMinute || Infinity)) || 0,
		floorFrom: worst.floorFrom,
		floorTo: worst.floorTo,
		floorHeldBy: worst.floorHeldBy,
		floorHeldByRow: worst.floorHeldByRow,
		floorPinnedForMs: worst.floorPinnedForMs,
		floorLane: worst.lane,
		floorAdvanced: passes.some((p) => p.floorAdvanced),
		scanned: sum('scanned'),
		scanLimit: Math.max(...passes.map((p) => p.scanLimit)),
		scanTruncated: passes.some((p) => p.scanTruncated),
		leaseRefused: passes.some((p) => p.leaseRefused),
		occupancy: leaseTable().occupancy(),
		floorUnpinned: passes.find((p) => p.floorUnpinned)?.floorUnpinned,
		lanes: passes.map((p) => ({
			lane: p.lane,
			label: laneLabel(p.lane),
			class: classOfLane(p.lane),
			granted: p.granted,
			sawDue: p.sawDue,
			scanned: p.scanned,
			spilled: p.spilled,
			skippedLeased: p.skippedLeased,
			floorTo: p.floorTo,
			floorHeldBy: p.floorHeldBy,
			floorPinnedForMs: p.floorPinnedForMs,
		})),
		grantLimit,
	};
};

/**
 * Run one bounded lane-restamp pass. See `util/laneRestamp.js` for what this is for and why it is
 * needed at all given that lanes are otherwise derived at write time.
 *
 * The I/O lives HERE because this module is the only file allowed to touch `RenderSchedule` — the
 * same rule that keeps the floor lowering inseparable from the due-time write, enforced by
 * `test/queueFunnel.test.js`. `laneRestamp.js` owns the decision; this owns the table.
 */
export const restampLanes = async ({ limit = 5000, force = false } = {}) => {
	const guard = restampGuard({ force });
	if (!guard.allowed) return { error: guard.reason };

	const result = await restampPass({
		limit,
		searchUnstamped: ({ limit: cap }) => scheduleTable().search(unstampedQuery(cap), { replicateFrom: false }),
		// Through `writeSchedules`, not a raw put, so each batch lowers its lane's watermark with the
		// batch minimum. A raw write here would file every restamped row BELOW the lane floor the very
		// first pass then establishes — the terminal render gap, applied to the whole corpus at once.
		writeRow: (rows) => writeSchedules(rows),
	});

	if (result.restamped) {
		logger.info(
			`[prerender] lane restamp: moved ${result.restamped} of ${result.examined} row(s) ` +
				`(${result.lanes.map((l) => `${l.label}=${l.rows}`).join(' ')})${result.done ? ' — nothing left to move' : ''}`
		);
	}
	return result;
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
