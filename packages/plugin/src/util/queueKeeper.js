/**
 * THE QUEUE KEEPER — this node's render queue, held in memory, kept current by a subscription.
 *
 * Before v0.93.0 the queue was the `nextRenderTime` index: a ready-set sweep walked it every few
 * minutes for "which rows next", the backlog snapshot walked it again for "how much is waiting", and
 * the claim scan fell back to it. Every walk degraded with the store (dead entries at the index head,
 * ~55 us/row on a churned production corpus), was bounded by a cap that truncated exactly when the
 * queue was deepest, and was minutes stale. This structure replaced all three: it holds every row this
 * node owns, keyed by cache key, and a subscription on `RenderSchedule` moves a row whenever it is
 * written. prerender-plugin#215 has the design and the benchmarks.
 *
 * ── WHY PER-CLASS BUCKETS ORDER THE QUEUE WITHOUT RESCORING ─────────────────────────────────
 *
 * The claim order is `util/renderPriority.js#scoreOf`: lateness over cadence, times the sitemap
 * boost. That score changes with the clock, so no stored order can express it (#80). But two rows
 * with the same cadence and the same sitemap flag share both divisor and multiplier, so between
 * THEM the earlier due time always scores higher, at every instant. So rows are grouped into
 * classes (route, cadence, sitemap flag), each class keeps its rows by due minute in ascending
 * order, and the best row overall is always at the head of one class. Taking the best K is a k-way
 * merge over a few dozen class heads, not a scan of the due set.
 *
 * The route is part of the class only so queue state can be reported per route; it does not change
 * the order.
 *
 * ── WHAT IS HELD, AND WHAT IS NOT ──────────────────────────────────────────────────────────────
 *
 * `classify` decides. The host passes one that returns null for a row this node does not own by
 * residency: a node can hold stale rows from an earlier ownership (a "residency ghost"), and a keeper
 * loading by primary key must not start rendering them. A row with no finite, non-negative due time
 * is not held either: `scoreOf` would have to guess at it, and the claim path has never served one.
 *
 * Minute granularity: every due time the plugin writes is minute-floored, and the ready set stores
 * due times in seconds for reporting only. Bucketing by minute costs
 * nothing that ordering or counting needs.
 *
 * NO DEPENDENCIES beyond the scoring policy, deliberately, same discipline as `util/readyQueue.js`:
 * `test/queueKeeper.test.js` drives it with plain values and no Harper at all.
 */
import { scoreOf } from './renderPriority.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Lateness bin edges, in cadences: [0, 0.25), [0.25, 1), [1, 2), [2, 4), [4, ∞). */
export const LATENESS_EDGES = [0.25, 1, 2, 4];

/**
 * A row is stored as one number, `dueMinute * CLASS_SPAN + classId`, so the per-row cost is one Map
 * entry and one Set membership. 2^16 classes is far past any real corpus: the class count is routes
 * times distinct cadences times two.
 */
const CLASS_SPAN = 65_536;

const binOf = (cadences) => {
	let bin = 0;
	while (bin < LATENESS_EDGES.length && cadences >= LATENESS_EDGES[bin]) bin++;
	return bin;
};

/** Index of the first element >= `value` in an ascending array. */
const lowerBound = (arr, value) => {
	let lo = 0;
	let hi = arr.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (arr[mid] < value) lo = mid + 1;
		else hi = mid;
	}
	return lo;
};

/**
 * @param {object} opts
 * @param {(key: string, value: object) => ({ route: string, cadenceMs: number, carried?: boolean } | null)} opts.classify
 *   null means "not this node's to render": the row is not held. `carried` says the cadence came off the
 *   row (`effectiveInterval`) rather than from config, which is what lets the host reclassify every
 *   held row in memory when config changes (`describe` hands it back).
 * @param {() => number} [opts.now]  injected clock, for flow accounting
 * @param {number} [opts.flowMinutes]  how many minutes of flow history to keep
 */
