import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * THE DISCOVERY PURGE — bulk removal of discovered (never sitemap-declared) targets under a
 * URL prefix, the cleanup half of the discovery gate.
 *
 * What is pinned here is the refusal set and the deletion predicate, because a purge whose
 * predicate drifts deletes live corpus and a purge whose interlock is skipped re-mints its own
 * work: GATE FIRST is encoded in `validatePurgePrefix` and must stay there.
 */

// The schedule funnel acquires the render-lease buffer at module scope, so the stub has to
// exist before the import — and it has to be KEYED (see reconcile.test.js).
const sabs = new Map();
const sharedBufferStub = {
	getUserSharedBuffer: (key, buffer) => {
		if (!sabs.has(key)) sabs.set(key, buffer);
		return sabs.get(key);
	},
	tryLock: () => true,
	unlock() {},
};

// resources/Target.js extends the raw table class at module scope, so it must be a class.
// `search` returns an ITERABLE, not a promise of one — Harper's does, and `for await` over a
// promise throws.
class FakeTable {
	static async get() {}
	static async put() {}
	static async patch() {}
	static async delete() {}
	static search() {
		return [];
	}
}

let purge, applyOptions;

before(async () => {
	globalThis.server = { hostname: 'node-a', workerIndex: 0, nodes: [], config: { http: {} } };
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {}, notify() {} };
	globalThis.Resource = class {};
	globalThis.databases = {
		coordination: { SharedBuffer: { primaryStore: sharedBufferStub } },
		probe_state: { ProbeState: FakeTable },
		render_service: { Target: FakeTable },
		page_cache: { PrerenderedPage: FakeTable },
		render_schedule: { RenderSchedule: FakeTable },
	};
	({ applyOptions } = await import('../src/config.js'));
	purge = await import('../src/util/discoveredPurge.js');
});

beforeEach(() => {
	applyOptions({});
	purge.resetDiscoveredPurgeState();
});

const newStats = () => ({
	examined: 0,
	owned: 0,
	discovered: 0,
	leaseSkipped: 0,
	deleted: 0,
	visitedSkipped: 0,
	errors: 0,
	errorSamples: [],
	abortedOnErrors: false,
	canceled: false,
});
const row = (url, sitemapUrl = null) => ({ url, sitemapUrl });

test('runner: the predicate is sitemapUrl-null, owner-scoped, with in-flight deferral', async () => {
	const deleted = [];
	const stats = newStats();
	await purge.purgeDiscoveredTargets({
		rows: (async function* () {
			yield row('https://x.example/catalog/a'); // discovered, owned → delete
			yield row('https://x.example/catalog/b', 'https://x.example/sitemap.xml'); // declared → keep
			yield row('https://x.example/catalog/c'); // unowned → not ours
			yield row('https://x.example/catalog/d'); // in flight → deferred
			yield row('https://x.example/catalog/e'); // discovered, owned → delete
		})(),
		ownerOf: (url) => (url.endsWith('/c') ? 'node-b' : 'node-a'),
		hostname: 'node-a',
		isLeased: (url) => url.endsWith('/d'),
		deleteTarget: async (url) => deleted.push(url),
		dryRun: false,
		ratePerSecond: 1_000_000,
		batchSize: 2,
		pause: async () => {},
		stats,
	});
	assert.deepEqual(deleted, ['https://x.example/catalog/a', 'https://x.example/catalog/e']);
	assert.equal(stats.examined, 5);
	assert.equal(stats.owned, 4);
	assert.equal(stats.discovered, 3);
	assert.equal(stats.leaseSkipped, 1);
	assert.equal(stats.deleted, 2);
	assert.equal(stats.canceled, false);
});

test('runner: a dry run counts what it would delete and deletes nothing', async () => {
	const deleted = [];
	const stats = newStats();
	await purge.purgeDiscoveredTargets({
		rows: (async function* () {
			yield row('https://x.example/catalog/a');
			yield row('https://x.example/catalog/b');
		})(),
		ownerOf: () => 'node-a',
		hostname: 'node-a',
		isLeased: () => false,
		deleteTarget: async (url) => deleted.push(url),
		dryRun: true,
		ratePerSecond: 1_000_000,
		pause: async () => {},
		stats,
	});
	assert.deepEqual(deleted, []);
	assert.equal(stats.deleted, 2, 'the census a real run is sized with');
});

test('runner: pacing holds the sustained delete rate to ratePerSecond', async () => {
	const waits = [];
	const stats = newStats();
	await purge.purgeDiscoveredTargets({
		rows: (async function* () {
			for (const name of ['a', 'b', 'c', 'd']) yield row(`https://x.example/catalog/${name}`);
		})(),
		ownerOf: () => 'node-a',
		hostname: 'node-a',
		isLeased: () => false,
		deleteTarget: async () => {},
		dryRun: false,
		ratePerSecond: 2,
		batchSize: 2,
		now: () => 0, // deletes take no time, so the full window remains
		pause: async (ms) => waits.push(ms),
		stats,
	});
	// Two batches of 2 at 2/s → each owes a 1000ms window.
	assert.deepEqual(waits, [1000, 1000]);
	assert.equal(stats.deleted, 4);
});

