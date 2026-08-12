import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The metric catalog (`src/metrics.js`).
 *
 * What these tests defend is a CONTRACT WITH DASHBOARDS, which no other test can see: a metric's
 * name and the order of its three dimension slots are what every panel, alert, and ad-hoc
 * get_analytics query keys on, and nothing about renaming a dimension or swapping two arguments
 * makes the plugin misbehave locally. So:
 *
 *   - every emitter passes (value, metric, path, method, type) in the order the catalog documents;
 *   - the catalog and the emitters describe the SAME set of metrics, so the doc surface and
 *     `GET /prerender_admin/metrics` cannot silently omit a metric that is being emitted;
 *   - no module outside `src/metrics.js` calls `server.recordAnalytics` directly, which is what
 *     keeps the catalog authoritative rather than aspirational;
 *   - every documented dimension-value enumeration a metric declares stays a closed set, because
 *     cardinality here is a storage cost paid per node, per flush, forever.
 */

const analytics = [];
globalThis.server = { hostname: 'test-node', recordAnalytics: (...args) => analytics.push(args) };

const { METRICS, BUILT_IN_METRICS, describeMetrics, metrics } = await import('../src/metrics.js');

const SRC = new URL('../src/', import.meta.url).pathname;

beforeEach(() => {
	analytics.length = 0;
});

/** The single emission the callback produced, as { value, metric, path, method, type }. */
const emitted = (fn) => {
	analytics.length = 0;
	fn();
	assert.equal(analytics.length, 1, 'expected exactly one recordAnalytics call');
	const [value, metric, path, method, type] = analytics[0];
	return { value, metric, path, method, type };
};

test('every catalog entry is well formed', () => {
	for (const [key, m] of Object.entries(METRICS)) {
		assert.equal(key, m.name, 'the catalog key is the metric name');
		assert.ok(['counter', 'value'].includes(m.kind), `${key}: kind`);
		assert.ok(m.summary && m.usefulFor, `${key}: needs a summary and a usefulFor`);
		assert.ok(m.emittedBy && m.cadence, `${key}: needs an emittedBy and a cadence`);
		// Exactly three slots, always all three, so a reader never has to wonder whether an absent
		// key means "unused" or "undocumented".
		assert.deepEqual(Object.keys(m.dimensions), ['path', 'method', 'type'], `${key}: dimension slots`);
		for (const [slot, d] of Object.entries(m.dimensions)) {
			assert.ok('name' in d && 'description' in d, `${key}.${slot}: needs a name and a description`);
			if (d.values) assert.ok(Array.isArray(d.values) && d.values.length, `${key}.${slot}: values`);
		}
	}
});

test('counters carry no unit and value metrics that measure time are in ms', () => {
	for (const [key, m] of Object.entries(METRICS)) {
		if (m.kind === 'counter') assert.equal(m.unit, undefined, `${key}: a counter has no unit`);
		if (key.endsWith('_time') || key.endsWith('page_age')) assert.equal(m.unit, 'ms', `${key}: unit`);
	}
});

test('bot_request emits (host, botName, deviceType) as a counter', () => {
	const e = emitted(() => metrics.botRequest('example.com', 'Googlebot', 'mobile'));
	assert.deepEqual(e, { value: true, metric: 'bot_request', path: 'example.com', method: 'Googlebot', type: 'mobile' });
});

test('bot_serve emits (source, cacheStatus, botName) — not the route, which route_serve carries', () => {
	const e = emitted(() => metrics.botServe('cache', 'hit', 'Googlebot'));
	assert.deepEqual(e, { value: true, metric: 'bot_serve', path: 'cache', method: 'hit', type: 'Googlebot' });
});

test('route_serve emits (route, cacheStatus, deviceType)', () => {
	const e = emitted(() => metrics.routeServe('/catalog/', 'swr', 'desktop'));
	assert.deepEqual(e, { value: true, metric: 'route_serve', path: '/catalog/', method: 'swr', type: 'desktop' });
});

test('page_age emits the age FIRST, then (botName, deviceType)', () => {
	const e = emitted(() => metrics.pageAge(1234, 'Googlebot', 'mobile'));
	assert.deepEqual(e, { value: 1234, metric: 'page_age', path: 'Googlebot', method: 'mobile', type: undefined });
});

test('route_page_age emits the age FIRST, then (route, cacheStatus, deviceType)', () => {
	const e = emitted(() => metrics.routePageAge(1234, '/product/prd-', 'hit', 'mobile'));
	assert.deepEqual(e, {
		value: 1234,
		metric: 'route_page_age',
		path: '/product/prd-',
		method: 'hit',
		type: 'mobile',
	});
});

test('page_age_negative is a prerender_ops counter, not a sample of the negative age', () => {
	// A negative age must never reach a distribution — that is the whole point of the series.
	const e = emitted(() => metrics.pageAgeNegative('Googlebot', 'mobile'));
	assert.deepEqual(e, {
		value: true,
		metric: 'prerender_ops',
		path: 'page_age_negative',
		method: 'Googlebot',
		type: 'mobile',
	});
});

