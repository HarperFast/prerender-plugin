import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * A result whose URL has NO Target on the node processing it (see `readTargetlessRow` /
 * `settleTargetless` in src/resources/RenderQueue.js).
 *
 * The failure this pins: every "no target" branch used to delete the schedule row, treating a
 * recurring row whose target had simply not replicated to this node yet exactly like a render-now
 * one-off. The target then arrived to find no row — terminal and silent, because nothing re-creates
 * a schedule for a target that exists. What is pinned:
 *
 *   - a one-off (no cadence on its row) is unchanged: page stored, row dropped;
 *   - a recurring row (cadence filed) is DEFERRED — no page stored, row re-filed deferMs out and
 *     stamped `targetMissingSince` — on the rendered, failure and redirect paths alike;
 *   - a target that arrives before the grace runs out is rendered and rescheduled normally, and the
 *     stamp is cleared;
 *   - past the grace the row is dropped, with a warning.
 */

const A = 'https://site.example.com/product/a';
const key = (url, device) => `${url}|${device}`;
const DEVICES = ['desktop', 'mobile'];

const stores = {
	target: new Map(),
	renderSchedule: new Map(),
	prerenderedPage: new Map(),
	renderExpectation: new Map(),
};
let warns = [];
let infos = [];
let errors = [];
let analytics = [];

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
			if (Array.isArray(select)) return Object.fromEntries(select.map((name) => [name, row[name]]));
			return { ...row };
		}
		static async put(id, data) {
			return new this(id).put({ ...data });
		}
		static async patch(id, data) {
			rows.set(id, { ...(rows.get(id) ?? {}), ...data });
		}
		static async delete(id) {
			return new this(id).delete();
		}
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
		error: (msg) => errors.push(String(msg)),
	};
	globalThis.createBlob = (buf) => buf;
	globalThis.databases = {
		probe_state: {
			ProbeState: { delete: async () => {} },
			RenderExpectation: makeResourceBase(stores.renderExpectation),
		},
		coordination: {
			SharedBuffer: {
				primaryStore: {
					getUserSharedBuffer: (k, buf) => {
						if (!sabs.has(k)) sabs.set(k, buf);
						return sabs.get(k);
					},
					tryLock: () => true,
					unlock() {},
				},
			},
		},
		render_service: {
			Target: makeResourceBase(stores.target),
			QueueControl: makeResourceBase(new Map()),
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
	errors = [];
	analytics = [];
	funnel.resetRenderQueueState();
});

afterEach(() => {
	config.domains = [];
	config.ingress.mode = 'prefix';
	config.ingress.routes = [];
	config.deviceTypes.default = ['desktop', 'mobile'];
	config.deviceTypes.supported = ['desktop', 'mobile', 'tablet'];
});

const claim = (limit = 10) => RenderQueue.claim({ limit });
const leased = (k) => !!funnel.leaseInfo(k);
const outcomes = () => analytics.filter((a) => a[1] === 'render' && a[2] === 'outcome').map((a) => [a[3], a[4]]);

/** Post a result the way the browser's `postResult` frames it: JSON envelope, then the bodies. */
const post = async (envelope, bodies = []) => {
	const meta = Buffer.from(JSON.stringify(envelope), 'utf8');
	const body = Buffer.concat([meta, ...bodies.map((b) => (Buffer.isBuffer(b) ? b : Buffer.from(b)))]);
	const ctx = { headers: new Map([['x-metadata-size', String(meta.byteLength)]]) };
	return RenderQueue.processJobResult(body, ctx);
};

/** A multi-device result for `url`: `variants` are `{ deviceType, ...metadata, content? }`. */
const postVariants = async (url, variants, { deviceTypes = DEVICES, id = url } = {}) => {
	const bodies = [];
	const wire = variants.map(({ content, ...metadata }) => {
		if (content) bodies.push(Buffer.from(content));
		return { ...metadata, contentLength: content ? Buffer.byteLength(content) : 0 };
	});
	return post({ id, url, deviceTypes, variants: wire }, bodies);
};

const rendered = (deviceType, content = `<html>${deviceType}</html>`, extra = {}) => ({
	deviceType,
	statusCode: 200,
	outcome: 'rendered',
	isIndexable: true,
	headers: {},
	renderTime: 100,
	structuredOffers: null,
	content,
	...extra,
});

const HOUR = 3_600_000;

/** A recurring row with no target: the shape a not-yet-replicated target leaves on its owner. */
const seedRecurringRow = ({ url = A, targetMissingSince } = {}) => {
	stores.renderSchedule.set(url, {
		nextRenderTime: 1,
		fromSitemap: true,
		effectiveInterval: 4 * HOUR,
		...(targetMissingSince === undefined ? {} : { targetMissingSince }),
	});
};

