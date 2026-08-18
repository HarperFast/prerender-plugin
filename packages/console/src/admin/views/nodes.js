/**
 * Nodes: every question that is about ONE node rather than about the cluster.
 *
 * WHY THIS VIEW EXISTS. Per-node health had four homes and was about to get a fifth. Liveness and
 * the replication gap sat on the overview, observed queue status, pause intent and throughput on
 * Queue, config divergence on Config, and the scope picker in the shell. The tell that this was
 * duplication rather than four deliberate framings: Queue imported `nodeAge` and `statusPill` FROM
 * the overview so it could draw a second node table beside the first. The override layer then added
 * the fifth question — "did the edit I just applied actually reach this node" — and that answer is
 * worthless split away from the others: a node that is responding, queued, and running the deployed
 * config is STILL ignoring every option this console writes if its override read has died. So the
 * per-node answers are collected here, and the views they came from keep a line that links here.
 *
 * TWO PAYLOADS, JOINED BY HOSTNAME, AND NEITHER VOUCHES FOR THE OTHER. `overview` carries the
 * QueueStatus rows (replicated, so every node holds a copy of every node's) plus this fan-out's own
 * liveness; `config` carries the override and restart state, which is node-local and therefore
 * exists only for the nodes that answered. A node can appear in one and not the other, and nothing
 * below invents a row to make the two tables the same length — a node missing from the second table
 * did not answer, which is itself the finding.
 *
 * NOTHING ON THIS VIEW IS SUMMED. Every number here belongs to the node in its row; the cluster
 * totals are on the pages that own them.
 */

import { ago, card, duration, el, ICONS, muted, note, num, pill, spacer, table } from '../ui.js';
import { fmtCount, pick } from '../charts.js';
import { nodeAge, statusPill } from './overview.js';
import { configState, loadConfig } from './_configEdit.js';

// Reused rather than minted as a view-local path: icon geometry has one home (ui.js ICONS), and a
// second home for it would be the same mistake this view exists to undo. The sync arc is the
// closest the set has to what this page is about — nodes catching up with one another.
export const meta = { id: 'nodes', label: 'Nodes', crumb: 'nodes', icon: ICONS.refresh };

export async function load(ctx) {
	const [res, analyticsRes] = await Promise.all([
		ctx.get('overview'),
		// The same range key Overview, Traffic and Queue default to, so all four share one
		// worker-cached scan rather than each paying for its own.
		ctx.get('analytics', { range: 3_600_000 }),
		// Config answers the two per-node questions the queue payload cannot: whether this node
		// agrees with its peers about the deployed options, and whether the override layer is still
		// reaching it. It reads the shared scratch, so arriving here from Queue costs no fan-out.
		loadConfig(ctx),
	]);
	ctx.data.overview = res.ok ? res.body : null;
	ctx.data.analytics = analyticsRes.ok ? analyticsRes.body : null;
	ctx.data.error = res.ok ? null : (res.body?.error ?? `Could not load node state (${res.status})`);
}

export function render(ctx) {
	const data = ctx.data.overview;
	if (!data) return el('div', { cls: 'note bad', text: ctx.data.error ?? 'No node data.' });

	const setPause = (scope, paused) => ctx.run(() => ctx.post('queue', { scope, paused }));

	return [
		el('div', { cls: 'view-head' }, [
			el('span', { cls: 'eyebrow', text: 'Nodes' }),
			spacer(),
			el('button', {
				text: 'Refresh',
				disabled: ctx.busy,
				// FORCED, unlike this view's own load. The config half is read through the shared
				// scratch that every other surface reuses instead of re-fetching, which is right for a
				// view switch and wrong for this button: the reason to press it is that a node was
				// mid-convergence a second ago, and answering that from the cached payload would
				// redraw the exact state that made you press it.
				onclick: () => ctx.run(() => loadConfig(ctx, { force: true })),
			}),
		]),
		nodeTable(ctx, data, setPause),
		divergence(ctx),
		overrideArrival(ctx),
		bootDrift(ctx),
	];
}

