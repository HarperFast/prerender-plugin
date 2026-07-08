import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfig, loadConfig } from '../dist/config.js';

const writeConfig = (value: unknown): string => {
	const dir = mkdtempSync(join(tmpdir(), 'prerender-cfg-'));
	const file = join(dir, 'prerender.config.json');
	writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
	return file;
};

test('defaults reproduce the original hardcoded behavior', () => {
	const config = defaultConfig();
	assert.deepEqual(config.devices.desktop.viewport, { width: 1920, height: 5000 });
	assert.equal(config.devices.desktop.userAgent, undefined);
	assert.ok(config.devices.mobile.userAgent && config.devices.mobile.userAgent.length > 0);
	assert.equal(config.defaultDevice, 'desktop');
	assert.deepEqual(config.block.resourceTypes, ['image', 'media', 'font']);
	assert.deepEqual(config.block.urlPatterns, []);
	assert.equal(config.navigation.waitUntil, 'domcontentloaded');
	assert.equal(config.scroll.enabled, true);
	assert.equal(config.scroll.topSettleMs, 300);
	assert.equal(config.scroll.stepFraction, 0.5);
	assert.equal(config.postProcess.stripScripts, true);
	assert.equal(config.injectWebComponentsPolyfill, true);
});

test('loadConfig() with no path returns defaults', () => {
	assert.deepEqual(loadConfig(), defaultConfig());
});

test('deep-merges a file over defaults, preserving untouched nested fields', () => {
	const file = writeConfig({
		navigation: { waitUntil: 'networkidle2' },
		block: { urlPatterns: ['google-analytics.com'] },
		devices: { mobile: { viewport: { width: 414, height: 896 } } },
		injectWebComponentsPolyfill: false,
	});
	const config = loadConfig(file);

	// overridden scalars
	assert.equal(config.navigation.waitUntil, 'networkidle2');
	assert.equal(config.injectWebComponentsPolyfill, false);
	// untouched sibling in the same nested object keeps its default
	assert.equal(config.navigation.renderBudgetMs, 20000);
	// scroll deep-merge: overridden stepFraction wins, sibling stepMs keeps its default
	assert.equal(loadConfig(writeConfig({ scroll: { stepFraction: 1 } })).scroll.stepFraction, 1);
	assert.equal(loadConfig(writeConfig({ scroll: { stepFraction: 1 } })).scroll.stepMs, defaultConfig().scroll.stepMs);
	// arrays replace wholesale
	assert.deepEqual(config.block.urlPatterns, ['google-analytics.com']);
	assert.deepEqual(config.block.resourceTypes, ['image', 'media', 'font']);
	// device deep-merge: viewport replaced, default userAgent preserved
	assert.deepEqual(config.devices.mobile.viewport, { width: 414, height: 896 });
	assert.equal(config.devices.mobile.userAgent, defaultConfig().devices.mobile.userAgent);
	// unmentioned device untouched
	assert.deepEqual(config.devices.tablet.viewport, { width: 768, height: 1024 });
});

test('can add a new device profile', () => {
	const file = writeConfig({ devices: { watch: { viewport: { width: 320, height: 320 } } } });
	const config = loadConfig(file);
	assert.deepEqual(config.devices.watch.viewport, { width: 320, height: 320 });
	assert.ok(config.devices.desktop); // defaults still present
});

test('validation: defaultDevice must exist in devices', () => {
	const file = writeConfig({ defaultDevice: 'phone' });
	assert.throws(() => loadConfig(file), /defaultDevice "phone" is not present/);
});

test('validation: a device must have a numeric viewport', () => {
	const file = writeConfig({ devices: { desktop: { viewport: { width: 'wide' } } } });
	assert.throws(() => loadConfig(file), /requires a viewport with numeric width and height/);
});

test('validation: navigation budgets must be positive', () => {
	const file = writeConfig({ navigation: { renderBudgetMs: 0 } });
	assert.throws(() => loadConfig(file), /navigation.renderBudgetMs must be a positive number/);
});

test('throws a descriptive error for malformed JSON', () => {
	const file = writeConfig('{ not valid json');
	assert.throws(() => loadConfig(file), /Failed to read prerender config/);
});

test('throws when the JSON root is not an object', () => {
	const file = writeConfig([1, 2, 3]);
	assert.throws(() => loadConfig(file), /must be a JSON object/);
});

test('throws a descriptive error for a missing file', () => {
	assert.throws(() => loadConfig('/no/such/prerender.config.json'), /Failed to read prerender config/);
});
