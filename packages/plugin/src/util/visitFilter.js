/**
 * Visit filter — "was this URL visited by a bot in the last N hours?", as a ring of Bloom
 * slices. The storage behind the DEMAND TRACKER (`demand.*`): `util/demand.js` turns it into a
 * demand level per URL, and the cadence ladder (util/demandLadder.js) asks it membership
 * questions directly, as it always has.
 *
 * WHY A BLOOM FILTER AND NOT A `lastVisitedAt` COLUMN. The obvious design is a timestamp on
 * Target, which the reschedule path already reads for free. It does not survive the traffic
 * this exists for. A per-URL write dedupes only within a flush window, so at the ~10M
 * bot-requests/day the search-engine ramp is sized for, writes land at roughly the distinct-
 * URL rate — order 100/s against a REPLICATED table whose patch path has already caused one
 * replication incident. A Bloom ring writes ONE merged-row RMW per NODE per dirty slot per
 * flush interval and costs constant memory regardless of request volume. The price is that it
 * cannot enumerate its members (see "no enumeration" below) and answers with false positives.
 *
 * COUNT THE BYTES, NOT THE PUTS. This module originally wrote that row once per WORKER, on the
 * reasoning that it was "a dozen small replicated puts per node per 5 minutes". The put count
 * was right and the adjective was wrong: the row is `bitsPerSlice / 8` bytes — 128 KB at the
 * default — so sixteen workers rewriting it every interval is ~2 MB per slot per interval of
 * REPLICATED transaction log for one row's worth of state. Measured on production: 1.2 GB of
 * transaction logs behind 18 MB of live data, the largest log corpus on the cluster (#87).
 * Workers now merge into a node-shared buffer (`sharedSlice`) and exactly one of them writes
 * per interval (`claimWriteTurn`), which is the same stored state for 1/N of the log volume.
 * Any future change here should price the BYTES on the replicated path, not the operations.
 *
 * WHY FALSE POSITIVES ARE THE SAFE ERROR. A false positive says "visited" for a URL nobody
 * asked for → that target renders MORE often than it needs to: wasted work, never staleness.
 * There are no false negatives, so a genuinely visited page can never be demoted for lack of
 * evidence. The one direction that would actually hurt is the one the structure cannot
 * produce.
 *
 * WHY A RING AND NOT ONE FILTER. A single 24h filter answers only "seen recently", which
 * saturates a multi-rung ladder: one visit pins a page at the fastest cadence for a whole
 * day, and a page visited once looks identical to one visited a thousand times. Slices let
 * the ladder ask the question it actually needs — "would this have been visited BETWEEN
 * renders at the candidate interval?" — by OR-ing the last ceil(interval / sliceMs) slices.
 * A page then only holds a fast rung if it keeps earning it at that rung's own timescale.
 *
 * NO ENUMERATION. `visitedWithin` tests membership; there is no way to list the visited set.
 * Anything needing "which URLs are hot" (e.g. scoping a bulk revalidation sweep) must walk
 * targets and test each, or use a different structure. This is why the ladder adjusts cadence
 * per-target at reschedule time rather than driving a sweep.
 *
 * SHAPE. Mirrors util/crawlStats.js exactly: per-thread slices accumulate in memory, a timer
 * merges them into this node's row (`slot|node`) under the cross-worker mutex, and rows
 * replicate so any node can answer. Reads merge every node's row for the slots they need,
 * cached in-memory and refreshed on a timer — the reschedule path runs ~20x/s and must not
 * pay a multi-row read per job result.
 *
 * Hot-path cost (recordVisit): one number compare for slot rollover, k = 7 int32 hash rounds
 * over the URL, k byte writes. No allocation, no await, no storage touch.
 */

import { setImmediate } from 'node:timers/promises';
import { config, onConfigApplied } from '../config.js';
import { getMutex, getSab } from './coordination.js';
import { fnv1a32 } from './hash.js';
import { metrics } from '../metrics.js';

const table = () => databases.crawl_stats.VisitFilter;

