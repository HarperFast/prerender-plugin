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
	RELEASE_GRACE_MS,
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
	// 7 header words: floor, occupancy, sawDue, earliestNotYetDue, and the three that track WHICH key
	// the floor is pinned at and since when (`notePinnedBy`).
	assert.equal(LEASE_HEADER_BYTES, 28);
	assert.equal(LEASE_SLOT_BYTES, 16);
	assert.equal(leaseBufferBytes(4096), 28 + 16 * 4096);
	assert.equal(leaseBufferBytes(4096), 65_564, 'the documented 64KB sizing');
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

test('release gives the lease up at once but keeps the key unclaimable for the commit grace', () => {
	// THE COMMIT-VISIBILITY GRACE. The result path releases from a `finally` inside the request
	// handler, while the reschedule it just issued commits with the AMBIENT transaction — after the
	// handler settles. Freeing the key on the spot leaves a window in which committed state still
	// shows the row overdue and unleased, and a `claim` on another worker (which does not share the
	// result path's mutex) grants it a second time: a duplicate render on every result, and a second
	// strike toward maxStrikes on a failing key.
	const now = 1_700_000_000_000;
	const { table, clock } = harness({ now });

	table.grant('a|desktop', { dueMinute: 1, leaseExpiryMs: now + 10 * MINUTE });
	assert.equal(table.release('a|desktop'), true);

	// Given up immediately for everything that means "is this being rendered": the gauge and leaseOf.
	assert.equal(table.occupancy(), 0);
	assert.equal(table.leaseOf('a|desktop'), null, 'not in flight any more');
	// But NOT claimable, which is the whole point — and never for longer than the original lease.
	assert.equal(table.isLeased('a|desktop'), true, 'still unclaimable while the transaction commits');
	assert.ok(RELEASE_GRACE_MS < 10 * MINUTE);

	assert.equal(table.release('a|desktop'), false, 'releasing twice is a no-op, not a second decrement');
	assert.equal(table.occupancy(), 0, 'and specifically not a gauge that goes negative');
	assert.equal(table.release('never-granted|desktop'), false);

	clock.now = now + RELEASE_GRACE_MS + 1_000;
	assert.equal(table.isLeased('a|desktop'), false, 'and the grace expires — the slot is reusable');
	assert.equal(table.grant('a|desktop', { dueMinute: 2, leaseExpiryMs: clock.now + MINUTE }), true);
	assert.equal(table.occupancy(), 1, 'a re-grant counts once');
});

