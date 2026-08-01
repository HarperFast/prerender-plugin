import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyOptions } from '../src/config.js';
import { currentMinuteMs, epochMsOf, getNextTimeOfDay, getInitialRenderTime, MINUTE } from '../src/util/time.js';

beforeEach(() => applyOptions({}));

test('currentMinuteMs floors to the minute', () => {
	assert.equal(currentMinuteMs(90_000), 60_000);
	assert.equal(currentMinuteMs(60_000), 60_000);
});

test('getNextTimeOfDay returns a future, minute-aligned timestamp', () => {
	const next = getNextTimeOfDay('07:00', 'America/New_York');
	assert.equal(next % MINUTE, 0);
	assert.ok(next > Date.now());
	// within the next 24h + a little slack for DST
	assert.ok(next - Date.now() <= 25 * 60 * MINUTE);
});

test('getNextTimeOfDay tolerates a missing minute component', () => {
	const next = getNextTimeOfDay('12', 'UTC');
	assert.equal(next % MINUTE, 0);
	assert.ok(next > Date.now());
});

test('getInitialRenderTime is minute-aligned within [now, now+interval)', () => {
	const interval = 24 * 60 * MINUTE; // a day
	const base = currentMinuteMs();
	const t = getInitialRenderTime('https://x.test/a|desktop', interval);
	assert.equal(t % MINUTE, 0);
	assert.ok(t >= base, 'not scheduled before now');
	assert.ok(t < base + interval + MINUTE, 'within the render interval');
});

test('getInitialRenderTime is stable per key and spreads across keys', () => {
	const interval = 24 * 60 * MINUTE;
	const a = getInitialRenderTime('key-a', interval);
	// Same key resolves to the same minute (deterministic offset; allow a 1-minute
	// window in case the wall clock ticks over a minute between the two calls).
	assert.ok(Math.abs(getInitialRenderTime('key-a', interval) - a) <= MINUTE, 'stable for a given key');
	// Distinct keys spread across the interval rather than collapsing to one time.
	const values = new Set(Array.from({ length: 100 }, (_, i) => getInitialRenderTime(`key-${i}`, interval)));
	assert.ok(values.size > 1, 'distinct keys spread across times');
});

/*
 * The jitter is seeded off the URL half of the cache key, so a URL's device variants come due
 * together: the pair sorts adjacently in claim order and renders back-to-back off a warm
 * origin, and the two cached copies of a page never differ in age by up to a whole interval.
 * Seeded off the full cacheKey (as it was), `|desktop` and `|mobile` hashed to unrelated
 * offsets.
 */
test('getInitialRenderTime aligns a URL device variants on one slot', () => {
	const interval = 24 * 60 * MINUTE;
	const url = 'https://x.test/catalog/shoes';
	const desktop = getInitialRenderTime(`${url}|desktop`, interval);
	const mobile = getInitialRenderTime(`${url}|mobile`, interval);
	const tablet = getInitialRenderTime(`${url}|tablet`, interval);

	// Allow a 1-minute window: the calls can straddle a wall-clock minute boundary.
	assert.ok(Math.abs(desktop - mobile) <= MINUTE, 'desktop and mobile share a slot');
	assert.ok(Math.abs(desktop - tablet) <= MINUTE, 'desktop and tablet share a slot');
});

test('getInitialRenderTime still spreads distinct URLs that share a device type', () => {
	const interval = 24 * 60 * MINUTE;
	const values = new Set(
		Array.from({ length: 200 }, (_, i) => getInitialRenderTime(`https://x.test/p/prd-${i}|desktop`, interval))
	);
	// Aligning device variants must not collapse the URL spread. 200 URLs over 1440 minute
	// buckets: a handful of hash collisions is expected, a near-total collapse is the bug.
	assert.ok(values.size > 100, `distinct URLs stay spread (got ${values.size} slots)`);
});

/*
 * A key with no delimiter is not a cache key. It must fall back to hashing the whole string:
 * `CacheKey.extractUrl` returns '' for such a key, and seeding off that would put EVERY
 * delimiter-less key on the same minute — the exact herd this jitter prevents.
 */
test('getInitialRenderTime does not collapse keys that lack the delimiter', () => {
	const interval = 24 * 60 * MINUTE;
	const values = new Set(Array.from({ length: 100 }, (_, i) => getInitialRenderTime(`no-delimiter-${i}`, interval)));
	assert.ok(values.size > 50, `delimiter-less keys stay spread (got ${values.size} slots)`);
});

// --- epochMsOf: a Harper Date column does not arrive in one predictable shape ---

test('epochMsOf accepts a Date, an epoch number, and an ISO string alike', () => {
	const ms = Date.UTC(2026, 7, 1, 12, 0, 0);
	assert.equal(epochMsOf(new Date(ms)), ms);
	assert.equal(epochMsOf(ms), ms);
	assert.equal(epochMsOf(new Date(ms).toISOString()), ms);
});

test('epochMsOf returns NaN for an absent column rather than the epoch', () => {
	// `new Date(null).getTime()` is 0, not NaN. Without the guard a missing timestamp reads as
	// 1970 — infinitely old — which is the opposite of "absent" for any staleness comparison.
	for (const absent of [null, undefined, '']) {
		assert.ok(Number.isNaN(epochMsOf(absent)), `${JSON.stringify(absent)} must be NaN`);
	}
});

test('epochMsOf returns NaN for an unparseable value', () => {
	assert.ok(Number.isNaN(epochMsOf('not a date')));
	assert.ok(Number.isNaN(epochMsOf({})));
});

test('epochMsOf keeps epoch 0 distinguishable from absent', () => {
	assert.equal(epochMsOf(0), 0);
});
