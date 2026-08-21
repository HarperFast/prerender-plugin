import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { renderOnce } from '../dist/renderOnce.js';
import { indexVerdict } from '../dist/renderer.js';

// `navigation.skipSettleWhenNonIndexable`: decide indexability against the pre-settle DOM and
// skip the settle phase when the document already disowns itself. Settle is ~80% of a render, and
// the plugin can never store a non-indexable page, so settling one is pure waste.
//
// The two properties that make it safe, both pinned below:
//   - it can only ever SKIP a render, never keep one the settled DOM would have rejected — a
//     verdict that arrives after DOMContentLoaded is still caught by the post-settle check;
//   - sitemap-listed urls are exempt, so the blast-radius guarantee in redirect.test.ts holds.

let origin: http.Server;
let base = '';

before(async () => {
	origin = http.createServer((req, res) => {
		const path = (req.url ?? '').split('?')[0];
		const html = (head: string, body = 'x') =>
			res.end(`<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`);
		res.setHeader('content-type', 'text/html');
		switch (path) {
			case '/noindex':
				return html('<meta name="robots" content="noindex">');
			case '/canonical-elsewhere':
				return html('<link rel="canonical" href="/other">');
			case '/canonical-respelled':
				return html('<link rel="canonical" href="/canonical-respelled?f=A+B">');
			case '/gone':
				res.writeHead(404, { 'content-type': 'text/html' });
				return html('<meta name="robots" content="noindex">', 'GONE');
			// noindex injected AFTER DOMContentLoaded, so the pre-settle DOM looks clean. Proves
			// the post-settle check stays authoritative.
			// Client-side redirect (fires before DOMContentLoaded) onto a noindex destination —
			// the bail must still report where it landed.
			case '/client-redirect':
				return html('', `<script>location.replace('/noindex');</script>`);
			case '/late-noindex':
				return html(
					'',
					`LATE<script>setTimeout(() => {
						const m = document.createElement('meta');
						m.setAttribute('name', 'robots');
						m.setAttribute('content', 'noindex');
						document.head.appendChild(m);
					}, 50);</script>`
				);
			default:
				return html('', 'OK');
		}
	});
	await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
	base = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
});

after(async () => {
	await new Promise<void>((r) => origin.close(() => r()));
});

// captureNonIndexable: false === a DISCOVERED url in production (isFromSitemap false), which is
// the only population this optimization touches.
const render = (path: string, over: Record<string, unknown> = {}, fromSitemap = false) =>
	renderOnce({
		url: `${base}${path}`,
		config: {
			scroll: { enabled: false },
			navigation: { skipSettleWhenNonIndexable: true, domStableMs: 50 },
			...over,
		},
		resourceCache: { enabled: false },
		captureNonIndexable: fromSitemap,
	});

test('a noindex document skips the settle phase entirely', async () => {
	const result = await render('/noindex');
	await result.close();

	assert.equal(result.isIndexable, false);
	assert.equal(result.reason, 'noindex');
	assert.equal(result.html, undefined, 'nothing to store — the plugin discards non-indexable content');
	assert.equal(result.timings.settle, undefined, 'the settle phase must have been skipped');
});

test('a canonical naming another document skips the settle phase', async () => {
	const result = await render('/canonical-elsewhere');
	await result.close();

	assert.equal(result.isIndexable, false);
	assert.equal(result.reason, 'canonical-mismatch');
	assert.equal(result.timings.settle, undefined);
});

test('a non-200 skips the settle phase and still posts its status', async () => {
	const result = await render('/gone');
	await result.close();

	assert.equal(result.statusCode, 404, 'the plugin needs the status to pick its suppression cadence');
	assert.equal(result.isIndexable, false);
	assert.equal(result.reason, 'http-error');
	assert.equal(result.timings.settle, undefined);
});

test('an indexable document is unaffected — it settles and serializes', async () => {
	const result = await render('/fine');
	await result.close();

	assert.equal(result.isIndexable, true);
	assert.match(result.html ?? '', /OK/);
	assert.notEqual(result.timings.settle, undefined, 'a page we can store must still get its settle phase');
});

// The safety property: skipping is a fast path for an answer already known, never a new verdict.
test('a verdict that only appears after DOMContentLoaded is still caught post-settle', async () => {
	const result = await render('/late-noindex');
	await result.close();

	assert.equal(result.isIndexable, false, 'the post-settle check remains authoritative');
	assert.equal(result.reason, 'noindex');
	assert.notEqual(result.timings.settle, undefined, 'it got there by settling, not by the fast path');
});

// Mirrors redirect.test.ts's blast-radius guarantee: the sitemap corpus is out of reach.
test('a sitemap-listed url is exempt — it settles and serializes even when non-indexable', async () => {
	const result = await render('/noindex', {}, true);
	await result.close();

	assert.equal(result.isIndexable, false, 'the verdict is unchanged');
	assert.ok(result.html, 'but the page is serialized anyway');
	assert.notEqual(result.timings.settle, undefined, 'so it must not have taken the fast path');
});

test('disabled by default: a noindex document still settles', async () => {
	const result = await renderOnce({
		url: `${base}/noindex`,
		config: { scroll: { enabled: false }, navigation: { domStableMs: 50 } },
		resourceCache: { enabled: false },
		captureNonIndexable: false,
	});
	await result.close();

	assert.equal(result.isIndexable, false);
	assert.notEqual(result.timings.settle, undefined, 'no behavior change on upgrade');
});

// canonical.strict still governs the verdict — the fast path reads it, it does not override it.
test('a re-spelled self-canonical is skipped only under canonical.strict', async () => {
	const lenient = await render('/canonical-respelled?f=A%20B');
	await lenient.close();
	assert.equal(lenient.isIndexable, true, 'default reading keeps its own target');
	assert.notEqual(lenient.timings.settle, undefined);

	const strict = await render('/canonical-respelled?f=A%20B', { canonical: { strict: true } });
	await strict.close();
	assert.equal(strict.isIndexable, false);
	assert.equal(strict.reason, 'canonical-variant');
	assert.equal(strict.timings.settle, undefined);
});

test('indexVerdict: the shared verdict both paths use', () => {
	const page = 'https://x.test/p';
	assert.deepEqual(indexVerdict({ canonicalHref: null, noindex: false }, page, false), { isIndexable: true });
	assert.deepEqual(indexVerdict({ canonicalHref: page, noindex: false }, page, true), { isIndexable: true });
	assert.deepEqual(indexVerdict({ canonicalHref: null, noindex: true }, page, false), {
		isIndexable: false,
		reason: 'noindex',
	});
	assert.deepEqual(indexVerdict({ canonicalHref: 'https://x.test/other', noindex: false }, page, false), {
		isIndexable: false,
		reason: 'canonical-mismatch',
	});
	// noindex outranks a canonical verdict when both fire, so the reason stays the stronger signal.
	assert.deepEqual(indexVerdict({ canonicalHref: 'https://x.test/other', noindex: true }, page, false), {
		isIndexable: false,
		reason: 'noindex',
	});
});

// A bail must not swallow a redirect: the plugin adopts the destination as its own target off
// `redirectedTo`, and without it a client-side move reads as "the source disowned itself".
test('a bail still reports a client-side redirect it landed on', async () => {
	const result = await render('/client-redirect');
	await result.close();

	assert.equal(result.isIndexable, false);
	assert.equal(result.reason, 'noindex', 'the verdict is read off the document it landed on');
	assert.equal(new URL(result.redirectedTo!).pathname, '/noindex', 'the landed url must survive the bail');
	assert.equal(result.timings.settle, undefined, 'and it still skipped the settle');
});
