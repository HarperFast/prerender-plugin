/**
 * THE NEGATIVE CACHE: answering a repeat request for a URL the origin says does not exist from the
 * origin's own stored 404/410, instead of asking the origin again.
 *
 * ── WHAT THIS IS FOR ─────────────────────────────────────────────────────────────────────────
 *
 * Crawlers keep asking for URLs that stopped existing long ago, and they re-ask on a schedule. On the
 * deployment this was built for, origin 404s were a third of every origin fetch, a dead product page
 * cost the origin nearly a full page build, and one crawler re-asked each dead URL about every 55
 * minutes. Each repeat is an origin request that can only answer what it answered last time.
 *
 * ── THREE WINDOWS, FROM THE LAST TIME THE ORIGIN CONFIRMED THE STATUS (`checkedAt`) ──────────
 *
 *   fresh       inside `freshMs`: answer from storage, ask nobody. The only part that saves origin load.
 *   revalidate  past `freshMs`, inside `lifeMs`: answer from storage AT ONCE and re-check the origin in
 *               the background with a HEAD. A 404/410 refreshes `checkedAt`; a 200 or a redirect drops
 *               the entry, so the next request sees the live page; anything else (5xx, a timeout) leaves
 *               it serving until its life ends. This buys response time and fast recovery, not offload.
 *   expired     past `lifeMs`: proxy as if nothing were stored, and a 404 stores again.
 *
 * The BODY has a life too. A confirmation moves `checkedAt` and nothing else, so a URL crawlers keep
 * asking for would otherwise answer with its first body forever. Once the bytes are older than `lifeMs`
 * (`storedAt`), the next check that goes to the origin anyway replaces them: the re-check is a GET instead
 * of a HEAD, and a proxied 404 is stored whole instead of confirmed. No extra origin request, and no body
 * is ever served more than about twice `lifeMs` old.
 *
 * ── WHAT IT MUST NEVER DO ────────────────────────────────────────────────────────────────────
 *
 * Answer for a URL that exists. So it only ever replaces an origin proxy on a TRUE miss (nothing in
 * `PrerenderedPage`, and the raw cache had nothing either); it never answers for a URL whose Target a
 * sitemap lists, checked on every read and not only at store time, because a sitemap listing is the
 * origin declaring the page exists and it outranks a stored 404; and it never answers a bot in
 * `excludeBots`. A wrong entry is corrected on the node that holds it — the rows are node-local — by the
 * proxied answer or the background re-check, so nothing ever has to reach across the cluster.
 *
 * Count honestly. A fresh answer is `bot_serve` source `negative`. An answer whose background re-check
 * went to the origin is source `origin`, cacheStatus `negative-revalidate`: the crawler did not wait,
 * but the origin did the work, and offload is about the origin. Folding those into `negative` would make
 * gross offload rise while the origin saw exactly as many requests as before.
 */

import { config } from '../config.js';
import { metrics } from '../metrics.js';
import { Target } from '../resources/Target.js';
import { materializeCachedBody } from './cachedBody.js';
import { dateColumnMs } from './time.js';
import { fetchOriginResource, releaseOriginBody } from './upstream.js';
import {
	collectBody,
	discardStream,
	hasCacheControlDirective,
	storableBody,
	teeForCapture,
	unsharedHint,
} from './rawCache.js';

const table = () => databases.negative_cache.NegativePage;

/**
 * The route's negative-cache policy for this request, or null when nothing should happen. Both switches,
 * for the same reason as `rawCachePolicy`: a route carrying `negativeCache: true` through a deployment
 * where the feature is off must mean exactly nothing.
 */
export const negativeCachePolicy = (entry) => {
	const negative = config.render.negative;
	if (!negative?.enabled) return null;
	if (!entry?.negativeCache) return null;
	return negative;
};

/** The storage key: the per-device cacheKey, or the device-free URL under `deviceIndependent`. */
export const negativeKeyOf = ({ cacheKey, cacheUrl }, policy) => (policy?.deviceIndependent ? cacheUrl : cacheKey);

