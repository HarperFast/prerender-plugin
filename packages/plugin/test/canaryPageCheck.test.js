/**
 * The canary and the page check: it DETECTS changes in its cohort, but a page-only disagreement is the
 * sweep's to correct, and its comparisons never feed the mapping guard.
 *
 * Run through the REAL canary (`runProbeCanaryOnce`, its bootstrap cohort, a loopback origin), because the
 * wiring is the whole point: a canary that witnessed made one 500-URL cohort the guard's entire sample
 * whenever no pass ran, and a cluster of it disarmed a correct mapping on every node of one deployment.
 */
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

const HOUR = 60 * 60 * 1000;

let changeProbe;
let applyOptions;
let spec;
let fnv1a32;

let origin;
let port;
let answer = { title: 'Red Shoe' };
const asked = [];

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
// Every write to a table the action path touches, so "nothing was acted on" is observed, not inferred.
const writes = [];
const table = (name, rows = new Map()) =>
	class {
		static async get({ id }) {
			const row = rows.get(id);
			return row ? { ...row } : undefined;
		}
		static async put(id, row) {
			writes.push({ table: name, op: 'put', id, row });
		}
		static async patch(id, patch) {
			writes.push({ table: name, op: 'patch', id, patch });
		}
		static async delete() {}
		static search() {
			return [];
		}
	};

let registry = new Map();
let probeState = new Map();
const matches = (row, { attribute, comparator, value }) =>
	comparator === 'greater_than_equal'
		? row[attribute] >= value
		: comparator === 'greater_than'
			? row[attribute] > value
			: comparator === 'less_than'
				? row[attribute] < value
				: row[attribute] === value;
class RegistryTable {
	static async get({ id }) {
		const row = registry.get(id);
		return row ? { ...row } : undefined;
	}
	static async *search({ conditions = [], sort, limit = Infinity }) {
		let rows = [...registry.values()].filter((row) => conditions.every((c) => matches(row, c)));
		rows.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
		if (sort?.descending) rows.reverse();
		for (const row of rows.slice(0, limit)) yield { ...row };
	}
}

before(async () => {
	origin = createServer((req, res) => {
		asked.push(req.url);
		res.writeHead(200, { 'content-type': 'application/json' });
		res.end(JSON.stringify(answer));
	});
	await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
	port = origin.address().port;
});

after(async () => {
	await new Promise((resolve) => origin.close(resolve));
});

beforeEach(async () => {
	globalThis.server = { hostname: 'node-a', workerIndex: 0, nodes: [], config: { http: {} } };
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {}, notify() {} };
	sharedRows = new Map();
	registry = new Map();
	probeState = new Map();
	writes.length = 0;
	asked.length = 0;
	answer = { title: 'Red Shoe' };
	globalThis.databases = {
		coordination: { SharedBuffer: SharedBufferFake },
		probe_state: { ProbeState: table('ProbeState', probeState), RenderExpectation: table('RenderExpectation') },
		render_service: { Target: RegistryTable },
		page_cache: { PrerenderedPage: table('PrerenderedPage') },
		render_schedule: { RenderSchedule: table('RenderSchedule') },
		invalidation: { Invalidation: table('Invalidation') },
	};
	changeProbe = await import('../src/util/changeProbe.js');
	({ applyOptions } = await import('../src/config.js'));
	spec = await import('../src/util/changeProbeSpec.js');
	({ fnv1a32 } = await import('../src/util/hash.js'));
	changeProbe.resetChangeProbeState();
});

afterEach(() => {
	applyOptions({ changeProbe: { enabled: false } });
	changeProbe.resetChangeProbeState();
});

const rules = () => [
	{
		label: 'pdp',
		pathPattern: '^/product/prd-([^/]+)',
		source: 'request',
		request: { urlTemplate: `http://127.0.0.1:${port}/p/$1` },
		extract: ['title', 'price'],
		pageCheck: { enabled: true, fields: [{ slot: 0, fact: 'title', compare: 'text' }] },
	},
];

// A URL the bootstrap cohort's 1-in-16 hash stride accepts.
const strideUrl = () => {
	for (let i = 0; ; i++) {
		const url = `https://site.example.com/product/prd-${i}`;
		if (fnv1a32(url) % 16 === 0) return url;
	}
};

