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
	extractPathProblem,
	compareField,
	fieldCaughtUp,
	changedSlots,
	canonicalPageFacts,
	serializePageFacts,
	parsePageFacts,
	PAGE_FACTS_MAX_BYTES,
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
	assert.deepEqual(ok[0].pageCheck, {
		priceFrom: 2,
		availableFrom: 3,
		vocabulary: null,
		fields: [],
		ignoreChanges: [],
	});

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
	assert.deepEqual(clash[0].pageCheck, {
		priceFrom: 0,
		availableFrom: 1,
		vocabulary: null,
		fields: [],
		ignoreChanges: [],
	});
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

// ---- tuple projection ---------------------------------------------------------------------------

test('a trailing [*].{a,b.c} projects each element to a tuple, sorted like any projection', () => {
	const doc = {
		payload: {
			products: [
				{
					variants: [
						{ sku: '222', availability: 'Out of Stock', price: { current: null } },
						{ sku: '111', availability: 'In Stock', price: { current: 19.99 } },
						{ sku: '333', price: {} },
						null,
					],
				},
			],
		},
	};
	assert.deepEqual(valueAtPath(doc, 'payload.products[0].variants[*].{sku,availability,price.current}'), [
		// Sorted by each tuple's JSON: `["111",…]` < `["222",…]` < `["333",…]` < `[null,…]`.
		['111', 'In Stock', 19.99],
		['222', 'Out of Stock', null],
		['333', null, null], // an unreachable inner path is null, never a shifted neighbour
		[null, null, null], // a null ELEMENT still yields a tuple, so every element has one shape
	]);
	// Whitespace around the names is not part of them.
	assert.deepEqual(valueAtPath({ v: [{ a: 1, b: { c: 2 } }] }, 'v[*].{ a , b.c }'), [[1, 2]]);
	// Nested projections still work, the tuple applying to the innermost elements.
	assert.deepEqual(
		valueAtPath(
			{
				o: [
					{
						i: [
							{ x: 2, y: 'b' },
							{ x: 1, y: 'a' },
						],
					},
				],
			},
			'o[*].i[*].{x,y}'
		),
		[
			[
				[1, 'a'],
				[2, 'b'],
			],
		]
	);
	// Not an array / missing branch: unreachable, like any other path.
	assert.equal(valueAtPath({ v: 'str' }, 'v[*].{a}'), undefined);
	assert.equal(valueAtPath({}, 'v[*].{a}'), undefined);
});

test('a reordered variant list projects to the same tuples, and a moved price reads as a change', () => {
	const one = {
		v: [
			{ s: 'a', p: 1 },
			{ s: 'b', p: 2 },
		],
	};
	const two = {
		v: [
			{ s: 'b', p: 2 },
			{ s: 'a', p: 1 },
		],
	};
	const moved = {
		v: [
			{ s: 'a', p: 2 },
			{ s: 'b', p: 1 },
		],
	};
	const sign = (json) => signatureOf(extractValues(json, ['v[*].{s,p}']));
	assert.equal(sign(one), sign(two), 'order is not a change');
	// The case two separate `[*]` projections cannot see: both prices swapped between SKUs. The sets
	// of SKUs and of prices are unchanged, but the PAIRING moved — which is what a page shows.
	assert.equal(
		signatureOf(extractValues(one, ['v[*].s', 'v[*].p'])),
		signatureOf(extractValues(moved, ['v[*].s', 'v[*].p']))
	);
	assert.notEqual(sign(one), sign(moved), 'a tuple keeps each price attached to its SKU');
});

test('extractPathProblem refuses braces anywhere but a well-formed trailing tuple after [*]', () => {
	for (const ok of ['a.b', 'a[*].b', 'a[*].{b}', 'a[*].{b,c.d}', 'x[0].y[*].{ s , p.v }', 'a[*].b[*].{c}']) {
		assert.equal(extractPathProblem(ok), null, ok);
	}
	for (const bad of [
		'a.{b,c}', // not after [*]
		'a[*].{b,c}.d', // not at the end
		'a[*].{b[0]}', // brackets inside
		'a[*].{b,,c}', // empty name
		'a[*].{}', // empty tuple
		'a[*].{b.}', // empty segment
		'a[*].{b', // unclosed
		'a[*].{x}[*].{y}', // two tuples
		'a[*].{b{c}}', // nested
	]) {
		assert.notEqual(extractPathProblem(bad), null, bad);
	}
});

test('a rule with a malformed tuple projection is dropped with a warning naming the path', () => {
	const warnings = [];
	const rules = compileProbeRules(
		[{ ...REQUEST_RULE, label: 'bad', extract: ['a', 'v.{s,p}'] }, REQUEST_RULE],
		warnings
	);
	assert.equal(rules.length, 1, 'only the malformed rule drops');
	assert.match(warnings[0], /bad: extract\[1\] "v\.\{s,p\}": a tuple projection must END the path/);
});

