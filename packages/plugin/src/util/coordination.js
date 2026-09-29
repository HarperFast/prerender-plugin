/**
 * Cross-worker coordination primitives backed by the node-local `SharedBuffer` table
 * (in the non-replicated `coordination` database).
 *
 *   - `getSab(key, size)` — a named buffer shared across workers via
 *     `getUserSharedBuffer`, for lock-free shared counters/flags (Atomics
 *     load/store/compareExchange; note it is a plain ArrayBuffer, so no wait/waitAsync). Held for
 *     the life of the process unless released (`releaseSabs`) — see the note at `getSab`.
 *   - `getMutex(key)`     — an async, cross-worker mutex built on the store's native
 *     `tryLock`/`unlock`, the same primitive Harper core uses for cross-thread mutual
 *     exclusion (see `resources/transactionBroadcast.ts`).
 */

import { createStoreMutex } from './mutex.js';

const MUTEX_KEY_PREFIX = 'mutex/';

const sharedBufferStore = () => databases.coordination.SharedBuffer.primaryStore;

// A SHARED BUFFER LIVES ONLY WHILE SOMETHING HOLDS IT. On the RocksDB store (Harper 5.2) the memory
// behind `getUserSharedBuffer` is freed once every ArrayBuffer referencing it has been garbage
// collected, and the next call for the key creates a NEW buffer from the zeroed default — so a caller
// that re-fetches a buffer by name on every use and keeps no reference loses what it wrote whenever a
// GC runs between two uses. Measured in Docker on Harper 5.2.14: a worker merged six registers into a
// shared sketch and, 11 ms later, the same key read back empty. The visit ring and the crawl sketches
// re-fetched this way (the other callers hold their buffer at module scope and never saw it).
//
// So this module holds every buffer it hands out, for the life of the process. A caller whose keys age
// out (a ring slot, a UTC day) releases them with `releaseSabs`; the memory is freed once no worker
// holds the key.
const held = new Map(); // key -> ArrayBuffer

export const getSab = (key, size) => {
	let buffer = held.get(key);
	if (!buffer) {
		buffer = sharedBufferStore().getUserSharedBuffer(key, new ArrayBuffer(size));
		held.set(key, buffer);
	}
	return buffer;
};

/** Stop holding every buffer whose key `matches` — for keys that will never be used again. */
export const releaseSabs = (matches) => {
	for (const key of held.keys()) if (matches(key)) held.delete(key);
};

/** Test seam: the keys held right now. */
export const heldSabKeys = () => [...held.keys()];

/** Test seam: forget every held buffer, as a restart would. */
export const resetHeldSabs = () => held.clear();

export const getMutex = (key) => {
	return createStoreMutex(sharedBufferStore(), `${MUTEX_KEY_PREFIX}${key}`);
};
