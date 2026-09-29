/**
 * What a sitemap walk must NOT conclude from a bad or partial view of the corpus, driven through REAL
 * walks (`Sitemap.refresh`) against in-memory tables and a faked origin that answers conditionally,
 * fails, redirects and truncates on demand.
 *
 *  - a walk with a failed child acts on no departure, and puts back what it unlinked;
 *  - a truncated or much-shorter document is a failed child, not a shorter sitemap;
 *  - a child the index stops listing is pruned (behind the same guard) instead of staying listed forever;
 *  - a URL still listed by a child that answered 304 is re-attached to it, not departed;
 *  - a discovered URL's FIRST listing is filed within `newTargets.window`;
 *  - departures and rejoins are filed as changes, keeping a probe mark filed earlier;
 *  - the bypass token goes only to this deployment's hosts, re-decided on every redirect hop;
 *  - a urlset row stores a bounded sample of its entries;
 *  - the blocking REST writers run outside the request's async context.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

const targets = new Map(); // url -> Target row
const pages = new Map(); // cacheKey -> PrerenderedPage row
const sitemapRows = new Map();
const scheduleRows = new Map();
const patches = []; // every Target.patch, in order
const pagePatches = [];
const schedulePuts = [];
const fetchLog = [];
const searchStores = []; // the async context every Target.search ran in
let documents = {};
const lastMod = {};
const redirects = {};
const request = new AsyncLocalStorage();

const project = (row, select) => {
	if (!select) return { ...row };
	if (typeof select === 'string') return row[select];
	return Object.fromEntries(select.map((key) => [key, row[key]]));
};
const matches = (row, conditions = []) => conditions.every(({ attribute, value }) => row[attribute] === value);

let applyOptions, sitemaps, cacheKeysOf, Target;

before(async () => {
	globalThis.Resource = class {};
	globalThis.server = {
		hostname: 'node-1',
		workerIndex: 0,
		nodes: [],
		config: { http: { port: 9926 } },
		recordAnalytics() {},
	};
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {}, notify() {} };
	const sabs = new Map();
	globalThis.databases = {
		render_service: {
			Target: class {
				static async get(arg) {
					const id = typeof arg === 'object' ? arg.id : arg;
					const row = targets.get(id);
					return row ? project(row, arg?.select) : undefined;
				}
				// A patch of a MISSING record creates one holding only the patched fields, as Harper's does —
				// which is what makes the url-in-every-patch assertions mean something.
				static async patch(id, fields) {
					patches.push({ id, ...fields });
					targets.set(id, Object.assign(targets.get(id) ?? {}, fields));
				}
				static async put(id, data) {
					targets.set(id, { ...data, url: id });
				}
				static async delete(id) {
					targets.delete(id);
				}
				static search({ select, conditions = [] } = {}) {
					searchStores.push(request.getStore());
					const rows = [...targets.values()].filter((row) => matches(row, conditions));
					return (async function* () {
						for (const row of rows) yield project(row, select);
					})();
				}
			},
			QueueControl: class {},
		},
		render_schedule: {
			RenderSchedule: class {
				static async get({ id, select }) {
					const row = scheduleRows.get(id);
					return row ? project(row, select) : undefined;
				}
				static async put(key, row) {
					schedulePuts.push({ key, ...row });
					scheduleRows.set(key, { ...row });
				}
				static async delete(key) {
					scheduleRows.delete(key);
				}
			},
		},
		page_cache: {
			PrerenderedPage: class {
				static async get({ id }) {
					return pages.has(id) ? { cacheKey: id, ...pages.get(id) } : undefined;
				}
				static async patch(id, fields) {
					pagePatches.push({ id, ...fields });
					pages.set(id, Object.assign(pages.get(id) ?? {}, fields));
				}
				static async delete(id) {
					pages.delete(id);
				}
			},
		},
		probe_state: {
			ProbeState: class {
				static async delete() {}
			},
			RenderExpectation: class {
				static async delete() {}
			},
		},
		sitemaps: {
			Sitemap: class {
				constructor(id) {
					this.id = id;
				}
				getId() {
					return this.id;
				}
				async delete() {
					sitemapRows.delete(this.id);
					return true;
				}
				static async get({ id, select }) {
					const row = sitemapRows.get(id);
					return row ? project(row, select) : undefined;
				}
				static async put(id, row) {
					sitemapRows.set(id, { ...row, url: id });
				}
				static async patch(id, fields) {
					sitemapRows.set(id, Object.assign(sitemapRows.get(id) ?? {}, fields));
				}
				static async delete(id) {
					sitemapRows.delete(id);
				}
				static search({ select, conditions = [] } = {}) {
					const rows = [...sitemapRows.values()].filter((row) => matches(row, conditions));
					return (async function* () {
						for (const row of rows) yield project(row, select);
					})();
				}
			},
			SitemapRefresh: class {
				static async get() {
					return undefined;
				}
				static async put() {}
			},
		},
		coordination: {
			SharedBuffer: class {
				static primaryStore = {
					getUserSharedBuffer: (key, buffer) => {
						if (!sabs.has(key)) sabs.set(key, buffer);
						return sabs.get(key);
					},
					tryLock: () => true,
					unlock() {},
				};
			},
		},
	};
	globalThis.fetch = async (url, init = {}) => {
		fetchLog.push({ url, headers: { ...init.headers }, redirect: init.redirect, store: request.getStore() });
		if (redirects[url]) return new Response(null, { status: 301, headers: { location: redirects[url] } });
		const xml = documents[url];
		if (xml === undefined) return new Response('unavailable', { status: 503, statusText: 'Service Unavailable' });
		const ims = init.headers?.['If-Modified-Since'];
		if (ims && lastMod[url] && ims === lastMod[url]) return new Response(null, { status: 304 });
		return new Response(xml, { status: 200, headers: lastMod[url] ? { 'last-modified': lastMod[url] } : {} });
	};

	({ applyOptions } = await import('../src/config.js'));
	({ sitemaps } = await import('../src/resources/Sitemap.js'));
	({ cacheKeysOf, Target } = await import('../src/resources/Target.js'));
});

const HOST = 'https://site.example.com';
const ROOT = `${HOST}/sitemap_index.xml`;
const C1 = `${HOST}/sitemap_product_1.xml`;
const C2 = `${HOST}/sitemap_product_2.xml`;
const C3 = `${HOST}/sitemap_product_3.xml`;
const P = (n) => `${HOST}/product/prd-${n}`;
const MON = 'Mon, 01 Sep 2026 00:00:00 GMT';
const TUE = 'Tue, 02 Sep 2026 00:00:00 GMT';

const index = (...children) =>
	`<?xml version="1.0"?><sitemapindex>${children.map((c) => `<sitemap><loc>${c}</loc></sitemap>`).join('')}</sitemapindex>`;
const urlset = (...urls) =>
	`<?xml version="1.0"?><urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;
const range = (from, to) => Array.from({ length: to - from }, (_, i) => P(from + i));

const configure = ({ sitemap = {}, domains = [], departureDryRun = false, arrivalDryRun = false } = {}) =>
	applyOptions({
		domains,
		origin: { securityToken: { header: 'x-bypass', value: 'SECRET' } },
		sitemap: {
			departure: { enabled: true, dryRun: departureDryRun, maxActions: -1, maxCandidates: -1 },
			arrival: { enabled: true, dryRun: arrivalDryRun, maxActions: -1, maxCandidates: -1 },
			conditional: { enabled: true },
			...sitemap,
		},
		ingress: {
			mode: 'forwarded',
			routes: [{ match: 'prefix', path: '/product/', departureAction: 'render', arrivalAction: 'render' }],
		},
	});

const walk = (docs) => {
	if (docs) documents = { ...docs };
	return sitemaps.refresh(ROOT);
};

beforeEach(() => {
	for (const map of [targets, pages, sitemapRows, scheduleRows]) map.clear();
	for (const list of [patches, pagePatches, schedulePuts, fetchLog, searchStores]) list.length = 0;
	for (const bag of [lastMod, redirects]) for (const key of Object.keys(bag)) delete bag[key];
	documents = {};
	configure();
});

const attributed = (url) => targets.get(url)?.sitemapUrl;

// ---- F1: a failed child ----

test('a walk with a FAILED child acts on no departure, re-links what it unlinked, and the next walk sees no rejoin', async () => {
	lastMod[C1] = MON;
	await walk({ [ROOT]: index(C1, C2), [C1]: urlset(P(1), P(2), P(3)), [C2]: urlset(P(4)) });
	for (const key of cacheKeysOf(P(2))) pages.set(key, { expiresAt: Date.now() + 86_400_000 });

	// Paginated shift: P2 and P3 move into C2, and C2's fetch fails this walk.
	lastMod[C1] = TUE;
	schedulePuts.length = 0;
	const failed = await walk({ [ROOT]: index(C1, C2), [C1]: urlset(P(1)) });

	assert.equal(failed.failed.length, 1);
	assert.deepEqual(failed.departures.outcomes, { relinked: 2 }, 'no departure acted on');
	assert.equal(schedulePuts.length, 0, 'nothing filed to render');
	for (const key of cacheKeysOf(P(2))) assert.ok(pages.get(key).expiresAt > Date.now(), 'nothing expired');
	for (const url of [P(2), P(3)]) {
		assert.equal(attributed(url), C1, `${url} is back with the child that unlinked it`);
		assert.equal(targets.get(url).unlistedAt, null, 'and carries no stamp to read as a rejoin later');
	}
	assert.equal(sitemapRows.get(C1).lastModified, null, 'the child that unlinked loses its validator');

	await sleep(5);
	lastMod[C1] = TUE;
	fetchLog.length = 0;
	const recovered = await walk({ [ROOT]: index(C1, C2), [C1]: urlset(P(1)), [C2]: urlset(P(2), P(3), P(4)) });
	assert.equal(fetchLog.find((f) => f.url === C1).headers['If-Modified-Since'], undefined, 'refetched in full');
	assert.equal(attributed(P(2)), C2);
	assert.equal(attributed(P(3)), C2);
	assert.equal(recovered.arrivals.considered, 0, 'the shifted URLs are shear, not rejoins');
	assert.deepEqual(recovered.departures.outcomes, { reattached: 2 });
});

test('the failed-walk re-link is not a departure action: it happens under dryRun too', async () => {
	configure({ departureDryRun: true });
	await walk({ [ROOT]: index(C1, C2), [C1]: urlset(P(1), P(2)), [C2]: urlset(P(4)) });
	const result = await walk({ [ROOT]: index(C1, C2), [C1]: urlset(P(1)) });
	assert.deepEqual(result.departures.outcomes, { relinked: 1 });
	assert.equal(attributed(P(2)), C1);
});

test('an arrival-only deployment still re-links after a failed walk, so the next walk files no false rejoin', async () => {
	applyOptions({
		sitemap: { arrival: { enabled: true, dryRun: false } },
		ingress: { mode: 'forwarded', routes: [{ match: 'prefix', path: '/product/', arrivalAction: 'render' }] },
	});
	await walk({ [ROOT]: index(C1, C2), [C1]: urlset(P(1), P(2)), [C2]: urlset(P(4)) });
	await walk({ [ROOT]: index(C1, C2), [C1]: urlset(P(1)) });
	assert.equal(attributed(P(2)), C1);
	await sleep(5);
	const next = await walk({ [ROOT]: index(C1, C2), [C1]: urlset(P(1)), [C2]: urlset(P(2), P(4)) });
	assert.equal(next.arrivals.considered, 0);
});

// ---- F2: truncated and short documents ----

test('a TRUNCATED child is a failed child: nothing it dropped is unlinked, departed or later rejoined', async () => {
	const full = urlset(...range(0, 10));
	await walk({ [ROOT]: index(C1, C2), [C1]: full, [C2]: urlset(P(100)) });

	const cut = full.slice(0, full.indexOf(P(4)) + 10);
	const bad = await walk({ [ROOT]: index(C1, C2), [C1]: cut, [C2]: urlset(P(100)) });
	assert.equal(bad.failed.length, 1);
	assert.match(bad.failed[0].error, /truncated/);
	assert.equal(bad.removed, 0);
	assert.deepEqual(bad.departures.outcomes, {});
	for (const url of range(0, 10)) assert.equal(attributed(url), C1);

	await sleep(5);
	const good = await walk({ [ROOT]: index(C1, C2), [C1]: full, [C2]: urlset(P(100)) });
	assert.equal(good.arrivals.considered, 0);
	assert.equal(good.failed.length, 0);
});

test('the shrink guard refuses a well-formed child that lost most of what it held, and maxRatio 1 lets it through', async () => {
	configure({ sitemap: { shrinkGuard: { maxRatio: 0.5, minUrls: 3 } } });
	await walk({ [ROOT]: index(C1), [C1]: urlset(...range(0, 10)) });

	const refused = await walk({ [ROOT]: index(C1), [C1]: urlset(P(0), P(1)) });
	assert.equal(refused.failed.length, 1);
	assert.match(refused.failed[0].error, /refusing to unlink 8 of 10.*shrinkGuard\.maxRatio=0\.5/);
	assert.equal(refused.removed, 0);
	assert.equal(sitemapRows.get(C1).entryCount, 10, 'the row keeps the last good fetch');
	for (const url of range(0, 10)) assert.equal(attributed(url), C1);

	configure({ sitemap: { shrinkGuard: { maxRatio: 1, minUrls: 3 } } });
	const allowed = await walk();
	assert.equal(allowed.failed.length, 0);
	assert.equal(allowed.removed, 8);
	assert.equal(allowed.departures.outcomes.render, 8);
});

test('the shrink guard leaves a shrink under minUrls alone — the default floor is well above real churn', async () => {
	await walk({ [ROOT]: index(C1), [C1]: urlset(...range(0, 10)) });
	const result = await walk({ [ROOT]: index(C1), [C1]: urlset(P(0)) });
	assert.equal(result.failed.length, 0);
	assert.equal(result.removed, 9);
});

// ---- S1: a child the index stops listing ----

test('a child the index STOPS LISTING is pruned after the walk: what moved stays, what is listed nowhere departs', async () => {
	await walk({ [ROOT]: index(C1, C2), [C1]: urlset(P(1)), [C2]: urlset(P(2), P(3)) });
	assert.equal(attributed(P(3)), C2);

	schedulePuts.length = 0;
	const result = await walk({ [ROOT]: index(C1), [C1]: urlset(P(1), P(2)) });
	assert.equal(attributed(P(2)), C1, 'the URL that moved is re-attached, not departed');
	assert.equal(attributed(P(3)), null, 'the one listed nowhere is unlinked');
	assert.equal(result.removed, 1);
	assert.equal(result.departures.outcomes.render, 1);
	assert.equal(sitemapRows.has(C2), false, 'and the dropped child row is gone');
	assert.equal(targets.has(P(2)) && targets.has(P(3)), true, 'without deleting any target');
});

test('a dropped child that would lose everything trips the guard, is offered again on a 304 index, and prunes once allowed', async () => {
	configure({ sitemap: { shrinkGuard: { maxRatio: 0.5, minUrls: 1 } } });
	lastMod[ROOT] = MON;
	await walk({ [ROOT]: index(C1, C2), [C1]: urlset(P(1)), [C2]: urlset(P(2), P(3)) });

	lastMod[ROOT] = TUE;
	const refused = await walk({ [ROOT]: index(C1), [C1]: urlset(P(1)) });
	assert.deepEqual(
		refused.failed.map((f) => f.url),
		[C2]
	);
	assert.equal(attributed(P(2)), C2);
	assert.equal(sitemapRows.has(C2), true, 'kept, so a later walk offers it again');

	const again = await walk(); // the index now answers 304
	assert.equal(again.notModified >= 1, true);
	assert.deepEqual(
		again.failed.map((f) => f.url),
		[C2]
	);

	configure({ sitemap: { shrinkGuard: { maxRatio: 1, minUrls: 1 } } });
	const allowed = await walk();
	assert.equal(allowed.failed.length, 0);
	assert.equal(attributed(P(2)), null);
	assert.equal(attributed(P(3)), null);
	assert.equal(sitemapRows.has(C2), false);
});

test('a dropped child is left alone on a walk that failed elsewhere — its URLs are not stranded on a deleted row', async () => {
	await walk({ [ROOT]: index(C1, C2), [C1]: urlset(P(1)), [C2]: urlset(P(2), P(3)) });

	// The index replaces C2 with C3 — and C3 fails this walk, so nothing has re-attached C2's URLs yet.
	const failed = await walk({ [ROOT]: index(C1, C3), [C1]: urlset(P(1)) });
	assert.equal(failed.failed.length, 1);
	assert.equal(failed.removed, 0, 'the dropped child is not pruned on a failed walk');
	assert.equal(attributed(P(2)), C2);
	assert.equal(sitemapRows.has(C2), true);

	const clean = await walk({ [ROOT]: index(C1, C3), [C1]: urlset(P(1)), [C3]: urlset(P(2), P(3)) });
	assert.equal(clean.failed.length, 0);
	assert.equal(attributed(P(2)), C3);
	assert.equal(attributed(P(3)), C3);
	assert.equal(sitemapRows.has(C2), false, 'dropped once the walk is clean');
});

// ---- S5: a second lister that answered 304 ----

test('a URL the owning child drops is re-attached to a child that still lists it and answered 304', async () => {
	lastMod[C1] = MON;
	lastMod[C2] = MON;
	await walk({ [ROOT]: index(C1, C2), [C1]: urlset(P(1), P(9)), [C2]: urlset(P(2), P(9)) });
	assert.equal(attributed(P(9)), C1, 'first writer wins');

	lastMod[C1] = TUE;
	schedulePuts.length = 0;
	fetchLog.length = 0;
	const result = await walk({ [ROOT]: index(C1, C2), [C1]: urlset(P(1)), [C2]: urlset(P(2), P(9)) });
	assert.ok(result.notModified >= 1);
	assert.equal(attributed(P(9)), C2, 'the child that still lists it owns it now');
	assert.equal(targets.get(P(9)).unlistedAt, null);
	assert.deepEqual(result.departures.outcomes, { 'listed-unchanged': 1 });
	assert.equal(schedulePuts.length, 0, 'not departed');
	const reread = fetchLog.filter((f) => f.url === C2);
	assert.equal(reread.length, 2, 'the 304, then one unconditional re-read for its listings');
	assert.equal(reread[1].headers['If-Modified-Since'], undefined);

	await sleep(5);
	const next = await walk();
	assert.equal(next.arrivals.considered, 0, 'and it never reads as a rejoin');
});

test('no held URL, no re-read: a walk that unlinked nothing never refetches a 304 child', async () => {
	lastMod[C2] = MON;
	await walk({ [ROOT]: index(C1, C2), [C1]: urlset(P(1)), [C2]: urlset(P(2)) });
	fetchLog.length = 0;
	await walk({ [ROOT]: index(C1, C2), [C1]: urlset(P(1), P(3)), [C2]: urlset(P(2)) });
	assert.equal(fetchLog.filter((f) => f.url === C2).length, 1);
});

// ---- S2: a discovered URL's first listing ----

test('a discovered URL’s FIRST listing is filed due now, sitemap-listed, inside the new-target cap', async () => {
	targets.set(P(7), { url: P(7) }); // minted by discovery: no attribution, no stamp
	const minuteBefore = Math.floor(Date.now() / 60_000) * 60_000;
	const result = await walk({ [ROOT]: index(C1), [C1]: urlset(P(7)) });
	assert.equal(attributed(P(7)), C1);
	assert.equal(result.listedSoon, 1);
	const filed = schedulePuts.filter((row) => row.key === P(7));
	assert.equal(filed.length, 1);
	assert.equal(filed[0].fromSitemap, true);
	assert.ok(filed[0].nextRenderTime >= minuteBefore && filed[0].nextRenderTime <= Date.now());
});

test('a first listing never files a row LATER than it already was due, and window 0 turns the fast path off', async () => {
	const earlier = Date.now() - 3_600_000;
	targets.set(P(7), { url: P(7) });
	scheduleRows.set(P(7), { nextRenderTime: earlier, fromSitemap: false, effectiveInterval: null });
	await walk({ [ROOT]: index(C1), [C1]: urlset(P(7)) });
	assert.equal(scheduleRows.get(P(7)).nextRenderTime, earlier);

	targets.clear();
	schedulePuts.length = 0;
	configure({ sitemap: { newTargets: { window: 0, maxPerRun: 5000 } } });
	targets.set(P(8), { url: P(8) });
	const result = await walk({ [ROOT]: index(C1), [C1]: urlset(P(8)) });
	assert.equal(result.listedSoon, 0);
	assert.equal(schedulePuts.length, 0);
});

test('a first listing brings forward the recheck of a verdict the listing contradicts — never a gone one', async () => {
	targets.set(P(5), { url: P(5), state: 'suppressed', suppressedReason: 'canonical-mismatch', strikes: 1 });
	targets.set(P(6), { url: P(6), state: 'suppressed', suppressedReason: 'http-gone', strikes: 1 });
	await walk({ [ROOT]: index(C1), [C1]: urlset(P(5), P(6)) });
	assert.equal(schedulePuts.filter((row) => row.key === P(5)).length, 1, 'the canonical-mismatch recheck is due now');
	assert.equal(schedulePuts.filter((row) => row.key === P(6)).length, 0, 'gone is left to its reopen path');
});

test('only a FIRST listing takes the fast path: a move between sitemaps keeps its schedule', async () => {
	await walk({ [ROOT]: index(C1, C2), [C1]: urlset(P(1)), [C2]: urlset(P(2)) });
	schedulePuts.length = 0;
	const result = await walk({ [ROOT]: index(C1, C2), [C1]: urlset(P(1), P(2)), [C2]: urlset(P(3)) });
	assert.equal(attributed(P(2)), C1);
	assert.equal(result.listedSoon, 0);
	assert.equal(schedulePuts.filter((row) => row.key === P(2)).length, 0);
});

test('first listings and creates share one maxPerRun', async () => {
	configure({ sitemap: { newTargets: { window: 15 * 60_000, maxPerRun: 1 } } });
	targets.set(P(7), { url: P(7) });
	targets.set(P(8), { url: P(8) });
	const result = await walk({ [ROOT]: index(C1), [C1]: urlset(P(7), P(8)) });
	assert.equal(result.listedSoon, 1);
});

// ---- M2: departures and rejoins filed as changes ----

test('a departure is filed as a change and keeps the change mark and demand a probe filed earlier', async () => {
	await walk({ [ROOT]: index(C1), [C1]: urlset(P(1), P(2)) });
	const markedAt = Date.now() - 7_200_000;
	scheduleRows.set(P(2), {
		nextRenderTime: Date.now() + 86_400_000,
		fromSitemap: true,
		effectiveInterval: null,
		changedAt: markedAt,
		demandPeriod: 3_600_000,
	});
	for (const key of cacheKeysOf(P(2))) pages.set(key, { expiresAt: Date.now() + 86_400_000 });

	const minuteBefore = Math.floor(Date.now() / 60_000) * 60_000;
	const result = await walk({ [ROOT]: index(C1), [C1]: urlset(P(1)) });
	assert.equal(result.departures.outcomes.render, 1);
	const row = scheduleRows.get(P(2));
	assert.ok(row.nextRenderTime >= minuteBefore && row.nextRenderTime <= Date.now(), 'due now');
	assert.equal(row.changedAt, markedAt, 'the probe’s mark keeps its first instant');
	assert.equal(row.demandPeriod, 3_600_000, 'and its demand');
	assert.equal(row.fromSitemap, false);

	for (const key of cacheKeysOf(P(2))) {
		const patch = pagePatches.find((p) => p.id === key);
		assert.equal(patch.cacheKey, key, 'the page key rides the expiry patch');
	}
});

test('a departure of an unmarked row files a fresh change mark', async () => {
	await walk({ [ROOT]: index(C1), [C1]: urlset(P(1), P(2)) });
	const before = Date.now();
	await walk({ [ROOT]: index(C1), [C1]: urlset(P(1)) });
	assert.ok(scheduleRows.get(P(2)).changedAt >= before);
});

// ---- S4: the key rides every patch ----

test('every Target patch a walk issues names the primary key', async () => {
	await walk({ [ROOT]: index(C1, C2), [C1]: urlset(P(1), P(2)), [C2]: urlset(P(3)) });
	targets.set(P(7), { url: P(7) });
	await walk({ [ROOT]: index(C1, C2), [C1]: urlset(P(1)), [C2]: urlset(P(2), P(3), P(7)) });
	await walk({ [ROOT]: index(C1, C2), [C1]: urlset(P(4)) }); // P1 unlinked, C2 fails: P1 re-linked
	assert.deepEqual(
		patches.map((p) => [p.id, p.sitemapUrl]),
		[
			[P(2), null],
			[P(2), C2],
			[P(7), C2],
			[P(1), null],
			[P(1), C1],
		]
	);
	for (const patch of patches) assert.equal(patch.url, patch.id, JSON.stringify(patch));
});

// ---- F8: the bypass token ----

test('the bypass token goes to the root sitemap’s host and to `domains`, never to another host', async () => {
	const partner = 'https://sitemaps.partner.example.net/c2.xml';
	await walk({ [ROOT]: index(C1, partner), [C1]: urlset(P(1)), [partner]: urlset(P(2)) });
	const sent = (url) => fetchLog.find((f) => f.url === url).headers['x-bypass'];
	assert.equal(sent(ROOT), 'SECRET');
	assert.equal(sent(C1), 'SECRET');
	assert.equal(sent(partner), undefined);
	assert.ok(
		fetchLog.every((f) => f.redirect === 'manual'),
		'redirects are followed by hand, never by fetch'
	);

	configure({ domains: ['sitemaps.partner.example.net'] });
	fetchLog.length = 0;
	await walk();
	assert.equal(sent(partner), 'SECRET', 'a host the deployment names is trusted');
});

test('a redirect re-decides the token on every hop, and the document is ingested under the URL that was asked for', async () => {
	const moved = 'https://cdn.partner.example.net/moved_1.xml';
	redirects[C1] = moved;
	await walk({ [ROOT]: index(C1), [moved]: urlset(P(1)) });
	const hops = fetchLog.filter((f) => f.url === C1 || f.url === moved);
	assert.deepEqual(
		hops.map((f) => [f.url, f.headers['x-bypass']]),
		[
			[C1, 'SECRET'],
			[moved, undefined],
		]
	);
	assert.equal(attributed(P(1)), C1);
});

test('a relative Location resolves against the hop, and a redirect loop fails the child', async () => {
	redirects[C1] = '/sitemap_product_1_v2.xml';
	const v2 = `${HOST}/sitemap_product_1_v2.xml`;
	await walk({ [ROOT]: index(C1), [v2]: urlset(P(1)) });
	assert.equal(fetchLog.find((f) => f.url === v2).headers['x-bypass'], 'SECRET');

	redirects[v2] = C1; // C1 -> v2 -> C1 -> ...
	const looped = await walk();
	assert.equal(looped.failed.length, 1);
	assert.match(looped.failed[0].error, /more than 5 redirects/);
});

// ---- S8: bounded entries ----

test('a urlset row keeps a bounded sample of its entries and the true count; an index keeps its whole list', async () => {
	const many = range(0, 600);
	await walk({ [ROOT]: index(C1, C2), [C1]: urlset(...many), [C2]: urlset(P(1000)) });
	assert.equal(sitemapRows.get(C1).entryCount, 600);
	assert.equal(sitemapRows.get(C1).entries.length, 500);
	assert.equal(sitemapRows.get(C1).entries[0].loc, P(0), 'the leading sample, in document order');
	assert.equal(sitemapRows.get(ROOT).entries.length, 2);
});

// ---- S7: blocking REST writers run outside the request context ----

test('POST /sitemaps with background:false walks outside the request’s async context and still answers with the result', async () => {
	documents = { [ROOT]: index(C1), [C1]: urlset(P(1)) };
	const results = await request.run({ request: 'POST /sitemaps' }, () =>
		new sitemaps(ROOT).post({ background: false })
	);
	assert.equal(results.length, 1);
	assert.equal(results[0].created, 1);
	assert.ok(fetchLog.length > 0);
	assert.ok(
		fetchLog.every((f) => f.store === undefined),
		'no fetch ran on the request’s context'
	);
});

test('DELETE /sitemaps/<url> cascades outside the request’s async context, then drops its own row', async () => {
	await walk({ [ROOT]: index(C1), [C1]: urlset(P(1), P(2)) });
	searchStores.length = 0;
	const deleted = await request.run({ request: 'DELETE' }, () => new sitemaps(C1).delete());
	assert.equal(deleted, true);
	assert.equal(targets.has(P(1)) || targets.has(P(2)), false);
	assert.equal(sitemapRows.has(C1), false);
	assert.ok(searchStores.length > 0);
	assert.ok(
		searchStores.every((store) => store === undefined),
		'the target scan ran detached'
	);
});

test('POST /Target {action: revalidate} runs outside the request’s async context and keeps its response shape', async () => {
	targets.set(P(1), { url: P(1), sitemapUrl: C1 });
	searchStores.length = 0;
	const result = await request.run({ request: 'POST /Target' }, () => new Target().post({ action: 'revalidate' }, {}));
	assert.deepEqual(result, { revalidating: 1, examined: 1, truncated: false });
	assert.deepEqual(searchStores, [undefined]);
});
