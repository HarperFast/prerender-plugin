/**
 * THE QUEUE KEEPER'S LIFECYCLE on worker 0: subscribe, load, go live, publish, verify, report.
 *
 * `util/queueKeeper.js` is the data structure. This module makes it this node's render queue: the
 * in-memory front, with `RenderSchedule` as its durable side. It is the INDEX here — the thing claims
 * are served from — so it carries the guarantees an index has to carry, against the table it indexes:
 *
 *   - BUILT FROM THE TABLE. Subscribe first, then walk the table by primary key (chunked, local), and
 *     apply the events that arrived during the walk only after it ends. Applied during the walk, a
 *     chunk read before a write would overwrite the newer value. Only the LAST event per row is kept:
 *     each carries the row's value at delivery, so it is at least as new as anything read, and the
 *     buffer is bounded by the number of rows — a whole-table re-send during the load fits.
 *   - A ROW THE WALK CANNOT READ DOES NOT STOP THE QUEUE. `walkUrlRange` throws when it cannot get past
 *     an unreadable key; the keeper then goes live on what it loaded, marked not exact, and says so
 *     loudly. Rows past that point are held as soon as anything writes them. Failing closed instead
 *     would stop this node granting any claim, forever, since there is no other path to the queue.
 *   - KEPT CURRENT BY EVERY WRITE. The subscription delivers every commit to the table, from any
 *     thread and any node (#215: exact on one node and on two). Only `put`, `delete` and `invalidate`
 *     change a row; a replay after a subscription gap, or the whole-table re-send after a base copy,
 *     re-applies current values and changes nothing.
 *   - CHECKED AGAINST THE TABLE WHEN USED. A claim point-reads each ready-set entry's durable row
 *     before granting it (`claimSchedules`), so an entry the keeper has not yet seen rescheduled or
 *     deleted is skipped, never rendered. Each publish also point-reads the head of what it published
 *     and repairs any it holds wrongly.
 *   - VERIFIED AGAINST THE TABLE, periodically (`queue.keeper.verifyInterval`): a full primary-key walk
 *     repairs anything missing, held at the wrong minute or class, or held after it was deleted. That
 *     bounds a missed write to one interval and counts it (`queue_health` `keeper_repaired`).
 *
 * A repair never trusts a read over a newer event: it snapshots what the keeper holds for the key,
 * reads the durable row, and applies the read only if the keeper's entry did not change meanwhile.
 * Harper delivers a row's value as of delivery, so an event arriving later can only be newer still.
 *
 * OWNERSHIP. The keeper holds only rows this node owns by residency: a node can store stale rows from
 * an earlier ownership ("residency ghosts"), which the old index never surfaced. Ownership depends on
 * the cluster's node list, empty at every worker start until the first `hdb_nodes` scan
 * (`util/residency.js`), so the load waits for a peer (up to a grace period, for a single-node
 * deployment), takes the node list BEFORE the walk, reloads if it changed during it, and rebuilds on
 * any later change.
 *
 * WHILE IT IS NOT LIVE — waiting for peers, loading, or failed and retrying — this node grants no
 * claims and reports `unready`; going live is reported at once (`QueueState`). There is no other path to the queue: the
 * `nextRenderTime` index it replaced is gone (#215).
 */
import { setImmediate as yieldNow, setTimeout as sleep } from 'node:timers/promises';
import { config, onConfigApplied } from '../config.js';
import { metrics } from '../metrics.js';
import { CacheKey } from './cacheKey.js';
import { getSab } from './coordination.js';
import { createQueueKeeper } from './queueKeeper.js';
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
/** Rows between event-loop yields during a walk. */
const WALK_YIELD_EVERY = 200;
/** Published entries point-read after each publish: the head, which claims take first. */
const TOP_CHECK_ROWS = 64;
/** A publish is forced at least this often, so an expired lease is noticed even with nothing else moving. */
const FORCE_PUBLISH_MS = 10_000;
/** Membership-driven rebuilds are spaced at least this far apart. */
const MIN_REBUILD_GAP_MS = 30_000;
const SCHEDULE_FIELDS = ['cacheKey', 'nextRenderTime', 'fromSitemap', 'effectiveInterval'];
const MAX_TIMER_MS = 2_147_483_647;

let snapshot = null;
const stateSnapshot = () =>
	(snapshot ??= createSharedSnapshot({ buffer: getSab(STATE_SAB_KEY, snapshotBufferBytes(STATE_SLOT_BYTES)) }));

/** The last queue-state document worker 0 published, from any worker; null before the first. */
export const readQueueStateDocument = () => stateSnapshot().read();

const messageOf = (e) => e?.message ?? String(e);

