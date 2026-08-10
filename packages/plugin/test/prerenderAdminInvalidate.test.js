import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * `PrerenderAdmin.invalidate()` — the operator door. First API-level tests for it; the property
 * pinned first is the one a review round found broken:
 *
 *   CLEARING RUNS BEFORE THE CLOSED-SET CHECK. The row that most needs clearing is one whose
 *   scope has STOPPED resolving (a route renamed or removed by a live config edit — the exact
 *   state `checkScopeResolvability` warns about). With validation first, the documented
 *   remediation ("either re-enable it or clear the rows") answered `400 Unknown scope`, and the
 *   row was undeletable through the only authenticated door.
 *
 * The closed-set check itself still guards the RECORD path, and the clear path still 404s a
 * scope that was never recorded — both asserted here so the reorder cannot silently widen.
 */

const invRows = new Map();

let PrerenderAdmin, config;

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

	// PrerenderAdmin transitively imports most of the plugin; every table it touches gets an
	// inert class-shaped fake (several resources `extend` their table, so these must be
	// constructors). Only the invalidation table carries real in-memory contents.
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
	class FakeInvalidation extends mkTable() {
		static async get(query) {
			const id = typeof query === 'object' ? query.id : query;
			const row = invRows.get(id);
			return row ? { ...row } : null;
		}
		static async put(id, data) {
			invRows.set(id, { scope: id, ...data });
		}
		static async delete(id) {
			return invRows.delete(id);
		}
		static async *search() {
			for (const row of invRows.values()) yield { ...row };
		}
	}
	globalThis.databases = new Proxy(
		{},
		{
			get: (_, db) =>
				db === 'invalidation'
					? new Proxy({}, { get: () => FakeInvalidation })
					: new Proxy({}, { get: () => mkTable() }),
		}
	);
	globalThis.transaction = (fn) => fn({});

	({ config } = await import('../src/config.js'));
	({ PrerenderAdmin } = await import('../src/resources/PrerenderAdmin.js'));
});

const at = (ms) => new Date(ms).toISOString();

beforeEach(() => {
	invRows.clear();
	config.invalidation.enabled = true;
	config.ingress.routes = [{ match: 'prefix', path: '/catalog/' }];
});

test('clearing a scope whose route was renamed away still works — the stale row is deletable', async () => {
	// The row was recorded while `route:prefix:/gone/` resolved; the route has since been renamed.
	invRows.set('route:prefix:/gone/', { scope: 'route:prefix:/gone/', invalidatedAt: at(5_000_000) });

	const res = await PrerenderAdmin.invalidate({ scope: 'route:prefix:/gone/', mode: null }, {});
	assert.equal(res.status, 200);
	const body = await res.json();
	assert.equal(body.wasInvalidatedAt, at(5_000_000));
	assert.equal(invRows.has('route:prefix:/gone/'), false, 'the stale row is gone');
});

test('clearing a scope that was never recorded is a 404, resolvable or not', async () => {
	const resolvable = await PrerenderAdmin.invalidate({ scope: 'route:prefix:/catalog/', mode: null }, {});
	assert.equal(resolvable.status, 404);
	const unresolvable = await PrerenderAdmin.invalidate({ scope: 'route:prefix:/nothing/', mode: null }, {});
	assert.equal(unresolvable.status, 404);
});

test('RECORDING an unresolvable scope is still refused with the valid literals', async () => {
	const res = await PrerenderAdmin.invalidate({ scope: 'route:prefix:/typo/', reason: 'x' }, {});
	assert.equal(res.status, 400);
	const body = await res.json();
	assert.match(body.error, /Unknown scope/);
	assert.deepEqual(body.knownScopes, ['all', 'route:prefix:/catalog/']);
	assert.equal(invRows.size, 0, 'nothing was written');
});

test('record → clear roundtrip works and reports from what it did', async () => {
	const rec = await PrerenderAdmin.invalidate({ scope: 'all', reason: 'price event' }, { user: { username: 'op' } });
	assert.equal(rec.status, 200);
	assert.equal(invRows.has('all'), true);

	const clr = await PrerenderAdmin.invalidate({ scope: 'all', mode: null }, { user: { username: 'op' } });
	assert.equal(clr.status, 200);
	assert.equal(invRows.has('all'), false);
});
