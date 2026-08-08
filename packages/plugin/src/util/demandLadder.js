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
 * DRY RUN. With `dryRun` on (the default), every decision is computed and counted but the
 * returned interval is the unchanged base — so a week of production traffic tells you the
 * steady-state level distribution, and therefore the render budget, BEFORE paying for it.
 */

import { config } from '../config.js';
import { visitedWithin, visitedInEachWindow, mergedReady, ensureMerged } from './visitFilter.js';

/** Rungs, ascending, normalized and de-duplicated. Config is the source of truth. */
export const rungs = () =>
	[...new Set((config.render.demand.ladder ?? []).filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b);

/** Index of the rung a target currently sits on; the closest rung when `current` is off-ladder. */
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
let stats = newStats();

function newStats() {
	return { promoted: 0, demoted: 0, held: 0, levels: new Map(), skippedCold: 0 };
}

const bump = (interval) => stats.levels.set(interval, (stats.levels.get(interval) ?? 0) + 1);

/**
 * Decide the cadence for `url`, given the `base` interval its route/stored config resolves to
 * and the `current` interval it last rendered at.
 *
 * Returns `{ interval, level, action }`. `interval` is what the caller should schedule with —
 * in dry-run that is always `base`, while `level` still reports what the ladder WOULD have
 * chosen, so callers can log the counterfactual without acting on it.
 */
export function decideInterval(url, base, current, nowMs = Date.now(), probe = visitProbe) {
	const demand = config.render.demand;
	const list = rungs();

	if (!demand.enabled || !list.length) return { interval: base, level: base, action: 'off' };
	armDemandStats();

	// A cold read-side union would read as "nothing was visited anywhere", which would demote
	// the entire corpus to the slowest rung on the first pass after a restart. Hold instead.
	if (!probe.ready()) {
		// Kick the refresh explicitly. The lazy path lives inside visitedWithin, which this
		// branch skips — without this the union never warms and the ladder never engages.
		probe.warm(nowMs);
		stats.skippedCold++;
		bump(base);
		return { interval: base, level: base, action: 'cold' };
	}

	// `base` is the ceiling: the ladder reallocates within the cadence the route already
	// grants, it never renders a target SLOWER than its route asked for. Rungs at or above
	// base are unreachable, so a route set to 6h simply has nowhere to demote to.
	const ceiling = rungIndexOf(base, list);
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
	return { interval: demand.dryRun ? base : level, level, action };
}

/**
 * Drain and return the interval's decision counters. The level histogram is the number that
 * says whether the split is still affordable — `fastFraction` is the share of decisions
 * landing below `maxFastInterval`, which is what `maxFastFraction` bounds.
 */
export function drainStats() {
	const out = stats;
	stats = newStats();
	const total = [...out.levels.values()].reduce((a, b) => a + b, 0);
	const fastLimit = config.render.demand.maxFastInterval;
	let fast = 0;
	for (const [interval, n] of out.levels) if (interval < fastLimit) fast += n;
	return {
		promoted: out.promoted,
		demoted: out.demoted,
		held: out.held,
		skippedCold: out.skippedCold,
		total,
		fastFraction: total ? fast / total : 0,
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
	const pretty = Object.fromEntries(Object.entries(s.levels).map(([ms, n]) => [`${Math.round(ms / 3600000)}h`, n]));
	const line = {
		dryRun: demand.dryRun,
		decisions: s.total,
		promoted: s.promoted,
		demoted: s.demoted,
		held: s.held,
		skippedCold: s.skippedCold,
		fastFraction: Number(s.fastFraction.toFixed(4)),
		levels: pretty,
	};
	if (s.fastFraction > demand.maxFastFraction) {
		logger.warn(
			`demand ladder: ${(s.fastFraction * 100).toFixed(1)}% of decisions landed below ` +
				`${Math.round(demand.maxFastInterval / 3600000)}h (limit ${(demand.maxFastFraction * 100).toFixed(1)}%) — ` +
				`the hot set has outgrown the configured budget`,
			line
		);
	} else {
		logger.notify?.('demand ladder', line) ?? logger.info('demand ladder', line);
	}
}

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
