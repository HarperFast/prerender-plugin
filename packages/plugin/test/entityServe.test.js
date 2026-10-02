import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync, gunzipSync } from 'node:zlib';

/**
 * The entity serve (util/entityServe.js): a true miss for one spelling of an entity is answered from the
 * cached render of the entity's canonical URL.
 *
 * What is pinned here:
 *   - it serves, end to end through `handleBotRequest`, the canonical's bytes and headers, as source and
 *     status `entity`, without asking the origin and without minting a target for the spelling;
 *   - EVERY guard falls through to the ordinary miss path, and is counted: the spelling has a target, no
 *     sibling in rotation, no page, a non-indexable / non-200 / stale / invalidated page, more than one
 *     candidate (or a read that cannot prove there is only one), a canonical not confirmed since the
 *     anchor, a page that does not name itself, an unreadable body, a URL with no entity prefix, an error;
 *   - confirmation is the CANONICAL's: a check counts only when it compared the canonical and agreed;
 *   - a dry run (the default) serves nothing and counts would-serve;
 *   - the read is one bounded, one-sided, node-local primary-key range;
 *   - a serve-time check of an entity serve checks the canonical, never the spelling.
 */

const analytics = [];
const targets = new Map(); // url -> { url, state }
const pages = new Map(); // cacheKey -> page row
const checks = new Map(); // url -> PageCheck row
const puts = [];
const searches = [];
let searchFault = null;
const sabs = new Map();
const visitRows = new Map();
const entityRows = new Map(); // the entity registry: prefix -> row

const origin = { server: null, port: 0, requests: [], body: '<html>origin</html>' };
let ORIGIN = '';
let CANON = '';
let VARIANT = '';

// A Harper-request-shaped header bag: case-insensitive `get` plus the `asObject` the proxy forwards.
class RequestHeaders {
	constructor(obj) {
		this.obj = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]));
	}
	get(name) {
		return this.obj[name.toLowerCase()] ?? null;
	}
	get asObject() {
		return this.obj;
	}
}

/** `Table.search` over a string primary key, as the entity read issues it. */
function* rangeOf(query) {
	const [condition] = query.conditions;
	const keys = [...targets.keys()].filter((k) => k >= condition.value).sort();
	let n = 0;
	for (const key of keys) {
		if (n++ >= query.limit) return;
		const row = targets.get(key);
		yield Object.fromEntries(query.select.map((field) => [field, row[field]]));
	}
}

let handleBotRequest;
let entityServe;
let serveCheck;
let config;
let applyOptions;
let ANCHOR;

before(async () => {
	origin.server = http.createServer((req, res) => {
		origin.requests.push({ method: req.method, url: req.url, headers: req.headers });
		res.writeHead(200, { 'content-type': 'text/html' });
		res.end(origin.body);
	});
	await new Promise((resolve) => origin.server.listen(0, '127.0.0.1', resolve));
	origin.port = origin.server.address().port;
	ORIGIN = `http://127.0.0.1:${origin.port}`;
	CANON = `${ORIGIN}/product/prd-1/right-slug.jsp`;
	VARIANT = `${ORIGIN}/product/prd-1/email.jsp`;

	globalThis.Resource = class {};
	globalThis.server = {
		hostname: 'test-node',
		nodes: [],
		config: { http: { port: 9926 } },
		recordAnalytics: (...args) => analytics.push(args),
		workerIndex: 1,
	};
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} };
	globalThis.createBlob = (bytes) => bytes;
	class TargetBase {
		static async get(query) {
			const id = typeof query === 'object' ? query.id : query;
			return targets.has(id) ? { ...targets.get(id) } : null;
		}
		static async put(id) {
			puts.push(id);
		}
		static search(query, context) {
			searches.push({ query, context });
			if (searchFault) throw searchFault;
			const rows = rangeOf(query);
			return {
				[Symbol.asyncIterator]() {
					return { next: async () => rows.next(), return: async () => ({ done: true }) };
				},
			};
		}
	}
	class PageBase {
		static async get(query) {
			const key = typeof query === 'object' ? query.id : query;
			const page = pages.get(key);
			return page ? { cacheKey: key, ...page } : null;
		}
	}
	globalThis.databases = {
		coordination: {
			SharedBuffer: {
				primaryStore: {
					getUserSharedBuffer(key, initial) {
						if (!sabs.has(key)) sabs.set(key, initial);
						return sabs.get(key);
					},
					tryLock: () => true,
					unlock() {},
				},
			},
		},
		render_service: {
			Target: TargetBase,
			QueueControl: class {},
			QueueStatus: class {},
			Entity: {
				get: async ({ id, select }) => {
					const row = entityRows.get(id);
					return row ? Object.fromEntries(select.map((field) => [field, row[field]])) : null;
				},
				patch: async (id, data) => entityRows.set(id, { ...(entityRows.get(id) ?? {}), ...data }),
			},
		},
		render_schedule: { RenderSchedule: class {} },
		page_cache: { PrerenderedPage: PageBase },
		probe_state: { ProbeState: class {}, RenderExpectation: class {} },
		invalidation: { Invalidation: { get: async () => null } },
		verification: {
			PageVerification: { get: async () => null },
			PageCheck: {
				get: async ({ id, select }) => {
					const row = checks.get(id);
					return row ? Object.fromEntries(select.map((field) => [field, row[field]])) : undefined;
				},
				put: async (id, row) => checks.set(id, row),
			},
		},
		raw_cache: { RawPage: { get: async () => null, put: async () => {} } },
		negative_cache: { NegativePage: { get: async () => null } },
		crawl_stats: {
			CrawlSketch: class {},
			// The demand tracker's ring rows (util/visitFilter.js), enough of the table to round-trip one slice.
			VisitFilter: {
				get: async (id) => (visitRows.has(id) ? { ...visitRows.get(id) } : null),
				put: async (id, data) => visitRows.set(id, { id, ...data }),
				delete: async (id) => visitRows.delete(id),
				search: async () => [...visitRows.values()].map((row) => ({ ...row })),
			},
		},
	};
	({ applyOptions, config } = await import('../src/config.js'));
	configure();
	({ handleBotRequest } = await import('../src/http_handlers/bot_request.js'));
	entityServe = await import('../src/util/entityServe.js');
	serveCheck = await import('../src/util/serveCheck.js');
});

