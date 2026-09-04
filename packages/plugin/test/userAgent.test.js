import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyOptions } from '../src/config.js';
import { getBotName, botMayDiscover, botCountsAsDemand, botRendersJs } from '../src/util/userAgent.js';

// Minimal stand-in for a WHATWG Headers object.
const headers = (map) => ({ get: (k) => map[k.toLowerCase()] ?? null });

beforeEach(() => applyOptions({}));

test('identifies known crawlers from the default registry', () => {
	assert.equal(
		getBotName(headers({ 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' })),
		'Googlebot'
	);
	assert.equal(getBotName(headers({ 'user-agent': 'Mozilla/5.0 (compatible; bingbot/2.0)' })), 'Bingbot');
	assert.equal(getBotName(headers({ 'user-agent': 'GPTBot/1.0' })), 'GPTBot');
});

test('prefers the most specific (longest) match', () => {
	assert.equal(getBotName(headers({ 'user-agent': 'Googlebot-Image/1.0' })), 'Googlebot-Image');
});

test('returns "other" for non-listed or missing user agents', () => {
	assert.equal(getBotName(headers({ 'user-agent': 'Mozilla/5.0 (Macintosh) Safari/605' })), 'other');
	assert.equal(getBotName(headers({})), 'other');
});

test('returns "debug" for the debug marker header', () => {
	assert.equal(getBotName(headers({ 'harper': 'pre-render', 'user-agent': 'whatever' })), 'debug');
});

test('honors a configured bot registry (and recompiles on change)', () => {
	applyOptions({ analytics: { bots: [{ name: 'MyBot', match: 'mybot' }] } });
	assert.equal(getBotName(headers({ 'user-agent': 'MyBot/3.0 (+https://example.com)' })), 'MyBot');
	// A default crawler removed from the registry loses its display name; derivation
	// still labels it with what the UA itself declares.
	assert.equal(getBotName(headers({ 'user-agent': 'Googlebot/2.1' })), 'Googlebot');
});

test('identifies expanded-registry crawlers under their display names', () => {
	const cases = [
		['GoogleOther-Image/1.0', 'GoogleOther-Image'],
		[
			'Mozilla/5.0 (X11; Linux x86_64; Storebot-Google/1.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/W.X.Y.Z Safari/537.36',
			'Storebot-Google',
		],
		['Mozilla/5.0 (compatible; SeznamBot/4.0; +http://napoveda.seznam.cz/seznambot-intro/)', 'SeznamBot'],
		['Mozilla/5.0 (compatible; Yeti/1.1; +https://naver.me/spd)', 'Naver Yeti'],
		[
			'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)',
			'ClaudeBot',
		],
		['Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)', 'OAI-SearchBot'],
		['Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)', 'PerplexityBot'],
		['CCBot/2.0 (https://commoncrawl.org/faq/)', 'CCBot'],
		[
			'Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)',
			'Bytespider',
		],
		['meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)', 'Meta-ExternalAgent'],
		['Mozilla/5.0 (compatible; MJ12bot/v1.4.8; http://mj12bot.com/)', 'MJ12bot'],
		['rogerbot/1.2 (https://moz.com/help/, rogerbot-crawler@moz.com)', 'Rogerbot'],
		['Screaming Frog SEO Spider/21.4', 'Screaming Frog'],
		['DuckDuckBot/1.0; (+http://duckduckgo.com/duckduckbot.html)', 'DuckDuckBot'],
		['Mozilla/5.0 (compatible; DuckDuckBot-Https/1.1; https://duckduckgo.com/duckduckbot)', 'DuckDuckBot'],
	];
	for (const [ua, expected] of cases) {
		assert.equal(getBotName(headers({ 'user-agent': ua })), expected, ua);
	}
});

// Derivation tests run with an empty registry so every hit below is derivation itself,
// not a registry match.
test('derives a name from a self-identifying UA the registry misses', () => {
	applyOptions({ analytics: { bots: [] } });
	const cases = [
		// compatible-slot, with version / bare / vN.N-style version
		['Mozilla/5.0 (compatible; ExampleBot/2.1; +https://example.com/bot)', 'ExampleBot'],
		['Mozilla/5.0 (compatible; Barkrowler/0.9; +https://example.com/crawler)', 'Barkrowler'],
		['Mozilla/5.0 (compatible; NewSpider; spider-feedback@example.com)', 'NewSpider'],
		// leading product token, incl. multiword heads
		['UnknownCrawler/1.0 (+https://example.com)', 'UnknownCrawler'],
		['facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', 'facebookexternalhit'],
		['Acme Site Auditor/3.2 (contact@example.com)', 'Acme Site Auditor'],
		['Sogou web spider/4.0(+http://www.example.com/docs.htm#07)', 'Sogou web spider'],
		// crawler keyword buried in an otherwise browser-shaped UA
		[
			'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 (NewsReaderBot/0.1; +http://example.com/bot)',
			'NewsReaderBot',
		],
	];
	for (const [ua, expected] of cases) {
		assert.equal(getBotName(headers({ 'user-agent': ua })), expected, ua);
	}
});

test('never derives a name from a browser-shaped UA', () => {
	applyOptions({ analytics: { bots: [] } });
	const browsers = [
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
		'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
		'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
		// legacy IE self-labels `compatible;` but MSIE is a browser, not a bot
		'Mozilla/5.0 (compatible; MSIE 10.0; Windows NT 6.1; Trident/6.0)',
		'Opera/9.80 (Windows NT 6.0) Presto/2.12.388 Version/12.14',
	];
	for (const ua of browsers) {
		assert.equal(getBotName(headers({ 'user-agent': ua })), 'other', ua);
	}
});

test('rejects names that would be meaningless aggregates or URL fragments', () => {
	applyOptions({ analytics: { bots: [] } });
	// A bare keyword labels nothing — grouping every "Bot" together is worse than 'other'.
	assert.equal(getBotName(headers({ 'user-agent': 'Mozilla/5.0 (compatible; Bot/1.0)' })), 'other');
	// The URL must not contribute tokens even though it contains "bot".
	assert.equal(getBotName(headers({ 'user-agent': 'Mozilla/5.0 (+http://www.example.com/bot.html)' })), 'other');
});

test('registry match wins over derivation', () => {
	applyOptions({ analytics: { bots: [{ name: 'Nice Name', match: 'uglytokenbot' }] } });
	assert.equal(getBotName(headers({ 'user-agent': 'UglyTokenBot/1.0 (+https://example.com)' })), 'Nice Name');
});

test('deriveUnknownBots: false restores the strict registry-or-other behavior', () => {
	applyOptions({ analytics: { deriveUnknownBots: false } });
	assert.equal(getBotName(headers({ 'user-agent': 'ExampleBot/2.1 (+https://example.com/bot)' })), 'other');
});

test('botMayDiscover: the default trusts every bot', () => {
	assert.equal(botMayDiscover('Googlebot'), true);
	assert.equal(botMayDiscover('other'), true);
	assert.equal(botMayDiscover('Anything At All'), true);
});

test('botMayDiscover: a list gates case-insensitively and follows a live config change', () => {
	applyOptions({ ingress: { discoveryBots: ['googlebot', 'Bingbot'] } });
	assert.equal(botMayDiscover('Googlebot'), true);
	assert.equal(botMayDiscover('BINGBOT'), true);
	assert.equal(botMayDiscover('AhrefsBot'), false);
	assert.equal(botMayDiscover('other'), false);
	assert.equal(botMayDiscover(undefined), false);
	// '*' anywhere in the list restores trust-everyone.
	applyOptions({ ingress: { discoveryBots: ['*'] } });
	assert.equal(botMayDiscover('AhrefsBot'), true);
});

test('botMayDiscover: an empty list turns traffic discovery off for every bot', () => {
	applyOptions({ ingress: { discoveryBots: [] } });
	assert.equal(botMayDiscover('Googlebot'), false);
	assert.equal(botMayDiscover('other'), false);
});

test('botCountsAsDemand: the default counts every bot', () => {
	assert.equal(botCountsAsDemand('Googlebot'), true);
	assert.equal(botCountsAsDemand('other'), true);
	assert.equal(botCountsAsDemand('Anything At All'), true);
});

test('botCountsAsDemand: a list gates case-insensitively and follows a live config change', () => {
	applyOptions({ render: { demand: { bots: ['googlebot', 'Bingbot'] } } });
	assert.equal(botCountsAsDemand('Googlebot'), true);
	assert.equal(botCountsAsDemand('BINGBOT'), true);
	assert.equal(botCountsAsDemand('AhrefsBot'), false);
	assert.equal(botCountsAsDemand('other'), false);
	assert.equal(botCountsAsDemand(undefined), false);
	applyOptions({ render: { demand: { bots: ['*'] } } });
	assert.equal(botCountsAsDemand('AhrefsBot'), true);
});

test('botCountsAsDemand: an empty list stops the ladder seeing any demand at all', () => {
	applyOptions({ render: { demand: { bots: [] } } });
	assert.equal(botCountsAsDemand('Googlebot'), false);
	assert.equal(botCountsAsDemand('other'), false);
});

// The two allowlists share a compile helper but must not share STATE: editing one cannot be
// allowed to answer for the other, which is exactly what a single cached set would do.
test('the discovery and demand allowlists are independent', () => {
	applyOptions({ ingress: { discoveryBots: ['Googlebot'] }, render: { demand: { bots: ['Bingbot'] } } });
	assert.equal(botMayDiscover('Googlebot'), true);
	assert.equal(botMayDiscover('Bingbot'), false);
	assert.equal(botCountsAsDemand('Googlebot'), false);
	assert.equal(botCountsAsDemand('Bingbot'), true);
});

// ---- botRendersJs: the gate on hydration_calls ----
//
// Same shape as the two allowlists above — a Set recompiled when the registry array's identity
// changes — and the same reason it is not a `??=` memo: applyOptions replaces `config.analytics.bots`
// with a fresh array on every change, and a set built once would keep honouring the registry the
// process booted with after an operator flagged or unflagged a crawler from the console.

test('botRendersJs: the default registry flags only the documented renderers', () => {
	for (const bot of ['Googlebot', 'Google InspectionTool', 'Bingbot', 'Applebot', 'YandexBot']) {
		assert.equal(botRendersJs(bot), true, bot);
	}
	for (const bot of ['GPTBot', 'ClaudeBot', 'OAI-SearchBot', 'PerplexityBot', 'CCBot', 'AhrefsBot', 'other']) {
		assert.equal(botRendersJs(bot), false, bot);
	}
	assert.equal(botRendersJs(undefined), false);
});

test('botRendersJs: matches case-insensitively, like the other registry-derived allowlists', () => {
	assert.equal(botRendersJs('googlebot'), true);
	assert.equal(botRendersJs('BINGBOT'), true);
});

test('botRendersJs: follows a live registry change in both directions', () => {
	applyOptions({
		analytics: {
			bots: [
				{ name: 'MyBot', match: 'mybot', rendersJs: true },
				{ name: 'Googlebot', match: 'googlebot', rendersJs: false },
			],
		},
	});
	assert.equal(botRendersJs('MyBot'), true, 'a deployment can flag a crawler the default does not');
	assert.equal(botRendersJs('Googlebot'), false, 'and unflag one the default does');
	// Back to the defaults: a fresh array, a fresh set.
	applyOptions({});
	assert.equal(botRendersJs('MyBot'), false);
	assert.equal(botRendersJs('Googlebot'), true);
});

test('botRendersJs: only a literal true flags; an entry without the field, or with junk in it, does not', () => {
	applyOptions({
		analytics: {
			bots: [
				{ name: 'A', match: 'a' },
				{ name: 'B', match: 'b', rendersJs: 'yes' },
				{ name: 'C', match: 'c', rendersJs: 1 },
			],
		},
	});
	for (const bot of ['A', 'B', 'C']) assert.equal(botRendersJs(bot), false, bot);
});

test('botRendersJs: a derived name has no registry entry to carry the flag', () => {
	applyOptions({ analytics: { bots: [], deriveUnknownBots: true } });
	const derived = getBotName(headers({ 'user-agent': 'RenderyBot/1.0 (+https://example.com/bot)' }));
	assert.equal(derived, 'RenderyBot');
	assert.equal(botRendersJs(derived), false);
});
