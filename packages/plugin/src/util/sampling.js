/**
 * REQUEST SAMPLING: a configurable, live-toggleable log of sampled bot requests, kept node-local.
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
 *   - a candidate sampler: its remaining filters (Set lookups), then the pick — an FNV-1a over the URL
 *     continued from the salt's precomputed state, or one Math.random().
 *   - picked: a minute counter for `maxPerMinute`, then assignments into a PREALLOCATED ring slot.
 *     Strings are referenced, never copied; only the listed headers are read. A full ring drops the
 *     record and counts it. Nothing awaits, nothing allocates, and a sampler can never fail a response.
 *
 * STORAGE. Every `flushInterval`, or as soon as the ring is half full, the worker drains the ring and
 * writes ONE ROW PER SAMPLER — the batch's records as gzipped NDJSON (gzip on zlib's thread pool, the
 * write detached from every request). Writes therefore scale with workers and samplers, not with sampling
 * volume. Rows are node-local (`replicate: false`) and expire `keep` after their first record. Records
 * still in the ring when a worker stops are lost: at most one flush interval's worth.
 *
 * CONFIG IS LIVE. `sampling.*` is applied on every config apply (an override row included): the samplers
 * are recompiled, the ring resized and the flush timer re-armed. Records already in the ring keep the
 * compiled sampler they were taken under, so a sampler edited or removed mid-batch still writes its
 * records with the fields it was recording.
 */

import { gzip as gzipCallback, gunzip as gunzipCallback } from 'node:zlib';
import { promisify } from 'node:util';
import { config, getLogger, onConfigApplied } from '../config.js';
import { Target } from '../resources/Target.js';
import { runDetached } from './detach.js';
import { compileSamplers, continueFnv, describeSampler, MAX_HEADERS } from './samplingSpec.js';

const gzip = promisify(gzipCallback);
const gunzip = promisify(gunzipCallback);

const table = () => databases.sampling.SampleChunk;

// Bounds the (route, bot) memo. Route entries are a configured handful; bot names are bounded by the
// registry, plus whatever names `deriveUnknownBots` mints — which is why there is a cap at all. Past it a
// lookup is computed and not kept: correct, only slower.
const MEMO_CAP = 512;
// A header value is recorded to this length. A user-agent is ~200 characters; anything longer is not a
// header worth keeping whole in a sample.
const MAX_HEADER_VALUE = 512;
// Distinct-URL target reads per batch run this many at a time, so a large batch cannot crowd the store.
const TARGET_READ_CONCURRENCY = 16;
const ERROR_LOG_INTERVAL_MS = 60_000;

let plan = null;
let started = false;
let timer = null;
let armedInterval = null;
let flushQueued = false;
let flushSeq = 0;
let lastErrorLogMs = 0;

