import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOptions, config } from '../src/config.js';
import { resolveUpstreamHeaders, sanitizeOriginResponseHeaders, stagingTargetIp } from '../src/util/upstream.js';

// Minimal stand-in for the request headers object (only `.get` is used here).
const headersWith = (present) => ({ get: (name) => (present.includes(name) ? '1' : null) });

test('staging defaults are off (empty ip) with a default toggle header', () => {
	applyOptions({});
	assert.equal(config.staging.ip, '');
	assert.equal(config.staging.header, 'x-harper-staging');
});

test('applyOptions accepts staging overrides', () => {
	applyOptions({ staging: { ip: '23.50.51.27', header: 'x-acme-staging' } });
	assert.equal(config.staging.ip, '23.50.51.27');
	assert.equal(config.staging.header, 'x-acme-staging');
	// untouched sibling keeps its default when only ip is overridden
	applyOptions({ staging: { ip: '1.2.3.4' } });
	assert.equal(config.staging.header, 'x-harper-staging');
});

test('stagingTargetIp is undefined when no staging ip is configured', () => {
	applyOptions({});
	assert.equal(stagingTargetIp(headersWith(['x-harper-staging'])), undefined);
});

test('stagingTargetIp returns the configured ip only when the toggle header is present', () => {
	applyOptions({ staging: { ip: '23.50.51.27' } });
	assert.equal(stagingTargetIp(headersWith(['x-harper-staging'])), '23.50.51.27');
	assert.equal(stagingTargetIp(headersWith([])), undefined);
});

test('stagingTargetIp honors a custom toggle header name', () => {
	applyOptions({ staging: { ip: '23.50.51.27', header: 'x-acme-staging' } });
	assert.equal(stagingTargetIp(headersWith(['x-acme-staging'])), '23.50.51.27');
	assert.equal(stagingTargetIp(headersWith(['x-harper-staging'])), undefined);
});

test('stagingTargetIp ignores an invalid configured ip (feature disabled)', () => {
	applyOptions({ staging: { ip: 'not-an-ip' } });
	assert.equal(stagingTargetIp(headersWith(['x-harper-staging'])), undefined);
});

test('stagingTargetIp is disabled when the toggle header name is configured empty', () => {
	applyOptions({ staging: { ip: '23.50.51.27', header: '' } });
	assert.equal(stagingTargetIp(headersWith(['x-harper-staging'])), undefined);
});

test('stagingTargetIp supports an IPv6 staging address', () => {
	applyOptions({ staging: { ip: '2606:2800:220:1:248:1893:25c8:1946' } });
	assert.equal(stagingTargetIp(headersWith(['x-harper-staging'])), '2606:2800:220:1:248:1893:25c8:1946');
});

test('ignoredHeaders defaults to an empty list', () => {
	applyOptions({});
	assert.deepEqual(config.ignoredHeaders, []);
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
	assert.equal(upstream['x-harper-renderer-bypass'], config.securityToken.value);
	assert.equal(upstream['x-harper-prerender-debug'], undefined);
});

test('resolveUpstreamHeaders drops operator-configured ignoredHeaders', () => {
	applyOptions({ ignoredHeaders: ['x-internal', 'x-trace-id'] });
	const upstream = resolveUpstreamHeaders({ 'x-internal': 'secret', 'x-trace-id': '123', 'x-keep': 'yes' }, 'desktop');
	assert.equal(upstream['x-internal'], undefined);
	assert.equal(upstream['x-trace-id'], undefined);
	assert.equal(upstream['x-keep'], 'yes');
});

test('resolveUpstreamHeaders matches ignoredHeaders case-insensitively', () => {
	applyOptions({ ignoredHeaders: ['X-Internal'] });
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
		'server-timing': 'cdn-cache; desc=MISS',
	});
	assert.equal(clean['content-type'], 'text/html; charset=utf-8');
	assert.equal(clean['content-encoding'], 'gzip');
	assert.equal(clean['content-length'], '1234');
	assert.equal(clean['cache-control'], 'max-age=60');
	assert.equal(clean['etag'], '"abc"');
	assert.equal(clean['vary'], 'Accept-Encoding');
	assert.equal(clean['x-robots-tag'], 'noindex');
	// server-timing is a List-type header (mergeable), so it is kept for observability
	assert.equal(clean['server-timing'], 'cdn-cache; desc=MISS');
});

test('sanitizeOriginResponseHeaders strips CDN/edge-injected headers (badxform cause)', () => {
	const clean = sanitizeOriginResponseHeaders({
		'content-type': 'text/html',
		'akamai-grn': '0.1234abcd',
		'x-akamai-staging': 'ESSL',
		'x-akamai-transformed': '9 0 0',
		'x-cache': 'TCP_MISS from a1-2-3-4',
		'x-cache-key': '/L/1/2/3/foo',
		'x-check-cacheable': 'NO',
		'via': '1.1 akamai.net',
		'set-cookie': 'sid=abc; Path=/',
		'connection': 'keep-alive',
	});
	assert.deepEqual(Object.keys(clean), ['content-type']);
});

test('resolveUpstreamHeaders drops a spoofed token/debug header even when configured mixed-case', () => {
	// Incoming keys are lowercased, so a mixed-case configured name must still match.
	applyOptions({ securityToken: { header: 'X-Harper-Token', value: 'real' }, debugHeader: { key: 'X-Harper-Debug' } });
	const upstream = resolveUpstreamHeaders({ 'x-harper-token': 'spoofed', 'x-harper-debug': 'true' }, 'desktop');
	assert.equal(upstream['x-harper-token'], undefined);
	assert.equal(upstream['x-harper-debug'], undefined);
	// the real token is still attached under the configured header name
	assert.equal(upstream['X-Harper-Token'], 'real');
});

test('resolveUpstreamHeaders picks up ignoredHeaders changes across applyOptions (memo rebuild)', () => {
	applyOptions({ ignoredHeaders: ['x-first'] });
	assert.equal(resolveUpstreamHeaders({ 'x-first': 'a', 'x-second': 'b' }, 'desktop')['x-first'], undefined);
	applyOptions({ ignoredHeaders: ['x-second'] });
	const upstream = resolveUpstreamHeaders({ 'x-first': 'a', 'x-second': 'b' }, 'desktop');
	// x-first is no longer ignored, x-second now is
	assert.equal(upstream['x-first'], 'a');
	assert.equal(upstream['x-second'], undefined);
});
