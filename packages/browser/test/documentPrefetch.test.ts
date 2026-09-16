import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import RenderJob from '../dist/RenderJob.js';
import { PREFETCH_MAX_BYTES, prefetchDocument, prefetchHeaders } from '../dist/documentPrefetch.js';
import { resolveSettings } from '../dist/settings.js';

// The worker-side document prefetch on its own: the request it sends (what the navigation would
// have sent), host resolution through `hostResolverRules` (connect to the mapped IP, keep the Host
// header — as Chrome's --host-resolver-rules does), and every outcome: a 200 text/html is held with
// its cookies kept apart from its headers; anything else yields nothing and the render fetches for
// itself. The origin records each request's headers, so the assertions are about what it received.
// The pipeline that drives these fetches is in prefetchPipeline.test.ts; the real-Chrome replay in
// documentReuseRender.test.ts.

type Seen = { path: string; headers: http.IncomingHttpHeaders };
const seen: Seen[] = [];
let origin: http.Server;
let port = 0;
// A hostname no resolver knows: reaching the origin at all proves the host-resolver rule was used.
const HOST = 'origin.test';

before(async () => {
	origin = http.createServer((req, res) => {
		const path = req.url ?? '';
		seen.push({ path, headers: req.headers });
		if (path.startsWith('/gz')) {
			res.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				'content-encoding': 'gzip',
				'set-cookie': ['bucket=b7; Path=/', 'vis=1; Path=/; HttpOnly'],
				'vary': 'Accept-Encoding',
			});
			return res.end(zlib.gzipSync('<html>gz</html>'));
		}
		if (path.startsWith('/redirect')) {
			res.writeHead(302, { location: '/gz' });
			return res.end();
		}
		if (path.startsWith('/json')) {
			res.writeHead(200, { 'content-type': 'application/json' });
			return res.end('{}');
		}
		if (path.startsWith('/big')) {
			res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(PREFETCH_MAX_BYTES + 1) });
			return res.end();
		}
		if (path.startsWith('/slow')) {
			setTimeout(() => {
				res.writeHead(200, { 'content-type': 'text/html' });
				res.end('<html>late</html>');
			}, 1500);
			return;
		}
		if (path.startsWith('/missing')) {
			res.writeHead(404, { 'content-type': 'text/html' });
			return res.end('<html>nope</html>');
		}
		res.writeHead(200, { 'content-type': 'text/html' });
		res.end('<html>plain</html>');
	});
	await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
	port = (origin.address() as AddressInfo).port;

	resolveSettings(
		{
			harper: {},
			hostResolverRules: { [HOST]: '127.0.0.1' },
			bypass: { header: 'x-bypass', token: 'tok-1' },
			config: {
				devices: {
					desktop: { userAgent: 'DesktopUA/1', viewport: { width: 1, height: 1 } },
					bare: { viewport: { width: 1, height: 1 } },
				},
				extraHeaders: { 'X-Extra': 'e1', 'X-Both': 'from-config' },
			},
		},
		{ requireHarper: false }
	);
});

after(async () => {
	await new Promise<void>((r) => origin.close(() => r()));
});

const job = (path: string, headers?: Record<string, string>) =>
	new RenderJob({
		id: `http://${HOST}:${port}${path}|desktop`,
		url: `http://${HOST}:${port}${path}`,
		expiresAt: Date.now() + 60_000,
		deviceType: 'desktop',
		callbackOrigin: 'http://127.0.0.1:1',
		isFromSitemap: false,
		headers,
	});

test('the request carries what the navigation would: device UA, extra headers, the bypass token, job headers', () => {
	const headers = prefetchHeaders(job('/p', { 'X-Both': 'from-job', 'X-Job': 'j' }), 'desktop');
	assert.equal(headers['user-agent'], 'DesktopUA/1');
	assert.equal(headers['x-extra'], 'e1');
	assert.equal(headers['x-bypass'], 'tok-1');
	assert.equal(headers['x-job'], 'j');
	assert.equal(headers['x-both'], 'from-job', 'the job header wins over the config header, as in the renderer');
	assert.equal(headers['sec-fetch-dest'], 'document');
	assert.equal(headers['sec-fetch-mode'], 'navigate');
	assert.match(headers['accept'], /^text\/html,/);
});

