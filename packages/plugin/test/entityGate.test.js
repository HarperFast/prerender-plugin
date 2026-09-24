import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The entity discovery gate (util/entityGate.js) and the per-route `entityPrefix` it reads.
 *
 * What is pinned here:
 *   - the route field is validated like every other optional route field: a bad value drops the
 *     FIELD with a warning, never the route, and a passthrough route refuses it;
 *   - a prefix must end on "/" at RUNTIME, so product 123 can never be gated by product 1234;
 *   - the decision: a sibling in rotation gates (listed or not), suppressed-only siblings mint, no
 *     siblings mint, the URL is never its own sibling, a dry run mints and counts;
 *   - the read is one bounded, one-sided, node-local primary-key range with the minimal projection,
 *     and its cursor is closed before anything is recorded;
 *   - discovery is the ONLY path that consults it — sitemap-driven creation never does.
 */

const analytics = [];
let openCursors = 0;
let cursorOpenAtEmit = false;

globalThis.server = {
	hostname: 'test-node',
	nodes: [],
	config: { http: { port: 9926 } },
	recordAnalytics: (...args) => {
		if (openCursors > 0) cursorOpenAtEmit = true;
		analytics.push(args);
	},
};
globalThis.logger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} };
globalThis.Resource = class {};

// The stubbed `Target` base the resource class extends. `get`/`put` are the calls
// `handlePageScheduling` makes; `search` is the sibling read. Every row lives in `rows`.
class TargetBase {
	static rows = new Map();
	static puts = [];
	static searches = [];
	static async get({ id }) {
		return TargetBase.rows.has(id) ? { url: id } : null;
	}
	static async put(id) {
		TargetBase.puts.push(id);
	}
	static search(query, context) {
		return fakeSearch([...TargetBase.rows.values()], query, context, TargetBase.searches);
	}
}

globalThis.databases = {
	coordination: {
		SharedBuffer: {
			primaryStore: { getUserSharedBuffer: (_key, buf) => buf, tryLock: () => true, unlock() {} },
		},
	},
	render_service: { Target: TargetBase, QueueControl: class {} },
	render_schedule: { RenderSchedule: class {} },
	page_cache: { PrerenderedPage: class {} },
	probe_state: { ProbeState: class {}, RenderExpectation: class {} },
};

/**
 * An in-memory stand-in for `Table.search` over a string primary key: ascending key order, the one
 * condition the gate issues, the projection, the limit — and cursor accounting, so a test can prove
 * the cursor is released (by `return()` on an early break, or by exhaustion).
 */
function fakeSearch(allRows, query, context, log) {
	log.push({ query, context });
	const [condition] = query.conditions;
	assert.equal(query.conditions.length, 1, 'the sibling read must be ONE-SIDED — a two-sided PK range is a scan');
	const rows = allRows
		.filter((row) => typeof row.url !== 'string' || row.url >= condition.value)
		.sort((a, b) => String(a.url ?? a.sortAs).localeCompare(String(b.url ?? b.sortAs)))
		.slice(0, query.limit);
	let index = 0;
	let open = true;
	openCursors++;
	const close = () => {
		if (open) {
			open = false;
			openCursors--;
		}
	};
	return {
		[Symbol.asyncIterator]() {
			return this;
		},
		async next() {
			if (index >= rows.length) {
				close();
				return { done: true, value: undefined };
			}
			const row = rows[index++];
			return { done: false, value: Object.fromEntries(query.select.map((key) => [key, row[key]])) };
		},
		async return() {
			close();
			return { done: true, value: undefined };
		},
	};
}

/** A standalone table over `rows` — for the unit tests that do not go through the Target stub. */
const tableOf = (rows) => {
	const searches = [];
	return { searches, search: (query, context) => fakeSearch(rows, query, context, searches) };
};

const ORIGIN = 'https://www.example.com';
const U = `${ORIGIN}/product/prd-123/new-spelling.jsp`;
const PATTERN = '^/product/prd-[^/]+/';

let applyOptions;
let config;
let matchRoute;
let inspectRoutes;
let evaluateEntityGate;
let entityPrefixOf;
let EntityGateOutcome;
let SIBLING_SELECT;
let SIBLING_READ_LIMIT;
let handlePageScheduling;

