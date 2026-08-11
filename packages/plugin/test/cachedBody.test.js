import { test, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * materializeCachedBody — reading a cached page's body BEFORE the response commits a status.
 *
 * The defect this closes (prerender-plugin#75, cause harper#2134): a `PrerenderedPage` record
 * whose blob file has been unlinked used to be discovered only once the body was already
 * streaming — after the 200, the headers and the `bot_serve` cache-hit row were all committed.
 * The crawler received a truncated document under a success status, and nothing in the metrics
 * or the status codes showed it. Measured at ~4,580/day on a 4-node production cluster.
 *
 * Reading up front means an unreadable blob becomes an ordinary origin serve instead. Buffering
 * is affordable because of the measured size distribution of this corpus — mean 223 KB, p99
 * 322 KB, hard max 420 KB, no tail, and a full cold read is p50 0.75 ms on the libuv threadpool
 * (never the event loop). Revisit if page bodies ever grow unbounded.
 */

let materializeCachedBody;

before(async () => {
	globalThis.Resource = class {};
	globalThis.server = { hostname: 'test-node', nodes: [], config: { http: { port: 9926 } }, recordAnalytics() {} };
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {} };
	globalThis.databases = {
		coordination: {
			SharedBuffer: {
				primaryStore: { getUserSharedBuffer: (_key, buf) => buf, tryLock: () => true, unlock() {} },
			},
		},
		render_service: { Target: class {}, QueueControl: class {} },
		render_schedule: { RenderSchedule: class {} },
		page_cache: { PrerenderedPage: class {} },
	};
	({ materializeCachedBody } = await import('../src/http_handlers/bot_request.js'));
});

// Stand-in for Harper's cached-content Blob: `bytes()` resolves the body or rejects the way a
// missing file does (`BlobReadError: Blob file not found for …`).
const blobOf = (value) => ({ bytes: async () => (value instanceof Error ? Promise.reject(value) : value) });

// A blob whose read never settles within the test's lifetime — stands in for the real failure:
// a body still arriving from a base copy, which puts Harper's reader into an incomplete-content
// retry loop bounded only by `storage_blobReadTimeout` (20s).
const stuckBlob = () => ({ bytes: () => new Promise(() => {}) });

// A blob that resolves after `ms`, to prove the budget is a deadline and not a fixed delay.
const slowBlob = (ms, value) => ({
	bytes: () => new Promise((resolve) => setTimeout(() => resolve(value), ms).unref()),
});

test('a readable blob yields its bytes', async () => {
	const res = await materializeCachedBody({ content: blobOf(Buffer.from('CACHED')) }, 'GET');
	assert.equal(res.ok, true);
	assert.equal(res.body.toString(), 'CACHED');
});

test('an unreadable blob reports failure with the error, and no bytes', async () => {
	const error = new Error('Blob file not found for /home/harperdb/harper/blobs/page_cache/0/abc/def');
	const res = await materializeCachedBody({ content: blobOf(error) }, 'GET');
	assert.equal(res.ok, false);
	assert.equal(res.body, undefined);
	assert.equal(res.error, error, 'the caller logs this to distinguish ENOENT from a transient fault');
});

test('HEAD never reads the blob — it sends no body, so it cannot be truncated', async () => {
	let read = 0;
	const content = {
		bytes: async () => {
			read++;
			return Buffer.from('X');
		},
	};
	const res = await materializeCachedBody({ content }, 'HEAD');
	assert.equal(res.ok, true);
	assert.equal(res.body, undefined);
	assert.equal(read, 0, 'a HEAD must not pay for a read it will not send');
});

test('a page with no content is servable with an empty body, not a failure', async () => {
	for (const page of [{}, { content: null }, { content: undefined }, null, undefined]) {
		const res = await materializeCachedBody(page, 'GET');
		assert.equal(res.ok, true, `expected ok for ${JSON.stringify(page)}`);
		assert.equal(res.body, undefined);
	}
});

test('a non-Blob body passes straight through without a read', async () => {
	// Keeps plain-string fixtures working, and covers any path that stores content inline
	// rather than as a Blob — neither can fail mid-stream, so neither needs materializing.
	const res = await materializeCachedBody({ content: 'INLINE-HTML' }, 'GET');
	assert.equal(res.ok, true);
	assert.equal(res.body, 'INLINE-HTML');
});

test('a rejection is captured, never thrown — the serve path must stay on its feet', async () => {
	// If this threw, handleBotRequest's catch would turn a recoverable dangling blob into a 500
	// for a crawler, which is worse than the truncated 200 it replaces.
	await assert.doesNotReject(() => materializeCachedBody({ content: blobOf(new Error('boom')) }, 'GET'));
});

// ── the read budget (page.blobReadBudgetMs) ────────────────────────────────────────────────
// Regression cover for the tail-latency regression 0.40.0 introduced: reading the body before
// committing a status is correct, but without a bound the request inherits Harper's 20s
// storage_blobReadTimeout. Measured in production mid-copy: a cohort of 88 cache hits averaging
// 13.6s (p95 17.5s) on one node, while its median hit was 2.3ms.

test('a stuck read gives up at the budget and reports a timeout, not an unreadable blob', async () => {
	const t0 = Date.now();
	const res = await materializeCachedBody({ content: stuckBlob() }, 'GET', 40);
	const elapsed = Date.now() - t0;
	assert.equal(res.ok, false);
	assert.equal(res.reason, 'timeout', 'must be distinguishable from a dangling blob');
	assert.equal(res.error, undefined, 'a timeout has no exception to report');
	assert.ok(elapsed < 1000, `expected to give up promptly, took ${elapsed}ms`);
});

test('a read that finishes inside the budget is unaffected', async () => {
	const res = await materializeCachedBody({ content: slowBlob(5, Buffer.from('IN-TIME')) }, 'GET', 500);
	assert.equal(res.ok, true);
	assert.equal(res.body.toString(), 'IN-TIME');
	assert.equal(res.reason, undefined);
});

test('budget 0 disables the bound (explicit opt-out, not an accidental zero-timeout)', async () => {
	const res = await materializeCachedBody({ content: slowBlob(5, Buffer.from('UNBOUNDED')) }, 'GET', 0);
	assert.equal(res.ok, true);
	assert.equal(res.body.toString(), 'UNBOUNDED');
});

test('an unreadable blob still reports reason=unreadable with its error, budget or not', async () => {
	const error = new Error('Blob file not found for /home/harperdb/harper/blobs/page_cache/0/abc/def');
	const res = await materializeCachedBody({ content: blobOf(error) }, 'GET', 500);
	assert.equal(res.ok, false);
	assert.equal(res.reason, 'unreadable');
	assert.equal(res.error, error);
});

test('a rejection arriving AFTER the budget expired does not become an unhandled rejection', async () => {
	// The losing side of the race is still in flight. If its rejection were left unhandled it would
	// surface long after we already answered the request, and on some configs take the process down.
	let seen = null;
	const onUnhandled = (e) => {
		seen = e;
	};
	process.on('unhandledRejection', onUnhandled);
	const late = { bytes: () => new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 20).unref()) };
	const res = await materializeCachedBody({ content: late }, 'GET', 5);
	assert.equal(res.reason, 'timeout');
	await new Promise((r) => setTimeout(r, 60));
	process.off('unhandledRejection', onUnhandled);
	assert.equal(seen, null, "the abandoned read's rejection must be swallowed");
});

test('HEAD skips the read entirely, so the budget can never apply to it', async () => {
	const res = await materializeCachedBody({ content: stuckBlob() }, 'HEAD', 5);
	assert.equal(res.ok, true);
	assert.equal(res.body, undefined);
});
