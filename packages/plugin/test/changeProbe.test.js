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

/**
 * A node-local table fake that also carries `primaryStore`. The probe's cross-worker state row
 * lives here; a plain object with only `primaryStore` made every publish throw (swallowed) and
 * every read return null, which would have let the observability tests pass against no storage.
 */
let sharedRows = new Map();
const probeStateTable = () => {
	class SharedBufferFake {
		static primaryStore = sharedBufferStub;
		static async get(key) {
			return sharedRows.get(key) ?? undefined;
		}
		static async put(key, value) {
			sharedRows.set(key, value);
		}
	}
	return SharedBufferFake;
};

beforeEach(async () => {
	globalThis.server = { hostname: 'node-a', workerIndex: 0, nodes: [], config: { http: {} } };
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {}, notify() {} };
	globalThis.databases = {
		// SharedBuffer is BOTH the SAB provider (renderLease, via primaryStore) and a node-local
		// TABLE — the change probe publishes its cross-worker state as a row here, so the fake has
		// to answer get/put as well as hand out buffers.
		coordination: { SharedBuffer: probeStateTable() },
		probe_state: { ProbeState: FakeTable, RenderExpectation: FakeTable },
		render_service: { Target: FakeTable },
		page_cache: { PrerenderedPage: FakeTable },
		render_schedule: { RenderSchedule: FakeTable },
		invalidation: { Invalidation: FakeTable },
	};
	sharedRows = new Map();
	changeProbe = await import('../src/util/changeProbe.js');
	changeProbe.resetChangeProbeState();
});

