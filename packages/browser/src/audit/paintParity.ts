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
	const add = (kind: string, name: string, el: Element) => {
		if (!name) return;
		const r = el.getBoundingClientRect();
		items.push({
			key: `${kind}:${name}`,
			width: +r.width.toFixed(1),
			height: +r.height.toFixed(1),
			area: +(r.width * r.height).toFixed(1),
		});
	};

	for (const el of elements) {
		const style = getComputedStyle(el);
		// Something the author has explicitly hidden is not "lost ink" — it is not ink at all.
		if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
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
 * Compare two inventories. Pure — no browser, so it is cheap to test directly.
 *
 * @param minArea ignore marks smaller than this at origin (sub-pixel spacers and 1px rules are
 *   noise, and a hairline that rounds to zero on one side is not a finding).
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
	lost.sort((a, b) => parseFloat(b.origin) * 1 - parseFloat(a.origin) * 1);
	return { shared, originOnly: o.size - shared, servedOnly: s.size - shared, lost, gained, lostByKind };
}

export default diffPaint;

// ── orchestration ─────────────────────────────────────────────────────────────────────────────

import { renderOnce } from '../renderOnce.js';
import { buildFullConfig, sweep } from './fullRender.js';
import { loadServed } from './serveState.js';
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
}

export interface PaintParityReport extends PaintParityResult {
	url: string;
	device: string;
	/** Bytes of the audited snapshot. */
	servedBytes: number;
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
	const { url, device, base, bypass, minArea = 4, renderBudgetMs = 120000, sweepDeadlineMs = 20000 } = o;

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
				return collectPaint(page);
			},
		},
	});

	try {
		const originPaint = (reference.probes.paint as PaintItem[]) ?? [];
		if (!reference.browser) throw new Error('paintParity: the reference render did not hand back a browser');

		// 3. The snapshot, loaded AT THE REAL URL so relative refs and same-origin subrequests
		// resolve the way they do for a crawler fetching the cached bytes.
		const { page } = await loadServed(reference.browser, {
			url,
			html,
			bypass,
			blockUrlPatterns: (base.block?.urlPatterns as string[] | undefined) ?? [],
		});
		let servedPaint: PaintItem[];
		try {
			servedPaint = await collectPaint(page);
		} finally {
			await page.close().catch(() => {});
		}

		return {
			url,
			device: reference.device,
			servedBytes: html.length,
			...diffPaint(originPaint, servedPaint, { minArea }),
		};
	} finally {
		await reference.close();
		await candidate.close();
	}
}
