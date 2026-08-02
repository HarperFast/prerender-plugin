/**
 * Overview: scale, the upcoming-render shape, node status, and the schedule-repair result.
 *
 * NOTHING ON THIS VIEW WALKS AN INDEX ON LOAD. The counts are table metadata (`getRecordCount`)
 * and the backlog/histogram comes from a snapshot computed on a background cadence — `claim`
 * does a sorted range read on `RenderSchedule.nextRenderTime` from every worker every few
 * seconds and every completed render writes back to it, so a panel that swept that index on
 * every page load would compete directly with rendering. Recomputing is an explicit click.
 */

import { ago, card, chart, duration, el, ICONS, kv, link, muted, num, pill, spacer, stat, unwired } from '../ui.js';

export const meta = { id: 'overview', label: 'Overview', crumb: 'overview', icon: ICONS.overview };

export async function load(ctx) {
	const res = await ctx.get('overview');
	ctx.data.overview = res.ok ? res.body : null;
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
		traffic(),
		upcoming(ctx, data),
		el('div', { cls: 'cols' }, [nodes(ctx, data), failures()]),
		repair(ctx, data),
	];
}

function counts(ctx, data) {
	const value = (count) => (count ? num(count.recordCount) : '—');
	const sub = (count) => (count?.estimatedRange ? `estimate ±${num(count.estimatedRange)}` : (count?.error ?? 'exact'));

	const backlog = data.backlog.lastRun;

	return el('div', { cls: 'stat-grid' }, [
		stat('Render targets', value(data.counts.targets), sub(data.counts.targets)),
		stat('Cached pages', value(data.counts.pages), sub(data.counts.pages)),
		stat(
			'Due now',
			backlog && !backlog.error ? num(backlog.overdue) + (backlog.truncated ? '+' : '') : '—',
			backlog?.error ? 'last snapshot failed' : backlog ? `snapshot ${ago(backlog.finishedAt)}` : 'no snapshot yet',
			{ warn: !!backlog && !backlog.error && backlog.overdue > 0 }
		),
		stat('Sitemaps', value(data.counts.sitemaps), [link('view sitemaps →', () => ctx.go('sitemaps'))]),
		stat('Non-indexable', value(data.counts.nonIndexable), 'suppressed URLs'),
	]);
}

/**
 * Bot traffic is the one number that says whether any of this is working, and it is the panel
 * this console most obviously wants. The serving path already records a `bot_request` metric,
 * but without a cache-status label there is no way to split hit from stale from miss — which is
 * the entire point of the chart. Left declared and empty until that is decided.
 */
const traffic = () =>
	card('Bot traffic served, last 24h', {
		body: [
			unwired(
				'Requests served to bots, split by cache hit / stale / miss, with the crawler breakdown.',
				'a cache-status label on the bot_request analytics metric, and a decision on reading node-local hdb_analytics vs aggregating across the cluster'
			),
		],
	});

function upcoming(ctx, data) {
	const { enabled, interval, running, lastRun } = data.backlog;
	const buckets = lastRun?.buckets ?? [];

	const recompute = el('button', {
		text: running ? 'Computing…' : 'Recompute',
		disabled: ctx.busy || running,
		onclick: () => ctx.run(() => ctx.post('backlog', {})),
	});

	const body = [];

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
					'herd — every target in that hour comes due at once.',
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
		foot: [muted('Throughput and render latency per node are not shown — see Queue & nodes.')],
	});
}

/**
 * Renders that fail leave a log line and nothing else: `processJobResult` warns and either
 * leaves the job to retry or drops an orphaned schedule row. Nothing persists what failed or
 * why, so there is nothing to list here yet.
 */
const failures = () =>
	card('Failing renders', {
		body: [
			unwired(
				'URLs whose last render failed, with the error and how many times it has repeated.',
				'a persisted render-failure record — processJobResult currently only logs, so a failure leaves no queryable trace'
			),
		],
	});

// A target whose RenderSchedule row is missing renders nothing, forever, with no error to
// notice it by — so the repair sweep's last result belongs on the dashboard whether or not
// anyone thinks to run it.
function repair(ctx, data) {
	const info = data.reconcile ?? {};
	const last = info.lastRun;

	const body = [];

	if (!info.enabled) {
		body.push(
			el('div', { cls: 'note bad' }, [
				el('code', { text: 'render.reconcile.enabled' }),
				' is false. Nothing will repair a target whose schedule row goes missing, and such a URL ' +
					'stops rendering permanently and silently.',
			])
		);
	}

	if (last?.error) {
		body.push(el('div', { cls: 'note bad', text: `Last sweep failed: ${last.error}` }));
	} else if (last) {
		body.push(
			kv([
				['Last sweep', ago(last.finishedAt)],
				['Targets examined', num(last.examined)],
				['Owned by this node', num(last.owned)],
				['Schedule rows restored', last.restored ? pill(num(last.restored), 'warn') : pill('0', 'ok')],
				last.truncated ? ['Truncated', pill('hit the restore cap — more may remain', 'bad')] : null,
			])
		);
	} else {
		body.push(muted('No sweep has run on this node yet since it started.'));
	}

	body.push(
		el('p', { cls: 'muted', style: { margin: '12px 0 0' } }, [
			'A target and its schedule are two writes in two databases, and the schedule is routed to the ' +
				'node owning the URL — so the pair can end up half-written. This sweep repairs only the keys ' +
				'THIS node owns (a node can only read its own residency-pinned rows without a cross-node ' +
				'fetch); every node sweeps its own slice.',
		])
	);

	return card('Schedule repair', {
		head: [
			info.enabled ? pill(`every ${duration(info.interval)}`, 'ok') : pill('disabled', 'bad'),
			info.running && pill('running now', 'warn'),
			spacer(),
			el('button', {
				text: info.running ? 'Sweep running…' : 'Run repair sweep',
				disabled: ctx.busy || info.running,
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