/**
 * Tell the fleet at once when this node starts or stops serving claims (`unready` ⇄ `queued`/`empty`),
 * rather than on the next status sync, up to `queue.statusSyncInterval` later. Unforced, so a pause
 * stands. Loaded lazily: `resources/QueueState.js` needs Harper's `Resource` at import.
 */
const reportQueueStatus = (status) =>
	import('../resources/QueueState.js')
		.then(({ QueueState }) => QueueState.reportStatus(status))
		.catch((e) => globalThis.logger?.warn?.(`[prerender] queue keeper could not report ${status}: ${messageOf(e)}`));

const carriedCadence = (effectiveInterval) => {
	const ms = Number(effectiveInterval);
	return Number.isFinite(ms) && ms > 0 ? ms : null;
};

/**
 * The host's classifier: null for a row this node does not own, else its route and cadence: the
 * row's carried `effectiveInterval`, else route over default.
 */
export const classifyScheduleRow = (key, value) => {
	const url = CacheKey.urlOf(key);
	if (getResidencyByUrl(url) !== server.hostname) return null;
	const cadenceMs = carriedCadence(value?.effectiveInterval) ?? resolveRenderInterval(url, null);
	return { route: routeScopeForUrl(url) ?? 'unrouted', cadenceMs };
};

const capList = (list) => (list.length > MAX_LISTED ? list.slice(0, MAX_LISTED) : list);

