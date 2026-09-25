/**
 * Health: the numbers worth checking every time, each with a verdict, and a link to the page that
 * explains it.
 *
 * WHAT THIS PAGE IS FOR. The old overview was a second, smaller copy of other pages — a serve strip
 * that Traffic did better, a backlog chart, and three maintenance cards — and nothing on it answered
 * "is anything wrong?". This page answers only that. Every tile is a CHECK: a value, a verdict
 * (ok / watch / bad, or neutral where there is no honest threshold), and where to go next. Anything
 * not ok is repeated in the banner at the top, so a healthy cluster reads as one green line.
 *
 * THRESHOLDS are judgement calls, stated here so they can be argued with in one place. Each is set
 * where the number stops being tail noise for a healthy deployment, from the measured baselines the
 * other views' comments cite (cache-hit serves ~2ms p95; claim scan ~15ms, degrading ~17× before a
 * backlog shows; render failures well under 10%; a healthy corpus at median 0.5× its cadence).
 *
 * SYSTEM VITALS are per node and never averaged: CPU, memory, event loop and disk come from Harper's
 * own per-minute resource rows (plugin v0.92.0+, through the analytics window) and a point-in-time
 * host block on the overview fan-out. A tile shows the WORST node, because a cluster is only as
 * healthy as its most loaded member and a mean of four would hide it. On an older plugin the section
 * says so instead of showing zeros.
 *
 * NOTHING HERE SCANS BEYOND WHAT OTHER VIEWS ALREADY DO: `overview` is point reads plus a background
 * snapshot, `analytics` is the shared, per-worker-cached window, `config` and `invalidations` are
 * small replicated reads.
 */

import { ago, card, duration, el, ICONS, muted, num, pct, pill, spacer, table } from '../ui.js';
import {
	bucketTotals,
	CACHE_SERVED,
	fmtCount,
	fmtMs,
	fmtNet,
	fmtRate,
	fmtRatio,
	isMerged,
	originLoad,
	perMinute,
	pick,
	SERIES,
	spark,
	sumCount,
	sumValues,
	weighted,
	weightedBuckets,
	windowEmpty,
} from '../charts.js';
import { configState, loadConfig } from './_configEdit.js';
import { cadenceFor, cadenceIndex, coverageSplit, originCostByReason } from './traffic.js';
import { drain } from './queue.js';

export const meta = { id: 'health', label: 'Health', icon: ICONS.overview, ranged: true };

// Series names as constants (see the route-contract scanner in adminAssets.test.js).
const OUTCOME = 'outcome';
const CLAIM_SCAN = 'claim_scan_ms';
const GRANTED = 'claim_granted';
const ORIGIN = 'origin';

export async function load(ctx) {
	const [overviewRes, analyticsRes, , invalidationsRes] = await Promise.all([
		ctx.get('overview'),
		ctx.get('analytics', { range: ctx.rangeMs }),
		loadConfig(ctx),
		ctx.get('invalidations'),
	]);
	ctx.data.overview = overviewRes.ok ? overviewRes.body : null;
	ctx.data.analytics = analyticsRes.ok ? analyticsRes.body : null;
	ctx.data.invalidations = invalidationsRes.ok ? invalidationsRes.body : null;
	ctx.data.error = overviewRes.ok
		? null
		: (overviewRes.body?.error ?? `Could not load cluster state (${overviewRes.status})`);
}

export function render(ctx) {
	const overview = ctx.data.overview;
	const analytics = usable(ctx.data.analytics) ? ctx.data.analytics : null;
	const config = configState(ctx).payload;
	const nodes = nodeVitals(overview, ctx.data.analytics);

	const groups = [
		{ title: 'Serving', checks: servingChecks(analytics, config) },
		{ title: 'Rendering', checks: renderingChecks(analytics, overview) },
		{ title: 'Cluster', checks: clusterChecks(overview, config, nodes, ctx.data.analytics) },
		{ title: 'System', checks: systemChecks(nodes), empty: systemGap(nodes) },
		{ title: 'Maintenance', checks: maintenanceChecks(overview, ctx.data.invalidations) },
	];
	const all = groups.flatMap((group) => group.checks);

	return [
		!overview && el('div', { cls: 'note bad', text: ctx.data.error ?? 'Could not load cluster state.' }),
		ctx.data.analytics && !analytics && el('div', { cls: 'note warn', text: analyticsProblem(ctx.data.analytics) }),
		banner(ctx, all),
		...groups.map((group) => groupCard(ctx, group)),
		nodeTable(ctx, nodes),
	];
}

const usable = (data) => data && data.available !== false && !windowEmpty(data);

const analyticsProblem = (data) =>
	data.available === false
		? `Analytics unavailable: ${data.error ?? 'unknown reason'}`
		: 'No analytics rows in this range.';

