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
| `rps`                        | `8`                                               | Max job starts per second (a job renders every device of one URL — see the queue protocol)  |
| `jobClaimLimit`              | `concurrency * 2`                                 | Jobs claimed per batch                                                                      |
| `browserExpirationThreshold` | `200`                                             | Pages a browser renders before being retired                                                |
| `incognitoPages`             | `true`                                            | Render each page in a fresh incognito context                                               |
| `contentEncoding`            | `gzip`                                            | Encoding used when posting rendered HTML back                                               |
| `chromeArgs`                 | hardened headless set                             | Chrome launch flags                                                                         |
| `browserLaunchOptions`       | built from `chromeArgs`                           | Full Puppeteer launch options (overrides `chromeArgs`)                                      |
| `resourceCache`              | enabled, ~8 GB in tmp                             | On-disk shared sub-resource cache (`enabled`/`dir`/limits)                                  |
| `renderer`                   | the default renderer                              | Custom renderer (see below)                                                                 |
| `installSignalHandlers`      | `true`                                            | Own SIGTERM/SIGINT (drain in-flight renders, then close Chrome); `false` to own the process |

## Queue protocol

A **job is one URL.** The plugin (>= 0.66.0) claims one job per URL and names every device to
render on it:

```jsonc
// POST /render_queue/claim → 200 [ ...jobs ]
{
	"id": "https://site.example.com/product/x", // the schedule row this job stands for — echoed back verbatim
	"url": "https://site.example.com/product/x",
	"deviceTypes": ["desktop", "mobile"], // every device to render, in this order
	"deviceType": "desktop", // the first of them, for renderers that predate the list
	"expiresAt": 1757520000000, // lease expiry (epoch ms)
	"callbackOrigin": "https://harper-node:9926",
	"isFromSitemap": true,
}
```

The worker renders the devices **in turn on the job's one concurrency slot** — each on a fresh page,
through the same `renderer` — so `concurrency` still bounds pages in flight and renders-per-slot is
unchanged; a job just holds its slot for as many renders as it has devices. (`rps` therefore paces
_job_ starts.) Every device's snapshot then goes back in **one** result, which is what lets the plugin
keep a URL's variants aligned: same render pass, seconds apart, one scheduling decision.

```jsonc
// POST /render_queue/job_result   (x-metadata-size: <bytes of the JSON envelope>)
{
	"id": "https://site.example.com/product/x",
	"url": "https://site.example.com/product/x",
	"deviceTypes": ["desktop", "mobile"], // what was asked
	"variants": [
		// what was attempted, in order — each followed in the body by `contentLength` bytes of its
		// encoded HTML (0 = no content: a redirect, a verdict, or an error)
		{
			"deviceType": "desktop",
			"outcome": "rendered",
			"statusCode": 200,
			"headers": {},
			"renderTime": 8123,
			"isIndexable": true,
			"structuredOffers": null,
			"contentLength": 41210,
		},
		{
			"deviceType": "mobile",
			"outcome": "error",
			"reason": "error",
			"error": { "name": "TimeoutError", "message": "…", "phase": "settle" },
			"contentLength": 0,
		},
	],
}
```

**Document reuse** (`config.documentReuse`, off by default). On a responsive site the origin answers
every device with the same document, so the second and later variants of a job can be navigated from
the first variant's captured document instead of fetching it again — one document fetch per URL
render instead of one per device, and the second variant skips its download. **No cookie crosses variants except the ones you name**: the replayed response carries no
`Set-Cookie` and nothing is copied from the first variant's context, so every variant starts with an
empty jar. The exception is routing. Where a site picks _which backend_ serves the page's API calls
from a cookie its document sets, a cookieless sibling renders against a different backend than the
device that fetched the document, and one URL's two snapshots stop being comparable —
`documentReuse.cookies.pin` names those cookies (empty by default), and a pinned cookie is also sent
by a variant that goes to the origin itself, so parity holds whichever path a variant takes. Pin only
routing cookies: never a session, cart, visitor or bot-manager cookie, which tie a render to an
identity two devices must not share. Pinning assumes the cookie is **device-independent**; if a pinned name
comes back with different values per device the worker warns and counts `pinnedCookieConflicts`, but
that is a running check, not the gate. **Verify before you enable anything** with `reuseParityCheck`
(below), which answers the same question locally and in advance. (Corollary
worth knowing: with reuse off each device already gets its own document and its own cookie, so if the
value is assigned per response rather than derived from the request, the two devices can disagree
today.) A document is never reused when it is not a final `200 text/html`, has a redirect chain, or
sends a `Vary` naming the user agent or a client hint. A replayed variant posts `documentReused:
true`. Turn it on only for a **responsive**
site: an adaptive site (server-side device detection, m-dot) serves different markup per device, and
replaying desktop markup into a mobile render caches a page no mobile visitor is served. `sampleEvery:
N` keeps that claim tested — every Nth job fetches its second variant normally and logs the structural
divergence between the two documents (hashed asset names, hydration ids and script bodies are
normalised away, so a deploy in progress does not read as divergence); it reports and counts, and
deliberately never switches reuse off by itself.

