import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * THE INVALIDATION ACCELERATOR — demand-driven heal, default off.
 *
 * What is pinned here is the refusal set, because that is where the whole mechanism's safety lives:
 * the happy path is one jittered write through the funnel, and every hazard is a guard that must
 * fire AND count itself. A silent skip and a working accelerator look identical in production.
 *
 *   - OWNER-NODE ONLY. The claim floor a lowered due time has to move is a node-local shared
 *     buffer, so a write from a non-owner lowers its own floor (a no-op) and files the row beneath
 *     the owner's. Measured shape of that mistake: 0 rows returned, 23ms.
 *   - THE PAIR MOVES TOGETHER. `util/time.js` seeds jitter off the URL half precisely so a URL's
 *     device variants share a minute; lowering one would leave the other on pre-invalidation
 *     content for up to a full interval, and `processJobResult` reschedules from each render's own
 *     completion, so the de-alignment is permanent, cycle over cycle. No metric would show it.
 *   - NEVER "NOW". Collapsing due times onto one instant is the herd the jitter exists to prevent:
 *     measured, it takes the claim scan from 0.36ms to 11.59ms (32x) and only clears on the store's
 *     next compaction.
 *   - NEVER A KEY THAT CANNOT HEAL. `strikes > 0` is NOT that test: the `discardContent` branch
 *     reschedules at cadence and RESETS strikes to 0 while writing no page, so a key parked there
 *     looks perfectly healthy and can never heal. The test that catches it is arithmetic on the row
 *     already read — `nextRenderTime - interval` is the minute the last render completed.
 *   - THE PER-ROW TESTS STAY PER ROW. "Already sooner" and "already rendered after the epoch" are
 *     properties of ONE device key, and a split pair is a normal production state, so taking either
 *     verdict from the device the crawl arrived on and applying it to the whole URL let the
 *     User-Agent pick which invariant held. Both directions are pinned below.
 *   - NEVER CREATES A TARGET OR A SCHEDULE ROW, and never raises a due time.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T0 = 1_700_000_400_000;

const OWNED = 'https://www.example.com/product/prd-owned';
const SITEMAP = 'https://www.example.com/sitemap.xml';

let accelerator, funnel, config, QueueState, getResidencyByUrl, collectConfigWarnings, getInitialRenderTime;
let PRERENDER, PASSTHROUGH, UNCLASSIFIED;

const schedule = new Map();
const targets = new Map();
const sabs = new Map();
let analytics = [];
let errors = [];
let nowMs = T0;
const realDateNow = Date.now;

/** Enough of a Harper resource for point reads and puts, with the array-select projection. */
const makeTable = (rows) =>
	class FakeTable {
		static async get(query) {
			const id = typeof query === 'object' ? query.id : query;
			const row = rows.get(id);
			if (!row) return null;
			const select = typeof query === 'object' ? query.select : undefined;
			if (typeof select === 'string') return row[select];
			if (Array.isArray(select)) return Object.fromEntries(select.map((name) => [name, row[name]]));
			return { ...row };
		}
		static async put(id, data) {
			rows.set(id, { ...data });
		}
		static async patch(id, data) {
			rows.set(id, { ...(rows.get(id) ?? {}), ...data });
		}
		static async delete(id) {
			return rows.delete(id);
		}
	};

