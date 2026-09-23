import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The page orphan sweep (src/util/pageOrphanSweep.js): deletion of cached pages no Target owns.
 *
 * The properties that make a destructive sweep over the busiest database safe to run against a live
 * cluster: it only touches pages whose URL this node owns; it never deletes a page that is recent,
 * still servable, owned by a target, or being rendered; each batch is one transaction that re-checks
 * every key immediately before deleting it; the cap bounds deletions but never the census; a dry run
 * deletes nothing; and a run of failed batches stops the pass instead of grinding on.
 */

const sabs = new Map();
const sharedBufferStub = {
	getUserSharedBuffer: (key, buffer) => {
		if (!sabs.has(key)) sabs.set(key, buffer);
		return sabs.get(key);
	},
	tryLock: () => true,
	unlock() {},
};
const runStateRows = new Map();
const coordinationTable = {
	primaryStore: sharedBufferStub,
	async get(key) {
		return runStateRows.get(key) ?? null;
	},
	async put(key, value) {
		runStateRows.set(key, value);
	},
};
class FakeTable {
	static async get() {}
	static async put() {}
	static async patch() {}
	static async delete() {}
	static search() {
		return [];
	}
}

let sweep;
beforeEach(async () => {
	globalThis.server = { hostname: 'node-a', nodes: [], config: { http: {} } };
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {} };
	globalThis.Resource = class {};
	globalThis.databases = {
		coordination: { SharedBuffer: coordinationTable },
		probe_state: { ProbeState: FakeTable, RenderExpectation: FakeTable },
		render_service: { Target: FakeTable },
		page_cache: { PrerenderedPage: FakeTable },
		render_schedule: { RenderSchedule: FakeTable },
	};
	sweep = await import('../src/util/pageOrphanSweep.js');
});

afterEach(() => {
	delete globalThis.server;
	delete globalThis.logger;
	delete globalThis.databases;
	delete globalThis.transaction;
});

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-23T12:00:00Z');
const OWNED = 'node-a';
const SWR = 6 * 3_600_000;
const url = (n) => `https://example.com/catalog/${n}`;

/** A page cached `ageDays` ago that expired a day after it was cached. */
const page = (n, { ageDays = 30, device = 'desktop', expiresAt } = {}) => {
	const lastCached = NOW - ageDays * DAY;
	return {
		cacheKey: `${url(n)}|${device}`,
		lastCached: new Date(lastCached).toISOString(),
		expiresAt: new Date(expiresAt ?? lastCached + DAY).toISOString(),
	};
};

const freshStats = () => ({
	examined: 0,
	owned: 0,
	old: 0,
	servableSkipped: 0,
	targeted: 0,
	leaseSkipped: 0,
	orphaned: 0,
	deleted: 0,
	changed: 0,
	unreadable: 0,
	truncated: false,
	errors: 0,
	errorSamples: [],
	abortedOnErrors: false,
	canceled: false,
});

const run = (rows, overrides = {}) => {
	const batches = [];
	const stats = freshStats();
	return sweep
		.sweepOrphanedPages({
			rows: (async function* () {
				yield* rows;
			})(),
			ownerOf: () => OWNED,
			hostname: OWNED,
			targetExists: async () => false,
			isLeased: () => false,
			deleteBatch: async (batch) => {
				batches.push(batch.map((b) => b.cacheKey));
				return { deleted: batch.length, changed: 0 };
			},
			minAgeMs: 21 * DAY,
			swrTtl: SWR,
			maxDeletes: 1000,
			ratePerSecond: 1_000_000,
			batchSize: 100,
			dryRun: false,
			now: () => NOW,
			pause: async () => {},
			onYield: async () => {},
			stats,
			...overrides,
		})
		.then(() => ({ stats, batches, deleted: batches.flat() }));
};

test('an owned, old, unservable, targetless, idle page is deleted', async () => {
	const { stats, deleted } = await run([page(1), page(1, { device: 'mobile' })]);
	assert.deepEqual(deleted, [`${url(1)}|desktop`, `${url(1)}|mobile`]);
	assert.equal(stats.orphaned, 2);
	assert.equal(stats.deleted, 2);
});

test('each guard spares its page: not owned, too recent, still servable, has a target, in flight', async () => {
	const rows = [
		page('foreign'),
		page('recent', { ageDays: 5 }),
		page('servable', { expiresAt: NOW + DAY }),
		page('targeted'),
		page('leased'),
		page('orphan'),
	];
	const { stats, deleted } = await run(rows, {
		ownerOf: (u) => (u === url('foreign') ? 'node-b' : OWNED),
		targetExists: async (u) => u === url('targeted'),
		isLeased: (u) => u === url('leased'),
	});
	assert.deepEqual(deleted, [`${url('orphan')}|desktop`]);
	assert.equal(stats.owned, 5);
	assert.equal(stats.old, 4, 'the recent page never reaches the later tests');
	assert.equal(stats.servableSkipped, 1);
	assert.equal(stats.targeted, 1);
	assert.equal(stats.leaseSkipped, 1);
	assert.equal(stats.orphaned, 1);
});

test('a page inside its SWR window is still servable and is spared', async () => {
	// Expired an hour ago, but swrTtl (6h) still serves it: deleting would turn a serve into a miss.
	const { deleted, stats } = await run([page(1, { expiresAt: NOW - 3_600_000 })]);
	assert.deepEqual(deleted, []);
	assert.equal(stats.servableSkipped, 1);
});

test('an unreadable timestamp is "cannot tell", never a reason to delete', async () => {
	const { deleted } = await run([
		{ cacheKey: `${url(1)}|desktop`, lastCached: null, expiresAt: null },
		{ cacheKey: `${url(2)}|desktop`, lastCached: new Date(NOW - 30 * DAY).toISOString(), expiresAt: null },
	]);
	assert.deepEqual(deleted, []);
});

