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
	ruleFingerprint,
	prefixFingerprints,
	signatureUnderPrefix,
	availabilityToken,
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
	assert.deepEqual(ok[0].pageCheck, { priceFrom: 2, availableFrom: 3, vocabulary: null });

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

	// enabled must be BOOLEAN true: a truthy non-boolean ("true" from YAML/JSON) is a config that
	// LOOKS enabled while protecting nothing — that must warn, never pass silently.
	const warnings = [];
	const strEnabled = compileProbeRules(
		[{ ...base, pageCheck: { enabled: 'true', priceFrom: 0, availableFrom: 1 } }],
		warnings
	);
	assert.equal(strEnabled[0].pageCheck, null);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /pageCheck\.enabled must be boolean true/);

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

test('availability reduces recognized vocabulary only — anything else is NO verdict, never a guess', async () => {
	// A URL form or unstripped schema.org prefix still reads (defense against a renderer that
	// didn't normalize), and Google's own in-stock set counts as available.
	assert.deepEqual(JSON.parse(pageClaimFromOffers(['9.99', 'USD', 'https://schema.org/InStock'])), [['9.99'], true]);
	assert.deepEqual(JSON.parse(pageClaimFromOffers(['9.99', 'USD', 'LimitedAvailability'])), [['9.99'], true]);
	assert.deepEqual(JSON.parse(pageClaimFromOffers(['9.99', 'USD', 'SoldOut'])), [['9.99'], false]);
	// PreOrder (and any private vocabulary) is neither available nor unavailable: the verdict is
	// null, so availability can never disagree — a wrong guess here would hard-expire every
	// matched page on every pass.
	assert.deepEqual(JSON.parse(pageClaimFromOffers(['9.99', 'USD', 'PreOrder'])), [['9.99'], null]);
	assert.deepEqual(JSON.parse(pageClaimFromOffers(['9.99', 'USD', 'InventoryLevel:42'])), [['9.99'], null]);
	// Mixed definitive-negative + unrecognized must NOT read as "unavailable" — the unrecognized
	// offer might be the buyable one.
	assert.deepEqual(JSON.parse(pageClaimFromOffers(['9.99', 'USD', 'OutOfStock', '9.99', 'USD', 'PreOrder'])), [
		['9.99'],
		null,
	]);
	// ...but any recognized available offer wins outright.
	assert.deepEqual(JSON.parse(pageClaimFromOffers(['9.99', 'USD', 'PreOrder', '9.99', 'USD', 'InStock'])), [
		['9.99'],
		true,
	]);
	// No readable price AND no verdict = no claim at all.
	assert.equal(pageClaimFromOffers(['$9.99', 'USD', 'PreOrder']), null);
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

test('claimsDisagree compares each dimension only when BOTH sides claim it', async () => {
	// null availability on either side: never an availability disagreement — but price still
	// compares, so an unrecognized vocabulary does not cost the price protection.
	assert.equal(claimsDisagree(JSON.stringify([['35.99'], null]), JSON.stringify([['35.99'], true])), false);
	assert.equal(claimsDisagree(JSON.stringify([['35.99'], null]), JSON.stringify([['29.99'], true])), true);
	assert.equal(claimsDisagree(JSON.stringify([['35.99'], true]), JSON.stringify([['35.99'], null])), false);
	// a page with NO readable prices must not disagree with any endpoint price: that shape is
	// systematic (a price format the plugin cannot parse), and price-disagreeing on it would
	// re-expire the page after every render, forever.
	assert.equal(claimsDisagree(JSON.stringify([[], true]), JSON.stringify([['29.99'], true])), false);
	// both dimensions unclaimed = never a disagreement
	assert.equal(claimsDisagree(JSON.stringify([[], null]), JSON.stringify([['29.99'], true])), false);
});

test('apiClaimOf projects through the mapping; absent mapped fields yield no claim', async () => {
	const pc = { priceFrom: 2, availableFrom: 3 };
	assert.deepEqual(JSON.parse(apiClaimOf([39.99, 35.99, 35.99, true], pc)), [['35.99'], true]);
	assert.deepEqual(JSON.parse(apiClaimOf([39.99, 35.99, 35.99, false], pc)), [['35.99'], false]);
	assert.deepEqual(JSON.parse(apiClaimOf([39.99, 35.99, 35.99, 'false'], pc)), [['35.99'], false]);
	assert.equal(apiClaimOf([null, null, null, null], pc), null);
	assert.equal(apiClaimOf([1, 2, 3, true], null), null);
	// An availability WORD is a claim: endpoints spell it every way (schema.org form, constant
	// case, the plain retail phrase) and all of them reduce to one token.
	assert.deepEqual(JSON.parse(apiClaimOf([39.99, 35.99, 35.99, 'IN_STOCK'], pc)), [['35.99'], true]);
	assert.deepEqual(JSON.parse(apiClaimOf([39.99, 35.99, 35.99, 'In Stock'], pc)), [['35.99'], true]);
	assert.deepEqual(JSON.parse(apiClaimOf([39.99, 35.99, 35.99, 'Out of Stock'], pc)), [['35.99'], false]);
	assert.deepEqual(JSON.parse(apiClaimOf([39.99, 35.99, 35.99, 'Sold Out'], pc)), [['35.99'], false]);
	assert.deepEqual(JSON.parse(apiClaimOf([39.99, 35.99, 35.99, 'https://schema.org/InStock'], pc)), [['35.99'], true]);
	// A word outside the vocabulary, or a non-word (a count), is a shape the plugin cannot read —
	// availability becomes NO claim rather than a guess that would disagree with every page on
	// every pass. Price alone still projects.
	assert.deepEqual(JSON.parse(apiClaimOf([39.99, 35.99, 35.99, 'PreOrder'], pc)), [['35.99'], null]);
	assert.deepEqual(JSON.parse(apiClaimOf([39.99, 35.99, 35.99, 7], pc)), [['35.99'], null]);
	assert.equal(apiClaimOf([null, null, null, 'Coming Soon'], pc), null);
	// A `[*]` projection: in stock when ANY variant is, out only when every readable one is and
	// none is unreadable — the reduction the page's offers get, so both sides answer one question.
	assert.deepEqual(JSON.parse(apiClaimOf([1, 2, 3, ['Out of Stock', 'In Stock']], pc)), [['3.00'], true]);
	assert.deepEqual(JSON.parse(apiClaimOf([1, 2, 3, ['Out of Stock', 'Out of Stock']], pc)), [['3.00'], false]);
	assert.deepEqual(JSON.parse(apiClaimOf([1, 2, 3, ['Out of Stock', 'PreOrder']], pc)), [['3.00'], null]);
	// A null element is an UNREADABLE variant, not an absent one: `[*]` writes null where the path
	// could not be walked, so a sold-out variant beside one whose availability has not populated
	// must not answer a confident "out of stock" the endpoint never gave.
	assert.deepEqual(JSON.parse(apiClaimOf([1, 2, 3, ['Out of Stock', null]], pc)), [['3.00'], null]);
	assert.deepEqual(JSON.parse(apiClaimOf([1, 2, 3, ['In Stock', null]], pc)), [['3.00'], true]);
	assert.deepEqual(JSON.parse(apiClaimOf([1, 2, 3, []], pc)), [['3.00'], null]);
});

test('apiClaimOf consults the rule vocabulary before the built-in words', () => {
	const pc = {
		priceFrom: 0,
		availableFrom: 1,
		vocabulary: { available: new Set(['ships']), unavailable: new Set(['nope', 'instock']) },
	};
	assert.deepEqual(JSON.parse(apiClaimOf([9, 'Ships!'], pc)), [['9.00'], true]);
	assert.deepEqual(JSON.parse(apiClaimOf([9, 'nope'], pc)), [['9.00'], false]);
	// The rule's word beats the built-in reading — an endpoint may use a schema.org-looking word
	// with its own meaning, and only the operator knows.
	assert.deepEqual(JSON.parse(apiClaimOf([9, 'InStock'], pc)), [['9.00'], false]);
	// Built-in words still apply for anything the rule did not name.
	assert.deepEqual(JSON.parse(apiClaimOf([9, 'Sold Out'], pc)), [['9.00'], false]);
	assert.equal(availabilityToken('https://schema.org/In-Stock'), 'instock');
	assert.equal(availabilityToken(' OUT_OF_STOCK '), 'outofstock');
	assert.equal(availabilityToken('///'), '');
});

test('pageCheck.availableValues / unavailableValues compile into the vocabulary, or drop it alone', () => {
	const base = {
		pathPattern: '^/p/',
		source: 'request',
		request: { urlTemplate: 'https://x/$1' },
		extract: ['a', 'b'],
	};
	const ok = compileProbeRules([
		{
			...base,
			pageCheck: {
				enabled: true,
				priceFrom: 0,
				availableFrom: 1,
				availableValues: ['Ships Today', 'IN_STOCK'],
				unavailableValues: ['Gone'],
			},
		},
	]);
	assert.deepEqual([...ok[0].pageCheck.vocabulary.available].sort(), ['instock', 'shipstoday']);
	assert.deepEqual([...ok[0].pageCheck.vocabulary.unavailable], ['gone']);
	// Neither list -> no vocabulary object, built-in words only.
	assert.equal(
		compileProbeRules([{ ...base, pageCheck: { enabled: true, priceFrom: 0, availableFrom: 1 } }])[0].pageCheck
			.vocabulary,
		null
	);
	// A word on both sides is a contradiction: the vocabulary drops, pageCheck stays.
	const warnings = [];
	const clash = compileProbeRules(
		[
			{
				...base,
				pageCheck: { enabled: true, priceFrom: 0, availableFrom: 1, availableValues: ['x'], unavailableValues: ['X'] },
			},
		],
		warnings
	);
	assert.deepEqual(clash[0].pageCheck, { priceFrom: 0, availableFrom: 1, vocabulary: null });
	assert.match(warnings[0], /both list x/);
	// A malformed list drops the vocabulary, not the page check.
	const bad = compileProbeRules(
		[{ ...base, pageCheck: { enabled: true, priceFrom: 0, availableFrom: 1, availableValues: 'yes' } }],
		warnings
	);
	assert.equal(bad[0].pageCheck.vocabulary, null);
	assert.match(warnings[1], /availableValues must be an array/);
});

test('valueAtPath [*] projects the rest of the path over an array, positionally', () => {
	const doc = {
		variants: [{ a: { s: 'x' } }, { a: {} }, { a: { s: 'z' } }],
		flat: [1, 2],
		nested: [{ k: [{ v: 1 }, { v: 2 }] }, { k: [{ v: 3 }] }],
	};
	// Projections come back SORTED — order is not a change, and an endpoint that returns its
	// variants in an unstable order must not read as changed on every pass.
	assert.deepEqual(valueAtPath(doc, 'variants[*].a.s'), ['x', 'z', null]);
	assert.deepEqual(valueAtPath(doc, 'variants[*].a'), [{ s: 'x' }, { s: 'z' }, {}]);
	assert.deepEqual(valueAtPath(doc, 'flat[*]'), [1, 2]);
	assert.deepEqual(valueAtPath(doc, 'nested[*].k[*].v'), [[1, 2], [3]]);
	// Past the end of a branch every element reads null, positionally, never a throw.
	assert.deepEqual(valueAtPath(doc, 'variants[*].a.s.t'), [null, null, null]);
	// Not an array -> unreachable, like any missing branch; a signature of all-null then fails the probe.
	assert.equal(valueAtPath(doc, 'nope[*].a'), undefined);
	assert.equal(valueAtPath({ variants: 'str' }, 'variants[*].a'), undefined);
	assert.deepEqual(extractValues(doc, ['variants[*].a.s', 'missing[*]']), [['x', 'z', null], null]);
	// `[*]` and `[N]` tokenize as brackets, never as the names `*` / digits.
	assert.deepEqual(valueAtPath({ '*': 1, 'variants': [{ '*': 2 }] }, 'variants[*].*'), [2]);
});

test('a reordered array projects to the same value, so a reorder is not a change', () => {
	// The failure this prevents: an endpoint with no stable variant order reads as 100% changed on
	// every pass, which on the canary cohort is a trip and a bulk invalidation of the rule's scope.
	const one = {
		v: [
			{ sku: 'a', av: 'In Stock' },
			{ sku: 'b', av: 'Out of Stock' },
		],
	};
	const two = {
		v: [
			{ sku: 'b', av: 'Out of Stock' },
			{ sku: 'a', av: 'In Stock' },
		],
	};
	assert.deepEqual(valueAtPath(one, 'v[*].av'), valueAtPath(two, 'v[*].av'));
	assert.deepEqual(valueAtPath(one, 'v[*]'), valueAtPath(two, 'v[*]'));
	// And the signature built from them agrees, which is the property that actually matters.
	assert.equal(
		JSON.stringify(extractValues(one, ['v[*].sku', 'v[*].av'])),
		JSON.stringify(extractValues(two, ['v[*].sku', 'v[*].av']))
	);
	// A genuine change still reads as one.
	const changed = {
		v: [
			{ sku: 'a', av: 'Out of Stock' },
			{ sku: 'b', av: 'Out of Stock' },
		],
	};
	assert.notEqual(JSON.stringify(extractValues(one, ['v[*].av'])), JSON.stringify(extractValues(changed, ['v[*].av'])));
});

test('ruleFingerprint changes with what is observed and with nothing else', () => {
	const base = {
		label: 'a',
		pathPattern: '^/p/(\\d+)',
		source: 'request',
		request: {
			urlTemplate: 'https://x/$1',
			method: 'GET',
			headers: { Accept: 'application/json', Referer: 'https://x/' },
		},
		extract: ['a', 'b'],
		statusSignals: [{ status: 400, contains: 'GONE', signature: 'gone' }],
		invalidateScope: 'all',
		pageCheck: { enabled: true, priceFrom: 0, availableFrom: 1 },
	};
	const fp = (raw) => compileProbeRules([raw])[0].fingerprint;
	assert.match(fp(base), /^[0-9a-f]{8}$/);
	// Same observation, different bookkeeping: label, pattern, scope, pageCheck, header ORDER.
	assert.equal(fp({ ...base, label: 'b' }), fp(base));
	assert.equal(fp({ ...base, pathPattern: '^/q/(\\d+)' }), fp(base));
	assert.equal(fp({ ...base, invalidateScope: null }), fp(base));
	assert.equal(fp({ ...base, pageCheck: undefined }), fp(base));
	assert.equal(
		fp({ ...base, request: { ...base.request, headers: { Referer: 'https://x/', Accept: 'application/json' } } }),
		fp(base)
	);
	// Different observation: endpoint, method, a header, the body, a path, a signal.
	assert.notEqual(fp({ ...base, request: { ...base.request, urlTemplate: 'https://y/$1' } }), fp(base));
	assert.notEqual(fp({ ...base, request: { ...base.request, method: 'POST', body: '{}' } }), fp(base));
	assert.notEqual(
		fp({ ...base, request: { ...base.request, headers: { ...base.request.headers, Cookie: 'c=1' } } }),
		fp(base)
	);
	assert.notEqual(fp({ ...base, extract: ['a', 'b', 'c'] }), fp(base));
	assert.notEqual(fp({ ...base, statusSignals: [] }), fp(base));
	// Document mode has its own fingerprint, distinct from any request rule.
	assert.notEqual(fp({ pathPattern: '^/p/' }), fp(base));
	assert.equal(fp({ pathPattern: '^/p/' }), fp({ pathPattern: '^/other/', label: 'z' }));
	// Direct call agrees with the compiled value.
	assert.equal(ruleFingerprint(compileProbeRules([base])[0]), fp(base));
});

test('ruleFingerprint output is PINNED — fingerprints stored in production must keep matching', () => {
	// Every baseline in ProbeState carries the fingerprint of the rule that took it, and the
	// append-only upgrade matches those stored strings against prefixes rebuilt with this same
	// function. Any change to what ruleFingerprint hashes or how it serializes silently turns the
	// next deploy into a full re-baseline of every matched URL (and every prefix match into a miss).
	// These values were computed before the prefix feature existed; they must never move.
	const rule = {
		pathPattern: '^/p/(\\d+)',
		source: 'request',
		request: {
			urlTemplate: 'https://x/$1',
			method: 'GET',
			headers: { Accept: 'application/json', Referer: 'https://x/' },
		},
		statusSignals: [{ status: 400, contains: 'GONE', signature: 'gone' }],
	};
	const fp = (extract) => compileProbeRules([{ ...rule, extract }])[0].fingerprint;
	assert.equal(fp(['a']), '6bee9b27');
	assert.equal(fp(['a', 'b']), 'b35871c5');
	assert.equal(fp(['a', 'b', 'c']), '735f199e');
	assert.equal(compileProbeRules([{ pathPattern: '^/p/' }])[0].fingerprint, '2f3989b4');
});

/** A three-path rule, and the same rule after appending a fourth path. */
const SHORT_RULE = {
	pathPattern: '^/product/prd-([^/]+)',
	source: 'request',
	request: {
		urlTemplate: 'https://api.example.com/price/$1',
		method: 'POST',
		headers: { Accept: 'application/json' },
		body: '{}',
	},
	extract: ['p.regular', 'p.sale', 'p.price'],
	statusSignals: [{ status: 404, contains: 'GONE', signature: 'unavailable' }],
};
const LONG_RULE = { ...SHORT_RULE, extract: [...SHORT_RULE.extract, 'p.variants[*].availability'] };
const compiled = (raw) => compileProbeRules([raw])[0];

test('prefixFingerprints: an APPENDED rule recognises the fingerprint of every shorter prefix', () => {
	const long = compiled(LONG_RULE);
	// Exactly the fingerprints the shorter rules stored — made by ruleFingerprint, not a lookalike.
	assert.equal(long.prefixFingerprints.get(compiled(SHORT_RULE).fingerprint), 3);
	assert.equal(
		long.prefixFingerprints.get(compiled({ ...SHORT_RULE, extract: ['p.regular', 'p.sale'] }).fingerprint),
		2
	);
	assert.equal(long.prefixFingerprints.get(compiled({ ...SHORT_RULE, extract: ['p.regular'] }).fingerprint), 1);
	assert.equal(long.prefixFingerprints.size, 3, 'k = 1..n-1 — never the full list');
	assert.equal(long.prefixFingerprints.has(long.fingerprint), false);
	// Bookkeeping that is not in the fingerprint is not in the prefixes either.
	const relabeled = compiled({
		...LONG_RULE,
		label: 'other',
		pageCheck: { enabled: true, priceFrom: 2, availableFrom: 3 },
	});
	assert.deepEqual([...relabeled.prefixFingerprints], [...long.prefixFingerprints]);
	// The direct call agrees with what compileRule stored.
	assert.deepEqual([...prefixFingerprints(long)], [...long.prefixFingerprints]);
	// A one-path rule has no prefix; document mode has no extract list at all.
	assert.equal(compiled({ ...SHORT_RULE, extract: ['p.price'] }).prefixFingerprints.size, 0);
	assert.equal(compiled({ pathPattern: '^/p/' }).prefixFingerprints.size, 0);
});

test('prefixFingerprints: anything but a clean append matches NO prefix — a real edit still re-baselines', () => {
	const shortFp = compiled(SHORT_RULE).fingerprint;
	const matches = (raw) => compiled(raw).prefixFingerprints.has(shortFp);
	assert.equal(matches(LONG_RULE), true, 'control: the clean append matches');
	// Removal, reordering, and editing an existing path.
	assert.equal(matches({ ...SHORT_RULE, extract: ['p.regular', 'p.sale'] }), false, 'removal');
	assert.equal(matches({ ...SHORT_RULE, extract: ['p.sale', 'p.regular', 'p.price', 'p.x'] }), false, 'reorder');
	assert.equal(matches({ ...SHORT_RULE, extract: ['p.regular', 'p.sale', 'p.list', 'p.x'] }), false, 'edit');
	// Prepending or inserting shifts the old slots — not an append.
	assert.equal(matches({ ...SHORT_RULE, extract: ['p.x', ...SHORT_RULE.extract] }), false, 'prepend');
	assert.equal(matches({ ...SHORT_RULE, extract: ['p.regular', 'p.x', 'p.sale', 'p.price'] }), false, 'insert');
	// An append made together with ANY other change to the observation.
	const withLong = (request) => ({ ...LONG_RULE, request: { ...LONG_RULE.request, ...request } });
	assert.equal(matches(withLong({ urlTemplate: 'https://api.example.com/v2/$1' })), false, 'endpoint');
	assert.equal(matches(withLong({ method: 'GET', body: null })), false, 'method/body');
	assert.equal(matches(withLong({ body: '{"a":1}' })), false, 'body');
	assert.equal(matches(withLong({ headers: { Accept: 'application/json', Cookie: 'c=1' } })), false, 'header');
	assert.equal(matches({ ...LONG_RULE, statusSignals: [] }), false, 'status signals');
	assert.equal(matches({ ...LONG_RULE, source: 'document', extract: undefined }), false, 'source');
});

// What probeOnce produces for a rule and a response — the stored and observed strings in production.
const signed = (json, raw) => signatureOf(extractValues(json, raw.extract));

test('signatureUnderPrefix reproduces the SHORTER rule’s signature byte for byte', () => {
	const long = compiled(LONG_RULE);
	// Values that stress the round trip: floats, a string with escapes and non-ASCII, a nested
	// object, a missing field (null), and a projected array.
	const response = {
		p: {
			regular: 39.99,
			sale: { amount: 35.5, label: 'Save "10%" — now\n', tags: ['a', null] },
			price: undefined,
			variants: [{ availability: 'In Stock' }, { availability: 'Out of Stock' }],
		},
	};
	const stored = signed(response, SHORT_RULE);
	const observed = signed(response, LONG_RULE);
	assert.notEqual(observed, stored, 'control: the longer observation is a different string');
	assert.equal(signatureUnderPrefix(long, 3, stored, observed), stored);
	// A different value in an old slot reads as different; a different value only in the new slot does not.
	const repriced = signed({ p: { ...response.p, regular: 29.99 } }, LONG_RULE);
	assert.notEqual(signatureUnderPrefix(long, 3, stored, repriced), stored);
	const newSlotOnly = signed({ p: { ...response.p, variants: [{ availability: 'Sold Out' }] } }, LONG_RULE);
	assert.equal(signatureUnderPrefix(long, 3, stored, newSlotOnly), stored);
});

test('signatureUnderPrefix: an all-null PREFIX is a value list, not a failed probe', () => {
	// The shorter rule would have read this response as a failure (all-null); the longer rule reads
	// a valid observation whose old slots went null — a change against the stored values.
	const long = compiled(LONG_RULE);
	const stored = signed({ p: { regular: 1, sale: 2, price: 3 } }, SHORT_RULE);
	const observed = signed({ p: { variants: [{ availability: 'In Stock' }] } }, LONG_RULE);
	assert.notEqual(observed, null, 'control: the longer rule accepts the observation');
	assert.equal(signatureOf(extractValues({ p: {} }, SHORT_RULE.extract)), null, 'control: the shorter rule would not');
	assert.equal(signatureUnderPrefix(long, 3, stored, observed), '[null,null,null]');
});

test('signatureUnderPrefix: status-signal literals compare whole, exactly as today', () => {
	const long = compiled(LONG_RULE);
	const stored = signed({ p: { regular: 1, sale: 2, price: 3 } }, SHORT_RULE);
	const observed = signed({ p: { regular: 1, sale: 2, price: 3, variants: [] } }, LONG_RULE);
	// Literal observed: passes through whole — equal to a stored literal, unequal to stored values.
	assert.equal(signatureUnderPrefix(long, 3, 'unavailable', 'unavailable'), 'unavailable');
	assert.equal(signatureUnderPrefix(long, 3, stored, 'unavailable'), 'unavailable');
	// Stored literal, values observed: the prefix of the values, which can never equal the literal.
	assert.equal(signatureUnderPrefix(long, 3, 'unavailable', observed), '[1,2,3]');
});

test('signatureUnderPrefix refuses a baseline the shorter rule could not have written', () => {
	// The guard against a prefix match by hash collision (or a foreign row) reading as a change for
	// every row: the shorter rule stores one of its literals or exactly k values, nothing else.
	const long = compiled(LONG_RULE);
	const observed = signed({ p: { regular: 1, sale: 2, price: 3, variants: [] } }, LONG_RULE);
	assert.equal(signatureUnderPrefix(long, 3, '[1,2]', observed), null, 'wrong slot count');
	assert.equal(signatureUnderPrefix(long, 3, '[1,2,3,4]', observed), null, 'wrong slot count');
	assert.equal(signatureUnderPrefix(long, 3, 'gone', observed), null, 'a literal this rule does not declare');
	assert.equal(signatureUnderPrefix(long, 3, '{"a":1}', observed), null, 'not an array');
	// And an observation that is neither a literal nor this rule's n values.
	assert.equal(signatureUnderPrefix(long, 3, '[1,2,3]', '[1,2,3]'), null, 'observation with the wrong slot count');
	assert.equal(signatureUnderPrefix(long, 3, '[1,2,3]', 'garbage'), null, 'an undeclared literal observation');
	// Control: the same stored value with the right shape is comparable.
	assert.equal(signatureUnderPrefix(long, 3, '[1,2,3]', observed), '[1,2,3]');
});

test('claimsDisagree survives a corrupted stored claim instead of ending the sweep', async () => {
	// A stored claim is data from a previous release or a damaged row — it may be any JSON.
	// Destructuring a non-array would throw inside the sweep's per-URL path and end the pass.
	const good = JSON.stringify([['35.99'], true]);
	for (const junk of ['null', '5', '"a string"', '{"not":"an array"}', '[]', '[null,null]', '[{},true]']) {
		assert.equal(claimsDisagree(junk, good), false, `page claim ${junk} must not throw or disagree`);
		assert.equal(claimsDisagree(good, junk), false, `api claim ${junk} must not throw or disagree`);
	}
});