test('runner: a cancel ends the pass at the next row and says so', async () => {
	const stats = newStats();
	let seen = 0;
	await purge.purgeDiscoveredTargets({
		rows: (async function* () {
			yield row('https://x.example/catalog/a');
			yield row('https://x.example/catalog/b');
			yield row('https://x.example/catalog/c');
		})(),
		ownerOf: () => 'node-a',
		hostname: 'node-a',
		isLeased: () => false,
		deleteTarget: async () => {},
		dryRun: false,
		ratePerSecond: 1_000_000,
		pause: async () => {},
		isCanceled: () => seen++ >= 1,
		stats,
	});
	assert.equal(stats.canceled, true);
	assert.equal(stats.examined, 1);
});

test('walkPrefix: keyset chunks, ge-then-gt, and the walk ends at the first URL past the prefix', async () => {
	const all = [
		'https://x.example/catalog/a',
		'https://x.example/catalog/b',
		'https://x.example/catalog/c',
		'https://x.example/product/prd-1',
	];
	const calls = [];
	const table = {
		search({ conditions, limit }) {
			calls.push(conditions[0]);
			const { comparator, value } = conditions[0];
			return all
				.filter((url) => (comparator === 'greater_than_equal' ? url >= value : url > value))
				.slice(0, limit)
				.map((url) => ({ url, sitemapUrl: null }));
		},
	};
	const seen = [];
	for await (const r of purge.walkPrefix(table, 'https://x.example/catalog/', 2)) seen.push(r.url);
	assert.deepEqual(seen, ['https://x.example/catalog/a', 'https://x.example/catalog/b', 'https://x.example/catalog/c']);
	// First chunk is inclusive of the prefix itself; later chunks resume exclusively after the cursor.
	assert.equal(calls[0].comparator, 'greater_than_equal');
	assert.equal(calls[0].value, 'https://x.example/catalog/');
	assert.equal(calls[1].comparator, 'greater_than');
	assert.equal(calls[1].value, 'https://x.example/catalog/b');
});

test('validatePurgePrefix: refuses junk, bare origins, unrouted prefixes, and ungated routes', () => {
	applyOptions({
		ingress: {
			mode: 'forwarded',
			routes: [
				{ match: 'prefix', path: '/catalog/', discoverTargets: false },
				{ match: 'prefix', path: '/product/prd-' },
			],
		},
	});
	assert.match(purge.validatePurgePrefix('not-a-url').message, /absolute http/);
	assert.match(purge.validatePurgePrefix('https://x.example/').message, /whole origin/);
	assert.match(purge.validatePurgePrefix('https://x.example/unknown/').message, /no prerender route/);
	// GATE FIRST, THEN PURGE — the interlock this test exists to pin.
	assert.match(purge.validatePurgePrefix('https://x.example/product/prd-').message, /gate it first/);
	assert.equal(purge.validatePurgePrefix('https://x.example/product/prd-', { force: true }), null);
	assert.equal(purge.validatePurgePrefix('https://x.example/catalog/'), null);
	for (const refusal of [
		purge.validatePurgePrefix('not-a-url'),
		purge.validatePurgePrefix('https://x.example/product/prd-'),
	]) {
		assert.equal(refusal.statusCode, 400, 'refusals are operator input, not faults');
	}
});

test('startDiscoveredPurge: a detached run completes, reports, and refuses to overlap', async () => {
	applyOptions({
		ingress: { mode: 'forwarded', routes: [{ match: 'prefix', path: '/catalog/', discoverTargets: false }] },
	});
	assert.throws(
		() => purge.startDiscoveredPurge({ urlPrefix: 'https://x.example/' }),
		/whole origin/,
		'validation refusals throw before anything starts'
	);
	const { started } = purge.startDiscoveredPurge({ urlPrefix: 'https://x.example/catalog/' });
	assert.equal(started, true);
	while (purge.getDiscoveredPurgeState().running) await new Promise((resolve) => setImmediate(resolve));
	const done = purge.getDiscoveredPurgeState();
	assert.equal(done.error, null);
	assert.equal(done.examined, 0, 'the FakeTable slice is empty');
	assert.equal(done.dryRun, true, 'a bare start is a census');
	assert.equal(typeof done.finishedAt, 'number');
});

test('runner: deletes are issued ONE AT A TIME, never concurrently', async () => {
	// The 503 regression this release fixes: a concurrently-issued batch put hundreds of
	// cascading writes in flight, the commit queue on that thread blew past its limit, and
	// Harper then rejected the render fleet's job_result posts (deletes themselves are exempt
	// from the check, so the purge never felt the backpressure it was creating).
	let inFlight = 0;
	let maxInFlight = 0;
	const stats = newStats();
	await purge.purgeDiscoveredTargets({
		rows: (async function* () {
			for (let i = 0; i < 12; i++) yield row(`https://x.example/catalog/${i}`);
		})(),
		ownerOf: () => 'node-a',
		hostname: 'node-a',
		isLeased: () => false,
		deleteTarget: async () => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((resolve) => setImmediate(resolve));
			inFlight--;
		},
		dryRun: false,
		ratePerSecond: 1_000_000,
		batchSize: 6,
		pause: async () => {},
		stats,
	});
	assert.equal(maxInFlight, 1, 'a second delete must never start before the previous one settles');
	assert.equal(stats.deleted, 12);
});

