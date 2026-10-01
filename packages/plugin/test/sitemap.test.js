import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSitemap, partitionSitemapEntries } from '../src/util/sitemap.js';
import { applyOptions } from '../src/config.js';
import { PASSTHROUGH, UNCLASSIFIED } from '../src/util/routeClass.js';

const xmlDecl = '<?xml version="1.0" encoding="UTF-8"?>';

test('parses a <urlset> with multiple <url> entries', () => {
	const { isIndex, entries } = parseSitemap(
		`${xmlDecl}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
			`<url><loc>https://x/a</loc></url><url><loc>https://x/b</loc></url></urlset>`
	);
	assert.equal(isIndex, false);
	assert.equal(entries.length, 2);
	assert.equal(entries[0].loc, 'https://x/a');
});

test('normalizes a single <url> to a one-element array', () => {
	const { isIndex, entries } = parseSitemap(`${xmlDecl}<urlset><url><loc>https://x/a</loc></url></urlset>`);
	assert.equal(isIndex, false);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].loc, 'https://x/a');
});

test('parses a <sitemapindex> as an index', () => {
	const { isIndex, entries } = parseSitemap(
		`${xmlDecl}<sitemapindex><sitemap><loc>https://x/s1.xml</loc></sitemap></sitemapindex>`
	);
	assert.equal(isIndex, true);
	assert.equal(entries.length, 1);
	assert.equal(entries[0].loc, 'https://x/s1.xml');
});

test('a valid but empty <urlset> yields no entries WITHOUT throwing', () => {
	const { isIndex, entries } = parseSitemap(`${xmlDecl}<urlset></urlset>`);
	assert.equal(isIndex, false);
	assert.deepEqual(entries, []);
});

test('a self-closing empty <urlset/> yields no entries without throwing', () => {
	const { entries } = parseSitemap(`${xmlDecl}<urlset/>`);
	assert.deepEqual(entries, []);
});

test('an empty <sitemapindex> yields no entries without throwing', () => {
	const { isIndex, entries } = parseSitemap(`${xmlDecl}<sitemapindex></sitemapindex>`);
	assert.equal(isIndex, true);
	assert.deepEqual(entries, []);
});

test('throws on an HTML error/challenge page (the CDN 403 case)', () => {
	const html = '<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY><H1>Access Denied</H1></BODY></HTML>';
	assert.throws(() => parseSitemap(html), /expected a <urlset> or <sitemapindex> root, got <HTML>/);
});

test('throws on an empty document', () => {
	assert.throws(() => parseSitemap(''), /got a non-XML or empty document/);
});

test('throws on a plain-text (non-XML) response — e.g. a bare "Access Denied"', () => {
	// fast-xml-parser parses plain text to {}, so this must NOT crash on `'urlset' in data`.
	assert.throws(() => parseSitemap('Access Denied'), /got a non-XML or empty document/);
});

// --- truncation: a cut-off document is refused, never read as a shorter sitemap ---

test('a <urlset> whose root is never closed is refused as truncated, not parsed to its prefix', () => {
	const cut = `${xmlDecl}<urlset><url><loc>https://x/a</loc></url><url><loc>https://x/b</loc></url><url><loc>https://x/`;
	// The parser hands back the half-written third entry too — which is exactly why the prefix must not be trusted.
	assert.throws(() => parseSitemap(cut), /truncated — its <urlset> is never closed \(3 entries before the cut\)/);
});

test('a <sitemapindex> cut off mid-list is refused the same way', () => {
	const cut = `${xmlDecl}<sitemapindex><sitemap><loc>https://x/s1.xml</loc></sitemap><sitemap><loc>https://x/s`;
	assert.throws(() => parseSitemap(cut), /truncated — its <sitemapindex> is never closed/);
});

test('whitespace, comments and processing instructions after the root close are not truncation', () => {
	const { entries } = parseSitemap(
		`${xmlDecl}<urlset><url><loc>https://x/a</loc></url></urlset>\n<!-- generated 2026-09-29 -->\n<?done?>\n`
	);
	assert.equal(entries.length, 1);
	assert.deepEqual(
		parseSitemap(`${xmlDecl}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"/>\n`).entries,
		[]
	);
});

test('an unescaped ampersand — invalid XML every parser tolerates — is still accepted: truncation is the only refusal', () => {
	const { entries } = parseSitemap(`${xmlDecl}<urlset><url><loc>https://x/a?b=1&c=2</loc></url></urlset>`);
	assert.equal(entries.length, 1);
});

