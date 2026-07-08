import { XMLParser } from 'fast-xml-parser';
import { config } from '../config.js';
import { RenderTarget } from './RenderTarget.js';
import { currentMinuteMs, getNextSitemapRefreshTime } from '../util/time.js';

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

					const incomingEntryMap = new Map(latestSitemap.entries.map((entry) => [entry.loc, entry]));

					for await (const target of RenderTarget.search({
						select: ['url', 'renderInterval', 'sitemapUrl'],
						conditions: [{ attribute: 'sitemapUrl', value: sitemapUrl }],
					})) {
						if (!incomingEntryMap.has(target.url)) {
							lastPromise = RenderTarget.patch(target.url, {
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

					for (const { loc: url, changefreq } of incomingEntryMap.values()) {
						const renderInterval = getTtlFromChangeFreq(changefreq, {
							minTtl: config.page.minTtl,
							defaultTtl: config.page.ttl,
						});

						let updateTarget = false;
						let revalidateNow = revalidate;

						if (revalidateNow) {
							updateTarget = true;
							created++;
						} else {
							// Only `sitemapUrl` is needed here; avoid materializing the full
							// record for every entry in this bulk loop.
							const existingTarget = await RenderTarget.get({ id: url, select: 'sitemapUrl' });

							if (existingTarget) {
								updateTarget = existingTarget.sitemapUrl !== sitemapUrl;
								if (updateTarget) {
									updated++;
								}
							} else {
								created++;
								updateTarget = true;
								revalidateNow = true;
							}
						}

						if (updateTarget) {
							// One target per URL; put fans out the per-device schedules for `deviceTypes`.
							lastPromise = RenderTarget.put(url, {
								deviceTypes,
								renderInterval,
								sitemapUrl,
								nextRenderTime: revalidateNow ? currentMinuteMs() : undefined,
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

		const it = RenderTarget.search({ conditions: [{ attribute: 'sitemapUrl', value: url }], select: 'url' });
		let promise;
		for await (const targetUrl of it) {
			promise = RenderTarget.delete(targetUrl);
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
	const res = await fetch(url, {
		method: 'GET',
		redirect: 'follow',
		headers: { 'User-Agent': 'harper-bot/1.0', [config.securityToken.header]: config.securityToken.value },
	});
	const xml = await res.text();

	const parser = new XMLParser({
		isArray: (tagName) => ['sitemap', 'url'].some((value) => value === tagName),
	});

	const data = parser.parse(xml);

	const parsed = { url, lastRefreshed: new Date(), entries: [], entryCount: 0 };

	if (Array.isArray(data?.urlset?.url)) {
		parsed.isIndex = false;
		parsed.entries = data.urlset.url;
	} else if (Array.isArray(data?.sitemapindex?.sitemap)) {
		parsed.isIndex = true;
		parsed.entries = data.sitemapindex.sitemap;
	}

	parsed.entryCount = parsed.entries.length;

	return parsed;
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
