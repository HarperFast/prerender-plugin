/**
 * THE ONLY MODULE IN `src/` THAT TOUCHES THE `RenderSchedule` TABLE.
 *
 * ── WHAT A ROW IS ────────────────────────────────────────────────────────────────────────────
 *
 * ONE ROW PER URL (since v0.66.0). The row's key is the URL, a claim hands the renderer ONE job
 * carrying every device in `config.deviceTypes.default`, and the renderer posts ONE result with
 * every device's snapshot — so a URL's variants are rendered in the same pass, seconds apart, and
 * scheduled by one decision. Before this the table held one row per cacheKey (per device), and the
 * two rows drifted apart through every per-device path (render-now, revalidate, reconcile, the
 * retry lanes) until "a split pair" was a normal production state.
 *
 * Existing per-device rows are NOT migrated by a sweep. Each one converts the first time it renders:
 * its job renders exactly the device its key names, and its result writes the URL row and deletes
 * the device row (`RenderQueue.processJobResult`). Two sibling rows therefore fold into one URL row
 * within a cycle at no extra renders. Until then BOTH SHAPES COEXIST in this table, and every reader
 * of a key in this module goes through `CacheKey.urlOf` / `CacheKey.deviceOf`, never `extractUrl`.
 *
 * A device-keyed row remains the shape of a deliberate ONE-DEVICE render: `renderNow` for a device
 * outside `deviceTypes.default` files one, and its result stores that page and retires the row
 * without touching the URL row.
 *
 * The primary-key attribute is still NAMED `cacheKey` in the schema, and that is not carelessness:
 * Harper refuses to rename the primary key of a table that has records (databases.ts, "Cannot
 * change the primary key"), so the column name is fixed for the life of the table. Read it as
 * "the schedule key".
 *
 * ── THE TABLE IS THE QUEUE'S DURABLE SIDE ────────────────────────────────────────────────────
 *
 * The queue itself is the keeper (`util/queueKeeperService.js`): worker 0 holds every row this node
 * owns, kept current by a subscription, and publishes the best of the due set to the ready set each
 * second. A claim takes from that set and checks each entry against its row here before granting it.
 * So the table is read by primary key only — the keeper's load and verification walks, and point
 * reads — and `nextRenderTime` carries no index (before v0.93.0 it did, and the claim scan, the
 * ready-set sweep and the backlog snapshot all walked it; see #215 for what that cost).
 *
 * The keeper sees every commit to the table, from any writer on any node, so nothing here has to
 * announce a write. What the single-module rule still buys is the write CONTRACT: `put` replaces the
 * record, so every writer must supply `fromSitemap` and `effectiveInterval` explicitly, and every read
 * must be local (`replicateFrom: false`: the table is residency-pinned, and an unowned point read
 * takes Harper's replication fetch, which has no timeout). `test/queueFunnel.test.js` fails the build
 * if any other file in `src/` touches the table.
 */

import { config } from '../config.js';
import { CacheKey } from './cacheKey.js';
import { getSab } from './coordination.js';
import { resolveRenderInterval } from './routeClass.js';
import { MINUTE, numberOf } from './time.js';
import { LEASE_SAB_KEY, createLeaseTable, leaseBufferBytes, leaseSlotsIn } from './renderLease.js';
import { READY_EPOCH_SEC, READY_SAB_KEY, createReadyQueue, readyBufferBytes, readyCapacityIn } from './readyQueue.js';
import { walkUrlRange } from './urlWalk.js';

/**
 * The live lease table, over one named buffer shared by every worker on this node.
 *
 * ALLOCATED ON FIRST USE, NEVER AT MODULE SCOPE. `queue.maxLeases` sizes the buffer, and module
 * scope is too early to read it: `extension.js` imports this module chain (RenderQueue → Target →
 * Sitemap → …) BEFORE it calls `applyOptions(scope.options.getAll())`, which is the rule stated at
 * the top of `src/config.js` — read `config.*` lazily, at request/timer time. Sized at module scope
 * it read the DEFAULT, so an operator who set `queue.maxLeases: 16384` still got 4,096 slots after a
 * restart, and the size assert below could not fire either, because both sides of its comparison
 * came from that same stale number. First use is a claim or a lease operation, always after options
 * are applied.
 *
 * The buffer is STILL sized once per process — the size of a named `getUserSharedBuffer` is fixed by
 * the first allocation, so a later worker asking for a different size gets a view of the first size.
 * That is why `queue.maxLeases` stays restart-scoped, and why a mismatch is logged loudly and then
 * honoured: indexing past a short buffer would be silent memory corruption, whereas deriving the slot
 * count from the buffer we actually got is merely a smaller table.
 *
 * It lives HERE rather than in `renderLease.js` so that module stays free of Harper globals and its
 * tests can run against a plain ArrayBuffer.
 */
