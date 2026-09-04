/**
 * Overview: scale, serve health, the upcoming-render shape, and the schedule-repair result.
 * Node health is one line here and a whole view (Nodes) behind it — see nodeSummary.
 *
 * NOTHING ON THIS VIEW WALKS THE PLUGIN'S TABLES ON LOAD. The table counts AND the
 * backlog/histogram come from a snapshot computed on a background cadence — `claim` does a
 * sorted range read on `RenderSchedule.nextRenderTime` from every worker every few seconds
 * and every completed render writes back to it, and even a time-bounded `getRecordCount` is
 * scanning work a dashboard refresh has no business doing on a worker that serves bot
 * traffic. THE ONE READ THAT ISN'T POINT-SHAPED is the serve-health strip: a bounded,
 * row-capped primary-key scan of `hdb_analytics` (a different table entirely — never the
 * claim path), answered from a per-worker cache for management.analytics.cacheTtl, so
 * action-reloads and view switches re-use it rather than re-scanning.
 *
 * TWO CLOCKS ON ONE SCREEN, and they must stay visibly separate. The snapshot numbers can be
 * fifteen minutes old; the claim-floor and in-flight numbers are atomic loads read at request
 * time. Every snapshot-sourced stat carries a "snapshot Nm ago" subtitle and every live one says
 * "live", and NOTHING here subtracts one from the other — a difference computed across those two
 * clocks would look authoritative and mean nothing. (The serve strip is a third clock — a
 * bucketed window labelled with its own range — and joins nothing either.)
 */

import {
	ago,
	card,
	chart,
	duration,
	el,
	ICONS,
	kv,
	link,
	muted,
	num,
	pct,
	pill,
	shortUrl,
	spacer,
	stat,
} from '../ui.js';
import {
	CACHE_STATUS_COLORS,
	colorFor,
	emptyNote,
	fmtMs,
	fmtNet,
	isMerged,
	legend,
	originLoad,
	pick,
	scopeLabel,
	stackBy,
	stackedBars,
	sumCount,
	weighted,
	windowEmpty,
} from '../charts.js';
import { configState } from './_configEdit.js';

export const meta = { id: 'overview', label: 'Overview', crumb: 'overview', icon: ICONS.overview };

// Row cap for the on-demand "Deep recompute". Sized to see past a backlog that has swallowed a
// production-sized `management.scanCap` while staying well under the plugin's own 100k ceiling —
// the point is to LEARN the real overdue figure once, not to make the deep walk routine.
const DEEP_SCAN_CAP = 50_000;

export async function load(ctx) {
	const [res, analyticsRes, purgeRes] = await Promise.all([
		ctx.get('overview'),
		// The same range key Traffic and Queue default to, so all three views share one
		// worker-cached scan instead of each paying their own.
		ctx.get('analytics', { range: 3_600_000 }),
		// In-memory state, no scan — the same argument the orphan sweep's last result rides on:
		// a destructive pass that is RUNNING has to be visible on the page an operator lands on,
		// not on one they would have to think to open.
		ctx.get('discovery-purge'),
	]);
	ctx.data.overview = res.ok ? res.body : null;
	ctx.data.analytics = analyticsRes.ok ? analyticsRes.body : null;
	ctx.data.purge = purgeRes.ok ? purgeRes.body : null;
	ctx.data.error = res.ok ? null : (res.body?.error ?? `Could not load the overview (${res.status})`);
}

export function render(ctx) {
	const data = ctx.data.overview;
	if (!data) return el('div', { cls: 'note bad', text: ctx.data.error ?? 'No overview data.' });

	return [
		el('div', { cls: 'view-head' }, [
			el('span', { cls: 'eyebrow', text: 'Overview' }),
			spacer(),
			el('span', { cls: 'muted mono', text: `generated ${ago(data.generatedAt)}` }),
			el('button', { text: 'Refresh', disabled: ctx.busy, onclick: () => ctx.reload() }),
		]),
		counts(ctx, data),
		traffic(ctx),
		upcoming(ctx, data),
		nodeSummary(ctx, data),
		failures(ctx),
		repair(ctx, data),
		orphans(ctx, data),
		discovered(ctx),
	];
}

