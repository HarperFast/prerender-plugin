/**
 * The Change probe view, executed.
 *
 * Four things have to stay true here, and each of them is a way the panel could read as healthy
 * while the probe is doing nothing useful:
 *
 *   - The change rate's denominator is the probes that HAD a baseline. A pass that is mostly
 *     seeding compares almost nothing, and dividing by `probed` would report that as a low
 *     change rate — "the catalogue is stable" — when the truthful answer is "we have not
 *     compared anything yet".
 *   - The pass counters are per FINISHED PASS, so `count` is passes and the recorded value is
 *     what a pass counted. Summing counts answers "how many passes ran", with a plausible
 *     number.
 *   - A dominant failure share is the endpoint-changed-shape alarm, and it is invisible in every
 *     other number: a failed probe leaves the signature untouched, triggers nothing, and looks
 *     exactly like a page that did not change.
 *   - A canary trip is one node's verdict about its own cohort. Folding four of them into a
 *     single boolean would name no node and match no log line.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installDom, find } from './domShim.js';

installDom();

const { el } = await import('../src/admin/ui.js');
const { load, render } = await import('../src/admin/views/probe.js');

const BUCKETS = 4;
const HOUR = 3_600_000;

/** A prerender_ops pass counter: `count` is PASSES, `mean` is what each pass counted. */
const passes = (series, passCount, perPass) => ({
	metric: 'prerender_ops',
	path: `probe_${series}`,
	method: null,
	type: null,
	count: passCount,
	total: 0,
	counts: new Array(BUCKETS).fill(passCount / BUCKETS),
	mean: perPass,
	median: perPass,
	p95: perPass,
	means: new Array(BUCKETS).fill(perPass),
	p95s: new Array(BUCKETS).fill(perPass),
});

// 4 passes, each probing 1000: 400 seeded and 100 failed per pass, so 4,000 probed, 2,000 of them
// compared, and 240 changed. The honest change rate is 240/2,000 = 12%; against `probed` it would
// read as 6% — the same catalogue, a different verdict.
const ANALYTICS = {
	available: true,
	scope: 'node',
	node: 'node-a',
	rangeMs: 24 * HOUR,
	startMs: 0,
	endMs: 24 * HOUR,
	bucketMs: 6 * HOUR,
	bucketCount: BUCKETS,
	truncated: false,
	scan: { ms: 4, scanned: 10, kept: 10, cap: 20_000 },
	series: [
		passes('probed', 4, 1000),
		passes('seeded', 4, 400),
		passes('failed', 4, 100),
		passes('changed', 4, 60),
		passes('triggered', 4, 55),
		passes('deferred', 4, 5),
		passes('canary_trip', 2, 1),
		passes('invalidated', 1, 1),
	],
};

const STATUS = {
	enabled: true,
	dryRun: true,
	node: 'node-a',
	ownerScopeNote: 'Probes only the URLs this node owns; every node sweeps its own slice.',
	rules: [
		{ label: 'price', pathPattern: '^/product/([^/]+)', source: 'request', invalidateScope: 'route:prefix:/product/' },
	],
	sweep: {
		running: false,
		armedInterval: 24 * HOUR,
		lastRun: {
			examined: 40_000,
			owned: 10_000,
			matched: 4000,
			probed: 4000,
			seeded: 1600,
			unchanged: 1760,
			changed: 240,
			triggered: 220,
			deferred: 20,
			failed: 400,
			errors: 0,
			failureSamples: [{ url: 'https://www.example.com/product/a', rule: 'price', error: 'HTTP 500' }],
			dryRun: true,
			startedAt: Date.now() - HOUR,
			finishedAt: Date.now() - 1000,
			error: null,
		},
	},
	canary: {
		running: false,
		armedInterval: 30 * 60_000,
		cohortSizes: { price: 500 },
		lastRun: {
			perRule: [
				{
					rule: 'price',
					cohort: 500,
					changed: 90,
					unchanged: 410,
					compared: 500,
					fraction: 0.18,
					tripped: true,
					action: { acted: false, reason: 'dry-run' },
				},
			],
			dryRun: true,
			startedAt: Date.now() - 60_000,
			finishedAt: Date.now() - 30_000,
			error: null,
		},
	},
};

