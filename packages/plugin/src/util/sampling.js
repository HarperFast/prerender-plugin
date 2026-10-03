/**
 * REQUEST SAMPLING: a configurable, live-toggleable log of sampled bot requests, kept in node-local files.
 *
 * WHY. Nothing else here records WHEN a URL is asked for. The demand tracker keeps one Bloom slice per
 * period (how often, not when, and it cannot list URLs); the crawl-breadth sketches count distinct URLs.
 * So "how often does each crawler come back to a page, per page type and device" has no answer without a
 * per-request record — and keeping one for every request is not affordable. A sampler keeps one for a
 * chosen slice: a route, a set of bots, a URL-stable fraction of the URL space, an explicit list.
 *
 * URL-STABLE SAMPLING (`sample.by: url`, the default) is what makes revisit questions answerable: a URL is
 * in or out of the sample by a hash of the URL and the sampler's salt, so EVERY request for a sampled URL
 * is recorded, from every bot and device, for as long as the sampler runs. Raising `rate` keeps every URL
 * already in and adds more; changing `salt` picks a different set. `by: request` samples requests instead,
 * for distributions that do not need a URL's history.
 *
 * WHAT THE REQUEST PATH PAYS (`sampleRequest`):
 *   - sampling off, or no enabled sampler: one module-variable null check.
 *   - on, and no sampler for this route and bot: two Map gets on a memo keyed by the route entry and the
 *     bot name, filled once per (route, bot) and reset on every config apply. No allocation.
 *   - a candidate sampler: its request filters (Set lookups), then the pick — an FNV-1a over the URL
 *     continued from the salt's precomputed state, or one Math.random() — and only then its URL filters,
 *     so a `urlPattern` runs on the picked fraction, not on every matched request.
 *   - picked: a minute counter for `maxPerMinute`, then assignments into a PREALLOCATED ring slot.
 *     Strings are referenced, never copied; only the listed headers are read. A full ring drops the
 *     record and counts it. Nothing awaits, nothing allocates, and a sampler can never fail a response.
 *
 * STORAGE: APPEND-ONLY FILES, THE WAY HARPER WRITES ITS LOGS — each thread appends to a file it owns, and
 * old files are deleted on a schedule — rather than through Harper's logger, which a component can point
 * at a file of its own only through each node's root config, and which prefixes every line. Every
 * `flushInterval`, or as soon as the ring is half full, the worker swaps in its spare slot array (O(1), so
 * the requests that follow land in an empty ring) and writes what it took, in slices that yield to the
 * event loop: one gzip member per slice, appended to
 * `<directory>/<sampler>/<YYYY-MM-DD>.w<worker>.t<thread>.ndjson.gz`. Concatenated members are one gzip
 * stream, so a day's file reads with `gunzip`. A worker thread owns its files — the thread id is in the
 * name because Harper's overlapping restart briefly runs two threads with one worker index — and
 * serializes its own appends, so lines never interleave; an append that fails is rolled back to the
 * file's size before it, so a partial member is never followed by another. Worker 0 deletes files older
 * than `sampling.keepDays` every hour.
 *
 * COMPLETENESS IS IN THE STREAM. A pick not recorded — over `maxPerMinute` (capped), with the ring full
 * (dropped), or in an append that failed (lost) — is counted, and the counts are appended as a line
 * `{"ts":…,"counters":{"capped":n,"dropped":n,"lost":n}}` beside the records, so a reader sees the loss in
 * the same window as the data. Records still in a ring when a worker stops are lost uncounted: at most one
 * flush interval's worth.
 *
 * CONFIG IS LIVE. `sampling.*` is applied on every config apply (an override row included): the samplers
 * are recompiled, the ring resized and the flush timer re-armed. Records already taken keep the compiled
 * sampler they were taken under, so a sampler edited or removed mid-batch still writes its records with
 * the fields it was recording.
 */

import { mkdir, open, readdir, readFile, stat, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setImmediate as yieldNow } from 'node:timers/promises';
import { threadId } from 'node:worker_threads';
import { promisify } from 'node:util';
import { constants as zlibConstants, gunzip as gunzipCallback, gzip as gzipCallback } from 'node:zlib';
import { config, getLogger, onConfigApplied } from '../config.js';
import { Target } from '../resources/Target.js';
import { runDetached } from './detach.js';
import {
	compileSamplers,
	continueFnv,
	credentialHeadersOf,
	describeSampler,
	isSamplerName,
	MAX_HEADERS,
} from './samplingSpec.js';

