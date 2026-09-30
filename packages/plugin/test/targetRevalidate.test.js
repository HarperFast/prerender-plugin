import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * `Target.revalidate` — the fan-out sweep that brings matching targets due now.
 *
 * Two properties, both about rows it must not file where nothing will read them:
 *
 *   - THE DUE MINUTE IS PER URL, never captured once for the sweep. Phase 2 writes up to
 *     `scan.collectCap` × devices rows with a point read per key, which at scale runs for tens of
 *     minutes. Schedule rows are residency-routed, so ~75% of them land on nodes whose claim floor
 *     this process cannot lower and which hold it at `nowMinute − queue.claimFloor.guard`: a row
 *     stamped with a minute older than the guard band lands BELOW the owner's floor and is never
 *     claimed again. Silently, from a fully funnel-routed in-plugin write, and permanently wherever
 *     `queue.claimFloor.resetInterval` is 0.
 *   - A TARGET ROW WITH NO `url` IS SKIPPED. `collectFromScan` skips on `undefined`/`null`, and
 *     since `pick` here returns an object that stopped being automatic.
 */

const DEVICES = ['desktop', 'mobile'];
const MINUTE = 60_000;

const stores = { target: new Map(), renderSchedule: new Map(), prerenderedPage: new Map() };

let Target, funnel;
const sabs = new Map();
const originalNow = Date.now;

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
		/**
		 * HONOURS `select`, which is the whole point of the projection test below. A fake that yields
		 * whole rows regardless makes `sitemapUrl` present no matter what the caller asked for, so the
		 * guard's premise — that the request's projection decides what phase 2 can see — is never
		 * exercised and the assertion passes for a reason unrelated to what it claims.
		 */
		static async *search(query = {}) {
			const { select } = query;
			const project = (row) =>
				typeof select === 'string'
					? { [select]: row[select] }
					: Array.isArray(select)
						? Object.fromEntries(select.map((name) => [name, row[name]]))
						: { ...row };
			for (const row of [...rows.values()]) yield project(row);
		}
	};

before(async () => {
	globalThis.server = { hostname: 'test-node', nodes: [], config: { http: { port: 9926 } } };
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {} };
	globalThis.databases = {
		// Target.delete removes the probe baseline alongside the cached pages.
		probe_state: { ProbeState: { delete: async () => {} }, RenderExpectation: { delete: async () => {} } },
		coordination: {
			SharedBuffer: {
				primaryStore: {
					getUserSharedBuffer: (key, buffer) => {
						if (!sabs.has(key)) sabs.set(key, buffer);
						return sabs.get(key);
					},
					tryLock: () => true,
					unlock() {},
				},
			},
		},
		render_service: { Target: makeResourceBase(stores.target) },
		render_schedule: { RenderSchedule: makeResourceBase(stores.renderSchedule) },
		page_cache: { PrerenderedPage: makeResourceBase(stores.prerenderedPage) },
	};

	({ Target } = await import('../src/resources/Target.js'));
	funnel = await import('../src/util/renderSchedule.js');
});

beforeEach(() => {
	for (const rows of Object.values(stores)) rows.clear();
	funnel.resetRenderQueueState();
});

afterEach(() => {
	Date.now = originalNow;
});

test('every URL is filed at the minute IT was written, not at the minute the sweep started', async () => {
	const urls = Array.from({ length: 4 }, (_, i) => `https://www.example.com/p${i}`);
	for (const url of urls) stores.target.set(url, { url });

	// A slow sweep: the clock advances a minute per page lookup, which is what a real one does over
	// hundreds of thousands of rows.
	let now = 1_700_000_400_000;
	Date.now = () => now;
	const PrerenderedPage = globalThis.databases.page_cache.PrerenderedPage;
	const realGet = PrerenderedPage.get.bind(PrerenderedPage);
	PrerenderedPage.get = async (query) => {
		now += MINUTE;
		return realGet(query);
	};

	try {
		const result = await Target.revalidate({});
		assert.equal(result.revalidating, urls.length);
	} finally {
		PrerenderedPage.get = realGet;
	}

	// One row per URL, keyed by the URL: the revalidated render covers every device in one job.
	const filed = urls.map((url) => Number(stores.renderSchedule.get(url).nextRenderTime));
	assert.equal(filed.length, 4);
	// Filed at the minute each row is WRITTEN (`fileDueNow` reads the clock at the write), so none can
	// carry the sweep's starting minute — which would rank the last rows as if they had waited the
	// whole sweep.
	const startMinute = Math.floor(1_700_000_400_000 / MINUTE) * MINUTE;
	assert.ok(
		filed.every((minute) => minute > startMinute),
		`each URL is stamped at its own write (got ${filed.join(', ')}), never the sweep's first minute ${startMinute}`
	);
	for (const url of urls) {
		for (const device of DEVICES) {
			assert.equal(stores.renderSchedule.has(`${url}|${device}`), false, 'no per-device schedule rows');
		}
	}
});

