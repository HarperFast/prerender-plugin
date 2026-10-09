import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { applyOptions, config } from '../src/config.js';
import { restartPaths } from '../src/configSchema.js';
import {
	configuredStagingIp,
	dispatcherFor,
	drainOrDestroy,
	releaseOriginBody,
	resolveUpstreamHeaders,
	sanitizeOriginResponseHeaders,
	stagingTargetIp,
} from '../src/util/upstream.js';

// Minimal stand-in for the request headers object (only `.get` is used here).
const headersWith = (present) => ({ get: (name) => (present.includes(name) ? '1' : null) });

test('staging defaults are off (empty ip) with a default toggle header', () => {
	applyOptions({});
	assert.equal(config.origin.staging.ip, '');
	assert.equal(config.origin.staging.header, 'x-harper-staging');
});

test('applyOptions accepts staging overrides', () => {
	applyOptions({ origin: { staging: { ip: '192.0.2.27', header: 'x-acme-staging' } } });
	assert.equal(config.origin.staging.ip, '192.0.2.27');
	assert.equal(config.origin.staging.header, 'x-acme-staging');
	// untouched sibling keeps its default when only ip is overridden
	applyOptions({ origin: { staging: { ip: '1.2.3.4' } } });
	assert.equal(config.origin.staging.header, 'x-harper-staging');
});

test('stagingTargetIp is undefined when no staging ip is configured', () => {
	applyOptions({});
	assert.equal(stagingTargetIp(headersWith(['x-harper-staging'])), undefined);
});

test('stagingTargetIp returns the configured ip only when the toggle header is present', () => {
	applyOptions({ origin: { staging: { ip: '192.0.2.27' } } });
	assert.equal(stagingTargetIp(headersWith(['x-harper-staging'])), '192.0.2.27');
	assert.equal(stagingTargetIp(headersWith([])), undefined);
});

test('stagingTargetIp honors a custom toggle header name', () => {
	applyOptions({ origin: { staging: { ip: '192.0.2.27', header: 'x-acme-staging' } } });
	assert.equal(stagingTargetIp(headersWith(['x-acme-staging'])), '192.0.2.27');
	assert.equal(stagingTargetIp(headersWith(['x-harper-staging'])), undefined);
});

test('stagingTargetIp ignores an invalid configured ip (feature disabled)', () => {
	applyOptions({ origin: { staging: { ip: 'not-an-ip' } } });
	assert.equal(stagingTargetIp(headersWith(['x-harper-staging'])), undefined);
});

test('stagingTargetIp is disabled when the toggle header name is configured empty', () => {
	applyOptions({ origin: { staging: { ip: '192.0.2.27', header: '' } } });
	assert.equal(stagingTargetIp(headersWith(['x-harper-staging'])), undefined);
});

test('stagingTargetIp supports an IPv6 staging address', () => {
	applyOptions({ origin: { staging: { ip: '2606:2800:220:1:248:1893:25c8:1946' } } });
	assert.equal(stagingTargetIp(headersWith(['x-harper-staging'])), '2606:2800:220:1:248:1893:25c8:1946');
});

test('configuredStagingIp returns the configured ip regardless of any request header', () => {
	applyOptions({ origin: { staging: { ip: '192.0.2.27' } } });
	// No header argument at all — the sitemap refresh opts in out-of-band, not via a header.
	assert.equal(configuredStagingIp(), '192.0.2.27');
});

test('configuredStagingIp is undefined when no staging ip is configured', () => {
	applyOptions({});
	assert.equal(configuredStagingIp(), undefined);
});

test('configuredStagingIp ignores an invalid configured ip', () => {
	applyOptions({ origin: { staging: { ip: 'not-an-ip' } } });
	assert.equal(configuredStagingIp(), undefined);
});

test('ignoredHeaders defaults to an empty list', () => {
	applyOptions({});
	assert.deepEqual(config.origin.ignoredHeaders, []);
});