**Document prefetch** (`config.documentReuse.prefetch`, off by default) takes the document fetch off
the render's critical path. Reuse makes it one fetch per URL instead of one per device; prefetch makes
that fetch overlap an _earlier_ job's render: the worker keeps a small bounded pool (`depth`) of
claimed jobs whose documents it fetches itself, in this process, while the render slots are busy, so
that when a slot frees the next job's document is already in hand. Its first variant's navigation is
answered from it **with the response's own cookies** (that variant is indistinguishable from one Chrome
fetched — it is its own response, arrived early), and the later variants replay it as under reuse,
without cookies. A prefetched document is that device's own response, so prefetch needs none of the
cross-device guards and works on its own for a single-device job; with `enabled` it is also what the
siblings replay. The request is built to be what the navigation would send (device user agent or the
browser's own, `extraHeaders`, the bypass token, the job's headers, Chrome's navigation `Accept` and
`Sec-Fetch-*`), and host resolution follows `hostResolverRules` exactly as Chrome does — a deployment
pinned to a staging edge never has its prefetch reach production. Only a final `200 text/html` within
32 MB is held; a redirect, an error status, a non-HTML body, a timeout (`timeoutMs`) or any failure
yields nothing and the variant fetches the document itself, at the cost of one extra request for that
URL. A variant answered from a prefetched document posts `documentPrefetched: true`. **The navigation
waits at most 500ms for a prefetch still in flight** and then fetches for itself, counted as
`prefetchLate`: that wait is spent inside the navigation, so an unbounded one would spend the render's
own budget waiting for a document it may not get. Sizing: to hide
a fetch of `f` seconds behind renders of `r` seconds on `c` slots, `depth ≥ f · c / r + 1` — the
default `2` covers c=10, f=1 s, r=12 s; a pooled job sits claimed about `depth · r / c` seconds before
its render starts, always inside the batch the plugin already claimed it in. **The pool also deepens
itself**: every time a render has to wait out the grace and go to the origin, depth grows by one up to
`maxDepth` (default 8) and stays there — the ratio between a fetch and a render is not something
configuration can know in advance, and the whole point is that the next render finds its document
already fetched. `rps` still paces render
starts, and at steady state a prefetch starts each time a render does, so the origin sees the same
request rate one render earlier. At shutdown, jobs still pooled — like any claimed job still waiting
for a slot when the drain began — are dropped (nothing rendered, nothing to post; the lease expires
and the queue re-grants them; `jobsAbandoned` counts them). The per-window log line reports
`documentsPrefetched`, `prefetchLate`, `prefetchFallthrough` (by why), `jobsAbandoned`, and under `phaseMs`
`prefetchFetch` (origin time taken off the render) and `prefetchWait` (how much of it a navigation
still waited for — 0 means the depth is enough). With prefetch on, a sample job compares a document
this process fetched against one Chrome fetched for the same URL, so it also keeps the prefetch's
fidelity under test — on a sample job every variant fetches cold, including the one the document was
prefetched for, so the comparison is same-device (this process against Chrome) rather than
cross-device.

A variant is **skipped and the result posted partial** when the lease has under 30s left or the
worker began draining between variants: `variants` then lists fewer devices than `deviceTypes`, the
plugin stores what rendered and retries the URL for the rest. (A result that never arrives would cost
the whole lease before anything retried.) The per-window log line reports `jobs` beside `completed`
(renders) and `variantsSkipped`.

