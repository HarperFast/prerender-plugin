import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChangeActions } from '../src/util/changeActions.js';

/**
 * The change probe's action pipeline, with no Harper at all. What is pinned, and why each matters:
 *
 *   - THE BASELINE IS WRITTEN AFTER THE ACTION, and only if it succeeded. Written first, a failure or
 *     a restart would lose the change outright: the next probe would compare against the new
 *     signature and see nothing.
 *   - BACKPRESSURE, NOT REFUSAL. A full pipeline makes `submit` wait; nothing detected is dropped.
 *   - STOP IS PROMPT. Disabling the probe must not leave a drain running for hours — at most the
 *     actions already in flight finish.
 */

const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
	let resolve;
	const promise = new Promise((r) => (resolve = r));
	return { promise, resolve };
};
const item = (url) => ({ row: { url }, observed: `sig:${url}`, rowExists: true, fingerprint: 'fp' });

test('acts, then writes the baseline with the claim cleared — in that order', async () => {
	const events = [];
	const actions = createChangeActions({
		act: async (row) => events.push(['act', row.url]),
		write: async (url, observed, opts) => events.push(['write', url, observed, opts.clearClaim, opts.fingerprint]),
		concurrency: 1,
	});
	await actions.submit(item('a'));
	await actions.drain();
	assert.deepEqual(events, [
		['act', 'a'],
		['write', 'a', 'sig:a', true, 'fp'],
	]);
	assert.equal(actions.stats.triggered, 1);
});

test('a failed action writes no baseline, counts an error, and never rejects', async () => {
	const written = [];
	const errors = [];
	const actions = createChangeActions({
		act: async () => {
			throw new Error('write refused');
		},
		write: async (url) => written.push(url),
		onError: (e, it) => errors.push([e.message, it.row.url]),
	});
	await actions.submit(item('a'));
	await actions.drain();
	assert.deepEqual(written, []);
	assert.deepEqual(errors, [['write refused', 'a']]);
	assert.equal(actions.stats.errors, 1);
	assert.equal(actions.stats.triggered, 0);
});

test('a full pipeline makes submit WAIT for a slot, and every item is acted on', async () => {
	const gates = [];
	const actions = createChangeActions({
		act: async () => {
			const g = deferred();
			gates.push(g);
			await g.promise;
		},
		write: async () => {},
		concurrency: 2,
	});
	await actions.submit(item('a'));
	await actions.submit(item('b'));
	assert.equal(actions.inFlight, 2);
	let thirdStarted = false;
	const third = actions.submit(item('c')).then(() => (thirdStarted = true));
	await tick();
	assert.equal(thirdStarted, false, 'no slot free: the third waits');
	gates[0].resolve();
	await third;
	assert.equal(thirdStarted, true, 'a slot freed: the third starts');
	assert.equal(actions.stats.maxInFlight, 2);
	for (const g of gates) g.resolve();
	await tick();
	gates.at(-1).resolve();
	await actions.drain();
	assert.equal(actions.stats.triggered, 3, 'nothing dropped');
});

test('stop: a waiting submit starts nothing, in-flight actions finish, and later submits are refused', async () => {
	const acted = [];
	const gate = deferred();
	const actions = createChangeActions({
		act: async (row) => {
			acted.push(row.url);
			await gate.promise;
		},
		write: async () => {},
		concurrency: 1,
	});
	await actions.submit(item('a'));
	const waiting = actions.submit(item('b'));
	actions.stop();
	assert.equal(await waiting, false, 'the waiting change is not acted on (its baseline stays stale)');
	assert.equal(await actions.submit(item('c')), false);
	gate.resolve();
	await actions.drain();
	assert.deepEqual(acted, ['a'], 'only the action already in flight ran');
	assert.equal(actions.stats.triggered, 1);
});

test('drain resolves at once when idle, and after the last action otherwise', async () => {
	const actions = createChangeActions({ act: async () => {}, write: async () => {} });
	await actions.drain();
	const gate = deferred();
	const slow = createChangeActions({ act: () => gate.promise, write: async () => {} });
	await slow.submit(item('a'));
	let drained = false;
	const d = slow.drain().then(() => (drained = true));
	await tick();
	assert.equal(drained, false);
	gate.resolve();
	await d;
	assert.equal(drained, true);
});

