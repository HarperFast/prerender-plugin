/**
 * BULK CACHE INVALIDATION — the one home for the `Invalidation` table.
 *
 * The operator gesture is "everything of this kind is wrong as of now; stop serving it." The
 * mechanism is a COMPARISON, not a rewrite: one row records a scope and an instant, and the serve
 * path demotes any cached page in that scope whose `lastCached` predates the instant. Nothing in
 * `PrerenderedPage` or `RenderSchedule` is touched.
 *
 * WHY NOT REWRITE THE CORPUS, which is what `Target.revalidate`'s collection form already does.
 * Measured on 400,000 rows (one node's slice of a 1.61M-key corpus): 15.7 s wall and **61.8 MB of
 * audit per node per invalidation**, at 162 B/row, and pacing does not reduce it — batching with
 * yields kept the same 162 B/write, took 8.9x longer, and made claim's max latency WORSE (47.4 ->
 * 62.4 ms). (While claims walked the `nextRenderTime` index, collapsing every due time to
 * `currentMinuteMs()` also slowed the claim scan 32x.) Recording an epoch instead costs **0.18 ms and 102 bytes** — ~606,000x less audit — and
 * it is what makes undo instant, because `lastCached` was never altered.
 *
 * WHY NOT A QUEUE-SIDE SWEEP, ever. The PDP corpus is 1,530,046 keys against a measured fleet
 * ceiling of 71,289 renders/hr, so the fastest physically possible full re-render is **21.5 h at
 * 100% utilisation** — against the 48 h such a page waits anyway — while measured utilisation is
 * already 98% with a 3.05 h standing backlog. A sweep would also displace the 1 h and 12 h routes
 * behind 1.53M PDP keys, because claim is strictly due-time-ascending. Cadence-heal is correct here
 * by CONSTRUCTION, not by preference: nothing in `claim`, `syncQueueState` or `reconcile` reads
 * `PrerenderedPage`, so the epoch cannot perturb the queue at all.
 *
 * WHY NOT COMPARE `expiresAt`. `expiresAt = lastCached + interval`, so an `expiresAt` test
 * under-invalidates by up to a full interval — 48 h on PDP, precisely the direction that keeps
 * serving the pre-change page. `expiresAt` is also already overloaded: `Target.revalidate` writes
 * `Date.now()` into it, which is standing proof that no single value of it can both block the SWR
 * window and tell the truth about the schedule. `lastCached` is a plain `Date` that nothing but a
 * real render writes.
 *
 * ── WHAT THIS FEATURE MUST NEVER DO ─────────────────────────────────────────────────────────────
 *
 * Serve content somebody deliberately invalidated, silently. Every failure path here is therefore
 * either loud or documented as failing open, and never quietly failing closed-then-open:
 *
 *   - A scope that resolves to nothing is a 400 at write time, not a green row. See
 *     `util/routeClass.js#routeScopes` for why the closed set is load-bearing.
 *   - A row with no readable `invalidatedAt` does not apply, and says so (`invalid-row`). There is
 *     deliberately NO `updatedTime` fallback: `updatedTime` re-stamps on every write, so a fallback
 *     would mean editing `reason` silently re-invalidates the corpus — the exact hazard the explicit
 *     column exists to avoid, reintroduced by its own safety net.
 *   - A read error falls back to a last-known-good that stores ABSENCE as well as presence and
 *     carries its own age. Both halves matter: without storing absence, one transient error after a
 *     clear pins a worker on a deleted epoch for the rest of its life; without the age bound, so
 *     does a permanent one.
 *   - `invalidation.enabled: false` is a kill switch, and while any row exists it is reported as a
 *     config warning, a log line and a console banner.
 *
 * ── HOW THE EPOCH REACHES EVERY WORKER: A SUBSCRIBED IN-MEMORY VIEW ─────────────────────────────
 *
 * Each worker holds the whole table in memory (`view`, below) and the serve path resolves from it
 * synchronously — no read, no await, no allocation while nothing is invalidated. A subscription is
 * the DOORBELL: any committed change to the table, on any node (a replicated write commits locally
 * and rings too), makes the worker re-read the table, so apply and undo reach every worker within one
 * notify pass plus one read of a single-digit table. The event is never the payload — Harper does not
 * dedupe and may reorder, so the view is always rebuilt from a read.
 *
 * WHY, IN NUMBERS. This used to resolve per request with two point reads (`all` and the route's
 * scope), and the module header priced that at "<=5,800 reads/day" to reject a refresh timer. At the
 * traffic this actually serves — ~7M bot requests/day, most of them cache-servable — it was ~10M reads
 * a day, about 2,000x the estimate. The view costs one read per worker per doorbell plus the
 * `invalidation.syncInterval` backstop (8 workers x 4 nodes x 1/min = 46,080 reads/day of a table
 * this small) — and it no longer grows with traffic.
 *
 * THE SUBSCRIPTION IS PRICED PER DATABASE, not per table: the audit log spans the database, so every
 * commit anywhere in it pays a notify pass for each subscribed worker. That is free here only because
 * `Invalidation` is ALONE in its database and written only when an invalidation is applied or
 * cleared. Never move another table into `invalidation`; see schema.graphql.
 *
 * EVERY FAILURE FALLS BACK TO THE OLD PATH, never to a stale view. The view is trusted only after a
 * full read completed while the subscription it was loaded under is still the live one. Until then —
 * at boot, before the first read lands; after `subscribe()` throws; after the subscription closes; after
 * a read throws — `resolveInvalidation` reads per request exactly as it did before, with the
 * last-known-good below. Each backstop tick retries whatever is down. The one failure no event reports,
 * delivery stopping silently, is bounded by that same tick.
 *
 * WHAT NEITHER DESIGN BUYS: cross-NODE effectiveness. Each node's serve path reads its own replica
 * of the invalidation table, so a row recorded on node A reaches node B by Harper async replication —
 * normally sub-second, but this cluster has seen freshly-written rows silently fail to replicate for
 * days (the Target replication-gap incident). During such a fault an "all" invalidation is silently
 * inert on the nodes that never received the row, while the console — answering from the writing
 * node — shows it active. The operator responses say this; the rehearsal step that matters is
 * confirming the row is visible on a PEER node, not the one that took the write.
 */

