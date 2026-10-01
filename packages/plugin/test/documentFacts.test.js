import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
import {
	createDocumentFactsScanner,
	documentFactsOf,
	charsetOfContentType,
	DOCUMENT_FACT_BOUNDS,
} from '../src/util/documentFacts.js';

/**
 * `util/documentFacts.js` — the renderer's page facts, read off an origin document's bytes.
 *
 * ONE RULE GOVERNS EVERY ASSERTION BELOW: a fact is either EXACTLY what the renderer's
 * `extractPageClaims` reads from the same bytes in Chrome, or it is null. A near miss is the failure
 * that matters — it disagrees with the stored page record on every comparison and re-renders that page
 * forever — so the cases here are mostly about the places a byte scanner and a browser parse part
 * ways: tags hidden in comments, raw-text elements and templates; character references; charsets;
 * "first" when the scan stopped early. The expected values were checked against Chrome; the browser
 * package's documentFactsParity test keeps them checked.
 */

const URL0 = 'https://shop.example.com/p/widget-123?color=red';
const ld = (value) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
const doc = (head, body = '<h1>Widget</h1>') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const PRODUCT = {
	'@context': 'https://schema.org',
	'@type': 'Product',
	'name': 'Widget',
	'sku': 'W1',
	'brand': { '@type': 'Brand', 'name': 'Acme' },
	'image': 'https://img.example.com/w.jpg?wid=1000',
	'offers': { '@type': 'Offer', 'price': '9.99', 'priceCurrency': 'USD', 'availability': 'https://schema.org/InStock' },
};
const CRUMBS = {
	'@type': 'BreadcrumbList',
	'itemListElement': [
		{ '@type': 'ListItem', 'position': 2, 'name': 'Tools' },
		{ '@type': 'ListItem', 'position': 1, 'item': { '@id': '/', 'name': 'Home' } },
	],
};
const HEAD =
	'<meta charset="utf-8"><title>Widget</title><link rel="canonical" href="https://shop.example.com/p/widget-123">' +
	'<meta name="description" content="A widget.">';

const factsOf = (html, opts = {}) => documentFactsOf(Buffer.from(html, 'utf8'), { url: URL0, ...opts });

test('reads every head fact in the renderer contract, h1 excepted', () => {
	const r = factsOf(doc(HEAD + ld(PRODUCT) + ld(CRUMBS)));
	assert.equal(r.outcome, 'ok');
	assert.deepEqual(r.facts, {
		canonical: 'https://shop.example.com/p/widget-123',
		title: 'Widget',
		metaDescription: 'A widget.',
		h1: null,
		product: {
			name: 'Widget',
			brand: 'Acme',
			image: 'https://img.example.com/w.jpg?wid=1000',
			rating: null,
			offers: [['W1', '9.99', 'USD', 'InStock']],
		},
		breadcrumbs: ['Home', 'Tools'],
	});
});

test('the scan stops as soon as every head fact is in hand — the rest of the document is never read', () => {
	const html = doc(HEAD + ld(PRODUCT) + ld(CRUMBS) + '<script>' + 'x'.repeat(100_000) + '</script>');
	const r = factsOf(html);
	assert.equal(r.facts.title, 'Widget');
	assert.ok(r.scannedBytes < 2_000, `scanned ${r.scannedBytes} of ${html.length}`);
});