before(async () => {
	Date.now = () => nowMs;
	globalThis.Resource = class {};
	globalThis.server = {
		hostname: 'node-a',
		// A second node, so residency has something to route away from — the not-owner guard is not
		// testable on a single-node cluster.
		nodes: [{ name: 'node-b' }],
		config: { http: { port: 9926 } },
		recordAnalytics: (...args) => analytics.push(args),
	};
	globalThis.logger = { info() {}, warn() {}, error: (e) => errors.push(String(e?.message ?? e)) };
	globalThis.databases = {
		coordination: {
			SharedBuffer: {
				primaryStore: {
					// KEYED: the lease table, the queue-status flag and the accelerator's rate window all
					// acquire from this store under different names. An unkeyed fake hands each its own
					// zeroed buffer and the rate-limit assertions would pass for the wrong reason.
					getUserSharedBuffer: (key, buf) => {
						if (!sabs.has(key)) sabs.set(key, buf);
						return sabs.get(key);
					},
					tryLock: () => true,
					unlock() {},
				},
			},
		},
		render_service: {
			Target: makeTable(targets),
			QueueControl: makeTable(new Map()),
			QueueStatus: makeTable(new Map()),
		},
		render_schedule: { RenderSchedule: makeTable(schedule) },
		page_cache: { PrerenderedPage: makeTable(new Map()) },
	};

	({ config, collectConfigWarnings } = await import('../src/config.js'));
	({ QueueState } = await import('../src/resources/QueueState.js'));
	({ getResidencyByUrl } = await import('../src/util/residency.js'));
	({ getInitialRenderTime } = await import('../src/util/time.js'));
	({ PRERENDER, PASSTHROUGH, UNCLASSIFIED } = await import('../src/util/routeClass.js'));
	funnel = await import('../src/util/renderSchedule.js');
	accelerator = await import('../src/util/invalidationReenqueue.js');
});

after(() => {
	Date.now = realDateNow;
});

beforeEach(() => {
	schedule.clear();
	targets.clear();
	analytics = [];
	errors = [];
	nowMs = T0;
	config.invalidation.enabled = true;
	config.invalidation.reenqueue.enabled = true;
	config.invalidation.reenqueue.spreadWindow = 15 * MINUTE;
	config.invalidation.reenqueue.maxPerMinute = 10;
	config.queue.jobLeaseTime = 10 * MINUTE;
	config.render.failureRetry.fastRetries = 2;
	// Shared buffers outlive the map clears above: without these the floor, the leases and the rate
	// window all leak into the next test.
	funnel.resetRenderQueueState();
	accelerator.resetReenqueueRateWindow();
	QueueState.reportStatus('empty', true);
});

/**
 * A URL this node owns, and one it does not — ASKED of residency rather than hardcoded. HRW hashing
 * over `[node-a, node-b]` decides which, so a fixture URL pinned by hand silently becomes a
 * not-owner test the day the hash or the node names change.
 */
const probeUrls = (owned, count = 1) => {
	const found = [];
	for (let i = 0; i < 2000 && found.length < count; i++) {
		const url = `${OWNED}-${i}`;
		if ((getResidencyByUrl(url) === 'node-a') === owned) found.push(url);
	}
	assert.equal(found.length, count, `no ${owned ? 'owned' : 'foreign'} URL in the probe set`);
	return found;
};
const ownedUrl = () => probeUrls(true, 1)[0];
const foreignUrl = () => probeUrls(false, 1)[0];

const keysOf = (url) => [`${url}|desktop`, `${url}|mobile`];

/**
 * A healthy accelerable key: a target with no strikes, and both device rows due one interval out
 * from a render that completed BEFORE the epoch.
 */
const seed = (url, { strikes = 0, sitemapUrl = null, lastCompleted = nowMs - 3 * HOUR, devices = 2 } = {}) => {
	targets.set(url, { url, strikes, sitemapUrl, renderInterval: null });
	for (const key of keysOf(url).slice(0, devices)) {
		schedule.set(key, { nextRenderTime: lastCompleted + DAY, fromSitemap: !!sitemapUrl });
	}
};

/** The verdict `resolveServeStatus` hands the serve path: `at` already includes `invalidation.pad`. */
const epoch = (at = nowMs - HOUR) => ({ scope: 'all', at });

const outcomes = () =>
	// invalidation_reenqueue is a prerender_ops series: (true, 'prerender_ops', series, outcome, scope)
	analytics.filter(([, , series]) => series === 'invalidation_reenqueue').map(([, , , outcome]) => outcome);

