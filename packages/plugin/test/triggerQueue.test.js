import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInlineTrigger, createTriggerQueue, SUBMIT_FULL, SUBMIT_QUEUED } from '../src/util/triggerQueue.js';

globalThis.logger ??= { debug() {}, info() {}, warn() {}, error() {} };

const item = (url, over = {}) => ({
	row: { url, sitemapUrl: null },
	observed: '[1]',
	rowExists: true,
	fingerprint: 'fp',
	...over,
});

const recorder = () => {
	const triggered = [];
	const written = [];
	return {
		triggered,
		written,
		trigger: async (row) => {
			triggered.push(row.url);
		},
		write: async (url, observed, opts) => {
			written.push({ url, observed, ...opts });
		},
	};
};

// The property the whole design rests on: submit RETURNS, it does not wait for the trigger. If it
// awaited, pass duration would still be a function of the change rate, which is the loop this
// exists to break.
test('submit returns without waiting for the trigger to run', async () => {
	let released;
	const gate = new Promise((resolve) => {
		released = resolve;
	});
	const q = createTriggerQueue({
		trigger: () => gate,
		write: async () => {},
		ratePerSecond: 0,
	});

	const outcome = q.submit(item('https://example.com/a'));
	assert.equal(outcome, SUBMIT_QUEUED, 'submit resolved while the trigger is still blocked');
	assert.equal(q.stats.triggered, 0, 'nothing has settled yet');

	released();
	await q.drain();
	assert.equal(q.stats.triggered, 1);
});

test('the baseline is written only AFTER the trigger succeeds, and carries clearClaim', async () => {
	const r = recorder();
	const q = createTriggerQueue({ ...r, ratePerSecond: 0 });
	q.submit(item('https://example.com/a'));
	await q.drain();

	assert.deepEqual(r.triggered, ['https://example.com/a']);
	assert.equal(r.written.length, 1);
	assert.equal(r.written[0].url, 'https://example.com/a');
	assert.equal(r.written[0].clearClaim, true, 'the trip hard-expired the page, so the stored claim must go');
	assert.equal(r.written[0].fingerprint, 'fp');
	assert.equal(r.written[0].rowExists, true);
});

// The retry story: a failed trigger must leave the signature stale so the next pass re-detects.
test('a throwing trigger writes NO baseline and is counted as an error', async () => {
	const written = [];
	const q = createTriggerQueue({
		trigger: async () => {
			throw new Error('refused');
		},
		write: async (url) => written.push(url),
		ratePerSecond: 0,
	});
	q.submit(item('https://example.com/a'));
	await q.drain();

	assert.deepEqual(written, [], 'writing here would lose the change outright');
	assert.equal(q.stats.errors, 1);
	assert.equal(q.stats.triggered, 0);
});

test('one failure does not stop the queue', async () => {
	const r = recorder();
	let calls = 0;
	const q = createTriggerQueue({
		trigger: async (row) => {
			calls++;
			if (calls === 1) throw new Error('first one fails');
			r.triggered.push(row.url);
		},
		write: r.write,
		ratePerSecond: 0,
	});
	q.submit(item('https://example.com/a'));
	q.submit(item('https://example.com/b'));
	await q.drain();

	assert.equal(q.stats.errors, 1);
	assert.equal(q.stats.triggered, 1);
	assert.deepEqual(r.triggered, ['https://example.com/b']);
});

test('a full queue refuses, which the caller counts as deferred', async () => {
	let released;
	const gate = new Promise((resolve) => {
		released = resolve;
	});
	const q = createTriggerQueue({
		trigger: () => gate,
		write: async () => {},
		maxPending: 2,
		concurrency: 1,
		ratePerSecond: 0,
	});

	// One is taken in flight immediately; the next two fill the pending list.
	q.submit(item('https://example.com/a'));
	const outcomes = [
		q.submit(item('https://example.com/b')),
		q.submit(item('https://example.com/c')),
		q.submit(item('https://example.com/d')),
	];
	assert.deepEqual(outcomes.slice(-1), [SUBMIT_FULL], 'the last one is past maxPending');
	assert.ok(q.stats.refused >= 1);

	released();
	await q.drain();
});

