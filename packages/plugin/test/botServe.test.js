import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * recordServeOutcome — the serve-outcome analytics behind the rollout success metrics.
 *
 * The properties pinned here:
 *   - `bot_serve` dimension ORDER is (source, cacheStatus, botName). Dashboards key on the
 *     positional path/method/type triple Harper builds from these, so reordering is a silent
 *     breaking change.
 *   - `pagetype_serve` is (pageType, cacheStatus, deviceType) and `pagetype_age` mirrors it —
 *     the per-template TTL-tuning signals. Same positional contract.
 *   - The label is taken from `info.pageTypeLabel` VERBATIM. Resolving it (declared name →
 *     route path → route class) is the classifier's job and is pinned in routeClass.test.js;
 *     duplicating that chain here would let the two drift while both suites stayed green.
 *   - `page_age`/`pagetype_age` are recorded ONLY for a cache-served resource
 *     (source === 'cache'), so render-now responses never drag the freshness distribution
 *     toward zero.
 *   - lastCached may arrive as a Date, a number, or a serialized string — all must yield the
 *     same age. A missing value (NaN) or a negative age (cross-node clock skew) records
 *     nothing rather than poisoning the mean.
 */

let analytics = [];
let recordServeOutcome;
let cacheServeStatus;

before(async () => {
	// bot_request.js transitively imports the Harper resource classes; stub the runtime
	// bindings, then dynamic-import so the stubs are in place before module evaluation.
	globalThis.Resource = class {};
	globalThis.server = {
		hostname: 'test-node',
		nodes: [],
		config: { http: { port: 9926 } },
		recordAnalytics: (...args) => analytics.push(args),
	};
	globalThis.logger = { info() {}, warn() {}, error() {} };
	globalThis.databases = {
		coordination: {
			SharedBuffer: {
				primaryStore: {
					getUserSharedBuffer: (_key, buf) => buf,
					tryLock: () => true,
					unlock() {},
				},
			},
		},
		render_service: { Target: class {}, QueueControl: class {} },
		render_schedule: { RenderSchedule: class {} },
		page_cache: { PrerenderedPage: class {} },
	};
	({ recordServeOutcome } = await import('../src/http_handlers/bot_request.js'));
	({ cacheServeStatus } = await import('../src/util/pageFreshness.js'));
});

beforeEach(() => {
	analytics = [];
});

const request = { botName: 'Googlebot' };

test('bot_serve records (source, cacheStatus, botName) and pagetype_serve records (pageType, cacheStatus, deviceType)', () => {
	recordServeOutcome({}, request, { source: 'origin', cacheStatus: 'miss', pageTypeLabel: 'category' }, 'desktop');
	assert.deepEqual(analytics, [
		[true, 'bot_serve', 'origin', 'miss', 'Googlebot'],
		[true, 'pagetype_serve', 'category', 'miss', 'desktop'],
	]);
});

test('the page-type label is emitted verbatim, whatever the classifier resolved it to', () => {
	// A declared name, the route-path fallback, and the route-class fallback all reach this
	// function the same way — as an already-resolved string. This asserts only the pass-through;
	// which of the three a given request yields is routeClass.test.js's contract.
	for (const label of ['pdp', '/catalog/', 'passthrough']) {
		analytics = [];
		recordServeOutcome({}, request, { source: 'origin', cacheStatus: 'miss', pageTypeLabel: label }, 'desktop');
		assert.equal(analytics[1][2], label);
	}
});

test('several routes sharing one page type report under a single label', () => {
	// The reason page types exist: two category routes, one row of numbers. Were the label still
	// the matched route's path, these two requests would land on unrelated series.
	for (let i = 0; i < 2; i++) {
		recordServeOutcome({}, request, { source: 'cache', cacheStatus: 'hit', pageTypeLabel: 'category' }, 'desktop');
	}
	const labels = analytics.filter(([, metric]) => metric === 'pagetype_serve').map(([, , label]) => label);
	assert.deepEqual(labels, ['category', 'category']);
});

