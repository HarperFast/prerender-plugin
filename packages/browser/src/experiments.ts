/**
 * TEMPORARY MEASUREMENT SCAFFOLDING — not a feature, not configuration, and not shipped.
 *
 * `bench/render-cpu` measures a candidate change against the code it would replace in ONE process,
 * against one fixture, minutes apart. That is only possible if both paths exist at once, which is
 * what these flags are for. Every flag defaults OFF, so an unflagged render — which is every render
 * outside the bench — behaves exactly as it did before this file existed.
 *
 * The rule for this file: whatever wins becomes unconditional and its flag is DELETED, together
 * with the path it beat. If this file is still here when the work lands, the work is not finished.
 */

export type Experiments = {
	/** Fold the DOM element count into the scroll-pass call (count at pass entry). */
	combineScrollCount: boolean;
	/** Fold scroll-into-view + match count into one call per waitFor poll tick. */
	combineWaitFor: boolean;
	/** Return structured offers and the serialized document from one call. */
	combineTail: boolean;
	/** Install the in-page helpers once at document start instead of per call. */
	installHelpers: boolean;
	/** A minCount:1 gate is an existence test — short-circuit instead of counting every match. */
	existsShortCircuit: boolean;
	/** Count with native querySelectorAll/getElementsByTagName instead of a JS child walk. */
	nativeCount: boolean;
	/** Document-start MutationObserver keeps the element count; a poll reads a number. */
	monitor: boolean;
	/** Emulate prefers-reduced-motion for the render. */
	reducedMotion: boolean;
	/** Accumulate a wall-clock split of the settle phase into `splits` (below). */
	instrument: boolean;
	/** Drive scroll passes from requestAnimationFrame instead of a fixed per-step timer. */
	rafScroll: boolean;
	/**
	 * Skip the pre-gate DOM-stability plateau when `finalDomStable` is on.
	 *
	 * With `finalDomStable`, the renderer measures a plateau TWICE: once before the waitFor gates and
	 * again after them. The second is strictly later and therefore strictly stronger — it is the one
	 * that decides the snapshot. The first costs at least `domStableMs` plus a poll interval on every
	 * render that reaches it.
	 */
	skipPreGatePlateau: boolean;
	/**
	 * Skip `scroll.topSettleMs` when a plateau follows.
	 *
	 * The dwell exists to let a throttled scroll handler run one tick after `scrollTo(0, 0)`. What
	 * follows it on the deployed profile is hundreds of milliseconds of further waiting before
	 * anything is serialized, so the handler has already run many times over.
	 */
	skipTopSettleBeforePlateau: boolean;
	/**
	 * Skip the `waitForNetworkIdle` call that sits directly in front of a DOM-stability plateau.
	 *
	 * On the deployed profile `networkIdleMs` (500) equals `networkIdleTimeoutMs` (500), so the call
	 * can never observe its idle window and is a fixed sleep. The plateau that follows is a strictly
	 * stronger readiness test for a DOM snapshot: a response that does not change the DOM cannot
	 * change the output, and one that does resets the plateau.
	 */
	skipIdleBeforePlateau: boolean;
	/** Skip the `waitForNetworkIdle` between the scroll pass and the return to the top. */
	skipIdleAfterScroll: boolean;
};

export const DEFAULT_EXPERIMENTS: Experiments = {
	combineScrollCount: false,
	combineWaitFor: false,
	combineTail: false,
	installHelpers: false,
	existsShortCircuit: false,
	nativeCount: false,
	monitor: false,
	reducedMotion: false,
	instrument: false,
	rafScroll: false,
	skipPreGatePlateau: false,
	skipTopSettleBeforePlateau: false,
	skipIdleBeforePlateau: false,
	skipIdleAfterScroll: false,
};

/**
 * Where the settle phase's WALL time goes, accumulated when `instrument` is on.
 *
 * The first bench run showed a render burning 7.4s of wall for 2.6s of CPU: most of settle is
 * WAITING, not working. Which wait — the per-step scroll timer, the network-idle window, the poll
 * sleep between ticks, or the gate's own dwell — decides which lever is worth pulling, and none of
 * the existing timings separate them.
 */
export type SettleSplit = {
	scrollMs: number;
	idleMs: number;
	countMs: number;
	gateMs: number;
	gateTicks: number;
	passes: number;
	/** Wall time inside the DOM-stability plateau waits, which `countMs` (the evaluate alone) misses. */
	plateauMs: number;
	plateaus: number;
	/** `scroll.topSettleMs` dwells — the last unattributed piece of the settle budget. */
	topSettleMs: number;
};

export const splits: SettleSplit = {
	scrollMs: 0,
	idleMs: 0,
	countMs: 0,
	gateMs: 0,
	gateTicks: 0,
	passes: 0,
	plateauMs: 0,
	plateaus: 0,
	topSettleMs: 0,
};

export const resetSplits = (): void => {
	Object.assign(splits, { scrollMs: 0, idleMs: 0, countMs: 0, gateMs: 0, gateTicks: 0, passes: 0, plateauMs: 0, plateaus: 0, topSettleMs: 0 });
};

/** Time an awaited step into one of the split buckets. Identity when instrumentation is off. */
export const timed = async <T>(bucket: keyof SettleSplit, fn: () => Promise<T>): Promise<T> => {
	if (!experiments.instrument) return await fn();
	const started = Date.now();
	try {
		return await fn();
	} finally {
		(splits[bucket] as number) += Date.now() - started;
	}
};

/** Mutable singleton: the bench assigns onto it between runs; the renderer reads it. */
export const experiments: Experiments = { ...DEFAULT_EXPERIMENTS };

export const resetExperiments = (): void => {
	Object.assign(experiments, DEFAULT_EXPERIMENTS);
	resetSplits();
};