const PROBE_CONFIG = (ratePerSecond = 10, concurrency = 4) => ({
	schema: {
		children: {
			changeProbe: { children: { ratePerSecond: { kind: 'option' }, concurrency: { kind: 'option' } } },
		},
	},
	layers: [
		{ path: 'changeProbe.ratePerSecond', effective: ratePerSecond },
		{ path: 'changeProbe.concurrency', effective: concurrency },
	],
});

function makeCtx({ status = STATUS, analytics = ANALYTICS, config = PROBE_CONFIG() } = {}) {
	const views = {};
	const scratch = (id) => (views[id] ??= {});
	const calls = { posts: [], renders: 0, reloads: 0 };
	return {
		calls,
		scratch,
		busy: false,
		get data() {
			return scratch('probe');
		},
		async get(route) {
			if (route === 'change-probe')
				return status
					? { ok: true, body: status }
					: { ok: false, status: 409, body: { error: 'changeProbe.enabled is false' } };
			if (route === 'analytics') return { ok: true, body: analytics };
			if (route === 'config') return { ok: true, body: config };
			return { ok: true, body: null };
		},
		async post(route, data) {
			calls.posts.push({ route, data });
			return { ok: true, body: {} };
		},
		async run(fn) {
			return fn();
		},
		render() {
			calls.renders++;
		},
		reload() {
			calls.reloads++;
		},
		go() {},
	};
}

const draw = (ctx) => el('div', null, render(ctx));
const tile = (ctx, label) =>
	find(draw(ctx), (n) => n.attributes?.class === 'stat' && n.children[0]?.textContent === label);
const button = (ctx, text) => find(draw(ctx), (n) => n.tagName === 'BUTTON' && n.textContent === text);

const ready = async (options) => {
	const ctx = makeCtx(options);
	await load(ctx);
	return ctx;
};

test('the change rate is measured against what was COMPARED, not against every probe', async () => {
	const ctx = await ready();
	const changed = tile(ctx, 'Changed');
	assert.ok(changed, 'expected a Changed tile');
	assert.match(changed.textContent, /12%/);
	assert.match(changed.textContent, /of 2\.0k compared/);
});

test('a pass counter is summed by VALUE — counting emits would report the number of passes', async () => {
	const ctx = await ready();
	// 4 passes × 1000 = 4,000 probes. Summing `count` would say 4.
	assert.match(tile(ctx, 'Probes').textContent, /4\.0k/);
});

test('a dominant failure share is called out as the endpoint alarm, not left as a number', async () => {
	const ctx = await ready({
		analytics: {
			...ANALYTICS,
			series: ANALYTICS.series.map((s) =>
				s.path === 'probe_failed' ? { ...s, mean: 900, means: s.means.map(() => 900) } : s
			),
		},
	});
	const text = draw(ctx).textContent;
	assert.match(text, /90% of probes failed/);
	assert.match(text, /back on interval-only freshness/);
	assert.ok(
		find(draw(ctx), (n) => n.attributes?.class === 'note bad'),
		'and it should read as a fault'
	);
});

test('a trip that recorded no invalidation says so instead of implying pages were flushed', async () => {
	const ctx = await ready();
	// 2 trips, 1 invalidation — the other was the dry run.
	assert.match(draw(ctx).textContent, /1 canary trip recorded no invalidation/);
});

test('an empty window is explained by the pass cadence, not read as "nothing is probing"', async () => {
	const ctx = await ready({ analytics: { ...ANALYTICS, series: [] } });
	const text = draw(ctx).textContent;
	assert.match(text, /once per FINISHED pass/);
	assert.match(text, /widen the range/);
});

// ---- the canary verdict ------------------------------------------------------

test('a trip names the node that tripped, because the cohort it judged was that node’s', async () => {
	const ctx = await ready();
	assert.match(draw(ctx).textContent, /tripped on node-a/);
});

test('a refusal to invalidate is reported with its reason, not as a successful trip', async () => {
	const ctx = await ready();
	assert.match(draw(ctx).textContent, /dry run — nothing invalidated/);
});

