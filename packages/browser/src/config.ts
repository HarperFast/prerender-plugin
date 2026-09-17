/**
 * Per-site rendering configuration for the prerender browser: how pages are
 * rendered for a given site (device profiles, request blocking,
 * navigation/scroll/wait strategy, HTML post-processing).
 *
 * Resolved by settings.ts from the `config` option passed to `startWorker()` —
 * either a deep-partial object (merged over the defaults via `mergeConfig`) or a
 * path to a JSON file (`loadConfig`). The defaults reproduce the original hardcoded
 * behavior, so an unconfigured deployment renders exactly as before.
 */

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { KnownDevices } from 'puppeteer';
import type { PuppeteerLifeCycleEvent } from 'puppeteer';

export type Viewport = {
	width: number;
	height: number;
	deviceScaleFactor?: number;
	isMobile?: boolean;
	hasTouch?: boolean;
	isLandscape?: boolean;
};

export type DeviceProfile = {
	/** User-Agent to set for this device. Omit to keep the browser default (Chrome desktop UA). */
	userAgent?: string;
	viewport: Viewport;
};

export type BlockConfig = {
	/** Puppeteer resource types aborted before they load (e.g. image, media, font, stylesheet). */
	resourceTypes: string[];
	/** Requests whose URL contains any of these substrings are aborted (e.g. analytics/ad hosts). */
	urlPatterns: string[];
	/**
	 * When `image` is in `resourceTypes`, answer blocked image requests with a 1×1
	 * transparent GIF (HTTP 200) instead of aborting them. Lazy-load libraries that
	 * swap a real URL into `src` and then fall back to a placeholder on load *error*
	 * (e.g. Slick) keep the real URL this way — so the serialized HTML retains real
	 * image URLs for indexing and shows no broken-image placeholders — while still
	 * transferring only ~43 bytes per image. Aborts (media/font and `urlPatterns`)
	 * are unaffected. Default false (preserves abort-everything behavior).
	 */
	stubImages: boolean;
};

export type NavigationConfig = {
	/** Puppeteer `waitUntil` for the initial navigation. */
	waitUntil: PuppeteerLifeCycleEvent | PuppeteerLifeCycleEvent[];
	/** Default per-render time budget (ms) used when a job doesn't specify one. */
	renderBudgetMs: number;
	/**
	 * Cap (ms) on the initial navigation alone — the wait for `waitUntil`. Without it the
	 * `goto` timeout is the *whole* remaining render budget, so a page that stalls before
	 * `waitUntil` burns a concurrency slot for the full budget and, when it does eventually
	 * load, leaves nothing for the settle phase (the waits below all clamp to what's left).
	 * A sub-budget fails a stalled navigation fast, frees the slot, and separates the two
	 * causes in the worker's stats (`failures.navTimeout` vs `failures.timeout`).
	 *
	 * `0` disables the cap (navigation may use the entire budget) — the default, preserving
	 * prior behavior. Values above the remaining budget have no effect; the smaller wins.
	 */
	navigationTimeoutMs: number;
	/** Idle window for the post-navigation/scroll network-idle waits (ms). */
	networkIdleMs: number;
	/** Max time to wait for network idle (ms). */
	networkIdleTimeoutMs: number;
	/**
	 * After the network-idle waits, additionally wait until the serialized DOM stops
	 * changing. Network-idle is an unreliable "content done" signal for widgets that
	 * begin loading *after* a brief network lull (e.g. a reviews widget that injects
	 * on scroll-into-view) — the idle wait fires in the gap and snapshots too early.
	 * Polling the DOM size until it settles captures that late content.
	 *
	 * `domStableMs` is how long the DOM element count must hold steady to be considered
	 * stable; `0` disables the wait (the default, preserving prior behavior).
	 * `domStableTimeoutMs` caps the total wait; `domStablePollMs` is the sample interval.
	 * `domStableTolerance` is the element-count drift (vs the window baseline) tolerated
	 * without resetting the timer, so small cosmetic churn (a carousel swapping a few
	 * nodes) doesn't keep the page "unstable" forever while a real widget injection
	 * (hundreds/thousands of nodes) still does.
	 */
	domStableMs: number;
	domStableTimeoutMs: number;
	domStablePollMs: number;
	domStableTolerance: number;
	/**
	 * Run the DOM-plateau check ONE MORE TIME at the very end of settle, after the `waitFor` gates.
	 *
	 * Without it a gate can release the snapshot onto a DOM that is still filling. Measured: a
	 * product page gated on its reviews widget serialized with 107 product links instead of 547,
	 * because `domStable()` runs BEFORE the gates, plateaued on a DOM that had not yet received the
	 * recommendation rails, and the review gate then let the snapshot go. Reviews were complete and
	 * correct; a whole other section was not there.
	 *
	 * The alternative is a `waitFor` rule per widget, forever, and a page is only as complete as the
	 * widget someone remembered to name. A plateau after the gates is the general form of the same
	 * check, so prefer this over growing the rule list.
	 *
	 * It is also the ONLY plateau check that runs under `scroll.settleUntilStable` — that branch
	 * calls `scrollSettle()` and never calls `domStable()` at all.
	 *
	 * Bounded by `domStableTimeoutMs` and the remaining budget like every other wait, and a complete
	 * no-op when `domStableMs` is 0. Default false, preserving existing behavior byte-for-byte —
	 * but turn it on for any config that leans on `waitFor` gates.
	 */
	finalDomStable: boolean;
	/**
	 * Decide indexability against the pre-settle DOM and skip the settle phase when the answer is
	 * already "not indexable" — the plugin can never store such a page, so settling it is waste,
	 * and settle is the dominant cost of a render. See the bail in `renderer.ts` for what it does
	 * and does not cover.
	 *
	 * Default false: a site whose canonical or robots tag is written by script rather than served
	 * in the document would see pages skipped that a full render would have kept.
	 */
	skipSettleWhenNonIndexable: boolean;
};

