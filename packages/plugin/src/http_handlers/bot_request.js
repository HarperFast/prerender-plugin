import { setTimeout as sleep } from 'node:timers/promises';
import { CacheKey } from '../util/cacheKey.js';
import { getBotName } from '../util/userAgent.js';
import { isPrerenderCandidate } from '../util/indexSignals.js';
import { canonicalizeUrl } from '../util/url.js';
import { config } from '../config.js';
import { sanitizeDeviceType } from '../util/device_type.js';
import { resolveForwardedRequest } from '../util/ingress.js';
import { classifyPath, isForwardedMode, PRERENDER } from '../util/routeClass.js';
import { Target } from '../resources/Target.js';
import { QueueState } from '../resources/QueueState.js';
import { fetchOriginResource } from '../util/upstream.js';
import { PrerenderedPage } from '../resources/PrerenderedPage.js';
import { resolveServingPolicy, pollForFreshRender } from '../util/renderNow.js';
import { cacheServeStatus } from '../util/pageFreshness.js';
import { currentMinuteMs } from '../util/time.js';
import { recordCrawl } from '../util/crawlStats.js';
import { deliverResource } from './response.js';

export async function handleBotRequest(request) {
	request.handlerPath = 'p';

	try {
		const target = resolveBotTarget(request);
		if (!target) {
			return { headers: {}, status: 400 };
		}
		const { url, cacheUrl, deviceType, routeClass, pageType, pageTypeLabel, route } = target;

		request.botName = getBotName(request.headers);
		const recordBots = config.analytics.enabled && (request.botName !== 'other' || config.analytics.recordUnmatched);
		if (recordBots) {
			server.recordAnalytics(true, 'bot_request', url.hostname, request.botName, deviceType);
			// Crawl breadth (distinct URLs per bot per day): one hash + one byte max into a
			// per-thread HLL sketch — see util/crawlStats.js for the cost/loss model.
			recordCrawl(request.botName, cacheUrl);
		}

		// Debug/observability info surfaced as x-harper-* response headers (only when the
		// debug header is present). `route` is the matched route entry, if any; `routeClass`
		// decides whether this request is cached and scheduled at all. `pageType` is the declared
		// template name or null; `pageTypeLabel` is the always-present metrics label for it. Both
		// come from the one classification the ingress already did, so the debug headers and the
		// serve metrics can never disagree about which template answered a request.
		const info = { route, routeClass, pageType, pageTypeLabel };

		const resource = await resolveResource({ request, url, cacheUrl, deviceType, routeClass, info });
		maybeSchedule(resource, routeClass);
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
// rollout success metrics:
//
//   origin offload   = bot_serve where source !== 'origin' (requests the origin never saw)
//   cache hit rate   = bot_serve by cacheStatus (hit / swr / stale / miss / skip / bypass).
//                      'hit' is within the page's renderInterval; 'swr' is served from the
//                      stale-while-revalidate window. Cache-served = hit + swr; treat hit
//                      alone as the freshness signal ("is the configured TTL being met").
//   freshness        = page_age, ms since the served page rendered (cache-served only, so a
//                      render-now response doesn't drag the distribution toward zero)
//
// Per-PAGE-TYPE variants of the same two signals, for tuning each template's renderInterval up
// or down independently (recordAnalytics has exactly three dimension slots — path/method/type —
// and bot_serve's are all taken, hence separate metrics rather than a fourth dimension):
//
//   pagetype_serve   = (pageType, cacheStatus, deviceType) counter. swr/stale share per
//                      template says whether that template's cadence is being DELIVERED; miss
//                      share says whether its corpus is even covered.
//   pagetype_age     = (pageType, cacheStatus, deviceType), ms since render, cache-served only.
//                      Served age per template against that template's own renderInterval is
//                      the "should this TTL move" number.
//
// These replace v0.33.0's `route_serve` / `route_page_age`, which labelled by the matched
// route's PATH. That split one template across every URL shape that reaches it — a site with
// two category routes got two unrelated rows that only a reader holding the route list could
// add back together — and it is the same label the render-side cost metric needs, so the two
// halves of "is this template worth what it costs" could not be joined. `pageTypeLabel` still
// falls back to the route path when no type is declared, so an un-migrated deployment emits the
// same label values under the new metric names.
//
// Cost: two counter bumps per request plus two numeric samples on a cache hit
// (recordAnalytics buffers in a Map and flushes on Harper's analytics timer) — no storage
// touch, no await, nothing added to response latency.
//
// Exported for tests: the dimension ORDER is the contract dashboards key on.
export function recordServeOutcome(resource, request, info, deviceType) {
	const pageType = info.pageTypeLabel;
	server.recordAnalytics(true, 'bot_serve', info.source, info.cacheStatus, request.botName);
	server.recordAnalytics(true, 'pagetype_serve', pageType, info.cacheStatus, deviceType);
	if (info.source === 'cache' && resource.lastCached) {
		// lastCached is a schema Date — guard truthiness FIRST, then coerce, exactly like the
		// expiresAt read above: `new Date(null)` is epoch 0 (not NaN), so an unguarded null
		// would record age ≈ Date.now() and poison the metric. Past the guard, a Date, number,
		// or serialized string all compare correctly; a malformed value yields NaN, and a
		// negative age (cross-node clock skew on a page another node just wrote) would poison
		// the mean — both fail the >= 0 check and record nothing.
		const age = Date.now() - new Date(resource.lastCached).getTime();
		if (age >= 0) {
			server.recordAnalytics(age, 'page_age', request.botName, deviceType);
			server.recordAnalytics(age, 'pagetype_age', pageType, info.cacheStatus, deviceType);
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
			pageType: target.pageType,
			pageTypeLabel: target.pageTypeLabel,
			route: target.route,
		};
	}

	// Native/prefix mode: the request path (minus the bot prefix) IS the absolute target URL.
	// Classification still applies — it is what carries the folded excludePathPatterns into
	// this mode — but the allowlist stays the global `url.queryParams`, so the key is
	// unchanged. canonicalizeUrl has already proved the URL parses by the time we classify.
	const cacheUrl = canonicalizeUrl(request.url.slice(config.ingress.botPathPrefix.length), config.cacheKey.queryParams);
	const { routeClass, pageType, pageTypeLabel, entry } = classifyPath(URL.parse(cacheUrl)?.pathname ?? '/');
	return {
		url: new URL(cacheUrl),
		cacheUrl,
		deviceType: sanitizeDeviceType(request.headers.get(config.ingress.deviceTypeHeader)),
		routeClass,
		pageType,
		pageTypeLabel,
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
	const { skipCache, missMode } = resolveServingPolicy(routeClass, request.method, request.headers);

	const page = skipCache ? null : await PrerenderedPage.get(cacheKey);
	// expiresAt is a schema `Date` (stored from Date.now()); read it robustly so a Date,
	// number, or serialized string all compare correctly — cf. the Number() coercion in
	// util/renderNow.js. A bad/missing value yields NaN => not servable from cache.
	const expiresAtMs = page && page.expiresAt ? new Date(page.expiresAt).getTime() : NaN;
	const serveStatus = cacheServeStatus(expiresAtMs, config.page.swrTtl, Date.now());

	if (serveStatus) {
		info.cacheStatus = serveStatus;
		info.source = 'cache';
		return page;
	}

	info.cacheStatus = skipCache ? 'skip' : page ? 'stale' : 'miss';

	if (missMode === 'prerender') {
		const rendered = await renderNow({ url, deviceType, cacheKey, request });
		info.renderNowStatus = rendered.renderNowStatus;
		// 'hit' served the fresh render; on timeout we served the fallback (a cached page
		// when miss=false, else the origin proxy / 504).
		info.source = rendered.renderNowStatus === 'hit' ? 'rendered' : rendered.resource.miss ? 'origin' : 'cache';
		return rendered.resource;
	}

	info.source = 'origin';
	return fetchOriginResource({ url, deviceType, headers: request.headers });
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
async function renderNow({ url, deviceType, cacheKey, request }) {
	const since = Date.now();
	const { RenderSchedule } = databases.render_schedule;

	// Force an immediately-claimable, one-off schedule. No Target is created, so
	// processJobResult won't reschedule it — and drops the schedule row once the result
	// lands — keeping this a single render rather than a recurring target. Concurrent
	// render-now requests for the same URL collapse onto this one row; the feature is
	// authenticated, so we accept the small window where a spammed key can re-render.
	await RenderSchedule.put(cacheKey, { nextRenderTime: currentMinuteMs(), fromSitemap: false });

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
		if (stale) return { resource: stale, renderNowStatus: 'timeout' };
	}

	// 'origin' (default), or 'stale' with no cached page to serve.
	return {
		resource: await fetchOriginResource({ url, deviceType, headers: request.headers }),
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
