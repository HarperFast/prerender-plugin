import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyOptions } from '../src/config.js';
import { currentMinuteMs, getNextTimeOfDay, getInitialRenderTime, MINUTE } from '../src/util/time.js';

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
