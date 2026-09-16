/**
 * Node-local run state for the detached admin sweeps, published where EVERY worker can read it.
 *
 * WHY THIS EXISTS. Harper loads a component per worker THREAD, so `let running`/`let lastRun` in a
 * sweep module is per-worker state describing a per-node activity. Every sweep here is started by
 * one worker and polled through an endpoint served by whichever worker takes the connection, so
 * module state makes both the guard and the result a coin flip with as many sides as there are
 * workers. Measured on a live cluster (2026-08-13, the orphan sweep's first real use): one node
 * answered `{"lastRun": null, "alreadyRunning": false}` while a sweep was in fact running on
 * another worker, and the completed run's summary was only ever visible in the log.
 *
 * Three consequences, in increasing order of cost:
 *
 *   1. The overlap guard does not guard. A second POST landing on a different worker reports
 *      `alreadyRunning: false` and starts a SECOND concurrent sweep on the same node — each one a
 *      full walk of the target registry (~1.2M rows on the cluster measured).
 *   2. The result is unreadable. An operator polling for the outcome can wait forever on a node
 *      that has already finished.
 *   3. THE CANCEL CAN MISS. `discoveredPurge`'s `{ action: 'stop' }` sets a flag in the worker
 *      that received it; the purge polls its own worker's flag. A stop landing anywhere else
 *      reports the purge as not running and does not stop it — on a paced bulk DELETE.
 *
 * THE SHAPE IS THE ONE `probeState.js` ALREADY USES, and for the same reason:
 * `coordination.SharedBuffer` is node-local (`replicate: false`), which is exactly the scope of
 * "what this node is doing". One row per sweep; any worker reads; the guard becomes a claim on the
 * row rather than a variable. (That module predates this one and stays as it is — its branch
 * structure is probe-specific. If it is ever touched again, it is the same mechanism.)
 *
 * WHAT IS DIFFERENT HERE: THE CLAIM IS ATOMIC, NOT ADVISORY. The probe tolerates two racing
 * workers starting one redundant pass. A destructive sweep does not: the issue that prompted this
 * asked for "a genuine cross-worker mutex, not an advisory flag, or two workers can still
 * interleave between check and set". So the read-decide-write is serialized by the store's own
 * cross-worker lock (`util/mutex.js`, the primitive Harper core uses for cross-thread exclusion).
 *
 * The lock is held for the CLAIM ONLY — a read, a compare and a put, microseconds — never for the
 * sweep, which runs for minutes to hours. A lock held for the duration would be exactly the
 * stranding hazard the heartbeat below exists to avoid, and would serialize the status endpoint
 * behind a running sweep.
 *
 * AND LIVENESS IS A HEARTBEAT, so a worker that dies mid-sweep cannot wedge the node forever. A
 * fixed staleness window measured from the START would have to be longer than the longest sweep
 * (wedging on a crash) or shorter (letting a healthy pass be stolen from itself); measured from
 * the last beat, neither. This is the probe's reasoning and it applies unchanged — a discovery
 * purge of a large prefix is hours.
 */

import { createStoreMutex } from './mutex.js';
import { epochMsOf } from './time.js';

const table = () => databases.coordination.SharedBuffer;

/** The store whose native lock serializes a claim. Same store the row lives in. */
const lockStore = () => table().primaryStore;

/**
 * How long without a heartbeat before a claim is considered abandoned.
 *
 * Generous on purpose. The cost of being wrong in one direction is a redundant sweep; in the other
 * it is a node that refuses to sweep until the process restarts. Every sweep here beats far more
 * often than this, and every one of them is safe to run twice.
 */
export const DEFAULT_STALE_MS = 120_000;

/**
 * Read one sweep's row, or null.
 *
 * Never throws: this backs status endpoints and run guards, and neither is worth a 500. A read
 * failure degrades to "no state", which callers render as unknown rather than as healthy.
 */
export const readRunState = async (key) => {
	try {
		return (await table().get(key)) ?? null;
	} catch (e) {
		globalThis.logger?.warn?.(`[prerender] could not read the ${key} run-state row: ${e?.message ?? String(e)}`);
		return null;
	}
};

/**
 * Is the row's claim live right now?
 *
 * `epochMsOf`, not `Number`: a timestamp can cross a serialization boundary as a number, a Date or
 * an ISO string, and `Number(null)` is 0 — finite, and therefore passing a naive check as "beat at
 * the epoch". Same trap `probeState.isPassRunning` documents.
 */
export const isRunning = (row, staleMs = DEFAULT_STALE_MS) => {
	if (!row?.running) return false;
	const beat = epochMsOf(row.heartbeatAt ?? row.startedAt);
	if (!Number.isFinite(beat)) return false;
	return Date.now() - beat < staleMs;
};

