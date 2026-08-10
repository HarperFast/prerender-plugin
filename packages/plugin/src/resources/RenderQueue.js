import { getMutex } from '../util/coordination.js';
import { config, onConfigApplied } from '../config.js';
import { currentMinuteMs } from '../util/time.js';
import { QueueState } from './QueueState.js';
import { CacheKey } from '../util/cacheKey.js';
import { canonicalizeUrl } from '../util/url.js';
import { classifyPath, queryAllowlistFor, resolveRenderInterval, PRERENDER } from '../util/routeClass.js';
import { decideInterval } from '../util/demandLadder.js';
import { backoffWait } from '../util/failureBackoff.js';
import { recordUnroutedPath } from '../util/unrouted.js';
import { metrics } from '../metrics.js';
import { Target, countedStrikes } from './Target.js';
import { getDesiredPause, setDesiredPause } from '../util/queueControl.js';
import { getResidencyByUrl } from '../util/residency.js';
import {
	claimSchedules,
	deleteSchedule,
	deriveQueueStatus,
	maybeResetFloor,
	reconcileLeaseGauge,
	releaseLease,
	resetFloorNow,
	writeSchedule,
} from '../util/renderSchedule.js';

const protocol = server.hostname === 'localhost' ? 'http' : 'https';
const port = protocol === 'https' ? server.config.http.securePort || server.config.http.port : server.config.http.port;

// The `RenderSchedule` table is deliberately NOT destructured here. Every read, write and delete
// of it goes through `util/renderSchedule.js`, which owns the due-time write and the claim-floor
// lowering together — a raw write from this file would file a row behind the floor and silently
// end that URL's rendering. `test/queueFunnel.test.js` enforces that mechanically.

const mutex = getMutex('render_queue');

