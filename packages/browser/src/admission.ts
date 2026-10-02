/**
 * Pressure-based admission: how many renders a worker may run at once, from the container's CPU
 * pressure instead of a fixed slot count.
 *
 * Render cost varies ~20x by page (an empty or dead-URL render is a fraction of a CPU-second, a full
 * product page several), so a fixed slot count overloads a pod that draws heavy pages and idles one
 * that draws light ones. Past the throughput peak, more concurrent renders only make each one cost
 * more CPU. PSI CPU pressure measures exactly that waiting — taken over each step's own interval from
 * the stall counter (util/cpu.ts), not the lagging `avg10` — so the limit steps up while pressure is
 * low and a job is held back, and down while it is high.
 *
 * Every worker in a container reads the same cgroup signal and runs its own step, on a staggered
 * tick, so each step is at most one slot — except the quarter cut above `2 x highPressure`, which
 * exists to leave a badly overloaded state within a few ticks rather than a few minutes.
 */

export type AdmissionMode = 'fixed' | 'pressure';

export type AdmissionSettings = {
	/** `fixed`: always `concurrency` renders at once. `pressure`: stepped between `min` and `max`. */
	mode: AdmissionMode;
	/** Fewest renders the limit steps down to. */
	min: number;
	/** Most renders the limit steps up to. */
	max: number;
	/** CPU pressure (PSI `some`, percent of the interval) below which the limit may rise, if a job is held back. */
	lowPressure: number;
	/** CPU pressure above which the limit falls. */
	highPressure: number;
	/** Milliseconds between steps. */
	intervalMs: number;
};

/**
 * The next render limit. `hasDemand` is whether the limit held a job back since the last step: raising
 * the limit of a worker with nothing queued only sets up an overshoot when a burst arrives. With no
 * pressure reading the limit holds.
 */
export function nextAdmissionLimit(
	current: number,
	pressure: number | null,
	hasDemand: boolean,
	limits: Pick<AdmissionSettings, 'min' | 'max' | 'lowPressure' | 'highPressure'>
): number {
	if (pressure === null) return current;
	let next = current;
	if (pressure > 2 * limits.highPressure) next = Math.floor(current * 0.75);
	else if (pressure > limits.highPressure) next = current - 1;
	else if (pressure < limits.lowPressure && hasDemand) next = current + 1;
	return Math.min(limits.max, Math.max(limits.min, next));
}
