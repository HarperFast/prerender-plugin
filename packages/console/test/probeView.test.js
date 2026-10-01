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
 *   - The pass counters are per EMIT (a probed batch from plugin v0.97.0, a finished pass
 *     before), so `count` is emits and the recorded value is what that batch or pass counted.
 *     Summing counts answers "how many emits", with a plausible number.
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
const { load, render, meta } = await import('../src/admin/views/probe.js');
const { mergerFor } = await import('../src/util/aggregate.js');

/**
 * A cluster status exactly as the console server builds it: every node's own payload through the
 * real merge. Hand-built merged fixtures drift from what the merge produces — that drift is how the
 * cluster view lost `mode` and the anchored schedule without a test noticing.
 */
const clusterOf = (...nodes) =>
	mergerFor('change-probe')(
		nodes.map(([hostname, body]) => ({
			origin: `https://${hostname}`,
			hostname,
			ok: true,
			status: 200,
			body: { ...body, node: hostname },
		}))
	).body;

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
	// `let`, so a test can do what the shell does on a node-scope switch: replace every scratch.
	let views = {};
	let current = 'probe';
	const scratch = (id) => (views[id] ??= {});
	const calls = { gets: [], posts: [], renders: 0, reloads: 0 };
	return {
		calls,
		scratch,
		busy: false,
		// The shell's global range (top bar).
		rangeMs: 24 * HOUR,
		// Like the shell's: the CURRENT view's scratch, whatever view that is when this is read.
		get data() {
			return scratch(current);
		},
		resetScope() {
			views = {};
		},
		navigate(id) {
			current = id;
		},
		async get(route, query) {
			calls.gets.push({ route, query });
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

test('re-baselined rows leave the compared denominator, so a rule edit cannot read as a static origin', async () => {
	// The pass right after a rule edit: the plugin re-baselines every row it could not compare —
	// stored under a different rule fingerprint — so almost nothing was actually compared. Counting
	// those as compared reports "0% changed" over a population nothing looked at, which is exactly
	// how a completely static catalogue reads.
	const analytics = {
		...ANALYTICS,
		series: [
			passes('probed', 4, 1000),
			passes('seeded', 4, 50),
			passes('rebaselined', 4, 900),
			passes('failed', 4, 10),
			passes('changed', 4, 4),
		],
	};
	const ctx = await ready({ analytics });
	const changed = tile(ctx, 'Changed');
	// 4,000 probed − 200 seeded − 3,600 re-baselined − 40 failed = 160 compared, and 16 changed.
	assert.match(changed.textContent, /of 160 compared/);
	assert.match(changed.textContent, /10%/);
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
	assert.match(text, /per batch/);
	assert.match(text, /once per FINISHED\s+pass/);
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
	const ctx = await ready({ status: clusterOf(['node-a', STATUS], ['node-b', STATUS]) });
	const sweep = button(ctx, 'Sweep (pick a node)');
	assert.ok(sweep, 'expected the button to name the scope problem rather than being silently inert');
	assert.equal(sweep.attributes.disabled, '');
	assert.match(sweep.attributes.title, /that node’s probe rate/);
});

test('a disabled probe names the nodes it is off on — their slice is simply absent from every total', async () => {
	// Some nodes on, some off: the cluster case. The finding is the nodes that are off.
	const ctx = await ready({
		status: clusterOf(
			['node-a', STATUS],
			['node-b', STATUS],
			['node-c', { ...STATUS, enabled: false }],
			['node-d', { ...STATUS, enabled: false }]
		),
	});
	const text = draw(ctx).textContent;
	assert.match(text, /is false on node-c, node-d/);
	assert.match(text, /never probed/);
	// Off everywhere is a state, not a per-node finding.
	const off = await ready({ status: { ...STATUS, enabled: false } });
	assert.match(draw(off).textContent, /changeProbe\.enabled is false\. Nothing is probed/);
});

test('an enabled probe with no rules says no timer is armed rather than showing an idle sweep', async () => {
	const ctx = await ready({
		status: { ...STATUS, rules: [], sweep: { running: false, armedInterval: null, lastRun: null } },
	});
	assert.match(draw(ctx).textContent, /no timer is armed/);
});

test('an unswept node is named, because it contributes zero to every figure above', async () => {
	const ctx = await ready({
		status: clusterOf(
			['node-a', STATUS],
			['node-b', { ...STATUS, sweep: { ...STATUS.sweep, lastRun: null } }],
			['node-c', STATUS]
		),
	});
	const text = draw(ctx).textContent;
	assert.match(text, /No sweep has finished on node-b/);
	// The sum says how many nodes it covers — two here, not three.
	assert.match(text, /Σ 2 nodes/);
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
	// An error and a full set of counters arrive together whenever the cluster is partly healthy.
	// Showing only the error was dropping three good slices; showing only the counters hid that a
	// quarter of the keyspace was missed.
	const broken = { node: 'node-d', startedAt: 1000, finishedAt: 2000, error: 'read transaction expired' };
	const ctx = await ready({
		status: clusterOf(
			['node-a', STATUS],
			['node-b', STATUS],
			['node-c', STATUS],
			['node-d', { ...STATUS, sweep: { ...STATUS.sweep, lastRun: broken } }]
		),
	});
	const text = draw(ctx).textContent;
	assert.match(text, /Last sweep failed on node-d: read transaction expired/);
	assert.match(text, /only the passes that did finish/);
	assert.match(text, /Rows examined/);
	assert.match(text, /Σ 3 nodes/, 'the three good slices are still there, and the sum says it is three');
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

// Since plugin v0.97.0 a pass skips only rows it (or the pass it resumes) already probed, so a large
// skip share is resumes re-walking ground — a node restarting mid-pass. The old advice (tune
// `reprobeAfter`, an option since retired) must not be given.
test('a sustained skip share is explained as resumed passes re-walking ground, not as a reprobeAfter overlap', async () => {
	const ctx = await ready({
		analytics: { ...ANALYTICS, series: [...ANALYTICS.series, passes('fresh', 4, 5000)] },
	});
	const text = draw(ctx).textContent;
	assert.match(text, /skipped as already probed/);
	assert.match(text, /restarting mid-pass/);
	assert.doesNotMatch(text, /reprobeAfter/);
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

// ---- the shared state row (plugin v0.62.0) -------------------------------------

test('an unreadable state row is the loudest thing on the page — the node is unknown, not idle', async () => {
	const ctx = await ready({ status: { ...STATUS, stateAvailable: false } });
	const text = draw(ctx).textContent;
	assert.match(text, /state row could not be read on node-a/);
	assert.match(text, /unknown, not idle/);
});

test('a cluster merge names the nodes whose state was unreadable, and flags them in the node table', async () => {
	const ctx = await ready({
		status: clusterOf(
			['node-a', { ...STATUS, stateAvailable: true }],
			['node-b', { ...STATUS, stateAvailable: false, sweep: { running: false, armedInterval: null, lastRun: null } }]
		),
	});
	const text = draw(ctx).textContent;
	assert.match(text, /could not be read on node-b/);
	assert.match(text, /state unreadable/);
});

test('a plugin without the state row is not accused of one it cannot read', async () => {
	const ctx = await ready();
	assert.doesNotMatch(draw(ctx).textContent, /could not be read/);
});

test('a running sweep says how far it has got, at node scope and summed under the cluster merge', async () => {
	// An OLDER plugin (no statusVersion): rows walked is all a running pass publishes.
	const running = (examinedApprox) => ({
		...STATUS,
		sweep: { ...STATUS.sweep, running: true, progress: { examinedApprox } },
	});
	const node = await ready({ status: running(24_000) });
	assert.match(draw(node).textContent, /Sweeping · ~24,000 rows examined/);

	const cluster = await ready({ status: clusterOf(['node-a', running(10_000)], ['node-b', running(4000)]) });
	const text = draw(cluster).textContent;
	// Disjoint slices, so the summary sums; the node table keeps each node's own count.
	assert.match(text, /Sweeping on all 2 nodes · ~14,000 rows examined across them/);
	assert.match(text, /~10,000 rows examined/);
	assert.match(text, /~4,000 rows examined/);
});

test('a running sweep with no heartbeat count yet still reads as running, without a made-up number', async () => {
	const ctx = await ready({ status: { ...STATUS, sweep: { ...STATUS.sweep, running: true, progress: null } } });
	const text = draw(ctx).textContent;
	assert.match(text, /Sweeping/);
	assert.match(text, /no heartbeat count yet/);
	assert.doesNotMatch(text, /rows examined/);
});

// ---- what the probe is doing NOW (console v0.16.0) -----------------------------------------------

/**
 * The redesign's contract, executed against the view: the running pass and the last pass that ended
 * are never shown as one; every time says how old it is; a node on an older plugin says which
 * numbers it cannot report instead of showing them as zero; and the health flags need no reading
 * between the lines. `now` here is the real clock, because the view ages everything against the
 * node's clock carried forward from when the status was read.
 */
import { readFileSync } from 'node:fs';

const LIVE = JSON.parse(readFileSync(new URL('./fixtures/change-probe-live-0.83.0.json', import.meta.url)));

/** Shift every epoch-ms `…At` field so a captured payload reads as just captured. */
const rebase = (value, shift) => {
	if (Array.isArray(value)) return value.map((v) => rebase(v, shift));
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([k, v]) => [
				k,
				typeof v === 'number' && /At$/.test(k) && v > 1e12 ? v + shift : rebase(v, shift),
			])
		);
	}
	return value;
};

/** The live 0.83.0 capture as a cluster status, plus the config the console would have loaded. */
const liveCluster = () => {
	const shift = Date.now() - LIVE.capturedAt;
	return clusterOf(...LIVE.nodes.map(({ hostname, body }) => [hostname, rebase(body, shift)]));
};
const liveConfig = () => {
	const flat = [];
	const walk = (value, path) => {
		if (value && typeof value === 'object' && !Array.isArray(value) && path !== 'changeProbe.rules') {
			for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
		} else flat.push({ path, effective: value });
	};
	walk(LIVE.config.changeProbe, 'changeProbe');
	const children = {};
	for (const { path } of flat) {
		const parts = path.split('.').slice(1);
		let node = children;
		for (const [i, part] of parts.entries()) {
			if (i === parts.length - 1) node[part] = { kind: 'option' };
			else node = (node[part] ??= { children: {} }).children;
		}
	}
	return { schema: { children: { changeProbe: { children } } }, layers: flat };
};

const v2Settings = {
	mode: 'anchored',
	anchorTime: '00:05',
	anchorTimezone: 'America/Chicago',
	anchorWindow: 0,
	ratePerSecond: 10,
	concurrency: 4,
	scope: 'all',
	// No reprobeAfter: plugin v0.97.0 retired it and stopped reporting it.
	trigger: { concurrency: 8 },
	canary: { interval: 30 * 60_000, count: 500, threshold: 0.7, minSample: 50 },
};

/** A plugin v0.94.0 payload; `running` puts it four hours into tonight's anchored pass. */
const v2Body = ({ running = false, over = {} } = {}) => {
	const now = Date.now();
	return {
		...STATUS,
		statusVersion: 2,
		serverTime: now,
		dryRun: false,
		mode: 'anchored',
		settings: v2Settings,
		heartbeat: { intervalMs: 30_000, staleAfterMs: 300_000 },
		stateAvailable: true,
		stateUpdatedAt: now - 20_000,
		rules: [
			{
				...STATUS.rules[0],
				fingerprint: '3fa1c29e',
				extract: ['product.price.sale', 'product.status'],
				endpoint: { method: 'GET', path: '/api/product/$1' },
			},
		],
		...over,
		sweep: {
			running,
			current: running
				? {
						startedAt: now - 4 * HOUR,
						heartbeatAt: now - 20_000,
						stale: false,
						startedBy: 'anchor',
						reseed: false,
						originStartedAt: now - 4 * HOUR,
						dryRun: false,
						label: null,
						phase: 'walking',
						sliceEstimate: 4000,
					}
				: null,
			progress: running
				? {
						examinedApprox: 20_000,
						examined: 20_111,
						owned: 5000,
						matched: 2000,
						probed: 1999,
						changed: 77,
						unchanged: 1800,
						seeded: 20,
						failed: 2,
						throttled: 0,
						triggered: 66,
						errors: 0,
						actionsInFlight: 3,
						actionWaitMs: 0,
						cursor: 'https://www.example.com/product/m',
						throttleLevel: 1,
						recentRate: 9.8,
						phase: 'walking',
					}
				: null,
			lastRun: {
				...STATUS.sweep.lastRun,
				dryRun: false,
				startedBy: 'anchor',
				resumedFrom: null,
				resumeCursor: null,
				changed: 240,
				// A healthy pass: STATUS's own record carries a 10% failure share.
				failed: 40,
				maxActionsInFlight: 8,
				actionWaitMs: 0,
				startedAt: now - 20 * HOUR,
				finishedAt: now - 11 * HOUR,
				slotChanges: { price: { 0: 200, 1: 60 } },
				fieldMismatch: { price: { '0:price': 9 } },
				fieldGuard: { price: { '0:price': { witnessed: 300, disagreed: 4, armed: true } } },
			},
			armedInterval: 'anchored:00:05|America/Chicago',
			nextAnchoredRunAt: new Date(now + 5 * HOUR).toISOString(),
			nextRunAt: now + 5 * HOUR,
			nextRunBasis: 'anchor',
			...over.sweep,
		},
		canary: { ...STATUS.canary, lastRun: null, nextRunAt: now + 10 * 60_000, ...over.canary },
	};
};

const isCard = (n) =>
	String(n.attributes?.class ?? '')
		.split(/\s+/)
		.includes('card');
const cardTitled = (ctx, pattern) =>
	find(draw(ctx), (n) => isCard(n) && pattern.test(n.children[0]?.textContent ?? ''));
/** The text of every help block in a tree — the explanations now sit behind "?" toggles. */
const helpText = (node) => {
	const out = [];
	find(node, (n) => {
		if (n.attributes?.class === 'help') out.push(n.textContent);
		return false;
	});
	return out.join('\n');
};

test('mid-pass: the running pass has its own card, and the last completed pass is labelled as the one BEFORE it', async () => {
	const ctx = await ready({
		status: clusterOf(['node-a', v2Body({ running: true })], ['node-b', v2Body({ running: true })]),
	});
	const current = cardTitled(ctx, /^Current pass — in progress/);
	assert.ok(current, 'the running pass is shown as itself');
	assert.match(current.textContent, /partial counts, so far/);
	assert.match(current.textContent, /the daily anchor/, 'who started it');
	assert.match(current.textContent, /Changed.*77/s, 'its own changed count');
	assert.doesNotMatch(current.textContent, /\b240\b/, 'and never the previous pass’s');

	const last = cardTitled(ctx, /^Last completed sweep — the pass BEFORE the one running now/);
	assert.ok(last, 'the previous pass cannot be read as the running one');
	assert.match(last.textContent, /previous pass — not the running one/);
	assert.match(last.textContent, /Changed.*240/s);

	const now = cardTitled(ctx, /^Probe now/);
	assert.match(now.textContent, /Sweeping on all 2 nodes · ~50% through · last node done ~/);
	assert.match(now.textContent, /2,000 of ~4,000 matched \(50%\)/);
	assert.match(now.textContent, /9\.8\/s now/);
	assert.match(now.textContent, /since \d\d:\d\d UTC \(4h ago\)/);
});

test('idle anchored node: the state line is the next run, in local and UTC time, with how long until it', async () => {
	const ctx = await ready({ status: v2Body() });
	const text = cardTitled(ctx, /^Probe now/).textContent;
	assert.match(text, /Idle · next sweep .* local · \d\d:\d\d UTC \(in 5h\)/);
	assert.match(text, /by the daily anchor/);
	assert.match(text, /last sweep ended 11h ago/);
	assert.match(text, /No health flags/);
	assert.equal(cardTitled(ctx, /^Current pass/), null, 'nothing is running, so there is no current-pass card');
	// Not the "pass BEFORE the one running now" variant: nothing is running.
	assert.match(cardTitled(ctx, /^Last completed sweep(?! —)/).textContent, /complete/);
});

test('older plugin (live 0.83.0 capture): armed and anchored, next run computed, missing counters n/a — not zero', async () => {
	const ctx = await ready({ status: liveCluster(), config: liveConfig() });
	const tree = draw(ctx);
	const text = tree.textContent;
	// The cluster view used to say "not armed" here: the merge dropped the anchored marker.
	assert.match(text, /daily at 00:05 America\/Chicago/);
	assert.doesNotMatch(text, /not armed/);
	assert.match(text, /Idle on all 4 nodes · next sweep .*05:05 UTC/);
	assert.match(text, /computed here from the anchor setting \(plugin < 0\.91\.0\)/);
	assert.match(text, /run a plugin older than 0\.91\.0/);
	// A counter the plugin predates is n/a with the version that added it — and never a 0.
	const extendedRow = find(tree, (n) => n.tagName === 'TR' && /Compared on appended paths/.test(n.textContent));
	assert.ok(extendedRow);
	assert.match(extendedRow.textContent, /n\/a/);
	assert.doesNotMatch(extendedRow.textContent, /\b0\b/);
	assert.ok(find(extendedRow, (n) => /added in 0\.86\.0/.test(n.attributes?.title ?? '')));
	assert.match(text, /Where the origin changed — per extract slot \(not reported\)/);
	// The flags are exactly what is there.
	assert.match(text, /Unreadable registry rows\./);
	assert.match(text, /Origin pushback \(trace\)\./);
	assert.doesNotMatch(text, /Probe failures/);
});

test('stale heartbeat while running is flagged; a pass whose heartbeat stopped reads as stalled', async () => {
	const late = v2Body({ running: true });
	late.sweep.current.heartbeatAt = Date.now() - 3 * 60_000;
	const lateText = draw(await ready({ status: late })).textContent;
	assert.match(lateText, /heartbeat late/);
	assert.match(lateText, /Heartbeat late\. The running sweep’s heartbeat is late/);

	const dead = v2Body({ running: true });
	dead.sweep.running = false;
	dead.sweep.current = { ...dead.sweep.current, heartbeatAt: Date.now() - 12 * 60_000, stale: true };
	const deadText = draw(await ready({ status: dead })).textContent;
	assert.match(deadText, /stalled/);
	assert.match(deadText, /heartbeat stopped/);
	assert.match(deadText, /presumed dead/);
	assert.doesNotMatch(deadText, /Idle/);
});

test('each health flag reaches the page with the nodes it holds on', async () => {
	const now = Date.now();
	const sick = v2Body({
		running: true,
		over: {
			sweep: {
				nextRunAt: now - 10 * 60_000, // the anchor passed while this pass was running
			},
		},
	});
	Object.assign(sick.sweep.progress, { throttleLevel: 8 });
	Object.assign(sick.sweep.lastRun, {
		probed: 1000,
		failed: 700,
		rebaselined: 200,
		errors: 12,
		unreadable: 3,
		fieldGuard: { price: { '0:price': { witnessed: 300, disagreed: 280, armed: false } } },
	});
	const text = draw(await ready({ status: clusterOf(['node-a', sick], ['node-b', v2Body()]) })).textContent;
	for (const title of [
		'Probe failures dominate.',
		'Backoff engaged.',
		'Rule edit re-baselined rows.',
		'Actions failed.',
		'Unreadable registry rows.',
		'Mapped field disarmed.',
		'Overran the anchor.',
	]) {
		assert.ok(text.includes(title), `expected the "${title}" flag`);
	}
	assert.match(text, /node-a: price 0:price/);
	assert.match(text, /node-a \(last sweep\): 12 failed of 232/);
	assert.match(text, /Health — \d+ faults?, \d+ warnings?/);
});

test('nodes disagreeing on mode or rules are flagged at the top, not left for the config view', async () => {
	const other = v2Body({ over: { mode: 'continuous' } });
	other.rules = [{ ...other.rules[0], fingerprint: 'deadbeef' }];
	const text = draw(await ready({ status: clusterOf(['node-a', v2Body()], ['node-b', other]) })).textContent;
	assert.match(
		text,
		/Modes differ between nodes\. The nodes run different sweep modes: node-a anchored, node-b continuous/
	);
	assert.match(text, /Rules differ between nodes\./);
});

test('the configuration card names the rule’s endpoint and fingerprint, and marks a setting that differs', async () => {
	const other = v2Body({ over: { settings: { ...v2Settings, ratePerSecond: 5 } } });
	const ctx = await ready({ status: clusterOf(['node-a', v2Body()], ['node-b', other]) });
	const text = cardTitled(ctx, /^Configuration/).textContent;
	assert.match(text, /GET \/api\/product\/\$1/);
	assert.match(text, /3fa1c29e/);
	assert.match(text, /Rate ceilingdiffers/);
	assert.match(text, /10\/s.*5\/s/s);
});

test('detail on demand: per-slot changes carry the extract path, per-field mismatches and the guard', async () => {
	const ctx = await ready({ status: v2Body() });
	const last = cardTitled(ctx, /^Last completed sweep/);
	const slotRow = find(
		last,
		(n) => n.tagName === 'TR' && /product\.price\.sale/.test(n.textContent) && /200/.test(n.textContent)
	);
	assert.ok(slotRow, 'slot 0 → its extract path, with its count');
	assert.match(last.textContent, /Page fields that disagreed with the origin/);
	assert.match(last.textContent, /0:price/);
	assert.match(last.textContent, /Mapping guard/);
});

test('the pass charts say they are counts, not a live gauge — and draw what a change produced', async () => {
	const ctx = await ready();
	const card = cardTitled(ctx, /^Probe passes/);
	assert.ok(card);
	assert.match(card.textContent, /counts, not a live gauge/);
	// The long "why" sits behind the card's help toggle — present, not on the page by default.
	assert.match(helpText(card), /NOT A LIVE GAUGE/);
	assert.match(helpText(card), /per probed batch/);
	assert.doesNotMatch(helpText(card), /bars are passes/);
	assert.match(helpText(card), /Throttled is inside Failed/);
	const acted = tile(ctx, 'Acted on');
	assert.match(acted.textContent, /220/, 'Σ over 4 passes of 55');
	assert.match(acted.textContent, /pages expired, render filed ahead/);
});

test('a window from an older plugin: the series v0.94.0 removed draw no tile, legend entry or bar', async () => {
	// probe_deferred and probe_trigger_queue_depth are still in any window that reaches back past the
	// upgrade. There is nothing left to judge them against, so they are not drawn at all.
	const ctx = await ready({
		analytics: {
			...ANALYTICS,
			series: [...ANALYTICS.series, passes('deferred', 4, 5), passes('trigger_queue_depth', 4, 812)],
		},
	});
	const card = cardTitled(ctx, /^Probe passes/);
	assert.equal(tile(ctx, 'Trigger queue peak'), null);
	assert.doesNotMatch(card.textContent, /Deferred|deferred|queue peak|812/);
	assert.match(tile(ctx, 'Acted on').textContent, /220/);
});

// ---- plugin v0.94.0: a detected change is acted on when it is found ------------------------------

test('the running pass shows the actions it has in flight against trigger.concurrency, and its own acted-on count', async () => {
	const ctx = await ready({ status: v2Body({ running: true }) });
	const current = cardTitled(ctx, /^Current pass — in progress/);
	const row = (label) => find(current, (n) => n.tagName === 'TR' && n.children[0]?.textContent.startsWith(label));
	assert.match(row('Actions in flight').textContent, /3 of 8/);
	assert.match(row('Acted on').textContent, /66/);
	assert.equal(row('Action errors').children.at(-1).textContent, '0');
	assert.doesNotMatch(current.textContent, /Trigger queue|Queued|Deferred/);
});

test('draining: the walk is finished and the node table says what is left — no drain-rate ETA', async () => {
	const body = v2Body({ running: true });
	body.sweep.current.phase = 'draining';
	body.sweep.progress.phase = 'draining';
	const text = cardTitled(await ready({ status: body }), /^Probe now/).textContent;
	assert.match(text, /finishing actions/);
	assert.match(text, /walk finished/);
	assert.match(text, /finishing 3 actions in flight/);
	assert.doesNotMatch(text, /trigger queue|ETA unavailable/i);
});

test('the last pass reports what it acted on, what failed and the most actions it had in flight', async () => {
	const body = v2Body();
	Object.assign(body.sweep.lastRun, { triggered: 231, errors: 2 });
	const last = cardTitled(await ready({ status: body }), /^Last completed sweep/);
	const row = (label) => find(last, (n) => n.tagName === 'TR' && n.children[0]?.textContent.startsWith(label));
	assert.match(row('Acted on').textContent, /231/);
	assert.equal(row('Action errors').children.at(-1).textContent, '2');
	assert.match(row('Action errors').textContent, /retried next probe/);
	assert.match(row('Most actions in flight').textContent, /8 of 8/);
	assert.match(helpText(last), /Nothing is deferred/);
	assert.doesNotMatch(last.textContent, /Trigger queue|Queued re-renders|Deferred|NaN/);
});

test('a resumed pass says what it continues and where it walks from — marked, never flagged', async () => {
	const now = Date.now();
	const running = v2Body({ running: true });
	Object.assign(running.sweep.current, {
		startedBy: 'resume',
		startedAt: now - HOUR,
		originStartedAt: now - 22 * HOUR,
	});
	const ctx = await ready({ status: running });
	const live = cardTitled(ctx, /^Probe now/);
	assert.ok(find(live, (n) => n.attributes?.class === 'pill info' && n.textContent === 'resumed'));
	assert.match(live.textContent, /started by a restart \(resuming the interrupted pass\)/);
	assert.match(live.textContent, /continues the pass started (\w{3} \d+ \w{3} )?\d\d:\d\d UTC \(22h ago\)/);
	// It walks from a cursor, so a share of the whole slice would be wrong: none is claimed.
	assert.match(live.textContent, /resumed mid-slice, so no percentage/);
	assert.doesNotMatch(live.textContent, /% through|matched \(\d+%\)/);
	assert.doesNotMatch(live.textContent, /Resumed after a restart|counted as fresh/, 'no flag explaining a skip share');
	const current = cardTitled(ctx, /^Current pass/);
	const row = (label) => find(current, (n) => n.tagName === 'TR' && n.children[0]?.textContent.startsWith(label));
	assert.match(row('Continues').textContent, /the pass started/);
	const cursor = find(row('Resume point'), (n) => n.attributes?.title === 'https://www.example.com/product/m');
	assert.ok(cursor, 'the walk cursor, with the full key on hover');

	// A resumed reseed says so — it is a dry run, whatever resumed it.
	const reseed = v2Body({ running: true });
	Object.assign(reseed.sweep.current, {
		startedBy: 'resume',
		originStartedAt: now - 2 * HOUR,
		reseed: true,
		dryRun: true,
	});
	assert.match(
		cardTitled(await ready({ status: reseed }), /^Probe now/).textContent,
		/continues the reseed \(a dry run\) started/
	);

	const done = v2Body();
	Object.assign(done.sweep.lastRun, {
		startedBy: 'resume',
		resumedFrom: now - 22 * HOUR,
		resumeCursor: 'https://www.example.com/product/k',
	});
	const after = await ready({ status: done });
	const last = cardTitled(after, /^Last completed sweep/);
	assert.match(last.textContent, /resumed after a restart/);
	assert.match(last.textContent, /continues the pass started (\w{3} \d+ \w{3} )?\d\d:\d\d UTC/);
	assert.match(last.textContent, /from https:\/\/www\.example\.com\/product\/k/);
	assert.match(helpText(last), /walks from the cursor the interrupted one reached/);
	assert.match(cardTitled(after, /^Probe now/).textContent, /No health flags/);
});

test('backpressure: the time the walk waited for an action slot sits beside actions in flight, and warns past 10%', async () => {
	const running = v2Body({ running: true });
	const current = cardTitled(await ready({ status: running }), /^Current pass/);
	const waitRow = (card) =>
		find(card, (n) => n.tagName === 'TR' && n.children[0]?.textContent.startsWith('Waited for an action slot'));
	assert.match(waitRow(current).textContent, /0s · 0% of the pass/);

	// The last pass ran 9h and waited 2h of it: the actions, not the origin, set its pace.
	const bound = v2Body();
	bound.sweep.lastRun.actionWaitMs = 2 * HOUR;
	const ctx = await ready({ status: bound });
	const last = cardTitled(ctx, /^Last completed sweep/);
	assert.ok(
		find(waitRow(last), (n) => n.attributes?.class === 'pill warn' && /2h · 22% of the pass/.test(n.textContent))
	);
	const now = cardTitled(ctx, /^Probe now/).textContent;
	assert.match(now, /Paced by its actions\./);
	assert.match(now, /node-a \(last sweep\): waited 2h \(22% of the pass\)/);
});

test('pacing: an action-bound pass is not diagnosed as an origin-latency or concurrency limit', async () => {
	// 1,500 probes in 200s, well under the 10/s ceiling — but 80s of it was spent waiting on the actions.
	const text = draw(await ready({ status: sweptAt(1500, 200, { actionWaitMs: 80_000 }) })).textContent;
	assert.match(text, /Waited for an action slot1m · 40% of the pass/);
	assert.match(text, /acting on changes set its pace, not the origin or the probe concurrency/);
	assert.match(text, /changeProbe\.trigger\.concurrency/);
	assert.doesNotMatch(text, /never actually reached|Implied per-probe latency/);
	// Without the wait the same numbers are the concurrency diagnosis they always were.
	assert.match(
		draw(await ready({ status: sweptAt(1500, 200, { actionWaitMs: 0 }) })).textContent,
		/never actually reached/
	);
});

test('an older plugin (0.93-shaped payload): the removed fields are not shown and the new ones are left out, not n/a rows', async () => {
	// What a node on 0.91–0.93 sends: trigger-queue counters and settings, no actions in flight.
	const old = v2Body({ running: true, over: { settings: { ...v2Settings, maxTriggersPerSweep: 150_000 } } });
	old.settings.trigger = { maxPending: 50_000, ratePerSecond: 3, concurrency: 4 };
	Object.assign(old.sweep.progress, { queued: 70, deferred: 4, triggerQueueDepth: 46_000 });
	delete old.sweep.progress.actionsInFlight;
	delete old.sweep.progress.actionWaitMs;
	delete old.sweep.progress.cursor;
	delete old.sweep.progress.errors;
	Object.assign(old.sweep.lastRun, { queued: 230, deferred: 12, triggerQueueDepth: 49_000 });
	delete old.sweep.lastRun.maxActionsInFlight;
	delete old.sweep.lastRun.actionWaitMs;
	delete old.sweep.lastRun.resumedFrom;
	delete old.sweep.lastRun.resumeCursor;
	const ctx = await ready({ status: old });
	const text = draw(ctx).textContent;
	assert.doesNotMatch(text, /Trigger queue|Triggers per sweep|drains \d|Queued re-renders|Deferred|deferred past|NaN/);
	assert.equal(
		find(cardTitled(ctx, /^Current pass/), (n) => n.tagName === 'TR' && /Actions in flight/.test(n.textContent)),
		null,
		'no node reports it: the row is left out rather than drawn as n/a'
	);
	assert.equal(
		find(cardTitled(ctx, /^Last completed sweep/), (n) => n.tagName === 'TR' && /Most actions/.test(n.textContent)),
		null
	);
	for (const label of ['Waited for an action slot', 'Resume point', 'Continues']) {
		assert.equal(
			find(draw(ctx), (n) => n.tagName === 'TR' && n.children[0]?.textContent.startsWith(label)),
			null,
			`nor the ${label} row`
		);
	}
	// Its trigger.concurrency meant triggers in flight — the same bound, so it is shown as such.
	assert.match(cardTitled(ctx, /^Configuration/).textContent, /Actions in flightat most 4/);
	assert.doesNotMatch(text, /Changes deferred|Trigger queue near full/);
});

test('a cluster with one node on each side of v0.94.0 names the older node’s missing count instead of dropping it', async () => {
	const old = v2Body({ running: true });
	delete old.sweep.progress.actionsInFlight;
	delete old.sweep.lastRun.maxActionsInFlight;
	const ctx = await ready({ status: clusterOf(['node-a', v2Body({ running: true })], ['node-b', old]) });
	const current = cardTitled(ctx, /^Current pass/);
	const actions = find(current, (n) => n.tagName === 'TR' && /Actions in flight/.test(n.textContent));
	assert.match(actions.textContent, /3 of 8/);
	assert.ok(find(actions, (n) => n.textContent === 'n/a' && /plugin < 0\.94\.0/.test(n.attributes?.title ?? '')));
	const most = find(
		cardTitled(ctx, /^Last completed sweep/),
		(n) => n.tagName === 'TR' && /Most actions/.test(n.textContent)
	);
	assert.match(most.textContent, /8 of 8/);
	assert.match(most.textContent, /n\/a/);
});

test('the configuration card shows the actions-in-flight bound, not the removed trigger-queue settings', async () => {
	const text = cardTitled(await ready({ status: v2Body() }), /^Configuration/).textContent;
	assert.match(text, /Actions in flightat most 8/);
	assert.doesNotMatch(text, /Trigger queue|Triggers per sweep/);
});

test('auto-refresh re-reads ONLY the status, on a timer, and pausing it stops the timer', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const ctx = await ready({ status: v2Body() });
	const fetched = [];
	const get = ctx.get.bind(ctx);
	ctx.get = async (route, query) => {
		fetched.push(route);
		return get(route, query);
	};
	draw(ctx); // arms the timer
	t.mock.timers.tick(30_000);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(fetched, ['change-probe'], 'the analytics scan is not re-run by the timer');
	assert.equal(ctx.calls.renders, 1);

	ctx.data.autoRefresh = false;
	draw(ctx);
	t.mock.timers.tick(60_000);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(fetched, ['change-probe'], 'paused means paused');
	t.mock.timers.reset();
});

test('the status read time is on the page, so a stale screen can never pass for a live one', async () => {
	const text = draw(await ready({ status: v2Body() })).textContent;
	assert.match(text, /status read at .* \(\d+s ago\) · re-read every 30s/);
});

// ---- the redesign: shell-owned header and range, help toggles, scoped refresh (console v0.17) ----

test('the pass panel follows the GLOBAL range, and the view has no range picker of its own', async () => {
	const ctx = makeCtx();
	ctx.rangeMs = 6 * HOUR;
	await load(ctx);
	assert.equal(meta.ranged, true, 'the shell shows its range picker for this view');
	assert.equal(meta.crumb, undefined);
	assert.deepEqual(ctx.calls.gets.find((call) => call.route === 'analytics').query, { range: 6 * HOUR });
	assert.equal(ctx.data.rangeMs, undefined, 'no view-local range survives');
	const tree = draw(ctx);
	for (const label of ['1h', '6h', '24h']) {
		assert.equal(
			find(tree, (n) => n.tagName === 'BUTTON' && n.textContent === label),
			null,
			`no local ${label} button`
		);
	}
});

test('no view header or Refresh button — the shell owns both; the status line and auto-refresh stay', async () => {
	const tree = draw(await ready({ status: v2Body() }));
	assert.equal(
		find(tree, (n) => n.attributes?.class === 'view-head'),
		null
	);
	assert.equal(
		find(tree, (n) => n.tagName === 'BUTTON' && n.textContent === 'Refresh'),
		null
	);
	assert.ok(find(tree, (n) => n.tagName === 'BUTTON' && n.textContent === 'auto-refresh'));
	assert.ok(find(tree, (n) => n.tagName === 'BUTTON' && n.textContent === 'paused'));
});

test('settings sit in a collapsed section — opened when the status read failed, since the fix is there', async () => {
	const section = (tree) => find(tree, (n) => String(n.attributes?.class ?? '').startsWith('section'));
	const healthy = section(draw(await ready()));
	assert.equal(healthy.attributes.class, 'section', 'collapsed by default');
	const failed = section(draw(await ready({ status: null })));
	assert.equal(failed.attributes.class, 'section open');
});

test('the auto-refresh drops a read once the operator has navigated away or switched scope', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const settle = () => new Promise((resolve) => setImmediate(resolve));

	// Scope switched before the timer fired: nothing is fetched at all.
	const before = await ready({ status: v2Body() });
	draw(before);
	before.resetScope();
	t.mock.timers.tick(30_000);
	await settle();
	assert.equal(before.calls.gets.filter((call) => call.route === 'change-probe').length, 1, 'only the load read');
	assert.equal(before.calls.renders, 0);

	// Navigated away WHILE the read was in flight: the answer must not land in whatever is on screen.
	const during = await ready({ status: v2Body() });
	const probeScratch = during.data;
	const statusBefore = probeScratch.status;
	draw(during);
	const get = during.get.bind(during);
	during.get = async (route, query) => {
		during.navigate('queue');
		return get(route, query);
	};
	t.mock.timers.tick(30_000);
	await settle();
	assert.equal(during.calls.renders, 0, 'no redraw for a view that is not on screen');
	assert.equal(probeScratch.status, statusBefore, 'the probe scratch keeps its own status');
	assert.equal(during.scratch('queue').status, undefined, 'and the queue view is not written into');

	// Scope switched while in flight: the old scope's read is dropped, not written under the new scope.
	const switched = await ready({ status: v2Body() });
	draw(switched);
	const get2 = switched.get.bind(switched);
	switched.get = async (route, query) => {
		switched.resetScope();
		return get2(route, query);
	};
	t.mock.timers.tick(30_000);
	await settle();
	assert.equal(switched.calls.renders, 0);
	assert.equal(switched.data.status, undefined, 'the new scope’s scratch stays empty until its own load');
	t.mock.timers.reset();
});

test('the auto-refresh never overwrites a newer status a full load landed while it was in flight', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const ctx = await ready({ status: v2Body() });
	draw(ctx);
	const newer = { ...v2Body(), node: 'from-the-load' };
	const get = ctx.get.bind(ctx);
	ctx.get = async (route, query) => {
		// A reload finished first and stamped a fresher read.
		ctx.data.status = newer;
		ctx.data.fetchedAt = Date.now() + 60_000;
		return get(route, query);
	};
	t.mock.timers.tick(30_000);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(ctx.data.status, newer);
	assert.equal(ctx.calls.renders, 0);
	t.mock.timers.reset();
});