/**
 * Observed status, pause intent, throughput and liveness — one row per node, moved here from Queue.
 *
 * The wording is load-bearing. `QueueControl` is replicated INTENT; `QueueStatus` is what each node
 * last OBSERVED. Per-node overrides win over the cluster scope in both directions, and a control
 * write converges within one statusSyncInterval — so the two are separate columns, or operators
 * conclude a pause failed and click it repeatedly.
 */
function nodeTable(ctx, data, setPause) {
	// PER-NODE THROUGHPUT, from the analytics window.
	//
	// Under cluster scope the proxy fans the window out and returns a per-node totals block
	// alongside the merged series, so every row here gets its own rate — the column used to be
	// '—' for every node but the one being read, because analytics rows are node-local and a
	// peer's blank rendered as zero would read as "that node is idle". Now the blank means
	// exactly one thing: that node did not answer. Reading a single node still fills only its
	// own row, for the same original reason.
	const analytics = ctx.data.analytics;
	const rateOf = (counts, rangeMs) => {
		const total = counts.reduce((acc, s) => acc + s.count, 0);
		return total > 0 && rangeMs > 0 ? `≈${fmtCount(total / (rangeMs / 3_600_000))}/h` : null;
	};

	// Hostnames are case-insensitive, so both sides of this join are lowercased — the same rule
	// resolveNode follows. The two keys reach it having been through different hands: `node` is
	// the node's own `server.hostname` (verbatim from its Harper config, whatever case that was
	// written in) and `hostname` is the configured origin's host, which `new URL()` has already
	// lowercased. Matching them raw would drop the fallback join for any deployment that spells
	// its hostname with a capital, and the symptom would be a blank throughput cell that reads
	// as "this node didn't answer".
	const rates = new Map();
	const setRate = (key, rate) => {
		if (key) rates.set(String(key).toLowerCase(), rate);
	};
	if (analytics && analytics.available !== false) {
		if (analytics.byNode) {
			for (const entry of analytics.byNode) {
				const outcomes = (entry.totals ?? []).filter((s) => s.metric === 'render' && s.path === 'outcome');
				const rate = rateOf(outcomes, entry.rangeMs ?? analytics.rangeMs);
				// The node's OWN hostname is the join key QueueStatus rows use; the configured
				// origin's host carries a port and would never match. Both are indexed so a
				// deployment whose origins happen to be bare hostnames still joins.
				setRate(entry.node, rate);
				setRate(entry.hostname, rate);
			}
		} else if (analytics.node) {
			setRate(
				analytics.node,
				rateOf(
					pick(analytics, 'render', (s) => s.path === 'outcome'),
					analytics.rangeMs
				)
			);
		}
	}
	const rateFor = (hostname) => (hostname ? (rates.get(String(hostname).toLowerCase()) ?? null) : null);

	const rows = data.nodes.map((node) =>
		el('tr', null, [
			el('td', { cls: 'mono' }, [node.hostname, node.isThisNode && muted(' (this node)')]),
			el('td', null, [statusPill(node.status)]),
			el('td', {
				cls: 'mono' + (rateFor(node.hostname) ? '' : ' muted'),
				text: rateFor(node.hostname) ?? '—',
			}),
			el('td', null, [node.responding === false ? pill('not responding', 'bad') : nodeAge(node)]),
			el('td', null, [
				node.override
					? node.override.paused
						? pill('override: paused', 'bad')
						: pill('override: force run', 'ok')
					: pill('inherits cluster'),
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
						disabled: ctx.busy,
						onclick: () => setPause(node.hostname, null),
					}),
				]),
			]),
		])
	);

	// A row every peer holds an older copy of means replication is not delivering that node's
	// writes — the one thing this table can see that nothing else can, since it is the only place
	// four copies of the same replicated row are compared side by side. It sits ABOVE the rows it
	// invalidates: the statuses below are read through whichever copy was freshest, and a reader
	// who meets that caveat after the table has already trusted it.
	const diverged = data.nodes.filter((n) => n.behind?.length);

	return el('div', { cls: 'card' }, [
		diverged.length &&
			el('div', { cls: 'card-body' }, [
				el('div', { cls: 'note bad' }, [
					'Replication gap: ' +
						diverged
							.map(
								(n) =>
									`${n.hostname}'s row is ${duration(n.spreadMs)} behind on ${n.behind.map((b) => b.reporter).join(', ')}`
							)
							.join('; ') +
						'. Those nodes are not receiving that node’s writes to render_service — which also carries ' +
						'Target, so URLs it discovers are not reaching them either.',
				]),
			]),
		table(
			['node', 'observed status', 'throughput', 'status since', 'intent', { text: 'actions', right: true }],
			rows,
			'No nodes have reported queue status yet.'
		),
		el('div', { cls: 'card-foot' }, [
			muted(
				'“Status since” is when that node’s queue status last CHANGED — the row is written only on a ' +
					'change, so a steady node showing hours is healthy, not stale. Liveness is the column beside ' +
					'it: whether the node answered this page load. Throughput is each node’s own processed-result ' +
					'rate, and a blank there means that node did not answer, never that it is idle — presenting ' +
					'it as zero would read as "idle".'
			),
		]),
	]);
}

