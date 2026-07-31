/**
 * Which phase of a render an error came from, tagged on the error itself so the worker can
 * attribute a failure without re-deriving it from the message. Puppeteer throws the same
 * `TimeoutError` for a navigation that never reached `waitUntil` and for a settle wait that
 * ran out — those have very different causes (slow origin vs. slow in-browser work), so the
 * phase is what makes the failure counters actionable.
 */
export type RenderPhase = 'navigation';

const PHASE_KEY = '__prerenderPhase';

/** Tag `err` with the phase it came from and return it (so it can be re-thrown inline). */
export function markRenderPhase<E>(err: E, phase: RenderPhase): E {
	if (err !== null && typeof err === 'object') {
		(err as Record<string, unknown>)[PHASE_KEY] = phase;
	}
	return err;
}

/** The phase tagged on `err`, or undefined if it carries none. */
export function renderPhaseOf(err: unknown): RenderPhase | undefined {
	if (err === null || typeof err !== 'object') return undefined;
	const phase = (err as Record<string, unknown>)[PHASE_KEY];
	return phase === 'navigation' ? phase : undefined;
}
