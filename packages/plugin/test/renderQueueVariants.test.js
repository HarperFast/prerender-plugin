import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * ONE JOB PER URL, ONE RESULT, ONE SCHEDULING DECISION (plugin v0.66.0 / browser v1.23.0).
 *
 * The schedule row is keyed by the URL. `claim` hands out one job per row carrying every device in
 * `deviceTypes.default`; the browser renders them in turn and posts `{ id, url, deviceTypes,
 * variants: [...] }` with the variants' bodies concatenated behind the JSON. What is pinned here:
 *
 *   - the claim job shape, for a URL row and for a pre-0.66.0 per-device row;
 *   - the result framing (`contentLength` per variant) and its refusal when it does not add up;
 *   - the precedence across variants: a redirect decides the URL, a genuine non-indexable verdict
 *     suppresses it, rendered pages are stored per device, a failed device puts the URL in the retry
 *     lanes with the good pages kept, and all-rendered reschedules ONCE;
 *   - a device the browser was asked for and did not post back is a failure, not a silent skip;
 *   - strikes: one result per URL means one strike per failed cycle;
 *   - the conversion of pre-0.66.0 per-device rows into the URL row, at no extra renders;
 *   - a one-device row for a device outside the default set is a one-off beside the rotation;
 *   - an older renderer answering a URL job (flat result, no device) is attributed to the first
 *     default device — degraded, never lost.
 */

const A = 'https://site.example.com/product/a';
const B = 'https://site.example.com/product/b';
const key = (url, device) => `${url}|${device}`;
const DEVICES = ['desktop', 'mobile'];

const stores = { target: new Map(), renderSchedule: new Map(), prerenderedPage: new Map() };
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
		probe_state: { ProbeState: { delete: async () => {} } },
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
const renderTimes = () => analytics.filter((a) => a[1] === 'render' && a[2] === 'time_ms');

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

const seedUrlRow = ({ url = A, renderInterval = 3_600_000, nextRenderTime = 1, state, strikes } = {}) => {
	stores.target.set(url, {
		url,
		renderInterval,
		...(state ? { state } : {}),
		...(Number.isFinite(strikes) ? { strikes } : {}),
	});
	stores.renderSchedule.set(url, { nextRenderTime, fromSitemap: false, effectiveInterval: renderInterval });
	for (const device of DEVICES) stores.prerenderedPage.set(key(url, device), { statusCode: 200, content: 'old html' });
};

// ───────────────────────────── claim ─────────────────────────────

test('a URL row claims as ONE job naming every default device, with deviceType for older renderers', async () => {
	seedUrlRow();
	const jobs = await claim();
	assert.equal(jobs.length, 1, 'one URL, one job — not one per device');
	const [job] = jobs;
	assert.equal(job.id, A, 'the row key, echoed back by the browser');
	assert.equal(job.url, A);
	assert.deepEqual(job.deviceTypes, ['desktop', 'mobile']);
	assert.equal(job.deviceType, 'desktop', 'the first device, for a renderer that predates the list');
	assert.equal(leased(A), true, 'leased under the row key');
});

test('a pre-0.66.0 per-device row claims as a job for exactly the device its key names', async () => {
	stores.target.set(A, { url: A, renderInterval: 3_600_000 });
	stores.renderSchedule.set(key(A, 'mobile'), { nextRenderTime: 1, fromSitemap: true });
	const [job] = await claim();
	assert.equal(job.id, key(A, 'mobile'));
	assert.equal(job.url, A, 'the URL, not the cacheKey');
	assert.deepEqual(job.deviceTypes, ['mobile']);
	assert.equal(job.deviceType, 'mobile');
	assert.equal(job.isFromSitemap, true);
});

