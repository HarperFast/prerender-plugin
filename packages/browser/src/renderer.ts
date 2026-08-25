import { Renderer } from './Worker.js';
import type { RenderTimings } from './RenderJob.js';
import { settings } from './settings.js';
import { CACHE_REPLAY_HEADER, getResourceCache } from './ResourceCache.js';
import type { PostProcessConfig } from './config.js';
import { canonicalizeUrl, canonicalVerdict } from './util/url.js';
import { markRenderPhase } from './util/renderPhase.js';

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

	// The bypass token goes to the navigation's OWN origin and nowhere else, so it can never be
	// handed to a third-party host the page happens to pull from.
	//
	// Resolved against `navigationUrl` so a relative reference is judged the way the browser would
	// judge it. Puppeteer always hands us absolute URLs, so today this only matters if a caller or
	// refactor ever passes a bare path — it resolves to the navigation origin instead of throwing.
	// The base cannot widen what counts as same-origin: a protocol-relative (`//other.example`) or
	// absolute foreign URL still resolves to its own origin and gets no token, and opaque schemes
	// (`about:`, `data:`) resolve to a null origin, which never matches.
	const isSameOrigin = (requestUrl: string) => {
		try {
			return new URL(requestUrl, navigationUrl).origin === navigationUrl.origin;
		} catch {
			return false;
		}
	};

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
			// Same-origin SUBRESOURCES need the bypass token as much as the document does. An edge
			// bot-mitigation rule keyed on the token answers the tokened navigation with a normal
			// 200 but 403s every un-tokened asset behind it — so the page loads with no scripts and
			// no stylesheet, and the snapshot is raw un-hydrated SSR markup. That render looks
			// perfectly healthy from the outside (200, non-empty, indexable), which is exactly why
			// it went unnoticed: the only visible symptom is client-rendered content silently
			// missing from the cache. Measured against a live edge: `_astro/*.js` and the layout
			// CSS return 403 un-tokened and 200 tokened, from the same host, seconds apart.
			if (settings.bypass.token && isSameOrigin(req.url())) {
				req.continue({ headers: { ...req.headers(), [settings.bypass.header]: settings.bypass.token } }).catch(noop);
				return;
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

			// A same-origin asset the origin refused while the document succeeded. Recorded on the
			// attempt (mutated in place, like `timings`, so it survives an early return) and
			// aggregated by the worker — a render whose scripts all 403 otherwise reports as a
			// clean success.
			if (res.status() >= 400 && isSameOrigin(res.url()) && job.latestAttempt) {
				job.latestAttempt.subresourceErrors = (job.latestAttempt.subresourceErrors ?? 0) + 1;
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
	// Navigation gets the smaller of its own sub-cap and what's left of the render budget, so a
	// stalled origin fails fast instead of consuming the whole budget (see navigationTimeoutMs).
	const navigationTimeout = config.navigation.navigationTimeoutMs
		? Math.min(remainingTimer.remaining, config.navigation.navigationTimeoutMs)
		: remainingTimer.remaining;
	let finalRes;
	try {
		finalRes = await page.goto(navigationUrl.href, {
			waitUntil: config.navigation.waitUntil,
			timeout: navigationTimeout,
			signal: ac.signal,
		});
	} catch (e) {
		// Tag the phase so the worker separates "never reached waitUntil" from a settle-phase
		// timeout — same TimeoutError, different cause.
		throw markRenderPhase(e, 'navigation');
	}
	timings.navTotal = Date.now() - navStart;

	// A navigation that HTTP-redirected to a different document is not worth settling. The plugin
	// never serves this render from the job's own key: it either discards the content (destination
	// on a route we don't serve) or refiles it under the destination's key — content produced under
	// the WRONG job context (waitFor rules are scoped by the job URL's path, so the destination
	// page type's rules never ran). Post the redirect back now and let the plugin schedule the
	// destination as a first-class target; the settle phase dominates a render's CPU, so this
	// frees the slot almost entirely.
	//
	// Two deliberate scope limits:
	//  - HTTP redirects only (`redirectChain()` non-empty). A client-side redirect has no redirect
	//    status to report; it falls through, renders, and is caught by the post-render check below,
	//    exactly as before.
	//  - Origin/path changes only (query compared with an empty allowlist, i.e. ignored). The
	//    plugin re-keys the destination with its per-route query allowlist, so a query-only change
	//    can collapse back to the SAME cache key — bailing on that would throw away a render the
	//    plugin would have stored. Render through and let its allowlist decide.
	if (finalRes) {
		const redirectChain = finalRes.request().redirectChain();
		const landedUrl = page.url();
		if (redirectChain.length > 0 && canonicalizeUrl(landedUrl, []) !== canonicalizeUrl(url, [])) {
			job.redirectedTo = landedUrl;
			// The FIRST hop's status is the origin's statement about the job URL itself — the
			// permanence signal (301/308 moved for good, else temporary) the plugin keys the
			// keep-vs-replace decision on. A missing hop response falls back to 302: temporary is
			// the conservative reading (the plugin keeps the target and retries next interval).
			const firstHop = redirectChain[0].response();
			job.httpResponse = {
				statusCode: firstHop?.status() ?? 302,
				headers: firstHop?.headers() ?? {},
			};
			return;
		}
	}

	// Settle dominates a render's cost, and the plugin's store guard is `statusCode === 200 &&
	// content` — so a document that already disowns itself can never be stored however long it
	// settles. Decide against the pre-settle DOM and skip the settle when the answer is already no.
	//
	// Can only ever SKIP a render: anything that survives falls through to the post-settle check,
	// which stays authoritative because script-injected canonical/robots tags land after this point.
	// A non-200 is decided on the status alone. The `status >= 400` response handler above calls
	// `ac.abort()`, but that only stops SUBRESOURCE interception (see the `ac.signal.aborted` guards
	// in the request handlers) — the main document has already answered by then, so `goto` resolves
	// normally and a 404 would otherwise settle in full. Verified by test, not by reading: an
	// earlier review argued `goto` rejects here and the suite disproved it.
	//
	// Sitemap jobs are exempt: their content is stored even when non-indexable, so bailing would
	// change WHAT gets cached rather than only how long it took.
	if (config.navigation.skipSettleWhenNonIndexable && finalRes && !job.isFromSitemap) {
		const statusCode = finalRes.status();
		// A client-side redirect can fire before DOMContentLoaded, so these signals may already be
		// the destination's — which is the document a settle would have snapshotted anyway. The
		// evaluate can also lose its execution context to a navigation still in flight; falling
		// through to settle on that keeps the pre-flag behavior exactly.
		const signals = statusCode === 200 ? await page.evaluate(extractIndexSignals).catch(() => null) : null;
		const verdict =
			statusCode === 200
				? signals && indexVerdict(signals, page.url(), config.canonical.strict)
				: { isIndexable: false, reason: 'http-error' as const };
		if (verdict && !verdict.isIndexable) {
			// Report the landed url as the post-settle path does; without it a bail would swallow a
			// client-side redirect and the plugin would suppress the source instead of adopting the
			// destination as its own target.
			const landedUrl = page.url();
			if (canonicalizeUrl(landedUrl) !== canonicalizeUrl(job.url)) job.redirectedTo = landedUrl;
			job.httpResponse = { statusCode, headers: finalRes.headers() };
			job.isIndexable = false;
			job.reason = verdict.reason;
			return;
		}
	}

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

	// Declarative "wait for content" step (config.waitFor). For each rule: optionally scroll the
	// selector into view (to trip an IntersectionObserver-lazy widget the fast scroll-settle passed
	// over before it loaded), then poll — across the light DOM and open shadow roots — until the
	// content selector reaches minCount (optionally held stable for stableMs) or the rule's timeout
	// / the remaining render budget elapses. Best-effort: a rule that never satisfies just times
	// out (same discipline as the renderer's other waits), so it can never fail a render. Reached
	// identically by renderOnce and the fleet because both run this renderer over the same config.
	const applyWaitFor = async () => {
		// The URL path, used for per-rule pathPattern scoping (falls back to '' if job.url is odd).
		let path = '';
		try {
			path = new URL(url).pathname;
		} catch {
			/* leave '' */
		}
		for (const rule of config.waitFor ?? []) {
			// Per-rule scoping: skip rules that don't target this device or path, so a rule never
			// polls to its timeout on renders it isn't meant for (e.g. a PDP-reviews rule on a
			// category page, or on desktop where the content is already in view). Validated at config
			// load, so a bad pathPattern regex can't reach here.
			if (rule.devices && !rule.devices.includes(deviceType)) continue;
			if (rule.pathPattern && !new RegExp(rule.pathPattern).test(path)) continue;

			const contentSelector = rule.waitForSelector ?? rule.selector;
			const minCount = Math.max(1, rule.minCount ?? 1);
			const doScroll = rule.scrollIntoView !== false;
			const stableMs = Math.max(0, rule.stableMs ?? 0);
			const deadline = Date.now() + Math.min(remainingTimer.remaining, rule.timeoutMs ?? remainingTimer.remaining);
			let satisfiedSince = 0;
			let hasScrolled = false;
			while (Date.now() < deadline) {
				// Scroll the anchor into view ONCE (enough to trip its IntersectionObserver); the widget
				// then loads into the DOM and is counted regardless of scroll position. Avoids per-tick
				// layout thrash and fighting the page's own scroll handling. Keeps retrying until the
				// anchor is actually found (it may itself be injected late).
				if (doScroll && !hasScrolled) {
					const scrolled = await page.evaluate(scrollSelectorIntoView, rule.selector).catch(() => false);
					if (scrolled) hasScrolled = true;
				}
				let count: number;
				try {
					count = await page.evaluate(countMatchingElements, contentSelector);
				} catch {
					return; // page closed / navigated — stop instead of looping to the deadline.
				}
				if (count >= minCount) {
					if (stableMs === 0) break;
					if (satisfiedSince === 0) satisfiedSince = Date.now();
					else if (Date.now() - satisfiedSince >= stableMs) break;
				} else {
					satisfiedSince = 0;
				}
				await new Promise((resolve) => setTimeout(resolve, config.navigation.domStablePollMs));
			}
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

	// Content-readiness waits run AFTER the scroll/settle phase (so lazy widgets have been scrolled
	// through) and BEFORE the snapshot; scroll back to the top afterward so scroll-reactive UI
	// (sticky headers) re-lands. No-op unless config.waitFor is set. Its dwell is attributed to
	// `settle` on purpose — it reads as part of the settle budget.
	if (config.waitFor?.length) {
		await applyWaitFor();
		await scrollToTop();
	}
	timings.settle = Date.now() - settleStart;

	if (finalRes) {
		job.httpResponse = job.httpResponse || {
			statusCode: finalRes.status(),
			headers: finalRes.headers(),
		};
		const statusCode = job.httpResponse.statusCode;

		// Redirect detection uses the SHARED canonical form (matches the plugin), so encoding,
		// param order, hash, and trailing-slash differences never trip a false redirect. Post
		// back the RAW final URL — the plugin canonicalizes it with the real route allowlist.
		// HTTP redirects to a different origin/path bailed right after navigation (above); what
		// reaches this check is client-side redirects and query-only changes, rendered through.
		const rawPageUrl = page.url();
		if (canonicalizeUrl(rawPageUrl) !== canonicalizeUrl(job.url)) {
			job.redirectedTo = rawPageUrl;
		}

		if (statusCode === 200) {
			const { canonicalHref, noindex } = await page.evaluate(extractIndexSignals);
			// A canonical naming a DIFFERENT document always disowns the page — invariable, every
			// site. A canonical naming this very document RE-SPELLED as another cache key
			// ('variant') is only a duplicate if the site's origin cannot tell the two spellings
			// apart, which is a property of its query parser, not of the URLs — so that half is
			// config, defaulting to the historical lenient reading. See config.canonical.strict.
			// Either way the reason slug is distinct, so duplicate spellings stay legible next to
			// genuine mismatches.
			const verdict = indexVerdict({ canonicalHref, noindex }, rawPageUrl, config.canonical.strict);
			job.isIndexable = verdict.isIndexable;
			if (!verdict.isIndexable) {
				job.reason = verdict.reason;
			}

			if (job.isIndexable || job.isFromSitemap) {
				// Before postProcess: it may strip nodes, and this must describe the page as
				// rendered. Best-effort — a failure here must never cost the render its content.
				// null is posted AS null: on the wire, null means "extraction ran, no Product
				// offers (or it failed benignly)" while an ABSENT field means "renderer predates
				// this feature" — the consumer alarms on the latter, so collapsing null into
				// undefined would make every offerless page impersonate an outdated renderer.
				job.structuredOffers = await page.evaluate(extractStructuredOffers, STRUCTURED_OFFER_CAP).catch(() => null);
				const ppStart = Date.now();
				const content = await page.evaluate(postProcess, config.postProcess, config.block.urlPatterns);
				timings.postProcess = Date.now() - ppStart;
				return content;
			}
		} else {
			job.isIndexable = false;
			job.reason = 'http-error';
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
		// Guard the in-page math: a non-positive/NaN/pathologically-small fraction would floor to
		// a 1px step (an extremely slow pass), so fall back to the half-viewport default. Values
		// this small are already rejected by config validate(); this is in-page defense-in-depth.
		const frac = stepFraction >= 0.01 ? stepFraction : 0.5;
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

// Scroll the first element matching `selector` — searched across the light DOM and all open shadow
// roots — into the center of the viewport, to trip an IntersectionObserver-lazy widget. Returns
// whether an element was found and scrolled (so the caller can scroll once, then stop). Runs in-page
// (passed to page.evaluate), so it is fully self-contained.
function scrollSelectorIntoView(selector: string): boolean {
	const find = (root: Document | ShadowRoot): Element | null => {
		const direct = root.querySelector(selector);
		if (direct) return direct;
		for (const el of root.querySelectorAll('*')) {
			const sr = (el as Element).shadowRoot;
			if (sr) {
				const nested = find(sr);
				if (nested) return nested;
			}
		}
		return null;
	};
	const el = find(document);
	if (!el) return false;
	el.scrollIntoView({ block: 'center' });
	return true;
}

// Count elements matching `selector` across the light DOM and all open shadow roots (widgets like
// the reviews list render into shadow DOM, invisible to a light-DOM-only querySelectorAll). Runs
// in-page; self-contained.
// Allocation-free (matches the countDomElements walk): a manual firstChild/nextSibling traversal
// testing each element with `matches(selector)` and recursing into open shadow roots, rather than
// querySelectorAll('*') per root (which allocates a NodeList of every element on every poll tick).
function countMatchingElements(selector: string): number {
	let n = 0;
	const walk = (node: Node) => {
		if (node.nodeType === 1) {
			const el = node as Element;
			if (el.matches(selector)) n++;
			const sr = el.shadowRoot;
			if (sr) walk(sr);
		}
		for (let child = node.firstChild; child; child = child.nextSibling) walk(child);
	};
	// A malformed/empty selector makes matches() throw a SyntaxError; return 0 so a bad rule just
	// times out best-effort instead of throwing out of the wait loop and abandoning the remaining
	// rules. (A closed/navigated page rejects at page.evaluate — still handled upstream.)
	try {
		walk(document);
	} catch {
		return 0;
	}
	return n;
}

// Read indexability signals from the rendered DOM. DOM extraction only — the URL comparison
// lives in Node (util/url.ts) so it is unit-tested and can't drift from the redirect
// normalizer. (That drift is exactly what marked self-canonical pages non-indexable: the
// canonical's literal `:` never matched the request's `%3A`.)
// Shared by the pre-settle bail and the post-settle check so the two can never disagree about
// what "non-indexable" means. A canonical naming a DIFFERENT document always disowns the page;
// a canonical naming this very document RE-SPELLED is only a duplicate when the site's origin
// cannot tell the spellings apart, which is config, not a property of the URLs — see
// config.canonical.strict.
export function indexVerdict(
	signals: { canonicalHref: string | null; noindex: boolean },
	pageUrl: string,
	strict: boolean
): { isIndexable: boolean; reason?: 'noindex' | 'canonical-variant' | 'canonical-mismatch' } {
	const verdict = canonicalVerdict(signals.canonicalHref, pageUrl);
	const disowned = verdict === 'elsewhere' || (verdict === 'variant' && strict);
	if (!signals.noindex && !disowned) return { isIndexable: true };
	return {
		isIndexable: false,
		reason: signals.noindex ? 'noindex' : verdict === 'variant' ? 'canonical-variant' : 'canonical-mismatch',
	};
}

// Refusal threshold, not a sample size: a variant-heavy PDP legitimately carries dozens of offer
// triples, but past this the page posts NO claim rather than a truncated one (see
// extractStructuredOffers — a deterministic sample can systematically disagree with the
// consumer's endpoint).
const STRUCTURED_OFFER_CAP = 200;

/**
 * The page's schema.org Product offers, flattened to [price, currency, availability] triples and
 * sorted so the sequence is stable across renders of unchanged content.
 *
 * Runs IN THE PAGE against the settled DOM, which is the whole point: the consumer would otherwise
 * have to regex-scan and JSON-parse the serialized document (~1MB on a commerce PDP) on its hottest
 * write path to recover values this process can read directly. Returns null when the page declares
 * no Product offers, so "no structured data" stays distinguishable from "no offers".
 *
 * A page carrying MORE offers than the cap also returns null — no claim, never a truncated one. A
 * deterministic sample that happens to omit the offer the consumer's endpoint reports would
 * disagree with it on every comparison, and a systematic disagreement means the consumer expires
 * and re-renders that page forever. "Too many offers to read confidently" degrades to exactly
 * what "no offers" does: nothing.
 *
 * Self-contained (passed to page.evaluate) — no imports, no closure over module scope.
 */
function extractStructuredOffers(cap: number): Array<string | null> | null {
	const triples: Array<Array<string | null>> = [];
	let overflowed = false;
	// Field-level byte bound: the cap bounds triple COUNT, so without this a single pathological
	// field (a megabyte "price" string) would still inflate every posted result for the page. No
	// legitimate price, currency code, or availability token approaches 64 characters.
	const bound = (value: string): string | null => (value === '' ? null : value.slice(0, 64));
	const collect = (node: unknown) => {
		if (overflowed || !node || typeof node !== 'object') return;
		const record = node as Record<string, unknown>;
		const type = record['@type'];
		const isProduct = type === 'Product' || (Array.isArray(type) && type.includes('Product'));
		if (!isProduct) return;
		const raw = record.offers;
		const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
		for (const entry of list) {
			if (!entry || typeof entry !== 'object') continue;
			if (triples.length >= cap) {
				overflowed = true;
				return;
			}
			const offer = entry as Record<string, unknown>;
			// filter(Boolean) before pop: a trailing slash (https://schema.org/InStock/) would
			// otherwise pop the empty segment and read as no availability at all.
			const availability =
				typeof offer.availability === 'string'
					? bound(offer.availability.split('/').filter(Boolean).pop() ?? '')
					: null;
			const price = offer.price === undefined || offer.price === null ? null : bound(String(offer.price));
			const currency = typeof offer.priceCurrency === 'string' ? bound(offer.priceCurrency) : null;
			triples.push([price, currency, availability]);
		}
	};
	document.querySelectorAll('script[type="application/ld+json"]').forEach((el) => {
		if (overflowed) return;
		let data: unknown;
		try {
			data = JSON.parse(el.textContent || '');
		} catch {
			return; // one malformed block must not cost the page its other blocks
		}
		const graph = (data as Record<string, unknown>)?.['@graph'];
		const nodes = Array.isArray(data) ? data : Array.isArray(graph) ? graph : [data];
		for (const node of nodes) {
			if (overflowed) break;
			collect(node);
		}
	});
	if (overflowed || !triples.length) return null;
	// Field-wise, not JSON.stringify per comparison: sorting is O(n log n) COMPARISONS, so
	// stringifying inside the comparator serialises every triple many times over. Code-unit
	// comparison, not localeCompare: the whole point of the sort is a sequence that is identical
	// across renders, and collation varies with the browser's locale/ICU.
	triples.sort((a, b) => {
		for (let i = 0; i < 3; i++) {
			const x = a[i];
			const y = b[i];
			if (x === y) continue;
			if (x === null) return -1;
			if (y === null) return 1;
			return x < y ? -1 : 1;
		}
		return 0;
	});
	return triples.flat();
}

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
				// Deliberately terse, and unquoted in the selector. This token is private — we mint
				// it here and consume it in the rules below, within the same document, so nothing
				// outside reads it and the name carries no contract. It is also repeated once per
				// SELECTOR (`rewriteSelector` splits comma-separated lists and prefixes each part),
				// so its length is multiplied by the rule count of every flattened shadow root: on
				// one measured review-heavy page it appeared 11,589 times, and `data-shadow-host`
				// with quotes cost 127 KB more than this spelling for identical output. `sN` is
				// always a valid CSS identifier, so the unquoted form is safe by construction.
				host.setAttribute('data-sh', hostId);
				const hostSel = `[data-sh=${hostId}]`;

				let css = '';
				const sheets = [...sr.styleSheets, ...((sr.adoptedStyleSheets as CSSStyleSheet[]) ?? [])];
				// Nodes whose rules made it into `css` above. Their originals must NOT be moved into
				// the light DOM with the rest of the shadow tree: `css` is the SCOPED copy, and the
				// original is the unscoped one the shadow boundary used to contain. Moving it out
				// would (a) re-emit every rule a second time and (b) defeat the scoping entirely —
				// a bare `button {…}` rule, perfectly safe inside a shadow root, would repaint every
				// button on the page. Only nodes we actually captured are dropped; a sheet that
				// failed to serialize (cross-origin `<link>`) keeps its element, since losing the
				// styling outright would be the worse of the two failures.
				const captured = new Set<Node>();
				for (const sheet of sheets) {
					try {
						css += serializeRules(sheet.cssRules, hostSel);
						if (sheet.ownerNode) captured.add(sheet.ownerNode);
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
						// Slotted nodes were ALWAYS light DOM and were always styled by the page, so
						// they must be exempt from the author-style reset below. Mark their roots.
						for (const node of assigned) {
							if (node.nodeType === 1) (node as Element).setAttribute('data-sl', '');
							replacement.appendChild(node);
						}
					} else {
						while (slot.firstChild) replacement.appendChild(slot.firstChild);
					}
					slot.replaceWith(replacement);
				}
				// Clear the host's remaining (unassigned, therefore unrendered) light children,
				// then move the resolved shadow tree into the host as direct children — so
				// `:host > x` / descendant relationships survive (a wrapper would break `>`).
				while (host.firstChild) host.removeChild(host.firstChild);
				// Restore the INBOUND half of the encapsulation the boundary provided. Outbound is
				// handled by prefixing every shadow rule with `hostSel`; inbound is this. Without
				// it the page's own rules — which could never reach this markup while it sat behind
				// a shadow root — apply the moment it lands in the light DOM. A Tailwind Preflight
				// `svg{display:block}` is the canonical case: it turns a five-star rating widget
				// into a vertical column, because inside the shadow root it never applied.
				//
				// `all: revert` drops author-level declarations, which is exactly what the boundary
				// did, while inherited properties still inherit (as they do through a real boundary).
				//
				// The specificity is load-bearing and deliberately (0,1,0):
				//   - it BEATS the page's element-selector resets (0,0,1), which is the whole point;
				//   - it LOSES to every rewritten shadow rule — `[data-sh] button` (0,1,1) and
				//     `[data-sh] .cls` (0,2,0) — so the component's own styling still wins;
				//   - the `:not()` is wrapped in `:where()` so the exemption contributes NOTHING to
				//     specificity. Written bare, `:not([data-sl] *)` would raise this to (0,2,0) and
				//     start beating the shadow rules it must lose to.
				const reset = `${hostSel} *:where(:not([data-sl],[data-sl] *)){all:revert}\n`;
				const style = document.createElement('style');
				style.textContent = reset + css;
				host.appendChild(style);
				for (const node of [...sr.childNodes]) {
					if (captured.has(node)) continue; // its rules are already in the scoped block
					host.appendChild(node);
				}
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

	if (opts.minifyInlineCss) {
		// Re-emit each inline sheet from the CSSOM rather than keeping the origin's source text.
		// Same operation as `inlineEmptyStyleSheets` above, widened from empty sheets to every one
		// — and it runs after it deliberately, so a sheet that step just filled is re-emitted from
		// the same CSSOM it was built from (a no-op) rather than being minified twice.
		//
		// The browser has already parsed these rules, so this cannot corrupt CSS the way a regex
		// minifier can. What it CAN do is drop rules Chrome did not implement (an
		// `@-moz-document` block, an `-ms-*` declaration) — see the config docs for the measured
		// scope of that.
		const serialize = (rules: CSSRuleList): string => {
			let css = '';
			for (const rule of rules) css += rule.cssText;
			return css;
		};
		for (const style of document.querySelectorAll('style')) {
			const sheet = style.sheet;
			if (!sheet) continue;
			let css: string;
			try {
				css = serialize(sheet.cssRules);
			} catch {
				continue; // unreadable (cross-origin) — leave the source text alone
			}
			// An empty result on a non-empty sheet means every rule was dropped or the sheet never
			// parsed; keeping the original is the conservative call. Never grow the document.
			if (css && css.length < style.textContent!.length) style.textContent = css;
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

	// Late, deliberately: every step above keys on attributes this can remove
	// (`stripBlockedResources` reads src/href/srcset, a `removeSelectors` entry can match on
	// an attribute selector), so stripping earlier would change what they match. Only
	// `pruneUnmatchedCss` runs after, and it must — it reads the finished DOM.
	for (const rule of opts.removeAttributes ?? []) {
		let elements: NodeListOf<Element>;
		try {
			elements = document.querySelectorAll(rule.selector);
		} catch {
			continue; // malformed selector — skip the rule, never fail the render over it
		}
		// Same contract as the malformed selector above: a rule that cannot be applied is skipped,
		// never fatal. `validate()` already guarantees the shape, but this runs inside the page —
		// a throw here fails the whole render job, out of all proportion to one bad rule.
		if (!Array.isArray(rule.attributes)) continue;
		// Split exact names from `prefix*` matches once per rule, not once per element.
		// A bare '*' yields an empty prefix and is dropped: it would strip every attribute.
		const exact = new Set<string>();
		const prefixes: string[] = [];
		for (const name of rule.attributes) {
			const lower = name.trim().toLowerCase();
			if (lower.endsWith('*')) {
				const prefix = lower.slice(0, -1);
				if (prefix) prefixes.push(prefix);
			} else if (lower) {
				exact.add(lower);
			}
		}
		if (exact.size === 0 && prefixes.length === 0) continue;
		for (const el of elements) {
			// `el.attributes` is a LIVE NamedNodeMap — snapshot it, or removing an attribute
			// re-indexes the map underneath the loop and skips the next one.
			for (const attr of [...el.attributes]) {
				const name = attr.name.toLowerCase();
				if (exact.has(name) || prefixes.some((prefix) => name.startsWith(prefix))) {
					el.removeAttribute(attr.name);
				}
			}
		}
	}

	if (opts.pruneUnmatchedCss) {
		// Drop style rules that cannot match anything in the finished document. Runs LAST: every
		// step above changes what exists to be matched, and `validate()` has already guaranteed
		// `stripScripts`, so nothing can re-introduce a match after serialization.
		//
		// Probe policy is one-directional — every uncertainty keeps the rule:
		//  * state pseudo-classes and pseudo-elements are stripped before probing, so `.x:hover`
		//    is judged on whether `.x` exists. Structural pseudos (`:not()`, `:nth-child()`) go
		//    too, which only widens the probe.
		//  * a selector whose quoted value contains a `:` is kept untested. The strip is a regex,
		//    and `[style*="display: block"]` is exactly the shape it would cut through the middle
		//    of. Quotes alone are not the hazard — a colon inside them is — and the distinction
		//    matters: on the flagged page 2,674 of 3,589 selectors carry a quote (the reviews
		//    widget keys on `[data-bv-show="…"]`), while just 2 have a colon inside one.
		//  * anything that fails to parse once rewritten — a `:is(a` left by splitting a selector
		//    list on a comma inside parentheses, say — throws, and a throw keeps the rule.
		const PSEUDO = /::?[a-zA-Z-]+(\([^()]*\))?/g;
		const colonInsideQuotes = (selector: string): boolean => {
			let quote = '';
			for (let i = 0; i < selector.length; i++) {
				const ch = selector[i];
				if (quote) {
					if (ch === quote) quote = '';
					else if (ch === ':') return true;
				} else if (ch === '"' || ch === "'") quote = ch;
			}
			return false;
		};
		// The DOM does not change while this runs — only CSS rules are deleted — so a probe's
		// answer depends on the probe string alone and is worth remembering. Sheets repeat
		// selectors heavily (a utility framework, a component library scoped to one host), and on
		// the flagged page this turns 4,387 `querySelector` calls into 3,144: 114ms down to 81ms.
		const probed = new Map<string, boolean>();
		const canEverMatch = (selectorText: string): boolean => {
			for (const part of selectorText.split(',')) {
				const one = part.trim();
				if (one === '' || colonInsideQuotes(one)) return true;
				const probe = one.replace(PSEUDO, '').trim();
				if (probe === '') return true; // e.g. `::selection` — nothing left to test
				const seen = probed.get(probe);
				if (seen !== undefined) {
					if (seen) return true;
					continue;
				}
				let matched: boolean;
				try {
					matched = document.querySelector(probe) !== null;
				} catch {
					matched = true; // unparseable once rewritten — never prune on a broken probe
				}
				probed.set(probe, matched);
				if (matched) return true;
			}
			return false;
		};
		// Grouping rules (@media/@supports/@layer/@container/@scope) are recursed into but never
		// deleted, even when emptied: an `@layer` block that disappears takes its position in the
		// cascade order with it. An empty `@media(){}` husk costs a few bytes and risks nothing.
		// @keyframes and @font-face have no selectorText and no `cssRules`, so both fall through
		// untouched — an animation whose rules were pruned still resolves its keyframes.
		const pruneRules = (owner: { deleteRule(index: number): void }, rules: CSSRuleList): void => {
			// Backwards: deleteRule re-indexes everything after it.
			for (let i = rules.length - 1; i >= 0; i--) {
				const rule = rules[i];
				// `instanceof` rather than duck-typing on `selectorText`/`cssRules`: CSSKeyframesRule
				// also has `cssRules` but its `deleteRule` takes a keyframe selector, not an index,
				// and CSSPageRule also has `selectorText`. Neither is one of these two types.
				if (rule instanceof CSSStyleRule) {
					if (!canEverMatch(rule.selectorText)) owner.deleteRule(i);
					continue;
				}
				if (rule instanceof CSSGroupingRule) pruneRules(rule, rule.cssRules);
			}
		};
		for (const style of document.querySelectorAll('style')) {
			const sheet = style.sheet;
			if (!sheet) continue;
			let css = '';
			try {
				pruneRules(sheet, sheet.cssRules);
				for (const rule of sheet.cssRules) css += rule.cssText;
			} catch {
				continue; // unreadable (cross-origin) — leave the source text alone
			}
			// Same guard as `minifyInlineCss`: never grow the document. A sheet whose rules were
			// all pruned legitimately serializes to '' — the CSSOM itself says nothing is left —
			// so an empty result is written, unlike there, where it would mean a parse failure.
			if (css.length < style.textContent!.length) style.textContent = css;
		}
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
