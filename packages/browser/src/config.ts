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
};

export type ScrollConfig = {
	/** Scroll to the bottom to trigger lazy-loaded content before serializing. */
	enabled: boolean;
	/** Delay between scroll steps (ms). */
	stepMs: number;
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
};

export type PrerenderConfig = {
	/** Device profiles keyed by the job's `deviceType`; unknown types fall back to `defaultDevice`. */
	devices: Record<string, DeviceProfile>;
	defaultDevice: string;
	block: BlockConfig;
	navigation: NavigationConfig;
	scroll: ScrollConfig;
	postProcess: PostProcessConfig;
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
		networkIdleMs: 300,
		networkIdleTimeoutMs: 1000,
		domStableMs: 0,
		domStableTimeoutMs: 8000,
		domStablePollMs: 250,
		domStableTolerance: 8,
	},
	scroll: { enabled: true, stepMs: 200, settleUntilStable: false, settleStablePasses: 2 },
	postProcess: {
		stripScripts: true,
		inlineEmptyStyleSheets: true,
		removeSelectors: ['link[rel=import]', 'link[as=script]', 'script#__NEXT_DATA__'],
		flattenShadowDom: false,
		stripBlockedResources: false,
		resolveLazyImages: false,
	},
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
	// domStableMs may be 0 (disabled) and domStableTolerance 0 (exact match), so these
	// only have to be non-negative numbers.
	for (const field of ['domStableMs', 'domStableTolerance'] as const) {
		if (typeof config.navigation[field] !== 'number' || config.navigation[field] < 0) {
			throw new Error(`prerender config: navigation.${field} must be a non-negative number`);
		}
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
