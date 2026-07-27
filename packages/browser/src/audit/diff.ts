// Diff 1 classifier (spec §2.2) — SEO completeness: full render (A) vs served snapshot bytes (B).
//
// PURE function, no puppeteer. Given N Fingerprints per side, it builds a per-sample normalized
// TEXT key set, computes each key's presence frequency across the N samples on each side, and
// classifies every key into MISSING / MISSING_A_UNSTABLE / FLAKY_B / STALE / NOISE with two
// false-positive guards (digit-twin churn suppression + token-containment/fragmentation). It also
// reports jsonld @type drops, count-bucket halvings, and run-to-run self-Jaccard for confidence.
//
// Customer-agnostic: all site specifics (which selectors map to which bucket) already live inside
// the Fingerprints the caller passes; this module only compares.

import { normText, digitCollapse, tokenize, presenceCounts, jaccard, median, wordScore } from './util.js';
import type { Fingerprint, Finding, Diff1 } from './util.js';

/** Build one Finding (util contract shape). frequency.k is always freqA per §2.2. */
function mkFinding(
	symptom: string,
	sampleText: string,
	freqA: number,
	N: number,
	computedReason: string,
	confidence: 'high' | 'low'
): Finding {
	return {
		symptom,
		selectorPath: '', // text-line findings have no single element; Diff 2 fills selectors
		computedReason,
		sampleText,
		frequency: { k: freqA, n: N },
		fixType: null, // suggest.mjs assigns fixes downstream
		fixPatch: null,
		confidence,
	};
}

/**
 * diffContent(aFps, bFps, N) — classify the A/B text-key delta plus structured (jsonld/bucket) drops.
 * @param {Array} aFps  N full-render (ground-truth) Fingerprints
 * @param {Array} bFps  N served-snapshot Fingerprints
 * @param {number} N    samples per side
 * @returns {{missing,missingAUnstable,flakyB,stale,noise,jsonldMissing,bucketDrops,counts,selfJaccard}}
 */
