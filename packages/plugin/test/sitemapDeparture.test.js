import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOptions } from '../src/config.js';
import { createRefreshRun } from '../src/util/sitemapRun.js';
import { decideDeparture, DepartureAction, departureActionFor } from '../src/util/sitemapDeparture.js';
import { anyRouteDeparts } from '../src/util/routeClass.js';

globalThis.logger ??= { debug() {}, info() {}, warn() {}, error() {} };

const PRODUCT = 'https://site.example.com/product/prd-1/thing.jsp';
const CATALOG = 'https://site.example.com/catalog/shoes.jsp';
const SITEMAP = 'https://site.example.com/sitemap_product_1.xml';

// Routes are only consulted in forwarded mode, which is also the mode a real deployment declares
// them in. `departureAction` is set on products and deliberately NOT on the catalog route.
const setRoutes = ({ productAction = 'render', enabled = true } = {}) =>
	applyOptions({
		sitemap: { departure: { enabled, dryRun: true, maxActions: 5000, maxCandidates: 50000 } },
		ingress: {
			mode: 'forwarded',
			routes: [
				{
					match: 'prefix',
					path: '/product/',
					mode: 'prerender',
					...(productAction ? { departureAction: productAction } : {}),
				},
				{ match: 'prefix', path: '/catalog/', mode: 'prerender' },
			],
		},
	});

const target = (over = {}) => ({ url: PRODUCT, sitemapUrl: null, state: null, ...over });

test('a route that opts in departs; one that does not is left alone', () => {
	setRoutes();
	assert.equal(departureActionFor(PRODUCT), DepartureAction.RENDER);
	// The catalog route declares nothing, so catalog pages keep serving through a re-bucketing.
	assert.equal(departureActionFor(CATALOG), DepartureAction.NONE);
});

test('the master switch turns every route off without editing the route list', () => {
	setRoutes({ enabled: false });
	assert.equal(departureActionFor(PRODUCT), DepartureAction.NONE);
});

// compileEntry drops a bad value and warns, exactly as it does for renderInterval/demandFloor: a
// typo must cost that route its departure check, never change how the path is SERVED.
test('an unrecognised action is dropped at compile time and reads as none', () => {
	setRoutes({ productAction: 'delete-it' });
	assert.equal(departureActionFor(PRODUCT), DepartureAction.NONE);
	assert.equal(anyRouteDeparts(), false, 'an invalid action must not keep the feature switched on');
});

test('the expire action is accepted as well as render', () => {
	setRoutes({ productAction: 'expire' });
	assert.equal(departureActionFor(PRODUCT), DepartureAction.EXPIRE);
});

test('a URL on no route at all never departs', () => {
	setRoutes();
	assert.equal(departureActionFor('https://site.example.com/help/returns'), DepartureAction.NONE);
});

// THE load-bearing guard: a URL that shifted to a later child of a paginated index is pruned
// before the child that now claims it is reached, so mid-walk it looks exactly like a departure.
test('a re-attached target is dropped, not acted on', () => {
	setRoutes();
	const decision = decideDeparture({ url: PRODUCT, target: target({ sitemapUrl: SITEMAP }) });
	assert.equal(decision.action, DepartureAction.NONE);
	assert.equal(decision.reason, 'reattached');
});

test('a genuinely departed target takes its route action', () => {
	setRoutes();
	const decision = decideDeparture({ url: PRODUCT, target: target() });
	assert.equal(decision.action, DepartureAction.RENDER);
	assert.equal(decision.reason, 'departed');
});

test('a target retired between the prune and the check is a no-op', () => {
	setRoutes();
	assert.deepEqual(decideDeparture({ url: PRODUCT, target: null }), {
		action: DepartureAction.NONE,
		reason: 'target-gone',
	});
});

// A suppressed target has no pages to expire and owns a recheck cadence; filing it due now would
// fight that schedule.
test('a suppressed target is left to its own recheck', () => {
	setRoutes();
	const decision = decideDeparture({ url: PRODUCT, target: target({ state: 'suppressed' }) });
	assert.equal(decision.action, DepartureAction.NONE);
	assert.equal(decision.reason, 'suppressed');
});

test('a departed catalog URL is skipped with a reason, not silently omitted', () => {
	setRoutes();
	const decision = decideDeparture({ url: CATALOG, target: target({ url: CATALOG }) });
	assert.equal(decision.action, DepartureAction.NONE);
	assert.equal(decision.reason, 'route-opted-out');
});

test('anyRouteDeparts gates the whole feature off the raw route list', () => {
	setRoutes();
	assert.equal(anyRouteDeparts(), true);
	setRoutes({ productAction: null });
	assert.equal(anyRouteDeparts(), false, 'no route opting in means no candidates are ever collected');
});

// ---- the run accumulator ----

test('candidates are collected independently of the removed SAMPLE cap', () => {
	// The bug this pins: the sample loop used to `break` at removedSampleCap, which would have
	// truncated the candidate list to the sample size — 20 candidates out of thousands, reported as
	// if that were every departure.
	const run = createRefreshRun({ removedSampleCap: 2, departureCap: 10 });
	run.addRemoved([1, 2, 3, 4, 5].map((n) => ({ url: `https://site.example.com/p/${n}` })));

	const snapshot = run.snapshot();
	assert.equal(snapshot.removed, 5, 'the count is always exact');
	assert.equal(snapshot.removedSample.length, 2, 'the sample stays capped');
	assert.equal(run.departureCandidates().length, 5, 'every departure is still a candidate');
});

test('a capped candidate list says so rather than under-reporting', () => {
	const run = createRefreshRun({ departureCap: 2 });
	run.addRemoved([1, 2, 3, 4].map((n) => ({ url: `https://site.example.com/p/${n}` })));

	assert.equal(run.departureCandidates().length, 2);
	assert.equal(run.snapshot().departures.capped, true);
	assert.equal(run.snapshot().removed, 4, 'the true departure count is never capped');
});

test('departureCap 0 collects nothing, so an opted-out deployment allocates nothing', () => {
	const run = createRefreshRun({ departureCap: 0 });
	run.addRemoved([{ url: PRODUCT }]);
	assert.equal(run.departureCandidates().length, 0);
	assert.equal(run.snapshot().departures.capped, false, 'not collecting is not the same as overflowing');
});

test('outcomes are tallied by name', () => {
	const run = createRefreshRun({ departureCap: 10 });
	run.countDeparture('render');
	run.countDeparture('render');
	run.countDeparture('reattached');
	assert.deepEqual(run.snapshot().departures.outcomes, { render: 2, reattached: 1 });
});
