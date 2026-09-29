import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQueueKeeper, LATENESS_EDGES } from '../src/util/queueKeeper.js';
import { scoreOf } from '../src/util/renderPriority.js';

/**
 * The queue keeper as a data structure, with plain values and no Harper at all.
 *
 * What is pinned here, and why each is a bug nothing else would catch:
 *
 *   - ITS ORDER IS `scoreOf`, AT MINUTE RESOLUTION. `topK` must produce exactly what scoring every due
 *     row with `scoreOf` (on its minute-floored due time) and sorting would, across cadences and the
 *     sitemap boost. Every due time the plugin writes is minute-floored, so it differs from exact
 *     scoring only in the order of rows tied within a minute. The claim order changing silently under
 *     a refactor would look like nothing at all.
 *   - A ROW IT DOES NOT OWN IS NEVER HELD. The host's classifier returns null for residency ghosts;
 *     holding one would start rendering pages another node owns.
 *   - APPLY IS IDEMPOTENT. A replay after a subscription gap, or the whole-table re-send after a base
 *     copy, re-applies rows the keeper already has, and must change nothing.
 *   - `complete` NEVER OVERCLAIMS. A claim that trusts it skips the index scan, so reporting complete
 *     while due rows were left unexamined would strand them.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = 1_790_000_040_000; // a whole minute
const url = (path) => `https://www.example.com${path}`;

const byRouteCadence = {
	'/home': { route: 'route:exact:/', cadenceMs: HOUR },
	'/pdp': { route: 'route:prefix:/product', cadenceMs: 48 * HOUR },
	'/cat': { route: 'route:prefix:/catalog', cadenceMs: 24 * HOUR },
};

/** Classifies by path prefix; any key containing 'ghost' is not owned. */
const classify = (key) => {
	if (key.includes('ghost')) return null;
	const prefix = Object.keys(byRouteCadence).find((p) => key.includes(p));
	return prefix ? byRouteCadence[prefix] : { route: 'none', cadenceMs: 24 * HOUR };
};

const keeperAt = (nowMs = T0) => {
	let clock = nowMs;
	const keeper = createQueueKeeper({ classify, now: () => clock });
	return { keeper, setNow: (ms) => (clock = ms) };
};

const put = (keeper, key, dueAt, fromSitemap = true, opts) =>
	keeper.apply(key, { nextRenderTime: dueAt, fromSitemap }, opts);

// ---- what is held ----------------------------------------------------------------------------------

test('holds a row once, moves it on rewrite, and drops it on delete', () => {
	const { keeper } = keeperAt();
	put(keeper, url('/home'), T0 - HOUR);
	assert.equal(keeper.size, 1);
	put(keeper, url('/home'), T0 + HOUR);
	assert.equal(keeper.size, 1);
	assert.equal(keeper.dueSummary(T0).due, 0, 'moved into the future, so no longer due');
	keeper.apply(url('/home'), null);
	assert.equal(keeper.size, 0);
	assert.equal(keeper.has(url('/home')), false);
});

test('a row this node does not own is never held, and an owned row that stops being owned is dropped', () => {
	const { keeper } = keeperAt();
	assert.equal(put(keeper, url('/ghost/1'), T0 - HOUR), false);
	assert.equal(keeper.size, 0);
	const owned = url('/pdp/1');
	let owner = true;
	const flipping = createQueueKeeper({ classify: (k) => (owner ? classify(k) : null), now: () => T0 });
	flipping.apply(owned, { nextRenderTime: T0 - HOUR, fromSitemap: true });
	assert.equal(flipping.size, 1);
	owner = false;
	flipping.apply(owned, { nextRenderTime: T0 - HOUR, fromSitemap: true });
	assert.equal(flipping.size, 0);
});

