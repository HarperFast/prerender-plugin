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
const { load, render, cadenceIndex, cadenceFor, notHitRows, originVerdict, originCostByReason, coverageSplit } =
	await import('../src/admin/views/traffic.js');
const { ratioOf } = await import('../src/admin/charts.js');

const HOUR = 3_600_000;
const BUCKETS = 4;

/**
 * One analytics combo, shaped like `util/analyticsRead.js` emits it.
 *
 * `p95` defaults to `value` but is worth setting: with a flat distribution no test can tell which
 * statistic a panel used, and "which statistic" is exactly what several of them now assert.
 */
function combo(metric, path, method, type, count, value, p95 = value) {
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
		row.p95 = p95;
		row.means = new Array(BUCKETS).fill(value);
		row.medians = new Array(BUCKETS).fill(value);
		row.p95s = new Array(BUCKETS).fill(p95);
	}
	return row;
}

/** The same combo as a pre-v0.51.0 plugin would send it: no per-bucket medians. */
function withoutBucketMedians(row) {
	const { medians, ...rest } = row;
	return rest;
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
		combo('page_age', 'googlebot', 'desktop', null, 700, 3 * HOUR, 9 * HOUR),
		combo('page_age', 'bingbot', 'desktop', null, 50, 12 * HOUR, 18 * HOUR),
		// route_page_age: path=route, method=cacheStatus, type=deviceType. Median 3h, tail 9h.
		combo('route_page_age', '/product/', 'hit', 'desktop', 600, 3 * HOUR, 9 * HOUR),
		combo('route_page_age', '/', 'hit', 'desktop', 150, 3 * HOUR, 9 * HOUR),
		// route_serve: path=route, method=cacheStatus, type=deviceType
		combo('route_serve', '/product/', 'hit', 'desktop', 600),
		combo('route_serve', '/product/', 'miss', 'desktop', 200),
		combo('route_serve', '/search/', 'miss', 'desktop', 100),
		combo('route_serve', 'unclassified', 'miss', 'desktop', 60),
		// origin_fetch: path=statusCode, method=reason. 100 of the 250 misses are pages the origin
		// does not have — the population that makes a complete corpus look broken.
		combo('origin_fetch', '200', 'miss', null, 140, 800),
		combo('origin_fetch', '404', 'miss', null, 100, 120),
		combo('origin_fetch', '503', 'miss', null, 10, 3000),
		combo('origin_fetch', '200', 'blob-timeout', null, 10, 700),
		// Harper's own per-request metrics, bot traffic only (handlerPath 'p')
		// A cache hit is single-digit ms with a tail; an origin proxy is two orders of magnitude
		// slower. Pooling the two is the thing the serve-time tile must not do.
		combo('duration', 'p', 'GET', 'cache-hit', 750, 5, 40),
		combo('duration', 'p', 'GET', 'cache-miss', 260, 900, 2400),
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
				{ match: 'prefix', path: '/product/', renderInterval: HOUR, demandFloor: 30 * 60_000 },
				{ match: 'exact', path: '/' },
				{ match: 'prefix', path: '/search/', renderInterval: 60_000 },
				{ match: 'prefix', path: '/legal/', mode: 'passthrough' },
				{ match: 'prefix', path: '/catalog/', renderInterval: 2 * HOUR, discoverTargets: false },
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
	assert.deepEqual(index.get('/search/'), {
		mode: 'passthrough',
		interval: 6 * HOUR,
		inherited: true,
	});
});

test('a route with its own renderInterval is measured against it, one without inherits the default', () => {
	const index = cadenceIndex(CONFIG, 6 * HOUR);
	assert.deepEqual(index.get('/product/'), {
		mode: 'prerender',
		interval: HOUR,
		inherited: false,
		discoverTargets: true,
		demandFloor: 30 * 60_000,
	});
	assert.deepEqual(index.get('/'), {
		mode: 'prerender',
		interval: 6 * HOUR,
		inherited: true,
		discoverTargets: true,
		demandFloor: null,
	});
});

