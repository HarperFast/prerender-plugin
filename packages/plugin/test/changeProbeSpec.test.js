import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The change probe's pure half: rule compilation, URL templating, extraction, signatures.
 *
 * The properties pinned here are the ones that keep a probe from ever doing damage on bad input:
 * an invalid rule drops INDIVIDUALLY (one typo must not break the list), captures are
 * URI-encoded into templates (an unencoded `/` changes which resource is probed), and — the big
 * one — an extraction where every path yields null is a FAILED observation, never a signature.
 * Without the all-null rule, an endpoint changing shape (the replatform failure this feature
 * exists to survive) would flip every signature at once and mass-trigger re-renders of pages
 * that did not change.
 */
import {
	compileProbeRules,
	inspectProbeRules,
	ruleForUrl,
	substituteTemplate,
	valueAtPath,
	extractValues,
	signatureOf,
	extractJsonLdOffers,
	buildProbeRequest,
	isSameProbeOrigin,
	statusSignalFor,
	pageClaimFromOffers,
	apiClaimOf,
	claimsDisagree,
} from '../src/util/changeProbeSpec.js';

const REQUEST_RULE = {
	pathPattern: '^/product/prd-([^/]+)',
	source: 'request',
	request: {
		urlTemplate: 'https://api.example.com/price/$1?store=1',
		method: 'POST',
		headers: { Accept: 'application/json' },
		body: '{}',
	},
	extract: ['payload.products[0].price', 'payload.products[0].inStock'],
};

test('compiles a request rule and lowercases header names', () => {
	const [rule] = compileProbeRules([REQUEST_RULE]);
	assert.ok(rule);
	assert.equal(rule.source, 'request');
	assert.equal(rule.request.method, 'POST');
	assert.deepEqual(rule.request.headers, { accept: 'application/json' });
	assert.deepEqual(rule.extract, ['payload.products[0].price', 'payload.products[0].inStock']);
});

test('document mode is the default and needs nothing but a pattern', () => {
	const [rule] = compileProbeRules([{ pathPattern: '^/product/' }]);
	assert.equal(rule.source, 'document');
	assert.equal(rule.request.method, 'GET');
	assert.equal(rule.extract, null);
});

test('one invalid rule drops alone, with a warning naming it', () => {
	const warnings = [];
	const rules = compileProbeRules(
		[
			{ pathPattern: '(' }, // does not compile
			{ pathPattern: '^/a/', source: 'nope' }, // bad source
			{ pathPattern: '^/b/', source: 'request' }, // no urlTemplate
			{ pathPattern: '^/c/', source: 'request', request: { urlTemplate: 'https://x/$1' } }, // no extract
			{
				pathPattern: '^/d/',
				source: 'request',
				request: { urlTemplate: 'https://x/$1', method: 'PUT' },
				extract: ['a'],
			},
			// HEAD is refused at compile: extraction parses the body and a HEAD probe has none,
			// so it would validate and then fail on every probe.
			{
				pathPattern: '^/f/',
				source: 'request',
				request: { urlTemplate: 'https://x/$1', method: 'HEAD' },
				extract: ['a'],
			},
			{ pathPattern: '^/e/', request: { headers: { a: 1 } } }, // non-string header
			{ ...REQUEST_RULE, label: 'good' }, // survives
		],
		warnings
	);
	assert.equal(rules.length, 1);
	assert.equal(rules[0].label, 'good');
	assert.equal(warnings.length, 7);
	assert.match(warnings[0], /rule\[0\]/);
});

test('inspectProbeRules reports declared vs usable', () => {
	const report = inspectProbeRules([{ pathPattern: '(' }, REQUEST_RULE]);
	assert.equal(report.total, 2);
	assert.equal(report.usable, 1);
	assert.equal(report.dropped, 1);
	assert.equal(report.warnings.length, 1);
});

test('first matching rule wins, matched on the path only', () => {
	const rules = compileProbeRules([
		{ ...REQUEST_RULE, pathPattern: '^/product/prd-special-', label: 'special' },
		{ ...REQUEST_RULE, label: 'general' },
	]);
	assert.equal(ruleForUrl(rules, 'https://example.com/product/prd-special-1/x').rule.label, 'special');
	assert.equal(ruleForUrl(rules, 'https://example.com/product/prd-7/x?q=1').rule.label, 'general');
	assert.equal(ruleForUrl(rules, 'https://example.com/catalog/'), null);
	assert.equal(ruleForUrl(rules, 'not a url'), null);
});

