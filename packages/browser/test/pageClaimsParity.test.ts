import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import { extractPageClaims, PAGE_FACT_BOUNDS, STRUCTURED_OFFER_CAP } from '../dist/pageFacts.js';
import type { PageFactBounds, PageFactOffer, PageFacts, PageFactsProduct } from '../dist/pageFacts.js';

/**
 * PARITY GATE for the single in-page extraction (browser 1.38.0).
 *
 * Up to 1.37.0 the renderer read `structuredOffers` and `pageFacts` with two separate `page.evaluate`
 * calls, each querying and JSON-parsing every JSON-LD block itself. 1.38.0 reads both in ONE evaluate
 * (`extractPageClaims`) that parses each block once. The outputs must not move by a byte: the plugin's
 * change probe stores `structuredOffers` as the claim it compares against, so any drift would expire and
 * re-render pages whose content never changed.
 *
 * So this file keeps the two 1.37.0 extractors VERBATIM (bottom of the file — only renamed) and asserts,
 * for every fixture the two extractors' own suites use, a set of new edge cases, and a seeded fuzz
 * corpus, that the merged extractor returns deep-equal AND byte-identical (JSON) output to the old pair —
 * each side mapped exactly as its renderer maps it (`.catch(() => null)` per evaluate before; one
 * evaluate, `?? null` per field, after).
 *
 * If the extraction's semantics are ever changed ON PURPOSE, this gate has done its job: delete the file.
 */

type Claims = { structuredOffers: Array<string | null> | null; pageFacts: PageFacts | null };

let server: http.Server;
let base = '';
const pages = new Map<string, string>();
let browser: Browser;