test('the scan is the head: it ends where the HTML parser ends the head, and a later fact is no claim', () => {
	const r = factsOf(doc('<meta charset="utf-8"><title>T</title>', ld(PRODUCT)));
	assert.equal(r.reachedHeadEnd, true);
	assert.equal(r.facts.product, null); // in the body
	// An implied head works the same way; the body start ends it.
	const implied = factsOf('<!doctype html><meta charset="utf-8"><title>Implied</title><body>' + ld(PRODUCT));
	assert.equal(implied.facts.title, 'Implied');
	assert.equal(implied.facts.product, null);
	// A start tag the head does not allow ends it, and so does non-whitespace text.
	assert.equal(factsOf(doc('<meta charset="utf-8"><div></div><title>After</title>')).facts, null);
	assert.equal(factsOf(doc('<meta charset="utf-8">text<title>After</title>')).facts, null);
	assert.equal(factsOf(doc('<meta charset="utf-8"><svg><title>Icon</title></svg>')).facts, null);
	// End tags that act as "anything else" end it too; any other stray end tag is ignored.
	assert.equal(factsOf(doc('<meta charset="utf-8"></br><title>After</title>')).facts, null);
	assert.equal(factsOf(doc('<meta charset="utf-8"></p><title>Kept</title>')).facts.title, 'Kept');
	// The renderer's one-level-down JSON-LD fallback applies only when NO block anywhere has a top-level
	// match, which reading only the head cannot know: never used.
	const nested = doc(
		'<meta charset="utf-8">' + ld({ '@type': 'ItemPage', 'mainEntity': { ...PRODUCT, name: 'Nested' } })
	);
	assert.equal(factsOf(nested).facts, null);
});

test('tags are matched as HTML matches them: any case, any attribute order, any quoting', () => {
	const r = factsOf(
		doc(
			"<META CHARSET=utf-8><TITLE>Widget</TITLE><LINK HREF='https://shop.example.com/x' REL=CANONICAL>" +
				'<Meta Content="Desc" NAME=Description><meta name=keywords content=a/b/>'
		)
	);
	assert.equal(r.facts.canonical, 'https://shop.example.com/x');
	assert.equal(r.facts.title, 'Widget');
	assert.equal(r.facts.metaDescription, 'Desc');
});

test('the first of each wins, as querySelector does; duplicate attributes keep their first value', () => {
	const r = factsOf(
		doc(
			'<meta charset="utf-8"><meta name="description" content="one" content="ignored"><meta name="description" content="two">' +
				'<link rel="canonical alternate" href="https://a.example.com/"><link rel="canonical" href="https://b.example.com/">' +
				'<link rel="canonical" href="https://c.example.com/">'
		)
	);
	assert.equal(r.facts.metaDescription, 'one');
	// `rel="canonical alternate"` is not `[rel="canonical"]`: the selector is an exact match, not a token list.
	assert.equal(r.facts.canonical, 'https://b.example.com/');
});

test('markup that is not markup is skipped: comments, raw text, scripts, templates', () => {
	const r = factsOf(
		doc(
			'<meta charset="utf-8"><!-- <title>Fake</title> --><!--><!---><!-- x --!>' +
				'<noscript><link rel="canonical" href="https://fake.example.com/"></noscript>' +
				'<template><template></template><link rel="canonical" href="https://fake.example.com/"></template>' +
				'<template><!-- </template> -->' +
				ld({ ...PRODUCT, name: 'Fake' }) +
				'</template>' +
				'<script>var s = "</head><title>x</title>"; if (a < b) {}</script>' +
				'<script><!--<script>a</script><title>Escaped</title></script>' +
				'<style>a::after{content:"<title>x</title>"}</style>' +
				'</x a=">"><title>Real</title><link rel="canonical" href="https://real.example.com/">' +
				ld(PRODUCT)
		)
	);
	assert.equal(r.facts.title, 'Real');
	assert.equal(r.facts.canonical, 'https://real.example.com/');
	assert.equal(r.facts.product.name, 'Widget');
});

