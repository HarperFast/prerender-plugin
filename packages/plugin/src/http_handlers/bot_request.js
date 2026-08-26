import { setTimeout as sleep } from 'node:timers/promises';
import { CacheKey } from '../util/cacheKey.js';
import { getBotName, botMayDiscover, botCountsAsDemand } from '../util/userAgent.js';
import { isPrerenderCandidate } from '../util/indexSignals.js';
import { canonicalizeUrl } from '../util/url.js';
import { config } from '../config.js';
import { sanitizeDeviceType } from '../util/device_type.js';
import { resolveForwardedRequest } from '../util/ingress.js';
import {
	classifyPath,
	isForwardedMode,
	resolveEffectiveInterval,
	routeScopeForEntry,
	PRERENDER,
} from '../util/routeClass.js';
import { Target } from '../resources/Target.js';
import { QueueState } from '../resources/QueueState.js';
import { fetchOriginResource } from '../util/upstream.js';
import { PrerenderedPage } from '../resources/PrerenderedPage.js';
import { resolveServingPolicy, pollForFreshRender } from '../util/renderNow.js';
import { resolveServeStatus } from '../util/pageFreshness.js';
import { resolveInvalidation } from '../util/invalidation.js';
import { maybeAccelerateHeal } from '../util/invalidationReenqueue.js';
import { currentMinuteMs } from '../util/time.js';
import { writeSchedule } from '../util/renderSchedule.js';
import { recordCrawl } from '../util/crawlStats.js';
import { metrics } from '../metrics.js';
import { recordVisit } from '../util/visitFilter.js';
import { materializeCachedBody } from '../util/cachedBody.js';
import { rescueFromOwner } from '../util/peerRescue.js';
import { deliverResource } from './response.js';

export async function handleBotRequest(request) {
	request.handlerPath = 'p';

	try {
		const target = resolveBotTarget(request);
		if (!target) {
			return { headers: {}, status: 400 };
		}
		const { url, cacheUrl, deviceType, routeClass, route } = target;

		request.botName = getBotName(request.headers);
		const recordBots = config.analytics.enabled && (request.botName !== 'other' || config.analytics.recordUnmatched);
		if (recordBots) {
			metrics.botRequest(url.hostname, request.botName, deviceType);
			// Crawl breadth (distinct URLs per bot per day): one hash + one byte max into a
			// per-thread HLL sketch — see util/crawlStats.js for the cost/loss model.
			recordCrawl(request.botName, cacheUrl);
		}

		// Debug/observability info surfaced as x-harper-* response headers (only when the
		// debug header is present). `route` is the matched route entry, if any; `routeClass`
		// decides whether this request is cached and scheduled at all.
		const info = { route, routeClass };

		const resource = await resolveResource({ request, url, cacheUrl, deviceType, routeClass, info });
		maybeSchedule(resource, routeClass, route, request.botName);
		recordDemand({ resource, routeClass, route, cacheUrl, botName: request.botName, cacheStatus: info.cacheStatus });
		// DEMAND-DRIVEN HEAL, default off and a no-op unless an invalidation is what cost this request
		// its cache serve (`info.invalidatedBy` is set only when the epoch was consulted, which happens
		// only when the page would otherwise have been served). Detached inside, like maybeSchedule —
		// and gated on the same `routeClass`, since a passthrough route still serves from cache.
		maybeAccelerateHeal({
			url: cacheUrl,
			cacheKey: info.cacheKey,
			invalidatedBy: info.invalidatedBy,
			routeClass,
		});
		if (recordBots) {
			recordServeOutcome(resource, request, info, deviceType);
		}

		return deliverResource(resource, request, info);
	} catch (e) {
		logger.error(e);
		return {
			headers: {},
			status: 500,
		};
	}
}

