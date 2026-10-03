import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';

/**
 * `util/sampling.js` — the request path, the ring and the flush.
 *
 * WHAT MUST NEVER HAPPEN, and each is pinned below:
 *   - COST WHEN OFF. Sampling off allocates no ring and records nothing.
 *   - AN INCOMPLETE SAMPLE THAT LOOKS COMPLETE. A pick that is not recorded — over `maxPerMinute`, or with
 *     the ring full — is counted on the next row, so a reader can tell.
 *   - A RECORD LOST OR RESHAPED BY A CONFIG EDIT. Records keep the sampler they were taken under; turning
 *     sampling off writes what was collected.
 *   - A RESPONSE FAILED BY A SAMPLER. `sampleRequest` never throws.
 */

let sampling;
let spec;
let config;
let applyOptions;
const chunks = new Map();
const targets = new Map();
let targetReads = 0;
let failPut = false;

class TargetBase {
	static async get({ id }) {
		targetReads++;
		return targets.get(id) ?? null;
	}
	static search() {
		return (async function* () {})();
	}
}

const SampleChunk = {
	async put(id, data) {
		if (failPut) throw new Error('write failed');
		chunks.set(id, { id, ...data });
	},
	search({ conditions, select }) {
		const [condition] = conditions;
		const rows = [...chunks.values()]
			.filter((row) => (condition.comparator === 'greater_than' ? row.id > condition.value : row.id >= condition.value))
			.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
			.map((row) => (select ? Object.fromEntries(select.map((key) => [key, row[key]])) : row));
		return (async function* () {
			yield* rows;
		})();
	},
};

before(async () => {
	globalThis.server = { hostname: 'node-a', workerIndex: 3, nodes: [], config: { http: { port: 9926 } } };
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} };
	globalThis.Resource = class {};
	globalThis.createBlob = (bytes) => bytes;
	globalThis.databases = {
		coordination: {
			SharedBuffer: { primaryStore: { getUserSharedBuffer: (_key, buf) => buf, tryLock: () => true, unlock() {} } },
		},
		render_service: { Target: TargetBase, QueueControl: class {} },
		render_schedule: { RenderSchedule: class {} },
		page_cache: { PrerenderedPage: class {} },
		probe_state: { ProbeState: class {}, RenderExpectation: class {} },
		sampling: { SampleChunk },
	};
	({ config, applyOptions } = await import('../src/config.js'));
	sampling = await import('../src/util/sampling.js');
	spec = await import('../src/util/samplingSpec.js');
	sampling.startRequestSampling();
});

