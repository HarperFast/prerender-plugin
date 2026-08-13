/**
 * Cluster aggregation: fold N nodes' admin payloads into one cluster answer, at read time.
 *
 * WHY THE CONSOLE DOES THIS AND NOT THE PLUGIN. Almost everything interesting in a prerender
 * deployment is node-local by construction — `hdb_analytics` rows are written per node, the
 * backlog snapshot covers only the residency-pinned keys THAT node owns, the claim floor is a
 * node-local shared buffer, and the unrouted tally is per worker. A plugin-side "cluster"
 * endpoint would have to fan out to its peers, which means every prerender node becomes a
 * client of every other prerender node on a path that also serves crawler traffic. The console
 * is already the one component that holds every node's session and talks to all of them, and it
 * runs off the serve path. So the fan-out lives here, and the plugin stays a set of honest
 * per-node endpoints.
 *
 * THREE MERGE CLASSES, and picking the wrong one is how a dashboard lies:
 *
 *   MERGED  — node-local numbers that genuinely add up (analytics, the backlog snapshot, the
 *             unrouted tally). Summed here. This is the only class that produces a number no
 *             single node can report: the true cluster backlog, the true serve rate.
 *   SHARED  — replicated tables every node can answer for identically (pages, sitemaps,
 *             invalidations, the crawl sketches, the static metric catalog). Fanning these out
 *             would multiply load to produce four copies of one answer, so ONE node answers and
 *             the payload says which.
 *   COMPARED — config. Identical by intent, so the interesting content is any DISAGREEMENT: a
 *             component deploy that silently skipped a node shows up here and nowhere else.
 *
 * PARTIAL ANSWERS ARE LABELLED, NEVER SILENTLY SHORT. A sum missing a node is not a smaller
 * number, it is a WRONG number, and it looks exactly like a real decline. Every merged payload
 * carries `sources` — who answered, who didn't, and why — and the UI refuses to present an
 * incomplete sum without saying so.
 *
 * Everything here is pure: `(results) => payload`. No I/O, no Harper globals, so the merge math
 * is unit-tested directly.
 */

/** The scope sentinel the UI sends in place of a node origin. Never a hostname. */
export const CLUSTER = 'cluster';

/**
 * Routes whose numbers are node-local and additive. Everything else in PROXIED_GET reads a
 * replicated table (or is static), so it is answered by ONE node — see SHARED_NOTE.
 */
export const MERGED_GET = Object.freeze(['overview', 'analytics', 'unrouted', 'config']);

/**
 * Why a route is answered by a single node under cluster scope, keyed by route. Shown in the
 * UI so "cluster" never implies a fan-out that didn't happen.
 */
export const SHARED_NOTE = Object.freeze({
	'pages': 'page_cache replicates — any node holds the whole corpus',
	'page-content': 'page_cache replicates — any node holds the whole corpus',
	'sitemaps': 'the sitemaps database replicates',
	'invalidations': 'the invalidation database replicates',
	'crawl-breadth': 'crawl sketches replicate; a read already merges every node’s shard',
	'metrics': 'the metric catalog is static, compiled into the plugin',
});

/**
 * POST routes that act on ONE node's own state and therefore cannot be sent to an arbitrary
 * node. Under cluster scope these are refused with an instruction to pick a node, rather than
 * quietly landing on whichever node happened to be first — "Run repair sweep" hitting one of
 * four nodes while the console says "all nodes" is the kind of thing an operator discovers
 * three incidents later.
 *
 * `queue` is absent on purpose: a control write is replicated intent, and its own `scope` field
 * already says which node(s) it applies to.
 */
