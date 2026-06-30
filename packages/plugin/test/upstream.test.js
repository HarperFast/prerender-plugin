import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOptions, config } from '../src/config.js';
import { stagingTargetIp } from '../src/util/upstream.js';

// Minimal stand-in for the request headers object (only `.get` is used here).
const headersWith = (present) => ({ get: (name) => (present.includes(name) ? '1' : null) });

test('staging defaults are off (empty ip) with a default toggle header', () => {
	applyOptions({});
	assert.equal(config.staging.ip, '');
	assert.equal(config.staging.header, 'x-harper-staging');
});

test('applyOptions accepts staging overrides', () => {
	applyOptions({ staging: { ip: '23.50.51.27', header: 'x-acme-staging' } });
	assert.equal(config.staging.ip, '23.50.51.27');
	assert.equal(config.staging.header, 'x-acme-staging');
	// untouched sibling keeps its default when only ip is overridden
	applyOptions({ staging: { ip: '1.2.3.4' } });
	assert.equal(config.staging.header, 'x-harper-staging');
});

test('stagingTargetIp is undefined when no staging ip is configured', () => {
	applyOptions({});
	assert.equal(stagingTargetIp(headersWith(['x-harper-staging'])), undefined);
});

test('stagingTargetIp returns the configured ip only when the toggle header is present', () => {
	applyOptions({ staging: { ip: '23.50.51.27' } });
	assert.equal(stagingTargetIp(headersWith(['x-harper-staging'])), '23.50.51.27');
	assert.equal(stagingTargetIp(headersWith([])), undefined);
});

test('stagingTargetIp honors a custom toggle header name', () => {
	applyOptions({ staging: { ip: '23.50.51.27', header: 'x-acme-staging' } });
	assert.equal(stagingTargetIp(headersWith(['x-acme-staging'])), '23.50.51.27');
	assert.equal(stagingTargetIp(headersWith(['x-harper-staging'])), undefined);
});

test('stagingTargetIp ignores an invalid configured ip (feature disabled)', () => {
	applyOptions({ staging: { ip: 'not-an-ip' } });
	assert.equal(stagingTargetIp(headersWith(['x-harper-staging'])), undefined);
});

test('stagingTargetIp is disabled when the toggle header name is configured empty', () => {
	applyOptions({ staging: { ip: '23.50.51.27', header: '' } });
	assert.equal(stagingTargetIp(headersWith(['x-harper-staging'])), undefined);
});

test('stagingTargetIp supports an IPv6 staging address', () => {
	applyOptions({ staging: { ip: '2606:2800:220:1:248:1893:25c8:1946' } });
	assert.equal(stagingTargetIp(headersWith(['x-harper-staging'])), '2606:2800:220:1:248:1893:25c8:1946');
});
