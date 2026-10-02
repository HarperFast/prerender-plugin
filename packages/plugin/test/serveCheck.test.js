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
let checks; // url -> a PageCheck record (util/pageCheck.js readPageCheck)
let bases; // key -> the served copy's lastCached now (ms); absent = unchanged
const NO_CHECK = { checkedAtMs: NaN, basisAtMs: NaN, outcome: null, field: null, evidence: null, observedDigest: null };
const check = (over) => ({ ...NO_CHECK, outcome: 'agree', ...over });
const ANCHOR = Date.now() - 3 * 3600_000; // the nightly update, three hours ago

const setup = async (serveCheckOptions = {}, extra = {}) => {
	applyOptions({
		changeProbe: {
			enabled: true,
			dryRun: false,
			rules: [RULE],
			serveCheck: { enabled: true, dryRun: false, maxAge: 0, ...serveCheckOptions },
		},
		...extra,
	});
	const { compileProbeRules, extractValues, signatureOf } = await import('../src/util/changeProbeSpec.js');
	const [compiled] = compileProbeRules([RULE]);
	calls = {
		probe: [],
		expire: [],
		expireOnly: [],
		deleteRaw: [],
		writeCheck: [],
		breadth: [],
		fetchDocument: [],
		pushback: [],
	};
	checks = new Map();
	bases = new Map();
	let api = API();
	serveCheck.__setServeCheckDepsForTest({
		anchor: () => ANCHOR,
		reserveSlot: () => Date.now(),
		disarmed: async () => new Set(),
		readCheck: async (url) => checks.get(url) ?? NO_CHECK,
		writeCheck: async (url, basisAtMs, options = {}) => calls.writeCheck.push({ url, basisAtMs, ...options }),
		readBasis: async (kind, key) => (bases.has(key) ? bases.get(key) : 0),
		pushback: (retryAfterMs) => calls.pushback.push(retryAfterMs),
		healthy: () => {},
		expireOnly: async (url) => calls.expireOnly.push(url),
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
	// As stored: the serve path hands the row's headers over unparsed.
	headers: JSON.stringify({ 'content-encoding': 'gzip', 'content-type': 'text/html; charset=utf-8' }),
	cacheKey: `${over.url ?? URL_A}|desktop`,
	deviceType: 'desktop',
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
	assert.deepEqual(agree, { result: 'agree', canonicalAgreed: true });
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
	assert.deepEqual(disarmed, { result: 'agree', canonicalAgreed: true });
	// A page that states nothing the rule maps: nothing decided.
	const none = serveCheck.compareWithEndpoint(rule, extractValues(API(), rule.extract), {}, { pageUrl: URL_A });
	assert.deepEqual(none, { result: 'inconclusive', canonicalAgreed: false });
});

test('compareWithEndpoint: canonicalAgreed says the CANONICAL compared and agreed — not that the check did', async () => {
	const { compileProbeRules, extractValues } = await import('../src/util/changeProbeSpec.js');
	const { documentFactsOf } = await import('../src/util/documentFacts.js');
	const [rule] = compileProbeRules([RULE]);
	const facts = documentFactsOf(Buffer.from(SNAPSHOT())).facts;
	const values = extractValues(API(), rule.extract);
	// The canonical field disarmed by the mapping guard: the check still agrees, on everything else, and
	// says nothing about the canonical.
	const disarmed = serveCheck.compareWithEndpoint(rule, values, facts, {
		pageUrl: URL_A,
		isArmed: (_rule, field) => field.fact !== 'canonical',
	});
	assert.deepEqual(disarmed, { result: 'agree', canonicalAgreed: false });
	// The page states no canonical: nothing about it compared.
	const noCanonical = serveCheck.compareWithEndpoint(rule, values, { ...facts, canonical: null }, { pageUrl: URL_A });
	assert.deepEqual(noCanonical, { result: 'agree', canonicalAgreed: false });
	// The origin re-spelled the slug: a disagreement, and certainly no agreement on the canonical.
	const respelled = serveCheck.compareWithEndpoint(
		rule,
		extractValues(API({ seoUrl: '/product/prd-a/new-spelling.jsp' }), rule.extract),
		facts,
		{ pageUrl: URL_A }
	);
	assert.equal(respelled.result, 'mismatch');
	assert.equal(respelled.canonicalAgreed, false);
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
	assert.deepEqual(serveCheck.compareDocuments(page, reranked, want), { result: 'agree', canonicalAgreed: true });
	// A canonical the check is not asked to compare says nothing about it.
	assert.deepEqual(serveCheck.compareDocuments(page, reranked, ['title', 'itemList']), {
		result: 'agree',
		canonicalAgreed: false,
	});
	const repriced = { ...reranked, itemList: [['https://shop.example.com/p/b', '18.00', 'USD', 'InStock']] };
	const repricedVerdict = serveCheck.compareDocuments(page, repriced, want);
	assert.equal(repricedVerdict.result, 'mismatch');
	assert.equal(repricedVerdict.field, 'itemList');
	// The evidence is what the DISAGREEING entries say: a re-rank of the rest does not move it.
	const repricedReranked = {
		...reranked,
		itemList: [['https://shop.example.com/p/d', '1.00', 'USD', 'InStock'], ...repriced.itemList],
	};
	assert.equal(serveCheck.compareDocuments(page, repricedReranked, want).evidence, repricedVerdict.evidence);
	const retitled = { ...reranked, title: 'Shoes & Boots' };
	const retitledVerdict = serveCheck.compareDocuments(page, retitled, want);
	assert.equal(retitledVerdict.result, 'mismatch');
	assert.equal(retitledVerdict.field, 'title');
	// A listing that names one product twice compares nothing: pairing its entries would be a guess.
	const twice = [
		['https://shop.example.com/p/a', '10.00', 'USD', 'InStock'],
		['https://shop.example.com/p/a', '12.00', 'USD', 'InStock'],
	];
	assert.deepEqual(serveCheck.compareDocuments({ itemList: twice }, { itemList: twice }, ['itemList']), {
		result: 'inconclusive',
		canonicalAgreed: false,
	});
	assert.deepEqual(serveCheck.compareDocuments({ title: null }, { title: 'x' }, want), {
		result: 'inconclusive',
		canonicalAgreed: false,
	});
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
	assert.equal(calls.writeCheck.length, 1);
	const [written] = calls.writeCheck;
	assert.equal(written.basisAtMs, input.lastCachedMs);
	assert.equal(written.outcome, 'agree');
	// EXACTLY the probe's observation (writePageCheck digests it), or the sweep could never match its baseline.
	const { compileProbeRules, extractValues, signatureOf } = await import('../src/util/changeProbeSpec.js');
	assert.equal(written.signature, signatureOf(extractValues(API(), compileProbeRules([RULE])[0].extract)));
	assert.deepEqual(calls.expire, []);
	assert.deepEqual(outcomes(), ['queued', 'agree']);
	// The canonical was among what agreed — the one fact the entity serve takes as confirmation.
	assert.equal(written.canonicalAgreed, true);
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
	// Recorded too, so no other worker or node asks about the same copy this window.
	assert.equal(calls.writeCheck.length, 1);
	assert.equal(calls.writeCheck[0].outcome, 'mismatch');
	assert.match(calls.writeCheck[0].field, /product\.offers/);
	assert.equal(typeof calls.writeCheck[0].evidence, 'string');
	assert.ok(!calls.writeCheck[0].signature, 'only an agreement can spare the sweep');
	// The disagreement was on the offers; the canonical still compared and agreed, and says so.
	assert.equal(calls.writeCheck[0].canonicalAgreed, true);
	assert.deepEqual(outcomes(), ['queued', 'mismatch']);
});

test('not asked: rendered since the threshold, already checked (by any node), or a bot outside the list', async () => {
	await setup({ bots: ['Googlebot'] });
	await consider(served({ botName: 'Bingbot' }));
	assert.deepEqual(calls.probe, [], 'a bot outside serveCheck.bots');
	await consider(served({ botName: 'Googlebot', lastCachedMs: ANCHOR + 1000 }));
	assert.deepEqual(calls.probe, [], 'rendered after the anchor: its render is the check');
	checks.set(URL_A, check({ checkedAtMs: ANCHOR + 60_000, basisAtMs: ANCHOR - 3600_000 }));
	await consider(served({ botName: 'Googlebot' }));
	assert.deepEqual(calls.probe, [], 'checked since the anchor, covering this render');
	assert.deepEqual(outcomes(), []);
});

test('a check that covered an OLDER render does not cover a newer split sibling — and vice versa', async () => {
	await setup();
	// Checked at the anchor, covering a render from 2h before it.
	checks.set(URL_A, check({ checkedAtMs: ANCHOR + 60_000, basisAtMs: ANCHOR - 2 * 3600_000 }));
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
		...{ anchor: () => ANCHOR, readCheck: async () => NO_CHECK },
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
		readCheck: async () => NO_CHECK,
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
	const recorded = new Map();
	let asked = 0;
	serveCheck.__setServeCheckDepsForTest({
		anchor: () => ANCHOR,
		reserveSlot: () => Date.now(),
		readCheck: async (url) => recorded.get(url) ?? NO_CHECK,
		writeCheck: async (url, basisAtMs, options) =>
			recorded.set(url, { ...NO_CHECK, checkedAtMs: Date.now(), basisAtMs, ...options }),
		readBasis: async () => 0,
		probe: async () => {
			asked++;
			throw new Error('a refused request');
		},
		expire: async () => assert.fail('a failed request must not act'),
	});
	const failing = served({ url: 'https://shop.example.com/product/prd-z/x.jsp' });
	await consider(failing);
	assert.deepEqual(outcomes(), ['queued', 'failed']);
	assert.equal(recorded.get(failing.url)?.outcome, 'failed', 'recorded, so the window is covered');
	// Another worker (fresh memory), the same window: not asked again, however often bots ask for the page.
	serveCheck.resetServeChecks();
	await consider(failing);
	assert.equal(asked, 1);
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
		readCheck: async () => NO_CHECK,
		readBasis: async () => 0,
		writeCheck: async (url, basisAtMs, options = {}) => calls.writeCheck.push({ url, basisAtMs, ...options }),
		expire: async (row) => calls.expire.push(row),
		readTarget: async (url) => ({ url, sitemapUrl: null }),
		fetchDocument: async (url, deviceType) => {
			calls.fetchDocument.push({ url, deviceType });
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
		headers: { 'content-type': 'text/html; charset=utf-8' },
		deviceType: 'mobile',
		botName: 'Bingbot',
		route,
	};
	await consider({ ...page, body: Buffer.from(listing('9.99')) });
	assert.deepEqual(
		calls.fetchDocument,
		[{ url: 'https://shop.example.com/c/shoes', deviceType: 'mobile' }],
		"the origin is asked as the served page's device"
	);
	assert.equal(calls.writeCheck.length, 1, 'same price on the product listed in both: agree');
	assert.equal(calls.writeCheck[0].outcome, 'agree');
	assert.ok(destroyed, 'the rest of the origin body is never read');
	serveCheck.resetServeChecks();
	await consider({ ...page, url: 'https://shop.example.com/c/shoes?x', body: Buffer.from(listing('12.99')) });
	assert.equal(calls.expire.length, 1, 'a listed product repriced: expired and re-filed');
});

// ---- review round 2: what a check must never do --------------------------------------------------

const SOLD_OUT = () => API({ skus: [{ sku: '111', availability: 'Out of Stock', price: null }] });

test('a copy re-rendered while its check waited is not compared — and one re-rendered during the request is not acted on', async () => {
	await setup();
	const input = served();
	// Replaced before the slot came up: nothing asked.
	bases.set(input.cacheKey, input.lastCachedMs + 60_000);
	await consider(input);
	assert.deepEqual(calls.probe, []);
	assert.deepEqual(outcomes(), ['queued', 'superseded']);
	// Removed: the same.
	ops = [];
	serveCheck.resetServeChecks();
	bases.set(input.cacheKey, NaN);
	await consider(input);
	assert.deepEqual(calls.probe, []);
	assert.deepEqual(outcomes(), ['queued', 'superseded']);
	// Replaced while the request was out, by the render the sweep's detection filed: the new page stands.
	ops = [];
	serveCheck.resetServeChecks();
	const { setApi } = await setup();
	setApi(SOLD_OUT());
	serveCheck.__setServeCheckDepsForTest({
		anchor: () => ANCHOR,
		reserveSlot: () => Date.now(),
		disarmed: async () => new Set(),
		readCheck: async () => NO_CHECK,
		readBasis: async () => (calls.probe.length ? input.lastCachedMs + 1 : input.lastCachedMs),
		probe: async (rule, url) => {
			calls.probe.push(url);
			const { compileProbeRules, extractValues, signatureOf } = await import('../src/util/changeProbeSpec.js');
			return signatureOf(extractValues(SOLD_OUT(), compileProbeRules([RULE])[0].extract));
		},
		expire: async () => assert.fail('the page that replaced it must not be expired'),
		writeCheck: async () => {},
	});
	await consider(input);
	assert.deepEqual(outcomes(), ['queued', 'superseded']);
});

test('the same disagreement on a page rendered after it, the origin unchanged, is HELD; an origin that moved is acted on', async () => {
	const { setApi } = await setup();
	setApi(SOLD_OUT());
	// The first mismatch: acted on, and its evidence recorded.
	await consider(served());
	assert.equal(calls.expire.length, 1);
	const first = calls.writeCheck[0];
	assert.equal(first.outcome, 'mismatch');
	// The re-render landed (newer basis), and the origin still says exactly the same: systematic, held.
	const rerendered = served({ lastCachedMs: ANCHOR - 600_000 });
	checks.set(
		URL_A,
		check({
			outcome: 'mismatch',
			field: first.field,
			evidence: first.evidence,
			checkedAtMs: ANCHOR - 1,
			basisAtMs: ANCHOR - 3600_000,
		})
	);
	ops = [];
	serveCheck.resetServeChecks();
	await consider(rerendered);
	assert.equal(calls.expire.length, 1, 'not re-rendered again');
	assert.equal(calls.writeCheck.at(-1).outcome, 'held');
	assert.deepEqual(outcomes(), ['queued', 'held']);
	// Held stays held while the origin says the same, whatever the page's age.
	checks.set(
		URL_A,
		check({
			outcome: 'held',
			field: first.field,
			evidence: first.evidence,
			checkedAtMs: ANCHOR - 1,
			basisAtMs: ANCHOR - 600_000,
		})
	);
	ops = [];
	serveCheck.resetServeChecks();
	await consider(rerendered);
	assert.equal(calls.expire.length, 1);
	assert.deepEqual(outcomes(), ['queued', 'held']);
	// The origin moved since (a sale that began and then ended): a new change, acted on.
	setApi(API({ skus: [{ sku: '111', availability: 'In Stock', price: 9.99 }] }));
	ops = [];
	serveCheck.resetServeChecks();
	await consider(rerendered);
	assert.equal(calls.expire.length, 2);
	assert.deepEqual(outcomes(), ['queued', 'mismatch']);
	// The re-render never landed (same basis as the last mismatch): re-filed again, not held.
	setApi(SOLD_OUT());
	checks.set(
		URL_A,
		check({
			outcome: 'mismatch',
			field: first.field,
			evidence: first.evidence,
			checkedAtMs: ANCHOR - 1,
			basisAtMs: ANCHOR - 3600_000,
		})
	);
	ops = [];
	serveCheck.resetServeChecks();
	await consider(served());
	assert.equal(calls.expire.length, 3);
	assert.deepEqual(outcomes(), ['queued', 'mismatch']);
});

test('two requests for one URL at once on one worker ask once', async () => {
	await setup();
	let release;
	const gate = new Promise((resolve) => (release = resolve));
	serveCheck.__setServeCheckDepsForTest({
		anchor: () => ANCHOR,
		reserveSlot: () => Date.now(),
		disarmed: async () => new Set(),
		readBasis: async () => 0,
		writeCheck: async () => {},
		readCheck: async () => {
			await gate; // both gates are inside the read at once
			return NO_CHECK;
		},
		probe: async (rule, url) => {
			calls.probe.push(url);
			return null;
		},
	});
	serveCheck.considerServeCheck(served());
	serveCheck.considerServeCheck(served());
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
	release();
	await serveCheck.serveChecksSettledForTest();
	assert.equal(calls.probe.length, 1);
});

test('nothing comparable is recorded too, and any recorded verdict covers the copy for every other worker and node', async () => {
	await setup();
	const { compileProbeRules } = await import('../src/util/changeProbeSpec.js');
	const labels = compileProbeRules([RULE])[0].pageCheck.fields.map((field) => field.label);
	// Every mapped field disarmed by the node's guard: the endpoint answered, nothing could decide.
	serveCheck.__setServeCheckDepsForTest({
		anchor: () => ANCHOR,
		reserveSlot: () => Date.now(),
		readCheck: async () => NO_CHECK,
		readBasis: async () => 0,
		disarmed: async () => new Set(labels),
		writeCheck: async (url, basisAtMs, options = {}) => calls.writeCheck.push({ url, basisAtMs, ...options }),
		probe: async () => {
			const { extractValues, signatureOf } = await import('../src/util/changeProbeSpec.js');
			return signatureOf(extractValues(API(), compileProbeRules([RULE])[0].extract));
		},
	});
	await consider(served());
	assert.deepEqual(outcomes(), ['queued', 'inconclusive']);
	assert.equal(calls.writeCheck.at(-1).outcome, 'inconclusive', 'asking again in 5 minutes would get the same nothing');
	// A page that states nothing at all: nothing to queue.
	ops = [];
	serveCheck.resetServeChecks();
	await consider(
		served({
			url: 'https://shop.example.com/product/prd-m/x.jsp',
			body: zlib.gzipSync(Buffer.from('<!doctype html><html><head></head><body></body></html>')),
		})
	);
	assert.deepEqual(outcomes(), ['no-facts']);
	// A recorded mismatch for this copy, from another node: covered, not asked again.
	await setup();
	checks.set(
		URL_A,
		check({ outcome: 'mismatch', field: 'x', evidence: 'y', checkedAtMs: ANCHOR + 1, basisAtMs: ANCHOR - 3600_000 })
	);
	await consider(served());
	assert.deepEqual(calls.probe, []);
});

test("the probe's own dry run keeps its checks dry", async () => {
	await setup();
	applyOptions({
		changeProbe: {
			enabled: true,
			dryRun: true,
			rules: [RULE],
			serveCheck: { enabled: true, dryRun: false, maxAge: 0 },
		},
	});
	await consider(served());
	assert.deepEqual(calls.probe, []);
	assert.deepEqual(outcomes(), ['would-check']);
});

test('pushback pauses out-of-pass requests node-wide (with its Retry-After) and is counted as throttled', async () => {
	await setup();
	serveCheck.__setServeCheckDepsForTest({
		anchor: () => ANCHOR,
		reserveSlot: () => Date.now(),
		readCheck: async () => NO_CHECK,
		readBasis: async () => 0,
		pushback: (retryAfterMs) => calls.pushback.push(retryAfterMs),
		probe: async () => {
			throw Object.assign(new Error('HTTP 429'), { statusCode: 429, distress: true, retryAfterMs: 30_000 });
		},
		expire: async () => assert.fail('a refused request must not act'),
	});
	await consider(served());
	assert.deepEqual(calls.pushback, [30_000]);
	assert.deepEqual(outcomes(), ['queued', 'throttled']);
});

test('a disagreeing page with no Target is only expired; a suppressed Target is left to the suppression path', async () => {
	const { setApi } = await setup();
	setApi(SOLD_OUT());
	serveCheck.__setServeCheckDepsForTest({
		anchor: () => ANCHOR,
		reserveSlot: () => Date.now(),
		disarmed: async () => new Set(),
		readCheck: async () => NO_CHECK,
		readBasis: async () => 0,
		writeCheck: async (url, basisAtMs, options = {}) => calls.writeCheck.push({ url, basisAtMs, ...options }),
		probe: async () => {
			const { compileProbeRules, extractValues, signatureOf } = await import('../src/util/changeProbeSpec.js');
			return signatureOf(extractValues(SOLD_OUT(), compileProbeRules([RULE])[0].extract));
		},
		expire: async () => assert.fail('nothing to re-file'),
		expireOnly: async (url) => calls.expireOnly.push(url),
		readTarget: async () => null,
	});
	await consider(served());
	assert.deepEqual(calls.expireOnly, [URL_A]);
	assert.deepEqual(outcomes(), ['queued', 'no-target']);
	ops = [];
	serveCheck.resetServeChecks();
	serveCheck.__setServeCheckDepsForTest({
		anchor: () => ANCHOR,
		reserveSlot: () => Date.now(),
		disarmed: async () => new Set(),
		readCheck: async () => NO_CHECK,
		readBasis: async () => 0,
		writeCheck: async () => assert.fail('nothing done, nothing recorded'),
		probe: async () => {
			const { compileProbeRules, extractValues, signatureOf } = await import('../src/util/changeProbeSpec.js');
			return signatureOf(extractValues(SOLD_OUT(), compileProbeRules([RULE])[0].extract));
		},
		expire: async () => assert.fail('a suppressed target is not re-filed here'),
		expireOnly: async () => assert.fail('nor expired'),
		readTarget: async (url) => ({ url, state: 'suppressed' }),
	});
	await consider(served());
	assert.deepEqual(outcomes(), ['queued', 'suppressed']);
});

test('a check switched off (or to dry run) while it waited is counted dropped, and asks nothing', async () => {
	await setup();
	let allow;
	const waiting = new Promise((resolve) => (allow = resolve));
	serveCheck.__setServeCheckDepsForTest({
		anchor: () => ANCHOR,
		readCheck: async () => NO_CHECK,
		readBasis: async () => 0,
		reserveSlot: () => Date.now() + 5,
		probe: async () => assert.fail('dropped checks ask nothing'),
	});
	serveCheck.considerServeCheck(served());
	for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
	config.changeProbe.serveCheck.dryRun = true;
	allow();
	await waiting;
	await new Promise((resolve) => setTimeout(resolve, 20));
	await serveCheck.serveChecksSettledForTest();
	assert.deepEqual(outcomes(), ['queued', 'dropped']);
});

test('a SLUG CHANGE is caught when a bot asks: the served canonical against the endpoint’s path now', async () => {
	const { setApi } = await setup();
	setApi(API({ seoUrl: '/product/prd-a/red-running-shoe.jsp' }));
	await consider(served());
	assert.equal(calls.expire.length, 1);
	assert.equal(calls.writeCheck[0].field, '1:canonical');
	assert.deepEqual(outcomes(), ['queued', 'mismatch']);
});

test('a field scoped away from a URL (pathPattern) cannot decide its check there', async () => {
	const { compileProbeRules, extractValues } = await import('../src/util/changeProbeSpec.js');
	const { documentFactsOf } = await import('../src/util/documentFacts.js');
	const scoped = {
		...RULE,
		pageCheck: {
			...RULE.pageCheck,
			fields: RULE.pageCheck.fields.map((field) =>
				field.fact === 'title' ? { ...field, pathPattern: '^/product/prd-(?!c)' } : field
			),
		},
	};
	const [rule] = compileProbeRules([scoped]);
	const facts = documentFactsOf(Buffer.from(SNAPSHOT())).facts;
	const placeholder = extractValues(API({ title: 'Shop' }), rule.extract);
	// On a collection URL the placeholder title is no claim; the canonical, image and offers still decide.
	const collectionUrl = 'https://shop.example.com/product/prd-c1/red-shoe.jsp';
	const collectionFacts = { ...facts, canonical: collectionUrl };
	const onCollection = serveCheck.compareWithEndpoint(
		rule,
		extractValues(API({ title: 'Shop', seoUrl: '/product/prd-c1/red-shoe.jsp' }), rule.extract),
		collectionFacts,
		{ pageUrl: collectionUrl }
	);
	assert.deepEqual(onCollection, { result: 'agree', canonicalAgreed: true });
	// On a regular URL the same disagreement decides.
	assert.equal(serveCheck.compareWithEndpoint(rule, placeholder, facts, { pageUrl: URL_A }).result, 'mismatch');
});