export const NODE_LOCAL_POST = Object.freeze({
	'reconcile': 'The repair sweep runs over the keys ONE node owns. Pick a node to sweep it.',
	// Node-scoped for a second reason on top of residency: the in-flight check reads THIS node's
	// lease buffer, so asked of a non-owner it cannot tell an orphan from a key mid-render — and
	// this sweep deletes.
	'sweep-orphans': 'The orphan sweep deletes among the keys ONE node owns. Pick a node to sweep it.',
	'backlog': 'A backlog snapshot covers the keys ONE node owns. Pick a node to recompute it.',
	// `schedule` reads RenderSchedule node-locally (replicateFrom: false, because the table is
	// residency-pinned and a cross-node read has no timeout). Asked of a node that does not own
	// the key it truthfully answers "no row" — which reads as "this URL will never render". The
	// UI never calls it (it is the peer endpoint `explain` uses, and `explain` already proxies
	// to the owner itself); a caller reaching it directly has to name the node they mean.
	'schedule':
		'A schedule row is only readable on the node that owns the key. Pick a node — or use explain, which finds the owner for you.',
});

// ---------------------------------------------------------------- small helpers

const num = (v) => (Number.isFinite(v) ? v : null);
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN);

/** Sum of a field over results, or null when no result carried a finite value. */
function sumOf(items, read) {
	let total = 0;
	let seen = false;
	for (const item of items) {
		const value = finite(read(item));
		if (Number.isFinite(value)) {
			total += value;
			seen = true;
		}
	}
	return seen ? total : null;
}

const maxOf = (items, read) => {
	let best = null;
	for (const item of items) {
		const value = finite(read(item));
		if (Number.isFinite(value) && (best === null || value > best)) best = value;
	}
	return best;
};

const minOf = (items, read) => {
	let best = null;
	for (const item of items) {
		const value = finite(read(item));
		if (Number.isFinite(value) && (best === null || value < best)) best = value;
	}
	return best;
};

/** Element-wise sum of equal-length numeric arrays; shorter arrays contribute what they have. */
function sumArrays(arrays, length) {
	const out = new Array(length).fill(0);
	for (const arr of arrays) {
		if (!Array.isArray(arr)) continue;
		for (let i = 0; i < length && i < arr.length; i++) {
			const value = finite(arr[i]);
			if (Number.isFinite(value)) out[i] += value;
		}
	}
	return out;
}

/**
 * The result whose `read` timestamp is newest. Used wherever every node holds a replicated copy
 * of the same row: they should agree, and when they don't the freshest copy is the one to show.
 */
function freshest(items, read) {
	let best = null;
	let bestAt = -Infinity;
	for (const item of items) {
		const at = finite(read(item));
		if (Number.isFinite(at) && at > bestAt) {
			bestAt = at;
			best = item;
		}
	}
	return best ?? items[0] ?? null;
}

const msOf = (value) => {
	if (value === null || value === undefined) return NaN;
	const n = typeof value === 'number' ? value : Date.parse(value);
	return Number.isFinite(n) ? n : NaN;
};

// ---------------------------------------------------------------- the envelope

/**
 * The provenance block every cluster-scoped response carries. This is the honesty contract:
 * a merged number is only as trustworthy as `complete`, and `nodes[]` says exactly which node
 * failed and how, so a dip in a chart can always be told apart from a node that stopped
 * answering.
 */
export function sourcesOf(results, { mode, scope = 'cluster', extra = null } = {}) {
	const nodes = results.map((r) => ({
		origin: r.origin,
		hostname: r.hostname,
		ok: !!r.ok,
		status: r.status ?? 0,
		error: r.error ?? null,
		ms: Number.isFinite(r.ms) ? r.ms : null,
	}));
	const answered = nodes.filter((n) => n.ok).length;
	return {
		mode,
		scope,
		answered,
		configured: nodes.length,
		complete: answered === nodes.length && answered > 0,
		nodes,
		...(extra ?? {}),
	};
}

/** Everything that answered with a usable body. */
const okBodies = (results) => results.filter((r) => r.ok && r.body && typeof r.body === 'object');

