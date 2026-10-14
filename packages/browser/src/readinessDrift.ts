/**
 * Readiness drift — noticing that a contract no longer matches the site, and saying so.
 *
 * ## Why
 *
 * A contract is written against a template, and templates change. When one does, a clause that named
 * the old markup stops holding on every render. The rot valve keeps that from costing CONTENT: the
 * render falls back to the timer-based settle and stores what the page has, which is the right trade.
 * What the valve does not do is tell anyone. Measured on a live product template: a redesign removed
 * the element one clause named, and that clause failed on 235,993 of 235,995 product renders over a
 * day. Every one of them paid the slow path, the render queue backed up behind them, and nothing said
 * why until a person went looking.
 *
 * So the worker keeps, per contract clause, the outcome of its last `window` applicable renders, and
 * logs a warning when the clause has failed on at least `threshold` of them. That is not something a
 * page does on its own: a clause failing on most renders of a page type means the contract and the
 * site disagree, and a person has to update one of them.
 *
 * ## What counts
 *
 * A clause FAILS a render when it does not hold on the page as serialized — `require[].ok` after the
 * contract's verdict is restated against the snapshot. Content that is merely slow does not count:
 * if the fallback settle caught it, the stored page has it and the clause holds. A clause its guard
 * skipped did not apply and is not counted either way. The caller decides which renders are eligible
 * at all; the worker passes only pages that rendered (a 200 document, content, indexable), because a
 * dead product page fails every clause and says nothing about the contract.
 *
 * ## Not a behaviour change
 *
 * Nothing here affects a render. The reports go to the log, for alerting, and the current set of
 * failing clauses rides on the worker's periodic stats line.
 */
import type { ReadinessResult } from './readiness.js';

export type ReadinessDriftPolicy = {
	/** Recent applicable renders per clause that the share is measured over. Default 50. */
	window: number;
	/** Renders a clause needs before any verdict, so one bad minute is not an alarm. Default 20. */
	minSamples: number;
	/**
	 * Share of those renders on which the clause failed, at or above which it is reported. Default 0.5.
	 * Healthy clauses fail on a few percent of renders (a product with no summary, a starved render the
	 * fallback could not rescue); a contract that no longer matches the template fails on nearly all.
	 * Recovery is reported once the share falls to half this, so a clause near the line does not flap.
	 */
	threshold: number;
	/** While a clause keeps failing, repeat the report this often (ms). Default one hour. */
	remindMs: number;
};

export const DEFAULT_DRIFT_POLICY: ReadinessDriftPolicy = {
	window: 50,
	minSamples: 20,
	threshold: 0.5,
	remindMs: 3_600_000,
};

export type DriftEvent = 'readiness-clause-failing' | 'readiness-clause-still-failing' | 'readiness-clause-recovered';

export type DriftReport = {
	event: DriftEvent;
	contract: string;
	clause: string;
	/** Renders in the current window on which the clause failed. */
	failed: number;
	/** Renders in the current window. */
	of: number;
	share: number;
	/** How the contract's window ended on those failing renders: `valve`, `deadline`, `stopped`… */
	exits: Record<string, number>;
	/** The most recent failing renders, `url (device)`, for a person to open. */
	examples: string[];
	/** When the clause crossed the threshold (ISO), on failing and still-failing reports. */
	failingSince?: string;
};

type Outcome = { failed: boolean; exit: string };

type ClauseState = {
	contract: string;
	clause: string;
	ring: Outcome[];
	next: number;
	examples: string[];
	failingSince: number | null;
	lastReport: number;
};

const EXAMPLES = 3;

export class ReadinessDrift {
	private readonly policy: ReadinessDriftPolicy;
	private readonly now: () => number;
	private readonly clauses = new Map<string, ClauseState>();

	constructor(policy: Partial<ReadinessDriftPolicy> = {}, now: () => number = Date.now) {
		this.policy = { ...DEFAULT_DRIFT_POLICY, ...policy };
		this.now = now;
	}

