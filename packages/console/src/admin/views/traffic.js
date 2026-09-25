/**
 * Traffic: what crawlers got, from where, how fast, how fresh — the delivery half of the
 * metric catalog, charted from ONE bounded analytics scan per node per refresh.
 *
 * THE FOUR QUESTIONS this view answers are the catalog's own (METRICS.md §1): are we taking
 * load off the origin (bot_serve source), is the cache hit and fresh (bot_serve status +
 * page_age), what does a non-cache serve cost (origin_fetch), and which route's cadence
 * should move (route_serve / route_page_age). The panels are ordered exactly that way.
 *
 * FRESHNESS IS SHOWN RELATIVE, because an age in milliseconds is not a verdict. A snapshot two
 * hours old is healthy on a 6h route and two hours overdue on an hourly one, and this deployment
 * runs both. `expiresAt` is written as `now + interval` when a render lands (RenderQueue), so the
 * served age divided by that route's configured cadence is a number with a fixed meaning
 * everywhere: under 1.0 the page was inside the window it was rendered for, at 1.0 it was due,
 * and past it the fleet is not keeping the cadence — the same threshold on every route, which is
 * what makes routes comparable at a glance and what the old absolute chart could not do. The
 * cadence comes from `ingress.routes[].renderInterval` (already loaded for the settings cards, so
 * it costs no request), falling back to `render.defaultInterval`. Absolute milliseconds stay one
 * click away, and the KPI carries both.
 *
 * OFFLOAD IS STATED TWICE, GROSS AND NET, because the number the rollout is judged on is not the
 * one the serve path can see. Gross offload is the share of crawler requests that were not proxied
 * to the origin live — `bot_serve` source ≠ origin — and it is what every serve-side panel here is
 * built from. It is also flattering: it counts what the origin was spared and none of what this
 * system asks of the origin in exchange — every render, every change probe, every sitemap fetch is
 * an origin request. Net offload subtracts those (`originLoad` in charts.js carries the arithmetic
 * and its caveats), and the panel beside the origin-fetch chart shows each term. One term it
 * cannot count is stated rather than omitted: the requests a page's own scripts make when a
 * rendering crawler runs it, which never pass through this plugin and are missing from BOTH sides
 * — the origin would have served them for every raw page-view, and does not for a snapshot served
 * without scripts. The net tile says "before crawler follow-up requests" and the panel reports the
 * exposure — every page handed to a crawler — as a count, never multiplied by a guessed factor.
 *
 * AND NOT EVERY MISS IS OURS. A miss whose origin fetch came back 404 or 410 is a URL that does
 * not exist anywhere — there is nothing for the cache to be missing, and it can never improve,
 * because only a 200 is ever scheduled for prerendering. Left in the coverage number those URLs
 * make a complete corpus look broken, and at crawler volume they are not a rounding error. So the
 * coverage figures are stated NET of them, with the excluded population shown beside the number
 * rather than quietly dropped. The netting is exact — a miss that proxies emits one bot_serve row
 * and one origin_fetch row — except under a bot filter, where origin_fetch carries no bot name;
 * there the tile says it is not netted instead of scaling one population by the other's share.
 *
 * NOT EVERY NON-HIT IS A MISS. "miss" is one of ten freshness verdicts and the only one that
 * means what the word implies — nothing cached under the key. The others are a page served past
 * its cadence (`swr`), one past the SWR window entirely (`stale`), a body that could not be read
 * although the key is cached and scheduled (`blob-missing` / `blob-timeout`, rescued or not), a
 * serve a bulk invalidation cost us (`invalidated`), a miss answered from a stored ORIGIN document
 * rather than a snapshot (`raw`), and requests where the cache was never consulted at all (`skip`,
 * `bypass`). They have five different fixes — corpus coverage, render cadence, blob integrity,
 * nothing-to-fix, and a setting — so they get their own panel rather than one bar labelled "miss",
 * with what each one cost at the origin beside it.
 *
 * `raw` IS A CACHE SERVE AND NEVER A HIT. `render.raw` keeps the document a miss already fetched,
 * for URLs that own no target and never will, so the next crawler is answered from storage: it
 * spares the origin exactly as a snapshot does, and it counts in Cache-served and in offload. But
 * no browser ran on it, it has no cadence to be measured against, and it emits no `page_age` — so
 * it is deliberately absent from every freshness number on this view. Its own panel reports what
 * the store REFUSED, because an enabled route filling nothing is otherwise indistinguishable from
 * one nobody enabled.
 *
 * THE BOT FILTER IS CLIENT-SIDE, ALWAYS. Selecting bots re-renders from the payload already in
 * hand; it never refetches, because the load discipline below is the whole reason this view can
 * afford to be this detailed. Four metrics carry a bot (`bot_request`, `bot_serve`, `page_age`,
 * and `prerender_ops`'s `discovery_gated`) and the rest do not — `route_serve`, `origin_fetch`,
 * `render`, the probe and sitemap counters, `duration` and `response_*` have no bot dimension at
 * all — so a panel that CANNOT honour the filter says "all bots" on its face rather than quietly
 * showing every crawler's numbers under one crawler's name. Net offload is one of those: a render
 * is not for any one crawler.
 *
 * LOAD DISCIPLINE. Every number on this view comes from a single `analytics` request; each
 * node answers it from a per-worker cache inside `management.analytics.cacheTtl`, so switching
 * ranges back and forth, a view switch, a bot selection, or a second operator does not multiply
 * scans. Under cluster scope that is one cached scan PER NODE — N times a bounded read, not N
 * times a table walk — and the footer states what the refresh actually cost on every node. This
 * console shares its upstreams' workers with bot traffic, and a dashboard that can slow a node
 * down owes the operator the number. Crawl breadth is the one extra query (its own capped scan
 * of the sketch table); the sketches replicate, so it is read from one node and loads only on
 * an explicit click.
 *
 * SCOPE HONESTY. Analytics rows are node-local, so a cluster total is a SUM the proxy computes
 * from every node's window (util/aggregate.js) — and a sum missing a node is a wrong number,
 * not a small one, which is why an incomplete fan-out banners the whole view. Merged
 * percentiles are count-weighted approximations and are always written "≈". Every card names
 * its scope; the footer names the nodes.
 */

import { card, el, ICONS, link, muted, num, pct, pill, section, spacer, stat, stats, table } from '../ui.js';
import {
	barList,
	CACHE_STATUS_COLORS,
	chips,
	colorFor,
	emptyNote,
	fmtCount,
	fmtMs,
	fmtNet,
	fmtRate,
	fmtRatio,
	isCacheServed,
	isMerged,
	legend,
	lineChart,
	nodeColor,
	nodeEntries,
	nodeSeries,
	originLoad,
	originLoadBuckets,
	perMinute,
	pick,
	ratioOf,
	scanFooter,
	scopeLabel,
	segmented,
	SERIES,
	stackBy,
	stackedBars,
	statusCodeColor,
	sumCount,
	weighted,
	weightedBuckets,
	windowEmpty,
} from '../charts.js';
import { appliedNote, configState, editTray, loadConfig, optionIndex, settingsCard } from './_configEdit.js';

export const meta = { id: 'traffic', label: 'Traffic', icon: ICONS.traffic, ranged: true };

export async function load(ctx) {
	// Relative by default: "1.4x the cadence" is a verdict, "4h" is a number the operator then has
	// to look a config value up for. Absolute stays one click away in the panel head.
	ctx.data.ageMode ??= 'ratio';
	ctx.data.bots ??= [];
	// Concurrent because the two are unrelated: the config read is usually already satisfied from
	// the shared scratch, and when it is not it must still not add a round trip to the range switch.
	const [res] = await Promise.all([ctx.get('analytics', { range: ctx.rangeMs }), loadConfig(ctx)]);
	ctx.data.analytics = res.ok ? res.body : null;
	ctx.data.error = res.ok ? null : (res.body?.error ?? `Could not load analytics (${res.status})`);
}

export function render(ctx) {
	const data = ctx.data.analytics;

	// The settings ride along on the EMPTY exits too, not just the charted one. `analytics.enabled`
	// is the likeliest reason this view has nothing to show, so the card that flips it belongs on
	// the screen reporting the emptiness rather than a view away.
	const knobs = [settings(ctx), editTray(ctx)];

	if (!data)
		return [appliedNote(ctx), el('div', { cls: 'note bad', text: ctx.data.error ?? 'No analytics data.' }), knobs];
	if (data.available === false) return [appliedNote(ctx), el('div', { cls: 'note bad', text: data.error }), knobs];

	if (windowEmpty(data)) {
		return [appliedNote(ctx), card('No traffic recorded', { body: [emptyNote('analytics', data)] }), knobs];
	}

	const filter = botFilter(ctx);
	const serves = pick(data, 'bot_serve', (s) => keepBot(filter, s.type));
	const requests = pick(data, 'bot_request', (s) => keepBot(filter, s.method));
	const ages = pick(data, 'page_age', (s) => keepBot(filter, s.path));
	const cadences = cadenceIndex(configState(ctx).payload, data.intervals?.defaultRenderInterval);
	// Over ALL bots whatever the filter says: three of its four terms carry no bot (see the header).
	const load = originLoad(data);
	const scope = { serves, requests, ages, cadences, filter, load };

	return [
		appliedNote(ctx),
		botBar(ctx, data, filter),
		filter && !serves.length ? el('div', { cls: 'note warn', text: noSelectedBotTraffic(filter) }) : null,
		kpis(data, scope),
		el('div', { cls: 'cols' }, [freshness(data, scope), staleness(ctx, data, scope)]),
		instances(data, filter),
		notFreshHit(data, scope),
		// The two origin-side panels together: what the origin was asked, then what each ask cost.
		el('div', { cls: 'cols' }, [originSeen(data, scope), originFetch(data, filter)]),
		el('div', { cls: 'cols' }, [latency(data, filter), statusCodes(data, filter)]),
		crawlers(data, scope),
		routes(ctx, data, cadences, filter),
		// The two panels about URLs the rotation does not cover, together: the gate is what keeps them
		// out of it, and the raw cache is what answers them anyway.
		discoveryGate(ctx, data, filter),
		rawCache(ctx, data, filter),
		breadth(ctx, filter),
		el('div', { cls: 'scan-foot' }, [scanFooter(data)]),
		knobs,
	];
}

// ---- by instance ------------------------------------------------------------
//
// The cluster total hides the one failure a load-balanced deployment actually has: traffic that is
// not balanced. GTM weighting, a node that dropped out of rotation, or one node whose cache is cold
// after a restart all look like nothing in a sum. Per-node buckets come from the merge
// (`perNodeBuckets` in util/aggregate.js), collapsed over the bot slot — so this panel cannot honour
// the bot filter and says so.

const CACHE_SOURCE_ORIGIN = 'origin';

