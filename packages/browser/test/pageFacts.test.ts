import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import puppeteer, { type Browser } from 'puppeteer';
import { extractPageFacts, PAGE_FACT_BOUNDS } from '../dist/pageFacts.js';
import { renderOnce } from '../dist/renderOnce.js';

/**
 * The renderer reports what the page ITSELF claims — canonical, title, meta description, first h1,
 * the first Product JSON-LD node and the first breadcrumb trail — so the consumer can compare those
 * claims against its own sources of truth without ever parsing HTML on its hot write path.
 *
 * Two rules every test below leans on:
 *   - bounds are REFUSALS: a value past its bound is null, never a truncated value that would disagree
 *     with the consumer's source forever and re-render the page on every comparison;
 *   - one malformed JSON-LD block must not cost the page its other blocks.
 */

const ld = (value: unknown) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
const doc = (head: string, body = '') => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const NULL_FACTS = { canonical: null, title: null, metaDescription: null, h1: null, product: null, breadcrumbs: null };

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

let seq = 0;
/** Serve `html`, load it, and run the extractor against the loaded DOM exactly as the renderer does. */
const factsOf = async (html: string) => {
	const path = `/fixture-${++seq}`;
	pages.set(path, html);
	const page = await browser.newPage();
	try {
		await page.goto(`${base}${path}`, { waitUntil: 'load' });
		return await page.evaluate(extractPageFacts, PAGE_FACT_BOUNDS);
	} finally {
		await page.close();
	}
};

test('head facts: canonical is resolved absolute, title trimmed, meta description verbatim, h1 collapsed', async () => {
	const facts = await factsOf(
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
		)
	);
	assert.equal(facts.canonical, `${base}/p/blue-widget?color=blue`, '.href — absolute, resolved against the document');
	assert.equal(facts.title, 'Blue Widget | Example Store');
	// Meta names are ASCII case-insensitive in HTML, so `Description` is the first one.
	assert.equal(facts.metaDescription, '  A widget, in blue.  ', 'the content attribute verbatim, untrimmed');
	assert.equal(facts.h1, 'Blue Widget 2000', 'runs of whitespace (incl. NBSP, tabs, newlines) collapse to one space');
	assert.equal(facts.product, null);
	assert.equal(facts.breadcrumbs, null);
});

test('a page that states nothing reports every fact as null — the object is still there', async () => {
	assert.deepEqual(await factsOf(doc('')), NULL_FACTS);
});

test('empty values are no claim: an empty title, description, h1 and canonical href are null', async () => {
	const facts = await factsOf(
		doc('<title>   </title><meta name="description" content=""><link rel="canonical">', '<h1>  \n </h1>')
	);
	assert.deepEqual(facts, NULL_FACTS);
});

test('Product: name, brand object, image array, rating and per-SKU offers in document order', async () => {
	const facts = await factsOf(
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
		)
	);
	assert.deepEqual(facts.product, {
		name: 'Blue Widget',
		brand: 'Example Brand',
		image: 'https://www.example.com/img/1.jpg',
		rating: [4.6, 212],
		// NOT sorted: the consumer keys by sku, and document order is the page's own statement.
		offers: [
			['SKU-B', '35.99', 'USD', 'InStock'],
			['1234567', '29.99', 'USD', 'OutOfStock'],
			['SKU-A', '0', 'USD', 'PreOrder'],
		],
	});
});

test('ProductGroup inside @graph: string brand, ImageObject url, reviewCount fallback, AggregateOffer offers', async () => {
	const facts = await factsOf(
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
		)
	);
	assert.deepEqual(facts.product, {
		name: 'Widget Family',
		brand: 'Example Brand',
		image: 'https://www.example.com/img/family.jpg',
		rating: [4.2, 37],
		offers: [
			['S', '10', 'USD', 'InStock'],
			['L', '20', 'USD', 'LimitedAvailability'],
		],
	});
});

test('a top-level JSON-LD array is searched; @type may be an array; the FIRST product on the page wins', async () => {
	const facts = await factsOf(
		doc(
			ld([
				{ '@type': 'WebSite', 'name': 'Example Store' },
				{ '@type': ['Product', 'Thing'], 'name': 'First', 'image': 'https://www.example.com/first.jpg' },
			]) + ld({ '@type': 'Product', 'name': 'Second' })
		)
	);
	assert.equal(facts.product?.name, 'First');
	assert.equal(facts.product?.image, 'https://www.example.com/first.jpg');
});