// Serve-outcome analytics, recorded once the request has resolved to a resource. `bot_request`
// (above, at ingress) is raw bot volume; this is what actually answered the request — the
// rollout success metrics. What each one MEANS and what a dashboard does with it lives in the
// catalog (`src/metrics.js`), which is also what `GET /prerender_admin/metrics` serves; this
// comment covers only why the emissions are shaped this way HERE.
//
// FOUR METRICS RATHER THAN TWO WITH MORE DIMENSIONS, because recordAnalytics has exactly three
// dimension slots (path/method/type) and bot_serve's are all taken. The per-route variants carry
// the route label instead of the bot, which is what makes each route's renderInterval tunable
// independently. The route label is the matched route's path ('/', '/catalog/', '/product/prd-' —
// tiny, stable cardinality), else the route class for passthrough, else 'unrouted'.
//
// Cost: two counter bumps per request plus two numeric samples on a cache hit (recordAnalytics
// buffers in a Map and flushes on Harper's analytics timer) — no storage touch, no await,
// nothing added to response latency.
//
// Exported for tests, which assert the emissions this function makes per outcome.
export function recordServeOutcome(resource, request, info, deviceType) {
	const route = info.route?.path ?? info.routeClass ?? 'unrouted';
	metrics.botServe(info.source, info.cacheStatus, request.botName);
	metrics.routeServe(route, info.cacheStatus, deviceType);
	if (info.source === 'cache' && resource.lastCached) {
		// lastCached is a schema Date — guard truthiness FIRST, then coerce, exactly like the
		// expiresAt read above: `new Date(null)` is epoch 0 (not NaN), so an unguarded null
		// would record age ≈ Date.now() and poison the metric. Past the guard, a Date, number,
		// or serialized string all compare correctly; a malformed value yields NaN, and a
		// negative age (cross-node clock skew on a page another node just wrote) would poison
		// the mean — both fail the >= 0 check and record nothing.
		const age = Date.now() - new Date(resource.lastCached).getTime();
		if (age >= 0) {
			metrics.pageAge(age, request.botName, deviceType);
			metrics.routePageAge(age, route, info.cacheStatus, deviceType);
		} else {
			// COUNT the discards instead of throwing them away. A negative age is a page whose
			// `lastCached` is in this node's future, i.e. cross-node clock skew — and that is the only
			// evidence anywhere of how large the skew actually is. `invalidation.pad` exists partly to
			// cover it and its default is otherwise justified only by the in-flight-render argument,
			// which is certain but bounds a different quantity. One counter, and the number stops being
			// silently discarded on every served request.
			metrics.pageAgeNegative(request.botName, deviceType);
		}
	}
}

// Resolve the request into { url, cacheUrl, deviceType, routeClass, route }, dispatching on
// ingress mode. In 'forwarded' mode isBotRequest already resolved + stashed the target; the
// fallback resolve guards against direct calls. Returns null when a forwarded request
// can't be resolved (e.g. an unusable forwarded host) => the caller 400s.
function resolveBotTarget(request) {
	if (isForwardedMode()) {
		const target = request._prerenderTarget ?? resolveForwardedRequest(request);
		if (!target) return null;
		return {
			url: target.url,
			cacheUrl: target.cacheUrl,
			deviceType: target.deviceType,
			routeClass: target.routeClass,
			route: target.route,
		};
	}

	// Native/prefix mode: the request path (minus the bot prefix) IS the absolute target URL.
	// Classification still applies — it is what carries the folded excludePathPatterns into
	// this mode — but the allowlist stays the global `url.queryParams`, so the key is
	// unchanged. canonicalizeUrl has already proved the URL parses by the time we classify.
	const cacheUrl = canonicalizeUrl(request.url.slice(config.ingress.botPathPrefix.length), config.cacheKey.queryParams);
	const { routeClass, entry } = classifyPath(URL.parse(cacheUrl)?.pathname ?? '/');
	return {
		url: new URL(cacheUrl),
		cacheUrl,
		deviceType: sanitizeDeviceType(request.headers.get(config.ingress.deviceTypeHeader)),
		routeClass,
		route: entry,
	};
}