before(async () => {
	({ applyOptions, config } = await import('../src/config.js'));
	({ matchRoute, inspectRoutes } = await import('../src/util/routeClass.js'));
	({ evaluateEntityGate, entityPrefixOf, EntityGateOutcome, SIBLING_SELECT, SIBLING_READ_LIMIT } = await import(
		'../src/util/entityGate.js'
	));
	({ handlePageScheduling } = await import('../src/http_handlers/bot_request.js'));
});

const productRoute = (extra = {}) => ({ match: 'prefix', path: '/product/prd-', queryParams: [], ...extra });

// `entityPrefix: undefined` must mean ABSENT, so presence is tested with `in` rather than left to a
// destructuring default (which would substitute PATTERN for an explicit undefined).
const configure = (options = {}) => {
	const { gate = {}, route = {} } = options;
	const entityPrefix = 'entityPrefix' in options ? options.entityPrefix : PATTERN;
	return applyOptions({
		ingress: {
			mode: 'forwarded',
			deviceTypeSource: 'path',
			excludePathPatterns: [],
			routes: [productRoute({ ...(entityPrefix === undefined ? {} : { entityPrefix }), ...route })],
			entityGate: { dryRun: false, ...gate },
		},
	});
};

const route = () => matchRoute('/product/prd-123/x.jsp');

beforeEach(() => {
	analytics.length = 0;
	cursorOpenAtEmit = false;
	TargetBase.rows = new Map();
	TargetBase.puts = [];
	TargetBase.searches = [];
	configure();
});

const put = (url, fields = {}) => TargetBase.rows.set(url, { url, sitemapUrl: null, state: null, ...fields });
const ops = (series) => analytics.filter(([, metric, path]) => metric === 'prerender_ops' && path === series);
const outcomes = () => ops('entity_gate').map(([, , , outcome]) => outcome);

// ── the route field ────────────────────────────────────────────────────────────────────────────

test('a valid entityPrefix compiles onto the route, anchored at the path root', () => {
	const entry = route();
	assert.ok(entry.entityPrefix instanceof RegExp);
	assert.ok(entry.entityPrefix.sticky, 'sticky, so a match can only start at the path root');
	assert.deepEqual(inspectRoutes([productRoute({ entityPrefix: PATTERN })], []).warnings, []);
});

test('an absent or null entityPrefix is simply off — no field, no warning', () => {
	for (const entityPrefix of [undefined, null]) {
		const raw = productRoute(entityPrefix === undefined ? {} : { entityPrefix });
		assert.deepEqual(inspectRoutes([raw], []).warnings, []);
		configure({ entityPrefix });
		assert.equal(route().entityPrefix, null);
	}
});

test('an invalid regular expression drops the FIELD with a warning, never the route', () => {
	const { warnings, prerender, dropped } = inspectRoutes([productRoute({ entityPrefix: '^/product/prd-[/' })], []);
	assert.equal(prerender, 1);
	assert.equal(dropped, 0);
	assert.ok(warnings.some((w) => w.includes('entityPrefix') && w.includes('not a valid regular expression')));
	configure({ entityPrefix: '^/product/prd-[/' });
	assert.equal(route().mode, 'prerender', 'the route still prerenders');
	assert.equal(route().entityPrefix, null);
});

test('a non-string or empty entityPrefix drops the field with a warning', () => {
	for (const bad of [123, true, '', ['^/a/'], { source: '^/a/' }]) {
		const { warnings, prerender } = inspectRoutes([productRoute({ entityPrefix: bad })], []);
		assert.equal(prerender, 1);
		assert.ok(
			warnings.some((w) => w.includes('entityPrefix') && w.includes('expected a non-empty regular expression')),
			`expected a type warning for ${JSON.stringify(bad)}, got ${JSON.stringify(warnings)}`
		);
	}
});

