/**
 * Config: the searchable index of every option the plugin has, and the panels that say whether
 * what it lists is actually in force.
 *
 * WHY AN INDEX RATHER THAN A SETTINGS SCREEN. Options are edited beside the data they govern —
 * `queue.*` under Queue, `sitemap.*` under Sitemaps — because a number is only judgeable next to
 * the thing it moves. What that costs is an operator who knows an option exists and has no idea
 * which of nine views it is on, whose only fallback is a config.yaml in a git checkout on another
 * machine. So this view searches EVERY option, including the ones the domain views own, and says
 * where each one lives. Exhaustive is the whole job: an option this page cannot find is, to an
 * operator working an incident, an option that does not exist.
 *
 * THE PANELS ABOVE THE INDEX COVER THE SILENT HALF. Since the override layer, an option can be
 * stored, replicated, listed here, and still not be running: a value the schema rejects is kept as
 * a row while the cluster keeps the file value, a node whose override subscription has died stops
 * honouring every edit made from this console, and `management.overrides.enabled` false on ONE
 * node makes that node ignore the layer entirely while every node still lists it. None of those
 * move a number anywhere else in this console — nothing goes red, no count changes, and the next
 * operator reads a setting that says one thing while a quarter of the cluster does another. They
 * are on this page, above the options, for that reason.
 *
 * DIVERGENCE STAYS THE HEADLINE, WITH ONE SPLIT. Every node runs the same component with the same
 * options, so nodes disagreeing is a deploy that did not land everywhere — except when it is this
 * console's own write replicating, which makes the cluster disagree about that path for about a
 * second on every single edit. The merge tags which is which (`overridden`); rendering the second
 * in the first's words is how the first stops being read at all.
 *
 * The raw JSON dump this view used to end with is gone. It was one node's merged config with no
 * provenance, and it could not distinguish a default nobody set from a deployed choice from an
 * override the cluster is refusing — three states with three different fixes.
 */

import {
	ago,
	append,
	card,
	el,
	formatValue,
	highlight,
	duration,
	icon,
	ICONS,
	kv,
	link,
	mono,
	muted,
	note,
	num,
	originPill,
	pill,
	spacer,
	table,
} from '../ui.js';
import {
	appliedNote,
	configState,
	editTray,
	loadConfig,
	optionIndex,
	pathsUnder,
	settingsCard,
} from './_configEdit.js';

export const meta = { id: 'config', label: 'Config', crumb: 'config', icon: ICONS.config };

/** The groups no domain view owns: what is prerendered, how it is fetched, and this console. */
const OWN_GROUPS = [
	'domains',
	'ingress',
	'deviceTypes',
	'origin',
	'debugHeader',
	'renderNow',
	'peerRescue',
	'management',
];

/**
 * Where every other top-level group is edited.
 *
 * The labels are duplicated rather than imported from the nine view modules' `meta`: a label that
 * drifts is cosmetic, while the import would make this view depend on every other one. A group in
 * NEITHER list is not lost — `browse` renders it as its own card — so a group added upstream can
 * never become an option the console has no page for.
 */
const ELSEWHERE = {
	cacheKey: { id: 'pages', label: 'Page cache' },
	page: { id: 'pages', label: 'Page cache' },
	invalidation: { id: 'invalidations', label: 'Invalidations' },
	render: { id: 'queue', label: 'Queue & nodes' },
	scan: { id: 'queue', label: 'Queue & nodes' },
	queue: { id: 'queue', label: 'Queue & nodes' },
	sitemap: { id: 'sitemaps', label: 'Sitemaps' },
	analytics: { id: 'traffic', label: 'Traffic' },
	crawlStats: { id: 'traffic', label: 'Traffic' },
};

