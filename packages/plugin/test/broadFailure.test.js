import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * util/broadFailure.js: a failure judged against its route's failure share on this node. Pinned here:
 *
 *   - the threshold needs BOTH enough results (`minResults`) and enough of them failed (`failureShare`);
 *   - routes are judged apart, so one backend's outage does not excuse another route's broken pages, and a
 *     route that is a small share of the node's renders is still judged on its own numbers;
 *   - the window forgets: counts older than `window` drop out;
 *   - `maxDuration` caps a broad spell, and the cap holds until the share falls below the threshold;
 *   - the health section reports it, and judging there is what notices a spell has ended.
 */

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 6, 12, 0, 0);
const PRODUCT = 'https://www.example.com/product/a';
const CATALOG = 'https://www.example.com/catalog/shoes';
const UNROUTED = 'https://www.example.com/help';

let bf, applyOptions, config;
const sabs = new Map();
let warns = [];
let notifies = [];

before(async () => {
	globalThis.server = { hostname: 'test-node', nodes: [], recordAnalytics() {} };
	globalThis.logger = {
		debug() {},
		info() {},
		notify: (msg) => notifies.push(String(msg)),
		warn: (msg) => warns.push(String(msg)),
		error() {},
	};
	globalThis.databases = {
		coordination: {
			SharedBuffer: {
				primaryStore: {
					getUserSharedBuffer: (k, buf) => {
						if (!sabs.has(k)) sabs.set(k, buf);
						return sabs.get(k);
					},
				},
			},
		},
	};
	({ applyOptions, config } = await import('../src/config.js'));
	bf = await import('../src/util/broadFailure.js');
});

const OPTIONS = {
	ingress: {
		mode: 'forwarded',
		routes: [
			{ match: 'prefix', path: '/product/', mode: 'prerender' },
			{ match: 'prefix', path: '/catalog/', mode: 'prerender' },
		],
	},
};

beforeEach(() => {
	applyOptions(OPTIONS);
	bf.resetBroadFailure();
	warns = [];
	notifies = [];
});

afterEach(() => applyOptions({}));

/** `ok` successful results and `failed` failed ones for `url`, at `at`. */
const results = (url, { ok = 0, failed = 0 }, at = T0) => {
	for (let i = 0; i < ok + failed; i++) bf.recordRenderResult(url, at);
	for (let i = 0; i < failed; i++) bf.recordRenderFailure(url, at);
};

test('a URL is judged under its prerender route, and everything else under `other`', () => {
	assert.equal(bf.routeOfUrl(PRODUCT), '/product/');
	assert.equal(bf.routeOfUrl(CATALOG), '/catalog/');
	assert.equal(bf.routeOfUrl(UNROUTED), 'other');
});

