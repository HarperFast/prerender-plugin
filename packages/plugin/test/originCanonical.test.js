import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

/**
 * The origin tap (util/originCanonical.js): a proxied origin document's canonical, read off its head as the
 * crawler's bytes stream by, into the entity registry.
 *
 * What is pinned here:
 *   - the crawler's branch gets every byte, unchanged, whatever the tap does;
 *   - the canonical is read from an identity body as it arrives and from a compressed body's prefix, and
 *     handed to the resolver as an `origin` observation of the URL asked for;
 *   - the tap reads a bounded prefix and lets go of its branch, so a long body does not keep it reading;
 *   - nothing is tapped that is not a 200 HTML document with a body, and past the in-flight bound a
 *     document goes by unread;
 *   - a resolver that throws costs nothing, and every tap returns its slot.
 */

let originCanonical;

before(async () => {
	globalThis.server = { hostname: 'node-a', nodes: [], config: { http: { port: 9926 } }, recordAnalytics() {} };
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} };
	globalThis.Resource = class {};
	globalThis.databases = {
		coordination: {
			SharedBuffer: { primaryStore: { getUserSharedBuffer: (_k, b) => b, tryLock: () => true, unlock() {} } },
		},
		render_service: { Target: class {}, QueueControl: class {}, Entity: class {} },
		render_schedule: { RenderSchedule: class {} },
		page_cache: { PrerenderedPage: class {} },
		probe_state: { ProbeState: class {}, RenderExpectation: class {} },
	};
	originCanonical = await import('../src/util/originCanonical.js');
});

const URL_ASKED = 'https://www.example.com/product/prd-1/email.jsp';
const CANONICAL = 'https://www.example.com/product/prd-1/new-slug.jsp';
const DOCUMENT = (tail = 'x'.repeat(2000)) =>
	`<!doctype html><html><head><meta charset="utf-8"><title>Shoe</title><link rel="canonical" href="${CANONICAL}">` +
	`</head><body>${tail}</body></html>`;

/** A web stream of `bytes` in `size`-byte chunks, counting how many chunks anyone pulled. */
const streamOf = (bytes, size = 512) => {
	let at = 0;
	const stats = { pulled: 0 };
	const stream = new ReadableStream({
		pull(controller) {
			if (at >= bytes.length) return controller.close();
			stats.pulled++;
			controller.enqueue(new Uint8Array(bytes.subarray(at, at + size)));
			at += size;
		},
	});
	return { stream, stats };
};
const resourceOf = (bytes, headers = {}, statusCode = 200, size) => {
	const { stream, stats } = streamOf(bytes, size);
	return {
		resource: {
			statusCode,
			headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
			content: stream,
			releaseBody: () => {},
		},
		stats,
	};
};
const drain = async (stream) => Buffer.from(await new Response(stream).arrayBuffer());
const settled = async () => {
	for (let i = 0; i < 50 && originCanonical.tapsInFlight() > 0; i++) await new Promise((r) => setTimeout(r, 5));
};

test('the crawler gets every byte, and the resolver hears the canonical as an ORIGIN observation of the URL asked for', async () => {
	const bytes = Buffer.from(DOCUMENT());
	const { resource } = resourceOf(bytes);
	const told = [];
	const tapped = originCanonical.tapOriginCanonical(resource, { url: URL_ASKED, resolve: async (o) => told.push(o) });
	assert.notEqual(tapped, resource, 'a tapped resource carries the crawler’s branch');
	assert.deepEqual(await drain(tapped.content), bytes);
	await settled();
	assert.deepEqual(
		told.map(({ atMs, ...rest }) => rest),
		[{ url: URL_ASKED, value: CANONICAL, from: 'origin' }]
	);
	assert.ok(Number.isFinite(told[0].atMs), 'stamped with when the document arrived');
	assert.equal(originCanonical.tapsInFlight(), 0);
});

