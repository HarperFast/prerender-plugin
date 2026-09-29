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
 * Workers now set their bits in one node-shared slice and exactly one of them stores it per
 * interval (`claimTurn`), which is the same stored state for 1/N of the log volume.
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
 * SHAPE (v0.95.1). ONE COPY PER NODE of everything, in shared memory:
 *
 *   - WRITE: every worker sets its visits' bits straight into the node-shared LIVE slice for the
 *     current slot (`live`), and one worker per `flushInterval` — whoever claims the turn — stores
 *     every slot whose bits moved since its last store to this node's row (`slot|node`). Rows
 *     replicate, so any node can answer.
 *   - READ: one node-shared UNION per slot (`union`), the OR of every node's stored rows, kept by
 *     one worker per `mergeInterval` and refreshed INCREMENTALLY: it projects the ring's rows to their
 *     versions (`updatedAt`) and fetches and merges the bits only of rows that changed — in steady
 *     traffic, the current slot's row from each node. (Whether the projection spares the storage
 *     read of each row's value is up to the store; what it certainly spares is the decode and the
 *     merge, and it happens once per node rather than once per worker.)
 *
 * Before v0.95.1 every worker kept its own copy of both: thread-local write slices merged into the
 * shared one at each flush, and a full union rebuilt from every row of the ring each merge interval.
 * At 16 workers that was 16 copies of the ring in memory and 16 full re-reads per interval — the
 * cost that scaled with `bitsPerSlice` and made a larger, less saturated ring expensive. Writing
 * straight into shared memory also removes the question of which worker still owes a store: the
 * bits are the node's the moment they are set.
 *
 * Hot-path cost (recordVisit): one number compare for slot rollover, two fnv1a32 hashes, k byte
 * reads, and an atomic OR only for a bit not already set (a repeat visit writes nothing). No
 * allocation, no await, no storage touch.
 */

import { setImmediate } from 'node:timers/promises';
import { config, onConfigApplied } from '../config.js';
import { getMutex, getSab, releaseSabs } from './coordination.js';
import { runDetached } from './detach.js';
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

/**
 * Set `url`'s bits in a slice other workers are setting too. `Atomics.or`, never `|=`: a plain
 * read-modify-write can drop a sibling's bit in the same byte, and a dropped bit is a false NEGATIVE,
 * the one error direction this filter must not make. A bit already set is only read, so a repeat
 * visit costs no atomic write. Returns whether any bit was newly set.
 */
const setSharedBits = (bytes, idx, k) => {
	let set = false;
	for (let i = 0; i < k; i++) {
		const at = idx[i] >>> 3;
		const mask = 1 << (idx[i] & 7);
		if (!(bytes[at] & mask)) {
			Atomics.or(bytes, at, mask);
			set = true;
		}
	}
	return set;
};

const hasBits = (bytes, idx, k) => {
	for (let i = 0; i < k; i++) if (!(bytes[idx[i] >>> 3] & (1 << (idx[i] & 7)))) return false;
	return true;
};

// ---------------------------------------------------------------------------- write side

let slot = null; // the ring slot the clock is currently in
let slotEndMs = 0; // rollover boundary, so the hot path compares one number
let liveNow = null; // this worker's view of the current slot's live slice (and its generation)
const liveHeld = new Set(); // slots whose live slice this worker holds (see `rollover`)
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

