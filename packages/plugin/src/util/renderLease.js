/**
 * The node-local render-lease table AND the claim floor, in ONE shared buffer.
 *
 * Both of these used to live in the `RenderSchedule` row itself, in the single
 * `nextRenderTime` column: `claim` wrote `now + jobLeaseTime` into it to mark the job taken,
 * and the scan found work by seeking that column's absolute minimum. That cost two writes per
 * render and it degraded, measurably and permanently:
 *
 *   `claim` scanned `nextRenderTime <= now` sorted, which seeks from the ABSOLUTE MINIMUM of
 *   that secondary index. Every completed render moves a key from the head of the index into
 *   the future and leaves a dead index entry AT THE SEEK POINT. Measured on harper 5.1.26 /
 *   rocksdb-js 2.4.1: the scan degraded from 0.36 ms to 6.25 ms over 40,000 reschedules
 *   (17.4×), linearly, at ~0.15 µs per completed render — and it did NOT self-heal (6.17 ms
 *   after the churn stopped). The cost is POSITION-dependent, not volume-dependent: the same
 *   churn away from the seek point was free (0.26 → 0.27 ms), and backlog DEPTH was free too
 *   (2,083 → 133,333 overdue rows was flat at 0.18–0.35 ms). The `sort` clause was free.
 *
 * The fix is a one-sided lower bound on the scan (`nextRenderTime >= floor`) so it no longer
 * seeks the absolute minimum: identical 20 keys at 0.43 ms instead of 6.20 ms, no schema
 * change. That `floor` is header slot 0 here. The lease had to leave `nextRenderTime` for the
 * floor to mean anything (a lease written into the due-time column IS a row moved forward), and
 * moving it out is also what halves queue writes — 2 per render to 1, ~87 → ~44 MB/day/node of
 * audit.
 *
 * WHY A SHARED BUFFER AND NOT A TABLE. A lease is process-lifetime state, not a record: it
 * exists to stop two renderers claiming the same key inside one lease window, and it is worth
 * exactly zero database operations. Harper itself keeps this class of state in
 * `getUserSharedBuffer` — the id incrementer, the next-request-id, the blob file id, the
 * restart-needed flag — and `util/coordination.js` already wraps it for this plugin.
 *
 * NOTE IT IS NOT A `SharedArrayBuffer`. `getUserSharedBuffer` hands back a plain `ArrayBuffer`
 * that is nonetheless shared across the workers of one node, so `Atomics.load`/`store`/
 * `compareExchange`/`add` all work on it but `Atomics.wait`/`waitAsync` THROW (see
 * `util/coordination.js` and `util/mutex.js`, which is why the cross-worker mutex is built on
 * the store's native `tryLock` instead). Every protocol here is therefore lock-free and
 * CAS-based, and the one place that genuinely needs mutual exclusion (the claim pass) is
 * serialized by that store mutex, not by this buffer.
 *
 * WHY LOSING EVERY LEASE ON RESTART IS THE CORRECT SEMANTICS. A lease is not a record of work;
 * the schedule row is. When the buffer is re-created zeroed at worker-generation replacement,
 * nothing has been lost: the schedule rows were never moved, they are still overdue, and the
 * next claim pass simply re-GRANTS them. The cost is a duplicate-render burst — at ~500 in
 * flight per node a rolling four-node restart re-grants ~2,000 jobs whose original renderers
 * are still working, and both results are accepted (the later `PrerenderedPage.put` wins, with
 * a correct `expiresAt`). The one sharp edge is that two results for the same failing key each
 * run `Target.patch(url, { strikes })`, so a failing key can double-strike toward `maxStrikes`.
 * That is accepted, not fixed: every candidate fix (gate the strike on lease presence, stamp a
 * claim generation onto the row) silently disables the whole `render.failureRetry.fastRetries`
 * lane across restarts, which is worse, and re-adding an `@updatedTime` column to detect
 * "recently claimed" would re-add the very write this change removes.
 *
 * RELEASING A LEASE SHORTENS IT TO A GRACE; IT NEVER FREES THE SLOT ON THE SPOT. The result path
 * releases from a `finally` inside the request handler, and the reschedule it just issued is a
 * `Table.put` with no explicit context — i.e. it joined the AMBIENT transaction, which commits after
 * the handler's promise settles. So at the moment the lease is given up, committed state still shows
 * the row at its original overdue due time, at the head of the floored scan, and `claim` (which does
 * not share the result path's mutex) can grant it a second time. The window is one commit, on every
 * single result — the design accepts duplicate grants at worker-generation frequency, not at render
 * frequency, and the duplicate costs a wasted render plus, on a failing key, a second strike toward
 * `maxStrikes`. So `release` sets the expiry to `now + RELEASE_GRACE_MS` instead: the key stays
 * unclaimable for a few seconds while the transaction becomes visible, and the slot is then reused
 * exactly like any expired one. It costs nothing — the floor derivation never reads a slot (see
 * util/renderSchedule.js), and by then the row is forward-dated, so a lingering slot pins nothing.
 * Committing the transaction early instead is NOT an option: the request wrapper commits again.
 *
 * The floor, by contrast, is NOT persisted for a reason that is easy to get backwards:
 * restart-zeroing is the single accidental self-heal that every stranding bug in this design
 * depends on. `floor = 0` means "seek from the absolute minimum", i.e. exactly the pre-v0.35.0
 * behaviour — so a restart cannot help but re-derive the truth from the index. Persisting the
 * floor would make a backwards clock step, or any bug that advanced it too far, DURABLE. The
 * price of not persisting it is one degraded 6.25 ms seek per worker generation. Pay it.
 *
 * NOTE ON THIS MODULE'S DEPENDENCIES: it has none beyond the hash. No `config`, no Harper globals,
 * not even the `getSab` wrapper — the LIVE buffer is acquired in `util/renderSchedule.js`, which
 * needs Harper anyway. That is deliberate: this file is a data structure, and keeping it importable
 * from a bare `node --test` is what lets `test/renderLease.test.js` drive the probe protocol, the
 * expiry boundary, the collision behaviour and every CAS rule on the floor against a plain
 * `new ArrayBuffer()` with an injected clock, rather than against a mock of Harper.
 */

