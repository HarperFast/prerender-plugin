import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * recordServeOutcome — the serve-outcome analytics behind the rollout success metrics.
 *
 * The properties pinned here:
 *   - `bot_serve` dimension ORDER is (source, cacheStatus, botName). Dashboards key on the
 *     positional path/method/type triple Harper builds from these, so reordering is a silent
 *     breaking change.
 *   - `page_age` is recorded ONLY for a cache-served resource (source === 'cache'), so
 *     render-now responses never drag the freshness distribution toward zero.
 *   - lastCached may arrive as a Date, a number, or a serialized string — all must yield the
 *     same age. A missing value (NaN) or a negative age (cross-node clock skew) records
 *     nothing rather than poisoning the mean.
 */

let analytics = [];
let recordServeOutcome;

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
});

beforeEach(() => {
	analytics = [];
});

const request = { botName: 'Googlebot' };

test('bot_serve records (source, cacheStatus, botName) in that order', () => {
	recordServeOutcome({}, request, { source: 'origin', cacheStatus: 'miss' }, 'desktop');
	assert.deepEqual(analytics, [[true, 'bot_serve', 'origin', 'miss', 'Googlebot']]);
});

test('a cache hit also records page_age with (botName, deviceType)', () => {
	const lastCached = Date.now() - 5000;
	// The three shapes a schema Date reaches this code in.
	for (const value of [new Date(lastCached), lastCached, new Date(lastCached).toISOString()]) {
		analytics = [];
		recordServeOutcome({ lastCached: value }, request, { source: 'cache', cacheStatus: 'hit' }, 'mobile');
		assert.equal(analytics.length, 2);
		const [age, metric, bot, device] = analytics[1];
		assert.equal(metric, 'page_age');
		assert.equal(bot, 'Googlebot');
		assert.equal(device, 'mobile');
		assert.ok(age >= 4000 && age <= 7000, `expected age ~5000ms, got ${age}`);
	}
});

test('page_age is skipped for a non-cache source, even with lastCached present', () => {
	recordServeOutcome({ lastCached: Date.now() }, request, { source: 'rendered', cacheStatus: 'miss' }, 'desktop');
	assert.equal(analytics.length, 1);
	assert.equal(analytics[0][1], 'bot_serve');
});

test('page_age is skipped when lastCached is missing, null, or in the future', () => {
	recordServeOutcome({}, request, { source: 'cache', cacheStatus: 'hit' }, 'desktop');
	// null is the trap case: new Date(null) is epoch 0, not NaN — unguarded, this would
	// record age ≈ Date.now() instead of nothing.
	recordServeOutcome({ lastCached: null }, request, { source: 'cache', cacheStatus: 'hit' }, 'desktop');
	recordServeOutcome({ lastCached: Date.now() + 60_000 }, request, { source: 'cache', cacheStatus: 'hit' }, 'desktop');
	assert.equal(analytics.length, 3);
	assert.ok(analytics.every(([, metric]) => metric === 'bot_serve'));
});
