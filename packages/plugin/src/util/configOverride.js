/**
 * The stored-override layer: reading it, validating a write, and noticing a change.
 *
 * Config resolves in three layers — schema defaults, then the deployed `config.yaml`, then the rows
 * in `config.ConfigOverride` written from the console. This module owns everything about
 * that third layer except the merge itself, which is `config.js`'s `resolveConfig`.
 *
 * WHY DELTAS AND NOT A SNAPSHOT. Each row is one option path. A snapshot of the whole config would
 * freeze every option an operator ever touched against future deploys: ship a corrected default, or
 * a fixed route, and the stale snapshot shadows it with nothing to say why the deploy did nothing.
 * With deltas, a `config.yaml` change still lands for every path nobody pinned, clearing one row
 * reverts one option, and clearing all of them returns the cluster to exactly its deployed state.
 *
 * WHY A REPLICATED TABLE AND NOT A FILE. The alternative — the console writing a file on each node —
 * has no convergence: a node that was mid-restart for one write diverges permanently, and there is
 * no mechanism that would ever heal it. Config divergence between nodes is the one thing this
 * cluster treats as a deploy failure rather than a preference, so a design whose normal operation
 * produces it is a design that trains operators to ignore the alarm. A replicated row is one write
 * that every node converges on, including a node that was down when it happened and a node added to
 * the cluster next month.
 *
 * HOW A CHANGE PROPAGATES. A table subscription acts as a DOORBELL, not a payload: any event
 * triggers a re-read of the whole (tiny) table, which is then re-applied. The event's own value is
 * deliberately ignored, because Harper's subscriptions do not dedupe and may deliver out of order —
 * whereas a full re-read is idempotent and always correct. A backstop poll covers the case where the
 * subscription was never established or the boot read failed, so the layer's staleness has a bound
 * that does not depend on a callback ever firing.
 *
 * EVERY WORKER SUBSCRIBES AND POLLS — unlike the schedulers in this plugin, which pin to one node
 * and worker. Each worker holds its own `config` object, so each has to learn about a change
 * itself; and the failure the backstop covers (this worker's subscription is gone) is per-worker by
 * definition. The cost is one bounded scan per worker per interval over a table with at most a few
 * dozen rows.
 */

import { config, getLogger, onConfigApplied, resolveConfig } from '../config.js';
import { aliasPaths, checkUiEditable } from '../configSchema.js';

const table = () => databases.config.ConfigOverride;

/**
 * Ceiling on rows one read will take. There are ~130 valid option paths and the path is the primary
 * key, so a table past this has accumulated rows for options that no longer exist — junk, not
 * configuration. The cap exists because `handleApplication` has a hard timeout (30s by default) and
 * a boot read that overruns it FAILS THE COMPONENT rather than merely delaying it, so every read on
 * this path has to be bounded by construction.
 */
const MAX_OVERRIDE_ROWS = 500;

/**
 * Deadline for a single override read. Same reasoning as the row cap, for the other failure mode:
 * an unowned point read on a residency-pinned table takes Harper's replication fetch, which has no
 * timeout at all. This table is deliberately not pinned and the walk is a local one-sided PK range,
 * so the deadline should never fire — it is here so that "should never" is not the only thing
 * standing between a slow read and a component that will not load.
 *
 * IT HAS TO BE SMALL BECAUSE IT AGGREGATES. `handleApplication` runs one thread at a time per plugin
 * (componentLoader takes a cross-thread lock), so a node with many workers pays this deadline
 * SERIALLY in the worst case, against a single 30s component-load budget and a lock wait that gives
 * up at timeout + 5s. At 5s a 14-worker node could push the later threads past both. Two seconds is
 * ~2000x a healthy read of a few dozen rows and keeps the aggregate inside the budget.
 */
const READ_TIMEOUT_MS = 2000;

/** Ceiling on entries in one write request. A config edit is a handful of paths, never hundreds. */
export const MAX_WRITE_ENTRIES = 200;

/**
 * How long to wait after a doorbell before re-reading. One console "save" writes several rows in
 * quick succession and each one rings; without this, each would trigger its own re-read and its own
 * `applyOptions`, and every `onConfigApplied` listener would re-arm its timers once per row.
 */