test('one malformed JSON-LD block does not cost the page its other blocks', async () => {
	const facts = await factsOf(
		doc(
			`<script type="application/ld+json">{ "@type": "Product", "name": broken </script>` +
				ld({ '@type': 'Product', 'name': 'Survivor', 'offers': { sku: 'X', price: 5, availability: 'InStock' } }) +
				`<script type="application/ld+json">null</script>` +
				`<script type="application/ld+json">"just a string"</script>` +
				ld({ '@type': 'BreadcrumbList', 'itemListElement': [{ position: 1, name: 'Home' }] })
		)
	);
	assert.equal(facts.product?.name, 'Survivor');
	assert.deepEqual(facts.product?.offers, [['X', '5', null, 'InStock']]);
	assert.deepEqual(facts.breadcrumbs, ['Home']);
});

test('a Product that states nothing else reports its fields as null', async () => {
	const facts = await factsOf(
		doc(
			ld({
				'@type': 'Product',
				'brand': { '@type': 'Brand' },
				'image': [],
				'aggregateRating': { ratingValue: 'n/a', ratingCount: null },
				'offers': { '@type': 'AggregateOffer', 'lowPrice': 1, 'highPrice': 9 },
			})
		)
	);
	// An AggregateOffer with no `offers` list states a range, not an offer; a rating with nothing
	// numeric in it is no rating.
	assert.deepEqual(facts.product, { name: null, brand: null, image: null, rating: null, offers: null });
});

test('rating: ratingCount wins over reviewCount, a lone ratingValue is kept, null is not read as 0', async () => {
	const withValueOnly = await factsOf(doc(ld({ '@type': 'Product', 'aggregateRating': { ratingValue: 5 } })));
	assert.deepEqual(withValueOnly.product?.rating, [5, null]);
	// Number(null) === 0 — a null count must stay null, not become a claimed zero reviews.
	const nullCount = await factsOf(
		doc(ld({ '@type': 'Product', 'aggregateRating': { ratingValue: '3.5', ratingCount: null, reviewCount: 8 } }))
	);
	assert.deepEqual(nullCount.product?.rating, [3.5, 8], 'ratingCount ?? reviewCount');
	const zero = await factsOf(doc(ld({ '@type': 'Product', 'aggregateRating': { ratingValue: 0, ratingCount: 0 } })));
	assert.deepEqual(zero.product?.rating, [0, 0], 'a stated zero is a claim');
});

test('offer fields are strings or null; a missing sku, price or currency is null', async () => {
	const facts = await factsOf(
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
		)
	);
	assert.deepEqual(facts.product?.offers, [
		[null, '12', null, null],
		[null, null, null, null],
	]);
});

test('breadcrumbs: ordered by position, item.name before the element name, unnamed crumbs skipped', async () => {
	const facts = await factsOf(
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
		)
	);
	assert.deepEqual(facts.breadcrumbs, ['Home', 'Shop', 'Widgets', 'Item name', 'Unpositioned']);
});

test('a BreadcrumbList with no named crumbs reports null, not an empty trail', async () => {
	const facts = await factsOf(doc(ld({ '@type': 'BreadcrumbList', 'itemListElement': [{ position: 1 }] })));
	assert.equal(facts.breadcrumbs, null);
});

// ── bounds: refusals, never truncations ─────────────────────────────────────────────────────────

test(`a string longer than ${PAGE_FACT_BOUNDS.maxString} characters is null; exactly at the bound it is kept`, async () => {
	const atBound = 'a'.repeat(PAGE_FACT_BOUNDS.maxString);
	const over = 'b'.repeat(PAGE_FACT_BOUNDS.maxString + 1);
	const facts = await factsOf(
		doc(
			`<title>${over}</title><meta name="description" content="${over}">
			<link rel="canonical" href="https://www.example.com/${over}">` +
				ld({ '@type': 'Product', 'name': over, 'brand': atBound, 'image': over }),
			`<h1>${over}</h1>`
		)
	);
	assert.deepEqual(facts, {
		...NULL_FACTS,
		product: { name: null, brand: atBound, image: null, rating: null, offers: null },
	});
});

test(`more than ${PAGE_FACT_BOUNDS.maxOffers} offers is offers: null — counted across an AggregateOffer too`, async () => {
	const offer = (i: number) => ({ sku: `S${i}`, price: i, priceCurrency: 'USD', availability: 'InStock' });
	const n = PAGE_FACT_BOUNDS.maxOffers;
	const atCap = await factsOf(doc(ld({ '@type': 'Product', 'offers': Array.from({ length: n }, (_, i) => offer(i)) })));
	assert.equal(atCap.product?.offers?.length, n, 'exactly at the cap is a complete claim');
	const over = await factsOf(
		doc(
			ld({
				'@type': 'Product',
				'name': 'Kept',
				'offers': [offer(-1), { '@type': 'AggregateOffer', 'offers': Array.from({ length: n }, (_, i) => offer(i)) }],
			})
		)
	);
	assert.equal(over.product?.offers, null, 'no claim — never the first 200');
	assert.equal(over.product?.name, 'Kept', 'the refusal costs only the offers');
});

