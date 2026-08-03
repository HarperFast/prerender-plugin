import { getMutex } from '../util/coordination.js';
import { config } from '../config.js';
import { currentMinuteMs } from '../util/time.js';
import { QueueState } from './QueueState.js';
import { CacheKey } from '../util/cacheKey.js';
import { canonicalizeUrl } from '../util/url.js';
import { classifyPath, queryAllowlistFor, resolveRenderInterval, PRERENDER } from '../util/routeClass.js';
import { recordUnroutedPath } from '../util/unrouted.js';
import { Target } from './Target.js';
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

		// The browser's OWN verdict about the landed document, captured before the domain
		// coercion below — "the page said noindex" and "the host is outside our allowlist"
		// must not be conflated: only the former means the destination was inspected.
		const inspectedNonIndexable = result.isIndexable === false;

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
			// do NOT delete its Target (which would drop it from the recurring rotation).
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
					await this.processRedirectResult(result, { redirectKey, landedOn, redirectPath, inspectedNonIndexable });
					return;
				}

				// A rendered result whose landed URL keys elsewhere (client-side redirect that
				// produced a real page): keep the long-standing refile semantics.
				if (outcome === 'rendered') {
					if (landedOn === PRERENDER) {
						// Retiring by URL takes the device siblings too — a page does not redirect
						// for one device and serve for another.
						logger.warn(`Skipped prerendered url due to redirect: ${result.id} redirected to ${result.redirectedTo}`);
						await Target.delete(CacheKey.extractUrl(result.id));
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
			const url = CacheKey.extractUrl(cacheKey);
			const renderTarget = await Target.get({
				id: url,
				select: ['renderInterval', 'sitemapUrl', 'state', 'strikes'],
			});
			const renderInterval = renderTarget?.renderInterval;

			// Schedule the next render relative to when THIS one completed (now), not a
			// fixed wall-clock time — so renders stay spread across the interval instead of
			// realigning into a daily herd, and the cadence self-paces to fleet throughput.
			// Cadence precedence: matched route's renderInterval, else the target's stored
			// interval (sitemap changefreq / explicit API write; invalid values — including
			// NaN from an arbitrary API PUT — are rejected), else the default. Resolved here
			// on every cycle, so a route-cadence config change applies on each URL's next
			// render without touching stored rows.
			const interval = resolveRenderInterval(url, renderInterval);
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

				// A suppressed URL that rendered indexable again has healed — put it back in
				// normal rotation, so the recheck cadence stops and discovery may see it again.
				if (renderTarget.state === 'suppressed' && result.isIndexable === true) {
					logger.warn(`Prerendered url ${url} is indexable again — lifting its suppression`);
					await Target.reactivate(url);
				} else if (renderTarget.state !== 'suppressed' && renderTarget.strikes > 0) {
					// Strikes are CONSECUTIVE failures by definition: a successful render resets the
					// count, so redirect blips months apart never accumulate toward retirement.
					// Guarded by strikes > 0 — the hot path (healthy target, no strikes) pays no
					// extra write.
					await Target.patch(url, { strikes: 0 });
				}
			} else {
				// No target owns this schedule: it's a one-off (render-now) or an orphaned
				// row. Nothing sets a recurring cadence, so drop the schedule instead of
				// leaving it to be re-claimed when the lease expires.
				await RenderSchedule.delete(cacheKey);
			}
		} else if (outcome === 'non-indexable') {
			// `reason` (browser ≥ v1.16.0) says WHY: 'noindex', 'canonical-mismatch', 'http-error',
			// or 'redirect-loop' — the difference between "the site asked us not to" and "the
			// render is broken", which read identically without it. The verdict SUPPRESSES the
			// target (state + recheck schedule) rather than deleting it — see Target.suppress,
			// which also grades http-error verdicts by status (404/410 recheck less, die sooner).
			//
			// EXCEPT 401/403: an auth-shaped error is almost never a statement about the page —
			// it's a broken renderer credential, an origin bot-mitigation rule change, or an
			// origin auth outage. Striking toward deletion would suppress (and after maxStrikes
			// DELETE) swathes of healthy targets exactly when such a failure hits everything at
			// once. Keep the target, keep its cached page, retry via retryAfterFailure.
			if (result.statusCode === 401 || result.statusCode === 403) {
				logger.error(
					`Prerender got ${result.statusCode} for ${cacheKey} — auth-shaped, NOT suppressing. ` +
						`If these are widespread, check the renderer's origin-bypass credential and the CDN/origin access rules.`
				);
				await this.retryAfterFailure(cacheKey);
			} else if (result.statusCode === 408 || result.statusCode === 429 || result.statusCode >= 500) {
				// Transient-shaped: the origin failed to serve the page, it didn't disavow it.
				// Suppressing would delete the last good cached page and park the URL for the
				// recheck interval over what may be one bad minute at the origin — keep both
				// and retry via retryAfterFailure (fast first, then the target's cadence).
				logger.warn(`Prerender got transient ${result.statusCode} for ${cacheKey} — keeping target and cached page`);
				await this.retryAfterFailure(cacheKey);
			} else {
				logger.warn(`Suppressing prerendered url: ${cacheKey}${result.reason ? ` (${result.reason})` : ''}`);
				await Target.suppress(CacheKey.extractUrl(cacheKey), {
					reason: result.reason,
					statusCode: result.statusCode,
				});
			}
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
			const renderTarget = await Target.get({ id: CacheKey.extractUrl(cacheKey), select: 'url' });
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
	static async processRedirectResult(result, { redirectKey, landedOn, redirectPath, inspectedNonIndexable }) {
		if (typeof result.renderTime === 'number') {
			server.recordAnalytics(result.renderTime, 'render_time', result.statusCode, 'redirect');
		}

		// Same status rules as processJobResult, applied BEFORE anything retires or strikes
		// the source. Only a rendered-through client-side redirect can carry these statuses
		// (a bail-at-nav result posts the first hop's 3xx), so `statusCode` here is the LANDED
		// document's: an auth-shaped or transient-shaped landing is a credential/origin
		// problem, not a verdict on either URL. Without this, a page whose client-side
		// redirect lands on a 401/403 would delete its source target on the FIRST such result
		// (via the inspectedNonIndexable branch below) — the exact mass-deletion the
		// processJobResult guard exists to prevent.
		const authShaped = result.statusCode === 401 || result.statusCode === 403;
		const transientShaped = result.statusCode === 408 || result.statusCode === 429 || result.statusCode >= 500;
		if (authShaped || transientShaped) {
			logger[authShaped ? 'error' : 'warn'](
				`Prerendered url ${result.id} redirected to ${result.redirectedTo}, which returned ${result.statusCode} — ` +
					`${authShaped ? 'auth-shaped' : 'transient'}, keeping the target`
			);
			await this.retryAfterFailure(result.id);
			return;
		}

		if (landedOn !== PRERENDER) {
			// The destination is a class we never serve from cache — adopting it would file
			// renders where no read looks, and deleting the source on ONE such result would end
			// its rendering on evidence as weak as an incomplete route list. Keep the source and
			// retry at its normal cadence (the retry costs a navigation, not a full settle) —
			// but count the strike: a source that answers this way every interval is de facto
			// permanently redirected, and recordRedirectStrike retires it after maxStrikes.
			logger.warn(
				`Prerendered url ${result.id} redirected (${result.statusCode}) to ${result.redirectedTo}, which is ` +
					`${landedOn} — keeping the target (no key to schedule the destination under)`
			);
			recordUnroutedPath(landedOn, redirectPath, 'redirect');
			await this.recordRedirectStrike(result.id, `to unserved ${landedOn} destination`);
			return;
		}

		if (inspectedNonIndexable) {
			// The landed document was actually loaded and inspected (a rendered-through
			// client-side redirect) and it is non-indexable: the source now leads to a page we
			// would never cache. Retire the source and suppress the destination, so neither
			// keeps rendering at full cadence. (This keys on the browser's posted verdict, not
			// the domain-coerced one — a foreign host was never inspected, and a suppressed
			// foreign row would be registry noise nothing ever reads.)
			logger.warn(
				`Prerendered url ${result.id} redirected to non-indexable ${result.redirectedTo}` +
					`${result.reason ? ` (${result.reason})` : ''} — retiring the target`
			);
			await Target.delete(CacheKey.extractUrl(result.id));
			const destinationUrl = CacheKey.extractUrl(redirectKey);
			const domain = URL.parse(destinationUrl)?.hostname;
			// Auth-shaped and transient statuses never reach here (guarded above), so this
			// suppression is a genuine content/gone verdict about the destination.
			if (!config.domains.length || config.domains.includes(domain)) {
				await Target.suppress(destinationUrl, { reason: result.reason, statusCode: result.statusCode });
			}
			return;
		}

		if (result.statusCode !== 301 && result.statusCode !== 308) {
			// No proof of permanence (302/303/307 — failover, geo bounce, outage page — or a
			// client-side redirect's 200). The source is expected to come back — keep its target
			// AND its cached page, and look again next interval. But a source that answers with
			// a temp redirect EVERY interval is a permanent redirect wearing a temporary status:
			// each result costs a strike and recordRedirectStrike retires the source after
			// maxStrikes rather than paying a navigation every interval forever.
			logger.warn(
				`Prerendered url ${result.id} temporarily redirected (${result.statusCode}) to ${result.redirectedTo} — ` +
					`keeping the target and retrying at its normal cadence`
			);
			await this.recordRedirectStrike(result.id, `temporary ${result.statusCode} to ${result.redirectedTo}`);
			return;
		}

		// Permanent move onto a route we serve: retire the source — Target.delete drops the URL's
		// row and every device's schedule and cached page — and adopt the destination in its
		// place. A mutual 301 pair (A↔B) ping-pongs create/delete at the targets' cadence; each
		// hop is a navigation-only render surfaced by this warn, so a broken site costs noise,
		// not settles.
		logger.warn(
			`Prerendered url ${result.id} permanently redirected (${result.statusCode}) to ${result.redirectedTo} — ` +
				`retiring the target in favor of ${redirectKey}`
		);
		const sourceUrl = CacheKey.extractUrl(result.id);
		const source = await Target.get({ id: sourceUrl, select: ['renderInterval'] });
		await Target.delete(sourceUrl);

		// An existing destination row — active OR suppressed — wins: active means it's already
		// in rotation under its own cadence; suppressed means a render already proved it
		// non-indexable, and a redirect pointing at it is no reason to resurrect it.
		const destinationUrl = CacheKey.extractUrl(redirectKey);
		const existingTarget = await Target.get({ id: destinationUrl, select: 'url' });
		if (existingTarget) return;

		// Same gate the bot-traffic discovery applies: a host outside the allowlist can never
		// be marked indexable.
		const domain = URL.parse(destinationUrl)?.hostname;
		if (config.domains.length && !config.domains.includes(domain)) return;

		// Due now, not jittered: adoptions arrive one per source render, already spread by the
		// sources' own schedule jitter, and the source's cached page was just deleted — the
		// sooner the destination renders, the shorter the window a bot gets neither page.
		const target = { nextRenderTime: currentMinuteMs() };
		if (Number.isFinite(source?.renderInterval) && source.renderInterval > 0) {
			target.renderInterval = source.renderInterval;
		}
		await Target.put(destinationUrl, target);
	}

	/**
	 * A redirect result that keeps its source in rotation still costs a strike: one temp
	 * redirect is failover noise, but `render.redirects.maxStrikes` consecutive ones mean the
	 * "temporary" status is a lie (or the route list will never serve the destination) and the
	 * source is retired outright. Retiring is safe, not destructive — bot traffic for the URL
	 * proxies to the origin, which serves its own redirect, and on-demand discovery re-creates
	 * whatever the origin actually serves. The strike counter is the target's one shared
	 * `strikes` field (suppression uses it too); any successful render clears it.
	 */
	static async recordRedirectStrike(cacheKey, why) {
		const sourceUrl = CacheKey.extractUrl(cacheKey);
		// One read serves both the strike decision and the reschedule below.
		const renderTarget = await Target.get({ id: sourceUrl, select: ['strikes', 'renderInterval', 'sitemapUrl'] });
		if (!renderTarget) {
			await RenderSchedule.delete(cacheKey);
			return;
		}
		const strikes = (Number.isFinite(renderTarget.strikes) ? Number(renderTarget.strikes) : 0) + 1;
		const maxStrikes = config.render.redirects.maxStrikes;
		if (Number.isFinite(maxStrikes) && maxStrikes > 0 && strikes >= maxStrikes) {
			logger.warn(
				`Prerendered url ${sourceUrl} kept redirecting ${strikes} consecutive times (${why}) — retiring it; ` +
					`bots get the origin's own redirect and discovery re-creates what it actually serves`
			);
			await Target.delete(sourceUrl); // drops schedules + pages too
			return;
		}
		await Target.patch(sourceUrl, { strikes });
		await this.rescheduleAtTargetCadence(cacheKey, renderTarget);
	}

	/**
	 * Retry shape for auth-shaped (401/403) and transient (408/429/5xx) failures — the ones
	 * that never suppress. Two lanes, split by the target's strike count
	 * (`render.failureRetry.fastRetries`):
	 *
	 *   FAST — the schedule is left holding its claim lease, so the retry comes on lease
	 *   expiry (`queue.jobLeaseTime`, minutes). An origin blip recovers fast, and the cached
	 *   page's swrTtl window keeps serving bots across a lease-sized wait.
	 *
	 *   SLOW — after `fastRetries` consecutive failures this is not a blip: drop to the
	 *   target's normal cadence so a persistently failing page can't hot-loop renders all
	 *   day, and push the kept page's `expiresAt` out to that retry so bots keep getting the
	 *   last good render instead of falling through to a failing origin (a cadence-sized
	 *   wait is far beyond swrTtl).
	 *
	 * Strikes are the target's one shared counter (suppression and redirect strikes use it
	 * too); any successful render clears it. A targetless key (render-now one-off) has its
	 * schedule dropped, as everywhere else.
	 */
	static async retryAfterFailure(cacheKey) {
		const sourceUrl = CacheKey.extractUrl(cacheKey);
		const renderTarget = await Target.get({ id: sourceUrl, select: ['strikes', 'renderInterval', 'sitemapUrl'] });
		if (!renderTarget) {
			await RenderSchedule.delete(cacheKey);
			return;
		}
		const strikes = (Number.isFinite(renderTarget.strikes) ? Number(renderTarget.strikes) : 0) + 1;
		await Target.patch(sourceUrl, { strikes });

		if (strikes <= config.render.failureRetry.fastRetries) {
			logger.warn(`Retrying ${cacheKey} on its claim lease (failure strike ${strikes})`);
			return; // schedule untouched — the lease written at claim drives the retry
		}

		const interval = resolveRenderInterval(sourceUrl, renderTarget.renderInterval);
		const nextRenderTime = currentMinuteMs() + interval;
		logger.warn(`Retrying ${cacheKey} at its normal cadence (failure strike ${strikes}) — extending the cached page`);
		await RenderSchedule.put(cacheKey, { nextRenderTime, fromSitemap: !!renderTarget.sitemapUrl });
		// Guarded by a point read: patch on a missing row would materialize a content-less
		// page record that the serving path could then try to serve. ARRAY select on purpose —
		// it builds a record (truthy for any existing row); a string select returns the bare
		// scalar, which is exactly the projection trap that has bitten twice before.
		const page = await databases.page_cache.PrerenderedPage.get({ id: cacheKey, select: ['cacheKey'] });
		if (page) {
			await databases.page_cache.PrerenderedPage.patch(cacheKey, { expiresAt: nextRenderTime });
		}
	}

	/**
	 * Keep a redirecting source in its rotation. Mirrors the post-render scheduling in
	 * processJobResult: a target-backed key comes due one interval from completion (so cadence
	 * self-paces instead of realigning into a herd); a targetless key (render-now one-off,
	 * orphaned row) has its schedule dropped so the lease doesn't re-claim it forever.
	 *
	 * `preloaded` (a row already read with at least renderInterval + sitemapUrl, e.g. by
	 * recordRedirectStrike) skips the point read.
	 */
	static async rescheduleAtTargetCadence(cacheKey, preloaded) {
		const sourceUrl = CacheKey.extractUrl(cacheKey);
		const renderTarget =
			preloaded ??
			(await Target.get({
				id: sourceUrl,
				select: ['renderInterval', 'sitemapUrl'],
			}));
		if (!renderTarget) {
			await RenderSchedule.delete(cacheKey);
			return;
		}
		// Same cadence resolution as the post-render path above (route > stored > default).
		const interval = resolveRenderInterval(sourceUrl, renderTarget.renderInterval);
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
			// synchronously with no per-job Target read. Preserve it on the lease
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
