import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync, gzipSync } from 'node:zlib';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `util/sampling.js` — the request path, the ring, the flush and the files.
 *
 * WHAT MUST NEVER HAPPEN, and each is pinned below:
 *   - COST WHEN OFF. Sampling off allocates no ring and records nothing.
 *   - AN INCOMPLETE SAMPLE THAT LOOKS COMPLETE. A pick that is not recorded — over `maxPerMinute`, with the
 *     ring full, or in an append that failed — is counted in a counters line in the same file.
 *   - A RECORD LOST OR RESHAPED BY A CONFIG EDIT. Records keep the sampler they were taken under; turning
 *     sampling off writes what was collected, counters included.
 *   - A RESPONSE FAILED BY A SAMPLER. `sampleRequest` never throws.
 */

let sampling;
let spec;
let config;
let applyOptions;
let root;
let dir;
const targets = new Map();
let targetReads = 0;

class TargetBase {
	static async get({ id }) {
		targetReads++;
		return targets.get(id) ?? null;
	}
	static search() {
		return (async function* () {})();
	}
}

before(async () => {
	root = mkdtempSync(join(tmpdir(), 'prerender-sampling-test-'));
	globalThis.server = { hostname: 'node-a', workerIndex: 3, nodes: [], config: { http: { port: 9926 } } };
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} };
	globalThis.Resource = class {};
	globalThis.databases = {
		coordination: {
			SharedBuffer: { primaryStore: { getUserSharedBuffer: (_key, buf) => buf, tryLock: () => true, unlock() {} } },
		},
		render_service: { Target: TargetBase, QueueControl: class {} },
		render_schedule: { RenderSchedule: class {} },
		page_cache: { PrerenderedPage: class {} },
		probe_state: { ProbeState: class {}, RenderExpectation: class {} },
	};
	({ config, applyOptions } = await import('../src/config.js'));
	sampling = await import('../src/util/sampling.js');
	spec = await import('../src/util/samplingSpec.js');
});

after(() => {
	sampling.resetSamplingForTests();
	rmSync(root, { recursive: true, force: true });
});

let testIndex = 0;
beforeEach(() => {
	dir = join(root, `t${testIndex++}`);
	applyOptions({});
	sampling.resetSamplingForTests();
	sampling.startRequestSampling();
	targets.clear();
	targetReads = 0;
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const PDP = { path: '/product/', match: 'prefix', mode: 'prerender' };
const CATALOG = { path: '/catalog/', match: 'prefix', mode: 'prerender' };
const urlOf = (i) => `https://www.example.com/product/prd-${i}/item.jsp`;
const today = () => new Date().toISOString().slice(0, 10);

const enable = (samplers, extra = {}) =>
	applyOptions({
		sampling: { enabled: true, directory: dir, ringSize: 64, flushInterval: 60_000, samplers, ...extra },
	});

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
		resource === undefined ? { lastCached: new Date(Date.now() - 5_000) } : resource,
		status,
		url
	);

const filesOf = (name) => (existsSync(join(dir, name)) ? readdirSync(join(dir, name)).sort() : []);

/** Every line of a sampler's files, in file order: records and counters lines alike. */
const linesOf = (name) =>
	filesOf(name).flatMap((file) =>
		gunzipSync(readFileSync(join(dir, name, file)))
			.toString()
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line))
	);
const recordsOf = (name) => linesOf(name).filter((line) => !line.counters);
const countersOf = (name) =>
	linesOf(name)
		.filter((line) => line.counters)
		.map((line) => line.counters);

test('off by default: nothing recorded, and no ring allocated', async () => {
	serve();
	const state = sampling.samplingWorkerState();
	assert.equal(state.active, false);
	assert.equal(state.ring.size, 0);
	await sampling.flushSamples();
	assert.equal(existsSync(dir), false);
});

