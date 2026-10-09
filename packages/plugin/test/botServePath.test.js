import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkHarperKey } from './support/harperKeyLimit.js';

/**
 * The bot serve path end to end: `handleBotRequest` against a real origin over a real socket, and a real
 * peer for the rescue hop. Each test pins a defect the 2026-09-29 review found by driving the handler the
 * way a crawler does, because every one of them was invisible to the unit tests around it:
 *
 *   - A PROXIED REDIRECT WITH NO TARGET. The response-header allowlist had no `location`, so an origin 301
 *     reached the crawler naming nowhere to go.
 *   - HEAD MISSES THAT PINNED SOCKETS. A HEAD went upstream as a GET and the body nobody would read held
 *     its origin connection open until undici's body timeout; a local 304 made from an origin 200 did the
 *     same.
 *   - A RESCUE THAT IGNORED THE OWNER'S EXPIRY. The owner's copy was served as a 200 on the strength of the
 *     LOCAL replica's metadata — even when the owner's own record said the page was already hard-expired.
 *   - CONDITIONALS ANSWERED WITH THE ORIGIN DOCUMENT'S VALIDATORS. A re-render that changed the snapshot
 *     under an unchanged origin ETag answered 304, and the crawler kept the old snapshot.
 */

let handleBotRequest;
let config;
let getResidencyByUrl;
let pageGet = async () => null;
const rawPuts = [];
const negativeRows = new Map();
// Every key a URL-keyed table was asked for. Each fake below also applies Harper's key check, so a key
// past the limit throws exactly where the real table would.
const tableKeys = [];
const keyed = (table, key) => {
	tableKeys.push(`${table}:${key}`);
	checkHarperKey(key);
};

// `inFlight`: origin responses not yet finished or torn down. A body nobody reads and nobody releases
// keeps its response here until undici's body timeout — that, not an idle pooled socket, is a leak.
const origin = { requests: [], server: null, port: 0, sockets: new Set(), connections: 0, inFlight: 0, respond: null };
const peer = { server: null, requests: 0, respond: null };

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

const defaultOrigin = (req, res) => {
	if (req.url.includes('big')) {
		res.writeHead(200, { 'content-type': 'text/html', 'etag': '"origin-v1"' });
		res.end('x'.repeat(4 * 1024 * 1024));
		return;
	}
	res.writeHead(200, { 'content-type': 'text/html' });
	res.end('<html>origin</html>');
};

