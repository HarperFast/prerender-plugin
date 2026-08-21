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
 * AND NOT EVERY MISS IS OURS. A miss whose origin fetch came back 404 or 410 is a URL that does
 * not exist anywhere — there is nothing for the cache to be missing, and it can never improve,
 * because only a 200 is ever scheduled for prerendering. Left in the coverage number those URLs
 * make a complete corpus look broken, and at crawler volume they are not a rounding error. So the
 * coverage figures are stated NET of them, with the excluded population shown beside the number
 * rather than quietly dropped. The netting is exact — a miss that proxies emits one bot_serve row
 * and one origin_fetch row — except under a bot filter, where origin_fetch carries no bot name;
 * there the tile says it is not netted instead of scaling one population by the other's share.
 *
 * NOT EVERY NON-HIT IS A MISS. "miss" is one of nine freshness verdicts and the only one that
 * means what the word implies — nothing cached under the key. The others are a page served past
 * its cadence (`swr`), one past the SWR window entirely (`stale`), a body that could not be read
 * although the key is cached and scheduled (`blob-missing` / `blob-timeout`, rescued or not), a
 * serve a bulk invalidation cost us (`invalidated`), and requests where the cache was never
 * consulted at all (`skip`, `bypass`). They have four different fixes — corpus coverage, render
 * cadence, blob integrity, and nothing-to-fix — so they get their own panel rather than one bar
 * labelled "miss", with what each one cost at the origin beside it.
 *
 * THE BOT FILTER IS CLIENT-SIDE, ALWAYS. Selecting bots re-renders from the payload already in
 * hand; it never refetches, because the load discipline below is the whole reason this view can
 * afford to be this detailed. Three metrics carry a bot (`bot_request`, `bot_serve`, `page_age`)
 * and the rest do not — `route_serve`, `origin_fetch`, `duration` and `response_*` have no bot
 * dimension at all — so a panel that CANNOT honour the filter says "all bots" on its face rather
 * than quietly showing every crawler's numbers under one crawler's name.
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