function instances(data, filter) {
	const entries = nodeEntries(data);
	if (!entries.length) {
		// Node scope has nothing to compare; a merge from before per-node buckets has no time axis. The
		// first is the common case and deserves one line pointing at the picker, not an empty card.
		return isMerged(data)
			? null
			: el('div', { cls: 'hint', text: 'Viewing one node — pick “all nodes” to compare instances.' });
	}

	const window = coveredMs(data);
	const serveTotals = entries.map((entry) => {
		const serves = entry.buckets.filter((s) => s.metric === 'bot_serve');
		const total = serves.reduce((acc, s) => acc + s.count, 0);
		return {
			entry,
			total,
			cache: serves.filter((s) => isCacheServed(s.method)).reduce((acc, s) => acc + s.count, 0),
			origin: serves.filter((s) => s.path === CACHE_SOURCE_ORIGIN).reduce((acc, s) => acc + s.count, 0),
			renders: entry.buckets.filter((s) => s.metric === 'render').reduce((acc, s) => acc + s.count, 0),
		};
	});
	const clusterTotal = serveTotals.reduce((acc, row) => acc + row.total, 0);
	const even = clusterTotal / entries.length;

	const series = entries.map((entry, i) => ({
		label: entry.label,
		color: nodeColor(i),
		points: perMinute(nodeSeries(entry, data.bucketCount, 'bot_serve'), data.bucketMs),
	}));

	const rows = serveTotals.map(({ entry, total, cache, origin, renders }, i) => {
		const skew = even > 0 ? total / even : null;
		return el('tr', null, [
			el('td', { cls: 'mono nowrap' }, [
				el('span', { cls: 'swatch', style: { background: nodeColor(i) } }),
				entry.label,
			]),
			el('td', { cls: 'right mono', text: num(total) }),
			el('td', { cls: 'right mono', text: window ? fmtRate(total / (window / 60_000)) : '—' }),
			el('td', { cls: 'right' }, [
				el('span', {
					// ±35% of an even split is the flag: GTM weights are rarely exact, and a node carrying a
					// third more or less than its peers is the imbalance worth seeing.
					cls: skew !== null && Math.abs(skew - 1) > 0.35 ? 'pill warn' : 'mono',
					text: pct(total, clusterTotal),
					title: skew !== null ? `${fmtRatio(skew)} an even split` : null,
				}),
			]),
			el('td', { cls: 'right mono', text: pct(cache, total) }),
			el('td', { cls: 'right mono', text: pct(total - origin, total) }),
			el('td', { cls: 'right mono muted', text: window ? `${fmtCount(renders / (window / 3_600_000))}/h` : '—' }),
		]);
	});

	return card('By instance', {
		head: [
			spacer(),
			allBotsTag(filter, 'per-node series are collapsed over the bot dimension'),
			legend(series.map(({ label, color }) => ({ label, color }))),
		],
		help:
			'Bot serves per minute on each node, and each node’s share of the cluster. A share far from an even split is ' +
			'load-balancer weighting or a node out of rotation; a node with a much lower cache-served share has a cold or ' +
			'missing cache. Renders/h is results that node posted — see Queue for per-node render detail.',
		body: [
			el('div', { cls: 'split' }, [
				el('div', null, [lineChart(data, series, { format: fmtRate })]),
				table(
					[
						'node',
						{ text: 'serves', right: true },
						{ text: 'rate', right: true },
						{ text: 'share', right: true },
						{ text: 'cache-served', right: true },
						{ text: 'offload', right: true },
						{ text: 'renders', right: true },
					],
					rows
				),
			]),
		],
	});
}

// ---- the bot filter ---------------------------------------------------------
//
// A selection, not a query. It narrows what is already in `ctx.data.analytics`, so every panel
// below re-renders from the same bytes and the upstream nodes see nothing at all.

/** Chips beyond this are tail traffic; the note says how many were left off. */
const MAX_BOT_CHIPS = 14;

/** The selected bots as a Set, or null for "all" — the shape every panel tests against. */
const botFilter = (ctx) => {
	const selected = new Set(ctx.data.bots ?? []);
	return selected.size ? selected : null;
};

/**
 * Does this combo belong to the selection? `name` is whichever slot carries the bot on that
 * metric (they differ — see the catalog), and an absent name is the plugin's own 'other' bucket.
 */
const keepBot = (filter, name) => !filter || filter.has(name ?? 'other');

const noSelectedBotTraffic = (filter) =>
	`No serves from ${[...filter].join(', ')} in this window. The panels below are empty because of the ` +
	'filter, not because nothing was served — clear it, or widen the range.';

/** Every bot in the window, ranked by serves, with its ingress count alongside. */
function botTotals(data) {
	const totals = new Map();
	const entry = (bot) => {
		let row = totals.get(bot);
		if (!row) totals.set(bot, (row = { bot, serves: 0, requests: 0 }));
		return row;
	};
	for (const s of pick(data, 'bot_serve')) entry(s.type ?? 'other').serves += s.count;
	for (const s of pick(data, 'bot_request')) entry(s.method ?? 'other').requests += s.count;
	return [...totals.values()].sort((a, b) => b.serves - a.serves || b.requests - a.requests);
}

function botBar(ctx, data, filter) {
	const ranked = botTotals(data);
	if (!ranked.length) return null;

	const shown = ranked.slice(0, MAX_BOT_CHIPS);
	// A SELECTED bot always gets a chip, even when it has fallen out of the top N or out of the
	// window entirely on a range switch. Otherwise the only control that can clear the filter
	// disappears and the operator is left with panels that look empty for no visible reason.
	for (const bot of ctx.data.bots ?? []) {
		if (!shown.some((row) => row.bot === bot)) shown.push(ranked.find((row) => row.bot === bot) ?? { bot, serves: 0 });
	}
	const shownBots = new Set(shown.map((row) => row.bot));
	const hidden = ranked.filter((row) => !shownBots.has(row.bot)).length;

	const toggle = (bot) => {
		const next = new Set(ctx.data.bots ?? []);
		if (next.has(bot)) next.delete(bot);
		else next.add(bot);
		ctx.data.bots = [...next];
		// RENDER, never reload: the payload in hand already holds every bot's rows.
		ctx.render();
	};

	return el('div', { cls: 'filterbar' }, [
		el('span', { cls: 'filter-label', text: 'Bots' }),
		el('button', {
			cls: `chip${filter ? '' : ' on'}`,
			text: 'all',
			title: 'Clear the filter — every crawler in the window.',
			onclick: () => {
				ctx.data.bots = [];
				ctx.render();
			},
		}),
		chips(
			shown.map(({ bot, serves }) => ({
				value: bot,
				label: bot,
				sub: fmtCount(serves),
				title: `${bot}: ${num(serves)} serves in this window`,
			})),
			{ isOn: (bot) => !!filter?.has(bot), onToggle: toggle }
		),
		hidden > 0 && muted(`+${hidden} smaller`),
		filter &&
			el('span', {
				cls: 'muted',
				text: 'panels tagged “all bots” can’t filter',
				title: 'Filters serves, freshness, staleness, page age, the crawler mix and the discovery gate.',
			}),
	]);
}

/** The tag an unfilterable panel wears while a filter is on, so its numbers are not misread. */
const allBotsTag = (filter, why) =>
	filter &&
	el('span', { title: `${why} — this metric has no bot dimension, so the filter cannot apply.` }, [
		pill('all bots', 'info'),
	]);

// ---- cadence (the yardstick every freshness number is measured against) -----

/** Route labels that are a CLASS rather than a configured route (see recordServeOutcome). */
const CLASS_LABELS = {
	unclassified: 'unclassified',
	unrouted: 'unrouted',
	passthrough: 'passthrough',
	prerender: 'prerender',
};

/**
 * Route label → `{ mode, interval, inherited }`, built from the config payload this view already
 * loaded for its settings cards.
 *
 * The label a serve was recorded under is the matched route's own `path` (metrics.js), so the
 * join is exact rather than a re-implementation of the plugin's matcher — this never has to
 * decide which route a URL matched, only what the route it already matched is configured to do.
 *
 * `excludePathPatterns` entries come FIRST because the plugin PREPENDS them to the compiled route
 * list and first match wins: a path that is both excluded and declared prerender is served as a
 * passthrough, and a table that read the prerender entry would flag its (entirely expected) miss
 * rate as a coverage failure.
 */
export function cadenceIndex(configPayload, defaultInterval) {
	const index = new Map();
	const options = optionIndex(configPayload);

	const add = (path, mode, renderInterval, extra = {}) => {
		if (typeof path !== 'string' || path === '' || index.has(path)) return;
		const own = mode === 'prerender' && Number.isFinite(renderInterval) && renderInterval > 0;
		index.set(path, { mode, interval: own ? renderInterval : defaultInterval, inherited: !own, ...extra });
	};

	for (const pattern of options.get('ingress.excludePathPatterns')?.effective ?? []) add(pattern, 'passthrough');
	for (const entry of options.get('ingress.routes')?.effective ?? []) {
		if (!entry || typeof entry !== 'object') continue;
		add(entry.path, entry.mode === 'passthrough' ? 'passthrough' : 'prerender', Number(entry.renderInterval), {
			// Both default to "unset", and the difference matters: `discoverTargets` defaults to TRUE
			// upstream, so an absent flag is an OPEN route, not an unknown one. `demandFloor` has no
			// default — absent means the demand ladder may take this route's pages to any rung.
			discoverTargets: entry.discoverTargets !== false,
			demandFloor:
				Number.isFinite(Number(entry.demandFloor)) && Number(entry.demandFloor) > 0 ? Number(entry.demandFloor) : null,
		});
	}
	return index;
}

/**
 * The cadence one route label is measured against. An unmatched label is a CLASS (the plugin fell
 * back to `routeClass` because no route matched), and those inherit the default interval — which
 * is only meaningful for the ones that are cached at all.
 */
export const cadenceFor = (index, label, defaultInterval) =>
	index.get(label) ?? {
		mode: CLASS_LABELS[label] ?? 'unknown',
		interval: defaultInterval,
		inherited: true,
		// Null, not `true`: no route matched, so there is no route flag to report. Printing the
		// upstream default here would claim a configuration this label does not have.
		discoverTargets: null,
		demandFloor: null,
	};

/** Whether a route's staleness is a verdict about US, or just a fact about a path we never cache. */
const isPrerender = (cadence) => cadence.mode === 'prerender' || cadence.mode === 'unknown';

/**
 * The combos, and the divisor to normalize each one by.
 *
 * Unfiltered, `route_page_age` is the better source for the same samples: it is emitted beside
 * `page_age` on every cache serve, so the population is identical, but it carries the route — and
 * therefore each sample's OWN cadence rather than one global default. Filtered by bot, only
 * `page_age` carries the bot, and the default interval is the only yardstick available; the panel
 * says which of the two it used.
 */
function stalenessBasis(data, { ages, cadences, filter }) {
	const fallback = data.intervals?.defaultRenderInterval;
	// Every route falls back to the default when it sets no cadence of its own, so ONE missing
	// default is the whole yardstick missing. Without it a ratio could still be computed over the
	// routes that do set an interval — a number covering part of the traffic, presented as if it
	// covered all of it. Both readers of this basis check the flag and show milliseconds instead.
	const normalizable = Number.isFinite(fallback) && fallback > 0;
	const routed = pick(data, 'route_page_age');
	if (!filter && routed.length) {
		return {
			combos: routed,
			scaleOf: (s) => cadenceFor(cadences, s.path, fallback).interval,
			basis: 'route',
			fallback,
			normalizable,
		};
	}
	return { combos: ages, scaleOf: () => fallback, basis: 'default', fallback, normalizable };
}