afterEach(async () => {
	changeProbe.resetChangeProbeState();
	// A scheduler test can leave a pass it started finishing against the fakes (a continuous cycle
	// runs to completion after its loop is cancelled). Let it land, and let every state write this
	// worker queued settle, before the globals it logs through are taken away — otherwise the pass
	// throws into the NEXT test as an unhandled rejection.
	for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
	await changeProbe.probeStatePublishedForTest();
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
	// Per-URL stored rule fingerprint: absent = the current rule's (the steady state), null = a row
	// from before fingerprints existed, any other string = a baseline taken under another rule.
	fingerprints = {},
	dryRun = false,
	maxTriggers = 100,
	owners = {},
	...overrides
}) => {
	const { compileProbeRules } = await import('../src/util/changeProbeSpec.js');
	const rules = compileProbeRules(RULES_RAW);
	const written = [];
	const writeOptions = [];
	const triggered = [];
	const { createInlineTrigger } = await import('../src/util/triggerQueue.js');
	const triggers = createInlineTrigger({
		trigger: async (row) => {
			triggered.push(row.url);
		},
		write: async (url, signature, options) => {
			written.push({ url, signature });
			writeOptions.push({ url, ...options });
		},
	});
	const stats = await changeProbe.runProbePass({
		rows: stream(rows),
		rules,
		ownerOf: (url) => owners[url] ?? 'node-a',
		hostname: 'node-a',
		probe: async (rule, url) => {
			const answer = answers[url];
			if (answer instanceof Error) throw answer;
			return answer ?? null;
		},
		// The port returns the whole baseline now — `probedAt` is what the freshness skip reads.
		read: async (url) =>
			stored[url] === undefined
				? null
				: {
						signature: stored[url],
						probedAt: NaN,
						fingerprint: url in fingerprints ? fingerprints[url] : rules[0].fingerprint,
					},
		write: async (url, signature, options) => {
			written.push({ url, signature });
			writeOptions.push({ url, ...options });
		},
		// The REAL inline shape, not a stub: the trigger-then-write ordering now lives in
		// util/triggerQueue.js, and a stub re-implementing it here would keep passing while the
		// shipped path regressed. This is also exactly how the canary wires itself.
		submitTrigger: triggers.submit,
		dryRun,
		maxTriggers,
		concurrency: 2,
		ratePerSecond: 1000,
		pause: async () => {},
		...overrides,
	});
	// What the sweep and the canary both do once the pass returns.
	await triggers.drain();
	stats.triggered = triggers.stats.triggered;
	stats.errors = triggers.stats.errors;
	return { stats, written, writeOptions, triggered, rules };
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

test('a baseline taken under ANOTHER rule re-baselines: stored, not compared, not triggered', async () => {
	const { stats, written, writeOptions, triggered, rules } = await runPass({
		rows: [row(URL_A), row(URL_B)],
		stored: { [URL_A]: '[1]', [URL_B]: '[1]' },
		fingerprints: { [URL_A]: 'deadbeef' }, // B carries the current rule's fingerprint
		answers: { [URL_A]: '[2]', [URL_B]: '[2]' },
	});
	// A: a rule edit produced a differently-shaped signature — that is not a content change.
	// B: the same new value under the same rule IS a change.
	assert.equal(stats.rebaselined, 1);
	assert.equal(stats.changed, 1);
	assert.equal(stats.triggered, 1);
	assert.deepEqual(triggered, [URL_B]);
	assert.deepEqual(written.map((w) => w.url).sort(), [URL_A, URL_B].sort());
	// Every baseline write carries the rule that made it, so the NEXT edit is recognised too.
	assert.ok(writeOptions.every((w) => w.fingerprint === rules[0].fingerprint));
	assert.equal(stats.probed, stats.seeded + stats.rebaselined + stats.unchanged + stats.changed + stats.failed);
});

test('a pre-fingerprint row is compared as usual and stamped once when quiet', async () => {
	const { stats, written, writeOptions, triggered, rules } = await runPass({
		rows: [row(URL_A), row(URL_B), row(URL_C)],
		stored: { [URL_A]: '[1]', [URL_B]: '[1]', [URL_C]: '[1]' },
		fingerprints: { [URL_A]: null, [URL_B]: null }, // legacy rows; C is already stamped
		answers: { [URL_A]: '[1]', [URL_B]: '[2]', [URL_C]: '[1]' },
	});
	// A: unchanged, legacy -> one stamp write. B: changed, legacy -> compared like any row (a
	// legacy baseline was taken by the rule in force). C: unchanged and stamped -> no write at all,
	// the converged-corpus guarantee.
	assert.equal(stats.unchanged, 2);
	assert.equal(stats.changed, 1);
	assert.equal(stats.rebaselined, 0);
	assert.deepEqual(triggered, [URL_B]);
	assert.deepEqual(written.map((w) => w.url).sort(), [URL_A, URL_B].sort());
	assert.ok(writeOptions.every((w) => w.fingerprint === rules[0].fingerprint));
});

test('the canary verdict ignores re-baselined rows, like seeds', async () => {
	const verdict = changeProbe.canaryVerdict(
		{ changed: 0, unchanged: 0, rebaselined: 500, seeded: 0 },
		{ threshold: 0.1, minSample: 10 }
	);
	assert.deepEqual(verdict, { tripped: false, compared: 0, fraction: null });
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

test('a failed trigger keeps the signature stale too', async () => {
	// The property is unchanged by the move to a submitted trigger; only the seam moved. Driven
	// through the REAL inline shape rather than a stub, because the ordering under test — baseline
	// written only after the trigger succeeds — now lives in util/triggerQueue.js, and a stub that
	// re-implemented it would pass while the shipped path regressed.
	const { compileProbeRules } = await import('../src/util/changeProbeSpec.js');
	const { createInlineTrigger } = await import('../src/util/triggerQueue.js');
	const written = [];
	const triggers = createInlineTrigger({
		trigger: async () => {
			throw new Error('write refused');
		},
		write: async (url, signature) => written.push({ url, signature }),
	});
	const stats = await changeProbe.runProbePass({
		rows: stream([row(URL_A)]),
		rules: compileProbeRules(RULES_RAW),
		ownerOf: () => 'node-a',
		hostname: 'node-a',
		probe: async () => '[2]',
		read: async () => ({ signature: '[1]', probedAt: NaN }),
		write: async (url, signature) => written.push({ url, signature }),
		submitTrigger: triggers.submit,
		dryRun: false,
		maxTriggers: 10,
		concurrency: 1,
		ratePerSecond: 1000,
		pause: async () => {},
	});
	await triggers.drain();
	assert.equal(triggers.stats.errors, 1);
	assert.equal(triggers.stats.triggered, 0);
	assert.equal(stats.queued, 1, 'the change was accepted for triggering');
	assert.deepEqual(written, [], 'no baseline may be written when the trigger threw');
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
	// `changeProbeStatus` is async now: it reads the node-local shared row rather than this
	// worker's module state, which is what makes it answer the same way from all 16 workers.
	const status = () => changeProbe.changeProbeStatus();
	assert.equal((await status()).sweep.lastRun, null);
	const { chained } = changeProbe.requestSweepReseed('reseed-now');
	assert.equal(chained, false);
	while (!(await status()).sweep.lastRun) await new Promise((resolve) => setImmediate(resolve));
	assert.equal((await status()).sweep.lastRun.label, 'reseed-now');
	// A reseed is dry-run BY CONSTRUCTION — re-baseline, never trigger.
	assert.equal((await status()).sweep.lastRun.dryRun, true);
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
		while ((await status()).sweep.lastRun?.label !== 'reseed-after-trip') {
			await new Promise((resolve) => setImmediate(resolve));
		}
		assert.equal((await status()).sweep.lastRun.dryRun, true);
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
		submitTrigger: async () => 'queued',
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
		submitTrigger: async () => 'queued',
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
		submitTrigger: async () => 'queued',
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
		submitTrigger: async () => 'queued',
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
		submitTrigger: async () => 'queued',
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
		submitTrigger: async () => 'queued',
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

test('freshness skip: a BigInt probedAt is coerced, not thrown on', async () => {
	// Harper numeric columns can surface as BigInt, and `new Date()` REFUSES a BigInt rather
	// than coercing it — an unguarded read would take down the whole sweep.
	const T = 1_700_000_000_000;
	const probed = [];
	const { compileProbeRules } = await import('../src/util/changeProbeSpec.js');
	const stats = await changeProbe.runProbePass({
		rows: stream([row(URL_A)]),
		rules: compileProbeRules(RULES_RAW),
		ownerOf: () => 'node-a',
		hostname: 'node-a',
		probe: async (rule, url) => {
			probed.push(url);
			return '[1]';
		},
		read: async () => ({ signature: '[1]', probedAt: Number(BigInt(T - 60_000)) }),
		write: async () => {},
		submitTrigger: async () => 'queued',
		dryRun: false,
		maxTriggers: 10,
		concurrency: 1,
		ratePerSecond: 1000,
		pause: async () => {},
		now: () => T,
		reprobeAfter: 12 * HOUR,
	});
	assert.deepEqual(probed, [], 'the BigInt-derived timestamp was understood as fresh');
	assert.equal(stats.fresh, 1);
});

test('origin backoff: the pacing wait can never exceed setTimeout’s 32-bit cap', async () => {
	// concurrency x 1/ratePerSecond x throttle is a PRODUCT of three separately-sane options;
	// past 2^31-1 ms setTimeout fires after 1ms instead of waiting, which would turn the backoff
	// into a hot loop against an origin already asking for room.
	const waits = [];
	const { compileProbeRules } = await import('../src/util/changeProbeSpec.js');
	await changeProbe.runProbePass({
		rows: stream([row(URL_A)]),
		rules: compileProbeRules(RULES_RAW),
		ownerOf: () => 'node-a',
		hostname: 'node-a',
		probe: async () => {
			throw Object.assign(new Error('HTTP 503'), { statusCode: 503, distress: true });
		},
		read: async () => null,
		write: async () => {},
		submitTrigger: async () => 'queued',
		dryRun: false,
		maxTriggers: 10,
		concurrency: 1,
		ratePerSecond: 0.000001, // a window far past the cap once multiplied by the backoff
		now: () => 0,
		pause: async (ms) => waits.push(ms),
		backoffMax: 1_000_000,
	});
	assert.equal(waits.length, 1);
	assert.ok(waits[0] <= 2147483647, `wait was ${waits[0]}`);
});

test('a trip hard-expires the page PAST the swr window — a known-wrong page is never served again', async () => {
	// The real trigger, not the injected port: the property under test is the expiry VALUE it
	// writes. A trip means the probed fields provably changed, so the page must not ride the
	// stale-while-revalidate window the way a merely-late re-render does — the patched expiresAt
	// has to land at least swrTtl in the past, where resolveServeStatus refuses it outright.
	const { config } = await import('../src/config.js');
	const patched = [];
	globalThis.databases.page_cache.PrerenderedPage = class extends FakeTable {
		static async get({ id }) {
			return { cacheKey: id, expiresAt: Date.now() + HOUR };
		}
		static async patch(id, fields) {
			patched.push({ id, ...fields });
		}
	};
	// Capture the schedule write too: the trigger must file ONE row, keyed by the URL.
	const scheduled = [];
	globalThis.databases.render_schedule.RenderSchedule = class extends FakeTable {
		static async put(id, fields) {
			scheduled.push({ id, ...fields });
		}
	};
	const before = Date.now();
	await changeProbe.triggerRevalidate(row('https://example.com/product/prd-a/'));
	// Bound against a clock read taken AFTER the call: the trigger reads Date.now() itself, so
	// comparing against `before` alone flakes on any millisecond tick between the two reads.
	const after = Date.now();
	assert.ok(patched.length >= 1, 'at least one device cacheKey was expired');
	for (const p of patched) {
		assert.ok(
			p.expiresAt <= after - config.page.swrTtl && p.expiresAt >= before - config.page.swrTtl,
			`expiresAt ${p.expiresAt} is not backdated past swrTtl (${config.page.swrTtl}) around [${before}, ${after}]`
		);
	}
});

test('a trip files ONE schedule row, keyed by the URL — not one per device', async () => {
	// The v0.66.0 regression this pins. A device-keyed row gets `deviceTypes: [thatDevice]` from
	// `claim`, so two of them are two ONE-DEVICE jobs: each fetches the origin document for
	// itself (defeating document reuse) and they render at different times (splitting the pair's
	// lastCached). One URL row is one job that renders every default device together.
	const scheduled = [];
	globalThis.databases.render_schedule.RenderSchedule = class extends FakeTable {
		static async put(id, fields) {
			scheduled.push({ id, ...fields });
		}
	};
	globalThis.databases.page_cache.PrerenderedPage = class extends FakeTable {
		static async get() {
			return null; // no cached page: isolate the schedule write
		}
	};

	const url = 'https://example.com/product/prd-a/';
	await changeProbe.triggerRevalidate(row(url));

	assert.equal(scheduled.length, 1, `expected exactly one schedule row, got ${JSON.stringify(scheduled)}`);
	assert.equal(scheduled[0].id, url, 'the row must be keyed by the URL, with no device suffix');
	assert.ok(!String(scheduled[0].id).includes('|'), 'a "|" in the key means a per-device row');
	// `put` REPLACES the record, so both of these must be explicit or the funnel throws.
	assert.equal(typeof scheduled[0].fromSitemap, 'boolean');
	assert.ok(Number.isFinite(scheduled[0].effectiveInterval));
});

/** A rule whose extract maps index 2 -> price and index 3 -> availability, with pageCheck on. */
const PAGECHECK_RULES = [
	{
		...RULES_RAW[0],
		extract: ['regular', 'sale', 'price', 'available'],
		pageCheck: { enabled: true, priceFrom: 2, availableFrom: 3 },
	},
];

const runPageCheckPass = async ({ rows, answers, stored = {}, ...overrides }) => {
	const { compileProbeRules } = await import('../src/util/changeProbeSpec.js');
	const written = [];
	const triggered = [];
	const write = async (url, signature, opts = {}) =>
		written.push({ url, signature, rowExists: opts.rowExists === true, clearClaim: opts.clearClaim === true });
	const { createInlineTrigger } = await import('../src/util/triggerQueue.js');
	// The real inline shape — `clearClaim` is set by the trigger path itself, and these tests are
	// precisely the ones asserting on it.
	const triggers = createInlineTrigger({
		trigger: async (row) => {
			triggered.push(row.url);
		},
		write,
	});
	const stats = await changeProbe.runProbePass({
		rows: stream(rows),
		rules: compileProbeRules(PAGECHECK_RULES),
		ownerOf: () => 'node-a',
		hostname: 'node-a',
		probe: async (rule, url) => answers[url] ?? null,
		read: async (url) => stored[url] ?? null,
		write,
		submitTrigger: triggers.submit,
		dryRun: false,
		maxTriggers: 100,
		concurrency: 1,
		ratePerSecond: 1000,
		pause: async () => {},
		...overrides,
	});
	await triggers.drain();
	stats.triggered = triggers.stats.triggered;
	stats.errors = triggers.stats.errors;
	return { stats, written, triggered };
};

test('ROUND-TRIP BLINDNESS: origin matches its own baseline but the PAGE disagrees -> trigger', async () => {
	// The measured production case: probe stored "available" and the origin still says available,
	// so the signature comparison sees nothing; the page rendered mid-flip and says OutOfStock.
	// Without pageCheck this is the `unchanged` early-return and the page stays wrong for a
	// whole render interval.
	const signature = JSON.stringify([39.99, 35.99, 35.99, true]);
	const { stats, triggered, written } = await runPageCheckPass({
		rows: [row(URL_A)],
		answers: { [URL_A]: signature },
		stored: {
			[URL_A]: { signature, probedAt: NaN, pageSignature: JSON.stringify([['35.99'], false]) },
		},
	});
	assert.equal(stats.pageMismatch, 1);
	// Buckets count by SIGNATURE outcome alone (probed = seeded + unchanged + changed + failed,
	// and the canary's denominator is changed + unchanged) — the mismatch OVERLAYS `unchanged`,
	// it does not replace it. The row still escapes the early-return and triggers.
	assert.equal(stats.unchanged, 1, 'the signature was unchanged — the bucket must still say so');
	assert.equal(stats.changed, 0, 'the origin signature did not change — only the page disagreed');
	assert.deepEqual(triggered, [URL_A]);
	// The claim is cleared IN THE SAME WRITE so the next pass does not re-trigger forever.
	assert.equal(written.length, 1);
	assert.equal(written[0].clearClaim, true, 'acting on a disagreement must clear the claim');
	assert.equal(written[0].rowExists, true, 'the row exists, so the write must be a patch, not a put');
});

test('page AGREES with the origin -> unchanged, nothing triggered', async () => {
	const signature = JSON.stringify([39.99, 35.99, 35.99, true]);
	const { stats, triggered } = await runPageCheckPass({
		rows: [row(URL_A)],
		answers: { [URL_A]: signature },
		stored: { [URL_A]: { signature, probedAt: NaN, pageSignature: JSON.stringify([['35.99'], true]) } },
	});
	assert.equal(stats.pageMismatch, 0);
	assert.equal(stats.unchanged, 1);
	assert.deepEqual(triggered, []);
});

test('no stored page claim -> the check is inert (a page nothing has rendered cannot disagree)', async () => {
	const signature = JSON.stringify([39.99, 35.99, 35.99, true]);
	const { stats, triggered } = await runPageCheckPass({
		rows: [row(URL_A)],
		answers: { [URL_A]: signature },
		stored: { [URL_A]: { signature, probedAt: NaN, pageSignature: null } },
	});
	assert.equal(stats.pageMismatch, 0);
	assert.equal(stats.unchanged, 1);
	assert.deepEqual(triggered, []);
});

test('a status-signal literal carries no price/availability, so it never reads as a disagreement', async () => {
	// `observed` is an opaque literal (e.g. sold-out via statusSignals), not an extracted array —
	// projecting it is impossible, and guessing would trigger on every such page.
	const { stats, triggered } = await runPageCheckPass({
		rows: [row(URL_A)],
		answers: { [URL_A]: 'unavailable' },
		stored: {
			[URL_A]: { signature: 'unavailable', probedAt: NaN, pageSignature: JSON.stringify([['35.99'], true]) },
		},
	});
	assert.equal(stats.pageMismatch, 0);
	assert.deepEqual(triggered, []);
});

test('a page disagreement still triggers on a URL the probe has never baselined', async () => {
	// No stored signature (would normally SEED and trigger nothing), but the page provably
	// disagrees with reality right now — that is worth acting on regardless of probe history.
	const signature = JSON.stringify([39.99, 35.99, 35.99, true]);
	const { stats, triggered } = await runPageCheckPass({
		rows: [row(URL_A)],
		answers: { [URL_A]: signature },
		stored: { [URL_A]: { signature: null, probedAt: NaN, pageSignature: JSON.stringify([['35.99'], false]) } },
	});
	assert.equal(stats.pageMismatch, 1);
	assert.equal(stats.seeded, 1, 'the first observation still counts as a seed — the mismatch overlays it');
	assert.deepEqual(triggered, [URL_A]);
});

test('seeding a claim-only row PATCHES around the claim — never a put over it', async () => {
	// A row created by recordPageClaim has a claim but no signature. The probe's first pass over
	// it takes the seed path, and the row EXISTS — so the write must be a patch naming only the
	// probe's own columns. A whole-row put would erase the render path's claim (or, worse, copy a
	// stale one over a claim a concurrent render just wrote), and the feature would silently stop
	// detecting on exactly the freshly-rendered pages it exists for.
	const claim = JSON.stringify([['35.99'], true]);
	const { stats, written, triggered } = await runPageCheckPass({
		rows: [row(URL_A)],
		answers: { [URL_A]: JSON.stringify([39.99, 35.99, 35.99, true]) },
		stored: { [URL_A]: { signature: null, probedAt: NaN, pageSignature: claim } },
	});
	assert.equal(stats.seeded, 1);
	assert.deepEqual(triggered, []);
	assert.equal(written.length, 1);
	assert.equal(written[0].rowExists, true, 'a claim-only row EXISTS — the seed must patch, never put over the claim');
	assert.equal(written[0].clearClaim, false, 'seeding must not clear the claim');
});

test('ANY acted trip clears the claim — a drift trip too, not just a page disagreement', async () => {
	// The trip hard-expired the page, so its claim no longer describes anything served — and a
	// preserved claim disagrees with the NEW baseline by construction on a price drift, which
	// would re-trip the same (already expired, already filed) page on every subsequent pass until
	// its re-render lands.
	const claim = JSON.stringify([['35.99'], true]); // agrees with the CURRENT origin answer
	const { stats, written, triggered } = await runPageCheckPass({
		rows: [row(URL_A)],
		answers: { [URL_A]: JSON.stringify([39.99, 35.99, 35.99, true]) },
		stored: { [URL_A]: { signature: JSON.stringify([1, 2, 3, true]), probedAt: NaN, pageSignature: claim } },
	});
	assert.equal(stats.changed, 1);
	assert.equal(stats.pageMismatch, 0, 'the page agrees with the origin — this is drift only');
	assert.deepEqual(triggered, [URL_A]);
	assert.equal(written.length, 1);
	assert.equal(written[0].clearClaim, true, 'an acted trip must clear the claim');
});

test('a DRY-RUN drift write preserves the claim — nothing was expired, the gauge must keep reading', async () => {
	const claim = JSON.stringify([['29.99'], true]);
	const { written, triggered } = await runPageCheckPass({
		rows: [row(URL_A)],
		answers: { [URL_A]: JSON.stringify([39.99, 35.99, 35.99, true]) },
		stored: { [URL_A]: { signature: JSON.stringify([1, 2, 3, true]), probedAt: NaN, pageSignature: claim } },
		dryRun: true,
	});
	assert.deepEqual(triggered, []);
	assert.equal(written.length, 1);
	assert.equal(written[0].clearClaim, false, 'dry-run must not clear the claim');
});

/**
 * recordPageClaim — the render-path write. This is the function that seeds ProbeState rows, so the
 * table verb is the contract: patch cannot create a missing record (put must be the seed), and put
 * on an existing row would clobber the probe's own columns (patch must be the update). The fakes
 * record WHICH verb ran, because a green `await` on the wrong verb is exactly how a silent-no-op
 * seeding bug almost shipped in this branch.
 */
const CLAIM_URL = 'https://example.com/product/prd-123/thing.jsp';
const claimHarness = async ({ existing = null } = {}) => {
	const { applyOptions } = await import('../src/config.js');
	applyOptions({
		changeProbe: {
			enabled: true,
			rules: [
				{
					label: 'pdp',
					pathPattern: '^/product/prd-',
					source: 'request',
					request: { urlTemplate: 'https://api.example.com/x', method: 'POST', body: '{}' },
					extract: ['a', 'b', 'price', 'available'],
					pageCheck: { enabled: true, priceFrom: 2, availableFrom: 3 },
				},
			],
		},
	});
	const calls = { get: [], put: [], patch: [] };
	globalThis.databases.probe_state.ProbeState = {
		async get(query) {
			calls.get.push(query);
			return existing;
		},
		async put(id, row) {
			calls.put.push({ id, row });
		},
		async patch(id, patch) {
			calls.patch.push({ id, patch });
		},
	};
	return calls;
};
const restoreConfig = async () => (await import('../src/config.js')).applyOptions({});

test('recordPageClaim SEEDS a missing row with put — patch cannot create', async (t) => {
	t.after(restoreConfig);
	const calls = await claimHarness();
	await changeProbe.recordPageClaim(CLAIM_URL, ['35.99', 'USD', 'InStock'], 1_700_000_000_000);
	assert.equal(calls.patch.length, 0);
	assert.equal(calls.put.length, 1);
	assert.equal(calls.put[0].id, CLAIM_URL);
	assert.deepEqual(calls.put[0].row, {
		url: CLAIM_URL,
		pageSignature: JSON.stringify([['35.99'], true]),
		// The RENDER's lastCached, passed in — not `Date.now()` at claim time. The serve path tests a
		// device key with `lastCached >= basisAt`, so a stamp taken even milliseconds later would make
		// the page this claim certifies fail its own test.
		pageClaimAt: new Date(1_700_000_000_000),
	});
});

test('recordPageClaim UPDATES an existing row with patch — put would clobber the probe baseline', async (t) => {
	t.after(restoreConfig);
	const calls = await claimHarness({ existing: { url: CLAIM_URL } });
	await changeProbe.recordPageClaim(CLAIM_URL, ['35.99', 'USD', 'OutOfStock'], 1_700_000_000_000);
	assert.equal(calls.put.length, 0);
	assert.equal(calls.patch.length, 1);
	assert.equal(calls.patch[0].id, CLAIM_URL);
	assert.deepEqual(calls.patch[0].patch, {
		pageSignature: JSON.stringify([['35.99'], false]),
		pageClaimAt: new Date(1_700_000_000_000),
	});
});

test('recordPageClaim: an ABSENT field means an old renderer — warn once an hour, write nothing', async (t) => {
	t.after(restoreConfig);
	const calls = await claimHarness();
	const warns = [];
	globalThis.logger.warn = (message) => warns.push(message);
	await changeProbe.recordPageClaim(CLAIM_URL, undefined);
	await changeProbe.recordPageClaim(CLAIM_URL, undefined);
	assert.equal(warns.length, 1, 'the per-render warn must throttle');
	assert.match(warns[0], /older than @harperfast\/prerender-browser 1\.20\.0/);
	assert.equal(calls.get.length + calls.put.length + calls.patch.length, 0);
});

test('recordPageClaim: null means the extraction RAN and found nothing — silent, no version alarm', async (t) => {
	t.after(restoreConfig);
	const calls = await claimHarness();
	const warns = [];
	globalThis.logger.warn = (message) => warns.push(message);
	await changeProbe.recordPageClaim(CLAIM_URL, null);
	assert.equal(warns.length, 0, 'an offerless page must not impersonate an outdated renderer');
	assert.equal(calls.get.length + calls.put.length + calls.patch.length, 0);
});

test('recordPageClaim ignores URLs no pageCheck rule matches, and never throws into the render path', async (t) => {
	t.after(restoreConfig);
	const calls = await claimHarness();
	await changeProbe.recordPageClaim('https://example.com/category/shoes', ['1.00', 'USD', 'InStock']);
	await changeProbe.recordPageClaim('not a url', ['1.00', 'USD', 'InStock']);
	assert.equal(calls.get.length + calls.put.length + calls.patch.length, 0);
});

test('recordPageClaim honors the master switch — "off" means nothing stored, not just no probes', async (t) => {
	t.after(restoreConfig);
	const calls = await claimHarness();
	const { applyOptions } = await import('../src/config.js');
	applyOptions({ changeProbe: { enabled: false, rules: [] } });
	await changeProbe.recordPageClaim(CLAIM_URL, ['35.99', 'USD', 'InStock']);
	assert.equal(calls.get.length + calls.put.length + calls.patch.length, 0);
});

test('writeSignature: patch for an existing row (claim untouched unless cleared), put only to create', async () => {
	// The verb choice IS the concurrency contract: a patch names only the probe's own columns, so
	// a claim a render writes mid-probe survives structurally; a whole-row put would replace it
	// with the stale copy read before the probe fetch.
	const calls = { put: [], patch: [] };
	globalThis.databases.probe_state.ProbeState = {
		async put(id, rowFields) {
			calls.put.push({ id, rowFields });
		},
		async patch(id, fields) {
			calls.patch.push({ id, fields });
		},
	};
	await changeProbe.writeSignature(URL_A, 'sig', { rowExists: true });
	assert.equal(calls.put.length, 0);
	assert.deepEqual(Object.keys(calls.patch[0].fields).sort(), ['probedAt', 'signature']);

	await changeProbe.writeSignature(URL_A, 'sig', { rowExists: true, clearClaim: true });
	// THE WHOLE RECORD. `pageClaimAt` is the render `pageSignature` and `pageFacts` came from; clearing
	// one and leaving another is a half-state a verification (or a mapped field) could later read.
	assert.deepEqual(Object.keys(calls.patch[1].fields).sort(), [
		'pageClaimAt',
		'pageFacts',
		'pageSignature',
		'probedAt',
		'signature',
	]);
	assert.equal(calls.patch[1].fields.pageSignature, null);
	assert.equal(calls.patch[1].fields.pageClaimAt, null);
	assert.equal(calls.patch[1].fields.pageFacts, null, 'the page record describes the expired page too');

	await changeProbe.writeSignature(URL_A, 'sig', { rowExists: false });
	assert.equal(calls.patch.length, 2);
	assert.equal(calls.put.length, 1);
	assert.equal(calls.put[0].rowFields.url, URL_A);
	assert.equal(calls.put[0].rowFields.pageSignature, null, 'a created row starts with no claim');
	assert.equal(calls.put[0].rowFields.pageFacts, null, 'and with no page record');
});

// ---- continuous pacing + the local-load governor ------------------------------------------------

/**
 * A pass harness that RECORDS the pauses instead of taking them, with a controllable clock.
 * The pacing is entirely arithmetic on elapsed time, so a fake clock makes it exactly testable —
 * and the properties below are the ones that decide whether a continuous probe is safe to leave
 * running: that the origin ceiling is never exceeded, that being behind is reported rather than
 * silently absorbed, and that a governor which cannot measure does not throttle on a guess.
 */
const runPaced = async ({ rows, answers = {}, clockStep = 0, ...overrides }) => {
	const { compileProbeRules } = await import('../src/util/changeProbeSpec.js');
	const pauses = [];
	let clock = 0;
	const stats = await changeProbe.runProbePass({
		rows: stream(rows),
		rules: compileProbeRules(RULES_RAW),
		ownerOf: () => 'node-a',
		hostname: 'node-a',
		probe: async (rule, url) => {
			clock += clockStep;
			return answers[url] ?? 'sig';
		},
		read: async () => null,
		write: async () => {},
		submitTrigger: async () => 'queued',
		dryRun: true,
		maxTriggers: 1000,
		concurrency: 2,
		ratePerSecond: 10,
		now: () => clock,
		pause: async (ms) => {
			pauses.push(ms);
			clock += ms;
		},
		...overrides,
	});
	return { stats, pauses };
};

const urls = (n) => Array.from({ length: n }, (_, i) => ({ url: `https://x.test/product/prd-${i}` }));

test('interval mode is unchanged: no cycle target means the old ratePerSecond window, exactly', async () => {
	// The guarantee that makes this shippable to a live, hand-tuned deployment. 2 rows per batch
	// at 10/s is a 200ms window, and nothing about continuous mode may alter it.
	const { pauses } = await runPaced({ rows: urls(4), cycleTarget: 0, sliceSize: 0 });
	assert.deepEqual(pauses, [200, 200]);
});

test('continuous: a reachable cycle target paces UNDER the origin ceiling', async () => {
	// 100 rows in 100s wants 1/s; the ceiling is 10/s, so the target governs and the pass slows
	// to spread the slice across the budget instead of finishing early and idling.
	const { pauses } = await runPaced({
		rows: urls(4),
		cycleTarget: 100_000,
		sliceSize: 100,
		ratePerSecond: 10,
	});
	assert.ok(
		pauses.every((ms) => ms > 200),
		`expected pauses wider than the 200ms ceiling window, got ${JSON.stringify(pauses)}`
	);
});

test('continuous: an unreachable target is CLAMPED to the ceiling and reported, never honoured', async () => {
	// 1,000,000 rows in 1s is not a schedule anyone can keep. The ceiling is the number agreed
	// with whoever runs the origin, so the target loses — and says so, which is the whole reason
	// this mode exists instead of the silently-skipped pass.
	const { stats, pauses } = await runPaced({
		rows: urls(4),
		cycleTarget: 1000,
		sliceSize: 1_000_000,
		ratePerSecond: 10,
	});
	assert.deepEqual(pauses, [200, 200], 'paced at the ceiling, not faster');
	assert.equal(stats.behindBatches, 2, 'and every such batch is counted for probe_cycle_behind');
});

test('continuous: no slice estimate runs at the ceiling WITHOUT reporting a missed target', async () => {
	// The first cycle after a restart. It is measuring, not failing — counting it as behind would
	// make every restart look like a capacity problem.
	const { stats, pauses } = await runPaced({ rows: urls(4), cycleTarget: 100_000, sliceSize: 0 });
	assert.deepEqual(pauses, [200, 200]);
	assert.equal(stats.behindBatches, 0);
});

test('the load governor widens the window when the loop is lagging', async () => {
	const { pauses } = await runPaced({
		rows: urls(4),
		lagThreshold: 50,
		loadBackoffMax: 8,
		readLag: () => ({ mean: 200, p95: 200, samples: 10 }),
	});
	// First batch doubles to 2x, second to 4x, off the 200ms base window.
	assert.deepEqual(pauses, [400, 800]);
});

test('the load governor RECOVERS by halves once the loop is quiet again', async () => {
	let call = 0;
	const { pauses } = await runPaced({
		rows: urls(8),
		lagThreshold: 50,
		loadBackoffMax: 8,
		// Two lagging batches, then quiet.
		readLag: () => ({ mean: 0, p95: call++ < 2 ? 200 : 1, samples: 10 }),
	});
	assert.deepEqual(pauses, [400, 800, 400, 200], 'up by doubles, down by halves');
});

test('a lag reading of NULL leaves the governor where it is — absent is not quiet', async () => {
	// No monitor, or a window that caught no samples. A probe that cannot measure the loop must
	// not conclude the loop is fine and accelerate into a node it is already hurting.
	const { pauses, stats } = await runPaced({
		rows: urls(4),
		lagThreshold: 50,
		loadBackoffMax: 8,
		readLag: () => null,
	});
	assert.deepEqual(pauses, [200, 200], 'unchanged, not recovered');
	assert.equal(stats.loopLagMs, null);
});

test('the governor is inert when disabled, and never reads the lag at all', async () => {
	let reads = 0;
	const { pauses } = await runPaced({
		rows: urls(4),
		lagThreshold: 0,
		readLag: () => {
			reads++;
			return { mean: 999, p95: 999, samples: 10 };
		},
	});
	assert.equal(reads, 0, 'a disabled governor must not even sample');
	assert.deepEqual(pauses, [200, 200]);
});

test('both governors compound: a busy node probing a struggling origin backs off for both', async () => {
	const { pauses } = await runPaced({
		rows: urls(2),
		ratePerSecond: 10,
		backoffMax: 64,
		lagThreshold: 50,
		loadBackoffMax: 8,
		readLag: () => ({ mean: 200, p95: 200, samples: 10 }),
		// A pushback response drives the ORIGIN governor on the same batch. `distress` is the flag
		// `isDistress` reads — `probeOnce` sets it on 429/502/503/504 and on connect/read timeouts.
		probe: async () => {
			const e = new Error('429 from the origin');
			e.distress = true;
			throw e;
		},
	});
	// 200ms base * 2 (origin) * 2 (local) — independent causes, multiplied not maxed.
	assert.deepEqual(pauses, [800]);
});

// ---- the scheduler: mode is a live option, and the canary is not collateral ----------------------

/**
 * `syncProbeTimers` is what makes `mode` switchable without a restart, and the interesting part
 * is what it must NOT break on the way: the canary is a separate cadence with a separate job
 * (mass change between sweeps), and an early return for continuous mode would have disabled the
 * mass-change detector for everyone who turned the new mode on.
 */
const applyProbeConfig = async (changeProbeOptions) => {
	const { applyOptions } = await import('../src/config.js');
	applyOptions({ changeProbe: { rules: RULES_RAW, ...changeProbeOptions } });
};

test('scheduler: mode is live — switching re-arms rather than leaving the old driver running', async (t) => {
	t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });

	await applyProbeConfig({ enabled: true, sweepInterval: 60_000, startDelay: 0, startJitter: 1 });
	changeProbe.startChangeProbeScheduler();
	assert.equal(changeProbe.probeTimerState().armedSweep, 60_000, 'interval mode arms the interval');

	await applyProbeConfig({ enabled: true, mode: 'continuous', cycleTarget: 60_000, startDelay: 0, startJitter: 1 });
	assert.equal(
		changeProbe.probeTimerState().armedSweep,
		'continuous',
		'the armed value must CHANGE with the mode, or sync sees no difference and leaves the timer up'
	);

	await applyProbeConfig({ enabled: true, sweepInterval: 60_000, startDelay: 0, startJitter: 1 });
	assert.equal(changeProbe.probeTimerState().armedSweep, 60_000, 'and back');

	t.mock.timers.reset();
	await applyProbeConfig({ enabled: false });
});

test('scheduler: anchored mode arms a daily timer keyed on the anchor, runs no boot sweep, and re-arms on edit', async (t) => {
	t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });

	await applyProbeConfig({
		enabled: true,
		mode: 'anchored',
		anchorTime: '03:00',
		anchorTimezone: 'UTC',
		startDelay: 0,
		startJitter: 1,
	});
	changeProbe.startChangeProbeScheduler();
	assert.equal(changeProbe.probeTimerState().armedSweep, 'anchored:03:00|UTC');
	// The status reads the PUBLISHED row (what every other worker sees), so wait for the write.
	await changeProbe.probeStatePublishedForTest();
	const status = await changeProbe.changeProbeStatus();
	assert.ok(status.sweep.nextAnchoredRunAt, 'the next run is published for the admin surface');
	const next = new Date(status.sweep.nextAnchoredRunAt);
	assert.equal(next.getUTCHours(), 3);
	assert.equal(next.getUTCMinutes(), 0);
	assert.ok(next.getTime() > Date.now() && next.getTime() - Date.now() <= 24 * 60 * 60 * 1000);
	// No boot sweep: with startDelay 0 an interval/continuous boot would have started a pass by now.
	assert.equal(status.sweep.running, false);

	// Editing the anchor is a mode change to the scheduler: the marker moves, the timer re-arms.
	await applyProbeConfig({
		enabled: true,
		mode: 'anchored',
		anchorTime: '04:30',
		anchorTimezone: 'UTC',
		startDelay: 0,
		startJitter: 1,
	});
	assert.equal(changeProbe.probeTimerState().armedSweep, 'anchored:04:30|UTC');

	// Back to interval mode (not continuous, which would start a pass that outlives the test).
	await applyProbeConfig({ enabled: true, sweepInterval: 60_000, startDelay: 0, startJitter: 1 });
	assert.equal(changeProbe.probeTimerState().armedSweep, 60_000);

	t.mock.timers.reset();
});

test('scheduler: an anchor inside the spring-forward hour still arms a FUTURE run', async (t) => {
	// 2026-03-08, America/New_York: 02:00 EST jumps to 03:00 EDT, so an anchor of 02:30 names a
	// wall-clock time that does not occur that day and resolves to an instant already past. Armed
	// as-is, the pass fires early AND every re-arm at the end of a pass computes the same past
	// instant — the whole corpus walked back to back at the ceiling rate until the hour is over.
	// The host's own zone is pinned to UTC for the duration: the resolver reads it, so without this
	// the instant it returns — and therefore whether the bug reproduces at all — depends on wherever
	// the test happens to run.
	const hostTz = process.env.TZ;
	process.env.TZ = 'UTC';
	t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
	try {
		// Three instants inside the skipped hour. Every one of them resolved into the past before
		// the guard, and each would have re-armed to the same past instant on every completion.
		for (const now of ['2026-03-08T06:35:00Z', '2026-03-08T06:45:00Z', '2026-03-08T06:55:00Z']) {
			t.mock.timers.setTime(Date.parse(now));
			await applyProbeConfig({
				enabled: true,
				mode: 'anchored',
				anchorTime: '02:30',
				anchorTimezone: 'America/New_York',
				startDelay: 0,
				startJitter: 1,
			});
			changeProbe.startChangeProbeScheduler();
			await changeProbe.probeStatePublishedForTest();

			const status = await changeProbe.changeProbeStatus();
			const next = new Date(status.sweep.nextAnchoredRunAt).getTime();
			assert.ok(
				next > Date.now(),
				`at ${now} the next anchored run must be in the future, got ${new Date(next).toISOString()}`
			);
			assert.equal(status.sweep.running, false, `at ${now} it must not fire on the spot`);
			await applyProbeConfig({ enabled: true, sweepInterval: 60_000, startDelay: 0, startJitter: 1 });
		}
	} finally {
		t.mock.timers.reset();
		if (hostTz === undefined) delete process.env.TZ;
		else process.env.TZ = hostTz;
	}
	await applyProbeConfig({ enabled: false });
});

test('scheduler: the canary stays armed in continuous mode', async (t) => {
	t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });

	await applyProbeConfig({
		enabled: true,
		mode: 'continuous',
		cycleTarget: 60_000,
		canary: { interval: 30_000, count: 5 },
		startDelay: 0,
		startJitter: 1,
	});
	changeProbe.startChangeProbeScheduler();
	assert.equal(changeProbe.probeTimerState().armedCanary, 30_000);

	t.mock.timers.reset();
	await applyProbeConfig({ enabled: false });
});

