import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The sweep and the ready-first claim, driven against a fake schedule table.
 *
 * What is pinned here, and why each one is a bug nothing else would catch:
 *
 *   - THE PRODUCTION SYMPTOM. A homepage two of its own cadences late, behind a deep backlog of rows
 *     that are older in absolute terms, must be granted FIRST. This is the whole reason the feature
 *     exists, and the reason re-sorting the claim window could not do it: the window is anchored at
 *     the oldest due time, so the homepage is never read at all.
 *   - THE SWEEP ADVANCES THE FLOOR. Once claims are served from memory they observe nothing, so a
 *     floor left to the claim path freezes — and a frozen floor is measured at 0.073 -> 5.60 ms over
 *     40,000 reschedules. If this regresses, the queue silently degrades back to the state the floor
 *     exists to prevent.
 *   - THE FALLBACK IS REAL. Cold, exhausted and disabled must all land on the index scan, because
 *     that is the entire safety argument: every failure mode here is the previous behaviour.
 *   - A LEASED ROW IS NEVER GRANTED TWICE. The set deliberately does not exclude leased rows (a row
 *     being rendered is still due, and excluding it would let the floor advance past a lease whose
 *     result has not landed), so the claim path has to refuse them.
 *   - `fromSitemap` SURVIVES. The renderer serializes a non-indexable page only when the url is
 *     sitemap-listed, so a job reporting `false` for a listed page silently stops it being cached.
 *     That bug has shipped twice in this package.
 *   - A NOT-YET-DUE ROW IS NEVER PUBLISHED, however urgent its cadence would make it.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = 1_700_000_400_000;
const minuteOf = (ms) => Math.floor(ms / MINUTE);

let funnel, config, applyOptions;
const sabs = new Map();
let table = new Map();
let searches = 0;

before(async () => {
	globalThis.server = { hostname: 'test-node', workerIndex: 0, nodes: [], config: { http: { port: 9926 } } };
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {} };
	globalThis.databases = {
		coordination: {
			SharedBuffer: {
				primaryStore: {
					getUserSharedBuffer: (key, buffer) => {
						if (!sabs.has(key)) sabs.set(key, buffer);
						return sabs.get(key);
					},
					tryLock: () => true,
					unlock() {},
				},
			},
		},
		render_schedule: {
			RenderSchedule: {
				put: async () => {},
				delete: async () => {},
				get: async () => undefined,
				// The one-sided ascending walk the real query performs: `>= value`, sorted, limited.
				search: (query) => {
					searches++;
					const from = query.conditions[0].value;
					const rows = [...table.values()]
						.filter((row) => Number(row.nextRenderTime) >= from)
						.sort((a, b) => Number(a.nextRenderTime) - Number(b.nextRenderTime))
						.slice(0, query.limit);
					return (async function* () {
						for (const row of rows) yield { ...row };
					})();
				},
			},
		},
	};

	({ config, applyOptions } = await import('../src/config.js'));
	funnel = await import('../src/util/renderSchedule.js');
});

// THE ROUTES ARE THE POINT. Without them every URL resolves to `render.defaultInterval`, so relative
// lateness collapses to absolute lateness and the ordering under test cannot be distinguished from
// the ordering it replaces — which is exactly how the first version of this file "failed".
const withRoutes = () =>
	applyOptions({
		ingress: {
			mode: 'forwarded',
			routes: [
				{ match: 'exact', path: '/', queryParams: [], renderInterval: HOUR },
				{ match: 'prefix', path: '/product/prd-', queryParams: [], renderInterval: 48 * HOUR },
				{ match: 'prefix', path: '/a', queryParams: [] },
				{ match: 'prefix', path: '/b', queryParams: [] },
			],
		},
	});

const seed = (rows) => {
	table = new Map(rows.map((r) => [r.cacheKey, r]));
};

const row = (url, device, dueAt, fromSitemap = true) => ({
	cacheKey: `${url}|${device}`,
	nextRenderTime: dueAt,
	fromSitemap,
});

beforeEach(() => {
	withRoutes();
	// ZERO EVERY SHARED BUFFER, not just the floor. Both the lease table and the ready set live in
	// named buffers that outlive a test, and both leak in ways that make the next test pass or fail
	// for the wrong reason: a leftover generation makes a "cold set" warm, and leases granted by an
	// earlier test's claim make the fallback scan skip rows and start further down the index. Zeroing
	// the bytes resets the floor, the leases, the occupancy gauge and the set in one step, and the
	// views the modules hold stay valid because only the contents change.
	for (const buffer of sabs.values()) new Uint8Array(buffer).fill(0);
	config.queue.ready.enabled = true;
	config.queue.ready.sweepCap = 500_000;
	config.queue.ready.sitemapBoost = 2;
	searches = 0;
});