export type ScrollConfig = {
	/** Scroll to the bottom to trigger lazy-loaded content before serializing. */
	enabled: boolean;
	/** Delay between scroll steps (ms). */
	stepMs: number;
	/**
	 * Scroll increment per step in the settle loop (`settleUntilStable`), as a fraction of the
	 * viewport height. Larger = fewer steps per pass = faster + less layout/paint CPU, but skips
	 * more per hop, so a lazy widget with a tight `rootMargin` could be scrolled past before its
	 * IntersectionObserver fires. `0.5` (half-viewport) is the safe default; `1.0` (full viewport)
	 * roughly halves pass time. Values ≤ 0 fall back to 0.5. Default 0.5.
	 */
	stepFraction: number;
	/**
	 * Loop full scroll-passes (with a network-idle wait between each) until the DOM's
	 * element count holds steady across passes, instead of a single scroll-to-bottom.
	 * A single fast scroll triggers IntersectionObserver-lazy widgets but snapshots
	 * before they finish; repeated passes keep them in view and let late content
	 * (reviews, UGC carousels, vote controls) fully load. Heavier (more wall-clock),
	 * bounded by `navigation.domStableTimeoutMs`. Default false.
	 */
	settleUntilStable: boolean;
	/**
	 * How many consecutive stable scroll-passes end the settle loop (only used when
	 * `settleUntilStable` is true). Fewer passes = faster but riskier; the per-pass
	 * `navigation.domStableTolerance` controls how much late churn is ignored. Default 2.
	 */
	settleStablePasses: number;
	/**
	 * After scrolling back to the top (end of the scroll/settle phase), wait this many ms
	 * before serializing so scroll-reactive UI returns to its top state. Sticky/compact
	 * headers commonly hide the main header on scroll-down and re-reveal it only at the
	 * top via a throttled scroll handler that runs a tick *after* `scrollTo(0, 0)` — with
	 * no wait, the snapshot captures the header mid-hide (a blank band). `0` disables the
	 * wait. Default 300.
	 */
	topSettleMs: number;
};

/**
 * A rule that strips named attributes off the elements a selector matches, applied last —
 * after every other post-processing step — and only to the serialized output.
 *
 * The motivating case is a framework's client-side hydration payload. An island/component
 * wrapper carries the props its runtime would rehydrate from, serialized as JSON *inside an
 * HTML attribute* — so every `"` becomes `&quot;` and the payload lands at roughly 6× the
 * size of the JSON. With `stripScripts` on, that runtime is gone from the snapshot and can
 * never read it back, which makes the payload pure dead weight: measured on one retail site
 * it was 12% of a product page and 33% of a category page. Removing the *element* is not an
 * option — the wrapper contains the server-rendered content — so the attribute is the unit.
 *
 * Byte count is not the only stake. Search engines apply a size budget to a document (Bing
 * documents a 125 KB soft limit past which a page "risks not being fully cached"), so dead
 * bytes ahead of the content push real content past the cut. On the product page above, the
 * `<h1>` sat at byte 161,454 — outside that budget — and moved to 80,809 once the hydration
 * attributes were dropped.
 *
 * Site-specific by nature, hence config rather than a built-in list: which attributes are
 * inert depends entirely on the framework that produced the page.
 */
export type RemoveAttributesRule = {
	/** CSS selector for the elements to strip. A selector that throws is skipped, not fatal. */
	selector: string;
	/**
	 * Attribute names to remove, matched case-insensitively. A trailing `*` makes an entry a
	 * prefix match (`data-aue-*` removes `data-aue-prop`, `data-aue-label`, …), which keeps a
	 * rule from drifting as a framework adds attributes to a family. A bare `"*"` is ignored
	 * rather than honored — stripping every attribute off an element is never what a caller
	 * means here, and it would silently delete `href`/`src`/`class`.
	 */
	attributes: string[];
};