test('scheduler: disabling stops the continuous driver, not just the interval timer', async (t) => {
	t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });

	await applyProbeConfig({ enabled: true, mode: 'continuous', cycleTarget: 60_000, startDelay: 0, startJitter: 1 });
	changeProbe.startChangeProbeScheduler();
	assert.equal(changeProbe.probeTimerState().armedSweep, 'continuous');

	await applyProbeConfig({ enabled: false });
	assert.equal(changeProbe.probeTimerState().armedSweep, null);

	t.mock.timers.reset();
});

test('cycle pacing belongs to the SWEEP — the canary must never inherit the sweep’s budget', async () => {
	// The canary re-probes a small fixed cohort on a deliberately fast cadence and has no budget
	// to spread anything across. Given the sweep's `cycleTarget`/`sliceSize` it would compute
	// `remaining/left` from the SWEEP's denominator and pace a 500-URL cohort as though it were
	// the whole slice — slowing further the longer the cycle target gets. Nothing in the canary's
	// own counters would show it had stopped being fast.
	//
	// Asserted on the limits builder both real callers share, so the split is pinned at its
	// source rather than inferred from a pass's counters.
	const { applyOptions } = await import('../src/config.js');
	applyOptions({
		changeProbe: { enabled: true, mode: 'continuous', cycleTarget: 8 * 60 * 60 * 1000, rules: RULES_RAW },
	});

	const sweepLimits = changeProbe.__passLimitsForTest(undefined, { paced: true });
	const canaryLimits = changeProbe.__passLimitsForTest(undefined);

	assert.equal(sweepLimits.cycleTarget, 8 * 60 * 60 * 1000, 'the sweep paces to the cycle target');
	assert.equal(canaryLimits.cycleTarget, 0, 'the canary does not');
	assert.equal(canaryLimits.sliceSize, 0, 'and has no slice denominator to pace against');
	// Everything else is shared — the fix must not have forked the limits wholesale.
	assert.equal(canaryLimits.ratePerSecond, sweepLimits.ratePerSecond);
	assert.equal(canaryLimits.concurrency, sweepLimits.concurrency);
	assert.equal(canaryLimits.lagThreshold, sweepLimits.lagThreshold, 'a congested node is congested either way');

	applyOptions({ changeProbe: { enabled: false } });
});

// ---- cross-worker observability ------------------------------------------------------------

/**
 * The probe scheduler arms on worker 0 only, but `/prerender_admin/change-probe` is served by all
 * sixteen. With the state in module variables the endpoint reported a healthy probe as switched
 * off on ~95% of reads (measured: worker 0 answered 3 of 60), and the POST guard — reading the
 * same module state — could never fire, so "Run sweep" started a second full-rate sweep beside
 * the scheduled one.
 *
 * These drive the shared row directly, which is what a different worker sees.
 */
const otherWorkerSees = async () => {
	// Everything worker-local is irrelevant to another worker; only the row travels.
	const row = await changeProbe.readProbeStateForTest();
	return row;
};

test('a finished pass is readable from a worker that never ran it', async () => {
	const { applyOptions } = await import('../src/config.js');
	applyOptions({ changeProbe: { enabled: true, rules: RULES_RAW } });

	await changeProbe.runProbeSweepOnce({ label: 'published' });

	// The row is the whole contract — a second worker has no module state at all.
	const row = await otherWorkerSees();
	assert.ok(row, 'the pass published a row');
	assert.equal(row.sweep.running, false);
	assert.equal(row.sweep.lastRun.label, 'published');
	assert.equal(row.node, 'node-a');

	const status = await changeProbe.changeProbeStatus();
	assert.equal(status.sweep.lastRun.label, 'published');
	assert.equal(status.stateAvailable, true, 'a present row is reported as available');

	applyOptions({ changeProbe: { enabled: false } });
});

test('no row reads as "nothing has run here", NOT as a failed read', async () => {
	// The distinction the old shape could not express: `armedInterval: null` meant both "disarmed"
	// and "you asked a worker that does not know", and an operator cannot act on that.
	const status = await changeProbe.changeProbeStatus();
	assert.equal(status.stateAvailable, false);
	assert.equal(status.sweep.lastRun, null);
	assert.equal(status.sweep.running, false);
});

test('the run guard is NODE-WIDE: a claim held by another worker refuses a second pass', async () => {
	const { applyOptions } = await import('../src/config.js');
	applyOptions({ changeProbe: { enabled: true, rules: RULES_RAW } });

	// Exactly what worker 0's scheduled sweep leaves behind while it runs. This worker's module
	// state knows nothing about it — which is the situation that used to double the origin rate.
	await changeProbe.publishProbeStateForTest({
		sweep: { running: true, startedAt: Date.now(), heartbeatAt: Date.now(), lastRun: null },
	});

	assert.equal(await changeProbe.isPassRunningOnNode('sweep'), true, 'visible from this worker');

	const result = await changeProbe.runProbeSweepOnce({ label: 'second' });
	assert.equal(result.skipped, true, 'refused');
	assert.match(result.reason, /already running/);

	// And the local flag must not be left stuck on by the refusal — that would wedge this worker's
	// sweep for the life of the process.
	assert.equal(changeProbe.isProbeSweepRunning(), false);

	applyOptions({ changeProbe: { enabled: false } });
});

test('a claim whose heartbeat has stopped is taken over, not honoured forever', async () => {
	const { applyOptions } = await import('../src/config.js');
	applyOptions({ changeProbe: { enabled: true, rules: RULES_RAW } });

	// A worker that crashed mid-sweep. A sweep runs for HOURS, so liveness cannot be inferred from
	// startedAt — without the heartbeat this row would either disable the probe until a process
	// restart, or be stolen from a healthy pass.
	const longAgo = Date.now() - 60 * 60 * 1000;
	await changeProbe.publishProbeStateForTest({
		sweep: { running: true, startedAt: longAgo, heartbeatAt: longAgo, lastRun: null },
	});

	assert.equal(await changeProbe.isPassRunningOnNode('sweep'), false, 'a dead heartbeat is not running');
	const result = await changeProbe.runProbeSweepOnce({ label: 'takeover' });
	assert.notEqual(result.skipped, true, 'the stale claim was taken over');

	applyOptions({ changeProbe: { enabled: false } });
});

