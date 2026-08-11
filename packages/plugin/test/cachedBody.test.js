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
