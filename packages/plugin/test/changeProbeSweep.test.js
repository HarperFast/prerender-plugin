import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

/**
 * The change probe END TO END on this process: the real sweep (`runProbeSweepOnce`), the real walk,
 * the real HTTP probe against a loopback origin, the real action pipeline and the real ProbeState
 * reads and writes — against in-memory tables. `changeProbe.test.js` pins the pass's decision logic
 * with every port injected; this file pins what those ports are WIRED to, which is where the review of
 * 2026-09-29 found its holes (a skip keyed on the wrong timestamp, metrics emitted after a walk that
 * could throw, an action failure the cursor walked past).
 */

let changeProbe;
let applyOptions;
let cacheKeysOf;

// ---- the loopback origin ----------------------------------------------------------------------

let origin;
let port;
const asked = [];
// id -> { status, body, headers }; absent ids answer the default price.
let answers = new Map();
before(async () => {
	origin = createServer((req, res) => {
		const id = req.url.replace('/price/', '');
		asked.push(id);
		const answer = answers.get(id) ?? { status: 200, body: { price: 10 } };
		res.writeHead(answer.status, { 'content-type': 'application/json', ...(answer.headers ?? {}) });
		res.end(JSON.stringify(answer.body ?? {}));
	});
	await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
	port = origin.address().port;
});
after(async () => {
	await new Promise((resolve) => origin.close(resolve));
});

// ---- the tables ---------------------------------------------------------------------------------

const sabs = new Map();
const sharedBufferStub = {
	getUserSharedBuffer: (key, buffer) => {
		if (!sabs.has(key)) sabs.set(key, buffer);
		return sabs.get(key);
	},
	tryLock: () => true,
	unlock() {},
};
let sharedRows = new Map();
class SharedBufferFake {
	static primaryStore = sharedBufferStub;
	static async get(key) {
		return sharedRows.get(key) ?? undefined;
	}
	static async put(key, value) {
		sharedRows.set(key, value);
	}
}

const project = (row, select) =>
	row && Array.isArray(select) ? Object.fromEntries(select.filter((k) => k in row).map((k) => [k, row[k]])) : row;

/** A keyed in-memory table with the get/put/patch/delete shape the probe uses; `faults` can fail an op. */
const memoryTable = (rows, faults = {}) =>
	class MemoryTable {
		static async get(query) {
			const id = typeof query === 'object' && query !== null ? query.id : query;
			await faults.get?.(id);
			const row = rows.get(id);
			return row ? project({ ...row }, query?.select) : undefined;
		}
		static async put(id, value) {
			await faults.put?.(id, value);
			rows.set(id, { ...value });
		}
		static async patch(id, fields) {
			await faults.patch?.(id, fields);
			const row = rows.get(id);
			if (row) rows.set(id, { ...row, ...fields });
		}
		static async delete(id) {
			rows.delete(id);
		}
		static search() {
			return [];
		}
	};

// The registry, searched the way util/urlWalk.js asks (one-sided url ranges, sorted).
let registry = new Map();
const matches = (row, { attribute, comparator, value }) =>
	comparator === 'greater_than_equal'
		? row[attribute] >= value
		: comparator === 'greater_than'
			? row[attribute] > value
			: row[attribute] === value;
let holdRow = async () => {};
class RegistryTable {
	static async get({ id }) {
		const row = registry.get(id);
		return row ? { ...row } : undefined;
	}
	static async put() {}
	static async patch() {}
	static async delete() {}
	static async *search({ conditions = [], limit = Infinity }) {
		const rows = [...registry.values()]
			.filter((row) => conditions.every((c) => matches(row, c)))
			.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
		let yielded = 0;
		for (const row of rows) {
			if (yielded++ >= limit) return;
			await holdRow(row.url);
			yield { ...row };
		}
	}
}

let probeRows;
let pages;
let schedules;
let invalidations;
let verifications;
let recorded;
let probeFaults;
let pageFaults;
const errors = [];
const warns = [];

