import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadinessDrift, driftMessage, validateDriftPolicy } from '../dist/readinessDrift.js';

// The drift tracker says "this contract no longer matches the site" — a clause failing on most
// renders of its page type — and changes nothing about any render. Measured on a live template, the
// failure it exists to surface ran for a day before anyone noticed: one clause unmet on 235,993 of
// 235,995 renders, every one paying the slow path, and not a single log line saying why.

const result = (clauses: Array<{ name: string; ok: boolean; skipped?: boolean }>, exit = 'valve') => ({
	contract: 'product',
	satisfied: clauses.every((c) => c.ok),
	stopped: false,
	exit: exit as never,
	waitedMs: 1000,
	firstSatisfiedMs: null,
	require: clauses.map((c) => ({ ...c, count: c.ok ? 1 : 0 })),
	observe: [],
});

test('a clause failing on most renders is reported once, with what a person needs to act', () => {
	const drift = new ReadinessDrift({ window: 10, minSamples: 5, threshold: 0.5 });
	const reports = [];
	for (let i = 0; i < 6; i++) {
		reports.push(
			...drift.record(
				result([
					{ name: 'h1', ok: true },
					{ name: 'reviews', ok: false },
				]),
				`https://x/p${i}`,
				'desktop'
			)
		);
	}
	assert.equal(reports.length, 1, 'one transition, not one line per render');
	const [r] = reports;
	assert.equal(r.event, 'readiness-clause-failing');
	assert.equal(r.clause, 'reviews');
	assert.equal(r.contract, 'product');
	assert.deepEqual([r.failed, r.of, r.share], [5, 5, 1]);
	assert.deepEqual(r.exits, { valve: 5 });
	assert.deepEqual(r.examples, ['https://x/p4 (desktop)', 'https://x/p3 (desktop)', 'https://x/p2 (desktop)']);
	assert.ok(r.failingSince);
	assert.match(driftMessage(r), /needs updating/);
	assert.deepEqual(drift.failing(), [{ contract: 'product', clause: 'reviews', failed: 6, of: 6, share: 1 }]);
});

test('nothing is reported before minSamples, and a clause failing on a minority never is', () => {
	const drift = new ReadinessDrift({ window: 20, minSamples: 10, threshold: 0.5 });
	let reports = [];
	for (let i = 0; i < 9; i++) reports.push(...drift.record(result([{ name: 'a', ok: false }]), 'u', 'd'));
	assert.equal(reports.length, 0, 'nine renders are not a verdict');
	const healthy = new ReadinessDrift({ window: 20, minSamples: 10, threshold: 0.5 });
	reports = [];
	for (let i = 0; i < 40; i++) reports.push(...healthy.record(result([{ name: 'a', ok: i % 5 !== 0 }]), 'u', 'd'));
	assert.equal(reports.length, 0, 'failing on 20% of renders is a page-level issue, not a broken contract');
});

test('a clause its guard skipped is not counted at all', () => {
	const drift = new ReadinessDrift({ window: 10, minSamples: 5, threshold: 0.5 });
	const reports = [];
	for (let i = 0; i < 20; i++)
		reports.push(...drift.record(result([{ name: 'summary', ok: true, skipped: true }]), 'u', 'd'));
	for (let i = 0; i < 4; i++) reports.push(...drift.record(result([{ name: 'summary', ok: false }]), 'u', 'd'));
	assert.equal(reports.length, 0, 'four applicable renders are below minSamples, however many were skipped');
});

test('a failing clause is reminded about, and its recovery is reported', () => {
	let now = 0;
	const drift = new ReadinessDrift({ window: 10, minSamples: 5, threshold: 0.5, remindMs: 1000 }, () => now);
	const events: string[] = [];
	const feed = (ok: boolean, n: number) => {
		for (let i = 0; i < n; i++)
			for (const r of drift.record(result([{ name: 'c', ok }]), 'u', 'd')) events.push(r.event);
	};
	feed(false, 5);
	now = 500;
	feed(false, 1);
	now = 1500;
	feed(false, 1);
	assert.deepEqual(events, ['readiness-clause-failing', 'readiness-clause-still-failing']);
	// Recovery is reported at half the threshold, so a clause near the line does not flap.
	feed(true, 5);
	assert.equal(events.at(-1), 'readiness-clause-still-failing', 'still above a quarter failing');
	feed(true, 3);
	assert.equal(events.at(-1), 'readiness-clause-recovered');
	assert.deepEqual(drift.failing(), []);
});

test('the drift policy is validated at config load', () => {
	assert.doesNotThrow(() => validateDriftPolicy(undefined));
	assert.doesNotThrow(() => validateDriftPolicy(false));
	assert.doesNotThrow(() => validateDriftPolicy({ window: 100, threshold: 0.8 }));
	assert.throws(() => validateDriftPolicy({ window: 0 }), /window must be a positive integer/);
	assert.throws(() => validateDriftPolicy({ window: 10, minSamples: 20 }), /cannot exceed/);
	assert.throws(() => validateDriftPolicy({ threshold: 0 }), /threshold/);
	assert.throws(() => validateDriftPolicy({ threshold: 1.5 }), /threshold/);
	assert.throws(() => validateDriftPolicy({ remindMs: -1 }), /remindMs/);
	assert.throws(() => validateDriftPolicy('yes'), /object or false/);
});
