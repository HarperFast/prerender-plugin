import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	DOCUMENT_REUSE_HEADER,
	JobDocumentCache,
	documentDivergence,
	toRespondPayload,
	varyForbidsReuse,
} from '../dist/documentReuse.js';
import { defaultConfig, mergeConfig } from '../dist/config.js';

// Document reuse across a job's device variants: the guards that decide whether a document may
// stand in for another device's, the fulfilment payload, and the structural comparison the sampled
// check relies on. The end-to-end behaviour (one origin fetch, no cookie crossing variants, marker
// posted) is in documentReuseRender.test.ts against a real browser.

test('Vary forbids reuse only when it names the user agent, a client hint, or *', () => {
	for (const ok of [undefined, null, '', 'Accept-Encoding', 'accept-encoding, Accept-Language', 'Origin']) {
		assert.equal(varyForbidsReuse(ok), false, `Vary: ${ok}`);
	}
	for (const forbidden of [
		'User-Agent',
		'Accept-Encoding, User-Agent',
		'Sec-CH-UA',
		'sec-ch-ua-mobile',
		'Sec-CH-UA-Platform',
		'Sec-CH-Viewport-Width',
		'Viewport-Width',
		'DPR',
		'*',
	]) {
		assert.equal(varyForbidsReuse(forbidden), true, `Vary: ${forbidden}`);
	}
});

test('the fulfilment payload drops hop-by-hop, encoding, length and set-cookie, and marks the replay', () => {
	const payload = toRespondPayload({
		url: 'https://site.example.com/p',
		status: 200,
		headers: {
			'content-type': 'text/html; charset=utf-8',
			'content-encoding': 'br',
			'content-length': '12345',
			'set-cookie': 'bucket=a; Path=/',
			'connection': 'keep-alive',
			'transfer-encoding': 'chunked',
			'vary': 'Accept-Encoding',
			'etag': '"abc"',
		},
		body: Buffer.from('<html></html>'),
		deviceType: 'desktop',
		source: 'navigation',
	});
	assert.equal(payload.status, 200);
	assert.deepEqual(payload.headers, {
		'content-type': 'text/html; charset=utf-8',
		'vary': 'Accept-Encoding',
		'etag': '"abc"',
		[DOCUMENT_REUSE_HEADER]: '1',
	});
	assert.equal(payload.body.toString(), '<html></html>');
	// Chrome DOES store a fulfilled response's Set-Cookie (verified against Fetch.fulfillRequest), so
	// stripping it is what keeps a cookie from crossing variants — not a formality.
	assert.equal('set-cookie' in payload.headers, false);
});

test("a prefetched document's own cookies are replayed only when asked — for the device that fetched it", () => {
	const doc = {
		url: 'https://site.example.com/p',
		status: 200,
		headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' },
		body: Buffer.from('<html></html>'),
		deviceType: 'desktop',
		source: 'prefetch' as const,
		setCookies: ['bucket=a; Path=/', 'vis=1; Path=/; HttpOnly'],
	};
	assert.equal('set-cookie' in toRespondPayload(doc).headers, false, 'a sibling replaying it gets no cookie');
	const own = toRespondPayload(doc, { withCookies: true });
	assert.deepEqual(
		own.headers['set-cookie'],
		['bucket=a; Path=/', 'vis=1; Path=/; HttpOnly'],
		'as a list, which puppeteer expands'
	);
	assert.equal('content-encoding' in own.headers, false, 'the body is decoded, so the encoding never replays');
	assert.equal(own.headers[DOCUMENT_REUSE_HEADER], '1');
});

// ── which document answers which device ──

const captured = (deviceType: string, vary?: string) => ({
	url: 'u',
	status: 200,
	headers: vary ? { vary } : {},
	body: Buffer.alloc(0),
	deviceType,
	source: 'navigation' as const,
});

test("a sibling's document answers another device only across devices, off a sample job, with a permitting Vary", async () => {
	const empty = new JobDocumentCache();
	assert.equal(await empty.replayFor('mobile'), null, 'nothing captured yet');

	const normal = new JobDocumentCache();
	normal.entry = captured('desktop');
	assert.equal(await normal.replayFor('mobile'), normal.entry);

	const sample = new JobDocumentCache({ sample: true });
	sample.entry = captured('desktop');
	assert.equal(await sample.replayFor('mobile'), null, 'a sample fetches and compares instead');

	const single = new JobDocumentCache({ acrossDevices: false });
	single.entry = captured('desktop');
	assert.equal(await single.replayFor('mobile'), null, 'reuse is off: no document crosses devices');

	const varies = new JobDocumentCache();
	varies.entry = captured('desktop', 'User-Agent');
	assert.equal(await varies.replayFor('mobile'), null, 'the origin said the document is device-specific');
});

test('a document fetched FOR a device always answers that device — its own response, arrived early', async () => {
	const doc = { ...captured('desktop', 'User-Agent'), source: 'prefetch' as const };
	const strictest = new JobDocumentCache({ sample: true, acrossDevices: false });
	strictest.entry = doc;
	assert.equal(await strictest.replayFor('desktop'), doc, 'no cross-device guard applies to the fetching device');
	assert.equal(await strictest.replayFor('mobile'), null);
});