const DEBOUNCE_MS = 150;

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const withDeadline = async (label, run) => {
	let timer;
	try {
		return await Promise.race([
			run(),
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out after ${READ_TIMEOUT_MS}ms`)), READ_TIMEOUT_MS);
				timer.unref?.();
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
};

/**
 * Read every stored override row.
 *
 * FAILS OPEN. A read that throws or times out returns `degraded: true` with no overrides rather
 * than propagating, because the caller is boot: the choice is between running the deployed
 * `config.yaml` and not loading the component at all, and the deployed config is a perfectly good
 * answer. The degradation is reported so the console can say the layer is not being honoured
 * instead of showing an empty override list that looks like "nobody has set anything".
 *
 * @returns {Promise<{ overrides: Record<string, any>, rows: object[], degraded: boolean,
 *                     truncated: boolean, error: string|null }>}
 */
export const readOverrides = async () => {
	const empty = { overrides: {}, rows: [], degraded: true, truncated: false, error: null };
	try {
		const rows = await withDeadline('ConfigOverride read', async () => {
			const collected = [];
			// One-sided range over the primary key, which is how every string-PK walk in this plugin is
			// expressed: a two-sided PK range collapses to a filtered intersection rather than an index
			// range. `select` is an ARRAY — a string `select` projects to the bare scalar, so `row.path`
			// would be undefined and every override would silently vanish.
			for await (const row of table().search(
				{
					conditions: [{ attribute: 'path', comparator: 'greater_than', value: '' }],
					select: ['path', 'value', 'updatedTime', 'updatedBy', 'note'],
					limit: MAX_OVERRIDE_ROWS + 1,
				},
				// SECOND argument, not a query field. Harper's search path consumes query options it
				// knows and silently ignores the rest, so `replicateFrom` written inside the query
				// object would read as if it were honoured while doing nothing at all.
				{ replicateFrom: false }
			)) {
				collected.push(row);
			}
			return collected;
		});

		const truncated = rows.length > MAX_OVERRIDE_ROWS;
		const kept = truncated ? rows.slice(0, MAX_OVERRIDE_ROWS) : rows;
		if (truncated) {
			getLogger().warn?.(
				`[prerender] ConfigOverride holds more than ${MAX_OVERRIDE_ROWS} rows — reading the first ` +
					`${MAX_OVERRIDE_ROWS}. There are only ~130 option paths, so the excess is rows for options ` +
					`that no longer exist.`
			);
		}

		const overrides = {};
		for (const row of kept) {
			if (typeof row?.path !== 'string' || row.path === '') continue;
			// `undefined` is how a row says nothing, and it is also what the merge skips. Storing it
			// would be a row that exists, lists in the console, and does nothing.
			if (row.value === undefined) continue;
			overrides[row.path] = row.value;
		}

		return { overrides, rows: kept, degraded: false, truncated, error: null };
	} catch (e) {
		getLogger().warn?.(
			`[prerender] Could not read stored config overrides (${e.message}) — running the deployed ` +
				`configuration for now; the backstop re-read will pick them up.`
		);
		return { ...empty, error: e.message };
	}
};

/**
 * Whether the override layer is switched on, decided from the FILE layer alone.
 *
 * It has to be resolvable before any override has been applied — that is the whole point of a kill
 * switch — so this resolves host options with no override layer and reads the flag off the result.
 * `management.overrides` is marked non-editable in the schema for the same reason: a switch whose
 * off position is reachable only through the thing it switches off is not a switch.
 */
export const overridesEnabledFor = (hostOptions) =>
	resolveConfig(hostOptions, null).config.management.overrides.enabled !== false;

/**
 * Read the override layer as it should be APPLIED for a given host-options layer: the rows, plus
 * whether the kill switch leaves them inert.
 *
 * When disabled the rows are still returned — the console shows what is stored alongside the fact
 * that none of it is in effect, which is a far better answer than an empty list.
 */
export const loadOverrideLayer = async (hostOptions) => {
	const enabled = overridesEnabledFor(hostOptions);
	const read = await readOverrides();
	return { ...read, enabled, applied: enabled ? read.overrides : {} };
};

/**
 * A stable fingerprint of an override set, for "did anything actually change".
 *
 * The backstop poll re-reads on a fixed cadence and almost always finds nothing new. Re-applying
 * regardless would be correct but not free: `applyOptions` notifies every `onConfigApplied`
 * listener, and those re-arm the sitemap scheduler, the reconciler and the backlog snapshotter. A
 * no-op poll must not touch any of them.
 */
export const fingerprintOverrides = (overrides) =>
	JSON.stringify(
		Object.keys(overrides ?? {})
			.sort()
			.map((path) => [path, overrides[path]])
	);

/**
 * Validate one proposed override before it is stored.
 *
 * `resolveConfig` would catch a bad value anyway — it type-checks against the schema default and
 * enforces enum/min/max, keeping the default when a value fails. But catching it only there means
 * the row lands, the console lists it, and the cluster does not honour it: the `override-rejected`
 * state, which is real and worth reporting but is a terrible thing to create on purpose. So the
 * same rules are applied here, at the door, and the write is refused with a reason an operator can
 * act on.
 *
 * @returns {{ ok: true, value: any, node: object } | { ok: false, reason: string }}
 */
export const validateOverride = (path, value) => {
	const editable = checkUiEditable(path);
	if (!editable.ok) return editable;
	const node = editable.node;

	if (value === undefined || value === null) {
		return { ok: false, reason: `${path}: no value — to remove an override, clear it instead` };
	}

	const expected = Array.isArray(node.default) ? 'array' : typeof node.default;
	const actual = Array.isArray(value) ? 'array' : typeof value;
	if (expected !== actual) {
		return { ok: false, reason: `${path}: expected ${expected}, got ${actual}` };
	}

	if (node.enum && !node.enum.includes(value)) {
		return { ok: false, reason: `${path}: must be one of ${node.enum.map((v) => `'${v}'`).join(' | ')}` };
	}

	if (node.itemEnum && Array.isArray(value)) {
		const bad = value.filter((entry) => !node.itemEnum.includes(entry));
		if (bad.length) {
			// Whole-list rejection, matching `enforceSchemaConstraints`: for the options that carry an
			// itemEnum a rogue entry is corrupting rather than merely wrong, and a half-applied list is
			// worse than the default one.
			return { ok: false, reason: `${path}: ${bad.map((v) => `'${v}'`).join(', ')} not allowed here` };
		}
	}

	if (node.nonEmpty && (value === '' || (Array.isArray(value) && value.length === 0))) {
		return { ok: false, reason: `${path}: must not be empty` };
	}

	if (typeof value === 'number') {
		if (!Number.isFinite(value)) return { ok: false, reason: `${path}: must be a finite number` };
		if (node.min !== undefined && value < node.min) return { ok: false, reason: `${path}: must be >= ${node.min}` };
		if (node.max !== undefined && value > node.max) return { ok: false, reason: `${path}: must be <= ${node.max}` };
	}

	return { ok: true, value, node };
};

/**
 * Apply a batch of override writes and clears.
 *
 * VALIDATE EVERYTHING FIRST, THEN WRITE. A batch that wrote as it validated could stop halfway and
 * leave a config that is neither the old one nor the requested one — and unlike a failed single
 * write, nobody would know which half landed.
 *
 * @param {{ set?: Array<{path: string, value: any, note?: string}>, clear?: string[], updatedBy?: string }} request
 * @returns {Promise<{ written: string[], cleared: string[] }>}
 */
export const writeOverrides = async ({ set = [], clear = [], updatedBy = null } = {}) => {
	for (const entry of set) {
		const verdict = validateOverride(entry?.path, entry?.value);
		if (!verdict.ok) throw new Error(verdict.reason);
	}

	const overrides = table();
	const written = [];
	const cleared = [];

	// CLEAR THE ALIASES TOO. The layer is indexed by the path an option lives at NOW, so a row
	// written before that option moved is reported to the console under its current name — and a
	// delete of the current name removes a row that does not exist while the real one survives. The
	// console would show the revert succeeding, the value would not change, and the next read would
	// put the override straight back.
	const aliases = aliasPaths();
	const legacyKeysFor = (path) =>
		Object.entries(aliases)
			.filter(([, current]) => current === path || path.startsWith(`${current}.`))
			.map(([legacy, current]) => (current === path ? legacy : legacy + path.slice(current.length)));

	for (const path of clear) {
		for (const key of [path, ...legacyKeysFor(path)]) {
			await overrides.delete(key);
		}
		cleared.push(path);
	}
	for (const entry of set) {
		await overrides.put(entry.path, {
			value: entry.value,
			updatedBy,
			note: typeof entry.note === 'string' && entry.note ? entry.note : null,
		});
		written.push(entry.path);
	}

	return { written, cleared };
};

// ---- change propagation -----------------------------------------------------------------------

let watchStarted = false;
let subscribed = false;
let subscribeError = null;
let armedInterval = null;
let pollTimer = null;
let debounceTimer = null;
let lastReadAt = null;
let lastFingerprint = null;
let lastError = null;
let inFlight = null;
let generation = 0;

/** What the watcher is doing, for the management API. */
export const overrideWatchState = () => ({
	enabled: config.management.overrides.enabled !== false,
	subscribed,
	subscribeError,
	syncInterval: armedInterval,
	lastReadAt,
	lastError,
});

/**
 * Seed the fingerprint from the set applied at boot, so the first backstop tick does not see every
 * override as new and re-apply a config that is already correct.
 */
export const seedOverrideFingerprint = (overrides) => {
	// Only when the watcher has not already applied something. A doorbell can fire between subscribe
	// and this call — that window is exactly why subscribing happens first — and seeding over its
	// result would file a NEWER applied set under an OLDER fingerprint. The backstop would then read
	// the table, match the stale fingerprint, and conclude nothing had changed, so the edit would stay
	// lost with every signal saying it had landed.
	//
	// Returns whether it seeded, so the caller knows whether its own boot apply is still wanted.
	if (lastFingerprint !== null) return false;
	lastFingerprint = fingerprintOverrides(overrides);
	lastReadAt = Date.now();
	return true;
};

/**
 * Start watching the override table. Idempotent. `onOverrides(overrides)` is called only when the
 * set has actually changed since the last call.
 *
 * Subscribing happens BEFORE the caller's boot read, deliberately: a write landing between a read
 * and a later subscribe would be caught by neither, and the resulting staleness would persist until
 * the next backstop tick with nothing to indicate it.
 */
export const startOverrideWatch = async (onOverrides, bootSettings) => {
	if (watchStarted) return;
	watchStarted = true;

	// Taken as an argument rather than read off `config`, because this runs BEFORE the first
	// `applyOptions`: reading the live object here would see schema defaults and subscribe even where
	// the deployed file turned subscribing off. It cannot run after the first apply either — the
	// subscription has to exist before the boot read so a write landing between the two is not missed
	// by both. `management.overrides` is file-only precisely so it can be resolved this early.
	const settings = bootSettings ?? config.management.overrides;

	// SERIALIZED, and superseded calls drop out. The doorbell and the backstop poll fire
	// independently, so two reads can be in flight at once — and whichever COMPLETES last wins, which
	// is not the one that READ last. That is a genuine reordering: a poll started before an edit can
	// finish after the doorbell that announced it and quietly restore the pre-edit config, with the
	// fingerprint then agreeing that nothing more is pending. Chaining makes "the newest read wins"
	// true by construction, and a call already superseded while queued skips entirely, because the
	// newer one is about to read strictly fresher data.
	const reread = async (reason) => {
		const mine = ++generation;
		inFlight = (inFlight ?? Promise.resolve()).then(async () => {
			if (mine !== generation) return;

			const { overrides, degraded, error } = await readOverrides();
			lastReadAt = Date.now();
			lastError = error;
			if (degraded) return;

			const fingerprint = fingerprintOverrides(overrides);
			if (fingerprint === lastFingerprint) return;

			getLogger().info?.(`[prerender] Config overrides changed (${reason}) — reapplying`);
			try {
				await onOverrides(overrides);
				// AFTER the apply, never before. Recording it first means an apply that threw is filed as
				// done: the backstop then sees "no change" on every subsequent tick and the worker runs
				// the old config indefinitely, which is precisely the state the backstop exists to end.
				lastFingerprint = fingerprint;
			} catch (e) {
				lastError = e.message;
				getLogger().error?.(e);
			}
		});
		return inFlight;
	};

	const ring = (reason) => {
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			reread(reason).catch((e) => getLogger().error?.(e));
		}, DEBOUNCE_MS);
		debounceTimer.unref?.();
	};

	if (settings.subscribe !== false) {
		try {
			// The LISTENER form, not `for await`. With a data listener attached, events are emitted
			// synchronously and never queue, so the high-water mark never comes into play; and a throw
			// from the listener is caught and logged per-subscriber by Harper's notify pass. Consuming
			// the async iterator instead would mean an exception escaping the loop body ends the
			// iterator, which emits 'close', which unregisters the subscription permanently — a worker
			// that silently stops seeing config changes, with nothing logged and nothing to re-add it.
			//
			// `omitCurrent`, because the retained replay CANNOT be used to load the layer, however
			// naturally that reads. Harper starts the replay in an IIFE it never awaits — `subscribe()`
			// resolves with the subscription while the replay is still running — and the replay yields
			// to the event loop every 100 rows (a `setImmediate`) while the caller resumes on a
			// microtask. A caller awaiting `subscribe()` therefore holds the first 100 rows and no
			// signal that more are coming. Under 100 rows it completes synchronously and looks perfect,
			// which is precisely what makes it a trap: it would pass every test and begin flapping the
			// config at boot on the first cluster to cross 100 overrides. Skipping the replay also
			// makes that IIFE a no-op, so the subscription is fully armed the moment this resolves —
			// which is what lets the boot read below be an ordinary bounded search with no window
			// between the two.
			// Deadline, because this is on the boot path: `handleApplication` is raced against a hard
			// timeout (30s by default) and blowing it FAILS the component rather than delaying it. A
			// subscription that will not establish must cost a warning and the backstop poll, never the
			// plugin.
			await withDeadline('ConfigOverride subscribe', () =>
				table().subscribe({
					omitCurrent: true,
					listener: () => ring('subscription'),
				})
			);
			subscribed = true;
		} catch (e) {
			subscribed = false;
			subscribeError = e.message;
			getLogger().warn?.(
				`[prerender] Could not subscribe to config overrides (${e.message}) — falling back to the ` +
					`backstop poll, so a console edit converges within management.overrides.syncInterval instead ` +
					`of about a second.`
			);
		}
	}

	// Reads the LIVE config, unlike the subscribe decision above: this is re-run from
	// `onConfigApplied`, which by definition only fires after an apply, and re-arming on the live
	// value is what makes the interval editable without a restart.
	// `Math.trunc(Number(...))`, never `| 0`: the bitwise coercion wraps at 2^31, so a syncInterval of
	// 2^31+1 ms became NEGATIVE and disabled the backstop while the schema, the API and the console
	// all went on reporting the configured value.
	const intervalOf = (settings) =>
		settings.enabled === false ? 0 : Math.max(0, Math.trunc(Number(settings.syncInterval)) || 0);

	const syncPollTimer = () => {
		const wanted = intervalOf(config.management.overrides);
		if (wanted === armedInterval) return;
		clearInterval(pollTimer);
		pollTimer = null;
		armedInterval = wanted > 0 ? wanted : null;
		if (!armedInterval) return;
		pollTimer = setInterval(() => {
			reread('backstop poll').catch((e) => getLogger().error?.(e));
		}, armedInterval);
		pollTimer.unref?.();
	};

	const armFromBoot = () => {
		const wanted = intervalOf(settings);
		armedInterval = wanted > 0 ? wanted : null;
		if (!armedInterval) return;
		pollTimer = setInterval(() => {
			reread('backstop poll').catch((e) => getLogger().error?.(e));
		}, armedInterval);
		pollTimer.unref?.();
	};

	armFromBoot();
	onConfigApplied(syncPollTimer);
};

/** Test seam: forget the watcher so a fresh one can be started. */
export const resetOverrideWatchForTests = () => {
	clearTimeout(debounceTimer);
	clearInterval(pollTimer);
	watchStarted = false;
	inFlight = null;
	generation = 0;
	subscribed = false;
	subscribeError = null;
	armedInterval = null;
	pollTimer = null;
	debounceTimer = null;
	lastReadAt = null;
	lastFingerprint = null;
	lastError = null;
};

export { MAX_OVERRIDE_ROWS, READ_TIMEOUT_MS, isPlainObject };
