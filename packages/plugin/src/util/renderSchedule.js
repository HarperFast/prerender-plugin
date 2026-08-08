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
 * The UNBOUNDED case is a row whose result never reschedules it: the generic-failure branch in
 * `resources/RenderQueue.js` (target exists → hold the lease, no schedule write, no strike) is
 * exactly that shape, and it is where every renderer crash, navigation timeout and settle failure
 * lands. One permanently failing URL in an 803k corpus therefore holds the floor at its own minute
 * indefinitely, and dead index entries then accumulate above that point at the full render rate —
 * the same degradation this design exists to remove (~43 ms/pass after a day at 200 renders/min).
 * It is detectable and it is NAMED: the pass reports `floorHeldBy`, `claim` logs it, and the console
 * shows it beside the floor lag. Routing that branch through `retryAfterFailure`'s strike-counted
 * lanes would make the pin genuinely bounded, and is deliberately not in this release: those strikes
 * are the SHARED target counter that suppression and redirect verdicts retire targets on, so feeding
 * a broad origin outage into it risks mass deletion.
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
import { MINUTE } from './time.js';
import { LEASE_SAB_KEY, createLeaseTable, leaseBufferBytes, leaseSlotsIn } from './renderLease.js';

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
	const at = Number(nextRenderTime);
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
export const writeSchedule = async (cacheKey, { nextRenderTime, fromSitemap } = {}) => {
	if (fromSitemap === undefined) {
		throw new Error(`writeSchedule(${cacheKey}) needs an explicit fromSitemap — put replaces the record`);
	}
	await scheduleTable().put(cacheKey, { nextRenderTime, fromSitemap });
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
	for (const { cacheKey, nextRenderTime, fromSitemap } of rows) {
		if (fromSitemap === undefined) {
			throw new Error(`writeSchedules(${cacheKey}) needs an explicit fromSitemap — put replaces the record`);
		}
		await scheduleTable().put(cacheKey, { nextRenderTime, fromSitemap });
		const at = Number(nextRenderTime);
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
	let lastGrantedMinute = null;
	let earliestNotYetDueMinute = 0;
	let leaseRefused = false;
	let skippedLeased = 0;
	let nonFinite = 0;

	for (const row of rows) {
		// Coerce BEFORE the finite check: a Harper `Long` column can surface as BigInt, and
		// `Number.isFinite(BigInt)` is false while `Math.min(bigint, number)` THROWS. A throw here
		// happens inside the claim mutex, which 500s `claim` — and a consumer that gets a 500
		// circuit-breaks the node. `Number(null)` is 0, which would read as "due since 1970", so
		// a null due time has to be skipped rather than coerced.
		const at =
			row.nextRenderTime === null || row.nextRenderTime === undefined ? Number.NaN : Number(row.nextRenderTime);
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

/** `runClaimPass` bound to the live table and config. Called by `RenderQueue.claim`. */
export const claimSchedules = async ({ grantLimit } = {}) => {
	const pass = await runClaimPass({
		searchSchedules: ({ floorMinute, limit }) =>
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
	});

	// Whatever this pass saw, including `null` for "nothing is due": a stale key here would name an
	// innocent URL as the thing pinning the queue.
	lastFloorHeldBy = pass.floorHeldBy;
	lastFloorHeldByAt = Date.now();

	return pass;
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