let liveLeaseTable = null;

export const leaseTable = () => {
	if (liveLeaseTable) return liveLeaseTable;

	const wantedSlots = Math.max(1, config.queue.maxLeases | 0);
	// `getSab` is synchronous — `getUserSharedBuffer` hands back the buffer itself, not a promise —
	// which is what lets this be a plain accessor.
	const buffer = getSab(LEASE_SAB_KEY, leaseBufferBytes(wantedSlots));

	if (buffer.byteLength !== leaseBufferBytes(wantedSlots)) {
		logger.error(
			`[prerender] render-lease buffer is ${buffer.byteLength} bytes but queue.maxLeases=${wantedSlots} wants ` +
				`${leaseBufferBytes(wantedSlots)}. The named shared buffer was sized by an earlier worker generation — ` +
				`this node runs with ${leaseSlotsIn(buffer.byteLength)} lease slots until it restarts. ` +
				`queue.maxLeases is restart-scoped for exactly this reason.`
		);
	}

	// `now` is passed as a wrapper rather than as the bare `Date.now` reference so the clock stays
	// LATE-BOUND: a test that swaps `Date.now` to walk past a lease expiry moves both clocks together.
	liveLeaseTable = createLeaseTable({ buffer, slots: wantedSlots, now: () => Date.now() });
	return liveLeaseTable;
};

// Resolved per call rather than destructured at module load. This module is imported by almost
// everything (Target → Sitemap → RenderQueue → the handlers), so a module-scope capture would make the
// import order of the whole package depend on when `databases` was populated.
const scheduleTable = () => databases.render_schedule.RenderSchedule;

/**
 * The node's ready set, over one named buffer shared by every worker.
 *
 * Allocated on first use for the same reason `leaseTable` is: `queue.ready.capacity` sizes it, and
 * module scope precedes the host applying its options. Restart-scoped for the same reason too, and a
 * mismatch is logged loudly and then honoured, since deriving the capacity from the buffer we actually
 * got is merely a smaller set.
 */
let liveReadyQueue = null;

export const readyQueue = () => {
	if (liveReadyQueue) return liveReadyQueue;
	const wanted = Math.max(1, config.queue.ready.capacity | 0);
	const buffer = getSab(READY_SAB_KEY, readyBufferBytes(wanted));
	if (readyCapacityIn(buffer.byteLength) < wanted) {
		logger.error(
			`[prerender] ready-set buffer holds ${readyCapacityIn(buffer.byteLength)} entries but ` +
				`queue.ready.capacity=${wanted}. The named shared buffer was sized by an earlier worker generation — ` +
				`this node runs with the smaller set until it restarts. queue.ready.capacity is restart-scoped for ` +
				`exactly that reason.`
		);
	}
	liveReadyQueue = createReadyQueue({ buffer, now: () => Date.now() });
	return liveReadyQueue;
};

/** Minutes since the epoch. Every due time in the system is already minute-floored. */
export const minuteOf = (ms) => Math.floor(ms / MINUTE);

/**
 * Write one schedule row.
 *
 * `fromSitemap` is REQUIRED, not optional: `put` REPLACES the record, so omitting it clears the
 * flag. `Target.revalidate` omitted it for as long as it has existed, which silently made every
 * revalidated key report `isFromSitemap: false` to the renderer — and the renderer skips
 * serializing a non-indexable sitemap-listed page. A required argument is how that stops being
 * possible.
 *
 * NOT wrapped in a deadline, ever. See the module comment in `resources/Target.js`: a write to a
 * residency-pinned key this node does not own does NOT block on the owner (measured: 500 writes
 * in 10.7 ms, mean 0.021 ms, against residency pinned to a node that does not exist). v0.15.0
 * assumed the read/write symmetry and wrapped these in a deadline that could never fire.
 */
