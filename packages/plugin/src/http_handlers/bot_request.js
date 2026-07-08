import { getAcceptedEncodings, getBestEncoding, reencode } from '../util/contentEncoding.js';
import { Readable } from 'node:stream';
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

export async function handleBotRequest(request) {
	request.handlerPath = 'p';

	try {
		let url;
		let deviceType;

		if (isForwardedMode()) {
			// isBotRequest already resolved + stashed the target; the fallback resolve
			// guards against direct calls. A null here means a matched route with an
			// unusable forwarded host.
			const target = request._prerenderTarget ?? resolveForwardedRequest(request);
			if (!target) {
				return { headers: {}, status: 400 };
			}
			url = target.url;
			deviceType = target.deviceType;
		} else {
			url = normalizeUrl(request.url.slice(config.botPathPrefix.length), true);
			deviceType = sanitizeDeviceType(request.headers.get(config.ingress.deviceTypeHeader));
		}

		request.botName = getBotName(request.headers);

		if (config.analytics.enabled && (request.botName !== 'other' || config.analytics.recordUnmatched)) {
			server.recordAnalytics(true, 'bot_request', url.hostname, request.botName, deviceType);
		}

		let resource;
		// Debug/observability info surfaced as x-harper-* response headers (only when the
		// debug header is present). `route` is the matched forwarded-mode route, if any.
		const info = { route: request._prerenderTarget?.route };

		if (request.method !== 'GET' && request.method !== 'HEAD') {
			logger.warn(`Unexpected Request ${request.method} ${url}`);

			resource = await fetchOriginResource({
				url,
				deviceType,
				method: request.method,
				headers: request.headers,
				body: request._nodeRequest,
			});
			info.source = 'origin';
		} else {
			const cacheKey = CacheKey.toCacheKey({ url: cacheKeyUrl(url), deviceType });
			info.cacheKey = cacheKey;
			info.url = url.href;

			// On-demand levers apply only to an authorized GET for a non-excluded URL.
			const authorized = request.method === 'GET' && isRenderNowAuthorized(request.headers) && !isExcludedUrl(url);
			const skipCache = authorized && wantsCacheSkip(request.headers);
			const missMode = authorized ? resolveMissMode(request.headers) : 'origin';

			const page = skipCache ? null : await PrerenderedPage.get(cacheKey);
			const fresh = page && page.expiresAt && page.expiresAt.valueOf() + config.page.swrTtl > Date.now();

			if (fresh) {
				resource = page;
				info.cacheStatus = 'hit';
				info.source = 'cache';
			} else {
				info.cacheStatus = skipCache ? 'skip' : page ? 'stale' : 'miss';

				if (missMode === 'prerender') {
					const rendered = await renderNow({ url, deviceType, cacheKey, request });
					resource = rendered.resource;
					info.renderNowStatus = rendered.renderNowStatus;
					// 'hit' served the fresh render; on timeout we served the fallback (a
					// cached page when miss=false, else the origin proxy / 504).
					info.source = rendered.renderNowStatus === 'hit' ? 'rendered' : resource.miss ? 'origin' : 'cache';
				} else {
					resource = await fetchOriginResource({ url, deviceType, headers: request.headers });
					info.source = 'origin';
				}
			}
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

// A URL is excluded from prerendering when its string form contains any configured
// exclude pattern. Accepts a URL object or a string.
function isExcludedUrl(url) {
	const urlString = String(url);
	return config.excludePathPatterns.some((pattern) => urlString.includes(pattern));
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
						await RenderTarget.put(cacheKey, {
							renderInterval: config.render.defaultInterval,
							nextRenderTime: currentMinuteMs(),
						});
					}
				}
			}
		}
	} catch (e) {
		logger.error(e);
	}
}

const allowed304Headers = ['cache-control', 'expires', 'date', 'etag', 'last-modified', 'vary', 'age'];

// Compact one-line description of a matched forwarded-mode route for the
// x-harper-route debug header.
function formatRoute(route) {
	return `${route.match} ${route.path} [${route.queryParams.join(', ')}]`;
}

