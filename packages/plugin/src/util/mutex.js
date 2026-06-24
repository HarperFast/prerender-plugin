/**
 * Async, cross-worker mutex built on a Harper store's native lock primitives
 * (`tryLock`/`unlock`) — the same mechanism Harper core uses for cross-thread
 * mutual exclusion (see `resources/transactionBroadcast.ts`).
 *
 * `store.tryLock(key, onGranted)`:
 *   - if the lock is free, acquires it and returns `true` (the callback is never called);
 *   - otherwise returns `false` and queues `onGranted`, which the store invokes once
 *     the lock is released to this caller.
 * `store.unlock(key)` releases the lock and grants it to the next queued waiter.
 *
 * This is preferred over an Atomics mutex over `getUserSharedBuffer`: that buffer is a
 * plain `ArrayBuffer` (not a `SharedArrayBuffer`), so `Atomics.wait`/`waitAsync` throw
 * on it — whereas the store's native lock is cross-worker, event-driven, and needs no
 * shared buffer at all.
 *
 * `store` is injected (rather than reaching for Harper globals) so the wrapper is
 * unit-testable against a fake store that models the tryLock/unlock contract.
 *
 * @param store   Object exposing `tryLock(key, onGranted) => boolean` and `unlock(key)`.
 * @param lockKey The lock key.
 */
export const createStoreMutex = (store, lockKey) => {
	const lock = () =>
		new Promise((resolve) => {
			// Acquired synchronously -> resolve now (the callback won't fire). Otherwise
			// the queued callback resolves us once the lock is granted.
			if (store.tryLock(lockKey, resolve)) resolve();
		});

	const unlock = () => store.unlock(lockKey);

	const withLock = (fn) => {
		return async (...args) => {
			await lock();
			try {
				return await fn(...args);
			} finally {
				unlock();
			}
		};
	};

	return { lock, unlock, withLock };
};
