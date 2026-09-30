import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Agent } from 'undici';
import { originBodyStream } from '../src/util/upstream.js';
import { collectBody, teeForCapture } from '../src/util/rawCache.js';

/**
 * `originBodyStream` — the proxied origin body as a web stream, replacing `Readable.toWeb`.
 *
 * THE HAZARD IT EXISTS FOR, reproduced below in a child process (an uncaughtException would take the
 * test runner's own process with it): Node's `Readable.toWeb` adapter throws `ERR_INVALID_STATE:
 * Controller is already closed` from its `data` listener when `cancel()` lands in the same microtask
 * phase the stream was created in. Measured on Node 24.15 against a 4 MB single-write origin body:
 * 20/20 for a cancel one or more microtasks after creation; 0/20 for a synchronous cancel, a cancel a
 * tick later, or one after a read. That timing is why a quick repro can see 0 — and why a caller that
 * does not control WHEN a body is cancelled (Harper cancelling it for a client that has gone) cannot
 * rule it out. The characterization is TOLERANT: if a Node release fixes the adapter it reports that
 * rather than failing. What is asserted is that `originBodyStream`, in the same window, throws nothing.
 */

const BIG = Buffer.alloc(4 * 1024 * 1024, 'x');
let server;
let port;
// Origin responses not yet finished or torn down: a body nobody reads or releases stays here.
let inFlight = 0;
const agent = new Agent();

before(async () => {
	server = http.createServer((req, res) => {
		inFlight++;
		res.on('close', () => inFlight--);
		if (req.url === '/half') {
			// Headers and part of the body, then the connection dies: a truncated origin response.
			res.writeHead(200, { 'content-length': String(BIG.length) });
			res.write(BIG.subarray(0, 1024));
			setTimeout(() => res.socket.destroy(), 20);
			return;
		}
		res.writeHead(200, { 'content-type': 'text/html' });
		res.end(BIG);
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	port = server.address().port;
});

after(async () => {
	server.closeAllConnections();
	server.close();
	await agent.close();
});

const get = (path = '/') => agent.request({ origin: `http://127.0.0.1:${port}`, path, method: 'GET' });
const settle = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));

test('CHARACTERIZATION: Readable.toWeb throws on a cancel inside its creation microtask phase; ours never does', (t) => {
	const upstream = new URL('../src/util/upstream.js', import.meta.url).href;
	const script = `
		import http from 'node:http';
		import { Readable } from 'node:stream';
		import { Agent } from 'undici';
		import { originBodyStream } from ${JSON.stringify(upstream)};
		let uncaught = 0;
		process.on('uncaughtException', () => { uncaught++; });
		const big = Buffer.alloc(4 * 1024 * 1024, 'x');
		const srv = http.createServer((q, s) => { s.writeHead(200); s.end(big); });
		await new Promise((r) => srv.listen(0, '127.0.0.1', r));
		const agent = new Agent();
		const counts = {};
		for (const [name, make] of [['toWeb', (b) => Readable.toWeb(b)], ['originBodyStream', originBodyStream]]) {
			const before = uncaught;
			for (let i = 0; i < 20; i++) {
				const res = await agent.request({ origin: 'http://127.0.0.1:' + srv.address().port, path: '/', method: 'GET' });
				const web = make(res.body);
				await Promise.resolve();
				web.cancel().catch(() => {});
			}
			await new Promise((r) => setTimeout(r, 200));
			counts[name] = uncaught - before;
		}
		console.log(JSON.stringify(counts));
		srv.closeAllConnections(); srv.close(); await agent.close();
	`;
	const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
		cwd: fileURLToPath(new URL('..', import.meta.url)),
		encoding: 'utf8',
		timeout: 60_000,
	});
	const line = run.stdout.trim().split('\n').pop();
	const counts = JSON.parse(line);
	t.diagnostic(
		`Node ${process.version}: Readable.toWeb threw ${counts.toWeb}/20, originBodyStream ${counts.originBodyStream}/20`
	);
	if (counts.toWeb === 0)
		t.diagnostic('the Readable.toWeb hazard did not reproduce on this Node — the adapter may be fixed');
	assert.equal(counts.originBodyStream, 0, 'the replacement must never surface as an uncaughtException');
});

test('a cancel in that same window releases the origin connection and throws nothing', async () => {
	for (let i = 0; i < 10; i++) {
		const res = await get();
		const web = originBodyStream(res.body);
		await Promise.resolve();
		await web.cancel();
	}
	await settle();
	assert.equal(inFlight, 0, 'cancel destroys the source, which ends its response');
});

test('the body reads through whole and unchanged', async () => {
	const res = await get();
	const bytes = Buffer.from(await new Response(originBodyStream(res.body)).arrayBuffer());
	assert.equal(bytes.length, BIG.length);
	assert.ok(bytes.equals(BIG));
});

test('backpressure: an unread body pauses the origin rather than buffering it into the heap', async () => {
	const res = await get();
	originBodyStream(res.body);
	await settle();
	assert.equal(res.body.isPaused(), true);
	assert.ok(res.body.readableLength < BIG.length / 4, `buffered ${res.body.readableLength} of ${BIG.length}`);
	res.body.destroy();
});

test('a truncated origin body errors the reader — it never looks like a complete document', async () => {
	const res = await get('/half');
	await assert.rejects(new Response(originBodyStream(res.body)).arrayBuffer());
});

test('a capture over its size cap, then the crawler going away, throws nothing and frees the connection', async () => {
	// The raw/negative capture path: `collectBody` cancels its tee branch past `maxBytes`, and Harper
	// cancels the crawler's branch on disconnect — the second cancel is the one that reaches the source.
	for (let i = 0; i < 5; i++) {
		const res = await get();
		const { downstream, captured } = teeForCapture(originBodyStream(res.body), 64 * 1024);
		const reader = downstream.getReader();
		await reader.read();
		assert.equal((await captured).outcome, 'oversize');
		await Promise.resolve();
		reader.cancel().catch(() => {});
	}
	await settle();
	assert.equal(inFlight, 0);
});

test('collectBody reads an originBodyStream to its end', async () => {
	const res = await get();
	const { bytes, outcome } = await collectBody(originBodyStream(res.body), BIG.length + 1);
	assert.equal(outcome, 'ok');
	assert.equal(bytes.length, BIG.length);
});