// Counts (like the histogram) come from the background snapshot, not from a per-load count:
// a dashboard refresh costs point reads only. Null until the first snapshot has run.
function counts(ctx, data) {
	const tables = data.counts;
	const asOf = data.countsAsOf ? `as of ${ago(data.countsAsOf)}` : 'no snapshot yet';
	const value = (count) => (count ? num(count.recordCount) : '—');
	// THESE TABLES REPLICATE, so they are NOT summed across nodes — every node counts the same
	// corpus. A persistent spread between nodes is therefore not rounding, it is a replication
	// gap, and it is worth more than the count itself: say so on the tile rather than silently
	// showing one node's number as the cluster's.
	const sub = (count) =>
		count?.divergent
			? `nodes disagree: ${num(count.spread.low)}–${num(count.spread.high)} · replication gap? · ${asOf}`
			: count?.estimatedRange
				? `estimate ±${num(count.estimatedRange)} · ${asOf}`
				: (count?.error ?? asOf);

	const backlog = data.backlog.lastRun;
	const floor = data.claimFloor ?? {};
	// A leased row keeps its past due time until the render lands, so "Due now" now includes every
	// in-flight render and its healthy floor is the in-flight count, not zero. The two are shown
	// SIDE BY SIDE and never subtracted: `overdue` is a scan that may be minutes old, `inFlight` is
	// a gauge read at request time.
	//
	// THE LIVE GAUGE FIRST, because the tile says "live". `claimFloor.occupancy` is an atomic load
	// taken while this payload was built; `backlog.inFlight` is the same gauge as of whenever the
	// snapshot last ran, which can be fifteen minutes ago — it was being preferred, so a tile
	// labelled live was showing a snapshot number. It stays as the fallback, and says so.
	const inFlightLive = Number.isFinite(floor.occupancy);
	const inFlight = inFlightLive ? floor.occupancy : Number.isFinite(backlog?.inFlight) ? backlog.inFlight : null;
	const dueBeyondInFlight = backlog && !backlog.error && Number.isFinite(inFlight) && backlog.overdue - inFlight > 0;

	return el('div', { cls: 'stat-grid' }, [
		stat('Render targets', value(tables?.targets), sub(tables?.targets), { warn: !!tables?.targets?.divergent }),
		stat('Cached pages', value(tables?.pages), sub(tables?.pages), { warn: !!tables?.pages?.divergent }),
		stat(
			'Due now',
			backlog && !backlog.error ? num(backlog.overdue) + (backlog.truncated ? '+' : '') : '—',
			backlog?.error
				? 'last snapshot failed'
				: backlog
					? `includes in-flight · snapshot ${ago(backlog.finishedAt)}`
					: 'no snapshot yet',
			{ warn: dueBeyondInFlight }
		),
		stat(
			'In flight',
			Number.isFinite(inFlight) ? num(inFlight) : '—',
			inFlightLive ? 'leased to a renderer · live' : `leased to a renderer · snapshot ${ago(backlog?.finishedAt)}`
		),
		stat(
			// Across a cluster this is the WORST node's lag, not an average: the queue is only as
			// healthy as its most-pinned node, and averaging four floors would hide the one that
			// has stopped moving. `worstNode` names it.
			floor.worstNode ? `Claim floor lag · worst (${floor.worstNode})` : 'Claim floor lag',
			floor.enabled === false ? 'disabled' : Number.isFinite(floor.lagMs) ? duration(floor.lagMs) : '—',
			floor.enabled === false
				? 'queue.claimFloor.enabled is false'
				: floor.disabledOn?.length
					? `disabled on ${floor.disabledOn.join(', ')}`
					: // NAME THE ROW, AND SAY HOW LONG IT HAS HELD. A lag figure alone sends an operator
						// hunting; the floor sits at the due minute of one row, and only a claim pass can say
						// which — so the key is what this worker's last pass saw. The duration beside it is
						// NODE-WIDE (it lives in the shared buffer), and it is the number that separates a
						// render legitimately in flight from one that never posts a result: past
						// queue.claimFloor.unpinAfter the claim pass writes that row forward itself.
						floor.floorHeldBy
						? `held by ${shortUrl(floor.floorHeldBy)}${
								floor.floorPinnedForMs > 0 ? ` for ${duration(floor.floorPinnedForMs)}` : ''
							} · this worker’s last claim`
						: 'how far back the claim scan starts · live',
			// The floor cannot advance past the oldest DUE ROW, and only that row's own result moves
			// it — a lease expiring does not — so a lag well past one lease means a render is holding
			// it and everything behind it is waiting. The subtitle names the row.
			{ warn: Number.isFinite(floor.lagMs) && floor.lagMs > 2 * (data.intervals?.jobLeaseTime ?? 0) }
		),
		stat('Sitemaps', value(tables?.sitemaps), [link('view sitemaps →', () => ctx.go('sitemaps'))]),
		stat(
			'Suppressed',
			tables?.suppressed && !tables.suppressed.error
				? num(tables.suppressed.recordCount) + (tables.suppressed.truncated ? '+' : '')
				: '—',
			'non-indexable verdicts'
		),
	]);
}

/**
 * Bot traffic is the one number that says whether any of this is working. Wired to the
 * node-local analytics window (the decision this panel was waiting on landed with the
 * external collector: read each node's own hdb_analytics, never a replicated fan-out — the
 * console charts THIS node's slice and says so; ratios are representative, totals are 1/N).
 * The Traffic view carries the full breakdown; this strip is the "is it working" read.
 */
