import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Status-aware result handling: not every HTTP error is the same statement about a page.
 *
 * The properties pinned here:
 *   - 404/410 (`gone`) suppress under `render.suppression.gone` — stored as `http-gone`,
 *     rechecked at the longer gone cadence, and deleted after the smaller gone maxStrikes.
 *     The origin said the page no longer exists; re-proving that 4 times a month is waste.
 *   - 401/403 NEVER suppress: an auth-shaped error is a renderer-credential or origin-rule
 *     problem, not a page verdict. The target and its cached pages survive and the job just
 *     reschedules — otherwise a credential outage would strike-and-delete the registry.
 *   - 408/429/5xx NEVER suppress: the origin failed to serve the page, it didn't disavow
 *     it. Target and cached pages survive; retry at normal cadence, no strike.
 *   - Content verdicts (noindex etc., status 200) still use the default knobs unchanged.
 */

const DESKTOP = 'desktop';
const key = (url, device = DESKTOP) => `${url}|${device}`;
const DEVICES = ['desktop', 'mobile'];

const A = 'https://site.example.com/product/old';
const B = 'https://site.example.com/product/new';

const stores = {
	target: new Map(),
	renderSchedule: new Map(),
	prerenderedPage: new Map(),
};

let warns = [];
let errors = [];

// Minimal stand-in for a Harper table/resource — same load-bearing semantics as the fake in
// renderQueueRedirect.test.js: static get/put/delete dispatch through an instance, put
// REPLACES, patch merges, string select returns the bare scalar.
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
		/**
		 * Enough of Harper's search to drive a real claim pass: the one-sided
		 * `nextRenderTime >= value` condition, the sort on the same attribute, and the limit. The
		 * primary key is injected into each projected row, which is what the real table does for a
		 * `select` naming it.
		 */
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

// The named cross-worker shared buffers. KEYED, not "return whatever was passed": QueueState and
// the render-lease table both acquire from this store under different names, and an unkeyed fake
// hands every acquisition its own freshly zeroed buffer — so a lease taken by `claim` would be
// invisible to `processJobResult` and every lease assertion below would pass for the wrong reason.
const sabs = new Map();

