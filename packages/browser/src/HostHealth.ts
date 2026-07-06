import { settings } from './settings.js';

/**
 * Per-host availability model shared by the claim loop (RenderQueueConsumer) and the
 * result poster (RenderJob). It answers one question — "may I contact host X right now?"
 * — from three signals, all collapsed onto two future timestamps per host:
 *
 *   - `nextPollAt`  — when there is (believed to be) work again. Pushed out on an empty
 *                     claim or an `empty`/`paused` status; reset to now on `queued`/jobs.
 *   - `circuitUntil` — when an overloaded/unreachable host may be contacted again. Set by
 *                      a 503/429/502/504 or a network error, with exponential jittered
 *                      backoff (honoring `Retry-After` when present).
 *
 * A host is eligible iff `now >= max(nextPollAt, circuitUntil)`. Keeping the two axes
 * separate means "has work" (queued) never shortens an active error backoff — we don't
 * slam a host that has work but is currently shedding load.
 *
 * MQTT status messages are reconciled by the producer's own `updatedTime` so an
 * out-of-order/retained delivery can't clobber fresher state (same producer clock, so
 * the comparison is valid). Claim/result outcomes are real-time local events and always
 * apply.
 */

const RETRY_AFTER_CAP_MS = 2 * 60 * 1000;

type HostRecord = {
	/** Earliest time we should poll this host for work again (idle/empty backoff). */
	nextPollAt: number;
	/** Earliest time we may contact this host at all (error/circuit backoff). */
	circuitUntil: number;
	/** Consecutive unavailability failures, for exponential backoff. */
	failures: number;
	/** Producer `updatedTime` of the last applied MQTT status (for ordering). */
	statusTime: number;
};

export type HostHealthOptions = {
	idleMs: number;
	minMs: number;
	maxMs: number;
	pausedMs: number;
	maxIdleMs: number;
	/** Injectable clock for tests. Defaults to Date.now. */
	now?: () => number;
	/** Injectable jitter in [0,1) for tests. Defaults to Math.random. */
	random?: () => number;
};

export class HostHealth {
	private hosts = new Map<string, HostRecord>();
	private waiters = new Set<() => void>();

	private idleMs: number;
	private minMs: number;
	private maxMs: number;
	private pausedMs: number;
	private maxIdleMs: number;
	private now: () => number;
	private random: () => number;

	constructor(opts: HostHealthOptions) {
		this.idleMs = opts.idleMs;
		this.minMs = opts.minMs;
		this.maxMs = opts.maxMs;
		this.pausedMs = opts.pausedMs;
		this.maxIdleMs = opts.maxIdleMs;
		this.now = opts.now ?? Date.now;
		this.random = opts.random ?? Math.random;
	}

	private record(host: string): HostRecord {
		let rec = this.hosts.get(host);
		if (!rec) {
			rec = { nextPollAt: 0, circuitUntil: 0, failures: 0, statusTime: 0 };
			this.hosts.set(host, rec);
		}
		return rec;
	}

	/** Exponential backoff with equal jitter, honoring a capped Retry-After when given. */
	private circuitBackoff(failures: number, retryAfterMs?: number): number {
		// Honor only a *positive* Retry-After, floored at minMs and capped: `Retry-After: 0`
		// and past HTTP-dates both parse to 0, so a naive `>= 0` here would set the circuit to
		// now+0 → the host is instantly re-eligible and the loop tight-spins the very host that
		// just said it's overloaded. Non-positive → fall through to the exponential path.
		if (retryAfterMs != null && retryAfterMs > 0) {
			return Math.min(RETRY_AFTER_CAP_MS, Math.max(this.minMs, retryAfterMs));
		}
		const exp = Math.min(this.maxMs, this.minMs * 2 ** Math.max(0, failures - 1));
		// Equal jitter: half fixed, half random — decorrelates retries across workers so
		// they don't re-storm an overloaded host in lockstep.
		return Math.round(exp / 2 + this.random() * (exp / 2));
	}

	/** Idle re-poll delay with ±25% jitter (decorrelates empty re-polls across workers). */
	private idleBackoff(base: number): number {
		return Math.round(base * (0.75 + this.random() * 0.5));
	}

	private availableAt(rec: HostRecord): number {
		return Math.max(rec.nextPollAt, rec.circuitUntil);
	}

	/**
	 * Apply an MQTT `queue_status` message. `updatedTime` is the producer's own clock;
	 * a message older than the last one we applied for this host is ignored.
	 */
	applyMqttStatus(host: string, status: string, updatedTime?: number): void {
		const rec = this.record(host);
		if (updatedTime != null && Number.isFinite(updatedTime)) {
			if (updatedTime < rec.statusTime) return; // stale / out-of-order
			rec.statusTime = updatedTime;
		}
		const now = this.now();
		if (status === 'queued') {
			rec.nextPollAt = 0; // there is work — poll as soon as the circuit (if any) allows
			this.maybeNotify(rec); // if eligible now (no open circuit), wake a sleeper
		} else if (status === 'paused') {
			rec.nextPollAt = now + this.pausedMs;
		} else {
			// 'empty' (or anything unrecognized): treat as no work for a while.
			rec.nextPollAt = now + this.idleBackoff(this.idleMs);
		}
	}

	/** A claim returned jobs — host is healthy and has work; keep claiming. */
	recordJobs(host: string): void {
		const rec = this.record(host);
		rec.failures = 0;
		rec.circuitUntil = 0;
		rec.nextPollAt = 0;
	}