after(() => {
	origin.server.closeAllConnections?.();
	origin.server.close();
});

const ROUTE = {
	match: 'prefix',
	path: '/product/prd-',
	queryParams: [],
	entityPrefix: '^/product/prd-[^/]+/',
	entityServe: true,
};
const configure = (over = {}) =>
	applyOptions({
		ingress: {
			mode: 'forwarded',
			deviceTypeSource: 'path',
			routes: [
				{ ...ROUTE, ...(over.route ?? {}) },
				{ match: 'prefix', path: '/p/', queryParams: [] },
			],
			entityServe: { dryRun: false, ...(over.entityServe ?? {}) },
		},
		analytics: { enabled: true },
		invalidation: { enabled: false },
		page: { snapshotValidators: true },
		...(over.rest ?? {}),
	});

const HOUR = 3_600_000;
const SNAPSHOT = (canonical) =>
	'<!doctype html><html><head><meta charset="utf-8"><title>Right Product</title>' +
	(canonical === null ? '' : `<link rel="canonical" href="${canonical}">`) +
	'</head><body><h1>Right Product</h1><svg><path fill="url(#star)"></path></svg></body></html>';

/** A cached page as `PrerenderedPage.get` returns it: stored head as a JSON string, blob-like content. */
const page = (over = {}) => {
	const html = SNAPSHOT(over.canonical === undefined ? CANON : over.canonical);
	return {
		statusCode: 200,
		headers: JSON.stringify({
			'content-type': 'text/html; charset=utf-8',
			'content-encoding': 'gzip',
			'etag': '"origin"',
		}),
		content: { bytes: async () => gzipSync(Buffer.from(html)) },
		lastCached: new Date(ANCHOR + HOUR), // rendered after the anchor: confirmed by the render itself
		expiresAt: new Date(Date.now() + 48 * HOUR),
		isIndexable: true,
		...over,
	};
};
const target = (url, state = null, suppressedReason = null, over = {}) =>
	targets.set(url, { url, state, suppressedReason, suppressedAt: null, suppressedCanonical: null, ...over });
const keyOf = (url, device = 'desktop') => `${url}|${device}`;
// The entity, as it stands on the measured origin: one canonical target in rotation with a fresh page,
// an old slug suppressed beside it, and nothing at all for the spelling a crawler asks for.
const entity = (pageOver = {}) => {
	target(CANON);
	target(`${ORIGIN}/product/prd-1/old-slug.jsp`, 'suppressed');
	pages.set(keyOf(CANON), page(pageOver));
};

let offered;
beforeEach(() => {
	analytics.length = 0;
	targets.clear();
	pages.clear();
	checks.clear();
	puts.length = 0;
	searches.length = 0;
	searchFault = null;
	origin.requests = [];
	origin.body = '<html>origin</html>';
	entityRows.clear();
	offered = [];
	ANCHOR = Date.now() - 6 * HOUR;
	configure();
	entityServe.__setEntityServeDepsForTest({
		anchor: () => ANCHOR,
		offerCheck: (candidate) => offered.push(candidate),
		comparesCanonical: () => true,
	});
});

const request = (url, method = 'GET', device = 'desktop') => ({
	method,
	url: `/${device}${new URL(url).pathname}`,
	headers: new RequestHeaders({
		'x-forwarded-host': `127.0.0.1:${origin.port}`,
		'x-forwarded-proto': 'http',
		'user-agent': 'Mozilla/5.0 (compatible; Bingbot/2.0; +http://www.bing.com/bingbot.htm)',
		'accept-encoding': 'gzip',
		'x-harper-prerender-debug': 'true',
	}),
});
const drain = async (body) => {
	if (!body) return Buffer.alloc(0);
	if (Buffer.isBuffer(body)) return body;
	if (typeof body.getReader === 'function') return Buffer.from(await new Response(body).arrayBuffer());
	const chunks = [];
	for await (const chunk of body) chunks.push(chunk);
	return Buffer.concat(chunks);
};
const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
// The entity serve's own range read (the discovery gate's, on the detached tail of a miss, reads 3).
const entityReads = () => searches.filter(({ query }) => query.limit === entityServe.ENTITY_READ_LIMIT).length;
const outcomes = () => analytics.filter((a) => a[1] === 'prerender_ops' && a[2] === 'entity_serve').map((a) => a[3]);
let matchRoute;
let inspectRoutes;
before(async () => {
	({ matchRoute, inspectRoutes } = await import('../src/util/routeClass.js'));
});
const compiledRoute = () => matchRoute('/product/prd-1/email.jsp');
const evaluate = (over = {}) =>
	entityServe.resolveEntityServe({
		cacheUrl: VARIANT,
		deviceType: 'desktop',
		route: compiledRoute(),
		botName: 'Bingbot',
		...over,
	});

// ── it serves ──────────────────────────────────────────────────────────────────────────────────────

test('a spelling with no page and no target is answered from the canonical’s render — not the origin', async () => {
	entity();
	const res = await handleBotRequest(request(VARIANT));
	const body = await drain(res.body);
	assert.equal(res.status, 200);
	assert.equal(gunzipSync(body).toString(), SNAPSHOT(CANON), 'the canonical’s bytes, as stored');
	assert.equal(res.headers.get('content-encoding'), 'gzip');
	assert.equal(res.headers.get('x-harper-cache'), 'entity');
	assert.equal(res.headers.get('x-harper-source'), 'entity');
	assert.equal(res.headers.get('x-harper-entity'), keyOf(CANON), 'the key whose render answered');
	assert.equal(res.headers.get('x-harper-cache-key'), keyOf(VARIANT), 'the key that was asked for');
	// A snapshot's validators are its own, never the origin document's.
	assert.match(res.headers.get('etag'), /^W\/"\d+-desktop"$/);
	assert.deepEqual(origin.requests, [], 'the origin was not asked');
	assert.deepEqual(outcomes(), ['served']);
	const serve = analytics.find((a) => a[1] === 'bot_serve');
	assert.deepEqual(serve.slice(2), ['entity', 'entity', 'Bingbot']);
	const routeServe = analytics.find((a) => a[1] === 'route_serve');
	assert.deepEqual(routeServe.slice(2), ['/product/prd-', 'entity', 'desktop']);
	assert.ok(
		analytics.some((a) => a[1] === 'page_age'),
		'an entity serve is a served snapshot: its age is recorded'
	);
	await settle();
	assert.deepEqual(puts, [], 'nothing minted for the spelling: it was served, not missed');
	assert.equal(analytics.filter((a) => a[1] === 'bot_miss').length, 0, 'not a miss: the origin was never asked');
});

