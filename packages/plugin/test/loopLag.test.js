import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loopLagMonitorState, readLoopLagMs, startLoopLagMonitor, stopLoopLagMonitor } from '../src/util/loopLag.js';

afterEach(() => stopLoopLagMonitor());

const block = (ms) => {
	const until = Date.now() + ms;
	while (Date.now() < until) {
		// Deliberately synchronous: this is the shape of stall the governor exists to notice —
		// a native call that holds the thread, not an await that yields it.
	}
};

test('an unstarted monitor reads null, and null is not zero', () => {
	// The distinction the pacer depends on: absent means "no reason to slow down", a zero reading
	// would mean "measured, and the loop is fine".
	assert.equal(readLoopLagMs(), null);
	assert.deepEqual(loopLagMonitorState(), { running: false, unavailable: false });
});

test('starting is idempotent', () => {
	assert.equal(startLoopLagMonitor(10), true);
	assert.equal(startLoopLagMonitor(10), true);
	assert.equal(loopLagMonitorState().running, true);
});

test('the sampling floor is SUBTRACTED from every reading', async () => {
	// THE TRAP THIS MODULE ABSORBS. The raw histogram reads back at roughly its own resolution on
	// an idle loop, so at resolution 20 a raw threshold under 20ms trips on a node doing nothing.
	//
	// Asserted as ARITHMETIC on the reading's own `raw`/`floor` rather than as an absolute idle
	// value: this suite runs its files in parallel, so the loop under test is never actually idle
	// and any absolute claim would be a flake. The calibration numbers live in the module doc,
	// where they were measured deliberately.
	for (const resolution of [5, 10, 20]) {
		stopLoopLagMonitor();
		startLoopLagMonitor(resolution);
		await new Promise((r) => setTimeout(r, 120));
		const reading = readLoopLagMs();
		assert.ok(reading, `resolution ${resolution}: expected samples`);
		assert.equal(reading.floor, resolution, 'the floor is the configured resolution');
		assert.equal(reading.p95, Math.max(0, reading.raw.p95 - resolution));
		assert.equal(reading.mean, Math.max(0, reading.raw.mean - resolution));
		assert.ok(reading.p95 >= 0, 'a corrected reading is never negative');
		assert.ok(reading.raw.p95 >= resolution * 0.5, 'the raw value carries the floor the correction removes');
	}
});

test('a BLOCKED loop reads the block, well clear of the idle floor', async () => {
	startLoopLagMonitor(10);
	await new Promise((r) => setTimeout(r, 100));
	readLoopLagMs(); // discard the idle window

	for (let i = 0; i < 4; i++) {
		block(40);
		await new Promise((r) => setTimeout(r, 10));
	}
	const reading = readLoopLagMs();
	assert.ok(reading, 'expected samples');
	assert.ok(reading.p95 > 20, `expected the 40ms blocks to show; got p95 ${reading.p95}ms`);
});

test('reading RESETS the window — the governor must see now, not all-time', async () => {
	// An un-reset histogram reports the worst thing that ever happened on this thread, and a
	// governor fed all-time data never recovers once anything has ever stalled.
	startLoopLagMonitor(5);
	await new Promise((r) => setTimeout(r, 60));
	readLoopLagMs(); // discard the warm-up window

	// Blocks interleaved with turns of the loop — a sample can only be recorded once the loop
	// runs again, so the stall has to be surrounded by yields to be observable at all.
	for (let i = 0; i < 4; i++) {
		block(40);
		await new Promise((r) => setTimeout(r, 10));
	}
	const spike = readLoopLagMs();
	assert.ok(spike && spike.p95 > 20, `expected the spike; got ${JSON.stringify(spike)}`);

	await new Promise((r) => setTimeout(r, 150));
	const after = readLoopLagMs();
	assert.ok(after, 'expected samples in the quiet window');
	assert.ok(after.p95 < spike.p95, `the quiet window must not inherit the spike (${after.p95} vs ${spike.p95})`);
});

test('stopping drops the monitor, and reading after it is null again', () => {
	startLoopLagMonitor(10);
	stopLoopLagMonitor();
	assert.equal(readLoopLagMs(), null);
	assert.equal(loopLagMonitorState().running, false);
});