import { lease64 } from './hash.js';

/**
 * Lease expiries are stored as Int32 SECONDS relative to this fixed epoch, not as raw epoch
 * seconds. Raw epoch seconds fit an Int32 only until 2038-01-19; offsetting by a constant buys
 * ±68 years from the constant, and the constant is baked in rather than derived so two workers
 * (or a worker and its replacement) can never disagree about what a stored number means.
 */
export const LEASE_EPOCH_SEC = 1_700_000_000;

// Header: [floorMinute, occupancy, lastPassSawDue, earliestNotYetDueMinute, pinLo, pinHi, pinSinceSec]
const H_FLOOR = 0;
const H_OCCUPANCY = 1;
const H_SAW_DUE = 2;
const H_EARLIEST_NOT_DUE = 3;
// Which key the claim floor is pinned at, and since when — see `notePinnedBy`. In the SHARED header
// rather than in module state because a claim pass runs on whichever worker the consumer's poll
// landed on, so a per-worker counter would be divided by the worker count and never reach a
// threshold.
const H_PIN_LO = 4;
const H_PIN_HI = 5;
const H_PIN_SINCE = 6;
const HEADER_INT32 = 7;

// Slot: [hashLo, hashHi, expiresSec, dueMinute]
const S_LO = 0;
const S_HI = 1;
const S_EXPIRES = 2;
const S_DUE = 3;
const SLOT_INT32 = 4;

/**
 * `dueMinute` of a slot whose lease has been RELEASED and is only sitting out its
 * commit-visibility grace (see the module comment). A real due minute is minutes-since-the-epoch,
 * so it can never be negative — this is a marker, not a value in the same space.
 *
 * It is what separates the two questions a slot answers. "Is this key claimable?" is `isLeased`,
 * which is about the EXPIRY alone and stays true through the grace: that is the whole point.
 * "Is this key being rendered right now?" is `leaseOf` and the occupancy gauge, and the answer for
 * a released lease is no. Conflating them would either re-open the duplicate-grant window or make
 * the console report every just-finished render as in flight.
 */