import { config, onConfigApplied } from '../config.js';
import { epochMsOf } from './time.js';
import { routeScopes, routeForScope } from './routeClass.js';
import { metrics } from '../metrics.js';
import { runDetached } from './detach.js';

/** The scope covering every prerender route. `route:<match>:<path>` covers exactly one. */
export const CLUSTER_SCOPE = 'all';

/** The only recognised mode in v1. An unrecognised value is treated as this, and reported. */
export const HARD = 'hard';

export const MAX_REASON_LENGTH = 200;

const table = () => databases.invalidation.Invalidation;

/**
 * Per-worker last-known-good, keyed by scope literal: `{ at, invalidatedAtMs }` where a null
 * `invalidatedAtMs` records a successful resolution that found NOTHING. Absence is stored precisely
 * because it is the value a cleared invalidation needs to propagate — see the module comment.
 *
 * Per key rather than one snapshot of the whole table: a request resolves at most two keys, and a
 * failure on one must not invalidate a fresh answer for the other.
 */
const lkg = new Map();

// A counter, so it costs no storage touch and no await: recordAnalytics buffers in a Map and
// flushes on Harper's own timer. Dimensions and kinds are documented in `src/metrics.js`.
const countError = (kind) => metrics.invalidationError(kind);

/**
 * One scope's epoch in ms, or `null` when the scope does not apply. `pad` is NOT added here — it is
 * applied once at the end of `resolveInvalidation`, so it stays live-tunable and shows up in explain
 * as a separate term rather than being baked into a cached number.
 *
 * `select` MUST be an array. A string `select` projects to the bare scalar rather than a record, the
 * trap that made a `QueueControl` read silently resolve to "no opinion" so that no node ever acted
 * on a pause (`util/queueControl.js:50-56`). Here it would make every row read as absent — i.e. the
 * feature would appear to work and invalidate nothing.
 */
