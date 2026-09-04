import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * recordServeOutcome — the serve-outcome analytics behind the rollout success metrics.
 *
 * The properties pinned here:
 *   - `bot_serve` dimension ORDER is (source, cacheStatus, botName). Dashboards key on the
 *     positional path/method/type triple Harper builds from these, so reordering is a silent
 *     breaking change.
 *   - `route_serve` is (route, cacheStatus, deviceType) and `route_page_age` mirrors it —
 *     the per-route TTL-tuning signals. Same positional contract.
 *   - The route label resolves route.path, then routeClass, then 'unrouted' — in that order.
 *   - `page_age`/`route_page_age` are recorded ONLY for a cache-served resource
 *     (source === 'cache'), so render-now responses never drag the freshness distribution
 *     toward zero.
 *   - lastCached may arrive as a Date, a number, or a serialized string — all must yield the
 *     same age. A missing value (NaN) or a negative age (cross-node clock skew) records
 *     nothing rather than poisoning the mean.
 *   - `hydration_calls` (v0.65.0) rides beside these for a crawler the registry flags as
 *     executing scripts — Googlebot, the bot every test here uses, is one — and its side is
 *     decided by source × scriptsStripped × whether k is known. The serve-outcome assertions
 *     above look at the rows WITHOUT it (`serveRows`), so each contract is pinned on its own.
 */

let analytics = [];
let recordServeOutcome;
let resolveServeStatus;

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
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {} };
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
	({ resolveServeStatus } = await import('../src/util/pageFreshness.js'));
});

beforeEach(() => {
	analytics = [];
});

/** The serve-outcome rows alone — hydration_calls has its own contract and its own tests below. */
const serveRows = () => analytics.filter(([, metric]) => metric !== 'hydration_calls');
const hydrationRows = () => analytics.filter(([, metric]) => metric === 'hydration_calls');

const request = { botName: 'Googlebot' };

test('bot_serve records (source, cacheStatus, botName) and route_serve records (route, cacheStatus, deviceType)', () => {
	recordServeOutcome({}, request, { source: 'origin', cacheStatus: 'miss', route: { path: '/catalog/' } }, 'desktop');
	assert.deepEqual(serveRows(), [
		[true, 'bot_serve', 'origin', 'miss', 'Googlebot'],
		[true, 'route_serve', '/catalog/', 'miss', 'desktop'],
	]);
});

test('route label falls back route.path -> routeClass -> unrouted', () => {
	recordServeOutcome({}, request, { source: 'origin', cacheStatus: 'miss', routeClass: 'passthrough' }, 'desktop');
	recordServeOutcome({}, request, { source: 'origin', cacheStatus: 'miss' }, 'desktop');
	assert.equal(serveRows()[1][2], 'passthrough');
	assert.equal(serveRows()[3][2], 'unrouted');
});

test('a cache serve also records page_age (botName, deviceType) and route_page_age (route, cacheStatus, deviceType)', () => {
	const lastCached = Date.now() - 5000;
	// The three shapes a schema Date reaches this code in.
	for (const value of [new Date(lastCached), lastCached, new Date(lastCached).toISOString()]) {
		analytics = [];
		recordServeOutcome(
			{ lastCached: value },
			request,
			{ source: 'cache', cacheStatus: 'hit', route: { path: '/product/prd-' } },
			'mobile'
		);
		assert.equal(serveRows().length, 4);
		const [age, metric, bot, device] = serveRows()[2];
		assert.equal(metric, 'page_age');
		assert.equal(bot, 'Googlebot');
		assert.equal(device, 'mobile');
		assert.ok(age >= 4000 && age <= 7000, `expected age ~5000ms, got ${age}`);
		const [rAge, rMetric, rRoute, rStatus, rDevice] = serveRows()[3];
		assert.equal(rMetric, 'route_page_age');
		assert.equal(rRoute, '/product/prd-');
		assert.equal(rStatus, 'hit');
		assert.equal(rDevice, 'mobile');
		assert.equal(rAge, age);
	}
});

test('an swr serve carries cacheStatus swr through both route metrics', () => {
	recordServeOutcome(
		{ lastCached: Date.now() - 5000 },
		request,
		{ source: 'cache', cacheStatus: 'swr', route: { path: '/catalog/' } },
		'desktop'
	);
	const statuses = serveRows().map(([, metric, ...dims]) => [metric, dims]);
	assert.deepEqual(statuses[0], ['bot_serve', ['cache', 'swr', 'Googlebot']]);
	assert.deepEqual(statuses[1], ['route_serve', ['/catalog/', 'swr', 'desktop']]);
	assert.equal(statuses[3][0], 'route_page_age');
	assert.equal(statuses[3][1][1], 'swr');
});