/** Card titles. The dotted prefix is the fallback, and it is never wrong — only terse. */
const TITLES = {
	domains: 'Indexable domains',
	ingress: 'Request ingestion',
	deviceTypes: 'Device types',
	cacheKey: 'Cache key',
	origin: 'Origin fetch',
	debugHeader: 'Debug headers',
	renderNow: 'On-demand render',
	peerRescue: 'Peer rescue',
	management: 'Management API',
	page: 'Cached-page lifetimes',
	invalidation: 'Invalidation',
	render: 'Render scheduling',
	scan: 'Claim scan',
	sitemap: 'Sitemap ingestion',
	queue: 'Render queue',
	analytics: 'Analytics',
	crawlStats: 'Crawl stats',
};

/**
 * The five questions operators actually arrive with.
 *
 * "Overridden" and "differs from config.yaml" are deliberately different sets. A REJECTED override
 * is a stored row that is NOT in force, so it is loud in the first and correctly absent from the
 * second — which is the whole distinction this view exists to keep visible.
 */
const FILTERS = [
	['all', 'All', () => true],
	['overridden', 'Overridden', (option) => !!option.overridden],
	['differs', 'Differs from config.yaml', (option) => JSON.stringify(option.effective) !== JSON.stringify(option.file)],
	['restart', 'Pending restart', (option, restarting) => restarting.has(option.path)],
	['locked', 'Not editable', (option) => option.uiEditable === false],
];

export async function load(ctx) {
	// ALWAYS force. A domain view may have filled this scratch minutes ago, and the one page that
	// reports whether the cluster agrees with itself must never answer from a cache of its own.
	const [, unroutedRes] = await Promise.all([loadConfig(ctx, { force: true }), ctx.get('unrouted')]);
	// Best-effort: the unrouted tally argues for a routing change, it does not gate the config
	// index. A node that cannot answer it must not take the whole page down with it.
	ctx.data.unrouted = unroutedRes.ok ? unroutedRes.body : null;
}

export function render(ctx) {
	const state = configState(ctx);
	const data = state.payload;
	if (!data) return el('div', { cls: 'note bad', text: state.error ?? 'No config data.' });

	return [
		el('div', { cls: 'view-head' }, [
			el('span', { cls: 'eyebrow', text: 'Config' }),
			el('span', {
				cls: 'muted mono',
				text: data.configFrom
					? `${data.sources?.answered ?? '?'} nodes compared`
					: `${data.node} · worker ${data.workerIndex}`,
			}),
			spacer(),
			el('button', { text: 'Refresh', disabled: ctx.busy, onclick: () => ctx.reload() }),
		]),
		// Above the divergence panel on purpose: right after an apply, the thing the operator is
		// about to read is a cluster that disagrees with itself, and this is the sentence that says
		// why that is expected for the next second.
		appliedNote(ctx),
		divergence(data),
		overrideLayer(data),
		pendingRestart(data),
		warnings(data),
		index(ctx, data),
		editTray(ctx),
	];
}

// ---------------------------------------------------------------- divergence

function divergence(data) {
	// Only meaningful once more than one node has been compared. A single-node read has nothing
	// to disagree with, and an "all nodes agree" banner there would be a claim about one node.
	if (!data.configFrom) return null;
	const rows = data.divergences ?? [];

	if (rows.length === 0) {
		return el('div', {
			cls: 'note ok',
			text: `All ${data.sources?.answered ?? 0} nodes report identical effective config.`,
		});
	}

	// The merge classifies every difference. A path with an override in play is this console's own
	// write replicating; everything else is the original finding, and keeps the original words.
	const deploy = rows.filter((row) => !row.overridden);
	const converging = rows.filter((row) => row.overridden);

	return [
		deploy.length
			? card('Nodes disagree', {
					head: [spacer(), muted(`${deploy.length} option${deploy.length === 1 ? '' : 's'} differ`)],
					body: [
						el('div', { cls: 'note bad' }, [
							'These options are not the same on every node. A prerender cluster runs one component ' +
								'with one set of options, so this is a deploy that did not reach every node (or a node ' +
								'that has not restarted into it) — not a configuration choice. Every other panel will ' +
								'keep looking healthy while it is true.',
						]),
						valueTable(deploy),
					],
				})
			: null,
		converging.length
			? card('An override is still landing', {
					head: [spacer(), muted(`${converging.length} option${converging.length === 1 ? '' : 's'}`)],
					body: [
						el('div', { cls: 'note info' }, [
							'These paths have a stored override in play and at least one node has not read the new row ' +
								'yet. This is NOT the deploy failure above: the rows replicate, so every edit made from ' +
								'this console makes the cluster disagree about that path for about a second. Nothing ' +
								'needs doing — refresh and it is gone. If it is still here, it is not convergence: it is ' +
								'a node REFUSING the override (its layer reads “override REJECTED — not in effect”) or a ' +
								'node whose override watch has stopped. The panel below says which.',
						]),
						valueTable(converging),
					],
				})
			: null,
		data.divergencesTruncated
			? el('div', {
					cls: 'note warn',
					text: 'The list was capped — the nodes differ in more options than are shown, which usually means one is on an entirely different release.',
				})
			: null,
	];
}