const readScope = async (scope) => {
	try {
		const row = await table().get({ id: scope, select: ['scope', 'invalidatedAt', 'mode'] });
		const resolved = interpretRow(scope, row);
		lkg.set(scope, { at: Date.now(), invalidatedAtMs: resolved });
		return resolved;
	} catch (e) {
		logger.error(e, `[prerender] invalidation read failed for scope ${scope}`);
		const remembered = lkg.get(scope);
		const maxAge = config.invalidation.lkgMaxAge;
		// STRICTLY less than, so `lkgMaxAge: 0` means what the option says it means — "fail open on the
		// first read error". With `<=`, an age of 0 (a read failing in the same millisecond the LKG was
		// written, which is the common case for two reads in one request) satisfied `0 <= 0` and the LKG
		// was used anyway, so the documented way to switch this off did not switch it off.
		if (remembered && Date.now() - remembered.at < maxAge) {
			countError('read-error');
			return remembered.invalidatedAtMs;
		}
		// FAIL OPEN. This table's normal state is empty, so "unknown" almost certainly means "nothing
		// is invalidated" — and failing closed would convert a cosmetic storage fault into a total
		// offload outage. Loud (counted + logged), never silent.
		countError(remembered ? 'lkg-expired' : 'read-error');
		return null;
	}
};

/**
 * A row as an epoch in ms, or `null` when it does not apply. Pure, so the precedence and
 * validity rules are testable without Harper.
 */
export const interpretRow = (scope, row) => {
	if (!row) return null;

	// A Date column, so `epochMsOf` — `new Date(null)` is epoch 0, not NaN, which would read as
	// "invalidated since 1970" and demote the entire scope forever off a row somebody wrote wrong.
	const at = epochMsOf(row.invalidatedAt);
	if (!Number.isFinite(at)) {
		countError('invalid-row');
		// error, not warn: this is somebody's deliberate invalidation being silently inert —
		// the one outcome this feature must never produce (see the module header).
		logger.error(
			`[prerender] invalidation row "${scope}" has no readable invalidatedAt, so it applies to NOTHING. ` +
				`Write an explicit ISO instant (there is deliberately no updatedTime fallback, because updatedTime ` +
				`re-stamps on every write and would re-invalidate the corpus whenever the row was edited).`
		);
		return null;
	}

	// Unrecognised mode -> treat as `hard`, the safe direction, and report it. Refusing to apply the
	// row would be the unsafe direction: it would silently un-invalidate over a typo in a field that
	// currently has exactly one legal value.
	if (row.mode !== undefined && row.mode !== null && row.mode !== HARD) {
		countError('unknown-mode');
		logger.warn(
			`[prerender] invalidation row "${scope}" has mode "${row.mode}", which this version does not know; ` +
				`treating it as "${HARD}" (stop serving). Only "${HARD}" is valid in this release.`
		);
	}

	return at;
};

/**
 * The applicable epoch for a page, given the route scope it belongs to (`null` when no prerender
 * route claims it — see `routeScopeForUrl`). Returns `{ scope, at }` or `null`.
 *
 * PRECEDENCE IS `max(at)`, NOT MOST-SPECIFIC-WINS. A leftover route-scoped row from a rehearsal must
 * not be able to hide a fresh `all` — and no coverage check can catch that, because coverage
 * enumerates routes, not competing rows. Most-specific-wins reads as the natural choice and is the
 * one rule that can silently serve invalidated content.
 *
 * A VALUE, NOT A PROMISE, whenever the view answers — the per-request cost is two Map lookups — and a
 * promise from the per-request-read fallback. Every caller awaits, which takes either.
 */