export type PostProcessConfig = {
	/** Remove executable `<script>` tags (data scripts like application/ld+json are kept). */
	stripScripts: boolean;
	/** Inline the text of empty (CSSOM-injected) stylesheets so styles survive serialization. */
	inlineEmptyStyleSheets: boolean;
	/**
	 * Re-emit every inline `<style>` from the CSSOM (`rule.cssText`) instead of the origin's
	 * source text. This is `inlineEmptyStyleSheets` generalized from empty sheets to all of them,
	 * and it is a *minifier that cannot corrupt*: the browser has already parsed the sheet, so
	 * unlike a regex pass there is no way to mangle a `url()` or a quoted string containing
	 * `{`, `}`, `;` or `:`. A sheet is left untouched if it has no readable rules, or if
	 * re-emission would not make it smaller.
	 *
	 * It IS lossy, in one specific and bounded way: Chrome discards what it does not implement at
	 * parse time, so re-emitting drops vendor rules for other engines. Measured across three real
	 * pages, everything dropped was exactly that — an `@-moz-document url-prefix(){…}` block
	 * (a Firefox-only hack) and an `-ms-overflow-style` declaration. Everything else that looked
	 * like a loss was shorthand/longhand normalization (`border-left` → `border-left-width`/
	 * `-style`/`-color`, `top`/`right`/`bottom`/`left` → `inset`). Computed styles and geometry
	 * were identical for all 16,017 elements across those pages, and `scrollHeight` was unchanged.
	 *
	 * So: safe for the snapshot's actual consumers, which render with Chromium — and a smaller
	 * semantic change than `stripScripts`, which is on by default. Weigh it against the payoff
	 * before enabling: on those pages it saved ~8% of the CSS, which is ~0.6% of the document.
	 * Default false.
	 */
	minifyInlineCss: boolean;
	/**
	 * Drop every style rule whose selector cannot match anything in the finished document.
	 *
	 * A prerendered snapshot carries the whole site's CSS but only one page's DOM, so most of
	 * what ships is unreachable. On a review-heavy product page 74% of the style rules matched
	 * nothing — 533 KB of the 1.89 MB document.
	 *
	 * This is only sound because the served snapshot is inert: with `stripScripts` on there is
	 * no code left to add a class or an element, so a selector that matches nothing at
	 * serialization time can never match afterwards. `validate()` therefore refuses the
	 * combination `pruneUnmatchedCss` without `stripScripts` — with scripts left in, a crawler
	 * re-runs them and a pruned rule could have been needed.
	 *
	 * Every uncertainty resolves toward KEEPING a rule: state pseudo-classes (`:hover`,
	 * `:checked`, …) and pseudo-elements are removed before probing, so only the part that must
	 * exist statically is tested; a selector that cannot be probed (quoted attribute values,
	 * anything that fails to parse once rewritten) is kept untested. Grouping rules
	 * (`@media`, `@supports`, `@layer`, …) are recursed into but never deleted, so cascade layer
	 * order is untouched. `@keyframes` and `@font-face` are never touched.
	 *
	 * Verified inert on six real pages (product/category/homepage × desktop/mobile): computed
	 * style — every property — plus `getBoundingClientRect` were identical for all 36,896
	 * elements, and page height was unchanged. Default false.
	 */
	pruneUnmatchedCss: boolean;
	/** Extra CSS selectors whose matching elements are removed before serialization. */
	removeSelectors: string[];
	/**
	 * Inline open shadow roots into the light DOM before serialization. `outerHTML`/
	 * `XMLSerializer` do not include shadow DOM, so content rendered there (e.g. a
	 * Bazaarvoice review list that Googlebot *does* see after rendering) would be lost
	 * from the prerendered HTML. When enabled, each open shadow root's HTML is appended
	 * into its host element so it survives serialization. Default false.
	 */
	flattenShadowDom: boolean;
	/**
	 * Remove resource elements (img/iframe/script/source/embed/link/…) whose URL matches
	 * a `block.urlPatterns` entry from the serialized HTML. Blocking at render keeps those
	 * hosts from loading *during* the render, but the tags remain in the output and would
	 * fire when the cached page is loaded/rendered (polluting ad/analytics reporting and
	 * throwing console errors). Stripping them keeps the served HTML clean. Default false.
	 */
	stripBlockedResources: boolean;
	/**
	 * Resolve lazy-loaded images: when an `<img>` has no real `src` (empty, a data: URI,
	 * or a loader/placeholder/spacer graphic) but carries the real URL in a lazy attribute
	 * (`data-lazy`, `data-src`, `data-original`, `data-image-src`, or `srcset`/`data-srcset`),
	 * copy that URL into `src`. Carousels/grids only set `src` for the slides scrolled into
	 * view, so off-screen images would otherwise ship with no `src` and never load when the
	 * page is served. Default false.
	 */
	resolveLazyImages: boolean;
	/**
	 * Attributes to strip from the serialized HTML, as `{ selector, attributes }` rules
	 * (see {@link RemoveAttributesRule}). Applied last, so every earlier step still sees the
	 * attributes it keys on — `stripBlockedResources` reads `src`/`href`, and a `removeSelectors`
	 * entry may match on an attribute this would remove. Empty by default → a no-op, so existing
	 * deployments serialize byte-identically.
	 */
	removeAttributes: RemoveAttributesRule[];
};

/**
 * A declarative "wait for content" rule applied after the scroll/settle phase and before the
 * snapshot. It scrolls a selector into view (to trip an IntersectionObserver-lazy widget) and then
 * waits until a content selector reaches a minimum match count. This is the reusable seam for
 * content that a fast scroll-settle passes over before it finishes loading — e.g. a reviews widget
 * that lazy-loads only once its container enters the viewport and sits below the fold on a short
 * (mobile) viewport. Because it lives in the config, the SAME rule is honored identically by the
 * on-demand harness (`renderOnce`) and the production fleet (it travels the per-site config the
 * consumer already feeds `startWorker`). Best-effort: a rule that never satisfies just times out.
 */
export type WaitForRule = {
	/** Optional label for telemetry — how this rule is attributed in `waitForResults`. Falls back to
	 *  the selector, which is fine until two rules share one. */
	name?: string;
	/** CSS selector to scroll into view. Required; caller-supplied at runtime — there is no default. */
	selector: string;
	/** Scroll `selector` into view before waiting (default true; set false to only wait). */
	scrollIntoView?: boolean;
	/** Selector whose match count must reach `minCount`. Defaults to `selector`. */
	waitForSelector?: string;
	/** Minimum matches of `waitForSelector` required to proceed (default 1). */
	minCount?: number;
	/** Require the match count to hold steady this long (ms) before proceeding (optional). */
	stableMs?: number;
	/** Max time to wait for this rule (ms). Default: the remaining render budget. */
	timeoutMs?: number;
	/**
	 * Only apply this rule for these device types (matched against the job's `deviceType`, i.e. the
	 * keys of `devices`). Omit → all devices. Scope a rule to the device(s) that actually need it
	 * (e.g. `['mobile', 'tablet']`, since a tall desktop viewport already has the content in view).
	 */
	devices?: string[];
	/**
	 * Only apply this rule when the render URL's PATH matches this JavaScript regular expression
	 * (e.g. `'^/product/'` for PDPs). Omit → all paths. Scope a rule to the routes that have the
	 * widget so it never polls to the timeout on pages that don't (a page-type latency guard).
	 */
	pathPattern?: string;
};

