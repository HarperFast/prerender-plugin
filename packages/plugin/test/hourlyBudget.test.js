import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { createHourlyBudget, hourlyBudgetLength } from '../src/util/hourlyBudget.js';

/**
 * The hourly budget (util/hourlyBudget.js) the entity registry's adoptions spend: one 64-bit cell per lane,
 * holding the hour and the count, shared by every worker thread through a shared buffer.
 */

const MODULE = new URL('../src/util/hourlyBudget.js', import.meta.url).href;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 2, 10, 30, 0);
const cells = (lanes = 2) =>
	new BigInt64Array(new SharedArrayBuffer(hourlyBudgetLength(lanes) * BigInt64Array.BYTES_PER_ELEMENT));

// Four real threads, released together from a gate, each try `attempts` reserves against `limit`. With `rollAt`, a
// thread's attempts from that index on are made an hour later.
const race = async (shared, { attempts, limit, rollAt = null }) => {
	const gate = new Int32Array(new SharedArrayBuffer(8)); // [ready, go]
	const runs = Array.from(
		{ length: 4 },
		() =>
			new Promise((resolve, reject) => {
				const worker = new Worker(
					`const { parentPort, workerData } = require('node:worker_threads');
					import(workerData.module).then(({ createHourlyBudget }) => {
						const budget = createHourlyBudget(() => workerData.cells);
						Atomics.add(workerData.gate, 0, 1);
						Atomics.wait(workerData.gate, 1, 0);
						const granted = [0, 0];
						for (let i = 0; i < workerData.attempts; i++) {
							const late = workerData.rollAt !== null && i >= workerData.rollAt;
							if (budget.reserve(workerData.limit, workerData.now + (late ? workerData.hour : 0), 0)) granted[late ? 1 : 0]++;
						}
						parentPort.postMessage(granted);
					});`,
					{
						eval: true,
						workerData: { module: MODULE, cells: shared, gate, attempts, limit, rollAt, now: NOW, hour: HOUR },
					}
				);
				worker.once('message', resolve);
				worker.once('error', reject);
			})
	);
	while (Atomics.load(gate, 0) < 4) await new Promise((r) => setTimeout(r, 1));
	Atomics.store(gate, 1, 1);
	Atomics.notify(gate, 1);
	return Promise.all(runs);
};

test('across real worker threads the limit holds exactly: no thread multiplies it', async () => {
	const shared = cells();
	// 200,000 attempts for a limit of 150,000: headroom for the reserves contention refuses.
	const granted = await race(shared, { attempts: 50_000, limit: 150_000 });
	assert.equal(
		granted.reduce((a, [now]) => a + now, 0),
		150_000,
		`granted ${granted.map(([n]) => n).join(' + ')} across 4 threads`
	);
	assert.equal(shared[1], 0n, 'the other lane is untouched');
});

test('the hour rolls under contention without handing out more than one hour’s budget per hour', async () => {
	// Every thread crosses into the next hour mid-run, at its own pace. The first hour grants at most its limit (a
	// thread still in it once another has rolled the cell is a straggler, and refused); the next hour grants exactly
	// its limit: no stale count from the first hour refuses it (the race a separate hour word and count word had).
	// Each hour has well over its limit in attempts: a reserve that loses eight races in a row is refused (the safe
	// direction), so "in full" needs headroom.
	const granted = await race(cells(), { attempts: 50_000, limit: 40_000, rollAt: 20_000 });
	const first = granted.reduce((a, [n]) => a + n, 0);
	const second = granted.reduce((a, [, n]) => a + n, 0);
	assert.ok(first <= 40_000, `the first hour granted ${first}`);
	assert.equal(second, 40_000, 'the next hour, in full');
});

test('lanes are independent, a release returns a slot this hour only, and the hour never moves back', () => {
	const shared = cells();
	const budget = createHourlyBudget(() => shared);
	assert.equal(budget.reserve(1, NOW, 0), true);
	assert.equal(budget.reserve(1, NOW, 0), false);
	assert.equal(budget.reserve(1, NOW, 1), true, 'lane 1 has its own count');
	budget.release(0, NOW);
	assert.equal(budget.reserve(1, NOW, 0), true, 'a released slot is spent again');
	assert.equal(budget.reserve(1, NOW + HOUR, 0), true, 'a new hour');
	assert.equal(budget.reserve(1, NOW + HOUR, 1), true, 'every lane rolls on its own first use');
	assert.equal(budget.reserve(1, NOW, 0), false, 'a straggler carrying the old hour is refused, not rolled back');
	budget.release(0, NOW);
	assert.equal(budget.reserve(1, NOW + HOUR, 0), false, 'a release for an hour already gone returns nothing');
	budget.release(0, NOW + HOUR);
	budget.release(0, NOW + HOUR);
	assert.equal(budget.reserve(2, NOW + HOUR, 0), true, 'a release never goes below zero');
	assert.equal(budget.reserve(2, NOW + HOUR, 0), true);
	assert.equal(budget.reserve(2, NOW + HOUR, 0), false);
});
