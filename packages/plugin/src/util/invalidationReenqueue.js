/**
 * THE INVALIDATION ACCELERATOR — demand-driven heal, DEFAULT OFF.
 *
 * When an invalidation is what made a request non-servable, lower that URL's due time so the pages
 * bots actually crawl heal first. The REQUEST is the trigger: no timer, no table scan, no cursor,
 * no cursor state to lose. It runs after the response, in a `setImmediate`, beside
 * `handlePageScheduling`.
 *
 * WHY THIS SHAPE AND NOT A SWEEP, once, so nobody re-proposes one. The long-tail corpus is
 * 1,530,046 keys against a measured fleet ceiling of 71,289 renders/hr — a full re-render floors at
 * 21.5h at 100% utilisation, against the 48h those pages wait anyway, and measured utilisation is
 * already 98% with a 3.05h standing backlog. A bulk rewrite also costs 61.8MB of audit per node
 * (162 B/row, which pacing provably does not reduce), and claim is strictly due-time ascending, so
 * 1.53M corpses sit in front of the 1h and 12h routes. Against a claim floor it fails SILENTLY:
 * measured, a bulk lowering under a stale floor returned 0 rows in 23ms — the entire invalidation
 * invisible to claim. Crawl demand is the only selector that is both free and correctly ordered:
 * ~4,000 bot requests/day against 1.6M keys, i.e. crawlers ask for ~0.25% of the corpus, and those
 * are exactly the pages whose staleness is visible to anyone.
 *
 * ── OWNER-NODE ONLY, AND WHY THAT IS NOT A LIMITATION WORTH ENGINEERING AWAY ────────────────────
 *
 * A due-time write is residency-routed and reaches the owner from any node, but the CLAIM FLOOR it
 * has to move is a node-local shared buffer (`SharedBuffer` is `replicate: false`) and `claim`
 * reads the schedule with `replicateFrom: false`. So an accelerating write from a non-owner lowers
 * ITS OWN floor — a no-op — and files a row beneath the owner's. That is the measured
 * "0 rows returned" shape. Hence guard 1: only the owner acts, which also makes the schedule read
 * node-authoritative. Coverage is ~25% of invalidated requests on a four-node cluster (HRW
 * arithmetic, not a measurement — `invalidation_reenqueue{outcome='not-owner'}` against the total
 * is what finally measures it), and crawlers revisit, so the other 75% heal on a later crawl that
 * lands on the owner.
 *
 * Because every write here goes through `util/renderSchedule.js` — the funnel — and the funnel
 * lowers the floor as part of the write, an owner-node write discharges the floor obligation BY
 * CONSTRUCTION. There is deliberately no second watermark mechanism in this module.
 *
 * ── THE GUARDS, EACH CLOSING A NAMED HAZARD ────────────────────────────────────────────────────
 *
 * Cheapest first, and every refusal is COUNTED — a skip is normal here, but it must not be silent,
 * or "the accelerator is enabled" and "the accelerator is doing anything" become indistinguishable.
 *
 *   not-owner    residency (above). A pure hash, no I/O.
 *   paused       this node's queue is paused. One atomic load off `QueueState`'s shared flag.
 *   leased       a device key of this URL is being rendered right now. The lease lives in this
 *                node's buffer and we own the key, so this is exact and free. Lowering under a live
 *                claim is pointless (the result rewrites the due time on completion) and, before
 *                #72 moved leases out of the row, was a duplicate render in flight.
 *   no-schedule  no schedule row for any device key. NEVER CREATED here (I13): a schedule row with
 *                no target is the render-now one-off shape, which `processJobResult` drops.
 *   no-target    no Target row. Same rule, other direction — creating one would silently enroll a
 *                URL in the rotation from a serve-path side effect.
 *   unhealable   `countedStrikes(target.strikes) > render.failureRetry.fastRetries` (a whole-URL
 *                property — one shared counter), OR every device row implies a render that COMPLETED
 *                after the epoch and still did not heal. See below.
 *   not-sooner   no device row is due later than the jittered time we would write, so writing could
 *                only RAISE a due time (I10). Also what makes an explicit `renderNow` heal
 *                idempotent: that path already wrote the current minute.
 *   throttled    the per-node minute budget is spent.
 *   error        the write threw. Logged, counted, swallowed — a failed acceleration must never
 *                turn into a 500 on a request that has already been answered.
 *
 * THE LAST TWO ARE TESTED PER ROW, NOT PER URL, because the WRITE is per row. A split pair is a
 * normal production state, not an edge case — `PrerenderAdmin.revalidateUrl` and `renderNow` each
 * write ONE device key on purpose, `util/reconcile.js` repairs a missing row with a fresh jitter, and
 * every per-device retry lane diverges the pair by its own delay. Taking either verdict from the
 * device the request happened to arrive on and applying it to the whole URL let the crawler's
 * User-Agent choose which invariant held: a mobile crawl would re-arm a desktop row that a desktop
 * crawl had just been refused (I11 lost), and one overdue sibling refused acceleration of the very key
 * whose page the invalidation had made unservable (I12's fan-out inverted into a whole-URL veto).
 * Skipping a row instead is safe in both directions: an unhealable key has no post-epoch content for
 * the pair to align with anyway, and an already-sooner key is already ahead in the claim order.
 *
 * I13 ("never creates a Target or a schedule row") is enforced by `no-schedule`/`no-target` against a
 * row that is ABSENT WHEN WE READ IT. It is not proof against a `Target.delete` landing between those
 * reads and the write — that window is one microtask wide, and the orphan it leaves is claimed once
 * and dropped by `processJobResult`'s targetless branch. Documented rather than closed: closing it
 * costs a second Target read after the write, which is what the orphan costs anyway.
 *
 * WHY `strikes > 0` IS NOT THE UNHEALABLE TEST. `processJobResult`'s `discardContent` branch
 * (a render that landed on a redirect destination we cannot key) counts as `outcome: 'rendered'`,
 * so it reschedules at cadence AND RESETS `strikes` TO 0 while writing no page. A key parked there
 * has a perfectly healthy-looking target and can never heal. The test that catches it is
 * arithmetic on the row we already read: `processJobResult` writes
 * `nextRenderTime = completionMinute + interval`, so `nextRenderTime - interval` IS the minute the
 * last render completed. If that is after the epoch and the page is still pre-epoch, a render
 * completed after the invalidation and did not heal this key — re-arming it would re-render it on
 * every crawl forever, neutralising the slow-retry lane whose entire purpose is that "a
 * persistently failing page can't hot-loop renders all day".
 *
 * A suppressed target cannot reach here at all, and that is by construction rather than by a
 * guard: `Target.suppress` deletes the cached pages, and the epoch is only read when a page was
 * about to be served.
 *
 * ── THE RATE LIMIT ─────────────────────────────────────────────────────────────────────────────
 *
 * Per NODE, shared across workers, in one minute-bucketed counter in a named shared buffer — the
 * same primitive the claim floor and the queue-status flag use (`util/coordination.js#getSab`).
 * It bounds requests, and one request writes at most one row per device row THE URL HAS —
 * `deviceTypes.default`, plus the served device when that one is merely `supported` — so the write
 * ceiling is `maxPerMinute ×` those rows (20/min/node at the two-device default, ≈2.3MB of
 * audit/node/day, ~7% of measured spare fleet capacity against ~1,000 owner-node candidate
 * requests/day cluster-wide).
 *
 * The slot is reserved LATE — after every refusal test, immediately before the write. Reserving
 * first would bound the reads too, but one repeatedly-crawled unhealable URL would then burn the
 * whole node's budget and starve every key that can actually heal. Reads stay bounded by bot
 * traffic instead: one Target read plus one schedule read per device key, on ≤2,900 cache-servable
 * requests/day cluster-wide, of which only the ~25% this node owns get past guard 1. An invalidated
 * request also pays `handlePageScheduling`'s own `Target.get` in the sibling `setImmediate` — the same
 * primary key, a different projection, deliberately NOT shared: that read is the rediscovery repair
 * for a page whose Target was deleted and it has to be fresh at the moment it runs.
 */