// ---- verdicts ---------------------------------------------------------------------

const VERDICT_RANK = { bad: 3, warn: 2, ok: 1, info: 0, na: -1 };
const VERDICT_LABEL = { bad: 'bad', warn: 'watch', ok: '', info: '', na: 'n/a' };

/** `higher` thresholds: value above warn → watch, above bad → bad. */
const above = (value, warn, bad) =>
	!Number.isFinite(value) ? 'na' : value >= bad ? 'bad' : value >= warn ? 'warn' : 'ok';
const below = (value, warn, bad) =>
	!Number.isFinite(value) ? 'na' : value <= bad ? 'bad' : value <= warn ? 'warn' : 'ok';

/**
 * One check. `go` is the view that explains it; `spark` a per-bucket series; `detail` the full
 * sentence, shown in the tooltip and in the banner.
 */
const check = (id, label, value, verdict, extra = {}) => ({ id, label, value, verdict, ...extra });

// ---- serving -------------------------------------------------------------------------

function servingChecks(data, config) {
	if (!data) return [];
	const serves = pick(data, 'bot_serve');
	const total = sumCount(serves);
	const minutes = coveredMinutes(data);
	const originServes = sumCount(serves.filter((s) => s.path === ORIGIN));
	const cacheServes = sumCount(serves.filter((s) => CACHE_SERVED.has(s.method)));
	const load = originLoad(data);
	const coverage = coverageSplit({ serves, costs: originCostByReason(data), filter: null });

	const responses = (data.series ?? []).filter((s) => s.metric.startsWith('response_'));
	const responseTotal = sumCount(responses);
	const serverErrors = sumCount(
		responses.filter((s) => {
			const code = Number(s.metric.slice('response_'.length));
			return !Number.isFinite(code) || code >= 500;
		})
	);
	const fiveXX = responseTotal > 0 ? serverErrors / responseTotal : null;

	const hits = pick(data, 'duration', (s) => s.type === 'cache-hit');
	const hitP95 = weighted(hits, 'p95');

	const fetches = pick(data, 'origin_fetch');
	const fetchTotal = sumCount(fetches);
	const fetchFailed = sumCount(fetches.filter((s) => !(Number(s.path) > 0) || Number(s.path) >= 500));
	const failShare = fetchTotal > 0 ? fetchFailed / fetchTotal : null;

	const staleness = stalenessMedian(data, config);

	return [
		check('serves', 'Bot serves', minutes ? fmtRate(total / minutes) : '—', total === 0 ? 'warn' : 'info', {
			sub: `${num(total)} in range`,
			spark: perMinute(bucketTotals(serves, data.bucketCount), data.bucketMs),
			go: 'traffic',
			detail: total === 0 ? 'No bot serves in this range.' : null,
		}),
		check(
			'offload',
			'Net offload',
			fmtNet(load.net),
			Number.isFinite(load.net) ? (load.net < 0 ? 'bad' : load.net < 0.5 ? 'warn' : 'ok') : 'na',
			{
				sub: `gross ${pct(total - originServes, total)}`,
				go: 'traffic',
				detail:
					'Crawler requests the origin did not answer, net of the renders, probes and sitemap fetches this system sends it.',
			}
		),
		check('cache', 'Cache-served', pct(cacheServes, total), total > 0 ? below(cacheServes / total, 0.5, 0.25) : 'na', {
			sub: `${num(cacheServes)} serves`,
			go: 'traffic',
		}),
		check(
			'coverage',
			'Coverage miss',
			pct(coverage.net, total),
			total > 0 ? above(coverage.net / total, 0.33, 0.6) : 'na',
			{
				sub: coverage.netable ? `excl. ${fmtCount(coverage.absent)} origin 404s` : 'nothing cached under the key',
				go: 'traffic',
			}
		),
		check('staleness', 'Staleness', fmtRatio(staleness), above(staleness, 1, 1.5), {
			sub: 'median age ÷ cadence',
			go: 'traffic',
			detail:
				'Median served age divided by each route’s render interval. 1.0 means half the cache serves were past due.',
		}),
		check('5xx', '5xx to bots', fiveXX === null ? '—' : pctFine(fiveXX), above(fiveXX, 0.005, 0.02), {
			sub: `${num(serverErrors)} responses`,
			go: 'traffic',
		}),
		check('hit-latency', 'Cache-hit p95', fmtMs(hitP95), above(hitP95, 50, 500), {
			sub: `median ${fmtMs(weighted(hits, 'median'))}`,
			spark: weightedBuckets(hits, 'p95s', data.bucketCount),
			go: 'traffic',
			detail: 'A cache hit is single-digit milliseconds when healthy; a slow tail here is blob reads timing out.',
		}),
		check(
			'origin-fail',
			'Origin failures',
			failShare === null ? '—' : pctFine(failShare),
			above(failShare, 0.02, 0.1),
			{
				sub: `${num(fetchFailed)} of ${fmtCount(fetchTotal)} fetches`,
				go: 'traffic',
				detail: 'Origin fetches that came back 5xx or never connected.',
			}
		),
	];
}