const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);

const DAY_MS = 86_400_000;
// Under Harper's root unless `sampling.directory` says otherwise: persistent, and outside the component
// directory a deploy replaces.
const DEFAULT_DIRECTORY = 'prerender-sampling';
// `<YYYY-MM-DD>.w<worker>.t<thread>.ndjson.gz`. Anything else in a sampler's directory is never read or deleted.
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.w(\d{3})\.t(\d+)\.ndjson\.gz$/;
export const fileNameOf = (day, worker, thread = threadId) =>
	`${day}.w${String(worker).padStart(3, '0')}.t${thread}.ndjson.gz`;

// Bounds the (route, bot) memo. Route entries are a configured handful; bot names are bounded by the
// registry, plus whatever names `deriveUnknownBots` mints — which is why there is a cap at all. Past it a
// lookup is computed and not kept: correct, only slower.
const MEMO_CAP = 512;
// A header value is recorded to this length. A user-agent is ~200 characters; anything longer is not a
// header worth keeping whole in a sample.
const MAX_HEADER_VALUE = 512;
// A `urlPattern` is tested only against URLs up to this length. The pattern is an operator's, but the URL
// is the crawler's, and a pattern that backtracks costs time in proportion to it; a longer URL counts as
// not matching.
const MAX_PATTERN_INPUT = 8192;
// Records serialized between event-loop yields, and per gzip member.
const SLICE = 1024;
// Distinct-URL target reads per batch run this many at a time, so a large batch cannot crowd the store.
const TARGET_READ_CONCURRENCY = 16;
const ERROR_LOG_INTERVAL_MS = 60_000;
const SWEEP_INTERVAL_MS = 3_600_000;

let plan = null;
let started = false;
let timer = null;
let armedInterval = null;
let sweepTimer = null;
let flushQueued = false;
let lastErrorLogMs = -Infinity;
// This worker's appends, one at a time: two flushes in flight (the timer and a half-full ring) never
// write the same file at once.
let appendQueue = Promise.resolve();

// `spare` is the second slot array a flush swaps in, kept for the flush after; null while a flush is
// still working through it.
const ring = { slots: [], spare: null, size: 0, half: 0, count: 0 };
// name -> counters and the per-minute cap window for this worker. Kept across recompiles, so an edit
// neither resets a sampler's numbers nor opens a second cap window inside the same minute.
const statsByName = new Map();

const newSlot = () => ({
	sampler: null,
	ts: 0,
	url: null,
	cacheKey: null,
	route: null,
	routeClass: null,
	bot: null,
	device: null,
	method: null,
	status: 0,
	cacheStatus: null,
	source: null,
	ageMs: null,
	entityUrl: null,
	renderNow: null,
	conditional: false,
	headers: new Array(MAX_HEADERS).fill(null),
});

const clearSlot = (slot) => {
	slot.sampler = null;
	slot.url = null;
	slot.cacheKey = null;
	slot.route = null;
	slot.entityUrl = null;
	slot.renderNow = null;
	slot.headers.fill(null);
};

const statsFor = (name) => {
	let stats = statsByName.get(name);
	if (!stats) {
		stats = {
			matched: 0,
			picked: 0,
			capped: 0,
			dropped: 0,
			lost: 0,
			written: 0,
			appends: 0,
			bytes: 0,
			errors: 0,
			lastFlushAt: null,
			// Since the last counters line this worker wrote for the sampler.
			pendingCapped: 0,
			pendingDropped: 0,
			pendingLost: 0,
			// The `maxPerMinute` window.
			minute: -1,
			inMinute: 0,
			// The compiled sampler last seen under this name.
			sampler: null,
		};
		statsByName.set(name, stats);
	}
	return stats;
};

/**
 * Where this node's sample files go: `sampling.directory` when set (it must be absolute), else
 * `<Harper root>/prerender-sampling`. Null when neither resolves, and then nothing is recorded.
 */
export const sampleDirectory = () => {
	const configured = config.sampling.directory;
	if (configured) return isAbsolute(configured) ? configured : null;
	const root = server.config?.rootPath ?? process.env.ROOTPATH;
	return typeof root === 'string' && root ? join(root, DEFAULT_DIRECTORY) : null;
};