test('a HEAD is answered the same way, with no body', async () => {
	entity();
	const res = await handleBotRequest(request(VARIANT, 'HEAD'));
	assert.equal(res.status, 200);
	assert.equal(res.headers.get('x-harper-cache'), 'entity');
	assert.equal((await drain(res.body)).length, 0);
	assert.deepEqual(origin.requests, []);
});

test('DRY RUN (the default): every guard is evaluated and counted would-serve, and the origin answers', async () => {
	entity();
	configure({ entityServe: { dryRun: true } });
	const res = await handleBotRequest(request(VARIANT));
	await drain(res.body);
	assert.equal(res.headers.get('x-harper-source'), 'origin');
	assert.equal(origin.requests.length, 1);
	assert.deepEqual(outcomes(), ['would-serve']);
	configure();
	assert.deepEqual(
		(() => {
			applyOptions({});
			return config.ingress.entityServe;
		})(),
		{ enabled: true, dryRun: true, maxConfirmAge: 0 },
		'defaults: on, DRY RUN, the anchor alone'
	);
});

// ── every guard falls through to the miss path, and is counted ─────────────────────────────────────

const fallsThrough = async (expected, { device = 'desktop', url = VARIANT } = {}) => {
	const res = await handleBotRequest(request(url, 'GET', device));
	const body = await drain(res.body);
	assert.equal(res.headers.get('x-harper-source'), 'origin', `${expected}: the miss path answered`);
	const text = res.headers.get('content-encoding') === 'gzip' ? gunzipSync(body).toString() : body.toString();
	assert.equal(text, '<html>origin</html>');
	assert.equal(origin.requests.length, 1);
	assert.deepEqual(outcomes(), [expected]);
};

test('has-target: a spelling with a target the render path keeps — in rotation, or suppressed about itself', async () => {
	for (const [state, reason] of [
		[null, null],
		['suppressed', 'noindex'],
		['suppressed', 'http-gone'],
		['suppressed', null],
	]) {
		entity();
		target(VARIANT, state, reason);
		await fallsThrough('has-target');
		analytics.length = 0;
		origin.requests = [];
	}
});

test('a spelling suppressed as a CANONICAL VERDICT is answered: its own render said the product lives elsewhere', async () => {
	for (const reason of ['canonical-mismatch', 'canonical-variant']) {
		targets.clear();
		entity(); // rendered at ANCHOR + 1h
		// Its verdict is older than the canonical's render: the render is the newer word, whatever it named.
		target(VARIANT, 'suppressed', reason, { suppressedAt: new Date(ANCHOR - HOUR) });
		analytics.length = 0;
		const res = await handleBotRequest(request(VARIANT));
		await drain(res.body);
		assert.equal(res.headers.get('x-harper-cache'), 'entity', reason);
		assert.equal(res.headers.get('x-harper-entity'), keyOf(CANON));
		assert.deepEqual(outcomes(), ['served']);
	}
	assert.deepEqual(origin.requests, [], 'the origin was not asked');
});

test('no-sibling: every other target of the entity is suppressed (or there is none)', async () => {
	target(`${ORIGIN}/product/prd-1/old-slug.jsp`, 'suppressed');
	await fallsThrough('no-sibling');
});

test('PREFIX COLLISION: product 12 is never a sibling of product 1', async () => {
	target(`${ORIGIN}/product/prd-12/other.jsp`);
	pages.set(keyOf(`${ORIGIN}/product/prd-12/other.jsp`), page({ canonical: `${ORIGIN}/product/prd-12/other.jsp` }));
	await fallsThrough('no-sibling');
});

test('no-page: the canonical is in rotation, but has no page for this device', async () => {
	entity();
	await fallsThrough('no-page', { device: 'mobile' });
});

test('not-indexable: a page that is not indexable, or not a 200', async () => {
	for (const over of [{ isIndexable: false }, { isIndexable: undefined }, { statusCode: 404 }]) {
		pages.clear();
		entity(over);
		await fallsThrough('not-indexable');
		analytics.length = 0;
		origin.requests = [];
	}
});

test('stale: past its own expiry — including inside SWR, where its own URL would still serve it', async () => {
	entity({ expiresAt: new Date(Date.now() - 60_000) });
	await fallsThrough('stale');
});

test('invalidated: a page an active invalidation covers is not carried to other spellings', async () => {
	entity();
	entityServe.__setEntityServeDepsForTest({
		anchor: () => ANCHOR,
		offerCheck: () => {},
		epochOf: async () => ({ at: Date.now() - 60_000, scope: 'all' }),
	});
	await fallsThrough('invalidated');
});

test('the most informative refusal wins when several targets are in rotation and none can serve', async () => {
	entity({ expiresAt: new Date(Date.now() - 60_000) });
	target(`${ORIGIN}/product/prd-1/zz-other.jsp`); // in rotation, no page
	const { outcome } = await evaluate();
	assert.equal(outcome, 'stale');
});

test('ambiguous: two servable pages, more rows than the read covers, or an unreadable row — never a guess', async () => {
	entity();
	const twin = `${ORIGIN}/product/prd-1/twin.jsp`;
	target(twin);
	pages.set(keyOf(twin), page({ canonical: twin }));
	assert.equal((await evaluate()).outcome, 'ambiguous');

	targets.clear();
	entity();
	for (let i = 0; i < entityServe.ENTITY_READ_LIMIT; i++) target(`${ORIGIN}/product/prd-1/dead-${i}.jsp`, 'suppressed');
	assert.equal((await evaluate()).outcome, 'ambiguous', 'the read cannot prove there is no second candidate');

	targets.clear();
	entity();
	targets.set(`${ORIGIN}/product/prd-1/bad.jsp`, { url: null, state: null });
	assert.equal((await evaluate()).outcome, 'ambiguous', 'an unreadable row could be this spelling’s own');
});

