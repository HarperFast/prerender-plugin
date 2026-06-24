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

	// Start background work now that config is applied. Both are idempotent and
	// self-gate by worker/node.
	startQueueStatusSync();
	startSitemapRefreshScheduler();
}
