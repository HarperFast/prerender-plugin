import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * `util/pageVerification.js` and the `resolveServeStatus` exemption it feeds.
 *
 * EVERY TEST HERE IS A FAIL-CLOSED TEST, because every failure mode of this feature is silent and
 * points the same way: a bug does not throw, it serves a page somebody deliberately invalidated,
 * while every serve metric reports success. So the contract pinned below is not "the exemption
 * works" — it is "the exemption is refused in each of the ways it can be wrong":
 *
 *   - a missing row, an unreadable timestamp, a read that throws, and the feature switched off all
 *     mean NOT VERIFIED. There is deliberately NO last-known-good cache, which is the opposite of
 *     `util/invalidation.js`: an unknown epoch means "probably nothing is invalidated" (fail open),
 *     an unknown verification means "I cannot prove this page is current" (fail closed).
 *   - a verification STRICTLY OLDER than the epoch does not exempt. `verifiedAt === epoch.at` must
 *     not qualify either: the epoch already carries `invalidation.pad`, whose entire job is to cover
 *     renders in flight across that instant.
 *   - the exemption is reported SEPARATELY (`exemptedBy`, cacheStatus `verified`) and only when it
 *     actually changed the outcome. A verification on a page that was servable anyway is not an
 *     exemption, and counting it as one turns the metric from "what is this buying" into "how many
 *     rows exist".
 */

const MINUTE = 60_000;

let pv, freshness, config;
const rows = new Map();
let reads = [];
let failReads = false;
let failWrites = false;
let ops = [];

before(async () => {
	globalThis.server = {
		hostname: 'test-node',
		nodes: [],
		recordAnalytics: (_p, metric, path, method) => ops.push(`${metric}:${path}:${method}`),
	};
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {} };
	globalThis.databases = {
		verification: {
			PageVerification: {
				async get(query) {
					const id = typeof query === 'object' ? query.id : query;
					reads.push(id);
					if (failReads) throw new Error('storage fault');
					const row = rows.get(id);
					if (!row) return null;
					const select = typeof query === 'object' ? query.select : undefined;
					if (Array.isArray(select)) return Object.fromEntries(select.map((n) => [n, row[n]]));
					return { ...row };
				},
				async put(id, data) {
					if (failWrites) throw new Error('storage fault');
					rows.set(id, { url: id, ...data });
				},
			},
		},
	};

	({ config } = await import('../src/config.js'));
	pv = await import('../src/util/pageVerification.js');
	freshness = await import('../src/util/pageFreshness.js');
});

beforeEach(() => {
	rows.clear();
	reads = [];
	ops = [];
	failReads = false;
	failWrites = false;
	config.invalidation.verification.enabled = true;
});

const URL_A = 'https://example.com/product/a';

// ---- the read: every unknown is a refusal ----------------------------------------------------

test('an absent row is NaN, not 0 — a missing verification must never read as "verified in 1970"', async () => {
	assert.ok(Number.isNaN(await pv.resolveVerification(URL_A)));
});

test('a null verifiedAt is NaN, not epoch 0', async () => {
	rows.set(URL_A, { url: URL_A, verifiedAt: null });
	assert.ok(Number.isNaN(await pv.resolveVerification(URL_A)));
});

test('a read that throws is NaN and is counted — never a throw onto a request that has an answer', async () => {
	failReads = true;
	assert.ok(Number.isNaN(await pv.resolveVerification(URL_A)));
	assert.ok(ops.some((o) => o === 'prerender_ops:page_verification:read-error'));
});

test('disabled reads nothing at all — the feature is inert, not merely ignored', async () => {
	config.invalidation.verification.enabled = false;
	rows.set(URL_A, { url: URL_A, verifiedAt: new Date() });
	assert.ok(Number.isNaN(await pv.resolveVerification(URL_A)));
	assert.equal(reads.length, 0, 'a disabled feature must not pay a storage read');
});

test('there is NO last-known-good: a second failing read after a good one is still NaN', async () => {
	rows.set(URL_A, { url: URL_A, verifiedAt: new Date() });
	assert.ok(Number.isFinite(await pv.resolveVerification(URL_A)));
	failReads = true;
	assert.ok(
		Number.isNaN(await pv.resolveVerification(URL_A)),
		'unlike invalidation, an unknown verification must not fall back to a remembered value'
	);
});

// ---- the write --------------------------------------------------------------------------------

test('a write records verifiedAt and is counted', async () => {
	await pv.writeVerification(URL_A);
	assert.ok(Number.isFinite(new Date(rows.get(URL_A).verifiedAt).getTime()));
	assert.ok(ops.includes('prerender_ops:page_verification:written'));
});

test('a failed write is swallowed and counted — it costs a page one cycle, never the probe pass', async () => {
	failWrites = true;
	await pv.writeVerification(URL_A);
	assert.ok(ops.includes('prerender_ops:page_verification:write-error'));
});

// ---- the exemption in resolveServeStatus -------------------------------------------------------

const serve = (over = {}) =>
	freshness.resolveServeStatus({
		expiresAtMs: 10_000,
		lastCachedMs: 1_000,
		swrTtl: MINUTE,
		now: 5_000,
		epoch: { scope: 'route:prefix:/product/', at: 2_000 },
		...over,
	});

test('without a verification the page is still invalidated', () => {
	const r = serve();
	assert.equal(r.status, 'invalidated');
	assert.equal(r.servable, false);
	assert.equal(r.exemptedBy, null);
});

test('a verification AFTER the epoch exempts the page and reports what did it', () => {
	const r = serve({ verifiedAtMs: 3_000 });
	assert.equal(r.servable, true);
	assert.equal(r.status, 'hit', 'the underlying freshness verdict is unchanged');
	assert.equal(r.invalidatedBy, null);
	assert.deepEqual(r.exemptedBy, { scope: 'route:prefix:/product/', at: 3_000 });
});

test('a verification BEFORE the epoch does not exempt', () => {
	assert.equal(serve({ verifiedAtMs: 1_500 }).status, 'invalidated');
});

test('verifiedAt EQUAL to the epoch does not exempt — the epoch already carries invalidation.pad', () => {
	const r = serve({ verifiedAtMs: 2_000 });
	assert.equal(r.status, 'invalidated', 'strict >, so the pad window is not silently given away');
});

test('a NaN verification fails closed', () => {
	assert.equal(serve({ verifiedAtMs: NaN }).status, 'invalidated');
});

test('omitting verifiedAtMs entirely fails closed — the default is the pre-feature answer', () => {
	assert.equal(serve().status, 'invalidated');
});

test('a page that was servable anyway is NOT reported as exempted', () => {
	// lastCached is already past the epoch, so nothing was refused and nothing was rescued.
	const r = serve({ lastCachedMs: 4_000, verifiedAtMs: 4_500 });
	assert.equal(r.servable, true);
	assert.equal(r.exemptedBy, null, 'an exemption that changed no outcome must not be counted');
});

test('a verification cannot resurrect a page past its SWR window', () => {
	// expiresAt + swrTtl is behind `now`: base is null, so there is no serve to rescue.
	const r = serve({ expiresAtMs: 1_000, now: 10 * MINUTE, verifiedAtMs: 9 * MINUTE });
	assert.equal(r.servable, false);
	assert.equal(r.status, null, 'stale is stale — verification answers currency, not lifetime');
	assert.equal(r.exemptedBy, null);
});

test('with no epoch at all, a verification changes nothing', () => {
	const r = serve({ epoch: null, verifiedAtMs: 9_000 });
	assert.equal(r.status, 'hit');
	assert.equal(r.exemptedBy, null);
});
