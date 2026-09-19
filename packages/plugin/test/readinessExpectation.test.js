import { test } from 'node:test';
import assert from 'node:assert/strict';

// What a URL produced LAST time is the only expectation that cannot rot — and the only one that can
// turn into a permanent false alarm. These tests are about the second half: the rule has to catch a
// page that quietly lost content AND get out of the way when the page really changed.
//
// The same rule exists in the browser package (`readiness.assessExpectations`) for the in-render
// path. They must agree; if you change one, change both.

const analytics = [];
let warns = [];
globalThis.server = { hostname: 'test-node', recordAnalytics: (...args) => analytics.push(args) };
globalThis.logger = { warn: (...args) => warns.push(args.map(String).join(' ')), info: () => {}, error: () => {} };

// A node-local table, as the code sees it: point read with a select, patch, put.
const rows = new Map();
const fakeTable = {
	get: async ({ id }) => (rows.has(id) ? { ...rows.get(id) } : undefined),
	patch: async (id, data) => rows.set(id, { ...rows.get(id), ...data }),
	put: async (id, data) => rows.set(id, { ...data }),
};
globalThis.databases = { probe_state: { RenderExpectation: fakeTable } };

const { assess, recordReadinessExpectation, hasObservations } = await import('../src/util/readinessExpectation.js');
const { CacheKey } = await import('../src/util/cacheKey.js');

const URL_A = 'https://example.com/';
const keyOf = (deviceType) => CacheKey.toCacheKey({ url: URL_A, deviceType });
const shortfallEmits = () => analytics.filter((a) => a[1] === 'render_readiness' && a[2] === 'shortfall');
const report = (learned) => ({ contract: 'home', satisfied: true, learned });

const history = (counts, consecutiveShortfalls = 0) => ({ counts, consecutiveShortfalls });

test('a first render has nothing to regress from, and is learned from', () => {
	const v = assess({ rails: 3, links: 350 }, null);
	assert.deepEqual(v.shortfalls, []);
	assert.equal(v.rebaselined, false);
	assert.deepEqual(v.next.counts, { rails: 3, links: 350 });
});

test('run-to-run churn is not a shortfall', () => {
	// Measured churn on these pages is ~5% on link and image counts; the tolerance is 50%, so
	// ordinary personalisation must never trip this.
	assert.deepEqual(assess({ links: 332 }, history({ links: 350 })).shortfalls, []);
});

test('losing the rails is caught even though no contract clause names them', () => {
	const v = assess({ rails: 0, links: 3 }, history({ rails: 3, links: 350 }));
	assert.deepEqual(v.shortfalls.map((s) => s.name).sort(), ['links', 'rails']);
	assert.equal(v.shortfalls.find((s) => s.name === 'rails').expected, 3);
});

test('a page that never had the thing cannot fall short of it', () => {
	assert.deepEqual(assess({ rails: 0 }, history({ rails: 0 })).shortfalls, []);
	// And an observation with no history at all is ignored rather than read as zero.
	assert.deepEqual(assess({ brandNew: 0 }, history({ rails: 3 })).shortfalls, []);
});

test('a suspected shortfall does NOT re-learn — that is how a regression would erase its evidence', () => {
	const v = assess({ rails: 0 }, history({ rails: 3 }, 0));
	assert.equal(v.shortfalls.length, 1);
	assert.deepEqual(v.next.counts, { rails: 3 }, 'the old expectation is kept');
	assert.equal(v.next.consecutive, 1);
});

test('the same shortfall, repeated, stops being a regression and becomes the page', () => {
	// THE CONVERGENCE MECHANISM. A rail removed site-wide must not fail this URL forever.
	assert.equal(assess({ rails: 0 }, history({ rails: 3 }, 0)).rebaselined, false, 'once is a lost rail');
	assert.equal(assess({ rails: 0 }, history({ rails: 3 }, 1)).rebaselined, false, 'twice is still suspicious');

	const third = assess({ rails: 0 }, history({ rails: 3 }, 2));
	assert.equal(third.rebaselined, true, 'three times in a row is the new shape of the page');
	assert.deepEqual(third.shortfalls, [], 'and it stops being reported as a shortfall');
	assert.deepEqual(third.next.counts, { rails: 0 }, 'the page as it is now becomes the expectation');
	assert.equal(third.next.consecutive, 0, 'so the next real regression starts from zero');
});