test('an unresolvable invalidateScope is a fault, not a footnote', async () => {
	const ctx = await ready({
		status: {
			...STATUS,
			dryRun: false,
			canary: {
				...STATUS.canary,
				lastRun: {
					...STATUS.canary.lastRun,
					perRule: [{ ...STATUS.canary.lastRun.perRule[0], action: { acted: false, reason: 'unresolvable-scope' } }],
				},
			},
		},
	});
	assert.match(draw(ctx).textContent, /names no configured route — NOTHING was invalidated/);
});

test('an empty cohort says the mass-change detector is dark rather than showing a clean zero', async () => {
	const ctx = await ready({
		status: {
			...STATUS,
			canary: {
				...STATUS.canary,
				cohortSizes: { price: 0 },
				lastRun: {
					...STATUS.canary.lastRun,
					perRule: [{ rule: 'price', cohort: 0, skipped: 'empty cohort' }],
				},
			},
		},
	});
	assert.match(draw(ctx).textContent, /mass-change\s+detector is dark/);
});

// ---- running a pass ----------------------------------------------------------

test('a pass inherits the configured dry run by default, and can be forced to a dry one', async () => {
	const ctx = await ready();
	button(ctx, 'Run sweep').listeners.click[0]();
	assert.deepEqual(ctx.calls.posts.at(-1), { route: 'change-probe', data: { action: 'sweep' } });

	ctx.data.runMode = 'dry';
	button(ctx, 'Run sweep').listeners.click[0]();
	assert.deepEqual(ctx.calls.posts.at(-1), { route: 'change-probe', data: { action: 'sweep', dryRun: true } });
});

test('under cluster scope the run buttons refuse and say why — a pass is one node’s rate budget', async () => {
	const ctx = await ready({
		status: {
			...STATUS,
			node: null,
			sources: { mode: 'merged', answered: 4, configured: 4, complete: true, nodes: [] },
		},
	});
	const sweep = button(ctx, 'Sweep (pick a node)');
	assert.ok(sweep, 'expected the button to name the scope problem rather than being silently inert');
	assert.equal(sweep.attributes.disabled, '');
	assert.match(sweep.attributes.title, /that node’s probe rate/);
});

test('a disabled probe names the nodes it is off on — their slice is simply absent from every total', async () => {
	const ctx = await ready({
		status: {
			...STATUS,
			enabled: true,
			disabledOn: ['node-c'],
			sources: { mode: 'merged', answered: 4, configured: 4, complete: true, nodes: [] },
		},
	});
	// `enabled` true with a disabledOn list is exactly the cluster case: some nodes have it on.
	const ctxOff = await ready({ status: { ...STATUS, enabled: false, disabledOn: ['node-c', 'node-d'] } });
	assert.match(draw(ctxOff).textContent, /is false on node-c, node-d/);
	assert.match(draw(ctxOff).textContent, /never probed/);
	assert.ok(draw(ctx));
});

test('an enabled probe with no rules says no timer is armed rather than showing an idle sweep', async () => {
	const ctx = await ready({
		status: { ...STATUS, rules: [], sweep: { running: false, armedInterval: null, lastRun: null } },
	});
	assert.match(draw(ctx).textContent, /no timer is armed/);
});

test('an unswept node is named, because it contributes zero to every figure above', async () => {
	const ctx = await ready({
		status: {
			...STATUS,
			sweep: { ...STATUS.sweep, unsweptNodes: ['node-b'], lastRun: { ...STATUS.sweep.lastRun, nodes: 3 } },
		},
	});
	const text = draw(ctx).textContent;
	assert.match(text, /No sweep has finished on node-b/);
	assert.match(text, /Oldest of 3 sweeps/);
});

test('the failure samples are shown, because a failed probe changes nothing and logs nowhere else', async () => {
	const ctx = await ready();
	assert.match(draw(ctx).textContent, /HTTP 500/);
});

test('the status read failing still renders the card that turns the probe on', async () => {
	const ctx = await ready({ status: null });
	assert.match(draw(ctx).textContent, /changeProbe.enabled is false/);
});

test('one node throwing does not delete the three that swept — both are reported', async () => {
	// The merge takes the first error it finds across nodes, so an error and a full set of counters
	// arrive together whenever the cluster is partly healthy. Showing only the error was dropping
	// three good slices; showing only the counters hid that a quarter of the keyspace was missed.
	const ctx = await ready({
		status: {
			...STATUS,
			sweep: {
				...STATUS.sweep,
				lastRun: { ...STATUS.sweep.lastRun, nodes: 4, error: 'read transaction expired' },
			},
		},
	});
	const text = draw(ctx).textContent;
	assert.match(text, /read transaction expired/);
	assert.match(text, /only the passes that did finish/);
	assert.match(text, /Rows examined/);
});

