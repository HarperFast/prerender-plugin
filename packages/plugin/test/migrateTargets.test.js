import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The one-shot legacy-registry migration (pre-v0.19 per-device RenderTarget rows → url-keyed
 * Target rows).
 *
 * The property that matters most is what it does NOT touch: RenderSchedule,
 * PrerenderedPage, AND the legacy rows themselves all survive byte-for-byte — the first two
 * because losing them means re-rendering the entire cache, the last because it keeps
 * rollback to pre-v0.19 clean. The rest: keyset pagination that never holds a cursor across
 * writes, absent-only writes (crashed/repeated runs converge), and the cluster queue paused
 * around the rebuild — unless an operator had already paused it, in which case their intent
 * survives.
 */

const key = (url, device) => `${url}|${device}`;
const A = 'https://site.example.com/product/a';
const B = 'https://site.example.com/product/b';

const stores = {
	legacy: new Map(),
	target: new Map(),
	renderSchedule: new Map(),
	prerenderedPage: new Map(),
	queueControl: new Map(),
};

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
		// Models the two query shapes the migration issues: the bare limit-1 existence probe,
		// and keyset pages (`cacheKey greater_than <afterKey|true>` + limit) returned in
		// primary-key order, like the real store's range scan.
		static async *search(query = {}) {
			const keyset = query.conditions?.find((c) => c.attribute === 'cacheKey' && c.comparator === 'greater_than');
			let entries = [...rows.values()];
			if (keyset) {
				entries = entries
					.filter((row) => keyset.value === true || row.cacheKey > keyset.value)
					.sort((a, b) => (a.cacheKey < b.cacheKey ? -1 : 1));
			}
			let yielded = 0;
			for (const row of entries) {
				if (query.limit !== undefined && yielded >= query.limit) return;
				yielded++;
				yield { ...row };
			}
		}
	};

let migrate;

before(async () => {
	globalThis.Resource = class {};
	globalThis.server = {
		hostname: 'test-node',
		nodes: [],
		workerIndex: 0,
		config: { http: { port: 9926 } },
		recordAnalytics() {},
	};
	globalThis.logger = { info() {}, warn() {}, error() {} };
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
			RenderTarget: makeResourceBase(stores.legacy),
			Target: makeResourceBase(stores.target),
			QueueControl: makeResourceBase(stores.queueControl),
			QueueStatus: makeResourceBase(new Map()),
		},
		render_schedule: { RenderSchedule: makeResourceBase(stores.renderSchedule) },
		page_cache: { PrerenderedPage: makeResourceBase(stores.prerenderedPage) },
	};

	migrate = await import('../src/util/migrateTargets.js');
});

beforeEach(() => {
	for (const rows of Object.values(stores)) rows.clear();
});

const seedLegacy = (url, { devices = ['desktop', 'mobile'], sitemapUrl = null, renderInterval = 3_600_000 } = {}) => {
	for (const device of devices) {
		const cacheKey = key(url, device);
		stores.legacy.set(cacheKey, { cacheKey, url, deviceType: device, sitemapUrl, renderInterval });
		stores.renderSchedule.set(cacheKey, { nextRenderTime: 7_777_777_777_777, fromSitemap: !!sitemapUrl });
		stores.prerenderedPage.set(cacheKey, { statusCode: 200, content: `cached ${cacheKey}` });
	}
};

test('rebuilds one Target row per URL and leaves the legacy rows in place (rollback insurance)', async () => {
	seedLegacy(A, { sitemapUrl: 'https://site.example.com/sitemap.xml', renderInterval: 1234567 });
	seedLegacy(B);

	const stats = await migrate.runTargetMigration();

	assert.equal(stats.legacyRows, 4);
	assert.equal(stats.created, 2);

	const a = stores.target.get(A);
	assert.equal(a.sitemapUrl, 'https://site.example.com/sitemap.xml');
	assert.equal(a.renderInterval, 1234567);
	assert.equal(a.schedulerNode, 'test-node');
	assert.notEqual(a.state, 'suppressed');

	assert.equal(stats.existing, 2, 'each URL sibling device row is covered by the first row seen');
	assert.equal(stores.legacy.size, 4, 'legacy rows must SURVIVE — pre-v0.19 code still finds its registry on rollback');
});

