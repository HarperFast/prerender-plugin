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
	await changeProbe.recordPageClaim(CLAIM_URL, ['35.99', 'USD', 'InStock']);
	assert.equal(calls.patch.length, 0);
	assert.equal(calls.put.length, 1);
	assert.equal(calls.put[0].id, CLAIM_URL);
	assert.deepEqual(calls.put[0].row, { url: CLAIM_URL, pageSignature: JSON.stringify([['35.99'], true]) });
});

test('recordPageClaim UPDATES an existing row with patch — put would clobber the probe baseline', async (t) => {
	t.after(restoreConfig);
	const calls = await claimHarness({ existing: { url: CLAIM_URL } });
	await changeProbe.recordPageClaim(CLAIM_URL, ['35.99', 'USD', 'OutOfStock']);
	assert.equal(calls.put.length, 0);
	assert.equal(calls.patch.length, 1);
	assert.equal(calls.patch[0].id, CLAIM_URL);
	assert.deepEqual(calls.patch[0].patch, { pageSignature: JSON.stringify([['35.99'], false]) });
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
	assert.deepEqual(Object.keys(calls.patch[1].fields).sort(), ['pageSignature', 'probedAt', 'signature']);
	assert.equal(calls.patch[1].fields.pageSignature, null);

	await changeProbe.writeSignature(URL_A, 'sig', { rowExists: false });
	assert.equal(calls.patch.length, 2);
	assert.equal(calls.put.length, 1);
	assert.equal(calls.put[0].rowFields.url, URL_A);
	assert.equal(calls.put[0].rowFields.pageSignature, null, 'a created row starts with no claim');
});
