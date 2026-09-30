import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

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
		static async get() {
			return null;
		}
		static async put() {}
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
					const page = await pageGet(key);
					return page && { cacheKey: key, ...page };
				}
			},
		},
		probe_state: { ProbeState: class {}, RenderExpectation: class {} },
		invalidation: { Invalidation: { get: async () => null } },
		verification: { PageVerification: { get: async () => null } },
		raw_cache: {
			RawPage: {
				get: async () => null,
				put: async (key) => {
					rawPuts.push(key);
				},
			},
		},
		negative_cache: { NegativePage: { get: async () => null } },
		crawl_stats: { CrawlSketch: class {}, VisitFilter: class {} },
	};
	let applyOptions;
	({ applyOptions, config } = await import('../src/config.js'));
	applyOptions({
		ingress: {
			mode: 'forwarded',
			deviceTypeSource: 'path',
			routes: [
				{ match: 'prefix', path: '/p/', mode: 'prerender', queryParams: [] },
				{ match: 'prefix', path: '/raw/', mode: 'prerender', queryParams: [], rawCache: true },
			],
		},
		analytics: { enabled: false },
		invalidation: { enabled: false },
		render: { raw: { enabled: true } },
		peerRescue: { enabled: true, token: 'cluster-secret' },
	});
	({ handleBotRequest } = await import('../src/http_handlers/bot_request.js'));
	({ getResidencyByUrl } = await import('../src/util/residency.js'));
});

after(() => {
	origin.server.closeAllConnections?.();
	origin.server.close();
	peer.server.close();
});

beforeEach(() => {
	origin.requests = [];
	origin.respond = null;
	peer.requests = 0;
	peer.respond = (_req, res) => {
		res.statusCode = 404;
		res.end();
	};
	pageGet = async () => null;
	rawPuts.length = 0;
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

// ── V2: a snapshot's validators describe the snapshot ───────────────────────────────────────────

test("a cache serve drops the origin document's validators and carries Last-Modified = its render time", async () => {
	pageGet = async () => cachedPage();
	const res = await handleBotRequest(request('/desktop/p/cached'));
	assert.equal(res.status, 200);
	assert.equal(
		res.headers.get('etag'),
		`W/"${new Date('2026-09-29T10:00:00Z').getTime()}"`,
		'the stored ETag is the ORIGIN document’s; the snapshot’s names its render'
	);
	assert.equal(res.headers.get('last-modified'), new Date('2026-09-29T10:00:00Z').toUTCString());
});

test("the origin's ETag no longer revalidates a snapshot: a re-render under an unchanged origin ETag is a 200", async () => {
	pageGet = async () => cachedPage();
	const res = await handleBotRequest(request('/desktop/p/cached', 'GET', { 'if-none-match': '"origin-v1"' }));
	assert.equal(res.status, 200, 'the crawler would keep the pre-render snapshot on a 304');
	assert.equal(origin.requests.length, 0, 'still a cache serve');
});

test('If-Modified-Since is evaluated against the render time', async () => {
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

test('the snapshot ETag revalidates the exact render: 304 for it, 200 once the page re-renders', async () => {
	const tag = `W/"${new Date('2026-09-29T10:00:00Z').getTime()}"`;
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
