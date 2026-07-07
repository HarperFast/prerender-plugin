import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyOptions } from '../src/config.js';
import { normalizeUrl, cacheKeyUrl } from '../src/util/url.js';

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

// cacheKeyUrl presents the cache-key form of an ALREADY-NORMALIZED url: it decodes `:` so
// keys read like the canonical form (`?CN=Gender:Mens`). Pure transform — it must NOT
// re-normalize or drop params (serving already applied the route/global allowlist).
test('cacheKeyUrl decodes ":" and preserves the (already-normalized) query verbatim', () => {
	assert.equal(
		cacheKeyUrl('https://www.kohls.com/catalog/mens-clothing.jsp?CN=Gender%3AMens+Department%3AClothing'),
		'https://www.kohls.com/catalog/mens-clothing.jsp?CN=Gender:Mens+Department:Clothing'
	);
});

test('cacheKeyUrl does not drop params (no allowlist re-applied)', () => {
	// even a param the global allowlist would drop is preserved — the caller already normalized
	assert.equal(cacheKeyUrl('https://x.com/a?CN=x%3Ay&foo=1'), 'https://x.com/a?CN=x:y&foo=1');
});

test('cacheKeyUrl decodes safe query sub-delimiters (: , @) but leaves separators encoded', () => {
	assert.equal(cacheKeyUrl('https://x.com/a?CN=A%3AB%2CC%40D'), 'https://x.com/a?CN=A:B,C@D');
	// %26 (&), %3D (=), %3B (;) stay encoded — decoding them could shift how the URL parses.
	assert.equal(cacheKeyUrl('https://x.com/a?q=a%26b%3Dc%3Bd'), 'https://x.com/a?q=a%26b%3Dc%3Bd');
});

test('cacheKeyUrl accepts a URL object and never throws', () => {
	assert.equal(cacheKeyUrl(new URL('https://x.com/a?CN=x%3Ay')), 'https://x.com/a?CN=x:y');
	assert.doesNotThrow(() => cacheKeyUrl('::::not a url'));
});

// The encoded/decoded COLLAPSE comes from normalizeUrl (sort re-encodes to %3A) then
// cacheKeyUrl (decode) — the pipeline the serving + scheduling paths use.
test('normalizeUrl -> cacheKeyUrl collapses encoded and decoded to one key', () => {
	applyOptions({ url: { queryParams: ['*'] } });
	const enc = cacheKeyUrl(normalizeUrl('https://x.com/a?CN=Gender%3AMens'));
	const dec = cacheKeyUrl(normalizeUrl('https://x.com/a?CN=Gender:Mens'));
	assert.equal(enc, dec);
	assert.equal(enc, 'https://x.com/a?CN=Gender:Mens');
});
