import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyOptions } from '../src/config.js';
import { canonicalizeUrl } from '../src/util/url.js';

beforeEach(() => applyOptions({}));

// The single shared vector, asserted by BOTH the plugin (this file) and the browser suite,
// so the two canonicalizeUrl copies cannot drift.
const VECTORS = JSON.parse(readFileSync(new URL('../../../test-vectors/canonicalize-url.json', import.meta.url)));

test('canonicalizeUrl matches every shared cache-key vector', () => {
	for (const { url, allowlist, expected } of VECTORS) {
		assert.equal(canonicalizeUrl(url, allowlist), expected, `vector: ${url} @ ${JSON.stringify(allowlist)}`);
	}
});

test('default allowlist keeps only the page param and drops the hash', () => {
	// default queryParams is ['page']
	assert.equal(canonicalizeUrl('https://x.com/a?foo=1&page=2&bar=3#frag'), 'https://x.com/a?page=2');
});

test('drops all query params with an empty allowlist', () => {
	assert.equal(canonicalizeUrl('https://x.com/a?foo=1&page=2', []), 'https://x.com/a');
});

test('keeps all params (sorted) with the "*" sentinel', () => {
	assert.equal(canonicalizeUrl('https://x.com/a?foo=1&bar=2', ['*']), 'https://x.com/a?bar=2&foo=1');
});

test('honors a custom allowlist and sorts survivors', () => {
	assert.equal(
		canonicalizeUrl('https://x.com/a?utm=x&page=2&ref=abc', ['ref', 'page']),
		'https://x.com/a?page=2&ref=abc'
	);
});

// The crux: '+' (facet separator) and '%20' (space) are NOT collapsed — the bug that made
// sitemap-seeded multi-word-facet catalog pages a permanent cache miss.
test('preserves + and %20 distinctly (no URLSearchParams form-decode)', () => {
	assert.equal(
		canonicalizeUrl('https://x.com/a?f=Two%20Words+Kind:Sample', ['f']),
		'https://x.com/a?f=Two%20Words+Kind:Sample'
	);
});

test('collapses encoded and decoded data sub-delimiters to one key (:/%3A, ,/%2C, @/%40)', () => {
	assert.equal(canonicalizeUrl('https://x.com/a?f=A%3AB', ['*']), canonicalizeUrl('https://x.com/a?f=A:B', ['*']));
	assert.equal(canonicalizeUrl('https://x.com/a?f=A%3AB%2CC%40D', ['f']), 'https://x.com/a?f=A:B,C@D');
});

test('leaves structural separators (& = ;) encoded so the URL cannot reparse', () => {
	assert.equal(canonicalizeUrl('https://x.com/a?q=a%26b%3Dc%3Bd', ['q']), 'https://x.com/a?q=a%26b%3Dc%3Bd');
});

test('encodes a literal | in the url-half so it cannot collide with the cache-key delimiter', () => {
	assert.equal(canonicalizeUrl('https://x.com/a|b/c', ['*']), 'https://x.com/a%7Cb/c');
	// literal and pre-encoded pipe collapse to the same form
	assert.equal(canonicalizeUrl('https://x.com/a|b/c', ['*']), canonicalizeUrl('https://x.com/a%7Cb/c', ['*']));
});

test('drops a trailing slash on a non-root path but keeps root "/"', () => {
	assert.equal(canonicalizeUrl('https://x.com/a/', ['*']), 'https://x.com/a');
	assert.equal(canonicalizeUrl('https://x.com/', ['*']), 'https://x.com/');
});

test('the returned half round-trips through new URL() unchanged (safe to build a fetch URL from)', () => {
	for (const { url, allowlist } of VECTORS) {
		const half = canonicalizeUrl(url, allowlist);
		assert.equal(new URL(half).href, half, `round-trip: ${half}`);
	}
});

test('accepts a URL object and an explicit allowlist overrides the global policy', () => {
	applyOptions({ cacheKey: { queryParams: ['page'] } });
	assert.equal(canonicalizeUrl(new URL('https://x.com/a?page=2&f=foo&utm=z'), ['f']), 'https://x.com/a?f=foo');
});

// --- RFC 3986 §6.2.2 normalization: the part no site can disagree with ---

test('unreserved escapes are always decoded (percent-encoding normalization)', () => {
	// ALPHA / DIGIT / - . _ ~ — `/%68ello` and `/hello` are the same resource by definition,
	// so keying them apart would be a duplicate for every origin that exists.
	assert.equal(canonicalizeUrl('https://x.com/%68ello/w%6Frld', []), 'https://x.com/hello/world');
	assert.equal(canonicalizeUrl('https://x.com/a?f=%41%2D%5F%7E%39', ['f']), 'https://x.com/a?f=A-_~9');
});

test('%2E needs no special case — the parser resolved dot segments first', () => {
	// The worry is that decoding %2E manufactures a `.`/`..` segment and re-points the path.
	// It cannot: WHATWG new URL() resolves dot segments in their ENCODED spellings too, so
	// they are gone before this runs, and what survives is inside a real segment.
	assert.equal(canonicalizeUrl('https://x.com/p/%2E%2E/x', []), 'https://x.com/x'); // .. popped `p`
	assert.equal(canonicalizeUrl('https://x.com/a%2Eb', []), 'https://x.com/a.b');
	assert.equal(canonicalizeUrl('https://x.com/a?f=1%2E5', ['f']), 'https://x.com/a?f=1.5');
});

test('structural escapes are never decoded, whatever the config says', () => {
	// %26 would split the query in two, %2F would invent a path segment, %2B would change a
	// facet separator into a literal plus. The schema refuses them in decodeReserved (below).
	assert.equal(
		canonicalizeUrl('https://x.com/a?f=Coats%20%26%20Jackets%2FOuterwear%2Bx', ['f']),
		'https://x.com/a?f=Coats%20%26%20Jackets%2FOuterwear%2Bx'
	);
});

// --- decodeReserved: the part that IS a claim about one origin ---

test('decodeReserved defaults to the WHATWG/Chrome-literal set', () => {
	assert.equal(canonicalizeUrl('https://x.com/a?f=A%3AB%2CC%40D', ['f']), 'https://x.com/a?f=A:B,C@D');
});

test('decodeReserved: [] decodes nothing beyond unreserved (what a CDN does)', () => {
	applyOptions({ cacheKey: { decodeReserved: [] } });
	assert.equal(canonicalizeUrl('https://x.com/a?f=A%3AB%2CC%40D', ['f']), 'https://x.com/a?f=A%3AB%2CC%40D');
	// …while the standards-mandated half is unaffected by config.
	assert.equal(canonicalizeUrl('https://x.com/%68i', []), 'https://x.com/hi');
});

test('decodeReserved can drop the comma alone — for a site with list-valued params', () => {
	applyOptions({ cacheKey: { decodeReserved: [':', '@'] } });
	assert.equal(canonicalizeUrl('https://x.com/a?f=A%3AB%2CC', ['f']), 'https://x.com/a?f=A:B%2CC');
});

test('a structural character in decodeReserved is refused and the default kept', () => {
	// Whole-list rejection: `&` in the set would decode a separator into every key, and a
	// half-applied key policy is worse than the default one.
	applyOptions({ cacheKey: { decodeReserved: [':', '&'] } });
	assert.equal(canonicalizeUrl('https://x.com/a?f=A%3AB%26C', ['f']), 'https://x.com/a?f=A:B%26C');
});
