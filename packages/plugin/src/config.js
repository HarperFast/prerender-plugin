/**
 * Central, runtime-mutable configuration for the prerender plugin.
 *
 * The option catalog — defaults, descriptions, validation, reload scopes — lives in
 * `configSchema.js`; this module owns the LIVE config object and the machinery that
 * applies host options onto it.
 *
 * `config` is pre-populated with defaults so every module can import it and read
 * values at request/timer time without waiting for setup. The plugin's
 * `handleApplication` (worker) calls `applyOptions()` with the host app's scoped
 * options (from `scope.options`) to override the defaults, and re-applies on every
 * `change` event for live reload. Nearly every option is live (scope 'live' in the
 * schema): background timers re-arm themselves via `onConfigApplied`. The few
 * restart-scoped options are diffed on re-apply and reported via
 * `pendingRestartChanges` (and a log warning) instead of taking effect.
 *
 * IMPORTANT: read `config.*` lazily (at request/timer time), not at module-load
 * time, so overrides applied during `handleApplication` take effect.
 */

import { isIP } from 'node:net';
import {
	configSchema,
	defaultConfig,
	aliasPaths,
	restartPaths,
	isOption,
	SECOND,
	MINUTE,
	HOUR,
	DAY,
} from './configSchema.js';
// Cyclic by design, and safe: routeClass.js imports `config`/`getLogger` from here, and this
// module calls back into it only from inside `collectConfigWarnings` — never at module
// evaluation time. The count has to come from the compiler rather than from raw config,
// because the finding's whole job is to catch entries the compiler REJECTED (a typo'd
// `match`), which the raw array still contains.
import { prerenderRouteCount } from './util/routeClass.js';

// Returns the Harper logger when running inside Harper, otherwise the console.
// Unit tests run outside Harper where `logger` is undefined.
export const getLogger = () => (typeof logger !== 'undefined' && logger ? logger : console);

// The live config object. Mutated in place by applyOptions so existing imports
// keep their reference.
export const config = defaultConfig();

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const getPath = (obj, path) => {
	let node = obj;
	for (const segment of path.split('.')) {
		if (!isPlainObject(node)) return undefined;
		node = node[segment];
	}
	return node;
};

const setPath = (obj, path, value) => {
	const segments = path.split('.');
	const leaf = segments.pop();
	let node = obj;
	for (const segment of segments) {
		if (!isPlainObject(node[segment])) node[segment] = {};
		node = node[segment];
	}
	node[leaf] = value;
};

const deletePath = (obj, path) => {
	const segments = path.split('.');
	const leaf = segments.pop();
	const parent = segments.length ? getPath(obj, segments.join('.')) : obj;
	if (isPlainObject(parent)) delete parent[leaf];
	// Prune a parent the removal emptied, so a legacy group that lost its last key
	// (e.g. `url` after `url.queryParams` relocated) doesn't trip the unknown-key warning.
	if (segments.length && isPlainObject(parent) && Object.keys(parent).length === 0) {
		deletePath(obj, segments.join('.'));
	}
};

const deepClone = (value) => {
	if (Array.isArray(value)) return value.map(deepClone);
	if (isPlainObject(value)) {
		const out = {};
		for (const [key, inner] of Object.entries(value)) out[key] = deepClone(inner);
		return out;
	}
	return value;
};

/**
 * Rewrite legacy option paths (schema `movedFrom` markers) onto their current location,
 * with a deprecation warning. The current path wins when both are set. Returns a
 * remapped deep copy; the caller's options object is never mutated.
 */
const remapLegacyPaths = (options) => {
	const copy = deepClone(options);
	for (const [oldPath, newPath] of Object.entries(aliasPaths())) {
		const value = getPath(copy, oldPath);
		if (value === undefined) continue;
		if (getPath(copy, newPath) === undefined) {
			setPath(copy, newPath, value);
			getLogger().warn?.(
				`[prerender] prerender.${oldPath} moved to prerender.${newPath} — update the config (the old path still works for now)`
			);
		} else {
			getLogger().warn?.(
				`[prerender] prerender.${oldPath} moved to prerender.${newPath}, which is also set — using prerender.${newPath} and ignoring the old path`
			);
		}
		deletePath(copy, oldPath);
	}
	return copy;
};

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
 * Enforce the schema's per-option constraints (`enum`, `min`/`max`, `nonEmpty`) on the
 * merged result, restoring the default on violation. These values passed `mergeInto`'s
 * type check but cannot be honored — an out-of-enum mode, or an empty
 * `cacheKey.delimiter` (which would make the keys of two URLs where one is a prefix of
 * the other collide, split parses into single CHARACTERS, and collapse every jitter
 * seed onto the empty string) — so the default wins. Distinct from
 * `collectConfigWarnings`, which reports settings that are merely risky.
 */
