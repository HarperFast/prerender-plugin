// prerender-audit / extract.mjs — spec §2.1
//
// extractContent(page, {buckets, mode}) -> Fingerprint (see util.mjs DATA SHAPES).
//
// One self-contained page.evaluate returns RAW data (links carry absolute hrefs, images carry raw
// srcs); normalization to comparison keys happens Node-side with the shared util helpers so the two
// sides of a diff agree on exactly one normalization contract.
//
// Everything that runs in-page is inlined into the single evaluate below — puppeteer serializes only
// that function body, not this module's lexical scope, so it may reference no util helper and no
// module const. All values it needs (`mode`, the bucket selector list) are passed as evaluate ARGS.
// Every DOM walk recurses open shadowRoots (rule 2); every risky call (querySelector/matches with
// caller selectors, JSON.parse, innerText, getClientRects, checkVisibility) is try/catch-guarded.

import type { Page } from 'puppeteer';
import { normHref, normSrcKey } from './util.js';
import type { Fingerprint } from './util.js';

/**
 * Structured, shadow-aware content fingerprint of the live page.
 */
export async function extractContent(
	page: Page,
	{ buckets = {}, mode = 'visible' }: { buckets?: Record<string, string>; mode?: 'visible' | 'structural' } = {}
): Promise<Fingerprint> {
	// [name, selector] pairs — plain JSON, safe to hand to page.evaluate as an arg.
	const bucketEntries = Object.entries(buckets || {});

	const raw = await page.evaluate(
		(mode: 'visible' | 'structural' | string, bucketEntries: [string, string][]) => {
			// ---- tiny in-page helpers (fully self-contained) ----------------------------------
			const collapse = (v: unknown) =>
				String(v == null ? '' : v)
					.replace(/\s+/g, ' ')
					.trim();

			// Visibility test used for headings (always) and for text nodes in mode:'visible'.
			// An element is "not visible" when checkVisibility (guarded — only if it's a function)
			// returns false, OR it has zero client rects. Any thrown guard is treated as "no signal".
			const isElVisible = (el: Element) => {
				if (!el) return false;
				let failsVis = false;
				try {
					if (typeof el.checkVisibility === 'function') {
						// contentVisibilityAuto MUST match detectors.mjs isVisible — else A (which sees
						// content-visibility:auto content as "visible") and C (which doesn't) disagree, and
						// off-screen chrome (header mega-menu) becomes a hidden-text cry-wolf. (review H1)
						failsVis = !el.checkVisibility({
							visibilityProperty: true,
							opacityProperty: true,
							contentVisibilityAuto: true,
						});
					}
				} catch {
					failsVis = false;
				}
				if (failsVis) return false;
				let zeroRect = false;
				try {
					const rects = el.getClientRects();
					zeroRect = !rects || rects.length === 0;
				} catch {
					zeroRect = false;
				}
				return !zeroRect;
			};

			// ---- accumulators ------------------------------------------------------------------
			const headings: string[] = [];
			const links: { href: string; text: string }[] = []; // raw { href (absolute), text }
			const images: { src: string; alt: string }[] = []; // raw { src, alt }
			const jsonldScripts: string[] = []; // raw textContent strings, parsed after the walk
			const allElements: Element[] = []; // every element (light + open shadow) — for bucket matching
			let h1Count = 0;

			const visitEl = (el: Element) => {
				const tag = el.tagName;
				if (tag === 'H1') h1Count++;
				if (tag === 'H1' || tag === 'H2' || tag === 'H3') {
					if (isElVisible(el)) {
						let t = '';
						try {
							t = collapse((el as HTMLElement).innerText || '').slice(0, 200);
						} catch {
							t = '';
						}
						if (t) headings.push(t);
					}
					return;
				}
				if (tag === 'A') {
					// only <a href>; el.href is the already-absolute IDL value
					let hasHref = false;
					try {
						hasHref =
							typeof (el as HTMLAnchorElement).hasAttribute === 'function' &&
							(el as HTMLAnchorElement).hasAttribute('href');
					} catch {
						hasHref = false;
					}
					if (hasHref) {
						let text = '';
						try {
							text = String((el as HTMLAnchorElement).innerText == null ? '' : (el as HTMLAnchorElement).innerText)
								.trim()
								.slice(0, 120);
						} catch {
							text = '';
						}
						links.push({ href: (el as HTMLAnchorElement).href || '', text });
					}
					return;
				}
				if (tag === 'IMG') {
					let src = '';
					try {
						src = (el as HTMLImageElement).currentSrc || el.getAttribute('src') || '';
					} catch {
						src = '';
					}
					images.push({ src, alt: (el as HTMLImageElement).alt || '' });
					return;
				}
				if (tag === 'SCRIPT') {
					let type = '';
					try {
						type = (el.getAttribute('type') || '').trim().toLowerCase();
					} catch {
						type = '';
					}
					if (type === 'application/ld+json') jsonldScripts.push(el.textContent || '');
				}
			};

			// Shadow-aware element walk: querySelectorAll('*') covers a root's light tree; recurse
			// into every open shadowRoot. (Closed roots are invisible to prod and tool alike.)
			const walkElements = (root: Document | ShadowRoot) => {
				let list: NodeListOf<Element>;
				try {
					list = root.querySelectorAll('*');
				} catch {
					return;
				}
				for (const el of list) {
					allElements.push(el);
					visitEl(el);
					if (el.shadowRoot) walkElements(el.shadowRoot);
				}
			};
			walkElements(document);

			// ---- meta (layout-independent head signals) ---------------------------------------
			const q = (sel: string) => {
				try {
					return document.querySelector(sel);
				} catch {
					return null;
				}
			};
			const mdEl = q('meta[name="description"]');
			const canonEl = q('link[rel="canonical"]');
			const robotsEl = q('meta[name="robots"]');
			const meta = {
				title: document.title || '',
				metaDescription: mdEl ? mdEl.getAttribute('content') || '' : '',
				canonical: canonEl ? canonEl.getAttribute('href') || '' : '',
				robots: robotsEl ? robotsEl.getAttribute('content') || '' : '',
				h1Count,
			};

			// ---- JSON-LD (handle arrays and {'@graph':[...]}; @type stringified if array) ------
			const jsonld: { type: string; key: string }[] = [];
			const pushNode = (node: any) => {
				if (!node || typeof node !== 'object' || Array.isArray(node)) return;
				let type = node['@type'];
				if (Array.isArray(type)) type = type.join(',');
				else if (type == null) type = '';
				else type = String(type);
				const rawKey = node.name || node['@id'] || node.sku || '';
				jsonld.push({ type, key: rawKey ? String(rawKey) : '' });
			};
			const handleParsed = (data: any) => {
				if (Array.isArray(data)) {
					for (const n of data) handleParsed(n);
					return;
				}
				if (data && typeof data === 'object') {
					if (Array.isArray(data['@graph'])) {
						for (const n of data['@graph']) handleParsed(n);
						return;
					}
					pushNode(data);
				}
			};
			for (const txt of jsonldScripts) {
				try {
					handleParsed(JSON.parse(txt));
				} catch {
					/* skip malformed JSON-LD */
				}
			}

			// ---- text: shadow-aware walk of document.body text nodes --------------------------
			// mode:'visible'    → drop a text node whose parentElement fails visibility.
			// mode:'structural' → keep every text node regardless of visibility.
			// script/style/noscript/template are never content, so their text is excluded in both
			// modes (this is a content-type filter, not a visibility filter).
			const SKIP_TEXT_TAGS: Record<string, number> = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1 };
			const textLines: string[] = [];
			const seen = new Set<string>();
			const pushText = (node: Node) => {
				if (mode === 'visible') {
					const el = node.parentElement;
					if (!el) return; // no element to verify visibility against → skip in visible mode
					if (!isElVisible(el)) return;
				}
				const t = collapse(node.nodeValue);
				if (!t || seen.has(t)) return;
				seen.add(t);
				textLines.push(t);
			};
			const walkTextNodes = (root: Node) => {
				let kids: NodeListOf<ChildNode>;
				try {
					kids = root.childNodes;
				} catch {
					return;
				}
				for (const n of kids) {
					const nt = n.nodeType;
					if (nt === 3) {
						pushText(n); // TEXT_NODE
					} else if (nt === 1) {
						// ELEMENT_NODE
						if (SKIP_TEXT_TAGS[(n as Element).tagName]) continue;
						if ((n as Element).shadowRoot) walkTextNodes((n as Element).shadowRoot as ShadowRoot);
						walkTextNodes(n);
					}
				}
			};
			if (document.body) walkTextNodes(document.body);

			// ---- buckets: shadow-aware count per selector -------------------------------------
			const bucketCounts: Record<string, number> = {};
			for (const entry of bucketEntries || []) {
				const name = entry && entry[0];
				const selector = entry && entry[1];
				if (name == null) continue;
				let count = 0;
				let valid = true;
				try {
					document.querySelector(selector); // validate once; invalid selector throws → count 0
				} catch {
					valid = false;
				}
				if (valid && selector) {
					for (const el of allElements) {
						try {
							if (el.matches && el.matches(selector)) count++;
						} catch {
							/* ignore per-element match failure */
						}
					}
				}
				bucketCounts[name] = count;
			}

			return { meta, headings, links, images, jsonld, text: textLines, buckets: bucketCounts };
		},
		mode,
		bucketEntries
	);

	// ---- Node-side normalization (single shared contract via util) ------------------------------
	const baseUrl = page.url();

	// links → { key: normHref, text }, deduped by key keeping the first non-empty text.
	const linkByKey = new Map<string, string>();
	for (const l of raw.links) {
		const key = normHref(l.href, baseUrl);
		if (!linkByKey.has(key)) linkByKey.set(key, l.text || '');
		else if (!linkByKey.get(key) && l.text) linkByKey.set(key, l.text);
	}
	const links = [...linkByKey.entries()].map(([key, text]) => ({ key, text }));

	// images → { srcKey: normSrcKey, alt }, deduped by srcKey keeping the first non-empty alt.
	const imgByKey = new Map<string, string>();
	for (const im of raw.images) {
		const srcKey = normSrcKey(im.src);
		if (!imgByKey.has(srcKey)) imgByKey.set(srcKey, im.alt || '');
		else if (!imgByKey.get(srcKey) && im.alt) imgByKey.set(srcKey, im.alt);
	}
	const images = [...imgByKey.entries()].map(([srcKey, alt]) => ({ srcKey, alt }));

	return {
		meta: raw.meta,
		headings: raw.headings,
		links,
		images,
		jsonld: raw.jsonld,
		text: raw.text,
		buckets: raw.buckets,
	};
}
