# `@harperfast/prerender-browser`

The headless-browser render library for [Harper Prerender](../plugin). It subscribes to the
[`@harperfast/prerender`](../plugin) plugin's queue-state topic over MQTT, claims due render jobs over
HTTP, renders each page in headless Chrome (Puppeteer), and posts the resulting HTML back to the
plugin's `/render_queue/job_result` endpoint.

It is a **library**, configured entirely through the options passed to `startWorker()` — it reads no
environment variables and ships no CLI or Dockerfile. A render service embeds it and supplies the
configuration (sourcing it from env, a file, or anywhere). The per-customer render deployment is where
it gets instantiated, customized, and containerized.

## Install

```sh
npm install @harperfast/prerender-browser
npx puppeteer browsers install chrome-headless-shell --install-deps   # a headless Chrome to render in
```

## Usage

```ts
import { startWorker, defaultRenderer } from '@harperfast/prerender-browser';

await startWorker({
	// connection + identity (required)
	harper: { mqttOrigin: 'mqtt://harper:1883', user: 'HDB_ADMIN', pass: '…', workerId: 'renderer-1' },

	// shared secret the origin fetches carry — must match the plugin's securityToken
	bypass: { header: 'x-harper-renderer-bypass', token: process.env.RENDERER_BYPASS_TOKEN },

	// rendering config — a deep-partial object merged over the defaults (or a path to a JSON file)
	config: {
		navigation: { waitUntil: 'networkidle2' },
		block: { urlPatterns: ['google-analytics.com'] },
	},

	// optional custom renderer (see below)
	renderer: async (page, job) => {
		// site-specific page setup the declarative config can't express…
		return defaultRenderer(page, job); // …then delegate to the configurable default
	},
});
```

`startWorker(options)` resolves the options over the built-in defaults, initializes the resource
cache, and starts the worker loop; it resolves once the cache index is built. It throws if a required
`harper` field is missing.

## Options (`BrowserOptions`)

Only `harper` is required; everything else has a default.

| Option                       | Default                                           | Purpose                                                                                     |
| ---------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `harper`                     | _(required)_                                      | `{ mqttOrigin, user, pass, workerId }` — connection + identity                              |
| `queuePort`                  | `9926`                                            | Port of the plugin's render-queue HTTP API                                                  |
| `bypass`                     | `{ header: x-harper-renderer-bypass, token: '' }` | Shared origin-bypass header/token (match the plugin)                                        |
| `config`                     | built-in defaults                                 | Rendering config (deep-partial object _or_ JSON file path)                                  |
| `concurrency`                | ~half the CPUs                                    | Max concurrent page renders                                                                 |
| `rps`                        | `8`                                               | Max render starts per second                                                                |
| `jobClaimLimit`              | `concurrency * 2`                                 | Jobs claimed per batch                                                                      |
| `browserExpirationThreshold` | `200`                                             | Pages a browser renders before being retired                                                |
| `incognitoPages`             | `true`                                            | Render each page in a fresh incognito context                                               |
| `contentEncoding`            | `gzip`                                            | Encoding used when posting rendered HTML back                                               |
| `chromeArgs`                 | hardened headless set                             | Chrome launch flags                                                                         |
| `browserLaunchOptions`       | built from `chromeArgs`                           | Full Puppeteer launch options (overrides `chromeArgs`)                                      |
| `resourceCache`              | enabled, ~8 GB in tmp                             | On-disk shared sub-resource cache (`enabled`/`dir`/limits)                                  |
| `renderer`                   | the default renderer                              | Custom renderer (see below)                                                                 |
| `installSignalHandlers`      | `true`                                            | Own SIGTERM/SIGINT (drain in-flight renders, then close Chrome); `false` to own the process |

## Rendering config

The `config` option (object or JSON-file path) is **deep-merged over the built-in defaults**, so only
include what you change:

