import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyOptions, config } from '../src/config.js';
import {
	classifyPath,
	classifyUrl,
	matchRoute,
	prerenderRouteCount,
	queryAllowlistFor,
	resolveEffectiveInterval,
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

test('resolveEffectiveInterval applies the demand ladder rung the route ceiling hides', () => {
	// The gap this exists to close. A route grants a CEILING and `render.demand` promotes visited
	// targets beneath it, storing the rung on the target — so route resolution alone reports 24h for a
	// page really on 6h. Anything dividing lateness by a cadence has to divide by the rung.
	const DAY_MS = 24 * HOUR_MS;
	forwarded({
		routes: [
			{ match: 'prefix', path: '/catalog/', queryParams: ['CN'], renderInterval: DAY_MS },
			{ match: 'exact', path: '/', queryParams: [] },
		],
	});
	const catalog = 'https://www.example.com/catalog/girls.jsp';

	assert.equal(resolveRenderInterval(catalog, null), DAY_MS, 'the route ceiling, as before');
	assert.equal(
		resolveEffectiveInterval(catalog, { demandInterval: 6 * HOUR_MS }),
		6 * HOUR_MS,
		'a promoted target is on its rung, not on the ceiling'
	);

	// CLAMPED, because a rung outlives the config that produced it: lower a route's cadence and every
	// target still carries a rung from the old, slower ladder until its next render. `decideInterval`
	// clamps to the ceiling the same way, so a stale rung must not read as SLOWER than the route.
	assert.equal(
		resolveEffectiveInterval(catalog, { demandInterval: 7 * DAY_MS }),
		DAY_MS,
		'a stale rung slower than the ceiling reads as the ceiling'
	);

	// Unevaluated is most of the corpus until the ladder reaches it, and the absent forms differ:
	// `Number(null)` is 0 and `Number(undefined)` is NaN. Both must fall through, not become 0.
	for (const absent of [null, undefined, 0, -1, NaN, 'nonsense']) {
		assert.equal(resolveEffectiveInterval(catalog, { demandInterval: absent }), DAY_MS, `absent: ${absent}`);
	}
	assert.equal(resolveEffectiveInterval(catalog), DAY_MS, 'and no target at all resolves to the route');

	// Stored interval still loses to the route, and the rung still beats both — the full precedence.
	assert.equal(
		resolveEffectiveInterval(catalog, { renderInterval: 3 * DAY_MS, demandInterval: 12 * HOUR_MS }),
		12 * HOUR_MS,
		'rung > route > stored'
	);
	// A BigInt from a `Long` column, which `Number.isFinite` rejects outright without the coercion.
	assert.equal(resolveEffectiveInterval(catalog, { demandInterval: BigInt(6 * HOUR_MS) }), 6 * HOUR_MS);
});

test('route discoverTargets: false kept, an invalid value drops the FIELD but never the route', () => {
	forwarded({
		ingress: {
			routes: [
				{ match: 'prefix', path: '/catalog/', discoverTargets: false },
				{ match: 'prefix', path: '/product/prd-', discoverTargets: 'no' }, // invalid → field dropped
			],
		},
	});
	assert.equal(matchRoute('/catalog/girls.jsp').discoverTargets, false);
	// The route still classifies (a gate typo must not unroute a served path)…
	assert.equal(classifyPath('/product/prd-1').routeClass, PRERENDER);
	// …it just keeps the default: discovery allowed.
	assert.equal(matchRoute('/product/prd-1').discoverTargets, true);
});

test('route discoverTargets defaults to true and is ignored on a passthrough route', () => {
	forwarded({
		ingress: {
			routes: [
				{ match: 'prefix', path: '/catalog/' },
				{ match: 'prefix', path: '/help/', mode: 'passthrough', discoverTargets: false },
			],
		},
	});
	assert.equal(matchRoute('/catalog/x').discoverTargets, true);
	// A passthrough route never schedules, so the field is warned about and ignored.
	assert.equal(matchRoute('/help/contact-us').discoverTargets, true);
});