test('a cache serve also records page_age (botName, deviceType) and pagetype_age (pageType, cacheStatus, deviceType)', () => {
	const lastCached = Date.now() - 5000;
	// The three shapes a schema Date reaches this code in.
	for (const value of [new Date(lastCached), lastCached, new Date(lastCached).toISOString()]) {
		analytics = [];
		recordServeOutcome(
			{ lastCached: value },
			request,
			{ source: 'cache', cacheStatus: 'hit', pageTypeLabel: 'pdp' },
			'mobile'
		);
		assert.equal(analytics.length, 4);
		const [age, metric, bot, device] = analytics[2];
		assert.equal(metric, 'page_age');
		assert.equal(bot, 'Googlebot');
		assert.equal(device, 'mobile');
		assert.ok(age >= 4000 && age <= 7000, `expected age ~5000ms, got ${age}`);
		const [rAge, rMetric, rType, rStatus, rDevice] = analytics[3];
		assert.equal(rMetric, 'pagetype_age');
		assert.equal(rType, 'pdp');
		assert.equal(rStatus, 'hit');
		assert.equal(rDevice, 'mobile');
		assert.equal(rAge, age);
	}
});

test('an swr serve carries cacheStatus swr through both page-type metrics', () => {
	recordServeOutcome(
		{ lastCached: Date.now() - 5000 },
		request,
		{ source: 'cache', cacheStatus: 'swr', pageTypeLabel: 'category' },
		'desktop'
	);
	const statuses = analytics.map(([, metric, ...dims]) => [metric, dims]);
	assert.deepEqual(statuses[0], ['bot_serve', ['cache', 'swr', 'Googlebot']]);
	assert.deepEqual(statuses[1], ['pagetype_serve', ['category', 'swr', 'desktop']]);
	assert.equal(statuses[3][0], 'pagetype_age');
	assert.equal(statuses[3][1][1], 'swr');
});

test('age metrics are skipped for a non-cache source, even with lastCached present', () => {
	recordServeOutcome({ lastCached: Date.now() }, request, { source: 'rendered', cacheStatus: 'miss' }, 'desktop');
	assert.equal(analytics.length, 2);
	assert.deepEqual(
		analytics.map(([, metric]) => metric),
		['bot_serve', 'pagetype_serve']
	);
});

test('age metrics are skipped when lastCached is missing, null, or in the future', () => {
	recordServeOutcome({}, request, { source: 'cache', cacheStatus: 'hit' }, 'desktop');
	// null is the trap case: new Date(null) is epoch 0, not NaN — unguarded, this would
	// record age ≈ Date.now() instead of nothing.
	recordServeOutcome({ lastCached: null }, request, { source: 'cache', cacheStatus: 'hit' }, 'desktop');
	recordServeOutcome({ lastCached: Date.now() + 60_000 }, request, { source: 'cache', cacheStatus: 'hit' }, 'desktop');
	assert.equal(analytics.length, 6);
	assert.ok(analytics.every(([, metric]) => metric === 'bot_serve' || metric === 'pagetype_serve'));
});

test('cacheServeStatus: hit before expiresAt, swr inside the window, null past it, null on NaN', () => {
	const now = 1_000_000;
	const swr = 100;
	assert.equal(cacheServeStatus(now + 1, swr, now), 'hit');
	assert.equal(cacheServeStatus(now, swr, now), 'swr'); // expiry instant itself is already swr
	assert.equal(cacheServeStatus(now - 99, swr, now), 'swr');
	assert.equal(cacheServeStatus(now - 100, swr, now), null); // window edge is exclusive
	assert.equal(cacheServeStatus(NaN, swr, now), null); // missing/garbage expiresAt never serves
	assert.equal(cacheServeStatus(now - 1, 0, now), null); // swrTtl 0 disables the window outright
});
