import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The node-local render-lease table and the claim floor, over a plain ArrayBuffer.
 *
 * `createLeaseTable` is a pure factory precisely so this file needs no Harper at all: the probe
 * protocol, the expiry boundary, the collision behaviour and every CAS rule on the floor are
 * exercised directly. What is pinned here is what makes the whole design safe:
 *
 *   - a fresh, all-zero buffer means "no leases and NO FLOOR", not "everything leased at the
 *     epoch and a floor of 1970" — the same class of trap as `new Date(null).getTime() === 0`;
 *   - two instances over the SAME buffer see each other, which is the only reason this is a
 *     coordination primitive rather than per-worker state;
 *   - a full table REFUSES to grant rather than corrupting a slot, because the caller must then
 *     not hand out the job;
 *   - a hash collision is safe in both directions (it reads as a phantom lease, which skips the
 *     row AND holds the floor back) and clears on expiry;
 *   - the floor is clamped on every read, lowered by CAS-MIN, and advanced by a CAS that is
 *     ABANDONED on conflict.
 */

import {
	LEASE_EPOCH_SEC,
	LEASE_HEADER_BYTES,
	LEASE_SLOT_BYTES,
	createLeaseTable,
	leaseBufferBytes,
} from '../src/util/renderLease.js';

const MINUTE = 60_000;
const SLOTS = 16;

/** A table over a fresh buffer with a clock the test drives. */
const harness = ({ slots = SLOTS, now = 1_700_000_000_000 } = {}) => {
	const buffer = new ArrayBuffer(leaseBufferBytes(slots));
	const clock = { now };
	const table = createLeaseTable({ buffer, slots, now: () => clock.now });
	return { buffer, clock, table, slots };
};

// ---- layout ----

test('the buffer layout is header + fixed-size slots', () => {
	assert.equal(LEASE_HEADER_BYTES, 16);
	assert.equal(LEASE_SLOT_BYTES, 16);
	assert.equal(leaseBufferBytes(4096), 16 + 16 * 4096);
	assert.equal(leaseBufferBytes(4096), 65_552, 'the documented 64KB sizing');
});

// ---- the all-zero buffer ----

test('a fresh all-zero buffer has no leases and NO floor (not a 1970 floor, not epoch leases)', () => {
	const { table } = harness();

	assert.equal(table.isLeased('https://www.example.com/a|desktop'), false);
	assert.equal(table.occupancy(), 0);
	assert.equal(table.rawFloorMinute(), 0);
	// 0 means "seek the absolute minimum". It must NOT be clamped into a real minute, or a fresh
	// worker would start life with a floor and strand everything older than the guard band.
	assert.equal(table.readFloorMinute(28_000_000, 5), 0);
	assert.deepEqual(table.scanLive(), { count: 0, oldestExpiresAtMs: null, oldestDueMinute: null });
	assert.deepEqual(table.readPassOutcome(), { sawDue: false, earliestNotYetDueMinute: 0 });
});

test('slot zero does not read as leased forever — the emptiness marker is hashLo, not the expiry', () => {
	// `expiresSec === 0` is a real point in time relative to LEASE_EPOCH_SEC, so if emptiness were
	// judged on the expiry every key hashing to an untouched slot would look leased (or, worse,
	// would look leased-at-the-epoch and be stolen). `hashLo === 0` is the marker instead.
	const { table } = harness();
	for (let i = 0; i < 200; i++) {
		assert.equal(table.isLeased(`https://www.example.com/${i}|desktop`), false);
	}
});

// ---- round trip + the expiry boundary ----

test('a granted lease round-trips, and the expiry boundary is exact', () => {
	const now = 1_700_000_000_000;
	const { table, clock } = harness({ now });
	const key = 'https://www.example.com/p|desktop';

	assert.equal(table.grant(key, { dueMinute: 100, leaseExpiryMs: now + 10 * MINUTE }), true);
	assert.equal(table.isLeased(key), true);
	assert.equal(table.occupancy(), 1);
	assert.deepEqual(table.leaseOf(key), { leaseExpiresAtMs: now + 10 * MINUTE, dueMinute: 100 });

	// One millisecond before expiry: still held.
	clock.now = now + 10 * MINUTE - 1;
	assert.equal(table.isLeased(key), true, 'expiry − 1ms is still leased');

	// AT the expiry: released. A lease that outlives its stated expiry would stall the claim floor
	// past the point the operator was told to expect.
	clock.now = now + 10 * MINUTE;
	assert.equal(table.isLeased(key), false, 'at expiry the lease is gone');
	assert.equal(table.leaseOf(key), null);

	clock.now = now + 60 * MINUTE;
	assert.equal(table.isLeased(key), false);
});