// ── THE NODE'S SHARED STATE ─────────────────────────────────────────────────────────────────
//
// Every key carries the SHAPE (see `shapeOf`) and, per slot, the ABSOLUTE slot number — never a ring
// position. A ring-position key would have to be zeroed on wrap, and zeroing a buffer other workers may
// be setting bits in is exactly the race that loses bits. Absolute keys are written for one slot's life
// and released when it leaves the ring (`ageOut`). coordination.js holds every buffer it hands out: on
// Harper 5.2 an unreferenced shared buffer is freed and re-fetched as zeros.
//
// ITS OWN NAMESPACE, `visitRing/`. v0.95.0 kept `visitFilter/{bits,gen,turn}/…` at other sizes, and a
// shared buffer keeps the size of its FIRST allocation for as long as any worker holds it — so a worker
// on this layout loaded beside one on the old (a worker restart inside a running process) would get the
// old size back and throw on every store.
//
//   live/<slot>   this node's bits for the slot, set by every worker
//   gen/<slot>    Int32 [set, stored]: `set` counts changes to the live slice, `stored` is the `set`
//                 value the last store read before copying it
//   union/<slot>  the OR of every node's stored row for the slot
//   ctl           Int32 [writeTurn, refreshTurn]  — the two one-worker-per-interval turns
//   stats         Float64 [mergedAt, newestFill, worstFill, worstFalsePositive, firstSlot + 1]
const RING = 'visitRing';
const bytesOf = (shape) => Number(shape.split('|')[1]) >>> 3;
const liveSlice = (s, shape = shapeOf()) => new Uint8Array(getSab(`${RING}/live/${shape}/${s}`, bytesOf(shape)));
const generationOf = (s, shape = shapeOf()) => new Int32Array(getSab(`${RING}/gen/${shape}/${s}`, 8));
const unionSlice = (s, shape = shapeOf()) => new Uint8Array(getSab(`${RING}/union/${shape}/${s}`, bytesOf(shape)));
const control = (shape = shapeOf()) => new Int32Array(getSab(`${RING}/ctl/${shape}`, 8));
const STATS_MERGED_AT = 0;
const STATS_NEWEST_FILL = 1;
const STATS_WORST_FILL = 2;
const STATS_WORST_FP = 3;
// The first slot any node stored a row of THIS shape for, plus one (0 = none yet). Counted only from
// rows of the right length: a restart with a new `bitsPerSlice` leaves old-shape rows in the ring, and
// counting them made a tracker with an hour of history answer as if it had eleven.
const STATS_FIRST_SLOT = 4;
// Read by the ladder's log line and readiness check, which also run where no store exists (early boot,
// unit tests of the ladder alone): there the answer is "never refreshed", all zeros.
const NO_STATS = new Float64Array(5);
const stats = (shape = shapeOf()) => {
	try {
		return new Float64Array(getSab(`${RING}/stats/${shape}`, 40));
	} catch {
		return NO_STATS;
	}
};
const firstSlotOf = (shared) => (shared[STATS_FIRST_SLOT] > 0 ? shared[STATS_FIRST_SLOT] - 1 : Infinity);

/**
 * Observe one bot visit. Called on the serving path; synchronous by design.
 * `url` is the device-free public URL (the Target primary key), NOT the cacheKey — cadence
 * resolves per URL, and dropping the device split halves the distinct count the filter holds.
 */
export function recordVisit(url) {
	if (!config.demand.enabled) return;

	const now = Date.now();
	if (now >= slotEndMs) rollover(now);

	if (!liveNow) {
		liveNow = { bytes: liveSlice(slot), generation: generationOf(slot) };
		liveHeld.add(slot);
	}
	if (setSharedBits(liveNow.bytes, bitsFor(url, bitCount(), hashes(), scratch), hashes())) {
		// AFTER the bits: a store that reads `set` and then copies the slice either sees this change's
		// count and its bits, or not the count — and then stores again next interval.
		Atomics.add(liveNow.generation, 0, 1);
	}

	if (!flushTimer) armFlushTimer();
}

function rollover(now) {
	slot = slotOf(now);
	slotEndMs = (slot + 1) * sliceMs();
	liveNow = null;
	ageOut(now);
}

/**
 * Let go of what has aged out of the ring — from EVERY entry point, not only a recorded visit: a worker
 * that answers questions or refreshes the union but never records one (a node the counted bots do not
 * reach) would otherwise hold a union slice per elapsed slot for the life of the process. Once per slot
 * per worker; one worker per node also sweeps the aged rows (bounded, off the hot path).
 */
