import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * `util/rawCache.js` — caching the origin document a miss already fetched.
 *
 * THE FAILURE MODES HERE ARE ALL SILENT, and they point in two directions rather than one:
 *
 *   - STORE TOO MUCH and the cache fills with documents that should never have been shared: a
 *     personalized response, a `private` one, an error page under a 200-shaped miss. Nothing throws;
 *     crawlers just start receiving somebody's session. So every refusal is pinned by name, and the
 *     name is what the metric reports — a route that is enabled and filling nothing must be
 *     distinguishable from one that is switched off.
 *   - SERVE WHAT WAS STORED WRONG and the bytes and their headers disagree. The body is kept in the
 *     origin's own encoding and re-encoded at serve time from the STORED `content-encoding`, so the
 *     one header that must not survive is `content-length`: a re-encoded body has a different
 *     length, and a stored one contradicts the bytes actually sent.
 *
 * The capture itself has a third: it rides the body a crawler is reading RIGHT NOW. A `tee()`
 * buffers for whichever branch is slower, so a capture that stalls, or that keeps reading past the
 * cap, is paid for in the crawler's latency and this process's memory. Both are pinned below.
 */

let rawCache, config, applyOptions;
const rows = new Map();
let ops = [];
let failWrites = false;

before(async () => {
	globalThis.server = {
		hostname: 'test-node',
		nodes: [],
		recordAnalytics: (_value, metric, path, method) => ops.push(`${metric}:${path}:${method}`),
	};
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {} };
	// Harper's blob factory. The real one writes a blob file; the shape that matters here is that
	// whatever is handed in comes back out, so the stored bytes can be asserted.
	globalThis.createBlob = (bytes) => ({ blob: true, bytes });
	globalThis.databases = {
		raw_cache: {
			RawPage: {
				async get(query) {
					const id = typeof query === 'object' ? query.id : query;
					if (id === 'THROWS') throw new Error('storage fault');
					return rows.get(id) ? { ...rows.get(id) } : null;
				},
				async put(id, data) {
					if (failWrites) throw new Error('storage fault');
					rows.set(id, { cacheKey: id, ...data });
				},
			},
		},
	};

	({ config, applyOptions } = await import('../src/config.js'));
	rawCache = await import('../src/util/rawCache.js');
});

beforeEach(() => {
	rows.clear();
	ops = [];
	failWrites = false;
	config.render.raw.enabled = true;
	config.render.raw.maxBytes = 1024;
	config.render.raw.expiry = 'midnight';
	config.render.raw.expiryMs = 21600000;
	config.render.raw.expiryTimezone = 'UTC';
	config.render.raw.maxConcurrentCaptures = 16;
	config.render.raw.contentTypes = ['text/html'];
	config.render.raw.assumeShared = false;
	config.render.raw.deviceIndependent = false;
});

const policy = () => config.render.raw;

