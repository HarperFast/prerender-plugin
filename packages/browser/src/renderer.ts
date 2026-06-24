import { Renderer } from './Worker.js';
import { settings } from './settings.js';
import { CACHE_REPLAY_HEADER, getResourceCache } from './ResourceCache.js';
import type { PostProcessConfig } from './config.js';

const noop = () => {};

// Forces the Web Components polyfills so shadow DOM / custom-element CSS is
// serialized into the prerendered HTML. Injected before document load when
// `injectWebComponentsPolyfill` is enabled.
const WEB_COMPONENTS_POLYFILL = `
    if (window.customElements)
        customElements.forcePolyfill = true;
    ShadyDOM = {force: true};
    ShadyCSS = {shimcssproperties: true};
`;

class RemainingTimer {
	startTime: number;
	maxBudget: number;

	constructor(maxBudget: number) {
		this.startTime = Date.now();
		this.maxBudget = maxBudget;
	}

	get remaining() {
		const elapsed = Date.now() - this.startTime;
		return Math.max(1, this.maxBudget - elapsed);
	}
}

const normalizeUrlForCompare = (url: string | URL): string => {
	const parsed = new URL(url);
	parsed.searchParams.sort();
	return decodeURI(parsed.href);
};

const renderer: Renderer = async (page, job) => {
	const { url, deviceType } = job;

	// Resolved rendering config + active resource cache for this render.
	const config = settings.config;
	const cache = getResourceCache();

	const navigationUrl = new URL(url);

	const blockedResourceTypes = new Set(config.block.resourceTypes);
	const blockedUrlPatterns = config.block.urlPatterns;
	const isBlockedUrl = (requestUrl: string) =>
		blockedUrlPatterns.length > 0 && blockedUrlPatterns.some((pattern) => requestUrl.includes(pattern));

	const profile = config.devices[deviceType] ?? config.devices[config.defaultDevice];

	const setupPromises: Promise<unknown>[] = [page.setRequestInterception(true), page.setViewport(profile.viewport)];

	if (profile.userAgent) {
		setupPromises.push(page.setUserAgent(profile.userAgent));
	}

	if (config.injectWebComponentsPolyfill) {
		setupPromises.push(page.evaluateOnNewDocument(WEB_COMPONENTS_POLYFILL));
	}

	const ac = new AbortController();
	let aborted = false;

	page
		.on('request', async (req) => {
			if (ac.signal.aborted || aborted) {
				req.abort().catch(noop);
				return;
			}
			if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
				const headers = req.headers();

				for (const [key, value] of Object.entries(config.extraHeaders)) {
					headers[key.toLowerCase()] = value;
				}

				if (settings.bypass.token) {
					headers[settings.bypass.header] = settings.bypass.token;
				}

				if (job.headers) {
					Object.keys(job.headers).forEach((header) => {
						headers[header.toLowerCase()] = job.headers![header];
					});
				}

				req.continue({ headers }).catch(noop);
				return;
			}
			if (blockedResourceTypes.has(req.resourceType()) || isBlockedUrl(req.url())) {
				req.abort().catch(noop);
				return;
			}

			if (cache?.isCacheableRequest(req)) {
				const entry = await cache.get(req.url());
				// Page may have aborted (origin error, timeout, page closed) while
				// we were waiting on the cache read — bail instead of responding
				// into a torn-down request.
				if (ac.signal.aborted || aborted) {
					req.abort().catch(noop);
					return;
				}
				if (entry) {
					req.respond(cache.toRespondPayload(entry)).catch(noop);
					return;
				}
			}
			req.continue().catch(noop); // For all other requests, continue without modification
		})
		.on('response', (res) => {
			const req = res.request();
			if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
				const status = res.status();
				const headers = res.headers();
				if (status >= 400) {
					job.httpResponse = {
						statusCode: status,
						headers,
					};
					ac.abort();
					aborted = true;
				}
				return;
			}

			if (!cache || !cache.isCacheableRequest(req)) return;
			const resHeaders = res.headers();
			// Skip responses we just synthesized from our own cache.
			if (resHeaders[CACHE_REPLAY_HEADER]) return;
			const policy = cache.getCachePolicy(res);
			if (!policy.cacheable) return;
			res
				.buffer()
				.then((body) =>
					cache!.set({
						url: req.url(),
						status: res.status(),
						headers: resHeaders,
						storedAt: Date.now(),
						expiresAt: Date.now() + policy.ttlMs,
						body,
					})
				)
				.catch(noop);
		});

	await Promise.all(setupPromises);

	const remainingTimer = new RemainingTimer(job.renderBudget || config.navigation.renderBudgetMs);

	const finalRes = await page.goto(navigationUrl.href, {
		waitUntil: config.navigation.waitUntil,
		timeout: remainingTimer.remaining,
		signal: ac.signal,
	});

	const networkIdle = () =>
		page
			.waitForNetworkIdle({
				idleTime: config.navigation.networkIdleMs,
				timeout: Math.min(remainingTimer.remaining, config.navigation.networkIdleTimeoutMs),
			})
			.catch(noop);

	if (config.scroll.enabled) {
		// Scroll to the bottom to trigger lazy-loaded content, then back to the top
		// (e.g. so a scroll-aware navbar renders in its default state).
		await page.evaluate(scrollToBottom, config.scroll.stepMs);
		await networkIdle();
		await page.evaluate(() => window.scrollTo(0, 0));
	}

	await networkIdle();

	if (finalRes) {
		job.httpResponse = job.httpResponse || {
			statusCode: finalRes.status(),
			headers: finalRes.headers(),
		};
		const statusCode = job.httpResponse.statusCode;

		const pageUrl = normalizeUrlForCompare(page.url());
		const jobUrl = normalizeUrlForCompare(job.url);

		if (pageUrl !== jobUrl) {
			job.redirectedTo = pageUrl;
		}

		if (statusCode === 200) {
			job.isIndexable = await page.evaluate(isIndexableFromContent, pageUrl);

			if (job.isIndexable || job.isFromSitemap) {
				const content = await page.evaluate(postProcess, config.postProcess);
				return content;
			}
		} else {
			job.isIndexable = false;
		}
	}
};