test('second-granularity rounding can only make a lease LONGER, never shorter', () => {
	// A lease that expires early is a duplicate render; a lease that expires 999ms late is nothing.
	const now = 1_700_000_000_000;
	const { table, clock } = harness({ now });
	const key = 'k|desktop';
	const leaseMs = 10 * MINUTE + 1; // deliberately not a whole second

	table.grant(key, { dueMinute: 1, leaseExpiryMs: now + leaseMs });
	assert.ok(table.leaseOf(key).leaseExpiresAtMs >= now + leaseMs, 'never rounded down');

	clock.now = now + leaseMs - 1;
	assert.equal(table.isLeased(key), true);
});

test('expiries relative to LEASE_EPOCH_SEC survive past 2038 (they are not raw Int32 epoch seconds)', () => {
	// Raw epoch seconds overflow an Int32 on 2038-01-19. The offset is what buys ±68 years.
	const now = Date.UTC(2039, 0, 1);
	const { table } = harness({ now });
	assert.ok(now / 1000 > 2 ** 31, 'precondition: raw epoch seconds would have overflowed');

	table.grant('future|desktop', { dueMinute: 7, leaseExpiryMs: now + 10 * MINUTE });
	assert.equal(table.isLeased('future|desktop'), true);
	assert.equal(table.leaseOf('future|desktop').leaseExpiresAtMs, now + 10 * MINUTE);
	assert.ok(LEASE_EPOCH_SEC > 0);
});

test('release is idempotent, keyed on the hash pair, and frees the slot', () => {
	const now = 1_700_000_000_000;
	const { table } = harness({ now });

	table.grant('a|desktop', { dueMinute: 1, leaseExpiryMs: now + MINUTE });
	assert.equal(table.release('a|desktop'), true);
	assert.equal(table.isLeased('a|desktop'), false);
	assert.equal(table.occupancy(), 0);
	assert.equal(table.release('a|desktop'), false, 'releasing twice is a no-op, not a corruption');
	assert.equal(table.release('never-granted|desktop'), false);
});

test('re-granting the same key reuses its slot instead of consuming a second one', () => {
	const now = 1_700_000_000_000;
	const { table } = harness({ now });
	table.grant('a|desktop', { dueMinute: 1, leaseExpiryMs: now + MINUTE });
	table.grant('a|desktop', { dueMinute: 2, leaseExpiryMs: now + 2 * MINUTE });
	assert.equal(table.occupancy(), 1);
	assert.deepEqual(table.leaseOf('a|desktop'), { leaseExpiresAtMs: now + 2 * MINUTE, dueMinute: 2 });
});

// ---- the property that makes it a coordination primitive ----

test('two instances over the SAME buffer see each other’s leases', () => {
	const now = 1_700_000_000_000;
	const buffer = new ArrayBuffer(leaseBufferBytes(SLOTS));
	const workerA = createLeaseTable({ buffer, slots: SLOTS, now: () => now });
	const workerB = createLeaseTable({ buffer, slots: SLOTS, now: () => now });

	workerA.grant('shared|desktop', { dueMinute: 42, leaseExpiryMs: now + MINUTE });

	assert.equal(workerB.isLeased('shared|desktop'), true, 'a lease taken on one worker must bind every worker');
	assert.equal(workerB.occupancy(), 1);
	workerB.lowerFloorTo(0);
	assert.equal(workerA.rawFloorMinute(), 0);
	assert.equal(workerB.release('shared|desktop'), true);
	assert.equal(workerA.isLeased('shared|desktop'), false);
});

// ---- capacity ----

test('a full probe window REFUSES to grant rather than corrupting an existing lease', () => {
	// The caller must then not emit the job: a granted-but-unrecorded job is a double render AND an
	// untracked hold on the claim floor.
	const now = 1_700_000_000_000;
	// One slot means the probe window is one slot: the second distinct key cannot be recorded.
	const { table } = harness({ slots: 1, now });

	assert.equal(table.grant('first|desktop', { dueMinute: 1, leaseExpiryMs: now + MINUTE }), true);
	assert.equal(table.grant('second|desktop', { dueMinute: 2, leaseExpiryMs: now + MINUTE }), false, 'table full');

	assert.equal(table.isLeased('first|desktop'), true, 'the existing lease survives the refusal intact');
	assert.deepEqual(table.leaseOf('first|desktop'), { leaseExpiresAtMs: now + MINUTE, dueMinute: 1 });
	assert.equal(table.isLeased('second|desktop'), false, 'and the refused key is not recorded');
	assert.equal(table.occupancy(), 1);
});