test('a dry run counts the population and deletes nothing', async () => {
	const { stats, batches } = await run([page(1), page(2)], { dryRun: true });
	assert.equal(batches.length, 0);
	assert.equal(stats.deleted, 2, 'would-be deletions, for sizing the real run');
});

test('the cap bounds deletions, not the census, and reports truncation', async () => {
	const rows = Array.from({ length: 10 }, (_, i) => page(i));
	const { stats, deleted } = await run(rows, { maxDeletes: 3 });
	assert.equal(deleted.length, 3);
	assert.equal(stats.orphaned, 10, 'the whole population is still measured');
	assert.equal(stats.truncated, true);
});

test('deletes go in batches of batchSize, one deleteBatch call each', async () => {
	const rows = Array.from({ length: 7 }, (_, i) => page(i));
	const { batches } = await run(rows, { batchSize: 3 });
	assert.deepEqual(
		batches.map((b) => b.length),
		[3, 3, 1]
	);
});

test('pages that changed before their delete are counted, not deleted', async () => {
	const { stats } = await run([page(1), page(2)], {
		deleteBatch: async (batch) => ({ deleted: batch.length - 1, changed: 1 }),
	});
	assert.equal(stats.deleted, 1);
	assert.equal(stats.changed, 1);
});

test('one failed batch is left for the next pass; a run of them stops the pass', async () => {
	const rows = Array.from({ length: 20 }, (_, i) => page(i));
	let calls = 0;
	const flaky = await run(rows, {
		batchSize: 2,
		deleteBatch: async (batch) => {
			if (++calls === 1) throw new Error('peer timeout');
			return { deleted: batch.length, changed: 0 };
		},
	});
	assert.equal(flaky.stats.errors, 1);
	assert.equal(flaky.stats.deleted, 18);

	await assert.rejects(
		run(rows, {
			batchSize: 2,
			deleteBatch: async () => {
				throw new Error('commit rejected');
			},
		}),
		/consecutive failed batches/
	);
});

test('a cancel ends the pass at the next row', async () => {
	let seen = 0;
	const { stats } = await run(
		Array.from({ length: 10 }, (_, i) => page(i)),
		{
			isCanceled: () => seen++ >= 3,
		}
	);
	assert.equal(stats.canceled, true);
	assert.equal(stats.examined, 3);
});

// ───────────────────────────── the batch transaction ─────────────────────────────

test('deletePageBatch re-checks every key inside ONE transaction, holding it for peer confirmation', async () => {
	const pages = new Map([
		[`${url(1)}|desktop`, { lastCached: new Date(NOW - 30 * DAY).toISOString() }],
		// Re-rendered since the walk saw it: must survive.
		[`${url(2)}|desktop`, { lastCached: new Date(NOW).toISOString() }],
		[`${url(3)}|desktop`, { lastCached: new Date(NOW - 30 * DAY).toISOString() }],
	]);
	// A target appeared for url(3) since the walk.
	const targets = new Set([url(3)]);
	const deletedKeys = [];
	let inTransaction = false;
	const transactions = [];
	globalThis.transaction = async (ctxOrFn, maybeFn) => {
		const [ctx, fn] = typeof ctxOrFn === 'function' ? [{}, ctxOrFn] : [ctxOrFn, maybeFn];
		transactions.push(ctx);
		inTransaction = true;
		try {
			return await fn();
		} finally {
			inTransaction = false;
		}
	};
	globalThis.databases.page_cache.PrerenderedPage = {
		get: async ({ id }) => (pages.has(id) ? { cacheKey: id, ...pages.get(id) } : null),
		delete: async (id) => {
			assert.ok(inTransaction, 'every delete runs inside the batch transaction');
			deletedKeys.push(id);
		},
	};
	globalThis.databases.render_service.Target = {
		get: async ({ id }) => (targets.has(id) ? { url: id } : null),
	};

	const walkedAt = NOW - 30 * DAY;
	const result = await sweep.deletePageBatch(
		[
			{ cacheKey: `${url(1)}|desktop`, url: url(1), lastCachedMs: walkedAt },
			{ cacheKey: `${url(2)}|desktop`, url: url(2), lastCachedMs: walkedAt },
			{ cacheKey: `${url(3)}|desktop`, url: url(3), lastCachedMs: walkedAt },
			// Gone since the walk.
			{ cacheKey: `${url(4)}|desktop`, url: url(4), lastCachedMs: walkedAt },
		],
		{ replicatedConfirmation: 3 }
	);

	assert.deepEqual(deletedKeys, [`${url(1)}|desktop`]);
	assert.deepEqual(result, { deleted: 1, changed: 3 });
	assert.equal(transactions.length, 1, 'one commit per batch');
	assert.equal(transactions[0].replicatedConfirmation, 3);
});

test('a stop lands during a long pacing window, not after it', async () => {
	// One 10-page batch at 1 page/s is a 10s window. Sliced, the stop is seen within one slice.
	const slept = [];
	let stop = false;
	const { stats } = await run(
		Array.from({ length: 20 }, (_, i) => page(i)),
		{
			batchSize: 10,
			ratePerSecond: 1,
			pause: async (ms) => {
				slept.push(ms);
				if (slept.length === 2) stop = true;
			},
			isCanceled: () => stop,
		}
	);
	assert.equal(slept.length, 2, 'the pause ended at the first slice after the stop');
	assert.ok(
		slept.every((ms) => ms <= 500),
		'no single sleep is longer than a slice'
	);
	assert.equal(stats.canceled, true);
	assert.equal(stats.deleted, 10, 'the second batch was never started');
});