// Resolve the resource to serve: an origin proxy for non-GET/HEAD, else a fresh cache hit,
// an on-demand render, or an origin proxy per the miss mode. Populates the debug `info`
// (cacheKey/url/cacheStatus/source/renderNowStatus) as a side effect.
async function resolveResource({ request, url, cacheUrl, deviceType, routeClass, info }) {
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		logger.warn(`Unexpected Request ${request.method} ${url}`);
		info.cacheStatus = 'bypass';
		info.source = 'origin';
		return fetchOriginResource({
			url,
			deviceType,
			method: request.method,
			headers: request.headers,
			body: request._nodeRequest,
			reason: 'bypass',
		});
	}

	// `cacheUrl` is the canonical URL-half (already computed at ingress); it IS the cache-key
	// url component, so no re-normalization here. Recorded even for a class we never cache,
	// because "what key WOULD this be" is the first thing to check when a URL unexpectedly
	// isn't being served from cache.
	const cacheKey = CacheKey.toCacheKey({ url: cacheUrl, deviceType });
	info.cacheKey = cacheKey;
	info.url = cacheUrl;

	// Note a non-prerender class still SERVES from cache here — it only never populates one
	// (`maybeSchedule` below). See resolveServingPolicy for why that matters.
	const { skipCache, missMode, missModeExplicit } = resolveServingPolicy(routeClass, request.method, request.headers);

	const page = skipCache ? null : await PrerenderedPage.get(cacheKey);
	// expiresAt is a schema `Date` (stored from Date.now()); read it robustly so a Date,
	// number, or serialized string all compare correctly — cf. the Number() coercion in
	// util/renderNow.js. A bad/missing value yields NaN => not servable from cache.
	const expiresAtMs = page && page.expiresAt ? new Date(page.expiresAt).getTime() : NaN;
	// Threaded from here rather than re-parsed: `lastCached` was being turned into a number two to
	// three times per served request across this file and response.js.
	const lastCachedMs = page && page.lastCached ? new Date(page.lastCached).getTime() : NaN;
	const now = Date.now();

	// READ THE EPOCH ONLY WHEN THIS REQUEST WOULD OTHERWISE HAVE BEEN A CACHE SERVE. Invalidation has
	// one mode and can only ever DEMOTE, so gating on "would have served" costs no correctness at all,
	// while a miss, a cache skip, a non-GET, a page already past its SWR window, and
	// `invalidation.enabled: false` every one of them pay ZERO added cost. The gate is also what makes
	// the `invalidated` counter mean "cache serves this invalidation is costing us" rather than an
	// unbounded tally of every stale key in the scope.
	// `info.route` is the entry matched at ingress, so this costs no second classification and cannot
	// disagree with the route label the metrics already used.
	const epoch =
		page && expiresAtMs + config.page.swrTtl > now ? await resolveInvalidation(routeScopeForEntry(info.route)) : null;

	const { status, servable, invalidatedBy } = resolveServeStatus({
		expiresAtMs,
		lastCachedMs,
		swrTtl: config.page.swrTtl,
		now,
		epoch,
	});
	info.invalidatedBy = invalidatedBy;

	if (servable) {
		// READ THE BODY BEFORE COMMITTING TO THE CACHE SERVE. A record whose blob file is gone
		// (harper#2134: the invalidate path unlinks blobs live records still reference; replication
		// also lands records whose bytes never arrived) used to be discovered only once the body was
		// already streaming — after the status, the headers and the `bot_serve` hit row had all been
		// committed. The crawler got a truncated document under a 200 and every signal said cache
		// hit. Reading here converts that into an ordinary origin serve: correct bytes, and counted.
		//
		// Buffering is affordable BECAUSE OF THE MEASURED SIZE DISTRIBUTION of this corpus: mean
		// 223 KB, p99 322 KB, hard max 420 KB, no tail; a full cold read is p50 0.75 ms / p99
		// 0.94 ms, on the libuv threadpool rather than the event loop. If page bodies ever grow
		// unbounded, revisit — streaming with a first-chunk peek trades this guarantee for memory.
		const cached = await materializeCachedBody(page, request.method);
		if (cached.ok) {
			info.cachedBody = cached.body;
			info.cacheStatus = status;
			info.source = 'cache';
			return page;
		}
		// GONE and SLOW are separated on purpose: they have different causes and different fixes.
		// `blob-missing` is a dangling reference (harper#2134) — the bytes are not coming back, and the
		// page is repaired by its next render. `blob-timeout` is a read still in progress, which in
		// practice means a base copy is streaming that blob right now (harper-pro#683) — the bytes DO
		// arrive, just not within a crawler's patience. Folding them together would have hidden the
		// second behind the first: the timeout cohort only appeared once a copy was running.
		const timedOut = cached.reason === 'timeout';
		// NOT `status` — that name is taken by the freshness verdict from resolveServeStatus above.
		const failStatus = timedOut ? 'blob-timeout' : 'blob-missing';
		// The serve_error counts the LOCAL blob fault and is emitted regardless of how the request is
		// ultimately answered — it is the blob-health signal, not the serve-outcome one (bot_serve is).
		metrics.serveError(timedOut ? 'blob-timeout' : 'blob-unreadable');

		// TRY THE RESIDENCY OWNER BEFORE THE ORIGIN. Both failure modes here are receive-side: the
		// owner granted every render claim for this key (claims are owner-scoped and callbackOrigin
		// points the result back at the granting node), so its blob is a written ORIGINAL, never a
		// received replica — the node most likely to hold complete bytes, a few ms away. The rescue
		// serves the real prerendered snapshot where the origin proxy would serve raw un-prerendered
		// markup, and an intra-cluster fetch is ~50x cheaper than the origin round trip. Inert unless
		// `peerRescue` is configured; origin remains the backstop for every miss (owner is this node,
		// owner unreachable, owner's own read fails).
		const rescue = await rescueFromOwner({ cacheKey, cacheUrl });
		if (rescue.ok) {
			const note = timedOut ? `read exceeded ${config.page.blobReadBudgetMs}ms` : 'unreadable';
			logger.warn(
				`cached blob ${note} for ${cacheKey}; served the owner's copy (${rescue.owner}, ${Math.round(rescue.ms)}ms)`
			);
			info.cachedBody = rescue.body;
			// Its own status rather than the freshness verdict: the rescue rate is the number an
			// operator trends against replication churn, and it must not inflate 'hit'.
			info.cacheStatus = 'peer-rescue';
			info.source = 'cache';
			// A plain view assembled from the OWNER's metadata, not the local record: the bytes and
			// their headers (content-encoding above all) must come from the same version, and the owner
			// writes every render for this key, so its copy is never older than the local one.
			return {
				statusCode: rescue.page.statusCode,
				headers: rescue.page.headers,
				lastCached: rescue.page.lastCached,
				expiresAt: rescue.page.expiresAt,
				isIndexable: rescue.page.isIndexable,
				cacheKey,
				deviceType,
				url: cacheUrl,
			};
		}

		if (timedOut) {
			logger.warn(
				`cached blob read exceeded ${config.page.blobReadBudgetMs}ms for ${cacheKey}; serving origin instead` +
					(rescue.reason === 'disabled' ? '' : ` (peer rescue: ${rescue.reason})`)
			);
		} else {
			logger.error(`cached blob unreadable for ${cacheKey}; serving origin instead`, cached.error);
		}
		info.cacheStatus = failStatus;
		info.source = 'origin';
		return fetchOriginResource({
			url,
			deviceType,
			headers: request.headers,
			reason: failStatus,
		});
	}

	info.cacheStatus = skipCache ? 'skip' : status === 'invalidated' ? 'invalidated' : page ? 'stale' : 'miss';

	// AN INVALIDATION IS NOT A MISS FOR THE ON-DEMAND LEVERS. Without this, `defaultMissMode:
	// 'prerender'` turns every authorized request for a still-fresh-but-invalidated page into a
	// schedule write at `currentMinuteMs()` — unjittered, which is the herd this feature exists to
	// avoid — plus up to `renderNow.timeoutMs` (30s) of polling for a render that has no reason to
	// arrive. An EXPLICIT `missHeader: prerender` still wins: that is a deliberate "heal this one URL
	// now", and it is exactly the gesture an operator uses to verify a rehearsal.
	const effectiveMissMode = status === 'invalidated' && !missModeExplicit ? 'origin' : missMode;

	if (effectiveMissMode === 'prerender') {
		const rendered = await renderNow({
			url,
			cacheUrl,
			deviceType,
			cacheKey,
			request,
			routeScope: routeScopeForEntry(info.route),
		});
		info.renderNowStatus = rendered.renderNowStatus;
		// 'hit' served the fresh render; on timeout we served the fallback (a cached page
		// when miss=false, else the origin proxy / 504).
		info.source = rendered.renderNowStatus === 'hit' ? 'rendered' : rendered.resource.miss ? 'origin' : 'cache';
		return rendered.resource;
	}

	info.source = 'origin';
	// `stripValidators` on an invalidated verdict, so the origin cannot answer 304 to the validators
	// this plugin handed the crawler off the snapshot that was just invalidated. Without it the crawler
	// keeps the pre-change bytes while every signal — the counter, the source, the status — says the
	// invalidation worked. See util/upstream.js.
	return fetchOriginResource({
		url,
		deviceType,
		headers: request.headers,
		stripValidators: info.cacheStatus === 'invalidated',
		// The cache status that led here IS the origin_fetch reason (miss/stale/skip/invalidated).
		reason: info.cacheStatus,
	});
}

