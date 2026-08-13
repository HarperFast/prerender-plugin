/**
 * On-demand, off-queue rendering — the debugging / testing / analysis counterpart to
 * `startWorker()`. `renderOnce()` runs the SAME production render path a worker would (the exact
 * `defaultRenderer` over the real `resolveSettings` → config → `ManagedBrowser` → `RenderJob`
 * path) for a single URL fed directly, and returns the HTML + per-phase timings + outcome signals
 * instead of claiming a job and posting the result back. Nothing here touches MQTT or the queue.
 *
 * Flexibility (testing → prerenderability analysis → arbitrary future probes) comes from three
 * runtime-supplied extension points, so the package bakes in no site-specific values:
 *   1. `probes` — async fns run against the live, settled, post-processed page before teardown
 *      (a screenshot, a selector/substring count, a shadow-DOM-presence scan, a future a11y/LCP/CDP
 *      probe are all just probes). Two neutral factories ship: `selectorCountProbe`, `htmlContainsProbe`.
 *   2. `keepOpen` — return the still-open page/browser + an idempotent `close()` for anything a
 *      structured probe map is too rigid for (attach CDP, step interactively, re-navigate).
 *   3. `renderer` / `config` — the same options `startWorker` takes, so a consumer can pass its
 *      EXACT deployed renderer + config in and get a faithful reproduction to analyze.
 *
 * `renderOnce`/`renderMatrix` mutate the process-global `settings` and are intended to run one at a
 * time (single-flight), like `startWorker` — do not call them concurrently in one process.
 */

import type { Browser, LaunchOptions, Page } from 'puppeteer';
import ManagedBrowser from './ManagedBrowser.js';
import RenderJob from './RenderJob.js';
import type { RenderTimings } from './RenderJob.js';
import defaultRenderer from './renderer.js';
import type { Renderer } from './Worker.js';
import { resolveSettings, defaultLaunchOptions, settings } from './settings.js';
import type { BrowserOptions } from './settings.js';
import { initResourceCache } from './ResourceCache.js';
import type { PrerenderConfig, Viewport } from './config.js';
import { noop } from './util/noop.js';
import logger from './util/Logger.js';

/** What a probe receives: the live post-render page + browser and everything the render computed. */
export interface ProbeContext {
	/** Live page — POST-render, so its DOM is already the post-processed/serialized form (see html). */
	page: Page;
	browser: Browser;
	/** The job the renderer mutated: httpResponse, isIndexable, redirectedTo, attempts/timings. */
	job: RenderJob;
	/** The renderer's returned HTML (=== the serialized post-processed DOM), or undefined. */
	html: string | undefined;
	/** The fully-resolved config actually used for this render. */
	config: PrerenderConfig;
	device: string;
}

/** A caller-supplied analysis run against the live page before teardown. Result is collected by key. */
export type Probe<T = unknown> = (ctx: ProbeContext) => T | Promise<T>;

export interface RenderOnceOptions extends Omit<BrowserOptions, 'harper'> {
	/** URL to render. */
	url: string;
	/** Device profile key (into config.devices). Default: config.defaultDevice. */
	device?: string;
	/** Extra per-navigation request headers (merged onto the request like a job's headers). */
	headers?: Record<string, string>;
	acceptLanguage?: string;
	/** Per-render time budget (ms) → job.renderBudget. Default: config.navigation.renderBudgetMs. */
	renderBudgetMs?: number;
	/** Optional — an off-queue render never reads settings.harper, so a connection is not required. */
	harper?: Partial<BrowserOptions['harper']>;
	/** Renderer to use. Default the built-in defaultRenderer; pass a consumer's own for parity. */
	renderer?: Renderer;
	/**
	 * Serialize even non-indexable pages (so the HTML is always inspectable). Default true — this is
	 * a documented deviation from production's indexable-or-sitemap gate, appropriate for a harness.
	 */
	captureNonIndexable?: boolean;
	/**
	 * Launch overrides merged OVER the shared defaultLaunchOptions() (e.g. { headless: false } to
	 * watch the render, devtools, slowMo). Fidelity-affecting — an opt-in, never on by default.
	 */
	launch?: Partial<LaunchOptions>;
	/** Capture a screenshot of the (post-processed) page after render. `true` → full page. */
	screenshot?: boolean | { fullPage?: boolean };
	/** Analyses run against the live page after render, before teardown; results keyed into result.probes. */
	probes?: Record<string, Probe>;
	/** Keep the page/browser open and hand them back (caller owns close()). Default false (auto-close). */
	keepOpen?: boolean;
	/** Reuse an already-launched browser (renderMatrix). When provided, renderOnce does NOT close it. */
	browser?: ManagedBrowser;
}