test('an owner-node request lowers every device key of the URL to the same jittered minute', async () => {
	const url = ownedUrl();
	seed(url);

	const result = await accelerator.accelerateHeal({ url, cacheKey: keysOf(url)[0], invalidatedBy: epoch() });

	assert.equal(result.outcome, 'lowered');
	assert.deepEqual(result.written.sort(), keysOf(url).sort(), 'both device keys, not just the one the bot asked for');
	const written = keysOf(url).map((key) => Number(schedule.get(key).nextRenderTime));
	assert.equal(written[0], written[1], 'the device variants share one minute (util/time.js’s invariant)');
	assert.equal(written[0], result.dueAt);
	assert.ok(result.dueAt >= nowMs - MINUTE, 'never in the past — a due time below the floor is never read again');
	assert.ok(result.dueAt < nowMs + 15 * MINUTE + MINUTE, 'inside the spread window');
	assert.equal(result.watermarkLowered, true);
	assert.deepEqual(outcomes(), ['lowered']);
});

test('the due time is spread across the window, not collapsed onto the current minute', async () => {
	const minutes = new Set();
	for (let i = 0; i < 40; i++) {
		const url = `https://www.example.com/spread-${i}`;
		if (getResidencyByUrl(url) !== 'node-a') continue;
		seed(url);
		const result = await accelerator.accelerateHeal({ url, cacheKey: keysOf(url)[0], invalidatedBy: epoch() });
		if (result.outcome === 'throttled') break;
		assert.equal(result.outcome, 'lowered');
		minutes.add(result.dueAt);
	}
	assert.ok(minutes.size >= 4, `expected the writes to be spread over several minutes, got ${minutes.size}`);
	assert.ok(
		!(minutes.size === 1 && [...minutes][0] === Math.floor(nowMs / MINUTE) * MINUTE),
		'a pile at the current minute is the 32x claim-scan regression this jitter exists to prevent'
	);
});

test('a key another node owns is refused as not-owner — a cross-node write cannot lower the owner’s floor', async () => {
	const url = foreignUrl();
	seed(url);

	const result = await accelerator.accelerateHeal({ url, cacheKey: keysOf(url)[0], invalidatedBy: epoch() });

	assert.equal(result.outcome, 'not-owner');
	assert.equal(result.owner, 'node-b');
	assert.deepEqual(outcomes(), ['not-owner']);
	assert.equal(Number(schedule.get(keysOf(url)[0]).nextRenderTime), nowMs - 3 * HOUR + DAY, 'nothing written');
});

test('a paused node accelerates nothing', async () => {
	const url = ownedUrl();
	seed(url);
	QueueState.reportStatus('paused');

	const result = await accelerator.accelerateHeal({ url, cacheKey: keysOf(url)[0], invalidatedBy: epoch() });

	assert.equal(result.outcome, 'paused');
	assert.deepEqual(outcomes(), ['paused']);
});

test('a key with a live claim lease is refused rather than re-armed under the render in flight', async () => {
	const url = ownedUrl();
	seed(url);
	// The lease lives in THIS node's buffer, which is exactly why the owner-only guard makes this
	// check exact: grant the sibling device, not the requested one, and it must still refuse.
	funnel.leaseTable().grant(keysOf(url)[1], { dueMinute: 1, leaseExpiryMs: nowMs + 5 * MINUTE });

	const result = await accelerator.accelerateHeal({ url, cacheKey: keysOf(url)[0], invalidatedBy: epoch() });

	assert.equal(result.outcome, 'leased');
	assert.equal(result.leasedKey, keysOf(url)[1]);
	assert.deepEqual(outcomes(), ['leased']);
});

test('a missing schedule row and a missing target are both refused — neither is ever created', async () => {
	const url = ownedUrl();

	// No schedule row at all (the terminal schedule-gap state reconcile repairs), target present.
	targets.set(url, { url, strikes: 0, sitemapUrl: null, renderInterval: null });
	const noSchedule = await accelerator.accelerateHeal({ url, cacheKey: keysOf(url)[0], invalidatedBy: epoch() });
	assert.equal(noSchedule.outcome, 'no-schedule');
	assert.equal(schedule.size, 0, 'a schedule row with no target is the render-now one-off shape');

	// Rows present, target gone (a suppression deletion, or a delete this crawl has not caught up with).
	schedule.clear();
	targets.clear();
	for (const key of keysOf(url)) schedule.set(key, { nextRenderTime: nowMs + DAY, fromSitemap: false });
	const noTarget = await accelerator.accelerateHeal({ url, cacheKey: keysOf(url)[0], invalidatedBy: epoch() });
	assert.equal(noTarget.outcome, 'no-target');
	assert.equal(targets.size, 0, 'no Target invented from a serve-path side effect');
	assert.deepEqual(
		keysOf(url).map((key) => Number(schedule.get(key).nextRenderTime)),
		[nowMs + DAY, nowMs + DAY],
		'and no due time moved'
	);
	assert.deepEqual(outcomes(), ['no-schedule', 'no-target']);
});