import { config } from '../config.js';
import { Target, cacheKeysOf, countedStrikes } from '../resources/Target.js';
import { QueueState } from '../resources/QueueState.js';
import { getSab } from './coordination.js';
import { getScheduleRow, leaseInfo, writeSchedules } from './renderSchedule.js';
import { getResidencyByUrl } from './residency.js';
import { forwardHeal, isPeerHealActive } from './peerHeal.js';
import { PRERENDER, resolveEffectiveInterval, resolveRenderInterval } from './routeClass.js';
import { MINUTE, getInitialRenderTime, numberOf } from './time.js';
import { metrics } from '../metrics.js';

/**
 * Every value the `outcome` dimension can take. Exported so a dashboard or a test can enumerate
 * them rather than discovering them from production traffic — §12.4's coverage question
 * (`not-owner` against the total) is only answerable if the refusal set is closed and named.
 */
export const REENQUEUE_OUTCOMES = [
	'lowered',
	'not-owner',
	'paused',
	'leased',
	'no-schedule',
	'no-target',
	'unhealable',
	'not-sooner',
	'throttled',
	'error',
	// Cross-node only (util/peerHeal.js). `forwarded` means this node handed the heal to the owner —
	// NOT that a row moved; the owner counts its own verdict in this same series, so the two are
	// deliberately not double-counted. `forward-failed` is a transport fault (peer down, timeout,
	// non-2xx), never a refusal the owner made.
	'forwarded',
	'forward-failed',
];

