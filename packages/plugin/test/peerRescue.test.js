import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

/**
 * Serve-path peer rescue: a cached page whose LOCAL blob fails the bounded read is answered
 * with the residency owner's copy over the cluster's own HTTP instead of the origin proxy.
 *
 * The properties worth pinning are the ones the design leans on:
 *   - fails CLOSED (no token / disabled → no endpoint, no rescue attempts, no network);
 *   - the destination is the residency owner and only ever a known cluster node;
 *   - the shared token is required and compared timing-safely on the serving side;
 *   - metadata and bytes cross the wire as ONE consistent version of the owner's record;
 *   - every failure (peer down, slow, 4xx/5xx, malformed metadata) is a `{ ok: false }`
 *     return, never a throw — the serve path must always be able to fall back to origin.
 */

let config;
let rescueFromOwner;
let peerTokenMatches;
let isPeerRescueActive;
let handlePeerPageRequest;
let getResidencyByUrl;

// This node's stored pages, served by the endpoint under test via the PrerenderedPage stub.
const records = new Map();

let httpServer;

before(async () => {
	// residency.js snapshots the node list from `server` at module load, so the global must be
	// in place before the import graph is evaluated. '127.0.0.1' is the one peer: peerOrigin
	// speaks plain http to a localhost address, which lets these tests run a real HTTP hop.
	globalThis.server = { hostname: 'test-node', nodes: [{ name: '127.0.0.1' }], config: { http: { port: 0 } } };
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {} };
	globalThis.Resource = class {};
	globalThis.databases = {
		page_cache: {
			PrerenderedPage: class {
				static async get(key) {
					return records.get(key);
				}
			},
		},
	};

	({ config } = await import('../src/config.js'));
	({ rescueFromOwner, peerTokenMatches, isPeerRescueActive } = await import('../src/util/peerRescue.js'));
	({ handlePeerPageRequest } = await import('../src/http_handlers/peer_page.js'));
	({ getResidencyByUrl } = await import('../src/util/residency.js'));

	// A real HTTP hop for the client tests: adapt node:http onto the endpoint handler, so the
	// happy path exercises the actual wire format (metadata header round trip, opaque bytes) —
	// exactly what a peer node would serve.
	httpServer = createServer(async (req, res) => {
		if (req.url.includes('force-403')) {
			res.statusCode = 403;
			return res.end();
		}
		if (req.url.includes('force-hang')) return; // never answered — the client deadline must fire
		const out = await handlePeerPageRequest({
			method: req.method,
			url: req.url,
			headers: new Headers(req.headers),
		});
		res.statusCode = out.status;
		for (const [name, value] of Object.entries(out.headers)) res.setHeader(name, value);
		res.end(out.body);
	});
	await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
	// peerOrigin reads the port lazily, so the ephemeral one can be filled in after listen.
	globalThis.server.config.http.port = httpServer.address().port;
});

after(() => {
	httpServer?.close();
	delete globalThis.server;
	delete globalThis.logger;
	delete globalThis.databases;
	delete globalThis.Resource;
});

beforeEach(() => {
	records.clear();
	config.peerRescue.enabled = true;
	config.peerRescue.token = 'cluster-secret';
	config.peerRescue.header = 'x-harper-peer-token';
	config.peerRescue.timeoutMs = 400;
	config.page.blobReadBudgetMs = 500;
});

// A url the rendezvous hash assigns to `owner`, so tests control which node "owns" the key.
const urlOwnedBy = (owner) => {
	for (let i = 0; i < 10_000; i++) {
		const url = `https://example.com/page-${i}`;
		if (getResidencyByUrl(url) === owner) return url;
	}
	throw new Error(`no candidate url hashed to ${owner}`);
};

const blobOf = (bytes) => ({ bytes: async () => bytes });

