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
const targets = new Map(); // url -> { state } for the sibling read
const searches = [];
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
		// The sibling read (`spelledOtherwise`): ascending keys from the condition, the projection, the limit.
		static async *search(query, context) {
			searches.push({ query, context });
			const from = query.conditions[0].value;
			const keys = [...targets.keys()].filter((key) => key >= from).sort();
			for (const key of keys.slice(0, query.limit)) yield { url: key, state: targets.get(key).state ?? null };
		}
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
	targets.clear();
	searches.length = 0;
	entityFault = null;
	configure();
	entity.resetAdoptionCountsForTest();
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

test('OFF: no read, no write, nothing counted', async () => {
	configure({ entities: { enabled: false } });
	assert.equal((await observe(CANON)).outcome, null);
	await entity.observeRenderedCanonical(CANON, { canonical: CANON }, Date.now());
	assert.deepEqual(writes, []);
	assert.deepEqual(analytics, []);
	applyOptions({});
	assert.equal(config.entities.enabled, true, 'on by default: a route opts in with entityPrefix');
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

const SETTINGS = { enabled: true, dryRun: false, maxPerHour: 500, retryAfter: 7 * 24 * HOUR };
const observer = ({
	target = null,
	settings = {},
	probeDryRun = false,
	now = Date.now,
	fileTarget = null,
	markAdopted = undefined,
	otherSpelling = undefined,
} = {}) => {
	const filed = [];
	const read = [];
	const resolve = entity.createCanonicalResolver({
		settings: { ...SETTINGS, ...settings },
		now,
		readTarget: async (url) => {
			read.push(url);
			return typeof target === 'function' ? target(url) : target;
		},
		fileTarget: fileTarget ?? (async (url, data) => filed.push({ url, data })),
		...(markAdopted ? { markAdopted } : {}),
		...(otherSpelling ? { otherSpelling } : {}),
	});
	// The change probe's call: its pass's dry run rides on each observation.
	const watch = ({ url, value }) => resolve({ url, value, from: 'probe', dryRun: probeDryRun });
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

test('the endpoint may name a /-rooted path or a whole URL — never a relative path', async () => {
	const { watch, filed } = observer();
	await watch({ url: OLD, value: CANON });
	assert.equal(filed[0].url, CANON);
	assert.equal(await watch({ url: OLD, value: '' }), null);
	assert.equal(await watch({ url: OLD, value: null }), null);
	assert.equal(await watch({ url: OLD, value: 42 }), null);
	// Resolved against the probed URL's DIRECTORY this would invent `/product/prd-1/product/prd-1/x.jsp`,
	// under the entity's own prefix.
	assert.equal(await watch({ url: OLD, value: 'product/prd-1/x.jsp' }), null);
	assert.equal(filed.length, 1);
});

test('a canonical spelled otherwise (`%27` for an apostrophe) is the SAME document: no move, no duplicate target', async () => {
	const encoded = `${PRODUCT}levi%27s-501.jsp`;
	const raw = `${PRODUCT}levi's-501.jsp`;
	assert.ok(entity.sameDocument(encoded, raw));
	assert.ok(!entity.sameDocument(`${PRODUCT}a%2Fb.jsp`, `${PRODUCT}a/b.jsp`), 'a reserved delimiter is not decoded');
	// The registry holds the sitemap's spelling; the endpoint spells it raw.
	await observe(encoded, { from: 'render', atMs: Date.now() - HOUR });
	writes.length = 0;
	assert.equal((await observe(raw)).outcome, 'same');
	assert.deepEqual(writes, [], 'nothing written, and the stored spelling stands');
	assert.equal(entities.get(PRODUCT).canonical, encoded);
	// Probed at the canonical itself, spelled otherwise: nothing to adopt.
	const probedAtIt = observer();
	await probedAtIt.watch({ url: encoded, value: "/product/prd-1/levi's-501.jsp" });
	assert.deepEqual(probedAtIt.read, []);
	// Probed at a variant: the exact key has no target, but a target in rotation holds it spelled otherwise.
	entities.clear();
	targets.set(encoded, { state: null });
	targets.set(OLD, { state: null });
	const variant = observer();
	assert.equal((await variant.watch({ url: OLD, value: "/product/prd-1/levi's-501.jsp" })).adopt, 'exists');
	assert.deepEqual(variant.filed, []);
	// The sibling read is one bounded, one-sided, node-local range under the entity's prefix.
	assert.equal(searches.length, 1);
	assert.deepEqual(searches[0].query.conditions, [
		{ attribute: 'url', comparator: 'greater_than_equal', value: PRODUCT },
	]);
	assert.equal(searches[0].query.limit, entity.SIBLING_READ_LIMIT);
	assert.deepEqual(searches[0].context, { replicateFrom: false });
	// A SUPPRESSED other spelling holds nothing in rotation: adopted.
	targets.set(encoded, { state: 'suppressed' });
	entities.clear();
	assert.equal((await observer().watch({ url: OLD, value: "/product/prd-1/levi's-501.jsp" })).adopt, 'adopted');
});

test('a canonical with a target in rotation is left alone — the ordinary duplicate spelling', async () => {
	const { watch, filed } = observer({ target: { url: CANON, state: null } });
	assert.equal((await watch({ url: OLD, value: CANON })).adopt, 'exists');
	assert.deepEqual(filed, []);
});

test('a canonical-verdict suppression is REACTIVATED, carrying its own declarations; any other is left', async () => {
	for (const suppressedReason of ['canonical-mismatch', 'canonical-variant']) {
		entities.clear();
		const unlistedAt = new Date(Date.now() - 24 * HOUR);
		const { watch, filed } = observer({
			target: {
				url: CANON,
				state: 'suppressed',
				suppressedReason,
				sitemapUrl: `${ORIGIN}/sitemap-products-1.xml`,
				// A Long column can come back as a BigInt.
				renderInterval: BigInt(2 * HOUR),
				unlistedAt,
			},
		});
		assert.equal((await watch({ url: OLD, value: CANON })).adopt, 'reactivated', suppressedReason);
		assert.equal(filed[0].data.sitemapUrl, `${ORIGIN}/sitemap-products-1.xml`);
		assert.equal(filed[0].data.renderInterval, 2 * HOUR);
		assert.equal(filed[0].data.unlistedAt, unlistedAt, 'or the sitemap arrival check could not see a rejoin');
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

test('at most maxPerHour an hour on this node, shared by every resolver; the next hour starts afresh', async () => {
	let clock = Date.UTC(2026, 9, 2, 10, 0, 0);
	const settings = { maxPerHour: 2 };
	const one = observer({ settings, now: () => clock });
	// Another resolver stands in for another worker thread, or another observer: one budget for the node.
	const two = observer({ settings, now: () => clock });
	const outcomes = [];
	for (let id = 1; id <= 4; id++) outcomes.push((await reslug(id % 2 ? one.watch : two.watch, id)).adopt);
	assert.deepEqual(outcomes, ['adopted', 'adopted', 'capped', 'capped']);
	assert.equal(one.filed.length + two.filed.length, 2);
	clock += HOUR;
	assert.equal((await reslug(one.watch, 9)).adopt, 'adopted', 'a new hour, a new budget');
});

const reslug = (watch, id) =>
	watch({ url: `${ORIGIN}/product/prd-${id}/old.jsp`, value: `/product/prd-${id}/new.jsp` });

test('a put that fails gives its slot back', async () => {
	let failing = true;
	const flaky = observer({
		settings: { maxPerHour: 1 },
		fileTarget: async () => {
			if (failing) throw new Error('write fault');
		},
	});
	assert.equal((await reslug(flaky.watch, 3)).adopt, 'error');
	failing = false;
	assert.equal((await reslug(flaky.watch, 4)).adopt, 'adopted');
	assert.equal((await reslug(flaky.watch, 5)).adopt, 'capped');
});

test('the adoption stands when only its memory fails to write', async () => {
	const { watch, filed } = observer({
		markAdopted: async () => {
			throw new Error('write fault');
		},
	});
	assert.equal((await watch({ url: OLD, value: CANON })).adopt, 'adopted');
	assert.equal(filed.length, 1);
});

test('an unreadable stored instant loses to any observation', async () => {
	entities.set(PRODUCT, { id: PRODUCT, canonical: OLD, canonicalFrom: 'render', canonicalAt: 'not a date' });
	assert.equal((await observe(CANON, { atMs: 1 })).outcome, 'moved');
	assert.equal(entities.get(PRODUCT).canonical, CANON);
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
	// Under the entity's prefix, but a passthrough carve-out (an exclude pattern) owns the path.
	configure({ rest: { excludePathPatterns: ['/search/'] } });
	entities.clear();
	assert.equal((await watch({ url: OLD, value: '/product/prd-1/search/x.jsp' })).adopt, 'refused');
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

test('config: the registry is on by default (a route opts in with entityPrefix); adoption is on but dry run, bounded', () => {
	applyOptions({});
	assert.deepEqual(config.entities, {
		enabled: true,
		adopt: { enabled: true, dryRun: true, maxPerHour: 60, retryAfter: 7 * 24 * HOUR },
	});
	assert.equal('adoptCanonical' in config.changeProbe, false, 'one home: the registry\u2019s own group');
});

// ── wiring ─────────────────────────────────────────────────────────────────────────────────────

test('the sweep wires the resolver with its pass\u2019s dry run; the canary wires none; the render result reports its canonical', async () => {
	const SRC = new URL('../src/', import.meta.url).pathname;
	const probe = await readFile(join(SRC, 'util', 'changeProbe.js'), 'utf8');
	// The PASS's dry run: an operator's measure-only sweep sets it.
	const wired =
		/onCanonical: entitiesOn\(\)\s*\? \(\{ url, value \}\) => resolveCanonical\(\{ url, value, from: 'probe', dryRun: limits\.dryRun \}\)/g;
	assert.equal([...probe.matchAll(wired)].length, 1);
	const queue = await readFile(join(SRC, 'resources', 'RenderQueue.js'), 'utf8');
	assert.match(queue, /observeRenderedCanonical\(scheduleUrl, describing\.pageFacts,/);
});

// ── review of 0.101.0: what a dry run counts, and what it spends ───────────────────────────────────

test('a DRY RUN counts each entity once per retryAfter, as arming would file it — not every observation', async () => {
	let clock = Date.UTC(2026, 9, 2, 10, 0, 0);
	const { watch, filed } = observer({ settings: { dryRun: true }, now: () => clock });
	assert.equal((await watch({ url: OLD, value: CANON })).adopt, 'would-adopt');
	assert.equal(entities.get(PRODUCT).wouldAdoptCanonical, CANON);
	// Every later observation of the same entity (a proxied miss, a verdict, a check) inside the window:
	assert.equal((await watch({ url: OLD, value: CANON })).adopt, 'recent');
	assert.equal((await watch({ url: `${PRODUCT}other-spelling.jsp`, value: CANON })).adopt, 'recent');
	clock += 7 * 24 * HOUR;
	assert.equal((await watch({ url: OLD, value: CANON })).adopt, 'would-adopt', 'the window passed');
	assert.deepEqual(filed, []);
	assert.equal(entities.get(PRODUCT).adoptedCanonical, undefined, 'a dry run never records a real adoption');
});

test('a dry run spends its own lane: it never takes the slots an armed node’s real adoptions need', async () => {
	const settings = { maxPerHour: 1 };
	// An operator's measure-only sweep on an armed node fills the dry lane...
	const sweep = observer({ settings, probeDryRun: true });
	assert.equal((await reslug(sweep.watch, 1)).adopt, 'would-adopt');
	assert.equal((await reslug(sweep.watch, 2)).adopt, 'capped', 'the dry lane is capped like the real one');
	// ...and a real observation the same hour still files.
	const armed = observer({ settings });
	assert.equal((await reslug(armed.watch, 3)).adopt, 'adopted');
	assert.equal((await reslug(armed.watch, 4)).adopt, 'capped');
});

test('arming starts from no memory: an entity a dry run would have adopted is adopted at once when armed', async () => {
	const dry = observer({ settings: { dryRun: true } });
	assert.equal((await dry.watch({ url: OLD, value: CANON })).adopt, 'would-adopt');
	const armed = observer();
	assert.equal((await armed.watch({ url: OLD, value: CANON })).adopt, 'adopted');
	assert.equal(armed.filed.length, 1);
});

test('retryAfter is per ENTITY: two spellings naming each other cannot reactivate each other in turn', async () => {
	let clock = Date.UTC(2026, 9, 2, 10, 0, 0);
	const { watch, filed } = observer({
		now: () => clock,
		target: { url: CANON, state: 'suppressed', suppressedReason: 'canonical-mismatch' },
	});
	assert.equal((await watch({ url: OLD, value: CANON })).adopt, 'reactivated');
	clock += HOUR;
	// The origin now names the OLD spelling again (a re-slug back, or an inconsistent copy at the edge).
	assert.equal((await watch({ url: CANON, value: OLD })).adopt, 'recent');
	assert.equal(filed.length, 1);
});

test('sameDocument compares two URLs, never a coerced non-string', () => {
	assert.equal(entity.sameDocument(null, 'null'), false);
	assert.equal(entity.sameDocument(undefined, 'undefined'), false);
	assert.equal(entity.sameDocument(null, null), false);
	assert.equal(entity.sameDocument(`${PRODUCT}levi%27s.jsp`, `${PRODUCT}levi's.jsp`), true);
});
