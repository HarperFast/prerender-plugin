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
import { renderPhaseOf } from './util/renderPhase.js';
import { JobDocumentCache } from './documentReuse.js';
import { closePrefetchAgent, prefetchDocument, type PrefetchOutcome } from './documentPrefetch.js';
import { BoundedAsyncQueue } from './util/asyncQueue.js';

export type Renderer = (page: Page, job: RenderJob) => Promise<string | undefined>;

// How long a retired browser may sit un-reaped before it's closed regardless of its ref counts.
// Comfortably longer than a render + its result POST, so it only ever fires on stuck bookkeeping.
const RETIRED_BROWSER_MAX_MS = 120000;

// A render is not started with less lease than this left: by the time it posted, the plugin may
// have re-granted the job, and the second render would be wasted. Applied to a job as claimed and,
// on a multi-device job, before EACH further variant — so a job that ran long posts what it has
// rather than a result nobody will accept. The plugin floors `queue.jobLeaseTime` at 2 minutes for
// exactly this number; lowering it here without raising that floor live-locks the queue.
const LEASE_MIN_REMAINING_MS = 30 * 1000;

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

	/** Retired browsers awaiting reaping, each mapped to when it was retired (see closeRetiredBrowsers). */
	retiredBrowsers: Map<ManagedBrowser, number> = new Map();

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
			// Renders that ended as a redirect (bailed after navigation, or landed elsewhere by a
			// client-side redirect). Split out of emptyContent so a site restructure's 301 wave
			// doesn't read as a content regression.
			redirected: 0,
			failures: {
				timeout: 0,
				// Navigation never reached `waitUntil` (slow origin / starved renderer) — distinct
				// from `timeout`, which is a settle-phase or protocol-level timeout.
				navTimeout: 0,
				protocol: 0,
				tooManyRedirects: 0,
				getPageFailed: 0,
				// Renders killed by our own teardown (drain deadline / browser gone during
				// shutdown). Not a render regression — kept out of the other buckets so a
				// rollout doesn't read as a failure spike.
				shutdownAborted: 0,
				other: 0,
			},
			expiredSkipped: 0,
			// Results posted — one per claimed JOB, whereas `completed` counts renders. With plugin >=
			// 0.66.0 a job renders every device of one URL, so `completed / jobs` is the variants per job.
			jobs: 0,
			// Variants a multi-device job asked for and this worker did NOT attempt: the lease ran short
			// or the worker began draining between variants. The plugin retries the URL for them.
			variantsSkipped: 0,
			// Document reuse (config.documentReuse): variants whose navigation was answered from a
			// sibling's captured document, sample jobs that fetched and compared instead, and those
			// samples' structural divergence ratios (0 = same markup; see documentReuse.ts).
			documentsReused: 0,
			documentSamples: 0,
			documentDivergence: [] as number[],
			// Document prefetch (config.documentReuse.prefetch): variants whose navigation was answered
			// from a document this process fetched ahead of the render, and prefetches that yielded no
			// document, by why (the variant then fetched normally — `status` is the origin's non-200,
			// normal for a share of jobs; `timeout`/`error` are worth a look).
			//
			// NOT DISJOINT FROM `documentsReused`: a sibling replaying a prefetched document is both
			// prefetched and reused, so on a two-device job with both features on the two counters sum
			// to more than the variants. Read `documentsPrefetched` as "navigations the origin never
			// saw because this process had already fetched it", `documentsReused` as "navigations
			// answered from ANOTHER device's document"; the overlap is the interesting case, not an
			// error. `prefetchLate` counts jobs whose prefetch had not landed within the navigation's
			// grace, so the render fetched for itself — a rising count means `depth` is too shallow.
			documentsPrefetched: 0,
			prefetchLate: 0,
			// Sample jobs where two devices' own documents set DIFFERENT values for a pinned cookie — the
			// pin's own assumption failing. Any non-zero count means a name in `cookies.pin` is
			// device-specific and must come out of the list.
			pinnedCookieConflicts: 0,
			// Replays the browser REFUSED (an unfulfillable payload). Those variants fetched their own
			// document, so nothing was lost but the saving; a steady count means reuse is buying nothing
			// on this site and the log line says why.
			documentReplayFailures: 0,
			prefetchFallthrough: {
				'status': 0,
				'not-html': 0,
				'too-large': 0,
				'timeout': 0,
				'aborted': 0,
				'error': 0,
			} as Record<Exclude<PrefetchOutcome, 'fetched'>, number>,
			// Claimed jobs this worker dropped at shutdown without attempting a render — pooled for
			// prefetch, or waiting for a slot when the drain began. Their leases expire and the queue
			// re-grants them; a handful per rollout is the expected shape.
			jobsAbandoned: 0,
			// How long a navigation waited for its prefetch to finish, ms — 0 when the document was already
			// in hand. A p95 well above 0 says `prefetch.depth` is too shallow for this concurrency.
			prefetchWaitMs: [] as number[],
			// Wall time of the prefetches that produced a document — the origin time the render no
			// longer spends.
			prefetchFetchMs: [] as number[],
			concurrencyBlocked: 0,
			rpsDelayed: 0,
			resultPostFailures: 0,
			fromSitemap: 0,
			browserLaunches: 0,
			browserRetirements: 0,
			// Renders that succeeded but loaded against a crippled asset set — see
			// RenderAttempt.subresourceErrors. `rendersDegraded` is the render count (how much of the
			// cache is affected); `subresourceErrors` is the total refused assets (how badly).
			rendersDegraded: 0,
			subresourceErrors: 0,
			renderTimes: [] as number[],
			// Per-phase wall-clock samples (ms), drained into percentiles by logStats. Attribute
			// the render time to network-wait (navTtfb/navTotal) vs in-browser work (settle/postProcess).
			navTtfb: [] as number[],
			navTotal: [] as number[],
			settle: [] as number[],
			postProcess: [] as number[],
		};
	}

	// Multi-device jobs seen while document reuse is on — the counter `documentReuse.sampleEvery`
	// selects sample jobs from. Per worker, which is what makes "every Nth job" mean what it says on
	// a worker that renders a few thousand jobs a day.
	private documentJobs = 0;

	// Chrome's own user agent, learned from the first launched browser: what a device profile without
	// a `userAgent` sends, and therefore what its prefetch must send too.
	private browserUserAgent: string | undefined;

	// The prefetch pool, while the pipelined loop is running — held so a render that found its
	// document not ready can deepen it.
	private pool: BoundedAsyncQueue<RenderJob> | null = null;

	/**
	 * Deepen the prefetch pool by one, up to `maxDepth`.
	 *
	 * The point of prefetching is that the next render finds its document already fetched, so a render
	 * that had to wait and then go to the origin is the pool saying it is too shallow for this
	 * concurrency and this origin — which is not something configuration can know in advance, since it
	 * depends on the ratio between a fetch and a render and both move. Growing on the evidence
	 * converges on "enough" and then stops; it never shrinks, because the cost of being one deeper is a
	 * lease and a document, and the cost of being one too shallow is a render that pays for its own
	 * fetch.
	 */
	private deepenPool(): void {
		const { maxDepth } = settings.config.documentReuse.prefetch;
		if (!this.pool || this.pool.capacity >= maxDepth) return;
		this.pool.grow();
		logger.info(
			{ depth: this.pool.capacity, maxDepth },
			'a render waited on its prefetch and went to the origin — deepening the prefetch pool'
		);
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

	/**
	 * The claim → render loop, over the queue consumer by default (tests pass their own iterable).
	 *
	 * Without prefetch, a claimed job goes straight to a render slot: admitted, held for a free slot and
	 * the `rps` pacing, started. With `documentReuse.prefetch` on, the loop is PIPELINED: a small
	 * bounded pool (`prefetch.depth`) of claimed jobs sits between the consumer and the slots, and a
	 * job's document fetch starts the moment it enters the pool — while earlier jobs are still
	 * rendering — so that by the time a slot frees, the next job's document is usually in hand and its
	 * render starts without waiting on the origin (documentPrefetch.ts).
	 *
	 * Two loops share the pool: the filler pulls from the consumer and waits while the pool is full,
	 * so the worker never runs ahead of its slots by more than `depth` claims; the render loop waits
	 * for a free slot and THEN takes the oldest pooled job — slot first, so exactly `depth` jobs
	 * prefetch ahead and the lease is re-checked right before the render, not before a wait — and a
	 * pooled job never waits for a SUCCESSOR to arrive, so a trickle of jobs from a near-empty queue
	 * renders as promptly as it did before. `rps` still paces render starts; at steady state a
	 * prefetch starts each time a render does, so the origin sees the same request rate, one render
	 * earlier.
	 *
	 * At shutdown the consumer ends, the filler closes the pool, and whatever is still pooled is
	 * dropped: no variant of it was attempted, so there is nothing to post, and its lease expires and
	 * the queue re-grants it — the same fate a job sitting unclaimed in the consumer's batch always had.
	 */
	async run(jobs: AsyncIterable<RenderJob> = RenderQueueConsumer(this.consumerAbort.signal)) {
		const prefetch = settings.config.documentReuse.prefetch;
		if (!prefetch.enabled) {
			for await (const job of jobs) {
				if (this.shuttingDown) break;
				if (!this.admit(job)) continue;
				const takenAt = Date.now();
				await this.awaitSlot();
				await this.start(job, takenAt);
			}
			return;
		}

		// A device profile without a `userAgent` sends Chrome's own, so the prefetch needs it before the
		// first fetch. Launching the browser here costs nothing: the first render needs it moments later.
		await this.getBrowser().then(
			(browser) => this.rememberUserAgent(browser),
			(err) =>
				logger.warn({ err }, 'browser launch ahead of the first prefetch failed — prefetching without its user agent')
		);

		const pool = new BoundedAsyncQueue<RenderJob>(prefetch.depth);
		this.pool = pool;
		const filling = (async () => {
			// Iterated by hand rather than `for await`, so the next claim is pulled only once the pool
			// has room for it: exactly `depth` jobs prefetch ahead, and a job's prefetch is under way
			// before the render loop can take it.
			const iterator = jobs[Symbol.asyncIterator]();
			try {
				while (!this.shuttingDown) {
					await pool.waitForRoom();
					if (pool.isClosed) break;
					const next = await iterator.next();
					if (next.done) break;
					const job = next.value;
					if (this.shuttingDown) {
						this.abandon(job);
						break;
					}
					if (!this.admit(job)) continue;
					this.startPrefetch(job);
					if (!(await pool.put(job))) this.abandon(job);
				}
			} finally {
				pool.close();
				// Let a generator source run its own cleanup (the queue consumer closes its MQTT client).
				await Promise.resolve(iterator.return?.()).catch(noop);
			}
		})();
		// Handled at creation as well as at the `await` below: the render loop can sit inside a
		// 12-second render before it reaches that await, and an unhandled rejection for that long
		// trips the process-level handler, which exits — killing every in-flight render with it.
		filling.catch(noop);

		for (;;) {
			const takenAt = Date.now();
			await this.awaitSlot();
			const job = await pool.take();
			if (!job) break;
			if (this.shuttingDown) {
				this.abandon(job);
				continue;
			}
			if (!this.admit(job)) {
				job.documentCache?.abortPrefetch();
				continue;
			}
			await this.start(job, takenAt);
		}
		await filling;
	}

	/** Hold until a render slot is free. */
	private async awaitSlot() {
		// wait for slot to open up
		if (this.inflight.size >= this.CONCURRENCY) {
			this.stats.concurrencyBlocked++;
			await Promise.race(this.inflight);
		}
	}

	/** Whether a claimed job still has enough lease to be worth rendering; counted and logged when not. */
	private admit(job: RenderJob): boolean {
		// Do not run expired jobs to prevent double rendering
		if (job.expiresAt - Date.now() < LEASE_MIN_REMAINING_MS) {
			this.stats.expiredSkipped++;
			console.log(`Skipping expired job ${job.id}`);
			return false;
		}
		return true;
	}

	/** With a slot free (`awaitSlot`), hold for the `rps` pacing and start the render (not awaited). */
	private async start(job: RenderJob, takenAt: number) {
		// Shutdown began while this job waited for its slot: the drain has run and the browser is gone,
		// so a render now would launch a fresh Chrome into a process that is exiting. Drop the job
		// instead — its lease expires and the queue re-grants it.
		if (this.shuttingDown) {
			this.abandon(job);
			return;
		}

		// wait if need to delay
		//
		// Measured from `takenAt` — when this job was taken, BEFORE it waited for a slot — because
		// that is what the loop this replaced measured, and `rps` is an origin-protection lever: a
		// number that quietly stops inserting the delay it always inserted is not a refactor. (The
		// reading is admittedly odd under saturation, where the slot wait alone exceeds the window
		// and no delay is ever due. That is a separate question from this change, and one to settle
		// against the origin rather than in passing.)
		const elapsed = takenAt - (this.lastRenderStartTime || Date.now());
		if (elapsed < this.jobStartDelay) {
			this.stats.rpsDelayed++;
			const delay = this.jobStartDelay - elapsed;
			await setTimeout(delay);
		}
		// One more check: the pacing delay is another window for the drain to begin, and a render
		// started after `destroy()` has run launches a fresh Chrome into an exiting process — and
		// does it INVISIBLY, since `shutdown()` snapshotted `inflight` before this was added to it.
		if (this.shuttingDown) {
			this.abandon(job);
			return;
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

	/**
	 * The job's document state, created on first ask: for every job when prefetch is on, else for a
	 * multi-device job when reuse is. Sample selection (`sampleEvery`) counts multi-device jobs under
	 * reuse, as it always has; a job that arrives through the pool and one rendered directly get the
	 * same object either way.
	 */
	private documentCacheFor(job: RenderJob): JobDocumentCache | null {
		if (job.documentCache) return job.documentCache;
		const reuse = settings.config.documentReuse;
		const multiDevice = (job.deviceTypes?.length ?? 1) > 1;
		const acrossDevices = reuse.enabled && multiDevice;
		if (!acrossDevices && !reuse.prefetch.enabled) return null;
		// SAMPLE SELECTION SPANS BOTH FEATURES. It used to be computed only for multi-device jobs
		// under reuse, which left the configuration this ships in first — prefetch on, reuse off —
		// with no running check of any kind, precisely where the new and unproven claim lives: that
		// a document this process fetched with undici is the one Chrome would have been served.
		// Every job that holds a document cache is now a sampling candidate.
		this.documentJobs++;
		const sample = reuse.sampleEvery > 0 && this.documentJobs % reuse.sampleEvery === 0;
		job.documentCache = new JobDocumentCache({ sample, acrossDevices, pin: reuse.cookies.pin });
		return job.documentCache;
	}

	/**
	 * Start fetching the job's document for its first device, ahead of its render. The result lands on
	 * the job's document cache; a prefetch that yields nothing is counted by outcome and the variant
	 * fetches for itself. Never throws, never fails the job.
	 */
	private startPrefetch(job: RenderJob) {
		const cache = this.documentCacheFor(job);
		if (!cache || cache.prefetch) return;
		const { timeoutMs } = settings.config.documentReuse.prefetch;
		const ac = new AbortController();
		cache.prefetchAbort = ac;
		cache.prefetch = prefetchDocument(job, job.deviceTypes?.[0] ?? job.deviceType, {
			timeoutMs,
			signal: ac.signal,
			defaultUserAgent: this.browserUserAgent,
		})
			.then((result) => {
				if (result.doc) {
					this.stats.prefetchFetchMs.push(result.ms);
					if (!cache.entry) cache.entry = result.doc;
					return result.doc;
				}
				this.stats.prefetchFallthrough[result.outcome as Exclude<PrefetchOutcome, 'fetched'>]++;
				if (result.outcome === 'timeout' || result.outcome === 'error') {
					logger.warn(
						{ id: job.id, outcome: result.outcome, ms: result.ms, err: result.error },
						'document prefetch yielded nothing — the render fetches the document itself'
					);
				} else if (result.outcome !== 'aborted') {
					logger.debug({ id: job.id, outcome: result.outcome, status: result.status }, 'document prefetch not held');
				}
				return null;
			})
			.catch((err) => {
				this.stats.prefetchFallthrough.error++;
				logger.warn({ id: job.id, err }, 'document prefetch failed — the render fetches the document itself');
				return null;
			});
	}

	/** A claimed job this worker will not render (shutdown): cancel any prefetch and let its lease expire. */
	private abandon(job: RenderJob) {
		job.documentCache?.abortPrefetch();
		this.stats.jobsAbandoned++;
		logger.info({ id: job.id }, 'claimed job dropped at shutdown — its lease expires and the queue re-grants it');
	}

	private async rememberUserAgent(browser: ManagedBrowser) {
		if (this.browserUserAgent) return;
		try {
			this.browserUserAgent = await browser.browser?.userAgent();
		} catch {
			// A browser that cannot say (or a stub in tests): profiles without a userAgent prefetch without one.
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
				jobs: s.jobs,
				variantsSkipped: s.variantsSkipped,
				documentsReused: s.documentsReused,
				documentSamples: s.documentSamples,
				// max/mean of the sampled divergence ratios this window (0 = same markup); null when
				// nothing was sampled.
				documentDivergence: summarize(s.documentDivergence),
				documentsPrefetched: s.documentsPrefetched,
				prefetchLate: s.prefetchLate,
				pinnedCookieConflicts: s.pinnedCookieConflicts,
				documentReplayFailures: s.documentReplayFailures,
				prefetchFallthrough: s.prefetchFallthrough,
				jobsAbandoned: s.jobsAbandoned,
				succeeded: s.succeeded,
				emptyContent: s.emptyContent,
				redirected: s.redirected,
				// Non-zero means pages are being cached with content missing even though every
				// render "succeeded" — treat it like a failure count, not a curiosity.
				rendersDegraded: s.rendersDegraded,
				subresourceErrors: s.subresourceErrors,
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
				// Prefetch: `prefetchFetch` is the origin time taken off the render's path; `prefetchWait`
				// is how much of it the navigation still waited for (0 = fully hidden — the depth signal).
				prefetchFetch: summarize(s.prefetchFetchMs),
				prefetchWait: summarize(s.prefetchWaitMs),
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
		const DRAINED = Symbol('drained');
		const outcome = await Promise.race([Promise.allSettled([...this.inflight]).then(() => DRAINED), deadline]);
		ac.abort();

		// Whether in-flight renders finished (their results are posted) or were abandoned to the
		// deadline (re-rendered later by whoever re-claims the jobs) — the difference matters when
		// reading a rollout's logs, so say which happened.
		const drained = outcome === DRAINED;
		if (!drained) {
			logger.warn({ deadlineMs, inflight: this.inflight.size }, 'shutdown drain deadline expired — abandoning renders');
		}

		await this.destroy();
		logger.info({ drained }, 'worker shutdown complete');
	}

	/**
	 * Best-effort SYNCHRONOUS teardown of every Chrome process, for the forced-exit paths where
	 * there's no time to await `destroy()` (a second termination signal, or the shutdown deadline
	 * backstop). Puppeteer's own signal handlers are disabled when we own the drain, so without
	 * this a forced exit would orphan Chrome. A browser still mid-launch has no PID yet and can't
	 * be reached from here — the same gap those forced paths already accept.
	 */
	killBrowsersSync() {
		const browsers = [...this.retiredBrowsers.keys(), ...(this.browser ? [this.browser] : [])];
		for (const browser of browsers) {
			browser.killSync();
		}
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
		for (const browser of this.retiredBrowsers.keys()) {
			closing.push(browser.close().catch(noop));
		}

		this.browser = null;
		this.retiredBrowsers.clear();

		// The prefetch agent holds keep-alive sockets to the origin, and it is the one resource this
		// teardown did not know about — harmless while the process exits anyway, but a `destroy()`
		// that leaves the event loop open is a surprise waiting for the first caller who uses this
		// class without exiting straight afterwards.
		closing.push(closePrefetchAgent());

		await Promise.all(closing);
	}

	/**
	 * Reap retired browsers once they're genuinely idle — BOTH counters at zero. Either-or (the
	 * previous condition) closed a browser out from under open pages: a render drops its job ref
	 * before its result POST completes, so `jobRefs === 0` while pages are still open is normal,
	 * and closing there killed those pages mid-flight — which surfaced as "Failed to close
	 * context" from their close handlers.
	 *
	 * The backstop is a deadline, not a looser condition: if a counter is somehow stuck (a page
	 * whose 'close' never fires), force the close after RETIRED_BROWSER_MAX_MS rather than leak a
	 * Chrome process forever — and say so, because a stuck counter is a bug worth seeing.
	 */
	closeRetiredBrowsers() {
		for (const [browser, retiredAt] of this.retiredBrowsers) {
			if (browser.closing) continue; // already being reaped by an earlier tick
			const idle = browser.activePages === 0 && browser.jobRefs === 0;
			const expired = Date.now() - retiredAt >= RETIRED_BROWSER_MAX_MS;
			if (!idle && !expired) continue;
			if (!idle) {
				logger.warn(
					{ activePages: browser.activePages, jobRefs: browser.jobRefs, retiredMs: Date.now() - retiredAt },
					'retired browser never went idle — closing anyway'
				);
			}
			browser.close().then(() => {
				this.retiredBrowsers.delete(browser);
			});
		}
	}

	retireBrowser(browser: ManagedBrowser) {
		if (this.retiredBrowsers.has(browser)) {
			return;
		}
		this.retiredBrowsers.set(browser, Date.now());
		this.stats.browserRetirements++;
		this.browser = null;
	}

	/**
	 * One claimed job, start to posted result.
	 *
	 * A job is one URL. With plugin >= 0.66.0 it names every device to render (`deviceTypes`), and
	 * they are rendered HERE, in turn, on this job's one concurrency slot — so `CONCURRENCY` still
	 * bounds pages in flight, and a job simply occupies its slot for as many renders as it has
	 * devices. Every device's snapshot then travels back in ONE result, which is what lets the plugin
	 * keep a URL's variants aligned: same render pass, seconds apart, one scheduling decision. A
	 * legacy per-device job (older plugin) is the single-variant case of the same loop and posts the
	 * shape that plugin understands.
	 *
	 * The variants run sequentially rather than in parallel on purpose. Parallel variants would need
	 * page-level accounting against `CONCURRENCY` and would double this job's burst on the origin;
	 * sequential keeps every existing capacity number true (renders/hour/slot is unchanged) at the cost
	 * of a longer per-job wall time, which the lease absorbs (`queue.jobLeaseTime` is minutes, a
	 * variant is seconds).
	 *
	 * A variant is skipped — and the result posted PARTIAL — when the lease has under
	 * `LEASE_MIN_REMAINING_MS` left or the worker started draining. A partial result is still worth
	 * posting: the plugin stores the variants that rendered and retries the URL for the rest, and a
	 * result that never arrives costs the whole lease before anything retries.
	 */
	async render(job: RenderJob) {
		const variants = job.variants();
		const attempted: RenderJob[] = [];

		// One shared document per job: prefetched ahead of this render (already on the job when it came
		// through the pool), or captured by the first variant when the operator has said the site is
		// responsive. The rest replay it — except on a sample job, which fetches and compares so the
		// claim keeps being tested. See documentReuse.ts.
		const documentCache = this.documentCacheFor(job);
		if (documentCache) for (const variant of variants) variant.documentCache = documentCache;

		for (const variant of variants) {
			if (attempted.length > 0) {
				const leaseLeft = job.expiresAt - Date.now();
				if (leaseLeft < LEASE_MIN_REMAINING_MS || this.shuttingDown) {
					const skipped = variants.length - attempted.length;
					this.stats.variantsSkipped += skipped;
					logger.warn(
						{ id: job.id, skipped, leaseLeftMs: leaseLeft, shuttingDown: this.shuttingDown },
						'posting a partial result — remaining device variants not attempted'
					);
					break;
				}
			}
			// A THROW HERE MUST NOT COST THE VARIANTS ALREADY RENDERED. `renderVariant` swallows
			// render failures itself, but it starts with `getBrowser()` — outside that handling — so a
			// failed relaunch between variants (the browser the previous variant retired on a timeout
			// or protocol error) rejected out of this loop, discarded every completed render, and
			// posted nothing at all, leaving the row pinning the claim floor. Ending the loop and
			// posting what is in hand is the same trade the lease and drain checks above already make.
			try {
				await this.renderVariant(variant);
				attempted.push(variant);
			} catch (e) {
				this.stats.failures.getPageFailed++;
				const skipped = variants.length - attempted.length;
				this.stats.variantsSkipped += skipped;
				logger.error(
					{ id: job.id, deviceType: variant.deviceType, skipped, err: e },
					'variant could not be started — posting what has rendered and leaving the rest to the plugin'
				);
				if (attempted.length === 0) throw e;
				break;
			}
		}

		// sendResult resolves true/false, but can still *reject* on an unexpected pre-POST failure
		// (e.g. encode() throwing before the retry loop). Catch it so it's counted as a post
		// failure rather than rejecting the whole render() through run()'s generic catch. Started
		// inside the chain so a synchronous throw lands in the same catch rather than escaping it.
		// (`attempted` is never empty: the skip check above only runs once one variant is done, and
		// `variants()` always yields at least one.)
		//
		// The legacy shape for a legacy job, always: an older plugin reads `id` as a cache key and has
		// no notion of `variants`, so it must get exactly what it always got.
		const posted = await Promise.resolve()
			.then(() => (job.deviceTypes ? RenderJob.sendVariantsResult(job, attempted) : attempted[0].sendResult()))
			.catch((err) => {
				logger.error({ id: job.id, err }, 'failed to send job result');
				return false;
			});
		this.stats.jobs++;
		if (!posted) this.stats.resultPostFailures++;

		if (documentCache) {
			this.stats.documentsReused += documentCache.reusedBy.length;
			this.stats.documentsPrefetched += documentCache.prefetchedBy.length;
			if (documentCache.prefetchWaitMs !== null) this.stats.prefetchWaitMs.push(documentCache.prefetchWaitMs);
			if (documentCache.prefetchLate) {
				this.stats.prefetchLate++;
				this.deepenPool();
			}
			// PINNING ASSUMES THE COOKIE IS NOT DEVICE-SPECIFIC, and this is where that assumption is
			// tested rather than trusted. On a sample job each device fetched its own document, so two
			// different values for the same pinned name means the cookie encodes the device — and
			// crossing it puts a sibling into the wrong experience, which is worse than not pinning.
			if (documentCache.replayFailures.length) {
				this.stats.documentReplayFailures += documentCache.replayFailures.length;
				// Survivable — each of those variants went to the origin itself — but never silent: it
				// means reuse is saving nothing on this site, and the browser's own message is the only
				// thing that says why (an unfulfillable header, a payload it would not take).
				logger.warn(
					{ id: job.id, failures: documentCache.replayFailures },
					'the browser refused a document replay; those variants fetched their own document'
				);
			}
			const conflict = documentCache.pinnedCookieConflict();
			if (conflict.length) {
				this.stats.pinnedCookieConflicts++;
				logger.warn(
					{ id: job.id, devices: conflict, pinned: [...documentCache.pinnedCookiesByDevice] },
					'pinned cookies differ between devices — they are device-specific, so pinning them is unsafe; ' +
						'remove them from documentReuse.cookies.pin'
				);
			}
			if (documentCache.divergence) {
				const { ratio, differing, chunks, samples } = documentCache.divergence;
				this.stats.documentSamples++;
				this.stats.documentDivergence.push(ratio);
				// Structural divergence between the first variant's document and a real second fetch. A
				// non-zero ratio on a quiet day is the site turning adaptive (or personalising the
				// document); on a deploy day it is build churn the normaliser did not cover — read the
				// samples before drawing either conclusion.
				logger[ratio > 0 ? 'warn' : 'info'](
					{ id: job.id, ratio: Number(ratio.toFixed(4)), differing, chunks, samples },
					'document reuse sample: structural divergence between device documents'
				);
			}
		}
	}

	/** Render ONE device variant on a page of its own; the result is posted by the caller. */
	private async renderVariant(job: RenderJob) {
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
				if (this.shuttingDown) {
					// We tore the browser down under this render (drain deadline, or a browser that
					// went away mid-drain): "detached Frame" / "Target closed" / a failed context
					// dispose. Our own doing, so it's a warning, not a render failure — and no point
					// retiring a browser that's already being closed.
					this.stats.failures.shutdownAborted++;
					logger.warn({ url: job.url, phase: renderPhaseOf(e), err: e }, 'render aborted by worker shutdown');
				} else if (e instanceof TimeoutError) {
					this.retireBrowser(browser);
					if (renderPhaseOf(e) === 'navigation') {
						this.stats.failures.navTimeout++;
					} else {
						this.stats.failures.timeout++;
					}
				} else if (e instanceof ProtocolError) {
					this.retireBrowser(browser);
					this.stats.failures.protocol++;
				} else if (e instanceof Error && e.message.startsWith('net::ERR_TOO_MANY_REDIRECTS')) {
					job.isIndexable = false;
					job.reason = 'redirect-loop';
					this.stats.failures.tooManyRedirects++;
				} else {
					this.stats.failures.other++;
				}
				if (!this.shuttingDown) {
					logger.error({ url: job.url, phase: renderPhaseOf(e), err: e }, 'failed to render page');
				}
				error = e as Error;
			}
		}

		job.attemptEnded(error, content);

		// Per-interval outcome + latency accounting (drained by logStats).
		this.stats.completed++;
		const attempt = job.latestAttempt;
		if (attempt?.renderEndTime) {
			this.stats.renderTimes.push(attempt.renderEndTime - attempt.renderStartTime);
		}
		if (attempt?.subresourceErrors) {
			this.stats.rendersDegraded++;
			this.stats.subresourceErrors += attempt.subresourceErrors;
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
			if (!content) {
				if (job.redirectedTo) this.stats.redirected++;
				else this.stats.emptyContent++;
			}
		}

		try {
			if (page) await browser.closePage(page);
		} finally {
			// Released only now — not when the render finished. A retired browser is reaped once its
			// refs hit zero, so dropping the ref before the page is closed let the reaper close the
			// browser under an open page.
			browser.jobRefs--;
		}
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
			this.rememberUserAgent(this.browser).catch(noop);
		}

		if (this.browser.totalOpenedPages > this.BROWSER_MAX_TOTAL_PAGES) {
			this.retireBrowser(this.browser);
			return this.getBrowser();
		}

		return this.browser;
	}
}
