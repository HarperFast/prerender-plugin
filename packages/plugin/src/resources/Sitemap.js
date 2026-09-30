import { config, onConfigApplied } from '../config.js';
import { metrics } from '../metrics.js';
import { describeError } from '../util/errors.js';
import { Target } from './Target.js';
import { classifyUrl, PASSTHROUGH, PRERENDER, UNCLASSIFIED } from '../util/routeClass.js';
import {
	currentMinuteMs,
	dateColumnMs,
	epochMsOf,
	getInitialRenderTime,
	getNextSitemapRefreshTime,
	numberOf,
} from '../util/time.js';
import { parseSitemap, partitionSitemapEntries, routeKey } from '../util/sitemap.js';
import { actionForExisting, canSkipLookup, createRefreshRun, TargetAction } from '../util/sitemapRun.js';
import { configuredStagingIp, dispatcherFor } from '../util/upstream.js';
import { setImmediate } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { applyInBatches, collectFromScan } from '../util/scan.js';
import { conditionalValidatorFor } from '../util/sitemapConditional.js';
import {
	decideDeparture,
	DepartureAction,
	departureCandidateCap,
	departureActionFor,
	departureLimit,
	droppedChildRefusal,
	indexShrinkRefusal,
	shrinkRefusal,
	shrinkReleaseLimit,
} from '../util/sitemapDeparture.js';
import {
	arrivalActionFor,
	arrivalCandidateCap,
	decideArrival,
	isFirstListing,
	isRejoin,
} from '../util/sitemapArrival.js';
import { cacheKeysOf } from './Target.js';
import { fileDueNow } from '../util/renderSchedule.js';
import { resolveEffectiveInterval } from '../util/routeClass.js';
import { runDetached } from '../util/detach.js';
import { demandOf } from '../util/demand.js';
import { isGoneSuppressed } from '../util/suppression.js';

/**
 * Log what a sitemap contributed vs. what was dropped. A large filtered share almost always
 * means `ingress.routes` is incomplete rather than that the sitemap is wrong — a silent filter
 * would look identical to a healthy refresh while quietly removing most of the render coverage,
 * so past the configured share this is an error, not an info line.
 */
function reportFiltered(sitemapUrl, filtered, totalEntries) {
	const total = filtered[PASSTHROUGH] + filtered[UNCLASSIFIED];
	if (total === 0) return;

	const percent = totalEntries > 0 ? Math.round((total / totalEntries) * 100) : 0;
	const summary =
		`${sitemapUrl}: ${total}/${totalEntries} entries (${percent}%) are not prerender routes and were ` +
		`not scheduled — passthrough ${filtered[PASSTHROUGH]}, unclassified ${filtered[UNCLASSIFIED]}`;

	if (percent >= config.sitemap.filteredWarnPercent) {
		logger.error(
			`[prerender] ${summary}. That is most of the sitemap: check ingress.routes for missing or ` +
				`mis-ordered routes before assuming the sitemap is at fault.`
		);
	} else {
		logger.info(`[prerender] ${summary}`);
	}
}

const {
	page_cache: { PrerenderedPage },
} = databases;

// The raw table, for the one delete that must NOT cascade: a child sitemap the index stopped listing
// loses its row once its targets have been unlinked. `Sitemap.delete` (the resource below) would take
// every target attributed to it — the URLs that moved to other children included.
const SitemapTable = databases.sitemaps.Sitemap;

/**
 * Entries a URLSET row keeps. The row used to store every `<url>` it listed — about 6 MB on a
 * 50,000-entry product child — rewritten and replicated to every node on each pass that changed it
 * (at least 100 MB a day on one deployment), for a list nothing reads back: the walk re-parses the
 * document, and the console's detail view shows a page of 50 at a time. A leading sample keeps that
 * view useful and `entryCount` keeps the true size. An INDEX keeps its whole list: it is small by
 * construction, and a 304 on an index is descended from it.
 */
const STORED_ENTRY_SAMPLE = 500;

/** Redirect hops one sitemap fetch follows, each one re-deciding the bypass token (`fetchLatestSitemap`). */
const MAX_SITEMAP_REDIRECTS = 5;

class Sitemap extends databases.sitemaps.Sitemap {
	static directURLMapping = true;

	/**
	 * Walk a sitemap (or sitemap index) and reconcile it into Targets (one per URL).
	 *
	 * `onProgress` is invoked after every document with the run's current snapshot, so a caller
	 * running this in the background can persist where it got to. It is awaited but never
	 * allowed to fail the walk.
	 */
	static async refresh(rootSitemapUrl, { revalidate = false, onProgress } = {}) {
		// Zero unless the departure check is on AND some route opts in; Infinity when
		// `maxCandidates` is -1. See util/sitemapDeparture.js.
		const departureCap = departureCandidateCap();
		// The same for rejoins, off `sitemap.arrival`. See util/sitemapArrival.js.
		const arrivalCap = arrivalCandidateCap();
		const run = createRefreshRun({
			removedSampleCap: config.sitemap.removedSampleCap,
			failedCap: config.sitemap.failedCap,
			departureCap,
			arrivalCap,
			// An arrival-only deployment still holds what the walk unlinks, bounded like departures: a
			// URL a failed child leaves unlinked is otherwise re-attached by the NEXT walk carrying an
			// earlier walk's stamp, and read there as a rejoin (see `relinkHeld`).
			holdCap:
				departureCap > 0 ? departureCap : arrivalCap > 0 ? departureLimit(config.sitemap.departure.maxCandidates) : 0,
		});
		const visited = new Set();
		// Children an index stopped listing, found as each index is processed and pruned once the walk
		// is over (`pruneDroppedChildren`) — by then every child still listed has re-attached what moved.
		const dropped = new Map();
		const queue = [{ url: rootSitemapUrl, parentUrl: null }];
		run.count('sitemapsDiscovered');

		while (queue.length) {
			const { url: sitemapUrl, parentUrl } = queue.shift();

			if (visited.has(sitemapUrl)) continue;
			visited.add(sitemapUrl);
			run.noteParent(sitemapUrl, parentUrl);

			try {
				const children = await refreshOneSitemap(sitemapUrl, {
					parentUrl,
					revalidate,
					run,
					visited,
					rootSitemapUrl,
					dropped,
				});
				for (const child of children) {
					queue.push({ url: child, parentUrl: sitemapUrl });
					run.count('sitemapsDiscovered');
				}
			} catch (e) {
				// A failing ROOT means the operator's own action was invalid (a bad URL, a 403 from
				// the edge, an HTML error page where XML was expected) and nothing was accomplished,
				// so it propagates — the same "fail loudly rather than report created: 0" property
				// `fetchLatestSitemap` was written for.
				//
				// A failing CHILD is one branch of a fan-out that is routinely tens of documents
				// wide. Aborting the whole walk over one of them used to throw away every remaining
				// child, which at index scale means abandoning hundreds of thousands of URLs because
				// a single sitemap 503'd. Record it and keep going; `failed` reports it.
				if (sitemapUrl === rootSitemapUrl) throw e;

				logger.error(`[prerender] Sitemap ${sitemapUrl} failed and was skipped: ${describeError(e)}`);
				run.addFailure(sitemapUrl, e, { parentUrl });
			}

			// Counts attempts, failures included: this is what a caller watches against
			// `sitemapsDiscovered` to see progress, and a walk with a failed child must still be
			// able to reach its total rather than appearing to stall forever.
			run.count('sitemapsProcessed');

			try {
				await onProgress?.(run.snapshot());
			} catch (e) {
				logger.warn(`[prerender] Sitemap progress callback failed: ${describeError(e)}`);
			}
		}

		// A child the index stopped listing is pruned as an empty urlset, AFTER every child still listed,
		// so the URLs that merely moved to one of them are re-attached first and only what is listed
		// nowhere departs. The index that dropped it already passed the shrink guard (`refreshOneSitemap`).
		// Its row goes only after the departure step (below).
		const prunedChildren = await pruneDroppedChildren(run, dropped, visited);

		// A URL the owning child dropped may still be listed by a child the origin answered 304 to,
		// whose entries this walk never read. Re-attached to it before anything reads it as departed.
		try {
			await reattachToUnchangedListers(run, rootSitemapUrl);
		} catch (e) {
			logger.error(`[prerender] Unchanged-lister check for ${rootSitemapUrl} failed: ${describeError(e)}`);
			run.addFailure(rootSitemapUrl, e);
		}

		// AFTER every child, so a URL that merely shifted to a later child of a paginated index has
		// had its chance to be re-attached. See util/sitemapDeparture.js.
		//
		// Guarded: the departure check is an addition to the walk, not the walk. A failure here must
		// not turn a refresh that correctly ingested a million URLs into a failed run — the walk's
		// own result is already committed by this point, and the outcome tally reports what happened.
		try {
			await processDepartures(run);
		} catch (e) {
			logger.error(`[prerender] Departure check for ${rootSitemapUrl} failed: ${describeError(e)}`);
			run.countDeparture('failed');
		}

		// The dropped children's rows, LAST, and not one the departure step re-linked held URLs back onto
		// (a failed child they could have moved into): a row deleted under its own targets would strand
		// them — attributed to a sitemap nothing walks, which is the state the prune exists to end. Kept,
		// it is simply offered again by the next walk.
		for (const url of prunedChildren) {
			if (run.wasRelinkedTo(url)) continue;
			try {
				await SitemapTable.delete(url);
			} catch (e) {
				logger.warn(`[prerender] Could not drop the row of unlisted sitemap ${url}: ${describeError(e)}`);
			}
		}

		// Rejoins were already told from shear during the walk (`isRejoin` against `run.startedAt`), so
		// nothing forces this after the walk except sharing the departure executor. Guarded the same way.
		try {
			await processArrivals(run);
		} catch (e) {
			logger.error(`[prerender] Arrival check for ${rootSitemapUrl} failed: ${describeError(e)}`);
			run.countArrival('failed');
		}

		try {
			await onProgress?.(run.snapshot());
		} catch (e) {
			logger.warn(`[prerender] Sitemap progress callback failed: ${describeError(e)}`);
		}

		return run.snapshot();
	}