test('resolveUpstreamHeaders forwards arbitrary downstream headers by default', () => {
	applyOptions({});
	const upstream = resolveUpstreamHeaders({ 'x-custom': 'keep', 'referer': 'https://example.com' }, 'desktop');
	assert.equal(upstream['x-custom'], 'keep');
	assert.equal(upstream['referer'], 'https://example.com');
});

test('resolveUpstreamHeaders always drops the base-ignored and security/debug headers', () => {
	applyOptions({});
	const upstream = resolveUpstreamHeaders(
		{
			'host': 'evil.example',
			'cookie': 'session=abc',
			'authorization': 'Bearer x',
			'x-harper-renderer-bypass': 'spoofed',
			'x-harper-prerender-debug': 'true',
		},
		'desktop'
	);
	assert.equal(upstream['host'], undefined);
	assert.equal(upstream['cookie'], undefined);
	assert.equal(upstream['authorization'], undefined);
	// the security token is set from config, never from the (spoofable) downstream value
	assert.equal(upstream['x-harper-renderer-bypass'], config.origin.securityToken.value);
	assert.equal(upstream['x-harper-prerender-debug'], undefined);
});

test('resolveUpstreamHeaders never forwards the peer token header, default or configured', () => {
	// An older node that does not know a /prerender_peer/* path treats it as bot traffic under a broad
	// prefix route, and would otherwise proxy it to the origin carrying the cluster's shared secret.
	applyOptions({});
	let upstream = resolveUpstreamHeaders({ 'x-harper-peer-token': 'cluster-secret', 'x-keep': 'yes' }, 'desktop');
	assert.equal(upstream['x-harper-peer-token'], undefined);
	assert.equal(upstream['x-keep'], 'yes');
	applyOptions({ peerRescue: { header: 'X-Cluster-Token' } });
	upstream = resolveUpstreamHeaders({ 'x-cluster-token': 'cluster-secret' }, 'desktop');
	assert.equal(upstream['x-cluster-token'], undefined, 'matched case-insensitively, and the memo rebuilt');
});

test('resolveUpstreamHeaders never forwards the render-now header, default or configured', () => {
	// It carries `renderNow.token`, a secret, on the requests that fall back to the origin.
	applyOptions({});
	let upstream = resolveUpstreamHeaders({ 'x-harper-render-now': 'render-secret', 'x-keep': 'yes' }, 'desktop');
	assert.equal(upstream['x-harper-render-now'], undefined);
	assert.equal(upstream['x-keep'], 'yes');
	applyOptions({ renderNow: { header: 'X-Ops-Render' } });
	upstream = resolveUpstreamHeaders({ 'x-ops-render': 'render-secret' }, 'desktop');
	assert.equal(upstream['x-ops-render'], undefined, 'matched case-insensitively, and the memo rebuilt');
});

test('resolveUpstreamHeaders drops operator-configured ignoredHeaders', () => {
	applyOptions({ origin: { ignoredHeaders: ['x-internal', 'x-trace-id'] } });
	const upstream = resolveUpstreamHeaders({ 'x-internal': 'secret', 'x-trace-id': '123', 'x-keep': 'yes' }, 'desktop');
	assert.equal(upstream['x-internal'], undefined);
	assert.equal(upstream['x-trace-id'], undefined);
	assert.equal(upstream['x-keep'], 'yes');
});

test('resolveUpstreamHeaders matches ignoredHeaders case-insensitively', () => {
	applyOptions({ origin: { ignoredHeaders: ['X-Internal'] } });
	const upstream = resolveUpstreamHeaders({ 'x-internal': 'secret' }, 'desktop');
	assert.equal(upstream['x-internal'], undefined);
});