/**
 * The response when nothing answered. A 502 rather than an empty aggregate: zero serves across
 * a cluster that is actually up is the single most dangerous number this console could print.
 */
const allFailed = (results, mode) => ({
	status: 502,
	body: {
		error: 'No prerender node answered.',
		sources: sourcesOf(results, { mode }),
	},
});

// ---------------------------------------------------------------- analytics

const comboKey = (s) => `${s.metric} ${s.path ?? ''} ${s.method ?? ''} ${s.type ?? ''}`;

/**
 * Merge per-node analytics windows into one cluster window.
 *
 * BUCKETS ALIGN BY INDEX, NOT BY TIMESTAMP. Every node derives `bucketMs` deterministically
 * from the same requested range, so bucket *i* means the same elapsed offset everywhere; the
 * nodes' window starts differ only by the few milliseconds between the fan-out's requests
 * (reported as `skewMs`, and always far under a ≥60s bucket). A node that clamped the range
 * differently — a peer running an older plugin, or a smaller `management.analytics.maxRange` —
 * produces a DIFFERENT bucket width, and index alignment would then silently smear two
 * timebases together. Those nodes are dropped from the merge and reported as failed sources
 * with the reason, which is the one outcome an operator can act on.
 *
 * DISTRIBUTIONS ARE COUNT-WEIGHTED AND APPROXIMATE, twice over: once inside each node (merging
 * Harper's per-combo aggregates) and again here. The weight available in the payload is the
 * bucket's `count`, which slightly over-weights buckets containing rows that carried no stats;
 * for value metrics — where a row without a mean is vanishing — the error is negligible. The UI
 * writes "≈" on every merged percentile for exactly this reason. A merged p95 is a trend line,
 * never an SLO.
 */
