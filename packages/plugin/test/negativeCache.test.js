import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * `util/negativeCache.js` — answering repeat requests for dead URLs from the origin's own stored 404.
 *
 * WHAT MUST NEVER HAPPEN, and each is pinned below:
 *   - A LIVE PAGE ANSWERED WITH A 404. A sitemap-listed Target overrules a stored 404 on every read; a
 *     200 from the origin — proxied or re-checked — drops the entry; an unreadable timestamp is expired,
 *     never "fresh forever".
 *   - OFFLOAD THAT IS NOT REAL. A stored answer whose background re-check went to the origin is source
 *     `origin`, so gross offload cannot rise while the origin does the same work.
 *   - A DRY RUN THAT OVERCOUNTS. It refreshes the fresh window only where an armed cache would have asked
 *     the origin, so `would-serve` is exactly what arming saves; and it counts the requests an armed
 *     cache would have answered wrongly (`would-serve-live`), which is the number to arm on.
 *   - A SICK ORIGIN SEEING MORE REQUESTS. Re-checks are one per key and capped per worker; a failed one
 *     keeps the entry answering.
 */

let nc;
let config;
let applyOptions;
const rows = new Map();
const ops = [];
const writes = [];
const targets = new Map();
let failTarget = false;

class TargetBase {
	static async get({ id }) {
		if (failTarget) throw new Error('target read failed');
		return targets.get(id) ?? null;
	}
	static search() {
		return (async function* () {})();
	}
}

const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const HOUR = 3_600_000;
const URL_A = 'https://www.example.com/product/prd-1/gone.jsp';
const KEY_A = `${URL_A}|desktop`;

before(async () => {
	globalThis.server = {
		hostname: 'test-node',
		nodes: [],
		config: { http: { port: 9926 } },
		recordAnalytics: (value, metric, path, method, type) => ops.push({ value, metric, path, method, type }),
	};
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
		negative_cache: {
			NegativePage: {
				async get(id) {
					if (id === 'THROWS') throw new Error('storage fault');
					return rows.has(id) ? { ...rows.get(id) } : null;
				},
				async put(id, data) {
					writes.push(['put', id]);
					rows.set(id, { cacheKey: id, ...data });
				},
				async patch(id, data) {
					writes.push(['patch', id]);
					rows.set(id, { ...(rows.get(id) ?? {}), ...data });
				},
				async delete(id) {
					writes.push(['delete', id]);
					rows.delete(id);
				},
			},
		},
	};
	({ config, applyOptions } = await import('../src/config.js'));
	nc = await import('../src/util/negativeCache.js');
});

beforeEach(() => {
	rows.clear();
	ops.length = 0;
	writes.length = 0;
	targets.clear();
	failTarget = false;
	applyOptions({ render: { negative: { enabled: true, dryRun: false } } });
});

const policy = (over = {}) => ({ ...config.render.negative, ...over });
const opsOf = (path) => ops.filter((o) => o.metric === 'prerender_ops' && o.path === path).map((o) => o.method);
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

// A web stream carrying `text`, the shape `fetchOriginResource` hands over.
const streamOf = (text) =>
	new ReadableStream({
		start(controller) {
			if (text) controller.enqueue(new TextEncoder().encode(text));
			controller.close();
		},
	});
const drain = async (stream) => new Response(stream).text();

const origin404 = (over = {}) => ({
	miss: true,
	statusCode: 404,
	url: URL_A,
	deviceType: 'desktop',
	headers: { 'content-type': 'text/html', 'content-encoding': 'gzip', 'content-length': '11' },
	content: streamOf('ITEM-GONE-1'),
	...over,
});

const storedRow = (over = {}) => ({
	cacheKey: KEY_A,
	statusCode: 404,
	headers: JSON.stringify({ 'content-type': 'text/html' }),
	content: Buffer.from('STORED-404'),
	storedAt: new Date(NOW - 3 * HOUR),
	checkedAt: new Date(NOW - 10 * 60_000),
	expiresAt: new Date(Date.now() + 5 * HOUR),
	...over,
});

// ── policy, keys, bots ───────────────────────────────────────────────────────────────────────

