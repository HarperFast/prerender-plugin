/**
 * The change probe's node-local state, published where every worker can read it.
 *
 * WHY THIS EXISTS. The probe scheduler arms on worker 0 only (`startChangeProbeScheduler`
 * returns early elsewhere), but `/prerender_admin/change-probe` is served by whichever worker
 * takes the connection. With the state in module variables that made the endpoint a coin flip
 * with 16 sides: measured on a live 16-worker node, worker 0 answered 3 of 60 requests, and the
 * other 95% reported `armedInterval: null`, `running: false`, `lastRun: null` — which is not
 * "unknown", it is INDISTINGUISHABLE FROM THE PROBE BEING SWITCHED OFF. Continuous mode made
 * that worse, because its whole accountability story is a status the operator can read.
 *
 * The second failure was quieter and more expensive. `POST /prerender_admin/change-probe`
 * guarded against a concurrent pass with `isProbeSweepRunning()` — also module state, also on
 * the answering worker, therefore ~always false. So the console's "Run sweep" button started a
 * full paced sweep on a random worker while worker 0's scheduled sweep was still running, and
 * the origin took `ratePerSecond` twice over — the one number that was negotiated with whoever
 * runs it. The guard could not fire; it was reading a variable no pass had ever written.
 *
 * THE FIX IS THE ONE THE BACKLOG SNAPSHOTTER ALREADY USES, and its module header states the
 * rationale in the same words: `coordination.SharedBuffer` is node-local (`replicate: false`),
 * which is exactly the scope of "what this node's probe is doing". Worker 0 publishes; any
 * worker reads; the run guard becomes a claim on the row rather than a variable.
 *
 * THE CLAIM IS ADVISORY, NOT A LOCK — same shape as `claimRefreshRun` and the backlog scan. Two
 * racing workers at worst start one redundant pass; a crashed worker can never wedge the probe
 * forever. What differs from those two is duration: a backlog scan is seconds and a sitemap walk
 * is minutes, but a sweep is HOURS, so a fixed staleness window would either wedge on a crash
 * (too long) or let a healthy pass be stolen from itself (too short). Hence the heartbeat: a
 * running pass touches `updatedAt` as it goes, and staleness is measured against that rather
 * than against when the pass began.
 */

import { epochMsOf } from './time.js';

const ROW_KEY = 'change_probe';

const table = () => databases.coordination.SharedBuffer;

/**
 * Read the row, or null.
 *
 * Never throws: this backs a status endpoint and a run guard, and neither is worth a 500. A read
 * failure degrades to "no state", which the callers render as unknown rather than as healthy.
 */
export const readProbeState = async () => {
	try {
		return (await table().get(ROW_KEY)) ?? null;
	} catch (e) {
		globalThis.logger?.warn?.(`[prerender] could not read the change-probe state row: ${e?.message ?? String(e)}`);
		return null;
	}
};

/**
 * Merge `patch` into the row, ONE LEVEL DEEP.
 *
 * The depth is not a nicety, it is the difference between this module working and quietly
 * recreating the bug it exists to fix. Every writer patches a single branch (`sweep`, `canary`,
 * `scheduler`) with a partial object, so a shallow spread REPLACES that branch: the heartbeat
 * publishes `{ sweep: { running, startedAt, heartbeatAt, progress } }` with no `lastRun`, and a
 * shallow merge therefore deletes `lastRun` 30 seconds into a pass and leaves it deleted for the
 * hours the pass runs. An operator checking on a live sweep would read exactly the "nothing has
 * ever run here" that this module was written to eliminate.
 *
 * One level is enough because the branches are one level deep, and it keeps the rule easy to
 * state: to CLEAR a field, name it explicitly (`lastRun: null`, `progress: null`) rather than
 * omitting it. Omission means "leave alone".
 *
 * READ-MODIFY-WRITE, and the race is deliberately tolerated: the writers are the scheduler
 * (arming) and whichever worker holds the pass (progress), so the only interleaving that loses
 * anything is an arm landing between a pass's read and write — which the next heartbeat or the
 * next config apply restores. A stricter store would cost a lock on the path a paced pass takes
 * every few seconds, to protect a field that is re-published continuously.
 *
 * Never throws. Publishing is observability, and observability must not be able to fail a probe
 * pass — the pass is the thing that keeps prices correct.
 */
export const publishProbeState = async (patch) => {
	try {
		const existing = (await table().get(ROW_KEY)) ?? {};
		const merged = { ...existing };
		for (const [key, value] of Object.entries(patch)) {
			const isBranch = value && typeof value === 'object' && !Array.isArray(value);
			merged[key] = isBranch ? { ...merged[key], ...value } : value;
		}
		await table().put(ROW_KEY, { ...merged, node: server.hostname, updatedAt: Date.now() });
		return true;
	} catch (e) {
		globalThis.logger?.warn?.(`[prerender] could not publish change-probe state: ${e?.message ?? String(e)}`);
		return false;
	}
};

/**
 * Is a pass of `kind` ('sweep' | 'canary') live on this node right now?
 *
 * `staleMs` is measured from the last HEARTBEAT, not from the start — see the module header. A
 * row whose heartbeat has stopped is a dead worker, and refusing to take it over would mean one
 * crash disables the probe until the next process restart.
 */
export const isPassRunning = (row, kind, staleMs) => {
	const pass = row?.[kind];
	if (!pass?.running) return false;
	// `epochMsOf`, not `Number`. A row can carry a timestamp as a number, a Date or an ISO string
	// depending on how it crossed a serialization boundary, and `Number(null)` is 0 rather than
	// NaN — so a `running` row with no usable timestamp would read as "beat at the epoch", which
	// is finite and therefore passes a naive check. Here that happened to land on the safe side
	// (stale -> taken over), but relying on which side an accident falls is how the next edit
	// breaks it.
	const beat = epochMsOf(pass.heartbeatAt ?? pass.startedAt);
	if (!Number.isFinite(beat)) return false;
	return Date.now() - beat < staleMs;
};
