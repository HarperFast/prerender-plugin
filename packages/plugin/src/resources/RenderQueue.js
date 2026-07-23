import { getMutex } from '../util/coordination.js';
import { config } from '../config.js';
import { currentMinuteMs } from '../util/time.js';
import { QueueState } from './QueueState.js';
import { CacheKey } from '../util/cacheKey.js';
import { cacheKeyUrl, normalizeUrl } from '../util/url.js';
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

			// Normalize the redirect target the same way serving does, so the rendered content is
			// stored under the key a bot request for that URL will look up. redirectedTo is the
			// renderer's decodeURI'd form; normalizeUrl re-sorts and standardizes the encoding
			// (['*'] keeps all params — the matched route, hence its allowlist, isn't known here),
			// then cacheKeyUrl applies the shared cache-key encoding.
			cacheKey = CacheKey.toCacheKey({ deviceType, url: cacheKeyUrl(normalizeUrl(result.redirectedTo, false, ['*'])) });
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

			// Schedule the next render relative to when THIS one completed (now), not a
			// fixed wall-clock time — so renders stay spread across the interval instead of
			// realigning into a daily herd, and the cadence self-paces to fleet throughput.
			// The per-target renderInterval drives the recurring cadence; fall back to the
			// default when a target exists without a valid interval (a bare number check also
			// rejects NaN from an arbitrary API PUT).
			const interval =
				Number.isFinite(renderInterval) && renderInterval > 0 ? renderInterval : config.render.defaultInterval;
			// The cached page expires when the next render is due; the swrTtl window then keeps
			// it served while the re-render lands, so render latency up to swrTtl never causes
			// a cache miss.
			const nextRenderTime = currentMinuteMs() + interval;

			if (result.content) {
				result.headers['x-harper-rendered'] = '1';
				await databases.page_cache.PrerenderedPage.put(cacheKey, {
					statusCode: result.statusCode,
					lastCached: Date.now(),
					content: createBlob(result.content),
					headers: JSON.stringify(result.headers),
					expiresAt: nextRenderTime,
					isIndexable: typeof result.isIndexable === 'boolean' ? result.isIndexable : null,
				});
			}

			if (renderTarget) {
				// A target owns this schedule → recurring. Reschedule relative to completion
				// using the resolved interval (so a target lacking an explicit renderInterval
				// falls back to the default instead of getting stuck re-claiming every lease
				// period). Refresh fromSitemap from the live target so it self-corrects if the
				// URL has since left its sitemap.
				await RenderSchedule.put(cacheKey, { nextRenderTime, fromSitemap: !!renderTarget.sitemapUrl });
			} else {
				// No target owns this schedule: it's a one-off (render-now) or an orphaned
				// row. Nothing sets a recurring cadence, so drop the schedule instead of
				// leaving it to be re-claimed when the lease expires.
				await RenderSchedule.delete(cacheKey);
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
			// A target-backed job is left to retry after its lease expires. But a one-off
			// (render-now) / orphaned schedule has no target, so leaving it would re-claim
			// and re-render the failed job indefinitely — drop it instead.
			const renderTarget = await RenderTarget.get({ id: cacheKey, select: 'cacheKey' });
			if (!renderTarget) {
				await RenderSchedule.delete(cacheKey);
			}
		}
	}

	static claim = mutex.withLock(async ({ limit = 20 } = {}) => {
		if (QueueState.status === 'paused') {
			return [];
		}

		// Bound the batch server-side so no consumer can over-claim: a large grant means a
		// large lease-write burst held under this mutex (long lock hold) and lets one worker
		// hoard a burst other renderers should share.
		limit = Math.min(Math.max(1, limit | 0), config.queue.maxClaimLimit);

		const currentMinute = currentMinuteMs();
		// Fully drain the search (read) transaction into memory BEFORE issuing any
		// RenderSchedule.put leases. Interleaving the puts inside the `for await` keeps the
		// read cursor's transaction open across the writes, which pins the log and blocks
		// reclamation; reading first releases it promptly (same pattern as refreshQueueStatus).
		const schedules = await Array.fromAsync(
			RenderSchedule.search(
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
			)
		);

		const jobs = [];
		const promises = [];

		for (const schedule of schedules) {
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
let queueStatusSyncInterval = null;

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

	queueStatusSyncInterval = setInterval(refresh, config.queue.statusSyncInterval);
	queueStatusSyncInterval.unref?.();
}

/**
 * Stop the periodic queue-status refresh. Called from the plugin's close hook so a
 * status-sync tick can't run during shutdown — in particular so it can't flip the
 * status back off `paused` after the close hook pauses the queue. Idempotent and a
 * no-op on any worker that never started the sync (only worker 0 runs it).
 */
export function stopQueueStatusSync() {
	if (queueStatusSyncInterval !== null) {
		clearInterval(queueStatusSyncInterval);
		queueStatusSyncInterval = null;
	}
	queueStatusSyncStarted = false;
}