beforeEach(async () => {
	globalThis.server = {
		hostname: 'node-a',
		workerIndex: 0,
		nodes: [],
		config: { http: {} },
		recordAnalytics: (value, metric, path, method, type) => recorded.push({ value, metric, path, method, type }),
	};
	errors.length = 0;
	warns.length = 0;
	globalThis.logger = {
		debug() {},
		info() {},
		notify() {},
		warn: (m) => warns.push(String(m)),
		error: (e, m) => errors.push(String(m ?? e?.message ?? e)),
	};
	sharedRows = new Map();
	registry = new Map();
	probeRows = new Map();
	pages = new Map();
	schedules = new Map();
	invalidations = new Map();
	verifications = new Map();
	recorded = [];
	probeFaults = {};
	pageFaults = {};
	holdRow = async () => {};
	asked.length = 0;
	answers = new Map();
	globalThis.databases = {
		coordination: { SharedBuffer: SharedBufferFake },
		probe_state: { ProbeState: memoryTable(probeRows, probeFaults), RenderExpectation: memoryTable(new Map()) },
		render_service: { Target: RegistryTable },
		page_cache: { PrerenderedPage: memoryTable(pages, pageFaults) },
		render_schedule: { RenderSchedule: memoryTable(schedules) },
		invalidation: { Invalidation: memoryTable(invalidations) },
		verification: { PageVerification: memoryTable(verifications) },
	};
	changeProbe = await import('../src/util/changeProbe.js');
	({ applyOptions } = await import('../src/config.js'));
	({ cacheKeysOf } = await import('../src/resources/Target.js'));
	changeProbe.resetChangeProbeState();
});

afterEach(async () => {
	applyOptions({ changeProbe: { enabled: false } });
	(await import('../src/util/invalidation.js')).resetInvalidationState();
	changeProbe.resetChangeProbeState();
	for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
	await changeProbe.probeStatePublishedForTest();
});

const HOUR = 60 * 60 * 1000;

const rules = () => [
	{
		label: 'pdp',
		pathPattern: '^/product/prd-([^/]+)',
		source: 'request',
		request: { urlTemplate: `http://127.0.0.1:${port}/price/$1` },
		extract: ['price'],
	},
];

const configure = (options = {}) =>
	applyOptions({
		changeProbe: {
			enabled: true,
			dryRun: false,
			rules: rules(),
			ratePerSecond: 10_000,
			concurrency: 2,
			canary: { count: 10, interval: 0 },
			...options,
		},
	});

const pdp = (id) => `https://site.example.com/product/prd-${id}`;
const seedTarget = (id, extra = {}) =>
	registry.set(pdp(id), {
		url: pdp(id),
		sitemapUrl: 'https://site.example.com/sitemap.xml',
		renderInterval: null,
		demandInterval: null,
		state: null,
		unlistedAt: null,
		...extra,
	});
const seedBaseline = (id, signature, probedAt) =>
	probeRows.set(pdp(id), {
		url: pdp(id),
		signature,
		probedAt: new Date(probedAt),
		pageSignature: null,
		pageClaimAt: null,
		pageFacts: null,
		ruleFingerprint: null,
	});
const seedPage = (id, extra = {}) => {
	for (const key of cacheKeysOf(pdp(id))) {
		pages.set(key, { cacheKey: key, expiresAt: Date.now() + 24 * HOUR, lastCached: Date.now() - HOUR, ...extra });
	}
};
const pageOf = (id) => pages.get(cacheKeysOf(pdp(id))[0]);
const series = (name) => recorded.filter((r) => r.metric === 'prerender_ops' && r.path === `probe_${name}`);
const total = (name) => series(name).reduce((sum, r) => sum + r.value, 0);

