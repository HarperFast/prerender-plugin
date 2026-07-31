/**
 * Public library entry for @harperfast/prerender-browser.
 *
 * The package is configured entirely through the options passed to `startWorker()` —
 * it reads no environment variables of its own. A consumer (e.g. a render-service
 * deployment) sources connection/secrets/config however it likes and passes them in:
 *
 *   import { startWorker, defaultRenderer } from '@harperfast/prerender-browser';
 *   await startWorker({
 *     harper: { mqttOrigin, user, pass, workerId },     // required
 *     bypass: { header: 'x-harper-pr-token', token },   // must match the plugin
 *     config: { navigation: { waitUntil: 'networkidle2' } }, // partial, merged over defaults
 *     renderer: async (page, job) => {                  // optional custom renderer
 *       // site-specific page setup the declarative config can't express...
 *       return defaultRenderer(page, job);
 *     },
 *   });
 */

import RenderWorker, { Renderer } from './Worker.js';
import defaultRenderer from './renderer.js';
import logger from './util/Logger.js';
import { applySettings, settings, workerLaunchOptions } from './settings.js';
import type { BrowserOptions } from './settings.js';
import { initResourceCache } from './ResourceCache.js';
import { ErrorHandler } from './errorHandler.js';

// How long in-flight renders get to finish after a termination signal before they're abandoned.
// Must stay comfortably under the supervisor's termination grace period (Kubernetes' default is
// 30s) so the drain + browser close complete before SIGKILL.
const SHUTDOWN_DRAIN_MS = 12000;

export type StartWorkerOptions = BrowserOptions & {
	/** Renderer to use instead of the built-in default. */
	renderer?: Renderer;
	/**
	 * Install process-level handlers (uncaughtException / unhandledRejection /
	 * SIGTERM / SIGINT) that log and gracefully exit. Default true. Set false to let
	 * the embedding app own process lifecycle.
	 */
	installSignalHandlers?: boolean;
};

/**
 * Boot the render worker: resolve options into the live settings, initialize the
 * resource cache, then subscribe → claim → render → post back. Resolves once the
 * cache index is built and the worker loop has started. Throws if a required Harper
 * connection option is missing.
 */
export async function startWorker(options: StartWorkerOptions): Promise<RenderWorker> {
	const { renderer: customRenderer, installSignalHandlers, ...browserOptions } = options;
	applySettings(browserOptions);
	const renderer = customRenderer ?? defaultRenderer;

	logger.info({
		event: 'prerender-browser-config',
		customRenderer: Boolean(customRenderer),
		settings: {
			...settings,
			harper: { ...settings.harper, pass: settings.harper.pass ? 'REDACTED' : '' },
			bypass: { ...settings.bypass, token: settings.bypass.token ? 'REDACTED' : '' },
		},
	});

	// Block job intake until the cache has scanned disk and built its in-memory index.
	await initResourceCache(settings.resourceCache);

	// Who owns SIGTERM/SIGINT also decides how Chrome is torn down — see workerLaunchOptions.
	const ownsSignals = installSignalHandlers !== false;
	const worker = new RenderWorker({
		maxConcurrency: settings.concurrency,
		browserExpirationThreshold: settings.browserExpirationThreshold,
		rps: settings.rps,
		browserLaunchOptions: workerLaunchOptions(ownsSignals),
		renderer,
	});

	// Install signal handlers AFTER the worker exists so SIGTERM/SIGINT can drain it
	// (stop claiming, finish in-flight renders) instead of dropping in-flight work.
	if (ownsSignals) {
		new ErrorHandler({
			// The forced-exit backstop must land strictly AFTER the drain deadline: with both at
			// the same value it can fire in the same tick the drain gives up, cutting off the
			// graceful browser close that follows it.
			shutdownDeadlineMs: SHUTDOWN_DRAIN_MS + 3000,
			onTerminate: () => worker.shutdown(SHUTDOWN_DRAIN_MS),
			onForceExit: () => worker.killBrowsersSync(),
		});
	}

	worker.run();
	return worker;
}

export { default as RenderWorker } from './Worker.js';
export { default as defaultRenderer } from './renderer.js';
export { default as RenderJob } from './RenderJob.js';
export { settings } from './settings.js';
export { defaultConfig, loadConfig, mergeConfig } from './config.js';

// On-demand render + analysis harness (the off-queue counterpart to startWorker). resolveSettings
// and defaultLaunchOptions stay internal — the public surface is renderOnce/renderMatrix + probes.
export { renderOnce, renderMatrix, selectorCountProbe, htmlContainsProbe } from './renderOnce.js';

// Prerenderability audit — the analysis counterpart to renderOnce: it renders one (url, device) cell in
// three states (full render / served bytes / served-bytes-rehydrated) and reports the two content diffs
// that expose what bots miss. renderAudit is the primitive; renderHtmlReport builds a self-contained HTML
// report from the cells; runSelfCheck is the tool's own correctness suite.
export { renderAudit } from './audit/renderAudit.js';
export { renderHtmlReport } from './audit/report.js';
export { runSelfCheck, runSelfCheckResults } from './audit/selfCheck.js';

export type { Renderer } from './Worker.js';
export type { RenderOnceOptions, RenderResult, RenderOutcome, Probe, ProbeContext } from './renderOnce.js';
export type { RenderAuditOptions } from './audit/renderAudit.js';
export type { SelfCheckResult } from './audit/selfCheck.js';
export type {
	AuditResult,
	AuditOutcome,
	Finding,
	FixType,
	Frequency,
	Fingerprint,
	FingerprintMeta,
	LinkKey,
	ImageKey,
	JsonLdEntry,
	Diff1,
	Diff2,
	BucketDrop,
	NoiseInfo,
	SelfJaccard,
	SuggestedConfig,
} from './audit/util.js';
export type { JobConfig } from './RenderJob.js';
export type { BrowserOptions, ResourceCacheOptions, Settings } from './settings.js';
export type {
	PrerenderConfig,
	DeepPartial,
	DeviceProfile,
	Viewport,
	BlockConfig,
	NavigationConfig,
	ScrollConfig,
	PostProcessConfig,
	WaitForRule,
} from './config.js';
