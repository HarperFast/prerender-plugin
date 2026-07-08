import ManagedBrowser from './ManagedBrowser.js';
import { LaunchOptions, Page, ProtocolError, TimeoutError } from 'puppeteer';
import RenderJob from './RenderJob.js';
import logger from './util/Logger.js';
import { RenderQueueConsumer } from './RenderQueueConsumer.js';
import { setTimeout } from 'timers/promises';
import { noop } from './util/noop.js';
import { getResourceCache } from './ResourceCache.js';
import { settings } from './settings.js';
import { CpuSampler } from './util/cpu.js';

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

	// Per-worker CPU sampler (this Node process + its own Chrome tree, plus container-wide
	// context). Reads the live browser PID each sample since it changes on browser retirement.
	private cpuSampler = new CpuSampler(() => this.browser?.pid);

	rps = 10;

	inflight: Set<Promise<void>> = new Set();

	lastRenderStartTime = Date.now();

	// Per-interval counters, snapshotted-and-reset by logStats() so each log line is a delta
	// (what this worker did since the last line), not a monotonic total. `renderTimes` is bounded
	// by throughput over one interval and cleared each tick.
	private stats = RenderWorker.freshStats();

	private statsSince = Date.now();

	private static freshStats() {
		return {
			completed: 0,
			succeeded: 0,
			emptyContent: 0,
			failures: { timeout: 0, protocol: 0, tooManyRedirects: 0, getPageFailed: 0, other: 0 },
			expiredSkipped: 0,
			concurrencyBlocked: 0,
			rpsDelayed: 0,
			resultPostFailures: 0,
			fromSitemap: 0,
			browserLaunches: 0,
			browserRetirements: 0,
			renderTimes: [] as number[],
			// Per-phase wall-clock samples (ms), drained into percentiles by logStats. Attribute
			// the render time to network-wait (navTtfb/navTotal) vs in-browser work (settle/postProcess).
			navTtfb: [] as number[],
			navTotal: [] as number[],
			settle: [] as number[],
			postProcess: [] as number[],
		};
	}

	// Set on graceful shutdown: stops the consumer loop and blocks new renders while
	// in-flight ones drain.
	private shuttingDown = false;

	private consumerAbort = new AbortController();

	constructor(config: RenderWorkerConfig) {
		this.browserLaunchOptions = config.browserLaunchOptions;
		this.CONCURRENCY = config.maxConcurrency ?? 5;
		this.BROWSER_MAX_TOTAL_PAGES = config.browserExpirationThreshold ?? 5000;
		this.renderFn = config.renderer;

		this.browserCleanupInterval = setInterval(() => {
			this.closeRetiredBrowsers();
		}, 10000);
		this.browserCleanupInterval.unref();

		process.on('uncaughtException', async (err) => {
			logger.error({ err }, 'uncaught exception');
			// Await so browsers are actually closed before the event loop dies (otherwise Chrome
			// is orphaned). ManagedBrowser.close() has its own SIGKILL fallback if it hangs.
			await this.destroy().catch(() => {});
			process.exit(1);
		});

		this.logStatsInterval = setInterval(() => {
			this.logStats();
		}, 60000);

		if (config.rps) {
			this.rps = config.rps;
		}
		this.jobStartDelay = Math.floor(1000 / this.rps);
	}

	async run() {
		for await (const job of RenderQueueConsumer(this.consumerAbort.signal)) {
			if (this.shuttingDown) break;
			const ts = Date.now();
			// Do not run expired jobs to prevent double rendering
			if (job.expiresAt - ts < 30 * 1000) {
				this.stats.expiredSkipped++;
				console.log(`Skipping expired job ${job.id}`);
				continue;
			}

			// wait for slot to open up
			if (this.inflight.size >= this.CONCURRENCY) {
				this.stats.concurrencyBlocked++;
				await Promise.race(this.inflight);
			}

			// wait if need to delay
			const elapsed = ts - (this.lastRenderStartTime || Date.now());
			if (elapsed < this.jobStartDelay) {
				this.stats.rpsDelayed++;
				const delay = this.jobStartDelay - elapsed;
				await setTimeout(delay);
			}
			this.lastRenderStartTime = Date.now();
			if (job.isFromSitemap) this.stats.fromSitemap++;
			const p = this.render(job)
				// NB: pino logger methods rely on `this`; passing `logger.error` bare makes it throw
				// (`Cannot read properties of undefined (reading Symbol(pino.msgPrefix))`) when a render
				// rejects, turning a logged failure into an unhandledRejection that kills the worker.
				.catch((err) => logger.error({ err }, 'failed to render job'))
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

		// Snapshot-and-reset: everything below is a delta over the elapsed window, so a log line
		// answers "what did this worker do since the last line" rather than "lifetime totals".
		const s = this.stats;
		this.stats = RenderWorker.freshStats();
		const now = Date.now();
		const elapsedSec = Math.max(0.001, (now - this.statsSince) / 1000);
		this.statsSince = now;

		// mean/p50/p95/max for a sample set, or null when empty (same percentile index the
		// render-time summary has always used: round(p·(n-1)) into the sorted array).
		const summarize = (samples: number[]) => {
			const n = samples.length;
			if (!n) return null;
			const sorted = [...samples].sort((a, b) => a - b);
			const q = (p: number) => sorted[Math.round(p * (n - 1))];
			return {
				mean: Math.round(sorted.reduce((a, b) => a + b, 0) / n),
				p50: q(0.5),
				p95: q(0.95),
				max: sorted[n - 1],
			};
		};

		// Average concurrent renders over the window (Little's law: L = Σ latency / window). Used
		// with this worker's CPU to derive cores-per-render for concurrency tuning.
		const renderMsSum = s.renderTimes.reduce((a, b) => a + b, 0);
		const avgConcurrent = Number((renderMsSum / (elapsedSec * 1000)).toFixed(2));

		const cpu = this.cpuSampler.next();
		// What one in-flight render actually costs in CPU, so a better CONCURRENCY can be picked:
		// coresPerRender ≈ this worker's cores ÷ its concurrent renders; at container scale the
		// CPU-bound concurrency is limitCores ÷ coresPerRender. Null until both are measurable.
		const coresPerRender =
			cpu.workerCores !== null && avgConcurrent > 0 ? Number((cpu.workerCores / avgConcurrent).toFixed(3)) : null;

		const failuresTotal =
			s.failures.timeout +
			s.failures.protocol +
			s.failures.tooManyRedirects +
			s.failures.getPageFailed +
			s.failures.other;

		const mem = process.memoryUsage();

		logger.info({
			workerId: settings.harper.workerId || undefined,
			windowSec: Number(elapsedSec.toFixed(1)),
			throughput: {
				completed: s.completed,
				perSec: Number((s.completed / elapsedSec).toFixed(2)),
				succeeded: s.succeeded,
				emptyContent: s.emptyContent,
				fromSitemap: s.fromSitemap,
				failures: failuresTotal,
				failuresByType: s.failures,
				resultPostFailures: s.resultPostFailures,
			},
			renderMs: summarize(s.renderTimes),
			// Where the render time went: navTtfb/navTotal are origin/edge response time (network),
			// settle/postProcess are in-browser work (CPU). Isolates a slow upstream from render cost.
			phaseMs: {
				navTtfb: summarize(s.navTtfb),
				navTotal: summarize(s.navTotal),
				settle: summarize(s.settle),
				postProcess: summarize(s.postProcess),
			},
			// `worker`: THIS worker's own cores (Node + its Chrome tree). `container`: the whole
			// pod from the cgroup — identical across all workers in the container, NOT this worker's
			// share. coresPerRender + container.utilization drive CONCURRENCY tuning.
			cpu: {
				workerCores: cpu.workerCores,
				nodeCores: cpu.nodeCores,
				browserCores: cpu.browserCores,
				avgConcurrent,
				coresPerRender,
				container: cpu.container,
			},
			saturation: {
				inflight: this.inflight.size,
				concurrency: this.CONCURRENCY,
				concurrencyBlocked: s.concurrencyBlocked,
				rpsDelayed: s.rpsDelayed,
				expiredSkipped: s.expiredSkipped,
			},
			browsers: {
				current: this.browser
					? {
							totalOpenedPages: this.browser.totalOpenedPages,
							activePages: this.browser.activePages,
							freeSlots: this.browser.freeSlots,
							jobRefs: this.browser.jobRefs,
						}
					: null,
				retired: this.retiredBrowsers.size,
				launches: s.browserLaunches,
				retirements: s.browserRetirements,
			},
			rssMb: Math.round(mem.rss / 1024 / 1024),
			resourceCache: cacheStats,
		});
	}

	/**
	 * Graceful shutdown: stop claiming new jobs, let in-flight renders finish (so their
	 * results are posted back instead of silently dropped and re-queued), then tear down.
	 * Bounded by `deadlineMs` so a stuck render can't outlast the supervisor's SIGKILL grace.
	 */
	async shutdown(deadlineMs = 12000) {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		logger.info({ inflight: this.inflight.size }, 'worker shutting down — draining in-flight renders');
		this.consumerAbort.abort();

		// NB: `setTimeout` here is the promise-based timers/promises import (see top of file).
		// Use an AbortController to cancel the deadline timer once the drain wins, and swallow
		// the resulting abort rejection.
		const ac = new AbortController();
		const deadline = setTimeout(deadlineMs, undefined, { signal: ac.signal }).catch(() => {});
		await Promise.race([Promise.allSettled([...this.inflight]), deadline]);
		ac.abort();

		await this.destroy();
		logger.info('worker shutdown complete');
	}

	// Async so callers can AWAIT it before process.exit() — otherwise the event loop dies before
	// the browser .close() promises run and Chrome is orphaned (the whole point of closing here).
	async destroy() {
		clearInterval(this.logStatsInterval);
		if (this.browserCleanupInterval !== null) {
			clearInterval(this.browserCleanupInterval);
			this.browserCleanupInterval = null;
		}

		const closing: Promise<void>[] = [];
		if (this.browser) {
			closing.push(this.browser.close().catch(noop));
		}
		// A browser mid-launch isn't in `this.browser` yet; close it once it resolves so a
		// destroy() during launch (shutdown drain deadline, or an uncaught exception) doesn't
		// orphan the Chrome process.
		if (this.browserPromise) {
			closing.push(this.browserPromise.then((b) => b.close().catch(noop)).catch(noop));
		}
		this.retiredBrowsers.forEach((browser) => {
			closing.push(browser.close().catch(noop));
		});

		this.browser = null;
		this.retiredBrowsers.clear();

		await Promise.all(closing);
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
		this.stats.browserRetirements++;
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
			this.stats.failures.getPageFailed++;
			logger.error({ err: e }, 'failed to get page');
			error = e as Error;
		}

		if (page && !page.isClosed()) {
			try {
				content = await this.renderFn(page, job);
			} catch (e) {
				if (e instanceof TimeoutError) {
					this.retireBrowser(browser);
					this.stats.failures.timeout++;
				} else if (e instanceof ProtocolError) {
					this.retireBrowser(browser);
					this.stats.failures.protocol++;
				} else if (e instanceof Error && e.message.startsWith('net::ERR_TOO_MANY_REDIRECTS')) {
					job.isIndexable = false;
					this.stats.failures.tooManyRedirects++;
				} else {
					this.stats.failures.other++;
				}
				logger.error({ url: job.url, err: e }, 'failed to render page');
				error = e as Error;
			}
		}

		job.attemptEnded(error, content);
		browser.jobRefs--;

		// Per-interval outcome + latency accounting (drained by logStats).
		this.stats.completed++;
		const attempt = job.latestAttempt;
		if (attempt?.renderEndTime) {
			this.stats.renderTimes.push(attempt.renderEndTime - attempt.renderStartTime);
		}
		const t = attempt?.timings;
		if (t) {
			if (t.navTtfb !== undefined) this.stats.navTtfb.push(t.navTtfb);
			if (t.navTotal !== undefined) this.stats.navTotal.push(t.navTotal);
			if (t.settle !== undefined) this.stats.settle.push(t.settle);
			if (t.postProcess !== undefined) this.stats.postProcess.push(t.postProcess);
		}
		if (!error) {
			this.stats.succeeded++;
			if (!content) this.stats.emptyContent++;
		}

		// sendResult resolves true/false, but can still *reject* on an unexpected pre-POST failure
		// (e.g. encode() throwing before the retry loop). Catch it so it's counted as a post
		// failure rather than rejecting the whole render() through run()'s generic catch.
		const sendPromise = job.sendResult().catch((err) => {
			logger.error({ id: job.id, err }, 'failed to send job result');
			return false;
		});
		const closePromise = page ? browser.closePage(page) : Promise.resolve();
		const [posted] = await Promise.all([sendPromise, closePromise]);
		if (!posted) this.stats.resultPostFailures++;
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
			this.stats.browserLaunches++;
			logger.info({ event: 'launched browser', retired: this.retiredBrowsers.size });
		}

		if (this.browser.totalOpenedPages > this.BROWSER_MAX_TOTAL_PAGES) {
			this.retireBrowser(this.browser);
			return this.getBrowser();
		}

		return this.browser;
	}
}
