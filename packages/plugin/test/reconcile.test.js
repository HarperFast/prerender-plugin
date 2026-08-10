import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The schedule-gap repair sweep.
 *
 * The bug it exists for: `Target` and `RenderSchedule` are separate databases, so a target is
 * one commit plus one schedule commit PER DEVICE, and the set can be left half-written. For a
 * URL that is not in a sitemap, NOTHING re-creates a missing schedule — the bot-traffic path
 * is gated on the target not existing, and `processJobResult` needs a claim that can never
 * happen. The URL (or one device of it) goes dark permanently and silently.
 *
 * The properties pinned here are the ones that make the sweep safe to run against a live
 * multi-node cluster with a million targets: it only ever asks about keys it OWNS (a
 * cross-node read of a residency-pinned row takes Harper's untimed replication fetch), it
 * checks every configured device independently (a half-scheduled URL is just as silent), it
 * pages so no read transaction stays open across writes, it restores with the JITTERED time
 * rather than "now", and its write cap reports truncation instead of quietly covering less
 * than it claims.
 */

let reconcile;

/**
 * The named cross-worker shared buffers, keyed. `reconcile.js` reaches the schedule funnel — the
 * only module allowed to write RenderSchedule — which acquires the render-lease buffer at MODULE
 * SCOPE, so this stub has to exist before the import or the whole file fails in `beforeEach`.
 *
 * KEYED, not "return whatever was passed": an unkeyed fake hands every acquisition its own freshly
 * zeroed buffer, so nothing ever sees anything anyone else wrote and the tests pass for the wrong
 * reason.
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

beforeEach(async () => {
	globalThis.server = { hostname: 'node-a', nodes: [], config: { http: {} } };
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {} };
	globalThis.databases = { coordination: { SharedBuffer: { primaryStore: sharedBufferStub } } };
	reconcile = await import('../src/util/reconcile.js');
});

afterEach(() => {
	delete globalThis.server;
	delete globalThis.logger;
	delete globalThis.databases;
});

/**
 * A fake registry. `owners` maps a URL to its owning node so a test can place rows on either
 * side of the residency boundary; `schedules` is the set of cacheKeys that HAVE a row.
 */
const harness = ({
	targets,
	owners = {},
	schedules = [],
	hostname = 'node-a',
	deviceTypes = ['desktop'],
	maxRestores = 100,
}) => {
	const scheduleSet = new Set(schedules);
	const puts = [];
	const scheduleReads = [];
	let scanOpen = false;
	const writesWhileScanOpen = [];

	// A live async iterator, like the real `search`. `scanOpen` tracks whether its cursor is
	// still being consumed, so a write issued mid-scan is caught rather than merely discouraged.
	const streamTargets = () =>
		(async function* () {
			scanOpen = true;
			try {
				for (const target of targets) yield target;
			} finally {
				scanOpen = false;
			}
		})();

	return {
		puts,
		scheduleReads,
		writesWhileScanOpen,
		run: (overrides = {}) =>
			reconcile.reconcileSchedules({
				streamTargets,
				getSchedule: async (cacheKey) => {
					scheduleReads.push(cacheKey);
					return scheduleSet.has(cacheKey) ? { cacheKey } : null;
				},
				putSchedule: async (cacheKey, row) => {
					if (scanOpen) writesWhileScanOpen.push(cacheKey);
					puts.push({ cacheKey, ...row });
					scheduleSet.add(cacheKey);
				},
				ownerOf: (url) => owners[url] ?? 'node-a',
				hostname,
				deviceTypes,
				maxRestores,
				...overrides,
			}),
	};
};

test('a target missing its schedule row gets one restored', async () => {
	const h = harness({
		targets: [{ url: 'https://x/a', renderInterval: 60000, sitemapUrl: null }],
	});

	const stats = await h.run();

	assert.equal(stats.restored, 1);
	assert.equal(h.puts.length, 1);
	assert.equal(h.puts[0].cacheKey, 'https://x/a|desktop');
});

test('a target that already has a schedule row is left alone', async () => {
	const h = harness({
		targets: [{ url: 'https://x/a', renderInterval: 60000 }],
		schedules: ['https://x/a|desktop'],
	});

	const stats = await h.run();

	assert.equal(stats.restored, 0);
	assert.equal(h.puts.length, 0);
});

test('every configured device is checked, and only the missing one is restored', async () => {
	// One URL row implies one schedule row PER device. A half-scheduled URL — desktop present,
	// mobile missing — is exactly as silent as a fully missing one and must be repaired
	// without disturbing the sibling that is fine.
	const h = harness({
		targets: [{ url: 'https://x/a', renderInterval: 60000 }],
		deviceTypes: ['desktop', 'mobile'],
		schedules: ['https://x/a|desktop'],
	});

	const stats = await h.run();

	assert.deepEqual(h.scheduleReads.sort(), ['https://x/a|desktop', 'https://x/a|mobile']);
	assert.equal(stats.missing, 1);
	assert.deepEqual(
		h.puts.map((p) => p.cacheKey),
		['https://x/a|mobile']
	);
});

test('keys owned by another node are never even asked about', async () => {
	// This is the safety property, not an optimization: a point read for a residency-pinned row
	// this node does not own takes Harper's replication fetch, which has no timeout — one such
	// read would hang the whole sweep.
	const h = harness({
		targets: [
			{ url: 'https://x/mine', renderInterval: 60000 },
			{ url: 'https://x/theirs', renderInterval: 60000 },
		],
		owners: { 'https://x/mine': 'node-a', 'https://x/theirs': 'node-b' },
	});

	const stats = await h.run();

	assert.equal(stats.examined, 2);
	assert.equal(stats.owned, 1);
	assert.deepEqual(h.scheduleReads, ['https://x/mine|desktop']);
	assert.deepEqual(
		h.puts.map((p) => p.cacheKey),
		['https://x/mine|desktop']
	);
});

test('residency is asked once per URL, and both device rows live with that owner', async () => {
	// RenderSchedule.setResidencyById hashes the URL half of the cacheKey, so the same URL on
	// two device types lands on the SAME node — one ownership answer covers the whole fan-out.
	const seen = [];
	const h = harness({
		targets: [{ url: 'https://x/a', renderInterval: 60000 }],
		deviceTypes: ['desktop', 'mobile'],
	});

	await h.run({
		ownerOf: (url) => {
			seen.push(url);
			return 'node-a';
		},
	});

	assert.deepEqual(seen, ['https://x/a']);
	assert.deepEqual(h.scheduleReads.sort(), ['https://x/a|desktop', 'https://x/a|mobile']);
});

test('restores at the jittered initial time, not now', async () => {
	// A repair pass can restore a great many rows at once; scheduling them all immediately
	// would trade a silent outage for a render herd.
	const interval = 60 * 60 * 1000;
	const before = Date.now();
	const h = harness({
		targets: [
			{ url: 'https://x/a', renderInterval: interval },
			{ url: 'https://x/b', renderInterval: interval },
			{ url: 'https://x/c', renderInterval: interval },
		],
	});

	await h.run();

	const times = h.puts.map((p) => p.nextRenderTime);
	for (const at of times) {
		assert.ok(Number.isFinite(at), 'nextRenderTime must be a finite number, not a Date or BigInt');
		assert.ok(at >= before - 60000 && at <= before + interval, `${at} outside [now, now+interval)`);
	}
	// Keyed off the cacheKey, so distinct keys spread rather than stacking on one instant.
	assert.ok(new Set(times).size > 1, 'restored rows should not all share one render time');
});

test('a BigInt renderInterval still produces a usable time', async () => {
	// `renderInterval` is a `Long`, which can arrive as BigInt — and `Number.isFinite(1n)` is
	// false, so an uncoerced value would silently fall through to the default interval.
	const h = harness({
		targets: [{ url: 'https://x/a', renderInterval: 3600000n }],
	});

	await h.run();

	assert.equal(h.puts.length, 1);
	assert.ok(Number.isFinite(h.puts[0].nextRenderTime));
});

test('fromSitemap is carried over from the target', async () => {
	// Denormalized onto the schedule so `claim` needs no cross-database read; restoring it as
	// `false` would mislabel every repaired sitemap job.
	const h = harness({
		targets: [
			{ url: 'https://x/a', sitemapUrl: 'https://x/sitemap.xml' },
			{ url: 'https://x/b', sitemapUrl: null },
		],
	});

	await h.run();

	assert.equal(h.puts.find((p) => p.cacheKey === 'https://x/a|desktop').fromSitemap, true);
	assert.equal(h.puts.find((p) => p.cacheKey === 'https://x/b|desktop').fromSitemap, false);
});

test('the walk pages through every target rather than stopping at the first batch', async () => {
	const targets = Array.from({ length: 7 }, (_, i) => ({
		url: `https://x/${i}`,
		renderInterval: 60000,
	}));
	const h = harness({ targets });

	const stats = await h.run();

	assert.equal(stats.examined, 7);
	assert.equal(stats.restored, 7);
});

test('no write is issued while the scan is still open', async () => {
	// Structural, not incidental: every restore happens in a second phase after the scan has
	// finished. Interleaving them would hold the read transaction across the writes and pin the
	// log against reclamation — the same reason `claim` drains before leasing.
	const targets = Array.from({ length: 5 }, (_, i) => ({
		url: `https://x/${i}`,
		renderInterval: 60000,
	}));
	const h = harness({ targets });

	await h.run();

	assert.deepEqual(h.writesWhileScanOpen, []);
});

test('the restore cap bounds writes but still measures the whole gap', async () => {
	const targets = Array.from({ length: 10 }, (_, i) => ({
		url: `https://x/${i}`,
		renderInterval: 60000,
	}));
	const h = harness({ targets, maxRestores: 4 });

	const stats = await h.run();

	assert.equal(stats.restored, 4);
	assert.equal(h.puts.length, 4);
	// The scan still runs to completion, so the true size of the gap is reported even though
	// only part of it was repaired. A short count that reads as "all clear" is the failure mode.
	assert.equal(stats.examined, 10);
	assert.equal(stats.missing, 10);
	assert.equal(stats.truncated, true);
});

test('a clean sweep reports truncated:false', async () => {
	const h = harness({
		targets: [{ url: 'https://x/a', renderInterval: 60000 }],
		schedules: ['https://x/a|desktop'],
	});

	const stats = await h.run();

	assert.equal(stats.truncated, false);
	assert.equal(stats.restored, 0);
	assert.equal(stats.owned, 1);
});

test('an empty registry is a clean no-op', async () => {
	const h = harness({ targets: [] });

	const stats = await h.run();

	assert.deepEqual(stats, { examined: 0, owned: 0, missing: 0, restored: 0, truncated: false });
});

test('the result does not depend on the order rows arrive in', async () => {
	// The point of the cursor-free design. A paged cursor resuming from the last key seen would
	// silently skip rows if the storage engine ever stopped returning them in key order; this
	// asserts the sweep is indifferent to order instead of relying on that guarantee.
	const targets = [
		{ url: 'https://x/c', renderInterval: 60000 },
		{ url: 'https://x/a', renderInterval: 60000 },
		{ url: 'https://x/b', renderInterval: 60000 },
	];

	const shuffled = await harness({ targets }).run();
	const sorted = await harness({ targets: [...targets].sort((a, b) => (a.url < b.url ? -1 : 1)) }).run();

	assert.deepEqual(shuffled, sorted);
	assert.equal(shuffled.restored, 3);
});

/**
 * The LIVE query, exercised through `reconcileScheduleGaps` rather than the injected
 * `streamTargets` fake above.
 *
 * v0.10.0 shipped broken because every test stubbed this layer out: the traversal logic was
 * right and the query was rejected by Harper on its very first page, so the sweep restored
 * nothing and reported an error. Asserting the query shape is the cheapest way to hold that
 * contract without a live database.
 */
test('the live query asks for no sort — Harper rejects sorting by the primary key', async () => {
	const searches = [];
	const rows = [
		{ url: 'https://x/a', renderInterval: 60000, sitemapUrl: null },
		{ url: 'https://x/b', renderInterval: 60000, sitemapUrl: null },
	];

	globalThis.databases = {
		render_service: {
			Target: {
				search(target) {
					searches.push(target);
					return (async function* () {
						yield* rows;
					})();
				},
			},
		},
		// `get` and `put` ONLY: the schedule funnel must never reach for `search` on the reconcile
		// path — that would be a second walk of the hot queue index inside a registry sweep.
		render_schedule: {
			RenderSchedule: { get: async () => null, put: async () => {} },
		},
		coordination: { SharedBuffer: { primaryStore: sharedBufferStub } },
	};

	const stats = await reconcile.reconcileScheduleGaps({ maxRestores: 10 });

	assert.equal(stats.examined, 2);
	// config.deviceTypes.default is ['desktop', 'mobile'], so two URLs fan out to four rows.
	assert.equal(stats.restored, 4);

	// Exactly one scan: no paging, so no cursor and no resumption.
	assert.equal(searches.length, 1);
	const [search] = searches;

	// `sort` on the primary key is rejected outright ("url is not indexed and not combined
	// with any other conditions") because it is not flagged `indexed` in attribute metadata.
	assert.equal(search.sort, undefined, 'must not ask Harper to sort by the primary key');
	// And no conditions: with none, Harper injects its own full-scan condition, which is what
	// this wants. Supplying a range condition is only needed to resume a cursor — there is none.
	assert.equal(search.conditions, undefined, 'an unconstrained scan needs no conditions');
	assert.equal(search.limit, undefined, 'a streamed scan needs no limit');
	assert.deepEqual(search.select, ['url', 'renderInterval', 'sitemapUrl']);
});
