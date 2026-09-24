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

// ── multi-device results (plugin >= 0.66.0) ──────────────────────────────────────────────────────
//
// One job per URL, every device rendered in turn, ONE result back: `{ id, url, deviceTypes,
// variants: [...] }` followed by the variants' encoded bodies concatenated in order, each variant
// saying how many of those bytes are its own. These tests post through the real
// `sendVariantsResult` and decode the wire exactly as the plugin does.

import { gunzipSync } from 'node:zlib';

// The raw bytes of every result the fake queue endpoint received, beside `posted`.
const postedBodies: Buffer[] = [];
let metadataSizes: number[] = [];

before(() => {
	// Re-wire the request handler to keep the raw body too — the framing is what these tests are about.
	server.removeAllListeners('request');
	server.on('request', (req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => {
			const body = Buffer.concat(chunks);
			const metadataSize = parseInt(String(req.headers['x-metadata-size']));
			posted.push(JSON.parse(body.subarray(0, metadataSize).toString('utf8')));
			postedBodies.push(body);
			metadataSizes.push(metadataSize);
			res.writeHead(204);
			res.end();
		});
	});
});

const makeUrlJob = (deviceTypes = ['desktop', 'mobile']) =>
	new RenderJob({
		id: 'https://site.example.com/product/x',
		url: 'https://site.example.com/product/x',
		expiresAt: Date.now() + 60_000,
		deviceType: deviceTypes[0],
		deviceTypes,
		callbackOrigin,
		isFromSitemap: true,
	});

type Variant = { deviceType: string; outcome: string; contentLength: number; statusCode?: number; reason?: string };

const sendVariants = async (job: RenderJob, variants: RenderJob[]) => {
	posted.length = 0;
	postedBodies.length = 0;
	metadataSizes = [];
	assert.equal(await RenderJob.sendVariantsResult(job, variants), true, 'result must be delivered');
	return {
		meta: posted[0] as { id: string; url: string; deviceTypes: string[]; variants: Variant[] },
		body: postedBodies[0],
		metadataSize: metadataSizes[0],
	};
};

test('variants() fans a multi-device job out to one per-device job sharing the claim', () => {
	const job = makeUrlJob(['desktop', 'mobile']);
	const variants = job.variants();
	assert.deepEqual(
		variants.map((v) => v.deviceType),
		['desktop', 'mobile']
	);
	for (const v of variants) {
		assert.equal(v.id, job.id);
		assert.equal(v.url, job.url);
		assert.equal(v.expiresAt, job.expiresAt);
		assert.equal(v.callbackOrigin, callbackOrigin);
		assert.equal(v.isFromSitemap, true);
		assert.equal(v.deviceTypes, undefined, 'a variant is a plain per-device job, never a group');
	}
	assert.notEqual(variants[0], job, 'the group job itself is not rendered');
});

test('a legacy per-device job is its own single variant', () => {
	const job = makeJob();
	assert.deepEqual(job.variants(), [job]);
	assert.equal(job.deviceTypes, undefined);
});

test('a job claimed with deviceTypes but no deviceType still has one (the first)', () => {
	const job = new RenderJob({
		id: 'https://site.example.com/p',
		url: 'https://site.example.com/p',
		expiresAt: Date.now() + 60_000,
		deviceTypes: ['mobile', 'desktop'],
		callbackOrigin,
		isFromSitemap: false,
	} as never);
	assert.equal(job.deviceType, 'mobile');
});

