// serveState.mjs — spec §3.1: construct state C by intercepting the main navigation and
// responding with B's snapshot bytes AT THE REAL URL, so relative / absolute / protocol-relative
// (`//host`) / CSS `url()` references all resolve against the true origin and get routed by
// `--host-resolver-rules` to staging exactly as prod would. Sub-resource requests carry the same
// bypass token B used, and mirror B's URL-pattern blocking, so C is a faithful "what actually
// displays when the served bytes load" render.
//
// Customer-agnostic: url / html / bypass{header,token} / blockUrlPatterns all arrive as parameters.
// Reuses the SAME browser as the B render (keepOpen), so host-resolver + launch args match.

import type { Browser, Page, HTTPRequest, HTTPResponse } from 'puppeteer';
import { sleep, noop } from './util.js';

/**
 * Load state C: intercept the main navigation and serve `html` at `url`.
 *
 * @param {import('puppeteer').Browser} browser  the same browser instance that rendered B
 * @param {object} opts
 * @param {string} opts.url                        the real URL (interception target + goto target)
 * @param {string} opts.html                       B's serialized snapshot bytes to serve
 * @param {{header:string, token:string}} [opts.bypass]  bot-mitigation bypass header/token for subrequests
 * @param {string[]} [opts.blockUrlPatterns]       substring patterns whose requests to abort (mirror B's block)
 * @returns {Promise<{page: import('puppeteer').Page, failed: Map<string,string>}>}
 *          `page` = the settled C page; `failed` = url -> errorText / 'HTTP <code>' for graceful
 *          image degradation downstream (detectors split BROKEN_SRC vs LOAD_FAILED vs UNREACHABLE_IN_ENV).
 */
export async function loadServed(
	browser: Browser,
	{
		url,
		html,
		bypass,
		blockUrlPatterns = [],
	}: { url: string; html: string; bypass?: { header: string; token: string }; blockUrlPatterns?: string[] }
): Promise<{ page: Page; failed: Map<string, string> }> {
	const page = await browser.newPage();
	const failed = new Map<string, string>(); // url -> errorText, for graceful image degradation

	await page.setRequestInterception(true);

	page.on('request', (req: HTTPRequest) => {
		// Clone headers so we can augment without mutating puppeteer's internal object.
		const h = { ...req.headers() };
		if (bypass && bypass.token) h[bypass.header] = bypass.token; // staging asset subrequests need the token

		// Interception can race (disabled mid-flight, request already handled) — each of respond/
		// abort/continue can throw SYNCHRONOUSLY ("Request is already handled!") or reject. Wrap the
		// whole handler in try/catch AND .catch the returned promise so one bad request never throws
		// out of the event listener.
		try {
			// The main-frame navigation to the real URL: answer with B's bytes.
			if (req.isNavigationRequest() && req.frame() === page.mainFrame() && req.url() === url) {
				return req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: html }).catch(noop);
			}
			// Mirror B's URL-pattern blocking (trackers/etc.) so C loads the same asset set B did.
			if (blockUrlPatterns.some((p) => req.url().includes(p))) {
				return req.abort().catch(noop);
			}
			return req.continue({ headers: h }).catch(noop);
		} catch {
			// Already-handled / interception-disabled race: best-effort continue, then give up.
			try {
				return req.continue().catch(noop);
			} catch {
				return undefined;
			}
		}
	});

	// Record sub-resource failures (bad token, unroutable CDN, 4xx/5xx) for the image-canary tiers.
	page.on('requestfailed', (r: HTTPRequest) =>
		failed.set(r.url(), (r.failure() && (r.failure() as { errorText: string }).errorText) || 'failed')
	);
	page.on('response', (r: HTTPResponse) => {
		if (r.status() >= 400) failed.set(r.url(), 'HTTP ' + r.status());
	});

	// Bounded navigation + settle: goto ≤20s, network-idle ≤5s, then a fixed 1.5s dwell so CSS
	// transitions/fades finish before detectors hit-test the page. Every wait is `.catch(noop)`'d —
	// a timeout here is not fatal; C construction is deterministic given B (scripts stripped).
	await page.goto(url, { waitUntil: 'load', timeout: 20000 }).catch(noop);
	await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(noop);
	await sleep(1500);

	return { page, failed };
}
