import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import RenderWorker from '../dist/Worker.js';
import RenderJob from '../dist/RenderJob.js';
import defaultRenderer from '../dist/renderer.js';
import { resolveSettings, defaultLaunchOptions } from '../dist/settings.js';

// Document reuse end to end, against a real headless Chrome: a two-device job fetches the document
// from the origin ONCE, the second variant navigates from the captured copy, the cookies the document
// set reach the second variant's scripts, and the result says which variant was replayed. Then the
// two ways reuse is deliberately withheld: a sample job, and a document whose `Vary` names the user
// agent. The origin records every request it sees, with the Cookie header, so the assertions are about
// what the origin actually received rather than about the renderer's own bookkeeping.

type Seen = { path: string; cookie: string | undefined; ua: string | undefined };
const seen: Seen[] = [];
let vary: string | undefined;

let origin: http.Server;
let base = '';
let queue: http.Server;
let callbackOrigin = '';
const posted: Array<{ variants: Array<{ deviceType: string; outcome: string; documentReused?: true }> }> = [];

before(async () => {
	origin = http.createServer((req, res) => {
		const path = req.url ?? '';
		seen.push({ path, cookie: req.headers.cookie, ua: req.headers['user-agent'] });
		if (path.startsWith('/app.js')) {
			res.writeHead(200, { 'content-type': 'application/javascript' });
			return res.end('document.getElementById("m").textContent = "hydrated";');
		}
		if (path.startsWith('/page')) {
			res.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				'set-cookie': 'bucket=b7; Path=/',
				...(vary ? { vary } : {}),
			});
			return res.end(
				`<!doctype html><html><head><title>t</title></head><body><p id="m">ssr</p><script src="/app.js?v=1"></script></body></html>`
			);
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
	base = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;

	queue = http.createServer((req, res) => {
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
	await new Promise<void>((r) => queue.listen(0, '127.0.0.1', r));
	callbackOrigin = `http://127.0.0.1:${(queue.address() as AddressInfo).port}`;
});

after(async () => {
	await new Promise<void>((r) => origin.close(() => r()));
	await new Promise<void>((r) => queue.close(() => r()));
});

const configure = (documentReuse: { enabled: boolean; sampleEvery?: number }) =>
	resolveSettings(
		{
			harper: {},
			config: {
				documentReuse,
				navigation: { waitUntil: 'load', renderBudgetMs: 8000, networkIdleTimeoutMs: 300, domStableMs: 0 },
				scroll: { enabled: false },
				block: { resourceTypes: ['image', 'media', 'font'], urlPatterns: [] },
				postProcess: { stripScripts: true },
			},
		},
		{ requireHarper: false }
	);

const renderJob = async (id: string) => {
	seen.length = 0;
	posted.length = 0;
	const worker = new RenderWorker({
		renderer: defaultRenderer,
		maxConcurrency: 1,
		browserLaunchOptions: defaultLaunchOptions(),
	});
	try {
		await worker.render(
			new RenderJob({
				id,
				url: `${base}/page`,
				expiresAt: Date.now() + 120_000,
				deviceType: 'desktop',
				deviceTypes: ['desktop', 'mobile'],
				callbackOrigin,
				isFromSitemap: true,
			})
		);
	} finally {
		await worker.destroy();
	}
	const documents = seen.filter((s) => s.path.startsWith('/page'));
	const scripts = seen.filter((s) => s.path.startsWith('/app.js'));
	return { documents, scripts, result: posted[0] };
};

test('with reuse on, a two-device job fetches the document once and the second variant is replayed', async () => {
	configure({ enabled: true });
	const { documents, scripts, result } = await renderJob(`${base}/page`);

	assert.equal(documents.length, 1, `origin must see ONE document request, saw ${documents.length}`);
	assert.ok(
		documents[0].ua?.includes('Macintosh') || !documents[0].ua?.includes('iPhone'),
		'the first (desktop) variant fetched it'
	);

	assert.equal(scripts.length, 2, 'each variant still loads its own scripts');
	assert.equal(scripts[0].cookie, 'bucket=b7', "the first variant's script call carries the document's cookie");
	assert.equal(scripts[1].cookie, 'bucket=b7', "so does the second's — the cookie travelled with the document");

	assert.deepEqual(
		result.variants.map((v) => [v.deviceType, v.outcome, v.documentReused]),
		[
			['desktop', 'rendered', undefined],
			['mobile', 'rendered', true],
		]
	);
});

test('a sample job fetches both documents and replays nothing', async () => {
	configure({ enabled: true, sampleEvery: 1 });
	const { documents, result } = await renderJob(`${base}/page?sample`);
	assert.equal(documents.length, 2, 'both variants went to the origin');
	assert.ok(
		documents.some((d) => d.ua?.includes('iPhone')),
		'the second fetch was the mobile one'
	);
	assert.deepEqual(
		result.variants.map((v) => v.documentReused),
		[undefined, undefined]
	);
});

test('a document whose Vary names the user agent is never reused', async () => {
	configure({ enabled: true });
	vary = 'Accept-Encoding, User-Agent';
	try {
		const { documents, result } = await renderJob(`${base}/page?vary`);
		assert.equal(documents.length, 2);
		assert.deepEqual(
			result.variants.map((v) => v.documentReused),
			[undefined, undefined]
		);
	} finally {
		vary = undefined;
	}
});

test('with reuse off (the default) every variant fetches its own document', async () => {
	configure({ enabled: false });
	const { documents, result } = await renderJob(`${base}/page?off`);
	assert.equal(documents.length, 2);
	assert.deepEqual(
		result.variants.map((v) => v.documentReused),
		[undefined, undefined]
	);
});
