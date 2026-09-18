// What a page produced LAST time is the only expectation that does not rot — and the only one that
// can turn into a permanent false alarm. These tests are about the second half: the mechanism has to
// catch a page that quietly lost its rails AND get out of the way when the template really changed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { assessExpectations, DEFAULT_EXPECTATION_POLICY } from '../dist/readiness.js';

const observed = (counts: Record<string, number>) =>
	Object.entries(counts).map(([name, count]) => ({ name, ok: true, count }));

test('a first render has nothing to regress from', () => {
	const verdict = assessExpectations(observed({ rails: 0, links: 0 }), undefined);
	assert.deepEqual(verdict.shortfalls, []);
	assert.equal(verdict.rebaselined, false);
	// It still reports what it saw, so the NEXT render has a baseline.
	assert.deepEqual(verdict.learned, { rails: 0, links: 0 });
});

test('run-to-run churn is not a shortfall', () => {
	// Measured churn on a live page is ~5% on link and image counts; the default tolerance is 50%,
	// so ordinary personalisation must never trip this.
	const verdict = assessExpectations(observed({ links: 332 }), { counts: { links: 350 } });
	assert.deepEqual(verdict.shortfalls, []);
});

test('losing the rails is caught even though no clause names them', () => {
	const verdict = assessExpectations(observed({ rails: 0, links: 3 }), { counts: { rails: 3, links: 350 } });
	assert.equal(verdict.shortfalls.length, 2);
	const rails = verdict.shortfalls.find((s) => s.name === 'rails')!;
	assert.equal(rails.expected, 3);
	assert.equal(rails.got, 0);
	assert.equal(rails.ratio, 0);
});

test('a page that never had the thing cannot fall short of it', () => {
	// An expectation of 0 is not evidence of anything, and treating it as a floor would make every
	// page that gains content look like it had lost some.
	const verdict = assessExpectations(observed({ rails: 0 }), { counts: { rails: 0 } });
	assert.deepEqual(verdict.shortfalls, []);
});

test('an observation with no history is ignored rather than read as zero', () => {
	const verdict = assessExpectations(observed({ rails: 0, brandNew: 0 }), { counts: { rails: 3 } });
	assert.deepEqual(
		verdict.shortfalls.map((s) => s.name),
		['rails']
	);
});

test('the same shortfall, repeated, stops being a regression and becomes the page', () => {
	// THE POINT OF THE WHOLE MECHANISM. A rail removed site-wide must not fail this URL forever.
	const history = { counts: { rails: 3 }, consecutiveShortfalls: 0 };
	const first = assessExpectations(observed({ rails: 0 }), history);
	assert.equal(first.shortfalls.length, 1, 'once is a lost rail');
	assert.equal(first.rebaselined, false);

	const second = assessExpectations(observed({ rails: 0 }), { ...history, consecutiveShortfalls: 1 });
	assert.equal(second.shortfalls.length, 1, 'twice is still suspicious');
	assert.equal(second.rebaselined, false);

	const third = assessExpectations(observed({ rails: 0 }), { ...history, consecutiveShortfalls: 2 });
	assert.deepEqual(third.shortfalls, [], 'three times in a row is the new shape of the page');
	assert.equal(third.rebaselined, true);
	assert.deepEqual(third.learned, { rails: 0 }, 'and the consumer is told what to store instead');
});

test('rebaselining needs the shortfall to persist, not merely a high counter', () => {
	// A URL carrying a stale counter from an unrelated earlier drop must not silently accept a NEW
	// regression on its first occurrence.
	const verdict = assessExpectations(observed({ rails: 3 }), { counts: { rails: 3 }, consecutiveShortfalls: 9 });
	assert.deepEqual(verdict.shortfalls, []);
	assert.equal(verdict.rebaselined, false, 'nothing fell short, so nothing is being re-learned');
});

test('the policy is configurable, and a stricter tolerance catches a smaller drop', () => {
	const loose = assessExpectations(observed({ links: 300 }), { counts: { links: 350 } });
	assert.deepEqual(loose.shortfalls, []);

	const strict = assessExpectations(
		observed({ links: 300 }),
		{ counts: { links: 350 } },
		{
			...DEFAULT_EXPECTATION_POLICY,
			tolerance: 0.1,
		}
	);
	assert.equal(strict.shortfalls.length, 1);
	assert.equal(Math.round(strict.shortfalls[0].ratio * 100), 86);
});
