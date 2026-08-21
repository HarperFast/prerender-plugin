/**
 * Repair for targets whose `RenderSchedule` rows have gone missing.
 *
 * `Target` and `RenderSchedule` live in separate databases, so creating a target is a target
 * commit plus one schedule commit PER DEVICE — and the schedule half is residency-routed to
 * whichever node owns the URL. If a schedule write is lost (a crash between them, or a routed
 * write to a node whose replication link is unhealthy), or if cluster membership changes and
 * moves a key's owner, the target survives with a missing schedule row for one or more of its
 * devices.
 *
 * Nothing then repairs it, and nothing renders that URL again:
 *
 *   - the bot-traffic path (`handlePageScheduling`) is gated on the target NOT existing, so
 *     it skips the URL from then on;
 *   - the sitemap refresh only visits URLs present in a sitemap, so a traffic-discovered URL
 *     — the homepage being the obvious one — is never revisited;
 *   - `processJobResult` reschedules, but only after a render, which needs a claim, which
 *     needs the very row that is missing.
 *
 * So the state is terminal AND silent: the cached page expires, every subsequent bot request
 * falls through to the origin, and there is no error and no metric to notice it by. Before
 * this sweep the only way to find one was to run the URL explainer on it by hand.
 *
 * WHY PER-NODE AND OWNER-SCOPED: the only safe way to ask "does this schedule row exist" is a
 * node-local read on the node that owns it. A cross-node point read takes Harper's
 * replication fetch, which has no timeout (see `util/peer.js`) — asking about a key we don't
 * own could hang the sweep forever. Each node therefore reconciles exactly the keys
 * rendezvous hashing assigns to it, where its node-local read IS authoritative. Every node
 * running the same sweep covers the whole keyspace, with no coordination and no cross-node
 * reads.
 */

import { metrics } from '../metrics.js';
import { setImmediate } from 'node:timers/promises';
import { config, onConfigApplied } from '../config.js';
import { CacheKey } from './cacheKey.js';
import { fnv1a32 } from './hash.js';
import { getResidencyByUrl } from './residency.js';
import { getInitialRenderTime } from './time.js';
import { resolveRenderInterval } from './routeClass.js';
import { getScheduleRow, writeSchedule } from './renderSchedule.js';

// Rows scanned between event-loop yields, so a sweep over a large registry stays background
// work rather than monopolizing the thread.
const YIELD_EVERY = 200;

/**
 * ONE pass over the targets: find the keys this node owns whose schedule row is missing, then
 * restore them after the scan has finished. All I/O is injected, so the traversal, the
 * ownership filter and the cap are testable without a live database.
 *
 * Deliberately CURSOR-FREE, and therefore indifferent to the order rows arrive in. An earlier
 * version paged by primary key and resumed from the last key seen, which quietly made
 * correctness depend on the storage engine returning rows in key order: if that ever stopped
 * holding, the cursor would skip rows silently — the worst possible failure mode for a repair
 * tool, in the one place nobody would look. A single pass needs no such guarantee.
 *
 * The two phases also make the transaction rule structural rather than a convention to
 * remember: no write is issued while the scan's cursor is open, because every write happens
 * after it closes. (Interleaving them would hold the read transaction across the writes and
 * pin the log against reclamation — the same reason `claim` drains before leasing.)
 *
 * The cap bounds WRITES, not scanning: the scan always runs to completion, so `missing` is the
 * true size of the gap even when only `maxRestores` of it was repaired this pass. That also
 * means the loop never breaks early, so the iterator is always fully consumed and its read
 * transaction always released.
 */