/**
 * How to read a page's `<link rel="canonical">` — see `canonicalVerdict` in util/url.ts.
 *
 * A canonical that names a DIFFERENT document always makes the page non-indexable; that much is
 * invariable. The open question is the re-spelling: a canonical that names this very document
 * under a different cache key ('variant'), which happens when a site writes a space as `+` where
 * its sitemap writes `%20`, or vice versa. Whether those two spellings are one resource is a fact
 * about the SITE's query parsing, not about the URLs — a form-decoding origin cannot tell them
 * apart, an RFC-3986 one can — so it is config, not a hardcoded assumption.
 *
 * `strict: false` (default) reproduces the historical reading exactly: a re-spelling counts as
 * self-canonical and gets its own target. `strict: true` calls it a duplicate key and reports
 * `canonical-variant`, so the plugin retires it instead of rendering the same bytes twice forever.
 *
 * Turn it on only for a site whose origin form-decodes its query. One request settles that for a
 * given parameter, for every URL: ask for a value containing a literal `+` (`?f=A%2BB`) and then
 * the same value with a raw `+` (`?f=A+B`). If the origin resolves the second as a SPACE — its
 * canonical comes back `A%20B`, or it simply serves what `A B` names — it form-decodes, and the
 * two spellings can never name different resources.
 */
export type CanonicalConfig = {
	/** Treat a re-spelled self-canonical as a duplicate cache key (non-indexable). Default false. */
	strict: boolean;
};

/**
 * The parts of the plugin's `cacheKey` policy that change WHICH URLS ARE THE SAME KEY, mirrored
 * here because the renderer must agree with the plugin about identity or it retires healthy URLs.
 *
 * Only these two. The plugin's `decodeReserved` deliberately has no twin: it changes the bytes of
 * a key, but the browser never builds one — it only compares two URLs it normalized itself
 * (`page.url()` vs the job URL for redirect detection; canonical vs `page.url()` for the
 * indexability verdict), and both sides of every comparison go through the same function. These
 * two are different: a job URL keyed under a folded (or slash-preserved) spelling gets compared
 * against a canonical spelled the plugin's way, so a renderer configured differently from the
 * plugin reads healthy pages as canonicalizing elsewhere and reports them non-indexable.
 *
 * Keep both in step with the plugin's config, and deploy the two together.
 */
export type CacheKeyConfig = {
	/** Fold `%20` to `+` in the query (plugin: `cacheKey.plusIsSpace`). Default false. */
	plusIsSpace: boolean;
	/** Whether `/a/` and `/a` are one key (plugin: `cacheKey.trailingSlash`). Default 'strip'. */
	trailingSlash: 'strip' | 'preserve';
};

/**
 * Reuse of the main document across the device variants of one job — see `src/documentReuse.ts`
 * for the whole argument. OFF by default: only the operator can say a site is responsive rather
 * than adaptive, and replaying desktop markup into a mobile render of an adaptive site caches a page
 * no mobile visitor is served.
 */
export type DocumentReuseConfig = {
	/** Answer the second and later variants' navigation from the first variant's document. */
	enabled: boolean;
	/**
	 * Every Nth multi-device job fetches its second variant normally and reports how much that
	 * document differs, structurally, from the one the first variant captured — the running proof
	 * that the site is still responsive. 0 disables sampling. Observability only: a divergent sample
	 * is logged and counted, never used to switch reuse off (a deploy in progress would trip it).
	 */
	sampleEvery: number;
	prefetch: DocumentPrefetchConfig;
	cookies: DocumentCookieConfig;
};

/**
 * Which cookies a document may carry across the variants of one job — see `src/documentReuse.ts`.
 */
export type DocumentCookieConfig = {
	/**
	 * Cookie NAMES that may cross, and that a variant fetching its own document will send. Empty by
	 * default, so nothing crosses.
	 *
	 * This exists for one thing: a cookie that selects WHICH BACKEND serves the page's API calls.
	 * Without it in the list, the device that fetched the document and the device that replayed it
	 * render against different backends, and one URL's two snapshots stop being comparable. Name
	 * those cookies and nothing else — never a session, cart, visitor or bot-manager cookie, which
	 * tie a render to an identity that must not be shared between two devices.
	 */
	pin: string[];
};

/**
 * Fetching a job's document in the worker AHEAD of its render — see `src/documentPrefetch.ts`. Works
 * on its own (a single-device job's document, fetched while an earlier job renders) and with
 * `documentReuse.enabled` (the prefetched document is then also what the other devices replay).
 */
export type DocumentPrefetchConfig = {
	enabled: boolean;
	/**
	 * Claimed jobs held prefetching ahead of the render slots — the pipeline depth, and the most
	 * prefetched documents in memory at once. To hide a fetch of `f` seconds behind renders of `r`
	 * seconds on `c` slots, a slot frees every `r / c` seconds, so `depth ≥ f · c / r + 1` keeps a
	 * document ready; 2 covers c=10, f=1 s, r=12 s. A pooled job sits claimed for about
	 * `depth · r / c` seconds before its render starts.
	 */
	depth: number;
	/**
	 * Ceiling the pool may grow to on its own. The point of prefetching is that the next render finds
	 * its document already in hand, so when one does NOT — the navigation waited out its grace and
	 * went to the origin — the pool deepens by one, up to here, and stays there. `depth` is the floor
	 * it starts from; this is how far it may go looking for "enough".
	 *
	 * It is a ceiling because depth is not free: every pooled job is CLAIMED but not yet rendered, so
	 * it holds a lease and a document in memory for roughly `depth · renderTime / concurrency`.
	 */
	maxDepth: number;
	/** Give up on a prefetch after this long; the variant then fetches the document itself. */
	timeoutMs: number;
};

