/**
 * Demand ladder — move a target's render cadence up or down a fixed rung list based on
 * whether bots actually visit it, within the SAME total render budget.
 *
 * WHAT THIS IS FOR, PRECISELY. A render interval bounds how stale a served page can be, but
 * only for content that drifts with TIME. Measured on this corpus, that is availability:
 * ~0.04%/hour, continuous, and directionally `InStock -> OutOfStock` (i.e. the cache claims
 * stock for sold-through items). Price does NOT drift that way — it steps at promotional
 * events, ~81% of PDPs at once, so no affordable interval bounds it and the ladder does not
 * try. Reviews and images are client-side and move over weeks. So each rung is really an
 * availability-error budget:
 *
 *     6h -> ~0.24%    12h -> ~0.5%    24h -> ~1%    48h -> ~2%
 *
 * That is why the default ladder bottoms out at 6h rather than 1h: 1h buys ~0.04% for SIX
 * TIMES the render cost of 6h, which is the worst trade on the curve — and the fast rungs are
 * exactly where a runaway hot-set becomes unaffordable. It is also why the TOP rung is capped
 * at 48h: demoting further (a 7d rung is ~7% wrong-availability) trades away more than the
 * budget it frees.
 *
 * PROMOTION IS DELIBERATELY HARDER THAN DEMOTION. Promoting on "visited at all during the
 * current interval" settles at rendering TWICE per visit: for a page visited with period P,
 * a window of length T contains a visit with probability ~T/P, so promote/demote balance at
 * T = P/2. Requiring a visit in EACH of the last `promoteWindows` candidate-sized windows
 * asks the sharper question — "would a render at the FASTER rung actually have been seen?" —
 * and settles near one render per visit instead. Demotion stays single-window because the
 * cost of demoting a page that is still wanted is bounded (it climbs back next cycle) while
 * over-promoting the whole corpus is not.
 *
 * BUDGET IS NOT SELF-LIMITING. Cost scales with the hot fraction, which is ~0.5% of the
 * corpus pre-ramp and rises with search-bot traffic. At 0.5% hot the split is free; if the
 * filter ever reads hot for most of the corpus, "promote the hot set" silently becomes
 * "halve every interval". `maxFastFraction` is the backstop, and the level histogram this
 * module logs is the early warning. Never ship this without watching that number.
 *
 * The backstop only works if it measures the LADDER. It is scored over graded decisions —
 * the ones where a faster rung existed and the visit filter was warm — never over routes
 * already granted a cadence at or below the fastest rung, which the ladder was never offered
 * a choice about. See the stats block below.
 *
 * And it only works if it is POOLED. Every counter here is per worker per interval, and
 * worker decision volumes are wildly unequal, so the guardrail ships as the raw `fast` and
 * `graded` counters and the ratio is taken at query time over their sums. A per-worker ratio
 * can only be aggregated by averaging ratios, which systematically overstates the number by
 * weighting the workers with the least evidence the same as the ones with the most.
 *
 * DRY RUN. With `dryRun` on (the default), every decision is computed and counted but the
 * returned interval is the unchanged base — so a week of production traffic tells you the
 * steady-state level distribution, and therefore the render budget, BEFORE paying for it.
 */

import { config, onConfigApplied } from '../config.js';
import { visitedWithin, visitedInEachWindow, mergedReady, ensureMerged, newestFill } from './visitFilter.js';
import { metrics } from '../metrics.js';

// Normalized rungs, recomputed only when config changes — decideInterval runs on the
// reschedule path (~20x/s) and must not re-filter/sort per decision. The per-base effective
// ladders derive from the same config, so they are cleared together.
let cachedRungs = [];
const effectiveLadders = new Map();
const updateRungs = () => {
	cachedRungs = [...new Set((config.render.demand.ladder ?? []).filter((n) => Number.isFinite(n) && n > 0))].sort(
		(a, b) => a - b
	);
	effectiveLadders.clear();
};
updateRungs();

/** Rungs, ascending, normalized and de-duplicated. Config is the source of truth. */
export const rungs = () => cachedRungs;

/**
 * The ladder a given base interval actually offers: every configured rung STRICTLY faster
 * than base, with base itself as the top (slowest) rung.
 *
 * Base is the resting state, and an off-ladder base is deliberately never snapped to a
 * configured rung — in either direction. Snapping UP schedules slower than the route granted
 * (a 1h route parked at the 6h rung, with no traffic input at all); snapping DOWN renders
 * faster than the route budgeted (a weekly `changefreq` route at 168h pulled to the 48h rung
 * is a 3.5x render-cost multiplier on that corpus slice — a fleet-capacity event, and one
 * `maxFastFraction` cannot see, because 48h is not "fast"). Both directions break the two
 * contracts the config text states: base is the ceiling, and the ladder reallocates within
 * the budget the route already grants.
 *
 * Memoized per base: bases come from routes/changefreq/default — a handful of distinct
 * values — and this runs per reschedule. Bounded anyway so a caller bug cannot grow it.
 */
