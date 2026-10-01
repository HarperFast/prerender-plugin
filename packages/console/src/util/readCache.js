/**
 * The console's read cache: upstream GET answers, per node, shared by every worker thread on this
 * host and by every operator signed in through it.
 *
 * WHY THE CONSOLE AND NOT THE PRERENDER NODES. The plugin caches its analytics window per WORKER,
 * and Harper hands each incoming connection to a worker (SO_REUSEPORT, else the most idle one), so
 * a refresh is answered from that cache only when it happens to land on the worker that scanned. The
 * console is the one place every operator's read passes through, and it already owns the fan-out:
 * a repeat read answered here never reaches a node that is also serving crawlers.
 *
 * WHY A TABLE AND NOT A MAP. The same distribution applies to this component — a module-level Map
 * would be per worker here too, and miss the same way. `ProxyRead` is a node-local table (not
 * replicated, not audited, not exported) that every worker on this host reads. A crash loses it,
 * which for a cache is the right trade: audited, every cached body would also be written to the
 * transaction log and kept there for its retention.
 *
 * WHO MAY READ A HIT. Every data route on the plugin requires a super_user and no answer depends on
 * which one asked — that is what makes one answer shareable between operators. But the console
 * cannot validate a session token itself: the token is opaque, and the console cookie is not signed,
 * so "sent a cookie" proves nothing. A hit for node X is served only to a requester whose token node X
 * itself confirmed as a super_user within `VERIFY_MS` — by answering a data route 200, by the shell's
 * own session check, or by a session check this cache makes when it holds neither. That is the
 * uncached authorization, at most `VERIFY_MS` stale, and never weaker.
 *
 * WHAT A WRITE DOES. Every console POST that can change state stamps a write generation, and an entry
 * whose fetch began before it is a miss: the reload after "Pause" or "Apply" reads the node, not the
 * answer from before the click. Writes made elsewhere — another console, the plugin's own schedulers
 * — are bounded by the TTL alone.
 */

import { createHash } from 'node:crypto';

/**
 * How long an answer may be served, per route, measured from when its DATA was produced — see
 * `bornAt` below. Only the routes that cost the node something, or cannot change faster, are listed.
 */
export const READ_TTL = Object.freeze({
	// Harper aggregates analytics once a minute: re-reading inside that window cannot surface a new
	// row, only repeat the scan. (The plugin's `management.analytics.cacheTtl` defaults to it too.)
	'analytics': 60_000,
	// Day-bucketed crawl sketches: a minute of staleness is invisible at that grain.
	'crawl-breadth': 60_000,
	// The metric catalog — static for a plugin release.
	'metrics': 600_000,
	// A capped page-cache scan on one of the node's two heavy slots per worker.
	'pages': 15_000,
});

/**
 * Everything else — overview, queue-state, the probe and purge status, config, invalidations,
 * sitemaps, unrouted — is cheap on the node by design, and is what an operator watches change. A
 * short TTL collapses a burst (a view switch, several operators, several tabs) without making a
 * Refresh look stuck.
 */
export const DEFAULT_READ_TTL = 5_000;

/**
 * Never cached. `session` IS the authorization check. `page-content` is a byte-exact download of one
 * stored page: unique per request, and up to megabytes.
 */
export const UNCACHED_READS = Object.freeze(new Set(['session', 'page-content']));

export const ttlFor = (route) => (UNCACHED_READS.has(route) ? 0 : (READ_TTL[route] ?? DEFAULT_READ_TTL));

/**
 * The POSTs that only read, and so leave the cache alone. Every other POST stamps the write
 * generation — including dry runs, because a dry-run purge or sweep still STARTS a pass, and the
 * status routes then read differently.
 */
export const READ_ONLY_POST = Object.freeze(new Set(['explain', 'schedule', 'sitemap']));

export const invalidatesReads = (route) => !READ_ONLY_POST.has(route);

/** How long a node's confirmation of one operator's token is trusted before it is asked again. */
export const VERIFY_MS = 60_000;

/**
 * Larger answers are served but not stored. Today's largest (a 24h analytics window) is tens of KB per
 * node; anything near this is not a dashboard read.
 */
export const MAX_CACHED_BODY = 4 * 1024 * 1024;