test('only the device rows that exist are written — a missing sibling is not created', async () => {
	const url = ownedUrl();
	seed(url, { devices: 1 });

	const result = await accelerator.accelerateHeal({ url, cacheKey: keysOf(url)[0], invalidatedBy: epoch() });

	assert.equal(result.outcome, 'lowered');
	assert.deepEqual(result.written, [keysOf(url)[0]]);
	assert.equal(
		schedule.size,
		1,
		'the sibling row stays absent for reconcile to repair, not for a serve path to invent'
	);
});

test('a target past fastRetries is refused as unhealable', async () => {
	const url = ownedUrl();
	seed(url, { strikes: 3 });

	const result = await accelerator.accelerateHeal({ url, cacheKey: keysOf(url)[0], invalidatedBy: epoch() });

	assert.equal(result.outcome, 'unhealable');
	assert.equal(result.reason, 'strikes');
	assert.deepEqual(outcomes(), ['unhealable']);
});

test('a render that COMPLETED after the epoch and still did not heal the key is refused (strikes 0 is not the test)', async () => {
	const url = ownedUrl();
	// The discardContent shape: outcome 'rendered', so it rescheduled at cadence AND reset strikes to
	// 0 — while writing no page. The row therefore says a render completed 10 minutes AFTER the epoch,
	// and the page the serve path just refused is still pre-epoch. Nothing can heal this key.
	seed(url, { strikes: 0, lastCompleted: nowMs - 50 * MINUTE });
	const at = nowMs - HOUR;

	const result = await accelerator.accelerateHeal({ url, cacheKey: keysOf(url)[0], invalidatedBy: epoch(at) });

	assert.equal(result.outcome, 'unhealable');
	assert.equal(result.reason, 'rendered-after-epoch');
	assert.deepEqual(outcomes(), ['unhealable']);

	// One minute the OTHER side of the epoch and it is a normal acceleration: the boundary is the
	// epoch (pad included), not the presence of strikes.
	schedule.clear();
	targets.clear();
	analytics = [];
	seed(url, { strikes: 0, lastCompleted: at - MINUTE });
	const healable = await accelerator.accelerateHeal({ url, cacheKey: keysOf(url)[0], invalidatedBy: epoch(at) });
	assert.equal(healable.outcome, 'lowered');
});

test('a due time already sooner than the jittered time is never raised', async () => {
	const url = ownedUrl();
	seed(url);
	// Overdue by an hour — the normal state for a key waiting behind a backlog. Accelerating would
	// push it 0-15 minutes into the FUTURE, which is a delay dressed up as a repair.
	for (const key of keysOf(url)) schedule.set(key, { nextRenderTime: nowMs - HOUR, fromSitemap: false });

	const result = await accelerator.accelerateHeal({ url, cacheKey: keysOf(url)[0], invalidatedBy: epoch() });

	assert.equal(result.outcome, 'not-sooner');
	assert.equal(result.earliest, nowMs - HOUR);
	assert.deepEqual(
		keysOf(url).map((key) => Number(schedule.get(key).nextRenderTime)),
		[nowMs - HOUR, nowMs - HOUR]
	);
});

