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
// `search` returns an ITERABLE, not a promise of one — Harper's does, and `for await` over a
// promise throws.
class FakeTable {
	static async get() {}
	static async put() {}
	static async patch() {}
	static async delete() {}
	static search() {
		return [];
	}
}

beforeEach(async () => {
	globalThis.server = { hostname: 'node-a', workerIndex: 0, nodes: [], config: { http: {} } };
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {}, notify() {} };
	globalThis.databases = {
		coordination: { SharedBuffer: { primaryStore: sharedBufferStub } },
		probe_state: { ProbeState: FakeTable },
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

/** Run one pass with everything faked; `answers` maps url -> signature | Error | null,
 *  `stored` is the ProbeState the read port answers from. */
const runPass = async ({
	rows,
	answers,
	stored = {},
	dryRun = false,
	maxTriggers = 100,
	owners = {},
	...overrides
}) => {
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
		// The port returns the whole baseline now — `probedAt` is what the freshness skip reads.
		read: async (url) => (stored[url] == null ? null : { signature: stored[url], probedAt: NaN }),
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
const URL_D = 'https://example.com/product/prd-d/';
const HOUR = 60 * 60 * 1000;

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
		rows: [row(URL_A), row(URL_B), row(URL_C)],
		stored: { [URL_B]: '[1]', [URL_C]: '[1]' },
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
		rows: [row(URL_A)],
		stored: { [URL_A]: '[1]' },
		answers: { [URL_A]: '[2]' },
		dryRun: true,
	});
	assert.equal(stats.changed, 1);
	assert.equal(stats.triggered, 0);
	assert.deepEqual(triggered, []);
	// Written in dry-run on purpose — see processOne in util/changeProbe.js for why.
	assert.deepEqual(written, [{ url: URL_A, signature: '[2]' }]);
});

