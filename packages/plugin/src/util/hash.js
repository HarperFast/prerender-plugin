// FNV-1a 32-bit (fast, deterministic). Used for node-residency rendezvous hashing
// and for deterministic per-key render-schedule jitter.
//
// DO NOT CHANGE THIS FUNCTION'S OUTPUT. `util/residency.js` shards the whole keyspace with
// it and `util/time.js` seeds every target's initial-render jitter with it, so a different
// mixing constant silently re-shards the cluster (every RenderSchedule row moves owner) and
// re-jitters the entire corpus (one herd, once, at whatever minute the new offsets land on).
// A new hash goes in a NEW function, as `lease64` below does.
export function fnv1a32(str) {
	const s = String(str ?? '');
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
	}
	return h >>> 0;
}

/**
 * 64 bits of hash for a cache key, as two independent 32-bit words — the identity of a lease
 * slot in the node-local render-lease table (`util/renderLease.js`).
 *
 * WHY 64 BITS. The lease table is a fixed-size open-addressed array of ~4k slots, and a
 * collision between two DIFFERENT cache keys reads as a phantom lease on the second key. With
 * one 32-bit word and 4,096 live entries the birthday probability of at least one collision is
 * ~4.7e-4 per fill — a few times a day across a fleet, forever. With 64 bits it is ~1.1e-13,
 * i.e. never. (A collision is safe in both directions — see the phantom-lease note in
 * renderLease.js — but "safe" costs a skipped render pass, and there is no reason to pay it.)
 *
 * WHY TWO SALTED fnv1a32 PASSES AND NOT BigInt. This runs on the claim path, once per taken
 * entry. `BigInt` arithmetic is slow, allocates, and — the reason that actually matters here —
 * this repo has already been bitten twice by BigInt escaping into numeric guards:
 * `Number.isFinite(BigInt)` is false (see `Target.countedStrikes` and `resolveRenderInterval`,
 * which both coerce BEFORE the finite check because a Harper `Long` column can surface as
 * BigInt). Keeping the lease hash in plain int32 arithmetic means no new instance of that trap,
 * and it reuses the one hash function this package already has tests for.
 *
 * The salt is a prefix rather than a different mixing constant, so both words come from the
 * same well-understood function; the two words are independent because FNV-1a's avalanche over
 * a differing first byte is complete long before the end of a cache key.
 *
 * `lo` is the slot-occupancy marker in the table and `0` there means "empty", so a computed
 * `lo` of 0 is stored as 1. That is done here rather than at the call site so no caller can
 * forget it. The one-in-four-billion key that collides with the remapped value is just an
 * ordinary hash collision, handled by the `hi` comparison.
 */
export function lease64(key) {
	const s = String(key ?? '');
	const lo = fnv1a32(`L\u0000${s}`) | 0;
	return { lo: lo === 0 ? 1 : lo, hi: fnv1a32(`H\u0001${s}`) | 0 };
}