test('F3 wired: a URL changed 9h ago by a daytime pass is probed and acted on by the next pass, whatever reprobeAfter says', async () => {
	// The reviewer's case C through the real sweep. `reprobeAfter: 12h` is configured exactly as the live
	// deployment has it; the baseline was written 9h ago by an off-schedule pass that caught a change.
	configure({ reprobeAfter: 12 * HOUR });
	seedTarget('1');
	seedBaseline('1', '[10]', Date.now() - 9 * HOUR);
	seedPage('1');
	answers.set('1', { status: 200, body: { price: 8 } }); // the midnight reprice
	const result = await changeProbe.runProbeSweepOnce({ startedBy: 'anchor' });
	assert.deepEqual(asked, ['1'], 'the URL was probed, not skipped as fresh');
	assert.equal(result.fresh, 0);
	assert.equal(result.changed, 1);
	assert.equal(result.triggered, 1);
	assert.equal(probeRows.get(pdp('1')).signature, '[8]', 'the new baseline is written after the action');
	const schedule = schedules.get(pdp('1'));
	assert.ok(schedule?.changedAt > 0, 'the render is filed with a change mark');
});

test('A4: probe counters are emitted per batch, and a pass that THROWS has still reported what it probed', async () => {
	configure({ chunkSize: 10 });
	for (let i = 0; i < 14; i++) seedTarget(String(i).padStart(2, '0'));
	// The registry read fails on the second chunk: the walk itself throws, which ends the pass.
	let chunks = 0;
	const search = RegistryTable.search;
	RegistryTable.search = function (query) {
		if (++chunks === 2) throw new Error('registry read fault');
		return search.call(this, query);
	};
	try {
		await assert.rejects(changeProbe.runProbeSweepOnce({ startedBy: 'manual' }), /registry read fault/);
	} finally {
		RegistryTable.search = search;
	}
	assert.ok(series('probed').length >= 2, 'more than one emit: per batch, not once per pass');
	assert.equal(total('probed'), 10, 'what the pass probed before it threw is reported, not lost with the pass');
	assert.equal(total('seeded'), 10);
});

test('item 5: a ProbeState fault on one row is counted and SKIPS that row — the pass goes on', async () => {
	// Harper answers 503 "outstanding write transactions" under a write wave; one such throw used to end the
	// whole pass, and nothing resumed it.
	configure({ chunkSize: 10 });
	for (let i = 0; i < 6; i++) seedTarget(String(i));
	probeFaults.get = async (id) => {
		if (id === pdp('4')) throw new Error('503 outstanding write transactions');
	};
	probeFaults.put = async (id) => {
		if (id === pdp('2')) throw new Error('503 outstanding write transactions');
	};
	const result = await changeProbe.runProbeSweepOnce({ startedBy: 'manual' });
	assert.equal(result.error, null);
	assert.equal(result.examined, 6, 'the walk finished');
	assert.equal(result.rowErrors, 2, 'the failed read and the failed seed write');
	assert.equal(result.probed, 5, 'the row whose read failed was not probed');
	assert.equal(total('errors'), 2, 'counted in probe_errors');
	assert.ok(probeRows.has(pdp('5')), 'rows after the fault were seeded');
	assert.ok(
		warns.some((m) => m.includes('2 rows skipped')),
		'and the pass says so'
	);
});

test('A4: an action that fails is retried once after the walk — the page is expired by the end of the pass', async () => {
	configure();
	seedTarget('1');
	seedBaseline('1', '[10]', Date.now() - 30 * HOUR);
	seedPage('1');
	answers.set('1', { status: 200, body: { price: 8 } });
	let refusals = 0;
	pageFaults.patch = async () => {
		if (refusals++ === 0) throw new Error('write refused');
	};
	const result = await changeProbe.runProbeSweepOnce({ startedBy: 'manual' });
	assert.equal(result.errors, 1, 'the first attempt threw');
	assert.equal(result.retried, 1);
	assert.equal(result.recovered, 1);
	assert.equal(result.unacted, 0);
	assert.equal(result.triggered, 1);
	assert.ok(pageOf('1').expiresAt < Date.now(), 'the known-wrong page no longer serves');
	assert.equal(probeRows.get(pdp('1')).signature, '[8]');
	assert.equal(total('errors'), 1, 'probe_errors is emitted');
	assert.ok(
		errors.some((m) => m.includes('retried once')),
		'the failure log says a retry follows'
	);
});

// ---- the anchored pass is never silently lost (F7a) ---------------------------------------------

