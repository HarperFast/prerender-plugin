/**
 * The node-local render-lease table, in a shared buffer.
 *
 * A lease stops two renderers claiming the same key inside one lease window. It used to live in the
 * `RenderSchedule` row itself (`claim` wrote `now + jobLeaseTime` into `nextRenderTime`), which cost
 * a second write per render; here it is an atomic store, so one render costs exactly one schedule
 * write, the reschedule when its result lands.
 *
 * WHY A SHARED BUFFER AND NOT A TABLE. A lease is process-lifetime state, not a record, and it is
 * worth exactly zero database operations. Harper itself keeps this class of state in
 * `getUserSharedBuffer` — the id incrementer, the next-request-id, the blob file id, the
 * restart-needed flag — and `util/coordination.js` already wraps it for this plugin.
 *
 * NOTE IT IS NOT A `SharedArrayBuffer`. `getUserSharedBuffer` hands back a plain `ArrayBuffer` that is
 * nonetheless shared across the workers of one node, so `Atomics.load`/`store`/`compareExchange`/`add`
 * all work on it but `Atomics.wait`/`waitAsync` THROW. Every protocol here is lock-free and CAS-based.
 *
 * A GRANT IS EXCLUSIVE, and that is what lets claims run concurrently on every worker with no mutex
 * (#218: the store mutex the claim path used to take is not mutually exclusive). A key that holds a
 * live lease — in flight, or released and sitting out its grace — is refused, never renewed. The ready
 * set's cursor already hands each entry of one generation to one taker; a key published in two
 * consecutive generations is the case this closes, since two claims can then both take it.
 *
 * WHY LOSING EVERY LEASE ON RESTART IS THE CORRECT SEMANTICS. A lease is not a record of work; the
 * schedule row is. When the buffer is re-created zeroed at worker-generation replacement, the schedule
 * rows are still due and the next claim simply re-grants them. The cost is a duplicate-render burst —
 * at ~500 in flight per node a rolling four-node restart re-grants ~2,000 jobs whose original renderers
 * are still working, and both results are accepted (the later `PrerenderedPage.put` wins, with a correct
 * `expiresAt`). The one sharp edge is that two results for the same failing key each run
 * `Target.patch(url, { strikes })`, so a failing key can double-strike toward `maxStrikes`. That is
 * accepted: every candidate fix (gate the strike on lease presence, stamp a claim generation onto the
 * row) silently disables the `render.failureRetry.fastRetries` lane across restarts, which is worse.
 *
 * RELEASING A LEASE SHORTENS IT TO A GRACE; IT NEVER FREES THE SLOT ON THE SPOT. The result path
 * releases from a `finally` inside the request handler, and the reschedule it just issued is a
 * `Table.put` with no explicit context — it joined the AMBIENT transaction, which commits after the
 * handler's promise settles. So at the moment the lease is given up, committed state still shows the
 * row at its original due time, and a claim's durable-row check would pass. `release` therefore sets
 * the expiry to `now + RELEASE_GRACE_MS`: the key stays unclaimable for a few seconds while the
 * transaction becomes visible, and the slot is then reused exactly like any expired one. Committing the
 * transaction early instead is NOT an option: the request wrapper commits again.
 *
 * NOTE ON THIS MODULE'S DEPENDENCIES: it has none beyond the hash. No `config`, no Harper globals, not
 * even the `getSab` wrapper — the LIVE buffer is acquired in `util/renderSchedule.js`. This file is a
 * data structure, and keeping it importable from a bare `node --test` is what lets
 * `test/renderLease.test.js` drive the probe protocol, the expiry boundary and every CAS rule against a
 * plain `new ArrayBuffer()` with an injected clock.
 */

import { lease64 } from './hash.js';

/**
 * Lease expiries are stored as Int32 SECONDS relative to this fixed epoch, not as raw epoch
 * seconds. Raw epoch seconds fit an Int32 only until 2038-01-19; offsetting by a constant buys
 * ±68 years from the constant, and the constant is baked in rather than derived so two workers
 * (or a worker and its replacement) can never disagree about what a stored number means.
 */
export const LEASE_EPOCH_SEC = 1_700_000_000;

