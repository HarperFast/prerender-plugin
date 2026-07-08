import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOptions, config } from '../src/config.js';
import { isRenderNowAuthorized, isRenderInFlight, pollForFreshRender } from '../src/util/renderNow.js';

// Minimal stand-in for request headers (only `.get` is used). `values` maps
// header name -> value; a missing name returns null (Harper/Headers semantics).
const headersWith = (values = {}) => ({ get: (name) => (name in values ? values[name] : null) });

test('renderNow defaults are off with a default header name', () => {
	applyOptions({});
	assert.equal(config.renderNow.enabled, false);
	assert.equal(config.renderNow.header, 'x-harper-render-now');
	assert.equal(config.renderNow.token, '');
	assert.equal(config.renderNow.fallback, 'origin');
});

test('isRenderNowAuthorized is false when the feature is disabled', () => {
	applyOptions({ renderNow: { enabled: false, token: 'secret' } });
	assert.equal(isRenderNowAuthorized(headersWith({ 'x-harper-render-now': 'secret' })), false);
});

test('isRenderNowAuthorized requires the header to be present', () => {
	applyOptions({ renderNow: { enabled: true, token: 'secret' } });
	assert.equal(isRenderNowAuthorized(headersWith({})), false);
});

test('isRenderNowAuthorized requires the header value to match the token', () => {
	applyOptions({ renderNow: { enabled: true, token: 'secret' } });
	assert.equal(isRenderNowAuthorized(headersWith({ 'x-harper-render-now': 'secret' })), true);
	assert.equal(isRenderNowAuthorized(headersWith({ 'x-harper-render-now': 'wrong' })), false);
});

test('isRenderNowAuthorized authorizes on presence when no token is configured', () => {
	applyOptions({ renderNow: { enabled: true } });
	assert.equal(isRenderNowAuthorized(headersWith({ 'x-harper-render-now': 'anything' })), true);
	assert.equal(isRenderNowAuthorized(headersWith({ 'x-harper-render-now': '' })), true);
	assert.equal(isRenderNowAuthorized(headersWith({})), false);
});

test('isRenderNowAuthorized honors a custom header name', () => {
	applyOptions({ renderNow: { enabled: true, header: 'x-acme-render', token: 't' } });
	assert.equal(isRenderNowAuthorized(headersWith({ 'x-acme-render': 't' })), true);
	assert.equal(isRenderNowAuthorized(headersWith({ 'x-harper-render-now': 't' })), false);
});

test('isRenderNowAuthorized is disabled when the header name is configured empty', () => {
	applyOptions({ renderNow: { enabled: true, header: '', token: 't' } });
	assert.equal(isRenderNowAuthorized(headersWith({ '': 't' })), false);
});

test('renderNow.token is sourced from valueEnv when set', () => {
	process.env.RENDER_NOW_TOKEN_TEST = 'from-env';
	applyOptions({ renderNow: { enabled: true, valueEnv: 'RENDER_NOW_TOKEN_TEST' } });
	assert.equal(config.renderNow.token, 'from-env');
	assert.equal(isRenderNowAuthorized(headersWith({ 'x-harper-render-now': 'from-env' })), true);
	delete process.env.RENDER_NOW_TOKEN_TEST;
});

test('isRenderInFlight: no existing schedule is not in flight (safe to enqueue)', () => {
	const lease = 10 * 60 * 1000;
	assert.equal(isRenderInFlight(null, 1_000_000, lease), false);
	assert.equal(isRenderInFlight(undefined, 1_000_000, lease), false);
});

test('isRenderInFlight: a due/past schedule is not in flight (claimable, re-enqueue)', () => {
	const now = 1_000_000;
	const lease = 10 * 60 * 1000;
	assert.equal(isRenderInFlight({ nextRenderTime: now }, now, lease), false);
	assert.equal(isRenderInFlight({ nextRenderTime: now - 1 }, now, lease), false);
});

test('isRenderInFlight: a lease-window schedule IS in flight (piggyback, no duplicate render)', () => {
	const now = 1_000_000;
	const lease = 10 * 60 * 1000;
	assert.equal(isRenderInFlight({ nextRenderTime: now + 1 }, now, lease), true);
	assert.equal(isRenderInFlight({ nextRenderTime: now + lease }, now, lease), true);
});

test('isRenderInFlight: a far-future scheduled target is NOT in flight (bump to now)', () => {
	const now = 1_000_000;
	const lease = 10 * 60 * 1000;
	// e.g. a target scheduled for tonight — render-now should still force it now.
	assert.equal(isRenderInFlight({ nextRenderTime: now + lease + 1 }, now, lease), false);
	assert.equal(isRenderInFlight({ nextRenderTime: now + 24 * 60 * 60 * 1000 }, now, lease), false);
});

test('pollForFreshRender returns a page rendered at/after `since`', async () => {
	let calls = 0;
	// Stale for the first two polls, fresh on the third.
	const get = async () => (++calls >= 3 ? { lastCached: 6000, content: 'x' } : { lastCached: 1000 });
	const page = await pollForFreshRender({
		get,
		cacheKey: 'k',
		since: 5000,
		timeoutMs: 10_000,
		pollIntervalMs: 1,
		sleep: async () => {},
		now: () => 1000, // constant clock — never times out
	});
	assert.equal(page.lastCached, 6000);
	assert.equal(calls, 3);
});

test('pollForFreshRender accepts a Date lastCached', async () => {
	const get = async () => ({ lastCached: new Date(6000) });
	const page = await pollForFreshRender({
		get,
		cacheKey: 'k',
		since: 5000,
		timeoutMs: 1000,
		pollIntervalMs: 1,
		sleep: async () => {},
		now: () => 0,
	});
	assert.equal(page.lastCached.valueOf(), 6000);
});

test('pollForFreshRender returns null on timeout when only stale pages exist', async () => {
	let t = 1000;
	const now = () => t;
	const sleep = async (ms) => {
		t += ms;
	};
	const get = async () => ({ lastCached: 0 }); // always stale
	const page = await pollForFreshRender({
		get,
		cacheKey: 'k',
		since: 5000,
		timeoutMs: 1000,
		pollIntervalMs: 250,
		sleep,
		now,
	});
	assert.equal(page, null);
});

test('pollForFreshRender returns null on timeout when the page is missing', async () => {
	let t = 0;
	const now = () => t;
	const sleep = async (ms) => {
		t += ms;
	};
	const get = async () => null;
	const page = await pollForFreshRender({
		get,
		cacheKey: 'k',
		since: 1,
		timeoutMs: 500,
		pollIntervalMs: 100,
		sleep,
		now,
	});
	assert.equal(page, null);
});