export function mergeAnalytics(results) {
	const usable = okBodies(results).filter((r) => r.body.available !== false);
	if (!usable.length) {
		// Every node answered "analytics unavailable" (or none answered at all). Pass the first
		// node's explanation through rather than inventing an empty window.
		const explained = okBodies(results)[0];
		if (explained) {
			return {
				status: 200,
				body: { ...explained.body, sources: sourcesOf(results, { mode: 'merged' }) },
			};
		}
		return allFailed(results, 'merged');
	}

	// DOUBLE-COUNT GUARD. When a deployment sets `analytics_replicate: true`, every node's
	// hdb_analytics already holds every node's rows — the plugin says so with `scope: 'cluster'`.
	// Summing would then multiply the whole cluster by N. One node answers instead.
	const replicated = usable.find((r) => r.body.scope === 'cluster');
	if (replicated) {
		return {
			status: 200,
			body: {
				...replicated.body,
				sources: sourcesOf(results, {
					mode: 'shared',
					extra: {
						servedBy: replicated.hostname,
						note: 'analytics_replicate is on — each node’s table already holds the whole cluster, so summing would multiply it.',
					},
				}),
			},
		};
	}

	// Group by bucket width; the largest group wins and the rest are reported as mismatched.
	const byWidth = new Map();
	for (const r of usable) {
		const width = finite(r.body.bucketMs);
		const key = Number.isFinite(width) ? width : 'invalid';
		byWidth.set(key, [...(byWidth.get(key) ?? []), r]);
	}
	let merged = usable;
	let mismatched = [];
	if (byWidth.size > 1) {
		const groups = [...byWidth.entries()].sort((a, b) => b[1].length - a[1].length);
		merged = groups[0][1];
		mismatched = groups.slice(1).flatMap(([, group]) => group);
	}

	const canonical = merged[0].body;
	const bucketMs = canonical.bucketMs;
	const bucketCount = Math.max(...merged.map((r) => finite(r.body.bucketCount) || 0), 1);

	// One accumulator per (metric, path, method, type) combo.
	const combos = new Map();
	for (const r of merged) {
		for (const s of r.body.series ?? []) {
			const key = comboKey(s);
			let acc = combos.get(key);
			if (!acc) {
				acc = {
					metric: s.metric,
					path: s.path ?? null,
					method: s.method ?? null,
					type: s.type ?? null,
					count: 0,
					total: 0,
					counts: new Array(bucketCount).fill(0),
					value: false,
					meanSum: 0,
					medianSum: 0,
					p95Sum: 0,
					statWeight: 0,
					meanSums: new Array(bucketCount).fill(0),
					p95Sums: new Array(bucketCount).fill(0),
					statWeights: new Array(bucketCount).fill(0),
				};
				combos.set(key, acc);
			}

			const count = finite(s.count) || 0;
			acc.count += count;
			acc.total += finite(s.total) || 0;
			const counts = Array.isArray(s.counts) ? s.counts : [];
			for (let i = 0; i < bucketCount && i < counts.length; i++) {
				const c = finite(counts[i]);
				if (Number.isFinite(c)) acc.counts[i] += c;
			}

			// A series is a distribution if the node sent one. Weight by the node's own count.
			const mean = finite(s.mean);
			if (Number.isFinite(mean) && count > 0) {
				acc.value = true;
				acc.meanSum += mean * count;
				acc.statWeight += count;
				const median = finite(s.median);
				if (Number.isFinite(median)) acc.medianSum += median * count;
				const p95 = finite(s.p95);
				if (Number.isFinite(p95)) acc.p95Sum += p95 * count;
			}
			if (Array.isArray(s.means)) {
				acc.value = true;
				for (let i = 0; i < bucketCount && i < s.means.length; i++) {
					const weight = finite(counts[i]);
					const m = finite(s.means[i]);
					if (Number.isFinite(m) && Number.isFinite(weight) && weight > 0) {
						acc.meanSums[i] += m * weight;
						acc.statWeights[i] += weight;
						const p = finite(s.p95s?.[i]);
						if (Number.isFinite(p)) acc.p95Sums[i] += p * weight;
					}
				}
			}
		}
	}

	const series = [...combos.values()].map((acc) => {
		const out = {
			metric: acc.metric,
			path: acc.path,
			method: acc.method,
			type: acc.type,
			count: acc.count,
			total: acc.total,
			counts: acc.counts,
		};
		if (acc.value && acc.statWeight > 0) {
			out.mean = acc.meanSum / acc.statWeight;
			out.median = acc.medianSum / acc.statWeight;
			out.p95 = acc.p95Sum / acc.statWeight;
			out.means = acc.statWeights.map((w, i) => (w > 0 ? acc.meanSums[i] / w : null));
			out.p95s = acc.statWeights.map((w, i) => (w > 0 ? acc.p95Sums[i] / w : null));
		}
		return out;
	});
	series.sort((a, b) => b.count - a.count || a.metric.localeCompare(b.metric));

	// Per-node totals WITHOUT buckets: enough for the node table's throughput column (which
	// otherwise has to print "—" for every node but one) at a few hundred bytes per node,
	// instead of shipping four full bucketed payloads.
	const byNode = merged.map((r) => ({
		origin: r.origin,
		hostname: r.hostname,
		// The node's OWN `server.hostname`, which is the key QueueStatus rows use. `hostname`
		// above is the configured origin's host and carries the port, so it does not join
		// against the node table — this is the field that does.
		node: r.body.node ?? null,
		rangeMs: r.body.rangeMs ?? null,
		truncated: !!r.body.truncated,
		scan: r.body.scan ?? null,
		totals: (r.body.series ?? []).map((s) => ({
			metric: s.metric,
			path: s.path ?? null,
			method: s.method ?? null,
			type: s.type ?? null,
			count: finite(s.count) || 0,
		})),
	}));

	// Config that should be identical across nodes; a disagreement changes what the reference
	// bands on the charts mean, so it is flagged rather than quietly taken from node one.
	const intervalsJson = merged.map((r) => JSON.stringify(r.body.intervals ?? null));
	const intervalsDiverge = new Set(intervalsJson).size > 1;

	const truncated = merged.some((r) => r.body.truncated);
	const startMs = minOf(merged, (r) => r.body.startMs);
	const skewMs = (maxOf(merged, (r) => r.body.startMs) ?? 0) - (startMs ?? 0);

	const failedForMerge = [
		...results.filter((r) => !r.ok),
		...mismatched.map((r) => ({
			...r,
			ok: false,
			error: `bucket width ${r.body.bucketMs}ms ≠ ${bucketMs}ms (different analytics range clamp) — excluded from the merge`,
		})),
	];
	const sourceRows = [...merged.map((r) => ({ ...r, ok: true })), ...failedForMerge];

	return {
		status: 200,
		body: {
			available: true,
			scope: 'cluster',
			node: null,
			workerIndex: null,
			rangeMs: canonical.rangeMs,
			startMs,
			endMs: maxOf(merged, (r) => r.body.endMs),
			bucketMs,
			bucketCount,
			// The COVERED window is the intersection, not the union: a number summed across
			// nodes is only honest over the span every contributing node actually reached.
			coveredFromMs: truncated ? maxOf(merged, (r) => r.body.coveredFromMs) : startMs,
			coveredToMs: truncated ? minOf(merged, (r) => r.body.coveredToMs) : maxOf(merged, (r) => r.body.endMs),
			truncated,
			skewMs,
			intervals: canonical.intervals ?? null,
			intervalsDiverge,
			scan: {
				scans: merged.length,
				ms: maxOf(merged, (r) => r.body.scan?.ms) ?? 0,
				scanned: sumOf(merged, (r) => r.body.scan?.scanned) ?? 0,
				kept: sumOf(merged, (r) => r.body.scan?.kept) ?? 0,
				cap: sumOf(merged, (r) => r.body.scan?.cap) ?? 0,
			},
			// The stalest cache in the merge bounds how fresh the whole window is.
			cacheAgeMs: maxOf(merged, (r) => r.body.cacheAgeMs),
			series,
			byNode,
			sources: sourcesOf(sourceRows, { mode: 'merged' }),
		},
	};
}