export const createQueueKeeper = ({ classify, now = Date.now, flowMinutes = 60 } = {}) => {
	if (typeof classify !== 'function') throw new TypeError('createQueueKeeper needs a classify function');

	/** key -> dueMinute * CLASS_SPAN + classId */
	const rows = new Map();
	/** classId -> { route, cadenceMs, carried, fromSitemap, buckets: Map<minute, Set<key>>, minutes: number[] } */
	const classes = [];
	const classIds = new Map();

	const flowSpan = Math.max(1, flowMinutes | 0);
	const flow = Array.from({ length: flowSpan }, () => ({
		minute: -1,
		added: 0,
		triggered: 0,
		rescheduled: 0,
		removed: 0,
		cameDue: 0,
	}));
	let lastTickMinute = null;
	// Bumped by every apply that changes what is held, so the host can skip a publish nothing changed.
	let version = 0;

	const classOf = (route, cadenceMs, carried, fromSitemap) => {
		const name = `${route}\u0000${cadenceMs}\u0000${carried ? 1 : 0}\u0000${fromSitemap ? 1 : 0}`;
		let id = classIds.get(name);
		if (id === undefined) {
			id = classes.length;
			if (id >= CLASS_SPAN) throw new RangeError(`queue keeper: more than ${CLASS_SPAN} classes`);
			classes.push({ route, cadenceMs, carried, fromSitemap, buckets: new Map(), minutes: [] });
			classIds.set(name, id);
		}
		return id;
	};

	const unpack = (packed) => {
		const classId = packed % CLASS_SPAN;
		return { classId, minute: (packed - classId) / CLASS_SPAN };
	};

	const insert = (key, classId, minute) => {
		const k = classes[classId];
		let set = k.buckets.get(minute);
		if (!set) {
			k.buckets.set(minute, (set = new Set()));
			k.minutes.splice(lowerBound(k.minutes, minute), 0, minute);
		}
		set.add(key);
		rows.set(key, minute * CLASS_SPAN + classId);
	};

	const remove = (key, packed) => {
		const { classId, minute } = unpack(packed);
		const k = classes[classId];
		const set = k.buckets.get(minute);
		if (set) {
			set.delete(key);
			if (set.size === 0) {
				k.buckets.delete(minute);
				const at = lowerBound(k.minutes, minute);
				if (k.minutes[at] === minute) k.minutes.splice(at, 1);
			}
		}
		rows.delete(key);
	};

	const flowSlot = (minute) => {
		const slot = flow[((minute % flowSpan) + flowSpan) % flowSpan];
		if (slot.minute !== minute) {
			slot.minute = minute;
			slot.added = slot.triggered = slot.rescheduled = slot.removed = slot.cameDue = 0;
		}
		return slot;
	};

	const dueMinuteOf = (value) => {
		const at = value?.nextRenderTime;
		if (at === null || at === undefined) return null;
		const ms = Number(at); // a Long can surface as a BigInt
		return Number.isFinite(ms) && ms >= 0 ? Math.floor(ms / MINUTE) : null;
	};

	/**
	 * Apply one row's current state. `value` null or undefined means the row is gone. Idempotent:
	 * applying the same value twice changes nothing, which is what lets a replay after a gap, or the
	 * whole-table re-send after a base copy, be absorbed without any bookkeeping.
	 *
	 * `quiet` skips flow accounting, for the initial load.
	 */
	const apply = (key, value, { quiet = false } = {}) => {
		const old = rows.get(key);
		const minute = value ? dueMinuteOf(value) : null;
		const described = minute === null ? null : classify(key, value);
		const nowMinute = quiet ? 0 : Math.floor(now() / MINUTE);
		const wasDue = old !== undefined && unpack(old).minute <= nowMinute;

		if (old !== undefined) remove(key, old);
		if (old !== undefined || described) version++;
		if (!described) {
			if (!quiet && old !== undefined) {
				const slot = flowSlot(nowMinute);
				slot.removed++;
			}
			return false;
		}
		const classId = classOf(described.route, described.cadenceMs, !!described.carried, !!value.fromSitemap);
		insert(key, classId, minute);
		if (!quiet) {
			const isDue = minute <= nowMinute;
			const slot = flowSlot(nowMinute);
			if (old === undefined) slot.added++;
			else if (wasDue && !isDue) slot.rescheduled++;
			else if (!wasDue && isDue) slot.triggered++;
		}
		return true;
	};

	/**
	 * Record, per minute since the last tick, how many held rows came due in it. Called by the host's
	 * publish loop; a gap longer than the flow window only records the window.
	 */
	const tick = (nowMs) => {
		const nowMinute = Math.floor(nowMs / MINUTE);
		if (lastTickMinute === null) {
			lastTickMinute = nowMinute;
			return;
		}
		for (let m = Math.max(lastTickMinute + 1, nowMinute - flowSpan + 1); m <= nowMinute; m++) {
			let n = 0;
			for (const k of classes) n += k.buckets.get(m)?.size ?? 0;
			flowSlot(m).cameDue += n;
		}
		lastTickMinute = Math.max(lastTickMinute, nowMinute);
	};

	/**
	 * The best `k` due rows, BEST FIRST, in the shape `readyQueue.publish` takes.
	 *
	 * A k-way merge over class heads: a max-heap of classes keyed by the score of each class's
	 * earliest due minute. Popping a class emits that minute's rows, then the class goes back keyed by
	 * its next minute. Rows `skip` rejects (leased, or no longer owned) are passed over, not counted.
	 *
	 * `complete` is true when every due row was examined: the result then holds every due row that
	 * `skip` let through, so a claim that exhausts the published set knows nothing more is due.
	 */
	const topK = (k, { nowMs, sitemapBoost = 1, skip } = {}) => {
		const limit = Math.max(0, k | 0);
		const nowMinute = Math.floor(nowMs / MINUTE);
		const out = [];
		let skipped = 0;

		// heap entries: [score, classId, cursor]
		const heap = [];
		const less = (a, b) => a[0] > b[0]; // max-heap
		const push = (entry) => {
			heap.push(entry);
			let i = heap.length - 1;
			while (i > 0) {
				const parent = (i - 1) >> 1;
				if (!less(heap[i], heap[parent])) break;
				[heap[i], heap[parent]] = [heap[parent], heap[i]];
				i = parent;
			}
		};
		const pop = () => {
			const top = heap[0];
			const last = heap.pop();
			if (heap.length) {
				heap[0] = last;
				for (let i = 0; ; ) {
					const l = 2 * i + 1;
					const r = l + 1;
					let best = i;
					if (l < heap.length && less(heap[l], heap[best])) best = l;
					if (r < heap.length && less(heap[r], heap[best])) best = r;
					if (best === i) break;
					[heap[i], heap[best]] = [heap[best], heap[i]];
					i = best;
				}
			}
			return top;
		};
		const scoreAt = (klass, minute) =>
			scoreOf(
				{ dueAt: minute * MINUTE, fromSitemap: klass.fromSitemap },
				{ nowMs, intervalMs: klass.cadenceMs, sitemapBoost }
			);

		for (let id = 0; id < classes.length; id++) {
			const klass = classes[id];
			if (klass.minutes.length && klass.minutes[0] <= nowMinute) push([scoreAt(klass, klass.minutes[0]), id, 0]);
		}

		while (heap.length && out.length < limit) {
			const [score, id, cursor] = pop();
			const klass = classes[id];
			const minute = klass.minutes[cursor];
			for (const key of klass.buckets.get(minute)) {
				if (skip && skip(key)) {
					skipped++;
					continue;
				}
				out.push({ entry: { cacheKey: key, dueAt: minute * MINUTE, fromSitemap: klass.fromSitemap }, score });
				if (out.length >= limit) break;
			}
			const next = cursor + 1;
			if (next < klass.minutes.length && klass.minutes[next] <= nowMinute) {
				push([scoreAt(klass, klass.minutes[next]), id, next]);
			}
		}
		// Exhausted only if nothing due is left un-examined. Stopping at `limit` mid-bucket, or with
		// classes still on the heap, is not complete even if the next rows would all be skipped.
		return { rows: out, skipped, complete: heap.length === 0 && out.length < limit };
	};

	/** Counts that the publish loop needs every tick, cheaply: due rows and the next due minute. */
	const dueSummary = (nowMs) => {
		const nowMinute = Math.floor(nowMs / MINUTE);
		let due = 0;
		let firstDueMinute = null;
		let earliestNotYetDueMinute = null;
		for (const klass of classes) {
			const { minutes, buckets } = klass;
			if (!minutes.length) continue;
			if (minutes[0] <= nowMinute && (firstDueMinute === null || minutes[0] < firstDueMinute)) {
				firstDueMinute = minutes[0];
			}
			const firstFuture = lowerBound(minutes, nowMinute + 1);
			for (let i = 0; i < firstFuture; i++) due += buckets.get(minutes[i]).size;
			if (
				firstFuture < minutes.length &&
				(earliestNotYetDueMinute === null || minutes[firstFuture] < earliestNotYetDueMinute)
			) {
				earliestNotYetDueMinute = minutes[firstFuture];
			}
		}
		return { rows: rows.size, due, firstDueMinute, earliestNotYetDueMinute };
	};

	/**
	 * The queue-state counts (#215's shape, before the host adds leases, pause and trust). Walks every
	 * occupied minute of every class once: tens of thousands of buckets on a large node, so the host
	 * computes it on its own slower interval, never per claim.
	 */
	const state = (nowMs) => {
		const nowMinute = Math.floor(nowMs / MINUTE);
		const bins = () => new Array(LATENESS_EDGES.length + 1).fill(0);
		const lateness = { sitemap: bins(), discovered: bins() };
		const byRoute = new Map();
		const byHour = new Array(24).fill(0);
		let due = 0;
		let dueSitemap = 0;
		let next15m = 0;
		let next60m = 0;
		let next24h = 0;
		let oldestDueMinute = null;
		let nextDueMinute = null;
		const classRows = [];

		for (const klass of classes) {
			const { minutes, buckets, cadenceMs, fromSitemap, route } = klass;
			if (!minutes.length) continue;
			let classDue = 0;
			let classRowsHeld = 0;
			let routeEntry = byRoute.get(route);
			if (!routeEntry) byRoute.set(route, (routeEntry = { route, due: 0, sitemap: bins(), discovered: bins() }));
			for (const minute of minutes) {
				const n = buckets.get(minute).size;
				classRowsHeld += n;
				if (minute <= nowMinute) {
					classDue += n;
					const cadences = cadenceMs > 0 ? ((nowMinute - minute) * MINUTE) / cadenceMs : 0;
					const bin = binOf(cadences);
					(fromSitemap ? lateness.sitemap : lateness.discovered)[bin] += n;
					(fromSitemap ? routeEntry.sitemap : routeEntry.discovered)[bin] += n;
				} else {
					const aheadMs = minute * MINUTE - nowMs;
					if (minute - nowMinute <= 15) next15m += n;
					if (minute - nowMinute <= 60) next60m += n;
					const hour = Math.floor(aheadMs / HOUR);
					if (hour < 24) {
						byHour[hour] += n;
						next24h += n;
					}
					if (nextDueMinute === null || minute < nextDueMinute) nextDueMinute = minute;
				}
			}
			due += classDue;
			if (fromSitemap) dueSitemap += classDue;
			routeEntry.due += classDue;
			const head = minutes[0];
			if (classDue && (oldestDueMinute === null || head < oldestDueMinute)) oldestDueMinute = head;
			classRows.push({
				route,
				cadenceMs,
				fromSitemap,
				rows: classRowsHeld,
				due: classDue,
				oldestDueAt: classDue ? head * MINUTE : null,
				// the class head's lateness, in its own cadences: the score before the sitemap boost
				oldestLatenessCadences: classDue && cadenceMs > 0 ? ((nowMinute - head) * MINUTE) / cadenceMs : null,
			});
		}

		const flowOut = [];
		for (let m = nowMinute - flowSpan + 1; m <= nowMinute; m++) {
			const slot = flow[((m % flowSpan) + flowSpan) % flowSpan];
			if (slot.minute !== m) continue;
			const { added, triggered, rescheduled, removed, cameDue } = slot;
			flowOut.push({ minute: m * MINUTE, cameDue, added, triggered, rescheduled, removed });
		}

		return {
			rows: rows.size,
			due,
			dueSitemap,
			dueDiscovered: due - dueSitemap,
			oldestDueAt: oldestDueMinute === null ? null : oldestDueMinute * MINUTE,
			nextDueAt: nextDueMinute === null ? null : nextDueMinute * MINUTE,
			coming: { next15m, next60m, next24h, byHour },
			lateness: { edges: LATENESS_EDGES, ...lateness },
			byRoute: [...byRoute.values()].filter((r) => r.due > 0).sort((a, b) => b.due - a.due),
			classes: classRows.filter((c) => c.due > 0).sort((a, b) => b.oldestLatenessCadences - a.oldestLatenessCadences),
			flow: flowOut,
		};
	};

	return {
		apply,
		tick,
		topK,
		dueSummary,
		state,
		has: (key) => rows.has(key),
		/** What is held for `key` — due minute and class — or null. */
		describe: (key) => {
			const packed = rows.get(key);
			if (packed === undefined) return null;
			const { classId, minute } = unpack(packed);
			const { route, cadenceMs, carried, fromSitemap } = classes[classId];
			return { minute, route, cadenceMs, carried, fromSitemap };
		},
		/**
		 * The row value `apply` would need to hold `key` exactly as it is held now — for reclassifying in
		 * memory: applying it again re-runs `classify` under the current config and ownership. Null when
		 * not held.
		 */
		heldValue: (key) => {
			const packed = rows.get(key);
			if (packed === undefined) return null;
			const { classId, minute } = unpack(packed);
			const { cadenceMs, carried, fromSitemap } = classes[classId];
			return { nextRenderTime: minute * MINUTE, fromSitemap, effectiveInterval: carried ? cadenceMs : null };
		},
		/** A snapshot of every held key: safe to iterate while applying (a live iterator is not). */
		keys: () => [...rows.keys()],
		/** The due minute held for `key`, or null when it is not held. */
		dueMinuteOf: (key) => {
			const packed = rows.get(key);
			return packed === undefined ? null : unpack(packed).minute;
		},
		/** Changes whenever what is held changes. */
		get version() {
			return version;
		},
		get size() {
			return rows.size;
		},
		get classCount() {
			return classes.length;
		},
	};
};