test('the policy needs the master switch AND the route opt-in — either alone is inert', () => {
	assert.ok(nc.negativeCachePolicy({ negativeCache: true }));
	assert.equal(nc.negativeCachePolicy({ negativeCache: false }), null);
	assert.equal(nc.negativeCachePolicy(null), null);
	applyOptions({ render: { negative: { enabled: false } } });
	assert.equal(nc.negativeCachePolicy({ negativeCache: true }), null);
});

test('the key is per device by default and the device-free URL under deviceIndependent', () => {
	assert.equal(nc.negativeKeyOf({ cacheKey: KEY_A, cacheUrl: URL_A }, policy()), KEY_A);
	assert.equal(nc.negativeKeyOf({ cacheKey: KEY_A, cacheUrl: URL_A }, policy({ deviceIndependent: true })), URL_A);
});

test('excludeBots is matched case-insensitively, and an edit to the list takes effect', () => {
	const p = policy({ excludeBots: ['Googlebot', 'Storebot-Google'] });
	assert.equal(nc.botMayReadNegative('googlebot', p), false);
	assert.equal(nc.botMayReadNegative('STOREBOT-GOOGLE', p), false);
	assert.equal(nc.botMayReadNegative('Bingbot', p), true);
	assert.equal(nc.botMayReadNegative(undefined, p), true);
	assert.equal(nc.botMayReadNegative('Googlebot', policy({ excludeBots: [] })), true, 'a new list is recompiled');
});

// ── the three windows ────────────────────────────────────────────────────────────────────────

test('freshness: fresh inside freshMs, revalidate inside lifeMs, expired after', () => {
	const p = policy({ freshMs: HOUR, lifeMs: 6 * HOUR });
	assert.equal(nc.negativeFreshness({ checkedAt: new Date(NOW - 59 * 60_000) }, p, NOW), 'fresh');
	assert.equal(nc.negativeFreshness({ checkedAt: new Date(NOW - HOUR) }, p, NOW), 'revalidate');
	assert.equal(nc.negativeFreshness({ checkedAt: new Date(NOW - 6 * HOUR + 1) }, p, NOW), 'revalidate');
	assert.equal(nc.negativeFreshness({ checkedAt: new Date(NOW - 6 * HOUR) }, p, NOW), 'expired');
});

test('an unreadable or future checkedAt is EXPIRED — never a row that answers forever', () => {
	const p = policy();
	for (const checkedAt of [null, undefined, 'garbage', new Date(NaN), new Date(NOW + 60_000)]) {
		assert.equal(nc.negativeFreshness({ checkedAt }, p, NOW), 'expired', String(checkedAt));
	}
});

test('a read returns nothing for an absent, expired or partial row, and a throwing read is a miss', async () => {
	assert.equal(await nc.readNegativePage('absent'), null);
	rows.set('expired', storedRow({ expiresAt: new Date(Date.now() - 1) }));
	assert.equal(await nc.readNegativePage('expired'), null);
	// A confirm (patch) racing a drop leaves only timestamps: not an answer.
	rows.set('partial', { checkedAt: new Date(), expiresAt: new Date(Date.now() + HOUR) });
	assert.equal(await nc.readNegativePage('partial'), null);
	assert.equal(await nc.readNegativePage('THROWS'), null);
	rows.set(KEY_A, storedRow());
	assert.equal((await nc.readNegativePage(KEY_A)).statusCode, 404);
});

// ── what may be stored ───────────────────────────────────────────────────────────────────────