const storedPage = (body, overrides = {}) => ({
	statusCode: 200,
	headers: JSON.stringify({ 'content-type': 'text/html', 'content-encoding': 'gzip' }),
	content: blobOf(body),
	lastCached: new Date('2026-08-12T00:00:00Z'),
	expiresAt: new Date('2026-08-13T00:00:00Z'),
	isIndexable: true,
	...overrides,
});

// ── fail-closed gates ──────────────────────────────────────────────────────────────────────

test('no token → inactive: no rescue is attempted and the endpoint answers 404', async () => {
	config.peerRescue.token = '';
	assert.equal(isPeerRescueActive(), false);

	const res = await rescueFromOwner({ cacheKey: 'k', cacheUrl: urlOwnedBy('127.0.0.1') });
	assert.deepEqual(res, { ok: false, reason: 'disabled' });

	const out = await handlePeerPageRequest({ method: 'GET', url: '/prerender_peer/page?key=k', headers: new Headers() });
	assert.equal(out.status, 404, 'an unconfigured node must not reveal the endpoint exists');
});

test('enabled: false → inactive even with a token configured', async () => {
	config.peerRescue.enabled = false;
	const res = await rescueFromOwner({ cacheKey: 'k', cacheUrl: urlOwnedBy('127.0.0.1') });
	assert.deepEqual(res, { ok: false, reason: 'disabled' });
});

test('token comparison: exact match only, and never a throw on a wrong-length probe', () => {
	assert.equal(peerTokenMatches('cluster-secret'), true);
	assert.equal(peerTokenMatches('cluster-secreT'), false);
	assert.equal(peerTokenMatches('x'), false, 'length mismatch must compare false, not throw');
	assert.equal(peerTokenMatches(''), false);
	assert.equal(peerTokenMatches(undefined), false);
	config.peerRescue.token = '';
	assert.equal(peerTokenMatches(''), false, 'empty-vs-empty must not authenticate');
});

// ── the client ─────────────────────────────────────────────────────────────────────────────

test('a self-owned key is not rescued — this node IS the owner, there is no one to ask', async () => {
	const res = await rescueFromOwner({ cacheKey: 'k', cacheUrl: urlOwnedBy('test-node') });
	assert.deepEqual(res, { ok: false, reason: 'self-owned' });
});

test('happy path: the owner answers one consistent version — metadata and bytes together', async () => {
	const cacheUrl = urlOwnedBy('127.0.0.1');
	const cacheKey = `${cacheUrl}|desktop`;
	records.set(cacheKey, storedPage(Buffer.from('OWNER-BYTES')));

	const res = await rescueFromOwner({ cacheKey, cacheUrl });
	assert.equal(res.ok, true);
	assert.equal(res.owner, '127.0.0.1');
	assert.equal(res.body.toString(), 'OWNER-BYTES');
	assert.equal(res.page.statusCode, 200);
	assert.equal(
		res.page.headers,
		JSON.stringify({ 'content-type': 'text/html', 'content-encoding': 'gzip' }),
		'the stored header JSON must arrive verbatim — it carries the content-encoding the bytes are in'
	);
	assert.equal(res.page.lastCached, new Date('2026-08-12T00:00:00Z').getTime(), 'dates cross the wire as epoch ms');
	assert.equal(res.page.isIndexable, true);
});

test('a cache key with a delimiter and query survives the round trip URL-encoded', async () => {
	const cacheUrl = urlOwnedBy('127.0.0.1');
	const cacheKey = `${cacheUrl}?a=1&b=two words|mobile`;
	records.set(cacheKey, storedPage(Buffer.from('ENCODED-KEY')));

	const res = await rescueFromOwner({ cacheKey, cacheUrl });
	assert.equal(res.ok, true);
	assert.equal(res.body.toString(), 'ENCODED-KEY');
});

test("the owner not holding the record is a miss, not a throw — the caller's origin fallback proceeds", async () => {
	const res = await rescueFromOwner({ cacheKey: 'never-stored', cacheUrl: urlOwnedBy('127.0.0.1') });
	assert.equal(res.ok, false);
	assert.equal(res.reason, 'peer responded 404');
});

