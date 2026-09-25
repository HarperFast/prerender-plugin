/**
 * Queue: is the render machinery keeping up, and is every node pulling its weight?
 *
 * One page for the supply side: the cluster pause, the backlog (due now, in flight, the claim
 * floor), the nodes doing the claiming (status, intent, throughput), what their renders produced,
 * and the options that shape all of it. The node table lived on its own Nodes page, which answered
 * every question about the queue except the one it was opened for; it is here now, beside the
 * throughput it explains.
 *
 * TWO CLOCKS, KEPT APART. The backlog numbers come from a snapshot computed on a background cadence
 * (possibly minutes old); the claim floor and in-flight gauge are read at request time; the charts
 * are a bucketed window over the shared time range. Nothing here subtracts one clock from another.
 *
 * THE PAUSE WORDING IS LOAD-BEARING. `QueueControl` is replicated INTENT; `QueueStatus` is what each
 * node last OBSERVED. A control write converges within one statusSyncInterval, so the two are
 * separate columns, or operators conclude a pause failed and click it repeatedly.
 */

import {
	ago,
	card,
	duration,
	el,
	ICONS,
	muted,
	num,
	pct,
	pill,
	section,
	shortUrl,
	spacer,
	stat,
	stats,
	table,
} from '../ui.js';
import {
	barList,
	colorFor,
	emptyNote,
	fmtCount,
	fmtMs,
	isMerged,
	legend,
	lineChart,
	nodeColor,
	nodeEntries,
	nodeSeries,
	OUTCOME_COLORS,
	pick,
	scanFooter,
	scopeLabel,
	SERIES,
	stackBy,
	stackedBars,
	sumCount,
	sumValues,
	weighted,
	weightedBuckets,
	windowEmpty,
} from '../charts.js';
import { appliedNote, editTray, loadConfig, settingsCard } from './_configEdit.js';

export const meta = { id: 'queue', label: 'Queue', icon: ICONS.queue, ranged: true };

// Row cap for the on-demand "Deep recompute": enough to see past a backlog that has swallowed a
// production-sized `management.scanCap`, well under the plugin's own 100k ceiling.
const DEEP_SCAN_CAP = 50_000;

// Series names as constants: the route-contract scanner in adminAssets.test.js reads a quoted name
// inside a lookup or comparison as a fetch of an admin route.
const OUTCOME = 'outcome';

export async function load(ctx) {
	const [res, analyticsRes] = await Promise.all([
		ctx.get('overview'),
		ctx.get('analytics', { range: ctx.rangeMs }),
		// The settings below render from this, through the shared config scratch.
		loadConfig(ctx),
	]);
	ctx.data.overview = res.ok ? res.body : null;
	ctx.data.analytics = analyticsRes.ok ? analyticsRes.body : null;
	ctx.data.error = res.ok ? null : (res.body?.error ?? `Could not load queue state (${res.status})`);
}

export function render(ctx) {
	const data = ctx.data.overview;
	if (!data) return el('div', { cls: 'note bad', text: ctx.data.error ?? 'Could not load queue state.' });
	const analytics = ctx.data.analytics;
	const usable = analytics && analytics.available !== false && !windowEmpty(analytics);

	return [
		appliedNote(ctx),
		controlBar(ctx, data),
		belowFloor(data),
		usable && legacyRenderers(analytics),
		kpis(data, usable ? analytics : null),
		nodeTable(ctx, data, analytics),
		usable
			? el('div', { cls: 'cols' }, [outcomesCard(analytics), rendersByNode(analytics) ?? timesCard(analytics)])
			: card('Renders', { body: [emptyNote('render', analytics)] }),
		usable &&
			nodeEntries(analytics).length > 0 &&
			el('div', { cls: 'cols' }, [timesCard(analytics), detailCard(analytics)]),
		usable && nodeEntries(analytics).length === 0 && detailCard(analytics),
		upcoming(ctx, data),
		usable && prioritisation(ctx, analytics),
		usable && el('div', { cls: 'scan-foot' }, [scanFooter(analytics)]),
		settings(ctx),
		editTray(ctx),
	];
}

// ---- control -------------------------------------------------------------------

