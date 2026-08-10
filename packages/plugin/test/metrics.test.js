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

test('page_age_negative is a counter, not a sample of the negative age', () => {
	// A negative age must never reach a distribution — that is the whole point of the metric.
	const e = emitted(() => metrics.pageAgeNegative('Googlebot', 'mobile'));
	assert.equal(e.value, true);
	assert.deepEqual([e.metric, e.path, e.method], ['page_age_negative', 'Googlebot', 'mobile']);
});

test('render_time emits the duration FIRST, then (statusCode, candidacy)', () => {
	const e = emitted(() => metrics.renderTime(9600, 200, 'candidate'));
	assert.deepEqual(e, { value: 9600, metric: 'render_time', path: 200, method: 'candidate', type: undefined });
});

test('queue_health and demand_ladder put the gauge name in the path slot', () => {
	// One metric with a series dimension, rather than five metric names — the shape a dashboard
	// iterates over to draw the queue panel.
	const q = emitted(() => metrics.queueHealth(42, 'overdue'));
	assert.deepEqual([q.value, q.metric, q.path], [42, 'queue_health', 'overdue']);
	const d = emitted(() => metrics.demandLadder(0.03, 'fast_fraction'));
	assert.deepEqual([d.value, d.metric, d.path], [0.03, 'demand_ladder', 'fast_fraction']);
});

test('the declared series of queue_health and demand_ladder are the ones the emitters accept', () => {
	for (const name of ['queue_health', 'demand_ladder']) {
		const values = METRICS[name].dimensions.path.values;
		assert.ok(values?.length, `${name} declares its series`);
		for (const series of values) {
			const e = emitted(() =>
				name === 'queue_health' ? metrics.queueHealth(1, series) : metrics.demandLadder(1, series)
			);
			assert.equal(e.path, series);
		}
	}
});

test('invalidation_reenqueue normalizes a missing scope to null rather than dropping the slot', () => {
	// `undefined` would omit the dimension entirely and split the series in two for the same
	// outcome; null keeps one row per outcome with an empty scope.
	const e = emitted(() => metrics.invalidationReenqueue('lowered', undefined));
	assert.deepEqual(e, {
		value: true,
		metric: 'invalidation_reenqueue',
		path: 'lowered',
		method: null,
		type: null,
	});
});

test('invalidation_error emits (kind) only', () => {
	const e = emitted(() => metrics.invalidationError('lkg-expired'));
	assert.deepEqual(e, {
		value: true,
		metric: 'invalidation_error',
		path: 'lkg-expired',
		method: null,
		type: null,
	});
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
	// "added a metric, forgot the doc" from shipping. Names only — the prose is allowed to be
	// shorter than the catalog's.
	const doc = await readFile(new URL('../METRICS.md', import.meta.url), 'utf8');
	for (const name of Object.keys(METRICS)) {
		assert.ok(doc.includes(`\`${name}\``), `METRICS.md does not mention ${name}`);
	}
	for (const name of Object.keys(BUILT_IN_METRICS)) {
		assert.ok(doc.includes(`\`${name}\``), `METRICS.md does not mention the built-in ${name}`);
	}
	// And nothing invented: every `metric_name`-shaped token the doc presents as a plugin metric
	// must exist. Restricted to the snake_case shape the plugin uses, so prose is unaffected.
	const known = new Set([...Object.keys(METRICS), ...Object.keys(BUILT_IN_METRICS)]);
	for (const [, token] of doc.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) {
		if (token.startsWith('invalidation_') || token.startsWith('route_') || token.startsWith('bot_')) {
			assert.ok(known.has(token), `METRICS.md references an unknown metric \`${token}\``);
		}
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