test('a revalidate LOWERS a page expiry and never raises one — a probe hard-expiry stays hard', async () => {
	// The change probe backdates a known-wrong page past the swr window. A revalidate that ran before its
	// render landed used to set `expiresAt: now`, putting it back into stale-while-revalidate serving.
	const url = 'https://www.example.com/hard';
	stores.target.set(url, { url });
	const hard = Date.now() - 3 * 60 * MINUTE;
	for (const device of DEVICES)
		stores.prerenderedPage.set(`${url}|${device}`, { cacheKey: `${url}|${device}`, expiresAt: hard });
	await Target.revalidate({});
	for (const device of DEVICES) {
		assert.equal(
			Number(stores.prerenderedPage.get(`${url}|${device}`).expiresAt),
			hard,
			`${device} stays hard-expired`
		);
	}
});

test('the sitemap flag survives the sweep — put REPLACES the schedule record', async () => {
	const listed = 'https://www.example.com/listed';
	const unlisted = 'https://www.example.com/unlisted';
	stores.target.set(listed, { url: listed, sitemapUrl: 'https://www.example.com/sitemap.xml' });
	stores.target.set(unlisted, { url: unlisted, sitemapUrl: null });

	await Target.revalidate({});

	assert.equal(
		stores.renderSchedule.get(listed).fromSitemap,
		true,
		'a cleared flag makes claim report isFromSitemap:false, and the renderer then skips serializing a ' +
			'non-indexable sitemap-listed page — i.e. a revalidate quietly stops those pages being cached'
	);
	assert.equal(stores.renderSchedule.get(unlisted).fromSitemap, false);
});

test('a caller projection that cannot support the sweep is refused by name, not silently trusted', async () => {
	const url = 'https://www.example.com/listed';
	stores.target.set(url, { url, sitemapUrl: 'https://www.example.com/sitemap.xml' });

	// `?select(url)` on the action request. An ABSENT sitemapUrl is indistinguishable from a null one,
	// so trusting the projection re-opens the clobber above on every matched key; dropping `url`
	// instead makes the sweep skip every row and report success. Both are silent.
	for (const select of [['url'], ['sitemapUrl'], 'url', ['strikes', 'state']]) {
		await assert.rejects(
			() => Target.revalidate({ select }),
			/omits url or sitemapUrl/,
			`select ${JSON.stringify(select)}`
		);
	}
	assert.equal(stores.renderSchedule.size, 0, 'and it refuses before writing anything');

	// The full projection runs, and — because the fake `search` above honours `select` — this also
	// asserts the thing the guard exists for: the two fields it insists on are the two phase 2 needs,
	// so the flag survives a projected sweep. Under a fake that ignored `select` the row carried
	// `sitemapUrl` whatever the caller asked for, and this assertion proved nothing about projections.
	await Target.revalidate({ select: ['url', 'sitemapUrl'] });
	assert.equal(stores.renderSchedule.size, 1, 'one row per URL');
	assert.equal(stores.renderSchedule.get(url).fromSitemap, true, 'from the projected row');
});

test('a target row with no url is skipped instead of scheduling the string "undefined"', async () => {
	stores.target.set('https://www.example.com/real', { url: 'https://www.example.com/real' });
	// A row with no `url` — a partial write, or a projection that did not include it.
	stores.target.set('broken', { sitemapUrl: 'https://www.example.com/sitemap.xml' });

	const result = await Target.revalidate({});

	assert.equal(result.revalidating, 1, 'only the usable row');
	assert.equal(result.examined, 2, 'while still reporting everything the walk saw');
	assert.deepEqual(
		[...stores.renderSchedule.keys()].sort(),
		['https://www.example.com/real'],
		'no schedule rows (and no floor lowering) for a URL that does not exist'
	);
});

// A patch of a MISSING record creates one holding only the patched fields (this fake's `patch` merges
// onto nothing, as Harper's does), and Harper writes the key attribute only when the patch names it.
// Every patch of a row that may have just been deleted therefore carries its key.
test('the revalidate expiry patch carries the page key, so one racing a delete cannot leave a keyless stub', async () => {
	const url = 'https://www.example.com/raced';
	stores.target.set(url, { url });
	for (const device of DEVICES) stores.prerenderedPage.set(`${url}|${device}`, { expiresAt: Date.now() + 3_600_000 });
	await Target.revalidate({});
	for (const device of DEVICES)
		assert.equal(stores.prerenderedPage.get(`${url}|${device}`).cacheKey, `${url}|${device}`);
});

test('reactivate carries the url: a target deleted a moment earlier comes back addressable, not as a url-less stub', async () => {
	const url = 'https://www.example.com/reactivated';
	await Target.reactivate(url);
	assert.deepEqual(stores.target.get(url), {
		url,
		state: null,
		suppressedReason: null,
		suppressedAt: null,
		strikes: 0,
	});
});

test('a revalidate over a collection is not an ask: its rows carry no urgent mark; one naming a single URL is', async () => {
	// Marked, a route-wide revalidate (up to its whole match set) queued ahead of every page the probe found
	// changed while it drained — changed pages are answered from the origin, revalidated ones from the cache.
	const urls = Array.from({ length: 3 }, (_, i) => `https://www.example.com/bulk${i}`);
	for (const url of urls) stores.target.set(url, { url });
	await Target.revalidate({});
	for (const url of urls) assert.equal('urgentAt' in stores.renderSchedule.get(url), false, url);

	for (const rows of Object.values(stores)) rows.clear();
	const one = 'https://www.example.com/one';
	stores.target.set(one, { url: one });
	await Target.revalidate({});
	assert.ok(stores.renderSchedule.get(one).urgentAt > 0, 'a revalidate that names one URL is an ask');
});