test('the read is one bounded, one-sided, node-local PK range with the minimal projection', async () => {
	entity();
	await evaluate();
	assert.equal(searches.length, 1);
	const [{ query, context }] = searches;
	assert.deepEqual(query.conditions, [
		{ attribute: 'url', comparator: 'greater_than_equal', value: `${ORIGIN}/product/prd-1/` },
	]);
	assert.equal(query.limit, entityServe.ENTITY_READ_LIMIT);
	assert.deepEqual(query.select, ['url', 'state', 'suppressedReason', 'suppressedAt', 'suppressedCanonical']);
	assert.deepEqual(context, { replicateFrom: false });
});

test('no-prefix: a URL the pattern does not match falls through, and reads nothing', async () => {
	await fallsThrough('no-prefix', { url: `${ORIGIN}/product/prd-1` });
	assert.equal(entityReads(), 0);
});

test('error: a read that throws falls through to the origin — never a failed request', async () => {
	entity();
	searchFault = new Error('read fault');
	await fallsThrough('error');
});

test('unreadable: a body that cannot be read falls through, and is counted as the blob fault it is', async () => {
	entity({
		content: {
			bytes: async () => {
				throw new Error('ENOENT');
			},
		},
	});
	await fallsThrough('unreadable');
	assert.ok(analytics.some((a) => a[1] === 'prerender_ops' && a[2] === 'serve_error' && a[3] === 'blob-unreadable'));
});

test('not-self-canonical: the page names another URL, no URL, or one that cannot be read exactly', async () => {
	for (const canonical of [VARIANT, `${ORIGIN}/product/prd-1/elsewhere.jsp`, null, '/product/prd-1/right-slug.jsp']) {
		pages.clear();
		entity({ canonical });
		await fallsThrough('not-self-canonical');
		analytics.length = 0;
		origin.requests = [];
	}
});

// ── confirmation is the canonical's, since the anchor ─────────────────────────────────────────────

const check = (over = {}) =>
	checks.set(CANON, {
		url: CANON,
		checkedAt: new Date(ANCHOR + 30 * 60_000),
		basisAt: new Date(ANCHOR - 2 * HOUR),
		outcome: 'agree',
		canonicalAgreed: true,
		...over,
	});

test('unconfirmed: rendered before the anchor and never checked since', async () => {
	entity({ lastCached: new Date(ANCHOR - 2 * HOUR) });
	await fallsThrough('unconfirmed');
});

test('a check since the anchor that compared the canonical and agreed confirms a page rendered before it', async () => {
	entity({ lastCached: new Date(ANCHOR - 2 * HOUR) });
	check();
	assert.equal((await evaluate()).outcome, 'served');
	// A 'held' disagreement on some other field still compared the canonical and agreed.
	check({ outcome: 'held', field: 'title' });
	assert.equal((await evaluate()).outcome, 'served');
});

test('what does NOT confirm: an agreement that never compared the canonical, an old check, a mismatch, a newer render', async () => {
	entity({ lastCached: new Date(ANCHOR - 2 * HOUR) });
	const cases = [
		[{ canonicalAgreed: false }, 'an agree that says nothing about the canonical (disarmed, or not mapped)'],
		[{ canonicalAgreed: undefined }, 'a row written before canonicalAgreed existed'],
		[{ checkedAt: new Date(ANCHOR - 60_000) }, 'checked before the anchor'],
		[{ outcome: 'mismatch', field: 'offers' }, 'a mismatch: the page is being expired'],
		[{ basisAt: new Date(ANCHOR - HOUR) }, 'the check covered a NEWER render than this one'],
	];
	for (const [over, why] of cases) {
		check(over);
		assert.equal((await evaluate()).outcome, 'unconfirmed', why);
	}
});

test('an unconfirmed canonical is OFFERED to the serve-time check — and only when a check could confirm it', async () => {
	entity({ lastCached: new Date(ANCHOR - 2 * HOUR) });
	await evaluate();
	assert.equal(offered.length, 1);
	const [offer] = offered;
	assert.equal(offer.url, CANON);
	assert.equal(offer.cacheKey, keyOf(CANON));
	assert.equal(offer.threshold, ANCHOR, 'the entity serve’s own threshold rides along');
	assert.equal(offer.deviceType, 'desktop');
	assert.equal(offer.botName, 'Bingbot');
	assert.equal(offer.route, compiledRoute());
	offered = [];
	entityServe.__setEntityServeDepsForTest({
		anchor: () => ANCHOR,
		offerCheck: (candidate) => offered.push(candidate),
		comparesCanonical: () => false,
	});
	assert.equal((await evaluate()).outcome, 'unconfirmed');
	assert.deepEqual(offered, [], 'a check that does not compare the canonical can never confirm it');
});

test('outside anchored mode nothing is confirmed unless maxConfirmAge says how recent is recent enough', async () => {
	entity({ lastCached: new Date(Date.now() - HOUR) });
	entityServe.__setEntityServeDepsForTest({ anchor: () => NaN, offerCheck: (c) => offered.push(c) });
	assert.equal((await evaluate()).outcome, 'unconfirmed');
	assert.deepEqual(offered, [], 'no threshold: no check could confirm it either');
	assert.equal((await evaluate({ settings: { dryRun: false, maxConfirmAge: 2 * HOUR } })).outcome, 'served');
	assert.equal((await evaluate({ settings: { dryRun: false, maxConfirmAge: HOUR / 2 } })).outcome, 'unconfirmed');
	// Beside an anchor, maxConfirmAge only ever TIGHTENS it.
	entityServe.__setEntityServeDepsForTest({ anchor: () => ANCHOR, offerCheck: () => {} });
	assert.equal(
		entityServe.confirmThreshold(Date.now(), 0, () => ANCHOR),
		ANCHOR
	);
	const tight = entityServe.confirmThreshold(Date.now(), HOUR, () => ANCHOR);
	assert.ok(tight > ANCHOR);
});