let agedAt = null;
function ageOut(nowMs) {
	const current = slotOf(nowMs);
	if (current === agedAt) return;
	agedAt = current;
	const shape = shapeOf();
	const oldest = current - sliceCount();
	const ours = `${RING}/`;
	releaseSabs((key) => {
		if (!key.startsWith(ours) || !key.includes(`/${shape}/`)) return false;
		const kind = key.slice(ours.length, key.indexOf('/', ours.length));
		const slotOfKey = Number(key.slice(key.lastIndexOf('/') + 1));
		return (kind === 'live' || kind === 'gen' || kind === 'union') && Number.isFinite(slotOfKey) && slotOfKey <= oldest;
	});
	for (const [id, seen] of seenVersions) if (seen.slot <= oldest) seenVersions.delete(id);
	// A LIVE slice is only needed until it is stored: nothing sets bits in a slot once it has ended
	// (every worker rolls over before its next visit), and after its last store the row carries it.
	// So this worker lets go of a live slice two slots back once `stored` has caught up with `set` —
	// never before, or an unstored slice would be freed with its bits. Keeps the node at about two live
	// slices instead of the whole ring.
	for (const s of liveHeld) {
		if (s >= current - 1) continue;
		if (s > oldest) {
			const generation = generationOf(s, shape);
			if (Atomics.load(generation, 1) < Atomics.load(generation, 0)) continue;
		}
		const key = `${RING}/live/${shape}/${s}`;
		releaseSabs((k) => k === key);
		liveHeld.delete(s);
	}
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
	// Every worker ticks; only the interval's winner stores (`claimTurn`). The dedup lives here
	// rather than inside `flushSlices` so that explicit calls (the disable path below, tests) always
	// persist.
	// Armed OUTSIDE whatever request recorded the first visit (util/detach.js): an interval created
	// inside a request runs every tick in that request's long-closed context.
	flushTimer = runDetached(() =>
		setInterval(
			() => flushSlices({ write: claimTurn(0, config.demand.flushInterval) }).catch((e) => logger.error(e)),
			armedFlushInterval
		)
	);
	flushTimer.unref?.();
};

// ------------------------------------------------------- one worker per node per interval
//
// The row is `bitsPerSlice / 8` bytes and it replicates, so every worker storing it every interval put
// N times one row's worth of state into the replicated transaction log — measured at 1.2 GB of logs
// behind 18 MB of live data on a production node (#87). The same turn-taking picks the one worker that
// re-unions the ring for the node. Whoever first observes that a full interval has elapsed since the
// last turn claims it with a CAS.
//
// Seconds are stored relative to a fixed epoch, in Int32, for the same reason `renderLease` does
// it: raw epoch seconds leave Int32 in 2038, and the offset buys a lifetime either side.
const TURN_EPOCH_SEC = 1_700_000_000;
const nowTurnSec = (nowMs = Date.now()) => Math.floor(nowMs / 1000) - TURN_EPOCH_SEC;