function traffic(ctx) {
	const data = ctx.data.analytics;
	const open = link('open traffic →', () => ctx.go('traffic'));
	const title = `Bot serves — ${scopeLabel(data)}, last hour`;

	if (!data || data.available === false || windowEmpty(data)) {
		return card(title, {
			head: [spacer(), open],
			body: [emptyNote('bot_serve', data)],
		});
	}

	const serves = pick(data, 'bot_serve');
	const total = sumCount(serves);
	const originServes = sumCount(serves.filter((s) => s.path === 'origin'));
	const cacheServes = sumCount(serves.filter((s) => s.path === 'cache'));
	// The figure the gross tile flatters: renders, probes and sitemap fetches are origin requests
	// too. Same arithmetic as Traffic (charts.js), so the two views cannot disagree about "net".
	const load = originLoad(data);
	// The median, matching Traffic: an evenly refreshed corpus puts its p95 within a whisker of the
	// interval by construction, so a p95 tile here would read as "behind" on a healthy fleet.
	const ageMedian = weighted(pick(data, 'page_age'), 'median');
	const interval = data.intervals?.defaultRenderInterval;

	const { keys, stacks } = stackBy(serves, 'method', data.bucketCount);

	return card(title, {
		head: [
			spacer(),
			legend(keys.slice(0, 5).map((k) => ({ label: k, color: colorFor(CACHE_STATUS_COLORS, k) }))),
			open,
		],
		body: [
			el('div', { cls: 'stat-grid tight' }, [
				stat('Serves', num(total)),
				stat(
					'Origin offload',
					pct(total - originServes, total),
					// Gross on the face, net underneath — the subtitle is what stops a 90% headline being
					// quoted for a deployment whose renders and probes hand most of it back.
					Number.isFinite(load.net)
						? `${fmtNet(load.net)} net of renders + probes · ${
								load.scriptCalls.measured ? 'script calls counted' : 'before crawler follow-up requests'
							}`
						: 'gross — crawler requests not proxied live',
					// Either figure under half is the flag; the net one is the one that can go negative.
					{ warn: (total > 0 && originServes > total / 2) || (Number.isFinite(load.net) && load.net < 0.5) }
				),
				stat('Cache-served', pct(cacheServes, total)),
				stat('Page age', fmtMs(ageMedian), 'median, cache serves only ≈', {
					warn: Number.isFinite(ageMedian) && Number.isFinite(interval) && ageMedian > interval,
				}),
			]),
			total > 0 ? stackedBars(data, keys, stacks, (k) => colorFor(CACHE_STATUS_COLORS, k)) : null,
		],
	});
}

function upcoming(ctx, data) {
	const { enabled, interval, running, lastRun } = data.backlog;
	const buckets = lastRun?.buckets ?? [];

	// A snapshot covers ONE node's owned keys, so "recompute" has no cluster meaning — the proxy
	// refuses it under cluster scope rather than silently recomputing a quarter of the picture.
	// Say that on the button instead of letting the click produce an error banner.
	const clusterScope = isMerged(data);
	const recompute = el('button', {
		text: clusterScope ? 'Recompute (pick a node)' : running ? 'Computing…' : 'Recompute',
		disabled: ctx.busy || running || clusterScope,
		title: clusterScope ? 'Each node snapshots the keys it owns. Switch to a node to recompute its slice.' : null,
		onclick: () => ctx.run(() => ctx.post('backlog', {})),
	});

	// A DEEPER walk, for this run only. Offered only when the last one truncated, because that
	// is the state where the panel stops answering the question: the ascending scan spends its
	// whole budget on overdue rows, so `overdue` reports the cap instead of a count and the
	// histogram below is empty — not because nothing is due, but because the scan never got
	// there. `management.scanCap` is sized for a walk that repeats every interval; this is the
	// one-off that tells you what to size it to.
	const deepen = el('button', {
		text: 'Deep recompute',
		disabled: ctx.busy || running || clusterScope,
		title: `One deliberate ${num(DEEP_SCAN_CAP)}-row walk, this run only — the scheduled snapshot keeps using management.scanCap.`,
		onclick: () => ctx.run(() => ctx.post('backlog', { cap: DEEP_SCAN_CAP })),
	});

	const body = [];

	// THE ALARM FOR THE FAILURE MODE THE CLAIM FLOOR INTRODUCES. A row whose due time sits below
	// the floor is never claimed again, and nothing else notices: the reconcile sweep tests row
	// EXISTENCE and the row exists, the URL simply stops rendering. This snapshot is the only
	// reader that still scans from the absolute index minimum, which makes it the only detector.
	if (lastRun?.belowFloor > 0) {
		const whose = lastRun.nodes > 1 ? `the claim floor of one of ${lastRun.nodes} nodes` : "this node's claim floor";
		body.push(
			el('div', { cls: 'note bad' }, [
				`${num(lastRun.belowFloor)} schedule row(s) sit BELOW ${whose}` +
					(lastRun.oldestBelowFloorMs ? ` (oldest was due ${ago(lastRun.oldestBelowFloorMs)})` : '') +
					'. Nothing will claim those keys, and they report no error. They are recovered when the floor ' +
					'resets (queue.claimFloor.resetInterval), or immediately with the queue action ' +
					'reset-claim-floor — run on the node that owns them, which is why this count is worth ' +
					'drilling into per node. A due time written straight to the table — the operations API ' +
					'or the exported RenderSchedule endpoint — is the usual cause; nothing in the plugin can see ' +
					'those writes.',
			])
		);
	}

	// A node that has never snapshotted contributes ZERO to this sum, which is indistinguishable
	// from a node with nothing due. Name it — the histogram is short by that node's whole slice.
	if (lastRun?.missing?.length) {
		body.push(
			el('div', { cls: 'note warn' }, [
				`No snapshot yet from ${lastRun.missing.join(', ')} — the totals and the histogram below are ` +
					`the other ${lastRun.nodes} node(s) only, so the real backlog is larger than shown.`,
			])
		);
	}

	if (lastRun?.error) {
		body.push(el('div', { cls: 'note bad', text: `The last snapshot failed: ${lastRun.error}` }));
	} else if (!lastRun) {
		body.push(
			el('div', { cls: 'note' }, [
				'No snapshot has been computed on this node yet. This scan walks the same ',
				el('code', { text: 'nextRenderTime' }),
				' index the render queue claims from, so it runs on a background cadence rather than on page load.',
			])
		);
	} else if (lastRun.truncated) {
		body.push(
			el('div', { cls: 'note warn' }, [
				`The scan hit its ${num(lastRun.cap)}-row cap on the overdue backlog, so the count above is a ` +
					'FLOOR, not a total, and the histogram below is empty because the walk never reached a ' +
					'not-yet-due row. "Deep recompute" runs one deeper walk to find the real figure — size ' +
					'management.scanCap from what it reports.',
			])
		);
	} else if (!buckets.some((bucket) => bucket.count)) {
		body.push(el('div', { cls: 'note ok', text: 'Nothing is due in the next 24 hours.' }));
	}

	if (buckets.length) {
		body.push(
			chart(buckets, {
				title: (bucket) => `${bucket.count} due in hour +${bucket.hour}`,
				label: (bucket) => (bucket.hour % 3 === 0 ? `+${bucket.hour}h` : ''),
				// A single hour holding a large share of the horizon is a render herd, not a shape.
				color: (bucket, max) => max > 20 && bucket.count > max * 0.5,
			})
		);
		body.push(
			el('p', { cls: 'muted', style: { margin: '12px 0 0' } }, [
				'A flat spread means the initial-render jitter is working. A single tall spike is a render ' +
					'herd — every target in that hour comes due at once. Hour 0 no longer holds the jobs ' +
					'currently being rendered: a leased row keeps its past due time until its result lands, so ' +
					'in-flight work counts as “due now” above rather than appearing in this histogram.',
			])
		);
	}

	return card('Renders due, next 24h', {
		head: [
			spacer(),
			enabled ? muted(`recomputed every ${duration(interval)}`) : pill('automatic snapshot disabled', 'warn'),
			lastRun && muted(`as of ${ago(lastRun.finishedAt)}`),
			recompute,
			lastRun?.truncated && deepen,
		],
		body,
	});
}

