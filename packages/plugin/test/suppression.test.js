import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOptions } from '../src/config.js';
import { gradeSuppression, isGoneVerdict } from '../src/util/suppression.js';

globalThis.logger ??= { debug() {}, info() {}, warn() {}, error() {} };

const DAY = 24 * 60 * 60 * 1000;

// applyOptions merges into DEFAULTS rather than cumulatively, so every override goes through here.
const setSuppression = (overrides = {}) =>
	applyOptions({
		render: {
			suppression: {
				recheckInterval: 7 * DAY,
				maxStrikes: 4,
				gone: { recheckInterval: 14 * DAY, maxStrikes: 2, maxStrikesUnlisted: 1, ...overrides },
			},
		},
	});

test('only an http-error verdict with a gone status grades as gone', () => {
	assert.equal(isGoneVerdict('http-error', 404), true);
	assert.equal(isGoneVerdict('http-error', 410), true);
	assert.equal(isGoneVerdict('http-error', 500), false);
	// A rendered document's status is not the statement the verdict is making.
	assert.equal(isGoneVerdict('noindex', 404), false);
	assert.equal(isGoneVerdict('canonical-mismatch', 410), false);
	assert.equal(isGoneVerdict(undefined, undefined), false);
});

test('an unlisted gone verdict retires on the first strike', () => {
	setSuppression();
	const graded = gradeSuppression({ reason: 'http-error', statusCode: 404, fromSitemap: false });
	assert.equal(graded.gone, true);
	assert.equal(graded.storedReason, 'http-gone');
	assert.equal(graded.maxStrikes, 1);
	assert.equal(graded.recheckInterval, 14 * DAY);
});

// The asymmetry this option exists for: the sitemap re-creates what it lists, so deleting a listed
// target buys a render every refresh instead of a recheck every fortnight.
test('a sitemap-listed gone verdict keeps counting the full gone ceiling', () => {
	setSuppression();
	const graded = gradeSuppression({ reason: 'http-error', statusCode: 410, fromSitemap: true });
	assert.equal(graded.gone, true);
	assert.equal(graded.storedReason, 'http-gone');
	assert.equal(graded.maxStrikes, 2);
});

test('non-gone verdicts ignore attribution and take the default knobs', () => {
	setSuppression();
	for (const fromSitemap of [true, false]) {
		const graded = gradeSuppression({ reason: 'noindex', statusCode: 200, fromSitemap });
		assert.equal(graded.gone, false);
		assert.equal(graded.storedReason, 'noindex');
		assert.equal(graded.maxStrikes, 4);
		assert.equal(graded.recheckInterval, 7 * DAY);
	}
});

// The one verdict shape that reaches `suppress` with no reason at all: stored as null, never
// coerced to a string, so the registry keeps saying "no reason given" rather than inventing one.
test('a reasonless verdict stores null and takes the default knobs', () => {
	setSuppression();
	const graded = gradeSuppression({ reason: undefined, statusCode: 404, fromSitemap: false });
	assert.equal(graded.gone, false);
	assert.equal(graded.storedReason, null);
	assert.equal(graded.maxStrikes, 4);
});

test('setting maxStrikesUnlisted equal to maxStrikes restores the pre-0.67.0 behaviour', () => {
	setSuppression({ maxStrikesUnlisted: 2 });
	assert.equal(gradeSuppression({ reason: 'http-error', statusCode: 404, fromSitemap: false }).maxStrikes, 2);
	assert.equal(gradeSuppression({ reason: 'http-error', statusCode: 404, fromSitemap: true }).maxStrikes, 2);
});
