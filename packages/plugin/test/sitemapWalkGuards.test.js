/**
 * What a sitemap walk must NOT conclude from a bad or partial view of the corpus, driven through REAL
 * walks (`Sitemap.refresh`) against in-memory tables and a faked origin that answers conditionally,
 * fails, redirects and truncates on demand.
 *
 *  - a failed child holds back, and puts back, only the URLs that could have moved into it;
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

test('a FAILED child holds back the URLs that could have moved into it: re-linked, and the next walk sees no rejoin', async () => {
	lastMod[C1] = MON;
	await walk({ [ROOT]: index(C1, C2), [C1]: urlset(P(1), P(2), P(3)), [C2]: urlset(P(4)) });
	for (const key of cacheKeysOf(P(2))) pages.set(key, { expiresAt: Date.now() + 86_400_000 });

	// Paginated shift: P2 and P3 move into C2, and C2's fetch fails this walk.
	lastMod[C1] = TUE;
	schedulePuts.length = 0;
	const failed = await walk({ [ROOT]: index(C1, C2), [C1]: urlset(P(1)) });

	assert.equal(failed.failed.length, 1);
	assert.deepEqual(failed.departures.outcomes, { relinked: 2 }, 'neither shifted URL departs');
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

test('the shrink guard refuses a DOCUMENT much shorter than the last accepted, and maxRatio 1 lets it through', async () => {
	configure({ sitemap: { shrinkGuard: { maxRatio: 0.5, minUrls: 3, acceptAfter: 3 } } });
	await walk({ [ROOT]: index(C1), [C1]: urlset(...range(0, 10)) });

	const refused = await walk({ [ROOT]: index(C1), [C1]: urlset(P(0), P(1)) });
	assert.equal(refused.failed.length, 1);
	assert.match(refused.failed[0].error, /refusing a document of 2 entries against the 10 last accepted.*maxRatio=0\.5/);
	assert.equal(refused.shrinkRefused, 1);
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

// Probe 1 of the round-2 review: the guard used to measure would-be-unlinked ÷ attributed, which counts
// every URL that MOVED. Forward shear across fixed-size children tripped it on every walk, froze the old
// attribution, never created the head insertions, and held the one real departure back for good.
test('forward shear across FIXED-SIZE children is not a shrink: new URLs are created and only the real departure departs', async () => {
	configure({ sitemap: { shrinkGuard: { maxRatio: 0.5, minUrls: 3 } } });
	await walk({ [ROOT]: index(C1, C2), [C1]: urlset(...range(10, 20)), [C2]: urlset(...range(20, 30)) });
	// Six low-id URLs inserted at the head, P(25) genuinely removed; every child stays 10 long.
	const all = [...range(1, 7), ...range(10, 25), ...range(26, 30)];
	await sleep(2);
	const result = await walk({
		[ROOT]: index(C1, C2, C3),
		[C1]: urlset(...all.slice(0, 10)),
		[C2]: urlset(...all.slice(10, 20)),
		[C3]: urlset(...all.slice(20)),
	});
	assert.equal(result.failed.length, 0);
	assert.equal(result.shrinkRefused, 0);
	assert.equal(targets.has(P(1)), true, 'the head insertions are created');
	assert.equal(attributed(P(25)), null);
	assert.equal(result.departures.outcomes.render, 1, 'only P(25) departs');
	assert.ok(result.departures.outcomes.reattached >= 6, 'the rest is shear, recognised after the walk');
});

// Round-3 N1: acceptance used to count WALKS, so a bad nightly build served unchanged all day was believed
// on the fourth walk of the same day — a mass departure — and rejoined when the next rebuild fixed it.
test('a shorter document served unchanged all day stays refused: it is not accepted before it outlives a rebuild', async () => {
	configure({ sitemap: { shrinkGuard: { maxRatio: 0.5, minUrls: 3 } } });
	const full = { [ROOT]: index(C1), [C1]: urlset(...range(0, 20)) };
	await walk(full);
	const partial = { [ROOT]: index(C1), [C1]: urlset(...range(0, 4)) };
	for (let walks = 1; walks <= 4; walks++) {
		const result = await walk(partial);
		assert.equal(result.shrinkRefused, 1, `walk ${walks}`);
		assert.equal(result.removed, 0);
	}
	assert.equal(sitemapRows.get(C1).shrinkRefusals, 4);
	await sleep(2);
	const rebuilt = await walk(full);
	assert.equal(rebuilt.failed.length, 0);
	assert.equal(rebuilt.arrivals.considered, 0, 'nothing departed, so nothing rejoins');
	assert.equal(sitemapRows.get(C1).shrinkRefusals, undefined, 'the full document clears the refusal');
});

test('a refused shrink is accepted once it survives a NEW origin version, and not before acceptAfter refusals', async () => {
	configure({ sitemap: { shrinkGuard: { maxRatio: 0.5, minUrls: 3, acceptAfter: 2 } } });
	lastMod[C1] = MON;
	await walk({ [ROOT]: index(C1), [C1]: urlset(...range(0, 10)) });

	lastMod[C1] = TUE; // the bad build
	const short = { [ROOT]: index(C1), [C1]: urlset(P(0), P(1)) };
	assert.equal((await walk(short)).shrinkRefused, 1);
	assert.equal(sitemapRows.get(C1).shrinkRefusedVersion.startsWith(TUE), true);
	lastMod[C1] = 'Wed, 03 Sep 2026 00:00:00 GMT'; // the next build: still short
	const accepted = await walk(short);
	assert.equal(accepted.shrinkRefused, 1, 'a new version on the FIRST refusal is still under acceptAfter');
	const believed = await walk(short);
	assert.equal(believed.shrinkAccepted, 1);
	assert.equal(believed.failed.length, 0);
	assert.equal(believed.removed, 8);
	assert.equal(sitemapRows.get(C1).entryCount, 2);
	assert.equal(sitemapRows.get(C1).shrinkRefusals, undefined, 'the accepted put clears the refusal');
});

test('a refused shrink with no new version is accepted after acceptAge', async () => {
	configure({ sitemap: { shrinkGuard: { maxRatio: 0.5, minUrls: 3, acceptAfter: 2, acceptAge: 20 } } });
	await walk({ [ROOT]: index(C1), [C1]: urlset(...range(0, 10)) });
	const short = { [ROOT]: index(C1), [C1]: urlset(P(0), P(1)) };
	assert.equal((await walk(short)).shrinkRefused, 1);
	assert.equal((await walk(short)).shrinkRefused, 1, 'not yet aged');
	await sleep(25);
	assert.equal((await walk(short)).shrinkAccepted, 1);
});

test('an accepted shrink releases at most releasePerWalk departures a walk, and the rest on later walks', async () => {
	configure({
		sitemap: { shrinkGuard: { maxRatio: 0.5, minUrls: 3, acceptAfter: 1, acceptAge: 0, releasePerWalk: 3 } },
	});
	lastMod[C1] = MON;
	await walk({ [ROOT]: index(C1), [C1]: urlset(...range(0, 10)) });
	lastMod[C1] = TUE;
	const short = { [ROOT]: index(C1), [C1]: urlset(P(0), P(1)) };
	await walk(short); // refused once
	const first = await walk(short);
	assert.equal(first.shrinkAccepted, 1);
	assert.equal(first.removed, 3);
	assert.equal(first.shrinkHeldBack, 5);
	assert.equal(first.departures.outcomes.render, 3);
	assert.equal(sitemapRows.get(C1).shrinkRelease, true);
	assert.equal(sitemapRows.get(C1).lastModified, null, 'refetched in full next walk');

	const second = await walk(short);
	assert.equal(second.shrinkRefused, 0, 'already accepted: not judged again');
	assert.equal(second.removed, 3);
	assert.equal(second.shrinkHeldBack, 2);
	const third = await walk(short);
	assert.equal(third.removed, 2);
	assert.equal(third.shrinkHeldBack, 0);
	assert.equal(sitemapRows.get(C1).shrinkRelease, undefined, 'done releasing');
	assert.equal(sitemapRows.get(C1).lastModified, TUE, 'conditional again');
});

// ---- S1: a child the index stops listing ----

test('a child the index STOPS LISTING is pruned after the walk: what moved stays, what is listed nowhere departs', async () => {
	await walk({
		[ROOT]: index(C1, C2, C3),
		[C1]: urlset(...range(10, 15)),
		[C2]: urlset(P(2), P(3)),
		[C3]: urlset(...range(20, 25)),
	});
	assert.equal(attributed(P(3)), C2);

	schedulePuts.length = 0;
	const result = await walk({
		[ROOT]: index(C1, C3),
		[C1]: urlset(...range(10, 15), P(2)),
		[C3]: urlset(...range(20, 25)),
	});
	assert.equal(attributed(P(2)), C1, 'the URL that moved is re-attached, not departed');
	assert.equal(attributed(P(3)), null, 'the one listed nowhere is unlinked');
	assert.equal(result.removed, 1);
	assert.equal(result.departures.outcomes.render, 1);
	assert.equal(sitemapRows.has(C2), false, 'and the dropped child row is gone');
	assert.equal(targets.has(P(2)) && targets.has(P(3)), true, 'without deleting any target');
});

// Probe 3: a well-formed PARTIAL index omitting many small children used to depart all of them and drop
// their rows, and they rejoined — two renders each — the next walk.
// Probe 3 (round 2): a well-formed PARTIAL index omitting many small children used to depart all of them
// and drop their rows, and they rejoined — two renders each — the next walk.
test('an index that omits most of its children is refused: nothing is pruned, and the full index brings no rejoin', async () => {
	configure({ sitemap: { shrinkGuard: { maxRatio: 0.5, minUrls: 3 } } });
	const C4 = `${HOST}/sitemap_product_4.xml`;
	const docs = {
		[ROOT]: index(C1, C2, C3, C4),
		[C1]: urlset(...range(0, 5)),
		[C2]: urlset(...range(5, 10)),
		[C3]: urlset(...range(10, 15)),
		[C4]: urlset(...range(15, 20)),
	};
	lastMod[ROOT] = MON;
	await walk(docs);

	lastMod[ROOT] = TUE;
	schedulePuts.length = 0;
	const partial = await walk({ ...docs, [ROOT]: index(C1) });
	assert.equal(partial.shrinkRefused, 3, 'each omitted child refused');
	assert.equal(partial.removed, 0);
	assert.deepEqual(partial.departures.outcomes, {});
	assert.equal(schedulePuts.length, 0);
	for (const child of [C2, C3, C4]) assert.equal(sitemapRows.has(child), true);
	assert.equal(attributed(P(6)), C2);

	await sleep(2);
	lastMod[ROOT] = 'Wed, 03 Sep 2026 00:00:00 GMT'; // the fixed index
	const back = await walk(docs);
	assert.equal(back.shrinkRefused, 0);
	assert.equal(back.arrivals.considered, 0, 'nothing departed, so nothing rejoins');
});

// Round-3 N10: with only an index-wide share, ONE child omitted of many (its build failed) departed
// everything it held, uncapped, and deleted its row; everything rejoined when it came back.
test('an index that omits ONE child of many is refused for that child, held back, and nothing rejoins when it returns', async () => {
	configure({ sitemap: { shrinkGuard: { maxRatio: 0.5, minUrls: 3 } } });
	const C4 = `${HOST}/sitemap_product_4.xml`;
	const docs = {
		[ROOT]: index(C1, C2, C3, C4),
		[C1]: urlset(...range(0, 50)),
		[C2]: urlset(...range(50, 100)),
		[C3]: urlset(...range(100, 150)),
		[C4]: urlset(...range(150, 200)),
	};
	await walk(docs);
	const omitted = await walk({ ...docs, [ROOT]: index(C1, C2, C4) });
	assert.equal(omitted.shrinkRefused, 1);
	assert.deepEqual(
		omitted.failed.map((f) => f.url),
		[C3]
	);
	assert.equal(omitted.removed, 0);
	assert.equal(sitemapRows.has(C3), true);
	await sleep(2);
	const back = await walk(docs);
	assert.equal(back.arrivals.considered, 0);
	assert.equal(back.failed.length, 0);
});

// Round-3 N7: a refused partial index was not a failure, so a URL that sheared into a child it omitted
// was unlinked by its old child, re-attached by nobody, departed — and rejoined.
test('a URL that sheared into a child a refused index omits is held back, not departed', async () => {
	configure({ sitemap: { shrinkGuard: { maxRatio: 0.5, minUrls: 3 } } });
	await walk({
		[ROOT]: index(C1, C2, C3),
		[C1]: urlset(...range(0, 5)),
		[C2]: urlset(...range(5, 10)),
		[C3]: urlset(...range(10, 15)),
	});
	const partial = await walk({ [ROOT]: index(C1), [C1]: urlset(P(100), ...range(0, 4)) });
	assert.deepEqual(partial.departures.outcomes, { relinked: 1 });
	assert.equal(attributed(P(4)), C1);
	await sleep(2);
	const back = await walk({
		[ROOT]: index(C1, C2, C3),
		[C1]: urlset(P(100), ...range(0, 4)),
		[C2]: urlset(...range(4, 10)),
		[C3]: urlset(...range(10, 15)),
	});
	assert.equal(back.arrivals.considered, 0);
	assert.equal(attributed(P(4)), C2);
});

// Round-3 N3: judged by child NAMES, children renamed every build read as all dropped, every walk.
test('children renamed every build are not a partial index: a real departure in the old child departs', async () => {
	configure({ sitemap: { shrinkGuard: { maxRatio: 0.5, minUrls: 3 } } });
	const child = (v, n) => `${HOST}/sitemap_product_${n}.xml?v=${v}`;
	await walk({
		[ROOT]: index(child(0, 1), child(0, 2)),
		[child(0, 1)]: urlset(P(1), P(2), P(3)),
		[child(0, 2)]: urlset(P(4), P(5)),
	});
	for (let v = 1; v <= 3; v++) {
		await sleep(2);
		const result = await walk({
			[ROOT]: index(child(v, 1), child(v, 2)),
			[child(v, 1)]: urlset(P(1), P(2)),
			[child(v, 2)]: urlset(P(4), P(5)),
		});
		assert.equal(result.shrinkRefused, 0, `v=${v}`);
		assert.equal(sitemapRows.has(child(v - 1, 1)), false, 'the old rows go');
		if (v === 1) assert.deepEqual(result.departures.outcomes, { render: 1 });
	}
	assert.equal(attributed(P(3)), null, 'P(3) left the site and departed');
	assert.equal(sitemapRows.size, 3);
});

test('a small legitimate index change is not refused: the minUrls floor applies to dropped children too', async () => {
	await walk({ [ROOT]: index(C1, C2), [C1]: urlset(P(1)), [C2]: urlset(P(2), P(3)) });
	const result = await walk({ [ROOT]: index(C1), [C1]: urlset(P(1)) });
	assert.equal(result.shrinkRefused, 0);
	assert.equal(result.removed, 2);
	assert.equal(sitemapRows.has(C2), false);
});

test('an omitted child is accepted once its INDEX publishes a new version still without it, releasing in batches', async () => {
	configure({ sitemap: { shrinkGuard: { maxRatio: 0.5, minUrls: 3, acceptAfter: 1, releasePerWalk: 4 } } });
	lastMod[ROOT] = MON;
	const docs = { [ROOT]: index(C1, C2), [C1]: urlset(...range(0, 5)), [C2]: urlset(...range(5, 11)) };
	await walk(docs);
	lastMod[ROOT] = TUE;
	const omit = { ...docs, [ROOT]: index(C1) };
	assert.equal((await walk(omit)).shrinkRefused, 1);
	assert.equal((await walk(omit)).shrinkRefused, 1, 'the same index version: still refused');
	lastMod[ROOT] = 'Wed, 03 Sep 2026 00:00:00 GMT';
	const accepted = await walk(omit);
	assert.equal(accepted.shrinkAccepted, 1);
	assert.equal(accepted.removed, 4);
	assert.equal(accepted.shrinkHeldBack, 2);
	assert.equal(sitemapRows.has(C2), true, 'kept while it is still releasing');
	const rest = await walk(omit);
	assert.equal(rest.removed, 2);
	assert.equal(sitemapRows.has(C2), false);
});

test('a dropped child whose URLs moved into a FAILED child is re-linked, and its row outlives the walk', async () => {
	const C4 = `${HOST}/sitemap_product_4.xml`;
	await walk({
		[ROOT]: index(C1, C2, C4),
		[C1]: urlset(...range(10, 15)),
		[C2]: urlset(P(2), P(3)),
		[C4]: urlset(...range(20, 25)),
	});

	// The index replaces C2 with C3 — and C3, never fetched before, fails this walk.
	const failed = await walk({
		[ROOT]: index(C1, C3, C4),
		[C1]: urlset(...range(10, 15)),
		[C4]: urlset(...range(20, 25)),
	});
	assert.equal(failed.failed.length, 1);
	assert.deepEqual(
		failed.departures.outcomes,
		{ relinked: 2 },
		'a sibling that failed with no sample holds its siblings'
	);
	assert.equal(attributed(P(2)), C2);
	assert.equal(sitemapRows.has(C2), true, 'kept: its URLs were put back on it');

	const clean = await walk({
		[ROOT]: index(C1, C3, C4),
		[C1]: urlset(...range(10, 15)),
		[C3]: urlset(P(2), P(3)),
		[C4]: urlset(...range(20, 25)),
	});
	assert.equal(clean.failed.length, 0);
	assert.equal(attributed(P(2)), C3);
	assert.equal(attributed(P(3)), C3);
	assert.equal(sitemapRows.has(C2), false, 'dropped once nothing was put back on it');
});

// ---- a failed child holds back only what could have moved into it ----

test('a failed child on ANOTHER route holds nothing back: product departures proceed while the stores sitemap 404s', async () => {
	applyOptions({
		domains: [],
		origin: { securityToken: { header: 'x-bypass', value: 'SECRET' } },
		sitemap: {
			departure: { enabled: true, dryRun: false, maxActions: -1, maxCandidates: -1 },
			arrival: { enabled: true, dryRun: false, maxActions: -1, maxCandidates: -1 },
		},
		ingress: {
			mode: 'forwarded',
			routes: [{ match: 'prefix', path: '/product/', departureAction: 'render', arrivalAction: 'render' }],
		},
	});
	const STORES = `${HOST}/sitemap_stores.xml`;
	const S = (n) => `${HOST}/stores/store-${n}.shtml`; // routed nowhere, like a store locator
	await walk({ [ROOT]: index(STORES, C1), [STORES]: urlset(S(1), S(2)), [C1]: urlset(P(1), P(2)) });

	const result = await walk({ [ROOT]: index(STORES, C1), [C1]: urlset(P(1)) });
	assert.deepEqual(
		result.failed.map((f) => f.url),
		[STORES]
	);
	assert.deepEqual(result.departures.outcomes, { render: 1 }, 'P(2) departs');
	assert.equal(attributed(P(2)), null);
});

test('a failed child on the SAME route holds back only that route: a catalog departure still proceeds', async () => {
	applyOptions({
		domains: [],
		sitemap: {
			departure: { enabled: true, dryRun: false, maxActions: -1, maxCandidates: -1 },
			arrival: { enabled: true, dryRun: false, maxActions: -1, maxCandidates: -1 },
		},
		ingress: {
			mode: 'forwarded',
			routes: [
				{ match: 'prefix', path: '/product/', departureAction: 'render' },
				{ match: 'prefix', path: '/catalog/', departureAction: 'render' },
			],
		},
	});
	const CAT = `${HOST}/sitemap_catalog.xml`;
	const K = (n) => `${HOST}/catalog/c-${n}`;
	await walk({ [ROOT]: index(CAT, C1, C2), [CAT]: urlset(K(1), K(2)), [C1]: urlset(P(1), P(2)), [C2]: urlset(P(3)) });

	const result = await walk({ [ROOT]: index(CAT, C1, C2), [CAT]: urlset(K(1)), [C1]: urlset(P(1)) });
	assert.deepEqual(result.departures.outcomes, { relinked: 1, render: 1 });
	assert.equal(attributed(P(2)), C1, 'the product URL could have moved into the failed product child');
	assert.equal(attributed(K(2)), null, 'the catalog URL could not');
});

// Round-3 N2: the hold-back was scoped from the 500-entry sample alone, so a mixed child whose first 500
// entries share one route missed the others.
test('a failed MIXED child holds back every route it held, not only the ones in its first 500 entries', async () => {
	applyOptions({
		domains: [],
		sitemap: {
			departure: { enabled: true, dryRun: false, maxActions: -1, maxCandidates: -1 },
			arrival: { enabled: true, dryRun: false, maxActions: -1, maxCandidates: -1 },
		},
		ingress: {
			mode: 'forwarded',
			routes: [
				{ match: 'prefix', path: '/product/', departureAction: 'render', arrivalAction: 'render' },
				{ match: 'prefix', path: '/catalog/' },
			],
		},
	});
	const K = (n) => `${HOST}/catalog/c-${n}`;
	const cats = Array.from({ length: 600 }, (_, i) => K(i)); // catalog first, product after
	await walk({ [ROOT]: index(C1, C2), [C1]: urlset(P(1), P(2)), [C2]: urlset(...cats, P(3)) });
	assert.equal(sitemapRows.get(C2).routes.length, 2, 'both routes recorded from the whole document');

	const result = await walk({ [ROOT]: index(C1, C2), [C1]: urlset(P(1)) }); // P(2) moved into C2, which fails
	assert.deepEqual(result.departures.outcomes, { relinked: 1 });
	assert.equal(attributed(P(2)), C1);
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

// Probes 2 / 2b / 4 of the round-2 review: the re-read used to fetch every 304'd urlset in full whenever
// anything at all was held — shear the walk had already re-attached, or an unlink on a route nothing acts on.
test('shear alone re-reads nothing: a held URL the walk already re-attached is not pending', async () => {
	lastMod[C3] = MON;
	await walk({ [ROOT]: index(C1, C2, C3), [C1]: urlset(P(1), P(2)), [C2]: urlset(P(3)), [C3]: urlset(P(50), P(51)) });
	fetchLog.length = 0;
	const result = await walk({
		[ROOT]: index(C1, C2, C3),
		[C1]: urlset(P(1)),
		[C2]: urlset(P(2), P(3)),
		[C3]: urlset(P(50), P(51)),
	});
	assert.deepEqual(
		fetchLog.filter((f) => f.url === C3).map((f) => f.headers['If-Modified-Since']),
		[MON],
		'only the conditional fetch'
	);
	assert.deepEqual(result.departures.outcomes, { reattached: 1 });
});

test('an unlink on a route with no departure or arrival action re-reads nothing, and a pending product URL re-reads only product children', async () => {
	applyOptions({
		domains: [],
		sitemap: {
			departure: { enabled: true, dryRun: false, maxActions: -1, maxCandidates: -1 },
			arrival: { enabled: true, dryRun: false, maxActions: -1, maxCandidates: -1 },
			conditional: { enabled: true },
		},
		ingress: {
			mode: 'forwarded',
			routes: [
				{ match: 'prefix', path: '/product/', departureAction: 'render', arrivalAction: 'render' },
				{ match: 'prefix', path: '/catalog/' },
			],
		},
	});
	const CAT = `${HOST}/sitemap_catalog.xml`;
	const K = (n) => `${HOST}/catalog/c-${n}`;
	lastMod[CAT] = MON;
	lastMod[C1] = MON;
	lastMod[C2] = MON;
	await walk({
		[ROOT]: index(CAT, C1, C2),
		[CAT]: urlset(K(1), K(2)),
		[C1]: urlset(...range(0, 5)),
		[C2]: urlset(...range(5, 10)),
	});

	lastMod[CAT] = TUE;
	fetchLog.length = 0;
	await walk({
		[ROOT]: index(CAT, C1, C2),
		[CAT]: urlset(K(1)),
		[C1]: urlset(...range(0, 5)),
		[C2]: urlset(...range(5, 10)),
	});
	assert.equal(
		fetchLog.filter((f) => !f.headers['If-Modified-Since'] && f.url !== CAT && f.url !== ROOT).length,
		0,
		'no full re-read'
	);

	// Now a product URL really departs from C1 while CAT and C2 answer 304: only C2 could list it.
	lastMod[C1] = TUE;
	fetchLog.length = 0;
	const result = await walk({
		[ROOT]: index(CAT, C1, C2),
		[CAT]: urlset(K(1)),
		[C1]: urlset(...range(0, 4)),
		[C2]: urlset(...range(5, 10)),
	});
	const full = fetchLog.filter((f) => f.url !== ROOT && f.url !== C1 && !f.headers['If-Modified-Since']);
	assert.deepEqual(
		full.map((f) => f.url),
		[C2],
		'the catalog child shares no route with the pending URL'
	);
	assert.deepEqual(result.departures.outcomes, { render: 1 });
});

test('a transient failure re-reading an unchanged child is retried once, and does not hold the departure back', async () => {
	lastMod[C3] = MON;
	await walk({ [ROOT]: index(C1, C3), [C1]: urlset(P(1), P(2)), [C3]: urlset(P(50)) });
	let calls = 0;
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		if (url === C3 && !init.headers?.['If-Modified-Since'] && ++calls === 1) return new Response('x', { status: 503 });
		return realFetch(url, init);
	};
	try {
		const result = await walk({ [ROOT]: index(C1, C3), [C1]: urlset(P(1)), [C3]: urlset(P(50)) });
		assert.equal(result.failed.length, 0);
		assert.deepEqual(result.departures.outcomes, { render: 1 });
	} finally {
		globalThis.fetch = realFetch;
	}
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

test('the token is never sent in cleartext: not to a same-host http:// child, not across an https -> http redirect', async () => {
	const plain = 'http://site.example.com/sitemap_plain.xml';
	const downgraded = 'http://site.example.com/sitemap_moved.xml';
	redirects[C1] = downgraded;
	await walk({ [ROOT]: index(C1, plain), [plain]: urlset(P(1)), [downgraded]: urlset(P(2)) });
	const sent = (url) => fetchLog.find((f) => f.url === url)?.headers['x-bypass'];
	assert.equal(sent(C1), 'SECRET');
	assert.equal(sent(downgraded), undefined);
	assert.equal(sent(plain), undefined);
	assert.equal(attributed(P(1)), plain, 'fetched all the same — only the token is withheld');
});

test('a local origin may carry the token over http', async () => {
	const localRoot = 'http://127.0.0.1:9926/sitemap.xml';
	documents = { [localRoot]: urlset(P(1)) };
	await sitemaps.refresh(localRoot);
	assert.equal(fetchLog.find((f) => f.url === localRoot).headers['x-bypass'], 'SECRET');
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