export const writeSchedule = async (
	cacheKey,
	{ nextRenderTime, fromSitemap, effectiveInterval, targetMissingSince, changedAt } = {}
) => {
	if (fromSitemap === undefined) {
		throw new Error(`writeSchedule(${cacheKey}) needs an explicit fromSitemap — put replaces the record`);
	}
	// REQUIRED FOR THE SAME REASON, AND IT IS THE SAME HAZARD. `put` replaces the record, so a writer
	// that omits this does not leave the old value alone — it ERASES a correct cadence off a row that
	// had one, and the keeper then ranks that page against its route ceiling instead of its ladder
	// rung. `null` is the legitimate explicit answer for a writer with no cadence in hand (a render-now
	// one-off has no cadence at all); what must not be possible is forgetting.
	if (effectiveInterval === undefined) {
		throw new Error(`writeSchedule(${cacheKey}) needs an explicit effectiveInterval — put replaces the record`);
	}
	// `targetMissingSince` is written only by the deferral that sets it (see `settleTargetless`);
	// every other write omits it, and since `put` replaces the record, omitting it CLEARS it.
	// `changedAt` the same way: the change probe sets it, a failed render's retry carries it, and every
	// other write — the render's own reschedule above all — clears it by omission (schema.graphql).
	await scheduleTable().put(cacheKey, {
		nextRenderTime,
		fromSitemap,
		effectiveInterval,
		...(targetMissingSince === undefined ? {} : { targetMissingSince }),
		...(Number.isFinite(changedAt) ? { changedAt } : {}),
	});
};

/**
 * The batch form, for writers with several rows in hand (the invalidation accelerator, which may
 * lower a URL row and a not-yet-converted device row together). Sequential: rows are independent,
 * so a rejection propagates with the earlier rows applied, and puts here are idempotent.
 */
export const writeSchedules = async (rows = []) => {
	for (const { cacheKey, nextRenderTime, fromSitemap, effectiveInterval } of rows) {
		if (fromSitemap === undefined) {
			throw new Error(`writeSchedules(${cacheKey}) needs an explicit fromSitemap — put replaces the record`);
		}
		if (effectiveInterval === undefined) {
			throw new Error(`writeSchedules(${cacheKey}) needs an explicit effectiveInterval — put replaces the record`);
		}
		await scheduleTable().put(cacheKey, { nextRenderTime, fromSitemap, effectiveInterval });
	}
};

/**
 * Drop a schedule row. Releases nothing: every delete here removes a row claimed seconds ago whose
 * result may still be arriving, and the lease simply expires.
 */
export const deleteSchedule = async (cacheKey) => {
	await scheduleTable().delete(cacheKey);
};

/**
 * A node-local point read. `replicateFrom: false` is not optional on this table: it is
 * residency-pinned, so a point read of a key this node does not own takes Harper's replication
 * fetch, which has NO TIMEOUT and can hang the caller forever.
 */
export const getScheduleRow = (cacheKey, select) =>
	scheduleTable().get({ id: cacheKey, select }, { replicateFrom: false });

// ---- the claim ------------------------------------------------------------------------------

/**
 * Grant up to `grantLimit` jobs from the ready set the keeper publishes.
 *
 * Each entry is CHECKED AGAINST ITS DURABLE ROW before it is granted, the way an index entry is only
 * as good as the row it points at. The set is at most a publish interval old and the keeper sees
 * writes by subscription, a moment after they commit, so an entry can name a row that was just
 * rendered and rescheduled, or deleted. A local point read costs microseconds; granting the stale
 * entry would cost a render. It also hands the renderer the LIVE `fromSitemap`.
 *
 * A short claim is simply short: what the set could not grant is in flight or was stale, and the
 * keeper republishes within a second. While the keeper is not serving (before its first publish, or
 * after it withdrew) nothing is granted and `keeperServed` is false, which the caller reports as
 * `unready`. A keeper that is serving but has gone quiet is still served from: every entry is checked
 * against its row, so its last set stays safe to grant from until it drains.
 *
 * A RENDER THAT NEVER REPORTS IS BOUNDED HERE. A lease that expires with no result — a renderer crashing
 * on the URL, or a result that cannot get back to this node — leaves the row due, so the key would be
 * granted again at every expiry, forever. The lease table counts those misses; past the fast-retry
 * lane's own holds (`render.failureRetry.fastRetries`) plus one, the key is HELD BACK in the lease table
 * instead of granted — two leases, then four, eight, … capped at its cadence — and named (`pass.wedged`).
 * Nothing durable is written, no strike is counted, and the first result that comes back for the key
 * resets it: so a node-wide delivery outage delays rows by a few leases, not by a cadence, while a URL
 * that genuinely crashes the renderer is retried ever more rarely.
 *
 * No mutex: the ready-set cursor hands each entry to one taker, and the lease grant is exclusive
 * (`util/renderLease.js`), so claims on every worker run concurrently.
 */
