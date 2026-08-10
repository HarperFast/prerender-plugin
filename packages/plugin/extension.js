/**
 * Prerender plugin module (Harper Plugin API).
 *
 * `handleApplication` runs once per worker after the plugin's resources and
 * schema have loaded. It reads the host app's scoped options (`scope.options`),
 * applies them onto the live `config`, re-applies on every change (live reload),
 * and starts the background schedulers once config is in effect.
 */

import { applyOptions } from './src/config.js';
import { startQueueStatusSync } from './src/resources/RenderQueue.js';
import { startSitemapRefreshScheduler } from './src/resources/Sitemap.js';
import { startScheduleReconciler } from './src/util/reconcile.js';
import { startUnroutedReporter } from './src/util/unrouted.js';
import { startBacklogSnapshotter } from './src/util/backlogSnapshot.js';
import { startInvalidationWatch } from './src/util/invalidation.js';

export async function handleApplication(scope) {
	await scope.ready;

	applyOptions(scope.options.getAll());

	// Live reload: re-apply whenever the host config changes. The background schedulers
	// below subscribe to applyOptions (onConfigApplied) and re-arm themselves, so their
	// gates and intervals — including the sitemap-refresh pinning — follow config without
	// a restart. The few boot-only options (schema scope 'restart') are diffed on
	// re-apply and reported via pendingRestartChanges instead of taking effect silently.
	scope.options.on('change', () => {
		try {
			applyOptions(scope.options.getAll());
		} catch (e) {
			scope.logger.error(e);
		}
	});

	// Start background work now that config is applied. All are idempotent and
	// self-gate by worker/node. The reconciler is deliberately NOT pinned to one node:
	// every node repairs the schedule rows it owns (see util/reconcile.js).
	startQueueStatusSync();
	startSitemapRefreshScheduler();
	startScheduleReconciler();
	// Keeps the console's backlog histogram off the page-load path: the scan walks the same
	// nextRenderTime index `claim` reads from, so it recomputes on this slow cadence instead.
	startBacklogSnapshotter();
	// Unlike the three above, this one runs on EVERY worker: its counters are in-process, so
	// each worker has to flush its own tally (see util/unrouted.js).
	startUnroutedReporter();
	// EVERY worker too, and for two different reasons in one call: it primes this worker's
	// last-known-good invalidation set (the serve path resolves per request, and the HTTP handler is
	// installed at module load — before this runs — so the very first cache-servable request would
	// otherwise be the one uncovered read), and it reports any recorded scope that no longer names a
	// configured route. That second half must re-run on config changes, because a route RENAMED by a
	// live edit un-invalidates a corpus somebody deliberately invalidated, with nothing else to notice.
	startInvalidationWatch();
}