/** Median served age ÷ each route's cadence — the Traffic view's Staleness tile, same arithmetic. */
function stalenessMedian(data, config) {
	const fallback = data.intervals?.defaultRenderInterval;
	if (!(Number.isFinite(fallback) && fallback > 0)) return null;
	const routed = pick(data, 'route_page_age');
	if (routed.length) {
		const cadences = cadenceIndex(config, fallback);
		return weighted(routed, 'median', (s) => cadenceFor(cadences, s.path, fallback).interval);
	}
	return weighted(pick(data, 'page_age'), 'median', () => fallback);
}

// ---- rendering -----------------------------------------------------------------------

function renderingChecks(data, overview) {
	const out = [];
	const backlog = overview?.backlog?.lastRun;
	const floor = overview?.claimFloor ?? {};
	const lease = overview?.intervals?.jobLeaseTime ?? 0;
	const inFlight = Number.isFinite(floor.occupancy) ? floor.occupancy : (backlog?.inFlight ?? null);

	if (data) {
		const outcomes = pick(data, 'render', (s) => s.path === OUTCOME);
		const total = sumCount(outcomes);
		const failed = sumCount(outcomes.filter((s) => s.method === 'failed' || s.method === 'auth-failure'));
		const hours = data.rangeMs / 3_600_000;
		const times = pick(data, 'render', (s) => s.path === 'time_ms');
		const claims = pick(data, 'queue_health', (s) => s.path === CLAIM_SCAN);
		const claimP95 = weighted(claims, 'p95');
		const granted = pick(data, 'queue_health', (s) => s.path === GRANTED);
		const fromReady = sumValues(granted.filter((s) => s.method === 'ready'));
		const grants = sumValues(granted);
		const stalled = total === 0 && backlog?.overdue > (inFlight ?? 0);

		out.push(
			check('renders', 'Renders / hour', fmtCount(total / hours), stalled ? 'bad' : total === 0 ? 'warn' : 'info', {
				sub: `${num(total)} results`,
				spark: bucketTotals(outcomes, data.bucketCount).map((c) => c * (3_600_000 / data.bucketMs)),
				go: 'queue',
				detail: stalled ? 'Rows are due and nothing posted a render result in this range.' : null,
			}),
			check('render-fail', 'Render failures', pct(failed, total), total > 0 ? above(failed / total, 0.1, 0.25) : 'na', {
				sub: `${num(failed)} failed or auth-failed`,
				go: 'queue',
			}),
			check('render-time', 'Render time', fmtMs(weighted(times, 'mean')), 'info', {
				sub: `mean · p95 ${fmtMs(weighted(times, 'p95'))}`,
				spark: weightedBuckets(times, 'means', data.bucketCount),
				go: 'queue',
			}),
			check('claim-scan', 'Claim scan p95', fmtMs(claimP95), above(claimP95, 250, 1000), {
				sub: `median ${fmtMs(weighted(claims, 'median'))}`,
				spark: weightedBuckets(claims, 'p95s', data.bucketCount),
				go: 'queue',
				detail: 'The leading indicator: the claim scan degrades before any backlog shows.',
			}),
			grants > 0 &&
				check(
					'prioritised',
					'Prioritised claims',
					pct(fromReady, grants),
					fromReady === 0 ? 'bad' : below(fromReady / grants, 0.5, 0.1),
					{
						sub: 'from the ready set',
						go: 'queue',
						detail:
							fromReady === 0 ? 'Every job came from the fallback index scan — nothing is being prioritised.' : null,
					}
				)
		);
	}

	if (overview) {
		const overdue = backlog && !backlog.error ? backlog.overdue : null;
		const outcomes = data ? pick(data, 'render', (s) => s.path === OUTCOME) : [];
		const rate = data ? sumCount(outcomes) / (data.rangeMs / 3_600_000) : null;
		// Judged by how long it takes to CLEAR, not by its size — see `drain` on the Queue view.
		const clear = drain(overdue, inFlight, rate);
		out.push(
			check(
				'due',
				'Backlog',
				Number.isFinite(overdue) ? num(overdue) + (backlog.truncated ? '+' : '') : '—',
				backlog?.error ? 'bad' : backlog?.truncated ? 'warn' : clear.verdict,
				{
					sub: Number.isFinite(clear.ms)
						? `~${duration(clear.ms)} to clear · ${num(inFlight ?? 0)} in flight`
						: `${Number.isFinite(inFlight) ? num(inFlight) : '—'} in flight`,
					go: 'queue',
					detail: backlog?.error
						? `The backlog snapshot failed: ${backlog.error}`
						: clear.verdict === 'bad' && !Number.isFinite(clear.ms)
							? 'Rows are due and nothing rendered in this range.'
							: Number.isFinite(clear.ms)
								? `At the current render rate the backlog clears in about ${duration(clear.ms)}.`
								: null,
				}
			),
			check(
				'floor',
				'Claim floor lag',
				floor.enabled === false ? 'off' : Number.isFinite(floor.lagMs) ? duration(floor.lagMs) : '—',
				floor.enabled === false || !Number.isFinite(floor.lagMs) || !lease
					? 'na'
					: above(floor.lagMs, 2 * lease, 6 * lease),
				{
					sub: floor.worstNode ? `worst: ${floor.worstNode}` : 'how far back claims start',
					go: 'queue',
					detail: 'Past two leases, one render is holding every row behind it.',
				}
			)
		);
	}
	return out.filter(Boolean);
}

