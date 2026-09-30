import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The serve path's side of `util/goneReopen.js`: where an origin 200 for a gone-suppressed target is
 * noticed, and where it must NOT cost anything.
 *
 *   - A bot the discovery gate refuses may still reopen a target — the row proves the URL is real.
 *   - A route that does not add targets from traffic never pays the Target read (that is the whole
 *     point of its gate), and neither does a request that found a page row (it has nothing to reopen).
 *   - The discovery path reuses the Target read it already makes, and reopens gone rows only.
 */

const told = [];
const analytics = [];
let reads = 0;

class TargetBase {
	static rows = new Map();
	static async get({ id }) {
		reads++;
		return TargetBase.rows.get(id) ?? null;
	}
	static async put() {}
	static search() {
		return (async function* () {})();
	}
}

let applyOptions;
let maybeSchedule;
let handlePageScheduling;
let resetReopenState;
let PRERENDER;

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
	({ PRERENDER } = await import('../src/util/routeClass.js'));
	({ maybeSchedule, handlePageScheduling } = await import('../src/http_handlers/bot_request.js'));
	({ resetReopenState } = await import('../src/util/goneReopen.js'));
});

const U = 'https://www.example.com/product/prd-9/back.jsp';
const route = (extra = {}) => ({ match: 'prefix', path: '/product/prd-', ...extra });
const ok200 = (extra = {}) => ({
	miss: true,
	statusCode: 200,
	url: U,
	deviceType: 'desktop',
	headers: { 'content-type': 'text/html; charset=utf-8' },
	...extra,
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const reopenOps = () => analytics.filter((a) => a[2] === 'gone_reopen').map((a) => `${a[3]}/${a[4]}`);

beforeEach(() => {
	told.length = 0;
	analytics.length = 0;
	reads = 0;
	TargetBase.rows.clear();
	// The dedupe window is per worker and outlives a test; the same URL recurs across them.
	resetReopenState();
	applyOptions({
		ingress: { discoveryBots: ['Googlebot'] },
		deviceTypes: { supported: ['desktop', 'mobile'], default: ['desktop', 'mobile'] },
		crawlStats: { enabled: false },
		demand: { enabled: false },
		// Dry run: the decision is observable as a count without a schedule table behind it.
		render: { suppression: { gone: { reopen: { enabled: true, dryRun: true } } } },
	});
});

test('a GATED bot’s origin 200 reopens a gone-suppressed target on a route that adds targets', async () => {
	TargetBase.rows.set(U, { url: U, state: 'suppressed', suppressedReason: 'http-gone' });
	maybeSchedule(ok200(), PRERENDER, route(), 'Bingbot', (c) => told.push(c), { cacheStatus: 'miss' });
	await settle();
	assert.deepEqual(told, ['gated-bot'], 'the miss cause is unchanged');
	assert.deepEqual(reopenOps(), ['would-file/traffic']);
});

test('a request that found a page row pays no read: it has nothing to reopen', async () => {
	TargetBase.rows.set(U, { url: U, state: 'suppressed', suppressedReason: 'http-gone' });
	for (const cacheStatus of ['stale', 'invalidated', 'blob-missing', null]) {
		maybeSchedule(ok200(), PRERENDER, route(), 'Bingbot', null, { cacheStatus });
	}
	await settle();
	assert.equal(reads, 0);
	assert.deepEqual(reopenOps(), []);
});

test('a route-gated miss never pays the Target read — the route gate exists to avoid exactly that', async () => {
	TargetBase.rows.set(U, { url: U, state: 'suppressed', suppressedReason: 'http-gone' });
	maybeSchedule(ok200(), PRERENDER, route({ discoverTargets: false }), 'Bingbot', null, { cacheStatus: 'miss' });
	await settle();
	assert.equal(reads, 0);
});

test('with the switch off, the gated path schedules nothing at all', async () => {
	applyOptions({
		ingress: { discoveryBots: ['Googlebot'] },
		render: { suppression: { gone: { reopen: { enabled: false } } } },
	});
	maybeSchedule(ok200(), PRERENDER, route(), 'Bingbot', null, { cacheStatus: 'miss' });
	await settle();
	assert.equal(reads, 0);
});

test('the discovery path reuses its own read: a gone row reopens, a noindex row does not', async () => {
	TargetBase.rows.set(U, { url: U, state: 'suppressed', suppressedReason: 'http-gone' });
	await handlePageScheduling(ok200(), route(), 'Googlebot', (c) => told.push(c));
	assert.deepEqual(told, ['suppressed']);
	assert.deepEqual(reopenOps(), ['would-file/traffic']);
	assert.equal(reads, 1, 'one read serves the miss cause and the reopen');

	told.length = 0;
	analytics.length = 0;
	TargetBase.rows.set(U, { url: U, state: 'suppressed', suppressedReason: 'noindex' });
	await handlePageScheduling(ok200(), route(), 'Googlebot', (c) => told.push(c));
	assert.deepEqual(told, ['suppressed']);
	assert.deepEqual(reopenOps(), []);
});

test("a HEAD's 200 reopens nothing, on either path — that claim takes a GET's status", async () => {
	// An origin's HEAD handler is not the page: plenty answer 200 to any path. Before HEAD was forwarded
	// as a HEAD this could not happen; now it must be refused explicitly.
	TargetBase.rows.set(U, { url: U, state: 'suppressed', suppressedReason: 'http-gone' });
	maybeSchedule(ok200({ method: 'HEAD' }), PRERENDER, route(), 'Bingbot', null, { cacheStatus: 'miss' });
	await settle();
	assert.equal(reads, 0, 'the gated path does not even look');
	await handlePageScheduling(ok200({ method: 'HEAD' }), route(), 'Googlebot', (c) => told.push(c));
	assert.deepEqual(told, ['suppressed'], 'the miss cause is unchanged');
	assert.deepEqual(reopenOps(), []);

	// The same request as a GET does reopen — the gate is the method, nothing else.
	await handlePageScheduling(ok200({ method: 'GET' }), route(), 'Googlebot', null);
	assert.deepEqual(reopenOps(), ['would-file/traffic']);
});
