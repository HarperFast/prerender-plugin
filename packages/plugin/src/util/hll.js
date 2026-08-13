/**
 * HyperLogLog distinct-count sketch — the mechanism behind the crawl-breadth metric
 * (distinct URLs crawled per bot per day, see util/crawlStats.js).
 *
 * Why a sketch and not a counter or a table: distinct counts don't add (summing per-thread
 * tallies double-counts every URL two threads both saw), a URL-dimensioned analytics key
 * space would be the whole corpus (~10^6 keys per flush window), and a row-per-URL table
 * would put a storage write on the bot read path. An HLL register array is a fixed 16 KB
 * per (bot, day) at the default precision, costs one string hash + one byte max per observation,
 * and — the property
 * everything here leans on — merges LOSSLESSLY by element-wise max: merging two sketches
 * yields byte-for-byte the sketch a single observer of both streams would have built, so
 * per-thread/per-node shards reassemble into one exact-union global sketch at read time.
 * Merging never compounds the estimation error.
 *
 * Parameters: p is configurable (`crawlStats.precision`, default 14 → m = 16384 registers,
 * standard error ≈ 1.04/√m ≈ 0.8%); p is also the row size in BYTES-as-2^p, so it trades
 * estimate accuracy directly against replicated write volume. The hash is
 * cyrb53 (53-bit, imul-based — no BigInt, no allocation): 14 bits pick the register, the
 * remaining 39 bits feed the rank, so register saturation is not reachable at any realistic
 * URL-corpus cardinality (rank caps at 40 ≈ 2^39·m distinct values). The classic 32-bit
 * large-range correction is deliberately omitted: it exists for hash spaces the estimate
 * can approach, and 2^53 is not one.
 *
 * Estimation is the original Flajolet et al. formula with the small-range fallback
 * (linear counting while empty registers remain), which is where a day's sketch for a
 * low-traffic bot actually lives — so that path is tested as carefully as the asymptotic one.
 */

export const HLL_P = 14; // default precision; crawlStats.precision overrides it
export const HLL_REGISTERS = 1 << HLL_P; // 16384

/**
 * Every function below derives m from the ARRAY IT IS GIVEN rather than from a module constant,
 * which is what lets precision be configuration instead of a rebuild. m is always a power of two,
 * so `31 - clz32(m)` recovers p exactly and costs two integer ops on the hot path — nothing
 * against the per-character hash loop that dominates `addToSketch`.
 *
 * The consequence to respect: a sketch's LENGTH is its identity. Two sketches of different
 * precision describe different register spaces and cannot be merged — see `mergeSketch`.
 */
const precisionOf = (m) => 31 - Math.clz32(m);

// 2^-r, indexed by rank. Sized for the smallest supported precision (the smaller p is, the more
// rank bits, and so the larger the maximum rank): p = 8 → 45 rank bits → max rank 46. 64 covers
// every precision this can be configured to, with room to spare.
const POW2_NEG = new Float64Array(64);
for (let r = 0; r < POW2_NEG.length; r++) POW2_NEG[r] = 2 ** -r;

/** 53-bit string hash (cyrb53, public domain — bryc). Deterministic, allocation-free. */
export function hash53(str, seed = 0) {
	let h1 = 0xdeadbeef ^ seed;
	let h2 = 0x41c6ce57 ^ seed;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** A zeroed sketch at precision `p` (m = 2^p registers = 2^p bytes). */
export const createSketch = (p = HLL_P) => new Uint8Array(1 << p);

/**
 * A zeroed sketch in the SAME register space as `src` — the shape any accumulator that is
 * going to merge `src` must have.
 *
 * This exists to be reached for instead of `createSketch()` on every read path. The default
 * argument makes the wrong thing look right: an accumulator built at `HLL_P` silently skips
 * (see `mergeSketch`) every sketch a deployment wrote at a configured `crawlStats.precision`,
 * and a sketch that merged nothing estimates as 0 — a real-looking number, not an error.
 */
export const createSketchLike = (src) => new Uint8Array(src.length);

/** Observe one value. The entire hot-path cost of the crawl-breadth metric lives here. */
export function addToSketch(registers, value) {
	const m = registers.length;
	const rankBits = 53 - precisionOf(m);
	const h = hash53(value);
	const index = h & (m - 1);
	// The remaining bits, exact: h < 2^53 so this division is integer-safe.
	const rest = Math.floor(h / m);
	// rank = leading zeros within the rank field + 1; rest === 0 → all zeros → rankBits + 1.
	const hi = Math.floor(rest / 4294967296);
	const bitLength = hi !== 0 ? 64 - Math.clz32(hi) : rest !== 0 ? 32 - Math.clz32(rest) : 0;
	const rank = rankBits - bitLength + 1;
	if (rank > registers[index]) registers[index] = rank;
}

/**
 * Union `src` into `dest` (element-wise max), in place. Merging shards is exact with
 * respect to set union — see the module comment.
 */
export function mergeSketch(dest, src) {
	// Different precision is a different register space: register i of a p=12 sketch and register
	// i of a p=14 one describe unrelated hash slices, so element-wise max across them is not a
	// union — it is garbage that reads as a plausible number. Skip instead. This is reachable
	// whenever `crawlStats.precision` changes: for the rest of that day the node's own new-shape
	// sketch simply ignores old-shape rows (an undercount that self-heals at rollover), and a
	// cross-node read ignores shards from nodes still on the old value until they roll too.
	if (src.length !== dest.length) return dest;
	for (let i = 0; i < dest.length; i++) {
		if (src[i] > dest[i]) dest[i] = src[i];
	}
	return dest;
}

/** Estimated cardinality of the set the sketch observed. */
export function estimateSketch(registers) {
	const m = registers.length;
	const alpha = 0.7213 / (1 + 1.079 / m);
	let sum = 0;
	let zeros = 0;
	for (let i = 0; i < m; i++) {
		const r = registers[i];
		sum += POW2_NEG[r];
		if (r === 0) zeros++;
	}
	const raw = (alpha * m * m) / sum;
	// Small-range: linear counting is the better estimator while empty registers remain.
	if (raw <= 2.5 * m && zeros > 0) {
		return Math.round(m * Math.log(m / zeros));
	}
	return Math.round(raw);
}