export const effectiveLadder = (base) => {
	let list = effectiveLadders.get(base);
	if (!list) {
		if (effectiveLadders.size >= 64) effectiveLadders.clear();
		list = [...cachedRungs.filter((r) => r < base), base];
		effectiveLadders.set(base, list);
	}
	return list;
};

/**
 * Index of the rung a target currently sits on; the closest rung when `current` is
 * off-ladder (a stored rung from an old ladder config — bases never snap, see
 * `effectiveLadder`).
 */
export const rungIndexOf = (current, list = rungs()) => {
	if (!list.length) return -1;
	const n = Number(current);
	if (!Number.isFinite(n) || n <= 0) return list.length - 1;
	let best = 0;
	for (let i = 1; i < list.length; i++) {
		if (Math.abs(list[i] - n) < Math.abs(list[best] - n)) best = i;
	}
	return best;
};

/**
 * The visit-filter seam. Injected so the ladder's decision logic — which is all of the
 * subtlety here — is unit-testable without a warm Bloom ring or Harper globals behind it.
 */
export const visitProbe = {
	ready: mergedReady,
	warm: ensureMerged,
	within: visitedWithin,
	eachWindow: visitedInEachWindow,
};

// Per-interval decision counters, drained by `drainStats` into the periodic histogram log.
//
// GRADED vs. UNGRADED. Only the decisions the ladder actually got to make — `promoted`,
// `demoted`, `held` — carry a level, and only they feed the histogram and `fastFraction`.
// The two early returns below are not ladder outcomes: `singleRung` had no faster rung to
// move to (the route's own cadence is the whole ladder) and `skippedCold` had no visit data
// to decide on. Counting them as levels was the defect in #86 — a deployment with a 6h route
// reported that route's every reschedule as "landed below 12h", so `fastFraction` had a
// structural floor set by the route mix and `maxFastFraction` warned forever about a hot set
// that had not moved at all.
let stats = newStats();

function newStats() {
	return {
		promoted: 0,
		demoted: 0,
		held: 0,
		levels: new Map(),
		skippedCold: 0,
		singleRung: 0,
		fast: 0,
		promotedFast: 0,
	};
}

const bump = (interval) => stats.levels.set(interval, (stats.levels.get(interval) ?? 0) + 1);

/**
 * Decide the cadence for `url`, given the `base` interval its route/stored config resolves to
 * and the `current` interval it last rendered at.
 *
 * Returns `{ interval, level, action }`. `interval` is what the caller should schedule with —
 * in dry-run that is always `base`, while `level` still reports what the ladder WOULD have
 * chosen, so callers can log the counterfactual without acting on it.
 *
 * `action` is one of `off` (ladder disabled), `single-rung` / `cold` (no decision was
 * possible — see the stats block above), or `promoted` / `demoted` / `held`.
 */
export function decideInterval(url, base, current, nowMs = Date.now(), probe = visitProbe) {
	const demand = config.render.demand;

	if (!demand.enabled || !cachedRungs.length) return { interval: base, level: base, action: 'off' };
	armDemandStats();

	// The rungs this base can actually occupy: everything faster than it, plus base itself
	// as the resting state. A single entry means no configured rung is faster than the
	// granted cadence — nothing to reallocate, so skip the probe (and the cold hold: there
	// is no move to hold back). Counted apart from `held`: the ladder did not hold this
	// target at its rung, it was never offered another one.
	const list = effectiveLadder(Number(base));
	if (list.length === 1) {
		stats.singleRung++;
		return { interval: base, level: base, action: 'single-rung' };
	}

	// A cold read-side union would read as "nothing was visited anywhere", which would demote
	// the entire corpus to the slowest rung on the first pass after a restart. Hold instead.
	if (!probe.ready()) {
		// Kick the refresh explicitly. The lazy path lives inside visitedWithin, which this
		// branch skips — without this the union never warms and the ladder never engages.
		probe.warm(nowMs);
		stats.skippedCold++;
		return { interval: base, level: base, action: 'cold' };
	}

	// `base` is the ceiling — the last entry of its own effective ladder — so rungs at or
	// above the route's grant are unreachable by construction, and a route set to 6h simply
	// has nowhere to demote to.
	const ceiling = list.length - 1;
	const from = Math.min(rungIndexOf(current ?? base, list), ceiling);

	let to = from;
	let action = 'held';

	const faster = from - 1;
	if (faster >= 0 && probe.eachWindow(url, list[faster], demand.promoteWindows, nowMs)) {
		to = faster;
		action = 'promoted';
	} else if (from < ceiling && !probe.within(url, list[from], nowMs)) {
		to = from + 1;
		action = 'demoted';
	}

	if (action === 'promoted') stats.promoted++;
	else if (action === 'demoted') stats.demoted++;
	else stats.held++;

	const level = list[to];
	bump(level);
	// Classified here rather than derived from the histogram at drain time, so a live
	// `maxFastInterval` change grades each decision against the limit in force when it was
	// made, and so the fast counters cannot drift from the set of decisions that produced them.
	if (level < demand.maxFastInterval) {
		stats.fast++;
		if (action === 'promoted') stats.promotedFast++;
	}
	return { interval: demand.dryRun ? base : level, level, action };
}