/** Path, then one line per node's value. The values are JSON, exactly as the merge compared them. */
const valueTable = (rows) =>
	el('div', { cls: 'scroll' }, [
		el('table', null, [
			el('tbody', null, [
				...rows.map((row) =>
					el('tr', null, [
						el('td', { cls: 'mono', text: row.path }),
						el(
							'td',
							null,
							row.values.map((value) => el('div', { cls: 'mono' }, [muted(`${value.hostname}: `), String(value.value)]))
						),
					])
				),
			]),
		]),
	]);

// ---------------------------------------------------------------- the override layer

/**
 * What is stored, whether it has reached every node, and whether every node is still listening.
 *
 * THE FAILURES HERE ARE NODE-LOCAL AND CANNOT BE AVERAGED. A layer honoured by three nodes out of
 * four is not 75% applied — it is one cluster serving two configurations from behind one CDN, and
 * the node that is ignoring it looks completely healthy from everywhere else. So the kill switch,
 * the dead subscription and the failed read are named per node, with the node's hostname, rather
 * than rolled into one "override health" verdict.
 */
function overrideLayer(data) {
	const overrides = data.overrides;
	if (!overrides) return null; // a plugin from before the override layer

	// Cluster scope reports per node and deliberately omits the scalar `watch` — it would be node
	// one's, and the node whose watch has died is exactly the one that must not be averaged away.
	// Node scope carries the scalars instead, so normalise to the per-node shape and keep one path.
	const compared = Array.isArray(overrides.nodes);
	const nodes = compared
		? overrides.nodes
		: [
				{
					hostname: data.node ?? 'this node',
					enabled: overrides.enabled,
					error: overrides.error,
					rowCount: (overrides.rows ?? []).length,
					watch: overrides.watch ?? null,
				},
			];

	const disabledOn = nodes.filter((node) => node.enabled === false).map((node) => node.hostname);
	// `subscribed: false` or a read error means that node has stopped hearing about edits. It is
	// the failure this panel exists to catch: it produces no error anywhere, and the console goes
	// on listing rows that node is not applying.
	const deaf = nodes.filter((node) => node.watch && (node.watch.subscribed === false || node.watch.lastError));
	const watching = nodes.filter((node) => node.watch?.subscribed).length;
	const watched = nodes.filter((node) => node.watch).length;

	const options = optionIndex(data);
	const rows = (overrides.rows ?? []).map((row) => {
		// The layers come from ONE node (`configFrom`) while the rows are the union across nodes, so
		// a row that has not reached that node yet has no layer to name — which the reach column is
		// already saying. A row with no option at all is different and permanent: an option that was
		// renamed or removed, still stored, doing nothing.
		const option = options.get(row.path);
		return el('tr', null, [
			el('td', { cls: 'mono', text: row.path }),
			el('td', { cls: 'mono', text: formatValue(row.value) }),
			el('td', null, [
				option ? originPill(option.source) : pill('no such option in this release — doing nothing', 'bad'),
			]),
			el(
				'td',
				null,
				!compared
					? [muted('—')]
					: (row.missingOn ?? []).length
						? row.missingOn.map((hostname) => pill(`not on ${hostname} yet`, 'warn'))
						: [muted('every node')]
			),
			el('td', { cls: 'muted mono', text: row.updatedBy ?? '' }),
			el('td', { cls: 'muted mono', text: row.updatedTime ? ago(new Date(row.updatedTime).getTime()) : '—' }),
			el('td', { cls: 'break', text: row.note ?? '' }),
		]);
	});

	return card('Stored overrides', {
		head: [spacer(), muted(`${rows.length} row${rows.length === 1 ? '' : 's'}`)],
		body: [
			disabledOn.length
				? note('bad', [
						el('strong', { text: `The override layer is switched OFF on ${disabledOn.join(', ')}. ` }),
						'Every row below is stored, replicated and listed there — and ignored. That node is running its ' +
							'deployed config.yaml, and an edit made from this console will never reach it. ',
						el('code', { text: 'management.overrides.enabled' }),
						' is a file option on purpose (a kill switch reachable only through the thing it switches off is ' +
							'not a switch), so it cannot be turned back on from here: edit that node’s config.yaml and ' +
							'restart it.',
					])
				: null,
			...deaf.map((node) =>
				note('bad', [
					el('strong', { text: `${node.hostname} has stopped hearing config edits. ` }),
					node.watch.lastError
						? `Its last read of the override table failed (${node.watch.lastError}). `
						: 'Its override subscription is not live. ',
					Number.isFinite(node.watch.syncInterval) && node.watch.syncInterval > 0
						? `A backstop re-read every ${Math.round(node.watch.syncInterval / 1000)}s is the only thing still ` +
							'delivering overrides to it, so an edit takes that long there instead of a second.'
						: 'Nothing else re-reads the table there, so every edit made from this console will miss that node ' +
							'until it restarts.',
					node.watch.lastReadAt ? ` Last read ${ago(node.watch.lastReadAt)}.` : ' It has not read the table yet.',
				])
			),
			overrides.degraded
				? note('warn', [
						el('strong', { text: 'A node could not read the override table. ' }),
						`The read fails open — the deployed config keeps running${overrides.error ? ` (${overrides.error})` : ''} — ` +
							'so the list below may be short. An empty list here is not evidence that nothing is set.',
					])
				: null,
			overrides.truncated
				? note('warn', [
						el('strong', { text: 'More rows than the read cap. ' }),
						'There are only ~130 option paths, so the excess is rows for options that no longer exist — they ' +
							'are inert, but they are also hiding rows that are not.',
					])
				: null,
			table(
				['path', 'value', 'layer', 'reached', 'by', 'when', 'note'],
				rows,
				'No stored overrides — every value comes from the deployed config.yaml or the schema default.'
			),
			watched
				? el('p', {
						cls: 'muted chart-note',
						text:
							`Override watch live on ${watching} of ${watched} node${watched === 1 ? '' : 's'}. ` +
							'A node that is not watching still applies overrides on its backstop re-read; a node that is ' +
							'neither watching nor backstopped applies them only at restart.',
					})
				: null,
		],
	});
}