export const reconcileSchedules = async ({
	streamTargets,
	getSchedule,
	putSchedule,
	ownerOf,
	hostname,
	deviceTypes,
	maxRestores,
	onYield = () => {},
} = {}) => {
	const stats = { examined: 0, owned: 0, missing: 0, restored: 0, truncated: false };
	const toRestore = [];

	// Phase 1 — read only. One target row implies one schedule row PER configured device, and
	// each is checked independently — a URL can be half-scheduled (desktop present, mobile
	// missing) and that partial gap is just as silent as a full one.
	for await (const target of streamTargets()) {
		stats.examined++;
		if (stats.examined % YIELD_EVERY === 0) await onYield();

		// Residency is keyed off the URL exactly as RenderSchedule's own `setResidencyById`
		// computes it, so this agrees with where the rows actually live.
		if (ownerOf(target.url) !== hostname) continue;
		stats.owned++;

		for (const deviceType of deviceTypes) {
			const cacheKey = CacheKey.toCacheKey({ url: target.url, deviceType });
			if (await getSchedule(cacheKey)) continue;
			stats.missing++;

			// Past the cap we keep counting but stop collecting, so the gap is measured in full
			// while the repair stays bounded. A membership change can strand a large slice of the
			// keyspace at once, and rewriting millions of rows in one pass would be its own outage.
			if (toRestore.length < maxRestores) toRestore.push({ cacheKey, target });
		}
	}

	// Phase 2 — writes, with the scan's cursor now closed.
	for (const { cacheKey, target } of toRestore) {
		// Hoisted because the jittered time and the recorded cadence must be the same number — see both
		// comments below.
		const interval = resolveRenderInterval(target.url, target.renderInterval);
		await putSchedule(cacheKey, {
			// The jittered initial time, NOT "now": a repair pass can restore a great many rows at
			// once, and scheduling them all immediately would replace a silent outage with a
			// render herd. This is the same value the original `Target.put` would have written,
			// so a repaired target rejoins the rotation exactly where it belonged.
			//
			// Cadence resolved the same way Target.put would (route > stored > default), so a
			// repaired row rejoins the rotation exactly where a fresh one would land. The
			// resolver owns the numeric guards — BigInt from a `Long` column is coerced,
			// null/NaN/non-positive fall back to the default.
			//
			// `getInitialRenderTime` is always >= `currentMinuteMs(now)`, so a repair can at worst
			// TIE the claim floor — and a tie is claimable only because the floor comparator is
			// inclusive (`greater_than_equal`). If that comparator were ever made exclusive, every
			// repaired row would be filed one step behind the floor and this sweep would restore
			// rows into the very silent gap it exists to close.
			nextRenderTime: getInitialRenderTime(cacheKey, interval),
			fromSitemap: !!target.sitemapUrl,
			// The same cadence the jitter above was drawn from, so a repaired row is ranked by the
			// window it was actually spread across. No ladder rung applied: `streamTargets` is an
			// unconstrained scan of the whole target corpus and `demandInterval` would widen it by a
			// fourth attribute on every row, to refine the ranking of rows that are (a) rare — this
			// only fires on a missing row — and (b) filed at a FUTURE jittered time, so not yet
			// competing for anything. The row's next render files the true rung.
			effectiveInterval: interval,
		});
		stats.restored++;
	}

	stats.truncated = stats.missing > stats.restored;

	return stats;
};

/** `reconcileSchedules` bound to the live tables. */
export const reconcileScheduleGaps = async ({ maxRestores = config.render.reconcile.maxRestores } = {}) => {
	const {
		render_service: { Target },
	} = databases;

	return reconcileSchedules({
		// One unconstrained scan, streamed. No conditions, no `sort`, no `limit`:
		//   - no `sort`, because asking Harper to sort by the primary key is what broke v0.10.0
		//     (the primary key is not flagged `indexed`, so a sort on it is rejected unless a
		//     condition accompanies it — and Harper injects its own scan condition only AFTER
		//     that check, so the first page threw before scanning anything);
		//   - no conditions, because with none Harper injects that full-scan condition itself,
		//     which is exactly what this wants;
		//   - no `limit`, because the caller streams and never resumes, so it needs no paging.
		//
		// Nothing here depends on the order rows arrive in — see `reconcileSchedules`.
		streamTargets: () => Target.search({ select: ['url', 'renderInterval', 'sitemapUrl'] }),
		// Node-local by construction — see the module comment. Existence is all that matters.
		// (`getScheduleRow` is what carries the mandatory `replicateFrom: false`.)
		getSchedule: (cacheKey) => getScheduleRow(cacheKey, ['cacheKey']),
		// Writes route by residency, so this reaches the owning node even though the read above
		// deliberately does not — and it goes through the schedule funnel, which lowers the claim
		// floor with the write. A restored row filed BEHIND the floor would be exactly the silent,
		// terminal gap this sweep exists to close, so the funnel is not optional here.
		//
		// Per row rather than one batched lowering for the whole phase: every restore is a jittered
		// FUTURE time, so the funnel's CAS-min never actually moves the floor and the per-row cost
		// is one atomic load. Batching it would mean changing the injected port signature that keeps
		// the traversal tests running with no Harper globals, for no measurable gain.
		putSchedule: (cacheKey, row) => writeSchedule(cacheKey, row),
		ownerOf: getResidencyByUrl,
		hostname: server.hostname,
		// Config at sweep time, matching Target.put's fan-out — so a device added to config
		// gets its missing schedule rows created for every existing target by this sweep.
		deviceTypes: config.deviceTypes.default,
		maxRestores,
		onYield: () => setImmediate(),
	});
};

let running = false;
let lastRun = null;

/** Summary of the most recent sweep on this node, for the management API. */
export const getLastReconcile = () => lastRun;

/** Whether a sweep is in flight, so the admin action can say so instead of implying a new one. */
export const isReconcileRunning = () => running;

/**
 * Run one sweep, guarded against overlap. Returns the run summary, or `{ skipped: true }`
 * when a sweep is already in flight — the periodic timer and the admin action share this
 * guard, so triggering it by hand can never double up on the scheduled pass.
 */
