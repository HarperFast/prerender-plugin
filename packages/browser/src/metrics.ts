/**
 * Opt-in OpenTelemetry metrics for the render worker.
 *
 * OpenTelemetry is imported LAZILY inside `createMetrics` (dynamic `import()`), so a worker
 * with metrics disabled never loads the SDK and pays zero cost. The worker folds ONE per-window
 * snapshot (the same deltas `logStats` already computes) into the instruments via `record()`;
 * a `PeriodicExportingMetricReader` then pushes them over OTLP/HTTP on its own timer. A slow or
 * unreachable collector is handled entirely inside the SDK's export loop — it never blocks,
 * delays, throws into `record()`, or otherwise touches the render path.
 *
 * `record()` is the single integration point; see `RenderWorker.logStats` for the caller.
 */

import type { Counter, Histogram } from '@opentelemetry/api';
import type { ResolvedMetrics } from './settings.js';
import logger from './util/Logger.js';

/** Per-window failure counts — keys MUST mirror `RenderWorker.stats.failures`. */
export type FailureCounts = {
	timeout: number;
	protocol: number;
	tooManyRedirects: number;
	getPageFailed: number;
	other: number;
};

/**
 * The per-window snapshot handed to `record()` once per stats window. Counts are deltas over the
 * window; the sample arrays are the raw per-render ms timings (what `logStats` turns into
 * percentiles) fed into OTel histograms so quantiles can be re-derived correctly across the fleet.
 */
export type MetricsSnapshot = {
	completed: number;
	succeeded: number;
	emptyContent: number;
	fromSitemap: number;
	failures: FailureCounts;
	expiredSkipped: number;
	concurrencyBlocked: number;
	rpsDelayed: number;
	resultPostFailures: number;
	browserLaunches: number;
	browserRetirements: number;
	renderTimes: number[];
	navTtfb: number[];
	navTotal: number[];
	settle: number[];
	postProcess: number[];
};

/** Point-in-time values reported by observable gauges. `null` fields are not observed. */
export type MetricsGauges = {
	inflight: number;
	concurrency: number;
	retiredBrowsers: number;
	rssBytes: number;
	workerCores: number | null;
	nodeCores: number | null;
	browserCores: number | null;
	cacheHitRate: number | null;
};

export type MetricsRecorder = {
	/** Fold one stats window into the instruments. Never throws. */
	record(snapshot: MetricsSnapshot, gauges: MetricsGauges): void;
	/** Flush buffered metrics and stop the exporter (best-effort; never throws). */
	shutdown(): Promise<void>;
};

// Render durations run seconds-to-tens-of-seconds (settle dominates); phases skew smaller.
const RENDER_DURATION_BUCKETS_MS = [
	250, 500, 1000, 2000, 4000, 6000, 8000, 10000, 12000, 15000, 20000, 30000, 45000, 60000,
];
const PHASE_DURATION_BUCKETS_MS = [50, 100, 250, 500, 1000, 2000, 4000, 6000, 8000, 10000, 15000, 20000, 30000];

/**
 * Build a metrics recorder that exports over OTLP/HTTP. Resolves once the meter provider,
 * exporter, and instruments are wired. Caller is responsible for `shutdown()` on drain.
 */