test('a release cannot cut short a lease another key has since taken over the slot', () => {
	// The old publish order CAS'd hashLo to 0 and only THEN zeroed the expiry, so a grant landing in
	// between had its brand-new lease silently zeroed. Release writes no hashLo at all now.
	const now = 1_700_000_000_000;
	const { table, clock } = harness({ slots: 1, now });

	table.grant('first|desktop', { dueMinute: 1, leaseExpiryMs: now + MINUTE });
	clock.now = now + 2 * MINUTE; // first|desktop's lease expired unreleased
	assert.equal(table.grant('second|desktop', { dueMinute: 2, leaseExpiryMs: clock.now + 10 * MINUTE }), true);

	// The first key's result finally arrives, for a slot that now belongs to somebody else.
	assert.equal(table.release('first|desktop'), false, 'the hash pair no longer matches — nothing to release');
	assert.equal(table.isLeased('second|desktop'), true, 'and the live lease is intact');
	assert.deepEqual(table.leaseOf('second|desktop'), { leaseExpiresAtMs: clock.now + 10 * MINUTE, dueMinute: 2 });
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
	// Giving the lease up on one worker is visible on every worker — as "not in flight" immediately,
	// and as "claimable" once the commit grace has passed (which is what `isLeased` answers).
	assert.equal(workerA.leaseOf('shared|desktop'), null);
	assert.equal(workerA.occupancy(), 0);
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

test('the occupancy gauge is only ever HIGH — a late release of an expired lease cannot pull it below the live count', () => {
	// THE DIRECTION MATTERS ENORMOUSLY. `occupancy()` sizes the claim pass's read past the in-flight
	// pile (grantLimit + occupancy + grantLimit), so a gauge reading high costs a slightly wider scan
	// while a gauge reading LOW makes a pass with more live leases than 2 × grantLimit grant NOTHING
	// while a backlog exists — silently, and for as long as the drift lasts.
	//
	// The interleaving that used to do it: `grant` counted only never-used slots, `release`
	// decremented unconditionally, and `scanLive` stored the live count. So every lease that expired
	// without a result and was released LATE (the result arrives after the lease ran out — routine)
	// left an unmatched −1 behind the reconciliation. Measured with 150 grants and 100 expired: the
	// gauge read 0 with 50 leases genuinely in flight.
	const now = 1_700_000_000_000;
	const { table, clock } = harness({ slots: 512, now });

	const expiring = [];
	const holding = [];
	for (let i = 0; i < 150; i++) {
		const key = `https://www.example.com/p${i}|desktop`;
		const keeps = i % 3 === 0;
		if (!table.grant(key, { dueMinute: 100 + i, leaseExpiryMs: now + (keeps ? 10 : 1) * MINUTE })) continue;
		(keeps ? holding : expiring).push(key);
	}
	assert.ok(holding.length > 40 && expiring.length > 80, 'precondition: a real pile in both states');
	assert.equal(table.occupancy(), holding.length + expiring.length);

	// Two minutes on: the short leases have expired with no result posted, and a console read (the
	// admin overview, an explain, a peer schedule request) reconciles the gauge down to the live set.
	clock.now = now + 2 * MINUTE;
	assert.equal(table.scanLive().count, holding.length);
	assert.equal(table.occupancy(), holding.length);

	// NOW the late results arrive for every expired lease.
	for (const key of expiring) table.release(key);

	assert.equal(table.occupancy(), holding.length, 'releasing an already-expired lease decrements nothing');
	assert.equal(table.scanLive().count, holding.length, 'and the walk agrees — the two never disagree');
});

test('releasing an EXPIRED lease never pushes its expiry back into the future', () => {
	// `release` shortens a lease to a commit-visibility grace, and "shorten" must mean shorten. For an
	// already-expired lease the grace (now + 5s) is LATER than the stored expiry, so writing it would
	// resurrect a dead slot for five seconds and make the key unclaimable again.
	//
	// This is also the half of the recycled-slot hazard that IS reachable from a single thread. The
	// other half is not: `release` reads the expiry BEFORE it re-validates ownership and CASes against
	// exactly that value, so a slot recycled between the two is caught either by the ownership check or
	// by the failed CAS — but reaching that interleaving needs the recycling `grant` to run between two
	// adjacent instructions of this function, which no sequential test can arrange. That ordering is
	// argued from `grant`'s publish order (payload before `hashLo`) in the module comment, and it is
	// deliberately NOT pinned by a test here rather than pinned by one that would pass either way.
	const now = 1_700_000_000_000;
	const { table, clock } = harness({ slots: 8, now });
	const key = 'https://www.example.com/expired|desktop';

	table.grant(key, { dueMinute: 500, leaseExpiryMs: now + MINUTE });
	clock.now = now + 5 * MINUTE; // long expired
	assert.equal(table.isLeased(key), false);

	assert.equal(table.release(key), true, 'the release is still accepted — it is the one result for it');
	assert.equal(table.isLeased(key), false, 'and the key stays claimable, rather than being re-blocked');
});

// ---- the pin tracker ----

test('notePinnedBy measures a pin in TIME, resets on a new holder, and clears on none', () => {
	// Deliberately AT `LEASE_EPOCH_SEC`, where the stored second is 0. `H_PIN_LO` is what says whether
	// anything is pinned; a version that read a `sinceSec` of 0 as "unset" re-stamped the pin on every
	// pass inside that second and it could never age.
	const now = 1_700_000_000_000;
	const { table, clock } = harness({ now });

	assert.equal(table.notePinnedBy('a|desktop'), 0, 'the pass that first observes a pin reports no age');
	assert.equal(table.notePinnedBy('a|desktop'), 0, 'a SECOND pass in the same second is still 0 — not a count');

	clock.now = now + 90_000;
	assert.equal(table.notePinnedBy('a|desktop'), 90_000);
	assert.equal(table.readPinAgeMs(), 90_000, 'and it can be read without recording anything');

	// A different row takes over: it starts its own clock rather than inheriting this age. Without
	// that, unpinning one row would immediately qualify the next and the escape hatch becomes a sweep.
	assert.equal(table.notePinnedBy('b|desktop'), 0);
	clock.now = now + 120_000;
	assert.equal(table.notePinnedBy('b|desktop'), 30_000);

	assert.equal(table.notePinnedBy(null), 0, 'nothing due ⇒ no pin');
	assert.equal(table.readPinAgeMs(), 0);
	// And the cleared pin does not resurrect the old holder's age when it comes back.
	assert.equal(table.notePinnedBy('b|desktop'), 0);
});

test('a backwards clock step reads as a fresh pin, not as an age that can never cross a threshold', () => {
	const now = 1_700_000_000_000;
	const { table, clock } = harness({ now });

	table.notePinnedBy('a|desktop');
	clock.now = now - 10 * MINUTE;
	assert.equal(table.notePinnedBy('a|desktop'), 0, 'clamped at 0 rather than negative');
	assert.equal(table.readPinAgeMs(), 0);
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

test('a pass STORES its own horizon — a LATER one replaces an earlier mark, so the status cannot latch', () => {
	// The pass drained every row from the floor up to the first future one, so it is authoritative
	// about the whole window: a horizon that has moved later means the row that used to name it has
	// rendered. Under the CAS-min this replaced, that later horizon was discarded — so once the
	// recorded minute arrived, `deriveQueueStatus` answered `queued` for the life of the buffer while
	// `claim` answered `empty`, the node rewrote the replicated QueueStatus row about twice a minute,
	// and no consumer in the fleet ever reached its idle interval.
	const { table } = harness();
	const M = 28_000_000;

	table.recordPassOutcome({ sawDue: true, earliestNotYetDueMinute: M + 1 });
	assert.equal(table.readPassOutcome().earliestNotYetDueMinute, M + 1);

	// That row rendered and is now a day out; the next pass sees nothing due and a much later horizon.
	table.recordPassOutcome({ sawDue: false, earliestNotYetDueMinute: M + 1440 });
	assert.deepEqual(table.readPassOutcome(), { sawDue: false, earliestNotYetDueMinute: M + 1440 });

	// And a pass that reached no future row at all clears the mark, as it always did.
	table.recordPassOutcome({ sawDue: false, earliestNotYetDueMinute: 0 });
	assert.equal(table.readPassOutcome().earliestNotYetDueMinute, 0);
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
