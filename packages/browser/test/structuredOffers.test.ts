import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { renderOnce } from '../dist/renderOnce.js';

/**
 * The renderer reads the page's schema.org Product offers off the settled DOM and posts them with
 * the result, so the consumer does not have to regex-scan and JSON-parse a ~1MB document on its
 * hottest write path to recover values this process had structured in front of it.
 */

const page = (head: string) =>
	`<!doctype html><html><head><title>p</title>
<link rel="canonical" href="URL_HERE">
${head}</head><body><h1>product</h1></body></html>`;

const OFFERS = page(
	`<script type="application/ld+json">${JSON.stringify({
		'@type': 'Product',
		'name': 'Thing',
		'offers': [
			{ price: 35.99, priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
			{ price: '29.99', priceCurrency: 'USD', availability: 'OutOfStock' },
		],
	})}</script>`
);

const GRAPH = page(
	`<script type="application/ld+json">${JSON.stringify({
		'@graph': [
			{ '@type': 'BreadcrumbList' },
			{
				'@type': ['Product'],
				'offers': { price: 10, priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
			},
		],
	})}</script>`
);

const MALFORMED = page(
	`<script type="application/ld+json">{ this is not json </script>
<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', 'offers': { price: 5, availability: 'InStock' } })}</script>`
);

const TRAILING_SLASH = page(
	`<script type="application/ld+json">${JSON.stringify({
		'@type': 'Product',
		'offers': { price: 7.5, priceCurrency: 'USD', availability: 'https://schema.org/InStock/' },
	})}</script>`
);

const NONE = page(`<script type="application/ld+json">${JSON.stringify({ '@type': 'WebPage' })}</script>`);

const NO_SCROLL = { scroll: { enabled: false } } as const;

let server: http.Server;
let base = '';
let body = OFFERS;

before(async () => {
	server = http.createServer((_req, res) => {
		res.setHeader('content-type', 'text/html; charset=utf-8');
		res.end(body.replace('URL_HERE', `${base}/`));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
	server?.close();
});

test('offers are flattened to [price, currency, availability] triples and sorted', async () => {
	body = OFFERS;
	const { job } = await renderOnce({ url: `${base}/`, config: NO_SCROLL });
	// Sorted, so an unchanged page produces an identical sequence on every render.
	assert.deepEqual(job.structuredOffers, ['29.99', 'USD', 'OutOfStock', '35.99', 'USD', 'InStock']);
	// A schema.org availability URL is reduced to its last segment, matching the plugin's contract.
	assert.ok(!JSON.stringify(job.structuredOffers).includes('schema.org'));
});

test('@graph documents and a single (non-array) offer are both read', async () => {
	body = GRAPH;
	const { job } = await renderOnce({ url: `${base}/`, config: NO_SCROLL });
	assert.deepEqual(job.structuredOffers, ['10', 'USD', 'InStock']);
});

test('one malformed JSON-LD block does not cost the page its other blocks', async () => {
	body = MALFORMED;
	const { job } = await renderOnce({ url: `${base}/`, config: NO_SCROLL });
	assert.deepEqual(job.structuredOffers, ['5', null, 'InStock']);
});

test('a page declaring no Product offers reports null — present on the wire, distinct from absent', async () => {
	// The consumer reads an ABSENT field as "renderer predates the feature" and alarms on it, so
	// an offerless page must post null (extraction ran, nothing to claim), never omit the field.
	body = NONE;
	const { job } = await renderOnce({ url: `${base}/`, config: NO_SCROLL });
	assert.equal(job.structuredOffers, null);
	assert.notEqual(job.structuredOffers, undefined);
});

test('a trailing slash on the availability URL still yields the verdict, not an empty string', async () => {
	body = TRAILING_SLASH;
	const { job } = await renderOnce({ url: `${base}/`, config: NO_SCROLL });
	assert.deepEqual(job.structuredOffers, ['7.5', 'USD', 'InStock']);
});
