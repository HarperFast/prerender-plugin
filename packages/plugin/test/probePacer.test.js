import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchPause, cycleRatePerSecond, MAX_TIMER_MS, pacedRate, stepBackoff } from '../src/util/probePacer.js';

test('cycleRatePerSecond: an on-schedule walk asks for the steady rate', () => {
	// Half the slice done, half the budget spent: exactly the rate that finishes on time.
	const rate = cycleRatePerSecond({ sliceSize: 1000, done: 500, elapsed: 5000, cycleTarget: 10_000 });
	assert.equal(rate, 100); // 500 rows / 5s
});

test('cycleRatePerSecond: falling behind asks for more, running ahead asks for less', () => {
	const behind = cycleRatePerSecond({ sliceSize: 1000, done: 100, elapsed: 5000, cycleTarget: 10_000 });
	const ahead = cycleRatePerSecond({ sliceSize: 1000, done: 900, elapsed: 5000, cycleTarget: 10_000 });
	assert.equal(behind, 180); // 900 left in 5s
	assert.equal(ahead, 20); // 100 left in 5s
	assert.ok(behind > ahead, 'the controller must push harder the further behind it is');
});

test('cycleRatePerSecond: a finished slice is 0, not an infinitely slow crawl', () => {
	// The caller reads 0 as "cycle complete". Returning a tiny rate instead would keep the pass
	// alive, pacing an empty batch queue forever.
	assert.equal(cycleRatePerSecond({ sliceSize: 1000, done: 1000, elapsed: 1, cycleTarget: 10_000 }), 0);
	assert.equal(cycleRatePerSecond({ sliceSize: 1000, done: 1200, elapsed: 1, cycleTarget: 10_000 }), 0);
});

test('cycleRatePerSecond: a spent budget is Infinity so the clamp is visible as a clamp', () => {
	// Finite-but-huge would make "at the ceiling" indistinguishable from a deliberate rate.
	assert.equal(cycleRatePerSecond({ sliceSize: 1000, done: 10, elapsed: 10_000, cycleTarget: 10_000 }), Infinity);
});

test('cycleRatePerSecond: no slice estimate means run at the ceiling and measure', () => {
	// The first cycle after a restart. A target cannot be honoured against an unknown denominator,
	// and inventing one would pace to a fiction.
	for (const sliceSize of [0, null, undefined, Number.NaN, -5]) {
		assert.equal(cycleRatePerSecond({ sliceSize, done: 0, elapsed: 0, cycleTarget: 10_000 }), Infinity);
	}
});

test('cycleRatePerSecond: no cycle target means interval mode, which never consults it', () => {
	assert.equal(cycleRatePerSecond({ sliceSize: 1000, done: 0, elapsed: 0, cycleTarget: 0 }), Infinity);
});

test('pacedRate: ratePerSecond is a CEILING that a cycle target may never lift', () => {
	// The origin ceiling is a number agreed with whoever runs the origin. No schedule of ours is a
	// reason to exceed it, so an unmeetable target is reported instead of honoured.
	const { rate, behind } = pacedRate({ ratePerSecond: 10, cycleRate: 500 });
	assert.equal(rate, 10);
	assert.equal(behind, true);
});

test('pacedRate: a reachable target paces UNDER the ceiling', () => {
	const { rate, behind } = pacedRate({ ratePerSecond: 10, cycleRate: 3 });
	assert.equal(rate, 3);
	assert.equal(behind, false);
});

test('pacedRate: a finished cycle is not "behind"', () => {
	const { rate, behind } = pacedRate({ ratePerSecond: 10, cycleRate: 0 });
	assert.equal(rate, 10);
	assert.equal(behind, false);
});

test('pacedRate: Infinity (no estimate, or budget spent) runs at the ceiling and flags it', () => {
	assert.deepEqual(pacedRate({ ratePerSecond: 7, cycleRate: Infinity }), { rate: 7, behind: true });
});

test('stepBackoff: doubles on pressure, halves on relief, clamped to [1, max]', () => {
	assert.equal(stepBackoff(1, true, 8), 2);
	assert.equal(stepBackoff(2, true, 8), 4);
	assert.equal(stepBackoff(8, true, 8), 8, 'clamped at max');
	assert.equal(stepBackoff(8, false, 8), 4);
	assert.equal(stepBackoff(1, false, 8), 1, 'never below 1');
});

test('stepBackoff: the asymmetry is the point — recovery is slower than the response', () => {
	// One bad batch reaches full backoff four times faster than four clean ones leave it.
	let up = 1;
	for (let i = 0; i < 3; i++) up = stepBackoff(up, true, 64);
	assert.equal(up, 8);
	let down = 8;
	const steps = [];
	while (down > 1) {
		down = stepBackoff(down, false, 64);
		steps.push(down);
	}
	assert.deepEqual(steps, [4, 2, 1], 'three clean batches to undo three bad ones — not one');
});

test('stepBackoff: max of 1 disables the governor entirely', () => {
	assert.equal(stepBackoff(1, true, 1), 1);
});

test('batchPause: the pause is the window MINUS what the batch already spent', () => {
	// A slow origin has already paid for its own pacing; charging it twice halves the real rate.
	const pause = batchPause({ batchSize: 10, rate: 10, originThrottle: 1, loadThrottle: 1, elapsed: 400 });
	assert.equal(pause, 600); // 10 rows at 10/s = 1000ms window, 400 already gone
});

test('batchPause: a batch that outran its window waits no further', () => {
	assert.equal(batchPause({ batchSize: 10, rate: 10, originThrottle: 1, loadThrottle: 1, elapsed: 5000 }), 0);
});

test('batchPause: the two governors MULTIPLY', () => {
	// Local pressure and origin pressure are independent causes; a node that is both busy and
	// probing a struggling origin must back off for both reasons, not the larger of them.
	const both = batchPause({ batchSize: 10, rate: 10, originThrottle: 4, loadThrottle: 2, elapsed: 0 });
	assert.equal(both, 8000); // 1000ms * 4 * 2
});

test('batchPause: an explicit Retry-After outranks our own arithmetic', () => {
	const pause = batchPause({
		batchSize: 1,
		rate: 100,
		originThrottle: 1,
		loadThrottle: 1,
		elapsed: 0,
		retryAfterMs: 30_000,
	});
	assert.equal(pause, 30_000, 'the origin named a number; guessing under it defeats the header');
});

test('batchPause: clamped to setTimeout’s 32-bit delay — the product can overflow', () => {
	// Three individually-sane values multiply past the limit, and past it setTimeout fires after
	// 1ms instead of waiting: a backoff that becomes a hot loop against an origin asking for room.
	const pause = batchPause({
		batchSize: 5000,
		rate: 1,
		originThrottle: 64,
		loadThrottle: 8,
		elapsed: 0,
	});
	assert.equal(pause, MAX_TIMER_MS, '5000 / 1 * 1000 * 64 * 8 = 2.56e9, over the 2.147e9 cap');

	// And just under it, the real value survives — a clamp that clamped everything would be a bug
	// wearing a guard's clothes.
	assert.equal(batchPause({ batchSize: 1000, rate: 1, originThrottle: 64, loadThrottle: 8, elapsed: 0 }), 512_000_000);
});