test('enabled with no valid sampler, or no usable directory, is still off', () => {
	enable([{ name: 'bad', nope: true }]);
	assert.equal(sampling.samplingWorkerState().active, false);
	assert.equal(sampling.samplingWorkerState().ring.size, 0);
	enable([{ name: 'ok' }], { directory: 'relative/path' });
	assert.equal(sampling.samplingWorkerState().active, false);
	assert.equal(sampling.samplingWorkerState().directory, null);
});

test("the default directory is under Harper's root", () => {
	server.config.rootPath = '/srv/hdb';
	try {
		applyOptions({ sampling: { enabled: true, samplers: [{ name: 'ok' }] } });
		assert.equal(sampling.sampleDirectory(), '/srv/hdb/prerender-sampling');
	} finally {
		delete server.config.rootPath;
	}
});

test('a matching request becomes one record in the sampler’s file for the day, this worker', async () => {
	enable([
		{
			name: 'pdp',
			match: { routes: ['/product/'], bots: ['googlebot'] },
			sample: { rate: 1 },
			fields: ['url', 'bot', 'device', 'status', 'cacheStatus', 'source', 'ageMs', 'node', 'worker', 'conditional'],
			headers: ['user-agent'],
		},
	]);
	const before = Date.now();
	serve(urlOf(1), { req: { headers: new Headers({ 'user-agent': 'UA-1', 'if-none-match': '"x"' }) }, status: 304 });
	const { files, records } = await sampling.flushSamples();
	assert.equal(files, 1);
	assert.equal(records, 1);
	assert.deepEqual(filesOf('pdp'), [`${today()}.w003.ndjson.gz`]);
	const [record] = recordsOf('pdp');
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
	assert.deepEqual(countersOf('pdp'), [], 'no counters line when nothing was missed');
	// A second flush appends to the same file.
	serve(urlOf(2));
	await sampling.flushSamples();
	assert.equal(filesOf('pdp').length, 1);
	assert.equal(recordsOf('pdp').length, 2);
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
	const records = recordsOf('narrow');
	assert.equal(records.length, 1);
	assert.equal(records[0].url, urlOf(1));
	const counters = sampling.samplingWorkerState().counters.narrow;
	// `matched` counts the request filters; the URL filters run after the pick.
	assert.equal(counters.matched, 3);
	assert.equal(counters.picked, 1);
});

test('a urlPattern is never run against a URL past 8,192 characters', async () => {
	enable([{ name: 'long', match: { urlPattern: 'prd-' }, sample: { rate: 1 }, fields: ['url'] }]);
	serve(`${urlOf(1)}?q=${'x'.repeat(9000)}`);
	serve(urlOf(2));
	await sampling.flushSamples();
	assert.deepEqual(
		recordsOf('long').map((r) => r.url),
		[urlOf(2)]
	);
});

test('a route matches by its path or by its class', async () => {
	enable([{ name: 'pass', match: { routes: ['passthrough'] }, sample: { rate: 1 }, fields: ['route'] }]);
	serve(urlOf(1), { inf: { route: { path: '/static/', mode: 'passthrough' }, routeClass: 'passthrough' } });
	serve(urlOf(1));
	await sampling.flushSamples();
	assert.deepEqual(
		recordsOf('pass').map((r) => r.route),
		['/static/']
	);
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
	await settle();
	await sampling.flushSamples();
	const records = recordsOf('stable');
	const expected = urls.filter((url) => spec.urlIsSampled(url, { salt: 'revisit-1', rate: 0.2 }));
	assert.ok(expected.length > 20 && expected.length < 60, String(expected.length));
	const counters = sampling.samplingWorkerState().counters.stable;
	assert.equal(counters.picked, expected.length * 2);
	assert.equal(counters.dropped + counters.capped, 0);
	assert.deepEqual([...new Set(records.map((r) => r.url))].sort(), expected.sort());
	for (const url of expected) {
		const mine = records.filter((r) => r.url === url);
		assert.deepEqual(mine.map((r) => `${r.bot}/${r.device}`).sort(), ['Bingbot/desktop', 'Googlebot/mobile']);
	}
});