test('an opened detail block stays open across the rebuild the auto-refresh triggers', async () => {
	const ctx = await ready({ status: v2Body() });
	const summaryOf = (tree) =>
		find(tree, (n) => n.tagName === 'DETAILS' && /Where the origin changed/.test(n.children[0]?.textContent ?? ''));
	const first = summaryOf(draw(ctx));
	assert.equal(first.attributes.open, undefined, 'closed by default');
	first.open = true;
	first.fire('toggle');
	assert.equal(summaryOf(draw(ctx)).attributes.open, '', 'still open after a full re-render');
	const again = summaryOf(draw(ctx));
	again.open = false;
	again.fire('toggle');
	assert.equal(summaryOf(draw(ctx)).attributes.open, undefined);
});

test('explanations moved behind help keep their substance', async () => {
	const ctx = await ready({ status: clusterOf(['node-a', v2Body({ running: true })], ['node-b', v2Body()]) });
	const text = helpText(draw(ctx));
	assert.match(text, /RUNNING pass’s own counts/, 'current pass');
	assert.match(text, /not buckets/, 'the overlay rows are not a partition');
	assert.match(text, /threshold crossed against ONE node’s cohort/, 'canary');
	// Pacing is per node only, so it is read at node scope.
	assert.match(
		helpText(draw(await ready({ status: sweptAt(750, 100) }))),
		/min\(concurrency ÷ latency, ratePerSecond\)/
	);
	assert.equal(
		find(draw(ctx), (n) => n.attributes?.class === 'muted chart-note'),
		null,
		'no explanatory paragraph is left in a card body'
	);
});