// ── the serve-time check sees the canonical, never the spelling ────────────────────────────────────

test('a serve-time check of an entity serve looks up the CANONICAL’s check, with the canonical’s bytes', async () => {
	const looked = [];
	configure({
		route: { documentCheck: ['canonical'] },
		rest: { changeProbe: { enabled: true, serveCheck: { enabled: true, dryRun: true } } },
	});
	serveCheck.resetServeChecks();
	serveCheck.__setServeCheckDepsForTest({
		anchor: () => ANCHOR,
		readCheck: async (url) => {
			looked.push(url);
			return { checkedAtMs: NaN, basisAtMs: NaN, outcome: null, canonicalAgreed: false };
		},
		recordBreadth: () => {},
	});
	try {
		// Rendered before the anchor, so the serve-time check is due; confirmed for the entity serve by a check.
		entity({ lastCached: new Date(ANCHOR - 2 * HOUR) });
		check();
		const res = await handleBotRequest(request(VARIANT));
		await drain(res.body);
		assert.equal(res.headers.get('x-harper-cache'), 'entity');
		await serveCheck.serveChecksSettledForTest();
		assert.deepEqual(looked, [CANON], 'the canonical’s check — the spelling has no page to check');
		assert.ok(
			analytics.some((a) => a[1] === 'prerender_ops' && a[2] === 'serve_check' && a[3] === 'would-check'),
			'and the check went ahead for it'
		);
	} finally {
		serveCheck.__setServeCheckDepsForTest();
		serveCheck.resetServeChecks();
		configure();
	}
});

// ── the route field ───────────────────────────────────────────────────────────────────────────────

test('entityServe compiles like every optional route field: a bad value drops the FIELD with a warning', () => {
	const compiled = (route) => {
		configure({ route });
		return { entry: compiledRoute(), warnings: inspectRoutes([{ ...ROUTE, ...route }], []).warnings };
	};
	try {
		assert.equal(compiled({}).entry.entityServe, true);
		assert.deepEqual(compiled({}).warnings, []);
		assert.equal(compiled({ entityServe: undefined }).entry.entityServe, false, 'absent is off');
		const noPrefix = compiled({ entityPrefix: undefined });
		assert.equal(noPrefix.entry.entityServe, false, 'no entity, nothing to serve from: compiled OFF');
		assert.match(noPrefix.warnings.join('\n'), /does nothing: the route has no usable entityPrefix/);
		const notBoolean = compiled({ entityServe: 'yes' });
		assert.equal(notBoolean.entry.entityServe, false);
		assert.match(notBoolean.warnings.join('\n'), /expected a boolean/);
		const passthrough = inspectRoutes([{ match: 'prefix', path: '/x/', mode: 'passthrough', entityServe: true }], []);
		assert.match(passthrough.warnings.join('\n'), /ignoring entityServe on passthrough route/);
	} finally {
		configure();
	}
});

test('the master switch off: no read, nothing counted, the miss path as before', async () => {
	entity();
	configure({ entityServe: { enabled: false } });
	const res = await handleBotRequest(request(VARIANT));
	await drain(res.body);
	assert.equal(res.headers.get('x-harper-source'), 'origin');
	assert.deepEqual(outcomes(), []);
	assert.equal(entityReads(), 0);
});

test('a route that does not opt in is untouched: no read, nothing counted', async () => {
	entity();
	configure({ route: { entityServe: false } });
	const res = await handleBotRequest(request(VARIANT));
	await drain(res.body);
	assert.equal(res.headers.get('x-harper-source'), 'origin');
	assert.deepEqual(outcomes(), []);
	assert.equal(entityReads(), 0);
});

// ── the sweep records its confirmations where the entity serve reads them ─────────────────────────

test('the sweep records checks for entity-serve routes even with serve-time checks off — and only for them', async () => {
	const { pageCheckRecorder } = await import('../src/util/changeProbe.js');
	const { writePageCheck } = await import('../src/util/pageCheck.js');
	try {
		configure({ rest: { changeProbe: { serveCheck: { enabled: true } } } });
		assert.equal(pageCheckRecorder(), writePageCheck, 'serve-time checks read every row: record them all');

		configure({ rest: { changeProbe: { serveCheck: { enabled: false } } } });
		const record = pageCheckRecorder();
		await record(CANON, ANCHOR, { canonicalAgreed: true });
		await record(`${ORIGIN}/p/listing`, ANCHOR, { canonicalAgreed: true });
		assert.deepEqual([...checks.keys()], [CANON], 'a row nothing reads is a replicated write that buys nothing');
		assert.equal(checks.get(CANON).canonicalAgreed, true);

		configure({ entityServe: { enabled: false }, rest: { changeProbe: { serveCheck: { enabled: false } } } });
		assert.equal(pageCheckRecorder(), null, 'nothing reads them at all: the pre-feature pass');
	} finally {
		configure();
	}
});

// ── review round: the offer, the canonical's serve-time check, validators, demand ──────────────────

/** Arm the serve-time check on a route whose `documentCheck` compares the canonical (or not). */
const armServeChecks = ({ documentCheck = ['canonical'], fetched = [], writes = [], bases = [] } = {}) => {
	configure({
		route: { documentCheck },
		rest: { changeProbe: { enabled: true, dryRun: false, serveCheck: { enabled: true, dryRun: false } } },
	});
	serveCheck.resetServeChecks();
	serveCheck.__setServeCheckDepsForTest({
		anchor: () => ANCHOR,
		reserveSlot: () => Date.now(),
		healthy: () => {},
		pushback: () => {},
		recordBreadth: () => {},
		readBasis: async (kind, key) => {
			bases.push(key);
			return dateMs(pages.get(key)?.lastCached);
		},
		// The origin's document now: the same canonical the page declares.
		fetchDocument: async (url, deviceType) => {
			fetched.push({ url, deviceType });
			return {
				statusCode: 200,
				headers: { 'content-type': 'text/html; charset=utf-8' },
				body: Readable.from([Buffer.from(SNAPSHOT(CANON))]),
			};
		},
		writeCheck: async (url, basisAtMs, details) => {
			writes.push({ url, basisAtMs, ...details });
			await writePageCheck(url, basisAtMs, details);
		},
	});
	// The REAL offer and the real "does a check compare the canonical" — nothing stubbed.
	entityServe.__setEntityServeDepsForTest({ anchor: () => ANCHOR });
};
const disarmServeChecks = () => {
	serveCheck.__setServeCheckDepsForTest();
	serveCheck.resetServeChecks();
	configure();
};
const dateMs = (value) => (value ? new Date(value).getTime() : NaN);
let Readable;
let writePageCheck;
before(async () => {
	({ Readable } = await import('node:stream'));
	({ writePageCheck } = await import('../src/util/pageCheck.js'));
});

