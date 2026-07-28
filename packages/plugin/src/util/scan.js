/**
 * Bounded scan-then-write, because Harper takes long transactions away from you.
 *
 * Two independent mechanisms in Harper core end a transaction that stays open too long:
 *
 *  1. The long-transaction monitor (`DatabaseTransaction`, `storage_maxTransactionOpenTime`,
 *     default 30s). Its discriminator is `hasPendingWrites()` AT THE MOMENT IT FIRES:
 *       - pending writes  -> the transaction is ABORTED and poisoned. Every later write or
 *         commit throws "Transaction was aborted after exceeding the open-transaction limit;
 *         split long-running work into smaller transactions" (HTTP 422). Core deliberately
 *         refuses to force-commit a partial write set, because that can strand secondary-index
 *         entries that only a full index rebuild repairs.
 *       - no pending writes -> the transaction is COMMITTED to release the snapshot and its
 *         clock is reset. Not poisoned, so a read-only scan survives this indefinitely.
 *  2. The stale read-transaction reaper (`RecordEncoder`, `storage_maxReadTransactionOpenTime`,
 *     default 300s, ticking every 15s). It logs an error once a read transaction has been open
 *     past ~45s and force-closes it past the limit.
 *
 * So the dangerous shape is not "a long scan" — it is "a cursor that is still open while writes
 * are pending". A `for await` over a table search that patches or puts as it goes is exactly
 * that, and it fails as a 422 with work already half-applied.
 *
 * The fix is structural rather than a bigger timeout: collect what needs changing while the
 * cursor is open and write NOTHING, let the cursor close, then apply the writes in bounded
 * batches. `util/reconcile.js` already works this way and says why; these helpers make it the
 * default for every registry walk instead of a convention each call site has to remember.
 *
 * All I/O is injected, so the traversal, the cap and the batching are testable without a live
 * database.
 */

import { config } from '../config.js';

/**
 * Phase 1 — read only. Walk `scan()` and collect what `pick` returns for each row.
 *
 * `pick` returns the value to collect, or `undefined`/`null` to skip the row. It MUST NOT write:
 * that is the whole point (see the module comment). It may be async — the sitemap prune needs a
 * classification per row — and rows are counted whether or not they are collected.
 *
 * Yields to the event loop every `yieldEvery` rows SCANNED, not every row collected. A walk that
 * collects almost nothing (the healthy case) would otherwise never yield, and `await` on a cursor
 * drains microtasks without letting timers or I/O callbacks run.
 *
 * The cap bounds MEMORY, not scanning: the walk always runs to completion so `examined` is the
 * true size of the registry, and `truncated` says whether the caller is acting on a partial set.
 * Bounding the collection matters at 1M+ targets, where buffering every key is its own outage.
 */
export const collectFromScan = async ({
	scan,
	pick,
	cap = config.scan.collectCap,
	yieldEvery = config.scan.yieldEvery,
	onYield = () => new Promise(setImmediate),
} = {}) => {
	const items = [];
	let examined = 0;

	for await (const row of scan()) {
		examined++;
		if (examined % yieldEvery === 0) await onYield();

		// Past the cap we keep scanning but stop collecting, so the count stays honest.
		if (items.length >= cap) continue;

		const picked = await pick(row);
		if (picked !== undefined && picked !== null) items.push(picked);
	}

	return { items, examined, truncated: items.length >= cap };
};

/**
 * Phase 2 — writes, with the scan's cursor now closed.
 *
 * Applies `apply` to each item in batches of `batchSize`, awaiting each batch before starting the
 * next and yielding between them. Awaiting per batch is what keeps pending writes from
 * accumulating across a monitor tick: a drained batch has no pending writes, so the monitor takes
 * the harmless commit-and-reset branch instead of the abort branch.
 *
 * Returns the number applied. A batch that rejects propagates — a poisoned transaction must not
 * look like a successful pass.
 */
export const applyInBatches = async ({
	items,
	apply,
	batchSize = config.scan.batchSize,
	onYield = () => new Promise(setImmediate),
} = {}) => {
	let applied = 0;

	for (let start = 0; start < items.length; start += batchSize) {
		const batch = items.slice(start, start + batchSize);
		await Promise.all(batch.map((item, index) => apply(item, start + index)));
		applied += batch.length;
		if (start + batchSize < items.length) await onYield();
	}

	return applied;
};
