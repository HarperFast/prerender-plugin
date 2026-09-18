import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * `util/rawCache.js` — caching the origin document a miss already fetched.
 *
 * THE FAILURE MODES HERE ARE ALL SILENT, and they point in two directions rather than one:
 *
 *   - STORE TOO MUCH and the cache fills with documents that should never have been shared: a
 *     personalized response, a `private` one, an error page under a 200-shaped miss. Nothing throws;
 *     crawlers just start receiving somebody's session. So every refusal is pinned by name, and the
 *     name is what the metric reports — a route that is enabled and filling nothing must be
 *     distinguishable from one that is switched off.
 *   - SERVE WHAT WAS STORED WRONG and the bytes and their headers disagree. The body is kept in the
 *     origin's own encoding and re-encoded at serve time from the STORED `content-encoding`, so the
 *     one header that must not survive is `content-length`: a re-encoded body has a different
 *     length, and a stored one contradicts the bytes actually sent.
 *
 * The capture itself has a third: it rides the body a crawler is reading RIGHT NOW. A `tee()`
 * buffers for whichever branch is slower, so a capture that stalls, or that keeps reading past the
 * cap, is paid for in the crawler's latency and this process's memory. Both are pinned below.
 */

let rawCache, config;
const rows = new Map();
let ops = [];
let failWrites = false;

before(async () => {
	globalThis.server = {
		hostname: 'test-node',
		nodes: [],
		recordAnalytics: (_value, metric, path, method) => ops.push(`${metric}:${path}:${method}`),
	};
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {} };
	// Harper's blob factory. The real one writes a blob file; the shape that matters here is that
	// whatever is handed in comes back out, so the stored bytes can be asserted.
	globalThis.createBlob = (bytes) => ({ blob: true, bytes });
	globalThis.databases = {
		raw_cache: {
			RawPage: {
				async get(query) {
					const id = typeof query === 'object' ? query.id : query;
					if (id === 'THROWS') throw new Error('storage fault');
					return rows.get(id) ? { ...rows.get(id) } : null;
				},
				async put(id, data) {
					if (failWrites) throw new Error('storage fault');
					rows.set(id, { cacheKey: id, ...data });
				},
			},
		},
	};

	({ config } = await import('../src/config.js'));
	rawCache = await import('../src/util/rawCache.js');
});

beforeEach(() => {
	rows.clear();
	ops = [];
	failWrites = false;
	config.render.raw.enabled = true;
	config.render.raw.maxBytes = 1024;
	config.render.raw.expiry = 'midnight';
	config.render.raw.expiryTimezone = 'UTC';
	config.render.raw.contentTypes = ['text/html'];
});

const policy = () => config.render.raw;

