import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createHourlyBudget, hourlyBudgetLength } from '../src/util/hourlyBudget.js';

/**
 * The hourly budget (util/hourlyBudget.js) the entity registry's adoptions spend: one count per lane per hour,
 * shared by every worker thread through a shared buffer.
 */

const MODULE = new URL('../src/util/hourlyBudget.js', import.meta.url).href;
const NOW = Date.UTC(2026, 9, 2, 10, 30, 0);

test('across real worker threads the limit holds exactly: no thread multiplies it', async () => {
	const shared = new Int32Array(new SharedArrayBuffer(hourlyBudgetLength(2) * Int32Array.BYTES_PER_ELEMENT));
	const workers = 4;
	const attempts = 200;
	const limit = 150;
	const granted = await Promise.all(
		Array.from(
			{ length: workers },
			() =>
				new Promise((resolve, reject) => {
					const worker = new Worker(
						`const { parentPort, workerData } = require('node:worker_threads');
						import(workerData.module).then(({ createHourlyBudget }) => {
							const budget = createHourlyBudget(() => workerData.cell);
							let granted = 0;
							for (let i = 0; i < workerData.attempts; i++) if (budget.reserve(workerData.limit, workerData.now, 0)) granted++;
							parentPort.postMessage(granted);
						});`,
						{ eval: true, workerData: { module: MODULE, cell: shared, attempts, limit, now: NOW } }
					);
					worker.once('message', resolve);
					worker.once('error', reject);
				})
		)
	);
	assert.equal(
		granted.reduce((a, b) => a + b, 0),
		limit,
		`granted ${granted.join(' + ')} across ${workers} threads`
	);
	assert.equal(shared[2], 0, 'the other lane is untouched');
});

test('lanes are independent, a release returns a slot, and the next hour starts afresh', () => {
	const cell = new Int32Array(new SharedArrayBuffer(hourlyBudgetLength(2) * Int32Array.BYTES_PER_ELEMENT));
	const budget = createHourlyBudget(() => cell);
	assert.equal(budget.reserve(1, NOW, 0), true);
	assert.equal(budget.reserve(1, NOW, 0), false);
	assert.equal(budget.reserve(1, NOW, 1), true, 'lane 1 has its own count');
	budget.release(0);
	assert.equal(budget.reserve(1, NOW, 0), true, 'a released slot is spent again');
	assert.equal(budget.reserve(1, NOW + 3_600_000, 0), true, 'a new hour');
	assert.equal(budget.reserve(1, NOW + 3_600_000, 1), true, 'every lane rolls');
	// A straggler carrying the old hour does not zero what the new hour has spent.
	assert.equal(budget.reserve(1, NOW, 0), false);
	budget.release(0);
	budget.release(0);
	assert.equal(cell[1], 0, 'a release never goes below zero');
});