// `excludeBots`, compiled to a lowercase-keyed Map and cached on the IDENTITY of the config array, the same
// idiom as the discovery allowlist: applyOptions replaces config on every change, so an identity check
// notices an edit and costs one comparison on the request path. The value is the CONFIGURED spelling: a
// bot name derived from the UA keeps the UA's own casing, and the metrics must not split one listed bot
// into several series by it.
let excludedFrom;
let excluded = new Map();

/** The `excludeBots` entry `botName` matches, in its configured spelling, or null when it may read. */
export const excludedBotName = (botName, policy) => {
	if (policy.excludeBots !== excludedFrom) {
		excludedFrom = policy.excludeBots;
		excluded = new Map(
			(Array.isArray(excludedFrom) ? excludedFrom : [])
				.filter((name) => typeof name === 'string' && name !== '')
				.map((name) => [name.toLowerCase(), name])
		);
	}
	return typeof botName === 'string' ? (excluded.get(botName.toLowerCase()) ?? null) : null;
};

/** May a request from `botName` be answered from a stored response? */
export const botMayReadNegative = (botName, policy) => excludedBotName(botName, policy) === null;

/**
 * Which window a stored row is in, for a request arriving at `nowMs`: 'fresh' | 'revalidate' | 'expired'.
 *
 * An unreadable `checkedAt`, or one in the future, is 'expired'. Fail closed: the cost is one proxied
 * request, and the alternative — a NaN age compares false against every bound — would be a row that
 * answers forever.
 */
export const negativeFreshness = (row, policy, nowMs = Date.now()) => {
	const age = nowMs - dateColumnMs(row?.checkedAt);
	if (!(age >= 0)) return 'expired';
	if (age < policy.freshMs) return 'fresh';
	if (age < policy.lifeMs) return 'revalidate';
	return 'expired';
};

/**
 * Have the stored BYTES outlived `lifeMs`? Then the next check that asks the origin replaces them rather
 * than confirming them. An unreadable `storedAt` counts as outlived, for the reason `negativeFreshness`
 * fails closed: the cost is one body rewrite.
 */
export const negativeBodyExpired = (row, policy, nowMs = Date.now()) =>
	!(nowMs - dateColumnMs(row?.storedAt) < policy.lifeMs);

/**
 * A stored row for this key, or null when there is none, it has expired, or it is not a whole answer.
 *
 * The status check is not paranoia: a background confirm is a `patch`, and a patch racing a drop can
 * leave a row carrying only its timestamps. Answering that would hand a crawler a response with no
 * status; reading it as absent just proxies.
 */
export const readNegativePage = async (key) => {
	let row;
	try {
		row = await table().get(key);
	} catch (e) {
		// A read failure is a miss, and a miss proxies. Never a 500 for a crawler over an optimisation.
		logger.warn?.(`[prerender] negative-cache entry unreadable for ${key}: ${e?.message ?? String(e)}`);
		return null;
	}
	if (!row) return null;
	if (!(dateColumnMs(row.expiresAt) > Date.now())) return null;
	if (!Number.isInteger(row.statusCode)) return null;
	return row;
};

/**
 * Does a Target say this URL must not be answered from a stored response? 'listed' | 'target' | 'error'
 * | null. A LOCAL read: Target replicates to every node, and a point read of it never waits on another.
 */
export const targetGuard = async (cacheUrl, policy) => {
	let target;
	try {
		target = await Target.get({ id: cacheUrl, select: ['sitemapUrl', 'state'] });
	} catch {
		return 'error';
	}
	if (!target) return null;
	if (target.sitemapUrl) return 'listed';
	return policy.skipTargets === 'any' ? 'target' : null;
};

/**
 * May this origin response be stored? The reason it may not, or null. Every branch names itself, so
 * `negative_cache` reports why a route fills nothing rather than merely that it doesn't.
 *
 * `no-store` is refused unless `ignoreNoStore`: the raw cache always honours it, and an origin whose
 * `no-store` means something must keep that. It is a switch here because some origins send it on every
 * document while a CDN — and this plugin's own page cache — keep them anyway.
 */
