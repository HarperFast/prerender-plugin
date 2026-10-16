// One "Harper worker" for test/health.test.js: the real util/health.js over shared buffers handed in by the
// test, so the counters and the boundary claim are exercised by real threads on real shared memory. The
// test runner also loads every file under test/ as a test; outside a worker this file does nothing.
import { isMainThread, parentPort, workerData } from 'node:worker_threads';

if (!isMainThread) await runWorker();

async function runWorker() {
	const { buffers, options, perWorker, boundaryMs } = workerData;

	globalThis.Resource = class {};
	globalThis.server = { hostname: 'test-node', workerIndex: workerData.index, nodes: [], recordAnalytics() {} };
	// Only the health line is collected: applying options can log warnings of its own.
	const logged = [];
	const collect = (line) => {
		if (typeof line === 'string' && line.startsWith('[prerender] health ')) logged.push(line);
	};
	globalThis.logger = { debug() {}, info: collect, warn: collect, notify: collect, error() {} };
	globalThis.databases = {
		coordination: {
			SharedBuffer: {
				primaryStore: {
					getUserSharedBuffer: (key) => {
						if (!buffers[key]) throw new Error(`no shared buffer was handed in for ${key}`);
						return buffers[key];
					},
					tryLock: () => true,
					unlock() {},
				},
			},
		},
	};

	const { applyOptions } = await import('../../src/config.js');
	applyOptions(options);
	const { countServe, writeIfClaimedForTest } = await import('../../src/util/health.js');

	parentPort.once('message', async () => {
		for (let i = 0; i < perWorker; i++) {
			countServe({ route: i % 2 ? '/a/' : '/b/', source: i % 3 ? 'cache' : 'origin', status: 200, ms: 1 });
		}
		const wrote = await writeIfClaimedForTest(boundaryMs);
		parentPort.postMessage({ wrote, logged });
	});
	parentPort.postMessage('ready');
}