test('an emptied deviceTypes.default is refused where config is applied — the job list is never empty', async () => {
	// Validated at the entry point (the schema marks the option `nonEmpty`), not guarded here: `claim`
	// and the fold rule in `describeJob` both read the same list, and a downstream fallback in one of
	// them would let the two disagree.
	const { applyOptions } = await import('../src/config.js');
	applyOptions({ deviceTypes: { default: [] } });
	assert.deepEqual(config.deviceTypes.default, ['desktop', 'mobile'], 'the default is kept');
	seedUrlRow();
	const [job] = await claim();
	assert.deepEqual(job.deviceTypes, ['desktop', 'mobile']);
	applyOptions({});
});

// ───────────────────────────── framing ─────────────────────────────

test('a multi-device result is decoded by walking contentLength per variant', async () => {
	seedUrlRow();
	await claim();
	await postVariants(A, [
		rendered('desktop', '<html>desktop</html>'),
		rendered('mobile', '<html>mobile — longer</html>'),
	]);

	assert.equal(stores.prerenderedPage.get(key(A, 'desktop')).content.toString(), '<html>desktop</html>');
	assert.equal(stores.prerenderedPage.get(key(A, 'mobile')).content.toString(), '<html>mobile — longer</html>');
});

test('a result whose contentLengths do not account for its body is refused with a 400', async () => {
	seedUrlRow();
	for (const wire of [
		// claims more than is there
		{ variants: [{ deviceType: 'desktop', outcome: 'rendered', statusCode: 200, contentLength: 999 }], body: 'short' },
		// leaves bytes unattributed
		{ variants: [{ deviceType: 'desktop', outcome: 'rendered', statusCode: 200, contentLength: 2 }], body: 'longer' },
	]) {
		const response = await post({ id: A, url: A, deviceTypes: ['desktop'], variants: wire.variants }, [wire.body]);
		assert.equal(response?.status, 400, 'a body that cannot be attributed to devices is refused');
	}
	assert.equal(stores.prerenderedPage.get(key(A, 'desktop')).content, 'old html', 'and nothing was stored');
});

// ───────────────────────────── precedence ─────────────────────────────

test('every device rendered: pages stored per device, ONE reschedule, ONE outcome, one page claim', async () => {
	seedUrlRow({ renderInterval: 3_600_000, strikes: 2 });
	await claim();
	const before = Date.now();
	await postVariants(A, [
		rendered('desktop', '<html>d</html>', { structuredOffers: ['9.99', 'USD', 'InStock'] }),
		rendered('mobile', '<html>m</html>', { structuredOffers: ['9.99', 'USD', 'InStock'] }),
	]);

	const desktop = stores.prerenderedPage.get(key(A, 'desktop'));
	const mobile = stores.prerenderedPage.get(key(A, 'mobile'));
	assert.equal(desktop.content.toString(), '<html>d</html>');
	assert.equal(mobile.content.toString(), '<html>m</html>');
	assert.equal(desktop.lastCached, mobile.lastCached, 'ONE timestamp for the pair — the verification basis is exact');
	assert.equal(JSON.parse(desktop.headers)['x-harper-rendered'], '1');

	const schedule = stores.renderSchedule.get(A);
	assert.ok(schedule.nextRenderTime >= before + 3_600_000 - 60_000, 'rescheduled one interval out');
	assert.equal(desktop.expiresAt, schedule.nextRenderTime, 'page expiry coupled to the next render');
	assert.equal(mobile.expiresAt, schedule.nextRenderTime);
	assert.equal(stores.renderSchedule.size, 1, 'exactly one schedule row for the URL');

	assert.equal(stores.target.get(A).strikes, 0, 'a successful render clears strikes');
	assert.deepEqual(outcomes(), [['rendered', 'stored']], 'exactly one outcome per posted result');
	assert.equal(renderTimes().length, 2, 'but one time_ms sample per rendered device');
	assert.equal(leased(A), false, 'the lease is released');
});