test('an errored pass that counted nothing shows the error alone, not a row of dashes', async () => {
	const ctx = await ready({
		status: {
			...STATUS,
			sweep: {
				...STATUS.sweep,
				lastRun: { node: 'node-a', startedAt: 1000, finishedAt: 2000, error: 'boom' },
			},
		},
	});
	const text = draw(ctx).textContent;
	assert.match(text, /Last sweep failed: boom/);
	assert.doesNotMatch(text, /Rows examined/);
	assert.doesNotMatch(text, /No sweep has finished since startup/);
});

test('the failure threshold is compared explicitly, so an empty window never reads as failing', async () => {
	// probed 0 makes the ratio null. Nothing may turn that into a "probe failures dominate" verdict.
	const ctx = await ready({ analytics: { ...ANALYTICS, series: [passes('failed', 1, 0)] } });
	assert.doesNotMatch(draw(ctx).textContent, /probe failures dominate/);
});

// ---------------------------------------------------------------- origin pressure

// THE ONE ALARM ON THIS PAGE THAT IS NOT ABOUT THE PROBE. Every other signal here reports a probe
// that has stopped telling the truth; this one reports a probe that is hurting the origin. It is
// also the only signal that says so: the sweep answers pushback by halving its own rate, so the
// probe quietly covers less of the corpus per pass while the change rate, the failure share and
// the trigger count all keep exactly the shape they had.
test('origin pushback is raised as its own alarm, not buried inside the failure count', async () => {
	const ctx = await ready({
		analytics: { ...ANALYTICS, series: [...ANALYTICS.series, passes('throttled', 4, 80)] },
	});
	const text = draw(ctx).textContent;
	assert.match(text, /The origin pushed back on 320 probes/);
	assert.match(text, /429\/502\/503\/504/);
	assert.match(text, /whoever runs the origin/);
	assert.match(text, /origin pushing back/, 'and it earns a pill on the card head');
});

// Throttled probes are a SUBSET of failed ones, and two tiles that look like siblings invite
// adding them. The tile says which of the two contains the other.
test('the throttled tile names its relationship to Failed rather than reading as a sibling', async () => {
	const ctx = await ready({
		analytics: { ...ANALYTICS, series: [...ANALYTICS.series, passes('throttled', 4, 80)] },
	});
	assert.match(tile(ctx, 'Throttled').textContent, /inside Failed/i);
});

test('no pushback raises nothing — a healthy origin is not an amber state', async () => {
	const text = draw(await ready()).textContent;
	assert.doesNotMatch(text, /pushed back/);
	assert.doesNotMatch(text, /origin pushing back/);
});

// ---------------------------------------------------------------- resumable sweeps

// `fresh` is DISJOINT FROM `probed`: a skipped URL was never attempted. Reported as a share of the
// probes it would exceed 100% on a heavily-skipped pass, and read as part of them it would make a
// resumed sweep look like a shrinking corpus.
test('rows skipped as fresh are counted against what a pass considered, not against its probes', async () => {
	const ctx = await ready({
		analytics: { ...ANALYTICS, series: [...ANALYTICS.series, passes('fresh', 4, 250)] },
	});
	// 4 × 250 = 1,000 skipped, against 4,000 probed = 5,000 considered.
	assert.match(tile(ctx, 'Skipped as fresh').textContent, /1\.0k/);
	assert.match(tile(ctx, 'Skipped as fresh').textContent, /of 5\.0k rows considered/);
});

// A settled deployment that skips most of what it considers is not keeping the cadence its
// settings describe: reprobeAfter sits too close to sweepInterval, so a URL probed late in one
// pass is skipped by the next and its true cadence is two sweep intervals. `probed` alone just
// looks like a smaller corpus.
test('a sustained skip share is explained as a reprobeAfter/sweepInterval overlap', async () => {
	const ctx = await ready({
		analytics: { ...ANALYTICS, series: [...ANALYTICS.series, passes('fresh', 4, 5000)] },
	});
	const text = draw(ctx).textContent;
	assert.match(text, /reprobeAfter/);
	assert.match(text, /two sweep\s+intervals|two sweep intervals/);
});

