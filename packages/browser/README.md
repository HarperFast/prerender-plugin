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
		"removeSelectors": ["link[rel=import]", "link[as=script]", "script#__NEXT_DATA__"],
	},
	"injectWebComponentsPolyfill": true, // force ShadyDOM/ShadyCSS so shadow-DOM CSS serializes
	"extraHeaders": {}, // extra request headers on the navigation request
	// How much of a render to pay for before accepting the page will not be served. Both decide
	// right after navigation instead of after the settle phase — see "Early suppression" below.
	"suppression": { "earlyErrorStatus": true, "earlyNonIndexable": true },
}
```

Invalid config (missing viewport, `defaultDevice` not in `devices`, non-positive budgets) throws at
`startWorker()`.

### Early suppression

The settle phase is where a render's cost is — on the reference deployment the scroll-settle passes
alone are **~78% of render time** and the bulk of per-render CPU. A page that turns out to be
non-indexable pays all of it, has its bytes discarded, and then pays it again on every
`render.suppression.recheck` for as long as the plugin keeps the target. Two verdicts are already
final immediately after navigation, so `suppression` takes them there.

The two switches are separate because their risk is not the same:

- **`earlyErrorStatus`** is behaviour-identical _by construction_. An HTTP status cannot change during
  the settle, and the post-settle branch does nothing with a non-200 but report it with no content —
  for a sitemap-listed URL as well. There is no case where settling first produces a different result,
  which is why it needs no sitemap exemption and why turning it off buys nothing but latency.
- **`earlyNonIndexable`** reads the page's own `noindex` / `<link rel=canonical>` off the _initial_
  DOM rather than the settled one. Those agree unless the page mutates its own `<head>` during the
  settle — adding a canonical from client-side routing, or removing a server-rendered `noindex`. The
  second direction is the one that costs something, so it gets its own switch. The post-settle check
  remains the backstop either way: a page that adds its `noindex` late is still caught, it just pays
  for the settle to be caught.

**Sitemap-listed URLs are never eligible for `earlyNonIndexable`.** They are serialized even when
non-indexable, so their settle is not wasted work and bailing would replace a served page with
nothing. (`renderOnce` maps `captureNonIndexable` onto `job.isFromSitemap`, so an inspection render
settles by default.)

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
