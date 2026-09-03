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
		probe_state: { ProbeState: FakeTable },
		render_service: { Target: FakeTable },
		page_cache: { PrerenderedPage: FakeTable },
		render_schedule: { RenderSchedule: FakeTable },
		invalidation: { Invalidation: FakeTable },
	};
	sharedRows = new Map();
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
		read: async (url) => (stored[url] === undefined ? null : { signature: stored[url], probedAt: NaN }),
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
		trigger: async () => {},
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
		trigger: async () => {},
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
	const stats = await changeProbe.runProbePass({
		rows: stream(rows),
		rules: compileProbeRules(PAGECHECK_RULES),
		ownerOf: () => 'node-a',
		hostname: 'node-a',
		probe: async (rule, url) => answers[url] ?? null,
		read: async (url) => stored[url] ?? null,
		write: async (url, signature, opts = {}) =>
			written.push({ url, signature, rowExists: opts.rowExists === true, clearClaim: opts.clearClaim === true }),
		trigger: async (target) => triggered.push(target.url),
		dryRun: false,
		maxTriggers: 100,
		concurrency: 1,
		ratePerSecond: 1000,
		pause: async () => {},
		...overrides,
	});
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
	// BOTH halves of the claim pair. `pageClaimAt` is the render `pageSignature` came from; clearing
	// one and leaving the other is a half-state a verification could later read.
	assert.deepEqual(Object.keys(calls.patch[1].fields).sort(), [
		'pageClaimAt',
		'pageSignature',
		'probedAt',
		'signature',
	]);
	assert.equal(calls.patch[1].fields.pageSignature, null);
	assert.equal(calls.patch[1].fields.pageClaimAt, null);

	await changeProbe.writeSignature(URL_A, 'sig', { rowExists: false });
	assert.equal(calls.patch.length, 2);
	assert.equal(calls.put.length, 1);
	assert.equal(calls.put[0].rowFields.url, URL_A);
	assert.equal(calls.put[0].rowFields.pageSignature, null, 'a created row starts with no claim');
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
		trigger: async () => {},
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
		trigger: async () => {},
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
		trigger: async () => {},
		dryRun: false,
		maxTriggers: 100,
		concurrency: 1,
		ratePerSecond: 1000,
		pause: async () => {},
	});
	assert.equal(stats.unchanged, 1);
});