// ---- cluster ---------------------------------------------------------------------------

function clusterChecks(overview, config, nodes, analytics) {
	const out = [];
	if (overview) {
		const list = overview.nodes ?? [];
		const down = list.filter((node) => node.responding === false);
		const paused = list.filter((node) => node.status === 'paused');
		const behind = list.filter((node) => node.behind?.length);
		const cluster = overview.control?.cluster;
		out.push(
			check(
				'responding',
				'Nodes responding',
				`${list.length - down.length}/${list.length}`,
				down.length ? 'bad' : list.length ? 'ok' : 'na',
				{
					sub: down.length
						? `down: ${down.map((n) => n.hostname).join(', ')}`
						: isMerged(overview)
							? 'all answered'
							: 'node scope',
					go: 'queue',
					detail: down.length ? `${down.map((n) => n.hostname).join(', ')} did not answer.` : null,
				}
			),
			check(
				'queue',
				'Queue',
				cluster?.paused ? 'paused' : paused.length ? `${paused.length} paused` : 'running',
				cluster?.paused || paused.length ? 'warn' : 'ok',
				{
					sub: paused.length
						? paused.map((n) => n.hostname).join(', ')
						: cluster?.updatedBy
							? `set by ${cluster.updatedBy}`
							: 'not paused',
					go: 'queue',
				}
			),
			check(
				'replication',
				'Replication',
				behind.length ? `${behind.length} behind` : 'converged',
				behind.length ? 'bad' : 'ok',
				{
					sub: behind.length
						? behind.map((n) => `${n.hostname} ${duration(n.spreadMs)}`).join(', ')
						: 'queue rows agree',
					go: 'queue',
					detail: behind.length
						? 'Peers hold an older copy of these nodes’ rows — their writes are not replicating.'
						: null,
				}
			)
		);
	}

	if (config) {
		const deploy = (config.divergences ?? []).filter((entry) => !entry.overridden).length;
		const restart = new Set((config.pendingRestart ?? []).map((entry) => entry.key)).size;
		const watchNodes = Array.isArray(config.overrides?.nodes)
			? config.overrides.nodes
			: config.overrides
				? [config.overrides]
				: [];
		const deaf = watchNodes.filter((n) => n.enabled === false || n.watch?.lastError || n.watch?.subscribed === false);
		out.push(
			check(
				'config',
				'Config agreement',
				config.configFrom ? (deploy ? `${deploy} differ` : 'identical') : '—',
				config.configFrom ? (deploy ? 'bad' : 'ok') : 'na',
				{
					sub: config.configFrom ? `${config.sources?.answered ?? '?'} nodes compared` : 'node scope',
					go: 'config',
					detail: deploy ? 'Options differ between nodes — a deploy did not reach every node.' : null,
				}
			),
			check(
				'restart',
				'Pending restart',
				restart ? `${restart} option${restart === 1 ? '' : 's'}` : 'none',
				restart ? 'warn' : 'ok',
				{
					sub: restart ? 'running the boot value' : 'config in force',
					go: 'config',
				}
			),
			check(
				'overrides',
				'Override watch',
				deaf.length ? `${deaf.length} not listening` : 'live',
				deaf.length ? 'bad' : 'ok',
				{
					sub: `${(config.overrides?.rows ?? []).length} stored overrides`,
					go: 'config',
					detail: deaf.length ? 'A node is not receiving config edits made from this console.' : null,
				}
			)
		);
	}

	// Version skew is the other deploy failure this page can see: a node still on the old plugin
	// serves traffic and answers every read.
	const versions = [...new Set(nodes.map((n) => n.host?.pluginVersion).filter(Boolean))];
	if (versions.length) {
		out.push(
			check(
				'versions',
				'Plugin version',
				versions.length === 1 ? versions[0] : `${versions.length} versions`,
				versions.length === 1 ? 'ok' : 'bad',
				{
					sub: versions.length === 1 ? 'on every node' : versions.join(' · '),
					go: 'queue',
					detail: versions.length > 1 ? 'Nodes run different plugin versions — a deploy skipped a node.' : null,
				}
			)
		);
	}
	if (analytics?.truncated) {
		out.push(
			check('scan-cap', 'Analytics coverage', 'truncated', 'warn', {
				sub: 'scan hit its row cap',
				go: 'traffic',
				detail: 'The analytics scan hit management.analytics.scanCap; totals cover only part of the range.',
			})
		);
	}
	return out;
}