test('NEVER touches schedules or cached pages — the whole point is zero re-renders', async () => {
	seedLegacy(A, { sitemapUrl: 'https://site.example.com/sitemap.xml' });
	const schedulesBefore = new Map([...stores.renderSchedule].map(([k, v]) => [k, { ...v }]));
	const pagesBefore = new Map([...stores.prerenderedPage].map(([k, v]) => [k, { ...v }]));

	await migrate.runTargetMigration();

	assert.deepEqual(new Map(stores.renderSchedule), schedulesBefore, 'schedule rows (and their jitter) must survive');
	assert.deepEqual(new Map(stores.prerenderedPage), pagesBefore, 'cached pages must survive');
});

test('absent-only: an existing Target row (parallel node, live traffic) is never clobbered', async () => {
	seedLegacy(A, { renderInterval: 1 });
	stores.target.set(A, { url: A, renderInterval: 999, state: 'suppressed', strikes: 3 });

	const stats = await migrate.runTargetMigration();

	assert.equal(stats.existing, 2, 'both device rows skip over the existing target');
	assert.equal(stats.created, 0);
	assert.deepEqual(stores.target.get(A), { url: A, renderInterval: 999, state: 'suppressed', strikes: 3 });
});

test('a re-trigger after completion creates nothing (absent-only over surviving legacy rows)', async () => {
	seedLegacy(A);
	await migrate.runTargetMigration();
	const again = await migrate.runTargetMigration();
	assert.equal(again.created, 0);
	assert.equal(again.existing, again.legacyRows, 'every legacy row is already covered');
});

test('an empty legacy table (fresh deployment) skips without pausing anything', async () => {
	const result = await migrate.runTargetMigration();
	assert.equal(result.skipped, true);
	assert.equal(stores.queueControl.size, 0, 'no pause intent should ever have been written');
});

test('the run summary and live progress are exposed for the admin poll', async () => {
	seedLegacy(A);
	const run = await migrate.runTargetMigration();
	assert.equal(run.error, null);
	assert.equal(run.node, 'test-node');
	const status = migrate.getMigrationStatus();
	assert.equal(status.running, false);
	assert.equal(status.lastOutcome, 'completed', 'the outcome flag is the cross-worker completion signal');
	assert.deepEqual(status.lastRun, run);
	assert.equal(status.progress.legacyRows, run.legacyRows, 'progress counters reflect the completed sweep');
});

test('concurrent triggers yield exactly ONE sweep — the CAS guard, not module state', async () => {
	// The v0.19.1 prod migration proved why: requests land on arbitrary workers, per-worker
	// state let every poll start a redundant sweep, and Harper's write-conflict detection
	// then killed the racing losers ("After 40 retries, unable to commit"). The Atomics CAS
	// on the node-shared buffer makes the second trigger a no-op instead of a coin-flip.
	seedLegacy(A);
	const [first, second] = await Promise.all([migrate.runTargetMigration(), migrate.runTargetMigration()]);

	const outcomes = [first, second];
	const ran = outcomes.filter((o) => !o.skipped);
	const refused = outcomes.filter((o) => o.skipped);
	assert.equal(ran.length, 1, 'exactly one sweep runs');
	assert.equal(refused.length, 1);
	assert.match(refused[0].reason, /already running/);
	assert.equal(stores.target.size, 1, 'the registry is written once');
});

