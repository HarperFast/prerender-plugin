/**
 * Crawl breadth: distinct URLs crawled per bot per UTC day, via per-thread HyperLogLog
 * sketches (util/hll.js — see there for why a sketch and why per-thread shards merge into
 * an exact global union).
 *
 * Shape: each worker thread keeps one in-memory sketch per bot for the current day and, on
 * a timer, merges it into this node's `crawl_stats.CrawlSketch` row (`day|bot|node`) —
 * read-merge-write under the cross-worker mutex (util/coordination.js), so concurrent
 * workers never lose each other's registers. One row per node (not per thread) keeps the
 * read side inside the admin console's query-cost rules: a week is days × bots × nodes
 * small rows, not × threads. Cross-node there is no contention at all — the node is in the
 * key. The read side (PrerenderAdmin's crawl-breadth route) merges a day's rows per bot.
 *
 * Hot-path cost (recordCrawl): one number compare for day rollover, one Map lookup, one
 * 53-bit string hash + one byte max. No allocation, no await, no storage touch. Everything
 * async (flush, retention sweep) happens on the timer or via setImmediate.
 *
 * Loss model: a thread dying loses at most flushInterval worth of that thread's unmerged
 * observations — an undercount, never a double count. Thread sketches are cumulative for
 * the day and merging is idempotent, so a failed flush is simply retried whole next cycle.
 * Rows replicate (table default), so any single node can answer for the cluster.
 */

import { config } from '../config.js';
import { getMutex } from './coordination.js';
import { createSketch, addToSketch, mergeSketch, estimateSketch } from './hll.js';

// When a thread sees more distinct bot names than the cap in one day (a UA-derivation
// flood — registry bots can't exceed it), the overflow shares this bucket. Distinct from
// the registry's 'other' so a capped day is visible as such rather than blending in.
export const OVERFLOW_BUCKET = '~overflow';

let sketches = new Map(); // botName -> Uint8Array registers
const dirty = new Set(); // botNames with unflushed observations
let day = null; // 'YYYY-MM-DD' (UTC) the current sketches belong to
let dayEndMs = 0; // rollover boundary, so the hot path compares one number
let flushTimer = null;

const utcDayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const table = () => databases.crawl_stats.CrawlSketch;

/**
 * Observe one crawled URL. Called on the bot serving path (behind the analytics gate) —
 * everything above about hot-path cost is about this function. Synchronous by design.
 */
export function recordCrawl(botName, url) {
	if (!config.crawlStats.enabled) return;

	const now = Date.now();
	if (now >= dayEndMs) rollover(now);

	let sketch = sketches.get(botName);
	if (!sketch) {
		if (sketches.size >= config.crawlStats.maxBotsPerThread) {
			botName = OVERFLOW_BUCKET;
			sketch = sketches.get(botName);
		}
		if (!sketch) {
			sketch = createSketch();
			sketches.set(botName, sketch);
		}
	}
	addToSketch(sketch, url);
	dirty.add(botName);

	// Lazily started so only threads that actually serve bot traffic run a timer.
	if (!flushTimer) {
		flushTimer = setInterval(() => flushSketches().catch((e) => logger.error(e)), config.crawlStats.flushInterval);
		flushTimer.unref?.();
	}
}

// Close out the old day and start the new one. The old sketches are captured and persisted
// off the hot path via setImmediate; the maps are swapped synchronously so no observation
// lands in the wrong day. Also the retention hook: one worker per node sweeps expired rows.
function rollover(now) {
	const previous = day ? { day, sketches, dirty: [...dirty] } : null;
	day = utcDayOf(now);
	dayEndMs = Date.parse(day) + 24 * 60 * 60 * 1000;
	sketches = new Map();
	dirty.clear();

	if (previous?.dirty.length) {
		setImmediate(() => persist(previous.day, previous.sketches, previous.dirty).catch((e) => logger.error(e)));
	}
	if (previous && server.workerIndex === 0) {
		setImmediate(() => sweepExpired().catch((e) => logger.error(e)));
	}
}

