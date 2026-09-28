import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The queue keeper's service (`util/queueKeeperService.js`) and everything that reads it — the claim
 * path, the backlog snapshot and `GET /prerender_admin/queue-state` — against a fake schedule table
 * with a keyset search, an index search, point reads and a subscription the test drives.
 *
 * The keeper is the index here and `RenderSchedule` its durable side. What is pinned, and why each is
 * a bug nothing else would catch:
 *
 *   - CLAIMS ARE SERVED FROM THE KEEPER AND NOTHING ELSE. A short claim is short, and while the keeper
 *     is not live or has gone quiet nothing is granted and the claim reports `queued`.
 *   - A KEY PUBLISHED IN TWO GENERATIONS IS GRANTED ONCE, however the claims interleave (#218).
 *   - EVERY GRANT IS CHECKED AGAINST THE DURABLE ROW, so an entry the keeper has not yet seen
 *     rescheduled or deleted is skipped, never rendered — and the renderer gets the live fromSitemap.
 *   - REPAIRS COME FROM THE TABLE AND NEVER REVERT A NEWER EVENT. The head of each publish and the
 *     verification walk repair what the keeper holds wrongly (missing, mismatched, deleted).
 *   - A WRITE DURING THE LOAD IS NOT REVERTED, and a node list that changes during the load reloads.
 *   - A ROW THIS NODE DOES NOT OWN IS NEVER HELD, and membership changes rebuild.
 *   - ONLY PUTS AND DELETES CHANGE A ROW. A `message` published to the table must not remove one.
 *   - NO SUBSCRIPTION OUTLIVES A STOP, even a stop that lands while the subscribe is in flight.
 *   - EVERY READ IS LOCAL, and QUEUE STATE NEVER PASSES FOR AN EMPTY QUEUE.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ORIGIN = 'https://www.example.com';

let config, applyOptions, service, funnel, backlog, PrerenderAdmin, residency;
const sabs = new Map();
let table = new Map();
let listeners = new Set();
let searchOptionsSeen = [];
let indexSearches = 0;
let onKeysetSearch = null;
let subscribeDelay = null;
let onPointRead = null;
/** When set, the walk's one-row forward probe finds a row whose key did not decode. */
let poisonProbe = false;
/** ...and with this, so does every read from the top down: the rows past it cannot be reached. */
let poisonTail = false;

before(async () => {
	globalThis.Resource = class {
		static loadAsInstance;
	};
	globalThis.server = {
		hostname: 'node-a',
		workerIndex: 0,
		nodes: [],
		recordAnalytics() {},
		config: { http: { securePort: 9926 } },
	};
	globalThis.logger = { info() {}, warn() {}, error() {}, notify() {}, debug() {}, trace() {} };
	globalThis.contentTypes = { set() {} };
	globalThis.transaction = (fn) => fn({});

	const primaryStore = {
		getUserSharedBuffer: (key, buffer) => {
			if (!sabs.has(key)) sabs.set(key, buffer);
			return sabs.get(key);
		},
		tryLock: () => true,
		unlock() {},
	};
	const RenderSchedule = {
		put: async (cacheKey, row) => table.set(cacheKey, { cacheKey, ...row }),
		delete: async (cacheKey) => table.delete(cacheKey),
		get: async (query, options) => {
			searchOptionsSeen.push(options);
			const id = typeof query === 'object' ? query.id : query;
			const row = table.get(id);
			const copy = row ? { ...row } : undefined;
			await onPointRead?.(id);
			return copy;
		},
		search: (query, options) => {
			searchOptionsSeen.push(options);
			const cond = query.conditions?.[0];
			if (cond?.attribute === 'nextRenderTime') {
				indexSearches++;
				const rows = [...table.values()]
					.filter((r) => Number(r.nextRenderTime) >= cond.value)
					.sort((a, b) => Number(a.nextRenderTime) - Number(b.nextRenderTime) || (a.cacheKey < b.cacheKey ? -1 : 1))
					.slice(0, query.limit);
				return (async function* () {
					for (const row of rows) yield { ...row };
				})();
			}
			// the keyset walks over cacheKey: walkUrlRange's ascending one, and the descending tail walk
			if (poisonProbe && query.limit === 1 && !query.select) {
				return (async function* () {
					yield {}; // an unreadable row past the cursor
				})();
			}
			if (poisonTail && query.sort?.descending) {
				return (async function* () {
					for (let i = 0; i < (query.limit ?? 1); i++) yield {}; // nothing readable from the top either
				})();
			}
			const descending = !!query.sort?.descending;
			const keys = [...table.keys()].sort();
			if (descending) keys.reverse();
			const value = cond?.value ?? '';
			const test = {
				greater_than: (k) => k > value,
				greater_than_equal: (k) => k >= value,
				less_than: (k) => k < value,
			}[cond?.comparator ?? 'greater_than_equal'];
			const picked = keys.filter(test).slice(0, query.limit ?? Infinity);
			const rows = picked.map((k) => ({ ...table.get(k) }));
			const hold = onKeysetSearch?.();
			return (async function* () {
				if (hold) await hold;
				for (const row of rows) yield row;
			})();
		},
		// One record per subscription, as Harper keeps one per call even for the same listener function.
		subscribe: async ({ listener }) => {
			if (subscribeDelay) await subscribeDelay;
			const record = { listener };
			listeners.add(record);
			let closed = false;
			return {
				get closed() {
					return closed || record.closed === true; // a test closes it by marking the record
				},
				end: () => {
					closed = true;
					listeners.delete(record);
				},
			};
		},
	};
	const mkTable = () =>
		class FakeTable {
			static async get() {
				return null;
			}
			static async put() {}
			static async delete() {
				return true;
			}
			static async *search() {}
			static async subscribe() {}
			static primaryStore = primaryStore;
		};
	globalThis.databases = new Proxy(
		{},
		{
			get: (_, db) => {
				if (db === 'render_schedule') return { RenderSchedule };
				if (db === 'coordination') return { SharedBuffer: { primaryStore } };
				return new Proxy({}, { get: () => mkTable() });
			},
		}
	);

	({ config, applyOptions } = await import('../src/config.js'));
	funnel = await import('../src/util/renderSchedule.js');
	service = await import('../src/util/queueKeeperService.js');
	backlog = await import('../src/util/backlogSnapshot.js');
	residency = await import('../src/util/residency.js');
	({ PrerenderAdmin } = await import('../src/resources/PrerenderAdmin.js'));

	// ONE CLUSTER FOR THE WHOLE FILE. `util/residency.js` deliberately latches the last non-empty node
	// list (an empty one is "not known yet", never "no peers"), so a test cannot go back to a single
	// node once another has named a peer. Pick the peer so the homepage is node-a's.
	for (let i = 0; ; i++) {
		CLUSTER = [{ name: 'node-a' }, { name: `peer-${i}` }];
		server.nodes = CLUSTER;
		if (residency.getResidencyByUrl(HOME) === 'node-a') break;
	}
});

let CLUSTER;
const HOME = `${ORIGIN}/`;

const withRoutes = () =>
	applyOptions({
		ingress: {
			mode: 'forwarded',
			routes: [
				{ match: 'exact', path: '/', queryParams: [], renderInterval: HOUR },
				{ match: 'prefix', path: '/item/', queryParams: [], renderInterval: 48 * HOUR },
			],
		},
	});

const itemKey = (n) => `${ORIGIN}/item/${n}`;
/** The nth item node-a owns, so every fixture row is one this node would hold. */
const owned = [];
const item = (n) => {
	for (let i = owned.length ? owned.at(-1).i + 1 : 0; owned.length <= n; i++) {
		if (residency.getResidencyByUrl(itemKey(i)) === 'node-a') owned.push({ i, key: itemKey(i) });
	}
	return owned[n].key;
};
const row = (cacheKey, nextRenderTime, fromSitemap = true) => ({ cacheKey, nextRenderTime, fromSitemap });
const seed = (rows) => {
	table = new Map(rows.map((r) => [r.cacheKey, r]));
};
const emit = (type, id, value, localTime = Date.now()) => {
	for (const { listener } of listeners) listener({ type, id, value, version: localTime, localTime });
};
const settle = async () => {
	for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
};

beforeEach(() => {
	withRoutes();
	for (const buffer of sabs.values()) new Uint8Array(buffer).fill(0);
	server.nodes = CLUSTER;
	config.queue.ready.sitemapBoost = 2;
	searchOptionsSeen = [];
	indexSearches = 0;
	onKeysetSearch = null;
	subscribeDelay = null;
	onPointRead = null;
	poisonProbe = false;
	poisonTail = false;
	listeners = new Set();
	table = new Map();
});

const started = async (opts = {}) => {
	const s = service.createKeeperService({ log: null, countPeers: async () => 1, ...opts });
	await s.start();
	return s;
};

// ---- load and live updates -------------------------------------------------------------------------

test('loads the table, goes live, and publishes the ready set in score order', async () => {
	const now = Date.now();
	seed([
		row(item(1), now - 3 * HOUR), // 3h / 48h
		row(HOME, now - 2 * HOUR), // 2h / 1h: first
		row(item(2), now + HOUR), // not due
	]);
	const s = await started();
	assert.equal(s.phase, 'live');
	assert.equal(s.keeper.size, 3);
	assert.deepEqual(
		funnel
			.readyQueue()
			.peek(5)
			.map((e) => e.cacheKey),
		[HOME, item(1)]
	);
	s.stop();
});

test('every read the load and the claim point reads make is local', async () => {
	seed([row(item(1), Date.now() - HOUR)]);
	const s = await started();
	assert.ok(searchOptionsSeen.length > 1);
	for (const options of searchOptionsSeen) assert.equal(options?.replicateFrom, false);
	s.stop();
});

test('a write during the load is applied after it, so the walk cannot revert it', async () => {
	const now = Date.now();
	seed([row(item(1), now - 5 * HOUR), row(item(2), now - 4 * HOUR)]);
	onKeysetSearch = () => {
		onKeysetSearch = null;
		table.set(item(1), row(item(1), now + 10 * HOUR));
		emit('put', item(1), table.get(item(1)));
	};
	const s = await started();
	assert.equal(s.keeper.dueSummary(now).due, 1, 'item(1) was moved to the future during the load');
	s.stop();
});

test('only the LAST event per row during the load is applied, and a whole-table re-send fits', async () => {
	const now = Date.now();
	seed([row(item(1), now - 5 * HOUR), row(item(2), now - 4 * HOUR)]);
	onKeysetSearch = () => {
		onKeysetSearch = null;
		emit('put', item(1), row(item(1), now + HOUR));
		emit('delete', item(1));
		emit('put', item(1), row(item(1), now + 10 * HOUR));
		// more events than the old 200k cap would have allowed, as a base-copy re-send could deliver
		for (let i = 0; i < 250_000; i++) emit('put', item(2), row(item(2), now - 4 * HOUR));
	};
	const s = await started();
	assert.equal(s.phase, 'live');
	assert.equal(s.keeper.dueMinuteOf(item(1)), Math.floor((now + 10 * HOUR) / MINUTE), 'the last event won');
	assert.equal(s.keeper.has(item(2)), true);
	s.stop();
});

test('an unreadable row stops the ascending walk; the rest is read from the top down', async () => {
	const now = Date.now();
	seed([row(item(1), now - HOUR), row(item(2), now - HOUR)]);
	poisonProbe = true;
	const s = await started();
	assert.equal(s.phase, 'live');
	assert.equal(s.keeper.size, 2);
	assert.equal(s.stats.partialLoad, null, 'the tail walk reached the stopping point: nothing is missing');
	s.stop();
});

test('if the tail cannot be read either, it goes live on what it read, not exact', async () => {
	const now = Date.now();
	seed([row(item(1), now - HOUR), row(item(2), now - HOUR)]);
	poisonProbe = true;
	poisonTail = true;
	const s = await started();
	assert.equal(s.phase, 'live', 'a partial queue, never none: there is no other path to the queue');
	assert.equal(s.keeper.size, 2);
	assert.match(s.stats.partialLoad, /cannot advance/);
	s.writeState();
	assert.equal((await PrerenderAdmin.queueState().json()).trust.exact, false);
	assert.equal((await funnel.claimSchedules({ grantLimit: 5 })).jobs.length, 2);
	s.stop();
});

test('claims are served while the table is still loading', async () => {
	const now = Date.now();
	seed(Array.from({ length: 3 }, (_, i) => row(item(i), now - HOUR)));
	let release;
	const gate = new Promise((resolve) => (release = resolve));
	let calls = 0;
	onKeysetSearch = () => {
		if (++calls === 2) return gate; // hold the walk after its first chunk
	};
	const s = service.createKeeperService({ log: null, countPeers: async () => 1 });
	const loading = s.start();
	await settle();
	await s.publish();
	assert.equal(s.phase, 'loading');
	assert.ok(funnel.readKeeperSignal().serving, 'serving from the first chunk');
	release();
	await loading;
	assert.equal(s.phase, 'live');
	s.stop();
});

test('live events move, add and remove rows; only puts and deletes change a row', async () => {
	const now = Date.now();
	seed([row(item(1), now - HOUR)]);
	const s = await started();
	emit('put', item(2), row(item(2), now - 2 * HOUR));
	emit('put', item(1), row(item(1), now + 48 * HOUR));
	emit('delete', item(99));
	assert.equal(s.keeper.size, 2);
	assert.equal(s.keeper.dueSummary(now).due, 1);
	emit('message', item(2), { note: 'published to the table' });
	emit('end_txn', item(2));
	assert.equal(s.keeper.has(item(2)), true, 'a message says nothing about the row');
	emit('delete', item(2));
	assert.equal(s.keeper.has(item(2)), false);
	s.stop();
});

// ---- ownership -------------------------------------------------------------------------------------

test('a row another node owns is never held or ranked', async () => {
	const now = Date.now();
	const rows = Array.from({ length: 40 }, (_, i) => row(itemKey(i), now - HOUR));
	seed(rows);
	const mine = rows.filter((r) => residency.getResidencyByUrl(r.cacheKey) === 'node-a');
	assert.ok(mine.length > 0 && mine.length < rows.length, 'the fixture must split between nodes');
	const s = await started();
	assert.equal(s.keeper.size, mine.length);
	for (const entry of funnel.readyQueue().peek(100)) {
		assert.equal(residency.getResidencyByUrl(entry.cacheKey), 'node-a');
	}
	s.stop();
});

test('a node list that changes during the load loads again, under the new list', async () => {
	const now = Date.now();
	seed(Array.from({ length: 40 }, (_, i) => row(item(i), now - HOUR)));
	onKeysetSearch = () => {
		onKeysetSearch = null;
		server.nodes = [...CLUSTER, { name: 'node-c' }];
	};
	const s = await started();
	await settle();
	assert.equal(s.phase, 'live');
	for (let i = 0; i < 40; i++) {
		assert.equal(s.keeper.has(item(i)), residency.getResidencyByUrl(item(i)) === 'node-a');
	}
	s.stop();
	server.nodes = CLUSTER;
});

test('a change of cluster membership resyncs in memory while serving, and a walk adds rows gained', async () => {
	const now = Date.now();
	seed(Array.from({ length: 40 }, (_, i) => row(item(i), now - HOUR)));
	const s = await started();
	const loadedAt = s.stats.loadedAt;
	assert.equal(s.keeper.size, 40);
	server.nodes = [...CLUSTER, { name: 'node-c' }];
	await s.publish();
	for (let i = 0; i < 5 && s.stats.lastResync === null; i++) await settle();
	assert.equal(s.phase, 'live');
	assert.equal(s.stats.loadedAt, loadedAt, 'never reloaded');
	assert.ok(s.keeper.size < 40, 'the rows node-c now owns were dropped');
	assert.ok(s.stats.lastResync.dropped > 0);
	assert.ok(funnel.readKeeperSignal().serving, 'serving throughout');
	// ...and back: the rows it owns again are found by the walk
	server.nodes = CLUSTER;
	await s.publish();
	for (let i = 0; i < 5 && s.keeper.size < 40; i++) await settle();
	assert.equal(s.keeper.size, 40, 'the walk added the rows this node owns again');
	s.stop();
});

// ---- lifecycle -------------------------------------------------------------------------------------

test('a stop that lands while the subscribe is in flight leaves no subscription behind', async () => {
	seed([row(item(1), Date.now() - HOUR)]);
	let release;
	subscribeDelay = new Promise((resolve) => (release = resolve));
	const s = service.createKeeperService({ log: null });
	const loading = s.start();
	await settle();
	s.stop();
	release();
	await loading;
	await settle();
	assert.equal(listeners.size, 0, 'no listener still registered');
	assert.equal(s.subscriptionOpen, false);
	assert.equal(s.phase, 'stopped');
});

test('a walk a resync needs is not lost when a verification is already running', async () => {
	const now = Date.now();
	seed(Array.from({ length: 40 }, (_, i) => row(itemKey(i), now - HOUR)));
	const s = await started();
	const heldBefore = s.keeper.size;
	let release;
	const gate = new Promise((resolve) => (release = resolve));
	onKeysetSearch = () => {
		onKeysetSearch = null;
		return gate; // the periodic verification is part-way through
	};
	const periodic = s.verify();
	await settle();
	// A peer leaves: rows move to this node, some in the part the running walk has already passed.
	server.nodes = [{ name: 'node-a' }];
	await s.resync('membership', { walk: true });
	release();
	await periodic;
	for (let i = 0; i < 10 && s.keeper.size < 40; i++) await settle();
	assert.ok(heldBefore < 40);
	assert.equal(s.keeper.size, 40, 'the queued walk ran and found the rows this node now owns');
	s.stop();
	server.nodes = CLUSTER;
});

test('a resubscribe that fails is tried again, after a backoff', async () => {
	seed([row(item(1), Date.now() - HOUR)]);
	let clock = Date.now();
	const s = await started({ now: () => clock, retryMs: 5_000 });
	const [record] = listeners;
	record.closed = true;
	let failNext = true;
	const RS = databases.render_schedule.RenderSchedule;
	const real = RS.subscribe;
	RS.subscribe = async (opts) => {
		if (failNext) {
			failNext = false;
			throw new Error('subscribe refused');
		}
		return real(opts);
	};
	try {
		await s.publish(); // sees the closed subscription: the resync fails
		await settle();
		assert.equal(s.subscriptionOpen, false);
		await s.publish();
		await settle();
		assert.equal(s.subscriptionOpen, false, 'not hammered: waits out the backoff');
		clock += 5_001;
		await s.publish();
		for (let i = 0; i < 5 && !s.subscriptionOpen; i++) await settle();
		assert.equal(s.subscriptionOpen, true, 'tried again, and open');
		assert.ok(funnel.readKeeperSignal().serving, 'serving throughout');
	} finally {
		RS.subscribe = real;
		s.stop();
	}
});

test('a config change during the load is applied when the load ends', async () => {
	const now = Date.now();
	seed([row(HOME, now - HOUR), row(item(1), now - HOUR)]);
	let release;
	const gate = new Promise((resolve) => (release = resolve));
	let calls = 0;
	onKeysetSearch = () => {
		if (++calls === 2) return gate;
	};
	const s = service.createKeeperService({ log: null, countPeers: async () => 1 });
	const loading = s.start();
	await settle();
	assert.equal(s.phase, 'loading');
	applyOptions({
		ingress: { mode: 'forwarded', routes: [{ match: 'exact', path: '/', queryParams: [], renderInterval: 3 * HOUR }] },
	});
	s.resync('the routes changed');
	release();
	await loading;
	for (let i = 0; i < 5 && s.keeper.describe(HOME)?.cadenceMs !== 3 * HOUR; i++) await settle();
	assert.equal(s.keeper.describe(HOME).cadenceMs, 3 * HOUR, 'reclassified under the new route once live');
	s.stop();
});

test('a resync reopens a closed subscription and goes on serving throughout', async () => {
	seed([row(item(1), Date.now() - HOUR)]);
	const s = await started();
	const [record] = listeners;
	record.closed = true;
	const gen = funnel.readyQueue().state().generation;
	await s.resync('test', { resubscribe: true, walk: true });
	assert.equal(listeners.size, 1, 'exactly one subscription');
	assert.equal(s.phase, 'live');
	assert.ok(funnel.readyQueue().state().count > 0, 'never withdrawn');
	assert.ok(funnel.readyQueue().state().generation >= gen);
	s.stop();
	assert.equal(listeners.size, 0);
});

// ---- publishing ------------------------------------------------------------------------------------

test('a publish nothing changed is skipped, and a claim that takes from the set republishes', async () => {
	seed([row(item(1), Date.now() - HOUR), row(item(2), Date.now() - 2 * HOUR)]);
	const s = await started();
	const gen = funnel.readyQueue().state().generation;
	await s.publish();
	assert.equal(funnel.readyQueue().state().generation, gen, 'nothing changed');
	await funnel.claimSchedules({ grantLimit: 1 });
	await s.publish();
	assert.ok(funnel.readyQueue().state().generation > gen, 'the lease and the cursor moved');
	assert.equal(funnel.readyQueue().peek(5).length, 1, 'the leased row is skipped');
	s.stop();
});

test('stopping withdraws the set, so no stale generation is served', async () => {
	seed([row(item(1), Date.now() - HOUR)]);
	const s = await started();
	assert.equal(funnel.readyQueue().state().count, 1);
	s.stop();
	assert.equal(funnel.readyQueue().state().count, 0);
});

// ---- the keeper is the index ----------------------------------------------------------------------

test('claims are served from the keeper without reading any index, and a short claim is short', async () => {
	const now = Date.now();
	seed([row(HOME, now - 2 * HOUR), row(item(1), now - HOUR), row(item(2), now - 2 * HOUR)]);
	const s = await started();
	indexSearches = 0;
	const pass = await funnel.claimSchedules({ grantLimit: 5 });
	assert.equal(indexSearches, 0);
	assert.equal(pass.keeperServed, true);
	assert.equal(pass.jobs[0].cacheKey, HOME, 'keeper order');
	assert.equal(pass.jobs.length, 3);
	const again = await funnel.claimSchedules({ grantLimit: 5 });
	assert.equal(again.jobs.length, 0);
	assert.equal(again.sawDue, true, 'all three in flight: still queued, never empty');
	assert.equal(indexSearches, 0);
	s.stop();
});

test('a claim checks each entry against its durable row: a rescheduled one is skipped, not rendered', async () => {
	const now = Date.now();
	seed([row(item(1), now - HOUR), row(item(2), now - 2 * HOUR, false)]);
	const s = await started();
	// Rendered and rescheduled by the table; the keeper has not seen the event yet.
	table.set(item(2), row(item(2), now + 48 * HOUR, false));
	// And the sitemap flag changed on the other row since the keeper published it.
	table.set(item(1), row(item(1), now - HOUR, false));
	const pass = await funnel.claimSchedules({ grantLimit: 5 });
	assert.deepEqual(
		pass.jobs.map((j) => j.cacheKey),
		[item(1)]
	);
	assert.equal(pass.skippedStale, 1);
	assert.equal(pass.jobs[0].fromSitemap, false, 'the live flag, from the durable row');
	s.stop();
});

test('a key longer than its ready-set budget is published and granted like any other', async () => {
	const now = Date.now();
	let long = null;
	for (let i = 0; !long; i++) {
		const key = `${ORIGIN}/item/${i}/${'x'.repeat(600)}`;
		if (residency.getResidencyByUrl(key) === 'node-a') long = key;
	}
	seed([row(item(1), now - HOUR), row(long, now - 2 * HOUR)]);
	const s = await started();
	const pass = await funnel.claimSchedules({ grantLimit: 5 });
	assert.ok(pass.jobs.some((j) => j.cacheKey === long));
	assert.equal(indexSearches, 0);
	s.stop();
});

test('a key published in two generations is granted once, however the claims interleave (#218)', async () => {
	// The first claim takes item(1) and is still reading its durable row when the keeper republishes
	// (the cursor moved, so the key is in the new generation too) and a second claim takes it from
	// there. The lease grant is exclusive, so exactly one of them is granted.
	const now = Date.now();
	seed([row(item(1), now - HOUR)]);
	const s = await started();
	let interleaved = false;
	let second = null;
	onPointRead = async (id) => {
		if (id !== item(1) || interleaved) return;
		interleaved = true;
		await s.publish();
		second = await funnel.claimSchedules({ grantLimit: 1 });
	};
	const first = await funnel.claimSchedules({ grantLimit: 1 });
	assert.ok(interleaved && second, 'the claims interleaved');
	assert.deepEqual(
		[...first.jobs, ...second.jobs].map((j) => j.cacheKey),
		[item(1)],
		'one grant between them'
	);
	s.stop();
});

test('before its first publish nothing is granted; a keeper gone quiet is still served from', async () => {
	const now = Date.now();
	seed([row(item(1), now - HOUR), row(item(2), now - HOUR)]);
	const before = await funnel.claimSchedules({ grantLimit: 5 });
	assert.equal(before.jobs.length, 0, 'no keeper yet');
	assert.equal(before.keeperServed, false);
	assert.equal(funnel.deriveQueueStatus(), 'unready');

	const s = await started();
	const realNow = Date.now;
	try {
		Date.now = () => realNow() + 5 * 60_000; // no heartbeat for five minutes: worker 0 stalled
		assert.equal(funnel.readKeeperSignal().stale, true, 'reported');
		const stale = await funnel.claimSchedules({ grantLimit: 1 });
		assert.equal(stale.jobs.length, 1, 'its last set is still granted from, each entry checked against its row');
	} finally {
		Date.now = realNow;
	}
	s.stop();
	assert.equal((await funnel.claimSchedules({ grantLimit: 5 })).jobs.length, 0, 'a stop withdraws the set');
	assert.equal(indexSearches, 0);
});

test('the keeper announces its own transitions: queued when it goes live, unready when it stops', async () => {
	const { QueueState } = await import('../src/resources/QueueState.js');
	QueueState.reportStatus('empty', true);
	seed([row(item(1), Date.now() - HOUR)]);
	const s = await started();
	await settle();
	assert.equal(QueueState.status, 'queued', 'live with a due row: the fleet is woken now, not at the next sync');
	s.stop();
	await settle();
	assert.equal(QueueState.status, 'unready');
});

test('a key whose leases keep expiring with no result is held back, ever longer, until a result comes', async () => {
	const realNow = Date.now;
	let clock = realNow();
	Date.now = () => clock;
	try {
		seed([row(item(1), clock - HOUR)]);
		const s = await started({ now: () => clock });
		const lease = config.queue.jobLeaseTime;
		const claimOne = async () => {
			await s.publish();
			return funnel.claimSchedules({ grantLimit: 1 });
		};
		const limit = config.render.failureRetry.fastRetries + 2;
		for (let i = 0; i < limit; i++) {
			assert.equal((await claimOne()).jobs.length, 1, `lease ${i + 1} granted`);
			clock += lease + 1_000; // expires with no result: a renderer crash, or a result that never arrives
		}
		let pass = await claimOne();
		assert.equal(pass.jobs.length, 0, 'held back, not granted again');
		assert.equal(pass.wedged[0].cacheKey, item(1));
		assert.equal(pass.wedged[0].backoff, 2 * lease, 'two leases first');
		assert.equal(Number(table.get(item(1)).nextRenderTime) <= clock, true, 'nothing durable was written');

		clock += 2 * lease + 1_000;
		assert.equal((await claimOne()).jobs.length, 1, 'one more attempt once the hold ends');
		clock += lease + 1_000; // ...which fails to report too
		pass = await claimOne();
		assert.equal(pass.wedged[0].backoff, 4 * lease, 'and the next hold is twice as long');

		clock += 4 * lease + 1_000;
		assert.equal((await claimOne()).jobs.length, 1);
		funnel.releaseLease(item(1)); // a result arrives
		clock += lease + 1_000;
		pass = await claimOne();
		assert.equal(pass.jobs.length, 1, 'a result resets the count: granted normally again');
		assert.deepEqual(pass.wedged, []);
		s.stop();
	} finally {
		Date.now = realNow;
	}
});

test('a publish still in flight does not stop the heartbeat', async () => {
	const now = Date.now();
	seed([row(item(1), now - HOUR)]);
	let clock = now;
	const s = await started({ now: () => clock });
	let unblock;
	onPointRead = () => new Promise((resolve) => (unblock = resolve));
	emit('put', item(2), row(item(2), now - HOUR)); // a change, so the next publish runs its head check
	table.set(item(2), row(item(2), now - HOUR));
	const slow = s.publish();
	await settle();
	assert.ok(unblock, 'the head check is waiting on a point read');
	clock += 3_000;
	await s.publish();
	assert.equal(funnel.readKeeperSignal(clock).heartbeatAt, Math.round(clock / 1000) * 1000);
	onPointRead = null;
	unblock();
	await slow;
	s.stop();
});

test('a publish nothing changed still refreshes the heartbeat', async () => {
	seed([row(item(1), Date.now() - HOUR)]);
	let clock = Date.now();
	const s = await started({ now: () => clock });
	const before = funnel.readKeeperSignal(clock).heartbeatAt;
	clock += 3_000;
	await s.publish();
	assert.ok(funnel.readKeeperSignal(clock).heartbeatAt > before);
	s.stop();
});

// ---- repairs from the table ------------------------------------------------------------------------

test('the head of each publish is checked against the table and repaired', async () => {
	const now = Date.now();
	let clock = now;
	seed([row(item(1), now - HOUR), row(item(2), now - 2 * HOUR)]);
	const s = await started({ now: () => clock });
	clock += 61_000; // each key is re-checked at most once a minute
	// The table moved item(2) to the future; the event never came.
	table.set(item(2), row(item(2), now + 48 * HOUR));
	emit('put', item(3), row(item(3), now - 3 * HOUR)); // something changes, so the next publish runs
	table.set(item(3), row(item(3), now - 3 * HOUR));
	await s.publish();
	assert.equal(s.keeper.dueMinuteOf(item(2)), Math.floor((now + 48 * HOUR) / MINUTE), 'repaired');
	assert.ok(s.stats.topCheck.repaired >= 1);
	s.stop();
});

test('the verification walk repairs a missing row, a mismatched one and a deleted one', async () => {
	const now = Date.now();
	seed([row(item(1), now - HOUR), row(item(2), now - 2 * HOUR), row(item(3), now + HOUR)]);
	const s = await started();
	s.keeper.apply(item(1), null); // lost
	table.set(item(3), row(item(3), now + 5 * HOUR)); // moved, event lost
	table.delete(item(2)); // deleted, event lost
	const result = await s.verify();
	assert.equal(result.missing, 1);
	assert.equal(result.mismatched, 1);
	assert.equal(result.phantoms, 1);
	assert.equal(result.repaired, 3);
	assert.equal(s.keeper.has(item(1)), true);
	assert.equal(s.keeper.has(item(2)), false);
	assert.equal(s.keeper.dueMinuteOf(item(3)), Math.floor((now + 5 * HOUR) / MINUTE));
	s.writeState();
	const body = await PrerenderAdmin.queueState().json();
	assert.equal(body.trust.exact, false, 'a verification that repaired anything is not exact');
	assert.equal((await s.verify()).repaired, 0, 'and a second walk finds nothing');
	s.stop();
});

test('the verification walk never applies a row older than an event that arrived during it', async () => {
	const now = Date.now();
	seed([row(item(1), now - HOUR)]);
	const s = await started();
	s.keeper.apply(item(1), null); // looks missing to the walk
	onKeysetSearch = () => {
		onKeysetSearch = null;
		// The chunk holding the (still due) row has been read; a reschedule commits and its event arrives
		// before the walk applies that chunk.
		table.set(item(1), row(item(1), now + 48 * HOUR));
		emit('put', item(1), table.get(item(1)));
	};
	await s.verify();
	assert.equal(s.keeper.dueMinuteOf(item(1)), Math.floor((now + 48 * HOUR) / MINUTE), 'the event won');
	s.stop();
});

test('a point-read repair never reverts a newer event that lands during its read', async () => {
	const now = Date.now();
	seed([row(item(1), now - HOUR)]);
	const s = await started();
	s.keeper.apply(item(5), row(item(5), now - HOUR)); // held, but not in the table: a phantom to the walk
	onPointRead = (id) => {
		if (id !== item(5)) return;
		onPointRead = null;
		// While the repair reads the (absent) row, the row is written and its event arrives.
		table.set(item(5), row(item(5), now + 48 * HOUR));
		emit('put', item(5), table.get(item(5)));
	};
	await s.verify();
	assert.equal(s.keeper.dueMinuteOf(item(5)), Math.floor((now + 48 * HOUR) / MINUTE), 'the event won');
	s.stop();
});

test('rows stored here that another node owns are counted by the walk, never held', async () => {
	const now = Date.now();
	let foreign = null;
	for (let i = 0; !foreign; i++) if (residency.getResidencyByUrl(itemKey(i)) !== 'node-a') foreign = itemKey(i);
	seed([row(foreign, now - HOUR), row(item(1), now - 30 * MINUTE)]);
	const s = await started();
	const result = await s.verify();
	assert.equal(result.unowned, 1);
	assert.equal(s.keeper.has(foreign), false);
	s.stop();
});

// ---- queue state -----------------------------------------------------------------------------------

test('the state document serves the backlog snapshot, and only while it is live and fresh', async () => {
	const now = Date.now();
	seed([row(item(1), now - HOUR), row(item(2), now + 90 * MINUTE), row(HOME, now - 5 * MINUTE)]);
	const s = await started();
	const stats = backlog.upcomingFromKeeper(Date.now());
	assert.equal(stats.source, 'keeper');
	assert.equal(stats.overdue, 2);
	assert.equal(stats.truncated, false);
	assert.equal(stats.buckets.length, 24);
	assert.equal(
		stats.buckets.reduce((n, b) => n + b.count, 0),
		1
	);
	assert.equal(backlog.upcomingFromKeeper(Date.now() + 10 * MINUTE), null, 'stale');
	s.stop();
	assert.equal(backlog.upcomingFromKeeper(Date.now()), null, 'stopped');
});

test('GET queue-state answers from the keeper, and 503 whenever it cannot vouch for its numbers', async () => {
	const now = Date.now();
	seed([row(item(1), now - HOUR, true), row(item(2), now - HOUR, false), row(item(3), now + 10 * MINUTE)]);
	const s = await started();
	const res = PrerenderAdmin.queueState();
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(body.schema, service.QUEUE_STATE_SCHEMA);
	assert.equal(body.now.due, 2);
	assert.equal(body.now.dueSitemap, 1);
	assert.equal(body.now.dueDiscovered, 1);
	assert.equal(body.now.inFlight, 0);
	assert.equal(body.now.unclaimed, 2);
	assert.equal(body.coming.next15m, 1);
	assert.equal(body.trust.live, true);
	assert.equal(body.trust.exact, true);
	assert.ok(Array.isArray(body.lateness.byRoute));
	assert.ok(Array.isArray(body.flow));

	s.stop();
	const stopped = PrerenderAdmin.queueState();
	assert.equal(stopped.status, 503);
	const why = await stopped.json();
	assert.equal(why.trust.live, false);
	assert.equal(why.now.due, undefined, 'no counts it cannot vouch for');
	assert.equal(why.trust.phase, 'stopped');
});

// ---- live config -----------------------------------------------------------------------------------

test('live config: a route change reclassifies in memory, without reloading or withdrawing', async () => {
	const now = Date.now();
	seed([row(item(1), now - HOUR), row(HOME, now - HOUR)]);
	service.startQueueKeeper();
	await settle();
	const s = service.keeperService();
	assert.equal(s.phase, 'live');
	const loadedAt = s.stats.loadedAt;
	assert.equal(s.keeper.describe(HOME).cadenceMs, HOUR);

	applyOptions({ queue: { keeper: { publishInterval: 2_000 } } });
	assert.equal(s.stats.loadedAt, loadedAt, 'an interval change does not reload');

	applyOptions({
		ingress: {
			mode: 'forwarded',
			routes: [{ match: 'exact', path: '/', queryParams: [], renderInterval: 2 * HOUR }],
		},
	});
	for (let i = 0; i < 5 && s.keeper.describe(HOME)?.cadenceMs !== 2 * HOUR; i++) await settle();
	assert.equal(s.keeper.describe(HOME).cadenceMs, 2 * HOUR, 'reclassified under the new route');
	assert.equal(s.stats.loadedAt, loadedAt, 'never reloaded');
	assert.ok(funnel.readKeeperSignal().serving);
	s.stop();
});

test('queue-state says when its per-class list was cut, instead of passing a partial list off as whole', async () => {
	const now = Date.now();
	// Each carried cadence is its own class, so 201 distinct intervals is one class past the list cap.
	const rows = Array.from({ length: 201 }, (_, n) => ({
		...row(item(n), now - HOUR),
		effectiveInterval: (60 + n) * MINUTE,
	}));
	seed(rows.slice(0, 3));
	let s = await started();
	s.writeState();
	let body = await PrerenderAdmin.queueState().json();
	assert.equal(body.lateness.listsTruncated, false);
	s.stop();

	seed(rows);
	s = await started();
	s.writeState();
	body = await PrerenderAdmin.queueState().json();
	assert.equal(body.lateness.classes.length, 200);
	assert.equal(body.lateness.listsTruncated, true);
	s.stop();
});

test('a row the change probe marked is loaded as CHANGED and counted in queue-state', async () => {
	// The walk and the head check read by an explicit field list; a list without `changedAt` would load
	// every marked row as routine and the head start would silently never apply.
	const { SCHEDULE_SELECT } = await import('../src/util/renderSchedule.js');
	assert.ok(SCHEDULE_SELECT.includes('changedAt'), 'the keeper load reads the mark');
	const now = Date.now();
	seed([{ ...row(item(1), now - MINUTE), changedAt: now - MINUTE }, row(item(2), now - HOUR)]);
	const s = await started();
	assert.equal(s.keeper.describe(item(1)).changed, true);
	assert.equal(s.keeper.describe(item(2)).changed, false);
	s.writeState();
	const body = await PrerenderAdmin.queueState().json();
	assert.equal(body.now.dueChanged, 1);
	s.stop();
});