test('the re-entrancy guard is set BEFORE the claim await, not after', async () => {
	// The claim is async, so setting the local flag after it leaves a window where two concurrent
	// calls on THIS worker both pass the guard. Caught by a hanging test during development.
	const { applyOptions } = await import('../src/config.js');
	applyOptions({ changeProbe: { enabled: true, rules: RULES_RAW } });

	const first = changeProbe.runProbeSweepOnce({ label: 'a' });
	// Synchronously — no await between the call and this check.
	assert.equal(changeProbe.isProbeSweepRunning(), true, 'the flag is set before any await');
	const second = await changeProbe.runProbeSweepOnce({ label: 'b' });
	assert.equal(second.skipped, true, 'the concurrent call is refused');
	await first;

	applyOptions({ changeProbe: { enabled: false } });
});

test('a heartbeat mid-pass must NOT wipe lastRun — the merge is one level deep', async () => {
	// The regression that nearly shipped inside the fix for the same class of bug. Every writer
	// patches ONE branch with a partial object; a shallow spread replaces that branch, so the
	// heartbeat — which carries no `lastRun` — deleted it 30s into a pass and left it deleted for
	// the hours the pass ran. An operator checking on a live sweep would read exactly the
	// "nothing has ever run here" this module exists to eliminate.
	await changeProbe.publishProbeStateForTest({
		sweep: { running: false, startedAt: 1, heartbeatAt: 1, lastRun: { label: 'previous' } },
	});

	// Exactly what `makeHeartbeat` writes: no `lastRun` key at all.
	await changeProbe.publishProbeStateForTest({
		sweep: { running: true, startedAt: 2, heartbeatAt: 2, progress: { examinedApprox: 400 } },
	});

	const row = await changeProbe.readProbeStateForTest();
	assert.deepEqual(row.sweep.lastRun, { label: 'previous' }, 'the previous result survived the heartbeat');
	assert.equal(row.sweep.progress.examinedApprox, 400, 'and the new progress landed');
	assert.equal(row.sweep.running, true);
});

test('a publish that rejects neither wedges later publishes nor rejects to its caller (review)', async () => {
	// Force the one path out of publishNow's try/catch: the read throws AND the warning logger throws.
	const working = globalThis.databases.coordination.SharedBuffer;
	globalThis.databases.coordination.SharedBuffer = class {
		static async get() {
			throw new Error('store down');
		}
		static async put() {}
	};
	globalThis.logger.warn = () => {
		throw new Error('logger down');
	};
	const failed = await changeProbe.publishProbeStateForTest({ sweep: { running: true } });
	assert.equal(failed, false, 'the rejected publish resolves false instead of rejecting to its caller');

	globalThis.databases.coordination.SharedBuffer = working;
	globalThis.logger.warn = () => {};
	await changeProbe.publishProbeStateForTest({ scheduler: { armedSweep: 'anchored:00:05|UTC' } });
	const row = await changeProbe.readProbeStateForTest();
	assert.equal(row?.scheduler?.armedSweep, 'anchored:00:05|UTC', 'the next publish still landed');
});

test('omission means "leave alone"; clearing a field requires naming it', async () => {
	// The rule the one-level merge implies, pinned so a future writer does not assume otherwise.
	await changeProbe.publishProbeStateForTest({ sweep: { running: true, progress: { examinedApprox: 9 } } });
	await changeProbe.publishProbeStateForTest({ sweep: { running: false, progress: null } });
	const row = await changeProbe.readProbeStateForTest();
	assert.equal(row.sweep.progress, null, 'an explicit null clears');
	assert.equal(row.sweep.running, false);
});

test('branches are independent: publishing scheduler state leaves pass records alone', async () => {
	await changeProbe.publishProbeStateForTest({ sweep: { running: false, lastRun: { label: 'kept' } } });
	await changeProbe.publishProbeStateForTest({ scheduler: { armedSweep: 'continuous', sliceSize: 42 } });
	const row = await changeProbe.readProbeStateForTest();
	assert.deepEqual(row.sweep.lastRun, { label: 'kept' });
	assert.equal(row.scheduler.sliceSize, 42);
});

test('a running row with no usable timestamp is not treated as freshly beating', async () => {
	// `Number(null)` is 0, which is finite — so a naive check reads "beat at the epoch" and the
	// answer depends on which side of the comparison that accident falls.
	const { isPassRunning } = await import('../src/util/probeState.js');
	assert.equal(isPassRunning({ sweep: { running: true } }, 'sweep', 60_000), false);
	assert.equal(isPassRunning({ sweep: { running: true, heartbeatAt: null, startedAt: null } }, 'sweep', 60_000), false);
	assert.equal(isPassRunning({ sweep: { running: true, heartbeatAt: 'nonsense' } }, 'sweep', 60_000), false);
	// A real, fresh beat still reads as running — the guard must not refuse everything.
	assert.equal(isPassRunning({ sweep: { running: true, heartbeatAt: Date.now() } }, 'sweep', 60_000), true);
	// And an ISO string, which is how a Date column can come back across a serialization boundary.
	assert.equal(
		isPassRunning({ sweep: { running: true, heartbeatAt: new Date().toISOString() } }, 'sweep', 60_000),
		true
	);
});

// ---- per-page verification writes (invalidation.verification) ---------------------------------

/**
 * The write gate for `PageVerification`. Two conditions, and BOTH are load-bearing in a way that is
 * invisible if you only test the happy path — a bug in either serves invalidated content while every
 * metric reports success.
 */
const runVerifyPass = async ({ rows, answers, stored = {}, armed = true, ...overrides }) => {
	const { compileProbeRules } = await import('../src/util/changeProbeSpec.js');
	const verified = [];
	const armedCalls = [];
	const rules = compileProbeRules([{ ...PAGECHECK_RULES[0], invalidateScope: 'route:prefix:/p/' }]);
	const stats = await changeProbe.runProbePass({
		rows: stream(rows),
		rules,
		ownerOf: () => 'node-a',
		hostname: 'node-a',
		probe: async (rule, url) => answers[url] ?? null,
		read: async (url) => stored[url] ?? null,
		write: async () => {},
		submitTrigger: async () => 'queued',
		verify: async (url, basisAt) => verified.push({ url, basisAt }),
		isArmed: async (scope) => {
			armedCalls.push(scope);
			if (armed === 'throw') throw new Error('read fault');
			return armed;
		},
		dryRun: false,
		maxTriggers: 100,
		concurrency: 1,
		ratePerSecond: 1000,
		pause: async () => {},
		...overrides,
	});
	return { stats, verified, armedCalls };
};

const AGREE_SIG = JSON.stringify([39.99, 35.99, 35.99, true]);
const AGREE_CLAIM = JSON.stringify([['35.99'], true]);
const CLAIM_AT = new Date(1_700_000_000_000);

test('an unchanged page whose claim AGREES is verified while an invalidation is armed', async () => {
	const { verified, stats } = await runVerifyPass({
		rows: [row(URL_A)],
		answers: { [URL_A]: AGREE_SIG },
		stored: { [URL_A]: { signature: AGREE_SIG, probedAt: NaN, pageSignature: AGREE_CLAIM, pageClaimAt: CLAIM_AT } },
	});
	assert.deepEqual(
		verified.map((v) => v.url),
		[URL_A]
	);
	assert.equal(verified[0].basisAt, CLAIM_AT, 'the render basis must be carried onto the verification');
	assert.equal(stats.unchanged, 1, 'verification must not disturb the signature buckets');
});

test('NO pageSignature -> NOT verified, even though pageDisagrees is false', async () => {
	// THE BUG THIS FEATURE CANNOT SURVIVE. `pageDisagrees` is only computed when a stored claim
	// exists, so a URL nobody ever compared arrives at the unchanged branch looking exactly like a
	// real agreement. Writing a verification here would exempt a page from an invalidation on the
	// strength of a comparison that never happened.
	const { verified } = await runVerifyPass({
		rows: [row(URL_A)],
		answers: { [URL_A]: AGREE_SIG },
		stored: { [URL_A]: { signature: AGREE_SIG, probedAt: NaN, pageSignature: null } },
	});
	assert.deepEqual(verified, [], 'no claim was compared, so there is nothing to certify');
});

test('a DISAGREEING page is triggered, never verified', async () => {
	const { verified, stats } = await runVerifyPass({
		rows: [row(URL_A)],
		answers: { [URL_A]: AGREE_SIG },
		stored: { [URL_A]: { signature: AGREE_SIG, probedAt: NaN, pageSignature: JSON.stringify([['35.99'], false]) } },
	});
	assert.equal(stats.pageMismatch, 1);
	assert.deepEqual(verified, []);
});

test('a CHANGED signature is never verified', async () => {
	const { verified, stats } = await runVerifyPass({
		rows: [row(URL_A)],
		answers: { [URL_A]: JSON.stringify([39.99, 30.0, 30.0, true]) },
		stored: { [URL_A]: { signature: AGREE_SIG, probedAt: NaN, pageSignature: AGREE_CLAIM, pageClaimAt: CLAIM_AT } },
	});
	assert.equal(stats.changed, 1);
	assert.deepEqual(verified, []);
});

test('a FIRST OBSERVATION seeds a baseline and is not verified', async () => {
	const { verified, stats } = await runVerifyPass({
		rows: [row(URL_A)],
		answers: { [URL_A]: AGREE_SIG },
		stored: { [URL_A]: { signature: null, probedAt: NaN, pageSignature: AGREE_CLAIM, pageClaimAt: CLAIM_AT } },
	});
	assert.equal(stats.seeded, 1);
	assert.deepEqual(verified, [], 'a page the probe has never compared is not proof of anything');
});

test('NOT ARMED -> no verification writes at all: a converged corpus pays nothing', async () => {
	const { verified } = await runVerifyPass({
		rows: [row(URL_A), row(URL_B)],
		answers: { [URL_A]: AGREE_SIG, [URL_B]: AGREE_SIG },
		stored: {
			[URL_A]: { signature: AGREE_SIG, probedAt: NaN, pageSignature: AGREE_CLAIM, pageClaimAt: CLAIM_AT },
			[URL_B]: { signature: AGREE_SIG, probedAt: NaN, pageSignature: AGREE_CLAIM, pageClaimAt: CLAIM_AT },
		},
		armed: false,
	});
	assert.deepEqual(verified, []);
});

test('the armed check is resolved ONCE PER SCOPE, not once per row', async () => {
	const { armedCalls } = await runVerifyPass({
		rows: [row(URL_A), row(URL_B)],
		answers: { [URL_A]: AGREE_SIG, [URL_B]: AGREE_SIG },
		stored: {
			[URL_A]: { signature: AGREE_SIG, probedAt: NaN, pageSignature: AGREE_CLAIM, pageClaimAt: CLAIM_AT },
			[URL_B]: { signature: AGREE_SIG, probedAt: NaN, pageSignature: AGREE_CLAIM, pageClaimAt: CLAIM_AT },
		},
	});
	assert.equal(armedCalls.length, 1, 'a pass covering 300k rows must not pay a point read per row');
});

test('an armed check that THROWS fails closed', async () => {
	const { verified } = await runVerifyPass({
		rows: [row(URL_A)],
		answers: { [URL_A]: AGREE_SIG },
		stored: { [URL_A]: { signature: AGREE_SIG, probedAt: NaN, pageSignature: AGREE_CLAIM, pageClaimAt: CLAIM_AT } },
		armed: 'throw',
	});
	assert.deepEqual(verified, [], 'unknown means unverified means keep proxying');
});

test('with no verify/isArmed wired, the pass behaves exactly as before', async () => {
	const { compileProbeRules } = await import('../src/util/changeProbeSpec.js');
	const stats = await changeProbe.runProbePass({
		rows: stream([row(URL_A)]),
		rules: compileProbeRules(PAGECHECK_RULES),
		ownerOf: () => 'node-a',
		hostname: 'node-a',
		probe: async () => AGREE_SIG,
		read: async () => ({ signature: AGREE_SIG, probedAt: NaN, pageSignature: AGREE_CLAIM, pageClaimAt: CLAIM_AT }),
		write: async () => {},
		submitTrigger: async () => 'queued',
		dryRun: false,
		maxTriggers: 100,
		concurrency: 1,
		ratePerSecond: 1000,
		pause: async () => {},
	});
	assert.equal(stats.unchanged, 1);
});

// ---- appending extract paths (append-only rule edits) -------------------------------------------

/**
 * A rule edit that only APPENDS extract paths keeps detecting on the slots the stored baseline has,
 * instead of re-baselining every matched URL blind for a pass. Stored and observed strings are
 * built with the real extraction (`signatureOf(extractValues(...))`), so these tests exercise the
 * exact strings the old rule stored and the new rule observes, not hand-written lookalikes.
 */
const APPEND_OLD = {
	label: 'pdp',
	pathPattern: '^/product/prd-([^/]+)',
	source: 'request',
	request: { urlTemplate: 'https://api.example.com/price/$1', method: 'POST', body: '{}' },
	extract: ['regular', 'sale', 'price'],
	statusSignals: [{ status: 404, contains: 'GONE', signature: 'unavailable' }],
};
const APPEND_NEW = { ...APPEND_OLD, extract: [...APPEND_OLD.extract, 'variants[*].availability'] };

const signedBy = async (raw, json) => {
	const { signatureOf, extractValues } = await import('../src/util/changeProbeSpec.js');
	return signatureOf(extractValues(json, raw.extract));
};
const OFFER = { regular: 39.99, sale: 35.99, price: 35.99, variants: [{ availability: 'In Stock' }] };

const runAppendPass = async ({ rulesRaw = [APPEND_NEW], rows, answers, stored = {}, ...overrides }) => {
	const { compileProbeRules } = await import('../src/util/changeProbeSpec.js');
	const { createInlineTrigger } = await import('../src/util/triggerQueue.js');
	const rules = compileProbeRules(rulesRaw);
	const written = [];
	const triggered = [];
	const write = async (url, signature, options = {}) => written.push({ url, signature, ...options });
	const triggers = createInlineTrigger({ trigger: async (target) => triggered.push(target.url), write });
	const stats = await changeProbe.runProbePass({
		rows: stream(rows),
		rules,
		ownerOf: () => 'node-a',
		hostname: 'node-a',
		probe: async (rule, url) => answers[url] ?? null,
		read: async (url) => (stored[url] ? { probedAt: NaN, pageSignature: null, ...stored[url] } : null),
		write,
		submitTrigger: triggers.submit,
		dryRun: false,
		maxTriggers: 100,
		concurrency: 1,
		ratePerSecond: 1000,
		pause: async () => {},
		...overrides,
	});
	await triggers.drain();
	stats.triggered = triggers.stats.triggered;
	stats.errors = triggers.stats.errors;
	return { stats, written, triggered, rules };
};
const oldFingerprint = async (raw = APPEND_OLD) =>
	(await import('../src/util/changeProbeSpec.js')).compileProbeRules([raw])[0].fingerprint;
const assertInvariant = (stats) =>
	assert.equal(stats.probed, stats.seeded + stats.rebaselined + stats.unchanged + stats.changed + stats.failed);

test('APPENDED path: an unchanged 3-slot baseline is COMPARED under the 4-slot rule and upgraded, not re-baselined', async () => {
	const fingerprint = await oldFingerprint();
	const { stats, written, triggered, rules } = await runAppendPass({
		rows: [row(URL_A), row(URL_B)],
		stored: {
			[URL_A]: { signature: await signedBy(APPEND_OLD, OFFER), fingerprint },
			[URL_B]: { signature: await signedBy(APPEND_OLD, OFFER), fingerprint },
		},
		answers: {
			[URL_A]: await signedBy(APPEND_NEW, OFFER),
			// A change in ONLY the new slot has no baseline yet, so it cannot be seen this pass.
			[URL_B]: await signedBy(APPEND_NEW, { ...OFFER, variants: [{ availability: 'Out of Stock' }] }),
		},
	});
	assert.equal(stats.extended, 2);
	assert.equal(stats.rebaselined, 0, 'appending a path is not a rule change');
	assert.equal(stats.unchanged, 2, 'compared rows land in the signature buckets');
	assert.deepEqual(triggered, []);
	// ONE upgrade patch per row: the FULL new observation under the CURRENT fingerprint, so the next
	// pass compares all four slots.
	assert.deepEqual(
		written.map(({ url, signature, rowExists, fingerprint: fp }) => ({ url, signature, rowExists, fp })),
		[
			{ url: URL_A, signature: await signedBy(APPEND_NEW, OFFER), rowExists: true, fp: rules[0].fingerprint },
			{
				url: URL_B,
				signature: await signedBy(APPEND_NEW, { ...OFFER, variants: [{ availability: 'Out of Stock' }] }),
				rowExists: true,
				fp: rules[0].fingerprint,
			},
		]
	);
	assertInvariant(stats);
});

