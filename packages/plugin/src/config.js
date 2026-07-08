/**
 * Central, runtime-mutable configuration for the prerender plugin.
 *
 * `config` is pre-populated with defaults so every module can import it and read
 * values at request/timer time without waiting for setup. The plugin's
 * `handleApplication` (worker) calls `applyOptions()` with the host app's scoped
 * options (from `scope.options`) to override the defaults, and re-applies on every
 * `change` event for live reload.
 *
 * IMPORTANT: read `config.*` lazily (at request/timer time), not at module-load
 * time, so overrides applied during `handleApplication` take effect.
 */

import { isIP } from 'node:net';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Returns the Harper logger when running inside Harper, otherwise the console.
// Unit tests run outside Harper where `logger` is undefined.
export const getLogger = () => (typeof logger !== 'undefined' && logger ? logger : console);

// Database/table names are fixed (defined statically in src/schemas/schema.graphql).
// Tables are split across databases by write-transaction coupling so the hot queue
// (render_schedule) is isolated from target, page-cache, and sitemap writes.
const defaultConfig = () => ({
	// Requests whose path starts with this prefix are treated as bot prerender
	// requests (e.g. `/p/<absolute-url>`).
	botPathPrefix: '/p/',

	// Allowlist of hostnames considered indexable. Pages on other hosts are
	// rendered but never marked indexable/cached. Empty = allow all.
	domains: [],

	// Request-ingestion model.
	//   'prefix'    — native model: bot requests arrive at `${botPathPrefix}<absolute-url>`
	//                 and the device type comes from a header (`deviceTypeHeader`).
	//   'forwarded' — reverse-proxy / CDN model (e.g. Akamai): the proxy routes a
	//                 restricted set of paths to the plugin. The device type is the
	//                 first path segment, the target URL is reconstructed from the
	//                 forwarded host/proto headers, and `routes` both identifies which
	//                 requests are prerender requests and sets each route's query-param
	//                 allowlist.
	ingress: {
		mode: 'prefix', // 'prefix' | 'forwarded'
		// Where the device type comes from in forwarded mode: 'path' (first path
		// segment, consumed when it is a supported device type) or 'header'.
		deviceTypeSource: 'header',
		deviceTypeHeader: 'x-device-type',
		// Headers carrying the original public scheme/host (forwarded mode).
		forwardedHostHeader: 'x-forwarded-host',
		forwardedProtoHeader: 'x-forwarded-proto',
		defaultProtocol: 'https',
		// Ordered route list (forwarded mode). Each entry is
		// { match: 'exact' | 'prefix', path: string, queryParams: string[] }. A request
		// is a prerender request only if its device-stripped path matches a route; the
		// matched route's `queryParams` is the cache-key / origin-fetch query allowlist
		// (same semantics as `url.queryParams`: ['*'] keeps all, [] drops all).
		routes: [],
	},

	deviceTypes: {
		// Device types the service understands; unrecognized values fall back to the
		// first entry.
		supported: ['desktop', 'mobile', 'tablet'],
		// Device types scheduled for rendering when a page is auto-discovered.
		default: ['desktop', 'mobile'],
	},

	// Shape of the cache key. `attributes` are joined by `delimiter` in order.
	cacheKey: {
		delimiter: '|',
		attributes: ['url', 'deviceType'],
	},

	// URL normalization used to build the cache key. `queryParams` is an allowlist
	// of query parameters to retain (others are dropped; the remaining ones are
	// sorted for a stable key):
	//   ['page']  keep only `?page=` (default)
	//   ['*']     keep all query params
	//   []        drop all query params
	url: {
		queryParams: ['page'],
	},

	// Shared secret sent to the origin so it can distinguish the prerender service
	// (and bypass bot mitigation). Set the value per deployment — preferably via
	// `valueEnv` so the secret stays out of config.yaml.
	securityToken: {
		header: 'x-harper-renderer-bypass',
		value: '',
		// If set, the token is sourced from this environment variable at config-apply
		// time and takes precedence over `value` (keeps the secret out of config.yaml).
		valueEnv: '',
	},

	// When this request header is present, debug response headers are emitted.
	debugHeader: {
		key: 'x-harper-prerender-debug',
		value: 'true',
	},

	// Additional downstream request header names never forwarded to the origin, on
	// top of the always-ignored set (hop-by-hop headers plus host, user-agent,
	// accept-encoding, cookie, authorization, and the security-token/debug header
	// names). Matched case-insensitively.
	ignoredHeaders: [],

	// Staging passthrough — for verifying an origin against a staging edge (e.g. the
	// Akamai staging network). When `ip` is set, a cache-MISS origin fetch that carries
	// the `header` request header is connected to `ip` instead of the public origin. The
	// Host header and TLS SNI stay the real origin host (only the TCP address is pinned),
	// so the staging edge serves the right property and presents a valid certificate.
	//
	// The header is only a toggle: the connect address is always the configured `ip`, never
	// a value from the request, so a request can't repoint the fetch at an arbitrary host.
	// The cache key does not include the header, so cache HITS always return the normal
	// cached page regardless of it. Empty `ip` disables the feature — production is
	// unaffected unless a staging IP is explicitly configured.
	staging: {
		ip: '',
		header: 'x-harper-staging',
	},

	// On-demand render control. When enabled, an authorized GET bot request gets two
	// orthogonal levers (both ignored for unauthorized requests, so real crawler traffic
	// is unaffected):
	//   1. Cache freshness — a request `Cache-Control: no-cache`/`no-store` SKIPS the
	//      served cache (forces a miss).
	//   2. Miss behavior — the `missHeader` value picks what to do on a miss/skip:
	//      'prerender' (force an immediate one-off render and long-poll for the fresh
	//      result) or 'origin' (proxy the origin, same as a normal miss). Absent →
	//      `defaultMissMode`.
	// So `defaultMissMode: prerender` + no Cache-Control = "serve cache, else render now"
	// (warm-on-demand); adding `Cache-Control: no-cache` = "always render fresh now".
	//
	// Authorization is gated by `header` presence; when a `token` is set the header VALUE
	// must equal it. An empty token leaves it unauthenticated (any client sending the
	// header can force renders — a DoS vector), which is warned about at config-apply
	// time. `valueEnv` sources the token from an environment variable.
	renderNow: {
		enabled: false,
		header: 'x-harper-render-now', // authorizes the on-demand levers
		token: '',
		valueEnv: '',
		missHeader: 'x-harper-render-miss', // value: 'prerender' | 'origin'
		defaultMissMode: 'prerender', // miss behavior when missHeader is absent
		timeoutMs: 30 * SECOND, // give up waiting for the fresh render after this long
		pollIntervalMs: 250, // how often to re-check the cache for the fresh render
		// What to serve when a prerender doesn't land before `timeoutMs`:
		//   'origin' — proxy the origin (same as a normal cache miss)
		//   'stale'  — serve the existing cached page if any, else fall back to origin
		//   'error'  — respond 504
		fallback: 'origin',
	},

	page: {
		ttl: DAY, // default cached-page TTL
		minTtl: 6 * HOUR, // floor for sitemap-derived TTLs
		swrTtl: 3 * HOUR, // stale-while-revalidate window
	},

	render: {
		defaultInterval: DAY, // how often a target is re-rendered
		time: '07:00', // local time-of-day for the daily render run
		timezone: 'America/New_York',
	},

	sitemap: {
		refreshTime: '12:00', // local time-of-day for the daily sitemap refresh
		timezone: 'America/New_York',
		// Pin the periodic sitemap refresh to one node + worker. Empty `node`
		// disables the scheduled refresh entirely (manual refresh still works).
		node: '',
		workerIndex: 0,
	},

	queue: {
		jobLeaseTime: 10 * MINUTE, // how long a claimed job is leased before re-claim
		statusSyncInterval: MINUTE, // how often queue status is recomputed/broadcast
	},

	// Per-device-type User-Agent strings sent to the origin.
	userAgents: {
		mobile:
			'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/W.X.Y.Z Mobile Safari/537.36 HarperPrerender/1.0',
		tablet:
			'Mozilla/5.0 (Linux; Android 7.0; Pixel C Build/NRD90M; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/52.0.2743.98 Safari/537.36 HarperPrerender/1.0',
		desktop:
			'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/W.X.Y.Z Safari/537.36 HarperPrerender/1.0',
	},

	// Pages whose normalized URL contains any of these substrings are never
	// auto-scheduled for rendering.
	excludePathPatterns: ['/search/'],

	// Bot-request analytics. `bots` is the registry used both to label requests and
	// to choose which crawlers are tracked by name — remove an entry to stop tracking
	// that bot (its requests then bucket as 'other'). Each entry is { name, match },
	// where `match` is a case-insensitive substring of the User-Agent; longer matches
	// win over shorter ones (e.g. `googlebot-image` before `googlebot`).
	analytics: {
		enabled: true, // record bot_request analytics at all
		recordUnmatched: true, // record requests whose UA matched no configured bot (as 'other')
		bots: [
			{ name: 'Googlebot-Image', match: 'googlebot-image' },
			{ name: 'Googlebot-News', match: 'googlebot-news' },
			{ name: 'Googlebot-Video', match: 'googlebot-video' },
			{ name: 'Googlebot-Smartphone', match: 'googlebot-smartphone' },
			{ name: 'Google InspectionTool', match: 'google-inspectiontool' },
			{ name: 'GoogleOther', match: 'googleother' },
			{ name: 'AdsBot-Google', match: 'adsbot-google' },
			{ name: 'Googlebot', match: 'googlebot' },
			{ name: 'Bingbot', match: 'bingbot' },
			{ name: 'GPTBot', match: 'gptbot' },
			{ name: 'AhrefsBot', match: 'ahrefsbot' },
			{ name: 'SemrushBot', match: 'semrushbot' },
			{ name: 'Applebot', match: 'applebot' },
			{ name: 'YandexBot', match: 'yandexbot' },
			{ name: 'Baidu Spider', match: 'baiduspider' },
		],
	},
});

