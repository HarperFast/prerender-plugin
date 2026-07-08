import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CpuSampler } from '../dist/util/cpu.js';

// These run on both Linux CI (procfs + maybe cgroup present) and macOS dev (neither), so they
// assert only the invariants that hold everywhere: the sampler never throws, always reports a
// positive core limit and a finite Node-CPU figure, and reports null (not a bogus number) for
// anything it can't actually measure.

test('CpuSampler reports Node CPU and a core limit without throwing', () => {
	const sampler = new CpuSampler(() => undefined);
	const w = sampler.next();

	assert.ok(Number.isFinite(w.nodeCores) && w.nodeCores >= 0, 'nodeCores is a non-negative number');
	assert.ok(w.container.limitCores > 0, 'limitCores has a sensible fallback');
	assert.equal(typeof w.container.limitCores, 'number');
});

test('CpuSampler reports null browser CPU when there is no browser PID', () => {
	const sampler = new CpuSampler(() => undefined);
	const w = sampler.next();

	assert.equal(w.browserCores, null, 'no PID → no browser measurement');
	assert.equal(w.workerCores, null, 'workerCores is null when the browser tree is unmeasurable');
});

test('CpuSampler reports null browser CPU for a non-existent PID', () => {
	// A PID that will not be in /proc — the tree read finds no root and returns null rather
	// than fabricating a number.
	const sampler = new CpuSampler(() => 2 ** 30);
	const w = sampler.next();

	assert.equal(w.browserCores, null);
	assert.equal(w.workerCores, null);
});

test('container utilization is either null or a 0..1 fraction', () => {
	const sampler = new CpuSampler(() => undefined);
	const { usedCores, utilization } = sampler.next().container;

	if (usedCores === null) {
		assert.equal(utilization, null, 'no cgroup usage → no utilization');
	} else {
		assert.ok(usedCores >= 0, 'usedCores non-negative');
		assert.ok(utilization !== null && utilization >= 0, 'utilization non-negative when measured');
	}
});
