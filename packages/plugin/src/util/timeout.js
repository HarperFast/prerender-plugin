/**
 * A deadline for a promise that has none of its own.
 *
 * The motivating case is Harper's residency-routed writes. `RenderSchedule` is pinned with
 * `setResidencyById`, so a put for a key this node does not own is forwarded to the owner —
 * and that forward has no deadline. When the owner is unreachable (a decommissioned node still
 * present in cluster membership, a partitioned replication link), the promise simply never
 * settles.
 *
 * `.catch()` cannot help, because a hang never rejects. Every caller that awaits such a write
 * inside a loop or a lock therefore stops forever, with no error, no log line, and no partial
 * result — which is exactly how a bulk sitemap walk (1M+ routed schedule writes, drained in
 * batches) dies silently partway through, and how `RenderQueue.claim` can wedge its mutex.
 *
 * Racing the write against a timer converts an unbounded hang into an ordinary, visible,
 * countable failure.
 *
 * IMPORTANT: this does NOT cancel the underlying operation — the write may still land after
 * the deadline. Only use it where a late or lost write is recoverable. For `RenderSchedule` it
 * is: a target with no schedule row is precisely the gap `util/reconcile.js` sweeps for, so a
 * timed-out schedule write degrades to "repaired within one reconcile interval" instead of
 * "this worker is now stuck".
 */

export class TimeoutError extends Error {
	constructor(message, { label, ms } = {}) {
		super(message);
		this.name = 'TimeoutError';
		this.label = label;
		this.timeoutMs = ms;
	}
}

/**
 * Resolve `promise`, or reject with a `TimeoutError` after `ms`.
 *
 * A non-positive or non-finite `ms` disables the deadline and returns the promise unchanged,
 * so a deployment can opt out with `0` without the call sites growing a conditional.
 *
 * The timer is always cleared, including on the success path — an uncleared timer would hold
 * the event loop open for the full duration after a fast write, which at batch scale means
 * tens of thousands of pending timers. It is deliberately NOT unref'd: an unref'd deadline can
 * be skipped entirely if it is the only thing left on the loop, which is the one moment the
 * timeout matters most.
 */
export const withTimeout = (promise, ms, label = 'operation') => {
	const settled = Promise.resolve(promise);
	if (!Number.isFinite(ms) || ms <= 0) return settled;

	let timer;
	// `Promise.race` subscribes to `settled`, so a rejection arriving after the deadline is
	// already considered handled and cannot surface as an unhandled rejection.
	return Promise.race([
		settled,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`, { label, ms })), ms);
		}),
	]).finally(() => clearTimeout(timer));
};

/** True when `error` came from `withTimeout` rather than from the operation itself. */
export const isTimeoutError = (error) => error instanceof TimeoutError;
