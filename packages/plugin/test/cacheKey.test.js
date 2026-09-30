import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { applyOptions } from '../src/config.js';
import { CacheKey, MAX_KEY_BYTES } from '../src/util/cacheKey.js';
import { canonicalizeUrl } from '../src/util/url.js';
import { HARPER_MAX_KEY_BYTES } from './support/harperKeyLimit.js';

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

// ---- Harper's primary-key limit ----

// The installed Harper (the dev dependency) and what it encodes keys with. Its `exports` hide
// `package.json`, so the package root is found by walking up from its entry point.
const harperRoot = (() => {
	let dir = dirname(createRequire(import.meta.url).resolve('harper'));
	while (
		!existsSync(join(dir, 'package.json')) ||
		JSON.parse(readFileSync(join(dir, 'package.json'))).name !== 'harper'
	) {
		const up = dirname(dir);
		if (up === dir) throw new Error('harper package root not found');
		dir = up;
	}
	return dir;
})();
const requireFromHarper = createRequire(join(harperRoot, 'package.json'));

test("MAX_KEY_BYTES is the installed Harper's own primary-key limit", () => {
	const source = readFileSync(join(harperRoot, 'resources', 'Table.ts'), 'utf8');
	const declared = Number(/const MAX_KEY_BYTES = (\d+);/.exec(source)?.[1]);
	assert.equal(MAX_KEY_BYTES, declared, "the plugin's bound must be Harper's, or it refuses too much or too little");
	assert.equal(HARPER_MAX_KEY_BYTES, declared, "the fake tables' check must be Harper's too");
});

test("a canonical URL's ordered-binary length is its UTF-8 length — the premise of measuring bytes", () => {
	const { writeKey } = requireFromHarper('ordered-binary');
	const buffer = Buffer.alloc(16_384);
	for (const raw of [
		'https://www.example.com/catalog/a.jsp?CN=Room:Patio%20%26%20Outdoor+Brand:X',
		'https://www.example.com/p/caf\u00e9/\u65e5\u672c?q=\u00fc\u00df&x=\u{1F600}',
		'https://www.example.com/p/tab\there?ctl=\u0001\u0002\u0003&sp=a b',
		`https://www.example.com/p/${'\u00e9'.repeat(900)}`,
	]) {
		const url = canonicalizeUrl(raw, ['*']);
		const key = CacheKey.toCacheKey({ url, deviceType: 'desktop' });
		assert.equal(writeKey(key, buffer, 0), Buffer.byteLength(key), url.slice(0, 80));
	}
});

test('fitsKeyLimit: a URL fits exactly when its longest cacheKey is at most MAX_KEY_BYTES', () => {
	// Default config: '|' and the longest supported device, 'desktop' — 8 bytes on top of the URL.
	const base = 'https://www.example.com/p/';
	const urlOf = (bytes) => base + 'a'.repeat(bytes - base.length);
	assert.equal(CacheKey.fitsKeyLimit(urlOf(MAX_KEY_BYTES - 8)), true, 'its longest key is exactly the limit');
	assert.equal(CacheKey.fitsKeyLimit(urlOf(MAX_KEY_BYTES - 7)), false, 'one byte over, for the longest device');
	assert.equal(CacheKey.fitsKeyLimit(urlOf(3000)), false);
	assert.equal(CacheKey.fitsKeyLimit('https://www.example.com/'), true);
});

test('fitsKeyLimit counts bytes, not characters, where the two differ', () => {
	// 600 characters, 1,200 UTF-8 bytes: the unit count alone would not decide this one either way.
	const url = `https://www.example.com/${'\u00e9'.repeat(600)}`;
	assert.equal(CacheKey.fitsKeyLimit(url), true);
	const over = `https://www.example.com/${'\u00e9'.repeat(980)}`;
	assert.ok(over.length + 8 < MAX_KEY_BYTES, 'precondition: fewer characters than the limit');
	assert.equal(CacheKey.fitsKeyLimit(over), false, '1,960 bytes of path is over, though it is 1,004 characters');
});

test('fitsKeyLimit follows the configured key shape: a delimiter per extra attribute, the device only if keyed', () => {
	const base = 'https://www.example.com/p/';
	const urlOf = (bytes) => base + 'a'.repeat(bytes - base.length);
	applyOptions({ cacheKey: { delimiter: '::', attributes: ['url', 'deviceType', 'region'] } });
	// Two '::' plus 'desktop': 11 bytes beside the URL.
	assert.equal(CacheKey.fitsKeyLimit(urlOf(MAX_KEY_BYTES - 11)), true);
	assert.equal(CacheKey.fitsKeyLimit(urlOf(MAX_KEY_BYTES - 10)), false);
	applyOptions({ cacheKey: { attributes: ['url'] } });
	assert.equal(CacheKey.fitsKeyLimit(urlOf(MAX_KEY_BYTES)), true, 'a URL-only key is the URL itself');
	assert.equal(CacheKey.fitsKeyLimit(urlOf(MAX_KEY_BYTES + 1)), false);
});
