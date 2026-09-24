/**
 * The sitemap ARRIVAL check's pure half: the route field, the rejoin test that keeps shear out, the
 * post-walk decision table, and the candidate list. The walk and the executor are exercised for real
 * against fake tables in sitemapArrivalWalk.test.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOptions, config } from '../src/config.js';
import { defaultConfig } from '../src/configSchema.js';
import { createRefreshRun } from '../src/util/sitemapRun.js';
import {
	ArrivalAction,
	arrivalActionFor,
	arrivalCandidateCap,
	decideArrival,
	isRejoin,
} from '../src/util/sitemapArrival.js';
import { anyRouteArrives, inspectRoutes, matchRoute } from '../src/util/routeClass.js';

globalThis.logger ??= { debug() {}, info() {}, warn() {}, error() {} };

const PRODUCT = 'https://site.example.com/product/prd-1';
const CATALOG = 'https://site.example.com/catalog/shoes';
const SITEMAP = 'https://site.example.com/sitemap_product_1.xml';
const WALK_START = Date.parse('2026-09-20T06:00:00Z');

const setRoutes = ({ productAction = 'render', arrival = {} } = {}) =>
	applyOptions({
		sitemap: { arrival: { enabled: true, dryRun: true, ...arrival } },
		ingress: {
			mode: 'forwarded',
			routes: [
				{
					match: 'prefix',
					path: '/product/',
					mode: 'prerender',
					...(productAction ? { arrivalAction: productAction } : {}),
				},
				{ match: 'prefix', path: '/catalog/', mode: 'prerender' },
			],
		},
	});

// ---- defaults: nothing changes until a route opts in ----

test('defaults: every route compiles to arrivalAction none, and the group ships dry-run with the departure ceilings', () => {
	const { arrival } = defaultConfig().sitemap;
	assert.deepEqual(arrival, { enabled: true, dryRun: true, maxActions: 5000, maxCandidates: 50000 });

	applyOptions({ ingress: { mode: 'forwarded', routes: [{ match: 'prefix', path: '/product/' }] } });
	assert.equal(matchRoute('/product/prd-1').arrivalAction, ArrivalAction.NONE);
	assert.equal(anyRouteArrives(), false);
	assert.equal(arrivalCandidateCap(), 0, 'nothing opted in, so the walk collects nothing');
});

// ---- the route field, validated exactly like departureAction ----

test('arrivalAction render is accepted on a prerender route and read back per URL', () => {
	setRoutes();
	assert.equal(matchRoute('/product/prd-1').arrivalAction, ArrivalAction.RENDER);
	assert.equal(arrivalActionFor(PRODUCT), ArrivalAction.RENDER);
	assert.equal(arrivalActionFor(CATALOG), ArrivalAction.NONE, 'the catalog route declares nothing');
	assert.equal(anyRouteArrives(), true);
});

test('an unrecognised arrivalAction drops the FIELD with a warning, never the route', () => {
	const { prerender, dropped, warnings } = inspectRoutes(
		[{ match: 'prefix', path: '/product/', arrivalAction: 'expire' }],
		[]
	);
	assert.equal(prerender, 1, 'the route still prerenders');
	assert.equal(dropped, 0);
	assert.ok(warnings.some((w) => w.includes('ignoring arrivalAction') && w.includes('got expire')));

	setRoutes({ productAction: 'bogus' });
	assert.equal(arrivalActionFor(PRODUCT), ArrivalAction.NONE);
	assert.equal(anyRouteArrives(), false, 'an invalid action must not switch collection on');
});

test('a passthrough route refuses arrivalAction with a warning', () => {
	const { passthrough, warnings } = inspectRoutes(
		[{ match: 'prefix', path: '/help/', mode: 'passthrough', arrivalAction: 'render' }],
		[]
	);
	assert.equal(passthrough, 1);
	assert.ok(warnings.some((w) => w.includes('ignoring arrivalAction on passthrough route')));
});

test('the master switch turns every route off without editing the route list', () => {
	setRoutes({ arrival: { enabled: false } });
	assert.equal(arrivalActionFor(PRODUCT), ArrivalAction.NONE);
	assert.equal(arrivalCandidateCap(), 0);
});

test('arrivalAction and departureAction are independent fields', () => {
	applyOptions({
		sitemap: { departure: { enabled: true }, arrival: { enabled: true } },
		ingress: { mode: 'forwarded', routes: [{ match: 'prefix', path: '/product/', departureAction: 'render' }] },
	});
	assert.equal(matchRoute('/product/prd-1').departureAction, 'render');
	assert.equal(anyRouteArrives(), false, 'arming departure does not arm arrival');
});

// ---- the rejoin test: what keeps shear out ----

test('isRejoin: a stamp from an EARLIER walk on an unattributed target is a rejoin', () => {
	assert.equal(isRejoin({ sitemapUrl: null, unlistedAt: new Date(WALK_START - 1) }, WALK_START), true);
	assert.equal(isRejoin({ sitemapUrl: null, unlistedAt: WALK_START - 86_400_000 }, WALK_START), true, 'epoch ms');
	assert.equal(isRejoin({ sitemapUrl: null, unlistedAt: new Date(WALK_START - 5).toISOString() }, WALK_START), true);
	assert.equal(isRejoin({ sitemapUrl: null, unlistedAt: BigInt(WALK_START - 5) }, WALK_START), true, 'BigInt');
});

// THE shear guard: this walk's own prune stamps exactly `run.startedAt`, so equality is shear.
test('isRejoin: a stamp equal to THIS walk’s start is this walk’s own prune — shear, not a rejoin', () => {
	assert.equal(isRejoin({ sitemapUrl: null, unlistedAt: new Date(WALK_START) }, WALK_START), false);
});

test('isRejoin: no stamp, an unreadable stamp, a still-attributed target, or no row are not rejoins', () => {
	assert.equal(isRejoin({ sitemapUrl: null }, WALK_START), false, 'discovered, or unlinked before v0.89.0');
	assert.equal(isRejoin({ sitemapUrl: null, unlistedAt: null }, WALK_START), false);
	assert.equal(isRejoin({ sitemapUrl: null, unlistedAt: 'not a date' }, WALK_START), false);
	// Attributed to a sitemap this walk has not reached yet: moving between children, not rejoining —
	// even with a (stale) stamp.
	assert.equal(isRejoin({ sitemapUrl: SITEMAP, unlistedAt: new Date(WALK_START - 1) }, WALK_START), false);
	assert.equal(isRejoin(null, WALK_START), false);
	assert.equal(isRejoin(undefined, WALK_START), false);
});

// ---- the post-walk decision table ----

test('decideArrival: a still-listed, unsuppressed target on an opted-in route renders', () => {
	setRoutes();
	assert.deepEqual(decideArrival({ url: PRODUCT, target: { url: PRODUCT, sitemapUrl: SITEMAP, state: null } }), {
		action: ArrivalAction.RENDER,
		reason: 'rejoined',
	});
});

test('decideArrival: every skip is named', () => {
	setRoutes();
	const listed = { url: PRODUCT, sitemapUrl: SITEMAP, state: null };
	assert.equal(decideArrival({ url: PRODUCT, target: null }).reason, 'target-gone');
	assert.equal(decideArrival({ url: PRODUCT, target: { ...listed, sitemapUrl: null } }).reason, 'unlinked');
	assert.equal(decideArrival({ url: PRODUCT, target: { ...listed, state: 'suppressed' } }).reason, 'suppressed');
	assert.equal(
		decideArrival({ url: CATALOG, target: { ...listed, url: CATALOG } }).reason,
		'route-opted-out',
		'a route without arrivalAction'
	);
	for (const target of [null, { ...listed, sitemapUrl: null }, { ...listed, state: 'suppressed' }]) {
		assert.equal(decideArrival({ url: PRODUCT, target }).action, ArrivalAction.NONE);
	}
});

// ---- the candidate list ----

test('arrivalCandidateCap follows sitemap.arrival.maxCandidates, -1 is Infinity, 0 is 0', () => {
	setRoutes({ arrival: { maxCandidates: 123 } });
	assert.equal(arrivalCandidateCap(), 123);
	setRoutes({ arrival: { maxCandidates: -1 } });
	assert.equal(arrivalCandidateCap(), Infinity);
	setRoutes({ arrival: { maxCandidates: 0 } });
	assert.equal(arrivalCandidateCap(), 0);
	assert.equal(config.sitemap.arrival.maxCandidates, 0);
});

test('addArrival holds up to the cap, then reports capped — and holds nothing at cap 0', () => {
	const run = createRefreshRun({ arrivalCap: 2 });
	for (let i = 0; i < 5; i++) run.addArrival(`${PRODUCT}-${i}`);
	assert.deepEqual(run.arrivalCandidates(), [`${PRODUCT}-0`, `${PRODUCT}-1`]);
	assert.deepEqual(run.snapshot().arrivals, { considered: 2, capped: true, outcomes: {} });

	const off = createRefreshRun();
	off.addArrival(PRODUCT);
	assert.deepEqual(off.snapshot().arrivals, { considered: 0, capped: false, outcomes: {} });

	const uncapped = createRefreshRun({ arrivalCap: Infinity });
	for (let i = 0; i < 60_000; i++) uncapped.addArrival(`${PRODUCT}-${i}`);
	assert.equal(uncapped.snapshot().arrivals.considered, 60_000);
	assert.equal(uncapped.snapshot().arrivals.capped, false);
});

test('the run carries the walk start it was given, and the arrival tally is separate from departures', () => {
	const run = createRefreshRun({ startedAt: WALK_START, arrivalCap: 10, departureCap: 10 });
	assert.equal(run.startedAt, WALK_START);
	run.countArrival('render');
	run.countArrival('render');
	run.countDeparture('reattached');
	assert.deepEqual(run.snapshot().arrivals.outcomes, { render: 2 });
	assert.deepEqual(run.snapshot().departures.outcomes, { reattached: 1 });
});