import { card, el, ICONS, link, muted, num, pct, pill, spacer, stat, table } from '../ui.js';
import {
	barList,
	CACHE_STATUS_COLORS,
	chips,
	colorFor,
	emptyNote,
	fmtCount,
	fmtMs,
	fmtRatio,
	legend,
	lineChart,
	pick,
	rangePicker,
	ratioOf,
	scanFooter,
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

export const meta = { id: 'traffic', label: 'Traffic', crumb: 'traffic', icon: ICONS.traffic };

const RANGES = [
	{ label: '15m', ms: 15 * 60_000 },
	{ label: '1h', ms: 3_600_000 },
	{ label: '6h', ms: 6 * 3_600_000 },
	{ label: '24h', ms: 24 * 3_600_000 },
];

export async function load(ctx) {
	ctx.data.rangeMs ??= 3_600_000;
	// Relative by default: "1.4x the cadence" is a verdict, "4h" is a number the operator then has
	// to look a config value up for. Absolute stays one click away in the panel head.
	ctx.data.ageMode ??= 'ratio';
	ctx.data.bots ??= [];
	// Concurrent because the two are unrelated: the config read is usually already satisfied from
	// the shared scratch, and when it is not it must still not add a round trip to the range switch.
	const [res] = await Promise.all([ctx.get('analytics', { range: ctx.data.rangeMs }), loadConfig(ctx)]);
	ctx.data.analytics = res.ok ? res.body : null;
	ctx.data.error = res.ok ? null : (res.body?.error ?? `Could not load analytics (${res.status})`);
}

export function render(ctx) {
	const data = ctx.data.analytics;

	const head = el('div', { cls: 'view-head' }, [
		el('span', { cls: 'eyebrow', text: 'Traffic' }),
		spacer(),
		rangePicker(RANGES, ctx.data.rangeMs, (ms) => {
			ctx.data.rangeMs = ms;
			ctx.reload();
		}),
		el('button', { text: 'Refresh', disabled: ctx.busy, onclick: () => ctx.reload() }),
	]);

	// The settings ride along on the EMPTY exits too, not just the charted one. `analytics.enabled`
	// is the likeliest reason this view has nothing to show, so the card that flips it belongs on
	// the screen reporting the emptiness rather than a view away.
	const knobs = [...settings(ctx), editTray(ctx)];

	if (!data)
		return [
			head,
			appliedNote(ctx),
			el('div', { cls: 'note bad', text: ctx.data.error ?? 'No analytics data.' }),
			knobs,
		];
	if (data.available === false)
		return [head, appliedNote(ctx), el('div', { cls: 'note bad', text: data.error }), knobs];

	if (windowEmpty(data)) {
		return [head, appliedNote(ctx), card('No traffic recorded', { body: [emptyNote('analytics', data)] }), knobs];
	}

	const filter = botFilter(ctx);
	const serves = pick(data, 'bot_serve', (s) => keepBot(filter, s.type));
	const requests = pick(data, 'bot_request', (s) => keepBot(filter, s.method));
	const ages = pick(data, 'page_age', (s) => keepBot(filter, s.path));
	const cadences = cadenceIndex(configState(ctx).payload, data.intervals?.defaultRenderInterval);
	const scope = { serves, requests, ages, cadences, filter };

	return [
		head,
		appliedNote(ctx),
		botBar(ctx, data, filter),
		filter && !serves.length ? el('div', { cls: 'note warn', text: noSelectedBotTraffic(filter) }) : null,
		kpis(data, scope),
		el('div', { cls: 'cols' }, [freshness(data, scope), staleness(ctx, data, scope)]),
		notFreshHit(data, scope),
		el('div', { cls: 'cols' }, [originFetch(data, filter), latency(data, filter)]),
		el('div', { cls: 'cols' }, [crawlers(data, scope), statusCodes(data, filter)]),
		routes(ctx, data, cadences, filter),
		breadth(ctx, filter),
		el('div', { cls: 'scan-foot' }, [scanFooter(data)]),
		knobs,
	];
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
			muted('filters serves, freshness, staleness, page age and the crawler mix — panels marked "all bots" cannot'),
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

	const add = (path, mode, renderInterval) => {
		if (typeof path !== 'string' || path === '' || index.has(path)) return;
		const own = mode === 'prerender' && Number.isFinite(renderInterval) && renderInterval > 0;
		index.set(path, { mode, interval: own ? renderInterval : defaultInterval, inherited: !own });
	};

	for (const pattern of options.get('ingress.excludePathPatterns')?.effective ?? []) add(pattern, 'passthrough');
	for (const entry of options.get('ingress.routes')?.effective ?? []) {
		if (!entry || typeof entry !== 'object') continue;
		add(entry.path, entry.mode === 'passthrough' ? 'passthrough' : 'prerender', Number(entry.renderInterval));
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
	const cacheServes = sumCount(serves.filter((s) => s.path === 'cache'));
	const freshHits = sumCount(serves.filter((s) => s.method === 'hit'));
	const coverage = coverageSplit({ serves, costs: originCostByReason(data), filter });
	const arrived = sumCount(requests);

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

	return el('div', { cls: 'stat-grid' }, [
		stat(
			'Bot serves',
			num(total),
			unresolvedShare > 0.02
				? `${num(unresolved)} of ${num(arrived)} never reached a serve`
				: `${num(arrived)} at ingress · ${rate}`,
			{ warn: unresolvedShare > 0.02 }
		),
		stat(
			'Origin offload',
			pct(total - originServes, total),
			'requests the origin never saw',
			// The offload number is the rollout's headline; a majority-origin window deserves the flag.
			{ warn: total > 0 && originServes > total / 2 }
		),
		stat('Cache-served', pct(cacheServes, total), 'stored snapshot answered'),
		stat('Fresh hits', pct(freshHits, total), 'inside the configured cadence'),
		stat(
			'Coverage miss',
			pct(coverage.net, total),
			coverage.netable
				? `${num(coverage.absent)} excluded — the origin has no such page`
				: coverage.absent > 0
					? 'not netted: the origin 404 split is all-bots'
					: 'nothing cached under the key',
			// A miss the origin CAN serve is the corpus gap; the netted figure is the one worth a flag.
			{ warn: total > 0 && coverage.net > total / 3 }
		),
		stat(
			'Serve time · cache hit',
			fmtMs(hitMedian),
			`median · p95 ${fmtMs(hitP95)} · origin-served ${fmtMs(otherMedian)}${filter ? ' · all bots' : ''}`
		),
		stat(
			normalizable ? 'Staleness' : 'Page age',
			normalizable ? fmtRatio(stalenessMedian) : fmtMs(ageMedian),
			// Three numbers, because each answers a different question: the ratio is the verdict, the
			// p95 is the tail, and the duration is what an operator quotes to someone else.
			normalizable
				? `median · p95 ${fmtRatio(stalenessP95)} · ${fmtMs(ageMedian)} against ${
						basis === 'route' ? 'each route’s cadence' : fmtMs(fallback)
					}`
				: 'median · no render interval in the payload',
			// On the MEDIAN, not the p95: half the serves past their own cadence is unambiguous,
			// where a p95 over 1.0 is where an evenly aged corpus lives anyway.
			{ warn: Number.isFinite(stalenessMedian) && stalenessMedian > 1 }
		),
	]);
}

// ---- panels -----------------------------------------------------------------

/** Serves over time, stacked by freshness verdict — the cache doing (or not doing) its job. */
function freshness(data, { serves, filter }) {
	const { keys, stacks } = stackBy(serves, 'method', data.bucketCount);
	return card('Serves by freshness', {
		head: [spacer(), legend(keys.map((k) => ({ label: k, color: colorFor(CACHE_STATUS_COLORS, k) })))],
		body: [
			serves.length
				? stackedBars(data, keys, stacks, (k) => colorFor(CACHE_STATUS_COLORS, k))
				: emptyNote('bot_serve', data),
			el('p', { cls: 'muted chart-note' }, [
				'hit + swr + peer-rescue is cache-served. A rising miss share is a coverage problem; a rising ',
				'swr share is the fleet not keeping the configured cadence; blob-* should sit at zero. What each ',
				'verdict costs, and which of them are the same problem, is the panel below.',
			]),
			filter && muted(`Filtered to ${[...filter].join(', ')}.`),
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
	const ratioMedian = normalizable ? weighted(combos, 'median', scaleOf) : null;
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
	const cacheServed = sumCount(
		serves.filter((x) => x.method === 'hit' || x.method === 'swr' || x.method === 'peer-rescue')
	);
	const pastDue = sumCount(serves.filter((x) => x.method === 'swr' || x.method === 'stale'));
	const contradicted =
		normalizable && Number.isFinite(ratioP95) && ratioP95 > 1 && cacheServed > 0 && pastDue / cacheServed < 0.01;

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
		body: [
			any
				? lineChart(data, series, { band: bands, format: mode === 'ratio' ? fmtRatio : fmtMs })
				: emptyNote('page_age', data),
			el('p', { cls: 'muted chart-note' }, [
				mode === 'ratio'
					? 'Cache serves only, so origin proxies cannot drag it toward zero. 1.0 is “exactly due”: a page ' +
						'expires one render interval after it was stored, so above the line the fleet is not keeping ' +
						'the cadence. ' +
						(swrBand
							? `The upper line is ${fmtRatio(swrBand)} — interval + page.swrTtl, past which a page stops ` +
								'being served at all and the next request falls through to the origin. '
							: '')
					: 'Cache serves only, so origin proxies cannot drag it toward zero. The dashed line is the default ' +
						'render interval — a p95 above it means the fleet is not keeping the cadence. ',
				basis === 'route'
					? 'Each sample is measured against its own route’s renderInterval (route_page_age), so routes on ' +
						'different cadences are comparable; the demand ladder can shorten an individual target’s ' +
						'interval within that, which makes this read slightly generous.'
					: `Measured against ${fmtMs(fallback)}, the default interval — page_age carries the bot, not the ` +
						'route, so a per-route cadence cannot be applied to a bot-filtered window.',
				mode === 'ratio' && Number.isFinite(ratioMedian)
					? `This window: median ${fmtRatio(ratioMedian)}, p95 ${fmtRatio(ratioP95)}. An evenly refreshed corpus ` +
						'sits at median 0.50× and p95 ~0.95× by construction — a page’s age walks from zero to its ' +
						'interval and is re-rendered — so the MEDIAN is the number with headroom, and the p95 is ' +
						'near the ceiling even when nothing is wrong. '
					: '',
				hasMedians
					? 'The lines are the p95 and the median — the same two statistics as the tile, so the trend and ' +
						'the headline cannot disagree.'
					: 'The lines are the p95 and the MEAN: this node’s plugin predates per-bucket medians (v0.51.0), ' +
						'so the typical case is a tile figure here rather than a trend.',
			]),
			contradicted &&
				el('div', { cls: 'note' }, [
					el('strong', { text: 'The freshness verdicts disagree with this ratio, and they are the authority. ' }),
					`Only ${pct(pastDue, cacheServed)} of cache serves were past due (swr + stale), which is decided per `,
					'request against that page’s own expiry — so these pages are fresh and the divisor is short. That ',
					'happens when a target’s cadence comes from its stored interval (a sitemap ',
					el('code', { text: 'changefreq' }),
					') rather than from ',
					el('code', { text: 'ingress.routes' }),
					', which is the only cadence this console can see. Set the route’s renderInterval to make this ',
					'panel agree with reality.',
				]),
			!normalizable &&
				el('div', {
					cls: 'note',
					text: 'This node’s analytics payload carries no render interval, so only absolute age can be shown.',
				}),
			discarded > 0 &&
				el('div', {
					cls: 'note warn',
					text:
						`${num(discarded)} served page(s) reported a NEGATIVE age and were discarded from this ` +
						'distribution — a snapshot stamped in this node’s future, i.e. cross-node clock skew.',
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
		label: 'Invalidated',
		hint: 'a bulk invalidation cost the serve',
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
		return card('Not a fresh hit — what, and what it cost', { head, body: [emptyNote('bot_serve', data)] });
	}
	if (!rows.length) {
		return card('Every serve was a fresh hit', {
			head,
			body: [
				el('div', { cls: 'note ok' }, [
					'Every bot serve in this window was answered from cache inside its render interval — no misses, ',
					'no stale pages, no blob faults, nothing proxied.',
				]),
			],
		});
	}

	const body = rows.map((row) => {
		const cost = costs.get(row.status);
		const answered = [...row.sources.entries()]
			.sort((a, b) => b[1] - a[1])
			.map(([source, count]) => `${source} ${pct(count, row.count)}`)
			.join(' · ');
		return el('tr', null, [
			el('td', null, [pill(row.status), el('div', { cls: 'muted', text: row.means })]),
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

	return card('Not a fresh hit — what, and what it cost', {
		head,
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
				el('div', { cls: 'note' }, [
					el('strong', {
						text: `${num(coverage.absent)} of the misses (${pct(coverage.absent, coverage.missServes)}) were 404 or 410 at the origin. `,
					}),
					'Those URLs do not exist, so there is nothing for the cache to be missing — they are not a ',
					'coverage gap, and ',
					coverage.netable
						? 'they are excluded from the Coverage figures above'
						: 'they would be excluded but for the bot filter',
					'. They also cannot improve: only a 200 is ever scheduled for prerendering, so the same URL ',
					'misses on every crawl. A large or growing population here is usually crawler-invented URLs ',
					'rather than anything this deployment did — the crawler sees the origin’s own 404, which is ',
					'counted in the status panel below.',
				]),
			el('p', { cls: 'muted chart-note' }, [
				'One row per freshness verdict, because they are four different problems: coverage is fixed in the ',
				'corpus (discovery, sitemaps), cadence by render capacity or a longer interval, integrity is blob ',
				'health and never a caching question, and the last two are working as configured. ',
				'“origin median” is what that verdict typically costs at the origin, with its p95 in the tooltip — and ',
				'“origin answered” is what came back: `absent` (404/410) is a page nobody has, `server-error` and ',
				'`connect-fail` are the origin in trouble, and only `served` is a page we could have had cached.',
				filter ? ' * origin_fetch carries no bot dimension: those two columns are all bots.' : '',
			]),
		],
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
		body: [
			any ? lineChart(data, series) : emptyNote('duration', data),
			el('p', { cls: 'muted chart-note' }, [
				'Harper’s own per-request timing for bot traffic, split by its independent cache verdict — ',
				'a cross-check on the freshness panel. Percentiles are count-weighted merges: trend, not SLO.',
			]),
		],
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
		head: [spacer(), filter && muted(`${[...filter].join(', ')} only`)],
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
			el('p', { cls: 'muted chart-note' }, [
				'Narrow every filterable panel to one crawler with the bot chips at the top of the page. A crawler ',
				'missing from this list is an unmatched User-Agent, not zero traffic — the registry and ',
				'analytics.deriveUnknownBots decide the labels.',
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
			el('p', { cls: 'muted chart-note' }, [
				'A metric exists only for codes that occurred — an absent code is zero, not unknown.',
			]),
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
					el('p', { cls: 'muted chart-note' }, [
						'Time to response headers, by why the origin was consulted — the same reasons as the ',
						'freshness verdicts above, plus render-timeout, which is renderNow falling back because the ',
						'fleet did not land an on-demand render in time.',
					]),
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
		if (s.method === 'hit' || s.method === 'swr' || s.method === 'peer-rescue') entry.cache += s.count;
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
			el('td', { cls: 'right mono' }, [
				prerender ? fmtMs(cadence.interval) : '—',
				prerender && cadence.inherited ? muted(' default') : null,
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
			link('explain a url →', () => ctx.go('explain')),
		],
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
					{ text: 'cadence', right: true },
					{ text: 'age median ≈', right: true },
					{ text: '÷ cadence', right: true },
				].filter(Boolean),
				rows
			),
			el('p', { cls: 'muted chart-note' }, [
				'The cadence-tuning table. “÷ cadence” is that route’s MEDIAN served age against its own ',
				'renderInterval, so every row is comparable and 1.0 means the same thing everywhere: half that ',
				'route’s serves were past due. An evenly refreshed route sits near 0.50×, and its p95 — in the ',
				'cell’s tooltip — sits near 0.95× by construction, which is why the tail is not what you tune ',
				'against. A high miss share means its corpus ',
				'isn’t covered — flagged only on routes we actually cache, since a passthrough is proxied live by ',
				'design. Cadence is read from ingress.routes; “default” means the route sets none and inherits ',
				'render.defaultInterval.',
			]),
			unclassified > 0 &&
				el('div', { cls: 'note warn' }, [
					`${pct(unclassified, total)} of route-attributed serves matched no route at all. Either the CDN is `,
					'forwarding paths nobody declared or the route list is incomplete — the unrouted report on ',
					link('Config', () => ctx.go('config')),
					' buckets them by first path segment.',
				]),
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
			el('p', { cls: 'muted' }, [
				'Distinct URLs each bot touched per day, from the crawl sketch (±2% at any scale). ',
				'Loads on demand — it is its own capped scan.',
			]),
			el('button', { text: 'Load 7-day breadth', onclick: loadBreadth })
		);
	} else if (state.loading) {
		body.push(el('p', { cls: 'muted', text: 'Merging sketches…' }));
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
				el('p', { cls: 'muted chart-note' }, [
					'Sketch estimates (±2% at any scale); the day total is the union across bots, not a sum' +
						(state.truncated ? ' — sketch scan truncated, so these undercount' : '') +
						'. Compare against the corpus size on the overview.',
				]),
				el('button', { text: 'Reload', onclick: loadBreadth })
			);
		}
	}

	return card('Crawl breadth', { body });
}

// ---- settings ---------------------------------------------------------------
//
// Below the panels, because the reading comes first: an operator arrives with a number, and the
// knob that produced it is the answer to "why is it that". Two of these groups decide what gets
// RECORDED and one decides what this console may READ — a distinction the descriptions have to
// carry, since a recording change leaves history intact and a read change leaves nothing at all.

const settings = (ctx) => [
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
];