/** The route label the metrics use, so a sampler's `match.routes` reads the same as a dashboard. */
const routeLabelOf = (info) => info.route?.path ?? info.routeClass ?? 'unrouted';

const candidatesFor = (routeKey, label, routeClass, botName) => {
	let byBot = plan.memo.get(routeKey);
	if (byBot === undefined) {
		if (plan.memo.size >= MEMO_CAP) return selectCandidates(label, routeClass, botName);
		byBot = new Map();
		plan.memo.set(routeKey, byBot);
	}
	let list = byBot.get(botName);
	if (list === undefined) {
		list = selectCandidates(label, routeClass, botName);
		if (byBot.size < MEMO_CAP) byBot.set(botName, list);
	}
	return list;
};

// A route matches by its label (the route's `path`) or by its class, so `routes: [passthrough]` covers
// every passthrough route without naming each one.
const selectCandidates = (label, routeClass, botName) => {
	const bot = String(botName).toLowerCase();
	const list = plan.samplers.filter(
		(sampler) =>
			(sampler.routes === null || sampler.routes.has(label) || sampler.routes.has(routeClass)) &&
			(sampler.bots === null || sampler.bots.has(bot))
	);
	return list.length ? list : null;
};

const headerOf = (request, name) => {
	const value = request.headers?.get?.(name);
	if (value === undefined || value === null) return null;
	const text = String(value);
	return text.length > MAX_HEADER_VALUE ? text.slice(0, MAX_HEADER_VALUE) : text;
};

/**
 * Offer one answered request to the samplers. Called by the bot handler once the response is assembled,
 * so `status` is the status sent (a conditional 304 included, and a 500 the handler itself answered).
 * Never throws into the request.
 *
 * @param {object} request    the bot request (`botName` already resolved)
 * @param {object} info       the handler's resolution info: route, routeClass, deviceType, cacheKey,
 *                            cacheStatus, source, entity, renderNowStatus
 * @param {object|null} resource  what answered (for `lastCached`)
 * @param {number} status     the status sent
 * @param {string} url        the canonical URL (the cache key's URL half)
 */
export function sampleRequest(request, info, resource, status, url) {
	if (plan === null) return;
	try {
		const label = routeLabelOf(info);
		const list = candidatesFor(info.route ?? info.routeClass ?? 'unrouted', label, info.routeClass, request.botName);
		if (list === null) return;
		let now = 0;
		for (let i = 0; i < list.length; i++) {
			const sampler = list[i];
			if (sampler.devices !== null && !sampler.devices.has(info.deviceType)) continue;
			if (sampler.methods !== null && !sampler.methods.has(request.method)) continue;
			if (sampler.cacheStatuses !== null && !sampler.cacheStatuses.has(info.cacheStatus)) continue;
			if (sampler.sources !== null && !sampler.sources.has(info.source)) continue;
			if (sampler.statuses !== null && !sampler.statuses.has(status)) continue;
			const stats = sampler.stats;
			stats.matched++;
			if (
				sampler.by === 'url' ? continueFnv(sampler.saltState, url) >= sampler.threshold : Math.random() >= sampler.rate
			) {
				continue;
			}
			// The URL filters after the pick: both are a pure function of the URL, so the order changes what
			// is recorded not at all, and a pattern runs on the picked fraction only.
			if (sampler.urls !== null && !sampler.urls.has(url)) continue;
			if (sampler.urlPattern !== null && (url.length > MAX_PATTERN_INPUT || !sampler.urlPattern.test(url))) continue;
			stats.picked++;
			if (now === 0) now = Date.now();
			const minute = Math.floor(now / 60_000);
			if (stats.minute !== minute) {
				stats.minute = minute;
				stats.inMinute = 0;
			}
			if (++stats.inMinute > sampler.maxPerMinute) {
				stats.capped++;
				stats.pendingCapped++;
				continue;
			}
			if (ring.count >= ring.size) {
				stats.dropped++;
				stats.pendingDropped++;
				continue;
			}
			const slot = ring.slots[ring.count++];
			slot.sampler = sampler;
			slot.ts = now;
			slot.url = url;
			slot.cacheKey = info.cacheKey ?? null;
			slot.route = label;
			slot.routeClass = info.routeClass ?? null;
			slot.bot = request.botName ?? null;
			slot.device = info.deviceType ?? null;
			slot.method = request.method ?? null;
			slot.status = status;
			slot.cacheStatus = info.cacheStatus ?? null;
			slot.source = info.source ?? null;
			const lastCachedMs =
				info.source !== 'origin' && resource?.lastCached ? new Date(resource.lastCached).getTime() : NaN;
			slot.ageMs = lastCachedMs >= 0 ? now - lastCachedMs : null;
			slot.entityUrl = info.entity?.url ?? null;
			slot.renderNow = info.renderNowStatus ?? null;
			slot.conditional = sampler.wantsConditional
				? headerOf(request, 'if-none-match') !== null || headerOf(request, 'if-modified-since') !== null
				: false;
			for (let h = 0; h < sampler.headers.length; h++) slot.headers[h] = headerOf(request, sampler.headers[h]);
			if (ring.count === ring.half) scheduleFlush();
		}
	} catch (e) {
		logError('[prerender] request sampling failed for one request', e);
	}
}

