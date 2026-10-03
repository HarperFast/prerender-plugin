import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	compileSamplers,
	continueFnv,
	DEFAULT_FIELDS,
	duplicateSamplerNames,
	inspectSamplers,
	isDeniedHeader,
	urlIsSampled,
} from '../src/util/samplingSpec.js';
import { fnv1a32 } from '../src/util/hash.js';

/**
 * `util/samplingSpec.js` — what a sampler entry may say.
 *
 * WHAT MUST NEVER HAPPEN, and each is pinned below:
 *   - A TYPO THAT WIDENS. Every match key narrows, so an unknown key must invalidate the entry rather than
 *     be ignored: `bot:` for `bots:` would otherwise sample every bot.
 *   - A CREDENTIAL IN A RECORD. Cookie, authorization, the origin bypass header and anything shaped like a
 *     token are refused at compile time, whatever the operator lists.
 *   - A URL SET THE ANALYSIS CANNOT RECOMPUTE. The request path's continued hash must equal
 *     `fnv1a32(salt + '\n' + url)`, and raising the rate must keep every URL already in.
 */

const compile = (list, options) => {
	const warnings = [];
	return { samplers: compileSamplers(list, warnings, options), warnings };
};

test('a sampler with only a name compiles with the documented defaults', () => {
	const { samplers, warnings } = compile([{ name: 'all' }]);
	assert.deepEqual(warnings, []);
	const [s] = samplers;
	assert.equal(s.enabled, true);
	assert.equal(s.by, 'url');
	assert.equal(s.rate, 0.01);
	assert.equal(s.salt, 'all');
	assert.deepEqual(s.fields, DEFAULT_FIELDS);
	assert.deepEqual(s.headers, []);
	assert.equal(s.maxPerMinute, 120);
	assert.equal(s.keep, 14 * 86_400_000);
	for (const key of ['routes', 'bots', 'devices', 'methods', 'cacheStatuses', 'sources', 'statuses', 'urls']) {
		assert.equal(s[key], null, `${key} defaults to any`);
	}
	assert.equal(s.urlPattern, null);
});

test('an unknown key at any level drops the entry instead of widening it', () => {
	for (const entry of [
		{ name: 'a', bot: ['Googlebot'] },
		{ name: 'a', match: { bot: ['Googlebot'] } },
		{ name: 'a', sample: { ratio: 0.5 } },
	]) {
		const { samplers, warnings } = compile([entry]);
		assert.equal(samplers.length, 0, JSON.stringify(entry));
		assert.match(warnings[0], /unknown key/);
	}
});

test('one bad entry drops itself, not the list', () => {
	const { samplers, warnings } = compile([
		{ name: 'good' },
		{ name: 'bad', sample: { rate: 0 } },
		{ name: 'also-good' },
	]);
	assert.deepEqual(
		samplers.map((s) => s.name),
		['good', 'also-good']
	);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /sampler 'bad' dropped: sample.rate/);
});

test("'*' anywhere in a list means any; bots compare lowercased, methods uppercased", () => {
	const [s] = compile([
		{ name: 'a', match: { routes: ['/product/', '*'], bots: ['Googlebot', 'BingBot'], methods: ['get', 'head'] } },
	]).samplers;
	assert.equal(s.routes, null);
	assert.deepEqual([...s.bots], ['googlebot', 'bingbot']);
	assert.deepEqual([...s.methods], ['GET', 'HEAD']);
});

test('rates outside (0, 1], unknown `by`, bad statuses, keeps and caps are refused', () => {
	const bad = [
		{ sample: { rate: 0 } },
		{ sample: { rate: 1.5 } },
		{ sample: { rate: '0.1' } },
		{ sample: { by: 'host' } },
		{ sample: { salt: '' } },
		{ match: { statuses: [200, 'x'] } },
		{ match: { statuses: [99] } },
		{ keep: 60_000 },
		{ keep: 91 * 86_400_000 },
		{ maxPerMinute: 0 },
		{ maxPerMinute: 6001 },
		{ maxPerMinute: 1.5 },
		{ enabled: 'yes' },
		{ match: { routes: '/product/' } },
		{ match: { bots: [''] } },
	];
	for (const extra of bad) {
		const { samplers } = compile([{ name: 'a', ...extra }]);
		assert.equal(samplers.length, 0, JSON.stringify(extra));
	}
	const [ok] = compile([{ name: 'a', sample: { rate: 1, by: 'request' }, match: { statuses: [200, 304] } }]).samplers;
	assert.equal(ok.threshold, 4294967296);
	assert.deepEqual([...ok.statuses], [200, 304]);
});