// ---------------------------------------------------------------- restart & warnings

function pendingRestart(data) {
	const entries = data.pendingRestart ?? [];
	if (!entries.length) return null;

	// Under cluster scope the merge tags each entry with its node, so one option appears once per
	// node that is holding a boot value. Fold them: the option is the finding, the nodes are detail.
	const byKey = new Map();
	for (const entry of entries) {
		const row = byKey.get(entry.key) ?? { key: entry.key, value: entry.value, bootValue: entry.bootValue, nodes: [] };
		if (entry.hostname) row.nodes.push(entry.hostname);
		byKey.set(entry.key, row);
	}

	const rows = [...byKey.values()].map((row) =>
		el('tr', null, [
			el('td', { cls: 'mono', text: row.key }),
			el('td', { cls: 'mono muted', text: formatValue(row.bootValue) }),
			el('td', { cls: 'mono', text: formatValue(row.value) }),
			el('td', { cls: 'muted mono', text: row.nodes.join(', ') || '—' }),
		])
	);

	return card('Changed, but still running the boot value', {
		head: [spacer(), muted(`${byKey.size} option${byKey.size === 1 ? '' : 's'}`)],
		body: [
			note('warn', [
				'These options are read once, at worker boot. The configuration now says the second value; the running ' +
					'code is still doing the first, and will until the worker restarts. The index below shows the new ' +
					'value because that is what is configured — this table is the only thing here that says it is not ' +
					'what is happening.',
			]),
			table(['option', 'running (boot)', 'configured', 'on'], rows),
		],
	});
}

