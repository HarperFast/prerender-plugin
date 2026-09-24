/**
 * The two departure ceilings, `sitemap.departure.maxActions` and `maxCandidates`, and their
 * uncapped setting.
 *
 * -1 means "no ceiling" for both. It has to be honoured by every layer that can set it (config.yaml,
 * a stored override) and by both places that enforce it (the walk's candidate list and the post-walk
 * action gate), and it must never report `capped` — a URL past either ceiling is dropped for good,
 * because the walk has already unlinked it, so "capped" is a statement about lost departures and an
 * uncapped deployment must never make it.
 *
 * `processDepartures` runs for real here against fake tables: the gate is the code under test, and a
 * copy of its comparison in a helper test would pass whatever the resource does.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let applyOptions, config, resolveConfig, defaultConfig;
let validateOverride;
let createRefreshRun;
let departureCandidateCap, departureLimit;
let processDepartures;

const warns = [];
// Every URL the post-walk re-read asks about, and what it answers: unlinked, not suppressed — a
// genuine departure on an opted-in route, so each one reaches the action gate.
const reads = [];
const pageReads = [];

before(async () => {
	globalThis.Resource = class {};
	globalThis.server = {
		hostname: 'node-1',
		workerIndex: 0,
		nodes: [],
		config: { http: { port: 9926 } },
		recordAnalytics() {},
	};
	globalThis.logger = { debug() {}, info() {}, warn: (msg) => warns.push(String(msg)), error() {} };
	// Sitemap.js's import graph destructures Harper tables at module load (see
	// test/configReactivity.test.js for why each of these is needed).
	const sabs = new Map();
	globalThis.databases = {
		render_service: {
			Target: class {
				static async get({ id }) {
					reads.push(id);
					return { url: id, sitemapUrl: null, state: null, renderInterval: null, demandInterval: null };
				}
			},
			QueueControl: class {},
		},
		render_schedule: { RenderSchedule: class {} },
		page_cache: {
			PrerenderedPage: class {
				// No cached page, so the live `expire` path reads and writes nothing further — enough to
				// prove the action ran without faking the page store.
				static async get({ id }) {
					pageReads.push(id);
					return null;
				}
			},
		},
		sitemaps: { Sitemap: class {}, SitemapRefresh: class {} },
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

	({ applyOptions, config, resolveConfig } = await import('../src/config.js'));
	({ defaultConfig } = await import('../src/configSchema.js'));
	({ validateOverride } = await import('../src/util/configOverride.js'));
	({ createRefreshRun } = await import('../src/util/sitemapRun.js'));
	({ departureCandidateCap, departureLimit } = await import('../src/util/sitemapDeparture.js'));
	({ processDepartures } = await import('../src/resources/Sitemap.js'));
});

const PRODUCT_ROUTE = { match: 'prefix', path: '/product/', mode: 'prerender' };

const configure = ({ departure = {}, action = 'render' } = {}) => {
	warns.length = 0;
	return applyOptions({
		sitemap: { departure: { enabled: true, dryRun: true, ...departure } },
		ingress: {
			mode: 'forwarded',
			routes: [{ ...PRODUCT_ROUTE, ...(action ? { departureAction: action } : {}) }],
		},
	});
};

const urls = (n) => Array.from({ length: n }, (_, i) => ({ url: `https://site.example.com/product/prd-${i}` }));

/** A walk that unlinked `n` product URLs, collected under the configured candidate cap. */
const walkThatUnlinked = (n) => {
	const run = createRefreshRun({ departureCap: departureCandidateCap() });
	run.addRemoved(urls(n));
	return run;
};

// ---- the defaults are not moved by this ----

test('the defaults are unchanged: 5000 actions, 50000 candidates', () => {
	const { departure } = defaultConfig().sitemap;
	assert.equal(departure.maxActions, 5000);
	assert.equal(departure.maxCandidates, 50000);
});

test('departureLimit: -1 is Infinity, 0 stays 0, a ceiling stays itself', () => {
	assert.equal(departureLimit(-1), Infinity);
	assert.equal(departureLimit(0), 0);
	assert.equal(departureLimit(5000), 5000);
});

// ---- both layers can set it ----

test('config.yaml can set -1 on both, and it is kept rather than reset to the default', () => {
	configure({ departure: { maxActions: -1, maxCandidates: -1 } });
	assert.equal(config.sitemap.departure.maxActions, -1);
	assert.equal(config.sitemap.departure.maxCandidates, -1);
	assert.deepEqual(
		warns.filter((w) => w.includes('sitemap.departure')),
		[],
		'-1 is a value, not a rejection'
	);
});

