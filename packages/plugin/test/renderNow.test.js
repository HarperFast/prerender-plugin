import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyOptions, config } from '../src/config.js';
import {
	isRenderNowAuthorized,
	wantsCacheSkip,
	resolveMissMode,
	pollForFreshRender,
	resolveServingPolicy,
} from '../src/util/renderNow.js';
import { PASSTHROUGH, PRERENDER, UNCLASSIFIED } from '../src/util/routeClass.js';

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

test('isRenderNowAuthorized fails CLOSED when no token is configured', () => {
	// Previously presence alone authorized here, which made an absent token an open door on a
	// path that takes public crawler traffic: any caller could skip the cache and force a
	// synchronous render occupying the request for up to timeoutMs. Enabling is now necessary
	// but not sufficient — without a token the levers are inert.
	applyOptions({ renderNow: { enabled: true } });
	assert.equal(config.renderNow.token, '');
	assert.equal(isRenderNowAuthorized(headersWith({ 'x-harper-render-now': 'anything' })), false);
	assert.equal(isRenderNowAuthorized(headersWith({ 'x-harper-render-now': '' })), false);
	assert.equal(isRenderNowAuthorized(headersWith({})), false);
});

test('an unresolved valueEnv leaves the levers inert, not open', () => {
	// The misconfiguration this exists for: config.js only assigns from the environment when the
	// variable is actually set, so a typo in the variable name leaves token at its empty default.
	// Under the old permissive reading that typo silently became an open door.
	delete process.env.RENDER_NOW_TOKEN_ABSENT;
	applyOptions({ renderNow: { enabled: true, valueEnv: 'RENDER_NOW_TOKEN_ABSENT' } });
	assert.equal(config.renderNow.token, '');
	assert.equal(isRenderNowAuthorized(headersWith({ 'x-harper-render-now': 'anything' })), false);
});

test('resolveServingPolicy grants no levers when the token is missing', () => {
	// The end-to-end consequence: a miss must proxy the origin as normal rather than forcing a
	// render, and Cache-Control must not be honored as a cache skip.
	applyOptions({ renderNow: { enabled: true, defaultMissMode: 'prerender' } });
	const policy = resolveServingPolicy(
		PRERENDER,
		'GET',
		headersWith({ 'x-harper-render-now': 'anything', 'cache-control': 'no-cache' })
	);
	assert.deepEqual(policy, { skipCache: false, missMode: 'origin' });
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

test('wantsCacheSkip is true for no-cache / no-store, false otherwise', () => {
	assert.equal(wantsCacheSkip(headersWith({ 'cache-control': 'no-cache' })), true);
	assert.equal(wantsCacheSkip(headersWith({ 'cache-control': 'no-store' })), true);
	assert.equal(wantsCacheSkip(headersWith({ 'cache-control': 'no-cache, no-store' })), true);
	// case-insensitive and tolerant of surrounding directives
	assert.equal(wantsCacheSkip(headersWith({ 'cache-control': 'public, No-Cache, max-age=0' })), true);
	// robust to spaces around '=' in a (malformed) directive
	assert.equal(wantsCacheSkip(headersWith({ 'cache-control': 'no-cache = foo' })), true);
	assert.equal(wantsCacheSkip(headersWith({ 'cache-control': 'max-age=0' })), false);
	assert.equal(wantsCacheSkip(headersWith({ 'cache-control': 'public, max-age=60' })), false);
	assert.equal(wantsCacheSkip(headersWith({})), false);
});

test('resolveMissMode reads the configured missHeader and falls back to the default', () => {
	applyOptions({ renderNow: { enabled: true, missHeader: 'x-miss', defaultMissMode: 'prerender' } });
	assert.equal(resolveMissMode(headersWith({ 'x-miss': 'prerender' })), 'prerender');
	assert.equal(resolveMissMode(headersWith({ 'x-miss': 'origin' })), 'origin');
	assert.equal(resolveMissMode(headersWith({ 'x-miss': 'ORIGIN' })), 'origin');
	// robust to surrounding whitespace
	assert.equal(resolveMissMode(headersWith({ 'x-miss': '  origin  ' })), 'origin');
	// absent / empty / unrecognized -> default
	assert.equal(resolveMissMode(headersWith({})), 'prerender');
	assert.equal(resolveMissMode(headersWith({ 'x-miss': '' })), 'prerender');
	assert.equal(resolveMissMode(headersWith({ 'x-miss': 'bogus' })), 'prerender');
});

test('resolveMissMode honors a configured default of origin', () => {
	applyOptions({ renderNow: { enabled: true, missHeader: 'x-miss', defaultMissMode: 'origin' } });
	assert.equal(resolveMissMode(headersWith({})), 'origin');
	assert.equal(resolveMissMode(headersWith({ 'x-miss': 'prerender' })), 'prerender');
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

// --- resolveServingPolicy: how the route class interacts with the on-demand levers ---

const authorizedOnDemand = () =>
	applyOptions({ renderNow: { enabled: true, token: 'secret', defaultMissMode: 'prerender' } });

test('resolveServingPolicy: a prerender path gets both on-demand levers', () => {
	authorizedOnDemand();
	const policy = resolveServingPolicy(
		PRERENDER,
		'GET',
		headersWith({ 'x-harper-render-now': 'secret', 'cache-control': 'no-cache' })
	);
	assert.deepEqual(policy, { skipCache: true, missMode: 'prerender' });
});

test('resolveServingPolicy: a non-prerender path never skips the cache or forces a render', () => {
	// The cache is still READ for these classes — that happens in the handler, and skipCache
	// false is what keeps it happening. What a non-prerender path cannot do is bypass the cache
	// or force a render for a URL that would never be stored.
	authorizedOnDemand();
	const headers = headersWith({ 'x-harper-render-now': 'secret', 'cache-control': 'no-cache' });
	for (const routeClass of [PASSTHROUGH, UNCLASSIFIED]) {
		assert.deepEqual(resolveServingPolicy(routeClass, 'GET', headers), { skipCache: false, missMode: 'origin' });
	}
});

test('resolveServingPolicy: the levers need an authorized GET', () => {
	authorizedOnDemand();
	const headers = headersWith({ 'x-harper-render-now': 'secret', 'cache-control': 'no-cache' });
	assert.deepEqual(resolveServingPolicy(PRERENDER, 'HEAD', headers), { skipCache: false, missMode: 'origin' });

	const unauthorized = headersWith({ 'x-harper-render-now': 'wrong', 'cache-control': 'no-cache' });
	assert.deepEqual(resolveServingPolicy(PRERENDER, 'GET', unauthorized), { skipCache: false, missMode: 'origin' });
});

test('resolveServingPolicy: an authorized GET without Cache-Control still warms on demand', () => {
	authorizedOnDemand();
	const policy = resolveServingPolicy(PRERENDER, 'GET', headersWith({ 'x-harper-render-now': 'secret' }));
	assert.deepEqual(policy, { skipCache: false, missMode: 'prerender' });
});
