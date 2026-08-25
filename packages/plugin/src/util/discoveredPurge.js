/**
 * Bulk removal of DISCOVERED targets under a URL prefix — the cleanup half of the discovery
 * gate (`ingress.routes[].discoverTargets` / `ingress.discoveryBots`).
 *
 * WHY THIS EXISTS. Traffic discovery on a combinatorial URL space (faceted navigation) mints
 * every novel link a crawler walks into a permanent render obligation: the corpus grows without
 * bound and the schedule spends the fleet on pages nothing asked for twice. The gate stops NEW
 * minting; this removes what was already minted. The predicate is `sitemapUrl` null under the
 * given prefix — a target no sitemap ever declared, i.e. one that exists only because a crawler
 * once requested it. Deletion is self-healing in the worst case: a URL that mattered is
 * re-served from the origin on its next request and — where the gate still allows it —
 * re-discovered.
 *
 * GATE FIRST, THEN PURGE. Purging a prefix whose route still allows discovery just re-mints the
 * junk from the next crawl. `startDiscoveredPurge` refuses a prefix whose matched route does not
 * set `discoverTargets: false` unless `force` is passed — the ordering is encoded in the API
 * because getting it wrong looks identical to success for a week.
 *
 * PER-NODE AND OWNER-SCOPED, like `util/orphanSweep.js` and for the same reason: the lease check
 * that keeps a delete from landing mid-render reads THIS node's shared lease buffer, so only the
 * key's owner can answer it. Run the purge on every node to cover the keyspace; deletes
 * replicate, so each node removes exactly its owned slice once.
 *
 * PACED, because the cascade is wide: one target delete fans out to its schedule rows, its
 * cached pages (blobs included) and its probe baseline, each of which is an audited, replicated
 * write. A multi-million-row purge at full speed is its own outage — `ratePerSecond` bounds the
 * target-per-second rate the way the change probe's sweep bounds origin requests.
 *
 * The walk is a chunked one-sided keyset scan over the URL primary key (the changeProbe
 * `walkTargets` shape): each chunk's read transaction closes before any delete runs (the
 * util/scan.js discipline), and a missed row is only a row for the next pass — the predicate is
 * per-row, so ordering can never delete the wrong thing, and the purge is re-runnable until a
 * pass reports zero.
 */

import { setImmediate as yieldNow, setTimeout as sleep } from 'node:timers/promises';
import { Target, cacheKeysOf } from '../resources/Target.js';
import { classifyUrl, PRERENDER } from './routeClass.js';
import { getResidencyByUrl } from './residency.js';
import { leaseInfo } from './renderSchedule.js';
import { walkUrlRange } from './urlWalk.js';

/**
 * Has the demand ladder stamped a rung on this target? Coerced before the finite check for the
 * reason `resolveRenderInterval` does it: a `Long` column can surface as a BigInt, which
 * `Number.isFinite` rejects outright — and here that would read a VISITED page as unvisited and
 * delete it, so the coercion is load-bearing rather than tidy.
 */
const isVisited = (demandInterval) => {
	const rung = Number(demandInterval);
	return Number.isFinite(rung) && rung > 0;
};

const YIELD_EVERY = 200;
const CHUNK_SIZE = 10_000;
const DELETE_BATCH = 20;
// Consecutive delete failures that end the pass. One fault is a row for the next pass; a fault
// on every row in a row is the storage engine saying stop, not something to grind through.
const MAX_CONSECUTIVE_ERRORS = 25;

/** The registry slice under `urlPrefix`, streamed in cursor-bounded chunks (see module comment). */
export async function* walkPrefix(table, urlPrefix, chunkSize = CHUNK_SIZE, onUnreadable) {
	// The exclusive upper key for the verification probes: the prefix with its last character
	// incremented, so a row from the NEXT keyspace region can neither resume nor fail this walk.
	const endBound = urlPrefix.slice(0, -1) + String.fromCharCode(urlPrefix.charCodeAt(urlPrefix.length - 1) + 1);
	for await (const row of walkUrlRange(table, {
		startAt: urlPrefix,
		select: ['url', 'sitemapUrl', 'demandInterval'],
		chunkSize,
		onUnreadable,
		endBound,
	})) {
		// Rows are key-ordered, so the first URL outside the prefix ends the whole walk.
		if (!row.url.startsWith(urlPrefix)) return;
		yield row;
	}
}

/**
 * One purge pass over a row stream. ALL I/O is injected (the orphanSweep/runProbePass pattern),
 * so the predicate, the owner scope, the lease deferral, the pacing and the cancel path are
 * testable without Harper globals. `stats` is mutated IN PLACE so a live status read reports
 * real progress, not a snapshot from whenever the pass finishes.
 *
 * `deleted` counts would-be deletions in a dry run (same semantics as the orphan sweep): the
 * census an operator sizes the real run with.
 */