test('a device that failed puts the URL in the fast lane while the device that rendered is stored', async () => {
	seedUrlRow();
	await claim();
	await postVariants(A, [
		rendered('desktop', '<html>fresh</html>'),
		{
			deviceType: 'mobile',
			outcome: 'error',
			reason: 'error',
			error: { name: 'TimeoutError', message: 'settle', phase: 'settle' },
		},
	]);

	assert.equal(
		stores.prerenderedPage.get(key(A, 'desktop')).content.toString(),
		'<html>fresh</html>',
		'good side stored'
	);
	assert.equal(
		stores.prerenderedPage.get(key(A, 'mobile')).content,
		'old html',
		'failed side keeps its last good page'
	);
	assert.equal(stores.target.get(A).strikes, 1, 'ONE strike for the URL, not one per failed device');
	assert.equal(stores.renderSchedule.get(A).nextRenderTime, 1, 'schedule untouched — the lease paces the retry');
	assert.equal(leased(A), true, 'the fast lane HOLDS the lease');
	assert.deepEqual(await claim(), [], 'so nothing re-claims it now');
	assert.deepEqual(outcomes(), [['failed', 'settle']]);
	assert.ok(warns.some((w) => w.includes('(mobile)') && w.includes('TimeoutError')));
});

test('both devices failing costs ONE strike — two per-device results used to cost two', async () => {
	seedUrlRow();
	await claim();
	await postVariants(A, [
		{
			deviceType: 'desktop',
			outcome: 'error',
			reason: 'error',
			error: { name: 'Error', message: 'x', phase: 'navigation' },
		},
		{
			deviceType: 'mobile',
			outcome: 'error',
			reason: 'error',
			error: { name: 'Error', message: 'y', phase: 'settle' },
		},
	]);
	assert.equal(stores.target.get(A).strikes, 1);
	assert.deepEqual(outcomes(), [['failed', 'navigation']], 'the first failed variant names the outcome');
});

test('an auth-shaped device outranks a transient one in the outcome, and neither suppresses', async () => {
	seedUrlRow();
	await claim();
	await postVariants(A, [
		{ deviceType: 'desktop', outcome: 'non-indexable', isIndexable: false, statusCode: 503, reason: 'http-error' },
		{ deviceType: 'mobile', outcome: 'non-indexable', isIndexable: false, statusCode: 403, reason: 'http-error' },
	]);
	assert.notEqual(stores.target.get(A).state, 'suppressed');
	assert.deepEqual(outcomes(), [['auth-failure', 403]]);
	assert.ok(errors.some((e) => e.includes('403') && e.includes('(mobile)')));
	assert.ok(infos.some((i) => i.includes('503') && i.includes('(desktop)')));
	assert.equal(leased(A), true);
});

test('a genuine non-indexable verdict on ANY device suppresses the URL, storing nothing', async () => {
	seedUrlRow();
	await claim();
	await postVariants(A, [
		rendered('desktop', '<html>fresh</html>'),
		{ deviceType: 'mobile', outcome: 'non-indexable', isIndexable: false, statusCode: 200, reason: 'noindex' },
	]);

	const target = stores.target.get(A);
	assert.equal(target.state, 'suppressed');
	assert.equal(target.suppressedReason, 'noindex');
	for (const device of DEVICES) {
		assert.equal(
			stores.prerenderedPage.has(key(A, device)),
			false,
			`${device} page dropped — the fresh desktop one too`
		);
	}
	assert.ok(stores.renderSchedule.get(A).nextRenderTime > Date.now() + 3_600_000, 'rescheduled at the recheck cadence');
	assert.deepEqual(outcomes(), [['suppressed', 'noindex']]);
	assert.ok(infos.some((i) => i.includes('Suppressing') && i.includes('(mobile, noindex)')));
});

