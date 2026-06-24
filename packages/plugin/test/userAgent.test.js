import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyOptions } from '../src/config.js';
import { getBotName } from '../src/util/userAgent.js';

// Minimal stand-in for a WHATWG Headers object.
const headers = (map) => ({ get: (k) => map[k.toLowerCase()] ?? null });

beforeEach(() => applyOptions({}));

test('identifies known crawlers from the default registry', () => {
	assert.equal(
		getBotName(headers({ 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' })),
		'Googlebot'
	);
	assert.equal(getBotName(headers({ 'user-agent': 'Mozilla/5.0 (compatible; bingbot/2.0)' })), 'Bingbot');
	assert.equal(getBotName(headers({ 'user-agent': 'GPTBot/1.0' })), 'GPTBot');
});

test('prefers the most specific (longest) match', () => {
	assert.equal(getBotName(headers({ 'user-agent': 'Googlebot-Image/1.0' })), 'Googlebot-Image');
});

test('returns "other" for non-listed or missing user agents', () => {
	assert.equal(getBotName(headers({ 'user-agent': 'Mozilla/5.0 (Macintosh) Safari/605' })), 'other');
	assert.equal(getBotName(headers({})), 'other');
});

test('returns "debug" for the debug marker header', () => {
	assert.equal(getBotName(headers({ 'harper': 'pre-render', 'user-agent': 'whatever' })), 'debug');
});

test('honors a configured bot registry (and recompiles on change)', () => {
	applyOptions({ analytics: { bots: [{ name: 'MyBot', match: 'mybot' }] } });
	assert.equal(getBotName(headers({ 'user-agent': 'MyBot/3.0 (+https://example.com)' })), 'MyBot');
	// A default crawler is no longer tracked once removed from the registry.
	assert.equal(getBotName(headers({ 'user-agent': 'Googlebot/2.1' })), 'other');
});