test('every refusal names itself, and the switches widen only their own refusal', () => {
	const p = policy();
	assert.equal(nc.negativeStoreRefusal(origin404(), p), null);
	assert.equal(nc.negativeStoreRefusal(origin404({ statusCode: 200 }), p), 'not-negative');
	assert.equal(nc.negativeStoreRefusal(origin404({ statusCode: 503 }), p), 'not-negative');
	assert.equal(nc.negativeStoreRefusal(origin404({ viaStaging: true }), p), 'staging');
	assert.equal(nc.negativeStoreRefusal(origin404({ hadSetCookie: true }), p), 'has-cookie');
	const priv = origin404({ headers: { 'cache-control': 'private, max-age=0' } });
	assert.equal(nc.negativeStoreRefusal(priv, p), 'private');
	const noStore = origin404({ headers: { 'cache-control': 'max-age=0, no-cache, no-store' } });
	assert.equal(nc.negativeStoreRefusal(noStore, p), 'no-store');

	assert.equal(nc.negativeStoreRefusal(origin404({ hadSetCookie: true }), policy({ assumeShared: true })), null);
	assert.equal(nc.negativeStoreRefusal(priv, policy({ assumeShared: true })), null);
	assert.equal(
		nc.negativeStoreRefusal(noStore, policy({ assumeShared: true })),
		'no-store',
		'assumeShared is not ignoreNoStore'
	);
	assert.equal(nc.negativeStoreRefusal(noStore, policy({ ignoreNoStore: true })), null);
	assert.equal(nc.negativeStoreRefusal(origin404({ statusCode: 410 }), p), null, '410 is kept by default');
});

test('a proxied 404 is captured, delivered in full, and stored with its windows set from now', async () => {
	const before = Date.now();
	const out = nc.captureForNegativeCache(origin404(), { key: KEY_A, cacheUrl: URL_A, policy: policy() });
	assert.equal(await drain(out.content), 'ITEM-GONE-1', 'the crawler gets every byte');
	await settle();
	const row = rows.get(KEY_A);
	assert.ok(row, 'stored');
	assert.equal(row.statusCode, 404);
	assert.equal(Buffer.from(row.content).toString(), 'ITEM-GONE-1');
	assert.deepEqual(
		JSON.parse(row.headers),
		{ 'content-type': 'text/html', 'content-encoding': 'gzip' },
		'no content-length'
	);
	assert.ok(row.checkedAt.getTime() >= before && row.storedAt.getTime() === row.checkedAt.getTime());
	assert.equal(row.expiresAt.getTime() - row.checkedAt.getTime(), config.render.negative.lifeMs);
	assert.deepEqual(opsOf('negative_cache'), ['stored']);
});

test('a URL a sitemap lists is never stored, and neither is one with any Target under skipTargets: any', async () => {
	targets.set(URL_A, { sitemapUrl: 'https://www.example.com/sitemap_product_1.xml' });
	const out = nc.captureForNegativeCache(origin404(), { key: KEY_A, cacheUrl: URL_A, policy: policy() });
	await drain(out.content);
	await settle();
	assert.equal(rows.size, 0);
	assert.deepEqual(opsOf('negative_cache'), ['skipped-listed']);

	targets.set(URL_A, { state: 'suppressed' });
	ops.length = 0;
	await drain(nc.captureForNegativeCache(origin404(), { key: KEY_A, cacheUrl: URL_A, policy: policy() }).content);
	await settle();
	assert.equal(rows.size, 1, 'an unlisted Target is stored under the default');
	rows.clear();
	ops.length = 0;
	const any = policy({ skipTargets: 'any' });
	await drain(nc.captureForNegativeCache(origin404(), { key: KEY_A, cacheUrl: URL_A, policy: any }).content);
	await settle();
	assert.equal(rows.size, 0);
	assert.deepEqual(opsOf('negative_cache'), ['skipped-target']);
});

test('an empty body is not stored, and a refused response is returned untouched with its body never teed', async () => {
	await drain(
		nc.captureForNegativeCache(origin404({ content: streamOf('') }), { key: KEY_A, cacheUrl: URL_A, policy: policy() })
			.content
	);
	await settle();
	assert.equal(rows.size, 0);
	assert.deepEqual(opsOf('negative_cache'), ['empty']);

	const refused = origin404({ hadSetCookie: true });
	assert.equal(nc.captureForNegativeCache(refused, { key: KEY_A, cacheUrl: URL_A, policy: policy() }), refused);
});

test('a tee that throws costs neither the response nor a capture slot', async () => {
	const locked = streamOf('ITEM-GONE-1');
	locked.getReader();
	const resource = origin404({ content: locked });
	const out = nc.captureForNegativeCache(resource, { key: KEY_A, cacheUrl: URL_A, policy: policy() });
	assert.equal(out, resource, 'the response is handed back untouched');
	assert.equal(nc.negativeCaptureSlotsInUse(), 0);
	assert.deepEqual(opsOf('negative_cache'), ['capture-failed']);
});