export const runReconcileOnce = async (options) => {
	if (running) return { skipped: true, reason: 'a reconcile sweep is already running', lastRun };
	running = true;

	const startedAt = Date.now();
	try {
		const stats = await reconcileScheduleGaps(options);
		lastRun = { ...stats, node: server.hostname, startedAt, finishedAt: Date.now(), error: null };

		// The same numbers as METRICS: `restored` > 0 is the alert (URLs were silently
		// un-renderable until this sweep). Guarded — a gauge must never cost the sweep record.
		try {
			metrics.reconcile(stats.restored, 'restored');
			metrics.reconcile(stats.missing, 'missing');
		} catch (e) {
			logger.warn(`[prerender] reconcile gauges not recorded: ${e?.message ?? String(e)}`);
		}

		// Restoring a row means a URL was silently un-renderable until now, which is worth a
		// warning rather than an info line. A clean pass says so quietly.
		if (stats.restored || stats.truncated) {
			logger.warn(
				`[prerender] schedule reconcile: restored ${stats.restored} of ${stats.missing} missing schedule row(s) across ${stats.owned} owned target(s) (${stats.examined} examined)` +
					(stats.truncated
						? ` — ${stats.missing - stats.restored} left for the next sweep by the ${config.render.reconcile.maxRestores}-restore cap`
						: '')
			);
		} else {
			logger.info(
				`[prerender] schedule reconcile: no gaps across ${stats.owned} owned target(s) (${stats.examined} examined)`
			);
		}

		return lastRun;
	} catch (e) {
		// `e?.message ?? String(e)` rather than `e.message`: anything can be thrown, and a
		// null/undefined/string throw would turn the failure record itself into a TypeError.
		lastRun = { node: server.hostname, startedAt, finishedAt: Date.now(), error: e?.message ?? String(e) };
		throw e;
	} finally {
		running = false;
	}
};

let reconcilerStarted = false;
let reconcilerDelayTimer = null;
let reconcilerIntervalTimer = null;
let reconcilerArmed = null; // the interval the timers were armed for, or null when disabled

const clearReconcilerTimers = () => {
	if (reconcilerDelayTimer) clearTimeout(reconcilerDelayTimer);
	if (reconcilerIntervalTimer) clearInterval(reconcilerIntervalTimer);
	reconcilerDelayTimer = reconcilerIntervalTimer = null;
};

// (Re)arm the sweep timers to match config: `render.reconcile.enabled`/`interval` are
// live. `startDelay`/`startJitter` stay restart-scoped — they only shape the first arming.
const syncReconcilerTimers = () => {
	const desired = config.render.reconcile.enabled ? config.render.reconcile.interval : null;
	if (desired === reconcilerArmed) return;

	const wasEnabled = reconcilerArmed !== null;
	clearReconcilerTimers();
	reconcilerArmed = desired;
	if (desired === null) return;

	const run = () => {
		runReconcileOnce().catch(logger.error);
	};

	if (wasEnabled) {
		// Cadence change while running: swap the interval; the next sweep comes on the new
		// cadence rather than immediately.
		reconcilerIntervalTimer = setInterval(run, desired);
		reconcilerIntervalTimer.unref?.();
		return;
	}

	// (Re)enabling arms boot-shaped: delay + per-node stagger. Every node runs this sweep,
	// and a config change (like a rolling restart) reaches them all at the same moment —
	// exactly when they would otherwise all start walking the registry at once.
	// Floor the modulus at 1 so `startJitter: 0` means "no stagger" rather than `% 0` → NaN,
	// which would hand setTimeout a NaN delay and fire everywhere at once — the very thing the
	// stagger exists to prevent.
	const stagger = fnv1a32(server.hostname) % Math.max(1, config.render.reconcile.startJitter | 0);

	reconcilerDelayTimer = setTimeout(() => {
		run();
		reconcilerIntervalTimer = setInterval(run, reconcilerArmed);
		reconcilerIntervalTimer.unref?.();
	}, config.render.reconcile.startDelay + stagger);
	reconcilerDelayTimer.unref?.();
};

// Introspection for tests and the management API: what the timers are currently armed
// with (`armedInterval: null` = disabled).
export const reconcilerTimerState = () => ({ started: reconcilerStarted, armedInterval: reconcilerArmed });

/**
 * Start the periodic sweep on worker 0 of EVERY node — unlike the sitemap refresh, this is
 * not pinned to one node, because each node can only authoritatively check the keys it owns.
 * Called from handleApplication after config is applied. Idempotent. The timers follow
 * config changes (enable/disable, interval) without a restart.
 */
export function startScheduleReconciler() {
	if (server.workerIndex !== 0 || reconcilerStarted) return;
	reconcilerStarted = true;

	syncReconcilerTimers();
	onConfigApplied(syncReconcilerTimers);
}