test('age metrics are skipped for a non-cache source, even with lastCached present', () => {
	recordServeOutcome({ lastCached: Date.now() }, request, { source: 'rendered', cacheStatus: 'miss' }, 'desktop');
	assert.equal(serveRows().length, 2);
	assert.deepEqual(
		serveRows().map(([, metric]) => metric),
		['bot_serve', 'route_serve']
	);
});

test('age metrics are skipped when lastCached is missing, null, or in the future', () => {
	recordServeOutcome({}, request, { source: 'cache', cacheStatus: 'hit' }, 'desktop');
	// null is the trap case: new Date(null) is epoch 0, not NaN — unguarded, this would
	// record age ≈ Date.now() instead of nothing.
	recordServeOutcome({ lastCached: null }, request, { source: 'cache', cacheStatus: 'hit' }, 'desktop');
	const metrics = serveRows().map(([, metric]) => metric);
	assert.deepEqual(metrics, ['bot_serve', 'route_serve', 'bot_serve', 'route_serve'], 'no age sample either way');
});

test('a lastCached in the FUTURE records page_age_negative instead of silently vanishing', () => {
	// A negative age is cross-node clock skew, and it is the only evidence anywhere of how large that
	// skew actually is — which is half of what invalidation.pad exists to cover. It still must not
	// enter page_age (it would drag the mean), so it becomes a counter rather than a discard.
	recordServeOutcome({ lastCached: Date.now() + 60_000 }, request, { source: 'cache', cacheStatus: 'hit' }, 'desktop');
	// page_age_negative is a prerender_ops series: (true, 'prerender_ops', series, bot, device)
	assert.deepEqual(
		serveRows().map(([, metric, seriesOrDim]) => (metric === 'prerender_ops' ? seriesOrDim : metric)),
		['bot_serve', 'route_serve', 'page_age_negative']
	);
	const [value, , , bot, device] = serveRows()[2];
	assert.equal(value, true, 'a counter, not a duration');
	assert.equal(bot, 'Googlebot');
	assert.equal(device, 'desktop');
});

const NOW = 1_000_000;
const SWR = 100;
const serve = (expiresAtMs, extra = {}) =>
	resolveServeStatus({ expiresAtMs, lastCachedMs: NOW - 1, swrTtl: SWR, now: NOW, epoch: null, ...extra });

test('resolveServeStatus: hit before expiresAt, swr inside the window, null past it, null on NaN', () => {
	assert.equal(serve(NOW + 1).status, 'hit');
	assert.equal(serve(NOW).status, 'swr'); // expiry instant itself is already swr
	assert.equal(serve(NOW - 99).status, 'swr');
	assert.equal(serve(NOW - 100).status, null); // window edge is exclusive
	assert.equal(serve(NaN).status, null); // missing/garbage expiresAt never serves
	assert.equal(serve(NOW - 1, { swrTtl: 0 }).status, null); // swrTtl 0 disables the window outright
	assert.equal(serve(NOW + 1).servable, true);
	assert.equal(serve(NOW - 100).servable, false);
});

test('resolveServeStatus THROWS when epoch is omitted — the whole point of the rename', () => {
	// A default would let a new call site compile while silently ignoring every invalidation, which
	// reads to an operator as "this page is fresh" while bots are being sent to the origin. `epoch:
	// undefined` must fail exactly like omitting it, hence the `in` check rather than `=== undefined`.
	assert.throws(() => resolveServeStatus({ expiresAtMs: NOW + 1, swrTtl: SWR, now: NOW }), TypeError);
	assert.throws(() => resolveServeStatus({ expiresAtMs: NOW + 1, swrTtl: SWR, now: NOW, epoch: undefined }), TypeError);
	assert.throws(() => resolveServeStatus(), TypeError);
	// ...and passing null explicitly is the caller CLAIMING nothing applies, which is fine.
	assert.equal(serve(NOW + 1).epochConsulted, false);
});

test('an epoch demotes a page rendered before it, and only when it would otherwise have served', () => {
	const epoch = { scope: 'all', at: NOW - 50 };

	// Rendered before the epoch, still inside its own window ⇒ the invalidation is what cost the serve.
	const hit = serve(NOW + 1, { lastCachedMs: NOW - 100, epoch });
	assert.equal(hit.status, 'invalidated');
	assert.equal(hit.servable, false);
	assert.equal(hit.base, 'hit', 'the base verdict is preserved, so the counter means "cost us a hit"');
	assert.deepEqual(hit.invalidatedBy, { scope: 'all', at: NOW - 50 });

	// Rendered AFTER the epoch ⇒ it healed, and serves normally.
	assert.equal(serve(NOW + 1, { lastCachedMs: NOW - 10, epoch }).status, 'hit');

	// Already past its SWR window ⇒ stays 'stale' (null), NOT 'invalidated'. Otherwise the counter
	// would tally every stale key in the scope instead of the blast radius.
	assert.equal(serve(NOW - 100, { lastCachedMs: NOW - 200, epoch }).status, null);

	// An unreadable lastCached counts as INVALIDATED, not as servable: every comparison against NaN
	// is false, so `<=` would have made a page with no usable timestamp serve straight through.
	assert.equal(serve(NOW + 1, { lastCachedMs: NaN, epoch }).status, 'invalidated');
});

