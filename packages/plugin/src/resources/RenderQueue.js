import { getMutex } from '../util/coordination.js';
import { config } from '../config.js';
import { currentMinuteMs, getNextRenderTime } from '../util/time.js';
import { QueueState } from './QueueState.js';
import { CacheKey } from '../util/cacheKey.js';
import { RenderTarget } from './RenderTarget.js';

const protocol = server.hostname === 'localhost' ? 'http' : 'https';
const port = protocol === 'https' ? server.config.http.securePort || server.config.http.port : server.config.http.port;

const { RenderSchedule } = databases.render_schedule;

const mutex = getMutex('render_queue');

export class RenderQueue extends Resource {
	static loadAsInstance = false;

	static refreshQueueStatus = async (force = false) => {
		await mutex.lock();
		try {
			const now = currentMinuteMs();

			const [existingId] = await Array.fromAsync(
				RenderSchedule.search(
					{
						conditions: [
							{
								attribute: 'nextRenderTime',
								comparator: 'less_than_equal',
								value: now,
							},
						],
						select: 'cacheKey',
						limit: 1,
					},
					{ replicateFrom: false }
				)
			);

			await QueueState.reportStatus(existingId ? 'queued' : 'empty', force);
		} catch (e) {
			logger.error(e);
		} finally {
			mutex.unlock();
		}
	};

	static pause = mutex.withLock(() => QueueState.reportStatus('paused'));

	static resume = () => this.refreshQueueStatus(true);

	static decodeJobResult(buffer, metadataSize) {
		const metadataBuffer = buffer.subarray(0, metadataSize);
		const result = JSON.parse(metadataBuffer.toString('utf8'));
		if (metadataBuffer.byteLength < buffer.byteLength) {
			result.content = buffer.subarray(metadataSize);
		}
		return result;
	}

	static async processJobResult(data, ctx) {
		const metadataSize = parseInt(ctx.headers.get('x-metadata-size'));

		const result = this.decodeJobResult(data, metadataSize);

		let cacheKey = result.id;
		const url = result.redirectedTo || result.url;

		if (result.redirectedTo) {
			if (result.redirectedTo !== result.url) {
				logger.warn(`Skipped prerendered url due to redirect: ${result.id} redirected to ${result.redirectedTo}`);
				await RenderTarget.delete(result.id);
			}

			const { deviceType } = CacheKey.parse(result.id);

			cacheKey = CacheKey.toCacheKey({ deviceType, url: result.redirectedTo });
		}

		try {
			const domain = URL.parse(url)?.hostname;
			// Empty allowlist = allow all hosts.
			if (config.domains.length && !config.domains.includes(domain)) {
				result.isIndexable = false;
			}
		} catch (e) {
			logger.error(e, result.id);
		}

		const hasContent = result.statusCode === 200 && result.content;

		if (typeof result.renderTime === 'number') {
			server.recordAnalytics(
				result.renderTime,
				'render_time',
				result.statusCode,
				typeof result.isIndexable === 'boolean'
					? result.isIndexable || hasContent
						? 'candidate'
						: 'non-candidate'
					: 'unknown'
			);
		}

		if (result.isIndexable === true || hasContent) {
			const renderTarget = await RenderTarget.get({ id: cacheKey, select: ['renderInterval', 'sitemapUrl'] });
			const renderInterval = renderTarget?.renderInterval;

			const nextRenderTime = getNextRenderTime();

			if (result.content) {
				result.headers['x-harper-rendered'] = '1';
				await databases.page_cache.PrerenderedPage.put(cacheKey, {
					statusCode: result.statusCode,
					lastCached: Date.now(),
					content: createBlob(result.content),
					headers: JSON.stringify(result.headers),
					expiresAt: nextRenderTime,
				});
			}

			if (typeof renderInterval === 'number' && renderInterval > 0) {
				// Refresh fromSitemap from the live target so it self-corrects if the URL
				// has since left its sitemap.
				await RenderSchedule.put(cacheKey, { nextRenderTime, fromSitemap: !!renderTarget.sitemapUrl });
			}
		} else if (result.isIndexable === false) {
			logger.warn(`Skipped prerendered url: ${cacheKey}`);
			await RenderTarget.delete(cacheKey);

			try {
				const nonIndexableUrl = CacheKey.extractUrl(cacheKey);
				const existingNonIndexable = await databases.signals.NonIndexable.get({
					id: nonIndexableUrl,
					select: 'url',
				});
				if (!existingNonIndexable) {
					await databases.signals.NonIndexable.put(nonIndexableUrl, { url: nonIndexableUrl });
				}
			} catch {
				/* best-effort signal write */
			}
		} else {
			logger.warn(`Unknown prerender error for ${cacheKey}`);
		}
	}

	static claim = mutex.withLock(async ({ limit = 20 } = {}) => {
		if (QueueState.status === 'paused') {
			return [];
		}

		const currentMinute = currentMinuteMs();
		const it = RenderSchedule.search(
			{
				conditions: [
					{
						attribute: 'nextRenderTime',
						comparator: 'less_than_equal',
						value: currentMinute,
					},
				],
				sort: {
					attribute: 'nextRenderTime',
				},
				limit,
			},
			{ replicateFrom: false }
		);

		const jobs = [];
		const promises = [];

		for await (const schedule of it) {
			const { url, deviceType } = CacheKey.parse(schedule.cacheKey);

			const expiresAt = currentMinuteMs(Date.now() + config.queue.jobLeaseTime);

			// `fromSitemap` is denormalized onto the schedule, so the job can be built
			// synchronously with no per-job RenderTarget read. Preserve it on the lease
			// write (put replaces the record).
			promises.push(
				Promise.resolve(
					RenderSchedule.put(schedule.cacheKey, { nextRenderTime: expiresAt, fromSitemap: schedule.fromSitemap })
				).catch(logger.error)
			);

			jobs.push({
				id: schedule.cacheKey,
				url,
				deviceType,
				expiresAt,
				callbackOrigin: `${protocol}://${server.hostname}:${port}`,
				isFromSitemap: !!schedule.fromSitemap,
			});
		}

		await Promise.all(promises);

		if (jobs.length === 0) {
			QueueState.reportStatus('empty');
		}

		return jobs;
	});

	async post(target, data) {
		const ctx = this.getContext();
		switch (target.id) {
			case 'pause':
				return RenderQueue.pause();
			case 'resume':
				return RenderQueue.resume();
			case 'claim':
				return RenderQueue.claim(data, ctx);
			case 'job_result':
				return RenderQueue.processJobResult(data, ctx);
			default:
				break;
		}
	}
}

let queueStatusSyncStarted = false;

/**
 * Start the periodic queue-status refresh on worker 0. Called from
 * handleApplication after config is applied (so the interval reflects overrides).
 * Idempotent.
 */
export function startQueueStatusSync() {
	if (server.workerIndex !== 0 || queueStatusSyncStarted) return;
	queueStatusSyncStarted = true;

	let refreshing = false;

	const refresh = () => {
		if (refreshing) return;

		refreshing = true;
		RenderQueue.refreshQueueStatus()
			.catch(logger.error)
			.finally(() => {
				refreshing = false;
			});
	};

	refresh();

	setInterval(refresh, config.queue.statusSyncInterval).unref?.();
}
