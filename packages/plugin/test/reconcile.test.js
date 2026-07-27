import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The schedule-gap repair sweep.
 *
 * The bug it exists for: `RenderTarget` and `RenderSchedule` are separate databases, so a
 * target is created in two commits and the pair can be left half-written. For a URL that is
 * not in a sitemap, NOTHING re-creates the schedule — the bot-traffic path is gated on the
 * target not existing, and `processJobResult` needs a claim that can never happen. The URL
 * goes dark permanently and silently.
 *
 * The properties pinned here are the ones that make the sweep safe to run against a live
 * multi-node cluster with a million targets: it only ever asks about keys it OWNS (a
 * cross-node read of a residency-pinned row takes Harper's untimed replication fetch), it
 * pages so no read transaction stays open across writes, it restores with the JITTERED time
 * rather than "now", and its write cap reports truncation instead of quietly covering less
 * than it claims.
 */

let reconcile;

beforeEach(async () => {
	globalThis.server = { hostname: 'node-a', nodes: [], config: { http: {} } };
	globalThis.logger = { info() {}, warn() {}, error() {} };
	reconcile = await import('../src/util/reconcile.js');
});

afterEach(() => {
	delete globalThis.server;
	delete globalThis.logger;
});

/**
 * A fake registry. `owners` maps a cacheKey to its owning node so a test can place rows on
 * either side of the residency boundary; `schedules` is the set of keys that HAVE a row.
 */
const harness = ({ targets, owners = {}, schedules = [], hostname = 'node-a', batchSize = 2, maxRestores = 100 }) => {
	const scheduleSet = new Set(schedules);
	const puts = [];
	const scheduleReads = [];
	let openCursor = false;
	const writesWhileCursorOpen = [];

	const searchTargets = async ({ cursor, limit }) => {
		openCursor = true;
		const ordered = [...targets].sort((a, b) => (a.cacheKey < b.cacheKey ? -1 : 1));
		const page = ordered.filter((t) => cursor === null || t.cacheKey > cursor).slice(0, limit);
		// A drained batch: the cursor is closed before the caller does any writing.
		openCursor = false;
		return page;
	};

	return {
		puts,
		scheduleReads,
		writesWhileCursorOpen,
		run: (overrides = {}) =>
			reconcile.reconcileSchedules({
				searchTargets,
				getSchedule: async (cacheKey) => {
					scheduleReads.push(cacheKey);
					return scheduleSet.has(cacheKey) ? { cacheKey } : null;
				},
				putSchedule: async (cacheKey, row) => {
					if (openCursor) writesWhileCursorOpen.push(cacheKey);
					puts.push({ cacheKey, ...row });
					scheduleSet.add(cacheKey);
				},
				ownerOf: (url) => owners[url] ?? 'node-a',
				hostname,
				batchSize,
				maxRestores,
				...overrides,
			}),
	};
};

test('a target missing its schedule row gets one restored', async () => {
	const h = harness({
		targets: [{ cacheKey: 'https://x/a|desktop', renderInterval: 60000, sitemapUrl: null }],
	});

	const stats = await h.run();

	assert.equal(stats.restored, 1);
	assert.equal(h.puts.length, 1);
	assert.equal(h.puts[0].cacheKey, 'https://x/a|desktop');
});

test('a target that already has a schedule row is left alone', async () => {
	const h = harness({
		targets: [{ cacheKey: 'https://x/a|desktop', renderInterval: 60000 }],
		schedules: ['https://x/a|desktop'],
	});

	const stats = await h.run();

	assert.equal(stats.restored, 0);
	assert.equal(h.puts.length, 0);
});

test('keys owned by another node are never even asked about', async () => {
	// This is the safety property, not an optimization: a point read for a residency-pinned row
	// this node does not own takes Harper's replication fetch, which has no timeout — one such
	// read would hang the whole sweep.
	const h = harness({
		targets: [
			{ cacheKey: 'https://x/mine|desktop', renderInterval: 60000 },
			{ cacheKey: 'https://x/theirs|desktop', renderInterval: 60000 },
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

test('residency is computed from the URL half, exactly as RenderSchedule pins it', async () => {
	// RenderSchedule.setResidencyById hashes CacheKey.extractUrl(cacheKey), so the same URL on
	// two device types lands on the SAME node. Hashing the whole key would split the pair and
	// make the sweep skip rows it actually owns.
	const seen = [];
	const h = harness({
		targets: [
			{ cacheKey: 'https://x/a|desktop', renderInterval: 60000 },
			{ cacheKey: 'https://x/a|mobile', renderInterval: 60000 },
		],
	});

	await h.run({
		ownerOf: (url) => {
			seen.push(url);
			return 'node-a';
		},
	});

	assert.deepEqual(seen, ['https://x/a', 'https://x/a']);
});

test('restores at the jittered initial time, not now', async () => {
	// A repair pass can restore a great many rows at once; scheduling them all immediately
	// would trade a silent outage for a render herd.
	const interval = 60 * 60 * 1000;
	const before = Date.now();
	const h = harness({
		targets: [
			{ cacheKey: 'https://x/a|desktop', renderInterval: interval },
			{ cacheKey: 'https://x/b|desktop', renderInterval: interval },
			{ cacheKey: 'https://x/c|desktop', renderInterval: interval },
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
		targets: [{ cacheKey: 'https://x/a|desktop', renderInterval: 3600000n }],
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
			{ cacheKey: 'https://x/a|desktop', sitemapUrl: 'https://x/sitemap.xml' },
			{ cacheKey: 'https://x/b|desktop', sitemapUrl: null },
		],
	});

	await h.run();

	assert.equal(h.puts.find((p) => p.cacheKey === 'https://x/a|desktop').fromSitemap, true);
	assert.equal(h.puts.find((p) => p.cacheKey === 'https://x/b|desktop').fromSitemap, false);
});

test('the walk pages through every target rather than stopping at the first batch', async () => {
	const targets = Array.from({ length: 7 }, (_, i) => ({
		cacheKey: `https://x/${i}|desktop`,
		renderInterval: 60000,
	}));
	const h = harness({ targets, batchSize: 2 });

	const stats = await h.run();

	assert.equal(stats.examined, 7);
	assert.equal(stats.restored, 7);
});

test('no write is issued while a search cursor is still open', async () => {
	// Interleaving writes into an open search holds its read transaction across them and pins
	// the log against reclamation — the same reason `claim` drains before leasing.
	const targets = Array.from({ length: 5 }, (_, i) => ({
		cacheKey: `https://x/${i}|desktop`,
		renderInterval: 60000,
	}));
	const h = harness({ targets, batchSize: 2 });

	await h.run();

	assert.deepEqual(h.writesWhileCursorOpen, []);
});

test('the restore cap stops the sweep and reports truncation', async () => {
	const targets = Array.from({ length: 10 }, (_, i) => ({
		cacheKey: `https://x/${i}|desktop`,
		renderInterval: 60000,
	}));
	const h = harness({ targets, batchSize: 3, maxRestores: 4 });

	const stats = await h.run();

	assert.equal(stats.restored, 4);
	assert.equal(stats.truncated, true);
	// Truncation must be visible: a short count that reads as "all clear" is the failure mode.
	assert.equal(h.puts.length, 4);
});

test('a clean sweep reports truncated:false', async () => {
	const h = harness({
		targets: [{ cacheKey: 'https://x/a|desktop', renderInterval: 60000 }],
		schedules: ['https://x/a|desktop'],
	});

	const stats = await h.run();

	assert.equal(stats.truncated, false);
	assert.equal(stats.restored, 0);
	assert.equal(stats.owned, 1);
});

test('an empty registry terminates instead of looping', async () => {
	const h = harness({ targets: [] });

	const stats = await h.run();

	assert.deepEqual(
		{ examined: stats.examined, restored: stats.restored, lastKey: stats.lastKey },
		{ examined: 0, restored: 0, lastKey: null }
	);
});

test('the cursor advances past skipped rows so a capped run makes progress', async () => {
	// If the cursor only advanced on restored rows, a sweep whose first page is entirely
	// owned elsewhere would re-read that same page forever.
	const pages = [];
	const h = harness({
		targets: [
			{ cacheKey: 'https://x/a|desktop' },
			{ cacheKey: 'https://x/b|desktop' },
			{ cacheKey: 'https://x/c|desktop' },
		],
		owners: { 'https://x/a': 'node-b', 'https://x/b': 'node-b' },
		batchSize: 2,
	});

	await h.run({
		searchTargets: async ({ cursor, limit }) => {
			pages.push(cursor);
			const ordered = [
				{ cacheKey: 'https://x/a|desktop' },
				{ cacheKey: 'https://x/b|desktop' },
				{ cacheKey: 'https://x/c|desktop' },
			];
			return ordered.filter((t) => cursor === null || t.cacheKey > cursor).slice(0, limit);
		},
	});

	assert.deepEqual(pages, [null, 'https://x/b|desktop']);
});