before(async () => {
	origin.server = http.createServer((req, res) => {
		origin.requests.push({ method: req.method, url: req.url, headers: req.headers });
		origin.inFlight++;
		res.on('close', () => origin.inFlight--);
		(origin.respond ?? defaultOrigin)(req, res);
	});
	origin.server.on('connection', (socket) => {
		origin.connections++;
		origin.sockets.add(socket);
		socket.on('close', () => origin.sockets.delete(socket));
	});
	await new Promise((resolve) => origin.server.listen(0, '127.0.0.1', resolve));
	origin.port = origin.server.address().port;

	peer.server = http.createServer((req, res) => {
		peer.requests++;
		peer.respond(req, res);
	});
	await new Promise((resolve) => peer.server.listen(0, '127.0.0.1', resolve));

	globalThis.Resource = class {};
	// `127.0.0.1` is the one peer: peerOrigin speaks plain http to a localhost name, so the rescue makes a
	// real HTTP hop to `peer.server`, whose port is the cluster's http port.
	globalThis.server = {
		hostname: 'test-node',
		nodes: [{ name: '127.0.0.1' }],
		config: { http: { port: peer.server.address().port } },
		recordAnalytics: () => {},
		workerIndex: 1,
	};
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} };
	globalThis.createBlob = (bytes) => bytes;
	class TargetBase {
		static async get(query) {
			keyed('Target', typeof query === 'object' ? query.id : query);
			return null;
		}
		static async put(key) {
			keyed('Target', key);
		}
	}
	globalThis.databases = {
		coordination: {
			SharedBuffer: { primaryStore: { getUserSharedBuffer: (_k, b) => b, tryLock: () => true, unlock() {} } },
		},
		render_service: { Target: TargetBase, QueueControl: class {}, QueueStatus: class {} },
		render_schedule: { RenderSchedule: class {} },
		page_cache: {
			PrerenderedPage: class {
				static async get(key) {
					keyed('PrerenderedPage', key);
					const page = await pageGet(key);
					return page && { cacheKey: key, ...page };
				}
			},
		},
		probe_state: { ProbeState: class {}, RenderExpectation: class {} },
		invalidation: { Invalidation: { get: async () => null } },
		verification: {
			PageVerification: {
				get: async (key) => {
					keyed('PageVerification', key);
					return null;
				},
			},
		},
		raw_cache: {
			RawPage: {
				get: async (key) => {
					keyed('RawPage', key);
					return null;
				},
				put: async (key) => {
					keyed('RawPage', key);
					rawPuts.push(key);
				},
			},
		},
		negative_cache: {
			NegativePage: {
				get: async (key) => {
					keyed('NegativePage', key);
					return negativeRows.has(key) ? { ...negativeRows.get(key) } : null;
				},
				put: async (key, data) => {
					keyed('NegativePage', key);
					negativeRows.set(key, { cacheKey: key, ...data });
				},
				patch: async (key, data) => {
					keyed('NegativePage', key);
					negativeRows.set(key, { ...(negativeRows.get(key) ?? {}), ...data });
				},
				delete: async (key) => {
					keyed('NegativePage', key);
					negativeRows.delete(key);
				},
			},
		},
		crawl_stats: { CrawlSketch: class {}, VisitFilter: class {} },
	};
	({ applyOptions, config } = await import('../src/config.js'));
	applyOptions(BASE_OPTIONS);
	({ handleBotRequest } = await import('../src/http_handlers/bot_request.js'));
	({ getResidencyByUrl } = await import('../src/util/residency.js'));
	sampling = await import('../src/util/sampling.js');
	sampling.startRequestSampling();
});

let applyOptions;
let sampling;

const BASE_OPTIONS = {
	ingress: {
		mode: 'forwarded',
		deviceTypeSource: 'path',
		routes: [
			{ match: 'prefix', path: '/p/', mode: 'prerender', queryParams: [] },
			{ match: 'prefix', path: '/raw/', mode: 'prerender', queryParams: [], rawCache: true },
			{ match: 'prefix', path: '/neg/', mode: 'prerender', queryParams: [], negativeCache: true },
		],
	},
	analytics: { enabled: false },
	invalidation: { enabled: false },
	render: { raw: { enabled: true }, negative: { enabled: true, dryRun: false } },
	peerRescue: { enabled: true, token: 'cluster-secret' },
};

after(() => {
	origin.server.closeAllConnections?.();
	origin.server.close();
	peer.server.close();
});

beforeEach(() => {
	config.page.snapshotValidators = false;
	origin.requests = [];
	origin.respond = null;
	peer.requests = 0;
	peer.respond = (_req, res) => {
		res.statusCode = 404;
		res.end();
	};
	pageGet = async () => null;
	rawPuts.length = 0;
	negativeRows.clear();
	tableKeys.length = 0;
});

const request = (path, method = 'GET', extra = {}) => ({
	method,
	url: path,
	headers: new RequestHeaders({
		'x-forwarded-host': `127.0.0.1:${origin.port}`,
		'x-forwarded-proto': 'http',
		'user-agent': 'Mozilla/5.0 (compatible; Bingbot/2.0; +http://www.bing.com/bingbot.htm)',
		'accept-encoding': 'gzip',
		'x-harper-prerender-debug': 'true',
		...extra,
	}),
});

const drain = async (body) => {
	if (!body) return '';
	if (Buffer.isBuffer(body)) return body.toString();
	if (typeof body.getReader === 'function') return new Response(body).text();
	const chunks = [];
	for await (const chunk of body) chunks.push(chunk);
	return Buffer.concat(chunks).toString();
};

const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