const flushTurns = async (n = 30) => {
	for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
	await changeProbe.probeStatePublishedForTest();
};
const unmatched = (n) => {
	for (let i = 0; i < n; i++) {
		const url = `https://site.example.com/help/${String(i).padStart(5, '0')}`;
		registry.set(url, { url, sitemapUrl: null, renderInterval: null, demandInterval: null, state: null });
	}
};
const anchorOutcomes = () => series('anchor').map((r) => r.method);
const sweepRow = async () => (await changeProbe.readProbeStateForTest())?.sweep;
const armAnchored = async (t, now, extra = {}) => {
	t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: Date.parse(now) });
	configure({
		mode: 'anchored',
		anchorTime: '03:00',
		anchorTimezone: 'UTC',
		chunkSize: 250,
		// The boot resume/catch-up check fires on the first tick unless a test says otherwise.
		startDelay: 0,
		startJitter: 1,
		...extra,
	});
	changeProbe.startChangeProbeScheduler();
	await flushTurns();
};
// A walk that blocks at row 250 until released: the way a test holds a pass mid-flight.
const gateAt = (index) => {
	let release;
	let reached = false;
	const gate = new Promise((resolve) => (release = resolve));
	let seen = 0;
	holdRow = async () => {
		if (seen++ === index) {
			reached = true;
			await gate;
		}
	};
	return { release, reached: () => reached };
};

test('F7a: an anchor that fires during a RESEED interrupts it and runs the anchored pass (reviewer case B)', async (t) => {
	await armAnchored(t, '2026-09-24T02:59:00Z', { startDelay: 24 * HOUR });
	unmatched(300);
	const gate = gateAt(250);
	const reseed = changeProbe.runProbeSweepOnce({ reseed: true, startedBy: 'reseed', label: 'reseed after a trip' });
	for (let i = 0; i < 100 && !gate.reached(); i++) await flushTurns(1);
	assert.equal((await sweepRow()).reseed, true, 'the reseed holds the sweep');

	t.mock.timers.tick(60_000); // 03:00 — the anchor fires, finds the reseed, asks it to stand down
	await flushTurns();
	t.mock.timers.tick(10_000); // the reseed's heartbeat tick reads the request
	await flushTurns();
	holdRow = async () => {};
	gate.release();
	const stoodDown = await reseed;
	assert.equal(stoodDown.aborted, true, 'the reseed stood down');
	assert.equal(stoodDown.interruptedBy, 'anchor');

	t.mock.timers.tick(15_000); // the anchor's retry finds the sweep free
	await flushTurns();
	const row = await sweepRow();
	assert.equal(row.lastRun.startedBy, 'anchor', 'the anchored pass ran — the night is not lost');
	assert.equal(row.lastRun.anchorAt, Date.parse('2026-09-24T03:00:00Z'), 'as the pass for that anchor');
	assert.equal(row.lastRun.examined, 300, 'a whole pass');
	assert.deepEqual(anchorOutcomes(), ['interrupted']);
	t.mock.timers.reset();
});

test('F7a: an anchor that fires during a pass that ACTS waits for it, then runs — chained, never skipped', async (t) => {
	await armAnchored(t, '2026-09-24T02:59:00Z', { startDelay: 24 * HOUR });
	unmatched(300);
	const gate = gateAt(250);
	const manual = changeProbe.runProbeSweepOnce({ startedBy: 'manual', dryRun: false });
	for (let i = 0; i < 100 && !gate.reached(); i++) await flushTurns(1);

	t.mock.timers.tick(60_000); // the anchor fires
	await flushTurns();
	t.mock.timers.tick(30_000); // heartbeats and retries while the manual pass is still running
	await flushTurns();
	assert.equal((await sweepRow()).startedBy, 'manual', 'the acting pass is not interrupted');
	holdRow = async () => {};
	gate.release();
	const finished = await manual;
	assert.equal(finished.aborted, undefined, 'it ran to completion');
	assert.equal(finished.examined, 300);

	t.mock.timers.tick(15_000);
	await flushTurns();
	const row = await sweepRow();
	assert.equal(row.lastRun.startedBy, 'anchor');
	assert.deepEqual(anchorOutcomes(), ['chained']);
	t.mock.timers.reset();
});

