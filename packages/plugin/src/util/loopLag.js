/**
 * Event-loop delay, as a governor input.
 *
 * WHY THIS EXISTS. A probe sweep that runs for a bounded stretch and then stops can be sized
 * against the origin alone: it is a guest that leaves. A CONTINUOUS one never leaves, so it also
 * has to answer for what it costs the node it runs on — and the node's scarce resource is not
 * bandwidth, it is the event loop the serve path shares with it. The existing origin backoff
 * cannot see that at all: a node losing its loop to the serve path returns no 429s, so the probe
 * reads a healthy origin and holds its configured rate straight through the congestion.
 *
 * WHY `monitorEventLoopDelay` AND NOT A TIMER. The obvious cheap version — `setTimeout(fn, n)`,
 * measure the overshoot — samples exactly as often as it fires and costs a timer each time, and
 * it measures the loop only at the instants it happens to run. `perf_hooks`'s monitor is a libuv
 * hook feeding a native histogram: sampling happens below JS, the accumulation is not JS work,
 * and reading it is a struct read. It is the right instrument and it is cheaper than the naive
 * one.
 *
 * WHAT THE NUMBER MEANS. The histogram records, per sample, how much LATER than scheduled the
 * loop got round to it. An idle loop sits near zero; a loop held by a synchronous native call
 * (a `getCount` walk, a big JSON serialization) shows that call's whole duration. So it is a
 * direct measure of the latency the serve path on this thread is eating — which is the thing the
 * probe must yield to.
 *
 * READ-AND-RESET, SINGLE CONSUMER. The histogram accumulates from `enable()` forever, so an
 * un-reset read reports the worst thing that ever happened on this thread rather than the state
 * now — and a governor fed all-time data never recovers. `read()` therefore resets, which makes
 * every call return "the lag since the last call" and makes this module single-consumer BY
 * CONSTRUCTION: a second caller would silently halve the first one's window. It has one consumer
 * (the probe pacer). If it ever needs a second, this becomes a sampler with a shared snapshot,
 * not another `reset()`.
 */

import { monitorEventLoopDelay } from 'node:perf_hooks';

let histogram = null;
let unavailable = false;
let resolution = 10;

/**
 * Start sampling. Idempotent, and safe to call where `perf_hooks` has no monitor: the whole
 * module degrades to "no signal", which the pacer reads as "no reason to slow down". A governor
 * that cannot measure must not throttle on a guess.
 */
export const startLoopLagMonitor = (resolutionMs = 10) => {
	if (histogram || unavailable) return !!histogram;
	resolution = Math.max(1, resolutionMs | 0);
	try {
		// Guarded, not because the import can fail — `perf_hooks` is core and the monitor predates
		// the engines floor — but because this is a diagnostic: a runtime that cannot construct one
		// must lose the governor, not the probe.
		histogram = monitorEventLoopDelay({ resolution });
		histogram.enable();
		return true;
	} catch {
		unavailable = true;
		histogram = null;
		return false;
	}
};

/**
 * Lag ABOVE the sampling floor, in milliseconds, since the previous read — then reset.
 *
 * THE BASELINE IS THE RESOLUTION, AND THIS IS THE TRAP THE MODULE EXISTS TO ABSORB. The histogram
 * records each sample's absolute lateness, not its excess over what was expected, so a completely
 * idle loop reads back at roughly the resolution rather than at zero. Measured on an idle process:
 *
 *   resolution  5ms -> mean  5.6ms      resolution 10ms -> mean 11.0ms
 *   resolution 20ms -> mean 21.0ms
 *
 * A threshold compared against the raw number is therefore resolution-dependent and quietly wrong:
 * at `resolution: 20` an idle node reads 21ms and trips any threshold under that, throttling a
 * probe against congestion that does not exist. Subtracting the floor is not a refinement, it is
 * what makes the reading mean anything — so this module returns the excess and never the raw
 * value, and owns the resolution so no caller can get the subtraction wrong. Same idle processes,
 * corrected: 0.6ms, 1.0ms, 1.0ms. A node held in 40ms synchronous blocks reads 18-41ms of excess.
 *
 * `p95` is the field the governor should use. What costs the serve path is the tail — one long
 * synchronous native call — and a mean over a short window dilutes exactly that into nothing.
 *
 * Returns `null` when there is no monitor or the window caught no samples: an ABSENT reading,
 * which the caller must not read as a reading of zero.
 */
export const readLoopLagMs = () => {
	if (!histogram) return null;
	let reading = null;
	try {
		if (histogram.count > 0) {
			// Floored at zero: a sample can land marginally under the resolution, and a governor
			// must never be handed a negative excess to reason about.
			const rawMean = histogram.mean / 1e6;
			const rawP95 = histogram.percentile(95) / 1e6;
			reading = {
				mean: Math.max(0, rawMean - resolution),
				p95: Math.max(0, rawP95 - resolution),
				samples: histogram.count,
				// The floor and the uncorrected values, carried so the correction is inspectable
				// rather than implicit. The admin surface reports them when sizing a threshold, and
				// it is the only way to verify the subtraction without re-deriving it.
				floor: resolution,
				raw: { mean: rawMean, p95: rawP95 },
			};
		}
		histogram.reset();
	} catch {
		return null;
	}
	return reading;
};

/** Tests only, and the disable path: stop sampling and drop the histogram. */
export const stopLoopLagMonitor = () => {
	try {
		histogram?.disable();
	} catch {
		// A monitor that will not stop is not a reason to fail whatever asked it to.
	}
	histogram = null;
	unavailable = false;
};

/** Introspection for the admin payload and tests. */
export const loopLagMonitorState = () => ({ running: !!histogram, unavailable });