test('render carries both the duration and the outcome, so the render panel reads in ONE scan', () => {
	const t = emitted(() => metrics.renderTime(9600, 200, 'candidate'));
	assert.deepEqual(t, { value: 9600, metric: 'render', path: 'time_ms', method: 200, type: 'candidate' });
});

test('queue_health puts the series in the path slot; the ladder is a prerender_ops demand_* series', () => {
	const q = emitted(() => metrics.queueHealth(42, 'overdue'));
	assert.deepEqual([q.value, q.metric, q.path], [42, 'queue_health', 'overdue']);
	const d = emitted(() => metrics.demandLadder(0.03, 'fill'));
	assert.deepEqual([d.value, d.metric, d.path], [0.03, 'prerender_ops', 'demand_fill']);
});

test('every ladder series the emitter can produce is declared on prerender_ops', () => {
	const series = ['promoted', 'demoted', 'held', 'skipped_cold', 'single_rung', 'promoted_fast', 'fast', 'graded'];
	for (const s of [...series, 'fill']) {
		const e = emitted(() => metrics.demandLadder(1, s));
		assert.ok(METRICS.prerender_ops.dimensions.path.values.includes(e.path), `prerender_ops missing ${e.path}`);
	}
});

test('invalidation_reenqueue normalizes a missing scope to null rather than dropping the slot', () => {
	// `undefined` would omit the dimension entirely and split the series in two for the same
	// outcome; null keeps one row per outcome with an empty scope.
	const e = emitted(() => metrics.invalidationReenqueue('lowered', undefined));
	assert.deepEqual(e, {
		value: true,
		metric: 'prerender_ops',
		path: 'invalidation_reenqueue',
		method: 'lowered',
		type: null,
	});
});

test('invalidation_error is a prerender_ops series keyed by kind', () => {
	const e = emitted(() => metrics.invalidationError('lkg-expired'));
	assert.deepEqual(e, {
		value: true,
		metric: 'prerender_ops',
		path: 'invalidation_error',
		method: 'lkg-expired',
		type: null,
	});
});

test('render outcome emits (outcome, detail) into the render name and normalizes a missing detail', () => {
	const e = emitted(() => metrics.renderOutcome('suppressed', 'noindex'));
	assert.deepEqual(e, { value: true, metric: 'render', path: 'outcome', method: 'suppressed', type: 'noindex' });
	const bare = emitted(() => metrics.renderOutcome('rendered', undefined));
	assert.equal(bare.type, null);
});

test('render documents every outcome detail the emitters use', () => {
	// The emit sites are spread across two RenderQueue methods; this pins the catalog's closed
	// sets so a new branch cannot invent an undocumented dimension value.
	const details = METRICS.render.dimensions.type.values;
	for (const detail of ['stored', 'discarded', 'refiled', 'unspecified', 'landed-auth', 'temporary', 'permanent']) {
		assert.ok(details.includes(detail), `detail ${detail} undocumented`);
	}
	// And the time_ms candidacy labels ride the same slot.
	for (const candidacy of ['candidate', 'non-candidate', 'unknown', 'redirect']) {
		assert.ok(details.includes(candidacy), `candidacy ${candidacy} undocumented`);
	}
});

test('claim_scan rides queue_health so the queue reads in ONE get_analytics scan', () => {
	// A metric name is a window scan on the read side (metric is unindexed in hdb_analytics);
	// a series is just rows in an existing scan. These pins are the consolidation contract.
	const c = emitted(() => metrics.claimScan(3.2, 'granted'));
	assert.deepEqual(c, { value: 3.2, metric: 'queue_health', path: 'claim_scan_ms', method: 'granted', type: null });
});

test('origin_fetch keeps its own name (it needs both dimension slots) and emits the duration FIRST', () => {
	const o = emitted(() => metrics.originFetch(120, 200, 'miss'));
	assert.deepEqual(o, { value: 120, metric: 'origin_fetch', path: 200, method: 'miss', type: null });
});

test('unrouted is a prerender_ops series carrying (class, bucket), with the count as the VALUE', () => {
	const e = emitted(() => metrics.unrouted(17, 'unclassified', '/blog/*'));
	assert.deepEqual(e, {
		value: 17,
		metric: 'prerender_ops',
		path: 'unrouted',
		method: 'unclassified',
		type: '/blog/*',
	});
});

test('sitemap_run and config_warnings are prerender_ops series; reconcile is a queue_health series', () => {
	const s = emitted(() => metrics.sitemapRun(42, 'created'));
	assert.deepEqual([s.value, s.metric, s.path], [42, 'prerender_ops', 'sitemap_created']);
	const r = emitted(() => metrics.reconcile(3, 'restored'));
	assert.deepEqual([r.value, r.metric, r.path], [3, 'queue_health', 'reconcile_restored']);
	const c = emitted(() => metrics.configWarnings(2));
	assert.deepEqual([c.value, c.metric, c.path], [2, 'prerender_ops', 'config_warnings']);
});

