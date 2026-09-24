/**
 * A document-start log of every resource the page has finished loading — what the `responded`
 * readiness clause reads.
 *
 * ## Why a clause needs to see the network at all
 *
 * Some content has a server-rendered PLACEHOLDER but is filled by one API call the page makes for
 * itself. Measured on a live commerce template: the recommendation rails are empty slots in the
 * document, filled from a single first-party call. Everything the contract can see in the DOM is
 * "a slot, not yet filled" — the same shape as "a slot this page will leave empty". The call is
 * the thing that decides, so the contract can name it: hold until that response has arrived, then
 * let the quiet window see what it rendered. The render then ends when the content does, however
 * late that is, instead of when a timer guesses it might have.
 *
 * ## Why an observer and not the resource-timing buffer
 *
 * The page owns `performance`'s resource buffer, and a commerce page fills it. Measured: a listing
 * page fired `resourcetimingbufferfull` 138-250 times per render, and the rail call it waited on
 * was NOT in `getEntriesByType('resource')` at the end — while a PerformanceObserver registered at
 * document start saw it on every render. Observers are delivered every entry whatever the buffer
 * holds, so this one is the source of truth.
 *
 * An entry is delivered at `responseEnd`: the body has fully arrived. A request still in flight is
 * absent, which is the point.
 *
 * Unlike the DOM monitor this patches nothing page-visible, so it is installed in report mode too:
 * a `responded` clause must read the same in both modes or report mode would measure a different
 * contract from the one that gates.
 *
 * Stringified and installed via `Page.addScriptToEvaluateOnNewDocument`: self-contained, no imports.
 */

/** The namespace the log lives under, in the page. */
export const RESPONSE_LOG_NS = '__prerenderResponses';

/** What `window.__prerenderResponses` exposes once installed. */
export type ResponseLog = {
	/**
	 * How many finished resources matched `pattern` — one of the patterns the log was installed
	 * with. -1 for a pattern it was not given (or could not compile), which callers read as "not yet".
	 */
	count: (pattern: string) => number;
};

declare global {
	interface Window {
		[RESPONSE_LOG_NS]: ResponseLog | undefined;
	}
}

/**
 * The document-start script, counting finished resources per pattern. Given the governing
 * contract's `responded` patterns up front, so it keeps one counter per pattern rather than every
 * URL: bounded however many resources the page loads, and nothing can be dropped — a capped list
 * of names would silently lose a late call on exactly the heavy pages that make one.
 */
export const responseLogSource = (patterns: string[]): string => `(() => {
  const NS = ${JSON.stringify(RESPONSE_LOG_NS)};
  if (window[NS]) return;
  const counters = [];
  for (const source of ${JSON.stringify(patterns)}) {
    try {
      counters.push({ source, re: new RegExp(source), n: 0 });
    } catch { /* validateReadiness rejects a malformed pattern at load; count() reads -1 for it */ }
  }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) for (const c of counters) if (c.re.test(e.name)) c.n++;
    }).observe({ type: 'resource', buffered: true });
  } catch { /* no PerformanceObserver: every count reads 0 ("not yet") and the contract timeout bounds it */ }
  window[NS] = {
    count: (pattern) => {
      for (const c of counters) if (c.source === pattern) return c.n;
      return -1;
    },
  };
})();`;