test('the capture cap is honoured and released on every path', async () => {
	const p = policy({ maxConcurrentCaptures: 1 });
	let release;
	const slow = new ReadableStream({
		start: (c) => (release = () => (c.enqueue(new TextEncoder().encode('X')), c.close())),
	});
	const first = nc.captureForNegativeCache(origin404({ content: slow }), { key: KEY_A, cacheUrl: URL_A, policy: p });
	const second = nc.captureForNegativeCache(origin404(), { key: 'other', cacheUrl: URL_A, policy: p });
	assert.deepEqual(opsOf('negative_cache'), ['capture-busy']);
	assert.equal(typeof second.content.tee, 'function', 'served untouched');
	release();
	await drain(first.content);
	await settle();
	assert.equal(nc.negativeCaptureSlotsInUse(), 0);
});

// ── answering ────────────────────────────────────────────────────────────────────────────────

const answer = (over = {}) =>
	nc.answerFromNegativeCache({
		key: KEY_A,
		cacheUrl: URL_A,
		url: URL_A,
		deviceType: 'desktop',
		method: 'GET',
		botName: 'Bingbot',
		policy: policy(),
		nowMs: NOW,
		recheck: () => assert.fail('no re-check inside the fresh window'),
		...over,
	});

test('inside the fresh window: answered from storage, source negative, and nobody is asked', async () => {
	rows.set(KEY_A, storedRow({ checkedAt: new Date(NOW - 10 * 60_000) }));
	const got = await answer();
	assert.equal(got.answered, true);
	assert.equal(got.cacheStatus, 'negative');
	assert.equal(got.source, 'negative');
	assert.equal(got.resource.statusCode, 404);
	assert.equal(got.body.toString(), 'STORED-404');
	assert.deepEqual(opsOf('negative_gap').length, 1);
	assert.equal(ops.find((o) => o.path === 'negative_gap').value, 10 * 60_000, 'the gap since the last confirmation');
});

test('past the fresh window: answered AT ONCE, and counted as origin when THIS request started the re-check', async () => {
	rows.set(KEY_A, storedRow({ checkedAt: new Date(NOW - 2 * HOUR) }));
	let asked = null;
	const got = await answer({ recheck: (args) => ((asked = args), true) });
	assert.equal(got.answered, true);
	assert.equal(got.cacheStatus, 'negative-revalidate');
	assert.equal(got.source, 'origin', 'the origin did the work, so offload counts it against');
	assert.equal(asked.key, KEY_A);
	assert.equal(asked.url, URL_A);

	// Joined an in-flight check, or the cap was reached: nobody asked the origin for THIS request.
	const joined = await answer({ recheck: () => false });
	assert.equal(joined.cacheStatus, 'negative');
	assert.equal(joined.source, 'negative');
});

test('an excluded bot is never answered, but its request is carried so its 404 still confirms the entry', async () => {
	rows.set(KEY_A, storedRow());
	const got = await answer({ botName: 'Googlebot', policy: policy({ excludeBots: ['Googlebot'] }) });
	assert.equal(got.answered, undefined);
	assert.equal(got.excluded, true);
	assert.deepEqual(opsOf('negative_cache'), ['bot-excluded']);
});

test('a Target a sitemap lists overrules a stored 404 on READ, and the entry is dropped', async () => {
	rows.set(KEY_A, storedRow());
	targets.set(URL_A, { sitemapUrl: 'https://www.example.com/sitemap_product_1.xml' });
	const got = await answer();
	assert.equal(got.answered, undefined);
	assert.equal(got.row, null);
	await settle();
	assert.equal(rows.has(KEY_A), false);
	assert.deepEqual(opsOf('negative_cache'), ['guarded-listed']);
});

test('a guard read that fails proxies (fail closed) and leaves the entry alone', async () => {
	rows.set(KEY_A, storedRow());
	failTarget = true;
	const got = await answer();
	assert.equal(got.answered, undefined);
	assert.equal(got.excluded, true);
	assert.equal(rows.has(KEY_A), true);
	assert.deepEqual(opsOf('negative_cache'), ['guard-error']);
});