test('a row with no usable due time is not held, and a BigInt due time is', () => {
	const { keeper } = keeperAt();
	for (const bad of [null, undefined, NaN, Infinity, -1, 'soon']) {
		assert.equal(keeper.apply(url(`/pdp/${String(bad)}`), { nextRenderTime: bad, fromSitemap: true }), false);
	}
	assert.equal(keeper.size, 0);
	assert.equal(keeper.apply(url('/pdp/big'), { nextRenderTime: BigInt(T0 - HOUR), fromSitemap: true }), true);
	assert.equal(keeper.dueSummary(T0).due, 1);
});

test('applying the same state twice changes nothing', () => {
	const { keeper } = keeperAt();
	for (let i = 0; i < 50; i++) put(keeper, url(`/pdp/${i}`), T0 - i * MINUTE, i % 2 === 0);
	const before = JSON.stringify(keeper.state(T0));
	for (let i = 0; i < 50; i++) put(keeper, url(`/pdp/${i}`), T0 - i * MINUTE, i % 2 === 0, { quiet: true });
	assert.equal(JSON.stringify(keeper.state(T0)), before);
	assert.equal(keeper.size, 50);
});

test('a change of sitemap flag moves the row to the other class', () => {
	const { keeper } = keeperAt();
	put(keeper, url('/pdp/1'), T0 - HOUR, false);
	assert.equal(keeper.state(T0).dueDiscovered, 1);
	put(keeper, url('/pdp/1'), T0 - HOUR, true);
	const s = keeper.state(T0);
	assert.equal(s.dueSitemap, 1);
	assert.equal(s.dueDiscovered, 0);
});

// ---- order -----------------------------------------------------------------------------------------

test('orders by lateness over cadence, not by due time: a late homepage beats an older PDP', () => {
	const { keeper } = keeperAt();
	put(keeper, url('/pdp/old'), T0 - 3 * HOUR); // 3h / 48h = 0.0625
	put(keeper, url('/home'), T0 - 2 * HOUR); // 2h / 1h = 2
	const { rows } = keeper.topK(10, { nowMs: T0 });
	assert.deepEqual(
		rows.map((r) => r.entry.cacheKey),
		[url('/home'), url('/pdp/old')]
	);
	assert.equal(rows[0].score, 2);
});

test('the sitemap boost is a multiplier on the score', () => {
	const { keeper } = keeperAt();
	put(keeper, url('/pdp/listed'), T0 - 10 * HOUR, true);
	put(keeper, url('/pdp/discovered'), T0 - 15 * HOUR, false);
	const { rows } = keeper.topK(10, { nowMs: T0, sitemapBoost: 2 });
	assert.equal(rows[0].entry.cacheKey, url('/pdp/listed'), '10h x2 beats 15h x1');
	assert.equal(rows[0].entry.fromSitemap, true);
	assert.equal(rows[1].entry.fromSitemap, false);
});

test('topK is exactly what scoring every due row at minute resolution and sorting would give', () => {
	const { keeper } = keeperAt();
	let seed = 7;
	const rand = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
	const paths = ['/home', '/pdp', '/cat', '/misc'];
	const all = [];
	for (let i = 0; i < 3000; i++) {
		const key = url(`${paths[i % 4]}/${i}`);
		const dueAt = T0 - Math.floor(rand() * 200 * HOUR) + Math.floor(rand() * 20 * HOUR);
		const fromSitemap = rand() < 0.7;
		put(keeper, key, dueAt, fromSitemap);
		all.push({ key, dueAt: Math.floor(dueAt / MINUTE) * MINUTE, fromSitemap });
	}
	const expected = all
		.filter((r) => r.dueAt <= T0)
		.map((r) => scoreOf(r, { nowMs: T0, intervalMs: classify(r.key).cadenceMs, sitemapBoost: 2 }))
		.sort((a, b) => b - a)
		.slice(0, 500);
	const { rows } = keeper.topK(500, { nowMs: T0, sitemapBoost: 2 });
	assert.equal(rows.length, 500);
	assert.deepEqual(
		rows.map((r) => r.score),
		expected
	);
	for (let i = 1; i < rows.length; i++) assert.ok(rows[i - 1].score >= rows[i].score, 'best first');
});

