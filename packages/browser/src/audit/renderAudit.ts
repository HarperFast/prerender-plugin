// renderAudit — the prerenderability-audit orchestrator (the analysis counterpart to renderOnce).
//
// renderAudit() renders ONE (url, device) cell into an AuditResult (see util.ts DATA SHAPES):
//   • State A (ground truth): buildFullConfig(base) + a probe that runs sweep() then extractContent
//     (structural + visible), rendered N times. renderBudgetMs is raised so the exhaustive settle has room.
//   • State B (served snapshot): base config, rendered N times; we keep result.html (the bytes bots get).
//   • State C (re-hydrated): each B html is reloaded via loadServed() at the real URL; from that page we
//     take B_structural (extractContent structural = "what's in the bytes"), C_visible (for Diff 2), and
//     run auditServed() (the fidelity detectors).
//   • Diff 1 = diffContent(A, B_structural). Diff 2 = auditServed findings aggregated over the N C-loads.
//   • suggestFixes() rolls both diffs into one scoped config patch.
//
// CRITICAL: renderOnce mutates process-global settings and is single-flight — every render here is
// SEQUENTIAL (interleaved A,B,A,B… so a time-based promo can't bias one whole side).

import type { Browser } from 'puppeteer';
import renderOnce from '../renderOnce.js';
import type { ProbeContext, RenderResult } from '../renderOnce.js';
import { buildFullConfig, sweep } from './fullRender.js';
import { extractContent } from './extract.js';
import { diffContent } from './diff.js';
import { loadServed } from './serveState.js';
import { auditServed } from './detectors.js';
import { suggestFixes } from './suggest.js';
import { normText, noop } from './util.js';
import type { AuditOutcome, AuditResult, DeepPartial, Diff1, Fingerprint, PrerenderConfig } from './util.js';

// Must match FULL_RENDER_OVERRIDES.navigation.domStableTimeoutMs — the scroll loop's ceiling. If A's
// settle rode to (near) this, ground truth is truncated → aStabilized:false demotes MISSING→FLAKY.
const A_STABLE_CEIL_MS = 45000;

const emptyDiff1 = (): Diff1 => ({
	missing: [],
	missingAUnstable: [],
	flakyB: [],
	stale: [],
	noise: { count: 0, samples: [] },
	jsonldMissing: [],
	bucketDrops: [],
	counts: {},
	selfJaccard: { A: 0, B: 0 },
});

const pathOf = (u: string): string => {
	try {
		return new URL(u).pathname.replace(/\/$/, '');
	} catch {
		return '';
	}
};

/** Options for one (url, device) audit cell. `base` is the deployed config the fleet actually runs. */
export interface RenderAuditOptions {
	/** The deployed base config (DeepPartial PrerenderConfig) — state B renders with exactly this. */
	base: DeepPartial<PrerenderConfig>;
	url: string;
	device?: string;
	/** Samples per side (default 3). Interleaved A,B,A,B… so a time-based promo can't bias one side. */
	N?: number;
	/** Bot-mitigation bypass header/token for staging subrequests (must match the plugin's token). */
	bypass?: { header: string; token: string };
	/** Chrome `--host-resolver-rules` (`MAP host ip`) so a staging edge IP is reachable in this env. */
	hostResolverRules?: Record<string, string>;
	/** Page-type bucket selectors — name → CSS selector, shadow-aware element counts. */
	buckets?: Record<string, string>;
	/** Extra caller-known loader/placeholder selectors for the frozen detector. */
	spinnerSelectors?: string[];
	/** Extra caller-known overlay/backdrop selectors for the occlusion detector. */
	overlaySelectors?: string[];
	pageType?: string;
	/** Regex source scoping suggested waitFor rules to this page type's routes. */
	pathPattern?: string;
	/** Capture A/B/C screenshots for the report. Default true. */
	screenshots?: boolean;
	/** State-A per-render time budget (ms). Default 90000. */
	fullRenderBudgetMs?: number;
	/** State-A hydration sweep wall-clock budget (ms). Default 20000. */
	sweepDeadlineMs?: number;
}

// A renderOnce result OR the normalized error-fallback the interleave loop substitutes on throw. Only
// the fields the loop reads are declared; RenderResult satisfies all of them, the fallback the required one.
interface RenderAttempt {
	outcome: string;
	error?: { name?: string; message?: string } | undefined;
	finalUrl?: string;
	timings?: { settle?: number };
	probes?: Record<string, unknown>;
	screenshot?: Uint8Array;
	html?: string | undefined;
	browser?: Browser;
	close?: RenderResult['close'];
}