test('the discovery gate and the demand floor ride on the same join as the cadence', () => {
	const index = cadenceIndex(CONFIG, 6 * HOUR);
	// `discoverTargets` defaults to TRUE upstream, so an ABSENT flag is an open route and only an
	// explicit false is a gate. Reporting "unknown" for the common case would put a dash in the
	// column on every route of every deployment that has never used the feature.
	assert.equal(index.get('/catalog/').discoverTargets, false);
	assert.equal(index.get('/product/').discoverTargets, true);
	// A CLASS label matched no route at all, so it carries no route flag — null, never the default.
	assert.equal(cadenceFor(index, 'unclassified', HOUR).discoverTargets, null);
	assert.equal(cadenceFor(index, 'unclassified', HOUR).demandFloor, null);
	// A floor is only reported when it is a usable interval; anything else is "no floor set".
	assert.equal(index.get('/product/').demandFloor, 30 * 60_000);
	assert.equal(index.get('/catalog/').demandFloor, null);
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
	assert.match(text, /Staleness/);
	assert.match(text, /2\.50×/);
	assert.match(text, /each route’s cadence/);
	// Absolute is still carried, because a ratio is not what anyone quotes.
	assert.match(text, /3\.0h/);
});

// ---- one statistic per question ---------------------------------------------

test('staleness leads with the MEDIAN and carries the p95 beside it', async () => {
	const ctx = await ready();
	const text = textOf(ctx);
	// route_page_age: median 3h on a 1h route (3.00x) and on the 6h default (0.50x), count-weighted
	// over 600/150 => 2.50x. The tail is 9h, which would read 7.50x — three times as alarming, on
	// the same healthy window.
	assert.match(text, /Staleness2\.50×median · p95 7\.50×/);
});

test('a p95 that would warn does not warn when the median is fine', async () => {
	const ctx = await ready();
	// The tile warns on the median (2.50x here, genuinely bad). Prove the threshold is on the
	// median by making the median healthy while the tail stays high.
	ctx.data.analytics = {
		...ANALYTICS,
		series: ANALYTICS.series.map((s) =>
			s.metric === 'route_page_age' ? combo(s.metric, s.path, s.method, s.type, s.count, 0.4 * HOUR, 5 * HOUR) : s
		),
	};
	const warned = find(draw(ctx), (n) => n.attributes?.class === 'value warn');
	assert.equal(warned, null, 'an evenly aged corpus has a p95 near its ceiling — that is not an alarm');
});

test('serve time reports the two populations separately, never pooled', async () => {
	const ctx = await ready();
	const text = textOf(ctx);
	// 750 hits at 5ms and 260 origin serves at 900ms. Pooled that is 235ms — a number that moves
	// with the hit rate rather than with how fast anything is.
	assert.match(text, /Serve time · cache hit5msmedian · p95 40ms · origin-served 900ms/);
	assert.doesNotMatch(text, /235ms/);
});

test('the per-route table and the staleness tile use the SAME statistic', async () => {
	const ctx = await ready();
	const product = rowFor(draw(ctx), '/product/');
	// Median 3h on a 1h cadence. The p95 (9h) would have read 9.00x in a table sitting inches
	// below a tile saying 2.50x, with nothing on screen to reconcile them.
	assert.match(product.textContent, /3\.00×/);
	assert.doesNotMatch(product.textContent, /9\.00×/);
});

test('a missing measurement is not a confident zero', () => {
	// `null / 48h` is 0 in JavaScript, not NaN, so an absent p95 divided by a present cadence
	// formats as "0.00×" — the most flattering possible reading of "we have no data". Same trap as
	// `Number(null) === 0`, arriving through division instead of coercion.
	assert.equal(ratioOf(null, 48 * HOUR), null);
	assert.equal(ratioOf(undefined, 48 * HOUR), null);
	assert.equal(ratioOf(3 * HOUR, null), null);
	assert.equal(ratioOf(3 * HOUR, 0), null, 'a zero cadence is not a yardstick');
	assert.equal(ratioOf(3 * HOUR, -1), null);
	assert.equal(ratioOf(3 * HOUR, 6 * HOUR), 0.5);
	assert.equal(ratioOf(0, 6 * HOUR), 0, 'a measured zero IS an answer');
});

