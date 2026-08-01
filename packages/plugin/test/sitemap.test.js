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

// --- partitionSitemapEntries: only prerender routes become render targets ---

const ROUTES = [
	{ match: 'exact', path: '/', queryParams: [] },
	{ match: 'prefix', path: '/catalog/', queryParams: ['CN'] },
	{ match: 'prefix', path: '/orders/', mode: 'passthrough' },
];

const forwarded = (extra = {}) =>
	applyOptions({ ingress: { mode: 'forwarded', routes: ROUTES }, excludePathPatterns: [], ...extra });

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

test('carries the entry through so changefreq still drives renderInterval', () => {
	forwarded();
	const { incoming } = partitionSitemapEntries([{ loc: 'https://www.example.com/catalog/a.jsp', changefreq: 'daily' }]);
	assert.equal(incoming.get('https://www.example.com/catalog/a.jsp').changefreq, 'daily');
});

test('prefix mode keeps everything except a folded exclude', () => {
	// No route list gates ingress in prefix mode, so a sitemap is not filtered down to routes.
	applyOptions({ excludePathPatterns: ['/search/'] });
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
