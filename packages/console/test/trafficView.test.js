/**
 * The Traffic view, EXECUTED — not merely imported.
 *
 * Same reason `uiControls.test.js` exists: these modules have no build step and no type checker,
 * so a view that throws halfway through building a card parses, lints and formats perfectly. This
 * one carries more state than any other view (a bot selection, an age mode, a config join), and
 * every one of those paths is a branch that only runs when someone clicks something.
 *
 * The invariants it pins are the ones the module header promises and a reader cannot verify:
 *
 *   - Freshness is reported RELATIVE to each route's own cadence, so the same number means the
 *     same thing on a 1h route and a 6h one.
 *   - A `miss` is not the only non-hit, and the families sum to the non-hit total.
 *   - The bot filter NEVER refetches. It is a narrowing of a payload already in hand, and the
 *     whole load-discipline argument for this view collapses if a click becomes a scan.
 *   - A passthrough route's 100% miss rate is not flagged as a coverage failure — including when
 *     the route is a `excludePathPatterns` entry that also appears in `ingress.routes`, which is
 *     the case where reading the wrong entry looks entirely plausible.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installDom, find } from './domShim.js';

installDom();

const { el } = await import('../src/admin/ui.js');
const { load, render, cadenceIndex, cadenceFor, notHitRows } = await import('../src/admin/views/traffic.js');

const HOUR = 3_600_000;
const BUCKETS = 4;

/** One analytics combo, shaped like `util/analyticsRead.js` emits it. */
function combo(metric, path, method, type, count, value) {
	const row = {
		metric,
		path,
		method,
		type,
		count,
		total: 0,
		counts: new Array(BUCKETS).fill(count / BUCKETS),
	};
	if (value !== undefined) {
		row.mean = value;
		row.median = value;
		row.p95 = value;
		row.means = new Array(BUCKETS).fill(value);
		row.p95s = new Array(BUCKETS).fill(value);
	}
	return row;
}

// A window with something of everything: two bots, two devices, a cache-served majority, a real
// coverage miss, a page served past due, a blob fault, an origin 5xx, and a passthrough route.
const ANALYTICS = {
	available: true,
	scope: 'node',
	node: 'node-a',
	rangeMs: HOUR,
	startMs: 0,
	endMs: HOUR,
	bucketMs: HOUR / BUCKETS,
	bucketCount: BUCKETS,
	coveredFromMs: 0,
	coveredToMs: HOUR,
	truncated: false,
	cacheAgeMs: 0,
	scan: { ms: 12, scanned: 1200, kept: 300, cap: 20_000 },
	intervals: { defaultRenderInterval: 6 * HOUR, jobLeaseTime: 120_000 },
	series: [
		// bot_serve: path=source, method=cacheStatus, type=botName
		combo('bot_serve', 'cache', 'hit', 'googlebot', 600),
		combo('bot_serve', 'cache', 'swr', 'googlebot', 100),
		combo('bot_serve', 'origin', 'miss', 'googlebot', 100),
		combo('bot_serve', 'origin', 'miss', 'bingbot', 150),
		combo('bot_serve', 'cache', 'hit', 'bingbot', 50),
		combo('bot_serve', 'origin', 'blob-timeout', 'googlebot', 10),
		// bot_request: path=host, method=botName, type=deviceType
		combo('bot_request', 'www.example.com', 'googlebot', 'desktop', 500),
		combo('bot_request', 'www.example.com', 'googlebot', 'mobile', 310),
		combo('bot_request', 'www.example.com', 'bingbot', 'desktop', 200),
		// page_age: path=botName, method=deviceType
		combo('page_age', 'googlebot', 'desktop', null, 700, 3 * HOUR),
		combo('page_age', 'bingbot', 'desktop', null, 50, 12 * HOUR),
		// route_page_age: path=route, method=cacheStatus, type=deviceType
		combo('route_page_age', '/product/', 'hit', 'desktop', 600, 3 * HOUR),
		combo('route_page_age', '/', 'hit', 'desktop', 150, 3 * HOUR),
		// route_serve: path=route, method=cacheStatus, type=deviceType
		combo('route_serve', '/product/', 'hit', 'desktop', 600),
		combo('route_serve', '/product/', 'miss', 'desktop', 200),
		combo('route_serve', '/search/', 'miss', 'desktop', 100),
		combo('route_serve', 'unclassified', 'miss', 'desktop', 60),
		// origin_fetch: path=statusCode, method=reason
		combo('origin_fetch', '200', 'miss', null, 240, 800),
		combo('origin_fetch', '503', 'miss', null, 10, 3000),
		combo('origin_fetch', '200', 'blob-timeout', null, 10, 700),
		// Harper's own per-request metrics, bot traffic only (handlerPath 'p')
		combo('duration', 'p', 'GET', 'cache-hit', 750, 5),
		combo('duration', 'p', 'GET', 'cache-miss', 260, 900),
		combo('response_200', 'p', 'GET', null, 950),
		combo('response_500', 'p', 'GET', null, 60),
		// A served page whose age computed negative — dropped from the distribution above
		combo('prerender_ops', 'page_age_negative', 'googlebot', 'desktop', 3),
	],
};

