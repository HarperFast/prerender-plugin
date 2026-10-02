/**
 * AN HOURLY BUDGET SHARED BY EVERY WORKER THREAD ON A NODE, over a BigInt64Array the caller hands in (a shared
 * buffer in production, util/coordination.js `getSab`). No Harper dependency, so it can be tested across real
 * worker threads.
 *
 * ONE 64-BIT CELL PER LANE, holding the hour and the count together: `hourSinceEpoch << 32 | spent`. Every
 * reserve and release is a single compare-and-swap of that cell, so a thread can never see a new hour with the
 * old hour's count, or the old hour's count reset under it: there is no window between rolling the hour and
 * zeroing the count, because they are one write. (Hours since the epoch fit 32 bits for 490,000 years.) Each LANE
 * is its own count against the same limit: the entity registry spends real adoptions in one and dry-run adoptions
 * in the other, so a dry run measures what the cap would do without spending the slots a real adoption needs.
 *
 * The hour only moves forward: a straggler carrying an older hour is refused rather than allowed to roll the cell
 * back and hand out the spent hour's budget again. This bounds load from a burst; it is not a safety property.
 */

const HOUR_MS = 3_600_000;
const COUNT_BITS = 32n;
const COUNT_MASK = (1n << COUNT_BITS) - 1n;

/** The BigInt64Array length a budget with `lanes` lanes needs. */
export const hourlyBudgetLength = (lanes) => lanes;

const hourOf = (cell) => Number(cell >> COUNT_BITS);
const countOf = (cell) => Number(cell & COUNT_MASK);
const pack = (hour, count) => (BigInt(hour) << COUNT_BITS) | BigInt(count);

/**
 * A budget over `cells()` (called on every use, so the caller can allocate lazily). `reserve(limit, nowMs, lane)`
 * takes a slot in `lane` this hour, false past `limit`; `release(lane, nowMs)` returns one taken this hour.
 */
export const createHourlyBudget = (cells) =>
	Object.freeze({
		reserve(limit, nowMs = Date.now(), lane = 0) {
			const i64 = cells();
			const hour = Math.floor(nowMs / HOUR_MS);
			for (let attempt = 0; attempt < 8; attempt++) {
				const seen = Atomics.load(i64, lane);
				const seenHour = hourOf(seen);
				if (hour < seenHour) return false; // a clock behind the cell: refuse, never roll back
				const used = hour === seenHour ? countOf(seen) : 0;
				if (used >= limit) return false;
				if (Atomics.compareExchange(i64, lane, seen, pack(hour, used + 1)) === seen) return true;
			}
			// Eight lost races: other workers are spending the budget right now. Refusing is the safe direction.
			return false;
		},
		release(lane = 0, nowMs = Date.now()) {
			const i64 = cells();
			const hour = Math.floor(nowMs / HOUR_MS);
			for (let attempt = 0; attempt < 8; attempt++) {
				const seen = Atomics.load(i64, lane);
				// A slot from an hour that has since rolled is already gone with it.
				if (hourOf(seen) !== hour || countOf(seen) === 0) return;
				if (Atomics.compareExchange(i64, lane, seen, seen - 1n) === seen) return;
			}
		},
		/** Tests: an empty budget. */
		reset() {
			const i64 = cells();
			for (let i = 0; i < i64.length; i++) Atomics.store(i64, i, 0n);
		},
	});
