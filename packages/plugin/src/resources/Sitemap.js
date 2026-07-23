import { config } from '../config.js';
import { RenderTarget } from './RenderTarget.js';
import { CacheKey } from '../util/cacheKey.js';
import { canonicalizeUrl } from '../util/url.js';
import { queryAllowlistFor } from '../util/ingress.js';
import { currentMinuteMs, getNextSitemapRefreshTime } from '../util/time.js';
import { parseSitemap } from '../util/sitemap.js';
import { configuredStagingIp, dispatcherFor } from '../util/upstream.js';

class Sitemap extends databases.sitemaps.Sitemap {
	static directURLMapping = true;

	static async refresh(rootSitemapUrl, { revalidate = false, deviceTypes = config.deviceTypes.default } = {}) {
		let created = 0;
		let updated = 0;
		let skipped = 0;
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
					let inflightCount = 0;
					let lastPromise = null;

					// Key by the canonical URL-half (the same transform the bot-read path uses),
					// so both the prune diff below (against existing targets' parsed keys) and the
					// render-target keys built later match the key a bot request will look up.
					const incomingEntryMap = new Map(
						latestSitemap.entries.map((entry) => [canonicalizeUrl(entry.loc, queryAllowlistFor(entry.loc)), entry])
					);

					for await (const target of RenderTarget.search({
						select: ['cacheKey', 'renderInterval', 'sitemapUrl'],
						conditions: [{ attribute: 'sitemapUrl', value: sitemapUrl }],
					})) {
						const parsed = CacheKey.parse(target.cacheKey);
						if (!incomingEntryMap.has(parsed.url)) {
							lastPromise = RenderTarget.patch(target.cacheKey, {
								sitemapUrl: null,
							});
							inflightCount++;
							removed.push(target);

							if (inflightCount >= 50) {
								await lastPromise;
								inflightCount = 0;
							} else if (inflightCount % 20 === 0) {
								await new Promise(setImmediate);
							}
						}
					}

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
								const existingTarget = await RenderTarget.get({ id: cacheKey, select: 'sitemapUrl' });

								if (existingTarget) {
									updateTarget = existingTarget.sitemapUrl !== sitemapUrl;
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
								lastPromise = RenderTarget.put(cacheKey, {
									renderInterval,
									sitemapUrl,
									nextRenderTime: revalidate ? currentMinuteMs() : undefined,
								});
								inflightCount++;
							} else {
								skipped++;
							}

							if (inflightCount >= 50) {
								await lastPromise;
								inflightCount = 0;
							} else if (inflightCount % 20 === 0) {
								await new Promise(setImmediate);
							}
						}
					}

					if (inflightCount > 0) {
						await lastPromise;
						inflightCount = 0;
					}
				}

				await Sitemap.put(sitemapUrl, latestSitemap);
			}
		}

		return { created, updated, skipped, removed };
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

	async delete() {
		const url = this.getId();

		const it = RenderTarget.search({ conditions: [{ attribute: 'sitemapUrl', value: url }], select: 'cacheKey' });
		let promise;
		for await (const cacheKey of it) {
			promise = RenderTarget.delete(cacheKey);
			await new Promise(setImmediate);
		}

		await promise;

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