/** k independent bit positions for `url`, by double hashing two salted fnv1a32 words. */
const bitsFor = (url, bitCount, k, out) => {
	const h1 = fnv1a32(url);
	// The prefix SALT is load-bearing: hashing the url twice would make h2 === h1 and collapse
	// the k probes onto a single url-dependent stride, wrecking the false-positive rate.
	// Salting by prefix (not a different mixing constant) is the idiom `lease64` already uses,
	// so both words come from the one hash function this package has tests for. `| 1` forces an
	// odd stride, coprime with a power-of-two bitCount, so probes reach every residue class.
	const h2 = fnv1a32('\u0001' + url) | 1;
	for (let i = 0; i < k; i++) out[i] = ((h1 + Math.imul(i, h2)) >>> 0) % bitCount;
	return out;
};

const setBits = (bytes, idx, k) => {
	for (let i = 0; i < k; i++) bytes[idx[i] >>> 3] |= 1 << (idx[i] & 7);
};

const hasBits = (bytes, idx, k) => {
	for (let i = 0; i < k; i++) if (!(bytes[idx[i] >>> 3] & (1 << (idx[i] & 7)))) return false;
	return true;
};

// ---------------------------------------------------------------------------- write side

let slices = new Map(); // slot -> Uint8Array (this thread's observations for that slot)
const dirty = new Set(); // slots with unmerged thread-local bits
// slots this thread merged into the shared buffer and has not seen stored: slot -> { gen, since }
const pendingWrite = new Map();
let slot = null; // the ring slot the clock is currently in
let slotEndMs = 0; // rollover boundary, so the hot path compares one number
let flushTimer = null;
let armedFlushInterval = null;
const scratch = new Int32Array(32); // reused index buffer; k is bounded well below 32

const sliceMs = () => config.demand.sliceMs;
const sliceCount = () => config.demand.slices;
// bitsPerSlice, normalized UP to a power of two (memoized on the raw config value — one
// compare on the hot path). Two things depend on the normalization, not just prefer it:
//   - byte sizing: a non-multiple-of-8 count would truncate at `>>> 3`, and bits past the
//     truncated end silently never store (typed arrays ignore OOB writes) yet always read
//     absent — a false-NEGATIVE source, the one error direction this filter must not have;
//   - probe spread: `bitsFor` guarantees distinct probes via an odd stride, which is
//     coprime with a POWER-OF-TWO modulus specifically.
let bcRaw = 0;
let bcNorm = 0;
const bitCount = () => {
	const raw = config.demand.bitsPerSlice;
	if (raw !== bcRaw) {
		bcRaw = raw;
		bcNorm = 1024;
		while (bcNorm < raw) bcNorm *= 2;
	}
	return bcNorm;
};
const hashes = () => Math.min(config.demand.hashes, scratch.length);

/** Ring slot for a wall-clock time. Monotonic, so slot order is comparable modulo the ring. */
export const slotOf = (ms) => Math.floor(ms / sliceMs());

const newSlice = () => new Uint8Array(bitCount() >>> 3);

/**
 * Observe one bot visit. Called on the serving path; synchronous by design.
 * `url` is the device-free public URL (the Target primary key), NOT the cacheKey — cadence
 * resolves per URL, and dropping the device split halves the distinct count the filter holds.
 */
export function recordVisit(url) {
	if (!config.demand.enabled) return;

	const now = Date.now();
	if (now >= slotEndMs) rollover(now);

	let bytes = slices.get(slot);
	if (!bytes) {
		bytes = newSlice();
		slices.set(slot, bytes);
	}
	setBits(bytes, bitsFor(url, bitCount(), hashes(), scratch), hashes());
	dirty.add(slot);

	if (!flushTimer) armFlushTimer();
}