test('a redirect the browser bailed on, on ANY device, decides the URL: 301 retires it and adopts the destination', async () => {
	seedUrlRow({ renderInterval: 1234567 });
	await claim();
	await postVariants(A, [
		rendered('desktop', '<html>fresh</html>'),
		{ deviceType: 'mobile', outcome: 'redirected', statusCode: 301, redirectedTo: B, renderTime: 40 },
	]);

	assert.equal(stores.target.has(A), false, 'a page does not redirect for one device and serve for another');
	assert.equal(stores.renderSchedule.has(A), false);
	for (const device of DEVICES) assert.equal(stores.prerenderedPage.has(key(A, device)), false);
	assert.equal(stores.target.get(B)?.renderInterval, 1234567, 'destination adopted with the cadence');
	assert.ok(stores.renderSchedule.get(B), 'and scheduled — one URL row');
	assert.deepEqual(outcomes(), [['redirect', 'permanent']]);
	const times = renderTimes();
	assert.equal(times.length, 2);
	assert.ok(
		times.some((t) => t[4] === 'redirect'),
		'the bail-at-nav variant is timed in its own lane'
	);
	assert.equal(leased(A), false);
});

test('a temporary redirect on one device strikes the URL and reschedules it at cadence', async () => {
	seedUrlRow({ renderInterval: 60_000 });
	await claim();
	await postVariants(A, [
		rendered('desktop', '<html>fresh</html>'),
		{ deviceType: 'mobile', outcome: 'redirected', statusCode: 302, redirectedTo: B },
	]);
	assert.equal(stores.target.get(A).strikes, 1);
	assert.ok(stores.renderSchedule.get(A).nextRenderTime > Date.now(), 'one reschedule, on the URL row');
	assert.equal(stores.target.has(B), false);
	assert.deepEqual(outcomes(), [['redirect', 'temporary']]);
});

test('a rendered client-side redirect refiles under the destination keys and retires the source once', async () => {
	seedUrlRow();
	await claim();
	await postVariants(A, [
		rendered('desktop', '<html>landed d</html>', { redirectedTo: B }),
		rendered('mobile', '<html>landed m</html>', { redirectedTo: B }),
	]);
	assert.equal(stores.target.has(A), false, 'source retired by the refile');
	assert.equal(stores.renderSchedule.has(A), false);
	assert.equal(stores.prerenderedPage.get(key(B, 'desktop')).content.toString(), '<html>landed d</html>');
	assert.equal(stores.prerenderedPage.get(key(B, 'mobile')).content.toString(), '<html>landed m</html>');
	assert.deepEqual(outcomes(), [['rendered', 'refiled']]);
	assert.equal(leased(A), false, 'the SOURCE lease — the one that was granted — is released');
});

test('a redirected variant whose destination re-keys to the SAME key is a failure, not a success', async () => {
	// The browser's own redirect check uses a default allowlist; the plugin's is per route, so a
	// query-only hop the route folds away arrives as `redirected` with no key change. Nothing was
	// rendered and nothing decided, so it must take the retry lane — never step 5's reschedule.
	seedUrlRow();
	await claim();
	await postVariants(A, [
		rendered('desktop', '<html>fresh</html>'),
		{ deviceType: 'mobile', outcome: 'redirected', statusCode: 200, redirectedTo: `${A}?utm=x` },
	]);
	assert.equal(stores.prerenderedPage.get(key(A, 'desktop')).content.toString(), '<html>fresh</html>');
	assert.equal(stores.target.get(A).strikes, 1, 'counted as a failure');
	assert.equal(stores.renderSchedule.get(A).nextRenderTime, 1, 'NOT rescheduled as a success');
	assert.equal(leased(A), true, 'the fast lane holds the lease');
	assert.deepEqual(outcomes(), [['failed', 'unknown']]);
});

test('an outcome this plugin does not know is a failure, not a success', async () => {
	seedUrlRow();
	await claim();
	await postVariants(A, [{ deviceType: 'desktop', outcome: 'teleported' }, rendered('mobile')]);
	assert.equal(stores.target.get(A).strikes, 1);
	assert.equal(stores.renderSchedule.get(A).nextRenderTime, 1);
	assert.equal(leased(A), true);
});