const DUE_RELEASED = -1;

/**
 * How long a released lease keeps its key unclaimable, covering the visibility gap between the
 * result path releasing and its transaction committing. Whole seconds (expiries are stored in
 * seconds, rounded up), and short next to the two-minute `queue.jobLeaseTime` minimum. Not a config
 * option: it is a property of Harper's commit timing, not of a deployment.
 */
export const RELEASE_GRACE_MS = 5_000;

/**
 * Probe length for the open-addressed table. Bounded rather than "probe until an empty slot"
 * on purpose: a bounded probe makes every operation O(1) with no tombstones, and a full probe
 * window simply reports the table as full (`grant` returns false, and the caller then does NOT
 * emit the job — see the I-8 invariant). Every read walks the whole window instead of stopping
 * at the first empty slot, so a released lease cannot break a later key's probe chain.
 */
const MAX_PROBE = 8;

export const LEASE_HEADER_BYTES = HEADER_INT32 * 4;
export const LEASE_SLOT_BYTES = SLOT_INT32 * 4;

/** Byte size of a lease buffer with `slots` slots. 4,096 slots = 65,564 B. */
export const leaseBufferBytes = (slots) => LEASE_HEADER_BYTES + LEASE_SLOT_BYTES * Math.max(0, slots | 0);

/** Slots that actually fit in a buffer of this size — the authority when a size assert fails. */
export const leaseSlotsIn = (byteLength) =>
	Math.max(1, Math.floor((byteLength - LEASE_HEADER_BYTES) / LEASE_SLOT_BYTES));

/**
 * The lease table + claim floor over an arbitrary buffer, with the clock injected.
 *
 * A pure factory rather than a module-level singleton so the whole structure — the probe
 * protocol, the expiry boundary, the collision behaviour, and every CAS rule on the floor — is
 * testable with a plain `new ArrayBuffer()` and no Harper globals at all. `util/renderSchedule.js`
 * makes the one live call to it, over the shared buffer named by `LEASE_SAB_KEY`.
 */
