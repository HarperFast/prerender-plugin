import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';

/**
 * The health line (util/health.js): one `[prerender] health {json}` line per node per interval.
 *
 * Pinned here:
 *   - each answered request lands in the right node and route fields, and a 5xx is "own" unless the live
 *     origin answered it;
 *   - a line drains what it reports, so consecutive lines never count a request twice;
 *   - exactly one worker writes each boundary, and the counts stay exact when real threads add and drain
 *     the same shared memory at once;
 *   - a state section that throws or hangs is written as null and named in `err`, never holding the line;
 *   - the level and the line's shape are the alerting contract.
 */

let applyOptions;
let health;
const logged = [];
// Every shared buffer this thread asked for, as real shared memory, so a worker thread can be handed the
// same ones.
const shared = {};

const H = 3_600_000;
const ROUTES = [
	{ match: 'prefix', path: '/a/', mode: 'prerender', queryParams: [] },
	{ match: 'prefix', path: '/b/', mode: 'prerender', queryParams: [] },
	{ match: 'contains', path: '/search/', mode: 'passthrough' },
];
const OPTIONS = { ingress: { mode: 'forwarded', routes: ROUTES, excludePathPatterns: [] } };

before(async () => {
	globalThis.Resource = class {};
	globalThis.server = { hostname: 'test-node', workerIndex: 0, nodes: [], recordAnalytics() {} };
	const record = (level) => (line) => logged.push({ level, line });
	globalThis.logger = {
		debug() {},
		info: record('info'),
		notify: record('notify'),
		warn: record('warn'),
		error: record('error'),
	};
	globalThis.databases = {
		coordination: {
			SharedBuffer: {
				primaryStore: {
					getUserSharedBuffer: (key, initial) => (shared[key] ??= new SharedArrayBuffer(initial.byteLength)),
					tryLock: () => true,
					unlock() {},
				},
			},
		},
	};
	({ applyOptions } = await import('../src/config.js'));
	applyOptions(OPTIONS);
	health = await import('../src/util/health.js');
});

beforeEach(async () => {
	applyOptions(OPTIONS);
	health.setHealthProvidersForTest({});
	await health.buildHealthLine(); // drain whatever an earlier test left
	logged.length = 0;
});

const zeros = (fields) => Object.fromEntries(fields.map((field) => [field, 0]));

test('each answered request lands in its node and route fields', async () => {
	const { countServe } = health;
	countServe({ route: '/a/', source: 'origin', status: 200, ms: 50 });
	countServe({ route: '/a/', source: 'cache', status: 200, ms: 5, ageMs: 2.5 * H, intervalMs: H });
	countServe({ route: '/a/', source: 'cache', status: 304, ms: 1500, ageMs: 1.5 * H, intervalMs: H });
	countServe({ route: '/b/', source: 'origin', status: 502, ms: 3500 }); // the origin's own 5xx, relayed
	countServe({ route: '/b/', source: 'rendered', status: 503, ms: 20 }); // a 5xx we produced
	countServe({ route: '/search/', source: 'origin', status: 404, ms: 1200 }); // passthrough → other
	countServe({ route: 'unrouted', source: null, status: 500, ms: 2, failed: true }); // the handler failed
	countServe({ route: '/a/', source: 'negative', status: 404, ms: 3 });

	const { bot, routes } = await health.buildHealthLine();
	assert.deepEqual(bot, {
		...zeros(health.NODE_FIELDS),
		req: 8,
		cache: 2,
		rendered: 1,
		origin: 2 + 1,
		negative: 1,
		s2xx: 2,
		s3xx: 1,
		s4xx: 2,
		s5xx: 3,
		own5xx: 2,
		over1s: 3,
		over3s: 1,
		ageOver1x: 2,
		ageOver2x: 1,
	});
	assert.deepEqual(Object.keys(routes), ['/a/', '/b/', health.OTHER_ROUTE], 'prerender routes, then other');
	assert.deepEqual(routes['/a/'], {
		...zeros(health.ROUTE_FIELDS),
		req: 4,
		origin: 1,
		s4xx: 1,
		ageOver1x: 2,
		ageOver2x: 1,
	});
	assert.deepEqual(routes['/b/'], { ...zeros(health.ROUTE_FIELDS), req: 2, origin: 1, s5xx: 2, own5xx: 1, over3s: 1 });
	assert.deepEqual(routes.other, { ...zeros(health.ROUTE_FIELDS), req: 2, origin: 1, s4xx: 1, s5xx: 1, own5xx: 1 });
});

test('a line drains what it reports: the next one starts from zero, and span covers the time between', async () => {
	health.countServe({ route: '/a/', source: 'cache', status: 200, ms: 1 });
	const first = await health.buildHealthLine(Date.now());
	assert.equal(first.bot.req, 1);
	const second = await health.buildHealthLine(Date.now() + 60_000);
	assert.deepEqual(second.bot, zeros(health.NODE_FIELDS));
	assert.ok(second.span >= 59 && second.span <= 61, `span ${second.span}s`);
});

test('nothing is counted while the line is disabled', async () => {
	applyOptions({ ...OPTIONS, health: { enabled: false } });
	health.countServe({ route: '/a/', source: 'cache', status: 200, ms: 1 });
	health.countTruncated();
	applyOptions(OPTIONS);
	assert.equal((await health.buildHealthLine()).bot.req, 0);
	health.countTruncated();
	assert.equal((await health.buildHealthLine()).bot.truncated, 1);
});