// ---- system -------------------------------------------------------------------------------

/**
 * Every node's system picture, joined from the two sources that carry one: the overview's `host`
 * (point in time) and the analytics window's `system` series (per bucket). Keyed by the node's own
 * hostname, lowercased and port-stripped on both sides.
 */
function nodeVitals(overview, analytics) {
	const key = (value) =>
		String(value ?? '')
			.toLowerCase()
			.replace(/:\d+$/, '');
	const byKey = new Map();
	const entry = (name) => {
		const k = key(name);
		if (!k) return null;
		if (!byKey.has(k))
			byKey.set(k, {
				hostname: String(name).replace(/:\d+$/, ''),
				host: null,
				system: null,
				status: null,
				serves: null,
				renders: null,
			});
		return byKey.get(k);
	};

	for (const node of overview?.nodes ?? []) {
		const e = entry(node.hostname);
		if (e) Object.assign(e, { status: node.status, responding: node.responding, since: node.statusChangedTime });
	}
	const hosts = overview?.hosts ?? (overview?.host ? [{ node: overview.node, host: overview.host }] : []);
	for (const h of hosts) {
		const e = entry(h.host?.hostname ?? h.node ?? h.hostname);
		if (e) e.host = h.host;
	}

	const systemOf = (system, name) => {
		const list = system?.nodes ?? [];
		return list.find((n) => key(n.hostname) === key(name)) ?? (list.length === 1 ? list[0] : null);
	};
	if (analytics?.byNode) {
		for (const node of analytics.byNode) {
			const e = entry(node.node ?? node.hostname);
			if (!e) continue;
			e.system = systemOf(node.system, node.node ?? node.hostname);
			e.serves = (node.totals ?? []).filter((s) => s.metric === 'bot_serve').reduce((acc, s) => acc + s.count, 0);
			e.renders = (node.totals ?? [])
				.filter((s) => s.metric === 'render' && s.path === OUTCOME)
				.reduce((acc, s) => acc + s.count, 0);
			e.rangeMs = node.rangeMs ?? analytics.rangeMs;
			e.bucketMs = analytics.bucketMs;
		}
	} else if (analytics?.system) {
		for (const n of analytics.system.nodes ?? []) {
			const e = entry(n.hostname ?? analytics.node);
			if (e) Object.assign(e, { system: n, bucketMs: analytics.bucketMs });
		}
	}
	return [...byKey.values()].sort((a, b) => a.hostname.localeCompare(b.hostname));
}

const hasSystem = (nodes) => nodes.some((n) => n.host || n.system);

/** Said once, not as five n/a tiles, when the cluster runs a plugin without system vitals. */
const systemGap = (nodes) =>
	hasSystem(nodes) ? null : 'System vitals need plugin v0.92.0 or later on the prerender nodes.';

const cpuFraction = (n) => {
	const cpu = n.system?.latest?.cpu;
	const cores = n.host?.cpus;
	return Number.isFinite(cpu) && Number.isFinite(cores) && cores > 0 ? cpu / cores : null;
};
const memAvailable = (n) =>
	Number.isFinite(n.host?.availableMemory) && n.host?.totalMemory > 0
		? n.host.availableMemory / n.host.totalMemory
		: null;
const diskFree = (n) =>
	Number.isFinite(n.system?.latest?.diskAvailable) && n.system?.latest?.diskSize > 0
		? n.system.latest.diskAvailable / n.system.latest.diskSize
		: null;
const loopOf = (n) => n.system?.latest?.workerElu ?? n.system?.latest?.elu ?? null;
const lastOf = (series) => [...(series ?? [])].reverse().find((v) => Number.isFinite(v)) ?? null;
const faultsPerMin = (n, bucketMs) => {
	const last = lastOf(n.system?.majorFaults);
	return Number.isFinite(last) && bucketMs ? last / (bucketMs / 60_000) : null;
};

