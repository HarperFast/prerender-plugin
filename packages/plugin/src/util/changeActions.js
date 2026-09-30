/**
 * What the change probe does with a detected change, and how many it does at once.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────────────────────
 *
 * A page the probe found changed is acted on WHEN IT IS FOUND: hard-expired (it is known wrong, so
 * one more serve is a served mismatch) and its render filed, ahead of routine rotation
 * (`changedAt` on the schedule row; `util/renderPriority.js`). The render queue is what orders the
 * work, and it holds every row of the node already: a change wave is a reordering of rows it has,
 * not an injection it has to be protected from.
 *
 * Before v0.94.0 a change went into an in-memory queue drained at `trigger.ratePerSecond` (3/s on
 * one deployment), capped at `trigger.maxPending` and `maxTriggersPerSweep`, with everything past
 * either cap DEFERRED to the next pass. On a day when 60% of a product corpus changed overnight,
 * each node took over 12 hours to drain, deferred ~35k changes it had detected, and still held
 * thousands when a restart dropped the queue — every one of those pages kept serving content the
 * probe knew was wrong, until the next day's pass found it again. The cap existed for reasons that
 * are gone (the claim floor, and the claim scan's cost when due rows pile onto one minute); the
 * render fleet's capacity is real, but it bounds how fast pages RE-RENDER, not how fast a known-
 * wrong page should stop being served.
 *
 * ── WHY IT IS NOT AWAITED IN-LINE, AND WHY IT IS NOT A QUEUE EITHER ──────────────────────────
 *
 * Acting is a handful of database operations (a read and a patch per device page, the schedule
 * write, the new baseline), and awaiting them inside the probe's row handler made the change rate
 * set the pass duration: measured once at 9.2h -> ~21h, and pass duration is detection latency.
 * So `submit` starts the action and returns; the pass keeps probing. What bounds the work is
 * CONCURRENCY — at most `concurrency` actions in flight — and when every slot is busy `submit`
 * waits for one. That wait is backpressure on the pass, never a refusal: nothing detected is
 * dropped or deferred, and the pass only slows if the database genuinely cannot keep up.
 *
 * ── ORDER, AND WHAT A RESTART COSTS ──────────────────────────────────────────────────────────
 *
 * The new baseline is written LAST, after the action succeeds. Anything that stops an action — a
 * failure, a restart mid-flight — leaves the stored signature stale, so the next probe of that URL
 * detects the same change and acts again. Actions are idempotent: an already hard-expired page is
 * not patched again, and a row already filed for a change keeps its place (`actOnChange`). So a
 * restart loses at most the `concurrency` actions in flight, and not even those: they are found
 * again, and the interrupted pass itself resumes on boot from its walk cursor (`changeProbe.js`,
 * `checkResume`), which is held back to the lowest URL still in flight here (`lowestInFlight`) so an
 * action a crash cut off is re-probed rather than skipped.
 *
 * ── A FAILED ACTION IS RETRIED ONCE, AFTER THE WALK ──────────────────────────────────────────
 *
 * "The next probe acts again" is only as good as the next probe is soon. The walk cursor has moved
 * past a failed URL, so in anchored mode its next probe is tomorrow's pass — a whole day of serving a
 * page the probe KNOWS is wrong, for what is usually a transient database refusal. So the first
 * `retryLimit` failures of a pass are kept and `retryFailed()` acts on each once more when the walk is
 * done (the caller runs it after the drain). A retry that succeeds counts `recovered`; one that fails
 * again, and any failure past the bound, is left to the next probe as before. The list is bounded
 * because a failure storm (a database refusing every write) is exactly when holding every item would
 * cost the most memory and buy the least — those retries would fail too. A retry first asks the caller
 * whether the detection still stands (`stillDue`): hours can pass between the two, and a page re-rendered
 * or a baseline re-written meanwhile must not be expired, or written over, on the walk's old evidence. A restart during the retries
 * loses them to the next pass: the cursor is not held back for them, which would make a resume re-probe
 * everything after the pass's first failure.
 */

// Failed actions kept for the after-walk retry — see the module comment.
export const RETRY_LIMIT = 1000;

/**
 * @param {object} ports
 * @param {(row: object, item: object) => Promise<string | void>} ports.act    expire the page and file
 *   its render; resolving 'covered' or 'healed' means it deliberately did nothing (see `run`)
 * @param {(item: object) => Promise<boolean>} [ports.stillDue]  before an after-walk retry: is the
 *   detection still current? False skips the retry (counted `retryStale`)
 * @param {(url: string, observed: string, opts: object) => Promise<void>} ports.write  baseline write
 * @param {number} ports.concurrency    actions in flight at once
 * @param {(error: unknown, item: object) => void} [ports.onError]
 */