// At most one line per interval. A clock stepped backwards logs at once rather than going quiet until it
// catches up.
const logError = (message, e) => {
	const now = Date.now();
	const elapsed = now - lastErrorLogMs;
	if (elapsed >= 0 && elapsed < ERROR_LOG_INTERVAL_MS) return;
	lastErrorLogMs = now;
	getLogger().warn?.(`${message}: ${e?.message ?? String(e)}`);
};

// A half-full ring asks for a flush from inside a request. The flush must not run there: its work would
// delay that one response, and anything it starts would inherit the request's async context
// (util/detach.js). So it is queued from the load context, on the next turn of the loop.
const scheduleFlush = () => {
	if (flushQueued) return;
	flushQueued = true;
	runDetached(() => {
		setImmediate(() => {
			flushQueued = false;
			flushSafely();
		});
	});
};

const flushSafely = () => {
	flushSamples().catch((e) => logError('[prerender] request sampling flush failed', e));
};

/** Take the ring's records in O(1): the spare array becomes the ring, and the taken one is worked through. */
const swapRing = () => {
	const n = ring.count;
	if (n === 0) return null;
	const slots = ring.slots;
	ring.slots = ring.spare ?? Array.from({ length: ring.size }, newSlot);
	ring.spare = null;
	ring.count = 0;
	return { slots, n };
};

// A worked-through array becomes the spare again, unless the ring has been resized since it was taken.
const releaseSlots = (slots) => {
	if (ring.spare === null && slots !== ring.slots && slots.length === ring.size && ring.size > 0) ring.spare = slots;
};

const takePending = () => {
	const out = [];
	for (const [name, stats] of statsByName) {
		if (stats.pendingCapped === 0 && stats.pendingDropped === 0 && stats.pendingLost === 0) continue;
		out.push({ name, capped: stats.pendingCapped, dropped: stats.pendingDropped, lost: stats.pendingLost });
		stats.pendingCapped = 0;
		stats.pendingDropped = 0;
		stats.pendingLost = 0;
	}
	return out;
};

const recordOf = (slot, sampler, node, worker) => {
	const record = {};
	for (const field of sampler.fields) {
		if (field === 'node') record.node = node;
		else if (field === 'worker') record.worker = worker;
		// Resolved once the batch is grouped (`resolveTargets`); a record whose read failed says 'unknown'.
		else if (field === 'target' || field === 'sitemap') record[field] = null;
		else record[field] = slot[field];
	}
	if (sampler.headers.length) {
		const headers = {};
		for (let h = 0; h < sampler.headers.length; h++) headers[sampler.headers[h]] = slot.headers[h];
		record.headers = headers;
	}
	return record;
};

/**
 * Resolve `target` and `sitemap` for the records that record them, from the URL each was TAKEN for —
 * `urls[i]`, kept beside the records, so a sampler need not record `url` to have its target read. One read
 * per distinct URL. A failed read records `target: 'unknown'` and `sitemap: null`, never null and false,
 * which would say "no target".
 */