/** The worst node by `score` (higher = worse), with its value. */
function worst(nodes, value, { higherIsWorse = true } = {}) {
	let best = null;
	for (const n of nodes) {
		const v = value(n);
		if (!Number.isFinite(v)) continue;
		if (!best || (higherIsWorse ? v > best.v : v < best.v)) best = { n, v };
	}
	return best;
}

function systemChecks(nodes) {
	if (!hasSystem(nodes)) return [];
	const cpu = worst(nodes, cpuFraction);
	const mem = worst(nodes, memAvailable, { higherIsWorse: false });
	const disk = worst(nodes, diskFree, { higherIsWorse: false });
	// The WORKERS' loop is the serve path's, so it is the one that says a node is saturated; the main
	// thread's is the fallback for a payload without worker rows.
	const elu = worst(nodes, loopOf);
	const lag = worst(nodes, (n) => n.system?.latest?.taskQueueLatency);
	const swap = worst(nodes, (n) => faultsPerMin(n, n.bucketMs));
	const uptime = worst(nodes, (n) => n.host?.uptimeSec, { higherIsWorse: false });
	const of = (w) => (w && nodes.length > 1 ? `worst: ${w.n.hostname}` : w ? w.n.hostname : 'no data');

	return [
		check('cpu', 'CPU', cpu ? pct(cpu.v, 1) : '—', cpu ? above(cpu.v, 0.85, 0.95) : 'na', {
			sub: of(cpu),
			spark:
				cpu?.n.system?.cpu && cpu.n.host?.cpus
					? cpu.n.system.cpu.map((v) => (Number.isFinite(v) ? v / cpu.n.host.cpus : null))
					: null,
			sparkMax: 1,
			detail: 'Harper process CPU as a share of the node’s cores.',
		}),
		check('memory', 'Memory available', mem ? pct(mem.v, 1) : '—', mem ? below(mem.v, 0.15, 0.07) : 'na', {
			sub: mem ? `${of(mem)}${mem.n.host?.swapUsed > 0 ? ` · swap ${bytes(mem.n.host.swapUsed)}` : ''}` : 'no data',
			detail: 'MemAvailable ÷ total on the node. Compare troughs, not a single sample.',
		}),
		check('swap', 'Swap-in', swap ? `${fmtCount(swap.v)}/min` : '—', swap ? above(swap.v, 50, 500) : 'na', {
			sub: `major faults · ${of(swap)}`,
			spark: swap?.n.system?.majorFaults,
			detail: 'Major page faults per minute — pages read back from swap. Sustained, it is memory pressure.',
		}),
		check('loop', 'Event loop', elu ? pct(elu.v, 1) : '—', elu ? above(elu.v, 0.8, 0.95) : 'na', {
			sub: `${elu && Number.isFinite(elu.n.system?.latest?.workerElu) ? 'workers' : 'main thread'} busy · ${of(elu)}`,
			spark: elu && Number.isFinite(elu.n.system?.latest?.workerElu) ? elu.n.system.workerElu : elu?.n.system?.elu,
			sparkMax: 1,
			detail: 'Share of wall time the event loop was busy. Near 100% the node serves every request late.',
		}),
		check('task-latency', 'Task latency', lag ? fmtMs(lag.v) : '—', lag ? above(lag.v, 50, 250) : 'na', {
			sub: of(lag),
			spark: lag?.n.system?.taskQueueLatency,
			detail: 'How late the main thread runs a scheduled task.',
		}),
		check('disk', 'Disk free', disk ? pct(disk.v, 1) : '—', disk ? below(disk.v, 0.15, 0.08) : 'na', {
			sub: disk ? `${bytes(disk.n.system.latest.diskAvailable)} · ${of(disk)}` : 'no data',
		}),
		uptime &&
			check('uptime', 'Uptime', duration(uptime.v * 1000), uptime.v < 900 ? 'warn' : 'ok', {
				sub: nodes.length > 1 ? `shortest: ${uptime.n.hostname}` : uptime.n.hostname,
				detail: uptime.v < 900 ? `${uptime.n.hostname} restarted ${duration(uptime.v * 1000)} ago.` : null,
			}),
	].filter(Boolean);
}

// ---- maintenance ------------------------------------------------------------------------------