test('sanitizeOriginResponseHeaders keeps genuine origin headers', () => {
	const clean = sanitizeOriginResponseHeaders({
		'content-type': 'text/html; charset=utf-8',
		'content-encoding': 'gzip',
		'content-length': '1234',
		'cache-control': 'max-age=60',
		'etag': '"abc"',
		'last-modified': 'Wed, 02 Jul 2026 00:00:00 GMT',
		'vary': 'Accept-Encoding',
		'x-robots-tag': 'noindex',
	});
	assert.equal(clean['content-type'], 'text/html; charset=utf-8');
	assert.equal(clean['content-encoding'], 'gzip');
	assert.equal(clean['content-length'], '1234');
	assert.equal(clean['cache-control'], 'max-age=60');
	assert.equal(clean['etag'], '"abc"');
	assert.equal(clean['vary'], 'Accept-Encoding');
	assert.equal(clean['x-robots-tag'], 'noindex');
});

test('sanitizeOriginResponseHeaders keeps a redirect target and the document language, and still drops link', () => {
	// The proxy does not follow redirects, so without `location` an origin 301 reached the crawler naming
	// no target. `link` stays out: traffic discovery reads these headers, and its Link-canonical check has
	// never seen one on this path (see the allowlist's comment).
	const clean = sanitizeOriginResponseHeaders({
		'location': '/product/prd-2/new.jsp',
		'content-language': 'en-US',
		'link': '<https://www.example.com/p>; rel="canonical"',
	});
	assert.equal(clean['location'], '/product/prd-2/new.jsp', 'relayed verbatim, relative or not');
	assert.equal(clean['content-language'], 'en-US');
	assert.equal(clean['link'], undefined);
});

test('releaseOriginBody destroys the origin stream, and falls back to cancel for anything else', async () => {
	let released = 0;
	releaseOriginBody({ releaseBody: () => released++, content: { cancel: () => assert.fail('never the web cancel') } });
	assert.equal(released, 1);
	let cancelled = 0;
	releaseOriginBody({ content: new ReadableStream({ cancel: () => void cancelled++ }) });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(cancelled, 1);
	// A stored page (Blob content, no stream) and nothing at all are both no-ops, never a throw.
	releaseOriginBody({ content: new Blob(['x']) });
	releaseOriginBody(undefined);
});

test('a drain has its own deadline: an origin body that stalls is destroyed, not held for bodyTimeout', async () => {
	let destroyed = 0;
	const stalled = new ReadableStream({ pull: () => new Promise(() => {}) });
	drainOrDestroy(stalled, { destroy: () => destroyed++ }, 30);
	await new Promise((resolve) => setTimeout(resolve, 80));
	assert.equal(destroyed, 1);

	// A body that ends inside the deadline is simply drained — its connection is reused, never destroyed.
	destroyed = 0;
	const small = new ReadableStream({
		start(c) {
			c.enqueue(new Uint8Array(10));
			c.close();
		},
	});
	drainOrDestroy(small, { destroy: () => destroyed++ }, 30);
	await new Promise((resolve) => setTimeout(resolve, 80));
	assert.equal(destroyed, 0);
});

test('sanitizeOriginResponseHeaders strips CDN/edge-injected headers (badxform cause)', () => {
	const clean = sanitizeOriginResponseHeaders({
		'content-type': 'text/html',
		'x-cdn-request-id': '0.1234abcd',
		'x-cdn-staging': 'ESSL',
		'x-cdn-transformed': '9 0 0',
		'x-cache': 'TCP_MISS from a1-2-3-4',
		'x-cache-key': '/L/1/2/3/foo',
		'x-check-cacheable': 'NO',
		'via': '1.1 cdn.example.net',
		'server-timing': 'cdn-cache; desc=MISS',
		'set-cookie': 'sid=abc; Path=/',
		'connection': 'keep-alive',
		// empty duplicated custom origin headers seen in the wild — must not be forwarded
		'x-origin-cc': '',
		'x-origin-ttl': '',
	});
	assert.deepEqual(Object.keys(clean), ['content-type']);
});

test('sanitizeOriginResponseHeaders returns {} for null/undefined input', () => {
	assert.deepEqual(sanitizeOriginResponseHeaders(null), {});
	assert.deepEqual(sanitizeOriginResponseHeaders(undefined), {});
});

