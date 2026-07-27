// Shared, customer-agnostic helpers + the data-shape CONTRACT for the prerenderability audit.
//
// The audit is the analysis counterpart to `renderOnce` (../renderOnce.ts): it renders one
// (url, device) cell in three states and reports the two content diffs that expose what bots miss.
// Everything here takes selectors/hosts/thresholds/renderOnce as ARGUMENTS and bakes in NO
// hostnames, tokens, or staging IPs — the site specifics live in the caller's config.
//
// ============================================================================================
// DATA SHAPES (the contract every module agrees on — these exact field names)
// ============================================================================================

import type { DeepPartial, PrerenderConfig, WaitForRule } from '../config.js';
export { noop } from '../util/noop.js';

/** Layout-independent head signals extracted once per render. */
export interface FingerprintMeta {
	title: string;
	metaDescription: string;
	canonical: string;
	robots: string;
	h1Count: number;
}

/** A link, keyed by its normalized href (normHref): origin+pathname, query sorted, hash dropped. */
export interface LinkKey {
	key: string;
	text: string;
}

/** An image, keyed by its normalized src (normSrcKey): normalized basename ('∅' for placeholders). */
export interface ImageKey {
	srcKey: string;
	alt: string;
}

/** One application/ld+json node: its @type + a (name|@id|sku) key; survives stripScripts. */
export interface JsonLdEntry {
	type: string;
	key: string;
}

/**
 * Structured, shadow-aware content fingerprint of one render — from extractContent(page, {buckets, mode}).
 * `mode:'visible'` keeps only text whose element passes checkVisibility; `mode:'structural'` keeps every
 * text node (i.e. "in the bytes at all"). `_visibleText` is stashed by state A's probe (the visible
 * ground truth for Diff 2's fidelity gate).
 */
export interface Fingerprint {
	meta: FingerprintMeta;
	headings: string[];
	links: LinkKey[];
	images: ImageKey[];
	jsonld: JsonLdEntry[];
	/** Visible (mode:'visible') or all-DOM (mode:'structural') text lines, whitespace-collapsed + deduped. */
	text: string[];
	/** bucketName -> shadow-aware element count (page-type selectors). */
	buckets: Record<string, number>;
	/** State-A probe stashes the visible-mode text here alongside the structural fingerprint. */
	_visibleText?: string[];
}

/** How many of n samples a finding fired in. */
export interface Frequency {
	k: number;
	n: number;
}

/** The config knob a fix routes to (null when a finding is a site bug, not a prerender-config lever). */
export type FixType = 'removeSelectors' | 'waitFor' | 'viewport' | 'resolveLazyImages' | null;

/**
 * One detected defect. The Diff-2 detectors emit this shape and the Diff-1 classifier reuses it.
 * `fixPatch` is either a selector string or a partial-config fragment. Optional fields are attached
 * downstream: `systematic` by the aggregator, `bucket*`/`_imgHosts` by the orchestrator/detectors.
 */
export interface Finding {
	symptom: string;
	/** Copy-pasteable selector for the offending element (selectorFor), '' when N/A. */
	selectorPath: string;
	/** Human one-liner explaining WHY it fired. */
	computedReason: string;
	/** Representative text (missing line / occluded content / …), may be ''. */
	sampleText: string;
	frequency: Frequency;
	fixType: FixType;
	fixPatch: string | Record<string, unknown> | null;
	confidence: 'high' | 'low';
	/** Set by the Diff-2 aggregator: fired in ≥half the C-loads. */
	systematic?: boolean;
	/** Attached by the orchestrator so suggest can emit a real waitFor rule for a dropped bucket. */
	bucketSelector?: string;
	bucket?: { selector?: string; name?: string };
	/** Detector-internal (frozen env-gate); stripped before the finding leaves detectors.ts. */
	_imgHosts?: string[];
}

/** Run-to-run self-similarity of each side's text-key sets (calibration/confidence banner). */
export interface SelfJaccard {
	A: number;
	B: number;
}

/** A count bucket that halved between the full render and the served bytes. */
export interface BucketDrop {
	name: string;
	medA: number;
	medB: number;
}

/** Non-actionable residue of the Diff-1 classification: aggregate count + a few samples. */
export interface NoiseInfo {
	count: number;
	samples: string[];
}

/** Diff 1 — SEO completeness (full render A vs served snapshot bytes B). */
export interface Diff1 {
	missing: Finding[];
	missingAUnstable: Finding[];
	flakyB: Finding[];
	stale: Finding[];
	noise: NoiseInfo;
	jsonldMissing: string[];
	bucketDrops: BucketDrop[];
	counts: Record<string, { medA: number; medB: number }>;
	selfJaccard: SelfJaccard;
}

/** Diff 2 — served fidelity (served bytes B vs the same bytes re-hydrated at the real URL, C). */
export interface Diff2 {
	findings: Finding[];
}

/** Render outcome as the harness reports it (renderOnce's RenderOutcome plus the audit's own gate). */
export type AuditOutcome = 'ok' | 'empty' | 'non-indexable' | 'http-error' | 'redirected' | 'error' | 'A_LOAD_FAILED';

