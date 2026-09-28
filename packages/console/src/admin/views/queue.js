/**
 * Queue: is the render machinery keeping up, and is every node pulling its weight?
 *
 * One page for the supply side: the cluster pause, the backlog (due now, in flight, how late), the
 * queue keeper on every node, the nodes doing the claiming (status, intent, throughput), what their
 * renders produced, and the options that shape all of it.
 *
 * THE QUEUE IS THE KEEPER (plugin v0.93.0). Worker 0 on each node holds every schedule row that node
 * owns in memory and publishes the ready set claims are served from; `GET /prerender_admin/queue-state`
 * is its state, exact and seconds old, and node-local. A node whose keeper cannot vouch for its numbers
 * answers 503 with the reason — which this page shows as that node's state, never as a missing number.
 *
 * THREE CLOCKS, KEPT APART. Queue state is each keeper's document (seconds old); the backlog snapshot is
 * computed on a background cadence (minutes old) and is only the fallback when a keeper cannot vouch;
 * leases are read at request time; the charts are a bucketed window over the shared time range. Every
 * tile says which it read, and nothing subtracts one clock from another.
 *
 * THE PAUSE WORDING IS LOAD-BEARING. `QueueControl` is replicated INTENT; `QueueStatus` is what each
 * node last OBSERVED. A control write converges within one statusSyncInterval, so the two are
 * separate columns, or operators conclude a pause failed and click it repeatedly.
 */