// Header: [occupancy]
const H_OCCUPANCY = 0;
const HEADER_INT32 = 1;

// Slot: [hashLo, hashHi, expiresSec, dueMinute, misses]
const S_LO = 0;
const S_HI = 1;
const S_EXPIRES = 2;
const S_DUE = 3;
// How many of this key's leases in a row EXPIRED rather than being released: the result never came
// (a renderer crash, a result that could not get back to this node), or the fast-retry lane held it.
// Reset by a release. See `missesBeforeGrant` and `hold`.
const S_MISSES = 4;
const SLOT_INT32 = 5;

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
 * `dueMinute` of a slot that is HELD BACK rather than leased (see `hold`): the key is unclaimable until
 * the expiry, but nothing is being rendered, so it counts in no gauge, and the miss count it carries is
 * neither reset (no result came) nor advanced (no render was attempted).
 */
const DUE_HELD = -2;

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
 * emit the job). Every read walks the whole window instead of stopping at the first empty slot, so
 * a released lease cannot break a later key's probe chain.
 */
const MAX_PROBE = 8;

export const LEASE_HEADER_BYTES = HEADER_INT32 * 4;
export const LEASE_SLOT_BYTES = SLOT_INT32 * 4;

/** Byte size of a lease buffer with `slots` slots. 4,096 slots = 81,924 B. */
export const leaseBufferBytes = (slots) => LEASE_HEADER_BYTES + LEASE_SLOT_BYTES * Math.max(0, slots | 0);

/** Slots that actually fit in a buffer of this size — the authority when a size assert fails. */
export const leaseSlotsIn = (byteLength) =>
	Math.max(1, Math.floor((byteLength - LEASE_HEADER_BYTES) / LEASE_SLOT_BYTES));

/**
 * The lease table over an arbitrary buffer, with the clock injected.
 *
 * A pure factory rather than a module-level singleton so the whole structure is testable with a plain
 * `new ArrayBuffer()` and no Harper globals at all. `util/renderSchedule.js` makes the one live call to
 * it, over the shared buffer named by `LEASE_SAB_KEY`.
 */
