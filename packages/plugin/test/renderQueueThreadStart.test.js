import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { publishDueRows } from './support/keeperStandIn.js';

/**
 * A thread Harper has just started can take `claim` or `job_result` before its `coordination` database
 * is loaded. Both used to throw a TypeError on the first lease read and answer 500, which the fleet logs
 * as an error. Pinned here: both answer 503 with a Retry-After, release nothing, and answer exactly as
 * before once the database is there.
 *
 * Its own file, and one test: the lease table is allocated on first use and kept for the life of the
 * module, so only a module that has never claimed is a just-started thread.
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

const makeResourceBase = (rows) =>
	class FakeResource {
		constructor(id) {
			this.__id = id;
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
	};

let RenderQueue, funnel, coordination;
const sabs = new Map();

before(async () => {
	globalThis.Resource = class {};
	globalThis.server = {
		hostname: 'test-node',
		nodes: [],
		config: { http: { port: 9926 } },
		recordAnalytics() {},
	};
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {} };
	globalThis.createBlob = (buf) => buf;
	coordination = {
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
	};
	globalThis.databases = {
		probe_state: {
			ProbeState: { delete: async () => {} },
			RenderExpectation: makeResourceBase(stores.renderExpectation),
		},
		coordination,
		render_service: {
			Target: makeResourceBase(stores.target),
			QueueControl: makeResourceBase(new Map()),
			QueueStatus: makeResourceBase(new Map()),
		},
		render_schedule: { RenderSchedule: makeResourceBase(stores.renderSchedule) },
		page_cache: { PrerenderedPage: makeResourceBase(stores.prerenderedPage) },
	};

	await import('../src/config.js');
	({ RenderQueue } = await import('../src/resources/RenderQueue.js'));
	funnel = await import('../src/util/renderSchedule.js');
});

/** Post a result the way the browser's `postResult` frames it: JSON envelope, then the bodies. */
const postRendered = (url) => {
	const bodies = DEVICES.map((device) => Buffer.from(`<html>${device}</html>`));
	const variants = DEVICES.map((deviceType, i) => ({
		deviceType,
		statusCode: 200,
		outcome: 'rendered',
		isIndexable: true,
		headers: {},
		renderTime: 100,
		contentLength: bodies[i].byteLength,
	}));
	const meta = Buffer.from(JSON.stringify({ id: url, url, deviceTypes: DEVICES, variants }), 'utf8');
	const ctx = { headers: new Map([['x-metadata-size', String(meta.byteLength)]]) };
	return RenderQueue.processJobResult(Buffer.concat([meta, ...bodies]), ctx);
};

const assertNotLoadedYet = (response, what) => {
	assert.ok(response instanceof Response, `${what}: a Response, not a throw`);
	assert.equal(response.status, 503, what);
	assert.equal(response.headers.get('retry-after'), '2', what);
};

test('before the coordination database is loaded, claim and job_result answer 503 + Retry-After; after, as before', async () => {
	stores.target.set(A, { url: A, renderInterval: 3_600_000 });
	stores.renderSchedule.set(A, { nextRenderTime: 1, fromSitemap: false, effectiveInterval: 3_600_000 });

	delete databases.coordination;
	assertNotLoadedYet(await RenderQueue.claim({ limit: 10 }), 'claim');
	assertNotLoadedYet(await postRendered(A), 'job_result');
	assert.equal(stores.prerenderedPage.size, 0, 'nothing stored');

	// Loaded: the claim is the bare array it always was.
	databases.coordination = coordination;
	publishDueRows(funnel, stores.renderSchedule);
	const jobs = await RenderQueue.claim({ limit: 10 });
	assert.ok(Array.isArray(jobs));
	assert.deepEqual(
		jobs.map((job) => job.id),
		[A]
	);

	// A result refused for the same reason keeps its lease, so the fleet's retry lands.
	delete databases.coordination;
	assertNotLoadedYet(await postRendered(A), 'job_result with a lease out');
	databases.coordination = coordination;
	assert.ok(funnel.leaseInfo(A), 'the 503 released nothing');
	assert.equal(await postRendered(A), undefined);
	assert.equal(stores.prerenderedPage.get(key(A, 'desktop')).content.toString(), '<html>desktop</html>');
	assert.equal(funnel.leaseInfo(A), null, 'the lease is released');
});
