import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * `readLag` only, which is the part with a failure mode worth a test.
 *
 * The monitor around it is a libuv histogram plus a `setInterval`; exercising that would test node,
 * not this. What is worth pinning is that an EMPTY window cannot emit `Infinity`: `recordAnalytics`
 * aggregates by mean, so a single `Infinity` makes the merged row's mean `Infinity` for that period
 * across every worker — the series reads as catastrophic while nothing is wrong, and it is the sort
 * of thing that gets discovered from a dashboard weeks later.
 */
const { readLag } = await import('../src/util/eventLoopLag.js');

const fake = (p99ns, maxns) => ({ percentile: () => p99ns, max: maxns });

test('readLag converts nanoseconds to ms', () => {
	assert.deepEqual(readLag(fake(12_000_000, 53_000_000)), { p99: 12, max: 53 });
});

test('an empty window emits NOTHING rather than Infinity', () => {
	// What node actually returns for a histogram with no samples.
	assert.deepEqual(readLag(fake(Infinity, Infinity)), {});
	// And the mixed case: a max but no percentile, or the reverse, each drops only the bad half.
	assert.deepEqual(readLag(fake(Infinity, 8_000_000)), { max: 8 });
	assert.deepEqual(readLag(fake(4_000_000, Infinity)), { p99: 4 });
});

test('NaN is dropped too, not emitted as a reading', () => {
	assert.deepEqual(readLag(fake(NaN, NaN)), {});
});

test('a zero-lag window is a real reading and must be kept', () => {
	// Distinct from empty: libuv sampled and found no delay. Dropping it would make an idle worker
	// indistinguishable from one whose monitor is broken.
	assert.deepEqual(readLag(fake(0, 0)), { p99: 0, max: 0 });
});
