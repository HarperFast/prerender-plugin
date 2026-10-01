import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

/**
 * `util/serveCheck.js` — a cached page checked against the origin when a bot asks for it.
 *
 * What must hold, and what these pin:
 *   - NOTHING ON THE RESPONSE PATH: the gate defers; a bot is served exactly as before.
 *   - ONLY WHEN DUE: not when the page's own render (or capture) is recent enough, not when a check
 *     already covered it (any node: the row is replicated), not for a bot outside `bots`.
 *   - THE VERDICT IS THE SWEEP'S: mapped fields compared by the same comparators against the facts of the
 *     page that was SERVED; a disarmed field never decides; nothing comparable decides nothing.
 *   - THE ACTIONS ARE THE PROBE'S: a disagreement expires and re-files (carrying the target's own fields),
 *     a disagreeing raw document is deleted, an agreement is recorded with the served page's basis.
 *   - EVERY SHORTFALL ASKS NOTHING: dry run, no budget slot, a full queue, a failed request.
 */

let serveCheck;
let applyOptions;
let config;
let ops = [];

const sabs = new Map();
const sharedBufferStub = {
	getUserSharedBuffer: (key, buffer) => {
		if (!sabs.has(key)) sabs.set(key, buffer);
		return sabs.get(key);
	},
	tryLock: () => true,
	unlock() {},
};
class FakeTable {
	static async get() {}
	static async put() {}
	static async patch() {}
	static async delete() {}
	static search() {
		return [];
	}
}
class SharedBufferFake {
	static primaryStore = sharedBufferStub;
	static async get() {
		return undefined;
	}
	static async put() {}
}

before(async () => {
	globalThis.server = {
		hostname: 'node-a',
		workerIndex: 0,
		nodes: [],
		config: { http: {} },
		recordAnalytics: (value, metric, path, method, type) => ops.push(`${metric}:${path}:${method}:${type}`),
	};
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {}, notify() {} };
	globalThis.databases = {
		coordination: { SharedBuffer: SharedBufferFake },
		probe_state: { ProbeState: FakeTable, RenderExpectation: FakeTable },
		render_service: { Target: FakeTable },
		page_cache: { PrerenderedPage: FakeTable },
		render_schedule: { RenderSchedule: FakeTable },
		invalidation: { Invalidation: FakeTable },
		verification: { PageVerification: FakeTable, PageCheck: FakeTable },
		raw_cache: { RawPage: FakeTable },
		crawl_stats: { CrawlSketch: FakeTable },
	};
	({ applyOptions, config } = await import('../src/config.js'));
	serveCheck = await import('../src/util/serveCheck.js');
});