/**
 * Node health in one line, with the detail a click away on Nodes.
 *
 * The nodes card used to live here, and its table was already the second copy of the one on Queue.
 * What this page actually needs from it is whether anything about the nodes should pull an operator
 * off the rest of the dashboard — so every clause is a thing that should be true, and the line turns
 * into an alarm the moment one of them is not. Nothing is dropped by shortening it: the table, the
 * replication detail and the per-node config answers all moved to Nodes rather than disappearing.
 */
function nodeSummary(ctx, data) {
	const nodes = data.nodes ?? [];
	// `responding` is null under node scope (there was no fan-out to answer it) and only ever false
	// when a configured node was asked and did not reply — so the count is of nodes NOT known bad,
	// never of nodes proven good.
	const responding = nodes.filter((node) => node.responding !== false).length;
	const paused = nodes.filter((node) => node.status === 'paused').length;
	const behind = nodes.filter((node) => node.behind?.length).length;

	const clauses = [
		[`${num(nodes.length)} node${nodes.length === 1 ? '' : 's'}`, nodes.length > 0],
		[`${num(responding)} responding`, responding === nodes.length],
		[`${num(paused)} paused`, paused === 0],
		behind ? [`${num(behind)} behind on replication`, false] : ['replication converged', true],
	];

	// The config clause is claimed ONLY when a config payload happens to be in the shared scratch —
	// Nodes and Queue load it, this view deliberately does not, because a fan-out for one clause is
	// not worth it on the page that is already the heaviest. Saying nothing is the honest state for a
	// question this page never asked; a green "config identical" derived from no data is exactly the
	// failure mode this console keeps being widened to prevent.
	const payload = configState(ctx).payload;
	if (payload?.configFrom) {
		// Only the unexplained ones. A divergence the merge tagged `overridden` is the override layer
		// converging — normally because of a write this console just made — and raising the
		// deploy-failure alarm for it here is how that alarm stops being read.
		const differ = (payload.divergences ?? []).filter((entry) => !entry.overridden).length;
		clauses.push(differ ? [`${num(differ)} option(s) differ between nodes`, false] : ['config identical', true]);
	}

	const bad = clauses.some(([, ok]) => !ok);
	return el('div', { cls: `note ${bad ? 'bad' : ''}`.trim() }, [
		clauses.map(([text], index) => [index > 0 && ' · ', text]),
		' — ',
		link('open nodes →', () => ctx.go('nodes')),
	]);
}

/**
 * Render failures IN AGGREGATE, from the `render` outcome metric — how many results failed,
 * were auth-refused, or bounced, this node, this hour. The aggregate is the alarm; the
 * per-URL list this card originally asked for still has no data path (a failure leaves a log
 * line, not a queryable record), so that part stays declared rather than faked: the panel
 * never shows a URL it cannot actually know.
 */
/**
 * Render outcomes, demoted to one line.
 *
 * This used to be a full card breaking outcomes down by kind. Queue already renders the same
 * `render` metric as KPIs AND as a stacked series over time, so the card was a strict subset of a
 * better panel one click away — and a dashboard that restates another page's numbers teaches
 * operators that the overview is where you look, which is exactly wrong when the detail (which
 * outcome, trending which way) only exists on the other page.
 *
 * What survives is the part an overview owes you: whether the number is bad enough to go and look.
 * The threshold matches Queue's own (one in ten past tail noise for any healthy corpus), so the two
 * pages cannot disagree about whether this is fine.
 */
