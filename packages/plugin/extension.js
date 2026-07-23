/**
 * Prerender plugin module (Harper Plugin API).
 *
 * `handleApplication` runs once per worker after the plugin's resources and
 * schema have loaded. It reads the host app's scoped options (`scope.options`),
 * applies them onto the live `config`, re-applies on every change (live reload),
 * and starts the background schedulers once config is in effect.
 */

import { applyOptions } from './src/config.js';
import { RenderQueue, startQueueStatusSync, stopQueueStatusSync } from './src/resources/RenderQueue.js';
import { startSitemapRefreshScheduler, stopSitemapRefreshScheduler } from './src/resources/Sitemap.js';

export async function handleApplication(scope) {
	await scope.ready;

	applyOptions(scope.options.getAll());

	// Live reload: re-apply whenever the host config changes. (Database names are
	// fixed and structural changes like render-scheduler pinning take effect on
	// restart.)
	scope.options.on('change', () => {
		try {
			applyOptions(scope.options.getAll());
		} catch (e) {
			scope.logger.error(e);
		}
	});

	// Graceful shutdown. On Harper >= 5.1 the worker awaits this listener before exiting
	// (Scope.close awaits its 'close' listeners, tracked by whenScopesClosed), so the async
	// teardown below reliably completes and is bounded by the supervisor's terminate timeout;
	// on older hosts it's best-effort. In-flight HTTP work (bot requests, render-result POSTs
	// to /render_queue/job_result) is drained by Harper's own connection close — not here.
	scope.once('close', async () => {
		try {
			// Stop the background schedulers first (synchronous, immediate) so neither burns DB
			// work during the drain: stopQueueStatusSync clears the status-refresh interval, and
			// stopSitemapRefreshScheduler clears its timer AND aborts an in-flight refresh at its
			// next yield point. Doing this before pause() also keeps a refresh tick from racing the
			// pause (a `paused` status is already sticky against non-forced reports, but there's no
			// reason to let the tick run). Both no-op on workers/nodes that never started them.
			stopQueueStatusSync();
			stopSitemapRefreshScheduler();

			// Tell the render fleet to stop claiming from this node before it goes away. pause()
			// sets the shared queue status to `paused`, which makes RenderQueue.claim return []
			// immediately for every worker on this node (the status lives in a cross-worker SAB) —
			// so no new jobs are handed out while in-flight requests drain — and replicates the
			// status so the fleet stops asking. Gated to worker 0, matching startQueueStatusSync.
			if (server.workerIndex === 0) {
				await RenderQueue.pause();
			}
		} catch (e) {
			scope.logger.error(e);
		}
	});

	// Start background work now that config is applied. Both are idempotent and
	// self-gate by worker/node.
	startQueueStatusSync();
	startSitemapRefreshScheduler();
}
