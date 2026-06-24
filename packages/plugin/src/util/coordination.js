/**
 * Cross-worker coordination primitives backed by the node-local `SharedBuffer` table
 * (in the non-replicated `coordination` database).
 *
 *   - `getSab(key, size)` — a named buffer shared across workers via
 *     `getUserSharedBuffer`, for lock-free shared counters/flags (Atomics
 *     load/store/compareExchange; note it is a plain ArrayBuffer, so no wait/waitAsync).
 *   - `getMutex(key)`     — an async, cross-worker mutex built on the store's native
 *     `tryLock`/`unlock`, the same primitive Harper core uses for cross-thread mutual
 *     exclusion (see `resources/transactionBroadcast.ts`).
 */

import { createStoreMutex } from './mutex.js';

const MUTEX_KEY_PREFIX = 'mutex/';

const sharedBufferStore = () => databases.coordination.SharedBuffer.primaryStore;

export const getSab = (key, size) => {
	return sharedBufferStore().getUserSharedBuffer(key, new ArrayBuffer(size));
};

export const getMutex = (key) => {
	return createStoreMutex(sharedBufferStore(), `${MUTEX_KEY_PREFIX}${key}`);
};