function failures(ctx) {
	const data = ctx.data.analytics;
	const open = link('open queue \u2192', () => ctx.go('queue'));
	if (!data || data.available === false || windowEmpty(data)) return null;

	const outcomes = pick(data, 'render', (s) => s.path === 'outcome');
	const total = sumCount(outcomes);
	if (total === 0) return null;

	const byOutcome = {};
	for (const s of outcomes) byOutcome[s.method] = (byOutcome[s.method] ?? 0) + s.count;
	const bad = (byOutcome['failed'] ?? 0) + (byOutcome['auth-failure'] ?? 0);
	const rate = bad / total;

	return el('div', { cls: `note ${rate > 0.1 ? 'bad' : ''}`.trim() }, [
		el('strong', { text: `Render outcomes \u00b7 ${scopeLabel(data)}, last hour: ` }),
		`${num(bad)} of ${num(total)} failed or auth-failed (${pct(bad, total)})`,
		rate > 0.1 ? ' \u2014 past tail noise for a healthy corpus. ' : '. ',
		open,
	]);
}

// A target whose RenderSchedule row is missing renders nothing, forever, with no error to
// notice it by — so the repair sweep's last result belongs on the dashboard whether or not
// anyone thinks to run it.
function repair(ctx, data) {
	const info = data.reconcile ?? {};
	const last = info.lastRun;

	const body = [];

	// ONE node with the sweep off is the finding, not "the cluster has it on". Each node repairs
	// only the keys it owns, so a single disabled node leaves roughly 1/N of the corpus with no
	// repair at all — and every other panel keeps looking healthy.
	if (!info.enabled) {
		body.push(
			el('div', { cls: 'note bad' }, [
				el('code', { text: 'render.reconcile.enabled' }),
				info.disabledOn?.length
					? ` is false on ${info.disabledOn.join(', ')}. The keys those nodes own have no repair sweep: ` +
						'a target whose schedule row goes missing there stops rendering permanently and silently.'
					: ' is false. Nothing will repair a target whose schedule row goes missing, and such a URL ' +
						'stops rendering permanently and silently.',
			])
		);
	}

	if (last?.error) {
		body.push(el('div', { cls: 'note bad', text: `Last sweep failed: ${last.error}` }));
	} else if (last) {
		body.push(
			kv([
				[last.nodes > 1 ? `Oldest of ${last.nodes} sweeps` : 'Last sweep', ago(last.finishedAt)],
				['Targets examined', num(last.examined)],
				[last.nodes > 1 ? 'Owned across nodes' : 'Owned by this node', num(last.owned)],
				['Schedule rows restored', last.restored ? pill(num(last.restored), 'warn') : pill('0', 'ok')],
				last.truncated ? ['Truncated', pill('hit the restore cap — more may remain', 'bad')] : null,
			])
		);
	} else {
		body.push(muted('No sweep has run yet since startup.'));
	}

	body.push(
		el('p', { cls: 'muted', style: { margin: '12px 0 0' } }, [
			'A target and its schedule are two writes in two databases, and the schedule is routed to the ' +
				'node owning the URL — so the pair can end up half-written. Each node repairs only the keys ' +
				'IT owns (a node can only read its own residency-pinned rows without a cross-node fetch), so ' +
				'the cluster figure above is the sum of every node’s own slice, and a sweep is always run ' +
				'against one node.',
		])
	);

	const clusterScope = isMerged(ctx.data.overview);
	return card('Schedule repair', {
		head: [
			info.enabled ? pill(`every ${duration(info.interval)}`, 'ok') : pill('disabled', 'bad'),
			info.running && pill('running now', 'warn'),
			spacer(),
			el('button', {
				text: clusterScope ? 'Run sweep (pick a node)' : info.running ? 'Sweep running…' : 'Run repair sweep',
				disabled: ctx.busy || info.running || clusterScope,
				title: clusterScope ? 'A sweep covers the keys one node owns. Switch to a node to run it there.' : null,
				// Reload rather than render an acknowledgement: the sweep is detached, so the
				// refreshed overview (running / lastRun) is the honest view of it.
				onclick: () => ctx.run(() => ctx.post('reconcile', {})),
			}),
		],
		body,
	});
}