export const negativeStoreRefusal = (resource, policy) => {
	if (!policy.statuses.includes(resource.statusCode)) return 'not-negative';
	if (resource.viaStaging) return 'staging';
	const unshared = unsharedHint(resource);
	if (unshared === 'set-cookie' && !policy.assumeShared) return 'has-cookie';
	if (unshared === 'private' && !policy.assumeShared) return 'private';
	if (!policy.ignoreNoStore && hasCacheControlDirective(resource.headers?.['cache-control'], 'no-store')) {
		return 'no-store';
	}
	return null;
};

/** Store a captured response. Best-effort: every failure is counted and swallowed (it runs detached). */
export const storeNegativePage = async ({ key, resource, bytes, policy, nowMs = Date.now() }) => {
	try {
		// An uncompressed 404 is gzipped before it is stored (see `storableBody`): the origin this was
		// built for sends every 404 uncompressed, 79-699 KB, while its 200s arrive gzipped.
		const stored = await storableBody(resource.headers, bytes);
		await table().put(key, {
			statusCode: resource.statusCode,
			headers: JSON.stringify(stored.headers),
			content: createBlob(stored.bytes),
			storedAt: new Date(nowMs),
			checkedAt: new Date(nowMs),
			expiresAt: new Date(nowMs + policy.lifeMs),
		});
		metrics.negativeCache(unsharedHint(resource) ? 'stored-unshared' : 'stored');
	} catch (e) {
		metrics.negativeCache('write-failed');
		logger.warn?.(`[prerender] negative-cache entry not stored for ${key}: ${e?.message ?? String(e)}`);
	}
};

/**
 * The origin just confirmed the status again: restart the fresh window and extend the life. A patch, so
 * the stored body is left alone; `@expiresAt` re-stamps the record's expiry from the field on every
 * store, patches included.
 */
export const confirmNegativePage = async (key, policy, nowMs = Date.now()) => {
	try {
		await table().patch(key, { checkedAt: new Date(nowMs), expiresAt: new Date(nowMs + policy.lifeMs) });
	} catch (e) {
		metrics.negativeCache('write-failed');
		logger.warn?.(`[prerender] negative-cache entry not refreshed for ${key}: ${e?.message ?? String(e)}`);
	}
};

/** The stored answer is wrong or unwanted. Best-effort: a row that survives is corrected by its next read. */
export const dropNegativePage = async (key) => {
	try {
		await table().delete(key);
	} catch (e) {
		logger.warn?.(`[prerender] negative-cache entry not dropped for ${key}: ${e?.message ?? String(e)}`);
	}
};

/**
 * In-flight captures, capped per worker for the reason `render.raw.maxConcurrentCaptures` gives: a capture
 * reads in a tight loop and removes the crawler's backpressure, so past the cap a response is served and
 * not stored rather than letting slow clients turn this worker's heap into the buffer.
 */
let inFlightCaptures = 0;
export const negativeCaptureSlotsInUse = () => inFlightCaptures;

/**
 * Attach a capture to a proxied 404/410, returning the resource with its body replaced by the branch the
 * crawler will read — or a promise of it, when the Target guard has to be read first.
 *
 * THE GUARD IS READ BEFORE THE BODY IS TEED, NOT AFTER IT IS BUFFERED. The other order teed and read every
 * byte of the 404 into memory and only then asked whether it could be kept — so for a URL a sitemap lists,
 * which answers 404 on EVERY request and is refused on every one, each request paid a tee, a full buffer
 * and a capture slot for a store that could never happen. The read was already made per capture, so this
 * adds no read; it moves one local point read in front of the response of a 404 that has no stored entry.
 * `guarded` is the verdict the lookup already read (`answerFromNegativeCache`), when it read one, so that
 * request pays no second read. The store itself stays detached: a write in front of a crawler's body is
 * latency the crawler pays for a benefit only the next crawler gets.
 */
