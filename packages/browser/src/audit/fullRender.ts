// State A (FULL render / ground truth) support for the prerenderability audit — spec §§1.1–1.2.
//
// Two pieces:
//   • FULL_RENDER_OVERRIDES / buildFullConfig — the config deep-merged over the audited base so A
//     differs from B (the deployed snapshot) ONLY in the dimensions that can drop content:
//     scroll/settle budget, post-processing, and content-readiness. A Diff-1 gap is then
//     unambiguously "B's fast budget missed it," never a viewport or blocking artifact.
//   • sweep — an in-probe hydration pass run on the LIVE post-render page before extraction. The
//     renderer's own settle loop only scrolls the window; this also drains nested overflow scrollers
//     and forces lazy <img> eager. Probes run OUTSIDE the renderer's RemainingTimer, so the sweep
//     carries its OWN wall-clock deadline and every wait inside it is bounded.
//
// All in-page functions below are SELF-CONTAINED (puppeteer serializes only the function body, not
// this module's scope) and shadow-aware (every DOM walk recurses open shadowRoots).

import { deepMerge, sleep, noop } from './util.js';
import type { DeepPartial, PrerenderConfig } from './util.js';
import type { Page } from 'puppeteer';

// ── §1.1 FULL_RENDER_OVERRIDES ────────────────────────────────────────────────────────────────
// Deep-merged over the audited base. NOTE: block.urlPatterns is deliberately NOT overridden — the
// deployed tracker block-list (demdex/dynatrace/doubleclick…) carries zero indexable content and,
// left in place, keeps networkIdle meaningful (trailing beacons would otherwise hold it open
// forever). renderBudgetMs is NOT set here; the caller passes it to renderOnce as an option.
export const FULL_RENDER_OVERRIDES: DeepPartial<PrerenderConfig> = {
	// Load real images/fonts (nothing to stub) so image-onload-gated lazy modules fire and state C
	// has a real "what should load" baseline. Deployed urlPatterns are preserved by not naming them.
	block: { resourceTypes: [], stubImages: false },
	navigation: {
		networkIdleMs: 800, // wider idle window ⇒ higher confidence the network truly settled
		networkIdleTimeoutMs: 5000, // allow slow lazy fetches between passes
		domStableMs: 2000, // require 2s of DOM quiet before "done"
		domStableTimeoutMs: 45000, // ground truth may need longer than prod's p95; also bounds the scroll loop
		domStableTolerance: 8, // catch small late injections (a price block, a breadcrumb) — package default
		domStablePollMs: 250,
	},
	scroll: {
		enabled: true,
		settleUntilStable: true,
		stepFraction: 0.25, // quarter-viewport hops hold every band in view (full hops can skip a widget)
		stepMs: 250, // dwell so IntersectionObserver fires AND its fetch is in flight before the next hop
		settleStablePasses: 3, // three consecutive quiet passes before believing it's done
		topSettleMs: 600, // let scroll-reactive UI re-land before extraction
	},
	// postProcess is deliberately NOT overridden — state A INHERITS the deployed post-processing in full
	// (stripScripts, removeSelectors, flattenShadowDom, resolveLazyImages, …). Post-processing is
	// deterministic and identical for both states, so it can't cause a content gap; the ONLY dimensions
	// we let A differ from B in are the two that actually DROP content — resource blocking (images) and
	// the scroll/settle budget. If A skipped post-processing it would (a) keep intentionally-stripped UI
	// (feedback modals, language switchers) → false Diff-1 "missing", and (b) leave shadow DOM un-
	// flattened so light-DOM removeSelectors couldn't reach shadow content → more false missing. Sharing
	// post-processing makes Diff 1 isolate exactly what B's fast budget/blocking dropped.
	//
	// Dropped by default: ground truth must NOT depend on the very rule we're tuning (waitFor), else the
	// tool can't tell you a rule is needed. A's exhaustiveness comes from the slow scroll + sweep instead.
	waitFor: [],
};

/** Build the state-A config: the audited base with FULL_RENDER_OVERRIDES deep-merged on top.
 *  Uses the shared deepMerge (arrays/scalars replace wholesale; nested plain objects recurse). */
