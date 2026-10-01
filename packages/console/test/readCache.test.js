/**
 * The read cache's contract (util/readCache.js), against a fake table and a hand-driven clock.
 *
 * The two properties everything else serves: an answer is shared between operators ONLY after the
 * node confirms the second one's own token, and an answer older than its data's TTL — or than a write
 * made through the console — is never served.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
	createReadCache,
	DEFAULT_READ_TTL,
	GENERATION_KEY,
	MAX_CACHED_BODY,
	READ_ONLY_POST,
	READ_TTL,
	UNCACHED_READS,
	VERIFY_MS,
} from '../src/util/readCache.js';
import { PROXIED_GET, PROXIED_POST } from '../src/util/proxy.js';

const A = 'https://node-a.example.com:9926';
const B = 'https://node-b.example.com:9926';

/** A Map standing in for the ProxyRead table: one instance is "the host", shared by every worker. */
function fakeTable() {
	const rows = new Map();
	return {
		rows,
		get: async (key) => rows.get(key) ?? null,
		put: async (key, record) => {
			rows.set(key, Object.freeze({ key, ...record }));
		},
	};
}

/**
 * One worker's cache over a shared table. `answers` maps a path to what the node says; `goodTokens`
 * are the tokens the node accepts as a super_user. Every fetch and verify is recorded.
 */
function worker({ table, clock, answers = {}, goodTokens = ['tok-1', 'tok-2'], enabled = true }) {
	const fetches = [];
	const verifies = [];
	const detached = [];
	const cache = createReadCache({
		table: () => table,
		fetch: async (origin, path, cookie) => {
			fetches.push({ origin, path, cookie });
			const answer = typeof answers[path] === 'function' ? await answers[path](cookie) : answers[path];
			if (answer instanceof Error) throw answer;
			if (!goodTokens.includes(cookie)) return raw(401, { error: 'Authentication required' });
			return answer ?? raw(404, { error: `Unknown route: ${path}` });
		},
		verify: async (origin, cookie) => {
			verifies.push({ origin, cookie });
			return goodTokens.includes(cookie);
		},
		detach: (fn) => {
			detached.push(fn);
			return fn();
		},
		enabled: () => enabled,
		now: () => clock.now,
	});
	return { cache, fetches, verifies, detached };
}

const raw = (status, body, contentType = 'application/json; charset=utf-8') => ({
	status,
	contentType,
	body: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
});