test('APPENDED path: a change in an OLD slot triggers, and the full observation is stored after the trigger', async () => {
	const fingerprint = await oldFingerprint();
	const repriced = { ...OFFER, price: 29.99 };
	const { stats, written, triggered, rules } = await runAppendPass({
		rows: [row(URL_A)],
		stored: { [URL_A]: { signature: await signedBy(APPEND_OLD, OFFER), fingerprint } },
		answers: { [URL_A]: await signedBy(APPEND_NEW, repriced) },
	});
	assert.equal(stats.extended, 1);
	assert.equal(stats.changed, 1);
	assert.equal(stats.rebaselined, 0);
	assert.deepEqual(triggered, [URL_A]);
	assert.equal(written.length, 1);
	assert.equal(written[0].signature, await signedBy(APPEND_NEW, repriced));
	assert.equal(written[0].fingerprint, rules[0].fingerprint);
	assert.equal(written[0].clearClaim, true, 'the normal acted-trip write');
	assertInvariant(stats);
});

test('APPENDED path: a deferred change writes nothing and is compared the same way on the next pass', async () => {
	const fingerprint = await oldFingerprint();
	const stored = { signature: await signedBy(APPEND_OLD, OFFER), fingerprint };
	const answer = await signedBy(APPEND_NEW, { ...OFFER, sale: 30 });
	const first = await runAppendPass({
		rows: [row(URL_A)],
		stored: { [URL_A]: stored },
		answers: { [URL_A]: answer },
		maxTriggers: 0,
	});
	assert.equal(first.stats.deferred, 1);
	assert.deepEqual(first.written, [], 'budget spent: baseline AND fingerprint left stale');
	const second = await runAppendPass({ rows: [row(URL_A)], stored: { [URL_A]: stored }, answers: { [URL_A]: answer } });
	assert.equal(second.stats.extended, 1);
	assert.deepEqual(second.triggered, [URL_A], 'the retry still sees the change');
});

test('APPENDED path: dry run compares and upgrades, triggers nothing', async () => {
	const fingerprint = await oldFingerprint();
	const { stats, written, triggered, rules } = await runAppendPass({
		rows: [row(URL_A)],
		stored: { [URL_A]: { signature: await signedBy(APPEND_OLD, OFFER), fingerprint } },
		answers: { [URL_A]: await signedBy(APPEND_NEW, { ...OFFER, regular: 49.99 }) },
		dryRun: true,
	});
	assert.equal(stats.changed, 1);
	assert.equal(stats.extended, 1);
	assert.deepEqual(triggered, []);
	assert.deepEqual(
		written.map((w) => [w.signature, w.fingerprint]),
		[[await signedBy(APPEND_NEW, { ...OFFER, regular: 49.99 }), rules[0].fingerprint]]
	);
});

test('APPENDED path: the pageCheck overlay still applies — a disagreeing page triggers on an unchanged row', async () => {
	// pageCheck indices point into `extract`, and appending does not shift them. Here the check even
	// reads the NEW slot (per-variant availability), and the page claims out of stock.
	const withPageCheck = { ...APPEND_NEW, pageCheck: { enabled: true, priceFrom: 2, availableFrom: 3 } };
	const fingerprint = await oldFingerprint(); // pageCheck is not in the fingerprint
	const { stats, triggered } = await runAppendPass({
		rulesRaw: [withPageCheck],
		rows: [row(URL_A)],
		stored: {
			[URL_A]: {
				signature: await signedBy(APPEND_OLD, OFFER),
				fingerprint,
				pageSignature: JSON.stringify([['35.99'], false]),
			},
		},
		answers: { [URL_A]: await signedBy(APPEND_NEW, OFFER) },
	});
	assert.equal(stats.extended, 1);
	assert.equal(stats.unchanged, 1, 'the old slots did not change');
	assert.equal(stats.pageMismatch, 1);
	assert.deepEqual(triggered, [URL_A]);
});

test('APPENDED path: an unchanged row whose page AGREES is verified while an invalidation is armed', async () => {
	const withPageCheck = {
		...APPEND_NEW,
		pageCheck: { enabled: true, priceFrom: 2, availableFrom: 3 },
		invalidateScope: 'route:prefix:/p/',
	};
	const verified = [];
	const { stats, written } = await runAppendPass({
		rulesRaw: [withPageCheck],
		rows: [row(URL_A)],
		stored: {
			[URL_A]: {
				signature: await signedBy(APPEND_OLD, OFFER),
				fingerprint: await oldFingerprint(),
				pageSignature: JSON.stringify([['35.99'], true]),
				pageClaimAt: CLAIM_AT,
			},
		},
		answers: { [URL_A]: await signedBy(APPEND_NEW, OFFER) },
		verify: async (url, basisAt) => verified.push({ url, basisAt }),
		isArmed: async () => true,
	});
	assert.equal(stats.extended, 1);
	assert.deepEqual(verified, [{ url: URL_A, basisAt: CLAIM_AT }]);
	assert.equal(written.length, 1, 'the upgrade patch is due as well — neither stands in for the other');
});

test('APPENDED path: the canary counts upgraded rows as COMPARED, so a mass change during an upgrade still trips', async () => {
	const fingerprint = await oldFingerprint();
	const urls = Array.from({ length: 10 }, (_, i) => `https://example.com/product/prd-${i}/`);
	const stored = {};
	const answers = {};
	for (const [i, url] of urls.entries()) {
		stored[url] = { signature: await signedBy(APPEND_OLD, OFFER), fingerprint };
		// 4 of 10 repriced in the old slots — a promotional step, in the middle of a rule edit.
		answers[url] = await signedBy(APPEND_NEW, i < 4 ? { ...OFFER, price: 19.99 } : OFFER);
	}
	const { stats } = await runAppendPass({ rows: urls.map((url) => row(url)), stored, answers, dryRun: true });
	assert.equal(stats.extended, 10);
	const verdict = changeProbe.canaryVerdict(stats, { threshold: 0.3, minSample: 10 });
	assert.deepEqual(verdict, { tripped: true, compared: 10, fraction: 0.4 });
});

test('a NON-append edit still re-baselines: reorder, removal, a changed path, or an append plus a header', async () => {
	const edits = {
		reorder: { ...APPEND_OLD, extract: ['sale', 'regular', 'price', 'variants[*].availability'] },
		removal: { ...APPEND_OLD, extract: ['regular', 'sale'] },
		changedPath: { ...APPEND_OLD, extract: ['regular', 'sale', 'listPrice', 'variants[*].availability'] },
		appendPlusHeader: { ...APPEND_NEW, request: { ...APPEND_NEW.request, headers: { accept: 'application/json' } } },
		appendPlusSignal: { ...APPEND_NEW, statusSignals: [] },
	};
	const fingerprint = await oldFingerprint();
	for (const [name, raw] of Object.entries(edits)) {
		const { stats, triggered } = await runAppendPass({
			rulesRaw: [raw],
			rows: [row(URL_A)],
			stored: { [URL_A]: { signature: await signedBy(APPEND_OLD, OFFER), fingerprint } },
			// A value change that WOULD trigger if the rows were (wrongly) compared.
			answers: { [URL_A]: await signedBy(raw, { ...OFFER, regular: 1, sale: 1, price: 1 }) },
		});
		assert.equal(stats.rebaselined, 1, `${name}: re-baselined`);
		assert.equal(stats.extended, 0, `${name}: not treated as an append`);
		assert.deepEqual(triggered, [], `${name}: nothing triggered`);
	}
});

test('APPENDED path: status-signal literals compare exactly as they always have', async () => {
	const fingerprint = await oldFingerprint();
	const { stats, triggered } = await runAppendPass({
		rows: [row(URL_A), row(URL_B), row(URL_C)],
		stored: {
			[URL_A]: { signature: 'unavailable', fingerprint }, // still sold out
			[URL_B]: { signature: 'unavailable', fingerprint }, // restocked
			[URL_C]: { signature: await signedBy(APPEND_OLD, OFFER), fingerprint }, // sold out
		},
		answers: {
			[URL_A]: 'unavailable',
			[URL_B]: await signedBy(APPEND_NEW, OFFER),
			[URL_C]: 'unavailable',
		},
	});
	assert.equal(stats.extended, 3);
	assert.equal(stats.unchanged, 1, 'the same literal is unchanged');
	assert.equal(stats.changed, 2, 'literal against values is a change, either way round');
	assert.deepEqual(triggered.sort(), [URL_B, URL_C].sort());
});

test('APPENDED path: old slots gone all-null beside a valid new slot is a CHANGE, not a failed probe', async () => {
	const fingerprint = await oldFingerprint();
	const observed = await signedBy(APPEND_NEW, { variants: [{ availability: 'In Stock' }] });
	assert.equal(await signedBy(APPEND_OLD, { variants: [{ availability: 'In Stock' }] }), null, 'control');
	const { stats, triggered } = await runAppendPass({
		rows: [row(URL_A)],
		stored: { [URL_A]: { signature: await signedBy(APPEND_OLD, OFFER), fingerprint } },
		answers: { [URL_A]: observed },
	});
	assert.equal(stats.failed, 0);
	assert.equal(stats.extended, 1);
	assert.equal(stats.changed, 1);
	assert.deepEqual(triggered, [URL_A]);
});

test('APPENDED path: a baseline without the shape the shorter rule writes re-baselines instead', async () => {
	// A stored fingerprint that matches a prefix but a signature the 3-path rule could never have
	// written (hash collision, a foreign row) must not be compared — comparing it would read as a
	// change on every such row.
	const fingerprint = await oldFingerprint();
	const { stats, triggered } = await runAppendPass({
		rows: [row(URL_A)],
		stored: { [URL_A]: { signature: '[1,2]', fingerprint } },
		answers: { [URL_A]: await signedBy(APPEND_NEW, OFFER) },
	});
	assert.equal(stats.rebaselined, 1);
	assert.equal(stats.extended, 0);
	assert.deepEqual(triggered, []);
});

// ---- the page record: mapped fields, caught-up changes, ignored slots, the mapping guard -----------

/**
 * A rule that maps four of its six slots to page facts and ignores one:
 *   0 title -> title (text)        1 seoUrl -> canonical (path)     2 image -> product.image (path)
 *   3 skus[*].{sku,availability,price} -> product.offers (skus)
 *   4 inventory — ignoreChanges    5 regular — unmapped, a change here always triggers
 * Stored and observed signatures are built with the real extraction, and records with the real
 * canonicalizer, so these exercise the strings production writes.
 */
const MAPPED_RULE = {
	label: 'pdp',
	pathPattern: '^/product/prd-([^/]+)',
	source: 'request',
	request: { urlTemplate: 'https://api.example.com/p/$1', method: 'POST', body: '{}' },
	extract: ['title', 'seoUrl', 'image', 'skus[*].{sku,availability,price}', 'inventory', 'regular'],
	statusSignals: [{ status: 404, contains: 'GONE', signature: 'unavailable' }],
	invalidateScope: 'route:prefix:/product/',
	pageCheck: {
		enabled: true,
		fields: [
			{ slot: 0, fact: 'title', compare: 'text' },
			{ slot: 1, fact: 'canonical', compare: 'path' },
			{ slot: 2, fact: 'product.image', compare: 'path' },
			{ slot: 3, fact: 'product.offers', compare: 'skus' },
		],
		ignoreChanges: [4],
	},
};
const API = (over = {}) => ({
	title: 'Red Shoe',
	seoUrl: '/product/prd-a/red-shoe.jsp',
	image: 'https://media.example.com/i/shoe?w=350',
	skus: [
		{ sku: '111', availability: 'In Stock', price: 19.99 },
		{ sku: '222', availability: 'Out of Stock', price: null },
	],
	inventory: 12,
	regular: 39.99,
	...over,
});
const apiSig = async (over, raw = MAPPED_RULE) => signedBy(raw, API(over));
const RECORD = async (over = {}) => {
	const { canonicalPageFacts } = await import('../src/util/changeProbeSpec.js');
	return JSON.stringify(
		canonicalPageFacts({
			canonical: 'https://www.example.com/product/prd-a/red-shoe.jsp',
			title: 'Red Shoe',
			product: {
				image: 'https://media.example.com/i/shoe?w=1000',
				offers: [
					['111', '19.99', 'USD', 'InStock'],
					['222', null, 'USD', 'OutOfStock'],
				],
			},
			...over,
		})
	);
};
// A WITNESSED record: rendered (2000) after the baseline was taken (1000).
const BASELINE_AT = 1000;
const RENDERED_AT = new Date(2000);

const guardFor = (settings = { threshold: 0.2, minWitnessed: 10 }) => {
	const disarmed = [];
	const guard = changeProbe.createMappingGuard({
		settings: () => settings,
		onDisarm: (rule, field, entry) => disarmed.push({ rule: rule.label, field: field.label, ...entry }),
	});
	return { guard, disarmed };
};

const runMappedPass = async ({ rulesRaw = [MAPPED_RULE], rows, answers, stored = {}, ...overrides }) => {
	const { compileProbeRules } = await import('../src/util/changeProbeSpec.js');
	const { createInlineTrigger } = await import('../src/util/triggerQueue.js');
	const rules = compileProbeRules(rulesRaw);
	const written = [];
	const triggered = [];
	const verified = [];
	const write = async (url, signature, options = {}) => written.push({ url, signature, ...options });
	const triggers = createInlineTrigger({ trigger: async (target) => triggered.push(target.url), write });
	const stats = await changeProbe.runProbePass({
		rows: stream(rows),
		rules,
		ownerOf: () => 'node-a',
		hostname: 'node-a',
		probe: async (rule, url) => answers[url] ?? null,
		// Steady state by default: the stored fingerprint is the rule's own, so nothing is stamped.
		read: async (url) =>
			stored[url]
				? {
						probedAt: BASELINE_AT,
						pageSignature: null,
						pageClaimAt: RENDERED_AT,
						pageFacts: null,
						fingerprint: rules[0].fingerprint,
						...stored[url],
					}
				: null,
		write,
		submitTrigger: triggers.submit,
		verify: async (url, basisAt) => verified.push({ url, basisAt }),
		isArmed: async () => false,
		dryRun: false,
		maxTriggers: 1000,
		concurrency: 1,
		ratePerSecond: 1000,
		pause: async () => {},
		...overrides,
	});
	await triggers.drain();
	stats.triggered = triggers.stats.triggered;
	assertInvariant(stats);
	return { stats, written, triggered, verified, rules };
};

test('MAPPED FIELD: the page disagrees with an UNCHANGED origin -> trigger, counted per field, record cleared', async () => {
	const signature = await apiSig();
	const { stats, triggered, written } = await runMappedPass({
		rows: [row(URL_A)],
		answers: { [URL_A]: signature },
		stored: { [URL_A]: { signature, pageFacts: await RECORD({ title: 'Red Shoe (Old Name)' }) } },
	});
	assert.deepEqual(triggered, [URL_A]);
	assert.equal(stats.unchanged, 1, 'the origin did not change — the bucket says so');
	assert.equal(stats.pageMismatch, 1);
	assert.deepEqual(stats.fieldMismatch, { pdp: { '0:title': 1 } }, 'decomposed by field');
	assert.deepEqual(stats.slotChanges, {}, 'no origin change to decompose');
	assert.equal(written[0].clearClaim, true, 'the trigger clears the record with the claim');
});