export const captureForNegativeCache = (resource, { key, cacheUrl, policy, guard = targetGuard, guarded }) => {
	const refusal = negativeStoreRefusal(resource, policy);
	if (refusal) {
		metrics.negativeCache(refusal);
		return resource;
	}
	if (typeof resource.content?.tee !== 'function') {
		metrics.negativeCache('no-body');
		return resource;
	}
	if (guarded !== undefined) return attachNegativeCapture(resource, { key, policy, guarded });
	// Rejection is mapped to the guard's own failure verdict: this promise is now on the response path, so
	// a throw here would turn the crawler's 404 into a 500.
	return guard(cacheUrl, policy).then(
		(verdict) => attachNegativeCapture(resource, { key, policy, guarded: verdict }),
		() => attachNegativeCapture(resource, { key, policy, guarded: 'error' })
	);
};

const attachNegativeCapture = (resource, { key, policy, guarded }) => {
	if (guarded) {
		// The body is untouched: the crawler reads the origin's stream directly, and nothing is buffered.
		metrics.negativeCache(guarded === 'error' ? 'guard-error' : `skipped-${guarded}`);
		return resource;
	}
	if (inFlightCaptures >= policy.maxConcurrentCaptures) {
		metrics.negativeCache('capture-busy');
		return resource;
	}

	let downstream, captured;
	try {
		({ downstream, captured } = teeForCapture(resource.content, policy.maxBytes));
	} catch (e) {
		// Before the slot is taken: a tee that throws (a stream something already locked) must neither cost
		// the crawler its response nor keep a slot nobody will ever return.
		metrics.negativeCache('capture-failed');
		logger.warn?.(`[prerender] negative-cache capture not attached for ${key}: ${e?.message ?? String(e)}`);
		return resource;
	}
	inFlightCaptures++;
	captured
		.then((result) => {
			// `.length`, not truthiness — an empty Buffer is truthy (see captureForRawCache).
			if (!result.bytes?.length) {
				metrics.negativeCache(result.bytes ? 'empty' : result.outcome);
				return;
			}
			return storeNegativePage({ key, resource, bytes: result.bytes, policy });
		})
		.catch((e) => logger.warn?.(`[prerender] negative-cache capture failed: ${e?.message ?? String(e)}`))
		// ALWAYS: a slot that is not returned is a permanent reduction in what this worker will ever store.
		.finally(() => {
			inFlightCaptures--;
		});

	// Released by draining, not destroying, for the reason `captureForRawCache` gives.
	return { ...resource, content: downstream, releaseBody: () => discardStream(downstream) };
};

// What a background re-check sends. There is no request to borrow headers from — the one that triggered
// it has already been answered — so it carries only what the origin fetch adds itself (user agent per
// device, the bypass token, accept-encoding) plus an `accept`. `get` answers null so the staging toggle,
// which reads a request header, can never switch a re-check to the staging edge.
const RECHECK_HEADERS = Object.freeze({ asObject: Object.freeze({ accept: 'text/html' }), get: () => null });

/** Re-checks in flight, by key: one per URL per worker, and at most `maxConcurrentChecks` at once. */
const inFlightChecks = new Map();
export const negativeRechecksInFlight = () => inFlightChecks.size;

/**
 * Act on what a re-check found. Exported for tests; `startNegativeRecheck` is the caller.
 *
 * `onLive` hears about a 200 so a gone-suppressed target for the URL can be reopened (util/goneReopen.js):
 * the entry going away fixes what this node SERVES, and only a render fixes what the rotation HOLDS.
 */