/** The row holding the write generation. Never a valid cache key: those are URLs. */
export const GENERATION_KEY = 'write-generation';

/** Bound on remembered confirmations, per worker. One per operator per node in practice. */
const MAX_CONFIRMATIONS = 1000;

/** The cache key is the URL the console would ask: one origin, one route, one query. */
export const cacheKeyFor = (origin, path) => `${origin}/prerender_admin/${path}`;

const isJson = (contentType) => /\bjson\b/i.test(String(contentType ?? ''));

const parse = (text) => {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
};

const ageOf = (payload) =>
	payload && typeof payload === 'object' && Number.isFinite(payload.cacheAgeMs) ? payload.cacheAgeMs : null;

/**
 * Whether a stored entry may answer now.
 *
 * Freshness runs from `bornAt`, when the DATA was produced, not from when the console fetched it. The
 * plugin caches analytics itself and says how old its answer was (`cacheAgeMs`); counting from the
 * fetch would stack the two TTLs, and a "60s" window could be two minutes old. An entry the clock has
 * gone backwards past is not fresh either: it would otherwise stay fresh for however far the clock
 * moved.
 */
export function isFresh(entry, { ttl, now, generation }) {
	if (!entry || typeof entry.body !== 'string') return false;
	if (!Number.isFinite(entry.startedAt) || !Number.isFinite(entry.bornAt)) return false;
	if (entry.startedAt < generation) return false;
	if (now < entry.startedAt) return false;
	return now - entry.bornAt < ttl;
}

/**
 * The read path every proxied GET takes.
 *
 * `fetch(origin, path, cookie)` → `{ status, contentType, body: Buffer }`, throwing on transport
 * failure; `verify(origin, cookie)` → whether that node accepts the token as a super_user. `table()`
 * returns the Harper table, or null where there is none (tests, or a host without the schema), and
 * `detach(fn)` runs a write outside the request's transaction (util/detach.js).
 *
 * Every answer is `{ status, contentType, body, payload, cached, ageMs }`: `payload` is a parse of
 * `body` that belongs to this caller alone (a merger may modify it), `undefined` for a non-JSON body,
 * and null for an unreadable one; `ageMs` is how long ago the console fetched it, null when it just did.
 */
