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
	'miss': WARN,
	'stale': PINK,
	'invalidated': PURPLE,
	'skip': MUTED,
	'bypass': MUTED,
	'blob-missing': BAD,
	'blob-timeout': BAD,
};

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

export const pick = (data, metric, filter) =>
	(data?.series ?? []).filter((s) => s.metric === metric && (!filter || filter(s)));

export const sumCount = (combos) => combos.reduce((acc, s) => acc + s.count, 0);

/**
 * Stack combos by one dimension: returns `{ keys, stacks }` where `stacks[key]` is a
 * per-bucket count array summed over every combo whose `dim` equals `key`. Keys are ordered
 * by total, biggest first, so legends and stacking order match visual weight.
 */
export function stackBy(combos, dim, bucketCount) {
	const stacks = new Map();
	for (const combo of combos) {
		const key = combo[dim] ?? 'unknown';
		let arr = stacks.get(key);
		if (!arr) stacks.set(key, (arr = new Array(bucketCount).fill(0)));
		for (let i = 0; i < combo.counts.length && i < bucketCount; i++) arr[i] += combo.counts[i];
	}
	const keys = [...stacks.keys()].sort((a, b) => stacks.get(b).reduce(sum, 0) - stacks.get(a).reduce(sum, 0));
	return { keys, stacks };
}

const sum = (a, b) => a + b;

/** Count-weighted merge of a distribution stat across combos (approximate by construction). */
export function weighted(combos, stat) {
	let total = 0;
	let weight = 0;
	for (const combo of combos) {
		if (Number.isFinite(combo[stat]) && combo.count > 0) {
			total += combo[stat] * combo.count;
			weight += combo.count;
		}
	}
	return weight > 0 ? total / weight : null;
}

/** Per-bucket count-weighted merge of `means`/`p95s` arrays across combos. */
export function weightedBuckets(combos, stat, bucketCount) {
	const sums = new Array(bucketCount).fill(0);
	const weights = new Array(bucketCount).fill(0);
	for (const combo of combos) {
		const values = combo[stat];
		if (!values) continue;
		for (let i = 0; i < bucketCount; i++) {
			if (Number.isFinite(values[i]) && combo.counts[i] > 0) {
				sums[i] += values[i] * combo.counts[i];
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
	const max = Math.max(...series.flatMap((s) => s.points.filter((p) => Number.isFinite(p))), band ?? 0, 1);
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

	// A reference band (e.g. a lease time or an interval) the values should sit under.
	if (Number.isFinite(band)) {
		const line = document.createElementNS(ns, 'line');
		line.setAttribute('x1', PAD);
		line.setAttribute('x2', W - PAD);
		line.setAttribute('y1', y(band));
		line.setAttribute('y2', y(band));
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

/** Segmented range picker. `ranges`: `[{ label, ms }]`. */
export function rangePicker(ranges, currentMs, onPick) {
	return el(
		'div',
		{ cls: 'segctl', role: 'group' },
		ranges.map(({ label, ms }) =>
			el('button', { cls: ms === currentMs ? 'on' : '', text: label, onclick: () => onPick(ms) })
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
	parts.push(data.scope === 'cluster' ? 'cluster-wide (analytics replicate)' : `this node (${data.node})`);
	if (data.scan) {
		parts.push(
			`one scan: ${data.scan.kept.toLocaleString()} of ${data.scan.scanned.toLocaleString()} rows in ${data.scan.ms}ms`
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

/** True when the window has no rows at all — the "is analytics even on" empty state. */
export const windowEmpty = (data) => !data?.series?.length;

/** Shared empty-state copy for a window with no rows. */
export const emptyNote = (what) =>
	el('div', { cls: 'note' }, [
		`No ${what} rows in this window on this node. Either no matching traffic arrived here, `,
		'the window is too narrow, or analytics is off (',
		el('code', { text: 'analytics.enabled' }),
		' gates recording). Analytics rows are node-local: each node charts its own slice.',
	]);