function rollover(now) {
	slot = slotOf(now);
	slotEndMs = (slot + 1) * sliceMs();
	// Drop in-memory slices that have aged out of the ring; one worker per node also sweeps
	// their persisted rows (same division of labor as crawlStats' day rollover — the sweep is
	// setImmediate'd off the hot path and bounded by `limit`).
	const oldest = slot - sliceCount();
	for (const s of slices.keys()) if (s <= oldest) slices.delete(s);
	// Aged-out slots can no longer be answered by any probe, so an unwritten one is dead debt;
	// dropping it keeps the set bounded by the ring rather than by uptime.
	for (const s of pendingWrite.keys()) if (s <= oldest) pendingWrite.delete(s);
	if (server.workerIndex === 0) {
		setImmediate().then(() => sweepExpired(oldest).catch((e) => logger.error(e)));
	}
}

/**
 * Delete persisted slices outside the ring: older than the cutoff, and beyond the current
 * slot. The future side is not paranoia — a `sliceMs` INCREASE renumbers slots DOWNWARD, so
 * rows written under the old numbering sit above every reachable slot; the age cutoff can
 * never touch them, and every worker would re-load them into its union forever. Nothing
 * legitimate is ever filed past the current slot (+1 absorbs boundary skew across nodes).
 * Exported for tests.
 */
export async function sweepExpired(cutoffSlot, nowSlot = slotOf(Date.now())) {
	const VisitFilter = table();
	const gone = [
		[{ attribute: 'slot', comparator: 'less_than', value: cutoffSlot }],
		[{ attribute: 'slot', comparator: 'greater_than', value: nowSlot + 1 }],
	];
	for (const conditions of gone) {
		const rows = await VisitFilter.search({ conditions, select: ['id'], limit: 1000 });
		for await (const row of rows) {
			await VisitFilter.delete(row.id);
		}
	}
}

const armFlushTimer = () => {
	armedFlushInterval = config.demand.flushInterval;
	// Every worker MERGES on every tick; only the interval's winner also WRITES. See
	// `claimWriteTurn` — the dedup lives here rather than inside `flushSlices` so that explicit
	// calls (the disable path below, shutdown, tests) always persist.
	flushTimer = setInterval(
		() => flushSlices({ write: claimWriteTurn() }).catch((e) => logger.error(e)),
		armedFlushInterval
	);
	flushTimer.unref?.();
};

// ------------------------------------------------------- one writer per node per interval
//
// The node's accumulated bits live in a shared buffer (see `sharedSlice`), so the row can be
// written by ANY one worker rather than by all of them. This is the atomic turn-taking that
// picks that one: whoever first observes that a full `flushInterval` has elapsed since the last
// write claims the turn with a CAS and does it; every other worker merges and returns.
//
// WHY THIS MATTERS: the row is `bitsPerSlice / 8` bytes — 128 KB at the default — and it
// replicates. Sixteen workers each writing it every interval put ~2 MB per slot per interval
// into the replicated transaction log for one row's worth of state, which measured 1.2 GB of
// transaction logs against 18 MB of live data on a production node (#87). One writer makes that
// 1/N without changing what is stored.
//
// Seconds are stored relative to a fixed epoch, in Int32, for the same reason `renderLease` does
// it: raw epoch seconds leave Int32 in 2038, and the offset buys a lifetime either side.
const TURN_EPOCH_SEC = 1_700_000_000;
const nowTurnSec = () => Math.floor(Date.now() / 1000) - TURN_EPOCH_SEC;

const claimWriteTurn = () => {
	const intervalSec = Math.max(1, Math.round(config.demand.flushInterval / 1000));
	const now = nowTurnSec();
	// Keyed by shape: a sizing change starts a fresh turn clock rather than inheriting one taken
	// against rows of a different byte length.
	const turn = new Int32Array(getSab(`visitFilter/turn/${shapeOf()}`, 4));
	const last = Atomics.load(turn, 0);
	const elapsed = now - last;
	// Only a turn taken in the PAST, within the interval, blocks this one. A bare
	// `elapsed < intervalSec` would also match a NEGATIVE elapsed — a clock stepped backwards
	// (NTP correction, VM migration) leaves `last` in the future, and the turn would then be
	// wedged shut until the clock caught up, which for a large step means no visit-filter write
	// for as long as it takes. Requiring `elapsed >= 0` to block makes a backward step reclaim
	// the turn on the next tick and re-anchor `last` to the corrected clock.
	if (last !== 0 && elapsed >= 0 && elapsed < intervalSec) return false;
	return Atomics.compareExchange(turn, 0, last, now) === last;
};