test('a compressed body: its prefix is inflated and read', async () => {
	const plain = Buffer.from(DOCUMENT());
	const { resource } = resourceOf(gzipSync(plain), { 'content-encoding': 'gzip' });
	const told = [];
	const tapped = originCanonical.tapOriginCanonical(resource, { url: URL_ASKED, resolve: async (o) => told.push(o) });
	assert.deepEqual(await drain(tapped.content), gzipSync(plain), 'the crawler gets the compressed bytes as sent');
	await settled();
	assert.deepEqual(
		told.map((o) => o.value),
		[CANONICAL]
	);
});

test('the tap reads a bounded prefix and lets go: a long body is not read to its end on the tap’s account', async () => {
	// 4 MB after the head. The crawler reads only the first chunk, then stops: the tap alone must not pull the
	// whole document through the tee.
	const bytes = Buffer.from(DOCUMENT('y'.repeat(4 * 1024 * 1024)));
	const { resource, stats } = resourceOf(bytes, {}, 200, 16 * 1024);
	const told = [];
	const tapped = originCanonical.tapOriginCanonical(resource, { url: URL_ASKED, resolve: async (o) => told.push(o) });
	const reader = tapped.content.getReader();
	await reader.read();
	await settled();
	assert.deepEqual(
		told.map((o) => o.value),
		[CANONICAL]
	);
	const bound = Math.ceil(originCanonical.TAP_MAX_BYTES / (16 * 1024)) + 2;
	assert.ok(stats.pulled <= bound, `pulled ${stats.pulled} chunks; the tap stops within its bound (${bound})`);
	reader.cancel().catch(() => {});
});

test('nothing is tapped that is not a 200 HTML document with a body', async () => {
	const bytes = Buffer.from(DOCUMENT());
	const resolve = async () => assert.fail('nothing to resolve');
	for (const [why, resource] of [
		['a 404', resourceOf(bytes, {}, 404).resource],
		['JSON', resourceOf(bytes, { 'content-type': 'application/json' }).resource],
		['no content type', { ...resourceOf(bytes).resource, headers: {} }],
		['no stream', { statusCode: 200, headers: { 'content-type': 'text/html' }, content: bytes }],
	]) {
		assert.equal(originCanonical.tapOriginCanonical(resource, { url: URL_ASKED, resolve }), resource, why);
	}
});

test('a document with no absolute canonical in its head says nothing', async () => {
	const told = [];
	for (const html of [
		'<html><head><title>t</title></head><body></body></html>',
		'<html><head><link rel="canonical" href="relative/slug.jsp"></head><body></body></html>',
	]) {
		const { resource } = resourceOf(Buffer.from(html));
		const tapped = originCanonical.tapOriginCanonical(resource, { url: URL_ASKED, resolve: async (o) => told.push(o) });
		await drain(tapped.content);
	}
	await settled();
	assert.deepEqual(told, []);
});

test('past the in-flight bound a document goes by unread; a resolver that throws costs nothing, and slots come back', async () => {
	// Streams that never deliver: each tap holds its slot until its body ends — in production, an origin body
	// that stalls errors at the fetch's body timeout, which is what `release` stands in for.
	const stalls = [];
	const stalled = () => {
		let source;
		const stream = new ReadableStream({
			start(controller) {
				source = controller;
			},
		});
		stalls.push(() => source.error(new Error('body timeout')));
		return { statusCode: 200, headers: { 'content-type': 'text/html' }, content: stream, releaseBody() {} };
	};
	const taps = [];
	for (let i = 0; i < originCanonical.TAP_MAX_IN_FLIGHT; i++) {
		taps.push(originCanonical.tapOriginCanonical(stalled(), { url: URL_ASKED, resolve: async () => {} }));
	}
	assert.equal(originCanonical.tapsInFlight(), originCanonical.TAP_MAX_IN_FLIGHT);
	const extra = stalled();
	assert.equal(originCanonical.tapOriginCanonical(extra, { url: URL_ASKED, resolve: async () => {} }), extra);
	for (const tap of taps) tap.content.cancel().catch(() => {});
	for (const release of stalls) release();
	await settled();
	assert.equal(originCanonical.tapsInFlight(), 0, 'a body that errors returns its slot');

	const { resource } = resourceOf(Buffer.from(DOCUMENT()));
	const tapped = originCanonical.tapOriginCanonical(resource, {
		url: URL_ASKED,
		resolve: async () => {
			throw new Error('registry fault');
		},
	});
	await drain(tapped.content);
	await settled();
	assert.equal(originCanonical.tapsInFlight(), 0, 'a failed resolve still returns its slot');
});