// ---------------------------------------------------------------- overview

/**
 * Merge per-node overviews.
 *
 * The headline is `backlog`: each node's snapshot covers only the RenderSchedule keys it owns
 * (the table is residency-pinned, and a node cannot read another node's rows without an
 * unbounded replication fetch), so summing the per-node snapshots is the ONLY way to see the
 * cluster's real render backlog. No single node can report it, and until now the console
 * couldn't either — an operator had to open four consoles and add up the tiles.
 *
 * The table COUNTS are the opposite case and must not be summed: `Target`, `PrerenderedPage`
 * and `Sitemap` all replicate, so every node counts the same corpus. They are taken from the
 * freshest snapshot and checked for disagreement — which is itself a finding, since a
 * persistent spread between nodes means replication has a gap.
 */
export function mergeOverview(results) {
	const usable = okBodies(results);
	if (!usable.length) return allFailed(results, 'merged');

	const bodies = usable.map((r) => ({ ...r, b: r.body }));

	// ---- nodes: QueueStatus replicates, so every node sees every node. Merge by hostname and
	// keep the freshest row for each — a node whose own replication is lagging shouldn't be the
	// one deciding what a peer's status is.
	const byHost = new Map();
	for (const { b } of bodies) {
		for (const node of b.nodes ?? []) {
			const existing = byHost.get(node.hostname);
			const at = msOf(node.updatedTime);
			if (!existing || !(msOf(existing.updatedTime) >= at)) {
				// `isThisNode` is meaningless in a cluster view — there is no "this node".
				byHost.set(node.hostname, { ...node, isThisNode: false });
			}
		}
	}
	const nodes = [...byHost.values()].sort((a, b) => String(a.hostname).localeCompare(String(b.hostname)));

	// ---- table counts: replicated, so compare rather than add.
	const freshestCounts = freshest(bodies, (r) => msOf(r.b.countsAsOf));
	const counts = mergeCounts(bodies, freshestCounts?.b?.counts ?? null);

	// ---- backlog: node-local slices of one cluster-wide queue. SUM.
	const runs = bodies.map((r) => r.b.backlog?.lastRun).filter(Boolean);
	const bucketLength = Math.max(0, ...runs.map((run) => (Array.isArray(run.buckets) ? run.buckets.length : 0)));
	const summedBuckets = sumArrays(
		runs.map((run) => (run.buckets ?? []).map((bucket) => bucket.count)),
		bucketLength
	).map((count, hour) => ({ hour, count }));

	const backlogRun = runs.length
		? {
				overdue: sumOf(runs, (run) => run.overdue),
				inFlight: sumOf(runs, (run) => run.inFlight),
				belowFloor: sumOf(runs, (run) => run.belowFloor),
				// The OLDEST row below any node's floor: the worst case is the one to act on.
				oldestBelowFloorMs: minOf(runs, (run) => run.oldestBelowFloorMs),
				buckets: summedBuckets,
				scanned: sumOf(runs, (run) => run.scanned),
				cap: sumOf(runs, (run) => run.cap),
				truncated: runs.some((run) => run.truncated),
				horizonMs: runs[0]?.horizonMs ?? null,
				// A sum is only as fresh as its STALEST input — and only as complete as its
				// narrowest, so a node with no snapshot yet is named rather than counted as zero.
				finishedAt: minOf(runs, (run) => msOf(run.finishedAt)),
				startedAt: minOf(runs, (run) => msOf(run.startedAt)),
				counts,
				error: runs.find((run) => run.error)?.error ?? null,
				nodes: runs.length,
				missing: bodies.filter((r) => !r.b.backlog?.lastRun).map((r) => r.hostname),
			}
		: null;

	// ---- claim floor: per node, and the cluster's health is the WORST node's.
	const floors = bodies
		.map((r) => ({ hostname: r.hostname, ...(r.b.claimFloor ?? {}) }))
		.filter((f) => f && Object.keys(f).length > 1);
	const worst = floors.reduce(
		(acc, f) => (acc === null || (finite(f.lagMs) || -1) > (finite(acc.lagMs) || -1) ? f : acc),
		null
	);
	const claimFloor = floors.length
		? {
				...(worst ?? {}),
				// In-flight leases ADD across nodes — this is the cluster's live render concurrency.
				occupancy: sumOf(floors, (f) => f.occupancy),
				lagMs: maxOf(floors, (f) => f.lagMs),
				worstNode: worst?.hostname ?? null,
				enabled: floors.some((f) => f.enabled !== false),
				disabledOn: floors.filter((f) => f.enabled === false).map((f) => f.hostname),
				byNode: floors.map((f) => ({
					hostname: f.hostname,
					enabled: f.enabled !== false,
					lagMs: num(finite(f.lagMs)),
					occupancy: num(finite(f.occupancy)),
					floorHeldBy: f.floorHeldBy ?? null,
					floorPinnedForMs: num(finite(f.floorPinnedForMs)),
				})),
			}
		: null;

	// ---- reconcile: per-node sweeps over each node's own keys. Sum the work, and name any
	// node where the sweep is OFF — one node with reconcile disabled is a silent hole in the
	// corpus, and a cluster view that reported "enabled" because three nodes were would hide it.
	const reconciles = bodies.map((r) => ({ hostname: r.hostname, ...(r.b.reconcile ?? {}) }));
	const sweeps = reconciles.map((r) => r.lastRun).filter(Boolean);
	const reconcile = {
		enabled: reconciles.every((r) => r.enabled !== false),
		disabledOn: reconciles.filter((r) => r.enabled === false).map((r) => r.hostname),
		interval: reconciles.find((r) => Number.isFinite(r.interval))?.interval ?? null,
		running: reconciles.some((r) => r.running),
		lastRun: sweeps.length
			? {
					examined: sumOf(sweeps, (s) => s.examined),
					owned: sumOf(sweeps, (s) => s.owned),
					restored: sumOf(sweeps, (s) => s.restored),
					truncated: sweeps.some((s) => s.truncated),
					finishedAt: minOf(sweeps, (s) => msOf(s.finishedAt)),
					error: sweeps.find((s) => s.error)?.error ?? null,
					nodes: sweeps.length,
				}
			: null,
	};

	const controlRows = bodies.map((r) => r.b.control?.cluster).filter(Boolean);
	const intervalsJson = bodies.map((r) => JSON.stringify(r.b.intervals ?? null));

	return {
		status: 200,
		body: {
			// The aggregate is as of its oldest constituent, not its newest.
			generatedAt: minOf(bodies, (r) => r.b.generatedAt),
			node: null,
			workerIndex: null,
			scope: 'cluster',
			localQueueStatus: null,
			queueStatusByNode: Object.fromEntries(bodies.map((r) => [r.hostname, r.b.localQueueStatus ?? null])),
			control: {
				cluster: freshest(controlRows, (row) => msOf(row.updatedTime)) ?? null,
				knownScopes: [...new Set(bodies.flatMap((r) => r.b.control?.knownScopes ?? []))],
			},
			nodes,
			counts,
			countsAsOf: freshestCounts?.b?.countsAsOf ?? null,
			backlog: {
				enabled: bodies.some((r) => r.b.backlog?.enabled),
				disabledOn: bodies.filter((r) => r.b.backlog?.enabled === false).map((r) => r.hostname),
				interval: bodies.find((r) => Number.isFinite(r.b.backlog?.interval))?.b.backlog.interval ?? null,
				running: bodies.some((r) => r.b.backlog?.running),
				lastRun: backlogRun,
			},
			intervals: bodies[0].b.intervals ?? null,
			intervalsDiverge: new Set(intervalsJson).size > 1,
			claimFloor,
			reconcile,
			sources: sourcesOf(results, { mode: 'merged' }),
		},
	};
}