// [minuteSinceEpoch, requestsThisMinute]. Minutes-since-the-epoch is ~29.4M today, so it fits an
// int32 for another 4,000 years — the same assumption `util/renderLease.js` makes about due minutes.
const RATE_SAB_KEY = 'invalidation_reenqueue_rate';
const R_MINUTE = 0;
const R_COUNT = 1;
const RATE_SAB_BYTES = 8;

// ALLOCATED ON FIRST USE, NEVER AT MODULE SCOPE: `databases` is not populated when this module is
// evaluated (the handler chain imports it before `handleApplication` runs), which is the same rule
// the lease table's buffer follows in util/renderSchedule.js.
let rateWindow = null;
const rateWindowI32 = () => {
	if (!rateWindow) rateWindow = new Int32Array(getSab(RATE_SAB_KEY, RATE_SAB_BYTES));
	return rateWindow;
};

/**
 * Reserve one accelerated request against this node's budget for the current minute.
 *
 * THE MINUTE IS SAMPLED HERE, WHERE THE SLOT IS SPENT — not at `accelerateHeal` entry. Between the
 * two there is an awaited Target read and one schedule read per device key, so a request that entered
 * at 12:00:59.9 files its rows in the NEXT minute, and the budget belongs to the minute the write
 * lands in.
 *
 * THE WINDOW ROLLS FORWARD ONLY (`minute > observedMinute`). Sampling at entry made a backwards roll
 * reachable from ordinary traffic: requests straddling a minute boundary arrive here carrying
 * different minutes, and a straggler carrying the older one won the CAS and zeroed a counter the new
 * minute had already spent — so each flip handed out the whole budget again and the documented
 * ceiling bounded nothing. With a monotonic roll the only cost of a backwards CLOCK step is that the
 * current budget stays spent until the clock catches up: the safe direction, and counted as
 * `throttled` rather than being silent.
 *
 * Whoever wins the roll zeroes the counter. A loser can read a count that is a few instructions
 * stale, which costs or grants at most one request in that minute. That is deliberate: this bounds
 * audit volume and render capacity with ~14x headroom over measured demand, it is not a safety
 * property, and a cross-worker mutex on the tail of the serve path would buy exactness nobody needs.
 */
const reserveSlot = () => {
	const i32 = rateWindowI32();
	const limit = Math.max(1, config.invalidation.reenqueue.maxPerMinute | 0);
	const minute = Math.floor(Date.now() / MINUTE);

	const observedMinute = Atomics.load(i32, R_MINUTE);
	if (minute > observedMinute && Atomics.compareExchange(i32, R_MINUTE, observedMinute, minute) === observedMinute) {
		Atomics.store(i32, R_COUNT, 0);
	}

	for (let attempt = 0; attempt < 8; attempt++) {
		const used = Atomics.load(i32, R_COUNT);
		if (used >= limit) return false;
		if (Atomics.compareExchange(i32, R_COUNT, used, used + 1) === used) return true;
	}
	// Eight lost races means the budget is being spent by other workers right now. Refusing is the
	// safe direction and the accounted one — a skip here is a normal outcome, not an error.
	return false;
};