test('a passthrough route refuses entityPrefix — it never discovers anything', () => {
	const raw = { match: 'prefix', path: '/help/', mode: 'passthrough', entityPrefix: '^/help/[^/]+/' };
	const { warnings } = inspectRoutes([raw], []);
	assert.ok(warnings.some((w) => w.includes('ignoring entityPrefix on passthrough route')));
	applyOptions({ ingress: { mode: 'forwarded', excludePathPatterns: [], routes: [raw] } });
	assert.equal(matchRoute('/help/a/b').entityPrefix, null);
});

test('a pattern that does not end in "/" is KEPT but warned about — the runtime rule is what refuses it', () => {
	const { warnings } = inspectRoutes([productRoute({ entityPrefix: '^/product/prd-\\d+' })], []);
	assert.ok(warnings.some((w) => w.includes('does not end in "/"') && w.includes('prd-1234')));
	configure({ entityPrefix: '^/product/prd-\\d+' });
	assert.ok(route().entityPrefix instanceof RegExp);
});

test('entityPrefix on a route with discoverTargets: false is warned about as a no-op', () => {
	const { warnings } = inspectRoutes([productRoute({ entityPrefix: PATTERN, discoverTargets: false })], []);
	assert.ok(warnings.some((w) => w.includes('entityPrefix') && w.includes('does nothing')));
});

// ── the prefix ─────────────────────────────────────────────────────────────────────────────────

test('the lookup prefix is the URL origin plus the matched path text', () => {
	assert.equal(entityPrefixOf(U, route()), `${ORIGIN}/product/prd-123/`);
	// The port is part of the origin, and of the canonical key.
	assert.equal(
		entityPrefixOf('https://www.example.com:8443/product/prd-9/x.jsp', route()),
		'https://www.example.com:8443/product/prd-9/'
	);
});

test('the match is anchored at the path root even without a leading ^', () => {
	configure({ entityPrefix: '/product/prd-[^/]+/' });
	assert.equal(entityPrefixOf(U, route()), `${ORIGIN}/product/prd-123/`);
	// A pattern that could only match MID-path matches nothing.
	configure({ entityPrefix: 'prd-[^/]+/' });
	assert.equal(entityPrefixOf(U, route()), null);
});

test('PREFIX COLLISION: product 123 is never a sibling of product 1234, whatever the pattern', () => {
	// A well-formed pattern: the prefix ends on "/", so it is not a string prefix of 1234's URL.
	const prefix = entityPrefixOf(U, route());
	assert.ok(!`${ORIGIN}/product/prd-1234/other.jsp`.startsWith(prefix));

	// An undelimited pattern WOULD produce `…/prd-123`, a string prefix of every prd-1234 URL. The
	// runtime rule refuses that match outright.
	configure({ entityPrefix: '^/product/prd-\\d+' });
	assert.equal(entityPrefixOf(U, route()), null);
});

test('an optional trailing "/" is usable: refused on the bare id URL, used where the URL continues', () => {
	configure({ entityPrefix: '^/product/prd-\\d+/?' });
	assert.equal(entityPrefixOf(`${ORIGIN}/product/prd-123`, route()), null);
	assert.equal(entityPrefixOf(U, route()), `${ORIGIN}/product/prd-123/`);
});

test('a match that does not extend past a prefix route’s own path names the whole route and is refused', () => {
	applyOptions({
		ingress: {
			mode: 'forwarded',
			excludePathPatterns: [],
			routes: [{ match: 'prefix', path: '/product/', queryParams: [], entityPrefix: '^/product/' }],
		},
	});
	assert.equal(entityPrefixOf(`${ORIGIN}/product/prd-1/x.jsp`, matchRoute('/product/prd-1/x.jsp')), null);
});

// ── the decision ───────────────────────────────────────────────────────────────────────────────

const gate = (overrides = {}) => ({ enabled: true, dryRun: false, ...overrides });

test('a sitemap-listed sibling in rotation GATES: not minted, counted on both series', async () => {
	const table = tableOf([
		{ url: `${ORIGIN}/product/prd-123/old-spelling.jsp`, sitemapUrl: `${ORIGIN}/sitemap-1.xml`, state: null },
	]);
	const result = await evaluateEntityGate({ url: U, route: route(), botName: 'Googlebot', table, gate: gate() });
	assert.equal(result.mint, false);
	assert.equal(result.outcome, EntityGateOutcome.GATED);
	assert.equal(result.blocker, `${ORIGIN}/product/prd-123/old-spelling.jsp`);
	assert.deepEqual(outcomes(), ['gated']);
	assert.deepEqual(ops('discovery_gated'), [[true, 'prerender_ops', 'discovery_gated', 'entity', 'Googlebot']]);
});