test('maxPerMinute: picks over the cap are counted in a counters line, once', async () => {
	enable([{ name: 'capped', sample: { rate: 1, by: 'request' }, maxPerMinute: 5, fields: ['url'] }]);
	for (let i = 0; i < 12; i++) serve(urlOf(i));
	await sampling.flushSamples();
	assert.equal(recordsOf('capped').length, 5);
	assert.deepEqual(countersOf('capped'), [{ capped: 7, dropped: 0, lost: 0 }]);
	// The next line carries only what was capped since (the 13th pick, same minute).
	serve(urlOf(99));
	await sampling.flushSamples();
	assert.deepEqual(countersOf('capped'), [
		{ capped: 7, dropped: 0, lost: 0 },
		{ capped: 1, dropped: 0, lost: 0 },
	]);
});

test('the cap window survives a config apply: an edit does not open a second one in the same minute', async () => {
	const samplers = [{ name: 'win', sample: { rate: 1, by: 'request' }, maxPerMinute: 2, fields: ['url'] }];
	enable(samplers);
	serve(urlOf(1));
	serve(urlOf(2));
	enable(samplers);
	serve(urlOf(3));
	await sampling.flushSamples();
	assert.equal(recordsOf('win').length, 2);
	assert.deepEqual(countersOf('win'), [{ capped: 1, dropped: 0, lost: 0 }]);
});

test('a full ring drops and counts, even for a sampler with no records in the batch', async () => {
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
	assert.deepEqual(recordsOf('late'), []);
	assert.deepEqual(countersOf('late'), [{ capped: 0, dropped: 2, lost: 0 }]);
	assert.equal(recordsOf('greedy').length, 64);
});

test('half full flushes on its own, off the request', async () => {
	enable([{ name: 'auto', sample: { rate: 1 }, fields: ['url'], maxPerMinute: 6000 }]);
	for (let i = 0; i < 31; i++) serve(urlOf(i));
	await settle();
	assert.equal(filesOf('auto').length, 0);
	serve(urlOf(31));
	assert.equal(filesOf('auto').length, 0, 'not inside the request');
	await settle();
	assert.equal(recordsOf('auto').length, 32);
});

test('a batch past one slice is written as several gzip members that read back as one stream', async () => {
	enable([{ name: 'big', sample: { rate: 1, by: 'request' }, fields: ['url'], maxPerMinute: 6000 }], {
		ringSize: 8192,
	});
	for (let i = 0; i < 3000; i++) serve(urlOf(i));
	await sampling.flushSamples();
	const records = recordsOf('big');
	assert.equal(records.length, 3000);
	assert.equal(records[2999].url, urlOf(2999));
});

test('records keep the sampler they were taken under across a config edit, targets included', async () => {
	targets.set(urlOf(2), { url: urlOf(2), state: 'active', sitemapUrl: 'https://www.example.com/sitemap.xml' });
	enable([{ name: 'edit', sample: { rate: 1 }, fields: ['url'] }]);
	serve(urlOf(1));
	enable([{ name: 'edit', sample: { rate: 1 }, fields: ['bot', 'target', 'sitemap'] }]);
	serve(urlOf(2));
	await sampling.flushSamples();
	assert.deepEqual(
		recordsOf('edit').map(({ ts, ...rest }) => rest),
		[{ url: urlOf(1) }, { bot: 'Googlebot', target: 'active', sitemap: true }]
	);
	// Counters survive the edit: they are kept by name.
	assert.equal(sampling.samplingWorkerState().counters.edit.picked, 2);
});

