/**
 * Prerender plugin module (Harper Plugin API).
 *
 * `handleApplication` runs once per worker after the plugin's resources and
 * schema have loaded. It reads the host app's scoped options (`scope.options`),
 * merges the stored override layer on top, applies the result onto the live
 * `config`, re-applies on every change to either layer (live reload), and starts
 * the background schedulers once config is in effect.
 */

import { applyOptions, resolveConfig } from './src/config.js';
import {
	loadOverrideLayer,
	overridesEnabledFor,
	seedOverrideFingerprint,
	startOverrideWatch,
} from './src/util/configOverride.js';
import { startQueueStatusSync, startReadySweep } from './src/resources/RenderQueue.js';
import { startSitemapRefreshScheduler } from './src/resources/Sitemap.js';
import { startScheduleReconciler } from './src/util/reconcile.js';
import { startUnroutedReporter } from './src/util/unrouted.js';
import { startBacklogSnapshotter } from './src/util/backlogSnapshot.js';
import { startInvalidationWatch } from './src/util/invalidation.js';

export async function handleApplication(scope) {
	await scope.ready;

	const hostOptions = () => scope.options.getAll();

	// The stored-override layer, as the table last reported it. Held raw — the kill switch is
	// consulted at apply time rather than here, so flipping `management.overrides.enabled` in the
	// config file takes effect on the next apply without having to re-read the table.
	let overrides = {};

	// BOTH LAYERS ON EVERY APPLY. `applyOptions` rebuilds the whole config from defaults each time,
	// so applying one layer alone silently drops the other: a config.yaml edit would wipe every
	// override until the next override change, and vice versa.
	// FAILING OPEN IS THE WHOLE CONTRACT, and it has to hold for a throw as well as for a read that
	// times out. Component load is raced against a hard timeout and an exception here does not merely
	// delay it — `handleApplication` rejecting marks the component failed on this worker, so a single
	// unusable override row would take the plugin down across the cluster rather than degrade it. A
	// deployment running its committed config.yaml with a loud warning is always the better outcome,
	// so the override layer is dropped rather than allowed to be fatal.
	const apply = () => {
		try {
			return applyOptions(hostOptions(), overridesEnabledFor(hostOptions()) ? overrides : {});
		} catch (e) {
			scope.logger.error(
				`[prerender] Could not apply stored config overrides (${e.message}) — running the deployed ` +
					`configuration without them. Fix or clear the offending row; the layer stays inert until then.`
			);
			overrides = {};
			return applyOptions(hostOptions(), {});
		}
	};

	// SUBSCRIBE BEFORE READING. A write that lands between the read and a later subscribe is seen by
	// neither, and the resulting staleness would persist — invisibly — until the backstop poll. The
	// watcher's own settings come from a pure resolve of the file layer, because nothing has been
	// applied yet and reading the live config here would see schema defaults.
	await startOverrideWatch((next) => {
		overrides = next;
		apply();
	}, resolveConfig(hostOptions(), null).config.management.overrides);

	// Requests cannot reach this worker until handleApplication resolves — the worker's socket
	// delivery is wired inside loadRootComponents().then(...) — so awaiting the override read here is
	// what guarantees no request and no timer ever observes a pre-override config. The read is
	// bounded and fails open for the same reason it has to be awaited: component load is raced
	// against a hard timeout, and overrunning it fails the component rather than delaying it.
	const layer = await loadOverrideLayer(hostOptions());
	// Seeded from what the TABLE says, not from what was applied, so a change made while the kill
	// switch is off is still detected as a change (and still correctly ignored) rather than mistaken
	// for the steady state.
	//
	// It returns false when the watcher already applied something while this read was in flight — the
	// doorbell fired in the window that subscribing early exists to cover. In that case the watcher
	// has strictly fresher data and this boot read must NOT overwrite it; applying anyway would
	// reinstate the pre-edit config and file it under a fingerprint that says nothing is pending.
	if (seedOverrideFingerprint(layer.overrides)) {
		overrides = layer.overrides;
		apply();
	}

	// Live reload: re-apply whenever the host config changes. The background schedulers
	// below subscribe to applyOptions (onConfigApplied) and re-arm themselves, so their
	// gates and intervals — including the sitemap-refresh pinning — follow config without
	// a restart. The few boot-only options (schema scope 'restart') are diffed on
	// re-apply and reported via pendingRestartChanges instead of taking effect silently.
	scope.options.on('change', () => {
		try {
			apply();
		} catch (e) {
			scope.logger.error(e);
		}
	});

	// Start background work now that config is applied. All are idempotent and
	// self-gate by worker/node. The reconciler is deliberately NOT pinned to one node:
	// every node repairs the schedule rows it owns (see util/reconcile.js).
	startQueueStatusSync();
	startReadySweep();
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