const RULE = {
	label: 'pdp',
	pathPattern: '^/product/prd-([^/]+)',
	source: 'request',
	request: { urlTemplate: 'https://api.example.com/p/$1', method: 'POST', body: '{}' },
	extract: ['title', 'seoUrl', 'image', 'skus[*].{sku,availability,price}'],
	invalidateScope: 'route:prefix:/product/',
	pageCheck: {
		enabled: true,
		fields: [
			{ slot: 0, fact: 'title', compare: 'text' },
			{ slot: 1, fact: 'canonical', compare: 'path' },
			{ slot: 2, fact: 'product.image', compare: 'path' },
			{ slot: 3, fact: 'product.offers', compare: 'skus' },
		],
	},
};
const API = (over = {}) => ({
	title: 'Red Shoe',
	seoUrl: '/product/prd-a/red-shoe.jsp',
	image: 'https://media.example.com/i/shoe?w=350',
	skus: [
		{ sku: '111', availability: 'In Stock', price: 19.99 },
		{ sku: '222', availability: 'Out of Stock', price: null },
	],
	...over,
});
const URL_A = 'https://shop.example.com/product/prd-a/red-shoe.jsp';
const ld = (value) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
const SNAPSHOT = (over = {}) =>
	'<!doctype html><html><head><meta charset="utf-8"><title>Red Shoe</title>' +
	`<link rel="canonical" href="${URL_A}"><meta name="description" content="A shoe.">` +
	ld({
		'@type': 'Product',
		'name': 'Red Shoe',
		'image': 'https://media.example.com/i/shoe?w=1000',
		'offers': [
			{ sku: '111', price: over.price ?? '19.99', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
			{
				sku: '222',
				price: '24.99',
				priceCurrency: 'USD',
				availability: over.availability222 ?? 'https://schema.org/OutOfStock',
			},
		],
	}) +
	'</head><body><h1>Red Shoe</h1></body></html>';

let calls;
let checks; // url -> { checkedAtMs, basisAtMs }
const ANCHOR = Date.now() - 3 * 3600_000; // the nightly update, three hours ago

const setup = async (serveCheckOptions = {}, extra = {}) => {
	applyOptions({
		changeProbe: {
			enabled: true,
			rules: [RULE],
			serveCheck: { enabled: true, dryRun: false, maxAge: 0, ...serveCheckOptions },
		},
		...extra,
	});
	const { compileProbeRules, extractValues, signatureOf } = await import('../src/util/changeProbeSpec.js');
	const [compiled] = compileProbeRules([RULE]);
	calls = { probe: [], expire: [], deleteRaw: [], writeCheck: [], breadth: [], fetchDocument: [] };
	checks = new Map();
	let api = API();
	serveCheck.__setServeCheckDepsForTest({
		anchor: () => ANCHOR,
		reserveSlot: () => Date.now(),
		disarmed: async () => new Set(),
		readCheck: async (url) => checks.get(url) ?? { checkedAtMs: NaN, basisAtMs: NaN },
		writeCheck: async (url, basisAtMs) => calls.writeCheck.push({ url, basisAtMs }),
		probe: async (rule, url) => {
			calls.probe.push(url);
			return signatureOf(extractValues(api, compiled.extract));
		},
		recordBreadth: (cause, url) => calls.breadth.push({ cause, url }),
		expire: async (row) => calls.expire.push(row),
		deleteRaw: async (key) => calls.deleteRaw.push(key),
		readTarget: async (url) => ({
			url,
			sitemapUrl: 'https://shop.example.com/sitemap.xml',
			renderInterval: 1,
			demandInterval: 2,
		}),
	});
	return { setApi: (next) => (api = next) };
};

beforeEach(() => {
	ops = [];
	serveCheck.resetServeChecks();
});
afterEach(() => {
	serveCheck.__setServeCheckDepsForTest(null);
	config.changeProbe.serveCheck.enabled = false;
});

const served = (over = {}) => ({
	kind: 'page',
	url: URL_A,
	lastCachedMs: ANCHOR - 3600_000, // rendered before the nightly update: due
	body: zlib.gzipSync(Buffer.from(SNAPSHOT(over.page ?? {}))),
	contentEncoding: 'gzip',
	contentType: 'text/html; charset=utf-8',
	botName: 'Bingbot',
	route: null,
	...over,
});
const outcomes = () => ops.filter((o) => o.startsWith('prerender_ops:serve_check:')).map((o) => o.split(':')[2]);
const consider = async (input) => {
	serveCheck.considerServeCheck(input);
	await serveCheck.serveChecksSettledForTest();
};

// ---- the comparators ------------------------------------------------------------------------------

test('compareWithEndpoint: the mapped fields, by the sweep’s comparators — armed only, and nothing comparable decides nothing', async () => {
	const { compileProbeRules, extractValues } = await import('../src/util/changeProbeSpec.js');
	const { documentFactsOf } = await import('../src/util/documentFacts.js');
	const [rule] = compileProbeRules([RULE]);
	const facts = documentFactsOf(Buffer.from(SNAPSHOT())).facts;
	const agree = serveCheck.compareWithEndpoint(rule, extractValues(API(), rule.extract), facts, { pageUrl: URL_A });
	assert.deepEqual(agree, { result: 'agree' });
	// A SKU sold out at the origin while the page still offers it.
	const soldOut = API({ skus: [{ sku: '111', availability: 'Out of Stock', price: null }] });
	const mismatch = serveCheck.compareWithEndpoint(rule, extractValues(soldOut, rule.extract), facts, {
		pageUrl: URL_A,
	});
	assert.equal(mismatch.result, 'mismatch');
	assert.match(mismatch.field, /product\.offers/);
	// The same field, disarmed by the node's mapping guard: it cannot decide, and the rest agree.
	const disarmed = serveCheck.compareWithEndpoint(rule, extractValues(soldOut, rule.extract), facts, {
		pageUrl: URL_A,
		isArmed: (_rule, field) => field.fact !== 'product.offers',
	});
	assert.deepEqual(disarmed, { result: 'agree' });
	// A page that states nothing the rule maps: nothing decided.
	const none = serveCheck.compareWithEndpoint(rule, extractValues(API(), rule.extract), {}, { pageUrl: URL_A });
	assert.deepEqual(none, { result: 'inconclusive' });
});

test('compareDocuments: fact by fact, and a listing by the products in BOTH — re-ranking is not a change', () => {
	const page = {
		title: 'Shoes',
		canonical: 'https://shop.example.com/c/shoes',
		itemList: [
			['https://shop.example.com/p/a', '10.00', 'USD', 'InStock'],
			['https://shop.example.com/p/b', '20.00', 'USD', 'InStock'],
		],
	};
	const reranked = {
		title: 'Shoes',
		canonical: 'https://shop.example.com/c/shoes',
		itemList: [
			['https://shop.example.com/p/c', '5.00', 'USD', 'InStock'],
			['https://shop.example.com/p/b', '20.00', 'USD', 'InStock'],
		],
	};
	const want = ['title', 'metaDescription', 'canonical', 'itemList'];
	assert.deepEqual(serveCheck.compareDocuments(page, reranked, want), { result: 'agree' });
	const repriced = { ...reranked, itemList: [['https://shop.example.com/p/b', '18.00', 'USD', 'InStock']] };
	assert.deepEqual(serveCheck.compareDocuments(page, repriced, want), { result: 'mismatch', field: 'itemList' });
	const retitled = { ...reranked, title: 'Shoes & Boots' };
	assert.deepEqual(serveCheck.compareDocuments(page, retitled, want), { result: 'mismatch', field: 'title' });
	assert.deepEqual(serveCheck.compareDocuments({ title: null }, { title: 'x' }, want), { result: 'inconclusive' });
});

test('checkThreshold: the last anchor, and maxAge for the sampled cohort only', async () => {
	const now = ANCHOR + 13 * 3600_000; // 13h after the anchor
	await setup({ maxAge: 0 });
	assert.equal(serveCheck.checkThreshold(URL_A, now), ANCHOR);
	await setup({ maxAge: 12 * 3600_000, sample: 1 });
	assert.equal(serveCheck.checkThreshold(URL_A, now), now - 12 * 3600_000);
	await setup({ maxAge: 12 * 3600_000, sample: 0 });
	assert.equal(serveCheck.checkThreshold(URL_A, now), ANCHOR);
	await setup({ maxAge: 0 });
	serveCheck.__setServeCheckDepsForTest({ anchor: () => NaN });
	assert.ok(Number.isNaN(serveCheck.checkThreshold(URL_A, now)), 'no anchor and no maxAge: never due');
});

// ---- the gate and the check, end to end -----------------------------------------------------------

test('a due page that agrees is recorded with the SERVED page’s basis, and is asked once', async () => {
	await setup();
	const input = served();
	await consider(input);
	assert.deepEqual(calls.probe, [URL_A]);
	assert.deepEqual(calls.writeCheck, [{ url: URL_A, basisAtMs: input.lastCachedMs }]);
	assert.deepEqual(calls.expire, []);
	assert.deepEqual(outcomes(), ['queued', 'agree']);
	// The same page again on this worker: not asked again.
	await consider(served());
	assert.deepEqual(calls.probe, [URL_A]);
});

test('a due page that disagrees is expired and re-filed, carrying the target’s own fields', async () => {
	const { setApi } = await setup();
	setApi(API({ skus: [{ sku: '111', availability: 'Out of Stock', price: null }] }));
	await consider(served());
	assert.equal(calls.expire.length, 1);
	assert.deepEqual(calls.expire[0], {
		url: URL_A,
		sitemapUrl: 'https://shop.example.com/sitemap.xml',
		renderInterval: 1,
		demandInterval: 2,
	});
	assert.deepEqual(calls.writeCheck, []);
	assert.deepEqual(outcomes(), ['queued', 'mismatch']);
});

test('not asked: rendered since the threshold, already checked (by any node), or a bot outside the list', async () => {
	await setup({ bots: ['Googlebot'] });
	await consider(served({ botName: 'Bingbot' }));
	assert.deepEqual(calls.probe, [], 'a bot outside serveCheck.bots');
	await consider(served({ botName: 'Googlebot', lastCachedMs: ANCHOR + 1000 }));
	assert.deepEqual(calls.probe, [], 'rendered after the anchor: its render is the check');
	checks.set(URL_A, { checkedAtMs: ANCHOR + 60_000, basisAtMs: ANCHOR - 3600_000 });
	await consider(served({ botName: 'Googlebot' }));
	assert.deepEqual(calls.probe, [], 'checked since the anchor, covering this render');
	assert.deepEqual(outcomes(), []);
});

test('a check that covered an OLDER render does not cover a newer split sibling — and vice versa', async () => {
	await setup();
	// Checked at the anchor, covering a render from 2h before it.
	checks.set(URL_A, { checkedAtMs: ANCHOR + 60_000, basisAtMs: ANCHOR - 2 * 3600_000 });
	await consider(served({ lastCachedMs: ANCHOR - 3 * 3600_000 })); // older than the basis: not covered
	assert.deepEqual(calls.probe, [URL_A]);
});

test('dry run counts the check and its distinct URL, and asks nothing', async () => {
	await setup({ dryRun: true });
	await consider(served());
	assert.deepEqual(calls.probe, []);
	assert.deepEqual(calls.breadth, [{ cause: 'would-check', url: URL_A }]);
	assert.deepEqual(outcomes(), ['would-check']);
});

test('every shortfall asks nothing: no budget slot (shed), a full queue (busy), a failed request', async () => {
	await setup();
	serveCheck.__setServeCheckDepsForTest({
		...{ anchor: () => ANCHOR, readCheck: async () => ({ checkedAtMs: NaN, basisAtMs: NaN }) },
		reserveSlot: () => null,
		probe: async () => {
			throw new Error('should not be asked');
		},
	});
	await consider(served());
	assert.deepEqual(outcomes(), ['queued', 'shed']);
	ops = [];
	serveCheck.resetServeChecks();
	await setup({ maxPending: 1 });
	serveCheck.__setServeCheckDepsForTest({
		anchor: () => ANCHOR,
		readCheck: async () => ({ checkedAtMs: NaN, basisAtMs: NaN }),
		reserveSlot: () => Date.now() + 60_000, // the slot is a minute away: the first one waits
	});
	// Four in flight (waiting for their slot), one queued, and the sixth finds the queue full.
	for (const id of ['b', 'c', 'd', 'e', 'f', 'g']) {
		serveCheck.considerServeCheck(served({ url: `https://shop.example.com/product/prd-${id}/x.jsp` }));
	}
	for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
	assert.ok(outcomes().includes('busy'), JSON.stringify(outcomes()));
	serveCheck.resetServeChecks();
	ops = [];
	await setup();
	serveCheck.__setServeCheckDepsForTest({
		anchor: () => ANCHOR,
		reserveSlot: () => Date.now(),
		readCheck: async () => ({ checkedAtMs: NaN, basisAtMs: NaN }),
		probe: async () => {
			throw new Error('ECONNRESET');
		},
		expire: async () => assert.fail('a failed request must not act'),
	});
	await consider(served({ url: 'https://shop.example.com/product/prd-z/x.jsp' }));
	assert.deepEqual(outcomes(), ['queued', 'failed']);
});

test('a raw document is checked from its STORED facts, and a disagreeing one is deleted', async () => {
	const { setApi } = await setup();
	const { documentFactsOf, serializeDocumentFacts } = await import('../src/util/documentFacts.js');
	const stored = serializeDocumentFacts(documentFactsOf(Buffer.from(SNAPSHOT())).facts).json;
	setApi(API({ title: 'Blue Shoe' }));
	await consider(served({ kind: 'raw', body: undefined, facts: stored, rawKey: URL_A }));
	assert.deepEqual(calls.deleteRaw, [URL_A]);
	assert.deepEqual(calls.expire, []);
	assert.deepEqual(outcomes(), ['queued', 'raw-mismatch']);
});

test('a documentCheck route reads the origin document only as far as its head, and compares the listing', async () => {
	await setup({}, { ingress: { mode: 'forwarded', routes: [{ match: 'prefix', path: '/c/', documentCheck: true }] } });
	const listing = (price) =>
		'<!doctype html><html><head><meta charset="utf-8"><title>Shoes</title><link rel="canonical" href="https://shop.example.com/c/shoes">' +
		ld({
			'@type': 'CollectionPage',
			'mainEntity': {
				'@type': 'ItemList',
				'itemListElement': [
					{
						position: 1,
						item: {
							url: 'https://shop.example.com/p/a',
							offers: { price, priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
						},
					},
				],
			},
		}) +
		'</head><body>' +
		'x'.repeat(200_000) +
		'</body></html>';
	let destroyed = false;
	serveCheck.__setServeCheckDepsForTest({
		anchor: () => ANCHOR,
		reserveSlot: () => Date.now(),
		readCheck: async () => ({ checkedAtMs: NaN, basisAtMs: NaN }),
		writeCheck: async (url, basisAtMs) => calls.writeCheck.push({ url, basisAtMs }),
		expire: async (row) => calls.expire.push(row),
		readTarget: async () => null,
		fetchDocument: async (url) => {
			calls.fetchDocument.push(url);
			const body = Readable.from([zlib.gzipSync(Buffer.from(listing('9.99')))]);
			body.on('close', () => (destroyed = true));
			return { statusCode: 200, headers: { 'content-encoding': 'gzip', 'content-type': 'text/html' }, body };
		},
	});
	const { matchRoute } = await import('../src/util/routeClass.js');
	const route = matchRoute('/c/shoes');
	const page = {
		kind: 'page',
		url: 'https://shop.example.com/c/shoes',
		lastCachedMs: ANCHOR - 1,
		contentType: 'text/html; charset=utf-8',
		botName: 'Bingbot',
		route,
	};
	await consider({ ...page, body: Buffer.from(listing('9.99')) });
	assert.deepEqual(calls.fetchDocument, ['https://shop.example.com/c/shoes']);
	assert.equal(calls.writeCheck.length, 1, 'same price on the product listed in both: agree');
	assert.ok(destroyed, 'the rest of the origin body is never read');
	serveCheck.resetServeChecks();
	await consider({ ...page, url: 'https://shop.example.com/c/shoes?x', body: Buffer.from(listing('12.99')) });
	assert.equal(calls.expire.length, 1, 'a listed product repriced: expired and re-filed');
});