// The filter's persisted shape: slot numbering (sliceMs), byte length (bitsPerSlice,
// normalized), probe count (hashes). Rows written under a different shape are at best
// unreadable (length mismatch, dropped by the union) and at worst silently wrong (fewer
// probe bits set than checked), and a sliceMs change renumbers every slot.
const shapeOf = () => `${sliceMs()}|${bitCount()}|${hashes()}`;
let armedShape = shapeOf();
// When the current shape's history began: 0 until a reshape, then the moment of it. Everything
// before it was recorded under another shape and is unreadable, so a consumer must not read an
// empty slot from before it as "nobody visited" — see `historyFromMs`.
let historyStartMs = 0;

onConfigApplied(() => {
	if (shapeOf() !== armedShape) {
		armedShape = shapeOf();
		// Drop BOTH sides of the in-memory state: old-shape write slices must not flush under
		// the new numbering, and the union must not keep answering from old-shape rows. Then
		// record when the NEW-shape history began: engaging against a near-empty union reads as
		// "nobody visited anything", the error direction this module must not produce, so each
		// consumer holds until the history it needs exists (the ladder: its slowest rung;
		// `visitedSlots`: it counts only the slots since). (Persisted old-shape rows age out via
		// sweepExpired; a sliceMs increase leaves them at impossible-future slot numbers, which
		// the sweep also deletes.)
		slices = new Map();
		dirty.clear();
		slot = null;
		slotEndMs = 0;
		merged = new Map();
		mergedAt = 0;
		unionStats = EMPTY_STATS;
		historyStartMs = Date.now();
	}
	if (!flushTimer) return;
	if (!config.demand.enabled) {
		clearInterval(flushTimer);
		flushTimer = null;
		armedFlushInterval = null;
		flushSlices().catch((e) => logger.error(e)); // persist rather than discard
		return;
	}
	if (config.demand.flushInterval !== armedFlushInterval) {
		clearInterval(flushTimer);
		armFlushTimer();
	}
});

/**
 * This node's accumulated bits for `slot`, shared by every worker on it.
 *
 * Keyed by shape as well as slot, so a `bitsPerSlice` change can never hand back a buffer of the
 * previous byte length (`getUserSharedBuffer` sizes a named buffer once, on first use, and later
 * callers get what the first one allocated — see the sizing note in `renderSchedule.js`).
 *
 * Keyed by ABSOLUTE slot, never by ring position. A ring-position key would have to be zeroed on
 * wrap, and zeroing a buffer other workers may already be OR-ing into is exactly the race that
 * loses bits — i.e. manufactures the false negative this module must never produce. Absolute keys
 * are write-once-per-slot and need no reset. The cost is one buffer per elapsed slot for the
 * process's life (128 KB per 6 h at the defaults, ~0.5 MB/day, released on restart), which is a
 * fair trade for deleting the race outright.
 */
const sharedSlice = (slot) => getSab(`visitFilter/bits/${shapeOf()}/${slot}`, bitCount() >>> 3);

/**
 * Merge `mine` into the node-shared buffer for `slot`, then clear it.
 *
 * `Atomics.or` per 32-bit word, not `|=`: sibling workers merge concurrently and a plain
 * read-modify-write can drop a neighbour's bit inside the same word. A dropped bit is a false
 * NEGATIVE, the one error direction this filter is built to exclude. Word-at-a-time (rather than
 * byte) makes it a quarter of the atomic operations, and the byte length is always a multiple of
 * 4 because `bitCount` is a power of two >= 1024.
 *
 * Zero words are skipped — a sparsely-populated slice is mostly zeros, and `Atomics.or` with 0 is
 * a no-op that still costs a locked instruction.
 */
