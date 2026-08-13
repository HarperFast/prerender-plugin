import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Queue status is DERIVED, not scanned.
 *
 * `syncQueueState` used to run a second head-seeking query (`nextRenderTime <= now`, limit 1) on
 * worker 0 every `queue.statusSyncInterval` — measured at ~700ms of synchronous native iteration
 * per minute on an aged node, on the worker that also serves bot traffic. With a claim floor the
 * answer is derivable from it plus the last claim outcome at zero database cost.
 *
 * The strongest way to pin the ABSENCE of a query is to make that query fatal: the RenderSchedule
 * fake here THROWS from `search`, so a status refresh that still scans cannot pass.
 *
 * Everything else in this file is the part of `syncQueueState` that must NOT change. Deleting the
 * pause resolution along with the scan would make cluster-wide pause stop converging with no error
 * anywhere: the QueueControl row is written, the console shows it, and no node ever acts on it.
 */

const MINUTE = 60_000;
const T0 = 1_700_000_400_000;
const minuteOf = (ms) => Math.floor(ms / MINUTE);

let RenderQueue, QueueState, funnel, config;

const controls = new Map();
const statuses = new Map();
const sabs = new Map();
let searchCalls = 0;

// A class, not an object literal: `Target` EXTENDS `databases.render_service.Target`.
// Same load-bearing semantics as the fakes in renderQueueRedirect.test.js — put replaces, a string
// select returns the bare scalar.
const makeTable = (rows) =>
	class FakeResource {
		constructor(id) {
			this.__id = id;
		}
		getId() {
			return this.__id;
		}
		async put(data) {
			rows.set(this.__id, { ...data });
		}
		async delete() {
			return rows.delete(this.__id);
		}
		static async get(query) {
			const id = typeof query === 'object' ? query.id : query;
			const row = rows.get(id);
			if (!row) return null;
			const select = typeof query === 'object' ? query.select : undefined;
			if (typeof select === 'string') return row[select];
			if (Array.isArray(select)) return Object.fromEntries(select.map((name) => [name, row[name]]));
			return { ...row };
		}
		static async put(id, data) {
			return new this(id).put({ ...data });
		}
		static async patch(id, data) {
			rows.set(id, { ...(rows.get(id) ?? {}), ...data });
		}
		static async delete(id) {
			return new this(id).delete();
		}
		static async search() {
			return [];
		}
	};

before(async () => {
	globalThis.Resource = class {};
	globalThis.server = { hostname: 'node-a', workerIndex: 0, nodes: [], config: { http: { port: 9926 } } };
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {} };
	globalThis.createBlob = (buffer) => buffer;
	globalThis.databases = {
		coordination: {
			SharedBuffer: {
				primaryStore: {
					// Keyed: QueueState and the render-lease table share this store under different names,
					// and an unkeyed fake would hand each acquisition its own zeroed buffer.
					getUserSharedBuffer: (key, buffer) => {
						if (!sabs.has(key)) sabs.set(key, buffer);
						return sabs.get(key);
					},
					tryLock: () => true,
					unlock() {},
				},
			},
		},
		render_service: {
			Target: makeTable(new Map()),
			QueueControl: makeTable(controls),
			QueueStatus: makeTable(statuses),
		},
		render_schedule: {
			// THE ASSERTION: any surviving scan is fatal.
			RenderSchedule: {
				get: async () => null,
				put: async () => {},
				delete: async () => {},
				search: () => {
					searchCalls++;
					throw new Error('RenderSchedule.search must not be reached from a queue-status refresh');
				},
			},
		},
		page_cache: { PrerenderedPage: makeTable(new Map()) },
	};

	({ config } = await import('../src/config.js'));
	({ QueueState } = await import('../src/resources/QueueState.js'));
	({ RenderQueue } = await import('../src/resources/RenderQueue.js'));
	funnel = await import('../src/util/renderSchedule.js');
});

beforeEach(() => {
	controls.clear();
	statuses.clear();
	searchCalls = 0;
	funnel.resetRenderQueueState();
	QueueState.reportStatus('empty', true);
});

