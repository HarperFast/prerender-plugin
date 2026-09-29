/**
 * THE QUEUE KEEPER'S LIFECYCLE on worker 0: subscribe, load, serve, verify, resync, report.
 *
 * `util/queueKeeper.js` is the data structure. This module makes it this node's render queue: the
 * in-memory front, with `RenderSchedule` as its durable side. It is the INDEX here — the thing claims
 * are served from — so it carries the guarantees an index has to carry, against the table it indexes:
 *
 *   - BUILT FROM THE TABLE, AND SERVING WHILE IT IS BUILT. Subscribe first, then walk the table by
 *     primary key (chunked, local), publishing the ready set from what is held so far from the first
 *     chunk on. Events apply as they arrive; a walked row is applied only if no event has touched its
 *     key since the walk began, since each event carries the row's value at delivery and is at least
 *     as new as anything the walk read. Serving a partial queue is safe because every grant is checked
 *     against its durable row; only the ORDER is incomplete until the walk ends.
 *   - A ROW THE WALK CANNOT READ DOES NOT STOP THE QUEUE. When `walkUrlRange` cannot get past a key that
 *     did not decode, the rest of the table is walked from the top down to it. Only if that stops short
 *     too is the load partial (`exact: false`, logged): a partial queue, never none, since there is no
 *     other path to the queue.
 *   - KEPT CURRENT BY EVERY WRITE. The subscription delivers every commit to the table, from any
 *     thread and any node (#215: exact on one node and on two). Only `put`, `delete` and `invalidate`
 *     change a row; a replay after a subscription gap, or the whole-table re-send after a base copy,
 *     re-applies current values and changes nothing.
 *   - CHECKED AGAINST THE TABLE WHEN USED. A claim point-reads each ready-set entry's durable row
 *     before granting it (`claimSchedules`), so an entry the keeper has not yet seen rescheduled or
 *     deleted is skipped, never rendered. Each publish also point-reads the head of what it published
 *     (each key at most once a minute) and repairs any it holds wrongly.
 *   - VERIFIED AGAINST THE TABLE, periodically (`queue.keeper.verifyInterval`): a full primary-key walk
 *     repairs anything missing, held at the wrong minute or class, or held after it was deleted. That
 *     bounds a missed write to one interval and counts it (`queue_health` `keeper_repaired`).
 *   - NEVER RELOADED ONCE LIVE, so nothing here stops claims. A change of routes or default interval
 *     reclassifies every held row in memory; a change of cluster membership reclassifies (dropping rows
 *     this node no longer owns) and then runs the verification walk (adding the rows it now does); a
 *     closed subscription is reopened and followed by the walk. The set is served throughout.
 *
 * A repair never trusts a read over a newer event: the walks skip keys an event touched while they ran,
 * and a point-read repair applies only if the keeper's entry did not change during the read.
 *
 * OWNERSHIP. The keeper holds only rows this node owns by residency: a node can store stale rows from an
 * earlier ownership ("residency ghosts"). Ownership depends on the cluster's node list, empty at every
 * worker start until the first `hdb_nodes` scan (`util/residency.js`), so a node with configured peers
 * waits to see one (up to a grace period) before loading. A node with none — `system.hdb_nodes` names no
 * other node, or does not exist — loads at once.
 *
 * UNTIL ITS FIRST PUBLISH, and after it withdraws, this node grants no claims and reports `unready`; the
 * keeper reports each change of status itself (`QueueState`), so the fleet is told at once.
 */
import { setImmediate as yieldNow, setTimeout as sleep } from 'node:timers/promises';
import { config, onConfigApplied } from '../config.js';
import { metrics } from '../metrics.js';
import { CacheKey } from './cacheKey.js';
import { getSab } from './coordination.js';
import { changedOf, demandPeriodOf, createQueueKeeper } from './queueKeeper.js';
import {
	clearKeeperSignal,
	getScheduleRow,
	leaseTable,
	minuteOf,
	publishKeeperSet,
	readyQueue,
	setKeeperSignal,
	subscribeScheduleChanges,
	walkScheduleRows,
	walkScheduleRowsDescending,
} from './renderSchedule.js';
import { getNodes, getResidencyByUrl } from './residency.js';
import { WALK_CANNOT_ADVANCE } from './urlWalk.js';
import { resolveRenderInterval, routeScopeForUrl } from './routeClass.js';
import { createSharedSnapshot, snapshotBufferBytes } from './sharedSnapshot.js';