**Compatibility.** A job WITHOUT `deviceTypes` — an older plugin, which claims one job per device
— is rendered as before and posted in the flat legacy shape (`{ id, url, outcome, … }` plus one
body), so this version can be deployed ahead of the plugin. The reverse is degraded, not broken: a
renderer older than this one, handed a multi-device job, renders only `deviceType` (the first) and
posts it flat; the plugin stores that one device and the others go unrendered until the fleet is
upgraded — so **roll the render fleet out first.**

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
	// Reuse the first device's document for the other devices of a job (see "Document reuse" above).
	// Only for a RESPONSIVE site; `sampleEvery` keeps a running structural check of that assumption.
	// `prefetch` fetches each job's document in the worker while earlier jobs render (see "Document
	// prefetch"): `depth` jobs ahead, giving up after `timeoutMs` (the variant then fetches itself).
	"documentReuse": {
		"enabled": false,
		"sampleEvery": 0,
		"prefetch": { "enabled": false, "depth": 2, "maxDepth": 8, "timeoutMs": 8000 },
		// Cookie NAMES that may cross variants — routing cookies only, never session/cart/visitor.
		"cookies": { "pin": [] },
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

### `paintParity` — validating that the snapshot still puts ink on screen

`renderAudit` compares the DOM: elements, attributes, text, computed styles. A whole class of
fidelity bug is invisible to it, because the markup stays perfect and only the _rendering_ is lost —
see the SVG-geometry case below, where 140 of 140 paths painted nothing while every DOM-level check
stayed green. `renderAudit` is structurally unable to catch that class at all: its ground-truth
state deliberately inherits the deployed post-processing, so a post-processing loss is applied to
both sides and cancels out.

`paintParity` keys on **paint identity** instead — the thing that makes a mark, named by something
stable enough to match across two independently rendered pages:

| kind  | key                                                     |
| ----- | ------------------------------------------------------- |
| `geo` | an SVG shape's own `d` / `points` / geometry attributes |
| `img` | the image's src basename                                |
| `bg`  | the `url()` of a background image                       |
| `txt` | the text string itself                                  |

For every key present on **both** sides it compares rendered area. A key that paints at origin and
has zero area in the snapshot is **lost ink** — regardless of whether its element, attributes and
computed styles are all still present. Keys only one side has are counted and reported, never
failed: that is ordinary content drift on a live site, and conflating the two is what makes naive
pixel diffing useless here.

```js
import { paintParity } from '@harperfast/prerender-browser';

const report = await paintParity({ url, base: deployedConfig, bypass });
// report.lost      -> [{ key, kind, origin: '17.4x17.3', served: '0x0' }, …]
// report.lostByKind-> { geo: 18, txt: 4 }
// report.shared / originOnly / servedOnly
```

The reference is the **non-prerendered** page: JS running, hydrated, post-processing off. The
snapshot is then loaded at the real URL (via the same `loadServed` path the audit uses) so relative
references and same-origin subrequests resolve as they do for a crawler fetching the cached bytes.
The inventory walk pierces open shadow roots deliberately — at origin a widget is often still
encapsulated while the snapshot has it flattened, and a non-piercing walk returns a false zero for
exactly the content most worth comparing.

**Sampling, and why the two sides reduce differently.** Each side is sampled over a short window
rather than at an instant, because carousels rotate, sliders transition and lazy images arrive. The
reductions are deliberately opposite: the reference keeps each mark's _smallest_ showing (it counts
as painting only if it painted in EVERY sample), the snapshot keeps its _largest_ (if it painted at
any point, it is not lost). Getting this symmetric is worse than not sampling — reducing both by
`max` inflates the reference as images load and manufactured 258 false losses on a real homepage.

**Read `gained` alongside `lost`.** Rotating content shows up as a symmetric pair: a hero carousel
caught on slide A at origin and slide B in the snapshot reports N lost and N gained, all in the same
region. That is a slide swap, not a defect — verified on a real homepage, where the six "lost"
shapes render identically on both sides when measured directly. A genuine loss is asymmetric: ink
disappears and nothing comparable appears in its place.

Two things to hold onto when using it. Marks below `minArea` (default 4px²) at origin are ignored, so
a hairline that rounds to zero on one side is not a finding. And when you test a detector like this,
**verify the fault is present in your broken fixture first** — an early version of this check
reported "no regression" because the fixture it was given had never actually been broken.

### `flattenShadowDom` and SVG geometry

The inbound reset that keeps page CSS out of flattened shadow content is deliberately **not**
`all: revert` on everything. `d`, `cx`, `cy`, `r`, `x`, `y`, `width` and `height` are CSS properties
in Chrome, and a presentation attribute supplies them from the _author_ origin — so a blanket revert
throws the geometry away and every flattened `<path>` collapses to zero size. Measured on a review
widget: **140 of 140 paths painted nothing**, leaving carousel arrows as empty outlined boxes while
the DOM, the text and every byte-level check looked perfect.

