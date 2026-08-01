import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTimeoutError, TimeoutError, withTimeout } from '../src/util/timeout.js';

const never = () => new Promise(() => {});
const after = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

test('resolves through when the operation finishes first', async () => {
	assert.equal(await withTimeout(Promise.resolve('done'), 1000, 'op'), 'done');
});

test('rejects with a TimeoutError once the deadline passes', async () => {
	await assert.rejects(withTimeout(never(), 20, 'RenderSchedule.put(k)'), (e) => {
		assert.ok(isTimeoutError(e), 'is a TimeoutError');
		assert.match(e.message, /RenderSchedule\.put\(k\) timed out after 20ms/);
		assert.equal(e.label, 'RenderSchedule.put(k)');
		assert.equal(e.timeoutMs, 20);
		return true;
	});
});

test("the operation's own rejection passes through unchanged and is NOT a timeout", async () => {
	// The caller distinguishes these: a real error propagates, a timeout is counted and degraded.
	const boom = new Error('write rejected');
	await assert.rejects(withTimeout(Promise.reject(boom), 1000, 'op'), (e) => {
		assert.equal(e, boom);
		assert.equal(isTimeoutError(e), false);
		return true;
	});
});

test('a non-positive or non-finite deadline disables the timeout', async () => {
	// Lets a deployment opt out with 0 without every call site growing a conditional.
	for (const ms of [0, -1, Number.NaN, undefined, null]) {
		assert.equal(await withTimeout(Promise.resolve('through'), ms, 'op'), 'through');
	}
});

test('a disabled deadline really does wait rather than resolving early', async () => {
	assert.equal(await withTimeout(after(15, 'slow'), 0, 'op'), 'slow');
});

test('a rejection arriving AFTER the deadline does not surface as an unhandled rejection', async () => {
	// This is the dangerous shape: the race is already lost, so nothing is awaiting the original
	// promise. If `Promise.race` had not subscribed to it, a late rejection would crash the worker.
	const unhandled = [];
	const onUnhandled = (e) => unhandled.push(e);
	process.on('unhandledRejection', onUnhandled);

	try {
		const late = new Promise((_, reject) => setTimeout(() => reject(new Error('late failure')), 30));
		await assert.rejects(withTimeout(late, 5, 'op'), isTimeoutError);
		// Well past the late rejection, plus a macrotask turn for the handler to have fired.
		await after(60);
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(unhandled, []);
	} finally {
		process.off('unhandledRejection', onUnhandled);
	}
});

test('the timer is cleared on success, so a fast call leaves nothing pending', async () => {
	// An uncleared deadline holds the event loop for its full duration after the work is done —
	// at batch scale that is tens of thousands of live timers.
	const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
	await withTimeout(Promise.resolve('fast'), 60_000, 'op');
	const settled = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
	assert.equal(settled, before, 'no timer left behind');
});

test('a TimeoutError is an Error and names itself', () => {
	const e = new TimeoutError('nope', { label: 'x', ms: 1 });
	assert.ok(e instanceof Error);
	assert.equal(e.name, 'TimeoutError');
	assert.equal(isTimeoutError(e), true);
	assert.equal(isTimeoutError(new Error('nope')), false);
});

test('a non-promise value is accepted and returned', async () => {
	assert.equal(await withTimeout('plain', 1000, 'op'), 'plain');
});
