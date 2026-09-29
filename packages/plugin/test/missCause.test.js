import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * WHY A MISS HAPPENED (`bot_miss`, http_handlers/bot_request.js). One cause per origin-served miss,
 * decided where the reason is known: the origin status and the discovery gates at resolve time, the
 * Target read (detached) for the rest.
 *
 * What is pinned, and why each matters:
 *   - EXACTLY ONCE per miss. bot_miss is read against bot_serve origin|miss; a path that told twice,
 *     or not at all, would make the causes stop summing to the misses they explain.
 *   - The causes a render can fix (new, unrendered, device) are told apart from the ones it cannot
 *     (not-found, the gates, passthrough, suppressed). That split is the whole point of the metric.
 *   - The emit carries the cause, the route label and the bot, in that slot order.
 */

const told = [];
const analytics = [];

class TargetBase {
	static rows = new Map();
	static puts = [];
	static fail = false;
	static async get({ id }) {
		if (TargetBase.fail) throw new Error('read failed');
		return TargetBase.rows.get(id) ?? null;
	}
	static async put(id) {
		TargetBase.puts.push(id);
	}
	static search() {
		return (async function* () {})();
	}
}

let applyOptions;
let maybeSchedule;
let handlePageScheduling;
let recordMiss;
let PRERENDER;
let PASSTHROUGH;

before(async () => {
	globalThis.server = {
		hostname: 'test-node',
		nodes: [],
		config: { http: { port: 9926 } },
		recordAnalytics: (...args) => analytics.push(args),
	};
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} };
	globalThis.Resource = class {};
	globalThis.databases = {
		coordination: {
			SharedBuffer: { primaryStore: { getUserSharedBuffer: (_key, buf) => buf, tryLock: () => true, unlock() {} } },
		},
		render_service: { Target: TargetBase, QueueControl: class {} },
		render_schedule: { RenderSchedule: class {} },
		page_cache: { PrerenderedPage: class {} },
		probe_state: { ProbeState: class {}, RenderExpectation: class {} },
	};
	({ applyOptions } = await import('../src/config.js'));
	({ PRERENDER, PASSTHROUGH } = await import('../src/util/routeClass.js'));
	({ maybeSchedule, handlePageScheduling, recordMiss } = await import('../src/http_handlers/bot_request.js'));
});

const U = 'https://www.example.com/product/prd-1/thing.jsp';
const route = (extra = {}) => ({ match: 'prefix', path: '/product/prd-', ...extra });
const miss = (extra = {}) => ({
	miss: true,
	statusCode: 200,
	url: U,
	deviceType: 'desktop',
	headers: { 'content-type': 'text/html; charset=utf-8' },
	...extra,
});
const onMiss = (cause) => told.push(cause);
// maybeSchedule detaches the Target read with setImmediate; this lets it run.
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(() => {
	told.length = 0;
	analytics.length = 0;
	TargetBase.rows.clear();
	TargetBase.puts = [];
	TargetBase.fail = false;
	applyOptions({
		ingress: { discoveryBots: ['Googlebot'] },
		deviceTypes: { supported: ['desktop', 'mobile', 'tablet'], default: ['desktop', 'mobile'] },
		// the per-cause distinct-URL sketch is exercised in crawlStats.test.js; off here so nothing flushes
		crawlStats: { enabled: false },
	});
});

test('the origin status decides dead URLs, redirects and errors — no Target read, told at once', () => {
	const cases = [
		[404, 'not-found'],
		[410, 'not-found'],
		[301, 'redirect'],
		[304, 'not-modified'],
		[403, 'client-error'],
		[429, 'client-error'],
		[502, 'origin-error'],
		[0, 'origin-error'],
		[204, 'uncacheable'],
	];
	for (const [statusCode, cause] of cases) {
		told.length = 0;
		maybeSchedule(miss({ statusCode }), PRERENDER, route(), 'Googlebot', onMiss);
		assert.deepEqual(told, [cause], `status ${statusCode}`);
	}
});

