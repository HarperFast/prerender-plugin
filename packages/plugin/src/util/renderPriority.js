/**
 * HOW URGENT A DUE ROW IS — the scoring policy, and nothing else.
 *
 * `claim` orders by `nextRenderTime` and nothing else, which expresses priority perfectly while the
 * queue is caught up and not at all once two rows are both past due. A due time encodes when a page
 * last rendered plus its cadence, not how much it matters:
 *
 *     home  (1h cadence)   due 2h ago   ->  2.00 cadences late
 *     PDP  (48h cadence)   due 3h ago   ->  0.06 cadences late
 *
 * Index order gives the lease to the PDP, because 3h > 2h. Nothing looks wrong while it does: the
 * floor advances, the scan stays fast, no row is wedged. Measured on the production corpus
 * (prerender-plugin#80), the 1h route sits at 4.78x its own TTL even at FULL capacity and 48.83x at
 * half, against 1.08x / 2.00x for the 48h route. And ~46% of a 521,929-row overdue queue was
 * bot-discovered rather than sitemap-submitted, so roughly half the capacity was going to pages
 * nobody submitted.
 *
 * ── WHY THIS IS A FUNCTION AND NOT AN INDEX ────────────────────────────────────────────────────
 *
 * Relative lateness cannot be an ORDER. `(t - dueAt) / interval` is linear in `t` with slope
 * `1/interval`, so two rows with different intervals cross exactly once — no stored key can express
 * an order that changes with the clock, and #80 rejected it as a comparator for exactly that reason.
 *
 * That objection is fatal to an index and irrelevant to a function that is re-evaluated. Since
 * v0.93.0 it is evaluated in memory by the queue keeper (`util/queueKeeper.js`), over class heads
 * rather than rows. Before that a sweep re-scored the whole due set from the index every few minutes,
 * and how affordable THAT was is a measurement worth keeping, because it is a trap anyone re-running
 * the harness will fall into.
 *
 * `bench/queue-index` (#119) measured ~2.4 us/row. MEASURED ON THE PRODUCTION CORPUS (2026-08-21) the
 * sweep runs ~55 us/row warm, ~80 us/row cold — a ~300k-row due set is a ~27s sweep, not the
 * sub-second one the bench predicted. Same storage engine in both cases (RocksDB, Harper's default).
 * What differs is the CORPUS: the bench wrote 200k rows fresh and read them immediately, where
 * production holds 1.3M rows that have been rewritten on every render for months.
 *
 * On an LSM store that difference is the whole cost. Every reschedule is a `put` that supersedes the
 * old value, and a range scan has to walk past superseded entries until compaction removes them — the
 * same shape as the dead-index-entry degradation the claim floor (v0.34.0–v0.92.0) existed to bound.
 * The harness ALREADY measured this and it was read too narrowly: an unfloored seek after 40,000 head reschedules went
 * 0.073 -> 5.60 ms, 77x, on the same engine and corpus. 2.4 us/row was a FLOOR for a fresh corpus,
 * never a steady state.
 *
 * The ARGUMENT survives intact: reads are still vastly cheaper than writes (76-89 us/row, and `patch`
 * worse than `put`), so recomputing in memory still beats encoding priority into `nextRenderTime`,
 * which would have made every policy change a rewrite of 1.3M rows. What does not survive is sizing
 * anything off a fresh-corpus number.
 *
 * The consequence worth stating plainly: BECAUSE THIS IS NOT IN THE KEY, changing the policy is a
 * config change with no data migration. Encoding priority into `nextRenderTime` (the rejected
 * alternative) would make every policy change a rewrite of 1.6M rows.
 *
 * ── THE FORMULA, AND WHY LATENESS RATHER THAN AGE ──────────────────────────────────────────────
 *
 *     score = max(0, now - dueAt) / interval  x  (fromSitemap ? sitemapBoost : 1)
 *
 * The tempting form is `(now - lastRender) / interval` — staleness relative to cadence, the same
 * number plus one, and it reads better. It is wrong here, because `dueAt - interval` is not when the
 * page last rendered for every row in the table. Two writers deliberately schedule a gap that is
 * not the cadence: `Target.suppress` writes `render.suppression.recheckInterval` (7 days), and
 * `backoffWait` writes up to `render.failureRetry.maxBackoff`. Under the age form a 7-day suppression
 * recheck on a 48h route arrives reading as 3.5 cadences stale and outranks a genuinely late homepage — promoting exactly the rows
 * worth deprioritizing.
 *
 * Lateness has no such coupling: it is zero at the moment any row comes due, whatever gap preceded
 * it, so a recheck or a backed-off retry enters at the back and climbs from there like anything else.
 *
 * ── STARVATION IS BOUNDED, AND THE BOUND IS STATABLE ──────────────────────────────────────────
 *
 * `sitemapBoost` is a MULTIPLIER, never an additive tier or a separate lane. A lane would let a large
 * sitemap corpus starve discovered URLs outright; a multiplier cannot, because an unserved row's
 * lateness grows without bound while the boost stays constant. A discovered row wins as soon as its
 * ratio passes `sitemapBoost x` the highest sitemap ratio in the set — so if sitemap pages are being
 * held at `U` cadences late, a discovered page is served by `sitemapBoost x U` cadences late.
 *
 * ── A DETECTED CHANGE, OR AN ASK TO RENDER NOW, STARTS AHEAD ─────────────────────────────────
 *
 *     score += headStart x max(1, sitemapBoost)
 *         headStart = changedHeadStart   a row the change probe filed: `changedAt` on the row
 *                   = urgentHeadStart    a row filed due now by an ask: `urgentAt` (render-now,
 *                                        revalidate, rejoin, a redirect destination adopted)
 *
 * The one ADDITIVE term, and it has to be: both kinds are filed at the current minute, so their
 * lateness is zero and no multiplier can move it — they would enter behind every overdue row in the
 * set. For a changed page that is the whole cost of the change: hard-expired because it is known
 * wrong, it is served from the origin for as long as it waits. For an ask it is the ask itself going
 * unanswered — a render-now whose caller is polling, a revalidate after a deploy, the destination of a
 * permanent redirect whose source's pages were just deleted. Measured before the urgent mark existed: a
 * row filed due now was absent from a full ready set of routine rows 1–5,000 minutes late, while a
 * changed row filed the same minute placed 3,565th.
 *
 * THE HEAD START IS BOOSTED, and it has to be. A routine SITEMAP row's lateness is multiplied by
 * `sitemapBoost`, so an unboosted head start of 1 cadence was worth HALF a cadence of sitemap lateness
 * at the default boost of 2: any sitemap product page 24h late on its 48h cadence outranked a page
 * found changed a minute ago. Multiplied by the boost, the head start is stated in the same units as
 * the rows it has to beat: a fresh marked row outranks every routine row less than `headStart`
 * cadences late, sitemap-listed or not (a discovered one, less than `headStart x sitemapBoost`). It is
 * the boost itself, not the row's sitemap flag, because a discovered page that changed is just as
 * wrong on the origin as a listed one.
 *
 * Starvation stays bounded, with the same kind of statement as the boost's: a routine row wins as
 * soon as its score passes the marked rows' — so if marked rows are being held at `U` cadences late,
 * a routine sitemap row is served by `headStart + U` cadences late (times `sitemapBoost` for a
 * discovered one). A change wave, or a route-wide revalidate, can take the fleet for a while; it
 * cannot take it indefinitely. A row carrying both marks takes the change's head start: the two are
 * not added.
 *
 * ── A CHANGED PAGE WAITS IN VISITS, NOT CADENCES ──────────────────────────────────────────────
 *
 *     changed row, queue.ready.changedDemand on, demand known:
 *         score = max(0, now - dueAt) / demandPeriod  x  (fromSitemap ? sitemapBoost : 1)  +  changedHeadStart
 *
 * A changed page is hard-expired, so every bot visit while it waits is served from the origin. Divided
 * by the page's estimated visit period (`demandPeriod`, stamped from the demand tracker when the change
 * was acted on — util/demand.js), the wait IS that count: the visits this page has sent to the origin
 * so far. Divided by cadence instead, every changed product page shares one divisor, and a change
 * wave renders in the order the probe found the changes — URL order — whatever bots are asking for.
 *
 * Two pages found changed together: the one asked for every 6h gains a point every 6h, the one asked
 * for twice a week gains one every 3.5 days, so the first renders first. The second is not starved:
 * it still gains, and a page with no visit in the tracker's whole window gains one point per window.
 *
 * WHERE THE TWO SCALES MEET. A changed row scores in visits missed and a routine row in cadences late,
 * and they are compared as numbers. That is the policy, stated: a routine row is still being served
 * from the cache — at worst stale — while a changed row is being served from the origin, so a changed
 * page nobody asks for yields to a routine row at the same score rather than taking the fleet from
 * pages bots are reading. The starvation bound above holds with U in visits.
 *
 * With demand unknown (tracker off, cold or saturated — the row carries no `demandPeriod`), or the
 * option off, a changed row orders by cadence exactly as above.
 */