beforeEach(() => {
	applyOptions({});
	sampling.resetSamplingForTests();
	sampling.startRequestSampling();
	chunks.clear();
	targets.clear();
	targetReads = 0;
	failPut = false;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

const PDP = { path: '/product/', match: 'prefix', mode: 'prerender' };
const CATALOG = { path: '/catalog/', match: 'prefix', mode: 'prerender' };
const urlOf = (i) => `https://www.example.com/product/prd-${i}/item.jsp`;

const enable = (samplers, extra = {}) =>
	applyOptions({ sampling: { enabled: true, ringSize: 64, flushInterval: 60_000, samplers, ...extra } });

const request = (over = {}) => ({
	botName: 'Googlebot',
	method: 'GET',
	headers: new Headers({ 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' }),
	...over,
});

const info = (over = {}) => ({
	route: PDP,
	routeClass: 'prerender',
	deviceType: 'mobile',
	cacheKey: `${urlOf(1)}|mobile`,
	cacheStatus: 'hit',
	source: 'cache',
	...over,
});

const serve = (url = urlOf(1), { req = {}, inf = {}, status = 200, resource } = {}) =>
	sampling.sampleRequest(
		request(req),
		info(inf),
		resource ?? { lastCached: new Date(Date.now() - 5_000) },
		status,
		url
	);

const recordsOf = (row) =>
	row.body
		? gunzipSync(row.body)
				.toString()
				.trim()
				.split('\n')
				.map((line) => JSON.parse(line))
		: [];

const rowsFor = (name) => [...chunks.values()].filter((row) => row.sampler === name);

test('off by default: nothing recorded, and no ring allocated', async () => {
	serve();
	const state = sampling.samplingWorkerState();
	assert.equal(state.active, false);
	assert.equal(state.ring.size, 0);
	await sampling.flushSamples();
	assert.equal(chunks.size, 0);
});

test('enabled with no valid sampler is still off', () => {
	enable([{ name: 'bad', nope: true }]);
	assert.equal(sampling.samplingWorkerState().active, false);
	assert.equal(sampling.samplingWorkerState().ring.size, 0);
});

test('a matching request becomes one record in one row per sampler, with the configured fields', async () => {
	enable([
		{
			name: 'pdp',
			match: { routes: ['/product/'], bots: ['googlebot'] },
			sample: { rate: 1 },
			fields: ['url', 'bot', 'device', 'status', 'cacheStatus', 'source', 'ageMs', 'node', 'worker', 'conditional'],
			headers: ['user-agent'],
			keep: 2 * 86_400_000,
		},
	]);
	const before = Date.now();
	serve(urlOf(1), { req: { headers: new Headers({ 'user-agent': 'UA-1', 'if-none-match': '"x"' }) }, status: 304 });
	const { chunks: written, records } = await sampling.flushSamples();
	assert.equal(written, 1);
	assert.equal(records, 1);
	const [row] = rowsFor('pdp');
	assert.match(row.id, /^pdp\/\d{13}\/003\/1$/);
	assert.equal(row.node, 'node-a');
	assert.equal(row.worker, 3);
	assert.equal(row.count, 1);
	assert.equal(row.capped, 0);
	assert.equal(row.dropped, 0);
	assert.equal(row.expiresAt.getTime(), row.firstAt.getTime() + 2 * 86_400_000);
	const [record] = recordsOf(row);
	assert.ok(record.ts >= before);
	assert.ok(record.ageMs >= 5_000 && record.ageMs < 6_000);
	assert.deepEqual(
		{ ...record, ts: 0, ageMs: 0 },
		{
			ts: 0,
			url: urlOf(1),
			bot: 'Googlebot',
			device: 'mobile',
			status: 304,
			cacheStatus: 'hit',
			source: 'cache',
			ageMs: 0,
			node: 'node-a',
			worker: 3,
			conditional: true,
			headers: { 'user-agent': 'UA-1' },
		}
	);
});

test('every filter narrows: route, bot, device, method, cache status, source, status, urls, pattern', async () => {
	enable([
		{
			name: 'narrow',
			match: {
				routes: ['/product/'],
				bots: ['Googlebot'],
				devices: ['mobile'],
				methods: ['GET'],
				cacheStatuses: ['hit'],
				sources: ['cache'],
				statuses: [200],
				urls: [urlOf(1), urlOf(2)],
				urlPattern: 'prd-1/',
			},
			sample: { rate: 1 },
			fields: ['url'],
		},
	]);
	serve(urlOf(1));
	serve(urlOf(1), { inf: { route: CATALOG } });
	serve(urlOf(1), { req: { botName: 'Bingbot' } });
	serve(urlOf(1), { inf: { deviceType: 'desktop' } });
	serve(urlOf(1), { req: { method: 'HEAD' } });
	serve(urlOf(1), { inf: { cacheStatus: 'swr' } });
	serve(urlOf(1), { inf: { source: 'origin' } });
	serve(urlOf(1), { status: 404 });
	serve(urlOf(2));
	serve(urlOf(3));
	await sampling.flushSamples();
	const records = rowsFor('narrow').flatMap(recordsOf);
	assert.equal(records.length, 1);
	assert.equal(records[0].url, urlOf(1));
	assert.equal(sampling.samplingWorkerState().counters.narrow.matched, 1);
});

test('a route matches by its path or by its class', async () => {
	enable([{ name: 'pass', match: { routes: ['passthrough'] }, sample: { rate: 1 }, fields: ['route'] }]);
	serve(urlOf(1), { inf: { route: { path: '/static/', mode: 'passthrough' }, routeClass: 'passthrough' } });
	serve(urlOf(1));
	await sampling.flushSamples();
	assert.deepEqual(rowsFor('pass').flatMap(recordsOf), [
		{ ts: rowsFor('pass').flatMap(recordsOf)[0].ts, route: '/static/' },
	]);
});

test('by url: exactly the URLs the hash picks, every request for them, from every bot and device', async () => {
	// A ring large enough for the whole burst: this test is about which URLs, not about overflow.
	enable([{ name: 'stable', sample: { rate: 0.2, salt: 'revisit-1' }, fields: ['url', 'bot', 'device'] }], {
		ringSize: 1024,
	});
	const urls = Array.from({ length: 200 }, (_, i) => urlOf(i));
	for (const url of urls) {
		serve(url);
		serve(url, { req: { botName: 'Bingbot' }, inf: { deviceType: 'desktop' } });
	}
	// The ring (64) flushes at half full on the next turn; give the queued flushes their turn too.
	await settle();
	await sampling.flushSamples();
	const records = rowsFor('stable').flatMap(recordsOf);
	const expected = urls.filter((url) => spec.urlIsSampled(url, { salt: 'revisit-1', rate: 0.2 }));
	assert.ok(expected.length > 20 && expected.length < 60, String(expected.length));
	const counters = sampling.samplingWorkerState().counters.stable;
	assert.equal(counters.picked, expected.length * 2);
	// Nothing went missing on the way to storage, or the next assertion would be measuring the ring.
	assert.equal(counters.dropped + counters.capped, 0);
	assert.deepEqual([...new Set(records.map((r) => r.url))].sort(), expected.sort());
	for (const url of expected) {
		const mine = records.filter((r) => r.url === url);
		assert.deepEqual(mine.map((r) => `${r.bot}/${r.device}`).sort(), ['Bingbot/desktop', 'Googlebot/mobile']);
	}
});

test('maxPerMinute: picks over the cap are counted on the next row, not recorded', async () => {
	enable([{ name: 'capped', sample: { rate: 1, by: 'request' }, maxPerMinute: 5, fields: ['url'] }]);
	for (let i = 0; i < 12; i++) serve(urlOf(i));
	await sampling.flushSamples();
	const [row] = rowsFor('capped');
	assert.equal(row.count, 5);
	assert.equal(row.capped, 7);
	assert.equal(sampling.samplingWorkerState().counters.capped.capped, 7);
	// Reported once: the next row carries only what was capped since (the 13th pick, same minute).
	serve(urlOf(99));
	await sampling.flushSamples();
	assert.deepEqual(
		rowsFor('capped').map((r) => r.capped),
		[7, 1]
	);
});

test('a full ring drops and counts; the drop reaches the table even for a sampler with no records', async () => {
	enable([
		{ name: 'greedy', sample: { rate: 1 }, match: { bots: ['Googlebot'] }, fields: ['url'], maxPerMinute: 6000 },
		{ name: 'late', sample: { rate: 1 }, match: { bots: ['Bingbot'] }, fields: ['url'] },
	]);
	// One synchronous burst: the half-full flush is queued, not run, so the ring fills.
	for (let i = 0; i < 64; i++) serve(urlOf(i));
	serve(urlOf(1), { req: { botName: 'Bingbot' } });
	serve(urlOf(2), { req: { botName: 'Bingbot' } });
	await settle();
	await sampling.flushSamples();
	const late = rowsFor('late');
	assert.equal(late.length, 1);
	assert.equal(late[0].count, 0);
	assert.equal(late[0].dropped, 2);
	assert.equal(late[0].body, null);
	assert.equal(
		rowsFor('greedy').reduce((sum, r) => sum + r.count, 0),
		64
	);
});

test('half full flushes on its own, off the request', async () => {
	enable([{ name: 'auto', sample: { rate: 1 }, fields: ['url'], maxPerMinute: 6000 }]);
	for (let i = 0; i < 31; i++) serve(urlOf(i));
	await settle();
	assert.equal(chunks.size, 0);
	serve(urlOf(31));
	assert.equal(chunks.size, 0, 'not inside the request');
	await settle();
	assert.equal(
		rowsFor('auto').reduce((sum, r) => sum + r.count, 0),
		32
	);
});

test('records keep the sampler they were taken under across a config edit', async () => {
	enable([{ name: 'edit', sample: { rate: 1 }, fields: ['url'] }]);
	serve(urlOf(1));
	enable([{ name: 'edit', sample: { rate: 1 }, fields: ['bot'] }]);
	serve(urlOf(2));
	await sampling.flushSamples();
	const records = rowsFor('edit').flatMap(recordsOf);
	assert.deepEqual(
		records.map(({ ts, ...rest }) => rest),
		[{ url: urlOf(1) }, { bot: 'Googlebot' }]
	);
	// Counters survive the edit: they are kept by name.
	assert.equal(sampling.samplingWorkerState().counters.edit.picked, 2);
});

test('switching sampling off writes what was collected and stops recording', async () => {
	enable([{ name: 'bye', sample: { rate: 1 }, fields: ['url'] }]);
	serve(urlOf(1));
	applyOptions({ sampling: { enabled: false } });
	await settle();
	assert.equal(
		rowsFor('bye').reduce((sum, r) => sum + r.count, 0),
		1
	);
	serve(urlOf(2));
	await sampling.flushSamples();
	assert.equal(
		rowsFor('bye').reduce((sum, r) => sum + r.count, 0),
		1
	);
	assert.equal(sampling.samplingWorkerState().active, false);
	assert.equal(sampling.samplingWorkerState().ring.size, 0, 'the ring is released');
});

test('a disabled sampler records nothing while the others run', async () => {
	enable([
		{ name: 'on', sample: { rate: 1 }, fields: ['url'] },
		{ name: 'off', enabled: false, sample: { rate: 1 }, fields: ['url'] },
	]);
	serve(urlOf(1));
	await sampling.flushSamples();
	assert.equal(rowsFor('on').length, 1);
	assert.equal(rowsFor('off').length, 0);
});

test('target and sitemap are read at flush, once per distinct URL', async () => {
	targets.set(urlOf(1), { url: urlOf(1), state: 'active', sitemapUrl: 'https://www.example.com/sitemap.xml' });
	targets.set(urlOf(2), { url: urlOf(2), state: 'suppressed', sitemapUrl: null });
	enable([{ name: 'tgt', sample: { rate: 1 }, fields: ['url', 'target', 'sitemap'] }]);
	serve(urlOf(1));
	serve(urlOf(1), { inf: { deviceType: 'desktop' } });
	serve(urlOf(2));
	serve(urlOf(3));
	assert.equal(targetReads, 0, 'never on the request');
	await sampling.flushSamples();
	assert.equal(targetReads, 3);
	const records = rowsFor('tgt').flatMap(recordsOf);
	assert.deepEqual(
		records.map(({ url, target, sitemap }) => [url, target, sitemap]),
		[
			[urlOf(1), 'active', true],
			[urlOf(1), 'active', true],
			[urlOf(2), 'suppressed', false],
			[urlOf(3), null, false],
		]
	);
});

test('origin-served records carry no age; a long header is cut to 512 characters', async () => {
	enable([{ name: 'age', sample: { rate: 1 }, fields: ['ageMs'], headers: ['user-agent'] }]);
	serve(urlOf(1), {
		inf: { source: 'origin', cacheStatus: 'miss' },
		req: { headers: new Headers({ 'user-agent': 'x'.repeat(900) }) },
	});
	await sampling.flushSamples();
	const [record] = rowsFor('age').flatMap(recordsOf);
	assert.equal(record.ageMs, null);
	assert.equal(record.headers['user-agent'].length, 512);
});

test('a sampler never throws into the request, and a failed write is counted', async () => {
	enable([{ name: 'safe', sample: { rate: 1 }, fields: ['url'] }]);
	assert.doesNotThrow(() => sampling.sampleRequest({ botName: 'Googlebot' }, { route: null }, null, 200, urlOf(1)));
	assert.doesNotThrow(() => sampling.sampleRequest(null, null, null, 200, urlOf(1)));
	failPut = true;
	serve(urlOf(1));
	await sampling.flushSamples();
	assert.equal(sampling.samplingWorkerState().counters.safe.errors, 1);
});

test('chunks read back in time order, by window and by cursor; totals read no bodies', async () => {
	enable([{ name: 'read', sample: { rate: 1 }, fields: ['url'] }]);
	const t0 = Date.UTC(2026, 9, 1, 0, 0, 0);
	for (let i = 0; i < 5; i++) {
		chunks.set(sampling.chunkIdOf('read', t0 + i * 60_000, 1, i + 1), {
			id: sampling.chunkIdOf('read', t0 + i * 60_000, 1, i + 1),
			sampler: 'read',
			count: 2,
			capped: i === 4 ? 3 : 0,
			dropped: 0,
			firstAt: new Date(t0 + i * 60_000),
			lastAt: new Date(t0 + i * 60_000 + 30_000),
			body: null,
		});
	}
	// Another sampler's rows sort beside these and must never be read as them.
	chunks.set(sampling.chunkIdOf('read2', t0, 1, 9), { id: sampling.chunkIdOf('read2', t0, 1, 9), sampler: 'read2' });

	const ids = async (args) => {
		const out = [];
		for await (const row of sampling.sampleChunks({ sampler: 'read', ...args })) out.push(row.id);
		return out;
	};
	assert.equal((await ids({})).length, 5);
	const window = await ids({ sinceMs: t0 + 60_000, untilMs: t0 + 3 * 60_000 });
	assert.equal(window.length, 2);
	const resumed = await ids({ after: window[0] });
	assert.equal(resumed.length, 3);
	assert.equal(resumed[0], window[1]);

	const totals = await sampling.storedSampleTotals({ names: ['read'], sinceMs: t0 });
	assert.equal(totals.read.chunks, 5);
	assert.equal(totals.read.records, 10);
	assert.equal(totals.read.capped, 3);
	assert.equal(totals.read.firstAt, new Date(t0).toISOString());
});

test('the ring follows ringSize live, writing what the old ring held', async () => {
	enable([{ name: 'size', sample: { rate: 1 }, fields: ['url'] }]);
	serve(urlOf(1));
	enable([{ name: 'size', sample: { rate: 1 }, fields: ['url'] }], { ringSize: 128 });
	assert.equal(sampling.samplingWorkerState().ring.size, 128);
	await settle();
	assert.equal(
		rowsFor('size').reduce((sum, r) => sum + r.count, 0),
		1
	);
	assert.equal(config.sampling.ringSize, 128);
});
