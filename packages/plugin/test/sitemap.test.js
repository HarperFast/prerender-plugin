import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSitemap } from '../src/util/sitemap.js';

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

test('throws on an HTML error/challenge page (the Akamai 403 case)', () => {
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
