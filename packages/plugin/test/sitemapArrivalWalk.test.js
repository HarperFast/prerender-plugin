/**
 * `Target.unlistedAt` and the sitemap arrival check, driven through REAL walks (`Sitemap.refresh`)
 * against in-memory tables and a faked origin.
 *
 * What is pinned here is what a helper-level test cannot see: that the unlink and the re-attach write
 * the stamp in the patches the walk already makes; that a URL shifting to a later child inside ONE
 * walk (paginated-sitemap shear) is unlinked, stamped, re-attached and cleared WITHOUT reading as a
 * rejoin; that a URL returning in a LATER walk does; and that the executor, the ceilings and the dry
 * run behave for arrivals exactly as they do for departures.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

const targets = new Map(); // url -> Target row
const pages = new Map(); // cacheKey -> PrerenderedPage row
const sitemapRows = new Map();
const patches = []; // every Target.patch, in order
const tablePuts = []; // every raw Target put (the sitemap CREATE path and Target.suppress)
const schedulePuts = [];
let documents = {};

const project = (row, select) => {
	if (!select) return { ...row };
	if (typeof select === 'string') return row[select];
	return Object.fromEntries(select.map((key) => [key, row[key]]));
};

let applyOptions, config, sitemaps, cacheKeysOf, Target;

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
				static async patch(id, fields) {
					patches.push({ id, ...fields });
					const row = targets.get(id);
					if (!row) throw new Error(`patch of a missing target ${id}`);
					Object.assign(row, fields);
				}
				// A put REPLACES the row, as Harper's does — which is what makes the suppress test mean something.
				static async put(id, data) {
					tablePuts.push({ id, data });
					targets.set(id, { ...data, url: id });
				}
				static async delete(id) {
					targets.delete(id);
				}
				static search({ select, conditions = [] }) {
					const rows = [...targets.values()].filter((row) =>
						conditions.every((condition) => row[condition.attribute] === condition.value)
					);
					return (async function* () {
						for (const row of rows) yield project(row, select);
					})();
				}
			},
			QueueControl: class {},
		},
		render_schedule: {
			RenderSchedule: class {
				static async put(key, row) {
					schedulePuts.push({ key, ...row });
				}
				static async delete() {}
			},
		},
		page_cache: {
			PrerenderedPage: class {
				static async get({ id }) {
					return pages.has(id) ? { cacheKey: id, ...pages.get(id) } : undefined;
				}
				static async patch(id, fields) {
					Object.assign(pages.get(id), fields);
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
				static async get({ id, select }) {
					const row = sitemapRows.get(id);
					return row ? project(row, select) : undefined;
				}
				static async put(id, row) {
					sitemapRows.set(id, { ...row, url: id });
				}
				static search() {
					return (async function* () {})();
				}
			},
			SitemapRefresh: class {},
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
	globalThis.fetch = async (url) => {
		const xml = documents[url];
		return xml === undefined
			? new Response('missing', { status: 404, statusText: 'Not Found' })
			: new Response(xml, { status: 200 });
	};

	({ applyOptions, config } = await import('../src/config.js'));
	({ sitemaps } = await import('../src/resources/Sitemap.js'));
	({ cacheKeysOf, Target } = await import('../src/resources/Target.js'));
});

const ROOT = 'https://site.example.com/sitemap_index.xml';
const C1 = 'https://site.example.com/sitemap_product_1.xml';
const C2 = 'https://site.example.com/sitemap_product_2.xml';
const P = (n) => `https://site.example.com/product/prd-${n}`;
const CATALOG = 'https://site.example.com/catalog/shoes';

const index = (...children) =>
	`<?xml version="1.0"?><sitemapindex>${children.map((c) => `<sitemap><loc>${c}</loc></sitemap>`).join('')}</sitemapindex>`;
const urlset = (...urls) =>
	`<?xml version="1.0"?><urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;

/** Publish the two children's contents, then walk. */
const walk = async ({ c1, c2, revalidate = false }) => {
	documents = { [ROOT]: index(C1, C2), [C1]: urlset(...c1), [C2]: urlset(...c2) };
	return sitemaps.refresh(ROOT, { revalidate });
};