test('character references decode exactly as the HTML tokenizer does, or the fact is refused', () => {
	const title = (t) =>
		factsOf(doc(`<meta charset="utf-8"><title>${t}</title><meta name="description" content="d">`)).facts.title;
	assert.equal(title('Men&#39;s &amp; Women&#x27;s &quot;Tees&quot; &lt;3'), 'Men\'s & Women\'s "Tees" <3');
	assert.equal(title('AT&T Phone & Case'), 'AT&T Phone & Case'); // a bare & is literal
	assert.equal(title('Caf&eacute; &mdash; Bar'), 'Café — Bar');
	// The 106 legacy names decode without `;` (longest match), and numeric ones do too.
	assert.equal(title('&copy 2024 Caf&eacute Table'), '© 2024 Café Table');
	assert.equal(title('&notin it It&#39s'), "¬in it It's"); // the longest legacy prefix: "not"
	assert.equal(title('&notit;'), null); // `;` after the run: the full table could hold "notit;"
	assert.equal(title('&#128;&#0;&#x110000;'), '€��'); // the windows-1252 remap, then U+FFFD
	// A named reference outside this decoder's set, with `;`, may be in the full table: refused.
	assert.equal(title('I &hearts; it'), null);
	// The attribute rule: a legacy name without `;` before `=` or an alphanumeric stays literal.
	const desc = (c) =>
		factsOf(doc(`<meta charset="utf-8"><title>T</title><meta name="description" content="${c}">`)).facts
			.metaDescription;
	assert.equal(desc('a?x=1&copy=2&ampb &amp c'), 'a?x=1&copy=2&ampb & c');
	// References inside the attributes that pick an element are decoded before comparing.
	const viaRef = factsOf(
		doc(
			'<meta charset="utf-8"><title>T</title><link rel="&#99;anonical" href="https://a.example.com/"><link rel="canonical" href="https://b.example.com/">'
		)
	);
	assert.equal(viaRef.facts.canonical, 'https://a.example.com/');
});

test('title whitespace is collapsed as document.title does it; CR/CRLF become LF everywhere', () => {
	const r = factsOf(
		doc('<meta charset="utf-8"><title>\n\t  Widget \r\n  Pro </title><meta name="description" content="a\r\nb\rc">')
	);
	assert.equal(r.facts.title, 'Widget Pro');
	assert.equal(r.facts.metaDescription, 'a\nb\nc');
});

test('text is decoded only when the charset makes it exact', () => {
	const utf8 = factsOf(doc('<meta charset="utf-8"><title>Café — “Tables”</title>'));
	assert.equal(utf8.facts.title, 'Café — “Tables”');
	// No charset anywhere: ASCII is the same in every ASCII-compatible encoding; anything else is refused.
	const plain = '<!doctype html><html><head><title>Plain</title><meta name="description" content="Café"></head></html>';
	const r = factsOf(plain);
	assert.equal(r.facts.title, 'Plain');
	assert.equal(r.facts.metaDescription, null);
	// The response header can supply it, and it outranks a meta; a byte-order mark outranks both.
	assert.equal(factsOf(plain, { contentType: 'text/html; charset=UTF-8' }).facts.metaDescription, 'Café');
	assert.equal(factsOf('﻿' + plain, { contentType: 'text/html; charset=windows-1252' }).facts.metaDescription, 'Café');
	// Another ASCII-compatible charset: ASCII text reads, non-ASCII does not.
	const latin = factsOf(
		'<html><head><meta charset="windows-1252"><title>T</title><meta name="description" content="Café"></head></html>'
	);
	assert.equal(latin.facts.title, 'T');
	assert.equal(latin.facts.metaDescription, null);
	// Not ASCII-compatible at all: nothing is read.
	assert.equal(factsOf(plain, { contentType: 'text/html; charset=utf-16' }).outcome, 'charset');
	// A JSON-LD block that cannot be decoded makes the later ones unknowable: never the next block instead.
	const poisoned = factsOf(
		'<!doctype html><html><head><title>T</title>' +
			ld({ ...PRODUCT, name: 'Café' }) +
			ld({ ...PRODUCT, name: 'Other' }) +
			'</head></html>'
	);
	assert.equal(poisoned.facts.product, null);
	// NUL is U+FFFD, as the tokenizer makes it.
	assert.equal(factsOf(doc('<meta charset="utf-8"><title>a\u0000b</title>')).facts.title, 'a�b');
	assert.equal(charsetOfContentType('text/html; charset="utf-8"'), 'utf-8');
	assert.equal(charsetOfContentType('text/html'), null);
});

