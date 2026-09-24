/**
 * `changeProbe.scope` — which targets the sweep and the canary spend an origin request on.
 *
 * The pure predicate is pinned first; then the selection inside `runProbePass`; then the REAL sweep and
 * canary (`runProbeSweepOnce` / `runProbeCanaryOnce`), which are the only place the cohort wiring can be
 * seen. Those probe a loopback HTTP server, so what the origin was asked for is observed directly
 * rather than inferred from counters.
 */
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { inListedScope, probeScopeFilter, ProbeScope } from '../src/util/probeScope.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-24T12:00:00Z');
const GRACE = 2 * DAY;

// ---- the predicate ----

test('scope all is no filter at all — null, so the default pass calls nothing per row', () => {
	assert.equal(probeScopeFilter({ scope: ProbeScope.ALL, unlistedGrace: GRACE }), null);
	assert.equal(probeScopeFilter({}), null, 'absent reads as the default');
});

test('listed: a target a sitemap lists is in scope, whatever its stamp says', () => {
	const opts = { unlistedGrace: GRACE, nowMs: NOW };
	assert.equal(inListedScope({ sitemapUrl: 'https://site.example.com/s.xml' }, opts), true);
	assert.equal(
		inListedScope({ sitemapUrl: 'https://site.example.com/s.xml', unlistedAt: new Date(NOW - 30 * DAY) }, opts),
		true
	);
});

test('listed: an unlisted target is in scope INSIDE the grace and out of it after', () => {
	const opts = { unlistedGrace: GRACE, nowMs: NOW };
	assert.equal(inListedScope({ sitemapUrl: null, unlistedAt: new Date(NOW - HOUR) }, opts), true);
	assert.equal(inListedScope({ sitemapUrl: null, unlistedAt: new Date(NOW - GRACE + 1) }, opts), true);
	assert.equal(inListedScope({ sitemapUrl: null, unlistedAt: new Date(NOW - GRACE) }, opts), false, 'boundary');
	assert.equal(inListedScope({ sitemapUrl: null, unlistedAt: new Date(NOW - 3 * DAY) }, opts), false);
});

test('listed: never listed, an unreadable stamp, or grace 0 are out; BigInt and future stamps are handled', () => {
	const opts = { unlistedGrace: GRACE, nowMs: NOW };
	assert.equal(inListedScope({ sitemapUrl: null }, opts), false, 'discovered, or unlinked before v0.89.0');
	assert.equal(inListedScope({ sitemapUrl: null, unlistedAt: null }, opts), false);
	assert.equal(inListedScope({ sitemapUrl: null, unlistedAt: 'garbage' }, opts), false);
	assert.equal(inListedScope({ sitemapUrl: null, unlistedAt: BigInt(NOW - HOUR) }, opts), true, 'no throw on BigInt');
	assert.equal(
		inListedScope({ sitemapUrl: null, unlistedAt: new Date(NOW + HOUR) }, opts),
		true,
		'clock skew keeps probing'
	);
	assert.equal(
		inListedScope({ sitemapUrl: null, unlistedAt: new Date(NOW) }, { unlistedGrace: 0, nowMs: NOW }),
		false,
		'grace 0 is listed-only'
	);
});

test('the filter reads the clock per row, so a target that ages out mid-pass drops out mid-pass', () => {
	let now = NOW;
	const inScope = probeScopeFilter({ scope: 'listed', unlistedGrace: GRACE }, () => now);
	const row = { sitemapUrl: null, unlistedAt: new Date(NOW - GRACE + HOUR) };
	assert.equal(inScope(row), true);
	now += 2 * HOUR;
	assert.equal(inScope(row), false);
});

// ---- the probe, with Harper and the origin faked ----

let changeProbe;
let applyOptions;
let collectConfigWarnings;
let fnv1a32;

let origin; // loopback probe endpoint
let port;
const asked = []; // probe paths the origin received

const sabs = new Map();
const sharedBufferStub = {
	getUserSharedBuffer: (key, buffer) => {
		if (!sabs.has(key)) sabs.set(key, buffer);
		return sabs.get(key);
	},
	tryLock: () => true,
	unlock() {},
};
let sharedRows = new Map();
class SharedBufferFake {
	static primaryStore = sharedBufferStub;
	static async get(key) {
		return sharedRows.get(key) ?? undefined;
	}
	static async put(key, value) {
		sharedRows.set(key, value);
	}
}
class NoopTable {
	static async get() {}
	static async put() {}
	static async patch() {}
	static async delete() {}
	static search() {
		return [];
	}
}