export const createChangeActions = ({
	act,
	write,
	concurrency = 8,
	onError,
	now = () => Date.now(),
	retryLimit = RETRY_LIMIT,
	stillDue = null,
} = {}) => {
	const limit = Math.max(1, concurrency | 0);
	// `waitMs` is how long the pass spent blocked on a full pipeline — the one way actions can slow a
	// pass, so the one number that says whether they did. `errors` counts FIRST attempts that threw;
	// `retried`/`recovered` are the after-walk retries and the ones that succeeded, so
	// `errors - recovered` is what is left for the next probe; `retrySkipped` failed past the bound.
	const stats = {
		triggered: 0,
		covered: 0,
		healed: 0,
		errors: 0,
		retried: 0,
		recovered: 0,
		retrySkipped: 0,
		retryStale: 0,
		maxInFlight: 0,
		waits: 0,
		waitMs: 0,
	};
	const failed = [];
	let inFlight = 0;
	const inFlightUrls = new Map(); // url -> count (a URL is acted on once per pass, but be exact)
	let stopped = false;
	// Resolvers waiting for a slot (submit) and for idleness (drain).
	let slotWaiters = [];
	let idleWaiters = [];

	const release = (url) => {
		inFlight--;
		const n = (inFlightUrls.get(url) ?? 1) - 1;
		if (n > 0) inFlightUrls.set(url, n);
		else inFlightUrls.delete(url);
		const next = slotWaiters.shift();
		if (next) next();
		if (inFlight === 0 && !slotWaiters.length) {
			const waiting = idleWaiters;
			idleWaiters = [];
			for (const resolve of waiting) resolve();
		}
	};

	const run = async (item, retry) => {
		try {
			// A retry hours after the detection must not act on what the walk saw then: if the baseline
			// has moved since, or a page re-rendered after the change was found, the next probe is the one
			// to decide (`stillDue`, changeProbe.js).
			if (retry && stillDue && !(await stillDue(item))) {
				stats.retryStale++;
				return;
			}
			// What the action did (changeProbe.js `actOnChange`): 'acted' (or nothing, for an injected
			// `act`), or one of the two cases an active invalidation leaves nothing to do for —
			// 'covered' (no baseline either: the change stays detectable) and 'healed' (the baseline
			// moves; the claim stays, since no page was expired and it still describes the cached one).
			const outcome = (await act(item.row, item)) ?? 'acted';
			if (outcome === 'covered') {
				stats.covered++;
			} else {
				// AFTER the action, never before — see the module comment. `clearClaim` goes with it
				// because the page was just hard-expired, so whatever the stored page claim described is
				// no longer being served.
				const acted = outcome !== 'healed';
				await write(item.row.url, item.observed, {
					rowExists: item.rowExists,
					clearClaim: acted,
					fingerprint: item.fingerprint,
				});
				if (acted) stats.triggered++;
				else stats.healed++;
			}
			if (retry) stats.recovered++;
		} catch (e) {
			if (!retry) {
				stats.errors++;
				if (failed.length < Math.max(0, retryLimit | 0)) failed.push(item);
				else stats.retrySkipped++;
			}
			// Swallowed on purpose: the signature stays stale, so the next probe of this URL acts again. An
			// action failure must never take down the pass that found the change.
			onError?.(e, item, { retry });
		} finally {
			release(item.row.url);
		}
	};

	const start = (item, retry) => {
		inFlight++;
		inFlightUrls.set(item.row.url, (inFlightUrls.get(item.row.url) ?? 0) + 1);
		if (inFlight > stats.maxInFlight) stats.maxInFlight = inFlight;
		void run(item, retry);
	};
	const slotFree = async (honourStop) => {
		while ((!honourStop || !stopped) && inFlight >= limit) await new Promise((resolve) => slotWaiters.push(resolve));
	};

	return {
		stats,

		/**
		 * Act on one detected change. Resolves once the action has STARTED — at once while a slot is
		 * free, otherwise when one frees up. Never rejects. After `stop()` it starts nothing, and the
		 * change stays detectable (its baseline was never written).
		 */
		async submit(item) {
			if (!stopped && inFlight >= limit) {
				const started = now();
				stats.waits++;
				await slotFree(true);
				stats.waitMs += now() - started;
			}
			if (stopped) return false;
			start(item, false);
			return true;
		},

		/**
		 * Act once more on every action that failed so far (up to `retryLimit`), then wait for them —
		 * see the module comment. Runs after `stop()` too: stopping ends the WALK's submissions, and a
		 * retry is database work the walk already decided on, not a new detection. Never rejects.
		 */
		async retryFailed() {
			const items = failed.splice(0);
			for (const item of items) {
				await slotFree(false);
				stats.retried++;
				start(item, true);
			}
			if (inFlight > 0) await new Promise((resolve) => idleWaiters.push(resolve));
		},

		/** Resolves once every action started so far has settled. */
		async drain() {
			if (inFlight === 0) return;
			await new Promise((resolve) => idleWaiters.push(resolve));
		},

		/**
		 * Start nothing more. Actions in flight finish (a database write cannot be recalled); a submit
		 * waiting for a slot returns without acting.
		 */
		stop() {
			stopped = true;
			const waiting = slotWaiters;
			slotWaiters = [];
			for (const resolve of waiting) resolve();
		},

		get inFlight() {
			return inFlight;
		},

		/** The lowest URL (walk order) with an action still in flight, or null — what a resume must not skip. */
		get lowestInFlight() {
			let lowest = null;
			for (const url of inFlightUrls.keys()) if (lowest === null || url < lowest) lowest = url;
			return lowest;
		},
	};
};