test('a released slot does not break a later key’s probe chain', () => {
	// Bounded probing with 0 as the emptiness marker would normally need tombstones; every read
	// walks the FULL window instead, so a hole in the middle cannot hide a key that probed past it.
	const now = 1_700_000_000_000;
	const { table } = harness({ slots: 4, now });
	const keys = ['a|desktop', 'b|desktop', 'c|desktop', 'd|desktop'];
	for (const [i, key] of keys.entries()) table.grant(key, { dueMinute: i, leaseExpiryMs: now + MINUTE });

	table.release(keys[1]);

	for (const key of [keys[0], keys[2], keys[3]]) {
		assert.equal(table.isLeased(key), true, `${key} must still be found past the hole`);
	}
});

// ---- collisions ----

test('a hash collision reads as a PHANTOM lease: the row is skipped and the floor held back, then it clears', () => {
	// The documented, deliberately conservative failure. 64 bits make it ~1.1e-13, but the
	// behaviour when it does happen has to be safe in BOTH directions, so it is pinned here with
	// the hash forced to collide (slots: 1 makes every key land on the same slot).
	const now = 1_700_000_000_000;
	const { table, clock } = harness({ slots: 1, now });

	table.grant('the-real-key|desktop', { dueMinute: 500, leaseExpiryMs: now + MINUTE });

	// (a) The colliding key reads as leased — the phantom.
	//     (Different hash words, same slot: the `hi` comparison keeps them distinct, so the
	//     collision surfaces as "no free slot" rather than as a shared lease.)
	assert.equal(table.grant('other-key|desktop', { dueMinute: 900, leaseExpiryMs: now + MINUTE }), false);
	// (b) The other key is NOT granted — the safe direction: skip the row this pass.
	assert.equal(table.isLeased('other-key|desktop'), false);
	// (c) The floor is held back at the real lease's position, not advanced past it.
	assert.equal(table.scanLive().oldestDueMinute, 500);

	// (d) On expiry the slot frees and the previously-blocked key is grantable.
	clock.now = now + MINUTE;
	assert.equal(table.grant('other-key|desktop', { dueMinute: 900, leaseExpiryMs: clock.now + MINUTE }), true);
	assert.equal(table.isLeased('other-key|desktop'), true);
});

// ---- scanLive ----

test('scanLive reports the oldest live lease and reconciles the occupancy gauge', () => {
	const now = 1_700_000_000_000;
	const { table, clock } = harness({ now });

	table.grant('old|desktop', { dueMinute: 10, leaseExpiryMs: now + MINUTE });
	table.grant('new|desktop', { dueMinute: 20, leaseExpiryMs: now + 5 * MINUTE });

	const live = table.scanLive();
	assert.equal(live.count, 2);
	assert.equal(live.oldestExpiresAtMs, now + MINUTE);
	assert.equal(live.oldestDueMinute, 10, 'the due minute the oldest lease is holding the floor at');

	// A lease that EXPIRED rather than being released leaves the O(1) gauge high; the full walk is
	// what corrects it, so a stale gauge can never drift forever.
	clock.now = now + 2 * MINUTE;
	assert.equal(table.occupancy(), 2, 'the gauge is best-effort and still says 2');
	assert.equal(table.scanLive().count, 1);
	assert.equal(table.occupancy(), 1, 'and the walk reconciled it');
});

// ---- the claim floor ----

/**
 * A floor is only ever ESTABLISHED by a pass advancing it off 0 — `lowerFloorTo` cannot create one,
 * because 0 already means "no floor" and there is nothing lower to go to. That asymmetry is the
 * point (see the note on `lowerFloorTo`), so the floor tests set up through `advanceFloor` exactly
 * as a claim pass does.
 */
const establishFloor = (table, minute) => assert.equal(table.advanceFloor(0, minute), true);

test('readFloorMinute clamps to nowMinute − guard for ANY stored value, including a future one', () => {
	const { table } = harness();
	const nowMinute = 28_000_000;

	establishFloor(table, nowMinute); // "the floor is the current minute"
	assert.equal(table.readFloorMinute(nowMinute, 5), nowMinute - 5, 'the guard band is applied on every read');

	// A BACKWARDS CLOCK STEP leaves a stored floor in the future. Unclamped it would strand
	// everything written between the two clocks; clamped it is simply ignored.
	table.advanceFloor(nowMinute, nowMinute + 10_000);
	assert.equal(table.rawFloorMinute(), nowMinute + 10_000);
	assert.equal(table.readFloorMinute(nowMinute, 5), nowMinute - 5, 'a future stored floor never wins');

	// And a guard wider than the whole clock cannot produce a negative floor.
	assert.equal(table.readFloorMinute(3, 100), 0);
});

