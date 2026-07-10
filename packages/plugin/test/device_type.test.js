import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyOptions } from '../src/config.js';
import { sanitizeDeviceType, extractDeviceFromPath } from '../src/util/device_type.js';

beforeEach(() => applyOptions({}));

test('passes through supported device types (case-insensitive)', () => {
	assert.equal(sanitizeDeviceType('mobile'), 'mobile');
	assert.equal(sanitizeDeviceType('TABLET'), 'tablet');
});

test('falls back to the first supported type for unknown/missing values', () => {
	assert.equal(sanitizeDeviceType('watch'), 'desktop');
	assert.equal(sanitizeDeviceType(undefined), 'desktop');
});

test('respects a configured supported list', () => {
	applyOptions({ deviceTypes: { supported: ['mobile', 'desktop'] } });
	assert.equal(sanitizeDeviceType('tablet'), 'mobile'); // unknown -> first supported
	assert.equal(sanitizeDeviceType('desktop'), 'desktop');
});

test('extractDeviceFromPath consumes a leading supported device segment (case-insensitive)', () => {
	assert.deepEqual(extractDeviceFromPath('/mobile/product/prd-1'), { deviceType: 'mobile', path: '/product/prd-1' });
	assert.deepEqual(extractDeviceFromPath('/DESKTOP/catalog/x.jsp'), { deviceType: 'desktop', path: '/catalog/x.jsp' });
});

test('extractDeviceFromPath maps a device-only path to the homepage', () => {
	assert.deepEqual(extractDeviceFromPath('/tablet/'), { deviceType: 'tablet', path: '/' });
	assert.deepEqual(extractDeviceFromPath('/tablet'), { deviceType: 'tablet', path: '/' });
});

test('extractDeviceFromPath returns a null device (path unchanged) when no device prefix is present', () => {
	assert.deepEqual(extractDeviceFromPath('/catalog/x.jsp'), { deviceType: null, path: '/catalog/x.jsp' });
	assert.deepEqual(extractDeviceFromPath('/'), { deviceType: null, path: '/' });
});