export function diffContent(aFps: Fingerprint[], bFps: Fingerprint[], N: number): Diff1 {
	// --- per-sample normalized TEXT key sets (normText each line; drop empties) ---
	// origLine maps a normalized key back to a representative ORIGINAL line for sampleText.
	// A originals win (findings mostly quote the ground-truth line); B fills B-only keys (STALE).
	const origLine = new Map<string, string>();
	const toKeySet = (f: Fingerprint, claimOrig: boolean): Set<string> => {
		const set = new Set<string>();
		const lines = Array.isArray(f?.text) ? f.text : [];
		for (const line of lines) {
			const k = normText(line);
			if (!k) continue; // empty normalization => no comparable content
			set.add(k);
			if (claimOrig && !origLine.has(k)) origLine.set(k, line);
		}
		return set;
	};
	const aSets = aFps.map((f) => toKeySet(f, true)); // A originals claimed first
	const bSets = bFps.map((f) => toKeySet(f, false));
	// Fill in originals for keys that only exist on the B side (needed for STALE sampleText).
	for (const f of bFps) {
		const lines = Array.isArray(f?.text) ? f.text : [];
		for (const line of lines) {
			const k = normText(line);
			if (k && !origLine.has(k)) origLine.set(k, line);
		}
	}

	const freqA = presenceCounts(aSets);
	const freqB = presenceCounts(bSets);

	// --- per-side token / digit-twin sets + reading-order token STREAMS for the containment guards ---
	// bDigitSet/aDigitSet: digit-collapsed line twins → suppress counter/price churn ("130"→"132").
	// bStreams: each B sample's tokens joined in reading order → the fragmentation guard requires a
	//   MISSING phrase to appear CONTIGUOUSLY in B (re-chunked adjacently), not merely token-scattered
	//   across unrelated B lines — otherwise vocabulary-rich pages suppress genuine gaps. (review H5)
	// aTokenSet/aDigitSet: the symmetric guard for STALE (review M2).
	const bDigitSet = new Set<string>();
	const aDigitSet = new Set<string>();
	const aTokenSet = new Set<string>();
	for (const f of bFps)
		for (const line of Array.isArray(f?.text) ? f.text : [])
			if (digitCollapse(line)) bDigitSet.add(digitCollapse(line));
	for (const f of aFps) {
		for (const line of Array.isArray(f?.text) ? f.text : []) {
			for (const t of tokenize(line)) aTokenSet.add(t);
			if (digitCollapse(line)) aDigitSet.add(digitCollapse(line));
		}
	}
	const bStreams = bFps.map(
		(f) => ' ' + (Array.isArray(f?.text) ? f.text : []).flatMap((l: string) => tokenize(l)).join(' ') + ' '
	);

	const twoThirds = Math.ceil((2 * N) / 3); // ground-truth gate threshold ⌈2N/3⌉

	const missing: Finding[] = [];
	const missingAUnstable: Finding[] = [];
	const flakyB: Finding[] = [];
	const stale: Finding[] = [];
	const noiseSamples: string[] = [];
	let noiseCount = 0;

	const allKeys = new Set([...freqA.keys(), ...freqB.keys()]);
	for (const k of allKeys) {
		const fa = freqA.get(k) || 0;
		const fb = freqB.get(k) || 0;
		const line = origLine.get(k) ?? k;

		if (fa === N && fb === 0 && !bDigitSet.has(digitCollapse(line))) {
			// MISSING candidate. Containment guard: if the phrase appears CONTIGUOUSLY in some B sample,
			// B has it (re-chunked adjacently) => FRAGMENTED, not a real gap. Requiring adjacency (not
			// mere token presence anywhere) stops vocabulary-rich pages from suppressing real gaps.
			// A token-less junk line ([] tokens) => vacuously fragmented, dropped. (review H5)
			const toks = tokenize(k);
			const phrase = ' ' + toks.join(' ') + ' ';
			const fragmented = toks.length ? bStreams.some((s) => s.includes(phrase)) : true;
			if (!fragmented) {
				missing.push(
					mkFinding(
						'missing',
						line,
						fa,
						N,
						`Present in all ${N} full renders, absent from every served snapshot`,
						'high'
					)
				);
			}
			// fragmented => intentionally emitted nowhere (suppressed false positive)
		} else if (fa >= twoThirds && fa < N && fb === 0) {
			// A could not fully reproduce it (ground-truth gate lets ⌈2N/3⌉..N-1 through, low-confidence).
			missingAUnstable.push(
				mkFinding(
					'missing',
					line,
					fa,
					N,
					`Present in ${fa}/${N} full renders (A unstable), absent from every served snapshot`,
					'low'
				)
			);
		} else if (fa === N && fb > 0 && fb < N && !bDigitSet.has(digitCollapse(line))) {
			// Deterministic in A, near-miss in B — a settle/timing flake on the served side. Digit-churn
			// twins ("146,917 Items" vs "146,920") are excluded → they fall through to NOISE. (grid facets)
			flakyB.push(
				mkFinding(
					'flaky-b',
					line,
					fa,
					N,
					`Present in all ${N} full renders but only ${fb}/${N} served snapshots`,
					'low'
				)
			);
		} else if (
			fb === N &&
			fa === 0 &&
			!aDigitSet.has(digitCollapse(line)) &&
			!(tokenize(line).length && tokenize(line).every((t) => aTokenSet.has(t)))
		) {
			// In every snapshot but never in a real render — frozen/stale prerender-only content. Guarded
			// symmetrically to MISSING: skip count-churn twins ("130 Reviews" vs live "132") and lines
			// whose tokens all appear in A (same content, re-chunked) → those are NOISE, not stale. (review M2)
			stale.push(
				mkFinding('stale', line, fa, N, 'In every served snapshot but no full render (stale / prerender-only)', 'high')
			);
		} else {
			// NOISE (spec §2.2 "else"): gated-out (freqA<⌈2N/3⌉), digit-churn, variable, or
			// stable-shared content. Non-actionable → aggregate count + samples only.
			noiseCount++;
			noiseSamples.push(line);
		}
	}

	// Sort finding lists so real phrases outrank bare numbers/prices.
	const byWord = (a: Finding, b: Finding) => wordScore(b.sampleText) - wordScore(a.sampleText);
	missing.sort(byWord);
	missingAUnstable.sort(byWord);
	flakyB.sort(byWord);
	stale.sort(byWord);

	// NOISE: aggregate count + up to 12 representative samples (most word-y first).
	noiseSamples.sort((a, b) => wordScore(b) - wordScore(a));
	const noise = { count: noiseCount, samples: noiseSamples.slice(0, 12) };

	// --- jsonld: @types present in EVERY A sample but NO B sample (high value) ---
	const typePresence = (fps: Fingerprint[]): Map<string, number> => {
		const counts = new Map<string, number>(); // @type -> number of samples containing it
		for (const f of fps) {
			const seen = new Set<string>();
			const arr = Array.isArray(f?.jsonld) ? f.jsonld : [];
			for (const j of arr) {
				const t = j?.type;
				if (t == null || t === '') continue;
				seen.add(t);
			}
			for (const t of seen) counts.set(t, (counts.get(t) || 0) + 1);
		}
		return counts;
	};
	const aTypes = typePresence(aFps);
	const bTypes = typePresence(bFps);
	const jsonldMissing: string[] = [];
	for (const [t, ca] of aTypes) {
		// present in EVERY A sample AND no B sample
		if (aFps.length > 0 && ca === aFps.length && !((bTypes.get(t) as number) > 0)) jsonldMissing.push(t);
	}
	jsonldMissing.sort();

	// --- count buckets: median(A) vs median(B) per bucket; flag halvings (medB < 0.5*medA) ---
	const bucketNames = new Set<string>();
	for (const f of aFps) for (const n of Object.keys(f?.buckets || {})) bucketNames.add(n);
	for (const f of bFps) for (const n of Object.keys(f?.buckets || {})) bucketNames.add(n);
	const counts: Record<string, { medA: number; medB: number }> = {};
	const bucketDrops: Diff1['bucketDrops'] = [];
	for (const name of bucketNames) {
		const medA = median(aFps.map((f) => f?.buckets?.[name] || 0));
		const medB = median(bFps.map((f) => f?.buckets?.[name] || 0));
		counts[name] = { medA, medB };
		if (medB < 0.5 * medA) bucketDrops.push({ name, medA, medB });
	}

	// --- self-Jaccard: mean pairwise run-to-run similarity of each side's text-key sets ---
	// Low A-self-Jaccard ⇒ the report banners the whole cell low-confidence. 1 if <2 samples.
	const meanPairwiseJaccard = (sets: Set<string>[]): number => {
		if (sets.length < 2) return 1;
		let sum = 0;
		let pairs = 0;
		for (let i = 0; i < sets.length; i++) {
			for (let j = i + 1; j < sets.length; j++) {
				sum += jaccard(sets[i], sets[j]); // jaccard() accepts iterables (Sets) directly
				pairs++;
			}
		}
		return pairs ? sum / pairs : 1;
	};
	const selfJaccard = { A: meanPairwiseJaccard(aSets), B: meanPairwiseJaccard(bSets) };

	return { missing, missingAUnstable, flakyB, stale, noise, jsonldMissing, bucketDrops, counts, selfJaccard };
}
