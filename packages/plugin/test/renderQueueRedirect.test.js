import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * processJobResult over the url-keyed Target registry.
 *
 * The properties pinned here:
 *   - Targets are ONE row per URL; put/delete/suppress fan out over the configured devices'
 *     RenderSchedule and PrerenderedPage rows.
 *   - A non-indexable verdict SUPPRESSES the target (state + strikes + recheck schedule,
 *     cached pages dropped) instead of deleting it — and `maxStrikes` consecutive verdicts
 *     delete it outright. A later indexable render lifts the suppression.
 *   - 301/308 onto a served route retires the source URL (row, schedules, pages) and adopts
 *     the destination as a first-class target — due now, inheriting the source's cadence —
 *     never clobbering an existing (or suppressed) destination, and respecting the domain
 *     allowlist.
 *   - 302/303/307 (or a client-side redirect's 200) keeps the source and its cached pages.
 *   - a redirect onto a route class we don't serve keeps the source.
 *   - a targetless source (render-now one-off) has its schedule dropped, not retried forever.
 */

const DESKTOP = 'desktop';
const key = (url, device = DESKTOP) => `${url}|${device}`;
// config.deviceTypes.default — what Target fan-out uses.
const DEVICES = ['desktop', 'mobile'];

const A = 'https://site.example.com/product/old';
const B = 'https://site.example.com/product/new';

// One Map per table for the whole run (the module under test captures the table objects at
// import), cleared between tests.
const stores = {
	target: new Map(),
	renderSchedule: new Map(),
	prerenderedPage: new Map(),
};

let warns = [];
let infos = [];
let analytics = [];

// Minimal stand-in for a Harper table/resource: static get/put/delete dispatch through an
// instance (so Target's put/delete overrides apply, exactly like Harper's Resource), put
// REPLACES the row (that is what makes Target.put a reactivation — omitted suppression
// fields clear), patch merges, and get() honors Harper's select semantics — a STRING select
// returns the bare scalar, an array select builds a record. All are load-bearing.
const makeResourceBase = (rows) =>
	class FakeResource {
		constructor(id) {
			this.__id = id;
		}
		getId() {
			return this.__id;
		}
		async put(data) {
			rows.set(this.__id, { ...data });
		}
		async delete() {
			return rows.delete(this.__id);
		}
		static async get(query) {
			const id = typeof query === 'object' ? query.id : query;
			const row = rows.get(id);
			if (!row) return null;
			const select = typeof query === 'object' ? query.select : undefined;
			if (typeof select === 'string') return row[select];
			if (Array.isArray(select)) {
				const picked = {};
				for (const name of select) picked[name] = row[name];
				return picked;
			}
			return { ...row };
		}
		static async put(id, data) {
			const resource = new this(id);
			return resource.put({ ...data });
		}
		static async patch(id, data) {
			rows.set(id, { ...(rows.get(id) ?? {}), ...data });
		}
		static async delete(id) {
			const resource = new this(id);
			return resource.delete();
		}
		/** Enough of Harper's search for a real claim pass — see the twin in suppressionStatus.test.js. */
		static async *search(query = {}) {
			const [condition] = query.conditions ?? [];
			const floor = condition ? Number(condition.value) : Number.NEGATIVE_INFINITY;
			const matching = [...rows.entries()]
				.map(([cacheKey, row]) => ({ cacheKey, ...row }))
				.filter((row) => Number(row.nextRenderTime) >= floor)
				.sort((a, b) => Number(a.nextRenderTime) - Number(b.nextRenderTime))
				.slice(0, query.limit ?? Infinity);
			for (const row of matching) yield row;
		}
	};

let RenderQueue, config, funnel;

// KEYED — QueueState and the render-lease table share this store under different names, and an
// unkeyed fake gives each acquisition its own zeroed buffer, so no lease assertion would mean
// anything.
const sabs = new Map();

before(async () => {
	globalThis.Resource = class {};
	globalThis.server = {
		hostname: 'test-node',
		nodes: [],
		config: { http: { port: 9926 } },
		recordAnalytics: (...args) => analytics.push(args),
	};
	globalThis.logger = {
		debug() {},
		info: (msg) => infos.push(String(msg)),
		warn: (msg) => warns.push(String(msg)),
		error() {},
	};
	globalThis.createBlob = (buf) => buf;
	globalThis.databases = {
		coordination: {
			SharedBuffer: {
				primaryStore: {
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
			Target: makeResourceBase(stores.target),
			QueueControl: makeResourceBase(new Map()),
			// `claim` reports empty/queued, and reporting writes this row.
			QueueStatus: makeResourceBase(new Map()),
		},
		render_schedule: { RenderSchedule: makeResourceBase(stores.renderSchedule) },
		page_cache: { PrerenderedPage: makeResourceBase(stores.prerenderedPage) },
	};

	({ config } = await import('../src/config.js'));
	({ RenderQueue } = await import('../src/resources/RenderQueue.js'));
	funnel = await import('../src/util/renderSchedule.js');
});

beforeEach(() => {
	for (const rows of Object.values(stores)) rows.clear();
	warns = [];
	infos = [];
	analytics = [];
	// The shared buffer OUTLIVES the store clears above, so the leases and the claim floor would
	// otherwise leak from one test into the next.
	funnel.resetRenderQueueState();
});

/** Claim the way the fleet would, so leases are recorded exactly as production records them. */
const claim = (limit = 10) => RenderQueue.claim({ limit });
const leased = (cacheKey) => !!funnel.leaseInfo(cacheKey);

afterEach(() => {
	config.domains = [];
	config.ingress.mode = 'prefix';
	config.ingress.routes = [];
});

/** Post a job result the way the queue endpoint would: metadata buffer (+ optional content). */
const postResult = async (metadata, content) => {
	const meta = Buffer.from(JSON.stringify(metadata), 'utf8');
	const body = content ? Buffer.concat([meta, Buffer.from(content)]) : meta;
	const ctx = { headers: new Map([['x-metadata-size', String(meta.byteLength)]]) };
	await RenderQueue.processJobResult(body, ctx);
};

const seedSource = ({ url = A, renderInterval = 3_600_000, state } = {}) => {
	stores.target.set(url, { url, renderInterval, ...(state ? { state } : {}) });
	for (const device of DEVICES) {
		stores.renderSchedule.set(key(url, device), { nextRenderTime: 1, fromSitemap: false });
		stores.prerenderedPage.set(key(url, device), { statusCode: 200, content: 'old html' });
	}
};

// ---- redirects ----

test('301 onto a served route retires the source URL — all devices — and adopts the destination', async () => {
	seedSource({ renderInterval: 1234567 });
	await postResult({ id: key(A), url: A, statusCode: 301, outcome: 'redirected', redirectedTo: B, renderTime: 42 });

	assert.equal(stores.target.has(A), false, 'source target must be retired');
	for (const device of DEVICES) {
		assert.equal(stores.renderSchedule.has(key(A, device)), false, `${device} schedule must be dropped`);
		assert.equal(stores.prerenderedPage.has(key(A, device)), false, `${device} cached page must be dropped`);
	}

	const adopted = stores.target.get(B);
	assert.ok(adopted, 'destination must become a target of its own');
	assert.equal(adopted.renderInterval, 1234567, 'cadence is inherited — the page moved, its schedule did not');
	assert.notEqual(adopted.state, 'suppressed');

	for (const device of DEVICES) {
		const schedule = stores.renderSchedule.get(key(B, device));
		assert.ok(schedule, `destination must be scheduled for ${device}`);
		assert.ok(schedule.nextRenderTime <= Date.now(), 'due now — the source pages are gone, fill the gap fast');
	}

	// One time_ms sample plus exactly one outcome — the emit-once-per-result contract, both
	// series of the `render` metric: (value, 'render', series, ...detail slots).
	const renderTimes = analytics.filter((a) => a[1] === 'render' && a[2] === 'time_ms');
	assert.equal(renderTimes.length, 1, 'redirect results still record render duration analytics');
	assert.equal(renderTimes[0][4], 'redirect');
	const outcomes = analytics.filter((a) => a[1] === 'render' && a[2] === 'outcome');
	assert.deepEqual(
		outcomes.map((a) => [a[3], a[4]]),
		[['redirect', 'permanent']],
		'exactly one render outcome per posted result'
	);
});

test('a rendered verdict with nothing to store is counted as no-content, not stored', async () => {
	// legacyOutcome calls an isIndexable-only result 'rendered'; the outcome detail must not
	// claim a page was cached when nothing was.
	seedSource();
	await postResult({ id: key(A), url: A, statusCode: 200, outcome: 'rendered', isIndexable: true });
	const outcomes = analytics.filter((a) => a[1] === 'render' && a[2] === 'outcome');
	assert.deepEqual(
		outcomes.map((a) => [a[3], a[4]]),
		[['rendered', 'no-content']]
	);
});

test('301 onto an already-targeted destination adopts nothing and leaves its schedule alone', async () => {
	seedSource();
	stores.target.set(B, { url: B, renderInterval: 999 });
	stores.renderSchedule.set(key(B), { nextRenderTime: 8_888_888_888_888 });

	await postResult({ id: key(A), url: A, statusCode: 301, outcome: 'redirected', redirectedTo: B });

	assert.equal(stores.target.has(A), false, 'source is still retired');
	assert.equal(stores.target.get(B).renderInterval, 999, 'existing destination target untouched');
	assert.equal(
		stores.renderSchedule.get(key(B)).nextRenderTime,
		8_888_888_888_888,
		'existing destination cadence must not be perturbed'
	);
});

test('301 onto a SUPPRESSED destination does not resurrect it', async () => {
	seedSource();
	stores.target.set(B, { url: B, state: 'suppressed', suppressedReason: 'noindex', strikes: 2 });

	await postResult({ id: key(A), url: A, statusCode: 301, outcome: 'redirected', redirectedTo: B });

	assert.equal(stores.target.has(A), false, 'the source still retires — the move is real');
	assert.equal(stores.target.get(B).state, 'suppressed', 'a render verdict outranks a redirect pointing at it');
	assert.equal(stores.target.get(B).strikes, 2, 'the verdict record is untouched');
});

test('temporary redirect (302) keeps the source — target, cached pages — and retries next interval', async () => {
	seedSource({ renderInterval: 60_000 });
	const before = Date.now();
	await postResult({ id: key(A), url: A, statusCode: 302, outcome: 'redirected', redirectedTo: B });

	assert.ok(stores.target.has(A), 'a failover bounce must not retire the target');
	assert.ok(stores.prerenderedPage.has(key(A)), 'the cached page keeps serving while the redirect heals');
	assert.equal(stores.target.has(B), false, 'a temporary destination is not adopted');

	const schedule = stores.renderSchedule.get(key(A));
	// nextRenderTime is minute-floored "now" + interval.
	const flooredBefore = Math.floor(before / 60_000) * 60_000;
	assert.ok(
		schedule.nextRenderTime >= flooredBefore + 60_000 && schedule.nextRenderTime <= Date.now() + 60_000,
		'rescheduled one interval out'
	);
});

test('a targetless source (render-now one-off) has its schedule dropped instead of retrying forever', async () => {
	stores.renderSchedule.set(key(A), { nextRenderTime: 1, fromSitemap: false });
	await claim();
	assert.equal(leased(key(A)), true, 'precondition: claimed under a lease');

	await postResult({ id: key(A), url: A, statusCode: 302, outcome: 'redirected', redirectedTo: B });

	assert.equal(stores.renderSchedule.has(key(A)), false);
	// `deleteSchedule` itself releases nothing (pinned in test/renderQueueFloor.test.js); the single
	// release point at the end of processJobResult frees the slot, which is safe precisely because
	// the row it paced no longer exists.
	assert.equal(leased(key(A)), false);
	assert.deepEqual(await claim(), [], 'and nothing is left to re-claim');
});

test('redirect onto an unrouted path keeps the source and adopts nothing', async () => {
	config.ingress.mode = 'forwarded';
	config.ingress.routes = [{ match: 'prefix', path: '/product/', mode: 'prerender' }];
	seedSource();
	const off = 'https://site.example.com/checkout/thanks';

	await postResult({ id: key(A), url: A, statusCode: 301, outcome: 'redirected', redirectedTo: off });

	assert.ok(stores.target.has(A), 'incomplete route list must not end this URL for good');
	assert.ok(stores.renderSchedule.has(key(A)), 'source stays in rotation');
	assert.equal(stores.target.has(off), false);
});

test('301 to a host outside the domain allowlist is not adopted', async () => {
	config.domains = ['site.example.com'];
	seedSource();
	const foreign = 'https://other.example.net/product/new';

	await postResult({ id: key(A), url: A, statusCode: 301, outcome: 'redirected', redirectedTo: foreign });

	assert.equal(stores.target.has(A), false);
	assert.equal(stores.target.has(foreign), false, 'a foreign host can never be marked indexable');
});

test('outcome=redirected onto a non-indexable landing retires the source and suppresses the destination', async () => {
	seedSource();
	await postResult({
		id: key(A),
		url: A,
		statusCode: 200, // client-side redirect: no HTTP hop status
		outcome: 'redirected',
		redirectedTo: B,
		isIndexable: false,
		reason: 'noindex',
	});

	assert.equal(stores.target.has(A), false, 'the source leads to a dead page — retire it');
	const destination = stores.target.get(B);
	assert.equal(destination?.state, 'suppressed', 'the destination verdict is recorded as a suppressed target');
	assert.equal(destination?.suppressedReason, 'noindex');
	assert.equal(destination?.strikes, 1);
});

test('outcome=redirected without permanence (client-side, 200) keeps the source', async () => {
	seedSource();
	await postResult({ id: key(A), url: A, statusCode: 200, outcome: 'redirected', redirectedTo: B });

	assert.ok(stores.target.has(A), 'no proof of permanence — the source stays');
	assert.ok(stores.renderSchedule.has(key(A)), 'and stays scheduled');
	assert.equal(stores.target.has(B), false);
});

// ---- rendered ----

test('outcome=rendered stores the page and reschedules', async () => {
	seedSource({ renderInterval: 60_000 });
	await postResult(
		{ id: key(A), url: A, statusCode: 200, outcome: 'rendered', isIndexable: true, headers: {} },
		'<html>fresh</html>'
	);

	const page = stores.prerenderedPage.get(key(A));
	assert.ok(page, 'content must be stored');
	assert.equal(page.isIndexable, true);
	assert.ok(stores.renderSchedule.get(key(A)).nextRenderTime > Date.now(), 'rescheduled one interval out');
});

// ---- route-typed render cadence ----

const HOUR_MS = 3_600_000;

test('outcome=rendered reschedules at the matched route renderInterval, beating the stored one', async () => {
	config.ingress.routes = [{ match: 'prefix', path: '/product/', renderInterval: 6 * HOUR_MS }];
	seedSource({ renderInterval: 24 * HOUR_MS });
	const before = Date.now();
	await postResult(
		{ id: key(A), url: A, statusCode: 200, outcome: 'rendered', isIndexable: true, headers: {} },
		'<html>fresh</html>'
	);

	const schedule = stores.renderSchedule.get(key(A));
	// ≈ now + 6h (minute-floored), NOT now + the stored 24h — route cadence is retroactive.
	assert.ok(schedule.nextRenderTime >= before + 6 * HOUR_MS - 60_000, 'due no earlier than ~6h out');
	assert.ok(schedule.nextRenderTime < before + 7 * HOUR_MS, 'stored 24h interval must not win');
	assert.equal(
		stores.prerenderedPage.get(key(A)).expiresAt,
		schedule.nextRenderTime,
		'page expiry stays coupled to the next render'
	);
});

test('outcome=rendered keeps the stored interval when the matched route sets no cadence', async () => {
	config.ingress.routes = [{ match: 'prefix', path: '/product/' }];
	seedSource({ renderInterval: 2 * HOUR_MS });
	const before = Date.now();
	await postResult(
		{ id: key(A), url: A, statusCode: 200, outcome: 'rendered', isIndexable: true, headers: {} },
		'<html>fresh</html>'
	);

	const schedule = stores.renderSchedule.get(key(A));
	assert.ok(schedule.nextRenderTime >= before + 2 * HOUR_MS - 60_000, 'stored cadence still drives');
	assert.ok(schedule.nextRenderTime < before + 3 * HOUR_MS, 'default must not win over a valid stored interval');
});

test('outcome=rendered with a landed URL that keys elsewhere keeps the refile semantics', async () => {
	seedSource();
	await postResult(
		{ id: key(A), url: A, statusCode: 200, outcome: 'rendered', isIndexable: true, redirectedTo: B, headers: {} },
		'<html>landed</html>'
	);

	assert.equal(stores.target.has(A), false, 'source target retired by the refile');
	for (const device of DEVICES) {
		assert.equal(stores.renderSchedule.has(key(A, device)), false, `${device} schedule retired with it`);
	}
	assert.ok(stores.prerenderedPage.get(key(B)), 'content filed under the landed key');
});

// ---- suppression lifecycle ----

test('a non-indexable verdict suppresses the target: state, strikes, recheck schedule, pages dropped', async () => {
	seedSource({ renderInterval: 60_000 });
	const before = Date.now();
	await postResult({
		id: key(A),
		url: A,
		statusCode: 200,
		outcome: 'non-indexable',
		isIndexable: false,
		reason: 'noindex',
	});

	const target = stores.target.get(A);
	assert.ok(target, 'the target must NOT be deleted — suppression replaces deletion');
	assert.equal(target.state, 'suppressed');
	assert.equal(target.suppressedReason, 'noindex');
	assert.equal(target.strikes, 1);
	assert.equal(target.renderInterval, 60_000, 'the cadence survives for when it heals');

	for (const device of DEVICES) {
		assert.equal(stores.prerenderedPage.has(key(A, device)), false, `${device} cached page must be dropped`);
		const schedule = stores.renderSchedule.get(key(A, device));
		assert.ok(
			schedule.nextRenderTime >= before + config.render.suppression.recheckInterval - 60_000,
			`${device} rescheduled at the recheck interval, not the render interval`
		);
	}
	// info, not warn, since the log relevel: a suppression is a normal verdict, and the
	// alertable aggregate is the render_outcome counter (asserted below).
	assert.ok(
		infos.some((w) => w.includes('Suppressing') && w.includes('(noindex)')),
		`expected a suppression info line naming the reason, got: ${infos.join(' | ')}`
	);
	assert.ok(
		analytics.some((a) => a[1] === 'render' && a[2] === 'outcome' && a[3] === 'suppressed' && a[4] === 'noindex'),
		'the suppression is counted with its reason'
	);
});

test('maxStrikes consecutive non-indexable verdicts delete the target outright', async () => {
	seedSource();
	for (let i = 0; i < config.render.suppression.maxStrikes; i++) {
		await postResult({
			id: key(A),
			url: A,
			statusCode: 200,
			outcome: 'non-indexable',
			isIndexable: false,
			reason: 'noindex',
		});
	}

	assert.equal(stores.target.has(A), false, 'strike limit reached — the target is gone');
	for (const device of DEVICES) {
		assert.equal(stores.renderSchedule.has(key(A, device)), false, 'and its schedules with it');
	}
});

test('an indexable render lifts a suppression', async () => {
	seedSource({ state: 'suppressed' });
	stores.target.get(A).suppressedReason = 'noindex';
	stores.target.get(A).strikes = 2;

	await postResult(
		{ id: key(A), url: A, statusCode: 200, outcome: 'rendered', isIndexable: true, headers: {} },
		'<html>healed</html>'
	);

	const target = stores.target.get(A);
	assert.equal(target.state, null, 'back in normal rotation');
	assert.equal(target.strikes, 0, 'the strike count resets — a heal is a heal');
	assert.ok(stores.prerenderedPage.get(key(A)), 'the healed content is cached');
});

test('a verdict for a URL nothing targeted creates the suppression row (render-now, redirect landings)', async () => {
	stores.renderSchedule.set(key(A), { nextRenderTime: 1 });
	await postResult({
		id: key(A),
		url: A,
		statusCode: 200,
		outcome: 'non-indexable',
		isIndexable: false,
		reason: 'canonical-mismatch',
	});

	const target = stores.target.get(A);
	assert.equal(target?.state, 'suppressed', 'the verdict must outlive the one-off render');
	assert.equal(target?.suppressedReason, 'canonical-mismatch');
});

// ---- errors ----

test('outcome=error leaves a target-backed job for the lease to retry', async () => {
	// THE SECOND FAST-LANE-BY-OMISSION, and the branch every renderer crash, timeout, ProtocolError
	// and settle failure lands in — i.e. the highest-volume failure path in production. It writes no
	// schedule row at all, so its pacing was ENTIRELY the lease sitting in `nextRenderTime`. With the
	// lease out of the row, "schedule untouched" stays true whether or not the lease is held, and
	// without the hold the row keeps its overdue due time and the fleet re-renders the failing page as
	// fast as it can claim it. The lease assertions below are the only thing that catches that.
	seedSource();
	await claim();
	const scheduleBefore = stores.renderSchedule.get(key(A));
	await postResult({
		id: key(A),
		url: A,
		outcome: 'error',
		reason: 'error',
		error: { name: 'ProtocolError', message: 'Target closed' },
	});

	assert.ok(stores.target.has(A), 'an error must never retire the target');
	assert.equal(stores.renderSchedule.get(key(A)), scheduleBefore, 'schedule untouched — the lease drives the retry');
	assert.equal(leased(key(A)), true, 'the lease must be HELD');
	assert.deepEqual(await claim(), [], 'so there is no immediate re-claim');

	// `+ 2s`: expiries are stored in whole seconds, rounded UP, so a lease is never shorter than
	// jobLeaseTime.
	const originalNow = Date.now;
	try {
		Date.now = () => originalNow() + config.queue.jobLeaseTime + 2_000;
		const afterExpiry = await claim();
		assert.equal(
			afterExpiry.filter((job) => job.id === key(A)).length,
			1,
			'and the retry arrives on lease expiry, exactly once'
		);
	} finally {
		Date.now = originalNow;
	}

	assert.ok(
		warns.some((w) => w.includes('ProtocolError')),
		`expected the posted error in the failure warn, got: ${warns.join(' | ')}`
	);
});

test('a rendered client-side redirect releases the lease held under result.id, not the destination key', async () => {
	// `processJobResult` re-points `cacheKey` at the redirect destination for the refile. Releasing by
	// that would leak the SOURCE's lease on every such result — and the source row, still carrying its
	// old due time, would then pin the claim floor for a whole lease, every cycle, forever.
	seedSource();
	await claim();
	assert.equal(leased(key(A)), true);

	await postResult(
		{ id: key(A), url: A, statusCode: 200, outcome: 'rendered', isIndexable: true, redirectedTo: B, headers: {} },
		'<html>landed</html>'
	);

	assert.equal(leased(key(A)), false, 'the SOURCE lease — the one that was actually granted — is released');
	assert.equal(leased(key(B)), false, 'and no lease is invented for the destination');
});

test('a job_result with an unusable x-metadata-size is a legible 400, not a mystery 500', async () => {
	// `subarray(0, NaN)` yields an empty buffer and `JSON.parse('')` throws, which surfaced as a bare
	// 500. Nothing can be recovered — without a decoded id there is not even a lease to release, so
	// the render's lease simply expires and the job is re-granted.
	const body = Buffer.from('{"id":"x"}', 'utf8');
	for (const size of [undefined, 'abc', '0', '99999']) {
		const ctx = { headers: new Map(size === undefined ? [] : [['x-metadata-size', size]]) };
		const response = await RenderQueue.processJobResult(body, ctx);
		assert.equal(response?.status, 400, `x-metadata-size "${size}" must be refused with a 400`);
	}
});

// ---- legacy results (no outcome posted — pre-1.16 browsers, inferred by legacyOutcome) ----

test('a legacy 301 result (no outcome field) still lands in the redirect branch', async () => {
	seedSource();
	await postResult({ id: key(A), url: A, statusCode: 301, redirectedTo: B });

	assert.equal(stores.target.has(A), false);
	assert.ok(stores.target.get(B), 'destination adopted from the inferred outcome');
});

test('a legacy non-indexable result (no outcome field) still suppresses', async () => {
	seedSource();
	await postResult({ id: key(A), url: A, statusCode: 200, isIndexable: false, reason: 'noindex' });

	assert.equal(stores.target.get(A)?.state, 'suppressed');
});

// ---- redirect strikes (a source that keeps redirecting is retired) ----

test('a temp redirect strikes the source but keeps it (and its cached page) below maxStrikes', async () => {
	seedSource();
	await postResult({ id: key(A), url: A, statusCode: 302, outcome: 'redirected', redirectedTo: B });

	const target = stores.target.get(A);
	assert.ok(target, 'source survives a first temp redirect');
	assert.equal(target.strikes, 1, 'but the strike is recorded');
	assert.equal(stores.prerenderedPage.get(key(A)).content, 'old html', 'cached page keeps serving');
	assert.ok(stores.renderSchedule.get(key(A)).nextRenderTime > Date.now(), 'retry scheduled at cadence');
});

test('maxStrikes consecutive temp redirects retire the source outright', async () => {
	const max = config.render.redirects.maxStrikes;
	seedSource();
	stores.target.get(A).strikes = max - 1;

	await postResult({ id: key(A), url: A, statusCode: 302, outcome: 'redirected', redirectedTo: B });

	assert.equal(stores.target.has(A), false, 'source retired — the temporary status was a lie');
	for (const device of DEVICES) {
		assert.equal(stores.renderSchedule.has(key(A, device)), false, `${device} schedule dropped`);
		assert.equal(
			stores.prerenderedPage.has(key(A, device)),
			false,
			`${device} page dropped (origin serves the redirect)`
		);
	}
	assert.equal(stores.target.has(B), false, 'no adoption from a temp redirect');
});

test('a redirect onto an unserved route class strikes the source too', async () => {
	config.ingress.mode = 'forwarded'; // only forwarded mode classifies unmatched paths as unserved
	config.ingress.routes = [{ match: 'prefix', path: '/product/', mode: 'prerender' }];
	const C = 'https://site.example.com/checkout/cart';
	seedSource();
	await postResult({ id: key(A), url: A, statusCode: 301, outcome: 'redirected', redirectedTo: C });

	const target = stores.target.get(A);
	assert.ok(target, 'source kept — route list may just be incomplete');
	assert.equal(target.strikes, 1, 'but the strike is recorded');
});

test('a successful render clears redirect strikes — only CONSECUTIVE redirects retire', async () => {
	seedSource();
	stores.target.get(A).strikes = 2;

	await postResult(
		{ id: key(A), url: A, statusCode: 200, outcome: 'rendered', isIndexable: true, headers: {}, renderTime: 10 },
		'<html>fresh</html>'
	);

	assert.equal(stores.target.get(A).strikes, 0, 'strikes reset on success');
	assert.notEqual(stores.target.get(A).state, 'suppressed');
});
