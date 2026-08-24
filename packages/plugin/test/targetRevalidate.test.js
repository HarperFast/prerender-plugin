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
		probe_state: { ProbeState: { delete: async () => {} } },
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

	const filed = urls.map((url) => Number(stores.renderSchedule.get(`${url}|desktop`).nextRenderTime));
	assert.equal(filed.length, 4);
	assert.ok(
		filed[filed.length - 1] > filed[0],
		`each URL is stamped with its own minute (got ${filed.join(', ')}) — one capture for the whole ` +
			`sweep would file the last rows below the owning node's floor`
	);
	for (const [i, url] of urls.entries()) {
		for (const device of DEVICES) {
			assert.equal(
				Number(stores.renderSchedule.get(`${url}|${device}`).nextRenderTime),
				filed[i],
				'a URL’s device variants still share one minute'
			);
		}
	}
});

test('the sitemap flag survives the sweep — put REPLACES the schedule record', async () => {
	const listed = 'https://www.example.com/listed';
	const unlisted = 'https://www.example.com/unlisted';
	stores.target.set(listed, { url: listed, sitemapUrl: 'https://www.example.com/sitemap.xml' });
	stores.target.set(unlisted, { url: unlisted, sitemapUrl: null });

	await Target.revalidate({});

	for (const device of DEVICES) {
		assert.equal(
			stores.renderSchedule.get(`${listed}|${device}`).fromSitemap,
			true,
			'a cleared flag makes claim report isFromSitemap:false, and the renderer then skips serializing a ' +
				'non-indexable sitemap-listed page — i.e. a revalidate quietly stops those pages being cached'
		);
		assert.equal(stores.renderSchedule.get(`${unlisted}|${device}`).fromSitemap, false);
	}
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
	assert.equal(stores.renderSchedule.size, DEVICES.length);
	for (const device of DEVICES) {
		assert.equal(stores.renderSchedule.get(`${url}|${device}`).fromSitemap, true, 'from the projected row');
	}
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
		['https://www.example.com/real|desktop', 'https://www.example.com/real|mobile'],
		'no schedule rows (and no floor lowering) for a URL that does not exist'
	);
});