test('F7a: a restart that SPANNED the anchor catches the pass up at boot, as that anchor’s pass', async (t) => {
	// Yesterday's anchored pass is the last thing the node ran; the process was down at today's 03:00.
	sharedRows.set('change_probe', {
		sweep: {
			running: false,
			startedAt: Date.parse('2026-09-23T03:00:00Z'),
			dryRun: false,
			startedBy: 'anchor',
			lastRun: { startedBy: 'anchor', startedAt: Date.parse('2026-09-23T03:00:00Z'), dryRun: false },
		},
	});
	unmatched(10);
	await armAnchored(t, '2026-09-24T03:30:00Z');
	t.mock.timers.tick(1); // the boot check
	await flushTurns();
	const row = await sweepRow();
	assert.equal(row.lastRun.startedBy, 'anchor', 'the missed night ran at boot');
	assert.equal(row.lastRun.anchorAt, Date.parse('2026-09-24T03:00:00Z'));
	assert.deepEqual(anchorOutcomes(), ['caught_up']);
	t.mock.timers.reset();
});

test('F7a: no catch-up when the anchored pass already started since the anchor — a restart costs nothing', async (t) => {
	sharedRows.set('change_probe', {
		sweep: {
			running: false,
			startedAt: Date.parse('2026-09-24T03:00:00Z'),
			dryRun: false,
			lastRun: { startedBy: 'anchor', startedAt: Date.parse('2026-09-24T03:00:00Z'), dryRun: false },
		},
	});
	unmatched(10);
	await armAnchored(t, '2026-09-24T09:30:00Z');
	t.mock.timers.tick(1);
	await flushTurns();
	const row = await sweepRow();
	assert.equal(row.lastRun.startedAt, Date.parse('2026-09-24T03:00:00Z'), 'nothing ran');
	assert.deepEqual(anchorOutcomes(), []);
	t.mock.timers.reset();
});

test('F7a: a dead claim from BEFORE the last anchor is not resumed — a whole catch-up pass runs instead', async (t) => {
	// Yesterday's pass (04:00, 23.5h ago — inside the old one-day resume window) died mid-walk. Finishing
	// its tail would leave its head unprobed since before today's 03:00 anchor.
	sharedRows.set('change_probe', {
		sweep: {
			running: true,
			startedAt: Date.parse('2026-09-23T04:00:00Z'),
			heartbeatAt: Date.parse('2026-09-23T09:00:00Z'),
			dryRun: false,
			startedBy: 'anchor',
			progress: { cursor: 'https://site.example.com/help/00005' },
		},
	});
	unmatched(10);
	await armAnchored(t, '2026-09-24T03:30:00Z');
	const decision = await changeProbe.__checkResumeForTest();
	assert.equal(decision.resumed, false);
	assert.equal(decision.reason, 'predates the last anchor');
	assert.equal(decision.caughtUp, true);
	await flushTurns();
	const row = await sweepRow();
	assert.equal(row.lastRun.examined, 10, 'the whole slice, not the tail after the cursor');
	assert.equal(row.lastRun.resumedFrom, null);
	t.mock.timers.reset();
});

test('F7a: the most recent anchor is DST-correct — a pass just after a fall-back anchor counts as that night’s', async (t) => {
	// America/Chicago falls back at 2026-11-01T07:00Z. The 00:05 anchor that day was 05:05Z (CDT); the
	// next is 06:05Z on Nov 2 (CST). `next - 24h` would say 06:05Z on Nov 1 — an hour late — and read the
	// 05:10Z pass as predating it.
	sharedRows.set('change_probe', {
		sweep: {
			running: false,
			startedAt: Date.parse('2026-11-01T05:10:00Z'),
			dryRun: false,
			lastRun: { startedBy: 'anchor', startedAt: Date.parse('2026-11-01T05:10:00Z'), dryRun: false },
		},
	});
	const hostTz = process.env.TZ;
	process.env.TZ = 'UTC';
	try {
		await armAnchored(t, '2026-11-01T12:00:00Z', { anchorTime: '00:05', anchorTimezone: 'America/Chicago' });
		const decision = await changeProbe.__checkResumeForTest();
		assert.equal(decision.caughtUp, undefined, 'no catch-up: that night’s pass ran');
	} finally {
		if (hostTz === undefined) delete process.env.TZ;
		else process.env.TZ = hostTz;
		t.mock.timers.reset();
	}
});

