import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applySettings, settings } from '../dist/settings.js';
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
	assert.deepEqual(settings.config, defaultConfig());
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
