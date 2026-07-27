/**
 * Repair for targets whose `RenderSchedule` row has gone missing.
 *
 * `RenderTarget` and `RenderSchedule` live in separate databases, so creating a target is
 * two independent commits — and the schedule half is residency-routed to whichever node owns
 * the URL. If that second write is lost (a crash between them, or a routed write to a node
 * whose replication link is unhealthy), or if cluster membership changes and moves a key's
 * owner, the target survives with no schedule row.
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

import { setImmediate } from 'node:timers/promises';
import { config } from '../config.js';
import { CacheKey } from './cacheKey.js';
import { fnv1a32 } from './hash.js';
import { getResidencyByUrl } from './residency.js';
import { getInitialRenderTime } from './time.js';

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
	maxRestores,
	onYield = () => {},
} = {}) => {
	const stats = { examined: 0, owned: 0, missing: 0, restored: 0, truncated: false };
	const toRestore = [];

	// Phase 1 — read only.
	for await (const target of streamTargets()) {
		stats.examined++;
		if (stats.examined % YIELD_EVERY === 0) await onYield();

		const cacheKey = target.cacheKey;

		// Residency is keyed off the URL-half exactly as RenderSchedule's own
		// `setResidencyById` computes it, so this agrees with where the row actually lives.
		if (ownerOf(CacheKey.extractUrl(cacheKey)) !== hostname) continue;
		stats.owned++;

		if (await getSchedule(cacheKey)) continue;
		stats.missing++;

		// Past the cap we keep counting but stop collecting, so the gap is measured in full
		// while the repair stays bounded. A membership change can strand a large slice of the
		// keyspace at once, and rewriting millions of rows in one pass would be its own outage.
		if (toRestore.length < maxRestores) toRestore.push(target);
	}

	// Phase 2 — writes, with the scan's cursor now closed.
	for (const target of toRestore) {
		await putSchedule(target.cacheKey, {
			// The jittered initial time, NOT "now": a repair pass can restore a great many rows at
			// once, and scheduling them all immediately would replace a silent outage with a
			// render herd. This is the same value the original `RenderTarget.put` would have
			// written, so a repaired target rejoins the rotation exactly where it belonged.
			//
			// `Long` columns can arrive as BigInt, which `Number.isFinite` rejects outright, so
			// coerce before handing it over. No range check is needed here: the callee guards
			// `Number.isFinite(interval) && interval > 0`, so a NON-POSITIVE value falls back to
			// the default too — `Number(null)` is 0, which that guard rejects.
			nextRenderTime: getInitialRenderTime(target.cacheKey, Number(target.renderInterval)),
			fromSitemap: !!target.sitemapUrl,
		});
		stats.restored++;
	}

	stats.truncated = stats.missing > stats.restored;

	return stats;
};

/** `reconcileSchedules` bound to the live tables. */
export const reconcileScheduleGaps = async ({ maxRestores = config.render.reconcile.maxRestores } = {}) => {
	const {
		render_service: { RenderTarget },
		render_schedule: { RenderSchedule },
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
		streamTargets: () => RenderTarget.search({ select: ['cacheKey', 'renderInterval', 'sitemapUrl'] }),
		// Node-local by construction — see the module comment. Existence is all that matters.
		getSchedule: (cacheKey) => RenderSchedule.get({ id: cacheKey, select: ['cacheKey'] }, { replicateFrom: false }),
		// Writes route by residency, so this reaches the owning node even though the read above
		// deliberately does not.
		putSchedule: (cacheKey, row) => RenderSchedule.put(cacheKey, row),
		ownerOf: getResidencyByUrl,
		hostname: server.hostname,
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

/**
 * Start the periodic sweep on worker 0 of EVERY node — unlike the sitemap refresh, this is
 * not pinned to one node, because each node can only authoritatively check the keys it owns.
 * Called from handleApplication after config is applied. Idempotent.
 */
export function startScheduleReconciler() {
	if (server.workerIndex !== 0 || reconcilerStarted) return;
	if (!config.render.reconcile.enabled) return;

	reconcilerStarted = true;

	const run = () => {
		runReconcileOnce().catch(logger.error);
	};

	// Stagger the first pass per node. Every node runs this sweep, and a rolling restart is
	// exactly when they would otherwise all start walking the registry at the same moment.
	// Floor the modulus at 1 so `startJitter: 0` means "no stagger" rather than `% 0` → NaN,
	// which would hand setTimeout a NaN delay and fire everywhere at once — the very thing the
	// stagger exists to prevent.
	const stagger = fnv1a32(server.hostname) % Math.max(1, config.render.reconcile.startJitter | 0);

	setTimeout(() => {
		run();
		setInterval(run, config.render.reconcile.interval).unref?.();
	}, config.render.reconcile.startDelay + stagger).unref?.();
}
