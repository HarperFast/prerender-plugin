/**
 * The read cache through the real resource: `PrerenderConsole` → fan-out / single node / POST → the
 * table, against stand-in prerender nodes over HTTP.
 *
 * The unit tests (readCache.test.js) pin the cache's rules; this pins that the resource routes every
 * read through it and every write past it. Two imports of the resource stand in for two Harper worker
 * threads: separate module state (in-flight map, confirmations), one shared table — which is the whole
 * reason the cache is a table.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const queueState = readFileSync(new URL('./fixtures/plugin-0.93.0-queue-state-live.json', import.meta.url), 'utf8');

globalThis.Resource ??= class {};
const rows = new Map();
globalThis.databases = {
	prerender_console: {
		ProxyRead: {
			get: async (key) => rows.get(key) ?? null,
			put: async (key, record) => void rows.set(key, Object.freeze({ key, ...record })),
		},
	},
};
const { PrerenderConsole: WorkerOne } = await import('../src/resources/PrerenderConsole.js?worker=1');
const { PrerenderConsole: WorkerTwo } = await import('../src/resources/PrerenderConsole.js?worker=2');
const { config } = await import('../src/config.js');
const { encodeSessionCookie } = await import('../src/util/proxy.js');

/** A stand-in prerender node: a super_user session for `good` cookies, a counter per route. */
async function node(name, { good = ['hdb-session=op-1', 'hdb-session=op-2'] } = {}) {
	const hits = {};
	const state = { paused: false };
	const server = createServer(async (req, res) => {
		const route = new URL(req.url, 'http://x').pathname.replace('/prerender_admin/', '');
		hits[route] = (hits[route] ?? 0) + 1;
		const send = (status, body) => {
			res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
			res.end(JSON.stringify(body));
		};
		if (!good.includes(req.headers.cookie))
			return send(401, { error: 'Authentication required', authenticated: false });
		if (route === 'session') return send(200, { authenticated: true, superUser: true, username: 'op' });
		if (req.method === 'POST' && route === 'queue') {
			await new Promise((resolve) => req.resume().on('end', resolve));
			state.paused = true;
			return send(200, { scope: 'node', paused: true });
		}
		if (route === 'metrics') return send(200, { metrics: [], node: name });
		if (route === 'queue-state') return send(200, JSON.parse(queueState));
		if (route === 'sitemaps') return send(200, { sitemaps: [], node: name });
		return send(404, { error: `Unknown route: ${route}` });
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const origin = `http://127.0.0.1:${server.address().port}`;
	return { origin, hits, state, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** A request target and context the resource's handlers read, as Harper would hand them over. */
const target = (route, params = {}) => ({
	id: route,
	get: (key) => params[key] ?? null,
	searchParams: new URLSearchParams(params),
});
const contextFor = (tokens) => ({
	headers: new Map([['cookie', `${config.cookieName}=${encodeSessionCookie(tokens)}`]]),
});
const as = (Resource, tokens) => {
	const resource = new Resource();
	resource.getContext = () => contextFor(tokens);
	return resource;
};

async function cluster(t) {
	const a = await node('a');
	const b = await node('b');
	const saved = config.nodes;
	config.nodes = [a.origin, b.origin];
	rows.clear();
	t.after(async () => {
		config.nodes = saved;
		await Promise.all([a.close(), b.close()]);
	});
	const op1 = { [a.origin]: 'hdb-session=op-1', [b.origin]: 'hdb-session=op-1' };
	const op2 = { [a.origin]: 'hdb-session=op-2', [b.origin]: 'hdb-session=op-2' };
	return { a, b, op1, op2 };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a merged cluster read fans out once; the next one is merged from the cache', async (t) => {
	const { a, b, op1 } = await cluster(t);
	const first = await (await as(WorkerOne, op1).get(target('queue-state'))).json();
	await settle();
	const second = await (await as(WorkerOne, op1).get(target('queue-state'))).json();
	assert.equal(a.hits['queue-state'], 1);
	assert.equal(b.hits['queue-state'], 1);
	assert.deepEqual(
		second.sources.nodes.map((n) => n.ok),
		[true, true]
	);
	assert.ok(
		second.sources.nodes.every((n) => Number.isFinite(n.ageMs)),
		'each node says its answer is cached'
	);
	assert.ok(
		first.sources.nodes.every((n) => n.ageMs === null),
		'and the first read says it is live'
	);
	assert.deepEqual(second.cluster, first.cluster, 'the same merge, from the same answers');
});

test('a shared cluster read is answered once, then served to the other worker and the drill-down', async (t) => {
	const { a, b, op1 } = await cluster(t);

	const first = await as(WorkerOne, op1).get(target('metrics'));
	assert.equal(first.status, 200);
	await settle();

	// Another worker, same operator — cluster scope (shared route), then a drill-down to node b.
	const again = await (await as(WorkerTwo, op1).get(target('metrics'))).json();
	assert.equal(again.sources.servedBy, new URL(a.origin).host);
	assert.ok(again.sources.nodes.find((n) => n.ok).ageMs >= 0, 'the provenance says it came from the cache');
	assert.equal(a.hits.metrics, 1, 'node a was read once');
	assert.equal(a.hits.session, 1, 'the second worker had no confirmation of its own, so it asked — cheaply');

	await as(WorkerOne, op1).get(target('metrics', { node: b.origin }));
	await settle();
	await as(WorkerOne, op1).get(target('metrics', { node: b.origin }));
	assert.equal(b.hits.metrics, 1);
});

test('a second operator is confirmed by the node before being served, and a forged cookie never is', async (t) => {
	const { a, op1, op2 } = await cluster(t);
	await as(WorkerOne, op1).get(target('sitemaps'));
	await settle();

	const res = await as(WorkerOne, op2).get(target('sitemaps'));
	assert.equal(res.status, 200);
	assert.equal(a.hits.sitemaps, 1);
	assert.equal(a.hits.session, 1, 'op-2’s own session, confirmed by node a');

	const forged = { [a.origin]: 'hdb-session=made-up' };
	const refused = await as(WorkerOne, forged).get(target('sitemaps', { node: a.origin }));
	assert.equal(refused.status, 401, 'the node’s own refusal, not the cached answer');
});

test('a POST invalidates the cache on every worker before it answers', async (t) => {
	const { a, op1 } = await cluster(t);
	await as(WorkerOne, op1).get(target('sitemaps', { node: a.origin }));
	await settle();
	await as(WorkerTwo, op1).get(target('sitemaps', { node: a.origin }));
	assert.equal(a.hits.sitemaps, 1);

	const write = await as(WorkerOne, op1).post(target('queue', { node: a.origin }), { scope: 'node', paused: true });
	assert.equal(write.status, 200);

	await as(WorkerTwo, op1).get(target('sitemaps', { node: a.origin }));
	assert.equal(a.hits.sitemaps, 2, 'the other worker read the node, not the pre-write answer');
});

test('a read-only POST leaves the cache alone', async (t) => {
	const { a, op1 } = await cluster(t);
	await as(WorkerOne, op1).get(target('sitemaps', { node: a.origin }));
	await settle();
	await as(WorkerOne, op1).post(target('explain', { node: a.origin }), { url: 'https://www.example.com/' });
	await as(WorkerOne, op1).get(target('sitemaps', { node: a.origin }));
	assert.equal(a.hits.sitemaps, 1);
});