export type PrerenderConfig = {
	/** Device profiles keyed by the job's `deviceType`; unknown types fall back to `defaultDevice`. */
	devices: Record<string, DeviceProfile>;
	defaultDevice: string;
	block: BlockConfig;
	navigation: NavigationConfig;
	scroll: ScrollConfig;
	postProcess: PostProcessConfig;
	canonical: CanonicalConfig;
	cacheKey: CacheKeyConfig;
	/**
	 * Optional declarative "wait for content" rules applied after scroll/settle and before the
	 * snapshot (see {@link WaitForRule}). Absent by default → a complete no-op, so existing
	 * deployments render byte-identically; present → both `renderOnce` and the fleet honor it.
	 */
	waitFor?: WaitForRule[];
	/** Inject Web Components (ShadyDOM/ShadyCSS) polyfill-forcing flags before load. */
	injectWebComponentsPolyfill: boolean;
	/** Extra request headers added to the navigation request (besides the bypass token and job headers). */
	extraHeaders: Record<string, string>;
	documentReuse: DocumentReuseConfig;
	/**
	 * Scoped config overrides, applied per render (see {@link ConfigOverride}). Absent by default →
	 * a complete no-op, so an unconfigured deployment resolves the base config by identity.
	 */
	overrides?: ConfigOverride[];
};

/**
 * A config patch that applies only to the renders it matches.
 *
 * The settle knobs are the reason this exists. `navigation.*` and `scroll.*` were global — ONE
 * setting for a home page, a category listing and a product page alike — while the only thing that
 * could be scoped was a `waitFor` rule. That is backwards: how long a page needs to settle, and what
 * it is even waiting for, is the most page-type-dependent thing the renderer does. A settle sized
 * for the page that needs the most is waste on every other page, and settle is ~78% of render time.
 *
 * Nothing here is settle-specific though, and that is deliberate: the defaults are opinionated, and
 * an opinion that cannot be overridden per route eventually becomes a reason to fork the renderer.
 * Anything read per render can be scoped — see `UNSCOPABLE` for the two blocks that cannot, and why.
 *
 * Matching is `pathPattern` AND `devices`; an omitted field matches everything. Scoping is on the
 * URL PATH, never on a declared page type — rule scopes AND together and no job carries a page type,
 * so a page-type scope would match nothing at all.
 *
 * Overrides apply IN ARRAY ORDER, each deep-merged over the result so far, so the last one that
 * matches wins a contested key. No specificity ranking: the order you wrote is the order you get.
 */
export type ConfigOverride = {
	/** Required. Names the override in the render result, and makes a never-matching rule visible. */
	name: string;
	/** JavaScript regex tested against the URL's path (e.g. `'^/product/'`). Omit → every path. */
	pathPattern?: string;
	/** Device types this applies to, matched against the job's `deviceType`. Omit → every device. */
	devices?: string[];
	/** The patch, deep-merged over the config resolved so far. */
	config: DeepPartial<PrerenderConfig>;
};

// Built-in defaults — these reproduce the renderer's original hardcoded behavior, so
// an unconfigured deployment renders exactly as before. Everything is overridable.
export const defaultConfig = (): PrerenderConfig => ({
	devices: {
		desktop: { viewport: { width: 1920, height: 5000 } },
		mobile: { userAgent: KnownDevices['iPhone 15'].userAgent, viewport: { width: 390, height: 844 } },
		tablet: { userAgent: KnownDevices['iPad'].userAgent, viewport: { width: 768, height: 1024 } },
	},
	defaultDevice: 'desktop',
	block: { resourceTypes: ['image', 'media', 'font'], urlPatterns: [], stubImages: false },
	navigation: {
		waitUntil: 'domcontentloaded',
		renderBudgetMs: 20000,
		navigationTimeoutMs: 0,
		networkIdleMs: 300,
		networkIdleTimeoutMs: 1000,
		domStableMs: 0,
		domStableTimeoutMs: 8000,
		domStablePollMs: 250,
		domStableTolerance: 8,
		finalDomStable: false,
		skipSettleWhenNonIndexable: false,
	},
	scroll: {
		enabled: true,
		stepMs: 200,
		stepFraction: 0.5,
		settleUntilStable: false,
		settleStablePasses: 2,
		topSettleMs: 300,
	},
	postProcess: {
		stripScripts: true,
		inlineEmptyStyleSheets: true,
		minifyInlineCss: false,
		pruneUnmatchedCss: false,
		removeSelectors: ['link[rel=import]', 'link[as=script]', 'script#__NEXT_DATA__'],
		flattenShadowDom: false,
		stripBlockedResources: false,
		resolveLazyImages: false,
		removeAttributes: [],
	},
	canonical: { strict: false },
	cacheKey: { plusIsSpace: false, trailingSlash: 'strip' },
	injectWebComponentsPolyfill: true,
	extraHeaders: {},
	documentReuse: {
		enabled: false,
		sampleEvery: 0,
		prefetch: { enabled: false, depth: 2, maxDepth: 8, timeoutMs: 8000 },
		cookies: { pin: [] },
	},
});

/** setTimeout's delay ceiling: past this a timer fires at once instead of late. */
const MAX_TIMER_MS = 2147483647;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

// Deep-merge `source` over `target`: nested objects recurse, arrays and scalars
// replace wholesale, and keys absent from the defaults are still added (so new
// device profiles / headers can be introduced).
const deepMerge = <T>(target: T, source: unknown): T => {
	if (!isPlainObject(source)) return target;
	const merged: Record<string, unknown> = { ...(target as Record<string, unknown>) };
	for (const key of Object.keys(source)) {
		const sourceValue = source[key];
		const targetValue = merged[key];
		merged[key] =
			isPlainObject(sourceValue) && isPlainObject(targetValue) ? deepMerge(targetValue, sourceValue) : sourceValue;
	}
	return merged as T;
};