const ring = { slots: [], size: 0, half: 0, count: 0 };
// name -> counters for this worker. Kept across recompiles, so a sampler's numbers survive an edit.
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
			written: 0,
			chunks: 0,
			bytes: 0,
			errors: 0,
			lastFlushAt: null,
			// Since the last row this worker wrote for the sampler: carried on the next row, so a reader
			// summing rows can tell how complete the sample was.
			pendingCapped: 0,
			pendingDropped: 0,
			// The compiled sampler last seen under this name, for a row that carries only counters.
			sampler: null,
		};
		statsByName.set(name, stats);
	}
	return stats;
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
 * Offer one delivered request to the samplers. Called by the bot handler after the response is assembled,
 * so `status` is the status sent (a conditional 304 included). Never throws into the request.
 *
 * @param {object} request    the bot request (`botName` already resolved)
 * @param {object} info       the handler's resolution info: route, routeClass, deviceType, cacheKey,
 *                            cacheStatus, source, entity, renderNowStatus
 * @param {object} resource   what answered (for `lastCached`)
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
			if (sampler.urls !== null && !sampler.urls.has(url)) continue;
			if (sampler.urlPattern !== null && !sampler.urlPattern.test(url)) continue;
			const stats = sampler.stats;
			stats.matched++;
			if (
				sampler.by === 'url' ? continueFnv(sampler.saltState, url) >= sampler.threshold : Math.random() >= sampler.rate
			) {
				continue;
			}
			stats.picked++;
			if (now === 0) now = Date.now();
			const minute = Math.floor(now / 60_000);
			if (sampler.minute !== minute) {
				sampler.minute = minute;
				sampler.inMinute = 0;
			}
			if (++sampler.inMinute > sampler.maxPerMinute) {
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

const logError = (message, e) => {
	const now = Date.now();
	if (now - lastErrorLogMs < ERROR_LOG_INTERVAL_MS) return;
	lastErrorLogMs = now;
	getLogger().warn?.(`${message}: ${e?.message ?? String(e)}`);
};

// A half-full ring asks for a flush from inside a request. The flush itself must not run there: it
// would add the drain to that one response, and its writes would inherit the request's transaction
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

const pad13 = (ms) => String(Math.max(0, Math.floor(ms))).padStart(13, '0');

/** The chunk row key: sampler, first record time, worker, sequence — so a sampler's rows sort by time. */
export const chunkIdOf = (name, firstMs, worker, seq) =>
	`${name}/${pad13(firstMs)}/${String(worker).padStart(3, '0')}/${seq.toString(36)}`;

/**
 * Drain the ring into per-sampler batches. Synchronous, so a request arriving during the write that
 * follows lands in an empty ring rather than in the batch being written.
 */
const takeBatches = () => {
	const node = server.hostname;
	const worker = server.workerIndex ?? 0;
	const batches = new Map();
	const n = ring.count;
	for (let i = 0; i < n; i++) {
		const slot = ring.slots[i];
		const sampler = slot.sampler;
		let batch = batches.get(sampler.name);
		if (!batch) {
			batch = { sampler, records: [], first: slot.ts, last: slot.ts };
			batches.set(sampler.name, batch);
		}
		const record = {};
		for (const field of sampler.fields) {
			if (field === 'node') record.node = node;
			else if (field === 'worker') record.worker = worker;
			else if (field === 'target' || field === 'sitemap') record[field] = null;
			else record[field] = slot[field];
		}
		if (sampler.headers.length) {
			const headers = {};
			for (let h = 0; h < sampler.headers.length; h++) headers[sampler.headers[h]] = slot.headers[h];
			record.headers = headers;
		}
		batch.records.push(record);
		if (slot.ts < batch.first) batch.first = slot.ts;
		if (slot.ts > batch.last) batch.last = slot.ts;
		clearSlot(slot);
	}
	ring.count = 0;
	// Counters with no records behind them still get a row: a ring full of another sampler's records
	// drops this one's, and that loss has to be readable from the table.
	for (const [name, stats] of statsByName) {
		if (batches.has(name) || (stats.pendingCapped === 0 && stats.pendingDropped === 0) || !stats.sampler) continue;
		const now = Date.now();
		batches.set(name, { sampler: stats.sampler, records: [], first: now, last: now });
	}
	for (const [name, batch] of batches) {
		const stats = statsFor(name);
		batch.capped = stats.pendingCapped;
		batch.dropped = stats.pendingDropped;
		stats.pendingCapped = 0;
		stats.pendingDropped = 0;
	}
	return batches;
};

/**
 * Resolve the flush-time fields (`target`, `sitemap`) for the records of samplers that record them: one
 * target read per distinct URL in the batch. A failed read records `target: 'unknown'` — never null, which
 * means "no target".
 */
const resolveTargets = async (records) => {
	const urls = [...new Set(records.map((record) => record.url).filter((url) => typeof url === 'string'))];
	const found = new Map();
	for (let i = 0; i < urls.length; i += TARGET_READ_CONCURRENCY) {
		await Promise.all(
			urls.slice(i, i + TARGET_READ_CONCURRENCY).map(async (url) => {
				try {
					const row = await Target.get({ id: url, select: ['url', 'state', 'sitemapUrl'] });
					found.set(url, row ? { target: row.state ?? 'active', sitemap: !!row.sitemapUrl } : null);
				} catch {
					found.set(url, undefined);
				}
			})
		);
	}
	for (const record of records) {
		const hit = found.get(record.url);
		const target = hit === undefined ? 'unknown' : (hit?.target ?? null);
		if ('target' in record) record.target = target;
		if ('sitemap' in record) record.sitemap = hit === undefined ? null : !!hit?.sitemap;
	}
};

const writeBatch = async (name, batch) => {
	const stats = statsFor(name);
	try {
		const { sampler, records } = batch;
		if (records.length && sampler.wantsTarget) await resolveTargets(records);
		let body = null;
		if (records.length) {
			let text = '';
			for (const record of records) text += `${JSON.stringify(record)}\n`;
			body = await gzip(Buffer.from(text), { level: 6 });
		}
		const worker = server.workerIndex ?? 0;
		await table().put(chunkIdOf(name, batch.first, worker, ++flushSeq), {
			sampler: name,
			node: server.hostname,
			worker,
			firstAt: new Date(batch.first),
			lastAt: new Date(batch.last),
			count: records.length,
			capped: batch.capped,
			dropped: batch.dropped,
			body: body ? createBlob(body) : null,
			expiresAt: new Date(batch.first + sampler.keep),
		});
		stats.written += records.length;
		stats.chunks++;
		stats.bytes += body ? body.length : 0;
		stats.lastFlushAt = Date.now();
	} catch (e) {
		stats.errors++;
		logError(`[prerender] request sampling could not write a batch for '${name}' (its records are lost)`, e);
	}
};

/** Drain this worker's ring and write one row per sampler. Exported for tests. */
export async function flushSamples() {
	const batches = takeBatches();
	if (batches.size === 0) return { chunks: 0, records: 0 };
	let records = 0;
	await Promise.all(
		[...batches].map(([name, batch]) => {
			records += batch.records.length;
			return writeBatch(name, batch);
		})
	);
	return { chunks: batches.size, records };
}

// Size 0 releases the ring. Records taken under the old ring are written, not discarded, before the slots
// are replaced or released: the drain is synchronous, so nothing can land in between.
const resizeRing = (size) => {
	if (ring.size === size) return;
	if (ring.count) {
		const batches = takeBatches();
		for (const [name, batch] of batches) writeBatch(name, batch);
	}
	ring.slots = Array.from({ length: size }, newSlot);
	ring.size = size;
	ring.half = size ? Math.max(1, Math.floor(size / 2)) : 0;
	ring.count = 0;
};

/**
 * Recompile from `config.sampling` and bring the ring and the timer in line. Run on every config apply,
 * in the load context (`onConfigApplied`), so the timer it arms never carries a request's transaction.
 */
export const syncSampling = () => {
	const sampling = config.sampling;
	const compiled = sampling?.enabled
		? compileSamplers(sampling.samplers, [], { deniedHeaders: [config.origin?.securityToken?.header].filter(Boolean) })
		: [];
	const enabled = compiled.filter((sampler) => sampler.enabled);
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
		// Switched off: what the ring holds is written now, and the ring is released.
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

/** Start sampling on this worker: compile now, and again on every config apply. Idempotent. */
export const startRequestSampling = () => {
	if (started) return;
	started = true;
	syncSampling();
	onConfigApplied(syncSampling);
};

/** This worker's live view, for the admin API: what is compiled, the ring, and the counters. */
export const samplingWorkerState = () => ({
	node: server.hostname,
	workerIndex: server.workerIndex ?? 0,
	active: plan !== null,
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
				written: stats.written,
				chunks: stats.chunks,
				bytes: stats.bytes,
				errors: stats.errors,
				lastFlushAt: stats.lastFlushAt ? new Date(stats.lastFlushAt).toISOString() : null,
			},
		])
	),
});

