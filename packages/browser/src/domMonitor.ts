/**
 * A document-start monitor that answers one question cheaply: how long has this page been still?
 *
 * ## Why this exists
 *
 * Readiness contracts (see readiness.ts) stop a render when the page contains what it should AND
 * has stopped changing. The first half a contract can state; the second half it cannot — a
 * recommendation rail has no server-rendered placeholder, so nothing in the DOM says one is still
 * coming. Only quiescence sees it.
 *
 * The renderer's existing plateau answers that by polling an element count and comparing samples,
 * which costs a full shadow-piercing tree walk per tick and can only measure quiet that accrued
 * AFTER it started looking. This maintains the same signal from mutation records instead, so the
 * answer is O(1) to read and covers the whole life of the document — including the quiet that
 * accrued during navigation, the scroll pass and the gates.
 *
 * ## Why a mutation count is not enough, and the tolerance matters
 *
 * The plateau does not treat every mutation as a change: it allows the element count to drift by
 * `domStableTolerance` (120 in the deployed config) before restarting its timer, because a page
 * with a perpetual ticker, a rotating carousel or animation classes never truly stops mutating.
 * A monitor that bumped its timestamp on any mutation would therefore report "never quiet" on
 * exactly the pages the tolerance was introduced for. So this keeps a bounded history of element
 * counts and answers `quietMs(tolerance)` against the same rule the plateau uses.
 *
 * ## What it cannot see, and how that fails
 *
 * Content inside a CLOSED shadow root is invisible here, exactly as it is invisible to the walk
 * this replaces. A mutation it cannot observe makes the page look quieter than it is, which is the
 * dangerous direction — so `quietMs` returns -1 ("cannot say") whenever its history has been
 * truncated, and the caller must treat that as not-quiet. It is never the sole stop condition: a
 * contract's clauses must hold as well, so a missed mutation alone cannot release a render.
 *
 * Stringified and installed via `Page.addScriptToEvaluateOnNewDocument`, so it must be entirely
 * self-contained: no imports, no closure over module scope, and no TypeScript that survives to
 * runtime. Running before the page's own scripts is what lets the `attachShadow` patch see every
 * root the page opens.
 */

/** The namespace the monitor lives under, in the page. */
export const MONITOR_NS = '__prerenderMonitor';

/** What `window.__prerenderMonitor` exposes once installed. */
export type DomMonitor = {
	/**
	 * Milliseconds since the element count last drifted from its current value by more than
	 * `tolerance`, or **-1** when the history cannot answer — which callers must read as "not quiet".
	 */
	quietMs: (tolerance: number) => number;
	/** Current element count across the light DOM and every open shadow root. */
	elements: () => number;
	/** Recount from scratch — the audit path for the incremental count. */
	recount: () => number;
};

declare global {
	interface Window {
		[MONITOR_NS]: DomMonitor | undefined;
	}
}

/** The document-start script. */
export const monitorSource = (): string => `(() => {
  const NS = ${JSON.stringify(MONITOR_NS)};
  if (window[NS]) return;

  // Bounded, because this lives for the whole render on a page that may mutate continuously.
  const HISTORY_MAX = 600;
  const state = {
    roots: [],
    elements: 0,
    startedAt: Date.now(),
    history: [],
    truncated: false,
  };

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
    if (delta === 0) return;
    state.elements += delta;
    state.history.push({ t: Date.now(), n: state.elements });
    if (state.history.length > HISTORY_MAX) {
      state.history.shift();
      state.truncated = true;
    }
  });

  const observe = (root) => {
    try {
      observer.observe(root, { childList: true, subtree: true });
    } catch { /* detached root */ }
  };

  // Every open shadow root, recorded as the page opens it. A root created before this script cannot
  // exist (this runs at document start); a CLOSED root is invisible here exactly as it is invisible
  // to the tree walk this replaces.
  const nativeAttach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    const root = nativeAttach.call(this, init);
    if (init && init.mode === 'open') {
      state.roots.push(root);
      observe(root);
    }
    return root;
  };

  observe(document);
  state.elements = countTree(document);

  window[NS] = {
    elements: () => state.elements,
    recount: () => {
      state.elements = countTree(document);
      return state.elements;
    },
    // Judged the way the plateau judges it: a change counts only when the element count has drifted
    // from the CURRENT count by more than the tolerance, so ordinary churn does not mask real quiet.
    quietMs: (tolerance) => {
      const now = Date.now();
      const cur = state.elements;
      for (let i = state.history.length - 1; i >= 0; i--) {
        const entry = state.history[i];
        if (Math.abs(entry.n - cur) > tolerance) return now - entry.t;
      }
      // An older change that exceeded the tolerance may have been dropped, and answering from what
      // is left would OVERSTATE the quiet — the one direction this must never fail in.
      if (state.truncated) return -1;
      return now - state.startedAt;
    },
  };
})();`;
