/**
 * WHICH OF THE DUE ROWS GOES FIRST.
 *
 * `claim` orders by `nextRenderTime` and nothing else, and `util/failureBackoff.js` states the
 * consequence plainly: "deprioritize this" and "make it due later" are the same statement, which is
 * why none of this needs a priority column or a second index. THE INDEX HALF OF THAT STILL HOLDS and
 * is the constraint this module works inside — there is still exactly one indexed attribute on
 * `RenderSchedule`, still one seek from the claim floor, and still one condition on the query. What
 * does not hold is the claim that a due time alone expresses priority, because once two rows are both
 * past due their relative order is fixed by due times, and a due time encodes when a page last
 * rendered plus its cadence — not how much it matters:
 *
 *     home  (1h cadence)   due 2h ago   -> 2 intervals late, serving a page 3h old
 *     PDP  (48h cadence)   due 3h ago   -> 0.06 intervals late, serving a page 51h old
 *
 * Index order gives the PDP the lease, because 3h > 2h. Every signal reads as healthy: the floor is
 * advancing, the scan is fast, nothing is wedged. The homepage is simply always behind a wall of
 * PDPs that are each a few minutes older in absolute terms, and the only visible symptom is the one
 * `config.yaml` already describes — worst-case served age of `interval + swrTtl`, which is 7x the
 * homepage's cadence and 0.125x a PDP's.
 *
 * So priority is still a function of due time. It is just measured in units of the page's OWN
 * cadence rather than in absolute milliseconds:
 *
 *     overdue ratio = max(0, now - dueAt) / renderInterval
 *
 * ── WHY LATENESS AND NOT AGE ────────────────────────────────────────────────────────────────────
 *
 * The tempting form is `(now - lastRender) / interval`, i.e. staleness relative to cadence, which is
 * the same number plus one and reads better. It is WRONG here, because `dueAt - interval` is not
 * when the page last rendered for every row in the table. Three writers deliberately schedule a gap
 * that is not the cadence: `Target.suppress` writes `render.suppression.recheckInterval` (7 days),
 * `backoffWait` writes up to `render.failureRetry.maxBackoff`, and `maybeUnpinFloor` pushes a row
 * forward by `render.defaultInterval` regardless of its route. Under the age form, a 7-day
 * suppression recheck on a 48h route arrives at the head of the queue reading as 3.5 intervals stale
 * and outranks a genuinely late homepage — i.e. the rows we most want to DEPRIORITIZE would be
 * promoted, and the suppression-recheck load this release exists to reduce would get there first.
 *
 * Lateness has no such coupling: it is zero at the moment a row comes due whatever gap preceded it,
 * so a recheck or a backed-off retry enters at the BACK of the due set and climbs from there like
 * anything else. That is the property worth the slightly worse-reading formula.
 *
 * ── STARVATION IS BOUNDED, AND THE BOUND IS STATABLE ────────────────────────────────────────────
 *
 * `sitemapBoost` is a MULTIPLIER on the ratio, never an additive tier or a separate lane. A lane
 * would let a large sitemap corpus starve discovered URLs outright; a multiplier cannot, because the
 * ratio of a row that is not being served grows without bound while the boost stays constant. A
 * non-sitemap row wins as soon as its ratio exceeds `boost x` the highest sitemap ratio in the
 * window, so if the sitemap set is being held at `U` intervals late, a discovered URL is served by
 * `boost x U` intervals late — at the default boost of 2 with sitemap pages held ~1.2 intervals
 * late, a discovered 48h PDP renders within ~115h. Whether that bound is comfortable is a judgement
 * about the corpus; that there IS one is a property of the formula.
 *
 * ── WHAT THIS CANNOT DO ─────────────────────────────────────────────────────────────────────────
 *
 * It reorders WITHIN the claim window and nowhere else. The window is
 * `min(grantLimit + in-flight + grantLimit, queue.claimScanCap)` rows starting at the claim floor —
 * roughly 550 rows at the recorded occupancy, against a corpus of 1.6M keys, so this chooses 25 from
 * ~550 candidates rather than 25 from the whole backlog. That is a real limit and it is the reason
 * this is a latency fix and NOT a capacity fix: total render volume is unchanged, which is also why
 * it is safe to ship on by default. If a route is short of capacity outright, no ordering rescues it
 * — `renderInterval` and fleet size are the levers, and `queue.claimScanCap` widens the pool this
 * chooses from if the window is the binding constraint.
 *
 * ── AND WHAT IT COSTS ───────────────────────────────────────────────────────────────────────────
 *
 * One unindexed `Long` on `RenderSchedule` (`renderInterval`, the effective cadence, denormalized
 * for the same reason `fromSitemap` is), one full walk of the drained window instead of a walk that
 * stops at `grantLimit`, and one sort of the grantable rows. The walk is the only one worth stating:
 * a caught-up pass breaks at the first not-yet-due row exactly as before, so the extra work appears
 * only when there IS a backlog — which is when there is something to choose. Measured against the
 * pass budget it is noise either way: ~550 lease probes and one sort against a 0.43 ms scan, on a
 * path that runs roughly 0.2 times a second per node.
 */