// Safe by construction: an abandoned item never had its baseline written, so the next pass finds
// the same change again.
test('stop abandons pending work and writes nothing for it', async () => {
	const r = recorder();
	let released;
	const gate = new Promise((resolve) => {
		released = resolve;
	});
	const q = createTriggerQueue({
		trigger: async (row) => {
			if (row.url.endsWith('/a')) return gate;
			r.triggered.push(row.url);
		},
		write: r.write,
		concurrency: 1,
		ratePerSecond: 0,
	});
	q.submit(item('https://example.com/a'));
	q.submit(item('https://example.com/b'));
	q.submit(item('https://example.com/c'));

	const dropped = q.stop();
	assert.equal(dropped, 2, 'b and c were abandoned');

	released();
	await q.drain();
	// The IN-FLIGHT item still completes and is still baselined, which is right: its trigger
	// actually succeeded, and a write you have already issued cannot be un-issued. Only PENDING
	// work is abandoned — and abandoning it is safe precisely because its baseline was never
	// written, so the next pass re-detects the same change.
	assert.deepEqual(r.triggered, [], 'neither abandoned item ran');
	assert.deepEqual(
		r.written.map((w) => w.url),
		['https://example.com/a'],
		'only the in-flight item was baselined'
	);
});

test('submissions after stop are refused rather than silently dropped', async () => {
	const q = createTriggerQueue({ trigger: async () => {}, write: async () => {}, ratePerSecond: 0 });
	q.stop();
	assert.equal(q.submit(item('https://example.com/a')), SUBMIT_FULL);
});

test('drain resolves immediately when nothing was submitted', async () => {
	const q = createTriggerQueue({ trigger: async () => {}, write: async () => {}, ratePerSecond: 0 });
	await q.drain();
	assert.equal(q.stats.triggered, 0);
});

test('pacing spaces trigger starts by the configured rate', async () => {
	const waits = [];
	let clock = 0;
	const q = createTriggerQueue({
		trigger: async () => {},
		write: async () => {},
		ratePerSecond: 4, // one slot every 250ms
		concurrency: 1,
		now: () => clock,
		sleep: async (ms) => {
			waits.push(ms);
			clock += ms;
		},
	});
	for (const url of ['a', 'b', 'c']) q.submit(item(`https://example.com/${url}`));
	await q.drain();

	assert.equal(q.stats.triggered, 3);
	// The first starts immediately; the next two each wait out a slot on a clock that never
	// advances on its own.
	assert.deepEqual(
		waits.filter((w) => w > 0),
		[250, 250]
	);
});

test('maxDepth reports the high-water mark, for sizing maxPending', async () => {
	let released;
	const gate = new Promise((resolve) => {
		released = resolve;
	});
	const q = createTriggerQueue({
		trigger: () => gate,
		write: async () => {},
		concurrency: 1,
		ratePerSecond: 0,
	});
	q.submit(item('https://example.com/a'));
	q.submit(item('https://example.com/b'));
	q.submit(item('https://example.com/c'));
	assert.ok(q.stats.maxDepth >= 2, `maxDepth was ${q.stats.maxDepth}`);
	released();
	await q.drain();
});

// ---- the inline shape the canary uses ----

test('the inline trigger settles synchronously and keeps the same ordering', async () => {
	const r = recorder();
	const inline = createInlineTrigger(r);
	const outcome = await inline.submit(item('https://example.com/a'));

	assert.equal(outcome, SUBMIT_QUEUED);
	assert.equal(inline.stats.triggered, 1, 'already settled by the time submit resolves');
	assert.deepEqual(r.triggered, ['https://example.com/a']);
	assert.equal(r.written[0].clearClaim, true);
});

test('the inline trigger also withholds the baseline when the trigger throws', async () => {
	const written = [];
	const inline = createInlineTrigger({
		trigger: async () => {
			throw new Error('refused');
		},
		write: async (url) => written.push(url),
	});
	await inline.submit(item('https://example.com/a'));

	assert.deepEqual(written, []);
	assert.equal(inline.stats.errors, 1);
	assert.equal(inline.stats.triggered, 0);
});