// A cached page as `PrerenderedPage.get` returns it: stored head as a JSON string, blob-like content.
const cachedPage = (over = {}) => ({
	statusCode: 200,
	headers: JSON.stringify({
		'content-type': 'text/html',
		'etag': '"origin-v1"',
		'last-modified': new Date('2026-09-01T00:00:00Z').toUTCString(),
	}),
	content: { bytes: async () => Buffer.from('<html>snapshot</html>') },
	lastCached: new Date('2026-09-29T10:00:00Z'),
	expiresAt: new Date(Date.now() + 3_600_000),
	isIndexable: true,
	...over,
});

// ── F5: a proxied redirect keeps its target ──────────────────────────────────────────────────────

test('a proxied origin 301 reaches the crawler WITH its Location, absolute, resolved against the public URL', async () => {
	for (const [location, expected] of [
		['https://www.example.com/product/prd-2/new.jsp', 'https://www.example.com/product/prd-2/new.jsp'],
		// Relative: resolved here, so the redirect is right whether the edge relays it or follows it.
		['/product/prd-2/new.jsp', `http://127.0.0.1:${origin.port}/product/prd-2/new.jsp`],
		['new.jsp?c=1', `http://127.0.0.1:${origin.port}/p/new.jsp?c=1`],
	]) {
		origin.respond = (_req, res) => {
			res.writeHead(301, { location, 'content-type': 'text/html', 'content-language': 'en-US' });
			res.end('moved');
		};
		const res = await handleBotRequest(request('/desktop/p/moved'));
		await drain(res.body);
		assert.equal(res.status, 301);
		assert.equal(res.headers.get('location'), expected, 'a redirect with no target is a dead end for the crawler');
		assert.equal(res.headers.get('content-language'), 'en-US');
	}
});

// ── The crawler's User-Agent on the proxy fetch ───────────────────────────────────────────────────

const BINGBOT = 'Mozilla/5.0 (compatible; Bingbot/2.0; +http://www.bing.com/bingbot.htm)';

test('a miss reaches the origin as the crawler plus HarperProxy when forwardUserAgent is on, and as the device browser UA when off', async () => {
	try {
		let res = await handleBotRequest(request('/desktop/p/ua-off'));
		await drain(res.body);
		assert.equal(origin.requests.at(-1).headers['user-agent'], config.origin.userAgents.desktop);

		applyOptions({ ...BASE_OPTIONS, origin: { forwardUserAgent: { enabled: true } } });
		res = await handleBotRequest(request('/mobile/p/ua-on'));
		await drain(res.body);
		assert.equal(res.status, 200);
		assert.equal(origin.requests.at(-1).headers['user-agent'], `${BINGBOT} HarperProxy/1.0`);
		await settle(); // each miss's detached scheduling tail, so it lands here and not in the next test
	} finally {
		applyOptions(BASE_OPTIONS);
	}
});

// ── A URL too long to be a key is proxied, not 500'd ──────────────────────────────────────────────

test('a URL too long to be a cache key is proxied to the origin — not the 500 a key throw made it — and touches no table', async () => {
	// Harper refuses a primary key past 1978 bytes with a throw. The page read was the first thing to hit
	// it, and the catch-all answered the crawler 500 for a URL the origin serves.
	const warned = [];
	const { warn } = logger;
	logger.warn = (msg) => warned.push(String(msg));
	try {
		for (const route of ['p', 'raw', 'neg']) {
			const path = `/desktop/${route}/${'a'.repeat(2100)}`;
			const res = await handleBotRequest(request(path, 'GET', { 'accept-encoding': 'identity' }));
			assert.equal(await drain(res.body), '<html>origin</html>', `${route}: the origin's document`);
			assert.equal(res.status, 200, route);
			assert.equal(res.headers.get('x-harper-cache'), 'bypass', `${route}: not a cacheable request at all`);
			assert.equal(res.headers.get('x-harper-source'), 'origin');
			assert.equal(origin.requests.at(-1).url, path.slice('/desktop'.length), 'the whole URL reached the origin');
		}
		await settle(); // the scheduling tail is detached: it would have read the Target by now
		assert.deepEqual(tableKeys, [], 'no read or write under a key Harper would refuse');
		assert.equal(warned.filter((m) => m.includes('its cache key would exceed the 1978-byte key limit')).length, 3);
	} finally {
		logger.warn = warn;
	}
});