test('a result that names no device at all is refused with a 400, and the lease simply expires', async () => {
	seedUrlRow();
	await claim();
	const response = await post({ id: A, url: A, variants: [] }, []);
	assert.equal(response?.status, 400);
	assert.equal(stores.renderSchedule.get(A).nextRenderTime, 1, 'nothing was rescheduled');
	assert.deepEqual(outcomes(), [], 'and nothing was counted');
});

test('a one-device row for a NON-default device whose URL turns out to 301 is retired too — no re-grant loop', async () => {
	seedUrlRow({ nextRenderTime: 9_999_999_999_999 });
	stores.renderSchedule.set(key(A, 'tablet'), { nextRenderTime: 1, fromSitemap: false });
	await claim();
	await postVariants(A, [{ deviceType: 'tablet', outcome: 'redirected', statusCode: 301, redirectedTo: B }], {
		id: key(A, 'tablet'),
		deviceTypes: ['tablet'],
	});
	assert.equal(stores.target.has(A), false, 'the URL is retired — a page does not redirect for one device only');
	assert.equal(stores.renderSchedule.has(A), false);
	assert.equal(stores.renderSchedule.has(key(A, 'tablet')), false, 'the tablet row goes too — it is not a default key');
	assert.equal(leased(key(A, 'tablet')), false);
	assert.ok(stores.target.get(B), 'destination adopted');
	const next = await claim();
	assert.ok(
		next.every((job) => job.url !== A),
		`nothing of ${A} is left to re-grant (got ${next.map((job) => job.id).join(', ')})`
	);
	assert.deepEqual(
		next.map((job) => job.id),
		[B],
		'only the adopted destination is due'
	);
});

test('a refiled result with a failed sibling releases the SOURCE lease and touches no other target', async () => {
	seedUrlRow();
	stores.target.set(B, { url: B, renderInterval: 3_600_000, strikes: 0 });
	stores.renderSchedule.set(B, { nextRenderTime: 5_555_555_555_555, fromSitemap: false });
	await claim();
	await postVariants(A, [
		rendered('desktop', '<html>landed</html>', { redirectedTo: B }),
		{
			deviceType: 'mobile',
			outcome: 'error',
			reason: 'error',
			error: { name: 'Error', message: 'x', phase: 'settle' },
		},
	]);
	assert.equal(stores.target.has(A), false, 'source retired by the refile');
	assert.equal(stores.prerenderedPage.get(key(B, 'desktop')).content.toString(), '<html>landed</html>');
	assert.equal(leased(A), false, 'no lease is held for a row that no longer exists');
	assert.equal(stores.target.get(B).strikes, 0, "the sibling's failure is not charged to the destination");
	assert.ok(warns.some((w) => w.includes('(mobile)') && w.includes('not retried')));
	assert.deepEqual(outcomes(), [['rendered', 'refiled']]);
});

test('a suppression that deletes at maxStrikes does not delete the folding device row twice', async () => {
	const max = config.render.suppression.maxStrikes;
	stores.target.set(A, { url: A, renderInterval: 3_600_000, state: 'suppressed', strikes: max - 1 });
	stores.renderSchedule.set(key(A, 'desktop'), { nextRenderTime: 1, fromSitemap: false });
	const RenderSchedule = globalThis.databases.render_schedule.RenderSchedule;
	const deletes = [];
	const realDelete = RenderSchedule.delete;
	RenderSchedule.delete = async (id) => {
		deletes.push(id);
		return realDelete.call(RenderSchedule, id);
	};
	try {
		await claim();
		await postVariants(
			A,
			[{ deviceType: 'desktop', outcome: 'non-indexable', isIndexable: false, statusCode: 200, reason: 'noindex' }],
			{ id: key(A, 'desktop'), deviceTypes: ['desktop'] }
		);
	} finally {
		RenderSchedule.delete = realDelete;
	}
	assert.equal(stores.target.has(A), false, 'deleted at maxStrikes');
	assert.equal(deletes.filter((id) => id === key(A, 'desktop')).length, 1, 'the device row is deleted exactly once');
});

