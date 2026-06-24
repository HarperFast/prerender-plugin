import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyOptions } from '../src/config.js';
import { normalizeUrl } from '../src/util/url.js';

beforeEach(() => applyOptions({}));

test('default policy keeps only the page param and drops the hash', () => {
	assert.equal(normalizeUrl('https://x.com/a?foo=1&page=2&bar=3#frag'), 'https://x.com/a?page=2');
});

test('drops all query params when none are allowlisted', () => {
	applyOptions({ url: { queryParams: [] } });
	assert.equal(normalizeUrl('https://x.com/a?foo=1&page=2'), 'https://x.com/a');
});

test('keeps all query params (sorted) with the "*" sentinel', () => {
	applyOptions({ url: { queryParams: ['*'] } });
	assert.equal(normalizeUrl('https://x.com/a?foo=1&bar=2'), 'https://x.com/a?bar=2&foo=1');
});

test('honors a custom allowlist and sorts survivors', () => {
	applyOptions({ url: { queryParams: ['ref', 'page'] } });
	assert.equal(normalizeUrl('https://x.com/a?utm=x&page=2&ref=abc'), 'https://x.com/a?page=2&ref=abc');
});

test('returnObject yields a URL instance', () => {
	const u = normalizeUrl('https://x.com/a?page=2', true);
	assert.ok(u instanceof URL);
	assert.equal(u.href, 'https://x.com/a?page=2');
});

test('an explicit allowlist overrides the global policy', () => {
	applyOptions({ url: { queryParams: ['page'] } });
	// global keeps `page`; the explicit allowlist keeps only `CN`
	assert.equal(normalizeUrl('https://x.com/a?page=2&CN=foo&utm=z', false, ['CN']), 'https://x.com/a?CN=foo');
});

test('an explicit empty allowlist drops all params regardless of global policy', () => {
	applyOptions({ url: { queryParams: ['*'] } });
	assert.equal(normalizeUrl('https://x.com/a?page=2&CN=foo', false, []), 'https://x.com/a');
});
