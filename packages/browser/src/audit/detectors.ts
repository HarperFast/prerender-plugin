// Diff-2 served-fidelity detectors (spec §3.3 + §3.4).
//
// `auditServed(page, …)` runs against the SETTLED state-C page (the served B bytes reloaded at the
// real URL, scripts stripped) and emits Findings for the ways the snapshot bytes fail to *display*:
//   1. present-but-hidden text   — claimed in B_structural, not visible in C (cloaking / lost content)
//   2. frozen / empty placeholder — a spinner/skeleton that never resolved
//   3. full-viewport overlay      — content is present but covered (a scrim/modal/banner occludes it)
//   4. broken images              — structural (src never resolved) + genuine load failures
//
// Everything is customer-agnostic: selectors/hosts/thresholds arrive as arguments. All DOM work is
// shadow-aware (recurses open shadowRoots) and lives in ONE self-contained page.evaluate whose helpers
// (normalize, selectorFor, topAt, …) are inlined — puppeteer serializes only the function body, never
// this module's scope, so nothing here may reference util.mjs or module consts. Node-side we finalize
// the image findings, because those need the requestfailed `failed` map + per-host success rate that
// only exist outside the page. We aggregate NOTHING across runs (frequency is always {k:1,n:1}); the
// caller rolls the N B-loads up into systematic-vs-intermittent.
//
// @typedef {{symptom:string, selectorPath:string, computedReason:string, sampleText:string,
//   frequency:{k:number,n:number}, fixType:(string|null), fixPatch:*, confidence:('high'|'low')}} Finding

import { noop } from './util.js';
import type { Finding } from './util.js';
import type { Page } from 'puppeteer';

// Per-<img> facts the in-page detector 4 collects; the finding decision is finalized Node-side.
interface ImgRec {
	src: string;
	abs: string;
	host: string;
	structural: boolean;
	loadFailed: boolean;
	loadedOK: boolean;
	alt: string;
	selectorPath: string;
	volatile: boolean;
}

// A frozen finding still carries its `_imgHosts` until the Node-side env-gate strips it.
type FrozenFinding = Finding & { _imgHosts?: string[] };

// The raw shape the single page.evaluate returns (detectors 1-3 finished; images finalized Node-side).
interface RawResult {
	hidden: Finding[];
	frozen: FrozenFinding[];
	overlays: Finding[];
	images: ImgRec[];
}

// The single serializable payload handed to inPageDetect (every caller value arrives on this object).
interface InPageArgs {
	bKeys: string[];
	aKeys: string[];
	spinnerSelectors: string[];
	overlaySelectors: string[];
}

interface AuditServedOpts {
	failed?: Map<string, string> | Record<string, string>;
	bStructuralText?: string[];
	aHadContentKeys?: string[];
	spinnerSelectors?: string[];
	overlaySelectors?: string[];
	hostResolvedHosts?: string[];
}

/**
 * Run the Diff-2 detectors against a settled state-C page.
 *
 * @param {import('puppeteer').Page} page  live, settled C page (served bytes reloaded at the real URL)
 * @param {object} [opts]
 * @param {Map<string,string>|Record<string,string>} [opts.failed]  request URL -> errorText (from loadServed)
 * @param {string[]} [opts.bStructuralText]  normalized text keys claimed by the served bytes (B_structural)
 * @param {string[]} [opts.aHadContentKeys]  normalized text keys that had real content in state A (ground truth)
 * @param {string[]} [opts.spinnerSelectors] extra caller-known loader/placeholder selectors
 * @param {string[]} [opts.overlaySelectors] extra caller-known overlay/backdrop selectors
 * @param {string[]} [opts.hostResolvedHosts] hosts known to be routable in this env (real load-fail signal)
 * @returns {Promise<{findings: Finding[]}>}
 */