/** The span the numbers actually cover — the truncated window when the scan hit its cap. */
const coveredMs = (data) => {
	const from = data.coveredFromMs ?? data.startMs;
	const to = data.coveredToMs ?? data.endMs;
	return Number.isFinite(from) && Number.isFinite(to) && to > from ? to - from : null;
};

// ---- KPIs -------------------------------------------------------------------

function kpis(data, scope) {
	const { serves, requests, filter } = scope;
	const total = sumCount(serves);
	const originServes = sumCount(serves.filter((s) => s.path === 'origin'));
	// BY VERDICT, NOT BY SOURCE. Until plugin v0.76.0 the two agreed — every cache-served verdict
	// carried source `cache`, `peer-rescue` included — so this counted `path === 'cache'` and got the
	// right answer. `raw` broke that: it is a cache serve with its OWN source, so the source test
	// would have dropped it and this tile would have fallen as the feature started working, while
	// gross offload rose. `isCacheServed` is the enumeration charts.js says every such sum must
	// share, and this is now one of them.
	const rawServes = sumCount(serves.filter((s) => s.path === 'raw'));
	const cacheServes = sumCount(serves.filter((s) => isCacheServed(s.method)));
	const freshHits = sumCount(serves.filter((s) => s.method === 'hit'));
	const coverage = coverageSplit({ serves, costs: originCostByReason(data), filter });
	const arrived = sumCount(requests);
	const { load } = scope;

	// SERVE TIME IS TWO POPULATIONS, and one number over both is a number about the hit rate. A
	// cache hit is single-digit milliseconds and an origin proxy is hundreds; pooling them produces
	// a figure that improves when offload improves and says nothing about how fast either path is.
	// Measured on this deployment: hits median 1.8ms, origin-proxied median 371ms, pooled 171ms —
	// where the pooled number moves with the 54/46 split, not with speed.
	const hitDurations = pick(data, 'duration', (s) => s.type === 'cache-hit');
	const otherDurations = pick(data, 'duration', (s) => s.type !== 'cache-hit');
	const hitMedian = weighted(hitDurations, 'median');
	const hitP95 = weighted(hitDurations, 'p95');
	const otherMedian = weighted(otherDurations, 'median');

	const { combos, scaleOf, basis, fallback, normalizable } = stalenessBasis(data, scope);
	const ageMedian = weighted(combos, 'median');
	// The MEDIAN leads here. A page's age walks 0 → its interval and is re-rendered, so an evenly
	// refreshed corpus sits at 0.5x by construction and its p95 already sits at ~0.95x — which
	// leaves the p95 no headroom at all before it reads as "behind" on a fleet that is not.
	// Above 1.0 the median means something unambiguous instead: most cache serves were past due.
	const stalenessMedian = normalizable ? weighted(combos, 'median', scaleOf) : null;
	const stalenessP95 = normalizable ? weighted(combos, 'p95', scaleOf) : null;

	// `bot_serve` is emitted once per request that RESOLVED to a resource, `bot_request` once per
	// request that arrived — both under the same gate. A gap is therefore requests that never
	// reached a serve outcome (an unusable forwarded host, a handler throw), which is invisible
	// everywhere else on this page: the serve panels can only ever chart what was served.
	const unresolved = arrived - total;
	const unresolvedShare = arrived > 0 ? unresolved / arrived : 0;
	const window = coveredMs(data);
	const perMinute = window ? total / (window / 60_000) : null;
	// A rate is what makes two ranges comparable — 40k serves means nothing until you know whether
	// it was an hour or a day. Sub-10 keeps a decimal: fmtCount would round a quiet crawl to "0/min".
	const rate = perMinute === null ? '—' : `${perMinute < 10 ? perMinute.toFixed(1) : fmtCount(perMinute)}/min`;

	return stats([
		stat('Bot serves', num(total), unresolvedShare > 0.02 ? `${num(unresolved)} never reached a serve` : rate, {
			warn: unresolvedShare > 0.02,
			title: `${num(arrived)} requests arrived at ingress; ${num(total)} resolved to a serve.`,
		}),
		stat(
			'Offload · gross',
			pct(total - originServes, total),
			'not proxied live',
			// The offload number is the rollout's headline; a majority-origin window deserves the flag.
			{
				warn: total > 0 && originServes > total / 2,
				title: 'Share of crawler requests not proxied to the origin live.',
			}
		),
		stat(
			'Offload · net',
			fmtNet(load.net),
			load.arrived > 0
				? `origin saw ${fmtCount(load.total)} of ${fmtCount(load.arrived)}${filter ? ' · all bots' : ''}`
				: 'no crawler requests',
			// Below half is a flag on either figure; below ZERO means this system is sending the origin
			// more requests than the crawlers would have on their own — the finding, not a display bug.
			{
				warn: Number.isFinite(load.net) && load.net < 0.5,
				title:
					'Gross offload minus the origin requests this system makes itself (renders, probes, sitemap fetches). ' +
					'Documents only — crawler follow-up requests are not counted on either side.',
			}
		),
		stat(
			'Cache-served',
			pct(cacheServes, total),
			// Named apart the moment there are any: a snapshot means a render covers that URL, a raw
			// document means one never will and the origin was spared anyway.
			rawServes > 0 ? `${pct(rawServes, total)} raw documents` : 'from a stored snapshot'
		),
		stat('Fresh hits', pct(freshHits, total), 'inside the cadence'),
		stat(
			'Coverage miss',
			pct(coverage.net, total),
			coverage.netable
				? `excl. ${num(coverage.absent)} origin 404s`
				: coverage.absent > 0
					? 'incl. origin 404s (filtered)'
					: 'nothing cached under the key',
			// A miss the origin CAN serve is the corpus gap; the netted figure is the one worth a flag.
			{
				warn: total > 0 && coverage.net > total / 3,
				title: 'Misses the origin could have served. A 404/410 at the origin is not a coverage gap and is excluded.',
			}
		),
		stat('Serve time', fmtMs(hitMedian), `cache hit median · origin ${fmtMs(otherMedian)}`, {
			title: `Cache-hit median ${fmtMs(hitMedian)}, p95 ${fmtMs(hitP95)}. Origin-served median ${fmtMs(otherMedian)}.${
				filter ? ' All bots.' : ''
			}`,
		}),
		stat(
			normalizable ? 'Staleness' : 'Page age',
			normalizable ? fmtRatio(stalenessMedian) : fmtMs(ageMedian),
			normalizable ? `median · ${fmtMs(ageMedian)}` : 'median',
			// On the MEDIAN, not the p95: half the serves past their own cadence is unambiguous,
			// where a p95 over 1.0 is where an evenly aged corpus lives anyway.
			{
				warn: Number.isFinite(stalenessMedian) && stalenessMedian > 1,
				title: normalizable
					? `Served age ÷ ${basis === 'route' ? 'each route’s cadence' : fmtMs(fallback)}. 1.0 = exactly due. ` +
						`p95 ${fmtRatio(stalenessP95)}.`
					: 'No render interval in the payload, so only absolute age.',
			}
		),
	]);
}

// ---- panels -----------------------------------------------------------------

/** Serves over time, stacked by freshness verdict — the cache doing (or not doing) its job. */
function freshness(data, { serves, filter }) {
	const { keys, stacks } = stackBy(serves, 'method', data.bucketCount);
	return card('Serves by freshness', {
		head: [
			filter && pill([...filter].join(', '), 'info'),
			spacer(),
			legend(keys.map((k) => ({ label: k, color: colorFor(CACHE_STATUS_COLORS, k) }))),
		],
		help:
			'hit + swr + verified + peer-rescue + raw is cache-served. A rising miss share is a coverage problem; a rising ' +
			'swr share is the fleet not keeping the cadence; blob-* should sit at zero. raw is a miss answered from a ' +
			'stored ORIGIN document — it spares the origin, but nothing rendered it, so it never counts as a hit.',
		body: [
			serves.length
				? stackedBars(data, keys, stacks, (k) => colorFor(CACHE_STATUS_COLORS, k))
				: emptyNote('bot_serve', data),
		],
	});
}

/**
 * Delivered freshness against the cadence each page was rendered for.
 *
 * Relative by default (see the module header). The absolute view is kept a click away rather than
 * deleted: a ratio answers "is the fleet keeping up", and an operator sizing an interval or
 * quoting an age to someone else still needs the milliseconds.
 */