// A backlog of 48h-cadence product pages that are older in absolute terms, plus a 1h homepage that
// is two of its own cadences late. Index order serves the products; relative lateness serves home.
const backlogWithLateHome = () => {
	const rows = [];
	for (let i = 0; i < 400; i++) {
		rows.push(row(`https://www.kohls.com/product/prd-${i}/x`, 'desktop', T0 - 3 * 24 * HOUR + i * MINUTE));
	}
	rows.push(row('https://www.kohls.com/', 'desktop', T0 - 2 * HOUR));
	return rows;
};

test('THE PRODUCTION SYMPTOM: a late homepage behind a deep backlog is granted first', async () => {
	seed(backlogWithLateHome());
	const sweep = await funnel.sweepReadySet({ nowMs: T0 });
	assert.equal(sweep.due, 401, 'the sweep scores the whole due set, not a window');
	assert.ok(sweep.published > 0);

	const pass = await funnel.claimSchedules({ grantLimit: 1 });
	assert.deepEqual(
		pass.jobs.map((j) => j.cacheKey),
		['https://www.kohls.com/|desktop'],
		'2 cadences late on a 1h route beats 3 days late on a 48h route'
	);
	assert.equal(pass.fromReady, 1);
});

test('...and the claim that serves it reads the index ZERO times', async () => {
	seed(backlogWithLateHome());
	await funnel.sweepReadySet({ nowMs: T0 });
	searches = 0;
	const pass = await funnel.claimSchedules({ grantLimit: 5 });
	assert.equal(pass.jobs.length, 5);
	assert.equal(searches, 0, 'the claim path must not touch the index while the set can serve it');
});

test('THE SWEEP ADVANCES THE FLOOR — otherwise the index degrades with nothing observing it', async () => {
	seed(backlogWithLateHome());
	const leases = funnel.leaseTable();
	assert.equal(leases.rawFloorMinute(), 0, 'precondition: unbounded');

	const sweep = await funnel.sweepReadySet({ nowMs: T0 });
	assert.equal(sweep.floorAdvanced, true);
	// The floor rule, unchanged: the due minute of the FIRST due row observed. The sweep sees every
	// due row, so that is the true minimum rather than the minimum of a window.
	assert.equal(leases.rawFloorMinute(), minuteOf(T0 - 3 * 24 * HOUR));
	assert.equal(sweep.firstDueKey, 'https://www.kohls.com/product/prd-0/x|desktop');
});

test('a cold set falls back to the index scan, which is the previous behaviour', async () => {
	seed(backlogWithLateHome());
	// No sweep has run.
	const pass = await funnel.claimSchedules({ grantLimit: 3 });
	assert.equal(pass.fromReady, 0);
	assert.ok(searches > 0, 'it must have read the index');
	// Index order: the oldest in absolute terms.
	assert.deepEqual(
		pass.jobs.map((j) => j.cacheKey),
		[
			'https://www.kohls.com/product/prd-0/x|desktop',
			'https://www.kohls.com/product/prd-1/x|desktop',
			'https://www.kohls.com/product/prd-2/x|desktop',
		]
	);
});

test('an exhausted set tops up from the index rather than granting short', async () => {
	seed([
		row('https://www.kohls.com/a1', 'desktop', T0 - HOUR),
		row('https://www.kohls.com/a2', 'desktop', T0 - HOUR),
		row('https://www.kohls.com/a3', 'desktop', T0 - HOUR),
	]);
	await funnel.sweepReadySet({ nowMs: T0 });
	const ready = funnel.readyQueue();
	// Drain it to one remaining entry. `capacity` cannot be shrunk at runtime — the buffer is sized by
	// its first allocation — so exhaustion has to be produced by consumption, which is also how it
	// happens in production when claims outrun the sweep.
	ready.take(ready.state().count - 1);
	searches = 0;

	const pass = await funnel.claimSchedules({ grantLimit: 3 });
	assert.equal(pass.fromReady, 1, 'one from the set...');
	assert.equal(pass.jobs.length, 3, '...and the batch is still filled, not truncated');
	assert.ok(searches > 0, 'the remainder came from the index');
});

test('disabled is a true revert: no sweep, and claims come straight from the index', async () => {
	seed(backlogWithLateHome());
	config.queue.ready.enabled = false;
	assert.deepEqual(await funnel.sweepReadySet({ nowMs: T0 }), { skipped: 'disabled' });
	const pass = await funnel.claimSchedules({ grantLimit: 2 });
	assert.equal(pass.fromReady, undefined);
	assert.deepEqual(
		pass.jobs.map((j) => j.cacheKey),
		['https://www.kohls.com/product/prd-0/x|desktop', 'https://www.kohls.com/product/prd-1/x|desktop']
	);
});

