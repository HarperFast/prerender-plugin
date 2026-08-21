import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { renderOnce } from '../dist/renderOnce.js';

/**
 * What a render pays for a page it is going to throw away.
 *
 * The settle phase IS a render's cost — on the reference deployment the scroll-settle passes alone
 * are ~78% of render time and the bulk of per-render CPU. A page that ends up non-indexable pays all
 * of it, has its bytes discarded, and then pays it again on every suppression recheck for as long as
 * the plugin keeps the target. Two verdicts are already final right after navigation, so they are
 * taken there instead.
 *
 * `timings.settle` is the assertion that matters throughout: `undefined` means the settle phase never
 * started, which is the only direct evidence the work was actually skipped rather than merely fast.
 * The existing redirect bail asserts the same way (`test/redirect.test.ts`).
 *
 * NOTE ON `captureNonIndexable`. `renderOnce` maps it onto `job.isFromSitemap` — the harness marks
 * jobs as sitemap-listed by default so non-indexable HTML stays inspectable. That makes it exactly
 * the switch these tests need: `false` is the discovered-URL shape the early bail applies to, and the
 * default is the sitemap-listed shape it must never apply to.
 */

let origin: http.Server;
let base = '';

// Requests the origin saw, so a test can prove a bail did not re-fetch anything.
const seen: string[] = [];

before(async () => {
	origin = http.createServer((req, res) => {
		const path = req.url ?? '';
		seen.push(path);
		const html = (head: string, body = 'x') =>
			`<!doctype html><html><head><title>t</title>${head}</head><body>${body}</body></html>`;

		res.setHeader('content-type', 'text/html');

		switch (path.split('?')[0]) {
			case '/noindex':
				return res.end(html('<meta name="robots" content="noindex">'));
			case '/noindex-googlebot':
				return res.end(html('<meta name="googlebot" content="NOINDEX">'));
			case '/canonical-elsewhere':
				return res.end(html('<link rel="canonical" href="/somewhere-else">'));
			case '/gone':
				res.writeHead(404, { 'content-type': 'text/html' });
				return res.end(html('', 'not found'));
			case '/server-error':
				res.writeHead(503, { 'content-type': 'text/html' });
				return res.end(html('', 'try later'));
			// Clean at parse time; adds its own noindex a moment later. The early check must MISS this
			// (it reads the initial DOM) and the post-settle check must still catch it — that boundary is
			// the entire scope of the difference between the two.
			case '/noindex-late':
				return res.end(
					html(
						'',
						`<p>ok</p><script>setTimeout(() => {
							const m = document.createElement('meta');
							m.name = 'robots'; m.content = 'noindex';
							document.head.appendChild(m);
						}, 150);</script>`
					)
				);
			default:
				return res.end(html('', 'OK'));
		}
	});
	await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
	base = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
});

after(async () => {
	await new Promise<void>((r) => origin.close(() => r()));
});

/** A discovered (non-sitemap) render — the shape the early non-indexable bail applies to. */
const discovered = (path: string, overrides: Record<string, unknown> = {}) =>
	renderOnce({
		url: `${base}${path}`,
		captureNonIndexable: false,
		config: { scroll: { enabled: false }, navigation: { domStableMs: 200 } },
		resourceCache: { enabled: false },
		...overrides,
	});

/** A sitemap-listed render — serialized even when non-indexable, so it must NOT bail early. */
const submitted = (path: string) =>
	renderOnce({
		url: `${base}${path}`,
		config: { scroll: { enabled: false }, navigation: { domStableMs: 200 } },
		resourceCache: { enabled: false },
	});

test('a noindex page the plugin discovered ends at navigation, before the settle phase', async () => {
	const result = await discovered('/noindex');
	await result.close();

	assert.equal(result.isIndexable, false);
	assert.equal(result.reason, 'noindex');
	assert.equal(result.html, undefined, 'nothing to store — the plugin suppresses this target');
	assert.equal(result.timings.settle, undefined, 'the settle phase must never have started');
	assert.equal(result.statusCode, 200, 'the document itself answered 200; the page disowned itself');
});

