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
		recordAnalytics: (...args) => analytics.push(args),
	};
	globalThis.logger = {
		info() {},
		warn: (msg) => warns.push(String(msg)),
		error() {},
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
	analytics = [];
});

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

	assert.equal(analytics.length, 1, 'redirect results still record render_time analytics');
	assert.equal(analytics[0][3], 'redirect');
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
	stores.renderSchedule.set(key(A), { nextRenderTime: 1 });
	await postResult({ id: key(A), url: A, statusCode: 302, outcome: 'redirected', redirectedTo: B });
	assert.equal(stores.renderSchedule.has(key(A)), false);
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
	assert.ok(
		warns.some((w) => w.includes('Suppressing') && w.includes('(noindex)')),
		`expected a suppression warn naming the reason, got: ${warns.join(' | ')}`
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
	seedSource();
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
	assert.ok(
		warns.some((w) => w.includes('ProtocolError')),
		`expected the posted error in the failure warn, got: ${warns.join(' | ')}`
	);
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