test('the charset search ends where Chrome’s does: a meta past it is not adopted', () => {
	const pad = '<!-- ' + 'x'.repeat(1200) + ' -->';
	// A tag outside Chrome's head-tag set, then 1 KB: Chrome stops looking, so the title is not UTF-8 to it.
	const late = factsOf(
		`<!doctype html><html><head><template></template>${pad}<meta charset="utf-8"><title>Café</title></head></html>`
	);
	assert.equal(late.facts?.title ?? null, null);
	// Head tags only: Chrome keeps looking at any distance.
	const far = factsOf(`<!doctype html><html><head>${pad}<meta charset="utf-8"><title>Café</title></head></html>`);
	assert.equal(far.facts.title, 'Café');
});

test('canonical: reported only when its resolution cannot depend on the base URL, in characters both URL serializers agree on', () => {
	const c = (head) => factsOf(doc(`<meta charset="utf-8">${head}<title>T</title>`)).facts?.canonical ?? null;
	assert.equal(
		c('<link rel="canonical" href="HTTPS://Shop.Example.COM:443/a/../b?x=1#f">'),
		'https://shop.example.com/b?x=1#f'
	);
	// A `<base>` may sit anywhere in the document, even after the head: anything relative is unknowable.
	assert.equal(c('<base href="https://cdn.example.com/b/"><link rel="canonical" href="../c">'), null);
	assert.equal(c('<link rel="canonical" href="/p/1">'), null);
	assert.equal(c('<link rel="canonical" href="//shop.example.com/p">'), null);
	assert.equal(c('<link rel="canonical" href="https:/www.example.com/x">'), null); // same-scheme relative
	assert.equal(c('<link rel="canonical" href="">'), null);
	assert.equal(c('<link rel="canonical">'), null); // no href: the DOM's .href is ''
	// Characters Chrome and Node serialize differently, or that depend on the charset: refused.
	assert.equal(c('<link rel="canonical" href="https://shop.example.com/c/red|blue">'), null);
	assert.equal(c('<link rel="canonical" href="&nbsp;https://shop.example.com/x">'), null);
	assert.equal(c('<link rel="canonical" href="https://shop.example.com/100%-cotton">'), null);
});

test('JSON-LD: the selector is exact on type, a malformed block costs nothing else, graphs and arrays are read', () => {
	const r = factsOf(
		doc(
			'<meta charset="utf-8"><script type=" application/ld+json ">' +
				JSON.stringify({ ...PRODUCT, name: 'Padded' }) +
				'</script><script type="application/ld+json">{bad</script>' +
				ld({ '@graph': [{ '@type': 'WebSite' }, CRUMBS] }) +
				ld([{ '@type': 'Organization' }, { ...PRODUCT, name: 'InArray' }])
		)
	);
	assert.equal(r.facts.product.name, 'InArray');
	assert.deepEqual(r.facts.breadcrumbs, ['Home', 'Tools']);
	assert.equal(
		factsOf(doc(`<meta charset="utf-8"><script type="APPLICATION/LD+JSON">${JSON.stringify(PRODUCT)}</script>`)).facts
			.product.name,
		'Widget'
	);
});

