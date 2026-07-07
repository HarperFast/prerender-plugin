import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrlForCompare, normalizeCanonicalUrl, canonicalAllowsIndex } from '../dist/util/url.js';

// The reported bug: the request carries %3A (encoded colon) while the page's canonical uses
// the literal ':'. They name the same resource, so the page is self-canonical → indexable.
test('canonical with a decoded reserved char (: vs %3A) counts as self-canonical', () => {
	const requested = 'https://www.kohls.com/catalog/mens-clothing.jsp?CN=Gender%3AMens+Department%3AClothing';
	const canonical = 'https://www.kohls.com/catalog/mens-clothing.jsp?CN=Gender:Mens+Department:Clothing';
	assert.equal(canonicalAllowsIndex(canonical, requested), true);
});

test('a genuinely different canonical is NOT self-canonical (stays non-indexable)', () => {
	const requested = 'https://www.kohls.com/catalog/mens-clothing.jsp?CN=Gender%3AMens';
	const canonical = 'https://www.kohls.com/catalog/womens-clothing.jsp?CN=Gender%3AWomens';
	assert.equal(canonicalAllowsIndex(canonical, requested), false);
});

test('no canonical → indexable', () => {
	assert.equal(canonicalAllowsIndex(null, 'https://www.kohls.com/x'), true);
	assert.equal(canonicalAllowsIndex(undefined, 'https://www.kohls.com/x'), true);
	assert.equal(canonicalAllowsIndex('', 'https://www.kohls.com/x'), true);
});

test('param order, trailing slash, and hash differences do not break self-canonical', () => {
	const current = 'https://www.kohls.com/p?b=2&a=1';
	assert.equal(canonicalAllowsIndex('https://www.kohls.com/p?a=1&b=2', current), true); // order
	assert.equal(canonicalAllowsIndex('https://www.kohls.com/p/?b=2&a=1', current), true); // trailing slash
	assert.equal(canonicalAllowsIndex('https://www.kohls.com/p?b=2&a=1#frag', current), true); // hash
});

test('a relative canonical resolves against the current URL', () => {
	const current = 'https://www.kohls.com/catalog/mens-clothing.jsp?CN=Gender%3AMens';
	assert.equal(canonicalAllowsIndex('/catalog/mens-clothing.jsp?CN=Gender:Mens', current), true);
});

test('a malformed canonical fails open (does not drop indexability)', () => {
	assert.equal(canonicalAllowsIndex('http://[bad', 'https://www.kohls.com/x'), true);
});

test('normalizeCanonicalUrl canonicalizes encoding, param order, hash, and trailing slash', () => {
	assert.equal(
		normalizeCanonicalUrl('https://x.com/a/?c=2&b=Gender:Mens#h'),
		normalizeCanonicalUrl('https://x.com/a?b=Gender%3AMens&c=2')
	);
});

test('normalizeCanonicalUrl is idempotent', () => {
	const once = normalizeCanonicalUrl('https://www.kohls.com/p/?b=2&a=Gender:Mens#h');
	assert.equal(normalizeCanonicalUrl(once), once);
});

test('normalizeUrlForCompare (redirect detection) is param-order-insensitive', () => {
	assert.equal(normalizeUrlForCompare('https://x.com/p?b=2&a=1'), normalizeUrlForCompare('https://x.com/p?a=1&b=2'));
});

// A malformed %-sequence must not throw URIError out of these normalizers — they run on
// every render job, and an uncaught throw would fail the job permanently.
test('malformed percent-encoding falls back to raw instead of throwing', () => {
	for (const bad of ['https://x.com/%E0%A0/a', 'https://x.com/p?x=%E0%A0']) {
		assert.doesNotThrow(() => normalizeUrlForCompare(bad));
		assert.doesNotThrow(() => normalizeCanonicalUrl(bad));
	}
	assert.doesNotThrow(() => canonicalAllowsIndex('https://x.com/a', 'https://x.com/%E0%A0/a'));
});
