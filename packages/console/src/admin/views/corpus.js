/**
 * Corpus: how big the rendered corpus is, and the three MANUAL passes that repair or trim it.
 *
 * These used to sit on the overview beneath the charts, which is where nobody looked for them. They
 * share one shape — a sweep that walks the keys ONE node owns, has a last-run record, and (for two
 * of them) deletes corpus — so they share a page, and every one of them refuses cluster scope with a
 * button that says so instead of an error banner.
 *
 * NOTHING HERE WALKS THE PLUGIN'S TABLES ON LOAD. The counts come from the background backlog
 * snapshot (`overview`), and each pass's state is an in-memory last-run record.
 *
 * THESE TABLES REPLICATE, so the counts are NOT summed across nodes — every node counts the same
 * corpus. A persistent spread between nodes is therefore not rounding, it is a replication gap, and
 * the tile says so.
 */

import { ago, card, duration, el, ICONS, kv, link, muted, num, pill, spacer, stat, stats } from '../ui.js';
import { isMerged } from '../charts.js';

export const meta = { id: 'corpus', label: 'Corpus', icon: ICONS.pages };

export async function load(ctx) {
	const [res, purgeRes] = await Promise.all([ctx.get('overview'), ctx.get('discovery-purge')]);
	ctx.data.overview = res.ok ? res.body : null;
	ctx.data.purge = purgeRes.ok ? purgeRes.body : null;
	ctx.data.error = res.ok ? null : (res.body?.error ?? `Could not load corpus state (${res.status})`);
}

export function render(ctx) {
	const data = ctx.data.overview;
	if (!data) return el('div', { cls: 'note bad', text: ctx.data.error ?? 'Could not load corpus state.' });

	return [
		counts(ctx, data),
		el('h2', { cls: 'group', text: 'Maintenance' }),
		repair(ctx, data),
		discovered(ctx),
		orphans(ctx, data),
	];
}

// Counts come from the background snapshot, not from a per-load count: a page load costs point
// reads only. Null until the first snapshot has run.
function counts(ctx, data) {
	const tables = data.counts;
	const asOf = data.countsAsOf ? `snapshot ${ago(data.countsAsOf)}` : 'no snapshot yet';
	const value = (count) => (count ? num(count.recordCount) : '—');
	const sub = (count) =>
		count?.divergent
			? `nodes disagree: ${num(count.spread.low)}–${num(count.spread.high)}`
			: count?.estimatedRange
				? `±${num(count.estimatedRange)} · ${asOf}`
				: (count?.error ?? asOf);
	const tip = (count) =>
		count?.divergent
			? 'This table replicates, so every node should count the same rows. A persistent spread is a replication gap.'
			: null;

	return stats([
		stat('Render targets', value(tables?.targets), sub(tables?.targets), {
			warn: !!tables?.targets?.divergent,
			title: tip(tables?.targets),
		}),
		stat('Cached pages', value(tables?.pages), sub(tables?.pages), {
			warn: !!tables?.pages?.divergent,
			title: tip(tables?.pages),
		}),
		stat('Sitemaps', value(tables?.sitemaps), [link('open sitemaps →', () => ctx.go('sitemaps'))]),
		stat(
			'Suppressed',
			tables?.suppressed && !tables.suppressed.error
				? num(tables.suppressed.recordCount) + (tables.suppressed.truncated ? '+' : '')
				: '—',
			'non-indexable verdicts'
		),
	]);
}

/** The per-node refusal every pass on this page shares, stated on the button rather than as an error. */
const nodeOnly = (clusterScope, idle, running, what) =>
	clusterScope ? `${idle} (pick a node)` : running ? `${what} running…` : idle;