// ---------------------------------------------------------------- unreadable rows

// A row the application layer cannot address is a storage-layer fault, and no setting on this page
// reaches it. It also appears in no other count: those targets are simply never probed.
test('unreadable registry rows are escalated to the database layer, not shown as a probe setting', async () => {
	const ctx = await ready({
		analytics: { ...ANALYTICS, series: [...ANALYTICS.series, passes('unreadable', 1, 7)] },
	});
	const text = draw(ctx).textContent;
	assert.match(text, /7 registry rows could not be decoded/);
	assert.match(text, /database team/);
});

// ---------------------------------------------------------------- page check (plugin v0.58.0)

// A mismatch means a different thing per run mode, and the counter cannot say which: armed, each
// one was hard-expired the moment it was seen (a detection rate); dry, nothing expires them, so
// the same disagreement is re-reported every pass (a standing count of wrong pages being served).
// The run mode is the STATUS's fact, so the note must read it there rather than guess from the
// window — and only the standing case warns, because armed the counter is the feature working.
test('page mismatches in dry run read as a standing count of wrong pages, and warn', async () => {
	const ctx = await ready({
		analytics: { ...ANALYTICS, series: [...ANALYTICS.series, passes('page_mismatch', 4, 5)] },
	});
	const text = draw(ctx).textContent;
	assert.match(text, /20 probes found the cached page disagreeing/);
	assert.match(text, /standing count of wrong pages/);
	assert.match(text, /pages disagree with the origin/, 'earns a pill while nothing is expiring them');
});

test('page mismatches while armed read as a detection rate, not an alarm', async () => {
	const ctx = await ready({
		status: { ...STATUS, dryRun: false },
		analytics: { ...ANALYTICS, series: [...ANALYTICS.series, passes('page_mismatch', 4, 5)] },
	});
	const text = draw(ctx).textContent;
	assert.match(text, /hard-expired the moment it was seen/);
	assert.doesNotMatch(text, /standing count/);
	assert.doesNotMatch(text, /pages disagree with the origin/);
});

// Mismatched rows are ALSO inside Changed or the unchanged remainder — the plugin buckets by
// signature outcome alone — and two tiles that look like siblings invite adding them.
test('the mismatch tile names the overlay instead of posing as an outcome bucket', async () => {
	const ctx = await ready({
		analytics: { ...ANALYTICS, series: [...ANALYTICS.series, passes('page_mismatch', 4, 5)] },
	});
	assert.match(tile(ctx, 'Page mismatch').textContent, /overlays the buckets/);
});

test('zero mismatches raise nothing — pageCheck unset and a fleet predating it look identical', async () => {
	const text = draw(await ready()).textContent;
	assert.doesNotMatch(text, /found the cached page disagreeing/);
	assert.doesNotMatch(text, /pages disagree with the origin/);
});

test('the sweep card reports pages that disagreed, and hides the row when there were none', async () => {
	const withMismatches = await ready({
		status: { ...STATUS, sweep: { ...STATUS.sweep, lastRun: { ...STATUS.sweep.lastRun, pageMismatch: 12 } } },
	});
	assert.match(draw(withMismatches).textContent, /Pages disagreeing with the origin/);
	assert.doesNotMatch(draw(await ready()).textContent, /Pages disagreeing with the origin/);
});

// ---------------------------------------------------------------- how a pass ended

// Three reasons a pass stops early, and they are not interchangeable: standing down for a reseed
// and being disabled are routine, while giving up on a refusing origin means the slice was never
// covered. One "Interrupted" label made the third indistinguishable from the first two.
test('a pass that gave up on a refusing origin is not labelled the same as one that stood down', async () => {
	const ctx = await ready({
		status: {
			...STATUS,
			sweep: {
				...STATUS.sweep,
				lastRun: { ...STATUS.sweep.lastRun, aborted: true, abortedOnDistress: true, throttled: 640 },
			},
		},
	});
	const text = draw(ctx).textContent;
	assert.match(text, /gave up on a refusing origin/);
	assert.match(text, /STOPPED EARLY/);
	assert.match(text, /partial count/);
	assert.doesNotMatch(text, /stood down for a reseed/);
});

