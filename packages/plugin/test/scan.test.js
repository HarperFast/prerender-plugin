import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyOptions } from '../src/config.js';
import { applyInBatches, collectFromScan } from '../src/util/scan.js';

beforeEach(() => applyOptions({}));

const rows = (n) => Array.from({ length: n }, (_, i) => ({ cacheKey: `k${i}` }));
const streamOf = (items) =>
	async function* () {
		for (const item of items) yield item;
	};

test('collects what pick returns and skips null/undefined', () => {
	return collectFromScan({
		scan: streamOf(rows(5)),
		pick: (row) => (row.cacheKey === 'k2' ? null : row.cacheKey),
		onYield: () => Promise.resolve(),
	}).then(({ items, examined, truncated }) => {
		assert.deepEqual(items, ['k0', 'k1', 'k3', 'k4']);
		assert.equal(examined, 5);
		assert.equal(truncated, false);
	});
});

test('an async pick is awaited (the sitemap prune classifies per row)', async () => {
	const { items } = await collectFromScan({
		scan: streamOf(rows(3)),
		pick: async (row) => row.cacheKey.toUpperCase(),
		onYield: () => Promise.resolve(),
	});
	assert.deepEqual(items, ['K0', 'K1', 'K2']);
});

test('the cap bounds memory but NOT scanning, so the count stays honest', async () => {
	const { items, examined, truncated } = await collectFromScan({
		scan: streamOf(rows(50)),
		pick: (row) => row.cacheKey,
		cap: 10,
		onYield: () => Promise.resolve(),
	});
	assert.equal(items.length, 10);
	// The walk still ran to completion — a repair/prune pass that silently under-reports the size
	// of the problem is worse than one that reports it and fixes part of it.
	assert.equal(examined, 50);
	assert.equal(truncated, true);
});

test('yields on rows SCANNED, not on rows collected', async () => {
	// A walk that collects almost nothing (the healthy case) must still yield, or it starves the
	// event loop: `await` on a cursor drains microtasks without letting timers or I/O run.
	let yields = 0;
	await collectFromScan({
		scan: streamOf(rows(100)),
		pick: () => null, // collects nothing at all
		yieldEvery: 10,
		onYield: () => {
			yields++;
			return Promise.resolve();
		},
	});
	assert.equal(yields, 10);
});

test('issues no writes while the scan is open', async () => {
	// The whole point: a write pending when Harper's long-transaction monitor fires gets the
	// transaction aborted and poisoned. This asserts the phases cannot interleave.
	const events = [];
	const scan = async function* () {
		for (const row of rows(3)) {
			events.push(`read:${row.cacheKey}`);
			yield row;
		}
		events.push('cursor-closed');
	};

	const { items } = await collectFromScan({ scan, pick: (r) => r.cacheKey, onYield: () => Promise.resolve() });
	await applyInBatches({
		items,
		apply: (cacheKey) => {
			events.push(`write:${cacheKey}`);
			return Promise.resolve();
		},
		onYield: () => Promise.resolve(),
	});

	assert.equal(events.indexOf('cursor-closed') < events.indexOf('write:k0'), true, 'a write preceded cursor close');
	assert.deepEqual(events, ['read:k0', 'read:k1', 'read:k2', 'cursor-closed', 'write:k0', 'write:k1', 'write:k2']);
});

test('applyInBatches fully drains each batch before starting the next', async () => {
	// `await lastPromise` was the old pattern and left the rest of the batch in flight. Every
	// promise in a batch must settle, or writes still span a monitor tick.
	let inFlight = 0;
	let maxInFlight = 0;
	const applied = await applyInBatches({
		items: Array.from({ length: 25 }, (_, i) => i),
		batchSize: 10,
		apply: async () => {
			maxInFlight = Math.max(maxInFlight, ++inFlight);
			await Promise.resolve();
			inFlight--;
		},
		onYield: () => Promise.resolve(),
	});
	assert.equal(applied, 25);
	assert.equal(maxInFlight <= 10, true, `batch overran: ${maxInFlight} in flight`);
	assert.equal(inFlight, 0);
});

test('applyInBatches passes the absolute index, not the in-batch index', async () => {
	const seen = [];
	await applyInBatches({
		items: ['a', 'b', 'c', 'd', 'e'],
		batchSize: 2,
		apply: (item, index) => {
			seen.push(`${index}:${item}`);
			return Promise.resolve();
		},
		onYield: () => Promise.resolve(),
	});
	assert.deepEqual(seen, ['0:a', '1:b', '2:c', '3:d', '4:e']);
});

test('a rejecting batch propagates rather than looking like a clean pass', async () => {
	await assert.rejects(
		applyInBatches({
			items: [1, 2, 3],
			batchSize: 2,
			apply: (item) => (item === 2 ? Promise.reject(new Error('poisoned')) : Promise.resolve()),
			onYield: () => Promise.resolve(),
		}),
		/poisoned/
	);
});

test('empty input is a no-op for both phases', async () => {
	const { items, examined, truncated } = await collectFromScan({
		scan: streamOf([]),
		pick: (r) => r,
		onYield: () => Promise.resolve(),
	});
	assert.deepEqual(items, []);
	assert.equal(examined, 0);
	assert.equal(truncated, false);
	assert.equal(await applyInBatches({ items: [], apply: () => Promise.reject(new Error('never')) }), 0);
});