// A target whose RenderSchedule row is missing renders nothing, forever, with no error to notice it
// by — so the repair sweep's last result belongs where an operator will see it.
function repair(ctx, data) {
	const info = data.reconcile ?? {};
	const last = info.lastRun;
	const clusterScope = isMerged(data);
	const body = [];

	// ONE node with the sweep off is the finding: each node repairs only the keys it owns, so a
	// single disabled node leaves ~1/N of the corpus with no repair at all.
	if (!info.enabled) {
		body.push(
			el('div', { cls: 'note bad' }, [
				el('code', { text: 'render.reconcile.enabled' }),
				info.disabledOn?.length
					? ` is false on ${info.disabledOn.join(', ')} — targets those nodes own will not be repaired.`
					: ' is false — a target that loses its schedule row stops rendering, silently.',
			])
		);
	}

	if (last?.error) body.push(el('div', { cls: 'note bad', text: `Last sweep failed: ${last.error}` }));
	else if (last) {
		body.push(
			kv([
				[last.nodes > 1 ? `Oldest of ${last.nodes} sweeps` : 'Last sweep', ago(last.finishedAt)],
				['Targets examined', num(last.examined)],
				[last.nodes > 1 ? 'Owned across nodes' : 'Owned by this node', num(last.owned)],
				['Schedule rows restored', last.restored ? pill(num(last.restored), 'warn') : pill('0', 'ok')],
				last.truncated ? ['Truncated', pill('hit the restore cap — more may remain', 'bad')] : null,
			])
		);
	} else body.push(muted('No sweep has run since startup.'));

	return card('Schedule repair', {
		head: [
			info.enabled ? pill(`every ${duration(info.interval)}`, 'ok') : pill('disabled', 'bad'),
			info.running && pill('running now', 'warn'),
			spacer(),
			el('button', {
				text: nodeOnly(clusterScope, 'Run sweep', info.running, 'Sweep'),
				disabled: ctx.busy || info.running || clusterScope,
				title: clusterScope ? 'A sweep covers the keys one node owns. Pick a node to run it there.' : null,
				onclick: () => ctx.run(() => ctx.post('reconcile', {})),
			}),
		],
		help: [
			'Restores the schedule row for any target that lost it. A target and its schedule are two writes in ',
			'two databases, and the schedule is routed to the node that owns the URL, so the pair can end up ',
			'half-written — and a target with no schedule row never renders and reports nothing. Each node ',
			'repairs only the keys it owns, so the cluster figure is the sum of every node’s slice.',
		],
		body,
	});
}

