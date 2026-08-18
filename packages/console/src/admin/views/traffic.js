/**
 * Traffic: what crawlers got, from where, how fast, how fresh — the delivery half of the
 * metric catalog, charted from ONE bounded analytics scan per node per refresh.
 *
 * THE FOUR QUESTIONS this view answers are the catalog's own (METRICS.md §1): are we taking
 * load off the origin (bot_serve source), is the cache hit and fresh (bot_serve status +
 * page_age), what does a non-cache serve cost (origin_fetch), and which route's cadence
 * should move (route_serve / route_page_age). The panels are ordered exactly that way.
 *
 * LOAD DISCIPLINE. Every number on this view comes from a single `analytics` request; each
 * node answers it from a per-worker cache inside `management.analytics.cacheTtl`, so switching
 * ranges back and forth, a view switch, or a second operator does not multiply scans. Under
 * cluster scope that is one cached scan PER NODE — N times a bounded read, not N times a
 * table walk — and the footer states what the refresh actually cost on every node. This
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

import { card, el, ICONS, link, num, pct, spacer, stat, table } from '../ui.js';
import {
	barList,
	CACHE_STATUS_COLORS,
	colorFor,
	emptyNote,
	fmtMs,
	legend,
	lineChart,
	pick,
	rangePicker,
	scanFooter,
	SERIES,
	stackBy,
	stackedBars,
	statusCodeColor,
	sumCount,
	weighted,
	weightedBuckets,
	windowEmpty,
} from '../charts.js';
import { appliedNote, editTray, loadConfig, settingsCard } from './_configEdit.js';

export const meta = { id: 'traffic', label: 'Traffic', crumb: 'traffic', icon: ICONS.traffic };

const RANGES = [
	{ label: '15m', ms: 15 * 60_000 },
	{ label: '1h', ms: 3_600_000 },
	{ label: '6h', ms: 6 * 3_600_000 },
	{ label: '24h', ms: 24 * 3_600_000 },
];

export async function load(ctx) {
	ctx.data.rangeMs ??= 3_600_000;
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

	const serves = pick(data, 'bot_serve');

	return [
		head,
		appliedNote(ctx),
		kpis(data, serves),
		el('div', { cls: 'cols' }, [freshness(data, serves), latency(data)]),
		el('div', { cls: 'cols' }, [bots(serves, data), statusCodes(data)]),
		el('div', { cls: 'cols' }, [originFetch(data), pageAge(data)]),
		routes(ctx, data),
		breadth(ctx),
		el('div', { cls: 'scan-foot' }, [scanFooter(data)]),
		knobs,
	];
}

// ---- KPIs -------------------------------------------------------------------

function kpis(data, serves) {
	const total = sumCount(serves);
	const originServes = sumCount(serves.filter((s) => s.path === 'origin'));
	const cacheServes = sumCount(serves.filter((s) => s.path === 'cache'));
	const freshHits = sumCount(serves.filter((s) => s.method === 'hit'));
	const requests = sumCount(pick(data, 'bot_request'));

	const durations = pick(data, 'duration');
	const p95 = weighted(durations, 'p95');
	const ageP95 = weighted(pick(data, 'page_age'), 'p95');
	const interval = data.intervals?.defaultRenderInterval;

	return el('div', { cls: 'stat-grid' }, [
		stat('Bot serves', num(total), `${num(requests)} requests at ingress`),
		stat(
			'Origin offload',
			pct(total - originServes, total),
			'requests the origin never saw',
			// The offload number is the rollout's headline; a majority-origin window deserves the flag.
			{ warn: total > 0 && originServes > total / 2 }
		),
		stat('Cache-served', pct(cacheServes, total), 'stored snapshot answered'),
		stat('Fresh hits', pct(freshHits, total), 'inside the configured TTL'),
		stat('Serve p95', fmtMs(p95), 'server-side, bot requests'),
		stat('Page age p95', fmtMs(ageP95), interval ? `render interval ${fmtMs(interval)}` : 'cache serves only', {
			warn: Number.isFinite(ageP95) && Number.isFinite(interval) && ageP95 > interval,
		}),
	]);
}

// ---- panels -----------------------------------------------------------------

/** Serves over time, stacked by freshness verdict — the cache doing (or not doing) its job. */
function freshness(data, serves) {
	const { keys, stacks } = stackBy(serves, 'method', data.bucketCount);
	return card('Serves by freshness', {
		head: [spacer(), legend(keys.map((k) => ({ label: k, color: colorFor(CACHE_STATUS_COLORS, k) })))],
		body: [
			stackedBars(data, keys, stacks, (k) => colorFor(CACHE_STATUS_COLORS, k)),
			el('p', { cls: 'muted chart-note' }, [
				'hit + swr is cache-served. A rising miss share is a coverage problem; a rising swr share is ',
				'the fleet not keeping the configured cadence; blob-* should sit at zero.',
			]),
		],
	});
}