test('a routine interruption keeps its routine wording', async () => {
	const ctx = await ready({
		status: { ...STATUS, sweep: { ...STATUS.sweep, lastRun: { ...STATUS.sweep.lastRun, aborted: true } } },
	});
	const text = draw(ctx).textContent;
	assert.match(text, /stood down for a reseed/);
	assert.doesNotMatch(text, /gave up on a refusing origin/);
});

// The pacing window halves back on every clean batch, so a value above 1 when the pass FINISHED
// means it was still backed off at the end — the pass took longer than sweepInterval implies and
// the corpus is being re-probed more slowly than the settings say.
test('a pass that finished still backed off says so, because its duration is not what it looks like', async () => {
	const ctx = await ready({
		status: {
			...STATUS,
			sweep: { ...STATUS.sweep, lastRun: { ...STATUS.sweep.lastRun, throttled: 40, throttleLevel: 8 } },
		},
	});
	const text = draw(ctx).textContent;
	assert.match(text, /8× normal/);
	assert.match(text, /still backed off/);
});

test('a pass that never backed off shows no pacing row at all', async () => {
	const ctx = await ready({
		status: { ...STATUS, sweep: { ...STATUS.sweep, lastRun: { ...STATUS.sweep.lastRun, throttleLevel: 1 } } },
	});
	assert.doesNotMatch(draw(ctx).textContent, /normal — still backed off/);
});

// ---- continuous mode -----------------------------------------------------------------------------

/**
 * The plugin tags the MODE into `sweep.armedInterval` (the literal 'continuous' instead of a
 * number), because that field is what its scheduler compares to decide whether to re-arm. Every
 * console reader of it therefore has to branch — and the failure of not branching is silent:
 * `duration('continuous')` renders nonsense rather than throwing, so the cadence line would read
 * as a broken number on exactly the deployments running the new mode.
 */
const CONTINUOUS = {
	...STATUS,
	mode: 'continuous',
	sweep: { ...STATUS.sweep, armedInterval: 'continuous', cycleTarget: 12 * HOUR, sliceSize: 237_000 },
};

test('continuous mode reports its target and slice, not a formatted interval', async () => {
	const ctx = await ready({ status: CONTINUOUS });
	const text = draw(ctx).textContent;
	assert.match(text, /continuous/);
	assert.match(text, /target 12h/);
	assert.match(text, /237.0k rows|237,000 rows/);
	assert.doesNotMatch(text, /every continuous/, 'the interval phrasing must not be applied to the mode string');
});

test('continuous mode with no measured slice says it is measuring, not nothing', async () => {
	// The first cycle after a restart runs at the rate ceiling because it has no denominator yet.
	// Rendering that as a blank would make "measuring" indistinguishable from "behind".
	const ctx = await ready({
		status: { ...CONTINUOUS, sweep: { ...CONTINUOUS.sweep, sliceSize: null } },
	});
	assert.match(draw(ctx).textContent, /measuring the slice/);
});

test('interval mode still reads as an interval — the new branch must not capture it', async () => {
	const ctx = await ready();
	const text = draw(ctx).textContent;
	assert.match(text, /every 1d/);
	// Scoped to the CADENCE LABEL's own shape, not to the word anywhere on the page: the settings
	// card documents both modes, so a bare /continuous/ here would fail on prose rather than on
	// the thing under test.
	assert.doesNotMatch(text, /continuous · target/);
});

test('the cycle-behind tile is hidden in interval mode, where there is no target to miss', async () => {
	// A permanent zero would read as "meeting the target" on a deployment that has none.
	assert.ok(!tile(await ready(), 'Cycle behind'));
});

test('continuous mode shows cycle-behind, and warns when the ceiling cannot meet the target', async () => {
	const ctx = await ready({
		status: CONTINUOUS,
		analytics: { ...ANALYTICS, series: [...ANALYTICS.series, passes('cycle_behind', 4, 35)] },
	});
	const behind = tile(ctx, 'Cycle behind');
	assert.ok(behind, 'expected the tile in continuous mode');
	assert.match(behind.textContent, /140/);
});

// ---- pacing & capacity -------------------------------------------------------------------------