export function createReadCache({ table, fetch, verify, detach, enabled = () => true, now = Date.now, log }) {
	const confirmed = new Map();
	const confirming = new Map();
	const inflight = new Map();
	// This worker's own last write, so its next read sees it before the table write has committed.
	let localGeneration = 0;

	const idOf = (origin, cookie) => createHash('sha256').update(origin).update('\0').update(cookie).digest('base64url');

	const confirm = (origin, cookie) => {
		if (!cookie) return;
		const id = idOf(origin, cookie);
		confirmed.delete(id);
		confirmed.set(id, now());
		if (confirmed.size <= MAX_CONFIRMATIONS) return;
		const cutoff = now() - VERIFY_MS;
		for (const [key, at] of confirmed) if (at < cutoff) confirmed.delete(key);
		while (confirmed.size > MAX_CONFIRMATIONS) confirmed.delete(confirmed.keys().next().value);
	};

	const forget = (origin, cookie) => {
		if (cookie) confirmed.delete(idOf(origin, cookie));
	};

	/** Whether `origin` currently accepts this token — remembered, else asked (once, however many wait). */
	const vouched = (origin, cookie) => {
		if (!cookie) return false;
		const id = idOf(origin, cookie);
		const at = confirmed.get(id);
		if (at !== undefined && now() - at < VERIFY_MS && now() >= at) return true;
		let pending = confirming.get(id);
		if (!pending) {
			pending = Promise.resolve()
				.then(() => verify(origin, cookie))
				.then(
					(ok) => {
						if (ok) confirm(origin, cookie);
						else forget(origin, cookie);
						return !!ok;
					},
					() => false
				)
				.finally(() => confirming.delete(id));
			confirming.set(id, pending);
		}
		return pending;
	};

	const answerOf = (raw, { cached = false, ageMs = null } = {}) => ({
		status: raw.status,
		contentType: raw.contentType,
		body: raw.body,
		payload: isJson(raw.contentType) ? parse(raw.body.toString('utf8')) : undefined,
		cached,
		ageMs,
	});

	const safeGet = async (store, key) => {
		try {
			return (await store.get(key)) ?? null;
		} catch (e) {
			log?.warn?.(`[prerender-console] read cache lookup failed; reading the node: ${e?.message ?? String(e)}`);
			return null;
		}
	};

	const generationOf = async (store) => {
		const row = await safeGet(store, GENERATION_KEY);
		return Math.max(localGeneration, Number.isFinite(row?.startedAt) ? row.startedAt : 0);
	};

	const hitOf = (entry, at) => {
		const payload = parse(entry.body);
		if (payload === null) return null;
		let text = entry.body;
		// The plugin's own age, carried forward: the footer's "cached Ns ago" must count the console's
		// time on top, or a minute-old window would read as the plugin's few seconds.
		if (ageOf(payload) !== null) {
			payload.cacheAgeMs = at - entry.bornAt;
			text = JSON.stringify(payload);
		}
		return {
			status: 200,
			contentType: entry.contentType,
			body: Buffer.from(text, 'utf8'),
			payload,
			cached: true,
			ageMs: at - entry.startedAt,
		};
	};

	const store = (key, raw, payload, startedAt) => {
		const tableRef = table();
		if (!tableRef || payload === null || payload === undefined) return;
		const text = raw.body.toString('utf8');
		if (text.length > MAX_CACHED_BODY) return;
		const record = {
			body: text,
			contentType: raw.contentType,
			startedAt,
			bornAt: startedAt - (ageOf(payload) ?? 0),
		};
		// Detached: the write must not join (and be reaped with) the request's transaction.
		Promise.resolve(detach(() => tableRef.put(key, record))).catch((e) =>
			log?.warn?.(`[prerender-console] read cache store failed for ${key}: ${e?.message ?? String(e)}`)
		);
	};

	/** The leader's fetch: the one request that goes to the node, which every concurrent reader rides. */
	const lead = async (key, origin, path, cookie) => {
		const startedAt = now();
		const flight = { startedAt, promise: fetch(origin, path, cookie) };
		inflight.set(key, flight);
		let raw;
		try {
			raw = await flight.promise;
		} finally {
			if (inflight.get(key) === flight) inflight.delete(key);
		}
		const answer = answerOf(raw);
		if (raw.status === 200) {
			confirm(origin, cookie);
			store(key, raw, answer.payload, startedAt);
		} else if (raw.status === 401 || raw.status === 403) {
			forget(origin, cookie);
		}
		return answer;
	};

	return {
		confirm,
		forget,

		/** One read of one node: from the table, from a fetch already in flight, or from the node. */
		async read(origin, route, query, cookie) {
			const path = route + (query ? `?${query}` : '');
			const ttl = ttlFor(route);
			const tableRef = enabled() ? table() : null;
			if (!tableRef || ttl <= 0) return answerOf(await fetch(origin, path, cookie));

			const key = cacheKeyFor(origin, path);
			const [entry, generation] = await Promise.all([safeGet(tableRef, key), generationOf(tableRef)]);
			const at = now();
			if (isFresh(entry, { ttl, now: at, generation }) && (await vouched(origin, cookie))) {
				const hit = hitOf(entry, now());
				if (hit) return hit;
			}

			const flight = inflight.get(key);
			if (flight && flight.startedAt >= generation && (await vouched(origin, cookie))) {
				// A transport failure is the node's state at this moment, for every rider alike — rethrown,
				// not retried. A 401/403 is about the LEADER's token, so a rider asks with its own.
				const raw = await flight.promise;
				if (raw.status !== 401 && raw.status !== 403) return answerOf(raw);
			}
			return lead(key, origin, path, cookie);
		},

		/**
		 * A write went through this console: every entry fetched before now is stale. Awaited by the
		 * POST before it answers, so the reload that follows cannot read the old generation.
		 */
		async noteWrite() {
			const at = now();
			localGeneration = Math.max(localGeneration, at);
			inflight.clear();
			const tableRef = table();
			if (!tableRef) return;
			try {
				await detach(() => tableRef.put(GENERATION_KEY, { body: null, contentType: null, startedAt: at, bornAt: at }));
			} catch (e) {
				log?.warn?.(
					`[prerender-console] write generation not stored; other workers may serve pre-write reads for up to their TTL: ${e?.message ?? String(e)}`
				);
			}
		},
	};
}
