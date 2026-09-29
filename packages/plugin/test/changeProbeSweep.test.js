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
		invalidation: { Invalidation: memoryTable(new Map()) },
		verification: { PageVerification: memoryTable(new Map()) },
	};
	changeProbe = await import('../src/util/changeProbe.js');
	({ applyOptions } = await import('../src/config.js'));
	({ cacheKeysOf } = await import('../src/resources/Target.js'));
	changeProbe.resetChangeProbeState();
});

afterEach(async () => {
	applyOptions({ changeProbe: { enabled: false } });
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
	for (let i = 0; i < 6; i++) seedTarget(String(i));
	// The fifth URL's ProbeState read fails hard: the pass throws out of its walk.
	probeFaults.get = async (id) => {
		if (id === pdp('4')) throw new Error('storage fault');
	};
	await assert.rejects(changeProbe.runProbeSweepOnce({ startedBy: 'manual' }), /storage fault/);
	assert.ok(series('probed').length >= 2, 'more than one emit: per batch, not once per pass');
	// Two full batches landed before the fault (and the error path reports the tail it reached).
	assert.ok(total('probed') >= 4, 'what the pass probed before it threw is reported, not lost with the pass');
	assert.equal(total('seeded'), 4);
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
