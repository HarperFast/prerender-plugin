import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import puppeteer, { type Browser } from 'puppeteer';
import { extractPageClaims, PAGE_FACT_BOUNDS, STRUCTURED_OFFER_CAP } from '../dist/pageFacts.js';
// The consumer's byte-level reader of the same contract. Plain JS, no build step.
import { documentFactsOf, DOCUMENT_FACT_BOUNDS } from '../../plugin/src/util/documentFacts.js';

/**
 * TWO READERS OF ONE CONTRACT. `extractPageClaims` reads the page facts off a settled DOM; the plugin's
 * `util/documentFacts.js` reads them off an origin document's bytes, without a DOM, so that a document
 * the plugin already has in hand (a proxied response, a stored raw document) can be compared with a
 * cached page's record. The two must agree EXACTLY or the byte reader must report null — a near miss
 * disagrees with the stored record on every comparison and re-renders that page forever.
 *
 * This test holds them to that, per field, on fixtures chosen where a byte scanner and an HTML parser
 * part ways. The browser parses with scripting ON (noscript is raw text, as in a render) while a CSP
 * stops every script, so nothing but the parser is under test. A fixture marked `exact` must also be
 * read in full — so the byte reader cannot pass by answering null to everything.
 */

const FIELDS = ['canonical', 'title', 'metaDescription', 'product', 'breadcrumbs'] as const;
const PAGE_PATH = '/p/widget-123?color=red';
const ld = (value: unknown) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
const doc = (head: string, body = '<h1>Widget</h1>') =>
	`<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const product = (extra: Record<string, unknown> = {}) => ({
	'@context': 'https://schema.org',
	'@type': 'Product',
	'name': 'Widget',
	'sku': 'W1',
	'offers': {
		'@type': 'Offer',
		'price': '9.99',
		'priceCurrency': 'USD',
		'availability': 'https://schema.org/InStock',
	},
	...extra,
});
const crumbs = {
	'@type': 'BreadcrumbList',
	'itemListElement': [
		{ '@type': 'ListItem', 'position': 2, 'name': 'Tools' },
		{ '@type': 'ListItem', 'position': 1, 'item': { '@id': '/', 'name': 'Home' } },
	],
};
const head =
	'<meta charset="utf-8"><title>Widget</title><link rel="canonical" href="https://shop.example.com/p/widget-123">' +
	'<meta name="description" content="A widget.">';

const FIXTURES: Array<{ name: string; html: string; exact?: boolean; contentType?: string }> = [
	{ name: 'all head facts', html: doc(head + ld(product()) + ld(crumbs)), exact: true },
	{
		name: 'case, attribute order, quoting',
		html: doc(
			'<META CHARSET=utf-8><TITLE>W</TITLE><LINK HREF=\'https://shop.example.com/x\' REL=CANONICAL><Meta Content="D" NAME=Description>'
		),
		exact: true,
	},
	{
		name: 'relative canonical + base',
		html: doc(
			'<meta charset="utf-8"><base href="https://cdn.example.com/b/"><link rel="canonical" href="../c?x=1#f"><title>T</title>'
		),
	},
	{
		name: 'relative canonical, base after it',
		html: doc('<meta charset="utf-8"><link rel="canonical" href="c"><base href="https://cdn.example.com/b/">'),
	},
	{ name: 'canonical without href', html: doc('<meta charset="utf-8"><link rel="canonical"><title>T</title>') },
	{
		name: 'canonical empty href',
		html: doc('<meta charset="utf-8"><link rel="canonical" href=""><title>T</title>'),
	},
	{
		name: 'rel token list is not a match',
		html: doc(
			'<meta charset="utf-8"><link rel="canonical alternate" href="https://a.example.com/"><link rel="canonical" href="https://b.example.com/">'
		),
		exact: true,
	},
	{
		name: 'comments hide tags',
		html: doc(
			'<meta charset="utf-8"><!-- <title>Fake</title> --><!--><!---><title>Real</title><meta name="description" content="d">'
		),
		exact: true,
	},
	{
		name: 'noscript and template hide tags',
		html: doc(
			'<meta charset="utf-8"><noscript><link rel="canonical" href="https://fake.example.com/"></noscript>' +
				`<template>${ld(product({ name: 'Fake' }))}</template><link rel="canonical" href="https://real.example.com/">` +
				ld(product())
		),
		exact: true,
	},
	{
		name: 'script and style contents are not markup',
		html: doc(
			'<meta charset="utf-8"><script>var s = "</head><title>x</title>"; if (a < b) {}</script>' +
				'<style>a::after{content:"<title>x</title>"}</style><title>Real</title>' +
				ld(product())
		),
		exact: true,
	},
	{
		name: 'character references',
		html: doc('<meta charset="utf-8"><title>Men&#39;s &amp; Women&#x27;s &quot;Tees&quot; &lt;3 AT&T</title>'),
		exact: true,
	},
	{ name: 'unknown named reference', html: doc('<meta charset="utf-8"><title>Caf&eacute;</title>') },
	{
		name: 'legacy reference without semicolon',
		html: doc('<meta charset="utf-8"><title>&copy 2024</title><meta name="description" content="a &amp b">'),
	},
	{ name: 'numeric reference without semicolon', html: doc('<meta charset="utf-8"><title>It&#39s</title>') },
	{
		name: 'whitespace and line endings',
		html: doc(
			'<meta charset="utf-8"><title>\n\t  Widget \r\n  Pro  </title><meta name="description" content="a\r\nb\rc">'
		),
		exact: true,
	},
	{
		name: 'UTF-8 text',
		html: doc(
			'<meta charset="utf-8"><title>Café — “Tables”</title><meta name="description" content="Größe ✓">' +
				ld(product({ name: 'Café' }))
		),
		exact: true,
	},
	{
		name: 'no charset, non-ASCII',
		html: '<!doctype html><html><head><title>Café</title><meta name="description" content="d"></head></html>',
	},
	{
		name: 'ld+json type: padded is not matched, case is',
		html: doc(
			`<meta charset="utf-8"><script type=" application/ld+json ">${JSON.stringify(product({ name: 'Padded' }))}</script>` +
				`<script type="APPLICATION/LD+JSON">${JSON.stringify(product({ name: 'Upper' }))}</script>`
		),
		exact: true,
	},
	{
		name: 'malformed block, @graph, top-level array',
		html: doc(
			'<meta charset="utf-8"><script type="application/ld+json">{bad</script>' +
				ld({ '@graph': [{ '@type': 'WebSite' }, crumbs] }) +
				ld([{ '@type': 'Organization' }, product({ name: 'InArray' })])
		),
		exact: true,
	},
	{
		name: 'ProductGroup variants',
		html: doc(
			'<meta charset="utf-8">' +
				ld({
					'@type': 'ProductGroup',
					'name': 'Shirt',
					'brand': { name: 'B' },
					'hasVariant': [
						{
							'@type': 'Product',
							'sku': 'S1',
							'image': ['https://img.example.com/1.jpg'],
							'offers': { price: 10, priceCurrency: 'USD', availability: 'https://schema.org/InStock/' },
						},
						{
							'@type': 'Product',
							'sku': 'S2',
							'offers': [{ price: '11.00', priceCurrency: 'USD', availability: 'OutOfStock' }],
						},
					],
				})
		),
		exact: true,
	},
	{
		name: 'AggregateOffer + rating',
		html: doc(
			'<meta charset="utf-8">' +
				ld(
					product({
						offers: {
							'@type': 'AggregateOffer',
							'lowPrice': 5,
							'offers': [
								{ price: 5, sku: 'a' },
								{ price: '6', sku: 'b' },
							],
						},
						aggregateRating: { ratingValue: '4.5', reviewCount: 12 },
					})
				)
		),
		exact: true,
	},
	{
		name: 'offers past the bound',
		html: doc(
			'<meta charset="utf-8">' +
				ld(product({ offers: Array.from({ length: 201 }, (_, i) => ({ price: i, sku: String(i) })) }))
		),
	},
	{
		name: 'nested mainEntity only',
		html: doc(
			'<meta charset="utf-8">' +
				ld({ '@type': 'ItemPage', 'mainEntity': product({ name: 'Nested' }), 'breadcrumb': crumbs })
		),
	},
	{
		name: 'nested in head, top-level in body',
		html: doc(
			'<meta charset="utf-8">' + ld({ '@type': 'WebPage', 'mainEntity': product({ name: 'Nested' }) }),
			ld(product({ name: 'BodyTop' }))
		),
	},
	{
		name: 'product only in the body',
		html: doc('<meta charset="utf-8"><title>T</title>', ld(product({ name: 'InBody' }))),
	},
	{
		name: 'SVG title in the body',
		html: '<!doctype html><html><head><meta charset="utf-8"></head><body><svg><title>Icon</title></svg></body></html>',
	},
	{
		name: 'no head tags at all',
		html:
			'<!doctype html><meta charset="utf-8"><title>Implied</title><link rel="canonical" href="https://shop.example.com/i"><p>x</p>' +
			ld(product()),
	},
	{
		name: 'duplicates: first wins',
		html: doc(
			'<meta charset="utf-8"><meta name="description" content="one" content="x"><meta name="description" content="two">' +
				'<link rel="canonical" href="https://a.example.com/" href="https://b.example.com/"><link rel="canonical" href="https://c.example.com/">'
		),
		exact: true,
	},
	{
		name: '> and < inside quoted values',
		html: doc(
			'<meta charset="utf-8"><meta name="description" content="a > b < c"><link rel="canonical" href="https://shop.example.com/a>b">'
		),
	},
	{
		name: 'over-long title',
		html: doc(
			`<meta charset="utf-8"><title>${'x'.repeat(2049)}</title><meta name="description" content="${'y'.repeat(2048)}">`
		),
	},
	{
		name: 'end tags with trailing space',
		html: doc(
			`<meta charset="utf-8"><title>Spaced</title ><script type="application/ld+json">${JSON.stringify(product())}</script >`
		),
		exact: true,
	},
	{ name: 'byte order mark', html: '﻿' + doc(head + ld(product())), exact: true },
	// ---- the adversarial review (2026-10-01): each of these once disagreed with Chrome ----
	{
		name: 'legacy references without semicolon',
		html: doc(
			'<meta charset="utf-8"><title>Caf&eacute Table M&uuml ller Espa&ntilde a</title><meta name="description" content="Caf&eacute x">'
		),
		exact: true,
	},
	{
		name: 'legacy longest match and numeric forms',
		html: doc('<meta charset="utf-8"><title>&notin it It&#39s &#128;&#x110000;&#0;</title>'),
		exact: true,
	},
	{
		name: 'attribute rule for legacy references',
		html: doc('<meta charset="utf-8"><title>T</title><meta name="description" content="a?x=1&copy=2&ampb &amp c">'),
		exact: true,
	},
	{ name: 'named reference outside the table', html: doc('<meta charset="utf-8"><title>I &hearts; it</title>') },
	{
		name: 'JSON-LD block undecodable before the charset',
		html: `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(product({ name: 'Café' }))}</script><meta charset="utf-8">${ld(product({ name: 'Other' }))}<title>T</title></head><body></body></html>`,
	},
	{
		name: 'JSON-LD block undecodable, no charset',
		html: `<!doctype html><html><head><title>T</title><script type="application/ld+json">${JSON.stringify(product({ name: 'Café' }))}</script>${ld(product({ name: 'Other' }))}</head><body></body></html>`,
	},
	{
		name: 'canonical, same-scheme relative',
		html: doc('<meta charset="utf-8"><link rel="canonical" href="https:/www.example.com/x"><title>T</title>'),
	},
	{
		name: 'canonical, NBSP before it',
		html: doc('<meta charset="utf-8"><link rel="canonical" href="&nbsp;https://a.example.com/x"><title>T</title>'),
	},
	{
		name: 'canonical, pipe in the path',
		html: doc(
			'<meta charset="utf-8"><title>T</title><link rel="canonical" href="https://shop.example.com/c/red|blue">'
		),
	},
	{
		name: 'canonical, normalized',
		html: doc(
			'<meta charset="utf-8"><title>T</title><link rel="canonical" href="HTTPS://Shop.Example.COM:443/a/../b/./c?x=1#y">'
		),
		exact: true,
	},
	{
		name: 'base after the head',
		html: `<!doctype html><html><head><meta charset="utf-8"><title>T</title><link rel="canonical" href="c"></head><base href="https://cdn.example.com/b/"><body></body></html>`,
	},
	{
		name: 'base data: url',
		html: doc('<meta charset="utf-8"><base href="data:text/html,x"><link rel="canonical" href="c"><title>T</title>'),
	},
	{
		name: 'comment closed by --!>',
		html: doc(
			'<meta charset="utf-8"><!-- x --!><title>A</title><!-- y --><title>B</title><link rel="canonical" href="https://a.example.com/">'
		),
		exact: true,
	},
	{
		name: 'end tag with a quoted > attribute',
		html: doc('<meta charset="utf-8"></x a=">"<title>Fake</title><title>Real</title>'),
	},
	{
		name: 'nested template',
		html: doc(
			'<meta charset="utf-8"><title>T</title><template><template></template><link rel="canonical" href="https://fake.example.com/"></template><link rel="canonical" href="https://real.example.com/">'
		),
		exact: true,
	},
	{
		name: 'template with a comment holding </template>',
		html: doc(
			'<meta charset="utf-8"><title>T</title><template><!-- </template> --><link rel="canonical" href="https://fake.example.com/"></template><link rel="canonical" href="https://real.example.com/">'
		),
		exact: true,
	},
	{
		name: 'script escaped state',
		html: doc(
			'<meta charset="utf-8"><title>T</title><script><!--<script>a</script><link rel="canonical" href="https://fake.example.com/"></script><link rel="canonical" href="https://real.example.com/">'
		),
		exact: true,
	},
	{
		name: 'JSON-LD in an escaped state, two blocks',
		html: doc(
			'<meta charset="utf-8"><title>T</title><script type="application/ld+json">{"@type":"Product","name":"A","description":"<!--<script></script>-->"}</script>' +
				ld(product({ name: 'B' }))
		),
		exact: true,
	},
	{
		name: 'rel via a character reference',
		html: doc(
			'<meta charset="utf-8"><title>T</title><link rel="&#99;anonical" href="https://a.example.com/"><link rel="canonical" href="https://b.example.com/">'
		),
		exact: true,
	},
	{
		name: 'meta name via a character reference',
		html: doc(
			'<meta charset="utf-8"><title>T</title><meta name="descr&#105;ption" content="A"><meta name="description" content="B">'
		),
		exact: true,
	},
	{
		name: 'script type via a character reference',
		html: doc(
			'<meta charset="utf-8"><title>T</title><script type="application/ld&#43;json">' +
				JSON.stringify(product({ name: 'A' })) +
				'</script>' +
				ld(product({ name: 'B' }))
		),
		exact: true,
	},
	{
		name: 'NUL in title and description',
		html: doc('<meta charset="utf-8"><title>a\u0000b</title><meta name="description" content="c\u0000d">'),
		exact: true,
	},
	{
		name: 'late meta charset after a non-head tag and 1 KB',
		html: `<!doctype html><html><head><template></template><!-- ${'x'.repeat(1200)} --><meta charset="utf-8"><title>Café</title></head><body></body></html>`,
	},
	{
		name: 'meta charset far in, head tags only',
		html: `<!doctype html><html><head><!-- ${'x'.repeat(1200)} --><meta charset="utf-8"><title>Café</title></head><body></body></html>`,
		exact: true,
	},
	{
		name: 'header charset outranks meta',
		contentType: 'text/html; charset=windows-1252',
		html: `<!doctype html><html><head><meta charset="utf-8"><title>Café T</title><meta name="description" content="plain"></head><body></body></html>`,
	},
	{
		name: 'utf-16 meta reads as utf-8',
		html: `<!doctype html><html><head><meta charset="utf-16"><title>Café</title></head><body></body></html>`,
		exact: true,
	},
	{ name: 'svg in the head', html: doc('<meta charset="utf-8"><svg><title>Icon</title></svg><title>Real</title>') },
	{
		name: 'foreign content and tables are past the head',
		html: doc(
			'<meta charset="utf-8"><title>T</title>',
			'<table><tr><td><link rel="canonical" href="https://a.example.com/"></td></tr><link rel="canonical" href="https://b.example.com/"></table>'
		),
	},
	{
		name: 'text ends the head',
		html: doc('<meta charset="utf-8">stray<title>T</title><link rel="canonical" href="https://a.example.com/">'),
	},
];

let server: http.Server;
let base = '';
const pages = new Map<string, string>();
const contentTypes = new Map<string, string>();
let browser: Browser;

before(async () => {
	server = http.createServer((req, res) => {
		const body = pages.get(req.url ?? '');
		res.writeHead(body === undefined ? 404 : 200, {
			'content-type': contentTypes.get(req.url ?? '') ?? 'text/html',
			'content-security-policy': "script-src 'none'",
		});
		res.end(body ?? 'not found');
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	browser = await puppeteer.launch({ headless: true });
});

after(async () => {
	await browser?.close();
	server?.close();
});

test('the byte reader and the renderer agree on the bounds', () => {
	assert.deepEqual({ ...DOCUMENT_FACT_BOUNDS }, { ...PAGE_FACT_BOUNDS });
});

let seq = 0;
for (const fixture of FIXTURES) {
	test(`parity: ${fixture.name}`, async () => {
		const path = `/fixture-${++seq}${PAGE_PATH}`;
		pages.set(path, fixture.html);
		if (fixture.contentType) contentTypes.set(path, fixture.contentType);
		const page = await browser.newPage();
		let dom;
		try {
			await page.goto(`${base}${path}`, { waitUntil: 'load' });
			dom = (await page.evaluate(extractPageClaims, STRUCTURED_OFFER_CAP, PAGE_FACT_BOUNDS)).pageFacts;
		} finally {
			await page.close();
		}
		const bytes = Buffer.from(fixture.html, 'utf8');
		{
			const ours = documentFactsOf(bytes, { contentType: fixture.contentType ?? 'text/html' }).facts;
			for (const field of FIELDS) {
				const expected = dom?.[field] ?? null;
				const actual = ours?.[field] ?? null;
				if (actual === null && !fixture.exact) continue; // no claim is always allowed
				assert.deepEqual(actual, expected, field);
			}
		}
	});
}