// `/search/` is BOTH an exclude pattern and a prerender route with a one-minute cadence. The
// plugin prepends the exclude, so it is served as a passthrough; a console that read the
// `ingress.routes` entry would report a 1m cadence and flag its miss rate.
const CONFIG = {
	schema: {
		children: {
			ingress: { children: { routes: { kind: 'option' }, excludePathPatterns: { kind: 'option' } } },
			page: { children: { swrTtl: { kind: 'option' } } },
		},
	},
	layers: [
		{
			path: 'ingress.routes',
			effective: [
				{ match: 'prefix', path: '/product/', renderInterval: HOUR },
				{ match: 'exact', path: '/' },
				{ match: 'prefix', path: '/search/', renderInterval: 60_000 },
				{ match: 'prefix', path: '/legal/', mode: 'passthrough' },
			],
		},
		{ path: 'ingress.excludePathPatterns', effective: ['/search/'] },
		{ path: 'page.swrTtl', effective: 3 * HOUR },
	],
};

/** A context with the shell's semantics: per-view scratch, and counters for render vs reload. */
function makeCtx({ analytics = ANALYTICS, config = CONFIG } = {}) {
	const views = {};
	const scratch = (id) => (views[id] ??= {});
	const calls = { renders: 0, reloads: 0, gets: [] };
	return {
		calls,
		scratch,
		busy: false,
		get data() {
			return scratch('traffic');
		},
		async get(route) {
			calls.gets.push(route);
			if (route === 'analytics') return { ok: true, body: analytics };
			if (route === 'config') return { ok: true, body: config };
			return { ok: true, body: {} };
		},
		async post() {
			return { ok: true };
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
const textOf = (ctx) => draw(ctx).textContent;
const buttonSaying = (node, text) => find(node, (n) => n.tagName === 'BUTTON' && n.textContent.includes(text));
/** The table row whose FIRST cell is exactly `label` — not merely a row mentioning it. */
const rowFor = (node, label) =>
	find(node, (n) => n.tagName === 'TR' && n.children[0]?.textContent === label && n.children.length > 2);

const ready = async () => {
	const ctx = makeCtx();
	await load(ctx);
	return ctx;
};

// ---- the cadence join (pure) ------------------------------------------------

test('an excluded path is passthrough even when ingress.routes also declares it', () => {
	const index = cadenceIndex(CONFIG, 6 * HOUR);
	assert.deepEqual(index.get('/search/'), { mode: 'passthrough', interval: 6 * HOUR, inherited: true });
});

test('a route with its own renderInterval is measured against it, one without inherits the default', () => {
	const index = cadenceIndex(CONFIG, 6 * HOUR);
	assert.deepEqual(index.get('/product/'), { mode: 'prerender', interval: HOUR, inherited: false });
	assert.deepEqual(index.get('/'), { mode: 'prerender', interval: 6 * HOUR, inherited: true });
});

test('a route label that is a CLASS, not a configured path, resolves to that class', () => {
	const index = cadenceIndex(CONFIG, 6 * HOUR);
	assert.equal(cadenceFor(index, 'unclassified', 6 * HOUR).mode, 'unclassified');
	assert.equal(cadenceFor(index, '/legal/', 6 * HOUR).mode, 'passthrough');
});

test('cadenceIndex survives a config payload it cannot read', () => {
	for (const payload of [
		null,
		{},
		{ schema: {}, layers: [] },
		{ layers: [{ path: 'ingress.routes', effective: 7 }] },
	]) {
		assert.equal(cadenceIndex(payload, HOUR).size, 0);
	}
});

// ---- the non-hit taxonomy (pure) --------------------------------------------

test('non-hit rows separate the four fixes, and never count a hit', () => {
	const rows = notHitRows(ANALYTICS.series.filter((s) => s.metric === 'bot_serve'));
	const byStatus = new Map(rows.map((row) => [row.status, row]));

	assert.equal(byStatus.has('hit'), false, 'a hit is not a non-hit');
	assert.equal(byStatus.get('miss').family, 'coverage');
	assert.equal(byStatus.get('swr').family, 'cadence');
	assert.equal(byStatus.get('blob-timeout').family, 'integrity');
	// 250 misses across two bots, all of them proxied.
	assert.equal(byStatus.get('miss').count, 250);
	assert.deepEqual([...byStatus.get('miss').sources], [['origin', 250]]);
	// Ranked by volume, so the biggest problem is the first row.
	assert.deepEqual(
		rows.map((row) => row.status),
		['miss', 'swr', 'blob-timeout']
	);
});

test('a verdict this console has never heard of gets its own family, not someone else’s fix', () => {
	const [row] = notHitRows([combo('bot_serve', 'origin', 'quantum-tunnelled', 'googlebot', 5)]);
	assert.equal(row.family, 'other');
});

// ---- the rendered view -------------------------------------------------------

test('the whole view renders, and reports staleness against each route’s own cadence', async () => {
	const ctx = await ready();
	const text = textOf(ctx);

	// route_page_age: 600 serves at 3h on a 1h route (3.0x) and 150 at 3h on the 6h default
	// (0.5x) => count-weighted 2.5. Against the default interval alone it would read 0.5x, which
	// is the entire point: the fleet is three hours behind on the route that matters.
	assert.match(text, /Staleness p95/);
	assert.match(text, /2\.50×/);
	assert.match(text, /each route’s cadence/);
	// Absolute is still carried, because a ratio is not what anyone quotes.
	assert.match(text, /3\.0h/);
});

test('the KPI strip separates a coverage miss from every other non-hit', async () => {
	const ctx = await ready();
	const text = textOf(ctx);
	// 250 misses of 1010 serves.
	assert.match(text, /Coverage miss/);
	assert.match(text, /25%/);
	// And the families are all named, each with its own fix.
	for (const family of ['Coverage', 'Cadence', 'Integrity']) assert.match(text, new RegExp(family));
});

test('the serve tile carries a rate, so two ranges can be compared at all', async () => {
	const ctx = await ready();
	assert.match(textOf(ctx), /17\/min/); // 1,010 serves over a one-hour covered window
});

test('a negative-age discard is surfaced, not silently missing from the distribution', async () => {
	const ctx = await ready();
	assert.match(textOf(ctx), /NEGATIVE age/);
});

test('a passthrough route is labelled and its miss rate is NOT flagged', async () => {
	const ctx = await ready();
	const search = rowFor(draw(ctx), '/search/');
	assert.ok(search, 'the /search/ route should have a row');
	assert.match(search.textContent, /passthrough/);
	assert.equal(
		find(search, (n) => n.attributes?.class === 'pill warn'),
		null,
		'a route we never cache is proxied live by design — flagging its miss rate trains the operator to ignore the flag'
	);
});

test('a prerendered route past its own cadence IS flagged, with the ratio', async () => {
	const ctx = await ready();
	const product = rowFor(draw(ctx), '/product/');
	assert.match(product.textContent, /3\.00×/); // 3h delivered on a 1h cadence
	assert.ok(
		find(product, (n) => n.attributes?.class === 'pill warn'),
		'a route delivering three times its configured cadence is the finding this table exists for'
	);
});

test('serves that matched no route at all are called out', async () => {
	const ctx = await ready();
	assert.match(textOf(ctx), /matched no route at all/);
});

// ---- the bot filter ----------------------------------------------------------

test('selecting a bot re-renders from the payload in hand and NEVER refetches', async () => {
	const ctx = await ready();
	const fetchesAfterLoad = ctx.calls.gets.length;

	buttonSaying(draw(ctx), 'bingbot').fire('click');

	assert.deepEqual(ctx.data.bots, ['bingbot']);
	assert.equal(ctx.calls.renders, 1, 'a selection redraws');
	assert.equal(ctx.calls.reloads, 0, 'a selection must not reload the view');
	assert.equal(ctx.calls.gets.length, fetchesAfterLoad, 'a selection must not cost a scan on any node');
});

test('a filtered view narrows what CAN be narrowed and says "all bots" where it cannot', async () => {
	const ctx = await ready();
	ctx.data.bots = ['bingbot'];
	const text = textOf(ctx);

	// bingbot: 150 misses of 200 serves.
	assert.match(text, /75%/);
	// page_age for bingbot is 12h against the 6h default — the per-route cadence cannot apply,
	// because page_age carries the bot and not the route. Both facts are stated.
	assert.match(text, /2\.00×/);
	assert.match(text, /a per-route cadence cannot be applied to a bot-filtered window/);
	// Harper's own timing, the status codes and origin_fetch have no bot dimension.
	assert.match(text, /all bots/);
});

test('a selection with no traffic explains itself instead of looking like an outage', async () => {
	const ctx = await ready();
	ctx.data.bots = ['a-bot-that-never-came'];
	const text = textOf(ctx);
	assert.match(text, /No serves from a-bot-that-never-came/);
	// And the chip is still on screen, or the filter could never be cleared.
	assert.ok(buttonSaying(draw(ctx), 'a-bot-that-never-came'));
});

test('crawl breadth narrows per bot, but its union total is left alone', async () => {
	const ctx = await ready();
	ctx.data.breadth = {
		breadth: [
			{
				day: '2026-08-20',
				total: 1000,
				bots: [
					{ bot: 'googlebot', distinctUrls: 800 },
					{ bot: 'bingbot', distinctUrls: 200 },
				],
			},
		],
	};
	ctx.data.bots = ['bingbot'];

	const perBot = find(
		draw(ctx),
		(n) => n.children?.[0]?.attributes?.class === 'panel-sub' && n.children[0].textContent.startsWith('by bot')
	);
	assert.match(perBot.textContent, /bingbot/);
	assert.doesNotMatch(perBot.textContent, /googlebot/, 'the per-bot column is a real per-bot split, so it can filter');
	// The day figure is a UNION of that day's sketches, not a sum — it stays labelled all-bots.
	assert.match(textOf(ctx), /all bots, union/);
});

// ---- the absolute/relative toggle -------------------------------------------

test('the age panel switches to absolute and back without reloading', async () => {
	const ctx = await ready();
	assert.match(textOf(ctx), /Staleness at serve/);

	buttonSaying(draw(ctx), 'absolute').fire('click');
	assert.equal(ctx.data.ageMode, 'ms');
	assert.equal(ctx.calls.reloads, 0);
	assert.match(textOf(ctx), /Page age at serve/);

	buttonSaying(draw(ctx), '÷ cadence').fire('click');
	assert.equal(ctx.data.ageMode, 'ratio');
});

test('a payload with no interval in it falls back to absolute age and says why', async () => {
	const ctx = makeCtx({ analytics: { ...ANALYTICS, intervals: null } });
	await load(ctx);
	const text = textOf(ctx);
	assert.match(text, /Page age at serve/);
	assert.match(text, /carries no render interval/);
});

// ---- the empty and broken windows -------------------------------------------

test('an empty window renders the "is analytics even on" state, not a wall of zeroes', async () => {
	const ctx = makeCtx({ analytics: { ...ANALYTICS, series: [] } });
	await load(ctx);
	assert.match(textOf(ctx), /No traffic recorded/);
});

test('an unavailable or failed analytics read still renders the knob that turns it on', async () => {
	const ctx = makeCtx({ analytics: { available: false, error: 'management.analytics.enabled is false' } });
	await load(ctx);
	assert.match(textOf(ctx), /management\.analytics\.enabled is false/);
});