/**
 * Whether every node is running the same options — and, since the override layer, WHY it is not.
 *
 * A prerender cluster runs one component with one set of options, so a difference between nodes
 * has never been a preference. It used to have exactly one cause, a deploy that skipped a node,
 * and that finding is otherwise invisible: the skipped node serves traffic, reports queue status
 * and answers this API, and only its options give it away.
 *
 * THE OVERRIDE LAYER GAVE IT A SECOND, BENIGN CAUSE, and the two must not share a banner. An
 * override commits on one node and reaches the rest by replication, so between the write and every
 * node re-reading the table the cluster genuinely disagrees — for about a second, because of
 * something this console just did. Left unclassified, every edit an operator makes here raises the
 * alarm that means "a deploy did not land", and an alarm that fires on its own console's normal
 * operation stops being read at all.
 */
function divergence(ctx) {
	const state = configState(ctx);
	const payload = state.payload;
	if (!payload) {
		return card('Config agreement', {
			body: [note('bad', [state.error ?? 'The config payload did not load, so nothing here can compare the nodes.'])],
		});
	}

	// Only meaningful once more than one node has been compared. A single-node read has nothing to
	// disagree with, and an "all nodes agree" banner there would be a claim about one node.
	if (!payload.configFrom) {
		return card('Config agreement', {
			body: [
				note('', [
					'This console is reading one node, so there is nothing to compare it against. Switch the scope ' +
						'to all nodes to see whether they agree.',
				]),
			],
		});
	}

	// `values[0]` is the reference node the merge compared against; every entry after it is a node
	// that differs from it. Flipping that into one row per NODE is the whole point of putting this
	// here rather than leaving it as the per-option table on Config: the question this view answers
	// is "which node is wrong", not "which option is".
	const pivot = (overridden) => {
		const out = [];
		for (const entry of payload.divergences ?? []) {
			if (!!entry.overridden !== overridden) continue;
			const [reference, ...others] = entry.values ?? [];
			for (const other of others)
				out.push({ hostname: other.hostname, path: entry.path, value: other.value, reference: reference?.value });
		}
		return out.sort((a, b) => String(a.hostname).localeCompare(String(b.hostname)) || a.path.localeCompare(b.path));
	};

	// The values arrive already JSON-encoded by the merge's flatten, so they are printed as-is —
	// re-encoding here would show a quoted string of a quoted string.
	const rowsFor = (entries) =>
		entries.map((entry) =>
			el('tr', null, [
				el('td', { cls: 'mono', text: entry.hostname }),
				el('td', { cls: 'mono', text: entry.path }),
				el('td', { cls: 'mono', text: String(entry.value ?? '—') }),
				el('td', { cls: 'mono muted', text: String(entry.reference ?? '—') }),
			])
		);

	const headers = ['node', 'option', 'this node', `${payload.configFrom} (reference)`];
	const deploy = pivot(false);
	const converging = pivot(true);

	if (!deploy.length && !converging.length) {
		return card('Config agreement', {
			body: [note('ok', [`All ${payload.sources?.answered ?? 0} nodes report identical effective config.`])],
		});
	}

	return card('Config agreement', {
		head: [
			deploy.length ? pill(`${deploy.length} unexplained`, 'bad') : pill('no deploy gap', 'ok'),
			converging.length ? pill(`${converging.length} converging`, 'info') : null,
			spacer(),
			muted(`compared against ${payload.configFrom}`),
		],
		body: [
			deploy.length
				? [
						note('bad', [
							'These options are not the same on every node. A prerender cluster runs one component ' +
								'with one set of options, so this is a deploy that did not reach every node (or a node ' +
								'that has not restarted into it) — not a configuration choice. Every other panel will ' +
								'keep looking healthy while it is true.',
						]),
						table(headers, rowsFor(deploy)),
					]
				: null,
			converging.length
				? [
						note('info', [
							'An override is in play at these paths, so this is the override layer converging, not a ' +
								'deploy that skipped a node: the write commits on one node and the rows replicate, which ' +
								'normally takes about a second. If it is still here after management.overrides.syncInterval ' +
								'the node is not catching up — it is refusing the override, and that node’s own layers ' +
								'report it as override-rejected.',
						]),
						table(headers, rowsFor(converging)),
					]
				: null,
			payload.divergencesTruncated
				? note('warn', [
						'The list was capped — the nodes differ in more options than are shown, which usually means ' +
							'one is on an entirely different release.',
					])
				: null,
		],
	});
}

