/**
 * In-page helper installation — the mechanism behind the `installHelpers`, `nativeCount` and
 * `monitor` experiments (see experiments.ts).
 *
 * WHY THIS EXISTS. `page.evaluate(fn)` ships `fn`'s SOURCE on every call and Chrome compiles it
 * afresh each time: nothing is cached between calls, so a settle loop that polls a DOM-walking
 * function 40 times compiles that function 40 times and throws away its inline caches 40 times.
 * Installing the same functions once at document start turns each poll into a one-line call whose
 * body V8 has already seen — and, with a shadow-root registry maintained from `attachShadow`, makes
 * a native (C++) count possible where the walk previously had to be JS to reach shadow content.
 *
 * Everything here is stringified and handed to `Page.addScriptToEvaluateOnNewDocument`, so it must
 * be fully self-contained: no imports, no closures over module scope, no TypeScript that survives
 * to runtime. It runs BEFORE the page's own scripts, which is what lets the `attachShadow` patch
 * see every root the page creates.
 */

/** The namespace the installed helpers live under, in the page. */
export const HELPERS = '__prerender';

/** What `window.__prerender` carries once the bootstrap has run. */
export type PrerenderHelpers = {
	/** The monitor's incrementally-maintained view: no tree walk. */
	read: () => { elements: number; lastChangeAt: number; mutations: number };
	/** Recount from scratch — the audit path for `read()`. */
	recount: () => number;
	nativeElements: () => number;
	nativeMatching: (selector: string) => number;
	nativeExists: (selector: string) => boolean;
	countDomElements: () => number;
	countMatchingElements: (selector: string) => number;
	scrollSelectorIntoView: (selector: string) => boolean;
	scrollPass: (stepMs: number, stepFraction: number) => Promise<void>;
	extractIndexSignals: () => { canonicalHref: string | null; noindex: boolean };
	extractStructuredOffers: (cap: number) => Array<string | null> | null;
	postProcess: (opts: unknown, blockedUrlPatterns: string[]) => string;
	countThenScrollPass: (stepMs: number, stepFraction: number) => Promise<number>;
	waitForStep: (opts: {
		anchor: string;
		content: string;
		scroll: boolean;
		existsOnly: boolean;
		mode: 'walk' | 'native';
	}) => { scrolled: boolean; count: number; exists: boolean };
};

declare global {
	interface Window {
		__prerender: PrerenderHelpers;
		/** Bench scaffolding: scroll passes performed, so a variant that adds a pass is visible. */
		__passes?: number;
	}
}

/**
 * Registry + counter, installed at document start.
 *
 * The `attachShadow` patch is the load-bearing part: an open shadow root is reachable from Node
 * only by walking the whole tree looking for `.shadowRoot`, which is the very cost we are trying to
 * remove. Recording each root as it is created replaces that walk with a list.
 *
 * The MutationObserver maintains an element count incrementally. `childList` only, deliberately:
 * the baseline signal is an ELEMENT COUNT, which attribute and text mutations cannot change — and
 * those are exactly the perpetual churn (a countdown ticker, animation classes) that the count was
 * chosen over `innerHTML.length` to ignore in the first place. Observing them would reintroduce it.
 */
function monitorSource(): string {
	return `(() => {
  const NS = ${JSON.stringify(HELPERS)};
  const state = { roots: [], elements: 0, lastChangeAt: Date.now(), mutations: 0, ready: false };
  const win = window;
  if (win[NS] && win[NS].state) return;

  const countTree = (node) => {
    let n = 0;
    const walk = (x) => {
      if (x.nodeType === 1) {
        n++;
        const sr = x.shadowRoot;
        if (sr) walk(sr);
      }
      for (let c = x.firstChild; c; c = c.nextSibling) walk(c);
    };
    walk(node);
    return n;
  };

  const observer = new MutationObserver((records) => {
    let delta = 0;
    for (const r of records) {
      for (const n of r.addedNodes) if (n.nodeType === 1 || n.nodeType === 11) delta += countTree(n);
      for (const n of r.removedNodes) if (n.nodeType === 1 || n.nodeType === 11) delta -= countTree(n);
    }
    state.mutations += records.length;
    if (delta !== 0) {
      state.elements += delta;
      state.lastChangeAt = Date.now();
    }
  });

  const observe = (root) => {
    try {
      observer.observe(root, { childList: true, subtree: true });
    } catch { /* detached root */ }
  };

  // Every shadow root the page opens, recorded as it opens and observed like the document. A root
  // created before this runs is impossible (this is a document-start script); a CLOSED root is
  // invisible here exactly as it is invisible to the walk this replaces.
  const nativeAttach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const root = nativeAttach.call(this, init);
    if (init && init.mode === 'open') {
      state.roots.push(root);
      // Content inside a root created later is counted when its own mutations arrive; a root that
      // is populated synchronously with innerHTML lands as one childList record on the root.
      observe(root);
    }
    return root;
  };

  observe(document);
  state.elements = countTree(document);
  state.ready = true;

  const roots = () => {
    // Drop roots whose host has left the document: their content is no longer in the snapshot, and
    // a stale root would hold a count that nothing can change again.
    const live = [];
    for (const r of state.roots) if (r.host && r.host.isConnected) live.push(r);
    state.roots = live;
    return live;
  };

  win[NS] = win[NS] || {};
  win[NS].state = state;
  win[NS].roots = roots;
  // Recount from scratch — the audit path for the incremental count, and the fallback if a
  // mutation was ever missed.
  win[NS].recount = () => {
    state.elements = countTree(document);
    return state.elements;
  };
  win[NS].read = () => ({
    elements: state.elements,
    lastChangeAt: state.lastChangeAt,
    mutations: state.mutations,
  });
  // Native counts: C++ traversal over the light DOM plus each registered open root, instead of a
  // JS firstChild/nextSibling walk testing every element.
  win[NS].nativeElements = () => {
    let n = document.getElementsByTagName('*').length;
    for (const r of roots()) n += r.querySelectorAll('*').length;
    return n;
  };
  win[NS].nativeMatching = (selector) => {
    try {
      let n = document.querySelectorAll(selector).length;
      for (const r of roots()) n += r.querySelectorAll(selector).length;
      return n;
    } catch {
      return 0;
    }
  };
  win[NS].nativeExists = (selector) => {
    try {
      if (document.querySelector(selector)) return true;
      for (const r of roots()) if (r.querySelector(selector)) return true;
      return false;
    } catch {
      return false;
    }
  };
})();`;
}

/**
 * Build the document-start script: the monitor, plus each renderer helper installed by name so a
 * poll can call it instead of re-shipping its source.
 *
 * `fns` are the renderer's own in-page functions, passed in rather than duplicated — the bootstrap
 * and the per-call path therefore run byte-identical code, which is the only way an A/B between
 * them measures the delivery mechanism and nothing else.
 */
export function buildBootstrap(fns: Record<string, (...args: never[]) => unknown>): string {
	const entries = Object.entries(fns)
		.map(([name, fn]) => `  ${name}: ${fn.toString()},`)
		.join('\n');
	return `${monitorSource()}
(() => {
  const NS = ${JSON.stringify(HELPERS)};
  window[NS] = Object.assign(window[NS] || {}, {
${entries}
  });
})();`;
}