function warnings(data) {
	const rows = (data.warnings ?? []).map((warning) =>
		el('div', { cls: `note ${warning.severity === 'warn' ? 'warn' : 'info'}` }, [
			el('strong', { cls: 'mono', text: `${warning.key}: ` }),
			warning.hostname ? muted(`${warning.hostname} · `) : null,
			warning.message,
		])
	);
	return rows.length ? rows : el('div', { cls: 'note ok', text: 'No configuration warnings.' });
}

// ---------------------------------------------------------------- the index

function index(ctx, data) {
	const state = configState(ctx);
	const options = optionIndex(data);
	const restarting = new Set((data.pendingRestart ?? []).map((entry) => entry.key));
	state.search ??= '';
	state.filter ??= 'all';

	// Filter counts are over the WHOLE catalog, not the current search: "how many options has this
	// deployment actually overridden" is the question, and it is answered by the button label
	// before anything is clicked.
	const catalog = [...options.values()];
	const counts = new Map(
		FILTERS.map(([key, , test]) => [key, catalog.filter((option) => test(option, restarting)).length])
	);

	const summary = el('span', { cls: 'muted mono' });
	const results = el('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px' } });

	const buttons = FILTERS.map(([key, label]) =>
		el('button', {
			cls: 'small',
			text: `${label} (${counts.get(key)})`,
			onclick: () => {
				state.filter = key;
				paint();
			},
		})
	);

	const search = el('input', {
		type: 'text',
		placeholder: 'Find an option — path or description',
		value: state.search,
		oninput: (event) => {
			state.search = event.target.value;
			paint();
		},
	});

	/**
	 * Repaint the results IN PLACE rather than through `ctx.render`. A full render rebuilds `#app`
	 * from nothing, which blurs the field it was typed into — a search box that loses focus after
	 * one character is not a search box. The term and the filter still live in the shared scratch,
	 * so a full render from anywhere else (staging an edit, applying the tray) comes back to the
	 * same result set.
	 */
	function paint() {
		for (const [i, button] of buttons.entries()) {
			button.className = FILTERS[i][0] === state.filter ? 'small primary' : 'small';
		}
		const matched = catalog.filter((option) => matches(option, state.search, state.filter, restarting));
		summary.textContent = finding(state)
			? `${matched.length} of ${catalog.length} options`
			: `${catalog.length} options`;
		results.textContent = '';
		append(results, finding(state) ? found(ctx, data, matched, state.search) : browse(ctx, data, options));
	}
	paint();

	return [
		card('Every option', {
			head: [
				el('div', { cls: 'searchbox', style: { maxWidth: '460px' } }, [icon(ICONS.search), search]),
				spacer(),
				summary,
			],
			body: [
				el('div', { cls: 'toolbar' }, buttons),
				el('p', { cls: 'muted chart-note' }, [
					data.configFrom
						? `Values, layers and provenance are ${data.configFrom}’s — the node the comparison above is against. `
						: 'Values, layers and provenance are this node’s. ',
					'A search or a filter reaches every option, including the ones another view owns; each is labelled ' +
						'with where it lives, and edits made from either place land in one tray and one write.',
				]),
			],
		}),
		results,
	];
}

const finding = (state) => state.search.trim() !== '' || state.filter !== 'all';

function matches(option, search, filter, restarting) {
	const test = FILTERS.find(([key]) => key === filter)?.[2] ?? (() => true);
	if (!test(option, restarting)) return false;
	const needle = search.trim().toLowerCase();
	if (!needle) return true;
	return option.path.toLowerCase().includes(needle) || (option.description ?? '').toLowerCase().includes(needle);
}

