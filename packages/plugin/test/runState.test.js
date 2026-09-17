import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * `util/runState.js` — the node-shared run state the detached sweeps claim, beat and publish.
 *
 * WHAT THESE PIN IS CROSS-WORKER BEHAVIOUR, which is the whole point: Harper loads a component per
 * worker thread, so the module state this replaced described one worker while every sweep is a
 * per-node activity polled through an endpoint served by whichever worker takes the connection.
 * The fakes below therefore model ONE ROW SHARED BY MANY READERS — not one module per test.
 *
 * The case that matters most is the cancel. `discoveredPurge`'s stop used to set a module flag in
 * the worker that received the POST while the pass polled its own worker's flag, so on a 16-worker
 * node a stop had roughly a 1-in-16 chance of reaching a running bulk DELETE and otherwise
 * reported success without stopping anything.
 */

const rows = new Map();
let locked = new Set();
let waiters = new Map();
let putFails = false;

const store = {
	// Models Harper's contract: acquire and return true, or return false and queue the callback to
	// be invoked when the lock is released TO THIS CALLER (at which point it holds the lock).
	tryLock(key, onGranted) {
		if (!locked.has(key)) {
			locked.add(key);
			return true;
		}
		waiters.set(key, [...(waiters.get(key) ?? []), onGranted]);
		return false;
	},
	unlock(key) {
		const queue = waiters.get(key) ?? [];
		const next = queue.shift();
		waiters.set(key, queue);
		if (next) return void next();
		locked.delete(key);
	},
};

let runState;

before(async () => {
	globalThis.server = { hostname: 'node-a', workerIndex: 0, nodes: [], config: { http: {} } };
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {}, notify() {} };
	globalThis.databases = {
		coordination: {
			SharedBuffer: {
				primaryStore: store,
				async get(key) {
					return rows.get(key) ?? null;
				},
				async put(key, value) {
					if (putFails) throw new Error('store is unavailable');
					rows.set(key, value);
				},
			},
		},
	};
	runState = await import('../src/util/runState.js');
});

beforeEach(() => {
	rows.clear();
	locked = new Set();
	waiters = new Map();
	putFails = false;
});

test('a claim is granted once, and the second worker is told who holds it', async () => {
	const first = await runState.claimRun('sweep');
	assert.equal(first.claimed, true);

	// A DIFFERENT worker asking — same row, because the row is the node's, not the worker's.
	const second = await runState.claimRun('sweep');
	assert.equal(second.claimed, false);
	assert.equal(second.row.running, true);
	assert.equal(typeof second.row.startedAt, 'number', 'the refusal says since when');
});

test('a finished run releases the claim and leaves the summary every worker reports', async () => {
	await runState.claimRun('sweep');
	await runState.finishRun('sweep', { deleted: 7, error: null });

	const row = await runState.readRunState('sweep');
	assert.equal(runState.isRunning(row), false);
	assert.deepEqual(row.lastRun, { deleted: 7, error: null });
	// And the node can start another.
	assert.equal((await runState.claimRun('sweep')).claimed, true);
});

test('a claim whose heartbeat has stopped is taken over — one crash cannot wedge the node', async () => {
	await runState.claimRun('sweep', { startedAt: Date.now() - 600_000 });
	const stale = await runState.readRunState('sweep');
	assert.equal(stale.running, true, 'the row still says running — the worker died without finishing');

	assert.equal(runState.isRunning(stale, 120_000), false, 'but the claim is stale');
	assert.equal((await runState.claimRun('sweep')).claimed, true, 'so it can be taken over');
});

test('a beating claim is NOT taken over, however long the pass runs', async () => {
	await runState.claimRun('sweep', { startedAt: Date.now() - 6 * 3600_000 });
	await runState.heartbeatRun('sweep');

	assert.equal((await runState.claimRun('sweep')).claimed, false, 'six hours in and still alive');
});

test('a claim that cannot be published is REFUSED, never assumed', async () => {
	// Proceeding on an unwritten claim is the original defect: one worker sweeping while every
	// other worker reports idle. Refusing is visible, and the operator retries.
	putFails = true;
	const { claimed, publishFailed } = await runState.claimRun('sweep');
	assert.equal(claimed, false);
	assert.equal(publishFailed, true);
});

test('the claim is serialized by the lock, so two simultaneous starts cannot both win', async () => {
	// Both enter before either writes — the interleave the issue asked for a real mutex to close.
	const [a, b] = await Promise.all([runState.claimRun('sweep'), runState.claimRun('sweep')]);
	assert.equal([a.claimed, b.claimed].filter(Boolean).length, 1, 'exactly one claim is granted');
});

test('the lock is released even when the claim is refused, or the node wedges on the second try', async () => {
	await runState.claimRun('sweep');
	await runState.claimRun('sweep'); // refused
	assert.equal(locked.has('run-state:sweep'), false, 'not still held by the refused attempt');
});

test('a cancel requested on ANY worker is seen by the worker running the pass', async () => {
	await runState.claimRun('purge');
	// The stop lands on a different worker than the pass. Same row, so it arrives.
	const { requested } = await runState.requestCancel('purge');
	assert.equal(requested, true);
	assert.equal(await runState.isCancelRequested('purge'), true);
});

