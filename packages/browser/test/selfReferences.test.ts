import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fragmentOnlySelfReferences } from '../dist/selfReferences.js';
import { renderOnce } from '../dist/renderOnce.js';

// A snapshot is served at URLs other than the one it was rendered at (a dropped query string, another
// spelling of the same entity). An absolute `url(<page URL>#id)` then names a different document; the
// fragment-only spelling names this one wherever it is served.

const PAGE = 'https://www.example.com/product/prd-1/some-slug.jsp';

test('an absolute self-reference in a presentation attribute becomes fragment-only', () => {
	const html = `<svg><path fill="url(${PAGE}#star_filled)"></path></svg>`;
	assert.equal(fragmentOnlySelfReferences(html, PAGE), '<svg><path fill="url(#star_filled)"></path></svg>');
});

test('every reference on the page is rewritten, in every quoting the serializer can produce', () => {
	const html = [
		`<path fill="url(${PAGE}#a)">`,
		`<path stroke="url(&quot;${PAGE}#b&quot;)">`,
		`<path style="fill: url('${PAGE}#c')">`,
		`<path mask="URL( ${PAGE}#d)">`,
		`<style>.x{fill:url("${PAGE}#e")}</style>`,
	].join('');
	assert.equal(
		fragmentOnlySelfReferences(html, PAGE),
		[
			'<path fill="url(#a)">',
			'<path stroke="url(&quot;#b&quot;)">',
			`<path style="fill: url('#c')">`,
			'<path mask="URL( #d)">',
			'<style>.x{fill:url("#e")}</style>',
		].join('')
	);
});

test('scheme-relative and path-absolute spellings of this page are self-references too', () => {
	const html = `<path fill="url(//www.example.com/product/prd-1/some-slug.jsp#a)"><path fill="url(/product/prd-1/some-slug.jsp#b)">`;
	assert.equal(fragmentOnlySelfReferences(html, PAGE), '<path fill="url(#a)"><path fill="url(#b)">');
});

test('the query is part of the URL, in its raw and its attribute-serialized spelling', () => {
	const page = 'https://www.example.com/p?a=1&b=2';
	const html = `<path fill="url(https://www.example.com/p?a=1&amp;b=2#a)"><style>*{fill:url(https://www.example.com/p?a=1&b=2#b)}</style>`;
	assert.equal(fragmentOnlySelfReferences(html, page), '<path fill="url(#a)"><style>*{fill:url(#b)}</style>');
	// The same path under ANOTHER query is another document.
	const other = '<path fill="url(https://www.example.com/p?a=2#a)">';
	assert.equal(fragmentOnlySelfReferences(other, page), other);
});

test('references to other documents, to this one without a fragment, and every href are left alone', () => {
	const html = [
		'<path fill="url(https://cdn.example.net/sprite.svg#a)">',
		'<path fill="url(https://www.example.com/product/prd-1/some-slug.jsp-other#b)">',
		'<path fill="url(https://www.example.com/product/prd-12/some-slug.jsp#c)">',
		`<div style="background:url(${PAGE})">`,
		`<a href="${PAGE}#reviews">`,
		`<use href="${PAGE}#icon">`,
		`<p>${PAGE}#text</p>`,
		'<path fill="url(http://www.example.com/product/prd-1/some-slug.jsp#d)">',
	].join('');
	assert.equal(fragmentOnlySelfReferences(html, PAGE), html);
});

test('a hash on the page URL itself is not part of the document it names', () => {
	const html = `<path fill="url(${PAGE}#a)">`;
	assert.equal(fragmentOnlySelfReferences(html, `${PAGE}#reviews`), '<path fill="url(#a)">');
});

test('a page with no self-reference comes back as the same string, and bad input is returned untouched', () => {
	const html = '<html><body><a href="/x">x</a></body></html>';
	assert.equal(fragmentOnlySelfReferences(html, PAGE), html);
	assert.equal(fragmentOnlySelfReferences(html, 'not a url'), html);
	assert.equal(fragmentOnlySelfReferences('', PAGE), '');
});

// ── end to end: a script builds the reference from `location`, as the reviews widget does ─────────

let server: http.Server;
let base = '';

const FIXTURE = `<!doctype html><html><head><title>stars</title></head><body>
<svg width="0" height="0"><defs><linearGradient id="star_filled"><stop offset="1" stop-color="#fc0"/></linearGradient></defs></svg>
<svg id="stars" width="20" height="20"></svg>
<script>
document.getElementById('stars').innerHTML =
	'<path d="M0 0h20v20H0z" fill="url(' + location.href.split('#')[0] + '#star_filled)"></path>';
</script>
</body></html>`;

before(async () => {
	server = http.createServer((_req, res) => {
		res.setHeader('content-type', 'text/html; charset=utf-8');
		res.end(FIXTURE);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
	server?.close();
});

test('a rendered snapshot carries the fragment-only reference a script built from location', async () => {
	const result = await renderOnce({ url: `${base}/product/prd-1/slug.jsp`, config: { scroll: { enabled: false } } });
	assert.ok(result.html, 'the page rendered');
	assert.match(result.html!, /fill="url\(#star_filled\)"/);
	assert.doesNotMatch(result.html!, /url\(http/, 'no absolute self-reference survives');
});