export const purgeDiscoveredTargets = async ({
	rows,
	ownerOf,
	hostname,
	isLeased,
	deleteTarget,
	dryRun,
	ratePerSecond,
	skipVisited = false,
	batchSize = DELETE_BATCH,
	isCanceled = () => false,
	now = Date.now,
	pause = sleep,
	onYield = () => yieldNow(),
	stats,
}) => {
	const batch = [];
	let consecutiveErrors = 0;

	const flush = async () => {
		if (!batch.length) return;
		const started = now();
		if (dryRun) {
			stats.deleted += batch.length;
		} else {
			// ONE AT A TIME, never `Promise.all` over the batch.
			//
			// Each delete cascades to the target's schedule rows, its cached pages and its probe
			// baseline, so a batch issued concurrently put hundreds of writes in flight at once.
			// Harper commits those on the request's own thread, and once a commit has been
			// outstanding past its limit that thread REJECTS every application write on it with
			// 503 until the commit settles. Deletes and replicated writes are exempt from that
			// check — so the purge never feels its own backpressure, and what ate the rejections
			// instead was the render fleet posting results back: ~2,000 completed renders
			// discarded in 30 minutes, measured, plus a thread left latched in the rejecting
			// state until the process restarted.
			//
			// Serialized, the purge self-limits to what the storage engine can absorb: when
			// deletes get slower the batch takes longer, the pacing window is already spent, and
			// the sweep simply proceeds at the achievable rate. `ratePerSecond` stays a CEILING
			// rather than a target it will chase past the engine's capacity.
			for (const url of batch) {
				try {
					await deleteTarget(url);
					stats.deleted++;
					consecutiveErrors = 0;
				} catch (e) {
					stats.errors++;
					consecutiveErrors++;
					if (stats.errorSamples.length < 3) {
						stats.errorSamples.push({ url, error: e?.message ?? String(e) });
					}
					if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
						stats.abortedOnErrors = true;
						throw new Error(
							`discovery purge stopped after ${consecutiveErrors} consecutive delete failures ` +
								`(last: ${e?.message ?? String(e)})`
						);
					}
				}
			}
		}
		const window = (batch.length / Math.max(1, ratePerSecond)) * 1000;
		const elapsed = now() - started;
		batch.length = 0;
		// Paced in the dry run too: the walk itself reads the same index the claim scan works,
		// and the census being a bit slower beats perturbing a saturated queue to count faster.
		if (elapsed < window) await pause(window - elapsed);
	};

	for await (const row of rows) {
		if (isCanceled()) {
			stats.canceled = true;
			break;
		}
		stats.examined++;
		if (stats.examined % YIELD_EVERY === 0) await onYield();

		if (ownerOf(row.url) !== hostname) continue;
		stats.owned++;

		// The predicate: never sitemap-declared. A linked target is live corpus whatever its
		// traffic looks like — the sitemap is the operator's statement of what should exist.
		if (row.sitemapUrl !== null && row.sitemapUrl !== undefined && row.sitemapUrl !== '') continue;
		stats.discovered++;

		// `skipVisited` spares anything the demand ladder has PROMOTED. A stored `demandInterval`
		// is not a guess: the ladder writes a rung only after a bot visited the URL in each of
		// `promoteWindows` consecutive windows, so it is durable evidence of repeat crawler demand
		// on a page no sitemap declares. Measured on a commerce corpus, 40% of never-declared
		// product pages carried one — deleting those would discard live, served pages and let the
		// crawler re-mint them, paying a delete and a re-render to arrive back where we started.
		//
		// It is a ONE-SIDED test, deliberately: a stamp proves demand, its absence only means no
		// repeat visit was observed within the ladder's windows. That asymmetry is the safe
		// direction here — the cost of sparing a dead page is one row, the cost of deleting a live
		// one is a re-mint cycle and a cache miss for whoever asked.
		if (skipVisited && isVisited(row.demandInterval)) {
			stats.visitedSkipped++;
			continue;
		}

		// Defer anything in flight, exactly as the orphan sweep does: correctness does not
		// depend on it (a result whose target is gone retires its own schedule row), but the
		// un-target-guarded PrerenderedPage.put on that path would strand a page record.
		if (isLeased(row.url)) {
			stats.leaseSkipped++;
			continue;
		}

		batch.push(row.url);
		if (batch.length >= batchSize) await flush();
	}
	await flush();

	return stats;
};

// ---- the live wrapper ---------------------------------------------------------------------

const newStats = () => ({
	examined: 0,
	unreadable: 0,
	owned: 0,
	discovered: 0,
	leaseSkipped: 0,
	deleted: 0,
	visitedSkipped: 0,
	errors: 0,
	errorSamples: [],
	abortedOnErrors: false,
	canceled: false,
});

let state = null;
let cancelRequested = false;

/** Live progress + last-run summary for the management API. */
export const getDiscoveredPurgeState = () => state ?? { running: false };