test('an invalidation newer than the last confirmation refuses the entry, so it is stored afresh', async () => {
	rows.set(KEY_A, storedRow({ checkedAt: new Date(NOW - 10 * 60_000) }));
	const got = await answer({ epochOf: async () => ({ at: NOW - 60_000 }) });
	assert.equal(got.answered, undefined);
	assert.equal(got.verdict, 'expired');
	assert.deepEqual(opsOf('negative_cache'), ['invalidated']);
	const older = await answer({ epochOf: async () => ({ at: NOW - HOUR }) });
	assert.equal(older.answered, true, 'an epoch older than the confirmation changes nothing');
});

test('an invalidation refuses the entry for an EXCLUDED bot too, so its proxied 404 re-stores rather than confirms', async () => {
	const row = storedRow({ checkedAt: new Date(NOW - 10 * 60_000) });
	rows.set(KEY_A, row);
	const lookup = await answer({
		botName: 'Googlebot',
		policy: policy({ excludeBots: ['Googlebot'] }),
		epochOf: async () => ({ at: NOW - 60_000 }),
	});
	assert.equal(lookup.verdict, 'expired');
	assert.deepEqual(opsOf('negative_cache'), ['invalidated'], 'decided before the bot check');
	// Confirming here would move checkedAt past the epoch and make the pre-invalidation bytes answerable.
	const out = nc.afterNegativeProxy(origin404(), {
		key: KEY_A,
		cacheUrl: URL_A,
		policy: policy({ excludeBots: ['Googlebot'] }),
		lookup,
		nowMs: NOW,
	});
	await drain(out.content);
	await settle();
	assert.deepEqual(writes, [['put', KEY_A]]);
	assert.equal(rows.get(KEY_A).content.toString(), 'ITEM-GONE-1');
});

test('a body that cannot be read proxies instead of committing a 404 with no bytes', async () => {
	rows.set(KEY_A, storedRow({ content: { bytes: async () => Promise.reject(new Error('Blob file not found')) } }));
	const got = await answer();
	assert.equal(got.answered, undefined);
	assert.equal(got.verdict, 'expired');
	assert.deepEqual(opsOf('negative_cache'), ['read-blob-failed']);
});

test('a DRY RUN never answers; it counts would-serve and would-revalidate instead', async () => {
	const dry = policy({ dryRun: true });
	rows.set(KEY_A, storedRow({ checkedAt: new Date(NOW - 10 * 60_000) }));
	const fresh = await answer({ policy: dry });
	assert.equal(fresh.answered, undefined);
	assert.equal(fresh.verdict, 'fresh');
	rows.set(KEY_A, storedRow({ checkedAt: new Date(NOW - 2 * HOUR) }));
	const stale = await answer({
		policy: dry,
		recheck: () => assert.fail('a dry run never re-checks in the background'),
	});
	assert.equal(stale.verdict, 'revalidate');
	assert.deepEqual(opsOf('negative_cache'), ['would-serve', 'would-revalidate']);
});

// ── after a proxy ────────────────────────────────────────────────────────────────────────────

test('after a proxied 404 with no entry: captured and stored', async () => {
	const out = nc.afterNegativeProxy(origin404(), {
		key: KEY_A,
		cacheUrl: URL_A,
		policy: policy(),
		lookup: { row: null },
	});
	await drain(out.content);
	await settle();
	assert.equal(rows.has(KEY_A), true);
});

test('a dry run refreshes the window ONLY where an armed cache would have asked the origin', async () => {
	const dry = policy({ dryRun: true });
	const row = storedRow();
	rows.set(KEY_A, row);
	nc.afterNegativeProxy(origin404(), {
		key: KEY_A,
		cacheUrl: URL_A,
		policy: dry,
		lookup: { row, verdict: 'fresh' },
		nowMs: NOW,
	});
	await settle();
	assert.deepEqual(writes, [], 'armed would have answered from storage: no confirmation');

	nc.afterNegativeProxy(origin404(), {
		key: KEY_A,
		cacheUrl: URL_A,
		policy: dry,
		lookup: { row, verdict: 'revalidate' },
		nowMs: NOW,
	});
	await settle();
	assert.deepEqual(writes, [['patch', KEY_A]], 'armed would have re-checked: this proxy is that check');

	writes.length = 0;
	nc.afterNegativeProxy(origin404(), {
		key: KEY_A,
		cacheUrl: URL_A,
		policy: dry,
		lookup: { row, verdict: 'fresh', excluded: true },
		nowMs: NOW,
	});
	await settle();
	assert.deepEqual(writes, [['patch', KEY_A]], 'an excluded bot always asks the origin, armed or not');
});

