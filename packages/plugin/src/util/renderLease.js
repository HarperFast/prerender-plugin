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

// Header: [floorMinute, occupancy, lastPassSawDue, earliestNotYetDueMinute]
const H_FLOOR = 0;
const H_OCCUPANCY = 1;
const H_SAW_DUE = 2;
const H_EARLIEST_NOT_DUE = 3;
const HEADER_INT32 = 4;

// Slot: [hashLo, hashHi, expiresSec, dueMinute]
const S_LO = 0;
const S_HI = 1;
const S_EXPIRES = 2;
const S_DUE = 3;
const SLOT_INT32 = 4;

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

/** Byte size of a lease buffer with `slots` slots. 4,096 slots = 65,552 B. */
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

	const isLeased = (cacheKey) => {
		const { lo, hi } = lease64(cacheKey);
		const nowSec = nowSecond();
		const { found } = locate(lo, hi, nowSec);
		if (found === -1) return false;
		return isLive(Atomics.load(i32, base(found) + S_EXPIRES), nowSec);
	};

	const leaseOf = (cacheKey) => {
		const { lo, hi } = lease64(cacheKey);
		const nowSec = nowSecond();
		const { found } = locate(lo, hi, nowSec);
		if (found === -1) return null;
		const at = base(found);
		const expiresSec = Atomics.load(i32, at + S_EXPIRES);
		if (!isLive(expiresSec, nowSec)) return null;
		return { leaseExpiresAtMs: fromExpiresSec(expiresSec), dueMinute: Atomics.load(i32, at + S_DUE) };
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
		Atomics.store(i32, at + S_HI, hi);
		Atomics.store(i32, at + S_EXPIRES, toExpiresSec(leaseExpiryMs));
		Atomics.store(i32, at + S_DUE, dueMinute | 0);
		if (Atomics.compareExchange(i32, at + S_LO, observedLo, lo) !== observedLo) return false;
		if (observedLo === 0) Atomics.add(i32, H_OCCUPANCY, 1);
		return true;
	};

	/**
	 * Release the lease for `cacheKey`. Idempotent; false when this key does not hold one.
	 *
	 * Keyed on the hash pair, never on a slot index remembered from earlier: the slot a key
	 * hashed to can have been recycled by another key in between, and clearing it by index would
	 * silently free somebody else's lease.
	 */
	const release = (cacheKey) => {
		const { lo, hi } = lease64(cacheKey);
		const { found } = locate(lo, hi, nowSecond());
		if (found === -1) return false;
		const at = base(found);
		if (Atomics.load(i32, at + S_HI) !== hi) return false;
		if (Atomics.compareExchange(i32, at + S_LO, lo, 0) !== lo) return false;
		Atomics.store(i32, at + S_EXPIRES, 0);
		Atomics.sub(i32, H_OCCUPANCY, 1);
		return true;
	};

	const occupancy = () => Math.max(0, Atomics.load(i32, H_OCCUPANCY));

	/**
	 * Full slot walk: live count, oldest expiry, and the due minute that oldest lease is holding
	 * the floor at. O(slots) — for the admin console only, never the claim path. Reconciles the
	 * best-effort occupancy gauge on the way past, so a lost increment/decrement (a stomped CAS,
	 * a lease that expired rather than being released) self-corrects.
	 */
	const scanLive = () => {
		const nowSec = nowSecond();
		let count = 0;
		let oldestExpiresSec = null;
		let oldestDueMinute = null;
		for (let slot = 0; slot < slotCount; slot++) {
			const at = base(slot);
			if (Atomics.load(i32, at + S_LO) === 0) continue;
			const expiresSec = Atomics.load(i32, at + S_EXPIRES);
			if (!isLive(expiresSec, nowSec)) continue;
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

	const recordPassOutcome = ({ sawDue, earliestNotYetDueMinute } = {}) => {
		Atomics.store(i32, H_SAW_DUE, sawDue ? 1 : 0);
		const mark = Math.max(0, earliestNotYetDueMinute | 0);
		if (mark === 0) {
			Atomics.store(i32, H_EARLIEST_NOT_DUE, 0);
			return;
		}
		// CAS-min, not a store: a funnel write during this pass may have marked something
		// earlier, and that mark is the only reason the next status recompute knows there is work.
		// (A write racing the exact end of a pass can still lose its mark; it costs one
		// `statusSyncInterval` of reporting `empty`, and every such writer also calls
		// `QueueState.reportStatus('queued')` itself. The FLOOR half of a funnel write — the
		// correctness half — cannot be lost, because it is a CAS-min too.)
		for (;;) {
			const current = Atomics.load(i32, H_EARLIEST_NOT_DUE);
			if (current !== 0 && current <= mark) break;
			if (Atomics.compareExchange(i32, H_EARLIEST_NOT_DUE, current, mark) === current) break;
		}
	};

	const readPassOutcome = () => ({
		sawDue: Atomics.load(i32, H_SAW_DUE) === 1,
		earliestNotYetDueMinute: Atomics.load(i32, H_EARLIEST_NOT_DUE),
	});

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
		resetAll,
	};
};

/** The named cross-worker buffer this table lives in. Versioned, so a future layout change gets
 *  a new name rather than a differently-shaped view of the old bytes. */
export const LEASE_SAB_KEY = 'render_queue_v1';
