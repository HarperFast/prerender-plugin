import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

/**
 * `http_handlers/peer_heal.js` — exercised through the HANDLER, against a request shaped like the
 * one Harper's raw `server.http` chain actually passes.
 *
 * THIS FILE EXISTS BECAUSE OF A PRODUCTION FAILURE. The first cut called `await request.json()`.
 * Harper's raw http request has no such method — the body is `request.body`, a Readable — so the
 * call threw, the handler's own catch turned it into a 400, and 100% of forwarded heals failed
 * while every external signal looked healthy: the route answered, auth gated correctly, and only
 * the body read was broken. `util/peerHeal.js` and `util/invalidationReenqueue.js` were both
 * thoroughly unit-tested and neither could see it, because the bug lived in the seam between the
 * handler and a request object no test constructed.
 *
 * So the contract pinned here is deliberately about the SEAM, not the logic:
 *   - a Readable body is read and parsed (the shape core actually passes)
 *   - the read is BOUNDED, since this is network-facing
 *   - a body-less or malformed request is refused with a useful code, never a throw
 *   - the auth/existence ordering is preserved: unconfigured 404 before wrong-token 403, so the
 *     endpoint's existence is not disclosed to an unauthenticated caller
 */

let handler, config;
const makeRequest = ({ method = 'POST', body, headers = {} } = {}) => ({
	method,
	url: '/prerender_peer/heal',
	headers: { get: (k) => headers[k] ?? headers[String(k).toLowerCase()] ?? null },
	body,
});

/** The shape core passes: a Readable, not a string and not a WHATWG Request. */
const streamOf = (obj) => Readable.from([Buffer.from(JSON.stringify(obj), 'utf8')]);

before(async () => {
	globalThis.Resource = class {};
	globalThis.server = { hostname: 'node-a', nodes: [], recordAnalytics: () => {}, config: { http: { port: 9926 } } };
	globalThis.logger = { info() {}, warn() {}, error() {}, debug() {} };
	// Enough of the module graph to import: the handler pulls in `accelerateHeal`, which reaches
	// `Target.js`, which destructures `databases.page_cache` at MODULE SCOPE. The collaborators are
	// covered exhaustively by their own suites — what is under test here is the handler seam, so
	// these only need to exist and answer emptily.
	// CLASS-shaped, not plain objects: the plugin's resources `extend` these tables, so an object
	// stub fails at import with "Class extends value is not a constructor". Same shape as
	// test/invalidationReenqueue.js's `makeTable`.
	const emptyTable = () =>
		class FakeTable {
			static async get() {
				return null;
			}
			static async put() {}
			static async patch() {}
			static async delete() {}
			static async *search() {}
		};
	globalThis.databases = {
		page_cache: { PrerenderedPage: emptyTable() },
		render_service: { Target: emptyTable(), QueueStatus: emptyTable(), QueueControl: emptyTable() },
		render_schedule: { RenderSchedule: emptyTable() },
		invalidation: { Invalidation: emptyTable() },
		verification: { PageVerification: emptyTable() },
		probe_state: { ProbeState: emptyTable() },
		coordination: {
			SharedBuffer: { primaryStore: { getUserSharedBuffer: (_k, buf) => buf } },
		},
	};

	({ config } = await import('../src/config.js'));
	handler = (await import('../src/http_handlers/peer_heal.js')).handlePeerHealRequest;
});

beforeEach(() => {
	config.invalidation.reenqueue.crossNode.enabled = true;
	config.peerRescue.token = 'shared-secret';
	config.peerRescue.header = 'x-harper-peer-token';
});

const AUTH = { 'x-harper-peer-token': 'shared-secret' };
const PAYLOAD = { url: 'https://example.com/p/1', cacheKey: 'https://example.com/p/1|desktop' };

test('a READABLE body is read and parsed — the shape Harper actually passes', async () => {
	const res = await handler(makeRequest({ body: streamOf(PAYLOAD), headers: AUTH }));
	// The handler gets past the body read: it either heals or reports not-invalidated, but it must
	// NOT answer "body must be JSON". That 400 is the production bug this test exists to pin.
	assert.notEqual(res.status, 400, 'a Readable body must not be rejected as unparseable');
});

test('a string body is accepted too — defensive against a different chain shape', async () => {
	const res = await handler(makeRequest({ body: JSON.stringify(PAYLOAD), headers: AUTH }));
	assert.notEqual(res.status, 400);
});