test('JSON-LD reduction matches the renderer: ProductGroup variants, AggregateOffer, rating, bounds', () => {
	const group = factsOf(
		doc(
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
		)
	).facts.product;
	assert.deepEqual(group, {
		name: 'Shirt',
		brand: 'B',
		image: 'https://img.example.com/1.jpg',
		rating: null,
		offers: [
			['S1', '10', 'USD', 'InStock'],
			['S2', '11.00', 'USD', 'OutOfStock'],
		],
	});
	const agg = factsOf(
		doc(
			'<meta charset="utf-8">' +
				ld({
					...PRODUCT,
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
	).facts.product;
	assert.deepEqual(agg.offers, [
		['a', '5', null, null],
		['b', '6', null, null],
	]);
	assert.deepEqual(agg.rating, [4.5, 12]);
	const tooMany = Array.from({ length: DOCUMENT_FACT_BOUNDS.maxOffers + 1 }, (_, i) => ({ price: i, sku: String(i) }));
	assert.equal(factsOf(doc('<meta charset="utf-8">' + ld({ ...PRODUCT, offers: tooMany }))).facts.product.offers, null);
	assert.equal(
		factsOf(doc(`<meta charset="utf-8"><title>${'x'.repeat(DOCUMENT_FACT_BOUNDS.maxString + 1)}</title>`)).facts,
		null
	);
});

test('chunks may split anything: 1-byte, 3-byte and 8 KB pushes all read what one push reads', () => {
	const html = Buffer.from(doc(HEAD + '<!-- c --><script>var a="<b>";</script>' + ld(PRODUCT) + ld(CRUMBS)), 'utf8');
	const whole = documentFactsOf(html, { url: URL0 }).facts;
	for (const size of [1, 3, 7, 8192]) {
		const s = createDocumentFactsScanner({ url: URL0 });
		for (let i = 0; i < html.length && s.push(html.subarray(i, i + size)); i += size);
		assert.deepEqual(s.finish().facts, whole, `chunk size ${size}`);
	}
});

test('compressed bodies: gzip, deflate and br read the same facts, inflating only a prefix', () => {
	// An incompressible body, so the head is a small fraction of the compressed bytes too.
	const filler = randomBytes(96 * 1024).toString('base64');
	const html = Buffer.from(doc(HEAD + ld(PRODUCT) + ld(CRUMBS), `<p>${filler}</p>`), 'utf8');
	const identity = documentFactsOf(html, { url: URL0 }).facts;
	const gz = zlib.gzipSync(html);
	const r = documentFactsOf(gz, { url: URL0, contentEncoding: 'gzip', firstInflateBytes: 1024 });
	assert.deepEqual(r.facts, identity);
	assert.ok(r.compressedBytesRead < gz.length, `read ${r.compressedBytesRead} of ${gz.length}`);
	assert.deepEqual(documentFactsOf(zlib.deflateSync(html), { url: URL0, contentEncoding: 'deflate' }).facts, identity);
	assert.deepEqual(
		documentFactsOf(zlib.brotliCompressSync(html), { url: URL0, contentEncoding: 'br' }).facts,
		identity
	);
	assert.deepEqual(documentFactsOf(html, { url: URL0, contentEncoding: 'identity' }).facts, identity);
	assert.equal(documentFactsOf(gz, { contentEncoding: 'zstd' }).outcome, 'encoding');
	assert.equal(documentFactsOf(Buffer.from('not gzip at all'), { contentEncoding: 'gzip' }).outcome, 'corrupt');
});

test('a document with no end in sight is truncated at maxBytes, not read forever', () => {
	const s = createDocumentFactsScanner({ maxBytes: 64 * 1024 });
	const chunk = Buffer.from('<meta charset="utf-8"><script>' + 'x'.repeat(16 * 1024));
	let pushes = 0;
	while (s.push(chunk)) pushes++;
	assert.equal(s.finish().outcome, 'truncated');
	assert.ok(pushes <= 4);
});

test('want: the scan stops once the wanted facts are in hand, and reports nothing else', () => {
	// A head carrying title/canonical/description up front, then a huge inline stylesheet and no JSON-LD
	// at all — the shape where looking for a Product means inflating the whole head for nothing.
	const css = `<style>${randomBytes(300 * 1024).toString('base64')}</style>`;
	const html = Buffer.from(doc(HEAD + css), 'utf8');
	const gz = zlib.gzipSync(html);
	const all = documentFactsOf(gz, { url: URL0, contentEncoding: 'gzip' });
	const some = documentFactsOf(gz, {
		url: URL0,
		contentEncoding: 'gzip',
		want: ['title', 'canonical', 'metaDescription'],
	});
	assert.equal(some.facts.title, 'Widget');
	assert.equal(some.facts.canonical, 'https://shop.example.com/p/widget-123');
	assert.equal(some.facts.metaDescription, 'A widget.');
	assert.ok(some.compressedBytesRead < 16 * 1024, `read ${some.compressedBytesRead}`);
	assert.ok(all.compressedBytesRead > 200 * 1024, `read ${all.compressedBytesRead}`);
	assert.deepEqual({ ...all.facts }, { ...some.facts });
	// An unwanted fact is null even when the scan passed it — the result depends only on `want`.
	const titleOnly = factsOf(doc(HEAD + ld(PRODUCT) + ld(CRUMBS)), { want: ['title'] }).facts;
	assert.deepEqual(titleOnly, {
		canonical: null,
		title: 'Widget',
		metaDescription: null,
		h1: null,
		product: null,
		breadcrumbs: null,
	});
	const productOnly = factsOf(doc(HEAD + ld(PRODUCT) + ld(CRUMBS)), { want: ['product'] }).facts;
	assert.equal(productOnly.product.name, 'Widget');
	assert.equal(productOnly.breadcrumbs, null);
	assert.throws(() => factsOf(doc(HEAD), { want: ['h1'] }), /unknown fact "h1"/);
	assert.throws(() => factsOf(doc(HEAD), { want: [] }), /non-empty/);
});

test('itemList (opt-in, outside the renderer contract): a listing page’s products in position order', () => {
	const listing = {
		'@type': 'CollectionPage',
		'name': 'Tools',
		'mainEntity': {
			'@type': 'ItemList',
			'itemListElement': [
				{
					'@type': 'ListItem',
					'position': 2,
					'item': {
						'@type': 'Product',
						'url': 'https://shop.example.com/p/b',
						'offers': { price: '5.00', priceCurrency: 'USD', availability: 'https://schema.org/OutOfStock' },
					},
				},
				{
					'@type': 'ListItem',
					'position': 1,
					'item': {
						'@type': 'Product',
						'url': 'https://shop.example.com/p/a',
						'offers': { price: '51.00 - 68.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
					},
				},
				{
					'@type': 'ListItem',
					'position': 3,
					'item': { '@type': 'Product', 'url': 'https://shop.example.com/p/c', 'offers': [{ price: 1 }, { price: 2 }] },
				},
			],
		},
	};
	const html = doc(HEAD + ld(listing));
	const r = factsOf(html, { want: ['title', 'itemList'] });
	assert.deepEqual(r.facts.itemList, [
		['https://shop.example.com/p/a', '51.00 - 68.00', 'USD', 'InStock'],
		['https://shop.example.com/p/b', '5.00', 'USD', 'OutOfStock'],
		['https://shop.example.com/p/c', null, null, null], // two offers: no single price to claim
	]);
	// Not asked for: the key is absent, so a default result keeps exactly the renderer contract's shape.
	assert.equal('itemList' in factsOf(html).facts, false);
	// A top-level ItemList reads the same way; too many entries refuses the list.
	assert.equal(factsOf(doc(HEAD + ld(listing.mainEntity)), { want: ['itemList'] }).facts.itemList.length, 3);
	const huge = {
		'@type': 'ItemList',
		'itemListElement': Array.from({ length: DOCUMENT_FACT_BOUNDS.maxOffers + 1 }, (_, i) => ({
			position: i,
			url: `https://shop.example.com/p/${i}`,
		})),
	};
	assert.equal(factsOf(doc(HEAD + ld(huge)), { want: ['title', 'itemList'] }).facts.itemList, null);
});

test('bounds: maxBytes caps one oversized push and an inflate that would exceed it (a decompression bomb)', () => {
	const head = '<!doctype html><html><head><meta charset="utf-8"><script>' + 'x'.repeat(200_000);
	const one = documentFactsOf(Buffer.from(head), { maxBytes: 64 * 1024 });
	assert.equal(one.outcome, 'truncated');
	assert.ok(one.scannedBytes <= 64 * 1024);
	const bomb = zlib.gzipSync(Buffer.alloc(50 * 1024 * 1024, 0x20));
	const r = documentFactsOf(bomb, { contentEncoding: 'gzip', maxBytes: 1024 * 1024 });
	assert.equal(r.outcome, 'truncated');
	assert.ok(r.inflatedBytes <= 1024 * 1024, `inflated ${r.inflatedBytes}`);
});
