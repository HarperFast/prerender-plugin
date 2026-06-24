import ManagedBrowser from './ManagedBrowser.js';
import { LaunchOptions, Page, ProtocolError, TimeoutError } from 'puppeteer';
import RenderJob from './RenderJob.js';
import logger from './util/Logger.js';
import { RenderQueueConsumer } from './RenderQueueConsumer.js';
import { setTimeout } from 'timers/promises';
import { noop } from './util/noop.js';
import { getResourceCache } from './ResourceCache.js';

export type Renderer = (page: Page, job: RenderJob) => Promise<string | undefined>;

type RenderWorkerConfig = {
	/**
	 * The max number of concurrent page renders
	 */
	maxConcurrency?: number;
	/**
	 * The total number of pages that can be rendered by the browser before it is replaced
	 */
	browserExpirationThreshold?: number;

	/**
	 * The renderer function that will be used to render pages
	 */
	renderer: Renderer;

	rps?: number;

	browserLaunchOptions?: LaunchOptions;
};

export default class RenderWorker {
	CONCURRENCY: number;
	BROWSER_MAX_TOTAL_PAGES: number;

	jobStartDelay: number;

	renderFn: Renderer;

	browser: ManagedBrowser | null = null;

	browserPromise: Promise<ManagedBrowser> | null = null;

	retiredBrowsers: Set<ManagedBrowser> = new Set();

	browserLaunchOptions?: LaunchOptions;

	private browserCleanupInterval: NodeJS.Timeout | null = null;

	logStatsInterval: NodeJS.Timeout;

	rps = 10;

	inflight: Set<Promise<void>> = new Set();

	lastRenderStartTime = Date.now();

	constructor(config: RenderWorkerConfig) {
		this.browserLaunchOptions = config.browserLaunchOptions;
		this.CONCURRENCY = config.maxConcurrency ?? 5;
		this.BROWSER_MAX_TOTAL_PAGES = config.browserExpirationThreshold ?? 5000;
		this.renderFn = config.renderer;

		this.browserCleanupInterval = setInterval(() => {
			this.closeRetiredBrowsers();
		}, 10000);
		this.browserCleanupInterval.unref();

		process.on('uncaughtException', (err) => {
			logger.error({ err }, 'uncaught exception');
			this.destroy();
			process.exit(1);
		});

		this.logStatsInterval = setInterval(() => {
			this.logStats();
		}, 45000);

		if (config.rps) {
			this.rps = config.rps;
		}
		this.jobStartDelay = Math.floor(1000 / this.rps);
	}

	async run() {
		for await (const job of RenderQueueConsumer()) {
			const ts = Date.now();
			// Do not run expired jobs to prevent double rendering
			if (job.expiresAt - ts < 30 * 1000) {
				console.log(`Skipping expired job ${job.id}`);
				continue;
			}

			// wait for slot to open up
			if (this.inflight.size >= this.CONCURRENCY) {
				await Promise.race(this.inflight);
			}

			// wait if need to delay
			const elapsed = ts - (this.lastRenderStartTime || Date.now());
			if (elapsed < this.jobStartDelay) {
				const delay = this.jobStartDelay - elapsed;
				await setTimeout(delay);
			}
			this.lastRenderStartTime = Date.now();
			const p = this.render(job)
				.catch(logger.error)
				.finally(() => {
					this.inflight.delete(p);
				});
			this.inflight.add(p);
		}
	}

	logStats() {
		const cache = getResourceCache();
		const cacheStats = cache
			? (() => {
					const { hits, misses, stores, evictions, indexedOnInit, droppedOnInit } = cache;
					const lookups = hits + misses;
					const hitRate = lookups > 0 ? hits / lookups : 0;
					return {
						ready: cache.isReady(),
						hits,
						misses,
						stores,
						evictions,
						hitRate: Number(hitRate.toFixed(3)),
						indexedOnInit,
						droppedOnInit,
					};
				})()
			: null;

		logger.info({
			retiredBrowsers: this.retiredBrowsers.size,
			currentBrowser: this.browser
				? {
						totalOpenedPages: this.browser.totalOpenedPages,
						activePages: this.browser.activePages,
						freeSlots: this.browser.freeSlots,
						jobRefs: this.browser.jobRefs,
					}
				: null,
			resourceCache: cacheStats,
		});
	}

	destroy() {
		if (this.browserCleanupInterval !== null) {
			clearInterval(this.browserCleanupInterval);
			this.browserCleanupInterval = null;
		}

		// close all browsers
		if (this.browser) {
			this.browser.close().catch(noop);
		}
		this.retiredBrowsers.forEach((browser) => {
			browser.close().catch(noop);
		});
		this.browser = null;
		this.retiredBrowsers.clear();
	}

	closeRetiredBrowsers() {
		for (const browser of this.retiredBrowsers) {
			if (browser.activePages === 0 || browser.jobRefs === 0) {
				browser.close().then(() => {
					this.retiredBrowsers.delete(browser);
				});
			}
		}
	}

	retireBrowser(browser: ManagedBrowser) {
		if (this.retiredBrowsers.has(browser)) {
			return;
		}
		this.retiredBrowsers.add(browser);
		this.browser = null;
	}

	async render(job: RenderJob) {
		const browser = await this.getBrowser();

		browser.jobRefs++;
		job.attemptStarted();

		let page: Page | undefined;

		let error: Error | undefined;
		let content: string | undefined;

		try {
			page = await browser.getPage();
		} catch (e) {
			this.retireBrowser(browser);
			logger.error({ err: e }, 'failed to get page');
			error = e as Error;
		}

		if (page && !page.isClosed()) {
			try {
				content = await this.renderFn(page, job);
			} catch (e) {
				if (e instanceof TimeoutError || e instanceof ProtocolError) {
					this.retireBrowser(browser);
				} else if (e instanceof Error && e.message.startsWith('net::ERR_TOO_MANY_REDIRECTS')) {
					job.isIndexable = false;
				}
				logger.error({ url: job.url, err: e }, 'failed to render page');
				error = e as Error;
			}
		}

		job.attemptEnded(error, content);
		browser.jobRefs--;

		const promises = [job.sendResult()];

		if (page) {
			promises.push(browser.closePage(page));
		}

		await Promise.all(promises);
	}

	async getBrowser(): Promise<ManagedBrowser> {
		if (this.browser === null) {
			if (this.browserPromise) {
				return await this.browserPromise;
			}
			logger.info({ event: 'launching browser', retired: this.retiredBrowsers.size });
			this.browserPromise = ManagedBrowser.launch({
				maxActivePages: this.CONCURRENCY,
				puppeteerLaunchOptions: this.browserLaunchOptions,
			}).finally(() => (this.browserPromise = null));
			this.browser = await this.browserPromise;
			logger.info({ event: 'launched browser', retired: this.retiredBrowsers.size });
		}

		if (this.browser.totalOpenedPages > this.BROWSER_MAX_TOTAL_PAGES) {
			this.retireBrowser(this.browser);
			return this.getBrowser();
		}

		return this.browser;
	}
}