test('a multi-device result posts one envelope and the bodies concatenated in variant order', async () => {
	const job = makeUrlJob(['desktop', 'mobile']);
	const [desktop, mobile] = job.variants();

	desktop.attemptStarted();
	desktop.httpResponse = { statusCode: 200, headers: { 'content-type': 'text/html' } };
	desktop.isIndexable = true;
	desktop.attemptEnded(undefined, '<html>desktop</html>');

	mobile.attemptStarted();
	mobile.httpResponse = { statusCode: 200, headers: { 'content-type': 'text/html' } };
	mobile.isIndexable = true;
	mobile.attemptEnded(undefined, '<html>mobile — a longer body so the offsets differ</html>');

	const { meta, body, metadataSize } = await sendVariants(job, [desktop, mobile]);

	assert.equal(meta.id, job.id);
	assert.equal(meta.url, job.url);
	assert.deepEqual(meta.deviceTypes, ['desktop', 'mobile']);
	assert.equal(meta.variants.length, 2);
	assert.deepEqual(
		meta.variants.map((v) => [v.deviceType, v.outcome]),
		[
			['desktop', 'rendered'],
			['mobile', 'rendered'],
		]
	);

	// Decode exactly as the plugin does: walk the body region by each variant's contentLength.
	let offset = metadataSize;
	const decoded: string[] = [];
	for (const v of meta.variants) {
		assert.ok(v.contentLength > 0, 'a rendered variant carries content');
		decoded.push(gunzipSync(body.subarray(offset, offset + v.contentLength)).toString('utf8'));
		offset += v.contentLength;
	}
	assert.equal(offset, body.byteLength, 'the contentLengths account for every body byte');
	assert.deepEqual(decoded, ['<html>desktop</html>', '<html>mobile — a longer body so the offsets differ</html>']);
});

test('a variant without content has contentLength 0 and consumes no body bytes', async () => {
	const job = makeUrlJob(['desktop', 'mobile']);
	const [desktop, mobile] = job.variants();

	desktop.attemptStarted();
	desktop.httpResponse = { statusCode: 200, headers: {} };
	desktop.isIndexable = true;
	desktop.attemptEnded(undefined, '<html>desktop</html>');

	// Mobile failed mid-render: no content, an error, and a derived reason.
	mobile.attemptStarted();
	mobile.attemptEnded(new Error('Navigation timeout of 30000 ms exceeded'), undefined);

	const { meta, body, metadataSize } = await sendVariants(job, [desktop, mobile]);
	assert.equal(meta.variants[0].contentLength > 0, true);
	assert.deepEqual(
		[meta.variants[1].outcome, meta.variants[1].contentLength, meta.variants[1].reason],
		['error', 0, 'error']
	);
	assert.equal(metadataSize + meta.variants[0].contentLength, body.byteLength);
});

test('a PARTIAL result echoes every device asked for while listing only those attempted', async () => {
	const job = makeUrlJob(['desktop', 'mobile']);
	const [desktop] = job.variants();
	desktop.attemptStarted();
	desktop.httpResponse = { statusCode: 200, headers: {} };
	desktop.isIndexable = true;
	desktop.attemptEnded(undefined, '<html>desktop</html>');

	const { meta } = await sendVariants(job, [desktop]);
	assert.deepEqual(meta.deviceTypes, ['desktop', 'mobile'], 'what the plugin asked for');
	assert.deepEqual(
		meta.variants.map((v) => v.deviceType),
		['desktop'],
		'what this worker actually rendered — the plugin retries the URL for the rest'
	);
});

test('a legacy job still posts the legacy envelope: id, url and the variant fields at the top level', async () => {
	const job = makeJob();
	job.attemptStarted();
	job.httpResponse = { statusCode: 200, headers: {} };
	job.isIndexable = true;
	job.attemptEnded(undefined, '<html>ok</html>');

	const meta = (await send(job)) as Record<string, unknown>;
	assert.equal(meta.id, 'https://site.example.com/product/x|desktop');
	assert.equal(meta.url, 'https://site.example.com/product/x');
	assert.equal(meta.outcome, 'rendered');
	assert.equal('variants' in meta, false, 'an older plugin has no notion of variants');
	assert.equal('deviceTypes' in meta, false);
});