test('template substitution URI-encodes captures and blanks unmatched groups', () => {
	const match = '/p/a b/x'.match(/^\/p\/([^/]+)(?:\/(zzz))?/);
	assert.equal(substituteTemplate('https://x/$1/$2', match), 'https://x/a%20b/');
});

test('valueAtPath walks dots and numeric brackets, and never throws', () => {
	const doc = { payload: { products: [{ prices: [{ sale: 9.5 }], flags: { ship: true } }] } };
	assert.equal(valueAtPath(doc, 'payload.products[0].prices[0].sale'), 9.5);
	assert.equal(valueAtPath(doc, 'payload.products[0].flags.ship'), true);
	assert.equal(valueAtPath(doc, 'payload.products[1].prices[0].sale'), undefined);
	assert.equal(valueAtPath(doc, 'nope.nope'), undefined);
	assert.equal(valueAtPath(null, 'a'), undefined);
});

test('signatureOf: all-null extraction is a FAILED observation, not a signature', () => {
	assert.equal(signatureOf([null, null]), null);
	assert.equal(signatureOf([]), null);
	assert.equal(signatureOf(null), null);
	// One real value is enough, and null holes stay positional so a field APPEARING is a change.
	assert.equal(signatureOf([45, null]), '[45,null]');
	assert.equal(signatureOf([45, null]), signatureOf([45, undefined]));
});

test('extractValues is positional with null for missing', () => {
	const values = extractValues({ a: { b: 1 } }, ['a.b', 'a.c']);
	assert.deepEqual(values, [1, null]);
	assert.equal(signatureOf(values), '[1,null]');
});

const page = (offers) =>
	`<html><head><script type="application/ld+json">${JSON.stringify({
		'@context': 'https://schema.org',
		'@type': 'Product',
		'name': 'X',
		offers,
	})}</script></head><body></body></html>`;

test('JSON-LD offers: price, currency, and the availability tail', () => {
	const values = extractJsonLdOffers(
		page({ '@type': 'Offer', 'price': '45', 'priceCurrency': 'USD', 'availability': 'https://schema.org/InStock' })
	);
	assert.deepEqual(values, ['45', 'USD', 'InStock']);
});

test('JSON-LD offers: offer arrays sign identically whatever order the origin serializes', () => {
	const a = extractJsonLdOffers(
		page([
			{ price: '1', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
			{ price: '2', priceCurrency: 'USD', availability: 'https://schema.org/OutOfStock' },
		])
	);
	const b = extractJsonLdOffers(
		page([
			{ price: '2', priceCurrency: 'USD', availability: 'https://schema.org/OutOfStock' },
			{ price: '1', priceCurrency: 'USD', availability: 'https://schema.org/InStock' },
		])
	);
	assert.deepEqual(a, b);
	assert.equal(signatureOf(a), signatureOf(b));
});

test('JSON-LD offers: @graph nesting, malformed sibling blocks, and no-product pages', () => {
	const graph = `<script type="application/ld+json">not json</script>
		<script type="application/ld+json">${JSON.stringify({
			'@graph': [{ '@type': 'BreadcrumbList' }, { '@type': ['Thing', 'Product'], 'offers': { price: 7 } }],
		})}</script>`;
	assert.deepEqual(extractJsonLdOffers(graph), [7, null, null]);
	assert.equal(extractJsonLdOffers('<html>no structured data</html>'), null);
	assert.equal(extractJsonLdOffers(page(undefined)), null);
});

test('buildProbeRequest: request mode templates the endpoint, document mode probes the URL itself', () => {
	const [requestRule] = compileProbeRules([REQUEST_RULE]);
	const [documentRule] = compileProbeRules([{ pathPattern: '^/product/', headers: undefined }]);

	const probe = buildProbeRequest(requestRule, 'https://example.com/product/prd-42/name.jsp');
	assert.deepEqual(probe, {
		url: 'https://api.example.com/price/42?store=1',
		method: 'POST',
		headers: { accept: 'application/json' },
		body: '{}',
	});

	const doc = buildProbeRequest(documentRule, 'https://example.com/product/prd-42/name.jsp');
	assert.equal(doc.url, 'https://example.com/product/prd-42/name.jsp');
	assert.equal(doc.method, 'GET');
	assert.equal(doc.body, null);

	assert.equal(buildProbeRequest(requestRule, 'https://example.com/catalog/'), null);
});

test('isSameProbeOrigin gates the token: same origin only, fail-safe on garbage', () => {
	// The security token and staging pin belong to the served origin; a rule naming a
	// third-party endpoint must produce a PLAIN fetch. Unparseable input reads as cross-origin.
	const page = 'https://www.example.com/product/prd-1/x';
	assert.equal(isSameProbeOrigin(page, 'https://www.example.com/web/api/1?store=1'), true);
	assert.equal(isSameProbeOrigin(page, 'https://api.example.com/price/1'), false); // subdomain differs
	assert.equal(isSameProbeOrigin(page, 'http://www.example.com/web/api/1'), false); // scheme differs
	assert.equal(isSameProbeOrigin(page, 'https://www.example.com:8443/web/api/1'), false); // port differs
	assert.equal(isSameProbeOrigin(page, 'https://third-party.example/price/1'), false);
	assert.equal(isSameProbeOrigin('not a url', 'https://www.example.com/x'), false);
	assert.equal(isSameProbeOrigin(page, 'not a url'), false);
});

test('duplicate labels are uniquified, never silently merged', () => {
	// Cohorts, pass records, and logs are keyed by label — a collision would merge two rules'
	// canary cohorts and mis-attribute their passes.
	const warnings = [];
	const rules = compileProbeRules(
		[
			{ ...REQUEST_RULE, label: 'pdp' },
			{ ...REQUEST_RULE, pathPattern: '^/product/prd-x', label: 'pdp' },
		],
		warnings
	);
	assert.deepEqual(
		rules.map((rule) => rule.label),
		['pdp', 'pdp#1']
	);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /duplicate label/);
});