test('sanitizeOriginResponseHeaders matches allowlist case-insensitively (normalizes key)', () => {
	const clean = sanitizeOriginResponseHeaders({ 'Content-Type': 'text/html', 'X-Cdn-Staging': 'ESSL' });
	assert.equal(clean['content-type'], 'text/html');
	assert.equal(clean['x-cdn-staging'], undefined);
	assert.equal(clean['X-Cdn-Staging'], undefined);
});

test('resolveUpstreamHeaders drops a spoofed token/debug header even when configured mixed-case', () => {
	// Incoming keys are lowercased, so a mixed-case configured name must still match.
	applyOptions({
		origin: { securityToken: { header: 'X-Harper-Token', value: 'real' } },
		debugHeader: { key: 'X-Harper-Debug' },
	});
	const upstream = resolveUpstreamHeaders({ 'x-harper-token': 'spoofed', 'x-harper-debug': 'true' }, 'desktop');
	assert.equal(upstream['x-harper-token'], undefined);
	assert.equal(upstream['x-harper-debug'], undefined);
	// the real token is still attached under the configured header name
	assert.equal(upstream['X-Harper-Token'], 'real');
});

test('resolveUpstreamHeaders picks up ignoredHeaders changes across applyOptions (memo rebuild)', () => {
	applyOptions({ origin: { ignoredHeaders: ['x-first'] } });
	assert.equal(resolveUpstreamHeaders({ 'x-first': 'a', 'x-second': 'b' }, 'desktop')['x-first'], undefined);
	applyOptions({ origin: { ignoredHeaders: ['x-second'] } });
	const upstream = resolveUpstreamHeaders({ 'x-first': 'a', 'x-second': 'b' }, 'desktop');
	// x-first is no longer ignored, x-second now is
	assert.equal(upstream['x-first'], 'a');
	assert.equal(upstream['x-second'], undefined);
});

// --- the User-Agent the origin sees ----------------------------------------------------------

const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

test('by default the crawler’s User-Agent never reaches the origin: the device’s fixed browser UA does', () => {
	applyOptions({});
	assert.equal(
		resolveUpstreamHeaders({ 'user-agent': GOOGLEBOT }, 'mobile')['user-agent'],
		config.origin.userAgents.mobile
	);
	assert.equal(
		resolveUpstreamHeaders({ 'user-agent': GOOGLEBOT }, 'nope')['user-agent'],
		config.origin.userAgents.desktop
	);
});

test('forwardUserAgent sends the crawler’s own UA with the suffix after one space', () => {
	applyOptions({ origin: { forwardUserAgent: { enabled: true } } });
	assert.equal(
		resolveUpstreamHeaders({ 'user-agent': GOOGLEBOT }, 'mobile')['user-agent'],
		`${GOOGLEBOT} HarperProxy/1.0`
	);
	applyOptions({ origin: { forwardUserAgent: { enabled: true, suffix: 'AcmeProxy/2' } } });
	assert.equal(
		resolveUpstreamHeaders({ 'user-agent': GOOGLEBOT }, 'desktop')['user-agent'],
		`${GOOGLEBOT} AcmeProxy/2`
	);
	applyOptions({});
});

test('forwardUserAgent with an empty suffix forwards the crawler’s UA verbatim', () => {
	applyOptions({ origin: { forwardUserAgent: { enabled: true, suffix: '' } } });
	assert.equal(resolveUpstreamHeaders({ 'user-agent': GOOGLEBOT }, 'desktop')['user-agent'], GOOGLEBOT);
	applyOptions({});
});