test('refreshQueueStatus resolves with a status even though RenderSchedule.search throws', async () => {
	funnel.leaseTable().recordPassOutcome({ sawDue: true, earliestNotYetDueMinute: 0 });

	const result = await RenderQueue.refreshQueueStatus();

	assert.equal(result.status, 'queued');
	assert.equal(searchCalls, 0, 'the status recompute must not scan the queue index at all');
	assert.equal(QueueState.status, 'queued');
});

test('the derivation is tri-state: due rows seen ⇒ queued, none ⇒ empty', async () => {
	funnel.leaseTable().recordPassOutcome({ sawDue: false, earliestNotYetDueMinute: 0 });
	assert.equal((await RenderQueue.refreshQueueStatus()).status, 'empty');

	funnel.leaseTable().recordPassOutcome({ sawDue: true, earliestNotYetDueMinute: 0 });
	assert.equal((await RenderQueue.refreshQueueStatus()).status, 'queued');
	assert.equal(searchCalls, 0);
});

test('a not-yet-due row whose minute has arrived flips the derivation to queued', () => {
	funnel.leaseTable().recordPassOutcome({ sawDue: false, earliestNotYetDueMinute: minuteOf(T0 + 5 * MINUTE) });
	assert.equal(funnel.deriveQueueStatus(T0), 'empty');
	assert.equal(funnel.deriveQueueStatus(T0 + 5 * MINUTE), 'queued');
	assert.equal(searchCalls, 0);
});

// ---- what must NOT have been deleted with the scan ----

test('a pause intent still short-circuits before any derivation, and reports paused', async () => {
	controls.set('all', { scope: 'all', paused: true });

	const result = await RenderQueue.refreshQueueStatus();

	assert.equal(result.status, 'paused');
	assert.equal(QueueState.status, 'paused', 'the node-local flag `claim` reads must actually hold it');
	assert.equal(searchCalls, 0);
});

test('a per-node override still wins over the cluster scope, in both directions', async () => {
	controls.set('all', { scope: 'all', paused: true });
	controls.set('node-a', { scope: 'node-a', paused: false });
	assert.notEqual((await RenderQueue.refreshQueueStatus()).status, 'paused', 'force-run beats a cluster pause');

	controls.set('all', { scope: 'all', paused: false });
	controls.set('node-a', { scope: 'node-a', paused: true });
	assert.equal((await RenderQueue.refreshQueueStatus()).status, 'paused', 'and a node pause beats a cluster run');
});

test('LIFTING a pause is force-written — a compareExchange cannot move a flag holding `paused`', async () => {
	// reportStatus's non-forced path swaps empty<->queued only, so without the `liftingPause` force a
	// resumed node would stay reported (and read) as paused forever.
	controls.set('all', { scope: 'all', paused: true });
	await RenderQueue.refreshQueueStatus();
	assert.equal(QueueState.status, 'paused');

	controls.delete('all');
	funnel.leaseTable().recordPassOutcome({ sawDue: false, earliestNotYetDueMinute: 0 });
	const result = await RenderQueue.refreshQueueStatus();

	assert.equal(result.status, 'empty');
	assert.equal(QueueState.status, 'empty', 'the flag actually moved off paused');
});

test('a forced refresh writes the QueueStatus row', async () => {
	funnel.leaseTable().recordPassOutcome({ sawDue: false, earliestNotYetDueMinute: 0 });
	await RenderQueue.refreshQueueStatus(true);
	assert.equal(statuses.get('node-a')?.status, 'empty');
});

// ---- the status row is written ONLY on a CHANGE ----
// `reportStatus` is called per bot request and per claim pass, and the node-local shared buffer
// exists precisely so those paths do not each become a replicated write. A steady node therefore
// writes nothing, and `updatedTime` means "status last CHANGED" — not "last reported".
//
// A heartbeat here was tried and reverted: it would have made every node's liveness legible at the
// cost of a replicated write per node per interval forever, to re-derive something the console
// already knows for free (whether the node answered its fan-out). Don't add it back. What the
// console needed instead was to stop inferring liveness from this timestamp at all.