// Schedule the URL for prerendering after a cacheable origin miss (a fresh 200 the caller
// didn't already have cached). Only a `prerender` path is ever scheduled — which now also
// covers what `excludePathPatterns` used to gate separately, since those patterns compile
// into passthrough routes (see util/routeClass.js).
//
// The discovery gates sit HERE, not in handlePageScheduling: a gated miss skips the detached
// Target.get entirely, which matters on a gated combinatorial route where misses are most of
// the traffic. The gates stop target CREATION only — an existing target's miss was a no-op in
// handlePageScheduling anyway — so `discovery_gated` counts gated misses, not denied mints.
function maybeSchedule(resource, routeClass, route, botName) {
	if (routeClass !== PRERENDER || !resource.miss || resource.statusCode !== 200) return;
	if (route && route.discoverTargets === false) {
		metrics.discoveryGated('route', botName);
		return;
	}
	if (!botMayDiscover(botName)) {
		metrics.discoveryGated('bot', botName);
		return;
	}
	setImmediate(handlePageScheduling, resource);
}

// Cache statuses that never looked for a page row, so they can neither prove nor disprove that a
// Target exists: a non-GET (`bypass`) and a deliberate cache skip (`skip`, i.e. render-now).
// Excluding them is right on the second count too — a forced render is an operator action, not
// crawler demand, and should not buy the page a faster rung.
const NO_PAGE_LOOKUP = new Set(['bypass', 'skip']);