// ───────────────────────────── partial results ─────────────────────────────

test('a device asked for and not posted back is a failure: good page stored, URL retries on the lease', async () => {
	seedUrlRow();
	await claim();
	await postVariants(A, [rendered('desktop', '<html>fresh</html>')], { deviceTypes: ['desktop', 'mobile'] });

	assert.equal(stores.prerenderedPage.get(key(A, 'desktop')).content.toString(), '<html>fresh</html>');
	assert.equal(stores.prerenderedPage.get(key(A, 'mobile')).content, 'old html');
	assert.equal(stores.target.get(A).strikes, 1);
	assert.equal(leased(A), true, 'held — the lease expiry re-renders the URL, mobile included');
	assert.deepEqual(outcomes(), [['failed', 'not-attempted']]);
	assert.ok(warns.some((w) => w.includes('(mobile)') && w.includes('not-attempted')));
});

// ───────────────────────────── conversion of pre-0.66.0 rows ─────────────────────────────

test('a per-device row folds into the URL row on its result, and the sibling converts on its own — no extra renders', async () => {
	stores.target.set(A, { url: A, renderInterval: 3_600_000 });
	stores.renderSchedule.set(key(A, 'desktop'), { nextRenderTime: 1, fromSitemap: false });
	stores.renderSchedule.set(key(A, 'mobile'), { nextRenderTime: 1, fromSitemap: false });

	const jobs = await claim();
	assert.deepEqual(
		jobs.map((j) => [j.id, j.deviceTypes]).sort(),
		[
			[key(A, 'desktop'), ['desktop']],
			[key(A, 'mobile'), ['mobile']],
		],
		'each legacy row renders exactly its own device — as it always did'
	);

	// Desktop's result: URL row written, desktop row retired, mobile row untouched.
	await postVariants(A, [rendered('desktop')], { id: key(A, 'desktop'), deviceTypes: ['desktop'] });
	assert.ok(stores.renderSchedule.get(A), 'the URL row now exists');
	assert.equal(stores.renderSchedule.has(key(A, 'desktop')), false, 'the desktop row is gone');
	assert.equal(
		stores.renderSchedule.get(key(A, 'mobile')).nextRenderTime,
		1,
		'the mobile row waits for its own render'
	);
	assert.equal(stores.prerenderedPage.get(key(A, 'desktop')).content.toString(), '<html>desktop</html>');
	const firstDue = stores.renderSchedule.get(A).nextRenderTime;

	// Mobile's result: same URL row (rewritten a moment later), mobile row retired. Converged.
	await postVariants(A, [rendered('mobile')], { id: key(A, 'mobile'), deviceTypes: ['mobile'] });
	assert.deepEqual([...stores.renderSchedule.keys()], [A], 'exactly one row remains, keyed by the URL');
	assert.ok(stores.renderSchedule.get(A).nextRenderTime >= firstDue);
	assert.equal(stores.prerenderedPage.get(key(A, 'mobile')).content.toString(), '<html>mobile</html>');
	assert.deepEqual(outcomes(), [
		['rendered', 'stored'],
		['rendered', 'stored'],
	]);
});

test('a per-device row in the fast lane is NOT retired — the lease expiry must re-grant it', async () => {
	stores.target.set(A, { url: A, renderInterval: 3_600_000 });
	stores.renderSchedule.set(key(A, 'desktop'), { nextRenderTime: 1, fromSitemap: false });
	await claim();
	await postVariants(
		A,
		[
			{
				deviceType: 'desktop',
				outcome: 'error',
				reason: 'error',
				error: { name: 'Error', message: 'x', phase: 'settle' },
			},
		],
		{ id: key(A, 'desktop'), deviceTypes: ['desktop'] }
	);
	assert.ok(stores.renderSchedule.has(key(A, 'desktop')), 'the row the lease paces stays');
	assert.equal(stores.renderSchedule.has(A), false, 'and no URL row is written yet');
	assert.equal(leased(key(A, 'desktop')), true);
});