test('a steady status writes NOTHING, however many syncs run', async () => {
	funnel.leaseTable().recordPassOutcome({ sawDue: true, earliestNotYetDueMinute: 0 });
	await RenderQueue.refreshQueueStatus();
	const first = statuses.get('node-a');
	assert.equal(first?.status, 'queued', 'the flip to queued wrote once');

	statuses.clear();
	for (let i = 0; i < 5; i++) await RenderQueue.refreshQueueStatus();

	assert.equal(statuses.size, 0, 'five more syncs at an unchanged status must not write at all');
});

test('a real change still writes, in both directions', async () => {
	funnel.leaseTable().recordPassOutcome({ sawDue: true, earliestNotYetDueMinute: 0 });
	await RenderQueue.refreshQueueStatus();
	assert.equal(statuses.get('node-a')?.status, 'queued');

	funnel.leaseTable().recordPassOutcome({ sawDue: false, earliestNotYetDueMinute: 0 });
	await RenderQueue.refreshQueueStatus();
	assert.equal(statuses.get('node-a')?.status, 'empty');
});

// ---- the lease-gauge walk rides on the status sync ----

test('the status refresh reconciles the lease gauge, which otherwise climbs without bound', async () => {
	// The gauge only comes DOWN on a release that matches a live lease. A lease that simply EXPIRES has
	// nobody to decrement it — the grant counted +1, and a late release (or the release that never
	// arrives) sees a dead slot and correctly declines — so every expiry leaks one, permanently.
	//
	// That is not cosmetic, because the gauge SIZES the claim scan (`grantLimit + occupancy +
	// grantLimit`, capped at queue.claimScanCap). Measured on the real pass it reached 820 against 20
	// genuinely in flight after ~80 minutes and crossed a 1,000-row cap by pass 49, after which every
	// claim drains the full cap of projected rows under the claim mutex, on the worker that also serves
	// bot traffic. Nothing else in the system walks the slots on a timer, so if this refresh stops doing
	// it the drift is unbounded again.
	const leases = funnel.leaseTable();
	const now = Date.now();

	// The broad-outage shape: leases granted and left to expire, over and over, with no result ever
	// posted for any of them.
	for (let round = 0; round < 5; round++) {
		for (let i = 0; i < 20; i++) {
			leases.grant(`k${i}|desktop`, { dueMinute: minuteOf(now) - 10, leaseExpiryMs: now - MINUTE });
		}
	}
	assert.equal(leases.occupancy(), 100, 'the gauge has drifted to 100 with nothing whatsoever live');

	await RenderQueue.refreshQueueStatus();

	assert.equal(leases.occupancy(), 0, 'the refresh walked the slots and reconciled it to the truth');
	assert.equal(searchCalls, 0, 'and did it without touching the queue index — the walk is pure Atomics');
});

// ---- the floor reset rides on the status sync ----

test('the status refresh resets the claim floor at most once per resetInterval', async () => {
	const original = config.queue.claimFloor.resetInterval;
	try {
		config.queue.claimFloor.resetInterval = 5 * MINUTE;
		funnel.resetRenderQueueState();

		// First refresh: the reset fires (this is what recovers a due time written below the floor by
		// the operations API, which no plugin code can observe).
		await RenderQueue.refreshQueueStatus();
		funnel.leaseTable().advanceFloor(0, minuteOf(T0));
		assert.equal(funnel.maybeResetFloor(Date.now() + MINUTE), false, 'not again inside the interval');
		assert.equal(funnel.leaseTable().rawFloorMinute(), minuteOf(T0), 'so the floor survives');

		assert.equal(funnel.maybeResetFloor(Date.now() + 6 * MINUTE), true);
		assert.equal(funnel.leaseTable().rawFloorMinute(), 0, 'and the next pass re-derives it from the index');
	} finally {
		config.queue.claimFloor.resetInterval = original;
	}
});

test('resetting the claim floor by hand reports what it changed', async () => {
	funnel.resetRenderQueueState();
	funnel.leaseTable().advanceFloor(0, minuteOf(T0));

	const result = await RenderQueue.resetClaimFloor();

	assert.equal(result.previousFloorMinute, minuteOf(T0));
	assert.equal(result.floorMinute, 0);
	assert.equal(result.node, 'node-a');
	assert.equal(funnel.leaseTable().rawFloorMinute(), 0);
});