test('a route whose tail could not be merged shows no tail, rather than 0.00×', async () => {
	const ctx = await ready();
	// A distribution the payload carried without a p95 — the shape `weighted` answers null for.
	ctx.data.analytics = {
		...ANALYTICS,
		series: ANALYTICS.series.map((s) => {
			if (s.metric !== 'route_page_age' || s.path !== '/product/') return s;
			const { p95, p95s, ...rest } = s;
			return rest;
		}),
	};
	const product = rowFor(draw(ctx), '/product/');
	const tail = find(product, (n) => String(n.attributes?.title ?? '').startsWith('p95 '));
	assert.equal(tail.attributes.title, 'p95 —', 'an absent tail must read as absent');
	// The median is unaffected, so the row still says what it does know.
	assert.match(product.textContent, /3\.00×/);
});

test('the staleness trend charts the median once the plugin buckets it', async () => {
	const ctx = await ready();
	const text = textOf(ctx);
	assert.match(text, /p95mean÷ cadence|p95median÷ cadence/, 'the legend should name the two lines');
	assert.match(text, /the p95 and the median/);
	assert.doesNotMatch(text, /predates per-bucket medians/);
});

test('an older plugin still gets a trend line, labelled as the mean it is', async () => {
	const ctx = await ready();
	ctx.data.analytics = {
		...ANALYTICS,
		series: ANALYTICS.series.map((s) => (s.metric === 'route_page_age' ? withoutBucketMedians(s) : s)),
	};
	const text = textOf(ctx);
	assert.match(text, /predates per-bucket medians/);
	// And it still draws something, rather than an empty chart.
	assert.match(text, /2\.50×/);
});

test('the origin cost column is what a miss typically costs, not its tail', async () => {
	const ctx = await ready();
	const text = textOf(ctx);
	// miss-reason fetches: 140 at 800ms, 100 at 120ms, 10 at 3000ms => median 616ms.
	assert.match(text, /origin median/);
	assert.match(text, /616ms/);
});

test('the KPI strip separates a coverage miss from every other non-hit', async () => {
	const ctx = await ready();
	const text = textOf(ctx);
	// 250 misses of 1,010 serves, but 100 of them 404 at the origin: 150/1010 = 15% is the number
	// this deployment can actually act on.
	assert.match(text, /Coverage miss/);
	assert.match(text, /15%/);
	// And the families are all named, each with its own fix.
	for (const family of ['Coverage', 'Cadence', 'Integrity']) assert.match(text, new RegExp(family));
});

// ---- misses the origin cannot serve -----------------------------------------

test('originVerdict separates "nobody has this page" from "the origin is broken"', () => {
	assert.equal(originVerdict(200), 'served');
	assert.equal(originVerdict(301), 'served');
	assert.equal(originVerdict(404), 'absent');
	assert.equal(originVerdict(410), 'absent');
	assert.equal(originVerdict(403), 'client-error');
	assert.equal(originVerdict(503), 'server-error');
	// 0 is the emitter's "the fetch itself failed before any status arrived".
	assert.equal(originVerdict(0), 'connect-fail');
	assert.equal(originVerdict(null), 'connect-fail');
	assert.equal(originVerdict('nonsense'), 'connect-fail');
});

test('coverage is netted of pages the origin does not have', () => {
	const serves = ANALYTICS.series.filter((s) => s.metric === 'bot_serve');
	const split = coverageSplit({ serves, costs: originCostByReason(ANALYTICS), filter: null });
	assert.equal(split.missServes, 250);
	assert.equal(split.absent, 100);
	assert.equal(split.net, 150);
	assert.equal(split.netable, true);
});

test('a 5xx from the origin is NOT netted out — that one is a real problem, just not ours to cache', () => {
	const serves = ANALYTICS.series.filter((s) => s.metric === 'bot_serve');
	const { net } = coverageSplit({ serves, costs: originCostByReason(ANALYTICS), filter: null });
	// 250 − 100 absent = 150. The ten 503s stay in, because a page the origin failed to serve is
	// still a page that exists.
	assert.equal(net, 150);
});

test('under a bot filter the netting is switched OFF rather than estimated', () => {
	const serves = ANALYTICS.series.filter((s) => s.metric === 'bot_serve' && s.type === 'bingbot');
	const split = coverageSplit({ serves, costs: originCostByReason(ANALYTICS), filter: new Set(['bingbot']) });
	// origin_fetch carries no bot, so its 100 absent rows are all-bots and cannot be subtracted
	// from one bot's 150 misses. Scaling one population by the other's share would be a guess
	// wearing a KPI's clothes — and it could even go negative.
	assert.equal(split.netable, false);
	assert.equal(split.net, split.missServes);
});