// ---- hydration_calls: which side of the offload ledger the page's own origin calls land on ----
//
// k is the render fleet's count of same-origin requests the page makes that no shared cache would
// answer (browser ≥ 1.22.0). A crawler that executes scripts makes those calls itself when it runs
// the page — unless the snapshot it was handed has no scripts left to run.

test('a cache serve of a script-stripped snapshot SAVES k — the crawler runs nothing', () => {
	const page = { uncacheableSubrequests: 7, scriptsStripped: true, lastCached: Date.now() - 1000 };
	recordServeOutcome(page, request, { source: 'cache', cacheStatus: 'hit', route: { path: '/p/' }, page }, 'desktop');
	assert.deepEqual(hydrationRows(), [[7, 'hydration_calls', 'saved', 'Googlebot', 'cache']]);
});

test('a cache serve of a snapshot that KEPT its scripts INCURS k', () => {
	const page = { uncacheableSubrequests: 7, scriptsStripped: false };
	recordServeOutcome(page, request, { source: 'cache', cacheStatus: 'hit', page }, 'desktop');
	assert.deepEqual(hydrationRows(), [[7, 'hydration_calls', 'incurred', 'Googlebot', 'cache']]);
});

test('an origin serve INCURS k whatever the snapshot did — the proxied page carries its scripts', () => {
	// The record the request was judged against (stale here) is on `info.page`; `resource` is the
	// origin response and knows nothing about k.
	const page = { uncacheableSubrequests: 4, scriptsStripped: true };
	recordServeOutcome({ statusCode: 200 }, request, { source: 'origin', cacheStatus: 'stale', page }, 'desktop');
	assert.deepEqual(hydrationRows(), [[4, 'hydration_calls', 'incurred', 'Googlebot', 'origin']]);
});

test('a render-now hit is a cache-shaped serve of the FRESH record', () => {
	const fresh = { uncacheableSubrequests: 2, scriptsStripped: true };
	recordServeOutcome(fresh, request, { source: 'rendered', cacheStatus: 'skip', page: null }, 'desktop');
	assert.deepEqual(hydrationRows(), [[2, 'hydration_calls', 'saved', 'Googlebot', 'rendered']]);
});

test('an unknown k is reported as UNKNOWN with value 0 — never as "this page makes no calls"', () => {
	// A miss: no record at all.
	recordServeOutcome({ statusCode: 200 }, request, { source: 'origin', cacheStatus: 'miss', page: null }, 'desktop');
	// A row rendered by a fleet that predates the tally: the field is absent.
	const old = { lastCached: Date.now() - 1000 };
	recordServeOutcome(old, request, { source: 'cache', cacheStatus: 'hit', page: old }, 'desktop');
	// Garbage in the field is not a number either.
	const bad = { uncacheableSubrequests: -1, scriptsStripped: true };
	recordServeOutcome(bad, request, { source: 'cache', cacheStatus: 'hit', page: bad }, 'desktop');
	assert.deepEqual(hydrationRows(), [
		[0, 'hydration_calls', 'unknown', 'Googlebot', 'origin'],
		[0, 'hydration_calls', 'unknown', 'Googlebot', 'cache'],
		[0, 'hydration_calls', 'unknown', 'Googlebot', 'cache'],
	]);
});

test('a row that does not say whether its scripts were stripped is read as KEPT — the side that cannot over-credit', () => {
	const page = { uncacheableSubrequests: 3 };
	recordServeOutcome(page, request, { source: 'cache', cacheStatus: 'hit', page }, 'desktop');
	assert.deepEqual(hydrationRows(), [[3, 'hydration_calls', 'incurred', 'Googlebot', 'cache']]);
});

test('a crawler the registry does not flag as executing scripts emits nothing — its page-view carries no k', () => {
	const page = { uncacheableSubrequests: 7, scriptsStripped: true };
	for (const botName of ['GPTBot', 'ClaudeBot', 'other', 'SomeDerivedBot', undefined]) {
		analytics = [];
		recordServeOutcome(page, { botName }, { source: 'cache', cacheStatus: 'hit', page }, 'desktop');
		assert.deepEqual(hydrationRows(), [], String(botName));
		// bot_serve + route_serve (no lastCached on this record, so no age rows) — untouched either way.
		assert.equal(serveRows().length, 2, 'the serve-outcome rows are untouched');
	}
});

test('the registry flag is matched case-insensitively, like the other registry-derived allowlists', () => {
	const page = { uncacheableSubrequests: 1, scriptsStripped: true };
	recordServeOutcome(page, { botName: 'googlebot' }, { source: 'cache', cacheStatus: 'hit', page }, 'desktop');
	assert.equal(hydrationRows().length, 1);
});
