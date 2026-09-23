/**
 * Deletion of cached pages that no Target owns — PAGE orphans, the population every other sweep is
 * blind to, because every other sweep walks the Target table.
 *
 * WHY THEY EXIST. A `PrerenderedPage` row is only ever removed by `Target.delete`'s cascade, so any
 * target that disappears without it strands its pages: nothing re-renders them (no schedule row),
 * nothing reclaims them (the table has no expiration), and `page_cache` is NOT residency-pinned, so
 * every one of them, blob included, sits on every node. Measured on a four-node deployment: 394,783
 * of 2.73M pages (14.4%, ~19 GB per node) owned no target on ANY node, all cached 4+ weeks earlier:
 *   - 386,594 left by a key-rule orphan sweep that deleted targets through the RAW table (skipping
 *     the cascade) — keys no request can even produce under the current cache-key rules;
 *   - 7,636 written by a render result that landed AFTER its target was retired (the page write was
 *     not target-guarded);
 *   - 553 whose target was removed by some path outside `Target.delete`.
 * They cost more than disk: every page_cache full copy after a replication reconnect walks them,
 * and a copy suspends live replication for that node pair for as long as it runs. And while a stale
 * orphan row exists, a crawler's request for its URL is a `stale` serve rather than a `miss`, which
 * keeps the raw-document cache from ever answering it (see util/rawCache.js).
 *
 * THE PREDICATE, CHEAPEST TEST FIRST. A page is deleted only when ALL hold:
 *   1. this node owns its URL (residency), so the lease check below is authoritative;
 *   2. it was cached at least `minAgeMs` ago — far past any render cadence, so a page a live
 *      rotation maintains can never qualify;
 *   3. it is NOT SERVABLE (`expiresAt + page.swrTtl` has passed), so deleting it cannot change any
 *      serve verdict except `stale` -> `miss`;
 *   4. no Target owns its URL on this node;
 *   5. no render of the URL is in flight.
 * and each is re-checked INSIDE the delete's transaction, immediately before the delete: the page
 * still carries the `lastCached` the walk saw and no target has appeared since. The re-check is not
 * belt and braces. Harper queues a deleted record's blob for unlinking when the delete is STAGED,
 * not when it commits, so a delete that raced a concurrent write of the same key could unlink a blob
 * the surviving record still references — the dangling-blob class the serve path already has to
 * survive (harper#2134). Deleting only keys nothing is writing is what keeps that off the table.
 *
 * A false positive costs nothing a crawler can see. Test 3 means the row was already answered from
 * the origin; the deletion only turns a `stale` into a `miss`, and on a route that discovers, that
 * miss re-mints the target (see util/discoveredPurge.js on why deletion is self-healing). Test 4 is
 * node-local, so a replica missing a target that exists elsewhere reads that page as an orphan —
 * the page is still unservable by test 3, and its URL's rotation lives on the node that owns it.
 *
 * WHY REPLICATED DELETES, AND BATCHED. There is no safe node-local removal: an eviction leaves no
 * tombstone, so the next full copy from any peer that still holds the row restores it. A replicated
 * delete writes a tombstone and an audit entry on every node and ships no blob — a few hundred bytes
 * per key per peer, well under 1% of a page write — so what binds is the COMMIT count on the busiest
 * database, not bytes. Each batch is therefore ONE transaction, run serially, and (when there are
 * peers) held until every peer confirms it: that is the backpressure. A peer that cannot confirm
 * stalls the sweep instead of letting it outrun replication. `ratePerSecond` is a ceiling on top.
 *
 * MANUAL ONLY, DRY-RUN BY DEFAULT, OWNER-SCOPED — the discovered-target purge's shape, for its
 * reasons: it deletes corpus, so it runs when someone decides to; a bare start is a census; and each
 * node covers only the keys it owns, so run it on every node. Deletes replicate, so each node
 * removes exactly its owned slice from the whole cluster once.
 */

import { setImmediate as yieldNow, setTimeout as sleep } from 'node:timers/promises';
import { config } from '../config.js';
import { CacheKey } from './cacheKey.js';
import { getNodes, getResidencyByUrl } from './residency.js';
import { leaseInfo } from './renderSchedule.js';
import { scheduleKeysOf } from '../resources/Target.js';
import { walkUrlRange } from './urlWalk.js';
import {
	claimRun,
	finishRun,
	isRunning,
	makeCancelPoller,
	makeHeartbeat,
	publishRunState,
	readRunState,
	requestCancel,
} from './runState.js';

const YIELD_EVERY = 200;
const CHUNK_SIZE = 10_000;
// Consecutive failed batches that end the pass. One fault is a batch for the next pass; a fault on
// every batch is the storage engine or a peer saying stop.
const MAX_CONSECUTIVE_ERRORS = 5;

