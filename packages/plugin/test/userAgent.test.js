import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyOptions } from '../src/config.js';
import { getBotName } from '../src/util/userAgent.js';

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
