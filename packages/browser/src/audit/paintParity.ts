// Paint parity — does the served snapshot still put the same ink on screen as the origin page?
//
// Every other comparison in this module keys on the DOM: elements, attributes, text, computed
// styles. A whole class of fidelity bug is invisible to all of them, because the markup stays
// perfect and only the *rendering* is lost. The case that motivated this: flattening shadow DOM
// with a blanket `all: revert` silently zeroed every `<path>` (in Chrome `d` is a CSS property fed
// from the author origin, so reverting discards it). 140 of 140 review paths painted nothing —
// carousel arrows became empty outlined boxes — while the DOM diff, the full computed-style
// comparison and the whole test suite stayed green.
//
// So this keys on PAINT IDENTITY instead: the thing that makes a mark, named by something stable
// enough to match across two independently rendered pages.
//
//   geo: an SVG shape          -> its own `d` / `points` / geometry attributes
//   img: an image              -> src basename
//   bg:  a background image    -> the url()
//   txt: a run of text         -> the string itself
//
// For every key present on BOTH sides, compare rendered area. A key that paints at origin and has
// zero area in the snapshot is LOST INK. Keys only one side has are counted, never failed — that is
// ordinary content drift on a live site, and conflating the two is what makes naive pixel diffing
// useless here.

import type { Page } from 'puppeteer';

/** One mark on screen, named by something stable across renders. */
export interface PaintItem {
	key: string;
	width: number;
	height: number;
	area: number;
}

export interface PaintLoss {
	key: string;
	/** `geo` | `img` | `bg` | `txt` */
	kind: string;
	origin: string;
	served: string;
}

export interface PaintParityResult {
	/** Keys present on both sides — the only ones that can produce a verdict. */
	shared: number;
	/** Present at origin only, or in the snapshot only: content drift, reported not failed. */
	originOnly: number;
	servedOnly: number;
	/** Paints at origin, zero area in the snapshot. This is the defect class. */
	lost: PaintLoss[];
	/** Zero at origin, paints in the snapshot. Usually lazy content the origin capture missed. */
	gained: PaintLoss[];
	lostByKind: Record<string, number>;
}

/**
 * Collect the paint inventory of a page. Runs inside the page.
 *
 * Walks INTO open shadow roots deliberately: at origin a widget is often still encapsulated while
 * the snapshot has it flattened into the light DOM, and a non-piercing walk reports a false zero
 * for exactly the content most worth comparing.
 */
