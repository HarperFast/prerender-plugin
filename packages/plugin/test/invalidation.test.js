import { test, before, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

/**
 * `util/invalidation.js` — the module the whole feature rests on.
 *
 * Every failure mode here is SILENT if it is wrong: the table's normal state is empty, so a
 * resolution bug does not throw, it just serves content somebody deliberately invalidated. That is
 * why each of these is pinned rather than reasoned about:
 *
 *   - PRECEDENCE IS max(at), IN BOTH ORDERS. "Most specific wins" reads as the natural rule and is
 *     the one rule that can silently serve invalidated content: a leftover route-scoped row from a
 *     rehearsal would hide a fresh cluster-wide `all`. No coverage check can catch it, because
 *     coverage enumerates routes, not competing rows.
 *   - THE LKG STORES ABSENCE. Without that, one transient read error after a clear pins a worker on
 *     a deleted epoch for the rest of its life, with the console showing nothing active.
 *   - THE LKG EXPIRES. Without that, so does a permanent read error.
 *   - A ROW WITH NO READABLE `invalidatedAt` APPLIES TO NOTHING, and there is deliberately no
 *     `updatedTime` fallback — `updatedTime` re-stamps on every write, so the fallback would mean
 *     editing `reason` silently re-invalidates the corpus.
 *   - THE READ IS GATED. The whole cost argument is that the epoch is read only when the request
 *     would otherwise have been a cache serve, so the read count itself is a contract.
 */

const MINUTE = 60_000;
const PAD = 2 * MINUTE;

let inv, config;

const rows = new Map();
let reads = [];
let failNext = 0;
let warns = [];
let errors = [];
// The subscription fake: every subscriber, a count of scans, and switches for the failures under test.
let subscribers = [];
let scans = 0;
let subscribeFails = 0;
let scanFails = 0;
let scanGate = null;
let deferWrites = false;
const pending = new Map();
const commitPending = () => {
	for (const [id, row] of pending) row === null ? rows.delete(id) : rows.set(id, row);
	pending.clear();
};

before(async () => {
	globalThis.server = { hostname: 'test-node', nodes: [], recordAnalytics: () => {} };
	globalThis.logger = {
		debug() {},
		info() {},
		warn: (m) => warns.push(String(m)),
		error: (...a) => errors.push(a.map(String).join(' ')),
	};
	globalThis.databases = {
		invalidation: {
			Invalidation: {
				async get(query) {
					const id = typeof query === 'object' ? query.id : query;
					reads.push(id);
					if (failNext > 0) {
						failNext--;
						throw new Error('storage fault');
					}
					const row = rows.get(id);
					if (!row) return null;
					const select = typeof query === 'object' ? query.select : undefined;
					if (Array.isArray(select)) return Object.fromEntries(select.map((n) => [n, row[n]]));
					return { ...row };
				},
				async put(id, data) {
					// `deferWrites` models a write inside a request: invisible to other readers until commit.
					if (deferWrites) pending.set(id, { scope: id, ...data });
					else rows.set(id, { scope: id, ...data });
				},
				async delete(id) {
					if (deferWrites) {
						pending.set(id, null);
						return rows.has(id);
					}
					return rows.delete(id);
				},
				async *search() {
					scans++;
					if (scanGate) await scanGate;
					if (scanFails > 0) {
						scanFails--;
						throw new Error('storage fault');
					}
					for (const row of [...rows.values()]) yield { ...row };
				},
				async subscribe(options) {
					if (subscribeFails > 0) {
						subscribeFails--;
						throw new Error('Can not subscribe to a table without an audit log');
					}
					const subscription = new EventEmitter();
					subscription.options = options;
					subscription.end = () => void (subscription.ended = true);
					subscribers.push(subscription);
					return subscription;
				},
			},
		},
	};

	({ config } = await import('../src/config.js'));
	inv = await import('../src/util/invalidation.js');
});

beforeEach(() => {
	rows.clear();
	reads = [];
	warns = [];
	errors = [];
	failNext = 0;
	subscribers = [];
	scans = 0;
	subscribeFails = 0;
	scanFails = 0;
	scanGate = null;
	deferWrites = false;
	pending.clear();
	inv.resetInvalidationState();
	config.invalidation.enabled = true;
	config.invalidation.syncInterval = 60_000;
	config.invalidation.pad = PAD;
	config.invalidation.lkgMaxAge = 5 * MINUTE;
	config.ingress.routes = [{ match: 'prefix', path: '/catalog/' }];
});

const at = (ms) => new Date(ms).toISOString();
const ROUTE = 'route:prefix:/catalog/';

// ---- precedence ----

test('precedence is max(at) over the applicable scopes — in BOTH insertion orders', async () => {
	// The dangerous direction: a stale route row must NOT hide a fresh `all`. Asserted both ways round
	// so the test cannot pass just because a Map happened to yield the right one first.
	rows.set('all', { scope: 'all', invalidatedAt: at(9_000_000), mode: 'hard' });
	rows.set(ROUTE, { scope: ROUTE, invalidatedAt: at(1_000_000), mode: 'hard' });
	let resolved = await inv.resolveInvalidation(ROUTE);
	assert.equal(resolved.scope, 'all', 'the NEWER epoch wins, not the more specific one');
	assert.equal(resolved.at, 9_000_000 + PAD);

	rows.clear();
	inv.resetInvalidationState();
	rows.set(ROUTE, { scope: ROUTE, invalidatedAt: at(9_000_000), mode: 'hard' });
	rows.set('all', { scope: 'all', invalidatedAt: at(1_000_000), mode: 'hard' });
	resolved = await inv.resolveInvalidation(ROUTE);
	assert.equal(resolved.scope, ROUTE, 'and the route wins when IT is newer');
	assert.equal(resolved.at, 9_000_000 + PAD);
});

test('a route scope only applies to its own route; `all` applies to everything', async () => {
	rows.set(ROUTE, { scope: ROUTE, invalidatedAt: at(5_000_000), mode: 'hard' });

	assert.equal((await inv.resolveInvalidation(ROUTE)).scope, ROUTE);
	// A page on a DIFFERENT route, and a page on no route at all, are untouched by it.
	assert.equal(await inv.resolveInvalidation('route:prefix:/other/'), null);
	assert.equal(await inv.resolveInvalidation(null), null);
});

test('pad is added at RESOLUTION, so it is live-tunable and never baked into a stored value', async () => {
	rows.set('all', { scope: 'all', invalidatedAt: at(5_000_000), mode: 'hard' });
	assert.equal((await inv.resolveInvalidation(null)).at, 5_000_000 + PAD);

	config.invalidation.pad = 0;
	inv.resetInvalidationState();
	assert.equal((await inv.resolveInvalidation(null)).at, 5_000_000, 'the same row, a different pad');
});

// ---- the read count IS the cost argument ----

test('resolution is at most TWO point reads by known key, and one when no route applies', async () => {
	rows.set('all', { scope: 'all', invalidatedAt: at(5_000_000) });

	await inv.resolveInvalidation(ROUTE);
	assert.deepEqual(reads, ['all', ROUTE], 'by known key, never a walk');

	reads = [];
	inv.resetInvalidationState();
	await inv.resolveInvalidation(null);
	assert.deepEqual(reads, ['all'], 'no route scope ⇒ one read');
});

test('the kill switch costs ZERO reads, not one wasted read', async () => {
	rows.set('all', { scope: 'all', invalidatedAt: at(5_000_000) });
	config.invalidation.enabled = false;

	assert.equal(await inv.resolveInvalidation(ROUTE), null);
	assert.deepEqual(reads, [], 'disabled means the serve path never touches the table');
});

// ---- invalid rows ----

test('a row with no readable invalidatedAt applies to NOTHING, and says so', async () => {
	// There is deliberately no updatedTime fallback: updatedTime re-stamps on every write, so a
	// fallback would re-invalidate the whole scope every time somebody fixed a typo in `reason`.
	rows.set('all', { scope: 'all', mode: 'hard', reason: 'no epoch', updatedTime: at(9_000_000) });

	assert.equal(await inv.resolveInvalidation(null), null, 'not "invalidated since 1970", and not updatedTime');
	// error since the log relevel: this is somebody's deliberate invalidation being silently
	// inert — the one outcome the feature must never produce.
	assert.ok(
		errors.some((w) => w.includes('no readable invalidatedAt')),
		'and it is reported — a row that applies to nothing must not be silent'
	);
});

test('an unrecognised mode is treated as hard (the safe direction) and reported', async () => {
	rows.set('all', { scope: 'all', invalidatedAt: at(5_000_000), mode: 'sideways' });

	const resolved = await inv.resolveInvalidation(null);
	assert.ok(resolved, 'refusing to apply it would be the UNSAFE direction — a typo would un-invalidate');
	assert.equal(resolved.at, 5_000_000 + PAD);
	assert.ok(warns.some((w) => w.includes('sideways')));
});

// ---- the last-known-good ----

test('the LKG stores ABSENCE, so a read error after a clear cannot resurrect the epoch', async () => {
	// The failure this exists for: resolve once while a row exists, clear it, resolve again
	// successfully (recording absence), then hit a read error. Without absence in the LKG the worker
	// falls back to the epoch it saw first and keeps demoting pages nobody has invalidated — with the
	// console showing nothing active and offload quietly sagging, for the life of the worker.
	rows.set('all', { scope: 'all', invalidatedAt: at(5_000_000) });
	assert.ok(await inv.resolveInvalidation(null), 'precondition: it resolved once');

	rows.delete('all');
	assert.equal(await inv.resolveInvalidation(null), null, 'the clear is visible immediately');

	failNext = 1;
	assert.equal(await inv.resolveInvalidation(null), null, 'and the remembered answer is ABSENCE, not the old epoch');
});

test('a read error falls back to the LKG while it is fresh', async () => {
	rows.set('all', { scope: 'all', invalidatedAt: at(5_000_000) });
	assert.ok(await inv.resolveInvalidation(null));

	failNext = 1;
	const resolved = await inv.resolveInvalidation(null);
	assert.ok(resolved, 'a transient storage fault must not un-invalidate the corpus');
	assert.equal(resolved.at, 5_000_000 + PAD);
});

test('past lkgMaxAge resolution fails OPEN rather than trusting a stale answer', async () => {
	rows.set('all', { scope: 'all', invalidatedAt: at(5_000_000) });
	assert.ok(await inv.resolveInvalidation(null));

	config.invalidation.lkgMaxAge = 0; // "fail open on the first read error"
	failNext = 1;
	assert.equal(
		await inv.resolveInvalidation(null),
		null,
		'this table is normally EMPTY, so "unknown" almost certainly means "nothing is invalidated" — failing ' +
			'closed would turn a cosmetic storage fault into a total offload outage'
	);
});

test('with no LKG at all, a read error fails open', async () => {
	rows.set('all', { scope: 'all', invalidatedAt: at(5_000_000) });
	failNext = 1;
	assert.equal(await inv.resolveInvalidation(null), null);
});

// ---- the admin derivation ----

test('epochFromActiveSet derives the same answer synchronously, with zero reads per row', async () => {
	const active = [
		{ scope: 'all', invalidatedAt: at(9_000_000) },
		{ scope: ROUTE, invalidatedAt: at(1_000_000) },
		{ scope: 'route:prefix:/other/', invalidatedAt: at(99_000_000) },
	];
	reads = [];

	const resolved = inv.epochFromActiveSet(active, ROUTE);
	assert.equal(resolved.scope, 'all', 'same max(at) rule as the serve path');
	assert.equal(resolved.at, 9_000_000 + PAD);
	// The OTHER route's much newer row must not leak in — that would report a page as invalidated in
	// the console while bots are served it perfectly happily.
	assert.equal(inv.epochFromActiveSet(active, 'route:prefix:/nothing/').scope, 'all');
	assert.deepEqual(reads, [], 'derivation is synchronous — an admin page must not read once per row');

	// An unreadable row contributes nothing here either.
	assert.equal(inv.epochFromActiveSet([{ scope: 'all' }], null), null);
});

// ---- resolvability: the detector for a scope that matches nothing ----

test('a scope naming no configured route is reported unresolvable, by name', async () => {
	rows.set('route:prefix:/gone/', { scope: 'route:prefix:/gone/', invalidatedAt: at(5_000_000) });
	rows.set('all', { scope: 'all', invalidatedAt: at(5_000_000) });

	const report = await inv.checkScopeResolvability();
	assert.deepEqual(report.unresolvable, ['route:prefix:/gone/']);
	assert.ok(report.knownScopes.includes('all') && report.knownScopes.includes(ROUTE));
	assert.ok(warns.some((w) => w.includes('/gone/') && w.includes('applying to NOTHING')));
});

test('a live route RENAME makes an active scope unresolvable — the case config alone cannot see', async () => {
	rows.set(ROUTE, { scope: ROUTE, invalidatedAt: at(5_000_000) });
	assert.deepEqual((await inv.checkScopeResolvability()).unresolvable, [], 'resolvable to begin with');

	// The operator edits ingress.routes. The row is untouched, still looks applied, and now covers
	// nothing — so that corpus is being served again with no other signal anywhere.
	config.ingress.routes = [{ match: 'prefix', path: '/renamed/' }];
	assert.deepEqual((await inv.checkScopeResolvability()).unresolvable, [ROUTE]);
});

// ---- writes ----

test('recordInvalidation stamps the epoch server-side and reports what it wrote', async () => {
	const written = await inv.recordInvalidation({ scope: 'all', reason: 'price flip', updatedBy: 'joe' });
	assert.equal(written.scope, 'all');
	assert.equal(written.mode, 'hard');
	assert.equal(written.reason, 'price flip');
	assert.ok(Number.isFinite(new Date(written.invalidatedAt).getTime()), 'a real instant, stamped here');
	assert.equal(rows.get('all').reason, 'price flip');
});

test('clearInvalidation reports from what it did, never by re-reading, and drops the LKG', async () => {
	rows.set('all', { scope: 'all', invalidatedAt: at(5_000_000) });
	assert.ok(await inv.resolveInvalidation(null), 'the LKG now holds an epoch');

	const cleared = await inv.clearInvalidation('all');
	assert.equal(cleared.cleared, true);
	assert.equal(cleared.existed, true);

	// A row deleted earlier in a request is still visible to a read in that request, which is why the
	// response must not be built from one. And this worker must not keep serving the cleared epoch out
	// of its own remembered answer.
	failNext = 1;
	assert.equal(await inv.resolveInvalidation(null), null, 'the LKG entry went with the row');
});

// ---- the per-worker view (the subscription replaces the per-request reads) ----

const until = async (condition, what) => {
	for (let i = 0; i < 500; i++) {
		if (condition()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.fail(`timed out waiting for ${what}`);
};
const trusted = () => inv.invalidationViewState().trusted;
const ring = () => subscribers.at(-1).options.listener({ type: 'put' });

test('once the view has loaded, a cache-servable request costs ZERO reads — it was two per request', async () => {
	rows.set('all', { scope: 'all', invalidatedAt: at(1_000_000), mode: 'hard' });
	rows.set(ROUTE, { scope: ROUTE, invalidatedAt: at(9_000_000), mode: 'hard' });
	inv.startInvalidationWatch();
	await until(trusted, 'the view to load');
	assert.equal(subscribers.length, 1);
	assert.equal(subscribers[0].options.omitCurrent, true, 'the retained replay truncates; the view loads by a read');
	assert.equal(typeof subscribers[0].options.listener, 'function', 'the listener form, never for-await');

	reads = [];
	for (let i = 0; i < 100; i++) {
		const resolved = inv.resolveInvalidation(ROUTE);
		assert.deepEqual(resolved, { scope: ROUTE, at: 9_000_000 + PAD }, 'same max(at) rule, same pad');
	}
	assert.deepEqual(inv.resolveInvalidation('route:prefix:/other/'), { scope: 'all', at: 1_000_000 + PAD });
	assert.deepEqual(reads, [], 'no point read at all');
	config.invalidation.enabled = false;
	assert.equal(inv.resolveInvalidation(ROUTE), null, 'the kill switch still wins');
});

test('before the view has loaded, the serve path reads per request — correct from the first request', async () => {
	rows.set('all', { scope: 'all', invalidatedAt: at(5_000_000) });
	let release;
	scanGate = new Promise((resolve) => (release = resolve));
	inv.startInvalidationWatch();
	await until(() => subscribers.length === 1, 'the subscription');
	assert.equal(trusted(), false);
	assert.equal((await inv.resolveInvalidation(null)).at, 5_000_000 + PAD);
	assert.deepEqual(reads, ['all'], 'the pre-view path, exactly as before');
	release();
	await until(trusted, 'the view to load');
});

test('an apply and an undo reach the view on the doorbell, from any node', async () => {
	inv.startInvalidationWatch();
	await until(trusted, 'the view to load');
	assert.equal(inv.resolveInvalidation(null), null);

	// A row written anywhere in the cluster commits here by replication and rings the subscription.
	rows.set('all', { scope: 'all', invalidatedAt: at(7_000_000) });
	ring();
	await until(() => inv.resolveInvalidation(null) !== null, 'the apply');
	assert.equal(inv.resolveInvalidation(null).at, 7_000_000 + PAD);

	rows.delete('all');
	ring();
	await until(() => inv.resolveInvalidation(null) === null, 'the undo');
	assert.deepEqual(reads, [], 'still no per-request read');
});

test('a doorbell that rings mid-load is not lost: another load follows the one in flight', async () => {
	inv.startInvalidationWatch();
	await until(trusted, 'the view to load');
	let release;
	scanGate = new Promise((resolve) => (release = resolve));
	const before = scans;
	ring();
	await until(() => scans === before + 1, 'the second load to start');
	// The write lands after the in-flight load has begun, so only a load AFTER it can see the row.
	rows.set('all', { scope: 'all', invalidatedAt: at(3_000_000) });
	ring();
	scanGate = null;
	release();
	await until(() => inv.resolveInvalidation(null) !== null, 'the write rung mid-load');
	assert.equal(scans, before + 2, 'exactly one more load, not one per ring');
});

test('a closed subscription falls back to per-request reads, and the backstop re-subscribes', async () => {
	mock.timers.enable({ apis: ['setInterval'] });
	try {
		rows.set('all', { scope: 'all', invalidatedAt: at(5_000_000) });
		inv.startInvalidationWatch();
		await until(trusted, 'the view to load');
		subscribers[0].emit('close');
		assert.equal(trusted(), false, 'a view nobody rings for is never trusted');
		reads = [];
		assert.equal((await inv.resolveInvalidation(null)).at, 5_000_000 + PAD);
		assert.deepEqual(reads, ['all'], 'correct meanwhile, by the per-request path');

		mock.timers.tick(60_000);
		await until(() => subscribers.length === 2 && trusted(), 'the re-subscribe and reload');
		reads = [];
		inv.resolveInvalidation(null);
		assert.deepEqual(reads, []);
	} finally {
		mock.timers.reset();
	}
});

test('a subscribe that throws is counted, falls back, and is retried by the backstop', async () => {
	mock.timers.enable({ apis: ['setInterval'] });
	try {
		subscribeFails = 1;
		inv.startInvalidationWatch();
		await until(() => warns.some((w) => w.includes('could not subscribe')), 'the warning');
		assert.equal(trusted(), false);
		assert.equal(scans > 0, true, 'the resolvability report still ran');
		mock.timers.tick(60_000);
		await until(trusted, 'the retried subscription to load');
		assert.equal(subscribers.length, 1);
	} finally {
		mock.timers.reset();
	}
});

test('a view read that fails leaves the view untrusted; the next doorbell or tick recovers it', async () => {
	rows.set('all', { scope: 'all', invalidatedAt: at(5_000_000) });
	inv.startInvalidationWatch();
	await until(trusted, 'the view to load');
	scanFails = 1;
	ring();
	await until(() => !trusted(), 'the failed read to distrust the view');
	assert.ok(errors.some((e) => e.includes('invalidation view read failed')));
	reads = [];
	assert.equal((await inv.resolveInvalidation(null)).at, 5_000_000 + PAD, 'the fallback still enforces it');
	assert.deepEqual(reads, ['all']);
	ring();
	await until(trusted, 'the recovery');
});

test('a view load refreshes the last-known-good, so a later fallback read error has a current answer', async () => {
	rows.set('all', { scope: 'all', invalidatedAt: at(5_000_000) });
	inv.startInvalidationWatch();
	await until(trusted, 'the view to load');
	subscribers[0].emit('close');
	failNext = 1;
	const resolved = await inv.resolveInvalidation(null);
	assert.equal(resolved?.at, 5_000_000 + PAD, 'a storage fault right after the drop must not un-invalidate');
});

test("a writer's own worker sees its write when the write returns — the canary trip's reseed resolves at once", async () => {
	// The trip records an invalidation and chains a reseed immediately; that reseed's first resolution
	// saw NO epoch (the doorbell had not landed), treated nothing as covered and re-baselined the scope.
	inv.startInvalidationWatch();
	await until(trusted, 'the view to load');
	const written = await inv.recordInvalidation({ scope: ROUTE, reason: 'canary trip', updatedBy: 'change-probe' });
	const resolved = inv.resolveInvalidation(ROUTE);
	assert.equal(resolved?.at, new Date(written.invalidatedAt).getTime() + PAD, 'no doorbell rung, and already visible');

	await inv.clearInvalidation(ROUTE);
	assert.equal(inv.resolveInvalidation(ROUTE), null, 'and the clear, the same way');
	assert.deepEqual(reads, [], 'from the view, not by falling back to per-request reads');
});

test('a write inside a request (not yet committed) is patched into the writer’s view, and the commit settles it', async () => {
	inv.startInvalidationWatch();
	await until(trusted, 'the view to load');
	deferWrites = true;
	const written = await inv.recordInvalidation({ scope: 'all', reason: 'admin', updatedBy: 'joe' });
	assert.equal(rows.has('all'), false, 'precondition: no read can see it yet');
	assert.equal(inv.resolveInvalidation(null)?.at, new Date(written.invalidatedAt).getTime() + PAD);

	// The request ends: the commit rings the doorbell and the real row replaces the patch.
	deferWrites = false;
	commitPending();
	ring();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(inv.resolveInvalidation(null)?.at, new Date(written.invalidatedAt).getTime() + PAD);
});

test('a clear inside a request is NOT patched: if its transaction aborts, nothing invalidated is served', async () => {
	rows.set('all', { scope: 'all', invalidatedAt: at(5_000_000) });
	inv.startInvalidationWatch();
	await until(trusted, 'the view to load');
	deferWrites = true;
	await inv.clearInvalidation('all');
	assert.equal(rows.has('all'), true, 'precondition: the delete is not visible yet');
	assert.equal(
		inv.resolveInvalidation(null)?.at,
		5_000_000 + PAD,
		'still enforced until the delete commits — late is the safe direction'
	);
	// The request aborts: nothing commits, and the invalidation must still be in force.
	pending.clear();
	deferWrites = false;
	ring();
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(inv.resolveInvalidation(null)?.at, 5_000_000 + PAD);
	// A clear outside a request has committed by the time it returns, and its own worker sees it at once.
	await inv.clearInvalidation('all');
	assert.equal(inv.resolveInvalidation(null), null);
});
