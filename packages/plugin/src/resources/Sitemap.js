import { config } from '../config.js';
import { describeError } from '../util/errors.js';
import { Target } from './Target.js';
import { classifyUrl, PASSTHROUGH, PRERENDER, UNCLASSIFIED } from '../util/routeClass.js';
import { currentMinuteMs, epochMsOf, getNextSitemapRefreshTime } from '../util/time.js';
import { parseSitemap, partitionSitemapEntries } from '../util/sitemap.js';
import { actionForExisting, canSkipLookup, createRefreshRun, TargetAction } from '../util/sitemapRun.js';
import { dispatcherFor, sitemapStagingIp } from '../util/upstream.js';
import { setImmediate } from 'node:timers/promises';
import { applyInBatches, collectFromScan } from '../util/scan.js';

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
		const run = createRefreshRun({
			removedSampleCap: config.sitemap.removedSampleCap,
			failedCap: config.sitemap.failedCap,
		});
		const visited = new Set();
		const queue = [{ url: rootSitemapUrl, parentUrl: null }];
		run.count('sitemapsDiscovered');

		while (queue.length) {
			const { url: sitemapUrl, parentUrl } = queue.shift();

			if (visited.has(sitemapUrl)) continue;
			visited.add(sitemapUrl);

			try {
				const children = await refreshOneSitemap(sitemapUrl, { parentUrl, revalidate, run, visited });
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
				run.addFailure(sitemapUrl, e);
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
			results.push(await runTrackedRefresh(url, refreshOptions));
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
		void runTrackedRefresh(only, refreshOptions).catch(() => {});
		return { background: true, sitemaps: [{ url: only, started: true, progress: progressPath(only) }] };
	}

	void (async () => {
		for (const root of urls) {
			const claim = await claimRefreshRun(root);
			if (!claim.ok) {
				logger.info(`[prerender] Skipping sitemap ${root}: ${claim.reason}`);
				continue;
			}
			await runTrackedRefresh(root, refreshOptions).catch(() => {});
		}
	})();

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
	duplicates: snapshot.duplicates,
	deferred: snapshot.deferred,
	removed: snapshot.removed,
	failed: snapshot.failed,
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
			`[prerender] Sitemap refresh for ${rootUrl} finished: ${result.sitemapsProcessed} sitemaps, ` +
				`${result.created} created, ${result.updated} re-attributed, ${result.skipped} unchanged, ` +
				`${result.removed} unlinked, ${result.failed.length} failed`
		);

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
 */
