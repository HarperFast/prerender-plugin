import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySubresponse, emptyTally, tallySubresponse } from '../dist/subrequests.js';

// The shared-cache verdict behind the per-page factor `k` (HarperFast/prerender-plugin#153).
//
// The rules are RFC 9111's for a SHARED cache, and the three-way split is the point: an explicit
// "reaches the origin" is counted as origin load, explicit freshness is not, and a response with
// no freshness information is neither — its fate is the CDN's default TTL, which this process
// cannot see, so guessing either way would put a made-up number on the offload figure.

const ok = (headers: Record<string, string> = {}) => classifySubresponse('GET', 200, headers);

test('a non-GET is origin load whatever the response says — that is what an API call is', () => {
	assert.equal(classifySubresponse('POST', 200, { 'cache-control': 'public, max-age=3600' }), 'uncacheable');
	assert.equal(classifySubresponse('PUT', 200, {}), 'uncacheable');
	assert.equal(classifySubresponse('HEAD', 200, { 'cache-control': 'max-age=60' }), 'cacheable');
});

test('a status a cache may not store reached the origin and will again', () => {
	for (const status of [500, 502, 503, 401, 403, 429, 302, 307]) {
		assert.equal(classifySubresponse('GET', status, { 'cache-control': 'max-age=60' }), 'uncacheable', String(status));
	}
	// The heuristically cacheable set is judged on its headers like a 200.
	assert.equal(classifySubresponse('GET', 404, { 'cache-control': 'max-age=60' }), 'cacheable');
	assert.equal(classifySubresponse('GET', 301, {}), 'unspecified');
});

test('Set-Cookie, no-store, private and no-cache each mean the origin answers every time', () => {
	assert.equal(ok({ 'set-cookie': 'sid=1', 'cache-control': 'max-age=3600' }), 'uncacheable');
	assert.equal(ok({ 'cache-control': 'no-store' }), 'uncacheable');
	assert.equal(ok({ 'cache-control': 'private, max-age=600' }), 'uncacheable');
	// no-cache is "revalidate before use": a conditional request to the origin per use.
	assert.equal(ok({ 'cache-control': 'no-cache' }), 'uncacheable');
	assert.equal(ok({ 'cache-control': 'public, no-cache="set-cookie"' }), 'uncacheable');
	assert.equal(ok({ vary: '*' }), 'uncacheable');
});

test('a directive is matched as a token, never as a substring of another', () => {
	// "private" inside a made-up extension must not trip the private rule; the real max-age wins.
	assert.equal(ok({ 'cache-control': 'x-privateer=1, max-age=60' }), 'cacheable');
	// "no-cache-ish" is not "no-cache".
	assert.equal(ok({ 'cache-control': 'no-cache-ish, max-age=60' }), 'cacheable');
});

test('s-maxage wins over max-age for a shared cache, and zero is stale on arrival', () => {
	assert.equal(ok({ 'cache-control': 'max-age=0, s-maxage=600' }), 'cacheable');
	assert.equal(ok({ 'cache-control': 'max-age=600, s-maxage=0' }), 'uncacheable');
	assert.equal(ok({ 'cache-control': 'max-age=0' }), 'uncacheable');
	assert.equal(ok({ 'cache-control': 'public, max-age=31536000, immutable' }), 'cacheable');
});

test('Expires is read against the origin clock, and an unparseable one is already expired', () => {
	assert.equal(ok({ expires: 'Thu, 01 Jan 2099 00:00:00 GMT' }), 'cacheable');
	assert.equal(ok({ expires: 'Thu, 01 Jan 1970 00:00:00 GMT' }), 'uncacheable');
	assert.equal(ok({ expires: '0' }), 'uncacheable');
	assert.equal(ok({ expires: '-1' }), 'uncacheable');
	// A clock-skewed origin: Expires one hour after ITS Date header is fresh whatever our clock says.
	assert.equal(ok({ date: 'Thu, 01 Jan 2015 00:00:00 GMT', expires: 'Thu, 01 Jan 2015 01:00:00 GMT' }), 'cacheable');
	// Cache-Control freshness outranks Expires.
	assert.equal(ok({ 'cache-control': 'max-age=0', 'expires': 'Thu, 01 Jan 2099 00:00:00 GMT' }), 'uncacheable');
});

test('no freshness information is UNSPECIFIED — not a guess in either direction', () => {
	assert.equal(ok({}), 'unspecified');
	assert.equal(
		ok({ 'content-type': 'application/json', 'last-modified': 'Thu, 01 Jan 2015 00:00:00 GMT' }),
		'unspecified'
	);
	assert.equal(ok({ 'cache-control': 'public' }), 'unspecified');
	assert.equal(ok({ vary: 'accept-encoding, accept' }), 'unspecified');
});

test('the tally counts every same-origin response once, and a replay from our own cache as cacheable', () => {
	const tally = emptyTally();
	tallySubresponse(tally, 'GET', 200, { 'cache-control': 'max-age=60' });
	tallySubresponse(tally, 'POST', 200, {});
	tallySubresponse(tally, 'GET', 200, {});
	// Replayed headers have been through filterReplayHeaders; the verdict must not depend on them.
	tallySubresponse(tally, 'GET', 200, {}, { replayedFromOwnCache: true });
	assert.deepEqual(tally, { sameOrigin: 4, cacheable: 2, uncacheable: 1, unspecified: 1, blocked: 0 });
});