	/**
	 * Refresh one sitemap (by id) or every stored sitemap (no id).
	 *
	 * Background by default — see `config.sitemap.background`. A sitemap index is not an
	 * HTTP-request-sized unit of work: a real one fans out to tens of children and over a million
	 * target writes, so holding the request open guarantees the client or an intermediary times
	 * out with no result, no error, and no way to tell what was written. Answering immediately
	 * with a handle, and persisting progress to `SitemapRefresh`, makes the walk observable
	 * instead.
	 */
	async post(options = {}) {
		const { background = config.sitemap.background, ...refreshOptions } = options;
		const paramUrl = this.getId();

		if (background) {
			return startSitemapRefreshInBackground(paramUrl || undefined, refreshOptions);
		}

		const urls = paramUrl ? [paramUrl] : await rootSitemapUrls();
		const results = [];
		for (const url of urls) {
			logger.info(`Scheduling refresh for sitemap`, url);
			// Awaited — this is the blocking form — but OUTSIDE the request's transaction (util/detach.js):
			// a walk is minutes of batched writes, each batch meant to commit as it goes, and on the
			// request's transaction they would all be pending on one that the long-transaction monitor
			// fires on every 30 seconds.
			results.push(await runDetached(() => runTrackedRefresh(url, refreshOptions)));
		}
		return results;
	}

	/**
	 * Remove a sitemap, its descendants, and every Target attributed to any of them.
	 *
	 * Deleting an INDEX has to reach its children or it accomplishes almost nothing: targets are
	 * attributed to the child sitemap that listed them, never to the index, so an index delete on
	 * its own removes ZERO targets. It just drops the index row and strands every child row plus
	 * all their targets, which keep rendering forever with nothing left to attribute or retire
	 * them. `parentUrl` is what makes the descendants findable.
	 *
	 * Target removal is two-phase per sitemap — see `deleteTargetsFor`.
	 */
	async delete() {
		const url = this.getId();

		// Re-entrancy: an ancestor's cascade has already removed this sitemap's targets and is
		// only calling back through here to drop the row. Also what makes a cyclic index
		// (A lists B, B lists A) terminate.
		if (cascading.has(url)) return super.delete(...arguments);

		// The cascade runs OUTSIDE the request's transaction (util/detach.js) and the request waits for
		// it: a large sitemap's targets are deleted in batches that must commit as they go, and on the
		// request's transaction every one of them would be pending on a transaction the 30-second
		// long-transaction monitor fires on. Only the row's own delete stays on the request.
		await runDetached(async () => {
			const descendants = await sitemapDescendants(url);

			for (const sitemapUrl of [url, ...descendants]) {
				await deleteTargetsFor(sitemapUrl);
			}

			for (const child of descendants) cascading.add(child);
			try {
				await applyInBatches({ items: descendants, apply: (child) => Sitemap.delete(child) });
			} finally {
				for (const child of descendants) cascading.delete(child);
			}
		});

		return super.delete(...arguments);
	}
}

export const sitemaps = Sitemap;

/**
 * Kick off a background refresh of one root sitemap (`url` given) or every root (omitted).
 * Extracted from `post` so the management console can start a walk through its own gated
 * surface without duplicating the claim/skip semantics.
 *
 * One sitemap: the claim is taken synchronously, so the caller is told immediately when a run
 * is already in flight rather than silently starting a second walk over the same targets.
 *
 * Refresh-all: ONE background job that walks the roots in sequence. Starting every stored
 * sitemap at once would put N concurrent walks on a single worker, each holding its own entry
 * map and issuing its own write batches — strictly worse than sequential. Claims are taken
 * just-in-time inside the loop so a queued sitemap is not judged against a claim made an hour
 * earlier. Roots only — an index reaches its own children, so walking children as top-level
 * jobs too would process every one of them twice (see `rootSitemapUrls`).
 */
export async function startSitemapRefreshInBackground(url, refreshOptions = {}) {
	const urls = url ? [url] : await rootSitemapUrls();

	if (urls.length === 1) {
		const [only] = urls;
		const claim = await claimRefreshRun(only);
		if (!claim.ok) {
			return {
				background: true,
				sitemaps: [{ url: only, started: false, reason: claim.reason, progress: progressPath(only) }],
			};
		}

		logger.info(`Starting background refresh for sitemap`, only);
		// Deliberately not awaited: the walk outlives this request. Failures are logged and
		// recorded on the progress row by `runTrackedRefresh`; the catch here only keeps the
		// rejection from surfacing as an unhandled one.
		// Outside the request that asked (util/detach.js): the walk outlives the response, and the
		// request's transaction does not.
		void runDetached(() => runTrackedRefresh(only, refreshOptions)).catch(() => {});
		return { background: true, sitemaps: [{ url: only, started: true, progress: progressPath(only) }] };
	}

	void runDetached(async () => {
		for (const root of urls) {
			const claim = await claimRefreshRun(root);
			if (!claim.ok) {
				logger.info(`[prerender] Skipping sitemap ${root}: ${claim.reason}`);
				continue;
			}
			await runTrackedRefresh(root, refreshOptions).catch(() => {});
		}
	});

	return {
		background: true,
		sitemaps: urls.map((root) => ({ url: root, started: true, progress: progressPath(root) })),
	};
}

/** Where a caller polls for a walk's progress. */
const progressPath = (rootUrl) => `/sitemap_refresh/${encodeURIComponent(rootUrl)}`;

/** Sitemap rows currently being removed as part of an ancestor's cascade. See `delete`. */
const cascading = new Set();

/** Every sitemap reachable from `url` via `parentUrl`, breadth-first and cycle-safe. */
async function sitemapDescendants(url) {
	const found = [];
	const seen = new Set([url]);
	const queue = [url];

	while (queue.length) {
		const parent = queue.shift();
		for await (const row of Sitemap.search({
			select: ['url'],
			conditions: [{ attribute: 'parentUrl', value: parent }],
		})) {
			if (seen.has(row.url)) continue;
			seen.add(row.url);
			found.push(row.url);
			queue.push(row.url);
		}
	}

	return found;
}

/** Remove every Target attributed to one sitemap, two-phase and bounded. */
async function deleteTargetsFor(sitemapUrl) {
	// Two-phase for the same reason as everywhere else: deleting from inside the open search
	// cursor leaves writes pending while it is open, which the long-transaction monitor aborts
	// (422) partway through on a large sitemap. See util/scan.js.
	const {
		items: urls,
		examined,
		truncated,
	} = await collectFromScan({
		scan: () => Target.search({ conditions: [{ attribute: 'sitemapUrl', value: sitemapUrl }], select: 'url' }),
		pick: (url) => url,
	});

	await applyInBatches({ items: urls, apply: (url) => Target.delete(url) });

	// `collectFromScan` reports this precisely so a caller cannot act on a partial set while
	// believing it was complete, and it used to be discarded here. A sitemap with more targets
	// than `scan.collectCap` loses only the first capful; the row goes away regardless, so the
	// remainder would be left rendering forever with nothing attributing them. Say so loudly —
	// re-running the delete is what clears the rest.
	if (truncated) {
		logger.error(
			`[prerender] Deleting sitemap ${sitemapUrl} removed ${urls.length} of ${examined} targets ` +
				`(scan.collectCap=${config.scan.collectCap}). Re-run the delete to remove the rest.`
		);
	}
}

/**
 * Milliseconds since a `Date`-typed column. See `epochMsOf` for the shapes one can arrive in.
 *
 * An unparseable or absent timestamp reports `Infinity`, which makes `claimRefreshRun` treat the
 * run as dead and take it over. That direction is deliberate: failing the other way would let one
 * unreadable timestamp block every future refresh of that root permanently, which is the terminal
 * state `staleRunMs` exists to prevent. Taking over merely risks a duplicate walk, and the walk is
 * idempotent.
 */
function ageOf(value) {
	const ms = epochMsOf(value);
	return Number.isFinite(ms) ? Date.now() - ms : Infinity;
}

/**
 * Refuse to start a second walk over a root that is already being walked.
 *
 * Advisory, not a lock: this is a node-local read of a replicated table (so no residency
 * routing and no unbounded cross-node fetch), and two requests arriving simultaneously can both
 * see "not running". That is acceptable — the walk is idempotent, and the guard exists to stop
 * the common case of an operator re-POSTing a slow index, not to serialize a race.
 *
 * A run whose progress row has gone stale is treated as dead and taken over. Without that, a
 * worker restart mid-walk would leave a `running` row that blocks every later refresh of that
 * root forever.
 */
async function claimRefreshRun(rootUrl) {
	let existing;
	try {
		existing = await databases.sitemaps.SitemapRefresh.get({ id: rootUrl, select: ['state', 'updatedAt', 'node'] });
	} catch (e) {
		// A progress row we cannot read must not block the actual work.
		logger.warn(`[prerender] Could not read refresh progress for ${rootUrl}: ${describeError(e)}`);
		return { ok: true };
	}

	if (existing?.state !== 'running') return { ok: true };

	const age = ageOf(existing.updatedAt);
	if (age < config.sitemap.staleRunMs) {
		return {
			ok: false,
			reason: `a refresh on ${existing.node ?? 'another node'} is already running (last progress ${Math.round(age / 1000)}s ago)`,
		};
	}

	logger.warn(
		`[prerender] Taking over the sitemap refresh for ${rootUrl}: the run on ${existing.node ?? 'another node'} ` +
			`has not reported progress in ${Math.round(age / 1000)}s (sitemap.staleRunMs=${config.sitemap.staleRunMs}).`
	);
	return { ok: true };
}

/** The snapshot fields that are persisted as progress. */
const progressFields = (snapshot) => ({
	sitemapsProcessed: snapshot.sitemapsProcessed,
	sitemapsDiscovered: snapshot.sitemapsDiscovered,
	created: snapshot.created,
	updated: snapshot.updated,
	skipped: snapshot.skipped,
	createdSoon: snapshot.createdSoon,
	listedSoon: snapshot.listedSoon,
	shrinkRefused: snapshot.shrinkRefused,
	shrinkAccepted: snapshot.shrinkAccepted,
	shrinkHeldBack: snapshot.shrinkHeldBack,
	notModified: snapshot.notModified,
	duplicates: snapshot.duplicates,
	deferred: snapshot.deferred,
	removed: snapshot.removed,
	failed: snapshot.failed,
	// The departure tally rides the progress row too, so a dry run is readable from
	// `GET /sitemap_refresh/<root>` without waiting for the walk to return.
	departures: snapshot.departures,
	arrivals: snapshot.arrivals,
});

