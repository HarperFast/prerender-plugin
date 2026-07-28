import { config } from '../config.js';
import { RenderTarget } from './RenderTarget.js';
import { CacheKey } from '../util/cacheKey.js';
import { classifyUrl, PASSTHROUGH, PRERENDER, UNCLASSIFIED } from '../util/routeClass.js';
import { currentMinuteMs, getNextSitemapRefreshTime } from '../util/time.js';
import { parseSitemap, partitionSitemapEntries, sitemapTargetNeedsUpdate } from '../util/sitemap.js';
import { configuredStagingIp, dispatcherFor } from '../util/upstream.js';
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

	static async refresh(rootSitemapUrl, { revalidate = false, deviceTypes = config.deviceTypes.default } = {}) {
		let created = 0;
		let updated = 0;
		let skipped = 0;
		// Entries dropped because they are not a prerender path, and existing targets for such
		// URLs that this pass deliberately left in place for the reconcile sweep to retire.
		const filteredTotals = { [PASSTHROUGH]: 0, [UNCLASSIFIED]: 0 };
		let deferred = 0;
		const removed = [];

		const visited = new Set();

		const queue = [rootSitemapUrl];

		while (queue.length) {
			let qLen = queue.length;

			while (qLen--) {
				const sitemapUrl = queue.shift();

				if (visited.has(sitemapUrl)) continue;

				visited.add(sitemapUrl);

				logger.info(`Processing sitemap`, sitemapUrl);

				const latestSitemap = await fetchLatestSitemap(sitemapUrl);

				if (latestSitemap.isIndex === true) {
					for (const { loc } of latestSitemap.entries) {
						queue.push(loc);
					}
				} else if (latestSitemap.entries?.length) {
					let inflight = [];

					// Keep only the URLs this deployment actually prerenders, keyed by the canonical
					// URL-half the bot read uses — so the prune diff below and the target keys built
					// later both match what a request will look up. Everything else is counted and
					// dropped rather than turned into a target that renders into a key no read
					// computes. See util/sitemap.js.
					const { incoming: incomingEntryMap, filtered, invalid } = partitionSitemapEntries(latestSitemap.entries);

					for (const { loc, message } of invalid) {
						logger.warn(`Skipping invalid sitemap entry ${loc}: ${message}`);
					}
					reportFiltered(sitemapUrl, filtered, latestSitemap.entries.length);
					filteredTotals[PASSTHROUGH] += filtered[PASSTHROUGH];
					filteredTotals[UNCLASSIFIED] += filtered[UNCLASSIFIED];

					// Two-phase, and NOT because of event-loop fairness alone: this loop used to issue
					// `RenderTarget.patch` from inside the open search cursor. Harper's long-transaction
					// monitor aborts (422, poisoned) any transaction that has writes pending when it fires,
					// so on a large sitemap the refresh could die partway through with some targets already
					// unlinked. Collect while reading, write once the cursor is closed — see util/scan.js.
					//
					// The collect step is also where the filtered-vs-departed distinction is made. Absent
					// from the incoming map means one of two very different things, and conflating them is
					// what would turn every filtered URL into an orphan:
					//   - it left the sitemap        -> unlink it, as before
					//   - it was FILTERED just above -> leave it alone
					// Unlinking is `patch`, which bypasses the overridden `put` and so leaves the
					// RenderSchedule row intact: the target keeps rendering on its interval with nothing
					// tracking it and no sitemap to bring it back. Fine for a URL that genuinely left the
					// sitemap (that is the pre-existing discovery-target shape), but applied to a filtered
					// URL it would silently convert this pass's entire filtered set into
					// permanently-rendering, unattributable targets — the exact load the filter removes.
					//
					// Retiring them is deliberately NOT done here. Deleting targets needs the guardrails the
					// reconcile sweep will carry (refuse when no prerender routes compile, a ceiling on how
					// much one pass may retire), not an ingest pass that would act on whatever the route
					// list happened to say this morning.
					const { items: departed } = await collectFromScan({
						scan: () =>
							RenderTarget.search({
								select: ['cacheKey', 'renderInterval', 'sitemapUrl'],
								conditions: [{ attribute: 'sitemapUrl', value: sitemapUrl }],
							}),
						pick: (target) => {
							const parsed = CacheKey.parse(target.cacheKey);
							if (incomingEntryMap.has(parsed.url)) return null;
							if (classifyUrl(parsed.url).routeClass !== PRERENDER) {
								deferred++;
								return null;
							}
							return target;
						},
					});

					await applyInBatches({
						items: departed,
						apply: (target) => RenderTarget.patch(target.cacheKey, { sitemapUrl: null }),
					});
					removed.push(...departed);

					for (const [cacheUrl, { changefreq }] of incomingEntryMap) {
						const renderInterval = getTtlFromChangeFreq(changefreq, {
							minTtl: config.page.minTtl,
							defaultTtl: config.page.ttl,
						});

						for (const deviceType of deviceTypes) {
							let updateTarget = false;

							const cacheKey = CacheKey.toCacheKey({ url: cacheUrl, deviceType });

							if (revalidate) {
								updateTarget = true;
								created++;
							} else {
								// Only `sitemapUrl` is needed here; avoid materializing the full
								// record for every entry × deviceType in this bulk loop.
								//
								// MUST be an array select. A string select projects to the bare VALUE,
								// not a record, so `existingTarget.sitemapUrl` read `undefined` off a
								// string and `updateTarget` was therefore always true: every known
								// target was re-put on every refresh, and since `RenderTarget.put`
								// recomputes `getInitialRenderTime` (now + jitter), each refresh pushed
								// the next render FORWARD. Any target whose interval exceeds the refresh
								// period — changefreq weekly, monthly, yearly — was reset before it ever
								// came due and so never re-rendered at all.
								const existingTarget = await RenderTarget.get({ id: cacheKey, select: ['sitemapUrl'] });

								if (existingTarget) {
									updateTarget = sitemapTargetNeedsUpdate(existingTarget, sitemapUrl);
									if (updateTarget) {
										updated++;
									}
								} else {
									created++;
									updateTarget = true;
								}
							}

							if (updateTarget) {
								// Explicit revalidate renders now; a newly-discovered target omits the
								// time so RenderTarget.put jitters its first render across the interval,
								// keeping bulk sitemap population from stampeding the queue.
								inflight.push(
									RenderTarget.put(cacheKey, {
										renderInterval,
										sitemapUrl,
										nextRenderTime: revalidate ? currentMinuteMs() : undefined,
									})
								);
							} else {
								skipped++;
							}

							// Drain the WHOLE batch, not just the most recent promise. This used to await
							// `lastPromise` alone, which left up to 49 writes still in flight — and Harper's
							// long-transaction monitor aborts (422, poisoned) any transaction that has writes
							// pending when it fires, so a slow batch could kill the refresh partway through.
							// Awaiting every promise in the batch is what makes "no pending writes across a
							// monitor tick" actually true. See util/scan.js.
							if (inflight.length >= config.scan.batchSize) {
								await Promise.all(inflight);
								inflight = [];
								await new Promise(setImmediate);
							}
						}
					}

					if (inflight.length > 0) {
						await Promise.all(inflight);
						inflight = [];
					}
				}

				await Sitemap.put(sitemapUrl, latestSitemap);
			}
		}

		return { created, updated, skipped, removed, filtered: filteredTotals, deferred };
	}

	async post(options = {}) {
		const urls = [];
		const paramUrl = this.getId();

		if (paramUrl) {
			urls.push(paramUrl);
		} else {
			for await (const url of Sitemap.search({ select: 'url' })) {
				urls.push(url);
			}
		}

		const results = [];

		for (const url of urls) {
			logger.info(`Scheduling refresh for sitemap`, url);
			const result = await Sitemap.refresh(url, options);
			results.push(result);
		}

		return results;
	}

	/**
	 * Two-phase for the same reason as RenderTarget.revalidate: deleting from inside the open
	 * search cursor leaves writes pending while the cursor is open, which the long-transaction
	 * monitor aborts (422) partway through on a large sitemap. See util/scan.js.
	 */
	async delete() {
		const url = this.getId();

		const { items: cacheKeys } = await collectFromScan({
			scan: () => RenderTarget.search({ conditions: [{ attribute: 'sitemapUrl', value: url }], select: 'cacheKey' }),
			pick: (cacheKey) => cacheKey,
		});

		await applyInBatches({ items: cacheKeys, apply: (cacheKey) => RenderTarget.delete(cacheKey) });

		return super.delete(...arguments);
	}
}

export const sitemaps = Sitemap;

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
	// Route every Harper→origin sitemap fetch through the same edge as the render/origin-fetch
	// path: whenever a staging IP is configured, pin the TCP connection to it (Host/SNI stay the
	// real origin, exactly like upstream.js). The security token typically only authenticates
	// against the staging edge, so a direct prod fetch is bounced with a 403 "Access Denied".
	// Empty staging.ip → normal direct fetch (production, once the token is valid at the origin).
	const stagingIp = configuredStagingIp();
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

			const urls = await Array.fromAsync(Sitemap.search({ select: 'url' }));

			for (const url of urls) {
				try {
					await Sitemap.refresh(url);
				} catch (e) {
					logger.error(e);
				}
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
