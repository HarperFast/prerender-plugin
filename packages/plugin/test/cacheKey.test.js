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