const resolveTargets = async (records, urls) => {
	const distinct = [...new Set(urls.filter((url) => typeof url === 'string'))];
	const found = new Map();
	for (let i = 0; i < distinct.length; i += TARGET_READ_CONCURRENCY) {
		await Promise.all(
			distinct.slice(i, i + TARGET_READ_CONCURRENCY).map(async (url) => {
				try {
					const row = await Target.get({ id: url, select: ['url', 'state', 'sitemapUrl'] });
					found.set(url, row ? { target: row.state ?? 'active', sitemap: !!row.sitemapUrl } : null);
				} catch {
					found.set(url, undefined);
				}
			})
		);
	}
	for (let i = 0; i < records.length; i++) {
		if (typeof urls[i] !== 'string') continue;
		const record = records[i];
		const hit = found.get(urls[i]);
		if ('target' in record) record.target = hit === undefined ? 'unknown' : (hit?.target ?? null);
		if ('sitemap' in record) record.sitemap = hit === undefined ? null : !!hit?.sitemap;
	}
};

/**
 * Append `bytes` whole or not at all. A write can land short (a full disk, an I/O error mid-way), and a
 * partial gzip member followed by the next append would make every member after it unreadable; so a
 * failed append truncates the file back to the size it had before.
 */
const appendWhole = async (path, bytes) => {
	const handle = await open(path, 'a');
	let size = -1;
	try {
		size = (await handle.stat()).size;
		await handle.appendFile(bytes);
	} catch (e) {
		if (size >= 0) await handle.truncate(size).catch(() => {});
		throw e;
	} finally {
		await handle.close();
	}
};

const appendSerially = (path, bytes) => {
	const run = appendQueue.then(() => appendWhole(path, bytes));
	appendQueue = run.catch(() => {});
	return run;
};

/**
 * Write one (sampler, day) group: its records in gzip members of `SLICE` records, then its counters line,
 * appended in one write. A failure loses the records, and says so: they are counted as `lost`, and the
 * counters this group carried go back to pending, for the next line this worker writes.
 */
const writeGroup = async (dir, group, worker, now) => {
	const stats = statsFor(group.name);
	const count = group.records.length;
	try {
		if (dir === null) {
			throw new Error('no sampling directory (set sampling.directory to an absolute path)');
		}
		if (group.urls.some((url) => url !== null)) await resolveTargets(group.records, group.urls);
		const members = [];
		for (let i = 0; i < count; i += SLICE) {
			let text = '';
			const end = Math.min(i + SLICE, count);
			for (let j = i; j < end; j++) text += `${JSON.stringify(group.records[j])}\n`;
			members.push(await gzip(Buffer.from(text)));
		}
		if (group.counters) {
			members.push(await gzip(Buffer.from(`${JSON.stringify({ ts: now, counters: group.counters })}\n`)));
		}
		const bytes = members.length === 1 ? members[0] : Buffer.concat(members);
		// Every time, not cached: an operator who deletes a sampler's folder (to start a study afresh) must not
		// stop its appends until the worker restarts. One syscall per sampler per flush.
		const folder = join(dir, group.name);
		await mkdir(folder, { recursive: true });
		await appendSerially(join(folder, fileNameOf(group.day, worker)), bytes);
		stats.written += count;
		stats.appends++;
		stats.bytes += bytes.length;
		stats.lastFlushAt = Date.now();
		return true;
	} catch (e) {
		stats.errors++;
		stats.lost += count;
		stats.pendingLost += count;
		if (group.counters) {
			stats.pendingCapped += group.counters.capped;
			stats.pendingDropped += group.counters.dropped;
			stats.pendingLost += group.counters.lost;
		}
		logError(`[prerender] request sampling could not append for '${group.name}' (${count} records lost, counted)`, e);
		return false;
	}
};

/**
 * Group taken records by (sampler name, UTC day of the record) — yielding every `SLICE` records — add the
 * pending counters to today's group per sampler, and write each group. Records keep the compiled sampler
 * they were taken under: fields, headers and whether targets are read all come from it.
 */