test('THE RISK NUMBER: a dry run counts would-serve-live when the origin answers 200 for a stored 404', async () => {
	const dry = policy({ dryRun: true });
	const row = storedRow();
	rows.set(KEY_A, row);
	nc.afterNegativeProxy(origin404({ statusCode: 200 }), {
		key: KEY_A,
		cacheUrl: URL_A,
		policy: dry,
		lookup: { row, verdict: 'fresh' },
	});
	await settle();
	assert.deepEqual(opsOf('negative_cache'), ['would-serve-live']);
	assert.equal(rows.has(KEY_A), false, 'and the wrong entry is dropped');
});

test('a proxied 200 or redirect drops the entry; a 5xx leaves it', async () => {
	for (const [statusCode, kept] of [
		[200, false],
		[301, false],
		[503, true],
	]) {
		const row = storedRow();
		rows.set(KEY_A, row);
		nc.afterNegativeProxy(origin404({ statusCode }), {
			key: KEY_A,
			cacheUrl: URL_A,
			policy: policy(),
			lookup: { row, verdict: 'expired' },
		});
		await settle();
		assert.equal(rows.has(KEY_A), kept, `status ${statusCode}`);
	}
});

// ── the background re-check ──────────────────────────────────────────────────────────────────

test('a re-check that finds the 404 again restarts the fresh window without rewriting the body', async () => {
	rows.set(KEY_A, storedRow({ checkedAt: new Date(NOW - 2 * HOUR) }));
	const outcome = await nc.settleNegativeRecheck({
		key: KEY_A,
		cacheUrl: URL_A,
		statusCode: 404,
		policy: policy(),
		nowMs: NOW,
	});
	assert.equal(outcome, 'gone');
	assert.equal(rows.get(KEY_A).checkedAt.getTime(), NOW);
	assert.equal(rows.get(KEY_A).expiresAt.getTime(), NOW + config.render.negative.lifeMs);
	assert.equal(rows.get(KEY_A).content.toString(), 'STORED-404', 'the stored body is untouched');
	assert.deepEqual(writes, [['patch', KEY_A]]);
});

test('a re-check that finds the page live drops the entry and reports the URL to reopen', async () => {
	rows.set(KEY_A, storedRow());
	const live = [];
	const outcome = await nc.settleNegativeRecheck({
		key: KEY_A,
		cacheUrl: URL_A,
		statusCode: 200,
		policy: policy(),
		onLive: (u) => live.push(u),
	});
	assert.equal(outcome, 'live');
	assert.equal(rows.has(KEY_A), false);
	assert.deepEqual(live, [URL_A]);
	assert.deepEqual(opsOf('negative_cache'), ['recheck-live']);
});

test('a redirect drops the entry; an origin failure keeps it answering (stale-if-error)', async () => {
	rows.set(KEY_A, storedRow());
	assert.equal(
		await nc.settleNegativeRecheck({ key: KEY_A, cacheUrl: URL_A, statusCode: 301, policy: policy() }),
		'moved'
	);
	assert.equal(rows.has(KEY_A), false);
	rows.set(KEY_A, storedRow());
	for (const statusCode of [500, 503, 429, 403, 0]) {
		assert.equal(
			await nc.settleNegativeRecheck({ key: KEY_A, cacheUrl: URL_A, statusCode, policy: policy() }),
			'error'
		);
	}
	assert.equal(rows.has(KEY_A), true);
});