const configure = ({ arrival = {}, productArrival = 'render', catalogArrival = null } = {}) =>
	applyOptions({
		sitemap: {
			departure: { enabled: true, dryRun: true },
			arrival: { enabled: true, dryRun: true, ...arrival },
		},
		ingress: {
			mode: 'forwarded',
			routes: [
				{
					match: 'prefix',
					path: '/product/',
					departureAction: 'render',
					...(productArrival ? { arrivalAction: productArrival } : {}),
				},
				{ match: 'prefix', path: '/catalog/', ...(catalogArrival ? { arrivalAction: catalogArrival } : {}) },
			],
		},
	});

const stampOf = (url) => targets.get(url)?.unlistedAt;

beforeEach(() => {
	targets.clear();
	pages.clear();
	sitemapRows.clear();
	patches.length = 0;
	tablePuts.length = 0;
	schedulePuts.length = 0;
	configure();
});

// ---- the stamp ----

test('an unlink stamps unlistedAt with the WALK’s start, in the same patch that clears sitemapUrl', async () => {
	await walk({ c1: [P(1), P(2)], c2: [P(3)] });
	assert.equal(stampOf(P(1)), undefined, 'a freshly created target carries no stamp');

	patches.length = 0;
	const before = Date.now();
	await walk({ c1: [P(2)], c2: [P(3)] });
	const after = Date.now();

	const unlink = patches.find((p) => p.id === P(1));
	assert.deepEqual(Object.keys(unlink).sort(), ['id', 'sitemapUrl', 'unlistedAt'], 'one patch, no extra write');
	assert.equal(unlink.sitemapUrl, null);
	assert.ok(unlink.unlistedAt instanceof Date);
	assert.ok(unlink.unlistedAt.getTime() >= before && unlink.unlistedAt.getTime() <= after);
	assert.equal(targets.get(P(1)).sitemapUrl, null);
	assert.equal(stampOf(P(2)), undefined, 'targets still listed are not touched');
});

test('a re-attach clears the stamp in the same patch that restores the attribution', async () => {
	await walk({ c1: [P(1), P(2)], c2: [P(3)] });
	await walk({ c1: [P(2)], c2: [P(3)] }); // P1 leaves
	assert.ok(stampOf(P(1)) instanceof Date);

	await sleep(5);
	patches.length = 0;
	await walk({ c1: [P(2)], c2: [P(1), P(3)] }); // P1 returns, to another child

	const reattach = patches.find((p) => p.id === P(1));
	assert.equal(reattach.sitemapUrl, C2);
	assert.equal(reattach.unlistedAt, null);
	assert.equal(stampOf(P(1)), null);
});

// THE shear case: a URL that moves to a LATER child is pruned by the child it left before the child
// that now claims it is reached. Its stamp is this walk's own start, so it must not read as a rejoin.
test('SHEAR: a URL moving to a later child in ONE walk is stamped, re-attached and cleared — and is not a rejoin', async () => {
	await walk({ c1: [P(1), P(2)], c2: [P(3)] });

	patches.length = 0;
	const result = await walk({ c1: [P(2)], c2: [P(1), P(3)] });

	const writes = patches.filter((p) => p.id === P(1));
	assert.equal(writes.length, 2, 'unlinked by C1, then re-attached by C2');
	assert.equal(writes[0].sitemapUrl, null);
	assert.ok(writes[0].unlistedAt instanceof Date, 'the prune stamped it');
	assert.equal(writes[1].sitemapUrl, C2);
	assert.equal(writes[1].unlistedAt, null, 'and the re-attach cleared it');
	assert.equal(stampOf(P(1)), null);

	assert.equal(result.arrivals.considered, 0, 'shear is not a rejoin');
	assert.deepEqual(result.arrivals.outcomes, {});
	assert.equal(result.departures.outcomes.reattached, 1, 'and the departure check drops it as shear too');
});

test('a URL moving to an EARLIER child is re-attached before its old child is pruned, and never stamped', async () => {
	await walk({ c1: [P(1)], c2: [P(2), P(3)] });

	patches.length = 0;
	const result = await walk({ c1: [P(1), P(3)], c2: [P(2)] });

	const writes = patches.filter((p) => p.id === P(3));
	assert.equal(writes.length, 1);
	assert.equal(writes[0].sitemapUrl, C1);
	assert.equal(writes[0].unlistedAt, null);
	assert.equal(result.arrivals.considered, 0);
});