test('the tuple path is part of the rule fingerprint — a different projection is a different observation', () => {
	const fp = (extract) => compileProbeRules([{ ...REQUEST_RULE, extract }])[0].fingerprint;
	assert.notEqual(fp(['v[*].{s,p}']), fp(['v[*].{s}']));
	assert.notEqual(fp(['v[*].{s,p}']), fp(['v[*].s']));
	assert.equal(fp(['v[*].{s,p}']), fp(['v[*].{s,p}']));
});

// ---- pageCheck.fields / ignoreChanges compilation -------------------------------------------------

const MAPPED_BASE = {
	label: 'm',
	pathPattern: '^/p/',
	source: 'request',
	request: { urlTemplate: 'https://api.example.com/x', method: 'POST', body: '{}' },
	extract: ['title', 'seo', 'image', 'price', 'skus[*].{sku,availability,price}', 'crumbs', 'rating', 'inventory'],
};
const mapped = (pageCheck, warnings = []) =>
	compileProbeRules([{ ...MAPPED_BASE, pageCheck: { enabled: true, ...pageCheck } }], warnings)[0];

test('pageCheck.fields compile into { slot, fact, compare, options, label }; the claim pair becomes optional', () => {
	const warnings = [];
	const rule = mapped(
		{
			fields: [
				{ slot: 0, fact: 'title', compare: 'text' },
				{ slot: 1, fact: 'canonical', compare: 'path' },
				{ slot: 2, fact: 'product.image', compare: 'path' },
				{ slot: 3, fact: 'product.offers', compare: 'priceSet' },
				{ slot: 4, fact: 'product.offers', compare: 'skus' },
				{ slot: 5, fact: 'breadcrumbs', compare: 'names', nameKey: 'label' },
				{ slot: 6, fact: 'product.rating.value', compare: 'number', tolerance: 0.05 },
				{ slot: 0, fact: 'h1', compare: 'text' }, // one slot, two facts: two fields
			],
			ignoreChanges: [7, 7],
		},
		warnings
	);
	assert.deepEqual(warnings, []);
	assert.equal(rule.pageCheck.priceFrom, null, 'no claim pair given, none compiled — and no warning');
	assert.equal(rule.pageCheck.availableFrom, null);
	assert.deepEqual(
		rule.pageCheck.fields.map((field) => field.label),
		[
			'0:title',
			'1:canonical',
			'2:product.image',
			'3:product.offers',
			'4:product.offers',
			'5:breadcrumbs',
			'6:product.rating.value',
			'0:h1',
		]
	);
	assert.deepEqual(rule.pageCheck.fields[4].options, { tuple: { sku: 0, availability: 1, price: 2 } });
	assert.deepEqual(rule.pageCheck.fields[5].options, { nameKey: 'label' });
	assert.deepEqual(rule.pageCheck.fields[6].options, { tolerance: 0.05 });
	assert.deepEqual(rule.pageCheck.ignoreChanges, [7], 'de-duplicated');
	// The claim pair still compiles beside fields, exactly as before.
	const both = mapped({ priceFrom: 3, availableFrom: 4, fields: [{ slot: 0, fact: 'title', compare: 'text' }] });
	assert.equal(both.pageCheck.priceFrom, 3);
	assert.equal(both.pageCheck.fields.length, 1);
});

