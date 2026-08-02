import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { renderOnce } from '../dist/renderOnce.js';

// Where the bypass token is allowed to go.
//
// An edge bot-mitigation rule keyed on the token lets the tokened document through and 403s every
// un-tokened asset behind it. A renderer that tokens only the navigation therefore loads the page
// with no scripts and no stylesheet and snapshots raw, un-hydrated SSR markup — while reporting a
// perfectly healthy 200. So the token has to reach same-origin subresources too.
//
// The other half matters just as much: it must NOT reach anyone else. These tests pin both, plus
// the signal that makes a crippled render visible (`subresourceErrors`).

const TOKEN = 'test-bypass-token';
const HEADER = 'x-test-bypass';

// Two servers: the page's own origin, and a third party it pulls a script from.
let origin: http.Server;
let thirdParty: http.Server;
let originBase = '';
let thirdPartyBase = '';

// Every request each server saw, and whether it carried the token.
const seen: { host: 'origin' | 'third-party'; path: string; tokened: boolean }[] = [];

before(async () => {
	thirdParty = http.createServer((req, res) => {
		seen.push({ host: 'third-party', path: req.url ?? '', tokened: req.headers[HEADER] !== undefined });
		res.setHeader('content-type', 'text/javascript');
		res.end('globalThis.__thirdParty = true;');
	});
	await new Promise<void>((r) => thirdParty.listen(0, '127.0.0.1', r));
	thirdPartyBase = `http://127.0.0.1:${(thirdParty.address() as AddressInfo).port}`;

	origin = http.createServer((req, res) => {
		const path = req.url ?? '';
		const tokened = req.headers[HEADER] === TOKEN;
		seen.push({ host: 'origin', path, tokened });

		// The edge under test: same-origin assets are refused unless they carry the token.
		if (path !== '/' && !tokened) {
			res.writeHead(403, { 'content-type': 'text/html' });
			res.end('<html><body>Access Denied</body></html>');
			return;
		}

		if (path === '/app.js') {
			res.setHeader('content-type', 'text/javascript');
			res.end(`document.getElementById('app').textContent = 'HYDRATED';`);
			return;
		}
		if (path === '/style.css') {
			res.setHeader('content-type', 'text/css');
			res.end('body{color:#111}');
			return;
		}
		res.setHeader('content-type', 'text/html; charset=utf-8');
		res.end(`<!doctype html><html><head><title>bypass</title>
<link rel="stylesheet" href="/style.css">
</head><body>
<div id="app">SSR</div>
<script src="${thirdPartyBase}/vendor.js"></script>
<script src="/app.js"></script>
</body></html>`);
	});
	await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
	originBase = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
});

after(async () => {
	await new Promise<void>((r) => origin.close(() => r()));
	await new Promise<void>((r) => thirdParty.close(() => r()));
});

const render = () =>
	renderOnce({
		url: `${originBase}/`,
		bypass: { header: HEADER, token: TOKEN },
		// Keep the render to the one variable under test.
		config: { scroll: { enabled: false }, postProcess: { stripScripts: false } },
		resourceCache: { enabled: false },
	});

test('same-origin subresources carry the bypass token, so the page actually renders', async () => {
	seen.length = 0;
	const result = await render();
	await result.close();

	const app = seen.find((r) => r.host === 'origin' && r.path === '/app.js');
	const css = seen.find((r) => r.host === 'origin' && r.path === '/style.css');
	assert.ok(app, 'the same-origin script was never requested');
	assert.ok(css, 'the same-origin stylesheet was never requested');
	assert.equal(app.tokened, true, 'same-origin script was sent WITHOUT the bypass token');
	assert.equal(css.tokened, true, 'same-origin stylesheet was sent WITHOUT the bypass token');

	// The end-to-end consequence: the script ran, so the SSR placeholder was replaced.
	assert.match(result.html ?? '', /HYDRATED/, 'page did not hydrate — subresources were refused');
	assert.doesNotMatch(result.html ?? '', /SSR<\/div>/, 'snapshot still holds the pre-hydration markup');
});

test('the navigation request still carries the token', async () => {
	seen.length = 0;
	const result = await render();
	await result.close();
	const doc = seen.find((r) => r.host === 'origin' && r.path === '/');
	assert.equal(doc?.tokened, true, 'navigation request lost the bypass token');
});

test('the token is never sent to a third-party origin', async () => {
	seen.length = 0;
	const result = await render();
	await result.close();

	const external = seen.filter((r) => r.host === 'third-party');
	assert.ok(external.length > 0, 'the third-party script was never requested — test proves nothing');
	for (const r of external) {
		assert.equal(r.tokened, false, `bypass token leaked to a third-party host (${r.path})`);
	}
});

test('refused same-origin subresources are counted, so a crippled render is not silent', async () => {
	// No token configured: the origin 403s every asset but still serves the document — the exact
	// shape that produced a fleet-wide cache of un-hydrated pages while reporting zero failures.
	const result = await renderOnce({
		url: `${originBase}/`,
		config: { scroll: { enabled: false }, postProcess: { stripScripts: false } },
		resourceCache: { enabled: false },
	});
	const errors = result.job.latestAttempt?.subresourceErrors ?? 0;
	await result.close();

	assert.equal(result.statusCode, 200, 'the document itself should still succeed');
	assert.ok(errors >= 2, `expected the refused script+stylesheet to be counted, got ${errors}`);
	assert.match(result.html ?? '', /SSR<\/div>/, 'without the token the page should stay un-hydrated');
});
