import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyOptions } from '../src/config.js';
import { isForwardedMode, matchRoute, resolveForwardedRequest } from '../src/util/ingress.js';

const ROUTES = [
	{ match: 'exact', path: '/', queryParams: [] },
	{ match: 'prefix', path: '/catalog/', queryParams: ['CN'] },
	{ match: 'prefix', path: '/product/prd-', queryParams: [] },
];

// Minimal stand-in for a Harper request: a case-insensitive `headers.get` and a
// `url` that is the request target (path + query), as in the native handler.
const mockRequest = (url, headers = {}) => {
	const lower = {};
	for (const [key, value] of Object.entries(headers)) lower[key.toLowerCase()] = value;
	return { url, headers: { get: (key) => lower[key.toLowerCase()] ?? null } };
};

beforeEach(() => applyOptions({ ingress: { mode: 'forwarded', deviceTypeSource: 'path', routes: ROUTES } }));

test('isForwardedMode reflects the configured mode', () => {
	assert.equal(isForwardedMode(), true);
	applyOptions({});
	assert.equal(isForwardedMode(), false);
});

test('matchRoute honors exact vs prefix and first-match order', () => {
	assert.equal(matchRoute('/').path, '/');
	assert.equal(matchRoute('/catalog/girls.jsp').path, '/catalog/');
	assert.equal(matchRoute('/product/prd-1/x').path, '/product/prd-');
	assert.equal(matchRoute('/product/other'), null); // prd- prefix required
	assert.equal(matchRoute('/render_queue'), null); // plugin API endpoints fall through
});

test('compiles away malformed routes', () => {
	applyOptions({
		ingress: {
			mode: 'forwarded',
			routes: [
				{ match: 'prefix', path: '/ok/', queryParams: [] },
				{ match: 'nope', path: '/bad/' }, // invalid match
				{ match: 'exact', path: 'no-slash' }, // path must start with /
			],
		},
	});
	assert.equal(matchRoute('/ok/x').path, '/ok/');
	assert.equal(matchRoute('no-slash'), null);
});

test('reconstructs the absolute URL and reads the device from the path', () => {
	const req = mockRequest('/mobile/product/prd-1107/lee.jsp', { 'x-forwarded-host': 'www.kohls.com' });
	const res = resolveForwardedRequest(req);
	assert.equal(res.deviceType, 'mobile');
	assert.equal(res.url.href, 'https://www.kohls.com/product/prd-1107/lee.jsp');
	assert.equal(res.route.path, '/product/prd-');
});

test('applies the per-route query allowlist (catalog keeps only CN)', () => {
	const req = mockRequest('/desktop/catalog/girls.jsp?CN=Gender:Girls&utm=x&page=2', {
		'x-forwarded-host': 'www.kohls.com',
	});
	const res = resolveForwardedRequest(req);
	assert.equal(res.deviceType, 'desktop');
	assert.equal(res.url.hostname, 'www.kohls.com');
	assert.equal(res.url.pathname, '/catalog/girls.jsp');
	assert.equal(res.url.searchParams.get('CN'), 'Gender:Girls');
	assert.equal(res.url.searchParams.has('utm'), false);
	assert.equal(res.url.searchParams.has('page'), false);
});

test('honors x-forwarded-proto and falls back to the default protocol', () => {
	const httpReq = mockRequest('/desktop/', { 'x-forwarded-host': 'www.kohls.com', 'x-forwarded-proto': 'http' });
	assert.equal(resolveForwardedRequest(httpReq).url.protocol, 'http:');
	const defaultReq = mockRequest('/desktop/', { 'x-forwarded-host': 'www.kohls.com' });
	assert.equal(resolveForwardedRequest(defaultReq).url.protocol, 'https:');
});

test('returns null (skips) a path-mode request with no device prefix', () => {
	// upstream only prefixes bot/prerender traffic; an unprefixed path is a non-bot request
	const req = mockRequest('/render_queue', { 'x-forwarded-host': 'www.kohls.com' });
	assert.equal(resolveForwardedRequest(req), null);
});

test('path-mode request with a device prefix but no matching route resolves as noCache, keeping all query params', () => {
	// the device prefix identifies it as CDN-forwarded bot traffic; a route the CDN
	// forwarded but we haven't configured must not be dropped, only logged — and it is
	// flagged noCache with every query param preserved so the handler just proxies it
	const req = mockRequest('/mobile/help/contact-us?ref=nav&utm=x', { 'x-forwarded-host': 'www.kohls.com' });
	const res = resolveForwardedRequest(req);
	assert.notEqual(res, null);
	assert.equal(res.deviceType, 'mobile');
	assert.equal(res.route, null);
	assert.equal(res.noCache, true);
	assert.equal(res.url.pathname, '/help/contact-us');
	assert.equal(res.url.searchParams.get('ref'), 'nav');
	assert.equal(res.url.searchParams.get('utm'), 'x');
});

test('a matched route resolves with noCache false', () => {
	const req = mockRequest('/mobile/product/prd-1107/lee.jsp', { 'x-forwarded-host': 'www.kohls.com' });
	assert.equal(resolveForwardedRequest(req).noCache, false);
});

test('header-mode request with no matching route falls through (returns null)', () => {
	// no device prefix to distinguish bot traffic from the plugin's own API endpoints,
	// so route match remains the gate in header mode
	applyOptions({ ingress: { mode: 'forwarded', deviceTypeSource: 'header', routes: ROUTES } });
	const req = mockRequest('/render_queue', { 'x-forwarded-host': 'www.kohls.com', 'x-device-type': 'tablet' });
	assert.equal(resolveForwardedRequest(req), null);
});

test('returns null when the forwarded host is missing or unsafe', () => {
	assert.equal(resolveForwardedRequest(mockRequest('/desktop/catalog/x.jsp')), null);
	assert.equal(
		resolveForwardedRequest(mockRequest('/desktop/catalog/x.jsp', { 'x-forwarded-host': 'evil.com/inject' })),
		null
	);
});

test('supports header-sourced device type in forwarded mode', () => {
	applyOptions({ ingress: { mode: 'forwarded', deviceTypeSource: 'header', routes: ROUTES } });
	const req = mockRequest('/catalog/x.jsp', { 'x-forwarded-host': 'www.kohls.com', 'x-device-type': 'tablet' });
	const res = resolveForwardedRequest(req);
	assert.equal(res.deviceType, 'tablet');
	assert.equal(res.url.href, 'https://www.kohls.com/catalog/x.jsp');
});