test('names: required, restricted characters, and the first of a repeated name wins', () => {
	assert.equal(compile([{}]).samplers.length, 0);
	assert.equal(compile([{ name: 'has space' }]).samplers.length, 0);
	assert.equal(compile([{ name: 'a/b' }]).samplers.length, 0);
	assert.equal(compile([{ name: '-lead' }]).samplers.length, 0);
	const { samplers, warnings } = compile([
		{ name: 'dup', sample: { rate: 0.5 } },
		{ name: 'dup', sample: { rate: 0.9 } },
	]);
	assert.equal(samplers.length, 1);
	assert.equal(samplers[0].rate, 0.5);
	assert.match(warnings[0], /already used/);
	assert.deepEqual(duplicateSamplerNames([{ name: 'dup' }, { name: 'x' }, { name: 'dup' }]), ['dup']);
	assert.deepEqual(duplicateSamplerNames([{ name: 'a' }, null, 'junk']), []);
});

test('fields: ts always first and once; an unknown field drops the entry', () => {
	const [s] = compile([{ name: 'a', fields: ['url', 'ts', 'bot', 'url', 'sitemap'] }]).samplers;
	assert.deepEqual(s.fields, ['ts', 'url', 'bot', 'sitemap']);
	assert.equal(s.wantsTarget, true);
	assert.equal(s.wantsConditional, false);
	assert.equal(compile([{ name: 'a', fields: ['url', 'ip'] }]).samplers.length, 0);
	assert.equal(compile([{ name: 'a', fields: [] }]).samplers.length, 0);
});

test('credential headers are refused whatever they are called; ordinary ones are lowercased', () => {
	const denied = ['x-harper-renderer-bypass'];
	for (const header of [
		'Cookie',
		'authorization',
		'Proxy-Authorization',
		'X-Harper-Renderer-Bypass',
		'x-api-key',
		'x-session-id',
		'x-csrf-token',
	]) {
		assert.equal(isDeniedHeader(header, denied), true, header);
		const { samplers, warnings } = compile([{ name: 'a', headers: [header] }], { deniedHeaders: denied });
		assert.equal(samplers.length, 0, header);
		assert.match(warnings[0], /never recorded/);
	}
	const [s] = compile([{ name: 'a', headers: ['User-Agent', 'Accept-Language'] }], { deniedHeaders: denied }).samplers;
	assert.deepEqual(s.headers, ['user-agent', 'accept-language']);
	assert.equal(compile([{ name: 'a', headers: ['bad header'] }]).samplers.length, 0);
	assert.equal(compile([{ name: 'a', headers: Array.from({ length: 9 }, (_, i) => `x-h${i}`) }]).samplers.length, 0);
});

test('urls: an exact set, never a wildcard; urlPattern must compile', () => {
	const [s] = compile([
		{ name: 'a', match: { urls: ['https://www.example.com/a', 'https://www.example.com/b'] } },
	]).samplers;
	assert.equal(s.urls.has('https://www.example.com/a'), true);
	assert.equal(compile([{ name: 'a', match: { urls: ['*'] } }]).samplers.length, 0);
	assert.equal(compile([{ name: 'a', match: { urlPattern: '(' } }]).samplers.length, 0);
	const [p] = compile([{ name: 'a', match: { urlPattern: '/product/prd-\\d+' } }]).samplers;
	assert.equal(p.urlPattern.test('https://www.example.com/product/prd-12/x.jsp'), true);
});

test('the request path hash is fnv1a32(salt + "\\n" + url), so an analysis can recompute the URL set', () => {
	const [s] = compile([{ name: 'revisit', sample: { salt: 'revisit-1', rate: 0.3 } }]).samplers;
	for (let i = 0; i < 200; i++) {
		const url = `https://www.example.com/product/prd-${i}/item.jsp?color=${i % 7}`;
		assert.equal(continueFnv(s.saltState, url), fnv1a32(`revisit-1\n${url}`));
		assert.equal(continueFnv(s.saltState, url) < s.threshold, urlIsSampled(url, s));
	}
});

test('raising the rate keeps every URL already in; a new salt picks a different set', () => {
	const urls = Array.from({ length: 5000 }, (_, i) => `https://www.example.com/catalog/c${i}.jsp`);
	const at = (rate, salt = 's') => new Set(urls.filter((url) => urlIsSampled(url, { rate, salt })));
	const one = at(0.01);
	const two = at(0.02);
	for (const url of one) assert.ok(two.has(url));
	assert.ok(two.size > one.size);
	// Near the rate, not exact: 5,000 URLs at 2% is ~100.
	assert.ok(two.size > 60 && two.size < 140, String(two.size));
	const other = at(0.02, 't');
	const overlap = [...other].filter((url) => two.has(url)).length;
	assert.ok(overlap < other.size / 2, `overlap ${overlap} of ${other.size}`);
});

test('inspectSamplers counts what compiles and what is enabled', () => {
	assert.deepEqual(inspectSamplers([{ name: 'a' }, { name: 'b', enabled: false }, { name: 'c', nope: 1 }]).total, 3);
	const report = inspectSamplers([{ name: 'a' }, { name: 'b', enabled: false }, { name: 'c', nope: 1 }]);
	assert.equal(report.usable, 2);
	assert.equal(report.enabled, 1);
	assert.equal(report.dropped, 1);
	assert.equal(report.warnings.length, 1);
	assert.deepEqual(inspectSamplers('nope'), { total: 0, usable: 0, enabled: 0, dropped: 0, warnings: [] });
});
