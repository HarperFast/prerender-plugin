/**
 * Overview: scale, serve health, the upcoming-render shape, node status, and the
 * schedule-repair result.
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
	isMerged,
	legend,
	pick,
	scopeLabel,
	stackBy,
	stackedBars,
	sumCount,
	weighted,
	windowEmpty,
} from '../charts.js';

export const meta = { id: 'overview', label: 'Overview', crumb: 'overview', icon: ICONS.overview };

export async function load(ctx) {
	const [res, analyticsRes] = await Promise.all([
		ctx.get('overview'),
		// The same range key Traffic and Queue default to, so all three views share one
		// worker-cached scan instead of each paying their own.
		ctx.get('analytics', { range: 3_600_000 }),
	]);
	ctx.data.overview = res.ok ? res.body : null;
	ctx.data.analytics = analyticsRes.ok ? analyticsRes.body : null;
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
		el('div', { cls: 'cols' }, [nodes(ctx, data), failures(ctx)]),
		repair(ctx, data),
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
	const ageP95 = weighted(pick(data, 'page_age'), 'p95');
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
				stat('Origin offload', pct(total - originServes, total), null, {
					warn: total > 0 && originServes > total / 2,
				}),
				stat('Cache-served', pct(cacheServes, total)),
				stat('Page age p95', fmtMs(ageP95), 'cache serves only ≈', {
					warn: Number.isFinite(ageP95) && Number.isFinite(interval) && ageP95 > interval,
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
				`The scan hit its ${num(lastRun.cap)}-row cap on the overdue backlog, so this distribution is ` +
					'incomplete. Clear the backlog (or raise management.scanCap) to see the shape.',
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
		],
		body,
	});
}

function nodes(ctx, data) {
	const rows = data.nodes.map((node) =>
		el('tr', null, [
			el('td', { cls: 'mono' }, [node.hostname, node.isThisNode && muted(' (this node)')]),
			el('td', null, [statusPill(node.status)]),
			el('td', { cls: 'right' }, [
				el('span', { cls: node.stale ? 'pill warn' : 'muted', text: ago(node.updatedTime) }),
			]),
		])
	);

	return card('Nodes', {
		head: [spacer(), link('open queue →', () => ctx.go('queue'))],
		body: [
			el('div', { cls: 'scroll' }, [
				el('table', null, [
					el(
						'tbody',
						null,
						rows.length
							? rows
							: [el('tr', null, [el('td', { cls: 'muted', text: 'No nodes have reported queue status yet.' })])]
					),
				]),
			]),
		],
		foot: [muted('Per-node throughput, pause intent and claim health are on Queue & nodes.')],
	});
}

/**
 * Render failures IN AGGREGATE, from the `render` outcome metric — how many results failed,
 * were auth-refused, or bounced, this node, this hour. The aggregate is the alarm; the
 * per-URL list this card originally asked for still has no data path (a failure leaves a log
 * line, not a queryable record), so that part stays declared rather than faked: the panel
 * never shows a URL it cannot actually know.
 */
function failures(ctx) {
	const data = ctx.data.analytics;
	const openQueue = link('open queue →', () => ctx.go('queue'));
	const title = `Render outcomes — ${scopeLabel(data)}, last hour`;

	if (!data || data.available === false || windowEmpty(data)) {
		return card(title, {
			head: [spacer(), openQueue],
			body: [emptyNote('render', data)],
		});
	}

	// Pill severity mirrors the chart colors: rendered good, hard failures bad, retried warn,
	// verdicts (suppressed/redirect) neutral — they are outcomes, not faults.
	const outcomeKind = (outcome) =>
		outcome === 'rendered'
			? 'ok'
			: outcome === 'failed' || outcome === 'auth-failure'
				? 'bad'
				: outcome === 'transient'
					? 'warn'
					: '';

	const outcomes = pick(data, 'render', (s) => s.path === 'outcome');
	const total = sumCount(outcomes);
	// A plain object, not a Map: the asset test pins `get('…')` literals as API routes, and
	// outcome names are a closed set from the metric catalog, so untrusted-key traps don't apply.
	const byOutcome = {};
	for (const s of outcomes) byOutcome[s.method] = (byOutcome[s.method] ?? 0) + s.count;
	const bad = (byOutcome['failed'] ?? 0) + (byOutcome['auth-failure'] ?? 0);

	return card(title, {
		head: [spacer(), openQueue],
		body: [
			total === 0
				? el('div', {
						cls: 'note',
						text: `No render results were processed on ${isMerged(data) ? 'any node' : 'this node'} in the window.`,
					})
				: kv(
						Object.entries(byOutcome)
							.sort((a, b) => b[1] - a[1])
							.map(([outcome, count]) => [outcome, pill(`${num(count)} · ${pct(count, total)}`, outcomeKind(outcome))])
					),
			bad > 0 &&
				el('p', { cls: 'muted', style: { margin: '12px 0 0' } }, [
					'WHICH urls are failing is not recorded anywhere queryable yet (a failure leaves a log ',
					'line only) — grep the node log for "processJobResult" until a failure record exists.',
				]),
		],
	});
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

export const statusPill = (status) =>
	pill(
		status ?? 'unknown',
		status === 'paused' ? 'bad' : status === 'queued' ? 'ok' : status === 'empty' ? '' : 'warn'
	);