/** Top-level groups in schema declaration order — `optionIndex` walks the schema in that order. */
const groupsOf = (paths) => [...new Set([...paths].map((path) => path.split('.')[0]))];

/**
 * A group's own description, first paragraph only. Several of these are multi-paragraph operator
 * documentation, and a card is a place to FIND an option, not to read the manual. An option at the
 * top level (`domains`) has no group description; its own is already on its row.
 */
function blurb(data, prefix) {
	const node = data?.schema?.children?.[prefix];
	if (!node || node.kind !== 'group') return null;
	return String(node.description ?? '').split('\n\n')[0] || null;
}

/**
 * Bot traffic served without prerendering, bucketed by first path segment. Either the CDN is
 * over-forwarding or the route list is incomplete — both are fixed per prefix, which is why the
 * report is bucketed the way a CDN rule or an ingress route is written.
 *
 * IT RENDERS DIRECTLY ABOVE THE `ingress` EDITOR, and that adjacency is the point. This report
 * exists for exactly one purpose: to tell an operator what to add to `ingress.routes`. It used to
 * live on Sitemaps, where it was an orphan — nothing on that page acts on it, and the setting it
 * argues about was in a different tab, behind a YAML file in another repo. Reading a prefix here
 * and adding the route for it is now one screen.
 */
function unroutedCard(ctx) {
	const data = ctx.data.unrouted;
	if (!data) return null;

	const rows = (routeClass) =>
		(data.report?.[routeClass] ?? []).map((row) =>
			el('tr', null, [
				el('td', { cls: 'mono', text: row.bucket }),
				el('td', null, [pill(routeClass, routeClass === 'unclassified' ? 'warn' : '')]),
				el('td', { cls: 'mono right', text: num(row.count) }),
				el('td', {
					cls: 'mono muted truncate',
					style: { maxWidth: '300px' },
					title: row.samplePath,
					text: row.samplePath,
				}),
				el('td', { cls: 'right' }, [
					link('explain →', () => ctx.go('explain', { input: { url: row.samplePath, deviceType: '' }, result: null })),
				]),
			])
		);

	return assembleUnrouted(data, [...rows('unclassified'), ...rows('passthrough')]);
}

// Assembled explicitly so the table sits between head and foot.
function assembleUnrouted(data, all) {
	return el('div', { cls: 'card' }, [
		el('div', { cls: 'card-head' }, [
			el('div', { cls: 'title', text: 'Served without prerendering' }),
			spacer(),
			el('span', {
				cls: 'muted mono',
				text: data.workers
					? `one worker on each of ${data.workers} nodes · since their last flush (every ${duration(data.interval)})`
					: `worker ${data.workerIndex} on ${data.node} · since its last flush (every ${duration(data.interval)})`,
			}),
		]),
		el('div', { cls: 'card-body' }, [
			all.length === 0
				? el('div', {
						cls: 'note ok',
						text: data.workers
							? `No unrouted traffic on the ${data.workers} sampled workers since their last flush.`
							: 'This worker has served nothing unrouted since its last flush.',
					})
				: null,
			el('p', { cls: 'muted', style: { margin: '12px 0 0' } }, [
				'Counters are per-worker and reset on every flush, so this is a SAMPLE — one worker per node, ' +
					'not a cluster total. It answers “is anything hitting a route we don’t classify”, never ' +
					'“how much”. unclassified = the CDN forwarded a path no route declares; passthrough = ' +
					'declared, deliberately proxied live.',
			]),
		]),
		all.length > 0 &&
			table(['path bucket', 'class', { text: 'requests', right: true }, 'sample', { text: '', right: true }], all),
		data.report?.overflowed
			? el('div', { cls: 'card-foot' }, [
					`${num(data.report.overflowed)} request(s) fell outside the bucket cap and are not broken down above.`,
				])
			: null,
	]);
}

