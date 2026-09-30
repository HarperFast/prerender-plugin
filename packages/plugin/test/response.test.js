import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyOptions } from '../src/config.js';

// response.js transitively imports PrerenderedPage, which extends a Harper `databases`
// binding that doesn't exist outside the runtime. Stub it, then dynamic-import so the
// stub is in place before module evaluation.
globalThis.databases = { page_cache: { PrerenderedPage: class {} } };
// metrics.serveError() emits through the Harper `server` global; capture instead of stubbing
// it away, so the tests can assert the failure is COUNTED as well as non-destructive.
const emitted = [];
globalThis.server ??= { hostname: 'test-node', recordAnalytics: (...a) => emitted.push(a) };
const { buildResponseHeaders, applyDebugHeaders, applyConditional, negotiateEncoding, deliverResource } = await import(
	'../src/http_handlers/response.js'
);

// Minimal stand-in for a Harper request: a case-insensitive `headers.get`.
const mockRequest = (headers = {}) => {
	const lower = {};
	for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = value;
	return { headers: { get: (key) => lower[key.toLowerCase()] ?? null } };
};

beforeEach(() => applyOptions({}));

test('buildResponseHeaders copies upstream headers, drops link by default, sets age for a cached 200', () => {
	const resource = {
		statusCode: 200,
		headers: { 'content-type': 'text/html', 'link': '<https://x>; rel=canonical', 'etag': '"abc"' },
		lastCached: new Date(Date.now() - 5000),
	};
	const headers = buildResponseHeaders(resource);
	assert.equal(headers.get('content-type'), 'text/html');
	assert.equal(headers.get('etag'), '"abc"');
	assert.equal(headers.has('link'), false, 'off until stored rows are sampled (page.serveLinkHeader)');
	const age = Number(headers.get('age'));
	assert.ok(age >= 4 && age <= 7, `expected age ~5, got ${age}`);
});

test('page.serveLinkHeader: true serves the stored Link', () => {
	applyOptions({ page: { serveLinkHeader: true } });
	const headers = buildResponseHeaders({ statusCode: 200, headers: { link: '<https://x>; rel=canonical' } }, true);
	assert.equal(headers.get('link'), '<https://x>; rel=canonical');
});

test('a newline-joined stored header (puppeteer joins repeats with \\n) is served as its separate values', () => {
	// Headers.append throws on a newline, so before this a page whose origin sent two x-robots-tag, vary,
	// cache-control or link headers lost that header on EVERY cache serve, with an error log each time.
	applyOptions({ page: { serveLinkHeader: true } });
	const logged = [];
	globalThis.logger = {
		error: (...a) => logged.push(a),
		warn: (...a) => logged.push(a),
		info() {},
		debug() {},
		trace() {},
	};
	emitted.length = 0;
	const stored = JSON.stringify({
		'x-robots-tag': 'noarchive\nmax-snippet:50',
		'vary': 'Accept-Encoding\r\nUser-Agent',
		'link': '<https://www.example.com/p>; rel=canonical\n<https://www.example.com/fr/p>; rel=alternate; hreflang=fr',
	});
	for (let i = 0; i < 3; i++) {
		const headers = buildResponseHeaders({ statusCode: 200, headers: stored }, true);
		assert.equal(headers.get('x-robots-tag'), 'noarchive, max-snippet:50');
		assert.equal(headers.get('vary'), 'Accept-Encoding, User-Agent');
		assert.equal(
			headers.get('link'),
			'<https://www.example.com/p>; rel=canonical, <https://www.example.com/fr/p>; rel=alternate; hreflang=fr'
		);
	}
	assert.deepEqual(logged, [], 'nothing to report: every value was served');
	assert.equal(emitted.filter((a) => a[3] === 'bad-header').length, 0);
});

