import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HLL_REGISTERS, createSketch, addToSketch, mergeSketch, estimateSketch, hash53 } from '../src/util/hll.js';

/**
 * The properties the crawl-breadth metric leans on:
 *   - estimates land within tolerance at small (linear-counting), mid, and large
 *     cardinalities — standard error at p=14 is ~0.8%, asserted here at 3% to keep the
 *     test deterministic-in-practice without being flaky;
 *   - duplicates never move the estimate (the whole point vs a counter);
 *   - merge is EXACTLY the sketch of the union, byte for byte — the property that makes
 *     per-thread/per-node shards a lossless decomposition of one global sketch.
 */

const url = (i) => `https://site.example.com/product/${i}?variant=${i % 7}`;

const sketchOf = (from, to) => {
	const s = createSketch();
	for (let i = from; i < to; i++) addToSketch(s, url(i));
	return s;
};

const assertWithin = (estimate, actual, tolerance) => {
	const error = Math.abs(estimate - actual) / actual;
	assert.ok(error <= tolerance, `estimate ${estimate} vs actual ${actual}: error ${(error * 100).toFixed(2)}%`);
};

test('hash53 is deterministic and spreads', () => {
	assert.equal(hash53('https://site.example.com/a'), hash53('https://site.example.com/a'));
	assert.notEqual(hash53('https://site.example.com/a'), hash53('https://site.example.com/b'));
	assert.ok(Number.isSafeInteger(hash53('x'.repeat(2000))));
});

test('empty sketch estimates zero', () => {
	assert.equal(estimateSketch(createSketch()), 0);
});

test('small cardinality (linear-counting range) is accurate', () => {
	// A day's sketch for a low-traffic bot lives here, so this range matters most.
	assertWithin(estimateSketch(sketchOf(0, 100)), 100, 0.03);
	assertWithin(estimateSketch(sketchOf(0, 5000)), 5000, 0.03);
});

test('mid and large cardinality are accurate', () => {
	assertWithin(estimateSketch(sketchOf(0, 100_000)), 100_000, 0.03);
	// The full-corpus scale (~10^6 URLs).
	assertWithin(estimateSketch(sketchOf(0, 1_000_000)), 1_000_000, 0.03);
});

test('duplicates never move the estimate', () => {
	const once = sketchOf(0, 10_000);
	const thrice = createSketch();
	for (let pass = 0; pass < 3; pass++) {
		for (let i = 0; i < 10_000; i++) addToSketch(thrice, url(i));
	}
	assert.deepEqual(thrice, once);
});

test('merge is byte-for-byte the sketch of the union', () => {
	// Overlapping shards: [0, 60k) and [40k, 100k) — 20k shared URLs must collapse.
	const a = sketchOf(0, 60_000);
	const b = sketchOf(40_000, 100_000);
	const merged = mergeSketch(new Uint8Array(a), b);
	assert.deepEqual(merged, sketchOf(0, 100_000));
	assertWithin(estimateSketch(merged), 100_000, 0.03);
});

test('merge order and grouping are irrelevant', () => {
	const shards = [sketchOf(0, 10_000), sketchOf(5000, 20_000), sketchOf(15_000, 30_000)];
	const forward = createSketch();
	for (const s of shards) mergeSketch(forward, s);
	const backward = createSketch();
	for (const s of [...shards].reverse()) mergeSketch(backward, s);
	assert.deepEqual(forward, backward);
	assert.equal(forward.length, HLL_REGISTERS);
});
