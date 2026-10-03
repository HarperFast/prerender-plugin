import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * `POST /prerender_admin/config-override` and `GET /prerender_admin/config` against an in-memory
 * `config.ConfigOverride`.
 *
 * A LIST WITH ENTRIES THE COMPILER DROPS IS REFUSED. `ingress.routes` and `changeProbe.rules` are
 * stored and merged whole, so the resolve check passes them, and the route or probe compiler then
 * quietly leaves the bad entries out. Before v0.97.0 the apply answered `applied: true` with the
 * drop reported beside it, which stored a route that was in the table and not in the router. Now the
 * dropped entries are `rejected`, in the preview and in the refusal alike — those the set NEWLY drops,
 * since one the running value already drops rides along in every whole-list edit the console sends.
 *
 * THE CONFIG VIEW REPORTS AN OVERRIDE MASKING A FILE CHANGE: each row records the file's value hash
 * when it is written, and the layers view compares it with the file now.
 */

const overrideRows = new Map();

let PrerenderAdmin, applyOptions, hashConfigValue;

before(async () => {
	globalThis.Resource = class {
		static loadAsInstance;
	};
	globalThis.server = {
		hostname: 'test-node',
		nodes: [],
		workerIndex: 1,
		recordAnalytics() {},
		config: { http: { securePort: 9926 } },
	};
	globalThis.logger = { info() {}, warn() {}, error() {}, notify() {}, debug() {}, trace() {} };
	globalThis.contentTypes = { set() {} };

	const mkTable = () =>
		class FakeTable {
			static async get() {
				return null;
			}
			static async put() {}
			static async delete() {
				return true;
			}
			static async *search() {}
			static async subscribe() {}
			static primaryStore = {
				tryLock: () => true,
				unlock() {},
				getUserSharedBuffer: (key, buf) => new SharedArrayBuffer(buf?.byteLength ?? 8),
			};
		};
	class FakeOverride extends mkTable() {
		static async put(path, row) {
			overrideRows.set(path, { path, ...row });
		}
		static async delete(path) {
			return overrideRows.delete(path);
		}
		static async *search() {
			for (const row of overrideRows.values()) yield { ...row };
		}
	}
	const tableFor = (_, table) => (table === 'ConfigOverride' ? FakeOverride : mkTable());
	globalThis.databases = new Proxy({}, { get: () => new Proxy({}, { get: tableFor }) });
	globalThis.transaction = (fn) => fn({});

	({ applyOptions, hashConfigValue } = await import('../src/config.js'));
	({ PrerenderAdmin } = await import('../src/resources/PrerenderAdmin.js'));
});

const FILE_ROUTES = [{ match: 'prefix', path: '/catalog/' }];
const file = (routes = FILE_ROUTES) => ({ ingress: { mode: 'forwarded', routes } });
const operator = { user: { username: 'op' } };

beforeEach(() => {
	overrideRows.clear();
	applyOptions(file(), {});
});

test('a routes set with an entry the compiler would drop is rejected in the preview, and refused on apply', async () => {
	const routes = [
		{ match: 'prefix', path: '/catalog/' },
		{ match: 'nope', path: '/typo/' }, // an invalid match: dropped, not rejected, by the compiler
	];

	const preview = await (
		await PrerenderAdmin.configOverride({ set: [{ path: 'ingress.routes', value: routes }], dryRun: true }, operator)
	).json();
	assert.equal(preview.applied, false);
	assert.equal(preview.rejected.length, 1);
	assert.equal(preview.rejected[0].path, 'ingress.routes');
	assert.equal(preview.rejected[0].dropped, 1);
	assert.match(preview.rejected[0].reason, /the compiler would drop 1 of these entries/);

	const res = await PrerenderAdmin.configOverride({ set: [{ path: 'ingress.routes', value: routes }] }, operator);
	assert.equal(res.status, 409);
	const body = await res.json();
	assert.equal(body.applied, false);
	assert.deepEqual(
		body.rejected.map((entry) => entry.path),
		['ingress.routes']
	);
	assert.equal(overrideRows.size, 0, 'nothing was written');
});