/**
 * Drain and return the interval's decision counters.
 *
 * `graded` is the decisions the ladder actually made; `total` adds the two no-decision paths.
 * `fastFraction` — what `maxFastFraction` bounds — is `fast / graded`: the share of LADDER
 * decisions that landed below `maxFastInterval`. Deliberately decision-weighted, because
 * decisions are renders: a target sitting on the 6h rung emits eight times the decisions of
 * one at 48h, so this reads as the share of the eligible render budget spent on fast rungs,
 * which is the thing `maxFastFraction` is trying to cap. Weighting by corpus instead would
 * report a number that no longer tracks cost.
 *
 * `promotedFast` is the movement counter beside it: promotions ONTO a fast rung, i.e. budget
 * the ladder is actively reallocating this interval, zero in a settled steady state.
 *
 * `fastFraction` here is THIS WORKER's ratio over THIS interval, which is a diagnostic, not
 * the guardrail. The guardrail is the pooled ratio, `sum(fast) / sum(graded)` over the raw
 * counters — see `logDemandStats`.
 */
export function drainStats() {
	const out = stats;
	stats = newStats();
	const graded = out.promoted + out.demoted + out.held;
	return {
		fast: out.fast,
		promoted: out.promoted,
		demoted: out.demoted,
		held: out.held,
		skippedCold: out.skippedCold,
		singleRung: out.singleRung,
		promotedFast: out.promotedFast,
		graded,
		total: graded + out.skippedCold + out.singleRung,
		fastFraction: graded ? out.fast / graded : 0,
		levels: Object.fromEntries([...out.levels].sort((a, b) => a[0] - b[0])),
	};
}

/** Test seam. */
export const resetDemandStats = () => {
	stats = newStats();
};

// ------------------------------------------------------------------- periodic histogram

let statsTimer = null;
let armedStatsInterval = null;

/**
 * Log the decision histogram. This is the number that says whether the split is still
 * affordable, and the ONLY early warning that a growing hot set is quietly turning
 * "promote the hot pages" into "halve every interval" — so it is logged whether or not the
 * ladder is actually acting (dry-run counts decisions all the same).
 */
