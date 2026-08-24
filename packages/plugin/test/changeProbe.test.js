import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The change probe's pass logic — the decision state machine that turns probe answers into
 * signature writes and re-render triggers, with all I/O injected (the reconcileSchedules
 * pattern).
 *
 * The properties pinned here are the ones that make the probe safe to point at a live corpus:
 * it only acts on URLs this node OWNS; a probe FAILURE changes nothing (no write, no trigger —
 * the probe accelerates the baseline cadence, it never gates it); a first observation SEEDS
 * rather than triggers (the probe hadn't seen the page, the page didn't change); dry-run writes
 * signatures but triggers nothing; the trigger budget DEFERS by leaving the signature stale, so
 * the next pass re-detects; and a failed trigger write keeps the signature stale too, for the
 * same reason.
 */

let changeProbe;

// The schedule funnel acquires the render-lease buffer at module scope, so the stub has to
// exist before the import — and it has to be KEYED (see reconcile.test.js).
const sabs = new Map();
const sharedBufferStub = {
	getUserSharedBuffer: (key, buffer) => {
		if (!sabs.has(key)) sabs.set(key, buffer);
		return sabs.get(key);
	},
	tryLock: () => true,
	unlock() {},
};

// resources/Target.js extends the raw table class at module scope, so it must be a class.
class FakeTable {
	static async get() {}
	static async put() {}
	static async patch() {}
	static async delete() {}
	static async search() {
		return [];
	}
}

beforeEach(async () => {
	globalThis.server = { hostname: 'node-a', workerIndex: 0, nodes: [], config: { http: {} } };
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {}, notify() {} };
	globalThis.databases = {
		coordination: { SharedBuffer: { primaryStore: sharedBufferStub } },
		render_service: { Target: FakeTable },
		page_cache: { PrerenderedPage: FakeTable },
		render_schedule: { RenderSchedule: FakeTable },
		invalidation: { Invalidation: FakeTable },
	};
	changeProbe = await import('../src/util/changeProbe.js');
	changeProbe.resetChangeProbeState();
});

afterEach(() => {
	changeProbe.resetChangeProbeState();
	delete globalThis.server;
	delete globalThis.logger;
	delete globalThis.databases;
});

const RULES_RAW = [
	{
		label: 'pdp',
		pathPattern: '^/product/prd-([^/]+)',
		source: 'request',
		request: { urlTemplate: 'https://api.example.com/price/$1', method: 'POST', body: '{}' },
		extract: ['price'],
	},
];

const row = (url, extra = {}) => ({ url, sitemapUrl: null, renderInterval: null, state: null, ...extra });

async function* stream(rows) {
	yield* rows;
}

/** Run one pass with everything faked; `answers` maps url -> signature | Error | null. */
const runPass = async ({ rows, answers, dryRun = false, maxTriggers = 100, owners = {}, ...overrides }) => {
	const { compileProbeRules } = await import('../src/util/changeProbeSpec.js');
	const written = [];
	const triggered = [];
	const stats = await changeProbe.runProbePass({
		rows: stream(rows),
		rules: compileProbeRules(RULES_RAW),
		ownerOf: (url) => owners[url] ?? 'node-a',
		hostname: 'node-a',
		probe: async (rule, url) => {
			const answer = answers[url];
			if (answer instanceof Error) throw answer;
			return answer ?? null;
		},
		write: async (url, signature) => written.push({ url, signature }),
		trigger: async (target) => triggered.push(target.url),
		dryRun,
		maxTriggers,
		concurrency: 2,
		ratePerSecond: 1000,
		pause: async () => {},
		...overrides,
	});
	return { stats, written, triggered };
};

const URL_A = 'https://example.com/product/prd-a/';
const URL_B = 'https://example.com/product/prd-b/';
const URL_C = 'https://example.com/product/prd-c/';

test('only owned, unsuppressed, rule-matched rows are probed', async () => {
	const { stats, written, triggered } = await runPass({
		rows: [
			row(URL_A), // probed
			row(URL_B, { state: 'suppressed' }), // suppression owns its own recheck cadence
			row(URL_C), // owned elsewhere
			row('https://example.com/catalog/x'), // no rule matches
		],
		owners: { [URL_C]: 'node-b' },
		answers: { [URL_A]: '[1]' },
	});
	assert.equal(stats.examined, 4);
	assert.equal(stats.owned, 3);
	assert.equal(stats.matched, 1);
	assert.equal(stats.probed, 1);
	assert.equal(stats.seeded, 1);
	assert.deepEqual(written, [{ url: URL_A, signature: '[1]' }]);
	assert.deepEqual(triggered, []);
});

test('the state machine: seed, unchanged, changed', async () => {
	const { stats, written, triggered } = await runPass({
		rows: [row(URL_A), row(URL_B, { probeSignature: '[1]' }), row(URL_C, { probeSignature: '[1]' })],
		answers: { [URL_A]: '[1]', [URL_B]: '[1]', [URL_C]: '[2]' },
	});
	assert.equal(stats.seeded, 1);
	assert.equal(stats.unchanged, 1);
	assert.equal(stats.changed, 1);
	assert.equal(stats.triggered, 1);
	assert.deepEqual(triggered, [URL_C]);
	// The changed URL's signature is written only after its trigger landed.
	assert.deepEqual(written.map((w) => w.url).sort(), [URL_A, URL_C].sort());
});