test('an over-limit HEAD goes upstream as a HEAD, a POST with its method, and both are origin_fetch key-too-long', async () => {
	const recorded = [];
	const { recordAnalytics } = server;
	server.recordAnalytics = (...args) => recorded.push(args);
	try {
		const path = `/desktop/p/${'a'.repeat(2100)}`;
		const head = await handleBotRequest(request(path, 'HEAD'));
		assert.equal(head.status, 200);
		assert.equal(head.body, undefined);
		assert.equal(origin.requests.at(-1).method, 'HEAD');
		const post = await handleBotRequest(request(path, 'POST'));
		await drain(post.body);
		assert.equal(post.status, 200);
		assert.equal(origin.requests.at(-1).method, 'POST');
		const reasons = recorded.filter((a) => a[1] === 'origin_fetch').map((a) => a[3]);
		assert.deepEqual(reasons, ['key-too-long', 'key-too-long']);
		await settle();
		assert.deepEqual(tableKeys, []);
	} finally {
		server.recordAnalytics = recordAnalytics;
	}
});

test('an over-limit URL whose origin answers 404 on a negative-cache route stores nothing', async () => {
	origin.respond = (_req, res) => {
		res.writeHead(404, { 'content-type': 'text/html' });
		res.end('gone');
	};
	const res = await handleBotRequest(request(`/desktop/neg/${'a'.repeat(2100)}`));
	await drain(res.body);
	assert.equal(res.status, 404, "the origin's own answer");
	await settle();
	assert.equal(negativeRows.size, 0);
	assert.deepEqual(tableKeys, []);
});

test('a URL just inside the limit is still looked up and cached normally', async () => {
	// 'desktop' plus the delimiter is 8 bytes beside the URL, so this URL's key is exactly 1978 bytes.
	const prefix = `http://127.0.0.1:${origin.port}/p/`;
	const path = `/desktop/p/${'a'.repeat(1978 - 8 - prefix.length)}`;
	const res = await handleBotRequest(request(path));
	await drain(res.body);
	assert.equal(res.status, 200);
	assert.equal(res.headers.get('x-harper-cache'), 'miss');
	assert.ok(
		tableKeys.some((k) => k.startsWith('PrerenderedPage:')),
		'the page was looked up under its key'
	);
});

// ── V1: a HEAD is a HEAD upstream, and nothing abandons a live origin body ──────────────────────

test('a HEAD miss goes to the origin as a HEAD, and HEAD misses do not pin origin sockets', async () => {
	await settle(50);
	const before = origin.sockets.size;
	for (let i = 0; i < 5; i++) {
		const res = await handleBotRequest(request(`/desktop/p/big-${i}`, 'HEAD'));
		assert.equal(res.status, 200);
		assert.equal(res.body, undefined);
	}
	assert.deepEqual(
		origin.requests.map((r) => r.method),
		['HEAD', 'HEAD', 'HEAD', 'HEAD', 'HEAD'],
		'sent as a GET, the origin built a 4 MB document nobody would read'
	);
	await settle();
	assert.ok(
		origin.sockets.size <= before + 1,
		`five HEAD misses must not hold five origin connections open (open: ${origin.sockets.size}, before: ${before})`
	);
	assert.equal(origin.inFlight, 0);
});

test('a HEAD miss on a raw-cache route stores nothing — there is no body to keep', async () => {
	const res = await handleBotRequest(request('/desktop/raw/head', 'HEAD'));
	assert.equal(res.status, 200);
	await settle(50);
	assert.deepEqual(rawPuts, [], 'an empty capture of a 200 is a document nobody should be served');
});

test('a local 304 made from an origin 200 releases the origin body instead of pinning its socket', async () => {
	await settle(50);
	for (let i = 0; i < 5; i++) {
		// The origin ignores the validator and answers 200; the crawler's If-None-Match matches its ETag, so
		// the handler answers 304 itself and never sends the 4 MB it was handed. Past the drain limit the
		// body is torn down rather than read to the end.
		const res = await handleBotRequest(request(`/desktop/p/big-cond-${i}`, 'GET', { 'if-none-match': '"origin-v1"' }));
		assert.equal(res.status, 304);
		assert.equal(res.body, undefined);
	}
	await settle();
	assert.equal(origin.inFlight, 0, 'every abandoned 4 MB response was released, none left pinned');
});