import { ago, card, duration, el, ICONS, muted, num, pct, pill, section, spacer, stat, stats, table } from '../ui.js';
import {
	barList,
	colorFor,
	emptyNote,
	fmtCount,
	fmtMs,
	fmtRatio,
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
import { appliedNote, configState, editTray, loadConfig, optionIndex, settingsCard } from './_configEdit.js';

export const meta = { id: 'queue', label: 'Queue', icon: ICONS.queue, ranged: true };

// Series names as constants: the route-contract scanner in adminAssets.test.js reads a quoted name
// inside a lookup or comparison as a fetch of an admin route.
const OUTCOME = 'outcome';

/**
 * The `queue_health` series this console reads, in ONE place. The metric guard in adminAssets.test.js
 * checks every name here against the plugin's catalog, so a read of a series the plugin no longer emits
 * fails CI instead of drawing an empty tile — v0.93.0 removed seven, and every one of them was read
 * here — and checks every catalog series against this list or a written waiver.
 */
export const QUEUE_HEALTH = Object.freeze({
	granted: 'claim_granted',
	stale: 'claim_stale',
	wedged: 'claim_wedged',
	keeperLive: 'keeper_live',
	loadMs: 'keeper_load_ms',
	publishMs: 'keeper_publish_ms',
	verifyMs: 'keeper_verify_ms',
	repaired: 'keeper_repaired',
});

/** One `queue_health` series from an analytics window. */
export const queueSeries = (data, name) => pick(data, 'queue_health', (s) => s.path === name);

/**
 * Thresholds shared with the Health view, so the two pages cannot disagree. Each is `[watch, bad]`.
 *
 * - publishMs: one ready-set publish on worker 0, every second. Single-digit ms is normal (the top-K is
 *   a merge over class heads); 250ms is a quarter of worker 0's time spent publishing.
 * - staleShare: ready-set entries a claim skipped because the row was no longer due, over everything it
 *   looked at. A trickle is normal; half means the keeper sees writes late.
 * - wedgedShare: holds (a key held back because its leases kept expiring with no result) over jobs
 *   granted. Any is a URL to look at; past 5% it is results not reaching the node, not one bad page.
 * - slotShare: the fullest node's live leases over its lease slots. A full table refuses grants.
 * - behindShare: due rows at least one cadence late (the page is two cadences old) over all due rows —
 *   judged only past `behindMinRows` late rows, so a quiet cluster whose handful of due rows includes a
 *   few held keys does not read as a third of the corpus falling behind.
 * - changedWaitMs: how long the longest-waiting CHANGED page (plugin v0.94.0) has been due. The probe
 *   hard-expired it, so bots get the origin for all of that time. The same bounds as the backlog's time to
 *   clear: changed rows are ranked ahead of routine ones, so past 2h the fleet is not reaching them.
 */
export const LIMITS = Object.freeze({
	publishMs: [50, 250],
	staleShare: [0.1, 0.5],
	wedgedShare: 0.05,
	slotShare: [0.75, 0.95],
	behindShare: [0.1, 0.33],
	behindMinRows: 100,
	changedWaitMs: [2 * 3_600_000, 8 * 3_600_000],
});

const VERDICT_RANK = { na: 0, ok: 1, warn: 2, bad: 3 };
const worseVerdict = (a, b) => ((VERDICT_RANK[a] ?? 0) >= (VERDICT_RANK[b] ?? 0) ? a : b);

const verdictAbove = (value, [warn, bad]) =>
	!Number.isFinite(value) ? 'na' : value >= bad ? 'bad' : value >= warn ? 'warn' : 'ok';

export async function load(ctx) {
	const [res, analyticsRes, stateRes] = await Promise.all([
		ctx.get('overview'),
		ctx.get('analytics', { range: ctx.rangeMs }),
		ctx.get('queue-state'),
		// The settings below render from this, through the shared config scratch.
		loadConfig(ctx),
	]);
	ctx.data.overview = res.ok ? res.body : null;
	ctx.data.analytics = analyticsRes.ok ? analyticsRes.body : null;
	ctx.data.queueState = queueStateOf(stateRes);
	ctx.data.queueStateError = ctx.data.queueState ? null : queueStateProblem(stateRes);
	ctx.data.error = res.ok ? null : (res.body?.error ?? `Could not load the cluster overview (${res.status})`);
}

export function render(ctx) {
	const data = ctx.data.overview;
	const analytics = ctx.data.analytics;
	const usable = analytics && analytics.available !== false && !windowEmpty(analytics);
	const qs = ctx.data.queueState;
	// Without the overview there are no controls, node table or snapshot — but the keepers answered on
	// their own route, and whether they are serving is exactly what an operator opens this page for.
	if (!data) {
		return [
			el('div', { cls: 'note bad', text: ctx.data.error ?? 'Could not load the cluster overview.' }),
			keeperAlarm(qs),
			kpis(null, qs, usable ? analytics : null),
			keeperCard(ctx, qs, usable ? analytics : null, null),
			qs?.cluster && el('div', { cls: 'cols' }, [latenessCard(qs), flowCard(qs)]),
		];
	}

	return [
		appliedNote(ctx),
		controlBar(ctx, data),
		keeperAlarm(qs),
		usable && legacyRenderers(analytics),
		kpis(data, qs, usable ? analytics : null),
		keeperCard(ctx, qs, usable ? analytics : null, data),
		qs?.cluster && el('div', { cls: 'cols' }, [latenessCard(qs), flowCard(qs)]),
		nodeTable(ctx, data, analytics),
		usable
			? el('div', { cls: 'cols' }, [outcomesCard(analytics), rendersByNode(analytics) ?? timesCard(analytics)])
			: card('Renders', { body: [emptyNote('render', analytics)] }),
		usable &&
			nodeEntries(analytics).length > 0 &&
			el('div', { cls: 'cols' }, [timesCard(analytics), detailCard(analytics)]),
		usable && nodeEntries(analytics).length === 0 && detailCard(analytics),
		upcoming(ctx, data, qs),
		usable && el('div', { cls: 'scan-foot' }, [scanFooter(analytics)]),
		settings(ctx),
		editTray(ctx),
	];
}

// ---- queue state ---------------------------------------------------------------

/** A plugin before v0.93.0 answers the route with this 404 ("Management API is disabled" is a 404 too). */
const NO_ROUTE = /^Unknown route/;

/** A row's node name for display; node scope's 404 carries none. */
export const hostOf = (row) => row?.hostname ?? 'this node';

/**
 * The queue-state answer in one shape under either scope.
 *
 * Cluster scope arrives merged (util/aggregate.js `mergeQueueState`). Node scope is the plugin's own
 * answer passed straight through — a 200, or a 503 whose body is still an answer: the keeper's reason,
 * its stats and the live `now` fields. A plugin before v0.93.0 answers 404 "Unknown route", which is a
 * node WITHOUT A KEEPER, judged the same at either scope. Null only when there is no answer at all.
 */
export function queueStateOf(res) {
	const body = res?.body;
	if (!body || typeof body !== 'object') return null;
	if (Array.isArray(body.nodes) && 'cluster' in body) return body;
	if (res.status === 404 && NO_ROUTE.test(body.error ?? '')) {
		const row = {
			hostname: null,
			node: null,
			httpStatus: 404,
			answered: false,
			noKeeper: true,
			live: false,
			error: body.error,
			now: null,
			coming: null,
			lateness: null,
			trust: null,
		};
		return {
			scope: 'node',
			generatedAt: null,
			live: 0,
			configured: 1,
			cluster: null,
			withheld: [{ hostname: null, reason: body.error }],
			nodes: [row],
		};
	}
	if (!body.trust || typeof body.trust !== 'object') return null;
	const live = !!res.ok && body.trust.live !== false;
	const row = {
		hostname: body.node ?? null,
		node: body.node ?? null,
		httpStatus: res.status,
		answered: true,
		live,
		error: live ? null : (body.error ?? `answered ${res.status}`),
		now: body.now ?? null,
		coming: live ? (body.coming ?? null) : null,
		lateness: live ? (body.lateness ?? null) : null,
		trust: body.trust,
	};
	return {
		scope: 'node',
		generatedAt: body.trust.stateAt ?? null,
		live: live ? 1 : 0,
		configured: 1,
		cluster: live
			? {
					now: body.now ?? null,
					coming: body.coming ?? null,
					lateness: body.lateness ?? null,
					flow: body.flow ?? [],
					exact: body.trust.exact === true,
				}
			: null,
		withheld: live ? [] : [{ hostname: row.hostname, reason: row.error }],
		nodes: [row],
	};
}

/** Why there is no queue state at all, naming what each node said. */
export function queueStateProblem(res) {
	const said = (res?.body?.sources?.nodes ?? [])
		.filter((node) => !node.ok)
		.map((node) => `${node.hostname} (${node.error ?? `HTTP ${node.status}`})`);
	const head = res?.body?.error ?? `Could not load queue state (${res?.status ?? 0}).`;
	return said.length ? `${head} ${said.join(', ')}.` : head;
}

const MEMBERSHIP = /node list changed/;

/**
 * Rows this node's last verification walk counted as REPAIRED because a membership change handed it
 * new rows to own — or 0.
 *
 * The plugin's walk cannot tell a row it gained from a row it missed: both are held nowhere and present
 * in the table, so both count as `missing`, raise `keeper_repaired` and turn `exact` false until the
 * next clean walk. After a node-list change that is the keeper doing its job. Its resync records the
 * walk it ran (`lastResync`: `why`, `at`, `ms`, `repaired`), so a last walk whose repairs equal that
 * resync's, and which ran inside it, is a gain, not a missed write.
 */
export function membershipGain(keeper) {
	const resync = keeper?.lastResync;
	const walk = keeper?.verify;
	if (!resync || !MEMBERSHIP.test(resync.why ?? '') || !(resync.repaired > 0)) return 0;
	if (!walk || walk.repaired !== resync.repaired) return 0;
	// The resync's own walk began after the resync and ended before it was recorded.
	const within = walk.at <= resync.at && resync.at - walk.at <= (resync.ms ?? 0) + 1000;
	return within ? resync.repaired : 0;
}

/**
 * Whether a live node's counts are complete. The plugin's `exact` also goes false for rows gained in a
 * membership change (see `membershipGain`); those counts ARE complete, and are not marked a lower bound.
 */
export function countsExact(row) {
	if (!row?.live) return false;
	if (row.trust?.exact === true) return true;
	const keeper = row.trust?.keeper;
	return !!keeper && !keeper.partialLoad && !keeper.resyncing && membershipGain(keeper) > 0;
}

/** The live nodes whose counts are a lower bound. */
export const inexactNodes = (qs) => (qs?.nodes ?? []).filter((row) => row.live && !countsExact(row)).map(hostOf);

const inexactReason = (keeper) =>
	keeper?.partialLoad
		? `Part of the table could not be read past an unreadable row (${keeper.partialLoad}); counts are a lower bound.`
		: keeper?.verify?.repaired > 0
			? `The last verification repaired ${num(keeper.verify.repaired)} row(s): the keeper had missed writes.`
			: keeper?.resyncing
				? 'Resyncing after a membership or config change; counts settle when it finishes.'
				: 'The keeper does not vouch that its counts are exact.';

/**
 * One node's queue keeper, judged: `{ verdict, label, detail }`.
 *
 * PHASE FIRST, STATUS SECOND. `now.status` is the node-local status flag, and before the keeper has
 * reported anything it reads `empty` — its zero value — so a node in `starting` says "empty" while it
 * grants nothing. The phase is the keeper's own word for what it is doing.
 *
 *   live, exact (or rows gained)    ok
 *   live, not exact                 watch: counts are a lower bound
 *   loading, still granting         watch: claims come from a partial queue until the load ends
 *   state stale, still granting     watch: worker 0 has gone quiet; its last set is granted until it drains
 *   anything else, or `unready`     bad: starting, waiting for peers, failed, stopped — no claims here
 *   no keeper (plugin < 0.93.0)     watch: nothing to judge, and its queue is not counted — it still
 *                                   claims from its own index (a canary rollout runs mixed versions)
 *   no answer                       bad
 */
export function keeperVerdict(row) {
	if (!row?.answered) {
		return row?.noKeeper
			? {
					verdict: 'warn',
					label: 'no keeper',
					detail:
						'Runs a plugin before v0.93.0: it has no queue keeper, so its queue is not counted here. ' +
						'It still claims from its own index.',
				}
			: { verdict: 'bad', label: 'no answer', detail: row?.error ?? 'Did not answer.' };
	}
	const keeper = row.trust?.keeper;
	if (row.live) {
		if (row.trust.exact === true) return { verdict: 'ok', label: 'live', detail: null };
		if (countsExact(row)) {
			return {
				verdict: 'ok',
				label: 'live',
				detail: `${num(membershipGain(keeper))} rows gained after a membership change.`,
			};
		}
		return { verdict: 'warn', label: 'inexact', detail: inexactReason(keeper) };
	}
	const phase = row.trust?.phase ?? 'unknown';
	const unready = row.now?.status === 'unready';
	if (phase === 'loading' && !unready) {
		return {
			verdict: 'warn',
			label: 'loading',
			detail: 'Loading; claims come from a partial queue until it finishes.',
		};
	}
	if (phase === 'live' && !unready) {
		return {
			verdict: 'warn',
			label: 'stale',
			detail: `${row.error ?? 'Its state is stale'}; claims are still granted from its last set until that drains.`,
		};
	}
	return {
		verdict: 'bad',
		label: unready && (phase === 'live' || phase === 'loading') ? 'unready' : phase,
		detail:
			`${row.error ?? `The queue keeper is ${phase}`}; this node grants no claims` +
			(keeper?.lastError ? ` (${keeper.lastError}).` : '.'),
	};
}

/** Due rows at least one cadence late, from lateness bins. Null without bins or a `1` edge. */
export function behind(lateness) {
	const edges = lateness?.edges;
	const cut = Array.isArray(edges) ? edges.indexOf(1) : -1;
	if (cut < 0) return null;
	let late = 0;
	let all = 0;
	for (const key of ['sitemap', 'discovered']) {
		const bins = lateness[key];
		if (!Array.isArray(bins)) return null;
		bins.forEach((n, i) => {
			const v = Number.isFinite(n) ? n : 0;
			all += v;
			if (i > cut) late += v;
		});
	}
	return { late, all, share: all > 0 ? late / all : null };
}

/** The Behind verdict: a share, judged only past a minimum number of late rows. */
export const behindVerdict = (late) =>
	!late || late.share === null
		? 'na'
		: late.late < LIMITS.behindMinRows
			? 'ok'
			: verdictAbove(late.share, LIMITS.behindShare);

/**
 * In flight, from the best source there is. The overview's lease walk is exact — but its sum is short
 * when a node answered without the block (a plugin before v0.93.0, mid-rollout), and then the keepers'
 * own sum, which covers every node, wins. Failing both, the short sum is marked (`shortOf`), never passed
 * off as the whole.
 */
function inFlightOf(overview, cluster, snapshot) {
	const leases = overview?.leases;
	const missing = Array.isArray(leases?.missing) ? leases.missing : [];
	if (Number.isFinite(leases?.occupancy) && !missing.length)
		return { value: leases.occupancy, live: true, shortOf: [] };
	if (Number.isFinite(cluster?.now?.inFlight)) return { value: cluster.now.inFlight, live: true, shortOf: [] };
	if (Number.isFinite(leases?.occupancy)) return { value: leases.occupancy, live: true, shortOf: missing };
	if (Number.isFinite(snapshot?.inFlight))
		return { value: snapshot.inFlight, live: false, shortOf: snapshot.missing ?? [] };
	return { value: null, live: false, shortOf: [] };
}

/**
 * Rows waiting beyond in-flight, PER NODE and summed: `Σ max(0, due − leases)`. Σdue − Σleases would let a
 * node with more leases than due rows cancel another node's waiting rows. Leases come from the exact walk
 * where the overview has the node, else from that node's own queue-state.
 */
function waitingOf(overview, liveRows, cluster) {
	let total = 0;
	for (const row of liveRows) {
		const due = row.now?.due;
		if (!Number.isFinite(due)) return Number.isFinite(cluster?.now?.unclaimed) ? cluster.now.unclaimed : null;
		const leased = exactLeases(overview, row.hostname) ?? row.now?.inFlight;
		total += Math.max(0, due - (Number.isFinite(leased) ? leased : 0));
	}
	return total;
}

/**
 * "Due now", "in flight" and the rows waiting, from the best source there is: the keepers' cluster total
 * when every node is live (exact, seconds old), else the backlog snapshot (minutes old). Shared with the
 * Health view so the two pages cannot disagree.
 *
 * `floor` marks a count that is a lower bound: an inexact keeper, a snapshot that hit unreadable rows, or
 * a snapshot with nodes it had no queue from. `keeperDown` marks a snapshot with no count BECAUSE a
 * keeper was not live — that fault is the keeper check's, and the backlog is unknown, not failed.
 */
export function backlogReading(overview, queueState) {
	const snapshot = overview?.backlog?.lastRun ?? null;
	const cluster = queueState?.cluster;
	const flight = inFlightOf(overview, cluster, snapshot);
	const base = { inFlight: flight.value, inFlightLive: flight.live, inFlightShortOf: flight.shortOf };
	if (cluster && Number.isFinite(cluster.now?.due)) {
		const liveRows = (queueState.nodes ?? []).filter((row) => row.live);
		return {
			...base,
			overdue: cluster.now.due,
			waiting: waitingOf(overview, liveRows, cluster),
			source: 'keeper',
			asOf: queueState.generatedAt ?? null,
			floor: !liveRows.every(countsExact),
			error: null,
			keeperDown: false,
			shortOf: [],
		};
	}
	if (!snapshot) {
		return {
			...base,
			overdue: null,
			waiting: null,
			source: null,
			asOf: null,
			floor: false,
			error: null,
			keeperDown: false,
			shortOf: [],
		};
	}
	const shortOf = [...(snapshot.missing ?? []), ...(snapshot.unavailable ?? [])];
	const overdue = !snapshot.error && Number.isFinite(snapshot.overdue) ? snapshot.overdue : null;
	return {
		...base,
		overdue,
		waiting: null,
		source: 'snapshot',
		asOf: snapshot.finishedAt ?? null,
		floor: !!snapshot.truncated || shortOf.length > 0,
		error: snapshot.error ?? null,
		keeperDown:
			!snapshot.error && overdue === null && (!!snapshot.queueUnavailable || (snapshot.unavailable?.length ?? 0) > 0),
		shortOf,
	};
}

/**
 * Changed pages waiting: due rows the change probe filed (plugin v0.94.0 `now.dueChanged`). The probe
 * hard-expired each one — its content is known changed — so until it re-renders, bots are served the
 * origin. Shared with the Health view so the two pages cannot disagree.
 *
 * TWO JUDGEMENTS, THE WORSE WINS. The ACTUAL wait of the longest-waiting changed page (`now.oldestChangedAt`,
 * its due minute; `LIMITS.changedWaitMs`) says how long bots have already been getting the origin for it.
 * The count ÷ the render rate (the backlog's 2h / 8h) says how long the rest will take — changed rows are
 * ranked `queue.ready.changedHeadStart` cadences ahead, so the render rate reaches them first. Each alone
 * misses a case: a small, old head reads fine by count, and a fresh wave reads fine by age.
 *
 * `reported` is false when no live node reports the count (an older plugin everywhere): hide it, never
 * show a 0. `count` is null when the cluster total is unknown — a keeper not live, or `missing` names the
 * live nodes that do not report it (a mixed rollout) — never a partial sum. The oldest wait is judged only
 * when the cluster reports it (every node on a plugin that sends it); `null` there means nothing is due.
 */
export function changedReading(queueState, rendersPerHour, now = Date.now()) {
	const liveRows = (queueState?.nodes ?? []).filter((row) => row.live);
	const reporting = liveRows.filter((row) => Number.isFinite(row.now?.dueChanged));
	const reported = reporting.length > 0;
	const clusterNow = queueState?.cluster?.now;
	const count = Number.isFinite(clusterNow?.dueChanged) ? clusterNow.dueChanged : null;
	const missing = reported ? liveRows.filter((row) => !Number.isFinite(row.now?.dueChanged)).map(hostOf) : [];
	const clear = count === null ? { ms: null, verdict: 'na' } : drainWaiting(count, rendersPerHour);
	const oldestReported = count !== null && !!clusterNow && 'oldestChangedAt' in clusterNow;
	const oldestAt = oldestReported && Number.isFinite(clusterNow.oldestChangedAt) ? clusterNow.oldestChangedAt : null;
	const waitMs = oldestAt === null ? null : Math.max(0, now - oldestAt);
	const waitVerdict = !oldestReported ? 'na' : waitMs === null ? 'ok' : verdictAbove(waitMs, LIMITS.changedWaitMs);
	return {
		reported,
		count,
		floor: count !== null && !liveRows.every(countsExact),
		missing,
		ms: clear.ms,
		clearVerdict: clear.verdict,
		oldestAt,
		waitMs,
		waitVerdict,
		verdict: worseVerdict(waitVerdict, clear.verdict),
	};
}

/** A changed-pages reading's one-line sub, for the Queue tile and the Health check. */
export function changedSub(r) {
	if (r.count === null) return r.missing.length ? `not reported by ${r.missing.join(', ')}` : 'needs every keeper live';
	if (r.count === 0) return 'none waiting';
	const parts = [
		r.waitMs !== null ? `oldest ${duration(r.waitMs)}` : null,
		Number.isFinite(r.ms) ? `~${duration(r.ms)} to re-render` : null,
	].filter(Boolean);
	return parts.length ? parts.join(' · ') : 'served from origin';
}

/** The fullest node's lease slots in use, `{ share, node }`, or null. */
export function slotPressure(overview) {
	const leases = overview?.leases;
	if (!leases) return null;
	if (Number.isFinite(leases.fullestShare)) return { share: leases.fullestShare, node: leases.fullestNode ?? null };
	return leases.maxLeases > 0 && Number.isFinite(leases.occupancy)
		? { share: leases.occupancy / leases.maxLeases, node: null }
		: null;
}

/**
 * The keeper's analytics over the range, judged. Every figure is a SUM OF VALUES where the series
 * records a count per emit (`claim_granted` is jobs per claim, `claim_wedged` holds per claim), never a
 * count of emits.
 */
export function keeperStats(data) {
	if (!data) return null;
	const series = (name) => queueSeries(data, name);
	const granted = sumValues(series(QUEUE_HEALTH.granted));
	const stale = sumValues(series(QUEUE_HEALTH.stale));
	// HOLDS, not keys: a key still failing when its hold ends is held again and counted again.
	const holds = sumValues(series(QUEUE_HEALTH.wedged));
	const publish = series(QUEUE_HEALTH.publishMs);
	const verify = series(QUEUE_HEALTH.verifyMs);
	const liveGauge = series(QUEUE_HEALTH.keeperLive);
	const looked = granted + stale;
	const staleShare = looked > 0 ? stale / looked : null;
	const publishP95 = weighted(publish, 'p95');
	const loads = sumCount(series(QUEUE_HEALTH.loadMs));
	const snapshots = sumCount(liveGauge);
	// The backlog snapshot's 1/0 gauge, once per snapshot per node: the zeros are snapshots that found a
	// keeper not live. A mean merges exactly, so samples × (1 − mean) counts them across nodes.
	const notLiveSnapshots = snapshots > 0 ? Math.round(snapshots * (1 - (weighted(liveGauge, 'mean') ?? 1))) : 0;
	return {
		granted,
		stale,
		staleShare,
		staleVerdict: looked > 0 ? verdictAbove(staleShare, LIMITS.staleShare) : 'na',
		holds,
		holdsVerdict:
			holds > 0 ? (granted > 0 && holds / granted >= LIMITS.wedgedShare ? 'bad' : 'warn') : granted > 0 ? 'ok' : 'na',
		verifyWalks: sumCount(verify),
		verifyMean: weighted(verify, 'mean'),
		publishP95,
		publishMedian: weighted(publish, 'median'),
		publishVerdict: verdictAbove(publishP95, LIMITS.publishMs),
		publishSpark: weightedBuckets(publish, 'p95s', data.bucketCount),
		// Once per keeper load: a load in the range is a restart (or a failed load retried).
		loads,
		loadP95: weighted(series(QUEUE_HEALTH.loadMs), 'p95'),
		snapshots,
		notLiveSnapshots,
		// A restart is one load, and the snapshot that lands in its load window (or the peer wait) reads the
		// keeper not live. Up to one such snapshot per load is the restart, not a fault.
		unexplainedNotLive: Math.max(0, notLiveSnapshots - loads),
	};
}

/**
 * Keeper repairs over the range, for BOTH views — one reading so they cannot disagree.
 *
 * Two sources: the range's `keeper_repaired` sum, and each node's last verification walk (queue-state),
 * which also covers a range too short to hold an hourly walk. Rows gained in a membership change are
 * counted apart (`gained`, a watch): the walk reports them as repairs, but nothing was missed (see
 * `membershipGain`). `missed` is what is left, and any is bad.
 */
export function repairsReading(data, qs) {
	const inRange = data ? sumValues(queueSeries(data, QUEUE_HEALTH.repaired)) : 0;
	const walksInRange = data ? sumCount(queueSeries(data, QUEUE_HEALTH.verifyMs)) : 0;
	const since = Number.isFinite(data?.startMs) ? data.startMs : null;
	const keepers = (qs?.nodes ?? []).filter((row) => row.answered).map((row) => row.trust?.keeper ?? null);
	const walked = keepers.filter((keeper) => keeper?.verify);
	const lastRepaired = walked.reduce((acc, keeper) => acc + Math.max(0, keeper.verify.repaired ?? 0), 0);
	const lastGained = walked.reduce((acc, keeper) => acc + membershipGain(keeper), 0);
	// A membership resync inside the range explains that much of the range's sum.
	const rangeGained = keepers.reduce((acc, keeper) => {
		const resync = keeper?.lastResync;
		const inWindow = since === null || (Number.isFinite(resync?.at) && resync.at >= since);
		return resync && MEMBERSHIP.test(resync.why ?? '') && resync.repaired > 0 && inWindow ? acc + resync.repaired : acc;
	}, 0);
	const gainedRange = Math.min(inRange, rangeGained);
	const gainedLast = Math.min(lastRepaired, lastGained);
	const missed = Math.max(inRange - gainedRange, lastRepaired - gainedLast);
	const gained = Math.max(gainedRange, gainedLast);
	const evidence = walksInRange > 0 || walked.length > 0;
	return {
		total: Math.max(inRange, lastRepaired),
		missed,
		gained,
		walksInRange,
		nodesWalked: walked.length,
		nodes: keepers.length,
		verdict: missed > 0 ? 'bad' : gained > 0 ? 'warn' : evidence ? 'ok' : 'na',
	};
}

/** What the repairs reading says, in one line, for a tile's sub or a check's. */
export function repairsSub(r) {
	const coverage =
		r.walksInRange > 0
			? `${num(r.walksInRange)} verify walk${r.walksInRange === 1 ? '' : 's'}`
			: r.nodesWalked > 0
				? 'no walk in range'
				: 'no verify walk yet';
	const nodes = r.nodes > 0 ? ` · last walk on ${r.nodesWalked}/${r.nodes} nodes` : '';
	return r.gained > 0 && r.missed === 0
		? `${num(r.gained)} rows gained after a membership change`
		: `${coverage}${nodes} · expect 0`;
}

/**
 * A node's live lease count from the overview's EXACT slot walk, or null. Preferred over queue-state's
 * `now.inFlight`, which before plugin v0.93.1 was the lease table's O(1) gauge: it counted a lease that
 * expired without a result until the next reconcile (measured 410 against an exact 290).
 */
function exactLeases(overview, hostname) {
	const leases = overview?.leases;
	if (!leases) return null;
	if (!Array.isArray(leases.byNode)) return Number.isFinite(leases.occupancy) ? leases.occupancy : null;
	const key = String(hostname ?? '').toLowerCase();
	const row = leases.byNode.find((entry) => String(entry.hostname ?? '').toLowerCase() === key);
	return Number.isFinite(row?.occupancy) ? row.occupancy : null;
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
 * THE ALARM AT THE TOP: a node whose keeper cannot serve grants no claims, and every other number on
 * this page would only show it as a slow decline in that node's renders. One sentence per node.
 */
function keeperAlarm(qs) {
	if (!qs) return null;
	const down = qs.nodes.map((row) => ({ row, v: keeperVerdict(row) })).filter(({ v }) => v.verdict === 'bad');
	if (!down.length) return null;
	return el(
		'div',
		{ cls: 'note bad' },
		down.map(({ row, v }) => el('div', null, [el('strong', { text: `${hostOf(row)}: ` }), v.detail]))
	);
}

// ---- KPIs ------------------------------------------------------------------------

function kpis(data, qs, analytics) {
	const reading = backlogReading(data, qs);
	// Over the window the scan COVERED: a truncated scan holds fewer hours than were asked for.
	const rendersPerHour = analytics
		? sumCount(pick(analytics, 'render', (s) => s.path === OUTCOME)) /
			(coveredHours(analytics) ?? analytics.rangeMs / 3_600_000)
		: null;
	const clear = drainOf(reading, rendersPerHour);
	const slots = slotPressure(data);
	const slotVerdict = verdictAbove(slots?.share, LIMITS.slotShare);
	const changed = changedReading(qs, rendersPerHour);
	const late = behind(qs?.cluster?.lateness);
	const lateVerdict = behindVerdict(late);
	const flightShort = reading.inFlightShortOf.length > 0;
	const sourceText =
		reading.source === 'keeper'
			? reading.floor
				? 'live · lower bound'
				: 'live'
			: reading.source === 'snapshot'
				? `snapshot ${ago(reading.asOf)}`
				: null;

	const tiles = [
		stat(
			'Due now',
			Number.isFinite(reading.overdue) ? num(reading.overdue) + (reading.floor ? '+' : '') : '—',
			reading.keeperDown
				? 'no count: a queue keeper is not live'
				: reading.error
					? 'last snapshot failed'
					: !reading.source
						? 'no queue state or snapshot'
						: Number.isFinite(clear.ms)
							? `~${duration(clear.ms)} to clear · ${sourceText}`
							: sourceText,
			{
				warn: clear.verdict === 'warn' || reading.floor,
				bad: clear.verdict === 'bad' || !!reading.error,
				title:
					'Includes in-flight renders: a leased row keeps its due time until it lands. "To clear" is the rows ' +
					'waiting beyond in-flight, node by node, ÷ the render rate over the selected range. Live when every ' +
					'node’s queue keeper can vouch for its count; otherwise the backlog snapshot' +
					(reading.shortOf.length ? `, which has no queue from ${reading.shortOf.join(', ')}.` : '.') +
					(reading.error ? ` ${reading.error}` : ''),
			}
		),
		// Plugin v0.94.0. Hidden, not zero, when no node reports it.
		changed.reported &&
			stat(
				'Changed, waiting',
				changed.count === null ? '—' : num(changed.count) + (changed.floor ? '+' : ''),
				changedSub(changed),
				{
					warn: changed.verdict === 'warn',
					bad: changed.verdict === 'bad',
					title:
						'Inside Due now: pages the change probe found changed and hard-expired, ranked ' +
						'queue.ready.changedHeadStart cadences ahead of routine rows. Bots are served the origin until each ' +
						're-renders. "Oldest" is how long the longest-waiting one has been due; "to re-render" is this count ÷ ' +
						'the render rate over the selected range. Either past 2h is a watch, past 8h bad.',
				}
			),
		stat(
			'In flight',
			Number.isFinite(reading.inFlight) ? num(reading.inFlight) + (flightShort ? '+' : '') : '—',
			[
				reading.inFlightLive ? 'live' : 'from snapshot',
				slots && `${isMerged(data) ? 'fullest node ' : ''}${pct(slots.share, 1)} of slots`,
			]
				.filter(Boolean)
				.join(' · '),
			{
				warn: slotVerdict === 'warn' || flightShort,
				bad: slotVerdict === 'bad',
				title:
					(flightShort ? `No lease count from ${reading.inFlightShortOf.join(', ')}. ` : '') +
					'Live leases. Slots are per node, and a full lease table refuses grants on that node' +
					(slots?.node ? ` (fullest: ${slots.node}).` : '.'),
			}
		),
		stat(
			'Behind',
			late?.share === null || !late ? '—' : pct(late.late, late.all),
			late
				? `${num(late.late)} due rows ≥ 1 cadence late`
				: qs?.cluster?.lateness?.edgesDiverge
					? 'nodes bin lateness differently'
					: qs
						? 'needs every keeper live'
						: 'no queue state',
			{
				warn: lateVerdict === 'warn',
				bad: lateVerdict === 'bad',
				title:
					'Due rows at least one of their own cadences late: their page is already two cadences old. Judged ' +
					`only past ${num(LIMITS.behindMinRows)} such rows.`,
			}
		),
	];

	if (analytics) {
		const outcomes = pick(analytics, 'render', (s) => s.path === OUTCOME);
		const times = pick(analytics, 'render', (s) => s.path === 'time_ms');
		const candidateTimes = pick(analytics, 'render', (s) => s.path === 'time_ms' && s.type === 'candidate');
		const total = sumCount(outcomes);
		const failedLike = sumCount(outcomes.filter((s) => s.method === 'failed' || s.method === 'auth-failure'));
		const hours = coveredHours(analytics) ?? analytics.rangeMs / 3_600_000;
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
			)
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
 * faster than it renders (bad). A backlog with NO renders in the window is bad on its face; a backlog
 * with no render RATE (analytics did not load) is unknown.
 */
export function drain(overdue, inFlight, rendersPerHour) {
	if (!Number.isFinite(overdue)) return { ms: null, verdict: 'na' };
	return drainWaiting(Math.max(0, overdue - (Number.isFinite(inFlight) ? inFlight : 0)), rendersPerHour);
}

/** `drain` from a `backlogReading`: its per-node waiting rows when it has them (the keepers), else due − in flight. */
export const drainOf = (reading, rendersPerHour) =>
	Number.isFinite(reading.waiting)
		? drainWaiting(reading.waiting, rendersPerHour)
		: drain(reading.overdue, reading.inFlight, rendersPerHour);

function drainWaiting(waiting, rendersPerHour) {
	if (waiting === 0) return { ms: 0, verdict: 'ok' };
	// An UNKNOWN rate (no analytics loaded) is not a zero one: "nothing rendered" would be a claim.
	if (rendersPerHour === null || rendersPerHour === undefined || !Number.isFinite(rendersPerHour)) {
		return { ms: null, verdict: 'na' };
	}
	if (rendersPerHour <= 0) return { ms: null, verdict: 'bad' };
	const ms = (waiting / rendersPerHour) * 3_600_000;
	return { ms, verdict: ms > 8 * 3_600_000 ? 'bad' : ms > 2 * 3_600_000 ? 'warn' : 'ok' };
}

/** Hours the analytics window actually covers — less than the range when the scan hit its cap. */
const coveredHours = (data) => {
	const from = data.coveredFromMs ?? data.startMs;
	const to = data.coveredToMs ?? data.endMs;
	return Number.isFinite(from) && Number.isFinite(to) && to > from ? (to - from) / 3_600_000 : null;
};

// ---- the queue keeper ---------------------------------------------------------------

const VERDICT_PILL = { ok: 'ok', warn: 'warn', bad: 'bad' };

/**
 * Every node's queue keeper: whether it can vouch for its numbers, its own counts, and what its load,
 * publish and verification cost — plus the range's keeper series above the table.
 */
function keeperCard(ctx, qs, analytics, overview) {
	if (!qs) {
		return card('Queue keeper', {
			body: [el('div', { cls: 'note bad', text: ctx.data.queueStateError ?? 'Could not load queue state.' })],
		});
	}
	const k = keeperStats(analytics);
	const repairs = repairsReading(analytics, qs);
	const verifyMs = Number(optionIndex(configState(ctx).payload).get('queue.keeper.verifyInterval')?.effective);
	const verifyEvery = Number.isFinite(verifyMs) && verifyMs > 0 ? `every ${duration(verifyMs)}` : 'periodic';
	const tiles = k
		? stats([
				stat('Repaired', num(repairs.total), repairsSub(repairs), {
					warn: repairs.verdict === 'warn',
					bad: repairs.verdict === 'bad',
					title:
						'Rows a verification walk found the keeper holding differently from the table. Expect 0; rows gained ' +
						'in a membership change are counted here too, and are named as such.',
				}),
				stat('Holds', num(k.holds), k.granted > 0 ? `${pct(k.holds, k.granted)} of grants` : 'no grants in range', {
					warn: k.holdsVerdict === 'warn',
					bad: k.holdsVerdict === 'bad',
					title:
						'Times a key was held back because its last leases all expired with no result: a renderer crashing on ' +
						'the URL (the plugin log names them), or, when many at once, results not reaching the node. A key ' +
						'still failing is held again, and counted again.',
				}),
				stat(
					'Stale skips',
					k.staleShare === null ? '—' : pct(k.stale, k.stale + k.granted),
					`${num(k.stale)} entries`,
					{
						warn: k.staleVerdict === 'warn',
						bad: k.staleVerdict === 'bad',
						title:
							'Ready-set entries a claim skipped because the row was no longer due. A large share: writes arrive late.',
					}
				),
				stat('Publish', fmtMs(k.publishP95), `p95 ≈ · median ${fmtMs(k.publishMedian)}`, {
					warn: k.publishVerdict === 'warn',
					bad: k.publishVerdict === 'bad',
					title:
						'One ready-set publish on worker 0, per queue.keeper.publishInterval (skipped when nothing changed, ' +
						'forced every 10s). Single-digit ms when healthy.',
				}),
				stat('Verify walk', fmtMs(k.verifyMean), k.verifyWalks ? 'mean' : 'no walk in range'),
				stat('Loads', num(k.loads), k.loads ? `p95 ≈ ${fmtMs(k.loadP95)}` : 'none in range', {
					title: 'One per keeper start: a restart, or a failed load retried. A node serves claims while it loads.',
				}),
			])
		: null;

	// Plugin v0.94.0's changed-pages count, per node: a column only once some node reports it.
	const withChanged = qs.nodes.some((row) => Number.isFinite(row.now?.dueChanged));
	const rows = qs.nodes.map((row) => {
		const v = keeperVerdict(row);
		const keeper = row.trust?.keeper;
		const verify = keeper?.verify;
		const late = behind(row.lateness);
		const leased = exactLeases(overview, row.hostname);
		const cell = (text, extra = {}) => el('td', { cls: 'right mono', text, ...extra });
		return el('tr', null, [
			el('td', { cls: 'mono' }, [hostOf(row)]),
			el('td', { title: v.detail }, [pill(v.label, VERDICT_PILL[v.verdict] ?? '')]),
			cell(row.live && Number.isFinite(row.now?.due) ? num(row.now.due) + (countsExact(row) ? '' : '+') : '—'),
			withChanged &&
				cell(
					row.live && Number.isFinite(row.now?.dueChanged)
						? num(row.now.dueChanged) + (countsExact(row) ? '' : '+')
						: '—',
					{
						title:
							row.live && !Number.isFinite(row.now?.dueChanged)
								? 'Not reported: this node’s plugin predates v0.94.0.'
								: 'Due rows the change probe filed: served from the origin until they re-render.' +
									(Number.isFinite(row.now?.oldestChangedAt)
										? ` The oldest has been due ${duration(Math.max(0, Date.now() - row.now.oldestChangedAt))}.`
										: ''),
					}
				),
			Number.isFinite(leased)
				? cell(num(leased), { title: 'Live leases, from an exact walk of the lease table.' })
				: cell(Number.isFinite(row.now?.inFlight) ? `≈${num(row.now.inFlight)}` : '—', {
						title: 'The lease gauge: it counts an expired lease until the next reconcile.',
					}),
			cell(Number.isFinite(row.coming?.next60m) ? num(row.coming.next60m) : '—'),
			cell(row.lateness?.oldestDueAt ? duration(Date.now() - row.lateness.oldestDueAt) : '—', {
				title: row.lateness?.oldestDueAt ? `oldest due row was due ${ago(row.lateness.oldestDueAt)}` : null,
			}),
			cell(late?.share === null || !late ? '—' : pct(late.late, late.all)),
			cell(
				keeper?.phase === 'loading' && keeper.loadStartedAt
					? `loading ${duration(Date.now() - keeper.loadStartedAt)}`
					: Number.isFinite(keeper?.loadMs)
						? fmtMs(keeper.loadMs)
						: '—',
				{
					title: Number.isFinite(keeper?.loadRows)
						? `${num(keeper.loadRows)} rows read, ${num(keeper.rows ?? 0)} held` +
							(keeper.unreadableRows ? `, ${num(keeper.unreadableRows)} unreadable` : '')
						: null,
				}
			),
			cell(Number.isFinite(keeper?.lastPublish?.ms) ? fmtMs(keeper.lastPublish.ms) : '—', {
				title: keeper?.lastPublish
					? `${num(keeper.lastPublish.published)} published ${ago(keeper.lastPublish.at)}` +
						(keeper.lastPublish.complete === false ? ' (not the whole due set)' : '')
					: null,
			}),
			el('td', { cls: 'right' }, [
				verify
					? verify.repaired > 0
						? membershipGain(keeper) > 0
							? el('span', { title: 'Rows this node gained in a membership change, not missed writes.' }, [
									pill(`${num(verify.repaired)} gained`, 'warn'),
								])
							: pill(`${num(verify.repaired)} repaired`, 'bad')
						: muted(ago(verify.at))
					: muted('not yet'),
			]),
		]);
	});

	const withheld = qs.withheld ?? [];
	return card('Queue keeper', {
		head: [spacer(), muted(`${qs.live} of ${qs.configured} live`)],
		help: [
			'Each node’s queue keeper holds the schedule rows that node owns and publishes the ready set claims are ',
			'served from; these counts are its own, exact and seconds old. A node that cannot vouch for its numbers ',
			'(starting, loading, failed, or gone quiet) says why, and the cluster total is withheld until every node ',
			'can, rather than shown short. The tiles are the selected range: rows the verification walk ',
			`(${verifyEvery}) had to repair (expect 0), holds on keys whose renders never report, claims that found `,
			'a row no longer due, and what a publish and a verification walk cost worker 0.',
		],
		body: [
			tiles,
			k?.unexplainedNotLive > 0 &&
				el('div', {
					cls: 'note warn',
					text:
						`${num(k.notLiveSnapshots)} of ${num(k.snapshots)} backlog snapshots in this range found a queue keeper ` +
						`not live, more than its ${num(k.loads)} load${k.loads === 1 ? '' : 's'} explain.`,
				}),
			withheld.length > 0 &&
				qs.configured > 1 &&
				el('div', {
					cls: 'note warn',
					text:
						`Cluster totals withheld: ${withheld.map((w) => w.hostname ?? 'this node').join(', ')} cannot vouch for ` +
						`${withheld.length === 1 ? 'its' : 'their'} counts. The rows below are each node’s own.`,
				}),
			inexactNodes(qs).length > 0 &&
				el('div', { cls: 'note warn', text: `Counts are a lower bound on ${inexactNodes(qs).join(', ')}.` }),
			table(
				[
					'node',
					'keeper',
					{ text: 'due', right: true },
					withChanged && { text: 'changed', right: true },
					{ text: 'in flight', right: true },
					{ text: 'next hour', right: true },
					{ text: 'oldest due', right: true },
					{ text: 'behind', right: true },
					{ text: 'load', right: true },
					{ text: 'publish', right: true },
					{ text: 'verified', right: true },
				].filter(Boolean),
				rows,
				'No node answered.'
			),
			k &&
				k.publishSpark.some((p) => Number.isFinite(p)) &&
				lineChart(analytics, [{ label: 'publish p95', color: SERIES[0], points: k.publishSpark }]),
		],
	});
}

const LATENESS_COLORS = ['var(--teal-500)', 'var(--teal-300)', 'var(--warn)', '#e07b39', 'var(--bad)'];

/** Due rows by lateness in their own cadences, and the classes whose head is furthest behind. */
function latenessCard(qs) {
	const lateness = qs.cluster.lateness ?? {};
	const edges = lateness.edges ?? [];
	const labels = [0, ...edges].map((lo, i) => (i < edges.length ? `${lo}–${edges[i]}×` : `≥ ${lo}×`));
	const bins = labels.map((label, i) => ({
		label,
		sitemap: lateness.sitemap?.[i] ?? 0,
		discovered: lateness.discovered?.[i] ?? 0,
	}));
	const classes = (lateness.classes ?? []).slice(0, 8);
	return card('How late the due rows are', {
		head: [spacer(), lateness.listsTruncated === true && muted('class lists capped at 200 per node')],
		help:
			'Due rows binned by lateness in their OWN cadence (0.5× on a 6h route is 3h late), sitemap and discovered ' +
			'apart. Claims take the most late first, with sitemap rows boosted and rows the change probe filed ' +
			'(changed) started queue.ready.changedHeadStart cadences ahead, so a class whose head keeps getting later ' +
			'is one that is being starved. The table is the classes whose oldest row is furthest behind.',
		body: [
			lateness.edgesDiverge
				? el('div', { cls: 'note warn', text: 'Nodes bin lateness differently (a version skew); bins not summed.' })
				: barList(
						bins.map((b, i) => ({
							label: `${b.label} · ${fmtCount(b.sitemap)} sitemap / ${fmtCount(b.discovered)} discovered`,
							value: b.sitemap + b.discovered,
							color: LATENESS_COLORS[i] ?? SERIES[0],
						}))
					),
			classes.length > 0 &&
				table(
					[
						'route',
						{ text: 'cadence', right: true },
						'source',
						{ text: 'due', right: true },
						{ text: 'oldest', right: true },
					],
					classes.map((c) =>
						el('tr', null, [
							el('td', { cls: 'mono', text: c.route ?? '(default)' }),
							el('td', { cls: 'right mono', text: Number.isFinite(c.cadenceMs) ? duration(c.cadenceMs) : '—' }),
							el('td', null, [c.fromSitemap ? 'sitemap' : 'discovered', c.changed && pill('changed', 'info')]),
							el('td', { cls: 'right mono', text: num(c.due) }),
							el('td', {
								cls: `right mono${c.oldestLatenessCadences >= 1 ? ' v-warn' : ''}`,
								text: fmtRatio(c.oldestLatenessCadences),
								title: c.oldestDueAt ? `due ${ago(c.oldestDueAt)}${c.worstNode ? ` on ${c.worstNode}` : ''}` : null,
							}),
						])
					)
				),
		],
	});
}

/**
 * The due set's arrivals and departures per minute over the last hour, from the keepers' own
 * bookkeeping: rows coming due by the clock or by a write, against due rows moving into the future (a
 * render landing, or a deferral). The gap between them is the queue growing or draining right now.
 * Rows added and removed are drawn apart and left out of the net: the keeper counts a membership change
 * without saying whether the row was due.
 */
function flowCard(qs) {
	const flow = qs.cluster.flow ?? [];
	if (!flow.length) {
		return card('Queue flow, last hour', { body: [el('div', { cls: 'empty', text: 'No flow recorded yet.' })] });
	}
	const MINUTE = 60_000;
	const start = flow[0].minute;
	const count = Math.round((flow[flow.length - 1].minute - start) / MINUTE) + 1;
	const at = new Map(flow.map((slot) => [slot.minute, slot]));
	const pointsOf = (read) =>
		Array.from({ length: count }, (_, i) => {
			const slot = at.get(start + i * MINUTE);
			return slot ? read(slot) : null;
		});
	const series = [
		{ label: 'came due', color: SERIES[0], points: pointsOf((s) => s.cameDue + s.triggered) },
		{ label: 'rescheduled', color: 'var(--ok)', points: pointsOf((s) => s.rescheduled) },
		{ label: 'added', color: SERIES[2], points: pointsOf((s) => s.added) },
		{ label: 'removed', color: SERIES[3], points: pointsOf((s) => s.removed) },
	];
	const sum = (read) => flow.reduce((acc, slot) => acc + read(slot), 0);
	const minutes = Math.max(1, flow.length);
	const inflow = sum((s) => s.cameDue + s.triggered) / minutes;
	const outflow = sum((s) => s.rescheduled) / minutes;
	return card('Queue flow, last hour', {
		head: [spacer(), legend(series.map(({ label, color }) => ({ label, color })))],
		help:
			'Per minute, from the keepers: rows that came due (their time arrived, or a write made them due) against ' +
			'due rows rescheduled into the future (a render landed, or it was deferred). Rows added and removed are ' +
			'drawn apart and left out of the net, because the keeper does not say whether they were due. Sustained ' +
			'"came due" above "rescheduled" is a queue that is growing.',
		body: [
			stats([
				stat('In', `${fmtCount(inflow)}/min`, 'came due'),
				stat('Out', `${fmtCount(outflow)}/min`, 'rescheduled'),
				stat(
					'Net',
					`${inflow >= outflow ? '+' : '−'}${fmtCount(Math.abs(inflow - outflow))}/min`,
					inflow > outflow ? 'growing' : inflow < outflow ? 'draining' : 'steady'
				),
			]),
			lineChart({ bucketCount: count, startMs: start, bucketMs: MINUTE }, series, {
				format: (v) => (Number.isFinite(v) ? `${fmtCount(v)}/min` : '—'),
			}),
		],
	});
}

// ---- nodes ---------------------------------------------------------------------------

/** How long a node has HELD its current status — the row is written only on a change. */
export const nodeAge = (node) =>
	Number.isFinite(node.statusChangedTime) ? muted(ago(node.statusChangedTime)) : muted('never recorded');

/**
 * A node's observed queue status. `unready` (plugin v0.93.0) is its own warning: the node's queue keeper
 * is not serving, so it grants nothing — distinct from `empty`, which grants nothing because nothing is due.
 */
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
			'steady node reads hours and that is healthy. unready means its queue keeper is not serving, so it ',
			'grants nothing. Intent is the per-node override, which wins over the ',
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
	const series = [
		{ label: 'render p95', color: SERIES[2], points: weightedBuckets(times, 'p95s', data.bucketCount) },
		{ label: 'render mean', color: SERIES[0], points: weightedBuckets(times, 'means', data.bucketCount) },
	];
	return card('Render time', {
		head: [spacer(), legend(series.map(({ label, color }) => ({ label, color })))],
		help:
			'The tail (p95, count-weighted ≈) beside the mean. Capacity is concurrency ÷ the MEAN, as in the tile above; ' +
			'the p95 is where a pathology hides behind a healthy middle.',
		body: [
			series.some((s) => s.points.some((p) => Number.isFinite(p)))
				? lineChart(data, series)
				: emptyNote('render time', data),
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

// ---- renders due, next 24h ----------------------------------------------------------------

/**
 * The next 24 hours of due rows, per hour. From the keepers when every node is live (exact, seconds old);
 * otherwise from the backlog snapshot, which says how old it is. Recompute refreshes the snapshot, which
 * also carries the table counts.
 */
function upcoming(ctx, data, qs) {
	const { enabled, interval, running, lastRun } = data.backlog ?? {};
	const liveHours = qs?.cluster?.coming?.byHour;
	const fromKeeper = Array.isArray(liveHours) && liveHours.length > 0;
	const buckets = fromKeeper ? liveHours.map((count, hour) => ({ hour, count })) : (lastRun?.buckets ?? []);
	// A snapshot covers ONE node's owned keys, so "recompute" has no cluster meaning.
	const clusterScope = isMerged(data);

	const body = [];
	if (!fromKeeper) {
		// A node that has never snapshotted, or whose keeper was not live when it did, contributes ZERO —
		// indistinguishable from nothing due.
		const short = [...(lastRun?.missing ?? []), ...(lastRun?.unavailable ?? [])];
		if (short.length) {
			body.push(
				el('div', {
					cls: 'note warn',
					text: `No queue from ${short.join(', ')} in the last snapshot — the real backlog is larger.`,
				})
			);
		}
		if (lastRun?.error) body.push(el('div', { cls: 'note bad', text: `The last snapshot failed: ${lastRun.error}` }));
		else if (!lastRun) body.push(el('div', { cls: 'empty', text: 'No queue state and no snapshot yet.' }));
		else if (lastRun.truncated) {
			body.push(
				el('div', {
					cls: 'note warn',
					text:
						'The snapshot’s counts are a lower bound: a queue keeper skipped unreadable rows or had to repair ' +
						'rows at its last verification.',
				})
			);
		}
	} else if (inexactNodes(qs).length > 0) {
		body.push(el('div', { cls: 'note warn', text: `Counts are a lower bound on ${inexactNodes(qs).join(', ')}.` }));
	}
	if ((fromKeeper || (lastRun && !lastRun.error)) && buckets.length && !buckets.some((bucket) => bucket.count)) {
		body.push(el('div', { cls: 'note ok', text: 'Nothing is due in the next 24 hours.' }));
	}
	if (buckets.length) body.push(hourBars(buckets));

	return card('Renders due, next 24h', {
		head: [
			spacer(),
			fromKeeper
				? muted(`live · queue keeper ${ago(qs.generatedAt)}`)
				: enabled
					? muted(`snapshot every ${duration(interval)}${lastRun ? ` · ${ago(lastRun.finishedAt)}` : ''}`)
					: pill('snapshot disabled', 'warn'),
			el('button', {
				cls: 'small',
				text: clusterScope ? 'Recompute (pick a node)' : running ? 'Computing…' : 'Recompute',
				disabled: ctx.busy || running || clusterScope,
				title: clusterScope
					? 'Each node snapshots the keys it owns. Pick a node to recompute its slice.'
					: 'Recompute this node’s backlog snapshot (and its table counts) now.',
				onclick: () => ctx.run(() => ctx.post('backlog', {})),
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

// ---- settings ----------------------------------------------------------------------------

function settings(ctx) {
	return section('queue', 'Settings', [
		settingsCard(ctx, {
			title: 'Queue mechanics',
			prefix: 'queue',
			description:
				'How work is handed to the render fleet: lease length, claim batch size, the ready set that decides the ' +
				'ORDER (sitemapBoost, and changedHeadStart for pages the change probe found changed), and the queue ' +
				'keeper that publishes it (publish, verification and state intervals). None of it ' +
				'changes what is in the corpus, only how fast and in what order it is worked through. ' +
				'queue.ready.capacity and queue.maxLeases are restart-scoped.',
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
				'The bounds every registry walk runs under: how many rows one scan buffers, how writes are batched once ' +
				'the cursor closes, and how often a walk yields to the event loop.',
		}),
	]);
}