test('forwardUserAgent falls back to the device UA when there is no crawler UA to forward', () => {
	applyOptions({ origin: { forwardUserAgent: { enabled: true } } });
	// No downstream at all, an empty UA, and headers with no UA (the negative cache's background re-check).
	assert.equal(resolveUpstreamHeaders(undefined, 'tablet')['user-agent'], config.origin.userAgents.tablet);
	assert.equal(resolveUpstreamHeaders({ 'user-agent': '' }, 'tablet')['user-agent'], config.origin.userAgents.tablet);
	assert.equal(
		resolveUpstreamHeaders({ accept: 'text/html' }, 'mobile')['user-agent'],
		config.origin.userAgents.mobile
	);
	applyOptions({});
});

// --- origin response-header cap -------------------------------------------------------------
//
// Asserted behaviorally against a real server rather than by reading undici's internal
// kMaxHeadersSize symbol, so the tests survive an undici refactor and actually prove the thing
// that broke in production: a large-but-legitimate origin response head must not kill the request.

// Serve a response whose head sums to `bytes` across many headers — the shape a real origin
// produces (a Set-Cookie pile-up plus CSP/Link-preload), since the cap is cumulative over the
// whole head, not per header.
//
// undici counts header NAME and VALUE bytes (Parser.onHeaderField / onHeaderValue each call
// trackHeader with their own buffer length) and not the `: ` / CRLF delimiters, so budgeting
// `name.length + value.length` per header is exactly what the cap sees.
const HEADER_BYTES = 1024;
const serverWithHeadBytes = async (bytes) => {
	const server = http.createServer((_req, res) => {
		const headers = {};
		for (let i = 0; i < Math.ceil(bytes / HEADER_BYTES); i++) {
			const name = `x-pad-${i}`;
			headers[name] = 'a'.repeat(HEADER_BYTES - name.length);
		}
		res.writeHead(200, headers);
		res.end('ok');
	});
	// Reject on a listen error rather than leaving the await to hang forever (EADDRINUSE, or a
	// sandbox that forbids binding) — a hung test is far harder to diagnose than a failed one.
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	return { server, origin: `http://127.0.0.1:${server.address().port}` };
};

const withServer = async (bytes, fn) => {
	const { server, origin } = await serverWithHeadBytes(bytes);
	try {
		return await fn(origin);
	} finally {
		// close() is async; awaiting it keeps a lingering handle from leaking into the next test.
		await new Promise((resolve) => server.close(resolve));
	}
};

test('a 32 KiB origin response head succeeds under the default cap', async () => {
	applyOptions({});
	assert.equal(config.origin.maxResponseHeaderBytes, 64 * 1024);
	// The whole point: the default must clear Node's http.maxHeaderSize, which is what undici
	// falls back to and what produced UND_ERR_HEADERS_OVERFLOW -> 500 for the crawler.
	assert.ok(config.origin.maxResponseHeaderBytes > http.maxHeaderSize);

	await withServer(32 * 1024, async (origin) => {
		const res = await dispatcherFor(undefined).request({ origin, path: '/', method: 'GET' });
		assert.equal(res.statusCode, 200);
		await res.body.text();
	});
});

test('the cap is genuinely enforced (a head above it still overflows)', async () => {
	// Proves the option is wired to undici rather than merely stored. A fresh module instance is
	// needed because the unpinned dispatcher is built once per process — which is the restart
	// scope, asserted below. The query string gives a distinct module URL; config.js resolves to
	// the same URL either way, so the singleton config this sets is what the fresh module reads.
	applyOptions({ origin: { maxResponseHeaderBytes: 16 * 1024 } });
	const fresh = await import('../src/util/upstream.js?fresh=low-cap');
	try {
		await withServer(32 * 1024, async (origin) => {
			await assert.rejects(
				() => fresh.dispatcherFor(undefined).request({ origin, path: '/', method: 'GET' }),
				(err) => err.code === 'UND_ERR_HEADERS_OVERFLOW'
			);
		});
	} finally {
		applyOptions({});
	}
});