test('a one-off (no cadence on its row) is unchanged: page stored, row dropped', async () => {
	stores.renderSchedule.set(A, { nextRenderTime: 1, fromSitemap: false, effectiveInterval: null });
	await claim();
	await postVariants(A, [rendered('desktop'), rendered('mobile')]);

	assert.equal(stores.renderSchedule.has(A), false);
	assert.equal(stores.prerenderedPage.get(key(A, 'desktop')).content.toString(), '<html>desktop</html>');
	assert.deepEqual(outcomes(), [['rendered', 'stored']]);
});

test('a recurring row whose target is missing here is DEFERRED, not dropped — and stores no page', async () => {
	seedRecurringRow();
	await claim();
	const before = Date.now();
	await postVariants(A, [rendered('desktop'), rendered('mobile')]);

	const row = stores.renderSchedule.get(A);
	assert.ok(row, 'the row survives — dropping it is the terminal gap');
	assert.ok(row.nextRenderTime >= before + config.render.targetMissing.deferMs - 60_000, 're-filed deferMs out');
	assert.ok(row.targetMissingSince >= before && row.targetMissingSince <= Date.now(), 'stamped with first sighting');
	assert.equal(row.effectiveInterval, 4 * HOUR, 'its cadence is carried, not lost');
	assert.equal(row.fromSitemap, true);
	assert.equal(stores.prerenderedPage.size, 0, 'no page for a URL no target on this node owns');
	assert.deepEqual(outcomes(), [['rendered', 'target-missing']]);
	assert.equal(leased(A), false, 'the lease is released: the row is in the future');
});

test('a target that arrives within the grace is rendered and rescheduled normally, and the stamp clears', async () => {
	const since = Date.now() - HOUR;
	seedRecurringRow({ targetMissingSince: since });
	stores.target.set(A, { url: A, renderInterval: 4 * HOUR, sitemapUrl: 'https://site.example.com/sitemap.xml' });
	await claim();
	await postVariants(A, [rendered('desktop'), rendered('mobile')]);

	const row = stores.renderSchedule.get(A);
	assert.equal(row.targetMissingSince, undefined, 'a normal reschedule puts the row whole and clears it');
	assert.ok(row.nextRenderTime > Date.now(), 'rescheduled on its cadence');
	assert.equal(stores.prerenderedPage.get(key(A, 'mobile')).content.toString(), '<html>mobile</html>');
	assert.deepEqual(outcomes(), [['rendered', 'stored']]);
});

test('a deferred row keeps its FIRST sighting on a second miss inside the grace', async () => {
	const since = Date.now() - 2 * HOUR;
	seedRecurringRow({ targetMissingSince: since });
	await claim();
	await postVariants(A, [rendered('desktop'), rendered('mobile')]);

	assert.equal(stores.renderSchedule.get(A).targetMissingSince, since, 'the grace is measured from first sighting');
});

test('past the grace the row is dropped, with a warning', async () => {
	seedRecurringRow({ targetMissingSince: Date.now() - config.render.targetMissing.graceMs - 60_000 });
	await claim();
	await postVariants(A, [rendered('desktop'), rendered('mobile')]);

	assert.equal(stores.renderSchedule.has(A), false);
	assert.equal(stores.prerenderedPage.size, 0);
	assert.ok(
		warns.some((w) => w.includes('no Target on this node') && w.includes('dropping')),
		'a drop that ends a rotation is never silent'
	);
});

test('the failure path defers a recurring targetless row too, and releases its lease', async () => {
	seedRecurringRow();
	await claim();
	await postVariants(A, [
		{ deviceType: 'desktop', outcome: 'error', reason: 'transient', statusCode: 503, headers: {} },
		rendered('mobile'),
	]);

	const row = stores.renderSchedule.get(A);
	assert.ok(row?.targetMissingSince, 'deferred, not dropped');
	assert.equal(stores.target.has(A), false, 'and no strike is written onto a target that is not here');
	assert.equal(leased(A), false);
});

test('the redirect path defers a recurring targetless row too', async () => {
	seedRecurringRow();
	await claim();
	await postVariants(A, [
		{
			deviceType: 'desktop',
			statusCode: 302,
			outcome: 'redirected',
			redirectedTo: 'https://site.example.com/product/b',
			headers: {},
		},
		{
			deviceType: 'mobile',
			statusCode: 302,
			outcome: 'redirected',
			redirectedTo: 'https://site.example.com/product/b',
			headers: {},
		},
	]);

	assert.ok(stores.renderSchedule.get(A)?.targetMissingSince, 'deferred, not dropped');
});

// ───────────────────────────── a gone verdict never mints a row ─────────────────────────────
//
// A suppressed row exists to stop something re-creating the URL, and for a 404/410 nothing can:
// discovery mints only on a 200. So `Target.suppress` returns `absent` instead of minting, and the
// job's row is settled like any other targetless result's. The race it closes: a URL row and a
// pre-0.66.0 device row in flight together — the first 404 retires the target and takes both rows,
// and the second used to mint it straight back as a suppressed row with a 14-day recheck.