async function refreshOneSitemap(sitemapUrl, { parentUrl, revalidate, run, visited }) {
	logger.info(`Processing sitemap`, sitemapUrl);

	const latestSitemap = await fetchLatestSitemap(sitemapUrl);
	const row = { ...latestSitemap, parentUrl };

	if (latestSitemap.isIndex === true) {
		await Sitemap.put(sitemapUrl, row);
		return latestSitemap.entries.map(({ loc }) => loc).filter(Boolean);
	}

	if (latestSitemap.entries?.length) {
		await reconcileSitemapEntries(sitemapUrl, latestSitemap, { revalidate, run, visited });
	}

	await Sitemap.put(sitemapUrl, row);
	return [];
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

/** Diff one `<urlset>` against the targets currently attributed to it, and apply the result. */
async function reconcileSitemapEntries(sitemapUrl, latestSitemap, { revalidate, run, visited }) {
	// Keep only the URLs this deployment actually prerenders, keyed by the canonical URL-half the
	// bot read uses — so the prune diff below and the target keys built later both match what a
	// request will look up. Everything else is counted and dropped rather than turned into a
	// target that renders into a key no read computes. See util/sitemap.js.
	const { incoming: incomingEntryMap, filtered, invalid } = partitionSitemapEntries(latestSitemap.entries);

	for (const { loc, message } of invalid) {
		logger.warn(`Skipping invalid sitemap entry ${loc}: ${message}`);
	}
	reportFiltered(sitemapUrl, filtered, latestSitemap.entries.length);
	run.addFiltered(filtered);

	// Two-phase, and NOT because of event-loop fairness alone: this loop used to issue
	// `Target.patch` from inside the open search cursor. Harper's long-transaction monitor
	// aborts (422, poisoned) any transaction that has writes pending when it fires, so on a large
	// sitemap the refresh could die partway through with some targets already unlinked. Collect
	// while reading, write once the cursor is closed — see util/scan.js.
	//
	// The collect step is also where the filtered-vs-departed distinction is made. Absent from the
	// incoming map means one of two very different things, and conflating them is what would turn
	// every filtered URL into an orphan:
	//   - it left the sitemap        -> unlink it, as before
	//   - it was FILTERED just above -> leave it alone
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
	// scan's own condition) already attributed to this sitemap, which is exactly what the entry
	// loop below would otherwise spend a point read per entry × device discovering. It is a cache,
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

	await applyInBatches({
		items: departed,
		apply: (target) => Target.patch(target.url, { sitemapUrl: null }),
	});
	run.addRemoved(departed);

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
		if (revalidate) {
			action = TargetAction.RENDER;
		} else if (canSkipLookup({ revalidate, knownKeys, key: cacheUrl })) {
			action = TargetAction.SKIP;
		} else {
			// Only reached for a URL the prune scan did not return: genuinely new, moved here
			// from another sitemap, or missed because `knownKeys` was capped. Only `sitemapUrl`
			// is needed, so don't materialize the whole record in a bulk loop.
			action = actionForExisting(await Target.get({ id: cacheUrl, select: ['sitemapUrl'] }), sitemapUrl, visited);
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

			case TargetAction.REATTACH:
				// Attribution changed, the page did not. `patch` leaves the RenderSchedule rows
				// alone; `put` would recompute `getInitialRenderTime` and shove the next render
				// forward by a fresh jitter every pass. See util/sitemapRun.js.
				run.count('updated');
				inflight.push(Target.patch(cacheUrl, { sitemapUrl, renderInterval }));
				break;

			case TargetAction.CREATE:
				// No explicit time, so Target.put jitters the first render across the
				// interval — bulk sitemap population must not stampede the queue.
				run.count('created');
				inflight.push(Target.put(cacheUrl, { renderInterval, sitemapUrl }));
				break;

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

async function fetchLatestSitemap(url) {
	// Pin the TCP connection to the staging edge when `sitemap.useStagingIp` + `staging.ip`
	// say so (Host/SNI stay the real origin, exactly like upstream.js). The flag exists because
	// the right edge differs per deployment: a token that only authenticates against the
	// staging edge needs the pin, while a token accepted on the production property can fetch
	// the real sitemap direct — `useStagingIp: false`. Either way the token is sent.
	const stagingIp = sitemapStagingIp();
	const via = stagingIp ? ` (via staging ${stagingIp})` : '';

	const res = await fetch(url, {
		method: 'GET',
		redirect: 'follow',
		headers: { 'User-Agent': config.sitemapUserAgent, [config.securityToken.header]: config.securityToken.value },
		dispatcher: dispatcherFor(stagingIp),
	});
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
		lastRefreshed: new Date(),
		isIndex: parsed.isIndex,
		entries: parsed.entries,
		entryCount: parsed.entries.length,
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

/**
 * Start the daily sitemap refresh, pinned to the configured node + worker. Called
 * from handleApplication after config is applied. No-op when `sitemap.node` is
 * empty or this node/worker is not the pinned one. Idempotent.
 */
export function startSitemapRefreshScheduler() {
	if (sitemapSchedulerStarted) return;
	if (!config.sitemap.node) return;
	if (config.sitemap.node !== server.hostname || config.sitemap.workerIndex !== server.workerIndex) return;

	sitemapSchedulerStarted = true;

	let isRefreshing = false;

	const refreshAllSitemaps = async () => {
		if (isRefreshing) return;
		isRefreshing = true;

		try {
			logger.info('Starting sitemap refresh');

			// Roots only, and sequential: an index walks its own children, so including them here
			// too doubled every fetch, point read and write in the daily pass.
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

		scheduleNextRefresh();
	};

	const scheduleNextRefresh = () => {
		const nextSitemapRefreshTime = getNextSitemapRefreshTime();
		setTimeout(refreshAllSitemaps, nextSitemapRefreshTime - Date.now()).unref?.();
	};

	scheduleNextRefresh();
}