export const resolveInvalidation = (routeScope) => {
	if (!config.invalidation.enabled) return null;
	if (view !== null) return epochFromView(view, routeScope);
	return resolveByReads(routeScope);
};

// The applicable scopes: `all`, plus the route's own when it has one.
const epochFromView = (rows, routeScope) => {
	let scope = CLUSTER_SCOPE;
	let at = rows.get(CLUSTER_SCOPE);
	if (routeScope && routeScope !== CLUSTER_SCOPE) {
		const routeAt = rows.get(routeScope);
		if (routeAt !== undefined && (at === undefined || routeAt > at)) {
			scope = routeScope;
			at = routeAt;
		}
	}
	return at === undefined ? null : { scope, at: at + config.invalidation.pad };
};

const resolveByReads = async (routeScope) => {
	// At most two, both point reads by known key, issued together. (Concurrency is correct here —
	// the "probe shapes sequentially" rule from the measurement work is about benchmarking, where a
	// Promise.all makes every shape report the slowest one's latency.)
	const scopes = routeScope && routeScope !== CLUSTER_SCOPE ? [CLUSTER_SCOPE, routeScope] : [CLUSTER_SCOPE];
	const epochs = await Promise.all(scopes.map(readScope));

	let winner = null;
	for (let i = 0; i < scopes.length; i++) {
		const at = epochs[i];
		if (at === null) continue;
		if (winner === null || at > winner.at) winner = { scope: scopes[i], at };
	}
	if (winner === null) return null;
	return { scope: winner.scope, at: winner.at + config.invalidation.pad };
};

// ---- the per-worker view ---------------------------------------------------------------------

/**
 * scope -> invalidatedAt ms, holding ONLY rows that apply (`interpretRow` non-null), so a scope that is
 * absent reads as "no invalidation" with no second lookup. `null` whenever it cannot be trusted — the
 * serve path then reads per request. Replaced whole on every load, never edited in place, so a
 * request can never observe half a load.
 */
let view = null;

/** The live subscription, or null. A load installs its result only if this has not changed under it. */
let subscription = null;
let subscribing = false;
// Warn on the transition into "cannot subscribe", not on every retry: the backstop retries each tick on
// every worker, and the counter already carries the rate.
let subscribeWarned = false;
// Loads are serialized, and a doorbell that rings mid-load marks the view dirty so a fresh load follows:
// the in-flight one may have read before the write it is ringing about.
let loading = null;
let dirty = false;
let backstopTimer = null;
let armedBackstop = null;

/**
 * Past this many rows the view is not trusted: an incomplete copy would read every scope it lost as
 * "nothing invalidated". The API caps active scopes at `invalidation.maxScopes`, so only rows written by
 * hand through the operations socket can get here, and they get the per-request path.
 */
const VIEW_MAX_ROWS = 1024;

// The boot path does not wait on this (the view starts detached), but a `subscribe()` that never settles
// would leave the worker on per-request reads with nothing said. Bounded, then retried by the backstop.
const SUBSCRIBE_TIMEOUT_MS = 10_000;

