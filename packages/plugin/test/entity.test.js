import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The entity registry (util/entity.js, issue #166) and the change probe's canonical adoption.
 *
 * What is pinned here:
 *   - an entity is keyed by its entity prefix, only on a prerender route that declares one, and product 1
 *     is never product 12;
 *   - the canonical is written by observations only, the NEWER of two disagreeing observations wins, an
 *     unchanged observation writes nothing, and a canonical under another entity's prefix is refused;
 *   - the probe adopts a canonical only when it is ANOTHER URL than the one probed and no target holds it in
 *     rotation: a canonical-verdict suppression is reactivated, any other is left alone; bounded per pass, per
 *     entity (`retryAfter`) and by both dry runs; refused when it could not be a target at all;
 *   - the whole registry is inert while `entities.enabled` is off.
 */

const analytics = [];
const entities = new Map(); // id -> row
const writes = []; // ['put' | 'patch', id, data]
let entityFault = null;

before(async () => {
	globalThis.server = {
		hostname: 'node-a',
		nodes: [],
		config: { http: { port: 9926 } },
		recordAnalytics: (...args) => analytics.push(args),
	};
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} };
	globalThis.Resource = class {};
	class TargetBase {
		static async get() {
			return null;
		}
		static async put() {}
	}
	globalThis.databases = {
		coordination: {
			SharedBuffer: { primaryStore: { getUserSharedBuffer: (_k, b) => b, tryLock: () => true, unlock() {} } },
		},
		render_service: {
			Target: TargetBase,
			QueueControl: class {},
			Entity: {
				async get({ id, select }) {
					if (entityFault) throw entityFault;
					const row = entities.get(id);
					return row ? Object.fromEntries(select.map((key) => [key, row[key]])) : null;
				},
				async put(id, data) {
					if (entityFault) throw entityFault;
					writes.push(['put', id, data]);
					entities.set(id, { ...data });
				},
				async patch(id, data) {
					if (entityFault) throw entityFault;
					writes.push(['patch', id, data]);
					entities.set(id, { ...(entities.get(id) ?? {}), ...data });
				},
			},
		},
		render_schedule: { RenderSchedule: class {} },
		page_cache: { PrerenderedPage: class {} },
		probe_state: { ProbeState: class {}, RenderExpectation: class {} },
	};
	({ applyOptions, config } = await import('../src/config.js'));
	entity = await import('../src/util/entity.js');
});

let applyOptions;
let config;
let entity;

const ORIGIN = 'https://www.example.com';
const PRODUCT = `${ORIGIN}/product/prd-1/`;
const CANON = `${PRODUCT}right-slug.jsp`;
const OLD = `${PRODUCT}old-slug.jsp`;
const HOUR = 3_600_000;

const configure = (over = {}) =>
	applyOptions({
		ingress: {
			mode: 'forwarded',
			routes: [
				{ match: 'prefix', path: '/product/prd-', queryParams: [], entityPrefix: '^/product/prd-[^/]+/' },
				{ match: 'prefix', path: '/catalog/', queryParams: ['CN'] },
			],
		},
		entities: { enabled: true, ...(over.entities ?? {}) },
		...(over.rest ?? {}),
	});

beforeEach(() => {
	analytics.length = 0;
	entities.clear();
	writes.length = 0;
	entityFault = null;
	configure();
});

const ops = (series) => analytics.filter((a) => a[1] === 'prerender_ops' && a[2] === series).map((a) => a.slice(3));
const observe = (canonical, { from = 'probe', atMs = Date.now(), url = OLD } = {}) =>
	entity.observeCanonical({ url, canonical, from, atMs });

// ── the key ─────────────────────────────────────────────────────────────────────────────────────

