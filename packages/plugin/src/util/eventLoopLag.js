/**
 * PER-WORKER EVENT-LOOP DELAY, so a stall can be attributed instead of guessed at.
 *
 * WHY THIS EXISTS. The bot-facing `duration` (`path: 'p'`) metric showed, on the production fleet,
 * a median and p95 identical across every worker (1.6ms / ~2.7ms) while five workers carried a p99
 * of 13-53ms against 3.6-7.4ms elsewhere. Median flat, p95 flat, p99 blown out by 10-30x is the
 * signature of intermittent event-loop blocking: it only touches the small share of requests that
 * land inside a stall. The arithmetic said the ready-set sweep must cause ~11ms slices (200 rows at
 * ~55us/row, before `queue.ready.yieldBudget` replaced the row count) — but the tail was broader
 * than one worker, and the sweep self-gates to `workerIndex === 0`. So the shape was CONSISTENT with
 * the sweep and could not be pinned on it, and the other candidates (queue-status sync, reconciler,
 * sitemap refresh, GC) were indistinguishable from it in that data.
 *
 * Lag measured per worker separates them. Whatever only worker 0 does shows up only on worker 0.
 *
 * WHY `monitorEventLoopDelay` AND NOT A TIMER-DRIFT LOOP. The libuv-side histogram samples in C++
 * at a fixed interval and costs nothing measurable, where the usual `setTimeout`-drift trick both
 * competes for the loop it is measuring and misses any stall shorter than its own interval.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { config, onConfigApplied } from '../config.js';
import { metrics } from '../metrics.js';

const NS_PER_MS = 1e6;

/** Node's ceiling for `setInterval`; past it the delay overflows and fires after 1ms. */
const MAX_TIMER_MS = 2147483647;

/**
 * The two statistics for one window, in ms, with unusable readings dropped.
 *
 * EXTRACTED SO IT CAN BE TESTED, because the failure it guards is silent and fleet-wide. An empty
 * histogram — a window in which libuv took no sample — returns `Infinity` from `percentile()` and
 * `0`/`Infinity` from `max`. Emitting `Infinity` does not just add a bad row: `recordAnalytics`
 * aggregates by mean, so one `Infinity` makes the mean of the merged row `Infinity` for that whole
 * period, across every worker. The series would read as catastrophic while nothing was wrong.
 *
 * READ BEFORE RESET is the caller's job and equally load-bearing: the histogram is cumulative, so a
 * window that never resets pins the p99 at the worst stall since boot and never recovers.
 */
export const readLag = (histogram) => {
	const out = {};
	const p99 = histogram.percentile(99) / NS_PER_MS;
	const max = histogram.max / NS_PER_MS;
	if (Number.isFinite(p99)) out.p99 = p99;
	if (Number.isFinite(max)) out.max = max;
	return out;
};

let started = false;

/**
 * Sample this worker's loop delay on an interval and report it.
 *
 * NOT gated to one worker, unlike every other periodic task here — see the module comment. Idempotent,
 * and it follows `management.eventLoopLagInterval` without a restart.
 */
export function startEventLoopLagMonitor() {
	if (started) return;
	const interval = () => Math.max(0, config.management.eventLoopLagInterval | 0);
	if (interval() <= 0) return;
	started = true;

	// `resolution` is how often libuv samples. 20ms is coarse enough to cost nothing and fine enough
	// to catch a slice of the size this exists to look for; a stall shorter than one sample is, by
	// construction, shorter than the thing being investigated.
	const histogram = monitorEventLoopDelay({ resolution: 20 });
	histogram.enable();

	const report = () => {
		// Read BEFORE reset — see `readLag`. Both halves matter and neither is obvious from the call.
		const lag = readLag(histogram);
		histogram.reset();
		if (lag.p99 !== undefined) metrics.eventLoopLag(lag.p99, 'p99', server.workerIndex);
		if (lag.max !== undefined) metrics.eventLoopLag(lag.max, 'max', server.workerIndex);
	};

	let armed = interval();
	let timer = setInterval(report, Math.min(MAX_TIMER_MS, armed));
	timer.unref?.();

	onConfigApplied(() => {
		if (interval() === armed) return;
		clearInterval(timer);
		armed = interval();
		timer = armed > 0 ? setInterval(report, Math.min(MAX_TIMER_MS, armed)) : null;
		timer?.unref?.();
	});
}