const loadView = async () => {
	const loadedUnder = subscription;
	const rows = [];
	try {
		// One-sided range over the primary key, as in `listInvalidations`; `select` an ARRAY (see
		// `readScope`). `replicateFrom: false` is the SECOND argument, not a query field — Harper ignores
		// unknown query fields silently. The table is fully replicated, so this is a local read either way;
		// it is stated so a future residency change cannot turn a doorbell into a cross-node wait.
		for await (const row of table().search(
			{
				conditions: [{ attribute: 'scope', comparator: 'greater_than', value: '' }],
				select: ['scope', 'invalidatedAt', 'mode'],
				limit: VIEW_MAX_ROWS + 1,
			},
			{ replicateFrom: false }
		)) {
			rows.push(row);
		}
	} catch (e) {
		view = null;
		countError('view-read-error');
		logger.error(e, '[prerender] invalidation view read failed; this worker reads per request until it recovers');
		return;
	}
	if (rows.length > VIEW_MAX_ROWS) {
		view = null;
		logger.warn(
			`[prerender] the invalidation table holds more than ${VIEW_MAX_ROWS} rows; this worker resolves epochs ` +
				`per request instead of from memory. Rows past invalidation.maxScopes can only have been written by hand.`
		);
		return;
	}

	const next = new Map();
	for (const row of rows) {
		const at = interpretRow(row.scope, row);
		if (at !== null) next.set(row.scope, at);
	}
	// The per-request fallback's memory, refreshed from the same read: if the view later goes untrusted and
	// a read then fails, the last-known-good is this load's answer rather than whatever the boot left.
	const now = Date.now();
	for (const scope of [CLUSTER_SCOPE, ...routeScopes()])
		lkg.set(scope, { at: now, invalidatedAtMs: next.get(scope) ?? null });

	// Installed only under the subscription it was read under. A read that raced a lost-and-replaced
	// subscription may predate a write only the new one would ring for; the new one has queued its own load.
	if (loadedUnder !== null && subscription === loadedUnder) view = next;
};

/** Ring the doorbell: (re)load the view, after any load already in flight. Never rejects. */
const requestLoad = () => {
	dirty = true;
	if (loading) return loading;
	// DETACHED: the doorbell can fire inside the async context of the request whose write rang it, and a
	// read on that request's transaction fails once Harper closes it (util/detach.js).
	loading = runDetached(async () => {
		try {
			while (dirty) {
				dirty = false;
				await loadView();
			}
		} finally {
			loading = null;
		}
	}).catch((e) => logger.error(e, '[prerender] invalidation view load failed'));
	return loading;
};

const dropSubscription = (lost) => {
	if (subscription !== lost) return;
	subscription = null;
	view = null;
	countError('view-subscribe-error');
	logger.warn('[prerender] invalidation subscription closed; this worker reads per request until it re-subscribes');
};

const subscribeView = async () => {
	if (subscription !== null || subscribing) return;
	subscribing = true;
	let timer;
	let gaveUp = false;
	const attempt = Promise.resolve().then(() =>
		// The LISTENER form, never `for await`: a throw escaping a loop body ends the iterator, which closes
		// and unregisters the subscription permanently. `omitCurrent`: the retained replay is unawaitable and
		// truncates at 100 for the caller, so the view is loaded by a bounded read instead, and with the
		// replay skipped the subscription is armed the moment this resolves.
		table().subscribe({
			omitCurrent: true,
			listener: () => {
				requestLoad();
			},
		})
	);
	try {
		const live = await Promise.race([
			attempt,
			new Promise((_, reject) => {
				timer = setTimeout(() => {
					gaveUp = true;
					reject(new Error(`subscribe timed out after ${SUBSCRIBE_TIMEOUT_MS}ms`));
				}, SUBSCRIBE_TIMEOUT_MS);
				timer.unref?.();
			}),
		]);
		if (!live) throw new Error('subscribe returned no subscription');
		subscription = live;
		subscribeWarned = false;
		live.on?.('close', () => dropSubscription(live));
		requestLoad();
	} catch (e) {
		countError('view-subscribe-error');
		if (!subscribeWarned) {
			subscribeWarned = true;
			logger.warn(
				`[prerender] could not subscribe to invalidations (${e?.message ?? e}); this worker reads per request ` +
					`and retries every invalidation.syncInterval`
			);
		}
		// A subscribe that settles after we stopped waiting must not live on unreferenced, ringing a view
		// nobody trusts and never being ended.
		if (gaveUp)
			attempt.then(
				(late) => late?.end?.(),
				() => {}
			);
	} finally {
		clearTimeout(timer);
		subscribing = false;
	}
};