test('lowerFloorTo is a CAS-MIN: a concurrent higher store cannot erase a lower lowering', () => {
	// The interleaving that matters: `renderNow` on worker 1 lowers the floor while a claim pass on
	// worker 3 advances it. An unconditional store on either side loses the other's write; CAS-min
	// composes, so the earliest due time always wins in any order.
	const { table } = harness();
	const M = 28_000_000;

	establishFloor(table, M + 2);
	assert.equal(table.rawFloorMinute(), M + 2);

	// A pass advances to M+5...
	assert.equal(table.advanceFloor(M + 2, M + 5), true);
	assert.equal(table.rawFloorMinute(), M + 5);

	// ...and a write for a row due at M still pulls it all the way back.
	table.lowerFloorTo(M);
	assert.equal(table.rawFloorMinute(), M);

	// A lowering to something already covered changes nothing.
	table.lowerFloorTo(M + 9);
	assert.equal(table.rawFloorMinute(), M);
});

test('lowerFloorTo(0) means NO floor — a due time at or below the epoch minute unbounds the scan', () => {
	// This is the `nextRenderTime = 1` case (and any junk past value): minuteOf(1) is 0, and 0 is
	// the "seek the absolute minimum" sentinel. The row is then found on the very next pass.
	const { table } = harness();
	establishFloor(table, 28_000_000);
	table.lowerFloorTo(0);
	assert.equal(table.rawFloorMinute(), 0);
	assert.equal(table.readFloorMinute(28_000_000, 5), 0);
	// Already unbounded — a later lowering to a real minute must not RAISE it.
	table.lowerFloorTo(27_000_000);
	assert.equal(table.rawFloorMinute(), 0);
});

test('advanceFloor is abandoned when the expected value changed under it', () => {
	const { table } = harness();
	const M = 28_000_000;
	establishFloor(table, M + 10);

	// A pass read M+10, then a funnel write lowered it to M for a row the pass never saw.
	table.lowerFloorTo(M);

	assert.equal(table.advanceFloor(M + 10, M + 20), false, 'the CAS must fail, not retry');
	assert.equal(table.rawFloorMinute(), M, 'and the lowering must survive intact');
});

test('resetFloor unbounds the scan again, and the clamp does not resurrect a floor', () => {
	const { table } = harness();
	const nowMinute = 28_000_000;
	establishFloor(table, nowMinute);
	assert.equal(table.readFloorMinute(nowMinute, 5), nowMinute - 5);

	table.resetFloor();

	assert.equal(table.rawFloorMinute(), 0);
	assert.equal(table.readFloorMinute(nowMinute, 5), 0, '0 stays 0 — it is not clamped into a real minute');
});

test('a funnel lowering marks the earliest-due hint so status can flip with no scan', () => {
	const { table } = harness();
	table.recordPassOutcome({ sawDue: false, earliestNotYetDueMinute: 0 });
	assert.deepEqual(table.readPassOutcome(), { sawDue: false, earliestNotYetDueMinute: 0 });

	table.lowerFloorTo(27_999_999);
	assert.equal(table.readPassOutcome().earliestNotYetDueMinute, 27_999_999);

	// A later, EARLIER mark wins; a later, later one does not.
	table.lowerFloorTo(27_999_000);
	assert.equal(table.readPassOutcome().earliestNotYetDueMinute, 27_999_000);
	table.lowerFloorTo(28_000_500);
	assert.equal(table.readPassOutcome().earliestNotYetDueMinute, 27_999_000);

	// Minute 0 would collide with the "unknown" sentinel, so it is recorded as 1.
	table.resetFloor();
	table.recordPassOutcome({ sawDue: false, earliestNotYetDueMinute: 0 });
	table.lowerFloorTo(0);
	assert.equal(table.readPassOutcome().earliestNotYetDueMinute, 1);
});

test('a size mismatch derives the slot count from the buffer instead of indexing past it', () => {
	// The named shared buffer is sized by the FIRST allocation in the process, so a worker asking
	// for a bigger one gets a view of the smaller. Silently indexing past it would be memory
	// corruption; a smaller table is merely a smaller table.
	const buffer = new ArrayBuffer(leaseBufferBytes(4));
	const table = createLeaseTable({ buffer, slots: 4096, now: () => 1_700_000_000_000 });
	assert.equal(table.slots, 4);
	assert.equal(table.grant('a|desktop', { dueMinute: 1, leaseExpiryMs: 1_700_000_060_000 }), true);
});