```jsonc
{
	"devices": {
		"desktop": { "viewport": { "width": 1920, "height": 5000 } },
		"mobile": { "viewport": { "width": 390, "height": 844 } }, // omit userAgent to keep the default
	},
	"defaultDevice": "desktop", // fallback for an unknown deviceType
	"block": {
		"resourceTypes": ["image", "media", "font"], // aborted before loading
		"urlPatterns": ["google-analytics.com"], // abort requests whose URL contains any
	},
	"navigation": {
		"waitUntil": "domcontentloaded", // 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'
		"renderBudgetMs": 20000,
		// Cap on the initial navigation alone. 0 (default) lets it use the whole renderBudgetMs, so a
		// page that stalls before `waitUntil` holds a concurrency slot for the full budget and leaves
		// nothing for settle. Set it to fail a stalled navigation fast (counted as failures.navTimeout).
		"navigationTimeoutMs": 0,
		"networkIdleMs": 300,
		"networkIdleTimeoutMs": 1000,
		// Skip the settle phase when the pre-settle DOM already proves the page non-indexable
		// (non-200, `noindex`, or a canonical naming another document). The plugin can never store
		// such a page, so settling it is waste — settle is ~80% of a render. Only ever SKIPS a
		// render: a verdict that appears after DOMContentLoaded is still caught post-settle, and
		// sitemap-listed urls are exempt. Default false — enable it if your canonical and robots
		// tags are served in the document rather than written by script.
		"skipSettleWhenNonIndexable": false,
	},
	"scroll": { "enabled": true, "stepMs": 200, "topSettleMs": 300 }, // scroll to bottom for lazy content; topSettleMs lets scroll-reactive headers re-reveal at the top before serializing
	// optional: AFTER the normal scroll-settle (which still runs and triggers all other lazy content),
	// scroll a selector into view and wait for lazy content (e.g. reviews below the fold on a short
	// viewport) before the snapshot. Absent → no-op. Scope each rule with `devices`/`pathPattern` so it
	// only runs where the widget is — otherwise it polls to `timeoutMs` on pages/devices that lack it.
	"waitFor": [
		{
			"selector": "#reviews",
			"waitForSelector": ".review",
			"minCount": 1,
			"timeoutMs": 15000,
			"devices": ["mobile", "tablet"], // desktop's tall viewport already has it in view
			"pathPattern": "^/product/", // only product pages have this widget
		},
	],
	"postProcess": {
		"stripScripts": true, // remove executable <script> (keeps application/ld+json etc.)
		"inlineEmptyStyleSheets": true,
		"minifyInlineCss": false, // re-emit inline <style> from the CSSOM (see below)
		"pruneUnmatchedCss": false, // drop style rules that match nothing (needs stripScripts)
		"removeSelectors": ["link[rel=import]", "link[as=script]", "script#__NEXT_DATA__"],
		// strip named attributes off matching elements, last, before serialization
		"removeAttributes": [
			{ "selector": "astro-island", "attributes": ["props", "component-url", "renderer-url"] },
			{ "selector": "*", "attributes": ["data-analytics-*"] }, // trailing * = prefix match
		],
	},
	"injectWebComponentsPolyfill": true, // force ShadyDOM/ShadyCSS so shadow-DOM CSS serializes
	"extraHeaders": {}, // extra request headers on the navigation request
}
```

Invalid config (missing viewport, `defaultDevice` not in `devices`, non-positive budgets) throws at
`startWorker()`.

### `postProcess.minifyInlineCss` — re-emitting inline CSS from the CSSOM

Replaces each inline `<style>`'s source text with the browser's own serialization of the parsed
sheet (`rule.cssText`). This is `inlineEmptyStyleSheets` generalized from empty sheets to every one,
and it runs immediately after it. Off by default.