test('a peer refusing the token (mismatched cluster config) reads as a miss with the status', async () => {
	const res = await rescueFromOwner({ cacheKey: 'force-403', cacheUrl: urlOwnedBy('127.0.0.1') });
	assert.equal(res.ok, false);
	assert.equal(res.reason, 'peer responded 403');
});

test('an unresponsive owner costs exactly the configured deadline, then origin fallback', async () => {
	config.peerRescue.timeoutMs = 60;
	const t0 = Date.now();
	const res = await rescueFromOwner({ cacheKey: 'force-hang', cacheUrl: urlOwnedBy('127.0.0.1') });
	const elapsed = Date.now() - t0;
	assert.equal(res.ok, false);
	assert.equal(res.reason, 'peer timed out');
	assert.ok(elapsed < 2000, `must give up at the deadline, took ${elapsed}ms`);
});

test('an unreachable owner is a captured failure, never a throw', async () => {
	const livePort = globalThis.server.config.http.port;
	globalThis.server.config.http.port = 1; // nothing listens on port 1
	try {
		const res = await rescueFromOwner({ cacheKey: 'k', cacheUrl: urlOwnedBy('127.0.0.1') });
		assert.equal(res.ok, false);
		assert.match(res.reason, /peer fetch failed/);
	} finally {
		globalThis.server.config.http.port = livePort;
	}
});

// ── the endpoint ───────────────────────────────────────────────────────────────────────────

// `token: null` sends NO token header (undefined would just re-trigger the default parameter).
const peerRequest = (key, { token = 'cluster-secret', method = 'GET' } = {}) => ({
	method,
	url: key === undefined ? '/prerender_peer/page' : `/prerender_peer/page?key=${encodeURIComponent(key)}`,
	headers: new Headers(token === null ? {} : { 'x-harper-peer-token': token }),
});

test('a wrong or missing token answers 403 with no body', async () => {
	records.set('k', storedPage(Buffer.from('X')));
	assert.equal((await handlePeerPageRequest(peerRequest('k', { token: 'wrong' }))).status, 403);
	assert.equal((await handlePeerPageRequest(peerRequest('k', { token: null }))).status, 403);
});

test('non-GET answers 405 — the endpoint is strictly a read', async () => {
	records.set('k', storedPage(Buffer.from('X')));
	assert.equal((await handlePeerPageRequest(peerRequest('k', { method: 'POST' }))).status, 405);
});

test('a missing key parameter answers 400', async () => {
	assert.equal((await handlePeerPageRequest(peerRequest(undefined))).status, 400);
});

test("the owner's own read failures map to distinct codes: stuck read 504, unreadable blob 410", async () => {
	config.page.blobReadBudgetMs = 30;
	records.set('stuck', storedPage(undefined, { content: { bytes: () => new Promise(() => {}) } }));
	records.set('gone', storedPage(undefined, { content: { bytes: () => Promise.reject(new Error('unlinked')) } }));

	assert.equal((await handlePeerPageRequest(peerRequest('stuck'))).status, 504);
	assert.equal((await handlePeerPageRequest(peerRequest('gone'))).status, 410);
});

test('a page with no content answers 200 with an empty body — matching what this node itself would serve', async () => {
	records.set('empty', storedPage(undefined, { content: null }));
	const out = await handlePeerPageRequest(peerRequest('empty'));
	assert.equal(out.status, 200);
	assert.equal(out.body.length, 0);
	assert.equal(JSON.parse(out.headers['x-prerender-page']).statusCode, 200);
});

test("the endpoint serves its record's status verbatim — a cached 404 is the owner's true answer", async () => {
	records.set('not-found-page', storedPage(Buffer.from('404-BODY'), { statusCode: 404 }));
	const out = await handlePeerPageRequest(peerRequest('not-found-page'));
	assert.equal(out.status, 200, 'transport says "I have it"; the page status travels in the metadata');
	assert.equal(JSON.parse(out.headers['x-prerender-page']).statusCode, 404);
});
