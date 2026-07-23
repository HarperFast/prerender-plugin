import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
	canonicalizeUrl,
	normalizeUrlForCompare,
	normalizeCanonicalUrl,
	canonicalAllowsIndex,
} from '../dist/util/url.js';

// The single shared vector, asserted by BOTH the browser (this file) and the plugin suite,
// so the two canonicalizeUrl copies (TS here, JS in the plugin) cannot drift.
const VECTORS: { url: string; allowlist: string[]; expected: string }[] = JSON.parse(
	readFileSync(new URL('../../../test-vectors/canonicalize-url.json', import.meta.url), 'utf8')
);

test('canonicalizeUrl matches every shared cache-key vector (must equal the plugin)', () => {
	for (const { url, allowlist, expected } of VECTORS) {
		assert.equal(canonicalizeUrl(url, allowlist), expected, `vector: ${url} @ ${JSON.stringify(allowlist)}`);
	}
});

// Redirect detection compares canonicalizeUrl(page.url()) vs canonicalizeUrl(job.url). A page
// that did not redirect must NOT be flagged just because Chrome's page.url() re-encodes, adds a
// trailing slash, or reorders params relative to the stored key.
test('canonicalizeUrl does not flag a non-redirect (encoding / trailing slash / order)', () => {
	const jobUrl = 'https://example.com/p?b=2&a=1';
	assert.equal(canonicalizeUrl('https://example.com/p/?a=1&b=2'), canonicalizeUrl(jobUrl)); // slash + order
	assert.equal(canonicalizeUrl('https://example.com/p?a=1&b=2#frag'), canonicalizeUrl(jobUrl)); // hash
	// ':' literal (Chrome's form) matches a stored key that decoded '%3A' to ':'
	assert.equal(canonicalizeUrl('https://example.com/a?f=X:Y'), canonicalizeUrl('https://example.com/a?f=X%3AY'));
});

// --- indexability (self-canonical) comparison — separate from the cache key ---

// The request carries %3A (encoded colon) while the page's canonical uses the literal ':'.
// They name the same resource, so the page is self-canonical → indexable.
test('canonical with a decoded reserved char (: vs %3A) counts as self-canonical', () => {
	const requested = 'https://example.com/c/page.jsp?f=A%3AB+g%3AC';
	const canonical = 'https://example.com/c/page.jsp?f=A:B+g:C';
	assert.equal(canonicalAllowsIndex(canonical, requested), true);
});

test('a genuinely different canonical is NOT self-canonical (stays non-indexable)', () => {
	const requested = 'https://example.com/c/page-a.jsp?f=A%3AB';
	const canonical = 'https://example.com/c/page-b.jsp?f=X%3AY';
	assert.equal(canonicalAllowsIndex(canonical, requested), false);
});

test('no canonical → indexable', () => {
	assert.equal(canonicalAllowsIndex(null, 'https://example.com/x'), true);
	assert.equal(canonicalAllowsIndex(undefined, 'https://example.com/x'), true);
	assert.equal(canonicalAllowsIndex('', 'https://example.com/x'), true);
});

test('param order, trailing slash, and hash differences do not break self-canonical', () => {
	const current = 'https://example.com/p?b=2&a=1';
	assert.equal(canonicalAllowsIndex('https://example.com/p?a=1&b=2', current), true); // order
	assert.equal(canonicalAllowsIndex('https://example.com/p/?b=2&a=1', current), true); // trailing slash
	assert.equal(canonicalAllowsIndex('https://example.com/p?b=2&a=1#frag', current), true); // hash
});

test('a relative canonical resolves against the current URL', () => {
	const current = 'https://example.com/c/page.jsp?f=A%3AB';
	assert.equal(canonicalAllowsIndex('/c/page.jsp?f=A:B', current), true);
});

test('a malformed canonical fails open (does not drop indexability)', () => {
	assert.equal(canonicalAllowsIndex('http://[bad', 'https://example.com/x'), true);
});

test('normalizeCanonicalUrl canonicalizes encoding, param order, hash, and trailing slash', () => {
	assert.equal(
		normalizeCanonicalUrl('https://x.com/a/?c=2&b=A:B#h'),
		normalizeCanonicalUrl('https://x.com/a?b=A%3AB&c=2')
	);
});

test('normalizeCanonicalUrl is idempotent', () => {
	const once = normalizeCanonicalUrl('https://example.com/p/?b=2&a=A:B#h');
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
		assert.doesNotThrow(() => canonicalizeUrl(bad));
	}
	assert.doesNotThrow(() => canonicalAllowsIndex('https://x.com/a', 'https://x.com/%E0%A0/a'));
});
