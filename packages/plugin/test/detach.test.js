import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { runDetached } from '../src/util/detach.js';

/**
 * Work a request starts and does not wait for must not run on the request's transaction (util/detach.js):
 * Harper closes it after the response, and every read the work makes on it aborts. Measured on Harper
 * 5.2.14: a probe pass started from the admin endpoint lost 1 to 11 page reads per pass, none once
 * detached.
 */

test('runDetached runs outside the caller’s async context — and stays outside across awaits', async () => {
	const requestContext = new AsyncLocalStorage();
	const seen = await requestContext.run({ transaction: 'the request’s' }, async () => {
		assert.deepEqual(requestContext.getStore(), { transaction: 'the request’s' });
		return runDetached(async () => {
			const before = requestContext.getStore();
			await new Promise((resolve) => setTimeout(resolve, 1));
			return { before, after: requestContext.getStore() };
		});
	});
	assert.deepEqual(seen, { before: undefined, after: undefined });
});

test('runDetached returns what the function returns, so a handler can await a start acknowledgement', async () => {
	assert.equal(
		runDetached(() => 42),
		42
	);
	assert.equal(await runDetached(async () => 'started'), 'started');
});

test('every admin action that starts work it does not wait for starts it detached', () => {
	const source = readFileSync(new URL('../src/resources/PrerenderAdmin.js', import.meta.url), 'utf8');
	const starts = [
		'runReconcileOnce',
		'runOrphanSweepOnce',
		'startPageOrphanSweep',
		'startDiscoveredPurge',
		'runProbeSweepOnce',
		'runProbeCanaryOnce',
		'runBacklogSnapshotOnce',
		'startSitemapRefreshInBackground',
	];
	for (const name of starts) {
		const calls = [...source.matchAll(new RegExp(`\\b${name}\\(`, 'g'))];
		assert.ok(calls.length > 0, `${name} is no longer called here — update this list`);
		for (const call of calls) {
			const before = source.slice(Math.max(0, call.index - 200), call.index);
			const opened = before.lastIndexOf('runDetached(');
			// inside the same statement as a runDetached( that opened before it: no `;` in between
			assert.ok(
				opened >= 0 && !before.slice(opened).includes(';'),
				`${name}(…) is called outside runDetached — started inline it runs on the request's transaction`
			);
		}
	}
});

test('the sitemap background refresh starts its walks detached', () => {
	const source = readFileSync(new URL('../src/resources/Sitemap.js', import.meta.url), 'utf8');
	const start = source.indexOf('export async function startSitemapRefreshInBackground');
	const body = source.slice(start, source.indexOf('\n}\n', start));
	assert.ok(start >= 0 && body.includes('runDetached('), 'the background walks go through runDetached');
	assert.doesNotMatch(body, /void runTrackedRefresh\(|void \(async/, 'no walk started inline');
});
