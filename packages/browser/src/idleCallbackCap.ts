/**
 * A document-start shim that caps how long `requestIdleCallback` may wait for an idle period.
 *
 * ## Why this exists
 *
 * Island frameworks hydrate their deferred components in an idle callback — Astro's `client:idle`
 * is `requestIdleCallback(hydrate)` with no timeout — and an idle callback fires only when the
 * main thread has nothing queued before its next frame deadline. On a developer machine that is a
 * few hundred milliseconds after load. On a render pod running at its CPU quota it may be never:
 * measured inside a saturated pod, the page's main thread was busy for 89-95% of a 12-15 s render
 * (tag managers, review widgets, header bidding, and the layout of a 17,000px-tall listing), and the
 * `client:idle` islands sat un-hydrated for 3.6-8 s on every product page profiled and for the
 * WHOLE render on every desktop listing page — where those islands included the recommendation
 * rails. The rails were not slow; they were never asked for.
 *
 * ## What the shim does
 *
 * Passes every idle request through to the native implementation with `timeout` capped at
 * `timeoutMs`. Idle semantics are preserved wherever idle time exists; where it does not, the
 * browser runs the callback as an ordinary task once the cap elapses, exactly as it would for a
 * caller that had asked for that timeout itself. Nothing is replaced by a timer and nothing runs
 * that would not have run — it runs SOONER, which is what a fast device would have done.
 *
 * A caller that asked for a shorter timeout keeps it; one that passed `0` (the spec's "none") gets
 * the cap. The callback's `IdleDeadline` reports `didTimeout: true`, as the spec requires when a
 * timeout fires, so a library that reschedules on an empty `timeRemaining()` still proceeds.
 *
 * Installed per render via `Page.addScriptToEvaluateOnNewDocument`, so it runs before the page's own
 * scripts and is self-contained: no imports, no closure over module scope.
 */
export const idleCallbackCapSource = (timeoutMs: number): string => `(() => {
  const cap = ${Math.max(1, Math.floor(timeoutMs))};
  const native = window.requestIdleCallback;
  if (typeof native !== 'function') return;
  const capped = function (callback, options) {
    const requested = options && typeof options.timeout === 'number' && options.timeout > 0 ? options.timeout : Infinity;
    return native.call(window, callback, { timeout: Math.min(requested, cap) });
  };
  // The wrapper is page-visible (its source is not native). Keep at least the name honest.
  try { Object.defineProperty(capped, 'name', { value: 'requestIdleCallback' }); } catch { /* frozen */ }
  window.requestIdleCallback = capped;
})();`;