/**
 * Run one refresh and record its progress and outcome on the `SitemapRefresh` row for that root.
 *
 * Rethrows so a blocking caller still sees the failure; the background call sites swallow it
 * because the row already carries it.
 */
async function runTrackedRefresh(rootUrl, options) {
	const startedAt = new Date();

	// `put` replaces the record, so every write restates the identity fields. A progress write
	// that fails must never take the walk down with it — it is telemetry, not the work.
	const writeProgress = (fields) =>
		databases.sitemaps.SitemapRefresh.put(rootUrl, {
			node: server.hostname,
			startedAt,
			updatedAt: new Date(),
			...fields,
		}).catch((e) => logger.warn(`[prerender] Could not record refresh progress for ${rootUrl}: ${describeError(e)}`));

	await writeProgress({ state: 'running' });

	try {
		const result = await Sitemap.refresh(rootUrl, {
			...options,
			onProgress: (snapshot) => writeProgress({ state: 'running', ...progressFields(snapshot) }),
		});

		await writeProgress({
			state: 'completed',
			finishedAt: new Date(),
			lastRefreshed: new Date(),
			...progressFields(result),
		});

		logger.info(
			`[prerender] Sitemap refresh for ${rootUrl} finished: ${result.sitemapsProcessed} sitemaps ` +
				`(${result.notModified} not modified), ${result.created} created ` +
				`(${result.createdSoon} fast-path), ${result.updated} re-attributed ` +
				`(${result.listedSoon} first listings fast-pathed), ${result.skipped} unchanged, ` +
				`${result.removed} unlinked, ${result.failed.length} failed`
		);

		// The same numbers as METRICS — corpus churn and walk health, previously log-only.
		// Guarded: a gauge must never cost the run its completed progress row.
		try {
			metrics.sitemapRun(result.sitemapsProcessed, 'sitemaps');
			metrics.sitemapRun(result.created, 'created');
			metrics.sitemapRun(result.createdSoon, 'created_soon');
			metrics.sitemapRun(result.updated, 'updated');
			metrics.sitemapRun(result.skipped, 'skipped');
			metrics.sitemapRun(result.notModified, 'not_modified');
			metrics.sitemapRun(result.removed, 'removed');
			metrics.sitemapRun(result.failed.length, 'failed');
			// Documents the shrink guard refused (each also a `failed` child) and the identical ones it
			// accepted after `acceptAfter` refusals — the second is the one to alert on: a real shrink landed.
			metrics.sitemapRun(result.shrinkRefused, 'shrink_refused');
			metrics.sitemapRun(result.shrinkAccepted, 'shrink_accepted');
			// URLs an accepted shrink kept attributed this walk, past `releasePerWalk`; they release later.
			metrics.sitemapRun(result.shrinkHeldBack, 'shrink_held_back');
		} catch (e) {
			logger.warn(`[prerender] sitemap_run gauges not recorded: ${describeError(e)}`);
		}

		return result;
	} catch (e) {
		logger.error(`[prerender] Sitemap refresh for ${rootUrl} aborted: ${describeError(e)}`);
		await writeProgress({ state: 'failed', finishedAt: new Date(), error: describeError(e) });
		throw e;
	}
}

/**
 * Fetch and process ONE sitemap document. Returns the child sitemap URLs to walk (empty for a
 * `<urlset>`).
 *
 * The stored row is written last, so a document that throws partway leaves the previous row —
 * and its `lastRefreshed` — untouched rather than recording a refresh that did not happen.
 *
 * A 304 writes NOTHING — the stored row is still current, validator included — and for a urlset
 * skips the reconcile entirely, which is where a pass's real cost lives: the per-child prune scan
 * holds a read cursor, and cursor-seconds are what scale with refresh frequency. That is what
 * makes polling often affordable rather than merely possible.
 */
async function refreshOneSitemap(sitemapUrl, { parentUrl, revalidate, run, visited, rootSitemapUrl, dropped }) {
	logger.info(`Processing sitemap`, sitemapUrl);

	// A narrow projection on purpose: `entries` on an index can be long, and this read happens for
	// every document on every pass. The entries are read back only on the one path that needs them —
	// a 304 on an INDEX. `entryCount` and the refusal fields are the shrink guard's (`judgeShrunk`).
	const stored = await Sitemap.get({ id: sitemapUrl, select: [...STORED_SELECT, 'isIndex', 'lastRefreshed'] });
	const ifModifiedSince = conditionalValidatorFor(stored, revalidate);

	const latestSitemap = await fetchLatestSitemap(sitemapUrl, { ifModifiedSince, rootSitemapUrl });

	if (latestSitemap.notModified) {
		run.count('notModified');

		// An INDEX still has to be descended. A 304 says the CHILD LIST is unchanged, not that the
		// children are — they are separate documents with their own validators, and on a real corpus
		// they move on a different schedule from the index that lists them (measured: children
		// rebuilt nightly, the index that lists them at a different hour entirely). So re-read the
		// stored entries and keep walking; each child then makes its own conditional decision.
		//
		// And re-diffed against the stored child rows, although the list is unchanged: a child a
		// previous walk found dropped but did not prune (refused by the shrink guard, a failed scan, a
		// release still in progress) still has its row, and an index that 304s from then on would
		// otherwise never offer it again. Same version as the walk that stored this list, so a refusal
		// waits out `acceptAge` rather than counting a 304 as a rebuild.
		if (stored?.isIndex === true) {
			const storedRow = await Sitemap.get({ id: sitemapUrl, select: ['url', 'entries'] });
			const children = (storedRow?.entries ?? []).map(({ loc }) => loc).filter(Boolean);
			const version = documentVersion(stored?.lastModified, children);
			for (const [url, info] of await findDroppedChildren(sitemapUrl, children, version)) dropped?.set(url, info);
			return children;
		}
		run.addUnchangedUrlset(sitemapUrl);
		return [];
	}

	const row = { ...latestSitemap, parentUrl };
	delete row.notModified;

	if (latestSitemap.isIndex === true) {
		// Stored whatever it omits: whether an omission is a partial index is judged after the walk, by
		// what the children it dropped still hold (`pruneDroppedChildren`), never by child names.
		const children = latestSitemap.entries.map(({ loc }) => loc).filter(Boolean);
		await Sitemap.put(sitemapUrl, row);
		const version = documentVersion(latestSitemap.lastModified, children);
		for (const [url, info] of await findDroppedChildren(sitemapUrl, children, version)) dropped?.set(url, info);
		return children;
	}

	// A urlset much SHORTER than the one last accepted is refused before its prune: thrown, it is a
	// failed child (the walk's catch records it), its row and its targets untouched. An accepted one,
	// and one still releasing an earlier acceptance, prunes at most `releasePerWalk`.
	let releasing = stored?.shrinkRelease === true;
	const refusal = shrinkRefusal({ sitemapUrl, incoming: latestSitemap.entries.length, stored: stored?.entryCount });
	if (refusal) {
		const version = documentVersion(
			latestSitemap.lastModified,
			latestSitemap.entries.map((entry) => entry?.loc)
		);
		if (!(await judgeShrunk({ sitemapUrl, stored, version, refusal, run }))) throw new Error(refusal);
		releasing = true;
	}

	const { routes, heldBack } = latestSitemap.entries?.length
		? await reconcileSitemapEntries(sitemapUrl, latestSitemap, {
				revalidate,
				run,
				visited,
				releaseLimit: releasing ? shrinkReleaseLimit() : Infinity,
			})
		: { routes: new Set(), heldBack: 0 };

	await Sitemap.put(sitemapUrl, {
		...row,
		entries: latestSitemap.entries.slice(0, STORED_ENTRY_SAMPLE),
		// Every route the document's entries fall on — what a failure of this child can have received, so
		// the hold-back is scoped by all of them, not by whichever route its first entries happen to share.
		routes: [...routes],
		// A release with URLs still held back: no validator, so the next walk fetches it again in full and
		// unlinks the next batch, and the marker keeps that walk to the same ceiling.
		...(heldBack > 0 ? { lastModified: null, shrinkRelease: true } : {}),
	});
	return [];
}

/** What every guard read of a stored row projects. */
const STORED_SELECT = [
	'url',
	'lastModified',
	'entryCount',
	'shrinkRefusals',
	'shrinkRefusedVersion',
	'shrinkRefusedAt',
	'shrinkRelease',
];

/** A document's version for the shrink guard: its validator and a digest of its locs — either moving is a new version. */
const documentVersion = (lastModified, locs) =>
	`${lastModified ?? ''}|${locs.length}:${createHash('sha256').update(locs.join('\n')).digest('base64url').slice(0, 22)}`;

/**
 * Refuse a shorter document the shrink guard tripped on — or ACCEPT it, once the shrink has outlived a
 * rebuild. Returns true to accept.
 *
 * Accepted when it has been refused at least `acceptAfter` times AND either it survived a NEW version
 * (`version` differs from the one first refused: the origin rebuilt it, and it is still short) or
 * `acceptAge` has passed since the first refusal. Counting walks alone was the wrong clock: a deployment
 * walking four times a day between nightly rebuilds accepted a bad build after a few walks of the same
 * day, just before the next rebuild would have fixed it — a mass departure, then a mass rejoin.
 *
 * The state rides the stored row, which a refused fetch otherwise leaves untouched; an accepted
 * document's put replaces the row and clears it (a dropped child's row goes when its prune completes).
 */