/** No search, no filter: the groups this view owns, plus a pointer to where the rest are. */
function browse(ctx, data, options) {
	const owned = new Set(OWN_GROUPS);
	// A group in neither list still gets a card. That is the invariant that keeps this an index: a
	// group added to the schema upstream cannot end up with no page in the console at all.
	const unclaimed = groupsOf(options.keys()).filter((prefix) => !owned.has(prefix) && !ELSEWHERE[prefix]);

	// A group may be preceded by the panel that argues for changing it. `ingress` is the only one so
	// far, and it is the clearest case in the whole config: the unrouted tally is a list of prefixes
	// nobody has written a route for.
	const EVIDENCE = { ingress: unroutedCard };

	return [
		...[...OWN_GROUPS, ...unclaimed].flatMap((prefix) => [
			EVIDENCE[prefix]?.(ctx) ?? null,
			settingsCard(ctx, { title: TITLES[prefix] ?? prefix, prefix, description: blurb(data, prefix) }),
		]),
		elsewhere(ctx, options),
	];
}

/** The groups a domain view owns: named, counted, and one click away. */
function elsewhere(ctx, options) {
	const byView = new Map();
	for (const prefix of groupsOf(options.keys())) {
		const owner = ELSEWHERE[prefix];
		if (!owner) continue;
		const entry = byView.get(owner.id) ?? { label: owner.label, prefixes: [], count: 0 };
		entry.prefixes.push(prefix);
		entry.count += pathsUnder(options, prefix).length;
		byView.set(owner.id, entry);
	}
	if (!byView.size) return null;

	return card('The rest of the configuration', {
		head: [spacer(), muted('searchable from here, edited there')],
		body: [
			el('p', {
				cls: 'muted chart-note',
				text:
					'These options are shown beside the data they govern, which is the only place their numbers mean ' +
					'anything. Search or filter above and they appear here too — this list is just the shortcut.',
			}),
			kv(
				[...byView.entries()].map(([id, entry]) => [
					entry.label,
					[
						mono(entry.prefixes.join(', ')),
						muted(` · ${entry.count} option${entry.count === 1 ? '' : 's'} · `),
						link('open →', () => ctx.go(id)),
					],
				])
			),
		],
	});
}

/**
 * A search or a filter: matching options from EVERY group, each group labelled with the view that
 * owns it. They stay editable here rather than only there — the staged set and the write are
 * shared, so an operator who found two related options in one search applies them together, which
 * is the whole reason that scratch is shared in the first place.
 */
function found(ctx, data, matched, term) {
	if (!matched.length) {
		return note('info', [
			'Nothing matches. Every option belongs to a group — clear the search to browse them, or try a word from ' +
				'the description rather than the path.',
		]);
	}

	const byGroup = new Map();
	for (const option of matched) {
		const prefix = option.path.split('.')[0];
		byGroup.set(prefix, [...(byGroup.get(prefix) ?? []), option.path]);
	}

	const cards = new Map();
	for (const [prefix, paths] of byGroup) {
		const owner = ELSEWHERE[prefix];
		const node = settingsCard(ctx, {
			title: TITLES[prefix] ?? prefix,
			paths,
			description: blurb(data, prefix),
			head: owner ? [pill(`lives on ${owner.label}`, 'info'), link('open →', () => ctx.go(owner.id))] : [],
		});
		if (node) cards.set(prefix, node);
	}

	return [term.trim() ? matchChips(matched, term, cards) : null, ...cards.values()];
}

/**
 * The index proper: one chip per hit, with the term marked where it landed.
 *
 * A hit whose chip shows NO mark matched the description rather than the path, which is worth
 * seeing at a glance — it is the difference between "there are eleven options about leases" and
 * "eleven descriptions mention leases", and it is the fastest way to tell a good search term from
 * a bad one before reading thirty rows.
 */
function matchChips(matched, term, cards) {
	return card('Matches', {
		head: [spacer(), muted(`${matched.length} option${matched.length === 1 ? '' : 's'}`)],
		body: [
			el(
				'div',
				{ cls: 'toolbar' },
				matched.map((option) =>
					el(
						'button',
						{
							cls: 'link',
							title: option.description ?? null,
							onclick: () =>
								cards.get(option.path.split('.')[0])?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
						},
						highlight(option.path, term)
					)
				)
			),
		],
	});
}