// The backstop: re-subscribe if the subscription is down, otherwise re-read. Re-armed from
// `onConfigApplied`, so `invalidation.syncInterval` is live.
const syncBackstop = () => {
	const wanted = Math.min(2147483647, Math.max(1000, Math.trunc(Number(config.invalidation.syncInterval)) || 60_000));
	if (wanted === armedBackstop) return;
	clearInterval(backstopTimer);
	armedBackstop = wanted;
	backstopTimer = setInterval(() => {
		if (subscription === null) subscribeView().catch(() => {});
		else requestLoad();
	}, wanted);
	backstopTimer.unref?.();
};

/** Tests only — the LKG and the view are per-worker process state that outlives a `beforeEach`. */
export const resetInvalidationState = () => {
	lkg.clear();
	view = null;
	subscription?.end?.();
	subscription = null;
	subscribing = false;
	subscribeWarned = false;
	dirty = false;
	loading = null;
	clearInterval(backstopTimer);
	backstopTimer = null;
	armedBackstop = null;
	invalidationWatchStarted = false;
};

/** Tests and diagnostics: is this worker resolving from memory, and is its doorbell connected? */
export const invalidationViewState = () => ({ trusted: view !== null, subscribed: subscription !== null });

// ---- the active set, for the admin surface ---------------------------------------------------

/**
 * Every row in the table, bounded by `maxScopes`. A WALK, not point reads of the known scope set,
 * and that difference is the whole point: a hand-written row from the operations-socket escape hatch
 * names a scope no validator ever saw, and point reads of the closed set would render it invisible
 * in exactly the view an operator opens to find out why an invalidation is not working.
 *
 * A plain `search` rather than `util/scan.js#collectFromScan`: that helper exists to bound walks of
 * the 1.6M-key tables with yields and a cap, and this table holds single digits of rows.
 */
export const listInvalidations = async () => {
	const cap = Math.max(1, config.invalidation.maxScopes | 0);
	const rows = [];
	// One-sided range over the primary key, which is how every string-PK walk in this plugin is
	// expressed. A two-sided range on a PK collapses to a filtered intersection instead of an index
	// range (measured 289-1490 ms against 0.30 ms), so it is never the shape to reach for.
	for await (const row of table().search({
		conditions: [{ attribute: 'scope', comparator: 'greater_than', value: '' }],
		select: ['scope', 'invalidatedAt', 'mode', 'reason', 'updatedBy', 'updatedTime'],
		limit: cap + 1,
	})) {
		rows.push(row);
	}
	return { rows: rows.slice(0, cap), truncated: rows.length > cap };
};

/**
 * Derive one page's applicable epoch from an already-resolved active set — SYNCHRONOUSLY, so an
 * admin view costs one read per request and zero per row.
 *
 * That is what makes the freshness verdict supplyable at every call site. Without it, the sitemap
 * URL-state view (fanned across a page of entries) and the page-cache listing (a synchronous map)
 * would each need a per-row read, doubling their cost — and the path of least resistance would be to
 * pass only the `all` epoch and silently miss every route scope, which is the class of bug the
 * `resolveServeStatus` rename exists to make impossible.
 */
export const epochFromActiveSet = (rows, routeScope) => {
	if (!config.invalidation.enabled) return null;
	let winner = null;
	for (const row of rows) {
		if (row.scope !== CLUSTER_SCOPE && row.scope !== routeScope) continue;
		const at = epochMsOf(row.invalidatedAt);
		if (!Number.isFinite(at)) continue;
		if (winner === null || at > winner.at) winner = { scope: row.scope, at };
	}
	if (winner === null) return null;
	return { scope: winner.scope, at: winner.at + config.invalidation.pad };
};

// ---- resolvability: the detector for a scope that matches nothing -----------------------------

/**
 * Report any active row whose scope no longer names anything, WITHOUT reading config alone.
 *
 * This exists because the obvious place to put the check cannot host it: `collectConfigWarnings()`
 * is synchronous and a pure function of config, so it cannot read a table. And the check has to be
 * against the table, not against config, because the two ways a scope goes stale are opposite in
 * direction — a route renamed or removed by a live config edit un-invalidates a corpus somebody
 * deliberately invalidated, and a hand-written row invents a scope that never existed.
 *
 * Run at boot, from `onConfigApplied`, and on every overview load, so a live route rename surfaces
 * within one config apply rather than at the next incident.
 */