function staleness(ctx, data, scope) {
	const { combos, scaleOf, basis, fallback, normalizable } = stalenessBasis(data, scope);
	const { serves } = scope;
	// A payload with no interval in it (an older plugin) cannot express a ratio at all. Fall back
	// rather than draw an empty chart, and say why below.
	const mode = normalizable && ctx.data.ageMode === 'ratio' ? 'ratio' : 'ms';

	const ratioP95 = normalizable ? weighted(combos, 'p95', scaleOf) : null;
	const points = (stat) => weightedBuckets(combos, stat, data.bucketCount, mode === 'ratio' ? scaleOf : undefined);
	// Plugin v0.51.0 buckets the median too. Before it, the payload carried per-bucket means and
	// p95s only — so the typical line had to be a mean, and this chart said so. Detected rather
	// than assumed: this console runs against whatever plugin a deployment has.
	const hasMedians = combos.some((c) => Array.isArray(c.medians));
	const typical = hasMedians
		? { label: 'median', points: points('medians') }
		: { label: 'mean', points: points('means') };
	const series = [
		{ label: 'p95', color: SERIES[2], points: points('p95s') },
		{ label: typical.label, color: SERIES[1], points: typical.points },
	];
	const any = series.some((s) => s.points.some((p) => Number.isFinite(p)));

	// On the relative chart both reference lines are fixed for every route at once: 1.0 is due,
	// and 1 + swrTtl/interval is where a page stops being servable and the next request falls
	// through to the origin. On the absolute chart only the default interval can be drawn.
	const swrTtl = Number(optionIndex(configState(ctx).payload).get('page.swrTtl')?.effective);
	// The SWR ceiling is only a single line when a single interval is the divisor. Normalized per
	// route it lands somewhere different for every route, so it is not drawn — and the note below
	// must not describe a line that isn't there.
	const swrOverInterval = ratioOf(swrTtl, fallback);
	const swrBand = mode === 'ratio' && basis === 'default' && swrOverInterval !== null ? 1 + swrOverInterval : null;
	const bands = mode === 'ratio' ? [1, swrBand].filter(Number.isFinite) : fallback;

	// Ages that computed NEGATIVE are dropped at the emit site (cross-node clock skew), so the
	// distribution above is missing them. Silence would make a skewed cluster look like a healthy
	// one with fewer samples.
	const discarded = sumCount(pick(data, 'prerender_ops', (s) => s.path === 'page_age_negative'));

	// THE VERDICTS ARE THE AUTHORITY, AND THIS RATIO IS A PROXY. `hit` / `swr` / `stale` are decided
	// per request against that page's OWN expiry, which is `lastCached + the interval it actually
	// ran on`. This panel can only divide by the interval the ROUTE is configured with, and those
	// differ whenever a target's cadence comes from its stored value (a sitemap `changefreq`)
	// instead — a case no metric exposes. When the two disagree, the verdicts win and the divisor
	// is what is wrong, so say that rather than let a config gap read as a fleet failure.
	//
	// THE DENOMINATOR IS THE SERVES THAT PRODUCED THE DISTRIBUTION, which is the serves whose SOURCE
	// was `cache` — `page_age`/`route_page_age` are emitted only on that branch. It is deliberately
	// not `isCacheServed`, which since plugin v0.76.0 also contains `raw`: a raw document contributes
	// no age sample, so counting it here would shrink the past-due share on exactly the deployments
	// that serve a lot of raw and fire this note against a fleet that is genuinely behind.
	const agedServes = sumCount(serves.filter((x) => x.path === 'cache'));
	const pastDue = sumCount(serves.filter((x) => x.method === 'swr' || x.method === 'stale'));
	const contradicted =
		normalizable && Number.isFinite(ratioP95) && ratioP95 > 1 && agedServes > 0 && pastDue / agedServes < 0.01;

	return card(mode === 'ratio' ? 'Staleness at serve (÷ cadence, ≈)' : 'Page age at serve (≈)', {
		head: [
			spacer(),
			legend(series.map(({ label, color }) => ({ label, color }))),
			segmented(
				[
					{ label: '÷ cadence', value: 'ratio', title: 'Served age divided by the render interval for that route.' },
					{ label: 'absolute', value: 'ms', title: 'Served age in milliseconds.' },
				],
				mode,
				(next) => {
					ctx.data.ageMode = next;
					ctx.render();
				}
			),
		],
		help: [
			mode === 'ratio'
				? 'Cache serves only. 1.0 is “exactly due”: a page expires one render interval after it was stored, so ' +
					'above the line the fleet is not keeping the cadence. ' +
					(swrBand
						? `The upper line (${fmtRatio(swrBand)}) is interval + page.swrTtl, past which a page is not served at all. `
						: '')
				: 'Cache serves only. The dashed line is the default render interval. ',
			basis === 'route'
				? 'Each sample is measured against its own route’s renderInterval, so routes on different cadences compare. '
				: `Measured against ${fmtMs(fallback)} (the default interval) — a bot-filtered window has no route. `,
			'An evenly refreshed corpus sits at median 0.50× and p95 ~0.95× by construction, so the median is the number ',
			'with headroom.',
			hasMedians ? '' : ' This plugin predates per-bucket medians (v0.51.0), so the typical line is the mean.',
		],
		body: [
			any
				? lineChart(data, series, { band: bands, format: mode === 'ratio' ? fmtRatio : fmtMs })
				: emptyNote('page_age', data),
			contradicted &&
				el('div', { cls: 'note' }, [
					el('strong', { text: 'The freshness verdicts disagree with this ratio, and they win. ' }),
					`Only ${pct(pastDue, agedServes)} of snapshot serves were past due — the divisor is short. Targets `,
					'whose cadence comes from a sitemap ',
					el('code', { text: 'changefreq' }),
					' are measured against the route’s interval; set the route’s renderInterval to match.',
				]),
			!normalizable && el('div', { cls: 'empty', text: 'No render interval in the payload — absolute age only.' }),
			discarded > 0 &&
				el('div', {
					cls: 'note warn',
					text: `${num(discarded)} serve(s) had a negative age and were dropped — cross-node clock skew.`,
				}),
		],
	});
}

// ---- what a non-hit actually was ---------------------------------------------
//
// The taxonomy this panel exists for. Each family is a different FIX, which is the only grouping
// worth putting on a dashboard: an operator arriving with "our miss rate is 40%" needs to know
// within one screen whether to widen the corpus, add render capacity, chase blob integrity, or
// stop worrying.

const FAMILIES = [
	{
		key: 'coverage',
		label: 'Coverage',
		hint: 'the corpus does not have it',
	},
	{
		key: 'cadence',
		label: 'Cadence',
		hint: 'cached, but behind its render interval',
	},
	{
		key: 'integrity',
		label: 'Integrity',
		hint: 'cached and scheduled; the body could not be read',
	},
	{
		key: 'invalidated',
		label: 'Invalidation',
		// One family for both halves, because they are one population — the pages a bulk
		// invalidation touched — split by what happened next: refused (`invalidated`, proxied to the
		// origin) or rescued (`verified`, served from cache on the probe's evidence). Read against
		// each other they size what per-page verification is buying; apart, neither means much.
		hint: 'a bulk invalidation touched the serve — refused, or rescued on evidence',
	},
	{
		key: 'raw',
		label: 'Raw document',
		// Not a fresh hit and not a problem: the request was a miss, and a stored ORIGIN document
		// answered it instead of a live proxy. Its own family because every other one names something
		// to fix — this one names a miss that cost the origin nothing, on a URL nothing will ever
		// render. Folding it into cadence or coverage would report the feature working as a fault.
		hint: 'a miss answered from a stored origin document — never rendered, so it has no cadence',
	},
	{
		key: 'not-cacheable',
		label: 'Not cacheable',
		hint: 'the cache was never consulted',
	},
];

/**
 * Every freshness verdict except `hit`, with the family it belongs to and what it means. Anything
 * absent here (a verdict a newer plugin emits) falls through to an "other" family rather than
 * being silently folded into one of these — a new value must never inherit someone else's fix.
 */
const NOT_HIT = {
	'miss': ['coverage', 'nothing cached under this key — it has never rendered, or it is not in the corpus'],
	'swr': ['cadence', 'past due, inside the stale-while-revalidate window — still served from cache'],
	'stale': ['cadence', 'past the SWR window — nothing servable was left, so we went elsewhere'],
	'blob-missing': ['integrity', 'the record is cached, but its stored body is gone (dangling blob)'],
	'blob-timeout': ['integrity', 'the body was still arriving when page.blobReadBudgetMs ran out'],
	'peer-rescue': [
		'integrity',
		'the local body failed and the residency owner’s copy answered it — still a cache serve',
	],
	'invalidated': ['invalidated', 'a bulk invalidation demoted a page that would otherwise have served'],
	// Deliberately its own verdict upstream and never folded into `hit`: the page is as old as it
	// ever was and is being served on EVIDENCE (the probe re-confirmed its price/availability
	// claims after the epoch), not on age. Still a cache serve — it counts toward offload.
	'verified': [
		'invalidated',
		'an invalidation would have refused it; the change probe proved its claims current — still a cache serve',
	],
	// A cache serve too, and counted as one — but never as a hit: a hit means a page this system
	// rendered was inside its cadence, and nothing rendered this. `render.raw` stores the document a
	// miss already fetched so the next crawler asking for the same URL is answered from storage.
	'raw': ['raw', 'a stored origin document answered it — no browser ran on it, and it owns no render target'],
	'skip': ['not-cacheable', 'the cache was deliberately not consulted (renderNow / Cache-Control)'],
	'bypass': ['not-cacheable', 'not a cacheable request at all (non-GET/HEAD)'],
};

/** Fold the non-hit serves into one row per verdict, carrying what answered each of them. */
export function notHitRows(serves) {
	const byStatus = new Map();
	for (const s of serves) {
		const status = s.method ?? 'unknown';
		if (status === 'hit') continue;
		let row = byStatus.get(status);
		if (!row) {
			const [family, means] = NOT_HIT[status] ?? ['other', 'an outcome this console does not know about'];
			byStatus.set(status, (row = { status, family, means, count: 0, sources: new Map() }));
		}
		row.count += s.count;
		const source = s.path ?? 'unknown';
		row.sources.set(source, (row.sources.get(source) ?? 0) + s.count);
	}
	return [...byStatus.values()].sort((a, b) => b.count - a.count);
}

/**
 * What the origin's answer MEANS, for a status code in `origin_fetch.path`.
 *
 * `absent` is the one that changes a number rather than describing it. A 404 or 410 says the page
 * does not exist at the origin, so the cache having nothing for it is not a coverage gap — there
 * is nothing to cover. It is also permanent: only a 200 is ever scheduled for prerendering
 * (`maybeSchedule`), so a URL the origin does not have misses on every single crawl, forever.
 * Folding those into "coverage miss" is what makes a corpus look broken when it is complete, and
 * the usual source is crawler-invented URLs rather than anything this deployment did.
 */
export function originVerdict(code) {
	const n = Number(code);
	if (!Number.isFinite(n) || n <= 0) return 'connect-fail';
	if (n === 404 || n === 410) return 'absent';
	if (n >= 500) return 'server-error';
	if (n >= 400) return 'client-error';
	return 'served';
}

/** Colors follow the status classes they summarize; `absent` is not a fault, so it is neutral. */
const VERDICT_COLORS = {
	'served': 'var(--ok)',
	'absent': 'var(--fg-3)',
	'client-error': 'var(--warn)',
	'server-error': 'var(--bad)',
	'connect-fail': 'var(--bad)',
};

/**
 * Origin-side cost keyed by the cache status that sent the request there (the reason slot),
 * with what the origin actually answered.
 */
export function originCostByReason(data) {
	const costs = new Map();
	for (const s of pick(data, 'origin_fetch')) {
		const reason = s.method ?? 'unknown';
		let row = costs.get(reason);
		if (!row) costs.set(reason, (row = { combos: [], count: 0, failures: 0, absent: 0, verdicts: new Map() }));
		row.combos.push(s);
		row.count += s.count;
		const verdict = originVerdict(s.path);
		row.verdicts.set(verdict, (row.verdicts.get(verdict) ?? 0) + s.count);
		if (verdict === 'server-error' || verdict === 'connect-fail') row.failures += s.count;
		if (verdict === 'absent') row.absent += s.count;
	}
	for (const row of costs.values()) {
		// Both, because "what does a miss typically cost" and "how bad does it get" are different
		// questions, and this one row is where each verdict answers them.
		row.median = weighted(row.combos, 'median');
		row.p95 = weighted(row.combos, 'p95');
	}
	return costs;
}

/**
 * The one verdict name shared by two metrics: `bot_serve.method` and `origin_fetch.method` (the
 * reason slot) both call it `miss`, which is exactly what lets the two populations be joined.
 *
 * A constant rather than a string literal at the Map lookup: the route-contract test scans client
 * modules for get/post calls taking a quoted name, and a bare lookup written that way reads to it
 * as a fetch of a route called "miss". That scan is worth far more than the characters it costs to
 * stay out of its way — it is what catches a route the console can no longer reach.
 */
const MISS = 'miss';

/**
 * The coverage number, split into the part we own and the part we do not.
 *
 * `absent` is counted on the origin_fetch side and `missServes` on the bot_serve side. They are
 * both per-request counters over the same window and a miss that proxies emits exactly one of
 * each, so subtracting is sound — EXCEPT under a bot filter, because origin_fetch carries no bot
 * name. Rather than scale one population by the other's share and call the estimate a KPI, the
 * netting is switched off there and the tile says so.
 */