/**
 * The jitter window actually used, clamped up to `queue.jobLeaseTime`.
 *
 * WHAT THE CLAMP IS FOR IS SPREAD, NOT LEASES. A narrow window piles this node's accelerated rows
 * onto a handful of minutes, and a pile lands exactly where the claim scan seeks: measured, that takes
 * the claim scan from 0.36ms to 11.59ms (32x), and the scar clears only on the store's next
 * compaction. `spreadWindow: 0` would collapse them onto ONE minute, which is why there is
 * deliberately no way to ask for "due now" here. `jobLeaseTime` is the floor only because the schema
 * already enforces `min: 2 * MINUTE` on it — i.e. it is the smallest spread this system already
 * trusts, not a coupling between the two quantities.
 *
 * IT IS NOT A LEASE GUARD, and it was documented as one in three places. That story — a row re-armed
 * sooner than `jobLeaseTime` comes due while the render it is chasing still holds its lease and pins
 * the claim floor for the rest of it — cannot be delivered by a window WIDTH: `dueAt` is uniform over
 * `[now, now + window)`, so even at the defaults (15min window, 10min lease) two thirds of accelerated
 * keys are re-armed sooner than a lease. The hazard is closed exactly, and elsewhere, by the `leased`
 * guard: it refuses when ANY device key of the URL holds a live lease, read out of this node's own
 * buffer. Left as it was, that sentence is what a future reader would cite to decide the `leased`
 * guard is redundant.
 *
 * `collectConfigWarnings` reports the misconfiguration by name, so the clamp is documented rather
 * than silent. Clamping instead of rejecting back to the default is the conservative direction:
 * rejecting would silently WIDEN a window an operator deliberately narrowed.
 */
const spreadWindowMs = () => Math.max(config.invalidation.reenqueue.spreadWindow, config.queue.jobLeaseTime);

const record = (outcome, scope) => metrics.invalidationReenqueue(outcome, scope);

/**
 * Accelerate one URL, or say exactly why not. Awaited by tests; in production it runs detached
 * from the response (see `maybeAccelerateHeal`).
 *
 * `url` is the canonical URL half of the cache key — the `Target` primary key. `invalidatedBy` is
 * `resolveServeStatus`'s verdict, so `.at` ALREADY INCLUDES `invalidation.pad`.
 */
