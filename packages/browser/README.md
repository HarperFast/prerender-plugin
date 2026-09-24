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
			"structuredOffers": ["29.99", "USD", "InStock"], // [price, currency, availability] triples, sorted
			"pageFacts": {
				"canonical": "https://site.example.com/product/x",
				"title": "Thing | Example Store",
				"metaDescription": "A thing, in blue.",
				"h1": "Thing",
				"product": {
					"name": "Thing",
					"brand": "Example Brand",
					"image": "https://site.example.com/img/x.jpg",
					"rating": [4.6, 212], // [ratingValue, ratingCount ?? reviewCount]
					"offers": [["SKU-1", "29.99", "USD", "InStock"]], // [sku, price, currency, availability], document order
				},
				"breadcrumbs": ["Home", "Things"],
			},
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

**What the page claims** (`structuredOffers`, `pageFacts`). A variant that produced content also
carries facts the renderer read off the settled DOM (before `postProcess`), so the consumer can compare
the cached page's own claims against its sources of truth without parsing HTML on its write path. Both
fields share one wire contract: **absent** means the renderer predates the field (a consumer may alarm on
it); **`null`** means the extraction ran and found nothing to claim or failed benignly — it is posted as
`null`, never omitted, and an extraction failure never fails the render. Both are read in one in-page
pass (one `page.evaluate`, each JSON-LD block parsed once): a failure in one reader costs only that
field, and a failure of the pass itself posts `null` for both. The extraction runs only on
the path that produces content, so a variant without content (a redirect, a verdict, an error) may carry
neither — absence is meaningful only on a variant that carries content.

- `structuredOffers` — what the consumer's change probe compares today: every schema.org `Product` offer
  on the page as flat `[price, currency, availability]` triples, sorted; `null` when there are none or
  more than 200.