export async function auditServed(
	page: Page,
	{
		failed = new Map(),
		bStructuralText = [],
		aHadContentKeys = [],
		spinnerSelectors = [],
		overlaySelectors = [],
		hostResolvedHosts = [],
	}: AuditServedOpts = {}
): Promise<{ findings: Finding[] }> {
	if (!page || page.isClosed?.()) return { findings: [] };

	// Everything below runs IN THE PAGE. It is fully self-contained: every helper is declared inside,
	// every caller value arrives via the single `args` object. Detectors 1-3 return finished Findings
	// (selectorPath computed in-page). Detector 4 only *collects* per-<img> facts; the finding decision
	// (structural vs load-failed vs unreachable) is finalized Node-side with the `failed` map below.
	const raw = (await page
		.evaluate(inPageDetect, {
			bKeys: Array.isArray(bStructuralText) ? bStructuralText : [],
			aKeys: Array.isArray(aHadContentKeys) ? aHadContentKeys : [],
			spinnerSelectors: Array.isArray(spinnerSelectors) ? spinnerSelectors : [],
			overlaySelectors: Array.isArray(overlaySelectors) ? overlaySelectors : [],
		})
		.catch(noop)) as RawResult | undefined;

	if (!raw) return { findings: [] };

	// Hidden + overlays merge immediately; frozen is merged AFTER the env-gate below (review M5).
	const findings: Finding[] = [...(raw.hidden || []), ...(raw.overlays || [])];

	// ---- Detector 4 finalization (Node-side: needs the requestfailed map + per-host success rate) ----
	const failedMap = failed instanceof Map ? failed : new Map(Object.entries(failed || {}));
	const resolvedSet = new Set((hostResolvedHosts || []).map((h) => String(h).toLowerCase()));
	const images = raw.images || [];

	// Per-host image success (shared by the frozen env-gate AND detector 4b). A non-structural image
	// counts as failed if it never painted (complete && naturalWidth===0) or its request is in the
	// requestfailed map.
	const byHost = new Map<string, { ok: number; fail: number; items: ImgRec[] }>(); // host -> { ok, fail, items[] }
	for (const im of images) {
		if (im.structural) continue;
		const host = String(im.host || '').toLowerCase();
		if (!host) continue;
		const rec: { ok: number; fail: number; items: ImgRec[] } = byHost.get(host) || { ok: 0, fail: 0, items: [] };
		const failedNow = im.loadFailed || (im.abs && failedMap.has(im.abs));
		if (failedNow) {
			rec.fail++;
			rec.items.push(im);
		} else if (im.loadedOK) {
			rec.ok++;
		}
		byHost.set(host, rec);
	}
	// Hosts that are 0%-success AND not caller-routable = unreachable in THIS env (dev laptop, no CDN
	// routing) — an emptiness caused by them is an artifact, not a defect.
	const unreachableHosts = new Set<string>();
	for (const [host, rec] of byHost)
		if (rec.fail > 0 && rec.ok === 0 && !resolvedSet.has(host)) unreachableHosts.add(host);

	// Frozen env-gate (review M5): a loader-classed tile that is "empty" ONLY because its image(s) live
	// on an unreachable-in-env host is an artifact — downgrade to low-confidence and drop the auto-fix so
	// the audit never suggests stripping a legit content tile that simply couldn't load its CDN image here.
	for (const f of raw.frozen || []) {
		const hosts = Array.isArray(f._imgHosts) ? f._imgHosts : [];
		const envArtifact = hosts.length > 0 && hosts.every((h) => unreachableHosts.has(h));
		delete f._imgHosts;
		if (envArtifact) {
			f.confidence = 'low';
			f.fixType = null;
			f.fixPatch = null;
			f.computedReason +=
				'; emptiness explained by image(s) on a host unreachable in this env — treated as unknown, not frozen';
		}
		findings.push(f);
	}

	// 4a. structural broken-src — env-independent, ALWAYS reported (a resolveLazyImages failure visible
	//     in the bytes alone: empty/`data:`/placeholder src).
	const seenBroken = new Set<string>();
	for (const im of images) {
		if (!im.structural) continue;
		const dedupe = im.selectorPath + '|' + im.src;
		if (seenBroken.has(dedupe)) continue;
		seenBroken.add(dedupe);
		const why = !im.src ? 'empty' : /^data:/i.test(im.src) ? 'a data: URI' : 'a placeholder/spacer image';
		findings.push({
			symptom: 'broken-src',
			selectorPath: im.selectorPath,
			computedReason: `served <img> src is ${why} — the lazy src was never resolved into the snapshot`,
			sampleText: im.alt || String(im.src || '').slice(0, 120),
			frequency: { k: 1, n: 1 },
			fixType: 'resolveLazyImages',
			fixPatch: { postProcess: { resolveLazyImages: true } },
			confidence: im.volatile ? 'low' : 'high',
		});
	}

	// 4b. load-failure — reuses the per-host success map above. A host with 0% success and not
	//     known-routable is UNREACHABLE_IN_ENV (dev laptop, no CDN routing) -> SKIP, never a finding. A
	//     host with some successes (or one the caller marked routable) yields genuine load-failed findings.
	for (const [host, rec] of byHost) {
		if (rec.fail === 0) continue;
		const routable = resolvedSet.has(host);
		if (rec.ok === 0 && !routable) continue; // unreachable-in-env → self-silence, do not cry wolf
		const rate = rec.ok + rec.fail ? rec.ok / (rec.ok + rec.fail) : 0;
		for (const im of rec.items) {
			const err = failedMap.get(im.abs);
			findings.push({
				symptom: 'load-failed',
				selectorPath: im.selectorPath,
				computedReason:
					`image failed to load from ${host} (host success ${Math.round(rate * 100)}%` + (err ? `; ${err}` : '') + ')',
				sampleText: im.alt || String(im.src || '').slice(0, 120),
				frequency: { k: 1, n: 1 },
				fixType: null, // a genuinely broken/404 image is a site bug, not a prerender-config knob
				fixPatch: null,
				confidence: routable ? 'high' : 'low',
			});
		}
	}

	return { findings };
}