**It cannot corrupt CSS**, which is the whole reason to do it this way. A regex minifier splits on
`{`, `}`, `;` and `:` and therefore mangles any `url()` or quoted string containing one — a real
hazard in `content:` values and data URIs. Here the browser has already parsed the sheet, so the
output is by construction valid CSS.

**It is lossy in one bounded way.** Chrome discards what it does not implement at parse time, so
re-emitting drops vendor rules for other engines. Measured across three real pages, everything
dropped was exactly that: an `@-moz-document url-prefix(){…}` block (a Firefox-only hack) and an
`-ms-overflow-style` declaration. Everything else that looks like a loss is shorthand/longhand
normalization — `border-left` becomes `border-left-width`/`-style`/`-color`, `top`/`right`/`bottom`/
`left` become `inset`. Computed styles and geometry were identical for all 16,017 elements across
those pages, and `scrollHeight` was unchanged. If your snapshot is consumed by Chromium-based
crawlers, that is safe; if something else renders it, weigh the vendor-rule loss.

**Do not expect much.** This is a normalizer, not an aggressive minifier: CSSOM serializes grouping
rules (`@media`, `@keyframes`) with a newline and two-space indent per inner rule, and that stays.
Measured saving is 6–13% of the inline CSS, which was ~0.6% of the document on the pages above. It
is worth enabling alongside `removeAttributes` for the position it buys — on the product page the
`<h1>` moved from 80,125 to 74,935 — not for the bytes on their own.

A sheet is left untouched when it has no readable rules (a cross-origin sheet throws on `cssRules`),
when re-emission comes back empty, or when the result would not be smaller — so the pass never grows
a document and is idempotent.

### `postProcess.pruneUnmatchedCss` — dropping CSS the page cannot use

Deletes every style rule whose selector cannot match anything in the finished document. Off by
default.

A prerendered snapshot ships the whole site's CSS but only one page's DOM, so most of what it
carries is unreachable. On a review-heavy product page **74% of the style rules matched nothing** —
533 KB of a 1.89 MB document. This is by some distance the largest remaining lever on these pages,
and unlike the others it removes nothing the browser would have used.

**Why it is safe here specifically.** A pruned rule is only inert if the DOM can never change
again, and what guarantees that is `stripScripts`: with no code left in the snapshot, nothing can
add a class or an element after serialization. So the two options are coupled, and enabling this
one without `stripScripts` is rejected by config validation rather than silently accepted.

**Every uncertainty resolves toward keeping a rule.** The probe strips pseudo-classes and
pseudo-elements before testing, so `.card:hover` is judged on whether `.card` exists — state is
never the reason a rule is dropped. Structural pseudos (`:not()`, `:nth-child()`) come off too,
which only widens the probe. A selector carrying a quoted value is never rewritten (the rewrite
could cut inside the string) and is kept untested; anything that fails to parse once rewritten is
kept as well. In a selector list, one matching part keeps the whole rule.

**Grouping rules are recursed into but never deleted**, even when emptied — an `@layer` block that
disappears takes its position in the cascade order with it, and an empty `@media (…) {}` husk costs
a few bytes and risks nothing. `@keyframes` and `@font-face` are never touched, so an animation
whose rules were pruned still resolves.

Measured on six real pages (product/category/homepage × desktop/mobile), rendered with their actual
stylesheets: every computed property and `getBoundingClientRect` identical for all 36,896 elements,
page height unchanged, and full-page screenshots pixel-identical. Savings ranged from 8.9% of the
document (category) to 30.3% (mobile product page).

### `postProcess.removeAttributes` — dropping dead hydration payloads

Removes named attributes from the elements a selector matches. Empty by default (a no-op, so
existing deployments serialize byte-identically), and applied **last** — after every other
post-processing step, so `stripBlockedResources` still sees the `src`/`href` it reads and a
`removeSelectors` attribute selector still matches.

