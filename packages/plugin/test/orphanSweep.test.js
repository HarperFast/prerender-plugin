import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The key-rule orphan sweep.
 *
 * The bug it exists for: a target's stored url IS the url-half of its cache key, and nothing
 * re-canonicalizes it. Change a `cacheKey.*` option and every target whose stored url is no
 * longer a fixed point of `canonicalizeUrl` keeps its schedule rows, keeps taking claim slots,
 * and renders forever into a key no request can produce. A sitemap refresh only UNLINKS it and
 * the canonical verdict calls it `self`, so nothing else cleans it up.
 *
 * The properties pinned here are the ones that make a DESTRUCTIVE sweep safe to run against a
 * live multi-node cluster: it only touches keys it owns, it never deletes a target whose render
 * is in flight, it never writes while the scan cursor is open, it reports the true population
 * even when the cap truncates the deletion, and a dry run deletes nothing.
 *
 * `isOrphanedByKeyRule` is deliberately NOT stubbed — the predicate is the whole point of the
 * tool, so these run it for real against the live `canonicalizeUrl`/route config. Urls are
 * chosen so the default config classifies them: `?page=` is the default `cacheKey.queryParams`
 * allowlist, so a url carrying an unlisted param is not a fixed point.
 */

/**
 * `orphanSweep.js` reaches `residency.js` and the schedule funnel, both of which touch Harper
 * globals at MODULE scope, so the stubs have to exist before the import — hence the dynamic
 * import in `beforeEach`. Same shape, and the same reason, as `reconcile.test.js`.
 */
const sabs = new Map();
const sharedBufferStub = {
	getUserSharedBuffer: (key, buffer) => {
		if (!sabs.has(key)) sabs.set(key, buffer);
		return sabs.get(key);
	},
	tryLock: () => true,
	unlock() {},
};

let orphanSweep;

beforeEach(async () => {
	globalThis.server = { hostname: 'node-a', nodes: [], config: { http: {} } };
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {} };
	globalThis.databases = { coordination: { SharedBuffer: { primaryStore: sharedBufferStub } } };
	orphanSweep = await import('../src/util/orphanSweep.js');
});

afterEach(() => {
	delete globalThis.server;
	delete globalThis.logger;
	delete globalThis.databases;
});

const DEVICES = ['desktop', 'mobile'];
const OWNED = 'this-node';

/** A url that survives canonicalization unchanged under the default config. */
const FIXED = 'https://example.com/a';
/** Not a fixed point: `foo` is not in the default `['page']` allowlist, so the key drops it. */
const ORPHAN_A = 'https://example.com/a?foo=1';
const ORPHAN_B = 'https://example.com/b?foo=2';

const run = (targets, overrides = {}) => {
	const deleted = [];
	const events = [];
	return orphanSweep
		.sweepOrphanedTargets({
			streamTargets: async function* () {
				for (const t of targets) {
					events.push(`read:${t.url}`);
					yield t;
				}
			},
			isLeased: () => false,
			deleteTarget: async (url) => {
				events.push(`delete:${url}`);
				deleted.push(url);
			},
			ownerOf: () => OWNED,
			hostname: OWNED,
			deviceTypes: DEVICES,
			maxDeletes: 100,
			...overrides,
		})
		.then((stats) => ({ stats, deleted, events }));
};

test('deletes only targets whose stored url is not a fixed point of canonicalizeUrl', async () => {
	const { stats, deleted } = await run([{ url: FIXED }, { url: ORPHAN_A }, { url: ORPHAN_B }]);

	assert.deepEqual(deleted, [ORPHAN_A, ORPHAN_B]);
	assert.equal(stats.examined, 3);
	assert.equal(stats.orphaned, 2);
	assert.equal(stats.deleted, 2);
	assert.equal(stats.truncated, false);
});

test('skips keys this node does not own — the lease check is only authoritative on the owner', async () => {
	const { stats, deleted } = await run([{ url: ORPHAN_A }, { url: ORPHAN_B }], {
		ownerOf: (url) => (url === ORPHAN_A ? OWNED : 'another-node'),
	});

	assert.deepEqual(deleted, [ORPHAN_A]);
	assert.equal(stats.examined, 2);
	assert.equal(stats.owned, 1);
	assert.equal(stats.orphaned, 1);
});

test('defers a target while ANY of its device keys is leased, and counts it as deferred', async () => {
	// Only the mobile key is out. The delete is per-url and takes every device key with it, so
	// the whole target has to wait — a per-device decision would delete the desktop row out from
	// under an in-flight mobile render.
	const { stats, deleted } = await run([{ url: ORPHAN_A }, { url: ORPHAN_B }], {
		isLeased: (cacheKey) => cacheKey === `${ORPHAN_A}|mobile`,
	});

	assert.deepEqual(deleted, [ORPHAN_B], 'the leased target is left for the next pass');
	assert.equal(stats.orphaned, 2);
	assert.equal(stats.leaseSkipped, 1);
	assert.equal(stats.deleted, 1);
	assert.equal(stats.truncated, false, 'a deferred target is not truncation — it was not dropped by the cap');
});

test('issues no delete while the scan cursor is open', async () => {
	// Harper aborts (and poisons) a transaction that stays open too long with writes pending, so
	// the two phases are a correctness property, not a style choice.
	const { events } = await run([{ url: ORPHAN_A }, { url: FIXED }, { url: ORPHAN_B }]);

	const firstDelete = events.findIndex((e) => e.startsWith('delete:'));
	const lastRead = events.map((e) => e.startsWith('read:')).lastIndexOf(true);
	assert.ok(firstDelete > lastRead, `expected every read before every delete, got ${events.join(' ')}`);
});

test('the cap bounds deletes but not the scan, and reports truncation', async () => {
	const { stats, deleted } = await run([{ url: ORPHAN_A }, { url: ORPHAN_B }], { maxDeletes: 1 });

	assert.equal(deleted.length, 1);
	assert.equal(stats.orphaned, 2, 'the scan runs to completion so the population is reported in full');
	assert.equal(stats.deleted, 1);
	assert.equal(stats.truncated, true);
});

test('a dry run counts the population and deletes nothing', async () => {
	const { stats, deleted } = await run([{ url: ORPHAN_A }, { url: ORPHAN_B }], { dryRun: true });

	assert.deepEqual(deleted, []);
	assert.equal(stats.orphaned, 2);
	assert.equal(stats.deleted, 2, 'reports what it WOULD have deleted');
	assert.equal(stats.dryRun, true);
});

test('a url that cannot be parsed is never treated as an orphan', async () => {
	// Malformed stored urls exist (crawler-invented junk). `canonicalizeUrl` throws on them, and
	// "I cannot tell" must not become "delete it" in a destructive sweep.
	const { stats, deleted } = await run([{ url: 'not a url at all' }, { url: '://///' }]);

	assert.deepEqual(deleted, []);
	assert.equal(stats.examined, 2);
	assert.equal(stats.orphaned, 0);
});