export function coverageSplit({ serves, costs, filter }) {
	const missServes = sumCount(serves.filter((s) => s.method === MISS));
	const absent = costs.get(MISS)?.absent ?? 0;
	const netable = !filter && absent > 0;
	return { missServes, absent, netable, net: netable ? Math.max(0, missServes - absent) : missServes };
}

/**
 * What the origin answered, as shares — the column that turns "40% miss" into an action.
 *
 * Read as a sentence: `served 88% · absent 12%` means nine in ten of those misses are pages the
 * origin has and we did not, and one in ten are pages nobody has.
 */
const verdictMix = (cost) =>
	el(
		'span',
		{ cls: 'mono', style: { fontSize: '11px' } },
		[...cost.verdicts.entries()]
			.sort((a, b) => b[1] - a[1])
			.flatMap(([verdict, count], index) => [
				index > 0 && muted(' · '),
				el('span', {
					style: { color: VERDICT_COLORS[verdict] ?? 'var(--fg-2)' },
					text: `${verdict} ${pct(count, cost.count)}`,
				}),
			])
	);

function notFreshHit(data, { serves, filter }) {
	const total = sumCount(serves);
	const rows = notHitRows(serves);
	const notHit = rows.reduce((acc, row) => acc + row.count, 0);
	const costs = originCostByReason(data);

	const byFamily = new Map();
	for (const row of rows) byFamily.set(row.family, (byFamily.get(row.family) ?? 0) + row.count);

	// Coverage is the one family that is not purely a bot_serve verdict: the part of it the origin
	// answered 404/410 is not a gap in our corpus. Netting it here keeps this strip agreeing with
	// the KPI above rather than shouting a bigger number two inches below a smaller one.
	const coverage = coverageSplit({ serves, costs, filter });
	if (coverage.netable) byFamily.set('coverage', coverage.net);

	const head = [
		spacer(),
		filter && muted(`${[...filter].join(', ')} only`),
		pill(`${pct(notHit, total)} of serves`, notHit > total / 2 ? 'warn' : ''),
	];

	if (!total) {
		return card('Not a fresh hit', { head, body: [emptyNote('bot_serve', data)] });
	}
	if (!rows.length) {
		return card('Every serve was a fresh hit', {
			head,
			body: [el('div', { cls: 'note ok', text: 'Every bot serve in this window was a fresh cache hit.' })],
		});
	}

	const body = rows.map((row) => {
		const cost = costs.get(row.status);
		const answered = [...row.sources.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([source, count]) => `${source} ${pct(count, row.count)}`)
			.join(' · ');
		return el('tr', { title: row.means }, [
			el('td', { cls: 'nowrap' }, [pill(row.status), el('span', { cls: 'muted cell-hint', text: row.means })]),
			el('td', { cls: 'right mono', text: num(row.count) }),
			el('td', { cls: 'right mono', text: pct(row.count, total) }),
			el('td', { cls: 'mono', text: answered }),
			el('td', {
				cls: 'right mono',
				text: cost ? fmtMs(cost.median) : '—',
				title: cost
					? `${num(cost.count)} origin fetches under reason "${row.status}" — median ${fmtMs(cost.median)}, p95 ${fmtMs(cost.p95)}`
					: 'no origin fetch carried this reason',
			}),
			el('td', null, [cost ? verdictMix(cost) : muted('—')]),
		]);
	});

	return card('Not a fresh hit', {
		head,
		help: [
			'One row per freshness verdict, because each has a different fix: coverage is fixed in the corpus (discovery, ',
			'sitemaps), cadence by render capacity or a longer interval, integrity is blob health, invalidation is a bulk ',
			'invalidation doing its job (verified is what per-page verification bought back), and not-cacheable is ',
			'working as configured. "origin median" is what that verdict typically costs at the origin (p95 in the ',
			'tooltip); "origin answered" is what came back — absent (404/410) is a page nobody has, and only served is a ',
			'page we could have had cached.',
			filter ? ' * origin_fetch has no bot dimension: those columns are all bots.' : '',
		],
		body: [
			el(
				'div',
				{ cls: 'stat-grid tight' },
				[
					...FAMILIES,
					// A verdict this console has no entry for still gets a tile, so the families always sum
					// to the non-hit total instead of quietly losing a new plugin's new outcome.
					...(byFamily.has('other')
						? [{ key: 'other', label: 'Other', hint: 'a verdict this console has no entry for' }]
						: []),
				]
					.filter((family) => byFamily.has(family.key))
					.map((family) => stat(family.label, pct(byFamily.get(family.key), total), family.hint))
					// The part carved out of Coverage, shown rather than silently dropped: the two tiles
					// have to add back up to the miss share or the strip is just wrong by a different amount.
					.concat(
						coverage.netable
							? [stat('Not found at origin', pct(coverage.absent, total), 'no such page — not a coverage gap')]
							: []
					)
			),
			table(
				[
					'verdict',
					{ text: 'serves', right: true },
					{ text: 'share', right: true },
					'answered from',
					{ text: `origin median ≈${filter ? ' *' : ''}`, right: true },
					`origin answered${filter ? ' *' : ''}`,
				],
				body
			),
			coverage.absent > 0 &&
				el('div', {
					cls: 'hint',
					text:
						`${num(coverage.absent)} of the misses (${pct(coverage.absent, coverage.missServes)}) were 404/410 at the ` +
						`origin — no such page, so not a coverage gap${coverage.netable ? ' (excluded above)' : ''}. Only a 200 is ` +
						'ever scheduled, so these miss on every crawl; usually crawler-invented URLs.',
				}),
		],
		cls: 'flush-table',
	});
}

/** Server-side latency by Harper's own cache verdict — an independent read on the hit rate. */
function latency(data, filter) {
	const hits = pick(data, 'duration', (s) => s.type === 'cache-hit');
	const misses = pick(data, 'duration', (s) => s.type !== 'cache-hit');
	const series = [
		{ label: 'cache-hit p95', color: SERIES[1], points: weightedBuckets(hits, 'p95s', data.bucketCount) },
		{ label: 'other p95', color: SERIES[0], points: weightedBuckets(misses, 'p95s', data.bucketCount) },
	];
	const any = series.some((s) => s.points.some((p) => Number.isFinite(p)));
	return card('Serve time (p95 ≈)', {
		head: [
			spacer(),
			allBotsTag(filter, 'Harper’s per-request timing'),
			legend(series.map(({ label, color }) => ({ label, color }))),
		],
		help:
			'Harper’s own per-request timing for bot traffic, split by its independent cache verdict — a cross-check on ' +
			'the freshness panel. Percentiles are count-weighted merges: trend, not SLO.',
		body: [any ? lineChart(data, series) : emptyNote('duration', data)],
	});
}

/** Who is crawling, on what, and how much of it still reaches the origin. */
function crawlers(data, { serves, requests, filter }) {
	const byBot = new Map();
	for (const s of serves) {
		const bot = s.type ?? 'other';
		const entry = byBot.get(bot) ?? { total: 0, origin: 0 };
		entry.total += s.count;
		if (s.path === 'origin') entry.origin += s.count;
		byBot.set(bot, entry);
	}
	const ranked = [...byBot.entries()].sort((a, b) => b[1].total - a[1].total);
	const top = ranked.slice(0, 8);
	const rest = ranked.slice(8);
	const rows = top.map(([bot, { total, origin }]) => ({
		label: bot,
		value: total,
		sub: `${pct(total - origin, total)} offloaded`,
		title: `${bot}: ${num(total)} serves, ${num(origin)} from origin`,
	}));
	if (rest.length) {
		const total = rest.reduce((acc, [, e]) => acc + e.total, 0);
		const origin = rest.reduce((acc, [, e]) => acc + e.origin, 0);
		rows.push({ label: `other (${rest.length})`, value: total, sub: `${pct(total - origin, total)} offloaded` });
	}

	// Device and host come off bot_request, which carries the bot in another slot — so both honour
	// the filter. The device split is here because mobile-first indexing makes "which device type
	// is the crawler asking as" a question about what gets indexed, and it appears nowhere else in
	// this console; the host split only appears when a deployment actually serves more than one,
	// where a host nobody expected is a CDN forwarding rule that should not exist.
	const tally = (dim) => {
		const totals = new Map();
		for (const s of requests) totals.set(s[dim] ?? 'unknown', (totals.get(s[dim] ?? 'unknown') ?? 0) + s.count);
		return [...totals.entries()].sort((a, b) => b[1] - a[1]);
	};
	const devices = tally('type');
	const hosts = tally('path');

	return card('Crawlers', {
		head: [spacer(), filter && pill([...filter].join(', '), 'info')],
		help:
			'A crawler missing from this list is an unmatched User-Agent, not zero traffic — the registry and ' +
			'analytics.deriveUnknownBots decide the labels. Device and host come from ingress requests.',
		body: [
			el('div', { cls: 'cols' }, [
				el('div', null, [
					el('div', { cls: 'panel-sub', text: 'serves by bot' }),
					rows.length ? barList(rows) : emptyNote('bot_serve', data),
				]),
				el('div', null, [
					el('div', { cls: 'panel-sub', text: 'requests by device' }),
					devices.length
						? barList(
								devices.map(([device, count]) => ({ label: device, value: count })),
								{ color: SERIES[2] }
							)
						: emptyNote('bot_request', data),
					hosts.length > 1 && el('div', { cls: 'panel-sub', style: { marginTop: '14px' }, text: 'requests by host' }),
					hosts.length > 1 &&
						barList(
							hosts.map(([host, count]) => ({ label: host, value: count })),
							{ color: SERIES[3] }
						),
				]),
			]),
		],
	});
}

/** The status mix as crawlers saw it — names discovered from the scan, never hardcoded. */
function statusCodes(data, filter) {
	const rows = (data.series ?? [])
		.filter((s) => s.metric.startsWith('response_'))
		.map((s) => ({ code: s.metric.slice('response_'.length), count: s.count }));
	const byCode = new Map();
	for (const { code, count } of rows) byCode.set(code, (byCode.get(code) ?? 0) + count);
	const ranked = [...byCode.entries()].sort((a, b) => b[1] - a[1]);

	// Class subtotals, because the individual codes are what happened and the class is what it
	// means. A 5xx share is the one number here that is an alarm rather than a mix.
	const total = ranked.reduce((acc, [, count]) => acc + count, 0);
	const classShare = (test) => ranked.filter(([code]) => test(Number(code))).reduce((acc, [, count]) => acc + count, 0);
	const serverErrors = classShare((n) => !Number.isFinite(n) || n >= 500);
	const classes = [
		['2xx', classShare((n) => n >= 200 && n < 300)],
		['3xx', classShare((n) => n >= 300 && n < 400)],
		['4xx', classShare((n) => n >= 400 && n < 500)],
		['5xx', serverErrors],
	].filter(([, count]) => count > 0);

	return card('Status codes served to bots', {
		head: [spacer(), allBotsTag(filter, 'Harper’s per-response counters')],
		help: 'A metric exists only for codes that occurred — an absent code is zero, not unknown.',
		body: [
			ranked.length
				? barList(
						ranked.map(([code, count]) => ({
							label: code,
							value: count,
							color: statusCodeColor(code),
						}))
					)
				: emptyNote('response_*', data),
			ranked.length &&
				el('p', { cls: 'muted chart-note mono' }, [
					classes.map(([label, count]) => `${label} ${pct(count, total)}`).join(' · '),
				]),
			serverErrors > total / 100 &&
				el('div', {
					cls: 'note bad',
					text: `${pct(serverErrors, total)} of responses to crawlers were 5xx (${num(serverErrors)}).`,
				}),
		],
	});
}