test('skipped rows are passed over without costing a place', () => {
	const { keeper } = keeperAt();
	for (let i = 0; i < 10; i++) put(keeper, url(`/pdp/${i}`), T0 - (10 - i) * HOUR);
	const leased = new Set([url('/pdp/0'), url('/pdp/1')]);
	const { rows, skipped } = keeper.topK(3, { nowMs: T0, skip: (k) => leased.has(k) });
	assert.deepEqual(
		rows.map((r) => r.entry.cacheKey),
		[url('/pdp/2'), url('/pdp/3'), url('/pdp/4')]
	);
	assert.equal(skipped, 2);
});

test('complete only when every due row was examined', () => {
	const { keeper } = keeperAt();
	for (let i = 0; i < 5; i++) put(keeper, url(`/pdp/${i}`), T0 - (i + 1) * HOUR);
	put(keeper, url('/pdp/future'), T0 + HOUR);
	assert.equal(keeper.topK(10, { nowMs: T0 }).complete, true, 'all 5 due rows fit');
	assert.equal(keeper.topK(3, { nowMs: T0 }).complete, false, 'stopped with due rows left');
	assert.equal(keeper.topK(5, { nowMs: T0 }).complete, false, 'filled to the limit exactly: not claimed');
	const allLeased = keeper.topK(3, { nowMs: T0, skip: () => true });
	assert.equal(allLeased.rows.length, 0);
	assert.equal(allLeased.complete, true, 'every due row examined, all skipped');
	assert.equal(keeper.topK(0, { nowMs: T0 }).complete, false);
});

test('rows due in the future are never returned', () => {
	const { keeper } = keeperAt();
	put(keeper, url('/pdp/later'), T0 + MINUTE);
	put(keeper, url('/pdp/now'), T0);
	assert.deepEqual(
		keeper.topK(10, { nowMs: T0 }).rows.map((r) => r.entry.cacheKey),
		[url('/pdp/now')]
	);
});

// ---- counts ----------------------------------------------------------------------------------------

test('dueSummary gives the due count, the first due minute and the next future minute', () => {
	const { keeper } = keeperAt();
	put(keeper, url('/pdp/1'), T0 - 5 * HOUR);
	put(keeper, url('/home/1'), T0 - HOUR);
	put(keeper, url('/cat/1'), T0 + 10 * MINUTE);
	put(keeper, url('/cat/2'), T0 + 3 * HOUR);
	const s = keeper.dueSummary(T0);
	assert.equal(s.rows, 4);
	assert.equal(s.due, 2);
	assert.equal(s.firstDueMinute, (T0 - 5 * HOUR) / MINUTE);
	assert.equal(s.earliestNotYetDueMinute, (T0 + 10 * MINUTE) / MINUTE);
});

test('state: due split, coming windows and the 24h histogram', () => {
	const { keeper } = keeperAt();
	put(keeper, url('/pdp/due-s'), T0 - 2 * HOUR, true);
	put(keeper, url('/pdp/due-d'), T0 - 30 * HOUR, false);
	put(keeper, url('/pdp/in10'), T0 + 10 * MINUTE);
	put(keeper, url('/pdp/in45'), T0 + 45 * MINUTE);
	put(keeper, url('/pdp/in5h'), T0 + 5 * HOUR + MINUTE);
	put(keeper, url('/pdp/in30h'), T0 + 30 * HOUR);
	const s = keeper.state(T0);
	assert.equal(s.rows, 6);
	assert.equal(s.due, 2);
	assert.equal(s.dueSitemap, 1);
	assert.equal(s.dueDiscovered, 1);
	assert.equal(s.coming.next15m, 1);
	assert.equal(s.coming.next60m, 2);
	assert.equal(s.coming.next24h, 3);
	assert.equal(s.coming.byHour[0], 2);
	assert.equal(s.coming.byHour[5], 1);
	assert.equal(
		s.coming.byHour.reduce((a, b) => a + b, 0),
		3
	);
	assert.equal(s.oldestDueAt, T0 - 30 * HOUR);
	assert.equal(s.nextDueAt, T0 + 10 * MINUTE);
});