const validate = (config: PrerenderConfig): PrerenderConfig => {
	// Every check below reaches straight into a config block, and a JSON-/API-supplied config can
	// null one out wholesale — `deepMerge` REPLACES a non-plain-object rather than merging into it,
	// so `{ postProcess: null }` survives to here intact. Assert the blocks are objects once, up
	// front, so that surfaces as a named config error rather than as a TypeError from whichever
	// check happened to touch the block first.
	for (const name of [
		'devices',
		'navigation',
		'scroll',
		'block',
		'postProcess',
		'canonical',
		'documentReuse',
	] as const) {
		const block: unknown = config[name];
		if (!block || typeof block !== 'object' || Array.isArray(block)) {
			throw new Error(`prerender config: \`${name}\` must be an object`);
		}
	}
	const devices = Object.keys(config.devices);
	if (devices.length === 0) {
		throw new Error('prerender config: `devices` must define at least one device profile');
	}
	if (!config.devices[config.defaultDevice]) {
		throw new Error(`prerender config: defaultDevice "${config.defaultDevice}" is not present in devices`);
	}
	for (const [name, profile] of Object.entries(config.devices)) {
		const viewport = profile?.viewport;
		if (!viewport || typeof viewport.width !== 'number' || typeof viewport.height !== 'number') {
			throw new Error(`prerender config: device "${name}" requires a viewport with numeric width and height`);
		}
	}
	for (const field of [
		'renderBudgetMs',
		'networkIdleMs',
		'networkIdleTimeoutMs',
		'domStableTimeoutMs',
		'domStablePollMs',
	] as const) {
		if (typeof config.navigation[field] !== 'number' || config.navigation[field] <= 0) {
			throw new Error(`prerender config: navigation.${field} must be a positive number`);
		}
	}
	// domStableMs may be 0 (disabled), domStableTolerance 0 (exact match), and
	// navigationTimeoutMs 0 (no navigation sub-cap), so these only have to be non-negative.
	for (const field of ['domStableMs', 'domStableTolerance', 'navigationTimeoutMs'] as const) {
		if (typeof config.navigation[field] !== 'number' || config.navigation[field] < 0) {
			throw new Error(`prerender config: navigation.${field} must be a non-negative number`);
		}
	}
	for (const field of ['finalDomStable', 'skipSettleWhenNonIndexable'] as const) {
		if (typeof config.navigation[field] !== 'boolean') {
			throw new Error(`prerender config: navigation.${field} must be a boolean`);
		}
	}
	if (typeof config.documentReuse.enabled !== 'boolean') {
		throw new Error('prerender config: documentReuse.enabled must be a boolean');
	}
	if (!Number.isInteger(config.documentReuse.sampleEvery) || config.documentReuse.sampleEvery < 0) {
		throw new Error('prerender config: documentReuse.sampleEvery must be a non-negative integer (0 = no sampling)');
	}
	const prefetch: unknown = config.documentReuse.prefetch;
	if (!isPlainObject(prefetch)) {
		throw new Error('prerender config: documentReuse.prefetch must be an object');
	}
	if (typeof prefetch.enabled !== 'boolean') {
		throw new Error('prerender config: documentReuse.prefetch.enabled must be a boolean');
	}
	if (!Number.isInteger(prefetch.depth) || (prefetch.depth as number) < 1) {
		throw new Error('prerender config: documentReuse.prefetch.depth must be a positive integer');
	}
	if (!Number.isInteger(prefetch.maxDepth) || (prefetch.maxDepth as number) < (prefetch.depth as number)) {
		throw new Error('prerender config: documentReuse.prefetch.maxDepth must be an integer >= depth');
	}
	const cookies: unknown = config.documentReuse.cookies;
	if (!isPlainObject(cookies)) {
		throw new Error('prerender config: documentReuse.cookies must be an object');
	}
	if (!Array.isArray(cookies.pin) || cookies.pin.some((name) => typeof name !== 'string' || !name.trim())) {
		throw new Error('prerender config: documentReuse.cookies.pin must be an array of non-empty cookie names');
	}
	// Bounded by setTimeout's signed-32-bit delay: a larger value does not mean "no timeout", it fires
	// the timer IMMEDIATELY (after 1ms, with a TimeoutOverflowWarning), so every prefetch would abort
	// the instant it started and fall through to a normal fetch — the feature silently off, under a
	// config that reads as generous. Refused at load rather than degraded at runtime.
	if (typeof prefetch.timeoutMs !== 'number' || !(prefetch.timeoutMs > 0) || prefetch.timeoutMs > MAX_TIMER_MS) {
		throw new Error(
			`prerender config: documentReuse.prefetch.timeoutMs must be a positive number of ms, at most ${MAX_TIMER_MS}`
		);
	}
	// Scroll step is a positive fraction of the viewport; reject non-numbers / non-positive
	// (config is API- and JSON-supplied). scrollPass additionally floors pathologically small
	// positive values in-page.
	if (typeof config.scroll.stepFraction !== 'number' || config.scroll.stepFraction <= 0) {
		throw new Error('prerender config: scroll.stepFraction must be a positive number');
	}
	// The rest of the settle dwells. These went unchecked while they were global and set once by
	// hand; scoped overrides make them per-route surface that a config author edits far more often,
	// and a negative dwell is the kind of value that produces a fast render with missing content
	// rather than an error.
	for (const field of ['stepMs', 'topSettleMs'] as const) {
		const v = config.scroll[field];
		// Capped at the timer ceiling for the same reason `prefetch.timeoutMs` is: past it,
		// `setTimeout` fires after 1ms instead of late, so an over-large dwell silently becomes NO
		// dwell — a fast render with missing content, which is the failure mode this whole config
		// surface is trying to make impossible to reach by accident.
		if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_TIMER_MS) {
			throw new Error(`prerender config: scroll.${field} must be a non-negative number of ms, at most ${MAX_TIMER_MS}`);
		}
	}
	if (!Number.isInteger(config.scroll.settleStablePasses) || config.scroll.settleStablePasses < 1) {
		throw new Error('prerender config: scroll.settleStablePasses must be a positive integer');
	}
	for (const field of ['enabled', 'settleUntilStable'] as const) {
		if (typeof config.scroll[field] !== 'boolean') {
			throw new Error(`prerender config: scroll.${field} must be a boolean`);
		}
	}
	// Pruning unmatched CSS is only sound against a DOM nothing can still change. `stripScripts`
	// is what guarantees that, so refuse the combination rather than quietly emitting a snapshot
	// whose CSS assumes an inert page while its scripts are still there to un-inert it.
	if (config.postProcess.pruneUnmatchedCss && !config.postProcess.stripScripts) {
		throw new Error(
			'prerender config: postProcess.pruneUnmatchedCss requires postProcess.stripScripts — ' +
				'a rule that matches nothing today can match again once a script runs'
		);
	}
	// removeAttributes is API-/JSON-supplied and runs as a raw selector + attribute-name loop
	// inside the page, so reject malformed rules here rather than silently dropping them there.
	if (!Array.isArray(config.postProcess.removeAttributes)) {
		throw new Error('prerender config: postProcess.removeAttributes must be an array of rules');
	}
	config.postProcess.removeAttributes.forEach((rule, i) => {
		if (!rule || typeof rule.selector !== 'string' || rule.selector.trim() === '') {
			throw new Error(`prerender config: postProcess.removeAttributes[${i}].selector must be a non-empty string`);
		}
		if (
			!Array.isArray(rule.attributes) ||
			rule.attributes.length === 0 ||
			rule.attributes.some((name) => typeof name !== 'string' || name.trim() === '')
		) {
			throw new Error(
				`prerender config: postProcess.removeAttributes[${i}].attributes must be a non-empty array of attribute names`
			);
		}
	});
	// waitFor is optional; when present every rule needs a non-empty selector and non-negative
	// numeric fields (it is API-/JSON-supplied, so validate before it reaches the in-page waits).
	if (config.waitFor !== undefined) {
		if (!Array.isArray(config.waitFor)) {
			throw new Error('prerender config: waitFor must be an array of rules');
		}
		config.waitFor.forEach((rule, i) => {
			if (!rule || typeof rule.selector !== 'string' || rule.selector.trim() === '') {
				throw new Error(`prerender config: waitFor[${i}].selector must be a non-empty string`);
			}
			if (
				rule.waitForSelector !== undefined &&
				(typeof rule.waitForSelector !== 'string' || rule.waitForSelector.trim() === '')
			) {
				throw new Error(`prerender config: waitFor[${i}].waitForSelector must be a non-empty string`);
			}
			for (const field of ['minCount', 'stableMs', 'timeoutMs'] as const) {
				const v = rule[field];
				if (v !== undefined && (typeof v !== 'number' || v < 0)) {
					throw new Error(`prerender config: waitFor[${i}].${field} must be a non-negative number`);
				}
			}
			if (
				rule.devices !== undefined &&
				(!Array.isArray(rule.devices) || rule.devices.some((d) => typeof d !== 'string' || d.trim() === ''))
			) {
				throw new Error(`prerender config: waitFor[${i}].devices must be an array of non-empty device names`);
			}
			// A `pageTypes` scope silently matches NOTHING: rule scopes AND together and no job carries
			// a declared page type, so such a rule never runs and the widget it was written to wait for
			// is quietly absent from every snapshot. Named page types were abandoned deliberately.
			// Failing loudly at config load is the only way this is ever noticed.
			if ('pageTypes' in (rule as Record<string, unknown>)) {
				throw new Error(
					`prerender config: waitFor[${i}] uses \`pageTypes\`, which no job ever carries, so the rule ` +
						'would match nothing and the content it guards would be missing from every render. Scope it ' +
						'with `pathPattern` instead.'
				);
			}
			if (rule.pathPattern !== undefined) {
				if (typeof rule.pathPattern !== 'string' || rule.pathPattern.trim() === '') {
					throw new Error(`prerender config: waitFor[${i}].pathPattern must be a non-empty string`);
				}
				try {
					new RegExp(rule.pathPattern);
				} catch (err) {
					throw new Error(
						`prerender config: waitFor[${i}].pathPattern is not a valid regex: ${(err as Error).message}`
					);
				}
			}
		});
	}
	validateOverrides(config);
	return config;
};