before(async () => {
	server = http.createServer((req, res) => {
		const body = pages.get(req.url ?? '');
		res.writeHead(body === undefined ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' });
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

/** The 1.37.0 renderer: two evaluates, each failure its own null. */
const before137 = async (page: Page): Promise<Claims> => ({
	structuredOffers: await page.evaluate(legacyStructuredOffers, STRUCTURED_OFFER_CAP).catch(() => null),
	pageFacts: await page.evaluate(legacyPageFacts, PAGE_FACT_BOUNDS).catch(() => null),
});

/** The 1.38.0 renderer: one evaluate. */
const after138 = async (page: Page): Promise<Claims> => {
	const claims = await page.evaluate(extractPageClaims, STRUCTURED_OFFER_CAP, PAGE_FACT_BOUNDS).catch(() => null);
	return { structuredOffers: claims?.structuredOffers ?? null, pageFacts: claims?.pageFacts ?? null };
};

const assertParity = (old: Claims, merged: Claims, label: string) => {
	assert.deepEqual(merged, old, `${label}: merged output differs from the 1.37.0 pair`);
	assert.equal(JSON.stringify(merged), JSON.stringify(old), `${label}: wire bytes differ`);
};

let seq = 0;
/** Serve `html`, load it (its own scripts run), and compare both extractions against that one DOM. */
const compare = async (label: string, html: string): Promise<Claims> => {
	const path = `/parity-${++seq}`;
	pages.set(path, html);
	const page = await browser.newPage();
	try {
		await page.goto(`${base}${path}`, { waitUntil: 'load' });
		const old = await before137(page);
		const merged = await after138(page);
		assertParity(old, merged, label);
		return merged;
	} finally {
		await page.close();
	}
};

// JSON inside <script> — escape `<` so no fixture string can close the element early.
const ld = (value: unknown) =>
	`<script type="application/ld+json">${JSON.stringify(value).replace(/</g, '\\u003c')}</script>`;
const rawLd = (text: string) => `<script type="application/ld+json">${text}</script>`;
const doc = (head: string, body = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
/** The structuredOffers suite's page shell. */
const soPage = (head: string) =>
	`<!doctype html><html><head><title>p</title>
<link rel="canonical" href="https://www.example.com/p">
${head}</head><body><h1>product</h1></body></html>`;

const soffer = (i: number) => ({ price: `${i}.99`, priceCurrency: 'USD', availability: 'https://schema.org/InStock' });
const foffer = (i: number) => ({ sku: `S${i}`, price: i, priceCurrency: 'USD', availability: 'InStock' });
const variant = (sku: string, offers: unknown, extra: Record<string, unknown> = {}) => ({
	'@type': 'Product',
	sku,
	offers,
	...extra,
});
const crumbs = (length: number) =>
	ld({
		'@type': 'BreadcrumbList',
		'itemListElement': Array.from({ length }, (_, i) => ({ position: i + 1, name: `C${i + 1}` })),
	});

// ── the structuredOffers suite's fixtures ──────────────────────────────────────────────────────

const STRUCTURED_OFFERS_FIXTURES: Array<[string, string]> = [
	[
		'offers: two offers, number and string price',
		soPage(
			ld({
				'@type': 'Product',
				'name': 'Thing',
				'offers': [
					{ price: 35.99, priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
					{ price: '29.99', priceCurrency: 'USD', availability: 'OutOfStock' },
				],
			})
		),
	],
	[
		'offers: @graph with a single offer',
		soPage(
			ld({
				'@graph': [
					{ '@type': 'BreadcrumbList' },
					{
						'@type': ['Product'],
						'offers': { price: 10, priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
					},
				],
			})
		),
	],
	[
		'offers: malformed block then a valid one',
		soPage(
			`${rawLd('{ this is not json ')}\n${ld({ '@type': 'Product', 'offers': { price: 5, availability: 'InStock' } })}`
		),
	],
	[
		'offers: trailing slash on availability',
		soPage(
			ld({
				'@type': 'Product',
				'offers': { price: 7.5, priceCurrency: 'USD', availability: 'https://schema.org/InStock/' },
			})
		),
	],
	['offers: none (WebPage only)', soPage(ld({ '@type': 'WebPage' }))],
	[
		'offers: 250 products in one @graph (over the cap)',
		soPage(ld({ '@graph': Array.from({ length: 250 }, (_, i) => ({ '@type': 'Product', 'offers': soffer(i) })) })),
	],
	[
		'offers: a 100k-character price is sliced',
		soPage(
			ld({ '@type': 'Product', 'offers': { price: 'x'.repeat(100000), priceCurrency: 'USD', availability: 'InStock' } })
		),
	],
];

// ── the pageFacts suite's fixtures ─────────────────────────────────────────────────────────────

const over = (n: number, c = 'x') => c.repeat(n + 1);
const PAGE_FACTS_FIXTURES: Array<[string, string]> = [
	[
		'facts: head facts',
		doc(
			`<title>
				Blue Widget | Example Store   </title>
			<link rel="canonical" href="/p/blue-widget?color=blue">
			<link rel="canonical" href="https://www.example.com/second-canonical-is-ignored">
			<meta name="Description" content="  A widget, in blue.  ">
			<meta name="description" content="the first description wins">`,
			`<h1>
				Blue
				<span>Widget</span>&nbsp;<em>\t2000</em>
			</h1><h1>second h1 is ignored</h1>`
		),
	],
	['facts: empty document', doc('')],
	[
		'facts: empty values',
		doc('<title>   </title><meta name="description" content=""><link rel="canonical">', '<h1>  \n </h1>'),
	],
	[
		'facts: Product with brand object, image array, rating, per-SKU offers',
		doc(
			ld({
				'@context': 'https://schema.org',
				'@type': 'Product',
				'name': 'Blue Widget',
				'brand': { '@type': 'Brand', 'name': 'Example Brand' },
				'image': ['https://www.example.com/img/1.jpg', 'https://www.example.com/img/2.jpg'],
				'aggregateRating': { '@type': 'AggregateRating', 'ratingValue': 4.6, 'ratingCount': 212, 'reviewCount': 90 },
				'offers': [
					{ sku: 'SKU-B', price: 35.99, priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
					{ sku: 1234567, price: '29.99', priceCurrency: 'USD', availability: 'http://schema.org/OutOfStock/' },
					{ sku: 'SKU-A', price: 0, priceCurrency: 'USD', availability: 'PreOrder' },
				],
			})
		),
	],
	[
		'facts: ProductGroup inside @graph with an AggregateOffer',
		doc(
			ld({
				'@context': 'https://schema.org',
				'@graph': [
					{ '@type': 'WebPage', 'name': 'not the product' },
					{
						'@type': 'ProductGroup',
						'name': 'Widget Family',
						'brand': 'Example Brand',
						'image': { '@type': 'ImageObject', 'url': 'https://www.example.com/img/family.jpg' },
						'aggregateRating': { ratingValue: '4.2', reviewCount: '37' },
						'offers': {
							'@type': 'AggregateOffer',
							'lowPrice': 10,
							'highPrice': 20,
							'offers': [
								{ sku: 'S', price: 10, priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
								{ sku: 'L', price: 20, priceCurrency: 'USD', availability: 'https://schema.org/LimitedAvailability' },
							],
						},
					},
				],
			})
		),
	],
	[
		'facts: top-level array, @type array, first product wins',
		doc(
			ld([
				{ '@type': 'WebSite', 'name': 'Example Store' },
				{ '@type': ['Product', 'Thing'], 'name': 'First', 'image': 'https://www.example.com/first.jpg' },
			]) + ld({ '@type': 'Product', 'name': 'Second' })
		),
	],
	[
		'facts: malformed, null and string blocks beside valid ones',
		doc(
			rawLd('{ "@type": "Product", "name": broken ') +
				ld({ '@type': 'Product', 'name': 'Survivor', 'offers': { sku: 'X', price: 5, availability: 'InStock' } }) +
				rawLd('null') +
				rawLd('"just a string"') +
				ld({ '@type': 'BreadcrumbList', 'itemListElement': [{ position: 1, name: 'Home' }] })
		),
	],
	[
		'facts: a Product that states nothing else',
		doc(
			ld({
				'@type': 'Product',
				'brand': { '@type': 'Brand' },
				'image': [],
				'aggregateRating': { ratingValue: 'n/a', ratingCount: null },
				'offers': { '@type': 'AggregateOffer', 'lowPrice': 1, 'highPrice': 9 },
			})
		),
	],
	['facts: rating value only', doc(ld({ '@type': 'Product', 'aggregateRating': { ratingValue: 5 } }))],
	[
		'facts: rating null count falls back to reviewCount',
		doc(ld({ '@type': 'Product', 'aggregateRating': { ratingValue: '3.5', ratingCount: null, reviewCount: 8 } })),
	],
	['facts: rating zero', doc(ld({ '@type': 'Product', 'aggregateRating': { ratingValue: 0, ratingCount: 0 } }))],
	[
		'facts: odd offer field types',
		doc(
			ld({
				'@type': 'Product',
				'offers': [
					{ price: 12 },
					{ sku: { nested: true }, price: true, priceCurrency: 840, availability: 42 },
					'not an offer',
					null,
				],
			})
		),
	],
	[
		'facts: breadcrumb ordering',
		doc(
			ld({
				'@type': 'BreadcrumbList',
				'itemListElement': [
					{ '@type': 'ListItem', 'position': 3, 'item': { '@id': 'https://www.example.com/c/w', 'name': 'Widgets' } },
					{ '@type': 'ListItem', 'position': '1', 'name': 'Home', 'item': 'https://www.example.com/' },
					{ '@type': 'ListItem', 'name': 'Unpositioned' },
					{ '@type': 'ListItem', 'position': 2, 'name': 'Shop', 'item': { name: '' } },
					{ '@type': 'ListItem', 'position': 4 },
					{ '@type': 'ListItem', 'position': 5, 'name': 'Element name', 'item': { name: 'Item name' } },
				],
			}) + ld({ '@type': 'BreadcrumbList', 'itemListElement': [{ position: 1, name: 'second list is ignored' }] })
		),
	],
	[
		'facts: breadcrumbs with no named crumbs',
		doc(ld({ '@type': 'BreadcrumbList', 'itemListElement': [{ position: 1 }] })),
	],
	[
		'facts: strings past and at maxString',
		doc(
			`<title>${over(PAGE_FACT_BOUNDS.maxString, 'b')}</title><meta name="description" content="${over(PAGE_FACT_BOUNDS.maxString, 'b')}">
			<link rel="canonical" href="https://www.example.com/${over(PAGE_FACT_BOUNDS.maxString, 'b')}">` +
				ld({
					'@type': 'Product',
					'name': over(PAGE_FACT_BOUNDS.maxString, 'b'),
					'brand': 'a'.repeat(PAGE_FACT_BOUNDS.maxString),
					'image': over(PAGE_FACT_BOUNDS.maxString, 'b'),
				}),
			`<h1>${over(PAGE_FACT_BOUNDS.maxString, 'b')}</h1>`
		),
	],
	[
		'facts: exactly maxOffers offers',
		doc(ld({ '@type': 'Product', 'offers': Array.from({ length: PAGE_FACT_BOUNDS.maxOffers }, (_, i) => foffer(i)) })),
	],
	[
		'facts: maxOffers + 1 across an AggregateOffer',
		doc(
			ld({
				'@type': 'Product',
				'name': 'Kept',
				'offers': [
					foffer(-1),
					{
						'@type': 'AggregateOffer',
						'offers': Array.from({ length: PAGE_FACT_BOUNDS.maxOffers }, (_, i) => foffer(i)),
					},
				],
			})
		),
	],
	['facts: exactly maxBreadcrumbs', doc(crumbs(PAGE_FACT_BOUNDS.maxBreadcrumbs))],
	['facts: maxBreadcrumbs + 1', doc(crumbs(PAGE_FACT_BOUNDS.maxBreadcrumbs + 1))],
	[
		'facts: one overlong breadcrumb name',
		doc(
			ld({
				'@type': 'BreadcrumbList',
				'itemListElement': [
					{ position: 1, name: 'Home' },
					{ position: 2, name: over(PAGE_FACT_BOUNDS.maxString) },
				],
			})
		),
	],
	[
		'facts: offer fields past and at maxOfferField',
		doc(
			ld({
				'@type': 'Product',
				'offers': [
					{
						sku: over(PAGE_FACT_BOUNDS.maxOfferField),
						price: over(PAGE_FACT_BOUNDS.maxOfferField),
						priceCurrency: over(PAGE_FACT_BOUNDS.maxOfferField),
						availability: `https://schema.org/${over(PAGE_FACT_BOUNDS.maxOfferField)}`,
					},
					{
						sku: 'k'.repeat(PAGE_FACT_BOUNDS.maxOfferField),
						price: '1.00',
						priceCurrency: 'USD',
						availability: 'https://schema.org/InStock',
					},
				],
			})
		),
	],
	[
		'facts: one sku-less offer takes the product sku',
		doc(
			ld({
				'@type': 'Product',
				'sku': 9001,
				'offers': { price: 5, priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
			})
		),
	],
	[
		'facts: one aggregated offer with an empty sku',
		doc(
			ld({
				'@type': 'Product',
				'sku': 'P-1',
				'offers': { '@type': 'AggregateOffer', 'offers': [{ price: 5, priceCurrency: 'USD', sku: '' }] },
			})
		),
	],
	['facts: the offer sku wins', doc(ld({ '@type': 'Product', 'sku': 'P-1', 'offers': { sku: 'O-1', price: 5 } }))],
	[
		'facts: several offers never take the product sku',
		doc(ld({ '@type': 'Product', 'sku': 'P-1', 'offers': [{ price: 5 }, { sku: 'O-2', price: 6 }] })),
	],
	[
		'facts: a refused offer sku is not replaced',
		doc(ld({ '@type': 'Product', 'sku': 'P-1', 'offers': { sku: over(PAGE_FACT_BOUNDS.maxOfferField), price: 5 } })),
	],
	[
		'facts: an overlong inherited sku',
		doc(ld({ '@type': 'Product', 'sku': over(PAGE_FACT_BOUNDS.maxOfferField, 'y'), 'offers': { price: 5 } })),
	],
	[
		'facts: ProductGroup reads its hasVariant offers',
		doc(
			ld({
				'@type': 'ProductGroup',
				'name': 'Widget Family',
				'productGroupID': 'FAM-1',
				'hasVariant': [
					variant(
						'V-S',
						{ price: 10, priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
						{
							name: 'Widget, small',
							brand: { '@type': 'Brand', 'name': 'Variant Brand' },
							image: 'https://www.example.com/img/small.jpg',
							aggregateRating: { ratingValue: 4, ratingCount: 3 },
						}
					),
					variant('V-L', [
						{ price: 20, priceCurrency: 'USD', availability: 'https://schema.org/OutOfStock' },
						{ sku: 'V-L-REFURB', price: 15, priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
					]),
					'not a variant',
				],
			})
		),
	],
	[
		"facts: a ProductGroup's own offers and fields win",
		doc(
			ld({
				'@type': 'ProductGroup',
				'name': 'Group name',
				'brand': 'Group Brand',
				'image': 'https://www.example.com/img/group.jpg',
				'aggregateRating': { ratingValue: 5, reviewCount: 1 },
				'offers': { '@type': 'AggregateOffer', 'offers': [{ sku: 'G-1', price: 1 }] },
				'hasVariant': [variant('V-1', { price: 2 }, { name: 'Variant name', brand: 'Variant Brand' })],
			})
		),
	],
	[
		'facts: a ProductGroup value past its bound',
		doc(
			ld({
				'@type': 'ProductGroup',
				'name': over(PAGE_FACT_BOUNDS.maxString, 'n'),
				'hasVariant': [variant('V-1', { price: 2 }, { name: 'Variant name' })],
			})
		),
	],
	[
		'facts: variant offers over the cap together',
		doc(
			ld({
				'@type': 'ProductGroup',
				'hasVariant': [
					variant(
						'A',
						Array.from({ length: PAGE_FACT_BOUNDS.maxOffers }, (_, i) => ({ price: i }))
					),
					variant('B', [{ price: 0 }]),
				],
			})
		),
	],
	[
		'facts: a refused group never falls through',
		doc(
			ld({
				'@type': 'ProductGroup',
				'offers': Array.from({ length: PAGE_FACT_BOUNDS.maxOffers + 1 }, (_, i) => ({ price: i })),
				'hasVariant': [variant('A', { price: 1 })],
			})
		),
	],
	[
		'facts: mainEntity object',
		doc(
			ld({
				'@type': 'WebPage',
				'mainEntity': { '@type': 'Product', 'name': 'Nested', 'offers': { sku: 'N-1', price: 3 } },
			})
		),
	],
	[
		'facts: mainEntity array inside @graph',
		doc(
			ld({
				'@context': 'https://schema.org',
				'@graph': [
					{
						'@type': 'ItemPage',
						'mainEntity': [
							{ '@type': 'Organization', 'name': 'not it' },
							{ '@type': 'ProductGroup', 'name': 'Nested group' },
						],
					},
				],
			})
		),
	],
	[
		'facts: mainEntityOfPage',
		doc(ld({ '@type': 'WebPage', 'mainEntityOfPage': { '@type': 'Product', 'name': 'Of page' } })),
	],
	[
		'facts: nested breadcrumb',
		doc(
			ld({
				'@type': 'CollectionPage',
				'breadcrumb': {
					'@type': 'BreadcrumbList',
					'itemListElement': [
						{ position: 2, name: 'Widgets' },
						{ position: 1, name: 'Home' },
					],
				},
			})
		),
	],
	[
		'facts: top-level beats nested',
		doc(
			ld({
				'@type': 'WebPage',
				'mainEntity': { '@type': 'Product', 'name': 'Nested' },
				'breadcrumb': { '@type': 'BreadcrumbList', 'itemListElement': [{ position: 1, name: 'Nested crumb' }] },
			}) +
				ld({ '@type': 'Product', 'name': 'Top level' }) +
				ld({ '@type': 'BreadcrumbList', 'itemListElement': [{ position: 1, name: 'Top crumb' }] })
		),
	],
	[
		'facts: one level deep, only under page nodes',
		doc(
			ld({
				'@graph': [
					{
						'@type': 'WebPage',
						'mainEntity': { '@type': 'WebPage', 'mainEntity': { '@type': 'Product', 'name': 'Deep' } },
					},
					{
						'@type': 'Organization',
						'mainEntity': { '@type': 'Product', 'name': 'Under an organization' },
						'breadcrumb': { '@type': 'BreadcrumbList', 'itemListElement': [{ position: 1, name: 'no' }] },
					},
					{
						'@type': 'WebPage',
						'mainEntityOfPage': 'https://www.example.com/p',
						'breadcrumb': { itemListElement: [{ position: 1, name: 'untyped' }] },
					},
				],
			})
		),
	],
];

// ── new edge cases: where the two readers' walks DIVERGE, so the shared parse must serve both ──

const EDGE_FIXTURES: Array<[string, string]> = [
	[
		// pageFacts stops after block 0 (product + breadcrumbs found); structuredOffers must still read the
		// later blocks — parsed only for it.
		'edge: facts stop early, offers read on',
		doc(
			ld({
				'@graph': [
					{ '@type': 'Product', 'name': 'First', 'offers': { sku: 'A', price: 1, priceCurrency: 'USD' } },
					{ '@type': 'BreadcrumbList', 'itemListElement': [{ position: 1, name: 'Home' }] },
				],
			}) +
				rawLd('{ broken') +
				ld({ '@type': 'Product', 'name': 'Second', 'offers': [{ price: 2 }, { price: 3, availability: 'InStock' }] }) +
				ld([{ '@type': 'Product', 'offers': { price: '0.50', priceCurrency: 'EUR' } }])
		),
	],
	[
		// structuredOffers overflows in block 1; pageFacts still needs block 3 for its breadcrumbs.
		'edge: offers overflow early, facts read on',
		doc(
			ld({ '@type': 'Organization', 'name': 'Example' }) +
				ld({
					'@graph': Array.from({ length: STRUCTURED_OFFER_CAP + 1 }, (_, i) => ({
						'@type': 'Product',
						'offers': soffer(i),
					})),
				}) +
				ld({ '@type': 'WebSite' }) +
				ld({ '@type': 'BreadcrumbList', 'itemListElement': [{ position: 1, name: 'Late crumb' }] })
		),
	],
	[
		'edge: exactly the offer cap across two products',
		doc(
			ld({
				'@graph': [
					{ '@type': 'Product', 'offers': Array.from({ length: 150 }, (_, i) => soffer(i)) },
					{
						'@type': 'Product',
						'offers': Array.from({ length: STRUCTURED_OFFER_CAP - 150 }, (_, i) => soffer(i + 150)),
					},
				],
			})
		),
	],
	[
		'edge: one offer past the cap across two blocks',
		doc(
			ld({ '@type': 'Product', 'offers': Array.from({ length: STRUCTURED_OFFER_CAP }, (_, i) => soffer(i)) }) +
				ld({ '@type': 'Product', 'offers': soffer(999) })
		),
	],
	[
		// A ProductGroup is not a `Product` to structuredOffers (null), while pageFacts reads its variants.
		'edge: ProductGroup — offers see nothing, facts see the variants',
		doc(
			ld({
				'@type': 'ProductGroup',
				'name': 'Family',
				'hasVariant': [variant('V1', { price: 4, priceCurrency: 'USD', availability: 'https://schema.org/InStock' })],
			})
		),
	],
	[
		'edge: JSON primitives, empty and whitespace blocks',
		doc(
			rawLd('') +
				rawLd('   \n ') +
				rawLd('42') +
				rawLd('true') +
				rawLd('[]') +
				rawLd('[null, 1, "x", []]') +
				rawLd('{"@graph": {"@type": "Product", "offers": {"price": 1}}}') +
				ld({ '@type': 'Product', 'name': 'After the junk', 'offers': { price: 8 } })
		),
	],
	[
		'edge: over-long strings everywhere',
		doc(
			`<title>${'t'.repeat(5000)}</title>` +
				ld({
					'@type': 'Product',
					'name': 'n'.repeat(3000),
					'sku': 's'.repeat(65),
					'offers': [
						{
							price: 'p'.repeat(100000),
							priceCurrency: 'c'.repeat(70),
							availability: `https://schema.org/${'a'.repeat(80)}`,
						},
						{ price: 1, priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
					],
				}),
			`<h1>${'h '.repeat(1500)}</h1>`
		),
	],
	[
		'edge: sort order with nulls, duplicates and non-ASCII',
		doc(
			ld({
				'@type': 'Product',
				'offers': [
					{ price: 'Ü', priceCurrency: 'USD' },
					{ price: 'Z' },
					{ availability: 'InStock' },
					{ price: 'Z' },
					{ price: '10', priceCurrency: 'USD', availability: 'https://schema.org/OutOfStock' },
					{ price: '9', priceCurrency: 'usd', availability: '/' },
					{ price: 1e21, priceCurrency: '€', availability: 'https://schema.org/' },
					{ price: -0, priceCurrency: 'USD', availability: '' },
				],
				'aggregateRating': { ratingValue: -0, ratingCount: '  12  ' },
			})
		),
	],
	[
		'edge: many small blocks',
		doc(
			Array.from({ length: 60 }, (_, i) =>
				i % 7 === 3
					? rawLd('{ nope')
					: ld({ '@type': i % 5 ? 'Thing' : 'Product', 'name': `N${i}`, 'offers': { price: i } })
			).join('') + ld({ '@type': 'BreadcrumbList', 'itemListElement': [{ position: 1, name: 'Last' }] })
		),
	],
];

// ── pages that break one reader: each side must null exactly what it nulled before ─────────────

const hostile = (script: string) =>
	doc(
		`<title>Hostile</title><link rel="canonical" href="https://www.example.com/h">` +
			ld({ '@type': 'Product', 'name': 'H', 'offers': { sku: 'H1', price: 2, priceCurrency: 'USD' } }) +
			ld({ '@type': 'BreadcrumbList', 'itemListElement': [{ position: 1, name: 'Home' }] }),
		`<h1>Hostile</h1><script>${script}</script>`
	);
const HOSTILE_FIXTURES: Array<[string, string, (c: Claims) => void]> = [
	[
		'hostile: document.title throws — facts null, offers kept',
		hostile(`Object.defineProperty(document, 'title', { get() { throw new Error('hostile'); } });`),
		(c) => {
			assert.equal(c.pageFacts, null);
			assert.deepEqual(c.structuredOffers, ['2', 'USD', null]);
		},
	],
	[
		'hostile: document.querySelector throws — facts null, offers kept',
		hostile(`document.querySelector = () => { throw new Error('hostile'); };`),
		(c) => {
			assert.equal(c.pageFacts, null);
			assert.deepEqual(c.structuredOffers, ['2', 'USD', null]);
		},
	],
	[
		'hostile: Array.prototype.flat throws — offers null, facts kept',
		hostile(`Array.prototype.flat = function () { throw new Error('hostile'); };`),
		(c) => {
			assert.equal(c.structuredOffers, null);
			assert.equal(c.pageFacts?.product?.name, 'H');
			assert.deepEqual(c.pageFacts?.breadcrumbs, ['Home']);
		},
	],
	[
		'hostile: document.querySelectorAll throws — both null',
		hostile(`document.querySelectorAll = () => { throw new Error('hostile'); };`),
		(c) => assert.deepEqual(c, { structuredOffers: null, pageFacts: null }),
	],
	[
		'hostile: one block’s textContent throws — that block is skipped by both',
		hostile(
			`Object.defineProperty(document.querySelector('script[type="application/ld+json"]'), 'textContent', { get() { throw new Error('hostile'); } });`
		),
		(c) => {
			assert.equal(c.structuredOffers, null, 'the only Product block was unreadable');
			assert.equal(c.pageFacts?.product, null);
			assert.deepEqual(c.pageFacts?.breadcrumbs, ['Home']);
		},
	],
];

test('every structuredOffers-suite fixture: merged output is identical to the 1.37.0 pair', async () => {
	for (const [label, html] of STRUCTURED_OFFERS_FIXTURES) await compare(label, html);
});

test('every pageFacts-suite fixture: merged output is identical to the 1.37.0 pair', async () => {
	for (const [label, html] of PAGE_FACTS_FIXTURES) await compare(label, html);
});

test('edge cases where the two walks diverge: merged output is identical to the 1.37.0 pair', async () => {
	const results = new Map<string, Claims>();
	for (const [label, html] of EDGE_FIXTURES) results.set(label, await compare(label, html));
	// Not vacuous: the divergent walks really did produce both claims.
	const early = results.get('edge: facts stop early, offers read on')!;
	assert.equal(early.structuredOffers?.length, 4 * 3, 'offers from blocks past the one facts stopped at');
	assert.deepEqual(early.pageFacts?.breadcrumbs, ['Home']);
	const late = results.get('edge: offers overflow early, facts read on')!;
	assert.equal(late.structuredOffers, null);
	assert.deepEqual(late.pageFacts?.breadcrumbs, ['Late crumb']);
});

test('a page that breaks one reader: each claim is null exactly where the 1.37.0 pair made it null', async () => {
	for (const [label, html, check] of HOSTILE_FIXTURES) check(await compare(label, html));
});

// ── seeded fuzz ────────────────────────────────────────────────────────────────────────────────

/** mulberry32 — a fixed seed, so a failure reproduces. */
const prng = (seed: number) => () => {
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const fuzzDocuments = (count: number, seed: number): string[] => {
	const rand = prng(seed);
	const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
	const maybe = (p: number) => rand() < p;
	const STRINGS = [
		'Widget',
		'',
		'  padded  ',
		'Ünïcødé ✓',
		'x'.repeat(64),
		'x'.repeat(65),
		'y'.repeat(PAGE_FACT_BOUNDS.maxString),
		'z'.repeat(PAGE_FACT_BOUNDS.maxString + 1),
		'a/b/',
		'35.99',
		' 4.5 ',
		'n/a',
	];
	const SCALARS = [0, -0, 12.5, 1e21, -3, 1234567, true, false, null, {}, [], { name: 'obj' }];
	const TYPES = [
		'Product',
		'Product',
		'ProductGroup',
		'BreadcrumbList',
		'WebPage',
		'ItemPage',
		'CollectionPage',
		'Organization',
		'Offer',
		'AggregateOffer',
		'Thing',
		['Product', 'Thing'],
		['ProductGroup'],
		['WebPage', 'ItemPage'],
		undefined,
		42,
	];
	const AVAILABILITY = [
		'https://schema.org/InStock',
		'http://schema.org/OutOfStock/',
		'InStock',
		'PreOrder',
		'',
		'/',
		'https://schema.org/',
		42,
		null,
		'x'.repeat(70),
		`https://schema.org/${'x'.repeat(70)}`,
	];
	const value = () => (maybe(0.6) ? pick(STRINGS) : pick(SCALARS));
	const offer = (nested = false): unknown => {
		if (maybe(0.05)) return pick(['not an offer', null, 7]);
		const o: Record<string, unknown> = {};
		if (maybe(0.3)) o['@type'] = pick(['Offer', 'AggregateOffer']);
		if (maybe(0.85)) o.price = maybe(0.6) ? pick([9.99, 0, -0, '35.99', 1e21, 100, '1,299.00']) : value();
		if (maybe(0.7)) o.priceCurrency = maybe(0.8) ? pick(['USD', 'EUR', 'usd', '€']) : value();
		if (maybe(0.7)) o.availability = pick(AVAILABILITY);
		if (maybe(0.5)) o.sku = maybe(0.7) ? `SKU-${Math.floor(rand() * 50)}` : value();
		if (!nested && o['@type'] === 'AggregateOffer' && maybe(0.7)) o.offers = offers(true);
		return o;
	};
	const offerCount = () => pick([0, 1, 1, 1, 2, 2, 3, 5, 8, 199, 200, 201]);
	const offers = (nested = false): unknown => {
		const list = Array.from({ length: offerCount() }, () => offer(nested));
		switch (pick(['array', 'array', 'single', 'aggregate', 'mixed', 'absent'])) {
			case 'single':
				return list[0] ?? offer(nested);
			case 'aggregate':
				return { '@type': 'AggregateOffer', 'lowPrice': 1, 'highPrice': 9, 'offers': maybe(0.8) ? list : undefined };
			case 'mixed':
				return [offer(nested), { '@type': 'AggregateOffer', 'offers': list }, ...list.slice(0, 2)];
			case 'absent':
				return pick([undefined, null, '', 'string offers']);
			default:
				return list;
		}
	};
	const crumbList = (): unknown => {
		const n = pick([0, 1, 2, 3, 5, 30, 31]);
		return {
			'@type': maybe(0.9) ? 'BreadcrumbList' : undefined,
			'itemListElement': Array.from({ length: n }, (_, i) =>
				maybe(0.05)
					? 'junk'
					: {
							'@type': 'ListItem',
							'position': maybe(0.8) ? pick([i + 1, String(i + 1), n - i, 1, null, 'x']) : undefined,
							'name': maybe(0.8) ? pick([`C${i}`, '', 'Home', 'z'.repeat(PAGE_FACT_BOUNDS.maxString + 1)]) : undefined,
							'item': maybe(0.4) ? pick([{ name: `Item ${i}` }, { name: '' }, 'https://www.example.com/']) : undefined,
						}
			),
		};
	};
	const node = (depth: number): unknown => {
		if (maybe(0.04)) return pick([null, 'text', 3, []]);
		const type = pick(TYPES);
		const n: Record<string, unknown> = { '@type': type };
		if (maybe(0.7)) n.name = value();
		if (maybe(0.4)) n.brand = maybe(0.5) ? { '@type': 'Brand', 'name': value() } : value();
		if (maybe(0.4))
			n.image = pick([
				value(),
				[value(), 'second'],
				{ '@type': 'ImageObject', 'url': value() },
				[],
				[{ url: 'https://www.example.com/i.jpg' }],
			]);
		if (maybe(0.4))
			n.aggregateRating = { ratingValue: value(), ratingCount: maybe(0.5) ? value() : undefined, reviewCount: value() };
		if (maybe(0.5)) n.sku = maybe(0.6) ? `P-${Math.floor(rand() * 20)}` : value();
		if (maybe(0.7)) n.offers = offers();
		if (maybe(0.2) || type === 'ProductGroup')
			n.hasVariant = Array.from({ length: pick([0, 1, 2, 3]) }, () => node(depth + 1));
		if (type === 'BreadcrumbList' || maybe(0.1))
			n.itemListElement = (crumbList() as Record<string, unknown>).itemListElement;
		if (depth < 2 && maybe(0.25)) n.mainEntity = maybe(0.5) ? node(depth + 1) : [node(depth + 1), node(depth + 1)];
		if (depth < 2 && maybe(0.15)) n.mainEntityOfPage = maybe(0.6) ? node(depth + 1) : 'https://www.example.com/p';
		if (depth < 2 && maybe(0.2)) n.breadcrumb = crumbList();
		return n;
	};
	const block = (): string => {
		switch (pick(['node', 'node', 'node', 'array', 'graph', 'graph', 'malformed', 'primitive', 'graph-object'])) {
			case 'array':
				return ld(Array.from({ length: pick([0, 1, 2, 4]) }, () => node(0)));
			case 'graph':
				return ld({
					'@context': 'https://schema.org',
					'@graph': Array.from({ length: pick([1, 2, 3, 6]) }, () => node(0)),
				});
			case 'graph-object':
				return ld({ '@graph': node(0) });
			case 'malformed':
				return rawLd(pick(['{ "@type": "Product", ', '', '   ', '{nope}', '[1,']));
			case 'primitive':
				return rawLd(pick(['null', '"str"', '42', 'true', '[]']));
			default:
				return ld(node(0));
		}
	};
	const text = () =>
		pick(['Blue Widget', '', '  spaced   out  ', 'w'.repeat(PAGE_FACT_BOUNDS.maxString + 1), 'Ünïcødé']);
	return Array.from({ length: count }, () => {
		const head = [
			maybe(0.8) ? `<title>${text()}</title>` : '',
			maybe(0.6) ? `<meta name="${pick(['description', 'Description', 'DESCRIPTION'])}" content="${text()}">` : '',
			maybe(0.6)
				? `<link rel="canonical"${maybe(0.9) ? ` href="${pick(['/p/1', 'https://www.example.com/p?a=1', '', '?q=1'])}"` : ''}>`
				: '',
			...Array.from({ length: pick([0, 1, 1, 2, 3, 5]) }, block),
		].join('');
		const body = maybe(0.7) ? `<h1>${text()} <span>${text()}</span></h1>` : '';
		return `<head>${head}</head><body>${body}</body>`;
	});
};

test('seeded fuzz: 400 generated documents, merged output identical to the 1.37.0 pair on every one', async () => {
	const documents = fuzzDocuments(400, 0x5eed138);
	const page = await browser.newPage();
	const seen = { offers: 0, offersNull: 0, product: 0, productOffers: 0, breadcrumbs: 0, capRefusal: 0 };
	try {
		pages.set('/fuzz', doc(''));
		await page.goto(`${base}/fuzz`, { waitUntil: 'load' });
		for (let i = 0; i < documents.length; i++) {
			await page.evaluate((html) => {
				document.documentElement.innerHTML = html;
			}, documents[i]);
			const old = await before137(page);
			const merged = await after138(page);
			assertParity(old, merged, `fuzz #${i}`);
			if (merged.structuredOffers) seen.offers++;
			else seen.offersNull++;
			if (merged.pageFacts?.product) seen.product++;
			if (merged.pageFacts?.product?.offers) seen.productOffers++;
			if (merged.pageFacts?.breadcrumbs) seen.breadcrumbs++;
			if (documents[i].split('"price"').length > STRUCTURED_OFFER_CAP && !merged.structuredOffers) seen.capRefusal++;
		}
	} finally {
		await page.close();
	}
	// The corpus must actually exercise both readers, not compare a wall of nulls.
	for (const [what, n] of Object.entries(seen)) assert.ok(n >= 20, `fuzz coverage: only ${n} documents with ${what}`);
});

// ── the 1.37.0 extractors, VERBATIM (renamed only) ─────────────────────────────────────────────
// `extractStructuredOffers` from src/renderer.ts and `extractPageFacts` from src/pageFacts.ts at
// browser 1.37.0. Do not edit: they are the reference the merged extractor is held to.

function legacyStructuredOffers(cap: number): Array<string | null> | null {
	const triples: Array<Array<string | null>> = [];
	let overflowed = false;
	// Field-level byte bound: the cap bounds triple COUNT, so without this a single pathological
	// field (a megabyte "price" string) would still inflate every posted result for the page. No
	// legitimate price, currency code, or availability token approaches 64 characters.
	const bound = (value: string): string | null => (value === '' ? null : value.slice(0, 64));
	const collect = (node: unknown) => {
		if (overflowed || !node || typeof node !== 'object') return;
		const record = node as Record<string, unknown>;
		const type = record['@type'];
		const isProduct = type === 'Product' || (Array.isArray(type) && type.includes('Product'));
		if (!isProduct) return;
		const raw = record.offers;
		const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
		for (const entry of list) {
			if (!entry || typeof entry !== 'object') continue;
			if (triples.length >= cap) {
				overflowed = true;
				return;
			}
			const offer = entry as Record<string, unknown>;
			// filter(Boolean) before pop: a trailing slash (https://schema.org/InStock/) would
			// otherwise pop the empty segment and read as no availability at all.
			const availability =
				typeof offer.availability === 'string'
					? bound(offer.availability.split('/').filter(Boolean).pop() ?? '')
					: null;
			const price = offer.price === undefined || offer.price === null ? null : bound(String(offer.price));
			const currency = typeof offer.priceCurrency === 'string' ? bound(offer.priceCurrency) : null;
			triples.push([price, currency, availability]);
		}
	};
	document.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
		if (overflowed) return;
		let data: unknown;
		try {
			data = JSON.parse(el.textContent || '');
		} catch {
			return; // one malformed block must not cost the page its other blocks
		}
		const graph = (data as Record<string, unknown>)?.['@graph'];
		const nodes = Array.isArray(data) ? data : Array.isArray(graph) ? graph : [data];
		for (const node of nodes) {
			if (overflowed) break;
			collect(node);
		}
	});
	if (overflowed || !triples.length) return null;
	// Field-wise, not JSON.stringify per comparison: sorting is O(n log n) COMPARISONS, so
	// stringifying inside the comparator serialises every triple many times over. Code-unit
	// comparison, not localeCompare: the whole point of the sort is a sequence that is identical
	// across renders, and collation varies with the browser's locale/ICU.
	triples.sort((a, b) => {
		for (let i = 0; i < 3; i++) {
			const x = a[i];
			const y = b[i];
			if (x === y) continue;
			if (x === null) return -1;
			if (y === null) return 1;
			return x < y ? -1 : 1;
		}
		return 0;
	});
	return triples.flat();
}

function legacyPageFacts(bounds: PageFactBounds): PageFacts {
	type Json = Record<string, unknown>;
	const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
	const boundTo =
		(max: number) =>
		(value: unknown): string | null =>
			typeof value !== 'string' || value === '' || value.length > max ? null : value;
	const str = boundTo(bounds.maxString);
	const offerField = boundTo(bounds.maxOfferField);
	const hasType = (node: Json, wanted: string[]) => {
		const type = node['@type'];
		return Array.isArray(type) ? type.some((t) => wanted.includes(t as string)) : wanted.includes(type as string);
	};
	// A schema.org number may be written as a JSON number or a numeric string ("4.5"). Anything else —
	// including null, which Number() would silently read as 0 — is no claim.
	const num = (value: unknown): number | null => {
		if (typeof value === 'number') return Number.isFinite(value) ? value : null;
		if (typeof value !== 'string') return null;
		const trimmed = value.trim();
		if (!trimmed || trimmed.length > bounds.maxOfferField) return null;
		const n = Number(trimmed);
		return Number.isFinite(n) ? n : null;
	};
	const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : value ? [value] : []);

	const canonicalEl = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
	const descriptionEl = document.querySelector('meta[name="description" i]');
	const h1El = document.querySelector('h1');

	// schema.org WebPage and its subtypes: the nodes whose `mainEntity` / `breadcrumb` are searched.
	const PAGE_TYPES = [
		'WebPage',
		'ItemPage',
		'CollectionPage',
		'SearchResultsPage',
		'ProfilePage',
		'AboutPage',
		'ContactPage',
		'FAQPage',
		'QAPage',
		'CheckoutPage',
		'MedicalWebPage',
		'RealEstateListing',
		'MediaGallery',
		'ImageGallery',
		'VideoGallery',
	];
	const PRODUCT_TYPES = ['Product', 'ProductGroup'];

	// A node at the top of a block (or of its @graph) always wins; one found a single level down — a
	// page node's `mainEntity` / `mainEntityOfPage` / `breadcrumb` — is used only when no top-level node
	// matched. One level only: this reads what a page states about itself, it does not crawl a graph.
	let productNode: Json | null = null;
	let breadcrumbNode: Json | null = null;
	let nestedProduct: Json | null = null;
	let nestedBreadcrumb: Json | null = null;
	const blocks = document.querySelectorAll('script[type="application/ld+json"]');
	for (let i = 0; i < blocks.length && !(productNode && breadcrumbNode); i++) {
		let data: unknown;
		try {
			data = JSON.parse(blocks[i].textContent || '');
		} catch {
			continue; // one malformed block must not cost the page its other blocks
		}
		const graph = isObject(data) ? data['@graph'] : undefined;
		const nodes = Array.isArray(data) ? data : Array.isArray(graph) ? graph : [data];
		for (const node of nodes) {
			if (!isObject(node)) continue;
			if (!productNode && hasType(node, PRODUCT_TYPES)) productNode = node;
			if (!breadcrumbNode && hasType(node, ['BreadcrumbList'])) breadcrumbNode = node;
			if (!hasType(node, PAGE_TYPES)) continue;
			if (!nestedProduct) {
				for (const entity of listOf(node.mainEntity)) {
					if (isObject(entity) && hasType(entity, PRODUCT_TYPES)) {
						nestedProduct = entity;
						break;
					}
				}
			}
			const ofPage = node.mainEntityOfPage;
			if (!nestedProduct && isObject(ofPage) && hasType(ofPage, PRODUCT_TYPES)) nestedProduct = ofPage;
			const crumb = node.breadcrumb;
			if (!nestedBreadcrumb && isObject(crumb) && hasType(crumb, ['BreadcrumbList'])) nestedBreadcrumb = crumb;
		}
	}
	productNode = productNode ?? nestedProduct;
	breadcrumbNode = breadcrumbNode ?? nestedBreadcrumb;

	// A JSON number is stated as its string form ("35.99", "12345"), as structuredOffers states a price.
	const asString = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : value);
	const absent = (value: unknown) => value === undefined || value === null || value === '';
	const nonEmpty = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);

	// The offer objects a node states, in document order — an AggregateOffer summarises
	// (lowPrice/highPrice), so only the offers it lists are offers. null when past the bound.
	const offersOf = (raw: unknown): Json[] | null => {
		const found: Json[] = [];
		for (const entry of listOf(raw)) {
			const list = isObject(entry) && hasType(entry, ['AggregateOffer']) ? listOf(entry.offers) : [entry];
			for (const offer of list) {
				if (!isObject(offer)) continue;
				if (found.length >= bounds.maxOffers) return null;
				found.push(offer);
			}
		}
		return found;
	};
	const tuple = (offer: Json, sku: unknown): PageFactOffer => {
		// Reduced exactly as extractStructuredOffers reduces it: the last non-empty path segment, so a
		// trailing slash (https://schema.org/InStock/) still yields the verdict.
		const availability =
			typeof offer.availability === 'string' ? (offer.availability.split('/').filter(Boolean).pop() ?? '') : null;
		return [
			offerField(asString(sku)),
			offerField(asString(offer.price)),
			offerField(offer.priceCurrency),
			offerField(availability),
		];
	};

	const readOffers = (node: Json, variants: Json[]): PageFactOffer[] | null => {
		const own = offersOf(node.offers);
		if (own === null) return null; // refused — never fall through to the variants
		if (own.length) {
			// A product selling ONE offer often names the SKU on itself rather than on the offer. Only
			// then: with several offers, the product's SKU names none of them.
			const inherit = own.length === 1 && absent(own[0].sku);
			return own.map((offer) => tuple(offer, inherit ? node.sku : offer.sku));
		}
		// A ProductGroup usually sells through its variants (`hasVariant`, each a Product with its own
		// offers and SKU) — read those when the group itself states no offers.
		const out: PageFactOffer[] = [];
		for (const variant of variants) {
			const offers = offersOf(variant.offers);
			if (offers === null) return null;
			for (const offer of offers) {
				if (out.length >= bounds.maxOffers) return null;
				out.push(tuple(offer, absent(offer.sku) ? variant.sku : offer.sku));
			}
		}
		return out.length ? out : null;
	};

	// Each field is PICKED raw — from the node, else (for a ProductGroup) its first variant — and only
	// then bounded, so a value the group states too long is refused rather than swapped for a variant's.
	const pickBrand = (n: Json) => nonEmpty(isObject(n.brand) ? n.brand.name : n.brand);
	const pickImage = (n: Json) => {
		const image = Array.isArray(n.image) ? n.image[0] : n.image;
		return nonEmpty(isObject(image) ? image.url : image);
	};
	const pickRating = (n: Json): [number | null, number | null] | undefined => {
		const r = n.aggregateRating;
		if (!isObject(r)) return undefined;
		const pair: [number | null, number | null] = [num(r.ratingValue), num(r.ratingCount ?? r.reviewCount)];
		return pair[0] !== null || pair[1] !== null ? pair : undefined;
	};

	const readProduct = (node: Json): PageFactsProduct => {
		const variants = hasType(node, ['ProductGroup']) ? listOf(node.hasVariant).filter(isObject) : [];
		const pick = <T>(from: (n: Json) => T | undefined): T | undefined =>
			from(node) ?? (variants.length ? from(variants[0]) : undefined);
		return {
			name: str(pick((n) => nonEmpty(n.name))),
			brand: str(pick(pickBrand)),
			image: str(pick(pickImage)),
			rating: pick(pickRating) ?? null,
			offers: readOffers(node, variants),
		};
	};

	const readBreadcrumbs = (node: Json): string[] | null => {
		const crumbs: Array<{ name: string; position: number | null; order: number }> = [];
		const elements = listOf(node.itemListElement);
		for (let order = 0; order < elements.length; order++) {
			const el = elements[order];
			if (!isObject(el)) continue;
			const itemName = isObject(el.item) ? el.item.name : undefined;
			const raw = typeof itemName === 'string' && itemName !== '' ? itemName : el.name;
			if (typeof raw !== 'string' || raw === '') continue; // an unnamed crumb claims nothing
			// A name past the bound refuses the whole trail: a trail with a hole in it would disagree.
			if (raw.length > bounds.maxString) return null;
			if (crumbs.length >= bounds.maxBreadcrumbs) return null;
			crumbs.push({ name: raw, position: num(el.position), order });
		}
		// Ordered by position; a crumb without one keeps its document order after the positioned ones.
		crumbs.sort((a, b) =>
			a.position === b.position
				? a.order - b.order
				: a.position === null
					? 1
					: b.position === null
						? -1
						: a.position - b.position
		);
		return crumbs.length ? crumbs.map((c) => c.name) : null;
	};

	return {
		canonical: canonicalEl ? str(canonicalEl.href) : null,
		title: str((document.title || '').trim()),
		metaDescription: descriptionEl ? str(descriptionEl.getAttribute('content')) : null,
		h1: h1El ? str((h1El.textContent || '').replace(/\s+/g, ' ').trim()) : null,
		product: productNode ? readProduct(productNode) : null,
		breadcrumbs: breadcrumbNode ? readBreadcrumbs(breadcrumbNode) : null,
	};
}