test(`more than ${PAGE_FACT_BOUNDS.maxBreadcrumbs} breadcrumbs, or one overlong name, is breadcrumbs: null`, async () => {
	const crumbs = (length: number) =>
		ld({
			'@type': 'BreadcrumbList',
			'itemListElement': Array.from({ length }, (_, i) => ({ position: i + 1, name: `C${i + 1}` })),
		});
	const atCap = await factsOf(doc(crumbs(PAGE_FACT_BOUNDS.maxBreadcrumbs)));
	assert.equal(atCap.breadcrumbs?.length, PAGE_FACT_BOUNDS.maxBreadcrumbs);
	const over = await factsOf(doc(crumbs(PAGE_FACT_BOUNDS.maxBreadcrumbs + 1)));
	assert.equal(over.breadcrumbs, null);
	// A trail with a hole where the overlong crumb was would disagree with the source forever.
	const longName = await factsOf(
		doc(
			ld({
				'@type': 'BreadcrumbList',
				'itemListElement': [
					{ position: 1, name: 'Home' },
					{ position: 2, name: 'x'.repeat(PAGE_FACT_BOUNDS.maxString + 1) },
				],
			})
		)
	);
	assert.equal(longName.breadcrumbs, null);
});

test(`an offer field longer than ${PAGE_FACT_BOUNDS.maxOfferField} characters is null — the field, not the offer`, async () => {
	const atBound = 'k'.repeat(PAGE_FACT_BOUNDS.maxOfferField);
	const over = 'x'.repeat(PAGE_FACT_BOUNDS.maxOfferField + 1);
	const facts = await factsOf(
		doc(
			ld({
				'@type': 'Product',
				'offers': [
					{ sku: over, price: over, priceCurrency: over, availability: `https://schema.org/${over}` },
					{ sku: atBound, price: '1.00', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
				],
			})
		)
	);
	assert.deepEqual(facts.product?.offers, [
		[null, null, null, null],
		[atBound, '1.00', 'USD', 'InStock'],
	]);
});

// ── through the real renderer ──────────────────────────────────────────────────────────────────

const RENDERED = (url: string) =>
	doc(
		`<title>Blue Widget</title><link rel="canonical" href="${url}">
		<meta name="description" content="A widget.">` +
			ld({
				'@type': 'Product',
				'name': 'Blue Widget',
				'offers': { sku: 'W1', price: 9.5, priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
			}),
		'<h1>Blue Widget</h1>'
	);
const NO_SCROLL = { scroll: { enabled: false } } as const;

test('the default renderer sets job.pageFacts beside structuredOffers', async () => {
	pages.set('/rendered', RENDERED(`${base}/rendered`));
	const { job } = await renderOnce({ url: `${base}/rendered`, config: NO_SCROLL });
	assert.deepEqual(job.pageFacts, {
		canonical: `${base}/rendered`,
		title: 'Blue Widget',
		metaDescription: 'A widget.',
		h1: 'Blue Widget',
		product: { name: 'Blue Widget', brand: null, image: null, rating: null, offers: [['W1', '9.5', 'USD', 'InStock']] },
		breadcrumbs: null,
	});
	assert.deepEqual(job.structuredOffers, ['9.5', 'USD', 'InStock'], 'structuredOffers is unchanged');
});

test('an extraction that throws posts pageFacts: null — present, never a failed render, never the offers', async () => {
	// The page makes `document.title` throw. The render must still succeed, its offers must still be
	// read, and pageFacts must be null (ran, failed benignly) rather than absent ("renderer predates it").
	pages.set(
		'/hostile',
		RENDERED(`${base}/hostile`).replace(
			'</body>',
			`<script>Object.defineProperty(document, 'title', { get() { throw new Error('hostile page'); } });</script></body>`
		)
	);
	const result = await renderOnce({ url: `${base}/hostile`, config: NO_SCROLL });
	assert.equal(result.outcome, 'ok');
	assert.ok(result.html && result.html.length > 0);
	assert.equal(result.job.pageFacts, null);
	assert.notEqual(result.job.pageFacts, undefined);
	assert.deepEqual(result.job.structuredOffers, ['9.5', 'USD', 'InStock']);
});
