import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyOptions } from '../src/config.js';
import { isHtmlContentType, isPrerenderCandidate } from '../src/util/indexSignals.js';

beforeEach(() => applyOptions({}));

test('isHtmlContentType recognizes HTML mime types', () => {
	assert.equal(isHtmlContentType('text/html; charset=utf-8'), true);
	assert.equal(isHtmlContentType('application/xhtml+xml'), true);
	assert.equal(isHtmlContentType('application/json'), false);
	assert.equal(isHtmlContentType(undefined), false);
});

test('isPrerenderCandidate requires 200 + HTML and no noindex', () => {
	const ok = { statusCode: 200, url: 'https://x.com/', headers: { 'content-type': 'text/html' } };
	assert.equal(isPrerenderCandidate(ok), true);

	const non200 = { statusCode: 404, url: 'https://x.com/', headers: { 'content-type': 'text/html' } };
	assert.equal(isPrerenderCandidate(non200), false);

	const notHtml = { statusCode: 200, url: 'https://x.com/', headers: { 'content-type': 'application/json' } };
	assert.equal(isPrerenderCandidate(notHtml), false);

	const noindex = {
		statusCode: 200,
		url: 'https://x.com/',
		headers: { 'content-type': 'text/html', 'x-robots-tag': 'noindex' },
	};
	assert.equal(isPrerenderCandidate(noindex), false);
});

test('isPrerenderCandidate rejects a contradicting canonical Link header', () => {
	const resource = {
		statusCode: 200,
		url: 'https://x.com/a',
		headers: { 'content-type': 'text/html', 'link': '<https://x.com/b>; rel="canonical"' },
	};
	assert.equal(isPrerenderCandidate(resource), false);
});
