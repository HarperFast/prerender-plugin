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

test('a sample job never replays, even with an entry', () => {
	const entry = { url: 'u', status: 200, headers: {}, body: Buffer.alloc(0), deviceType: 'desktop' };
	const normal = new JobDocumentCache();
	assert.equal(normal.canReplay, false, 'nothing captured yet');
	normal.entry = entry;
	assert.equal(normal.canReplay, true);
	const sample = new JobDocumentCache({ sample: true });
	sample.entry = entry;
	assert.equal(sample.canReplay, false, 'a sample fetches and compares instead');
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
	assert.deepEqual(defaultConfig().documentReuse, { enabled: false, sampleEvery: 0 });
	assert.deepEqual(mergeConfig({ documentReuse: { enabled: true, sampleEvery: 50 } }).documentReuse, {
		enabled: true,
		sampleEvery: 50,
	});
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
