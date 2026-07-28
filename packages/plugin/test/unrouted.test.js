import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyOptions } from '../src/config.js';
import { bucketOf, drainUnroutedReport, logUnroutedReport, recordUnroutedPath } from '../src/util/unrouted.js';
import { PASSTHROUGH, PRERENDER, UNCLASSIFIED } from '../src/util/routeClass.js';

beforeEach(() => {
	applyOptions({});
	drainUnroutedReport(); // start each test from an empty tally
});

test('buckets by first path segment', () => {
	assert.equal(bucketOf('/'), '/');
	assert.equal(bucketOf(''), '/');
	assert.equal(bucketOf('/foo'), '/foo');
	assert.equal(bucketOf('/help/contact-us'), '/help/*');
	assert.equal(bucketOf('/help/'), '/help/*');
	assert.equal(bucketOf('/a/b/c/d'), '/a/*');
});

test('counts per class and bucket, keeping a sample path', () => {
	recordUnroutedPath(UNCLASSIFIED, '/help/contact-us', 'cdn');
	recordUnroutedPath(UNCLASSIFIED, '/help/returns', 'cdn');
	recordUnroutedPath(PASSTHROUGH, '/orders/history', 'cdn');

	const report = drainUnroutedReport();
	assert.equal(report[UNCLASSIFIED].length, 1);
	assert.equal(report[UNCLASSIFIED][0].bucket, '/help/*');
	assert.equal(report[UNCLASSIFIED][0].count, 2);
	assert.equal(report[UNCLASSIFIED][0].samplePath, '/help/contact-us');
	assert.equal(report[PASSTHROUGH].length, 1);
	assert.equal(report.overflowed, 0);
});

test('ignores the prerender class — a prerendered path is not a finding', () => {
	recordUnroutedPath(PRERENDER, '/catalog/girls.jsp', 'cdn');
	const report = drainUnroutedReport();
	assert.equal(report[UNCLASSIFIED].length, 0);
	assert.equal(report[PASSTHROUGH].length, 0);
});

test('separates a redirect-sourced finding from CDN traffic in the same bucket', () => {
	recordUnroutedPath(UNCLASSIFIED, '/help/x', 'cdn');
	recordUnroutedPath(UNCLASSIFIED, '/help/x', 'redirect');
	const buckets = drainUnroutedReport()[UNCLASSIFIED].map((row) => row.bucket);
	assert.deepEqual(buckets.sort(), ['/help/*', '/help/* (redirect)']);
});

test('sorts by count descending', () => {
	recordUnroutedPath(UNCLASSIFIED, '/rare/x', 'cdn');
	for (let i = 0; i < 5; i++) recordUnroutedPath(UNCLASSIFIED, '/common/x', 'cdn');

	const rows = drainUnroutedReport()[UNCLASSIFIED];
	assert.deepEqual(
		rows.map((row) => row.bucket),
		['/common/*', '/rare/*']
	);
});

test('counts into an overflow tally past maxBuckets instead of evicting', () => {
	// Bounded on purpose: "unclassified" means the shape is unknown, so a per-URL counter
	// would be unbounded. Overflow still counts, so the reported volume is never a lie.
	applyOptions({ ingress: { report: { maxBuckets: 2 } } });
	recordUnroutedPath(UNCLASSIFIED, '/a/x', 'cdn');
	recordUnroutedPath(UNCLASSIFIED, '/b/x', 'cdn');
	recordUnroutedPath(UNCLASSIFIED, '/c/x', 'cdn');
	recordUnroutedPath(UNCLASSIFIED, '/d/x', 'cdn');
	// An already-known bucket still increments after the cap is reached.
	recordUnroutedPath(UNCLASSIFIED, '/a/y', 'cdn');

	const report = drainUnroutedReport();
	assert.equal(report[UNCLASSIFIED].length, 2);
	assert.equal(report.overflowed, 2);
	assert.equal(report[UNCLASSIFIED].find((row) => row.bucket === '/a/*').count, 2);
});

test('records nothing when reporting is disabled', () => {
	applyOptions({ ingress: { report: { enabled: false } } });
	recordUnroutedPath(UNCLASSIFIED, '/help/x', 'cdn');
	assert.equal(drainUnroutedReport()[UNCLASSIFIED].length, 0);
});

test('draining resets the tally, so each report is a rate for the interval', () => {
	recordUnroutedPath(UNCLASSIFIED, '/help/x', 'cdn');
	assert.equal(drainUnroutedReport()[UNCLASSIFIED].length, 1);
	assert.equal(drainUnroutedReport()[UNCLASSIFIED].length, 0);
});

test('logs one line per class, with node and worker, and stays silent when empty', () => {
	const lines = [];
	globalThis.server = { hostname: 'node-1', workerIndex: 3 };
	globalThis.logger = { warn: (message) => lines.push(message), error: () => {} };

	try {
		logUnroutedReport();
		assert.deepEqual(lines, [], 'nothing seen => nothing logged');

		recordUnroutedPath(UNCLASSIFIED, '/help/contact-us', 'cdn');
		recordUnroutedPath(PASSTHROUGH, '/orders/history', 'cdn');
		logUnroutedReport();

		assert.equal(lines.length, 2);
		assert.match(lines[0], /unclassified: 1 request\(s\)/);
		assert.match(lines[0], /node=node-1 worker=3/);
		assert.match(lines[0], /\/help\/\* ×1 \(e\.g\. \/help\/contact-us\)/);
		assert.match(lines[1], /passthrough: 1 request\(s\)/);
	} finally {
		delete globalThis.server;
		delete globalThis.logger;
	}
});

afterEach(() => {
	drainUnroutedReport();
});

test('bucketOf never throws on a non-string, so reporting cannot break the read path', () => {
	for (const bad of [null, undefined, 42, {}, []]) {
		assert.equal(bucketOf(bad), '/');
	}
});
