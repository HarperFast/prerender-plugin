import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyOptions, config } from '../src/config.js';
import {
	classifyPath,
	classifyUrl,
	matchRoute,
	prerenderRouteCount,
	queryAllowlistFor,
	pageTypeSettings,
	declaredPageTypes,
	routePageTypes,
	resolveRenderInterval,
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
		ingress: {
			mode: 'forwarded',
			deviceTypeSource: 'path',
			routes: ROUTES,
			excludePathPatterns: overrides.excludePathPatterns ?? [],
			...overrides.ingress,
		},
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
	applyOptions({ ingress: { excludePathPatterns: ['/search/'] } });
	assert.equal(config.ingress.mode, 'prefix');

	const normal = classifyPath('/anything/at/all');
	assert.equal(normal.routeClass, PRERENDER);
	assert.deepEqual(normal.queryParams, config.cacheKey.queryParams);

	const excluded = classifyPath('/search/q');
	assert.equal(excluded.routeClass, PASSTHROUGH);
	// Prefix mode has one global allowlist; the class decides scheduling, not the key.
	assert.deepEqual(excluded.queryParams, config.cacheKey.queryParams);
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
	assert.deepEqual(queryAllowlistFor('https://www.example.com/catalog/x'), config.cacheKey.queryParams);
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

test('classifyUrl classifies a whole URL the same way classifyPath does its path', () => {
	forwarded({ excludePathPatterns: ['/search/'] });
	for (const path of ['/', '/catalog/girls.jsp', '/help/contact-us', '/catalog/search/x']) {
		const byUrl = classifyUrl(`https://www.example.com${path}?a=1`);
		const byPath = classifyPath(path);
		assert.equal(byUrl.routeClass, byPath.routeClass, `class disagreement for ${path}`);
		assert.deepEqual(byUrl.queryParams, byPath.queryParams, `allowlist disagreement for ${path}`);
	}
});

test('classifyUrl reports an unparseable URL as unclassified, keeping all params', () => {
	forwarded();
	const result = classifyUrl('not-a-url');
	assert.equal(result.routeClass, UNCLASSIFIED);
	assert.deepEqual(result.queryParams, ['*']);
	assert.equal(result.entry, null);
});

test('classifyUrl on an unparseable URL still yields the global allowlist in prefix mode', () => {
	applyOptions({});
	assert.deepEqual(classifyUrl('not-a-url').queryParams, config.cacheKey.queryParams);
});

// ---- per-route renderInterval ----

const HOUR_MS = 3_600_000;

test('route renderInterval: valid values kept, invalid values drop the FIELD but never the route', () => {
	forwarded({
		ingress: {
			routes: [
				{ match: 'exact', path: '/', renderInterval: 2 * HOUR_MS },
				{ match: 'prefix', path: '/catalog/', renderInterval: -5 }, // invalid → field dropped
				{ match: 'prefix', path: '/product/prd-', renderInterval: 'daily' }, // invalid → field dropped
			],
		},
	});
	assert.equal(matchRoute('/').renderInterval, 2 * HOUR_MS);
	// The route still classifies (a cadence typo must not unroute a served path)…
	assert.equal(classifyPath('/catalog/girls.jsp').routeClass, PRERENDER);
	assert.equal(classifyPath('/product/prd-1').routeClass, PRERENDER);
	// …it just carries no cadence.
	assert.equal(matchRoute('/catalog/girls.jsp').renderInterval, null);
	assert.equal(matchRoute('/product/prd-1').renderInterval, null);
});

test('route renderInterval is rejected on a passthrough route (never scheduled)', () => {
	forwarded({
		ingress: { routes: [{ match: 'prefix', path: '/help/', mode: 'passthrough', renderInterval: HOUR_MS }] },
	});
	const entry = matchRoute('/help/contact-us');
	assert.equal(entry.mode, PASSTHROUGH);
	assert.equal(entry.renderInterval, null);
});

test('resolveRenderInterval precedence: route > stored > default', () => {
	forwarded({
		ingress: {
			routes: [
				{ match: 'exact', path: '/', renderInterval: 2 * HOUR_MS },
				{ match: 'prefix', path: '/catalog/' }, // no cadence → defers to stored
			],
		},
	});
	const base = 'https://www.example.com';

	// Route cadence beats a stored interval — this is what makes config changes retroactive.
	assert.equal(resolveRenderInterval(`${base}/`, 24 * HOUR_MS), 2 * HOUR_MS);
	// A route without a cadence defers to the stored (sitemap changefreq / API) value…
	assert.equal(resolveRenderInterval(`${base}/catalog/girls.jsp`, 6 * HOUR_MS), 6 * HOUR_MS);
	// …and to the default when nothing is stored or the stored value is unusable.
	assert.equal(resolveRenderInterval(`${base}/catalog/girls.jsp`, null), config.render.defaultInterval);
	assert.equal(resolveRenderInterval(`${base}/catalog/girls.jsp`, NaN), config.render.defaultInterval);
	assert.equal(resolveRenderInterval(`${base}/catalog/girls.jsp`, -1), config.render.defaultInterval);
	// An unmatched path behaves as before: stored else default.
	assert.equal(resolveRenderInterval(`${base}/unrouted`, 5 * HOUR_MS), 5 * HOUR_MS);
	assert.equal(resolveRenderInterval(`${base}/unrouted`, 0), config.render.defaultInterval);
	// A `Long` column can surface the stored interval as BigInt — it must still count.
	assert.equal(resolveRenderInterval(`${base}/catalog/girls.jsp`, BigInt(6 * HOUR_MS)), 6 * HOUR_MS);
});

test('renderInterval: null on a route entry means "not set" — no warning, defers to stored', () => {
	forwarded({ ingress: { routes: [{ match: 'prefix', path: '/catalog/', renderInterval: null }] } });
	assert.equal(matchRoute('/catalog/girls.jsp').renderInterval, null);
	assert.equal(resolveRenderInterval('https://www.example.com/catalog/girls.jsp', HOUR_MS), HOUR_MS);
});

test('a per-URL cadence exception is an exact route above its class prefix', () => {
	forwarded({
		ingress: {
			routes: [
				{ match: 'exact', path: '/catalog/hot-deals.jsp', renderInterval: HOUR_MS },
				{ match: 'prefix', path: '/catalog/', renderInterval: 6 * HOUR_MS },
			],
		},
	});
	const base = 'https://www.example.com';
	assert.equal(resolveRenderInterval(`${base}/catalog/hot-deals.jsp`, null), HOUR_MS);
	assert.equal(resolveRenderInterval(`${base}/catalog/girls.jsp`, null), 6 * HOUR_MS);
});

/* ── Page types (templates) ─────────────────────────────────────────────────────────────── */

// The shape this whole feature exists for: one template reached by two different URL shapes.
const withPageTypes = (pageTypes, routes) => applyOptions({ pageTypes, ingress: { mode: 'forwarded', routes } });

const KOHLS_SHAPED = [
	{ match: 'exact', path: '/', pageType: 'home' },
	{ match: 'prefix', path: '/catalog/', pageType: 'category' },
	{ match: 'contains', path: '/category/', pageType: 'category' },
	{ match: 'prefix', path: '/product/prd-', pageType: 'pdp' },
];

test('several routes share one page type, and the metrics label collapses onto it', () => {
	withPageTypes([], KOHLS_SHAPED);
	// Two distinct route patterns, one label — without this the two category shapes would report
	// as '/catalog/' and '/category/' and no consumer could tell they were the same template.
	assert.equal(classifyPath('/catalog/girls.jsp').pageTypeLabel, 'category');
	assert.equal(classifyPath('/shop/category/boys').pageTypeLabel, 'category');
	assert.equal(classifyPath('/').pageTypeLabel, 'home');
	assert.equal(classifyPath('/product/prd-1').pageTypeLabel, 'pdp');
});

test('pageType is the DECLARED name only; pageTypeLabel carries the fallback', () => {
	withPageTypes([], [{ match: 'prefix', path: '/catalog/' }]);
	const c = classifyPath('/catalog/girls.jsp');
	// Null name, path label. The queue job sends `pageType`, so an undeclared route must not
	// make a browser-side rule scoped to a template fire on it.
	assert.equal(c.pageType, null);
	assert.equal(c.pageTypeLabel, '/catalog/');
});

test('label falls back name -> route path -> route class', () => {
	withPageTypes(
		[],
		[
			{ match: 'prefix', path: '/named/', pageType: 'pdp' },
			{ match: 'prefix', path: '/bare/' },
		]
	);
	assert.equal(classifyPath('/named/x').pageTypeLabel, 'pdp');
	assert.equal(classifyPath('/bare/x').pageTypeLabel, '/bare/');
	// Nothing matched at all — the class is the label, and it is always a string.
	assert.equal(classifyPath('/nothing').pageTypeLabel, UNCLASSIFIED);
});

test('a deployment declaring no page types emits exactly its pre-pageTypes labels', () => {
	// The adoption guarantee: turning the feature on changes no label until a route names a type.
	forwarded();
	assert.equal(classifyPath('/catalog/girls.jsp').pageTypeLabel, '/catalog/');
	assert.equal(classifyPath('/').pageTypeLabel, '/');
	assert.equal(classifyPath('/nothing').pageTypeLabel, UNCLASSIFIED);
});

test('pageType is rejected on a passthrough route (never rendered or cached)', () => {
	withPageTypes([], [{ match: 'prefix', path: '/search/', mode: PASSTHROUGH, pageType: 'search' }]);
	const entry = matchRoute('/search/x');
	assert.equal(entry.mode, PASSTHROUGH);
	assert.equal(entry.pageType, null);
	assert.equal(classifyPath('/search/x').pageType, null);
	// It still labels by its PATH, exactly as it did before page types existed — knowing which
	// declared passthrough is absorbing traffic is worth more than one merged 'passthrough' row.
	// Only a path matching NOTHING falls all the way through to the class.
	assert.equal(classifyPath('/search/x').pageTypeLabel, '/search/');
	assert.equal(classifyPath('/nothing').pageTypeLabel, UNCLASSIFIED);
});

test('a malformed pageType drops the FIELD, never the route', () => {
	// Losing a name costs a label; dropping the entry would change how the path is SERVED.
	withPageTypes(
		[],
		[
			{ match: 'prefix', path: '/a/', pageType: '' },
			{ match: 'prefix', path: '/b/', pageType: 42 },
			{ match: 'prefix', path: '/c/', pageType: 'ok' },
		]
	);
	assert.equal(prerenderRouteCount(), 3);
	assert.equal(matchRoute('/a/x').pageType, null);
	assert.equal(matchRoute('/b/x').pageType, null);
	assert.equal(matchRoute('/c/x').pageType, 'ok');
});

test('a route may name a page type that is not declared — metrics only, no settings', () => {
	// Declaring a type is only needed to give it SETTINGS; requiring it would make naming a
	// template purely for reporting impossible.
	withPageTypes([], [{ match: 'prefix', path: '/product/', pageType: 'pdp' }]);
	assert.equal(classifyPath('/product/x').pageType, 'pdp');
	assert.equal(pageTypeSettings('pdp'), null);
	assert.equal(resolveRenderInterval('https://www.example.com/product/x', null), config.render.defaultInterval);
});

test('resolveRenderInterval precedence: route > pageType > stored > default', () => {
	withPageTypes(
		[
			{ name: 'category', renderInterval: 12 * HOUR_MS },
			{ name: 'pdp', renderInterval: 48 * HOUR_MS },
		],
		[
			// An exact route carves one URL out of its template's cadence.
			{ match: 'exact', path: '/catalog/hot-deals.jsp', pageType: 'category', renderInterval: HOUR_MS },
			{ match: 'prefix', path: '/catalog/', pageType: 'category' },
			{ match: 'contains', path: '/category/', pageType: 'category' },
			{ match: 'prefix', path: '/product/prd-', pageType: 'pdp' },
			{ match: 'prefix', path: '/misc/' }, // no type, no cadence
		]
	);
	const base = 'https://www.example.com';

	// Route beats its page type.
	assert.equal(resolveRenderInterval(`${base}/catalog/hot-deals.jsp`, 5 * HOUR_MS), HOUR_MS);
	// Page type beats the stored interval, on BOTH routes that share the type — the drift this
	// replaces: the same cadence copied onto two routes, where only the first match is observed.
	assert.equal(resolveRenderInterval(`${base}/catalog/girls.jsp`, 5 * HOUR_MS), 12 * HOUR_MS);
	assert.equal(resolveRenderInterval(`${base}/shop/category/boys`, 5 * HOUR_MS), 12 * HOUR_MS);
	assert.equal(resolveRenderInterval(`${base}/product/prd-1`, 5 * HOUR_MS), 48 * HOUR_MS);
	// A route with no type still falls through to stored, then default.
	assert.equal(resolveRenderInterval(`${base}/misc/x`, 5 * HOUR_MS), 5 * HOUR_MS);
	assert.equal(resolveRenderInterval(`${base}/misc/x`, null), config.render.defaultInterval);
});

test('a declared page type with no renderInterval defers to stored, then default', () => {
	withPageTypes([{ name: 'pdp' }], [{ match: 'prefix', path: '/product/', pageType: 'pdp' }]);
	const url = 'https://www.example.com/product/x';
	assert.equal(pageTypeSettings('pdp').renderInterval, null);
	assert.equal(resolveRenderInterval(url, 6 * HOUR_MS), 6 * HOUR_MS);
	assert.equal(resolveRenderInterval(url, null), config.render.defaultInterval);
});

test('an invalid pageType renderInterval drops the FIELD, keeping the type usable', () => {
	withPageTypes([{ name: 'pdp', renderInterval: -5 }], [{ match: 'prefix', path: '/product/', pageType: 'pdp' }]);
	assert.equal(pageTypeSettings('pdp').renderInterval, null);
	assert.equal(classifyPath('/product/x').pageTypeLabel, 'pdp'); // still labels
	assert.equal(resolveRenderInterval('https://www.example.com/product/x', null), config.render.defaultInterval);
});

test('a duplicated page-type name resolves to the last declaration', () => {
	withPageTypes(
		[
			{ name: 'pdp', renderInterval: 12 * HOUR_MS },
			{ name: 'pdp', renderInterval: 48 * HOUR_MS },
		],
		[{ match: 'prefix', path: '/product/', pageType: 'pdp' }]
	);
	assert.equal(resolveRenderInterval('https://www.example.com/product/x', null), 48 * HOUR_MS);
});

test('declaredPageTypes and routePageTypes expose both sides of the join', () => {
	// What the "declared but unreferenced" config finding is computed from.
	withPageTypes(
		[{ name: 'category' }, { name: 'orphan' }],
		[
			{ match: 'prefix', path: '/catalog/', pageType: 'category' },
			{ match: 'prefix', path: '/x/', pageType: 'ghost' },
		]
	);
	assert.deepEqual(declaredPageTypes(), ['category', 'orphan']);
	assert.deepEqual([...routePageTypes()].sort(), ['category', 'ghost']);
});

test('tolerates a non-array pageTypes value and junk entries', () => {
	withPageTypes([null, {}, { name: '' }, { name: 'ok' }], [{ match: 'prefix', path: '/a/', pageType: 'ok' }]);
	assert.deepEqual(declaredPageTypes(), ['ok']);
	assert.equal(classifyPath('/a/x').pageTypeLabel, 'ok');
});

test('prefix (native) mode still resolves page types from routes', () => {
	// Prefix mode has no route list gating ingress, but a route that names a template must still
	// label and configure it — otherwise the feature would silently be forwarded-mode-only.
	applyOptions({
		pageTypes: [{ name: 'pdp', renderInterval: 48 * HOUR_MS }],
		ingress: { mode: 'prefix', routes: [{ match: 'prefix', path: '/product/', pageType: 'pdp' }] },
	});
	assert.equal(classifyPath('/product/x').pageType, 'pdp');
	assert.equal(classifyPath('/product/x').pageTypeLabel, 'pdp');
	assert.equal(resolveRenderInterval('https://www.example.com/product/x', null), 48 * HOUR_MS);
	// A folded exclude is passthrough and carries no template.
	assert.equal(classifyPath('/other').pageType, null);
});

test('classifyUrl on an unparseable URL yields a label rather than undefined', () => {
	// Every request must produce a label or the metric develops holes that read as lost traffic.
	withPageTypes([], KOHLS_SHAPED);
	assert.equal(classifyUrl('not a url').pageTypeLabel, UNCLASSIFIED);
	assert.equal(classifyUrl('not a url').pageType, null);
});