export default renderer;

async function scrollToBottom(stepMs: number) {
	await new Promise<void>((resolve) => {
		const viewportHeight = window.innerHeight;
		let totalScrolled = 0;

		const timer = setInterval(() => {
			const scrollHeight = document.body.scrollHeight;

			window.scrollBy(0, viewportHeight);
			totalScrolled += viewportHeight;

			if (totalScrolled >= scrollHeight) {
				clearInterval(timer);
				resolve();
			}
		}, stepMs);
	});
}

function isIndexableFromContent(pageUrl: string) {
	const normalizeUrl = (url: string) => {
		try {
			const parsed = new URL(url);
			parsed.hash = '';
			let href = parsed.href;
			href = href.endsWith('/') ? href.substring(0, href.length - 1) : href;
			return decodeURI(href);
		} catch {
			return url;
		}
	};
	let isIndexable = true;

	document.querySelectorAll('link[rel="canonical"], meta[name="robots"], meta[name="googlebot"]').forEach((el) => {
		if (isIndexable === false) return;
		const tagName = el.tagName.toLowerCase();

		if (tagName === 'link') {
			const href = el.getAttribute('href');
			if (href && href !== pageUrl) {
				const canonicalUrl = normalizeUrl(href);
				const currentUrl = normalizeUrl(pageUrl);

				if (canonicalUrl !== currentUrl) {
					isIndexable = false;
				}
			}
		} else if (tagName === 'meta') {
			if (el.getAttribute('content')?.includes('noindex')) isIndexable = false;
		}
	});

	return isIndexable;
}

function postProcess(opts: PostProcessConfig) {
	if (opts.inlineEmptyStyleSheets) {
		// Inline any style sheets that are empty (assumed to be dynamically injected CSSOM)
		for (const styleSheet of document.styleSheets) {
			if (!styleSheet.href && styleSheet.ownerNode)
				if ('innerText' in styleSheet.ownerNode && styleSheet.ownerNode.innerText === '') {
					let css = '';
					for (const cssRule of styleSheet.cssRules) {
						css += cssRule.cssText;
					}
					(styleSheet.ownerNode as Element).innerHTML = css;
				}
		}
	}

	const removeSelectors = [...opts.removeSelectors];
	if (opts.stripScripts) {
		// Strip only script tags that contain JavaScript (no type attribute, or a type
		// that is javascript/module). Data scripts (e.g. application/ld+json) are kept.
		removeSelectors.push('script:not([type])', 'script[type*="javascript"]', 'script[type="module"]');
	}
	if (removeSelectors.length > 0) {
		document.querySelectorAll(removeSelectors.join(', ')).forEach((el) => el.remove());
	}

	let content = '';
	for (const node of document.childNodes) {
		switch (node) {
			case document.documentElement:
				content += document.documentElement.outerHTML;
				break;
			default:
				content += new XMLSerializer().serializeToString(node);
				break;
		}
	}
	return content;
}
