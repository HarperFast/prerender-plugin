/**
 * THE READY SET — the node's answer to "which page next", held in shared memory rather than derived
 * from an index.
 *
 * ── WHY THIS EXISTS AT ALL ─────────────────────────────────────────────────────────────────────
 *
 * `claim` reads `nextRenderTime >= floor` and takes the first rows it finds, so the queue serves
 * whatever is oldest-due. That is the wrong order under scarcity (see `util/renderPriority.js` for
 * the two production measurements), and the reason it could not simply be re-sorted is structural:
 * the claim window is ANCHORED AT THE OLDEST DUE TIME. Under a deep backlog every row in it is
 * ancient, so a homepage two of its own cadences late is nowhere near the window and no amount of
 * re-ranking finds a row that was never read. Widening the window does not help — a wider window
 * anchored in the same place is more ancient rows.
 *
 * The fix is to stop deciding from a window. A background sweep scores the WHOLE due set and keeps
 * the best few thousand here; `claim` then pops from this in priority order and touches no index at
 * all. That is affordable because of one measured fact (#119): a projected one-sided read costs
 * ~2.4 us/row, flat from 200 to 20,000 rows, and yielding every 200 rows is free — so scoring
 * 200,000 rows costs ~480 ms, and even a 500k-row overdue set is ~1.2 s. Writes, by contrast, are
 * 76-89 us/row, i.e. 32x a read. Reading liberally and writing not at all is the cheap direction, and
 * this structure adds ZERO writes.
 *
 * ── IT IS A CACHE IN FRONT OF THE OLD PATH, NOT A REPLACEMENT ─────────────────────────────────
 *
 * The single most important property for shipping this safely: when the set is cold, empty, or
 * exhausted, `claim` falls back to the floored scan it has always used. So the failure mode of
 * everything here is TODAY'S BEHAVIOUR — not a stalled queue. A sweep that never runs, a buffer sized
 * to zero, a worker that never publishes: all of them degrade to the current ordering rather than to
 * no ordering.
 *
 * That also means nothing here is a correctness invariant. An entry naming a row that has since been
 * rescheduled or deleted costs at most one redundant render (the lease CAS refuses a duplicate, and
 * `processJobResult` already drops a result whose target is gone). Compare that with the claim
 * floor, where a row filed below it is never claimed again — silently, terminally. This structure
 * cannot lose a page, because the next sweep re-reads the table.
 *
 * ── WHY A SHARED BUFFER, AND WHY DOUBLE-BUFFERED ──────────────────────────────────────────────
 *
 * Claims arrive on whichever worker the consumer's poll landed on, so a per-worker set would mean N
 * workers each sweeping the corpus — N times the cost for the same answer. One worker sweeps and
 * publishes here; every worker reads.
 *
 * The set is REBUILT WHOLE on every sweep, never mutated in place, which is what makes the layout
 * trivial: two slots, write the inactive one, flip an atomic. No fragmentation, no compaction, no
 * partially-visible set — a reader is always looking at one complete generation. Variable-length
 * cache keys would otherwise force an allocator in shared memory, which is exactly the kind of thing
 * that has taken this node down twice.
 *
 * ── AND WHY THE CURSOR IS A BARE ATOMIC ────────────────────────────────────────────────────────
 *
 * Entries are written BEST FIRST, so consumption order is already priority order and a consumer needs
 * to compare nothing. Claiming is `Atomics.add(cursor, 1)`: no lock, no scan, no coordination, and two
 * workers can never be handed the same index. Popping past the end simply reports exhaustion, which
 * is the signal to fall back.
 *
 * NO DEPENDENCIES beyond the encoder, deliberately — same discipline as `util/renderLease.js`. This
 * is a data structure, so `test/readyQueue.test.js` drives it against a plain `new ArrayBuffer()`
 * with no Harper at all.
 */

// Header, Int32 slots:
//   0  activeSlot        which slot readers should use (0 or 1)
//   1  generation        bumped on every publish; lets a reader notice it was mid-flight
//   2  cursor            next index to hand out, shared across workers
//   3  count[slot 0]
//   4  count[slot 1]
//   5  sweptAtSec        when the active slot was published (relative epoch, see below)
//   6  scannedRows       how many rows the publishing sweep examined, for reporting
const H_ACTIVE = 0;
const H_GENERATION = 1;
const H_CURSOR = 2;
const H_COUNT_0 = 3;
const H_COUNT_1 = 4;
const H_SWEPT_AT = 5;
const H_SCANNED = 6;
const HEADER_INT32 = 8; // one spare, so a future field does not move the slots