/**
 * This node's chunk rows for one sampler, in key order (first-record time, then worker): those whose first
 * record is at or after `sinceMs` and before `untilMs`, or after the row id `after` when resuming. A chunk
 * spans at most one flush interval, so a reader wanting records from `sinceMs` on starts one interval
 * earlier and filters records by `ts`.
 *
 * One lower-bound condition on the key, with the upper bound applied here: the walk ends at the first row
 * past it, so reading a window costs the rows in the window.
 */
export async function* sampleChunks({ sampler, sinceMs = 0, untilMs = Infinity, after = null, select }) {
	const prefix = `${sampler}/`;
	const resume = typeof after === 'string' && after.startsWith(prefix);
	const start = resume ? after : `${prefix}${pad13(sinceMs)}`;
	const end = Number.isFinite(untilMs) ? `${prefix}${pad13(untilMs)}` : `${prefix}~`;
	const results = table().search({
		conditions: [{ attribute: 'id', comparator: resume ? 'greater_than' : 'greater_than_equal', value: start }],
		sort: { attribute: 'id' },
		...(select ? { select: select.includes('id') ? select : ['id', ...select] } : {}),
	});
	for await (const row of results) {
		if (typeof row?.id !== 'string' || row.id >= end) return;
		yield row;
	}
}