test('a local 304 on a captured body drains it instead, so the raw capture beside it still stores', async () => {
	origin.respond = (_req, res) => {
		res.writeHead(200, { 'content-type': 'text/html', 'etag': '"raw-v1"' });
		res.end('<html>raw document</html>');
	};
	const res = await handleBotRequest(request('/desktop/raw/cond', 'GET', { 'if-none-match': '"raw-v1"' }));
	assert.equal(res.status, 304);
	for (let i = 0; i < 100 && rawPuts.length === 0; i++) await settle(5);
	assert.equal(rawPuts.length, 1, 'destroying the source here would have failed the capture riding it');
});

// ── F10: the owner's copy is judged by its own metadata ─────────────────────────────────────────

// A path whose cache URL the residency hash assigns to the peer, so the rescue has someone to ask.
const peerOwnedPath = () => {
	for (let i = 0; i < 10_000; i++) {
		const path = `/p/rescue-${i}`;
		if (getResidencyByUrl(`http://127.0.0.1:${origin.port}${path}`) === '127.0.0.1') return path;
	}
	throw new Error('no path hashed to the peer');
};

const answerAsOwner = (meta) => (_req, res) => {
	res.writeHead(200, {
		'content-type': 'application/octet-stream',
		'x-prerender-page': JSON.stringify({
			statusCode: 200,
			headers: JSON.stringify({ 'content-type': 'text/html' }),
			isIndexable: true,
			...meta,
		}),
	});
	res.end('<html>owner snapshot</html>');
};

test('a rescue whose OWNER copy is hard-expired falls back to the origin instead of serving it', async () => {
	const path = peerOwnedPath();
	// The local replica still looks fresh; its blob is gone.
	pageGet = async () =>
		cachedPage({ content: { bytes: async () => Promise.reject(new Error('Blob file not found')) } });
	// The owner's record has been hard-expired (the change probe does exactly this) — past the SWR window.
	const expired = Date.now() - config.page.swrTtl - 60_000;
	peer.respond = answerAsOwner({ lastCached: Date.now() - 3_600_000, expiresAt: expired });

	const res = await handleBotRequest(request(`/desktop${path}`, 'GET', { 'accept-encoding': 'identity' }));
	const body = await drain(res.body);
	assert.equal(peer.requests, 1, 'the owner was asked');
	assert.equal(res.headers.get('x-harper-cache'), 'blob-missing', 'the rescue missed, so the local fault stands');
	assert.equal(res.headers.get('x-harper-source'), 'origin');
	assert.equal(body, '<html>origin</html>');
	assert.equal(origin.requests.length, 1);
});

test('a rescue whose owner copy is servable is still served from the owner', async () => {
	const path = peerOwnedPath();
	pageGet = async () =>
		cachedPage({ content: { bytes: async () => Promise.reject(new Error('Blob file not found')) } });
	peer.respond = answerAsOwner({ lastCached: Date.now() - 60_000, expiresAt: Date.now() + 3_600_000 });

	const res = await handleBotRequest(request(`/desktop${path}`, 'GET', { 'accept-encoding': 'identity' }));
	assert.equal(res.headers.get('x-harper-cache'), 'peer-rescue');
	assert.equal(await drain(res.body), '<html>owner snapshot</html>');
	assert.equal(origin.requests.length, 0);
});

// ── an origin 404 sent uncompressed is stored gzipped, and served correctly both ways ────────────────