test('dry run counts and re-baselines but never triggers', async () => {
	const { stats, written, triggered } = await runPass({
		rows: [row(URL_A, { probeSignature: '[1]' })],
		answers: { [URL_A]: '[2]' },
		dryRun: true,
	});
	assert.equal(stats.changed, 1);
	assert.equal(stats.triggered, 0);
	assert.deepEqual(triggered, []);
	// Written in dry-run ON PURPOSE: each pass then reports fresh changes — the true change
	// rate — instead of re-reporting the same delta forever (the demand-ladder precedent).
	assert.deepEqual(written, [{ url: URL_A, signature: '[2]' }]);
});

test('a probe failure changes NOTHING: no write, no trigger, counted, sampled', async () => {
	const { stats, written, triggered } = await runPass({
		rows: [row(URL_A, { probeSignature: '[1]' }), row(URL_B, { probeSignature: '[1]' })],
		answers: { [URL_A]: new Error('HTTP 500'), [URL_B]: null }, // fetch failure and all-null extraction
	});
	assert.equal(stats.failed, 2);
	assert.equal(stats.changed, 0);
	assert.deepEqual(written, []);
	assert.deepEqual(triggered, []);
	assert.equal(stats.failureSamples.length, 1); // only the throw is sampled; all-null has no error
	assert.equal(stats.failureSamples[0].url, URL_A);
});

test('past the trigger budget a change DEFERS: signature left stale so the next pass retries', async () => {
	const { stats, written, triggered } = await runPass({
		rows: [row(URL_A, { probeSignature: '[1]' }), row(URL_B, { probeSignature: '[1]' })],
		answers: { [URL_A]: '[2]', [URL_B]: '[2]' },
		maxTriggers: 1,
		concurrency: 1, // deterministic order: A triggers, B defers
	});
	assert.equal(stats.triggered, 1);
	assert.equal(stats.deferred, 1);
	assert.deepEqual(triggered, [URL_A]);
	assert.deepEqual(written, [{ url: URL_A, signature: '[2]' }]);
});

test('a failed trigger write keeps the signature stale too', async () => {
	const { compileProbeRules } = await import('../src/util/changeProbeSpec.js');
	const written = [];
	const stats = await changeProbe.runProbePass({
		rows: stream([row(URL_A, { probeSignature: '[1]' })]),
		rules: compileProbeRules(RULES_RAW),
		ownerOf: () => 'node-a',
		hostname: 'node-a',
		probe: async () => '[2]',
		write: async (url, signature) => written.push({ url, signature }),
		trigger: async () => {
			throw new Error('write refused');
		},
		dryRun: false,
		maxTriggers: 10,
		concurrency: 1,
		ratePerSecond: 1000,
		pause: async () => {},
	});
	assert.equal(stats.errors, 1);
	assert.equal(stats.triggered, 0);
	assert.deepEqual(written, []);
});

test('pacing sleeps out the remainder of each batch window', async () => {
	const pauses = [];
	let clock = 0;
	await runPass({
		rows: [row(URL_A), row(URL_B)],
		answers: { [URL_A]: '[1]', [URL_B]: '[1]' },
		concurrency: 2,
		ratePerSecond: 2, // 2 probes at 2/s = a 1000ms window; the fake clock spends 0
		pause: async (ms) => pauses.push(ms),
		now: () => clock,
	});
	assert.deepEqual(pauses, [1000]);
});

test('cohort collection sees every matched row', async () => {
	const cohort = [];
	await runPass({
		rows: [row(URL_A), row('https://example.com/catalog/x')],
		answers: { [URL_A]: '[1]' },
		collectCohort: (rule, url) => cohort.push(`${rule.label}:${url}`),
	});
	assert.deepEqual(cohort, [`pdp:${URL_A}`]);
});

test('cancellation stops the walk and says so', async () => {
	let calls = 0;
	const { stats } = await runPass({
		rows: [row(URL_A), row(URL_B)],
		answers: { [URL_A]: '[1]', [URL_B]: '[1]' },
		isCanceled: () => ++calls > 1,
	});
	assert.equal(stats.aborted, true);
	assert.ok(stats.examined < 2);
});

test('canaryVerdict: no verdict below minSample, seeds and failures excluded from both sides', () => {
	const { canaryVerdict } = changeProbe;
	// 40 compared of which 39 changed — but minSample is 50, so no verdict.
	assert.deepEqual(
		canaryVerdict({ changed: 39, unchanged: 1, seeded: 100, failed: 100 }, { threshold: 0.1, minSample: 50 }),
		{
			tripped: false,
			compared: 40,
			fraction: null,
		}
	);
	const tripped = canaryVerdict({ changed: 10, unchanged: 90 }, { threshold: 0.1, minSample: 50 });
	assert.equal(tripped.tripped, true);
	assert.equal(tripped.fraction, 0.1);
	const held = canaryVerdict({ changed: 9, unchanged: 91 }, { threshold: 0.1, minSample: 50 });
	assert.equal(held.tripped, false);
});
