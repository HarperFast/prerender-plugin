import { test } from 'node:test';
import assert from 'node:assert/strict';
import RenderWorker from '../dist/Worker.js';
import logger from '../dist/util/Logger.js';

/**
 * The stats line's `throughput.failures` is the count alerts and operators read. It must include every
 * render-failure bucket — navigation timeouts were split out of `timeout` and silently dropped from the sum,
 * so the line read 0 failures while navigations timed out — and leave out only our own teardown.
 */
test('throughput.failures sums every render-failure bucket, navigation timeouts included, teardown excluded', async (t) => {
	const worker = new RenderWorker({ renderer: async () => undefined });
	const logged: Record<string, unknown>[] = [];
	t.mock.method(logger, 'info', (o: Record<string, unknown>) => {
		logged.push(o);
	});
	try {
		const stats = (worker as unknown as { stats: { failures: Record<string, number> } }).stats;
		Object.assign(stats.failures, {
			timeout: 1,
			navTimeout: 2,
			protocol: 3,
			tooManyRedirects: 4,
			getPageFailed: 5,
			other: 6,
			shutdownAborted: 100,
		});
		worker.logStats();
	} finally {
		await worker.destroy();
	}
	const line = logged.find((o) => o.throughput) as {
		throughput: { failures: number; failuresByType: Record<string, number> };
	};
	assert.ok(line, 'a stats line was logged');
	assert.equal(line.throughput.failures, 1 + 2 + 3 + 4 + 5 + 6);
	assert.equal(line.throughput.failuresByType.shutdownAborted, 100, 'still reported, in its own bucket');
});