/** The full result runAudit() returns for one (url, device) cell. */
export interface AuditResult {
	url: string;
	device: string | undefined;
	pageType: string;
	outcomeA: AuditOutcome;
	outcomeB: AuditOutcome;
	/** Did state A converge? (else MISSING is demoted to FLAKY and the cell is low-confidence). */
	aStabilized: boolean;
	selfJaccard: SelfJaccard;
	diff1: Diff1;
	diff2: Diff2;
	/** Aggregated partial PrerenderConfig patch (from suggest.ts); `_notes` is advisory-only. */
	suggestedConfig: SuggestedConfig;
	screenshots: { A?: Uint8Array; B?: Uint8Array; C?: Uint8Array };
	/** The served bytes (state B) for the report / verify. */
	bHtml: string | undefined;
	note: string;
}

/** The minimal fix patch suggest.ts emits: a partial config plus advisory `_notes`. */
export type SuggestedConfig = DeepPartial<PrerenderConfig> & { _notes?: string[]; waitFor?: WaitForRule[] };

// ============================================================================================
// Helpers
// ============================================================================================

type Plain = Record<string, unknown>;
const isPlainObject = (v: unknown): v is Plain => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep-merge `source` over `target`: nested plain objects recurse; arrays/scalars replace wholesale.
 *  Same semantics as the CLI's deepMerge and the browser package's mergeConfig. */
export function deepMerge(target: unknown, source: unknown): unknown {
	if (!isPlainObject(source) || !isPlainObject(target)) return source;
	const out: Plain = { ...target };
	for (const k of Object.keys(source)) {
		out[k] = isPlainObject(source[k]) && isPlainObject(out[k]) ? deepMerge(out[k], source[k]) : source[k];
	}
	return out;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Normalize a text line for cross-render comparison: lowercase, collapse non-alphanumerics to single
 *  spaces, trim. Empty result means "no comparable content" (skip). */
export const normText = (s: unknown): string =>
	String(s)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();

/** Digit-collapsed twin of a normalized line ("1 234 reviews" -> "# reviews"): used ONLY to suppress
 *  counter/price churn ("1,234 reviews" vs "1,235 reviews") from the MISSING bucket. */
export const digitCollapse = (s: unknown): string => normText(s).replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

/** Content tokens of a line (words ≥2 chars), for the containment/fragmentation guard. */
export const tokenize = (s: unknown): string[] =>
	normText(s)
		.split(' ')
		.filter((t) => t.length >= 2);

/** Rank real phrases above bare numbers/prices in a finding list. */
export const wordScore = (s: unknown): number => (String(s).match(/[a-zA-Z]{3,}/g) || []).length;

/** Normalize a link href to a comparison key: absolute origin+pathname, query params sorted, hash dropped.
 *  Relative/invalid hrefs resolve against baseUrl; unparseable ones fall back to the raw trimmed string. */
export function normHref(href: string, baseUrl: string): string {
	try {
		const u = new URL(href, baseUrl);
		if (/^https?:$/.test(u.protocol) === false) return (u.protocol + u.pathname).toLowerCase();
		const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
		const qs = params.length ? '?' + params.map(([k, v]) => `${k}=${v}`).join('&') : '';
		return (u.origin + u.pathname + qs).toLowerCase().replace(/\/$/, '');
	} catch {
		return String(href).trim().toLowerCase();
	}
}

/** Normalize an image src to a comparison key: the basename without query/hash, lowercased.
 *  data:/blank/1x1/placeholder srcs collapse to a sentinel so they never match a real image. */
export function normSrcKey(src: string): string {
	const s = String(src || '').trim();
	if (!s || /^data:/i.test(s) || /(loader|placeholder|spacer|blank|1x1|transparent)/i.test(s)) return '∅';
	try {
		const u = new URL(s, 'https://x/');
		const base = u.pathname.split('/').filter(Boolean).pop() || u.pathname;
		return base.toLowerCase();
	} catch {
		return (s.split('/').pop() || s).split('?')[0].toLowerCase();
	}
}

/** Jaccard similarity of two iterables of (already-normalized) keys. Accepts arrays or Sets. */
export function jaccard(aKeys: Iterable<string>, bKeys: Iterable<string>): number {
	const A = new Set(aKeys);
	const B = new Set(bKeys);
	if (!A.size && !B.size) return 1;
	let inter = 0;
	for (const k of A) if (B.has(k)) inter++;
	return inter / (A.size + B.size - inter);
}

/** Presence count of each key across an iterable of Sets (how many samples contain it). */
export function presenceCounts(keySets: Iterable<Set<string>>): Map<string, number> {
	const freq = new Map<string, number>();
	for (const set of keySets) for (const k of set) freq.set(k, (freq.get(k) || 0) + 1);
	return freq;
}

/** median of a numeric array (0 for empty). */
export const median = (xs: number[]): number => {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export type { DeepPartial, PrerenderConfig, WaitForRule };