const claimTurn = (which, intervalMs, nowMs = Date.now()) => {
	const intervalSec = Math.max(1, Math.round(intervalMs / 1000));
	const now = nowTurnSec(nowMs);
	const turn = control();
	const last = Atomics.load(turn, which);
	const elapsed = now - last;
	// Only a turn taken in the PAST, within the interval, blocks this one. A bare
	// `elapsed < intervalSec` would also match a NEGATIVE elapsed — a clock stepped backwards
	// (NTP correction, VM migration) leaves `last` in the future, and the turn would then be
	// wedged shut until the clock caught up. Requiring `elapsed >= 0` to block makes a backward
	// step reclaim the turn on the next tick and re-anchor `last` to the corrected clock.
	if (last !== 0 && elapsed >= 0 && elapsed < intervalSec) return false;
	return Atomics.compareExchange(turn, which, last, now) === last;
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
		// The old shape's buffers are never read or written again (every key carries the shape).
		const oldShape = armedShape;
		releaseSabs((key) => key.startsWith(`${RING}/`) && key.split('/').includes(oldShape));
		armedShape = shapeOf();
		// Drop this worker's views and the row versions it has seen, then record when the NEW-shape
		// history began: engaging against a near-empty union reads as "nobody visited anything", the
		// error direction this module must not produce, so each consumer holds until the history it
		// needs exists (the ladder: its slowest rung; `visitedSlots`: it counts only the slots since).
		// (Persisted old-shape rows age out via sweepExpired; a sliceMs increase leaves them at
		// impossible-future slot numbers, which the sweep also deletes.)
		slot = null;
		slotEndMs = 0;
		liveNow = null;
		liveHeld.clear();
		seenVersions.clear();
		refreshing = null;
		agedAt = null;
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
 * Store every ring slot whose live slice changed since its last store — when `write` is set, which
 * the timer sets only for the worker holding the interval's turn. Exported for tests.
 *
 * No worker owes anything: the bits are in the node-shared slice the moment they are set, so whichever
 * worker holds the turn stores them all. A store records the change count it read BEFORE copying the
 * slice (`stored`), so a change made during a store is stored by the next. Each slot is stored on its
 * own: one that fails is retried next interval and never holds back the others.
 */
export async function flushSlices({ write = true, nowMs = Date.now() } = {}) {
	if (!write) return;
	ageOut(nowMs);
	const shape = shapeOf();
	const newest = slotOf(nowMs);
	for (let s = newest - sliceCount() + 1; s <= newest; s++) {
		const generation = generationOf(s, shape);
		if (!(Atomics.load(generation, 0) > Atomics.load(generation, 1))) continue;
		try {
			await persist(s, generation, shape);
		} catch (e) {
			logger.error(e, `[prerender] visit ring: storing slot ${s} failed; retried next interval`);
		}
	}
}

async function persist(s, generation, shape) {
	const VisitFilter = table();
	const node = server.hostname;
	const id = `${s}|${node}`;
	// Every change up to this count is in the slice copied below (changes after it may be too —
	// storing a bit twice is harmless, missing one is not).
	const covered = Atomics.load(generation, 0);
	const live = liveSlice(s, shape);
	liveHeld.add(s);
	// READ-MERGE-WRITE of this node's own row (node is in the key, so the read is local), serialized by
	// the cross-worker mutex. The row can hold bits this process's live slice does not: everything stored
	// before a restart, and whatever a worker still on an older layout stored during a rolling upgrade
	// (it writes the same row). A blind overwrite would drop them — a false negative. One local row read
	// per store is the whole cost.
	const mutex = getMutex(`visitFilter/${s}`);
	await mutex.lock();
	try {
		const bits = new Uint8Array(live); // a copy: the slice keeps moving under other workers
		const existing = await VisitFilter.get(id);
		if (existing?.bits && existing.bits.length === bits.length) {
			const stored = new Uint8Array(existing.bits);
			for (let i = 0; i < bits.length; i++) bits[i] |= stored[i];
		}
		await VisitFilter.put(id, { slot: s, node, bits: Buffer.from(bits.buffer), updatedAt: Date.now() });
	} finally {
		mutex.unlock();
	}
	markStored(generation, covered);
}

/** OR `from` into the shared `into`, word by word, skipping zero words (a sparse slice is mostly zeros). */
const orInto = (into, from) => {
	const target = new Int32Array(into.buffer, into.byteOffset, into.byteLength >>> 2);
	const source = new Int32Array(from.buffer, from.byteOffset, from.byteLength >>> 2);
	for (let i = 0; i < source.length; i++) {
		const w = source[i];
		if (w !== 0) Atomics.or(target, i, w);
	}
};

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

// Row versions this worker has already folded into the shared union: id -> { slot, version }. Local
// to the worker, and that is enough: the union is a monotone OR, so a worker that takes the refresh
// turn with an older view only re-folds rows another worker already folded — wasted reads, never
// a wrong answer.
const seenVersions = new Map();
let refreshing = null;

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

const epochOf = (value) => {
	if (value === null || value === undefined) return NaN;
	const ms = typeof value === 'bigint' ? Number(value) : new Date(value).getTime();
	return Number.isFinite(ms) ? ms : NaN;
};

/**
 * Bring the node's shared union up to date with every node's stored rows for the slots in the ring.
 * Called by the worker holding the refresh turn (`maybeRefresh`), and directly by tests.
 *
 * INCREMENTAL: it projects the ring's rows to their versions (id, slot, `updatedAt`) and fetches the
 * bits only of slots with a row this worker has not folded at that version. In steady traffic that
 * is the current slot, from each node; older slots stop changing once their slot ends. The union is a
 * monotone OR, so folding a row again is harmless and nothing ever needs clearing.
 *
 * It then measures what the sizing depends on — the set-bit fraction of each slot and the false-positive
 * rate that implies (`fill^k`) — and publishes it with the refresh time for every worker. The newest
 * slot is PARTIAL and still filling, so it is reported (`newestFill`, the sizing sawtooth) but kept out
 * of the worst case, which is taken over the FULL slots — the ones most of every level count is made of.
 */
export async function refreshMerged(nowMs = Date.now()) {
	ageOut(nowMs);
	const VisitFilter = table();
	// ONE SHAPE for the whole refresh: a reshape that lands mid-refresh must not fold old-shape rows into
	// the new shape's union, where they would stay for the ring's life (the union only ever gains bits).
	const shape = shapeOf();
	const expected = bytesOf(shape);
	const shared = stats(shape);
	const newest = slotOf(nowMs);
	const oldest = newest - sliceCount() + 1;
	const changedSlots = new Set();
	let scanned = 0;
	const versions = await VisitFilter.search({
		conditions: [{ attribute: 'slot', comparator: 'greater_than_equal', value: oldest }],
		select: ['id', 'slot', 'updatedAt'],
	});
	for await (const row of versions) {
		// Bounded at ring-length x nodes rows — but it runs on workers serving traffic, and awaiting a
		// cursor only drains microtasks (repo convention: yield by rows SCANNED, same as util/scan.js).
		if (++scanned % config.scan.yieldEvery === 0) await setImmediate();
		if (!row?.id || !(row.slot >= oldest && row.slot <= newest + 1)) continue;
		const version = epochOf(row.updatedAt);
		const seen = seenVersions.get(row.id);
		if (seen && seen.version === version && Number.isFinite(version)) continue;
		changedSlots.add(row.slot);
	}
	for (const s of changedSlots) {
		if (shapeOf() !== shape) return; // reshaped meanwhile: the new shape starts its own history
		const union = unionSlice(s, shape);
		const rows = await VisitFilter.search({
			conditions: [{ attribute: 'slot', comparator: 'equals', value: s }],
			select: ['id', 'slot', 'bits', 'updatedAt'],
		});
		for await (const row of rows) {
			if (row?.slot !== s || !row.bits) continue;
			const bits = new Uint8Array(row.bits);
			if (bits.length !== expected || shapeOf() !== shape) continue;
			orInto(union, bits);
			if (!(firstSlotOf(shared) <= s)) shared[STATS_FIRST_SLOT] = s + 1;
			seenVersions.set(row.id, { slot: s, version: epochOf(row.updatedAt) });
		}
		await setImmediate();
	}
	if (shapeOf() !== shape) return;

	let newestFill = 0;
	let worstFill = 0;
	let fullSlots = 0;
	const first = firstSlotOf(shared);
	for (let s = Math.max(oldest, first); s <= newest; s++) {
		const fill = fillOf(unionSlice(s, shape));
		if (s === newest) newestFill = fill;
		else {
			fullSlots++;
			if (fill > worstFill) worstFill = fill;
		}
	}
	// A ring with only its newest slot has no full slot to judge; the partial one is all there is.
	if (!fullSlots) worstFill = newestFill;
	const worstFalsePositive = worstFill ** Number(shape.split('|')[2]);
	shared[STATS_NEWEST_FILL] = newestFill;
	shared[STATS_WORST_FILL] = worstFill;
	shared[STATS_WORST_FP] = worstFalsePositive;
	shared[STATS_MERGED_AT] = nowMs; // last: a reader that sees the time sees the numbers it describes

	// The sizing signals, emitted where they are measured — once per node per refresh. `fill` is the
	// newest slot's (the sawtooth to read at its PEAK), `false_positive` the worst full slot's `fill^k`,
	// the number `demand.maxFalsePositive` is compared against. Guarded: losing a metric must never fail
	// a refresh.
	try {
		metrics.demand(newestFill, 'fill');
		metrics.demand(worstFalsePositive, 'false_positive');
	} catch {
		// metrics unavailable (tests, early boot)
	}
}

const mergedAtMs = () => stats()[STATS_MERGED_AT];

/**
 * True once the node's union holds a first refresh. Consumers decide for themselves how much
 * history they need on top (`historyFromMs`): the union may be populated but still blind to
 * everything recorded before a reshape.
 */
export const mergedWarm = () => mergedAtMs() > 0;

/**
 * When the current shape's history began — 0 unless the filter was reshaped since boot. Nothing
 * recorded before it is readable, so an empty slot from before it is NOT evidence of no visits.
 */
export const historyFromMs = () => historyStartMs;

/** The last refresh's sizing measurements: `{ newestFill, worstFill, worstFalsePositive }`. */
export const unionHealth = () => {
	const shared = stats();
	return {
		newestFill: shared[STATS_NEWEST_FILL],
		worstFill: shared[STATS_WORST_FILL],
		worstFalsePositive: shared[STATS_WORST_FP],
	};
};

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
 * Warm the union and WAIT for it: resolves once the union holds a refresh (at once when it already
 * does). For a caller about to ask many questions in a row — a probe pass — so the first few are not
 * answered by a cold union. If another worker holds the refresh turn, this waits for its refresh, up
 * to 10 s; a pass that starts anyway answers `cold` and stamps nothing, which is the safe side.
 */
export const awaitMerged = async (nowMs = Date.now()) => {
	const mine = maybeRefresh(nowMs);
	if (mine) return mine;
	for (let waited = 0; !mergedWarm() && waited < 10_000; waited += 100) {
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
};

const maybeRefresh = (nowMs) => {
	if (refreshing) return refreshing;
	if (nowMs - mergedAtMs() < config.demand.mergeInterval) return undefined;
	// One refresh per node per interval: the union is shared, so a second worker refreshing it would
	// only repeat the reads. A cold union (never refreshed) is claimed at once by whoever asks first.
	if (!claimTurn(1, config.demand.mergeInterval, nowMs) && mergedWarm()) return undefined;
	// Outside whatever request asked (util/detach.js): a render result's reschedule asks from inside the
	// result request's transaction, and the refresh's reads must not ride on it.
	refreshing = runDetached(() => refreshMerged(nowMs))
		.catch((e) => logger.error(e))
		.finally(() => {
			refreshing = null;
		});
	return refreshing;
};

/** The ring slots the union can answer for, oldest first — clipped to the first slot any node wrote. */
const readableFrom = (oldestWanted) => Math.max(oldestWanted, firstSlotOf(stats()));

const visitedIn = (idx, k, windowMs, nowMs) => {
	const newest = slotOf(nowMs);
	// Anchor on the slot containing the window's START, not on a slot count. The newest slot
	// is PARTIAL: `ceil(windowMs/sliceMs)` slots back from it cover as little as the elapsed
	// part of the current slot — a probe minutes into a slot at the 6h rung would examine
	// minutes of its 6h window, and the miss direction is a false NEGATIVE, the one error
	// this filter must not make (a genuinely visited page reading unvisited gets demoted).
	// Anchoring instead over-covers by up to one slice — the safe, documented direction.
	// Clamped to the ring so a window wider than the ring cannot walk absent slots, and to the first
	// slot any node wrote (an earlier one has nothing to answer with).
	const oldest = readableFrom(Math.max(slotOf(nowMs - windowMs), newest - sliceCount() + 1));
	for (let s = newest; s >= oldest; s--) if (hasBits(unionSlice(s), idx, k)) return true;
	return false;
};

/**
 * Was `url` visited at any point in the last `windowMs`? Tests the ring slices covering that
 * window; a slot with no row anywhere reads as "not visited", so a cold union answers false
 * rather than inventing traffic.
 */
export function visitedWithin(url, windowMs, nowMs = Date.now()) {
	ageOut(nowMs);
	maybeRefresh(nowMs);
	if (!mergedWarm()) return false;
	const k = hashes();
	return visitedIn(bitsFor(url, bitCount(), k, scratch), k, windowMs, nowMs);
}

/**
 * In how many ring slots was `url` visited? The demand LEVEL, 0..`covered`, over the slots the
 * union can answer for: the ring, newest (partial) slot included, clipped to the current shape's
 * history (`historyFromMs`) and to the oldest slot any node has written — a tracker switched on
 * yesterday has one day of slots, and an empty slot before its first row is not evidence of
 * nothing. `covered` is 0 while the union is cold. A read of the shared union; the refresh it may
 * kick is async and answers later questions.
 */
export function visitedSlots(url, nowMs = Date.now()) {
	ageOut(nowMs);
	maybeRefresh(nowMs);
	if (!mergedWarm()) return { level: 0, covered: 0 };
	const k = hashes();
	const newest = slotOf(nowMs);
	let oldest = newest - sliceCount() + 1;
	if (historyStartMs > 0) oldest = Math.max(oldest, slotOf(historyStartMs));
	oldest = readableFrom(oldest);
	if (oldest > newest) return { level: 0, covered: 0 };
	const idx = bitsFor(url, bitCount(), k, scratch);
	let level = 0;
	for (let s = oldest; s <= newest; s++) if (hasBits(unionSlice(s), idx, k)) level++;
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
 * one render per visit instead. The URL is hashed once for all the windows.
 */
export function visitedInEachWindow(url, windowMs, count, nowMs = Date.now()) {
	ageOut(nowMs);
	maybeRefresh(nowMs);
	if (!mergedWarm()) return false;
	const k = hashes();
	const idx = bitsFor(url, bitCount(), k, scratch);
	for (let w = 0; w < count; w++) {
		if (!visitedIn(idx, k, windowMs, nowMs - w * windowMs)) return false;
	}
	return true;
}

/**
 * Fill factor (set-bit fraction) of the newest slot in the union — the sizing early warning
 * surfaced in the demand-ladder histogram log. A k-hash probe false-positives at ~fill^k, and
 * false positives promote pages nobody visited. Measured at each refresh, never on the serve path.
 */
export const newestFill = () => stats()[STATS_NEWEST_FILL];

/** Test seam: drop this worker's in-memory state. The node-shared state lives in coordination.js. */
export function resetVisitFilter() {
	slot = null;
	slotEndMs = 0;
	liveNow = null;
	liveHeld.clear();
	agedAt = null;
	seenVersions.clear();
	historyStartMs = 0;
	armedShape = shapeOf();
	refreshing = null;
	if (flushTimer) clearInterval(flushTimer);
	flushTimer = null;
	armedFlushInterval = null;
}