/** Request a cooperative stop; the pass ends at its next row. */
export const stopDiscoveredPurge = () => {
	if (state?.running) cancelRequested = true;
	return getDiscoveredPurgeState();
};

/**
 * Validate a prefix + the gate interlock, without starting anything. Returns the compiled
 * refusal (an Error with statusCode 400) or null when the purge may start. Split out so the
 * admin layer can surface a precise message and tests can cover each refusal.
 */
export const validatePurgePrefix = (urlPrefix, { force = false } = {}) => {
	const parsed = typeof urlPrefix === 'string' ? URL.parse(urlPrefix) : null;
	if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
		return badRequest(`urlPrefix must be an absolute http(s) URL prefix, got ${String(urlPrefix)}`);
	}
	// A bare origin is refused unconditionally — "delete every discovered target on the site"
	// deserves per-prefix intent, not one typo'd slash.
	if (parsed.pathname === '/' || parsed.pathname === '') {
		return badRequest(`urlPrefix must include a path beyond '/' — purge per route prefix, not a whole origin`);
	}
	const { routeClass, entry } = classifyUrl(urlPrefix);
	if (routeClass !== PRERENDER) {
		return badRequest(
			`urlPrefix matches no prerender route (${routeClass}) — nothing on it is scheduled, so there is nothing to purge`
		);
	}
	if (!force && entry && entry.discoverTargets !== false) {
		return badRequest(
			`the matched route "${entry.match} ${entry.path}" still allows discovery — gate it first ` +
				`(discoverTargets: false) or crawlers re-mint what this purge removes; pass force: true to override`
		);
	}
	return null;
};

const badRequest = (message) => Object.assign(new Error(message), { statusCode: 400 });

/**
 * Start one detached, owner-scoped purge pass on THIS node. Returns the initial state;
 * progress and the outcome live on `getDiscoveredPurgeState`.
 */
export const startDiscoveredPurge = ({
	urlPrefix,
	dryRun = true,
	ratePerSecond = 200,
	force = false,
	skipVisited = false,
} = {}) => {
	if (state?.running) return { started: false, alreadyRunning: true, state };
	const refusal = validatePurgePrefix(urlPrefix, { force });
	if (refusal) throw refusal;

	cancelRequested = false;
	state = {
		running: true,
		node: server.hostname,
		urlPrefix,
		dryRun,
		ratePerSecond,
		skipVisited,
		startedAt: Date.now(),
		finishedAt: null,
		error: null,
		...newStats(),
		ownerScopeNote: 'Purges only the keys this node owns; run on every node to cover the keyspace.',
	};

	const stats = state;
	purgeDiscoveredTargets({
		rows: walkPrefix(databases.render_service.Target, urlPrefix, undefined, () => {
			stats.unreadable++;
		}),
		ownerOf: getResidencyByUrl,
		hostname: server.hostname,
		// Any leased device key defers the whole target — the delete takes every device with it.
		isLeased: (url) => cacheKeysOf(url).some((cacheKey) => Boolean(leaseInfo(cacheKey))),
		// The RESOURCE class delete, never the raw table's: only it cascades to the schedule
		// rows, the cached pages and the probe baseline. A raw delete leaves schedule rows that
		// re-render once each and page blobs that nothing ever reclaims.
		deleteTarget: (url) => Target.delete(url),
		dryRun,
		ratePerSecond,
		skipVisited,
		isCanceled: () => cancelRequested,
		stats,
	})
		.catch((e) => {
			stats.error = e?.message ?? String(e);
			logger.error(e, '[prerender] discovery purge failed');
		})
		.finally(() => {
			stats.running = false;
			stats.finishedAt = Date.now();
			const verb = stats.dryRun ? 'would delete' : 'deleted';
			logger.warn(
				`[prerender] discovery purge ${stats.canceled ? 'stopped' : 'finished'}: ${verb} ${stats.deleted} ` +
					`discovered target(s) under ${stats.urlPrefix} (${stats.owned} owned of ${stats.examined} examined, ` +
					`${stats.leaseSkipped} deferred as in-flight` +
					// Skipped rows are retried by the next pass, so a pass that ended with them is
					// INCOMPLETE for its prefix even when it reports no error — say so here rather
					// than leaving an operator to infer it from a count that does not add up.
					`${stats.visitedSkipped ? `, ${stats.visitedSkipped} spared as bot-visited` : ''}` +
					`${stats.unreadable ? `, ${stats.unreadable} unreadable row(s) skipped` : ''}` +
					`${stats.errors ? `, ${stats.errors} failed and left for the next pass` : ''})` +
					`${stats.error ? ` — error: ${stats.error}` : ''}`
			);
		});

	return { started: true, alreadyRunning: false, state };
};

/** Test seam. */
export const resetDiscoveredPurgeState = () => {
	state = null;
	cancelRequested = false;
};