function maintenanceChecks(overview, invalidations) {
	const out = [];
	const lastRun = overview?.backlog?.lastRun;
	if (overview) {
		const below = lastRun?.belowFloor ?? 0;
		out.push(
			check('below-floor', 'Below claim floor', num(below), below > 0 ? 'bad' : lastRun ? 'ok' : 'na', {
				sub: below > 0 ? 'rows that will never be claimed' : 'no stranded rows',
				go: 'queue',
				detail: below > 0 ? `${num(below)} schedule rows sit below the claim floor and will never be claimed.` : null,
			})
		);
		const info = overview.reconcile ?? {};
		const last = info.lastRun;
		const overdue = last?.finishedAt && info.interval ? Date.now() - last.finishedAt > 3 * info.interval : false;
		out.push(
			check(
				'repair',
				'Schedule repair',
				!info.enabled ? 'disabled' : last ? ago(last.finishedAt) : 'not run',
				// Restoring a few rows is the sweep doing its job (a restart leaves half-written pairs), so
				// it is reported, not flagged. A truncated sweep, or one that stopped running, is.
				!info.enabled || last?.error ? 'bad' : last?.truncated || overdue ? 'warn' : last ? 'ok' : 'info',
				{
					sub: last?.error
						? 'last sweep failed'
						: last
							? `${num(last.restored ?? 0)} rows restored`
							: `every ${duration(info.interval ?? 0)}`,
					go: 'corpus',
					detail: !info.enabled
						? 'render.reconcile.enabled is false — a target that loses its schedule row stops rendering.'
						: last?.truncated
							? 'The last sweep hit its restore cap — more rows may be missing.'
							: overdue
								? `No sweep has finished in ${duration(Date.now() - last.finishedAt)}.`
								: null,
				}
			)
		);
	}
	if (invalidations) {
		const active = invalidations.invalidations ?? [];
		out.push(
			check('invalidations', 'Invalidations', active.length ? `${active.length} active` : 'none', 'info', {
				sub: active.length
					? `newest ${ago(Math.max(...active.map((i) => new Date(i.invalidatedAt).getTime())))}`
					: 'no active scopes',
				go: 'invalidations',
			})
		);
	}
	return out;
}

// ---- rendering the checks ---------------------------------------------------------------------

function banner(ctx, checks) {
	const flagged = checks
		.filter((c) => c.verdict === 'bad' || c.verdict === 'warn')
		.sort((a, b) => VERDICT_RANK[b.verdict] - VERDICT_RANK[a.verdict]);
	const judged = checks.filter((c) => c.verdict === 'ok' || c.verdict === 'warn' || c.verdict === 'bad').length;
	if (!flagged.length) {
		return el('div', { cls: 'health-banner ok' }, [
			el('span', { cls: 'dot' }),
			el('strong', { text: 'All clear' }),
			muted(` — ${judged} checks healthy`),
		]);
	}
	const bad = flagged.some((c) => c.verdict === 'bad');
	return el('div', { cls: `health-banner ${bad ? 'bad' : 'warn'}` }, [
		el('div', { cls: 'health-banner-head' }, [
			el('span', { cls: 'dot' }),
			el('strong', { text: `${flagged.length} ${flagged.length === 1 ? 'check needs' : 'checks need'} attention` }),
			muted(` · ${judged - flagged.length} healthy`),
		]),
		el(
			'ul',
			{ cls: 'health-list' },
			flagged.map((c) =>
				el('li', { cls: c.verdict }, [
					el('span', { cls: 'dot' }),
					el('span', { cls: 'hl-label', text: c.label }),
					el('span', { cls: 'hl-value mono', text: c.value }),
					el('span', { cls: 'hl-detail muted', text: c.detail ?? c.sub ?? '' }),
					c.go && el('button', { cls: 'link', text: 'open →', onclick: () => ctx.go(c.go) }),
				])
			)
		),
	]);
}

function groupCard(ctx, { title, checks, empty }) {
	if (!checks.length && !empty) return null;
	return el('section', { cls: 'vgroup' }, [
		el('h2', { cls: 'group', text: title }),
		checks.length
			? el(
					'div',
					{ cls: 'vitals' },
					checks.map((c) => vital(ctx, c))
				)
			: el('div', { cls: 'hint', text: empty }),
	]);
}

const SPARK_COLOR = {
	bad: 'var(--bad)',
	warn: 'var(--warn)',
	ok: 'var(--teal-400)',
	info: SERIES[0],
	na: 'var(--fg-4)',
};

function vital(ctx, c) {
	return el(
		c.go ? 'button' : 'div',
		{
			cls: `vital ${c.verdict}`,
			title: [c.detail, c.go ? `Open ${c.go}` : null].filter(Boolean).join(' — ') || null,
			onclick: c.go ? () => ctx.go(c.go) : null,
		},
		[
			el('div', { cls: 'vital-top' }, [
				el('span', { cls: 'dot' }),
				el('span', { cls: 'vital-label', text: c.label }),
				VERDICT_LABEL[c.verdict] && el('span', { cls: 'vital-verdict', text: VERDICT_LABEL[c.verdict] }),
			]),
			el('div', { cls: 'vital-value', text: c.value }),
			el('div', { cls: 'vital-sub', text: c.sub ?? '' }),
			Array.isArray(c.spark) && c.spark.some((v) => Number.isFinite(v))
				? spark(c.spark, { color: SPARK_COLOR[c.verdict], max: c.sparkMax })
				: el('div', { cls: 'spark-gap' }),
		]
	);
}