// Targets orphaned by a CACHE-KEY RULE CHANGE: their stored url no longer canonicalizes to the
// key they are filed under, so no request can ever produce it. They render forever into keys
// nothing reads, and no other repair path can see them — which is exactly why the sweep's last
// result belongs on the dashboard rather than only in the response to its own POST.
//
// MANUAL by design: there is no timer, because the population is created by an operator
// changing a `cacheKey` option, and this deletes corpus.
function orphans(ctx, data) {
	const info = data.orphanSweep ?? {};
	const last = info.lastRun;
	const clusterScope = isMerged(ctx.data.overview);

	const body = [];

	// A node nobody has swept contributes ZERO to every total below, which is indistinguishable
	// from a node that came back clean. Under cluster scope that is the shortfall worth naming —
	// there is no schedule to fall back on, so an unswept node stays unswept until someone acts.
	if (info.unsweptNodes?.length) {
		body.push(
			el('div', { cls: 'note warn' }, [
				`Never swept on ${info.unsweptNodes.join(', ')} — those nodes' keys are not represented in the ` +
					'counts below, so the real orphan count is larger than shown.',
			])
		);
	}

	if (last?.error) {
		body.push(el('div', { cls: 'note bad', text: `Last sweep failed: ${last.error}` }));
	} else if (last) {
		const stranded = (last.orphaned ?? 0) - (last.leaseSkipped ?? 0) - (last.deleted ?? 0);
		body.push(
			kv([
				[
					last.nodes > 1 ? `Oldest of ${last.nodes} sweeps` : 'Last sweep',
					`${last.finishedAt ? ago(last.finishedAt) : 'unknown'}${last.dryRun ? ' (dry run — nothing deleted)' : ''}`,
				],
				['Targets examined', num(last.examined)],
				[last.nodes > 1 ? 'Owned across nodes' : 'Owned by this node', num(last.owned)],
				['Key-rule orphans found', last.orphaned ? pill(num(last.orphaned), 'warn') : pill('0', 'ok')],
				['Deleted', last.dryRun ? muted('none — dry run') : num(last.deleted)],
				// Deferred is not a failure: a key mid-render is skipped and caught next pass.
				last.leaseSkipped ? ['Deferred as in-flight', pill(num(last.leaseSkipped), '')] : null,
				last.truncated
					? ['Truncated', pill(`hit the ${num(info.maxDeletes)} delete cap — ~${num(stranded)} remain`, 'bad')]
					: null,
			])
		);
	} else {
		body.push(muted('No sweep has run on this node since startup. It has no timer — it runs when you run it.'));
	}

	body.push(
		el('p', { cls: 'muted', style: { margin: '12px 0 0' } }, [
			'Run this after changing a ',
			el('code', { text: 'cacheKey' }),
			' option, and run it with the dry run first: the scan always completes, so the orphan count is ' +
				'the true size of the population even when the delete cap stopped the removals. Each node ' +
				'sweeps only the keys IT owns — the in-flight check reads that node’s own lease buffer — so ' +
				'every node has to be swept to cover the keyspace.',
		])
	);

	return card('Key-rule orphans', {
		head: [
			pill('manual — no timer'),
			info.running && pill('running now', 'warn'),
			spacer(),
			el('button', {
				text: clusterScope ? 'Sweep (pick a node)' : info.running ? 'Sweep running…' : 'Dry run',
				disabled: ctx.busy || info.running || clusterScope,
				title: clusterScope ? 'A sweep deletes among the keys one node owns. Switch to a node to run it there.' : null,
				// Always an explicit dryRun: the button that deletes corpus should not be the one
				// you reach by default, and the plugin's own default can be configured either way.
				onclick: () => ctx.run(() => ctx.post('sweep-orphans', { dryRun: true })),
			}),
			el('button', {
				cls: 'danger',
				text: 'Delete orphans',
				disabled: ctx.busy || info.running || clusterScope || !last || last.error || !last.orphaned,
				title: !last?.orphaned ? 'Run a dry run first — this acts on what that census found.' : null,
				onclick: () => ctx.run(() => ctx.post('sweep-orphans', { dryRun: false })),
			}),
		],
		body,
	});
}

/**
 * Targets that entered the corpus from TRAFFIC rather than from a sitemap, and the paced,
 * owner-scoped pass that removes them.
 *
 * WHY THIS IS A DIFFERENT POPULATION FROM THE ORPHANS ABOVE. A key-rule orphan is a bookkeeping
 * fault — a row nothing can ever ask for. A discovered target is a URL a crawler genuinely asked
 * for, which the plugin then minted and has been re-rendering on cadence ever since. On a route
 * whose URL space is combinatorial (facets, filter and sort permutations) that is unbounded: every
 * novel combination a crawler walks becomes permanent render load, and the corpus grows faster
 * than the fleet can keep it fresh.
 *
 * GATE BEFORE PURGING, and the plugin refuses the other order rather than trusting anyone to
 * remember it: with `ingress.routes[].discoverTargets` still true on the matched route, crawlers
 * re-mint exactly what the purge removed, so the pass is a rate-limited way to delete corpus and
 * change nothing. The refusal is a 400 with that sentence in it, and `force` is the deliberate
 * override.
 */