test('tapsOriginCanonical: a GET, on an entityServe route with an entity prefix, with the registry on', async () => {
	const { applyOptions } = await import('../src/config.js');
	const route = { entityServe: true, entityPrefix: /^\/product\/prd-[^/]+\//y };
	applyOptions({ entities: { enabled: true } });
	assert.equal(originCanonical.tapsOriginCanonical(route, 'GET'), true);
	assert.equal(originCanonical.tapsOriginCanonical(route, 'HEAD'), false);
	assert.equal(originCanonical.tapsOriginCanonical({ ...route, entityServe: false }, 'GET'), false);
	assert.equal(originCanonical.tapsOriginCanonical({ entityServe: true }, 'GET'), false);
	applyOptions({ entities: { enabled: false } });
	assert.equal(originCanonical.tapsOriginCanonical(route, 'GET'), false, 'registry off');
	applyOptions({});
	assert.equal(originCanonical.tapsOriginCanonical(route, 'GET'), true, 'on by default');
});

test('an UNSENT tapped response lets go: its branch is cancelled, and the source once the tap has its prefix', async () => {
	let cancelled = false;
	let at = 0;
	const bytes = Buffer.from(DOCUMENT('z'.repeat(2 * 1024 * 1024)));
	const source = new ReadableStream({
		pull(controller) {
			if (at >= bytes.length) return controller.close();
			controller.enqueue(new Uint8Array(bytes.subarray(at, at + 16 * 1024)));
			at += 16 * 1024;
		},
		cancel() {
			cancelled = true;
		},
	});
	const told = [];
	const tapped = originCanonical.tapOriginCanonical(
		{ statusCode: 200, headers: { 'content-type': 'text/html' }, content: source, releaseBody() {} },
		{ url: URL_ASKED, resolve: async (o) => told.push(o) }
	);
	// A local 304, or a client gone: the response never reads its body.
	await tapped.releaseBody();
	await settled();
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(cancelled, true, 'the source is cancelled, not drained');
	assert.ok(at <= originCanonical.TAP_MAX_BYTES + 32 * 1024, `read ${at} bytes of ${bytes.length}`);
	assert.equal(told.length, 1, 'the tap still read its canonical');
	assert.equal(originCanonical.tapsInFlight(), 0);
});

test('stacked under the raw-cache capture, both copies are whole and the canonical is read', async () => {
	const { teeForCapture } = await import('../src/util/rawCache.js');
	const bytes = Buffer.from(DOCUMENT('w'.repeat(300 * 1024)));
	const { resource } = resourceOf(bytes, {}, 200, 8 * 1024);
	const told = [];
	const tapped = originCanonical.tapOriginCanonical(resource, { url: URL_ASKED, resolve: async (o) => told.push(o) });
	const { downstream, captured } = teeForCapture(tapped.content, 4 * 1024 * 1024);
	assert.deepEqual(await drain(downstream), bytes, 'the crawler’s copy');
	assert.deepEqual((await captured).bytes, bytes, 'the raw cache’s copy');
	await settled();
	assert.equal(told.length, 1);
});

test('no tap for a URL with a query string, or with the entity serve’s master switch off', async () => {
	const { applyOptions } = await import('../src/config.js');
	const route = { entityServe: true, entityPrefix: /^\/product\/prd-[^/]+\//y };
	applyOptions({ entities: { enabled: true } });
	assert.equal(originCanonical.tapsOriginCanonical(route, 'GET', URL_ASKED), true);
	assert.equal(originCanonical.tapsOriginCanonical(route, 'GET', `${URL_ASKED}?color=red`), false);
	applyOptions({ entities: { enabled: true }, ingress: { entityServe: { enabled: false } } });
	assert.equal(originCanonical.tapsOriginCanonical(route, 'GET', URL_ASKED), false);
	applyOptions({});
});
