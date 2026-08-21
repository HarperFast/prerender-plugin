/**
 * ONE CLAIM WATERMARK PER LANE, over a shared buffer of its own.
 *
 * The floor is the entire performance story of the claim path, and #80 re-measured it per lane:
 * three lanes interleaved in one index read in 0.29-0.32 ms each WITH a watermark, and 3.46 ms
 * WITHOUT one. Interleaving is free; the watermark is the whole win. So a lane that has no
 * watermark of its own is a lane that seeks from the absolute minimum of its slice on every pass,
 * and it degrades the same way the unfloored scan did before v0.34.0 — 0.36 ms to 6.25 ms over
 * 40,000 reschedules, linear, and it did not recover when the churn stopped.
 *
 * ── WHY A SEPARATE BUFFER RATHER THAN MORE HEADER IN `renderLease.js` ───────────────────────────
 *
 * Because that module is a data structure with a probe protocol, an expiry boundary, a release
 * grace and an eight-rule CAS contract, all pinned by tests that run against a bare
 * `new ArrayBuffer()`. Widening its header changes the offset of every slot, and the named shared
 * buffer is SIZED BY ITS FIRST ALLOCATION — so a worker generation that allocated the old layout
 * hands the new code a correctly-sized-looking view with everything shifted. That is silent memory
 * corruption in the module that decides which URLs render.
 *
 * A second named buffer cannot do that. It is sized independently, it is absent-or-present rather
 * than subtly-misaligned, and the lease table keeps every invariant it already has. The cost is one
 * more `getUserSharedBuffer` key per node.
 *
 * ── THE FLOOR RULE IS THE SAME RULE, PER LANE ──────────────────────────────────────────────────
 *
 * Read `util/renderSchedule.js`'s module comment for why it is what it is; nothing about it changes
 * here except its scope. Per lane:
 *
 *   floor_new = the due minute of the FIRST DUE ROW THAT LANE'S PASS OBSERVED — granted, skipped as
 *               already-leased, or refused for any reason. If it observed no due row at all:
 *               `nowMinute - guard`.
 *
 * Stated per lane rather than globally because the hazard is per lane too: a wedged row pins its OWN
 * lane and nothing else. That is a strict improvement on the single global floor, where one
 * permanently-failing product page pinned the scan position for the homepage as well.
 *
 * ── MINUTES, DECODED ───────────────────────────────────────────────────────────────────────────
 *
 * A stored floor is a DUE MINUTE, never an encoded `nextRenderTime`. The lane's seek bound is
 * rebuilt as `lane * LANE_STRIDE + floorMinute * MINUTE` at query time. Storing the encoded form
 * would make floors incomparable across lanes — and "which lane is furthest behind" is the question
 * both the console and the unpin hatch ask.
 *
 * NO DEPENDENCIES beyond the hash, for the same reason `renderLease.js` has none: this is a data
 * structure, and `test/laneFloor.test.js` drives every CAS rule against a plain ArrayBuffer with an
 * injected clock rather than against a mock of Harper.
 */

import { lease64 } from './hash.js';

/** Per lane: [floorMinute, pinLo, pinHi, pinSinceSec]. */
const L_FLOOR = 0;
const L_PIN_LO = 1;
const L_PIN_HI = 2;
const L_PIN_SINCE = 3;
const LANE_INT32 = 4;

/**
 * Pin timestamps are Int32 SECONDS relative to this constant, matching `renderLease.js`: raw epoch
 * seconds overflow an Int32 in 2038, and a baked-in constant means two workers can never disagree
 * about what a stored number means.
 */
export const LANE_EPOCH_SEC = 1_700_000_000;

export const LANE_FLOOR_SAB_KEY = 'prerender/lane-floors';

/** Byte size of a lane-floor buffer for `lanes` lanes. */
export const laneFloorBufferBytes = (lanes) => LANE_INT32 * 4 * Math.max(1, lanes | 0);

/** How many lanes a buffer of this size holds. */
export const laneFloorLanesIn = (byteLength) => Math.max(1, Math.floor(byteLength / (LANE_INT32 * 4)));

const toSec = (ms) => Math.round(ms / 1000) - LANE_EPOCH_SEC;
const fromSec = (sec) => (sec + LANE_EPOCH_SEC) * 1000;

/**
 * @param {object} opts
 * @param {ArrayBuffer} opts.buffer  shared across the node's workers
 * @param {number} [opts.lanes]  lane count; clamped to what the buffer actually holds
 * @param {() => number} [opts.now]  injected clock, LATE-BOUND by the caller (see `leaseTable`)
 */