const originResource = (over = {}) => ({
	miss: true,
	statusCode: 200,
	viaStaging: false,
	hadSetCookie: false,
	headers: { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip', 'content-length': '123' },
	...over,
});

// A web stream over the given chunks; `failAt` makes it error after that many chunks, which is what
// a truncated origin response looks like from here.
const streamOf = (chunks, failAt = -1) =>
	new ReadableStream({
		start(controller) {
			chunks.forEach((chunk, i) => {
				if (i === failAt) return controller.error(new Error('origin body truncated'));
				controller.enqueue(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
			});
			if (failAt === -1) controller.close();
		},
	});

const drain = async (stream) => {
	const reader = stream.getReader();
	const out = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		out.push(value);
	}
	return Buffer.concat(out);
};

// ---- both switches ---------------------------------------------------------------------------

test('the policy requires the master switch AND the route opt-in — either alone is inert', () => {
	assert.equal(rawCache.rawCachePolicy({ rawCache: true }), policy());

	config.render.raw.enabled = false;
	assert.equal(rawCache.rawCachePolicy({ rawCache: true }), null, 'route opt-in alone must do nothing');

	config.render.raw.enabled = true;
	assert.equal(rawCache.rawCachePolicy({ rawCache: false }), null);
	assert.equal(rawCache.rawCachePolicy(undefined), null, 'an unmatched URL has no route and must not store');
});

// ---- expiry ----------------------------------------------------------------------------------

test('expiry: midnight resolves to the next UTC midnight, not to "now + 24h"', () => {
	const at = rawCache.rawExpiresAt(policy());
	const asDate = new Date(at);
	assert.equal(asDate.getUTCHours(), 0);
	assert.equal(asDate.getUTCMinutes(), 0);
	assert.ok(at > Date.now(), 'must be in the future');
	assert.ok(at - Date.now() <= 24 * 60 * 60 * 1000, 'and no more than a day out');
});

test('expiry: a numeric value is a plain offset from now', () => {
	config.render.raw.expiry = 3_600_000;
	const now = Date.now();
	const at = rawCache.rawExpiresAt(policy(), now);
	assert.equal(at, now + 3_600_000);
});

test('expiry: a garbage value falls back to the boundary and NEVER to NaN', () => {
	// NaN would be stored as an expiry that every comparison reads as "not servable" — a feature
	// that stores everything and serves none of it, with nothing to say so.
	for (const bad of ['soon', null, 0, -1, {}]) {
		config.render.raw.expiry = bad;
		const at = rawCache.rawExpiresAt(policy());
		assert.ok(Number.isFinite(at), `expiry ${String(bad)} produced a non-finite expiry`);
		assert.ok(at > Date.now());
	}
});

// ---- the store gate --------------------------------------------------------------------------

test('a clean 200 HTML response is storable', () => {
	assert.equal(rawCache.storeRefusal(originResource(), policy()), null);
});

test('every refusal reports itself by name', () => {
	const cases = [
		[{ statusCode: 404 }, 'not-200'],
		[{ statusCode: 500 }, 'not-200'],
		[{ viaStaging: true }, 'staging'],
		[{ hadSetCookie: true }, 'has-cookie'],
		[{ headers: { 'content-type': 'application/json' } }, 'content-type'],
		[{ headers: { 'content-type': 'text/html', 'cache-control': 'private, max-age=0' } }, 'no-store'],
		[{ headers: { 'content-type': 'text/html', 'cache-control': 'no-store' } }, 'no-store'],
	];
	for (const [over, expected] of cases) {
		assert.equal(rawCache.storeRefusal(originResource(over), policy()), expected, JSON.stringify(over));
	}
});

test('a personalized document is refused even though the sanitizer already dropped its cookie', () => {
	// `sanitizeOriginResponseHeaders` filters `set-cookie` out, so by the time a resource reaches
	// here its headers are indistinguishable from a shared response. `hadSetCookie` is the only
	// surviving evidence, and this is the test that keeps it wired.
	const resource = originResource({ hadSetCookie: true });
	assert.equal(resource.headers['set-cookie'], undefined, 'precondition: the header is already gone');
	assert.equal(rawCache.storeRefusal(resource, policy()), 'has-cookie');
});

test('no-cache is STORABLE — it means revalidate before use, not do not store', () => {
	const resource = originResource({ headers: { 'content-type': 'text/html', 'cache-control': 'no-cache' } });
	assert.equal(rawCache.storeRefusal(resource, policy()), null);
});

test('the content-type match ignores parameters and case', () => {
	for (const value of ['text/html; charset=utf-8', 'TEXT/HTML', ' text/html ']) {
		const resource = originResource({ headers: { 'content-type': value } });
		assert.equal(rawCache.storeRefusal(resource, policy()), null, value);
	}
});

// ---- stored headers --------------------------------------------------------------------------

test('content-length is dropped and content-encoding is kept', () => {
	// The body is stored in the origin's encoding and re-encoded at serve time, so the encoding is
	// load-bearing and the length is actively wrong.
	const stored = rawCache.storedHeaders(originResource().headers);
	assert.equal(stored['content-length'], undefined);
	assert.equal(stored['content-encoding'], 'gzip');
	assert.equal(stored['content-type'], 'text/html; charset=utf-8');
	assert.equal(stored['x-harper-raw'], '1');
});

test('storedHeaders tolerates a resource with no headers at all', () => {
	assert.deepEqual(rawCache.storedHeaders(undefined), { 'x-harper-raw': '1' });
});

// ---- the capture -----------------------------------------------------------------------------

test('a body under the cap is captured whole, and the crawler still gets every byte', async () => {
	const { downstream, captured } = rawCache.teeForCapture(streamOf(['<html>', 'body', '</html>']), 1024);
	const [delivered, result] = await Promise.all([drain(downstream), captured]);
	assert.equal(delivered.toString(), '<html>body</html>');
	assert.equal(result.outcome, 'ok');
	assert.equal(result.bytes.toString(), '<html>body</html>');
});

test('past the cap the capture is abandoned — and the crawler is UNAFFECTED', async () => {
	// The whole point of capping rather than refusing up front: the response is already in flight
	// when the size becomes known, so an oversize document must still be delivered in full.
	const chunks = ['a'.repeat(600), 'b'.repeat(600), 'c'.repeat(600)];
	const { downstream, captured } = rawCache.teeForCapture(streamOf(chunks), 1024);
	const [delivered, result] = await Promise.all([drain(downstream), captured]);
	assert.equal(delivered.length, 1800, 'the crawler must receive the whole oversize document');
	assert.equal(result.outcome, 'oversize');
	assert.equal(result.bytes, null, 'and nothing is retained for it');
});

test('a truncated origin body yields no capture rather than a partial document', async () => {
	const { downstream, captured } = rawCache.teeForCapture(streamOf(['<html>', 'x'], 1), 1024);
	// The crawler's branch fails on its own terms; that is not this module's business.
	await drain(downstream).catch(() => {});
	const result = await captured;
	assert.equal(result.outcome, 'capture-failed');
	assert.equal(result.bytes, null);
});

test('the capture never rejects, whatever the stream does', async () => {
	const { downstream, captured } = rawCache.teeForCapture(streamOf(['x'], 0), 1024);
	await drain(downstream).catch(() => {});
	await assert.doesNotReject(() => captured);
});

test('the capture cannot hold the crawler back: downstream completes without the capture being awaited', async () => {
	// A `tee()` buffers for the slower branch. The capture reads in a tight loop with nothing to wait
	// on, so it is always the faster one — if that ever stops being true, the crawler pays for it and
	// this test is what notices.
	const { downstream } = rawCache.teeForCapture(streamOf(['one', 'two']), 1024);
	const delivered = await drain(downstream);
	assert.equal(delivered.toString(), 'onetwo');
});

// ---- store + read round trip -----------------------------------------------------------------

test('a stored page keeps the origin bytes verbatim and is read back while fresh', async () => {
	await rawCache.storeRawPage({
		cacheKey: 'https://example.com/c|desktop',
		resource: originResource(),
		bytes: Buffer.from('GZIPPED'),
		policy: policy(),
	});

	const row = rows.get('https://example.com/c|desktop');
	assert.equal(row.statusCode, 200);
	assert.equal(row.content.bytes.toString(), 'GZIPPED');
	assert.equal(JSON.parse(row.headers)['content-encoding'], 'gzip');
	assert.equal(JSON.parse(row.headers)['content-length'], undefined);
	assert.ok(ops.includes('prerender_ops:raw_cache:stored'));

	const read = await rawCache.readRawPage('https://example.com/c|desktop');
	assert.equal(read.content.bytes.toString(), 'GZIPPED');
});

test('a write failure is counted and swallowed — a served response must not fail over a copy', async () => {
	failWrites = true;
	await assert.doesNotReject(() =>
		rawCache.storeRawPage({ cacheKey: 'k', resource: originResource(), bytes: Buffer.from('x'), policy: policy() })
	);
	assert.ok(ops.includes('prerender_ops:raw_cache:write-failed'));
});

// ---- the read: every unknown is a miss --------------------------------------------------------

test('an absent row reads as a miss', async () => {
	assert.equal(await rawCache.readRawPage('nope'), null);
});

test('an expired row reads as a miss', async () => {
	rows.set('k', { cacheKey: 'k', expiresAt: new Date(Date.now() - 1) });
	assert.equal(await rawCache.readRawPage('k'), null);
});

test('an unreadable or missing expiry reads as a miss, never as "serve it forever"', async () => {
	for (const expiresAt of [undefined, null, 'not-a-date', NaN]) {
		rows.set('k', { cacheKey: 'k', expiresAt });
		assert.equal(await rawCache.readRawPage('k'), null, String(expiresAt));
	}
});

test('a read that throws degrades to the origin proxy rather than a 500', async () => {
	assert.equal(await rawCache.readRawPage('THROWS'), null);
});

// ---- the wiring ------------------------------------------------------------------------------

test('a refused resource is returned untouched, with its body never teed', async () => {
	const resource = originResource({ statusCode: 404, content: streamOf(['nope']) });
	const out = rawCache.captureForRawCache(resource, { cacheKey: 'k', policy: policy() });
	assert.equal(out.content, resource.content, 'the original stream must be handed straight through');
	assert.ok(ops.includes('prerender_ops:raw_cache:not-200'));
	assert.equal(rows.size, 0);
});

test('a storable resource is teed, delivered in full, and eventually stored', async () => {
	const resource = originResource({ content: streamOf(['<html>ok</html>']) });
	const out = rawCache.captureForRawCache(resource, { cacheKey: 'k', policy: policy() });
	assert.notEqual(out.content, resource.content, 'the crawler must read the teed branch');

	const delivered = await drain(out.content);
	assert.equal(delivered.toString(), '<html>ok</html>');

	// The store is detached by contract, so settle the microtask queue the way the real request does.
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(rows.get('k').content.bytes.toString(), '<html>ok</html>');
});

test('a body that is not a stream is left alone rather than guessed at', () => {
	const resource = originResource({ content: 'already a string' });
	const out = rawCache.captureForRawCache(resource, { cacheKey: 'k', policy: policy() });
	assert.equal(out.content, 'already a string');
	assert.ok(ops.includes('prerender_ops:raw_cache:no-body'));
});