test('the unpinned dispatcher is built once and ignores a live cap change', async () => {
	// Both halves of restart scope: the hot path must not rebuild per request (efficiency), and a
	// live edit must not silently take effect (correctness — config.js reports pending-restart).
	applyOptions({});
	const first = dispatcherFor(undefined);
	assert.equal(dispatcherFor(undefined), first);

	applyOptions({ origin: { maxResponseHeaderBytes: 128 * 1024 } });
	assert.equal(dispatcherFor(undefined), first, 'a live cap change must not swap the dispatcher');

	// ...and it still honors the cap it was constructed with, not the newly configured one.
	await withServer(32 * 1024, async (origin) => {
		const res = await first.request({ origin, path: '/', method: 'GET' });
		assert.equal(res.statusCode, 200);
		await res.body.text();
	});
	applyOptions({});
});

test('maxResponseHeaderBytes is declared restart-scoped', () => {
	// Guards the scope declaration itself: dropping it would make the option look live while the
	// running dispatcher quietly kept the old cap.
	assert.ok(restartPaths().includes('origin.maxResponseHeaderBytes'));
});

test('a dispatcher built after a live cap edit still uses the captured cap', async () => {
	// origin.staging.ip IS live-scoped, so enabling staging mints a pinned dispatcher long after
	// boot. If that construction re-read config it would pick up a cap edited in the meantime
	// while the unpinned singleton kept the boot value — two dispatchers disagreeing, and a
	// pending-restart notice that was only half true. The cap is captured once instead.
	// A fresh module instance so the pinned entry is genuinely built here rather than reused from
	// an earlier test, and so the capture starts unset.
	applyOptions({});
	const fresh = await import('../src/util/upstream.js?fresh=capture-once');
	fresh.dispatcherFor(undefined); // force the capture at the default

	applyOptions({ origin: { maxResponseHeaderBytes: 16 * 1024, staging: { ip: '127.0.0.1' } } });
	const pinnedAfterEdit = fresh.dispatcherFor('127.0.0.1');

	// Built after the edit, but still honors the captured 64 KiB — a 32 KiB head must pass. Were
	// it reading config at construction it would have taken the 16 KiB cap and overflowed.
	await withServer(32 * 1024, async (origin) => {
		const res = await pinnedAfterEdit.request({ origin, path: '/', method: 'GET' });
		assert.equal(res.statusCode, 200);
		await res.body.text();
	});
	applyOptions({});
});

test('the staging-pinned dispatcher carries the cap too', async () => {
	// Constructed on its own branch, so it is the easy one to miss — and a staging deploy that
	// 500s on every large-header page would look like a staging-edge fault, not a config gap.
	applyOptions({});
	const pinned = dispatcherFor('127.0.0.1');
	assert.notEqual(pinned, dispatcherFor(undefined));

	await withServer(32 * 1024, async (origin) => {
		// The pin rewrites DNS to 127.0.0.1; the port still comes from the origin URL.
		const res = await pinned.request({ origin, path: '/', method: 'GET' });
		assert.equal(res.statusCode, 200);
		await res.body.text();
	});
});

test('a cap outside the schema bounds is rejected back to the default', () => {
	// enforceSchemaConstraints warns and restores the default rather than throwing, so a typo
	// degrades to the safe 64 KiB instead of silently reintroducing the 16 KiB failure...
	applyOptions({ origin: { maxResponseHeaderBytes: 1024 } });
	assert.equal(config.origin.maxResponseHeaderBytes, 64 * 1024);

	// ...and the ceiling catches the opposite typo — a stray factor of a thousand — before it
	// becomes an out-of-memory risk multiplied across concurrent connections.
	applyOptions({ origin: { maxResponseHeaderBytes: 64 * 1024 * 1024 } });
	assert.equal(config.origin.maxResponseHeaderBytes, 64 * 1024);

	// The bounds themselves are inclusive and must stay usable.
	applyOptions({ origin: { maxResponseHeaderBytes: 1024 * 1024 } });
	assert.equal(config.origin.maxResponseHeaderBytes, 1024 * 1024);
	applyOptions({});
});