export const checkScopeResolvability = async () => {
	const known = routeScopes();
	const { rows, truncated } = await listInvalidations();
	const unresolvable = [];
	for (const row of rows) {
		if (row.scope === CLUSTER_SCOPE) continue;
		if (!known.has(row.scope)) unresolvable.push(row.scope);
	}
	if (unresolvable.length) {
		logger.warn(
			`[prerender] ${unresolvable.length} invalidation scope(s) match no configured prerender route and are ` +
				`applying to NOTHING: ${unresolvable.join(', ')}. Either a route was renamed or removed while the ` +
				`invalidation was active — in which case that corpus is being served again — or the row was written ` +
				`by hand. Valid scopes: ${[CLUSTER_SCOPE, ...known].join(', ')}.`
		);
	}
	return { unresolvable, active: rows.length, truncated, knownScopes: [CLUSTER_SCOPE, ...known] };
};

/** Is this scope literal one an invalidation may name right now? */
export const isScopeResolvable = (scope) => scope === CLUSTER_SCOPE || routeScopes().has(scope);

/**
 * Start this worker's view of the table, and watch for scopes that stop resolving. Called once per
 * worker from `handleApplication`, and re-run on every config apply.
 *
 * EVERY WORKER, not worker 0. The view is per-worker process state (the serve path runs on every
 * worker), and so is the last-known-good it refreshes. The resolvability report is a log line, so
 * worker 0 would be enough for it alone; running it everywhere costs one bounded read of a
 * single-digit table per worker per config change and keeps the halves in one place.
 *
 * NOT AWAITED BY THE BOOT PATH: until the subscription is armed and the first read lands, the serve
 * path reads per request, which is correct, only dearer.
 *
 * RE-RUNNING ON CONFIG APPLY IS THE POINT, and it is the half that cannot be got from config alone.
 * A route renamed or removed by a live edit silently un-invalidates whatever that scope covered —
 * the row is still there, still looks applied, and now matches nothing. `collectConfigWarnings()` is
 * synchronous and a pure function of config, so it cannot read the table to notice; this can. The
 * re-run also re-arms the backstop (its interval is live) and reloads the view, whose read is what
 * fills the last-known-good for any route scope the edit added.
 *
 * Failures are swallowed per call. The view falls back by itself and the report is diagnostics; a
 * boot that failed because an empty table could not be read would be a far worse trade than a late
 * warning.
 */
let invalidationWatchStarted = false;

export const startInvalidationWatch = () => {
	if (invalidationWatchStarted) return;
	invalidationWatchStarted = true;

	const run = () => {
		syncBackstop();
		if (subscription !== null) requestLoad();
		checkScopeResolvability().catch(() => {});
		warnIfKillSwitchHidesRows().catch(() => {});
	};

	subscribeView().catch(() => {});
	run();
	onConfigApplied(run);
};

/**
 * `invalidation.enabled: false` while rows exist MUST NEVER BE SILENT.
 *
 * It is a kill switch, and it exists because at 3am you want a way to take a new mechanism out of the
 * serve path. But the state it produces — rows recorded, console showing them, and the whole corpus
 * quietly serving pre-invalidation bytes again — is the single outcome this feature must never
 * produce without saying so. `collectConfigWarnings()` cannot detect it (it cannot read a table), so
 * the detection lives here and fires on boot and on every config apply, which is exactly when someone
 * flips the switch.
 */