// ---- the reseed after a canary trip acts where the invalidation does not cover (F7b) -------------

test('F7b: the reseed ACTS on a page re-rendered after the trip that then changed — and leaves a pre-trip page to the invalidation', async (t) => {
	t.after(() => applyOptions({ invalidation: { verification: { enabled: false } } }));
	applyOptions({
		changeProbe: {
			enabled: true,
			dryRun: false,
			rules: rules(),
			ratePerSecond: 10_000,
			concurrency: 2,
			canary: { count: 10, interval: 0 },
		},
		invalidation: { verification: { enabled: true } },
	});
	const trip = Date.now() - 2 * HOUR;
	invalidations.set('all', { scope: 'all', invalidatedAt: new Date(trip), mode: 'hard' });
	for (const id of ['pre', 'post', 'verified']) {
		seedTarget(id);
		seedBaseline(id, '[10]', trip - 24 * HOUR);
		answers.set(id, { status: 200, body: { price: 8 } });
	}
	seedPage('pre', { lastCached: trip - HOUR }); // the invalidation refuses it
	seedPage('post', { lastCached: trip + HOUR }); // re-rendered after the trip: the invalidation lets it through
	seedPage('verified', { lastCached: trip - HOUR }); // pre-trip, but a verification exempts it
	verifications.set(pdp('verified'), {
		url: pdp('verified'),
		verifiedAt: new Date(trip + 30 * 60_000),
		basisAt: new Date(trip - HOUR),
	});

	const { chained } = changeProbe.requestSweepReseed('reseed after invalidating all');
	assert.equal(chained, false);
	let lastRun;
	for (let i = 0; i < 200 && !lastRun; i++) {
		await new Promise((resolve) => setImmediate(resolve));
		lastRun = (await changeProbe.readProbeStateForTest())?.sweep?.lastRun;
	}
	assert.equal(lastRun.dryRun, false, 'the reseed is armed');
	assert.equal(lastRun.changed, 3);
	assert.equal(lastRun.triggered, 2, 'post and verified: pages a bot can still be served');
	assert.equal(lastRun.covered, 1, 'pre: every page already refused by the invalidation');
	assert.ok(pageOf('post').expiresAt < Date.now(), 'the post-trip page that changed no longer serves');
	assert.ok(schedules.get(pdp('post'))?.changedAt > 0, 'and its render is filed ahead of rotation');
	assert.ok(pageOf('verified').expiresAt < Date.now(), 'a verification-exempt page is not covered');
	assert.ok(
		pageOf('pre').expiresAt > Date.now(),
		'the pre-trip page is NOT expired — clearing a false trip restores it'
	);
	assert.equal(schedules.get(pdp('pre')), undefined);
	// The baseline stays where it was (round 2): a FALSE trip then leaves no glitch value behind for the
	// next pass to "detect" back, and a true trip's page is acted on if the invalidation is cleared first.
	assert.equal(probeRows.get(pdp('pre')).signature, '[10]', 'and its baseline does not move');
	assert.equal(lastRun.covered, 1);
});

// ---- detection lag (G1) ---------------------------------------------------------------------------

test('G1: every detected change emits two lag bounds, per rule — since the anchor, and since the previous pass', async () => {
	configure({});
	const previousStart = Date.now() - 24 * HOUR;
	sharedRows.set('change_probe', {
		sweep: { running: false, lastRun: { startedBy: 'anchor', startedAt: previousStart, dryRun: false } },
	});
	seedTarget('changed');
	seedBaseline('changed', '[10]', previousStart - HOUR);
	answers.set('changed', { status: 200, body: { price: 8 } });
	seedTarget('quiet');
	seedBaseline('quiet', '[10]', previousStart - HOUR);
	answers.set('quiet', { status: 200, body: { price: 10 } });
	const anchorAt = Date.now() - 2 * HOUR; // an anchored pass that started (chained) after its anchor
	const before = Date.now();
	await changeProbe.runProbeSweepOnce({ startedBy: 'anchor', anchorAt });
	const after = Date.now();
	const lags = series('detection_lag');
	assert.equal(lags.length, 2, 'one change, two bounds; the unchanged URL emits nothing');
	const pass = lags.find((r) => r.method === 'pass');
	const previous = lags.find((r) => r.method === 'previous_pass');
	assert.equal(pass.type, 'pdp', 'labelled by rule');
	assert.ok(pass.value >= before - anchorAt && pass.value <= after - anchorAt, 'measured from the ANCHOR');
	assert.ok(previous.value >= before - previousStart && previous.value <= after - previousStart);
});