test('the same page AGREEING on every mapped field -> unchanged, nothing triggered, nothing written', async () => {
	const signature = await apiSig();
	const { stats, triggered, written } = await runMappedPass({
		rows: [row(URL_A)],
		answers: { [URL_A]: signature },
		stored: { [URL_A]: { signature, pageFacts: await RECORD() } },
	});
	assert.deepEqual(triggered, []);
	assert.deepEqual(written, [], 'a converged corpus still pays no write per probe');
	assert.equal(stats.pageMismatch, 0);
	assert.deepEqual(stats.fieldMismatch, {});
});

test('CAUGHT UP: the origin changed and the page ALREADY shows the new value -> baseline moves, nothing triggered', async () => {
	// A cadence render landed after the rename: re-rendering again would buy nothing.
	const before = await apiSig();
	const after = await apiSig({ title: 'Red Running Shoe' });
	const { stats, triggered, written } = await runMappedPass({
		rows: [row(URL_A)],
		answers: { [URL_A]: after },
		stored: { [URL_A]: { signature: before, pageFacts: await RECORD({ title: 'Red Running Shoe' }) } },
	});
	assert.deepEqual(triggered, []);
	assert.equal(stats.changed, 1, 'still a change — for the canary, the rest of the corpus has not caught up');
	assert.equal(stats.caughtUp, 1);
	assert.deepEqual(stats.slotChanges, { pdp: { 0: 1 } });
	assert.equal(written.length, 1);
	assert.equal(written[0].signature, after, 'the new baseline, so the next pass compares against it');
	assert.equal(written[0].rowExists, true);
	assert.notEqual(written[0].clearClaim, true, 'nothing was expired, so the record stands');
});

test('a change the page has NOT caught up with triggers — and is a page mismatch too', async () => {
	const { stats, triggered } = await runMappedPass({
		rows: [row(URL_A)],
		answers: { [URL_A]: await apiSig({ title: 'Red Running Shoe' }) },
		stored: { [URL_A]: { signature: await apiSig(), pageFacts: await RECORD() } },
	});
	assert.deepEqual(triggered, [URL_A]);
	assert.equal(stats.caughtUp, 0);
	assert.equal(stats.changed, 1);
	assert.deepEqual(stats.fieldMismatch, { pdp: { '0:title': 1 } });
});

test('a change in an UNMAPPED slot triggers exactly as before, even when every mapped field agrees', async () => {
	const { stats, triggered } = await runMappedPass({
		rows: [row(URL_A)],
		answers: { [URL_A]: await apiSig({ regular: 34.99 }) },
		stored: { [URL_A]: { signature: await apiSig(), pageFacts: await RECORD() } },
	});
	assert.deepEqual(triggered, [URL_A]);
	assert.equal(stats.caughtUp, 0);
	assert.deepEqual(stats.slotChanges, { pdp: { 5: 1 } });
	// ...and a change spanning a caught-up slot AND an unmapped one still triggers.
	const both = await runMappedPass({
		rows: [row(URL_A)],
		answers: { [URL_A]: await apiSig({ title: 'Red Running Shoe', regular: 34.99 }) },
		stored: { [URL_A]: { signature: await apiSig(), pageFacts: await RECORD({ title: 'Red Running Shoe' }) } },
	});
	assert.deepEqual(both.triggered, [URL_A]);
	assert.equal(both.stats.caughtUp, 0);
});

test('a change in a mapped slot with NO page record (or a record that cannot compare) triggers — no evidence, no suppression', async () => {
	for (const pageFacts of [null, await RECORD({ title: null }), '{corrupt']) {
		const { stats, triggered } = await runMappedPass({
			rows: [row(URL_A)],
			answers: { [URL_A]: await apiSig({ title: 'Red Running Shoe' }) },
			stored: { [URL_A]: { signature: await apiSig(), pageFacts } },
		});
		assert.deepEqual(triggered, [URL_A], `record ${pageFacts}`);
		assert.equal(stats.caughtUp, 0);
		assert.equal(stats.pageMismatch, 0, 'and no claim is not a mismatch');
	}
});

test('skus: a changed SKU the page does not list is NOT caught up, even though every listed SKU agrees', async () => {
	const skus = (price) => [
		{ sku: '111', availability: 'In Stock', price: 19.99 },
		{ sku: '999', availability: 'In Stock', price }, // beyond the page's truncated offer list
	];
	const { triggered, stats } = await runMappedPass({
		rows: [row(URL_A)],
		answers: { [URL_A]: await apiSig({ skus: skus(4) }) },
		stored: { [URL_A]: { signature: await apiSig({ skus: skus(5) }), pageFacts: await RECORD() } },
	});
	assert.deepEqual(triggered, [URL_A], 'swallowing this change is the failure caught-up must not have');
	assert.equal(stats.caughtUp, 0);
	assert.equal(stats.pageMismatch, 0, 'the SKUs both sides list agree — the page is not wrong where it can be checked');
	// A repriced SKU the page DOES list, already showing the new price: caught up.
	const listed = await runMappedPass({
		rows: [row(URL_A)],
		answers: { [URL_A]: await apiSig() },
		stored: {
			[URL_A]: {
				signature: await apiSig({ skus: [{ sku: '111', availability: 'In Stock', price: 21.99 }, API().skus[1]] }),
				pageFacts: await RECORD(),
			},
		},
	});
	assert.deepEqual(listed.triggered, []);
	assert.equal(listed.stats.caughtUp, 1);
});

test('IGNORED: a change confined to ignoreChanges writes the baseline, triggers nothing, and is NOT a change for the canary', async () => {
	const rows = [];
	const answers = {};
	const stored = {};
	for (let i = 0; i < 10; i++) {
		const url = `https://example.com/product/prd-${i}/`;
		rows.push(row(url));
		answers[url] = await apiSig({ inventory: 11 - i });
		stored[url] = { signature: await apiSig(), pageFacts: null };
	}
	const { stats, triggered, written } = await runMappedPass({ rows, answers, stored });
	assert.deepEqual(triggered, []);
	assert.equal(stats.ignored, 10);
	assert.equal(stats.unchanged, 10, 'bucketed unchanged: for mass-change detection it is not a change');
	assert.equal(stats.changed, 0);
	assert.deepEqual(stats.slotChanges, { pdp: { 4: 10 } }, 'but still counted per slot');
	assert.equal(written.length, 10, 'each baseline moves, so the next pass compares against the new value');
	// THE CANARY: a site-wide edit of an ignored field must not trip a route-wide invalidation.
	assert.equal(changeProbe.canaryVerdict(stats, { threshold: 0.1, minSample: 5 }).tripped, false);
	// Control: the same volume of change in a slot that is NOT ignored trips it.
	for (const url of Object.keys(answers)) answers[url] = await apiSig({ regular: 1 });
	const control = await runMappedPass({ rows, answers, stored });
	assert.equal(control.stats.changed, 10);
	assert.equal(changeProbe.canaryVerdict(control.stats, { threshold: 0.1, minSample: 5 }).tripped, true);
});

test('ignored + caught up together: nothing triggers; ignored + unmapped: triggers', async () => {
	const quiet = await runMappedPass({
		rows: [row(URL_A)],
		answers: { [URL_A]: await apiSig({ title: 'Red Running Shoe', inventory: 3 }) },
		stored: { [URL_A]: { signature: await apiSig(), pageFacts: await RECORD({ title: 'Red Running Shoe' }) } },
	});
	assert.deepEqual(quiet.triggered, []);
	assert.equal(quiet.stats.caughtUp, 1);
	assert.equal(quiet.stats.ignored, 0, 'not ignored-only: the title changed too');
	const loud = await runMappedPass({
		rows: [row(URL_A)],
		answers: { [URL_A]: await apiSig({ regular: 1, inventory: 3 }) },
		stored: { [URL_A]: { signature: await apiSig(), pageFacts: await RECORD() } },
	});
	assert.deepEqual(loud.triggered, [URL_A]);
});

test('a status-signal literal transition is never ignored or caught up — it is a state, not slots', async () => {
	const { stats, triggered } = await runMappedPass({
		rows: [row(URL_A)],
		answers: { [URL_A]: 'unavailable' },
		stored: { [URL_A]: { signature: await apiSig(), pageFacts: await RECORD() } },
	});
	assert.deepEqual(triggered, [URL_A]);
	assert.deepEqual(stats.slotChanges, { pdp: { signal: 1 } });
	assert.equal(stats.pageMismatch, 0, 'a literal carries no values to compare');
});

test('APPENDED path (#206) rows: a mapped disagreement triggers and a caught-up change is absorbed and upgraded', async () => {
	const { compileProbeRules } = await import('../src/util/changeProbeSpec.js');
	const OLD = { ...MAPPED_RULE, extract: MAPPED_RULE.extract.slice(0, 5), pageCheck: undefined };
	const oldFp = compileProbeRules([OLD])[0].fingerprint;
	const { guard } = guardFor({ threshold: 0, minWitnessed: 1 }); // disarms on its first witness
	// Unchanged prefix, page wrong on a mapped field -> trigger.
	const wrong = await runMappedPass({
		rows: [row(URL_A)],
		answers: { [URL_A]: await apiSig() },
		stored: {
			[URL_A]: { signature: await apiSig({}, OLD), fingerprint: oldFp, pageFacts: await RECORD({ title: 'Old' }) },
		},
		guard,
	});
	assert.equal(wrong.stats.extended, 1);
	assert.deepEqual(wrong.triggered, [URL_A]);
	// An appended-path row is never WITNESSED: its new slots have no baseline to be unchanged against.
	assert.equal(wrong.stats.fieldGuard.pdp['0:title'].witnessed, 0);
	// Changed old slot the page already shows -> caught up, and the write upgrades the baseline.
	const caught = await runMappedPass({
		rows: [row(URL_A)],
		answers: { [URL_A]: await apiSig({ title: 'Red Running Shoe' }) },
		stored: {
			[URL_A]: {
				signature: await apiSig({}, OLD),
				fingerprint: oldFp,
				pageFacts: await RECORD({ title: 'Red Running Shoe' }),
			},
		},
	});
	assert.equal(caught.stats.extended, 1);
	assert.equal(caught.stats.caughtUp, 1);
	assert.deepEqual(caught.triggered, []);
	assert.equal(caught.written[0].signature, await apiSig({ title: 'Red Running Shoe' }), 'the full observation');
	assert.equal(caught.written[0].fingerprint, caught.rules[0].fingerprint, 'under the current fingerprint');
});

test('MAPPING GUARD: a broken mapping is DISARMED after minWitnessed and stops triggering; it still counts', async () => {
	const { guard, disarmed } = guardFor({ threshold: 0.2, minWitnessed: 10 });
	const rows = [];
	const answers = {};
	const stored = {};
	const signature = await apiSig();
	for (let i = 0; i < 30; i++) {
		const url = `https://example.com/product/prd-${i}/`;
		rows.push(row(url));
		answers[url] = signature;
		// Every page "disagrees" on the title: the slot is mapped to the wrong fact.
		stored[url] = { signature, pageFacts: await RECORD({ title: 'Acme' }) };
	}
	const { stats, triggered } = await runMappedPass({ rows, answers, stored, guard });
	// Witness 10 crosses the threshold and is itself not acted on; 1-9 each re-rendered a page.
	assert.equal(triggered.length, 9, 'a corpus-wide broken mapping costs ~minWitnessed renders, not the corpus');
	assert.equal(stats.pageMismatch, 9, 'pageMismatch counts only the actionable (armed) disagreements');
	assert.deepEqual(stats.fieldMismatch, { pdp: { '0:title': 30 } }, 'a disarmed field is still counted');
	assert.deepEqual(
		disarmed.map((d) => [d.rule, d.field, d.witnessed, d.disagreed]),
		[['pdp', '0:title', 10, 10]]
	);
	assert.deepEqual(stats.fieldGuard.pdp['0:title'], { witnessed: 30, disagreed: 30, armed: false });
	assert.deepEqual(
		stats.fieldGuard.pdp['1:canonical'],
		{ witnessed: 30, disagreed: 0, armed: true },
		'siblings unaffected'
	);
});

test('MAPPING GUARD: rare round trips never disarm — and each one re-renders', async () => {
	const { guard, disarmed } = guardFor({ threshold: 0.2, minWitnessed: 20 });
	const rows = [];
	const answers = {};
	const stored = {};
	const signature = await apiSig();
	for (let i = 0; i < 100; i++) {
		const url = `https://example.com/product/prd-${i}/`;
		rows.push(row(url));
		answers[url] = signature;
		// 2% of pages caught a transient value mid-flip: the genuine round-trip case.
		stored[url] = { signature, pageFacts: await RECORD(i % 50 === 7 ? { title: 'Red Shoe — Sale' } : {}) };
	}
	const { stats, triggered } = await runMappedPass({ rows, answers, stored, guard });
	assert.equal(triggered.length, 2, 'an individual witnessed disagreement is NEVER suppressed');
	assert.deepEqual(disarmed, []);
	assert.deepEqual(stats.fieldGuard.pdp['0:title'], { witnessed: 100, disagreed: 2, armed: true });
});

test('MAPPING GUARD: the rate is RECENT — a mapping right for a long time and then broken is still disarmed promptly', async () => {
	const { guard, disarmed } = guardFor({ threshold: 0.2, minWitnessed: 10 }); // memory ~100 comparisons
	const rule = { label: 'pdp', extract: ['title'] };
	const title = { slot: 0, fact: 'title', compare: 'text', options: {}, label: '0:title' };
	// A week of agreement...
	for (let i = 0; i < 100_000; i++) guard.witness(rule, title, false);
	assert.equal(guard.isArmed(rule, title), true);
	// ...then the site changes its title template and every re-render disagrees.
	let spent = 0;
	while (guard.isArmed(rule, title) && spent < 1000) {
		guard.witness(rule, title, true);
		spent++;
	}
	assert.equal(disarmed.length, 1);
	assert.ok(spent < 60, `disarmed after ${spent} disagreements, not after outweighing 100,000 agreements`);
	// The halved sample never drops below minWitnessed, and a disarm is sticky.
	for (let i = 0; i < 1000; i++) guard.witness(rule, title, false);
	assert.equal(guard.isArmed(rule, title), false, 'only a mapping edit or a restart re-arms');
	// A correct mapping at a steady 2% never trips however long it runs.
	const { guard: steady } = guardFor({ threshold: 0.2, minWitnessed: 10 });
	for (let i = 0; i < 100_000; i++) steady.witness(rule, title, i % 50 === 0);
	assert.equal(steady.isArmed(rule, title), true);
});

test('MAPPING GUARD: only WITNESSED comparisons count — a record older than the baseline proves nothing', async () => {
	const { guard, disarmed } = guardFor({ threshold: 0.2, minWitnessed: 10 });
	const rows = [];
	const answers = {};
	const stored = {};
	const signature = await apiSig();
	for (let i = 0; i < 30; i++) {
		const url = `https://example.com/product/prd-${i}/`;
		rows.push(row(url));
		answers[url] = signature;
		// Rendered BEFORE the baseline was taken: the page may simply predate the current value.
		stored[url] = { signature, pageFacts: await RECORD({ title: 'Acme' }), pageClaimAt: new Date(500) };
	}
	const { triggered, stats } = await runMappedPass({ rows, answers, stored, guard });
	assert.equal(triggered.length, 30);
	assert.deepEqual(disarmed, []);
	assert.equal(stats.fieldGuard.pdp['0:title'].witnessed, 0);
	// A CHANGED origin is not witnessed either (the page cannot be expected to show a value it predates).
	const changed = await runMappedPass({
		rows: [row(URL_A)],
		answers: { [URL_A]: await apiSig({ title: 'New' }) },
		stored: { [URL_A]: { signature, pageFacts: await RECORD({ title: 'Acme' }) } },
		guard,
	});
	assert.equal(changed.stats.fieldGuard.pdp['0:title'].witnessed, 0);
});

test('MAPPING GUARD: a disarmed field no longer vouches for a caught-up change — the change triggers', async () => {
	const { guard } = guardFor({ threshold: 0.2, minWitnessed: 1 });
	const signature = await apiSig();
	await runMappedPass({
		rows: [row(URL_A)],
		answers: { [URL_A]: signature },
		stored: { [URL_A]: { signature, pageFacts: await RECORD({ title: 'Acme' }) } },
		guard,
	});
	const { triggered, stats } = await runMappedPass({
		rows: [row(URL_B)],
		answers: { [URL_B]: await apiSig({ title: 'Red Running Shoe' }) },
		stored: { [URL_B]: { signature, pageFacts: await RECORD({ title: 'Red Running Shoe' }) } },
		guard,
	});
	assert.deepEqual(triggered, [URL_B]);
	assert.equal(stats.caughtUp, 0);
});