test('a variant whose result cannot be built is posted as an error — the rest of the job still lands', async () => {
	// Compression is the thing that realistically rejects here: an allocation failure on a
	// multi-megabyte document. Before this, one such rejection took down the whole `Promise.all`,
	// so NOTHING was posted — including the device that had rendered perfectly — and the schedule
	// row sat pinning the claim floor with no result to release it.
	const job = makeUrlJob(['desktop', 'mobile']);
	const variants = job.variants();
	for (const v of variants) {
		v.httpResponse = { statusCode: 200, headers: {} };
		v.isIndexable = true;
		v.attemptStarted();
		v.attemptEnded(undefined, `<html>${v.deviceType}</html>`);
	}
	variants[0].resultMetadata = () => Promise.reject(new RangeError('Array buffer allocation failed'));

	const { meta, body, metadataSize } = await sendVariants(job, variants);
	assert.deepEqual(meta.deviceTypes, ['desktop', 'mobile'], 'the job still reports what it was asked for');
	assert.equal(meta.variants.length, 2, 'both devices are accounted for');

	const [desktop, mobile] = meta.variants;
	assert.equal(desktop.outcome, 'error');
	assert.equal(desktop.reason, 'result-build-failed');
	assert.equal(desktop.contentLength, 0, 'it contributes no bytes');
	assert.equal((desktop as unknown as { error: { name: string; phase: string } }).error.name, 'RangeError');
	assert.equal((desktop as unknown as { error: { phase: string } }).error.phase, 'result');

	assert.equal(mobile.outcome, 'rendered', 'the healthy device is unaffected');
	assert.ok(mobile.contentLength > 0);
	// And the framing still adds up, so the plugin can walk it.
	assert.equal(metadataSize + mobile.contentLength, body.byteLength);
	assert.equal(gunzipSync(body.subarray(metadataSize)).toString(), '<html>mobile</html>');
});

// `pageFacts` rides every path `structuredOffers` rides, with the same absent-vs-null contract: ABSENT
// means "this renderer predates the feature" (the consumer alarms on it), null means "the extraction
// ran and failed benignly". Collapsing null into absent would make every such page impersonate an
// outdated renderer.
const FACTS = {
	canonical: 'https://site.example.com/product/x',
	title: 'Thing',
	metaDescription: null,
	h1: 'Thing',
	product: { name: 'Thing', brand: null, image: null, rating: [4.5, 10], offers: [['S1', '9.99', 'USD', 'InStock']] },
	breadcrumbs: ['Home', 'Things'],
};

test('pageFacts travels on the legacy envelope; null is posted as null and undefined stays absent', async () => {
	const rendered = (facts: unknown) => {
		const job = makeJob();
		job.attemptStarted();
		job.httpResponse = { statusCode: 200, headers: {} };
		job.isIndexable = true;
		job.pageFacts = facts as never;
		job.attemptEnded(undefined, '<html>ok</html>');
		return job;
	};
	const withFacts = (await send(rendered(FACTS))) as Record<string, unknown>;
	assert.deepEqual(withFacts.pageFacts, FACTS);

	const failed = (await send(rendered(null))) as Record<string, unknown>;
	assert.equal('pageFacts' in failed, true, 'null must reach the wire, not be dropped');
	assert.equal(failed.pageFacts, null);

	const never = (await send(rendered(undefined))) as Record<string, unknown>;
	assert.equal('pageFacts' in never, false, 'no extraction ran — nothing is claimed');
});

test('pageFacts travels on every variant of a multi-device result, and on a variant whose result could not be built', async () => {
	const job = makeUrlJob(['desktop', 'mobile']);
	const variants = job.variants();
	for (const v of variants) {
		v.httpResponse = { statusCode: 200, headers: {} };
		v.isIndexable = true;
		v.pageFacts = { ...FACTS, h1: `Thing (${v.deviceType})` } as never;
		v.attemptStarted();
		v.attemptEnded(undefined, `<html>${v.deviceType}</html>`);
	}
	variants[1].resultMetadata = () => Promise.reject(new RangeError('Array buffer allocation failed'));

	const { meta } = await sendVariants(job, variants);
	const [desktop, mobile] = meta.variants as unknown as Array<{ reason?: string; pageFacts: typeof FACTS }>;
	assert.deepEqual(desktop.pageFacts, { ...FACTS, h1: 'Thing (desktop)' });
	assert.equal(mobile.reason, 'result-build-failed');
	assert.deepEqual(mobile.pageFacts, { ...FACTS, h1: 'Thing (mobile)' }, 'carried even when the body was not');
});