export const accelerateHeal = async ({ url, cacheKey, invalidatedBy, forwarded = false }) => {
	// No null tolerance here, on purpose: the one production caller (`maybeAccelerateHeal`)
	// returns before dispatch without a verdict, so a null `invalidatedBy` is a caller bug —
	// better a loud TypeError on the first property read than a guard that quietly accepts it.
	const scope = invalidatedBy.scope ?? null;
	const refuse = (outcome, extra) => {
		record(outcome, scope);
		return { outcome, ...extra };
	};

	const owner = getResidencyByUrl(url);
	if (owner !== server.hostname) {
		// `forwarded` is set by the peer endpoint, and is what makes this a LEAF. If a forwarded heal
		// arrives at a node that does not consider itself the owner — residency disagreement during a
		// topology change — it refuses here rather than forwarding again. Without this, two nodes that
		// disagree could bounce one heal between them until a timeout.
		if (forwarded || !isPeerHealActive()) return refuse('not-owner', { owner });

		// THE SLOT IS RESERVED BEFORE THE CALL, not before the write as on the local path, and that
		// inversion is the whole cost argument: it makes `maxPerMinute` bound CALLS MADE (40/min/node
		// at the current setting) rather than leaving them proportional to invalidated traffic
		// (~66,000/hr measured). The local path reserves late for the opposite reason — so one
		// repeatedly-crawled unhealable URL cannot burn the budget before the cheap refusals run —
		// and that reasoning does not transfer here, because off-owner none of those refusals can be
		// evaluated at all.
		if (!reserveSlot()) return refuse('throttled', { owner });

		const sent = await forwardHeal({ owner, url, cacheKey });
		// The OWNER counted its own outcome in its own `invalidation_reenqueue` series, so counting
		// the verdict again here would double-count every forwarded heal cluster-wide. This node
		// records only that it forwarded — the transport step, which is the thing its own metrics can
		// legitimately claim to know about.
		if (!sent.ok) return refuse('forward-failed', { owner, reason: sent.reason });
		record('forwarded', scope);
		return { outcome: 'forwarded', owner, ownerOutcome: sent.outcome };
	}

	// One atomic load off the node-local flag every worker shares. A paused node must not accumulate
	// pulled-forward due times it is not draining — they would all come due at once on resume.
	if (QueueState.status === 'paused') return refuse('paused');

	// The device keys this URL implies, plus the key the request was actually served under: a device
	// type may be `supported` (so it has pages and rows) without being in `deviceTypes.default`, and
	// excluding it would leave the one key the request was about un-accelerated.
	const keys = cacheKeysOf(url);
	if (!keys.includes(cacheKey)) keys.push(cacheKey);

	// Exact, and free: we own the key, so its lease is in THIS node's buffer.
	for (const key of keys) if (leaseInfo(key)) return refuse('leased', { leasedKey: key });

	const [target, ...rows] = await Promise.all([
		Target.get({ id: url, select: ['url', 'strikes', 'renderInterval', 'sitemapUrl', 'demandInterval'] }),
		// `replicateFrom: false` rides along inside the funnel's reader. Ownership makes this read
		// AUTHORITATIVE; only the option makes it LOCAL, and an unowned point read on this
		// residency-pinned table takes Harper's untimed replication fetch — inside a `setImmediate`,
		// holding an open read transaction on the one table whose scan degradation has already cost an
		// investigation.
		...keys.map((key) => getScheduleRow(key, ['cacheKey', 'nextRenderTime', 'fromSitemap'])),
	]);

	// A row with an unreadable due time is left alone rather than given one: the accelerator cannot
	// tell a broken row from a claimed one, and `util/backlogSnapshot.js` is what reports those.
	const present = keys
		.map((key, i) => ({ cacheKey: key, nextRenderTime: numberOf(rows[i]?.nextRenderTime) }))
		.filter((row) => Number.isFinite(row.nextRenderTime));
	if (!present.length) return refuse('no-schedule');
	if (!target) return refuse('no-target');

	const strikes = countedStrikes(target.strikes);
	if (strikes > config.render.failureRetry.fastRetries) return refuse('unhealable', { reason: 'strikes', strikes });

	// Resolved the same way `processJobResult` resolves it when it writes the row (route > stored >
	// default), and the same way `util/renderSchedule.js`'s unpin hatch resolves what it writes. A
	// route interval changed since that write makes this arithmetic imprecise by the difference —
	// bounded either way: refusing wrongly leaves the key to heal on cadence, accelerating wrongly
	// costs at most one render, and the rate limit caps both.
	const interval = resolveRenderInterval(url, target.renderInterval);
	// Seeded off the URL half, so every device key we write gets the SAME minute for free (I12) — a
	// lowering that moved one device would de-align the pair permanently, cycle over cycle, because
	// `processJobResult` reschedules from each render's own completion. No metric would show it:
	// route_serve and page_age are per-device and nobody reads them as a pair.
	const dueAt = getInitialRenderTime(cacheKey, spreadWindowMs());

	// PER ROW, BECAUSE THE WRITE IS PER ROW — see the module comment on why a whole-URL verdict here
	// let the crawler's User-Agent decide which invariant held.
	//
	//   completedAfterEpoch  the row's implied completion is after the epoch, so a render has already
	//                        run and left this key pre-epoch: nothing can heal it (I11).
	//   nextRenderTime > dueAt  the only rows a write can LOWER. Anything else would be raised (I10),
	//                        and a row already due sooner is already ahead of `dueAt` in claim order.
	const completedAfterEpoch = (row) => row.nextRenderTime - interval > invalidatedBy.at;
	const eligible = present.filter((row) => !completedAfterEpoch(row) && row.nextRenderTime > dueAt);
	if (!eligible.length) {
		// Reported for the key the REQUEST was about, so the counter describes the page this bot was
		// refused rather than whichever sibling happens to sort first. `present[0]` only when the served
		// device has no row of its own.
		const observed = present.find((row) => row.cacheKey === cacheKey) ?? present[0];
		return completedAfterEpoch(observed)
			? refuse('unhealable', { reason: 'rendered-after-epoch', lastCompleted: observed.nextRenderTime - interval })
			: refuse('not-sooner', { dueAt, earliest: Math.min(...present.map((row) => row.nextRenderTime)) });
	}

	if (!reserveSlot()) return refuse('throttled', { dueAt });

	try {
		// One batch, one floor lowering at the batch minimum — and because we own these keys, that
		// lowering is the OWNER's floor. `fromSitemap` comes from the live target rather than from the
		// schedule row we just read: `put` REPLACES the record, and the target is the field's source of
		// truth, so this self-corrects a row whose flag went stale (same choice as the reschedule path).
		await writeSchedules(
			eligible.map((row) => ({
				cacheKey: row.cacheKey,
				nextRenderTime: dueAt,
				fromSitemap: !!target.sitemapUrl,
				// The cadence, not the acceleration. `dueAt` is when the invalidation wants this rendered;
				// how often the page renders is unchanged by being accelerated, and it is what the sweep
				// ranks by. Same source as `interval` above, with the ladder rung applied.
				effectiveInterval: resolveEffectiveInterval(url, target),
			}))
		);
	} catch (e) {
		logger.error(e, `[prerender] could not accelerate ${cacheKey} after an invalidation`);
		return refuse('error');
	}

	record('lowered', scope);
	return {
		outcome: 'lowered',
		dueAt,
		written: eligible.map((row) => row.cacheKey),
		// The device rows this write deliberately left where they were. There is no metric dimension for
		// a partial fan-out — `lowered` is `lowered` — so a caller that wants to know whether the key the
		// request was about actually moved has to read this.
		skipped: present.filter((row) => !eligible.includes(row)).map((row) => row.cacheKey),
		// The floor obligation, discharged by the funnel as part of the write. True by construction
		// here, because guard 1 already refused every key this node does not own.
		watermarkLowered: true,
	};
};

