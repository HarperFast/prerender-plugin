import { getAcceptedEncodings, getBestEncoding, reencode } from '../util/contentEncoding.js';
import { Readable } from 'node:stream';
import { CacheKey } from '../util/cacheKey.js';
import { getBotName } from '../util/userAgent.js';
import { isPrerenderCandidate } from '../util/indexSignals.js';
import { normalizeUrl } from '../util/url.js';
import { config } from '../config.js';
import { sanitizeDeviceType } from '../util/device_type.js';
import { isForwardedMode, resolveForwardedRequest } from '../util/ingress.js';
import { RenderTarget } from '../resources/RenderTarget.js';
import { fetchOriginResource } from '../util/upstream.js';
import { PrerenderedPage } from '../resources/PrerenderedPage.js';
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

		if (request.method !== 'GET' && request.method !== 'HEAD') {
			logger.warn(`Unexpected Request ${request.method} ${url}`);

			resource = await fetchOriginResource({
				url,
				deviceType,
				method: request.method,
				headers: request.headers,
				body: request._nodeRequest,
			});
		} else {
			const cacheKey = CacheKey.toCacheKey({ url: url.href, deviceType });

			const page = await PrerenderedPage.get(cacheKey);

			if (page && page.expiresAt && page.expiresAt.valueOf() + config.page.swrTtl > Date.now()) {
				resource = page;
			} else {
				resource = await fetchOriginResource({ url, deviceType, headers: request.headers });
			}
		}

		return deliverResource(resource, request);
	} catch (e) {
		logger.error(e);
		return {
			headers: {},
			status: 500,
		};
	}
}

async function handlePageScheduling(resource) {
	try {
		if (isPrerenderCandidate(resource)) {
			const existingNonIndexable = await databases.signals.NonIndexable.get({ id: resource.url, select: 'url' });

			if (!existingNonIndexable) {
				for (const deviceType of config.deviceTypes.default) {
					const cacheKey = CacheKey.toCacheKey({ url: resource.url, deviceType });
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

function deliverResource(resource, request) {
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

		const excluded = config.excludePathPatterns.some((pattern) => resource.url.includes(pattern));
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