/**
 * How overdue a row is, in units of its own render cadence, with sitemap membership applied.
 *
 * Clamped at zero rather than allowed to go negative: `runClaimPass` only ever scores rows it has
 * already established are due, and a negative score from a clock skew would sort a due row BELOW
 * rows that are exactly on time, which is the one ordering that makes no sense at all.
 *
 * `intervalMs` is trusted to be a positive finite number — `resolveRenderInterval` guarantees that
 * (it falls back to `render.defaultInterval`), and re-validating it here would hide a caller that
 * had started passing nonsense. The one guard that stays is the division: a zero or negative
 * interval would produce Infinity or a sign flip, so it degrades to pure lateness instead.
 */
export const overdueRatio = ({ nextRenderTime, fromSitemap }, { nowMs, intervalMs, sitemapBoost = 1 }) => {
	const lateness = Math.max(0, nowMs - nextRenderTime);
	const ratio = intervalMs > 0 ? lateness / intervalMs : lateness;
	return fromSitemap ? ratio * sitemapBoost : ratio;
};

/**
 * Order due rows most-urgent-first, in place.
 *
 * THE TIEBREAKS ARE THE INTERESTING PART. The ratio is zero for every row at the instant it comes
 * due, so on a caught-up node — which is the state the queue spends most of its time in — the
 * primary key carries no information at all and the tiebreaks decide everything:
 *
 *   1. ratio x boost, descending — the actual priority statement.
 *   2. sitemap before non-sitemap. The boost is multiplicative, so it vanishes at ratio 0 and could
 *      not express "prefer the sitemap page" in exactly the caught-up case where nothing else
 *      distinguishes the two. This is that half, and it is a tiebreak rather than a term added to
 *      the ratio precisely so it cannot survive into the backlogged case and become an unbounded
 *      lane.
 *   3. due time, ascending — FIFO. Keeps the caught-up node's behaviour identical to the pre-change
 *      index order rather than merely unspecified, so turning this on changes nothing observable
 *      until there is a backlog to reorder.
 *
 * `sort` is not required to be stable for correctness here, but V8's is, so equal rows keep the
 * index order the scan delivered them in.
 *
 * @param {Array<{cacheKey: string, nextRenderTime: number, fromSitemap: boolean, renderInterval?: number}>} rows
 *   due rows, mutated in place
 * @param {(cacheKey: string) => number} intervalFor  fallback cadence resolver, for a row that
 *   carries no stored `renderInterval` (in ms)
 * @param {{nowMs: number, sitemapBoost: number}} opts
 */
export const orderByPriority = (rows, intervalFor, { nowMs, sitemapBoost }) => {
	// Score once per row, not once per comparison: `sort` calls the comparator O(n log n) times, and
	// the fallback resolver parses a URL and walks the route list. At a 550-row window that is the
	// difference between 550 route resolutions and ~5,500 of them.
	const scored = new Map();
	for (const row of rows) {
		const score = overdueRatio(row, { nowMs, intervalMs: intervalOf(row, intervalFor), sitemapBoost });
		scored.set(row, score);
		// STAMPED, not just kept in the map. This number is the only evidence that the ordering did
		// anything: `claim` reports the score of every job it grants, and a distribution sitting at
		// several intervals late is the signal that the fleet is short of capacity for that route
		// rather than merely ordering it badly. Recomputing it in the caller would mean resolving
		// every granted row's cadence a second time.
		row.priority = score;
	}

	rows.sort((a, b) => {
		const byRatio = scored.get(b) - scored.get(a);
		if (byRatio !== 0) return byRatio;
		const bySitemap = (b.fromSitemap ? 1 : 0) - (a.fromSitemap ? 1 : 0);
		if (bySitemap !== 0) return bySitemap;
		return a.nextRenderTime - b.nextRenderTime;
	});

	return rows;
};

/**
 * The cadence to score a row against: the EFFECTIVE interval denormalized onto the row when it is
 * there, else whatever the fallback resolver says.
 *
 * The stored value wins because it is the only one that knows about the demand ladder. `claim` has
 * no Target read, so the fallback can see the ROUTE's interval and nothing else — and at the
 * recorded configuration the catalog routes declare a 24h ceiling that the ladder promotes to 12h
 * or 6h per URL. Scoring a promoted page at its ceiling would under-prioritize precisely the pages
 * the ladder singled out as the most-visited, which is the opposite of the intent.
 *
 * The fallback is not a degenerate case, though, and it is why this is a fallback rather than a
 * requirement: a row is written by several paths that do not have the effective interval in hand
 * (a reconcile repair, an invalidation re-enqueue, a render-now one-off), and `put` replaces the
 * record — so any of them clears the field until that URL's next completed render re-stamps it.
 * Route-resolved is the right answer in the meantime, and for a route that declares its own
 * `renderInterval` it is also usually the exact answer.
 */
const intervalOf = (row, intervalFor) =>
	Number.isFinite(row.renderInterval) && row.renderInterval > 0 ? row.renderInterval : intervalFor(row.cacheKey);