test('broad needs minResults AND failureShare: a few failures, or many among many successes, are the page’s', () => {
	results(PRODUCT, { failed: 19 });
	assert.equal(bf.isBroadFailure(PRODUCT, T0), false, '19 results is under minResults (20): too few to judge');
	results(PRODUCT, { ok: 1 });
	assert.equal(bf.isBroadFailure(PRODUCT, T0), true, '19 of 20 failed');

	bf.resetBroadFailure();
	warns = [];
	results(PRODUCT, { ok: 60, failed: 40 });
	assert.equal(bf.isBroadFailure(PRODUCT, T0), false, '40% failed is under failureShare 0.5');
	results(PRODUCT, { failed: 20 });
	assert.equal(bf.isBroadFailure(PRODUCT, T0), true, '60 of 120');
	assert.equal(warns.length, 1, 'entering a broad spell is logged once');
	assert.match(warns[0], /broad render failure on route \/product\//);
});

test('routes are judged apart: a catalog outage excuses catalog failures only', () => {
	// The shape of a backend outage behind one kind of page: the catalog route fails wholesale while
	// product pages, the bulk of the renders, render fine. Judged across the node, 30 of 230 failed is 13%.
	results(PRODUCT, { ok: 200 });
	results(CATALOG, { ok: 2, failed: 28 });
	assert.equal(bf.isBroadFailure(CATALOG, T0), true);
	assert.equal(bf.isBroadFailure(PRODUCT, T0), false);
	results(PRODUCT, { failed: 3 });
	assert.equal(bf.isBroadFailure(PRODUCT, T0), false, 'a product page failing now is still the page’s');
});

test('the window forgets: failures older than `window` no longer count', () => {
	results(PRODUCT, { failed: 30 }, T0);
	assert.equal(bf.isBroadFailure(PRODUCT, T0 + 5 * MIN), true, 'inside the 10-minute window');
	assert.equal(bf.isBroadFailure(PRODUCT, T0 + 10 * MIN), false, 'out of it');
	assert.ok(
		notifies.some((m) => m.includes('over on route /product/')),
		'and the end of the spell is logged'
	);
});

test('a minute bucket is reused once the ring wraps, not added to', () => {
	results(PRODUCT, { failed: 30 }, T0);
	// 61 minutes later the same ring slot comes round again: the old minute's counts must be gone.
	results(PRODUCT, { ok: 25 }, T0 + 61 * MIN);
	assert.equal(bf.isBroadFailure(PRODUCT, T0 + 61 * MIN), false);
	const health = bf.broadFailureHealth(T0 + 61 * MIN);
	assert.equal(health.results, 25);
	assert.equal(health.failed, 0);
});

test('maxDuration caps a broad spell, and the cap holds until the failure share falls', () => {
	applyOptions({ ...OPTIONS, render: { failureRetry: { broadFailure: { maxDuration: 30 * MIN } } } });
	// A route failing every minute for 40 minutes.
	const verdicts = [];
	for (let m = 0; m <= 40; m++) {
		results(CATALOG, { failed: 5 }, T0 + m * MIN);
		verdicts.push(bf.isBroadFailure(CATALOG, T0 + m * MIN));
	}
	assert.equal(verdicts[2], false, '15 results: not yet minResults');
	assert.equal(verdicts[3], true, 'broad from 20 results, at minute 3');
	assert.equal(verdicts[32], true, '29 minutes into the spell');
	assert.equal(verdicts[33], false, '30 minutes in: capped, strikes count again');
	assert.equal(verdicts[40], false, 'and it stays capped while the share stays up');
	assert.ok(warns.some((w) => w.includes('past render.failureRetry.broadFailure.maxDuration')));
	assert.deepEqual(bf.broadFailureHealth(T0 + 40 * MIN).capped, ['/catalog/']);

	// The share falls (the window empties), the route starts clean, and a new spell can begin.
	assert.equal(bf.isBroadFailure(CATALOG, T0 + 60 * MIN), false);
	results(CATALOG, { failed: 25 }, T0 + 61 * MIN);
	assert.equal(bf.isBroadFailure(CATALOG, T0 + 61 * MIN), true, 'a fresh spell after the share fell');
});

test('the health section: counts in the window, the broad routes, and the routes with failures', () => {
	results(PRODUCT, { ok: 100, failed: 2 });
	results(CATALOG, { failed: 25 });
	results(UNROUTED, { ok: 3 });
	const health = bf.broadFailureHealth(T0);
	assert.equal(health.results, 130);
	assert.equal(health.failed, 27);
	assert.deepEqual(health.broad, ['/catalog/']);
	assert.deepEqual(health.capped, []);
	assert.deepEqual(health.routes, {
		'/product/': { results: 102, failed: 2 },
		'/catalog/': { results: 25, failed: 25 },
	});
});

test('off: nothing is counted, nothing is broad, and the health section is null', () => {
	applyOptions({ ...OPTIONS, render: { failureRetry: { broadFailure: { enabled: false } } } });
	results(CATALOG, { failed: 50 });
	assert.equal(bf.isBroadFailure(CATALOG, T0), false);
	assert.equal(bf.broadFailureHealth(T0), null);
	applyOptions(OPTIONS);
	assert.equal(bf.broadFailureHealth(T0).results, 0, 'the results while off were never recorded');
});

test('broadRetryWait: retryAfter, never past the cadence, whole minutes, at least one', async () => {
	const { broadRetryWait } = await import('../src/util/failureBackoff.js');
	assert.equal(broadRetryWait(48 * 60 * MIN), 30 * MIN, 'a 48h page retries in 30 minutes, not 48 hours');
	assert.equal(broadRetryWait(10 * MIN), 10 * MIN, 'never later than its own cadence');
	assert.equal(broadRetryWait(90_500), MIN, 'floored to whole minutes');
	assert.equal(broadRetryWait(10_000), MIN, 'and never under one');
	assert.equal(config.render.failureRetry.broadFailure.retryAfter, 30 * MIN);
});
