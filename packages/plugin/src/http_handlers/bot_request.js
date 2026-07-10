import { setTimeout as sleep } from 'node:timers/promises';
import { CacheKey } from '../util/cacheKey.js';
import { getBotName } from '../util/userAgent.js';
import { isPrerenderCandidate } from '../util/indexSignals.js';
import { normalizeUrl, cacheKeyUrl } from '../util/url.js';
import { config } from '../config.js';
import { sanitizeDeviceType } from '../util/device_type.js';
import { isForwardedMode, resolveForwardedRequest } from '../util/ingress.js';
import { RenderTarget } from '../resources/RenderTarget.js';
import { QueueState } from '../resources/QueueState.js';
import { fetchOriginResource } from '../util/upstream.js';
import { PrerenderedPage } from '../resources/PrerenderedPage.js';
import { isRenderNowAuthorized, wantsCacheSkip, resolveMissMode, pollForFreshRender } from '../util/renderNow.js';
import { currentMinuteMs } from '../util/time.js';
import { deliverResource } from './response.js';

export async function handleBotRequest(request) {
	request.handlerPath = 'p';

	try {
		const target = resolveBotTarget(request);
		if (!target) {
			return { headers: {}, status: 400 };
		}
		const { url, deviceType, noCache, route } = target;

		request.botName = getBotName(request.headers);
		if (config.analytics.enabled && (request.botName !== 'other' || config.analytics.recordUnmatched)) {
			server.recordAnalytics(true, 'bot_request', url.hostname, request.botName, deviceType);
		}

		// Debug/observability info surfaced as x-harper-* response headers (only when the
		// debug header is present). `route` is the matched forwarded-mode route, if any;
		// `noCache` marks an unrecognized forwarded path we proxy but never cache.
		const info = { route, noCache };

		const resource = await resolveResource({ request, url, deviceType, info });
		maybeSchedule(resource, noCache);

		return deliverResource(resource, request, info);
	} catch (e) {
		logger.error(e);
		return {
			headers: {},
			status: 500,
		};
	}
}

// Resolve the request into { url, deviceType, noCache, route }, dispatching on ingress
// mode. In 'forwarded' mode isBotRequest already resolved + stashed the target; the
// fallback resolve guards against direct calls. Returns null when a forwarded request
// can't be resolved (a matched route with an unusable forwarded host) => the caller 400s.
function resolveBotTarget(request) {
	if (isForwardedMode()) {
		const target = request._prerenderTarget ?? resolveForwardedRequest(request);
		if (!target) return null;
		return { url: target.url, deviceType: target.deviceType, noCache: !!target.noCache, route: target.route };
	}

	return {
		url: normalizeUrl(request.url.slice(config.botPathPrefix.length), true),
		deviceType: sanitizeDeviceType(request.headers.get(config.ingress.deviceTypeHeader)),
		noCache: false,
		route: undefined,
	};
}

// Resolve the resource to serve: an origin proxy for non-GET/HEAD, else a fresh cache hit,
// an on-demand render, or an origin proxy per the miss mode. Populates the debug `info`
// (cacheKey/url/cacheStatus/source/renderNowStatus) as a side effect.
async function resolveResource({ request, url, deviceType, info }) {
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		logger.warn(`Unexpected Request ${request.method} ${url}`);
		info.source = 'origin';
		return fetchOriginResource({
			url,
			deviceType,
			method: request.method,
			headers: request.headers,
			body: request._nodeRequest,
		});
	}

	// `url.href` re-serializes on each access; read it once and reuse for the cache key
	// and the debug info.
	const href = url.href;
	const cacheKey = CacheKey.toCacheKey({ url: cacheKeyUrl(href), deviceType });
	info.cacheKey = cacheKey;
	info.url = href;

	// On-demand levers apply only to an authorized GET for a non-excluded URL.
	const authorized = request.method === 'GET' && isRenderNowAuthorized(request.headers) && !isExcludedUrl(url);
	const skipCache = authorized && wantsCacheSkip(request.headers);
	// Unrecognized paths are never rendered/cached, so a miss always just proxies.
	const missMode = authorized && !info.noCache ? resolveMissMode(request.headers) : 'origin';

	const page = skipCache ? null : await PrerenderedPage.get(cacheKey);
	// expiresAt is a schema `Date` (stored from Date.now()); read it robustly so a Date,
	// number, or serialized string all compare correctly — cf. the Number() coercion in
	// util/renderNow.js. A bad/missing value yields NaN => not fresh.
	const expiresAtMs = page && page.expiresAt ? new Date(page.expiresAt).getTime() : NaN;
	const fresh = !isNaN(expiresAtMs) && expiresAtMs + config.page.swrTtl > Date.now();

	if (fresh) {
		info.cacheStatus = 'hit';
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
// didn't already have cached). Skipped for excluded URLs and for unrecognized forwarded
// paths (noCache), which we proxy but never populate into the cache.
function maybeSchedule(resource, noCache) {
	if (resource.miss && resource.statusCode === 200 && !noCache && !isExcludedUrl(resource.url)) {
		setImmediate(handlePageScheduling, resource);
	}
}

// A URL is excluded from prerendering when its string form contains any configured
// exclude pattern. Accepts a URL object or a string. Skips the string coercion entirely
// when no patterns are configured (the common case).
function isExcludedUrl(url) {
	const patterns = config.excludePathPatterns;
	if (patterns.length === 0) return false;
	const urlString = String(url);
	return patterns.some((pattern) => urlString.includes(pattern));
}

// On-demand render: force an immediate one-off render and wait for the fresh result,
// bypassing both the cache and the origin proxy. Returns { resource, renderNowStatus }
// where renderNowStatus is 'hit' (fresh render served) or 'timeout' (fell back).
async function renderNow({ url, deviceType, cacheKey, request }) {
	const since = Date.now();
	const { RenderSchedule } = databases.render_schedule;

	// Force an immediately-claimable, one-off schedule. No RenderTarget is created, so
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
			const existingNonIndexable = await databases.signals.NonIndexable.get({
				id: cacheKeyUrl(resource.url),
				select: 'url',
			});

			if (!existingNonIndexable) {
				for (const deviceType of config.deviceTypes.default) {
					const cacheKey = CacheKey.toCacheKey({ url: cacheKeyUrl(resource.url), deviceType });
					const existingTarget = await RenderTarget.get({ id: cacheKey, select: 'cacheKey' });
					if (!existingTarget) {
						// No explicit time → RenderTarget.put jitters the first render across the
						// interval, so a crawl that discovers many URLs at once doesn't stampede.
						await RenderTarget.put(cacheKey, {
							renderInterval: config.render.defaultInterval,
						});
					}
				}
			}
		}
	} catch (e) {
		logger.error(e);
	}
}