export type RenderOutcome = 'ok' | 'empty' | 'non-indexable' | 'http-error' | 'redirected' | 'error';

export interface RenderResult {
	url: string;
	device: string;
	viewport: Viewport;
	html: string | undefined;
	htmlBytes: number;
	/** A one-word "why" for the render, derived with a fixed precedence (see deriveOutcome). */
	outcome: RenderOutcome;
	statusCode: number | undefined;
	isIndexable: boolean | undefined;
	/** Why no cacheable content: 'noindex' | 'canonical-mismatch' | 'canonical-variant' | 'http-error' | 'redirect-loop' | 'redirect' | 'error'. */
	reason: string | undefined;
	/** Normalized redirect target (job.redirectedTo), if the final URL canonically differs. */
	redirectedTo: string | undefined;
	/** Raw page.url() at snapshot time (complements the normalized redirectedTo). */
	finalUrl: string | undefined;
	/** Sanitized response headers, exactly the allowlist a worker posts back. */
	responseHeaders: Record<string, string> | undefined;
	/** Per-phase wall-clock split { navTtfb, navTotal, settle, postProcess } — same as prod stats. */
	timings: RenderTimings;
	renderTimeMs: number | undefined;
	screenshot: Uint8Array | undefined;
	/** Set when the renderer threw — the result is still returned (mirrors Worker.render). */
	error: { name: string; message: string } | undefined;
	config: PrerenderConfig;
	job: RenderJob;
	probes: Record<string, unknown>;
	/** Present only when keepOpen: true. */
	page?: Page;
	browser?: Browser;
	/** Idempotent teardown (closes the page, and the browser unless it was caller-provided). */
	close(): Promise<void>;
}

// One-word "why" with fixed precedence so a human reads the outcome at a glance. Order matters:
// a 4xx aborts navigation (the renderer throws), so http-error is checked FIRST and never presented
// as a clean render; a thrown non-4xx is 'error'; otherwise HTML present wins ('ok'), then the
// explicit non-indexable / redirect signals, else 'empty'.
function deriveOutcome(job: RenderJob, html: string | undefined, error: unknown): RenderOutcome {
	const status = job.httpResponse?.statusCode;
	if (status !== undefined && status >= 400) return 'http-error';
	if (error) return 'error';
	if (html) return 'ok';
	if (job.isIndexable === false) return 'non-indexable';
	if (job.redirectedTo) return 'redirected';
	return 'empty';
}

/**
 * Render a single URL on demand, off the queue. See the module doc for the extension points.
 */