test('a bad pageCheck.fields entry drops ALONE with a warning — never the rule, never its siblings', () => {
	const cases = [
		[{ slot: 99, fact: 'title', compare: 'text' }, /fields\[0\]\.slot must be an integer index into extract \(0-7\)/],
		[{ slot: '0', fact: 'title', compare: 'text' }, /slot must be an integer/],
		[{ slot: 0, fact: 'titel', compare: 'text' }, /fact must be one of canonical, title/],
		[{ slot: 0, fact: 'title', compare: 'fuzzy' }, /compare must be one of text, path/],
		[{ slot: 0, fact: 'title', compare: 'priceSet' }, /compare "priceSet" does not apply to fact "title" \(use text\)/],
		[
			{ slot: 3, fact: 'product.offers', compare: 'text' },
			/does not apply to fact "product.offers" \(use priceSet or skus\)/,
		],
		[{ slot: 1, fact: 'canonical', compare: 'number' }, /use text or path/],
		[
			{ slot: 6, fact: 'product.rating.value', compare: 'number', tolerance: -1 },
			/tolerance must be a finite number >= 0/,
		],
		[{ slot: 5, fact: 'breadcrumbs', compare: 'names', nameKey: '' }, /nameKey must be a non-empty string/],
		[{ slot: 4, fact: 'product.offers', compare: 'skus', tuple: ['availability', 'price'] }, /tuple must name "sku"/],
		[{ slot: 4, fact: 'product.offers', compare: 'skus', tuple: ['sku', 'sku', 'price'] }, /each at most once/],
		[{ slot: 4, fact: 'product.offers', compare: 'skus', tuple: ['sku', 'color'] }, /tuple\[1\] must be/],
		[{ slot: 4, fact: 'product.offers', compare: 'skus', tuple: ['sku'] }, /at least one of "availability" or "price"/],
		['title', /must be an object/],
	];
	for (const [entry, pattern] of cases) {
		const warnings = [];
		const rule = mapped({ fields: [entry, { slot: 0, fact: 'title', compare: 'text' }] }, warnings);
		assert.ok(rule, `the rule survives ${JSON.stringify(entry)}`);
		assert.deepEqual(
			rule.pageCheck.fields.map((field) => field.label),
			['0:title'],
			`only the bad entry drops: ${JSON.stringify(entry)}`
		);
		assert.equal(warnings.length, 1, JSON.stringify(warnings));
		assert.match(warnings[0], pattern);
		assert.match(warnings[0], /entry dropped/);
	}
	// A duplicate (slot, fact) pair drops the SECOND one.
	const warnings = [];
	const dup = mapped(
		{
			fields: [
				{ slot: 0, fact: 'title', compare: 'text' },
				{ slot: 0, fact: 'title', compare: 'text' },
			],
		},
		warnings
	);
	assert.equal(dup.pageCheck.fields.length, 1);
	assert.match(warnings[0], /maps slot 0 to title a second time/);
	// An unknown key is warned about but does not drop the entry (it changes nothing it compares).
	const typo = [];
	const kept = mapped({ fields: [{ slot: 6, fact: 'product.rating.value', compare: 'number', tolerence: 1 }] }, typo);
	assert.equal(kept.pageCheck.fields.length, 1);
	assert.deepEqual(kept.pageCheck.fields[0].options, { tolerance: 0 });
	assert.match(typo[0], /unknown key\(s\) tolerence ignored/);
	// A non-array is ignored whole, and with nothing else usable the block is too.
	const notArray = [];
	assert.equal(mapped({ fields: { slot: 0 } }, notArray).pageCheck, null);
	assert.match(notArray[0], /pageCheck\.fields must be an array/);
});

test('pageCheck with fields: an INVALID claim pair drops the pair and keeps the fields; alone it drops the block', () => {
	const warnings = [];
	const rule = mapped(
		{ priceFrom: 3, availableFrom: 99, fields: [{ slot: 0, fact: 'title', compare: 'text' }] },
		warnings
	);
	assert.equal(rule.pageCheck.priceFrom, null);
	assert.equal(rule.pageCheck.fields.length, 1);
	assert.match(warnings[0], /the price\/availability claim is ignored \(fields and ignoreChanges still apply\)/);
	// Without fields or ignoreChanges the pair is required, exactly as before.
	const alone = [];
	assert.equal(mapped({}, alone).pageCheck, null);
	assert.match(alone[0], /pageCheck ignored/);
	// A block of every entry bad is no block at all.
	assert.equal(mapped({ fields: [{ slot: 99, fact: 'title', compare: 'text' }] }).pageCheck, null);
});

test('pageCheck.ignoreChanges: entries validated alone, sorted, and a warning when it covers every slot', () => {
	const warnings = [];
	const rule = mapped({ ignoreChanges: [7, 2, 'x', 99, 2] }, warnings);
	assert.deepEqual(rule.pageCheck.ignoreChanges, [2, 7]);
	assert.equal(rule.pageCheck.fields.length, 0);
	assert.equal(warnings.length, 2);
	assert.match(warnings[0], /ignoreChanges\[2\] must be an integer index/);
	assert.match(warnings[1], /ignoreChanges\[3\]/);
	const everything = [];
	mapped({ ignoreChanges: [0, 1, 2, 3, 4, 5, 6, 7] }, everything);
	assert.match(everything[0], /lists EVERY extract slot/);
	const notArray = [];
	assert.equal(mapped({ ignoreChanges: 3 }, notArray).pageCheck, null);
	assert.match(notArray[0], /ignoreChanges must be an array/);
});

test('mappings and ignore lists are NOT in the rule fingerprint — adding them re-baselines nothing', () => {
	const fp = (pageCheck) => compileProbeRules([{ ...MAPPED_BASE, pageCheck }])[0].fingerprint;
	const none = fp(undefined);
	assert.equal(fp({ enabled: true, fields: [{ slot: 0, fact: 'title', compare: 'text' }] }), none);
	assert.equal(fp({ enabled: true, ignoreChanges: [7] }), none);
	assert.equal(
		fp({ enabled: true, priceFrom: 3, availableFrom: 4, fields: [{ slot: 0, fact: 'h1', compare: 'text' }] }),
		none
	);
});

// ---- comparators ----------------------------------------------------------------------------------

