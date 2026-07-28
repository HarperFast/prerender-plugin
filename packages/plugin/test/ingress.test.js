import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyOptions } from '../src/config.js';
import { resolveForwardedRequest } from '../src/util/ingress.js';
import { isForwardedMode, PASSTHROUGH, PRERENDER, UNCLASSIFIED } from '../src/util/routeClass.js';

// Route matching and classification are covered in routeClass.test.js; this file covers
// turning a forwarded request into a target.
const ROUTES = [
	{ match: 'exact', path: '/', queryParams: [] },
	{ match: 'prefix', path: '/catalog/', queryParams: ['CN'] },
	{ match: 'prefix', path: '/product/prd-', queryParams: [] },
	{ match: 'prefix', path: '/orders/', mode: 'passthrough' },
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

test('reconstructs the absolute URL and reads the device from the path', () => {
	const req = mockRequest('/mobile/product/prd-1107/lee.jsp', { 'x-forwarded-host': 'www.example.com' });
	const res = resolveForwardedRequest(req);
	assert.equal(res.deviceType, 'mobile');
	assert.equal(res.url.href, 'https://www.example.com/product/prd-1107/lee.jsp');
	assert.equal(res.route.path, '/product/prd-');
	assert.equal(res.routeClass, PRERENDER);
});

test('applies the per-route query allowlist (catalog keeps only CN)', () => {
	const req = mockRequest('/desktop/catalog/girls.jsp?CN=Gender:Girls&utm=x&page=2', {
		'x-forwarded-host': 'www.example.com',
	});
	const res = resolveForwardedRequest(req);
	assert.equal(res.deviceType, 'desktop');
	assert.equal(res.url.hostname, 'www.example.com');
	assert.equal(res.url.pathname, '/catalog/girls.jsp');
	assert.equal(res.url.searchParams.get('CN'), 'Gender:Girls');
	assert.equal(res.url.searchParams.has('utm'), false);
	assert.equal(res.url.searchParams.has('page'), false);
});

test('honors x-forwarded-proto and falls back to the default protocol', () => {
	const httpReq = mockRequest('/desktop/', { 'x-forwarded-host': 'www.example.com', 'x-forwarded-proto': 'http' });
	assert.equal(resolveForwardedRequest(httpReq).url.protocol, 'http:');
	const defaultReq = mockRequest('/desktop/', { 'x-forwarded-host': 'www.example.com' });
	assert.equal(resolveForwardedRequest(defaultReq).url.protocol, 'https:');
});

test('returns null (skips) a path-mode request with no device prefix', () => {
	// upstream only prefixes bot/prerender traffic; an unprefixed path is a non-bot request
	const req = mockRequest('/render_queue', { 'x-forwarded-host': 'www.example.com' });
	assert.equal(resolveForwardedRequest(req), null);
});

test('a device-prefixed path matching no route is unclassified, and keeps all query params', () => {
	// the device prefix identifies it as CDN-forwarded bot traffic; a path the CDN forwarded
	// but we haven't declared must not be dropped, only counted — and every query param is
	// preserved so the handler proxies exactly what the visitor asked for
	const req = mockRequest('/mobile/help/contact-us?ref=nav&utm=x', { 'x-forwarded-host': 'www.example.com' });
	const res = resolveForwardedRequest(req);
	assert.notEqual(res, null);
	assert.equal(res.deviceType, 'mobile');
	assert.equal(res.route, null);
	assert.equal(res.routeClass, UNCLASSIFIED);
	assert.equal(res.url.pathname, '/help/contact-us');
	assert.equal(res.url.searchParams.get('ref'), 'nav');
	assert.equal(res.url.searchParams.get('utm'), 'x');
});

test('a passthrough route resolves for proxying, keeping all query params', () => {
	const req = mockRequest('/desktop/orders/history?id=123&page=4', { 'x-forwarded-host': 'www.example.com' });
	const res = resolveForwardedRequest(req);
	assert.equal(res.routeClass, PASSTHROUGH);
	assert.equal(res.route.path, '/orders/');
	// Nothing is stripped: a passthrough request reaches the origin as the visitor sent it.
	assert.equal(res.url.searchParams.get('id'), '123');
	assert.equal(res.url.searchParams.get('page'), '4');
});

test('header-mode: an unclassified path falls through, but a passthrough route proxies', () => {
	// No device prefix to distinguish bot traffic from the plugin's own API endpoints, so an
	// unclassified path must fall through to them — which makes a passthrough route the only
	// way to proxy a non-prerendered path in this mode.
	applyOptions({ ingress: { mode: 'forwarded', deviceTypeSource: 'header', routes: ROUTES } });
	const headers = { 'x-forwarded-host': 'www.example.com', 'x-device-type': 'tablet' };

	assert.equal(resolveForwardedRequest(mockRequest('/render_queue', headers)), null);

	const proxied = resolveForwardedRequest(mockRequest('/orders/history', headers));
	assert.equal(proxied.routeClass, PASSTHROUGH);
	assert.equal(proxied.deviceType, 'tablet');
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
	const req = mockRequest('/catalog/x.jsp', { 'x-forwarded-host': 'www.example.com', 'x-device-type': 'tablet' });
	const res = resolveForwardedRequest(req);
	assert.equal(res.deviceType, 'tablet');
	assert.equal(res.url.href, 'https://www.example.com/catalog/x.jsp');
});