test('replayFor waits for a pending prefetch and records how long the navigation waited', async () => {
	const cache = new JobDocumentCache({ acrossDevices: false });
	const doc = { ...captured('desktop'), source: 'prefetch' as const };
	cache.prefetch = new Promise((resolve) =>
		setTimeout(() => {
			cache.entry = doc;
			resolve(doc);
		}, 60)
	);
	assert.equal(await cache.replayFor('desktop'), doc);
	assert.ok((cache.prefetchWaitMs ?? 0) >= 40, `waited for the prefetch: ${cache.prefetchWaitMs}ms`);
	// A second variant asking finds it settled: no further wait is recorded above the first.
	const before = cache.prefetchWaitMs;
	await cache.replayFor('desktop');
	assert.equal(cache.prefetchWaitMs, before);

	const settledNull = new JobDocumentCache();
	settledNull.prefetch = Promise.resolve(null);
	assert.equal(
		await settledNull.replayFor('desktop'),
		null,
		'a prefetch that yielded nothing leaves the variant to fetch'
	);
	assert.equal(settledNull.prefetchWaitMs, 0);
});

// ── the structural comparison ──

const page = (build: string, uid: string, rum: string, extra = '') =>
	`<!doctype html><html><head><link rel="stylesheet" href="/_astro/Layout.${build}.css"><script>(window.BOOMR_mq=window.BOOMR_mq||[]).push(["addVar",{"rua.t":"${rum}"}])</script></head>` +
	`<body><astro-island uid="${uid}" component-url="/_astro/index.${build}.js"><h1>Product</h1></astro-island>${extra}</body></html>`;

test('build churn and per-request noise normalise to zero divergence', () => {
	// Exactly what two same-device fetches seconds apart differed by on a production storefront:
	// hashed asset names (a deploy in progress), hydration island ids, RUM variables.
	const d = documentDivergence(
		page('Dvfxdw-C', 'ZV9nP3', '1789412487922'),
		page('DdWmEjED', 'Z1z5qtn', '1789412505058')
	);
	assert.equal(d.differing, 0, JSON.stringify(d.samples));
	assert.equal(d.ratio, 0);
	assert.ok(d.chunks > 0);
});

test('markup one device has and the other does not is reported, with samples', () => {
	const desktop = page('abc12345', 'A', '1');
	const mobile = page('abc12345', 'A', '1', '<nav class="mobile-drawer"><a href="/menu">Menu</a></nav>');
	const d = documentDivergence(desktop, mobile);
	assert.ok(d.differing >= 2, `expected the drawer chunks to differ, got ${d.differing}`);
	assert.ok(d.ratio > 0 && d.ratio < 0.5);
	assert.ok(d.samples.some((s) => s.includes('mobile-drawer')));
});

test('identical documents diverge by exactly nothing, and Buffers are accepted', () => {
	const html = page('abc12345', 'A', '1');
	const d = documentDivergence(Buffer.from(html), Buffer.from(html));
	assert.deepEqual([d.differing, d.ratio], [0, 0]);
});

// ── config ──

test('documentReuse defaults off, merges, and rejects bad values by name', () => {
	const prefetch = { enabled: false, depth: 2, timeoutMs: 8000 };
	assert.deepEqual(defaultConfig().documentReuse, { enabled: false, sampleEvery: 0, prefetch });
	assert.deepEqual(mergeConfig({ documentReuse: { enabled: true, sampleEvery: 50 } }).documentReuse, {
		enabled: true,
		sampleEvery: 50,
		prefetch,
	});
	assert.deepEqual(
		mergeConfig({ documentReuse: { prefetch: { enabled: true } } }).documentReuse.prefetch,
		{ enabled: true, depth: 2, timeoutMs: 8000 },
		'a partial prefetch block keeps the other defaults'
	);
	assert.throws(
		() => mergeConfig({ documentReuse: { prefetch: { enabled: 'yes' } } } as never),
		/documentReuse\.prefetch\.enabled must be a boolean/
	);
	assert.throws(
		() => mergeConfig({ documentReuse: { prefetch: { depth: 0 } } } as never),
		/prefetch\.depth must be a positive integer/
	);
	assert.throws(
		() => mergeConfig({ documentReuse: { prefetch: { timeoutMs: 0 } } } as never),
		/prefetch\.timeoutMs must be a positive number/
	);
	assert.throws(
		() => mergeConfig({ documentReuse: { prefetch: null } } as never),
		/documentReuse\.prefetch must be an object/
	);
	assert.throws(
		() => mergeConfig({ documentReuse: { enabled: 'yes' } } as never),
		/documentReuse\.enabled must be a boolean/
	);
	assert.throws(
		() => mergeConfig({ documentReuse: { sampleEvery: -1 } } as never),
		/sampleEvery must be a non-negative integer/
	);
	assert.throws(
		() => mergeConfig({ documentReuse: { sampleEvery: 1.5 } } as never),
		/sampleEvery must be a non-negative integer/
	);
	assert.throws(() => mergeConfig({ documentReuse: null } as never), /`documentReuse` must be an object/);
});