export const settleNegativeRecheck = async ({ key, cacheUrl, statusCode, policy, onLive, nowMs = Date.now() }) => {
	if (policy.statuses.includes(statusCode)) {
		await confirmNegativePage(key, policy, nowMs);
		metrics.negativeCache('recheck-gone');
		return 'gone';
	}
	if (statusCode >= 200 && statusCode < 300) {
		await dropNegativePage(key);
		metrics.negativeCache('recheck-live');
		if (statusCode === 200 && onLive) {
			try {
				await onLive(cacheUrl);
			} catch (e) {
				logger.warn?.(`[prerender] reopen after a live re-check failed for ${cacheUrl}: ${e?.message ?? String(e)}`);
			}
		}
		return 'live';
	}
	if (statusCode >= 300 && statusCode < 400) {
		await dropNegativePage(key);
		metrics.negativeCache('recheck-moved');
		return 'moved';
	}
	// 5xx, 429, 403, or no status: the origin failed to answer, it did not say the page exists. Keep
	// answering until the life ends — this is the stale-if-error half, and why a sick origin sees the
	// re-checks and nothing more.
	metrics.negativeCache('recheck-error');
	return 'error';
};

/**
 * A GET re-check found the page still gone, and the stored bytes had outlived `lifeMs`: store the origin's
 * answer whole. A response this cache may no longer keep (the origin now marks it private, say) or cannot
 * read drops the entry instead — confirming it would keep serving the outlived bytes, which is the one
 * thing this path exists to stop. Exported for tests; `startNegativeRecheck` is the caller.
 */
export const refreshNegativeBody = async ({ key, resource, policy, nowMs = Date.now() }) => {
	metrics.negativeCache('recheck-gone');
	const refusal = negativeStoreRefusal(resource, policy);
	if (refusal || typeof resource.content?.getReader !== 'function') {
		releaseOriginBody(resource);
		metrics.negativeCache(refusal ?? 'no-body');
		await dropNegativePage(key);
		return 'dropped';
	}
	const result = await collectBody(resource.content, policy.maxBytes);
	if (!result.bytes?.length) {
		metrics.negativeCache(result.bytes ? 'empty' : result.outcome);
		await dropNegativePage(key);
		return 'dropped';
	}
	await storeNegativePage({ key, resource, bytes: result.bytes, policy, nowMs });
	return 'refreshed';
};

/**
 * Start a background re-check of a stored response, unless one is already running for this key or the
 * per-worker cap is reached. Returns whether THIS call started one — the caller reports the request as
 * `negative-revalidate` (source origin) only then, so bot_serve and origin_fetch agree one for one.
 *
 * A HEAD, unless `refreshBody` (the stored bytes have outlived `lifeMs`): then a GET, whose 404 replaces
 * them. Bounded like a capture — `maxBytes` per check, `maxConcurrentChecks` checks.
 *
 * Per worker, not per node: two workers can re-check the same key at once. That is at most one extra
 * request per worker per key, and coordinating across threads would cost more than it saves.
 */
export const startNegativeRecheck = ({
	key,
	url,
	cacheUrl,
	deviceType,
	policy,
	onLive,
	refreshBody = false,
	fetchOrigin = fetchOriginResource,
}) => {
	if (inFlightChecks.has(key)) {
		metrics.negativeCache('recheck-joined');
		return false;
	}
	if (inFlightChecks.size >= policy.maxConcurrentChecks) {
		metrics.negativeCache('recheck-busy');
		return false;
	}
	const run = (async () => {
		let resource;
		try {
			resource = await fetchOrigin({
				url,
				deviceType,
				method: refreshBody ? 'GET' : 'HEAD',
				headers: RECHECK_HEADERS,
				reason: 'revalidate',
			});
		} catch (e) {
			metrics.negativeCache('recheck-error');
			logger.warn?.(`[prerender] negative-cache re-check failed for ${key}: ${e?.message ?? String(e)}`);
			return;
		}
		if (refreshBody && policy.statuses.includes(resource.statusCode)) {
			await refreshNegativeBody({ key, resource, policy });
			return;
		}
		// A HEAD has no body, and a GET that is not storing one has nothing to read, but either stream still
		// has to be closed to release the socket — by destroying the source, not cancelling the web stream
		// (see `releaseOriginBody`), and not awaited, so nothing can pin the re-check slot.
		releaseOriginBody(resource);
		await settleNegativeRecheck({ key, cacheUrl, statusCode: resource.statusCode, policy, onLive });
	})()
		.catch((e) => logger.warn?.(`[prerender] negative-cache re-check failed for ${key}: ${e?.message ?? String(e)}`))
		.finally(() => inFlightChecks.delete(key));
	inFlightChecks.set(key, run);
	return true;
};