// ---- the Change safety card (plugin v0.97.0 series) ----

/** A counted event: one emit per event, value 1, the detail on the method slot. */
const events = (series, detail, n) => ({ ...passes(series, n, 1), method: detail });

/** A duration: `n` samples whose median and p95 are as given, the bound on method and the rule on type. */
const lag = (bound, rule, n, medianMs, p95Ms) => ({
	...passes('detection_lag', n, medianMs),
	method: bound,
	type: rule,
	median: medianMs,
	p95: p95Ms,
});

/** A tile's VALUE line alone (its label and caption run into it in `textContent`). */
const valueOf = (ctx, label) => tile(ctx, label).children[1].textContent;

const SAFETY = {
	...ANALYTICS,
	series: [
		...ANALYTICS.series,
		passes('errors', 2, 3), // 2 batches with 3 action errors each = 6
		passes('caught_up', 4, 10),
		passes('covered', 1, 7),
		events('anchor', 'on_time', 3),
		events('anchor', 'skipped', 1),
		lag('pass', 'price', 100, 2 * HOUR, 6 * HOUR),
		lag('previous_pass', 'price', 100, 20 * HOUR, 30 * HOUR),
		events('render_mismatch', 'rechecked', 5),
		events('render_mismatch', 'confirmed', 2),
		events('render_mismatch', 'cleared', 3),
		events('render_mismatch', 'shed', 4),
	],
};

