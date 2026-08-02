import { getMutex } from '../util/coordination.js';
import { config } from '../config.js';
import { currentMinuteMs } from '../util/time.js';
import { QueueState } from './QueueState.js';
import { CacheKey } from '../util/cacheKey.js';
import { canonicalizeUrl } from '../util/url.js';
import { classifyPath, queryAllowlistFor, PRERENDER } from '../util/routeClass.js';
import { recordUnroutedPath } from '../util/unrouted.js';
import { RenderTarget } from './RenderTarget.js';
import { getDesiredPause, setDesiredPause } from '../util/queueControl.js';

const protocol = server.hostname === 'localhost' ? 'http' : 'https';
const port = protocol === 'https' ? server.config.http.securePort || server.config.http.port : server.config.http.port;

const { RenderSchedule } = databases.render_schedule;

const mutex = getMutex('render_queue');

// Browsers ≥ v1.16.0 post `outcome` — the single field result handling keys on: 'rendered'
// (content present; a rendered-through client-side redirect is still a rendered page),
// 'redirected' (ended at navigation, no content), 'non-indexable' (the page said don't), or
// 'error'. Older browsers don't post it; infer it from the legacy signals with the same
// precedence the old condition chain applied, so a mixed fleet lands in the branches it
// always did.
const legacyOutcome = (result) => {
	if ((result.statusCode === 200 && result.content) || result.isIndexable === true) return 'rendered';
	if (result.redirectedTo) return 'redirected';
	if (result.isIndexable === false) return 'non-indexable';
	return 'error';
};

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
		// `intent.paused`, not the raw argument: setDesiredPause normalizes (an absent `paused`
		// is written as `false`), so threading the raw value could resolve "no opinion" while
		// the row on disk says `false`. Using what was actually written keeps the resolved
		// state and the persisted state identical by construction.
		const local = await syncQueueState(true, { scope: target, paused: intent.paused });
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
		// Set when the render landed somewhere we don't serve from cache: reschedule as normal
		// but store nothing, since the content belongs to a different URL than the key.
		let discardContent = false;

		// The domain allowlist runs BEFORE the outcome is resolved so a legacy result for a
		// foreign host still infers 'non-indexable' the way the old chain coerced it.
		try {
			const domain = URL.parse(url)?.hostname;
			// Empty allowlist = allow all hosts.
			if (config.domains.length && !config.domains.includes(domain)) {
				result.isIndexable = false;
			}
		} catch (e) {
			logger.error(e, result.id);
		}

		const outcome = result.outcome ?? legacyOutcome(result);

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
				const redirectPath = URL.parse(result.redirectedTo)?.pathname;
				const landedOn = redirectPath === undefined ? PRERENDER : classifyPath(redirectPath).routeClass;

				// 'redirected' = the render ended without content: the browser (≥ v1.16.0) bailed
				// at navigation on an HTTP redirect (statusCode = the first hop's 3xx), or a
				// rendered-through client-side redirect landed on a page that produced nothing.
				// Content rendered under this job's context (device profile, waitFor path scoping)
				// could only be stored under a key it wasn't rendered for, so there is nothing to
				// store — only scheduling to decide.
				if (outcome === 'redirected') {
					await this.processRedirectResult(result, { redirectKey, landedOn, redirectPath });
					return;
				}

				// A rendered result whose landed URL keys elsewhere (client-side redirect that
				// produced a real page): keep the long-standing refile semantics.
				if (outcome === 'rendered') {
					if (landedOn === PRERENDER) {
						logger.warn(`Skipped prerendered url due to redirect: ${result.id} redirected to ${result.redirectedTo}`);
						await RenderTarget.delete(result.id);
						cacheKey = redirectKey;
					} else {
						// The redirect target is a class we never serve from cache, so re-keying onto it
						// would file the render where no read will ever look — and deleting this target
						// would silently end the URL's rendering for good (see util/reconcile.js on how
						// undiagnosable that state is). The route list may simply be incomplete, so
						// report it and leave the target alone rather than destroy it on that evidence.
						// The render is wasted each interval until the redirect or the routes are fixed.
						logger.warn(
							`Prerendered url ${result.id} redirected to ${result.redirectedTo}, which is ${landedOn} — ` +
								`discarding the render and keeping the target (no key to store it under)`
						);
						recordUnroutedPath(landedOn, redirectPath, 'redirect');
						discardContent = true;
					}
				}
			}
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

		if (outcome === 'rendered') {
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

			if (result.content && !discardContent) {
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
		} else if (outcome === 'non-indexable') {
			// `reason` (browser ≥ v1.16.0) says WHY: 'noindex', 'canonical-mismatch', 'http-error',
			// or 'redirect-loop' — the difference between "the site asked us not to" and "the
			// render is broken", which read identically without it.
			logger.warn(`Skipped prerendered url: ${cacheKey}${result.reason ? ` (${result.reason})` : ''}`);
			await RenderTarget.delete(cacheKey);
			await this.markNonIndexable(CacheKey.extractUrl(cacheKey));
		} else {
			// The browser posts `reason` and the failed attempt's error (name/message/phase) since
			// v1.16.0; without them this branch can only say "unknown". `phase: 'navigation'`
			// means the document never arrived (slow/refusing origin) — a different problem from
			// a render that failed mid-settle.
			const detail = result.error
				? ` — ${result.error.name}${result.error.phase ? ` [${result.error.phase}]` : ''}: ${result.error.message}`
				: '';
			logger.warn(`Prerender failed for ${cacheKey} (${result.reason || 'no reason reported'})${detail}`);
			// A target-backed job is left to retry after its lease expires. But a one-off
			// (render-now) / orphaned schedule has no target, so leaving it would re-claim
			// and re-render the failed job indefinitely — drop it instead.
			const renderTarget = await RenderTarget.get({ id: cacheKey, select: 'cacheKey' });
			if (!renderTarget) {
				await RenderSchedule.delete(cacheKey);
			}
		}
	}

	/**
	 * A render that ended as a redirect with no content. Usually the browser bailed at
	 * navigation on an HTTP redirect (`result.statusCode` is the FIRST hop's 3xx — the origin's
	 * statement about the job URL itself); a client-side redirect that rendered through to a
	 * page that produced nothing lands here too (statusCode 200, permanence unknowable). What's
	 * decided is what happens to the source target, and whether the destination becomes a
	 * target of its own so it gets rendered under its own job context instead of being cached
	 * from a render that ran as another URL.
	 */
	static async processRedirectResult(result, { redirectKey, landedOn, redirectPath }) {
		if (typeof result.renderTime === 'number') {
			server.recordAnalytics(result.renderTime, 'render_time', result.statusCode, 'redirect');
		}

		if (landedOn !== PRERENDER) {
			// The destination is a class we never serve from cache — adopting it would file
			// renders where no read looks, and deleting the source would end its rendering for
			// good on evidence as weak as an incomplete route list. Keep the source and retry at
			// its normal cadence; the retry now costs a navigation, not a full settle.
			logger.warn(
				`Prerendered url ${result.id} redirected (${result.statusCode}) to ${result.redirectedTo}, which is ` +
					`${landedOn} — keeping the target (no key to schedule the destination under)`
			);
			recordUnroutedPath(landedOn, redirectPath, 'redirect');
			await this.rescheduleRedirectSource(result.id);
			return;
		}

		if (result.isIndexable === false) {
			// The landed document was actually loaded and inspected (a rendered-through
			// client-side redirect) and it is non-indexable: the source now leads to a page we
			// would never cache. Retire the source and remember the destination is dead, so
			// neither keeps rendering.
			logger.warn(
				`Prerendered url ${result.id} redirected to non-indexable ${result.redirectedTo}` +
					`${result.reason ? ` (${result.reason})` : ''} — retiring the target`
			);
			await RenderTarget.delete(result.id);
			await this.markNonIndexable(CacheKey.extractUrl(redirectKey));
			return;
		}

		if (result.statusCode !== 301 && result.statusCode !== 308) {
			// No proof of permanence (302/303/307 — failover, geo bounce, outage page — or a
			// client-side redirect's 200). The source is expected to come back — keep its target
			// AND its cached page, and look again next interval.
			logger.warn(
				`Prerendered url ${result.id} temporarily redirected (${result.statusCode}) to ${result.redirectedTo} — ` +
					`keeping the target and retrying at its normal cadence`
			);
			await this.rescheduleRedirectSource(result.id);
			return;
		}

		// Permanent move onto a route we serve: retire the source — RenderTarget.delete drops its
		// target, schedule, and cached page — and adopt the destination in its place. A mutual
		// 301 pair (A↔B) ping-pongs create/delete at the targets' cadence; each hop is a
		// navigation-only render surfaced by this warn, so a broken site costs noise, not settles.
		logger.warn(
			`Prerendered url ${result.id} permanently redirected (${result.statusCode}) to ${result.redirectedTo} — ` +
				`retiring the target in favor of ${redirectKey}`
		);
		const source = await RenderTarget.get({ id: result.id, select: ['renderInterval'] });
		await RenderTarget.delete(result.id);

		const existingTarget = await RenderTarget.get({ id: redirectKey, select: 'cacheKey' });
		if (existingTarget) return; // already in the rotation under its own cadence

		// Same gate the bot-traffic discovery applies: a host outside the allowlist can never be
		// marked indexable, and a URL already proven non-indexable shouldn't be resurrected by a
		// redirect pointing at it.
		const destinationUrl = CacheKey.extractUrl(redirectKey);
		const domain = URL.parse(destinationUrl)?.hostname;
		if (config.domains.length && !config.domains.includes(domain)) return;
		const existingNonIndexable = await databases.signals.NonIndexable.get({
			id: destinationUrl,
			select: 'url',
		});
		if (existingNonIndexable) return;

		// Due now, not jittered: adoptions arrive one per source render, already spread by the
		// sources' own schedule jitter, and the source's cached page was just deleted — the
		// sooner the destination renders, the shorter the window a bot gets neither page.
		const target = { nextRenderTime: currentMinuteMs() };
		if (Number.isFinite(source?.renderInterval) && source.renderInterval > 0) {
			target.renderInterval = source.renderInterval;
		}
		await RenderTarget.put(redirectKey, target);
	}

	/** Record the indexability verdict for a URL (idempotent, best-effort — a failed signal
	 *  write must never fail the job result that carried it). */
	static async markNonIndexable(url) {
		try {
			const existing = await databases.signals.NonIndexable.get({ id: url, select: 'url' });
			if (!existing) {
				await databases.signals.NonIndexable.put(url, { url });
			}
		} catch {
			/* best-effort signal write */
		}
	}

	/**
	 * Keep a redirecting source in its rotation. Mirrors the post-render scheduling in
	 * processJobResult: a target-backed key comes due one interval from completion (so cadence
	 * self-paces instead of realigning into a herd); a targetless key (render-now one-off,
	 * orphaned row) has its schedule dropped so the lease doesn't re-claim it forever.
	 */
	static async rescheduleRedirectSource(cacheKey) {
		const renderTarget = await RenderTarget.get({ id: cacheKey, select: ['renderInterval', 'sitemapUrl'] });
		if (!renderTarget) {
			await RenderSchedule.delete(cacheKey);
			return;
		}
		const interval =
			Number.isFinite(renderTarget.renderInterval) && renderTarget.renderInterval > 0
				? renderTarget.renderInterval
				: config.render.defaultInterval;
		await RenderSchedule.put(cacheKey, {
			nextRenderTime: currentMinuteMs() + interval,
			fromSitemap: !!renderTarget.sitemapUrl,
		});
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