/** A stored `Date` (or number, or ISO string) as epoch ms; NaN when it cannot be read. */
const epochMs = (value) => (value === null || value === undefined ? NaN : new Date(value).getTime());

/**
 * One sweep pass over a page stream. ALL I/O is injected (the discoveredPurge pattern), so the
 * predicate, the owner scope, the batching, the pacing and the cancel path are testable without
 * Harper globals. `stats` is mutated IN PLACE so a live status read reports real progress.
 *
 * `deleted` counts would-be deletions in a dry run: the census an operator sizes the real run with.
 */
export const sweepOrphanedPages = async ({
	rows,
	ownerOf,
	hostname,
	targetExists,
	isLeased,
	deleteBatch,
	minAgeMs,
	swrTtl,
	maxDeletes,
	ratePerSecond,
	batchSize,
	dryRun,
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
			try {
				const { deleted, changed } = await deleteBatch(batch);
				stats.deleted += deleted;
				stats.changed += changed;
				consecutiveErrors = 0;
			} catch (e) {
				stats.errors++;
				consecutiveErrors++;
				if (stats.errorSamples.length < 3) stats.errorSamples.push(e?.message ?? String(e));
				if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
					stats.abortedOnErrors = true;
					throw new Error(
						`page orphan sweep stopped after ${consecutiveErrors} consecutive failed batches ` +
							`(last: ${e?.message ?? String(e)})`
					);
				}
			}
		}
		const window = (batch.length / Math.max(1, ratePerSecond)) * 1000;
		const elapsed = now() - started;
		batch.length = 0;
		if (elapsed < window) await pause(window - elapsed);
	};

	for await (const row of rows) {
		if (isCanceled()) {
			stats.canceled = true;
			break;
		}
		stats.examined++;
		if (stats.examined % YIELD_EVERY === 0) await onYield();

		const url = CacheKey.urlOf(row.cacheKey);
		if (!url) continue;
		if (ownerOf(url) !== hostname) continue;
		stats.owned++;

		// An unreadable timestamp is "cannot tell", which is never a reason to delete.
		const cachedAt = epochMs(row.lastCached);
		const at = now();
		if (!(at - cachedAt >= minAgeMs)) continue;
		stats.old++;

		const expiresAt = epochMs(row.expiresAt);
		if (!(expiresAt + swrTtl <= at)) {
			stats.servableSkipped++;
			continue;
		}

		if (await targetExists(url)) {
			stats.targeted++;
			continue;
		}

		if (isLeased(url)) {
			stats.leaseSkipped++;
			continue;
		}
		stats.orphaned++;

		// Past the cap we keep counting but stop deleting, so the population is measured in full.
		if (stats.deleted + batch.length >= maxDeletes) {
			stats.truncated = true;
			continue;
		}
		batch.push({ cacheKey: row.cacheKey, url, lastCachedMs: cachedAt });
		if (batch.length >= batchSize) await flush();
	}
	await flush();

	return stats;
};

const newStats = () => ({
	examined: 0,
	owned: 0,
	old: 0,
	servableSkipped: 0,
	targeted: 0,
	leaseSkipped: 0,
	orphaned: 0,
	deleted: 0,
	changed: 0,
	unreadable: 0,
	truncated: false,
	errors: 0,
	errorSamples: [],
	abortedOnErrors: false,
	canceled: false,
});

/**
 * Delete one batch in ONE transaction, re-checking every key inside it (see the module comment on
 * why the re-check is load-bearing). `replicatedConfirmation` holds the commit until that many peers
 * confirm it. Returns how many were deleted and how many had changed since the walk saw them.
 */
export const deletePageBatch = async (batch, { replicatedConfirmation = 0 } = {}) => {
	const pages = databases.page_cache.PrerenderedPage;
	const targets = databases.render_service.Target;
	let deleted = 0;
	let changed = 0;
	const run = async () => {
		for (const { cacheKey, url, lastCachedMs } of batch) {
			const page = await pages.get({ id: cacheKey, select: ['cacheKey', 'lastCached'] });
			if (!page || epochMs(page.lastCached) !== lastCachedMs || (await targets.get({ id: url, select: ['url'] }))) {
				changed++;
				continue;
			}
			await pages.delete(cacheKey);
			deleted++;
		}
	};
	await (replicatedConfirmation > 0 ? transaction({ replicatedConfirmation }, run) : transaction(run));
	return { deleted, changed };
};

const KEY = 'page_orphan_sweep';
const SWEEP_STALE_MS = 120_000;

