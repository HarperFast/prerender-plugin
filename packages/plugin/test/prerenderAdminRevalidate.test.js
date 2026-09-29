import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * `POST /prerender_admin/revalidate` — `PrerenderAdmin.revalidateUrl()`.
 *
 * v0.94.0 moved the write to `fileDueNow` and deleted the local `nextRenderTime`, which the response
 * still returned by shorthand. Every call then threw a ReferenceError AFTER filing the render, and
 * Harper's transactional wrapper rolled the filed render back, so the button did nothing and
 * answered 500. Nothing called the handler, and `no-undef` was off for the plugin. These tests
 * call it.
 */

const scheduleRows = new Map();
let targetRow = null;

let PrerenderAdmin, config;

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
			static primaryStore = {
				tryLock: () => true,
				unlock() {},
				getUserSharedBuffer: (key, buf) => new SharedArrayBuffer(buf?.byteLength ?? 8),
			};
		};
	class FakeTarget extends mkTable() {
		static async get() {
			return targetRow ? { ...targetRow } : null;
		}
	}
	class FakeSchedule extends mkTable() {
		static async get(query) {
			const id = typeof query === 'object' ? query.id : query;
			const row = scheduleRows.get(id);
			return row ? { ...row } : null;
		}
		static async put(id, data) {
			scheduleRows.set(id, { cacheKey: id, ...data });
		}
	}
	const tableFor = (_, table) =>
		table === 'Target' ? FakeTarget : table === 'RenderSchedule' ? FakeSchedule : mkTable();
	globalThis.databases = new Proxy({}, { get: () => new Proxy({}, { get: tableFor }) });
	globalThis.transaction = (fn) => fn({});

	({ config } = await import('../src/config.js'));
	({ PrerenderAdmin } = await import('../src/resources/PrerenderAdmin.js'));
});

beforeEach(() => {
	scheduleRows.clear();
	targetRow = { url: 'https://example.com/a', sitemapUrl: null, renderInterval: null, demandInterval: null };
	config.ingress.routes = [{ match: 'prefix', path: '/' }];
});

test('revalidate for a URL with a Target answers 200 with the due time it filed', async () => {
	const before = Date.now();
	const res = await PrerenderAdmin.revalidateUrl({ url: 'https://example.com/a' });
	assert.equal(res.status, 200);
	const body = await res.json();

	const row = scheduleRows.get('https://example.com/a');
	assert.ok(row, 'the render was filed');
	assert.equal(body.nextRenderTime, row.nextRenderTime, 'the response names the due time that was written');
	// Filed at the current minute: never later than now.
	assert.ok(body.nextRenderTime <= Date.now() && body.nextRenderTime > before - 60_000, String(body.nextRenderTime));
	assert.equal(body.canonicalUrl, 'https://example.com/a');
});

test('revalidate keeps an earlier due time the row already had, and reports that one', async () => {
	// `fileDueNow` never demotes: a row already due keeps its place, and the response must say so
	// rather than claim the current minute.
	const earlier = Date.now() - 3_600_000;
	scheduleRows.set('https://example.com/a', {
		cacheKey: 'https://example.com/a',
		nextRenderTime: earlier,
		fromSitemap: false,
		effectiveInterval: null,
	});

	const res = await PrerenderAdmin.revalidateUrl({ url: 'https://example.com/a' });
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(body.nextRenderTime, earlier);
	assert.equal(scheduleRows.get('https://example.com/a').nextRenderTime, earlier);
});

test('revalidate without a Target is still refused with 409 and files nothing', async () => {
	targetRow = null;
	const res = await PrerenderAdmin.revalidateUrl({ url: 'https://example.com/a' });
	assert.equal(res.status, 409);
	assert.equal(scheduleRows.size, 0);
});
