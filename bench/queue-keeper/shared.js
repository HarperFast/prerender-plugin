/**
 * What both queue-keeper harnesses share: the synthetic corpus (keys, cadences, due times) and the
 * KEEPER itself, so the single-node and the two-node runs measure the same structure on the same rows.
 * Deterministic by row index, so every thread and every node agrees on a row without sharing state.
 */
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;

// Cadence mix shaped like a large retail corpus: overwhelmingly 48h product pages, a slow discovered tail, a sliver of
// catalog and the homepage. Only the SHAPE matters here: the keeper keeps one due-ordered list per class.
const CADENCES = [
	[1 * HOUR, 0.0001],
	[6 * HOUR, 0.02],
	[24 * HOUR, 0.03],
	[48 * HOUR, 0.8],
	[96 * HOUR, 0.1499],
];
const CADENCE_INDEX = new Map(CADENCES.map(([ms], i) => [ms, i]));
const OTHER_CLASS = CADENCES.length;

// Deterministic per-row properties, so the writer and the keeper agree without sharing state.
export const mix = (i) => {
	let x = (i + 0x9e3779b9) | 0;
	x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
	x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
	return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
};
const WORDS = [
	'womens',
	'mens',
	'sonoma',
	'goods',
	'for',
	'life',
	'short',
	'sleeve',
	'crewneck',
	'tee',
	'jeans',
	'straight',
	'fit',
	'nike',
	'running',
	'shoes',
	'kitchen',
	'aid',
	'stand',
	'mixer',
	'bedding',
	'queen',
	'set',
];
const slugFor = (i) => {
	const words = 7 + Math.floor(mix(i * 7 + 1) * 8);
	const out = [];
	for (let w = 0; w < words; w++) out.push(WORDS[Math.floor(mix(i * 31 + w) * WORDS.length)]);
	return out.join('-');
};
// Production cache keys are now URLs (one schedule row per URL), about 95-135 characters on product pages.
export const keyFor = (i) => `https://www.example.com/product/prd-${1_000_000 + i}/${slugFor(i)}.jsp`;
const cadenceFor = (i) => {
	const r = mix(i * 13 + 5);
	let acc = 0;
	for (const [ms, share] of CADENCES) if ((acc += share) > r) return ms;
	return 48 * HOUR;
};
const fromSitemapFor = (i) => mix(i * 17 + 3) < 0.97;
// Steady state: due times spread across each row's cadence, with ~2% already overdue.
export const recordFor = (i, nowMs, phase = mix(i * 19 + 11)) => {
	const cadence = cadenceFor(i);
	return {
		nextRenderTime: Math.round(nowMs - 0.02 * cadence + phase * cadence),
		fromSitemap: fromSitemapFor(i),
		effectiveInterval: cadence,
	};
};

// A cheap PRNG for picking which rows to reschedule.
export const prng = (seed) => {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		return (s >>> 0) / 4294967296;
	};
};

export const pct = (arr, p) => {
	if (!arr.length) return null;
	const sorted = Float64Array.from(arr).sort();
	return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
};
export const round = (n, d = 2) =>
	typeof n !== 'number' || !Number.isFinite(n) ? n : Math.round(n * 10 ** d) / 10 ** d;
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const yieldNow = () => new Promise((resolve) => setImmediate(resolve));

// ---- THE KEEPER: what design C would hold in memory ----------------------------------------------------
//
// `due`: key -> minute * 16 + class, a small integer (V8 stores it unboxed; minute ~ 2.98e7, x16 < 2^30).
// `buckets[class]`: minute -> Set of keys due in that minute. Within one class (same cadence and sitemap
// flag) priority order IS due order, so the best row overall is at the head of one class; `lo[class]` is
// that head's minute, advanced lazily.
export const classOf = (cadence, fromSitemap) =>
	(CADENCE_INDEX.get(cadence) ?? OTHER_CLASS) * 2 + (fromSitemap ? 1 : 0);
const CLASS_COUNT = (OTHER_CLASS + 1) * 2;
const CADENCE_OF_CLASS = (c) => (CADENCES[c >> 1] ?? [48 * HOUR])[0];

export class Keeper {
	constructor() {
		this.due = new Map();
		this.buckets = Array.from({ length: CLASS_COUNT }, () => new Map());
		this.lo = new Array(CLASS_COUNT).fill(Infinity);
	}

	apply(key, value) {
		const old = this.due.get(key);
		if (old !== undefined) {
			const oc = old & 15;
			const om = (old - oc) / 16;
			const set = this.buckets[oc].get(om);
			if (set) {
				set.delete(key);
				if (set.size === 0) this.buckets[oc].delete(om);
			}
		}
		// Not queued: a delete, or a row with no usable due time. `Number()` first: a Long can surface as a
		// BigInt, and a non-finite time must not become a NaN bucket.
		const due = value?.nextRenderTime;
		const dueMs = due === null || due === undefined ? NaN : Number(due);
		if (!Number.isFinite(dueMs)) {
			this.due.delete(key);
			return;
		}
		const c = classOf(Number(value.effectiveInterval), !!value.fromSitemap);
		const m = Math.floor(dueMs / MINUTE);
		this.due.set(key, m * 16 + c);
		let set = this.buckets[c].get(m);
		if (!set) this.buckets[c].set(m, (set = new Set()));
		set.add(key);
		if (m < this.lo[c]) this.lo[c] = m;
	}

	/** The best `k` due rows, scored the way the ready-set sweep scores them: lateness / cadence. */
	topK(k, nowMs, sitemapBoost = 2) {
		const nowMin = Math.floor(nowMs / MINUTE);
		const candidates = [];
		for (let c = 0; c < CLASS_COUNT; c++) {
			const map = this.buckets[c];
			if (!map.size) continue;
			const cadence = CADENCE_OF_CLASS(c);
			const boost = c & 1 ? sitemapBoost : 1;
			let taken = 0;
			let m = this.lo[c];
			// Advance past emptied head minutes once, so later calls start at the real head.
			while (m <= nowMin && !map.has(m)) m++;
			this.lo[c] = m;
			for (; m <= nowMin && taken < k; m++) {
				const set = map.get(m);
				if (!set) continue;
				const score = (((nowMin - m) * MINUTE) / cadence) * boost;
				for (const key of set) {
					candidates.push({ key, score });
					if (++taken >= k) break;
				}
			}
		}
		candidates.sort((a, b) => b.score - a.score);
		return candidates.length > k ? candidates.slice(0, k) : candidates;
	}

	counts(nowMs) {
		const nowMin = Math.floor(nowMs / MINUTE);
		let dueNow = 0;
		let nextHour = 0;
		for (const map of this.buckets) {
			for (const [m, set] of map) {
				if (m <= nowMin) dueNow += set.size;
				else if (m <= nowMin + 60) nextHour += set.size;
			}
		}
		return { rows: this.due.size, dueNow, nextHour };
	}
}
