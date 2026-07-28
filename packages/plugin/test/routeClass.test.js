import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyOptions, config } from '../src/config.js';
import {
	classifyPath,
	matchRoute,
	prerenderRouteCount,
	queryAllowlistFor,
	PASSTHROUGH,
	PRERENDER,
	UNCLASSIFIED,
} from '../src/util/routeClass.js';

const ROUTES = [
	{ match: 'exact', path: '/', queryParams: [] },
	{ match: 'prefix', path: '/catalog/', queryParams: ['CN'] },
	{ match: 'prefix', path: '/product/prd-', queryParams: [] },
];

const forwarded = (overrides = {}) =>
	applyOptions({
		ingress: { mode: 'forwarded', deviceTypeSource: 'path', routes: ROUTES, ...overrides.ingress },
		excludePathPatterns: overrides.excludePathPatterns ?? [],
	});

beforeEach(() => forwarded());

test('honors exact vs prefix and first-match order', () => {
	assert.equal(matchRoute('/').path, '/');
	assert.equal(matchRoute('/catalog/girls.jsp').path, '/catalog/');
	assert.equal(matchRoute('/product/prd-1/x').path, '/product/prd-');
	assert.equal(matchRoute('/product/other'), null); // prd- prefix required
	assert.equal(matchRoute('/render_queue'), null); // plugin API endpoints fall through
});

test('compiles away malformed entries without dropping the rest', () => {
	forwarded({
		ingress: {
			routes: [
				{ match: 'prefix', path: '/ok/', queryParams: [] },
				{ match: 'nope', path: '/bad/' }, // invalid match
				{ match: 'exact', path: 'no-slash' }, // exact/prefix must be rooted
				{ match: 'prefix', path: '/bad-mode/', mode: 'sometimes' }, // invalid mode
				{ match: 'prefix' }, // no path
			],
		},
	});
	assert.equal(matchRoute('/ok/x').path, '/ok/');
	assert.equal(matchRoute('no-slash'), null);
	assert.equal(matchRoute('/bad-mode/x'), null);
	assert.equal(prerenderRouteCount(), 1);
});

test('mode defaults to prerender and carries the route allowlist', () => {
	const result = classifyPath('/catalog/girls.jsp');
	assert.equal(result.routeClass, PRERENDER);
	assert.deepEqual(result.queryParams, ['CN']);
	assert.equal(result.entry.mode, PRERENDER);
	assert.equal(result.entry.source, 'ingress.routes');
});

test('an unmatched path is unclassified and keeps every param', () => {
	const result = classifyPath('/help/contact-us');
	assert.equal(result.routeClass, UNCLASSIFIED);
	assert.deepEqual(result.queryParams, ['*']);
	assert.equal(result.entry, null);
});

test('a passthrough route is never given a query allowlist, even when one is configured', () => {
	// An allowlist here could only strip params off the proxied origin fetch — there is no
	// cache and therefore no key for it to shape — so it is rejected at compile time.
	forwarded({ ingress: { routes: [{ match: 'prefix', path: '/orders/', mode: 'passthrough', queryParams: ['id'] }] } });
	const result = classifyPath('/orders/history');
	assert.equal(result.routeClass, PASSTHROUGH);
	assert.deepEqual(result.queryParams, ['*']);
	assert.deepEqual(result.entry.queryParams, ['*']);
});

test('a passthrough carve-out can sit inside a prerendered prefix when ordered first', () => {
	forwarded({
		ingress: {
			routes: [
				{ match: 'prefix', path: '/catalog/clearance/', mode: 'passthrough' },
				{ match: 'prefix', path: '/catalog/', queryParams: ['CN'] },
			],
		},
	});
	assert.equal(classifyPath('/catalog/clearance/x').routeClass, PASSTHROUGH);
	assert.equal(classifyPath('/catalog/girls.jsp').routeClass, PRERENDER);
});

test('excludePathPatterns compile to passthrough entries that beat a prerender route', () => {
	forwarded({ excludePathPatterns: ['/search/'] });
	const result = classifyPath('/catalog/search/results');
	assert.equal(result.routeClass, PASSTHROUGH);
	assert.equal(result.entry.match, 'contains');
	assert.equal(result.entry.source, 'excludePathPatterns');
	// The prerender route it overlaps still applies everywhere else.
	assert.equal(classifyPath('/catalog/girls.jsp').routeClass, PRERENDER);
});

test('recompiles when excludePathPatterns changes without ingress.routes changing', () => {
	assert.equal(classifyPath('/catalog/search/x').routeClass, PRERENDER);
	forwarded({ excludePathPatterns: ['/search/'] });
	assert.equal(classifyPath('/catalog/search/x').routeClass, PASSTHROUGH);
});

test('prefix mode: everything is prerender except a folded exclude, and the allowlist is global', () => {
	applyOptions({ excludePathPatterns: ['/search/'] });
	assert.equal(config.ingress.mode, 'prefix');

	const normal = classifyPath('/anything/at/all');
	assert.equal(normal.routeClass, PRERENDER);
	assert.deepEqual(normal.queryParams, config.url.queryParams);

	const excluded = classifyPath('/search/q');
	assert.equal(excluded.routeClass, PASSTHROUGH);
	// Prefix mode has one global allowlist; the class decides scheduling, not the key.
	assert.deepEqual(excluded.queryParams, config.url.queryParams);
});

test('queryAllowlistFor agrees with classifyPath for the same path', () => {
	// The anti-drift guard: the sitemap write, discovery and redirect re-key all go through
	// queryAllowlistFor, while the read path goes through classifyPath. If these two ever
	// disagree, rendered pages get stored under a key no read computes.
	forwarded({ excludePathPatterns: ['/search/'] });
	for (const path of ['/', '/catalog/girls.jsp', '/product/prd-1', '/help/contact-us', '/catalog/search/x']) {
		assert.deepEqual(
			queryAllowlistFor(`https://www.example.com${path}`),
			classifyPath(path).queryParams,
			`disagreement for ${path}`
		);
	}
});

test('queryAllowlistFor keeps all params for an unparseable URL', () => {
	assert.deepEqual(queryAllowlistFor('not a url'), ['*']);
});

test('queryAllowlistFor returns the global allowlist in prefix mode', () => {
	applyOptions({});
	assert.deepEqual(queryAllowlistFor('https://www.example.com/catalog/x'), config.url.queryParams);
});

test('prerenderRouteCount ignores passthrough entries', () => {
	forwarded({
		ingress: {
			routes: [
				{ match: 'prefix', path: '/a/', queryParams: [] },
				{ match: 'prefix', path: '/b/', mode: 'passthrough' },
			],
		},
		excludePathPatterns: ['/search/'],
	});
	assert.equal(prerenderRouteCount(), 1);
});

test('tolerates junk in excludePathPatterns without breaking route matching', () => {
	// Non-strings are skipped before compiling, and every push is guarded, so no null entry can
	// reach the compiled list — one would throw in matchRoute on EVERY bot request.
	forwarded({ excludePathPatterns: ['', null, 42, {}, '/search/'] });
	assert.equal(classifyPath('/catalog/search/x').routeClass, PASSTHROUGH);
	assert.equal(classifyPath('/catalog/girls.jsp').routeClass, PRERENDER);
});

test('tolerates a non-array routes value', () => {
	forwarded({ ingress: { routes: 'not-an-array' } });
	assert.equal(classifyPath('/anything').routeClass, UNCLASSIFIED);
});