const gone = (deviceType, statusCode = 404) => ({
	deviceType,
	statusCode,
	outcome: 'non-indexable',
	isIndexable: false,
	reason: 'http-error',
	headers: {},
	renderTime: 100,
});

/** An unlisted target with its URL row AND a device row not yet folded — both due. */
const seedUnfoldedPair = () => {
	stores.target.set(A, { url: A, renderInterval: 4 * HOUR });
	stores.renderSchedule.set(A, { nextRenderTime: 1, fromSitemap: false, effectiveInterval: 4 * HOUR });
	stores.renderSchedule.set(key(A, 'mobile'), { nextRenderTime: 1, fromSitemap: false });
};

const assertRetiredForGood = async () => {
	assert.equal(stores.target.has(A), false, 'the late sibling must not mint the target back as suppressed');
	assert.equal(stores.renderSchedule.size, 0, 'no recheck row, and no device row left behind');
	assert.equal(stores.prerenderedPage.size, 0);
	assert.deepEqual(await claim(), [], 'nothing left to render');
};

test('a device-row 404 landing after its URL row retired the target does NOT re-mint it', async () => {
	seedUnfoldedPair();
	const claimed = (await claim()).map((job) => job.id).sort();
	assert.deepEqual(claimed, [A, key(A, 'mobile')].sort(), 'precondition: both rows are in flight at once');

	await postVariants(A, [gone('desktop'), gone('mobile')]);
	assert.equal(stores.target.has(A), false, 'precondition: an unlisted 404 retires on the first verdict');
	assert.equal(stores.renderSchedule.has(key(A, 'mobile')), false, 'precondition: and its delete took the device row');

	await post({ id: key(A, 'mobile'), url: A, ...gone('mobile') });

	await assertRetiredForGood();
	assert.ok(
		infos.some((m) => m.includes('not minting')),
		'the skipped mint is logged'
	);
});

test('the same race in the other order: a URL-row 404 after the device row retired the target', async () => {
	seedUnfoldedPair();
	await claim();

	await post({ id: key(A, 'mobile'), url: A, ...gone('mobile') });
	assert.equal(stores.target.has(A), false, 'precondition: the device-row verdict retired the target');

	await postVariants(A, [gone('desktop'), gone('mobile')]);

	await assertRetiredForGood();
});

test('a gone one-off with no target drops its row and mints nothing', async () => {
	stores.renderSchedule.set(A, { nextRenderTime: 1, fromSitemap: false, effectiveInterval: null });
	await claim();
	await postVariants(A, [gone('desktop', 410), gone('mobile', 410)]);

	assert.equal(stores.target.has(A), false);
	assert.equal(stores.renderSchedule.has(A), false, 'the one-off row is dropped');
	assert.equal(leased(A), false);
});

test('a gone verdict on a recurring row whose target is missing here defers the row and mints nothing', async () => {
	// The target may exist elsewhere and not have replicated yet — minting here would REPLACE it with
	// a row carrying `sitemapUrl: null` once it arrives. Deferred like any targetless recurring row.
	seedRecurringRow();
	await claim();
	await postVariants(A, [gone('desktop'), gone('mobile')]);

	assert.equal(stores.target.has(A), false, 'a 404 must not mint a suppressed target');
	assert.ok(stores.renderSchedule.get(A)?.targetMissingSince, 'deferred, not dropped');
	assert.deepEqual(outcomes(), [['suppressed', 'http-error']], 'the verdict is still counted');
});

test('a NON-gone verdict with no target still mints its suppressed row — the page 200s, so discovery would', async () => {
	stores.renderSchedule.set(A, { nextRenderTime: 1, fromSitemap: false, effectiveInterval: null });
	await claim();
	const noindex = (deviceType) => ({ ...gone(deviceType, 200), reason: 'noindex' });
	await postVariants(A, [noindex('desktop'), noindex('mobile')]);

	assert.equal(stores.target.get(A)?.state, 'suppressed');
	assert.equal(stores.target.get(A)?.suppressedReason, 'noindex');
});

// ───────────────────────────── retirement leaves no page behind ─────────────────────────────

test('retiring a target deletes its pages for EVERY supported device — a tablet one-off included', async () => {
	// Before: `Target.delete` removed pages only under `deviceTypes.default`, so a one-off rendered
	// for a supported non-default device outlived its target as a page nothing re-renders or reclaims.
	const { Target } = await import('../src/resources/Target.js');
	stores.target.set(A, { url: A, renderInterval: 4 * HOUR });
	for (const device of ['desktop', 'mobile', 'tablet']) {
		stores.prerenderedPage.set(key(A, device), { statusCode: 200, content: 'html' });
	}

	await Target.delete(A);

	assert.equal(stores.target.has(A), false);
	assert.equal(stores.prerenderedPage.size, 0, 'no page survives its target, whatever device it was stored for');
});
