import { Renderer } from './Worker.js';
import type { RenderTimings } from './RenderJob.js';
import { settings } from './settings.js';
import { CACHE_REPLAY_HEADER, getResourceCache } from './ResourceCache.js';
import type { PostProcessConfig } from './config.js';
import { normalizeUrlForCompare, canonicalAllowsIndex } from './util/url.js';

const noop = () => {};

// 1×1 transparent GIF used to satisfy blocked image requests (see block.stubImages).
const STUB_IMAGE = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const STUB_IMAGE_RESPONSE = { status: 200, contentType: 'image/gif', body: STUB_IMAGE };

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

const renderer: Renderer = async (page, job) => {
	const { url, deviceType } = job;

	// Resolved rendering config + active resource cache for this render.
	const config = settings.config;
	const cache = getResourceCache();

	const navigationUrl = new URL(url);

	// Per-phase timing split, surfaced to the worker's per-window stats through the render
	// attempt. Mutated in place below; the attempt holds the same object reference, so partial
	// timings survive an early return (non-200 / redirect / non-indexable).
	const timings: RenderTimings = {};
	if (job.latestAttempt) job.latestAttempt.timings = timings;
	let navStart = 0;

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
			if (isBlockedUrl(req.url())) {
				req.abort().catch(noop);
				return;
			}
			if (blockedResourceTypes.has(req.resourceType())) {
				// Stub blocked images (vs abort) so lazy-loaders keep their real src URLs.
				if (config.block.stubImages && req.resourceType() === 'image') {
					req.respond(STUB_IMAGE_RESPONSE).catch(noop);
				} else {
					req.abort().catch(noop);
				}
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
				// Time-to-first-byte for the main document: navigation start → response headers.
				// This is the origin/edge response time — the signal that isolates a slow upstream
				// (e.g. a saturated pinned staging IP) from in-browser render cost.
				if (navStart && timings.navTtfb === undefined) timings.navTtfb = Date.now() - navStart;
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

	navStart = Date.now();
	const finalRes = await page.goto(navigationUrl.href, {
		waitUntil: config.navigation.waitUntil,
		timeout: remainingTimer.remaining,
		signal: ac.signal,
	});
	timings.navTotal = Date.now() - navStart;

	const settleStart = Date.now();

	const networkIdle = () =>
		page
			.waitForNetworkIdle({
				idleTime: config.navigation.networkIdleMs,
				timeout: Math.min(remainingTimer.remaining, config.navigation.networkIdleTimeoutMs),
			})
			.catch(noop);

	// Wait until the DOM's element count stops changing for `domStableMs`, capped by
	// `domStableTimeoutMs` and the remaining render budget. Catches late content
	// (e.g. a reviews widget injected after a network lull) that network-idle misses.
	// Element count (not HTML length) is the signal so perpetual cosmetic churn —
	// rotating carousels, animation classes, countdown text — doesn't reset the timer;
	// it still jumps when a widget injects real DOM.
	const domStable = async () => {
		const { domStableMs, domStableTimeoutMs, domStablePollMs, domStableTolerance } = config.navigation;
		if (domStableMs <= 0) return;
		const deadline = Date.now() + Math.min(remainingTimer.remaining, domStableTimeoutMs);
		let baseline = -1;
		let stableSince = Date.now();
		while (Date.now() < deadline) {
			// Count light + open-shadow elements: widgets like the reviews list render into
			// shadow DOM, which wouldn't change a light-DOM-only count, so the wait would
			// settle before they appear.
			let count: number;
			try {
				count = await page.evaluate(countDomElements);
			} catch {
				// Page closed / crashed / navigated — stop polling instead of spinning to the deadline.
				return;
			}
			// Reset the timer only when the count drifts past the baseline by more than the
			// tolerance; small ± churn around a plateau is treated as stable.
			if (baseline < 0 || Math.abs(count - baseline) > domStableTolerance) {
				baseline = count;
				stableSince = Date.now();
			} else if (Date.now() - stableSince >= domStableMs) {
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, domStablePollMs));
		}
	};

	// Loop scroll-passes (network-idle between each) until the DOM element count holds
	// steady across passes — keeps IntersectionObserver-lazy widgets in view long enough
	// to fully load (reviews, UGC carousels, vote controls) before the snapshot.
	const scrollSettle = async () => {
		const deadline = Date.now() + Math.min(remainingTimer.remaining, config.navigation.domStableTimeoutMs);
		const requiredStablePasses = Math.max(1, config.scroll.settleStablePasses);
		let last = -1;
		let stablePasses = 0;
		while (Date.now() < deadline && stablePasses < requiredStablePasses) {
			let count: number;
			try {
				await page.evaluate(scrollPass, config.scroll.stepMs, config.scroll.stepFraction);
				await networkIdle();
				count = await page.evaluate(countDomElements);
			} catch {
				// Page closed / crashed during a pass — stop instead of looping to the deadline.
				return;
			}
			if (last >= 0 && Math.abs(count - last) <= config.navigation.domStableTolerance) stablePasses++;
			else stablePasses = 0;
			last = count;
		}
		await scrollToTop();
	};

	// Return to the top and let scroll-reactive UI settle before we serialize. Sticky/
	// compact headers hide the main header on scroll-down and re-reveal it only at the top
	// via a throttled scroll handler that fires a tick *after* scrollTo(0, 0); serializing
	// immediately captures the header mid-hide (a blank band). Hold for topSettleMs so that
	// handler runs first. The wait is a Node-side timer (not an in-page requestAnimationFrame
	// flush) on purpose: rAF can be paused indefinitely in a backgrounded headless tab, which
	// would hang the render — and since we serialize the DOM (not a paint), only the handler's
	// class flip needs to land, which the wall-clock wait covers regardless of how it's scheduled.
	const scrollToTop = async () => {
		await page.evaluate(() => window.scrollTo(0, 0)).catch(noop);
		if (config.scroll.topSettleMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, config.scroll.topSettleMs));
		}
	};

	if (config.scroll.enabled && config.scroll.settleUntilStable) {
		await scrollSettle();
	} else {
		if (config.scroll.enabled) {
			// Scroll to the bottom to trigger lazy-loaded content, then back to the top
			// (e.g. so a scroll-aware navbar renders in its default state).
			await page.evaluate(scrollToBottom, config.scroll.stepMs);
			await networkIdle();
			await scrollToTop();
		}
		await networkIdle();
		await domStable();
	}
	timings.settle = Date.now() - settleStart;

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
			const { canonicalHref, noindex } = await page.evaluate(extractIndexSignals);
			job.isIndexable = !noindex && canonicalAllowsIndex(canonicalHref, pageUrl);

			if (job.isIndexable || job.isFromSitemap) {
				const ppStart = Date.now();
				const content = await page.evaluate(postProcess, config.postProcess, config.block.urlPatterns);
				timings.postProcess = Date.now() - ppStart;
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

// One absolute-position scroll pass from top to bottom in `stepFraction`-of-viewport steps.
// Used by the settle loop so each lazy section is held in the viewport long enough to trigger.
async function scrollPass(stepMs: number, stepFraction: number) {
	await new Promise<void>((resolve) => {
		let y = 0;
		// Guard the in-page math: a non-positive/NaN fraction would floor to a 1px step (a
		// pathologically slow pass), so fall back to the half-viewport default.
		const frac = stepFraction > 0 ? stepFraction : 0.5;
		const step = Math.max(1, Math.round(window.innerHeight * frac));
		const timer = setInterval(() => {
			window.scrollTo(0, y);
			y += step;
			if (y >= document.body.scrollHeight) {
				clearInterval(timer);
				resolve();
			}
		}, stepMs);
	});
}

// Count elements across the light DOM and all open shadow roots (widgets like the
// reviews list render into shadow DOM, invisible to a light-DOM-only count). Walks the
// tree via firstChild/nextSibling rather than querySelectorAll('*') so it allocates no
// NodeLists — this runs on every poll/pass over element-heavy pages.
function countDomElements() {
	let n = 0;
	const walk = (node: Node) => {
		if (node.nodeType === 1) {
			n++;
			const shadow = (node as Element).shadowRoot;
			if (shadow) walk(shadow);
		}
		for (let child = node.firstChild; child; child = child.nextSibling) walk(child);
	};
	walk(document);
	return n;
}

// Read indexability signals from the rendered DOM. DOM extraction only — the URL comparison
// lives in Node (util/url.ts) so it is unit-tested and can't drift from the redirect
// normalizer. (That drift is exactly what marked self-canonical pages non-indexable: the
// canonical's literal `:` never matched the request's `%3A`.)
function extractIndexSignals(): { canonicalHref: string | null; noindex: boolean } {
	let canonicalHref: string | null = null;
	let noindex = false;

	document.querySelectorAll('link[rel="canonical"], meta[name="robots"], meta[name="googlebot"]').forEach((el) => {
		if (el.tagName.toLowerCase() === 'link') {
			// First canonical wins (multiple canonicals is invalid HTML anyway).
			if (canonicalHref === null) canonicalHref = el.getAttribute('href');
		} else if (el.getAttribute('content')?.toLowerCase().includes('noindex')) {
			// robots directives are case-insensitive per spec (NOINDEX / NoIndex).
			noindex = true;
		}
	});

	return { canonicalHref, noindex };
}

function postProcess(opts: PostProcessConfig, blockedUrlPatterns: string[] = []) {
	if (opts.flattenShadowDom) {
		// Inline open shadow roots into their host's light DOM so outerHTML/XMLSerializer
		// include them (content rendered in shadow DOM — e.g. a reviews widget Googlebot
		// sees after rendering — is otherwise lost). Collect deepest-last, then process
		// deepest-first so nested shadow content is inlined before its ancestor.
		const hosts: Element[] = [];
		const walk = (root: Document | ShadowRoot) => {
			for (const el of root.querySelectorAll('*')) {
				if (el.shadowRoot) {
					hosts.push(el);
					walk(el.shadowRoot);
				}
			}
		};
		walk(document);

		// Rewrite a shadow selector so it (a) still applies once flattened and (b) stays
		// SCOPED to its host. `:host`/`:host(x)` re-target the (now light-DOM) host via a
		// unique attribute we stamp on it; every other selector is prefixed with the host
		// selector so it only matches inside the flattened subtree — otherwise unscoped
		// shadow rules (e.g. a bare `button {…}`) would leak out and restyle the whole page.
		const rewriteSelector = (selectorText: string, hostSel: string): string =>
			selectorText
				.split(',')
				.map((s) => {
					s = s.trim();
					if (s.includes(':host')) {
						return s.replace(/:host\(([^)]*)\)/g, (_m, inner) => hostSel + inner.trim()).replace(/:host/g, hostSel);
					}
					return `${hostSel} ${s}`;
				})
				.join(', ');

		// Serialize CSSOM rules to text (innerHTML omits insertRule()/adoptedStyleSheets
		// rules), rewriting :host and recursing into @media/@supports groups.
		const serializeRules = (rules: CSSRuleList, hostSel: string): string => {
			let css = '';
			for (const rule of rules) {
				const styleRule = rule as CSSStyleRule;
				const groupRule = rule as CSSGroupingRule;
				if (styleRule.selectorText !== undefined && styleRule.style) {
					css += `${rewriteSelector(styleRule.selectorText, hostSel)}{${styleRule.style.cssText}}\n`;
				} else if (groupRule.cssRules) {
					const prelude = rule.cssText.slice(0, rule.cssText.indexOf('{'));
					css += `${prelude}{\n${serializeRules(groupRule.cssRules, hostSel)}}\n`;
				} else {
					css += rule.cssText + '\n'; // @keyframes, @font-face, …
				}
			}
			return css;
		};

		let hostSeq = 0;
		for (const host of hosts.reverse()) {
			try {
				const sr = host.shadowRoot as ShadowRoot;
				const hostId = `s${hostSeq++}`;
				host.setAttribute('data-shadow-host', hostId);
				const hostSel = `[data-shadow-host="${hostId}"]`;

				let css = '';
				const sheets = [...sr.styleSheets, ...((sr.adoptedStyleSheets as CSSStyleSheet[]) ?? [])];
				for (const sheet of sheets) {
					try {
						css += serializeRules(sheet.cssRules, hostSel);
					} catch {
						/* cross-origin stylesheet — cssRules not readable */
					}
				}
				// Resolve <slot>s: replace each with its projected (assigned) light-DOM nodes,
				// or its fallback content if nothing is assigned. This must happen before we
				// clear the host's light children, otherwise slotted content would be lost and
				// components using slot projection would render with the wrong structure.
				for (const slot of sr.querySelectorAll('slot')) {
					const assigned = slot.assignedNodes();
					const replacement = document.createDocumentFragment();
					if (assigned.length > 0) {
						for (const node of assigned) replacement.appendChild(node);
					} else {
						while (slot.firstChild) replacement.appendChild(slot.firstChild);
					}
					slot.replaceWith(replacement);
				}
				// Clear the host's remaining (unassigned, therefore unrendered) light children,
				// then move the resolved shadow tree into the host as direct children — so
				// `:host > x` / descendant relationships survive (a wrapper would break `>`).
				while (host.firstChild) host.removeChild(host.firstChild);
				if (css) {
					const style = document.createElement('style');
					style.textContent = css;
					host.appendChild(style);
				}
				while (sr.firstChild) host.appendChild(sr.firstChild);
			} catch {
				/* closed shadow root or serialization error — skip */
			}
		}
	}

	if (opts.resolveLazyImages) {
		// Copy the real URL from a lazy attribute into `src` for images that never got a
		// real `src` (off-screen carousel/grid slides). Without this they ship with an empty
		// or placeholder `src` and never load when the page is served.
		const lazyAttrs = ['data-lazy', 'data-src', 'data-original', 'data-image-src', 'data-img-src'];
		const firstUrl = (value: string): string => {
			const first = (value || '').trim().split(',')[0];
			return first ? first.trim().split(/\s+/)[0] : '';
		};
		// Any non-empty value that isn't a data:/javascript: URI or a bare hash — so relative
		// paths (`images/p.jpg`, `../logo.png`) resolve too, not just absolute/slash URLs.
		const isRealUrl = (u: string) => {
			const t = (u || '').trim();
			return t !== '' && !t.startsWith('data:') && !t.startsWith('javascript:') && !t.startsWith('#');
		};
		for (const img of document.querySelectorAll('img')) {
			const src = img.getAttribute('src') || '';
			const needsSrc = !src || src.startsWith('data:') || /loader|placeholder|spacer|blank|1x1|transparent/i.test(src);
			if (!needsSrc) continue;
			let real = '';
			for (const attr of lazyAttrs) {
				const v = img.getAttribute(attr) || '';
				if (isRealUrl(v)) {
					real = v;
					break;
				}
			}
			if (!real) real = firstUrl(img.getAttribute('srcset') || img.getAttribute('data-srcset') || '');
			if (real && isRealUrl(real)) img.setAttribute('src', real);
		}
	}

	if (opts.stripBlockedResources && blockedUrlPatterns.length > 0) {
		// Remove resource elements pointing at blocked hosts (ad/analytics/RUM pixels,
		// frames, scripts) so the served HTML doesn't fire them on load. Runs after the
		// shadow flatten so pixels that came from shadow content are caught too.
		document.querySelectorAll('img, iframe, script, source, embed, object, link, video, audio').forEach((el) => {
			const url =
				el.getAttribute('src') ||
				el.getAttribute('href') ||
				el.getAttribute('srcset') ||
				el.getAttribute('data-src') ||
				'';
			if (url && blockedUrlPatterns.some((pattern) => url.includes(pattern))) el.remove();
		});
	}

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