// The registry: rows keyed by url, searched the way util/urlWalk.js asks (one-sided url ranges, sorted).
let registry = new Map();
const matches = (row, { attribute, comparator, value }) =>
	comparator === 'greater_than_equal'
		? row[attribute] >= value
		: comparator === 'greater_than'
			? row[attribute] > value
			: comparator === 'less_than'
				? row[attribute] < value
				: row[attribute] === value;
class RegistryTable extends NoopTable {
	static async get({ id }) {
		const row = registry.get(id);
		return row ? { ...row } : undefined;
	}
	static async *search({ conditions = [], sort, limit = Infinity }) {
		let rows = [...registry.values()].filter((row) => conditions.every((c) => matches(row, c)));
		rows.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
		if (sort?.descending) rows.reverse();
		for (const row of rows.slice(0, limit)) yield { ...row };
	}
}

const warns = [];

before(async () => {
	origin = createServer((req, res) => {
		asked.push(req.url);
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify({ price: 10 }));
	});
	await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
	port = origin.address().port;
});

after(async () => {
	await new Promise((resolve) => origin.close(resolve));
});

beforeEach(async () => {
	globalThis.server = { hostname: 'node-a', workerIndex: 0, nodes: [], config: { http: {} } };
	warns.length = 0;
	globalThis.logger = { debug() {}, info() {}, warn: (m) => warns.push(String(m)), error() {}, notify() {} };
	globalThis.databases = {
		coordination: { SharedBuffer: SharedBufferFake },
		probe_state: { ProbeState: NoopTable, RenderExpectation: NoopTable },
		render_service: { Target: RegistryTable },
		page_cache: { PrerenderedPage: NoopTable },
		render_schedule: { RenderSchedule: NoopTable },
		invalidation: { Invalidation: NoopTable },
	};
	sharedRows = new Map();
	registry = new Map();
	asked.length = 0;
	changeProbe = await import('../src/util/changeProbe.js');
	({ applyOptions, collectConfigWarnings } = await import('../src/config.js'));
	({ fnv1a32 } = await import('../src/util/hash.js'));
	changeProbe.resetChangeProbeState();
});

afterEach(() => {
	applyOptions({ changeProbe: { enabled: false } });
	changeProbe.resetChangeProbeState();
});

const rules = () => [
	{
		label: 'pdp',
		pathPattern: '^/product/prd-([^/]+)',
		source: 'request',
		request: { urlTemplate: `http://127.0.0.1:${port}/price/$1` },
		extract: ['price'],
	},
];

const configure = (changeProbe = {}) =>
	applyOptions({
		changeProbe: {
			enabled: true,
			rules: rules(),
			ratePerSecond: 10_000,
			concurrency: 8,
			reprobeAfter: 0,
			canary: { count: 10, interval: 0 },
			...changeProbe,
		},
	});

/** The product id a probe request named — what the origin was actually asked about. */
const probedIds = () => asked.map((path) => path.replace('/price/', '')).sort();

/**
 * Four shapes of target, one each. `ids` lets the canary tests pick URLs the bootstrap cohort stride
 * accepts (fnv1a32 % 16 === 0).
 */
const seedCorpus = (ids = ['listed', 'recent', 'stale', 'never']) => {
	const [listed, recent, stale, never] = ids;
	const now = Date.now();
	const put = (id, row) =>
		registry.set(`https://site.example.com/product/prd-${id}`, {
			url: `https://site.example.com/product/prd-${id}`,
			renderInterval: null,
			demandInterval: null,
			state: null,
			...row,
		});
	put(listed, { sitemapUrl: 'https://site.example.com/sitemap_product_1.xml' });
	put(recent, { sitemapUrl: null, unlistedAt: new Date(now - HOUR) });
	put(stale, { sitemapUrl: null, unlistedAt: new Date(now - 5 * DAY) });
	put(never, { sitemapUrl: null });
	return { listed, recent, stale, never };
};

// ---- runProbePass: the selection itself ----

