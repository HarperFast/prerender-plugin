/**
 * AN HOURLY BUDGET SHARED BY EVERY WORKER THREAD ON A NODE, over an Int32Array the caller hands in (a shared
 * buffer in production, util/coordination.js `getSab`). No Harper dependency, so it can be tested across real
 * worker threads.
 *
 * Layout: [hourSinceEpoch, spent in lane 0, spent in lane 1, ...]. Hours since the epoch fit an int32 for a
 * quarter of a million years. Each LANE is its own count against the same limit: the entity registry spends
 * real adoptions in one and dry-run adoptions in the other, so a dry run measures what the cap would do without
 * spending the slots a real adoption needs.
 *
 * The window rolls forward only, and whoever wins the roll zeroes every lane — the shape of
 * util/invalidationReenqueue.js `reserveSlot`, for the same reasons: a straggler carrying an older hour must not
 * zero a count the new hour has spent, and a loser of a race costs or grants at most one slot. This bounds load
 * from a burst; it is not a safety property.
 */

const HOUR_MS = 3_600_000;
const B_HOUR = 0;

/** The Int32Array length a budget with `lanes` lanes needs. */
export const hourlyBudgetLength = (lanes) => 1 + lanes;

/**
 * A budget over `cell()` (called on every use, so the caller can allocate lazily). `reserve(limit, nowMs, lane)`
 * takes a slot in `lane` this hour, false past `limit`; `release(lane)` returns one.
 */
export const createHourlyBudget = (cell) => {
	const roll = (i32, nowMs) => {
		const hour = Math.floor(nowMs / HOUR_MS);
		const observed = Atomics.load(i32, B_HOUR);
		if (hour > observed && Atomics.compareExchange(i32, B_HOUR, observed, hour) === observed) {
			for (let lane = 1; lane < i32.length; lane++) Atomics.store(i32, lane, 0);
		}
	};
	return Object.freeze({
		reserve(limit, nowMs = Date.now(), lane = 0) {
			const i32 = cell();
			roll(i32, nowMs);
			const at = 1 + lane;
			for (let attempt = 0; attempt < 8; attempt++) {
				const used = Atomics.load(i32, at);
				if (used >= limit) return false;
				if (Atomics.compareExchange(i32, at, used, used + 1) === used) return true;
			}
			// Eight lost races: other workers are spending the budget right now. Refusing is the safe direction.
			return false;
		},
		release(lane = 0) {
			const i32 = cell();
			const at = 1 + lane;
			for (let attempt = 0; attempt < 8; attempt++) {
				const used = Atomics.load(i32, at);
				if (used <= 0 || Atomics.compareExchange(i32, at, used, used - 1) === used) return;
			}
		},
		/** Tests: an empty budget. */
		reset() {
			const i32 = cell();
			for (let i = 0; i < i32.length; i++) Atomics.store(i32, i, 0);
		},
	});
};