// The live config object. Mutated in place by applyOptions so existing imports
// keep their reference.
export const config = defaultConfig();

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Deep-merge `source` onto `target`, guided by the shape of `target` (the
 * defaults). Only keys that exist in the defaults are considered. Values must
 * match the default's type, otherwise the override is rejected with a warning and
 * the default is kept. Arrays are replaced wholesale (not merged element-wise).
 */
const mergeInto = (target, source, path = 'prerender') => {
	if (!isPlainObject(source)) return;

	for (const key of Object.keys(target)) {
		if (!(key in source)) continue;

		const defaultValue = target[key];
		const overrideValue = source[key];
		const keyPath = `${path}.${key}`;

		if (overrideValue === undefined || overrideValue === null) continue;

		if (Array.isArray(defaultValue)) {
			if (!Array.isArray(overrideValue)) {
				getLogger().warn?.(`[prerender] Ignoring ${keyPath}: expected an array`);
				continue;
			}
			target[key] = overrideValue.slice();
		} else if (isPlainObject(defaultValue)) {
			if (!isPlainObject(overrideValue)) {
				getLogger().warn?.(`[prerender] Ignoring ${keyPath}: expected an object`);
				continue;
			}
			mergeInto(defaultValue, overrideValue, keyPath);
		} else if (typeof defaultValue === typeof overrideValue) {
			target[key] = overrideValue;
		} else {
			getLogger().warn?.(
				`[prerender] Ignoring ${keyPath}: expected ${typeof defaultValue}, got ${typeof overrideValue}`
			);
		}
	}

	// Surface override keys that don't map to a known option — usually a typo.
	for (const key of Object.keys(source)) {
		// `package`/`files`/`runOnMainThread`/`timeout` are Harper component keys, not plugin options.
		if (
			key in target ||
			[
				'package',
				'files',
				'runOnMainThread',
				'timeout',
				'rest',
				'graphqlSchema',
				'jsResource',
				'pluginModule',
			].includes(key)
		) {
			continue;
		}
		if (path === 'prerender') getLogger().warn?.(`[prerender] Unknown configuration key: ${path}.${key}`);
	}
};