test('a recovery resets the counter rather than leaving it armed', () => {
	const v = assess({ rails: 3 }, history({ rails: 3 }, 2));
	assert.deepEqual(v.shortfalls, []);
	assert.equal(v.rebaselined, false, 'nothing fell short, so nothing is being re-learned');
	assert.equal(v.next.consecutive, 0);
});

// ─── the record path: the unit is the PAGE, not the URL ─────────────────────────────────────────

test('desktop and mobile renders of ONE URL keep separate histories — the measured 59% img gap is not a shortfall', async () => {
	rows.clear();
	analytics.length = 0;
	warns = [];
	// Measured on the live home page, same URL, one job: desktop 625 img, mobile 256.
	await recordReadinessExpectation({ url: URL_A, deviceType: 'desktop' }, report({ images: 625, rails: 2 }));
	await recordReadinessExpectation({ url: URL_A, deviceType: 'mobile' }, report({ images: 256, rails: 2 }));
	// And the next job, same shape.
	await recordReadinessExpectation({ url: URL_A, deviceType: 'desktop' }, report({ images: 625, rails: 2 }));
	await recordReadinessExpectation({ url: URL_A, deviceType: 'mobile' }, report({ images: 256, rails: 2 }));

	assert.deepEqual(shortfallEmits(), [], 'a device gap is not content loss');
	assert.deepEqual(warns, []);
	assert.deepEqual(
		[...rows.keys()].sort(),
		[keyOf('desktop'), keyOf('mobile')].sort(),
		'one row per page, keyed like the page'
	);
	assert.deepEqual(JSON.parse(rows.get(keyOf('desktop')).counts), { images: 625, rails: 2 });
	assert.deepEqual(JSON.parse(rows.get(keyOf('mobile')).counts), { images: 256, rails: 2 });
});

test('a real drop on one device is still caught, and names the device', async () => {
	rows.clear();
	analytics.length = 0;
	warns = [];
	await recordReadinessExpectation({ url: URL_A, deviceType: 'mobile' }, report({ images: 256 }));
	await recordReadinessExpectation({ url: URL_A, deviceType: 'mobile' }, report({ images: 40 }));
	assert.equal(shortfallEmits().length, 1);
	assert.deepEqual(shortfallEmits()[0].slice(1), ['render_readiness', 'shortfall', 'home', 'images']);
	assert.ok(warns.some((w) => w.includes(URL_A) && w.includes('(mobile)') && w.includes('images 40 vs 256')));
	assert.equal(rows.get(keyOf('mobile')).consecutiveShortfalls, 1);
	assert.deepEqual(JSON.parse(rows.get(keyOf('mobile')).counts), { images: 256 }, 'kept, not re-learned');
});

test('a contract with no observe clauses posts learned={} and records nothing', async () => {
	rows.clear();
	assert.equal(hasObservations({}), false);
	assert.equal(hasObservations(undefined), false);
	assert.equal(hasObservations({ rails: 0 }), true, 'a zero count is still an observation');
	await recordReadinessExpectation({ url: URL_A, deviceType: 'desktop' }, report({}));
	assert.equal(rows.size, 0);
});

test('a failing table never throws, and warns once rather than once per render', async () => {
	analytics.length = 0;
	warns = [];
	const broken = globalThis.databases.probe_state.RenderExpectation;
	globalThis.databases.probe_state.RenderExpectation = undefined; // a node whose schema did not load
	try {
		for (let i = 0; i < 50; i++) {
			await recordReadinessExpectation({ url: URL_A, deviceType: 'desktop' }, report({ images: 1 }));
		}
	} finally {
		globalThis.databases.probe_state.RenderExpectation = broken;
	}
	assert.equal(warns.length, 1, 'fifty failures, one line');
	assert.ok(warns[0].includes('could not record the readiness expectation'));
	assert.ok(warns[0].includes(keyOf('desktop')));
});