The case it exists for: a framework's client-side hydration payload. An island/component wrapper
carries the props its runtime would rehydrate from, serialized as JSON _inside an HTML attribute_ —
so every `"` becomes `&quot;` and the payload lands at roughly 6× the size of the JSON. With
`stripScripts` on, that runtime is not in the snapshot and can never read the payload back, which
makes it pure dead weight. Removing the _element_ is not an option — the wrapper contains the
server-rendered content — so the attribute is the unit, hence this option rather than
`removeSelectors`.

Size is not the only stake. Search engines apply a size budget per document — Bing's webmaster
tools flag "HTML size is too long" against a documented **soft limit of 1 MB**, "used for guidance
to ensure all content & links are available in the page source to be cached by the crawler". Take
that number from the tool's own issue text; third-party write-ups quote much smaller figures that
do not match it. Measured on one retail site's product page, the hydration payload was **83% of an
8.06 MB document** — 27 island wrappers, five of them each carrying a near-identical 1.4 MB
payload, the same dataset serialized five times over. Stripping those attributes took the document
to 1.37 MB, with the extracted text, links, images, `ld+json`, headings, classes and inline styles
all byte-identical to the untouched render.

Attribute names match case-insensitively. A trailing `*` makes an entry a prefix match
(`data-aue-*` covers `data-aue-prop`, `data-aue-label`, …), which keeps a rule from drifting as a
framework grows an attribute family. A bare `"*"` is ignored rather than honored — it would strip
`href`/`src`/`class` off everything the selector matches. A selector that fails to parse skips its
rule instead of failing the render.

Two things worth checking before adding a rule: an attribute may be **load-bearing for CSS**
(`[data-state]` selectors are common), and it may be a **diagnostic** — Astro removes `ssr` from
`<astro-island>` on hydration, so stripping `ssr` would destroy the only marker distinguishing a
healthy snapshot from an un-hydrated one. Strip what is inert, not what is merely non-visual.

## Custom renderer

A renderer receives the Puppeteer `page` and the `RenderJob` and returns the serialized HTML (or
`undefined`). **Wrapping `defaultRenderer`** keeps all the `config` behavior and lets you add steps
around it (auth cookies, app-ready waits, widget removal); returning your own HTML bypasses it.

## On-demand rendering & analysis (`renderOnce`)

`renderOnce()` runs the **same production render path** as a worker for a single URL fed directly —
off the queue, no MQTT, no result POST — and returns the HTML, per-phase timings, and outcome
signals. It's the harness for testing config changes and analyzing a page's prerenderability.

```ts
import { renderOnce, renderMatrix, selectorCountProbe, htmlContainsProbe } from '@harperfast/prerender-browser';

const r = await renderOnce({
	url: 'https://example.com/product/123',
	device: 'mobile', // a key in config.devices; default config.defaultDevice
	config: {
		/* same shape as startWorker's config */
	},
	bypass: { header: 'x-harper-renderer-bypass', token: process.env.TOKEN },
	probes: {
		// each runs against the live, settled page before teardown
		reviews: selectorCountProbe(['.review']),
		text: htmlContainsProbe(['Verified Buyer']),
	},
	screenshot: true,
});
console.log(r.outcome, r.statusCode, r.timings, r.probes);
// also: r.html, r.htmlBytes, r.isIndexable, r.redirectedTo, r.viewport, r.screenshot …
```

- **No Harper connection required** — an off-queue render never reads `settings.harper`, so `harper` is optional.
- **Fidelity** — the render is the unmodified `defaultRenderer` over the real settings/config/interception
  path; pass your deployed `renderer`/`config` for an exact reproduction. The resource cache defaults **off**.
- **`probes`** — the flexible analysis surface: each is `(ctx) => result` run against the live post-render
  page; results are keyed into `result.probes`. Two neutral factories ship — `selectorCountProbe` (live DOM,
  walks open shadow roots) and `htmlContainsProbe` (serialized-HTML substrings); pairing them separates
  "never loaded" from "lost in serialization". `keepOpen: true` returns the still-open `page`/`browser`
  (+ idempotent `close()`) for interactive/CDP probing.