const field = (compare, fact, options = {}) => ({ slot: 0, fact, compare, options, label: `0:${fact}` });
const PAGE_URL = 'https://www.example.com/product/prd-1/red-shoe.jsp';
const verdict = (f, api, facts, vocabulary = null) => compareField(f, api, facts, { pageUrl: PAGE_URL, vocabulary });

test('text: exact after NFC + whitespace collapse + trim — no case folding, no HTML stripping', () => {
	const title = field('text', 'title');
	assert.equal(verdict(title, 'Red Shoe | Example', { title: 'Red Shoe | Example' }), true);
	assert.equal(verdict(title, '  Red Shoe \n| Example ', { title: 'Red Shoe | Example' }), true, 'whitespace');
	assert.equal(verdict(title, 'Café', { title: 'Café' }), true, 'NFC');
	assert.equal(verdict(title, 'red shoe | example', { title: 'Red Shoe | Example' }), false, 'case matters');
	// MEASURED QUIRK: the endpoint's description carries markup, and the page's meta tag repeats the
	// RAW string. Stripping the markup would turn a 100% match into a disagreement on every page.
	const meta = field('text', 'metaDescription');
	const raw = 'Soft leather.<br><li><a href="/x">Care</a></li>';
	assert.equal(verdict(meta, raw, { metaDescription: raw }), true);
	assert.equal(
		verdict(meta, raw, { metaDescription: 'Soft leather.Care' }),
		false,
		'the stripped text is a different string'
	);
	// No claim on either side is NOT a disagreement.
	assert.equal(verdict(title, null, { title: 'x' }), null);
	assert.equal(verdict(title, '   ', { title: 'x' }), null);
	assert.equal(verdict(title, 42, { title: '42' }), null, 'a non-string endpoint value is not guessed at');
	assert.equal(verdict(title, 'x', { title: null }), null);
	assert.equal(verdict(title, 'x', null), null);
	// product.* reads through the product object.
	assert.equal(verdict(field('text', 'product.brand'), 'Acme', { product: { brand: 'Acme' } }), true);
	assert.equal(verdict(field('text', 'product.name'), 'Acme', { product: null }), null);
});

test('path: URL path only — size parameters, origin and fragment ignored; relative values resolve against the page', () => {
	const image = field('path', 'product.image');
	// MEASURED QUIRK: the endpoint's image URL differs from the page's on EVERY page, by size params alone.
	assert.equal(
		verdict(image, 'https://media.example.com/is/image/shoe_1?w=350&h=350', {
			product: { image: 'https://media.example.com/is/image/shoe_1?w=1000&h=1000' },
		}),
		true
	);
	assert.equal(
		verdict(image, '//cdn.example.com/is/image/shoe_1?w=350', {
			product: { image: 'https://media.example.com/is/image/shoe_1' },
		}),
		true,
		'protocol-relative, and a different host: the path is what is compared'
	);
	assert.equal(
		verdict(image, 'https://media.example.com/is/image/shoe_2?w=350', {
			product: { image: 'https://media.example.com/is/image/shoe_1?w=1000' },
		}),
		false
	);
	const canonical = field('path', 'canonical');
	// An SEO URL from the endpoint is usually a PATH; the canonical is absolute.
	assert.equal(verdict(canonical, '/product/prd-1/red-shoe.jsp', { canonical: `${PAGE_URL}#top` }), true);
	assert.equal(verdict(canonical, '/product/prd-1/blue-shoe.jsp', { canonical: PAGE_URL }), false);
	assert.equal(
		verdict(canonical, '/p/caf%C3%A9~x', { canonical: 'https://www.example.com/p/café%7Ex' }),
		true,
		'encoding'
	);
	assert.equal(
		verdict(canonical, '/a/', { canonical: 'https://www.example.com/a' }),
		false,
		'a trailing slash is a different path'
	);
	assert.equal(verdict(canonical, '', { canonical: PAGE_URL }), null);
	assert.equal(verdict(canonical, '/x', { canonical: null }), null);
});

test('number: numeric equality, "4.0" meets 4, with an optional tolerance; no number is no claim', () => {
	const value = field('number', 'product.rating.value', { tolerance: 0 });
	const count = field('number', 'product.rating.count', { tolerance: 0 });
	// MEASURED QUIRK: the endpoint states the rating as a string, the page as a number.
	assert.equal(verdict(value, '4.0', { product: { rating: [4, 120] } }), true);
	assert.equal(verdict(value, '4.3', { product: { rating: [4, 120] } }), false);
	assert.equal(verdict(count, 120, { product: { rating: [4, 120] } }), true);
	assert.equal(verdict(count, '121', { product: { rating: [4, 120] } }), false);
	assert.equal(
		verdict(field('number', 'product.rating.value', { tolerance: 0.05 }), 4.25, { product: { rating: [4.3, 1] } }),
		true
	);
	// A null count stays null — never Number(null) === 0.
	assert.equal(verdict(count, 0, { product: { rating: [4, null] } }), null);
	assert.equal(verdict(count, null, { product: { rating: [4, 0] } }), null);
	assert.equal(verdict(count, '1,234', { product: { rating: [4, 1234] } }), null, 'unparseable is no claim');
	assert.equal(verdict(value, '', { product: { rating: [0, 1] } }), null);
});