/**
 * Try to answer this request from a stored response.
 *
 * Returns `{ answered: true, resource, body, cacheStatus, source }` when it did, and otherwise what the
 * lookup found — `{ row, verdict, excluded }` — for `afterNegativeProxy` to act on once the origin has
 * answered. Every refusal is counted by name.
 *
 * `epochOf` resolves the route's bulk-invalidation epoch; a stored response confirmed before it is not
 * answered, the same rule the raw cache follows, so an operator's invalidation reaches these too.
 */
export const answerFromNegativeCache = async ({
	key,
	cacheUrl,
	url,
	deviceType,
	method,
	botName,
	policy,
	epochOf = async () => null,
	onLive,
	recheck = startNegativeRecheck,
	guard = targetGuard,
	nowMs = Date.now(),
}) => {
	const row = await readNegativePage(key);
	if (!row) return { row: null, verdict: null };

	const checkedAtMs = dateColumnMs(row.checkedAt);
	// Every request that found a stored 404, armed or not, excluded or not: the gap since the origin last
	// confirmed it is the crawlers' re-ask curve, which is what `freshMs` should be chosen from.
	if (Number.isFinite(checkedAtMs)) metrics.negativeGap(Math.max(0, nowMs - checkedAtMs));

	const verdict = negativeFreshness(row, policy, nowMs);
	if (verdict === 'expired') return { row, verdict };

	// BEFORE the bot and Target checks, and not only as a guard on answering. A refused row must reach
	// `afterNegativeProxy` as expired for EVERY request, so the proxied 404 stores afresh; a row that went
	// on as 'fresh' for an excluded bot would be CONFIRMED by that bot's proxied 404, moving `checkedAt`
	// past the epoch and making the pre-invalidation bytes answerable again.
	const epoch = await epochOf();
	if (epoch && !(checkedAtMs > epoch.at)) {
		metrics.negativeCache('invalidated');
		return { row, verdict: 'expired' };
	}

	// THE TARGET GUARD BEFORE THE BOT CHECK, so an excluded bot's request is judged against the same row a
	// readable bot's would be. A row a listed Target overrules answers nobody, and counting it for an excluded
	// bot made `excluded-live` report a relisted product the sitemap had already protected.
	const guarded = await guard(cacheUrl, policy);
	if (guarded === 'error') {
		// Fail closed: proxy. The row stays; its next read decides again.
		metrics.negativeCache('guard-error');
		return { row, verdict, excluded: true };
	}
	// `guarded` rides along past this point so `afterNegativeProxy` does not read the same Target again
	// before deciding whether to capture: this request's verdict is already in hand.
	if (guarded) {
		metrics.negativeCache(`guarded-${guarded}`);
		void dropNegativePage(key);
		return { row: null, verdict: null, guarded };
	}

	const excludedBot = excludedBotName(botName, policy);
	if (excludedBot) {
		// The bot name only on a GET: those are the requests `excluded-live` can judge (a HEAD's 200 proves
		// nothing about the page), so the named rows are exactly its denominator.
		metrics.negativeCache('bot-excluded', method === 'HEAD' ? null : excludedBot);
		return { row, verdict, excluded: true, excludedBot };
	}

	if (policy.dryRun) {
		metrics.negativeCache(verdict === 'fresh' ? 'would-serve' : 'would-revalidate');
		return { row, verdict, guarded };
	}

	// Read the body before committing to the answer, as the page and raw paths do: an unreadable blob
	// becomes an ordinary proxy, and the proxied 404 stores a readable one.
	const body = await materializeCachedBody(row, method);
	if (!body.ok) {
		metrics.negativeCache('read-blob-failed');
		return { row, verdict: 'expired', guarded };
	}

	const started =
		verdict === 'revalidate'
			? recheck({
					key,
					url,
					cacheUrl,
					deviceType,
					policy,
					onLive,
					refreshBody: negativeBodyExpired(row, policy, nowMs),
				})
			: false;
	return {
		answered: true,
		resource: {
			statusCode: row.statusCode,
			headers: row.headers,
			lastCached: row.storedAt,
			deviceType,
			url: cacheUrl,
		},
		body: body.body,
		cacheStatus: started ? 'negative-revalidate' : 'negative',
		source: started ? 'origin' : 'negative',
	};
};

