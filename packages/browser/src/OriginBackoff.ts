import logger from './util/Logger.js';
import { settings } from './settings.js';
import { renderPhaseOf } from './util/renderPhase.js';

/**
 * ORIGIN BACKOFF: this worker renders on fewer slots while the origin is failing its navigations.
 *
 * WHY HERE, AND NOT IN THE QUEUE. The queue only learns that a render failed when its result is posted, and
 * it serves a fleet rendering for every route at once; an origin outage is usually narrower than that (one
 * backend behind one kind of page). The renderer is the one client that sees its own requests to the origin
 * fail, as they fail, so it is the one that backs them off. Each worker judges only its own navigations and
 * needs nothing from the queue or the other workers.
 *
 * WHAT COUNTS. A navigation the origin failed: the document never arrived (a navigation timeout, a refused
 * or reset connection: anything `page.goto` threw), or it arrived with 408, 429 or a 5xx. Everything else the
 * origin answered, including a 404 or a redirect, counts as answered: those are verdicts about one page, not
 * distress. A render that never reached the origin (no page could be opened, a protocol fault) says nothing
 * about it and is not counted.
 *
 * THE CURVE, judged once per `windowMs` on the window just closed:
 *   - at least `minNavigations` navigations and at least `failureShare` of them failed: HALVE the share of
 *     render slots in use (never below one slot, which keeps a trickle of renders asking whether the origin is
 *     back);
 *   - fewer than `minNavigations`, but still failing at that share: HOLD. A worker already down to one slot
 *     sees few navigations a window, and a thin sample of failures is not a reason to ramp back up;
 *   - otherwise: add back `recoverStep` of the full concurrency (a window with nothing in it counts as
 *     healthy, so an idle worker recovers).
 * Immediate cut, gradual recovery: the asymmetry a backoff needs, so a recovering origin is not handed the
 * full fleet the minute it answers once.
 *
 * The claim size follows the same share, so a worker that renders on fewer slots does not hold leases for
 * jobs it cannot start; they stay in the queue for a worker that can.
 */

export type OriginVerdict = 'answered' | 'failed';

const distressStatus = (statusCode: number) => statusCode === 408 || statusCode === 429 || statusCode >= 500;

/**
 * What one finished render variant says about the origin: `failed`, `answered`, or null when the render
 * never got as far as the origin.
 */
export function originVerdict(error: unknown, statusCode: number | undefined): OriginVerdict | null {
	// A status the document arrived with decides, whatever was thrown after it: the renderer aborts its own
	// navigation signal on a document of 400 or more, and that abort must not read as the origin failing.
	if (typeof statusCode === 'number' && statusCode > 0) return distressStatus(statusCode) ? 'failed' : 'answered';
	if (error && renderPhaseOf(error) === 'navigation') {
		// A redirect loop is the origin answering, over and over: a page's verdict, not distress.
		if (error instanceof Error && error.message.startsWith('net::ERR_TOO_MANY_REDIRECTS')) return 'answered';
		return 'failed';
	}
	return null;
}

// A floor on the share kept, far under one slot of any real concurrency: `slots` rounds up to one anyway.
const MIN_SHARE = 1 / 64;

export class OriginBackoff {
	/** The share of render slots (and of the claim size) in use: 1 is the configured concurrency. */
	share = 1;

	private windowStart: number;
	private answered = 0;
	private failed = 0;

	constructor(private readonly now: () => number = Date.now) {
		this.windowStart = now();
	}

	/** Count one finished render variant's navigation. */
	record(verdict: OriginVerdict | null): void {
		if (verdict === null || !settings.originBackoff.enabled) return;
		this.roll();
		if (verdict === 'failed') this.failed++;
		else this.answered++;
	}

	/** Render slots to use out of `concurrency`: at least one, never more than configured. */
	slots(concurrency: number): number {
		return this.scaled(concurrency);
	}

	/** Jobs to claim at once out of `limit`, at the same share as the slots. */
	claimLimit(limit: number): number {
		return this.scaled(limit);
	}

	private scaled(full: number): number {
		if (!settings.originBackoff.enabled) {
			this.share = 1;
			return full;
		}
		this.roll();
		return Math.max(1, Math.min(full, Math.round(full * this.share)));
	}

	/** Judge every window that has closed since the last call, then start counting the current one. */
	private roll(): void {
		const { windowMs } = settings.originBackoff;
		const now = this.now();
		const elapsed = now - this.windowStart;
		// A clock reading that is not a number would make `windowStart` NaN for good, and every later call would
		// judge a window of one navigation. Start the window over at this reading instead; the share stays.
		if (!Number.isFinite(elapsed)) {
			this.windowStart = now;
			return;
		}
		if (elapsed < windowMs) return;
		const windows = Math.floor(elapsed / windowMs);
		this.judge(this.answered, this.failed);
		// Windows that passed with nothing counted in them: nothing failed in them either.
		for (let i = 1; i < windows && this.share < 1; i++) this.judge(0, 0);
		this.windowStart += windows * windowMs;
		this.answered = 0;
		this.failed = 0;
	}

	private judge(answered: number, failed: number): void {
		const { minNavigations, failureShare, recoverStep, windowMs } = settings.originBackoff;
		const navigations = answered + failed;
		const failing = navigations > 0 && failed >= failureShare * navigations;
		const before = this.share;
		if (failing && navigations >= minNavigations) {
			this.share = Math.max(MIN_SHARE, this.share / 2);
		} else if (!failing) {
			this.share = Math.min(1, this.share + recoverStep);
		}
		if (this.share === before) return;
		const counts = { navigations, failed, windowSec: Math.round(windowMs / 1000) };
		if (this.share < before) {
			logger.warn(
				{ ...counts, share: this.share, previousShare: before },
				'the origin is failing most navigations: rendering on fewer slots (originBackoff)'
			);
		} else {
			logger.info(
				{ ...counts, share: this.share, previousShare: before },
				this.share === 1
					? 'the origin is answering again: back to full concurrency (originBackoff)'
					: 'the origin is answering again: adding render slots back (originBackoff)'
			);
		}
	}
}

let singleton: OriginBackoff | null = null;

/** The process's origin backoff, shared by the claim loop (claim size) and the worker (slots, verdicts). */
export const getOriginBackoff = (): OriginBackoff => (singleton ??= new OriginBackoff());

/** Tests: start from full concurrency, optionally on a clock of their own. */
export const resetOriginBackoff = (now?: () => number): OriginBackoff => (singleton = new OriginBackoff(now));