const writeOut = async (taken, pending) => {
	const dir = sampleDirectory();
	const node = server.hostname;
	const worker = server.workerIndex ?? 0;
	const groups = new Map();
	const groupFor = (name, day) => {
		const key = `${name}/${day}`;
		let group = groups.get(key);
		if (!group) {
			group = { name, day, records: [], urls: [], counters: null };
			groups.set(key, group);
		}
		return group;
	};
	let dayNumber = NaN;
	let dayText = '';
	const dayOf = (ms) => {
		const n = Math.floor(ms / DAY_MS);
		if (n !== dayNumber) {
			dayNumber = n;
			dayText = new Date(n * DAY_MS).toISOString().slice(0, 10);
		}
		return dayText;
	};

	if (taken) {
		for (let i = 0; i < taken.n; i++) {
			const slot = taken.slots[i];
			const sampler = slot.sampler;
			const group = groupFor(sampler.name, dayOf(slot.ts));
			group.records.push(recordOf(slot, sampler, node, worker));
			group.urls.push(sampler.wantsTarget ? slot.url : null);
			clearSlot(slot);
			if ((i + 1) % SLICE === 0) await yieldNow();
		}
		releaseSlots(taken.slots);
	}
	const now = Date.now();
	for (const { name, capped, dropped, lost } of pending)
		groupFor(name, dayOf(now)).counters = { capped, dropped, lost };

	let files = 0;
	let records = 0;
	for (const group of groups.values()) {
		if (await writeGroup(dir, group, worker, now)) {
			files++;
			records += group.records.length;
		}
	}
	return { files, records };
};

/** Write out this worker's ring and pending counters. Exported for tests. */
export async function flushSamples() {
	const taken = swapRing();
	const pending = takePending();
	if (taken === null && pending.length === 0) return { files: 0, records: 0 };
	return writeOut(taken, pending);
}

// Size 0 releases the ring. What the old ring held is written, never discarded; on release the pending
// counters go with it, since no flush follows.
const resizeRing = (size) => {
	if (ring.size === size) return;
	const taken = ring.count ? { slots: ring.slots, n: ring.count } : null;
	ring.slots = size ? Array.from({ length: size }, newSlot) : [];
	ring.spare = null;
	ring.size = size;
	ring.half = size ? Math.max(1, Math.floor(size / 2)) : 0;
	ring.count = 0;
	const pending = size === 0 ? takePending() : [];
	if (taken || pending.length) {
		writeOut(taken, pending).catch((e) => logError('[prerender] request sampling flush failed', e));
	}
};

/**
 * Recompile from `config.sampling` and bring the ring and the timer in line. Run on every config apply,
 * in the load context (`onConfigApplied`), so the timer it arms never carries a request's transaction.
 */
export const syncSampling = () => {
	const sampling = config.sampling;
	const compiled = sampling.enabled
		? compileSamplers(sampling.samplers, [], { deniedHeaders: credentialHeadersOf(config) })
		: [];
	const enabled = compiled.filter((sampler) => sampler.enabled);
	if (enabled.length && sampleDirectory() === null) {
		logError('[prerender] request sampling is enabled but has no directory', {
			message: 'set sampling.directory to an absolute path — nothing is recorded until then',
		});
		enabled.length = 0;
	}
	for (const sampler of enabled) {
		sampler.stats = statsFor(sampler.name);
		sampler.stats.sampler = sampler;
	}
	if (enabled.length) {
		// The ring exists only while something can be sampled, so a deployment with sampling off carries
		// none of it.
		resizeRing(sampling.ringSize);
		plan = { samplers: enabled, memo: new Map() };
	} else {
		plan = null;
		resizeRing(0);
	}

	const desired = plan ? sampling.flushInterval : null;
	if (desired !== armedInterval) {
		if (timer) clearInterval(timer);
		timer = null;
		armedInterval = desired;
		if (desired !== null) {
			timer = setInterval(flushSafely, desired);
			timer.unref?.();
		}
	}
};

/**
 * Delete this node's sample files older than `sampling.keepDays` (by the day in the file name), for every
 * sampler directory — including samplers no longer configured. Run hourly on worker 0, whether or not
 * sampling is on, so turning it off never strands files. Exported for tests.
 */
export async function sweepSampleFiles(nowMs = Date.now()) {
	const dir = sampleDirectory();
	if (!dir) return { deleted: 0 };
	const cutoff = new Date(nowMs - config.sampling.keepDays * DAY_MS).toISOString().slice(0, 10);
	let names;
	try {
		names = await readdir(dir);
	} catch (e) {
		if (e.code === 'ENOENT') return { deleted: 0 };
		throw e;
	}
	let deleted = 0;
	for (const name of names) {
		if (!isSamplerName(name)) continue;
		let files;
		try {
			files = await readdir(join(dir, name));
		} catch {
			continue;
		}
		for (const file of files) {
			const match = FILE_RE.exec(file);
			if (!match || match[1] >= cutoff) continue;
			try {
				await unlink(join(dir, name, file));
				deleted++;
			} catch (e) {
				if (e.code !== 'ENOENT') logError('[prerender] request sampling could not delete an old file', e);
			}
		}
	}
	return { deleted };
}

