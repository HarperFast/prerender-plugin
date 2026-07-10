import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
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
		route: { match: 'prefix', path: '/catalog/', queryParams: ['CN'] },
	};
	applyDebugHeaders(headers, mockRequest(), resource, info);
	assert.equal(headers.get('x-harper-device-type'), 'mobile');
	assert.equal(headers.get('x-harper-cache'), 'miss');
	assert.equal(headers.get('x-harper-source'), 'origin');
	assert.equal(headers.get('x-harper-cache-key'), 'https://x/|mobile');
	assert.equal(headers.get('x-harper-url'), 'https://x/');
	assert.equal(headers.get('x-harper-route'), 'prefix /catalog/ [CN]');
	assert.equal(headers.get('x-harper-indexable'), 'true');
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