/**
 * Table counts across nodes. Every counted table replicates, so the nodes should agree;
 * `divergent` marks the ones that don't. A count is an estimate on a large table, so the
 * threshold is generous — this is looking for a replication GAP, not for jitter.
 */
const DIVERGENCE_THRESHOLD = 0.02;

function mergeCounts(bodies, representative) {
	if (!representative) return null;
	const out = {};
	for (const [table, value] of Object.entries(representative)) {
		const observed = bodies
			.map((r) => ({ hostname: r.hostname, count: finite(r.b.counts?.[table]?.recordCount) }))
			.filter((o) => Number.isFinite(o.count));
		const high = Math.max(...observed.map((o) => o.count), 0);
		const low = observed.length ? Math.min(...observed.map((o) => o.count)) : 0;
		const divergent = observed.length > 1 && high > 0 && (high - low) / high > DIVERGENCE_THRESHOLD;
		out[table] = {
			...value,
			divergent,
			...(divergent ? { spread: { low, high, byNode: observed } } : {}),
		};
	}
	return out;
}

// ---------------------------------------------------------------- unrouted

/**
 * The unrouted tally, summed across nodes.
 *
 * It stays labelled `perWorker` because it still is: each node answers from ONE worker's
 * in-process counters, so the cluster sum is a sum of N single-worker slices, not the cluster's
 * traffic. That understatement is why the panel exists at all (it answers "is anything hitting
 * a route we don't classify", not "how much"), and the payload keeps saying so.
 */