test('below -1 is still rejected, keeping the default', () => {
	configure({ departure: { maxActions: -2, maxCandidates: -5 } });
	assert.equal(config.sitemap.departure.maxActions, 5000);
	assert.equal(config.sitemap.departure.maxCandidates, 50000);
	assert.ok(warns.some((w) => w.includes('prerender.sitemap.departure.maxActions') && w.includes('>= -1')));
});

test('a config-override row accepts -1 at the door and applies it', () => {
	for (const path of ['sitemap.departure.maxActions', 'sitemap.departure.maxCandidates']) {
		assert.equal(validateOverride(path, -1).ok, true, `${path}: -1 must be writable from the console`);
		assert.equal(validateOverride(path, -2).ok, false, `${path}: below -1 must be refused`);
		assert.equal(validateOverride(path, 0).ok, true, `${path}: 0 is still a valid setting`);
	}
	const { config: resolved } = resolveConfig(
		{},
		{ 'sitemap.departure.maxActions': -1, 'sitemap.departure.maxCandidates': -1 }
	);
	assert.equal(resolved.sitemap.departure.maxActions, -1);
	assert.equal(resolved.sitemap.departure.maxCandidates, -1);
});

test('an override of -1 wins over a finite config.yaml ceiling', () => {
	const { config: resolved } = resolveConfig(
		{ sitemap: { departure: { maxActions: 100 } } },
		{ 'sitemap.departure.maxActions': -1 }
	);
	assert.equal(resolved.sitemap.departure.maxActions, -1);
});

// ---- the candidate list ----

test('maxCandidates -1 collects every departed URL and never reports capped', () => {
	configure({ departure: { maxCandidates: -1 } });
	assert.equal(departureCandidateCap(), Infinity);

	// Past the default ceiling, so an uncapped setting that quietly fell back to it would show.
	const run = walkThatUnlinked(60000);
	const { departures, removed } = run.snapshot();
	assert.equal(departures.considered, 60000);
	assert.equal(departures.considered, removed, 'none dropped: every unlinked URL is a candidate');
	assert.equal(departures.capped, false);
});

test('the default candidate ceiling still caps, and says so', () => {
	configure();
	const run = walkThatUnlinked(60000);
	assert.equal(run.snapshot().departures.considered, 50000);
	assert.equal(run.snapshot().departures.capped, true);
});

test('maxCandidates 0 still collects nothing, and is not reported as overflow', () => {
	configure({ departure: { maxCandidates: 0 } });
	assert.equal(departureCandidateCap(), 0);
	const run = walkThatUnlinked(10);
	assert.equal(run.snapshot().departures.considered, 0);
	assert.equal(run.snapshot().departures.capped, false);
});

// -1 must not become a way to switch collection ON: 0 is how a walk with nothing opted in stays
// allocation-free, whatever the ceiling says.
test('uncapped collects nothing when no route opts in or the check is off', () => {
	configure({ departure: { maxCandidates: -1 }, action: null });
	assert.equal(departureCandidateCap(), 0, 'no route opts in');
	configure({ departure: { maxCandidates: -1, enabled: false } });
	assert.equal(departureCandidateCap(), 0, 'master switch off');
});

// ---- the action gate ----

test('maxActions -1 acts on every candidate and never counts capped (dry run)', async () => {
	configure({ departure: { maxActions: -1, maxCandidates: -1 } });
	const run = walkThatUnlinked(6000);
	await processDepartures(run);

	const { outcomes } = run.snapshot().departures;
	assert.equal(outcomes['would-render'], 6000, 'past the default 5000, every one is acted on');
	assert.equal(outcomes.capped, undefined);
});

test('maxActions -1 acts on every candidate for real, not only in a dry run', async () => {
	configure({ departure: { maxActions: -1, maxCandidates: -1, dryRun: false }, action: 'expire' });
	pageReads.length = 0;
	const run = walkThatUnlinked(5200);
	await processDepartures(run);

	const { outcomes } = run.snapshot().departures;
	assert.equal(outcomes.expire, 5200);
	assert.equal(outcomes.capped, undefined);
	assert.ok(pageReads.length >= 5200, 'every departed URL had its cached pages looked up to expire');
});

test('the default maxActions still caps at 5000 and counts the rest as capped', async () => {
	configure();
	const run = walkThatUnlinked(6000);
	await processDepartures(run);

	const { outcomes } = run.snapshot().departures;
	assert.equal(outcomes['would-render'], 5000);
	assert.equal(outcomes.capped, 1000);
});

test('maxActions 0 still acts on nothing: every candidate is decided and counted capped', async () => {
	configure({ departure: { maxActions: 0 } });
	reads.length = 0;
	const run = walkThatUnlinked(25);
	await processDepartures(run);

	const { outcomes } = run.snapshot().departures;
	assert.equal(outcomes['would-render'], undefined);
	assert.equal(outcomes.capped, 25);
	assert.equal(reads.length, 25, 'each candidate is still re-read and decided');
});
