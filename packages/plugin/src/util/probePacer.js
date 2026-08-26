/**
 * The pacing arithmetic for a probe pass: how fast to go, and how much to give back when
 * something pushes back.
 *
 * Lives here rather than in `util/changeProbe.js` for the reason `sitemapRun.js` does: that
 * module reaches for `databases`, `server` and `metrics` at import time, so anything left inside
 * it can only be tested against a live Harper. Every function below is pure — clock and inputs
 * in, a number out — which is what lets the interesting cases (behind schedule, at the ceiling,
 * an empty slice, a first cycle with no estimate) be tested directly instead of inferred from a
 * sweep's counters.
 *
 * TWO GOVERNORS, DELIBERATELY SEPARATE. `originThrottle` answers "is the thing I am probing in
 * trouble", `loadThrottle` answers "is the node I am probing FROM in trouble". They multiply into
 * one pacing window, but they are tracked and reported apart because the operator question is
 * always which one is slowing the pass — a probe crawling because the origin is shedding load and
 * a probe crawling because it is losing the event loop to the serve path have nothing in common
 * except the symptom.
 */

/**
 * Requests per second needed to finish the rest of the slice inside the rest of the cycle.
 *
 * This is what makes continuous mode a schedule rather than a speed. The interval model asks the
 * operator to solve `corpus / rate <= interval` by hand and re-solve it every time the corpus
 * grows or the origin has a bad week; when the answer stops holding, the pass simply overruns and
 * is skipped, and the cadence silently halves with nothing saying so. Here the rate is DERIVED
 * from how far behind the walk actually is, every batch, so corpus growth and lost time are
 * absorbed continuously instead of discovered at the end.
 *
 *   - Nothing left to do -> 0. The caller reads that as "cycle complete", not "go infinitely
 *     slowly".
 *   - Budget already spent -> Infinity. Genuinely behind: the caller clamps to the ceiling and
 *     reports it. Returning a huge-but-finite number here would let the clamp look like a choice.
 *   - No usable estimate of the slice (the first cycle after a restart) -> Infinity, i.e. run at
 *     the ceiling and measure. A cycle target cannot be honoured against an unknown denominator,
 *     and guessing one would silently pace to a fiction.
 */
export const cycleRatePerSecond = ({ sliceSize, done, elapsed, cycleTarget }) => {
	if (!Number.isFinite(sliceSize) || sliceSize <= 0) return Infinity;
	if (!Number.isFinite(cycleTarget) || cycleTarget <= 0) return Infinity;

	const remaining = sliceSize - (Number.isFinite(done) ? done : 0);
	if (remaining <= 0) return 0;

	const left = cycleTarget - (Number.isFinite(elapsed) ? elapsed : 0);
	if (left <= 0) return Infinity;

	return (remaining / left) * 1000;
};

/**
 * The rate a batch is actually paced at, and whether the cycle target is out of reach at it.
 *
 * `ratePerSecond` is a CEILING and never a target: it is the number agreed with whoever runs the
 * origin, and no schedule of ours is a reason to exceed it. So a cycle that cannot be met simply
 * is not met — and says so. `behind` is the signal that replaces the interval model's silent
 * skip: the pass is flat out and still losing ground, which is a corpus that has outgrown its
 * agreed rate and wants either a longer target or a conversation about the ceiling.
 */
export const pacedRate = ({ ratePerSecond, cycleRate }) => {
	const ceiling = Math.max(1, ratePerSecond);
	if (!Number.isFinite(cycleRate)) return { rate: ceiling, behind: true };
	if (cycleRate <= 0) return { rate: ceiling, behind: false };
	return { rate: Math.min(ceiling, cycleRate), behind: cycleRate > ceiling };
};

/**
 * Move a backoff multiplier: double on pressure, halve on relief, clamped to `[1, max]`.
 *
 * The asymmetry is the whole design and it is shared by both governors. Doubling means the
 * response to pressure is immediate — one bad batch is enough — while halving means recovery
 * takes several clean batches, so a source of intermittent pressure is not repeatedly charged
 * full speed between episodes. A symmetric controller oscillates against exactly the kind of
 * load that makes an origin shed requests in the first place.
 */
export const stepBackoff = (current, pressured, max) => {
	const ceiling = Math.max(1, max);
	const at = Number.isFinite(current) && current >= 1 ? current : 1;
	if (pressured) return Math.min(at * 2, ceiling);
	return Math.max(1, at / 2);
};

/**
 * The pause after a batch, in ms.
 *
 * The window is the time the batch SHOULD have taken at the paced rate, stretched by both
 * governors; the pause is whatever of it the batch did not already spend. Subtracting the elapsed
 * time is what keeps the rate honest when the origin is slow: a batch that took longer than its
 * window has already paid for itself and waits no further.
 *
 * `retryAfterMs` outranks the arithmetic. The origin named a number, and guessing under it is
 * precisely the disrespect the header exists to prevent.
 *
 * The clamp is not decoration. This window is a PRODUCT — batch size, 1/rate, and two independent
 * multipliers — so values that are individually sane can multiply past `setTimeout`'s signed
 * 32-bit delay, and past it `setTimeout` fires after 1ms instead of waiting, turning a backoff
 * into a hot loop against something already asking for room.
 */
export const MAX_TIMER_MS = 2147483647;

export const batchPause = ({ batchSize, rate, originThrottle, loadThrottle, elapsed, retryAfterMs = 0 }) => {
	const window = (batchSize / Math.max(1, rate)) * 1000 * Math.max(1, originThrottle) * Math.max(1, loadThrottle);
	return Math.min(Math.max(window - elapsed, retryAfterMs, 0), MAX_TIMER_MS);
};