test('MAPPING GUARD: stays disarmed across a reload of the SAME mapping, re-arms when the mapping changes', async () => {
	const { guard } = guardFor({ threshold: 0.2, minWitnessed: 1 });
	const signature = await apiSig();
	const broken = { [URL_A]: { signature, pageFacts: await RECORD({ title: 'Acme' }) } };
	await runMappedPass({ rows: [row(URL_A)], answers: { [URL_A]: signature }, stored: broken, guard });
	// A config reload compiles NEW field objects for the same mapping: still disarmed.
	const reloaded = await runMappedPass({ rows: [row(URL_A)], answers: { [URL_A]: signature }, stored: broken, guard });
	assert.equal(reloaded.stats.fieldGuard.pdp['0:title'].armed, false);
	assert.deepEqual(reloaded.triggered, []);
	// The operator fixes the mapping (slot 0 now compares against h1): a new key, a clean record.
	const fixed = {
		...MAPPED_RULE,
		pageCheck: {
			...MAPPED_RULE.pageCheck,
			fields: [{ slot: 0, fact: 'h1', compare: 'text' }, ...MAPPED_RULE.pageCheck.fields.slice(1)],
		},
	};
	const after = await runMappedPass({
		rulesRaw: [fixed],
		rows: [row(URL_A)],
		answers: { [URL_A]: signature },
		stored: { [URL_A]: { signature, pageFacts: await RECORD({ title: 'Acme', h1: 'Red Shoe' }) } },
		guard,
	});
	assert.equal(after.stats.fieldGuard.pdp['0:h1'].armed, true);
	assert.deepEqual(after.triggered, []);
});

test('MAPPING GUARD in DRY RUN: counts and disarms (the dry-run week finds a broken mapping), triggers nothing', async () => {
	const { guard, disarmed } = guardFor({ threshold: 0.2, minWitnessed: 5 });
	const rows = [];
	const answers = {};
	const stored = {};
	const signature = await apiSig();
	for (let i = 0; i < 8; i++) {
		const url = `https://example.com/product/prd-${i}/`;
		rows.push(row(url));
		answers[url] = signature;
		stored[url] = { signature, pageFacts: await RECORD({ title: 'Acme' }) };
	}
	const { triggered, written } = await runMappedPass({ rows, answers, stored, guard, dryRun: true });
	assert.deepEqual(triggered, []);
	assert.equal(disarmed.length, 1);
	assert.ok(
		written.every((w) => w.clearClaim !== true),
		'dry run never clears the record'
	);
});

test('the process guard WARNS loudly on disarm, naming the rule, the field and its extract path', async (t) => {
	const { applyOptions } = await import('../src/config.js');
	t.after(() => applyOptions({}));
	applyOptions({ changeProbe: { mappingGuard: { threshold: 0.5, minWitnessed: 2 } } });
	const warns = [];
	globalThis.logger.warn = (message) => warns.push(message);
	const { compileProbeRules } = await import('../src/util/changeProbeSpec.js');
	const [rule] = compileProbeRules([MAPPED_RULE]);
	// The same factory the sweep uses, with the live config and the real warning.
	const signature = await apiSig();
	const guard = changeProbe.__mappingGuardForTest();
	for (const url of [URL_A, URL_B]) {
		await changeProbe.runProbePass({
			rows: stream([row(url)]),
			rules: [rule],
			ownerOf: () => 'node-a',
			hostname: 'node-a',
			probe: async () => signature,
			read: async () => ({
				signature,
				probedAt: BASELINE_AT,
				pageClaimAt: RENDERED_AT,
				pageFacts: await RECORD({ title: 'Acme' }),
				fingerprint: rule.fingerprint,
			}),
			write: async () => {},
			submitTrigger: async () => 'queued',
			guard,
			dryRun: true,
			maxTriggers: 10,
			concurrency: 1,
			ratePerSecond: 1000,
			pause: async () => {},
		});
	}
	assert.equal(warns.length, 1);
	assert.match(
		warns[0],
		/change-probe pdp: pageCheck field 0:title \(extract\[0\] "title", compare text\) is DISARMED/
	);
	assert.match(warns[0], /2 of 2 recent witnessed comparisons \(100\.0%\)/);
});

test('verification: a pair+fields rule verifies only when NO armed mapped field disagrees', async () => {
	const PAIRED = {
		...MAPPED_RULE,
		extract: [...MAPPED_RULE.extract, 'price', 'available'],
		pageCheck: { ...MAPPED_RULE.pageCheck, priceFrom: 6, availableFrom: 7 },
	};
	const json = { ...API(), price: 19.99, available: true };
	const signature = await signedBy(PAIRED, json);
	const claim = JSON.stringify([['19.99'], true]);
	const armedPass = (pageFacts) =>
		runMappedPass({
			rulesRaw: [PAIRED],
			rows: [row(URL_A)],
			answers: { [URL_A]: signature },
			stored: { [URL_A]: { signature, pageSignature: claim, pageFacts } },
			isArmed: async () => true,
		});
	const agreeing = await armedPass(await RECORD());
	assert.deepEqual(
		agreeing.verified.map((v) => v.url),
		[URL_A]
	);
	const wrong = await armedPass(await RECORD({ title: 'Acme' }));
	assert.deepEqual(wrong.verified, [], 'a page wrong on a mapped field is never certified');
	assert.deepEqual(wrong.triggered, [URL_A]);
	// No record (older renderer): the claim pair alone certifies, exactly as before fields existed.
	const noRecord = await armedPass(null);
	assert.deepEqual(
		noRecord.verified.map((v) => v.url),
		[URL_A]
	);
});

test('verification: a fields-only rule needs an armed mapped field that AGREED — no record, no proof', async () => {
	const signature = await apiSig();
	const pass = (storedRow, answer = signature) =>
		runMappedPass({
			rows: [row(URL_A)],
			answers: { [URL_A]: answer },
			stored: { [URL_A]: storedRow },
			isArmed: async () => true,
		});
	assert.deepEqual(
		(await pass({ signature, pageFacts: await RECORD() })).verified.map((v) => v.url),
		[URL_A]
	);
	assert.deepEqual((await pass({ signature, pageFacts: null })).verified, [], 'nothing was compared');
	// An ignored change: the page's visible fields did not move, and they agree — verified.
	const ignored = await pass({ signature, pageFacts: await RECORD() }, await apiSig({ inventory: 1 }));
	assert.equal(ignored.stats.ignored, 1);
	assert.deepEqual(
		ignored.verified.map((v) => v.url),
		[URL_A]
	);
	// A caught-up change: the baseline just moved — verified on the next pass, not this one.
	const caught = await pass({ signature, pageFacts: await RECORD({ title: 'New' }) }, await apiSig({ title: 'New' }));
	assert.equal(caught.stats.caughtUp, 1);
	assert.deepEqual(caught.verified, []);
});

test('dry run: a caught-up change still moves the baseline; a mapped mismatch writes without clearing the record', async () => {
	const caught = await runMappedPass({
		rows: [row(URL_A)],
		answers: { [URL_A]: await apiSig({ title: 'New' }) },
		stored: { [URL_A]: { signature: await apiSig(), pageFacts: await RECORD({ title: 'New' }) } },
		dryRun: true,
	});
	assert.equal(caught.written.length, 1);
	assert.equal(caught.stats.caughtUp, 1);
	const signature = await apiSig();
	const wrong = await runMappedPass({
		rows: [row(URL_A)],
		answers: { [URL_A]: signature },
		stored: { [URL_A]: { signature, pageFacts: await RECORD({ title: 'Acme' }) } },
		dryRun: true,
	});
	assert.deepEqual(wrong.triggered, []);
	assert.equal(wrong.stats.pageMismatch, 1);
	assert.equal(wrong.written.length, 1);
	assert.notEqual(wrong.written[0].clearClaim, true);
});

test('slotChanges decomposes changed by slot for EVERY rule — a rule with no pageCheck too', async () => {
	const { stats } = await runPass({
		rows: [row(URL_A), row(URL_B)],
		answers: { [URL_A]: JSON.stringify([2]), [URL_B]: JSON.stringify([1]) },
		stored: { [URL_A]: JSON.stringify([1]), [URL_B]: JSON.stringify([1]) },
	});
	assert.equal(stats.changed, 1);
	assert.deepEqual(stats.slotChanges, { pdp: { 0: 1 } });
	assert.equal(stats.fieldGuard, undefined, 'no mapped fields, no guard snapshot');
});

// ---- recordPageClaim: the page record -------------------------------------------------------------

const mappedClaimHarness = async ({ existing = null, pageCheck } = {}) => {
	const { applyOptions } = await import('../src/config.js');
	applyOptions({
		changeProbe: {
			enabled: true,
			rules: [
				{
					label: 'pdp',
					pathPattern: '^/product/prd-',
					source: 'request',
					request: { urlTemplate: 'https://api.example.com/x', method: 'POST', body: '{}' },
					extract: ['title', 'b', 'price', 'available'],
					pageCheck: pageCheck ?? {
						enabled: true,
						priceFrom: 2,
						availableFrom: 3,
						fields: [{ slot: 0, fact: 'title', compare: 'text' }],
					},
				},
			],
		},
	});
	const calls = { get: [], put: [], patch: [] };
	globalThis.databases.probe_state.ProbeState = {
		async get(query) {
			calls.get.push(query);
			return existing;
		},
		async put(id, row) {
			calls.put.push({ id, row });
		},
		async patch(id, patch) {
			calls.patch.push({ id, patch });
		},
	};
	return calls;
};
const FACTS_IN = { title: 'Red Shoe', h1: 'Red Shoe', product: { offers: [['1', '35.99', 'USD', 'InStock']] } };

test('recordPageClaim stores the canonical page record in the SAME write as the claim and its stamp', async (t) => {
	t.after(restoreConfig);
	const calls = await mappedClaimHarness({ existing: { url: CLAIM_URL } });
	await changeProbe.recordPageClaim(CLAIM_URL, ['35.99', 'USD', 'InStock'], 1_700_000_000_000, { pageFacts: FACTS_IN });
	const { canonicalPageFacts } = await import('../src/util/changeProbeSpec.js');
	assert.equal(calls.put.length, 0);
	assert.equal(calls.patch.length, 1, 'one write — no extra read or write for the record');
	assert.deepEqual(calls.patch[0].patch, {
		pageSignature: JSON.stringify([['35.99'], true]),
		pageFacts: JSON.stringify(canonicalPageFacts(FACTS_IN)),
		pageClaimAt: new Date(1_700_000_000_000),
	});
	// A missing row is seeded with put, record included.
	const seeded = await mappedClaimHarness();
	await changeProbe.recordPageClaim(CLAIM_URL, null, 1_700_000_000_000, { pageFacts: FACTS_IN });
	assert.equal(seeded.put.length, 1);
	assert.equal(seeded.put[0].row.pageFacts, JSON.stringify(canonicalPageFacts(FACTS_IN)));
	assert.equal(
		seeded.put[0].row.pageSignature,
		null,
		'the page declared no offers: no claim, and the record still stands'
	);
});

test('recordPageClaim: ABSENT pageFacts is an old renderer — warn hourly, and the record is stored EMPTY', async (t) => {
	t.after(restoreConfig);
	const calls = await mappedClaimHarness({ existing: { url: CLAIM_URL } });
	const warns = [];
	globalThis.logger.warn = (message) => warns.push(message);
	await changeProbe.recordPageClaim(CLAIM_URL, ['35.99', 'USD', 'InStock'], 1_700_000_000_000);
	await changeProbe.recordPageClaim(CLAIM_URL, ['35.99', 'USD', 'InStock'], 1_700_000_000_000);
	assert.equal(warns.length, 1, 'throttled');
	assert.match(warns[0], /older than @harperfast\/prerender-browser 1\.37\.0/);
	// Null, not left alone: the row's older record describes a page this render just replaced.
	assert.equal(calls.patch[0].patch.pageFacts, null);
	assert.equal(calls.patch[0].patch.pageSignature, JSON.stringify([['35.99'], true]), 'the claim is recorded as ever');
	// On a missing row with nothing to record, no row is created at all.
	const empty = await mappedClaimHarness();
	await changeProbe.recordPageClaim(CLAIM_URL, null, 1_700_000_000_000);
	assert.equal(empty.put.length + empty.patch.length, 0);
});

test('recordPageClaim: NULL pageFacts means the extraction ran and found nothing — silent, stored null', async (t) => {
	t.after(restoreConfig);
	const calls = await mappedClaimHarness({ existing: { url: CLAIM_URL } });
	const warns = [];
	globalThis.logger.warn = (message) => warns.push(message);
	await changeProbe.recordPageClaim(CLAIM_URL, ['35.99', 'USD', 'InStock'], 1_700_000_000_000, { pageFacts: null });
	assert.equal(warns.length, 0);
	assert.equal(calls.patch[0].patch.pageFacts, null);
});

test('recordPageClaim REFUSES an oversized record (stored null, warned), never truncates it', async (t) => {
	t.after(restoreConfig);
	const calls = await mappedClaimHarness({ existing: { url: CLAIM_URL } });
	const warns = [];
	globalThis.logger.warn = (message) => warns.push(message);
	const huge = { title: 'x', breadcrumbs: Array.from({ length: 30 }, () => 'y'.repeat(2000)) };
	await changeProbe.recordPageClaim(CLAIM_URL, null, 1_700_000_000_000, { pageFacts: huge });
	assert.equal(calls.patch[0].patch.pageFacts, null);
	assert.match(warns[0], /over the 16384-byte bound — not stored/);
});

test('recordPageClaim: a render that did not store EVERY default device records no facts', async (t) => {
	t.after(restoreConfig);
	const calls = await mappedClaimHarness({ existing: { url: CLAIM_URL } });
	await changeProbe.recordPageClaim(CLAIM_URL, ['35.99', 'USD', 'InStock'], 1_700_000_000_000, {
		pageFacts: FACTS_IN,
		complete: false,
	});
	assert.equal(calls.patch[0].patch.pageFacts, null, 'the other device page is older than this record would claim');
});

test('recordPageClaim: a fields-only rule records the page record and no claim; a pair-only rule no record', async (t) => {
	t.after(restoreConfig);
	const warns = [];
	const fieldsOnly = await mappedClaimHarness({
		existing: { url: CLAIM_URL },
		pageCheck: { enabled: true, fields: [{ slot: 0, fact: 'title', compare: 'text' }] },
	});
	globalThis.logger.warn = (message) => warns.push(message);
	await changeProbe.recordPageClaim(CLAIM_URL, undefined, 1_700_000_000_000, { pageFacts: FACTS_IN });
	assert.equal(fieldsOnly.patch[0].patch.pageSignature, null);
	assert.ok(fieldsOnly.patch[0].patch.pageFacts);
	assert.deepEqual(warns, [], 'no claim pair, so an old structuredOffers-less renderer is not its concern');
	// A rule with only the claim pair behaves exactly as before: no record, and no write at all
	// when the render yields no claim.
	const pairOnly = await mappedClaimHarness({
		existing: { url: CLAIM_URL },
		pageCheck: { enabled: true, priceFrom: 2, availableFrom: 3 },
	});
	await changeProbe.recordPageClaim(CLAIM_URL, ['35.99', 'USD', 'InStock'], 1_700_000_000_000, { pageFacts: FACTS_IN });
	assert.deepEqual(Object.keys(pairOnly.patch[0].patch).sort(), ['pageClaimAt', 'pageSignature']);
	await changeProbe.recordPageClaim(CLAIM_URL, null, 1_700_000_000_000, { pageFacts: FACTS_IN });
	assert.equal(pairOnly.patch.length, 1, 'no claim, no write — exactly as before fields existed');
});