async function judgeShrunk({ sitemapUrl, stored, version, refusal, run }) {
	const { acceptAfter, acceptAge } = config.sitemap.shrinkGuard;
	const refusals = Math.max(0, numberOf(stored?.shrinkRefusals) || 0);
	const firstAt = dateColumnMs(stored?.shrinkRefusedAt);
	const rebuilt = refusals > 0 && stored?.shrinkRefusedVersion !== version;
	const aged = refusals > 0 && Number.isFinite(firstAt) && Date.now() - firstAt >= acceptAge;
	if (refusals >= acceptAfter && (rebuilt || aged)) {
		run.count('shrinkAccepted');
		logger.error(
			`[prerender] ${sitemapUrl}: ACCEPTING a shrink the guard refused ${refusals} time(s) — it ` +
				`${rebuilt ? 'survived a new origin version' : `has stood for ${Math.round((Date.now() - firstAt) / 3_600_000)}h`}. ` +
				`Its departures release at most sitemap.shrinkGuard.releasePerWalk a walk. (${refusal})`
		);
		return true;
	}
	run.count('shrinkRefused');
	if (stored) {
		await Sitemap.patch(sitemapUrl, {
			url: sitemapUrl,
			shrinkRefusals: refusals + 1,
			// The FIRST refusal's version and time: what "a new version" and `acceptAge` are measured from.
			...(refusals === 0 ? { shrinkRefusedVersion: version, shrinkRefusedAt: new Date() } : {}),
		});
	}
	return false;
}

/**
 * The children of `indexUrl` that have a stored row but are no longer listed, each with what the
 * post-walk guard needs: the index's version and the entries all its stored children held.
 *
 * A child's row keeps its `parentUrl` after the index stops listing it, so it is not a root either:
 * nothing walks it, nothing prunes it, and every target attributed to it stays LISTED for good — in
 * the probe's `listed` scope, behind the negative cache's `listed` guard, never offered to the
 * departure check. Collected here, acted on after the walk. Read-only: the cursor closes before any
 * write (util/scan.js).
 */
async function findDroppedChildren(indexUrl, listed, indexVersion) {
	const listedNow = new Set(listed);
	const dropped = [];
	let storedEntries = 0;
	for await (const row of Sitemap.search({
		select: ['url', 'isIndex', 'entryCount'],
		conditions: [{ attribute: 'parentUrl', value: indexUrl }],
	})) {
		if (!row?.url) continue;
		const entries = numberOf(row.entryCount);
		storedEntries += Number.isFinite(entries) && entries > 0 ? entries : 0;
		if (!listedNow.has(row.url)) dropped.push([row.url, { isIndex: row.isIndex === true, parentUrl: indexUrl }]);
	}
	for (const [, info] of dropped) Object.assign(info, { indexUrl, indexVersion, indexEntries: storedEntries });
	return dropped;
}

/**
 * Prune every child an index stopped listing as if it now listed nothing — unless the shrink guard says
 * the omission is a partial index. Returns the rows the caller drops after the departure step — never
 * this, because that step may re-link held URLs back onto one.
 *
 * Skipped when this walk visited it after all (another index lists it). A dropped sub-INDEX stands for
 * its stored descendants — its targets are attributed to its children, never to itself.
 *
 * THREE PHASES, so the guard sees the whole omission before anything is unlinked: every dropped urlset's
 * leftovers are collected (what it still holds after the walk re-attached everything that moved: exactly
 * what is listed nowhere now); each is judged alone (`droppedChildRefusal`) and with its index
 * (`indexShrinkRefusal`); then the ones not refused are pruned. A refused one is a FAILED child — its row
 * and its targets stay, and its routes hold back the URLs that could have moved into it (a URL that
 * shifted into a child the index left out is unlinked by its old child and re-attached by nobody).
 */
async function pruneDroppedChildren(run, dropped, visited) {
	const leaves = [];
	for (const [url, info] of [...dropped].filter(([candidate]) => !visited.has(candidate))) {
		run.noteParent(url, info.parentUrl);
		if (!info.isIndex) {
			leaves.push({ url, info, top: url });
			continue;
		}
		for (const child of (await sitemapDescendants(url)).filter((candidate) => !visited.has(candidate))) {
			const row = await Sitemap.get({ id: child, select: ['url', 'isIndex', 'parentUrl'] });
			run.noteParent(child, row?.parentUrl ?? url);
			if (row && row.isIndex !== true) leaves.push({ url: child, info, top: url });
			else if (row) leaves.push({ url: child, info, top: url, index: true });
		}
		leaves.push({ url, info, top: url, index: true });
	}

	// Phase 1: what each dropped urlset still holds.
	const leftoversByIndex = new Map();
	for (const leaf of leaves) {
		if (leaf.index) continue;
		try {
			leaf.stored = await Sitemap.get({ id: leaf.url, select: STORED_SELECT });
			leaf.scan = await collectDeparted(leaf.url, new Map(), run);
			const key = leaf.info.indexUrl;
			leftoversByIndex.set(key, (leftoversByIndex.get(key) ?? 0) + leaf.scan.departed.length);
		} catch (e) {
			leaf.failed = true;
			logger.error(`[prerender] Sitemap ${leaf.url} is no longer listed and could not be pruned: ${describeError(e)}`);
			run.addFailure(leaf.url, e);
		}
	}

	// Phase 2 and 3: judge each, prune the ones not refused.
	const incomplete = new Set();
	const pruned = [];
	for (const leaf of leaves) {
		if (leaf.index) continue;
		if (leaf.failed) {
			incomplete.add(leaf.top);
			continue;
		}
		try {
			const { departed, truncated } = leaf.scan;
			let releasing = leaf.stored?.shrinkRelease === true;
			const refusal =
				!releasing &&
				(droppedChildRefusal({
					sitemapUrl: leaf.url,
					leftovers: departed.length,
					entryCount: leaf.stored?.entryCount,
				}) ??
					indexShrinkRefusal({
						indexUrl: leaf.info.indexUrl,
						leftovers: leftoversByIndex.get(leaf.info.indexUrl) ?? 0,
						storedEntries: leaf.info.indexEntries ?? 0,
					}));
			if (refusal) {
				if (
					!(await judgeShrunk({
						sitemapUrl: leaf.url,
						stored: leaf.stored,
						version: leaf.info.indexVersion,
						refusal,
						run,
					}))
				) {
					logger.error(`[prerender] ${refusal}`);
					run.addFailure(leaf.url, new Error(refusal));
					incomplete.add(leaf.top);
					continue;
				}
				releasing = true;
			}
			logger.info(`[prerender] Sitemap ${leaf.url} is no longer listed by its index — unlinking what it still holds`);
			const heldBack = await unlinkDeparted(leaf.url, departed, run, releasing ? shrinkReleaseLimit() : Infinity);
			if (heldBack > 0) await Sitemap.patch(leaf.url, { url: leaf.url, shrinkRelease: true });
			if (heldBack > 0 || truncated) incomplete.add(leaf.top);
			else if (leaf.top === leaf.url) pruned.push(leaf.url);
		} catch (e) {
			incomplete.add(leaf.top);
			logger.error(`[prerender] Sitemap ${leaf.url} is no longer listed and could not be pruned: ${describeError(e)}`);
			run.addFailure(leaf.url, e);
		}
	}
	// A dropped sub-index goes with all its descendants, and only once every one of them is done.
	for (const top of new Set(leaves.filter((leaf) => leaf.index && leaf.url === leaf.top).map((leaf) => leaf.top))) {
		if (!incomplete.has(top)) pruned.push(...leaves.filter((leaf) => leaf.top === top).map((leaf) => leaf.url));
	}
	return pruned;
}

/**
 * The sitemaps a "refresh everything" pass should start from: those no index claims as a child.
 *
 * Rows written before `parentUrl` existed have none, so they read as roots and are walked
 * directly on the first pass after upgrading — which is also the pass that stamps them, so the
 * duplication corrects itself. Filtering in JS rather than querying for a null attribute keeps
 * this independent of Harper's null-comparison semantics, and the row count here is the number
 * of sitemap documents, not of URLs.
 */
async function rootSitemapUrls() {
	const roots = [];
	for await (const row of Sitemap.search({ select: ['url', 'parentUrl'] })) {
		if (!row.parentUrl) roots.push(row.url);
	}
	return roots;
}

/** What the entry loop's point read projects: `actionForExisting`, `isRejoin` and `fileFirstListing`. */
const FIRST_LISTING_SELECT = ['sitemapUrl', 'unlistedAt', 'state', 'suppressedReason', 'demandInterval'];

/**
 * A first listing's fast path: file the URL due now, never later than it already was (`fileDueNow`).
 *
 * Due NOW rather than jittered across `newTargets.window` like a create, because only `fileDueNow`
 * keeps what the row already has — a due time that is earlier, a change mark the probe filed — and the
 * row is not new: it may carry both. The burst is bounded by the same `maxPerRun` a create's is, and
 * the window still gates it (0 disables both). A row SUPPRESSED on a verdict other than gone —
 * canonical-mismatch, noindex — is filed the same way: its recheck, parked for days by the verdict,
 * is exactly what the site declaring the URL calls into question, and the render re-proves or lifts
 * it. A gone verdict is left to its own reopen path (util/goneReopen.js), which the caller excludes.
 */
const fileFirstListing = (url, existing, renderInterval) =>
	fileDueNow(url, {
		fromSitemap: true,
		effectiveInterval: resolveEffectiveInterval(url, { renderInterval, demandInterval: existing?.demandInterval }),
	});