test('an active UNLISTED sibling gates too', async () => {
	const table = tableOf([{ url: `${ORIGIN}/product/prd-123/new.jsp`, sitemapUrl: null, state: null }]);
	const result = await evaluateEntityGate({ url: U, route: route(), table, gate: gate() });
	assert.equal(result.mint, false);
	assert.equal(result.outcome, 'gated');
});

test('SUPPRESSED-ONLY siblings mint — a re-slug is delayed, never blocked for good', async () => {
	const table = tableOf([
		{ url: `${ORIGIN}/product/prd-123/a.jsp`, state: 'suppressed' },
		// Listed AND suppressed: a sitemap listing a non-canonical URL must not block the canonical one.
		{ url: `${ORIGIN}/product/prd-123/b.jsp`, sitemapUrl: `${ORIGIN}/sitemap-1.xml`, state: 'suppressed' },
	]);
	const result = await evaluateEntityGate({ url: U, route: route(), table, gate: gate() });
	assert.equal(result.mint, true);
	assert.equal(result.outcome, 'suppressed-only');
	assert.deepEqual(ops('discovery_gated'), []);
});

test('no siblings mints — including when the NEIGHBOURING product (prd-1234) is tracked', async () => {
	const table = tableOf([
		{ url: `${ORIGIN}/product/prd-1234/other.jsp`, state: null },
		{ url: `${ORIGIN}/product/prd-12/other.jsp`, state: null },
	]);
	const result = await evaluateEntityGate({ url: U, route: route(), table, gate: gate() });
	assert.equal(result.mint, true);
	assert.equal(result.outcome, 'no-siblings');
});

test('the URL is never its own sibling', async () => {
	const table = tableOf([{ url: U, state: null }]);
	const result = await evaluateEntityGate({ url: U, route: route(), table, gate: gate() });
	assert.equal(result.mint, true);
	assert.equal(result.outcome, 'no-siblings');
});

test('DRY RUN: the same verdict mints anyway and counts would-gate — never discovery_gated', async () => {
	const table = tableOf([{ url: `${ORIGIN}/product/prd-123/new.jsp`, state: null }]);
	const result = await evaluateEntityGate({ url: U, route: route(), table, gate: gate({ dryRun: true }) });
	assert.equal(result.mint, true);
	assert.equal(result.outcome, 'would-gate');
	assert.deepEqual(outcomes(), ['would-gate']);
	assert.deepEqual(ops('discovery_gated'), []);
});

test('a route without entityPrefix is untouched: no read, nothing recorded', async () => {
	configure({ entityPrefix: undefined });
	const table = tableOf([{ url: `${ORIGIN}/product/prd-123/new.jsp`, state: null }]);
	const result = await evaluateEntityGate({ url: U, route: route(), table, gate: gate() });
	assert.deepEqual(result, { mint: true, outcome: null, prefix: null, blocker: null });
	assert.equal(table.searches.length, 0);
	assert.deepEqual(analytics, []);
	// And with no matched route at all (prefix ingress with no routes declared).
	assert.equal((await evaluateEntityGate({ url: U, route: null, table, gate: gate() })).outcome, null);
});

test('the master switch off: no read, nothing recorded, minted', async () => {
	const table = tableOf([{ url: `${ORIGIN}/product/prd-123/new.jsp`, state: null }]);
	const result = await evaluateEntityGate({ url: U, route: route(), table, gate: gate({ enabled: false }) });
	assert.equal(result.mint, true);
	assert.equal(table.searches.length, 0);
	assert.deepEqual(analytics, []);
});