export const PAINT_INVENTORY = (): PaintItem[] => {
	const elements: Element[] = [];
	const walk = (root: Document | ShadowRoot) => {
		for (const el of root.querySelectorAll('*')) {
			elements.push(el);
			if (el.shadowRoot) walk(el.shadowRoot);
		}
	};
	walk(document);

	const items: PaintItem[] = [];
	const clip = (s: string | null, n = 56) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

	// Set once per element, read by `add`. An element that does not effectively paint is recorded
	// with ZERO area rather than skipped — that distinction is the whole fix. Dropping it would move
	// the key into `originOnly`, which `diffPaint` deliberately reports and never fails (it cannot
	// tell real content drift from a defect), so the bug would still pass. Keeping the key on both
	// sides at area 0 is what lets the existing "painted at origin, zero here" rule fire.
	let elPaints = true;
	const add = (kind: string, name: string, el: Element) => {
		if (!name) return;
		const r = el.getBoundingClientRect();
		const width = elPaints ? r.width : 0;
		const height = elPaints ? r.height : 0;
		items.push({
			key: `${kind}:${name}`,
			width: +width.toFixed(1),
			height: +height.toFixed(1),
			area: +(width * height).toFixed(1),
		});
	};

	/** The next node up, crossing a shadow boundary at the host rather than stopping there. */
	const parentOf = (el: Element): Element | null => {
		if (el.parentElement) return el.parentElement;
		const root = el.getRootNode();
		return root instanceof ShadowRoot ? root.host : null;
	};

	// EFFECTIVE visibility, not own-style visibility. `opacity` is NOT an inherited property, so a
	// child of an `opacity: 0` ancestor computes `opacity: 1` and its box keeps its full size — an
	// own-style check scores a completely invisible subtree as painting, identically to a healthy
	// one. That is not hypothetical: a reveal-on-hydrate wrapper left in its pre-reveal state
	// (`max-height: 0; opacity: 0`) hid an entire reviews section, 2,336 elements and 467 text runs,
	// while every number this module produced stayed byte-identical to the healthy render.
	//
	// `checkVisibility` is the platform's own answer and covers display / visibility /
	// content-visibility / inherited opacity in one call; the fallback walks for the cases that
	// genuinely need an ancestor (display and opacity — `visibility` is inheritable but overridable,
	// so the element's OWN computed value is already the right answer for it).
	const cssVisible = (el: Element, style: CSSStyleDeclaration): boolean => {
		const check = (el as Element & { checkVisibility?: (o: object) => boolean }).checkVisibility;
		if (typeof check === 'function') return check.call(el, { checkOpacity: true, checkVisibilityCSS: true });
		if (style.display === 'none' || style.visibility === 'hidden') return false;
		for (let n: Element | null = el; n; n = parentOf(n)) {
			const s = n === el ? style : getComputedStyle(n);
			if (s.display === 'none' || Number(s.opacity) === 0) return false;
		}
		return true;
	};

	// The other way a live-looking subtree paints nothing: an ancestor COLLAPSED to zero in an axis
	// it clips (the `max-height: 0; overflow: hidden` accordion). `checkVisibility` does not model
	// clipping, and the descendants keep non-zero boxes of their own.
	//
	// Deliberately narrow — only a clipper whose own box is ZERO in the clipped axis counts. An
	// element merely scrolled outside a normal-sized `overflow: hidden` container (every carousel on
	// every page) is NOT treated as invisible: that is ordinary off-screen content, it reads the same
	// at origin, and failing it would bury real findings under carousel noise.
	const clipMemo = new Map<Element, boolean>();
	const isZeroClipper = (el: Element): boolean => {
		const s = getComputedStyle(el);
		const clipsX = s.overflowX !== 'visible';
		const clipsY = s.overflowY !== 'visible';
		if (!clipsX && !clipsY) return false;
		const r = el.getBoundingClientRect();
		return (clipsX && r.width === 0) || (clipsY && r.height === 0);
	};
	/** Does anything at or above `el` clip its content away entirely? Memoized; elements arrive in
	 *  document order, so each ancestor is answered once and reused by its whole subtree. */
	const clipsContent = (el: Element | null): boolean => {
		if (!el) return false;
		const hit = clipMemo.get(el);
		if (hit !== undefined) return hit;
		const chain: Element[] = [];
		let n: Element | null = el;
		while (n && !clipMemo.has(n)) {
			chain.push(n);
			n = parentOf(n);
		}
		let acc = n ? (clipMemo.get(n) as boolean) : false;
		for (let i = chain.length - 1; i >= 0; i--) {
			acc = acc || isZeroClipper(chain[i]);
			clipMemo.set(chain[i], acc);
		}
		return acc;
	};

	for (const el of elements) {
		const style = getComputedStyle(el);
		// Something the author has explicitly hidden is not "lost ink" — it is not ink at all. That
		// still holds, and falls out of the area being 0 on BOTH sides: hidden at origin means
		// `origin.area > minArea` is false, so it can never produce a finding. What no longer falls
		// through is the asymmetric case — painting at origin, invisible here — which is the defect.
		elPaints = cssVisible(el, style) && !clipsContent(parentOf(el));
		const tag = el.tagName.toLowerCase();

		if (tag === 'path') add('geo', clip(el.getAttribute('d')), el);
		else if (tag === 'polygon' || tag === 'polyline') add('geo', clip(el.getAttribute('points')), el);
		else if (tag === 'circle' || tag === 'ellipse')
			add(
				'geo',
				`${tag}|${clip(el.getAttribute('r') || el.getAttribute('rx'), 12)}|${clip(el.getAttribute('cx'), 12)}`,
				el
			);
		else if (tag === 'rect')
			add('geo', `rect|${clip(el.getAttribute('width'), 12)}|${clip(el.getAttribute('height'), 12)}`, el);
		else if (tag === 'line')
			add('geo', `line|${clip(el.getAttribute('x1'), 10)}|${clip(el.getAttribute('y1'), 10)}`, el);
		else if (tag === 'img' && el.getAttribute('src')) {
			let name = el.getAttribute('src') as string;
			try {
				name = new URL(name, location.href).pathname.split('/').pop() || name;
			} catch {
				/* keep the raw attribute — it is only a key */
			}
			add('img', clip(name), el);
		} else if (style.backgroundImage && style.backgroundImage !== 'none') {
			add('bg', clip(style.backgroundImage.replace(/^url\(["']?/, '').replace(/["']?\)$/, '')), el);
		}

		// Own text only, so a string is attributed to the node that holds it rather than to every
		// ancestor as well.
		let own = '';
		for (const node of el.childNodes) if (node.nodeType === 3) own += node.nodeValue ?? '';
		add('txt', clip(own), el);
	}
	return items;
};

/** Collect the inventory from an already-loaded page. */
export async function collectPaint(page: Page): Promise<PaintItem[]> {
	return page.evaluate(PAINT_INVENTORY) as Promise<PaintItem[]>;
}

/**
 * Collect over a short observation WINDOW rather than at an instant.
 *
 * A single sample is not a safe basis for "this never painted": carousels rotate, sliders
 * transition, lazy images arrive. But the two sides need OPPOSITE reductions, and getting that
 * backwards is worse than not sampling at all — reducing both by `max` inflates the reference as
 * more images load and manufactured 258 false losses on a real homepage.
 *
 * - reference (`min`): a mark counts as painting only if it painted in EVERY sample. A slide that
 *   rotated away, or an image that had not yet loaded, is not held against the snapshot.
 * - snapshot (`max`): a mark counts as painting if it painted in ANY sample. Catching it
 *   mid-transition is not evidence that it is missing.
 *
 * A key absent from a sample entirely is treated as zero area for `min`, which is the same
 * conservative direction.
 */
export async function collectPaintStable(
	page: Page,
	{ samples = 2, gapMs = 1200, reduce = 'max' }: { samples?: number; gapMs?: number; reduce?: 'min' | 'max' } = {}
): Promise<PaintItem[]> {
	const rounds: Map<string, PaintItem>[] = [];
	for (let i = 0; i < Math.max(1, samples); i++) {
		if (i > 0) await new Promise((resolve) => setTimeout(resolve, gapMs));
		const round = new Map<string, PaintItem>();
		for (const item of await collectPaint(page)) {
			const prev = round.get(item.key);
			if (!prev || item.area > prev.area) round.set(item.key, item);
		}
		rounds.push(round);
	}
	if (rounds.length === 1) return [...rounds[0].values()];

	const keys = new Set<string>();
	for (const round of rounds) for (const key of round.keys()) keys.add(key);
	const zero = (key: string): PaintItem => ({ key, width: 0, height: 0, area: 0 });
	const out: PaintItem[] = [];
	for (const key of keys) {
		let chosen: PaintItem | undefined;
		for (const round of rounds) {
			const item = round.get(key) ?? zero(key);
			if (!chosen) chosen = item;
			else if (reduce === 'min' ? item.area < chosen.area : item.area > chosen.area) chosen = item;
		}
		if (chosen) out.push(chosen);
	}
	return out;
}

/**
 * Compare two inventories. Pure — no browser, so it is cheap to test directly.
 *
 * @param minArea ignore marks smaller than this at origin (sub-pixel spacers and hairline rules are
 *   noise, and a rule that rounds to zero on one side is not a finding).
 */
export function diffPaint(
	origin: PaintItem[],
	served: PaintItem[],
	{ minArea = 4 }: { minArea?: number } = {}
): PaintParityResult {
	// Best (largest) showing per key: a key repeated many times is judged on whether it painted at
	// all, not on every instance.
	const best = (items: PaintItem[]) => {
		const map = new Map<string, PaintItem>();
		for (const item of items) {
			const prev = map.get(item.key);
			if (!prev || item.area > prev.area) map.set(item.key, item);
		}
		return map;
	};
	const o = best(origin);
	const s = best(served);

	const lost: PaintLoss[] = [];
	const gained: PaintLoss[] = [];
	const lostByKind: Record<string, number> = {};
	let shared = 0;
	const box = (i: PaintItem) => `${i.width}x${i.height}`;

	for (const [key, oi] of o) {
		const si = s.get(key);
		if (!si) continue;
		shared++;
		if (oi.area > minArea && si.area <= 0.5) {
			const kind = key.slice(0, key.indexOf(':'));
			lost.push({ key, kind, origin: box(oi), served: box(si) });
			lostByKind[kind] = (lostByKind[kind] ?? 0) + 1;
		} else if (oi.area <= 0.5 && si.area > minArea) {
			gained.push({ key, kind: key.slice(0, key.indexOf(':')), origin: box(oi), served: box(si) });
		}
	}
	// Biggest losses first — they are the ones a human should look at.
	lost.sort(
		(a, b) => b.origin.split('x').reduce((x, y) => x * +y, 1) - a.origin.split('x').reduce((x, y) => x * +y, 1)
	);
	return { shared, originOnly: o.size - shared, servedOnly: s.size - shared, lost, gained, lostByKind };
}

// ── orchestration ─────────────────────────────────────────────────────────────────────────────

import { renderOnce } from '../renderOnce.js';
import { buildFullConfig, sweep } from './fullRender.js';
import { loadServed, type ResourceFailure } from './serveState.js';
import type { DeepPartial, PrerenderConfig } from '../config.js';

export interface PaintParityOptions {
	url: string;
	device?: string;
	/** The deployed config — the CANDIDATE renders with exactly this. */
	base: DeepPartial<PrerenderConfig>;
	/** Bot-mitigation bypass header/token, used for the reference and for the snapshot's subrequests. */
	bypass?: { header: string; token: string };
	/** Skip rendering a candidate and audit these bytes instead (e.g. what the cache already holds). */
	html?: string;
	/** Ignore marks smaller than this at origin. Default 4 (px²). */
	minArea?: number;
	/** Per-render budget for both sides. Default 120000. */
	renderBudgetMs?: number;
	/** Wall-clock budget for the reference's hydration sweep. Default 20000. */
	sweepDeadlineMs?: number;
	/** Inventory samples per side. >1 tolerates carousels and transitions. Default 2. */
	samples?: number;
	/** Gap between samples, ms. Default 1200. */
	sampleGapMs?: number;
}

export interface PaintParityReport extends PaintParityResult {
	url: string;
	device: string;
	/** Bytes of the audited snapshot. */
	servedBytes: number;
	/**
	 * Same-origin stylesheets that did NOT load while the snapshot was being measured.
	 *
	 * This is a verdict about the MEASUREMENT, not about the page: with the site's own CSS missing,
	 * every class that hides something stops hiding it, so a genuinely invisible section measures as
	 * fully painting and the audit reports a clean pass. Measured on a real snapshot — the same
	 * bytes, the only difference being whether the origin-bypass token was sent on subrequests:
	 *
	 *   token sent     9 stylesheets ok  ->  wrapper opacity 0, max-height 0px  ->  invisible
	 *   token withheld 6 ok / 3x HTTP 403 ->  wrapper opacity 1, max-height none -> "visible"
	 *
	 * A non-empty array means `lost` is not trustworthy and the run should be treated as invalid,
	 * not as a pass. `paintParityVerdict()` reports that case as `invalid`.
	 */
	stylesheetFailures: ResourceFailure[];
}

/** `invalid` — the run measured nothing meaningful and must not be read as a pass or a failure.
 *  `lost-ink` — trustworthy, and the snapshot dropped marks the origin page paints.
 *  `clean` — trustworthy, and nothing was lost. */
export type PaintParityVerdict = 'invalid' | 'lost-ink' | 'clean';

/**
 * Three-valued on purpose. A boolean would have to fold "the measurement broke" into one of the two
 * real answers, and folding it into `pass` is precisely the failure this module just had.
 *
 * Note for anyone gating a corpus on this: `lost` carries a small drift baseline on a live site —
 * measured on one real product page, a healthy snapshot lost 2 text marks (a store link and a
 * number) against 127 for the same page with its reviews section invisible. So threshold the count
 * or triage the findings; do not demand `lost.length === 0` across a corpus and expect signal.
 */
export function paintParityVerdict(report: PaintParityReport): PaintParityVerdict {
	if (report.stylesheetFailures.length > 0) return 'invalid';
	return report.lost.length > 0 ? 'lost-ink' : 'clean';
}

/**
 * Audit one (url, device): does the snapshot we serve put the same ink on screen as the origin page?
 *
 * The reference is the NON-prerendered page — JS running, hydrated, post-processing off. That
 * distinction is the whole point: `renderAudit`'s ground-truth state deliberately inherits the
 * deployed post-processing, so a post-processing loss is applied to both its sides and is
 * structurally invisible to it. Here the reference must not be post-processed at all, or the very
 * defect being hunted cancels out.
 */
export async function paintParity(o: PaintParityOptions): Promise<PaintParityReport> {
	const {
		url,
		device,
		base,
		bypass,
		minArea = 4,
		renderBudgetMs = 120000,
		sweepDeadlineMs = 20000,
		samples = 2,
		sampleGapMs = 1200,
	} = o;

	// 1. The candidate: exactly what the fleet would cache and serve.
	const candidate =
		o.html !== undefined
			? { html: o.html, close: async () => {} }
			: await renderOnce({ url, device, bypass, renderBudgetMs, config: base as DeepPartial<PrerenderConfig> });
	const html = candidate.html;
	if (!html) {
		await candidate.close();
		throw new Error(`paintParity: the candidate render produced no HTML for ${url}`);
	}

	// 2. The reference: the live page, hydrated, with post-processing OFF. `keepOpen` so the same
	// browser (same launch args, same host-resolver rules) also loads the snapshot below.
	const referenceConfig = buildFullConfig({
		...base,
		postProcess: {
			stripScripts: false,
			flattenShadowDom: false,
			inlineEmptyStyleSheets: false,
			minifyInlineCss: false,
			pruneUnmatchedCss: false,
			stripBlockedResources: false,
			removeSelectors: [],
			removeAttributes: [],
		},
	} as DeepPartial<PrerenderConfig>);
	const reference = await renderOnce({
		url,
		device,
		bypass,
		renderBudgetMs,
		config: referenceConfig,
		keepOpen: true,
		probes: {
			paint: async ({ page }) => {
				await sweep(page, { deadlineMs: sweepDeadlineMs });
				// `min`: only marks that painted in EVERY sample are held against the snapshot.
				return collectPaintStable(page, { samples, gapMs: sampleGapMs, reduce: 'min' });
			},
		},
	});

	try {
		const originPaint = (reference.probes.paint as PaintItem[]) ?? [];
		if (!reference.browser) throw new Error('paintParity: the reference render did not hand back a browser');

		// 3. The snapshot, loaded AT THE REAL URL so relative refs and same-origin subrequests
		// resolve the way they do for a crawler fetching the cached bytes.
		const { page, resourceFailures } = await loadServed(reference.browser, {
			url,
			html,
			bypass,
			blockUrlPatterns: (base.block?.urlPatterns as string[] | undefined) ?? [],
		});
		let servedPaint: PaintItem[];
		try {
			// `max`: if the snapshot painted it at any point in the window, it is not lost.
			servedPaint = await collectPaintStable(page, { samples, gapMs: sampleGapMs, reduce: 'max' });
		} finally {
			await page.close().catch(() => {});
		}

		// Only SAME-ORIGIN stylesheets invalidate the measurement. A third-party stylesheet that
		// 403s is ordinary web weather and usually blocked on purpose; the site's own CSS is what
		// carries the classes that do the hiding.
		const pageOrigin = new URL(url).origin;
		const stylesheetFailures = resourceFailures.filter((f) => {
			if (f.type !== 'stylesheet') return false;
			try {
				return new URL(f.url).origin === pageOrigin;
			} catch {
				return false;
			}
		});

		return {
			url,
			device: reference.device,
			servedBytes: html.length,
			stylesheetFailures,
			...diffPaint(originPaint, servedPaint, { minArea }),
		};
	} finally {
		await reference.close();
		await candidate.close();
	}
}