const mergeIntoShared = (slot, mine) => {
	const shared = new Int32Array(sharedSlice(slot));
	const words = new Int32Array(mine.buffer, mine.byteOffset, mine.byteLength >>> 2);
	let merged = false;
	for (let i = 0; i < words.length; i++) {
		const w = words[i];
		if (w !== 0) {
			Atomics.or(shared, i, w);
			merged = true;
		}
	}
	mine.fill(0);
	// This merge's generation (see "WHO PAYS FOR A MERGE" below), or 0 when nothing was merged.
	return merged ? Atomics.add(generationOf(slot), 0, 1) + 1 : 0;
};

// ── WHO PAYS FOR A MERGE ─────────────────────────────────────────────────────────────────────
//
// One writer per node per interval stores the shared buffer, so a worker that loses the turn relies
// on the winner to store its bits. Relying on it blindly lost them: the winner stores only the slots
// IT has pending, so bits a loser merged after the winner's last store of a slot — the tail of every
// slot, or everything in a slot only a losing worker saw traffic for — waited for the loser to win a
// turn, which a phase-locked timer may never do. Measured on two workers with bursty traffic: one
// worker's visits reached storage in 2 of 5 slots. That is a false negative, the one error this
// filter must not make.
//
// So each shared slot carries two node-shared counters, `[merged, stored]`. A merge takes the next
// `merged` generation; a store records the `merged` value it read before reading the buffer. A worker
// forgets a debt once `stored` has passed its own merge (someone stored its bits), and pays a debt
// itself — turn or no turn — once it is two intervals old: the winner had its chance. In steady
// traffic the winner stores the live slot every interval and no loser ever writes; a loser writes
// only for the tail the winner missed, which is exactly what used to be lost.
const generationOf = (slot) => new Int32Array(getSab(`visitFilter/gen/${shapeOf()}/${slot}`, 8));

/**
 * Merge this thread's dirty slices into the node-shared buffers, and — when `write` is set —
 * persist them to this node's rows. Exported for tests.
 *
 * The split is what makes one write serve every worker: merging is per worker and lock-free,
 * writing is once per node per interval (`claimWriteTurn`). A worker that loses the turn has
 * still contributed its bits to the shared buffer, and the winner's next store of that slot
 * carries them; if none comes within two intervals, this worker stores them itself (see "WHO PAYS
 * FOR A MERGE"). `nowMs` is injectable for tests.
 */
export async function flushSlices({ write = true, nowMs = Date.now() } = {}) {
	// Merge FIRST and unconditionally. This is the step that must not be skipped: it is the only
	// thing that moves observations off this thread, and the shared buffer is what every later
	// write reads from.
	for (const s of dirty) {
		const mine = slices.get(s);
		const gen = mine ? mergeIntoShared(s, mine) : 0;
		// Merged is NOT stored. Tracked separately from `dirty` because a worker that loses the
		// turn clears `dirty` without writing: without this the bits would sit in the shared
		// buffer, unwritten, until some worker happened to have BOTH new traffic for that slot
		// and the turn — and on a quiet node they would simply age out with the slot. That is a
		// false negative, so the debt is held explicitly until a store covers it. A debt keeps the
		// time it was FIRST owed, so a stream of merges cannot keep postponing its payment.
		if (gen) pendingWrite.set(s, { gen, since: pendingWrite.get(s)?.since ?? nowMs });
	}
	dirty.clear();

	// Debts another worker already paid: a store of the slot read the buffer after this merge.
	for (const [s, debt] of pendingWrite) {
		if (Atomics.load(generationOf(s), 1) >= debt.gen) pendingWrite.delete(s);
	}
	if (!pendingWrite.size) return;
	const overdueBefore = nowMs - 2 * config.demand.flushInterval;
	// Clear the debt slot by slot AS EACH ONE LANDS, rather than clearing up front and restoring
	// on failure. A failure part-way through would otherwise re-queue the slots that had already
	// been written, and each of those is another full-size replicated row — re-spending exactly
	// what this function exists to save. Whatever remains in the map is precisely what did not
	// land, and a later flush retries only that.
	for (const [s, debt] of [...pendingWrite]) {
		if (!write && debt.since > overdueBefore) continue;
		await persist(s);
		pendingWrite.delete(s);
	}
}