export function buildFullConfig(base: DeepPartial<PrerenderConfig>): DeepPartial<PrerenderConfig> {
	return deepMerge(base, FULL_RENDER_OVERRIDES) as DeepPartial<PrerenderConfig>;
}

// ── §1.2 Hydration sweep ──────────────────────────────────────────────────────────────────────

/**
 * Run the hydration sweep on the live post-render page (the first thing state-A's extract probe does).
 * Carries its own wall-clock deadline because probes run outside the renderer's RemainingTimer.
 *
 * @param {import('puppeteer').Page} page  live post-render page (do not launch a browser here)
 * @param {{ deadlineMs?: number }} [opts] absolute wall-clock budget for the whole sweep
 * @returns {Promise<{ swept: true, iters: number }>} iters = settle passes performed
 */
export async function sweep(
	page: Page,
	{ deadlineMs = 20000 }: { deadlineMs?: number } = {}
): Promise<{ swept: true; iters: number }> {
	const end = Date.now() + deadlineMs; // absolute wall-clock deadline; NOT the render budget

	// Force lazy <img> eager once up front so their fetches are in flight during the sweep.
	await page.evaluate(forceLazyEager).catch(noop);

	let last = -1;
	let stableIters = 0;
	let iters = 0;

	// Loop until two consecutive stable passes (|Δ count| ≤ 8) or the deadline. Both the loop and
	// every wait inside it are bounded, so this always terminates.
	while (Date.now() < end && stableIters < 2) {
		iters++;

		// Scroll the window AND every nested overflow scroller (shadow-aware); the in-page walk gets
		// its own remaining-time budget so a page that keeps growing content can't spin forever.
		const scrollBudget = Math.max(0, end - Date.now());
		await page.evaluate(scrollAllScrollables, 0.25, 200, scrollBudget).catch(noop);

		// Let fetches the scroll kicked off settle. Clamp the timeout to (0, 3000]: puppeteer treats
		// timeout:0 as "no timeout" (unbounded), so the floor of 1 guarantees a real bound.
		const idleTimeout = Math.max(1, Math.min(3000, end - Date.now()));
		await page.waitForNetworkIdle({ idleTime: 500, timeout: idleTimeout }).catch(noop);

		// Bounded image settle: resolve when all images (shadow-aware) are complete, else cap at 6s.
		await Promise.race([page.waitForFunction(allImagesComplete, { timeout: 6000 }), sleep(6000)]).catch(noop);

		// Best-effort webfont settle (returns a serializable boolean so page.evaluate can await it).
		// fonts.ready can NEVER settle if a webfont subresource stalls (TCP-accepted, never answered) —
		// and page.evaluate has no timeout, so .catch(noop) wouldn't save us. Bound it. (review H3)
		await Promise.race([page.evaluate(fontsReady), sleep(Math.min(2000, Math.max(1, end - Date.now())))]).catch(noop);

		// Shadow-aware element count (reuses the renderer's allocation-free walk).
		let count = last;
		try {
			count = await page.evaluate(countDomElements);
		} catch {
			count = last; // treat an evaluate failure as "no change" — keeps the loop terminating, never resets progress
		}
		if (last >= 0 && Math.abs(count - last) <= 8) stableIters++;
		else stableIters = 0;
		last = count;
	}

	// Return to the top and let scroll-reactive UI re-land before the extractor reads the DOM.
	await page.evaluate(() => window.scrollTo(0, 0)).catch(noop);
	await sleep(400);

	return { swept: true, iters };
}

// ── In-page helpers (self-contained + shadow-aware; passed to page.evaluate / waitForFunction) ──

// Force every img[loading="lazy"] to eager across the light DOM and all open shadow roots so its
// fetch fires during the sweep. Allocation-free firstChild/nextSibling walk. Returns count changed.
function forceLazyEager(): number {
	let n = 0;
	const walk = (node: Node) => {
		if (node.nodeType === 1) {
			const el = node as Element;
			try {
				if (el.tagName === 'IMG' && el.getAttribute('loading') === 'lazy') {
					(el as HTMLImageElement).loading = 'eager';
					n++;
				}
			} catch {
				/* ignore a hostile element */
			}
			if (el.shadowRoot) walk(el.shadowRoot);
		}
		for (let child = node.firstChild; child; child = child.nextSibling) walk(child);
	};
	try {
		walk(document);
	} catch {
		/* malformed DOM — best effort */
	}
	return n;
}

