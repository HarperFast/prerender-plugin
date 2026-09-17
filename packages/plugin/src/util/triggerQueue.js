/**
 * A bounded, separately-paced queue for change-probe triggers.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────
 *
 * The sweep used to run `await trigger(row)` inside the row handler. Triggering is six database
 * operations (a read and a patch per device page, plus the schedule write), so with the handler's
 * concurrency shared between probing and triggering, TRIGGER VOLUME SET PASS DURATION — and pass
 * duration is detection latency, because the interval between two probes of the same URL is one
 * pass.
 *
 * That closes a loop: more change -> more triggers -> longer pass -> a longer window in which each
 * URL can change -> more change detected per pass -> more triggers. Measured on one deployment,
 * arming the probe took a pass from 9.2h to a projected ~21h with bot traffic flat across both
 * windows (153,728/hr vs 150,743/hr, so contention was ruled out), and every available config knob
 * traded deferrals against latency rather than escaping the loop. Raising the trigger budget made
 * the pass longer; lowering it shed more change. Neither is a fix.
 *
 * Submitting instead of awaiting breaks the loop: the sweep runs at its probe-rate floor whatever
 * the change rate, and triggers drain beside it at their own pace. Pass duration becomes
 * `max(probe time, drain time)` instead of the sum, and the knob that matters becomes triggers per
 * SECOND — what the render fleet actually experiences — rather than triggers per pass.
 *
 * ── WHAT IS PRESERVED EXACTLY ────────────────────────────────────────────────────────────────
 *
 * The baseline write still happens ONLY after a successful trigger, and it happens HERE rather
 * than in the caller, because that ordering is the whole retry story: a trigger that fails, or one
 * that never ran because the queue was cleared, leaves the stored signature stale, so the next
 * pass re-detects the same change and tries again. Writing the baseline at submit time would lose
 * the change outright on any failure. `test/triggerQueue.test.js` pins this.
 *
 * A full queue is reported to the caller as a refusal, which the sweep counts as `deferred` — the
 * same accounting the per-pass budget already produced, and with the same stale-signature
 * semantics, so nothing downstream has to learn a new state.
 *
 * ── DELIBERATELY IN MEMORY, AND DELIBERATELY NOT DURABLE ─────────────────────────────────────
 *
 * Losing the queue costs nothing but a repeat detection: every unsettled item still has its old
 * signature stored, so the next pass finds it again. That is why `stop()` may simply drop pending
 * work, and why a restart mid-pass needs no recovery path. Durability here would buy nothing and
 * add a table on the probe's write path, which is the one thing `ProbeState`'s design avoids.
 */

/** The outcome of a submit, as the caller's stats understand it. */
export const SUBMIT_QUEUED = 'queued';
export const SUBMIT_FULL = 'full';

/**
 * @param {object} ports
 * @param {(row: object) => Promise<void>} ports.trigger   performs the re-render trigger
 * @param {(url: string, observed: string, opts: object) => Promise<void>} ports.write  baseline write
 * @param {number} ports.maxPending      queue depth before submissions are refused
 * @param {number} ports.ratePerSecond   drain pace; 0 or less means unpaced
 * @param {number} ports.concurrency     triggers in flight at once
 * @param {(ms: number) => Promise<void>} [ports.sleep]
 * @param {() => number} [ports.now]
 * @param {(error: unknown, item: object) => void} [ports.onError]
 */
