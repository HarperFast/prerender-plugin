import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyOptions } from '../src/config.js';
import { currentMinuteMs, getNextTimeOfDay, getNextRenderTime, MINUTE } from '../src/util/time.js';

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

test('getNextRenderTime reflects configured render time/timezone', () => {
	applyOptions({ render: { time: '03:30', timezone: 'UTC' } });
	const next = getNextRenderTime();
	const asUtc = new Date(next);
	// minute-aligned and in the future
	assert.equal(next % MINUTE, 0);
	assert.ok(next > Date.now());
	// the UTC time-of-day should be 03:30
	assert.equal(asUtc.getUTCHours(), 3);
	assert.equal(asUtc.getUTCMinutes(), 30);
});