- **`renderMatrix(url, devices, options)`** renders one URL across devices in a single browser — the
  desktop-vs-mobile comparison substrate.

`renderOnce`/`renderMatrix` mutate the process-global settings; run them one at a time (single-flight).

## Prerenderability audit (`renderAudit`)

`renderAudit()` is the analysis counterpart to `renderOnce`. For one `(url, device)` cell it renders the
page in **three states** and reports the **two diffs** that expose what a bot actually receives:

- **State A — full render (ground truth):** the deployed config with an exhaustive scroll/settle + a
  hydration sweep, so every lazy/below-the-fold module loads. This is "everything the page can show".
- **State B — served snapshot:** the deployed config as-is → the exact bytes the cache serves to bots.
- **State C — re-hydrated snapshot:** B's bytes reloaded at the real URL (nav-intercepted), so you see
  what those served bytes _display_ when a browser loads them.

```ts
import { renderAudit, renderHtmlReport } from '@harperfast/prerender-browser';

const cell = await renderAudit({
	url: 'https://example.com/product/123',
	device: 'mobile',
	base: {
		/* your DEPLOYED config — state B renders with exactly this */
	},
	bypass: { header: 'x-harper-renderer-bypass', token: process.env.TOKEN },
	hostResolverRules: { 'example.com': '203.0.113.10' }, // reach a staging edge IP in this env
	buckets: { reviews: '[class*=review-]' }, // page-type element counts, shadow-aware
	pageType: 'pdp',
	pathPattern: '^/product/',
});

console.log(cell.diff1.missing); // SEO content in the full render but absent from the served bytes
console.log(cell.diff2.findings); // served-fidelity defects: hidden / frozen / occluded / broken-img
console.log(cell.suggestedConfig); // a minimal, scoped config patch that would close the gaps

const html = renderHtmlReport([cell], { title: 'Prerender audit' }); // self-contained HTML report
```

- **Diff 1 — SEO completeness (A − B):** content present in every full render but missing from every
  served snapshot. Guarded against cry-wolf (digit/counter churn, phrase re-chunking, an unstable ground
  truth) so a finding means a real gap, not render noise.
- **Diff 2 — served fidelity (B − C):** ways the served bytes fail to _display_ — present-but-hidden text,
  a frozen/empty placeholder, a full-viewport overlay occluding content, or a broken/unresolved `<img>`.
- **`suggestedConfig`** — the two diffs rolled into one minimal `PrerenderConfig` patch (a scoped
  `waitFor` rule, `postProcess.removeSelectors`, `resolveLazyImages`, …) you can deep-merge and re-audit.
- **Customer-agnostic** — every site specific (selectors, hosts, tokens, page types) is an argument; the
  package bakes in no hostnames or IPs. `renderAudit` renders sequentially (single-flight, like `renderOnce`).
- **`runSelfCheck()` / `runSelfCheckResults()`** — the tool's own correctness suite (the pure diff
  classifier on synthetic fingerprints + the fidelity detectors against self-contained golden fixtures).

## Exports

`startWorker`, `defaultRenderer`, `RenderWorker`, `settings`, `loadConfig` / `mergeConfig` /
`defaultConfig`, `renderOnce` / `renderMatrix` / `selectorCountProbe` / `htmlContainsProbe`,
`renderAudit` / `renderHtmlReport` / `runSelfCheck` / `runSelfCheckResults`, and the
`BrowserOptions`, `Renderer`, `RenderJob`, `PrerenderConfig`, `WaitForRule`, `RenderOnceOptions`,
`RenderResult`, `Probe`, `RenderAuditOptions`, `AuditResult`, `Finding`, `Diff1`, `Diff2`,
`Fingerprint`, `SuggestedConfig` (and related) types.

## License

Apache-2.0
