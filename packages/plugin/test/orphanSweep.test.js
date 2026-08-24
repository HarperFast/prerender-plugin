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

// resources/Target.js (imported for the CASCADING delete) extends the raw table class and
// destructures PrerenderedPage at module scope, so the table stubs must be classes and must
// exist before the import.
class FakeTable {
	static async get() {}
	static async put() {}
	static async patch() {}
	static async delete() {}
	static search() {
		return [];
	}
}

beforeEach(async () => {
	globalThis.server = { hostname: 'node-a', nodes: [], config: { http: {} } };
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {} };
	globalThis.Resource = class {};
	globalThis.databases = {
		coordination: { SharedBuffer: { primaryStore: sharedBufferStub } },
		probe_state: { ProbeState: FakeTable },
		render_service: { Target: FakeTable },
		page_cache: { PrerenderedPage: FakeTable },
		render_schedule: { RenderSchedule: FakeTable },
	};
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

/**
 * The summary line. Split out from the runner because the branch had a bug that only shows up
 * in one state: every orphan deferred as in-flight.
 */
const statsOf = (over = {}) => ({
	examined: 10,
	owned: 5,
	orphaned: 0,
	leaseSkipped: 0,
	deleted: 0,
	truncated: false,
	dryRun: false,
	...over,
});

test('a pass whose orphans were ALL deferred still reports them', async () => {
	// truncated is `orphaned - leaseSkipped > deleted`, i.e. `0 > 0` = false here, and deleted is
	// 0 — so a condition written in terms of the deletion takes the quiet branch and claims there
	// are no orphans while three exist. That would tell an operator the cleanup is done when
	// nothing was cleaned.
	const { level, message } = orphanSweep.summarizeSweep(statsOf({ orphaned: 3, leaseSkipped: 3 }), 5000);

	assert.equal(level, 'warn');
	assert.match(message, /0 of 3 key-rule orphan\(s\)/);
	assert.match(message, /3 deferred as in-flight/);
	assert.doesNotMatch(message, /no key-rule orphans/);
});

test('a genuinely clean pass stays quiet', async () => {
	const { level, message } = orphanSweep.summarizeSweep(statsOf(), 5000);

	assert.equal(level, 'info');
	assert.match(message, /no key-rule orphans among 5 owned target\(s\)/);
});

test('a truncated pass names the cap so a short count is not read as "all clear"', async () => {
	const { level, message } = orphanSweep.summarizeSweep(
		statsOf({ orphaned: 9000, deleted: 5000, truncated: true }),
		5000
	);

	assert.equal(level, 'warn');
	assert.match(message, /5000 of 9000 key-rule orphan\(s\)/);
	assert.match(message, /5000-delete cap/);
});

test('a dry run says so in the line, so a census is never read as a deletion', async () => {
	const { message } = orphanSweep.summarizeSweep(statsOf({ orphaned: 2, deleted: 2, dryRun: true }), 5000);

	assert.match(message, /DRY RUN, nothing deleted/);
});