test('runner: a failing delete costs one row, not the pass', async () => {
	const stats = newStats();
	await purge.purgeDiscoveredTargets({
		rows: (async function* () {
			for (const name of ['a', 'boom', 'c']) yield row(`https://x.example/catalog/${name}`);
		})(),
		ownerOf: () => 'node-a',
		hostname: 'node-a',
		isLeased: () => false,
		deleteTarget: async (url) => {
			if (url.endsWith('/boom')) throw new Error('Operation aborted: Database closed during transaction');
		},
		dryRun: false,
		ratePerSecond: 1_000_000,
		pause: async () => {},
		stats,
	});
	assert.equal(stats.deleted, 2, 'the rows either side of the fault still deleted');
	assert.equal(stats.errors, 1);
	assert.equal(stats.abortedOnErrors, false);
	assert.match(stats.errorSamples[0].error, /Database closed/);
	assert.equal(stats.errorSamples[0].url, 'https://x.example/catalog/boom');
});

test('runner: a fault on every row stops the pass instead of grinding through millions', async () => {
	const stats = newStats();
	await assert.rejects(
		purge.purgeDiscoveredTargets({
			rows: (async function* () {
				for (let i = 0; i < 500; i++) yield row(`https://x.example/catalog/${i}`);
			})(),
			ownerOf: () => 'node-a',
			hostname: 'node-a',
			isLeased: () => false,
			deleteTarget: async () => {
				throw new Error('storage is gone');
			},
			dryRun: false,
			ratePerSecond: 1_000_000,
			pause: async () => {},
			stats,
		}),
		/consecutive delete failures/
	);
	assert.equal(stats.abortedOnErrors, true);
	assert.equal(stats.deleted, 0);
	assert.ok(stats.errors < 500, 'it stopped early rather than walking the whole stream');
});

test('runner: an intermittent fault does not trip the consecutive-failure stop', async () => {
	const stats = newStats();
	let n = 0;
	await purge.purgeDiscoveredTargets({
		rows: (async function* () {
			for (let i = 0; i < 200; i++) yield row(`https://x.example/catalog/${i}`);
		})(),
		ownerOf: () => 'node-a',
		hostname: 'node-a',
		isLeased: () => false,
		// Every third delete fails — far more than production ever saw, and still not a reason
		// to abandon the pass: the counter resets on each success.
		deleteTarget: async () => {
			if (n++ % 3 === 0) throw new Error('transient');
		},
		dryRun: false,
		ratePerSecond: 1_000_000,
		pause: async () => {},
		stats,
	});
	assert.equal(stats.abortedOnErrors, false);
	assert.equal(stats.deleted + stats.errors, 200);
});

test('skipVisited: spares ladder-promoted targets, still deletes the unvisited ones', async () => {
	// A stored demandInterval is durable evidence a bot visited the URL in each of promoteWindows
	// consecutive windows — on a commerce corpus 40% of never-declared product pages carried one,
	// and deleting those pays a delete plus a re-mint to arrive back where we started.
	const deleted = [];
	const stats = newStats();
	await purge.purgeDiscoveredTargets({
		rows: (async function* () {
			yield { url: 'https://x.example/product/a', sitemapUrl: null, demandInterval: 43200000 }; // visited
			yield { url: 'https://x.example/product/b', sitemapUrl: null, demandInterval: null }; // not
			yield { url: 'https://x.example/product/c', sitemapUrl: null }; // field absent
			yield { url: 'https://x.example/product/d', sitemapUrl: null, demandInterval: BigInt(86400000) }; // Long
		})(),
		ownerOf: () => 'node-a',
		hostname: 'node-a',
		isLeased: () => false,
		deleteTarget: async (url) => deleted.push(url),
		dryRun: false,
		ratePerSecond: 1_000_000,
		skipVisited: true,
		pause: async () => {},
		stats,
	});
	assert.deepEqual(deleted, ['https://x.example/product/b', 'https://x.example/product/c']);
	assert.equal(stats.visitedSkipped, 2, 'the BigInt rung counts as visited — Long columns surface that way');
	assert.equal(stats.discovered, 4);
	assert.equal(stats.deleted, 2);
});

test('skipVisited: off by default, so the predicate is unchanged for existing callers', async () => {
	const deleted = [];
	const stats = newStats();
	await purge.purgeDiscoveredTargets({
		rows: (async function* () {
			yield { url: 'https://x.example/product/a', sitemapUrl: null, demandInterval: 43200000 };
		})(),
		ownerOf: () => 'node-a',
		hostname: 'node-a',
		isLeased: () => false,
		deleteTarget: async (url) => deleted.push(url),
		dryRun: false,
		ratePerSecond: 1_000_000,
		pause: async () => {},
		stats,
	});
	assert.deepEqual(deleted, ['https://x.example/product/a']);
	assert.equal(stats.visitedSkipped, 0);
});
