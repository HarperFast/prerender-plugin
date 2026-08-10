import { setTimeout as sleep } from 'node:timers/promises';
import { CacheKey } from '../util/cacheKey.js';
import { getBotName } from '../util/userAgent.js';
import { isPrerenderCandidate } from '../util/indexSignals.js';
import { canonicalizeUrl } from '../util/url.js';
import { config } from '../config.js';
import { sanitizeDeviceType } from '../util/device_type.js';
import { resolveForwardedRequest } from '../util/ingress.js';
import { classifyPath, isForwardedMode, routeScopeForEntry, PRERENDER } from '../util/routeClass.js';
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

		// Demand signal for the render ladder. Deliberately OUTSIDE the `recordBots` gate: that
		// gate is about analytics volume, whereas this feeds scheduling — a deployment that turns
		// analytics down must not silently demote its whole corpus for lack of observed traffic.
		// Keyed on the device-free URL, since cadence resolves per URL and dropping the device
		// split halves the distinct count the filter carries. No-op unless render.demand.enabled.
		// Prerender-class only: those are the only keys the ladder ever probes (proxied and
		// unclassified paths own no Target), and recording the plentiful junk URLs the CDN
		// over-forwards would only raise the filter's fill factor — at high fill the
		// false-positive rate explodes and the ladder degenerates into promoting everything.
		if (routeClass === PRERENDER) recordVisit(cacheUrl);

		// Debug/observability info surfaced as x-harper-* response headers (only when the
		// debug header is present). `route` is the matched route entry, if any; `routeClass`
		// decides whether this request is cached and scheduled at all.
		const info = { route, routeClass };

		const resource = await resolveResource({ request, url, cacheUrl, deviceType, routeClass, info });
		maybeSchedule(resource, routeClass);
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
		info.cacheStatus = status;
		info.source = 'cache';
		return page;
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
function maybeSchedule(resource, routeClass) {
	if (routeClass === PRERENDER && resource.miss && resource.statusCode === 200) {
		setImmediate(handlePageScheduling, resource);
	}
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
	const renderTarget = await Target.get({ id: cacheUrl, select: ['sitemapUrl'] });

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
	await writeSchedule(cacheKey, { nextRenderTime: currentMinuteMs(), fromSitemap: !!renderTarget?.sitemapUrl });

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