// ============================================================================================
// IN-PAGE detection — SELF-CONTAINED. Serialized by puppeteer with NO access to module scope:
// every helper is declared inside, every external value arrives on `args`. Shadow-aware throughout.
// Returns { hidden[], frozen[], overlays[], images[] } (images finalized Node-side).
// ============================================================================================
function inPageDetect(args: InPageArgs): RawResult {
	const { bKeys, aKeys, spinnerSelectors, overlaySelectors } = args;

	// --- normalization: IDENTICAL to util.normText (inlined per the self-containment rule) ---
	const norm = (s: string): string =>
		String(s)
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, ' ')
			.trim();

	// --- volatile (hashed) token detection + CSS escaping for selectorFor ---
	const VOL = /^[a-z0-9]{6,}$|--|__[a-f0-9]{4,}/;
	const cssEsc = (s: string): string => {
		try {
			if (window.CSS && CSS.escape) return CSS.escape(s);
		} catch {
			/* ignore */
		}
		return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
	};
	const attrEsc = (s: string): string => String(s).replace(/(["\\])/g, '\\$1');
	const cs = (el: Element): CSSStyleDeclaration | null => {
		try {
			return getComputedStyle(el);
		} catch {
			return null;
		}
	};

	// --- shadow-aware collection of every element (light DOM + open shadow roots) ---
	const allEls = (): Element[] => {
		const out: Element[] = [];
		const walk = (root: Document | ShadowRoot): void => {
			let list: NodeListOf<Element>;
			try {
				list = root.querySelectorAll('*');
			} catch {
				return;
			}
			for (const el of list) {
				out.push(el);
				if (el.shadowRoot) walk(el.shadowRoot);
			}
		};
		walk(document);
		return out;
	};

	// --- visibility (checkVisibility with a manual fallback + zero-area guard) ---
	const isVisible = (el: Element): boolean => {
		try {
			if (el.checkVisibility)
				return el.checkVisibility({ visibilityProperty: true, opacityProperty: true, contentVisibilityAuto: true });
		} catch {
			/* fall through */
		}
		const s = cs(el);
		if (!s) return false;
		if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) < 0.1) return false;
		try {
			const r = el.getBoundingClientRect();
			return r.width > 0 && r.height > 0;
		} catch {
			return false;
		}
	};

	const bgAlpha = (s: CSSStyleDeclaration | null): number => {
		if (!s) return 0;
		const c = s.backgroundColor || '';
		if (!c || c === 'transparent') return 0;
		const m = c.match(/rgba?\(([^)]+)\)/i);
		if (!m) return 0;
		const parts = m[1].split(',').map((x) => x.trim());
		return parts.length >= 4 ? parseFloat(parts[3]) : 1;
	};

	const textOf = (el: Element): string => {
		try {
			return norm(el.textContent || '');
		} catch {
			return '';
		}
	};

	// --- selectorFor: #id(non-hashed) → [data-testid]/[data-*]/[role]/[aria-label] → tag+stable classes
	//     → tag:nth-of-type(k); emit leaf + up to 2 ancestors; flag hashed/positional as volatile. ---
	const ownSel = (node: Element): { part: string; strong: boolean; volatile: boolean } => {
		if (!node || node.nodeType !== 1) return { part: '', strong: false, volatile: false };
		const tag = node.tagName.toLowerCase();
		const attr = (n: string): string | null => {
			try {
				return node.getAttribute(n);
			} catch {
				return null;
			}
		};
		const id = attr('id');
		if (id && !VOL.test(id) && /^[A-Za-z]/.test(id)) return { part: '#' + cssEsc(id), strong: true, volatile: false };
		const tid = attr('data-testid');
		if (tid) return { part: tag + '[data-testid="' + attrEsc(tid) + '"]', strong: true, volatile: false };
		try {
			for (const a of node.attributes) {
				if (a.name.indexOf('data-') === 0 && a.value && a.value.length <= 32 && !VOL.test(a.value)) {
					return { part: tag + '[' + a.name + '="' + attrEsc(a.value) + '"]', strong: true, volatile: false };
				}
			}
		} catch {
			/* ignore */
		}
		const role = attr('role');
		if (role) return { part: tag + '[role="' + attrEsc(role) + '"]', strong: false, volatile: false };
		const al = attr('aria-label');
		if (al && al.length <= 40)
			return { part: tag + '[aria-label="' + attrEsc(al) + '"]', strong: false, volatile: false };
		const clsRaw = attr('class') || '';
		const cls = clsRaw.split(/\s+/).filter(Boolean);
		const stable = cls.filter((c) => !VOL.test(c));
		if (stable.length)
			return { part: tag + '.' + stable.slice(0, 3).map(cssEsc).join('.'), strong: false, volatile: false };
		// No stable class token, but a class exists → use it (flagged volatile) rather than a purely
		// positional nth-of-type, which is even more fragile.
		if (cls.length) return { part: tag + '.' + cls.slice(0, 2).map(cssEsc).join('.'), strong: false, volatile: true };
		let k = 1;
		let sib: Element | null = node;
		while ((sib = (sib as Element).previousElementSibling)) if (sib.tagName === node.tagName) k++;
		return { part: tag + ':nth-of-type(' + k + ')', strong: false, volatile: true }; // positional → fragile
	};

	const selectorFor = (el: Element): { sel: string; volatile: boolean } => {
		if (!el || el.nodeType !== 1) return { sel: '', volatile: true };
		const leaf = ownSel(el);
		const parts = [leaf.part];
		let volatile = leaf.volatile;
		if (!leaf.strong) {
			let node = el.parentElement;
			let depth = 0;
			let anchored = false;
			while (node && parts.length < 3 && !anchored && depth < 8) {
				const os = ownSel(node);
				if (os.part) {
					parts.unshift(os.part);
					if (os.strong) anchored = true;
				}
				node = node.parentElement;
				depth++;
			}
		}
		return { sel: parts.filter(Boolean).join(' '), volatile };
	};

	// --- first ancestor (shadow-piercing) whose computed style hides its subtree ---
	const isHider = (el: Element): boolean => {
		const s = cs(el);
		if (!s) return false;
		if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return true;
		if (parseFloat(s.opacity) < 0.1) return true;
		const clip = s.clip || '';
		if (/rect\(\s*0(px)?[, ]/.test(clip) || clip === 'rect(0px, 0px, 0px, 0px)') return true;
		const cp = s.clipPath || (s as CSSStyleDeclaration & Record<string, string>).webkitClipPath || '';
		if (/inset\(\s*(100|9\d)/.test(cp)) return true;
		try {
			const r = el.getBoundingClientRect();
			if (r.width === 0 && r.height === 0) return true;
		} catch {
			/* ignore */
		}
		return false;
	};
	const firstHiderAncestor = (start: Element): Element | null => {
		let node: Element | null = start;
		let depth = 0;
		while (node && node.nodeType === 1 && depth < 40) {
			if (isHider(node)) return node;
			const root: Node = node.getRootNode && node.getRootNode();
			node = node.parentElement || (root instanceof ShadowRoot ? root.host : null);
			depth++;
		}
		return null;
	};

	// True if the element sits inside NAVIGATION CHROME — a <nav>/<header> landmark or a menu role.
	// A collapsed mega-menu / drop-nav is *supposed* to be hidden until interaction; bots still get the
	// links in the DOM. So "hidden in the served page" there is expected behavior, not a fidelity loss —
	// excluding it kills the header-nav hidden-text cry-wolf that clip/off-screen CSS leaks past
	// checkVisibility. (Main-content loss is unaffected — it isn't under nav/menu.)
	const NAV_ROLES: Record<string, number> = { navigation: 1, menu: 1, menubar: 1, menuitem: 1 };
	// Conventional nav/menu class or id tokens (customer-agnostic — these are common framework patterns,
	// not any one site's strings). Matched as whole hyphen/underscore-delimited tokens to avoid e.g.
	// "navy" or "menuitem-description-body".
	const NAV_TOKEN = /(^|[-_ ])(nav|navigation|navbar|menu|megamenu|meganav|flyout)([-_ ]|$)/i;
	const inNavChrome = (start: Element): boolean => {
		let node: Element | null = start;
		let depth = 0;
		while (node && node.nodeType === 1 && depth < 40) {
			const tag = node.tagName;
			if (tag === 'NAV' || tag === 'HEADER') return true;
			try {
				if (NAV_ROLES[(node.getAttribute('role') || '').toLowerCase()]) return true;
				const cls = typeof node.className === 'string' ? node.className : node.getAttribute('class') || '';
				if (NAV_TOKEN.test(cls) || NAV_TOKEN.test(node.id || '')) return true;
			} catch {
				/* ignore */
			}
			const root: Node = node.getRootNode && node.getRootNode();
			node = node.parentElement || (root instanceof ShadowRoot ? root.host : null);
			depth++;
		}
		return false;
	};

	// --- shadow-piercing hit test (spec §3.3) and a shadow-aware "t is within candidate" test ---
	const topAt = (x: number, y: number): Element | null => {
		let el: Element | null;
		try {
			el = document.elementFromPoint(x, y);
		} catch {
			return null;
		}
		while (el && el.shadowRoot) {
			let inner: Element | null;
			try {
				inner = el.shadowRoot.elementFromPoint(x, y);
			} catch {
				break;
			}
			if (!inner || inner === el) break;
			el = inner;
		}
		return el;
	};
	const withinCandidate = (t: Element | null, cand: Element): boolean => {
		let node: Node | null = t;
		let guard = 0;
		while (node && guard++ < 200) {
			if (node === cand) return true;
			node = node.nodeType === 11 && (node as ShadowRoot).host ? (node as ShadowRoot).host : node.parentNode; // hop shadow root → host
		}
		return false;
	};

	// --- shared context ---
	const els = allEls();
	const vw = window.innerWidth || document.documentElement.clientWidth || 0;
	const vh = window.innerHeight || document.documentElement.clientHeight || 0;
	const pageTextLen = (norm(document.body ? document.body.textContent || '' : '').length || 0) + 1;
	const aBlob = ' ' + (Array.isArray(aKeys) ? aKeys.join(' ') : '') + ' ';
	const aHas = (needle: string): boolean => aBlob.indexOf(needle) !== -1;
	// Exact-membership set of A's visible keys (already normalized upstream). Detector 1 gates on this,
	// NOT the loose aBlob substring — "shoes" must not pass because "running shoes" exists in A, and the
	// space-join must not manufacture phantom cross-line adjacencies. (review M1)
	const aKeySet = new Set(Array.isArray(aKeys) ? aKeys : []);

	// ============================================================================
	// DETECTOR 1 — present-but-hidden text  (B_structural − C_visible)
	// ============================================================================
	const hidden: Finding[] = [];
	let visibleBlob = '';
	let domBlob = '';
	const hiddenNodes: { n: string; el: Element }[] = []; // { n: normalizedText, el: parentElement } for text that is NOT visible
	{
		const collectText = (root: Node): void => {
			let tw: TreeWalker;
			try {
				tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
			} catch {
				return;
			}
			let n: Node | null;
			while ((n = tw.nextNode())) {
				const nv = norm(n.nodeValue || '');
				if (!nv) continue;
				const parent = n.parentElement;
				// Skip non-content text nodes: script/style source, template/noscript markup, <title>.
				// Their raw source can otherwise falsely satisfy a "present in DOM" check (and in real
				// state C scripts are stripped entirely anyway).
				const pt = parent && parent.tagName;
				if (pt === 'SCRIPT' || pt === 'STYLE' || pt === 'NOSCRIPT' || pt === 'TEMPLATE' || pt === 'TITLE') continue;
				domBlob += ' ' + nv;
				if (parent && isVisible(parent)) visibleBlob += ' ' + nv;
				else if (parent && hiddenNodes.length < 4000) hiddenNodes.push({ n: nv, el: parent });
			}
		};
		collectText(document); // TreeWalker stops at shadow boundaries; sweep each shadow root separately
		for (const el of els) if (el.shadowRoot) collectText(el.shadowRoot);
	}
	let processed = 0;
	for (const bkRaw of Array.isArray(bKeys) ? bKeys : []) {
		if (processed >= 300) break; // bound the accusation set
		const bk = norm(bkRaw);
		if (bk.length < 4) continue; // skip trivially-short keys (spurious substring matches)
		if (visibleBlob.indexOf(bk) !== -1) continue; // still visible in C → no fidelity loss
		// Fidelity GATE: only content a user SAW in the full render (state A) can be a "lost when served"
		// defect. Content that was hidden in A too is intentionally-hidden UI (nav drawers, collapsed
		// menus, toggled banners) — present in the bytes but never meant to show — so it is NOT a defect.
		if (!aKeySet.has(bk)) continue;
		processed++;
		if (domBlob.indexOf(bk) !== -1) {
			// Present in the DOM but not visible → locate it and walk to the first style hider.
			let hitEl: Element | null = null;
			for (const hn of hiddenNodes) {
				if (hn.n.indexOf(bk) !== -1) {
					hitEl = hn.el;
					break;
				}
			}
			if (!hitEl) continue; // in DOM but no hidden text node matched (likely occluded/off-screen) → detector 3's job
			const hider = firstHiderAncestor(hitEl);
			if (!hider) continue; // not actually style-hidden → avoid a false positive
			if (inNavChrome(hitEl)) continue; // collapsed nav/menu chrome is expected-hidden, not lost content
			const sf = selectorFor(hider);
			const inA = aKeySet.has(bk); // A rendered this content → JS was meant to reveal it (waitFor); else it's a stray hidden node (remove)
			let sample = '';
			try {
				sample = (hitEl.textContent || '').trim().slice(0, 140);
			} catch {
				/* ignore */
			}
			hidden.push({
				symptom: 'hidden-text',
				selectorPath: sf.sel,
				computedReason:
					'text claimed in the served bytes is present in the DOM but hidden by an ancestor' +
					(inA ? '; state A rendered this content, so JS should reveal it' : ''),
				sampleText: sample || bk,
				frequency: { k: 1, n: 1 },
				fixType: inA ? 'waitFor' : 'removeSelectors',
				fixPatch: sf.sel,
				confidence: sf.volatile ? 'low' : 'high',
			});
		} else {
			// Absent from C's DOM entirely → a different, rarer bug: dropped during serialization/hydration.
			hidden.push({
				symptom: 'dropped-in-serialization',
				selectorPath: '',
				computedReason: 'text claimed in the served bytes is absent from the reloaded DOM entirely',
				sampleText: bk,
				frequency: { k: 1, n: 1 },
				fixType: null,
				fixPatch: null,
				confidence: 'low',
			});
		}
	}

	// ============================================================================
	// DETECTOR 2 — frozen / empty placeholders
	// ============================================================================
	const frozen: FrozenFinding[] = [];
	const NAME_RE = /spinner|loading|loader|skeleton|shimmer|placeholder|progress|pulse/i;
	const extra = new Set<Element>();
	for (const sel of Array.isArray(spinnerSelectors) ? spinnerSelectors : []) {
		for (const el of els) {
			try {
				if (el.matches && el.matches(sel)) extra.add(el);
			} catch {
				/* bad caller selector → skip */
			}
		}
	}
	const hasLoadedImg = (el: Element): boolean => {
		const roots: (Element | ShadowRoot)[] = [el];
		let guard = 0;
		while (roots.length && guard++ < 4000) {
			const root = roots.pop() as Element | ShadowRoot;
			if (root.nodeType === 1 && (root as Element).shadowRoot) roots.push((root as Element).shadowRoot as ShadowRoot);
			let imgs: NodeListOf<HTMLImageElement> | HTMLImageElement[];
			try {
				imgs = root.querySelectorAll('img');
			} catch {
				imgs = [];
			}
			// A loaded spinner GIF / loader-named image is NOT "content" — excluding it keeps a dead
			// loader from short-circuiting the frozen check. (review M4; inline regex — PLACEHOLDER_RE is in TDZ here)
			for (const im of imgs) {
				let s = '';
				try {
					s = im.getAttribute('src') || '';
				} catch {
					/* ignore */
				}
				if (
					im.complete &&
					im.naturalWidth > 0 &&
					!/loader|placeholder|spacer|blank|1x1|transparent|spinner|loading/i.test(s)
				)
					return true;
			}
			let all: NodeListOf<Element> | Element[];
			try {
				all = root.querySelectorAll('*');
			} catch {
				all = [];
			}
			for (const c of all) if (c.shadowRoot) roots.push(c.shadowRoot);
		}
		return false;
	};
	// Hosts of descendant <img> that FAILED to load (complete && naturalWidth===0) with a well-formed
	// http(s) src — shadow-aware. The Node side uses these to decide whether a frozen candidate's
	// emptiness is really an unreachable-CDN artifact (review M5).
	const failedImgHostsOf = (el: Element): string[] => {
		const hosts = new Set<string>();
		const roots: (Element | ShadowRoot)[] = [el];
		let guard = 0;
		while (roots.length && guard++ < 4000) {
			const root = roots.pop() as Element | ShadowRoot;
			if (root.nodeType === 1 && (root as Element).shadowRoot) roots.push((root as Element).shadowRoot as ShadowRoot);
			let imgs: NodeListOf<HTMLImageElement> | HTMLImageElement[];
			try {
				imgs = root.querySelectorAll('img');
			} catch {
				imgs = [];
			}
			for (const im of imgs) {
				if (!(im.complete && im.naturalWidth === 0)) continue;
				let abs = '';
				try {
					abs = im.getAttribute('src') ? new URL(im.getAttribute('src') as string, location.href).href : '';
				} catch {
					abs = '';
				}
				if (!/^https?:/i.test(abs)) continue;
				try {
					hosts.add(new URL(abs).host.toLowerCase());
				} catch {
					/* ignore */
				}
			}
			let all: NodeListOf<Element> | Element[];
			try {
				all = root.querySelectorAll('*');
			} catch {
				all = [];
			}
			for (const c of all) if (c.shadowRoot) roots.push(c.shadowRoot);
		}
		return [...hosts];
	};
	const attrsBlob = (el: Element): string => {
		let s = '';
		try {
			s += ' ' + (el.id || '');
		} catch {
			/* ignore */
		}
		try {
			const cn = el.className as string & { baseVal?: string };
			s += ' ' + (cn && cn.baseVal !== undefined ? cn.baseVal : el.getAttribute('class') || '');
		} catch {
			/* ignore */
		}
		try {
			for (const a of el.attributes) if (a.name.indexOf('data-') === 0) s += ' ' + a.name + ' ' + a.value;
		} catch {
			/* ignore */
		}
		try {
			s += ' ' + (el.getAttribute('aria-label') || '');
		} catch {
			/* ignore */
		}
		return s;
	};
	const seenFrozen = new Set<Element>();
	const FORM_TAGS: Record<string, number> = { INPUT: 1, TEXTAREA: 1, SELECT: 1, BUTTON: 1, OPTION: 1 };
	for (const el of els) {
		if (el.nodeType !== 1 || !isVisible(el)) continue;
		// Form controls are never "frozen loaders": an empty <input>/<select> legitimately has no text and
		// its `placeholder`/name tokens ("...placeholder...") falsely trip the loader name-match. (search box)
		if (FORM_TAGS[el.tagName]) continue;
		const nameMatch = NAME_RE.test(attrsBlob(el));
		let busy = false;
		let roleProg = false;
		let infinite = false;
		try {
			busy = el.getAttribute('aria-busy') === 'true';
		} catch {
			/* ignore */
		}
		try {
			roleProg = el.getAttribute('role') === 'progressbar' || el.tagName === 'PROGRESS';
		} catch {
			/* ignore */
		}
		const s = cs(el);
		if (s && (s.animationIterationCount || '').indexOf('infinite') !== -1) infinite = true;
		const extraMatch = extra.has(el);
		// Qualifier: a real loader signal. `infinite` (an infinite CSS animation) is NOT a qualifier on
		// its own — decorative pulse/shimmer animations are far too common — it only BOOSTS confidence
		// once one of the real signals (loader name / aria-busy / progressbar / caller selector) matched.
		if (!nameMatch && !busy && !roleProg && !extraMatch) continue;
		// Emptiness gate: a frozen placeholder shows a spinner, not content → <5% of page text, no loaded image.
		if (textOf(el).length / pageTextLen >= 0.05) continue;
		if (hasLoadedImg(el)) continue;
		let area = 0;
		try {
			const r = el.getBoundingClientRect();
			area = r.width * r.height;
		} catch {
			/* ignore */
		}
		if (area < 100) continue; // ignore sub-pixel / decorative bits
		// De-dupe nested spinners: skip if an ancestor already fired.
		let anc = el.parentElement;
		let dup = false;
		while (anc) {
			if (seenFrozen.has(anc)) {
				dup = true;
				break;
			}
			anc = anc.parentElement;
		}
		if (dup) continue;
		seenFrozen.add(el);
		// Cross-ref A: did this region have real content in A? Match the region's label/id/data tokens
		// (minus the placeholder keywords themselves) against A's content keys.
		// Content words from the region's id/class/data/aria-label. Do NOT apply the VOL(atile) filter
		// here — VOL flags any 6+ char lowercase token (e.g. "reviews", "region"), but those are exactly
		// the real words we want to match against A. Only drop the placeholder keywords themselves.
		const labelToks = norm(attrsBlob(el))
			.split(' ')
			.filter((t) => t.length >= 4 && !NAME_RE.test(t));
		let contentLost = false;
		for (const t of labelToks) {
			if (aHas(' ' + t + ' ') || aHas(' ' + t) || aHas(t + ' ')) {
				contentLost = true;
				break;
			}
		}
		const sf = selectorFor(el);
		const strongSig = busy || roleProg || extraMatch;
		const sigs: string[] = [];
		if (busy) sigs.push('aria-busy');
		if (roleProg) sigs.push('progressbar');
		if (infinite) sigs.push('infinite-animation');
		if (nameMatch) sigs.push('name-match');
		if (extraMatch) sigs.push('caller-selector');
		frozen.push({
			symptom: contentLost ? 'frozen-content-lost' : 'frozen-dead-spinner',
			selectorPath: sf.sel,
			computedReason:
				'visible loader/placeholder [' +
				sigs.join(', ') +
				'] with <5% text and no loaded image' +
				(contentLost ? '; state A had content for this region' : '; empty in both A and C'),
			sampleText: '',
			frequency: { k: 1, n: 1 },
			fixType: contentLost ? 'waitFor' : 'removeSelectors',
			fixPatch: sf.sel,
			confidence: strongSig && !sf.volatile ? 'high' : 'low',
			_imgHosts: failedImgHostsOf(el), // Node-side env-gate (review M5); stripped before return
		});
	}

	// ============================================================================
	// DETECTOR 3 — full-viewport overlays / dimmers (geometry only; produces NO text diff)
	// ============================================================================
	const overlays: Finding[] = [];
	const vpArea = vw * vh || 1;
	const overlayHint = new Set<Element>();
	for (const sel of Array.isArray(overlaySelectors) ? overlaySelectors : []) {
		for (const el of els) {
			try {
				if (el.matches && el.matches(sel)) overlayHint.add(el);
			} catch {
				/* bad caller selector → skip */
			}
		}
	}
	const gridPts: number[][] = [];
	for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) gridPts.push([(vw * (i + 0.5)) / 5, (vh * (j + 0.5)) / 5]);
	const hasInteractive = (el: Element): boolean => {
		const roots: (Element | ShadowRoot)[] = [el];
		let guard = 0;
		while (roots.length && guard++ < 3000) {
			const root = roots.pop() as Element | ShadowRoot;
			if (root.nodeType === 1 && (root as Element).shadowRoot) roots.push((root as Element).shadowRoot as ShadowRoot);
			try {
				if (root.querySelector('button, [role=button], a[href], input[type=submit]')) return true;
			} catch {
				/* ignore */
			}
			let all: NodeListOf<Element> | Element[];
			try {
				all = root.querySelectorAll('*');
			} catch {
				all = [];
			}
			for (const c of all) if (c.shadowRoot) roots.push(c.shadowRoot);
		}
		return false;
	};
	const candidates: { el: Element; hits: number; rect: DOMRect; alpha: number }[] = [];
	let tested = 0;
	for (const el of els) {
		if (el.nodeType !== 1 || !isVisible(el)) continue;
		const s = cs(el);
		if (!s) continue;
		const pos = s.position;
		if (pos !== 'fixed' && pos !== 'absolute' && pos !== 'sticky') continue;
		let rect: DOMRect;
		try {
			rect = el.getBoundingClientRect();
		} catch {
			continue;
		}
		const area = Math.max(0, rect.width) * Math.max(0, rect.height);
		if (area < 0.6 * vpArea) continue; // must cover ≥60% of the viewport
		const alpha = bgAlpha(s);
		const bf = s.backdropFilter || (s as CSSStyleDeclaration & Record<string, string>).webkitBackdropFilter || 'none';
		let isDialog = false;
		let roleDialog = false;
		let isModal = false;
		try {
			isDialog = el.tagName === 'DIALOG' && el.hasAttribute('open');
		} catch {
			/* ignore */
		}
		try {
			roleDialog = el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true';
		} catch {
			/* ignore */
		}
		try {
			isModal = el.matches('.modal');
		} catch {
			/* ignore */
		}
		const styleOK = alpha >= 0.5 || (bf && bf !== 'none') || isDialog || roleDialog || isModal || overlayHint.has(el);
		if (!styleOK) continue;
		const zi = s.zIndex;
		const ziNum = zi && zi !== 'auto' ? parseInt(zi, 10) || 0 : 0;
		if (!(ziNum >= 1 || pos === 'fixed' || pos === 'sticky')) continue; // high stacking context
		// Own text must be small (not the page's main content wrapper) — UNLESS the element has explicit
		// overlay semantics (dialog/role=dialog/.modal/caller-named), which text-heavy consent/age-gate/
		// signup interstitials legitimately have. Without this bypass a paragraph-heavy modal that buries
		// all content is silently exempted and reported by NO detector. (review H4)
		const explicitOverlay = isDialog || roleDialog || isModal || overlayHint.has(el);
		if (!explicitOverlay && textOf(el).length / pageTextLen >= 0.05) continue;
		if (tested++ >= 40) break; // bound the hit-testing
		// Confirm OCCLUSION with a shadow-piercing 5×5 hit-test grid.
		let hits = 0;
		for (const [x, y] of gridPts) {
			const t = topAt(x, y);
			if (t && withinCandidate(t, el)) hits++;
		}
		if (hits < 0.6 * gridPts.length) continue; // ≥60% of 25 points topped by the candidate
		candidates.push({ el, hits, rect, alpha });
	}
	candidates.sort((a, b) => b.hits - a.hits);
	const seenOverlay = new Set<string>();
	for (const cand of candidates.slice(0, 4)) {
		const { el, hits, rect, alpha } = cand;
		const sf = selectorFor(el);
		if (!sf.sel || seenOverlay.has(sf.sel)) continue;
		seenOverlay.add(sf.sel);
		const ownTextLen = textOf(el).length;
		const semiTransparent = alpha >= 0.5 && alpha < 0.95;
		const edgeStrip = (rect.top <= 2 || rect.bottom >= vh - 2) && rect.height < 0.9 * vh;
		let symptom: string;
		if (ownTextLen === 0 && semiTransparent)
			symptom = 'dimming-scrim'; // see-through dimmer with no content of its own
		else if (hasInteractive(el) && alpha >= 0.95)
			symptom = 'modal'; // opaque + actionable → a modal covering content
		else if (edgeStrip)
			symptom = 'banner'; // top/bottom strip → consent/interstitial banner
		else symptom = 'occluded';
		overlays.push({
			symptom,
			selectorPath: sf.sel,
			computedReason:
				symptom +
				' overlay tops ' +
				hits +
				'/' +
				gridPts.length +
				' hit-test points (' +
				Math.round(rect.width) +
				'×' +
				Math.round(rect.height) +
				'px, bg alpha ' +
				alpha.toFixed(2) +
				')',
			sampleText: '',
			frequency: { k: 1, n: 1 },
			fixType: 'removeSelectors',
			fixPatch: sf.sel,
			confidence: sf.volatile ? 'low' : 'high',
		});
	}

	// ============================================================================
	// DETECTOR 4 — image collection (finalized Node-side with the requestfailed map)
	// ============================================================================
	const PLACEHOLDER_RE = /loader|placeholder|spacer|blank|1x1|transparent/i;
	const images: ImgRec[] = [];
	for (const el of els) {
		if (el.tagName !== 'IMG') continue;
		let src = '';
		try {
			src = el.getAttribute('src') || '';
		} catch {
			/* ignore */
		}
		let abs = '';
		try {
			abs = src ? new URL(src, location.href).href : '';
		} catch {
			abs = src;
		}
		let host = '';
		try {
			host = abs ? new URL(abs).host : '';
		} catch {
			host = '';
		}
		// Compute load state FIRST: a rendered inline image (data:/SVG logo that actually painted) is NOT
		// a broken-src — only an UNrendered data URI (a real lazy placeholder) is. (review M3)
		const complete = !!(el as HTMLImageElement).complete;
		const nw = (el as HTMLImageElement).naturalWidth || 0;
		const nh = (el as HTMLImageElement).naturalHeight || 0;
		const structural = !src || PLACEHOLDER_RE.test(src) || (/^data:/i.test(src) && !(complete && nw > 1 && nh > 1));
		const wellFormed = !!abs && /^https?:/i.test(abs);
		const loadFailed = !structural && complete && nw === 0 && wellFormed;
		const loadedOK = !structural && complete && nw > 0;
		let alt = '';
		try {
			alt = el.getAttribute('alt') || '';
		} catch {
			/* ignore */
		}
		const sf = selectorFor(el);
		images.push({ src, abs, host, structural, loadFailed, loadedOK, alt, selectorPath: sf.sel, volatile: sf.volatile });
	}

	return { hidden, frozen, overlays, images };
}

export default auditServed;
