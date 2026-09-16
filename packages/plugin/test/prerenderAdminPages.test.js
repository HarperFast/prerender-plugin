import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * `PrerenderAdmin.listPages()` — the console's page browser.
 *
 * THE PROPERTY THESE PIN IS HOW MANY ROWS THE SCAN CONSUMES, not what it returns. The defect
 * (#106) was invisible in the response: a prefix with no match AT THE SEEK POINT returned
 * `504 page-cache read timed out` because the two-sided primary-key range did not prune — the
 * walk ran past the `less_than` bound until it found `limit + 1` matches or hit the end of the
 * table. Measured live against ~800k keys: the same 504 at `limit=1`, `limit=5` and `limit=30`,
 * and for a prefix matching zero rows, because the cost was the scan and not the rows.
 *
 * So the fake below COUNTS what the consumer pulls, and deliberately does NOT honour a
 * `less_than` condition — that is exactly the behaviour that made the two-sided range useless,
 * and a fake that honoured it would make this defect untestable.
 *
 * It also holds a fixture with NO key under the probed prefix. A fixture that happens to contain
 * a matching key cannot see this bug at all, which is why the zero-match case is pinned first.
 */

let PrerenderAdmin, config;
let keys = [];
let consumed = 0;

const rowFor = (cacheKey) => ({
	cacheKey,
	statusCode: 200,
	lastCached: new Date(1_000_000).toISOString(),
	expiresAt: new Date(9_000_000_000_000).toISOString(),
	isIndexable: true,
});

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

	class FakePrerenderedPage extends mkTable() {
		// Ascending key walk honouring ONLY `greater_than` and `limit` — see the note above on why
		// `less_than` is ignored on purpose. Lazy, so breaking out of the consumer stops the walk,
		// which is the whole mechanism under test.
		static async *search({ conditions = [], limit = Infinity } = {}) {
			const gt = conditions.find((c) => c.comparator === 'greater_than')?.value ?? '';
			let yielded = 0;
			for (const key of keys) {
				if (key <= gt) continue;
				if (yielded >= limit) return;
				consumed++;
				yielded++;
				yield rowFor(key);
			}
		}
	}

	globalThis.databases = new Proxy(
		{},
		{
			get: (_, db) =>
				db === 'page_cache'
					? new Proxy({}, { get: (__, t) => (t === 'PrerenderedPage' ? FakePrerenderedPage : mkTable()) })
					: new Proxy({}, { get: () => mkTable() }),
		}
	);
	globalThis.transaction = (fn) => fn({});

	({ config } = await import('../src/config.js'));
	({ PrerenderAdmin } = await import('../src/resources/PrerenderAdmin.js'));
});

const ORIGIN = 'https://example.com';
beforeEach(() => {
	consumed = 0;
	config.ingress.routes = [{ match: 'prefix', path: '/catalog/' }];
	// Sorted, as a primary-key walk returns them. Nothing under `/catalog.jsp?CN=Nope`.
	keys = [
		`${ORIGIN}/catalog.jsp?CN=Brand:ACME|desktop`,
		`${ORIGIN}/catalog.jsp?CN=Brand:ACME|mobile`,
		`${ORIGIN}/catalog.jsp?CN=Size:2T|desktop`,
		`${ORIGIN}/product/prd-1/a.jsp|desktop`,
		`${ORIGIN}/product/prd-2/b.jsp|desktop`,
		`${ORIGIN}/product/prd-3/c.jsp|desktop`,
	].sort();
});

const call = (params) =>
	PrerenderAdmin.listPages({
		get: (k) => params[k],
	});

test('a prefix with NO match at the seek point costs ONE row, not a walk to the end of the table', async () => {
	// The seek lands on `Brand:ACME…`, which is not under the probed prefix. Ascending order makes
	// that the proof that nothing later can match either.
	const res = await call({ prefix: `${ORIGIN}/catalog.jsp?CN=Nope:None`, limit: '1' });

	assert.equal(res.status, 200, 'a zero-match prefix is an empty page, never a 504');
	const body = await res.json();
	assert.deepEqual(body.pages, []);
	assert.equal(body.truncated, false);
	assert.equal(body.nextCursor, null);
	assert.equal(consumed, 1, 'stopped at the first key outside the prefix');
});

test('the cost of a zero-match prefix does not grow with limit — that was the defect signature', async () => {
	await call({ prefix: `${ORIGIN}/catalog.jsp?CN=Nope:None`, limit: '1' });
	const atOne = consumed;
	consumed = 0;
	await call({ prefix: `${ORIGIN}/catalog.jsp?CN=Nope:None`, limit: '30' });
	assert.equal(consumed, atOne, 'flat in limit');
});

test('a prefix that sorts BEFORE every key stops immediately instead of walking the table', async () => {
	const res = await call({ prefix: 'aaaa-sorts-first', limit: '5' });
	assert.equal(res.status, 200);
	assert.deepEqual((await res.json()).pages, []);
	assert.equal(consumed, 1);
});

test('a matching prefix returns its rows and stops at the first key outside it', async () => {
	const res = await call({ prefix: `${ORIGIN}/catalog.jsp?CN=Brand:ACME`, limit: '10' });
	const body = await res.json();

	assert.deepEqual(
		body.pages.map((p) => p.cacheKey),
		[`${ORIGIN}/catalog.jsp?CN=Brand:ACME|desktop`, `${ORIGIN}/catalog.jsp?CN=Brand:ACME|mobile`]
	);
	assert.equal(body.truncated, false);
	// Two matches, then one row past the prefix that ends the page.
	assert.equal(consumed, 3);
});

test('a full page reports truncated + nextCursor and never consumes past limit + 1', async () => {
	const res = await call({ prefix: `${ORIGIN}/product/`, limit: '2' });
	const body = await res.json();

	assert.equal(body.pages.length, 2);
	assert.equal(body.truncated, true);
	assert.equal(body.nextCursor, `${ORIGIN}/product/prd-2/b.jsp|desktop`);
	assert.equal(consumed, 3, 'limit + 1, and not one row more');
});

test('the cursor resumes after the last key and keeps the prefix bound', async () => {
	const res = await call({
		prefix: `${ORIGIN}/product/`,
		cursor: `${ORIGIN}/product/prd-2/b.jsp|desktop`,
		limit: '2',
	});
	const body = await res.json();

	assert.deepEqual(
		body.pages.map((p) => p.cacheKey),
		[`${ORIGIN}/product/prd-3/c.jsp|desktop`]
	);
	assert.equal(body.truncated, false);
});

test('no prefix at all is an unbounded ascending walk bounded only by limit', async () => {
	const res = await call({ limit: '3' });
	const body = await res.json();

	assert.equal(body.pages.length, 3);
	assert.equal(body.truncated, true);
	assert.equal(consumed, 4, 'limit + 1');
});
