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
	secretPaths,
	walkOptions,
	schemaNodeAt,
	checkUiEditable,
	isOption,
	SECOND,
	MINUTE,
	HOUR,
	DAY,
} from './configSchema.js';
import { describeSecret } from './util/redact.js';
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

/**
 * Where merge/validation warnings go.
 *
 * Normally the log. During `resolveConfig` they are captured instead, because that path also
 * serves the management API's dry run: previewing a change must not write "Ignoring
 * prerender.x" into the http log for a value that was never applied — a log line that says a
 * setting was rejected, emitted while nothing was written, is worse than no preview at all.
 * Resolution is synchronous end to end, so a single module-level sink cannot interleave; the
 * save/restore still nests correctly if that ever stops being true.
 */
let warnSink = null;
const warn = (message) => {
	if (warnSink) warnSink.push(message);
	else getLogger().warn?.(message);
};

const captureWarnings = (fn) => {
	const previous = warnSink;
	const sink = (warnSink = []);
	try {
		return { result: fn(), warnings: sink };
	} finally {
		warnSink = previous;
	}
};

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
		for (const [key, inner] of Object.entries(value)) {
			// `out['__proto__'] = x` REASSIGNS the clone's prototype instead of adding a key, so a stored
			// value carrying that key would silently give the clone inherited properties — an
			// `ingress.routes` entry could arrive with no own `mode` and still read as passthrough,
			// which is a route that stops being prerendered for a reason not visible in the row.
			if (key === '__proto__') continue;
			out[key] = deepClone(inner);
		}
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
			warn(
				`[prerender] prerender.${oldPath} moved to prerender.${newPath} — update the config (the old path still works for now)`
			);
		} else {
			warn(
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
const mergeInto = (target, source, path = 'prerender', origin = null) => {
	if (!isPlainObject(source)) return;

	for (const key of Object.keys(target)) {
		if (!(key in source)) continue;

		const defaultValue = target[key];
		const overrideValue = source[key];
		const keyPath = `${path}.${key}`;

		if (overrideValue === undefined || overrideValue === null) continue;

		if (Array.isArray(defaultValue)) {
			if (!Array.isArray(overrideValue)) {
				warn(`[prerender] Ignoring ${keyPath}: expected an array`);
				continue;
			}
			target[key] = overrideValue.slice();
		} else if (isPlainObject(defaultValue)) {
			if (!isPlainObject(overrideValue)) {
				warn(`[prerender] Ignoring ${keyPath}: expected an object`);
				continue;
			}
			mergeInto(defaultValue, overrideValue, keyPath, origin);
		} else if (typeof defaultValue === typeof overrideValue) {
			target[key] = overrideValue;
		} else {
			warn(`[prerender] Ignoring ${keyPath}: expected ${typeof defaultValue}, got ${typeof overrideValue}`);
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
		if (path === 'prerender') {
			// `origin` names the layer, because the fix differs: an unknown key in config.yaml is a
			// typo to correct in git, while an unknown key in a stored override is a row left behind
			// by an option that was renamed or removed in a later release — which nobody would find
			// by grepping the repo.
			warn(`[prerender] Unknown configuration key: ${path}.${key}${origin ? ` (from ${origin})` : ''}`);
		}
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
const enforceSchemaConstraints = (fresh, fallback = null) => {
	// `fallback` is the config as it stood BEFORE the layer being validated — the file layer, when
	// validating overrides on top of it. Without it a rejected override reverts its option all the
	// way to the schema default, which means one typo'd override silently discards a value the
	// deployed config.yaml sets deliberately: the operator gets neither their new value nor the one
	// that was running, and nothing says the deployed setting was collateral. Type mismatches are
	// already safe this way (`mergeInto` simply never overwrites), so this makes the two rejection
	// paths agree.
	const reject = (path, node, why) => {
		const restored = fallback ? getPath(fallback, path) : undefined;
		const useFallback = restored !== undefined;
		warn(
			`[prerender] Ignoring prerender.${path}: ${why} — keeping the ${useFallback ? 'configured' : 'default'} value`
		);
		setPath(fresh, path, deepClone(useFallback ? restored : node.default));
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
		// `itemEnum` is `enum` for a list, and exists for options where a rogue entry is not
		// merely wrong but corrupting: `cacheKey.decodeReserved` with `&` in it would decode a
		// separator into every key and reparse the URL. Whole-list rejection (rather than
		// dropping the bad entry) keeps the config one statement — a half-applied key policy is
		// worse than the default one.
		if (node.itemEnum && Array.isArray(value)) {
			const bad = value.filter((entry) => !node.itemEnum.includes(entry));
			if (bad.length) {
				reject(path, node, `${bad.map((v) => `'${v}'`).join(', ')} not allowed here`);
				return;
			}
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

// The two input layers, kept exactly as they were last handed over, so the management API can
// answer "where did this value come from" without re-deriving it from the merged result — which
// cannot be done, since a merged value that equals the default is indistinguishable from one
// nobody set.
let lastHostOptions = {};
let lastOverrides = {};

/**
 * Rewrite one dotted path through the schema's `movedFrom` aliases.
 *
 * Done at the PATH level rather than by handing the nested object to `remapLegacyPaths`, because a
 * group-level marker has to rewrite a prefix: with `url` moved to `cacheKey`, a stored override of
 * `url.queryParams` belongs at `cacheKey.queryParams`, and only prefix matching gets there.
 */
const remapOverridePath = (path, aliases) => {
	// `Object.hasOwn`, never a bare lookup. The alias map is a plain object, so `aliases['__proto__']`
	// resolves to Object.prototype through the prototype chain — truthy, and NOT a string. Returning
	// it made `schemaNodeAt` call `.split` on an object and throw, and that throw travelled out of
	// applyOptions, out of handleApplication, and FAILED THE COMPONENT on every worker of every node.
	// One row in a replicated table, written by anything that bypasses the API's own validation, and
	// the cluster stops loading the plugin — the exact opposite of the fail-open property this layer
	// is supposed to have.
	if (Object.hasOwn(aliases, path)) return aliases[path];
	for (const [oldPath, newPath] of Object.entries(aliases)) {
		if (path.startsWith(`${oldPath}.`)) return newPath + path.slice(oldPath.length);
	}
	return path;
};

/**
 * `{ 'queue.jobLeaseTime': 90000 }` -> `{ queue: { jobLeaseTime: 90000 } }`, dropping — loudly —
 * any path that is not an option in this release.
 *
 * The loudness is the point. `mergeInto` only reports an unknown key at the TOP level, so a stale
 * override nested under a valid group (`queue.somethingRenamed`) would otherwise be discarded in
 * total silence: the row stays in the table, the console lists it, and it does nothing. It is also
 * invisible to `describeConfigLayers`, which walks the schema and therefore cannot show a path the
 * schema no longer has. An option renamed a release ago would quietly un-set itself on upgrade,
 * which is the worst moment for a setting to disappear without a word.
 */
const overridesToNested = (overrides) => {
	const nested = {};
	const aliases = aliasPaths();

	for (const [rawPath, value] of overrideEntries(overrides)) {
		const path = remapOverridePath(rawPath, aliases);
		if (path !== rawPath) {
			warn(`[prerender] Stored override ${rawPath} moved to ${path} — applying it there (update it to silence this)`);
		}

		const node = schemaNodeAt(path);
		if (!node || !isOption(node)) {
			warn(
				`[prerender] Ignoring stored override ${rawPath}: not an option in this release — it is a row left ` +
					`behind by an option that was renamed or removed, and it is doing nothing. Clear it from the console.`
			);
			continue;
		}

		// THE SAME REFUSAL AT APPLY AS AT THE DOOR. `checkUiEditable` gates the management API, but the
		// table is also reachable through the operations API — the break-glass path the schema comment
		// advertises — and a row written that way was being merged. That is not a theoretical gap: a row
		// for `management.enabled: false` disabled the management API on every node, and the console
		// could not undo it because undoing it goes through the API it just switched off. A secret is
		// the same shape of problem, one layer down. Anything the console may not write, the merge will
		// not honour, whatever route the row arrived by.
		const editable = checkUiEditable(path);
		if (!editable.ok) {
			warn(
				`[prerender] Ignoring stored override ${rawPath}: ${editable.reason}. A row for this option is ` +
					`only settable in config.yaml, so it is being ignored rather than applied.`
			);
			continue;
		}

		setPath(nested, path, deepClone(value));
	}

	return nested;
};

// Accepts a Map (what a table read produces) or a plain object, and skips anything that is not a
// usable path/value pair rather than letting it become a `{ undefined: ... }` key deep in the merge.
const overrideEntries = (overrides) => {
	if (!overrides) return [];
	const entries = overrides instanceof Map ? [...overrides.entries()] : Object.entries(overrides);
	return entries.filter(([path, value]) => typeof path === 'string' && path !== '' && value !== undefined);
};

/**
 * Index the override layer by the path it applies to, not the path it is stored under.
 *
 * They differ for a row written before an option moved. The merge already remaps those, so the
 * value takes effect — but `describeConfigLayers` looks up provenance by current path, and keyed
 * on the raw path it would report `source: 'default'` for an option that is in fact overridden.
 * A layers view that says "nobody set this" about a value somebody set is worse than no layers
 * view, so the remap happens once, here, and everything downstream sees current paths.
 */
const normalizeOverrides = (overrides) => {
	const aliases = aliasPaths();
	const out = {};
	for (const [path, value] of overrideEntries(overrides)) {
		out[remapOverridePath(path, aliases)] = deepClone(value);
	}
	return out;
};

/**
 * Build a config from its layers WITHOUT touching the live one.
 *
 * Precedence, lowest first: schema defaults < host options (config.yaml) < stored overrides
 * (`config.ConfigOverride`, written from the console). Both upper layers go through the
 * same `mergeInto` type checks and the same `enforceSchemaConstraints` pass, so an override
 * cannot enter by a route that skips validation — the console is not a second, weaker door into
 * the config.
 *
 * Legacy-path remapping runs over the override layer too. A stored override is keyed by the path
 * that was current when an operator set it, so an option that MOVES in a later release would
 * otherwise turn every override of it into an unknown key on upgrade — silently reverting a
 * deliberate setting at exactly the moment nobody is looking for it.
 *
 * Pure, and warnings are returned rather than logged, because this also serves the management
 * API's dry run.
 *
 * @returns {{ config: object, warnings: string[] }}
 */
export const resolveConfig = (options, overrides) => {
	const { result, warnings } = captureWarnings(() => {
		const fresh = defaultConfig();
		if (isPlainObject(options)) mergeInto(fresh, remapLegacyPaths(options));

		// The file layer is validated on its own FIRST, and the result kept, so that it can be the
		// fallback when an override is rejected below. Validating only once at the end would leave
		// no record of what was running before the override, and a rejected override would take the
		// deployed value down with it.
		enforceSchemaConstraints(fresh);

		// Already alias-remapped and schema-checked path by path, so it does NOT go through
		// `remapLegacyPaths` again — doing so would rewrite nothing and only risk double-reporting.
		const nested = overridesToNested(overrides);
		if (Object.keys(nested).length > 0) {
			const fileLayer = deepClone(fresh);
			mergeInto(fresh, nested, 'prerender', 'a stored override');
			enforceSchemaConstraints(fresh, fileLayer);
		}

		// After the merge, so an env-sourced secret still wins over a literal in either layer.
		resolveSecretsFromEnv(fresh);
		return fresh;
	});
	return { config: result, warnings };
};

/**
 * Apply the config layers onto the live `config`, with validation. Safe to call repeatedly (on
 * every options `change`, and on every override-table change). Resets to defaults first so
 * removed keys — and cleared overrides — revert.
 *
 * @param options    host options (`scope.options.getAll()`)
 * @param overrides  stored overrides as dotted path -> value (Map or plain object)
 */
export const applyOptions = (options, overrides) => {
	const { config: fresh, warnings } = resolveConfig(options, overrides);
	for (const message of warnings) getLogger().warn?.(message);

	const previous = deepClone(config);

	// Replace the contents of the live object in place to preserve the reference.
	for (const key of Object.keys(config)) delete config[key];
	Object.assign(config, fresh);

	lastHostOptions = isPlainObject(options) ? deepClone(options) : {};
	lastOverrides = normalizeOverrides(overrides);

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

/** The override layer as last applied: dotted path -> value. */
export const activeOverrides = () => deepClone(lastOverrides);

/** The host-options layer as last handed over (the deployed `config.yaml`). */
export const hostOptions = () => deepClone(lastHostOptions);

const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Per-option provenance: what each layer says, which one won, and whether a stored override is
 * actually in effect.
 *
 * `source: 'override-rejected'` is the state this exists for. An override whose value fails the
 * type check or a schema constraint is kept in the table and listed in the console, while the
 * running config quietly holds the file value — so the operator sees their setting on screen and
 * the cluster does not have it. Without this row the two are indistinguishable.
 *
 * Secrets are reported as presence per layer and never by value: the console renders straight
 * from this, and a layers view that showed what `redactConfig` hides would be a hole in the one
 * place an operator is most likely to screenshot.
 */
export const describeConfigLayers = () => {
	const defaults = defaultConfig();
	const fileConfig = resolveConfig(lastHostOptions, null).config;
	const secrets = new Set(secretPaths());
	const rows = [];

	walkOptions((path, node, scope) => {
		const secret = secrets.has(path) || !!node.secret;
		const show = (value) => (secret ? describeSecret(value) : value);

		const defaultValue = getPath(defaults, path);
		const fileValue = getPath(fileConfig, path);
		const effective = getPath(config, path);
		const overridden = Object.hasOwn(lastOverrides, path);
		const overrideValue = overridden ? lastOverrides[path] : undefined;

		let source;
		if (overridden && sameValue(effective, overrideValue)) source = 'override';
		else if (overridden) source = 'override-rejected';
		else if (!sameValue(fileValue, defaultValue)) source = 'file';
		else source = 'default';

		rows.push({
			path,
			scope,
			secret,
			source,
			overridden,
			fileDiffersFromDefault: !sameValue(fileValue, defaultValue),
			default: show(defaultValue),
			file: show(fileValue),
			override: overridden ? show(overrideValue) : undefined,
			effective: show(effective),
		});
	});

	return rows;
};

// Source the security token from an environment variable when `valueEnv` is set,
// so the shared secret never has to live in config.yaml. Runs after the merge so
// it overrides any literal `value`. (loadEnv populates process.env before the
// plugin applies options.)
const resolveSecretsFromEnv = (target) => {
	const { valueEnv } = target.origin.securityToken;
	if (valueEnv && process.env[valueEnv]) {
		target.origin.securityToken.value = process.env[valueEnv];
	}
	const renderNowEnv = target.renderNow.valueEnv;
	if (renderNowEnv && process.env[renderNowEnv]) {
		target.renderNow.token = process.env[renderNowEnv];
	}
	const peerRescueEnv = target.peerRescue.valueEnv;
	if (peerRescueEnv && process.env[peerRescueEnv]) {
		target.peerRescue.token = process.env[peerRescueEnv];
	}
};

/**
 * Collect the risky-configuration findings for the live config as structured data, so the
 * same list can be logged at config-apply time AND surfaced by the management API (these
 * used to exist only as log lines, where nobody sees them until something is already
 * wrong). `severity` is 'warn' for a misconfiguration and 'info' for a
 * dangerous-but-deliberate mode that is worth showing prominently.
 */
export const collectConfigWarnings = (target = config, { prerenderRoutes } = {}) => {
	const findings = [];
	// Defaults to the live compiled count. A caller checking a PROSPECTIVE config (the management
	// API's dry run) must pass its own, because the compiled route list is memoized from the live
	// config — reading it here would answer the previewed `ingress.routes` change with the count
	// that is currently running, which is exactly backwards for the one finding that matters most
	// when editing routes.
	const routeCount = prerenderRoutes ?? prerenderRouteCount();
	const add = (severity, key, message) => findings.push({ severity, key, message });

	if (!target.origin.securityToken.value) {
		add(
			'warn',
			'origin.securityToken.value',
			'origin.securityToken.value is empty — the origin cannot authenticate prerender requests'
		);
	}
	if (target.domains.length === 0) {
		add('warn', 'domains', 'domains allowlist is empty — all hosts will be treated as indexable');
	}
	if (target.ingress.mode === 'forwarded' && routeCount === 0) {
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
	const { staging } = target.origin;
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
	if (target.renderNow.enabled) {
		if (!target.renderNow.header) {
			add('warn', 'renderNow.header', 'renderNow.enabled but renderNow.header is empty — on-demand render is disabled');
		} else if (!target.renderNow.token) {
			// Inert, not open: isRenderNowAuthorized fails closed without a token. Still worth
			// reporting, because the operator asked for a feature that is not actually on — and
			// naming the unresolved variable is the difference between a five-second fix and a hunt.
			const { valueEnv } = target.renderNow;
			add(
				'warn',
				'renderNow.token',
				valueEnv
					? `renderNow.enabled is true but renderNow.valueEnv ("${valueEnv}") is not set in the environment and no renderNow.token is configured — renderNow is DISABLED (the levers fail closed rather than authorizing anyone)`
					: 'renderNow.enabled is true but no renderNow.token is configured — renderNow is DISABLED (the levers fail closed rather than authorizing anyone); set renderNow.token or renderNow.valueEnv'
			);
		}
	}
	if (target.peerRescue.enabled && !target.peerRescue.token) {
		// Inert, not open: both the rescue client and the endpoint fail closed without a token.
		// Same shape as the renderNow finding — the operator asked for a feature that is not on.
		const { valueEnv } = target.peerRescue;
		add(
			'warn',
			'peerRescue.token',
			valueEnv
				? `peerRescue.enabled is true but peerRescue.valueEnv ("${valueEnv}") is not set in the environment and no peerRescue.token is configured — peer rescue is DISABLED (it fails closed rather than serving cached pages unauthenticated)`
				: 'peerRescue.enabled is true but no peerRescue.token is configured — peer rescue is DISABLED (it fails closed rather than serving cached pages unauthenticated); set peerRescue.token or peerRescue.valueEnv'
		);
	}
	if (target.invalidation.enabled && target.invalidation.pad < target.queue.jobLeaseTime) {
		// Cross-option, like spreadWindow below. The pad's config text calls in-flight renders "the
		// certain one" of the two things it covers — but a job legitimately holds its claim for up to
		// jobLeaseTime, and a render that posts back later than the pad stamps lastCached after
		// epoch+pad with PRE-change bytes: the page reads as healed and serves wrong content until its
		// next cadence render (48h on the long-tail route), with no counter firing because the
		// comparison sincerely passes. Normal claim-to-post is seconds, so the default usually holds —
		// this fires so the operator sees the gap during exactly the degraded/backlogged states in
		// which invalidations get recorded. Cost of matching pad to jobLeaseTime is one extra render
		// per over-included page.
		add(
			'warn',
			'invalidation.pad',
			`invalidation.pad (${target.invalidation.pad}ms) is below queue.jobLeaseTime ` +
				`(${target.queue.jobLeaseTime}ms) — a render claimed just before an invalidation may post back ` +
				`after the pad, stamping pre-change content as healed for a full render interval. Set pad >= ` +
				`jobLeaseTime unless post-back latency is known to be seconds.`
		);
	}
	const { reenqueue } = target.invalidation;
	if (reenqueue.enabled && reenqueue.spreadWindow < target.queue.jobLeaseTime) {
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
				`(${target.queue.jobLeaseTime}ms) — that squeezes every accelerated due time onto a handful of ` +
				`minutes, and a pile of rows at the minute the claim scan seeks takes that scan from 0.36ms to ` +
				`11.59ms. The accelerator is using ${target.queue.jobLeaseTime}ms instead; raise spreadWindow to at ` +
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
