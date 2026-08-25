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
});

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
	// Scroll step is a positive fraction of the viewport; reject non-numbers / non-positive
	// (config is API- and JSON-supplied). scrollPass additionally floors pathologically small
	// positive values in-page.
	if (typeof config.scroll.stepFraction !== 'number' || config.scroll.stepFraction <= 0) {
		throw new Error('prerender config: scroll.stepFraction must be a positive number');
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
	return config;
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
