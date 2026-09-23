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

// `coordination.SharedBuffer` is a REAL TABLE in production, not just a lock store: the sweeps'
// run-state row lives in it (`util/runState.js`), and `primaryStore` is only what the claim's
// cross-worker lock uses. A fake carrying just `primaryStore` makes every claim refuse — the
// publish fails, and a claim that cannot be published is refused by design — so the row has to be
// modelled here for the sweeps to start at all.
const runStateRows = new Map();
const coordinationTable = {
	primaryStore: sharedBufferStub,
	async get(key) {
		return runStateRows.get(key) ?? null;
	},
	async put(key, value) {
		runStateRows.set(key, value);
	},
};

beforeEach(async () => {
	globalThis.server = { hostname: 'node-a', nodes: [], config: { http: {} } };
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {} };
	globalThis.databases = { coordination: { SharedBuffer: coordinationTable } };
	reconcile = await import('../src/util/reconcile.js');
});

afterEach(() => {
	delete globalThis.server;
	delete globalThis.logger;
	delete globalThis.databases;
});

/**
 * A fake registry. `owners` maps a URL to its owning node so a test can place rows on either
 * side of the residency boundary; `schedules` is the set of schedule keys that HAVE a row — a URL
 * (the row every target should have) or a pre-0.66.0 `url|device` cacheKey.
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
	assert.equal(h.puts[0].cacheKey, 'https://x/a', 'the row is keyed by the URL — one row, every device');
});

test('a target that already has a schedule row is left alone', async () => {
	const h = harness({
		targets: [{ url: 'https://x/a', renderInterval: 60000 }],
		schedules: ['https://x/a'],
	});

	const stats = await h.run();

	assert.equal(stats.restored, 0);
	assert.equal(h.puts.length, 0);
	assert.deepEqual(h.scheduleReads, ['https://x/a'], 'a present URL row settles it in one read');
});

test('a URL still scheduled under a pre-0.66.0 device row is NOT restored beside it', async () => {
	// A per-device row converts into the URL row the first time it renders. Until then the URL IS
	// scheduled, and restoring a URL row next to it would render the URL twice for a cycle. The
	// device reads run only when the URL row is missing, so a converged corpus never pays them.
	const h = harness({
		targets: [{ url: 'https://x/a', renderInterval: 60000 }],
		deviceTypes: ['desktop', 'mobile'],
		schedules: ['https://x/a|mobile'],
	});

	const stats = await h.run();

	assert.deepEqual(h.scheduleReads, ['https://x/a', 'https://x/a|desktop', 'https://x/a|mobile']);
	assert.equal(stats.missing, 0);
	assert.deepEqual(h.puts, []);
});

test('a URL with neither a URL row nor any device row is restored under the URL', async () => {
	const h = harness({
		targets: [{ url: 'https://x/a', renderInterval: 60000 }],
		deviceTypes: ['desktop', 'mobile'],
	});

	const stats = await h.run();

	assert.deepEqual(h.scheduleReads, ['https://x/a', 'https://x/a|desktop', 'https://x/a|mobile']);
	assert.equal(stats.missing, 1);
	assert.deepEqual(
		h.puts.map((p) => p.cacheKey),
		['https://x/a']
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
	assert.deepEqual(h.scheduleReads, ['https://x/mine', 'https://x/mine|desktop']);
	assert.deepEqual(
		h.puts.map((p) => p.cacheKey),
		['https://x/mine']
	);
});

test('residency is asked once per URL, and every row of the URL lives with that owner', async () => {
	// RenderSchedule.setResidencyById hashes the URL (the URL half, for a pre-0.66.0 cacheKey), so
	// the URL row and any leftover device row land on the SAME node — one ownership answer covers
	// every key that is checked.
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
	assert.deepEqual(h.scheduleReads.sort(), ['https://x/a', 'https://x/a|desktop', 'https://x/a|mobile']);
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

	assert.equal(h.puts.find((p) => p.cacheKey === 'https://x/a').fromSitemap, true);
	assert.equal(h.puts.find((p) => p.cacheKey === 'https://x/b').fromSitemap, false);
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

	assert.deepEqual(stats, { examined: 0, owned: 0, missing: 0, restored: 0, unreadable: 0, truncated: false });
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
 * The LIVE walk, exercised through `reconcileScheduleGaps` rather than the injected
 * `streamTargets` fake above.
 *
 * v0.10.0 shipped broken because every test stubbed this layer out: the traversal logic was
 * right and the query was rejected by Harper on its very first page. So the live query shape is
 * asserted here against a fake table that answers the way Harper's does — conditions, sort and
 * limit honored — including the two unreadable-row personalities from util/urlWalk.js.
 */