const offers = (...list) => ({ product: { offers: list } });

test('priceSet: a single endpoint price must be printed; for a list, every printed price must still be offered', () => {
	const set = field('priceSet', 'product.offers');
	assert.equal(verdict(set, 35.99, offers(['1', '35.99', 'USD', 'InStock'])), true, 'number vs string');
	// A single endpoint price (a "lowest price") need only be AMONG the page's variant prices.
	assert.equal(
		verdict(set, 19.99, offers(['1', '19.99', 'USD', 'InStock'], ['2', '24.99', 'USD', 'InStock'])),
		true,
		'scalar is contained'
	);
	// MEASURED QUIRK: a page's structured data can stop at N offers while the endpoint lists every
	// variant, so a price that exists only on an unlisted variant is absent from the page by
	// construction. That must agree — equality here re-rendered the product on every pass, forever.
	assert.equal(
		verdict(set, [10, 12, 15], offers(['1', '10', 'USD', 'InStock'], ['2', '12', 'USD', 'InStock'])),
		true,
		'truncated page lists a subset of the endpoint set'
	);
	// A price the page prints that the endpoint no longer offers IS a disagreement.
	assert.equal(
		verdict(set, [10, 15], offers(['1', '10', 'USD', 'InStock'], ['2', '12', 'USD', 'InStock'])),
		false,
		'page prints a price the endpoint dropped'
	);
	assert.equal(verdict(set, '35.9', offers(['1', '35.90', 'USD', 'InStock'])), true);
	assert.equal(
		verdict(
			set,
			[19.99, 24.99, 19.99],
			offers(['1', '19.99', 'USD', 'InStock'], ['2', '24.99', 'USD', 'InStock'], ['3', '19.99', 'USD', 'OutOfStock'])
		),
		true,
		'distinct sets'
	);
	assert.equal(
		verdict(set, [19.99], offers(['1', '19.99', 'USD', 'InStock'], ['2', '24.99', 'USD', 'InStock'])),
		false
	);
	assert.equal(verdict(set, 29.99, offers(['1', '35.99', 'USD', 'InStock'])), false);
	// MEASURED QUIRK: the endpoint's lowest price is null exactly when the product is out of stock.
	// That is no claim, never "disagrees with every price on the page".
	assert.equal(verdict(set, null, offers(['1', '35.99', 'USD', 'OutOfStock'])), null);
	// A hole on either side means the sets cannot be compared.
	assert.equal(verdict(set, [19.99, null], offers(['1', '19.99', 'USD', 'InStock'])), null);
	assert.equal(verdict(set, 19.99, offers(['1', '19.99', 'USD', 'InStock'], ['2', null, 'USD', 'InStock'])), null);
	assert.equal(verdict(set, [], offers(['1', '19.99', 'USD', 'InStock'])), null);
	assert.equal(verdict(set, 19.99, offers()), null);
	assert.equal(verdict(set, 19.99, { product: { offers: null } }), null);
	assert.equal(verdict(set, 'USD 19.99', offers(['1', '19.99', 'USD', 'InStock'])), null);
});

test('names: the endpoint list against the page list TAIL — a leading home crumb needs no config', () => {
	const crumbs = field('names', 'breadcrumbs', { nameKey: 'name' });
	const page = { breadcrumbs: ['Home', 'Shoes', 'Running Shoes'] };
	// MEASURED QUIRK: the page opens with a site-home crumb the endpoint omits.
	assert.equal(verdict(crumbs, ['Shoes', 'Running Shoes'], page), true);
	assert.equal(
		verdict(crumbs, [{ name: 'Shoes', url: '/c/s' }, { name: 'Running Shoes' }], page),
		true,
		'objects via nameKey'
	);
	assert.equal(verdict(field('names', 'breadcrumbs', { nameKey: 'label' }), [{ label: 'Running Shoes' }], page), true);
	assert.equal(verdict(crumbs, ['Home', 'Shoes', 'Running Shoes'], page), true, 'the whole list is its own tail');
	assert.equal(verdict(crumbs, ['Boots', 'Running Shoes'], page), false);
	assert.equal(verdict(crumbs, ['Running Shoes', 'Shoes'], page), false, 'order matters');
	assert.equal(verdict(crumbs, ['X', 'Home', 'Shoes', 'Running Shoes'], page), false, 'the page is missing a level');
	assert.equal(verdict(crumbs, [], page), null);
	assert.equal(verdict(crumbs, [{ url: '/c/s' }], page), null, 'a crumb with no name is no claim');
	assert.equal(verdict(crumbs, 'Shoes', page), null);
	assert.equal(verdict(crumbs, ['Shoes'], { breadcrumbs: null }), null);
});

