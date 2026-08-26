import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * recordDemand — which requests are allowed to become demand for the render ladder.
 *
 * The ladder spends render budget on whatever this records, and it can only ever act on URLs
 * that own a Target, so both gates here are load-bearing rather than tidying. They also hold
 * down the Bloom ring's fill factor, and that failure mode is silent: the false-positive rate
 * is `fill^k`, so a saturated ring answers "visited" for everything and the ladder promotes the
 * whole corpus to its floor with no other metric moving.
 *
 * The properties pinned here:
 *   - a cache-served request is demand, and so is every status that FOUND a page row but served
 *     from the origin anyway (swr, stale, invalidated, blob-missing) — a page row exists only
 *     where a Target does, so demoting those for lack of evidence would be a false negative;
 *   - a `miss` counts only when this request is what puts the URL into the rotation: a
 *     cacheable 200 on a route that mints targets;
 *   - a miss on a discovery-gated route does NOT count (it owns no Target and never will), and
 *     neither does a non-200 (an origin 404 is not a page);
 *   - non-prerender classes never count, since they own no Target at all;
 *   - `render.demand.bots` gates on the resolved bot name.
 *
 * The assertions go through the real visitFilter rather than a stub, so a wiring change that
 * records the wrong URL — the cache key instead of the device-free URL, say — fails here.
 */

const rows = new Map();
const sabs = new Map();

let applyOptions, recordDemand;
let flushSlices, refreshMerged, visitedWithin, resetVisitFilter;

const H = 60 * 60 * 1000;
const URL_A = 'https://example.com/product/prd-1/a.jsp';

before(async () => {
	globalThis.Resource = class {};
	globalThis.server = { hostname: 'node-a', workerIndex: 1, nodes: [], config: { http: { port: 9926 } } };
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {} };
	globalThis.databases = {
		coordination: {
			SharedBuffer: {
				primaryStore: {
					getUserSharedBuffer(key, initial) {
						let buf = sabs.get(key);
						if (!buf) sabs.set(key, (buf = initial));
						return buf;
					},
					tryLock: () => true,
					unlock() {},
				},
			},
		},
		crawl_stats: {
			VisitFilter: {
				async get(id) {
					const row = rows.get(id);
					return row ? { ...row } : null;
				},
				async put(id, data) {
					rows.set(id, { id, ...data });
				},
				async delete(id) {
					rows.delete(id);
				},
				async search({ conditions = [] } = {}) {
					const out = [];
					for (const row of rows.values()) {
						const ok = conditions.every((c) =>
							c.comparator === 'less_than'
								? row.slot < c.value
								: c.comparator === 'greater_than'
									? row.slot > c.value
									: row.slot >= c.value
						);
						if (ok) out.push({ ...row });
					}
					return out;
				},
			},
		},
		render_service: { Target: class {}, QueueControl: class {} },
		render_schedule: { RenderSchedule: class {} },
		page_cache: { PrerenderedPage: class {} },
	};

	({ applyOptions } = await import('../src/config.js'));
	({ recordDemand } = await import('../src/http_handlers/bot_request.js'));
	({ flushSlices, refreshMerged, visitedWithin, resetVisitFilter } = await import('../src/util/visitFilter.js'));
});

// `applyOptions` resolves each group against the schema, so a partial `demand` block resets its
// siblings to their defaults — `enabled` back to false, which silently no-ops `recordVisit` and
// makes every assertion below pass for the wrong reason. Always send the whole group.
const setDemand = (overrides = {}) =>
	applyOptions({
		ingress: { routes: [] },
		render: {
			demand: { enabled: true, sliceMs: H, slices: 16, bitsPerSlice: 1 << 20, hashes: 7, bots: ['*'], ...overrides },
		},
	});

beforeEach(() => {
	rows.clear();
	sabs.clear();
	resetVisitFilter();
	setDemand();
});

/** Record one request, then round-trip the ring so `visitedWithin` can see it. */
async function wasRecorded(args, url = URL_A) {
	recordDemand({
		resource: { statusCode: 200 },
		routeClass: 'prerender',
		route: {},
		cacheUrl: url,
		botName: 'Googlebot',
		...args,
	});
	await flushSlices();
	await refreshMerged();
	return visitedWithin(url, 2 * H);
}