export async function renderOnce(options: RenderOnceOptions): Promise<RenderResult> {
	const {
		url,
		device,
		headers,
		acceptLanguage,
		renderBudgetMs,
		harper,
		renderer: customRenderer,
		captureNonIndexable,
		launch,
		screenshot,
		probes,
		keepOpen,
		browser: providedBrowser,
		...browserOptions
	} = options;

	if (!url) throw new Error('renderOnce: `url` is required');

	// Resolve config/bypass/chromeArgs through the SAME path prod uses. Harper is not required (an
	// off-queue render never reads settings.harper); the resource cache defaults OFF for a clean cold
	// render unless the caller explicitly enables it (a warm-fleet comparison must also set a
	// separate cache dir — the shared URL-keyed dir cross-contaminates staging↔prod).
	resolveSettings(
		{ ...browserOptions, harper: harper ?? {}, resourceCache: { enabled: false, ...browserOptions.resourceCache } },
		{ requireHarper: false }
	);

	// Always (re)initialize the resource cache from the resolved settings — including the disabled
	// default, where initResourceCache nulls the process-global cache. Skipping it when disabled
	// would leave a cache a PRIOR in-process render (or startWorker) installed still active, so the
	// documented cold render would silently serve/store sub-resources from it.
	await initResourceCache(settings.resourceCache);

	const deviceType = device ?? settings.config.defaultDevice;
	const profile = settings.config.devices[deviceType];
	if (!profile) {
		throw new Error(
			`renderOnce: device "${deviceType}" is not in config.devices (have: ${Object.keys(settings.config.devices).join(', ')})`
		);
	}

	const renderFn = customRenderer ?? defaultRenderer;
	const ownsBrowser = !providedBrowser;
	const managed =
		providedBrowser ??
		(await ManagedBrowser.launch({
			maxActivePages: 1,
			// Shared launch options so Chrome parity with startWorker can't drift; caller `launch`
			// overrides (headful/devtools) are documented fidelity-affecting opt-ins.
			puppeteerLaunchOptions: { ...(settings.browserLaunchOptions ?? defaultLaunchOptions()), ...launch },
		}));

	const job = new RenderJob({
		id: 'render-once',
		url,
		expiresAt: Date.now() + 60 * 60 * 1000, // far future — renderOnce never posts a result
		deviceType,
		acceptLanguage,
		renderBudget: renderBudgetMs,
		callbackOrigin: 'http://localhost', // unused: no sendResult
		isFromSitemap: captureNonIndexable ?? true, // serialize even non-indexable pages so HTML is inspectable
		headers,
	});

	let page: Page | undefined;
	let closed = false;
	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		if (page && !page.isClosed()) await managed.closePage(page).catch(noop);
		if (ownsBrowser) await managed.close().catch(noop);
	};

	let html: string | undefined;
	let error: { name: string; message: string } | undefined;

	try {
		page = await managed.getPage();

		// MUST precede renderFn: renderer.ts attaches the timings object only when job.latestAttempt
		// exists, so miss this and per-phase timings silently vanish.
		job.attemptStarted();
		try {
			html = await renderFn(page, job);
		} catch (e) {
			const err = e as Error;
			// Mirror Worker.render: a redirect loop is a non-indexable signal, not just a generic
			// error — so the harness reports the same isIndexable a worker would post.
			if (err.message?.startsWith('net::ERR_TOO_MANY_REDIRECTS')) {
				job.isIndexable = false;
				job.reason = 'redirect-loop';
			}
			error = { name: err.name, message: err.message };
		}
		job.attemptEnded(error ? new Error(error.message) : undefined, html);

		// Probes + screenshot + finalUrl are captured from the LIVE page, before any teardown.
		const probeResults: Record<string, unknown> = {};
		let shot: Uint8Array | undefined;
		let finalUrl: string | undefined;
		if (page && !page.isClosed()) {
			finalUrl = page.url();
			if (probes) {
				const ctx: ProbeContext = {
					page,
					browser: managed.browser,
					job,
					html,
					config: settings.config,
					device: deviceType,
				};
				for (const [name, probe] of Object.entries(probes)) {
					try {
						probeResults[name] = await probe(ctx);
					} catch (e) {
						probeResults[name] = { error: (e as Error).message };
					}
				}
			}
			if (screenshot) {
				const fullPage = typeof screenshot === 'object' ? (screenshot.fullPage ?? true) : true;
				shot = await page
					.screenshot({ fullPage })
					.catch((e) => (logger.warn({ err: e }, 'renderOnce: screenshot failed'), undefined));
			}
		}

		const attempt = job.latestAttempt;
		const result: RenderResult = {
			url,
			device: deviceType,
			viewport: profile.viewport,
			html,
			htmlBytes: html ? Buffer.byteLength(html) : 0,
			outcome: deriveOutcome(job, html, error),
			statusCode: job.httpResponse?.statusCode,
			isIndexable: job.isIndexable,
			reason: job.reason ?? (error ? 'error' : !html && job.redirectedTo ? 'redirect' : undefined),
			redirectedTo: job.redirectedTo,
			finalUrl,
			responseHeaders: job.httpResponse?.headers,
			timings: attempt?.timings ?? {},
			renderTimeMs: attempt?.renderEndTime !== undefined ? attempt.renderEndTime - attempt.renderStartTime : undefined,
			screenshot: shot,
			error,
			config: settings.config,
			job,
			probes: probeResults,
			page: keepOpen ? page : undefined,
			browser: keepOpen ? managed.browser : undefined,
			close,
		};

		if (!keepOpen) await close();
		return result;
	} catch (e) {
		// Unexpected infra failure (e.g. getPage) — never leak Chrome.
		await close();
		throw e;
	}
}