test('a per-device row past fastRetries converts as it takes the slow lane', async () => {
	const fast = config.render.failureRetry.fastRetries;
	stores.target.set(A, { url: A, renderInterval: 3_600_000, strikes: fast });
	stores.renderSchedule.set(key(A, 'desktop'), { nextRenderTime: 1, fromSitemap: false });
	await claim();
	await postVariants(
		A,
		[
			{
				deviceType: 'desktop',
				outcome: 'error',
				reason: 'error',
				error: { name: 'Error', message: 'x', phase: 'settle' },
			},
		],
		{ id: key(A, 'desktop'), deviceTypes: ['desktop'] }
	);
	assert.ok(stores.renderSchedule.get(A).nextRenderTime > Date.now(), 'the backoff lands on the URL row');
	assert.equal(stores.renderSchedule.has(key(A, 'desktop')), false, 'the device row is retired');
	assert.equal(leased(key(A, 'desktop')), false, 'slow lane releases');
});

// ───────────────────────────── one-device rows beside the rotation ─────────────────────────────

test('a per-device row for a NON-default device is a one-off: page stored, row retired, URL row untouched', async () => {
	seedUrlRow({ nextRenderTime: 9_999_999_999_999 });
	stores.renderSchedule.set(key(A, 'tablet'), { nextRenderTime: 1, fromSitemap: false });
	const jobs = await claim();
	assert.deepEqual(
		jobs.map((j) => j.id),
		[key(A, 'tablet')],
		'only the tablet row is due'
	);
	assert.deepEqual(jobs[0].deviceTypes, ['tablet']);

	await postVariants(A, [rendered('tablet')], { id: key(A, 'tablet'), deviceTypes: ['tablet'] });

	assert.equal(stores.prerenderedPage.get(key(A, 'tablet')).content.toString(), '<html>tablet</html>');
	assert.equal(stores.renderSchedule.has(key(A, 'tablet')), false, 'one render, then gone');
	assert.equal(
		stores.renderSchedule.get(A).nextRenderTime,
		9_999_999_999_999,
		'the rotation is not re-anchored by a one-off'
	);
	assert.equal(leased(key(A, 'tablet')), false);
});

test('a targetless URL row (render-now one-off) is dropped after its result, not retried forever', async () => {
	stores.renderSchedule.set(A, { nextRenderTime: 1, fromSitemap: false });
	await claim();
	await postVariants(A, [rendered('desktop'), rendered('mobile')]);
	assert.equal(stores.renderSchedule.has(A), false);
	assert.equal(stores.prerenderedPage.get(key(A, 'desktop')).content.toString(), '<html>desktop</html>');
	assert.equal(leased(A), false);
	assert.deepEqual(await claim(), []);
});

// ───────────────────────────── older renderers ─────────────────────────────

test('an older renderer answering a URL job posts flat and is attributed to the first default device', async () => {
	seedUrlRow();
	await claim();
	// No `variants`, no `deviceType`: a pre-1.23.0 renderer rendered `job.deviceType` (desktop) and posted
	// the legacy envelope with the row key as `id`.
	await post({ id: A, url: A, statusCode: 200, outcome: 'rendered', isIndexable: true, headers: {} }, [
		'<html>old renderer</html>',
	]);
	assert.equal(stores.prerenderedPage.get(key(A, 'desktop')).content.toString(), '<html>old renderer</html>');
	assert.equal(
		stores.prerenderedPage.get(key(A, 'mobile')).content,
		'old html',
		'mobile was not rendered — degraded, not broken'
	);
	assert.ok(stores.renderSchedule.get(A).nextRenderTime > Date.now(), 'the URL is rescheduled');
	assert.deepEqual(outcomes(), [['rendered', 'stored']]);
});