/** Config blocks a scoped override may not touch, and why. Both are decided ABOVE the level an
 *  override matches at, so accepting one would mean accepting a setting that silently does nothing
 *  — the same shape of landmine as a rule scope nothing can satisfy. */
const UNSCOPABLE: Record<string, string> = {
	overrides: 'overrides cannot nest',
	cacheKey:
		'cacheKey mirrors the URL-identity policy the plugin applies; the two must agree for every ' +
		'URL or healthy pages are retired as duplicates, so it cannot vary by route',
	documentReuse:
		'documentReuse is decided once per JOB, and a job spans device variants, so it is settled ' +
		'before any one variant device is known and a scoped value here would not be read',
};

const validateOverrides = (config: PrerenderConfig): void => {
	if (config.overrides === undefined) return;
	if (!Array.isArray(config.overrides)) {
		throw new Error('prerender config: overrides must be an array of scoped override rules');
	}
	const seen = new Set<string>();
	config.overrides.forEach((override, i) => {
		if (!isPlainObject(override)) {
			throw new Error(`prerender config: overrides[${i}] must be an object`);
		}
		// A name is mandatory: it is how an applied override is attributed in a render result and how
		// a rule that never matches anything is ever noticed.
		if (typeof override.name !== 'string' || override.name.trim() === '') {
			throw new Error(`prerender config: overrides[${i}].name must be a non-empty string`);
		}
		if (seen.has(override.name)) {
			throw new Error(`prerender config: overrides[${i}].name "${override.name}" is not unique`);
		}
		seen.add(override.name);
		if (override.devices !== undefined) {
			if (!Array.isArray(override.devices) || override.devices.some((d) => typeof d !== 'string' || d.trim() === ''))
				throw new Error(`prerender config: overrides[${i}].devices must be an array of non-empty device names`);
			// A device name that is not a real profile can never equal a job's deviceType, so the
			// override silently never applies — the same class of failure as a scope nothing can
			// satisfy, and a plain typo is all it takes.
			const known = Object.keys(config.devices);
			for (const d of override.devices) {
				if (!known.includes(d)) {
					throw new Error(
						`prerender config: overrides[${i}].devices names unknown device "${d}", so the override would ` +
							`never apply (known devices: ${known.join(', ')})`
					);
				}
			}
		}
		if (override.pathPattern !== undefined) {
			if (typeof override.pathPattern !== 'string' || override.pathPattern.trim() === '') {
				throw new Error(`prerender config: overrides[${i}].pathPattern must be a non-empty string`);
			}
			try {
				new RegExp(override.pathPattern);
			} catch (err) {
				throw new Error(
					`prerender config: overrides[${i}].pathPattern is not a valid regex: ${(err as Error).message}`
				);
			}
		}
		if (!isPlainObject(override.config)) {
			throw new Error(`prerender config: overrides[${i}].config must be an object`);
		}
		for (const [key, why] of Object.entries(UNSCOPABLE)) {
			if (key in override.config) {
				throw new Error(`prerender config: overrides[${i}].config may not set "${key}" — ${why}`);
			}
		}
		// Validate the PATCH APPLIED, not the patch alone: a bad value only shows up once it has
		// replaced the default it overrides. Each override is checked on its own against the base —
		// combinations are not enumerated, which is a deliberate limit, but every value that can
		// reach a render has been through the same checks the base config was.
		const base = { ...config, overrides: undefined } as PrerenderConfig;
		try {
			validate(deepMerge(base, override.config));
		} catch (err) {
			throw new Error(
				`prerender config: overrides[${i}] ("${override.name}") is invalid once applied — ${(err as Error).message}`
			);
		}
	});
};