test('an uncompressed origin 404 is stored gzipped, then answered from storage to gzip and identity clients alike', async () => {
	const page = '<html><body>' + '<p>This item is no longer available.</p>'.repeat(5000) + '</body></html>';
	origin.respond = (_req, res) => {
		// No content-encoding, whatever the request asked for: the origin shape this was built for.
		res.writeHead(404, { 'content-type': 'text/html' });
		res.end(page);
	};
	const miss = await handleBotRequest(request('/desktop/neg/gone', 'GET', { 'accept-encoding': 'identity' }));
	assert.equal(miss.status, 404);
	assert.equal(await drain(miss.body), page, 'the proxied 404 is the origin body, untouched');
	assert.equal(origin.requests.length, 1);
	// The store is detached (gzip, then the put): wait for it rather than for a fixed time.
	for (let i = 0; i < 100 && negativeRows.size === 0; i++) await settle(20);

	const row = [...negativeRows.values()][0];
	assert.ok(row, 'the 404 was stored');
	assert.equal(JSON.parse(row.headers)['content-encoding'], 'gzip');
	assert.ok(row.content.length < page.length / 5, `stored ${row.content.length} bytes for ${page.length}`);

	const gz = await handleBotRequest(request('/desktop/neg/gone', 'GET', { 'accept-encoding': 'gzip' }));
	assert.equal(gz.status, 404);
	assert.equal(gz.headers.get('x-harper-source'), 'negative');
	assert.equal(gz.headers.get('content-encoding'), 'gzip');
	const gzBytes = Buffer.from(await new Response(gz.body).arrayBuffer());
	assert.equal(gunzipSync(gzBytes).toString(), page, 'served as stored, and it decodes to the origin page');

	const plain = await handleBotRequest(request('/desktop/neg/gone', 'GET', { 'accept-encoding': 'identity' }));
	assert.equal(plain.status, 404);
	assert.equal(plain.headers.get('content-encoding'), null, 'decoded for a client that did not ask for gzip');
	assert.equal(await drain(plain.body), page);
	assert.equal(origin.requests.length, 1, 'both answered from storage: the origin was asked once');
});

// ── V2: a snapshot's validators describe the snapshot ───────────────────────────────────────────

test('by default a cache serve carries no validators at all, and a conditional request gets the full snapshot', async () => {
	pageGet = async () => cachedPage();
	const plain = await handleBotRequest(request('/desktop/p/cached'));
	assert.equal(plain.status, 200);
	assert.equal(plain.headers.get('x-harper-source'), 'cache');
	assert.equal(plain.headers.has('etag'), false, "not the origin document's, and not our own");
	assert.equal(plain.headers.has('last-modified'), false);
	const conditional = await handleBotRequest(
		request('/desktop/p/cached', 'GET', {
			'if-none-match': `W/"${new Date('2026-09-29T10:00:00Z').getTime()}-desktop"`,
			'if-modified-since': new Date().toUTCString(),
			'accept-encoding': 'identity',
		})
	);
	assert.equal(conditional.status, 200, 'nothing this cache served can be revalidated');
	assert.equal(await drain(conditional.body), '<html>snapshot</html>');
	assert.equal(origin.requests.length, 0, 'still a cache serve');
});

test("page.snapshotValidators: a cache serve drops the origin document's validators and carries Last-Modified = its render time", async () => {
	config.page.snapshotValidators = true;
	pageGet = async () => cachedPage();
	const res = await handleBotRequest(request('/desktop/p/cached'));
	assert.equal(res.status, 200);
	assert.equal(
		res.headers.get('etag'),
		`W/"${new Date('2026-09-29T10:00:00Z').getTime()}-desktop"`,
		'the stored ETag is the ORIGIN document’s; the snapshot’s names its render and device'
	);
	assert.equal(res.headers.get('last-modified'), new Date('2026-09-29T10:00:00Z').toUTCString());
});

test("the origin's ETag no longer revalidates a snapshot: a re-render under an unchanged origin ETag is a 200", async () => {
	pageGet = async () => cachedPage();
	const res = await handleBotRequest(request('/desktop/p/cached', 'GET', { 'if-none-match': '"origin-v1"' }));
	assert.equal(res.status, 200, 'the crawler would keep the pre-render snapshot on a 304');
	assert.equal(origin.requests.length, 0, 'still a cache serve');
});