test('a probe rule list with a rule the compiler would drop is refused the same way', async () => {
	const rules = [{ label: 'no-pattern-no-endpoint' }];
	const res = await PrerenderAdmin.configOverride({ set: [{ path: 'changeProbe.rules', value: rules }] }, operator);
	assert.equal(res.status, 409);
	const body = await res.json();
	assert.equal(body.applied, false);
	assert.equal(body.rejected[0].path, 'changeProbe.rules');
	assert.equal(body.rejected[0].dropped, 1);
	assert.equal(overrideRows.size, 0);
});

test('a bad route already in the FILE layer does not block an unrelated edit', async () => {
	applyOptions(file([...FILE_ROUTES, { match: 'nope', path: '/typo/' }]), {});
	const res = await PrerenderAdmin.configOverride({ set: [{ path: 'page.ttl', value: 7000 }] }, operator);
	assert.equal(res.status, 200);
	assert.equal((await res.json()).applied, true);
	assert.equal(overrideRows.get('page.ttl').value, 7000);
});

// The console sends the WHOLE list on a one-entry edit, so a bad entry the file layer already drops rides
// along in every edit of that list. Refusing on it blocked every routes edit, contrary to the intent above.
test('a bad route the running config ALREADY drops does not block an edit of the same list', async () => {
	const bad = { match: 'nope', path: '/typo/' };
	applyOptions(file([...FILE_ROUTES, bad]), {});
	const edited = [...FILE_ROUTES, bad, { match: 'prefix', path: '/store/' }];
	const res = await PrerenderAdmin.configOverride({ set: [{ path: 'ingress.routes', value: edited }] }, operator);
	assert.equal(res.status, 200);
	assert.equal((await res.json()).applied, true);
	assert.deepEqual(overrideRows.get('ingress.routes').value, edited);
});

test('an edit that ADDS a bad route beside one already dropped is refused for the new one only', async () => {
	const bad = { match: 'nope', path: '/typo/' };
	applyOptions(file([...FILE_ROUTES, bad]), {});
	const edited = [...FILE_ROUTES, bad, { match: 'prefix', path: 'no-leading-slash' }, bad];
	const res = await PrerenderAdmin.configOverride({ set: [{ path: 'ingress.routes', value: edited }] }, operator);
	assert.equal(res.status, 409);
	const body = await res.json();
	assert.equal(body.rejected[0].dropped, 2, 'the new entry, and the second copy of the old one');
	assert.equal(overrideRows.size, 0);
});

test('a clean routes set applies and records the file value it was written against', async () => {
	const routes = [{ match: 'prefix', path: '/catalog/', renderInterval: 3_600_000 }];
	const res = await PrerenderAdmin.configOverride({ set: [{ path: 'ingress.routes', value: routes }] }, operator);
	assert.equal(res.status, 200);
	assert.equal((await res.json()).applied, true);
	assert.equal(overrideRows.get('ingress.routes').fileHash, hashConfigValue(FILE_ROUTES));
});

test('GET config reports an override masking a later config.yaml change, in layers and in warnings', async () => {
	const routes = [{ match: 'prefix', path: '/catalog/', renderInterval: 3_600_000 }];
	await PrerenderAdmin.configOverride({ set: [{ path: 'ingress.routes', value: routes }] }, operator);
	const row = overrideRows.get('ingress.routes');

	// The deploy the override now hides: a route added to config.yaml.
	const deployed = [...FILE_ROUTES, { match: 'prefix', path: '/store/' }];
	applyOptions(file(deployed), { 'ingress.routes': row.value }, { 'ingress.routes': row.fileHash });

	const view = await (await PrerenderAdmin.configView()).json();
	const layer = view.layers.find((entry) => entry.path === 'ingress.routes');
	assert.equal(layer.source, 'override');
	assert.equal(layer.masking, true);
	assert.equal(layer.redundant, false);
	assert.ok(
		view.warnings.some((warning) => warning.key === 'ingress.routes' && /masking/.test(warning.message)),
		JSON.stringify(view.warnings)
	);
	assert.equal(view.overrides.rows[0].fileHash, row.fileHash);
});

