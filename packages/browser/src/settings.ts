/**
 * Runtime settings for the prerender browser — the single configuration surface.
 *
 * The package reads NO environment variables; everything is supplied as JS options
 * to `startWorker(options)` (see index.ts), which calls `applySettings()` to resolve
 * them over the built-in defaults into the live `settings` object that the rest of
 * the modules read lazily. Consumers (e.g. a render-service deployment) source these
 * however they like — env, file, hardcoded — and pass them in.
 */

import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchOptions } from 'puppeteer';
import { loadConfig, mergeConfig } from './config.js';
import type { DeepPartial, PrerenderConfig } from './config.js';

export type ResourceCacheOptions = {
	/** Disable the on-disk resource cache entirely. */
	enabled?: boolean;
	dir?: string;
	maxEntryBytes?: number;
	maxTotalBytes?: number;
	maxTtlMs?: number;
	/** Cache responses marked `cache-control: private` (a dedicated renderer is the end user). */
	allowPrivate?: boolean;
};

export type BrowserOptions = {
	/** Harper connection + identity (required). */
	harper: {
		mqttOrigin: string;
		user: string;
		pass: string;
		workerId: string;
	};
	/** Port the render-queue HTTP API is served on (default 9926). */
	queuePort?: number;
	/** Shared origin-bypass header/token — must match the plugin's `securityToken`. */
	bypass?: { header?: string; token?: string };
	/** Rendering config: a (deep) partial object merged over defaults, or a path to a JSON file. */
	config?: DeepPartial<PrerenderConfig> | string;
	/** Max concurrent page renders (default: ~half the CPUs). */
	concurrency?: number;
	/** Max render starts per second (default 8). */
	rps?: number;
	/** Jobs claimed per batch (default: concurrency * 2). */
	jobClaimLimit?: number;
	/** Pages a browser renders before being retired and replaced (default 200). */
	browserExpirationThreshold?: number;
	/** Render each page in a fresh incognito context (default true). */
	incognitoPages?: boolean;
	/** Encoding used when posting rendered HTML back (default 'gzip'). */
	contentEncoding?: string;
	/** Chrome launch flags (default: a hardened headless set). */
	chromeArgs?: string[];
	/** Full Puppeteer launch options — overrides the default built from `chromeArgs`. */
	browserLaunchOptions?: LaunchOptions;
	/** On-disk shared sub-resource (script/stylesheet) cache. */
	resourceCache?: ResourceCacheOptions;
};

export type ResolvedResourceCache = {
	enabled: boolean;
	dir: string;
	maxEntryBytes: number;
	maxTotalBytes: number;
	maxTtlMs: number;
	allowPrivateResponses: boolean;
};

export type Settings = {
	harper: { mqttOrigin: string; user: string; pass: string; workerId: string };
	queuePort: number;
	bypass: { header: string; token: string };
	config: PrerenderConfig;
	concurrency: number;
	rps: number;
	jobClaimLimit: number;
	browserExpirationThreshold: number;
	incognitoPages: boolean;
	contentEncoding: string;
	chromeArgs: string[];
	browserLaunchOptions?: LaunchOptions;
	resourceCache: ResolvedResourceCache;
};

const DEFAULT_CHROME_ARGS = [
	'--no-sandbox',
	'--disable-setuid-sandbox',
	'--disable-renderer-backgrounding',
	'--disable-background-timer-throttling',
	'--disable-features=BackForwardCache',
	'--disable-gpu',
	'--disable-software-rasterizer',
	'--disk-cache-size=1073741824',
	'--media-cache-size=268435456',
	'--renderer-process-limit=64',
	'--no-first-run',
	'--no-default-browser-check',
	'--js-flags=--max-old-space-size=768',
];

const defaultConcurrency = () => Math.max(1, Math.floor((cpus().length - 3) / 2));

const defaults = (): Settings => ({
	harper: { mqttOrigin: '', user: '', pass: '', workerId: '' },
	queuePort: 9926,
	bypass: { header: 'x-harper-renderer-bypass', token: '' },
	config: mergeConfig(),
	concurrency: defaultConcurrency(),
	rps: 8,
	jobClaimLimit: 0, // resolved from concurrency in applySettings
	browserExpirationThreshold: 200,
	incognitoPages: true,
	contentEncoding: 'gzip',
	chromeArgs: DEFAULT_CHROME_ARGS,
	browserLaunchOptions: undefined,
	resourceCache: {
		enabled: true,
		dir: join(tmpdir(), 'render-service-cache'),
		maxEntryBytes: 20 * 1024 * 1024,
		maxTotalBytes: 8 * 1024 * 1024 * 1024,
		maxTtlMs: 30 * 24 * 60 * 60 * 1000,
		allowPrivateResponses: true,
	},
});

// The live settings (stable reference; mutated in place by applySettings so existing
// `import { settings }` references keep seeing the resolved values).
export const settings: Settings = defaults();

/**
 * Resolve `options` over the defaults into the live `settings` and return it. Throws
 * if a required Harper connection field is missing. Safe to call once at startup.
 */
export const applySettings = (options: BrowserOptions): Settings => {
	if (!options || typeof options !== 'object') {
		throw new Error('startWorker: an options object is required');
	}
	const harper = options.harper;
	for (const field of ['mqttOrigin', 'user', 'pass', 'workerId'] as const) {
		if (!harper?.[field]) throw new Error(`startWorker: harper.${field} is required`);
	}

	const fresh = defaults();
	fresh.harper = { ...harper };
	fresh.queuePort = options.queuePort ?? fresh.queuePort;
	fresh.bypass = {
		header: options.bypass?.header ?? fresh.bypass.header,
		token: options.bypass?.token ?? fresh.bypass.token,
	};
	fresh.config = typeof options.config === 'string' ? loadConfig(options.config) : mergeConfig(options.config ?? {});
	fresh.concurrency = options.concurrency ?? fresh.concurrency;
	fresh.rps = options.rps ?? fresh.rps;
	fresh.jobClaimLimit = options.jobClaimLimit ?? fresh.concurrency * 2;
	fresh.browserExpirationThreshold = options.browserExpirationThreshold ?? fresh.browserExpirationThreshold;
	fresh.incognitoPages = options.incognitoPages ?? fresh.incognitoPages;
	fresh.contentEncoding = options.contentEncoding ?? fresh.contentEncoding;
	fresh.chromeArgs = options.chromeArgs ?? fresh.chromeArgs;
	fresh.browserLaunchOptions = options.browserLaunchOptions;
	fresh.resourceCache = {
		enabled: options.resourceCache?.enabled ?? fresh.resourceCache.enabled,
		dir: options.resourceCache?.dir ?? fresh.resourceCache.dir,
		maxEntryBytes: options.resourceCache?.maxEntryBytes ?? fresh.resourceCache.maxEntryBytes,
		maxTotalBytes: options.resourceCache?.maxTotalBytes ?? fresh.resourceCache.maxTotalBytes,
		maxTtlMs: options.resourceCache?.maxTtlMs ?? fresh.resourceCache.maxTtlMs,
		allowPrivateResponses: options.resourceCache?.allowPrivate ?? fresh.resourceCache.allowPrivateResponses,
	};

	Object.assign(settings, fresh);
	return settings;
};
