import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMetrics } from '../dist/metrics.js';

// A refused endpoint (port 1) makes any export fail fast (ECONNREFUSED) so the "export is
// swallowed" path is exercised without a real collector or a slow socket timeout. A short
// interval keeps exportTimeoutMillis small so shutdown()'s final flush can't stall the test.
const REFUSED_ENDPOINT = 'http://127.0.0.1:1/v1/metrics';
// Short interval → small export timeout, so the shutdown flush against the dead endpoint
// returns fast instead of retrying for the exporter's multi-second default.
const OPTS = { enabled: true, otlpEndpoint: REFUSED_ENDPOINT, exportIntervalMs: 250, headers: {} };

const SNAPSHOT = {
	completed: 5,
	succeeded: 4,
	emptyContent: 1,
	fromSitemap: 2,
	failures: { timeout: 1, protocol: 0, tooManyRedirects: 0, getPageFailed: 0, other: 0 },
	expiredSkipped: 0,
	concurrencyBlocked: 3,
	rpsDelayed: 0,
	resultPostFailures: 1,
	browserLaunches: 1,
	browserRetirements: 0,
	renderTimes: [1200, 9800, 15000],
	navTtfb: [600],
	navTotal: [1800],
	settle: [9000, 9500],
	postProcess: [200],
};

const GAUGES = {
	inflight: 3,
	concurrency: 8,
	retiredBrowsers: 0,
	rssBytes: 123456,
	workerCores: 4.2,
	nodeCores: null,
	browserCores: null,
	cacheHitRate: 0.87,
};

test('record() and shutdown() never throw, even with the collector unreachable', async () => {
	const recorder = await createMetrics(OPTS, { workerId: 'test-worker-1' });
	assert.doesNotThrow(() => recorder.record(SNAPSHOT, GAUGES));
	// A second window must fold in cleanly (cumulative counters, more histogram samples).
	assert.doesNotThrow(() => recorder.record(SNAPSHOT, GAUGES));
	// shutdown() flushes once to the refused endpoint; it must resolve, not reject.
	await recorder.shutdown();
});

test('record() tolerates an all-zero window and null CPU/cache gauges', async () => {
	const recorder = await createMetrics(OPTS, { workerId: 'test-worker-2' });
	const zeroSnapshot = {
		completed: 0,
		succeeded: 0,
		emptyContent: 0,
		fromSitemap: 0,
		failures: { timeout: 0, protocol: 0, tooManyRedirects: 0, getPageFailed: 0, other: 0 },
		expiredSkipped: 0,
		concurrencyBlocked: 0,
		rpsDelayed: 0,
		resultPostFailures: 0,
		browserLaunches: 0,
		browserRetirements: 0,
		renderTimes: [],
		navTtfb: [],
		navTotal: [],
		settle: [],
		postProcess: [],
	};
	const nullGauges = {
		inflight: 0,
		concurrency: 8,
		retiredBrowsers: 0,
		rssBytes: 0,
		workerCores: null,
		nodeCores: null,
		browserCores: null,
		cacheHitRate: null,
	};
	assert.doesNotThrow(() => recorder.record(zeroSnapshot, nullGauges));
	await recorder.shutdown();
});