/** Version of the queue-state document; bump on an incompatible change so readers can tell. */
export const QUEUE_STATE_SCHEMA = 1;

const STATE_SAB_KEY = 'prerender/queue-state-v1';
const STATE_SLOT_BYTES = 256 * 1024;
/** Lists in the state document are capped so a corpus with very many routes or cadences still fits. */
const MAX_LISTED = 200;
/** Rows between event-loop yields during a walk or a reclassification. */
const WALK_YIELD_EVERY = 200;
/** Published entries point-read after each publish: the head, which claims take first. */
const TOP_CHECK_ROWS = 64;
/** A key the head check read is not read again for this long. */
const TOP_CHECK_TTL_MS = 60_000;
/** A publish is forced at least this often, so an expired lease is noticed even with nothing else moving. */
const FORCE_PUBLISH_MS = 10_000;
const SCHEDULE_FIELDS = ['cacheKey', 'nextRenderTime', 'fromSitemap', 'effectiveInterval', 'changedAt', 'demandPeriod'];
const MAX_TIMER_MS = 2_147_483_647;

let snapshot = null;
const stateSnapshot = () =>
	(snapshot ??= createSharedSnapshot({ buffer: getSab(STATE_SAB_KEY, snapshotBufferBytes(STATE_SLOT_BYTES)) }));

/** The last queue-state document worker 0 published, from any worker; null before the first. */
export const readQueueStateDocument = () => stateSnapshot().read();

const messageOf = (e) => e?.message ?? String(e);

/**
 * Report a queue status now rather than at the next status sync. Unforced, so a pause stands. Loaded
 * lazily: `resources/QueueState.js` needs Harper's `Resource` at import.
 */
let queueStateModule = null;
const reportQueueStatus = async (status) => {
	try {
		queueStateModule ??= await import('../resources/QueueState.js');
		await queueStateModule.QueueState.reportStatus(status);
	} catch (e) {
		globalThis.logger?.warn?.(`[prerender] queue keeper could not report ${status}: ${messageOf(e)}`);
	}
};

/**
 * How many OTHER nodes this node is configured to replicate with: `system.hdb_nodes` has one row per
 * node, this one included. 0 when that table does not exist (a Harper without replication). Throws when
 * it cannot be read, and the caller then waits for peers as if there were some.
 */
export const countConfiguredPeers = async () => {
	const table = globalThis.databases?.system?.hdb_nodes;
	if (!table?.search) return 0;
	let peers = 0;
	for await (const row of table.search({ conditions: [], select: ['name'] })) {
		if (typeof row?.name === 'string' && row.name !== server.hostname) peers++;
	}
	return peers;
};

const carriedCadence = (effectiveInterval) => {
	const ms = Number(effectiveInterval);
	return Number.isFinite(ms) && ms > 0 ? ms : null;
};

/**
 * The host's classifier: null for a row this node does not own, else its route and cadence: the
 * row's carried `effectiveInterval` (`carried`), else route over default.
 */
export const classifyScheduleRow = (key, value) => {
	const url = CacheKey.urlOf(key);
	if (getResidencyByUrl(url) !== server.hostname) return null;
	const carried = carriedCadence(value?.effectiveInterval);
	return {
		route: routeScopeForUrl(url) ?? 'unrouted',
		cadenceMs: carried ?? resolveRenderInterval(url, null),
		carried: carried !== null,
	};
};

const capList = (list) => (list.length > MAX_LISTED ? list.slice(0, MAX_LISTED) : list);

/** Does what the keeper holds for this key match the durable row? */
const matches = (held, row, described) =>
	held !== null &&
	described !== null &&
	held.minute === minuteOf(Number(row.nextRenderTime)) &&
	held.fromSitemap === !!row.fromSitemap &&
	held.changed === changedOf(row) &&
	held.demandPeriodMs === demandPeriodOf(row) &&
	held.cadenceMs === described.cadenceMs &&
	held.carried === described.carried &&
	held.route === described.route;