test('the request that finds a canonical unconfirmed is what gets it confirmed — and the next one is served', async () => {
	const fetched = [];
	const writes = [];
	armServeChecks({ fetched, writes });
	try {
		entity({ lastCached: new Date(ANCHOR - 2 * HOUR) });
		assert.equal((await evaluate()).outcome, 'unconfirmed');
		await serveCheck.serveChecksSettledForTest();
		assert.deepEqual(fetched, [{ url: CANON, deviceType: 'desktop' }], 'the CANONICAL was checked, for this device');
		assert.equal(writes.length, 1);
		assert.equal(writes[0].url, CANON);
		assert.equal(writes[0].outcome, 'agree');
		assert.equal(writes[0].canonicalAgreed, true);
		analytics.length = 0;
		assert.equal((await evaluate()).outcome, 'served', 'confirmed by that check');
	} finally {
		disarmServeChecks();
	}
});

test('no offer when no check compares the canonical — and an offer the check turns away reads no blob', async () => {
	const fetched = [];
	armServeChecks({ documentCheck: ['title'], fetched });
	try {
		let reads = 0;
		entity({
			lastCached: new Date(ANCHOR - 2 * HOUR),
			content: {
				bytes: async () => {
					reads++;
					return gzipSync(Buffer.from(SNAPSHOT(CANON)));
				},
			},
		});
		assert.equal((await evaluate()).outcome, 'unconfirmed');
		await serveCheck.serveChecksSettledForTest();
		assert.deepEqual(fetched, [], 'a check of the title alone can never confirm the canonical');
		assert.equal(reads, 0);

		// A check the serve-time check finds covered (it ran, compared no canonical) is turned away BEFORE the
		// loader runs: no blob read for it.
		armServeChecks({ fetched });
		checks.set(CANON, {
			url: CANON,
			checkedAt: new Date(ANCHOR + 60_000),
			basisAt: new Date(ANCHOR - 2 * HOUR),
			outcome: 'inconclusive',
			canonicalAgreed: false,
		});
		assert.equal((await evaluate()).outcome, 'unconfirmed');
		await serveCheck.serveChecksSettledForTest();
		assert.deepEqual(fetched, [], 'one ask per window: the same check would find the same nothing');
		assert.equal(reads, 0, 'turned away by the check’s cheap gates, so the body was never read');
	} finally {
		disarmServeChecks();
	}
});

test('a check older than maxConfirmAge is not taken as covering the offer: the entity’s threshold rides along', async () => {
	const fetched = [];
	armServeChecks({ fetched });
	try {
		configure({
			route: { documentCheck: ['canonical'] },
			entityServe: { maxConfirmAge: HOUR },
			rest: { changeProbe: { enabled: true, dryRun: false, serveCheck: { enabled: true, dryRun: false } } },
		});
		entityServe.__setEntityServeDepsForTest({ anchor: () => ANCHOR });
		entity({ lastCached: new Date(ANCHOR - 2 * HOUR) });
		// Agreed on the canonical after the anchor, but more than an hour ago.
		checks.set(CANON, {
			url: CANON,
			checkedAt: new Date(Date.now() - 2 * HOUR),
			basisAt: new Date(ANCHOR - 2 * HOUR),
			outcome: 'agree',
			canonicalAgreed: true,
		});
		assert.equal((await evaluate({ settings: config.ingress.entityServe })).outcome, 'unconfirmed');
		await serveCheck.serveChecksSettledForTest();
		assert.deepEqual(fetched, [{ url: CANON, deviceType: 'desktop' }], 'asked again, for the entity serve’s window');
	} finally {
		disarmServeChecks();
	}
});

test('an ARMED serve-time check of an entity serve compares the canonical’s own row and key', async () => {
	const fetched = [];
	const writes = [];
	const bases = [];
	armServeChecks({ fetched, writes, bases });
	try {
		// Confirmed for the entity serve by a check after the anchor, while the serve-time check's own window
		// (`maxAge` one minute, every URL sampled) is later than that check: so it is due for the canonical.
		entity({ lastCached: new Date(ANCHOR - 2 * HOUR) });
		checks.set(CANON, {
			url: CANON,
			checkedAt: new Date(ANCHOR + 60_000),
			basisAt: new Date(ANCHOR - 2 * HOUR),
			outcome: 'agree',
			canonicalAgreed: true,
		});
		configure({
			route: { documentCheck: ['canonical'] },
			rest: {
				changeProbe: {
					enabled: true,
					dryRun: false,
					serveCheck: { enabled: true, dryRun: false, maxAge: 60_000, sample: 1 },
				},
			},
		});
		const res = await handleBotRequest(request(VARIANT));
		await drain(res.body);
		assert.equal(res.headers.get('x-harper-cache'), 'entity');
		await serveCheck.serveChecksSettledForTest();
		assert.deepEqual(bases, [keyOf(CANON)], 'the served copy is the CANONICAL’s row — the spelling has none');
		assert.deepEqual(fetched, [{ url: CANON, deviceType: 'desktop' }]);
		assert.equal(writes.at(-1).url, CANON);
		assert.equal(writes.at(-1).outcome, 'agree', 'compared, not dropped as superseded');
	} finally {
		disarmServeChecks();
	}
});