So SVG subtrees are excluded from the blanket reset, and the leak that reset exists to stop — a page
`svg { display: block }` that stacks a star row vertically — is closed by reverting just `display`
(plus `vertical-align`/`max-width`/`width`/`height`, the rest of what a Preflight-style reset sets on
`<svg>`). Both rules are `:where()`, specificity 0, emitted before the component's own CSS, so the
component still wins wherever it has an opinion. Origin paints 96 of 143 paths on that page; this
restores 92 of 140 — parity within render drift.

This is worth knowing generally: **a fidelity bug can be invisible to DOM- and text-level checks.**
Nothing was missing from the markup; the geometry was gone.

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
which only widens the probe. Anything that fails to parse once rewritten is kept untested, and in a
selector list one matching part keeps the whole rule.

The one case the rewrite cannot handle is a **colon inside a quoted value** —
`[style*="display: block"]` is the shape a regex strip would cut through the middle of — so those
selectors are kept untested. Note the distinction: quotes alone are not the hazard. On the flagged
page 2,674 of 3,589 selectors carry a quote (the reviews widget keys on `[data-bv-show="…"]`) while
only 2 have a colon inside one, so bailing on every quoted selector would have forfeited most of
the saving for nothing.

**DOM the probe cannot see is accounted for explicitly**, because anything hidden from
`document.querySelector` would make a live rule look dead. There are four such places and they are
not equivalent:

- **`<template>` content** is serialized into the output but is not in the document tree, and
  **`<noscript>` content** is inert _text_ while scripting is enabled (which it is, inside the
  renderer) yet becomes live DOM for any consumer that renders the snapshot with scripting off.
  Both are probed: template fragments directly, noscript markup via `DOMParser`. Only rules the
  main document rejects pay for this, and these roots are tiny.
- **iframes** need nothing. CSS does not cross a browsing context, so a parent sheet never styles
  iframe content; that content is not in the output either (`outerHTML` emits the tag, not the
  loaded document); and the iframe's own stylesheets are never touched, since the pass runs in the
  main frame. Rules styling the `<iframe>` _element_ match in the parent DOM as usual.
- **shadow roots** need nothing. `flattenShadowDom` has already inlined open roots into the light
  DOM by the time this runs, so their content is visible to the probe; closed roots reach neither
  the flatten nor the serializer, so nothing that references them is in the output.

**Grouping rules are recursed into but never deleted**, even when emptied — an `@layer` block that
disappears takes its position in the cascade order with it, and an empty `@media (…) {}` husk costs
a few bytes and risks nothing. `@keyframes` and `@font-face` are never touched, so an animation
whose rules were pruned still resolves.

**Verification.** Six real pages (product/category/homepage × desktop/mobile) were each rendered
twice through the full pipeline — this flag off, then on, nothing else changed — and both outputs
loaded with their real stylesheets. On five of the six, every computed property and every
`getBoundingClientRect` was identical across all elements, with text, link and image counts and
page height unchanged.

| page             | before  | after   |        |
| ---------------- | ------- | ------- | ------ |
| product desktop  | 1.89 MB | 1.39 MB | −26.6% |
| product mobile   | 1.61 MB | 1.14 MB | −29.4% |
| category desktop | 0.88 MB | 0.80 MB | −8.9%  |
| category mobile  | 0.75 MB | 0.67 MB | −10.4% |
| homepage desktop | 0.74 MB | 0.65 MB | −12.1% |
| homepage mobile  | 0.57 MB | 0.48 MB | −15.7% |

The sixth (homepage desktop) genuinely renders differently, and the honest size of it is: **1.01% of
fold pixels change** (13,150 px, 2,880 of them strongly), and the page ends 1 px shorter. That is
larger than a "rounding" story suggests, so here is what it actually is.

Every underlying difference is float precision. Across 3,845 elements, **exactly one** moves 1 px or
more — an inline `<a>` whose x shifts 5.5 px as accumulated sub-pixel width changes re-break a line.
The other 1,785 differences are all sub-1px: `width`/`height` by ~0.01 px, nine `font-size` values
resolving `9.99999px` where they had `10px`, `text-decoration` thickness `1px` → `0.999999px`. Text
shifted a fraction of a pixel re-rasterises, and re-rasterised glyph edges are what those 13,150
pixels are.

