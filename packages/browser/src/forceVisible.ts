/**
 * A document-start shim that reports every element a page observes with `IntersectionObserver` as
 * visible — so content that loads "when scrolled into view" loads without a scroll pass, at any
 * viewport height.
 *
 * ## Why this exists
 *
 * Lazy content is gated on visibility: a review widget that initialises when its container enters
 * the viewport, an island framework's `client:visible` hydration, a lazily-mounted rail. A renderer
 * has two blunt ways to satisfy that gate, and both cost the fleet on every render:
 *
 *  - a very tall viewport, so everything is "in view" at load. Chrome lays out and rasterises the
 *    whole viewport: measured on a live listing page, dropping a 5,000px viewport to 1,080px cut
 *    CPU-seconds per render by 43% with every page's content identical;
 *  - a scroll pass, which steps through the page on a timer and dwells at the top afterwards — a
 *    guess at how long each lazy trigger needs, paid on every render.
 *
 * Neither is the signal the page is waiting for. The signal is the IntersectionObserver callback,
 * so this delivers it: each observed element is reported intersecting, once, asynchronously, the
 * way a real viewport would report an element already on screen. Measured on a live product
 * template at a 1,080px viewport with no scroll pass: the review widget never loaded on any mobile
 * render without this, and loaded on every one with it.
 *
 * ## What it deliberately does
 *
 *  - Budgeted per document. A "load more" sentinel reported visible loads the next page, whose new
 *    sentinel would be reported visible too; the budget is what stops an infinite list from
 *    becoming an infinite render. Past it, the native observer alone decides.
 *  - A native "not intersecting" update for an element already reported visible is dropped, so a
 *    component that unloads when scrolled away does not unload what it just loaded.
 *  - Nothing is delivered for an element the page stopped observing before the report was due.
 *
 * What it cannot do: content gated on `scroll` events or on `getBoundingClientRect()` checks, and
 * native `loading="lazy"`, are not IntersectionObserver callbacks. Measure a page type before
 * relying on this alone.
 *
 * Installed per render via `Page.addScriptToEvaluateOnNewDocument`, before the page's own scripts;
 * self-contained, no imports, no closure over module scope.
 */

/** The namespace the shim's counters live under, in the page. */
export const FORCE_VISIBLE_NS = '__prerenderVisibility';

/** What `window.__prerenderVisibility` exposes once installed. */
export type ForceVisibleStats = {
	/** `observe()` calls seen. */
	observed: number;
	/** Synthetic "visible" reports delivered. */
	reported: number;
	/** Native "not intersecting" updates dropped for elements already reported visible. */
	suppressed: number;
	/** Reports the budget refused. Non-zero means a page asked for more than the budget allows. */
	refused: number;
};

declare global {
	interface Window {
		[FORCE_VISIBLE_NS]: ForceVisibleStats | undefined;
	}
}

/** The document-start script. `budget` is the most synthetic reports one document may receive. */
export const forceVisibleSource = (budget: number): string => `(() => {
  const NS = ${JSON.stringify(FORCE_VISIBLE_NS)};
  const Native = window.IntersectionObserver;
  if (typeof Native !== 'function' || window[NS]) return;
  let left = ${Math.max(0, Math.floor(budget))};
  const stats = { observed: 0, reported: 0, suppressed: 0, refused: 0 };
  window[NS] = stats;

  class IntersectionObserver extends Native {
    constructor(callback, options) {
      // Elements reported visible (synthetically or natively), and those currently observed.
      const visible = new WeakSet();
      const watching = new Set();
      super((entries, observer) => {
        const kept = [];
        for (const e of entries) {
          if (e.isIntersecting) {
            visible.add(e.target);
            kept.push(e);
          } else if (visible.has(e.target)) {
            stats.suppressed++;
          } else {
            kept.push(e);
          }
        }
        if (kept.length) callback.call(observer, kept, observer);
      }, options);
      this._forced = { callback, visible, watching };
    }
    observe(target) {
      super.observe(target);
      stats.observed++;
      const { callback, visible, watching } = this._forced;
      watching.add(target);
      if (left <= 0) {
        stats.refused++;
        return;
      }
      left--;
      setTimeout(() => {
        // The page stopped caring, or the real observer already said so.
        if (!watching.has(target) || visible.has(target) || !target.isConnected) return;
        visible.add(target);
        stats.reported++;
        const rect = target.getBoundingClientRect();
        const entry = {
          target,
          time: performance.now(),
          isIntersecting: true,
          isVisible: true,
          intersectionRatio: 1,
          boundingClientRect: rect,
          intersectionRect: rect,
          rootBounds: null,
        };
        try {
          callback.call(this, [entry], this);
        } catch (err) {
          setTimeout(() => { throw err; });
        }
      }, 0);
    }
    unobserve(target) {
      this._forced.watching.delete(target);
      super.unobserve(target);
    }
    disconnect() {
      this._forced.watching.clear();
      super.disconnect();
    }
  }
  window.IntersectionObserver = IntersectionObserver;
})();`;