test('lowestInFlight names the earliest URL still acting, and the time spent waiting is counted', async () => {
	const gates = new Map();
	let clock = 0;
	const actions = createChangeActions({
		act: (row) => new Promise((resolve) => gates.set(row.url, resolve)),
		write: async () => {},
		concurrency: 2,
		now: () => clock,
	});
	await actions.submit(item('https://e.x/b'));
	await actions.submit(item('https://e.x/a'));
	assert.equal(actions.lowestInFlight, 'https://e.x/a');
	const waiting = actions.submit(item('https://e.x/c'));
	clock = 250;
	gates.get('https://e.x/a')();
	await waiting;
	assert.equal(actions.stats.waits, 1);
	assert.equal(actions.stats.waitMs, 250, 'the pass was blocked on a full pipeline for 250ms');
	assert.equal(actions.lowestInFlight, 'https://e.x/b');
	gates.get('https://e.x/b')();
	await tick();
	gates.get('https://e.x/c')();
	await actions.drain();
	assert.equal(actions.lowestInFlight, null);
});

test('A4: a failed action is retried ONCE after the walk; a success counts recovered and writes the baseline', async () => {
	// The walk cursor has moved past a failed URL, so without the retry its page — known wrong — serves
	// until the next pass reaches it again: in anchored mode, tomorrow.
	const attempts = new Map();
	const written = [];
	const retries = [];
	const actions = createChangeActions({
		act: async (row) => {
			const n = (attempts.get(row.url) ?? 0) + 1;
			attempts.set(row.url, n);
			// `a` fails once (transient), `b` fails every time.
			if (row.url === 'b' || n === 1) throw new Error('write refused');
		},
		write: async (url) => written.push(url),
		onError: (e, it, { retry }) => retries.push([it.row.url, retry]),
		concurrency: 2,
	});
	await actions.submit(item('a'));
	await actions.submit(item('b'));
	await actions.drain();
	assert.deepEqual(written, [], 'nothing acted on the first attempt');
	await actions.retryFailed();
	assert.deepEqual(written, ['a'], 'the transient failure recovered and its baseline was written');
	assert.equal(attempts.get('a'), 2);
	assert.equal(attempts.get('b'), 2, 'retried once, not forever');
	assert.equal(actions.stats.errors, 2, 'errors counts first attempts');
	assert.equal(actions.stats.retried, 2);
	assert.equal(actions.stats.recovered, 1);
	assert.equal(actions.stats.triggered, 1);
	assert.deepEqual(retries, [
		['a', false],
		['b', false],
		['b', true],
	]);
	await actions.retryFailed();
	assert.equal(attempts.get('b'), 2, 'a retry that fails is not queued again');
});

test('A4: the retry list is BOUNDED — failures past it are counted and left to the next probe', async () => {
	const actions = createChangeActions({
		act: async () => {
			throw new Error('refused');
		},
		write: async () => {},
		retryLimit: 2,
	});
	for (const url of ['a', 'b', 'c', 'd']) await actions.submit(item(url));
	await actions.drain();
	await actions.retryFailed();
	assert.equal(actions.stats.errors, 4);
	assert.equal(actions.stats.retried, 2);
	assert.equal(actions.stats.retrySkipped, 2);
});

test('A4: retries run after stop() — stopping ends the walk’s submissions, not work it already decided on', async () => {
	let calls = 0;
	const actions = createChangeActions({
		act: async () => {
			if (calls++ === 0) throw new Error('refused');
		},
		write: async () => {},
	});
	await actions.submit(item('a'));
	await actions.drain();
	actions.stop();
	await actions.retryFailed();
	assert.equal(actions.stats.recovered, 1);
});

test('round 2 item 9: a retry whose detection is no longer current is SKIPPED, not acted on stale inputs', async () => {
	let attempts = 0;
	const written = [];
	const actions = createChangeActions({
		act: async () => {
			if (attempts++ === 0) throw new Error('refused');
		},
		write: async (url) => written.push(url),
		stillDue: async (it) => it.row.url !== 'a',
	});
	await actions.submit(item('a'));
	await actions.drain();
	await actions.retryFailed();
	assert.equal(attempts, 1, 'the retry did not act');
	assert.deepEqual(written, [], 'nor write the old observation over the newer baseline');
	assert.equal(actions.stats.retryStale, 1);
	assert.equal(actions.stats.recovered, 0);
});