export function logDemandStats() {
	const s = drainStats();
	if (!s.total) return;
	const demand = config.render.demand;
	const fill = newestFill();

	// The same numbers as METRICS, not just a log line — with the ladder enabled without a
	// dry-run week, this is the only guardrail, and a guardrail nobody can alert on is a
	// postmortem exhibit. Guarded: losing a metric must never cost the log line, which is
	// still the richer record (per-level histogram).
	//
	// The guardrail ships as its two COUNTERS, `fast` and `graded`, never as a ratio. These
	// counters are per worker per interval, and workers see wildly unequal decision volumes —
	// measured in production, one worker's interval had graded 3 while a sibling's had 50. A
	// ratio emitted per worker can then only be consumed by AVERAGING ratios, and the average
	// of ratios is not the ratio of sums: 1/3 and 1/50 average to 0.175, while the pooled truth
	// is 2/53 = 0.038. That is a 4.6x overstatement of budget consumption, biased by exactly
	// the workers with the least evidence. Summing counters and dividing at query time is
	// correct across workers AND across nodes, which a gauge can never be.
	try {
		metrics.demandLadder(s.promoted, 'promoted');
		metrics.demandLadder(s.demoted, 'demoted');
		metrics.demandLadder(s.held, 'held');
		metrics.demandLadder(s.skippedCold, 'skipped_cold');
		metrics.demandLadder(s.singleRung, 'single_rung');
		metrics.demandLadder(s.promotedFast, 'promoted_fast');
		metrics.demandLadder(s.fast, 'fast');
		metrics.demandLadder(s.graded, 'graded');
		metrics.demandLadder(fill, 'fill');
	} catch (e) {
		logger.warn(`[prerender] demand_ladder metrics not recorded: ${e?.message ?? String(e)}`);
	}
	const pretty = Object.fromEntries(Object.entries(s.levels).map(([ms, n]) => [`${Math.round(ms / 3600000)}h`, n]));
	const line = {
		dryRun: demand.dryRun,
		decisions: s.total,
		// The denominator of fastFraction: decisions the ladder actually made. The two
		// counters after it are the rest of `decisions`, and neither is a ladder outcome.
		graded: s.graded,
		promoted: s.promoted,
		demoted: s.demoted,
		held: s.held,
		skippedCold: s.skippedCold,
		singleRung: s.singleRung,
		promotedFast: s.promotedFast,
		fast: s.fast,
		// This WORKER's ratio for this interval. The fleet number is the pooled
		// sum(demand_fast)/sum(demand_graded) — see the metrics block above.
		fastFraction: Number(s.fastFraction.toFixed(4)),
		// Set-bit fraction of the newest union slot — the sizing early warning. A k-hash probe
		// false-positives at ~fill^k (k=7: fill 0.5 ≈ 0.8%, fill 0.88 ≈ 40%), and false
		// positives promote pages nobody visited — watch this before trusting the histogram.
		fill: Number(fill.toFixed(4)),
		levels: pretty,
	};
	if (s.graded >= minResolvableSample() && s.fastFraction > demand.maxFastFraction) {
		logger.warn(
			`demand ladder: ${(s.fastFraction * 100).toFixed(1)}% of this worker's ${s.graded} ladder decisions ` +
				`landed below ${Math.round(demand.maxFastInterval / 3600000)}h ` +
				`(limit ${(demand.maxFastFraction * 100).toFixed(1)}%) — the hot set may be outgrowing the ` +
				`configured budget; confirm against pooled demand_fast / demand_graded`,
			line
		);
	} else {
		(logger.notify ?? logger.info).call(logger, `[prerender] demand ladder ${JSON.stringify(line)}`);
	}
}

/**
 * The smallest `graded` count at which this worker's ratio can say anything about the limit.
 *
 * Below `1 / maxFastFraction` decisions, ONE fast decision already exceeds the limit by
 * itself — the test then reports the arrival of a single promotion, not a budget trend, and
 * at the 0.05 default that is any interval with fewer than 20 graded decisions. Production
 * intervals per worker ran as low as 2, so without this floor the warning fires on samples
 * that cannot carry it (every warning observed in the first hour of v0.43.0 was one of these).
 *
 * This is a floor on MEANINGLESSNESS, not a significance test: at exactly 1/maxFastFraction
 * the warning still trips on two fast decisions, which is noisy but no longer vacuous. The
 * statistically sound version of this question is the pooled counters, where the denominator
 * is every worker on every node and the interval count is however long you chart it — which
 * is why the metric, not this line, is the alert.
 */
const minResolvableSample = () => {
	const limit = config.render.demand.maxFastFraction;
	// A zero limit means "any fast decision is too many", which one decision does resolve.
	return limit > 0 ? Math.ceil(1 / limit) : 1;
};

/** Arm the histogram timer once, on the first thread that decides anything. */
export function armDemandStats() {
	if (statsTimer) return;
	armedStatsInterval = config.render.demand.statsInterval;
	statsTimer = setInterval(() => {
		try {
			logDemandStats();
		} catch (e) {
			logger.error(e);
		}
	}, armedStatsInterval);
	statsTimer.unref?.();
}

export function stopDemandStats() {
	if (statsTimer) clearInterval(statsTimer);
	statsTimer = null;
	armedStatsInterval = null;
}

// Keep the cached rungs and the histogram timer following live config, mirroring the
// flush-timer handling in crawlStats/visitFilter: disable stops the timer (flushing the
// counters one last time so a toggle doesn't swallow them), an interval change re-arms.
onConfigApplied(() => {
	updateRungs();
	if (!statsTimer) return;
	if (!config.render.demand.enabled) {
		logDemandStats();
		stopDemandStats();
		return;
	}
	if (config.render.demand.statsInterval !== armedStatsInterval) {
		stopDemandStats();
		armDemandStats();
	}
});