// Scroll the window top→bottom AND every element with its own overflow scroller, in
// stepFraction-of-height hops with a dwell each, shadow-aware. Bounded by maxMs (probes run outside
// RemainingTimer): both the scroll-height condition AND the wall-clock deadline can end each loop,
// so a page whose content keeps growing still terminates.
async function scrollAllScrollables(stepFraction: number, dwellMs: number, maxMs: number): Promise<void> {
	const deadline = Date.now() + (maxMs > 0 ? maxMs : 0);
	const frac = stepFraction >= 0.01 ? stepFraction : 0.25; // guard a pathological fraction (defense in depth)
	const dwell = (ms: number) => new Promise((r) => setTimeout(r, ms));
	const pageHeight = () =>
		Math.max(
			document.body ? document.body.scrollHeight : 0,
			document.documentElement ? document.documentElement.scrollHeight : 0
		);

	// Collect the nested overflow scrollers first (shadow-aware, allocation-free walk).
	const scrollers: Element[] = [];
	const collect = (node: Node) => {
		if (node.nodeType === 1) {
			const el = node as Element;
			try {
				if (el.clientHeight > 0 && el.scrollHeight - el.clientHeight > 4) scrollers.push(el);
			} catch {
				/* ignore */
			}
			if (el.shadowRoot) collect(el.shadowRoot);
		}
		for (let child = node.firstChild; child; child = child.nextSibling) collect(child);
	};
	try {
		collect(document);
	} catch {
		/* best effort */
	}

	// 1) Scroll the window in quarter-viewport hops with a dwell so lazy widgets trip and fetch.
	const winStep = Math.max(1, Math.round(window.innerHeight * frac));
	for (let y = 0; ; y += winStep) {
		if (Date.now() > deadline) break;
		try {
			window.scrollTo(0, y);
		} catch {
			/* ignore */
		}
		await dwell(dwellMs);
		if (y >= pageHeight()) break;
	}

	// 2) Drain each nested scroller the same way.
	for (const el of scrollers) {
		if (Date.now() > deadline) break;
		const step = Math.max(1, Math.round(el.clientHeight * frac));
		for (let top = 0; ; top += step) {
			if (Date.now() > deadline) break;
			try {
				el.scrollTop = top;
			} catch {
				break;
			}
			await dwell(dwellMs);
			if (top >= el.scrollHeight) break;
		}
	}
}

// True when every <img> across the light DOM and all open shadow roots has finished loading.
// Shadow-aware, short-circuiting firstChild/nextSibling walk. Used as a waitForFunction predicate.
function allImagesComplete(): boolean {
	const walk = (node: Node): boolean => {
		if (node.nodeType === 1) {
			const el = node as Element;
			if (el.tagName === 'IMG' && (el as HTMLImageElement).complete === false) return false;
			if (el.shadowRoot && walk(el.shadowRoot) === false) return false;
		}
		for (let child = node.firstChild; child; child = child.nextSibling) {
			if (walk(child) === false) return false;
		}
		return true;
	};
	try {
		return walk(document);
	} catch {
		return true; // never block the sweep on a hostile DOM
	}
}

// Count elements across the light DOM and all open shadow roots (matches renderer.ts countDomElements:
// allocation-free firstChild/nextSibling walk, no querySelectorAll('*') NodeLists).
function countDomElements(): number {
	let n = 0;
	const walk = (node: Node) => {
		if (node.nodeType === 1) {
			n++;
			const shadow = (node as Element).shadowRoot;
			if (shadow) walk(shadow);
		}
		for (let child = node.firstChild; child; child = child.nextSibling) walk(child);
	};
	walk(document);
	return n;
}

// Resolve when webfonts are ready; returns a serializable boolean so page.evaluate can await it.
// Bounded IN-PAGE (not only by sweep's Node-side race): a stalled webfont subresource keeps
// document.fonts.ready pending forever, and an abandoned page.evaluate leaves that promise pending on
// the CDP session — so cap the wait here too, freeing the connection immediately. (review H3)
function fontsReady(): boolean | Promise<boolean> {
	if (!document.fonts) return true;
	return Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, 1500))]).then(() => true);
}