test('the Change safety card sums action errors by VALUE and flags them', async () => {
	const ctx = await ready({ analytics: SAFETY });
	assert.equal(valueOf(ctx, 'Action errors'), '6');
	assert.match(draw(ctx).textContent, /6 action error\(s\)/);
	assert.equal(valueOf(ctx, 'Caught up'), '40');
	assert.equal(valueOf(ctx, 'Covered'), '7');
});

test('the Change safety card reads anchor outcomes, and a skipped anchor is the warning', async () => {
	const ctx = await ready({ analytics: SAFETY });
	assert.match(tile(ctx, 'Anchored passes').textContent, /3 on time/);
	assert.equal(valueOf(ctx, 'Skipped anchors'), '1');
	assert.match(draw(ctx).textContent, /an anchored pass was skipped/);
});

test('the Change safety card reads detection lag as a duration and the render check by outcome', async () => {
	const ctx = await ready({ analytics: SAFETY });
	assert.match(tile(ctx, 'Detection lag').textContent, /2(\.0)?\s?h/);
	assert.match(tile(ctx, '…from the previous pass').textContent, /20(\.0)?\s?h/);
	assert.match(tile(ctx, 'Render check').textContent, /2 confirmed stale · 3 cleared/);
	assert.match(tile(ctx, 'Not re-probed').textContent, /4 shed/);
});