// ---- what the origin actually saw ----------------------------------------------
//
// The gross offload tile is a serve-side number, and the serve path is not the only thing here
// that talks to the origin. The arithmetic is `originLoad` in charts.js (the overview reads the
// same figure); this is the panel that shows its terms.

/** What the origin saw, by cause, over time — the panel behind the net offload tile. */
const LOAD_ROWS = [
	{
		key: 'proxied',
		label: 'proxied serves',
		color: 'var(--warn)',
		means: 'crawler requests forwarded live — the only term the gross figure counts',
	},
	{
		key: 'renders',
		label: 'renders',
		color: SERIES[0],
		means: 'page loads by the render fleet, one per posted result — the document only',
	},
	{
		key: 'probes',
		label: 'change probes',
		color: SERIES[2],
		means: 'origin calls by the change probe, failures included',
	},
	{ key: 'sitemaps', label: 'sitemap fetches', color: SERIES[3], means: 'sitemaps read by refresh runs' },
];

function originSeen(data, { load, filter }) {
	const stacks = originLoadBuckets(data);
	const present = LOAD_ROWS.filter((row) => load[row.key] > 0);
	const keys = present.map((row) => row.key);
	const colorOf = (key) => LOAD_ROWS.find((row) => row.key === key)?.color ?? 'var(--fg-4)';

	// The fifth term is stated rather than guessed: a rendering crawler runs the page, and its XHR/fetch
	// calls go straight to the origin, never through this plugin — so the figure is documents-only on
	// both sides. See `originLoad` in charts.js for the full ledger.
	const help = [
		'Every request the origin answered because this deployment exists, against what crawlers asked for. Gross ',
		'offload counts only proxied serves; net offload subtracts all of them. A render counts as one request (the ',
		'document); a probe is one small endpoint call. Not counted: requests the CDN answered from its own cache, ',
		'renders that never posted a result, and — on both sides — the XHR/fetch calls a rendering crawler’s page ',
		'makes (they bypass this plugin). Where snapshots are served without scripts, true net offload is higher than ',
		'shown.',
		load.lumpy
			? ' Probe and sitemap counts land where a pass FINISHED, so over a range shorter than a pass quote the 24h figure.'
			: '',
	];

	return card('What the origin actually saw', {
		head: [
			spacer(),
			allBotsTag(filter, 'renders, probes and sitemap fetches are not for any one crawler'),
			legend(present.map((row) => ({ label: row.label, color: row.color }))),
		],
		help,
		body: !load.total
			? [el('div', { cls: 'note ok', text: 'Nothing in this window reached the origin — 100% offload.' })]
			: [
					Number.isFinite(load.net) &&
						load.net < 0 &&
						el('div', { cls: 'note warn' }, [
							el('strong', { text: 'Net offload is negative. ' }),
							'Renders and probes send the origin more requests than the crawlers would have — expected while a ',
							'corpus backfills. Levers: render interval, demand floors, the discovery gate, probe rate. Read it over 24h.',
						]),
					stats([
						stat('Crawlers asked', fmtCount(load.arrived), 'requests at ingress'),
						stat('Origin answered', fmtCount(load.total), `${fmtNet(load.net)} net offload`, {
							warn: Number.isFinite(load.net) && load.net < 0.5,
						}),
						stat('Proxied', fmtCount(load.proxied), `+${fmtCount(load.total - load.proxied)} from this system`),
						stat('Follow-ups', 'not measured', `${fmtCount(load.handed)} pages handed to crawlers`, {
							title: 'The XHR/fetch calls a rendering crawler’s page makes are counted on neither side of the ledger.',
						}),
					]),
					stackedBars(data, keys, stacks, colorOf, { format: fmtCount }),
					barList(
						present.map((row) => ({
							label: row.label,
							value: load[row.key],
							color: row.color,
							sub: pct(load[row.key], load.total),
							title: `${row.label}: ${num(load[row.key])} — ${row.means}`,
						})),
						{ format: fmtCount }
					),
				],
	});
}

/** What a non-cache serve costs: why the origin was consulted, how slowly it answered, and with what. */
function originFetch(data, filter) {
	const fetches = pick(data, 'origin_fetch');
	const costs = originCostByReason(data);
	const ranked = [...costs.entries()].sort((a, b) => b[1].count - a[1].count);

	const series = [
		{ label: 'p95', color: SERIES[3], points: weightedBuckets(fetches, 'p95s', data.bucketCount) },
		{ label: 'mean', color: SERIES[0], points: weightedBuckets(fetches, 'means', data.bucketCount) },
	];

	// The status mix, which the reason breakdown hides: a 404-heavy proxy is a corpus problem the
	// failure count deliberately does not flag (a 404 is an answer), and it is invisible otherwise.
	const byCode = new Map();
	for (const s of fetches) byCode.set(s.path ?? '0', (byCode.get(s.path ?? '0') ?? 0) + s.count);
	const totalFetches = sumCount(fetches);
	const codes = [...byCode.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 6)
		.map(([code, count]) => `${code === '0' ? 'connect-fail' : code} ${pct(count, totalFetches)}`);

	return card('Origin fetches', {
		head: [spacer(), allBotsTag(filter, 'origin_fetch'), legend(series.map(({ label, color }) => ({ label, color })))],
		help:
			'Time to response headers, by why the origin was consulted — the freshness verdicts, plus render-timeout ' +
			'(renderNow falling back because the fleet did not land an on-demand render in time).',
		body: fetches.length
			? [
					lineChart(data, series),
					barList(
						ranked.map(([reason, { count, failures, median, p95 }]) => ({
							label: reason,
							value: count,
							sub: `${fmtMs(median)}${failures ? ` · ${num(failures)} failed` : ''}`,
							color: failures > count / 2 ? 'var(--bad)' : SERIES[0],
							title: `${reason}: ${num(count)} fetches, median ${fmtMs(median)}, p95 ${fmtMs(p95)}, ${num(failures)} failed (5xx/connect)`,
						})),
						{}
					),
					el('p', { cls: 'muted chart-note mono' }, [`origin answered: ${codes.join(' · ')}`]),
				]
			: [emptyNote('origin_fetch', data)],
	});
}

/** Which route's cadence should move — the per-route serve mix, delivered age, and staleness. */
function routes(ctx, data, cadences, filter) {
	const fallback = data.intervals?.defaultRenderInterval;
	const byRoute = new Map();
	for (const s of pick(data, 'route_serve')) {
		const route = s.path ?? 'unrouted';
		const entry = byRoute.get(route) ?? { total: 0, cache: 0, miss: 0, aging: 0, integrity: 0 };
		entry.total += s.count;
		if (isCacheServed(s.method)) entry.cache += s.count;
		if (s.method === 'miss') entry.miss += s.count;
		if (s.method === 'swr' || s.method === 'stale') entry.aging += s.count;
		if (s.method === 'blob-missing' || s.method === 'blob-timeout' || s.method === 'peer-rescue')
			entry.integrity += s.count;
		byRoute.set(route, entry);
	}
	const ageByRoute = new Map();
	for (const s of pick(data, 'route_page_age')) {
		const route = s.path ?? 'unrouted';
		const list = ageByRoute.get(route) ?? [];
		list.push(s);
		ageByRoute.set(route, list);
	}

	const ranked = [...byRoute.entries()].sort((a, b) => b[1].total - a[1].total);
	if (!ranked.length) return null;

	const total = ranked.reduce((acc, [, entry]) => acc + entry.total, 0);
	// Only worth a column when the deployment has any: it is a fault class that should read zero.
	const anyIntegrity = ranked.some(([, entry]) => entry.integrity > 0);
	const unclassified = ranked
		.filter(([route]) => cadenceFor(cadences, route, fallback).mode === 'unclassified')
		.reduce((acc, [, entry]) => acc + entry.total, 0);

	const rows = ranked.map(([route, { total: routeTotal, cache, miss, aging, integrity }]) => {
		const cadence = cadenceFor(cadences, route, fallback);
		const prerender = isPrerender(cadence);
		// The MEDIAN, so this column and the Staleness tile are the same statistic. They were not:
		// the tile is what an operator reads first and the table is where they act, and one saying
		// 0.34x while the other says 0.89x for the same route is worse than either alone.
		const ageRows = ageByRoute.get(route) ?? [];
		const ageMedian = weighted(ageRows, 'median');
		const ageTailP95 = weighted(ageRows, 'p95');
		const ratio = ratioOf(ageMedian, cadence.interval);
		const tailRatio = ratioOf(ageTailP95, cadence.interval);
		return el('tr', null, [
			el('td', { cls: 'mono', text: route }),
			el('td', null, [
				cadence.mode === 'prerender'
					? muted('prerender')
					: // `unknown` means the config payload could not be read, not that the route is odd — a
						// pill on every row would read as a finding about the deployment.
						cadence.mode === 'unknown'
						? muted('—')
						: pill(cadence.mode, cadence.mode === 'unclassified' ? 'warn' : ''),
			]),
			el('td', { cls: 'right mono', text: num(routeTotal) }),
			el('td', { cls: 'right mono', text: pct(cache, routeTotal) }),
			el('td', { cls: 'right' }, [
				// Miss share is the coverage number; past a third it stops being tail noise — but ONLY
				// on a route we actually cache. A passthrough route is proxied live by definition, so
				// its 100% miss rate is the configuration working, and flagging it trains the operator
				// to ignore the flag on the routes where it means something.
				el('span', {
					cls: prerender && routeTotal > 0 && miss > routeTotal / 3 ? 'pill warn' : 'mono',
					text: pct(miss, routeTotal),
				}),
			]),
			el('td', { cls: 'right mono', text: pct(aging, routeTotal) }),
			anyIntegrity &&
				el('td', { cls: 'right' }, [
					integrity ? el('span', { cls: 'pill bad', text: pct(integrity, routeTotal) }) : muted('—'),
				]),
			el('td', null, [
				cadence.discoverTargets === null ? muted('—') : cadence.discoverTargets ? muted('open') : pill('gated', 'info'),
			]),
			el('td', { cls: 'right mono' }, [
				prerender ? fmtMs(cadence.interval) : '—',
				prerender && cadence.inherited ? muted(' default') : null,
				// The floor bounds how far the demand ladder may accelerate this route's pages, so it
				// belongs beside the cadence it modifies rather than in a column of its own that would
				// be empty on every deployment that has not set one.
				prerender && cadence.demandFloor ? muted(` · floor ${fmtMs(cadence.demandFloor)}`) : null,
			]),
			el('td', {
				cls: 'right mono',
				text: fmtMs(ageMedian),
				title: `median ${fmtMs(ageMedian)} · p95 ${fmtMs(ageTailP95)}`,
			}),
			el('td', { cls: 'right' }, [
				prerender && ratio !== null
					? el('span', {
							cls: ratio > 1 ? 'pill warn' : 'mono',
							text: fmtRatio(ratio),
							title: `p95 ${fmtRatio(tailRatio)}`,
						})
					: muted('—'),
			]),
		]);
	});

	return card('Per route', {
		head: [
			spacer(),
			allBotsTag(filter, 'route_serve carries the route in the slot bot_serve uses for the bot'),
			link('inspect a url →', () => ctx.go('inspect')),
		],
		help: [
			'The cadence-tuning table. "÷ cadence" is the route’s median served age against its own renderInterval, so ',
			'1.0 means the same everywhere: half that route’s serves were past due. An evenly refreshed route sits near ',
			'0.50× (p95, in the tooltip, near 0.95× by construction). Miss is flagged only on routes we cache — a ',
			'passthrough is proxied live by design. "default" cadence inherits render.defaultInterval; "floor" is the ',
			'fastest rung the demand ladder may grant. "gated" routes no longer mint a target for an unknown URL.',
		],
		cls: 'flush-table',
		body: [
			table(
				[
					'route',
					'mode',
					{ text: 'serves', right: true },
					{ text: 'cache-served', right: true },
					{ text: 'miss', right: true },
					{ text: 'swr+stale', right: true },
					anyIntegrity && { text: 'blob', right: true },
					'discovery',
					{ text: 'cadence', right: true },
					{ text: 'age median ≈', right: true },
					{ text: '÷ cadence', right: true },
				].filter(Boolean),
				rows
			),
			unclassified > 0 &&
				el('div', { cls: 'note warn' }, [
					`${pct(unclassified, total)} of serves matched no route — the CDN forwards undeclared paths or the route `,
					'list is incomplete. ',
					link('See the unrouted report →', () => ctx.go('config')),
				]),
		],
	});
}