// ---- per-node table ---------------------------------------------------------------------------

function nodeTable(ctx, nodes) {
	if (!nodes.length) return null;
	const system = hasSystem(nodes);
	const totalServes = nodes.reduce((acc, n) => acc + (n.serves ?? 0), 0);
	const cell = (text, verdict = null, extra = {}) =>
		el('td', {
			cls: `right mono${verdict && verdict !== 'ok' && verdict !== 'na' ? ` v-${verdict}` : ''}`,
			text,
			...extra,
		});

	const rows = nodes.map((n) => {
		const cpu = cpuFraction(n);
		const mem = memAvailable(n);
		const disk = diskFree(n);
		const elu = loopOf(n);
		const hours = (n.rangeMs ?? 0) / 3_600_000;
		return el('tr', null, [
			el('td', { cls: 'mono' }, [n.hostname]),
			el('td', null, [
				n.responding === false
					? pill('down', 'bad')
					: n.status
						? pill(n.status, n.status === 'paused' ? 'bad' : n.status === 'queued' ? 'ok' : '')
						: muted('—'),
			]),
			cell(n.host?.uptimeSec ? duration(n.host.uptimeSec * 1000) : '—', n.host?.uptimeSec < 900 ? 'warn' : null),
			system &&
				cell(cpu === null ? '—' : pct(cpu, 1), above(cpu, 0.85, 0.95), {
					title: n.host?.cpus ? `${n.host.cpus} cores` : null,
				}),
			system &&
				el('td', { cls: 'spark-cell' }, [
					n.system?.cpu && n.host?.cpus
						? spark(
								n.system.cpu.map((v) => (Number.isFinite(v) ? v / n.host.cpus : null)),
								{ max: 1, color: SERIES[0], height: 18 }
							)
						: null,
				]),
			system &&
				cell(mem === null ? '—' : pct(mem, 1), below(mem, 0.15, 0.07), {
					title: n.host?.totalMemory
						? `${bytes(n.host.availableMemory)} of ${bytes(n.host.totalMemory)} available`
						: null,
				}),
			system && cell(Number.isFinite(n.system?.latest?.rss) ? bytes(n.system.latest.rss) : '—'),
			system && cell(Number.isFinite(elu) ? pct(elu, 1) : '—', above(elu, 0.8, 0.95)),
			system && cell(disk === null ? '—' : pct(disk, 1), below(disk, 0.15, 0.08)),
			cell(n.serves === null ? '—' : pct(n.serves, totalServes)),
			cell(n.renders === null || !hours ? '—' : `${fmtCount(n.renders / hours)}/h`),
			el('td', { cls: 'mono muted', text: n.host?.pluginVersion ?? '—' }),
		]);
	});

	return card('Nodes', {
		head: [spacer(), el('button', { cls: 'link', text: 'queue controls →', onclick: () => ctx.go('queue') })],
		help:
			'One row per node. CPU is the Harper process against the node’s cores; memory is MemAvailable ÷ total; RSS is ' +
			'the Harper process; loop is worker event-loop utilization; disk is free space on the database volume. ' +
			'Serves and renders are each node’s share over the selected range.',
		cls: 'flush',
		body: [
			table(
				[
					'node',
					'status',
					{ text: 'uptime', right: true },
					system && { text: 'cpu', right: true },
					system && '',
					system && { text: 'mem avail', right: true },
					system && { text: 'rss', right: true },
					system && { text: 'loop', right: true },
					system && { text: 'disk free', right: true },
					{ text: 'serves', right: true },
					{ text: 'renders', right: true },
					'plugin',
				].filter((h) => h !== false),
				rows
			),
		],
	});
}

// ---- formatting ------------------------------------------------------------------------------

/** A share that stays readable below 1% — 5xx and origin failures live down there. */
const pctFine = (v) =>
	!Number.isFinite(v)
		? '—'
		: v === 0
			? '0%'
			: v < 0.001
				? '<0.1%'
				: v < 0.1
					? `${(v * 100).toFixed(1)}%`
					: `${Math.round(v * 100)}%`;

const bytes = (b) => {
	if (!Number.isFinite(b)) return '—';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let v = b;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)}${units[i]}`;
};

function coveredMinutes(data) {
	const from = data.coveredFromMs ?? data.startMs;
	const to = data.coveredToMs ?? data.endMs;
	return Number.isFinite(from) && Number.isFinite(to) && to > from ? (to - from) / 60_000 : null;
}