test('page.snapshotValidators: If-Modified-Since is evaluated against the render time', async () => {
	config.page.snapshotValidators = true;
	pageGet = async () => cachedPage();
	const same = await handleBotRequest(
		request('/desktop/p/cached', 'GET', { 'if-modified-since': new Date('2026-09-29T10:00:00Z').toUTCString() })
	);
	assert.equal(same.status, 304, 'not re-rendered since the crawler’s copy');
	assert.equal(same.headers.get('last-modified'), new Date('2026-09-29T10:00:00Z').toUTCString());

	// The origin's own Last-Modified (Sept 1) is older than this validator; the render is newer. Before, the
	// origin's date answered this 304 — for a snapshot rendered after the crawler's copy.
	const older = await handleBotRequest(
		request('/desktop/p/cached', 'GET', { 'if-modified-since': new Date('2026-09-15T00:00:00Z').toUTCString() })
	);
	assert.equal(older.status, 200, 're-rendered since: the crawler must get the new snapshot');
});

// ── round 2: a refused page row must not let our own validators decide ────────────────────────

// The origin a Merchant Center-style check trips on: content changed, content ETag changed, but its
// Last-Modified is a template mtime that never moves.
const constantLastModified = (_req, res) => {
	res.writeHead(200, {
		'content-type': 'text/html',
		'etag': '"new-content"',
		'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT',
	});
	res.end('<html>new price</html>');
};

test('a probe hard-expired (stale) page proxied with OUR Last-Modified is a 200, and the validator never reaches the origin', async () => {
	origin.respond = constantLastModified;
	// The crawler holds our snapshot: its Last-Modified is our render time, an hour ago.
	const ours = new Date(Date.now() - 3_600_000).toUTCString();
	// The page row is still there but hard-expired: past its SWR window, so it is not served.
	pageGet = async () => cachedPage({ expiresAt: new Date(Date.now() - config.page.swrTtl - 60_000) });
	const res = await handleBotRequest(
		request('/desktop/p/expired', 'GET', { 'if-modified-since': ours, 'accept-encoding': 'identity' })
	);
	assert.equal(res.headers.get('x-harper-cache'), 'stale');
	assert.equal(res.status, 200, 'a 304 here keeps the pre-change snapshot the probe just expired');
	assert.equal(await drain(res.body), '<html>new price</html>');
	assert.equal(origin.requests.at(-1).headers['if-modified-since'], undefined, 'stripped upstream too');
});

test('a blob-fault proxy strips the validators and skips the local conditional too', async () => {
	origin.respond = constantLastModified;
	pageGet = async () =>
		cachedPage({ content: { bytes: async () => Promise.reject(new Error('Blob file not found')) } });
	const res = await handleBotRequest(
		request('/desktop/p/dangling', 'GET', {
			'if-modified-since': new Date().toUTCString(),
			'if-none-match': '"new-content"',
		})
	);
	await drain(res.body);
	assert.equal(res.headers.get('x-harper-cache'), 'blob-missing');
	assert.equal(res.status, 200);
	const sent = origin.requests.at(-1).headers;
	assert.equal(sent['if-modified-since'], undefined);
	assert.equal(sent['if-none-match'], undefined);
});

test('a TRUE miss keeps ordinary conditional handling: its validators came from the origin', async () => {
	origin.respond = constantLastModified;
	const res = await handleBotRequest(request('/desktop/p/never-cached', 'GET', { 'if-none-match': '"new-content"' }));
	assert.equal(res.status, 304);
	assert.equal(origin.requests.at(-1).headers['if-none-match'], '"new-content"', 'forwarded, as before');
});

test('page.snapshotValidators: the snapshot ETag revalidates the exact render: 304 for it, 200 once the page re-renders', async () => {
	config.page.snapshotValidators = true;
	const tag = `W/"${new Date('2026-09-29T10:00:00Z').getTime()}-desktop"`;
	pageGet = async () => cachedPage();
	assert.equal((await handleBotRequest(request('/desktop/p/cached', 'GET', { 'if-none-match': tag }))).status, 304);
	// Re-rendered 400 ms later — the same HTTP-date second. If-Modified-Since would call this unchanged.
	pageGet = async () => cachedPage({ lastCached: new Date('2026-09-29T10:00:00.400Z') });
	const later = await handleBotRequest(
		request('/desktop/p/cached', 'GET', {
			'if-none-match': tag,
			'if-modified-since': new Date('2026-09-29T10:00:00Z').toUTCString(),
		})
	);
	assert.equal(later.status, 200);
});

