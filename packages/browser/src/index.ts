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
import { applySettings, settings } from './settings.js';
import type { BrowserOptions } from './settings.js';
import { initResourceCache } from './ResourceCache.js';
import { ErrorHandler } from './errorHandler.js';

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

	if (installSignalHandlers !== false) {
		new ErrorHandler();
	}

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

	const worker = new RenderWorker({
		maxConcurrency: settings.concurrency,
		browserExpirationThreshold: settings.browserExpirationThreshold,
		rps: settings.rps,
		browserLaunchOptions: settings.browserLaunchOptions ?? {
			timeout: 20000,
			protocolTimeout: 50000,
			headless: 'shell',
			ignoreDefaultArgs: ['--disable-dev-shm-usage'],
			args: settings.chromeArgs,
		},
		renderer,
	});

	worker.run();
	return worker;
}

export { default as RenderWorker } from './Worker.js';
export { default as defaultRenderer } from './renderer.js';
export { default as RenderJob } from './RenderJob.js';
export { settings } from './settings.js';
export { defaultConfig, loadConfig, mergeConfig } from './config.js';

export type { Renderer } from './Worker.js';
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
} from './config.js';