test('switching sampling off writes the records and the counters it held, and releases the ring', async () => {
	enable([{ name: 'bye', sample: { rate: 1, by: 'request' }, maxPerMinute: 1, fields: ['url'] }]);
	serve(urlOf(1));
	serve(urlOf(2));
	await sampling.flushSamples();
	serve(urlOf(3)); // capped again, with nothing in the ring
	applyOptions({ sampling: { enabled: false, directory: dir } });
	await settle();
	assert.equal(recordsOf('bye').length, 1);
	assert.deepEqual(countersOf('bye'), [
		{ capped: 1, dropped: 0, lost: 0 },
		{ capped: 1, dropped: 0, lost: 0 },
	]);
	serve(urlOf(4));
	await sampling.flushSamples();
	assert.equal(recordsOf('bye').length, 1);
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
	assert.equal(recordsOf('on').length, 1);
	assert.deepEqual(filesOf('off'), []);
});

test('target and sitemap are read at flush, once per distinct URL, with or without url recorded', async () => {
	targets.set(urlOf(1), { url: urlOf(1), state: 'active', sitemapUrl: 'https://www.example.com/sitemap.xml' });
	targets.set(urlOf(2), { url: urlOf(2), state: 'suppressed', sitemapUrl: null });
	enable([
		{ name: 'tgt', sample: { rate: 1 }, fields: ['url', 'target', 'sitemap'] },
		{ name: 'nourl', sample: { rate: 1 }, fields: ['bot', 'target', 'sitemap'] },
	]);
	serve(urlOf(1));
	serve(urlOf(1), { inf: { deviceType: 'desktop' } });
	serve(urlOf(2));
	serve(urlOf(3));
	assert.equal(targetReads, 0, 'never on the request');
	await sampling.flushSamples();
	assert.equal(targetReads, 6, 'three distinct URLs, for each of the two samplers');
	assert.deepEqual(
		recordsOf('tgt').map(({ url, target, sitemap }) => [url, target, sitemap]),
		[
			[urlOf(1), 'active', true],
			[urlOf(1), 'active', true],
			[urlOf(2), 'suppressed', false],
			[urlOf(3), null, false],
		]
	);
	assert.deepEqual(
		recordsOf('nourl').map(({ target, sitemap }) => [target, sitemap]),
		[
			['active', true],
			['active', true],
			['suppressed', false],
			[null, false],
		]
	);
	assert.equal('url' in recordsOf('nourl')[0], false);
});

test('origin-served records carry no age; a long header is cut to 512 characters', async () => {
	enable([{ name: 'age', sample: { rate: 1 }, fields: ['ageMs'], headers: ['user-agent'] }]);
	serve(urlOf(1), {
		inf: { source: 'origin', cacheStatus: 'miss' },
		req: { headers: new Headers({ 'user-agent': 'x'.repeat(900) }) },
	});
	serve(urlOf(2), { resource: null, status: 500 });
	await sampling.flushSamples();
	const [first, second] = recordsOf('age');
	assert.equal(first.ageMs, null);
	assert.equal(first.headers['user-agent'].length, 512);
	assert.equal(second.ageMs, null, 'a handler failure has no resource');
});

test('a sampler never throws into the request', () => {
	enable([{ name: 'safe', sample: { rate: 1 }, fields: ['url'] }]);
	assert.doesNotThrow(() => sampling.sampleRequest({ botName: 'Googlebot' }, { route: null }, null, 200, urlOf(1)));
	assert.doesNotThrow(() => sampling.sampleRequest(null, null, null, 200, urlOf(1)));
});

test('a failed append counts its records as lost and keeps the counters it carried, for the next line', async () => {
	const samplers = [{ name: 'fail', sample: { rate: 1, by: 'request' }, maxPerMinute: 1, fields: ['url'] }];
	// A directory that cannot be created: its parent is a file.
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, 'not-a-dir'), 'x');
	const good = dir;
	dir = join(root, 'not-a-dir', 'sub');
	enable(samplers);
	serve(urlOf(1)); // recorded
	serve(urlOf(2)); // capped
	await sampling.flushSamples();
	const state = sampling.samplingWorkerState().counters.fail;
	assert.equal(state.errors, 1);
	assert.equal(state.lost, 1);
	dir = good;
	enable(samplers);
	await sampling.flushSamples();
	assert.deepEqual(recordsOf('fail'), []);
	assert.deepEqual(countersOf('fail'), [{ capped: 1, dropped: 0, lost: 1 }]);
});