test('a `googlebot` meta counts, and the directive is case-insensitive', async () => {
	const result = await discovered('/noindex-googlebot');
	await result.close();
	assert.equal(result.isIndexable, false);
	assert.equal(result.reason, 'noindex');
	assert.equal(result.timings.settle, undefined);
});

test('a canonical naming another document ends at navigation too', async () => {
	const result = await discovered('/canonical-elsewhere');
	await result.close();
	assert.equal(result.isIndexable, false);
	assert.equal(result.reason, 'canonical-mismatch');
	assert.equal(result.timings.settle, undefined);
});

test('A SITEMAP-LISTED PAGE STILL SETTLES, because its bytes are still served', async () => {
	// The exemption is load-bearing, not cautious: a sitemap-listed url is serialized even when
	// non-indexable, so its settle is not wasted work and bailing would replace a served page with
	// nothing at all.
	const result = await submitted('/noindex');
	await result.close();

	assert.equal(result.isIndexable, false, 'still reported non-indexable');
	assert.equal(result.reason, 'noindex');
	assert.notEqual(result.timings.settle, undefined, 'but it must have settled...');
	assert.ok(result.html, '...and produced content to serve');
});

test('a non-200 ends at navigation for EVERY page, sitemap-listed included', async () => {
	// Behaviour-identical by construction: a status cannot change during the settle, and the
	// post-settle branch does nothing with a non-200 but report it with no content — for a
	// sitemap-listed url too. So this one needs no exemption.
	for (const [path, status] of [
		['/gone', 404],
		['/server-error', 503],
	] as const) {
		for (const render of [discovered, submitted]) {
			const result = await render(path);
			await result.close();
			assert.equal(result.statusCode, status, `${path} status`);
			assert.equal(result.isIndexable, false, `${path} indexable`);
			assert.equal(result.reason, 'http-error', `${path} reason`);
			assert.equal(result.html, undefined, `${path} content`);
			assert.equal(result.timings.settle, undefined, `${path} must not settle`);
		}
	}
});

test('a healthy page is untouched: it settles, and it serializes', async () => {
	const result = await discovered('/fine');
	await result.close();

	assert.equal(result.isIndexable, true);
	assert.equal(result.reason, undefined);
	assert.notEqual(result.timings.settle, undefined, 'the settle phase must still run');
	assert.match(result.html ?? '', /OK/);
});

test('a page that adds its noindex DURING the settle is still caught, by the post-settle check', async () => {
	// The one difference between the two checks, made explicit. The early check reads the initial DOM,
	// so it cannot see this — and the late check has to remain the backstop, or moving the check
	// forward would silently narrow what gets suppressed at all.
	const result = await discovered('/noindex-late');
	await result.close();

	assert.equal(result.isIndexable, false, 'the late check still runs and still decides');
	assert.equal(result.reason, 'noindex');
	assert.notEqual(result.timings.settle, undefined, 'and it necessarily paid for the settle to see it');
});

test('earlyNonIndexable: false restores settle-then-decide, with the same verdict', async () => {
	// The kill switch has to be a revert of WHEN the decision is taken, not of the decision.
	const result = await discovered('/noindex', {
		config: {
			scroll: { enabled: false },
			navigation: { domStableMs: 200 },
			suppression: { earlyNonIndexable: false },
		},
	});
	await result.close();

	assert.equal(result.isIndexable, false, 'same verdict');
	assert.equal(result.reason, 'noindex', 'same reason');
	assert.notEqual(result.timings.settle, undefined, 'but it settled first');
});

test('earlyErrorStatus: false likewise settles a 404 before reporting it', async () => {
	const result = await discovered('/gone', {
		config: {
			scroll: { enabled: false },
			navigation: { domStableMs: 200 },
			suppression: { earlyErrorStatus: false },
		},
	});
	await result.close();

	assert.equal(result.statusCode, 404);
	assert.equal(result.reason, 'http-error');
	assert.notEqual(result.timings.settle, undefined);
});

test('a bail fetches the document exactly once — it does not re-navigate to decide', async () => {
	seen.length = 0;
	const result = await discovered('/noindex');
	await result.close();
	assert.equal(
		seen.filter((p) => p === '/noindex').length,
		1,
		'one navigation; the verdict comes off the DOM already in front of us'
	);
});