export const claimSchedules = async ({ grantLimit } = {}) => {
	const wanted = Math.max(0, grantLimit | 0);
	const leases = leaseTable();
	const nowMs = Date.now();
	const keeper = readKeeperSignal(nowMs);
	const pass = {
		jobs: [],
		// the tri-state rule: granting nothing while due rows are in flight is still `queued`
		sawDue: keeper.serving && keeper.due > 0,
		keeperServed: keeper.serving,
		skippedLeased: 0,
		skippedStale: 0,
		leaseRefused: false,
		occupancy: 0,
		wedged: [],
		// the keeper has read the whole table, so finding nothing due means empty
		complete: keeper.complete,
	};
	if (!keeper.serving || wanted === 0) {
		pass.occupancy = leases.occupancy();
		return pass;
	}

	const queue = readyQueue();
	const leaseTimeMs = config.queue.jobLeaseTime;
	const missLimit = Math.max(0, config.render.failureRetry.fastRetries | 0) + 1;
	// Over-take, because an entry may name a row that is already leased — the set is published every
	// second, and a lease granted since is not reflected in it — so a run of them must not end the
	// attempt while the set still holds grantable work. Bounded, so an entirely-leased set costs a fixed
	// number of atomic loads rather than draining the whole thing.
	const attempts = Math.min(queue.capacity, wanted * 4);
	for (let taken = 0; pass.jobs.length < wanted && taken < attempts; ) {
		const batch = queue.take(Math.min(wanted - pass.jobs.length, attempts - taken));
		if (batch.length === 0) break;
		taken += batch.length;
		for (const entry of batch) {
			if (pass.jobs.length >= wanted) break;
			if (leases.isLeased(entry.cacheKey)) {
				pass.skippedLeased++;
				continue;
			}
			const row = await getScheduleRow(entry.cacheKey, ['nextRenderTime', 'fromSitemap', 'effectiveInterval']);
			const dueAt = numberOf(row?.nextRenderTime);
			if (!row || !Number.isFinite(dueAt) || dueAt > nowMs) {
				pass.skippedStale++;
				continue;
			}
			const misses = leases.missesBeforeGrant(entry.cacheKey);
			if (misses > missLimit) {
				const carried = Number(row.effectiveInterval);
				const cadence =
					Number.isFinite(carried) && carried > 0
						? carried
						: resolveRenderInterval(CacheKey.urlOf(entry.cacheKey), null);
				const backoff = Math.min(cadence, leaseTimeMs * 2 ** Math.min(20, misses - missLimit));
				if (leases.hold(entry.cacheKey, nowMs + backoff))
					pass.wedged.push({ cacheKey: entry.cacheKey, misses, backoff });
				continue;
			}
			const expiresAtMs = nowMs + leaseTimeMs;
			// Exclusive: false when another claim leased this key since the check above (the read yielded),
			// or when the table has no slot for it. No slot, no job — a granted-but-unrecorded job is a
			// double render.
			if (!leases.grant(entry.cacheKey, { dueMinute: minuteOf(dueAt), leaseExpiryMs: expiresAtMs })) {
				if (leases.isLeased(entry.cacheKey)) {
					pass.skippedLeased++;
					continue;
				}
				pass.leaseRefused = true;
				break;
			}
			pass.jobs.push({
				cacheKey: entry.cacheKey,
				dueMinute: minuteOf(dueAt),
				expiresAtMs,
				// Off the durable row, NOT left absent. The renderer serializes a non-indexable page only when
				// the url is sitemap-listed, so a job reporting `false` for a listed page silently stops it
				// being cached — the bug this package has shipped twice.
				fromSitemap: !!row.fromSitemap,
				score: entry.score,
			});
		}
		if (pass.leaseRefused) break;
	}
	pass.sawDue ||= pass.jobs.length > 0;
	pass.occupancy = leases.occupancy();
	return pass;
};

// ---- the queue keeper's table I/O (driven by util/queueKeeperService.js) ---------------------

/** The four fields every reader of this table projects. */
export const SCHEDULE_SELECT = ['cacheKey', 'nextRenderTime', 'fromSitemap', 'effectiveInterval', 'changedAt'];

/**
 * Every row this node stores, in primary-key order, for the keeper's load. A chunked keyset walk
 * (`walkUrlRange`) rather than one long cursor: a production node holds ~250k rows on a churned store
 * (expect tens of seconds), and a single open read transaction that long is reaped by Harper
 * (`util/scan.js`). Every read is local (`replicateFrom: false`), as on every read of this table.
 */
