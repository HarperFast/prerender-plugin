import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The node-local render-lease table, over a plain ArrayBuffer.
 *
 * `createLeaseTable` is a pure factory precisely so this file needs no Harper at all: the probe
 * protocol, the expiry boundary, the collision behaviour and every CAS rule are exercised directly.
 * What is pinned here is what makes the whole design safe:
 *
 *   - a fresh, all-zero buffer means "no leases", not "everything leased at the epoch" — the same
 *     class of trap as `new Date(null).getTime() === 0`;
 *   - a grant is EXCLUSIVE: a key holding a live lease is refused, never renewed (#218);
 *   - two instances over the SAME buffer see each other, which is the only reason this is a
 *     coordination primitive rather than per-worker state;
 *   - a full table REFUSES to grant rather than corrupting a slot, because the caller must then
 *     not hand out the job;
 *   - a hash collision is safe in both directions (it reads as a phantom lease, which skips the
 *     row) and clears on expiry.
 */

import { lease64 } from '../src/util/hash.js';
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
	// One header word: the occupancy gauge.
	assert.equal(LEASE_HEADER_BYTES, 4);
	// Eight slot words: hash lo/hi, expiry, due minute, the miss count, and the latest grant's second, due
	// minute and millisecond.
	assert.equal(LEASE_SLOT_BYTES, 32);
	assert.equal(leaseBufferBytes(4096), 4 + 32 * 4096);
	assert.equal(leaseBufferBytes(4096), 131_076, 'the documented 128KB sizing');
});

// ---- the all-zero buffer ----

