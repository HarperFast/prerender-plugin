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
};

export type ScrollConfig = {
	/** Scroll to the bottom to trigger lazy-loaded content before serializing. */
	enabled: boolean;
	/** Delay between scroll steps (ms). */
	stepMs: number;
};

export type PostProcessConfig = {
	/** Remove executable `<script>` tags (data scripts like application/ld+json are kept). */
	stripScripts: boolean;
	/** Inline the text of empty (CSSOM-injected) stylesheets so styles survive serialization. */
	inlineEmptyStyleSheets: boolean;
	/** Extra CSS selectors whose matching elements are removed before serialization. */
	removeSelectors: string[];
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
	block: { resourceTypes: ['image', 'media', 'font'], urlPatterns: [] },
	navigation: { waitUntil: 'domcontentloaded', renderBudgetMs: 20000, networkIdleMs: 300, networkIdleTimeoutMs: 1000 },
	scroll: { enabled: true, stepMs: 200 },
	postProcess: {
		stripScripts: true,
		inlineEmptyStyleSheets: true,
		removeSelectors: ['link[rel=import]', 'link[as=script]', 'script#__NEXT_DATA__'],
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
	for (const field of ['renderBudgetMs', 'networkIdleMs', 'networkIdleTimeoutMs'] as const) {
		if (typeof config.navigation[field] !== 'number' || config.navigation[field] <= 0) {
			throw new Error(`prerender config: navigation.${field} must be a positive number`);
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
