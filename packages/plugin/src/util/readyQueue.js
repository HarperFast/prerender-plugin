/**
 * THE READY SET — the node's answer to "which page next", held in shared memory rather than derived
 * from an index.
 *
 * ── WHY THIS EXISTS AT ALL ─────────────────────────────────────────────────────────────────────
 *
 * Priority is relative lateness (`util/renderPriority.js`), which no stored key can order, so the
 * queue cannot be read off an index in the order it should be served. The queue keeper
 * (`util/queueKeeperService.js`) holds every due row on worker 0 and publishes the best few thousand
 * here each second; `claim`, on whichever worker the consumer's poll landed, pops from this in
 * priority order and touches no index at all.
 *
 * An entry is a pointer, never the truth: a claim point-reads each entry's durable row before granting
 * it (`claimSchedules`), so an entry naming a row that has since been rescheduled or deleted is skipped,
 * not rendered.
 *
 * ── WHY A SHARED BUFFER, AND WHY DOUBLE-BUFFERED ──────────────────────────────────────────────
 *
 * Claims arrive on whichever worker the consumer's poll landed on, and the keeper lives on one. It
 * publishes here; every worker reads.
 *
 * The set is REBUILT WHOLE on every publish, never mutated in place, which is what makes the layout
 * trivial: two slots, write the inactive one, flip an atomic. No fragmentation, no compaction, no
 * partially-visible set — a reader is always looking at one complete generation. Keys are packed end to
 * end in the slot's key region in publish order, so a variable-length key needs no allocator.
 *
 * ── AND WHY THE CURSOR IS A BARE ATOMIC ────────────────────────────────────────────────────────
 *
 * Entries are written BEST FIRST, so consumption order is already priority order and a consumer needs
 * to compare nothing. Claiming is `Atomics.add(cursor, 1)`: no lock, no scan, no coordination, and two
 * workers can never be handed the same index. Popping past the end simply reports exhaustion: the
 * keeper republishes within a second.
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
//   6  scannedRows       due rows the keeper held at publish, for reporting
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
 * the score. A claim hands the renderer the value off the durable row it reads before granting, not
 * this one; the copy here is for the explainer and the tests.
 */
const E_SCORE = 0;
const E_DUE_AT = 1;
const E_KEY_OFFSET = 2;
const E_KEY_LEN = 3;
const E_FLAGS = 4;
const ENTRY_INT32 = 5;

const F_FROM_SITEMAP = 1;

/**
 * Key bytes budgeted per entry: a slot's key region is `capacity × READY_KEY_BYTES` bytes, shared by
 * its entries end to end, so any one key may be far longer — only the total is bounded. A generation
 * whose keys outrun the region ends at the last key that fit (never truncated: a truncated key names a
 * different row), and the rest follow in a later generation once the head has been claimed.
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
	// smaller set.
	const cap = Math.min(
		Math.max(0, capacity | 0) || readyCapacityIn(buffer.byteLength),
		readyCapacityIn(buffer.byteLength)
	);

	const perSlotEntryBytes = cap * ENTRY_INT32 * 4;
	const keyRegionBytes = cap * READY_KEY_BYTES;
	const slotEntryBase = (slot) => HEADER_INT32 * 4 + slot * (perSlotEntryBytes + cap * READY_KEY_BYTES);
	const slotBlobBase = (slot) => slotEntryBase(slot) + perSlotEntryBytes;
	const entryIndex = (slot, i) => slotEntryBase(slot) / 4 + i * ENTRY_INT32;

	const countSlot = (slot) => (slot === 0 ? H_COUNT_0 : H_COUNT_1);

	const readEntry = (slot, i) => {
		const base = entryIndex(slot, i);
		const keyOffset = Atomics.load(i32, base + E_KEY_OFFSET);
		const keyLen = Atomics.load(i32, base + E_KEY_LEN);
		// Bounds-checked against the slot's key region: an entry read while its slot was being rewritten
		// can pair a stale offset with a fresh length, and must fail rather than read past the region.
		const regionBase = slotBlobBase(slot);
		if (keyLen <= 0 || keyOffset < regionBase || keyOffset + keyLen > regionBase + keyRegionBytes) return null;
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
		 * set. Returns how many entries were actually stored: fewer than offered when the capacity or the
		 * key region filled first.
		 */
		publish(rows, { scannedRows = 0 } = {}) {
			if (cap === 0) return 0;
			const target = Atomics.load(i32, H_ACTIVE) === 0 ? 1 : 0;
			const blobBase = slotBlobBase(target);

			let stored = 0;
			let keyBytes = 0;
			for (const { entry, score } of rows) {
				if (stored >= cap) break;
				const encoded = encoder.encode(entry.cacheKey);
				// ENDS THE GENERATION, never skips or truncates: skipping would publish lower-priority rows
				// ahead of this one, and a truncated key names a different row.
				if (keyBytes + encoded.length > keyRegionBytes) break;
				const keyOffset = blobBase + keyBytes;
				keyBytes += encoded.length;
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
			// ORDER MATTERS, together with `take` reading the slot AFTER its cursor increment: flip first,
			// then reset. Any index a take gets is then read from the slot that was active when it got it
			// or a newer one, so a take straddling a publish can hand out a new-generation entry a second
			// time (the lease grant refuses the duplicate) but never skips one. The other order let a take
			// that read the old slot consume index 0.. of the new generation: its head, handed to nobody.
			Atomics.store(i32, H_ACTIVE, target);
			Atomics.store(i32, H_CURSOR, 0);
			Atomics.add(i32, H_GENERATION, 1);
			return stored;
		},

		/**
		 * Take the next `n` entries in priority order. Returns fewer (or none) when the set is
		 * exhausted.
		 *
		 * `Atomics.add` on the cursor is the whole concurrency story: within one generation two workers
		 * can never be handed the same index, and there is no lock to hold while a claim is in flight.
		 * The slot is read after each increment, never before (see the ordering note in `publish`).
		 */
		take(n) {
			const out = [];
			if (cap === 0) return out;
			for (let i = 0; i < n; i++) {
				const index = Atomics.add(i32, H_CURSOR, 1);
				const slot = Atomics.load(i32, H_ACTIVE);
				const count = Atomics.load(i32, countSlot(slot));
				if (index >= count) {
					// Do not let the cursor run away past the count while a set is exhausted: it is an
					// Int32 and a busy node claims several times a second, so an unbounded increment would
					// wrap in about eight days of idling and start handing out valid indices again.
					//
					// A COMPARE-EXCHANGE, NOT A STORE, and the difference is a whole generation. A plain
					// store here races `publish`: publish resets the cursor to 0 and flips the slot, and a
					// store landing just after that rewinds it to the PREVIOUS generation's count — so every
					// entry of the fresh set is skipped, silently, until the next publish replaces it. The CAS
					// only clamps if the cursor is still where this call's own increment left it, so a
					// concurrent reset always wins. (Two threads are needed to hit it, which is why no test
					// here can: single-threaded, nothing can interleave between the add and the clamp.)
					Atomics.compareExchange(i32, H_CURSOR, index + 1, count);
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