/** Does what the keeper holds for this key match the durable row? */
const matches = (held, row, described) =>
	held !== null &&
	described !== null &&
	held.minute === minuteOf(Number(row.nextRenderTime)) &&
	held.fromSitemap === !!row.fromSitemap &&
	held.cadenceMs === described.cadenceMs &&
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
} = {}) => {
	const createdAt = now();
	let keeper = null;
	let subscription = null;
	let phase = 'stopped';
	let epoch = 0;
	/** During a load: the last event per row, applied when the walk ends. */
	let buffered = null;
	let publishing = false;
	let lastDue = 0;
	let verifying = false;
	let lastPublishKey = null;
	let failures = 0;
	let nodesKey = null;
	let lastRebuildAt = 0;
	let withdrawnAtStart = false;
	const timers = { publish: null, state: null, verify: null, retry: null, rebuild: null };
	const stats = {
		loadStartedAt: null,
		loadedAt: null,
		loadMs: null,
		loadRows: 0,
		unreadableRows: 0,
		/** Why the last load stopped short of the end of the table, or null when it read it all. */
		partialLoad: null,
		eventsApplied: 0,
		lastEventAt: null,
		lastPublish: null,
		topCheck: null,
		verify: null,
		repairedTotal: 0,
		lastError: null,
	};

	const applyEvent = (event) => {
		const type = event?.type;
		// A `put` carries the row's current value (Harper re-reads it before delivery); `delete` and
		// `invalidate` mean there is no current row here. Anything else — a `message` published to the
		// table, a transaction marker — says nothing about the row and must not remove it.
		let value;
		if (type === 'put') value = event.value ?? null;
		else if (type === 'delete' || type === 'invalidate') value = null;
		else return;
		keeper.apply(event.id, value);
		stats.eventsApplied++;
		stats.lastEventAt = now();
	};

	const onEvent = (event) => {
		if (!keeper || event?.id === undefined || event?.id === null) return;
		if (buffered) {
			buffered.delete(event.id); // re-insert, so the map holds each row's LAST event
			buffered.set(event.id, event);
			return;
		}
		try {
			applyEvent(event);
		} catch (e) {
			// An event that could not be applied is a row the keeper may now be wrong about. Rebuild
			// rather than carry on silently different from the table.
			log?.error?.(`[prerender] queue keeper could not apply a ${event?.type} for ${event?.id}: ${messageOf(e)}`);
			rebuild('an event could not be applied');
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

	/** Stop serving the keeper's generation: claims grant nothing until it is live again. */
	const withdraw = () => {
		clearKeeperSignal();
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

	/** Load from the table and go live. Resolves when live, or when stopped/superseded meanwhile. */
	const start = async () => {
		const mine = ++epoch;
		clearTimers();
		endSubscription();
		// A generation left by an earlier worker 0 (a restart, a crash) or by this keeper before a
		// rebuild must not keep being served: claims wait until this one is live.
		if (phase === 'live' || !withdrawnAtStart) withdraw();
		withdrawnAtStart = true;
		keeper = null;
		buffered = null;
		stats.lastError = null;

		// Ownership is only knowable once the node list is. Wait for a peer, up to the grace period.
		if (getNodes().length < 2 && now() - createdAt < peerGraceMs) {
			phase = 'waiting-for-peers';
			writeState();
			while (getNodes().length < 2 && now() - createdAt < peerGraceMs) {
				await sleep(1_000, undefined, { ref: false });
				if (mine !== epoch) return;
			}
		}

		phase = 'loading';
		nodesKey = getNodes().join(',');
		keeper = createQueueKeeper({ classify: classifyScheduleRow, now });
		buffered = new Map();
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
			let rows = 0;
			try {
				for await (const row of walkScheduleRows({ onUnreadable: () => stats.unreadableRows++ })) {
					if (mine !== epoch) return;
					keeper.apply(row.cacheKey, row, { quiet: true });
					if (++rows % WALK_YIELD_EVERY === 0) await yieldNow();
				}
			} catch (e) {
				if (e?.code !== WALK_CANNOT_ADVANCE) throw e;
				// Live on what was read (see the module comment); `exact` is false while this stands.
				stats.partialLoad = messageOf(e);
				stats.unreadableRows++;
				log?.error?.(
					`[prerender] queue keeper load stopped at an unreadable schedule row after ${rows} row(s): ` +
						`${stats.partialLoad}. Going live without the rows past it; they are held as soon as anything ` +
						'writes them. Repair or delete the unreadable row, then restart.'
				);
			}
			if (mine !== epoch) return;
			if (getNodes().join(',') !== nodesKey) {
				log?.info?.('[prerender] queue keeper: the node list changed during the load; loading again.');
				rebuild('the node list changed during the load');
				return;
			}
			const pending = [...buffered.values()];
			buffered = null;
			for (const event of pending) applyEvent(event);
			stats.loadRows = rows;
			stats.loadMs = Math.round(performance.now() - started);
			stats.loadedAt = now();
			failures = 0;
			phase = 'live';
			lastPublishKey = null;
			metrics.queueHealth(stats.loadMs, 'keeper_load_ms');
			log?.info?.(
				`[prerender] queue keeper live: ${keeper.size} of ${rows} stored schedule rows are this node's, loaded in ` +
					`${stats.loadMs}ms (${pending.length} write(s) applied from during the load` +
					`${stats.unreadableRows ? `, ${stats.unreadableRows} unreadable row(s) skipped` : ''}).`
			);
			if (getNodes().length < 2) {
				log?.info?.(
					'[prerender] queue keeper: no cluster peer is visible, so every stored row counts as this ' +
						"node's. If this node is clustered, the keeper rebuilds when the node list changes."
				);
			}
			await publish();
			if (mine !== epoch) return;
			reportQueueStatus(lastDue > 0 ? 'queued' : 'empty');
			writeState();
			timers.publish = every(publish, config.queue.keeper.publishInterval);
			timers.state = every(writeState, config.queue.keeper.stateInterval);
			if (config.queue.keeper.verifyInterval > 0) timers.verify = every(verify, config.queue.keeper.verifyInterval);
		} catch (e) {
			if (mine !== epoch) return;
			phase = 'failed';
			stats.lastError = messageOf(e);
			buffered = null;
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
		buffered = null;
		failures = 0;
		phase = 'stopped';
		writeState();
	};

	/** Rebuild from the table; spaced so a flapping trigger cannot re-walk the table continuously. */
	const rebuild = (why) => {
		const wait = lastRebuildAt + MIN_REBUILD_GAP_MS - now();
		if (wait > 0) {
			if (!timers.rebuild) {
				log?.info?.(`[prerender] queue keeper rebuild (${why}) deferred ${Math.ceil(wait / 1000)}s.`);
				timers.rebuild = setTimeout(() => {
					timers.rebuild = null;
					lastRebuildAt = now();
					start();
				}, wait);
				timers.rebuild.unref?.();
			}
			return Promise.resolve();
		}
		lastRebuildAt = now();
		log?.info?.(`[prerender] queue keeper rebuilding from the table: ${why}.`);
		return start();
	};

	const publish = async () => {
		if (phase !== 'live') return;
		// The heartbeat comes first and does not wait on a publish still in flight (its head check awaits
		// 64 point reads): a slow publish must not look like a dead keeper to the claim path.
		if (publishing) {
			setKeeperSignal({ due: lastDue, nowMs: now() });
			return;
		}
		publishing = true;
		const mine = epoch;
		const started = performance.now();
		try {
			if (subscription?.closed) {
				rebuild('its subscription closed');
				return;
			}
			const nodes = getNodes().join(',');
			if (nodes !== nodesKey) {
				rebuild(`the cluster's node list changed (${nodesKey || 'none'} -> ${nodes})`);
				return;
			}
			const nowMs = now();
			keeper.tick(nowMs);
			const summary = keeper.dueSummary(nowMs);
			// The heartbeat, every tick: a keeper that is alive but has nothing new to publish must not
			// look stalled to the claim path.
			lastDue = summary.due;
			setKeeperSignal({ due: summary.due, nowMs });

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
			// Check the head of what was just published against the table, and repair what it holds
			// wrongly, so an entry a claim would find stale is fixed at the source rather than skipped
			// on every claim until its event arrives.
			let repaired = 0;
			const checked = top.rows.slice(0, TOP_CHECK_ROWS);
			for (const { entry } of checked) {
				if (mine !== epoch || !keeper) return;
				if (await repairFromTable(entry.cacheKey)) repaired++;
			}
			stats.topCheck = { at: nowMs, checked: checked.length, repaired };
			if (repaired) {
				// Usually an event still on its way: the next publish would have corrected it. Counted
				// apart from the verification walk's repairs, which are misses.
				lastPublishKey = null;
			}
		} catch (e) {
			stats.lastError = messageOf(e);
			log?.error?.(`[prerender] queue keeper publish failed: ${stats.lastError}`);
		} finally {
			publishing = false;
		}
	};

	/**
	 * The verification walk: every row of the table against the keeper, and every key the keeper holds
	 * against the table. What it repairs is a write the keeper missed.
	 */
	const verify = async () => {
		if (phase !== 'live' || verifying) return null;
		verifying = true;
		const mine = epoch;
		const started = performance.now();
		const result = { at: now(), scanned: 0, owned: 0, unowned: 0, missing: 0, mismatched: 0, phantoms: 0 };
		try {
			const seen = new Set();
			const suspects = [];
			let unreadable = 0;
			for await (const row of walkScheduleRows({ onUnreadable: () => unreadable++ })) {
				if (mine !== epoch || !keeper) return null;
				result.scanned++;
				const described = classifyScheduleRow(row.cacheKey, row);
				if (!described) {
					result.unowned++;
				} else {
					result.owned++;
					seen.add(row.cacheKey);
					if (!matches(keeper.describe(row.cacheKey), row, described)) suspects.push(row.cacheKey);
				}
				if (result.scanned % WALK_YIELD_EVERY === 0) await yieldNow();
			}
			// Keys the keeper holds that the walk did not see: deleted, or written after the walk passed.
			for (const key of keeper.keys()) if (!seen.has(key)) suspects.push(key);
			for (const key of suspects) {
				if (mine !== epoch || !keeper) return null;
				const wasHeld = keeper.describe(key) !== null;
				if (await repairFromTable(key)) {
					if (!wasHeld) result.missing++;
					else if (keeper.describe(key) === null) result.phantoms++;
					else result.mismatched++;
				}
			}
			result.unreadableRows = unreadable;
			result.repaired = result.missing + result.mismatched + result.phantoms;
			result.ms = Math.round(performance.now() - started);
			stats.verify = result;
			stats.repairedTotal += result.repaired;
			metrics.queueHealth(result.ms, 'keeper_verify_ms');
			if (result.repaired) {
				metrics.queueHealth(result.repaired, 'keeper_repaired');
				log?.warn?.(
					`[prerender] queue keeper verification repaired ${result.repaired} row(s) it held differently from ` +
						`the table (${result.missing} missing, ${result.mismatched} mismatched, ${result.phantoms} deleted). ` +
						'Those were writes it missed; a steady count means its subscription is losing them.'
				);
			}
			return result;
		} catch (e) {
			stats.lastError = messageOf(e);
			log?.error?.(`[prerender] queue keeper verification failed: ${stats.lastError}`);
			return null;
		} finally {
			verifying = false;
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
				// nothing skipped on the load, and the last verification found nothing to repair
				exact: phase === 'live' && stats.unreadableRows === 0 && !stats.partialLoad && !(stats.verify?.repaired > 0),
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
		rebuild,
		publish,
		verify,
		writeState,
		/** Re-arm the timers after an interval change; no-op unless live. */
		rearm() {
			if (phase !== 'live') return;
			for (const name of ['publish', 'state', 'verify']) if (timers[name]) clearInterval(timers[name]);
			timers.publish = every(publish, config.queue.keeper.publishInterval);
			timers.state = every(writeState, config.queue.keeper.stateInterval);
			timers.verify = config.queue.keeper.verifyInterval > 0 ? every(verify, config.queue.keeper.verifyInterval) : null;
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
 * change to the routes or the default interval rebuilds it (a row's route and resolved cadence are its
 * class). Idempotent.
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
			service.rebuild('the routes or the default render interval changed, so rows may have changed class');
		} else if (
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