test('statusSignals: compiled in order, 2xx rejected, malformed entries dropped individually', () => {
	const warnings = [];
	const [rule] = compileProbeRules(
		[
			{
				label: 'inventory',
				pathPattern: '^/product/prd-([^/]+)',
				source: 'request',
				request: { urlTemplate: 'https://api.example.com/inv/$1' },
				extract: ['price'],
				statusSignals: [
					{ status: 404, signature: 'gone' },
					{ status: 400, contains: 'OOS_CODE', signature: 'unavailable' },
					{ status: 200, signature: 'ignored' }, // 2xx is extracted normally
					{ status: 999, signature: 'bad-status' },
					{ status: 410, signature: '' }, // empty signature
				],
			},
		],
		warnings
	);
	assert.deepEqual(
		rule.statusSignals,
		[
			{ status: 404, contains: null, signature: 'gone' },
			{ status: 400, contains: 'OOS_CODE', signature: 'unavailable' },
		],
		'only the two well-formed non-2xx entries survive, in declared order'
	);
	assert.equal(warnings.length, 3, 'each dropped entry warned');
	assert.ok(warnings.some((w) => /2xx/.test(w)));
});

test('statusSignalFor: first match wins and the contains guard is required to match', () => {
	const [rule] = compileProbeRules([
		{
			label: 'inventory',
			pathPattern: '^/p/(.+)',
			source: 'request',
			request: { urlTemplate: 'https://api.example.com/$1' },
			extract: ['price'],
			statusSignals: [
				{ status: 400, contains: 'OOS_CODE', signature: 'unavailable' },
				{ status: 400, signature: 'generic-400' },
			],
		},
	]);
	assert.equal(statusSignalFor(rule, 400, '{"errors":[{"code":"OOS_CODE"}]}'), 'unavailable');
	// Same status, guard absent from the body -> falls through to the unguarded entry.
	assert.equal(statusSignalFor(rule, 400, '{"errors":[{"code":"SOMETHING_ELSE"}]}'), 'generic-400');
	assert.equal(statusSignalFor(rule, 503, 'anything'), null, 'undeclared status carries no signal');
	assert.equal(statusSignalFor({ statusSignals: [] }, 400, 'x'), null);
	assert.equal(statusSignalFor({}, 400, 'x'), null, 'a rule with no signals never throws');
});