/**
 * Apply host-provided options onto the live `config`, with validation. Safe to
 * call repeatedly (e.g. on every options `change`). Resets to defaults first so
 * removed keys revert.
 */
export const applyOptions = (options) => {
	const fresh = defaultConfig();
	if (isPlainObject(options)) mergeInto(fresh, options);

	// Replace the contents of the live object in place to preserve the reference.
	for (const key of Object.keys(config)) delete config[key];
	Object.assign(config, fresh);

	resolveSecretsFromEnv();
	warnOnRiskyConfig();
	return config;
};

// Source the security token from an environment variable when `valueEnv` is set,
// so the shared secret never has to live in config.yaml. Runs after the merge so
// it overrides any literal `value`. (loadEnv populates process.env before the
// plugin applies options.)
const resolveSecretsFromEnv = () => {
	const { valueEnv } = config.securityToken;
	if (valueEnv && process.env[valueEnv]) {
		config.securityToken.value = process.env[valueEnv];
	}
	const renderNowEnv = config.renderNow.valueEnv;
	if (renderNowEnv && process.env[renderNowEnv]) {
		config.renderNow.token = process.env[renderNowEnv];
	}
};

const warnOnRiskyConfig = () => {
	const log = getLogger();
	if (!config.securityToken.value) {
		log.warn?.('[prerender] securityToken.value is empty — the origin cannot authenticate prerender requests');
	}
	if (config.domains.length === 0) {
		log.warn?.('[prerender] domains allowlist is empty — all hosts will be treated as indexable');
	}
	if (config.staging.ip) {
		// Mirror stagingTargetIp's gate (ip AND header AND valid ip) so the warning never
		// claims the feature is on when it is actually disabled.
		if (!config.staging.header) {
			log.warn?.('[prerender] staging.ip is set but staging.header is empty — staging passthrough is disabled');
		} else if (isIP(config.staging.ip)) {
			log.warn?.(
				`[prerender] staging passthrough ENABLED — cache-miss requests carrying "${config.staging.header}" are proxied to ${config.staging.ip} (Host/SNI preserved)`
			);
		} else {
			log.warn?.(
				`[prerender] staging.ip "${config.staging.ip}" is not a valid IP address — staging passthrough is disabled`
			);
		}
	}
	if (config.renderNow.enabled) {
		if (!config.renderNow.header) {
			log.warn?.('[prerender] renderNow.enabled but renderNow.header is empty — on-demand render is disabled');
		} else if (!config.renderNow.token) {
			log.warn?.(
				`[prerender] renderNow ENABLED WITHOUT A TOKEN — any client sending "${config.renderNow.header}" can force cache/origin-bypassing renders (DoS risk); set renderNow.token or renderNow.valueEnv`
			);
		}
	}
};

export { SECOND, MINUTE, HOUR, DAY };
