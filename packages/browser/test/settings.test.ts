import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySettings, composeHostResolverRulesArg, settings } from '../dist/settings.js';
import { defaultConfig } from '../dist/config.js';

const HARPER = { mqttOrigin: 'mqtt://localhost:1883', user: 'u', pass: 'p', workerId: 'w1' };

test('requires the harper connection fields', () => {
	assert.throws(() => applySettings(undefined as any), /options object is required/);
	assert.throws(
		() => applySettings({ harper: { mqttOrigin: '', user: 'u', pass: 'p', workerId: 'w' } }),
		/harper.mqttOrigin is required/
	);
});

test('applies defaults and derives jobClaimLimit from concurrency', () => {
	applySettings({ harper: HARPER, concurrency: 4 });
	assert.equal(settings.harper.workerId, 'w1');
	assert.equal(settings.concurrency, 4);
	assert.equal(settings.jobClaimLimit, 8); // concurrency * 2
	assert.equal(settings.queuePort, 9926);
	assert.equal(settings.bypass.header, 'x-harper-renderer-bypass');
	assert.equal(settings.contentEncoding, 'gzip');
	assert.equal(settings.resourceCache.enabled, true);
	assert.deepEqual(settings.backoff, {
		idleMs: 15000,
		minMs: 1000,
		maxMs: 30000,
		pausedMs: 30000,
		maxIdleMs: 60000,
		resultRetries: 3,
	});
	assert.deepEqual(settings.config, defaultConfig());
});

test('backoff options override defaults (partial merge)', () => {
	applySettings({ harper: HARPER, backoff: { idleMs: 5000, resultRetries: 1 } });
	assert.equal(settings.backoff.idleMs, 5000);
	assert.equal(settings.backoff.resultRetries, 1);
	assert.equal(settings.backoff.maxMs, 30000); // untouched default preserved
});

test('options override defaults', () => {
	applySettings({
		harper: HARPER,
		queuePort: 9000,
		bypass: { header: 'x-harper-pr-token', token: 'secret' },
		rps: 20,
		jobClaimLimit: 50,
		incognitoPages: false,
		contentEncoding: 'br',
		resourceCache: { enabled: false, dir: '/tmp/x' },
	});
	assert.equal(settings.queuePort, 9000);
	assert.deepEqual(settings.bypass, { header: 'x-harper-pr-token', token: 'secret' });
	assert.equal(settings.rps, 20);
	assert.equal(settings.jobClaimLimit, 50);
	assert.equal(settings.incognitoPages, false);
	assert.equal(settings.contentEncoding, 'br');
	assert.equal(settings.resourceCache.enabled, false);
	assert.equal(settings.resourceCache.dir, '/tmp/x');
});

test('config option accepts a deep-partial object merged over defaults', () => {
	applySettings({ harper: HARPER, config: { navigation: { waitUntil: 'networkidle2' } } });
	assert.equal(settings.config.navigation.waitUntil, 'networkidle2');
	assert.equal(settings.config.navigation.renderBudgetMs, 20000); // default preserved
	assert.deepEqual(settings.config.block.resourceTypes, ['image', 'media', 'font']);
});

test('bypass token defaults to empty when omitted', () => {
	applySettings({ harper: HARPER });
	assert.equal(settings.bypass.token, '');
});

test('composeHostResolverRulesArg builds the Chrome flag and drops empty entries', () => {
	assert.equal(composeHostResolverRulesArg(undefined), null);
	assert.equal(composeHostResolverRulesArg({}), null);
	assert.equal(composeHostResolverRulesArg({ '': '1.2.3.4', 'www.kohls.com': '' }), null);
	assert.equal(
		composeHostResolverRulesArg({ 'www.kohls.com': '23.50.51.27' }),
		'--host-resolver-rules=MAP www.kohls.com 23.50.51.27'
	);
	assert.equal(
		composeHostResolverRulesArg({ 'www.kohls.com': ' 23.50.51.27 ', 'api.kohls.com': '1.2.3.4' }),
		'--host-resolver-rules=MAP www.kohls.com 23.50.51.27,MAP api.kohls.com 1.2.3.4'
	);
});

test('composeHostResolverRulesArg rejects values with whitespace or commas (rule injection)', () => {
	// A comma in a value would inject a second rule (e.g. a wildcard remap of every host).
	assert.throws(
		() => composeHostResolverRulesArg({ 'www.kohls.com': '23.50.51.27,MAP * 1.1.1.1' }),
		/must not contain whitespace or commas/
	);
	assert.throws(
		() => composeHostResolverRulesArg({ 'www.kohls.com': '23.50.51.27 1.1.1.1' }),
		/must not contain whitespace or commas/
	);
	assert.throws(() => composeHostResolverRulesArg({ 'bad host': '1.2.3.4' }), /must not contain whitespace or commas/);
});

test('hostResolverRules appends --host-resolver-rules onto the default chrome args', () => {
	applySettings({ harper: HARPER, hostResolverRules: { 'www.kohls.com': '23.50.51.27' } });
	assert.deepEqual(settings.hostResolverRules, { 'www.kohls.com': '23.50.51.27' });
	assert.ok(settings.chromeArgs.includes('--no-sandbox')); // hardened defaults preserved
	assert.equal(settings.chromeArgs.at(-1), '--host-resolver-rules=MAP www.kohls.com 23.50.51.27');
});

test('hostResolverRules appends onto custom chromeArgs without dropping them', () => {
	applySettings({
		harper: HARPER,
		chromeArgs: ['--foo'],
		hostResolverRules: { 'www.kohls.com': '23.50.51.27' },
	});
	assert.deepEqual(settings.chromeArgs, ['--foo', '--host-resolver-rules=MAP www.kohls.com 23.50.51.27']);
});

test('no host-resolver flag is added when hostResolverRules is omitted', () => {
	applySettings({ harper: HARPER });
	assert.deepEqual(settings.hostResolverRules, {});
	assert.ok(!settings.chromeArgs.some((a: string) => a.startsWith('--host-resolver-rules')));
});
