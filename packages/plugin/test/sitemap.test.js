import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSitemap, sitemapTargetNeedsUpdate } from '../src/util/sitemap.js';

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

/**
 * Regression tests for the refresh's "has this target changed" decision.
 *
 * This is the same projection trap that broke pause in v0.8.0 (see queueControlRead.test.js):
 * a STRING select returns the bare value, an ARRAY select builds a record. The call site read
 * `.sitemapUrl` off the result, so with a string select it was always `undefined` and every
 * known target was re-put on every refresh — each put recomputing `getInitialRenderTime`
 * (now + jitter) and pushing the next render forward. Targets with an interval longer than the
 * refresh period never came due at all.
 *
 * The fake reproduces Harper's projection semantics so the wrong select shape fails here.
 */

const project = (row, select) => {
	if (!row) return undefined;
	// Mirror Harper's `resources/Table.ts`: a string select assigns the value itself.
	if (typeof select === 'string') return row[select];
	if (Array.isArray(select)) {
		const projected = {};
		for (const attribute of select) projected[attribute] = row[attribute];
		return projected;
	}
	return row;
};

const SITEMAP = 'https://x/sitemap.xml';

test('an unchanged target is not re-put (array select — the shape the call site uses)', () => {
	const existing = project({ cacheKey: 'https://x/a|desktop', sitemapUrl: SITEMAP }, ['sitemapUrl']);
	assert.equal(sitemapTargetNeedsUpdate(existing, SITEMAP), false);
});

test('a target that moved to a different sitemap is re-put', () => {
	const existing = project({ cacheKey: 'https://x/a|desktop', sitemapUrl: 'https://x/old.xml' }, ['sitemapUrl']);
	assert.equal(sitemapTargetNeedsUpdate(existing, SITEMAP), true);
});

test('a target pruned out of every sitemap (sitemapUrl null) is re-put when it returns', () => {
	const existing = project({ cacheKey: 'https://x/a|desktop', sitemapUrl: null }, ['sitemapUrl']);
	assert.equal(sitemapTargetNeedsUpdate(existing, SITEMAP), true);
});

test('a STRING select makes an unchanged target look changed — the bug this guards', () => {
	// Documents why the call site must pass an array. If someone "optimizes" it back to a
	// string, this is the behavior they reintroduce: every target re-put on every refresh.
	const scalar = project({ cacheKey: 'https://x/a|desktop', sitemapUrl: SITEMAP }, 'sitemapUrl');
	assert.equal(scalar, SITEMAP, 'a string select returns the bare value');
	assert.equal(sitemapTargetNeedsUpdate(scalar, SITEMAP), true);
});
