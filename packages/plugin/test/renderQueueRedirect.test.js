import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * processJobResult's handling of a content-less redirect result — the shape a browser
 * (≥ v1.16.0) posts when it ends a render at navigation because the URL HTTP-redirected to a
 * different document (statusCode = the FIRST hop's 3xx, no content).
 *
 * The properties pinned here:
 *   - 301/308 onto a served route RETIRES the source (target, schedule, cached page) and
 *     ADOPTS the destination as a first-class target — due now, inheriting the source's
 *     cadence — so it renders under its own job context instead of being cached from a
 *     render that ran as another URL.
 *   - adoption never clobbers an existing destination target, never resurrects a URL in
 *     NonIndexable, and respects the domain allowlist.
 *   - 302/303/307 KEEPS the source (and its cached page) and just reschedules it: failover
 *     and geo bounces are expected to heal.
 *   - a redirect onto a route class we don't serve keeps the source too — deleting it on
 *     evidence as weak as an incomplete route list would end its rendering silently.
 *   - a targetless source (render-now one-off) has its schedule dropped, not retried forever.
 */

const DEVICE = 'desktop';
const key = (url) => `${url}|${DEVICE}`;

const A = 'https://site.example.com/product/old';
const B = 'https://site.example.com/product/new';

// One Map per table for the whole run (the module under test captures the table objects at
// import), cleared between tests.
const stores = {
	renderTarget: new Map(),
	renderSchedule: new Map(),
	prerenderedPage: new Map(),
	nonIndexable: new Map(),
};

let warns = [];
let analytics = [];

// Minimal stand-in for a Harper table/resource: static get/put/delete dispatch through an
// instance (so RenderTarget's put/delete overrides apply, exactly like Harper's Resource),
// and get() honors Harper's select semantics — a STRING select returns the bare scalar, an
// array select builds a record. Both shapes are load-bearing in the code under test.
const makeResourceBase = (rows) =>
	class FakeResource {
		constructor(id) {
			this.__id = id;
		}
		getId() {
			return this.__id;
		}
		async put(data) {
			rows.set(this.__id, { ...(rows.get(this.__id) ?? {}), ...data });
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
			if (Array.isArray(select)) {
				const picked = {};
				for (const name of select) picked[name] = row[name];
				return picked;
			}
			return { ...row };
		}
		static async put(id, data) {
			const resource = new this(id);
			return resource.put({ ...data });
		}
		static async delete(id) {
			const resource = new this(id);
			return resource.delete();
		}
		static async search() {
			return [];
		}
	};

let RenderQueue, config;

before(async () => {
	globalThis.Resource = class {};
	globalThis.server = {
		hostname: 'test-node',
		nodes: [],
		config: { http: { port: 9926 } },
		recordAnalytics: (...args) => analytics.push(args),
	};
	globalThis.logger = {
		info() {},
		warn: (msg) => warns.push(String(msg)),
		error() {},
	};
	globalThis.createBlob = (buf) => buf;
	globalThis.databases = {
		coordination: {
			SharedBuffer: {
				primaryStore: {
					getUserSharedBuffer: (_key, buf) => buf,
					tryLock: () => true,
					unlock() {},
				},
			},
		},
		render_service: {
			RenderTarget: makeResourceBase(stores.renderTarget),
			QueueControl: makeResourceBase(new Map()),
		},
		render_schedule: { RenderSchedule: makeResourceBase(stores.renderSchedule) },
		page_cache: { PrerenderedPage: makeResourceBase(stores.prerenderedPage) },
		signals: { NonIndexable: makeResourceBase(stores.nonIndexable) },
	};

	({ config } = await import('../src/config.js'));
	({ RenderQueue } = await import('../src/resources/RenderQueue.js'));
});

beforeEach(() => {
	for (const rows of Object.values(stores)) rows.clear();
	warns = [];
	analytics = [];
});

afterEach(() => {
	config.domains = [];
	config.ingress.mode = 'prefix';
	config.ingress.routes = [];
});

/** Post a job result the way the queue endpoint would: metadata buffer (+ optional content). */
const postResult = async (metadata, content) => {
	const meta = Buffer.from(JSON.stringify(metadata), 'utf8');
	const body = content ? Buffer.concat([meta, Buffer.from(content)]) : meta;
	const ctx = { headers: new Map([['x-metadata-size', String(meta.byteLength)]]) };
	await RenderQueue.processJobResult(body, ctx);
};

const seedSource = ({ renderInterval = 3_600_000 } = {}) => {
	stores.renderTarget.set(key(A), { cacheKey: key(A), url: A, deviceType: DEVICE, renderInterval });
	stores.renderSchedule.set(key(A), { nextRenderTime: 1, fromSitemap: false });
	stores.prerenderedPage.set(key(A), { statusCode: 200, content: 'old html' });
};

test('301 onto a served route retires the source and adopts the destination', async () => {
	seedSource({ renderInterval: 1234567 });
	await postResult({ id: key(A), url: A, statusCode: 301, redirectedTo: B, renderTime: 42 });

	assert.equal(stores.renderTarget.has(key(A)), false, 'source target must be retired');
	assert.equal(stores.renderSchedule.has(key(A)), false, 'source schedule must be dropped');
	assert.equal(stores.prerenderedPage.has(key(A)), false, 'source cached page must be dropped');

	const adopted = stores.renderTarget.get(key(B));
	assert.ok(adopted, 'destination must become a target of its own');
	assert.equal(adopted.renderInterval, 1234567, 'cadence is inherited — the page moved, its schedule did not');

	const schedule = stores.renderSchedule.get(key(B));
	assert.ok(schedule, 'destination must be scheduled');
	assert.ok(schedule.nextRenderTime <= Date.now(), 'due now — the source page is gone, fill the gap fast');

	assert.equal(analytics.length, 1, 'redirect results still record render_time analytics');
	assert.equal(analytics[0][3], 'redirect');
});

test('301 onto an already-targeted destination adopts nothing and leaves its schedule alone', async () => {
	seedSource();
	stores.renderTarget.set(key(B), { cacheKey: key(B), renderInterval: 999 });
	stores.renderSchedule.set(key(B), { nextRenderTime: 8_888_888_888_888 });

	await postResult({ id: key(A), url: A, statusCode: 301, redirectedTo: B });

	assert.equal(stores.renderTarget.has(key(A)), false, 'source is still retired');
	assert.equal(stores.renderTarget.get(key(B)).renderInterval, 999, 'existing destination target untouched');
	assert.equal(
		stores.renderSchedule.get(key(B)).nextRenderTime,
		8_888_888_888_888,
		'existing destination cadence must not be perturbed'
	);
});

test('temporary redirect (302) keeps the source — target, cached page — and retries next interval', async () => {
	seedSource({ renderInterval: 60_000 });
	const before = Date.now();
	await postResult({ id: key(A), url: A, statusCode: 302, redirectedTo: B });

	assert.ok(stores.renderTarget.has(key(A)), 'a failover bounce must not retire the target');
	assert.ok(stores.prerenderedPage.has(key(A)), 'the cached page keeps serving while the redirect heals');
	assert.equal(stores.renderTarget.has(key(B)), false, 'a temporary destination is not adopted');

	const schedule = stores.renderSchedule.get(key(A));
	// nextRenderTime is minute-floored "now" + interval.
	const flooredBefore = Math.floor(before / 60_000) * 60_000;
	assert.ok(
		schedule.nextRenderTime >= flooredBefore + 60_000 && schedule.nextRenderTime <= Date.now() + 60_000,
		'rescheduled one interval out'
	);
});

test('a targetless source (render-now one-off) has its schedule dropped instead of retrying forever', async () => {
	stores.renderSchedule.set(key(A), { nextRenderTime: 1 });
	await postResult({ id: key(A), url: A, statusCode: 302, redirectedTo: B });
	assert.equal(stores.renderSchedule.has(key(A)), false);
});

test('redirect onto an unrouted path keeps the source and adopts nothing', async () => {
	config.ingress.mode = 'forwarded';
	config.ingress.routes = [{ match: 'prefix', path: '/product/', mode: 'prerender' }];
	seedSource();
	const off = 'https://site.example.com/checkout/thanks';

	await postResult({ id: key(A), url: A, statusCode: 301, redirectedTo: off });

	assert.ok(stores.renderTarget.has(key(A)), 'incomplete route list must not end this URL for good');
	assert.ok(stores.renderSchedule.has(key(A)), 'source stays in rotation');
	assert.equal(stores.renderTarget.has(key(off)), false);
});

test('301 does not resurrect a destination already proven non-indexable', async () => {
	seedSource();
	stores.nonIndexable.set(B, { url: B });

	await postResult({ id: key(A), url: A, statusCode: 301, redirectedTo: B });

	assert.equal(stores.renderTarget.has(key(A)), false, 'the source still retires — the move is real');
	assert.equal(stores.renderTarget.has(key(B)), false, 'NonIndexable wins over adoption');
});

test('301 to a host outside the domain allowlist is not adopted', async () => {
	config.domains = ['site.example.com'];
	seedSource();
	const foreign = 'https://other.example.net/product/new';

	await postResult({ id: key(A), url: A, statusCode: 301, redirectedTo: foreign });

	assert.equal(stores.renderTarget.has(key(A)), false);
	assert.equal(stores.renderTarget.has(key(foreign)), false, 'a foreign host can never be marked indexable');
});

test('non-indexable results log the reason; failed results log the posted error', async () => {
	seedSource();
	await postResult({ id: key(A), url: A, statusCode: 200, isIndexable: false, reason: 'noindex' });
	assert.ok(
		warns.some((w) => w.includes(key(A)) && w.includes('(noindex)')),
		`expected a skip warn naming the reason, got: ${warns.join(' | ')}`
	);

	warns = [];
	seedSource();
	await postResult({
		id: key(A),
		url: A,
		reason: 'error',
		error: { name: 'TimeoutError', message: 'Navigation timeout of 30000 ms exceeded', phase: 'navigation' },
	});
	assert.ok(
		warns.some((w) => w.includes('TimeoutError') && w.includes('[navigation]')),
		`expected the posted error in the failure warn, got: ${warns.join(' | ')}`
	);
	assert.ok(stores.renderSchedule.has(key(A)), 'a target-backed failure is left for the lease to retry');
});
