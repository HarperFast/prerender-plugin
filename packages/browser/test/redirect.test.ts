import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { renderOnce } from '../dist/renderOnce.js';

// What a render does when navigation redirects.
//
// An HTTP redirect to a different document ends the render at navigation: the settle phase is
// most of a render's CPU, and the content it would produce could only be filed under a key it
// wasn't rendered for (waitFor rules are scoped by the job URL's path). The result posts the
// FIRST hop's status — the origin's statement about the job URL itself — so the plugin can
// tell a permanent move from a failover bounce.
//
// Just as important is what does NOT bail:
//   - a query-only change (the plugin's route allowlist may collapse it to the same key),
//   - a client-side redirect (no HTTP status to reason about),
//   - a redirect chain that lands back on the URL it started from (failover bounce).
// Those render through and keep the long-standing post-render redirect detection.

let origin: http.Server;
let base = '';

// Requests the origin saw, so a test can assert what was (not) fetched.
const seen: string[] = [];

// `/bounce-start` state: first navigation redirects away and back, second serves 200.
let bounceHits = 0;

before(async () => {
	origin = http.createServer((req, res) => {
		const path = req.url ?? '';
		seen.push(path);

		const page = (marker: string) =>
			res.end(`<!doctype html><html><head><title>t</title></head><body><p id="m">${marker}</p></body></html>`);

		switch (path.split('?')[0]) {
			case '/moved':
				res.writeHead(301, { location: '/destination' });
				return res.end();
			case '/hop':
				// 302 first, then 301 — the posted status must be the FIRST hop's.
				res.writeHead(302, { location: '/moved' });
				return res.end();
			case '/temp':
				res.writeHead(307, { location: '/destination' });
				return res.end();
			case '/query-only':
				if (!path.includes('ref=')) {
					res.writeHead(301, { location: '/query-only?ref=promo' });
					return res.end();
				}
				res.setHeader('content-type', 'text/html');
				return page('QUERY');
			case '/bounce-start':
				if (bounceHits++ === 0) {
					res.writeHead(302, { location: '/bounce-mid' });
					return res.end();
				}
				res.setHeader('content-type', 'text/html');
				return page('BOUNCED-HOME');
			case '/bounce-mid':
				res.writeHead(302, { location: '/bounce-start' });
				return res.end();
			case '/client-redirect':
				res.setHeader('content-type', 'text/html');
				return res.end(
					`<!doctype html><html><head><title>t</title></head><body><script>location.replace('/destination');</script></body></html>`
				);
			case '/noindex':
				res.setHeader('content-type', 'text/html');
				return res.end(
					`<!doctype html><html><head><title>t</title><meta name="robots" content="noindex"></head><body>x</body></html>`
				);
			case '/canonical-elsewhere':
				res.setHeader('content-type', 'text/html');
				return res.end(
					`<!doctype html><html><head><title>t</title><link rel="canonical" href="/destination"></head><body>x</body></html>`
				);
			// Serves one page under any spelling of its query, and canonicalizes to the `+` one —
			// what a faceted origin does. Requested as `%20`, it is the same document under a
			// different cache key.
			case '/canonical-respelled':
				res.setHeader('content-type', 'text/html');
				return res.end(
					`<!doctype html><html><head><title>t</title><link rel="canonical" href="/canonical-respelled?f=A+B"></head><body>x</body></html>`
				);
			case '/destination':
				res.setHeader('content-type', 'text/html');
				return page('DESTINATION');
			default:
				res.setHeader('content-type', 'text/html');
				return page('OK');
		}
	});
	await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
	base = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
});

after(async () => {
	await new Promise<void>((r) => origin.close(() => r()));
});

const render = (path: string) =>
	renderOnce({
		url: `${base}${path}`,
		config: { scroll: { enabled: false } },
		resourceCache: { enabled: false },
	});

test('an HTTP redirect to a different path ends the render at navigation', async () => {
	const result = await render('/moved');
	await result.close();

	assert.equal(result.statusCode, 301, 'must post the redirect status, not the destination 200');
	assert.equal(result.html, undefined, 'no content — nothing renders under a key it was not rendered for');
	assert.equal(result.outcome, 'redirected');
	assert.equal(result.reason, 'redirect');
	assert.equal(new URL(result.redirectedTo!).pathname, '/destination');
	assert.equal(result.timings.settle, undefined, 'the settle phase must have been skipped entirely');
});