const sweepSafely = () => {
	sweepSampleFiles().catch((e) => logError('[prerender] request sampling retention sweep failed', e));
};

/** Start sampling on this worker: compile now, and again on every config apply. Idempotent. */
export const startRequestSampling = () => {
	if (started) return;
	started = true;
	syncSampling();
	onConfigApplied(syncSampling);
	if ((server.workerIndex ?? 0) === 0) {
		sweepTimer = setInterval(sweepSafely, SWEEP_INTERVAL_MS);
		sweepTimer.unref?.();
		setTimeout(sweepSafely, 60_000).unref?.();
	}
};

/** This worker's live view, for the admin API: what is compiled, the ring, and the counters. */
export const samplingWorkerState = () => ({
	node: server.hostname,
	workerIndex: server.workerIndex ?? 0,
	active: plan !== null,
	directory: sampleDirectory(),
	flushInterval: armedInterval,
	ring: { size: ring.size, used: ring.count },
	samplers: plan ? plan.samplers.map(describeSampler) : [],
	counters: Object.fromEntries(
		[...statsByName].map(([name, stats]) => [
			name,
			{
				matched: stats.matched,
				picked: stats.picked,
				capped: stats.capped,
				dropped: stats.dropped,
				lost: stats.lost,
				written: stats.written,
				appends: stats.appends,
				bytes: stats.bytes,
				errors: stats.errors,
				lastFlushAt: stats.lastFlushAt ? new Date(stats.lastFlushAt).toISOString() : null,
			},
		])
	),
});

/** This node's files for one sampler, in name order (day, then worker), with size and modification time. */
export async function listSampleFiles(sampler) {
	const dir = sampleDirectory();
	if (!dir || !isSamplerName(sampler)) return [];
	let names;
	try {
		names = await readdir(join(dir, sampler));
	} catch (e) {
		if (e.code === 'ENOENT') return [];
		throw e;
	}
	const files = [];
	for (const name of names.filter((one) => FILE_RE.test(one)).sort()) {
		const path = join(dir, sampler, name);
		try {
			const { size, mtimeMs } = await stat(path);
			files.push({ name, day: name.slice(0, 10), path, size, mtimeMs });
		} catch {
			// Deleted by the sweep between the listing and the stat.
		}
	}
	return files;
}

/** Per sampler: this node's files, bytes, and first and last day. Reads directory entries, never files. */
export async function sampleFileSummary(names) {
	const out = {};
	for (const name of names) {
		const files = await listSampleFiles(name);
		const bytes = files.reduce((sum, file) => sum + file.size, 0);
		out[name] = {
			files: files.length,
			bytes,
			firstDay: files.length ? files[0].day : null,
			lastDay: files.length ? files[files.length - 1].day : null,
		};
	}
	return out;
}

/**
 * One file's bytes, as `format` asks:
 *   ndjson  decoded. A file a worker is appending to right now can end mid-member, so decoding flushes
 *           what is complete and keeps whole lines only. `maxOutputLength` bounds the decoded size (a
 *           RangeError past it).
 *   gzip    as stored.
 *   whole   decoded to whole lines and gzipped again: one well-formed member, for a file that may be
 *           mid-append, so that files after it in a concatenated download stay readable.
 */
export async function readSampleFile(path, { format = 'ndjson', maxOutputLength } = {}) {
	const bytes = await readFile(path);
	if (format === 'gzip') return bytes;
	const text = await gunzip(bytes, {
		finishFlush: zlibConstants.Z_SYNC_FLUSH,
		...(maxOutputLength ? { maxOutputLength } : {}),
	});
	const end = text.lastIndexOf(10);
	const lines = end === -1 ? Buffer.alloc(0) : text.subarray(0, end + 1);
	return format === 'whole' ? gzip(lines) : lines;
}

/** Test seam: forget everything this worker holds. */
export const resetSamplingForTests = () => {
	if (timer) clearInterval(timer);
	if (sweepTimer) clearInterval(sweepTimer);
	timer = null;
	sweepTimer = null;
	armedInterval = null;
	plan = null;
	started = false;
	flushQueued = false;
	appendQueue = Promise.resolve();
	ring.slots = [];
	ring.spare = null;
	ring.size = 0;
	ring.half = 0;
	ring.count = 0;
	statsByName.clear();
};