test('a split pair lowers the sibling that can be pulled forward instead of vetoing the whole URL', async () => {
	const url = ownedUrl();
	seed(url);
	const [desktop, mobile] = keysOf(url);
	// A SPLIT PAIR, which is a normal production state: `revalidateUrl` and `renderNow` each write ONE
	// device key on purpose, and every per-device retry lane diverges the pair by its own delay. Here
	// desktop sits overdue behind the measured 3.05h claim backlog while mobile is 20h out.
	schedule.set(desktop, { nextRenderTime: nowMs - 2 * HOUR, fromSitemap: false });
	schedule.set(mobile, { nextRenderTime: nowMs + 20 * HOUR, fromSitemap: false });

	// The crawl arrives on mobile — the device whose page the invalidation just cost a serve.
	const result = await accelerator.accelerateHeal({ url, cacheKey: mobile, invalidatedBy: epoch() });

	assert.equal(result.outcome, 'lowered', 'an overdue SIBLING must not refuse the key the request was about');
	assert.deepEqual(result.written, [mobile]);
	assert.deepEqual(result.skipped, [desktop], 'and the partial fan-out is reported, since `lowered` cannot say it');
	assert.equal(Number(schedule.get(mobile).nextRenderTime), result.dueAt);
	assert.equal(
		Number(schedule.get(desktop).nextRenderTime),
		nowMs - 2 * HOUR,
		'the overdue row keeps its place in the claim order — a lowering that raised it would be a delay ' +
			'dressed up as a repair, and aligning DOWN onto it would drag this node’s claim floor back two hours'
	);
});

test('an unhealable device row is skipped, not promoted into a verdict on the whole URL', async () => {
	const url = ownedUrl();
	seed(url);
	const [desktop, mobile] = keysOf(url);
	const at = nowMs - HOUR;
	// Desktop took the discardContent shape: its row says a render completed 10 minutes AFTER the epoch
	// and wrote no page, so nothing can heal that key. Mobile last completed 3h ago and can.
	const rows = () => {
		schedule.set(desktop, { nextRenderTime: at + 10 * MINUTE + DAY, fromSitemap: false });
		schedule.set(mobile, { nextRenderTime: nowMs - 3 * HOUR + DAY, fromSitemap: false });
	};

	// WHICHEVER DEVICE THE BOT USED. Served on mobile, a whole-URL verdict re-armed the desktop row a
	// desktop crawl would have been refused (I11 lost); served on desktop, it refused the mobile key
	// that can still heal.
	for (const servedOn of [mobile, desktop]) {
		analytics = [];
		rows();
		const result = await accelerator.accelerateHeal({ url, cacheKey: servedOn, invalidatedBy: epoch(at) });

		assert.equal(result.outcome, 'lowered', `served on ${servedOn}`);
		assert.deepEqual(result.written, [mobile], `served on ${servedOn}`);
		assert.equal(
			Number(schedule.get(desktop).nextRenderTime),
			at + 10 * MINUTE + DAY,
			'the unhealable row is left where it is — re-arming it re-renders on every crawl forever'
		);
	}
});

test('the minute budget is spent where the write lands, and the window never rolls backwards', async () => {
	config.invalidation.reenqueue.maxPerMinute = 1;
	const urls = probeUrls(true, 3);
	for (const url of urls) seed(url);
	const spend = async (url) =>
		(await accelerator.accelerateHeal({ url, cacheKey: keysOf(url)[0], invalidatedBy: epoch() })).outcome;

	assert.equal(await spend(urls[0]), 'lowered', 'the minute’s single slot');

	// A STRAGGLER'S MINUTE — older than the one that spent the budget. Requests straddling a boundary
	// legitimately arrive carrying both, so a window that rolls on `!==` rather than `>` lets the older
	// one zero the counter and hand the whole budget out again, repeatedly, inside one minute.
	nowMs -= MINUTE;
	assert.equal(await spend(urls[1]), 'throttled', 'the window is monotonic: a backwards minute never refills it');
	nowMs += MINUTE;

	// And the minute is sampled where the slot is SPENT, not at entry: the awaited reads before it can
	// carry a request into the next minute, and that is the minute whose budget it consumes.
	const Target = globalThis.databases.render_service.Target;
	const realGet = Target.get;
	Target.get = async (query) => {
		nowMs += MINUTE;
		return realGet.call(Target, query);
	};
	try {
		assert.equal(await spend(urls[2]), 'lowered', 'a request whose reads crossed the boundary spends the NEW minute');
	} finally {
		Target.get = realGet;
	}
});

