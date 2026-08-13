import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	cookiePairsFrom,
	decodeSessionCookie,
	encodeSessionCookie,
	forwardedQuery,
	readCookie,
	resolveNode,
} from '../src/util/proxy.js';
import { applyOptions, config } from '../src/config.js';

const NODES = ['https://node-a.example.com:9926', 'https://node-b.example.com:9926'];

test('session cookie round-trips, and anything malformed decodes to signed-out', () => {
	const tokens = { [NODES[0]]: 'hdb-session=abc123', [NODES[1]]: 'hdb-session=def456; extra=1' };
	assert.deepEqual(decodeSessionCookie(encodeSessionCookie(tokens)), tokens);

	for (const junk of [
		null,
		undefined,
		'',
		'not-base64!!',
		Buffer.from('"a string"').toString('base64url'),
		Buffer.from('{"v":2,"nodes":{}}').toString('base64url'),
		'x'.repeat(10000),
	]) {
		assert.equal(decodeSessionCookie(junk), null, `expected null for ${String(junk).slice(0, 30)}`);
	}

	// Non-string token values are dropped, not passed through to a Cookie header.
	const dirty = Buffer.from(JSON.stringify({ v: 1, nodes: { a: 42, b: 'ok=1' } })).toString('base64url');
	assert.deepEqual(decodeSessionCookie(dirty), { b: 'ok=1' });
});

test('readCookie finds our cookie among others and ignores lookalikes', () => {
	const header = 'hdb-session=host-own; prerender-console-session=VALUE; other=x';
	assert.equal(readCookie(header, 'prerender-console-session'), 'VALUE');
	assert.equal(readCookie(header, 'console-session'), null);
	assert.equal(readCookie('', 'prerender-console-session'), null);
	assert.equal(readCookie(null, 'prerender-console-session'), null);
});

test('resolveNode: configured origins and hostnames resolve, everything else is refused', () => {
	// The default node is the FIRST configured one — order is meaningful.
	assert.equal(resolveNode(undefined, NODES), NODES[0]);
	assert.equal(resolveNode('', NODES), NODES[0]);
	// Full origin, host (with port) and bare hostname all address a node.
	assert.equal(resolveNode(NODES[1], NODES), NODES[1]);
	assert.equal(resolveNode('node-b.example.com:9926', NODES), NODES[1]);
	assert.equal(resolveNode('node-b.example.com', NODES), NODES[1]);
	// Same hostname on two ports: the host match keeps them distinct.
	const samehost = ['https://x.example.com:9926', 'https://x.example.com:9927'];
	assert.equal(resolveNode('x.example.com:9927', samehost), samehost[1]);
	// Hostnames are case-insensitive; the configured origins are already lowercased.
	assert.equal(resolveNode('Node-B.Example.COM', NODES), NODES[1]);
	assert.equal(resolveNode('HTTPS://NODE-B.EXAMPLE.COM:9926', NODES), NODES[1]);
	// The SSRF gate: anything not on the list resolves to nothing, never to a URL.
	assert.equal(resolveNode('https://evil.example.net', NODES), null);
	assert.equal(resolveNode('node-a.example.com.evil.net', NODES), null);
	assert.equal(resolveNode('node-a.example.com/../../x', NODES), null);
	assert.equal(resolveNode('anything', []), null);
	assert.equal(resolveNode(undefined, []), null);
});

test('cookiePairsFrom keeps name=value pairs and drops attributes', () => {
	assert.equal(
		cookiePairsFrom(['hdb-session=abc; Path=/; HttpOnly; Secure', 'other=1; SameSite=Lax']),
		'hdb-session=abc; other=1'
	);
	assert.equal(cookiePairsFrom('hdb-session=abc; Path=/'), 'hdb-session=abc');
	assert.equal(cookiePairsFrom(undefined), '');
	assert.equal(cookiePairsFrom(['NoEqualsSign']), '');
});

test('forwardedQuery forwards the query minus the node selector', () => {
	// A RequestTarget that exposes URLSearchParams-style iteration.
	const params = new URLSearchParams([
		['range', '3600000'],
		['node', 'node-b.example.com'],
	]);
	assert.equal(forwardedQuery(params), 'range=3600000');

	// One that only exposes get(): falls back to the documented parameter names.
	const bare = { get: (key) => ({ cacheKey: 'https://x/￨desktop', node: 'n' })[key] ?? null };
	assert.equal(forwardedQuery(bare), `cacheKey=${encodeURIComponent('https://x/￨desktop')}`);

	assert.equal(forwardedQuery(null), '');
});

test('applyOptions: invalid node URLs are dropped, valid ones normalize to origins', () => {
	const before = { ...config };
	try {
		applyOptions({
			nodes: ['https://node-a.example.com:9926/some/path', 'not a url', 42, 'ftp://nope.example.com'],
			requestTimeout: 5000,
			unknownKnob: true,
		});
		// The path is stripped — only the origin is a proxy target — and junk never lands.
		assert.deepEqual(config.nodes, ['https://node-a.example.com:9926']);
		assert.equal(config.requestTimeout, 5000);
		// Past the 32-bit timer limit the value is refused, not stored: Node would fire the
		// timeout after 1ms and every proxied request would fail.
		applyOptions({ requestTimeout: 2147483648 });
		assert.equal(config.requestTimeout, 5000);
	} finally {
		Object.assign(config, before);
	}
});