test('without the v0.97.0 series the Change safety card says so rather than showing zeros', async () => {
	const ctx = await ready();
	assert.match(draw(ctx).textContent, /No action, anchor, detection-lag or render-check series/);
});

// ---- the Serve-time checks card (plugin v0.98.0, prerender_ops serve_check) ----

/** A serve_check counter: one emit per decision, the outcome on method and the source on type. */
const serveCheckEvents = (outcome, source, n) => ({
	metric: 'prerender_ops',
	path: 'serve_check',
	method: outcome,
	type: source,
	count: n,
	total: n,
	counts: new Array(BUCKETS).fill(n / BUCKETS),
	mean: 1,
});

const SERVE_CHECKS = {
	...ANALYTICS,
	series: [
		...ANALYTICS.series,
		serveCheckEvents('queued', 'api', 120),
		serveCheckEvents('agree', 'api', 100),
		serveCheckEvents('mismatch', 'api', 6),
		serveCheckEvents('raw-mismatch', 'raw', 2),
		serveCheckEvents('shed', 'api', 3),
		serveCheckEvents('busy', 'api', 1),
		serveCheckEvents('failed', 'document', 4),
	],
};

test('the Serve-time checks card counts verdicts by outcome and names the source of each mismatch', async () => {
	const ctx = await ready({ analytics: SERVE_CHECKS });
	assert.equal(valueOf(ctx, 'Agreed'), '100');
	assert.match(tile(ctx, 'Agreed').textContent, /93% of decided/);
	assert.equal(valueOf(ctx, 'Mismatched'), '6');
	assert.equal(valueOf(ctx, 'Raw deleted'), '2');
	assert.equal(valueOf(ctx, 'Not asked'), '4');
	assert.equal(valueOf(ctx, 'Request failed'), '4');
	const text = draw(ctx).textContent;
	assert.match(text, /mismatch · api/);
	assert.match(text, /mismatch · raw/);
});

test('without the serve_check series and with the feature off, the card is not drawn', async () => {
	const ctx = await ready();
	assert.doesNotMatch(draw(ctx).textContent, /Serve-time checks/);
});
