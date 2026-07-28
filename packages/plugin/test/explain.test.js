import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyOptions } from '../src/config.js';
import { explainCacheKey } from '../src/util/explain.js';

const ROUTES = [
	{ match: 'prefix', path: '/catalog/', queryParams: ['CN'] },
	{ match: 'prefix', path: '/product/prd-', queryParams: [] },
];

beforeEach(() => applyOptions({}));

test('prefix mode explains the key under the global allowlist', () => {
	const out = explainCacheKey('https://www.example.com/a/b?page=2&utm=x', 'mobile');

	assert.equal(out.resolved.deviceType, 'mobile');
	assert.equal(out.resolved.canonicalUrl, 'https://www.example.com/a/b?page=2');
	assert.equal(out.resolved.cacheKey, 'https://www.example.com/a/b?page=2|mobile');
	assert.deepEqual(out.allowlist.used, ['page']);
	assert.equal(out.allowlist.source, 'url.queryParams');
	// In prefix mode there is only one allowlist, so there is nothing to disagree with.
	assert.equal(out.underGlobalAllowlist.differs, false);
});

test('forwarded mode resolves the allowlist from the matched route', () => {
	applyOptions({ ingress: { mode: 'forwarded', routes: ROUTES } });

	const out = explainCacheKey('https://www.example.com/catalog/girls.jsp?CN=a&utm=x&page=2', 'desktop');

	assert.equal(out.ingress.routeClass, 'prerender');
	assert.equal(out.eligibility.prerendered, true);
	assert.equal(out.ingress.route.path, '/catalog/');
	assert.equal(out.ingress.route.source, 'ingress.routes');
	assert.deepEqual(out.allowlist.used, ['CN']);
	assert.equal(out.resolved.canonicalUrl, 'https://www.example.com/catalog/girls.jsp?CN=a');
	// The global allowlist keeps `page` instead of `CN`, so the keys diverge — this flag is
	// what points at a route problem during a permanent-cache-miss investigation.
	assert.equal(out.underGlobalAllowlist.differs, true);
	assert.equal(out.underGlobalAllowlist.canonicalUrl, 'https://www.example.com/catalog/girls.jsp?page=2');
});

test('an unmatched forwarded path keeps every param and says so', () => {
	applyOptions({ ingress: { mode: 'forwarded', routes: ROUTES } });

	const out = explainCacheKey('https://www.example.com/nope?b=2&a=1');

	assert.equal(out.ingress.routeClass, 'unclassified');
	assert.equal(out.eligibility.prerendered, false);
	assert.equal(out.ingress.route, null);
	assert.deepEqual(out.allowlist.used, ['*']);
	// '*' keeps params but still sorts them, so the key stays stable.
	assert.equal(out.resolved.canonicalUrl, 'https://www.example.com/nope?a=1&b=2');
});

test('an unsupported device type is flagged as a fallback, not silently swapped', () => {
	const out = explainCacheKey('https://www.example.com/a', 'watch');
	assert.equal(out.resolved.deviceType, 'desktop');
	assert.equal(out.resolved.deviceTypeFellBack, true);
});

test('a case-only device difference is normalization, not a fallback', () => {
	const out = explainCacheKey('https://www.example.com/a', 'Mobile');
	assert.equal(out.resolved.deviceType, 'mobile');
	assert.equal(out.resolved.deviceTypeFellBack, false);
});

test('exclude patterns and the domain allowlist are reported', () => {
	applyOptions({ domains: ['www.example.com'], excludePathPatterns: ['/search/'] });

	// An excluded path now reports as passthrough, and names the config key it came from —
	// `excludePathPatterns`, not a route someone wrote — since that is what to go and change.
	const excluded = explainCacheKey('https://www.example.com/search/q?x=1');
	assert.equal(excluded.ingress.routeClass, 'passthrough');
	assert.equal(excluded.eligibility.prerendered, false);
	assert.equal(excluded.eligibility.excludedByPattern, '/search/');
	assert.equal(excluded.eligibility.domainAllowed, true);

	const offHost = explainCacheKey('https://other.example.org/a');
	assert.equal(offHost.eligibility.domainAllowed, false);
	assert.equal(offHost.eligibility.excludedByPattern, null);
	// Prefix mode: anything not excluded is prerenderable.
	assert.equal(offHost.ingress.routeClass, 'prerender');
});

test('a passthrough route is reported as deliberate, with no exclude pattern to blame', () => {
	applyOptions({
		ingress: { mode: 'forwarded', routes: [{ match: 'prefix', path: '/orders/', mode: 'passthrough' }] },
		excludePathPatterns: [],
	});

	const out = explainCacheKey('https://www.example.com/orders/history?id=1');
	assert.equal(out.ingress.routeClass, 'passthrough');
	assert.equal(out.ingress.route.source, 'ingress.routes');
	assert.equal(out.eligibility.excludedByPattern, null);
	assert.equal(out.eligibility.prerendered, false);
	// No allowlist on a passthrough route, so the proxied URL keeps the query intact.
	assert.deepEqual(out.allowlist.used, ['*']);
});

test('an empty domains allowlist allows every host', () => {
	const out = explainCacheKey('https://anything.example.net/a');
	assert.equal(out.eligibility.domainAllowed, true);
});

test('an unparseable URL throws rather than returning a plausible-looking key', () => {
	assert.throws(() => explainCacheKey('not-a-url', 'desktop'));
	assert.throws(() => explainCacheKey('/relative/path', 'desktop'));
});