test('a redirect chain posts the FIRST hop status (the statement about the job URL)', async () => {
	const result = await render('/hop');
	await result.close();
	assert.equal(result.statusCode, 302);
	assert.equal(new URL(result.redirectedTo!).pathname, '/destination');
});

test('a temporary (307) redirect is posted as such', async () => {
	const result = await render('/temp');
	await result.close();
	assert.equal(result.statusCode, 307);
	assert.equal(result.html, undefined);
});

test('a query-only redirect renders through — the plugin allowlist may collapse it to the same key', async () => {
	const result = await render('/query-only');
	await result.close();

	assert.equal(result.statusCode, 200);
	assert.match(result.html ?? '', /QUERY/, 'must render the landed document, not bail');
	assert.ok(result.redirectedTo, 'still reported so the plugin can re-key if its allowlist keeps the param');
	assert.notEqual(result.timings.settle, undefined, 'render-through must include the settle phase');
});

test('a redirect chain that lands back on the job URL is not a redirect at all', async () => {
	bounceHits = 0;
	const result = await render('/bounce-start');
	await result.close();

	assert.equal(result.statusCode, 200);
	assert.match(result.html ?? '', /BOUNCED-HOME/);
	assert.equal(result.redirectedTo, undefined, 'a failover bounce must keep the target rendering normally');
});

test('a client-side redirect renders through and is caught post-render', async () => {
	const result = await render('/client-redirect');
	await result.close();

	assert.equal(result.statusCode, 200, 'no HTTP hop — the document itself answered 200');
	assert.equal(new URL(result.redirectedTo!).pathname, '/destination');
	assert.match(result.html ?? '', /DESTINATION/);
});

test('reason distinguishes noindex from canonical-mismatch', async () => {
	const noindex = await render('/noindex');
	await noindex.close();
	assert.equal(noindex.isIndexable, false);
	assert.equal(noindex.reason, 'noindex');

	const canonical = await render('/canonical-elsewhere');
	await canonical.close();
	assert.equal(canonical.isIndexable, false);
	assert.equal(canonical.reason, 'canonical-mismatch');
});

// A canonical that names THIS document under another spelling is still a second cache key, so
// it is non-indexable — with its own reason, because "you already render this page under a
// different key" is a different operational story from "this page disowns itself".
test('a re-spelled self-canonical is non-indexable as canonical-variant', async () => {
	const result = await renderOnce({
		url: `${base}/canonical-respelled?f=A%20B`,
		config: { scroll: { enabled: false } },
		resourceCache: { enabled: false },
		captureNonIndexable: false, // production's gate: a DISCOVERED url, not a sitemap-listed one
	});
	await result.close();

	assert.equal(result.isIndexable, false);
	assert.equal(result.reason, 'canonical-variant');
	assert.equal(result.outcome, 'non-indexable');
	assert.equal(result.html, undefined);
});

// THE BLAST-RADIUS GUARANTEE, pinned so a refactor cannot quietly remove it. A sitemap-listed
// url serializes even when non-indexable, and content wins in RenderJob.outcome — so the result
// posts as 'rendered' and the plugin's suppression branch is never reached. Whatever a canonical
// verdict decides, it can only ever retire urls we DISCOVERED; the corpus the site itself
// declared is structurally out of reach. An origin whose canonicals are spelled differently from
// its own sitemap therefore loses nothing but the isIndexable flag on the stored page.
test('a sitemap-listed url survives any canonical verdict (content wins → rendered)', async () => {
	for (const path of ['/canonical-respelled?f=A%20B', '/canonical-elsewhere']) {
		const result = await renderOnce({
			url: `${base}${path}`,
			config: { scroll: { enabled: false } },
			resourceCache: { enabled: false },
			captureNonIndexable: true, // === isFromSitemap in production
			// The POSTED outcome — what the plugin actually branches on — not renderOnce's own slug.
			probes: { posted: ({ job }) => job.outcome },
		});
		await result.close();

		assert.equal(result.isIndexable, false, `${path}: the verdict itself is unchanged`);
		assert.ok(result.html, `${path}: but the page is serialized anyway`);
		assert.equal(result.probes.posted, 'rendered', `${path}: so content wins and nothing suppresses it`);
	}
});