export const createLeaseTable = ({
	buffer,
	slots = leaseSlotsIn(buffer.byteLength),
	now = Date.now,
	// Tests only: called inside `grant`'s race window (fresh-slot payload stored, key not yet claimed),
	// so a test can run a concurrent grant there deterministically.
	onGrantWindow = null,
} = {}) => {
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
	// forever", and the reason `hashLo === 0` (not the expiry) is the emptiness marker.
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
			// it is the single linearization point of a fresh slot's publish below.
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
	 * A slot the OCCUPANCY GAUGE counts: a live lease that has not been released. `grant`, `release`
	 * and `scanLive` must all agree on this predicate, or the gauge drifts in both directions.
	 */
	const isCounted = (at, nowSec) =>
		Atomics.load(i32, at + S_LO) !== 0 &&
		isLive(Atomics.load(i32, at + S_EXPIRES), nowSec) &&
		Atomics.load(i32, at + S_DUE) >= 0;

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
	 * Lease `cacheKey`, EXCLUSIVELY: false when the key already holds a live lease (see the module
	 * comment), when the probe window is full, or when a concurrent grant won the slot. The caller
	 * MUST treat false as "do not hand out this job".
	 *
	 * Two linearization points, one per case:
	 *
	 *   - THE KEY'S OWN EXPIRED SLOT (`found`): a CAS on the EXPIRY, from the expired value read to the
	 *     new one. The key word cannot serve here — it already holds this key, so a CAS on it would let
	 *     two concurrent grants both succeed, which is the duplicate grant #218 measured.
	 *   - A FRESH SLOT (`free`, empty or another key's expired one): payload first (`hashHi`,
	 *     `expiresSec`, `dueMinute`), then a CAS on `hashLo`, so a reader that sees a matching `hashLo`
	 *     sees the payload written before it. Two grants racing for one fresh slot can leave the
	 *     winner's `hashLo` beside the loser's `hashHi`, which reads as "no lease for either key" — the
	 *     restart case, re-granted on a later claim; the window is a handful of non-yielding instructions.
	 *
	 * AND ONE LIVE SLOT PER KEY, checked after a fresh slot is won. A concurrent grant of the SAME key
	 * that ran `locate` inside this grant's window saw this slot's payload but not yet its key, so it
	 * neither found the key nor took the slot, and can have won ANOTHER fresh slot. Whichever of the two
	 * then sees the other's live slot gives its own back, so at most one is granted (both backing out is
	 * possible, and costs one claim attempt).
	 */
	const grant = (cacheKey, { dueMinute, leaseExpiryMs, held = false } = {}) => {
		const { lo, hi } = lease64(cacheKey);
		const nowSec = nowSecond();
		const { found, free } = locate(lo, hi, nowSec);
		const expiresSec = toExpiresSec(leaseExpiryMs);
		// Clamped at 0 so a caller's junk value can never land on a marker.
		const due = held ? DUE_HELD : Math.max(0, dueMinute | 0);

		if (found !== -1) {
			const at = base(found);
			const observed = Atomics.load(i32, at + S_EXPIRES);
			if (isLive(observed, nowSec)) return false;
			const misses = missesOf(at);
			Atomics.store(i32, at + S_DUE, due);
			if (Atomics.compareExchange(i32, at + S_EXPIRES, observed, expiresSec) !== observed) return false;
			Atomics.store(i32, at + S_MISSES, misses);
			if (!held) Atomics.add(i32, H_OCCUPANCY, 1);
			return true;
		}

		if (free === -1) return false;
		const at = base(free);
		const observedLo = Atomics.load(i32, at + S_LO);
		Atomics.store(i32, at + S_HI, hi);
		Atomics.store(i32, at + S_EXPIRES, expiresSec);
		Atomics.store(i32, at + S_DUE, due);
		Atomics.store(i32, at + S_MISSES, 0);
		onGrantWindow?.(cacheKey);
		if (Atomics.compareExchange(i32, at + S_LO, observedLo, lo) !== observedLo) return false;
		if (liveElsewhere(lo, hi, free, nowSec)) {
			Atomics.compareExchange(i32, at + S_LO, lo, 0);
			return false;
		}
		if (!held) Atomics.add(i32, H_OCCUPANCY, 1);
		return true;
	};

	/**
	 * Hold `cacheKey` back until `untilMs` without leasing it: the backoff for a key whose renders keep
	 * failing to report (see `claimSchedules`). Node-local and lost on restart, deliberately — it writes
	 * nothing durable, so a restart simply gives the key another attempt. A result that arrives for the
	 * key meanwhile (`release`) ends the hold after the usual grace and resets its miss count.
	 */
	const hold = (cacheKey, untilMs) => grant(cacheKey, { leaseExpiryMs: untilMs, held: true });

	/**
	 * The miss count a grant into the expired slot at `at` carries: reset by a release, carried unchanged
	 * through a hold (no render was attempted), and advanced by one for a lease that simply expired.
	 */
	const missesOf = (at) => {
		const due = Atomics.load(i32, at + S_DUE);
		const stored = Math.max(0, Atomics.load(i32, at + S_MISSES));
		if (due === DUE_RELEASED) return 0;
		return due === DUE_HELD ? stored : stored + 1;
	};

	/**
	 * How many of `cacheKey`'s leases in a row have just expired without a result: 0 when it holds no
	 * expired slot, when its last lease was released, and when what just ended was a HOLD — the attempt
	 * after a hold is always granted, carrying the count, so a key that still fails to report is held
	 * again for twice as long. The claim path uses it to bound a render that never reports (see
	 * `claimSchedules`). An undercount when the slot has been recycled by another key, never an overcount.
	 */
	const missesBeforeGrant = (cacheKey) => {
		const { lo, hi } = lease64(cacheKey);
		const nowSec = nowSecond();
		const { found } = locate(lo, hi, nowSec);
		if (found === -1) return 0;
		const at = base(found);
		if (isLive(Atomics.load(i32, at + S_EXPIRES), nowSec)) return 0;
		if (Atomics.load(i32, at + S_DUE) === DUE_HELD) return 0;
		return missesOf(at);
	};

	/** Does another slot in `lo`'s probe window hold a live lease for this key? */
	const liveElsewhere = (lo, hi, except, nowSec) => {
		const start = (lo >>> 0) % slotCount;
		for (let probe = 0; probe < MAX_PROBE && probe < slotCount; probe++) {
			const slot = (start + probe) % slotCount;
			if (slot === except) continue;
			const at = base(slot);
			if (
				Atomics.load(i32, at + S_LO) === lo &&
				Atomics.load(i32, at + S_HI) === hi &&
				isLive(Atomics.load(i32, at + S_EXPIRES), nowSec)
			) {
				return true;
			}
		}
		return false;
	};

	/**
	 * Give up the lease for `cacheKey`: the key stops counting as in flight immediately and becomes
	 * claimable again once its `RELEASE_GRACE_MS` grace has passed. Idempotent; false when this key
	 * holds no lease to give up.
	 *
	 * The slot is deliberately NOT published free — see the module comment on the commit-visibility
	 * grace. Nothing in this function writes `hashLo`, and the one payload word it does write is CAS'd
	 * against the value it read.
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

		// READ THE EXPIRY BEFORE RE-VALIDATING OWNERSHIP, and CAS against exactly this value below. The
		// other order hands this function a RECYCLER'S fresh expiry when the slot is recycled in between,
		// and the CAS then truncates somebody else's brand-new lease to a five-second grace: a duplicate
		// render, and on a failing key a duplicate strike toward `maxStrikes`.
		//
		// Reading it first is sufficient because `grant` publishes a recycled slot's payload BEFORE it
		// claims `hashLo`. A recycle that began before this read is caught by the ownership re-check; one
		// that landed after it necessarily stored a different expiry, so the CAS fails and nothing is
		// written.
		const expiresSec = Atomics.load(i32, at + S_EXPIRES);
		if (Atomics.load(i32, at + S_LO) !== lo || Atomics.load(i32, at + S_HI) !== hi) return false;

		// ONE release per lease, claimed with a CAS on the due-minute word. Two results for one key is
		// a documented case (the restart duplicate-render burst), and without this claim the second
		// would decrement the occupancy gauge for a grant that was only ever counted once.
		const dueMinute = Atomics.load(i32, at + S_DUE);
		if (dueMinute === DUE_RELEASED) return false;
		const wasCounted = isCounted(at, nowSec); // false for a hold: it was never counted
		if (Atomics.compareExchange(i32, at + S_DUE, dueMinute, DUE_RELEASED) !== dueMinute) return false;

		// Shorten to the grace, never lengthen (a lease that already expired stays expired), and only
		// if the expiry is still the one read above.
		const graceSec = toExpiresSec(now() + RELEASE_GRACE_MS);
		if (graceSec < expiresSec) Atomics.compareExchange(i32, at + S_EXPIRES, expiresSec, graceSec);
		if (wasCounted) Atomics.sub(i32, H_OCCUPANCY, 1);
		return true;
	};

	// Best-effort, and drifts ONLY EVER HIGH — but WITHOUT BOUND until something walks the slots, so
	// `scanLive` is a periodic obligation and not merely a console read. `grant`/`release` are exact
	// about every lease that ends in a RESULT; a lease that simply EXPIRES has nobody to decrement it.
	// `reconcileLeaseGauge` in util/renderSchedule.js walks the slots once per status sync.
	const occupancy = () => Math.max(0, Atomics.load(i32, H_OCCUPANCY));

	/**
	 * Full slot walk: in-flight count, oldest expiry, and that lease's due minute. Reconciles the
	 * best-effort occupancy gauge on the way past, so a lease that expired rather than being released
	 * (or a stomped CAS) stops inflating the gauge forever. O(slots) of plain Atomics loads.
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

	/** Zero everything. Tests only — see `resetRenderQueueState` in util/renderSchedule.js. */
	const resetAll = () => i32.fill(0);

	return {
		slots: slotCount,
		isLeased,
		grant,
		hold,
		release,
		occupancy,
		scanLive,
		leaseOf,
		missesBeforeGrant,
		resetAll,
	};
};

/** The named cross-worker buffer this table lives in. Versioned, so a layout change gets a new name
 *  rather than a differently-shaped view of the old bytes (v2: the claim floor's header words are gone,
 *  and a slot carries its miss count). */
export const LEASE_SAB_KEY = 'render_queue_v2';
