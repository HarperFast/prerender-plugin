import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config, applyOptions } from '../src/config.js';

test('applyOptions overrides scalars and replaces arrays', () => {
	applyOptions({ botPathPrefix: '/bot/', domains: ['a.com', 'b.com'] });
	assert.equal(config.botPathPrefix, '/bot/');
	assert.deepEqual(config.domains, ['a.com', 'b.com']);
});

test('applyOptions deep-merges nested objects', () => {
	applyOptions({ page: { ttl: 1000 }, securityToken: { value: 'secret' } });
	assert.equal(config.page.ttl, 1000);
	// untouched nested keys keep defaults
	assert.equal(config.page.swrTtl, 3 * 60 * 60 * 1000);
	assert.equal(config.securityToken.header, 'x-harper-renderer-bypass');
	assert.equal(config.securityToken.value, 'secret');
});

test('applyOptions resets to defaults on each call (removed keys revert)', () => {
	applyOptions({ botPathPrefix: '/x/' });
	assert.equal(config.botPathPrefix, '/x/');
	applyOptions({});
	assert.equal(config.botPathPrefix, '/p/');
});

test('applyOptions rejects type-mismatched values and keeps defaults', () => {
	applyOptions({ botPathPrefix: 123, domains: 'not-an-array', page: 'nope' });
	assert.equal(config.botPathPrefix, '/p/');
	assert.deepEqual(config.domains, []);
	assert.equal(config.page.ttl, 24 * 60 * 60 * 1000);
});

test('sitemapUserAgent defaults to the Harper sitemap crawler UA and is overridable', () => {
	applyOptions({});
	assert.equal(config.sitemapUserAgent, 'HarperSitemapCrawler/1.0');
	applyOptions({ sitemapUserAgent: 'AcmeBot/2.0' });
	assert.equal(config.sitemapUserAgent, 'AcmeBot/2.0');
});

test('proxy device UAs carry the HarperProxy product token', () => {
	applyOptions({});
	for (const ua of Object.values(config.userAgents)) {
		assert.match(ua, /HarperProxy\/1\.0$/);
	}
});

test('applyOptions exposes analytics + url defaults', () => {
	applyOptions({});
	assert.equal(config.analytics.enabled, true);
	assert.equal(config.analytics.recordUnmatched, true);
	assert.ok(Array.isArray(config.analytics.bots) && config.analytics.bots.length > 0);
	assert.deepEqual(config.url.queryParams, ['page']);
});

test('applyOptions replaces the bots registry wholesale', () => {
	applyOptions({ analytics: { bots: [{ name: 'OnlyBot', match: 'onlybot' }] } });
	assert.deepEqual(config.analytics.bots, [{ name: 'OnlyBot', match: 'onlybot' }]);
	// scalar siblings keep their defaults
	assert.equal(config.analytics.enabled, true);
});

test('applyOptions ignores null/undefined overrides', () => {
	applyOptions({ botPathPrefix: null });
	assert.equal(config.botPathPrefix, '/p/');
});

test('applyOptions tolerates non-object input', () => {
	applyOptions(undefined);
	assert.equal(config.botPathPrefix, '/p/');
	applyOptions(null);
	assert.equal(config.botPathPrefix, '/p/');
});

test('applyOptions exposes ingress defaults', () => {
	applyOptions({});
	assert.equal(config.ingress.mode, 'prefix');
	assert.equal(config.ingress.deviceTypeSource, 'header');
	assert.equal(config.ingress.deviceTypeHeader, 'x-device-type');
	assert.equal(config.ingress.forwardedHostHeader, 'x-forwarded-host');
	assert.deepEqual(config.ingress.routes, []);
});

test('applyOptions accepts forwarded ingress overrides and replaces routes wholesale', () => {
	applyOptions({
		ingress: {
			mode: 'forwarded',
			deviceTypeSource: 'path',
			routes: [{ match: 'prefix', path: '/catalog/', queryParams: ['CN'] }],
		},
	});
	assert.equal(config.ingress.mode, 'forwarded');
	assert.equal(config.ingress.deviceTypeSource, 'path');
	// untouched nested keys keep defaults
	assert.equal(config.ingress.forwardedHostHeader, 'x-forwarded-host');
	assert.deepEqual(config.ingress.routes, [{ match: 'prefix', path: '/catalog/', queryParams: ['CN'] }]);
});

test('applyOptions sources the security token from valueEnv (overriding the literal)', () => {
	process.env.__TEST_PR_TOKEN = 'env-secret';
	try {
		applyOptions({ securityToken: { value: 'literal', valueEnv: '__TEST_PR_TOKEN' } });
		assert.equal(config.securityToken.value, 'env-secret');
	} finally {
		delete process.env.__TEST_PR_TOKEN;
	}
});

test('applyOptions keeps the literal token when valueEnv is unset or missing', () => {
	applyOptions({ securityToken: { value: 'literal', valueEnv: '__MISSING_ENV__' } });
	assert.equal(config.securityToken.value, 'literal');
});