export async function* walkScheduleRows({ chunkSize = 1000, onUnreadable } = {}) {
	yield* walkUrlRange(scheduleTable(), {
		key: 'cacheKey',
		select: SCHEDULE_SELECT,
		chunkSize,
		onUnreadable,
		searchOptions: { replicateFrom: false },
	});
}

/**
 * The rows ABOVE `above`, in DESCENDING primary-key order: how the keeper reaches the rows past an
 * unreadable one that stopped the ascending walk (`walkUrlRange` throws there). A store that cannot
 * read forward past a row whose key did not decode can still read down to it from the top. One
 * condition per query, filtered in code, since two conditions on one key are not accepted everywhere
 * (see `util/urlWalk.js`).
 *
 * The generator's return value is `true` when it reached `above` — a query found nothing more, or a
 * row at or below it — and `false` when it stopped at a chunk with no readable key. Residual, as in
 * `walkUrlRange`: a store that ENDS a read early at an unreadable row, without yielding it, reads here
 * as the end of the range.
 */
export async function* walkScheduleRowsDescending({ above, chunkSize = 1000, onUnreadable } = {}) {
	let below = null;
	for (;;) {
		const conditions =
			below === null
				? [{ attribute: 'cacheKey', comparator: 'greater_than', value: above }]
				: [{ attribute: 'cacheKey', comparator: 'less_than', value: below }];
		let n = 0;
		let lowest = null;
		for await (const row of scheduleTable().search(
			{ conditions, sort: { attribute: 'cacheKey', descending: true }, select: SCHEDULE_SELECT, limit: chunkSize },
			{ replicateFrom: false }
		)) {
			n++;
			if (typeof row?.cacheKey !== 'string') {
				onUnreadable?.();
				continue;
			}
			if (row.cacheKey <= above) return true;
			lowest = row.cacheKey;
			yield row;
		}
		if (n === 0) return true;
		if (lowest === null) return false;
		below = lowest;
	}
}

/**
 * Subscribe to every write to this table, in listener form (the form that does not build an async
 * iterator per event). `omitCurrent`: the keeper loads the current rows itself, by the walk above.
 *
 * What a node's subscription receives on a residency-pinned table, measured by bench/queue-keeper
 * (#215, #217): a `put` with the value for every write to a row this node owns, local or replicated;
 * a `delete` with no value for each write THIS node makes to a row it does not own (nothing is stored
 * locally, so the delivery re-read finds nothing); nothing for rows it neither owns nor wrote. After a
 * replication base copy that carries any row of the table, the whole table is re-sent as puts.
 */
export const subscribeScheduleChanges = (listener) => scheduleTable().subscribe({ omitCurrent: true, listener });

/** Publish a ready-set generation the keeper built. Returns how many entries fit. */
export const publishKeeperSet = (rows, { due = 0 } = {}) => readyQueue().publish(rows, { scannedRows: due });

/**
 * THE KEEPER'S SIGNAL TO CLAIMS, in its own buffer.
 *
 *   live         the keeper is publishing the set claims are served from (while loading too)
 *   heartbeatAt  refreshed on every publish tick, published or skipped
 *   due          due rows the keeper holds (the tri-state status rule needs it)
 *   complete     the keeper holds the whole table (its load has finished), so `due: 0` means empty
 */
const KEEPER_SIGNAL_SAB_KEY = 'prerender/queue-keeper-signal';
const KS_LIVE = 0;
const KS_HEARTBEAT = 1; // seconds relative to READY_EPOCH_SEC
const KS_DUE = 2;
const KS_COMPLETE = 3;
const KS_INT32 = 8;
let liveKeeperSignal = null;
const keeperSignalView = () => (liveKeeperSignal ??= new Int32Array(getSab(KEEPER_SIGNAL_SAB_KEY, KS_INT32 * 4)));
const clampInt32 = (n) => Math.max(0, Math.min(2_147_483_647, n | 0));

export const setKeeperSignal = ({ due = 0, complete = true, nowMs = Date.now() } = {}) => {
	const view = keeperSignalView();
	Atomics.store(view, KS_DUE, clampInt32(due));
	Atomics.store(view, KS_COMPLETE, complete ? 1 : 0);
	Atomics.store(view, KS_HEARTBEAT, Math.round(nowMs / 1000) - READY_EPOCH_SEC);
	Atomics.store(view, KS_LIVE, 1);
};