test('a cache serve is demand', async () => {
	assert.equal(await wasRecorded({ cacheStatus: 'hit' }), true);
});

test('every status that FOUND a page row is demand, even when the body came from the origin', async (t) => {
	// A page row exists only where a Target does, so these must not be treated as unvisited —
	// that is the false-negative direction, and it demotes pages that are merely late.
	for (const cacheStatus of ['swr', 'stale', 'invalidated', 'blob-missing', 'blob-timeout', 'peer-rescue']) {
		await t.test(cacheStatus, async () => {
			resetVisitFilter();
			rows.clear();
			sabs.clear();
			assert.equal(await wasRecorded({ cacheStatus, resource: { statusCode: 200 } }), true);
		});
	}
});

test('a miss counts when THIS request is what mints the target: a cacheable 200 on a minting route', async () => {
	assert.equal(await wasRecorded({ cacheStatus: 'miss', resource: { statusCode: 200 }, route: {} }), true);
});

test('a miss on a discovery-gated route is NOT demand — it owns no target and never will', async () => {
	assert.equal(
		await wasRecorded({ cacheStatus: 'miss', resource: { statusCode: 200 }, route: { discoverTargets: false } }),
		false
	);
});

test('a gated route still counts once the URL has a page row', async () => {
	// The gate stops target CREATION, not cadence: a sitemap-declared URL on a gated route is a
	// real target and must keep earning its rung.
	assert.equal(await wasRecorded({ cacheStatus: 'hit', route: { discoverTargets: false } }), true);
});

test('a missed non-200 is NOT demand — an origin 404 is not a page', async () => {
	assert.equal(await wasRecorded({ cacheStatus: 'miss', resource: { statusCode: 404 } }), false);
	assert.equal(await wasRecorded({ cacheStatus: 'miss', resource: { statusCode: 301 } }), false);
});

test('statuses that never looked for a page row cannot claim one', async () => {
	// 'bypass' is a non-GET, 'skip' a deliberate cache bypass. Neither is `miss` either — a miss
	// LOOKED and found nothing — so they take neither branch and record nothing.
	assert.equal(await wasRecorded({ cacheStatus: 'bypass', resource: { statusCode: 200 } }), false);
	assert.equal(await wasRecorded({ cacheStatus: 'skip', resource: { statusCode: 200 } }), false);
});

test('a render-now MISS still records: it looked, found nothing, and mints the target', async () => {
	// `resolveResource` stamps cacheStatus BEFORE the render-now branch, so an on-demand render
	// of an unknown URL arrives here as a plain 'miss'. Excluding it would drop genuine crawler
	// demand wherever a deployment serves misses by rendering rather than proxying.
	assert.equal(await wasRecorded({ cacheStatus: 'miss', resource: { statusCode: 200 } }), true);
});

test('a non-prerender class is never demand', async () => {
	assert.equal(await wasRecorded({ routeClass: 'passthrough', cacheStatus: 'hit' }), false);
	assert.equal(await wasRecorded({ routeClass: 'unclassified', cacheStatus: 'hit' }), false);
});

test('render.demand.bots gates the signal on the resolved bot name', async () => {
	setDemand({ bots: ['Googlebot'] });
	assert.equal(
		await wasRecorded({ cacheStatus: 'hit', botName: 'AhrefsBot' }, 'https://example.com/product/prd-2/a.jsp'),
		false
	);
	assert.equal(await wasRecorded({ cacheStatus: 'hit', botName: 'Googlebot' }), true);
});

test('the device-free URL is what gets recorded, not the cache key', async () => {
	// Cadence resolves per URL; recording per device would double the distinct count the ring
	// carries for no added resolution.
	await wasRecorded({ cacheStatus: 'hit' }, URL_A);
	assert.equal(visitedWithin(URL_A, 2 * H), true);
	assert.equal(visitedWithin(`${URL_A}|desktop`, 2 * H), false);
});
