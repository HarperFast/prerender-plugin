import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadyQueue, readyBufferBytes, readyCapacityIn, READY_KEY_BYTES } from '../src/util/readyQueue.js';
import { scoreOf } from '../src/util/renderPriority.js';

/**
 * The ready set and the scoring policy, against a plain ArrayBuffer with no Harper at all.
 *
 * What is pinned here, and why each one is a bug nothing else would catch:
 *
 *   - A KEY IS NEVER TRUNCATED, AND ANY LENGTH FITS. Keys are packed end to end, so a long key needs
 *     no slot of its own size; a generation whose keys outrun the region ends at the last that fit. A
 *     truncated cache key would name a DIFFERENT row, so a lease would be granted on the wrong page.
 *   - THE CURSOR HANDS EACH INDEX OUT ONCE. It is the entire concurrency story — two workers claiming
 *     concurrently must never receive the same entry, and there is no lock to fall back on.
 *   - ...AND IT CANNOT RUN AWAY. It is an Int32 incremented on every claim including exhausted ones;
 *     unbounded, it wraps in about eight days of idling and starts handing out valid indices again.
 *   - A READER NEVER SEES A HALF-WRITTEN SET. `publish` writes the inactive slot and flips, and the
 *     cursor must reset BEFORE the flip or a claim landing between the two skips the head of a fresh
 *     generation.
 *   - LATENESS, NOT AGE. A 7-day suppression recheck must not outrank a genuinely late page.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = 1_700_000_400_000;

const queueOf = (capacity, now = () => T0) =>
	createReadyQueue({ buffer: new ArrayBuffer(readyBufferBytes(capacity)), capacity, now });

const row = (cacheKey, score, dueAt = T0 - HOUR) => ({ entry: { cacheKey, dueAt }, score });

// ---- scoring -----------------------------------------------------------------------------------

test('a page late by one of its own cadences scores 1, whatever the cadence is', () => {
	assert.equal(scoreOf({ dueAt: T0 - HOUR }, { nowMs: T0, intervalMs: HOUR }), 1);
	assert.equal(scoreOf({ dueAt: T0 - 48 * HOUR }, { nowMs: T0, intervalMs: 48 * HOUR }), 1);
});

test('the documented inversion: a 1h page 2h late outranks a 48h page 3h late', () => {
	const home = scoreOf({ dueAt: T0 - 2 * HOUR }, { nowMs: T0, intervalMs: HOUR });
	const pdp = scoreOf({ dueAt: T0 - 3 * HOUR }, { nowMs: T0, intervalMs: 48 * HOUR });
	// Absolute due time says the PDP (3h > 2h). Relative lateness says the homepage, by ~32x.
	assert.equal(home, 2);
	assert.ok(home > pdp);
});

test('LATENESS, NOT AGE: a 7-day suppression recheck coming due does not outrank a late page', () => {
	// The row `Target.suppress` wrote: due now, scheduled 7 days ago, scored against a 48h cadence.
	// Under an age-based formula this reads as 3.5 cadences stale and wins.
	const recheck = scoreOf({ dueAt: T0 }, { nowMs: T0, intervalMs: 48 * HOUR });
	const late = scoreOf({ dueAt: T0 - 6 * HOUR }, { nowMs: T0, intervalMs: 48 * HOUR });
	assert.equal(recheck, 0);
	assert.ok(late > recheck);
});

test('the sitemap boost is a multiplier, so a far-behind discovered row still wins', () => {
	const listed = scoreOf({ dueAt: T0 - HOUR, fromSitemap: true }, { nowMs: T0, intervalMs: HOUR, sitemapBoost: 2 });
	const discovered = scoreOf({ dueAt: T0 - 3 * HOUR }, { nowMs: T0, intervalMs: HOUR, sitemapBoost: 2 });
	assert.equal(listed, 2);
	assert.equal(discovered, 3);
	assert.ok(discovered > listed, 'a multiplier cannot become a starvation lane');
});

test('a zero or negative interval degrades to raw lateness rather than Infinity or a sign flip', () => {
	assert.equal(scoreOf({ dueAt: T0 - 5 }, { nowMs: T0, intervalMs: 0 }), 5);
	assert.equal(scoreOf({ dueAt: T0 - 5 }, { nowMs: T0, intervalMs: -HOUR }), 5);
});

test('an ABSENT due time scores 0, not the epoch — it must not sort to the head', () => {
	// `nowMs - null` is `nowMs`, so the naive form gives a lateness of ~1.8e12 and a broken row wins
	// the next lease outright. This is the trap that actually bites; the interval's `> 0` guard already
	// closes the divisor half.
	for (const dueAt of [null, undefined, Number.NaN, 'x']) {
		assert.equal(scoreOf({ dueAt }, { nowMs: T0, intervalMs: HOUR }), 0, `dueAt=${dueAt}`);
	}
	// ...and a genuinely late row still scores, so the guard has not swallowed the real case.
	assert.equal(scoreOf({ dueAt: T0 - HOUR }, { nowMs: T0, intervalMs: HOUR }), 1);
});

test('a numeric-string interval still divides — the guard is a comparison, not a typeof check', () => {
	assert.equal(scoreOf({ dueAt: T0 - HOUR }, { nowMs: T0, intervalMs: String(HOUR) }), 1);
});

test('a row scored at or before its due moment is 0, never negative', () => {
	assert.equal(scoreOf({ dueAt: T0 }, { nowMs: T0, intervalMs: HOUR }), 0);
	assert.equal(scoreOf({ dueAt: T0 + HOUR }, { nowMs: T0, intervalMs: HOUR }), 0);
});

// ---- top-K -------------------------------------------------------------------------------------

// ---- the shared set ---------------------------------------------------------------------------

test('publish then take hands rows out in the order they were published', () => {
	const q = queueOf(8);
	assert.equal(q.publish([row('a|desktop', 3), row('b|desktop', 2), row('c|desktop', 1)]), 3);
	assert.deepEqual(
		q.take(2).map((e) => e.cacheKey),
		['a|desktop', 'b|desktop']
	);
	assert.deepEqual(
		q.take(2).map((e) => e.cacheKey),
		['c|desktop'],
		'a partial take is the signal that the set is exhausted'
	);
	assert.deepEqual(q.take(1), [], 'and it stays exhausted until the next publish');
});

test('THE CURSOR HANDS EACH INDEX OUT ONCE, across interleaved consumers', () => {
	const q = queueOf(64);
	q.publish(Array.from({ length: 50 }, (_, i) => row(`k${i}|desktop`, 50 - i)));
	// Two "workers" interleaved over the same buffer — which is what the atomic cursor is for.
	const a = [];
	const b = [];
	for (let i = 0; i < 25; i++) {
		a.push(...q.take(1));
		b.push(...q.take(1));
	}
	const all = [...a, ...b].map((e) => e.cacheKey);
	assert.equal(all.length, 50);
	assert.equal(new Set(all).size, 50, 'no entry may be handed to two consumers');
});

test('the cursor CANNOT RUN AWAY past the count while the set is exhausted', () => {
	const q = queueOf(4);
	q.publish([row('a|desktop', 1)]);
	q.take(1);
	for (let i = 0; i < 10_000; i++) q.take(5);
	// Unbounded, this is an Int32 incremented on every claim: it would wrap in about eight days of
	// idling and start handing out valid indices again.
	assert.equal(q.state().consumed, 1);
	assert.equal(q.state().remaining, 0);
});

test('a fresh publish resets consumption, and a reader never sees a half-written set', () => {
	const q = queueOf(8);
	q.publish([row('old-1|desktop', 5), row('old-2|desktop', 4)]);
	q.take(1);
	assert.equal(q.state().remaining, 1);

	q.publish([row('new-1|desktop', 9), row('new-2|desktop', 8), row('new-3|desktop', 7)]);
	const state = q.state();
	assert.equal(state.count, 3);
	assert.equal(state.consumed, 0, 'the cursor must reset with the generation');
	assert.equal(state.generation, 2);
	assert.deepEqual(
		q.take(3).map((e) => e.cacheKey),
		['new-1|desktop', 'new-2|desktop', 'new-3|desktop']
	);
});

test('publishing alternates slots, so the set being read is never the set being written', () => {
	const q = queueOf(4);
	q.publish([row('gen1|desktop', 1)]);
	const first = q.peek(1)[0].cacheKey;
	q.publish([row('gen2|desktop', 1)]);
	const second = q.peek(1)[0].cacheKey;
	q.publish([row('gen3|desktop', 1)]);
	assert.equal(first, 'gen1|desktop');
	assert.equal(second, 'gen2|desktop');
	assert.equal(q.peek(1)[0].cacheKey, 'gen3|desktop');
});

test('A KEY LONGER THAN ITS BUDGET FITS: keys are packed, so only the total is bounded', () => {
	const q = queueOf(4);
	const long = `https://www.example.com/${'x'.repeat(2 * READY_KEY_BYTES)}|desktop`;
	assert.equal(q.publish([row(long, 9), row('short|desktop', 5)]), 2);
	assert.deepEqual(
		q.take(2).map((e) => e.cacheKey),
		[long, 'short|desktop']
	);
});

test('A KEY IS NEVER TRUNCATED: a generation whose keys outrun the region ends at the last that fit', () => {
	// Ending, not skipping: skipping would publish lower-priority rows ahead of the one that did not
	// fit, and a truncated key names a different row.
	const q = queueOf(2);
	const huge = `https://www.example.com/${'x'.repeat(2 * READY_KEY_BYTES)}|desktop`;
	const stored = q.publish([row('first|desktop', 9), row(huge, 8), row('last|desktop', 7)]);
	assert.equal(stored, 1);
	assert.deepEqual(
		q.take(3).map((e) => e.cacheKey),
		['first|desktop']
	);
});

test('a multi-byte key round-trips by BYTES, not characters', () => {
	const q = queueOf(4);
	const key = 'https://www.example.com/café-über/日本|mobile';
	q.publish([row(key, 1)]);
	assert.equal(q.take(1)[0].cacheKey, key);
});

test('publishing more than capacity keeps the head, which is the best of the set', () => {
	const q = queueOf(3);
	const stored = q.publish(Array.from({ length: 10 }, (_, i) => row(`k${i}|desktop`, 10 - i)));
	assert.equal(stored, 3);
	assert.deepEqual(
		q.take(5).map((e) => e.cacheKey),
		['k0|desktop', 'k1|desktop', 'k2|desktop']
	);
});

test('a zero-capacity buffer degrades to empty rather than corrupting memory', () => {
	const q = createReadyQueue({ buffer: new ArrayBuffer(readyBufferBytes(1)), capacity: 0 });
	assert.equal(q.capacity, 1, 'capacity is derived from the buffer when the argument is unusable');
	const tiny = createReadyQueue({ buffer: new ArrayBuffer(32), capacity: 100 });
	assert.equal(tiny.capacity, 0);
	assert.equal(tiny.publish([row('a|desktop', 1)]), 0);
	assert.deepEqual(tiny.take(5), []);
});

test('capacity is clamped to the buffer, never trusted from the argument', () => {
	const buffer = new ArrayBuffer(readyBufferBytes(4));
	const q = createReadyQueue({ buffer, capacity: 10_000 });
	assert.equal(q.capacity, readyCapacityIn(buffer.byteLength));
	assert.ok(q.capacity <= 4);
});

test('state reports age and the due count published with it, with no database work', () => {
	let clock = T0;
	const q = queueOf(8, () => clock);
	assert.equal(q.state().sweptAt, null, 'never published reads as null, not as the epoch');
	q.publish([row('a|desktop', 1)], { scannedRows: 200_000 });
	clock = T0 + 90_000;
	const state = q.state();
	assert.equal(state.scannedRows, 200_000);
	assert.equal(state.ageMs, 90_000);
	assert.equal(state.sweptAt, T0);
});

test('score survives the round trip, so what is reported is what it was ordered by', () => {
	const q = queueOf(4);
	q.publish([row('a|desktop', 2.5), row('b|desktop', 0.125)]);
	const taken = q.take(2);
	assert.equal(taken[0].score, 2.5);
	assert.equal(taken[1].score, 0.125);
});

test('an absurd score is clamped rather than overflowing the Int32 it is stored in', () => {
	const q = queueOf(4);
	q.publish([row('a|desktop', 1e12)]);
	const [entry] = q.take(1);
	assert.ok(Number.isFinite(entry.score) && entry.score > 0, `got ${entry.score}`);
});
