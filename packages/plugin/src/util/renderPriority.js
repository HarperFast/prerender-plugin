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
 * That objection is fatal to an index and irrelevant to a function that is re-evaluated. Measured
 * (#119): a projected one-sided read costs ~2.4 us/row, flat from 200 to 20,000 rows, and yielding
 * every 200 rows is free. So re-scoring the whole due set costs ~480 ms per 200,000 rows — cheap
 * enough to redo on a timer, which is what `util/readyQueue.js` does. Nothing is stored, so the
 * crossing never has to be represented.
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
 * page last rendered for every row in the table. Three writers deliberately schedule a gap that is
 * not the cadence: `Target.suppress` writes `render.suppression.recheckInterval` (7 days),
 * `backoffWait` writes up to `render.failureRetry.maxBackoff`, and the unpin hatch pushes by
 * `render.defaultInterval`. Under the age form a 7-day suppression recheck on a 48h route arrives
 * reading as 3.5 cadences stale and outranks a genuinely late homepage — promoting exactly the rows
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
 */

/**
 * How overdue a row is in units of its own cadence, with sitemap membership applied.
 *
 * Clamped at zero rather than allowed to go negative: only rows already established as due are
 * scored, and a negative score from a clock skew would sort a due row BELOW rows that are exactly on
 * time, which is the one ordering that makes no sense at all.
 *
 * The only guard is the division. A zero or negative interval would produce Infinity or a sign flip,
 * so it degrades to raw lateness — which still orders sensibly among rows that share the problem.
 */
export const scoreOf = ({ dueAt, fromSitemap }, { nowMs, intervalMs, sitemapBoost = 1 }) => {
	const lateness = Math.max(0, nowMs - dueAt);
	const ratio = intervalMs > 0 ? lateness / intervalMs : lateness;
	return fromSitemap ? ratio * sitemapBoost : ratio;
};

/**
 * A BOUNDED MAX-K SELECTION over a stream, as a min-heap of size K.
 *
 * The point is that the sweep must be able to walk a due set far larger than anything it can hold:
 * 500,000 overdue rows at the recorded corpus, against a ready set of a few thousand. So rows stream
 * THROUGH this and only the best K are ever retained — memory is a function of K, not of the corpus,
 * which is what makes "sweep everything" affordable in the first place. A sort would need the whole
 * set resident, and this node has twice been taken down by an unbounded structure over this corpus.
 *
 * A min-heap (not a max-heap) because the operation on every row after the first K is "is this better
 * than the WORST one I am keeping" — one comparison against the root, and a rejected row costs
 * exactly that. At a 500k-row sweep into a 5k set, ~99% of rows are rejected on that single compare.
 */
export const createTopK = (k) => {
	const capacity = Math.max(1, k | 0);
	// [score, entry] pairs kept as parallel arrays: one allocation each rather than an object per
	// candidate, on a path that sees every due row on the node.
	const scores = [];
	const entries = [];

	const swap = (i, j) => {
		const s = scores[i];
		scores[i] = scores[j];
		scores[j] = s;
		const e = entries[i];
		entries[i] = entries[j];
		entries[j] = e;
	};

	const up = (i) => {
		while (i > 0) {
			const parent = (i - 1) >> 1;
			if (scores[parent] <= scores[i]) break;
			swap(parent, i);
			i = parent;
		}
	};

	const down = (i) => {
		for (;;) {
			const left = 2 * i + 1;
			const right = left + 1;
			let smallest = i;
			if (left < scores.length && scores[left] < scores[smallest]) smallest = left;
			if (right < scores.length && scores[right] < scores[smallest]) smallest = right;
			if (smallest === i) break;
			swap(i, smallest);
			i = smallest;
		}
	};

	return {
		get size() {
			return scores.length;
		},

		/** True if the candidate was kept. */
		offer(score, entry) {
			if (scores.length < capacity) {
				scores.push(score);
				entries.push(entry);
				up(scores.length - 1);
				return true;
			}
			// The single comparison the whole design rests on: the root is the worst kept row.
			if (score <= scores[0]) return false;
			scores[0] = score;
			entries[0] = entry;
			down(0);
			return true;
		},

		/**
		 * The kept entries, BEST FIRST, with their scores.
		 *
		 * Best-first is what lets the shared cursor in `util/readyQueue.js` be a bare atomic
		 * increment: consumption order IS priority order, so no consumer has to compare anything.
		 */
		drainDescending() {
			const out = entries.map((entry, i) => ({ entry, score: scores[i] }));
			out.sort((a, b) => b.score - a.score);
			return out;
		},
	};
};