const enforceSchemaConstraints = (fresh) => {
	const reject = (path, node, why) => {
		getLogger().warn?.(`[prerender] Ignoring prerender.${path}: ${why} — keeping the default`);
		setPath(fresh, path, deepClone(node.default));
	};

	const walk = (node, path) => {
		if (!isOption(node)) {
			for (const [key, child] of Object.entries(node.children)) walk(child, path ? `${path}.${key}` : key);
			return;
		}
		const value = getPath(fresh, path);
		if (node.enum && !node.enum.includes(value)) {
			reject(path, node, `must be one of ${node.enum.map((v) => `'${v}'`).join(' | ')}`);
			return;
		}
		// null/undefined can't actually reach here through applyOptions (mergeInto skips
		// null/undefined overrides, and every schema path exists in the defaults), but the
		// validator shouldn't depend on the merge layer's behavior to be safe.
		if (
			node.nonEmpty &&
			(value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0))
		) {
			reject(path, node, 'must not be empty');
			return;
		}
		if (typeof value === 'number') {
			if (node.min !== undefined && value < node.min) reject(path, node, `must be >= ${node.min}`);
			else if (node.max !== undefined && value > node.max) reject(path, node, `must be <= ${node.max}`);
		}
	};
	walk(configSchema, '');
};

// Listeners notified after every applyOptions with (config, previous). Background
// timers use this to re-arm when the interval/gate they run on changes, which is what
// makes those options genuinely live instead of boot-captured.
const configListeners = new Set();
export const onConfigApplied = (listener) => {
	configListeners.add(listener);
};

// Restart-scoped options that changed on a live re-apply: the new value is in `config`
// but the running behavior still reflects boot. Keyed by path so a value flapped back
// to its boot state clears its entry. Exposed for the management API.
let bootConfig = null;
const pendingRestart = new Map();
export const pendingRestartChanges = () => [...pendingRestart.values()];

const trackRestartScopedChanges = () => {
	for (const path of restartPaths()) {
		const bootValue = getPath(bootConfig, path);
		const newValue = getPath(config, path);
		if (JSON.stringify(newValue) === JSON.stringify(bootValue)) {
			pendingRestart.delete(path);
			continue;
		}
		// Warn once per distinct new value, not on every re-apply of the same config.
		if (JSON.stringify(pendingRestart.get(path)?.value) !== JSON.stringify(newValue)) {
			getLogger().warn?.(
				`[prerender] prerender.${path} changed but is only read at boot — the new value takes effect on the next worker restart`
			);
		}
		pendingRestart.set(path, { key: path, value: newValue, bootValue });
	}
};

/**
 * Apply host-provided options onto the live `config`, with validation. Safe to
 * call repeatedly (e.g. on every options `change`). Resets to defaults first so
 * removed keys revert.
 */
export const applyOptions = (options) => {
	const fresh = defaultConfig();
	if (isPlainObject(options)) mergeInto(fresh, remapLegacyPaths(options));
	enforceSchemaConstraints(fresh);

	const previous = deepClone(config);

	// Replace the contents of the live object in place to preserve the reference.
	for (const key of Object.keys(config)) delete config[key];
	Object.assign(config, fresh);

	resolveSecretsFromEnv();

	// The first apply is boot: everything takes effect, nothing is pending-restart.
	if (!bootConfig) bootConfig = deepClone(config);
	else trackRestartScopedChanges();

	warnOnRiskyConfig();

	for (const listener of configListeners) {
		try {
			listener(config, previous);
		} catch (e) {
			getLogger().error?.(e);
		}
	}
	return config;
};

// Source the security token from an environment variable when `valueEnv` is set,
// so the shared secret never has to live in config.yaml. Runs after the merge so
// it overrides any literal `value`. (loadEnv populates process.env before the
// plugin applies options.)
const resolveSecretsFromEnv = () => {
	const { valueEnv } = config.origin.securityToken;
	if (valueEnv && process.env[valueEnv]) {
		config.origin.securityToken.value = process.env[valueEnv];
	}
	const renderNowEnv = config.renderNow.valueEnv;
	if (renderNowEnv && process.env[renderNowEnv]) {
		config.renderNow.token = process.env[renderNowEnv];
	}
};

/**
 * Collect the risky-configuration findings for the live config as structured data, so the
 * same list can be logged at config-apply time AND surfaced by the management API (these
 * used to exist only as log lines, where nobody sees them until something is already
 * wrong). `severity` is 'warn' for a misconfiguration and 'info' for a
 * dangerous-but-deliberate mode that is worth showing prominently.
 */