/** Persist this thread's dirty sketches for the current day. Exported for tests. */
export async function flushSketches() {
	if (!dirty.size) return;
	const bots = [...dirty];
	dirty.clear();
	try {
		await persist(day, sketches, bots);
	} catch (e) {
		// Sketches are cumulative for the day and merging is idempotent, so retrying the
		// whole flush next cycle is safe — re-mark rather than wait for new traffic.
		for (const bot of bots) dirty.add(bot);
		throw e;
	}
}

async function persist(forDay, forSketches, bots) {
	const CrawlSketch = table();
	for (const bot of bots) {
		const mine = forSketches.get(bot);
		if (!mine) continue;
		// Read-merge-write of this node's row, serialized against the other workers by the
		// cross-worker mutex. The row is this node's own (node is in the key), so the read
		// is local — no cross-node fetch to time out on.
		const id = `${forDay}|${bot}|${server.hostname}`;
		await getMutex(`crawlSketch/${bot}`).withLock(async () => {
			const existing = await CrawlSketch.get(id);
			// Merge into a copy: merging the row INTO the thread sketch would fold other
			// workers' registers into thread-local state, and a later failed write would
			// then re-contribute them as if they were this thread's own.
			const merged = new Uint8Array(mine);
			if (existing?.registers) mergeSketch(merged, existing.registers);
			// `estimate` is this NODE's count, stored for eyeballing a raw row — the real
			// per-day number requires merging all nodes first (distinct counts don't add).
			await CrawlSketch.put(id, {
				day: forDay,
				bot,
				node: server.hostname,
				registers: merged,
				estimate: estimateSketch(merged),
				updatedAt: Date.now(),
			});
		})();
	}
}

// Delete rows past retention. Runs once per day-rollover on one worker per node; deletes
// are idempotent so concurrent nodes sweeping the same replicated rows is harmless. Bounded
// per pass — anything left over is caught the next day.
async function sweepExpired() {
	const CrawlSketch = table();
	const cutoff = utcDayOf(Date.now() - config.crawlStats.retentionDays * 24 * 60 * 60 * 1000);
	const expired = await CrawlSketch.search({
		conditions: [{ attribute: 'day', comparator: 'less_than', value: cutoff }],
		select: ['id'],
		limit: 1000,
	});
	for await (const row of expired) {
		await CrawlSketch.delete(row.id);
	}
}

/**
 * Merge raw sketch rows into per-day breadth estimates — the pure half of the admin
 * crawl-breadth route, split out so it's testable without the resource plumbing.
 * Returns [{ day, total, bots: [{ bot, distinctUrls, shards }] }] sorted by day desc,
 * where `total` is the distinct-URL count of the UNION across bots (not a sum).
 */
export function computeBreadth(rows) {
	const byDay = new Map();
	for (const row of rows) {
		if (!row?.registers || !row.bot) continue;
		let bots = byDay.get(row.day);
		if (!bots) byDay.set(row.day, (bots = new Map()));
		let entry = bots.get(row.bot);
		if (!entry) bots.set(row.bot, (entry = { registers: createSketch(), shards: 0 }));
		mergeSketch(entry.registers, row.registers);
		entry.shards++;
	}

	return [...byDay]
		.sort(([a], [b]) => (a < b ? 1 : -1))
		.map(([forDay, bots]) => {
			const union = createSketch();
			const perBot = [...bots]
				.map(([bot, { registers, shards }]) => {
					mergeSketch(union, registers);
					return { bot, distinctUrls: estimateSketch(registers), shards };
				})
				.sort((a, b) => b.distinctUrls - a.distinctUrls);
			return { day: forDay, total: estimateSketch(union), bots: perBot };
		});
}

/** Test hook: reset module state between tests. */
export function resetCrawlStats() {
	sketches = new Map();
	dirty.clear();
	day = null;
	dayEndMs = 0;
	if (flushTimer) clearInterval(flushTimer);
	flushTimer = null;
}
