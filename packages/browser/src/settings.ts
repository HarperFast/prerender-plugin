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
	/**
	 * Per-browser DNS overrides: a map of hostname → IP that composes Chrome's
	 * `--host-resolver-rules` flag (`MAP <host> <ip>`), appended to `chromeArgs`. Chrome
	 * connects to the given IP but keeps the original Host header and TLS SNI, so the
	 * certificate still validates — the mechanism for pointing renders at an Akamai
	 * staging edge (or any alternate origin) without touching `/etc/hosts`. Ignored when
	 * `browserLaunchOptions` is supplied (that fully owns the launch args). Default none.
	 */
	hostResolverRules?: Record<string, string>;
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
	hostResolverRules: Record<string, string>;
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

/**
 * Compose Chrome's `--host-resolver-rules` flag from a hostname → IP map, or return
 * null when there are no (valid) rules. Entries with an empty host or IP are dropped.
 * Multiple rules are comma-joined, e.g. `--host-resolver-rules=MAP a 1.1.1.1,MAP b 2.2.2.2`.
 *
 * Values are trimmed and must not contain whitespace or commas — those are the flag's
 * own separators, so a stray one would silently corrupt the grammar (e.g. an IP of
 * `1.1.1.1,MAP * 2.2.2.2` injects a second wildcard rule remapping every host). A bad
 * entry throws at resolve time (startup) rather than mis-pointing renders. Legitimate
 * values — wildcards (`*.example.com`), `host:port`, IPv6 literals — contain neither.
 */
export const composeHostResolverRulesArg = (rules?: Record<string, string>): string | null => {
	const maps: string[] = [];
	for (const [rawHost, rawIp] of Object.entries(rules ?? {})) {
		const host = rawHost.trim();
		const ip = (rawIp ?? '').trim();
		if (!host || !ip) continue; // unset entry — skip
		if (/[\s,]/.test(host) || /[\s,]/.test(ip)) {
			throw new Error(
				`hostResolverRules: entry "${host}" → "${ip}" is invalid — host and IP must not contain whitespace or commas`
			);
		}
		maps.push(`MAP ${host} ${ip}`);
	}
	return maps.length ? `--host-resolver-rules=${maps.join(',')}` : null;
};

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
	hostResolverRules: {},
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
	// Append the composed --host-resolver-rules flag onto the base args (custom or default)
	// so a host→IP override doesn't require re-declaring the hardened default flag set.
	fresh.hostResolverRules = { ...(options.hostResolverRules ?? {}) };
	const baseChromeArgs = options.chromeArgs ?? DEFAULT_CHROME_ARGS;
	const hostResolverArg = composeHostResolverRulesArg(fresh.hostResolverRules);
	fresh.chromeArgs = hostResolverArg ? [...baseChromeArgs, hostResolverArg] : [...baseChromeArgs];
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