function controlBar(ctx, data) {
	const control = data.control?.cluster;
	const setPause = (paused) => ctx.run(() => ctx.post('queue', { scope: 'all', paused }));
	return el('div', { cls: 'bar' }, [
		el('span', { cls: 'bar-label', text: 'Cluster queue' }),
		control ? (control.paused ? pill('paused', 'bad', true) : pill('running', 'ok', true)) : pill('not set (running)'),
		control?.updatedBy && muted(`set by ${control.updatedBy} ${ago(new Date(control.updatedTime).getTime())}`),
		spacer(),
		muted(`nodes apply it within ${duration(data.intervals?.statusSyncInterval ?? 0)}`),
		el('button', { cls: 'danger small', text: 'Pause cluster', disabled: ctx.busy, onclick: () => setPause(true) }),
		el('button', { cls: 'small', text: 'Resume cluster', disabled: ctx.busy, onclick: () => setPause(false) }),
	]);
}

/**
 * THE ALARM FOR THE FAILURE MODE THE CLAIM FLOOR INTRODUCES. A row whose due time sits below the
 * floor is never claimed again and nothing else notices — the reconcile sweep tests row EXISTENCE.
 * The backlog snapshot is the only reader that scans from the index minimum, so it is the only
 * detector; it goes at the top because it is the one thing on this page that is silently permanent.
 */
function belowFloor(data) {
	const lastRun = data.backlog?.lastRun;
	if (!(lastRun?.belowFloor > 0)) return null;
	return el('div', { cls: 'note bad' }, [
		el('strong', {
			text: `${num(lastRun.belowFloor)} schedule row(s) sit below the claim floor and will never be claimed. `,
		}),
		lastRun.oldestBelowFloorMs ? `Oldest was due ${ago(lastRun.oldestBelowFloorMs)}. ` : '',
		'Recover with the queue action reset-claim-floor on the owning node, or wait for queue.claimFloor.resetInterval. ',
		'Usual cause: a due time written straight to the table.',
	]);
}

// ---- KPIs ------------------------------------------------------------------------

function kpis(data, analytics) {
	const backlog = data.backlog?.lastRun;
	const floor = data.claimFloor ?? {};
	// THE LIVE GAUGE FIRST: `claimFloor.occupancy` is read while this payload was built; the snapshot's
	// `inFlight` may be fifteen minutes old and is only the fallback.
	const inFlightLive = Number.isFinite(floor.occupancy);
	const inFlight = inFlightLive ? floor.occupancy : Number.isFinite(backlog?.inFlight) ? backlog.inFlight : null;

	const rendersPerHour = analytics
		? sumCount(pick(analytics, 'render', (s) => s.path === OUTCOME)) / (analytics.rangeMs / 3_600_000)
		: null;
	const clear = drain(backlog && !backlog.error ? backlog.overdue : null, inFlight, rendersPerHour);

	const tiles = [
		stat(
			'Due now',
			backlog && !backlog.error ? num(backlog.overdue) + (backlog.truncated ? '+' : '') : '—',
			backlog?.error
				? 'last snapshot failed'
				: !backlog
					? 'no snapshot yet'
					: Number.isFinite(clear.ms)
						? `~${duration(clear.ms)} to clear · ${ago(backlog.finishedAt)}`
						: `snapshot ${ago(backlog.finishedAt)}`,
			{
				warn: clear.verdict === 'warn' || !!backlog?.truncated,
				bad: clear.verdict === 'bad' || !!backlog?.error,
				title:
					'Includes in-flight renders — a leased row keeps its due time until it lands. "To clear" is the rows ' +
					'waiting beyond in-flight ÷ the render rate over the selected range.',
			}
		),
		stat('In flight', Number.isFinite(inFlight) ? num(inFlight) : '—', inFlightLive ? 'live' : 'from snapshot'),
		stat(
			'Claim floor lag',
			floor.enabled === false ? 'off' : Number.isFinite(floor.lagMs) ? duration(floor.lagMs) : '—',
			floor.enabled === false
				? 'queue.claimFloor.enabled is false'
				: floor.floorHeldBy
					? `held by ${shortUrl(floor.floorHeldBy)}`
					: floor.worstNode
						? `worst: ${floor.worstNode}`
						: 'live',
			{
				// The floor cannot pass the oldest DUE ROW and only that row's result moves it, so a lag
				// past two leases means one render is holding everything behind it.
				warn: Number.isFinite(floor.lagMs) && floor.lagMs > 2 * (data.intervals?.jobLeaseTime ?? 0),
				title:
					(floor.worstNode ? `Worst node: ${floor.worstNode}. ` : '') +
					(floor.floorHeldBy
						? `Held by ${floor.floorHeldBy}${floor.floorPinnedForMs > 0 ? ` for ${duration(floor.floorPinnedForMs)}` : ''}.`
						: 'How far back the claim scan starts.'),
			}
		),
	];

	if (analytics) {
		const outcomes = pick(analytics, 'render', (s) => s.path === OUTCOME);
		const times = pick(analytics, 'render', (s) => s.path === 'time_ms');
		const candidateTimes = pick(analytics, 'render', (s) => s.path === 'time_ms' && s.type === 'candidate');
		const claims = pick(analytics, 'queue_health', (s) => s.path === 'claim_scan_ms');
		const total = sumCount(outcomes);
		const failedLike = sumCount(outcomes.filter((s) => s.method === 'failed' || s.method === 'auth-failure'));
		const hours = analytics.rangeMs / 3_600_000;
		tiles.push(
			stat('Renders / hour', fmtCount(total / hours), `${num(total)} results · ${scopeLabel(analytics)}`),
			stat('Failed', pct(failedLike, total), `${num(failedLike)} failed or auth-failed`, {
				// One in ten failing is past tail noise for any healthy corpus.
				warn: total > 0 && failedLike > total / 10,
			}),
			// THE MEAN, because capacity is concurrency ÷ MEAN render time. Since browser v1.18.0 the pooled
			// mean mixes cheap non-indexable bails with full renders, so the stored-page mean rides along.
			stat(
				'Render time',
				fmtMs(weighted(times, 'mean')),
				`mean · p95 ${fmtMs(weighted(times, 'p95'))}${
					candidateTimes.length && candidateTimes.length !== times.length
						? ` · stored ${fmtMs(weighted(candidateTimes, 'mean'))}`
						: ''
				}`,
				{ title: 'Capacity is concurrency ÷ this mean. "stored" is the mean of renders that produced a cached page.' }
			),
			stat('Claim scan', fmtMs(weighted(claims, 'p95')), `p95 ≈ · median ${fmtMs(weighted(claims, 'median'))}`, {
				title: 'The leading indicator: it degrades before any backlog shows.',
			})
		);
	}
	return stats(tiles);
}