test('state: lateness is binned in cadences, split by sitemap and by route', () => {
	const { keeper } = keeperAt();
	put(keeper, url('/home/a'), T0 - 10 * MINUTE, true); // 0.17 cadences -> bin 0
	put(keeper, url('/home/b'), T0 - 90 * MINUTE, true); // 1.5 -> bin 2
	put(keeper, url('/pdp/a'), T0 - 240 * HOUR, false); // 5 -> bin 4
	put(keeper, url('/pdp/b'), T0 - 24 * HOUR, false); // 0.5 -> bin 1
	const s = keeper.state(T0);
	assert.deepEqual(s.lateness.edges, LATENESS_EDGES);
	assert.deepEqual(s.lateness.sitemap, [1, 0, 1, 0, 0]);
	assert.deepEqual(s.lateness.discovered, [0, 1, 0, 0, 1]);
	const home = s.byRoute.find((r) => r.route === 'route:exact:/');
	assert.equal(home.due, 2);
	assert.deepEqual(home.sitemap, [1, 0, 1, 0, 0]);
	const worst = s.classes[0];
	assert.equal(worst.route, 'route:prefix:/product');
	assert.equal(worst.oldestLatenessCadences, 5);
	assert.equal(worst.oldestDueAt, T0 - 240 * HOUR);
});

// ---- flow ------------------------------------------------------------------------------------------

test('flow counts additions, triggers, reschedules and removals per minute; a quiet load counts nothing', () => {
	const { keeper, setNow } = keeperAt();
	put(keeper, url('/pdp/loaded'), T0 - HOUR, true, { quiet: true });
	put(keeper, url('/pdp/new'), T0 + HOUR); // added
	put(keeper, url('/pdp/new'), T0 - MINUTE); // future -> due: triggered
	put(keeper, url('/pdp/loaded'), T0 + 48 * HOUR); // due -> future: rescheduled
	keeper.apply(url('/pdp/new'), null); // removed
	const [minute] = keeper.state(T0).flow;
	assert.deepEqual(minute, { minute: T0, cameDue: 0, added: 1, triggered: 1, rescheduled: 1, removed: 1 });

	put(keeper, url('/pdp/soon'), T0 + 2 * MINUTE, true, { quiet: true });
	keeper.tick(T0);
	setNow(T0 + 3 * MINUTE);
	keeper.tick(T0 + 3 * MINUTE);
	const flow = keeper.state(T0 + 3 * MINUTE).flow;
	assert.equal(flow.find((f) => f.minute === T0 + 2 * MINUTE).cameDue, 1);
});

// ---- a change the probe found ---------------------------------------------------------------------

const putChanged = (keeper, key, dueAt, changedAt = dueAt) =>
	keeper.apply(key, { nextRenderTime: dueAt, fromSitemap: true, changedAt });

test('a CHANGED row starts ahead: filed now, it outranks routine rows that are already overdue', () => {
	// The probe files a changed page at the current minute, so its lateness is zero. Without the head
	// start it would enter BEHIND every overdue row while its page — hard-expired, known wrong — is
	// served from the origin for as long as it waits.
	const { keeper } = keeperAt();
	put(keeper, url('/pdp/routine-late'), T0 - 12 * HOUR); // a quarter of its cadence late
	putChanged(keeper, url('/pdp/changed'), T0);
	const withHeadStart = keeper.topK(10, { nowMs: T0, changedHeadStart: 1 }).rows.map((r) => r.entry.cacheKey);
	assert.deepEqual(withHeadStart, [url('/pdp/changed'), url('/pdp/routine-late')]);
	const without = keeper.topK(10, { nowMs: T0, changedHeadStart: 0 }).rows.map((r) => r.entry.cacheKey);
	assert.deepEqual(without, [url('/pdp/routine-late'), url('/pdp/changed')], 'head start 0: ranked like any other row');
});