/**
 * Merge a patch into the row. One level deep, `undefined` ignored — to CLEAR a field, name it
 * explicitly (`lastRun: null`); omission means "leave alone". Never throws: publishing is
 * observability and must not be able to fail the sweep it describes.
 */
export const publishRunState = async (key, patch) => {
	try {
		const existing = (await table().get(key)) ?? {};
		const merged = { ...existing };
		for (const [field, value] of Object.entries(patch)) {
			if (value === undefined) continue;
			merged[field] = value;
		}
		await table().put(key, { ...merged, node: server.hostname, updatedAt: Date.now() });
		return true;
	} catch (e) {
		globalThis.logger?.warn?.(`[prerender] could not publish ${key} run state: ${e?.message ?? String(e)}`);
		return false;
	}
};

/**
 * Claim the run, under the store's cross-worker lock.
 *
 * Returns `{ claimed: true, row }` or `{ claimed: false, row }` where `row` is the state that
 * refused the claim, so a caller can report who holds it and since when.
 *
 * A FAILURE TO PUBLISH REFUSES THE CLAIM. The alternative — proceed on an unwritten claim — is the
 * defect this module exists to remove, one worker sweeping while every other worker reports idle.
 * Refusing is visible; the operator retries.
 */
export const claimRun = async (key, { staleMs = DEFAULT_STALE_MS, startedAt = Date.now(), meta = {} } = {}) => {
	const { withLock } = createStoreMutex(lockStore(), `run-state:${key}`);
	return withLock(async () => {
		const row = await readRunState(key);
		if (isRunning(row, staleMs)) return { claimed: false, row };
		const published = await publishRunState(key, {
			running: true,
			startedAt,
			heartbeatAt: startedAt,
			cancelRequested: false,
			progress: null,
			...meta,
		});
		if (!published) return { claimed: false, row, publishFailed: true };
		return { claimed: true, row: await readRunState(key) };
	})();
};

/** Touch the claim so it is not read as abandoned, optionally publishing live progress. */
export const heartbeatRun = (key, progress) =>
	publishRunState(key, { heartbeatAt: Date.now(), progress: progress ?? undefined });

/**
 * A heartbeat throttled to at most one write per `everyMs`, for wiring into a hot loop.
 *
 * The sweeps yield every few hundred rows, which on a 1.2M-row walk is thousands of yields — a
 * write on each would cost more than the sweep. The throttle is what lets the beat ride the
 * existing yield hook instead of needing a timer of its own, and a timer would keep beating after
 * a crashed pass, which is precisely the signal the staleness window reads.
 *
 * Fire-and-forget by design: a beat that loses a race with another write costs nothing, and making
 * the caller await it would put a store write in the sweep's inner loop.
 */
export const makeHeartbeat = (key, everyMs = DEFAULT_STALE_MS / 4) => {
	let last = 0;
	return (progress) => {
		const now = Date.now();
		if (now - last < everyMs) return;
		last = now;
		void heartbeatRun(key, progress);
	};
};

/** Release the claim and record the summary every worker will report from here on. */
export const finishRun = (key, lastRun) =>
	publishRunState(key, { running: false, heartbeatAt: Date.now(), progress: null, cancelRequested: false, lastRun });

/**
 * Ask a running sweep to stop. The flag lives on the ROW, so it reaches the sweep whichever worker
 * is running it and whichever worker was asked — which is the whole point.
 */
export const requestCancel = async (key, staleMs = DEFAULT_STALE_MS) => {
	const row = await readRunState(key);
	if (!isRunning(row, staleMs)) return { requested: false, row };
	await publishRunState(key, { cancelRequested: true });
	return { requested: true, row: await readRunState(key) };
};

/** Has a cancel been requested? Read from the row, so any worker's stop is seen by the runner. */
export const isCancelRequested = async (key) => Boolean((await readRunState(key))?.cancelRequested);

/**
 * A SYNCHRONOUS cancel check backed by the row, for a loop that cannot await one.
 *
 * The purge asks `isCanceled()` once per row, so the check has to answer without I/O: a store read
 * per row would cost more than the delete it guards, on a walk of over a million rows. This
 * returns a cached answer and refreshes it in the background at most every `everyMs`, so a stop
 * takes effect within about that long rather than on the very next row — which is what a
 * cooperative stop on a rate-paced sweep is worth.
 *
 * ONCE TRUE, ALWAYS TRUE. A cancel is not retracted, and latching means a read that fails (or a
 * row rewritten by the finish path) can never un-cancel a pass that is already winding down.
 */
export const makeCancelPoller = (key, everyMs = 2000) => {
	let canceled = false;
	let lastPoll = 0;
	let polling = false;
	return () => {
		const now = Date.now();
		if (!canceled && !polling && now - lastPoll >= everyMs) {
			lastPoll = now;
			polling = true;
			void isCancelRequested(key)
				.then((v) => {
					if (v) canceled = true;
				})
				.finally(() => {
					polling = false;
				});
		}
		return canceled;
	};
};