test('an entity serve answers a conditional request against its own validators', async () => {
	entity();
	const first = await handleBotRequest(request(VARIANT));
	await drain(first.body);
	const etag = first.headers.get('etag');
	const conditional = request(VARIANT);
	conditional.headers.obj['if-none-match'] = etag;
	const res = await handleBotRequest(conditional);
	assert.equal(res.status, 304);
	assert.equal(res.headers.get('x-harper-cache'), 'entity');
	assert.deepEqual(origin.requests, []);
});

test('a FALL-THROUGH on an entity route does not let a validator this plugin handed out decide a 304', async () => {
	// An earlier entity serve gave the crawler the snapshot's render time; now the canonical is stale.
	entity({ expiresAt: new Date(Date.now() - 60_000) });
	const conditional = request(VARIANT);
	conditional.headers.obj['if-modified-since'] = new Date(Date.now() + HOUR).toUTCString();
	conditional.headers.obj['if-none-match'] = 'W/"1-desktop"';
	const res = await handleBotRequest(conditional);
	await drain(res.body);
	assert.equal(res.status, 200, 'the origin’s document, not a 304 off our own old validator');
	assert.equal(origin.requests.length, 1);
	assert.equal(origin.requests[0].headers['if-modified-since'], undefined, 'not forwarded to the origin');
	assert.equal(origin.requests[0].headers['if-none-match'], undefined);
	// With snapshot validators off, nothing this plugin served carries one: ordinary handling.
	configure({ rest: { page: { snapshotValidators: false } } });
	origin.requests = [];
	const plain = request(VARIANT);
	plain.headers.obj['if-modified-since'] = new Date(Date.now() + HOUR).toUTCString();
	const res2 = await handleBotRequest(plain);
	await drain(res2.body);
	assert.ok(origin.requests[0].headers['if-modified-since'], 'forwarded as before');
});

test('an entity serve is demand for the CANONICAL — the URL that owns the target — never the spelling', async () => {
	const { flushSlices, refreshMerged, visitedWithin, resetVisitFilter } = await import('../src/util/visitFilter.js');
	const { resetHeldSabs } = await import('../src/util/coordination.js');
	configure({
		rest: { demand: { enabled: true, sliceMs: HOUR, slices: 16, bitsPerSlice: 1 << 20, hashes: 7, bots: ['*'] } },
	});
	resetVisitFilter();
	try {
		entity();
		const res = await handleBotRequest(request(VARIANT));
		await drain(res.body);
		assert.equal(res.headers.get('x-harper-cache'), 'entity');
		await flushSlices();
		await refreshMerged();
		assert.equal(visitedWithin(CANON, 2 * HOUR), true);
		assert.equal(visitedWithin(VARIANT, 2 * HOUR), false);
	} finally {
		resetVisitFilter();
		visitRows.clear();
		sabs.clear();
		resetHeldSabs();
		configure();
	}
});

// ── the entity registry: the newest word from the origin ────────────────────────────────────────────

const NEW_SLUG = () => `${ORIGIN}/product/prd-1/new-slug.jsp`;
const PREFIX = () => `${ORIGIN}/product/prd-1/`;
const registryRow = (canonical, canonicalAt, from = 'probe') => ({
	id: PREFIX(),
	canonical,
	canonicalFrom: from,
	canonicalAt: canonicalAt instanceof Date ? canonicalAt : new Date(canonicalAt),
});
const withRegistry = (row) => {
	const read = [];
	entityServe.__setEntityServeDepsForTest({
		anchor: () => ANCHOR,
		offerCheck: (candidate) => offered.push(candidate),
		comparesCanonical: () => true,
		registryOn: () => true,
		readEntity: async (key) => {
			read.push(key);
			return typeof row === 'function' ? row() : row;
		},
	});
	return read;
};

test('MOVED: the origin named another canonical after the page was rendered — a re-slug it predates', async () => {
	entity(); // rendered at ANCHOR + 1h
	const read = withRegistry(registryRow(NEW_SLUG(), ANCHOR + 2 * HOUR, 'check'));
	assert.equal((await evaluate()).outcome, 'moved');
	assert.deepEqual(read, [PREFIX()], 'one point read, by the entity prefix');
	// Named BEFORE the render: the render read the origin later, and its page names itself — it stands.
	withRegistry(registryRow(NEW_SLUG(), ANCHOR + 30 * 60_000));
	assert.equal((await evaluate()).outcome, 'served');
	// The registry naming the page itself, in any spelling, is no veto.
	withRegistry(registryRow(CANON, Date.now()));
	assert.equal((await evaluate()).outcome, 'served');
	withRegistry(registryRow(CANON.replace('right-slug', 'right%2Dslug'), Date.now()));
	assert.equal((await evaluate()).outcome, 'served', 'decodeURI-equal: one document');
	// An unreadable instant cannot say which came first: it vetoes.
	withRegistry({ id: PREFIX(), canonical: NEW_SLUG(), canonicalAt: 'not a date' });
	assert.equal((await evaluate()).outcome, 'moved');
	// No row, or a row with no canonical: nothing to say.
	withRegistry(null);
	assert.equal((await evaluate()).outcome, 'served');
	withRegistry({ id: PREFIX() });
	assert.equal((await evaluate()).outcome, 'served');
});

test('MOVED against a CHECK-confirmed page: the later of the render and the check is when it was last confirmed', async () => {
	entity({ lastCached: new Date(ANCHOR - 2 * HOUR) });
	check(); // checked at ANCHOR + 30m, canonical agreed
	withRegistry(registryRow(NEW_SLUG(), ANCHOR + 10 * 60_000));
	assert.equal((await evaluate()).outcome, 'served', 'the check is newer than the registry’s word');
	withRegistry(registryRow(NEW_SLUG(), ANCHOR + 40 * 60_000));
	assert.equal((await evaluate()).outcome, 'moved', 'the registry heard the re-slug after the check');
});

test('a TIE between two servable spellings goes to the one the registry names — and with no word, ambiguous', async () => {
	entity();
	const next = NEW_SLUG();
	target(next);
	pages.set(keyOf(next), page({ canonical: next }));
	assert.equal((await evaluate()).outcome, 'ambiguous', 'the registry off: never a guess');
	withRegistry(registryRow(next, ANCHOR));
	const picked = await evaluate();
	assert.equal(picked.outcome, 'served');
	assert.equal(picked.serve.url, next);
	withRegistry(registryRow(`${ORIGIN}/product/prd-1/third.jsp`, ANCHOR));
	assert.equal((await evaluate()).outcome, 'ambiguous', 'it names neither');
});