test('the head start is BOUNDED: a routine row more than changedHeadStart cadences late wins', () => {
	const { keeper } = keeperAt();
	putChanged(keeper, url('/pdp/changed'), T0);
	put(keeper, url('/pdp/very-late'), T0 - 3 * 48 * HOUR, false); // three cadences late, discovered
	const order = keeper.topK(10, { nowMs: T0, changedHeadStart: 1 }).rows.map((r) => r.entry.cacheKey);
	assert.deepEqual(
		order,
		[url('/pdp/very-late'), url('/pdp/changed')],
		'a change wave cannot starve rotation indefinitely'
	);
});

test('the order with changed rows is still exactly scoreOf at minute resolution', () => {
	const { keeper } = keeperAt();
	const rows = [];
	for (let i = 0; i < 60; i++) {
		const path = ['/home', '/pdp', '/cat'][i % 3];
		const dueAt = T0 - (i % 17) * 37 * MINUTE;
		const changed = i % 4 === 0;
		const fromSitemap = i % 5 !== 0;
		const key = url(`${path}/${i}`);
		keeper.apply(key, { nextRenderTime: dueAt, fromSitemap, changedAt: changed ? dueAt : null });
		rows.push({ key, dueAt, changed, fromSitemap, cadenceMs: classify(key).cadenceMs });
	}
	const opts = { nowMs: T0, sitemapBoost: 2, changedHeadStart: 1 };
	const expected = rows
		.map((r) => ({
			key: r.key,
			score: scoreOf(
				{ dueAt: r.dueAt, fromSitemap: r.fromSitemap, changed: r.changed },
				{ nowMs: T0, intervalMs: r.cadenceMs, sitemapBoost: 2, changedHeadStart: 1 }
			),
		}))
		.sort((a, b) => b.score - a.score)
		.map((r) => r.score);
	const got = keeper.topK(100, opts).rows.map((r) => r.score);
	assert.deepEqual(got, expected);
});

test('the changed flag is part of what is held: describe, heldValue and a clearing rewrite', () => {
	const { keeper } = keeperAt();
	putChanged(keeper, url('/pdp/a'), T0);
	assert.equal(keeper.describe(url('/pdp/a')).changed, true);
	const held = keeper.heldValue(url('/pdp/a'));
	assert.ok(held.changedAt > 0, 'a reclassify re-applies the flag');
	// The render's reschedule `put`s the row without `changedAt`: routine again.
	put(keeper, url('/pdp/a'), T0 + 48 * HOUR);
	assert.equal(keeper.describe(url('/pdp/a')).changed, false);
	// A BigInt, as a Long can surface, is read as a mark.
	keeper.apply(url('/pdp/b'), { nextRenderTime: T0, fromSitemap: true, changedAt: BigInt(T0) });
	assert.equal(keeper.describe(url('/pdp/b')).changed, true);
});

// ---- a changed row's demand (queue.ready.changedDemand) ------------------------------------------

const putUrgent = (keeper, key, dueAt, fromSitemap = true) =>
	keeper.apply(key, { nextRenderTime: dueAt, fromSitemap, urgentAt: dueAt });