/**
 * How long the current backlog takes to clear at the render rate just observed — the verdict "due
 * now" alone cannot give. A leased row keeps its due time until it lands, so in-flight work is netted
 * out first; a few hundred rows due on a fleet doing thousands an hour is minutes of work, not a
 * finding. Shared with the Health view so the two pages cannot disagree.
 *
 * Returns `{ ms, verdict }`; `ms` is null when there is no rate to divide by. Past two hours the
 * backlog is outrunning a normal cadence's slack (watch), past eight a daily corpus is going stale
 * faster than it renders (bad). A backlog with NO renders in the window is bad on its face.
 */
export function drain(overdue, inFlight, rendersPerHour) {
	if (!Number.isFinite(overdue)) return { ms: null, verdict: 'na' };
	const waiting = Math.max(0, overdue - (Number.isFinite(inFlight) ? inFlight : 0));
	if (waiting === 0) return { ms: 0, verdict: 'ok' };
	if (!(rendersPerHour > 0)) return { ms: null, verdict: 'bad' };
	const ms = (waiting / rendersPerHour) * 3_600_000;
	return { ms, verdict: ms > 8 * 3_600_000 ? 'bad' : ms > 2 * 3_600_000 ? 'warn' : 'ok' };
}

// ---- nodes ---------------------------------------------------------------------------

/** How long a node has HELD its current status — the row is written only on a change. */
export const nodeAge = (node) =>
	Number.isFinite(node.statusChangedTime) ? muted(ago(node.statusChangedTime)) : muted('never recorded');

export const statusPill = (status) =>
	pill(
		status ?? 'unknown',
		status === 'paused' ? 'bad' : status === 'queued' ? 'ok' : status === 'empty' ? '' : 'warn'
	);

/**
 * One row per node: observed status, liveness, intent, and its own render throughput over the range.
 *
 * Throughput comes from the merge's per-node totals. A blank means that node did not answer —
 * never "idle", which is what printing zero would say. Hostnames are lowercased on both sides of the
 * join: `node` is the node's own `server.hostname` (whatever case its config used) and `hostname` is
 * the configured origin's host, which `new URL()` already lowercased.
 */