/** Server-side latency by Harper's own cache verdict — an independent read on the hit rate. */
function latency(data) {
	const hits = pick(data, 'duration', (s) => s.type === 'cache-hit');
	const misses = pick(data, 'duration', (s) => s.type !== 'cache-hit');
	const series = [
		{ label: 'cache-hit p95', color: SERIES[1], points: weightedBuckets(hits, 'p95s', data.bucketCount) },
		{ label: 'other p95', color: SERIES[0], points: weightedBuckets(misses, 'p95s', data.bucketCount) },
	];
	const any = series.some((s) => s.points.some((p) => Number.isFinite(p)));
	return card('Serve time (p95 ≈)', {
		head: [spacer(), legend(series.map(({ label, color }) => ({ label, color })))],
		body: [
			any ? lineChart(data, series) : emptyNote('duration', data),
			el('p', { cls: 'muted chart-note' }, [
				'Harper’s own per-request timing for bot traffic, split by its independent cache verdict — ',
				'a cross-check on the freshness panel. Percentiles are count-weighted merges: trend, not SLO.',
			]),
		],
	});
}

/** Who is crawling, and how much of each bot's traffic still reaches the origin. */
function bots(serves, data) {
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
	return card('Serves by bot', {
		body: [rows.length ? barList(rows) : emptyNote('bot_serve', data)],
	});
}

/** The status mix as crawlers saw it — names discovered from the scan, never hardcoded. */
function statusCodes(data) {
	const rows = (data.series ?? [])
		.filter((s) => s.metric.startsWith('response_'))
		.map((s) => ({ code: s.metric.slice('response_'.length), count: s.count }));
	const byCode = new Map();
	for (const { code, count } of rows) byCode.set(code, (byCode.get(code) ?? 0) + count);
	const ranked = [...byCode.entries()].sort((a, b) => b[1] - a[1]);
	return card('Status codes served to bots', {
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
			el('p', { cls: 'muted chart-note' }, [
				'A metric exists only for codes that occurred — an absent code is zero, not unknown.',
			]),
		],
	});
}

/** What a non-cache serve costs: why the origin was consulted, how slowly it answered. */
function originFetch(data) {
	const fetches = pick(data, 'origin_fetch');
	const byReason = new Map();
	for (const s of fetches) {
		const reason = s.method ?? 'unknown';
		const entry = byReason.get(reason) ?? { count: 0, failures: 0 };
		entry.count += s.count;
		const code = Number(s.path);
		if (!Number.isFinite(code) || code <= 0 || code >= 500) entry.failures += s.count;
		byReason.set(reason, entry);
	}
	const ranked = [...byReason.entries()].sort((a, b) => b[1].count - a[1].count);

	const p95Points = weightedBuckets(fetches, 'p95s', data.bucketCount);
	const meanPoints = weightedBuckets(fetches, 'means', data.bucketCount);
	const series = [
		{ label: 'p95', color: SERIES[3], points: p95Points },
		{ label: 'mean', color: SERIES[0], points: meanPoints },
	];

	return card('Origin fetches', {
		head: [spacer(), legend(series.map(({ label, color }) => ({ label, color })))],
		body: fetches.length
			? [
					lineChart(data, series),
					barList(
						ranked.map(([reason, { count, failures }]) => ({
							label: reason,
							value: count,
							sub: failures ? `${num(failures)} failed` : '',
							color: failures > count / 2 ? 'var(--bad)' : SERIES[0],
							title: `${reason}: ${num(count)} fetches, ${num(failures)} failed (5xx/connect)`,
						})),
						{}
					),
					el('p', { cls: 'muted chart-note' }, [
						'Time to response headers, by why the origin was consulted. render-timeout rows are ',
						'renderNow falling back — the fleet not keeping up with on-demand requests.',
					]),
				]
			: [emptyNote('origin_fetch', data)],
	});
}