test('an URGENT row starts ahead of routine lateness, sitemap-listed or not, and is still bounded', () => {
	// Filed due now by an ask (render-now, revalidate, rejoin, an adopted redirect destination), lateness 0.
	const { keeper } = keeperAt();
	put(keeper, url('/pdp/sitemap-late'), T0 - 30 * HOUR); // 30h late on a 48h cadence: boosted to 1.25
	putUrgent(keeper, url('/pdp/asked'), T0, false);
	put(keeper, url('/pdp/very-late'), T0 - 5 * 48 * HOUR); // five cadences late
	const order = keeper.topK(10, { nowMs: T0, sitemapBoost: 2, urgentHeadStart: 1 }).rows.map((r) => r.entry.cacheKey);
	assert.deepEqual(order, [url('/pdp/very-late'), url('/pdp/asked'), url('/pdp/sitemap-late')]);
	const off = keeper.topK(10, { nowMs: T0, sitemapBoost: 2, urgentHeadStart: 0 }).rows.map((r) => r.entry.cacheKey);
	assert.equal(off.at(-1), url('/pdp/asked'), 'head start 0: ranked like any other row, which is last');
});

test('the urgent flag is part of what is held — describe, heldValue, the state — and a change mark wins', () => {
	const { keeper } = keeperAt();
	putUrgent(keeper, url('/pdp/a'), T0 - MINUTE);
	assert.equal(keeper.describe(url('/pdp/a')).urgent, true);
	assert.ok(keeper.heldValue(url('/pdp/a')).urgentAt > 0, 'a reclassify re-applies the flag');
	keeper.apply(url('/pdp/a'), keeper.heldValue(url('/pdp/a')));
	assert.equal(keeper.describe(url('/pdp/a')).urgent, true, 'and survives the round trip');
	const state = keeper.state(T0);
	assert.equal(state.dueUrgent, 1);
	assert.equal(state.oldestUrgentDueAt, T0 - MINUTE);
	keeper.apply(url('/pdp/b'), { nextRenderTime: T0, fromSitemap: true, changedAt: T0, urgentAt: T0 });
	assert.deepEqual(
		[keeper.describe(url('/pdp/b')).changed, keeper.describe(url('/pdp/b')).urgent],
		[true, false],
		'one class, the change’s'
	);
	put(keeper, url('/pdp/a'), T0 + 48 * HOUR); // the render's reschedule
	assert.equal(keeper.describe(url('/pdp/a')).urgent, false);
});

const putChangedDemand = (keeper, key, dueAt, demandPeriod) =>
	keeper.apply(key, { nextRenderTime: dueAt, fromSitemap: true, changedAt: dueAt, demandPeriod });

test('changedDemand: changed pages found together render most-asked-for first', () => {
	// A change wave: three PDPs found changed in the same minute, an hour ago. In cadence they tie, and
	// the order is whatever the minute bucket holds. In visits, the page asked for every 6h has sent
	// the origin a sixth of a visit per hour of wait, the twice-a-week one a sixtieth.
	const { keeper } = keeperAt();
	putChangedDemand(keeper, url('/pdp/rare'), T0 - HOUR, 96 * HOUR);
	putChangedDemand(keeper, url('/pdp/hot'), T0 - HOUR, 6 * HOUR);
	putChangedDemand(keeper, url('/pdp/daily'), T0 - HOUR, 24 * HOUR);
	const on = keeper.topK(10, { nowMs: T0, changedHeadStart: 1, changedDemand: true }).rows.map((r) => r.entry.cacheKey);
	assert.deepEqual(on, [url('/pdp/hot'), url('/pdp/daily'), url('/pdp/rare')]);
	const off = keeper.topK(10, { nowMs: T0, changedHeadStart: 1, changedDemand: false }).rows;
	assert.equal(new Set(off.map((r) => r.score)).size, 1, 'off: one divisor, one score — demand is ignored');
});

test('changedDemand: a changed row with no demand estimate orders by cadence, as before', () => {
	const { keeper } = keeperAt();
	putChanged(keeper, url('/pdp/unknown'), T0 - 6 * HOUR); // no demandPeriod: the tracker could not say
	const [row] = keeper.topK(10, { nowMs: T0, changedHeadStart: 1, changedDemand: true }).rows;
	assert.equal(row.score, 6 / 48 + 1, 'lateness over the 48h cadence, plus the head start');
});