test('the registry is read only when it is on, and only once there is a page to serve', async () => {
	entity();
	let reads = 0;
	entityServe.__setEntityServeDepsForTest({
		anchor: () => ANCHOR,
		offerCheck: () => {},
		comparesCanonical: () => true,
		registryOn: () => false,
		readEntity: async () => {
			reads++;
			return registryRow(NEW_SLUG(), Date.now());
		},
	});
	assert.equal((await evaluate()).outcome, 'served', 'registry off: no veto');
	assert.equal(reads, 0);
	const read = withRegistry(registryRow(NEW_SLUG(), Date.now()));
	pages.clear();
	assert.equal((await evaluate()).outcome, 'no-page');
	assert.deepEqual(read, [], 'nothing to serve, nothing to ask');
});

test('has-query: a spelling with a query string falls through, before any read', async () => {
	entity();
	assert.equal((await evaluate({ cacheUrl: `${VARIANT}?color=red` })).outcome, 'has-query');
	assert.equal(entityReads(), 0);
});

test('every evaluation records how long it took, whatever it decided', async () => {
	entity();
	await evaluate();
	await evaluate({ cacheUrl: `${ORIGIN}/elsewhere` });
	const timings = analytics.filter((a) => a[1] === 'prerender_ops' && a[2] === 'entity_serve_ms');
	assert.equal(timings.length, 2);
	for (const [value] of timings) assert.ok(Number.isFinite(value) && value >= 0);
});

// ── every fetch from the origin resolves the canonical ──────────────────────────────────────────────

test('a miss that reaches the origin teaches the registry the canonical its document declares — and adopts it', async () => {
	configure({ rest: { entities: { enabled: true, adopt: { dryRun: false } } } });
	entityServe.__setEntityServeDepsForTest({
		anchor: () => ANCHOR,
		offerCheck: () => {},
		comparesCanonical: () => true,
	});
	const next = NEW_SLUG();
	// The probe recorded the product last night, at its old slug: a crawler's miss moves a row, never creates one.
	entityRows.set(PREFIX(), registryRow(`${ORIGIN}/product/prd-1/old-slug.jsp`, ANCHOR, 'probe'));
	// No sibling in rotation: the spelling falls through to the origin, whose document names the new slug.
	target(`${ORIGIN}/product/prd-1/old-slug.jsp`, 'suppressed', 'canonical-mismatch');
	origin.body = `<!doctype html><html><head><link rel="canonical" href="${next}"><title>t</title></head><body>${'x'.repeat(4096)}</body></html>`;
	const res = await handleBotRequest(request(VARIANT));
	const body = await drain(res.body);
	assert.equal(res.headers.get('x-harper-source'), 'origin');
	const text = res.headers.get('content-encoding') === 'gzip' ? gunzipSync(body).toString() : body.toString();
	assert.equal(text, origin.body, 'the crawler gets every byte the origin sent');
	await settle(100);
	const row = entityRows.get(PREFIX());
	assert.equal(row?.canonical, next);
	assert.equal(row?.canonicalFrom, 'origin');
	assert.ok(puts.includes(next), 'the canonical no target held was filed');
	const adopt = analytics.find((a) => a[1] === 'prerender_ops' && a[2] === 'canonical_adopt');
	assert.deepEqual(adopt.slice(3), ['adopted', 'origin']);
});

test('no tap with the registry off, on a route that does not opt in, or for a HEAD', async () => {
	origin.body = `<html><head><link rel="canonical" href="${NEW_SLUG()}"></head></html>`;
	target(`${ORIGIN}/product/prd-1/old-slug.jsp`, 'suppressed', 'canonical-mismatch');
	await drain((await handleBotRequest(request(VARIANT))).body);
	configure({ rest: { entities: { enabled: true } }, route: { entityServe: false } });
	await drain((await handleBotRequest(request(VARIANT))).body);
	configure({ rest: { entities: { enabled: true } } });
	await drain((await handleBotRequest(request(VARIANT, 'HEAD'))).body);
	await settle(100);
	assert.equal(entityRows.size, 0);
});

// ── review of 0.102.0 ────────────────────────────────────────────────────────────────────────────────

test('a suppressed spelling whose verdict is NEWER than the candidate’s confirmation is answered only with the page it named', async () => {
	const disowned = new Date(ANCHOR + 2 * HOUR); // after the candidate's render at ANCHOR + 1h
	const cases = [
		[{ suppressedAt: disowned }, 'moved', 'a verdict that predates the field: no telling what it named'],
		[{ suppressedAt: disowned, suppressedCanonical: CANON }, 'served', 'it named this very page'],
		[{ suppressedAt: disowned, suppressedCanonical: NEW_SLUG() }, 'moved', 'it named another canonical'],
		[{ suppressedAt: 'not a date', suppressedCanonical: CANON }, 'served', 'named it: the instant does not matter'],
		[{ suppressedAt: 'not a date' }, 'moved', 'an unreadable instant, and nothing named'],
		[{ suppressedAt: new Date(ANCHOR) }, 'served', 'older than the render: the render is the newer word'],
	];
	for (const [over, expected, why] of cases) {
		targets.clear();
		entity();
		target(VARIANT, 'suppressed', 'canonical-mismatch', over);
		assert.equal((await evaluate()).outcome, expected, why);
	}
});

test('the registry veto allows for the gap between a candidate’s origin read and its store', async () => {
	entity(); // stored at ANCHOR + 1h, read up to CONFIRMATION_READ_SLACK_MS before that
	withRegistry(registryRow(NEW_SLUG(), ANCHOR + HOUR - 30_000));
	assert.equal((await evaluate()).outcome, 'moved', 'seen 30s before the store: the render may have read before it');
	withRegistry(registryRow(NEW_SLUG(), ANCHOR + HOUR - entityServe.CONFIRMATION_READ_SLACK_MS - 1000));
	assert.equal((await evaluate()).outcome, 'served', 'well before the render: the render is the newer word');
});