/** Diff one `<urlset>` against the targets currently attributed to it, and apply the result. */
async function reconcileSitemapEntries(sitemapUrl, latestSitemap, { revalidate, run, visited, releaseLimit }) {
	// Keep only the URLs this deployment actually prerenders, keyed by the canonical URL-half the
	// bot read uses — so the prune diff below and the target keys built later both match what a
	// request will look up. Everything else is counted and dropped rather than turned into a
	// target that renders into a key no read computes. See util/sitemap.js.
	const { incoming: incomingEntryMap, filtered, invalid, routes } = partitionSitemapEntries(latestSitemap.entries);

	// debug, not warn: per-entry, and a sitemap with thousands of bad entries would flood the
	// log. The aggregate summary (reportFiltered) already reports counts and escalates itself
	// to error when most of the sitemap is affected.
	for (const { loc, message } of invalid) {
		logger.debug(`Skipping invalid sitemap entry ${loc}: ${message}`);
	}
	reportFiltered(sitemapUrl, filtered, latestSitemap.entries.length);
	run.addFiltered(filtered);

	const { knownKeys, heldBack } = await pruneSitemapTargets(sitemapUrl, incomingEntryMap, { run, limit: releaseLimit });

	// Read once per child rather than per entry: config is a live object and this is the hot loop.
	const { window: newTargetWindow, maxPerRun: newTargetCap } = config.sitemap.newTargets;

	let inflight = [];
	let considered = 0;

	for (const [cacheUrl, { changefreq }] of incomingEntryMap) {
		const renderInterval = getTtlFromChangeFreq(changefreq, {
			minTtl: config.page.minTtl,
			defaultTtl: config.page.ttl,
		});

		// Yield on rows CONSIDERED, not on writes issued. The skip path below is entirely
		// synchronous now that `knownKeys` answers it without a point read, so the healthy
		// steady state — where almost everything is already correct — would otherwise run
		// 100,000 iterations for a single product sitemap without ever reaching the batch
		// drain, monopolizing the thread. The previous code was accidentally safe here only
		// because it awaited a database read every iteration. Same reasoning, and the same
		// counter, as `collectFromScan`.
		if (++considered % config.scan.yieldEvery === 0) await setImmediate();

		let action;
		let rejoined = false;
		let existing = null;
		if (revalidate) {
			// No point read, so no rejoin is detected — and none needs to be: this files every listed URL
			// due now. The `put` below replaces the row, which clears any `unlistedAt` by construction.
			action = TargetAction.RENDER;
		} else if (canSkipLookup({ revalidate, knownKeys, key: cacheUrl })) {
			action = TargetAction.SKIP;
		} else {
			// Only reached for a URL the prune scan did not return: genuinely new, moved here
			// from another sitemap, or missed because `knownKeys` was capped. The attribution and the
			// unlink stamp decide the action; the verdict and the rung are what a first listing's
			// fast path needs (`fileFirstListing`). Never the whole record in a bulk loop.
			existing = await Target.get({ id: cacheUrl, select: FIRST_LISTING_SELECT });
			action = actionForExisting(existing, sitemapUrl, visited);
			rejoined = action === TargetAction.REATTACH && isRejoin(existing, run.startedAt);
		}

		switch (action) {
			case TargetAction.SKIP:
				run.count('skipped');
				continue;

			case TargetAction.DUPLICATE:
				// Listed by an earlier sitemap in this same walk, which already owns it. Leaving
				// it alone is what makes attribution converge instead of ping-ponging.
				run.count('duplicates');
				continue;

			case TargetAction.REATTACH: {
				// Attribution changed, the page did not. `patch` leaves the RenderSchedule rows
				// alone; `put` would recompute `getInitialRenderTime` and shove the next render
				// forward by a fresh jitter every pass. See util/sitemapRun.js.
				//
				// `unlistedAt: null` in the same patch: re-attributed is listed, whether this is a rejoin, a
				// same-walk shear, or a move from another sitemap. Unconditional, so the stamp cannot outlive
				// the attribution it describes.
				//
				// A FIRST listing is the exception on the schedule (util/sitemapArrival.js `isFirstListing`):
				// a URL discovered from traffic that the site now declares takes the new-target fast path,
				// inside the same per-walk cap as a create — its first render, or the recheck of a verdict
				// the declaration contradicts, filed due now (`fileFirstListing`).
				run.count('updated');
				if (rejoined) run.addArrival(cacheUrl);
				const soon =
					newTargetWindow > 0 &&
					newTargetWindow < renderInterval &&
					run.fastPathTaken() < newTargetCap &&
					isFirstListing(existing) &&
					!isGoneSuppressed(existing);
				if (soon) run.count('listedSoon');
				const attach = Target.patch(cacheUrl, { url: cacheUrl, sitemapUrl, renderInterval, unlistedAt: null });
				inflight.push(soon ? attach.then(() => fileFirstListing(cacheUrl, existing, renderInterval)) : attach);
				break;
			}

			case TargetAction.CREATE: {
				// A DECLARATION IS A STRONG SIGNAL, so a newly listed URL does not wait out a full
				// interval of jitter to be rendered once. `getInitialRenderTime` spreads the first
				// render across `hash(url) % interval`, which is sized for the first ingest of a large
				// sitemap and applies just as hard to the handful of genuinely new URLs a mature corpus
				// gains each day — on a 48h cadence, up to two days.
				//
				// The window is jittered rather than set to "now" for the same reason the interval jitter
				// exists: a batch of creates must land across minutes, not in one. And the cap is what
				// keeps bulk population safe — past `maxPerRun` this falls back to the old full-interval
				// jitter by passing no explicit time at all, so a first ingest behaves exactly as before.
				//
				// Only the FIRST render moves: `Target.put` still files `effectiveInterval` from the
				// route/stored cadence, so every render after this one is on the normal schedule.
				run.count('created');
				// `< renderInterval`, because a window WIDER than the route's own cadence makes the "fast"
				// path slower than the jitter it replaces — and would still count as `createdSoon`, so the
				// metric would report an acceleration that did not happen. Not reachable on a corpus whose
				// shortest interval is a day, but the guard is free and the metric has to stay honest.
				const fast = newTargetWindow > 0 && newTargetWindow < renderInterval && run.fastPathTaken() < newTargetCap;
				if (fast) run.count('createdSoon');
				inflight.push(
					Target.put(cacheUrl, {
						renderInterval,
						sitemapUrl,
						...(fast ? { nextRenderTime: getInitialRenderTime(cacheUrl, newTargetWindow) } : {}),
					})
				);
				break;
			}

			case TargetAction.RENDER:
				run.count('created');
				inflight.push(Target.put(cacheUrl, { renderInterval, sitemapUrl, nextRenderTime: currentMinuteMs() }));
				break;
		}

		// Drain the WHOLE batch, not just the most recent promise. This used to await
		// `lastPromise` alone, which left the rest of the batch still in flight — and Harper's
		// long-transaction monitor aborts (422, poisoned) any transaction that has writes
		// pending when it fires, so a slow batch could kill the refresh partway through.
		// Awaiting every promise in the batch is what makes "no pending writes across a monitor
		// tick" actually true. See util/scan.js.
		if (inflight.length >= config.scan.batchSize) {
			await Promise.all(inflight);
			inflight = [];
			await setImmediate();
		}
	}

	if (inflight.length > 0) {
		await Promise.all(inflight);
	}

	return { routes, heldBack };
}

/**
 * The prune half of a reconcile: unlink every target attributed to `sitemapUrl` that the document no
 * longer lists. Returns the keys it found still listed (the entry loop's point-read cache) and whether
 * the scan was truncated. A child the index stopped listing is pruned through here too, with an empty
 * `incomingEntryMap`. The shrink guard has already judged the DOCUMENT by this point
 * (`refreshOneSitemap`); what the prune unlinks includes every URL that merely moved, which is the
 * post-walk shear handling's to sort out, not a reason to refuse.
 */
async function pruneSitemapTargets(sitemapUrl, incomingEntryMap, { run, limit = Infinity }) {
	const scan = await collectDeparted(sitemapUrl, incomingEntryMap, run);
	const heldBack = await unlinkDeparted(sitemapUrl, scan.departed, run, limit);
	return { knownKeys: scan.knownKeys, truncated: scan.truncated, heldBack };
}

/** The read half of a prune: every target attributed to `sitemapUrl` the document no longer lists. */
async function collectDeparted(sitemapUrl, incomingEntryMap, run) {
	// Two-phase, and NOT because of event-loop fairness alone: this loop used to issue
	// `Target.patch` from inside the open search cursor. Harper's long-transaction monitor
	// aborts (422, poisoned) any transaction that has writes pending when it fires, so on a large
	// sitemap the refresh could die partway through with some targets already unlinked. Collect
	// while reading, write once the cursor is closed — see util/scan.js.
	//
	// The collect step is also where the filtered-vs-departed distinction is made. Absent from the
	// incoming map means one of two very different things, and conflating them is what would turn
	// every filtered URL into an orphan:
	//   - it left the sitemap              -> unlink it, as before
	//   - it was FILTERED by the partition -> leave it alone
	// Unlinking is `patch`, which bypasses the overridden `put` and so leaves the RenderSchedule
	// row intact: the target keeps rendering on its interval with nothing tracking it and no
	// sitemap to bring it back. Fine for a URL that genuinely left the sitemap (that is the
	// pre-existing discovery-target shape), but applied to a filtered URL it would silently
	// convert this pass's entire filtered set into permanently-rendering, unattributable
	// targets — the exact load the filter removes.
	//
	// Retiring them is deliberately NOT done here. Deleting targets needs the guardrails the
	// reconcile sweep will carry (refuse when no prerender routes compile, a ceiling on how much
	// one pass may retire), not an ingest pass that would act on whatever the route list happened
	// to say this morning.
	//
	// The same pass builds `knownKeys`: every target this scan returns is BOTH present and (by the
	// scan's own condition) already attributed to this sitemap, which is exactly what the caller's
	// entry loop would otherwise spend a point read per entry × device discovering. It is a cache,
	// not an authority — a miss falls through to the read — so capping it costs latency, never
	// correctness.
	const knownKeys = new Set();
	const {
		items: departed,
		examined,
		truncated,
	} = await collectFromScan({
		scan: () =>
			Target.search({
				// Array select, NOT a string one: a string select projects to the bare VALUE
				// rather than a record, which is the trap that once made every target look
				// un-attributed. Only the key is needed — nothing here reads the other columns.
				select: ['url'],
				conditions: [{ attribute: 'sitemapUrl', value: sitemapUrl }],
			}),
		pick: (target) => {
			if (incomingEntryMap.has(target.url)) {
				if (knownKeys.size < config.scan.collectCap) knownKeys.add(target.url);
				return null;
			}
			if (classifyUrl(target.url).routeClass !== PRERENDER) {
				run.count('deferred');
				return null;
			}
			return target;
		},
	});

	// `collectFromScan` computes this precisely so a caller cannot act on a partial set while
	// reporting success, and it used to be discarded here. A truncated prune means some departed
	// targets kept their attribution and will be unlinked on a later pass.
	if (truncated) {
		logger.error(
			`[prerender] ${sitemapUrl}: prune collected ${departed.length} of ${examined} scanned targets ` +
				`(scan.collectCap=${config.scan.collectCap}). Only the collected ones were unlinked this pass.`
		);
		run.addTruncatedScan(sitemapUrl, examined, departed.length);
	}

	return { departed, examined, truncated, knownKeys };
}