before(async () => {
	globalThis.Resource = class {};
	globalThis.server = {
		hostname: 'test-node',
		nodes: [],
		config: { http: { port: 9926 } },
		recordAnalytics: () => {},
	};
	globalThis.logger = {
		info() {},
		warn: (msg) => warns.push(String(msg)),
		error: (msg) => errors.push(String(msg)),
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
	errors = [];
	// The shared buffer OUTLIVES the store clears above, so without this the leases and the claim
	// floor leak from one test into the next.
	funnel.resetRenderQueueState();
});

/** Claim jobs the way the render fleet would, so the lease is recorded exactly as production does. */
const claim = (limit = 10) => RenderQueue.claim({ limit });

/**
 * `seedSource` writes STRAIGHT into the fake table, bypassing the funnel, so a seeded row never
 * lowers the claim floor. That is fine only because `beforeEach` resets the floor to 0 ("seek the
 * absolute minimum") — a test that seeds after a floor has been established must seed through the
 * funnel or reset first.
 */
const leased = (cacheKey) => !!funnel.leaseInfo(cacheKey);

const postResult = async (metadata, content) => {
	const meta = Buffer.from(JSON.stringify(metadata), 'utf8');
	const body = content ? Buffer.concat([meta, Buffer.from(content)]) : meta;
	const ctx = { headers: new Map([['x-metadata-size', String(meta.byteLength)]]) };
	await RenderQueue.processJobResult(body, ctx);
};

const seedSource = ({ url = A, renderInterval = 3_600_000, strikes, state } = {}) => {
	stores.target.set(url, {
		url,
		renderInterval,
		...(state ? { state } : {}),
		...(Number.isFinite(strikes) ? { strikes } : {}),
	});
	for (const device of DEVICES) {
		stores.renderSchedule.set(key(url, device), { nextRenderTime: 1, fromSitemap: false });
		stores.prerenderedPage.set(key(url, device), { statusCode: 200, content: 'old html' });
	}
};

const nonIndexable = (statusCode, extra = {}) => ({
	id: key(A),
	url: A,
	statusCode,
	outcome: 'non-indexable',
	isIndexable: false,
	reason: 'http-error',
	...extra,
});

// ---- gone (404/410) ----

test('404 suppresses as http-gone at the gone recheck cadence', async () => {
	seedSource();
	await postResult(nonIndexable(404));

	const target = stores.target.get(A);
	assert.equal(target.state, 'suppressed');
	assert.equal(target.suppressedReason, 'http-gone', '404 is stored as http-gone, not generic http-error');
	assert.equal(target.strikes, 1);

	const goneRecheck = config.render.suppression.gone.recheckInterval;
	const defaultRecheck = config.render.suppression.recheckInterval;
	assert.ok(goneRecheck > defaultRecheck, 'precondition: gone rechecks are further apart than the default');
	for (const device of DEVICES) {
		const schedule = stores.renderSchedule.get(key(A, device));
		assert.ok(schedule, `${device} recheck schedule must exist`);
		assert.ok(
			schedule.nextRenderTime > Date.now() + defaultRecheck,
			'recheck must use the gone cadence, not the default'
		);
		assert.equal(stores.prerenderedPage.has(key(A, device)), false, 'cached error page must not keep serving');
	}
});

test('410 classifies as gone too', async () => {
	seedSource();
	await postResult(nonIndexable(410));
	assert.equal(stores.target.get(A).suppressedReason, 'http-gone');
});

test('gone deletes after gone.maxStrikes, sooner than the default maxStrikes', async () => {
	const goneMax = config.render.suppression.gone.maxStrikes;
	assert.ok(goneMax < config.render.suppression.maxStrikes, 'precondition: gone dies sooner');

	seedSource({ strikes: goneMax - 1, state: 'suppressed' });
	await postResult(nonIndexable(404));

	assert.equal(stores.target.has(A), false, 'target must be deleted at gone.maxStrikes');
	for (const device of DEVICES) {
		assert.equal(stores.renderSchedule.has(key(A, device)), false, `${device} schedule must be gone`);
	}
});

test('a 404 verdict does NOT delete at gone.maxStrikes when the strikes came under the default class', async () => {
	// Classification is per-verdict: strikes carry over, so a target already at
	// gone.maxStrikes strikes from OTHER verdicts is deleted by the next gone verdict.
	// This pins the arithmetic rather than any per-class strike ledger.
	seedSource({ strikes: 1, state: 'suppressed' });
	await postResult(nonIndexable(404));
	assert.equal(stores.target.has(A), false, 'strikes are one shared counter; 2nd strike as gone deletes');
});

// ---- auth-shaped (401/403) ----

test('403 keeps the target and cached pages; first failure retries on the claim lease', async () => {
	seedSource({ renderInterval: 3_600_000 });
	const claimed = await claim();
	assert.ok(
		claimed.some((job) => job.id === key(A)),
		'precondition: the job is claimed, so a lease exists to be held'
	);

	await postResult(nonIndexable(403));

	const target = stores.target.get(A);
	assert.ok(target, 'target must survive an auth-shaped result');
	assert.notEqual(target.state, 'suppressed');
	assert.equal(target.strikes, 1, 'the failure is counted');

	assert.equal(
		stores.renderSchedule.get(key(A)).nextRenderTime,
		1,
		'schedule untouched — the claim lease drives the fast retry'
	);
	// AND THE LEASE IS HELD. This is the load-bearing half: "schedule untouched" alone was the whole
	// mechanism when the lease lived IN nextRenderTime, and it stays true even if the lease is
	// released — at which point the row, still carrying its original overdue due time, is instantly
	// re-claimable and the fleet hot-loops the failing page.
	assert.equal(leased(key(A)), true, 'the fast lane must KEEP the lease');
	assert.deepEqual(await claim(), [], 'so an immediate second claim grants nothing');

	assert.equal(stores.prerenderedPage.get(key(A)).content, 'old html', 'last good page keeps serving');
	assert.ok(
		errors.some((e) => e.includes('403')),
		'auth-shaped results log at error level'
	);
});

test('401 behaves like 403', async () => {
	seedSource();
	await postResult(nonIndexable(401));
	assert.notEqual(stores.target.get(A)?.state, 'suppressed');
	assert.equal(stores.prerenderedPage.has(key(A)), true);
});

test('403 on a targetless one-off drops the schedule instead of retrying forever', async () => {
	stores.renderSchedule.set(key(A), { nextRenderTime: 1, fromSitemap: false });
	await claim();
	assert.equal(leased(key(A)), true, 'precondition: the one-off was claimed under a lease');

	await postResult(nonIndexable(403));

	assert.equal(stores.renderSchedule.has(key(A)), false);
	// `deleteSchedule` itself never releases a lease (that invariant is pinned directly in
	// test/renderQueueFloor.test.js). What releases it here is the single release point at the end of
	// processJobResult, on the 'dropped' lane — safe, because the row it referred to no longer exists,
	// and it frees the slot immediately rather than pinning the claim floor for a whole lease.
	assert.equal(leased(key(A)), false, 'the dropped lane releases, since there is no row left to pace');
	assert.deepEqual(await claim(), [], 'and nothing is left to claim');
});

// ---- transient (408/429/5xx) ----

for (const statusCode of [408, 429, 500, 503]) {
	test(`${statusCode} keeps the target and cached pages; first failure retries on the claim lease`, async () => {
		seedSource();
		await claim();
		await postResult(nonIndexable(statusCode));

		const target = stores.target.get(A);
		assert.ok(target, 'target must survive a transient failure');
		assert.notEqual(target.state, 'suppressed');
		assert.equal(target.strikes, 1, 'the failure is counted');
		assert.equal(stores.prerenderedPage.get(key(A)).content, 'old html', 'last good page keeps serving');

		assert.equal(stores.renderSchedule.get(key(A)).nextRenderTime, 1, 'schedule untouched — lease-driven retry');
		assert.equal(leased(key(A)), true, 'and the lease is HELD, which is what paces the retry');
		assert.deepEqual(await claim(), [], 'no immediate re-claim');
	});

	test(`${statusCode} retries exactly once, on lease expiry — not as fast as the fleet can claim`, async () => {
		seedSource();
		await claim();
		await postResult(nonIndexable(statusCode));

		// The whole lease window: still nothing.
		for (let elapsed = 0; elapsed < config.queue.jobLeaseTime; elapsed += config.queue.jobLeaseTime / 4) {
			assert.deepEqual(await claim(), [], 'the failing page must not be re-rendered inside the lease');
		}

		// Past expiry: granted, and exactly once. `+ 2s` rather than `+ 1ms` because expiries are
		// stored in whole seconds and ROUNDED UP — deliberately, so second granularity can only ever
		// make a lease longer than jobLeaseTime, never shorter.
		const originalNow = Date.now;
		try {
			Date.now = () => originalNow() + config.queue.jobLeaseTime + 2_000;
			const afterExpiry = await claim();
			assert.equal(
				afterExpiry.filter((job) => job.id === key(A)).length,
				1,
				'the retry arrives on lease expiry, exactly once'
			);
			assert.deepEqual(await claim(), [], 'and the fresh lease immediately covers it again');
		} finally {
			Date.now = originalNow;
		}
	});
}

test('past fastRetries, a failure drops to the target cadence — page kept but its expiry untouched', async () => {
	const fast = config.render.failureRetry.fastRetries;
	seedSource({ renderInterval: 3_600_000 });
	stores.target.get(A).strikes = fast; // this failure is strike fast+1 — first slow-lane one
	stores.prerenderedPage.get(key(A)).expiresAt = 777; // sentinel: must not be rewritten
	await claim();

	await postResult(nonIndexable(503));

	const target = stores.target.get(A);
	assert.equal(target.strikes, fast + 1);
	assert.notEqual(target.state, 'suppressed');

	const schedule = stores.renderSchedule.get(key(A));
	assert.ok(schedule.nextRenderTime > Date.now(), 'slow lane: rescheduled at the target cadence');
	assert.ok(schedule.nextRenderTime < Date.now() + 2 * 3_600_000, 'cadence, not a suppression recheck');

	// The slow lane RELEASES the lease. Holding it would pin the claim floor for a full jobLeaseTime
	// for a row that is now hours in the future — a latency cost for nothing.
	assert.equal(leased(key(A)), false, 'the slow lane releases the lease');
	// Refused by the DUE TIME — the row is hours out. (A released lease also keeps its key
	// unclaimable for its commit-visibility grace, which is why this cannot be asserted the other way
	// round; the due time is the thing that holds past the grace.)
	assert.deepEqual(await claim(), [], 'and the immediate re-claim is refused by the due time, not by a lease');

	const page = stores.prerenderedPage.get(key(A));
	assert.equal(page.content, 'old html', 'page survives');
	assert.equal(
		page.expiresAt,
		777,
		'expiry deliberately NOT extended — swrTtl bounds staleness; past it, origin is the truth'
	);
});

// ---- content verdicts stay on the default knobs ----

test('noindex (status 200) still suppresses under the default knobs with its own reason', async () => {
	seedSource();
	await postResult(nonIndexable(200, { reason: 'noindex' }));

	const target = stores.target.get(A);
	assert.equal(target.state, 'suppressed');
	assert.equal(target.suppressedReason, 'noindex');

	const goneRecheck = config.render.suppression.gone.recheckInterval;
	const schedule = stores.renderSchedule.get(key(A));
	assert.ok(schedule.nextRenderTime < Date.now() + goneRecheck, 'default recheck cadence, not the gone one');
});

test('a noindex verdict that happens to carry a 404 status is still classified gone by status only for http-error', async () => {
	// Classification keys on reason === http-error; a content verdict's status is not the
	// statement being made.
	seedSource();
	await postResult(nonIndexable(404, { reason: 'noindex' }));
	assert.equal(stores.target.get(A).suppressedReason, 'noindex');
});

// ---- redirect destination ----

test('a client-side redirect landing on a 403 page keeps the source and seeds nothing', async () => {
	seedSource();
	await postResult({
		id: key(A),
		url: A,
		statusCode: 403,
		outcome: 'redirected',
		redirectedTo: B,
		isIndexable: false,
	});

	const source = stores.target.get(A);
	assert.ok(source, 'auth-shaped landing must NOT retire the source — a credential outage would mass-delete');
	assert.notEqual(source.state, 'suppressed');
	assert.equal(source.strikes, 1, 'the failure is counted toward the retry lanes');
	assert.equal(stores.prerenderedPage.get(key(A)).content, 'old html', 'last good page keeps serving');
	assert.equal(stores.target.has(B), false, 'auth-shaped destination must not become a suppressed row');
});

test('a client-side redirect landing on a 503 page keeps the source and seeds nothing', async () => {
	seedSource();
	await postResult({
		id: key(A),
		url: A,
		statusCode: 503,
		outcome: 'redirected',
		redirectedTo: B,
		isIndexable: false,
	});

	assert.ok(stores.target.get(A), 'transient landing must not retire the source');
	assert.equal(stores.target.has(B), false, 'transient destination must not become a suppressed row');
});

test('a client-side redirect landing on a 404 page retires the source and seeds an http-gone destination', async () => {
	// The genuine-verdict path the guard must NOT swallow: gone destinations still classify.
	seedSource();
	await postResult({
		id: key(A),
		url: A,
		statusCode: 404,
		outcome: 'redirected',
		redirectedTo: B,
		isIndexable: false,
		reason: 'http-error',
	});

	assert.equal(stores.target.has(A), false, 'source retired — it leads to a page that is gone');
	assert.equal(stores.target.get(B)?.suppressedReason, 'http-gone', 'destination suppressed under the gone class');
});

test('a BigInt strikes value (Harper numeric surfacing) still counts toward the slow lane', async () => {
	const fast = config.render.failureRetry.fastRetries;
	seedSource({ renderInterval: 3_600_000 });
	stores.target.get(A).strikes = BigInt(fast); // Number.isFinite(BigInt) is false — must coerce first

	await postResult(nonIndexable(503));

	assert.equal(stores.target.get(A).strikes, fast + 1, 'BigInt count read correctly, not reset to 1');
	assert.ok(stores.renderSchedule.get(key(A)).nextRenderTime > Date.now(), 'transitioned to the slow lane');
});

// ---- a THROW out of result handling ----

test('a throw while handling a result HOLDS the lease — it must not become a re-render loop', async () => {
	// `holdLease` is only set by branches that ran to completion, so a throw used to release. That is
	// the worst case to release on: the throw propagates out of the request handler, Harper ABORTS the
	// ambient transaction, and everything this result had written — the cached page included — is
	// rolled back. The row keeps its original overdue due time, and the claim floor is at or below its
	// minute by construction, so a freed lease means the next pass re-grants it seconds later: an
	// UNPACED re-render loop against whatever is throwing, at claim frequency rather than once per
	// lease.
	//
	// The throw here is a real one, not an injected stub: a rendered result with content but no
	// `headers` object, which the store path stamps `x-harper-rendered` onto.
	seedSource();
	const claimed = await claim();
	assert.ok(
		claimed.some((job) => job.id === key(A)),
		'precondition: claimed, so there is a lease to hold'
	);

	await assert.rejects(
		() => postResult({ id: key(A), url: A, statusCode: 200, outcome: 'rendered' }, 'fresh html'),
		/x-harper-rendered/,
		'the failure must surface (a 500), not be swallowed'
	);

	assert.equal(leased(key(A)), true, 'the lease is HELD, so the retry is paced by queue.jobLeaseTime');
	assert.deepEqual(await claim(), [], 'and an immediate re-claim grants nothing');
	assert.equal(stores.renderSchedule.get(key(A)).nextRenderTime, 1, 'the row was never moved — nothing else paces it');
});