/**
 * What the discovery gate is holding out of the render rotation.
 *
 * READ IT AS TRAFFIC, NOT AS DENIED MINTS. The plugin counts every cacheable MISS whose target
 * creation the gate refused, which includes repeat misses on URLs it has already refused — so this
 * is "requests on URLs held out of the rotation", not "URLs prevented". That is the more useful
 * number anyway: it is the crawl pressure the gate is absorbing, and its shape over the window is
 * what says whether a crawler has moved on or is still walking the same combinatorial space.
 *
 * NOTHING HERE IS A FAILURE. A gated request is still SERVED — proxied live from the origin, with
 * the miss counted on the route table above — it simply never enters the render rotation. The
 * panel exists because the alternative to gating is a corpus that grows faster than the fleet can
 * keep it fresh, and that shows up nowhere until the whole queue is late.
 */
// The two gate reasons, as named constants rather than quoted literals at the lookup. The
// cross-package route scanner in adminAssets.test.js reads any Map lookup written with a quoted
// name as a call to an admin route of that name — including one inside a comment, which is why
// this one describes the shape instead of showing it. The scanner is deliberately blunt: a
// mistyped route name has to fail in the suite rather than in a browser, and the cost of that is
// spelling lookup keys out as constants here.
const GATE_ROUTE_FLAG = 'route';
const GATE_BOT_ALLOWLIST = 'bot';