const runPass = async ({ rows, inScope, collectCohort }) => {
	const { compileProbeRules } = await import('../src/util/changeProbeSpec.js');
	const probed = [];
	const stats = await changeProbe.runProbePass({
		rows: (async function* () {
			yield* rows;
		})(),
		rules: compileProbeRules(rules()),
		ownerOf: (url) => (url.includes('elsewhere') ? 'node-b' : 'node-a'),
		hostname: 'node-a',
		probe: async (rule, url) => {
			probed.push(url);
			return '[1]';
		},
		read: async () => null,
		write: async () => {},
		submitTrigger: async () => {},
		dryRun: true,
		maxTriggers: 100,
		concurrency: 4,
		ratePerSecond: 10_000,
		pause: async () => {},
		inScope,
		collectCohort,
	});
	return { stats, probed };
};

const row = (id, extra = {}) => ({
	url: `https://site.example.com/product/prd-${id}`,
	sitemapUrl: null,
	renderInterval: null,
	state: null,
	...extra,
});

const MIXED = () => [
	row('listed', { sitemapUrl: 'https://site.example.com/s.xml' }),
	row('recent', { unlistedAt: new Date(Date.now() - HOUR) }),
	row('stale', { unlistedAt: new Date(Date.now() - 5 * DAY) }),
	row('never'),
	row('suppressed', { sitemapUrl: 'https://site.example.com/s.xml', state: 'suppressed' }),
	row('elsewhere', { sitemapUrl: 'https://site.example.com/s.xml' }),
	{ ...row('x'), url: 'https://site.example.com/catalog/shoes' }, // no rule
];

test('runProbePass under listed: probes listed + recently unlisted, counts the rest as outOfScope', async () => {
	const cohort = [];
	const { stats, probed } = await runPass({
		rows: MIXED(),
		inScope: probeScopeFilter({ scope: 'listed', unlistedGrace: GRACE }),
		collectCohort: (rule, url) => cohort.push(url),
	});
	const ids = probed.map((url) => url.split('prd-')[1]).sort();
	assert.deepEqual(ids, ['listed', 'recent']);
	assert.equal(stats.outOfScope, 2, 'stale + never — the origin requests saved');
	assert.equal(stats.matched, 2, 'matched is what is probed, so continuous pacing sizes the real slice');
	assert.equal(stats.owned, 6);
	assert.deepEqual(cohort.map((url) => url.split('prd-')[1]).sort(), ['listed', 'recent'], 'the cohort follows');
});

test('suppressed and unowned rows are skipped exactly as before and are NOT counted as out of scope', async () => {
	const { stats } = await runPass({
		rows: [row('suppressed', { state: 'suppressed' }), row('elsewhere')],
		inScope: probeScopeFilter({ scope: 'listed', unlistedGrace: GRACE }),
	});
	assert.equal(stats.outOfScope, 0);
	assert.equal(stats.probed, 0);
});

test('defaults: with no scope filter every owned, unsuppressed, matched row is probed and outOfScope stays 0', async () => {
	const { stats, probed } = await runPass({ rows: MIXED(), inScope: null });
	assert.deepEqual(probed.map((url) => url.split('prd-')[1]).sort(), ['listed', 'never', 'recent', 'stale']);
	assert.equal(stats.outOfScope, 0);
	assert.equal(stats.matched, 4);
});

// ---- the real sweep ----

test('the sweep under scope listed asks the origin only about in-scope targets', async () => {
	configure({ scope: 'listed', unlistedGrace: GRACE });
	const { listed, recent } = seedCorpus();
	const result = await changeProbe.runProbeSweepOnce({ label: 'scoped' });

	assert.deepEqual(probedIds(), [listed, recent].sort());
	assert.equal(result.outOfScope, 2);
	assert.equal(result.matched, 2);
	assert.equal(result.examined, 4);
});

test('the sweep under the default scope asks about every target, as before', async () => {
	configure();
	seedCorpus();
	const result = await changeProbe.runProbeSweepOnce({ label: 'default' });
	assert.deepEqual(probedIds(), ['listed', 'never', 'recent', 'stale']);
	assert.equal(result.outOfScope, 0);
	assert.ok(!warns.some((w) => w.includes('changeProbe.scope left')));
});

test('a sweep that skips more than it probes says so', async () => {
	configure({ scope: 'listed', unlistedGrace: GRACE });
	seedCorpus();
	registry.delete('https://site.example.com/product/prd-recent'); // 1 in scope, 2 out
	await changeProbe.runProbeSweepOnce({ label: 'mostly-unlisted' });
	assert.ok(
		warns.some((w) => w.includes('changeProbe.scope left 2 rule-matched targets') && w.includes('probed only 1'))
	);
});

