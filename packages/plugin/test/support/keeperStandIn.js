/**
 * A stand-in for the queue keeper, for tests that drive `RenderQueue.claim` against a fake
 * `RenderSchedule` map: publish every due row as the ready set, oldest due first, and mark the keeper
 * live, so a claim is served exactly as it is in production — from the set, each entry checked
 * against its row. The keeper itself (ordering, ownership, subscription) is tested in
 * `queueKeeperService.test.js`; here only the claim and result paths are under test.
 *
 * `funnel` is the imported `util/renderSchedule.js`, passed in so this module needs no Harper
 * globals at import time.
 */
export const publishDueRows = (funnel, rows, nowMs = Date.now()) => {
	const due = [...rows.entries()]
		.map(([cacheKey, row]) => ({ cacheKey, dueAt: Number(row.nextRenderTime), fromSitemap: !!row.fromSitemap }))
		.filter((entry) => Number.isFinite(entry.dueAt) && entry.dueAt <= nowMs)
		.sort((a, b) => a.dueAt - b.dueAt);
	funnel.publishKeeperSet(due.map((entry) => ({ entry, score: 0 })));
	funnel.setKeeperSignal({ due: due.length, nowMs });
};
