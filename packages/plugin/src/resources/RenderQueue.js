import { getMutex } from '../util/coordination.js';
import { config } from '../config.js';
import { currentMinuteMs } from '../util/time.js';
import { QueueState } from './QueueState.js';
import { CacheKey } from '../util/cacheKey.js';
import { canonicalizeUrl } from '../util/url.js';
import { queryAllowlistFor } from '../util/ingress.js';
import { RenderTarget } from './RenderTarget.js';
import { getDesiredPause, setDesiredPause } from '../util/queueControl.js';

const protocol = server.hostname === 'localhost' ? 'http' : 'https';
const port = protocol === 'https' ? server.config.http.securePort || server.config.http.port : server.config.http.port;

const { RenderSchedule } = databases.render_schedule;

const mutex = getMutex('render_queue');

/**
 * Resolve this node's desired pause intent from the replicated `QueueControl` table and
 * store it into the node-local queue flag; when not paused, recompute empty/queued from
 * the backlog as before. Caller must hold `mutex`.
 *
 * This is what makes pause/resume work cluster-wide: `claim` reads a non-replicated,
 * node-local flag, so a remote node can't be addressed directly — but every node runs
 * this on its own status-sync interval, so a replicated intent write converges everywhere
 * within one `queue.statusSyncInterval`.
 */
async function syncQueueState(force = false, pending = null) {
	const desired = await getDesiredPause(server.hostname, pending);

	if (desired.paused) {
		await QueueState.reportStatus('paused');
		return { status: 'paused', ...desired };
	}

	// The intent says "run". If the local flag still holds `paused`, the report must be
	// forced: reportStatus's non-forced path is a compareExchange between empty<->queued,
	// which by design cannot move a flag currently holding `paused`.
	const liftingPause = QueueState.status === 'paused';

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

	const status = existingId ? 'queued' : 'empty';
	await QueueState.reportStatus(status, force || liftingPause);
	return { status, ...desired };
}

export class RenderQueue extends Resource {
	static loadAsInstance = false;

	static refreshQueueStatus = async (force = false) => {
		await mutex.lock();
		try {
			return await syncQueueState(force);
		} catch (e) {
			logger.error(e);
		} finally {
			mutex.unlock();
		}
	};

	/**
	 * Record a pause intent and immediately re-resolve it for this node.
	 *
	 * `scope` is a hostname (per-node override) or 'all' (cluster-wide default); `paused`
	 * is true, false (explicitly run), or null (delete the row — for a node scope, inherit
	 * 'all' again). Remote nodes pick the change up on their next status sync.
	 */
	static setPause = mutex.withLock(async ({ scope, paused, updatedBy } = {}) => {
		const target = scope ?? server.hostname;
		const intent = await setDesiredPause(target, paused, updatedBy);
		// Re-resolve rather than assuming the write applies here: a cluster-wide pause does
		// not pause a node carrying an explicit `paused: false` override, and vice versa.
		//
		// The just-written scope is passed as `pending` instead of being re-read: a row
		// deleted earlier in this request is still visible to a read here, so re-reading it
		// resolves a resume straight back to "paused" and returns the opposite of what
		// actually happened. The other scope is read normally — this write didn't touch it.
		const local = await syncQueueState(true, { scope: target, paused });
		return { ...intent, node: server.hostname, local };
	});

	// Node-scoped pause: this node stops claiming until resumed. Resume CLEARS the node's
	// override (rather than writing `paused: false`) so it restores the inherited state
	// instead of silently punching a hole in a deliberate cluster-wide pause.
	//
	// Named explicitly rather than via `this` so the binding survives being destructured or
	// passed as a callback (`const { pause } = RenderQueue`), and so a subclass can't
	// accidentally redirect it.
	static pause = ({ updatedBy } = {}) => RenderQueue.setPause({ scope: server.hostname, paused: true, updatedBy });

	static resume = ({ updatedBy } = {}) => RenderQueue.setPause({ scope: server.hostname, paused: null, updatedBy });

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
			const { deviceType } = CacheKey.parse(result.id);

			// The browser posts the RAW final page URL as `redirectedTo`. Canonicalize it the
			// same way serving does — with the allowlist a bot READ of that target would use
			// (route-aware) — so the rendered content is stored under the key that read computes.
			const redirectKey = CacheKey.toCacheKey({
				deviceType,
				url: canonicalizeUrl(result.redirectedTo, queryAllowlistFor(result.redirectedTo)),
			});

			// Only treat it as a redirect when the final URL canonicalizes to a DIFFERENT key.
			// A target whose page URL collapses back to the same key (trailing slash, param
			// reorder, encoding) is not a redirect — keep it under result.id and, crucially,
			// do NOT delete its RenderTarget (which would drop it from the recurring rotation).
			if (redirectKey !== result.id) {
				logger.warn(`Skipped prerendered url due to redirect: ${result.id} redirected to ${result.redirectedTo}`);
				await RenderTarget.delete(result.id);
				cacheKey = redirectKey;
			}
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
			// Deliberately node-scoped: this resource sets `loadAsInstance = false`, which
			// skips Harper's allow* permission checks (see Resource.ts), so it must not be
			// able to pause the whole cluster. Cluster-scoped control lives on the
			// super-user-gated admin resource.
			case 'pause':
				return RenderQueue.pause({ updatedBy: ctx?.user?.username ?? 'render_queue-api' });
			case 'resume':
				return RenderQueue.resume({ updatedBy: ctx?.user?.username ?? 'render_queue-api' });
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