/**
 * The write half: unlink `departed`, at most `limit` of them (an accepted shrink releasing in batches,
 * `sitemap.shrinkGuard.releasePerWalk`). Returns how many it held back.
 */
async function unlinkDeparted(sitemapUrl, departed, run, limit = Infinity) {
	const released = departed.length > limit ? departed.slice(0, limit) : departed;
	const heldBack = departed.length - released.length;
	if (heldBack > 0) run.count('shrinkHeldBack', heldBack);

	// `unlistedAt` rides the unlink patch — no extra write — and is THE WALK'S START, not this prune's
	// clock: a URL this same walk re-attaches further on then carries exactly `run.startedAt`, which is
	// how the entry loop's re-attach tells shear from a rejoin (util/sitemapArrival.js). The probe's
	// `changeProbe.scope: listed` grace is measured from it too (util/probeScope.js).
	const unlistedAt = new Date(run.startedAt);
	// The primary key rides every patch here, and in every other patch of a row that may have just been
	// deleted: a patch that lands on a missing record CREATES one holding only the patched fields, and
	// Harper writes the key attribute only when the update names it (`resources/Table.ts`, the
	// primary-key assignment in the write path). A walk racing a retirement on another node then left a
	// row with no `url` — invisible to every keyed walk (util/urlWalk.js counts it as unreadable) and
	// undeletable by anything that reads rows to find them.
	await applyInBatches({
		items: released,
		apply: (target) => Target.patch(target.url, { url: target.url, sitemapUrl: null, unlistedAt }),
	});
	run.addRemoved(released, sitemapUrl);

	return heldBack;
}

function getTtlFromChangeFreq(changefreq, { minTtl, defaultTtl }) {
	changefreq = changefreq?.toLowerCase();
	let ttl;
	switch (changefreq) {
		case 'always':
			ttl = 0;
			break;
		case 'hourly':
			ttl = 1000 * 60 * 60;
			break;
		case 'daily':
			ttl = 1000 * 60 * 60 * 24;
			break;
		case 'weekly':
			ttl = 1000 * 60 * 60 * 24 * 7;
			break;
		case 'monthly':
			ttl = 1000 * 60 * 60 * 24 * 30;
			break;
		case 'yearly':
			ttl = 1000 * 60 * 60 * 24 * 365;
			break;
		case 'never':
			ttl = 1000 * 60 * 60 * 24 * 365;
			break;
		default:
			ttl = defaultTtl;
			break;
	}
	return Math.max(ttl, minTtl);
}

/**
 * The action path both post-walk checks share: re-read each candidate, decide it, and — inside the
 * ceiling, and outside a dry run — hard-expire its cached pages and, for `render`, file it due now.
 *
 * ONE executor rather than one per check, because the action is the same action: a departing product
 * page and a rejoining one are both pages whose cached snapshot is known to disagree with what the
 * origin now says about availability. What differs is only how a candidate is decided (`decide`), which
 * ceiling and dry-run switch apply, and where the outcome is counted.
 *
 * `decide` answers `{ action, reason }` with `action` spelled as a `DepartureAction` — `ArrivalAction`
 * reuses those strings by construction (see util/routeClass.js), which is what lets one comparison
 * serve both.
 */
async function actOnWalkCandidates({ urls, decide, dryRun, maxActions, count }) {
	let acted = 0;

	await applyInBatches({
		items: urls,
		apply: async (url) => {
			const target = await Target.get({
				id: url,
				// `sitemapUrl` is the shear guard (departures) and the still-listed check (arrivals),
				// `state` keeps suppressed targets out — except, for an arrival, a GONE-suppressed one, which
				// `suppressedReason` identifies (util/goneReopen.js) — and the two cadence fields are what
				// `resolveEffectiveInterval` needs to file a rung-correct row.
				select: ['url', 'sitemapUrl', 'state', 'suppressedReason', 'renderInterval', 'demandInterval'],
			});

			const { action, reason } = decide({ url, target });
			if (action === DepartureAction.NONE) {
				count(reason);
				return;
			}

			// Check and increment in ONE synchronous block. `applyInBatches` runs a batch's items in
			// parallel, so a check that awaited anything before incrementing would let a whole batch
			// through a cap of one.
			if (acted >= maxActions) {
				count('capped');
				return;
			}
			acted++;

			if (dryRun) {
				count(`would-${action}`);
				return;
			}

			// HARD-expired, past the stale-while-revalidate window rather than to `now`. A plain
			// `Date.now()` expiry leaves the page 'swr' (`util/pageFreshness.js`), i.e. still SERVING
			// for another `page.swrTtl` — and the swr window exists to smooth over a late re-render of
			// content presumed still right, which is exactly what a departed (or rejoined) product page
			// is not. This matches `changeProbe.actOnChange`, which backdates for the same reason;
			// `Target.revalidate` keeps the plain expiry deliberately, because an operator asking for
			// a re-render is not asserting the content is wrong.
			const nowMs = Date.now();
			const hardExpiredAt = nowMs - config.page.swrTtl;
			await Promise.all(
				cacheKeysOf(url).map(async (cacheKey) => {
					const page = await PrerenderedPage.get({ id: cacheKey, select: ['cacheKey', 'expiresAt'] });
					if (!page) return;
					// Already past it (the probe expired it earlier tonight): one replicated write per page per
					// fact, not per signal. The key rides the patch — see `pruneSitemapTargets`.
					const expiresAt = dateColumnMs(page.expiresAt);
					if (Number.isFinite(expiresAt) && expiresAt <= hardExpiredAt) return;
					await PrerenderedPage.patch(cacheKey, { cacheKey, expiresAt: hardExpiredAt });
				})
			);

			if (action === DepartureAction.RENDER) {
				// FILED THE WAY THE PROBE FILES A DETECTED CHANGE (changeProbe.actOnChange), because it is one:
				// the page was just hard-expired as known to disagree with the origin. A plain schedule put here
				// entered the row at lateness zero with no change mark — behind every late row, while its page
				// was already answering from the origin — and REPLACED the row, erasing a `changedAt` and
				// `demandPeriod` the probe had filed for the same page that night. `fileDueNow` files at the
				// current minute PER URL (never a minute captured once for the pass — the Target.revalidate
				// lesson), never later than the row already was, and keeps a mark's first instant.
				const demand = demandOf(url, nowMs);
				await fileDueNow(url, {
					// Derived, never a literal. For a departure `decideDeparture` has already proved this
					// target has no attribution, so it can only evaluate false; for an arrival
					// `decideArrival` has proved it has one, so it can only evaluate true. The literal
					// `false` is what `test/queueFunnel.test.js` forbids outright, and for a good reason:
					// the derivation stays correct if either guard ever moves, where a literal would
					// silently mis-flag a URL the day someone loosened the check above it.
					fromSitemap: !!target.sitemapUrl,
					effectiveInterval: resolveEffectiveInterval(url, target),
					changedAt: nowMs,
					demandPeriod: demand.known ? demand.periodMs : undefined,
				});
			}
			count(action);
		},
	});
}

/** An outcome tally as one log fragment: "render 3, reattached 12". */
const summarizeOutcomes = (outcomes) =>
	Object.entries(outcomes)
		.map(([name, count]) => `${name} ${count}`)
		.join(', ');

/**
 * The post-walk departure check: decide, and act on, the URLs this walk unlinked.
 *
 * Runs once per walk, after every child, because a URL that shifted to a LATER child of a
 * paginated index is pruned before the child that now claims it is reached — mid-walk it is
 * indistinguishable from one that genuinely left. `decideDeparture` re-reads each candidate and
 * drops anything that picked up an attribution in the meantime; see util/sitemapDeparture.js for
 * why that guard is the load-bearing part.
 *
 * Every candidate is decided and counted, including the ones nothing happens to, so a dry run
 * answers the question a deployment actually has before enabling this: how many URLs a real walk
 * would touch, and how many of the departures are shear rather than departure.
 *
 * A candidate refused by `maxActions` is counted `capped` and is gone for good — the walk already
 * unlinked it, so no later walk offers it again. `maxActions: -1` removes the ceiling.
 *
 * Exported for tests.
 */
export async function processDepartures(run) {
	// A FAILED CHILD HOLDS BACK ONLY THE URLS THAT COULD HAVE MOVED INTO IT. A paginated index shears
	// forward: a URL that moved from child k into child k+1 is unlinked by k's prune and re-attached only
	// when k+1 is reached — and if k+1 failed (a 503, a truncated body, a refused short document)
	// nothing re-attaches it. It would read as departed here: its page hard-expired and filed to render,
	// and on the NEXT walk, re-attached with this walk's stamp, read as a rejoin and rendered again. So
	// those URLs are put back instead (`relinkHeld`) and the next walk decides. Which URLs "could have"
	// is judged by route, from the routes the failed child's row holds (`heldBlockedByFailures`): a 404 on a
	// store-locator sitemap says nothing about product pages, and must not hold every product departure
	// in the walk back with it.
	const blocked = run.walkFailed() ? await heldBlockedByFailures(run) : new Set();
	if (blocked.size) await relinkHeld(run, blocked);

	const urls = run.departureCandidates().filter((url) => !blocked.has(url));
	if (!urls.length) return;

	const { dryRun } = config.sitemap.departure;
	await actOnWalkCandidates({
		urls,
		// A URL `reattachToUnchangedListers` put back is re-attached like shear, but for a different reason
		// worth telling apart: a second child still lists it.
		decide: (candidate) =>
			candidate.target?.sitemapUrl && run.isListedUnchanged(candidate.url)
				? { action: DepartureAction.NONE, reason: 'listed-unchanged' }
				: decideDeparture(candidate),
		dryRun,
		// Through `departureLimit`, never raw: -1 is "no ceiling", and `acted >= -1` would refuse all.
		maxActions: departureLimit(config.sitemap.departure.maxActions),
		count: (outcome) => run.countDeparture(outcome),
	});

	const { considered, capped, outcomes } = run.snapshot().departures;
	const summary = summarizeOutcomes(outcomes);
	logger.info(
		`[prerender] Departure check: ${considered} candidates` +
			`${capped ? ' (CAPPED at maxCandidates — the departed URLs past it were never checked, and no later walk will offer them)' : ''}` +
			`${dryRun ? ', DRY RUN' : ''} — ${summary || 'nothing to do'}`
	);

	recordDepartureGauges(outcomes);
}