/**
 * The serve path's whole involvement: one call, no await, nothing on the response's critical path.
 *
 * Detached in a `setImmediate` for the same reason `handlePageScheduling` is — the bot already has
 * its bytes, and this is a repair. Returns whether it scheduled the attempt, for tests.
 *
 * `invalidatedBy` is non-null ONLY when the epoch was consulted, which `bot_request.js` gates on
 * "this request would otherwise have been a cache serve". So the candidate set is exactly the
 * requests an invalidation cost us a serve on — not every stale key in the scope — which is what
 * bounds this mechanism to ~2,900 requests/day cluster-wide before a single guard runs.
 *
 * `routeClass` gates it exactly as it gates `maybeSchedule`, and for the same reason. A PASSTHROUGH
 * route still SERVES from cache — it only never populates one — and nothing retires a URL whose route
 * was flipped prerender → passthrough (the retirement sweep was cancelled), so its Target, schedule
 * rows and cached pages all survive the flip. Without this gate an `all` invalidation would turn
 * crawler volume into schedule writes on a route the operator has taken OUT of prerendering. It also
 * keeps the accelerator's candidate set identical to the scheduler's, which is what makes "the
 * accelerator only ever pulls an already-scheduled render forward" true.
 */
export const maybeAccelerateHeal = ({ url, cacheKey, invalidatedBy, routeClass }) => {
	if (!invalidatedBy) return false;
	if (routeClass !== PRERENDER) return false;
	if (!config.invalidation.enabled || !config.invalidation.reenqueue.enabled) return false;
	setImmediate(() => {
		// No unhandled rejection may escape a detached repair, and no refusal may be silent: every path
		// inside `accelerateHeal` counts itself, and a throw past it counts as `error` here.
		accelerateHeal({ url, cacheKey, invalidatedBy }).catch((e) => {
			record('error', invalidatedBy.scope);
			logger.error(e, `[prerender] invalidation accelerator failed for ${cacheKey}`);
		});
	});
	return true;
};

/** Tests only — the rate window is shared-buffer state that outlives a `beforeEach`. */
export const resetReenqueueRateWindow = () => {
	const i32 = rateWindowI32();
	Atomics.store(i32, R_MINUTE, 0);
	Atomics.store(i32, R_COUNT, 0);
};
