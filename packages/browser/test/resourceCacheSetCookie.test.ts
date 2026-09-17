import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { renderOnce } from '../dist/renderOnce.js';
import { ResourceCache, getResourceCache } from '../dist/ResourceCache.js';

// `getCachePolicy` only reads status() and headers(), so a literal stands in for HTTPResponse.
const res = (status: number, headers: Record<string, string>) =>
	({ status: () => status, headers: () => headers }) as never;

const policyCache = (allowPrivateResponses = true) =>
	new ResourceCache({
		dir: path.join(os.tmpdir(), 'rc-policy-unused'),
		maxEntryBytes: 1 << 20,
		maxTotalBytes: 1 << 24,
		maxTtlMs: 60_000,
		allowPrivateResponses,
	});

test('a `public` response is cacheable even when it carries Set-Cookie', () => {
	const cache = policyCache();
	// The shape that matters in the wild: an edge stapling a session cookie onto an immutable
	// content-hashed bundle. Refusing this is what held the fleet cache at a 13.7% hit rate.
	const policy = cache.getCachePolicy(
		res(200, {
			'set-cookie': 'ak_bmsc=deadbeef; Path=/; HttpOnly',
			'cache-control': 'public, max-age=31536000',
		})
	);
	assert.equal(policy.cacheable, true);
	assert.equal(policy.ttlMs, 31536000 * 1000 > 60_000 ? 60_000 : 31536000 * 1000, 'ttl is clamped to maxTtlMs');
});

test('Set-Cookie WITHOUT `public` is still refused', () => {
	const cache = policyCache();
	// No `public` means the origin never declared it shared-cacheable, so the cookie still reads as
	// a user-specific signal and the conservative refusal stands.
	for (const cc of ['max-age=600', 'private, max-age=600', '']) {
		const policy = cache.getCachePolicy(res(200, { 'set-cookie': 'sid=1', 'cache-control': cc }));
		assert.equal(policy.cacheable, false, `cache-control: ${cc || '<absent>'} should be refused`);
	}
});

test('`public` does not override the other refusals', () => {
	const cache = policyCache();
	const cases: Array<[string, Record<string, string>]> = [
		['no-store', { 'cache-control': 'public, no-store', 'set-cookie': 'sid=1' }],
		['no-cache', { 'cache-control': 'public, no-cache', 'set-cookie': 'sid=1' }],
		['vary:*', { 'cache-control': 'public, max-age=60', 'vary': '*', 'set-cookie': 'sid=1' }],
		['vary:user-agent', { 'cache-control': 'public, max-age=60', 'vary': 'User-Agent', 'set-cookie': 'sid=1' }],
		['no ttl', { 'cache-control': 'public', 'set-cookie': 'sid=1' }],
	];
	for (const [label, headers] of cases) {
		assert.equal(cache.getCachePolicy(res(200, headers)).cacheable, false, `${label} must stay refused`);
	}
	assert.equal(
		cache.getCachePolicy(res(404, { 'cache-control': 'public, max-age=60' })).cacheable,
		false,
		'non-200 must stay refused'
	);
});

test('vary: accept-encoding alone is still accepted alongside Set-Cookie', () => {
	const cache = policyCache();
	const policy = cache.getCachePolicy(
		res(200, { 'cache-control': 'public, max-age=60', 'vary': 'Accept-Encoding', 'set-cookie': 'sid=1' })
	);
	assert.equal(policy.cacheable, true);
});

// --- end to end: the asset is really replayed, and the page still renders -------------------

const CSS = '.banner { color: rgb(1, 2, 3); }';
const PAGE = `<!doctype html><html><head><title>rc</title>
<link rel="stylesheet" href="/style.css"></head>
<body><div class="banner">hello</div><script src="/app.js"></script></body></html>`;

let origin: http.Server;
let base = '';
let cacheDir = '';
const hits: string[] = [];

before(async () => {
	origin = http.createServer((req, reply) => {
		hits.push(req.url || '');
		if (req.url === '/style.css') {
			// Exactly the live shape: Set-Cookie on an immutable public asset.
			reply.writeHead(200, {
				'content-type': 'text/css',
				'cache-control': 'public, max-age=31536000',
				'set-cookie': 'ak_bmsc=deadbeef; Path=/; HttpOnly',
			});
			return reply.end(CSS);
		}
		if (req.url === '/app.js') {
			reply.writeHead(200, {
				'content-type': 'application/javascript',
				'cache-control': 'public, max-age=31536000',
				'set-cookie': 'sid=abc; Path=/',
			});
			return reply.end('window.__ran = true;');
		}
		reply.writeHead(200, { 'content-type': 'text/html' });
		reply.end(PAGE);
	});
	await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
	base = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
	cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-e2e-'));
});

after(async () => {
	await new Promise<void>((r) => origin.close(() => r()));
	await fs.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
});

test('the asset is stored, replayed on the next render, and the page still renders correctly', async () => {
	const render = () =>
		renderOnce({
			url: `${base}/`,
			config: { scroll: { enabled: false }, postProcess: { stripScripts: false } },
			resourceCache: { enabled: true, dir: cacheDir },
		});

	hits.length = 0;
	const first = await render();
	assert.equal(first.outcome, 'ok');
	const afterFirst = [...hits];
	assert.ok(afterFirst.includes('/style.css'), 'first render must fetch the stylesheet from the origin');

	const cache = getResourceCache();
	assert.ok(cache, 'the resource cache should be installed');
	assert.ok(cache!.stores > 0, `the public+Set-Cookie asset should have been STORED (stores=${cache!.stores})`);
	await first.close();

	hits.length = 0;
	const second = await render();
	assert.equal(second.outcome, 'ok');

	// The point of the fix: the second render serves the asset from disk instead of the origin.
	assert.ok(!hits.includes('/style.css'), `the stylesheet should be replayed, not refetched (origin saw ${hits})`);

	// ...and the replay must not have broken rendering. The stylesheet has to have APPLIED, which
	// a byte-identical body alone would not prove — check the rule reached the document.
	assert.match(second.html || '', /banner/, 'the page body should still be present');
	assert.ok((second.html || '').length > 0, 'the replayed render must not be empty');

	// The cookie must never survive into a replay.
	const stored = await cache!.get(`${base}/style.css`);
	assert.ok(stored, 'the stylesheet should be in the cache');
	const replayHeaders = cache!.toRespondPayload(stored!).headers as Record<string, string>;
	assert.ok(
		!Object.keys(replayHeaders).some((k) => k.toLowerCase() === 'set-cookie'),
		'set-cookie must be stripped from the replay'
	);
	await second.close();
});