function discovered(ctx) {
	const state = ctx.data.purge;
	const clusterScope = isMerged(ctx.data.overview);
	const busy = ctx.busy || !!state?.running;

	// Kept in view scratch so the prefix survives the reload every action triggers.
	const input = el('input', {
		cls: 'mono',
		type: 'text',
		value: ctx.data.purgePrefix ?? '',
		placeholder: 'https://www.example.com/catalog/',
		style: { flex: '1', minWidth: '260px' },
	});
	const remember = () => {
		ctx.data.purgePrefix = input.value.trim();
		return ctx.data.purgePrefix;
	};

	// SPARING BOT-VISITED TARGETS IS THE SAFE DEFAULT, so the console defaults it on even though
	// the plugin's own default is off (a plugin default that changed behaviour for existing callers
	// would be the wrong kind of change; a console default is a suggestion to a human).
	//
	// A stored `demandInterval` is not a guess: the ladder writes a rung only after a bot visited
	// the URL in each of several consecutive windows, so it is durable evidence of repeat crawler
	// demand on a page no sitemap declares. Deleting one discards a live, served page and lets the
	// crawler re-mint it — a delete and a re-render to arrive back where we started. The test is
	// one-sided on purpose (a stamp proves demand; its absence proves only that no repeat visit was
	// observed), and that asymmetry points the same way: sparing a dead page costs one row.
	ctx.data.purgeSkipVisited ??= true;
	const skipVisited = el('input', {
		type: 'checkbox',
		// The house convention for a boolean attribute: present or absent, never `checked="false"`.
		checked: ctx.data.purgeSkipVisited ? '' : null,
		onchange: (e) => {
			ctx.data.purgeSkipVisited = !!e.target.checked;
		},
	});

	const start = (dryRun) => {
		const urlPrefix = remember();
		if (!urlPrefix) return;
		return ctx.run(() => ctx.post('discovery-purge', { urlPrefix, dryRun, skipVisited: ctx.data.purgeSkipVisited }));
	};

	const body = [
		el('div', { cls: 'toolbar' }, [
			input,
			el('button', {
				text: clusterScope ? 'Census (pick a node)' : 'Dry-run census',
				disabled: busy || clusterScope,
				title: clusterScope
					? 'A purge walks the keys one node owns. Switch to a node to run it, and run every node to cover the keyspace.'
					: 'Counts what a real pass would delete. Nothing is removed.',
				onclick: () => start(true),
			}),
			el('button', {
				cls: 'danger',
				text: 'Purge discovered',
				disabled: busy || clusterScope || !state?.startedAt || state?.dryRun === false,
				title: !state?.startedAt
					? 'Run the census first — this deletes what that census counted.'
					: 'Deletes every discovered target under the prefix on this node.',
				onclick: () => start(false),
			}),
			state?.running &&
				el('button', {
					text: 'Stop',
					disabled: ctx.busy || clusterScope,
					onclick: () => ctx.run(() => ctx.post('discovery-purge', { action: 'stop' })),
				}),
		]),
		el('label', { cls: 'muted', style: { display: 'flex', alignItems: 'center', gap: '6px', margin: '8px 0 0' } }, [
			skipVisited,
			el('span', null, [
				'Spare targets the demand ladder has promoted — pages a bot came back to across several ' +
					'windows, which a purge would delete only for the crawler to re-mint. Applies to the census ' +
					'as well, so the count reflects what the matching purge would remove.',
			]),
		]),
	];

	if (state?.error) body.push(el('div', { cls: 'note bad', text: `Last pass failed: ${state.error}` }));

	// A DIFFERENT FAILURE FROM `state.error`, and it has to say so. `error` is one pass that threw;
	// this is the pass deciding the storage engine had stopped accepting deletes and stopping
	// itself. Grinding on would have kept issuing writes the engine was already rejecting.
	if (state?.abortedOnErrors) {
		body.push(
			el('div', { cls: 'note bad' }, [
				'The pass STOPPED ITSELF after failing to delete many rows in a row — that is the storage engine ' +
					'refusing, not one bad row. What it had already deleted is deleted; the rest of the prefix is ' +
					'untouched. Deletes cascade to schedule rows, cached pages and probe baselines, so this is worth ' +
					'reading as load before starting another pass: re-run it when the node is quieter, and lower ' +
					'the rate if it recurs.',
			])
		);
	}

	// The samples, because a delete failure appears in no other surface: it is not a render, not a
	// serve, and the row it names is still in the corpus and still being re-rendered on cadence.
	if (state?.errorSamples?.length) {
		body.push(
			el('div', { cls: 'note warn' }, [
				'First delete failures: ',
				el('span', { cls: 'mono break' }, [
					state.errorSamples
						.map((sample) => `${sample.hostname ? sample.hostname + ' ' : ''}${sample.url} — ${sample.error}`)
						.join(' · '),
				]),
			])
		);
	}

	// `startedAt` is what separates "has run" from "never run": a node that has never run answers
	// `{ running: false }` and nothing else, and rendering that as a row of zeroes would read as a
	// clean census.
	const totals = state?.totals ?? state;
	if (state?.startedAt) {
		// EVERY WAY A DISCOVERED ROW SURVIVED THE PASS, subtracted — not just the deletes. A row that
		// reached the delete decision was deleted, deferred as in-flight, spared as bot-visited, or
		// it errored; anything left over is what the pass had not reached when it stopped. Omitting a
		// term inflates this figure by exactly that term, which turns "we spared 40% of the prefix on
		// purpose" into "~40% was never reached" — a completed pass reported as an interrupted one.
		//
		// `unreadable` is NOT a term here, and that is not an omission: those rows are skipped by the
		// walk before anything reads their sitemapUrl, so they never entered `discovered` and cannot
		// be subtracted from it. They get their own row below.
		const accounted =
			(totals.deleted ?? 0) + (totals.leaseSkipped ?? 0) + (totals.visitedSkipped ?? 0) + (totals.errors ?? 0);
		const stranded = (totals.discovered ?? 0) - accounted;
		body.push(
			kv([
				[
					state.ranNodes > 1 ? `Oldest of ${state.ranNodes} passes` : state.running ? 'Started' : 'Last pass',
					`${state.running ? ago(state.startedAt) + ' — still running' : state.finishedAt ? ago(state.finishedAt) : 'unknown'}` +
						`${state.dryRun ? ' (census — nothing deleted)' : ''}${state.canceled ? ' · stopped early' : ''}`,
				],
				['Prefix', state.urlPrefix ?? (state.urlPrefixes?.length ? state.urlPrefixes.join(', ') : '—')],
				['Rows examined', num(totals.examined)],
				[state.ranNodes > 1 ? 'Owned across nodes' : 'Owned by this node', num(totals.owned)],
				['Discovered (never in a sitemap)', totals.discovered ? pill(num(totals.discovered), 'warn') : pill('0', 'ok')],
				['Deleted', state.dryRun ? muted('none — census') : num(totals.deleted)],
				totals.leaseSkipped ? ['Deferred as in-flight', pill(num(totals.leaseSkipped), '')] : null,
				// Shown whenever the flag was on, INCLUDING at zero: "spared 0" and "did not check"
				// are different findings, and only one of them says the prefix has no live demand on
				// it. At zero on a large prefix that is itself worth seeing.
				state.skipVisited ? ['Spared as bot-visited', pill(num(totals.visitedSkipped ?? 0), 'ok')] : null,
				totals.unreadable ? ['Unreadable rows stepped over', pill(num(totals.unreadable), 'bad')] : null,
				totals.errors ? ['Failed — left for the next pass', pill(num(totals.errors), 'bad')] : null,
				// A pass that stopped early OR gave up on errors left the rest of the prefix in place.
				(state.canceled || state.abortedOnErrors) && stranded > 0
					? ['Not reached', pill(`~${num(stranded)} left under this prefix`, 'warn')]
					: null,
			])
		);
	} else {
		body.push(muted('No purge has run on this node since startup. It has no timer — it runs when you run it.'));
	}

	if (state?.unrunNodes?.length) {
		body.push(
			el('div', { cls: 'note warn' }, [
				`Never run on ${state.unrunNodes.join(', ')} — those nodes' keys are not represented above, and their ` +
					'discovered targets are still rendering.',
			])
		);
	}

	if (state?.urlPrefixes?.length > 1) {
		body.push(
			el('div', { cls: 'note warn' }, [
				'The nodes last ran DIFFERENT prefixes, so the totals above add up two populations. The per-node ' +
					'figures are the answer until every node has run the same one.',
			])
		);
	}

	// The same class of divergence as the prefixes above, and just as invisible in a total: the
	// nodes applied different DELETE PREDICATES to the same prefix, so "spared as bot-visited" is
	// true of part of the keyspace and false of the rest — and the rows the other nodes deleted are
	// gone either way.
	if (state?.ranNodes > 1 && state.skipVisitedOn?.length && state.skipVisitedOn.length < state.ranNodes) {
		body.push(
			el('div', { cls: 'note warn' }, [
				`Only ${state.skipVisitedOn.join(', ')} spared bot-visited targets — the other nodes deleted theirs. ` +
					'The totals above therefore sum two different predicates over the same prefix. Re-running the ' +
					'sparing nodes will not restore what the others removed; crawlers re-mint those URLs if the ' +
					'route is still discovering.',
			])
		);
	}

	body.push(
		el('p', { cls: 'muted', style: { margin: '12px 0 0' } }, [
			'Gate the route first — set ',
			el('code', { text: 'discoverTargets: false' }),
			' on it under Request ingestion — or crawlers re-mint what this removes; the plugin refuses an ' +
				'ungated prefix for that reason, and refuses a bare origin always. A sitemap-declared URL is never ' +
				'touched whatever its traffic looks like: the sitemap is the operator’s statement of what should ' +
				'exist. ',
			link('See how much traffic the gate is holding out →', () => ctx.go('traffic')),
		])
	);

	return card('Discovered targets', {
		head: [
			pill('manual — no timer'),
			state?.running &&
				pill(state.runningOn?.length ? `running on ${state.runningOn.join(', ')}` : 'running now', 'warn'),
			// Under cluster scope the merge reports `skipVisited` only when EVERY node that ran used it,
			// so a mixed cluster reads as "deleting" — which is the true half: some nodes did, and
			// those rows are gone. The note below names which nodes spared theirs. A plugin older
			// than v0.57.0 has no such flag and also reads as "deleting", which is equally correct.
			state?.startedAt &&
				(state.skipVisited ? pill('sparing bot-visited', 'ok') : pill('deleting bot-visited', 'warn')),
			spacer(),
			state?.ratePerSecond ? muted(`${num(state.ratePerSecond)}/s`) : null,
		],
		body,
	});
}

/**
 * How long a node has HELD its current queue status — never "how long since it reported".
 *
 * The QueueStatus row is written only when the status actually moves: `reportStatus` is called
 * per bot request and per claim pass, and the node-local shared buffer exists so those paths do
 * not each become a replicated write. So an old timestamp on a busy node means "it has been
 * queued for three hours", which is health, not silence — and this used to render as an amber
 * "stale" pill on every node in the cluster, permanently, which made the one node that had
 * genuinely stopped indistinguishable from the three that were fine.
 */
export const nodeAge = (node) =>
	Number.isFinite(node.statusChangedTime)
		? muted(`since ${ago(node.statusChangedTime)}`)
		: muted('status never recorded');

export const statusPill = (status) =>
	pill(
		status ?? 'unknown',
		status === 'paused' ? 'bad' : status === 'queued' ? 'ok' : status === 'empty' ? '' : 'warn'
	);
