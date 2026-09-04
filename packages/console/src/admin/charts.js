/**
 * Chart primitives + analytics-payload helpers for the console.
 *
 * Same hard rule as ui.js: no DOM from HTML strings, ever — everything is built through
 * `el()`/createElementNS, so origin- and operator-supplied values (bot names, routes, status
 * strings) are injection-safe by construction.
 *
 * COLOR IS ASSIGNED BY JOB, not picked per chart:
 *   - SERIES: identity ("which line is which") — four fixed slots on Harper's hues, assigned
 *     in order and never cycled. Validated for CVD separation, lightness band, chroma and
 *     contrast against the card surface (#11161d) — re-run the check before changing them.
 *   - SEMANTIC: state (good / aging / trouble) for the closed sets the plugin defines
 *     (cache statuses, serve sources, render outcomes, status-code classes). These reuse the
 *     console's status tokens so "red means bad" stays true everywhere, and they are keyed by
 *     VALUE so a filter or a missing series never repaints the survivors.
 *   - Anything unknown falls back to gray: a new enum value shows up legible and uncolored
 *     rather than stealing a meaning.
 *
 * Every multi-series chart gets a legend; single-series charts are named by their card title.
 * Hover detail rides native `title` tooltips — same affordance the rest of the console uses.
 */

import { el } from './ui.js';

// ---- palette --------------------------------------------------------------

/** Categorical identity slots. Fixed order; never cycled — past four, fold into "other". */
export const SERIES = ['#3d8cff', '#10a87e', '#9d6bff', '#c94f83'];

const OK = 'var(--ok)';
const WARN = 'var(--warn)';
const BAD = 'var(--bad)';
const INFO = 'var(--info)';
const MUTED = 'var(--fg-4)';
const PURPLE = '#9d6bff';
const PINK = '#c94f83';

/** Freshness verdicts (bot_serve.method / route_serve.method). */
export const CACHE_STATUS_COLORS = {
	'hit': OK,
	'swr': INFO,
	'peer-rescue': '#8ff1cd',
	// A cache serve an invalidation would have refused, let through on the probe's evidence
	// (plugin v0.63.0). Coloured beside `invalidated` rather than beside `hit`: the two are the
	// same population — pages a bulk invalidation touched — split into rescued and refused.
	'verified': '#c9a7ff',
	'miss': WARN,
	'stale': PINK,
	'invalidated': PURPLE,
	'skip': MUTED,
	'bypass': MUTED,
	'blob-missing': BAD,
	'blob-timeout': BAD,
};

/**
 * The freshness verdicts that are CACHE SERVES — the bytes came from a stored snapshot. This is
 * the one enumeration every "cache-served" sum in the console must share, because a verdict
 * missing from it does not read as missing: it reads as a smaller hit rate. `verified` sat outside
 * every such sum for one plugin release and the cache-served share simply looked lower.
 *
 * `hit`, `swr` and `verified` are the page itself; `peer-rescue` is the owner's copy of it. What
 * is NOT here: `miss`/`stale` (origin), `blob-*` (the local body failed AND no rescue landed, so
 * the request went to origin), `invalidated` (refused), `skip`/`bypass` (never consulted).
 */
export const CACHE_SERVED = new Set(['hit', 'swr', 'verified', 'peer-rescue']);
export const isCacheServed = (status) => CACHE_SERVED.has(status);

/** Where the bytes came from (bot_serve.path). `origin` is the one offload counts against. */
export const SOURCE_COLORS = { cache: OK, rendered: INFO, origin: WARN };

/** What became of a posted render result (render outcome.method). */
export const OUTCOME_COLORS = {
	'rendered': OK,
	'suppressed': PURPLE,
	'redirect': INFO,
	'transient': WARN,
	'auth-failure': PINK,
	'failed': BAD,
};

export const colorFor = (map, key) => map[key] ?? MUTED;

/** Status-code class color: 2xx good, 3xx info, 4xx warn, 5xx/0 bad. */
export const statusCodeColor = (code) => {
	const n = Number(code);
	if (!Number.isFinite(n) || n <= 0 || n >= 500) return BAD;
	if (n >= 400) return WARN;
	if (n >= 300) return INFO;
	return OK;
};