**No rule is lost.** The font-size rules matching the drifting elements are identical in number and
in text on both sides; they are `em`-chained (`0.625em`, `0.83333em`), and Chrome accumulates float
error through an `em` chain differently depending on how computed-style objects are shared —
deleting rules changes that sharing.

Attribution was checked rather than assumed, because the obvious guess is wrong. Re-serialising the
sheets is **not** what does it: a control that re-rendered the same stored page with the flag _off_ —
same extra pass, same re-emission, nothing deleted — differs by **0 px**. Deleting the rules is what
moves the pixels. Worth knowing before blaming `minifyInlineCss` for a similar drift elsewhere.

Two measurement traps are worth recording, because both manufacture false alarms here.
Computed-style property **enumeration order is not stable** — Chrome lists custom properties in
stylesheet-registration order, so deleting rules reshuffles the enumeration while every value stays
identical; compare sorted, or all 9,991 elements look changed when none are. And a page's own
**running animations** (a `shimmer` placeholder) make computed values time-dependent, so freeze them
before sampling.

**Cost.** The pass is bounded by `querySelector` calls, and answers are memoized per probe string
(the DOM cannot change while it runs), so repeated selectors are paid for once — on the flagged
product page, 4,387 probes collapse to 3,144 calls.

Measured in place rather than in a bench: the `postProcess` phase goes from **119–128 ms to
229–230 ms**, so the pass costs about **105 ms** on a ~10 s render — roughly 1%. (An earlier
figure of 81 ms came from a `setContent` bench and understated it; take the in-place number.)
Lighter pages are 5–12 ms. A rightmost-compound prefilter would roughly halve it, but it was
measured disagreeing with the DOM on two rules and rejected: a pass that deletes CSS has to be
exactly right, not nearly right.

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

### `reuseParityCheck` — proving reuse is safe BEFORE enabling it

```ts
import { reuseParityCheck, formatReuseParity } from '@harperfast/prerender-browser';

const results = await reuseParityCheck({
	urls: ['https://example.com/product/a', 'https://example.com/product/b'],
	devices: ['desktop', 'mobile'],
	pin: ['bucket'], // the routing cookies you intend to configure
	bypass: { header: 'x-origin-bypass', token: process.env.BYPASS_TOKEN },
	config: {
		/* the fleet's own rendering config */
	},
});
console.log(formatReuseParity(results));
```

Renders each URL twice — once with reuse off, which is what production does today and therefore the
control, and once with it on — and compares **each device against its own control**. Nothing is
compared across devices: the question is not whether desktop and mobile agree (they should not) but
whether each is still the page it would have been.

It reports, per device, whether the page's own `structuredOffers` are identical, whether the outcome,
status and indexability agree, and the structural divergence of the snapshot. **Read the offers
first** — where a site routes its API calls by a cookie the document sets, a replayed variant runs
without it, its pricing call is answered by a different backend, and the offers come back wrong while
everything else still looks healthy. A non-zero divergence ratio is not automatically a failure (live
pages churn between two renders seconds apart); a differing offer set is.

It also answers the question those per-device comparisons structurally cannot: **did mobile stay
mobile?** A replayed render is measured against three distances taken on the same page in the same
minute — its own control, the nearest other device's control, and the **churn floor**: the same
measurement for a variant that replayed nothing and therefore fetched its own document both times. It
must sit closer to the churn floor than to its sibling (`device=own 0.080 vs sibling 0.238, churn
0.071`, `identity` on the result). A replayed variant that had become its sibling fails this even
though its offers, status and outcome all agree, because the sibling's page is a perfectly valid page.

The floor is what makes this usable on a live site. An absolute "kept its own markup" measure was
tried first and failed the control — recommendation rails pick different products on every render, so
even a variant that replays nothing loses most of its distinctive markup between two renders. Catalog
pages here churn 0.23 while their two devices differ by 0.28, so a fixed threshold would be either
blind or crying wolf. Where the devices do not differ by more than the churn, the result is reported
`INCONCLUSIVE` rather than passed or failed, and the variant that fetched its own document is never
judged — it is the control. This is the only comparison here that crosses devices, and it crosses them
to prove they stayed apart.

This is the gate for turning `documentReuse.enabled` on, and for deciding what belongs in
`cookies.pin`. The in-worker sampled check is the ongoing version of the same question, but it can
only report after the affected snapshots have been served.

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