test("a profile without a user agent sends the browser's own, and none when that is unknown", () => {
	assert.equal(prefetchHeaders(job('/p'), 'bare', 'HeadlessChrome/1')['user-agent'], 'HeadlessChrome/1');
	assert.equal('user-agent' in prefetchHeaders(job('/p'), 'bare'), false);
	assert.equal(
		prefetchHeaders(job('/p'), 'unknown-device', 'HeadlessChrome/1')['user-agent'],
		'DesktopUA/1',
		'an unknown device falls back to the default device profile (desktop here), as the renderer does'
	);
});

test('the host-resolver rule is honoured: connects to the mapped IP with the Host header intact', async () => {
	seen.length = 0;
	const result = await prefetchDocument(job('/plain'), 'desktop', { timeoutMs: 2000 });
	assert.equal(result.outcome, 'fetched');
	assert.equal(seen.length, 1);
	assert.equal(seen[0].headers.host, `${HOST}:${port}`, 'the Host header names the rule host, not the IP');
	assert.equal(seen[0].headers['user-agent'], 'DesktopUA/1');
	assert.equal(seen[0].headers['x-bypass'], 'tok-1');
	assert.equal(seen[0].headers['x-extra'], 'e1');
	assert.equal(result.doc?.body.toString(), '<html>plain</html>');
	assert.equal(result.doc?.deviceType, 'desktop');
	assert.equal(result.doc?.source, 'prefetch');
	assert.equal(result.doc?.url, `http://${HOST}:${port}/plain`);
	assert.ok(result.ms >= 0);
});

test('a 200 text/html is held DECODED, with its Set-Cookie values apart from its headers', async () => {
	const result = await prefetchDocument(job('/gz'), 'desktop', { timeoutMs: 2000 });
	assert.equal(result.outcome, 'fetched');
	assert.equal(result.doc?.body.toString(), '<html>gz</html>', 'the gzip has been undone');
	assert.deepEqual(result.doc?.setCookies, ['bucket=b7; Path=/', 'vis=1; Path=/; HttpOnly']);
	assert.equal('set-cookie' in (result.doc?.headers ?? {}), false, 'cookies never ride in the replayable headers');
	assert.equal(result.doc?.headers['vary'], 'Accept-Encoding');
	assert.equal(result.doc?.status, 200);
});

test('a redirect is NOT followed and yields nothing — the plugin decides redirects from Chrome', async () => {
	seen.length = 0;
	const result = await prefetchDocument(job('/redirect'), 'desktop', { timeoutMs: 2000 });
	assert.equal(result.outcome, 'status');
	assert.equal(result.status, 302);
	assert.equal(result.doc, null);
	assert.equal(seen.length, 1, 'the Location was not fetched');
});

test('a non-200 yields nothing, with the status', async () => {
	const result = await prefetchDocument(job('/missing'), 'desktop', { timeoutMs: 2000 });
	assert.equal(result.outcome, 'status');
	assert.equal(result.status, 404);
	assert.equal(result.doc, null);
});

test('a non-HTML body is not a document', async () => {
	const result = await prefetchDocument(job('/json'), 'desktop', { timeoutMs: 2000 });
	assert.equal(result.outcome, 'not-html');
	assert.equal(result.doc, null);
});

test('a body over the size cap is not held', async () => {
	const result = await prefetchDocument(job('/big'), 'desktop', { timeoutMs: 2000 });
	assert.equal(result.outcome, 'too-large');
	assert.equal(result.doc, null);
});

test('a slow origin times out into nothing, within the timeout', async () => {
	const started = Date.now();
	const result = await prefetchDocument(job('/slow'), 'desktop', { timeoutMs: 200 });
	assert.equal(result.outcome, 'timeout');
	assert.equal(result.doc, null);
	assert.ok(Date.now() - started < 1400, 'did not wait for the origin');
});

test('an external abort is reported as aborted, not as an error', async () => {
	const ac = new AbortController();
	const pending = prefetchDocument(job('/slow'), 'desktop', { timeoutMs: 5000, signal: ac.signal });
	setTimeout(() => ac.abort(), 50);
	const result = await pending;
	assert.equal(result.outcome, 'aborted');
	assert.equal(result.doc, null);
});

test('an unreachable origin is an error outcome, never a rejection', async () => {
	const unreachable = new RenderJob({
		id: 'x',
		url: `http://${HOST}:1/plain`,
		expiresAt: Date.now() + 60_000,
		deviceType: 'desktop',
		callbackOrigin: 'http://127.0.0.1:1',
		isFromSitemap: false,
	});
	const result = await prefetchDocument(unreachable, 'desktop', { timeoutMs: 2000 });
	assert.equal(result.outcome, 'error');
	assert.equal(result.doc, null);
	assert.ok(result.error);
});
