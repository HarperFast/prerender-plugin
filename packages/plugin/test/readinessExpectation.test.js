import { test } from 'node:test';
import assert from 'node:assert/strict';

// What a URL produced LAST time is the only expectation that cannot rot — and the only one that can
// turn into a permanent false alarm. These tests are about the second half: the rule has to catch a
// page that quietly lost content AND get out of the way when the page really changed.
//
// The same rule exists in the browser package (`readiness.assessExpectations`) for the in-render
// path. They must agree; if you change one, change both.

globalThis.server = { hostname: 'test-node', recordAnalytics: () => {} };
globalThis.databases = { probe_state: { RenderExpectation: {} } };
globalThis.logger = { warn: () => {}, info: () => {}, error: () => {} };

const { assess } = await import('../src/util/readinessExpectation.js');

const history = (counts, consecutiveShortfalls = 0) => ({ counts, consecutiveShortfalls });

test('a first render has nothing to regress from, and is learned from', () => {
	const v = assess({ rails: 3, links: 350 }, null);
	assert.deepEqual(v.shortfalls, []);
	assert.equal(v.rebaselined, false);
	assert.deepEqual(v.next.counts, { rails: 3, links: 350 });
});

test('run-to-run churn is not a shortfall', () => {
	// Measured churn on these pages is ~5% on link and image counts; the tolerance is 50%, so
	// ordinary personalisation must never trip this.
	assert.deepEqual(assess({ links: 332 }, history({ links: 350 })).shortfalls, []);
});

test('losing the rails is caught even though no contract clause names them', () => {
	const v = assess({ rails: 0, links: 3 }, history({ rails: 3, links: 350 }));
	assert.deepEqual(v.shortfalls.map((s) => s.name).sort(), ['links', 'rails']);
	assert.equal(v.shortfalls.find((s) => s.name === 'rails').expected, 3);
});

test('a page that never had the thing cannot fall short of it', () => {
	assert.deepEqual(assess({ rails: 0 }, history({ rails: 0 })).shortfalls, []);
	// And an observation with no history at all is ignored rather than read as zero.
	assert.deepEqual(assess({ brandNew: 0 }, history({ rails: 3 })).shortfalls, []);
});

test('a suspected shortfall does NOT re-learn — that is how a regression would erase its evidence', () => {
	const v = assess({ rails: 0 }, history({ rails: 3 }, 0));
	assert.equal(v.shortfalls.length, 1);
	assert.deepEqual(v.next.counts, { rails: 3 }, 'the old expectation is kept');
	assert.equal(v.next.consecutive, 1);
});

test('the same shortfall, repeated, stops being a regression and becomes the page', () => {
	// THE CONVERGENCE MECHANISM. A rail removed site-wide must not fail this URL forever.
	assert.equal(assess({ rails: 0 }, history({ rails: 3 }, 0)).rebaselined, false, 'once is a lost rail');
	assert.equal(assess({ rails: 0 }, history({ rails: 3 }, 1)).rebaselined, false, 'twice is still suspicious');

	const third = assess({ rails: 0 }, history({ rails: 3 }, 2));
	assert.equal(third.rebaselined, true, 'three times in a row is the new shape of the page');
	assert.deepEqual(third.shortfalls, [], 'and it stops being reported as a shortfall');
	assert.deepEqual(third.next.counts, { rails: 0 }, 'the page as it is now becomes the expectation');
	assert.equal(third.next.consecutive, 0, 'so the next real regression starts from zero');
});

test('a recovery resets the counter rather than leaving it armed', () => {
	const v = assess({ rails: 3 }, history({ rails: 3 }, 2));
	assert.deepEqual(v.shortfalls, []);
	assert.equal(v.rebaselined, false, 'nothing fell short, so nothing is being re-learned');
	assert.equal(v.next.consecutive, 0);
});