/**
 * Whether the override layer is actually REACHING each node. This section is the headline of this
 * view, not a footnote to it.
 *
 * Every other panel about a node can be green while this one is not. A node that has stopped
 * reading the override table keeps serving traffic, keeps reporting queue status, keeps answering
 * this API, and quietly runs the deployed config.yaml while this console lists the overrides it is
 * ignoring — and the apply banner will have said "applied", truthfully, because the row WAS
 * written. Nothing else in this console can see the difference.
 *
 * TWO MECHANISMS, AND ONLY ONE OF THEM IS FATAL WHEN IT DIES. The subscription is the fast path
 * (about a second); `syncInterval` is the backstop re-read that recovers a node whose subscription
 * never established. So an unsubscribed node still converges, just slowly, and says so — but a node
 * whose backstop is erroring converges never. Both are per node AND PER WORKER, so what is reported
 * here is the worker that answered this request, not the node as a whole.
 */
function overrideArrival(ctx) {
	const payload = configState(ctx).payload;
	const overrides = payload?.overrides;
	// Absent on a plugin that predates the override layer. Rendering an empty section there would
	// invent a capability the cluster does not have.
	if (!overrides) return null;

	// Under cluster scope the merge publishes one entry per node; under node scope the plugin
	// answers for itself and names no hostname, so the single row is built from the payload's own
	// identity. Rendering nothing there would read as "no nodes".
	const nodes = Array.isArray(overrides.nodes)
		? overrides.nodes
		: [
				{
					hostname: payload.node ?? 'this node',
					enabled: overrides.enabled ?? null,
					degraded: overrides.degraded ?? null,
					truncated: overrides.truncated ?? null,
					error: overrides.error ?? null,
					rowCount: (overrides.rows ?? []).length,
					watch: overrides.watch ?? null,
				},
			];

	const stalled = nodes.filter((node) => node.watch?.lastError || node.error);
	const unsubscribed = nodes.filter((node) => node.watch && node.watch.subscribed === false && !node.watch.lastError);
	const inert = nodes.filter((node) => node.enabled === false);

	const rows = nodes.map((node) => {
		const watch = node.watch;
		return el('tr', null, [
			el('td', { cls: 'mono', text: node.hostname }),
			el('td', { cls: 'mono', text: num(node.rowCount) }),
			el('td', null, [
				node.enabled === false ? pill('kill switch off — rows stored but inert', 'bad') : pill('honoured', 'ok'),
				node.degraded ? pill('read degraded', 'warn') : null,
				node.truncated ? pill('row list truncated', 'warn') : null,
			]),
			el('td', null, [
				!watch
					? muted('not reported')
					: watch.lastError
						? pill('re-read failing', 'bad')
						: watch.subscribed
							? pill('live', 'ok')
							: pill('backstop only', 'warn'),
				watch?.subscribeError && muted(` ${watch.subscribeError}`),
				node.error && muted(` ${node.error}`),
			]),
			el('td', null, [
				watch?.lastReadAt ? muted(ago(watch.lastReadAt)) : muted('never'),
				watch?.syncInterval ? muted(` · backstop every ${duration(watch.syncInterval)}`) : null,
			]),
		]);
	});

	return card('Override arrival', {
		head: [
			stalled.length ? pill(`${stalled.length} not converging`, 'bad') : null,
			unsubscribed.length ? pill(`${unsubscribed.length} on the backstop`, 'warn') : null,
			spacer(),
			muted('per node and per worker — the worker that answered'),
		],
		body: [
			stalled.length
				? note('bad', [
						el('strong', { text: `${stalled.map((node) => node.hostname).join(', ')} ` }),
						`${stalled.length === 1 ? 'is' : 'are'} no longer reading the override table: ` +
							`${stalled.map((node) => node.watch?.lastError ?? node.error).join('; ')}. ` +
							'Every option applied from this console is being stored and ignored there, and nothing ' +
							'else on this page will show it — that node keeps serving traffic on the deployed ' +
							'config.yaml. Restart its workers to re-arm the read.',
					])
				: null,
			inert.length
				? note('bad', [
						el('code', { text: 'management.overrides.enabled' }),
						` is false on ${inert.map((node) => node.hostname).join(', ')}. It is a FILE option by design — ` +
							'a kill switch reachable through the thing it switches off is not a switch — so those nodes ' +
							'run the deployed config while this console lists rows they will never apply.',
					])
				: null,
			unsubscribed.length
				? note('warn', [
						`${unsubscribed.map((node) => node.hostname).join(', ')} ${unsubscribed.length === 1 ? 'has' : 'have'} ` +
							'no live subscription and depend on the backstop re-read alone. Edits still arrive, within one ' +
							'sync interval instead of about a second — so a value that reads as the old one there is ' +
							'lagging, not lost.',
					])
				: null,
			table(['node', 'override rows', 'layer', 'read', 'last re-read'], rows, 'No node reported override state.'),
		],
		foot: [
			muted(
				'Row counts are what each node has READ, not what is stored: a node mid-convergence is short ' +
					'a row it has not seen yet, which is the same shape as a node that will never see it. The ' +
					'read column is what separates them.'
			),
		],
	});
}