// ---- formatting ------------------------------------------------------------

/** Milliseconds for chart labels: sub-second stays in ms, above reads in s/m. */
export function fmtMs(v) {
	if (v === null || v === undefined || !Number.isFinite(v)) return '—';
	if (v < 1000) return `${Math.round(v)}ms`;
	if (v < 60_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}s`;
	if (v < 3_600_000) return `${Math.round(v / 60_000)}m`;
	return `${(v / 3_600_000).toFixed(1)}h`;
}

/**
 * A dimensionless ratio, for anything measured against its own yardstick — a served age against
 * the cadence that page was supposed to be re-rendered on, above all. Two decimals under 10 so
 * "just past due" (1.04x) is distinguishable from "twice the cadence", coarser above it where the
 * exact figure has stopped mattering.
 */
export function fmtRatio(v) {
	if (v === null || v === undefined || !Number.isFinite(v)) return '—';
	if (v >= 100) return `${Math.round(v)}×`;
	if (v >= 10) return `${v.toFixed(1)}×`;
	return `${v.toFixed(2)}×`;
}

/**
 * A ratio, or null when either side is missing — never a number that only looks like an answer.
 *
 * `null / 48h` is **0**, not NaN, so a missing measurement divided by a present yardstick formats
 * as a confident "0.00×" — the most flattering possible reading of "we have no data". It is the
 * same `Number(null) === 0` trap the plugin's own `numberOf()` exists for, arriving through
 * division instead of coercion. Every ÷-cadence figure on the Traffic view goes through here so
 * the guard cannot be forgotten at one call site out of four.
 */
export const ratioOf = (value, yardstick) =>
	Number.isFinite(value) && Number.isFinite(yardstick) && yardstick > 0 ? value / yardstick : null;

export function fmtCount(v) {
	if (v === null || v === undefined || !Number.isFinite(v)) return '—';
	if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
	if (v >= 10_000) return `${Math.round(v / 1000)}k`;
	if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
	return String(Math.round(v));
}

const clock = (ms) => {
	const d = new Date(ms);
	return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

// ---- payload helpers -------------------------------------------------------
//
// The analytics payload is `series`: one entry per (metric, path, method, type) combo, each
// carrying totals plus fixed-width bucket arrays. These helpers shape combos into charts and
// KPIs; they never fetch.
//
// EVERY NUMBER HERE IS ALREADY A JS NUMBER, and deliberately so — nothing below re-coerces.
// These modules run in the browser and their only input is `res.json()`, so a database Long or
// BigInt cannot reach them (JSON has no such type, and stringifying one throws at the source).
// The coercion belongs where the database is actually read, and lives there: `bucketize()` in
// the plugin's `util/analyticsRead.js` runs every column through `numberOf()` — which also
// keeps `Number(null) === 0` from flooring a weighted average — and the console's cluster merge
// (`util/aggregate.js`) does the same with its own `finite()`. Coercing a second time here would
// imply the payload is untrusted in a way it is not, and would hide which layer owns the rule.

export const pick = (data, metric, filter) =>
	(data?.series ?? []).filter((s) => s.metric === metric && (!filter || filter(s)));

export const sumCount = (combos) => combos.reduce((acc, s) => acc + s.count, 0);

/**
 * What a VALUE metric actually recorded, as opposed to how many times it recorded.
 *
 * `count` is the number of EMITS. For most value metrics that is what you want (750 durations),
 * but several of them record a count as their value — `claim_granted` emits once per claim pass
 * carrying the number of jobs, `ready_cadence` once per sweep carrying a number of rows — and
 * there `sumCount` answers "how many claim passes ran", which is a different question with a
 * plausible-looking answer.
 *
 * Reconstructed as Σ(mean × count) rather than read off `total`: the row schema has a `total`
 * column, but Harper populates it only for BOOLEAN counters. Every distribution row in a live
 * payload carries `total: 0` alongside a perfectly good mean (verified against production — 82 of
 * 142 series had a non-zero total, and not one of them was a distribution). Since each row's mean
 * is exact over its own samples, the product is the true sum.
 */
export const sumValues = (combos) =>
	combos.reduce((acc, s) => (Number.isFinite(s.mean) && s.count > 0 ? acc + s.mean * s.count : acc), 0);

/**
 * Stack combos by one dimension: returns `{ keys, stacks }` where `stacks[key]` is a
 * per-bucket count array summed over every combo whose `dim` equals `key`. Keys are ordered
 * by total, biggest first, so legends and stacking order match visual weight.
 */
export function stackBy(combos, dim, bucketCount, { values = false } = {}) {
	const stacks = new Map();
	for (const combo of combos) {
		const key = combo[dim] ?? 'unknown';
		let arr = stacks.get(key);
		if (!arr) stacks.set(key, (arr = new Array(bucketCount).fill(0)));
		for (let i = 0; i < combo.counts.length && i < bucketCount; i++) {
			// `values` is the per-bucket form of sumValues above: for a metric whose recorded value is
			// itself a count, stacking the emit counts charts how often it was recorded rather than
			// what it recorded.
			if (!values) arr[i] += combo.counts[i];
			else if (Number.isFinite(combo.means?.[i]) && combo.counts[i] > 0) arr[i] += combo.means[i] * combo.counts[i];
		}
	}
	const keys = [...stacks.keys()].sort((a, b) => stacks.get(b).reduce(sum, 0) - stacks.get(a).reduce(sum, 0));
	return { keys, stacks };
}

const sum = (a, b) => a + b;

/**
 * Count-weighted merge of a distribution stat across combos.
 *
 * WHICH STATISTIC TO ASK FOR, because the three this payload carries answer different questions
 * and the console gets one of them wrong per panel if nobody says this out loud:
 *
 *   `mean`   — the only one that merges EXACTLY. A count-weighted mean of means is the true mean
 *              of the pooled population, across combos, buckets and nodes alike. It is also the
 *              statistic that governs throughput: renders/hour is concurrency ÷ MEAN render time,
 *              never ÷ p95. Use it for capacity and for anything that has to add up.
 *   `median` — the typical experience, and the one to lead with when the question is "what does a
 *              crawler normally get". Robust to a tail that a mean would swallow.
 *   `p95`    — the tail, and ONLY the tail. It is the right alarm for a pathology that hides
 *              behind a healthy middle (a cohort of cache hits at 13.6s while the median stayed
 *              at 2.3ms), and the wrong headline for anything else — including any distribution
 *              with a natural ceiling, where a perfectly healthy population already sits near it.
 *
 * A merged median or p95 is a count-weighted average of per-row percentiles, which is NOT the
 * percentile of the pooled population — close in practice, wrong in principle, and always written
 * "≈". Only the mean escapes that.
 *
 * `scaleOf` divides each combo's value by its OWN yardstick before the merge, which is what makes
 * a mixed population comparable: a 2h-cadence route and a 24h-cadence route both express their
 * staleness as "x of the cadence I was configured for", and the merged number means something.
 * A combo whose yardstick is unusable (absent, zero) is EXCLUDED rather than merged raw — mixing
 * ratios with milliseconds would produce a number with no unit at all. Callers that can't
 * guarantee a yardstick for everything must say so; see the staleness panel's fallback.
 */
export function weighted(combos, stat, scaleOf) {
	let total = 0;
	let weight = 0;
	for (const combo of combos) {
		if (!Number.isFinite(combo[stat]) || !(combo.count > 0)) continue;
		let value = combo[stat];
		if (scaleOf) {
			const yardstick = scaleOf(combo);
			if (!Number.isFinite(yardstick) || yardstick <= 0) continue;
			value /= yardstick;
		}
		total += value * combo.count;
		weight += combo.count;
	}
	return weight > 0 ? total / weight : null;
}

/** Per-bucket count-weighted merge of `means`/`p95s` arrays across combos; `scaleOf` as above. */
export function weightedBuckets(combos, stat, bucketCount, scaleOf) {
	const sums = new Array(bucketCount).fill(0);
	const weights = new Array(bucketCount).fill(0);
	for (const combo of combos) {
		const values = combo[stat];
		if (!values) continue;
		let yardstick = 1;
		if (scaleOf) {
			yardstick = scaleOf(combo);
			if (!Number.isFinite(yardstick) || yardstick <= 0) continue;
		}
		for (let i = 0; i < bucketCount; i++) {
			if (Number.isFinite(values[i]) && combo.counts[i] > 0) {
				sums[i] += (values[i] / yardstick) * combo.counts[i];
				weights[i] += combo.counts[i];
			}
		}
	}
	return sums.map((s, i) => (weights[i] > 0 ? s / weights[i] : null));
}

// ---- primitives ------------------------------------------------------------

export const legend = (items) =>
	el(
		'div',
		{ cls: 'legend' },
		items.map(({ label, color }) =>
			el('span', { cls: 'key' }, [el('span', { cls: 'swatch', style: { background: color } }), label])
		)
	);

/**
 * Stacked bar timeline. `stacks` as from `stackBy`; keys are drawn bottom-up in the given
 * order with 2px gaps so segment boundaries survive adjacent same-lightness colors. Each
 * column's tooltip carries the full breakdown — the table view for people who need numbers.
 */
export function stackedBars(data, keys, stacks, colorOf, { format = fmtCount } = {}) {
	const bucketCount = data.bucketCount;
	const totals = new Array(bucketCount).fill(0);
	for (const key of keys) for (let i = 0; i < bucketCount; i++) totals[i] += stacks.get(key)[i];
	const max = Math.max(...totals, 1);

	const columns = [];
	for (let i = 0; i < bucketCount; i++) {
		const t = data.startMs + i * data.bucketMs;
		const lines = [`${clock(t)} — ${format(totals[i])}`];
		const segments = [];
		// Bottom-up: column-reverse in CSS, so append biggest (first key) first.
		for (const key of keys) {
			const v = stacks.get(key)[i];
			if (v > 0) {
				lines.push(`${key}: ${format(v)}`);
				segments.push(
					el('div', {
						cls: 'seg',
						style: { height: `${(v / max) * 100}%`, background: colorOf(key) },
					})
				);
			}
		}
		columns.push(el('div', { cls: 'col', title: lines.join('\n') }, segments));
	}

	return el('div', null, [el('div', { cls: 'tchart' }, columns), timeAxis(data)]);
}

/**
 * Line chart over the window's buckets. `series`: `[{ label, color, points }]`, points
 * aligned to buckets with nulls for empty buckets (drawn as gaps, never as zero — an empty
 * minute is absence of data, and a line dropping to zero would read as a latency collapse).
 */
export function lineChart(data, series, { format = fmtMs, band } = {}) {
	const ns = 'http://www.w3.org/2000/svg';
	const W = 600;
	const H = 150;
	const PAD = 4;
	// One reference line or several: a normalized chart has two worth drawing (due, and the point
	// the page stops being servable at all), and they are the same kind of mark.
	const bands = [band].flat().filter((v) => Number.isFinite(v));
	const max = Math.max(...series.flatMap((s) => s.points.filter((p) => Number.isFinite(p))), ...bands, 1);
	const bucketCount = data.bucketCount;
	const x = (i) => PAD + (i / Math.max(1, bucketCount - 1)) * (W - 2 * PAD);
	const y = (v) => H - PAD - (v / max) * (H - 2 * PAD);

	const svg = document.createElementNS(ns, 'svg');
	svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
	svg.setAttribute('preserveAspectRatio', 'none');
	svg.setAttribute('class', 'tline');

	// Recessive grid: quarter lines only.
	for (const f of [0.25, 0.5, 0.75]) {
		const line = document.createElementNS(ns, 'line');
		line.setAttribute('x1', PAD);
		line.setAttribute('x2', W - PAD);
		line.setAttribute('y1', y(max * f));
		line.setAttribute('y2', y(max * f));
		line.setAttribute('class', 'grid');
		svg.appendChild(line);
	}

	// Reference bands (e.g. a lease time, an interval, or 1.0 on a normalized chart) the values
	// should sit under.
	for (const at of bands) {
		const line = document.createElementNS(ns, 'line');
		line.setAttribute('x1', PAD);
		line.setAttribute('x2', W - PAD);
		line.setAttribute('y1', y(at));
		line.setAttribute('y2', y(at));
		line.setAttribute('class', 'band');
		svg.appendChild(line);
	}

	for (const s of series) {
		// Split into runs at nulls so gaps stay gaps.
		let run = [];
		const flush = () => {
			if (run.length > 1) {
				const poly = document.createElementNS(ns, 'polyline');
				poly.setAttribute('points', run.map(([px, py]) => `${px},${py}`).join(' '));
				poly.setAttribute('fill', 'none');
				poly.setAttribute('stroke', s.color);
				poly.setAttribute('stroke-width', '2');
				poly.setAttribute('stroke-linejoin', 'round');
				poly.setAttribute('stroke-linecap', 'round');
				poly.setAttribute('vector-effect', 'non-scaling-stroke');
				svg.appendChild(poly);
			} else if (run.length === 1) {
				const dot = document.createElementNS(ns, 'circle');
				dot.setAttribute('cx', run[0][0]);
				dot.setAttribute('cy', run[0][1]);
				dot.setAttribute('r', '2.5');
				dot.setAttribute('fill', s.color);
				svg.appendChild(dot);
			}
			run = [];
		};
		s.points.forEach((v, i) => (Number.isFinite(v) ? run.push([x(i), y(v)]) : flush()));
		flush();
	}

	// Hover layer: one cell per bucket carrying the tooltip (hit target wider than any mark).
	const cells = [];
	for (let i = 0; i < bucketCount; i++) {
		const lines = [clock(data.startMs + i * data.bucketMs)];
		for (const s of series) lines.push(`${s.label}: ${format(s.points[i])}`);
		cells.push(el('div', { cls: 'cell', title: lines.join('\n') }));
	}

	return el('div', null, [
		el('div', { cls: 'tchart-wrap' }, [
			svg,
			el('div', { cls: 'hover-cells' }, cells),
			el('span', { cls: 'ymax mono', text: format(max) }),
		]),
		timeAxis(data),
	]);
}

/** Ranked horizontal bars — magnitude + identity for a nominal list (bots, reasons, routes). */
export function barList(rows, { format = fmtCount, color = SERIES[0], max: maxIn } = {}) {
	const max = maxIn ?? Math.max(...rows.map((r) => r.value), 1);
	return el(
		'div',
		{ cls: 'barlist' },
		rows.map((row) =>
			el('div', { cls: 'brow', title: row.title ?? `${row.label}: ${format(row.value)}` }, [
				el('span', { cls: 'blabel truncate' }, [row.label]),
				el('div', { cls: 'btrack' }, [
					el('span', {
						cls: 'bfill',
						style: { width: `${Math.max(1, (row.value / max) * 100)}%`, background: row.color ?? color },
					}),
				]),
				el('span', { cls: 'bvalue mono', text: format(row.value) }),
				row.sub !== undefined && el('span', { cls: 'bsub mono muted', text: row.sub }),
			])
		)
	);
}

/** Sparse time labels under a chart: first, middle, last. */
function timeAxis(data) {
	const at = (i) => clock(data.startMs + i * data.bucketMs);
	return el('div', { cls: 'taxis mono' }, [
		el('span', { text: at(0) }),
		el('span', { text: at(Math.floor(data.bucketCount / 2)) }),
		el('span', { text: at(data.bucketCount) }),
	]);
}

/** Segmented single-choice control. `items`: `[{ label, value, title }]`. */
export function segmented(items, current, onPick) {
	return el(
		'div',
		{ cls: 'segctl', role: 'group' },
		items.map(({ label, value, title }) =>
			el('button', { cls: value === current ? 'on' : '', text: label, title, onclick: () => onPick(value) })
		)
	);
}

/** Segmented range picker. `ranges`: `[{ label, ms }]`. */
export const rangePicker = (ranges, currentMs, onPick) =>
	segmented(
		ranges.map(({ label, ms }) => ({ label, value: ms })),
		currentMs,
		onPick
	);

/**
 * A multi-select filter row. `items`: `[{ label, value, sub, color, title }]`.
 *
 * Toggling one is a CLIENT-SIDE narrowing of a payload already fetched — never a refetch. That is
 * the whole reason the console can offer this filter at all: the analytics window is one bounded
 * scan shared by every panel and every operator inside the cache TTL, and a filter that re-queried
 * per selection would turn an idle dashboard into a scan generator on workers that also serve bot
 * traffic. Callers re-render; they must not reload.
 */
export function chips(items, { isOn, onToggle }) {
	return el(
		'div',
		{ cls: 'chips' },
		items.map((item) =>
			el(
				'button',
				{
					'cls': `chip${isOn(item.value) ? ' on' : ''}`,
					'title': item.title,
					'aria-pressed': isOn(item.value) ? 'true' : 'false',
					'onclick': () => onToggle(item.value),
				},
				[
					item.color && el('span', { cls: 'swatch', style: { background: item.color } }),
					el('span', { text: item.label }),
					item.sub !== undefined && item.sub !== null && el('span', { cls: 'chip-sub mono', text: item.sub }),
				]
			)
		)
	);
}

/**
 * The footer every analytics card group carries: what this refresh actually cost, on which
 * node, and how stale the cached window is. The console shows its own query cost for the
 * same reason the collector logs one — a dashboard that can slow a constrained node down
 * must say what it spent.
 */
export function scanFooter(data) {
	const parts = [];
	const scans = data.scan?.scans ?? 1;
	if (data.sources?.mode === 'merged') parts.push(`${data.sources.answered} nodes merged`);
	else if (data.sources?.mode === 'shared') parts.push(`${data.sources.servedBy} (${data.sources.note})`);
	else parts.push(data.scope === 'cluster' ? 'cluster-wide (analytics replicate)' : `this node (${data.node})`);
	if (data.scan) {
		parts.push(
			`${scans === 1 ? 'one scan' : `${scans} scans`}: ${data.scan.kept.toLocaleString()} of ` +
				`${data.scan.scanned.toLocaleString()} rows in ${scans === 1 ? '' : '≤'}${data.scan.ms}ms`
		);
	}
	if (data.truncated) {
		parts.push(
			`hit the ${data.scan.cap.toLocaleString()}-row cap — covers ${clock(data.coveredFromMs)}–${clock(data.coveredToMs)} only`
		);
	}
	parts.push(
		data.cacheAgeMs !== null && data.cacheAgeMs !== undefined && data.cacheAgeMs > 1000
			? `cached ${Math.round(data.cacheAgeMs / 1000)}s ago`
			: 'fresh'
	);
	return el('span', { cls: 'muted mono', text: parts.join(' · ') });
}

/**
 * What a payload's numbers actually cover, for card titles and eyebrows: "all N nodes", or the
 * node's own hostname. Panels say this out loud on EVERY card that carries a total, because the
 * same tile means something very different at 1/N scale — an operator who reads a per-node
 * serve rate as the cluster's will conclude the deployment is doing a quarter of its work.
 */
export function scopeLabel(data) {
	const sources = data?.sources;
	if (sources?.mode === 'merged') {
		return sources.complete ? `all ${sources.configured} nodes` : `${sources.answered} of ${sources.configured} nodes`;
	}
	if (sources?.mode === 'shared') return `cluster · read from ${sources.servedBy}`;
	if (data?.scope === 'cluster') return 'cluster-wide';
	return data?.node ? `node ${data.node}` : 'this node';
}

/** True when the payload is a cluster merge rather than one node's slice. */
export const isMerged = (data) => data?.sources?.mode === 'merged';

/** True when the window has no rows at all — the "is analytics even on" empty state. */
export const windowEmpty = (data) => !data?.series?.length;

/** Shared empty-state copy for a window with no rows. */
export const emptyNote = (what, data) =>
	el('div', { cls: 'note' }, [
		`No ${what} rows in this window on ${isMerged(data) ? 'any node' : 'this node'}. Either no matching traffic `,
		'arrived, the window is too narrow, or analytics is off (',
		el('code', { text: 'analytics.enabled' }),
		' gates recording). Analytics rows are node-local; a cluster view sums every node’s own slice.',
	]);

// ---- origin load: the net offload arithmetic ---------------------------------
//
// Shared by Traffic (which shows every term) and the Overview (which shows the figure), so the two
// can never disagree about what "net" means.

// Series names as constants: the route-contract scanner in adminAssets.test.js reads a quoted
// name inside a Map lookup or a comparison as a fetch of a route by that name.
const RENDER_OUTCOME = 'outcome';
const PROBE_REQUESTS = 'probe_probed';
const SITEMAP_FETCHES = 'sitemap_sitemaps';

/**
 * Every request the origin answered because this deployment exists, over the window, beside the
 * requests crawlers made — the two sides of the net offload figure.
 *
 * GROSS OFFLOAD IS FLATTERING. It is the share of crawler requests that were not proxied live
 * (`bot_serve` source ≠ origin), and it counts what the origin was spared and none of what this
 * system asks of the origin in exchange. A deployment rendering its whole corpus on a short
 * cadence for a trickle of bot traffic can post a 95% gross offload while sending the origin MORE
 * requests than the crawlers would have. Net offload is
 * `1 − (proxied + renders + probes + sitemap fetches) ÷ crawler requests arrived`.
 *
 * FOUR TERMS, each from a series already in the scan:
 *
 *   proxied   `bot_serve` source = origin. A crawler request forwarded live: a miss, a page past
 *             its SWR window, a blob fault nobody rescued, an invalidated page, a skip, a bypass.
 *   renders   `render` series `outcome` — EXACTLY one row per posted result (metrics.js), so its
 *             count is the number of page loads the headless fleet performed against the origin,
 *             whatever became of each (rendered, suppressed, failed, transient…). Each is counted as
 *             ONE origin request: the document. A page load also pulls the page's own scripts and
 *             stylesheets, which reach the origin only if the CDN does not cache them for the
 *             renderer — a deployment fact no metric here can see, so it is stated, not estimated.
 *   probes    `probe_probed` — one origin call per attempt, failures included (a refused probe was
 *             still a request). Sweep and canary both emit it. A probe hits a small endpoint, not a
 *             page render, so it is cheaper than the other three; it is still a request.
 *   sitemaps  `sitemap_sitemaps` — one fetch per sitemap a refresh run processed.
 *
 * `renders` is read with sumCount (one emit = one result); the two pass counters with sumValues
 * (one emit per pass carrying the pass's count — sumCount there would count passes).
 *
 * THE DENOMINATOR IS `bot_request`, not `bot_serve`: without this system the CDN forwards every
 * crawler request to the origin, including the few that never reach a serve outcome here, so the
 * baseline is what ARRIVED. When the window has serves but no requests (it should not — both are
 * gated identically — but an older plugin could), the serve total stands in.
 *
 * A FIFTH TERM IS EXPOSED BUT NOT COUNTED — what a crawler fetches from the origin AFTER we hand
 * it a page. A rendering crawler (Google's WRS, Bingbot, Applebot) loads the page's scripts and
 * then makes whatever XHR/fetch calls the page makes — inventory, pricing, personalisation — and
 * those are the calls least likely to be cacheable anywhere; an image crawler fetches the images;
 * any crawler may follow a linked resource. None of it passes through this plugin: the CDN
 * forwards the DOCUMENT request to us and sends the crawler's subrequests straight to the origin,
 * so no series here can count them, and a net figure that quietly omitted them would be
 * flattering in exactly the way the gross one is. What CAN be counted is the exposure: every page
 * handed to a crawler — ALL of them, not a guessed subset of bots that "probably" fetch more,
 * because which crawler does what is a fact about the crawler that this console should not
 * assert. It is reported as that — a count of pages, never multiplied by a guessed
 * requests-per-page — and every reader of this figure says "before crawler follow-up requests".
 * The measured version needs the render fleet and the registry: our own headless Chrome loads the
 * same pages and already runs a cache policy on every same-origin response, so "uncacheable
 * same-origin subrequests per page load" is measurable there; stored on the cached page and
 * multiplied at serve time by what the registry says that crawler fetches, it becomes a counted
 * term. A snapshot with its scripts stripped hydrates nothing, which makes even the rendering
 * crawlers' share of this an upper bound.
 *
 * WHAT IS NOT COUNTED, so nobody assumes it is: crawler requests the CDN answered from its own
 * cache (they never reach this plugin), renders that crashed before posting a result (no row), and
 * cluster-internal traffic — peer rescue and forwarded heals are node-to-node, never origin.
 *
 * `lumpy` is true when either pass counter contributed: those land in the bucket where the pass
 * FINISHED, so over a range shorter than a pass the term is either absent or all of it. Over a
 * 24h range it is right to within one pass.
 */
export function originLoad(data) {
	const serves = pick(data, 'bot_serve');
	const served = sumCount(serves);
	const proxied = sumCount(serves.filter((s) => s.path === 'origin'));
	const renders = sumCount(pick(data, 'render', (s) => s.path === RENDER_OUTCOME));
	const probes = sumValues(pick(data, 'prerender_ops', (s) => s.path === PROBE_REQUESTS));
	const sitemaps = sumValues(pick(data, 'prerender_ops', (s) => s.path === SITEMAP_FETCHES));
	const requests = sumCount(pick(data, 'bot_request'));
	const arrived = requests > 0 ? requests : served;
	const total = proxied + renders + probes + sitemaps;

	return {
		proxied,
		renders,
		probes,
		sitemaps,
		total,
		arrived,
		// Null, never 0 or 100%: an empty window has no offload to report.
		net: arrived > 0 ? (arrived - total) / arrived : null,
		lumpy: probes > 0 || sitemaps > 0,
		// The fifth term's exposure: every page handed to a crawler, cache-served or proxied alike —
		// the crawler fetches what it fetches next either way.
		handed: served,
	};
}

/**
 * Per-bucket origin load by cause, for a stacked chart: stackBy's inner loop applied per TERM
 * rather than over one metric's dimension, because the four terms come from three metrics and two
 * value semantics. The proxied and render terms are per-request counts; the two pass counters are
 * VALUES (one emit carrying a count), so their per-bucket form is mean × count, as in stackBy's
 * values mode.
 */
export function originLoadBuckets(data) {
	const bucketsOf = (combos, values) => {
		const out = new Array(data.bucketCount).fill(0);
		for (const combo of combos) {
			for (let i = 0; i < combo.counts.length && i < out.length; i++) {
				if (!values) out[i] += combo.counts[i];
				else if (Number.isFinite(combo.means?.[i]) && combo.counts[i] > 0) out[i] += combo.means[i] * combo.counts[i];
			}
		}
		return out;
	};
	return new Map([
		[
			'proxied',
			bucketsOf(
				pick(data, 'bot_serve', (s) => s.path === 'origin'),
				false
			),
		],
		[
			'renders',
			bucketsOf(
				pick(data, 'render', (s) => s.path === RENDER_OUTCOME),
				false
			),
		],
		[
			'probes',
			bucketsOf(
				pick(data, 'prerender_ops', (s) => s.path === PROBE_REQUESTS),
				true
			),
		],
		[
			'sitemaps',
			bucketsOf(
				pick(data, 'prerender_ops', (s) => s.path === SITEMAP_FETCHES),
				true
			),
		],
	]);
}

/**
 * A net offload as a percentage that may be NEGATIVE. `pct()` is built for shares of a whole;
 * this is a signed ratio of 1, and a minus sign here is the finding.
 */
export const fmtNet = (net) => (Number.isFinite(net) ? `${Math.round(net * 100)}%` : '—');