test('a header no response may carry is dropped, COUNTED per serve, and logged at most once a minute', () => {
	const logged = [];
	globalThis.logger = {
		error: (...a) => logged.push(a),
		warn: (...a) => logged.push(a),
		info() {},
		debug() {},
		trace() {},
	};
	emitted.length = 0;
	for (let i = 0; i < 5; i++) {
		const headers = buildResponseHeaders({
			statusCode: 200,
			headers: { 'x-bad': 'a\u0000b', 'content-type': 'text/html' },
		});
		assert.equal(headers.get('content-type'), 'text/html', 'the rest of the response is unaffected');
		assert.equal(headers.has('x-bad'), false);
	}
	assert.equal(emitted.filter((a) => a[1] === 'prerender_ops' && a[3] === 'bad-header').length, 5);
	assert.equal(logged.length, 1, 'one log line for five serves, not one per request');
});

test("by default a snapshot carries NO validators — neither the origin document's nor its own — and never 304s", () => {
	// The default: a site whose origin sends no validators keeps serving crawlers exactly that. Turning
	// them on starts crawlers revalidating and this cache answering 304s, so it is a decision, not a default.
	const lastCached = Date.UTC(2026, 8, 29, 12, 0, 0, 100);
	const stored = { 'etag': '"origin"', 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT', 'content-type': 'text/html' };
	const headers = buildResponseHeaders({ statusCode: 200, headers: stored, lastCached }, true, 'desktop');
	assert.equal(headers.has('etag'), false);
	assert.equal(headers.has('last-modified'), false);
	assert.equal(headers.get('content-type'), 'text/html');
	assert.ok(headers.has('age'), 'age is not a validator and is still set');
	// Every conditional shape a crawler could send gets the full snapshot: the origin's tag, a tag from a
	// release that did send ours, and dates either side of the render.
	for (const conditional of [
		{ 'if-none-match': '"origin"' },
		{ 'if-none-match': `W/"${lastCached}-desktop"` },
		{ 'if-modified-since': new Date(lastCached + 60_000).toUTCString() },
		{ 'if-modified-since': 'Mon, 01 Jan 2024 00:00:00 GMT' },
	]) {
		for (const source of ['cache', 'rendered']) {
			const res = deliverResource(
				{ statusCode: 200, headers: JSON.stringify(stored), lastCached, deviceType: 'desktop' },
				{ ...mockRequest(conditional), method: 'GET' },
				{ source, cachedBody: Buffer.from('snapshot') }
			);
			assert.equal(res.status, 200, `${source} ${JSON.stringify(conditional)}`);
			assert.equal(res.headers.has('etag'), false);
			assert.equal(res.headers.has('last-modified'), false);
		}
	}
});

test('page.snapshotValidators: a snapshot carries W/"<lastCachedMs>-<device>" and Last-Modified from lastCached, never the origin validators', () => {
	applyOptions({ page: { snapshotValidators: true } });
	const lastCached = Date.UTC(2026, 8, 29, 12, 0, 0, 100);
	const stored = { 'etag': '"origin"', 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' };
	const desktop = buildResponseHeaders({ statusCode: 200, headers: stored, lastCached }, true, 'desktop');
	assert.equal(desktop.get('etag'), `W/"${lastCached}-desktop"`);
	assert.equal(desktop.get('last-modified'), new Date(lastCached).toUTCString());
	// One render job stamps the SAME lastCached on every device variant; the bytes differ, so must the tag.
	const mobile = buildResponseHeaders({ statusCode: 200, headers: stored, lastCached }, true, 'mobile');
	assert.notEqual(mobile.get('etag'), desktop.get('etag'));
});

test('page.snapshotValidators: a stored page row with no device column takes the device off its cache key', () => {
	applyOptions({ page: { snapshotValidators: true } });
	const lastCached = Date.UTC(2026, 8, 29, 12, 0, 0, 100);
	const row = (device) => ({
		statusCode: 200,
		headers: '{}',
		lastCached,
		cacheKey: `https://www.example.com/p|${device}`,
	});
	const desktop = deliverResource(
		row('desktop'),
		{ ...mockRequest(), method: 'GET' },
		{ source: 'cache', cachedBody: Buffer.from('d') }
	);
	assert.equal(desktop.headers.get('etag'), `W/"${lastCached}-desktop"`);
	const mobile = deliverResource(
		row('mobile'),
		{ ...mockRequest({ 'if-none-match': desktop.headers.get('etag') }), method: 'GET' },
		{
			source: 'cache',
			cachedBody: Buffer.from('m'),
		}
	);
	assert.equal(mobile.status, 200);
});

test("page.snapshotValidators: one device's snapshot ETag does not revalidate another device's snapshot of the same render", () => {
	applyOptions({ page: { snapshotValidators: true } });
	const lastCached = Date.UTC(2026, 8, 29, 12, 0, 0, 100);
	const page = { statusCode: 200, headers: '{}', lastCached };
	const desktopTag = buildResponseHeaders(page, true, 'desktop').get('etag');
	const asMobile = deliverResource(
		page,
		{ ...mockRequest({ 'if-none-match': desktopTag }), method: 'GET' },
		{
			source: 'cache',
			deviceType: 'mobile',
			cachedBody: Buffer.from('mobile bytes'),
		}
	);
	assert.equal(asMobile.status, 200);
	const asDesktop = deliverResource(
		page,
		{ ...mockRequest({ 'if-none-match': desktopTag }), method: 'GET' },
		{
			source: 'cache',
			deviceType: 'desktop',
			cachedBody: Buffer.from('desktop bytes'),
		}
	);
	assert.equal(asDesktop.status, 304);
});

test('page.snapshotValidators: the snapshot ETag decides revalidation: a same-second re-render is a 200, the same render a 304', () => {
	applyOptions({ page: { snapshotValidators: true } });
	// If-Modified-Since alone cannot tell two renders inside one second apart (HTTP dates are seconds), and
	// the date was stamped by whichever node rendered. If-None-Match takes precedence and names the render.
	const base = Date.UTC(2026, 8, 29, 12, 0, 0);
	const first = buildResponseHeaders({ statusCode: 200, headers: {}, lastCached: base + 100 }, true);
	const validators = { 'if-none-match': first.get('etag'), 'if-modified-since': first.get('last-modified') };
	const rerender = deliverResource(
		{ statusCode: 200, headers: '{}', lastCached: base + 900 },
		{ ...mockRequest(validators), method: 'GET' },
		{ source: 'cache', cachedBody: Buffer.from('new') }
	);
	assert.equal(rerender.status, 200);
	const same = deliverResource(
		{ statusCode: 200, headers: '{}', lastCached: base + 100 },
		{ ...mockRequest(validators), method: 'GET' },
		{ source: 'cache', cachedBody: Buffer.from('old') }
	);
	assert.equal(same.status, 304);
	assert.equal(same.headers.get('etag'), `W/"${base + 100}-"`);
});

test('a proxy that found a page row it would not serve skips the local conditional', () => {
	// The crawler's If-Modified-Since is our render time; the origin's Last-Modified is a template mtime.
	// Compared locally they answered 304 for a page the probe had just expired.
	const ims = new Date(Date.now() - 3_600_000).toUTCString();
	let released = 0;
	const origin = {
		miss: true,
		statusCode: 200,
		headers: { 'etag': '"new-hash"', 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' },
		content: 'NEW BODY',
		releaseBody: () => released++,
	};
	const refused = deliverResource(
		origin,
		{ ...mockRequest({ 'if-modified-since': ims }), method: 'GET' },
		{
			source: 'origin',
			cacheStatus: 'stale',
			stripConditionals: true,
		}
	);
	assert.equal(refused.status, 200);
	assert.equal(released, 0, 'the body is sent, not released');
	// A true miss keeps ordinary conditional handling against the origin's validators.
	const miss = deliverResource(
		origin,
		{ ...mockRequest({ 'if-modified-since': ims }), method: 'GET' },
		{
			source: 'origin',
			cacheStatus: 'miss',
		}
	);
	assert.equal(miss.status, 304);
	assert.equal(released, 1);
});

test('buildResponseHeaders omits age unless it is a cached 200', () => {
	assert.equal(buildResponseHeaders({ statusCode: 200, headers: {} }).has('age'), false);
	assert.equal(buildResponseHeaders({ statusCode: 404, headers: {}, lastCached: new Date() }).has('age'), false);
});

test('applyConditional downgrades to 304 on a matching etag, keeping only allowed headers', () => {
	const headers = new Headers({ 'etag': '"v1"', 'content-type': 'text/html', 'cache-control': 'max-age=60' });
	const res = applyConditional(200, headers, mockRequest({ 'if-none-match': '"v1"' }), 'BODY');
	assert.equal(res.status, 304);
	assert.equal(res.body, undefined);
	assert.equal(res.headers.get('etag'), '"v1"');
	assert.equal(res.headers.get('cache-control'), 'max-age=60');
	assert.equal(res.headers.has('content-type'), false); // not in the 304 allowlist
});

test('applyConditional downgrades when if-modified-since is at/after last-modified', () => {
	const headers = new Headers({ 'last-modified': new Date('2026-01-01T00:00:00Z').toUTCString() });
	const req = mockRequest({ 'if-modified-since': new Date('2026-01-02T00:00:00Z').toUTCString() });
	assert.equal(applyConditional(200, headers, req, 'B').status, 304);
});

test('applyConditional matches weak etags, comma-lists, and the * wildcard (RFC 7232)', () => {
	// weak validator: W/"v1" request tag matches a strong "v1" response etag
	const weak = applyConditional(200, new Headers({ etag: '"v1"' }), mockRequest({ 'if-none-match': 'W/"v1"' }), 'B');
	assert.equal(weak.status, 304);

	// comma-separated list containing the etag
	const list = applyConditional(
		200,
		new Headers({ etag: '"v2"' }),
		mockRequest({ 'if-none-match': '"v1", "v2"' }),
		'B'
	);
	assert.equal(list.status, 304);

	// wildcard matches any existing representation
	const star = applyConditional(200, new Headers({ etag: '"v9"' }), mockRequest({ 'if-none-match': '*' }), 'B');
	assert.equal(star.status, 304);
});

test('applyConditional ignores if-modified-since when if-none-match is present but unmatched (RFC 7232)', () => {
	const headers = new Headers({
		'etag': '"v1"',
		'last-modified': new Date('2026-01-01T00:00:00Z').toUTCString(),
	});
	// if-none-match does not match => must NOT fall through to the (matching) if-modified-since
	const req = mockRequest({
		'if-none-match': '"other"',
		'if-modified-since': new Date('2026-01-02T00:00:00Z').toUTCString(),
	});
	const res = applyConditional(200, headers, req, 'B');
	assert.equal(res.status, 200);
	assert.equal(res.body, 'B');
});

test('applyConditional passes through on no match or a non-200 status', () => {
	const noMatch = applyConditional(200, new Headers({ etag: '"v1"' }), mockRequest({ 'if-none-match': '"v2"' }), 'B');
	assert.equal(noMatch.status, 200);
	assert.equal(noMatch.body, 'B');

	const non200 = applyConditional(500, new Headers(), mockRequest({ 'if-none-match': '"v1"' }), 'B');
	assert.equal(non200.status, 500);
	assert.equal(non200.body, 'B');
});

test('applyDebugHeaders emits x-harper-* from the resource and info', () => {
	const headers = new Headers();
	const resource = { deviceType: 'mobile', isIndexable: true, cacheKey: 'https://x/|mobile' };
	const info = {
		cacheStatus: 'miss',
		source: 'origin',
		cacheKey: 'https://x/|mobile',
		url: 'https://x/',
		routeClass: 'prerender',
		route: { match: 'prefix', path: '/catalog/', mode: 'prerender', queryParams: ['CN'], source: 'ingress.routes' },
	};
	applyDebugHeaders(headers, mockRequest(), resource, info);
	assert.equal(headers.get('x-harper-device-type'), 'mobile');
	assert.equal(headers.get('x-harper-cache'), 'miss');
	assert.equal(headers.get('x-harper-source'), 'origin');
	assert.equal(headers.get('x-harper-cache-key'), 'https://x/|mobile');
	assert.equal(headers.get('x-harper-url'), 'https://x/');
	assert.equal(headers.get('x-harper-route-class'), 'prerender');
	assert.equal(headers.get('x-harper-route'), 'prefix /catalog/ [CN] prerender (ingress.routes)');
	assert.equal(headers.get('x-harper-indexable'), 'true');
});

test('applyDebugHeaders emits the route class even with no matched route', () => {
	// The unclassified case is exactly the one worth seeing in a response header.
	const headers = new Headers();
	applyDebugHeaders(headers, mockRequest(), { cacheKey: 'https://x/|mobile' }, { routeClass: 'unclassified' });
	assert.equal(headers.get('x-harper-route-class'), 'unclassified');
	assert.equal(headers.get('x-harper-route'), null);
});

test('applyDebugHeaders falls back to the cache-key device type', () => {
	const headers = new Headers();
	applyDebugHeaders(headers, mockRequest(), { cacheKey: 'https://x/|tablet' }, {});
	assert.equal(headers.get('x-harper-device-type'), 'tablet');
});

test('negotiateEncoding leaves the body untouched when the encoding already matches', () => {
	const headers = new Headers({ 'content-encoding': 'gzip', 'content-length': '10' });
	const body = 'UNCHANGED';
	const out = negotiateEncoding(body, headers, mockRequest({ 'accept-encoding': 'gzip' }));
	assert.equal(out, body);
	assert.equal(headers.get('content-encoding'), 'gzip');
	assert.equal(headers.get('content-length'), '10');
});

test('negotiateEncoding re-encodes and rewrites headers when the encoding differs', () => {
	const headers = new Headers({ 'content-length': '3' }); // no content-encoding => srcEncoding null
	const webStream = new ReadableStream({
		start(c) {
			c.enqueue(new Uint8Array([1, 2, 3]));
			c.close();
		},
	});
	const out = negotiateEncoding(webStream, headers, mockRequest({ 'accept-encoding': 'gzip' }));
	assert.notEqual(out, webStream); // re-encoded through gzip
	assert.equal(headers.get('content-encoding'), 'gzip');
	assert.equal(headers.has('content-length'), false); // length invalidated by re-encode
});

test('deliverResource gates debug headers on the debug request header, and reports wasCacheMiss', () => {
	const resource = {
		statusCode: 200,
		miss: true,
		headers: { 'content-type': 'text/html' },
		content: undefined,
		url: 'https://x/',
		deviceType: 'mobile',
		cacheKey: 'https://x/|mobile',
	};

	const plain = deliverResource(resource, mockRequest(), { source: 'origin' });
	assert.equal(plain.status, 200);
	assert.equal(plain.wasCacheMiss, true);
	assert.equal(plain.headers.has('x-harper-source'), false);

	const debug = deliverResource(resource, mockRequest({ 'x-harper-prerender-debug': 'true' }), { source: 'origin' });
	assert.equal(debug.headers.get('x-harper-source'), 'origin');
});

// ── cache-served bodies are materialized before the response commits ───────────────────────
// Regression cover for prerender-plugin#75 / harper#2134: a record whose blob file is gone used
// to be discovered only mid-stream, after the 200 and the bot_serve hit row were committed, so
// the crawler got a truncated document under a success status.

test('deliverResource sends info.cachedBody in preference to resource.content', () => {
	const resource = {
		statusCode: 200,
		miss: false,
		headers: { 'content-type': 'text/html' },
		content: 'SHOULD-NOT-BE-USED',
		cacheKey: 'https://x/|desktop',
	};
	const out = deliverResource(resource, mockRequest(), { cachedBody: Buffer.from('MATERIALIZED') });
	assert.equal(out.status, 200);
	assert.equal(out.body.toString(), 'MATERIALIZED');
});

test('deliverResource still sends resource.content when no body was materialized', () => {
	const resource = {
		statusCode: 200,
		miss: true,
		headers: { 'content-type': 'text/html' },
		content: 'ORIGIN-STREAM',
		cacheKey: 'https://x/|desktop',
	};
	assert.equal(deliverResource(resource, mockRequest(), {}).body, 'ORIGIN-STREAM');
});

test('deliverResource sends no body for HEAD even when one was materialized', () => {
	const resource = { statusCode: 200, miss: false, headers: {}, content: 'X', cacheKey: 'https://x/|desktop' };
	const req = { ...mockRequest(), method: 'HEAD' };
	assert.equal(deliverResource(resource, req, { cachedBody: Buffer.from('Y') }).body, undefined);
});

test('deliverResource does NOT delete the record when a residual Blob stream errors', async () => {
	// The delete replicated, so one node's unreadable blob evicted the page on every node —
	// including peers holding readable bytes — and scheduled no repair.
	let deleted = 0;
	globalThis.databases.page_cache.PrerenderedPage.delete = () => deleted++;

	class FakeBlob extends Blob {
		on(event, handler) {
			if (event === 'error') setImmediate(() => handler(new Error('Blob file not found')));
			return this;
		}
		stream() {
			return new ReadableStream({ start: (c) => c.close() });
		}
	}
	const resource = {
		statusCode: 200,
		miss: false,
		headers: {},
		content: new FakeBlob(['x']),
		cacheKey: 'https://x/|desktop',
	};
	emitted.length = 0;
	deliverResource(resource, mockRequest(), {});
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(deleted, 0, 'a blob delivery error must not evict the replicated record');
	assert.ok(
		emitted.some((a) => a[1] === 'prerender_ops' && a[3] === 'blob-stream'),
		'the failure must still be counted'
	);
});

test('negotiateEncoding passes a Node Readable through instead of wrapping the stream object', async () => {
	// Readable.from([stream]) would emit the STREAM OBJECT as one chunk, silently corrupting the
	// response. Not reachable from upstream.js today (it hands over a web stream), but it holds a
	// Node Readable and converts it only for this call.
	const { Readable } = await import('node:stream');
	const { gzipSync } = await import('node:zlib');
	const headers = new Headers({ 'content-encoding': 'gzip' });
	const req = mockRequest({ 'accept-encoding': 'identity' });
	const out = negotiateEncoding(Readable.from([gzipSync(Buffer.from('node stream body'))]), headers, req);
	const chunks = [];
	for await (const chunk of out) chunks.push(chunk);
	assert.equal(Buffer.concat(chunks).toString(), 'node stream body');
});

test('negotiateEncoding decompresses a Buffer body rather than iterating it byte-by-byte', async () => {
	// The cache path hands in a Buffer. `Readable.from(buffer)` would emit individual byte NUMBERS,
	// so gunzip would receive garbage; the body must be wrapped as a single chunk. Verified by
	// round-tripping real gzip bytes through the identity negotiation and reading them back.
	const { gzipSync } = await import('node:zlib');
	const headers = new Headers({ 'content-encoding': 'gzip', 'content-length': '99' });
	const req = mockRequest({ 'accept-encoding': 'identity' });
	const out = negotiateEncoding(gzipSync(Buffer.from('hello cached page')), headers, req);
	assert.equal(headers.has('content-length'), false, 'a re-encode invalidates the stored length');
	assert.equal(headers.has('content-encoding'), false, 'identity means no content-encoding');
	const chunks = [];
	for await (const chunk of out) chunks.push(chunk);
	assert.equal(Buffer.concat(chunks).toString(), 'hello cached page');
});