test('changedDemand: a changed page nobody asks for yields to a routine row at the same score', () => {
	// A changed PDP with no visit in the tracker's 4-day window, 12h into its wait: 12/96 + 1 = 1.125 in
	// visits, 12/48 + 1 = 1.25 in cadence. A routine PDP 1.2 cadences late (57h36m) sits between the two
	// — still being served from the cache to the bots that ARE asking for it. Demand puts it first;
	// cadence would not.
	const { keeper } = keeperAt();
	putChangedDemand(keeper, url('/pdp/unasked'), T0 - 12 * HOUR, 96 * HOUR);
	put(keeper, url('/pdp/routine'), T0 - (57 * HOUR + 36 * MINUTE));
	const order = (changedDemand) =>
		keeper.topK(10, { nowMs: T0, changedHeadStart: 1, changedDemand }).rows.map((r) => r.entry.cacheKey);
	assert.deepEqual(order(true), [url('/pdp/routine'), url('/pdp/unasked')]);
	assert.deepEqual(order(false), [url('/pdp/unasked'), url('/pdp/routine')]);
});

test('changedDemand: the order is still exactly scoreOf, with demand periods in the mix', () => {
	const { keeper } = keeperAt();
	const rows = [];
	const periods = [null, 6 * HOUR, 12 * HOUR, 24 * HOUR, 96 * HOUR];
	for (let i = 0; i < 80; i++) {
		const path = ['/home', '/pdp', '/cat'][i % 3];
		const dueAt = T0 - (i % 19) * 41 * MINUTE;
		const changed = i % 3 !== 1;
		const demandPeriodMs = changed ? periods[i % periods.length] : null;
		const fromSitemap = i % 4 !== 0;
		const key = url(`${path}/${i}`);
		keeper.apply(key, {
			nextRenderTime: dueAt,
			fromSitemap,
			changedAt: changed ? dueAt : null,
			// an unchanged row may carry a stale value; it must mean nothing
			demandPeriod: demandPeriodMs ?? (changed ? null : 6 * HOUR),
		});
		rows.push({ key, dueAt, changed, fromSitemap, demandPeriodMs, cadenceMs: classify(key).cadenceMs });
	}
	const opts = { nowMs: T0, sitemapBoost: 2, changedHeadStart: 1, changedDemand: true };
	const expected = rows
		.map((r) =>
			scoreOf(
				{ dueAt: r.dueAt, fromSitemap: r.fromSitemap, changed: r.changed, demandPeriodMs: r.demandPeriodMs },
				{ nowMs: T0, intervalMs: r.cadenceMs, sitemapBoost: 2, changedHeadStart: 1, changedDemand: true }
			)
		)
		.sort((a, b) => b - a);
	assert.deepEqual(
		keeper.topK(200, opts).rows.map((r) => r.score),
		expected
	);
});

test('scoreOf: demand is the divisor only for a changed row, with the option on and a usable period', () => {
	const at = { nowMs: T0, intervalMs: 48 * HOUR, changedHeadStart: 1, changedDemand: true };
	const dueAt = T0 - 6 * HOUR;
	assert.equal(scoreOf({ dueAt, changed: true, demandPeriodMs: 6 * HOUR }, at), 1 + 1, 'six hours of a 6h period');
	assert.equal(
		scoreOf({ dueAt, changed: true, demandPeriodMs: 6 * HOUR }, { ...at, changedDemand: false }),
		6 / 48 + 1
	);
	assert.equal(scoreOf({ dueAt, changed: false, demandPeriodMs: 6 * HOUR }, at), 6 / 48, 'a routine row ignores it');
	for (const unusable of [null, undefined, 0, -1, NaN]) {
		assert.equal(scoreOf({ dueAt, changed: true, demandPeriodMs: unusable }, at), 6 / 48 + 1, `unusable ${unusable}`);
	}
	assert.equal(
		scoreOf({ dueAt, changed: true, fromSitemap: true, demandPeriodMs: 6 * HOUR }, { ...at, sitemapBoost: 2 }),
		2 + 2,
		'the sitemap boost still multiplies the ratio — and the head start, which is stated in boosted units'
	);
});