/**
 * Timestamps are Int32 SECONDS relative to a fixed constant, matching `util/renderLease.js`: raw
 * epoch seconds overflow an Int32 in 2038, and a baked-in constant means two workers can never
 * disagree about what a stored number means.
 */
export const READY_EPOCH_SEC = 1_700_000_000;

/**
 * Per entry: a fixed record plus its key bytes in the slot's blob region.
 *
 *   scoreMilli  Int32  the score x 1000, so a reader can report it without recomputing
 *   dueAtSec    Int32  seconds relative to READY_EPOCH_SEC
 *   keyOffset   Int32  byte offset of the key within the slot's blob region
 *   keyLen      Int32  key length in bytes
 *   flags       Int32  bit 0 = fromSitemap
 *
 * `fromSitemap` is carried even though ordering does not need it — the boost is already folded into
 * the score. The renderer needs the LIVE value: it serializes a non-indexable page only when the url
 * is sitemap-listed, so a job that reports `false` for a listed page silently stops that page being
 * cached at all. That bug has been introduced twice in this package by a caller that let the flag go
 * absent, and the alternative here is a point read per granted job on the claim path against a
 * residency-pinned table, where an unowned read takes an untimed replication fetch.
 */
const E_SCORE = 0;
const E_DUE_AT = 1;
const E_KEY_OFFSET = 2;
const E_KEY_LEN = 3;
const E_FLAGS = 4;
const ENTRY_INT32 = 5;

const F_FROM_SITEMAP = 1;

/**
 * Bytes reserved per entry for its key. The production cache key is a URL plus a device suffix;
 * measured against the corpus the long tail of product URLs sits comfortably under this, and a key
 * that does not fit is DROPPED FROM THE SET rather than truncated — a truncated key is a key that
 * names a different row, which would grant a lease on the wrong page.
 */
export const READY_KEY_BYTES = 256;

export const READY_SAB_KEY = 'prerender/ready-queue';

/** Byte size of a ready-set buffer holding `capacity` entries per slot. */
export const readyBufferBytes = (capacity) => {
	const cap = Math.max(1, capacity | 0);
	const perSlot = cap * ENTRY_INT32 * 4 + cap * READY_KEY_BYTES;
	return HEADER_INT32 * 4 + 2 * perSlot;
};

/** How many entries per slot a buffer of this size holds. */
export const readyCapacityIn = (byteLength) =>
	Math.max(0, Math.floor((byteLength - HEADER_INT32 * 4) / (2 * (ENTRY_INT32 * 4 + READY_KEY_BYTES))));

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const toSec = (ms) => Math.round(ms / 1000) - READY_EPOCH_SEC;
const fromSec = (sec) => (sec + READY_EPOCH_SEC) * 1000;

/**
 * @param {object} opts
 * @param {ArrayBuffer} opts.buffer  shared across the node's workers
 * @param {number} [opts.capacity]  entries per slot; clamped to what the buffer actually holds
 * @param {() => number} [opts.now]  injected clock, late-bound by the caller
 */