/**
 * Options that CHANGED and are not in force yet, per node.
 *
 * A restart-scoped option is read once at boot. Applying one from this console writes the row,
 * replicates it, and every node's `config` immediately reports the new value — while the running
 * behaviour is still the boot value everywhere. That is the one edit whose "applied" is true and
 * whose effect is absent, and it is per node because a node that has since been restarted has
 * cleared its entry while its peers have not.
 *
 * Silent when nothing is pending: that is the normal state, and a green card for it is noise.
 */
function bootDrift(ctx) {
	const payload = configState(ctx).payload;
	const entries = payload?.pendingRestart ?? [];
	if (!entries.length) return null;

	const rows = entries
		.map((entry) => ({ ...entry, hostname: entry.hostname ?? payload.node ?? 'this node' }))
		.sort((a, b) => String(a.hostname).localeCompare(String(b.hostname)) || String(a.key).localeCompare(String(b.key)))
		.map((entry) =>
			el('tr', null, [
				el('td', { cls: 'mono', text: entry.hostname }),
				el('td', { cls: 'mono', text: entry.key }),
				el('td', { cls: 'mono muted', text: JSON.stringify(entry.bootValue ?? null) }),
				el('td', { cls: 'mono', text: JSON.stringify(entry.value ?? null) }),
			])
		);

	return card('Pending restart', {
		head: [pill(`${rows.length} option${rows.length === 1 ? '' : 's'} awaiting a restart`, 'warn'), spacer()],
		body: [
			note('warn', [
				'These nodes report a new value for an option they only read at boot, so the config on this ' +
					'console and the behaviour on those nodes disagree — deliberately, and until their workers ' +
					'restart. The "running" column is what the traffic is actually being served under.',
			]),
			table(['node', 'option', 'running (boot)', 'configured'], rows),
		],
	});
}