test('serve_error is a prerender_ops counter keyed by kind', () => {
	const e = emitted(() => metrics.serveError('blob-stream'));
	assert.deepEqual(e, { value: true, metric: 'prerender_ops', path: 'serve_error', method: 'blob-stream', type: null });
});

test('every series the consolidated emitters produce is declared in its catalog entry', () => {
	// The series values are built at the emit site (e.g. `sitemap_${series}`), so this is what
	// keeps a new call from minting an undocumented series.
	const qh = METRICS.queue_health.dimensions.path.values;
	for (const series of ['claim_scan_ms', 'reconcile_restored', 'reconcile_missing']) {
		assert.ok(qh.includes(series), `queue_health missing ${series}`);
	}
	const ops = METRICS.prerender_ops.dimensions.path.values;
	for (const series of [
		'unrouted',
		'serve_error',
		'config_warnings',
		'sitemap_sitemaps',
		'sitemap_created',
		'sitemap_updated',
		'sitemap_skipped',
		'sitemap_removed',
		'sitemap_failed',
	]) {
		assert.ok(ops.includes(series), `prerender_ops missing ${series}`);
	}
});

test('every emitter emits a metric the catalog documents, and every catalog entry has an emitter', () => {
	const emittedNames = new Set();
	for (const emit of Object.values(metrics)) {
		analytics.length = 0;
		// Arity-agnostic: extra arguments are harmless, and what is asserted is only the NAME.
		emit('a', 'b', 'c', 'd');
		assert.equal(analytics.length, 1);
		emittedNames.add(analytics[0][1]);
	}
	assert.deepEqual([...emittedNames].sort(), Object.keys(METRICS).sort());
});

test('no module outside src/metrics.js calls server.recordAnalytics directly', async () => {
	const offenders = [];
	const walk = async (dir) => {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(path);
			} else if (entry.name.endsWith('.js') && path !== join(SRC, 'metrics.js')) {
				if (/\brecordAnalytics\s*\(/.test(await readFile(path, 'utf8'))) offenders.push(path.slice(SRC.length));
			}
		}
	};
	await walk(SRC);
	assert.deepEqual(offenders, [], 'route new metrics through src/metrics.js so the catalog stays authoritative');
});

test('METRICS.md documents exactly the metrics that exist', async () => {
	// The doc is the human entry point and the catalog is the source of truth; this is what keeps
	// "added a metric, forgot the doc" — and its inverse, a doc row for a metric nobody emits —
	// from shipping.
	//
	// CHECKED AGAINST THE TABLE ROWS, not "is the name mentioned somewhere". The metric tables are
	// the doc's authoritative list, so a row is what "documented" has to mean; a passing mention in
	// prose is not. Scanning prose instead would also be unable to tell a metric name from the
	// dozen other snake_case tokens the doc legitimately contains — Harper operation names
	// (`get_analytics`, `list_metrics`, `describe_table`), dimension VALUES (`below_floor`,
	// `fast_fraction`, `skipped_cold`), and the deliberately-not-yet-emitted names proposed in the
	// gaps section (`render_outcome`, `claim_scan`, `origin_fetch`) — each of which a
	// prose-wide check would flag as an unknown metric.
	//
	// The first cell of a metric row is a backticked name and nothing else, which is what the
	// pattern keys on: the other tables' first cells carry spaces, capitals or dots
	// (`GET overview`, `render_service.Target`) and so never match.
	const doc = await readFile(new URL('../METRICS.md', import.meta.url), 'utf8');
	const documented = [...doc.matchAll(/^\|\s*`([a-z0-9_<>-]+)`\s*\|/gm)].map(([, name]) => name);

	const known = new Set([...Object.keys(METRICS), ...Object.keys(BUILT_IN_METRICS)]);
	for (const name of documented) {
		assert.ok(known.has(name), `METRICS.md has a table row for \`${name}\`, which no catalog entry declares`);
	}
	// Every direction, and every metric — a typo anywhere in a name fails one side or the other.
	for (const name of known) {
		assert.ok(documented.includes(name), `METRICS.md has no table row for \`${name}\``);
	}
});

test('describeMetrics is JSON-serializable and covers both the plugin and the built-in metrics', () => {
	const described = describeMetrics();
	assert.deepEqual(
		described.plugin.map((m) => m.name),
		Object.keys(METRICS)
	);
	assert.deepEqual(
		described.builtIn.map((m) => m.name),
		Object.keys(BUILT_IN_METRICS)
	);
	// The admin route serves this verbatim, so a non-serializable value would 500 the panel.
	assert.deepEqual(JSON.parse(JSON.stringify(described)).plugin.length, described.plugin.length);
	// Mutating the description must not reach the frozen catalog.
	described.plugin[0].summary = 'mutated';
	assert.notEqual(Object.values(METRICS)[0].summary, 'mutated');
});