test('one write per boundary: a second claim of it, or of an earlier one, writes nothing', async () => {
	const boundary = Date.now() + 10 * H;
	health.countServe({ route: '/b/', source: 'origin', status: 200, ms: 1 });
	assert.equal(await health.writeIfClaimedForTest(boundary), true);
	assert.equal(await health.writeIfClaimedForTest(boundary), false);
	assert.equal(await health.writeIfClaimedForTest(boundary - 60_000), false);
	assert.equal(logged.length, 1);

	const { level, line } = logged[0];
	assert.equal(level, 'notify', 'the default level');
	assert.match(line, /^\[prerender\] health \{/);
	const parsed = JSON.parse(line.slice('[prerender] health '.length));
	assert.equal(parsed.bot.req, 1);
	assert.equal(parsed.routes['/b/'].req, 1);
	assert.equal(typeof parsed.v === 'string' || parsed.v === null, true);
	assert.ok(Number.isInteger(parsed.up) && Number.isInteger(parsed.span));

	applyOptions({ ...OPTIONS, health: { level: 'warn' } });
	assert.equal(await health.writeIfClaimedForTest(boundary + 60_000), true);
	assert.equal(logged[1].level, 'warn', 'health.level is the level written');
});

test('state sections: a value, a null, and a throwing reader written as null and named in err', async () => {
	health.setHealthProvidersForTest({
		keeper: () => ({ ok: 1, live: 1, ageS: 3, ready: 10 }),
		probe: async () => null,
		sitemap: async () => {
			throw new Error('table gone');
		},
	});
	const line = await health.buildHealthLine();
	assert.deepEqual(line.keeper, { ok: 1, live: 1, ageS: 3, ready: 10 });
	assert.equal(line.probe, null);
	assert.equal(line.sitemap, null);
	assert.deepEqual(line.err, ['sitemap']);

	health.setHealthProvidersForTest({ keeper: () => ({ ok: 1 }) });
	assert.equal('err' in (await health.buildHealthLine()), false, 'err only when a section failed');
});

test('a section that never answers is cut off, and the line is still written', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	health.setHealthProvidersForTest({ probe: () => new Promise(() => {}) });
	const pending = health.buildHealthLine();
	// Let the section start, then pass its deadline.
	await Promise.resolve();
	await Promise.resolve();
	t.mock.timers.tick(5_000);
	const line = await pending;
	assert.equal(line.probe, null);
	assert.deepEqual(line.err, ['probe']);
});

test('a live route change re-lays the counters: new routes get their own fields, unknown ones go to other', async () => {
	applyOptions({
		...OPTIONS,
		ingress: { ...OPTIONS.ingress, routes: [...ROUTES, { match: 'prefix', path: '/c/', mode: 'prerender' }] },
	});
	health.countServe({ route: '/c/', source: 'cache', status: 200, ms: 1 });
	health.countServe({ route: '/gone/', source: 'cache', status: 200, ms: 1 });
	const { routes } = await health.buildHealthLine();
	assert.deepEqual(Object.keys(routes), ['/a/', '/b/', '/c/', 'other']);
	assert.equal(routes['/c/'].req, 1);
	assert.equal(routes.other.req, 1);
});

test('a long route table folds its tail into other instead of growing the line without bound', async () => {
	const many = Array.from({ length: 40 }, (_, i) => ({ match: 'prefix', path: `/r${i}/`, mode: 'prerender' }));
	applyOptions({ ...OPTIONS, ingress: { ...OPTIONS.ingress, routes: many } });
	health.countServe({ route: '/r39/', source: 'cache', status: 200, ms: 1 });
	const { routes } = await health.buildHealthLine();
	assert.equal(Object.keys(routes).length, 33);
	assert.equal(routes.other.req, 1);
});

test('real threads: counts stay exact while workers add and race to claim the same boundary', async () => {
	const workers = 4;
	const perWorker = 20_000;
	const boundaryMs = Date.now() + 100 * H;
	// Create every buffer here first, so the workers are handed the same shared memory.
	await health.buildHealthLine();

	const results = await Promise.all(
		Array.from({ length: workers }, (_, index) => {
			const worker = new Worker(new URL('./support/healthWorker.js', import.meta.url), {
				workerData: { index, buffers: shared, options: OPTIONS, perWorker, boundaryMs },
			});
			return new Promise((resolve, reject) => {
				worker.on('error', reject);
				worker.on('message', (message) => {
					if (message === 'ready') return worker.postMessage('go');
					resolve(message);
					void worker.terminate();
				});
			});
		})
	);

	const writers = results.filter((result) => result.wrote);
	assert.equal(writers.length, 1, 'exactly one worker wrote the boundary');
	assert.equal(writers[0].logged.length, 1);
	const written = JSON.parse(writers[0].logged[0].slice('[prerender] health '.length));
	// The writer drained whatever had been counted when it claimed; the rest is still in the buffer.
	const rest = await health.buildHealthLine();
	const total = workers * perWorker;
	assert.equal(written.bot.req + rest.bot.req, total);
	assert.equal(written.bot.cache + written.bot.origin + rest.bot.cache + rest.bot.origin, total);
	assert.equal(written.routes['/a/'].req + rest.routes['/a/'].req, total / 2);
	assert.equal(written.routes['/b/'].req + rest.routes['/b/'].req, total / 2);
});