test('skus: per-SKU availability verdict and price, over the INTERSECTION of SKUs only', () => {
	const skus = field('skus', 'product.offers', { tuple: { sku: 0, availability: 1, price: 2 } });
	const page = offers(['111', '19.99', 'USD', 'InStock'], ['222', '24.99', 'USD', 'OutOfStock']);
	assert.equal(
		verdict(
			skus,
			[
				['111', 'In Stock', 19.99],
				['222', 'Out of Stock', null],
			],
			page
		),
		true
	);
	// MEASURED QUIRK: the page lists at most 50 SKU offers where the endpoint lists more — a SKU only
	// the endpoint has is not a disagreement.
	assert.equal(
		verdict(
			skus,
			[
				['111', 'In Stock', 19.99],
				['999', 'In Stock', 5],
			],
			page
		),
		true
	);
	assert.equal(verdict(skus, [['111', 'Out of Stock', 19.99]], page), false, 'availability verdicts differ');
	assert.equal(verdict(skus, [['111', 'In Stock', 17.99]], page), false, 'both state a price, and they differ');
	// Out of stock with a null endpoint price: availability still compares, price is no claim.
	assert.equal(verdict(skus, [['222', 'Out of Stock', null]], page), true);
	// An unrecognized word is no verdict — nothing compared, no claim.
	assert.equal(verdict(skus, [['222', 'Backordered', null]], page), null);
	// The rule's vocabulary applies on the endpoint side.
	const vocabulary = { available: new Set(['backordered']), unavailable: new Set() };
	assert.equal(verdict(skus, [['222', 'Backordered', null]], page, vocabulary), false);
	assert.equal(verdict(skus, [['999', 'In Stock', 1]], page), null, 'no SKU in common');
	// A numeric SKU meets its string form; a duplicated SKU is ambiguous and skipped.
	assert.equal(verdict(skus, [[111, 'In Stock', 19.99]], page), true);
	assert.equal(
		verdict(
			skus,
			[
				['111', 'In Stock', 1],
				['111', 'In Stock', 19.99],
			],
			page
		),
		null
	);
	// A custom tuple order.
	const priceFirst = field('skus', 'product.offers', { tuple: { sku: 1, availability: null, price: 0 } });
	assert.equal(verdict(priceFirst, [[19.99, '111', 'ignored']], page), true);
	assert.equal(verdict(priceFirst, [[18.99, '111']], page), false);
	// Garbage entries are skipped, not guessed at.
	assert.equal(verdict(skus, [null, 'x', ['111', 'In Stock', 19.99]], page), true);
	assert.equal(verdict(skus, 'x', page), null);
});

test('fieldCaughtUp: agreement with the new value — and for skus, every CHANGED SKU must itself be proven', () => {
	const title = field('text', 'title');
	assert.equal(fieldCaughtUp(title, 'Old', 'New', { title: 'New' }, {}), true);
	assert.equal(fieldCaughtUp(title, 'Old', 'New', { title: 'Old' }, {}), false);
	assert.equal(fieldCaughtUp(title, 'Old', 'New', null, {}), false, 'no record is no evidence');

	const skus = field('skus', 'product.offers', { tuple: { sku: 0, availability: 1, price: 2 } });
	const page = offers(['111', '19.99', 'USD', 'InStock'], ['222', '24.99', 'USD', 'InStock']);
	const before = [
		['111', 'In Stock', 21.99],
		['222', 'In Stock', 24.99],
		['999', 'In Stock', 5],
	];
	// 111 repriced and the page shows the new price: caught up.
	assert.equal(
		fieldCaughtUp(
			skus,
			before,
			[
				['111', 'In Stock', 19.99],
				['222', 'In Stock', 24.99],
				['999', 'In Stock', 5],
			],
			page
		),
		true
	);
	// 999 repriced — a SKU the page does not list. The SKUs the page DOES list all agree, so the
	// intersection verdict is true; reading that as "caught up" would swallow the change.
	const offPage = [
		['111', 'In Stock', 21.99],
		['222', 'In Stock', 24.99],
		['999', 'In Stock', 4],
	];
	assert.equal(compareField(skus, offPage, page, {}), false, '(111 still disagrees here)');
	const offPageOnly = [
		['111', 'In Stock', 19.99],
		['222', 'In Stock', 24.99],
		['999', 'In Stock', 4],
	];
	const beforeOffPage = [
		['111', 'In Stock', 19.99],
		['222', 'In Stock', 24.99],
		['999', 'In Stock', 5],
	];
	assert.equal(compareField(skus, offPageOnly, page, {}), true);
	assert.equal(
		fieldCaughtUp(skus, beforeOffPage, offPageOnly, page, {}),
		false,
		'an unprovable changed SKU is not caught up'
	);
	// A SKU gone from the endpoint while the page still lists it: not caught up. And one the page
	// never listed: the page agrees with the old list as well as the new one, so nothing proves it was
	// re-rendered — that triggers, as every removal did before fields.
	const removed = [['111', 'In Stock', 19.99]];
	assert.equal(
		fieldCaughtUp(
			skus,
			[
				['111', 'In Stock', 19.99],
				['222', 'In Stock', 24.99],
			],
			removed,
			page
		),
		false
	);
	assert.equal(
		fieldCaughtUp(
			skus,
			[
				['111', 'In Stock', 19.99],
				['333', 'In Stock', 1],
			],
			removed,
			page
		),
		false
	);
	// A changed tuple that cannot be keyed is never provable.
	assert.equal(
		fieldCaughtUp(
			skus,
			[['111', 'In Stock', 19.99]],
			[
				['111', 'In Stock', 19.99],
				[null, 'In Stock', 1],
			],
			page
		),
		false
	);
});