test('an entity is its entity prefix, only on a prerender route that declares one', () => {
	assert.deepEqual(entity.entityOf(OLD)?.key, PRODUCT);
	assert.equal(entity.entityOf(`${ORIGIN}/catalog/shoes.jsp?CN=Red`), null, 'no entityPrefix, no entity');
	assert.equal(entity.entityOf(`${ORIGIN}/product/prd-1`), null, 'a match must end on "/"');
	assert.equal(entity.entityOf(`${ORIGIN}/elsewhere/x`), null);
});

// ── the canonical: observations, newest wins ───────────────────────────────────────────────────

test('the first observation creates the entity; the same one again writes nothing', async () => {
	const at = Date.now() - HOUR;
	const first = await observe(CANON, { atMs: at });
	assert.equal(first.outcome, 'new');
	assert.deepEqual(entities.get(PRODUCT), {
		id: PRODUCT,
		canonical: CANON,
		canonicalFrom: 'probe',
		canonicalAt: new Date(at),
		firstSeenAt: entities.get(PRODUCT).firstSeenAt,
	});
	writes.length = 0;
	const again = await observe(CANON, { from: 'render' });
	assert.equal(again.outcome, 'same');
	assert.deepEqual(writes, [], 'a converged registry pays no write per observation');
	assert.deepEqual(ops('entity_canonical'), [
		['new', 'probe'],
		['same', 'render'],
	]);
});

test('a NEWER disagreeing observation moves the canonical; an older one does not', async () => {
	const t0 = Date.now() - 2 * HOUR;
	await observe(OLD, { atMs: t0 });
	const moved = await observe(CANON, { atMs: t0 + HOUR });
	assert.equal(moved.outcome, 'moved');
	assert.equal(entities.get(PRODUCT).canonical, CANON);
	assert.equal(entities.get(PRODUCT).canonicalFrom, 'probe');
	// A render claimed before the re-slug, landing after the probe saw it: it read the origin EARLIER.
	const stale = await observe(OLD, { from: 'render', atMs: t0 + HOUR / 2 });
	assert.equal(stale.outcome, 'older');
	assert.equal(entities.get(PRODUCT).canonical, CANON);
});

test('a canonical is keyed exactly as its route keys it, and one under ANOTHER entity is refused', async () => {
	assert.equal((await observe(`${CANON}?utm_source=x#reviews`)).canonical, CANON, 'the route keeps no query');
	assert.equal((await observe(`${ORIGIN}/product/prd-12/right-slug.jsp`)).outcome, 'foreign');
	assert.equal((await observe(`https://other.example.net/product/prd-1/x.jsp`)).outcome, 'foreign');
	assert.equal((await observe('not a url')).outcome, 'unreadable');
	assert.equal(entities.get(PRODUCT).canonical, CANON);
});

test('a failed read or write is counted and swallowed', async () => {
	entityFault = new Error('read fault');
	assert.equal((await observe(CANON)).outcome, 'error');
	assert.deepEqual(ops('entity_canonical'), [['error', 'probe']]);
});

test('OFF (the default): no read, no write, nothing counted', async () => {
	configure({ entities: { enabled: false } });
	assert.equal((await observe(CANON)).outcome, null);
	await entity.observeRenderedCanonical(CANON, { canonical: CANON }, Date.now());
	assert.deepEqual(writes, []);
	assert.deepEqual(analytics, []);
	applyOptions({});
	assert.deepEqual(config.entities, { enabled: false });
});

test('a stored render reports the canonical its page declared', async () => {
	await entity.observeRenderedCanonical(OLD, { canonical: CANON }, Date.now() - 60_000);
	assert.equal(entities.get(PRODUCT).canonical, CANON);
	assert.equal(entities.get(PRODUCT).canonicalFrom, 'render');
	// A render with no page record says nothing.
	writes.length = 0;
	await entity.observeRenderedCanonical(OLD, null, Date.now());
	await entity.observeRenderedCanonical(OLD, { canonical: null }, Date.now());
	assert.deepEqual(writes, []);
});

// ── adoption ─────────────────────────────────────────────────────────────────────────────────────