test('records land in the file of their own UTC day', async () => {
	enable([{ name: 'days', sample: { rate: 1, by: 'request' }, fields: ['url'] }]);
	const realNow = Date.now;
	const midnight = Date.UTC(2026, 9, 3);
	try {
		Date.now = () => midnight - 1000;
		serve(urlOf(1));
		Date.now = () => midnight + 1000;
		serve(urlOf(2));
	} finally {
		Date.now = realNow;
	}
	await sampling.flushSamples();
	assert.deepEqual(filesOf('days'), ['2026-10-02.w003.ndjson.gz', '2026-10-03.w003.ndjson.gz']);
});

test('the retention sweep deletes files older than keepDays in every sampler directory, and nothing else', async () => {
	enable([{ name: 'kept' }], { keepDays: 7 });
	const now = Date.UTC(2026, 9, 20, 12);
	const write = (name, file) => {
		mkdirSync(join(dir, name), { recursive: true });
		writeFileSync(join(dir, name, file), gzipSync('{}\n'));
	};
	write('kept', '2026-10-01.w000.ndjson.gz');
	write('kept', '2026-10-13.w000.ndjson.gz');
	write('kept', '2026-10-20.w001.ndjson.gz');
	write('removed-sampler', '2026-09-01.w000.ndjson.gz');
	write('kept', 'notes.txt');
	const { deleted } = await sampling.sweepSampleFiles(now);
	assert.equal(deleted, 2);
	assert.deepEqual(filesOf('kept'), ['2026-10-13.w000.ndjson.gz', '2026-10-20.w001.ndjson.gz', 'notes.txt']);
	assert.deepEqual(filesOf('removed-sampler'), []);
});

test('reading a file: members decode as one stream, a member being written keeps whole lines, output is bounded', async () => {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, 'f.ndjson.gz');
	const complete = Buffer.concat([gzipSync('{"a":1}\n{"a":2}\n'), gzipSync('{"a":3}\n')]);
	const partial = gzipSync('{"a":4}\n{"a":5}\n').subarray(0, 18);
	writeFileSync(path, Buffer.concat([complete, partial]));
	const text = (await sampling.readSampleFile(path)).toString();
	assert.ok(text.startsWith('{"a":1}\n{"a":2}\n{"a":3}\n'));
	assert.ok(text.endsWith('\n'));
	assert.deepEqual(await sampling.readSampleFile(path, { decode: false }), readFileSync(path));
	await assert.rejects(sampling.readSampleFile(path, { maxOutputLength: 8 }), RangeError);
});

test('the ring follows ringSize live, writing what the old ring held', async () => {
	enable([{ name: 'size', sample: { rate: 1 }, fields: ['url'] }]);
	serve(urlOf(1));
	enable([{ name: 'size', sample: { rate: 1 }, fields: ['url'] }], { ringSize: 128 });
	assert.equal(sampling.samplingWorkerState().ring.size, 128);
	await settle();
	assert.equal(recordsOf('size').length, 1);
	assert.equal(config.sampling.ringSize, 128);
});

test('listSampleFiles and the summary read only this sampler’s well-formed files', async () => {
	enable([{ name: 'list', sample: { rate: 1 }, fields: ['url'] }]);
	serve(urlOf(1));
	await sampling.flushSamples();
	writeFileSync(join(dir, 'list', 'stray.gz'), 'x');
	const files = await sampling.listSampleFiles('list');
	assert.deepEqual(
		files.map((f) => f.name),
		[`${today()}.w003.ndjson.gz`]
	);
	assert.deepEqual(await sampling.listSampleFiles('../list'), [], 'not a sampler name');
	const summary = await sampling.sampleFileSummary(['list', 'none']);
	assert.equal(summary.list.files, 1);
	assert.ok(summary.list.bytes > 0);
	assert.deepEqual(summary.none, { files: 0, bytes: 0, firstDay: null, lastDay: null });
});