async function persist(s) {
	const VisitFilter = table();
	const node = server.hostname;
	// Every merge up to this generation is in the buffer read below (merges after it may be too —
	// storing a bit twice is harmless, missing one is not).
	const generation = generationOf(s);
	const covered = Atomics.load(generation, 0);
	const bits = new Uint8Array(sharedSlice(s));
	const id = `${s}|${node}`;
	// Read-merge-write of this node's own row (node is in the key, so the read is local and
	// cannot take a cross-node fetch), serialized against sibling workers by the cross-worker
	// mutex. The read is still required even though the shared buffer holds this process's full
	// accumulation: after a restart the buffer starts empty while the ROW still holds everything
	// written before it, and a plain overwrite would drop that history — again a false negative.
	// Same discipline as crawlStats.persist.
	const mutex = getMutex(`visitFilter/${s}`);
	await mutex.lock();
	try {
		const existing = await VisitFilter.get(id);
		const merged = existing?.bits ? new Uint8Array(existing.bits) : newSlice();
		if (merged.length !== bits.length) {
			// bitsPerSlice changed under us; the old row is a different shape. Start clean rather
			// than merging garbage — one slice of undercount, self-heals next slot.
			await VisitFilter.put(id, { slot: s, node, bits: Buffer.from(bits), updatedAt: Date.now() });
		} else {
			for (let i = 0; i < merged.length; i++) merged[i] |= bits[i];
			await VisitFilter.put(id, { slot: s, node, bits: Buffer.from(merged), updatedAt: Date.now() });
		}
	} finally {
		mutex.unlock();
	}
	markStored(generation, covered);
}

/** Raise `stored` to `covered`, never lower it (a slower concurrent store may finish last). */
const markStored = (generation, covered) => {
	let cur = Atomics.load(generation, 1);
	while (covered > cur) {
		const prev = Atomics.compareExchange(generation, 1, cur, covered);
		if (prev === cur) break;
		cur = prev;
	}
};

// ---------------------------------------------------------------------------- read side

let merged = new Map(); // slot -> Uint8Array unioned across nodes
let mergedAt = 0;
let refreshing = null;

// Measured once per re-union, never per question: the set-bit fraction of each slot and the
// false-positive rate that implies (`fill^k`). The newest slot is PARTIAL and still filling, so it
// is reported (`newestFill`, the sizing sawtooth) but kept out of the worst case, which is taken
// over the FULL slots — the ones most of every level count is made of.
const EMPTY_STATS = Object.freeze({ newestFill: 0, worstFill: 0, worstFalsePositive: 0 });
let unionStats = EMPTY_STATS;

const fillOf = (bytes) => {
	let set = 0;
	for (let i = 0; i < bytes.length; i++) {
		let b = bytes[i];
		b = b - ((b >> 1) & 0x55);
		b = (b & 0x33) + ((b >> 2) & 0x33);
		set += (b + (b >> 4)) & 0x0f;
	}
	return bytes.length ? set / (bytes.length * 8) : 0;
};

const measureUnion = (union, newestSlot) => {
	const expected = bitCount() >>> 3;
	let newestFill = 0;
	let worstFill = 0;
	let fullSlots = 0;
	for (const [s, bytes] of union) {
		if (bytes.length !== expected) continue;
		const fill = fillOf(bytes);
		if (s === newestSlot) newestFill = fill;
		else {
			fullSlots++;
			if (fill > worstFill) worstFill = fill;
		}
	}
	// A ring with only its newest slot has no full slot to judge; the partial one is all there is.
	if (!fullSlots) worstFill = newestFill;
	return { newestFill, worstFill, worstFalsePositive: worstFill ** hashes() };
};

/**
 * Refresh the in-memory union of every node's rows for the slots still in the ring.
 * Cheap (slices x nodes small rows) and on a timer, because the reschedule path cannot
 * afford a multi-row read per job result.
 */
