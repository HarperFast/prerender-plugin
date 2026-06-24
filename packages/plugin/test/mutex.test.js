import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStoreMutex } from '../src/util/mutex.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

// Fake store modeling the documented native lock contract:
//   tryLock(key, onGranted): if free -> acquire, return true (onGranted NEVER called);
//     if held -> queue onGranted, return false.
//   unlock(key): grant to the next queued waiter (its onGranted fires and it now holds
//     the lock); if none waiting, mark the key free.
const makeFakeStore = () => {
	const locks = new Map(); // key -> { held: boolean, queue: Array<fn> }
	const stateFor = (key) => {
		let state = locks.get(key);
		if (!state) {
			state = { held: false, queue: [] };
			locks.set(key, state);
		}
		return state;
	};
	return {
		calls: { tryLock: 0, unlock: 0 },
		tryLock(key, onGranted) {
			this.calls.tryLock++;
			const state = stateFor(key);
			if (!state.held) {
				state.held = true;
				return true;
			}
			state.queue.push(onGranted);
			return false;
		},
		unlock(key) {
			this.calls.unlock++;
			const state = stateFor(key);
			if (!state.held) return false;
			if (state.queue.length > 0)
				state.queue.shift()(); // grant to next; stays held
			else state.held = false;
			return true;
		},
		isHeld(key) {
			return stateFor(key).held;
		},
	};
};

test('acquires immediately when free and releases', async () => {
	const store = makeFakeStore();
	const mutex = createStoreMutex(store, 'k');

	await mutex.lock();
	assert.equal(store.isHeld('k'), true);
	assert.equal(store.calls.tryLock, 1);

	mutex.unlock();
	assert.equal(store.isHeld('k'), false);
});

test('a contended acquire waits until the holder releases (granted via callback)', async () => {
	const store = makeFakeStore();
	const mutex = createStoreMutex(store, 'k');

	await mutex.lock(); // holds

	let secondAcquired = false;
	const second = mutex.lock().then(() => {
		secondAcquired = true;
	});

	await tick();
	assert.equal(secondAcquired, false); // queued, not granted yet

	mutex.unlock(); // grants the lock to the queued waiter
	await second;
	assert.equal(secondAcquired, true);
	assert.equal(store.isHeld('k'), true); // still held — now by the second acquirer
	mutex.unlock();
});

test('withLock serializes overlapping critical sections', async () => {
	const store = makeFakeStore();
	const mutex = createStoreMutex(store, 'k');
	const events = [];

	const run = mutex.withLock(async (id) => {
		events.push(`enter:${id}`);
		await tick();
		events.push(`exit:${id}`);
	});

	await Promise.all([run('a'), run('b')]);

	// b must not enter until a has exited (and released the lock).
	assert.deepEqual(events, ['enter:a', 'exit:a', 'enter:b', 'exit:b']);
	assert.equal(store.isHeld('k'), false);
});

test('namespaces the lock key under the mutex prefix is left to the caller', async () => {
	// createStoreMutex uses the key verbatim; getMutex (coordination.js) adds the prefix.
	const store = makeFakeStore();
	const mutex = createStoreMutex(store, 'mutex/render_queue');
	await mutex.lock();
	assert.equal(store.isHeld('mutex/render_queue'), true);
	mutex.unlock();
});
