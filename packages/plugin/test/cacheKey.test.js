import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyOptions } from '../src/config.js';
import { CacheKey } from '../src/util/cacheKey.js';

beforeEach(() => applyOptions({}));

test('toCacheKey joins configured attributes with the delimiter', () => {
	assert.equal(CacheKey.toCacheKey({ url: 'https://x.com/', deviceType: 'mobile' }), 'https://x.com/|mobile');
});

test('toCacheKey uses empty string for missing attributes', () => {
	assert.equal(CacheKey.toCacheKey({ url: 'https://x.com/' }), 'https://x.com/|');
});

test('parse round-trips with toCacheKey', () => {
	const key = CacheKey.toCacheKey({ url: 'https://x.com/p', deviceType: 'desktop' });
	assert.deepEqual(CacheKey.parse(key), { url: 'https://x.com/p', deviceType: 'desktop' });
});

test('extractUrl returns the portion before the first delimiter', () => {
	assert.equal(CacheKey.extractUrl('https://x.com/p|desktop'), 'https://x.com/p');
});

test('honors a configured delimiter and attribute list', () => {
	applyOptions({ cacheKey: { delimiter: '::', attributes: ['url', 'deviceType', 'region'] } });
	const key = CacheKey.toCacheKey({ url: 'https://x.com/', deviceType: 'mobile', region: 'west' });
	assert.equal(key, 'https://x.com/::mobile::west');
	assert.deepEqual(CacheKey.parse(key), { url: 'https://x.com/', deviceType: 'mobile', region: 'west' });
	assert.equal(CacheKey.extractUrl(key), 'https://x.com/');
});

// ---- schedule keys: a URL, or a pre-0.66.0 / one-device `<url>|<device>` row ----

test('isCacheKey / urlOf / deviceOf tell a URL-keyed schedule row from a per-device one', () => {
	const url = 'https://x.com/p?page=2';
	assert.equal(CacheKey.isCacheKey(url), false);
	assert.equal(CacheKey.urlOf(url), url, 'a URL is its own schedule key');
	assert.equal(CacheKey.deviceOf(url), null);

	assert.equal(CacheKey.isCacheKey(`${url}|mobile`), true);
	assert.equal(CacheKey.urlOf(`${url}|mobile`), url);
	assert.equal(CacheKey.deviceOf(`${url}|mobile`), 'mobile');
});

test('the shape test keys on a SUPPORTED device tail, so a delimiter inside the URL cannot misfire', () => {
	// `cacheKey.delimiter` is configurable; with one that can legitimately occur inside a URL, "contains
	// the delimiter" would read a plain URL as a per-device row and strip its tail.
	applyOptions({ cacheKey: { delimiter: '/' } });
	const url = 'https://x.com/catalog/shoes';
	assert.equal(CacheKey.isCacheKey(url), false, 'ends in "shoes", not a device');
	assert.equal(CacheKey.urlOf(url), url);
	assert.equal(CacheKey.deviceOf(url), null);
	assert.equal(CacheKey.isCacheKey(`${url}/mobile`), true);
	assert.equal(CacheKey.urlOf(`${url}/mobile`), url);
	assert.equal(CacheKey.deviceOf(`${url}/mobile`), 'mobile');
	applyOptions({});
});

test('an unsupported device tail is not a per-device key', () => {
	assert.equal(CacheKey.isCacheKey('https://x.com/p|watch'), false);
	assert.equal(CacheKey.urlOf('https://x.com/p|watch'), 'https://x.com/p|watch');
});