// ──────────────── review fixes: refile, verdict order, legacy renderer ────────────────

test('a client-side refile does NOT store the sibling that did not redirect — its target is gone', async () => {
	// One device follows a client-side redirect to a URL we serve; the other renders the source
	// normally. `Target.delete` takes the source target, its schedule row and all of its pages, so
	// writing the sibling's page back under the source key would leave a blob for a URL with no
	// target and no schedule row: never re-rendered, never reclaimed, and still served to bots as a
	// 200 for a URL the origin redirects away from.
	seedUrlRow();
	stores.target.set(B, { url: B, renderInterval: 3_600_000 });
	await postVariants(A, [
		rendered('desktop', '<html>landed on b</html>', { redirectedTo: B }),
		rendered('mobile', '<html>still a</html>'),
	]);

	assert.equal(stores.target.has(A), false, 'the source target was retired with the refile');
	assert.equal(stores.prerenderedPage.has(key(A, 'mobile')), false, 'the sibling was NOT written back under it');
	assert.equal(stores.prerenderedPage.has(key(A, 'desktop')), false);
	assert.ok(
		infos.some((line) => String(line).includes('discarding the mobile render')),
		`the discard is reported, got: ${JSON.stringify(infos)}`
	);
	assert.equal(stores.prerenderedPage.has(key(B, 'desktop')), true, 'the refiled page landed on the destination');
});

test('a verdict outranks a refile: the target is suppressed, never deleted and re-minted', async () => {
	// Documented precedence is redirect, then verdict, then rendered. With the refile running first
	// it deleted the target and `Target.suppress` then CREATED the row again — re-minting the very
	// target that had just been deleted, as suppressed and carrying a strike.
	seedUrlRow();
	stores.target.set(B, { url: B, renderInterval: 3_600_000 });
	await postVariants(A, [
		rendered('desktop', '<html>landed on b</html>', { redirectedTo: B }),
		{
			deviceType: 'mobile',
			statusCode: 200,
			outcome: 'non-indexable',
			reason: 'noindex',
			isIndexable: false,
			headers: {},
			renderTime: 90,
			structuredOffers: null,
		},
	]);

	const target = stores.target.get(A);
	assert.ok(target, 'the target survives a verdict — suppression is not deletion');
	assert.equal(target.state, 'suppressed');
	assert.deepEqual(outcomes(), [['suppressed', 'noindex']], 'one outcome, and it is the verdict');
	assert.equal(stores.prerenderedPage.has(key(B, 'desktop')), false, 'nothing was refiled onto the destination');
});

test('a flat result on a URL row is counted and warned about — an un-upgraded renderer is otherwise silent', async () => {
	// A pre-1.23.0 worker renders ONE device of a multi-device job and posts it flat. The URL still
	// reschedules as a success (making the others `not-attempted` would burn the corpus's strikes
	// against a merely-old fleet), so this counter and warning are the only evidence it happened.
	seedUrlRow();
	await post({ id: A, url: A, statusCode: 200, outcome: 'rendered', isIndexable: true, headers: {}, renderTime: 50 });

	const legacy = analytics.filter((a) => a[1] === 'prerender_ops' && a[2] === 'legacy_renderer');
	assert.equal(legacy.length, 1, 'counted once for the result');
	assert.equal(legacy[0][3], 'desktop', 'tagged with the device it actually rendered');
	// The counter is what is asserted because it fires on every result. Its companion log line is
	// deliberately rate-limited to once an hour per node — a stale pod produces one of these for
	// every job it claims, and a line per render would bury the thing it is warning about — so
	// whether it appears here depends on what ran earlier in the file.
	assert.equal(stores.prerenderedPage.has(key(A, 'desktop')), true, 'and the one device it did render is stored');
});