export function mergeUnrouted(results) {
	const usable = okBodies(results);
	if (!usable.length) return allFailed(results, 'merged');

	const classes = new Set();
	for (const r of usable) {
		for (const key of Object.keys(r.body.report ?? {})) {
			if (Array.isArray(r.body.report[key])) classes.add(key);
		}
	}

	const report = { overflowed: usable.some((r) => r.body.report?.overflowed) };
	for (const routeClass of classes) {
		const merged = new Map();
		for (const r of usable) {
			for (const row of r.body.report?.[routeClass] ?? []) {
				const existing = merged.get(row.bucket);
				if (existing) existing.count += finite(row.count) || 0;
				else merged.set(row.bucket, { bucket: row.bucket, count: finite(row.count) || 0, samplePath: row.samplePath });
			}
		}
		report[routeClass] = [...merged.values()].sort((a, b) => b.count - a.count);
	}

	return {
		status: 200,
		body: {
			node: null,
			workerIndex: null,
			scope: 'cluster',
			perWorker: true,
			workers: usable.length,
			interval: usable[0].body.interval ?? null,
			report,
			sources: sourcesOf(results, { mode: 'merged' }),
		},
	};
}

// ---------------------------------------------------------------- config

/** Bound on the reported divergence list — a truly divergent pair would otherwise be huge. */
const MAX_DIVERGENCES = 60;