- `pageFacts` — what the page says about itself:
  - `canonical`: `.href` of the first `<link rel="canonical">`, absolute.
  - `title`: `document.title`, trimmed.
  - `metaDescription`: the first `<meta name="description">`, verbatim.
  - `h1`: the first `<h1>`'s text, whitespace collapsed.
  - `product`: the first JSON-LD node typed `Product` or `ProductGroup`. Top-level arrays and `@graph`
    are searched, and a block that does not parse is skipped without costing the others. It carries
    `name`; `brand` (`brand.name`, or a string brand); `image` (a string, the first of an array, or an
    ImageObject's `url`); `rating`, as the numbers `[ratingValue, ratingCount ?? reviewCount]`, or
    `null` when neither is numeric; and `offers`, one `[sku, price, currency, availability]` per offer
    in **document order** (keyed by sku, never sorted). An `AggregateOffer` contributes its `offers`
    list, and availability is reduced to its last path segment (`InStock`) exactly as in
    `structuredOffers`.
  - `breadcrumbs`: the names in the first `BreadcrumbList`, ordered by `position` (`item.name`, else
    the element's own `name`; unnamed crumbs are skipped).
  - Any fact the page does not state, or states empty, is `null`.
- Where the product facts come from when the page does not put them on one top-level node:
  - **sku on the product.** A product with exactly **one** offer that has no `sku` names it with the
    product's own `sku`. Never with several offers — the product's SKU names none of them then.
  - **ProductGroup variants.** A `ProductGroup` stating no offers of its own reports the offers of its
    `hasVariant` products, each sku-less offer taking its variant's `sku`, under the same 200-offer
    refusal (a group whose own offers are refused does not fall through to its variants). `name`, `brand`,
    `image` and `rating` stay the group's, taken from the first variant only where the group states none.
  - **One level of nesting.** When no top-level node matches, a page node's (`WebPage` or a subtype such as
    `ItemPage` or `CollectionPage`) `mainEntity` / `mainEntityOfPage` object is searched for the product,
    and its `breadcrumb` object for the trail. A top-level node always wins, and nothing deeper is read.

**Bounds are refusals, not truncations.** A truncated value would disagree with the consumer's source
forever and re-render the page on every comparison, so a value past its bound becomes no claim at all:
a `pageFacts` string over 2,048 characters is `null`; more than 200 offers makes `product.offers` `null`;
more than 30 breadcrumbs, or one breadcrumb name over 2,048 characters, makes `breadcrumbs` `null`; an
offer field over 64 characters is `null` (that field only). (`structuredOffers` predates this rule: it
refuses past 200 offers but still slices an over-long field to 64 characters.)

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

**One context per job** (`config.variantContext.shared`, off by default). Each variant has always had
a browser context of its own — its own cookie jar, its own origin storage, and its own copy of
Chrome's HTTP cache. The last of those is waste: both variants load the same page seconds apart, so
the second re-fetches every script, stylesheet and API response the first already pulled. Turning this
on renders a job's variants in one context, so Chrome serves the second from the cache the first
filled. Measured on a production storefront, second variant, with the on-disk resource cache already
on and warm: same-origin network responses fell from **103 to 22** on a product page and 99 to 16 on a
catalog page, total network fetches from ~337 to ~139, and the on-disk cache was not cannibalised (70
hits before, 66 after) — the two caches hold different things, since a cache shared between unrelated
renders can only keep cookieless GET script/stylesheet responses while a per-job one is thrown away
with its job.

**Only the cache is shared.** Between variants every cookie is deleted but `documentReuse.cookies.pin`
and the navigation origin's `local_storage`, `indexeddb`, `service_workers` and `cache_storage` are
cleared, so what a variant inherits is exactly what it inherits with this off. That wipe is the
feature: measured on the same page, an _unwiped_ shared context handed the second variant 125 cookies
instead of the 6 pinned ones and put both devices on one session id, one visitor id and one
bot-manager token — two devices sharing an identity is what `cookies.pin` exists to prevent, and
nothing downstream would notice. A wipe that cannot be applied takes the sharing with it: that variant
renders in a context of its own (counted as `variantContextResetFailures`), because the saving is only
worth having while it costs nothing. Sharing is also skipped entirely on a **sample job**, whose later
variants exist to fetch cold. It is independent of `documentReuse.enabled` — a site that serves
different markup per device cannot reuse a document but still fetches the same assets twice — and
best-effort: a variant that lands on a different browser than its sibling (a retirement, or the page
ceiling) simply starts a context there. The per-window log line reports `variantContextsShared` and
`variantContextResetFailures`.

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
		"urlPatterns": ["google-analytics.com", "re:/public/[0-9a-f]{40,}"], // abort URLs containing a substring, or matching a `re:` regex
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
	// Render a job's device variants in ONE browser context so Chrome's HTTP cache serves the second
	// variant what the first fetched (see "One context per job"). Cookies and origin storage are wiped
	// between variants down to `documentReuse.cookies.pin`, so nothing else carries over.
	"variantContext": { "shared": false },
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
	// optional: per-page-type statements of what a COMPLETE render contains. When one governs a
	// render it REPLACES the timer-based settle — see "Readiness contracts" below. Absent → no-op.
	"readiness": {
		"onSatisfied": "quiet", // stop once the contract holds AND the DOM has been still for quietMs
		"quietMs": 250,
		"unmetGraceMs": 1000, // stop waiting on a clause that has never been true once everything else holds
		"contracts": [
			{
				"name": "product",
				"pathPattern": "^/product/",
				"require": [
					{ "name": "price", "selector": "[data-price]", "nonEmptyText": true, "textMatches": "\\$\\s?\\d" },
					{ "name": "hydrated", "selector": "astro-island", "shed": "ssr" },
					{ "name": "no-skeletons", "absent": ".skeleton" },
					{ "name": "grid-or-empty", "anyOf": [{ "selector": ".tile", "minCount": 1 }, { "selector": ".no-results" }] },
					{ "name": "rails-filled", "every": ".rail", "contains": ".slide" },
					// only required when the page's own JSON-LD says the content should exist
					{ "name": "reviews", "selector": ".review", "onlyIf": { "jsonLdNumber": "aggregateRating.ratingCount" } },
				],
				"observe": [{ "name": "product-links", "selector": "a[href^=/product/]" }], // reported, never waited on
			},
		],
	},
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
	// optional: config patches that apply only to the renders they match. See "Scoped overrides".
	"overrides": [
		{
			"name": "product-settle",
			"pathPattern": "^/product/",
			"config": { "navigation": { "domStableTimeoutMs": 15000 }, "scroll": { "stepFraction": 1.0 } },
		},
	],
}
```

Invalid config (missing viewport, `defaultDevice` not in `devices`, non-positive budgets) throws at
`startWorker()`.

### Scoped overrides — per-route settle, and per-route everything else

Every block above is global: one setting for a home page, a category listing and a product page
alike. That is backwards for the settle phase in particular, because how long a page needs to settle
— and what it is even waiting for — is the most page-type-dependent thing the renderer does. A
settle sized for the page that needs the most is waste on every other page, and settle is roughly
78% of render time.

`overrides` is a list of config patches, each scoped by URL path and/or device:

```jsonc
"overrides": [
	// A cheap settle for a page type that has no lazy content worth waiting for.
	{ "name": "home", "pathPattern": "^/$", "config": { "scroll": { "settleStablePasses": 1 } } },
	// A patient one, with an explicit readiness gate, where the money is.
	{
		"name": "product",
		"pathPattern": "^/product/",
		"config": {
			"navigation": { "domStableTimeoutMs": 15000 },
			"waitFor": [{ "selector": "#reviews", "waitForSelector": ".review", "minCount": 1 }],
		},
	},
	// Narrower still: path AND device.
	{ "name": "product-mobile", "pathPattern": "^/product/", "devices": ["mobile"], "config": { … } },
]
```

- **Matching is `pathPattern` AND `devices`**; an omitted field matches everything. Scoping is on the
  URL path — there is no page-type axis, and a rule scope nothing can satisfy is worse than no rule.
- **Order decides.** Overrides apply in array order, each deep-merged over the result so far, so the
  last matching one wins a contested key. There is no specificity ranking.
- **Arrays replace, objects merge** — the same rule the top-level config merge already follows. An
  override that sets `waitFor` replaces the list rather than appending to it.
- **No-op when unset.** With no overrides configured the base config is returned by identity, so an
  existing deployment renders byte-identically.
- **Three blocks cannot be scoped**, and are rejected at config load: `cacheKey`, because it mirrors
  the URL-identity policy the plugin applies and the two must agree for every URL; `documentReuse`,
  because it is decided once per job and a job spans device variants, so a scoped value would never
  be read; and `variantContext`, for the same reason — the contexts a job opens are settled before
  its first variant renders. Overrides also cannot nest.
- Each override is **validated as applied** — merged over the base and run through the same checks —
  so a patch that replaces a good default with a bad value fails at load, not mid-render.
- `renderOnce()` reports which ones matched as `appliedOverrides`, and its `config` is the resolved
  config, so "which settings did this render actually use" has an answer you do not have to derive
  by hand.

**Tune settle against content, never against timings.** A dwell that looks like slack is often the
only thing holding a widget's load open: on one real site `networkIdleTimeoutMs` never resolves at
all, so it acts as a fixed per-pass sleep, and cutting it 2000 → 500 made renders 3.5× faster and
dropped every one of 1,635 review nodes with `outcome=ok` and no error. Add the explicit `waitFor`
readiness gate first, confirm the content is still there, and only then take the blind dwell down.

### Readiness contracts — deciding a render is complete by asking the page

Every other settle signal is a timer, and a timer cannot be wrong out loud. A render that missed a
widget, or that serialized pre-hydration markup, reports 200, non-empty and indexable, and nothing
downstream can tell. A contract states per page type what a complete render CONTAINS; the renderer
holds until that is true **and** the DOM has gone quiet, and posts the per-clause result back.

Seven assertion forms, each of which exists because something else could not express it:

| form                                          | satisfied when                                                        | exists because                                                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `selector` + `minCount`                       | at least N match (shadow-piercing)                                    | the base case                                                                                                               |
| `anyOf` (branch `textMatches` optional)       | any branch matches (a `textMatches` branch counts only matching text) | an empty-but-legitimate listing page is structurally identical to one whose grid has not arrived                            |
| `absent`                                      | nothing matches                                                       | skeletons and spinners that a real render replaces                                                                          |
| `selector` + `shed`                           | no element still carries the attribute (`maxRemaining`, `allowNone`)  | frameworks drop a marker on hydrate; this is the check that catches a snapshot of pre-hydration markup                      |
| `every` + `contains`                          | every container has content, and at least one exists                  | "at least 3 rails" is a constant someone measured once; "every rail is filled" survives the template changing               |
| `selector` + `nonEmptyText` (+ `textMatches`) | some match has text / matching text                                   | presence is not the same as populated                                                                                       |
| `responded` (+ `minCount`)                    | a named call (URL RegExp) has finished loading                        | content filled into a server-rendered slot by one API call — the call decides, and timers guessing at it clip the slow tail |

Any clause can carry `onlyIf` — a guard making it conditional on what the page's **own** data says
(`jsonLdNumber`) or on what the DOM holds (`present`). This is the difference between a guess and a
check: a product with reviews and one without are structurally identical apart from the reviews, so
a presence gate cannot tell "none" from "not yet", and accepting _either_ review items or a rating
summary fires early on pages that do have reviews (measured: the summary lands 236–263 ms before the
first review). Keyed on the page's declared `aggregateRating.ratingCount`, the document says what
should exist and the rendered DOM is held to it.

When the page's data cannot say it but the widget does — a rating count that includes ratings with
no review text, so there is nothing to list — give the `anyOf` branch for that state a
`textMatches`. The explicit statement ("N ratings without review text") satisfies; the headings the
widget renders on every page do not. Pick text the widget only shows in its final state: measured,
a review list's status line reads "1 to 0 of N" for 116–232 ms on pages that DO have reviews, before
the list fills.

A `responded` clause names the call a page's late content comes from. Measured on a commerce
template: recommendation rails are empty server-rendered slots filled by one first-party call, and a
render whose call took longer than the renderer's 5 s in-flight bound was treated as hung, released
by the rot valve and stored with the slot empty. A request matching a `responded` clause never ages
out, so the render holds while it is open (bounded by `timeoutMs`) and stops once it has answered
and the page is quiet. Guard it with `onlyIf: { present: <the slot> }` so a page without the slot
does not wait for a call it will not make. It is read from a document-start `PerformanceObserver`,
not the resource-timing buffer, which such a page overflows.

**Three properties worth knowing before writing one:**

- **The quiet window is not optional, and it is where the speed comes from.** Running the same stop
  policy with an _empty_ contract saves the same time to within 30 ms on 7 of 8 pages — the win is
  replacing blind dwells with one real quiescence test. Stopping the instant a contract holds saves
  more and loses the recommendation rails (measured: 99% of product links on one product page, 100%
  on an empty facet), because rails have no server-rendered placeholder and no clause can assert one
  is still coming. The contract's contribution is falsifiability, and that is what makes a short
  quiet window safe.
- **A clause must be false on a truncated render.** Anything server-rendered is true before the page
  finishes and proves nothing; keep those as validity clauses and make sure at least one clause names
  content that genuinely arrives late, or the contract will stop early.
- **Templates change, so contracts rot.** A clause that has never been true, once every other clause
  holds and the DOM is quiet, is stood aside after `unmetGraceMs` and reported unsatisfied — the
  render falls back to the ordinary settle. Cost degrades to roughly today's behaviour instead of
  waiting out the timeout on every render forever; without that valve one unsatisfiable clause
  measured +385% wall.

- **Cap `timeoutMs` low.** A contract that does not satisfy pays its whole timeout **and then the
  full fallback settle on top**, and it costs CPU rather than only wall, because the page keeps
  executing while the poll runs. Measured on a concurrency ladder: with a 15s timeout, one render in
  twelve under contention took 10.8s and CPU/render rose 36%; at 3s the straggler was 4.8s and CPU
  rose 12%, with the median render unchanged either way. Erring low is the safe direction — giving up
  early falls back to exactly what the renderer does without a contract, so a too-low timeout costs
  the optimisation and never the content. Set it from the `firstSatisfiedMs` distribution the results
  carry rather than from a guess; if p95 approaches the timeout, the contract is being abandoned
  under load and the win is quietly gone.

Note this is a different failure from the rot valve above, and needs its own control: `unmetGraceMs`
fires when a clause has never been true **and the page has gone quiet**, which is what a template
change looks like. A page that is merely slow is still mutating, so the valve does not fire and the
timeout is what bounds the wait.

An unsatisfied contract always falls through to the normal settle, so a badly written contract can
cost a render time but never content. So does a contract that _held_ but never saw the page go quiet
within its `timeoutMs`: the stop condition is "held **and** quiet", and the deadline is not a stop. `job.readiness` carries `satisfied`, per-clause `ok`/`count`/
`firstTrueMs`, and any `observe` counts.

`job.readiness.exit` (also on the wire) says **how** the contract's window ended: `stopped` (held
and quiet), `valve` (the rot valve stood a never-true clause aside), `deadline` (`timeoutMs` or the
render budget), `gone` (the page closed or navigated) or `observed` (report mode). `valve` and
`deadline` are the two exits that hand a render to the fallback settle, so they are the ones to
watch. `readiness.onGiveUp: 'stop'` (default `'settle'`) serializes an armed contract's render at
either exit instead of running the fallback timers, `waitFor` gates and final plateau. That is for a
page type whose late content is named (`responded`, `anyOf`, guards), so the fallback has nothing
left to rescue. The verdict is still restated against what was serialized, so an incomplete render
still says so.

### `navigation.forceVisibleBudget` — lazy content without a tall viewport or a scroll pass

Content that loads "when scrolled into view" waits on an `IntersectionObserver` callback. A renderer
usually satisfies that by brute force, either with a very tall viewport (so everything is "in view"
at load) or with a timed scroll pass, and both are paid on every render. With
`forceVisibleBudget: N`, a document-start shim reports each element the page observes as
intersecting, once, asynchronously, the way a real viewport reports an element already on screen.
Lazy widgets then initialise at any viewport height with no scroll at all.

Measured through the worker on two live commerce templates, interleaved against a 5,000px viewport
with a scroll pass. Rails, filled rail slots and review nodes were identical on every page; rail item
counts moved by at most 2 in either direction, which is the rails' own run-to-run churn.

| page type | viewport                      | CPU-s per render                                    | render p50 (desktop) |
| --------- | ----------------------------- | --------------------------------------------------- | -------------------- |
| listing   | 1,080px                       | **−39%**                                            | −10% (p95 −30%)      |
| product   | 1,080px                       | **−16%**                                            | −11% (p95 −16%)      |
| product   | 1,080px, **without** the shim | the review widget never loaded on any mobile render | —                    |

- **Budgeted per document.** A "load more" sentinel reported visible loads the next page, whose new
  sentinel would be reported too. Past the budget the native observer alone decides. Real pages of
  both types observed 96–211 elements per render.
- **An element reported visible is never un-seen:** the native "not intersecting" update that
  follows is dropped, so a component that unloads when scrolled away keeps what it loaded.
- **Nothing is reported for an element the page stopped observing** before the report was due.
- **What it cannot trigger:** code gated on `scroll` events or `getBoundingClientRect()` checks, and
  native `loading="lazy"`. Measure a page type with no scroll pass before relying on it.

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
status and indexability agree, and the structural divergence of the snapshot (plus, informationally and
outside the verdict, which `pageFacts` differ). **Read the offers
first** — where a site routes its API calls by a cookie the document sets, a replayed variant runs
without it, its pricing call is answered by a different backend, and the offers come back wrong while
everything else still looks healthy. A non-zero divergence ratio is not automatically a failure (live
pages churn between two renders seconds apart); a differing offer set is.

It also answers the question those per-device comparisons structurally cannot: **did mobile stay
mobile?** A replayed render is measured against three distances taken on the same page in the same
minute — its own control, the nearest other device's control, and **that device's own churn floor**,
which is why the run renders each URL three times: two reuse-off passes (whose distance from each
other is churn and nothing else) and one with reuse on. It
must sit closer to the churn floor than to its sibling (`device=own 0.080 vs sibling 0.238, churn
0.071`, `identity` on the result). A replayed variant that had become its sibling fails this even
though its offers, status and outcome all agree, because the sibling's page is a perfectly valid page.

The floor is what makes this usable on a live site. An absolute "kept its own markup" measure was
tried first and failed the control — recommendation rails pick different products on every render, so
even a variant that replays nothing loses most of its distinctive markup between two renders. Nor is
one shared floor enough: on one catalog page two desktop renders differed by 0.172 while two mobile
renders differed by 0.024, so judging mobile against desktop's noise invents a failure in one
direction and hides one in the other. Where the devices do not differ by more than the churn, the result is reported
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