function discoveryGate(ctx, data, filter) {
	const gated = pick(data, 'prerender_ops', (s) => s.path === 'discovery_gated' && keepBot(filter, s.type));
	const options = optionIndex(configState(ctx).payload);
	const bots = options.get('ingress.discoveryBots')?.effective ?? ['*'];
	const gatedRoutes = (options.get('ingress.routes')?.effective ?? []).filter(
		(entry) => entry && typeof entry === 'object' && entry.discoverTargets === false
	);
	const botGateOn = Array.isArray(bots) && !(bots.length === 1 && bots[0] === '*');
	const total = sumCount(gated);

	// Nothing gated AND nothing configured to gate: describe the capability rather than drawing an
	// empty chart, which would read as a subsystem that is on and quiet.
	if (!total && !botGateOn && !gatedRoutes.length) {
		return card('Discovery gate', {
			head: [spacer(), pill('not configured', '')],
			help: [
				'Every route mints a target for any unknown URL a bot asks for. On a combinatorial URL space (facets, ',
				'filters, sorts) that is unbounded render load. The gates are ',
				el('code', { text: 'discoverTargets' }),
				' per route and ',
				el('code', { text: 'ingress.discoveryBots' }),
				' — under Request ingestion on ',
				link('Config →', () => ctx.go('config')),
			],
			body: [el('div', { cls: 'empty', text: 'Every route mints targets for any bot.' })],
		});
	}

	const byGate = new Map();
	const byBot = new Map();
	for (const s of gated) {
		byGate.set(s.method ?? 'unknown', (byGate.get(s.method ?? 'unknown') ?? 0) + s.count);
		byBot.set(s.type ?? 'other', (byBot.get(s.type ?? 'other') ?? 0) + s.count);
	}
	const ranked = [...byBot.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

	return card(`Discovery gate — ${scopeLabel(data)}`, {
		head: [
			gatedRoutes.length
				? pill(`${gatedRoutes.length} route${gatedRoutes.length === 1 ? '' : 's'} gated`, 'info')
				: null,
			botGateOn ? pill(bots.length ? `minting: ${bots.join(', ')}` : 'sitemap-only corpus', 'info') : null,
			spacer(),
			link('purge what is already in →', () => ctx.go('corpus')),
		],
		help:
			'Counted per gated MISS, so a URL refused a hundred times counts a hundred — the crawl pressure the gate ' +
			'absorbs, not URLs prevented. A gated request is still served (from the origin); it just never enters the ' +
			'render rotation. Gating stops NEW targets only: purge what was minted before, on Corpus.',
		body: [
			stats([
				stat('Gated misses', fmtCount(total), 'served from origin, never scheduled'),
				stat('By route flag', fmtCount(byGate.get(GATE_ROUTE_FLAG) ?? 0), 'discoverTargets: false'),
				stat('By bot allowlist', fmtCount(byGate.get(GATE_BOT_ALLOWLIST) ?? 0), 'ingress.discoveryBots'),
			]),
			ranked.length
				? barList(
						ranked.map(([bot, count]) => ({ label: bot, value: count })),
						{ format: fmtCount }
					)
				: el('div', { cls: 'empty', text: 'Configured, and refused nothing in this range.' }),
		],
	});
}

/**
 * The raw-document cache: what it stored, and — the point of the panel — what it REFUSED.
 *
 * READ THE REFUSALS. An enabled route that stores nothing looks exactly like a route nobody
 * enabled: same miss rate, same origin proxies, no error anywhere. The only thing that
 * distinguishes them is the reason each candidate was turned away, which is why the plugin emits
 * one `raw_cache` row per store ATTEMPT rather than counting successes. A panel that charted
 * `stored` alone would be blind to the whole failure mode it exists for.
 *
 * TWO OUTCOMES ARE FINDINGS RATHER THAN FACTS OF LIFE, and they are flagged:
 *
 *   has-cookie   the origin tried to set a cookie, i.e. it is personalizing a route that was
 *                assumed to be shared. Storing that document would replay one visitor's page to
 *                every crawler, so the refusal is correct — but the ASSUMPTION is wrong, and
 *                nothing else in this console would ever say so.
 *   oversize     `render.raw.maxBytes` is below the route's real document size, so the feature is
 *                enabled and structurally cannot fill. It is a settings fix, not a fault.
 *
 * The rest are the shape of the traffic: `not-200` and `content-type` are documents that were never
 * eligible, `no-store` is the origin declining a shared cache (correctly honoured), `capture-busy`
 * is the per-worker concurrency cap shedding a capture rather than the heap, and `empty` is a 200
 * with no body — the one that used to be stored and replayed as a zero-byte document.
 *
 * `stored-unshared` IS A STORE, NOT A REFUSAL. Under `render.raw.assumeShared` a document the origin
 * marked `Set-Cookie`/`private` is kept anyway, and the plugin reports it apart so the assumption
 * stays visible. Folding it into the refusals — which is what this panel did before the outcome
 * existed — reports the route as refusing 100% of attempts on the very deployment where the option
 * just made it work, and lights the `stored === 0` warning while the cache fills. It is counted as
 * stored, and its share is called out as a census rather than an alarm: on an origin that sets a
 * cookie on every response the share is pinned at 100% by construction.
 *
 * WHAT THE STORE RATE IS NOT: a hit rate. Fills and serves are different populations over the same
 * window — a document stored now is read by the NEXT crawler, possibly after this window — so the
 * serves are shown beside the fills and never divided by them.
 */
// Outcome names as constants at the lookup sites, for the same reason the discovery gate's are:
// the route-contract scanner in adminAssets.test.js reads a quoted name inside a Map lookup as a
// fetch of an admin route by that name.
const RAW_STORED = 'stored';
// A store the origin called personal, kept anyway under `render.raw.assumeShared`. It is a STORE,
// and counting it as a refusal would report the feature as refusing everything at the exact moment
// it starts working — the inverse of the truth, and the same reading the operator came here to clear.
const RAW_STORED_UNSHARED = 'stored-unshared';
const RAW_HAS_COOKIE = 'has-cookie';
const RAW_OVERSIZE = 'oversize';

/** Every refusal the plugin can report, and what an operator should do about it. */
const RAW_REFUSALS = {
	'not-200': ['the origin did not answer 200 — only a 200 is ever eligible', ''],
	'staging': ['fetched through the staging origin, so the bytes are not production', ''],
	'has-cookie': ['the origin set a cookie: this route is personalized, not shared', 'bad'],
	'content-type': ['not in render.raw.contentTypes', ''],
	'no-store': ['the origin sent private / no-store — it is declining a shared cache', ''],
	'no-body': ['the response body was not a stream, so there was nothing to capture', ''],
	'oversize': ['larger than render.raw.maxBytes — served, and the capture abandoned', 'warn'],
	'capture-failed': ['the origin body errored or truncated mid-capture', 'warn'],
	'write-failed': ['the store itself threw — the document was served, nothing was kept', 'bad'],
	'empty': ['a 200 with a zero-byte body — refused rather than replayed as an empty document', 'warn'],
	'capture-busy': ['render.raw.maxConcurrentCaptures was full; the next request stores it', ''],
	'vary-device': [
		'the origin sent Vary: User-Agent / a client hint — it is adaptive, so render.raw.deviceIndependent is wrong here',
		'bad',
	],
};

function rawCache(ctx, data, filter) {
	const attempts = pick(data, 'prerender_ops', (s) => s.path === 'raw_cache');
	const options = optionIndex(configState(ctx).payload);
	const enabled = options.get('render.raw.enabled')?.effective === true;
	const rawRoutes = (options.get('ingress.routes')?.effective ?? []).filter(
		(entry) => entry && typeof entry === 'object' && entry.rawCache === true
	);
	// All bots: `raw_cache` carries no bot dimension (its slots are outcome and nothing else), and
	// the serve counts are narrowed by the filter like every other bot_serve read on this view.
	const rawServes = sumCount(pick(data, 'bot_serve', (s) => s.path === 'raw' && keepBot(filter, s.type)));

	const byOutcome = new Map();
	for (const s of attempts) byOutcome.set(s.method ?? 'unknown', (byOutcome.get(s.method ?? 'unknown') ?? 0) + s.count);
	const unshared = byOutcome.get(RAW_STORED_UNSHARED) ?? 0;
	const stored = (byOutcome.get(RAW_STORED) ?? 0) + unshared;
	const total = [...byOutcome.values()].reduce((acc, n) => acc + n, 0);
	const refused = total - stored;

	// Off and never switched on: describe the capability instead of drawing an empty chart, which
	// would read as a subsystem that is on and failing. Same exit as the discovery gate's.
	if (!enabled && !total && !rawServes) {
		return card('Raw-document cache', {
			head: [spacer(), pill('off', '')],
			help: [
				'Keeps the origin document a miss already fetched, so the next crawler asking for a URL outside the render ',
				'rotation is answered from storage. It is NOT a prerendered snapshot — check the route’s server-rendered ',
				'HTML carries its SEO surface first. Switches: ',
				el('code', { text: 'render.raw.enabled' }),
				' and ',
				el('code', { text: 'rawCache' }),
				' on a route (',
				link('Config →', () => ctx.go('config')),
				').',
			],
			body: [el('div', { cls: 'empty', text: 'Off.' })],
		});
	}

	const cookieRefusals = byOutcome.get(RAW_HAS_COOKIE) ?? 0;
	const oversize = byOutcome.get(RAW_OVERSIZE) ?? 0;
	const ranked = [...byOutcome.entries()]
		.filter(([outcome]) => outcome !== RAW_STORED && outcome !== RAW_STORED_UNSHARED)
		.sort((a, b) => b[1] - a[1]);
	const maxBytes = options.get('render.raw.maxBytes')?.effective;

	return card(`Raw-document cache — ${scopeLabel(data)}`, {
		head: [
			enabled ? null : pill('master switch off', 'warn'),
			rawRoutes.length
				? pill(`${rawRoutes.length} route${rawRoutes.length === 1 ? '' : 's'} opted in`, 'info')
				: pill('no route opted in', 'warn'),
			spacer(),
		],
		help: [
			'One row per store ATTEMPT, so a route that is enabled and filling nothing is distinguishable from one that is ',
			'off. A raw document only replaces an origin PROXY on a true miss — never a stale or invalidated snapshot. ',
			'Stored documents expire on ',
			el('code', { text: 'render.raw.expiry' }),
			' and refill on demand. "kept as unshared" is ',
			el('code', { text: 'render.raw.assumeShared' }),
			' storing a document the origin marked personal: a census, not an alarm — the body-diff test (two visitors, ',
			'different IPs/locales) is the real detector.',
		],
		body: [
			// The two refusals that are findings rather than traffic, each above the breakdown so it
			// is not something an operator has to spot in a bar list.
			cookieRefusals > 0 &&
				el('div', { cls: 'note bad' }, [
					el('strong', { text: `${num(cookieRefusals)} document(s) refused for setting a cookie. ` }),
					'The origin personalizes a route enabled as shared — check what it sets, or take it off ',
					el('code', { text: 'rawCache' }),
					'.',
				]),
			oversize > 0 &&
				el('div', { cls: 'note warn' }, [
					el('strong', { text: `${num(oversize)} document(s) exceeded render.raw.maxBytes` }),
					maxBytes ? ` (${fmtCount(maxBytes)} compressed bytes)` : '',
					' — served, not stored, so the route cannot fill.',
				]),
			stats([
				stat(
					'Stored',
					fmtCount(stored),
					total
						? `${pct(stored, total)} of ${fmtCount(total)} attempts${unshared > 0 ? ` · ${num(unshared)} kept as unshared` : ''}`
						: 'no attempts'
				),
				stat('Refused', fmtCount(refused), 'reasons below', {
					warn: total > 0 && stored === 0,
				}),
				// Deliberately NOT stored ÷ serves: a document stored in this window is read by the next
				// crawler, which may be in the next one. Different populations, shown side by side.
				stat('Raw serves', fmtCount(rawServes), `misses answered from storage${filter ? ' · filtered' : ''}`),
			]),
			total === 0
				? el('div', {
						cls: 'empty',
						text: 'No store attempt in this range.',
						title: 'A capture is only attempted on a miss on an opted-in route.',
					})
				: stored === total
					? el('div', { cls: 'note ok' }, ['Every eligible document in this window was stored.'])
					: // A TABLE, not a bar list, and for the same reason the non-hit verdicts are one: the
						// reason has to be readable beside the count rather than behind a hover, and a bar
						// list's sub-label is a nowrap cell sized for a number.
						table(
							['refusal', { text: 'documents', right: true }, { text: 'share', right: true }],
							ranked.map(([outcome, count]) => {
								const [means, severity] = RAW_REFUSALS[outcome] ?? ['an outcome this console does not know about', ''];
								return el('tr', { title: means }, [
									el('td', { cls: 'nowrap' }, [
										pill(outcome, severity),
										el('span', { cls: 'muted cell-hint', text: means }),
									]),
									el('td', { cls: 'right mono', text: num(count) }),
									el('td', { cls: 'right mono', text: pct(count, total) }),
								]);
							})
						),
		],
	});
}

/** Distinct URLs per bot per day — how much of the corpus crawlers actually walk. */
function breadth(ctx, filter) {
	const state = ctx.data.breadth;

	const loadBreadth = async () => {
		ctx.data.breadth = { loading: true };
		ctx.render();
		const res = await ctx.get('crawl-breadth', { days: 7 });
		ctx.data.breadth = res.ok ? res.body : { error: res.body?.error ?? `Failed (${res.status})` };
		ctx.render();
	};

	const body = [];
	if (!state) {
		body.push(
			el('button', {
				cls: 'small',
				text: 'Load 7-day breadth',
				title: 'Its own capped scan of the sketch table, so it loads on demand.',
				onclick: loadBreadth,
			})
		);
	} else if (state.loading) {
		body.push(el('div', { cls: 'empty', text: 'Merging sketches…' }));
	} else if (state.error) {
		body.push(el('div', { cls: 'note bad', text: state.error }));
	} else {
		const days = state.breadth ?? [];
		if (!days.length) {
			body.push(el('div', { cls: 'note', text: 'No crawl-sketch rows yet (crawlStats.enabled gates recording).' }));
		} else {
			// Newest day first in the payload. Two reads side by side: the day trend (union
			// distinct URLs — how much of the corpus gets walked per day) and the newest
			// day's per-bot split.
			const latest = days[0];
			// Shards the plugin could not merge, because they were written at a different
			// `crawlStats.precision` — a different register space, not a mergeable sketch. It
			// resolves itself at the next UTC rollover, but until then the day undercounts, and
			// an unmerged sketch reads as a flat zero rather than as an error. Say so: a breadth
			// number that is quietly missing a node's shards looks exactly like a quiet crawler.
			const mismatched = days.reduce((acc, d) => acc + (d.mismatchedShards ?? 0), 0);
			if (mismatched) {
				body.push(
					el('div', {
						cls: 'note warn',
						text:
							`${mismatched} sketch shard${mismatched === 1 ? '' : 's'} could not be merged — written at a ` +
							'different crawlStats.precision. Those days undercount until every node has rolled over to ' +
							'the new value (one UTC day).',
					})
				);
			}
			body.push(
				el('div', { cls: 'cols' }, [
					el('div', null, [
						el('div', { cls: 'panel-sub', text: 'distinct URLs per day (all bots, union)' }),
						barList(
							days.map((d) => ({ label: d.day, value: d.total })),
							{ color: SERIES[1] }
						),
					]),
					el('div', null, [
						el('div', { cls: 'panel-sub', text: `by bot, ${latest.day}${filter ? ' (filtered)' : ''}` }),
						// The per-bot column narrows with the filter; the day total beside it cannot, because it
						// is a UNION of the day's sketches and not a sum — subtracting bots from it is not an
						// operation HyperLogLog offers a reader.
						barList(
							latest.bots
								.filter(({ bot }) => keepBot(filter, bot))
								.slice(0, 8)
								.map(({ bot, distinctUrls }) => ({ label: bot, value: distinctUrls }))
						),
					]),
				]),
				state.truncated && el('div', { cls: 'note warn', text: 'Sketch scan truncated — these undercount.' })
			);
		}
	}

	return card('Crawl breadth', {
		head: [
			spacer(),
			state && !state.loading && !state.error && el('button', { cls: 'small', text: 'Reload', onclick: loadBreadth }),
		],
		help:
			'Distinct URLs each bot touched per day, from the crawl sketch (±2% at any scale). The day total is the union ' +
			'across bots, not a sum. Compare against the corpus size on Corpus.',
		body,
	});
}

// ---- settings ---------------------------------------------------------------
//
// Below the panels, because the reading comes first: an operator arrives with a number, and the
// knob that produced it is the answer to "why is it that". Two of these groups decide what gets
// RECORDED and one decides what this console may READ — a distinction the descriptions have to
// carry, since a recording change leaves history intact and a read change leaves nothing at all.

const settings = (ctx) =>
	section('traffic', 'Settings', [
		settingsCard(ctx, {
			title: 'Analytics recording',
			prefix: 'analytics',
			description:
				'What the plugin records for bot traffic, and under which names. Turning recording off empties ' +
				'every panel above from the moment it takes effect — it does not delete rows already recorded, ' +
				'and it changes nothing about what bots are served. The bot registry and deriveUnknownBots decide ' +
				'the labels in the bot filter: a crawler missing there is an unmatched User-Agent, not zero traffic.',
		}),
		settingsCard(ctx, {
			title: 'Crawl-breadth sketches',
			prefix: 'crawlStats',
			description:
				'The sketch behind Crawl breadth above; nothing else reads it. Recording is gated by analytics ' +
				'recording as well as by this group — with no bot name there is nothing to attribute a sketch to. ' +
				'precision changes the register space, so days already written at the old value stop merging with ' +
				'new ones until the next UTC rollover (that panel says so when it happens), and retentionDays only ' +
				'prunes stored sketches.',
		}),
		settingsCard(ctx, {
			title: 'Analytics reads (this console)',
			prefix: 'management.analytics',
			description:
				'What this console is allowed to scan for the panels above — the cost of looking, never what was ' +
				'recorded. cacheTtl is why switching ranges back and forth does not multiply scans, maxRange bounds ' +
				'the range picker, and scanCap sheds the OLDEST end of a window rather than failing; the scan footer ' +
				'reports the window a refresh actually covered.',
		}),
	]);