/**
 * After a request the negative cache did not answer has been proxied: store a 404 that has no entry,
 * refresh one the origin just confirmed, drop one the origin just contradicted. Returns the resource the
 * crawler will read (teed when a capture is attached), or a promise of it while the Target guard is read.
 *
 * THE DRY RUN'S ONE SUBTLETY: a proxied 404 may refresh `checkedAt` only where an ARMED cache would have
 * asked the origin too. Refreshing on every request would restart the fresh window on requests an armed
 * cache answers from storage, and `would-serve` would stop being exactly what arming saves.
 *
 * Where it does refresh, bytes that have outlived `lifeMs` are replaced by the ones just proxied rather
 * than confirmed — what an armed cache's GET re-check does, here for free.
 */
export const afterNegativeProxy = (
	resource,
	{ key, cacheUrl, policy, lookup = {}, method = 'GET', nowMs = Date.now() }
) => {
	const { row = null, verdict = null, excluded = false, excludedBot = null, guarded } = lookup;
	const status = resource.statusCode;

	if (policy.statuses.includes(status)) {
		// A HEAD carries no body: it can confirm a stored answer's status, as the background HEAD re-check
		// does, but it can never supply one. Capturing it would store an empty 404 — or, for bytes that have
		// outlived `lifeMs`, confirming would keep serving them; so where a body is needed it does neither.
		const head = method === 'HEAD';
		if (!row || verdict === 'expired') {
			return head ? resource : captureForNegativeCache(resource, { key, cacheUrl, policy, guarded });
		}
		const armedWouldAsk = excluded || !policy.dryRun || verdict !== 'fresh';
		if (!armedWouldAsk) return resource;
		if (negativeBodyExpired(row, policy, nowMs)) {
			return head ? resource : captureForNegativeCache(resource, { key, cacheUrl, policy, guarded });
		}
		void confirmNegativePage(key, policy, nowMs);
		return resource;
	}

	// A HEAD's 2xx/3xx neither drops the entry nor counts against it: an origin's HEAD handler is not the
	// page (plenty answer 200 to any path), so it may CONFIRM a stored 404 above but cannot overturn one.
	// The next GET, or the background re-check, decides.
	if (row && method !== 'HEAD') {
		// THE RISK NUMBER: an armed cache would have answered this request with the stored 404 (or answered
		// it at once and only then re-checked), and the origin, asked anyway, says the page is live.
		// LIVE = a 200, or a 304: the origin saying the crawler's own copy of a live page is current. A 3xx
		// redirect drops the entry below but is not counted, since the page moved rather than came back.
		const live = status === 200 || status === 304;
		const wouldAnswer = verdict === 'fresh' || verdict === 'revalidate';
		if (policy.dryRun && !excluded && live && wouldAnswer) {
			metrics.negativeCache('would-serve-live');
		}
		// THE SAME RISK FOR AN EXCLUDED BOT, armed or not: the stale 404 an answer from storage would have
		// given it. Its request always reaches the origin, so this is observed for free, and it is the number
		// that decides whether a bot can leave `excludeBots`. Keyed on the bot rather than on `excluded`,
		// which a guard error sets too; the guard already ran, so a row a listed Target overrules never gets here.
		if (excludedBot && live && wouldAnswer) {
			metrics.negativeCache('excluded-live', excludedBot);
		}
		if (status >= 200 && status < 400) void dropNegativePage(key);
	}
	return resource;
};