test('a truncated GZIP body, which undici decodes leniently to a prefix with status 200, is refused', async () => {
	const { createServer } = await import('node:http');
	const { gzipSync } = await import('node:zlib');
	const locs = Array.from({ length: 5000 }, (_, i) => `<url><loc>https://example.com/product/prd-${i}</loc></url>`);
	const gz = gzipSync(
		`${xmlDecl}<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.join('')}</urlset>`
	);
	const cut = gz.subarray(0, Math.floor(gz.length * 0.4));
	const server = createServer((req, res) => {
		res.writeHead(200, { 'content-type': 'application/xml', 'content-encoding': 'gzip', 'content-length': cut.length });
		res.end(cut);
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	try {
		const res = await fetch(`http://127.0.0.1:${server.address().port}/sitemap.xml`);
		assert.equal(res.status, 200);
		const text = await res.text();
		assert.ok(text.length > 0, 'the prefix arrives with no error');
		assert.throws(() => parseSitemap(text), /truncated/);
	} finally {
		server.close();
	}
});

// --- partitionSitemapEntries: only prerender routes become render targets ---

const ROUTES = [
	{ match: 'exact', path: '/', queryParams: [] },
	{ match: 'prefix', path: '/catalog/', queryParams: ['CN'] },
	{ match: 'prefix', path: '/orders/', mode: 'passthrough' },
];

const forwarded = ({ excludePathPatterns = [] } = {}) =>
	applyOptions({ ingress: { mode: 'forwarded', routes: ROUTES, excludePathPatterns } });

const locs = (...urls) => urls.map((loc) => ({ loc }));

test('keeps prerender entries and counts the rest by class', () => {
	forwarded();
	const { incoming, filtered, invalid } = partitionSitemapEntries(
		locs(
			'https://www.example.com/',
			'https://www.example.com/catalog/a.jsp',
			'https://www.example.com/orders/history', // declared passthrough
			'https://www.example.com/blog/post' // nothing matched
		)
	);

	assert.deepEqual([...incoming.keys()], ['https://www.example.com/', 'https://www.example.com/catalog/a.jsp']);
	assert.equal(filtered[PASSTHROUGH], 1);
	assert.equal(filtered[UNCLASSIFIED], 1);
	assert.deepEqual(invalid, []);
});

test('reports every route the entries fall on, filtered ones included', () => {
	forwarded();
	const { routes } = partitionSitemapEntries(
		locs('https://www.example.com/catalog/a.jsp', 'https://www.example.com/orders/x', 'https://www.example.com/blog/y')
	);
	assert.equal(routes.size, 3, 'the catalog route, the passthrough route and the unclassified class');
	assert.ok(routes.has(UNCLASSIFIED));
});

test('keys kept entries with the matched route allowlist, not the raw URL', () => {
	// The key has to equal what a bot read computes, or the render is stored where nothing looks.
	forwarded();
	const { incoming } = partitionSitemapEntries(locs('https://www.example.com/catalog/a.jsp?CN=x&utm=y'));
	assert.deepEqual([...incoming.keys()], ['https://www.example.com/catalog/a.jsp?CN=x']);
});

test('a folded excludePathPatterns entry filters as passthrough', () => {
	forwarded({ excludePathPatterns: ['/search/'] });
	const { incoming, filtered } = partitionSitemapEntries(locs('https://www.example.com/catalog/search/results'));
	assert.equal(incoming.size, 0);
	assert.equal(filtered[PASSTHROUGH], 1);
});

test('one malformed <loc> is reported without losing the good entries', () => {
	forwarded();
	const { incoming, invalid } = partitionSitemapEntries(
		locs('not-a-url', 'https://www.example.com/catalog/a.jsp', 'also/bad')
	);
	assert.equal(incoming.size, 1);
	assert.equal(invalid.length, 2);
	assert.equal(invalid[0].loc, 'not-a-url');
	assert.ok(invalid[0].message);
});

test('a <loc> too long to be a cache key is reported invalid, and the rest of the sitemap still lands', () => {
	// The ingest's Target.get would throw on its key — Harper refuses a key past its limit — and a throw
	// there ended the child's ingest partway, losing every entry after it.
	forwarded();
	const long = `https://www.example.com/catalog/a.jsp?CN=${'Room:Patio%20%26%20Outdoor+'.repeat(80)}`;
	const { incoming, invalid } = partitionSitemapEntries(
		locs('https://www.example.com/catalog/a.jsp', long, 'https://www.example.com/catalog/b.jsp')
	);
	assert.deepEqual(
		[...incoming.keys()],
		['https://www.example.com/catalog/a.jsp', 'https://www.example.com/catalog/b.jsp']
	);
	assert.equal(invalid.length, 1);
	assert.equal(invalid[0].loc, long);
	assert.match(invalid[0].message, /too long to be a cache key \(\d+ bytes; the limit is 1978\)/);
});

test('a long <loc> whose KEY fits is kept: the bound is on the canonical key, not the raw URL', () => {
	// The route allowlist drops `utm`, so the key is short however long the listed URL is.
	forwarded();
	const loc = `https://www.example.com/catalog/a.jsp?CN=x&utm=${'y'.repeat(3000)}`;
	const { incoming, invalid } = partitionSitemapEntries(locs(loc));
	assert.deepEqual([...incoming.keys()], ['https://www.example.com/catalog/a.jsp?CN=x']);
	assert.deepEqual(invalid, []);
});

test('carries the entry through so changefreq still drives renderInterval', () => {
	forwarded();
	const { incoming } = partitionSitemapEntries([{ loc: 'https://www.example.com/catalog/a.jsp', changefreq: 'daily' }]);
	assert.equal(incoming.get('https://www.example.com/catalog/a.jsp').changefreq, 'daily');
});

test('prefix mode keeps everything except a folded exclude', () => {
	// No route list gates ingress in prefix mode, so a sitemap is not filtered down to routes.
	applyOptions({ ingress: { excludePathPatterns: ['/search/'] } });
	const { incoming, filtered } = partitionSitemapEntries(
		locs('https://www.example.com/anything', 'https://www.example.com/search/q')
	);
	assert.equal(incoming.size, 1);
	assert.equal(filtered[PASSTHROUGH], 1);
});

test('tolerates a non-array entries value', () => {
	forwarded();
	const { incoming, filtered, invalid } = partitionSitemapEntries(undefined);
	assert.equal(incoming.size, 0);
	assert.equal(filtered[UNCLASSIFIED], 0);
	assert.deepEqual(invalid, []);
});