test('changeProbeStatus names a rule’s mapped fields and ignored slots only when it has them', async (t) => {
	t.after(restoreConfig);
	await mappedClaimHarness({
		pageCheck: { enabled: true, fields: [{ slot: 0, fact: 'title', compare: 'text' }], ignoreChanges: [1] },
	});
	const status = await changeProbe.changeProbeStatus();
	assert.deepEqual(status.rules[0].pageFields, ['0:title:text']);
	assert.deepEqual(status.rules[0].ignoreChanges, [1]);
	await mappedClaimHarness({ pageCheck: { enabled: true, priceFrom: 2, availableFrom: 3 } });
	const plain = await changeProbe.changeProbeStatus();
	// The optional pageCheck keys are absent; the identity keys (v0.91.0) are always there.
	assert.deepEqual(Object.keys(plain.rules[0]).sort(), [
		'endpoint',
		'extract',
		'fingerprint',
		'invalidateScope',
		'label',
		'pathPattern',
		'source',
	]);
});

// ---- what the probe is doing NOW (plugin v0.91.0) -------------------------------------------------

/**
 * The admin surface used to answer "what is the probe doing" with the LAST pass that ended, beside a
 * bare `running: true` — for the ~9 hours an anchored pass runs, every number on it was yesterday's.
 * These pin the running pass's own identity and counters, the next scheduled run from ANY worker,
 * and #176: `nextAnchoredRunAt` read null right after arming, on every node, because it was module
 * state on worker 0 and the one publish ran before the anchor was armed.
 */

const flushTurns = async (n = 30) => {
	for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
};

/**
 * A registry the real walk can page through: `search` honours the cursor condition and limit, and
 * `hold(index)` can block before handing over a row — which is how a test catches a pass mid-flight.
 */
const walkableTargets = (urls, { hold = () => null } = {}) => {
	const sorted = [...urls].sort();
	return class WalkableTargets {
		static async get() {}
		static search({ conditions = [], limit = Infinity } = {}) {
			return (async function* () {
				const [cursor] = conditions;
				let yielded = 0;
				for (const [index, url] of sorted.entries()) {
					if (cursor && !(cursor.comparator === 'greater_than_equal' ? url >= cursor.value : url > cursor.value)) {
						continue;
					}
					if (yielded >= limit) return;
					await hold(index);
					yield { url, sitemapUrl: null, renderInterval: null, state: null, unlistedAt: null };
					yielded++;
				}
			})();
		}
	};
};

// Rows no rule matches: the walk examines them (and heartbeats over them) without a single origin
// request, which is what lets a whole pass run here with no network.
const unmatchedUrls = (n) =>
	Array.from({ length: n }, (_, i) => `https://www.example.com/help/${String(i).padStart(5, '0')}`);

test('a running sweep publishes ITS OWN identity and partial counts, apart from the last pass that ended', async (t) => {
	const { applyOptions } = await import('../src/config.js');
	applyOptions({ changeProbe: { enabled: true, rules: RULES_RAW, chunkSize: 250, dryRun: true } });
	t.after(() => applyOptions({ changeProbe: { enabled: false } }));
	const T0 = Date.parse('2026-09-24T05:05:00Z');
	t.mock.timers.enable({ apis: ['Date'], now: T0 });

	// Yesterday's finished pass — the record the running pass must NOT be confused with.
	await changeProbe.publishProbeStateForTest({
		sweep: {
			running: false,
			lastRun: { label: 'yesterday', matched: 12_345, probed: 12_000, startedAt: 1, finishedAt: 2 },
		},
	});

	let release;
	const gate = new Promise((resolve) => (release = resolve));
	globalThis.databases.render_service.Target = walkableTargets(unmatchedUrls(300), {
		hold: async (index) => {
			// Past the first chunk's heartbeat: the walk has examined 250 rows and beaten once at 200.
			if (index === 249) t.mock.timers.tick(31_000);
			if (index >= 250) await gate;
		},
	});

	const pass = changeProbe.runProbeSweepOnce({ startedBy: 'manual' });
	for (let i = 0; i < 200; i++) {
		await flushTurns(1);
		if ((await changeProbe.readProbeStateForTest())?.sweep?.progress?.examined === 200) break;
	}

	const mid = await changeProbe.changeProbeStatus();
	assert.equal(mid.statusVersion, 2);
	assert.equal(mid.sweep.running, true);
	assert.equal(mid.sweep.current.startedAt, T0, 'the running pass says when IT started');
	assert.equal(mid.sweep.current.startedBy, 'manual');
	assert.equal(mid.sweep.current.dryRun, true);
	assert.equal(mid.sweep.current.phase, 'walking');
	assert.equal(mid.sweep.current.stale, false);
	assert.equal(mid.sweep.current.sliceEstimate, 12_345, 'the previous complete pass sizes the ETA');
	assert.equal(mid.sweep.progress.examined, 200, 'the pass’s own counters, not yesterday’s');
	assert.equal(mid.sweep.progress.examinedApprox, 200, 'kept for consoles that predate the counters');
	assert.equal(mid.sweep.progress.probed, 0);
	assert.equal(mid.sweep.progress.triggerQueueDepth, 0);
	assert.equal(typeof mid.sweep.progress.recentRate, 'number');
	assert.equal(mid.sweep.lastRun.label, 'yesterday', 'and the last pass that ENDED is still the previous one');
	assert.equal(mid.serverTime, T0 + 31_000, 'the node clock rides along, so a reader ages against it');

	release();
	await pass;
	const done = await changeProbe.changeProbeStatus();
	assert.equal(done.sweep.running, false);
	assert.equal(done.sweep.current, null, 'no claim, no current pass');
	assert.equal(done.sweep.progress, null);
	assert.equal(done.sweep.lastRun.startedBy, 'manual', 'the finished record says who started it');
	assert.equal(done.sweep.lastRun.examined, 300);
});

test('a pass whose heartbeat stopped is reported as STALLED, not as idle', async () => {
	// `running` is the claim filtered by staleness — right for the run guard, and indistinguishable
	// from an idle node for an operator. `current.stale` is the difference.
	const longAgo = Date.now() - 10 * 60 * 1000;
	await changeProbe.publishProbeStateForTest({
		sweep: { running: true, startedAt: longAgo - 60_000, heartbeatAt: longAgo, startedBy: 'anchor', lastRun: null },
	});
	const status = await changeProbe.changeProbeStatus();
	assert.equal(status.sweep.running, false, 'the claim is takeable');
	assert.equal(status.sweep.current.stale, true);
	assert.equal(status.sweep.current.heartbeatAt, longAgo);
	assert.equal(status.sweep.current.startedBy, 'anchor');
	assert.deepEqual(status.heartbeat, { intervalMs: 30_000, staleAfterMs: 300_000 });
});

test('#176: a live continuous -> anchored switch PUBLISHES a finite next anchored run', async (t) => {
	t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
	t.after(() => t.mock.timers.reset());
	await applyProbeConfig({ enabled: true, mode: 'continuous', cycleTarget: 60_000, startDelay: 3_600_000 });
	changeProbe.startChangeProbeScheduler();
	await applyProbeConfig({ enabled: true, mode: 'anchored', anchorTime: '00:05', anchorTimezone: 'America/Chicago' });
	await changeProbe.probeStatePublishedForTest();

	// The ROW — what the fifteen workers that never armed anything read.
	const row = await changeProbe.readProbeStateForTest();
	assert.equal(row.scheduler.armedSweep, 'anchored:00:05|America/Chicago');
	assert.ok(Number.isFinite(row.scheduler.nextAnchorAt), 'the published anchor is finite right after arming');
	assert.ok(row.scheduler.nextAnchorAt > Date.now());

	const status = await changeProbe.changeProbeStatus();
	assert.equal(new Date(status.sweep.nextAnchoredRunAt).getTime(), row.scheduler.nextAnchorAt);
	assert.equal(status.sweep.nextRunAt, row.scheduler.nextAnchorAt);
	assert.equal(status.sweep.nextRunBasis, 'anchor');
	await applyProbeConfig({ enabled: false });
});

test('#176: a worker that never armed the scheduler still reports the next anchored run', async () => {
	// Exactly the fifteen-of-sixteen case: this worker's module state knows nothing; only the row does.
	const { applyOptions } = await import('../src/config.js');
	applyOptions({ changeProbe: { enabled: true, rules: RULES_RAW, mode: 'anchored', anchorTime: '00:05' } });
	const at = Date.now() + 5 * 3_600_000;
	await changeProbe.publishProbeStateForTest({ scheduler: { armedSweep: 'anchored:00:05|UTC', nextAnchorAt: at } });
	const status = await changeProbe.changeProbeStatus();
	assert.equal(status.sweep.nextAnchoredRunAt, new Date(at).toISOString());
	assert.equal(status.sweep.nextRunAt, at);
	applyOptions({ changeProbe: { enabled: false } });
});

test('every anchor re-arm publishes: mid-pass the next run is already the FOLLOWING anchor, and stays so', async (t) => {
	t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: Date.parse('2026-09-24T02:59:00Z') });
	t.after(() => t.mock.timers.reset());
	let release;
	const gate = new Promise((resolve) => (release = resolve));
	globalThis.databases.render_service.Target = walkableTargets(unmatchedUrls(3), { hold: () => gate });
	await applyProbeConfig({ enabled: true, mode: 'anchored', anchorTime: '03:00', anchorTimezone: 'UTC' });
	changeProbe.startChangeProbeScheduler();
	await changeProbe.probeStatePublishedForTest();
	const today = Date.parse('2026-09-24T03:00:00Z');
	const tomorrow = Date.parse('2026-09-25T03:00:00Z');
	assert.equal((await changeProbe.readProbeStateForTest()).scheduler.nextAnchorAt, today);

	t.mock.timers.tick(60_000); // the anchor fires; the pass blocks on the gate
	for (let i = 0; i < 100 && !(await changeProbe.readProbeStateForTest())?.sweep?.running; i++) await flushTurns(1);
	const mid = await changeProbe.changeProbeStatus();
	assert.equal(mid.sweep.running, true);
	assert.equal(mid.sweep.current.startedBy, 'anchor');
	assert.equal(mid.sweep.nextRunAt, tomorrow, 'never null, never the instant that just fired');

	release();
	for (let i = 0; i < 100 && (await changeProbe.readProbeStateForTest())?.sweep?.running; i++) await flushTurns(1);
	await changeProbe.probeStatePublishedForTest();
	const after = await changeProbe.readProbeStateForTest();
	assert.equal(after.sweep.lastRun.startedBy, 'anchor');
	assert.equal(after.scheduler.nextAnchorAt, tomorrow, 'the re-arm after the pass published too');
	await applyProbeConfig({ enabled: false });
});

test('an unusable anchor publishes a NULL next run — and null now means only that', async (t) => {
	t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
	t.after(() => t.mock.timers.reset());
	await applyProbeConfig({ enabled: true, mode: 'anchored', anchorTime: '03:00', anchorTimezone: 'Not/AZone' });
	changeProbe.startChangeProbeScheduler();
	await changeProbe.probeStatePublishedForTest();
	const status = await changeProbe.changeProbeStatus();
	assert.equal(status.sweep.armedInterval, 'anchored:03:00|Not/AZone', 'armed, so the null is not a disarm');
	assert.equal(status.sweep.nextAnchoredRunAt, null);
	assert.equal(status.sweep.nextRunAt, null);
	assert.equal(status.sweep.nextRunBasis, 'anchor');
	await applyProbeConfig({ enabled: false });
});

test('interval mode: the next run is the boot sweep until it fires, then the next timer tick', async (t) => {
	const T0 = Date.parse('2026-09-24T12:00:00Z');
	t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: T0 });
	t.after(() => t.mock.timers.reset());
	await applyProbeConfig({
		enabled: true,
		sweepInterval: 3_600_000,
		startDelay: 60_000,
		startJitter: 1,
		canary: { interval: 600_000 },
	});
	changeProbe.startChangeProbeScheduler();
	await changeProbe.probeStatePublishedForTest();
	let status = await changeProbe.changeProbeStatus();
	assert.equal(status.sweep.nextRunBasis, 'startup');
	assert.equal(status.sweep.nextRunAt, T0 + 60_000);

	t.mock.timers.tick(60_000); // boot fires: a sweep (empty registry) and the timers arm
	await flushTurns();
	await changeProbe.probeStatePublishedForTest();
	status = await changeProbe.changeProbeStatus();
	assert.equal(status.sweep.nextRunBasis, 'interval');
	assert.equal(status.sweep.nextRunAt, T0 + 60_000 + 3_600_000);
	assert.equal(status.canary.nextRunAt, T0 + 60_000 + 600_000);
	await applyProbeConfig({ enabled: false });
});

test('a pass on a worker that is not the scheduler’s does not overwrite the published schedule', async () => {
	// The admin POST runs a pass wherever the request landed. That worker has nothing armed, and its
	// end-of-pass publish used to write `armedSweep: null` over worker 0's — "not armed" on the admin
	// surface until worker 0 next republished, a day later in anchored mode.
	const { applyOptions } = await import('../src/config.js');
	applyOptions({ changeProbe: { enabled: true, rules: RULES_RAW } });
	const schedule = { armedSweep: 'anchored:00:05|UTC', armedCanary: 1_800_000, nextAnchorAt: Date.now() + 3_600_000 };
	await changeProbe.publishProbeStateForTest({ scheduler: schedule });
	await changeProbe.runProbeSweepOnce({ startedBy: 'manual' });
	await changeProbe.probeStatePublishedForTest();
	const row = await changeProbe.readProbeStateForTest();
	assert.equal(row.scheduler.armedSweep, schedule.armedSweep);
	assert.equal(row.scheduler.armedCanary, schedule.armedCanary);
	assert.equal(row.scheduler.nextAnchorAt, schedule.nextAnchorAt);
	applyOptions({ changeProbe: { enabled: false } });
});

test('the canary’s cohort build republishes the cohort sizes instead of leaving the boot-time {}', async (t) => {
	t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
	t.after(() => t.mock.timers.reset());
	await applyProbeConfig({
		enabled: true,
		sweepInterval: 3_600_000,
		startDelay: 3_600_000,
		canary: { interval: 600_000 },
	});
	changeProbe.startChangeProbeScheduler();
	await changeProbe.probeStatePublishedForTest();
	assert.deepEqual((await changeProbe.readProbeStateForTest()).scheduler.cohortSizes, {});
	await changeProbe.runProbeCanaryOnce({ startedBy: 'interval' });
	await changeProbe.probeStatePublishedForTest();
	const row = await changeProbe.readProbeStateForTest();
	assert.deepEqual(row.scheduler.cohortSizes, { pdp: 0 }, 'the build ran and its (empty) result is published');
	assert.equal(row.canary.lastRun.startedBy, 'interval');
	await applyProbeConfig({ enabled: false });
});

test('the drain keeps beating while the queue settles, and stops the moment it is idle', async (t) => {
	t.mock.timers.enable({ apis: ['setInterval'] });
	let settle;
	const triggers = { drain: () => new Promise((resolve) => (settle = resolve)) };
	let beats = 0;
	const draining = changeProbe.__drainWithHeartbeatForTest(triggers, () => beats++);
	t.mock.timers.tick(30_000);
	assert.equal(beats, 3, 'a beat every third of an interval while the queue drains');
	settle();
	await draining;
	t.mock.timers.tick(60_000);
	assert.equal(beats, 3, 'and none after');
	t.mock.timers.reset();
});

test('the status names what the probe runs on: settings, rule fingerprints, extract paths and endpoint', async (t) => {
	const { applyOptions } = await import('../src/config.js');
	t.after(() => applyOptions({ changeProbe: { enabled: false } }));
	applyOptions({
		changeProbe: {
			enabled: true,
			rules: RULES_RAW,
			mode: 'anchored',
			anchorTime: '00:05',
			anchorTimezone: 'America/Chicago',
			ratePerSecond: 7,
			trigger: { maxPending: 1234 },
		},
	});
	const status = await changeProbe.changeProbeStatus();
	assert.equal(status.settings.mode, 'anchored');
	assert.equal(status.settings.anchorTime, '00:05');
	assert.equal(status.settings.anchorTimezone, 'America/Chicago');
	assert.equal(status.settings.ratePerSecond, 7);
	assert.equal(status.settings.trigger.maxPending, 1234);
	const [rule] = status.rules;
	assert.match(rule.fingerprint, /\S/);
	assert.deepEqual(rule.extract, ['price']);
	assert.deepEqual(rule.endpoint, { method: 'POST', path: '/price/$1' }, 'the path, never the host');
	assert.equal(status.workerIndex, 0);
});