export async function refreshMerged(nowMs = Date.now()) {
	const VisitFilter = table();
	const newest = slotOf(nowMs);
	const oldest = newest - sliceCount() + 1;
	const next = new Map();
	let scanned = 0;
	const found = await VisitFilter.search({
		conditions: [{ attribute: 'slot', comparator: 'greater_than_equal', value: oldest }],
		select: ['slot', 'bits'],
	});
	for await (const row of found) {
		// Bounded at ring-length x nodes rows, so this rarely fires — but it runs on workers
		// serving traffic, and awaiting a cursor only drains microtasks (repo convention:
		// yield by rows SCANNED, same as util/scan.js).
		if (++scanned % config.scan.yieldEvery === 0) await setImmediate();
		if (!row?.bits) continue;
		const cur = next.get(row.slot);
		const bits = new Uint8Array(row.bits);
		if (!cur) next.set(row.slot, bits);
		else if (cur.length === bits.length) for (let i = 0; i < cur.length; i++) cur[i] |= bits[i];
	}
	merged = next;
	mergedAt = nowMs;
	unionStats = measureUnion(next, newest);
	// The sizing signals, emitted where they are measured. `fill` is the newest slot's (the sawtooth
	// to read at its PEAK), `false_positive` the worst full slot's `fill^k` — the number
	// `demand.maxFalsePositive` is compared against. Guarded: losing a metric must never fail a
	// refresh.
	try {
		metrics.demand(unionStats.newestFill, 'fill');
		metrics.demand(unionStats.worstFalsePositive, 'false_positive');
	} catch {
		// metrics unavailable (tests, early boot)
	}
	return merged;
}

/**
 * True once the read-side union holds a first refresh. Consumers decide for themselves how much
 * history they need on top (`historyFromMs`): the union may be populated but still blind to
 * everything recorded before a reshape.
 */
export const mergedWarm = () => mergedAt > 0;

/**
 * When the current shape's history began — 0 unless the filter was reshaped since boot. Nothing
 * recorded before it is readable, so an empty slot from before it is NOT evidence of no visits.
 */
export const historyFromMs = () => historyStartMs;

/** The last re-union's sizing measurements: `{ newestFill, worstFill, worstFalsePositive }`. */
export const unionHealth = () => unionStats;

/**
 * Kick the background refresh without asking a membership question.
 *
 * Load-bearing for cold start: the ladder refuses to decide while the union is cold (a cold
 * union reads as "nothing was visited anywhere", which would demote the whole corpus on the
 * first pass after a restart). But the refresh is normally driven lazily from `visitedWithin`,
 * which that same refusal skips — so without this the filter would never warm and the ladder
 * would stay disabled forever.
 */
export const ensureMerged = (nowMs = Date.now()) => {
	maybeRefresh(nowMs);
};

/**
 * Warm the union and WAIT for it: resolves once a refresh that was due has landed (at once when the
 * union is already current). For a caller about to ask many questions in a row — a probe pass — so
 * the first few are not answered by a cold union.
 */
export const awaitMerged = async (nowMs = Date.now()) => {
	await maybeRefresh(nowMs);
};

const maybeRefresh = (nowMs) => {
	if (refreshing) return refreshing;
	if (nowMs - mergedAt < config.demand.mergeInterval) return undefined;
	refreshing = refreshMerged(nowMs)
		.catch((e) => logger.error(e))
		.finally(() => {
			refreshing = null;
		});
	return refreshing;
};

/**
 * Was `url` visited at any point in the last `windowMs`? Tests the ring slices covering that
 * window; a slot with no row anywhere reads as "not visited", so a cold read-side union
 * answers false rather than inventing traffic.
 */