test('the per-node budget is shared across workers, counts requests, and refills on the next minute', async () => {
	config.invalidation.reenqueue.maxPerMinute = 2;
	const urls = probeUrls(true, 3);
	for (const url of urls) seed(url);

	const results = [];
	for (const url of urls) {
		results.push((await accelerator.accelerateHeal({ url, cacheKey: keysOf(url)[0], invalidatedBy: epoch() })).outcome);
	}
	assert.deepEqual(results, ['lowered', 'lowered', 'throttled'], 'the third request in the minute is refused');
	assert.deepEqual(outcomes(), ['lowered', 'lowered', 'throttled']);

	// The window is minute-bucketed, not a leaky bucket: the next minute is a fresh budget.
	nowMs += MINUTE;
	const afterRollover = await accelerator.accelerateHeal({
		url: urls[2],
		cacheKey: keysOf(urls[2])[0],
		invalidatedBy: epoch(),
	});
	assert.equal(afterRollover.outcome, 'lowered');
});

test('a refusal does not spend the budget — one hot unhealable URL cannot starve the healable ones', async () => {
	config.invalidation.reenqueue.maxPerMinute = 1;
	const [hot, healable] = probeUrls(true, 2);
	seed(hot, { strikes: 9 });

	for (let i = 0; i < 5; i++) {
		const refused = await accelerator.accelerateHeal({ url: hot, cacheKey: keysOf(hot)[0], invalidatedBy: epoch() });
		assert.equal(refused.outcome, 'unhealable');
	}

	seed(healable);
	const result = await accelerator.accelerateHeal({
		url: healable,
		cacheKey: keysOf(healable)[0],
		invalidatedBy: epoch(),
	});
	assert.equal(result.outcome, 'lowered', 'the minute’s single slot was still there for the key that can heal');
});

test('fromSitemap is re-supplied from the live target — put replaces the record', async () => {
	const url = ownedUrl();
	// The row's denormalized flag is stale/false; the target is the source of truth.
	seed(url, { sitemapUrl: SITEMAP });
	for (const key of keysOf(url)) schedule.set(key, { ...schedule.get(key), fromSitemap: false });

	const result = await accelerator.accelerateHeal({ url, cacheKey: keysOf(url)[0], invalidatedBy: epoch() });
	assert.equal(result.outcome, 'lowered');

	for (const key of keysOf(url)) {
		assert.equal(schedule.get(key).fromSitemap, true, 'a cleared flag makes the renderer skip a sitemap-listed page');
	}
});

test('the write lowers this node’s claim floor, so the accelerated row is above the seek point', async () => {
	const url = ownedUrl();
	seed(url);
	const leases = funnel.leaseTable();
	// A caught-up node's floor sits AHEAD of the row we are about to file. Without the funnel's
	// lowering, that row would be inserted behind the seek point and never claimed again.
	const aheadMinute = Math.floor(nowMs / MINUTE) + 60;
	assert.equal(leases.advanceFloor(0, aheadMinute), true);

	const result = await accelerator.accelerateHeal({ url, cacheKey: keysOf(url)[0], invalidatedBy: epoch() });

	assert.equal(result.outcome, 'lowered');
	assert.equal(leases.rawFloorMinute(), Math.floor(result.dueAt / MINUTE), 'the floor came down to the batch minimum');
});

test('maybeAccelerateHeal is inert while it is disabled, and while nothing was invalidated', async () => {
	const url = ownedUrl();
	seed(url);
	const invalidatedBy = epoch();
	const call = (extra) =>
		accelerator.maybeAccelerateHeal({ url, cacheKey: keysOf(url)[0], invalidatedBy, routeClass: PRERENDER, ...extra });

	config.invalidation.reenqueue.enabled = false;
	assert.equal(call(), false);

	config.invalidation.reenqueue.enabled = true;
	config.invalidation.enabled = false;
	assert.equal(call(), false);

	config.invalidation.enabled = true;
	assert.equal(
		call({ invalidatedBy: null }),
		false,
		'a served or merely-stale request never reaches the accelerator at all'
	);

	// A PASSTHROUGH route still SERVES from cache — it only never populates one — and nothing retires a
	// URL whose route was flipped out of prerendering, so its target, rows and pages all survive. Gated
	// exactly like `maybeSchedule`, or crawler volume becomes schedule writes on a route the operator
	// took out of the rotation.
	for (const routeClass of [PASSTHROUGH, UNCLASSIFIED, undefined]) {
		assert.equal(call({ routeClass }), false, `routeClass ${String(routeClass)}`);
	}

	assert.deepEqual(outcomes(), [], 'and none of that records a series in a default deployment');
	assert.equal(Number(schedule.get(keysOf(url)[0]).nextRenderTime), nowMs - 3 * HOUR + DAY);
});