function nodeTable(ctx, data, analytics) {
	const setPause = (scope, paused) => ctx.run(() => ctx.post('queue', { scope, paused }));
	const hours = (analytics?.rangeMs ?? 0) / 3_600_000;

	const byHost = new Map();
	const index = (key, value) => key && byHost.set(String(key).toLowerCase(), value);
	if (analytics && analytics.available !== false) {
		if (analytics.byNode) {
			for (const entry of analytics.byNode) {
				const outcomes = (entry.totals ?? []).filter((s) => s.metric === 'render' && s.path === OUTCOME);
				const total = outcomes.reduce((acc, s) => acc + s.count, 0);
				const failed = outcomes
					.filter((s) => s.method === 'failed' || s.method === 'auth-failure')
					.reduce((acc, s) => acc + s.count, 0);
				const value = { total, failed, hours: (entry.rangeMs ?? analytics.rangeMs) / 3_600_000 };
				index(entry.node, value);
				index(entry.hostname, value);
			}
		} else if (analytics.node) {
			const outcomes = pick(analytics, 'render', (s) => s.path === OUTCOME);
			index(analytics.node, {
				total: sumCount(outcomes),
				failed: sumCount(outcomes.filter((s) => s.method === 'failed' || s.method === 'auth-failure')),
				hours,
			});
		}
	}
	const clusterTotal = [...new Set(byHost.values())].reduce((acc, v) => acc + v.total, 0);
	const rateOf = (hostname) => byHost.get(String(hostname ?? '').toLowerCase()) ?? null;

	const rows = (data.nodes ?? []).map((node) => {
		const rate = rateOf(node.hostname);
		return el('tr', null, [
			el('td', { cls: 'mono' }, [node.hostname, node.isThisNode && muted(' ·this')]),
			el('td', null, [node.responding === false ? pill('not responding', 'bad') : statusPill(node.status)]),
			el('td', null, [nodeAge(node)]),
			el('td', {
				cls: 'right mono' + (rate ? '' : ' muted'),
				text: rate && rate.hours > 0 ? fmtCount(rate.total / rate.hours) : '—',
			}),
			el('td', { cls: 'right mono muted', text: rate && clusterTotal > 0 ? pct(rate.total, clusterTotal) : '—' }),
			el('td', { cls: 'right' }, [
				rate && rate.total > 0
					? el('span', {
							cls: rate.failed > rate.total / 10 ? 'pill warn' : 'mono',
							text: pct(rate.failed, rate.total),
						})
					: muted('—'),
			]),
			el('td', null, [
				node.override
					? node.override.paused
						? pill('paused here', 'bad')
						: pill('forced on', 'ok')
					: muted('inherits'),
			]),
			el('td', null, [
				el('div', { cls: 'row-actions' }, [
					el('button', {
						cls: 'danger small',
						text: 'Pause',
						disabled: ctx.busy,
						onclick: () => setPause(node.hostname, true),
					}),
					el('button', {
						cls: 'small',
						text: 'Force run',
						disabled: ctx.busy,
						onclick: () => setPause(node.hostname, false),
					}),
					el('button', {
						cls: 'small',
						text: 'Inherit',
						disabled: ctx.busy || !node.override,
						onclick: () => setPause(node.hostname, null),
					}),
				]),
			]),
		]);
	});

	// A row every peer holds an older copy of means replication is not delivering that node's writes —
	// visible only here, where four copies of the same replicated row are compared side by side.
	const diverged = (data.nodes ?? []).filter((n) => n.behind?.length);

	return card('Nodes', {
		head: [spacer(), muted(isMerged(data) ? `${(data.nodes ?? []).length} nodes` : 'this node’s view')],
		help: [
			'Status is what each node last observed; the row is written only when it changes, so "since" on a ',
			'steady node reads hours and that is healthy. Intent is the per-node override, which wins over the ',
			'cluster control in both directions. Renders/h and failed are each node’s own results over the ',
			'selected range; a blank means that node did not answer, never that it is idle.',
		],
		body: [
			diverged.length > 0 &&
				el('div', { cls: 'note bad' }, [
					'Replication gap: ' +
						diverged
							.map(
								(n) =>
									`${n.hostname} is ${duration(n.spreadMs)} behind on ${n.behind.map((b) => b.reporter).join(', ')}`
							)
							.join('; ') +
						'. Those nodes are not receiving its render_service writes (Target included).',
				]),
			table(
				[
					'node',
					'status',
					'since',
					{ text: 'renders/h', right: true },
					{ text: 'share', right: true },
					{ text: 'failed', right: true },
					'intent',
					{ text: '', right: true },
				],
				rows,
				'No nodes have reported queue status yet.'
			),
		],
		cls: 'flush',
	});
}