export const createLeaseTable = ({ buffer, slots = leaseSlotsIn(buffer.byteLength), now = Date.now } = {}) => {
	const i32 = new Int32Array(buffer);
	const slotCount = Math.max(1, Math.min(slots | 0, leaseSlotsIn(buffer.byteLength)));

	const base = (slot) => HEADER_INT32 + slot * SLOT_INT32;

	// Round the expiry UP to the next whole second, so second-granularity storage can only ever
	// make a lease LONGER than `jobLeaseTime`, never shorter. A lease that expires early is a
	// double render; a lease that expires 999 ms late is nothing.
	const toExpiresSec = (ms) => Math.ceil(ms / 1000) - LEASE_EPOCH_SEC;
	const fromExpiresSec = (sec) => (sec + LEASE_EPOCH_SEC) * 1000;

	// A slot is live while now is strictly before its expiry second. `expiresSec === 0` on a
	// never-written slot therefore reads as long expired rather than as "leased at the epoch
	// forever" — the same class of trap as `new Date(null).getTime() === 0` in util/time.js,
	// and the reason `hashLo === 0` (not the expiry) is the emptiness marker.
	const isLive = (expiresSec, nowSec) => expiresSec > nowSec;
	const nowSecond = () => Math.floor(now() / 1000) - LEASE_EPOCH_SEC;

	/**
	 * Locate `key`: the slot currently holding it (`found`), and the first slot that could take
	 * it (`free` — empty or expired). Walks the FULL probe window in both cases; see MAX_PROBE.
	 */
	const locate = (lo, hi, nowSec) => {
		const start = (lo >>> 0) % slotCount;
		let found = -1;
		let free = -1;
		for (let probe = 0; probe < MAX_PROBE && probe < slotCount; probe++) {
			const slot = (start + probe) % slotCount;
			const at = base(slot);
			// `hashLo` FIRST and alone decides whether the rest of the slot is worth reading —
			// it is the single linearization point of the publish protocol below.
			const observedLo = Atomics.load(i32, at + S_LO);
			if (observedLo === lo && Atomics.load(i32, at + S_HI) === hi) {
				found = slot;
				break;
			}
			if (free === -1 && (observedLo === 0 || !isLive(Atomics.load(i32, at + S_EXPIRES), nowSec))) free = slot;
		}
		return { found, free };
	};

	/**
	 * A slot the OCCUPANCY GAUGE counts: a live lease that has not been released. The gauge exists to
	 * size the claim pass's read past the in-flight pile, so this predicate is the one thing `grant`,
	 * `release` and `scanLive` must all agree on — they used to disagree, and the gauge could read 0
	 * with leases genuinely in flight (`grant` incremented only when it took a never-used slot, while
	 * `release` decremented unconditionally, so every lease that EXPIRED and was released late left an
	 * unmatched −1 behind `scanLive`'s reconciliation). `occupancy()` reading low is not cosmetic: it
	 * collapses the claim scan window to `2 × grantLimit`, and a pass with more live leases than that
	 * grants NOTHING while a backlog exists.
	 */
	const isCounted = (at, nowSec) =>
		Atomics.load(i32, at + S_LO) !== 0 &&
		isLive(Atomics.load(i32, at + S_EXPIRES), nowSec) &&
		Atomics.load(i32, at + S_DUE) !== DUE_RELEASED;

	/** "Is this key claimable?" — the expiry alone, so a released lease still blocks through its
	 *  grace. See DUE_RELEASED for why this is deliberately not the same question as `leaseOf`. */
	const isLeased = (cacheKey) => {
		const { lo, hi } = lease64(cacheKey);
		const nowSec = nowSecond();
		const { found } = locate(lo, hi, nowSec);
		if (found === -1) return false;
		return isLive(Atomics.load(i32, base(found) + S_EXPIRES), nowSec);
	};

	/** "Is this key being rendered right now, and since when?" — observability, so a lease sitting
	 *  out its release grace reads as no lease at all. */
	const leaseOf = (cacheKey) => {
		const { lo, hi } = lease64(cacheKey);
		const nowSec = nowSecond();
		const { found } = locate(lo, hi, nowSec);
		if (found === -1) return null;
		const at = base(found);
		if (!isCounted(at, nowSec)) return null;
		return {
			leaseExpiresAtMs: fromExpiresSec(Atomics.load(i32, at + S_EXPIRES)),
			dueMinute: Atomics.load(i32, at + S_DUE),
		};
	};

	/**
	 * Take (or renew) the slot for `cacheKey`. Returns false when the probe window is full,
	 * which the caller MUST treat as "do not hand out this job": a granted-but-unrecorded job is
	 * both a double render and an untracked hold on the claim floor.
	 *
	 * PUBLISH ORDER: payload (`hashHi`, `expiresSec`, `dueMinute`) first, then a
	 * `compareExchange` on `hashLo`. Only the successful CAS grants the slot, and a reader that
	 * sees a matching `hashLo` therefore sees payload that was written before it. The residual
	 * race is two workers racing for the same expired slot: the loser may have stomped the
	 * payload before its CAS failed, leaving the winner's `hashLo` beside the loser's `hashHi`,
	 * which reads as "no lease for either key". That degrades to exactly the restart case — the
	 * row was never moved, so it is re-granted — and the window is a handful of non-yielding
	 * instructions inside a mutex-serialized claim pass.
	 */
	const grant = (cacheKey, { dueMinute, leaseExpiryMs } = {}) => {
		const { lo, hi } = lease64(cacheKey);
		const nowSec = nowSecond();
		const { found, free } = locate(lo, hi, nowSec);
		const slot = found !== -1 ? found : free;
		if (slot === -1) return false;

		const at = base(slot);
		const observedLo = Atomics.load(i32, at + S_LO);
		// Read BEFORE the payload stores below overwrite it. The only way this slot is already
		// counted is that it holds a live, unreleased lease for THIS key (`free` never selects a live
		// slot), i.e. a renewal — which must not count twice. Every other case (empty, expired, or
		// released and inside its grace) is a new live lease and a genuine +1.
		const renewingCounted = isCounted(at, nowSec);
		Atomics.store(i32, at + S_HI, hi);
		Atomics.store(i32, at + S_EXPIRES, toExpiresSec(leaseExpiryMs));
		// Clamped at 0 so a caller's junk value can never land on the DUE_RELEASED marker.
		Atomics.store(i32, at + S_DUE, Math.max(0, dueMinute | 0));
		if (Atomics.compareExchange(i32, at + S_LO, observedLo, lo) !== observedLo) return false;
		if (!renewingCounted) Atomics.add(i32, H_OCCUPANCY, 1);
		return true;
	};

	/**
	 * Give up the lease for `cacheKey`: the key stops counting as in flight immediately and becomes
	 * claimable again once its `RELEASE_GRACE_MS` grace has passed. Idempotent; false when this key
	 * holds no lease to give up.
	 *
	 * The slot is deliberately NOT published free — see the module comment on the commit-visibility
	 * grace. That also removes the old publish-order hazard here: this used to CAS `hashLo` to 0 and
	 * only THEN zero the expiry, so a `grant` that took the slot in between had its brand-new lease
	 * silently zeroed. Nothing in this function writes `hashLo` any more, and the one payload word it
	 * does write is CAS'd against the value it read.
	 *
	 * Keyed on the hash pair, never on a slot index remembered from earlier: the slot a key hashed to
	 * can have been recycled by another key in between, and clearing it by index would silently free
	 * somebody else's lease.
	 */
	const release = (cacheKey) => {
		const { lo, hi } = lease64(cacheKey);
		const nowSec = nowSecond();
		const { found } = locate(lo, hi, nowSec);
		if (found === -1) return false;
		const at = base(found);

		// READ THE EXPIRY BEFORE RE-VALIDATING OWNERSHIP, and CAS against exactly this value below.
		// The order is the whole protection, and having it the other way round was a live bug: it read
		// the expiry AFTER the ownership check, so a slot recycled in between handed this function the
		// RECYCLER'S FRESH EXPIRY, which is far in the future — `graceSec < expiresSec` was therefore
		// true and the CAS truncated somebody else's brand-new lease to a five-second grace. That key
		// was then re-granted seconds later while its first render was still running: a duplicate
		// render, and on a failing key a duplicate strike toward `maxStrikes` (the result path does not
		// share the claim mutex, so release-vs-grant is genuinely concurrent).
		//
		// Reading it first is sufficient because `grant` publishes a recycled slot's payload (`hashHi`,
		// `expiresSec`, `dueMinute`) BEFORE it claims `hashLo`. A recycle that began before this read is
		// caught by the ownership re-check; one that landed after it necessarily stored a different
		// expiry, so the CAS fails and nothing is written. And with THIS key's own expiry in hand the
		// guard below also declines, correctly, to "shorten" an already-expired lease into the future.
		const expiresSec = Atomics.load(i32, at + S_EXPIRES);
		if (Atomics.load(i32, at + S_LO) !== lo || Atomics.load(i32, at + S_HI) !== hi) return false;

		// ONE release per lease, claimed with a CAS on the due-minute word. Two results for one key is
		// a documented case (the restart duplicate-render burst), and without this claim the second
		// would decrement the occupancy gauge for a grant that was only ever counted once.
		const dueMinute = Atomics.load(i32, at + S_DUE);
		if (dueMinute === DUE_RELEASED) return false;
		const wasCounted = isCounted(at, nowSec);
		if (Atomics.compareExchange(i32, at + S_DUE, dueMinute, DUE_RELEASED) !== dueMinute) return false;

		// Shorten to the grace, never lengthen (a lease that already expired stays expired), and only
		// if the expiry is still the one read above.
		const graceSec = toExpiresSec(now() + RELEASE_GRACE_MS);
		if (graceSec < expiresSec) Atomics.compareExchange(i32, at + S_EXPIRES, expiresSec, graceSec);
		if (wasCounted) Atomics.sub(i32, H_OCCUPANCY, 1);
		return true;
	};

	// Best-effort, and drifts ONLY EVER HIGH — but it drifts WITHOUT BOUND until something walks the
	// slots, so `scanLive` is a periodic obligation and not merely a console read. `grant`/`release`
	// are exact about every lease that ends in a RESULT; a lease that simply EXPIRES has nobody to
	// decrement it, because the grant counted +1 and a late release (or no release at all) sees a dead
	// slot and correctly declines. Every expiry therefore leaks one, permanently.
	//
	// High is the SAFER direction, not a harmless one: it widens the claim pass's scan window (low
	// silently stops the pass granting), and the window is capped at `queue.claimScanCap` — so
	// unchecked drift ends with every pass draining the full cap of projected rows under the claim
	// mutex, on a worker that also serves bot traffic. Measured against the real pass: 820 against 20
	// genuinely in flight by pass 40, crossing a 1,000-row cap around pass 49 and staying there. Under
	// a broad origin outage, where every job's lease expires unreleased, it saturates in minutes.
	// `reconcileLeaseGauge` in util/renderSchedule.js is what keeps that from happening.
	const occupancy = () => Math.max(0, Atomics.load(i32, H_OCCUPANCY));

	/**
	 * Full slot walk: in-flight count, oldest expiry, and the due minute that oldest lease is holding
	 * the floor at. Reconciles the best-effort occupancy gauge on the way past, so a lease that expired
	 * rather than being released (or a stomped CAS) stops inflating the gauge forever.
	 *
	 * O(slots) of plain Atomics loads, and NOT an admin-console luxury: the gauge has no other way back
	 * down (see `occupancy`), so this must run on a timer as well as on a console read. It does — from
	 * `syncQueueState` via `reconcileLeaseGauge`, on worker 0, under the claim mutex, once per
	 * `queue.statusSyncInterval`. Never call it from inside the claim pass's row loop.
	 *
	 * It counts EXACTLY what `grant`/`release` maintain — `isCounted`, i.e. live and not released.
	 * Storing anything else here is what made the gauge driftable in both directions: a walk that
	 * counted a different population left the next `release` decrementing something this store had
	 * already taken out.
	 */
	const scanLive = () => {
		const nowSec = nowSecond();
		let count = 0;
		let oldestExpiresSec = null;
		let oldestDueMinute = null;
		for (let slot = 0; slot < slotCount; slot++) {
			const at = base(slot);
			if (!isCounted(at, nowSec)) continue;
			const expiresSec = Atomics.load(i32, at + S_EXPIRES);
			count++;
			if (oldestExpiresSec === null || expiresSec < oldestExpiresSec) {
				oldestExpiresSec = expiresSec;
				oldestDueMinute = Atomics.load(i32, at + S_DUE);
			}
		}
		Atomics.store(i32, H_OCCUPANCY, count);
		return {
			count,
			oldestExpiresAtMs: oldestExpiresSec === null ? null : fromExpiresSec(oldestExpiresSec),
			oldestDueMinute,
		};
	};

	// ---- the claim floor -------------------------------------------------------------------

	/**
	 * The floor to seek from, in minutes since the epoch. `0` means "no floor" — seek the
	 * absolute index minimum, exactly as before v0.35.0.
	 *
	 * THE GUARD CLAMP IS APPLIED ON EVERY READ, and it is what makes the whole design safe
	 * without cross-node coordination. `RenderSchedule` is residency-pinned, so ~75% of "render
	 * this URL now" writes on a four-node cluster are issued by a node that is not the owner and
	 * therefore cannot lower the owner's floor. Every such writer in this repo writes
	 * `currentMinuteMs()` or later; holding the floor at least `guardMinutes` behind the current
	 * minute means those rows land ABOVE it by construction, on every node, with no signalling,
	 * no peer notification and no table subscription (both of which were considered and rejected
	 * for Stage 1 as unverified and unmeasured).
	 *
	 * The clamp also absorbs, for free, three otherwise separate hazards: an empty pass that
	 * tried to advance the floor to the current minute, a backwards clock step, and a floor that
	 * somehow survived into a new worker generation.
	 */
	const readFloorMinute = (nowMinute, guardMinutes) => {
		const stored = Atomics.load(i32, H_FLOOR);
		if (stored <= 0) return 0;
		return Math.max(0, Math.min(stored, (nowMinute | 0) - Math.max(0, guardMinutes | 0)));
	};

	const rawFloorMinute = () => Atomics.load(i32, H_FLOOR);

	/**
	 * Lower the floor to `minute` if it is not already at or below it — a CAS-MIN loop, never a
	 * store. A schedule write and a claim pass run on different workers and only the claim pass
	 * holds the mutex, so an unconditional store here would happily erase a floor another worker
	 * advanced (or, worse, a lowering another writer had just made). CAS-min composes: whoever
	 * writes the earliest due time wins, in any interleaving.
	 *
	 * `minute <= 0` stores 0, which is "no floor" — the correct reading of a due time at or
	 * before the epoch minute (the `nextRenderTime = 1` trick, a `PUT` with a junk value): the
	 * next pass seeks from the absolute minimum and finds it.
	 */
	const lowerFloorTo = (minute) => {
		const target = Math.max(0, minute | 0);
		for (;;) {
			const current = Atomics.load(i32, H_FLOOR);
			if (current === 0) break; // already unbounded — nothing lower to go to
			if (target >= current) break;
			if (Atomics.compareExchange(i32, H_FLOOR, current, target) === current) break;
		}

		// Mark the earliest known due minute too, so `deriveQueueStatus` can answer "there is
		// work" without a scan. `0` is the "unknown" marker in that slot, so a due minute of 0
		// is recorded as 1 — one minute of imprecision in a status hint, versus losing it.
		const mark = Math.max(1, target);
		for (;;) {
			const current = Atomics.load(i32, H_EARLIEST_NOT_DUE);
			if (current !== 0 && current <= mark) break;
			if (Atomics.compareExchange(i32, H_EARLIEST_NOT_DUE, current, mark) === current) break;
		}
	};

	/**
	 * Advance the floor from the value the pass started at to what the pass derived. A CAS, and
	 * a FAILED CAS IS ABANDONED, never retried: a failure means somebody lowered the floor while
	 * this pass was reading, and that lowering is about a row this pass could not have seen. The
	 * next pass re-derives from the index.
	 */
	const advanceFloor = (expectedMinute, nextMinute) => {
		const expected = Math.max(0, expectedMinute | 0);
		const next = Math.max(0, nextMinute | 0);
		return Atomics.compareExchange(i32, H_FLOOR, expected, next) === expected;
	};

	const resetFloor = () => Atomics.store(i32, H_FLOOR, 0);

	/**
	 * Record what one claim pass saw: whether anything was due, and the minute of the earliest
	 * NOT-YET-DUE row it reached (0 = it reached none).
	 *
	 * A STORE, NOT A CAS-MIN, and that is the fix for a latch. The pass drained every row from the
	 * floor up to the first future one, so it is authoritative about the whole window — including the
	 * case that matters, a horizon that has moved LATER because the row that used to name it has since
	 * rendered. Under a CAS-min that later horizon was discarded, so once a recorded minute arrived
	 * `deriveQueueStatus` answered `queued` for the life of the buffer while `claim` kept answering
	 * `empty`: the node flapped, rewrote the replicated `QueueStatus` row about twice a minute, and no
	 * consumer in the fleet ever reached its idle interval.
	 *
	 * The CAS-min stays where it belongs, in `lowerFloorTo`: a funnel write is authoritative about its
	 * OWN row and nothing else, so it may only pull the mark earlier. The price of the store is that a
	 * funnel write racing the exact end of a pass can lose its mark — one `statusSyncInterval` of
	 * reporting `empty`, and every such writer also calls `QueueState.reportStatus('queued')` itself.
	 * The FLOOR half of that write, which is the correctness half, is a CAS-min and cannot be lost.
	 */
	const recordPassOutcome = ({ sawDue, earliestNotYetDueMinute } = {}) => {
		Atomics.store(i32, H_SAW_DUE, sawDue ? 1 : 0);
		Atomics.store(i32, H_EARLIEST_NOT_DUE, Math.max(0, earliestNotYetDueMinute | 0));
	};

	const readPassOutcome = () => ({
		sawDue: Atomics.load(i32, H_SAW_DUE) === 1,
		earliestNotYetDueMinute: Atomics.load(i32, H_EARLIEST_NOT_DUE),
	});

	/**
	 * Note which key the claim floor is pinned at and return how long THIS pin has lasted, in ms.
	 * `0` both when there is no pin and on the pass that first observes one — a duration, not a count,
	 * so "no pin yet" and "just started" are the same answer and neither can trip a threshold.
	 *
	 * WHY IT IS MEASURED IN TIME AND NOT IN PASSES. A count of passes is not a duration: the render
	 * fleet polls on its own cadence, so fifty passes is a few seconds behind a nine-pod fleet and
	 * over an hour behind one idle consumer — while what makes a pin pathological is only ever how
	 * long it lasts. (And it lives in the SHARED header, not in module state, because a claim pass runs
	 * on whichever worker the consumer's poll landed on: a per-worker counter would be divided by the
	 * worker count and never reach a threshold at all.)
	 *
	 * Stored as seconds against `LEASE_EPOCH_SEC`, the same idiom as a lease expiry, because a raw ms
	 * timestamp does not fit an Int32.
	 *
	 * `H_PIN_LO` ALONE ANSWERS "is anything pinned", and the stored second is never a sentinel for
	 * anything. `lease64` never returns a `lo` of 0, so 0 there is an unambiguous "no pin", exactly as
	 * it is in a slot — whereas treating a `sinceSec` of 0 as "unset" collided with the real second 0
	 * (`LEASE_EPOCH_SEC` itself), and a pin first observed inside that one-second window then re-stamped
	 * itself on every pass and could never age past 0. Narrow, but it is the class of bug the epoch
	 * offset exists to avoid, and `H_PIN_LO` already carries the information.
	 *
	 * PUBLISH ORDER, mirroring `grant`: the second and the high word first, `H_PIN_LO` last. A reader
	 * that sees a matching `lo` has therefore already seen the timestamp that belongs with it, instead
	 * of pairing a new holder with the previous holder's start time and reporting a huge age.
	 */
	const notePinnedBy = (cacheKey) => {
		if (!cacheKey) {
			Atomics.store(i32, H_PIN_LO, 0);
			Atomics.store(i32, H_PIN_HI, 0);
			Atomics.store(i32, H_PIN_SINCE, 0);
			return 0;
		}
		const { lo, hi } = lease64(cacheKey);
		const nowSec = nowSecond();
		if (Atomics.load(i32, H_PIN_LO) !== lo || Atomics.load(i32, H_PIN_HI) !== hi) {
			Atomics.store(i32, H_PIN_SINCE, nowSec);
			Atomics.store(i32, H_PIN_HI, hi);
			Atomics.store(i32, H_PIN_LO, lo);
			return 0;
		}
		// Clamped at 0 so a backwards clock step reads as a fresh pin rather than as a negative age
		// that could never cross a threshold again.
		return Math.max(0, (nowSec - Atomics.load(i32, H_PIN_SINCE)) * 1000);
	};

	/** How long the current pin has lasted, without recording anything. Observability. */
	const readPinAgeMs = () => {
		if (Atomics.load(i32, H_PIN_LO) === 0) return 0;
		return Math.max(0, (nowSecond() - Atomics.load(i32, H_PIN_SINCE)) * 1000);
	};

	/** Zero everything. Tests only — see `resetRenderQueueState` in util/renderSchedule.js. */
	const resetAll = () => i32.fill(0);

	return {
		slots: slotCount,
		isLeased,
		grant,
		release,
		occupancy,
		scanLive,
		leaseOf,
		readFloorMinute,
		rawFloorMinute,
		lowerFloorTo,
		advanceFloor,
		resetFloor,
		recordPassOutcome,
		readPassOutcome,
		notePinnedBy,
		readPinAgeMs,
		resetAll,
	};
};

/** The named cross-worker buffer this table lives in. Versioned, so a future layout change gets
 *  a new name rather than a differently-shaped view of the old bytes. */
export const LEASE_SAB_KEY = 'render_queue_v1';