test('a re-check is a HEAD with reason revalidate, one per key, capped, and always releases its slot', async () => {
	rows.set(KEY_A, storedRow());
	const calls = [];
	let answer404;
	const fetchOrigin = (args) => {
		calls.push(args);
		return new Promise((resolve) => (answer404 = () => resolve({ statusCode: 404, content: streamOf('') })));
	};
	const p = policy({ maxConcurrentChecks: 1 });
	assert.equal(
		nc.startNegativeRecheck({ key: KEY_A, url: URL_A, cacheUrl: URL_A, deviceType: 'mobile', policy: p, fetchOrigin }),
		true
	);
	assert.equal(
		nc.startNegativeRecheck({ key: KEY_A, url: URL_A, cacheUrl: URL_A, deviceType: 'mobile', policy: p, fetchOrigin }),
		false
	);
	assert.equal(
		nc.startNegativeRecheck({
			key: 'other',
			url: URL_A,
			cacheUrl: URL_A,
			deviceType: 'mobile',
			policy: p,
			fetchOrigin,
		}),
		false
	);
	assert.deepEqual(opsOf('negative_cache'), ['recheck-joined', 'recheck-busy']);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].method, 'HEAD');
	assert.equal(calls[0].reason, 'revalidate');
	assert.equal(calls[0].deviceType, 'mobile');
	assert.equal(calls[0].headers.get('x-anything'), null, 'no request header can switch a re-check to staging');
	answer404();
	await settle();
	assert.equal(nc.negativeRechecksInFlight(), 0);

	const failing = () => Promise.reject(new Error('connect timeout'));
	assert.equal(
		nc.startNegativeRecheck({
			key: KEY_A,
			url: URL_A,
			cacheUrl: URL_A,
			deviceType: 'desktop',
			policy: p,
			fetchOrigin: failing,
		}),
		true
	);
	await settle();
	assert.equal(nc.negativeRechecksInFlight(), 0, 'a failed fetch releases the slot too');
	assert.ok(opsOf('negative_cache').includes('recheck-error'));
	assert.equal(rows.has(KEY_A), true, 'and the entry keeps answering');
});

// ── the body's own life ──────────────────────────────────────────────────────────────────────

test('a body older than lifeMs is outlived; an unreadable storedAt counts as outlived', () => {
	const p = policy({ lifeMs: 6 * HOUR });
	assert.equal(nc.negativeBodyExpired(storedRow({ storedAt: new Date(NOW - 5 * HOUR) }), p, NOW), false);
	assert.equal(nc.negativeBodyExpired(storedRow({ storedAt: new Date(NOW - 6 * HOUR) }), p, NOW), true);
	assert.equal(nc.negativeBodyExpired(storedRow({ storedAt: null }), p, NOW), true);
});

test('a re-check of an outlived body asks for it: the lookup passes refreshBody only then', async () => {
	const seen = [];
	const recheck = (args) => (seen.push(args.refreshBody), true);
	rows.set(KEY_A, storedRow({ checkedAt: new Date(NOW - 2 * HOUR), storedAt: new Date(NOW - 3 * HOUR) }));
	await answer({ recheck });
	rows.set(KEY_A, storedRow({ checkedAt: new Date(NOW - 2 * HOUR), storedAt: new Date(NOW - 20 * HOUR) }));
	await answer({ recheck });
	assert.deepEqual(seen, [false, true]);
});

test('a refreshing re-check is a GET whose 404 replaces the stored body and restarts both clocks', async () => {
	rows.set(KEY_A, storedRow({ storedAt: new Date(NOW - 20 * HOUR) }));
	const calls = [];
	const fetchOrigin = async (args) => (calls.push(args), origin404({ content: streamOf('ITEM-GONE-2') }));
	assert.equal(
		nc.startNegativeRecheck({
			key: KEY_A,
			url: URL_A,
			cacheUrl: URL_A,
			deviceType: 'desktop',
			policy: policy(),
			refreshBody: true,
			fetchOrigin,
		}),
		true
	);
	await settle();
	assert.equal(calls[0].method, 'GET');
	assert.equal(calls[0].reason, 'revalidate');
	assert.deepEqual(writes, [['put', KEY_A]], 'stored whole, not patched');
	const row = rows.get(KEY_A);
	assert.equal(row.content.toString(), 'ITEM-GONE-2');
	assert.ok(Date.now() - row.storedAt.getTime() < 60_000, 'the new bytes are dated now');
	assert.equal(row.checkedAt.getTime(), row.storedAt.getTime());
	assert.deepEqual(opsOf('negative_cache'), ['recheck-gone', 'stored']);
	assert.equal(nc.negativeRechecksInFlight(), 0);
});