export const createReadyQueue = ({ buffer, capacity, now = Date.now } = {}) => {
	const i32 = new Int32Array(buffer);
	const bytes = new Uint8Array(buffer);
	// Clamped to the buffer, never trusted from the argument: indexing past a short buffer is silent
	// memory corruption, whereas deriving the capacity from the buffer we actually got is merely a
	// smaller set — and a smaller set degrades to the fallback scan, which is safe.
	const cap = Math.min(
		Math.max(0, capacity | 0) || readyCapacityIn(buffer.byteLength),
		readyCapacityIn(buffer.byteLength)
	);

	const perSlotEntryBytes = cap * ENTRY_INT32 * 4;
	const slotEntryBase = (slot) => HEADER_INT32 * 4 + slot * (perSlotEntryBytes + cap * READY_KEY_BYTES);
	const slotBlobBase = (slot) => slotEntryBase(slot) + perSlotEntryBytes;
	const entryIndex = (slot, i) => slotEntryBase(slot) / 4 + i * ENTRY_INT32;

	const countSlot = (slot) => (slot === 0 ? H_COUNT_0 : H_COUNT_1);

	const readEntry = (slot, i) => {
		const base = entryIndex(slot, i);
		const keyOffset = Atomics.load(i32, base + E_KEY_OFFSET);
		const keyLen = Atomics.load(i32, base + E_KEY_LEN);
		if (keyLen <= 0 || keyLen > READY_KEY_BYTES) return null;
		return {
			cacheKey: decoder.decode(bytes.subarray(keyOffset, keyOffset + keyLen)),
			dueAt: fromSec(Atomics.load(i32, base + E_DUE_AT)),
			score: Atomics.load(i32, base + E_SCORE) / 1000,
			fromSitemap: (Atomics.load(i32, base + E_FLAGS) & F_FROM_SITEMAP) !== 0,
		};
	};

	return {
		capacity: cap,

		/**
		 * Publish a whole generation. `rows` must already be BEST FIRST — the cursor hands out indices
		 * in order and compares nothing, so ordering is this function's contract, not the reader's.
		 *
		 * Writes the INACTIVE slot and flips at the end, so a reader is never looking at a half-written
		 * set. Returns how many entries were actually stored.
		 */
		publish(rows, { scannedRows = 0 } = {}) {
			if (cap === 0) return 0;
			const target = Atomics.load(i32, H_ACTIVE) === 0 ? 1 : 0;
			const blobBase = slotBlobBase(target);

			let stored = 0;
			for (const { entry, score } of rows) {
				if (stored >= cap) break;
				const encoded = encoder.encode(entry.cacheKey);
				// DROPPED, NOT TRUNCATED. A truncated key names a different row, and granting a lease on
				// the wrong page is worse than not granting one — the fallback scan will find this row.
				if (encoded.length > READY_KEY_BYTES) continue;
				const keyOffset = blobBase + stored * READY_KEY_BYTES;
				bytes.set(encoded, keyOffset);
				const base = entryIndex(target, stored);
				Atomics.store(i32, base + E_SCORE, Math.round(Math.min(2_147_483, score) * 1000));
				Atomics.store(i32, base + E_DUE_AT, toSec(entry.dueAt));
				Atomics.store(i32, base + E_KEY_OFFSET, keyOffset);
				Atomics.store(i32, base + E_KEY_LEN, encoded.length);
				Atomics.store(i32, base + E_FLAGS, entry.fromSitemap ? F_FROM_SITEMAP : 0);
				stored++;
			}

			Atomics.store(i32, countSlot(target), stored);
			Atomics.store(i32, H_SCANNED, Math.min(scannedRows, 2_147_483_647));
			Atomics.store(i32, H_SWEPT_AT, toSec(now()));
			// ORDER MATTERS: reset the cursor BEFORE flipping, or a claim landing between the two reads
			// the new slot with the old slot's cursor and skips the head of a fresh generation.
			Atomics.store(i32, H_CURSOR, 0);
			Atomics.store(i32, H_ACTIVE, target);
			Atomics.add(i32, H_GENERATION, 1);
			return stored;
		},

		/**
		 * Take the next `n` entries in priority order. Returns fewer (or none) when the set is
		 * exhausted, which is the caller's signal to fall back to the index scan.
		 *
		 * `Atomics.add` on the cursor is the whole concurrency story: two workers can never be handed
		 * the same index, and there is no lock to hold while a claim is in flight.
		 */
		take(n) {
			const out = [];
			if (cap === 0) return out;
			const slot = Atomics.load(i32, H_ACTIVE);
			const count = Atomics.load(i32, countSlot(slot));
			for (let i = 0; i < n; i++) {
				const index = Atomics.add(i32, H_CURSOR, 1);
				if (index >= count) {
					// Do not let the cursor run away past the count while a set is exhausted: it is an
					// Int32 and a busy node claims several times a second, so an unbounded increment would
					// wrap in about eight days of idling and start handing out valid indices again.
					Atomics.store(i32, H_CURSOR, count);
					break;
				}
				const entry = readEntry(slot, index);
				if (entry) out.push(entry);
			}
			return out;
		},

		/** What the console and the metrics read. No database work, all atomic loads. */
		state() {
			const slot = Atomics.load(i32, H_ACTIVE);
			const count = Atomics.load(i32, countSlot(slot));
			const cursor = Math.min(Atomics.load(i32, H_CURSOR), count);
			const sweptAtSec = Atomics.load(i32, H_SWEPT_AT);
			return {
				capacity: cap,
				count,
				consumed: cursor,
				remaining: Math.max(0, count - cursor),
				generation: Atomics.load(i32, H_GENERATION),
				scannedRows: Atomics.load(i32, H_SCANNED),
				sweptAt: sweptAtSec === 0 ? null : fromSec(sweptAtSec),
				ageMs: sweptAtSec === 0 ? null : Math.max(0, now() - fromSec(sweptAtSec)),
			};
		},

		/** Peek at the head without consuming — for the explainer and for tests. */
		peek(n = 10) {
			const slot = Atomics.load(i32, H_ACTIVE);
			const count = Atomics.load(i32, countSlot(slot));
			const cursor = Math.min(Atomics.load(i32, H_CURSOR), count);
			const out = [];
			for (let i = cursor; i < Math.min(count, cursor + n); i++) {
				const entry = readEntry(slot, i);
				if (entry) out.push(entry);
			}
			return out;
		},
	};
};