// Rate limit for the wedged-row warning below. Per worker, which is the cheap and correct-enough
// direction: the pin AGE it gates on is node-wide (it lives in the shared header), so every worker
// agrees about when to start warning, and the worst case is one message per worker per window rather
// than one per node. Sharing a timestamp across workers would mean another header word and a CAS to
// suppress log lines.
let lastFloorPinWarnAt = 0;

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
 * store it into the node-local queue flag; when not paused, derive empty/queued. Caller must
 * hold `mutex`.
 *
 * This is what makes pause/resume work cluster-wide: `claim` reads a non-replicated,
 * node-local flag, so a remote node can't be addressed directly — but every node runs
 * this on its own status-sync interval, so a replicated intent write converges everywhere
 * within one `queue.statusSyncInterval`.
 *
 * THE STATUS RECOMPUTE NO LONGER SCANS. It used to run a second head-seeking query
 * (`nextRenderTime <= now`, limit 1) against the same index `claim` walks — measured at ~700ms
 * of synchronous native iteration per minute on an aged node, on worker 0, which also serves bot
 * traffic. Once a claim floor exists the answer is derivable from it plus the last claim outcome
 * at zero database cost, so the scan is gone. `test/queueStatusDerived.test.js` pins its absence
 * by installing a `search` that throws.
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

	// The floor reset rides here because this function already holds the claim mutex, which is
	// exactly the serialization a reset needs against a concurrent `advanceFloor`. It is the only
	// recovery for a due time written below the floor by the operations API or the exported REST
	// surface — nothing in-process can observe those writes.
	maybeResetFloor(Date.now());

	// And the lease-gauge walk rides here for the same reason, on the same cadence. It is NOT
	// bookkeeping: the gauge only ever drifts UP (a lease that expires without a result has nobody to
	// decrement it) and it SIZES the claim scan, so unreconciled it climbs until every claim pass
	// drains the full `queue.claimScanCap` — measured at 820 against 20 truly in flight after ~80
	// minutes, and minutes rather than hours during a broad origin outage. One walk fixes the number
	// for every worker, because the buffer is shared.
	reconcileLeaseGauge();

	const status = deriveQueueStatus(Date.now());
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

		// A missing or unparseable header used to make `subarray(0, NaN)` produce an empty buffer
		// and `JSON.parse('')` throw, which surfaced as a bare 500 with no clue what was wrong.
		// Nothing can be recovered from such a post — without a decoded `id` there is not even a
		// lease to release, so the lease just expires and the job is re-granted — so say so
		// legibly instead of leaving a mystery 500 in the log.
		if (!Number.isFinite(metadataSize) || metadataSize <= 0 || metadataSize > data.byteLength) {
			logger.error(
				`[prerender] job_result rejected: x-metadata-size is ${ctx.headers.get('x-metadata-size')} for a ` +
					`${data.byteLength}-byte body. The render's lease will expire and the job be re-granted.`
			);
			return new Response(
				JSON.stringify({ error: 'x-metadata-size must be a positive integer no larger than the request body' }),
				{ status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } }
			);
		}

		const result = this.decodeJobResult(data, metadataSize);

		// THE key the lease was granted under, captured before anything can re-point `cacheKey`.
		// The redirect refile below reassigns `cacheKey` to the destination, and releasing by that
		// would leak the SOURCE's lease on every rendered client-side redirect — the source row
		// would then pin the claim floor until the lease expired, every cycle, forever.
		const claimKey = result.id;
		// Set true by the branches whose retry pacing IS the lease (see retryAfterFailure): they
		// must keep it, or the row — which still carries its original overdue due time now that
		// the lease has left `nextRenderTime` — becomes immediately re-claimable and hot-loops.
		let holdLease = false;
		try {
			return await this.processDecodedJobResult(result, {
				holdLease: () => {
					holdLease = true;
				},
			});
		} catch (e) {
			// A THROW MUST HOLD THE LEASE. `holdLease` is only set by branches that ran to
			// completion, so without this a throw would release it — and a throw is precisely the
			// case where nothing moved the row forward. Worse, the throw propagates out of the
			// request handler, so Harper ABORTS the ambient transaction and rolls back whatever this
			// result did commit (the `PrerenderedPage.put` included). The row keeps its original
			// overdue due time and the floor is at or below its minute by construction, so a freed
			// lease means the next pass re-grants it seconds later: an unpaced re-render loop against
			// whatever is throwing, at claim frequency rather than once per lease.
			//
			// Reachable, not theoretical: `result.headers[...] = '1'` on a post with no headers
			// object, a `PrerenderedPage.put`/`createBlob` failure, a `Target.get`/`Target.patch`
			// rejection. Holding the lease paces the retry at `queue.jobLeaseTime`, exactly like the
			// fast-retry lanes below, and the 500 is what says the result was not processed.
			holdLease = true;
			throw e;
		} finally {
			// THE SINGLE RELEASE POINT. One lease, one result, one release — by `claimKey`.
			if (!holdLease && claimKey) releaseLease(claimKey);
		}
	}

	static async processDecodedJobResult(result, { holdLease }) {
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
					// The lane comes back up so the fast-retry branch inside it holds its lease just
					// like the two in this function — one release point, three deciders.
					const lane = await this.processRedirectResult(result, {
						redirectKey,
						landedOn,
						redirectPath,
						inspectedNonIndexable,
					});
					if (lane === 'fast') holdLease();
					return;
				}

				// A rendered result whose landed URL keys elsewhere (client-side redirect that
				// produced a real page): keep the long-standing refile semantics.
				if (outcome === 'rendered') {
					if (landedOn === PRERENDER) {
						// Retiring by URL takes the device siblings too — a page does not redirect
						// for one device and serve for another.
						logger.info(`Skipped prerendered url due to redirect: ${result.id} redirected to ${result.redirectedTo}`);
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
			metrics.renderTime(
				result.renderTime,
				result.statusCode,
				typeof result.isIndexable === 'boolean'
					? result.isIndexable || hasContent
						? 'candidate'
						: 'non-candidate'
					: 'unknown'
			);
		}

		if (outcome === 'rendered') {
			// One render_outcome per posted result (the redirect path emits its own inside
			// processRedirectResult). `refiled` = the client-side-redirect re-key above moved the
			// result onto the destination's cache key; `discarded` = it landed on a class we never
			// serve and the content was dropped.
			metrics.renderOutcome('rendered', discardContent ? 'discarded' : cacheKey !== result.id ? 'refiled' : 'stored');
			const url = CacheKey.extractUrl(cacheKey);
			const renderTarget = await Target.get({
				id: url,
				select: ['renderInterval', 'sitemapUrl', 'state', 'strikes', 'demandInterval'],
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
			const base = resolveRenderInterval(url, renderInterval);
			// The demand ladder reallocates cadence WITHIN `base` (which stays the ceiling) by
			// whether bots actually visit this URL. Off / dry-run / cold filter all return `base`
			// unchanged, so this is a no-op until deliberately switched on.
			const demand = decideInterval(url, base, renderTarget?.demandInterval);
			const interval = demand.interval;
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
				//
				// This is the highest-volume schedule write in the system, and it writes
				// `now + interval` — i.e. FORWARD. The funnel's floor lowering is a CAS-min, so this
				// path costs one atomic load and moves the floor not at all. That is load-bearing: a
				// lowering on every completed render would rewind the floor to the current minute
				// continuously and the whole 14× seek win would evaporate.
				await writeSchedule(cacheKey, { nextRenderTime, fromSitemap: !!renderTarget.sitemapUrl });

				// Persist the rung ONLY on an actual move. 'held' must not write even when the
				// stored field is absent — absence already resolves to the base ceiling, so writing
				// it would be redundant, and on first evaluation it would be a corpus-wide storm of
				// replicated Target patches (~one per render for a full cycle), in dry-run too.
				// A converged corpus therefore pays nothing here, on the system's hottest path.
				if (demand.action === 'promoted' || demand.action === 'demoted') {
					await Target.patch(url, { demandInterval: demand.level });
				}

				// A suppressed URL that rendered indexable again has healed — put it back in
				// normal rotation, so the recheck cadence stops and discovery may see it again.
				if (renderTarget.state === 'suppressed' && result.isIndexable === true) {
					logger.info(`Prerendered url ${url} is indexable again — lifting its suppression`);
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
				//
				// The delete does NOT release the key's lease (see util/renderSchedule.js): the slot
				// keeps holding the claim floor at this row's old due minute until it expires. That
				// is the conservative direction — releasing here would let the floor advance past a
				// row whose result may still be arriving from a duplicate renderer.
				await deleteSchedule(cacheKey);
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
				metrics.renderOutcome('auth-failure', result.statusCode);
				logger.error(
					`Prerender got ${result.statusCode} for ${cacheKey} — auth-shaped, NOT suppressing. ` +
						`If these are widespread, check the renderer's origin-bypass credential and the CDN/origin access rules.`
				);
				if ((await this.retryAfterFailure(cacheKey)) === 'fast') holdLease();
			} else if (result.statusCode === 408 || result.statusCode === 429 || result.statusCode >= 500) {
				// Transient-shaped: the origin failed to serve the page, it didn't disavow it.
				// Suppressing would delete the last good cached page and park the URL for the
				// recheck interval over what may be one bad minute at the origin — keep both
				// and retry via retryAfterFailure (fast first, then the target's cadence).
				metrics.renderOutcome('transient', result.statusCode);
				// info, not warn: by-design tolerance of an origin blip. The aggregate (a transient
				// BURST is origin trouble) is render_outcome's job, not a per-URL log flood's.
				logger.info(`Prerender got transient ${result.statusCode} for ${cacheKey} — keeping target and cached page`);
				if ((await this.retryAfterFailure(cacheKey)) === 'fast') holdLease();
			} else {
				metrics.renderOutcome('suppressed', result.reason ?? 'unspecified');
				// info, not warn: a suppression is a normal verdict (the page declared itself
				// non-indexable) and it self-heals on its own recheck cadence. The alertable event is
				// MASS suppression, which is the render_outcome counter's job.
				logger.info(`Suppressing prerendered url: ${cacheKey}${result.reason ? ` (${result.reason})` : ''}`);
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
			metrics.renderOutcome('failed', result.error?.phase ?? 'unknown');
			logger.warn(`Prerender failed for ${cacheKey} (${result.reason || 'no reason reported'})${detail}`);
			// Same lane as every other non-suppressing failure: fast retries on the held lease,
			// then escalation to a backed-off due time. This branch used to hold the lease
			// unconditionally and forever — no strike, no escalation — so a permanently-crashing
			// render re-rendered once per `queue.jobLeaseTime` for the life of the target.
			//
			// The waste was never the renders (measured: 7 such keys per node, ~42 renders/hr
			// against a fleet doing 87,660). It was the CLAIM FLOOR: a held lease pins the floor at
			// its row's due minute, so a handful of permanently-failing rows held the floor 12+
			// hours in the past indefinitely, and every claim scan seeked from there across dead
			// index entries. Escalating returns 'slow', which releases the lease and lets the floor
			// advance — that is the point of this change, not the saved render capacity.
			//
			// `retryAfterFailure` does its own target read (and drops a targetless render-now /
			// orphaned row), so the redundant existence check that used to guard this branch is gone.
			if ((await this.retryAfterFailure(cacheKey)) === 'fast') holdLease();
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
	 *
	 * Returns the retry lane when it took one (`'fast'`/`'slow'`/`'dropped'`), so the caller — the
	 * single lease-release point — knows whether this result's pacing is the lease itself.
	 */
	static async processRedirectResult(result, { redirectKey, landedOn, redirectPath, inspectedNonIndexable }) {
		if (typeof result.renderTime === 'number') {
			metrics.renderTime(result.renderTime, result.statusCode, 'redirect');
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
			metrics.renderOutcome('redirect', authShaped ? 'landed-auth' : 'landed-transient');
			// error for auth (credential/mitigation trouble), info for transient (origin blip) —
			// same split as processJobResult's non-redirect branches.
			logger[authShaped ? 'error' : 'info'](
				`Prerendered url ${result.id} redirected to ${result.redirectedTo}, which returned ${result.statusCode} — ` +
					`${authShaped ? 'auth-shaped' : 'transient'}, keeping the target`
			);
			return await this.retryAfterFailure(result.id);
		}

		if (landedOn !== PRERENDER) {
			// The destination is a class we never serve from cache — adopting it would file
			// renders where no read looks, and deleting the source on ONE such result would end
			// its rendering on evidence as weak as an incomplete route list. Keep the source and
			// retry at its normal cadence (the retry costs a navigation, not a full settle) —
			// but count the strike: a source that answers this way every interval is de facto
			// permanently redirected, and recordRedirectStrike retires it after maxStrikes.
			metrics.renderOutcome('redirect', 'unrouted-destination');
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
			metrics.renderOutcome('redirect', 'non-indexable-destination');
			logger.info(
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
			metrics.renderOutcome('redirect', 'temporary');
			logger.info(
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
		metrics.renderOutcome('redirect', 'permanent');
		logger.info(
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
			await deleteSchedule(cacheKey);
			return;
		}
		const strikes = countedStrikes(renderTarget.strikes) + 1;
		const maxStrikes = config.render.redirects.maxStrikes;
		if (Number.isFinite(maxStrikes) && maxStrikes > 0 && strikes >= maxStrikes) {
			logger.info(
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
	 *   FAST — the schedule row is left alone AND THE CALLER KEEPS THE CLAIM LEASE, so the retry
	 *   comes on lease expiry (`queue.jobLeaseTime`, minutes). An origin blip recovers fast, and
	 *   the cached page's swrTtl window keeps serving bots across a lease-sized wait.
	 *
	 *   SLOW — after `fastRetries` consecutive failures this is not a blip: drop to the
	 *   target's normal cadence so a persistently failing page can't hot-loop renders all
	 *   day. The kept page's expiry is deliberately NOT extended: `swrTtl` is the product
	 *   bound on how stale we serve as if fresh, and past it bots fall through to the
	 *   origin — whose answer (a live page for auth-shaped failures, an honest 5xx for
	 *   transient ones) is the truth. Serving arbitrarily old snapshots while users get
	 *   errors would break bot/user parity.
	 *
	 * Strikes are the target's one shared counter (suppression and redirect strikes use it
	 * too); any successful render clears it. A targetless key (render-now one-off) has its
	 * schedule dropped, as everywhere else.
	 *
	 * WHAT CHANGED IN v0.34.0, AND WHY IT HAD TO. The fast lane used to work purely by omission:
	 * `claim` wrote `now + jobLeaseTime` into `nextRenderTime`, so "leave the schedule untouched"
	 * meant "the row is due again at lease expiry". With the lease moved out of the row (see
	 * util/renderLease.js), "untouched" means the row still carries its ORIGINAL overdue due time
	 * and is immediately re-claimable — a paced retry silently becomes a hot loop re-rendering a
	 * failing page as fast as the fleet can claim it. So the fast lane now returns `'fast'` and
	 * the caller does NOT release the lease. The timing is deliberately unchanged: the lease
	 * expires at CLAIM + jobLeaseTime, so a render that fails 30s in retries in
	 * jobLeaseTime − 30s. The lease is NOT re-armed to `now + jobLeaseTime` on failure — that
	 * would quietly lengthen a documented wait.
	 *
	 * The cost, which belongs in the operator's head: a held lease holds the claim floor, so
	 * `fastRetries: 2` can pin it for 2 × jobLeaseTime (20 minutes on defaults), and during a
	 * broad origin 5xx or a bot-mitigation rule change EVERY job takes this lane and no lease is
	 * released at all for that window.
	 *
	 * @returns {Promise<'fast'|'slow'|'dropped'>} which lane was taken. `'fast'` means the caller
	 *   must keep the lease; the other two mean release it (the row is now in the future or gone,
	 *   and holding a lease for it would pin the claim floor for a full lease for nothing).
	 */
	static async retryAfterFailure(cacheKey) {
		const sourceUrl = CacheKey.extractUrl(cacheKey);
		const renderTarget = await Target.get({ id: sourceUrl, select: ['strikes', 'renderInterval', 'sitemapUrl'] });
		if (!renderTarget) {
			await deleteSchedule(cacheKey);
			return 'dropped';
		}
		const strikes = countedStrikes(renderTarget.strikes) + 1;
		await Target.patch(sourceUrl, { strikes });

		if (strikes <= config.render.failureRetry.fastRetries) {
			logger.debug(`Retrying ${cacheKey} on its claim lease (failure strike ${strikes})`);
			// Schedule untouched, lease held by the caller — the lease expiry drives the retry.
			return 'fast';
		}

		const interval = resolveRenderInterval(sourceUrl, renderTarget.renderInterval);
		const fromSitemap = !!renderTarget.sitemapUrl;
		const wait = backoffWait(interval, strikes, fromSitemap);
		const nextRenderTime = currentMinuteMs() + wait;
		logger.debug(
			`Retrying ${cacheKey} in ${Math.round(wait / 60000)}m (failure strike ${strikes}` +
				`${fromSitemap ? '' : ', non-sitemap'})`
		);
		await writeSchedule(cacheKey, { nextRenderTime, fromSitemap });
		return 'slow';
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
			await deleteSchedule(cacheKey);
			return;
		}
		// Same cadence resolution as the post-render path above (route > stored > default).
		const interval = resolveRenderInterval(sourceUrl, renderTarget.renderInterval);
		await writeSchedule(cacheKey, {
			nextRenderTime: currentMinuteMs() + interval,
			fromSitemap: !!renderTarget.sitemapUrl,
		});
	}

	/**
	 * Grant up to `limit` due jobs.
	 *
	 * THE RESPONSE SHAPE IS A CONTRACT: HTTP 200 with a bare JSON array, `[]` when there is
	 * nothing to grant. The render fleet's consumer treats only 200 as success and immediately
	 * `.map`s the body — a 204, an object wrapper, or a new status code circuit-breaks a
	 * perfectly healthy node.
	 *
	 * WHAT NO LONGER HAPPENS HERE: the per-job lease write. `claim` used to write
	 * `nextRenderTime = now + jobLeaseTime` back onto every granted row, which was a second
	 * write per render landing on the hot head of the very index the scan seeks from. The lease
	 * now lives in a node-local shared buffer (util/renderLease.js) and recording it is an atomic
	 * store, so one render costs exactly ONE schedule write — the reschedule when its result
	 * lands. That halves queue write volume and audit bytes (~87 → ~44 MB/day/node).
	 *
	 * `expiresAt` is therefore no longer minute-floored either. The flooring only ever existed
	 * because the value doubled as a `nextRenderTime`, and it silently cost up to 59,999 ms of
	 * lease — which matters because the fleet discards any granted job with under 30s of lease
	 * left (hence `queue.jobLeaseTime`'s two-minute minimum).
	 */
	static claim = mutex.withLock(async ({ limit = 20 } = {}) => {
		if (QueueState.status === 'paused') {
			return [];
		}

		// Bound the batch server-side so no consumer can over-claim: the whole pass runs under
		// this mutex, and one worker must not be able to hold it while hoarding a burst other
		// renderers should share.
		limit = Math.min(Math.max(1, limit | 0), config.queue.maxClaimLimit);

		// One pass: floored scan, drained before anything is leased, leases granted from memory,
		// floor advanced to the first due row the pass saw. All of it in util/renderSchedule.js —
		// this function owns the wire format and the status report, nothing else.
		const scanStarted = performance.now();
		const pass = await claimSchedules({ grantLimit: limit });
		// The queue's leading indicator: this duration degrades (measured 17x once) when dead index
		// entries pile at the seek point, before any backlog shows. Two clock reads and one buffered
		// emit per pass — nothing on the per-row path.
		metrics.claimScan(
			performance.now() - scanStarted,
			pass.scanTruncated ? 'capped' : pass.jobs.length ? 'granted' : 'empty'
		);

		const jobs = [];
		let notOwnedHere = 0;

		for (const granted of pass.jobs) {
			const { url, deviceType } = CacheKey.parse(granted.cacheKey);

			// Detection only, deliberately. `claim`'s lease write used to purge a stale local
			// record on a node that is no longer the residency owner, as a side effect; that purge
			// is gone with the write. The corrective write is a new write on the hot claim path with
			// residency semantics that could not be verified, so Stage 1 ships the count and leaves
			// the repair to `render.reconcile` (which restores the row on the new owner) until this
			// number proves it happens.
			if (getResidencyByUrl(url) !== server.hostname) notOwnedHere++;

			jobs.push({
				id: granted.cacheKey,
				url,
				deviceType,
				expiresAt: granted.expiresAtMs,
				callbackOrigin: `${protocol}://${server.hostname}:${port}`,
				// `fromSitemap` is denormalized onto the schedule row, so the job is built with no
				// per-job Target read.
				isFromSitemap: !!granted.fromSitemap,
			});
		}

		if (pass.leaseRefused) {
			// Deliberately not "all N slots are in use": a grant is also refused when the key's
			// 8-slot probe window is full (occupancy can be a fraction of maxLeases) or when its
			// publish CAS lost a race. Report the occupancy and let it say which.
			logger.warn(
				`[prerender] claim could not record a lease for a due row: ${pass.occupancy} of ` +
					`${config.queue.maxLeases} slots occupied. Granted ${jobs.length} of ${limit}. If the occupancy is ` +
					`near the table size, raise queue.maxLeases (restart-scoped); if it is nowhere near it, the key's ` +
					`probe window is full and the next pass will place it elsewhere.`
			);
		} else if (pass.scanTruncated && jobs.length < limit) {
			logger.warn(
				`[prerender] claim hit its ${pass.scanLimit}-row scan cap with ${pass.occupancy} lease(s) in flight and ` +
					`granted ${jobs.length} of ${limit}, without reaching a not-yet-due row. In-flight work is filling ` +
					`the scan window — raise queue.claimScanCap, or look at ${pass.floorHeldBy ?? 'the oldest due row'}, ` +
					`which is holding the claim floor at minute ${pass.floorTo}.`
			);
		}

		// A SEPARATE CHECK, deliberately not chained onto the branches above. The wedged row this names
		// is one due row that never reschedules on an otherwise HEALTHY node: every pass still reaches a
		// not-yet-due row, so `scanTruncated` is false and `leaseRefused` is false, and the branch above
		// stays silent for as long as the node runs. That was the whole failure — the single scenario the
		// `floorHeldBy` report was added for was the one scenario that could never print it, while the
		// scan quietly degraded past the cost the floor was introduced to remove.
		//
		// The threshold is what the retry design itself can explain and no more: the fast-retry lane
		// holds its lease, and therefore the floor, for `fastRetries` full leases before the slow lane
		// writes the row forward, so one further lease beyond that is not a lane — it is a row whose
		// result never comes. Rate-limited to one line per window per worker, so a genuinely stuck row
		// says so about twice before `queue.claimFloor.unpinAfter` pushes it forward on its own.
		// Gated on the floor being ON: with it off the scan seeks from the absolute index minimum anyway,
		// so a row that never moves costs nothing extra and there is nothing to warn about.
		if (config.queue.claimFloor.enabled) {
			const explainable = config.queue.jobLeaseTime * (Math.max(0, config.render.failureRetry.fastRetries | 0) + 1);
			if (pass.floorPinnedForMs > explainable && Date.now() - lastFloorPinWarnAt >= explainable) {
				lastFloorPinWarnAt = Date.now();
				const unpin = config.queue.claimFloor.unpinAfter;
				logger.warn(
					`[prerender] ${pass.floorHeldBy} has held the claim floor at minute ${pass.floorTo} for ` +
						`${Math.round(pass.floorPinnedForMs / 60_000)} minute(s) — longer than the retry lanes can account ` +
						`for (${Math.round(explainable / 60_000)} min), so its render is failing in a way that posts no ` +
						`result and reschedules nothing. Everything due behind it is waiting and the nextRenderTime index ` +
						`is degrading above it. ` +
						(unpin > 0
							? `It will be pushed forward automatically after ${Math.round(unpin / 60_000)} min.`
							: `queue.claimFloor.unpinAfter is 0, so this will NOT resolve on its own — repair or delete the URL.`)
				);
			}
		}

		if (notOwnedHere) {
			logger.warn(
				`[prerender] claim granted ${notOwnedHere} job(s) for URL(s) this node does not own by residency. ` +
					`Stale local schedule rows on a former owner are no longer purged at claim time; the schedule ` +
					`reconcile sweep restores them on the new owner.`
			);
		}

		if (jobs.length === 0) {
			// TRI-STATE, and the distinction is not cosmetic. "Saw due rows but granted none" means
			// a large backlog is entirely in flight (or the scan cap was consumed by it) — reporting
			// `empty` there tells every consumer in the fleet to back off to its idle interval while
			// there is work, and nothing corrects it until the next status sync.
			QueueState.reportStatus(pass.sawDue ? 'queued' : 'empty');
		}

		return jobs;
	});

	/**
	 * Reset the claim floor now instead of waiting out `queue.claimFloor.resetInterval`.
	 *
	 * The operator escape hatch for the one write this plugin cannot see: a due time written
	 * below the floor through the operations API or the exported `RenderSchedule` REST surface.
	 * Under the claim mutex, so it cannot interleave with a pass's `advanceFloor`.
	 */
	static resetClaimFloor = mutex.withLock(async () => ({ ...resetFloorNow(), node: server.hostname }));

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
 * Idempotent. The interval follows `queue.statusSyncInterval` changes without a restart.
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

	let armedInterval = config.queue.statusSyncInterval;
	let timer = setInterval(refresh, armedInterval);
	timer.unref?.();

	onConfigApplied(() => {
		if (config.queue.statusSyncInterval === armedInterval) return;
		clearInterval(timer);
		armedInterval = config.queue.statusSyncInterval;
		timer = setInterval(refresh, armedInterval);
		timer.unref?.();
	});
}
