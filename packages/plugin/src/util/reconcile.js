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

/**
 * Walk targets in primary-key order and restore any missing schedule row for the keys this
 * node owns. All I/O is injected so the traversal, the ownership filter and the caps are
 * testable without a live database.
 *
 * `searchTargets({ cursor, limit })` must return an ARRAY (a drained batch), not a live
 * iterator: writes must never be issued while a search cursor is still open, since that keeps
 * the read transaction open across them and pins the log against reclamation (the same
 * reason `claim` drains before leasing). Paging by primary key is what keeps each read
 * transaction short — a single walk across a million targets would sit open long enough for
 * Harper to complain about it and commit it out from under us.
 */
export const reconcileSchedules = async ({
	searchTargets,
	getSchedule,
	putSchedule,
	ownerOf,
	hostname,
	batchSize,
	maxRestores,
	onBatch = () => {},
} = {}) => {
	const stats = { examined: 0, owned: 0, restored: 0, truncated: false, lastKey: null };
	let cursor = null;

	for (;;) {
		const batch = await searchTargets({ cursor, limit: batchSize });
		if (!batch.length) break;

		for (const target of batch) {
			const cacheKey = target.cacheKey;
			// Advance the cursor for every row, including ones we skip, so a capped or
			// interrupted run always makes forward progress instead of re-reading its prefix.
			cursor = cacheKey;
			stats.examined++;
			stats.lastKey = cacheKey;

			// Residency is keyed off the URL-half exactly as RenderSchedule's own
			// `setResidencyById` computes it, so this agrees with where the row actually lives.
			if (ownerOf(CacheKey.extractUrl(cacheKey)) !== hostname) continue;
			stats.owned++;

			if (await getSchedule(cacheKey)) continue;

			// A cap on WRITES, not on rows examined: the pathological case is a membership
			// change stranding a large slice of the keyspace at once, and restoring millions of
			// rows in a single pass would be its own outage. Report the truncation so a short
			// count is never mistaken for "all clear".
			if (stats.restored >= maxRestores) {
				stats.truncated = true;
				return stats;
			}

			await putSchedule(cacheKey, {
				// The jittered initial time, NOT "now": a repair pass can restore a great many
				// rows at once, and scheduling them all immediately would replace a silent
				// outage with a render herd. This is the same value the original
				// `RenderTarget.put` would have written, so a repaired target rejoins the
				// rotation exactly where it belonged.
				//
				// `Long` columns can arrive as BigInt, which `Number.isFinite` rejects outright,
				// so coerce before handing it over — `getInitialRenderTime` falls back to the
				// default interval for anything non-finite.
				nextRenderTime: getInitialRenderTime(cacheKey, Number(target.renderInterval)),
				fromSitemap: !!target.sitemapUrl,
			});
			stats.restored++;
		}

		await onBatch(stats);

		// A short page means the index walk is done.
		if (batch.length < batchSize) break;
	}

	return stats;
};

/** `reconcileSchedules` bound to the live tables. */
export const reconcileScheduleGaps = async ({
	batchSize = config.render.reconcile.batchSize,
	maxRestores = config.render.reconcile.maxRestores,
} = {}) => {
	const {
		render_service: { RenderTarget },
		render_schedule: { RenderSchedule },
	} = databases;

	return reconcileSchedules({
		searchTargets: ({ cursor, limit }) =>
			Array.fromAsync(
				RenderTarget.search({
					// Paging by primary key is an ordinary index walk: Harper injects this exact
					// condition shape (`greater_than` on the primary key) for any unconstrained
					// scan, so a cursor is just that scan resumed. The first page passes no
					// condition and lets Harper inject it.
					...(cursor === null
						? {}
						: { conditions: [{ attribute: 'cacheKey', comparator: 'greater_than', value: cursor }] }),
					sort: { attribute: 'cacheKey' },
					select: ['cacheKey', 'renderInterval', 'sitemapUrl'],
					limit,
				})
			),
		// Node-local by construction — see the module comment. Existence is all that matters.
		getSchedule: (cacheKey) => RenderSchedule.get({ id: cacheKey, select: ['cacheKey'] }, { replicateFrom: false }),
		// Writes route by residency, so this reaches the owning node even though the read above
		// deliberately does not.
		putSchedule: (cacheKey, row) => RenderSchedule.put(cacheKey, row),
		ownerOf: getResidencyByUrl,
		hostname: server.hostname,
		batchSize,
		maxRestores,
		// Yield between pages so a sweep over a large registry stays background work.
		onBatch: () => setImmediate(),
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
				`[prerender] schedule reconcile: restored ${stats.restored} missing schedule row(s) across ${stats.owned} owned target(s) (${stats.examined} examined)` +
					(stats.truncated
						? ` — stopped at the ${config.render.reconcile.maxRestores}-restore cap, more may remain`
						: '')
			);
		} else {
			logger.info(
				`[prerender] schedule reconcile: no gaps across ${stats.owned} owned target(s) (${stats.examined} examined)`
			);
		}

		return lastRun;
	} catch (e) {
		lastRun = { node: server.hostname, startedAt, finishedAt: Date.now(), error: e.message };
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