test('A LEASED ROW IS NEVER GRANTED TWICE, and the set does not drop it', async () => {
	seed([row('https://www.kohls.com/', 'desktop', T0 - 2 * HOUR), row('https://www.kohls.com/a', 'desktop', T0 - HOUR)]);
	await funnel.sweepReadySet({ nowMs: T0 });
	const leases = funnel.leaseTable();
	// Lease the head of the set out from under the claim, the way a concurrent worker would.
	//
	// EXPIRY ON THE REAL CLOCK, not on T0. The lease table is built with `() => Date.now()`, and T0 is
	// a fixed past timestamp — so a `T0 + HOUR` expiry is already long expired and `isLeased` answers
	// false. The first version of this test granted a lease that never existed and then asserted the
	// row was not re-granted, which is a test that cannot fail for the right reason.
	leases.grant('https://www.kohls.com/|desktop', {
		dueMinute: minuteOf(T0 - 2 * HOUR),
		leaseExpiryMs: Date.now() + HOUR,
	});

	const pass = await funnel.claimSchedules({ grantLimit: 2 });
	const keys = pass.jobs.map((j) => j.cacheKey);
	assert.equal(keys.includes('https://www.kohls.com/|desktop'), false, 'the leased row must not be re-granted');
	assert.ok(pass.skippedLeased >= 1);
});

test('a not-yet-due row is never published, however urgent its cadence would make it', async () => {
	seed([
		row('https://www.kohls.com/', 'desktop', T0 + HOUR), // 1h route, not yet due
		row('https://www.kohls.com/product/prd-1/x', 'desktop', T0 - HOUR),
	]);
	const sweep = await funnel.sweepReadySet({ nowMs: T0 });
	assert.equal(sweep.due, 1);
	assert.deepEqual(
		funnel
			.readyQueue()
			.peek(5)
			.map((e) => e.cacheKey),
		['https://www.kohls.com/product/prd-1/x|desktop']
	);
});

test('`fromSitemap` survives the round trip through shared memory', async () => {
	seed([
		row('https://www.kohls.com/a', 'desktop', T0 - HOUR, true),
		row('https://www.kohls.com/b', 'desktop', T0 - HOUR, false),
	]);
	await funnel.sweepReadySet({ nowMs: T0 });
	const pass = await funnel.claimSchedules({ grantLimit: 2 });
	const byKey = new Map(pass.jobs.map((j) => [j.cacheKey, j.fromSitemap]));
	assert.equal(byKey.get('https://www.kohls.com/a|desktop'), true);
	assert.equal(byKey.get('https://www.kohls.com/b|desktop'), false);
});

test('the sitemap boost orders a listed page ahead of a discovered one at equal lateness', async () => {
	seed([
		row('https://www.kohls.com/a', 'desktop', T0 - HOUR, false),
		row('https://www.kohls.com/b', 'desktop', T0 - HOUR, true),
	]);
	await funnel.sweepReadySet({ nowMs: T0 });
	assert.deepEqual(
		funnel
			.readyQueue()
			.peek(2)
			.map((e) => e.cacheKey),
		['https://www.kohls.com/b|desktop', 'https://www.kohls.com/a|desktop']
	);
});

test('a sweep that hits its cap without reaching a not-yet-due row reports truncated', async () => {
	seed(backlogWithLateHome());
	config.queue.ready.sweepCap = 10;
	const sweep = await funnel.sweepReadySet({ nowMs: T0 });
	assert.equal(sweep.scanned, 10);
	assert.equal(sweep.truncated, true, 'the ordering covers only a prefix of the backlog');

	// ...and a sweep that DOES reach one is not truncated even if it read every row it was allowed.
	seed([row('https://www.kohls.com/a', 'desktop', T0 - HOUR), row('https://www.kohls.com/b', 'desktop', T0 + HOUR)]);
	config.queue.ready.sweepCap = 2;
	const complete = await funnel.sweepReadySet({ nowMs: T0 });
	assert.equal(complete.truncated, false);
	config.queue.ready.sweepCap = 500_000;
});

test('a row with an unusable due time is counted and skipped, never scored', async () => {
	seed([
		{ cacheKey: 'https://www.kohls.com/a|desktop', nextRenderTime: null, fromSitemap: true },
		row('https://www.kohls.com/b', 'desktop', T0 - HOUR),
	]);
	const sweep = await funnel.sweepReadySet({ nowMs: T0 });
	assert.equal(sweep.nonFinite, 1);
	assert.equal(sweep.due, 1);
	assert.deepEqual(
		funnel
			.readyQueue()
			.peek(5)
			.map((e) => e.cacheKey),
		['https://www.kohls.com/b|desktop']
	);
});

test('a BigInt due time from a Long column is scored, not thrown on', async () => {
	seed([{ cacheKey: 'https://www.kohls.com/a|desktop', nextRenderTime: BigInt(T0 - HOUR), fromSitemap: true }]);
	const sweep = await funnel.sweepReadySet({ nowMs: T0 });
	assert.equal(sweep.due, 1);
	assert.equal(funnel.readyQueue().peek(1)[0].cacheKey, 'https://www.kohls.com/a|desktop');
});