test('a URL the pattern does not match mints and is counted no-prefix', async () => {
	configure({ entityPrefix: '^/product/prd-\\d+/' });
	const table = tableOf([]);
	const result = await evaluateEntityGate({
		url: `${ORIGIN}/product/prd-abc/x.jsp`,
		route: matchRoute('/product/prd-abc/x.jsp'),
		table,
		gate: gate(),
	});
	assert.equal(result.mint, true);
	assert.equal(result.outcome, 'no-prefix');
	assert.equal(table.searches.length, 0);
});

test('a read that throws FAILS OPEN: minted, counted as error', async () => {
	const table = {
		search() {
			throw new Error('store unavailable');
		},
	};
	const result = await evaluateEntityGate({ url: U, route: route(), table, gate: gate() });
	assert.equal(result.mint, true);
	assert.equal(result.outcome, 'error');
});

test('an unreadable row is skipped, never taken for a sibling or a cursor', async () => {
	const table = tableOf([
		{ url: undefined, sortAs: `${ORIGIN}/product/prd-123/0`, state: null },
		{ url: `${ORIGIN}/product/prd-123/a.jsp`, state: 'suppressed' },
	]);
	const result = await evaluateEntityGate({ url: U, route: route(), table, gate: gate() });
	assert.equal(result.outcome, 'suppressed-only');
});

// ── the read ───────────────────────────────────────────────────────────────────────────────────

test('the read is one bounded, one-sided, node-local PK range with the minimal projection', async () => {
	const table = tableOf([{ url: `${ORIGIN}/product/prd-123/a.jsp`, state: 'suppressed' }]);
	await evaluateEntityGate({ url: U, route: route(), table, gate: gate() });
	assert.equal(table.searches.length, 1);
	const [{ query, context }] = table.searches;
	assert.deepEqual(query.conditions, [
		{ attribute: 'url', comparator: 'greater_than_equal', value: `${ORIGIN}/product/prd-123/` },
	]);
	assert.deepEqual(query.sort, { attribute: 'url' });
	assert.deepEqual(query.select, [...SIBLING_SELECT]);
	assert.deepEqual(query.select, ['url', 'state']);
	assert.equal(SIBLING_READ_LIMIT, 3, 'measured: the first sibling in rotation was within 3 keys for 150/150 entities');
	assert.equal(query.limit, SIBLING_READ_LIMIT, 'a fixed 3-row read — no knob');
	// SECOND argument: Harper ignores unknown query fields, so inside the query it would do nothing.
	assert.deepEqual(context, { replicateFrom: false });
	assert.equal('replicateFrom' in query, false);
});

test('the cursor is released before anything is recorded — on an early break and on exhaustion', async () => {
	// Early break: the first sibling in rotation decides.
	let table = tableOf([
		{ url: `${ORIGIN}/product/prd-123/a.jsp`, state: null },
		{ url: `${ORIGIN}/product/prd-123/b.jsp`, state: null },
	]);
	await evaluateEntityGate({ url: U, route: route(), table, gate: gate() });
	assert.equal(openCursors, 0);
	assert.equal(cursorOpenAtEmit, false);

	// Exhaustion.
	table = tableOf([]);
	await evaluateEntityGate({ url: U, route: route(), table, gate: gate() });
	assert.equal(openCursors, 0);
	assert.equal(cursorOpenAtEmit, false);
});

test('the read stops at the first sibling in rotation, and the 3-row limit bounds the suppressed case', async () => {
	const dead = (n) =>
		Array.from({ length: n }, (_, i) => ({ url: `${ORIGIN}/product/prd-123/dead-${i}.jsp`, state: 'suppressed' }));
	const live = { url: `${ORIGIN}/product/prd-123/zz-live.jsp`, state: null };
	// Two dead slugs ahead of the live one: the live one is the third row read, so the gate finds it.
	let result = await evaluateEntityGate({ url: U, route: route(), table: tableOf([...dead(2), live]), gate: gate() });
	assert.equal(result.outcome, 'gated');
	assert.equal(result.blocker, live.url);
	// Three dead slugs ahead of it: the live one is past the read, and the gate MINTS (the pre-gate
	// behaviour) — it never refuses on a guess.
	result = await evaluateEntityGate({ url: U, route: route(), table: tableOf([...dead(3), live]), gate: gate() });
	assert.equal(result.outcome, 'suppressed-only');
	assert.equal(result.mint, true);
	// The first sibling in rotation ends the read: nothing after it is consumed.
	const table = tableOf([live, ...dead(2)]);
	result = await evaluateEntityGate({ url: U, route: route(), table, gate: gate() });
	assert.equal(result.outcome, 'gated');
});