	/** Record one eligible render's verdict. Returns the reports it triggered, usually none. */
	record(result: ReadinessResult | undefined, url: string, deviceType: string): DriftReport[] {
		if (!result) return [];
		const reports: DriftReport[] = [];
		for (const r of result.require) {
			if (r.skipped) continue;
			const key = `${result.contract}\u0000${r.name}`;
			let state = this.clauses.get(key);
			if (!state) {
				state = {
					contract: result.contract,
					clause: r.name,
					ring: [],
					next: 0,
					examples: [],
					failingSince: null,
					lastReport: 0,
				};
				this.clauses.set(key, state);
			}
			const outcome = { failed: !r.ok, exit: result.exit ?? 'unknown' };
			if (state.ring.length < this.policy.window) state.ring.push(outcome);
			else state.ring[state.next] = outcome;
			state.next = (state.next + 1) % this.policy.window;
			if (outcome.failed) {
				state.examples.unshift(`${url} (${deviceType})`);
				state.examples.length = Math.min(state.examples.length, EXAMPLES);
			}
			const report = this.assess(state);
			if (report) reports.push(report);
		}
		return reports;
	}

	/** Clauses currently reported failing, for the worker's stats line. Empty when all is well. */
	failing(): Array<{ contract: string; clause: string; failed: number; of: number; share: number }> {
		const out = [];
		for (const state of this.clauses.values()) {
			if (state.failingSince === null) continue;
			const failed = state.ring.filter((o) => o.failed).length;
			out.push({
				contract: state.contract,
				clause: state.clause,
				failed,
				of: state.ring.length,
				share: round(failed / state.ring.length),
			});
		}
		return out;
	}

	private assess(state: ClauseState): DriftReport | null {
		const of = state.ring.length;
		if (of < this.policy.minSamples) return null;
		const failed = state.ring.filter((o) => o.failed).length;
		const share = failed / of;
		const now = this.now();
		let event: DriftEvent | null = null;
		if (state.failingSince === null) {
			if (share >= this.policy.threshold) {
				state.failingSince = now;
				event = 'readiness-clause-failing';
			}
		} else if (share <= this.policy.threshold / 2) {
			event = 'readiness-clause-recovered';
		} else if (now - state.lastReport >= this.policy.remindMs) {
			event = 'readiness-clause-still-failing';
		}
		if (!event) return null;
		state.lastReport = now;
		const exits: Record<string, number> = {};
		for (const o of state.ring) if (o.failed) exits[o.exit] = (exits[o.exit] ?? 0) + 1;
		const report: DriftReport = {
			event,
			contract: state.contract,
			clause: state.clause,
			failed,
			of,
			share: round(share),
			exits,
			examples: [...state.examples],
		};
		if (event === 'readiness-clause-recovered') {
			state.failingSince = null;
		} else {
			report.failingSince = new Date(state.failingSince as number).toISOString();
		}
		return report;
	}
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** The message a report is logged with: what failed, and what a person should do about it. */
export function driftMessage(report: DriftReport): string {
	const where = `readiness clause "${report.clause}" of contract "${report.contract}"`;
	const pct = Math.round(report.share * 100);
	if (report.event === 'readiness-clause-recovered') {
		return `${where} is holding again (failed on ${report.failed} of the last ${report.of} renders)`;
	}
	return (
		`${where} failed on ${report.failed} of the last ${report.of} renders (${pct}%): ` +
		'the contract no longer matches the page and needs updating; every such render pays the fallback settle'
	);
}

const MAX_TIMER_MS = 2147483647;

/** Config-load validation for `readiness.drift`. */
export function validateDriftPolicy(drift: unknown): void {
	if (drift === undefined || drift === false) return;
	if (typeof drift !== 'object' || drift === null) {
		throw new Error('prerender config: readiness.drift must be an object or false');
	}
	const d = drift as Record<string, unknown>;
	const int = (field: string, value: unknown) => {
		if (value !== undefined && (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 100_000)) {
			throw new Error(`prerender config: readiness.drift.${field} must be a positive integer`);
		}
	};
	int('window', d.window);
	int('minSamples', d.minSamples);
	const window = (d.window as number | undefined) ?? DEFAULT_DRIFT_POLICY.window;
	const minSamples = (d.minSamples as number | undefined) ?? DEFAULT_DRIFT_POLICY.minSamples;
	if (minSamples > window) {
		throw new Error('prerender config: readiness.drift.minSamples cannot exceed readiness.drift.window');
	}
	const t = d.threshold;
	if (t !== undefined && (typeof t !== 'number' || !(t > 0 && t <= 1))) {
		throw new Error('prerender config: readiness.drift.threshold must be a number above 0 and at most 1');
	}
	const r = d.remindMs;
	if (r !== undefined && (typeof r !== 'number' || !Number.isFinite(r) || r <= 0 || r > MAX_TIMER_MS)) {
		throw new Error(`prerender config: readiness.drift.remindMs must be a positive number up to ${MAX_TIMER_MS}`);
	}
}