test('the excluded population is shown, explained, and never silently dropped', async () => {
	const ctx = await ready();
	const text = textOf(ctx);
	assert.match(text, /Not found at origin/);
	assert.match(text, /100 of the misses \(40%\) were 404 or 410 at the origin/);
	// The two things that make it actionable: it is not a corpus gap, and it cannot improve.
	assert.match(text, /not a\s+coverage gap/);
	assert.match(text, /only a 200 is ever scheduled/);
});

test('each verdict says what the origin actually answered', async () => {
	const ctx = await ready();
	const text = textOf(ctx);
	// 140 served / 100 absent / 10 server-error of 250 miss-driven fetches.
	assert.match(text, /served 56%/);
	assert.match(text, /absent 40%/);
	assert.match(text, /server-error 4%/);
});

test('a filtered window says the origin columns are all-bots rather than quietly mixing them', async () => {
	const ctx = await ready();
	ctx.data.bots = ['bingbot'];
	const text = textOf(ctx);
	assert.match(text, /not netted: the origin 404 split is all-bots/);
	assert.match(text, /origin_fetch carries no bot dimension/);
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

// ---- the discovery gate ------------------------------------------------------
//
// A gated request is still SERVED — it just never enters the render rotation — so nothing about
// this panel is a failure count. What it has to keep straight is that the number is gated MISSES
// (repeat misses on an already-refused URL included), not URLs prevented, and that a deployment
// which has never configured a gate gets the capability described rather than an empty chart.

const gated = (reason, bot, count) => combo('prerender_ops', 'discovery_gated', reason, bot, count);

test('the gate panel splits the two gates and ranks the bots behind them', async () => {
	const ctx = makeCtx({
		analytics: {
			...ANALYTICS,
			series: [...ANALYTICS.series, gated('route', 'Googlebot', 900), gated('bot', 'SomeCrawler', 300)],
		},
	});
	await load(ctx);
	const text = textOf(ctx);
	assert.match(text, /Gated misses/);
	assert.match(text, /1\.2k/);
	assert.match(text, /SomeCrawler/);
	// The two gates answer different questions — a route whose URL space is combinatorial, versus a
	// crawler that should not be minting at all — and they are fixed in different places.
	assert.match(text, /discoverTargets: false/);
	assert.match(text, /ingress.discoveryBots/);
});

test('a gated miss is counted as traffic held out, never as a URL prevented', async () => {
	const ctx = makeCtx({
		analytics: { ...ANALYTICS, series: [...ANALYTICS.series, gated('route', 'Googlebot', 900)] },
	});
	await load(ctx);
	assert.match(textOf(ctx), /not a count of URLs prevented/);
});

test('the bot filter narrows the gate panel, because discovery_gated carries the bot', async () => {
	const ctx = makeCtx({
		analytics: {
			...ANALYTICS,
			series: [...ANALYTICS.series, gated('route', 'Googlebot', 900), gated('route', 'SomeCrawler', 300)],
		},
	});
	await load(ctx);
	ctx.data.bots = ['SomeCrawler'];
	const text = textOf(ctx);
	assert.match(text, /300/);
	assert.doesNotMatch(text, /1\.2k/, 'the filtered total must not include the bot that was filtered out');
});

test('a deployment with no gate configured is told what the gate is for, not shown an empty chart', async () => {
	const ctx = await ready();
	// CONFIG gates /catalog/, so start from a config that gates nothing at all.
	const open = {
		...CONFIG,
		layers: CONFIG.layers.map((layer) =>
			layer.path === 'ingress.routes'
				? { ...layer, effective: layer.effective.map(({ discoverTargets, ...rest }) => rest) }
				: layer
		),
	};
	const plain = makeCtx({ config: open });
	await load(plain);
	const text = textOf(plain);
	assert.match(text, /not configured/);
	assert.match(text, /crawlers walk novel combinations into permanent render load/);
	assert.ok(ctx);
});

test('a configured gate that refused nothing says so, rather than reading as unconfigured', async () => {
	// CONFIG gates /catalog/ and the window carries no discovery_gated rows.
	const ctx = await ready();
	const text = textOf(ctx);
	assert.match(text, /1 route gated/);
	assert.match(text, /refused nothing in this window/);
});
