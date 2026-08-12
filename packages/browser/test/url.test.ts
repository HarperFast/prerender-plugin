import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canonicalizeUrl, normalizeUrlForCompare, normalizeCanonicalUrl, canonicalVerdict } from '../dist/util/url.js';

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

// --- canonical verdict: read against the CACHE KEY, not the document ---

// The request carries %3A (encoded colon) while the page's canonical uses the literal ':'.
// canonicalizeUrl decodes both to ':', so they are one key → self-canonical → indexable.
test('canonical with a decoded reserved char (: vs %3A) counts as self-canonical', () => {
	const requested = 'https://example.com/c/page.jsp?f=A%3AB+g%3AC';
	const canonical = 'https://example.com/c/page.jsp?f=A:B+g:C';
	assert.equal(canonicalVerdict(canonical, requested), 'self');
});

test('a genuinely different canonical points elsewhere (stays non-indexable)', () => {
	const requested = 'https://example.com/c/page-a.jsp?f=A%3AB';
	const canonical = 'https://example.com/c/page-b.jsp?f=X%3AY';
	assert.equal(canonicalVerdict(canonical, requested), 'elsewhere');
});

test('no canonical → self (indexable)', () => {
	assert.equal(canonicalVerdict(null, 'https://example.com/x'), 'self');
	assert.equal(canonicalVerdict(undefined, 'https://example.com/x'), 'self');
	assert.equal(canonicalVerdict('', 'https://example.com/x'), 'self');
});

test('param order, trailing slash, and hash differences do not break self-canonical', () => {
	const current = 'https://example.com/p?b=2&a=1';
	assert.equal(canonicalVerdict('https://example.com/p?a=1&b=2', current), 'self'); // order
	assert.equal(canonicalVerdict('https://example.com/p/?b=2&a=1', current), 'self'); // trailing slash
	assert.equal(canonicalVerdict('https://example.com/p?b=2&a=1#frag', current), 'self'); // hash
});

test('a relative canonical resolves against the current URL', () => {
	const current = 'https://example.com/c/page.jsp?f=A%3AB';
	assert.equal(canonicalVerdict('/c/page.jsp?f=A:B', current), 'self');
});

test('a malformed canonical fails open (does not drop indexability)', () => {
	assert.equal(canonicalVerdict('http://[bad', 'https://example.com/x'), 'self');
});

// THE CASE THIS VERDICT EXISTS FOR. A faceted origin resolves `+`, `%2B` and `%20` between
// facets to the same page and canonicalizes all of them to the `+` spelling — but each spelling
// is its own cache key, so without this verdict every crawler-invented re-encoding becomes a
// second recurring target holding byte-identical content. The form-encoding comparison cannot
// see it: `%20` and `+` collapse to the same string there, which is exactly why the verdict is
// taken on canonicalizeUrl instead.
test('a %20-for-+ separator re-spelling is a duplicate KEY, not a self-canonical page', () => {
	const canonical = 'https://example.com/c/page.jsp?f=Color:Black+Size:Large';
	const respelled = 'https://example.com/c/page.jsp?f=Color:Black%20Size:Large';
	assert.notEqual(canonicalizeUrl(respelled, ['f']), canonicalizeUrl(canonical, ['f']));
	assert.equal(normalizeCanonicalUrl(respelled), normalizeCanonicalUrl(canonical)); // same document…
	assert.equal(canonicalVerdict(canonical, respelled), 'variant'); // …different key ⇒ suppress
});

test('a %2B-for-+ separator re-spelling is also non-indexable', () => {
	const canonical = 'https://example.com/c/page.jsp?f=Color:Black+Size:Large';
	const respelled = 'https://example.com/c/page.jsp?f=Color:Black%2BSize:Large';
	assert.notEqual(canonicalVerdict(canonical, respelled), 'self');
});

test('facet values in another order are not self-canonical', () => {
	const canonical = 'https://example.com/c/page.jsp?f=Color:Black+Size:Large';
	const reordered = 'https://example.com/c/page.jsp?f=Size:Large+Color:Black';
	assert.equal(canonicalVerdict(canonical, reordered), 'elsewhere');
});

// The mirror image, and the reason this must not be solved by folding `+` and `%2B` in the
// cache key: in VALUE position they are different values (`BLACK+DECKER` the brand vs the two
// facets `BLACK` and `DECKER`). A self-canonical page keeping `%2B` must stay indexable.
test('a %2B inside a facet VALUE is self-canonical and must not be flagged', () => {
	const url = 'https://example.com/c/page.jsp?f=Brand:ACME%2BCO';
	assert.equal(canonicalVerdict(url, url), 'self');
	assert.equal(canonicalVerdict('/c/page.jsp?f=Brand:ACME%2BCO', url), 'self');
});

// The rendered URL is already route-filtered, so params the route drops must not be able to
// manufacture a mismatch — the plugin would never have keyed them in the first place.
test('a param the route dropped cannot create a mismatch', () => {
	const current = 'https://example.com/c/page.jsp?f=A:B';
	assert.equal(canonicalVerdict('https://example.com/c/page.jsp?f=A:B&utm_source=x', current), 'self');
	// …and a query-less request (a route that drops everything) ignores the canonical's query.
	assert.equal(canonicalVerdict('https://example.com/p/prd-1?color=red', 'https://example.com/p/prd-1'), 'self');
});

// The reverse is a real verdict: the origin saying "the canonical of this filtered page is the
// unfiltered one" means this key duplicates that one.
test('a canonical that drops a param the request kept is not self', () => {
	assert.notEqual(canonicalVerdict('https://example.com/c/page.jsp', 'https://example.com/c/page.jsp?f=A:B'), 'self');
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
	assert.doesNotThrow(() => canonicalVerdict('https://x.com/a', 'https://x.com/%E0%A0/a'));
});