test('a Buffer body is accepted', async () => {
	const res = await handler(makeRequest({ body: Buffer.from(JSON.stringify(PAYLOAD)), headers: AUTH }));
	assert.notEqual(res.status, 400);
});

test('an oversized body is REFUSED rather than buffered', async () => {
	// Network-facing read: a valid token must not buy the ability to make a worker hold an
	// arbitrary payload. The cap is 8 KiB against a legitimate body of a few hundred bytes.
	const huge = Readable.from([Buffer.alloc(20_000, 0x41)]);
	const res = await handler(makeRequest({ body: huge, headers: AUTH }));
	// 413, not 400: the caller folds every non-2xx into `forward-failed`, but its reason carries the
	// status, so this is the difference between a diagnosable log line and an ambiguous one.
	assert.equal(res.status, 413);
	assert.match(res.body, /too large/);
});

test('a body-less POST is a field error, not a parse error', async () => {
	const res = await handler(makeRequest({ body: null, headers: AUTH }));
	assert.equal(res.status, 400);
	assert.match(res.body, /url and cacheKey are required/);
});

test('malformed JSON is a 400, never a throw into the http chain', async () => {
	const res = await handler(makeRequest({ body: Readable.from([Buffer.from('{not json')]), headers: AUTH }));
	assert.equal(res.status, 400);
});

test('a stream that ERRORS mid-read is a 400, not an unhandled rejection', async () => {
	const bad = new Readable({
		read() {
			this.destroy(new Error('socket reset'));
		},
	});
	const res = await handler(makeRequest({ body: bad, headers: AUTH }));
	assert.equal(res.status, 400);
});

test('EXISTENCE IS NOT DISCLOSED: unconfigured answers 404 BEFORE the token is checked', async () => {
	config.invalidation.reenqueue.crossNode.enabled = false;
	const res = await handler(makeRequest({ body: streamOf(PAYLOAD), headers: AUTH }));
	assert.equal(res.status, 404, 'a node without the feature must not reveal that the route exists');
});

test('a wrong token is 403, and the body is never read', async () => {
	let touched = false;
	const spy = new Readable({
		read() {
			touched = true;
			this.push(null);
		},
	});
	const res = await handler(makeRequest({ body: spy, headers: { 'x-harper-peer-token': 'wrong' } }));
	assert.equal(res.status, 403);
	assert.equal(touched, false, 'an unauthenticated caller must not get a body read');
});

test('a non-POST is 405 after auth', async () => {
	const res = await handler(makeRequest({ method: 'GET', body: null, headers: AUTH }));
	assert.equal(res.status, 405);
});

test('a raw Uint8Array body is parsed, NOT iterated byte-by-byte', async () => {
	// `Buffer.isBuffer(new Uint8Array(...))` is false — a Buffer is a Uint8Array subclass, not the
	// reverse. A bare isBuffer check let this fall into the streaming branch, where a Uint8Array's
	// SYNCHRONOUS iterability makes `for await` walk it one byte at a time and hand Buffer.from a
	// number. Caught in review (gemini-code-assist).
	const bytes = new Uint8Array(Buffer.from(JSON.stringify(PAYLOAD), 'utf8'));
	const res = await handler(makeRequest({ body: bytes, headers: AUTH }));
	assert.notEqual(res.status, 400, 'a Uint8Array body must be parsed whole');
});

test('a Uint8Array VIEW onto a larger allocation reads only its own bytes', async () => {
	// The (buffer, byteOffset, byteLength) form matters: copying the whole backing store would
	// splice neighbouring bytes into the JSON.
	const json = Buffer.from(JSON.stringify(PAYLOAD), 'utf8');
	const backing = Buffer.alloc(json.length + 64, 0x7a);
	json.copy(backing, 32);
	const view = new Uint8Array(backing.buffer, backing.byteOffset + 32, json.length);
	const res = await handler(makeRequest({ body: view, headers: AUTH }));
	assert.notEqual(res.status, 400);
});

test('an oversized already-materialised body is refused without parsing', async () => {
	const res = await handler(makeRequest({ body: new Uint8Array(20_000), headers: AUTH }));
	assert.equal(res.status, 413);
	assert.match(res.body, /too large/);
});

test('a stream chunk that is neither text nor bytes is refused explicitly', async () => {
	const weird = Readable.from([{ not: 'bytes' }], { objectMode: true });
	const res = await handler(makeRequest({ body: weird, headers: AUTH }));
	assert.equal(res.status, 400);
});