/**
 * Flatten an object to dotted leaf paths. Arrays are leaves (order matters and an element-wise
 * diff of, say, a route list is noise, not a finding).
 */
function flatten(value, prefix = '', out = new Map()) {
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, out);
	} else {
		out.set(prefix, JSON.stringify(value ?? null));
	}
	return out;
}

/**
 * Compare each node's effective config against the first node's.
 *
 * THIS IS THE ONE PLACE A HALF-APPLIED DEPLOY IS VISIBLE. A component deploy that restarts
 * three nodes and silently skips the fourth leaves a cluster running two versions of its own
 * configuration, and every other panel keeps looking healthy — the skipped node serves traffic,
 * reports queue status, and answers this API. The only symptom is that its options differ.
 */
export function mergeConfig(results) {
	const usable = okBodies(results);
	if (!usable.length) return allFailed(results, 'compared');

	const reference = usable[0];
	const referenceFlat = flatten(reference.body.config ?? {});

	const divergences = [];
	let truncated = false;
	for (const r of usable.slice(1)) {
		const flat = flatten(r.body.config ?? {});
		const paths = new Set([...referenceFlat.keys(), ...flat.keys()]);
		for (const path of paths) {
			if (referenceFlat.get(path) === flat.get(path)) continue;
			if (divergences.length >= MAX_DIVERGENCES) {
				truncated = true;
				break;
			}
			let entry = divergences.find((d) => d.path === path);
			if (!entry) {
				entry = { path, values: [{ hostname: reference.hostname, value: referenceFlat.get(path) ?? null }] };
				divergences.push(entry);
			}
			entry.values.push({ hostname: r.hostname, value: flat.get(path) ?? null });
		}
	}

	const tagged = (key) => usable.flatMap((r) => (r.body[key] ?? []).map((item) => ({ ...item, hostname: r.hostname })));

	return {
		status: 200,
		body: {
			...reference.body,
			scope: 'cluster',
			node: null,
			workerIndex: null,
			// The reference node's own config, named — the pre view is one node's truth, and
			// pretending it is "the cluster's config" is exactly what divergence disproves.
			configFrom: reference.hostname,
			divergences,
			divergencesTruncated: truncated,
			warnings: tagged('warnings'),
			pendingRestart: tagged('pendingRestart'),
			sources: sourcesOf(results, { mode: 'compared' }),
		},
	};
}

// ---------------------------------------------------------------- dispatch

const MERGERS = {
	overview: mergeOverview,
	analytics: mergeAnalytics,
	unrouted: mergeUnrouted,
	config: mergeConfig,
};

export const mergerFor = (route) => MERGERS[route] ?? null;