// ---- charts -------------------------------------------------------------------------

function outcomesCard(data) {
	const outcomes = pick(data, 'render', (s) => s.path === OUTCOME);
	const { keys, stacks } = stackBy(outcomes, 'method', data.bucketCount);
	return card('Render outcomes', {
		head: [spacer(), legend(keys.map((k) => ({ label: k, color: colorFor(OUTCOME_COLORS, k) })))],
		help:
			'One row per posted result. A rising auth-failure share with steady suppressed is the broken-bypass-token ' +
			'signature; suppressed climbing on its own is the corpus being mass-suppressed.',
		body: [
			outcomes.length ? stackedBars(data, keys, stacks, (k) => colorFor(OUTCOME_COLORS, k)) : emptyNote('render', data),
		],
	});
}

/** Renders per node over the range — the chart that says which node stopped pulling its weight. */
function rendersByNode(data) {
	const entries = nodeEntries(data);
	if (!entries.length) return null;
	const perHour = 3_600_000 / data.bucketMs;
	const series = entries.map((entry, i) => ({
		label: entry.label,
		color: nodeColor(i),
		points: nodeSeries(entry, data.bucketCount, 'render', (s) => s.path === OUTCOME).map((c) => c * perHour),
	}));
	return card('Renders by node', {
		head: [spacer(), legend(series.map(({ label, color }) => ({ label, color })))],
		help: 'Posted render results per hour, per node. A line falling away from the others is a node that has stopped claiming.',
		body: [lineChart(data, series, { format: (v) => (Number.isFinite(v) ? `${fmtCount(v)}/h` : '—') })],
	});
}

function timesCard(data) {
	const times = pick(data, 'render', (s) => s.path === 'time_ms');
	const claims = pick(data, 'queue_health', (s) => s.path === 'claim_scan_ms');
	const series = [
		{ label: 'render p95', color: SERIES[2], points: weightedBuckets(times, 'p95s', data.bucketCount) },
		{ label: 'claim scan p95', color: SERIES[0], points: weightedBuckets(claims, 'p95s', data.bucketCount) },
	];
	return card('Render time & claim scan', {
		head: [spacer(), legend(series.map(({ label, color }) => ({ label, color })))],
		help:
			'Tails (p95, count-weighted ≈), not capacity: renders/hour is concurrency ÷ the MEAN render time in the tile ' +
			'above. The claim scan degrades before any backlog shows, so its trend matters more than its level.',
		body: [
			series.some((s) => s.points.some((p) => Number.isFinite(p)))
				? lineChart(data, series)
				: emptyNote('render time / claim scan', data),
		],
	});
}

function detailCard(data) {
	const outcomes = pick(data, 'render', (s) => s.path === OUTCOME);
	const details = new Map();
	for (const s of outcomes) {
		const key = `${s.method}${s.type && s.type !== 'unspecified' ? ` · ${s.type}` : ''}`;
		details.set(key, { count: (details.get(key)?.count ?? 0) + s.count, method: s.method });
	}
	const ranked = [...details.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 12);
	return card('Outcome detail', {
		body: [
			ranked.length
				? barList(
						ranked.map(([label, { count, method }]) => ({
							label,
							value: count,
							color: colorFor(OUTCOME_COLORS, method),
						}))
					)
				: emptyNote('render outcomes', data),
		],
	});
}

/**
 * A renderer too old for URL jobs (`prerender_ops.legacy_renderer`). SHOWN ONLY WHEN NON-ZERO: zero is
 * the steady state, and non-zero is a mid-upgrade fleet whose unrendered devices show up nowhere else
 * on this page — the old pod posts well-formed single-device results and every other number stays clean.
 */
