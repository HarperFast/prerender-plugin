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
			// the keyset walk over cacheKey that walkUrlRange performs
			if (poisonProbe && query.limit === 1 && !query.select) {
				return (async function* () {
					yield {}; // an unreadable row past the cursor
				})();
			}
			const keys = [...table.keys()].sort();
			const from = cond?.value ?? '';
			const inclusive = cond?.comparator !== 'greater_than';
			const picked = keys.filter((k) => (inclusive ? k >= from : k > from)).slice(0, query.limit ?? Infinity);
			const rows = picked.map((k) => ({ ...table.get(k) }));
			onKeysetSearch?.();
			return (async function* () {
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
					return closed;
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
	listeners = new Set();
	table = new Map();
});

const started = async (opts = {}) => {
	const s = service.createKeeperService({ log: null, ...opts });
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

test('a load that cannot get past an unreadable row goes live on what it read, not exact', async () => {
	const now = Date.now();
	seed([row(item(1), now - HOUR), row(item(2), now - HOUR)]);
	poisonProbe = true;
	const s = await started();
	assert.equal(s.phase, 'live', 'a partial queue, never none: there is no other path to the queue');
	assert.equal(s.keeper.size, 2);
	assert.match(s.stats.partialLoad, /cannot advance/);
	s.writeState();
	assert.equal((await PrerenderAdmin.queueState().json()).trust.exact, false);
	assert.equal((await funnel.claimSchedules({ grantLimit: 5 })).jobs.length, 2);
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

test('a change of cluster membership after going live rebuilds the keeper', async () => {
	const now = Date.now();
	seed(Array.from({ length: 40 }, (_, i) => row(item(i), now - HOUR)));
	const s = await started();
	assert.equal(s.keeper.size, 40);
	server.nodes = [...CLUSTER, { name: 'node-c' }];
	await s.publish();
	await settle();
	assert.equal(s.phase, 'live');
	assert.ok(s.keeper.size < 40, 'the rows node-c now owns were dropped');
	s.stop();
	server.nodes = CLUSTER;
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

test('a rebuild that lands while the subscribe is in flight leaves exactly one subscription', async () => {
	seed([row(item(1), Date.now() - HOUR)]);
	let release;
	subscribeDelay = new Promise((resolve) => (release = resolve));
	const s = service.createKeeperService({ log: null });
	const first = s.start();
	await settle();
	const second = s.rebuild('test');
	release();
	await Promise.all([first, second]);
	await settle();
	assert.equal(listeners.size, 1);
	assert.equal(s.phase, 'live');
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

test('a keeper that is not live, or has gone quiet, grants nothing and reports unready', async () => {
	const now = Date.now();
	seed([row(item(1), now - HOUR)]);
	const before = await funnel.claimSchedules({ grantLimit: 5 });
	assert.equal(before.jobs.length, 0, 'no keeper yet');
	assert.equal(before.keeperServed, false);
	assert.equal(funnel.deriveQueueStatus(), 'unready');

	const s = await started();
	const realNow = Date.now;
	try {
		Date.now = () => realNow() + 5 * 60_000; // no heartbeat for five minutes
		const stale = await funnel.claimSchedules({ grantLimit: 5 });
		assert.equal(stale.jobs.length, 0, 'stale: nothing granted');
		assert.equal(stale.keeperServed, false);
		assert.equal(funnel.deriveQueueStatus(), 'unready');
	} finally {
		Date.now = realNow;
	}
	assert.equal(indexSearches, 0);
	s.stop();
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
	seed([row(item(1), now - HOUR), row(item(2), now - 2 * HOUR)]);
	const s = await started();
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

test('a repair never reverts a newer event that lands during its read', async () => {
	const now = Date.now();
	seed([row(item(1), now - HOUR)]);
	const s = await started();
	s.keeper.apply(item(1), null); // looks missing to the walk
	onPointRead = (id) => {
		if (id !== item(1)) return;
		onPointRead = null;
		// While the repair reads the (still due) row, a reschedule commits and its event arrives.
		table.set(item(1), row(item(1), now + 48 * HOUR));
		emit('put', item(1), table.get(item(1)));
	};
	await s.verify();
	assert.equal(s.keeper.dueMinuteOf(item(1)), Math.floor((now + 48 * HOUR) / MINUTE), 'the event won');
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

test('live config: a route change rebuilds the keeper, an interval change re-arms it', async () => {
	const now = Date.now();
	seed([row(item(1), now - HOUR), row(HOME, now - HOUR)]);
	service.startQueueKeeper();
	await settle();
	const s = service.keeperService();
	assert.equal(s.phase, 'live');
	const loadedAt = s.stats.loadedAt;

	applyOptions({ queue: { keeper: { publishInterval: 2_000 } } });
	assert.equal(s.stats.loadedAt, loadedAt, 'an interval change does not reload');

	await new Promise((resolve) => setTimeout(resolve, 5));
	applyOptions({
		ingress: {
			mode: 'forwarded',
			routes: [{ match: 'exact', path: '/', queryParams: [], renderInterval: 2 * HOUR }],
		},
	});
	await settle();
	assert.equal(s.phase, 'live');
	assert.ok(s.stats.loadedAt > loadedAt, 'reloaded');
	s.stop();
});