test('a refreshing re-check that finds the page live drops the entry and reopens, like a HEAD', async () => {
	rows.set(KEY_A, storedRow({ storedAt: new Date(NOW - 20 * HOUR) }));
	let cancelled = false;
	const content = new ReadableStream({ cancel: () => void (cancelled = true) });
	const live = [];
	nc.startNegativeRecheck({
		key: KEY_A,
		url: URL_A,
		cacheUrl: URL_A,
		deviceType: 'desktop',
		policy: policy(),
		refreshBody: true,
		onLive: (u) => live.push(u),
		fetchOrigin: async () => ({ statusCode: 200, headers: {}, content }),
	});
	await settle();
	assert.equal(rows.has(KEY_A), false);
	assert.deepEqual(live, [URL_A]);
	assert.equal(cancelled, true, 'a live body nobody stores is closed, not read');
});

test('an outlived body the origin now refuses, or sends empty, is dropped — never confirmed', async () => {
	for (const [resource, reason] of [
		[origin404({ headers: { 'content-type': 'text/html', 'cache-control': 'private' } }), 'private'],
		[origin404({ content: streamOf('') }), 'empty'],
	]) {
		rows.set(KEY_A, storedRow({ storedAt: new Date(NOW - 20 * HOUR) }));
		ops.length = 0;
		assert.equal(await nc.refreshNegativeBody({ key: KEY_A, resource, policy: policy() }), 'dropped');
		assert.equal(rows.has(KEY_A), false, reason);
		assert.deepEqual(opsOf('negative_cache'), ['recheck-gone', reason]);
	}
});

test("an excluded bot's proxied 404 replaces an outlived body instead of confirming it", async () => {
	const row = storedRow({ storedAt: new Date(NOW - 20 * HOUR) });
	rows.set(KEY_A, row);
	const out = nc.afterNegativeProxy(origin404(), {
		key: KEY_A,
		cacheUrl: URL_A,
		policy: policy(),
		lookup: { row, verdict: 'fresh', excluded: true },
		nowMs: NOW,
	});
	await drain(out.content);
	await settle();
	assert.deepEqual(writes, [['put', KEY_A]]);
	assert.equal(rows.get(KEY_A).content.toString(), 'ITEM-GONE-1');
});

test('the guard reads the Target once, locally: listed, any Target, or nothing', async () => {
	assert.equal(await nc.targetGuard(URL_A, policy()), null);
	targets.set(URL_A, { state: 'suppressed', sitemapUrl: null });
	assert.equal(await nc.targetGuard(URL_A, policy()), null);
	assert.equal(await nc.targetGuard(URL_A, policy({ skipTargets: 'any' })), 'target');
	targets.set(URL_A, { sitemapUrl: 'https://www.example.com/s.xml' });
	assert.equal(await nc.targetGuard(URL_A, policy()), 'listed');
	failTarget = true;
	assert.equal(await nc.targetGuard(URL_A, policy()), 'error');
});

// ── the schema ───────────────────────────────────────────────────────────────────────────────

test('NegativePage is node-local, expiring by its own field, and its database has a replicated anchor', () => {
	const schema = fs.readFileSync(fileURLToPath(new URL('../src/schemas/schema.graphql', import.meta.url)), 'utf8');
	const table = schema.match(/type NegativePage @table\(([^)]*)\)[^{]*\{([^}]*)\}/);
	assert.ok(table, 'NegativePage is declared');
	assert.match(table[1], /database: "negative_cache"/);
	assert.match(table[1], /replicate: false/, 'node-local: the traffic that repeats is pinned to one node');
	assert.match(table[2], /expiresAt: Date @expiresAt/, 'the stored life governs reclaim, not the table default');
	assert.match(table[2], /checkedAt: Date/);
	assert.doesNotMatch(table[0], /@export/, 'no REST write verb may put a 404 under a cache key');
	assert.match(schema, /type NegativePageAnchor @table\(database: "negative_cache"\)/, 'harper-pro#685');
});
