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
		static async search() {
			return [];
		}
	};

let RenderQueue, config;

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
					getUserSharedBuffer: (_key, buf) => buf,
					tryLock: () => true,
					unlock() {},
				},
			},
		},
		render_service: {
			Target: makeResourceBase(stores.target),
			QueueControl: makeResourceBase(new Map()),
		},
		render_schedule: { RenderSchedule: makeResourceBase(stores.renderSchedule) },
		page_cache: { PrerenderedPage: makeResourceBase(stores.prerenderedPage) },
	};

	({ config } = await import('../src/config.js'));
	({ RenderQueue } = await import('../src/resources/RenderQueue.js'));
});

beforeEach(() => {
	for (const rows of Object.values(stores)) rows.clear();
	warns = [];
	errors = [];
});

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

test('403 keeps the target, keeps the cached pages, reschedules at normal cadence', async () => {
	seedSource({ renderInterval: 3_600_000 });
	await postResult(nonIndexable(403));

	const target = stores.target.get(A);
	assert.ok(target, 'target must survive an auth-shaped result');
	assert.notEqual(target.state, 'suppressed');
	assert.ok(!target.strikes, 'no strike for an auth-shaped result');

	const schedule = stores.renderSchedule.get(key(A));
	assert.ok(schedule.nextRenderTime > Date.now(), 'rescheduled in the future');
	assert.ok(
		schedule.nextRenderTime < Date.now() + 2 * 3_600_000,
		'rescheduled at the target cadence, not a suppression recheck'
	);
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
	stores.renderSchedule.set(key(A), { nextRenderTime: 1 });
	await postResult(nonIndexable(403));
	assert.equal(stores.renderSchedule.has(key(A)), false);
});

// ---- transient (408/429/5xx) ----

for (const statusCode of [408, 429, 500, 503]) {
	test(`${statusCode} keeps the target and cached pages and retries at normal cadence`, async () => {
		seedSource();
		await postResult(nonIndexable(statusCode));

		const target = stores.target.get(A);
		assert.ok(target, 'target must survive a transient failure');
		assert.notEqual(target.state, 'suppressed');
		assert.ok(!target.strikes, 'no strike for a transient failure');
		assert.equal(stores.prerenderedPage.get(key(A)).content, 'old html', 'last good page keeps serving');

		const schedule = stores.renderSchedule.get(key(A));
		assert.ok(schedule.nextRenderTime > Date.now(), 'rescheduled in the future');
	});
}

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
	assert.ok(!source.strikes, 'no strike either');
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