// Demand signal for the render ladder (util/visitFilter.js -> util/demandLadder.js). Keyed on
// the device-free URL, since cadence resolves per URL and dropping the device split halves the
// distinct count the filter carries. No-op unless `render.demand.enabled`.
//
// DELIBERATELY OUTSIDE the `recordBots` analytics gate: that gate is about analytics volume,
// whereas this feeds scheduling — turning analytics down must not silently demote the corpus for
// lack of observed traffic.
//
// BOTH GATES BELOW EXIST TO HOLD THE RING'S FILL FACTOR DOWN, and that is a correctness concern,
// not a tidiness one. Fill sets the false-positive rate (~fill^k), and a saturated ring does not
// fail loudly — it answers "visited" for everything, so the ladder promotes the whole corpus to
// its floor and the visit signal stops being a signal. `bitsPerSlice` is sized for the URLs the
// ladder can actually act on, so anything else recorded here is spent budget.
//
//   ROTATION. The ladder only ever probes URLs that own a Target. `cacheStatus` is the sharper
//   test than `resource.miss`: 'stale', 'invalidated', 'blob-missing' and 'blob-timeout' all
//   served from the origin but FOUND a page row, and a page row exists only where a Target does,
//   so treating those as unvisited would demote pages that are merely late. 'miss' is the one
//   status that proves nothing was found, and it still counts when THIS request is what puts the
//   URL into the rotation — a cacheable 200 on a route that mints targets. It does not when the
//   route is discovery-gated (combinatorial facet URLs, which own no Target and never will) or
//   the origin returned no page (404s for URLs that predate the deployment).
//
//   BOT. `render.demand.bots`, mirroring `ingress.discoveryBots`. Cadence is render budget, so a
//   deployment usually wants it allocated by the engines it serves rather than by every crawler
//   that walks the corpus.
export function recordDemand({ resource, routeClass, route, cacheUrl, botName, cacheStatus }) {
	if (routeClass !== PRERENDER) return;
	const owned = cacheStatus !== 'miss' && !NO_PAGE_LOOKUP.has(cacheStatus);
	const minting = cacheStatus === 'miss' && resource.statusCode === 200 && route?.discoverTargets !== false;
	if (!owned && !minting) return;
	if (!botCountsAsDemand(botName)) return;
	recordVisit(cacheUrl);
}

