/**
 * Prerender console component module (Harper Plugin API).
 *
 * Reads the host app's scoped options, applies them onto the live `config`, and re-applies on
 * change. No schedulers; the one table is the proxy's read cache (src/util/readCache.js) — the
 * data all lives on the prerender cluster this console points at.
 */

import { applyOptions } from './src/config.js';

export async function handleApplication(scope) {
	await scope.ready;

	applyOptions(scope.options.getAll());

	scope.options.on('change', () => {
		try {
			applyOptions(scope.options.getAll());
		} catch (e) {
			scope.logger.error(e);
		}
	});
}