export const collectConfigWarnings = () => {
	const findings = [];
	const add = (severity, key, message) => findings.push({ severity, key, message });

	if (!config.origin.securityToken.value) {
		add(
			'warn',
			'origin.securityToken.value',
			'origin.securityToken.value is empty — the origin cannot authenticate prerender requests'
		);
	}
	if (config.domains.length === 0) {
		add('warn', 'domains', 'domains allowlist is empty — all hosts will be treated as indexable');
	}
	if (config.ingress.mode === 'forwarded' && prerenderRouteCount() === 0) {
		// Nothing is prerendered in this state: every forwarded request classifies as
		// unclassified and is proxied straight through. Silent before — the plugin looked
		// healthy while serving zero cached pages. It is also the state a single typo in
		// `routes` produces, since invalid entries are dropped individually, which is why the
		// retirement sweep refuses to run when this finding is present.
		add(
			'warn',
			'ingress.routes',
			'forwarded mode with NO valid prerender routes — every request will be proxied uncached; ' +
				'check ingress.routes for entries dropped as invalid'
		);
	}
	const { staging } = config.origin;
	if (staging.ip) {
		// Mirror stagingTargetIp's gate (ip AND header AND valid ip) so the finding never
		// claims the feature is on when it is actually disabled.
		if (!staging.header) {
			add(
				'warn',
				'origin.staging.header',
				'origin.staging.ip is set but origin.staging.header is empty — staging passthrough is disabled'
			);
		} else if (isIP(staging.ip)) {
			add(
				'info',
				'origin.staging.ip',
				`staging passthrough ENABLED — cache-miss requests carrying "${staging.header}" are proxied to ${staging.ip} (Host/SNI preserved). Toggling this on/off contaminates the URL-keyed page cache; wipe it when switching.`
			);
		} else {
			add(
				'warn',
				'origin.staging.ip',
				`origin.staging.ip "${staging.ip}" is not a valid IP address — staging passthrough is disabled`
			);
		}
	}
	if (config.renderNow.enabled) {
		if (!config.renderNow.header) {
			add('warn', 'renderNow.header', 'renderNow.enabled but renderNow.header is empty — on-demand render is disabled');
		} else if (!config.renderNow.token) {
			// Inert, not open: isRenderNowAuthorized fails closed without a token. Still worth
			// reporting, because the operator asked for a feature that is not actually on — and
			// naming the unresolved variable is the difference between a five-second fix and a hunt.
			const { valueEnv } = config.renderNow;
			add(
				'warn',
				'renderNow.token',
				valueEnv
					? `renderNow.enabled is true but renderNow.valueEnv ("${valueEnv}") is not set in the environment and no renderNow.token is configured — renderNow is DISABLED (the levers fail closed rather than authorizing anyone)`
					: 'renderNow.enabled is true but no renderNow.token is configured — renderNow is DISABLED (the levers fail closed rather than authorizing anyone); set renderNow.token or renderNow.valueEnv'
			);
		}
	}
	const { reenqueue } = config.invalidation;
	if (reenqueue.enabled && reenqueue.spreadWindow < config.queue.jobLeaseTime) {
		// Cross-option, so it cannot live in the schema's per-option constraints — and it is a warning
		// plus a clamp at use time rather than a rejection, because rejecting back to the default would
		// silently WIDEN the window an operator deliberately narrowed.
		//
		// THE HAZARD IS THE PILE, NOT THE LEASE. A narrow window squeezes every accelerated row on the
		// node onto a handful of minutes, and rows piled at the minute the claim scan seeks take that
		// scan from 0.36ms to 11.59ms (32x), clearing only on the store's next compaction. This warning
		// used to claim instead that a key re-armed sooner than `jobLeaseTime` chases a render that still
		// holds its lease — which a window WIDTH cannot prevent (the jitter is uniform, so most keys are
		// re-armed sooner than a lease even at the defaults), and which the accelerator's node-local
		// `leased` guard already refuses exactly. `jobLeaseTime` remains the clamp only because the
		// schema floors it at 2 minutes, making it the smallest spread this system already trusts.
		add(
			'warn',
			'invalidation.reenqueue.spreadWindow',
			`invalidation.reenqueue.spreadWindow (${reenqueue.spreadWindow}ms) is below queue.jobLeaseTime ` +
				`(${config.queue.jobLeaseTime}ms) — that squeezes every accelerated due time onto a handful of ` +
				`minutes, and a pile of rows at the minute the claim scan seeks takes that scan from 0.36ms to ` +
				`11.59ms. The accelerator is using ${config.queue.jobLeaseTime}ms instead; raise spreadWindow to at ` +
				`least that to silence this.`
		);
	}

	return findings;
};

const warnOnRiskyConfig = () => {
	const log = getLogger();
	for (const { message } of collectConfigWarnings()) {
		log.warn?.(`[prerender] ${message}`);
	}
};

export { SECOND, MINUTE, HOUR, DAY };