/** Let the detached table writes settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a second read inside the TTL is answered from the table, not the node', async () => {
	const table = fakeTable();
	const clock = { now: 1_000_000 };
	const w = worker({ table, clock, answers: { overview: raw(200, { generatedAt: 1 }) } });

	const first = await w.cache.read(A, 'overview', '', 'tok-1');
	assert.equal(first.cached, false);
	assert.deepEqual(first.payload, { generatedAt: 1 });
	await settle();

	clock.now += DEFAULT_READ_TTL - 1;
	const second = await w.cache.read(A, 'overview', '', 'tok-1');
	assert.equal(second.cached, true);
	assert.equal(second.ageMs, DEFAULT_READ_TTL - 1);
	assert.deepEqual(second.payload, { generatedAt: 1 });
	assert.equal(w.fetches.length, 1, 'the node was asked once');
	assert.equal(w.verifies.length, 0, 'the 200 itself confirmed the token — no session check needed');

	clock.now += 1;
	const third = await w.cache.read(A, 'overview', '', 'tok-1');
	assert.equal(third.cached, false, 'at the TTL the entry is a miss');
	assert.equal(w.fetches.length, 2);
});

test('another operator gets the cached answer only after the node confirms their own token', async () => {
	const table = fakeTable();
	const clock = { now: 1_000_000 };
	const w = worker({ table, clock, answers: { overview: raw(200, { generatedAt: 1 }) } });
	await w.cache.read(A, 'overview', '', 'tok-1');
	await settle();

	const hit = await w.cache.read(A, 'overview', '', 'tok-2');
	assert.equal(hit.cached, true);
	assert.deepEqual(w.verifies, [{ origin: A, cookie: 'tok-2' }], 'one session check, against that node');

	// A cookie the node does not accept never sees the entry: it gets the node's own refusal.
	const forged = await w.cache.read(A, 'overview', '', 'forged');
	assert.equal(forged.cached, false);
	assert.equal(forged.status, 401);
	assert.equal(w.fetches.at(-1).cookie, 'forged', 'asked with the requester’s own token');

	// No token at all is never vouched for.
	const anonymous = await w.cache.read(A, 'overview', '', undefined);
	assert.equal(anonymous.status, 401);
});

test('a confirmation lapses after VERIFY_MS and is asked for again', async () => {
	const table = fakeTable();
	const clock = { now: 1_000_000 };
	const w = worker({ table, clock, answers: { metrics: raw(200, { metrics: [] }) } });
	await w.cache.read(A, 'metrics', '', 'tok-1');
	await settle();
	clock.now += VERIFY_MS;
	const hit = await w.cache.read(A, 'metrics', '', 'tok-1');
	assert.equal(hit.cached, true);
	assert.equal(w.verifies.length, 1, 'past the window, the token is checked again before the hit');
});

test('a token confirmed on one node is not vouched for on another', async () => {
	const table = fakeTable();
	const clock = { now: 1_000_000 };
	const w = worker({ table, clock, answers: { metrics: raw(200, { metrics: [] }) } });
	await w.cache.read(A, 'metrics', '', 'tok-1');
	await w.cache.read(B, 'metrics', '', 'tok-2');
	await settle();
	await w.cache.read(B, 'metrics', '', 'tok-1');
	assert.deepEqual(w.verifies, [{ origin: B, cookie: 'tok-1' }]);
});

test('a session the node denies, or a 401 from a data route, drops the confirmation', async () => {
	const table = fakeTable();
	const clock = { now: 1_000_000 };
	const goodTokens = ['tok-1'];
	const w = worker({ table, clock, goodTokens, answers: { overview: raw(200, { n: 1 }), config: raw(200, { c: 1 }) } });
	await w.cache.read(A, 'overview', '', 'tok-1');
	await settle();
	assert.equal((await w.cache.read(A, 'overview', '', 'tok-1')).cached, true);

	// The node signs the token out (expired, revoked). The next uncached read says so...
	goodTokens.length = 0;
	assert.equal((await w.cache.read(A, 'config', '', 'tok-1')).status, 401);
	// ...and the cached overview is no longer served on the strength of the old confirmation.
	const after = await w.cache.read(A, 'overview', '', 'tok-1');
	assert.equal(after.cached, false);
	assert.equal(after.status, 401);
});

test('freshness runs from when the DATA was produced, so the plugin’s TTL and the console’s do not stack', async () => {
	const table = fakeTable();
	const clock = { now: 1_000_000 };
	// The plugin answered from its own per-worker cache, 50s old.
	const w = worker({
		table,
		clock,
		answers: { 'analytics?range=3600000': raw(200, { series: [], cacheAgeMs: 50_000 }) },
	});
	await w.cache.read(A, 'analytics', 'range=3600000', 'tok-1');
	await settle();

	clock.now += 9_000;
	const hit = await w.cache.read(A, 'analytics', 'range=3600000', 'tok-1');
	assert.equal(hit.cached, true);
	assert.equal(hit.payload.cacheAgeMs, 59_000, 'the age the footer shows counts both caches');
	assert.equal(JSON.parse(hit.body.toString()).cacheAgeMs, 59_000, 'and so do the bytes passed through');

	clock.now += 1_000;
	assert.equal((await w.cache.read(A, 'analytics', 'range=3600000', 'tok-1')).cached, false, 'the data is 60s old');
	assert.equal(READ_TTL.analytics, 60_000);
});

test('a write through the console makes every earlier entry a miss — on every worker sharing the table', async () => {
	const table = fakeTable();
	const clock = { now: 1_000_000 };
	const answers = { overview: raw(200, { paused: false }) };
	const one = worker({ table, clock, answers });
	const two = worker({ table, clock, answers });
	await one.cache.read(A, 'overview', '', 'tok-1');
	await settle();
	assert.equal((await two.cache.read(A, 'overview', '', 'tok-1')).cached, true, 'a second worker reads the same table');

	clock.now += 10;
	await one.cache.noteWrite();
	assert.ok(table.rows.get(GENERATION_KEY), 'the generation is stored for the other workers');
	assert.equal(one.detached.length, 2, 'both the entry write and the generation write ran detached');

	answers.overview = raw(200, { paused: true });
	const mine = await one.cache.read(A, 'overview', '', 'tok-1');
	const theirs = await two.cache.read(A, 'overview', '', 'tok-1');
	assert.deepEqual(mine.payload, { paused: true });
	assert.equal(mine.cached, false);
	assert.deepEqual(theirs.payload, { paused: true });
});

test('a write is seen by its own worker even when the table write fails', async () => {
	const table = fakeTable();
	const clock = { now: 1_000_000 };
	const w = worker({ table, clock, answers: { overview: raw(200, { n: 1 }) } });
	await w.cache.read(A, 'overview', '', 'tok-1');
	await settle();
	clock.now += 10;
	table.put = async () => {
		throw new Error('disk full');
	};
	await w.cache.noteWrite();
	assert.equal((await w.cache.read(A, 'overview', '', 'tok-1')).cached, false);
});

test('concurrent misses for one key send ONE request to the node', async () => {
	const table = fakeTable();
	const clock = { now: 1_000_000 };
	let release;
	const gate = new Promise((resolve) => (release = resolve));
	const w = worker({
		table,
		clock,
		answers: { overview: async () => (await gate, raw(200, { n: 1 })) },
	});
	// The rider must be vouched for before it may ride; confirm tok-2 ahead of time.
	w.cache.confirm(A, 'tok-2');
	const reads = [w.cache.read(A, 'overview', '', 'tok-1'), w.cache.read(A, 'overview', '', 'tok-2')];
	await settle();
	release();
	const [leader, rider] = await Promise.all(reads);
	assert.equal(w.fetches.length, 1);
	assert.deepEqual(leader.payload, { n: 1 });
	assert.deepEqual(rider.payload, { n: 1 });
	assert.notEqual(leader.payload, rider.payload, 'each caller gets its own parse — a merger may modify it');
});

test('a rider whose leader was refused asks with its own token', async () => {
	const table = fakeTable();
	const clock = { now: 1_000_000 };
	let release;
	const gate = new Promise((resolve) => (release = resolve));
	const w = worker({
		table,
		clock,
		goodTokens: ['tok-2'],
		answers: { overview: async () => (await gate, raw(200, { n: 1 })) },
	});
	w.cache.confirm(A, 'tok-2');
	const reads = [w.cache.read(A, 'overview', '', 'stale'), w.cache.read(A, 'overview', '', 'tok-2')];
	await settle();
	release();
	const [leader, rider] = await Promise.all(reads);
	assert.equal(leader.status, 401);
	assert.equal(rider.status, 200, 'the leader’s 401 was about the leader');
	assert.equal(w.fetches.length, 2);
});

test('a rider shares the leader’s transport failure instead of repeating it', async () => {
	const table = fakeTable();
	const clock = { now: 1_000_000 };
	let release;
	const gate = new Promise((resolve) => (release = resolve));
	const w = worker({
		table,
		clock,
		answers: { overview: async () => (await gate, new Error('connect ECONNREFUSED')) },
	});
	w.cache.confirm(A, 'tok-2');
	const reads = [w.cache.read(A, 'overview', '', 'tok-1'), w.cache.read(A, 'overview', '', 'tok-2')];
	await settle();
	release();
	const outcomes = await Promise.allSettled(reads);
	assert.deepEqual(
		outcomes.map((o) => o.status),
		['rejected', 'rejected']
	);
	assert.equal(w.fetches.length, 1, 'one doomed request, not one per waiting operator');
});

test('session and page-content always go to the node', async () => {
	const table = fakeTable();
	const clock = { now: 1_000_000 };
	const w = worker({
		table,
		clock,
		answers: {
			'session': raw(200, { authenticated: true }),
			'page-content?cacheKey=k': raw(200, '<html></html>', 'text/plain; charset=utf-8'),
		},
	});
	for (let i = 0; i < 2; i++) {
		await w.cache.read(A, 'session', '', 'tok-1');
		const page = await w.cache.read(A, 'page-content', 'cacheKey=k', 'tok-1');
		assert.equal(page.payload, undefined, 'a text body is never parsed');
		assert.equal(page.body.toString(), '<html></html>');
		await settle();
	}
	assert.equal(w.fetches.length, 4);
	assert.equal(table.rows.size, 0);
	assert.deepEqual([...UNCACHED_READS].sort(), ['page-content', 'session']);
});

test('only a readable 200 within the size bound is stored', async () => {
	const table = fakeTable();
	const clock = { now: 1_000_000 };
	const w = worker({
		table,
		clock,
		answers: {
			overview: raw(503, { error: 'overloaded' }),
			config: raw(200, 'not json'),
			pages: raw(200, { pad: 'x'.repeat(MAX_CACHED_BODY) }),
			sitemaps: raw(200, { sitemaps: [] }),
		},
	});
	for (const route of ['overview', 'config', 'pages', 'sitemaps']) await w.cache.read(A, route, '', 'tok-1');
	await settle();
	assert.deepEqual([...table.rows.keys()], [`${A}/prerender_admin/sitemaps`]);
});

test('a cached payload belongs to its caller: modifying one does not reach the next', async () => {
	const table = fakeTable();
	const clock = { now: 1_000_000 };
	const w = worker({ table, clock, answers: { overview: raw(200, { nodes: [{ h: 'a' }] }) } });
	await w.cache.read(A, 'overview', '', 'tok-1');
	await settle();
	const first = await w.cache.read(A, 'overview', '', 'tok-1');
	first.payload.nodes.push({ h: 'injected' });
	const second = await w.cache.read(A, 'overview', '', 'tok-1');
	assert.deepEqual(second.payload, { nodes: [{ h: 'a' }] });
});

test('a clock that went backwards does not keep an entry fresh', async () => {
	const table = fakeTable();
	const clock = { now: 1_000_000 };
	const w = worker({ table, clock, answers: { overview: raw(200, { n: 1 }) } });
	await w.cache.read(A, 'overview', '', 'tok-1');
	await settle();
	clock.now -= 60_000;
	assert.equal((await w.cache.read(A, 'overview', '', 'tok-1')).cached, false);
});

test('disabled, or with no table, every read goes to the node', async () => {
	const clock = { now: 1_000_000 };
	const off = worker({ table: fakeTable(), clock, enabled: false, answers: { overview: raw(200, { n: 1 }) } });
	const none = worker({ table: null, clock, answers: { overview: raw(200, { n: 1 }) } });
	for (const w of [off, none]) {
		await w.cache.read(A, 'overview', '', 'tok-1');
		await settle();
		assert.equal((await w.cache.read(A, 'overview', '', 'tok-1')).cached, false);
		assert.equal(w.fetches.length, 2);
	}
});

test('a table that fails to read degrades to the node, never to an error', async () => {
	const table = fakeTable();
	table.get = async () => {
		throw new Error('Database closed during transaction get operation');
	};
	const w = worker({ table, clock: { now: 1_000_000 }, answers: { overview: raw(200, { n: 1 }) } });
	const answer = await w.cache.read(A, 'overview', '', 'tok-1');
	assert.equal(answer.status, 200);
	assert.equal(answer.cached, false);
});

test('the read-only POSTs are real proxied routes, and every TTL names a real proxied GET', () => {
	for (const route of READ_ONLY_POST) assert.ok(PROXIED_POST.includes(route), `${route} is not a proxied POST`);
	for (const route of Object.keys(READ_TTL)) assert.ok(PROXIED_GET.includes(route), `${route} is not a proxied GET`);
	for (const route of UNCACHED_READS) assert.ok(PROXIED_GET.includes(route), `${route} is not a proxied GET`);
});

test('the table outlives the longest TTL, so no row vanishes while it is still servable', () => {
	const schema = readFileSync(new URL('../src/schemas/schema.graphql', import.meta.url), 'utf8');
	const directive = schema.match(/type ProxyRead @table\(([^)]*)\)/)?.[1];
	assert.ok(directive, 'ProxyRead is declared');
	assert.match(directive, /replicate: false/);
	assert.match(directive, /audit: false/);
	assert.doesNotMatch(schema.match(/type ProxyRead[^{]*/)[0], /@export/, 'the cache is never reachable over REST');
	const expirationMs = Number(directive.match(/expiration: (\d+)/)[1]) * 1000;
	const longest = Math.max(DEFAULT_READ_TTL, ...Object.values(READ_TTL));
	assert.ok(expirationMs > longest, `expiration ${expirationMs}ms must exceed the longest TTL ${longest}ms`);
});
