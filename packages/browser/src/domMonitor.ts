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

  // True when some OTHER node added in this same batch now contains the node. Records are delivered
  // after the task that produced them, and countTree walks the subtree as it is THEN — so when the
  // parser or a framework inserts a parent and then its children in one task, the parent's record
  // already counts the children and each child's own record would count it again. Measured before
  // this check: +21 for a parent with 10 children, and a 13,128-element document read as 41,878 —
  // an inflation that depends on where the parser yielded, so ordinary churn of ~100 elements read
  // as ~250 and tripped a tolerance of 120. Walks 'host' at a shadow boundary so a root's content
  // is attributed to its host's insertion.
  // Follow 'host' only from a ShadowRoot (nodeType 11): <a> and <area> have a native 'host' too, a
  // string, and a detached anchor at the root of an added subtree must not be walked through it.
  const up = (n) => n.parentNode || (n.nodeType === 11 ? n.host : null);
  const insideAdded = (node, added) => {
    for (let p = up(node); p; p = up(p)) if (added.has(p)) return true;
    return false;
  };

  const observer = new MutationObserver((records) => {
    const added = new Set();
    for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) added.add(n);
    let delta = 0;
    for (const r of records) {
      for (const n of r.addedNodes) if (n.nodeType === 1 && !insideAdded(n, added)) delta += countTree(n);
      // A removed node is detached by now, so its subtree is exactly what left. (A child removed
      // from an already-removed parent in the same batch is subtracted twice; that reads as a
      // change and shortens the reported quiet — the safe direction — and is rare.)
      for (const n of r.removedNodes) if (n.nodeType === 1) delta -= countTree(n);
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
  const patchedAttach = function (init) {
    const root = nativeAttach.call(this, init);
    if (init && init.mode === 'open') {
      state.roots.push(root);
      observe(root);
    }
    return root;
  };
  // The wrapper is page-visible (its source is not native), and that is accepted: it is installed
  // only when a contract will be waited on. Keep at least the name honest for anything that reads it.
  try {
    Object.defineProperty(patchedAttach, 'name', { value: 'attachShadow' });
  } catch { /* frozen function objects — cosmetic only */ }
  Element.prototype.attachShadow = patchedAttach;

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
      const history = state.history;
      for (let i = history.length - 1; i >= 0; i--) {
        if (Math.abs(history[i].n - cur) > tolerance) {
          // history[i] is the LAST moment the count was far from where it is now. The quiet did not
          // begin then — it began with the next change, the one that brought the count within
          // tolerance of its current value. Returning history[i].t here (as this once did) reported
          // the still period BEFORE the last burst as if it had accrued after it: a page quiet for
          // 2s, then hit with 500 insertions, read as 2,153ms quiet 150ms later — and a render
          // gated on "held && quiet" stopped the instant its last clause held, with no dwell at all.
          // The next entry exists whenever the latest entry carries the current count, which every
          // observed change guarantees; a recount() that moved the count without recording a change
          // leaves no such entry, and "the count just moved" is the honest answer then.
          const since = history[i + 1];
          return since ? now - since.t : 0;
        }
      }
      // An older change that exceeded the tolerance may have been dropped, and answering from what
      // is left would OVERSTATE the quiet — the one direction this must never fail in.
      if (state.truncated) return -1;
      return now - state.startedAt;
    },
  };
})();`;