/** Withdraw the keeper from the claim path: claims grant nothing until it is live again. */
export const clearKeeperSignal = () => Atomics.store(keeperSignalView(), KS_LIVE, 0);

/**
 * When a keeper's heartbeat counts as stale: ten publish intervals, never under 30 seconds. REPORTED,
 * NOT ENFORCED. A stale keeper's last set is still served, because every entry is checked against its
 * durable row before it is granted — so a stalled worker 0 degrades to "serve the last set until it
 * drains" (5,000 entries is many minutes of claims) instead of stopping every claim on the node. A
 * keeper that stops or restarts withdraws its set itself.
 */
const keeperFreshMs = () => Math.max(30_000, 10 * Math.max(0, Number(config.queue.keeper.publishInterval) || 0));

export const readKeeperSignal = (nowMs = Date.now()) => {
	const view = keeperSignalView();
	const sec = Atomics.load(view, KS_HEARTBEAT);
	const heartbeatAt = sec === 0 ? null : (sec + READY_EPOCH_SEC) * 1000;
	const ageMs = heartbeatAt === null ? null : Math.max(0, nowMs - heartbeatAt);
	const live = Atomics.load(view, KS_LIVE) === 1;
	const stale = live && (ageMs === null || ageMs > keeperFreshMs());
	return {
		live,
		// A stale keeper is served from until its last set drains; after that it is not serving at all
		// — its worker may be gone for good (a replacement that never started its keeper), and `queued`
		// forever would keep the fleet polling a node that can grant nothing.
		serving: live && (!stale || readyQueue().state().remaining > 0),
		stale,
		complete: Atomics.load(view, KS_COMPLETE) === 1,
		heartbeatAt,
		ageMs,
		due: Atomics.load(view, KS_DUE),
	};
};

// ---- lease lifecycle exposed to the result path ---------------------------------------------

export const releaseLease = (cacheKey) => leaseTable().release(cacheKey);

export const leaseInfo = (cacheKey) => leaseTable().leaseOf(cacheKey);

// ---- status derivation (zero DB ops) --------------------------------------------------------

/**
 * `empty`, `queued` or `unready`, from the keeper's signal. `unready` while the keeper is not serving
 * (see `QueueState`), and while it is still loading and has found nothing due yet: the count is not
 * known to be zero.
 *
 * The due count includes rows in flight (a row stays due until its result reschedules it), which is
 * the tri-state rule: "granted zero but there ARE due rows" must report `queued`, never `empty`.
 */
export const deriveQueueStatus = (nowMs = Date.now()) => {
	const keeper = readKeeperSignal(nowMs);
	if (!keeper.serving) return 'unready';
	if (keeper.due > 0) return 'queued';
	return keeper.complete ? 'empty' : 'unready';
};

/**
 * Walk the lease slots and reconcile the occupancy gauge to what is actually live. Called from
 * `syncQueueState` once per `queue.statusSyncInterval`, on worker 0.
 *
 * The gauge has no other way back down: `grant`/`release` are exact about every lease that ends in a
 * RESULT, but a lease that merely EXPIRES leaves its +1 behind forever. It feeds each claim's
 * `occupancy` and the lease-refused warning, so unreconciled it would report "8000 of 4096 slots
 * occupied". The buffer is shared, so ONE walk fixes it for every worker.
 */
export const reconcileLeaseGauge = () => leaseTable().scanLive();

/** Everything the console needs about the lease table. All O(1) except the slot walk. */
export const leaseState = () => {
	const live = leaseTable().scanLive();
	return {
		occupancy: live.count,
		oldestLeaseExpiresAt: live.oldestExpiresAtMs,
		oldestLeaseDueMinute: live.oldestDueMinute,
		maxLeases: leaseTable().slots,
	};
};

/**
 * In-flight lease count, for the backlog snapshot and `queue-state`: the slot walk, not the O(1)
 * gauge. The gauge still counts every lease that expired without a result until the next reconcile
 * (measured 410 against a true 290 after a burst of renders that never reported), which would
 * deflate `unclaimed` for exactly the consumer that sizes the fleet from it. The walk is a few
 * thousand atomic loads, and it reconciles the gauge as it goes.
 */
export const inFlightLeases = () => leaseTable().scanLive().count;

/**
 * Zero the lease buffer. TESTS ONLY (precedent: `resetCrawlStats`). The buffer outlives a
 * `beforeEach` that clears the fake tables, so without this the leases leak between tests in one
 * file and the second test in a file mysteriously claims nothing.
 */
export const resetRenderQueueState = () => {
	leaseTable().resetAll();
};
