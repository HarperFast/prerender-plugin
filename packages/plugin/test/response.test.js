import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { applyOptions } from '../src/config.js';

// response.js transitively imports PrerenderedPage, which extends a Harper `databases`
// binding that doesn't exist outside the runtime. Stub it, then dynamic-import so the
// stub is in place before module evaluation.
globalThis.databases = { page_cache: { PrerenderedPage: class {} } };
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

test('buildResponseHeaders copies upstream headers, drops link, sets age for a cached 200', () => {
	const resource = {
		statusCode: 200,
		headers: { 'content-type': 'text/html', 'link': '<https://x>; rel=preload', 'etag': '"abc"' },
		lastCached: new Date(Date.now() - 5000),
	};
	const headers = buildResponseHeaders(resource);
	assert.equal(headers.get('content-type'), 'text/html');
	assert.equal(headers.get('etag'), '"abc"');
	assert.equal(headers.has('link'), false);
	const age = Number(headers.get('age'));
	assert.ok(age >= 4 && age <= 7, `expected age ~5, got ${age}`);
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

// --- HEAD (RFC 9110 §9.3.2): no body, but headers identical to the GET's ---

const headRequest = (headers = {}) => ({ ...mockRequest(headers), method: 'HEAD' });

// A gzip payload so the GET half of the comparison can actually decode rather than
// erroring asynchronously on a stream that only claims to be gzip.
const gzipStream = () => {
	const gzipped = zlib.gzipSync(Buffer.from('<html>hydrated</html>'));
	return new ReadableStream({
		start(c) {
			c.enqueue(new Uint8Array(gzipped));
			c.close();
		},
	});
};

const gzipResource = () => ({
	statusCode: 200,
	miss: true,
	headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' },
	content: gzipStream(),
	url: 'https://x/',
	deviceType: 'desktop',
	cacheKey: 'https://x/|desktop',
});

test('deliverResource: a HEAD reports the encoding a GET would have returned, not the stored one', () => {
	// The live prod regression: HEAD kept the stored `content-encoding: gzip` while the GET
	// re-encoded to identity, so HEAD described a representation the GET never delivered.
	const get = deliverResource(gzipResource(), mockRequest(), {});
	const head = deliverResource(gzipResource(), headRequest(), {});

	assert.equal(head.body, undefined, 'HEAD must carry no body');
	assert.notEqual(get.body, undefined, 'GET still carries a body');

	// The whole point: identical encoding metadata for identical requests.
	assert.equal(get.headers.has('content-encoding'), false);
	assert.equal(head.headers.has('content-encoding'), false);
	assert.equal(head.headers.get('content-type'), get.headers.get('content-type'));
});

test('deliverResource: a HEAD that accepts the stored encoding keeps it', () => {
	const head = deliverResource(gzipResource(), headRequest({ 'accept-encoding': 'gzip' }), {});
	assert.equal(head.headers.get('content-encoding'), 'gzip');
	assert.equal(head.body, undefined);
});

test('deliverResource: a 304 never gains a content-encoding', () => {
	// Negotiation must not run on a response with no representation — otherwise a client
	// advertising gzip would get `content-encoding: gzip` on a bodiless 304.
	const lastCached = new Date('2026-08-01T00:00:00Z');
	const etag = `W/"${lastCached.getTime().toString(36)}"`;
	const resource = { ...gzipResource(), lastCached };

	const res = deliverResource(resource, mockRequest({ 'if-none-match': etag, 'accept-encoding': 'gzip' }), {});
	assert.equal(res.status, 304);
	assert.equal(res.body, undefined);
	assert.equal(res.headers.has('content-encoding'), false);
});

test('deliverResource: a bodiless fallback (content: null) keeps its headers untouched', () => {
	// The render-now timeout 504 has no representation at all.
	const resource = {
		miss: true,
		statusCode: 504,
		url: 'https://x/',
		deviceType: 'desktop',
		headers: {},
		content: null,
	};
	const res = deliverResource(resource, mockRequest({ 'accept-encoding': 'gzip' }), {});
	assert.equal(res.status, 504);
	assert.equal(res.headers.has('content-encoding'), false);
});

// --- Conditional-request validator synthesized from lastCached ---

test('buildResponseHeaders synthesizes a weak etag from lastCached, and no last-modified', () => {
	const lastCached = new Date('2026-08-01T00:00:00Z');
	const headers = buildResponseHeaders({ statusCode: 200, headers: { 'content-type': 'text/html' }, lastCached });

	assert.equal(headers.get('etag'), `W/"${lastCached.getTime().toString(36)}"`);
	// Deliberately absent: a date-semantic validator would flap on every re-render even when
	// the content is byte-identical.
	assert.equal(headers.has('last-modified'), false);
});

test('buildResponseHeaders never clobbers an upstream etag', () => {
	const headers = buildResponseHeaders({
		statusCode: 200,
		headers: { etag: '"from-origin"' },
		lastCached: new Date('2026-08-01T00:00:00Z'),
	});
	assert.equal(headers.get('etag'), '"from-origin"');
});

test('buildResponseHeaders omits the etag when there is no usable lastCached', () => {
	assert.equal(buildResponseHeaders({ statusCode: 200, headers: {} }).has('etag'), false);
	assert.equal(buildResponseHeaders({ statusCode: 200, headers: {}, lastCached: 'nonsense' }).has('etag'), false);
	// Not a cached 200 => no validator to offer.
	assert.equal(buildResponseHeaders({ statusCode: 404, headers: {}, lastCached: new Date() }).has('etag'), false);
});

test('the synthesized etag round-trips to a 304 for both GET and HEAD', () => {
	const lastCached = new Date('2026-08-01T00:00:00Z');
	const etag = buildResponseHeaders({ statusCode: 200, headers: {}, lastCached }).get('etag');
	const resource = { ...gzipResource(), lastCached };

	for (const request of [mockRequest({ 'if-none-match': etag }), headRequest({ 'if-none-match': etag })]) {
		const res = deliverResource({ ...resource, content: gzipStream() }, request, {});
		assert.equal(res.status, 304);
		assert.equal(res.body, undefined);
		assert.equal(res.headers.get('etag'), etag);
	}
});