	/** A claim returned zero jobs (200) — host is healthy but drained; back off polling. */
	recordEmpty(host: string): void {
		const rec = this.record(host);
		rec.failures = 0;
		rec.circuitUntil = 0;
		rec.nextPollAt = this.now() + this.idleBackoff(this.idleMs);
	}

	/**
	 * Open (or extend) the circuit. The failure exponent escalates only ONCE per open
	 * window: concurrent in-flight failures (the claim loop plus every parallel result POST
	 * share this one record) and a host's own retries, all firing while the circuit is
	 * already open, extend the backoff (via max) without compounding the exponent — so a
	 * single blip across CONCURRENCY posters doesn't rocket straight to the cap.
	 */
	private openCircuit(host: string, retryAfterMs?: number): void {
		const rec = this.record(host);
		const now = this.now();
		if (rec.circuitUntil <= now) rec.failures += 1; // a new failure round (circuit was closed)
		rec.circuitUntil = Math.max(rec.circuitUntil, now + this.circuitBackoff(rec.failures, retryAfterMs));
	}

	/** Host is overloaded/unreachable (503/429/502/504 or network error) — circuit-break. */
	recordUnavailable(host: string, retryAfterMs?: number): void {
		this.openCircuit(host, retryAfterMs);
	}

	/**
	 * A non-retriable error response (e.g. a 4xx bug or an auth failure). These are usually
	 * persistent, so escalate like an unavailable host rather than re-polling every minMs
	 * forever (a ~1 req/s spin against a broken endpoint). Still logged each round by the
	 * caller, so a real bug stays visible.
	 */
	recordError(host: string): void {
		this.openCircuit(host);
	}

	/** A result POST (or any request) succeeded — clear the circuit and wake a sleeper. */
	recordSuccess(host: string): void {
		const rec = this.record(host);
		rec.failures = 0;
		rec.circuitUntil = 0;
		// Cross-actor recovery: this is called by the result poster (RenderJob), not the
		// consumer loop. If clearing the circuit made a host eligible now, wake the consumer
		// so it re-polls immediately instead of waiting out a sleep sized for the old circuit.
		this.maybeNotify(rec);
	}

	isEligible(host: string): boolean {
		const rec = this.hosts.get(host);
		if (!rec) return false;
		return this.now() >= this.availableAt(rec);
	}

	/** Pick a random eligible host from those we've heard of, or null if none are ready. */
	pickEligible(): string | null {
		const now = this.now();
		const eligible: string[] = [];
		for (const [host, rec] of this.hosts) {
			if (now >= this.availableAt(rec)) eligible.push(host);
		}
		if (eligible.length === 0) return null;
		return eligible[Math.floor(this.random() * eligible.length)];
	}

	/**
	 * How long to sleep before the next poll re-evaluation: 0 if a host is eligible now,
	 * otherwise the time until the soonest host becomes eligible, clamped to `maxIdleMs`.
	 * When no hosts are known yet, wait the full `maxIdleMs`.
	 */
	nextWakeDelay(): number {
		const now = this.now();
		let soonest = Infinity;
		for (const rec of this.hosts.values()) {
			const at = this.availableAt(rec);
			if (at <= now) return 0;
			if (at < soonest) soonest = at;
		}
		if (soonest === Infinity) return this.maxIdleMs;
		return Math.min(this.maxIdleMs, soonest - now);
	}

	/** Wake sleepers only if the change actually made this host eligible now. */
	private maybeNotify(rec: HostRecord): void {
		if (this.waiters.size === 0) return;
		if (this.now() >= this.availableAt(rec)) this.notify();
	}

	/** Wake any sleepers early (a host became eligible). */
	private notify(): void {
		if (this.waiters.size === 0) return;
		for (const wake of [...this.waiters]) wake();
	}

	/**
	 * Sleep up to `ms`, resolving early if a host becomes eligible (`notify`) or `signal`
	 * aborts. Never rejects — the caller re-checks `signal.aborted` after it returns.
	 */
	wait(ms: number, signal?: AbortSignal): Promise<void> {
		return new Promise<void>((resolve) => {
			if (signal?.aborted) return resolve();
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.waiters.delete(finish);
				signal?.removeEventListener('abort', finish);
				resolve();
			};
			const timer = setTimeout(finish, ms);
			this.waiters.add(finish);
			signal?.addEventListener('abort', finish, { once: true });
		});
	}
}

/** Parse an HTTP `Retry-After` value (delta-seconds or an HTTP-date) into ms, or undefined. */
export const parseRetryAfter = (value?: string | string[]): number | undefined => {
	if (value == null) return undefined;
	const raw = Array.isArray(value) ? value[0] : value;
	if (!raw) return undefined;
	const secs = Number(raw);
	if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
	const date = Date.parse(raw);
	if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
	return undefined;
};

// Lazily-built singleton, configured from `settings.backoff` on first use (after
// applySettings has run at startup). Mirrors the getResourceCache() pattern.
let singleton: HostHealth | null = null;
export const getHostHealth = (): HostHealth => {
	if (!singleton) {
		singleton = new HostHealth({
			idleMs: settings.backoff.idleMs,
			minMs: settings.backoff.minMs,
			maxMs: settings.backoff.maxMs,
			pausedMs: settings.backoff.pausedMs,
			maxIdleMs: settings.backoff.maxIdleMs,
		});
	}
	return singleton;
};