// Recursively-optional version of a type, with arrays kept whole. Lets callers pass
// any nested subset of the config (e.g. `{ navigation: { waitUntil: 'networkidle2' } }`).
export type DeepPartial<T> = T extends (infer _U)[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

/**
 * Deep-merge a partial rendering config over the built-in defaults and validate it.
 * `mergeConfig()` (no argument) returns the validated defaults.
 */
export const mergeConfig = (overrides: DeepPartial<PrerenderConfig> = {}): PrerenderConfig =>
	validate(deepMerge(defaultConfig(), overrides));

/** What `resolveConfigForJob` resolved, and which overrides got it there. */
export type ResolvedConfig = {
	config: PrerenderConfig;
	/** Names of the overrides applied, in the order they were applied. Empty → the base config. */
	applied: string[];
};

// Resolved configs are cached by the SIGNATURE of what produced them (device + the ordered list of
// matching override names), not by URL: every product page resolves the same config, so the cache
// holds one entry per distinct combination rather than one per URL. Bounded by construction — the
// number of combinations is a property of the config, not of the corpus.
const resolvedCache = new Map<string, PrerenderConfig>();
let resolvedCacheFor: ConfigOverride[] | undefined;

/**
 * The effective config for one render. Matches `config.overrides` against this job's URL path and
 * device type and deep-merges the matches, in order, over the base.
 *
 * Identity when nothing matches (and when no overrides are configured at all), so a deployment that
 * does not use them pays nothing and renders byte-identically.
 */
export const resolveConfigForJob = (
	config: PrerenderConfig,
	{ url, deviceType }: { url: string; deviceType: string }
): ResolvedConfig => {
	const overrides = config.overrides;
	if (!overrides?.length) return { config, applied: [] };

	// The cache is keyed by name-signature, so it must be dropped when the config itself is replaced
	// (a live config reload). Identity of the overrides array is the cheapest correct witness.
	if (resolvedCacheFor !== overrides) {
		resolvedCache.clear();
		resolvedCacheFor = overrides;
	}

	let path = '';
	try {
		path = new URL(url).pathname;
	} catch {
		/* an unparseable URL matches only the unscoped overrides, which is the conservative read */
	}

	const applied: string[] = [];
	for (const override of overrides) {
		if (override.devices && !override.devices.includes(deviceType)) continue;
		if (override.pathPattern && !new RegExp(override.pathPattern).test(path)) continue;
		applied.push(override.name);
	}
	if (!applied.length) return { config, applied };

	const key = `${deviceType}\u0000${applied.join('\u0000')}`;
	let resolved = resolvedCache.get(key);
	if (!resolved) {
		const names = new Set(applied);
		resolved = overrides.reduce(
			(acc, override) => (names.has(override.name) ? deepMerge(acc, override.config) : acc),
			config
		);
		resolvedCache.set(key, resolved);
	}
	return { config: resolved, applied };
};

/**
 * Load and validate a rendering config from a JSON file, deep-merged over the
 * defaults. Throws a descriptive error on a missing/invalid file or invalid config.
 */
export const loadConfig = (configPath?: string): PrerenderConfig => {
	if (!configPath) return mergeConfig();

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(resolvePath(configPath), 'utf8'));
	} catch (err) {
		throw new Error(`Failed to read prerender config at "${configPath}": ${(err as Error).message}`, { cause: err });
	}
	if (!isPlainObject(parsed)) {
		throw new Error(`Prerender config at "${configPath}" must be a JSON object`);
	}

	return mergeConfig(parsed);
};
