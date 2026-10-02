import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkHarperKey } from './support/harperKeyLimit.js';

/**
 * `PrerenderAdmin.explain` for a URL too long to be a cache key. Its reads would throw on the key, and
 * `readWithTimeout` turns a throw into a "degraded" view that blames timed-out reads — so the endpoint
 * answers from the explanation alone: nothing stored or scheduled, a bot request proxied to the origin.
 */

let PrerenderAdmin;
const touched = [];

before(async () => {
	globalThis.Resource = class {
		static loadAsInstance;
	};
	globalThis.server = {
		hostname: 'test-node',
		nodes: [],
		workerIndex: 1,
		recordAnalytics() {},
		config: { http: { securePort: 9926 } },
	};
	globalThis.logger = { info() {}, warn() {}, error() {}, notify() {}, debug() {}, trace() {} };
	globalThis.contentTypes = { set() {} };

	// Every table applies Harper's key check and records what it was asked for.
	const mkTable = (name) =>
		class FakeTable {
			static async get(query) {
				const id = typeof query === 'object' && query !== null ? query.id : query;
				touched.push(`${name}:${id}`);
				checkHarperKey(id);
				return null;
			}
			static async put() {}
			static async *search() {}
			static async subscribe() {}
			static primaryStore = {
				tryLock: () => true,
				unlock() {},
				getUserSharedBuffer: (key, buf) => new SharedArrayBuffer(buf?.byteLength ?? 8),
			};
		};
	globalThis.databases = new Proxy({}, { get: (_, db) => new Proxy({}, { get: (__, t) => mkTable(`${db}.${t}`) }) });
	globalThis.transaction = (fn) => fn({});

	({ PrerenderAdmin } = await import('../src/resources/PrerenderAdmin.js'));
});

beforeEach(() => {
	touched.length = 0;
});

test('explain for a URL too long to key answers without a read: not keyable, served by the origin', async () => {
	const url = `https://www.example.com/a/${'x'.repeat(2100)}`;
	const res = await PrerenderAdmin.explain({ url, deviceType: 'desktop' });
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(body.eligibility.keyable, false);
	assert.equal(body.eligibility.prerendered, false);
	assert.deepEqual(body.verdict, {
		reliable: true,
		wouldServe: 'origin',
		scheduled: false,
		recurring: false,
		suppressed: false,
	});
	assert.equal(body.degraded, null, 'not blamed on timed-out reads');
	assert.deepEqual(body.rows, { renderTarget: null, renderSchedule: null, prerenderedPage: null, suppression: null });
	assert.deepEqual(touched, [], 'no read under a key Harper would refuse');
});

test('explain for an ordinary URL still reads its rows', async () => {
	const res = await PrerenderAdmin.explain({ url: 'https://www.example.com/a', deviceType: 'desktop' });
	const body = await res.json();
	assert.equal(body.eligibility.keyable, true);
	assert.ok(
		touched.some((t) => t.endsWith('.Target:https://www.example.com/a')),
		touched.join(', ')
	);
});

test('revalidate for a URL too long to key is a plain 400, not the 504 a swallowed key throw read as', async () => {
	const res = await PrerenderAdmin.revalidateUrl({ url: `https://www.example.com/a/${'x'.repeat(2100)}` });
	assert.equal(res.status, 400);
	assert.match((await res.json()).error, /too long to be a cache key/);
	assert.deepEqual(touched, []);
});

test('explain names the URL’s entity and reads its row — and reads nothing for it while the registry is off', async () => {
	const { applyOptions } = await import('../src/config.js');
	const routes = [{ match: 'prefix', path: '/product/prd-', queryParams: [], entityPrefix: '^/product/prd-[^/]+/' }];
	const url = 'https://www.example.com/product/prd-1/email.jsp';
	try {
		applyOptions({ ingress: { mode: 'forwarded', routes }, entities: { enabled: true } });
		const body = await (await PrerenderAdmin.explain({ url, deviceType: 'desktop' })).json();
		assert.equal(body.rows.entity.key, 'https://www.example.com/product/prd-1/');
		assert.equal(body.rows.entity.canonical, null, 'no row yet');
		assert.ok(touched.includes('render_service.Entity:https://www.example.com/product/prd-1/'), touched.join(', '));

		touched.length = 0;
		applyOptions({ ingress: { mode: 'forwarded', routes }, entities: { enabled: false } });
		const off = await (await PrerenderAdmin.explain({ url, deviceType: 'desktop' })).json();
		assert.equal(off.rows.entity, null);
		assert.ok(!touched.some((t) => t.includes('.Entity:')));
	} finally {
		applyOptions({});
	}
});