function legacyRenderers(data) {
	const rows = pick(data, 'prerender_ops', (s) => s.path === 'legacy_renderer');
	const total = sumCount(rows);
	if (!total) return null;
	const devices = [...new Set(rows.map((s) => s.method).filter(Boolean))].sort();
	return el('div', { cls: 'note bad' }, [
		el('strong', {
			text: `${num(total)} result${total === 1 ? '' : 's'} came from a renderer older than browser 1.23.0. `,
		}),
		'It rendered only ',
		devices.length ? el('code', { text: devices.join(', ') }) : 'one device',
		' of each job; the other devices are never being written and will fall out of cache. Upgrade the fleet.',
	]);
}

// ---- backlog histogram ----------------------------------------------------------------

function upcoming(ctx, data) {
	const { enabled, interval, running, lastRun } = data.backlog ?? {};
	const buckets = lastRun?.buckets ?? [];
	// A snapshot covers ONE node's owned keys, so "recompute" has no cluster meaning.
	const clusterScope = isMerged(data);

	const body = [];
	// A node that has never snapshotted contributes ZERO, indistinguishable from nothing due.
	if (lastRun?.missing?.length) {
		body.push(
			el('div', {
				cls: 'note warn',
				text: `No snapshot yet from ${lastRun.missing.join(', ')} — the real backlog is larger.`,
			})
		);
	}
	if (lastRun?.error) body.push(el('div', { cls: 'note bad', text: `The last snapshot failed: ${lastRun.error}` }));
	else if (!lastRun) body.push(el('div', { cls: 'empty', text: 'No snapshot computed yet.' }));
	else if (lastRun.truncated) {
		body.push(
			el('div', {
				cls: 'note warn',
				text:
					`The scan hit its ${num(lastRun.cap)}-row cap on the overdue backlog, so "due now" is a floor and this ` +
					'chart is empty. Deep recompute finds the real figure — size management.scanCap from it.',
			})
		);
	} else if (!buckets.some((bucket) => bucket.count))
		body.push(el('div', { cls: 'note ok', text: 'Nothing is due in the next 24 hours.' }));

	if (buckets.length) body.push(hourBars(buckets));

	return card('Renders due, next 24h', {
		head: [
			spacer(),
			enabled
				? muted(`every ${duration(interval)}${lastRun ? ` · ${ago(lastRun.finishedAt)}` : ''}`)
				: pill('snapshot disabled', 'warn'),
			el('button', {
				cls: 'small',
				text: clusterScope ? 'Recompute (pick a node)' : running ? 'Computing…' : 'Recompute',
				disabled: ctx.busy || running || clusterScope,
				title: clusterScope ? 'Each node snapshots the keys it owns. Pick a node to recompute its slice.' : null,
				onclick: () => ctx.run(() => ctx.post('backlog', {})),
			}),
			lastRun?.truncated &&
				el('button', {
					cls: 'small',
					text: 'Deep recompute',
					disabled: ctx.busy || running || clusterScope,
					title: `One ${num(DEEP_SCAN_CAP)}-row walk, this run only.`,
					onclick: () => ctx.run(() => ctx.post('backlog', { cap: DEEP_SCAN_CAP })),
				}),
		],
		help:
			'A flat spread means the initial-render jitter is working; a single tall hour is a render herd. In-flight ' +
			'work is not here — a leased row keeps its past due time, so it counts as "due now" above.',
		body,
	});
}

/** The hourly histogram as stacked-bar geometry, so it gets the same crosshair tooltip. */
function hourBars(buckets) {
	const max = Math.max(...buckets.map((b) => b.count), 0);
	const herd = (b) => max > 20 && b.count > max * 0.5 && buckets.filter((x) => x.count > max * 0.5).length <= 2;
	const keys = ['due', 'herd'];
	const stacks = new Map([
		['due', buckets.map((b) => (herd(b) ? 0 : b.count))],
		['herd', buckets.map((b) => (herd(b) ? b.count : 0))],
	]);
	const hour = 3_600_000;
	const start = Math.floor(Date.now() / hour) * hour;
	return stackedBars(
		{ bucketCount: buckets.length, startMs: start, bucketMs: hour },
		keys,
		stacks,
		(k) => (k === 'herd' ? 'var(--warn)' : 'var(--teal-500)'),
		{ share: false }
	);
}

// ---- prioritisation ----------------------------------------------------------------------

/**
 * Whether the render ORDER is actually being decided. The ready set REORDERS A FIXED AMOUNT OF WORK AND
 * MOVES NO TOTAL, so every other number on this page reads the same whether prioritisation works or is
 * off — `claim_granted` ready-vs-index is the only signal. Failures worth naming: every grant from
 * `index`; `ready_sweep_ms` coming back `capped`; `ready_published` zero against a backlog.
 */