test('fieldCaughtUp: a change the comparator cannot SEE is never caught up — the page agrees with both values', () => {
	// A crumb's URL changed inside the endpoint's objects; only names are compared, and the page's links
	// may be exactly what is stale.
	const crumbs = field('names', 'breadcrumbs', { nameKey: 'name' });
	const trail = { breadcrumbs: ['Home', 'Shoes'] };
	assert.equal(
		fieldCaughtUp(crumbs, [{ name: 'Shoes', url: '/c/1' }], [{ name: 'Shoes', url: '/c/2' }], trail, {}),
		false
	);
	assert.equal(fieldCaughtUp(crumbs, [{ name: 'Boots' }], [{ name: 'Shoes' }], trail, {}), true, 'a visible change is');
	// A cache-busting query parameter under `path`, a whitespace edit under `text`.
	const image = field('path', 'product.image');
	const shown = { product: { image: 'https://media.example.com/i/a.jpg?w=1000' } };
	assert.equal(
		fieldCaughtUp(image, 'https://media.example.com/i/a.jpg?v=2', 'https://media.example.com/i/a.jpg?v=3', shown, {}),
		false
	);
	assert.equal(fieldCaughtUp(field('text', 'title'), 'Red  Shoe', 'Red Shoe', { title: 'Red Shoe' }, {}), false);
	// A SKU whose tuple changed only in a position the mapping skips.
	const skus = field('skus', 'product.offers', { tuple: { sku: 0, availability: null, price: 1 } });
	const offersShown = offers(['111', '19.99', 'USD', 'InStock']);
	assert.equal(fieldCaughtUp(skus, [['111', 19.99, 7]], [['111', 19.99, 6]], offersShown, {}), false);
	assert.equal(fieldCaughtUp(skus, [['111', 21.99, 7]], [['111', 19.99, 6]], offersShown, {}), true);
	// Two SKUs change at once: one the page lists (and shows the new price for), one it does not. The
	// visible change makes the page disagree with the OLD list, so only the per-SKU proof stops the
	// off-page change being swallowed with it.
	const pair = offers(['111', '19.99', 'USD', 'InStock']);
	assert.equal(
		fieldCaughtUp(
			skus,
			[
				['111', 21.99, 7],
				['999', 5, 1],
			],
			[
				['111', 19.99, 7],
				['999', 4, 1],
			],
			pair,
			{}
		),
		false
	);
	// ...and likewise a second SKU whose tuple moved only in a skipped position.
	const both = offers(['111', '19.99', 'USD', 'InStock'], ['222', '9.99', 'USD', 'InStock']);
	assert.equal(
		fieldCaughtUp(
			skus,
			[
				['111', 21.99, 7],
				['222', 9.99, 3],
			],
			[
				['111', 19.99, 7],
				['222', 9.99, 2],
			],
			both,
			{}
		),
		false
	);
	assert.equal(
		fieldCaughtUp(
			skus,
			[
				['111', 21.99, 7],
				['222', 9.99, 3],
			],
			[
				['111', 19.99, 7],
				['222', 9.99, 3],
			],
			both,
			{}
		),
		true
	);
	// A value the endpoint did not state before: the page showing the new one is evidence.
	assert.equal(fieldCaughtUp(field('text', 'title'), null, 'Red Shoe', { title: 'Red Shoe' }, {}), true);
});

