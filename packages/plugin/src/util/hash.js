// FNV-1a 32-bit (fast, deterministic). Used for node-residency rendezvous hashing
// and for deterministic per-key render-schedule jitter.
export function fnv1a32(str) {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
	}
	return h >>> 0;
}
