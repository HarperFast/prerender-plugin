/**
 * HyperLogLog distinct-count sketch — the mechanism behind the crawl-breadth metric
 * (distinct URLs crawled per bot per day, see util/crawlStats.js).
 *
 * Why a sketch and not a counter or a table: distinct counts don't add (summing per-thread
 * tallies double-counts every URL two threads both saw), a URL-dimensioned analytics key
 * space would be the whole corpus (~10^6 keys per flush window), and a row-per-URL table
 * would put a storage write on the bot read path. An HLL register array is a fixed 16 KB
 * per (bot, day), costs one string hash + one byte max per observation, and — the property
 * everything here leans on — merges LOSSLESSLY by element-wise max: merging two sketches
 * yields byte-for-byte the sketch a single observer of both streams would have built, so
 * per-thread/per-node shards reassemble into one exact-union global sketch at read time.
 * Merging never compounds the estimation error.
 *
 * Parameters: p = 14 → m = 16384 registers, standard error ≈ 1.04/√m ≈ 0.8%. The hash is
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

export const HLL_P = 14;
export const HLL_REGISTERS = 1 << HLL_P; // 16384
const INDEX_MASK = HLL_REGISTERS - 1;
const RANK_BITS = 53 - HLL_P; // 39
const ALPHA = 0.7213 / (1 + 1.079 / HLL_REGISTERS);

// 2^-r for r in [0, 40] — estimate() is read-path only, but there's no reason to pay
// Math.pow in a 16k-iteration loop either.
const POW2_NEG = new Float64Array(RANK_BITS + 2);
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

export const createSketch = () => new Uint8Array(HLL_REGISTERS);

/** Observe one value. The entire hot-path cost of the crawl-breadth metric lives here. */
export function addToSketch(registers, value) {
	const h = hash53(value);
	const index = h & INDEX_MASK;
	// The remaining 39 bits, exact: h < 2^53 so this division is integer-safe.
	const rest = Math.floor(h / HLL_REGISTERS);
	// rank = leading zeros within the 39-bit field + 1; rest === 0 → all zeros → RANK_BITS + 1.
	const hi = Math.floor(rest / 4294967296); // top 7 bits
	const bitLength = hi !== 0 ? 64 - Math.clz32(hi) : rest !== 0 ? 32 - Math.clz32(rest) : 0;
	const rank = RANK_BITS - bitLength + 1;
	if (rank > registers[index]) registers[index] = rank;
}

/**
 * Union `src` into `dest` (element-wise max), in place. Merging shards is exact with
 * respect to set union — see the module comment.
 */
export function mergeSketch(dest, src) {
	for (let i = 0; i < HLL_REGISTERS; i++) {
		if (src[i] > dest[i]) dest[i] = src[i];
	}
	return dest;
}

/** Estimated cardinality of the set the sketch observed. */
export function estimateSketch(registers) {
	let sum = 0;
	let zeros = 0;
	for (let i = 0; i < HLL_REGISTERS; i++) {
		const r = registers[i];
		sum += POW2_NEG[r];
		if (r === 0) zeros++;
	}
	const raw = (ALPHA * HLL_REGISTERS * HLL_REGISTERS) / sum;
	// Small-range: linear counting is the better estimator while empty registers remain.
	if (raw <= 2.5 * HLL_REGISTERS && zeros > 0) {
		return Math.round(HLL_REGISTERS * Math.log(HLL_REGISTERS / zeros));
	}
	return Math.round(raw);
}