test('a fresh all-zero buffer has no leases (not epoch leases)', () => {
	const { table } = harness();

	assert.equal(table.isLeased('https://www.example.com/a|desktop'), false);
	assert.equal(table.occupancy(), 0);
	assert.deepEqual(table.scanLive(), { count: 0, oldestExpiresAtMs: null, oldestDueMinute: null });
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

test('A GRANT IS EXCLUSIVE: a live lease is refused, never renewed (#218)', () => {
	// Two claims that both took the same key — from two consecutive ready-set generations — must not
	// both be granted. Renewal was the duplicate grant #218 measured.
	const now = 1_700_000_000_000;
	const { table } = harness({ now });
	assert.equal(table.grant('a|desktop', { dueMinute: 1, leaseExpiryMs: now + MINUTE }), true);
	assert.equal(table.grant('a|desktop', { dueMinute: 2, leaseExpiryMs: now + 2 * MINUTE }), false);
	assert.equal(table.occupancy(), 1);
	assert.deepEqual(table.leaseOf('a|desktop'), { leaseExpiresAtMs: now + MINUTE, dueMinute: 1 }, 'unchanged');
});

test('a released lease is refused through its grace too, and granted once the grace has passed', () => {
	const now = 1_700_000_000_000;
	const { table, clock } = harness({ now });
	table.grant('a|desktop', { dueMinute: 1, leaseExpiryMs: now + MINUTE });
	table.release('a|desktop');
	assert.equal(table.grant('a|desktop', { dueMinute: 2, leaseExpiryMs: now + MINUTE }), false, 'inside the grace');
	clock.now = now + RELEASE_GRACE_MS + 1_000;
	assert.equal(table.grant('a|desktop', { dueMinute: 2, leaseExpiryMs: clock.now + MINUTE }), true);
	assert.deepEqual(table.leaseOf('a|desktop'), { leaseExpiresAtMs: clock.now + MINUTE, dueMinute: 2 });
});

test('two grants of one key racing onto DIFFERENT fresh slots: at most one is granted', () => {
	// Grant A stores its payload into the key's home slot (another key's expired lease) and, before its
	// CAS on the key word, grant B of the same key runs: B sees a live slot holding a different key, so
	// it takes the next slot. A's CAS then succeeds too. The rescan after a fresh slot is won is what
	// stops both being granted.
	let t = 1_700_000_000_000;
	const buffer = new ArrayBuffer(leaseBufferBytes(SLOTS));
	let inner = null;
	const a = createLeaseTable({
		buffer,
		slots: SLOTS,
		now: () => t,
		onGrantWindow: (key) => {
			if (inner !== null) return;
			inner = b.grant(key, { dueMinute: 5, leaseExpiryMs: t + MINUTE });
		},
	});
	const b = createLeaseTable({ buffer, slots: SLOTS, now: () => t });
	// An expired lease of another key in K's home slot, so A's grant recycles it.
	const K = 'https://www.example.com/p/1';
	const home = (lease64(K).lo >>> 0) % SLOTS;
	let other = null;
	for (let i = 0; other === null; i++) {
		const key = `https://www.example.com/o/${i}`;
		if ((lease64(key).lo >>> 0) % SLOTS === home && key !== K) other = key;
	}
	b.grant(other, { dueMinute: 1, leaseExpiryMs: t + 1_000 });
	t += MINUTE;

	const outer = a.grant(K, { dueMinute: 5, leaseExpiryMs: t + MINUTE });
	assert.equal(inner, true, 'the racing grant took another slot');
	assert.equal(outer, false, 'and the first gave its slot back');
	assert.equal(a.isLeased(K), true);
	assert.equal(a.scanLive().count, 1, 'one live lease for the key');
});

test('a lease that EXPIRES counts as a miss; a released one resets the count', () => {
	let t = 1_700_000_000_000;
	const { table } = {
		table: createLeaseTable({ buffer: new ArrayBuffer(leaseBufferBytes(SLOTS)), slots: SLOTS, now: () => t }),
	};
	const key = 'https://www.example.com/crash';
	assert.equal(table.missesBeforeGrant(key), 0, 'never leased');
	for (let i = 1; i <= 3; i++) {
		table.grant(key, { dueMinute: 1, leaseExpiryMs: t + MINUTE });
		assert.equal(table.missesBeforeGrant(key), 0, 'a live lease is not a miss yet');
		t += MINUTE; // expired with no result
		assert.equal(table.missesBeforeGrant(key), i, `${i} lease(s) in a row expired`);
	}
	table.grant(key, { dueMinute: 1, leaseExpiryMs: t + MINUTE });
	table.release(key); // a result came
	t += MINUTE;
	assert.equal(table.missesBeforeGrant(key), 0, 'released: the count starts again');
});

test('a RELEASED lease re-granted at the same due minute counts a miss: its result did not commit', () => {
	// The result path releases before the request's transaction commits. When that commit fails, the row
	// is still due at its old minute and the key is re-granted a few seconds later — and a release that
	// always reset the count meant the wedge guard never engaged on that loop.
	let t = 1_700_000_000_000;
	const table = createLeaseTable({ buffer: new ArrayBuffer(leaseBufferBytes(SLOTS)), slots: SLOTS, now: () => t });
	const key = 'https://www.example.com/uncommitted';
	for (let i = 1; i <= 4; i++) {
		assert.equal(table.grant(key, { dueMinute: 7, leaseExpiryMs: t + MINUTE }), true);
		assert.equal(table.release(key), true, 'a result came');
		t += 6_000; // past the release grace
		assert.equal(table.missesBeforeGrant(key, 7), i, `${i} result(s) in a row left the row where it was`);
	}
	assert.equal(table.missesBeforeGrant(key, 8), 0, 'a row that moved is a result that landed: the count resets');
	table.grant(key, { dueMinute: 8, leaseExpiryMs: t + MINUTE });
	table.release(key);
	t += 6_000;
	assert.equal(table.missesBeforeGrant(key, 8), 1, 'and it counts again from there');
});

test('a hold carries a same-minute miss count, so the backoff after an uncommitted loop keeps doubling', () => {
	let t = 1_700_000_000_000;
	const table = createLeaseTable({ buffer: new ArrayBuffer(leaseBufferBytes(SLOTS)), slots: SLOTS, now: () => t });
	const key = 'https://www.example.com/uncommitted';
	for (let i = 0; i < 3; i++) {
		table.grant(key, { dueMinute: 7, leaseExpiryMs: t + MINUTE });
		table.release(key);
		t += 6_000;
	}
	assert.equal(table.missesBeforeGrant(key, 7), 3);
	assert.equal(table.hold(key, t + MINUTE, 7), true);
	t += MINUTE;
	assert.equal(table.missesBeforeGrant(key, 7), 0, 'the attempt after a hold is always granted');
	table.grant(key, { dueMinute: 7, leaseExpiryMs: t + MINUTE });
	table.release(key);
	t += 6_000;
	assert.equal(table.missesBeforeGrant(key, 7), 4, 'carried through the hold, not reset by it');
});

test('grantOf names the latest real grant, and still does once it is released or expired', () => {
	let t = 1_700_000_000_500;
	const table = createLeaseTable({ buffer: new ArrayBuffer(leaseBufferBytes(SLOTS)), slots: SLOTS, now: () => t });
	const key = 'https://www.example.com/a';
	assert.equal(table.grantOf(key), null, 'never granted');
	table.grant(key, { dueMinute: 3, leaseExpiryMs: t + MINUTE });
	assert.deepEqual(table.grantOf(key), { grantedAtMs: 1_700_000_000_500, dueMinute: 3, live: true, released: false });
	table.release(key);
	assert.deepEqual(table.grantOf(key), { grantedAtMs: 1_700_000_000_500, dueMinute: 3, live: false, released: true });
	t += 2 * MINUTE;
	table.grant(key, { dueMinute: 5, leaseExpiryMs: t + MINUTE });
	t += 2 * MINUTE; // expired with no result
	assert.deepEqual(table.grantOf(key), {
		grantedAtMs: 1_700_000_120_500,
		dueMinute: 5,
		live: false,
		released: false,
	});
	table.hold(key, t + MINUTE, 5);
	assert.equal(table.grantOf(key).grantedAtMs, 1_700_000_120_500, 'a hold is not a grant');
});

test('a generation-checked release gives up only the lease granted then — never a re-grant since', () => {
	// A render that outlived its lease still posts its result. By then the key may be leased to another
	// renderer, and an unchecked release handed that renderer's key back to the queue.
	let t = 1_700_000_000_000;
	const table = createLeaseTable({ buffer: new ArrayBuffer(leaseBufferBytes(SLOTS)), slots: SLOTS, now: () => t });
	const key = 'https://www.example.com/slow';
	table.grant(key, { dueMinute: 3, leaseExpiryMs: t + MINUTE });
	const first = table.grantOf(key).grantedAtMs;
	t += 2 * MINUTE; // the first renderer is still going; its lease expires
	table.grant(key, { dueMinute: 3, leaseExpiryMs: t + MINUTE }); // and the key goes to a second one
	assert.equal(table.release(key, { grantedAtMs: first }), false, 'the late result does not release it');
	assert.equal(table.isLeased(key), true);
	assert.equal(table.leaseOf(key).leaseExpiresAtMs, t + MINUTE, 'still the second renderer’s lease, untruncated');
	assert.equal(table.release(key, { grantedAtMs: table.grantOf(key).grantedAtMs }), true, 'its own result does');
});

test('re-granting an EXPIRED lease reuses its slot instead of consuming a second one', () => {
	const now = 1_700_000_000_000;
	const { table, clock } = harness({ now });
	table.grant('a|desktop', { dueMinute: 1, leaseExpiryMs: now + MINUTE });
	clock.now = now + MINUTE;
	assert.equal(table.grant('a|desktop', { dueMinute: 2, leaseExpiryMs: clock.now + MINUTE }), true);
	assert.equal(table.scanLive().count, 1);
	assert.deepEqual(table.leaseOf('a|desktop'), { leaseExpiresAtMs: clock.now + MINUTE, dueMinute: 2 });
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
	assert.equal(
		workerB.grant('shared|desktop', { dueMinute: 42, leaseExpiryMs: now + MINUTE }),
		false,
		'and the other worker cannot take it too'
	);
	assert.equal(workerB.release('shared|desktop'), true);
	// Giving the lease up on one worker is visible on every worker — as "not in flight" immediately,
	// and as "claimable" once the commit grace has passed (which is what `isLeased` answers).
	assert.equal(workerA.leaseOf('shared|desktop'), null);
	assert.equal(workerA.occupancy(), 0);
});

// ---- capacity ----

test('a full probe window REFUSES to grant rather than corrupting an existing lease', () => {
	// The caller must then not emit the job: a granted-but-unrecorded job is a double render.
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

test('a hash collision reads as a PHANTOM lease: the row is skipped, then it clears', () => {
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
	// (c) The real lease is untouched.
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

// ---- sizing ----

test('a size mismatch derives the slot count from the buffer instead of indexing past it', () => {
	// The named shared buffer is sized by the FIRST allocation in the process, so a worker asking
	// for a bigger one gets a view of the smaller. Silently indexing past it would be memory
	// corruption; a smaller table is merely a smaller table.
	const buffer = new ArrayBuffer(leaseBufferBytes(4));
	const table = createLeaseTable({ buffer, slots: 4096, now: () => 1_700_000_000_000 });
	assert.equal(table.slots, 4);
	assert.equal(table.grant('a|desktop', { dueMinute: 1, leaseExpiryMs: 1_700_000_060_000 }), true);
});

test('the grant instant is exact to the millisecond — a mark in the same second is not "after" it', () => {
	// Floored to its second, a grant at .400 read as .000, before a mark filed at .100 — and the result path
	// dropped that correct render as changed-during-render.
	const t = 1_700_000_050_400;
	const table = createLeaseTable({ buffer: new ArrayBuffer(leaseBufferBytes(SLOTS)), slots: SLOTS, now: () => t });
	table.grant('https://www.example.com/ms', { dueMinute: 1, leaseExpiryMs: t + MINUTE });
	assert.equal(table.grantOf('https://www.example.com/ms').grantedAtMs, t);
	assert.equal(
		table.release('https://www.example.com/ms', { grantedAtMs: t - 400 }),
		false,
		'the second alone is not the grant'
	);
	assert.equal(table.release('https://www.example.com/ms', { grantedAtMs: t }), true);
});

test('a leftDue release CARRIES the miss count — it neither counts a miss nor resets the count', () => {
	let t = 1_700_000_000_000;
	const table = createLeaseTable({ buffer: new ArrayBuffer(leaseBufferBytes(SLOTS)), slots: SLOTS, now: () => t });
	const key = 'https://www.example.com/carried';
	for (let i = 0; i < 3; i++) {
		table.grant(key, { dueMinute: 7, leaseExpiryMs: t + MINUTE });
		t += 2 * MINUTE; // expired with no result
	}
	assert.equal(table.missesBeforeGrant(key, 7), 3);
	table.grant(key, { dueMinute: 7, leaseExpiryMs: t + MINUTE });
	table.release(key, { grantedAtMs: table.grantOf(key).grantedAtMs, leftDue: true });
	t += 6_000;
	assert.equal(table.missesBeforeGrant(key, 7), 3, 'the same minute: not a commit that failed');
	assert.equal(table.missesBeforeGrant(key, 9), 3, 'another minute: not a result that proved the key healthy');
});