test('scoreOf: the head start is in BOOSTED units, so a fresh marked row beats routine sitemap lateness', () => {
	// Unboosted, a head start of 1 was worth half a cadence of sitemap lateness at the default boost of 2:
	// any sitemap product page 24h late on its 48h cadence outranked a page found changed a minute ago.
	const at = { nowMs: T0, intervalMs: 48 * HOUR, sitemapBoost: 2, changedHeadStart: 1, urgentHeadStart: 1 };
	const lateSitemap = scoreOf({ dueAt: T0 - 30 * HOUR, fromSitemap: true }, at);
	for (const fromSitemap of [true, false]) {
		assert.ok(scoreOf({ dueAt: T0, fromSitemap, changed: true }, at) > lateSitemap, `changed, sitemap ${fromSitemap}`);
		assert.ok(scoreOf({ dueAt: T0, fromSitemap, urgent: true }, at) > lateSitemap, `urgent, sitemap ${fromSitemap}`);
	}
	// and still bounded: a sitemap row past `headStart` cadences late wins
	assert.ok(scoreOf({ dueAt: T0 - 50 * HOUR, fromSitemap: true }, at) > scoreOf({ dueAt: T0, changed: true }, at));
});

test('scoreOf: an urgent row takes urgentHeadStart; a row carrying both marks takes the change’s, not the sum', () => {
	const at = { nowMs: T0, intervalMs: 48 * HOUR, changedHeadStart: 1, urgentHeadStart: 0.5 };
	assert.equal(scoreOf({ dueAt: T0, urgent: true }, at), 0.5);
	assert.equal(scoreOf({ dueAt: T0, changed: true, urgent: true }, at), 1);
	assert.equal(scoreOf({ dueAt: T0, urgent: true }, { ...at, urgentHeadStart: 0 }), 0, 'off, not broken');
});

test('a changed row carries its demand through describe, heldValue and the queue state', () => {
	const { keeper } = keeperAt();
	putChangedDemand(keeper, url('/pdp/a'), T0 - HOUR, 6 * HOUR);
	putChangedDemand(keeper, url('/pdp/b'), T0 - 2 * HOUR, 6 * HOUR);
	putChangedDemand(keeper, url('/pdp/c'), T0 - 3 * HOUR, 24 * HOUR);
	putChanged(keeper, url('/pdp/d'), T0 - 4 * HOUR);
	assert.equal(keeper.describe(url('/pdp/a')).demandPeriodMs, 6 * HOUR);
	assert.equal(keeper.heldValue(url('/pdp/a')).demandPeriod, 6 * HOUR, 'a reclassify keeps the estimate');
	assert.deepEqual(keeper.state(T0).changedByDemand, [
		{ periodMs: 6 * HOUR, due: 2, oldestDueAt: T0 - 2 * HOUR },
		{ periodMs: 24 * HOUR, due: 1, oldestDueAt: T0 - 3 * HOUR },
		{ periodMs: null, due: 1, oldestDueAt: T0 - 4 * HOUR },
	]);
	// The render's reschedule `put`s the row without the mark: its demand goes with it.
	put(keeper, url('/pdp/a'), T0 + 48 * HOUR);
	assert.equal(keeper.describe(url('/pdp/a')).demandPeriodMs, null);
});

test('state counts due changed rows and flags their classes', () => {
	const { keeper } = keeperAt();
	putChanged(keeper, url('/pdp/a'), T0 - MINUTE);
	putChanged(keeper, url('/pdp/b'), T0 + HOUR); // not yet due
	put(keeper, url('/pdp/c'), T0 - MINUTE);
	const s = keeper.state(T0);
	assert.equal(s.due, 2);
	assert.equal(s.dueChanged, 1);
	assert.ok(s.classes.some((c) => c.changed === true && c.due === 1));
});