/**
 * How overdue a row is in units of its own cadence, with sitemap membership applied.
 *
 * Clamped at zero rather than allowed to go negative: only rows already established as due are
 * scored, and a negative score from a clock skew would sort a due row BELOW rows that are exactly on
 * time, which is the one ordering that makes no sense at all.
 *
 * Two guards, and they are guarding different things. The DUE TIME is validated because an absent one
 * does not degrade gracefully — `nowMs - null` is `nowMs`, a lateness of ~1.8e12 that sorts a broken
 * row straight to the head. The INTERVAL is only compared, not validated, because `> 0` is already
 * false for every unusable value; a zero or negative one would produce Infinity or a sign flip, so it
 * degrades to raw lateness, which still orders sensibly among rows that share the problem.
 */
export const scoreOf = (
	{ dueAt, fromSitemap, changed = false, urgent = false, demandPeriodMs = null },
	{ nowMs, intervalMs, sitemapBoost = 1, changedHeadStart = 0, urgentHeadStart = 0, changedDemand = false }
) => {
	// THE DUE TIME IS GUARDED, AND IT IS THE DANGEROUS ONE. `nowMs - null` is `nowMs`, so an absent
	// due time does not produce a small score or a NaN — it produces a lateness of ~1.8e12, which sorts
	// straight to the head of the set and hands the next lease to a broken row. The keeper never holds a
	// non-finite due time, but this is exported and scored by callers that may, so the guard belongs with
	// the arithmetic. Zero is the right answer: a row with no due time
	// makes no claim to urgency.
	if (!Number.isFinite(dueAt) || !Number.isFinite(nowMs)) return 0;
	const lateness = Math.max(0, nowMs - dueAt);
	// The interval needs no such guard, and deliberately does not get one: `> 0` is already false for
	// null, undefined, NaN, 0 and every negative, so the `Number(null) === 0` trap is closed by the
	// comparison rather than by a coercion. Adding a `typeof` check would only change behaviour for a
	// numeric STRING interval, which works correctly today.
	// A changed row waits in VISITS when its demand is known and the option is on — see "A CHANGED PAGE
	// WAITS IN VISITS" above. `> 0` is false for null/NaN/0, so an unknown demand falls back to cadence.
	const divisor = changed && changedDemand && demandPeriodMs > 0 ? demandPeriodMs : intervalMs;
	const ratio = divisor > 0 ? lateness / divisor : lateness;
	const score = fromSitemap ? ratio * sitemapBoost : ratio;
	// A change the probe found, or an ask to render now — see "A DETECTED CHANGE, OR AN ASK TO RENDER
	// NOW, STARTS AHEAD" above: in boosted units, and the change's when a row carries both. A non-positive
	// or non-finite head start adds nothing, so the policy is off rather than broken.
	const headStart = changed ? changedHeadStart : urgent ? urgentHeadStart : 0;
	if (!(Number.isFinite(headStart) && headStart > 0)) return score;
	const boost = Number.isFinite(sitemapBoost) && sitemapBoost > 1 ? sitemapBoost : 1;
	return score + headStart * boost;
};