/**
 * One keeper instance and its timers. Separate from the module-level start function so tests can
 * drive a service against a fake table without worker 0 or config timers.
 */
export const createKeeperService = ({
	now = () => Date.now(),
	log = globalThis.logger,
	peerGraceMs = 120_000,
	retryMs = 30_000,
	maxRetryMs = 10 * 60_000,
	countPeers = countConfiguredPeers,
} = {}) => {
	const createdAt = now();
	let keeper = null;
	let subscription = null;
	/** stopped | waiting-for-peers | loading | live | failed. `loading` and `live` serve claims. */
	let phase = 'stopped';
	let epoch = 0;
	/** While a walk runs: keys an event touched since it began, whose walked value may be older. */
	let touched = null;
	/** The load has finished, so a due count of 0 means empty rather than "not found yet". */
	let complete = false;
	let publishing = false;
	let verifying = false;
	let resyncing = false;
	let pendingResync = null;
	/** No resync is started before this (ms): the backoff after one failed. */
	let resyncRetryAt = 0;
	/** A walk was asked for (by a resync) and has not run to completion yet. */
	let walkWanted = false;
	let lastDue = 0;
	let lastReported = null;
	let lastPublishKey = null;
	let failures = 0;
	let nodesKey = null;
	const checkedAt = new Map();
	const timers = { publish: null, state: null, verify: null, retry: null, walkRetry: null };
	const stats = {
		loadStartedAt: null,
		loadedAt: null,
		loadMs: null,
		loadRows: 0,
		unreadableRows: 0,
		/** Why the last load could not cover the whole table, or null when it did. */
		partialLoad: null,
		eventsApplied: 0,
		lastEventAt: null,
		lastPublish: null,
		topCheck: null,
		verify: null,
		lastResync: null,
		repairedTotal: 0,
		lastError: null,
	};

	const serving = () => keeper !== null && (phase === 'loading' || phase === 'live');

	const applyEvent = (event) => {
		const type = event?.type;
		// A `put` carries the row's current value (Harper re-reads it before delivery); `delete` and
		// `invalidate` mean there is no current row here. Anything else — a `message` published to the
		// table, a transaction marker — says nothing about the row and must not remove it.
		let value;
		if (type === 'put') value = event.value ?? null;
		else if (type === 'delete' || type === 'invalidate') value = null;
		else return;
		touched?.add(event.id);
		keeper.apply(event.id, value);
		stats.eventsApplied++;
		stats.lastEventAt = now();
	};

	const onEvent = (event) => {
		if (!keeper || event?.id === undefined || event?.id === null) return;
		try {
			applyEvent(event);
		} catch (e) {
			// A row the keeper may now be wrong about: the verification walk puts it right, from the table.
			log?.error?.(`[prerender] queue keeper could not apply a ${event?.type} for ${event?.id}: ${messageOf(e)}`);
			resync('an event could not be applied', { walk: true });
		}
	};

	/**
	 * Repair one key from its durable row, unless the keeper's entry moved while it was being read (an
	 * event is newer than the read). Returns true if what the keeper held was wrong.
	 */
	const repairFromTable = async (key) => {
		const before = keeper.describe(key);
		const row = await getScheduleRow(key, SCHEDULE_FIELDS);
		if (!keeper) return false;
		const after = keeper.describe(key);
		if (JSON.stringify(before) !== JSON.stringify(after)) return false; // an event won
		const described = row ? classifyScheduleRow(key, row) : null;
		const due = row ? Number(row.nextRenderTime) : NaN;
		const shouldHold = described !== null && Number.isFinite(due) && due >= 0;
		if (!shouldHold) {
			if (after === null) return false;
			keeper.apply(key, null);
			return true;
		}
		if (matches(after, row, described)) return false;
		keeper.apply(key, row);
		return true;
	};

	/**
	 * Walk the whole table, ascending, then — if an unreadable key stops that — descending from the top
	 * down to where it stopped. `onRow` is called for every readable row. Resolves null when superseded,
	 * else `{ rows, unreadable, partial }`, `partial` naming why part of the table could not be read.
	 */
	const walkAll = async (mine, onRow) => {
		let rows = 0;
		let unreadable = 0;
		let lastKey = '';
		let partial = null;
		const counted = () => unreadable++;
		try {
			for await (const row of walkScheduleRows({ onUnreadable: counted })) {
				if (mine !== epoch) return null;
				lastKey = row.cacheKey;
				onRow(row);
				if (++rows % WALK_YIELD_EVERY === 0) await yieldNow();
			}
		} catch (e) {
			if (e?.code !== WALK_CANNOT_ADVANCE) throw e;
			unreadable++;
			const tail = walkScheduleRowsDescending({ above: lastKey, onUnreadable: counted });
			let step;
			while (!(step = await tail.next()).done) {
				if (mine !== epoch) return null;
				onRow(step.value);
				if (++rows % WALK_YIELD_EVERY === 0) await yieldNow();
			}
			if (step.value !== true) partial = messageOf(e);
		}
		return { rows, unreadable, partial };
	};

	const endSubscription = (sub = subscription) => {
		if (sub === subscription) subscription = null;
		try {
			(sub?.end ?? sub?.return)?.call(sub);
		} catch (e) {
			log?.warn?.(`[prerender] queue keeper could not end its subscription: ${messageOf(e)}`);
		}
	};

	const clearTimers = () => {
		for (const name of Object.keys(timers)) {
			if (timers[name]) clearTimeout(timers[name]);
			timers[name] = null;
		}
	};

	const every = (fn, ms) => {
		const timer = setInterval(fn, Math.min(MAX_TIMER_MS, Math.max(1, ms)));
		timer.unref?.();
		return timer;
	};

	/** Report the status the keeper now implies, when it differs from the last one reported. */
	const announce = () => {
		const status = !serving() ? 'unready' : lastDue > 0 ? 'queued' : complete ? 'empty' : 'unready';
		if (status === lastReported) return;
		lastReported = status;
		reportQueueStatus(status);
	};

	/** Stop serving the keeper's generation: claims grant nothing until it publishes again. */
	const withdraw = () => {
		clearKeeperSignal();
		lastReported = 'unready';
		reportQueueStatus('unready');
		try {
			publishKeeperSet([]);
		} catch (e) {
			log?.warn?.(`[prerender] queue keeper could not withdraw the ready set: ${messageOf(e)}`);
		}
	};

	const scheduleRetry = (mine) => {
		failures++;
		const delay = Math.min(maxRetryMs, retryMs * 2 ** (failures - 1));
		timers.retry = setTimeout(() => {
			timers.retry = null;
			if (mine === epoch) start();
		}, delay);
		timers.retry.unref?.();
		return delay;
	};

	/** Resolves false when superseded. */
	const waitForPeers = async (mine) => {
		if (getNodes().length >= 2) return true;
		let peers = null;
		try {
			peers = await countPeers();
		} catch (e) {
			log?.warn?.(`[prerender] queue keeper could not read the configured peers (${messageOf(e)}); waiting for them`);
		}
		if (mine !== epoch) return false;
		if (peers === 0) return true;
		phase = 'waiting-for-peers';
		writeState();
		while (getNodes().length < 2 && now() - createdAt < peerGraceMs) {
			await sleep(1_000, undefined, { ref: false });
			if (mine !== epoch) return false;
		}
		return true;
	};

	/** Load from the table, serving from the first chunk. Resolves when live, or when stopped meanwhile. */
	const start = async () => {
		const mine = ++epoch;
		clearTimers();
		endSubscription();
		// A generation left by an earlier worker 0 (a restart, a crash) must not keep being served.
		withdraw();
		keeper = null;
		touched = null;
		complete = false;
		stats.lastError = null;

		if (!(await waitForPeers(mine))) return;

		phase = 'loading';
		nodesKey = getNodes().join(',');
		keeper = createQueueKeeper({ classify: classifyScheduleRow, now });
		const loadTouched = new Set();
		touched = loadTouched;
		stats.loadStartedAt = now();
		stats.unreadableRows = 0;
		stats.partialLoad = null;
		writeState();
		const started = performance.now();
		try {
			const sub = await subscribeScheduleChanges(onEvent);
			if (mine !== epoch) {
				endSubscription(sub);
				return;
			}
			subscription = sub;
			// Serve while loading (see the module comment).
			timers.publish = every(publish, config.queue.keeper.publishInterval);
			timers.state = every(writeState, config.queue.keeper.stateInterval);
			const walked = await walkAll(mine, (row) => {
				if (!loadTouched.has(row.cacheKey)) keeper.apply(row.cacheKey, row, { quiet: true });
			});
			if (walked === null) return;
			if (touched === loadTouched) touched = null;
			stats.loadRows = walked.rows;
			stats.unreadableRows = walked.unreadable;
			stats.partialLoad = walked.partial;
			stats.loadMs = Math.round(performance.now() - started);
			stats.loadedAt = now();
			failures = 0;
			complete = true;
			phase = 'live';
			lastPublishKey = null;
			metrics.queueHealth(stats.loadMs, 'keeper_load_ms');
			if (walked.partial) {
				log?.error?.(
					`[prerender] queue keeper could not read part of the schedule table past an unreadable row ` +
						`(${walked.partial}); serving without those rows, which are held as soon as anything writes them. ` +
						'Repair or delete the unreadable row.'
				);
			}
			log?.info?.(
				`[prerender] queue keeper live: ${keeper.size} of ${walked.rows} stored schedule rows are this node's, ` +
					`loaded in ${stats.loadMs}ms while serving` +
					`${walked.unreadable ? `, ${walked.unreadable} unreadable row(s) skipped` : ''}.`
			);
			await publish();
			if (mine !== epoch) return;
			writeState();
			if (config.queue.keeper.verifyInterval > 0) timers.verify = every(verify, config.queue.keeper.verifyInterval);
			// What was asked for while loading (a config change, an event that could not be applied), and a
			// node list that moved under the load.
			const deferred = pendingResync;
			pendingResync = null;
			if (getNodes().join(',') !== nodesKey) {
				resync(`the node list changed during the load${deferred ? `; ${deferred.why}` : ''}`, {
					walk: true,
					resubscribe: !!deferred?.resubscribe,
				});
			} else if (deferred) {
				resync(deferred.why, deferred);
			}
		} catch (e) {
			if (mine !== epoch) return;
			phase = 'failed';
			stats.lastError = messageOf(e);
			touched = null;
			pendingResync = null;
			clearTimers();
			endSubscription();
			withdraw();
			writeState();
			const delay = scheduleRetry(mine);
			log?.error?.(
				`[prerender] queue keeper load failed (${stats.lastError}); this node grants no claims until it ` +
					`loads. Retrying in ${Math.round(delay / 1000)}s.`
			);
		}
	};

	const stop = () => {
		epoch++;
		clearTimers();
		endSubscription();
		withdraw();
		keeper = null;
		touched = null;
		complete = false;
		failures = 0;
		pendingResync = null;
		walkWanted = false;
		phase = 'stopped';
		writeState();
	};

	/**
	 * Re-apply every held row under the current config and ownership, in memory: a row whose route or
	 * config-resolved cadence changed moves class, and a row this node no longer owns is dropped.
	 */
	const reclassify = async (mine) => {
		let moved = 0;
		let dropped = 0;
		const keys = keeper.keys();
		for (let i = 0; i < keys.length; i++) {
			if (mine !== epoch || !keeper) return null;
			const key = keys[i];
			const before = keeper.describe(key);
			if (before) {
				keeper.apply(key, keeper.heldValue(key), { quiet: true });
				const after = keeper.describe(key);
				if (!after) dropped++;
				else if (after.route !== before.route || after.cadenceMs !== before.cadenceMs) moved++;
			}
			if ((i + 1) % WALK_YIELD_EVERY === 0) await yieldNow();
		}
		return { moved, dropped };
	};

	/**
	 * Bring the keeper in line with a changed world while it goes on serving: reopen the subscription
	 * (`resubscribe`), reclassify in memory, then run the verification walk (`walk`) for what only the
	 * table can tell. Coalesced: a request while one runs is merged into the next.
	 */
	const resync = (why, { resubscribe = false, walk = false } = {}) => {
		if (phase !== 'live' && phase !== 'loading') return Promise.resolve();
		// While loading (or while one runs), merged into the next: the load runs it when it goes live.
		if (resyncing || phase === 'loading') {
			pendingResync = {
				why: pendingResync ? `${pendingResync.why}; ${why}` : why,
				resubscribe: resubscribe || !!pendingResync?.resubscribe,
				walk: walk || !!pendingResync?.walk,
			};
			return Promise.resolve();
		}
		resyncing = true;
		const mine = epoch;
		return (async () => {
			const started = performance.now();
			try {
				log?.info?.(`[prerender] queue keeper resyncing while serving: ${why}.`);
				if (resubscribe) {
					endSubscription();
					const sub = await subscribeScheduleChanges(onEvent);
					if (mine !== epoch) return endSubscription(sub);
					subscription = sub;
				}
				// Recorded only once the keeper holds rows by it, so a failed resync is noticed again.
				const nodes = getNodes().join(',');
				const reclassified = await reclassify(mine);
				if (reclassified === null) return;
				nodesKey = nodes;
				if (walk) walkWanted = true;
				const verified = walk ? await verify() : null;
				stats.lastResync = {
					at: now(),
					why,
					ms: Math.round(performance.now() - started),
					...reclassified,
					repaired: verified?.repaired ?? null,
				};
				lastPublishKey = null;
			} catch (e) {
				stats.lastError = messageOf(e);
				resyncRetryAt = now() + retryMs;
				log?.error?.(
					`[prerender] queue keeper resync failed (${why}): ${stats.lastError}; serving meanwhile, retrying in ` +
						`${Math.round(retryMs / 1000)}s.`
				);
			} finally {
				resyncing = false;
				const next = pendingResync;
				pendingResync = null;
				if (next && mine === epoch) resync(next.why, next);
			}
		})();
	};

	const publish = async () => {
		if (!serving()) return;
		// The heartbeat does not wait on a publish still in flight (its head check awaits point reads).
		if (publishing) {
			setKeeperSignal({ due: lastDue, complete, nowMs: now() });
			return;
		}
		publishing = true;
		const mine = epoch;
		const started = performance.now();
		try {
			if (phase === 'live' && !resyncing && now() >= resyncRetryAt) {
				// No subscription at all is a resubscribe that failed: try again, as for a closed one.
				if (!subscription || subscription.closed) {
					resync('its subscription is not open', { resubscribe: true, walk: true });
				} else {
					const nodes = getNodes().join(',');
					if (nodes !== nodesKey) {
						resync(`the cluster's node list changed (${nodesKey || 'none'} -> ${nodes})`, { walk: true });
					}
				}
			}
			const nowMs = now();
			keeper.tick(nowMs);
			const summary = keeper.dueSummary(nowMs);
			lastDue = summary.due;
			setKeeperSignal({ due: summary.due, complete, nowMs });
			announce();

			const leases = leaseTable();
			const ready = readyQueue().state();
			// Nothing held changed, no lease moved, no claim took from the set, and within the same
			// minute and force window: the published generation is still exactly right.
			const keyOf = (r) =>
				`${keeper.version}|${minuteOf(nowMs)}|${Math.floor(nowMs / FORCE_PUBLISH_MS)}|${leases.occupancy()}|${r.consumed}|${r.generation}`;
			if (keyOf(ready) === lastPublishKey) return;
			const top = keeper.topK(ready.capacity, {
				nowMs,
				sitemapBoost: config.queue.ready.sitemapBoost,
				changedHeadStart: config.queue.ready.changedHeadStart,
				changedDemand: config.queue.ready.changedDemand,
				skip: (key) => leases.isLeased(key),
			});
			const published = publishKeeperSet(top.rows, { due: summary.due });
			lastPublishKey = keyOf(readyQueue().state());
			const ms = performance.now() - started;
			stats.lastPublish = {
				at: nowMs,
				ms: Math.round(ms * 10) / 10,
				published,
				complete: top.complete && published === top.rows.length,
				skippedLeased: top.skipped,
				due: summary.due,
			};
			metrics.queueHealth(ms, 'keeper_publish_ms');
			if (phase !== 'live') return;
			// Check the head of what was just published against the table, and repair what it holds
			// wrongly, so an entry a claim would find stale is fixed at the source rather than skipped on
			// every claim until its event arrives. Each key at most once per TOP_CHECK_TTL_MS: a head that
			// has not moved has nothing new to find.
			for (const [key, at] of checkedAt) if (nowMs - at > TOP_CHECK_TTL_MS) checkedAt.delete(key);
			let checked = 0;
			let repaired = 0;
			for (const { entry } of top.rows.slice(0, TOP_CHECK_ROWS)) {
				if (checkedAt.has(entry.cacheKey)) continue;
				if (mine !== epoch || !keeper) return;
				checkedAt.set(entry.cacheKey, nowMs);
				checked++;
				if (await repairFromTable(entry.cacheKey)) repaired++;
			}
			if (checked) stats.topCheck = { at: nowMs, checked, repaired };
			if (repaired) lastPublishKey = null;
		} catch (e) {
			stats.lastError = messageOf(e);
			log?.error?.(`[prerender] queue keeper publish failed: ${stats.lastError}`);
		} finally {
			publishing = false;
		}
	};

	/**
	 * The verification walk: every row of the table against the keeper, and every key the keeper holds
	 * against the table. What it repairs is a write the keeper missed — or, after a membership change,
	 * a row this node has just come to own.
	 */
	const verify = async () => {
		// One at a time; a walk asked for meanwhile (`walkWanted`) runs when this one ends.
		if (phase !== 'live' || verifying) return null;
		verifying = true;
		const wanted = walkWanted;
		walkWanted = false;
		const mine = epoch;
		const started = performance.now();
		const result = { at: now(), scanned: 0, owned: 0, unowned: 0, missing: 0, mismatched: 0, phantoms: 0 };
		const verifyTouched = new Set();
		touched = verifyTouched;
		let ok = false;
		try {
			const seen = new Set();
			const walked = await walkAll(mine, (row) => {
				result.scanned++;
				const key = row.cacheKey;
				const described = classifyScheduleRow(key, row);
				if (described) {
					result.owned++;
					seen.add(key);
				} else {
					result.unowned++;
				}
				// An event since the walk began is newer than this read; the walk's own value is not
				// needed. Otherwise the walked row IS the table's value, newer than anything held.
				if (verifyTouched.has(key)) return;
				const held = keeper.describe(key);
				if (!described) {
					if (held !== null) {
						keeper.apply(key, null);
						result.mismatched++;
					}
					return;
				}
				if (matches(held, row, described)) return;
				if (held === null) result.missing++;
				else result.mismatched++;
				keeper.apply(key, row);
			});
			if (walked === null) return null;
			// Keys held that the walk did not see: deleted, unless an event touched them meanwhile. Only
			// when the walk covered the whole table — a part it could not read proves nothing.
			if (!walked.partial) {
				for (const key of keeper.keys()) {
					if (seen.has(key) || verifyTouched.has(key)) continue;
					if (mine !== epoch || !keeper) return null;
					if (await repairFromTable(key)) result.phantoms++;
				}
			}
			result.unreadableRows = walked.unreadable;
			result.partial = walked.partial;
			result.repaired = result.missing + result.mismatched + result.phantoms;
			result.ms = Math.round(performance.now() - started);
			stats.verify = result;
			stats.repairedTotal += result.repaired;
			if (!walked.partial && stats.partialLoad) stats.partialLoad = null; // the whole table is now held
			metrics.queueHealth(result.ms, 'keeper_verify_ms');
			if (result.repaired) {
				metrics.queueHealth(result.repaired, 'keeper_repaired');
				log?.warn?.(
					`[prerender] queue keeper verification repaired ${result.repaired} row(s) it held differently from ` +
						`the table (${result.missing} missing, ${result.mismatched} mismatched, ${result.phantoms} deleted).`
				);
			}
			lastPublishKey = null;
			ok = true;
			return result;
		} catch (e) {
			stats.lastError = messageOf(e);
			log?.error?.(`[prerender] queue keeper verification failed: ${stats.lastError}`);
			return null;
		} finally {
			if (touched === verifyTouched) touched = null;
			verifying = false;
			if (mine === epoch) {
				if (!ok && wanted && !timers.walkRetry) {
					// A walk a resync depends on (rows gained, writes missed) must not wait out the interval.
					timers.walkRetry = setTimeout(() => {
						timers.walkRetry = null;
						walkWanted = true;
						verify();
					}, retryMs);
					timers.walkRetry.unref?.();
				} else if (walkWanted) {
					setImmediate(verify);
				}
			}
		}
	};

	/** The queue-state document, as published to the shared buffer. */
	const document = () => {
		const nowMs = now();
		let queue = null;
		if (phase === 'live' && keeper) {
			queue = keeper.state(nowMs);
			queue.listsTruncated = queue.byRoute.length > MAX_LISTED || queue.classes.length > MAX_LISTED;
			queue.byRoute = capList(queue.byRoute);
			queue.classes = capList(queue.classes);
		}
		return {
			schema: QUEUE_STATE_SCHEMA,
			node: server.hostname,
			generatedAt: nowMs,
			keeper: {
				phase,
				rows: keeper?.size ?? 0,
				classes: keeper?.classCount ?? 0,
				resyncing,
				// the whole table is held, and the last verification found nothing to repair
				exact: phase === 'live' && !resyncing && !stats.partialLoad && !(stats.verify?.repaired > 0),
				...stats,
			},
			queue,
		};
	};

	function writeState() {
		try {
			const result = stateSnapshot().write(document());
			if (!result.ok) log?.warn?.(`[prerender] queue state (${result.bytes} bytes) does not fit its shared buffer`);
		} catch (e) {
			log?.error?.(`[prerender] queue keeper could not publish queue state: ${messageOf(e)}`);
		}
	}

	return {
		start,
		stop,
		resync,
		publish,
		verify,
		writeState,
		/** Re-arm the timers after an interval change; the verification timer only once live. */
		rearm() {
			if (!serving()) return;
			for (const name of ['publish', 'state', 'verify']) if (timers[name]) clearInterval(timers[name]);
			timers.publish = every(publish, config.queue.keeper.publishInterval);
			timers.state = every(writeState, config.queue.keeper.stateInterval);
			timers.verify =
				phase === 'live' && config.queue.keeper.verifyInterval > 0
					? every(verify, config.queue.keeper.verifyInterval)
					: null;
		},
		get phase() {
			return phase;
		},
		get keeper() {
			return keeper;
		},
		get stats() {
			return stats;
		},
		get subscriptionOpen() {
			return subscription !== null;
		},
	};
};