test('pageCheck compiles only with in-bounds indices, and only for source "request"', async () => {
	const base = {
		label: 'r',
		pathPattern: '^/p/',
		source: 'request',
		request: { urlTemplate: 'https://api.example.com/x', method: 'POST', body: '{}' },
		extract: ['a', 'b', 'c', 'd'],
	};
	const ok = compileProbeRules([{ ...base, pageCheck: { enabled: true, priceFrom: 2, availableFrom: 3 } }]);
	assert.deepEqual(ok[0].pageCheck, { priceFrom: 2, availableFrom: 3 });

	// out of bounds -> dropped whole, rule survives (a half-applied mapping compares the wrong column)
	const oob = compileProbeRules([{ ...base, pageCheck: { enabled: true, priceFrom: 2, availableFrom: 9 } }]);
	assert.equal(oob.length, 1);
	assert.equal(oob[0].pageCheck, null);

	// disabled and absent both yield null
	assert.equal(
		compileProbeRules([{ ...base, pageCheck: { enabled: false, priceFrom: 0, availableFrom: 1 } }])[0].pageCheck,
		null
	);
	assert.equal(compileProbeRules([base])[0].pageCheck, null);

	// document mode: the stored signature IS the page's offers, so the check is meaningless
	const doc = compileProbeRules([
		{
			label: 'd',
			pathPattern: '^/p/',
			source: 'document',
			pageCheck: { enabled: true, priceFrom: 0, availableFrom: 1 },
		},
	]);
	assert.equal(doc[0].pageCheck, null);
});

test('pageClaimFromOffers reduces offers to (prices, anyInStock); nothing usable -> null', async () => {
	// Shape is the renderer's: flat [price, currency, availability] triples (browser >= 1.20.0).
	// number and string prices canonicalize the same way
	assert.equal(
		JSON.stringify(JSON.parse(pageClaimFromOffers([35.99, 'USD', 'InStock']))),
		JSON.stringify(JSON.parse(pageClaimFromOffers(['35.99', 'USD', 'InStock'])))
	);
	// every SKU out of stock => the page presents as unavailable
	assert.deepEqual(JSON.parse(pageClaimFromOffers(['15.99', 'USD', 'OutOfStock', '15.99', 'USD', 'OutOfStock'])), [
		['15.99'],
		false,
	]);
	// one available SKU is enough
	assert.deepEqual(JSON.parse(pageClaimFromOffers(['15.99', 'USD', 'OutOfStock', '16.99', 'USD', 'InStock'])), [
		['15.99', '16.99'],
		true,
	]);
	// an absent price must NOT become 0.00 (Number(null) === 0)
	assert.deepEqual(JSON.parse(pageClaimFromOffers([null, null, 'InStock'])), [[], true]);
	assert.equal(pageClaimFromOffers(null), null);
	assert.equal(pageClaimFromOffers([]), null);
});

test('claimsDisagree: availability differs, or the origin price is ABSENT from the page', async () => {
	const page = JSON.stringify([['35.99'], true]);
	const claim = (p, a) => JSON.stringify([p === null ? [] : [p], a]);
	// the measured production case: page says out of stock, origin says available, price equal
	assert.equal(claimsDisagree(JSON.stringify([['35.99'], false]), claim('35.99', true)), true);
	// agreement
	assert.equal(claimsDisagree(page, claim('35.99', true)), false);
	// origin price the page never prints
	assert.equal(claimsDisagree(page, claim('29.99', true)), true);
	// a multi-variant page carrying MORE prices than the origin reports is NOT a disagreement
	assert.equal(claimsDisagree(JSON.stringify([['29.99', '35.99'], true]), claim('35.99', true)), false);
	// no claim on either side is never a disagreement
	assert.equal(claimsDisagree(null, claim('35.99', true)), false);
	assert.equal(claimsDisagree(page, null), false);
	assert.equal(claimsDisagree('not json', claim('35.99', true)), false);
});

test('apiClaimOf projects through the mapping; absent mapped fields yield no claim', async () => {
	const pc = { priceFrom: 2, availableFrom: 3 };
	assert.deepEqual(JSON.parse(apiClaimOf([39.99, 35.99, 35.99, true], pc)), [['35.99'], true]);
	assert.deepEqual(JSON.parse(apiClaimOf([39.99, 35.99, 35.99, false], pc)), [['35.99'], false]);
	assert.equal(apiClaimOf([null, null, null, null], pc), null);
	assert.equal(apiClaimOf([1, 2, 3, true], null), null);
});