/** One cohort member whose cached page shows `pageTitle`, baselined against the origin's `baseline`. */
const seed = ({ pageTitle, baseline = { title: 'Red Shoe' } }) => {
	applyOptions({
		changeProbe: {
			enabled: true,
			dryRun: false,
			rules: rules(),
			ratePerSecond: 10_000,
			canary: { count: 10, interval: 0 },
		},
	});
	const [rule] = spec.compileProbeRules(rules());
	const url = strideUrl();
	registry.set(url, { url, sitemapUrl: null, renderInterval: null, demandInterval: null, state: null });
	const now = Date.now();
	probeState.set(url, {
		url,
		signature: spec.signatureOf(spec.extractValues(baseline, rule.extract)),
		probedAt: new Date(now - 2 * HOUR),
		pageSignature: null,
		// Rendered AFTER the baseline, origin unchanged since: a WITNESSED comparison, were anyone witnessing.
		pageClaimAt: new Date(now - HOUR),
		pageFacts: spec.serializePageFacts({ title: pageTitle }).json,
		ruleFingerprint: rule.fingerprint,
	});
	return url;
};

test('the canary counts a page-only disagreement but neither re-renders it nor feeds the guard', async () => {
	const url = seed({ pageTitle: 'Red Shoe (Old Name)' });
	const canary = await changeProbe.runProbeCanaryOnce();
	const [run] = canary.perRule;
	assert.equal(asked.length, 1, 'the cohort member was probed');
	assert.equal(run.unchanged, 1);
	assert.equal(run.pageMismatch, 1, 'seen and counted');
	assert.deepEqual(run.fieldMismatch, { pdp: { '0:title': 1 } });
	assert.equal(run.triggered, 0, 'left to the sweep');
	assert.deepEqual(writes, [], `nothing expired, filed or re-baselined for ${url}`);
	assert.deepEqual(run.fieldGuard.pdp['0:title'], { witnessed: 0, disagreed: 0, armed: true }, 'not witnessed');
});

test('the canary still ACTS on an origin change in its cohort', async () => {
	const url = seed({ pageTitle: 'Red Shoe' });
	answer = { title: 'Red Shoe', price: 29.99 }; // an unmapped slot moved
	const canary = await changeProbe.runProbeCanaryOnce();
	const [run] = canary.perRule;
	assert.equal(run.changed, 1);
	assert.equal(run.triggered, 1);
	const baseline = writes.find((w) => w.table === 'ProbeState' && w.id === url);
	assert.ok(baseline, 'the new baseline is written with the action');
	assert.equal(baseline.patch.pageFacts, null, 'and the acted page’s record cleared with it');
});

test('the canary READS the guard the sweep feeds: a field the sweep disarmed is disarmed for the canary too', async () => {
	const url = seed({ pageTitle: 'Red Shoe (Old Name)' });
	applyOptions({
		changeProbe: {
			enabled: true,
			dryRun: false,
			rules: rules(),
			ratePerSecond: 10_000,
			canary: { count: 10, interval: 0 },
			mappingGuard: { threshold: 0.5, minWitnessed: 1 },
		},
	});
	await changeProbe.runProbeSweepOnce({ label: 'disarm' });
	const [rule] = changeProbe.probeRules();
	assert.equal(changeProbe.isFieldArmed(rule, rule.pageCheck.fields[0]), false, 'the sweep disarmed it');
	// The sweep witnessed the disagreement (and re-rendered the page, clearing its record); restore the record
	// so the canary has the same disagreement to read.
	probeState.set(url, { ...probeState.get(url), probedAt: new Date(Date.now() - 2 * HOUR) });
	writes.length = 0;
	const canary = await changeProbe.runProbeCanaryOnce();
	const [run] = canary.perRule;
	assert.equal(run.fieldGuard.pdp['0:title'].armed, false, 'the canary sees the sweep’s verdict');
	assert.equal(run.pageMismatch, 0, 'a disarmed field’s disagreement is not an actionable mismatch');
	assert.deepEqual(run.fieldMismatch, { pdp: { '0:title': 1 } }, 'but it is still counted');
	assert.deepEqual(writes, []);
});
