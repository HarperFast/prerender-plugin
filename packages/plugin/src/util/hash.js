// FNV-1a 32-bit (fast, deterministic). Used for node-residency rendezvous hashing
// and for deterministic per-key render-schedule jitter.
export function fnv1a32(str) {
	const s = String(str ?? '');
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
	}
	return h >>> 0;
}