/** A stored chunk's records as NDJSON bytes, or its gzip as stored. */
export const chunkBytes = async (row, { decode = true } = {}) => {
	const blob = row?.body;
	if (!blob) return null;
	const stored = typeof blob.bytes === 'function' ? await blob.bytes() : blob;
	const bytes = Buffer.isBuffer(stored) ? stored : Buffer.from(stored);
	return decode ? gunzip(bytes) : bytes;
};

/**
 * Totals of this node's stored rows per sampler over a window: rows, records, and the capped and dropped
 * counts the rows carry. Reads no bodies. `cap` bounds the rows walked per sampler; a walk that hits it
 * says so.
 */
export async function storedSampleTotals({ names, sinceMs, untilMs = Infinity, cap = 20_000 }) {
	const out = {};
	for (const name of names) {
		const totals = { chunks: 0, records: 0, capped: 0, dropped: 0, firstAt: null, lastAt: null, truncated: false };
		for await (const row of sampleChunks({
			sampler: name,
			sinceMs,
			untilMs,
			select: ['count', 'capped', 'dropped', 'firstAt', 'lastAt'],
		})) {
			if (totals.chunks === cap) {
				totals.truncated = true;
				break;
			}
			totals.chunks++;
			totals.records += Number(row.count) || 0;
			totals.capped += Number(row.capped) || 0;
			totals.dropped += Number(row.dropped) || 0;
			const first = row.firstAt ? new Date(row.firstAt).getTime() : NaN;
			const last = row.lastAt ? new Date(row.lastAt).getTime() : NaN;
			if (first >= 0 && (totals.firstAt === null || first < totals.firstAt)) totals.firstAt = first;
			if (last >= 0 && (totals.lastAt === null || last > totals.lastAt)) totals.lastAt = last;
		}
		if (totals.firstAt !== null) totals.firstAt = new Date(totals.firstAt).toISOString();
		if (totals.lastAt !== null) totals.lastAt = new Date(totals.lastAt).toISOString();
		out[name] = totals;
	}
	return out;
}

/** Test seam: forget everything this worker holds. */
export const resetSamplingForTests = () => {
	if (timer) clearInterval(timer);
	timer = null;
	armedInterval = null;
	plan = null;
	started = false;
	flushQueued = false;
	flushSeq = 0;
	ring.slots = [];
	ring.size = 0;
	ring.half = 0;
	ring.count = 0;
	statsByName.clear();
};