export async function createMetrics(options: ResolvedMetrics, context: { workerId: string }): Promise<MetricsRecorder> {
	// Lazy imports: nothing here loads unless a worker actually enabled metrics.
	const { MeterProvider, PeriodicExportingMetricReader, AggregationType } = await import('@opentelemetry/sdk-metrics');
	const { resourceFromAttributes } = await import('@opentelemetry/resources');
	const { OTLPMetricExporter } = await import('@opentelemetry/exporter-metrics-otlp-proto');

	// Bound a single export (incl. the SDK's internal retries) so a down/slow collector can't
	// keep an export — or the final shutdown flush — in flight for the exporter's 10s default.
	const exportTimeoutMs = Math.min(options.exportIntervalMs, 8000);
	const reader = new PeriodicExportingMetricReader({
		exporter: new OTLPMetricExporter({
			url: options.otlpEndpoint,
			headers: options.headers,
			timeoutMillis: exportTimeoutMs,
		}),
		exportIntervalMillis: options.exportIntervalMs,
		exportTimeoutMillis: exportTimeoutMs,
	});

	const provider = new MeterProvider({
		resource: resourceFromAttributes({
			'service.name': 'prerender-browser',
			'service.instance.id': context.workerId,
			'worker.id': context.workerId,
		}),
		readers: [reader],
		views: [
			{
				instrumentName: 'prerender.render.duration',
				aggregation: {
					type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
					options: { boundaries: RENDER_DURATION_BUCKETS_MS },
				},
			},
			{
				instrumentName: 'prerender.render.phase.duration',
				aggregation: {
					type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
					options: { boundaries: PHASE_DURATION_BUCKETS_MS },
				},
			},
		],
	});

	const meter = provider.getMeter('@harperfast/prerender-browser');
	const counter = (name: string, description: string): Counter => meter.createCounter(name, { description });

	const completed = counter('prerender.renders.completed', 'Renders completed (any outcome).');
	const succeeded = counter('prerender.renders.succeeded', 'Renders that completed without error.');
	const emptyContent = counter('prerender.renders.empty_content', 'Successful renders that produced empty content.');
	const fromSitemap = counter('prerender.renders.from_sitemap', 'Renders whose job originated from a sitemap.');
	const failures = counter('prerender.renders.failures', 'Failed renders, labelled by failure `type`.');
	const resultPostFailures = counter(
		'prerender.renders.result_post_failures',
		'Renders whose result POST back to Harper failed.'
	);
	const expiredSkipped = counter(
		'prerender.jobs.expired_skipped',
		'Claimed jobs skipped because their lease had nearly expired.'
	);
	const concurrencyBlocked = counter(
		'prerender.jobs.concurrency_blocked',
		'Times a job start waited on a free concurrency slot.'
	);
	const rpsDelayed = counter('prerender.jobs.rps_delayed', 'Times a job start was delayed by the rps limiter.');
	const browserLaunches = counter('prerender.browser.launches', 'Chrome browser launches.');
	const browserRetirements = counter('prerender.browser.retirements', 'Chrome browsers retired and replaced.');

	const renderDuration = meter.createHistogram('prerender.render.duration', {
		unit: 'ms',
		description: 'Wall-clock per render.',
	});
	const phaseDuration = meter.createHistogram('prerender.render.phase.duration', {
		unit: 'ms',
		description: 'Per-phase render wall-clock, labelled by `phase`.',
	});

	// Observable gauges report the most recent window's values, stored on each `record()`.
	let lastGauges: MetricsGauges | null = null;
	const gauge = (name: string, description: string, pick: (g: MetricsGauges) => number | null): void => {
		meter.createObservableGauge(name, { description }).addCallback((result) => {
			const value = lastGauges ? pick(lastGauges) : null;
			if (value !== null && value !== undefined) result.observe(value);
		});
	};
	gauge('prerender.renders.inflight', 'Renders in flight at collection time.', (g) => g.inflight);
	gauge('prerender.concurrency', 'Configured max concurrent renders.', (g) => g.concurrency);
	gauge('prerender.browser.retired_open', 'Retired browsers not yet closed.', (g) => g.retiredBrowsers);
	gauge('prerender.process.rss_bytes', 'Worker process resident set size (bytes).', (g) => g.rssBytes);
	gauge('prerender.cpu.worker_cores', 'CPU cores used by this worker (Node + its Chrome tree).', (g) => g.workerCores);
	gauge('prerender.cpu.node_cores', 'CPU cores used by the Node process.', (g) => g.nodeCores);
	gauge('prerender.cpu.browser_cores', 'CPU cores used by the Chrome tree.', (g) => g.browserCores);
	gauge('prerender.resource_cache.hit_rate', 'Resource cache hit rate over the window (0–1).', (g) => g.cacheHitRate);

	logger.info(
		{ event: 'prerender-metrics-started', endpoint: options.otlpEndpoint, exportIntervalMs: options.exportIntervalMs },
		'OpenTelemetry metrics export enabled'
	);

	const recordPhase = (samples: number[], phase: string): void => {
		for (const ms of samples) phaseDuration.record(ms, { phase });
	};

	return {
		record(snapshot, gauges) {
			try {
				completed.add(snapshot.completed);
				succeeded.add(snapshot.succeeded);
				emptyContent.add(snapshot.emptyContent);
				fromSitemap.add(snapshot.fromSitemap);
				// Only emit a failure series for types that actually occurred, to avoid five
				// permanently-zero label sets.
				for (const [type, n] of Object.entries(snapshot.failures)) {
					if (n) failures.add(n, { type });
				}
				resultPostFailures.add(snapshot.resultPostFailures);
				expiredSkipped.add(snapshot.expiredSkipped);
				concurrencyBlocked.add(snapshot.concurrencyBlocked);
				rpsDelayed.add(snapshot.rpsDelayed);
				browserLaunches.add(snapshot.browserLaunches);
				browserRetirements.add(snapshot.browserRetirements);
				for (const ms of snapshot.renderTimes) renderDuration.record(ms);
				recordPhase(snapshot.navTtfb, 'navTtfb');
				recordPhase(snapshot.navTotal, 'navTotal');
				recordPhase(snapshot.settle, 'settle');
				recordPhase(snapshot.postProcess, 'postProcess');
				lastGauges = gauges;
			} catch (err) {
				// Telemetry bookkeeping must never disrupt the worker.
				logger.debug({ err }, 'metrics record failed');
			}
		},
		async shutdown() {
			try {
				await provider.shutdown();
			} catch (err) {
				logger.debug({ err }, 'metrics shutdown failed');
			}
		},
	};
}