/**
 * Audit one (url, device) cell — the reusable prerenderability primitive.
 * @returns an AuditResult with Diff 1 (SEO completeness), Diff 2 (served fidelity), and a scoped fix patch.
 */
export async function renderAudit(o: RenderAuditOptions): Promise<AuditResult> {
	const {
		base,
		url,
		device,
		N = 3,
		bypass,
		hostResolverRules = {},
		buckets = {},
		spinnerSelectors = [],
		overlaySelectors = [],
		pageType = '',
		pathPattern = '',
		screenshots = true,
		fullRenderBudgetMs = 90000,
		sweepDeadlineMs = 20000,
	} = o;

	const fullConfig = buildFullConfig(base);
	const blockUrlPatterns = (base && base.block && base.block.urlPatterns) || [];
	const resolvedHosts = Object.keys(hostResolverRules || {});
	// `pageType` reaches the RENDER, not just the report grouping. It was a label only, which was
	// harmless while nothing in a render consulted it — but a `waitFor` rule scoped with
	// `pageTypes` would then be skipped on every audit render, so state B would settle differently
	// from the fleet it is supposed to reproduce and the audit would report content as missing that
	// production actually captures. Empty string (the default) is passed as undefined so an
	// unlabelled audit is "no page type", not a type named ''.
	const common = { device, bypass, hostResolverRules, pageType: pageType || undefined };

	// State A probe: hydrate, then extract BOTH modes from the live post-render page:
	//  • structural → the Diff-1 fingerprint (bots parse the DOM; visibility is irrelevant to "is the
	//    content in the bytes"). Comparing A-structural vs B-structural is symmetric, so hidden-but-present
	//    markup (nav drawers, collapsed menus, footer) doesn't masquerade as STALE.
	//  • visible    → stashed on `_visibleText` as the ground truth for Diff-2's fidelity gate: only
	//    content a user actually SAW in the full render can be a "lost when served" defect.
	const aProbe: Record<string, (ctx: ProbeContext) => Promise<Fingerprint>> = {
		A: async (ctx) => {
			await sweep(ctx.page, { deadlineMs: sweepDeadlineMs });
			const structural = await extractContent(ctx.page, { buckets, mode: 'structural' });
			const visible = await extractContent(ctx.page, { buckets, mode: 'visible' });
			structural._visibleText = visible.text || [];
			return structural;
		},
	};

	const aFps: Fingerprint[] = [];
	const bHtmls: string[] = [];
	let aShot: Uint8Array | undefined;
	let bShot: Uint8Array | undefined;
	let cShot: Uint8Array | undefined;
	let outcomeA: AuditOutcome = 'ok';
	let outcomeB: AuditOutcome = 'ok';
	let aSettleMax = 0;
	let finalUrlA: string | undefined;
	let finalUrlB: string | undefined;
	let keptBrowser: Browser | undefined;
	let keptClose: RenderResult['close'] | undefined;

	// ---- interleaved sequential sampling: A0,B0,A1,B1,… (single-flight safe) ----
	for (let i = 0; i < N; i++) {
		const a: RenderAttempt = await renderOnce({
			url,
			config: fullConfig,
			renderBudgetMs: fullRenderBudgetMs,
			probes: aProbe,
			screenshot: screenshots && i === 0,
			...common,
		}).catch((e): RenderAttempt => ({ outcome: 'error', error: { message: (e as Error)?.message } }));
		if (a.outcome !== 'ok') outcomeA = a.outcome as AuditOutcome;
		if (a.finalUrl) finalUrlA = a.finalUrl;
		if (a.timings?.settle) aSettleMax = Math.max(aSettleMax, a.timings.settle);
		const aFp = a.probes?.A as (Fingerprint & { error?: unknown }) | undefined;
		if (aFp && !aFp.error && Array.isArray(aFp.text)) aFps.push(aFp);
		if (screenshots && i === 0 && a.screenshot) aShot = a.screenshot;

		const last = i === N - 1;
		const b: RenderAttempt = await renderOnce({
			url,
			config: base,
			screenshot: screenshots && i === 0,
			keepOpen: last,
			...common,
		}).catch((e): RenderAttempt => ({ outcome: 'error', error: { message: (e as Error)?.message } }));
		if (b.outcome !== 'ok') outcomeB = b.outcome as AuditOutcome;
		if (b.finalUrl) finalUrlB = b.finalUrl;
		if (typeof b.html === 'string' && b.html) bHtmls.push(b.html);
		if (screenshots && i === 0 && b.screenshot) bShot = b.screenshot;
		if (last && b.browser) {
			keptBrowser = b.browser;
			keptClose = b.close;
		} else if (last && typeof b.close === 'function') {
			await b.close().catch(noop); // last render didn't keepOpen (errored) — nothing to reuse
		}
	}

	const base_result: AuditResult = {
		url,
		device,
		pageType,
		outcomeA,
		outcomeB,
		aStabilized: false,
		selfJaccard: { A: 0, B: 0 },
		diff1: emptyDiff1(),
		diff2: { findings: [] },
		suggestedConfig: {},
		screenshots: { A: aShot, B: bShot, C: undefined },
		bHtml: bHtmls[0],
		note: '',
	};

	// ---- guard: state A never loaded (bad token / staging down / captcha) → never accuse B ----
	const aTextMax = aFps.length ? Math.max(...aFps.map((f) => f.text?.length || 0)) : 0;
	const aHasTitle = aFps.some((f) => f.meta?.title);
	if (!aFps.length || (aTextMax < 20 && !aHasTitle)) {
		if (keptClose) await keptClose().catch(noop);
		return {
			...base_result,
			outcomeA: 'A_LOAD_FAILED',
			note: 'State A did not load (check bypass token / staging routing) — no diff computed.',
		};
	}

	const aStabilized = outcomeA === 'ok' && aSettleMax < A_STABLE_CEIL_MS * 0.98;
	const redirectDivergent = Boolean(
		finalUrlA && finalUrlB && pathOf(finalUrlA) && pathOf(finalUrlB) && pathOf(finalUrlA) !== pathOf(finalUrlB)
	);

	// ---- state C for each B html: B_structural + C_visible(detectors) ----
	const bFps: Fingerprint[] = [];
	const diff2Raw: import('./util.js').Finding[][] = [];
	// Diff-2 fidelity gate: content that was VISIBLE in the full render (A). A key hidden/absent in the
	// served page is only a defect if a user actually saw it in A — otherwise it's intentionally-hidden
	// UI (menus, drawers) that bots don't care about.
	const aVisibleKeys = [...new Set(aFps.flatMap((f) => (f._visibleText || []).map(normText).filter(Boolean)))];
	const aHadContentKeys = aVisibleKeys;
	if (keptBrowser && bHtmls.length) {
		for (let i = 0; i < bHtmls.length; i++) {
			let cPage;
			let failed;
			try {
				({ page: cPage, failed } = await loadServed(keptBrowser, { url, html: bHtmls[i], bypass, blockUrlPatterns }));
			} catch {
				continue; // a single C-load failure just drops that sample
			}
			try {
				const bFp = await extractContent(cPage, { buckets, mode: 'structural' });
				bFps.push(bFp);
				if (screenshots && !cShot) cShot = await cPage.screenshot({ fullPage: true }).catch(() => undefined);
				const bStructuralText = [...new Set((bFp.text || []).map(normText).filter(Boolean))];
				const res = await auditServed(cPage, {
					failed,
					bStructuralText,
					aHadContentKeys,
					spinnerSelectors,
					overlaySelectors,
					hostResolvedHosts: resolvedHosts,
				}).catch(() => ({ findings: [] }));
				diff2Raw.push(res.findings || []);
			} catch {
				// extractContent's page.evaluate can reject on a detached/crashed C page. Swallow it so the
				// loop continues AND the keptClose() below always runs — an uncaught throw here would orphan
				// the keepOpen Chrome (~500 MB). (review H2)
				continue;
			} finally {
				await cPage.close().catch(noop);
			}
		}
	}
	if (keptClose) await keptClose().catch(noop);

	// ---- guard: state C never loaded → can't measure B from bytes; degrade rather than cry wolf ----
	if (!bFps.length) {
		return {
			...base_result,
			aStabilized,
			note:
				'State C (served-bytes reload) failed for every sample — Diff 1/2 not computed. ' +
				(redirectDivergent ? 'Also: A/B redirected to different paths.' : ''),
			screenshots: { A: aShot, B: bShot, C: cShot },
		};
	}

	// ---- Diff 1 (match sample counts so freqA===N / freqB===N semantics hold) ----
	const Neff = Math.min(aFps.length, bFps.length);
	let diff1: Diff1;
	if (Neff < 2) {
		diff1 = { ...emptyDiff1(), selfJaccard: { A: 1, B: 1 } };
	} else {
		diff1 = diffContent(aFps.slice(0, Neff), bFps.slice(0, Neff), Neff);
	}

	// B-determinism gate: when the served snapshot itself varies run-to-run (low self-Jaccard — a lazy/
	// virtualized/personalized product grid), per-line FLAKY can't be told apart from that global variance,
	// so it's noise, not a fixable defect. Fold it into a note rather than headline 100+ "flaky" findings.
	let flakyNote = '';
	if (diff1.selfJaccard.B < 0.97 && diff1.flakyB.length) {
		flakyNote = `${diff1.flakyB.length} flaky-B line(s) suppressed — the served snapshot varies run-to-run (self-Jaccard ${diff1.selfJaccard.B.toFixed(2)}); treat as grid/personalization variance, not a defect.`;
		diff1.noise = { count: (diff1.noise?.count || 0) + diff1.flakyB.length, samples: diff1.noise?.samples || [] };
		diff1.flakyB = [];
	}

	// aStabilized:false ⇒ ground truth truncated ⇒ demote MISSING to low-confidence unstable (never accuse).
	if (!aStabilized && diff1.missing.length) {
		for (const f of diff1.missing) {
			f.confidence = 'low';
			f.computedReason += ' [state A did not stabilize — low confidence]';
		}
		diff1.missingAUnstable = [...diff1.missing, ...diff1.missingAUnstable];
		diff1.missing = [];
	}

	// ---- Diff 2: aggregate detector findings across the N C-loads (systematic vs intermittent) ----
	const agg = new Map<string, { finding: import('./util.js').Finding; k: number }>();
	for (const findings of diff2Raw) {
		const perRun = new Set<string>();
		for (const f of findings) {
			const key = f.symptom + '|' + (f.selectorPath || f.sampleText || ''); // selectorless findings need sampleText to stay distinct (review L1)
			if (perRun.has(key)) continue;
			perRun.add(key);
			const cur = agg.get(key);
			if (cur) cur.k++;
			else agg.set(key, { finding: f, k: 1 });
		}
	}
	const nC = diff2Raw.length || 1;
	const diff2Findings = [...agg.values()]
		.map(({ finding, k }) => ({ ...finding, frequency: { k, n: nC }, systematic: k >= Math.ceil(nC / 2) }))
		.sort((a, b) => Number(b.systematic) - Number(a.systematic) || b.frequency.k - a.frequency.k);
	const diff2 = { findings: diff2Findings };

	// Attribute a dropped bucket's SELECTOR to the text-line findings so suggestFixes can emit a real
	// waitFor rule (e.g. {selector:'[class*=review-]'}) instead of a TODO placeholder. diffContent only
	// knows bucket NAMES; the name→selector map (buckets) lives here. (review M7)
	const dropSel = (diff1.bucketDrops || []).map((d) => buckets[d.name]).find((sel) => typeof sel === 'string' && sel);
	if (dropSel) for (const f of [...diff1.missing, ...diff1.flakyB]) f.bucketSelector = dropSel;

	// ---- suggest one scoped patch ----
	const hasGap = diff1.missing.length || diff1.flakyB.length;
	const suggestedConfig = suggestFixes(diff1, diff2, {
		pageType,
		pathPattern,
		device,
		missingDevices: hasGap && device ? [device] : [],
	});

	const notes: string[] = [];
	if (flakyNote) notes.push(flakyNote);
	if (!aStabilized)
		notes.push(
			'State A did not fully stabilize (settle hit the ceiling) — MISSING demoted, treat this cell as low-confidence.'
		);
	if (redirectDivergent)
		notes.push(
			`A and B resolved to different paths (A=${finalUrlA} B=${finalUrlB}) — the two states may be different pages.`
		);
	if (Neff < 2) notes.push(`Only ${Neff} matched A/B sample(s) — diff skipped (need ≥2).`);
	if (diff1.selfJaccard.A < 0.8)
		notes.push(
			`Low A self-similarity (${diff1.selfJaccard.A.toFixed(2)}) — ground truth is noisy; trust structured buckets over text lines.`
		);

	return {
		url,
		device,
		pageType,
		outcomeA,
		outcomeB,
		aStabilized,
		selfJaccard: diff1.selfJaccard,
		diff1,
		diff2,
		suggestedConfig,
		screenshots: { A: aShot, B: bShot, C: cShot },
		bHtml: bHtmls[0],
		note: notes.join(' '),
	};
}

export default renderAudit;