test('a cancel for a pass that is not running is reported as not requested', async () => {
	const { requested } = await runState.requestCancel('purge');
	assert.equal(requested, false, 'nothing to stop — and no flag left behind to poison the next pass');
	assert.equal(await runState.isCancelRequested('purge'), false);
});

test('a new claim clears a previous cancel, so a stop cannot carry into the next pass', async () => {
	await runState.claimRun('purge');
	await runState.requestCancel('purge');
	await runState.finishRun('purge', { canceled: true });

	await runState.claimRun('purge');
	assert.equal(await runState.isCancelRequested('purge'), false);
});

test('the sync cancel poller answers without I/O and latches once set', async () => {
	await runState.claimRun('purge');
	const poll = runState.makeCancelPoller('purge', 0);

	assert.equal(poll(), false, 'the first call answers immediately from the cache, never awaits');
	await runState.requestCancel('purge');
	poll(); // kicks the refresh
	await new Promise((r) => setImmediate(r));
	assert.equal(poll(), true);

	// Latched: the finish path rewrites the row with cancelRequested false, and a pass already
	// winding down must not be un-cancelled by it.
	await runState.finishRun('purge', {});
	poll();
	await new Promise((r) => setImmediate(r));
	assert.equal(poll(), true, 'once cancelled, always cancelled for this pass');
});

test('the throttled heartbeat writes at most once per window', async () => {
	await runState.claimRun('sweep');
	const beat = runState.makeHeartbeat('sweep', 10_000);

	beat();
	await new Promise((r) => setImmediate(r));
	const first = (await runState.readRunState('sweep')).heartbeatAt;

	for (let i = 0; i < 50; i++) beat();
	await new Promise((r) => setImmediate(r));
	assert.equal((await runState.readRunState('sweep')).heartbeatAt, first, '50 calls, one write');
});

test('a row with no usable timestamp reads as not running, not as beating at the epoch', async () => {
	// `Number(null)` is 0 — finite, and therefore passing a naive check as "beat in 1970".
	assert.equal(runState.isRunning({ running: true, heartbeatAt: null, startedAt: null }), false);
	assert.equal(runState.isRunning({ running: true, heartbeatAt: 'not a date' }), false);
});

// ---- review follow-ups: clock drift and floating rejections ----

test('a backward clock step does not suppress the heartbeat', async () => {
	// An NTP correction makes `now - last` negative. A bare `elapsed < everyMs` would then skip
	// every beat until the wall clock caught back up to `last` — and on a claim whose liveness IS
	// the heartbeat, a silent gap reads as an abandoned run and hands the sweep to another worker.
	const beats = [];
	let clock = 1_000_000;
	const realNow = Date.now;
	Date.now = () => clock;
	try {
		const beat = runState.makeHeartbeat('sweep-drift', 1000);
		beat('first'); // last = 1_000_000
		clock = 1_000_500;
		beat('too soon'); // inside the interval: suppressed
		clock = 900_000; // the clock steps BACKWARD
		beat('after drift');
		await new Promise((resolve) => setImmediate(resolve));
		const row = await runState.readRunState('sweep-drift');
		beats.push(row?.progress);
	} finally {
		Date.now = realNow;
	}
	assert.equal(beats[0], 'after drift', 'the beat after a backward step must go through');
});

test('a backward clock step does not suppress the cancel poll', async () => {
	// This poller is how a running bulk DELETE learns it was told to stop. With a bare
	// `elapsed >= everyMs`, a backward clock step makes elapsed negative and suppresses polling for
	// as long as the drift lasts — leaving `{ action: 'stop' }` unobserved on a destructive path.
	await runState.claimRun('purge-drift');
	let clock = 1_000_000;
	const realNow = Date.now;
	Date.now = () => clock;
	try {
		const poll = runState.makeCancelPoller('purge-drift', 1000);
		assert.equal(poll(), false, 'nothing cancelled yet');
		await new Promise((r) => setImmediate(r));

		Date.now = realNow;
		await runState.requestCancel('purge-drift');
		Date.now = () => clock;

		clock = 900_000; // the clock steps BACKWARD, well inside the 1000ms interval
		poll(); // must still kick a refresh
		await new Promise((r) => setImmediate(r));
		assert.equal(poll(), true, 'the cancel must still be observed after a backward clock step');
	} finally {
		Date.now = realNow;
	}
});

test('a failing cancel poll is swallowed, not left as an unhandled rejection', async () => {
	// The promise is deliberately floating so the caller's hot loop never awaits it, which means an
	// unhandled rejection would reach Node's default handler and take the worker down.
	const errors = [];
	const priorLogger = globalThis.logger;
	globalThis.logger = { ...priorLogger, error: (m) => errors.push(String(m)) };
	const rejections = [];
	const onRejection = (e) => rejections.push(e);
	process.on('unhandledRejection', onRejection);
	try {
		const broken = runState.makeCancelPoller('missing-store-run', 0);
		globalThis.databases.coordination.SharedBuffer.get = async () => {
			throw new Error('store unavailable');
		};
		broken();
		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.deepEqual(rejections, [], 'no unhandled rejection may escape the poller');
		assert.equal(broken(), false, 'a poller that cannot read reports "not cancelled"');
	} finally {
		process.off('unhandledRejection', onRejection);
		globalThis.logger = priorLogger;
	}
});
