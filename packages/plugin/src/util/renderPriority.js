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
 * ── A DETECTED CHANGE STARTS AHEAD ────────────────────────────────────────────────────────────
 *
 *     score += changedHeadStart            (a row the change probe filed: `changedAt` on the row)
 *
 * The one ADDITIVE term, and it has to be: the probe files a changed page at the current minute, so
 * its lateness is zero and no multiplier can move it — it would enter behind every overdue row in the
 * set, while its page, hard-expired because it is known wrong, is served from the origin for as long
 * as it waits. The head start ranks it as if it were already `changedHeadStart` cadences late.
 *
 * Starvation stays bounded, with the same kind of statement as the boost's: a routine row wins as
 * soon as its score passes the changed rows' — so if changed rows are being held at `U` cadences
 * late, a routine row is served by `changedHeadStart + U` cadences late (divide by `sitemapBoost` for
 * a sitemap row). A change wave can take the fleet for a while; it cannot take it indefinitely.
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
	{ dueAt, fromSitemap, changed = false },
	{ nowMs, intervalMs, sitemapBoost = 1, changedHeadStart = 0 }
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
	const ratio = intervalMs > 0 ? lateness / intervalMs : lateness;
	const score = fromSitemap ? ratio * sitemapBoost : ratio;
	// A change the probe found: the page is known wrong, was hard-expired, and is served from the origin
	// until this render lands — see "A DETECTED CHANGE STARTS AHEAD" above. A non-positive or non-finite
	// head start adds nothing, so the policy is off rather than broken.
	return changed && changedHeadStart > 0 ? score + changedHeadStart : score;
};