function prioritisation(ctx, data) {
	const series = (name) => pick(data, 'queue_health', (s) => s.path === name);
	const granted = series('claim_granted');
	const sweeps = series('ready_sweep_ms');
	const published = series('ready_published');
	const cadence = series('ready_cadence');
	if (!granted.length && !sweeps.length && !published.length) return null;

	// sumVALUES: `claim_granted` emits once per claim pass carrying the number of jobs.
	const bySource = (name) => sumValues(granted.filter((s) => s.method === name));
	const fromReady = bySource('ready');
	const fromIndex = bySource('index');
	const grants = fromReady + fromIndex;
	// One emit per sweep, so emits ARE sweeps.
	const capped = sumCount(sweeps.filter((s) => s.method === 'capped'));
	const carried = sumValues(cadence.filter((s) => s.method === 'carried'));
	const resolved = sumValues(cadence.filter((s) => s.method === 'resolved'));
	// A per-sweep count, so its MEAN is entries per sweep.
	const perSweep = weighted(published, 'mean');
	const backlog = ctx.data.overview?.backlog?.lastRun?.overdue ?? null;

	const { keys, stacks } = stackBy(granted, 'method', data.bucketCount, { values: true });
	const sourceColor = (key) => (key === 'ready' ? 'var(--ok)' : SERIES[0]);

	return card('Render prioritisation', {
		head: [spacer(), legend(keys.map((k) => ({ label: k, color: sourceColor(k) })))],
		help: [
			'The ready set reorders a fixed amount of work and moves no total, so this is the only panel that can tell ',
			'prioritisation working from switched off. "Cadence carried" is a migration gauge: a row carries its own ',
			'interval once it re-renders, so it reads low right after an upgrade.',
		],
		body: [
			grants > 0 &&
				fromReady === 0 &&
				el('div', { cls: 'note bad' }, [
					'Every job came from the fallback index scan — nothing is being prioritised. The sweep is failing, ',
					el('code', { text: 'queue.ready.capacity' }),
					' could not be sized at boot (restart-scoped), or the set is always dry.',
				]),
			capped > 0 &&
				el('div', { cls: 'note warn' }, [
					`${num(capped)} sweep(s) hit `,
					el('code', { text: 'queue.ready.sweepCap' }),
					' — the ordering skips the recently-due rows it exists to protect.',
				]),
			stats([
				stat('Prioritised', pct(fromReady, grants), `${num(fromReady)} of ${num(grants)} jobs from the ready set`, {
					warn: grants > 0 && fromReady === 0,
				}),
				stat('Ready supply', perSweep === null ? '—' : fmtCount(perSweep), 'entries per sweep', {
					warn: perSweep === 0 && backlog > 0,
				}),
				stat('Sweep time', fmtMs(weighted(sweeps, 'mean')), sweeps.length ? 'mean' : 'no sweep in range'),
				stat('Cadence carried', pct(carried, carried + resolved), 'rows scored on their own cadence', {
					warn: carried + resolved > 0 && carried === 0,
				}),
			]),
			grants > 0
				? stackedBars(data, keys, stacks, sourceColor)
				: el('div', { cls: 'empty', text: 'No jobs granted in this range.' }),
		],
	});
}

// ---- settings ----------------------------------------------------------------------------

function settings(ctx) {
	return section('queue', 'Settings', [
		settingsCard(ctx, {
			title: 'Queue mechanics',
			prefix: 'queue',
			description:
				'How work is handed to the render fleet: lease length, claim batch size, the claim floor, and the ready set ' +
				'that decides the ORDER. None of it changes what is in the corpus, only how fast and in what order it is ' +
				'worked through. queue.ready.capacity is restart-scoped.',
		}),
		settingsCard(ctx, {
			title: 'Render scheduling',
			prefix: 'render',
			description:
				'What arrives in the queue at all: the render cadence, failure retry and suppression, and the repair sweep.',
		}),
		settingsCard(ctx, {
			title: 'Scan budgets',
			prefix: 'scan',
			description:
				'The bounds every registry walk runs under. A cap below the real backlog makes the backlog snapshot and the ' +
				'sweeps report a floor rather than a count.',
		}),
	]);
}