// ---- round 2: what an active invalidation leaves the probe to do ----------------------------------

const PAIR_RULES = () => [
	{
		label: 'pdp',
		pathPattern: '^/product/prd-([^/]+)',
		source: 'request',
		request: { urlTemplate: `http://127.0.0.1:${port}/price/$1` },
		// slots 0/1 are what the claim pair reads; slot 2 is an UNMAPPED slot that moves with the price (a
		// regular price, a percent-off) — so `caughtUp` can never absorb the change.
		extract: ['price', 'available', 'regular'],
		pageCheck: { enabled: true, priceFrom: 0, availableFrom: 1 },
	},
];
const configurePair = () =>
	applyOptions({
		changeProbe: {
			enabled: true,
			dryRun: false,
			rules: PAIR_RULES(),
			ratePerSecond: 10_000,
			concurrency: 2,
			canary: { count: 10, interval: 0 },
		},
	});
const waitForLastRun = async (label) => {
	for (let i = 0; i < 400; i++) {
		const lastRun = (await changeProbe.readProbeStateForTest())?.sweep?.lastRun;
		if (lastRun && (!label || lastRun.label === label)) return lastRun;
		await new Promise((resolve) => setImmediate(resolve));
	}
	throw new Error('no pass finished');
};

test('round 2 item 1: the reseed does NOT expire a page healed after the trip whose claim agrees (reviewer RV3)', async () => {
	const spec = await import('../src/util/changeProbeSpec.js');
	configurePair();
	const trip = Date.now() - 2 * HOUR;
	invalidations.set('all', { scope: 'all', invalidatedAt: new Date(trip), mode: 'hard' });
	seedTarget('healed');
	answers.set('healed', { status: 200, body: { price: 8, available: true, regular: 12 } }); // the post-trip origin
	probeRows.set(pdp('healed'), {
		url: pdp('healed'),
		signature: '[10,true,15]', // the pre-trip baseline
		probedAt: new Date(trip - 24 * HOUR),
		pageSignature: spec.pageClaimFromOffers(['8', 'USD', 'InStock']), // what the healed render claims
		pageClaimAt: new Date(trip + HOUR),
		pageFacts: null,
		ruleFingerprint: null,
	});
	seedPage('healed', { lastCached: trip + HOUR, expiresAt: Date.now() + 90 * HOUR });
	changeProbe.requestSweepReseed('reseed after invalidating all');
	const lastRun = await waitForLastRun('reseed after invalidating all');
	assert.equal(lastRun.changed, 1);
	assert.equal(lastRun.triggered, 0, 'nothing acted on');
	assert.equal(lastRun.healed, 1);
	assert.ok(pageOf('healed').expiresAt > Date.now(), 'the correct, healed page keeps serving');
	assert.equal(schedules.get(pdp('healed')), undefined, 'and is not re-filed');
	assert.equal(probeRows.get(pdp('healed')).signature, '[8,true,12]', 'its baseline moves to the post-trip values');
	assert.ok(probeRows.get(pdp('healed')).pageSignature, 'and the claim stays: it still describes the page');
	assert.equal(total('caught_up'), 1, 'counted as caught up');
});