function deliverResource(resource, request, info = {}) {
	let status = resource.statusCode;
	let headers = new Headers();
	let body = request.method === 'HEAD' ? undefined : resource.content;
	let wasCacheMiss;

	if (!resource.miss) {
		wasCacheMiss = false;
		if (body instanceof Blob) {
			body.on('error', (e) => {
				logger.error('blob delivery error', e);
				PrerenderedPage.delete(resource.cacheKey);
			});
			body = body.stream();
		}
	} else {
		if (status === 200 || status === 304) {
			wasCacheMiss = true;
		}

		const excluded = isExcludedUrl(resource.url);
		if (status === 200 && !excluded) {
			setImmediate(handlePageScheduling, resource);
		}
	}

	const upstreamHeaders = typeof resource.headers === 'string' ? JSON.parse(resource.headers) : resource.headers;

	for (const [key, value] of Object.entries(upstreamHeaders)) {
		try {
			if (key !== 'link') {
				headers.append(key, value);
			}
		} catch (e) {
			logger.error(e);
		}
	}

	// set age header
	if (status === 200 && resource.lastCached) {
		const ageSec = Math.max(0, Math.floor((Date.now() - resource.lastCached.valueOf()) / 1000));
		headers.set('age', String(ageSec));
	}

	if (request.headers.get(config.debugHeader.key)) {
		headers.set('x-harper-device-type', resource.deviceType || CacheKey.parse(resource.cacheKey).deviceType);
		if (resource.lastCached) {
			headers.set('x-harper-cache-timestamp', new Date(resource.lastCached).toISOString());
		}
		if (resource.viaStaging) {
			headers.set('x-harper-origin', 'staging');
		}
		if (info.cacheStatus) {
			headers.set('x-harper-cache', info.cacheStatus);
		}
		if (info.source) {
			headers.set('x-harper-source', info.source);
		}
		if (info.cacheKey) {
			headers.set('x-harper-cache-key', info.cacheKey);
		}
		if (info.url) {
			headers.set('x-harper-url', info.url);
		}
		if (info.route) {
			headers.set('x-harper-route', formatRoute(info.route));
		}
		if (resource.isIndexable === true || resource.isIndexable === false) {
			headers.set('x-harper-indexable', String(resource.isIndexable));
		}
	}

	// handle 304
	if (status === 200) {
		let return304 = false;

		// handle etag
		{
			const etag = request.headers.get('if-none-match');
			if (etag && etag === headers.get('etag')) {
				return304 = true;
			}
		}

		// handle last-modified
		{
			const ifModifiedSince = request.headers.get('if-modified-since');
			const lastModified = headers.get('last-modified');
			if (ifModifiedSince && lastModified) {
				const ifModifiedSinceTime = new Date(ifModifiedSince).getTime();
				const lastModifiedTime = new Date(lastModified).getTime();
				if (!isNaN(ifModifiedSinceTime) && !isNaN(lastModifiedTime)) {
					if (lastModifiedTime <= ifModifiedSinceTime) {
						return304 = true;
					}
				}
			}
		}

		if (return304) {
			// return 304 with only allowed headers
			const headers304 = new Headers();
			for (const headerName of allowed304Headers) {
				const headerValue = headers.get(headerName);
				if (headerValue !== null) {
					headers304.set(headerName, headerValue);
				}
			}
			status = 304;
			headers = headers304;
			body = undefined;
		}
	}

	// Always surface the on-demand render outcome so the caller knows whether it got a
	// fresh render ('hit') or the fallback ('timeout'). Set after 304 handling so it
	// survives the header reset on a conditional response.
	if (info.renderNowStatus) {
		headers.set('x-harper-render-now', info.renderNowStatus);
	}

	if (body) {
		const contentEncoding = headers.get('content-encoding') || null;

		const bestEncoding = getBestEncoding(getAcceptedEncodings(request.headers.get('accept-encoding')), contentEncoding);

		if (bestEncoding !== contentEncoding) {
			if (bestEncoding) {
				headers.set('content-encoding', bestEncoding);
			} else {
				headers.delete('content-encoding');
			}

			body = reencode(Readable.fromWeb(body), contentEncoding, bestEncoding, false);

			headers.delete('content-length');
		}
	}

	return {
		headers,
		status,
		body,
		wasCacheMiss,
	};
}