// ── request sampling ──────────────────────────────────────────────────────────────────────────

const samplerSet = (value, dryRun = false) =>
	PrerenderAdmin.configOverride({ set: [{ path: 'sampling.samplers', value }], dryRun }, operator);

test('a sampler list with an entry the compiler would drop is refused, and nothing is written', async () => {
	for (const value of [
		[{ name: 'pdp', match: { bot: ['Googlebot'] } }], // a misspelled key would widen the match
		[{ name: 'pdp', headers: ['cookie'] }],
		[{ name: 'pdp', headers: ['x-harper-renderer-bypass'] }],
		[{ name: 'pdp', sample: { rate: 2 } }],
		[{ name: 'pdp', fields: ['ip'] }],
	]) {
		const res = await samplerSet(value);
		assert.equal(res.status, 409, JSON.stringify(value));
		const body = await res.json();
		assert.equal(body.rejected[0].path, 'sampling.samplers');
		assert.match(body.rejected[0].reason, /the compiler would drop 1 of these entries/);
	}
	assert.equal(overrideRows.size, 0);
});

test('two samplers sharing a name are refused: the name is the key their records are stored under', async () => {
	const res = await samplerSet([{ name: 'pdp' }, { name: 'pdp', sample: { rate: 0.5 } }]);
	assert.equal(res.status, 409);
	const body = await res.json();
	assert.match(body.rejected[0].reason, /sampler names must be unique: 'pdp' repeated/);
	assert.equal(overrideRows.size, 0);
});

test('a valid sampler list previews as a live change and applies', async () => {
	const value = [
		{
			name: 'revisit-pdp',
			match: { routes: ['/catalog/'], bots: ['Googlebot', 'Bingbot'] },
			sample: { by: 'url', rate: 0.01, salt: 'revisit-1' },
			fields: ['url', 'bot', 'device', 'status', 'cacheStatus', 'conditional', 'sitemap'],
			headers: ['user-agent'],
		},
	];
	const preview = await (await samplerSet(value, true)).json();
	assert.deepEqual(preview.rejected, []);
	assert.equal(preview.changes[0].path, 'sampling.samplers');
	assert.equal(preview.changes[0].willTakeEffect, true);

	const res = await samplerSet(value);
	assert.equal(res.status, 200);
	assert.deepEqual(overrideRows.get('sampling.samplers').value, value);
});

test('GET sampling shows the compiled samplers and the invalid ones; GET samples needs a sampler name', async () => {
	applyOptions(
		{
			...file(),
			sampling: {
				enabled: true,
				samplers: [
					{ name: 'ok', match: { routes: ['/catalog/'] } },
					{ name: 'bad', x: 1 },
				],
			},
		},
		{}
	);
	const params = (query) => ({ get: (key) => query[key] });
	const view = await (await PrerenderAdmin.samplingView(params({}))).json();
	assert.equal(view.enabled, true);
	assert.deepEqual(
		view.worker.samplers.map((s) => s.name),
		[]
	); // this test never starts the worker's sampling: the view reports what the worker runs, not the config
	assert.equal(view.invalid.length, 1);
	assert.match(view.invalid[0], /sampler 'bad' dropped/);
	assert.deepEqual(Object.keys(view.stored.bySampler).sort(), ['bad', 'ok']);

	assert.equal((await PrerenderAdmin.samples(params({}))).status, 400);
	assert.equal((await PrerenderAdmin.samples(params({ sampler: 'a/b' }))).status, 400);
	assert.equal((await PrerenderAdmin.samples(params({ sampler: 'ok', format: 'csv' }))).status, 400);
	const empty = await PrerenderAdmin.samples(params({ sampler: 'ok', format: 'gzip' }));
	assert.equal(empty.status, 200);
	assert.equal(empty.headers.get('content-type'), 'application/gzip');
	assert.equal(empty.headers.get('x-sampling-chunks'), '0');
	assert.equal(empty.headers.get('x-sampling-next'), null);
});