/** One `sitemap_departure_<outcome>` series per outcome. Guarded: a counter must never cost the run its result. */
function recordDepartureGauges(outcomes) {
	try {
		for (const [name, count] of Object.entries(outcomes)) {
			metrics.sitemapRun(count, `departure_${name.replace(/-/g, '_')}`);
		}
	} catch (e) {
		logger.warn(`[prerender] sitemap departure gauges not recorded: ${describeError(e)}`);
	}
}

/** The ROUTE a URL belongs to, as the key a child row's `routes` set holds (util/sitemap.js `routeKey`). */
const routeKeyOf = (url) => routeKey(classifyUrl(url));

/**
 * The routes a stored child row holds: its `routes` set, written from EVERY entry on each successful
 * parse, else — a row stored before that existed — whatever its leading entry sample covers. The sample
 * alone missed a mixed child whose first 500 entries share one route and whose rest are on another.
 */
const storedRoutes = (row) => {
	const routes = new Set();
	if (Array.isArray(row?.routes) && row.routes.length) {
		for (const key of row.routes) if (typeof key === 'string') routes.add(key);
		return routes;
	}
	for (const entry of Array.isArray(row?.entries) ? row.entries : []) {
		if (typeof entry?.loc === 'string' && URL.canParse(entry.loc)) routes.add(routeKeyOf(entry.loc));
	}
	return routes;
};

/**
 * What one failed document could have received: the routes it holds (a sub-index: its stored
 * children's), else — a document never stored, so nothing is known of its content — every URL whose
 * previous child was its SIBLING, else everything.
 */
async function failureScope(url, parentUrl) {
	const select = ['url', 'isIndex', 'entries', 'routes'];
	const row = await Sitemap.get({ id: url, select });
	const routes = new Set();
	if (row && !row.isIndex) for (const key of storedRoutes(row)) routes.add(key);
	if (row?.isIndex) {
		for (const child of await sitemapDescendants(url)) {
			const childRow = await Sitemap.get({ id: child, select });
			if (childRow && !childRow.isIndex) for (const key of storedRoutes(childRow)) routes.add(key);
		}
	}
	if (routes.size) return { routes };
	return parentUrl === undefined || parentUrl === null ? { all: true } : { siblingsOf: parentUrl };
}

/** The held URLs any of this walk's failed documents could have received (see `processDepartures`). */
async function heldBlockedByFailures(run) {
	const held = run.heldUnlinked();
	const blocked = new Set();
	if (!held.length) return blocked;
	const routes = new Set();
	const parents = new Set();
	for (const { url, parentUrl } of run.failedChildren()) {
		const scope = await failureScope(url, parentUrl);
		if (scope.all) {
			for (const entry of held) blocked.add(entry.url);
			return blocked;
		}
		for (const key of scope.routes ?? []) routes.add(key);
		if (scope.siblingsOf !== undefined) parents.add(scope.siblingsOf);
	}
	for (const { url, sitemapUrl } of held) {
		if (routes.has(routeKeyOf(url)) || (parents.size && parents.has(run.parentOf(sitemapUrl)))) blocked.add(url);
	}
	return blocked;
}

/**
 * Undo this walk's unlink of each `blocked` held URL: back to the child that unlinked it, stamp
 * cleared — exactly the row it had before the walk, since the prune only ever unlinks a URL that was
 * listed. Counted as the departure outcome `relinked`, beside `reattached` (a later child claimed it
 * after all) and `target-gone`. NOT gated by `sitemap.departure.dryRun`: this is not a departure action
 * but the correction of the walk's own write, and it is what keeps the next walk from reading every
 * re-linked URL as a rejoin.
 *
 * The children that unlinked something lose their stored validator, so the next walk fetches them
 * unconditionally: re-linked, a URL that really did move stays attributed to its old child — and is
 * DUPLICATE to the child that now lists it — until the old child's prune runs again, which a 304 would
 * put off until `sitemap.conditional.fullPassInterval`.
 *
 * URLs the walk unlinked past `holdCap` were never held and stay unlinked; the next walk re-attaches
 * them as a move, and — carrying this walk's stamp — as a rejoin. `departures.capped` says it happened.
 */
async function relinkHeld(run, blocked) {
	const unconditional = new Set();
	await applyInBatches({
		items: run.heldUnlinked().filter(({ url }) => blocked.has(url)),
		apply: async ({ url, sitemapUrl }) => {
			const target = await Target.get({ id: url, select: ['url', 'sitemapUrl'] });
			if (!target) return run.countDeparture('target-gone');
			if (target.sitemapUrl) return run.countDeparture('reattached');
			if (!sitemapUrl) return run.countDeparture('unknown-child');
			await Target.patch(url, { url, sitemapUrl, unlistedAt: null });
			unconditional.add(sitemapUrl);
			run.noteRelinked(sitemapUrl);
			run.countDeparture('relinked');
		},
	});
	for (const sitemapUrl of unconditional) {
		// Read first: a patch of a missing row would create one with no `parentUrl`, i.e. a new ROOT.
		if (await Sitemap.get({ id: sitemapUrl, select: ['url'] })) {
			await Sitemap.patch(sitemapUrl, { url: sitemapUrl, lastModified: null });
		}
	}

	const { failed, failedOverflow } = run.snapshot();
	logger.warn(
		`[prerender] Departure check HELD BACK ${blocked.size} URL(s): ${failed.length + failedOverflow} child ` +
			`sitemap(s) failed that they could have moved into, so they were re-linked for the next walk to decide`
	);
}

/** Does a departure or an arrival action care whether this URL is listed? */
const hasWalkAction = (url) =>
	departureActionFor(url) !== DepartureAction.NONE || arrivalActionFor(url) !== DepartureAction.NONE;

/**
 * Re-attach a URL the walk unlinked to a child that still lists it but answered 304.
 *
 * A URL listed by two children is owned by the first (`actionForExisting`, first writer wins). When the
 * owner drops it, its prune unlinks it — and the other child, unchanged, answered 304, so its entries
 * were never read and nothing re-attaches it: it reads as departed while still declared, and heals on
 * that child's next full pass, counted as a rejoin. So once the walk is over, a 304'd urlset that could
 * list such a URL is fetched unconditionally, parsed (no reconcile, no write to its row), and every one
 * it lists is re-attached to it — attribution only, as any re-attach is. Reported as the departure
 * outcome `listed-unchanged`.
 *
 * NARROWED BEFORE ANYTHING IS FETCHED, because a product child is megabytes and ~0.3s of parse on the
 * worker that also serves bots. Only held URLs that are STILL unattributed once the walk is over (shear
 * already re-attached the rest) and whose route has a departure or arrival action (nothing else acts on
 * a false unlink) are pending; with none, nothing is fetched. And only a child whose stored routes
 * include one of theirs is re-read. One retry per child, since a transient error here would
 * otherwise hold its route's departures back for a walk; a second failure is a failed child, which
 * holds back only the pending URLs it could list (`heldBlockedByFailures`).
 */
async function reattachToUnchangedListers(run, rootSitemapUrl) {
	const unchanged = run.unchangedUrlsets();
	if (!unchanged.length) return;
	const actionable = run.heldUnlinked().filter(({ url }) => hasWalkAction(url));
	if (!actionable.length) return;

	const pending = new Set();
	await applyInBatches({
		items: actionable,
		apply: async ({ url }) => {
			const target = await Target.get({ id: url, select: ['url', 'sitemapUrl'] });
			if (target && !target.sitemapUrl) pending.add(url);
		},
	});

	for (const childUrl of unchanged) {
		if (!pending.size) return;
		const pendingRoutes = new Set([...pending].map(routeKeyOf));
		const stored = await Sitemap.get({ id: childUrl, select: ['url', 'entries', 'routes'] });
		const routes = storedRoutes(stored);
		if (routes.size && ![...routes].some((key) => pendingRoutes.has(key))) continue;

		const latest = await fetchLatestSitemap(childUrl, { rootSitemapUrl })
			.catch(() => fetchLatestSitemap(childUrl, { rootSitemapUrl }))
			.catch((e) => {
				logger.error(`[prerender] Sitemap ${childUrl} could not be re-read for its listings: ${describeError(e)}`);
				run.addFailure(childUrl, e);
				return null;
			});
		if (!latest || latest.isIndex) continue;
		const { incoming } = partitionSitemapEntries(latest.entries);
		const listed = [...pending].filter((url) => incoming.has(url));
		for (const url of listed) pending.delete(url);
		await applyInBatches({
			items: listed,
			apply: async (url) => {
				const target = await Target.get({ id: url, select: ['url', 'sitemapUrl'] });
				if (!target || target.sitemapUrl) return;
				await Target.patch(url, { url, sitemapUrl: childUrl, unlistedAt: null });
				run.noteListedUnchanged(url);
			},
		});
	}
}

/**
 * The post-walk arrival action: act on the URLs this walk found REJOINING a sitemap.
 *
 * Which URLs those are was settled during the walk — `isRejoin` compared each re-attached target's
 * `unlistedAt` against this walk's start, which is what keeps same-walk shear out — so this only
 * re-reads each one, applies `decideArrival`, and hands it to the executor departures use, under
 * `sitemap.arrival`'s own dry-run switch and ceilings. See util/sitemapArrival.js.
 *
 * Reported in the run tally and the progress row (`arrivals`) and in the log, NOT as metric series:
 * the tally carries every outcome already, and a new `sitemap_*` family is a console change (its
 * metric-coverage guard reads these emit sites) that belongs with a panel to show it on.
 *
 * Exported for tests.
 */