/**
 * Render one URL across several devices, reusing a single settings resolution and a single browser
 * (device is a job field, not a settings field, so this is faithful and race-free). Renders
 * sequentially and returns one RenderResult per device — the substrate for a desktop-vs-mobile
 * comparison. The browser is always closed at the end.
 */
export async function renderMatrix(
	url: string,
	devices: string[],
	options: Omit<RenderOnceOptions, 'url' | 'device' | 'browser' | 'keepOpen'> = {}
): Promise<RenderResult[]> {
	resolveSettings(
		{ ...options, harper: options.harper ?? {}, resourceCache: { enabled: false, ...options.resourceCache } },
		{ requireHarper: false }
	);
	// Always (re)initialize the resource cache from the resolved settings — including the disabled
	// default, where initResourceCache nulls the process-global cache. Skipping it when disabled
	// would leave a cache a PRIOR in-process render (or startWorker) installed still active, so the
	// documented cold render would silently serve/store sub-resources from it.
	await initResourceCache(settings.resourceCache);
	const browser = await ManagedBrowser.launch({
		maxActivePages: 1,
		puppeteerLaunchOptions: { ...(settings.browserLaunchOptions ?? defaultLaunchOptions()), ...options.launch },
	});
	const results: RenderResult[] = [];
	try {
		for (const device of devices) {
			results.push(await renderOnce({ ...options, url, device, browser }));
		}
	} finally {
		await browser.close().catch(noop);
	}
	return results;
}

/**
 * Probe factory: count elements matching each selector on the LIVE page, walking the light DOM and
 * all open shadow roots (so shadow-DOM widgets like a reviews list are counted). This is the
 * "did it actually load into the DOM" signal — distinct from a serialized-HTML substring count,
 * which can differ when flattenShadowDom is off. Selectors are runtime arguments; nothing baked in.
 */
export function selectorCountProbe(selectors: string[]): Probe<Record<string, number>> {
	return ({ page }) => {
		if (page.isClosed()) return {};
		return page.evaluate((sels: string[]) => {
			const countMatches = (selector: string): number => {
				let n = 0;
				const walk = (root: Document | ShadowRoot) => {
					n += root.querySelectorAll(selector).length;
					for (const el of root.querySelectorAll('*')) {
						const sr = (el as Element).shadowRoot;
						if (sr) walk(sr);
					}
				};
				walk(document);
				return n;
			};
			const out: Record<string, number> = {};
			for (const s of sels) out[s] = countMatches(s);
			return out;
		}, selectors);
	};
}

/**
 * Probe factory: count occurrences of each needle in the serialized HTML (the exact bytes that ship
 * to the cache). This is the "did it survive serialization" signal — pair it with
 * selectorCountProbe to separate "never loaded" from "loaded but lost in serialization". Needles are
 * runtime arguments; nothing baked in.
 */
export function htmlContainsProbe(needles: string[]): Probe<Record<string, number>> {
	return ({ html }) => {
		const h = html ?? '';
		const out: Record<string, number> = {};
		for (const needle of needles) {
			out[needle] = needle ? h.split(needle).length - 1 : 0;
		}
		return out;
	};
}

export default renderOnce;