// Targets orphaned by a CACHE-KEY RULE CHANGE: their stored url no longer canonicalizes to the key
// they are filed under, so no request can ever produce it. MANUAL by design — the population is
// created by an operator changing a `cacheKey` option, and this deletes corpus.
function orphans(ctx, data) {
	const info = data.orphanSweep ?? {};
	const last = info.lastRun;
	const clusterScope = isMerged(data);
	const body = [];

	// A node nobody has swept contributes ZERO to every total, indistinguishable from clean.
	if (info.unsweptNodes?.length) {
		body.push(
			el('div', {
				cls: 'note warn',
				text: `Never swept on ${info.unsweptNodes.join(', ')} — the real orphan count is larger than shown.`,
			})
		);
	}

	if (last?.error) body.push(el('div', { cls: 'note bad', text: `Last sweep failed: ${last.error}` }));
	else if (last) {
		const stranded = (last.orphaned ?? 0) - (last.leaseSkipped ?? 0) - (last.deleted ?? 0);
		body.push(
			kv([
				[
					last.nodes > 1 ? `Oldest of ${last.nodes} sweeps` : 'Last sweep',
					`${last.finishedAt ? ago(last.finishedAt) : 'unknown'}${last.dryRun ? ' (dry run)' : ''}`,
				],
				['Targets examined', num(last.examined)],
				[last.nodes > 1 ? 'Owned across nodes' : 'Owned by this node', num(last.owned)],
				['Orphans found', last.orphaned ? pill(num(last.orphaned), 'warn') : pill('0', 'ok')],
				['Deleted', last.dryRun ? muted('none — dry run') : num(last.deleted)],
				// Deferred is not a failure: a key mid-render is skipped and caught next pass.
				last.leaseSkipped ? ['Deferred as in-flight', pill(num(last.leaseSkipped), '')] : null,
				last.truncated
					? ['Truncated', pill(`hit the ${num(info.maxDeletes)} delete cap — ~${num(stranded)} remain`, 'bad')]
					: null,
			])
		);
	} else body.push(muted('No sweep has run since startup — it has no timer.'));

	return card('Key-rule orphans', {
		head: [
			pill('manual'),
			info.running && pill('running now', 'warn'),
			spacer(),
			el('button', {
				text: nodeOnly(clusterScope, 'Dry run', info.running, 'Sweep'),
				disabled: ctx.busy || info.running || clusterScope,
				title: clusterScope ? 'A sweep deletes among the keys one node owns. Pick a node.' : null,
				// Always an explicit dryRun: the button that deletes corpus should not be the default one.
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
		help: [
			'Run after changing a ',
			el('code', { text: 'cacheKey' }),
			' option, dry run first. A target whose stored URL no longer canonicalizes to its key renders ',
			'forever into a key nothing reads. The scan always completes, so the orphan count is the true size ',
			'of the population even when the delete cap stopped the removals. Every node must be swept to cover ',
			'the keyspace.',
		],
		body,
	});
}

/**
 * Targets that entered the corpus from TRAFFIC rather than from a sitemap, and the paced,
 * owner-scoped pass that removes them.
 *
 * GATE BEFORE PURGING: with `discoverTargets` still true on the matched route, crawlers re-mint what
 * the purge removed, so the plugin refuses an ungated prefix (400) and `force` is the override.
 */
function discovered(ctx) {
	const state = ctx.data.purge;
	const clusterScope = isMerged(ctx.data.overview);
	const busy = ctx.busy || !!state?.running;

	// Kept in view scratch so the prefix survives the reload every action triggers.
	const input = el('input', {
		cls: 'mono grow',
		type: 'text',
		value: ctx.data.purgePrefix ?? '',
		placeholder: 'https://www.example.com/catalog/',
	});
	const remember = () => {
		ctx.data.purgePrefix = input.value.trim();
		return ctx.data.purgePrefix;
	};

	// SPARING BOT-VISITED TARGETS IS THE SAFE DEFAULT, so the console defaults it on even though the
	// plugin's own default is off. A stored `demandInterval` is durable evidence of repeat crawler
	// demand; deleting one discards a live, served page only for the crawler to re-mint it.
	ctx.data.purgeSkipVisited ??= true;
	const skipVisited = el('input', {
		type: 'checkbox',
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
					? 'A purge walks the keys one node owns. Pick a node, and run every node to cover the keyspace.'
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
		el('label', { cls: 'check muted' }, [
			skipVisited,
			el('span', {
				text: 'Spare targets the demand ladder promoted (pages bots keep coming back to)',
				title: 'Applies to the census too, so its count matches what the purge would remove.',
			}),
		]),
	];

	if (state?.error) body.push(el('div', { cls: 'note bad', text: `Last pass failed: ${state.error}` }));

	// A DIFFERENT FAILURE FROM `state.error`: the pass decided the storage engine had stopped
	// accepting deletes and stopped itself.
	if (state?.abortedOnErrors) {
		body.push(
			el('div', {
				cls: 'note bad',
				text:
					'The pass stopped itself after many consecutive delete failures — the storage engine refusing, not one ' +
					'bad row. Re-run when the node is quieter, at a lower rate.',
			})
		);
	}

	// The samples, because a delete failure appears in no other surface.
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

	// `startedAt` separates "has run" from "never run": a node that has never run answers
	// `{ running: false }`, and rendering that as zeroes would read as a clean census.
	const totals = state?.totals ?? state;
	if (state?.startedAt) {
		// EVERY WAY A DISCOVERED ROW SURVIVED THE PASS is subtracted, or a completed pass that spared
		// 40% on purpose reads as one that never reached 40%. `unreadable` rows are skipped before
		// anything reads their sitemapUrl, so they never entered `discovered`; they get their own row.
		const accounted =
			(totals.deleted ?? 0) + (totals.leaseSkipped ?? 0) + (totals.visitedSkipped ?? 0) + (totals.errors ?? 0);
		const stranded = (totals.discovered ?? 0) - accounted;
		body.push(
			kv([
				[
					state.ranNodes > 1 ? `Oldest of ${state.ranNodes} passes` : state.running ? 'Started' : 'Last pass',
					`${state.running ? ago(state.startedAt) + ' — still running' : state.finishedAt ? ago(state.finishedAt) : 'unknown'}` +
						`${state.dryRun ? ' (census)' : ''}${state.canceled ? ' · stopped early' : ''}`,
				],
				['Prefix', state.urlPrefix ?? (state.urlPrefixes?.length ? state.urlPrefixes.join(', ') : '—')],
				['Rows examined', num(totals.examined)],
				[state.ranNodes > 1 ? 'Owned across nodes' : 'Owned by this node', num(totals.owned)],
				['Discovered (never in a sitemap)', totals.discovered ? pill(num(totals.discovered), 'warn') : pill('0', 'ok')],
				['Deleted', state.dryRun ? muted('none — census') : num(totals.deleted)],
				totals.leaseSkipped ? ['Deferred as in-flight', pill(num(totals.leaseSkipped), '')] : null,
				// Shown whenever the flag was on, INCLUDING at zero: "spared 0" and "did not check" differ.
				state.skipVisited ? ['Spared as bot-visited', pill(num(totals.visitedSkipped ?? 0), 'ok')] : null,
				totals.unreadable ? ['Unreadable rows stepped over', pill(num(totals.unreadable), 'bad')] : null,
				totals.errors ? ['Failed — left for the next pass', pill(num(totals.errors), 'bad')] : null,
				(state.canceled || state.abortedOnErrors) && stranded > 0
					? ['Not reached', pill(`~${num(stranded)} left under this prefix`, 'warn')]
					: null,
			])
		);
	} else body.push(muted('No purge has run since startup — it has no timer.'));

	if (state?.unrunNodes?.length) {
		body.push(
			el('div', {
				cls: 'note warn',
				text: `Never run on ${state.unrunNodes.join(', ')} — their discovered targets are not counted and still rendering.`,
			})
		);
	}
	if (state?.urlPrefixes?.length > 1) {
		body.push(
			el('div', {
				cls: 'note warn',
				text: 'Nodes last ran different prefixes, so these totals add two populations. Read the per-node figures.',
			})
		);
	}
	// Same class of divergence: nodes applied different DELETE PREDICATES to the same prefix.
	if (state?.ranNodes > 1 && state.skipVisitedOn?.length && state.skipVisitedOn.length < state.ranNodes) {
		body.push(
			el('div', {
				cls: 'note warn',
				text:
					`Only ${state.skipVisitedOn.join(', ')} spared bot-visited targets; the other nodes deleted theirs, so ` +
					'these totals mix two predicates.',
			})
		);
	}

	return card('Discovered targets', {
		head: [
			pill('manual'),
			state?.running &&
				pill(state.runningOn?.length ? `running on ${state.runningOn.join(', ')}` : 'running now', 'warn'),
			// A mixed cluster reads as "deleting" — the true half: some nodes did, and those rows are gone.
			state?.startedAt &&
				(state.skipVisited ? pill('sparing bot-visited', 'ok') : pill('deleting bot-visited', 'warn')),
			spacer(),
			state?.ratePerSecond ? muted(`${num(state.ratePerSecond)}/s`) : null,
		],
		help: [
			'Removes targets that entered the corpus from crawler traffic rather than a sitemap. Gate the route ',
			'first — set ',
			el('code', { text: 'discoverTargets: false' }),
			' on it — or crawlers re-mint what this removes; the plugin refuses an ungated prefix, and always refuses ',
			'a bare origin. A sitemap-declared URL is never touched. ',
			link('See what the gate is holding out →', () => ctx.go('traffic')),
		],
		body,
	});
}
