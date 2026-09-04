import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import RenderJob from '../dist/RenderJob.js';
import { resolveSettings } from '../dist/settings.js';

// The job-result wire shape — the contract the plugin's processJobResult consumes.
//
// `outcome` is the ONE decision field ('rendered' | 'redirected' | 'non-indexable' | 'error');
// `isIndexable` rides along as a property of a rendered page, `reason` says why there is no
// content, and `error` carries the failed attempt's detail. These tests post through the real
// sendResult() (gzip, metadata framing and all) and assert what actually lands on the wire.

let server: http.Server;
let callbackOrigin = '';

// Metadata of every result the fake queue endpoint received.
const posted: Record<string, unknown>[] = [];

before(async () => {
	resolveSettings({ harper: {} }, { requireHarper: false });

	server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => {
			const body = Buffer.concat(chunks);
			const metadataSize = parseInt(String(req.headers['x-metadata-size']));
			posted.push(JSON.parse(body.subarray(0, metadataSize).toString('utf8')));
			res.writeHead(204);
			res.end();
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	callbackOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
	await new Promise<void>((r) => server.close(() => r()));
});

const makeJob = () =>
	new RenderJob({
		id: 'https://site.example.com/product/x|desktop',
		url: 'https://site.example.com/product/x',
		expiresAt: Date.now() + 60_000,
		deviceType: 'desktop',
		callbackOrigin,
		isFromSitemap: false,
	});

const send = async (job: RenderJob) => {
	posted.length = 0;
	assert.equal(await job.sendResult(), true, 'result must be delivered');
	return posted[0];
};

test('a successful render posts outcome=rendered with no reason', async () => {
	const job = makeJob();
	job.attemptStarted();
	job.httpResponse = { statusCode: 200, headers: { 'content-type': 'text/html' } };
	job.isIndexable = true;
	job.attemptEnded(undefined, '<html>ok</html>');

	const meta = await send(job);
	assert.equal(meta.outcome, 'rendered');
	assert.equal(meta.isIndexable, true);
	assert.equal(meta.reason, undefined);
	assert.equal(meta.error, undefined);
});

test('a navigation-bailed redirect posts outcome=redirected with the hop status', async () => {
	const job = makeJob();
	job.attemptStarted();
	job.httpResponse = { statusCode: 301, headers: {} };
	job.redirectedTo = 'https://site.example.com/product/y';
	job.attemptEnded(undefined, undefined);

	const meta = await send(job);
	assert.equal(meta.outcome, 'redirected');
	assert.equal(meta.statusCode, 301);
	assert.equal(meta.reason, 'redirect');
	assert.equal(meta.redirectedTo, 'https://site.example.com/product/y');
});

test('a rendered-through client-side redirect is still outcome=rendered', async () => {
	const job = makeJob();
	job.attemptStarted();
	job.httpResponse = { statusCode: 200, headers: {} };
	job.redirectedTo = 'https://site.example.com/product/y';
	job.isIndexable = true;
	job.attemptEnded(undefined, '<html>landed</html>');

	const meta = await send(job);
	assert.equal(meta.outcome, 'rendered', 'content wins — the plugin refiles it, not the redirect path');
	assert.equal(meta.reason, undefined);
});

test('a noindex page posts outcome=non-indexable with the reason', async () => {
	const job = makeJob();
	job.attemptStarted();
	job.httpResponse = { statusCode: 200, headers: {} };
	job.isIndexable = false;
	job.reason = 'noindex';
	job.attemptEnded(undefined, undefined);

	const meta = await send(job);
	assert.equal(meta.outcome, 'non-indexable');
	assert.equal(meta.isIndexable, false);
	assert.equal(meta.reason, 'noindex');
});

test('a failed render posts outcome=error with the attempt error and derived reason', async () => {
	const job = makeJob();
	job.attemptStarted();
	job.attemptEnded(new Error('Navigation timeout of 30000 ms exceeded'), undefined);

	const meta = await send(job);
	assert.equal(meta.outcome, 'error');
	assert.equal(meta.reason, 'error', 'reason falls back to the error class without producers setting it');
	assert.deepEqual(
		{ name: (meta.error as { name: string }).name, message: (meta.error as { message: string }).message },
		{ name: 'Error', message: 'Navigation timeout of 30000 ms exceeded' }
	);
});

// The per-page origin factor (HarperFast/prerender-plugin#153). The plugin reads an ABSENT
// `subrequests` as "this renderer predates the measurement", so a tally must ride every result
// that had an attempt — including one that never reached content — and `scriptsStripped` must
// say what this fleet does to the snapshot, since that is what turns the factor from a cost into
// a saving at serve time.
test('a render posts its same-origin subrequest tally and whether the snapshot keeps its scripts', async () => {
	const job = makeJob();
	const attempt = job.attemptStarted();
	attempt.subrequests = { sameOrigin: 12, cacheable: 7, uncacheable: 4, unspecified: 1, blocked: 3 };
	job.httpResponse = { statusCode: 200, headers: {} };
	job.attemptEnded(undefined, '<html>ok</html>');

	const meta = await send(job);
	assert.deepEqual(meta.subrequests, { sameOrigin: 12, cacheable: 7, uncacheable: 4, unspecified: 1, blocked: 3 });
	// The default config strips scripts; the field is the fleet's setting, posted as a boolean.
	assert.equal(meta.scriptsStripped, true);
});

test('a result that never reached content still carries the partial tally', async () => {
	const job = makeJob();
	const attempt = job.attemptStarted();
	attempt.subrequests = { sameOrigin: 2, cacheable: 1, uncacheable: 1, unspecified: 0, blocked: 0 };
	job.attemptEnded(new Error('Navigation timeout of 30000 ms exceeded'), undefined);

	const meta = await send(job);
	assert.equal(meta.outcome, 'error');
	assert.deepEqual(meta.subrequests, { sameOrigin: 2, cacheable: 1, uncacheable: 1, unspecified: 0, blocked: 0 });
});
