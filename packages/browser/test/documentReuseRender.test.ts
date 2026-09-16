import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import RenderWorker from '../dist/Worker.js';
import RenderJob from '../dist/RenderJob.js';
import defaultRenderer from '../dist/renderer.js';
import { resolveSettings, defaultLaunchOptions } from '../dist/settings.js';

// Document reuse end to end, against a real headless Chrome: a two-device job fetches the document
// from the origin ONCE, the second variant navigates from the captured copy with an EMPTY cookie jar
// (no cookie crosses variants), and the result says which variant was replayed. Then the two ways
// reuse is deliberately withheld: a sample job, and a document whose `Vary` names the user agent. The
// origin records every request it sees, with the Cookie header, so the assertions are about what the
// origin actually received rather than about the renderer's own bookkeeping.
//
// Then PREFETCH, through `run()` (the pipeline is what starts a prefetch): the worker fetches the
// document itself, Chrome's navigation is answered from it — WITH the response's own cookies for the
// device that fetched it — and the origin sees one document request carrying the bypass token; with
// reuse on top, the sibling replays the same document without cookies; and a prefetch the origin
// answers with a 404 yields nothing, so Chrome fetches the document as it always did.

type Seen = { path: string; cookie: string | undefined; ua: string | undefined; bypass: string | undefined };
const seen: Seen[] = [];
let vary: string | undefined;

let origin: http.Server;
let base = '';
let queue: http.Server;
let callbackOrigin = '';
type Variant = {
	deviceType: string;
	outcome: string;
	documentReused?: true;
	documentPrefetched?: true;
	statusCode?: number;
};
const posted: Array<Variant & { variants: Variant[] }> = [];