/** Live progress + last-run summary for the management API, from ANY worker on this node. */
export const getPageOrphanSweepState = async () => {
	const row = await readRunState(KEY);
	if (!row) return { running: false };
	if (isRunning(row, SWEEP_STALE_MS)) {
		return row.progress ?? { running: true, node: row.node, startedAt: row.startedAt };
	}
	return row.lastRun ?? { running: false };
};

/** Request a cooperative stop; the pass ends at its next row, whichever worker is running it. */
export const stopPageOrphanSweep = async () => {
	await requestCancel(KEY);
	return getPageOrphanSweepState();
};

/**
 * Start one detached, owner-scoped sweep pass on THIS node. Returns the initial state; progress and
 * the outcome live on `getPageOrphanSweepState`.
 */
export const startPageOrphanSweep = async ({
	dryRun = config.render.pageOrphanSweep.dryRun,
	minAgeMs = config.render.pageOrphanSweep.minAge,
	maxDeletes = config.render.pageOrphanSweep.maxDeletes,
	ratePerSecond = config.render.pageOrphanSweep.ratePerSecond,
	batchSize = config.render.pageOrphanSweep.batchSize,
} = {}) => {
	const claim = await claimRun(KEY, { staleMs: SWEEP_STALE_MS });
	if (!claim.claimed) {
		return { started: false, alreadyRunning: true, state: claim.row?.progress ?? { running: false } };
	}

	const replicatedConfirmation = config.render.pageOrphanSweep.confirmReplication
		? Math.max(0, getNodes().length - 1)
		: 0;
	const stats = {
		running: true,
		node: server.hostname,
		dryRun,
		minAgeMs,
		maxDeletes,
		ratePerSecond,
		batchSize,
		replicatedConfirmation,
		startedAt: Date.now(),
		finishedAt: null,
		error: null,
		...newStats(),
		ownerScopeNote: 'Sweeps only the pages whose URL this node owns; run on every node to cover the keyspace.',
	};

	const beat = makeHeartbeat(KEY);
	await publishRunState(KEY, { progress: { ...stats } });
	sweepOrphanedPages({
		rows: walkUrlRange(databases.page_cache.PrerenderedPage, {
			key: 'cacheKey',
			select: ['cacheKey', 'lastCached', 'expiresAt'],
			chunkSize: CHUNK_SIZE,
			onUnreadable: () => {
				stats.unreadable++;
			},
		}),
		ownerOf: getResidencyByUrl,
		hostname: server.hostname,
		// Target is not residency-pinned, so this is a plain node-local point read.
		targetExists: async (url) => Boolean(await databases.render_service.Target.get({ id: url, select: ['url'] })),
		isLeased: (url) => scheduleKeysOf(url).some((key) => Boolean(leaseInfo(key))),
		deleteBatch: (batch) => deletePageBatch(batch, { replicatedConfirmation }),
		minAgeMs,
		swrTtl: config.page.swrTtl,
		maxDeletes,
		ratePerSecond,
		batchSize,
		dryRun,
		onYield: async () => {
			beat({ ...stats });
			await yieldNow();
		},
		isCanceled: makeCancelPoller(KEY),
		stats,
	})
		.catch((e) => {
			stats.error = e?.message ?? String(e);
			logger.error(e, '[prerender] page orphan sweep failed');
		})
		.finally(async () => {
			stats.running = false;
			stats.finishedAt = Date.now();
			await finishRun(KEY, { ...stats });
			logger.warn(
				`[prerender] page orphan sweep ${stats.canceled ? 'stopped' : 'finished'}` +
					`${stats.dryRun ? ' (DRY RUN, nothing deleted)' : ''}: ${stats.dryRun ? 'would delete' : 'deleted'} ` +
					`${stats.deleted} of ${stats.orphaned} orphaned page(s) (${stats.owned} owned of ${stats.examined} ` +
					`examined; ${stats.old} old enough, ${stats.servableSkipped} still servable, ` +
					`${stats.targeted} with a target, ${stats.leaseSkipped} in flight` +
					`${stats.changed ? `, ${stats.changed} changed before delete` : ''}` +
					`${stats.unreadable ? `, ${stats.unreadable} unreadable row(s) skipped` : ''}` +
					`${stats.errors ? `, ${stats.errors} failed batch(es)` : ''})` +
					`${stats.truncated ? ` — the rest left for the next pass by the ${stats.maxDeletes}-delete cap` : ''}` +
					`${stats.error ? ` — error: ${stats.error}` : ''}`
			);
		});

	return { started: true, alreadyRunning: false, state: stats };
};

/** Test seam: clear the node's published row. */
export const resetPageOrphanSweepState = () =>
	publishRunState(KEY, { running: false, heartbeatAt: null, cancelRequested: false, progress: null, lastRun: null });