test('a local 304 on a GET drains the body so the pooled origin connection is REUSED, not closed', async () => {
	origin.respond = (_req, res) => {
		res.writeHead(200, { 'content-type': 'text/html', 'etag': '"small"' });
		res.end('y'.repeat(200 * 1024));
	};
	await settle(50);
	const before = origin.connections;
	for (let i = 0; i < 5; i++) {
		const res = await handleBotRequest(request(`/desktop/p/small-cond-${i}`, 'GET', { 'if-none-match': '"small"' }));
		assert.equal(res.status, 304);
		await settle(30);
	}
	assert.ok(
		origin.connections - before <= 1,
		`five local 304s must reuse one connection, not open five (opened ${origin.connections - before})`
	);
});

// ── request sampling ─────────────────────────────────────────────────────────────────────────────

test('a sampler records the status the crawler was SENT: an origin 200 answered locally as a 304', async () => {
	const sampleDir = mkdtempSync(join(tmpdir(), 'prerender-bot-sampling-'));
	applyOptions({
		...BASE_OPTIONS,
		sampling: {
			enabled: true,
			directory: sampleDir,
			samplers: [
				{
					name: 'pdp',
					match: { routes: ['/p/'], bots: ['Bingbot'] },
					sample: { rate: 1 },
					fields: ['url', 'route', 'bot', 'device', 'status', 'cacheStatus', 'source', 'conditional', 'ageMs'],
				},
			],
		},
	});
	try {
		// The origin answers 200 with this ETag, and the crawler's If-None-Match matches it, so the handler
		// sends a 304 — the status the sampler must record, not the origin's 200.
		const res = await handleBotRequest(request('/desktop/p/big-sampled', 'GET', { 'if-none-match': '"origin-v1"' }));
		assert.equal(res.status, 304);
		await settle();
		await sampling.flushSamples();
		const files = readdirSync(join(sampleDir, 'pdp'));
		assert.equal(files.length, 1);
		const [record] = gunzipSync(readFileSync(join(sampleDir, 'pdp', files[0])))
			.toString()
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line));
		const { ts, ...rest } = record;
		assert.ok(ts > 0);
		assert.deepEqual(rest, {
			url: `http://127.0.0.1:${origin.port}/p/big-sampled`,
			route: '/p/',
			bot: 'Bingbot',
			device: 'desktop',
			status: 304,
			cacheStatus: 'miss',
			source: 'origin',
			conditional: true,
			ageMs: null,
		});
	} finally {
		applyOptions(BASE_OPTIONS);
		rmSync(sampleDir, { recursive: true, force: true });
	}
});

test('a request the handler answers 500 is still offered to the samplers', async () => {
	const sampleDir = mkdtempSync(join(tmpdir(), 'prerender-bot-sampling-'));
	applyOptions({
		...BASE_OPTIONS,
		sampling: {
			enabled: true,
			directory: sampleDir,
			samplers: [{ name: 'fails', match: { routes: ['/p/'] }, sample: { rate: 1 }, fields: ['url', 'status'] }],
		},
	});
	try {
		pageGet = async () => {
			throw new Error('storage fault');
		};
		const res = await handleBotRequest(request('/desktop/p/broken'));
		assert.equal(res.status, 500);
		await sampling.flushSamples();
		const [file] = readdirSync(join(sampleDir, 'fails'));
		const { ts, ...record } = JSON.parse(gunzipSync(readFileSync(join(sampleDir, 'fails', file))).toString());
		assert.ok(ts > 0);
		assert.deepEqual(record, { url: `http://127.0.0.1:${origin.port}/p/broken`, status: 500 });
	} finally {
		applyOptions(BASE_OPTIONS);
		rmSync(sampleDir, { recursive: true, force: true });
	}
});