/**
 * The panel exists because `throughput = min(concurrency / latency, ratePerSecond)` has two terms
 * that fail with identical symptoms and unrelated fixes. Every case below is one an operator
 * would otherwise have to derive by hand from a pass's start/finish timestamps.
 */
const sweptAt = (probed, seconds, extra = {}) => ({
	...CONTINUOUS,
	sweep: {
		...CONTINUOUS.sweep,
		lastRun: {
			...CONTINUOUS.sweep.lastRun,
			probed,
			throttled: 0,
			throttleLevel: 1,
			startedAt: Date.now() - seconds * 1000,
			finishedAt: Date.now(),
			...extra,
		},
	},
});

test('a sweep running AT its ceiling says the ceiling is the limit', async () => {
	// 1000 probes in 100s = 10/s against a 10/s ceiling. Raising concurrency here buys nothing.
	const ctx = await ready({ status: sweptAt(1000, 100) });
	const text = draw(ctx).textContent;
	assert.match(text, /10\.0\/s/);
	assert.match(text, /running at its configured ceiling/);
});

test('a sweep well UNDER its ceiling with no pushback names concurrency, not the rate', async () => {
	// 750 probes in 100s = 7.5/s against a 10/s ceiling, clean. The ceiling is never reached, so
	// it is inert — this is the case that would otherwise be diagnosed by hand.
	const ctx = await ready({ status: sweptAt(750, 100) });
	const text = draw(ctx).textContent;
	assert.match(text, /7\.5\/s/);
	assert.match(text, /never actually reached/);
	assert.match(text, /concurrency/);
	// 4 in flight ÷ 7.5/s = ~533ms per probe.
	assert.match(text, /533ms/);
});

test('low throughput WITH origin pushback is the backoff working, not a capacity ceiling', async () => {
	// The same 7.5/s, but the origin pushed back — attributing that to latency would send the
	// operator to raise concurrency against an origin already shedding load.
	const ctx = await ready({ status: sweptAt(750, 100, { throttled: 40, throttleLevel: 4 }) });
	const text = draw(ctx).textContent;
	assert.match(text, /backoff doing its job/);
	assert.doesNotMatch(text, /never actually reached/);
});

test('continuous mode says whether the cycle target is reachable, and at what concurrency', async () => {
	// 237k rows over an 8h target needs 8.23/s; the node sustains 7.5/s. Unreachable — and the
	// answer is concurrency 5, not a higher rate ceiling.
	const status = sweptAt(750, 100);
	const ctx = await ready({
		status: { ...status, sweep: { ...status.sweep, cycleTarget: 8 * HOUR, sliceSize: 237_000 } },
	});
	const text = draw(ctx).textContent;
	assert.match(text, /8\.2\/s/, 'the rate the target needs');
	assert.match(text, /5 \(from 4\)/, 'the concurrency that would reach it');
});

test('a reachable cycle target is not dressed up as a problem', async () => {
	// The same node against a 12h target needs 5.5/s, comfortably inside 7.5/s.
	const status = sweptAt(750, 100);
	const ctx = await ready({
		status: { ...status, sweep: { ...status.sweep, cycleTarget: 12 * HOUR, sliceSize: 237_000 } },
	});
	const text = draw(ctx).textContent;
	assert.match(text, /5\.5\/s/);
	assert.doesNotMatch(text, /Concurrency that would reach it/);
});

test('under cluster scope the panel refuses rather than averaging four nodes into a fiction', async () => {
	// A rate is one node's property: its own slice, its own duration, its own origin latency.
	const status = sweptAt(750, 100);
	const ctx = await ready({
		status: {
			...status,
			sources: { mode: 'merged', answered: 4, configured: 4, complete: true, nodes: [] },
		},
	});
	const text = draw(ctx).textContent;
	assert.match(text, /Switch to a node/);
	assert.doesNotMatch(text, /Implied per-probe latency/);
});

test('the local governor is reported apart from the origin one — the fixes point opposite ways', async () => {
	const ctx = await ready({
		status: sweptAt(750, 100, { loadThrottleLevel: 4, loopLagMs: 180 }),
	});
	const text = draw(ctx).textContent;
	assert.match(text, /local load/);
	assert.match(text, /event loop 180ms behind/);
});