test('pauses the cluster for the rebuild and resumes after', async () => {
	seedLegacy(A);

	// Observe the intent row while the migration runs: the write path goes through
	// RenderQueue.setPause, so a pause must be visible mid-flight and gone at the end.
	let sawPausedDuringRebuild = false;
	const TargetTable = globalThis.databases.render_service.Target;
	const originalPut = TargetTable.put.bind(TargetTable);
	TargetTable.put = async (id, data) => {
		if (stores.queueControl.get('all')?.paused === true) sawPausedDuringRebuild = true;
		return originalPut(id, data);
	};
	try {
		await migrate.runTargetMigration();
	} finally {
		TargetTable.put = originalPut;
	}

	assert.equal(sawPausedDuringRebuild, true, 'the registry rebuild must happen under the cluster pause');
	assert.equal(stores.queueControl.has('all'), false, 'the pause intent must be lifted afterward');
});

test('an operator pause outranks the migration — it is never resumed on their behalf', async () => {
	seedLegacy(A);
	stores.queueControl.set('all', { paused: true, updatedBy: 'operator' });

	await migrate.runTargetMigration();

	assert.equal(stores.queueControl.get('all')?.paused, true, 'the operator intent must survive the migration');
});

test('half-pairs and BigInt intervals migrate cleanly', async () => {
	// A URL with only one device row (a historical half-write) still becomes a full Target;
	// the new reconcile sweep backfills its missing device schedule on its own cadence.
	stores.legacy.set(key(A, 'desktop'), {
		cacheKey: key(A, 'desktop'),
		url: A,
		deviceType: 'desktop',
		sitemapUrl: null,
		renderInterval: 3600000n,
	});

	const stats = await migrate.runTargetMigration();

	assert.equal(stats.created, 1);
	const target = stores.target.get(A);
	assert.ok(target);
	assert.equal(target.renderInterval, 3600000, 'BigInt Long coerced to a number');
});

test('keyset pagination visits every row exactly once across page boundaries', async () => {
	// Force many pages with pageSize 1: the sweep must advance strictly by last-seen key,
	// terminate, and neither skip nor double-create.
	for (let i = 0; i < 7; i++) {
		seedLegacy(`https://site.example.com/product/p${i}`, { devices: ['desktop'] });
	}
	const stats = { legacyRows: 0, created: 0, existing: 0 };
	const sorted = () => [...stores.legacy.values()].sort((a, b) => (a.cacheKey < b.cacheKey ? -1 : 1));

	await migrate.migrateLegacyTargets({
		pageLegacy: async (afterKey, limit) =>
			sorted()
				.filter((row) => afterKey === undefined || row.cacheKey > afterKey)
				.slice(0, limit),
		getTarget: async (url) => stores.target.get(url) ?? null,
		putTarget: async (url, row) => stores.target.set(url, row),
		stats,
		pageSize: 1,
	});

	assert.equal(stats.legacyRows, 7);
	assert.equal(stats.created, 7);
	assert.equal(stores.target.size, 7);
});

test('device rows that disagree resolve to the FIRST row seen; attribution self-heals via sitemap reattach', async () => {
	// Streaming per-row (no in-memory grouping at 1.6M rows), so the first device row wins.
	// A first row missing sitemapUrl creates the target unattributed — the next sitemap
	// refresh REATTACHes it (patch sitemapUrl + renderInterval), so drift heals in a pass.
	stores.legacy.set(key(A, 'desktop'), { cacheKey: key(A, 'desktop'), url: A, sitemapUrl: null, renderInterval: null });
	stores.legacy.set(key(A, 'mobile'), {
		cacheKey: key(A, 'mobile'),
		url: A,
		sitemapUrl: 'https://site.example.com/sitemap.xml',
		renderInterval: 60000,
	});

	await migrate.runTargetMigration();

	const target = stores.target.get(A);
	assert.ok(target, 'the URL is targeted either way');
	assert.equal(target.sitemapUrl, null, 'first row seen wins — reattach owns the correction');
});