test('changedSlots: which slots moved, or null when a literal or a shape change makes that unknowable', () => {
	assert.deepEqual(changedSlots('[1,"a",[1,2]]', '[1,"b",[1,3]]'), [1, 2]);
	assert.deepEqual(changedSlots('[1,{"x":1}]', '[2,{"x":1}]'), [0]);
	assert.equal(changedSlots('unavailable', '[1,2]'), null, 'a status-signal literal is a state, not slots');
	assert.equal(changedSlots('[1,2]', 'unavailable'), null);
	assert.equal(changedSlots('[1,2]', '[1,2,3]'), null, 'different shapes');
	assert.equal(changedSlots('[1,2]', '[1,2]'), null, 'nothing moved: not a change of any slot');
});

test('compareField never throws on a corrupted record — it is no claim', () => {
	const cases = [
		[field('text', 'product.name'), 'x', { product: 'str' }],
		[field('number', 'product.rating.value', { tolerance: 0 }), 1, { product: { rating: 'x' } }],
		[field('priceSet', 'product.offers'), 1, { product: { offers: 'x' } }],
		[
			field('skus', 'product.offers', { tuple: { sku: 0, availability: 1, price: 2 } }),
			[['1', 'x', 1]],
			{ product: { offers: [5] } },
		],
		[field('names', 'breadcrumbs', { nameKey: 'name' }), ['a'], { breadcrumbs: [1, 2] }],
	];
	for (const [f, api, facts] of cases)
		assert.equal(compareField(f, api, facts, { pageUrl: PAGE_URL }), null, f.compare);
});

// ---- the stored page record ----------------------------------------------------------------------

test('canonicalPageFacts: the contract shape in a FIXED key order — extra keys and wrong types dropped', () => {
	const a = canonicalPageFacts({
		h1: 'Red Shoe',
		title: 'Red Shoe | Example',
		extra: 'dropped',
		product: { offers: [['1', '9.99', 'USD', 'InStock'], 'junk'], rating: [4.5, '12'], name: 'Red Shoe', brand: 7 },
		breadcrumbs: ['Home', 'Shoes'],
		canonical: PAGE_URL,
		metaDescription: '',
	});
	assert.deepEqual(Object.keys(a), ['canonical', 'title', 'metaDescription', 'h1', 'product', 'breadcrumbs']);
	assert.deepEqual(a, {
		canonical: PAGE_URL,
		title: 'Red Shoe | Example',
		metaDescription: null, // empty string: one way to say "no claim"
		h1: 'Red Shoe',
		product: {
			name: 'Red Shoe',
			brand: null, // wrong type
			image: null,
			rating: [4.5, null], // a string count is not the contract's number
			offers: [
				['1', '9.99', 'USD', 'InStock'],
				[null, null, null, null],
			],
		},
		breadcrumbs: ['Home', 'Shoes'],
	});
	// Equal facts serialize to equal bytes whatever order the renderer sent them in.
	const b = canonicalPageFacts({
		canonical: PAGE_URL,
		breadcrumbs: ['Home', 'Shoes'],
		h1: 'Red Shoe',
		title: 'Red Shoe | Example',
		product: { name: 'Red Shoe', rating: [4.5, '12'], offers: [['1', '9.99', 'USD', 'InStock'], 'junk'] },
	});
	assert.equal(JSON.stringify(b), JSON.stringify(a));
	// Nothing claimable is null, and a trail with a non-string crumb is no trail.
	assert.equal(canonicalPageFacts({ title: '', product: { name: null }, breadcrumbs: [] }), null);
	assert.equal(canonicalPageFacts(null), null);
	assert.equal(canonicalPageFacts('facts'), null);
	assert.equal(canonicalPageFacts({ title: 't', breadcrumbs: ['a', 5] }).breadcrumbs, null);
});

test('serializePageFacts REFUSES a record over the bound rather than truncating it; parsePageFacts round-trips', () => {
	const small = serializePageFacts({ title: 'Red Shoe' });
	assert.equal(small.refused, false);
	assert.deepEqual(parsePageFacts(small.json), {
		canonical: null,
		title: 'Red Shoe',
		metaDescription: null,
		h1: null,
		product: null,
		breadcrumbs: null,
	});
	// 200 offers — the renderer's own cap — fit.
	const many = Array.from({ length: 200 }, (_, i) => [`sku-${i}`, '19.99', 'USD', 'InStock']);
	assert.equal(serializePageFacts({ product: { offers: many } }).refused, false);
	// A pathological page does not: stored as null, and the size reported.
	const huge = serializePageFacts({ breadcrumbs: Array.from({ length: 30 }, () => 'x'.repeat(2000)) });
	assert.equal(huge.refused, true);
	assert.equal(huge.json, null);
	assert.ok(huge.bytes > PAGE_FACTS_MAX_BYTES);
	assert.equal(PAGE_FACTS_MAX_BYTES, 16 * 1024);
	assert.deepEqual(serializePageFacts(null), { json: null, bytes: 0, refused: false });
	for (const junk of [null, '', '{', '[1]', '"s"', 5]) assert.equal(parsePageFacts(junk), null, String(junk));
});