test('round 2 item 1: a post-trip page whose claim DISAGREES, or a baseline taken after the trip, is still acted on', async () => {
	const spec = await import('../src/util/changeProbeSpec.js');
	configurePair();
	const trip = Date.now() - 2 * HOUR;
	invalidations.set('all', { scope: 'all', invalidatedAt: new Date(trip), mode: 'hard' });
	const seedRow = (id, { claim, probedAt }) => {
		seedTarget(id);
		answers.set(id, { status: 200, body: { price: 8, available: true, regular: 12 } });
		probeRows.set(pdp(id), {
			url: pdp(id),
			signature: '[10,true,15]',
			probedAt: new Date(probedAt),
			pageSignature: spec.pageClaimFromOffers([claim, 'USD', 'InStock']),
			pageClaimAt: new Date(trip + HOUR),
			pageFacts: null,
			ruleFingerprint: null,
		});
		seedPage(id, { lastCached: trip + HOUR });
	};
	seedRow('stale-render', { claim: '10', probedAt: trip - 24 * HOUR }); // rendered after the trip, still old
	seedRow('later-change', { claim: '8', probedAt: trip + 30 * 60_000 }); // a change NEWER than the trip
	changeProbe.requestSweepReseed('r');
	const lastRun = await waitForLastRun('r');
	assert.equal(lastRun.triggered, 2);
	assert.ok(pageOf('stale-render').expiresAt < Date.now());
	assert.ok(pageOf('later-change').expiresAt < Date.now());
});

test('round 2 item 7: ANY pass during an active invalidation leaves a pre-trip page to it — not only the reseed', async () => {
	configure({});
	const trip = Date.now() - 2 * HOUR;
	invalidations.set('all', { scope: 'all', invalidatedAt: new Date(trip), mode: 'hard' });
	seedTarget('pre');
	seedBaseline('pre', '[10]', trip - 24 * HOUR);
	answers.set('pre', { status: 200, body: { price: 8 } });
	seedPage('pre', { lastCached: trip - HOUR });
	// The anchored pass that interrupted the reseed, say: an ordinary acting pass.
	const result = await changeProbe.runProbeSweepOnce({ startedBy: 'anchor' });
	assert.equal(result.covered, 1);
	assert.equal(result.triggered, 0);
	assert.ok(pageOf('pre').expiresAt > Date.now(), 'not expired: clearing a false trip still restores it');
});

test('round 2 item 11: the pass reads the epoch directly and never keeps "nothing invalidated" for the pass', async (t) => {
	configure({});
	t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-24T03:00:00Z') });
	try {
		const epochFor = changeProbe.__epochResolverForTest();
		assert.equal(await epochFor(pdp('1')), null);
		invalidations.set('all', { scope: 'all', invalidatedAt: new Date(Date.now()), mode: 'hard' });
		t.mock.timers.tick(6_000);
		const epoch = await epochFor(pdp('1'));
		assert.equal(epoch?.trippedAt, Date.parse('2026-09-24T03:00:00Z'), 'a trip recorded mid-pass is seen');
		invalidations.clear();
		t.mock.timers.tick(60_000);
		assert.ok(await epochFor(pdp('1')), 'an epoch once seen is kept for the pass');
	} finally {
		t.mock.timers.reset();
	}
});

test('round 2 item 9: the after-walk retry is skipped when the page re-rendered after the detection', async () => {
	configure({});
	seedTarget('1');
	seedBaseline('1', '[10]', Date.now() - 30 * HOUR);
	seedPage('1');
	answers.set('1', { status: 200, body: { price: 8 } });
	let refusals = 0;
	pageFaults.patch = async () => {
		if (refusals++ > 0) return;
		// The first attempt fails — and a render lands meanwhile, showing the change.
		for (const key of cacheKeysOf(pdp('1'))) pages.set(key, { ...pages.get(key), lastCached: Date.now() + 1000 });
		throw new Error('write refused');
	};
	const result = await changeProbe.runProbeSweepOnce({ startedBy: 'manual' });
	assert.equal(result.errors, 1);
	assert.equal(result.retryStale, 1, 'the retry saw the newer render and stood down');
	assert.equal(result.triggered, 0);
	assert.ok(pageOf('1').expiresAt > Date.now(), 'the new render is not expired on the walk’s old evidence');
	assert.equal(probeRows.get(pdp('1')).signature, '[10]', 'and the old observation is not written');
});
