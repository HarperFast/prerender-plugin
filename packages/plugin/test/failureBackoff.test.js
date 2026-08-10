import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOptions } from '../src/config.js';
import { backoffWait } from '../src/util/failureBackoff.js';

globalThis.logger ??= { info() {}, warn() {}, error() {} };

const H = 60 * 60 * 1000;
const DAY = 24 * H;

// applyOptions merges into DEFAULTS rather than cumulatively, so every override goes through here.
const setRetry = (overrides = {}) =>
	applyOptions({
		render: {
			failureRetry: {
				fastRetries: 2,
				backoffFactor: 2,
				maxBackoff: 7 * DAY,
				nonSitemapPenalty: 4,
				...overrides,
			},
		},
	});

test('first escalation waits exactly one interval (unchanged from the flat behaviour)', () => {
	setRetry();
	// strike 3 with fastRetries: 2 is the first strike past the fast lane.
	assert.equal(backoffWait(24 * H, 3, true), 24 * H);
});

test('each strike past the first escalation multiplies by backoffFactor', () => {
	setRetry();
	assert.equal(backoffWait(24 * H, 4, true), 48 * H);
	assert.equal(backoffWait(24 * H, 5, true), 96 * H);
});

test('maxBackoff caps the growth', () => {
	setRetry({ maxBackoff: 3 * DAY });
	assert.equal(backoffWait(24 * H, 9, true), 3 * DAY);
});

test('a maxBackoff BELOW the interval never shortens the retry below the cadence', () => {
	// The trap this guards: a 48h page against a 24h ceiling must not come due every 24h —
	// that would make a FAILING page render more often than a healthy one.
	setRetry({ maxBackoff: DAY });
	assert.equal(backoffWait(48 * H, 3, true), 48 * H);
	assert.equal(backoffWait(48 * H, 7, true), 48 * H);
});

test('the first escalation is one interval for EVERY target, sitemap or not', () => {
	// One failure has not earned a deprioritization verdict.
	setRetry({ nonSitemapPenalty: 4 });
	assert.equal(backoffWait(6 * H, 3, true), 6 * H);
	assert.equal(backoffWait(6 * H, 3, false), 6 * H);
});

test('from the second escalation, non-sitemap targets back off harder', () => {
	setRetry({ nonSitemapPenalty: 4 });
	assert.equal(backoffWait(6 * H, 4, true), 12 * H); // base curve: interval * 2
	assert.equal(backoffWait(6 * H, 4, false), 48 * H); // * 4 penalty
});

test('nonSitemapPenalty: 1 treats both alike', () => {
	setRetry({ nonSitemapPenalty: 1 });
	assert.equal(backoffWait(6 * H, 4, false), backoffWait(6 * H, 4, true));
});

test('backoffFactor: 1 restores a flat cadence at every strike', () => {
	setRetry({ backoffFactor: 1, nonSitemapPenalty: 1 });
	for (const strike of [3, 4, 10, 50]) {
		assert.equal(backoffWait(24 * H, strike, true), 24 * H);
	}
});

test('fastRetries: 0 escalates from the very first strike without a negative exponent', () => {
	setRetry({ fastRetries: 0 });
	assert.equal(backoffWait(24 * H, 1, true), 24 * H);
	assert.equal(backoffWait(24 * H, 2, true), 48 * H);
});

test('a float-valued factor or penalty still yields an integer, minute-aligned wait', () => {
	// nextRenderTime is `Long @indexed` and the claim floor compares whole minutes (minuteOf), so
	// a fractional wait must never reach the row. Both options are `min: 1` with no integer bound.
	setRetry({ backoffFactor: 1.5, nonSitemapPenalty: 2.5 });
	for (const [strikes, sitemap] of [
		[4, true],
		[5, true],
		[4, false],
		[6, false],
	]) {
		const w = backoffWait(6 * H, strikes, sitemap);
		assert.equal(Number.isInteger(w), true, `strike ${strikes} produced non-integer ${w}`);
		assert.equal(w % 60000, 0, `strike ${strikes} produced non-minute-aligned ${w}`);
	}
});

test('flooring to a minute never pushes the wait over maxBackoff', () => {
	// The ceiling only governs where it sits ABOVE the cadence — below it, the cadence floor wins
	// by design (see the maxBackoff-under-interval test), so use a short interval here.
	const cap = 100 * 60 * 1000 + 30_000; // deliberately not minute-aligned
	setRetry({ backoffFactor: 1.7, maxBackoff: cap });
	const w = backoffWait(10 * 60 * 1000, 9, false);
	assert.ok(w <= cap, `${w} exceeded the cap ${cap}`);
	assert.equal(w % 60000, 0);
});

test('the wait never goes backwards as strikes climb', () => {
	setRetry();
	let prev = 0;
	for (let s = 3; s <= 12; s++) {
		const w = backoffWait(24 * H, s, false);
		assert.ok(w >= prev, `strike ${s} waited ${w}, less than previous ${prev}`);
		prev = w;
	}
});