const warnIfKillSwitchHidesRows = async () => {
	if (config.invalidation.enabled) return;
	const { rows } = await listInvalidations();
	if (!rows.length) return;
	logger.warn(
		`[prerender] invalidation.enabled is FALSE while ${rows.length} invalidation row(s) exist ` +
			`(${rows.map((row) => row.scope).join(', ')}). Those invalidations are NOT being applied: every page ` +
			`they cover is serving pre-invalidation content again, and the rows will keep looking applied to ` +
			`anyone reading the table. Either re-enable it or clear the rows.`
	);
};

// ---- writes ----------------------------------------------------------------------------------

/**
 * Record an invalidation. Returns what was written — never re-read.
 *
 * `invalidatedAt` is stamped HERE, server-side. A caller-supplied instant is rejected by the API
 * rather than ignored: an operator who thinks they backdated an invalidation and did not has a
 * corpus they believe is invalidated and is not.
 */
export const recordInvalidation = async ({ scope, reason, updatedBy }) => {
	const invalidatedAt = new Date();
	await table().put(scope, {
		invalidatedAt,
		mode: HARD,
		reason,
		updatedBy: updatedBy ?? null,
	});
	await reflectOwnWrite(scope, invalidatedAt.getTime());
	return { scope, invalidatedAt: invalidatedAt.toISOString(), mode: HARD, reason, updatedBy: updatedBy ?? null };
};

/**
 * THE WRITER'S OWN WORKER SEES ITS WRITE BEFORE THE WRITE RETURNS. The doorbell reaches this worker a
 * notify pass and a read after the commit, and a caller that acts on its own write at once would miss
 * it: the change probe's canary trip records an invalidation and immediately chains a reseed, whose
 * first resolution then saw NO epoch, treated nothing as covered and re-baselined the whole scope —
 * making a false trip unrecoverable by clearing it.
 *
 * So: reload the view now, after the write, and wait for it. A write made outside a request (the
 * probe's passes) has committed by the time `put` resolves, so that read sees it. A write made INSIDE
 * a request (the admin API) commits only when the request ends, so no read can see it yet — then the
 * write is patched into this worker's copy directly, and the doorbell after the commit replaces the
 * patch with the real row. The patch never overrides a newer answer: a put only raises a scope's epoch,
 * and a clear only removes an epoch older than the clear itself.
 */
const reflectOwnWrite = async (scope, atMs) => {
	if (subscription === null) return; // no view in use: the per-request reads see the table itself
	await requestLoad();
	if (view === null) return;
	const current = view.get(scope);
	if (atMs === null) {
		if (current === undefined || !(current <= Date.now())) return;
	} else if (current !== undefined && current >= atMs) return;
	const next = new Map(view);
	if (atMs === null) next.delete(scope);
	else next.set(scope, atMs);
	view = next;
};

/**
 * Clear an invalidation. Returns the fact of the delete, computed from what was just done — NEVER
 * by re-reading.
 *
 * `util/queueControl.js:57-63` documents why: a row deleted earlier in a request is still visible to
 * a read in that same request, so re-reading would make the one operation whose entire value is
 * confirmation report the exact opposite of what happened.
 */
export const clearInvalidation = async (scope) => {
	const existed = await table().delete(scope);
	// Drop the LKG entry on this worker so its own next request re-reads rather than serving the
	// cleared epoch out of its remembered answer for up to `lkgMaxAge`.
	lkg.delete(scope);
	await reflectOwnWrite(scope, null);
	return { scope, cleared: true, existed: existed !== false };
};

/** The compiled route a scope names, for the coverage half of the API response. */
export const scopeCoverage = (scope) => {
	if (scope === CLUSTER_SCOPE) {
		const all = [...routeScopes()];
		return { scope, covers: 'every prerender route', matchedRoutes: all, uncoveredRoutes: [] };
	}
	const entry = routeForScope(scope);
	const others = [...routeScopes()].filter((s) => s !== scope);
	return {
		scope,
		covers: entry ? `${entry.match} ${entry.path}` : 'nothing — this scope matches no configured route',
		matchedRoutes: entry ? [scope] : [],
		uncoveredRoutes: others,
	};
};