export const createTriggerQueue = ({
	trigger,
	write,
	maxPending = 5000,
	ratePerSecond = 10,
	concurrency = 4,
	sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now = () => Date.now(),
	onError,
} = {}) => {
	const pending = [];
	const stats = { triggered: 0, errors: 0, refused: 0, maxDepth: 0 };
	let stopped = false;
	let inFlight = 0;
	let pumping = false;
	// The next instant a trigger may start, advanced by one slot per dispatch. Pacing the START of
	// each trigger rather than sleeping between completions keeps the rate honest when triggers
	// have uneven latency, which they do: a page miss is one read, a hit is a read and a patch.
	let nextSlotAt = 0;
	let idleResolvers = [];

	const slotMs = ratePerSecond > 0 ? 1000 / ratePerSecond : 0;

	const settleIdle = () => {
		if (pending.length || inFlight) return;
		const waiting = idleResolvers;
		idleResolvers = [];
		for (const resolve of waiting) resolve();
	};

	const runOne = async (item) => {
		try {
			await trigger(item.row);
			stats.triggered++;
			// AFTER the trigger, never before — see the module comment. `clearClaim` goes with it
			// because the trigger hard-expired the page, so whatever the stored page claim described
			// is no longer being served.
			await write(item.row.url, item.observed, {
				rowExists: item.rowExists,
				clearClaim: true,
				fingerprint: item.fingerprint,
			});
		} catch (e) {
			stats.errors++;
			// Swallowed on purpose: the signature stays stale, so the next pass retries this URL.
			// A trigger failure must never take down the pass that submitted it.
			onError?.(e, item);
		}
	};

	const pump = async () => {
		if (pumping) return;
		pumping = true;
		try {
			while (!stopped && pending.length && inFlight < concurrency) {
				if (slotMs > 0) {
					const at = now();
					const startAt = Math.max(at, nextSlotAt);
					nextSlotAt = startAt + slotMs;
					const wait = startAt - at;
					if (wait > 0) await sleep(wait);
					// `stopped` can flip while we were asleep.
					if (stopped) break;
				}
				const item = pending.shift();
				if (!item) break;
				inFlight++;
				runOne(item).finally(() => {
					inFlight--;
					settleIdle();
					// Re-enter rather than recurse: `pump` is single-flight, so this just restarts the
					// loop if it has already exited.
					void pump();
				});
			}
		} finally {
			pumping = false;
			settleIdle();
		}
	};

	return {
		stats,

		/**
		 * Offer one detected change. Returns `SUBMIT_QUEUED` or `SUBMIT_FULL`; never throws and
		 * never waits on the trigger itself, which is the entire point.
		 */
		submit(item) {
			if (stopped || pending.length >= maxPending) {
				stats.refused++;
				return SUBMIT_FULL;
			}
			pending.push(item);
			if (pending.length > stats.maxDepth) stats.maxDepth = pending.length;
			void pump();
			return SUBMIT_QUEUED;
		},

		/** Resolves once everything submitted so far has settled. */
		async drain() {
			void pump();
			if (!pending.length && !inFlight) return;
			await new Promise((resolve) => idleResolvers.push(resolve));
		},

		/**
		 * Stop accepting and abandon what is pending. Safe by construction: an abandoned item never
		 * had its baseline written, so the next pass re-detects it.
		 */
		stop() {
			stopped = true;
			const dropped = pending.length;
			pending.length = 0;
			settleIdle();
			return dropped;
		},

		get depth() {
			return pending.length + inFlight;
		},
	};
};

/**
 * The synchronous shape, for callers that should not decouple: the canary.
 *
 * Its cohort is a few hundred URLs and its whole value is being fast and immediate, so queuing
 * would add machinery to a path with nothing to gain from it. Same contract, so `runProbePass`
 * has one code path rather than a branch.
 */
export const createInlineTrigger = ({ trigger, write, onError } = {}) => {
	const stats = { triggered: 0, errors: 0, refused: 0, maxDepth: 0 };
	return {
		stats,
		async submit(item) {
			try {
				await trigger(item.row);
				stats.triggered++;
				await write(item.row.url, item.observed, {
					rowExists: item.rowExists,
					clearClaim: true,
					fingerprint: item.fingerprint,
				});
			} catch (e) {
				stats.errors++;
				onError?.(e, item);
			}
			return SUBMIT_QUEUED;
		},
		async drain() {},
		stop() {
			return 0;
		},
		get depth() {
			return 0;
		},
	};
};