export function visitedWithin(url, windowMs, nowMs = Date.now()) {
	maybeRefresh(nowMs);
	if (!merged.size) return false;
	const k = hashes();
	const newest = slotOf(nowMs);
	// Anchor on the slot containing the window's START, not on a slot count. The newest slot
	// is PARTIAL: `ceil(windowMs/sliceMs)` slots back from it cover as little as the elapsed
	// part of the current slot — a probe minutes into a slot at the 6h rung would examine
	// minutes of its 6h window, and the miss direction is a false NEGATIVE, the one error
	// this filter must not make (a genuinely visited page reading unvisited gets demoted).
	// Anchoring instead over-covers by up to one slice — the safe, documented direction.
	// Clamped to the ring so a window wider than the ring cannot walk absent slots.
	const oldest = Math.max(slotOf(nowMs - windowMs), newest - sliceCount() + 1);
	const idx = bitsFor(url, bitCount(), k, scratch);
	for (let s = newest; s >= oldest; s--) {
		const bytes = merged.get(s);
		if (bytes && bytes.length === bitCount() >>> 3 && hasBits(bytes, idx, k)) return true;
	}
	return false;
}

/**
 * In how many ring slots was `url` visited? The demand LEVEL, 0..`covered`, over the slots the
 * union can answer for: the ring, newest (partial) slot included, clipped to the current shape's
 * history (`historyFromMs`) and to the oldest slot any node has written — a tracker switched on
 * yesterday has one day of slots, and an empty slot before its first row is not evidence of
 * nothing. `covered` is 0 while the union is cold. A read of the cached union; the refresh it may
 * kick is async and answers later questions.
 */
export function visitedSlots(url, nowMs = Date.now()) {
	maybeRefresh(nowMs);
	if (!merged.size) return { level: 0, covered: 0 };
	const k = hashes();
	const expected = bitCount() >>> 3;
	const newest = slotOf(nowMs);
	let oldest = newest - sliceCount() + 1;
	if (historyStartMs > 0) oldest = Math.max(oldest, slotOf(historyStartMs));
	let firstWritten = Infinity;
	for (const [s, bytes] of merged) if (bytes.length === expected && s < firstWritten) firstWritten = s;
	oldest = Math.max(oldest, firstWritten);
	if (oldest > newest) return { level: 0, covered: 0 };
	const idx = bitsFor(url, bitCount(), k, scratch);
	let level = 0;
	for (let s = oldest; s <= newest; s++) {
		const bytes = merged.get(s);
		if (bytes && bytes.length === expected && hasBits(bytes, idx, k)) level++;
	}
	return { level, covered: newest - oldest + 1 };
}

/**
 * Was `url` visited in EACH of the last `count` consecutive windows of `windowMs`?
 *
 * This is the promotion test, and the distinction from `visitedWithin` is the whole reason
 * the ladder converges sensibly. "Visited at all during the current interval" promotes a page
 * whose real visit period equals its interval, which settles at rendering TWICE per visit.
 * Requiring a visit in each of the last two candidate-sized windows asks the sharper question
 * — "would a render at the FASTER cadence actually have been seen?" — and settles at roughly
 * one render per visit instead.
 */
export function visitedInEachWindow(url, windowMs, count, nowMs = Date.now()) {
	for (let w = 0; w < count; w++) {
		const end = nowMs - w * windowMs;
		if (!visitedWithin(url, windowMs, end)) return false;
	}
	return true;
}

/**
 * Fill factor (set-bit fraction) of the newest slot in the union — the sizing early warning
 * surfaced in the demand-ladder histogram log. A k-hash probe false-positives at ~fill^k, and
 * false positives promote pages nobody visited. Read once per histogram interval, never on
 * the serve path.
 */
export function newestFill() {
	let newest = -Infinity;
	for (const s of merged.keys()) if (s > newest) newest = s;
	const bytes = merged.get(newest);
	return bytes?.length ? fillOf(bytes) : 0;
}

/** Test seam: drop all in-memory state (both sides). */
export function resetVisitFilter() {
	slices = new Map();
	dirty.clear();
	pendingWrite.clear();
	slot = null;
	slotEndMs = 0;
	merged = new Map();
	mergedAt = 0;
	unionStats = EMPTY_STATS;
	historyStartMs = 0;
	armedShape = shapeOf();
	refreshing = null;
	if (flushTimer) clearInterval(flushTimer);
	flushTimer = null;
	armedFlushInterval = null;
}