// ---- the arrival check ----

test('a genuine rejoin — unlinked by an EARLIER walk — is a candidate, and a dry run acts on nothing', async () => {
	await walk({ c1: [P(1), P(2)], c2: [P(3)] });
	await walk({ c1: [P(2)], c2: [P(3)] }); // P1 leaves
	await sleep(5); // walks must start on different milliseconds for the stamp to predate the next one

	schedulePuts.length = 0;
	const result = await walk({ c1: [P(1), P(2)], c2: [P(3)] });

	assert.equal(result.arrivals.considered, 1);
	assert.deepEqual(result.arrivals.outcomes, { 'would-render': 1 });
	assert.equal(schedulePuts.length, 0, 'dry run writes no schedule');
	assert.equal(targets.get(P(1)).sitemapUrl, C1);
	assert.equal(stampOf(P(1)), null);
});

test('an armed rejoin hard-expires the cached pages past swrTtl and files the URL due at the current minute', async () => {
	configure({ arrival: { dryRun: false } });
	await walk({ c1: [P(1), P(2)], c2: [P(3)] });
	await walk({ c1: [P(2)], c2: [P(3)] });
	for (const key of cacheKeysOf(P(1))) pages.set(key, { expiresAt: Date.now() + 86_400_000 });
	await sleep(5);

	schedulePuts.length = 0;
	const minuteBefore = Math.floor(Date.now() / 60_000) * 60_000;
	const result = await walk({ c1: [P(1), P(2)], c2: [P(3)] });
	const now = Date.now();

	assert.deepEqual(result.arrivals.outcomes, { render: 1 });
	for (const key of cacheKeysOf(P(1))) {
		assert.ok(
			pages.get(key).expiresAt <= now - config.page.swrTtl,
			`${key} is past the swr window, not merely expired`
		);
	}
	const filed = schedulePuts.filter((row) => row.key === P(1));
	assert.equal(filed.length, 1, 'ONE schedule row, keyed by the URL');
	assert.equal(filed[0].fromSitemap, true, 'a rejoined URL is sitemap-listed');
	assert.ok(filed[0].nextRenderTime >= minuteBefore && filed[0].nextRenderTime <= now);
	assert.equal(filed[0].effectiveInterval, config.render.defaultInterval);
});

test('a rejoin on a route that has not opted in is decided and counted, never acted on', async () => {
	configure({ arrival: { dryRun: false } }); // product opts in, catalog does not
	await walk({ c1: [CATALOG, P(2)], c2: [P(3)] });
	await walk({ c1: [P(2)], c2: [P(3)] }); // the catalog URL leaves
	await sleep(5);

	schedulePuts.length = 0;
	const result = await walk({ c1: [CATALOG, P(2)], c2: [P(3)] });
	assert.deepEqual(result.arrivals.outcomes, { 'route-opted-out': 1 });
	assert.equal(schedulePuts.length, 0);
});

test('a suppressed target that rejoins is left to suppression', async () => {
	configure({ arrival: { dryRun: false } });
	await walk({ c1: [P(1), P(2)], c2: [P(3)] });
	await walk({ c1: [P(2)], c2: [P(3)] });
	targets.get(P(1)).state = 'suppressed';
	await sleep(5);

	schedulePuts.length = 0;
	const result = await walk({ c1: [P(1), P(2)], c2: [P(3)] });
	assert.deepEqual(result.arrivals.outcomes, { suppressed: 1 });
	assert.equal(schedulePuts.length, 0);
});

test('a discovered target a sitemap lists for the first time is re-attributed, not an arrival', async () => {
	await walk({ c1: [P(2)], c2: [P(3)] });
	targets.set(P(9), { url: P(9), sitemapUrl: null }); // discovered from traffic: no stamp

	const result = await walk({ c1: [P(2), P(9)], c2: [P(3)] });
	assert.equal(targets.get(P(9)).sitemapUrl, C1);
	assert.equal(result.arrivals.considered, 0);
});

