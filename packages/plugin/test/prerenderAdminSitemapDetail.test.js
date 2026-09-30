import { test, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * `PrerenderAdmin.sitemapDetail` reports how many entries are STORED beside the document's true
 * `entryCount`. A urlset row keeps only a leading sample from v0.97.0, and a console paging to
 * `entryCount` ran out at the sample and kept offering "next" onto empty pages.
 */

const CHILD = 'https://example.com/sitemap_product_1.xml';
const sitemapRow = {
	url: CHILD,
	isIndex: false,
	entryCount: 50_000,
	entries: Array.from({ length: 500 }, (_, i) => ({ loc: `https://example.com/product/prd-${i}` })),
	lastRefreshed: new Date(1_000_000).toISOString(),
	parentUrl: null,
};

let PrerenderAdmin;

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
	class FakeSitemap extends mkTable() {
		static async get(query) {
			const id = typeof query === 'object' ? query.id : query;
			if (id !== CHILD) return null;
			const select = typeof query === 'object' ? query.select : undefined;
			return select ? Object.fromEntries(select.map((key) => [key, sitemapRow[key]])) : { ...sitemapRow };
		}
	}
	const tableFor = (_, table) => (table === 'Sitemap' ? FakeSitemap : mkTable());
	globalThis.databases = new Proxy({}, { get: () => new Proxy({}, { get: tableFor }) });
	globalThis.transaction = (fn) => fn({});

	({ PrerenderAdmin } = await import('../src/resources/PrerenderAdmin.js'));
});

test('the detail reports the stored entries beside the true entryCount, and a page past them is empty', async () => {
	const body = await (await PrerenderAdmin.sitemapDetail({ url: CHILD, offset: 450, limit: 50 })).json();
	assert.equal(body.sitemap.entryCount, 50_000);
	assert.equal(body.sitemap.entriesStored, 500);
	assert.equal(body.entries.length, 50);

	const past = await (await PrerenderAdmin.sitemapDetail({ url: CHILD, offset: 500, limit: 50 })).json();
	assert.equal(past.entries.length, 0, 'which is why a client pages to entriesStored');
});
