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
		static async *search() {
			for (const row of [...rows.values()]) yield { ...row };
		}
	};

before(async () => {
	globalThis.server = { hostname: 'test-node', nodes: [], config: { http: { port: 9926 } } };
	globalThis.logger = { info() {}, warn() {}, error() {} };
	globalThis.databases = {
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