test('ceilings: maxActions caps what is acted on, maxCandidates what is held, and -1 lifts both', async () => {
	const rejoinThree = async () => {
		targets.clear();
		await walk({ c1: [P(1), P(2), P(3), P(4)], c2: [P(5)] });
		await walk({ c1: [P(4)], c2: [P(5)] }); // P1..P3 leave
		await sleep(5);
		return walk({ c1: [P(1), P(2), P(3), P(4)], c2: [P(5)] });
	};

	configure({ arrival: { maxActions: 1 } });
	let result = await rejoinThree();
	assert.deepEqual(result.arrivals.outcomes, { 'would-render': 1, 'capped': 2 });

	configure({ arrival: { maxActions: 0 } });
	result = await rejoinThree();
	assert.deepEqual(result.arrivals.outcomes, { capped: 3 }, '0 acts on nothing, and still decides every candidate');

	configure({ arrival: { maxCandidates: 2 } });
	result = await rejoinThree();
	assert.equal(result.arrivals.considered, 2);
	assert.equal(result.arrivals.capped, true);

	configure({ arrival: { maxActions: -1, maxCandidates: -1 } });
	result = await rejoinThree();
	assert.deepEqual(result.arrivals.outcomes, { 'would-render': 3 });
	assert.equal(result.arrivals.capped, false);
});

test('the arrival dry run is its own switch: armed departures do not arm arrivals', async () => {
	applyOptions({
		sitemap: { departure: { enabled: true, dryRun: false }, arrival: { enabled: true } },
		ingress: {
			mode: 'forwarded',
			routes: [{ match: 'prefix', path: '/product/', departureAction: 'render', arrivalAction: 'render' }],
		},
	});
	assert.equal(config.sitemap.arrival.dryRun, true);
	await walk({ c1: [P(1), P(2)], c2: [P(3)] });
	await walk({ c1: [P(2)], c2: [P(3)] });
	await sleep(5);
	const result = await walk({ c1: [P(1), P(2)], c2: [P(3)] });
	assert.deepEqual(result.arrivals.outcomes, { 'would-render': 1 });
});

test('a revalidate walk detects no rejoin, and its put clears the stamp by replacing the row', async () => {
	configure({ arrival: { dryRun: false } });
	await walk({ c1: [P(1), P(2)], c2: [P(3)] });
	await walk({ c1: [P(2)], c2: [P(3)] });
	await sleep(5);

	const result = await walk({ c1: [P(1), P(2)], c2: [P(3)], revalidate: true });
	assert.equal(result.arrivals.considered, 0);
	assert.equal(stampOf(P(1)), undefined);
	assert.equal(targets.get(P(1)).sitemapUrl, C1);
});

// ---- defaults ----

test('defaults: with no arrivalAction anywhere, a rejoin collects nothing and files nothing', async () => {
	configure({ productArrival: null });
	await walk({ c1: [P(1), P(2)], c2: [P(3)] });
	await walk({ c1: [P(2)], c2: [P(3)] });
	await sleep(5);

	schedulePuts.length = 0;
	const result = await walk({ c1: [P(1), P(2)], c2: [P(3)] });
	assert.deepEqual(result.arrivals, { considered: 0, capped: false, outcomes: {} });
	assert.equal(schedulePuts.length, 0);
	// The stamp is recorded whatever the arrival config says — it is what a later `scope: listed` or
	// `arrivalAction` needs history from — and it rides writes the walk makes anyway.
	assert.equal(stampOf(P(1)), null);
});

// ---- the other writer of sitemapUrl: suppression's whole-row put ----

test('Target.suppress carries unlistedAt across its whole-row put, beside sitemapUrl', async () => {
	const stamp = new Date(Date.parse('2026-09-20T06:00:00Z'));
	targets.set(P(7), { url: P(7), sitemapUrl: null, unlistedAt: stamp, strikes: 0 });

	const { deleted } = await Target.suppress(P(7), { reason: 'noindex' });
	assert.equal(deleted, false);
	const put = tablePuts.find((p) => p.id === P(7));
	assert.equal(put.data.state, 'suppressed');
	assert.equal(put.data.unlistedAt, stamp, 'dropping it would make a recently-unlisted target read as never listed');
	assert.equal(targets.get(P(7)).unlistedAt, stamp);

	// A listed target has no stamp, and suppression must not invent one.
	targets.set(P(8), { url: P(8), sitemapUrl: C1, strikes: 0 });
	await Target.suppress(P(8), { reason: 'noindex' });
	assert.equal(targets.get(P(8)).unlistedAt, null);
	assert.equal(targets.get(P(8)).sitemapUrl, C1);
});