const liveTargets = (rows, { abortsBefore = new Set() } = {}) => {
	const searches = [];
	const Target = {
		search({ conditions, sort, select, limit }) {
			searches.push({ conditions, sort, select, limit });
			const [range, upper] = conditions ?? [];
			let view = rows.filter((r) => {
				if (!range) return true;
				if (range.comparator === 'greater_than' ? r.key <= range.value : r.key < range.value) return false;
				return !(upper && r.key >= upper.value);
			});
			if (sort?.descending) view = [...view].reverse();
			const out = [];
			for (const r of view) {
				// The aborting personality: a PROJECTED read ends in front of the poison row.
				if (select && abortsBefore.has(r.key)) break;
				out.push({ ...r.record });
				if (out.length >= limit) break;
			}
			return (async function* () {
				yield* out;
			})();
		},
	};
	globalThis.databases = {
		render_service: { Target },
		// `get` and `put` ONLY: the schedule funnel must never reach for `search` on the reconcile
		// path — that would be a second walk of the hot queue index inside a registry sweep.
		render_schedule: {
			RenderSchedule: { get: async () => null, put: async () => {} },
		},
		coordination: { SharedBuffer: coordinationTable },
	};
	return searches;
};
const targetRow = (url) => ({ key: url, record: { url, renderInterval: 60000, sitemapUrl: null } });

test('the live walk conditions every chunk on the url key — never a bare primary-key sort', async () => {
	const searches = liveTargets([targetRow('https://x/a'), targetRow('https://x/b')]);

	const stats = await reconcile.reconcileScheduleGaps({ maxRestores: 10 });

	assert.equal(stats.examined, 2);
	// One row per URL, whatever `config.deviceTypes.default` says: two URLs, two rows.
	assert.equal(stats.restored, 2);
	assert.equal(stats.unreadable, 0);
	// A sort on the un-indexed primary key is rejected outright unless a condition accompanies it
	// ("url is not indexed and not combined with any other conditions") — so no search may sort
	// without a `url` condition beside it.
	for (const search of searches) {
		assert.equal(search.conditions?.[0]?.attribute, 'url', 'every chunk carries a condition on the key');
		assert.ok(Number.isFinite(search.limit), 'every chunk is bounded');
	}
	// The chunk reads project; only the verification probes are projection-free.
	assert.deepEqual(searches[0].select, ['url', 'renderInterval', 'sitemapUrl']);
});

test('a target past a projection-poison row is still examined — the walk does not end at it', async () => {
	// The production failure: the PROJECTED iterator silently ends in front of a row it cannot
	// project, and the old single streamed search reported "no gaps" for everything past it. The
	// projection-free probe proves the range continues, so the walk skips the row (counting it —
	// its projected read never hands it over) and carries on to the targets beyond.
	const poison = 'https://x/m';
	const puts = [];
	liveTargets([targetRow('https://x/a'), targetRow(poison), targetRow('https://x/z')], {
		abortsBefore: new Set([poison]),
	});
	globalThis.databases.render_schedule.RenderSchedule.put = async (key) => {
		puts.push(key);
	};

	const stats = await reconcile.reconcileScheduleGaps({ maxRestores: 10 });

	assert.ok(puts.includes('https://x/z'), 'the target PAST the poison row was reached and restored');
	assert.equal(stats.examined, 2);
	assert.equal(stats.unreadable, 1, 'the row the walk could not hand over is counted, not silently dropped');
});

test('a row unreadable on every path fails the pass instead of reporting it clean', async () => {
	// When no read can hand over the row's key, the walk cannot prove it covered the range. A
	// partial pass must be recorded as a failure — never as "no gaps across N owned targets", which
	// is the lie that left live targets unscheduled for weeks.
	const poison = 'https://x/m';
	liveTargets([targetRow('https://x/a'), { key: poison, record: { url: undefined } }, targetRow('https://x/z')], {
		abortsBefore: new Set([poison]),
	});

	await assert.rejects(reconcile.reconcileScheduleGaps({ maxRestores: 10 }), /NOT fully covered/);
});