test('maybeAccelerateHeal detaches the attempt and swallows a write failure as a counted outcome', async () => {
	const url = ownedUrl();
	seed(url);
	const RenderSchedule = globalThis.databases.render_schedule.RenderSchedule;
	const realPut = RenderSchedule.put;
	RenderSchedule.put = async () => {
		throw new Error('store unavailable');
	};

	try {
		assert.equal(
			accelerator.maybeAccelerateHeal({
				url,
				cacheKey: keysOf(url)[0],
				invalidatedBy: epoch(),
				routeClass: PRERENDER,
			}),
			true
		);
		// POLL, DO NOT SLEEP. `maybeAccelerateHeal` returns synchronously and does its work in a
		// detached `setImmediate` whose body then awaits several reads, so a fixed delay is a race
		// against the machine: a 5ms sleep passed locally and failed in a loaded run. Yielding until
		// the outcome lands is bounded (it fails if the work genuinely never happens) without being
		// timing-dependent.
		for (let i = 0; i < 500 && outcomes().length === 0; i++) {
			await new Promise((resolve) => setImmediate(resolve));
		}
	} finally {
		RenderSchedule.put = realPut;
	}

	assert.deepEqual(outcomes(), ['error'], 'a failed repair is counted, not silent, and never a 500');
	assert.ok(errors.length >= 1);
});

test('every outcome records the scope beside it, so a refusal set is readable per invalidation', async () => {
	const url = ownedUrl();
	seed(url);
	await accelerator.accelerateHeal({
		url,
		cacheKey: keysOf(url)[0],
		invalidatedBy: { scope: 'route:prefix:/product/', at: nowMs - HOUR },
	});
	const [record] = analytics.filter(([, , series]) => series === 'invalidation_reenqueue');
	assert.deepEqual(record, [true, 'prerender_ops', 'invalidation_reenqueue', 'lowered', 'route:prefix:/product/']);
	assert.ok(
		accelerator.REENQUEUE_OUTCOMES.includes(record[3]),
		'the outcome set is closed and exported — §12.4 coverage is not answerable otherwise'
	);
});

test('a spreadWindow below jobLeaseTime is reported by name AND clamped up to the lease', async () => {
	config.invalidation.reenqueue.spreadWindow = MINUTE;

	const finding = collectConfigWarnings().find((f) => f.key === 'invalidation.reenqueue.spreadWindow');
	assert.ok(finding, 'the cross-option assertion is a config finding, not a silent clamp');
	assert.equal(finding.severity, 'warn');
	assert.match(finding.message, /jobLeaseTime/);

	// Clamped: a 1-minute window squeezes this node's whole accelerated stream onto one minute, and a
	// pile of rows at the minute the claim scan seeks is the measured 0.36ms → 11.59ms regression. (It
	// is NOT a lease guard — overwriting a render in flight is refused outright, by the `leased` test.)
	const url = ownedUrl();
	seed(url);
	const result = await accelerator.accelerateHeal({ url, cacheKey: keysOf(url)[0], invalidatedBy: epoch() });
	assert.equal(result.outcome, 'lowered');
	assert.equal(
		result.dueAt,
		getInitialRenderTime(keysOf(url)[0], config.queue.jobLeaseTime),
		'the lease is the window'
	);

	config.invalidation.reenqueue.spreadWindow = 15 * MINUTE;
	assert.equal(
		collectConfigWarnings().some((f) => f.key === 'invalidation.reenqueue.spreadWindow'),
		false
	);
});