// ── the discovery path ─────────────────────────────────────────────────────────────────────────

const originMiss = (url) => ({
	miss: true,
	statusCode: 200,
	url,
	headers: { 'content-type': 'text/html; charset=utf-8' },
});

test('discovery, ARMED: a URL whose product has a target in rotation is not minted', async () => {
	put(`${ORIGIN}/product/prd-123/old-spelling.jsp`);
	await handlePageScheduling(originMiss(U), route(), 'Googlebot');
	assert.deepEqual(TargetBase.puts, []);
	assert.deepEqual(outcomes(), ['gated']);
});

test('discovery, DRY RUN (the default): minted exactly as before, and counted', async () => {
	configure({ gate: { dryRun: true } });
	put(`${ORIGIN}/product/prd-123/old-spelling.jsp`);
	await handlePageScheduling(originMiss(U), route(), 'Googlebot');
	assert.deepEqual(TargetBase.puts, [U]);
	assert.deepEqual(outcomes(), ['would-gate']);
});

test('discovery on a route without entityPrefix: minted, no sibling read, nothing recorded', async () => {
	configure({ entityPrefix: undefined });
	put(`${ORIGIN}/product/prd-123/old-spelling.jsp`);
	await handlePageScheduling(originMiss(U), route(), 'Googlebot');
	assert.deepEqual(TargetBase.puts, [U]);
	assert.equal(TargetBase.searches.length, 0);
	assert.deepEqual(outcomes(), []);
});

test('discovery of a URL that already has a row: no sibling read at all', async () => {
	put(U, { state: 'suppressed' });
	put(`${ORIGIN}/product/prd-123/old-spelling.jsp`);
	await handlePageScheduling(originMiss(U), route(), 'Googlebot');
	assert.deepEqual(TargetBase.puts, []);
	assert.equal(TargetBase.searches.length, 0);
});

test('discovery with suppressed-only siblings mints the new URL', async () => {
	put(`${ORIGIN}/product/prd-123/old-spelling.jsp`, { state: 'suppressed' });
	await handlePageScheduling(originMiss(U), route(), 'Googlebot');
	assert.deepEqual(TargetBase.puts, [U]);
	assert.deepEqual(outcomes(), ['suppressed-only']);
});

// ── scope: discovery only ──────────────────────────────────────────────────────────────────────

test('discovery is the ONLY caller — sitemap-driven (and every other) creation never meets the gate', async () => {
	const SRC = new URL('../src/', import.meta.url).pathname;
	const files = (await readdir(SRC, { recursive: true })).filter((f) => f.endsWith('.js'));
	const callers = [];
	for (const file of files) {
		const source = await readFile(join(SRC, file), 'utf8');
		if (file.endsWith('entityGate.js')) continue;
		if (/\bevaluateEntityGate\b/.test(source)) callers.push(file);
	}
	assert.deepEqual(callers, [join('http_handlers', 'bot_request.js')]);

	const botRequest = await readFile(join(SRC, 'http_handlers', 'bot_request.js'), 'utf8');
	const calls = [...botRequest.matchAll(/await evaluateEntityGate\(/g)];
	assert.equal(calls.length, 1, 'exactly one call site');
	// ...and it sits inside handlePageScheduling, after the existing-row check.
	const body = botRequest.slice(botRequest.indexOf('export async function handlePageScheduling'));
	assert.ok(body.indexOf('await evaluateEntityGate(') > body.indexOf('if (!existingTarget)'));
});

// ── config ─────────────────────────────────────────────────────────────────────────────────────

test('ingress.entityGate defaults: on, DRY RUN — and the read size is not configuration', () => {
	applyOptions({});
	assert.deepEqual(config.ingress.entityGate, { enabled: true, dryRun: true });
});
