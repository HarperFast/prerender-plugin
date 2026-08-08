/**
 * Visit filter — "was this URL visited by a bot in the last N hours?", as a ring of Bloom
 * slices. The demand ladder (util/demandLadder.js) reads it to decide whether a target's
 * render cadence should move up or down; nothing else depends on it.
 *
 * WHY A BLOOM FILTER AND NOT A `lastVisitedAt` COLUMN. The obvious design is a timestamp on
 * Target, which the reschedule path already reads for free. It does not survive the traffic
 * this exists for. A per-URL write dedupes only within a flush window, so at the ~10M
 * bot-requests/day the search-engine ramp is sized for, writes land at roughly the distinct-
 * URL rate — order 100/s against a REPLICATED table whose patch path has already caused one
 * replication incident. A Bloom ring writes ONE merged row per node per flush (~0.02/s) and
 * costs constant memory regardless of request volume. The price is that it cannot enumerate
 * its members (see "no enumeration" below) and answers with false positives.
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

import { config, onConfigApplied } from '../config.js';
import { getMutex } from './coordination.js';
import { fnv1a32 } from './hash.js';

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
const dirty = new Set();
let slot = null; // the ring slot the clock is currently in
let slotEndMs = 0; // rollover boundary, so the hot path compares one number
let flushTimer = null;
let armedFlushInterval = null;
const scratch = new Int32Array(32); // reused index buffer; k is bounded well below 32

const sliceMs = () => config.render.demand.sliceMs;
const sliceCount = () => config.render.demand.slices;
const bitCount = () => config.render.demand.bitsPerSlice;
const hashes = () => Math.min(config.render.demand.hashes, scratch.length);

/** Ring slot for a wall-clock time. Monotonic, so slot order is comparable modulo the ring. */
export const slotOf = (ms) => Math.floor(ms / sliceMs());

const newSlice = () => new Uint8Array(bitCount() >>> 3);

/**
 * Observe one bot visit. Called on the serving path; synchronous by design.
 * `url` is the device-free public URL (the Target primary key), NOT the cacheKey — cadence
 * resolves per URL, and dropping the device split halves the distinct count the filter holds.
 */
export function recordVisit(url) {
	if (!config.render.demand.enabled) return;

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
	// Drop slices that have aged out of the ring; their rows expire server-side via sweep.
	const oldest = slot - sliceCount();
	for (const s of slices.keys()) if (s <= oldest) slices.delete(s);
}

const armFlushTimer = () => {
	armedFlushInterval = config.render.demand.flushInterval;
	flushTimer = setInterval(() => flushSlices().catch((e) => logger.error(e)), armedFlushInterval);
	flushTimer.unref?.();
};

onConfigApplied(() => {
	if (!flushTimer) return;
	if (!config.render.demand.enabled) {
		clearInterval(flushTimer);
		flushTimer = null;
		armedFlushInterval = null;
		flushSlices().catch((e) => logger.error(e)); // persist rather than discard
		return;
	}
	if (config.render.demand.flushInterval !== armedFlushInterval) {
		clearInterval(flushTimer);
		armFlushTimer();
	}
});

/** Persist this thread's dirty slices into this node's rows. Exported for tests. */
export async function flushSlices() {
	if (!dirty.size) return;
	const slots = [...dirty];
	dirty.clear();
	try {
		await persist(slots);
	} catch (e) {
		// Slices are cumulative and OR-merging is idempotent, so replaying the whole flush is
		// safe — re-mark rather than wait for new traffic to notice.
		for (const s of slots) dirty.add(s);
		throw e;
	}
}

async function persist(slots) {
	const VisitFilter = table();
	const node = server.hostname;
	for (const s of slots) {
		const mine = slices.get(s);
		if (!mine) continue;
		const id = `${s}|${node}`;
		// Read-merge-write of this node's own row (node is in the key, so the read is local
		// and cannot take a cross-node fetch), serialized against sibling workers by the
		// cross-worker mutex. Same discipline as crawlStats.persist.
		const mutex = getMutex(`visitfilter:${id}`);
		const release = await mutex.lock();
		try {
			const existing = await VisitFilter.get(id);
			const merged = existing?.bits ? new Uint8Array(existing.bits) : newSlice();
			if (merged.length !== mine.length) {
				// bitsPerSlice changed under us; the old row is a different shape. Start clean
				// rather than merging garbage — one slice of undercount, self-heals next slot.
				await VisitFilter.put(id, { slot: s, node, bits: Buffer.from(mine), updatedAt: Date.now() });
				continue;
			}
			for (let i = 0; i < merged.length; i++) merged[i] |= mine[i];
			await VisitFilter.put(id, { slot: s, node, bits: Buffer.from(merged), updatedAt: Date.now() });
		} finally {
			release();
		}
	}
}

// ---------------------------------------------------------------------------- read side

let merged = new Map(); // slot -> Uint8Array unioned across nodes
let mergedAt = 0;
let refreshing = null;

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
	for await (const row of VisitFilter.search({
		conditions: [{ attribute: 'slot', comparator: 'greater_than_equal', value: oldest }],
		select: ['slot', 'bits'],
	})) {
		if (!row?.bits) continue;
		const cur = next.get(row.slot);
		const bits = new Uint8Array(row.bits);
		if (!cur) next.set(row.slot, bits);
		else if (cur.length === bits.length) for (let i = 0; i < cur.length; i++) cur[i] |= bits[i];
	}
	merged = next;
	mergedAt = nowMs;
	return merged;
}

/** True once the read-side union is warm enough to answer. */
export const mergedReady = () => mergedAt > 0;

/**
 * Kick the background refresh without asking a membership question.
 *
 * Load-bearing for cold start: the ladder refuses to decide while the union is cold (a cold
 * union reads as "nothing was visited anywhere", which would demote the whole corpus on the
 * first pass after a restart). But the refresh is normally driven lazily from `visitedWithin`,
 * which that same refusal skips — so without this the filter would never warm and the ladder
 * would stay disabled forever.
 */
export const ensureMerged = (nowMs = Date.now()) => maybeRefresh(nowMs);

const maybeRefresh = (nowMs) => {
	if (nowMs - mergedAt < config.render.demand.mergeInterval || refreshing) return;
	refreshing = refreshMerged(nowMs)
		.catch((e) => logger.error(e))
		.finally(() => {
			refreshing = null;
		});
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
	const span = Math.max(1, Math.ceil(windowMs / sliceMs()));
	const idx = bitsFor(url, bitCount(), k, scratch);
	for (let s = newest; s > newest - span; s--) {
		const bytes = merged.get(s);
		if (bytes && bytes.length === bitCount() >>> 3 && hasBits(bytes, idx, k)) return true;
	}
	return false;
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

/** Test seam: drop all in-memory state (both sides). */
export function resetVisitFilter() {
	slices = new Map();
	dirty.clear();
	slot = null;
	slotEndMs = 0;
	merged = new Map();
	mergedAt = 0;
	if (flushTimer) clearInterval(flushTimer);
	flushTimer = null;
	armedFlushInterval = null;
}