test('a route that is not prerendered is passthrough, whatever the origin said', () => {
	maybeSchedule(miss(), PASSTHROUGH, route(), 'Googlebot', onMiss);
	assert.deepEqual(told, ['passthrough']);
});

test('the discovery gates: gated-route before gated-bot, and both counted on discovery_gated as before', () => {
	maybeSchedule(miss(), PRERENDER, route({ discoverTargets: false }), 'Googlebot', onMiss);
	maybeSchedule(miss(), PRERENDER, route(), 'SomeScraper', onMiss);
	assert.deepEqual(told, ['gated-route', 'gated-bot']);
	const gated = analytics.filter((a) => a[2] === 'discovery_gated').map((a) => a[3]);
	assert.deepEqual(gated, ['route', 'bot'], 'the existing series is unchanged');
});

test('an ungated 200 is decided by the Target read: new, unrendered, device, suppressed', async () => {
	maybeSchedule(miss(), PRERENDER, route(), 'Googlebot', onMiss);
	await settle();
	assert.deepEqual(told, ['new']);
	assert.deepEqual(TargetBase.puts, [U], 'and it minted, as before');

	TargetBase.rows.set(U, { url: U, state: null });
	await handlePageScheduling(miss(), route(), 'Googlebot', onMiss);
	await handlePageScheduling(miss({ deviceType: 'tablet' }), route(), 'Googlebot', onMiss);
	TargetBase.rows.set(U, { url: U, state: 'suppressed' });
	await handlePageScheduling(miss({ deviceType: 'tablet' }), route(), 'Googlebot', onMiss);
	assert.deepEqual(told, ['new', 'unrendered', 'device', 'suppressed'], 'suppressed wins over device');
	assert.equal(TargetBase.puts.length, 1, 'an existing row is never re-minted');
});

test('a 200 that is not a prerender candidate is uncacheable; a failed read is error — told once each', async () => {
	await handlePageScheduling(miss({ headers: { 'content-type': 'application/json' } }), route(), 'Googlebot', onMiss);
	TargetBase.fail = true;
	await handlePageScheduling(miss(), route(), 'Googlebot', onMiss);
	assert.deepEqual(told, ['uncacheable', 'error']);
});

test('no callback, no emit: the analytics gate is the caller’s, and scheduling behaves exactly as before', async () => {
	maybeSchedule(miss(), PRERENDER, route(), 'Googlebot', null);
	await settle();
	assert.deepEqual(TargetBase.puts, [U]);
	assert.equal(analytics.filter((a) => a[1] === 'bot_miss').length, 0, 'nothing recorded without the callback');
});

test('recordMiss emits cause, route label, bot — in that slot order', () => {
	recordMiss('not-found', { route: route(), routeClass: PRERENDER, cacheUrl: U, botName: 'Googlebot' });
	recordMiss('passthrough', { route: null, routeClass: PASSTHROUGH, cacheUrl: U, botName: 'Bingbot' });
	assert.deepEqual(
		analytics.filter((a) => a[1] === 'bot_miss'),
		[
			[true, 'bot_miss', 'not-found', '/product/prd-', 'Googlebot'],
			[true, 'bot_miss', 'passthrough', 'passthrough', 'Bingbot'],
		]
	);
});

test('an on-demand render that timed out is render-timeout, whatever its fallback answered — told once', async () => {
	// fallback 'error' answers with render-now's own 504, fallback 'origin' with the origin's status;
	// neither is why the request missed.
	maybeSchedule(miss({ statusCode: 504 }), PRERENDER, route(), 'Googlebot', onMiss, { renderTimedOut: true });
	maybeSchedule(miss(), PRERENDER, route(), 'Googlebot', onMiss, { renderTimedOut: true });
	await settle();
	assert.deepEqual(told, ['render-timeout', 'render-timeout'], 'never also origin-error or new');
	assert.deepEqual(TargetBase.puts, [U], 'and the 200 fallback still schedules as it would have');
});