/** Freshness as delivered, against the configured cadence. */
function pageAge(data) {
	const ages = pick(data, 'page_age');
	const interval = data.intervals?.defaultRenderInterval;
	const series = [
		{ label: 'p95', color: SERIES[2], points: weightedBuckets(ages, 'p95s', data.bucketCount) },
		{ label: 'median', color: SERIES[1], points: weightedBuckets(ages, 'means', data.bucketCount) },
	];
	const any = series.some((s) => s.points.some((p) => Number.isFinite(p)));
	return card('Page age at serve (≈)', {
		head: [spacer(), legend(series.map(({ label, color }) => ({ label, color })))],
		body: [
			any ? lineChart(data, series, { band: interval }) : emptyNote('page_age', data),
			el('p', { cls: 'muted chart-note' }, [
				'Cache serves only, so origin proxies cannot drag it toward zero. The dashed line is the ',
				'default render interval — a p95 above it means the fleet is not keeping the cadence. ',
				'“median” here charts the bucket mean (count-weighted).',
			]),
		],
	});
}

/** Which route's cadence should move — the per-route serve mix and delivered age. */
function routes(ctx, data) {
	const byRoute = new Map();
	for (const s of pick(data, 'route_serve')) {
		const route = s.path ?? 'unrouted';
		const entry = byRoute.get(route) ?? { total: 0, cache: 0, miss: 0, aging: 0 };
		entry.total += s.count;
		if (s.method === 'hit' || s.method === 'swr' || s.method === 'peer-rescue') entry.cache += s.count;
		if (s.method === 'miss') entry.miss += s.count;
		if (s.method === 'swr' || s.method === 'stale') entry.aging += s.count;
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

	const rows = ranked.map(([route, { total, cache, miss, aging }]) => {
		const ageP95 = weighted(ageByRoute.get(route) ?? [], 'p95');
		return el('tr', null, [
			el('td', { cls: 'mono', text: route }),
			el('td', { cls: 'right mono', text: num(total) }),
			el('td', { cls: 'right mono', text: pct(cache, total) }),
			el('td', { cls: 'right' }, [
				// Miss share is the coverage number; past a third it stops being tail noise.
				el('span', { cls: total > 0 && miss > total / 3 ? 'pill warn' : 'mono', text: pct(miss, total) }),
			]),
			el('td', { cls: 'right mono', text: pct(aging, total) }),
			el('td', { cls: 'right mono', text: fmtMs(ageP95) }),
		]);
	});

	return card('Per route', {
		head: [spacer(), link('explain a url →', () => ctx.go('explain'))],
		body: [
			table(
				[
					'route',
					{ text: 'serves', right: true },
					{ text: 'cache-served', right: true },
					{ text: 'miss', right: true },
					{ text: 'swr+stale', right: true },
					{ text: 'age p95 ≈', right: true },
				],
				rows
			),
			el('p', { cls: 'muted chart-note' }, [
				'The cadence-tuning table: a high swr+stale share means that route’s renderInterval is not ',
				'being delivered; a high miss share means its corpus isn’t covered; compare age p95 to the ',
				'route’s own interval before moving it.',
			]),
		],
	});
}

/** Distinct URLs per bot per day — how much of the corpus crawlers actually walk. */
function breadth(ctx) {
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
						el('div', { cls: 'panel-sub', text: `by bot, ${latest.day}` }),
						barList(latest.bots.slice(0, 8).map(({ bot, distinctUrls }) => ({ label: bot, value: distinctUrls }))),
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
			'the labels in Serves by bot: a crawler missing there is an unmatched User-Agent, not zero traffic.',
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