// On-demand render: force an immediate one-off render and wait for the fresh result,
// bypassing both the cache and the origin proxy. Returns { resource, renderNowStatus }
// where renderNowStatus is 'hit' (fresh render served) or 'timeout' (fell back).
async function renderNow({ url, cacheUrl, deviceType, cacheKey, request, routeScope }) {
	const since = Date.now();

	// `fromSitemap` COMES FROM THE TARGET, and this fixes a pre-existing bug: `put` REPLACES the
	// record, so the hardcoded `false` this call used to pass silently cleared the flag on any
	// sitemap-sourced URL somebody rendered on demand. `claim` then reported `isFromSitemap: false`
	// to the renderer, which skips serializing a non-indexable page unless it is sitemap-listed — so
	// one authenticated render-now could quietly stop that page being cached at all, and the next
	// scheduled render would re-file the same `false` from a schedule row nobody suspected.
	// The target is the field's source of truth (`RenderQueue` re-derives it from there on every
	// reschedule for exactly that reason). NO target is the legitimate render-now one-off shape, where
	// `false` is the true answer.
	const renderTarget = await Target.get({ id: cacheUrl, select: ['sitemapUrl', 'renderInterval', 'demandInterval'] });

	// Force an immediately-claimable, one-off schedule. No Target is created, so
	// processJobResult won't reschedule it — and drops the schedule row once the result
	// lands — keeping this a single render rather than a recurring target. Concurrent
	// render-now requests for the same URL collapse onto this one row; the feature is
	// authenticated, so we accept the small window where a spammed key can re-render.
	//
	// Through the funnel, because "due at the current minute" is exactly the write a claim floor
	// would strand: on this node the funnel lowers the floor in-process, and on any other node —
	// which is ~75% of keys, since schedule rows are residency-pinned — the guard band is what
	// keeps the row above the owner's floor and therefore claimable.
	await writeSchedule(cacheKey, {
		nextRenderTime: currentMinuteMs(),
		fromSitemap: !!renderTarget?.sitemapUrl,
		// PRESERVED WHEN THERE IS A TARGET, `null` WHEN THERE IS NOT — and the difference matters because
		// `put` replaces the record. This key may be a real target's recurring row (a warm-on-demand
		// render-now), and filing `null` there would strip its cadence and demote the page in the next
		// sweep. With no target this is the render-now one-off shape, which has no cadence to record: the
		// row is dropped once the result lands. Either way it is due at the current minute, so its own
		// ranking is unaffected — this is about not damaging the row on the way past.
		effectiveInterval: renderTarget ? resolveEffectiveInterval(cacheUrl, renderTarget) : null,
	});

	// Wake idle consumers now instead of waiting out the periodic status sync. Non-force
	// so a paused queue stays paused (the render then simply times out to the fallback).
	await QueueState.reportStatus('queued');

	const page = await pollForFreshRender({
		get: (key) => PrerenderedPage.get(key),
		cacheKey,
		since,
		timeoutMs: config.renderNow.timeoutMs,
		pollIntervalMs: config.renderNow.pollIntervalMs,
		sleep,
	});

	if (page) {
		return { resource: page, renderNowStatus: 'hit' };
	}

	// The render didn't land before the timeout — fall back per config.
	const { fallback } = config.renderNow;

	if (fallback === 'error') {
		return {
			resource: { miss: true, statusCode: 504, url: String(url), deviceType, headers: {}, content: null },
			renderNowStatus: 'timeout',
		};
	}

	if (fallback === 'stale') {
		const stale = await PrerenderedPage.get(cacheKey);
		// `fallback: 'stale'` is opt-in STALENESS — it deliberately serves a page past its window, so
		// no freshness check belongs here. An invalidation is a different statement: not "this is old"
		// but "this is WRONG", and serving it would defeat the invalidation on the one path that reads
		// the cache without ever passing the gate above (it got here with `skipCache` true, so this is
		// the request's first and only epoch read).
		if (stale) {
			const staleLastCachedMs = stale.lastCached ? new Date(stale.lastCached).getTime() : NaN;
			const epoch = await resolveInvalidation(routeScope);
			if (!epoch || staleLastCachedMs > epoch.at) return { resource: stale, renderNowStatus: 'timeout' };
		}
	}

	// 'origin' (default), or 'stale' with no cached page to serve. If an invalidation is active
	// for this scope, strip the crawler's conditional validators — the same 304 defeat the direct
	// origin path in resolveResource closes: the validators came from us, off a snapshot the epoch
	// may have just invalidated, and an origin whose ETag is publish-date-shaped answers 304,
	// letting the crawler keep pre-change bytes while the request records renderNowStatus:
	// 'timeout' and every signal reads as success. Stripping whenever ANY epoch is active for the
	// scope (rather than re-deriving this page's exact verdict) over-strips at worst — the cost is
	// a full origin response instead of a 304, only while an invalidation row exists.
	const activeEpoch = await resolveInvalidation(routeScope);
	return {
		resource: await fetchOriginResource({
			url,
			deviceType,
			headers: request.headers,
			stripValidators: !!activeEpoch,
			reason: 'render-timeout',
		}),
		renderNowStatus: 'timeout',
	};
}

async function handlePageScheduling(resource) {
	try {
		if (isPrerenderCandidate(resource)) {
			// resource.url is the origin-fetch URL built from the canonical half, so it is
			// already route-filtered; canonicalize idempotently ('*' keeps it as-is) so this
			// url-half equals the Target primary key.
			const canonicalUrl = canonicalizeUrl(resource.url, ['*']);

			// One row answers both questions the old shape needed two tables for: an ACTIVE
			// target is already in rotation, and a SUPPRESSED one is a render verdict saying
			// "stop re-creating me" (it re-checks itself on its own schedule). Only a URL with
			// no row at all is genuinely new.
			const existingTarget = await Target.get({ id: canonicalUrl, select: 'url' });
			if (!existingTarget) {
				// No explicit time → Target.put jitters the first render across the interval,
				// so a crawl that discovers many URLs at once doesn't stampede.
				// Deliberately NO renderInterval: cadence is resolved at schedule time
				// (route > stored > default — see resolveRenderInterval). Stamping the
				// default here would freeze creation-time config into the row, which is
				// exactly what made interval config changes non-retroactive.
				await Target.put(canonicalUrl, {});
			}
		}
	} catch (e) {
		logger.error(e);
	}
}