before(async () => {
	origin = http.createServer((req, res) => {
		const path = req.url ?? '';
		seen.push({
			path,
			cookie: req.headers.cookie,
			ua: req.headers['user-agent'],
			bypass: req.headers['x-bypass'] as string | undefined,
		});
		if (path.startsWith('/missing')) {
			res.writeHead(404, { 'content-type': 'text/html' });
			return res.end('<html><body>gone</body></html>');
		}
		if (path.startsWith('/app.js')) {
			res.writeHead(200, { 'content-type': 'application/javascript' });
			return res.end('document.getElementById("m").textContent = "hydrated";');
		}
		if (path.startsWith('/page')) {
			res.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				'set-cookie': ['bucket=b7; Path=/', 'SESSIONID=s-' + Math.random().toString(36).slice(2) + '; Path=/'],
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

const configure = (documentReuse: {
	enabled: boolean;
	sampleEvery?: number;
	prefetch?: { enabled: boolean; depth?: number; timeoutMs?: number };
	cookies?: { pin: string[] };
}) =>
	resolveSettings(
		{
			harper: {},
			bypass: { header: 'x-bypass', token: 'tok-1' },
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

// Through `run()`, which is where a prefetch starts: one job in, the render awaited, the result read.
const runJob = async (path: string, deviceTypes?: string[]) => {
	seen.length = 0;
	posted.length = 0;
	const worker = new RenderWorker({
		renderer: defaultRenderer,
		maxConcurrency: 1,
		browserLaunchOptions: defaultLaunchOptions(),
	});
	const job = new RenderJob({
		id: deviceTypes ? `${base}${path}` : `${base}${path}|desktop`,
		url: `${base}${path}`,
		expiresAt: Date.now() + 120_000,
		deviceType: 'desktop',
		deviceTypes,
		callbackOrigin,
		isFromSitemap: true,
	});
	try {
		await worker.run(
			(async function* () {
				yield job;
			})()
		);
		await Promise.allSettled([...worker.inflight]);
	} finally {
		await worker.destroy();
	}
	const documents = seen.filter((s) => s.path.startsWith(path));
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
	assert.match(
		scripts[0].cookie ?? '',
		/bucket=b7/,
		"the first variant's script call carries the cookies its document set"
	);
	assert.equal(
		scripts[1].cookie,
		undefined,
		"the second variant's does NOT: the replayed response carries no Set-Cookie and nothing is copied — no cookie crosses variants"
	);

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

// ── prefetch ──

test('prefetch alone: the worker fetches the document, Chrome navigates from it WITH its own cookies', async () => {
	configure({ enabled: false, prefetch: { enabled: true, depth: 1 } });
	const { documents, scripts, result } = await runJob('/page?prefetch');

	assert.equal(documents.length, 1, `the origin saw ONE document request, saw ${documents.length}`);
	assert.equal(documents[0].bypass, 'tok-1', 'the prefetch carries the bypass token, as the navigation would');
	assert.match(documents[0].ua ?? '', /Chrome/, "the desktop profile has no UA of its own, so the browser's was sent");
	assert.equal(scripts.length, 1);
	assert.match(
		scripts[0].cookie ?? '',
		/bucket=b7/,
		"the variant's script call carries the cookies its (prefetched) document set — its own response, arrived early"
	);
	assert.equal(scripts[0].bypass, 'tok-1', 'subresources still tokened');
	assert.equal(result.outcome, 'rendered');
	assert.equal(result.statusCode, 200);
	assert.equal(result.documentPrefetched, true);
	assert.equal(result.documentReused, undefined, 'nothing crossed devices');
	assert.equal('variants' in result, false, 'a legacy job still posts the flat shape');
});

test('prefetch with reuse: one fetch by the worker answers both devices — cookies to the first only', async () => {
	configure({ enabled: true, prefetch: { enabled: true, depth: 1 } });
	const { documents, scripts, result } = await runJob('/page?prefetch-reuse', ['desktop', 'mobile']);

	assert.equal(documents.length, 1, 'ONE document request for two devices');
	assert.equal(scripts.length, 2, 'each variant still loads its own scripts');
	assert.match(scripts[0].cookie ?? '', /bucket=b7/, 'the fetching device gets its cookies');
	assert.equal(scripts[1].cookie, undefined, 'the sibling gets none: no cookie crosses variants');
	assert.deepEqual(
		result.variants.map((v) => [v.deviceType, v.outcome, v.documentPrefetched, v.documentReused]),
		[
			['desktop', 'rendered', true, undefined],
			['mobile', 'rendered', true, true],
		]
	);
});

test('a prefetch the origin answers with a 404 yields nothing: Chrome fetches, and the render reports the 404', async () => {
	configure({ enabled: false, prefetch: { enabled: true, depth: 1 } });
	const { documents, result } = await runJob('/missing');
	assert.equal(documents.length, 2, 'the prefetch, then the navigation');
	assert.equal(documents[1].ua?.includes('Chrome'), true);
	assert.equal(result.statusCode, 404);
	assert.equal(result.documentPrefetched, undefined);
});

test('a sample job under prefetch compares the worker-fetched document against one Chrome fetched', async () => {
	configure({ enabled: true, sampleEvery: 1, prefetch: { enabled: true, depth: 1 } });
	const { documents, result } = await runJob('/page?prefetch-sample', ['desktop', 'mobile']);
	// Three fetches on a sample job: the prefetch, then BOTH variants cold. Under prefetch the
	// comparison that matters is same-device — this process's fetch against Chrome's — so the
	// fetching device goes to the origin too, and the first cold fetch is the one compared.
	assert.equal(documents.length, 3, 'the prefetch, then each variant fetching for itself');
	assert.equal(documents[2].ua?.includes('iPhone'), true, 'the last fetch was the mobile one, by Chrome');
	assert.deepEqual(
		result.variants.map((v) => [v.documentPrefetched, v.documentReused]),
		[
			[undefined, undefined],
			[undefined, undefined],
		]
	);
});

test('a pinned cookie crosses to the sibling so both devices hit the same backend — nothing else does', async () => {
	// The reason this exists: where a storefront picks WHICH BACKEND serves the page's API calls from
	// a cookie its document sets, a cookieless sibling renders against a different backend than the
	// device that fetched the document, and one URL's two snapshots stop being comparable. The
	// session cookie still never crosses.
	configure({ enabled: true, cookies: { pin: ['bucket'] } });
	const { documents, scripts, result } = await renderJob(`${base}/page?pinned`);

	assert.equal(documents.length, 1, 'still one document fetch for the two devices');
	assert.equal(scripts.length, 2);
	assert.match(scripts[0].cookie ?? '', /bucket=b7/, 'the fetching device has the routing cookie');
	assert.match(scripts[0].cookie ?? '', /SESSIONID=/, 'and its own session, as it always did');
	assert.equal(scripts[1].cookie, 'bucket=b7', 'the sibling gets the routing cookie AND ONLY that');
	assert.deepEqual(
		result.variants.map((v) => [v.deviceType, v.documentReused]),
		[
			['desktop', undefined],
			['mobile', true],
		]
	);
});

test('with no pin configured the sibling still gets nothing, which is the default', async () => {
	configure({ enabled: true });
	const { scripts } = await renderJob(`${base}/page?unpinned`);
	assert.equal(scripts[1].cookie, undefined, 'default behaviour is unchanged: no cookie crosses');
});