const SETTINGS = { enabled: true, dryRun: false, maxPerPass: 500, retryAfter: 7 * 24 * HOUR };
const observer = ({ target = null, settings = {}, probeDryRun = false, now = Date.now } = {}) => {
	const filed = [];
	const read = [];
	const watch = entity.createCanonicalObserver({
		settings: { ...SETTINGS, ...settings },
		probeDryRun,
		now,
		readTarget: async (url) => {
			read.push(url);
			return typeof target === 'function' ? target(url) : target;
		},
		fileTarget: async (url, data) => filed.push({ url, data }),
	});
	return { watch, filed, read };
};
const adopts = () => ops('canonical_adopt').map(([outcome]) => outcome);

test('the probed URL IS the canonical: recorded, and nothing to adopt', async () => {
	const { watch, read } = observer();
	const result = await watch({ url: CANON, value: '/product/prd-1/right-slug.jsp' });
	assert.equal(result.outcome, 'new');
	assert.deepEqual(read, [], 'not even a Target read');
	assert.deepEqual(adopts(), []);
});

test('a canonical no target holds is ADOPTED: filed due now and urgent, and remembered on the entity', async () => {
	const { watch, filed } = observer();
	const result = await watch({ url: OLD, value: '/product/prd-1/right-slug.jsp' });
	assert.equal(result.adopt, 'adopted');
	assert.equal(filed.length, 1);
	assert.equal(filed[0].url, CANON);
	assert.equal(filed[0].data.urgent, true);
	assert.ok(filed[0].data.nextRenderTime <= Date.now() && filed[0].data.nextRenderTime > Date.now() - 60_000);
	assert.equal(entities.get(PRODUCT).adoptedCanonical, CANON);
	assert.deepEqual(adopts(), ['adopted']);
});

test('the endpoint may name a path or a whole URL', async () => {
	const { watch, filed } = observer();
	await watch({ url: OLD, value: CANON });
	assert.equal(filed[0].url, CANON);
	assert.equal(await watch({ url: OLD, value: '' }), null);
	assert.equal(await watch({ url: OLD, value: null }), null);
	assert.equal(await watch({ url: OLD, value: 42 }), null);
});

test('a canonical with a target in rotation is left alone — the ordinary duplicate spelling', async () => {
	const { watch, filed } = observer({ target: { url: CANON, state: null } });
	assert.equal((await watch({ url: OLD, value: CANON })).adopt, 'exists');
	assert.deepEqual(filed, []);
});

test('a canonical-verdict suppression is REACTIVATED, carrying its own declarations; any other is left', async () => {
	for (const suppressedReason of ['canonical-mismatch', 'canonical-variant']) {
		entities.clear();
		const { watch, filed } = observer({
			target: {
				url: CANON,
				state: 'suppressed',
				suppressedReason,
				sitemapUrl: `${ORIGIN}/sitemap-products-1.xml`,
				renderInterval: 2 * HOUR,
			},
		});
		assert.equal((await watch({ url: OLD, value: CANON })).adopt, 'reactivated', suppressedReason);
		assert.equal(filed[0].data.sitemapUrl, `${ORIGIN}/sitemap-products-1.xml`);
		assert.equal(filed[0].data.renderInterval, 2 * HOUR);
		assert.equal(filed[0].data.urgent, true);
	}
	for (const suppressedReason of ['http-gone', 'noindex', 'redirect-loop']) {
		entities.clear();
		const { watch, filed } = observer({ target: { url: CANON, state: 'suppressed', suppressedReason } });
		assert.equal((await watch({ url: OLD, value: CANON })).adopt, 'suppressed', suppressedReason);
		assert.deepEqual(filed, []);
	}
});