export async function processArrivals(run) {
	const urls = run.arrivalCandidates();
	if (!urls.length) return;

	const { dryRun } = config.sitemap.arrival;
	await actOnWalkCandidates({
		urls,
		decide: decideArrival,
		dryRun,
		maxActions: departureLimit(config.sitemap.arrival.maxActions),
		count: (outcome) => run.countArrival(outcome),
	});

	const { considered, capped, outcomes } = run.snapshot().arrivals;
	logger.info(
		`[prerender] Arrival check: ${considered} rejoined` +
			`${capped ? ' (CAPPED at maxCandidates — the rejoins past it were never checked, and no later walk will offer them)' : ''}` +
			`${dryRun ? ', DRY RUN' : ''} — ${summarizeOutcomes(outcomes) || 'nothing to do'}`
	);
}

/**
 * May a sitemap fetch of `url` carry the origin-bypass token (and take the staging pin)?
 *
 * Only over https, and only to a host this deployment serves: the root sitemap's own host, or one named
 * in `domains`. A child on any other host is fetched WITHOUT the token — an edge that requires it answers
 * 403, which is a failed child like any other. The token
 * used to ride EVERY sitemap fetch with `redirect: 'follow'` — and undici keeps custom headers across a
 * cross-origin redirect, so an index listing a third-party child, or a child 301ing to another host,
 * handed the bypass secret to whoever answered (reproduced: a 301 to another host received the header
 * verbatim). The same rule the render path follows: the token goes to the navigation origin, never to a
 * third-party host.
 */
const mayCarryToken = (url, rootSitemapUrl) => {
	const parsed = URL.parse(url);
	const host = parsed?.hostname;
	if (!host) return false;
	// And never in cleartext: a same-host `http://` child, or an https -> http redirect, would hand the
	// secret to every hop on the path. A local origin is the one exception, as it is for the queue's own
	// URLs: there is no wire to read it from.
	if (parsed.protocol !== 'https:' && !LOCAL_HOSTS.has(host)) return false;
	return host === URL.parse(rootSitemapUrl)?.hostname || config.domains.includes(host);
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const isRedirect = (status) => status === 301 || status === 302 || status === 303 || status === 307 || status === 308;

async function fetchLatestSitemap(url, { ifModifiedSince = null, rootSitemapUrl = url } = {}) {
	// Route every Harper→origin sitemap fetch through the same edge as the render/origin-fetch
	// path: whenever a staging IP is configured, pin the TCP connection to it (Host/SNI stay the
	// real origin, exactly like upstream.js). The security token typically only authenticates
	// against the staging edge, so a direct prod fetch is bounced with a 403 "Access Denied".
	// Empty staging.ip → normal direct fetch (production, once the token is valid at the origin).
	// Both apply only to a host that may carry the token (`mayCarryToken`): the staging edge fronts
	// this deployment's hosts, not a third party's.
	//
	// Redirects are followed HERE, `redirect: 'manual'`, a bounded number of hops, so the token and the
	// pin are decided again for every hop's host rather than inherited from the first.
	let current = url;
	let res;
	let via = '';
	for (let hop = 0; ; hop++) {
		const trusted = mayCarryToken(current, rootSitemapUrl);
		const stagingIp = trusted ? configuredStagingIp() : undefined;
		via = stagingIp ? ` (via staging ${stagingIp})` : '';

		res = await fetch(current, {
			method: 'GET',
			redirect: 'manual',
			headers: {
				'User-Agent': config.sitemap.userAgent,
				...(trusted ? { [config.origin.securityToken.header]: config.origin.securityToken.value } : {}),
				// Echoed back VERBATIM from the stored row — see the schema comment. Absent on the first
				// fetch of a document, when the origin sends no validator, and whenever the caller wants a
				// full re-ingest.
				...(ifModifiedSince ? { 'If-Modified-Since': ifModifiedSince } : {}),
			},
			dispatcher: dispatcherFor(stagingIp),
		});

		if (!isRedirect(res.status)) break;
		const location = res.headers.get('location');
		// Released, not read: a redirect body is never the document.
		await res.body?.cancel().catch(() => {});
		const next = location ? URL.parse(location, current) : null;
		if (!next || (next.protocol !== 'https:' && next.protocol !== 'http:')) {
			throw new Error(`Sitemap fetch for ${url}${via}: ${res.status} with no usable Location (${location ?? 'none'})`);
		}
		if (hop >= MAX_SITEMAP_REDIRECTS) {
			throw new Error(
				`Sitemap fetch for ${url}${via}: more than ${MAX_SITEMAP_REDIRECTS} redirects (last ${next.href})`
			);
		}
		current = next.href;
	}

	// BEFORE the `res.ok` guard, because 304 is not ok: `Response.ok` is 200-299, so a
	// not-modified would otherwise be thrown as a failed fetch. Nothing else to read — a 304 has no
	// body — and nothing to write: the stored row is still current, validator included.
	if (res.status === 304) return { url, notModified: true };

	const xml = await res.text();

	// A blocked/errored fetch returns an HTML error page with a 4xx/5xx status. Guard the
	// status AND the parsed shape so it fails loudly instead of being silently treated as an
	// empty sitemap (which used to return a misleading `created: 0` success).
	if (!res.ok) {
		throw new Error(`Sitemap fetch failed for ${url}${via}: ${res.status} ${res.statusText} — ${snippet(xml)}`);
	}

	let parsed;
	try {
		parsed = parseSitemap(xml);
	} catch (e) {
		const contentType = res.headers.get('content-type') ?? 'unknown';
		throw new Error(
			`Sitemap fetch for ${url}${via} returned a non-sitemap response (status ${res.status}, content-type ${contentType}): ${e.message} — ${snippet(xml)}`
		);
	}

	return {
		url,
		notModified: false,
		lastRefreshed: new Date(),
		isIndex: parsed.isIndex,
		entries: parsed.entries,
		entryCount: parsed.entries.length,
		// Null where the origin sends none, which makes every later fetch of this document
		// unconditional — the correct degradation, not an error.
		lastModified: res.headers.get('last-modified') ?? null,
	};
}

// A short, single-line excerpt of a response body for error messages. Slice before the
// whitespace-collapse so a large body (a full sitemap can be >1 MB) doesn't run the regex
// over the whole string.
function snippet(body, max = 200) {
	const raw = String(body ?? '');
	const truncated = raw.length > max * 2 ? raw.slice(0, max * 2) : raw;
	const text = truncated.replace(/\s+/g, ' ').trim();
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

let sitemapSchedulerStarted = false;
let sitemapPendingTimer = null;
let sitemapArmedKey = null; // `${refreshTime}|${timezone}|${refreshInterval}` while scheduled, null while not

// This node+worker runs the scheduled refresh only while it is the pinned one. Live:
// re-pinning via config (node, workerIndex) starts/stops the scheduler without a restart.
const isPinnedHere = () =>
	!!config.sitemap.node && config.sitemap.node === server.hostname && config.sitemap.workerIndex === server.workerIndex;

// Introspection for tests and the management API: what the pending refresh is armed with
// (`armedKey: null` = not scheduled on this worker).
export const sitemapSchedulerState = () => ({ started: sitemapSchedulerStarted, armedKey: sitemapArmedKey });

/**
 * Start the scheduled sitemap refresh, pinned to the configured node + worker. Called from
 * handleApplication after config is applied. Every worker subscribes; only the pinned
 * one holds a timer. `sitemap.node`/`workerIndex`/`refreshTime`/`timezone`/`refreshInterval`
 * are all live: changing any of them re-schedules (or stops) the pending refresh on the next
 * config apply. Idempotent.
 *
 * Runs happen on a grid of `refreshInterval`-spaced slots anchored on `refreshTime` — see
 * `getNextIntervalSlot`. Only ONE timer is ever held (a fresh one is armed after each run),
 * deliberately, rather than a `setInterval` at the configured period: a walk that outruns its
 * slot must skip to the next one, and re-computing the slot from the wall clock each time is
 * also what keeps the schedule from drifting by a walk-length on every pass.
 */
export function startSitemapRefreshScheduler() {
	if (sitemapSchedulerStarted) return;
	sitemapSchedulerStarted = true;

	let isRefreshing = false;

	const refreshAllSitemaps = async () => {
		if (isRefreshing) return;
		isRefreshing = true;

		try {
			logger.info('Starting sitemap refresh');

			// Roots only, and sequential: an index walks its own children, so including them here
			// too doubled every fetch, point read and write in the pass.
			for (const url of await rootSitemapUrls()) {
				const claim = await claimRefreshRun(url);
				if (!claim.ok) {
					logger.info(`[prerender] Skipping scheduled refresh of ${url}: ${claim.reason}`);
					continue;
				}
				// Already logged and recorded on the progress row; one bad root must not stop the rest.
				await runTrackedRefresh(url).catch(() => {});
			}

			await databases.sitemaps.SitemapRefresh.put('all', { lastRefreshed: Date.now() });
		} catch (e) {
			logger.error(e);
		}

		isRefreshing = false;

		// Re-checks the pin: if it moved while this run was in flight, no new timer is armed here.
		scheduleNextRefresh();
	};

	const scheduleNextRefresh = () => {
		if (sitemapPendingTimer) clearTimeout(sitemapPendingTimer);
		sitemapPendingTimer = null;
		sitemapArmedKey = null;
		if (!isPinnedHere()) return;

		sitemapArmedKey = `${config.sitemap.refreshTime}|${config.sitemap.timezone}|${config.sitemap.refreshInterval}`;
		sitemapPendingTimer = setTimeout(refreshAllSitemaps, getNextSitemapRefreshTime() - Date.now());
		sitemapPendingTimer.unref?.();
	};

	const sync = () => {
		const desiredKey = isPinnedHere()
			? `${config.sitemap.refreshTime}|${config.sitemap.timezone}|${config.sitemap.refreshInterval}`
			: null;
		if (desiredKey === sitemapArmedKey) return;
		scheduleNextRefresh();
	};

	scheduleNextRefresh();
	onConfigApplied(sync);
}