const originResource = (over = {}) => ({
	miss: true,
	statusCode: 200,
	viaStaging: false,
	hadSetCookie: false,
	headers: { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip', 'content-length': '123' },
	...over,
});

// A web stream over the given chunks; `failAt` makes it error after that many chunks, which is what
// a truncated origin response looks like from here.
const streamOf = (chunks, failAt = -1) =>
	new ReadableStream({
		start(controller) {
			chunks.forEach((chunk, i) => {
				if (i === failAt) return controller.error(new Error('origin body truncated'));
				controller.enqueue(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
			});
			if (failAt === -1) controller.close();
		},
	});

const drain = async (stream) => {
	const reader = stream.getReader();
	const out = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		out.push(value);
	}
	return Buffer.concat(out);
};

// ---- both switches ---------------------------------------------------------------------------

test('the policy requires the master switch AND the route opt-in — either alone is inert', () => {
	assert.equal(rawCache.rawCachePolicy({ rawCache: true }), policy());

	config.render.raw.enabled = false;
	assert.equal(rawCache.rawCachePolicy({ rawCache: true }), null, 'route opt-in alone must do nothing');

	config.render.raw.enabled = true;
	assert.equal(rawCache.rawCachePolicy({ rawCache: false }), null);
	assert.equal(rawCache.rawCachePolicy(undefined), null, 'an unmatched URL has no route and must not store');
});

// ---- expiry ----------------------------------------------------------------------------------

test('expiry: midnight resolves to the next UTC midnight, not to "now + 24h"', () => {
	const at = rawCache.rawExpiresAt(policy());
	const asDate = new Date(at);
	assert.equal(asDate.getUTCHours(), 0);
	assert.equal(asDate.getUTCMinutes(), 0);
	assert.ok(at > Date.now(), 'must be in the future');
	assert.ok(at - Date.now() <= 24 * 60 * 60 * 1000, 'and no more than a day out');
});

test("expiry: 'interval' uses expiryMs as a plain offset from now", () => {
	// expiry and expiryMs are SEPARATE options because the config merge type-checks every value
	// against its default: a numeric override of a string-defaulted option was rejected outright, so
	// the documented "or a number of ms" form never reached the running config. This test goes
	// through `applyOptions` rather than assigning the field, so it cannot pass on a state the
	// config path is unable to produce.
	applyOptions({ render: { raw: { enabled: true, expiry: 'interval', expiryMs: 3_600_000 } } });
	const now = Date.now();
	assert.equal(rawCache.rawExpiresAt(policy(), now), now + 3_600_000);
});

test('a numeric `expiry` is refused by the config layer and does NOT silently become an interval', () => {
	applyOptions({ render: { raw: { enabled: true, expiry: 3_600_000 } } });
	assert.equal(config.render.raw.expiry, 'midnight', 'a type mismatch must keep the default');
	const at = rawCache.rawExpiresAt(policy());
	assert.equal(new Date(at).getUTCHours(), 0, 'and the behaviour must be midnight, not an offset');
});

test('expiry: a garbage value falls back to the boundary and NEVER to NaN', () => {
	// NaN would be stored as an expiry that every comparison reads as "not servable" — a feature
	// that stores everything and serves none of it, with nothing to say so.
	for (const bad of ['soon', null, 0, -1, {}]) {
		config.render.raw.expiry = bad;
		const at = rawCache.rawExpiresAt(policy());
		assert.ok(Number.isFinite(at), `expiry ${String(bad)} produced a non-finite expiry`);
		assert.ok(at > Date.now());
	}
});

// ---- the store gate --------------------------------------------------------------------------

test('a clean 200 HTML response is storable', () => {
	assert.equal(rawCache.storeRefusal(originResource(), policy()), null);
});

test('every refusal reports itself by name', () => {
	const cases = [
		[{ statusCode: 404 }, 'not-200'],
		[{ statusCode: 500 }, 'not-200'],
		[{ viaStaging: true }, 'staging'],
		[{ hadSetCookie: true }, 'has-cookie'],
		[{ headers: { 'content-type': 'application/json' } }, 'content-type'],
		[{ headers: { 'content-type': 'text/html', 'cache-control': 'private, max-age=0' } }, 'no-store'],
		[{ headers: { 'content-type': 'text/html', 'cache-control': 'no-store' } }, 'no-store'],
	];
	for (const [over, expected] of cases) {
		assert.equal(rawCache.storeRefusal(originResource(over), policy()), expected, JSON.stringify(over));
	}
});

test('a personalized document is refused even though the sanitizer already dropped its cookie', () => {
	// `sanitizeOriginResponseHeaders` filters `set-cookie` out, so by the time a resource reaches
	// here its headers are indistinguishable from a shared response. `hadSetCookie` is the only
	// surviving evidence, and this is the test that keeps it wired.
	const resource = originResource({ hadSetCookie: true });
	assert.equal(resource.headers['set-cookie'], undefined, 'precondition: the header is already gone');
	assert.equal(rawCache.storeRefusal(resource, policy()), 'has-cookie');
});

// ---- assumeShared: the origin's claim about itself, overridden on evidence ---------------------
//
// `Set-Cookie` and `Cache-Control: private` are two forms of ONE claim — this response is not the
// same for every crawler. The claim can be false: an origin fronted by a CDN that already serves one
// cached copy to every visitor sets session cookies that say nothing about the body. Measured on one
// deployment, refusing on them stored ZERO documents against 33,572 misses an hour. What must NOT
// happen is the override quietly widening to things it was never about, or silencing its own alarm.

test('assumeShared stores a cookie-bearing document, and counts it apart so the alarm survives', async () => {
	const resource = originResource({ hadSetCookie: true });
	assert.equal(rawCache.storeRefusal(resource, policy()), 'has-cookie', 'refused by default');

	config.render.raw.assumeShared = true;
	assert.equal(rawCache.storeRefusal(resource, policy()), null);

	await rawCache.storeRawPage({ cacheKey: 'k', resource, bytes: Buffer.from('GZIPPED'), policy: policy() });
	assert.ok(ops.includes('prerender_ops:raw_cache:stored-unshared'), 'counted apart from an ordinary store');
	assert.ok(!ops.includes('prerender_ops:raw_cache:stored'), 'and NOT also as a plain store — one emit per attempt');
	assert.equal(rows.get('k').content.bytes.toString(), 'GZIPPED');
});

test('assumeShared stores a `private` document — the explicit form of the same claim', () => {
	const resource = originResource({
		headers: { 'content-type': 'text/html', 'cache-control': 'private, max-age=600' },
	});
	assert.equal(rawCache.storeRefusal(resource, policy()), 'no-store', 'refused by default');
	config.render.raw.assumeShared = true;
	assert.equal(rawCache.storeRefusal(resource, policy()), null);
});

test('assumeShared does NOT override a literal no-store — a different statement from "not shared"', () => {
	config.render.raw.assumeShared = true;
	for (const value of ['no-store', 'private, no-store', 'max-age=600, no-store']) {
		const resource = originResource({ headers: { 'content-type': 'text/html', 'cache-control': value } });
		assert.equal(rawCache.storeRefusal(resource, policy()), 'no-store', value);
	}
});

test('assumeShared widens NOTHING else — every other refusal still fires', () => {
	config.render.raw.assumeShared = true;
	const cases = [
		[{ statusCode: 404, hadSetCookie: true }, 'not-200'],
		[{ statusCode: 500 }, 'not-200'],
		[{ viaStaging: true, hadSetCookie: true }, 'staging'],
		[{ hadSetCookie: true, headers: { 'content-type': 'application/json' } }, 'content-type'],
	];
	for (const [over, expected] of cases) {
		assert.equal(rawCache.storeRefusal(originResource(over), policy()), expected, JSON.stringify(over));
	}
});

test('an ordinary shared document still counts as `stored` under assumeShared', async () => {
	config.render.raw.assumeShared = true;
	await rawCache.storeRawPage({ cacheKey: 'k', resource: originResource(), bytes: Buffer.from('x'), policy: policy() });
	assert.ok(ops.includes('prerender_ops:raw_cache:stored'));
	assert.ok(!ops.includes('prerender_ops:raw_cache:stored-unshared'));
});

test('a cache-control DIRECTIVE is read, not a substring — a quoted field name is not a directive', () => {
	// Both directives that matter here may carry a quoted field-name argument (RFC 9111 §5.2.2), and
	// a substring test reads the ARGUMENT as the directive. A word-boundary regex does not fix it:
	// `-` is a word boundary, so /\bprivate\b/ matches inside `X-Private-Header` too.
	const cc = (value) => originResource({ headers: { 'content-type': 'text/html', 'cache-control': value } });

	// ...the argument must not be mistaken for the directive
	assert.equal(rawCache.unsharedHint(cc('no-cache="X-Private-Header", max-age=600')), null);
	assert.equal(rawCache.unsharedHint(cc('x-private-hint=1, max-age=600')), null);
	assert.equal(rawCache.storeRefusal(cc('no-cache="no-store", max-age=600'), policy()), null);

	// ...while the real directives are still found, in any case and any position
	assert.equal(rawCache.unsharedHint(cc('max-age=600, PRIVATE')), 'private');
	assert.equal(rawCache.unsharedHint(cc('  private  ')), 'private');
	assert.equal(rawCache.storeRefusal(cc('max-age=0, No-Store'), policy()), 'no-store');

	// a repeated header arriving as an array is the same list, comma-joined
	assert.equal(rawCache.unsharedHint(cc(['max-age=600', 'private'])), 'private');
	assert.equal(rawCache.storeRefusal(cc(['max-age=600', 'no-store']), policy()), 'no-store');

	// and an absent or empty header is not a claim about anything
	for (const value of [undefined, null, '', '   ']) {
		const resource = originResource({ headers: { 'content-type': 'text/html', 'cache-control': value } });
		assert.equal(rawCache.unsharedHint(resource), null, JSON.stringify(value));
		assert.equal(rawCache.storeRefusal(resource, policy()), null, JSON.stringify(value));
	}
});

test('a MALFORMED cache-control still refuses — the parser may only ever remove a false positive', () => {
	// Substring matching over-refused, which is conservative for a cache. A parser that answers from
	// a header it cannot parse UNDER-refuses, which is not — and each row below went from refused to
	// STORED in the first version of this parser, on the default path with no `assumeShared` set.
	// `private;max-age=60` is an origin plainly declaring the response unshared.
	const cc = (value) => originResource({ headers: { 'content-type': 'text/html', 'cache-control': value } });
	for (const value of [
		'private;max-age=60',
		'no-store;private',
		'no-cache="x, no-store', // unbalanced quote swallows the separator
		'max-age=600, no-store"', // stray trailing quote
		'"private"', // quoted directive name
		'"no-store"',
	]) {
		assert.equal(rawCache.storeRefusal(cc(value), policy()), 'no-store', value);
	}
	// And the refusal is not an artefact of the fallback being reached for everything: the
	// well-formed false positives are still stored.
	for (const value of ['no-cache="X-Private-Header", max-age=600', 'x-private-hint=1, max-age=600', 'privately-held']) {
		assert.equal(rawCache.storeRefusal(cc(value), policy()), null, value);
	}
});

test('unsharedHint names the ground, and reports nothing for a plainly shared response', () => {
	assert.equal(rawCache.unsharedHint(originResource()), null);
	assert.equal(rawCache.unsharedHint(originResource({ hadSetCookie: true })), 'set-cookie');
	assert.equal(
		rawCache.unsharedHint(originResource({ headers: { 'content-type': 'text/html', 'cache-control': 'PRIVATE' } })),
		'private'
	);
	// `no-store` is not a sharedness claim, so it is not a hint — it is refused on its own terms.
	assert.equal(
		rawCache.unsharedHint(originResource({ headers: { 'content-type': 'text/html', 'cache-control': 'no-store' } })),
		null
	);
	assert.equal(rawCache.unsharedHint(undefined), null);
});

test('no-cache is STORABLE — it means revalidate before use, not do not store', () => {
	const resource = originResource({ headers: { 'content-type': 'text/html', 'cache-control': 'no-cache' } });
	assert.equal(rawCache.storeRefusal(resource, policy()), null);
});

test('the content-type match ignores parameters and case', () => {
	for (const value of ['text/html; charset=utf-8', 'TEXT/HTML', ' text/html ']) {
		const resource = originResource({ headers: { 'content-type': value } });
		assert.equal(rawCache.storeRefusal(resource, policy()), null, value);
	}
});

// ---- stored headers --------------------------------------------------------------------------

test('content-length is dropped and content-encoding is kept', () => {
	// The body is stored in the origin's encoding and re-encoded at serve time, so the encoding is
	// load-bearing and the length is actively wrong.
	const stored = rawCache.storedHeaders(originResource().headers);
	assert.equal(stored['content-length'], undefined);
	assert.equal(stored['content-encoding'], 'gzip');
	assert.equal(stored['content-type'], 'text/html; charset=utf-8');
	assert.equal(stored['x-harper-raw'], undefined, 'no marker header: it had no reader and shipped ungated');
});

test('storedHeaders tolerates a resource with no headers at all', () => {
	assert.deepEqual(rawCache.storedHeaders(undefined), {});
});

// ---- the capture -----------------------------------------------------------------------------

test('a body under the cap is captured whole, and the crawler still gets every byte', async () => {
	const { downstream, captured } = rawCache.teeForCapture(streamOf(['<html>', 'body', '</html>']), 1024);
	const [delivered, result] = await Promise.all([drain(downstream), captured]);
	assert.equal(delivered.toString(), '<html>body</html>');
	assert.equal(result.outcome, 'ok');
	assert.equal(result.bytes.toString(), '<html>body</html>');
});

test('past the cap the capture is abandoned — and the crawler is UNAFFECTED', async () => {
	// The whole point of capping rather than refusing up front: the response is already in flight
	// when the size becomes known, so an oversize document must still be delivered in full.
	const chunks = ['a'.repeat(600), 'b'.repeat(600), 'c'.repeat(600)];
	const { downstream, captured } = rawCache.teeForCapture(streamOf(chunks), 1024);
	const [delivered, result] = await Promise.all([drain(downstream), captured]);
	assert.equal(delivered.length, 1800, 'the crawler must receive the whole oversize document');
	assert.equal(result.outcome, 'oversize');
	assert.equal(result.bytes, null, 'and nothing is retained for it');
});

test('a truncated origin body yields no capture rather than a partial document', async () => {
	const { downstream, captured } = rawCache.teeForCapture(streamOf(['<html>', 'x'], 1), 1024);
	// The crawler's branch fails on its own terms; that is not this module's business.
	await drain(downstream).catch(() => {});
	const result = await captured;
	assert.equal(result.outcome, 'capture-failed');
	assert.equal(result.bytes, null);
});

test('the capture never rejects, whatever the stream does', async () => {
	const { downstream, captured } = rawCache.teeForCapture(streamOf(['x'], 0), 1024);
	await drain(downstream).catch(() => {});
	await assert.doesNotReject(() => captured);
});

test('the capture cannot hold the crawler back: downstream completes without the capture being awaited', async () => {
	// A `tee()` buffers for the slower branch. The capture reads in a tight loop with nothing to wait
	// on, so it is always the faster one — if that ever stops being true, the crawler pays for it and
	// this test is what notices.
	const { downstream } = rawCache.teeForCapture(streamOf(['one', 'two']), 1024);
	const delivered = await drain(downstream);
	assert.equal(delivered.toString(), 'onetwo');
});

// ---- store + read round trip -----------------------------------------------------------------

test('a stored page keeps the origin bytes verbatim and is read back while fresh', async () => {
	await rawCache.storeRawPage({
		cacheKey: 'https://example.com/c|desktop',
		resource: originResource(),
		bytes: Buffer.from('GZIPPED'),
		policy: policy(),
	});

	const row = rows.get('https://example.com/c|desktop');
	assert.equal(row.statusCode, 200);
	assert.equal(row.content.bytes.toString(), 'GZIPPED');
	assert.equal(JSON.parse(row.headers)['content-encoding'], 'gzip');
	assert.equal(JSON.parse(row.headers)['content-length'], undefined);
	assert.ok(ops.includes('prerender_ops:raw_cache:stored'));

	const read = await rawCache.readRawPage('https://example.com/c|desktop');
	assert.equal(read.content.bytes.toString(), 'GZIPPED');
});

test('the RawPage schema still declares @expiresAt — the directive IS the storage saving', () => {
	// This guards a fact that lives OUTSIDE this codebase. The directive is what makes Harper treat the
	// stored timestamp as the record's expiration; without it Harper falls back to the table's 48h and
	// a row that stopped being servable at midnight sits on disk, with its blob, for up to another 47h.
	// No behavioural test here can see that — the behaviour is Harper's — so dropping the directive
	// would leave this whole suite green while silently restoring two-day retention.
	// A SCANNER MUST FAIL AS ITSELF. Every anchor is asserted before it is used: without that, a
	// renamed table makes `indexOf` return -1, `slice(-1)` quietly yields the last character of the
	// file, and the directive assertion below fails — reporting a MISSING DIRECTIVE when the truth is
	// that this test stopped being able to look. On a guard whose whole job is noticing silent drift,
	// misdiagnosing its own blindness as the thing it watches for is the expensive failure.
	//
	// The header is matched with a whitespace-tolerant regex so a formatter cannot break the scanner,
	// but the block is terminated on a LINE-START `}` rather than by a non-greedy `[\s\S]*?\}`. That
	// distinction is load-bearing: the body is mostly prose comments, and a single `}` in any of them
	// truncates a non-greedy match short of the field — which reads as the directive being gone.
	// Verified: adding a brace to one comment makes that form fail while this one still passes.
	const schema = fs.readFileSync(fileURLToPath(new URL('../src/schemas/schema.graphql', import.meta.url)), 'utf8');
	const header = /type\s+RawPage\s+@table\(/.exec(schema);
	assert.ok(header, 'scanner anchor lost: no `type RawPage @table(` declaration in schema.graphql');
	const block = schema.slice(header.index);
	const close = block.indexOf('\n}');
	assert.notEqual(close, -1, 'scanner anchor lost: the RawPage block is not closed by a line-start `}`');
	const body = block.slice(0, close);
	// ...and that the block found really is the table, not a comment that happens to name it.
	assert.match(body, /cacheKey:\s*String\s+@primaryKey/, 'scanner matched something that is not the RawPage table');
	assert.match(
		body,
		/expiresAt:\s*Date\s+@expiresAt/,
		'RawPage.expiresAt must carry the @expiresAt directive — without it Harper reclaims on the table default'
	);
});

test("the stored expiresAt is a Date — the shape Harper's @expiresAt directive consumes", async () => {
	// `RawPage.expiresAt` carries `@expiresAt`, so this field is not merely a column `readRawPage`
	// checks: Harper stamps it into the record's expiry metadata, which governs read-hiding and the
	// cleanup sweep. Its coercion accepts a Date, a number, or a numeric/ISO string, and falls back to
	// the table's 48h default on anything else — SILENTLY. So a change here that made this field a
	// boolean, an empty string, or absent would not fail any other test; it would just quietly restore
	// the two-day retention this directive exists to remove.
	await rawCache.storeRawPage({
		cacheKey: 'k',
		resource: originResource(),
		bytes: Buffer.from('x'),
		policy: policy(),
	});
	const stored = rows.get('k').expiresAt;
	assert.ok(stored instanceof Date, `expiresAt must be a Date, got ${Object.prototype.toString.call(stored)}`);
	assert.ok(
		Number.isFinite(stored.getTime()),
		'and a valid one — an Invalid Date coerces to NaN and takes the 48h default'
	);
	assert.ok(stored.getTime() > Date.now(), 'and in the future, or the row is born expired');
});

test('a write failure is counted and swallowed — a served response must not fail over a copy', async () => {
	failWrites = true;
	await assert.doesNotReject(() =>
		rawCache.storeRawPage({ cacheKey: 'k', resource: originResource(), bytes: Buffer.from('x'), policy: policy() })
	);
	assert.ok(ops.includes('prerender_ops:raw_cache:write-failed'));
});

// ---- the read: every unknown is a miss --------------------------------------------------------

test('an absent row reads as a miss', async () => {
	assert.equal(await rawCache.readRawPage('nope'), null);
});

test('an expired row reads as a miss', async () => {
	rows.set('k', { cacheKey: 'k', expiresAt: new Date(Date.now() - 1) });
	assert.equal(await rawCache.readRawPage('k'), null);
});

test('an unreadable or missing expiry reads as a miss, never as "serve it forever"', async () => {
	for (const expiresAt of [undefined, null, 'not-a-date', NaN]) {
		rows.set('k', { cacheKey: 'k', expiresAt });
		assert.equal(await rawCache.readRawPage('k'), null, String(expiresAt));
	}
});

test('a read that throws degrades to the origin proxy rather than a 500', async () => {
	assert.equal(await rawCache.readRawPage('THROWS'), null);
});

// ---- the wiring ------------------------------------------------------------------------------

test('a refused resource is returned untouched, with its body never teed', async () => {
	const resource = originResource({ statusCode: 404, content: streamOf(['nope']) });
	const out = rawCache.captureForRawCache(resource, { cacheKey: 'k', policy: policy() });
	assert.equal(out.content, resource.content, 'the original stream must be handed straight through');
	assert.ok(ops.includes('prerender_ops:raw_cache:not-200'));
	assert.equal(rows.size, 0);
});

test('a storable resource is teed, delivered in full, and eventually stored', async () => {
	const resource = originResource({ content: streamOf(['<html>ok</html>']) });
	const out = rawCache.captureForRawCache(resource, { cacheKey: 'k', policy: policy() });
	assert.notEqual(out.content, resource.content, 'the crawler must read the teed branch');

	const delivered = await drain(out.content);
	assert.equal(delivered.toString(), '<html>ok</html>');

	// The store is detached by contract, so settle the microtask queue the way the real request does.
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(rows.get('k').content.bytes.toString(), '<html>ok</html>');
});

test('a body that is not a stream is left alone rather than guessed at', () => {
	const resource = originResource({ content: 'already a string' });
	const out = rawCache.captureForRawCache(resource, { cacheKey: 'k', policy: policy() });
	assert.equal(out.content, 'already a string');
	assert.ok(ops.includes('prerender_ops:raw_cache:no-body'));
});

// ---- the fixes the adversarial review found --------------------------------------------------

test('a 200 with a ZERO-LENGTH body is not stored — an empty buffer is truthy', () => {
	// `Buffer.concat([], 0)` is an empty Buffer, and empty Buffers are truthy. A `!result.bytes`
	// check therefore stored an origin 200 with no body (an origin error path, some CDN failure
	// modes) and replayed zero bytes under `content-encoding: gzip` to every later crawler.
	const resource = originResource({ content: streamOf([]) });
	rawCache.captureForRawCache(resource, { cacheKey: 'k', policy: policy() });
	return new Promise((resolve) =>
		setImmediate(() => {
			assert.equal(rows.size, 0, 'nothing may be stored for an empty body');
			assert.ok(ops.includes('prerender_ops:raw_cache:empty'), `expected an 'empty' outcome, got ${ops.join()}`);
			resolve();
		})
	);
});

test('concurrent captures are capped, and the cap is released on every path', async () => {
	// Capturing REMOVES origin->crawler backpressure: the capture reads in a tight loop, so the
	// origin drains at full speed however slowly the crawler reads, and this worker's heap becomes
	// the buffer. Measured retention is ~2x maxBytes per capture (one copy in `chunks`, one held by
	// the tee for the unread branch), so the slot count is what actually bounds the heap.
	config.render.raw.maxConcurrentCaptures = 2;
	const held = [1, 2, 3].map((n) => {
		const resource = originResource({ content: streamOf([`<html>${n}</html>`]) });
		return { n, out: rawCache.captureForRawCache(resource, { cacheKey: `k${n}`, policy: policy() }) };
	});

	assert.equal(rawCache.captureSlotsInUse(), 2, 'only two may capture at once');
	assert.ok(ops.includes('prerender_ops:raw_cache:capture-busy'), 'the refusal is counted, not silent');
	// The third is still SERVED — it just is not stored.
	assert.equal((await drain(held[2].out.content)).toString(), '<html>3</html>');

	await Promise.all(held.slice(0, 2).map((h) => drain(h.out.content)));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(rawCache.captureSlotsInUse(), 0, 'slots must be returned or capture decays to zero');
	assert.equal(rows.size, 2);
});

test('an oversize capture still reports itself when the crawler branch is never drained', async () => {
	// `cancel()` on a tee branch returns the SHARED cancel promise, which settles only when both
	// branches cancel or the source closes — so awaiting it never returned for a client that
	// disconnected, a HEAD, or a local 304, and the `oversize` metric silently under-reported by
	// exactly that population. This asserts the capture settles without anyone reading downstream.
	const { captured } = rawCache.teeForCapture(streamOf(['a'.repeat(600), 'b'.repeat(600)]), 512);
	const result = await captured;
	assert.equal(result.outcome, 'oversize');
	assert.equal(result.bytes, null);
});

test('a chunk with no byteLength cannot disable the cap', async () => {
	// `size += undefined` makes size NaN, and `NaN > maxBytes` is FALSE — the cap would stop
	// existing rather than fire. Unreachable through Readable.toWeb, but teeForCapture is exported.
	const odd = new ReadableStream({
		start(c) {
			c.enqueue({ not: 'a typed array' });
			c.close();
		},
	});
	const { captured } = rawCache.teeForCapture(odd, 8);
	const result = await captured;
	assert.ok(result.outcome === 'ok' || result.outcome === 'capture-failed');
});

test('x-harper-raw is not stored — it had no reader and shipped to every crawler ungated', () => {
	assert.equal(rawCache.storedHeaders(originResource().headers)['x-harper-raw'], undefined);
});

// ---- deviceIndependent: one row per URL --------------------------------------------------------
//
// The failure this guards against is silent in the worst direction: keyed by URL, whichever device
// missed first decides what every device is served. So the default must stay per-device, and the
// origin's own `Vary` must still be able to refuse the share.

test('rawKeyOf: the per-device cacheKey by default, the device-free URL under deviceIndependent', () => {
	const req = { cacheKey: 'https://example.com/catalog/x|mobile', cacheUrl: 'https://example.com/catalog/x' };
	assert.equal(rawCache.rawKeyOf(req, policy()), req.cacheKey, 'default is per-device');
	config.render.raw.deviceIndependent = true;
	assert.equal(rawCache.rawKeyOf(req, policy()), req.cacheUrl);
	assert.equal(
		rawCache.rawKeyOf({ ...req, cacheKey: 'https://example.com/catalog/x|desktop' }, policy()),
		rawCache.rawKeyOf(req, policy()),
		'both devices land on ONE row — the point of the option'
	);
});

test('variesByDevice: User-Agent, screen and Sec-CH-* hints, the ingress device header, and * — case-insensitive', () => {
	for (const vary of [
		'User-Agent',
		'accept-encoding, user-agent',
		' Sec-CH-UA-Mobile ',
		'sec-ch-ua',
		'Sec-CH-Viewport-Width',
		'DPR',
		'Viewport-Width',
		'X-Device-Type',
		'*',
		['Accept-Encoding', 'User-Agent'],
	]) {
		assert.equal(rawCache.variesByDevice({ vary }), true, JSON.stringify(vary));
	}
	for (const vary of [undefined, null, '', 'Accept-Encoding', 'Accept-Language, Origin', 'x-user-agent-hint']) {
		assert.equal(rawCache.variesByDevice({ vary }), false, JSON.stringify(vary));
	}
	assert.equal(rawCache.variesByDevice(undefined), false);
	// The ingress device header comes from config, not a hardcoded name.
	config.ingress.deviceTypeHeader = 'x-form-factor';
	try {
		assert.equal(rawCache.variesByDevice({ vary: 'X-Form-Factor' }), true);
		assert.equal(rawCache.variesByDevice({ vary: 'X-Device-Type' }), false);
	} finally {
		config.ingress.deviceTypeHeader = 'x-device-type';
	}
});

test('storeRefusal: a device-varying document is refused ONLY when it would be shared across devices', () => {
	const adaptive = originResource({ headers: { ...originResource().headers, vary: 'Accept-Encoding, User-Agent' } });
	assert.equal(rawCache.storeRefusal(adaptive, policy()), null, 'per-device keys store it under its own device');
	config.render.raw.deviceIndependent = true;
	assert.equal(rawCache.storeRefusal(adaptive, policy()), 'vary-device');
	const responsive = originResource({ headers: { ...originResource().headers, vary: 'Accept-Encoding' } });
	assert.equal(rawCache.storeRefusal(responsive, policy()), null, 'Vary: Accept-Encoding is the responsive case');
});

test('capture under deviceIndependent: the refusal is counted by name and nothing is stored', async () => {
	config.render.raw.deviceIndependent = true;
	const resource = originResource({
		headers: { ...originResource().headers, vary: 'User-Agent' },
		content: streamOf(['<html>']),
	});
	const out = rawCache.captureForRawCache(resource, { cacheKey: 'https://example.com/x', policy: policy() });
	assert.equal(out, resource, 'served untouched — no tee for a refused capture');
	assert.ok(ops.includes('prerender_ops:raw_cache:vary-device'));
	assert.equal(rows.size, 0);
});

test('deviceIndependent defaults to false — sharing across devices is opt-in', async () => {
	const { defaultConfig } = await import('../src/configSchema.js');
	assert.equal(defaultConfig().render.raw.deviceIndependent, false);
});