test('a canonical adopted within retryAfter is not filed again — a bad canonical costs one render a window', async () => {
	let clock = Date.now();
	const { watch, filed } = observer({ now: () => clock });
	assert.equal((await watch({ url: OLD, value: CANON })).adopt, 'adopted');
	clock += 24 * HOUR;
	assert.equal((await watch({ url: OLD, value: CANON })).adopt, 'recent');
	clock += 7 * 24 * HOUR;
	assert.equal((await watch({ url: OLD, value: CANON })).adopt, 'adopted');
	assert.equal(filed.length, 2);
});

test('at most maxPerPass a pass; a new observer is a new pass', async () => {
	const { watch, filed } = observer({ settings: { maxPerPass: 2 } });
	const outcomes = [];
	for (let id = 1; id <= 4; id++) {
		outcomes.push(
			(await watch({ url: `${ORIGIN}/product/prd-${id}/old.jsp`, value: `/product/prd-${id}/new.jsp` })).adopt
		);
	}
	assert.deepEqual(outcomes, ['adopted', 'adopted', 'capped', 'capped']);
	assert.equal(filed.length, 2);
	const next = observer({ settings: { maxPerPass: 2 } });
	assert.equal(
		(await next.watch({ url: `${ORIGIN}/product/prd-9/old.jsp`, value: '/product/prd-9/new.jsp' })).adopt,
		'adopted'
	);
});

test('DRY RUN — its own or the probe’s: would-adopt, nothing filed, nothing remembered', async () => {
	for (const options of [{ settings: { dryRun: true } }, { probeDryRun: true }]) {
		entities.clear();
		analytics.length = 0;
		const { watch, filed } = observer(options);
		assert.equal((await watch({ url: OLD, value: CANON })).adopt, 'would-adopt');
		assert.deepEqual(filed, []);
		assert.equal(entities.get(PRODUCT).adoptedCanonical, undefined);
		assert.equal(entities.get(PRODUCT).canonical, CANON, 'the OBSERVATION is still recorded');
	}
});

test('refused: a canonical that could not be a target — too long to key, or off the domain allowlist', async () => {
	const long = `/product/prd-1/${'a'.repeat(2100)}.jsp`;
	const { watch, filed } = observer();
	assert.equal((await watch({ url: OLD, value: long })).adopt, 'refused');
	configure({ rest: { domains: ['shop.example.org'] } });
	entities.clear();
	assert.equal((await watch({ url: OLD, value: CANON })).adopt, 'refused');
	assert.deepEqual(filed, []);
});

test('the adoption switch off: observations recorded, nothing adopted', async () => {
	const { watch, filed, read } = observer({ settings: { enabled: false } });
	const result = await watch({ url: OLD, value: CANON });
	assert.equal(result.outcome, 'new');
	assert.equal(result.adopt, undefined);
	assert.deepEqual(read, []);
	assert.deepEqual(filed, []);
});

test('a failed adoption is counted and swallowed', async () => {
	const { watch } = observer({
		target: () => {
			throw new Error('read fault');
		},
	});
	assert.equal((await watch({ url: OLD, value: CANON })).adopt, 'error');
});

test('config: the registry is off by default; adoption is on but dry run, bounded', () => {
	applyOptions({});
	assert.deepEqual(config.entities, { enabled: false });
	assert.deepEqual(config.changeProbe.adoptCanonical, {
		enabled: true,
		dryRun: true,
		maxPerPass: 500,
		retryAfter: 7 * 24 * HOUR,
	});
});

// ── wiring ─────────────────────────────────────────────────────────────────────────────────────

test('the sweep wires one observer per pass; the canary wires none; the render result reports its canonical', async () => {
	const SRC = new URL('../src/', import.meta.url).pathname;
	const probe = await readFile(join(SRC, 'util', 'changeProbe.js'), 'utf8');
	assert.equal([...probe.matchAll(/onCanonical: entitiesOn\(\) \? createCanonicalObserver\(\) : null/g)].length, 1);
	const queue = await readFile(join(SRC, 'resources', 'RenderQueue.js'), 'utf8');
	assert.match(queue, /observeRenderedCanonical\(scheduleUrl, describing\.pageFacts,/);
});