export const createLaneFloors = ({ buffer, lanes = laneFloorLanesIn(buffer.byteLength), now = Date.now } = {}) => {
	const i32 = new Int32Array(buffer);
	// Clamped to the buffer, never trusted from the argument: indexing past a short buffer is silent
	// corruption, whereas deriving the count from the buffer we actually got is merely fewer lanes —
	// and `renderSchedule.js` logs loudly when the two disagree.
	const laneCount = Math.max(1, Math.min(lanes | 0, laneFloorLanesIn(buffer.byteLength)));
	const base = (lane) => Math.min(Math.max(0, lane | 0), laneCount - 1) * LANE_INT32;

	/**
	 * The floor to seek this lane from, clamped `guard` minutes behind now on EVERY read.
	 *
	 * The guard is what makes a "render this URL now" write safe from any node with no cross-node
	 * coordination: schedule rows are residency-pinned, so most such writes are issued by a node that
	 * cannot lower the owner's floor — but they are written at the current minute, and every node
	 * holds its floor behind that by construction.
	 */
	const readFloorMinute = (lane, nowMinute, guard = 0) => {
		const stored = Atomics.load(i32, base(lane) + L_FLOOR);
		// A zero floor means NO FLOOR (seek the lane's absolute minimum), which is what a fresh buffer
		// and a deliberate reset both mean. Clamping it up to `nowMinute - guard` would silently turn
		// "re-derive from the bottom" into "skip everything older than the guard band" — i.e. it would
		// strand exactly the rows a reset exists to recover.
		if (stored <= 0) return 0;
		return Math.min(stored, Math.max(0, nowMinute - guard));
	};

	/**
	 * CAS-min: lower this lane's floor to cover `minute`, or leave it alone.
	 *
	 * The high-volume caller is every completed render writing `now + interval`, which is ABOVE the
	 * floor and therefore costs one atomic load and changes nothing. That negative half is where the
	 * win lives — a lowering on every render would rewind the floor continuously.
	 */
	const lowerFloorTo = (lane, minute) => {
		const at = base(lane) + L_FLOOR;
		const target = Math.max(0, Math.floor(minute));
		for (;;) {
			const current = Atomics.load(i32, at);
			// 0 already means unbounded, so nothing is lower.
			if (current !== 0 && current <= target) return false;
			if (Atomics.compareExchange(i32, at, current, target) === current) return true;
		}
	};

	/**
	 * Advance this lane's floor from the value the pass started at to what it observed. ABANDONS on
	 * conflict rather than retrying: a conflict means a funnel write lowered the floor for a row this
	 * pass never saw, and re-advancing over it would strand that row. The next pass re-derives.
	 */
	const advanceFloor = (lane, from, to) => {
		const at = base(lane) + L_FLOOR;
		const target = Math.max(0, Math.floor(to));
		if (target <= from) return false;
		return Atomics.compareExchange(i32, at, from, target) === from;
	};

	const resetFloor = (lane) => Atomics.store(i32, base(lane) + L_FLOOR, 0);

	const resetAllFloors = () => {
		for (let lane = 0; lane < laneCount; lane++) resetFloor(lane);
	};

	/**
	 * Record which key is holding this lane's floor and return how long it has held it, in ms.
	 * `null` clears the pin — a pass that found nothing due must not leave a stale pin ageing forever.
	 *
	 * The key is stored as its 64-bit hash rather than its text, because the buffer is fixed-width;
	 * the CALLER reports the readable key from its own pass result. The hash exists only to answer
	 * "is this the same row as last time".
	 */
	const notePinnedBy = (lane, cacheKey) => {
		const b = base(lane);
		if (!cacheKey) {
			Atomics.store(i32, b + L_PIN_LO, 0);
			Atomics.store(i32, b + L_PIN_HI, 0);
			Atomics.store(i32, b + L_PIN_SINCE, 0);
			return 0;
		}
		const { lo, hi } = lease64(cacheKey);
		const nowMs = now();
		const sameLo = Atomics.load(i32, b + L_PIN_LO) === lo;
		const sameHi = Atomics.load(i32, b + L_PIN_HI) === hi;
		if (sameLo && sameHi) {
			const since = Atomics.load(i32, b + L_PIN_SINCE);
			return since === 0 ? 0 : Math.max(0, nowMs - fromSec(since));
		}
		Atomics.store(i32, b + L_PIN_LO, lo);
		Atomics.store(i32, b + L_PIN_HI, hi);
		Atomics.store(i32, b + L_PIN_SINCE, toSec(nowMs));
		return 0;
	};

	/** Every lane's floor minute and pin age — what the console and the unpin hatch read. */
	const snapshot = (nowMs = now()) =>
		Array.from({ length: laneCount }, (_, lane) => {
			const b = base(lane);
			const since = Atomics.load(i32, b + L_PIN_SINCE);
			return {
				lane,
				floorMinute: Atomics.load(i32, b + L_FLOOR),
				pinnedForMs: since === 0 ? 0 : Math.max(0, nowMs - fromSec(since)),
			};
		});

	return {
		laneCount,
		readFloorMinute,
		lowerFloorTo,
		advanceFloor,
		resetFloor,
		resetAllFloors,
		notePinnedBy,
		snapshot,
	};
};