test('the canary cohort a SWEEP builds holds only in-scope targets', async () => {
	configure({ scope: 'listed', unlistedGrace: GRACE });
	const { listed, recent } = seedCorpus();
	await changeProbe.runProbeSweepOnce({ label: 'build' });

	asked.length = 0;
	const canary = await changeProbe.runProbeCanaryOnce();
	assert.deepEqual(probedIds(), [listed, recent].sort());
	assert.equal(canary.perRule[0].cohort, 2);
});

// The bootstrap cohort (no sweep yet) samples 1-in-16 by hash, so pick ids it accepts.
const strideIds = (n) => {
	const ids = [];
	for (let i = 0; ids.length < n; i++) {
		if (fnv1a32(`https://site.example.com/product/prd-${i}`) % 16 === 0) ids.push(String(i));
	}
	return ids;
};

test('the BOOTSTRAP canary cohort (no sweep yet) applies the same selection', async () => {
	configure({ scope: 'listed', unlistedGrace: GRACE });
	const { listed, recent } = seedCorpus(strideIds(4));
	const canary = await changeProbe.runProbeCanaryOnce();
	assert.equal(canary.perRule[0].cohort, 2);
	assert.deepEqual(probedIds(), [listed, recent].sort());
});

test('a cohort member whose grace ran out since the cohort was built is skipped and counted', async () => {
	configure({ scope: 'listed', unlistedGrace: GRACE });
	const { listed, recent } = seedCorpus(strideIds(4));
	await changeProbe.runProbeCanaryOnce(); // builds [listed, recent]

	registry.get(`https://site.example.com/product/prd-${recent}`).unlistedAt = new Date(Date.now() - 3 * DAY);
	asked.length = 0;
	const canary = await changeProbe.runProbeCanaryOnce();
	assert.deepEqual(probedIds(), [listed]);
	assert.equal(canary.perRule[0].outOfScope, 1);
});

test('the default scope leaves the bootstrap cohort exactly as before', async () => {
	configure();
	seedCorpus(strideIds(4));
	const canary = await changeProbe.runProbeCanaryOnce();
	assert.equal(canary.perRule[0].cohort, 4);
	assert.equal(canary.perRule[0].outOfScope, 0);
});

// ---- the config warning ----

const scopeFinding = () => collectConfigWarnings().find((f) => f.key === 'changeProbe.scope');

test('scope listed without an armed departure is a config warning, naming why', () => {
	applyOptions({ changeProbe: { enabled: true, rules: rules(), scope: 'listed' } });
	assert.match(scopeFinding()?.message ?? '', /no prerender route sets departureAction/);

	applyOptions({
		changeProbe: { enabled: true, rules: rules(), scope: 'listed' },
		sitemap: { departure: { enabled: true, dryRun: true } },
		ingress: { mode: 'forwarded', routes: [{ match: 'prefix', path: '/product/', departureAction: 'render' }] },
	});
	assert.match(scopeFinding()?.message ?? '', /sitemap\.departure\.dryRun is true/);

	applyOptions({
		changeProbe: { enabled: true, rules: rules(), scope: 'listed' },
		sitemap: { departure: { enabled: false, dryRun: false } },
		ingress: { mode: 'forwarded', routes: [{ match: 'prefix', path: '/product/', departureAction: 'render' }] },
	});
	assert.match(scopeFinding()?.message ?? '', /sitemap\.departure\.enabled is false/);
});

test('scope listed with departure armed, or the default scope, raises no warning', () => {
	applyOptions({
		changeProbe: { enabled: true, rules: rules(), scope: 'listed' },
		sitemap: { departure: { enabled: true, dryRun: false } },
		ingress: { mode: 'forwarded', routes: [{ match: 'prefix', path: '/product/', departureAction: 'render' }] },
	});
	assert.equal(scopeFinding(), undefined);

	applyOptions({ changeProbe: { enabled: true, rules: rules() } });
	assert.equal(scopeFinding(), undefined);
});

test('an invalid scope or grace is rejected back to the default', async () => {
	const { config } = await import('../src/config.js');
	applyOptions({ changeProbe: { scope: 'sitemap-only', unlistedGrace: -1 } });
	assert.equal(config.changeProbe.scope, 'all');
	assert.equal(config.changeProbe.unlistedGrace, 2 * DAY);
	applyOptions({ changeProbe: { scope: 'listed', unlistedGrace: 0 } });
	assert.equal(config.changeProbe.scope, 'listed');
	assert.equal(config.changeProbe.unlistedGrace, 0);
});