let service = null;

/** The running service on worker 0, or null (tests read it). */
export const keeperService = () => service;

/**
 * Start the keeper on worker 0 and follow live config: an interval change re-arms its timers, and a
 * change to the routes or the default interval reclassifies every held row in memory (a row's route and
 * resolved cadence are its class). Idempotent.
 */
export function startQueueKeeper() {
	if (server.workerIndex !== 0 || service) return;
	service = createKeeperService();
	service.start();

	// What a row's class is derived from: its route (ingress routes, exclusions, mode) and, for a row
	// that carries no cadence, the default interval.
	const classKey = () =>
		JSON.stringify([
			config.ingress.routes,
			config.ingress.excludePathPatterns,
			config.ingress.mode,
			config.render.defaultInterval,
		]);
	let armed = { ...config.queue.keeper };
	let routesKey = classKey();
	onConfigApplied(() => {
		const next = config.queue.keeper;
		const nextRoutesKey = classKey();
		if (nextRoutesKey !== routesKey) {
			service.resync('the routes or the default render interval changed, so rows may have changed class');
		}
		if (
			next.publishInterval !== armed.publishInterval ||
			next.stateInterval !== armed.stateInterval ||
			next.verifyInterval !== armed.verifyInterval
		) {
			service.rearm();
		}
		armed = { ...next };
		routesKey = nextRoutesKey;
	});
}
