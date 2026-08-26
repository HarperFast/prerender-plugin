/**
 * The background schedulers re-arm themselves when config changes (onConfigApplied), which
 * is what makes their gates and intervals live options instead of boot-captured ones.
 * These tests drive applyOptions and assert each scheduler's armed state follows.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let applyOptions;
let startUnroutedReporter, unroutedReporterState, recordUnroutedPath;
let startScheduleReconciler, reconcilerTimerState;
let startBacklogSnapshotter, snapshotterTimerState;
let startSitemapRefreshScheduler, sitemapSchedulerState;
let UNCLASSIFIED;

const warns = [];

before(async () => {
	globalThis.Resource = class {};
	globalThis.server = { hostname: 'node-1', workerIndex: 0, nodes: [], config: { http: { port: 9926 } } };
	globalThis.logger = {
		info() {},
		warn: (msg) => warns.push(String(msg)),
		error() {},
	};
	// Sitemap.js's import graph (Target.js, and through it the RenderSchedule funnel) destructures
	// Harper tables at module load; these tests never touch the tables, only the schedulers' timer
	// state. `coordination.SharedBuffer.primaryStore` is not optional: the funnel pulls in
	// util/renderLease.js, which acquires its shared buffer at module scope, so without it every
	// import in this file throws in `before`.
	const sabs = new Map();
	globalThis.databases = {
		render_service: { Target: class {}, QueueControl: class {} },
		render_schedule: { RenderSchedule: class {} },
		page_cache: { PrerenderedPage: class {} },
		sitemaps: { Sitemap: class {}, SitemapRefresh: class {} },
		coordination: {
			SharedBuffer: class {
				static primaryStore = {
					// Keyed — see test/renderLease.test.js on why an unkeyed fake passes for the wrong
					// reason.
					getUserSharedBuffer: (key, buffer) => {
						if (!sabs.has(key)) sabs.set(key, buffer);
						return sabs.get(key);
					},
					tryLock: () => true,
					unlock() {},
				};
			},
		},
	};

	({ applyOptions } = await import('../src/config.js'));
	({ startUnroutedReporter, unroutedReporterState, recordUnroutedPath } = await import('../src/util/unrouted.js'));
	({ UNCLASSIFIED } = await import('../src/util/routeClass.js'));
	({ startScheduleReconciler, reconcilerTimerState } = await import('../src/util/reconcile.js'));
	({ startBacklogSnapshotter, snapshotterTimerState } = await import('../src/util/backlogSnapshot.js'));
	({ startSitemapRefreshScheduler, sitemapSchedulerState } = await import('../src/resources/Sitemap.js'));

	// Boot: defaults, all schedulers started once (as handleApplication does).
	applyOptions({});
	startUnroutedReporter();
	startScheduleReconciler();
	startBacklogSnapshotter();
	startSitemapRefreshScheduler();
});

test('unrouted reporter follows enable/disable and interval changes', () => {
	assert.deepEqual(unroutedReporterState(), { started: true, armedInterval: 5 * 60 * 1000 });

	applyOptions({ ingress: { report: { interval: 60 * 1000 } } });
	assert.equal(unroutedReporterState().armedInterval, 60 * 1000);

	applyOptions({ ingress: { report: { enabled: false } } });
	assert.equal(unroutedReporterState().armedInterval, null);

	applyOptions({});
	assert.equal(unroutedReporterState().armedInterval, 5 * 60 * 1000);
});

test('unrouted reporter actually flushes on the armed cadence (and stops when disabled)', (t) => {
	t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
	// Re-arm under mock timers so the interval is a mocked one.
	applyOptions({ ingress: { report: { interval: 1000 } } });

	warns.length = 0;
	recordUnroutedPath(UNCLASSIFIED, '/mystery/paths', 'cdn');
	t.mock.timers.tick(1000);
	assert.ok(
		warns.some((w) => w.includes('served without prerendering')),
		warns.join('\n')
	);

	applyOptions({ ingress: { report: { enabled: false } } });
	warns.length = 0;
	recordUnroutedPath(UNCLASSIFIED, '/mystery/paths', 'cdn');
	t.mock.timers.tick(10_000);
	assert.equal(warns.length, 0);

	t.mock.timers.reset();
	applyOptions({});
});

test('reconciler follows enabled/interval without a restart', (t) => {
	// Never let the sweep actually fire — it would walk Harper tables that don't exist here.
	t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });

	assert.deepEqual(reconcilerTimerState(), { started: true, armedInterval: 6 * 60 * 60 * 1000 });

	// Turning the sweep OFF at runtime (the incident lever) disarms it.
	applyOptions({ render: { reconcile: { enabled: false } } });
	assert.equal(reconcilerTimerState().armedInterval, null);

	// Turning it back ON re-arms (boot-shaped: startDelay + jitter, then the interval).
	applyOptions({ render: { reconcile: { interval: 60 * 60 * 1000 } } });
	assert.equal(reconcilerTimerState().armedInterval, 60 * 60 * 1000);

	// A cadence change while running swaps the interval.
	applyOptions({ render: { reconcile: { interval: 2 * 60 * 60 * 1000 } } });
	assert.equal(reconcilerTimerState().armedInterval, 2 * 60 * 60 * 1000);

	t.mock.timers.reset();
	applyOptions({});
});

test('backlog snapshotter gates on management.enabled and its interval (0 disables)', (t) => {
	t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });

	assert.deepEqual(snapshotterTimerState(), { started: true, armedInterval: 15 * 60 * 1000 });

	applyOptions({ management: { backlogSnapshotInterval: 0 } });
	assert.equal(snapshotterTimerState().armedInterval, null);

	applyOptions({ management: { enabled: false } });
	assert.equal(snapshotterTimerState().armedInterval, null);

	applyOptions({ management: { backlogSnapshotInterval: 5 * 60 * 1000 } });
	assert.equal(snapshotterTimerState().armedInterval, 5 * 60 * 1000);

	t.mock.timers.reset();
	applyOptions({});
});

test('sitemap refresh scheduler starts/stops/re-schedules as the pin and time move', (t) => {
	t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });

	// Boot had no sitemap.node: nothing scheduled anywhere.
	assert.deepEqual(sitemapSchedulerState(), { started: true, armedKey: null });

	// Pinning this node+worker at runtime arms the daily refresh — the change that used to
	// require a full restart.
	applyOptions({ sitemap: { node: 'node-1' } });
	assert.equal(sitemapSchedulerState().armedKey, '12:00|America/New_York|86400000');

	// Changing the refresh time re-schedules the pending run.
	applyOptions({ sitemap: { node: 'node-1', refreshTime: '03:30', timezone: 'UTC' } });
	assert.equal(sitemapSchedulerState().armedKey, '03:30|UTC|86400000');

	// So does changing the interval alone: the armed key carries it, so moving from one pass a
	// day to four takes effect on the next config apply rather than at the next restart.
	applyOptions({
		sitemap: { node: 'node-1', refreshTime: '03:30', timezone: 'UTC', refreshInterval: 6 * 60 * 60 * 1000 },
	});
	assert.equal(sitemapSchedulerState().armedKey, '03:30|UTC|21600000');

	// Re-pinning to another node (or worker) disarms this one.
	applyOptions({ sitemap: { node: 'node-2' } });
	assert.equal(sitemapSchedulerState().armedKey, null);

	applyOptions({ sitemap: { node: 'node-1', workerIndex: 3 } });
	assert.equal(sitemapSchedulerState().armedKey, null);

	t.mock.timers.reset();
	applyOptions({});
});