test('a probe failure changes NOTHING: no write, no trigger, counted, sampled', async () => {
	const { stats, written, triggered } = await runPass({
		rows: [row(URL_A), row(URL_B)],
		stored: { [URL_A]: '[1]', [URL_B]: '[1]' },
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
		rows: [row(URL_A), row(URL_B)],
		stored: { [URL_A]: '[1]', [URL_B]: '[1]' },
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
		rows: stream([row(URL_A)]),
		rules: compileProbeRules(RULES_RAW),
		ownerOf: () => 'node-a',
		hostname: 'node-a',
		probe: async () => '[2]',
		read: async () => ({ signature: '[1]', probedAt: NaN }),
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

test('cohortCollector picks the lowest hashes — a keyspace sample, not the alphabetical head', async () => {
	const { fnv1a32 } = await import('../src/util/hash.js');
	const urls = Array.from({ length: 200 }, (_, i) => `https://example.com/product/prd-${i}/x`);
	const expected = [...urls].sort((a, b) => fnv1a32(a) - fnv1a32(b) || (a < b ? -1 : 1)).slice(0, 5);

	const forward = changeProbe.cohortCollector(5);
	for (const url of urls) forward.add(url);
	assert.deepEqual(forward.list(), expected);

	// Insertion order must not matter (pruning at 4x count included), or two nodes walking
	// different key ranges first would disagree about "the" sample.
	const reversed = changeProbe.cohortCollector(5);
	for (const url of [...urls].reverse()) reversed.add(url);
	assert.deepEqual(reversed.list(), expected);
});

test('requestSweepReseed runs immediately when no sweep is running', async () => {
	const status = () => changeProbe.changeProbeStatus();
	assert.equal(status().sweep.lastRun, null);
	const { chained } = changeProbe.requestSweepReseed('reseed-now');
	assert.equal(chained, false);
	while (!status().sweep.lastRun) await new Promise((resolve) => setImmediate(resolve));
	assert.equal(status().sweep.lastRun.label, 'reseed-now');
	// A reseed is dry-run BY CONSTRUCTION — re-baseline, never trigger.
	assert.equal(status().sweep.lastRun.dryRun, true);
});

test('requestSweepReseed interrupts a running sweep and chains the reseed after it stands down', async () => {
	const { config } = await import('../src/config.js');
	const savedChunk = config.changeProbe.chunkSize;
	config.changeProbe.chunkSize = 3;
	let releaseGate;
	const gate = new Promise((resolve) => (releaseGate = resolve));
	let searchCalls = 0;
	globalThis.databases.render_service.Target = class extends FakeTable {
		static async *search({ limit }) {
			searchCalls++;
			if (searchCalls === 1) {
				// Exactly `limit` rows, so the walk comes back for a second chunk — and blocks there.
				for (let i = 0; i < limit; i++) yield row(`https://example.com/other/${i}`);
				return;
			}
			await gate;
		}
	};
	try {
		const live = changeProbe.runProbeSweepOnce({ label: 'live' });
		while (!changeProbe.isProbeSweepRunning()) await new Promise((resolve) => setImmediate(resolve));

		const { chained } = changeProbe.requestSweepReseed('reseed-after-trip');
		assert.equal(chained, true);

		releaseGate();
		await live;
		// The chained reseed is detached from the live pass's finally; wait for its record.
		const status = () => changeProbe.changeProbeStatus();
		while (status().sweep.lastRun?.label !== 'reseed-after-trip') {
			await new Promise((resolve) => setImmediate(resolve));
		}
		assert.equal(status().sweep.lastRun.dryRun, true);
	} finally {
		config.changeProbe.chunkSize = savedChunk;
		globalThis.databases.render_service.Target = FakeTable;
	}
});

test('freshness skip: a baseline younger than reprobeAfter is not re-probed', async () => {
	// The restart case: a pass that already covered these URLs died mid-walk, and the pass that
	// replaces it must not spend origin requests re-confirming what is already stored.
	const probed = [];
	const T = 1_700_000_000_000;
	const { compileProbeRules } = await import('../src/util/changeProbeSpec.js');
	const stats = await changeProbe.runProbePass({
		rows: stream([row(URL_A), row(URL_B)]),
		rules: compileProbeRules(RULES_RAW),
		ownerOf: () => 'node-a',
		hostname: 'node-a',
		probe: async (rule, url) => {
			probed.push(url);
			return '[9]';
		},
		read: async (url) => ({ signature: '[1]', probedAt: url === URL_A ? T - 60_000 : T - 20 * HOUR }),
		write: async () => {},
		trigger: async () => {},
		dryRun: false,
		maxTriggers: 10,
		concurrency: 1,
		ratePerSecond: 1000,
		pause: async () => {},
		now: () => T,
		reprobeAfter: 12 * HOUR,
	});
	assert.deepEqual(probed, [URL_B], 'only the stale baseline was re-probed');
	assert.equal(stats.fresh, 1);
	assert.equal(stats.probed, 1);
});

test('freshness skip: an unparseable or missing probedAt probes rather than skips', async () => {
	const probed = [];
	const { compileProbeRules } = await import('../src/util/changeProbeSpec.js');
	const stats = await changeProbe.runProbePass({
		rows: stream([row(URL_A), row(URL_B)]),
		rules: compileProbeRules(RULES_RAW),
		ownerOf: () => 'node-a',
		hostname: 'node-a',
		probe: async (rule, url) => {
			probed.push(url);
			return '[1]';
		},
		// A row with no timestamp, and one that never had a baseline at all.
		read: async (url) => (url === URL_A ? { signature: '[1]', probedAt: NaN } : null),
		write: async () => {},
		trigger: async () => {},
		dryRun: false,
		maxTriggers: 10,
		concurrency: 1,
		ratePerSecond: 1000,
		pause: async () => {},
		reprobeAfter: 12 * HOUR,
	});
	assert.equal(probed.length, 2, 'unknown age must probe — never skip on a value we cannot read');
	assert.equal(stats.fresh, 0);
});

test('origin backoff: a pushback response stretches the pacing window, a clean batch relaxes it', async () => {
	const waits = [];
	let call = 0;
	const distress = Object.assign(new Error('HTTP 503'), { statusCode: 503, distress: true });
	const { compileProbeRules } = await import('../src/util/changeProbeSpec.js');
	const stats = await changeProbe.runProbePass({
		// Four batches of one: fail, fail, then succeed, succeed.
		rows: stream([row(URL_A), row(URL_B), row(URL_C), row(URL_D)]),
		rules: compileProbeRules(RULES_RAW),
		ownerOf: () => 'node-a',
		hostname: 'node-a',
		probe: async () => {
			if (call++ < 2) throw distress;
			return '[1]';
		},
		read: async () => null,
		write: async () => {},
		trigger: async () => {},
		dryRun: false,
		maxTriggers: 10,
		concurrency: 1,
		ratePerSecond: 1, // a 1000ms base window per single-item batch
		now: () => 0,
		pause: async (ms) => waits.push(ms),
		backoffMax: 64,
	});
	// Doubling on each distressed batch, halving back on each clean one.
	assert.deepEqual(waits, [2000, 4000, 2000, 1000]);
	assert.equal(stats.throttled, 2);
	assert.equal(stats.throttleLevel, 1, 'recovered to the configured rate by the end');
});

test('origin backoff: an explicit Retry-After outranks the computed window', async () => {
	const waits = [];
	const { compileProbeRules } = await import('../src/util/changeProbeSpec.js');
	await changeProbe.runProbePass({
		rows: stream([row(URL_A)]),
		rules: compileProbeRules(RULES_RAW),
		ownerOf: () => 'node-a',
		hostname: 'node-a',
		probe: async () => {
			throw Object.assign(new Error('HTTP 429'), { statusCode: 429, distress: true, retryAfterMs: 90_000 });
		},
		read: async () => null,
		write: async () => {},
		trigger: async () => {},
		dryRun: false,
		maxTriggers: 10,
		concurrency: 1,
		ratePerSecond: 1000,
		now: () => 0,
		pause: async (ms) => waits.push(ms),
		backoffMax: 64,
	});
	assert.deepEqual(waits, [90_000], 'the origin named a number; we do not guess under it');
});

test('origin backoff: a fully refusing origin ends the pass instead of crawling', async () => {
	const rows = [];
	for (let i = 0; i < 400; i++) rows.push(row(`https://example.com/product/prd-${i}/`));
	const { compileProbeRules } = await import('../src/util/changeProbeSpec.js');
	const stats = await changeProbe.runProbePass({
		rows: stream(rows),
		rules: compileProbeRules(RULES_RAW),
		ownerOf: () => 'node-a',
		hostname: 'node-a',
		probe: async () => {
			throw Object.assign(new Error('HTTP 503'), { statusCode: 503, distress: true });
		},
		read: async () => null,
		write: async () => {},
		trigger: async () => {},
		dryRun: false,
		maxTriggers: 10,
		concurrency: 1,
		ratePerSecond: 1000,
		pause: async () => {},
		backoffMax: 64,
		abortAfterDistress: 50,
	});
	assert.equal(stats.abortedOnDistress, true);
	assert.equal(stats.aborted, true);
	assert.ok(stats.probed < 400, `stopped early, probed ${stats.probed} of 400`);
});

test('origin backoff: a rule/product failure is NOT distress and must not throttle the sweep', async () => {
	const waits = [];
	const { compileProbeRules } = await import('../src/util/changeProbeSpec.js');
	const stats = await changeProbe.runProbePass({
		rows: stream([row(URL_A), row(URL_B)]),
		rules: compileProbeRules(RULES_RAW),
		ownerOf: () => 'node-a',
		hostname: 'node-a',
		// A 404 is a dead product and a 500 floor is a known per-product condition on this corpus —
		// neither is the origin asking us to slow down, and treating them as such would throttle a
		// healthy sweep down to nothing over a stable ~1.7% failure floor.
		probe: async () => {
			throw Object.assign(new Error('HTTP 404'), { statusCode: 404, distress: false });
		},
		read: async () => null,
		write: async () => {},
		trigger: async () => {},
		dryRun: false,
		maxTriggers: 10,
		concurrency: 1,
		ratePerSecond: 1,
		now: () => 0,
		pause: async (ms) => waits.push(ms),
		backoffMax: 64,
		abortAfterDistress: 50,
	});
	assert.equal(stats.throttled, 0);
	assert.equal(stats.failed, 2);
	assert.deepEqual(waits, [1000, 1000], 'window never stretched');
	assert.equal(stats.abortedOnDistress, false);
});
