import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import RenderWorker from '../dist/Worker.js';
import RenderJob from '../dist/RenderJob.js';
import { resolveSettings } from '../dist/settings.js';
import { BoundedAsyncQueue } from '../dist/util/asyncQueue.js';

// The worker's prefetch PIPELINE: with `documentReuse.prefetch` on, `run()` keeps a bounded pool of
// claimed jobs whose documents are fetched while earlier jobs render, and hands each render a document
// that is already in hand. Driven with a stub browser and a stub renderer (no Chrome), a real local
// origin that timestamps every document request, and a fake queue endpoint — what is under test is
// the ordering and the accounting: the fetch overlaps the previous render, a pooled job never waits
// for a successor, depth is exact, and shutdown drops what is pooled. The fetch itself is tested in
// documentPrefetch.test.ts; the real-Chrome replay in documentReuseRender.test.ts.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let origin: http.Server;
let base = '';
let queue: http.Server;
let callbackOrigin = '';
const documentRequests: Array<{ path: string; at: number }> = [];
const posted: Array<{ id: string; statusCode?: number; documentPrefetched?: true }> = [];

before(async () => {
	origin = http.createServer((req, res) => {
		documentRequests.push({ path: req.url ?? '', at: Date.now() });
		res.writeHead(200, { 'content-type': 'text/html' });
		res.end(`<html>${req.url}</html>`);
	});
	await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
	base = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;

	queue = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on('data', (c) => chunks.push(c));
		req.on('end', () => {
			const body = Buffer.concat(chunks);
			const metadataSize = parseInt(String(req.headers['x-metadata-size']));
			posted.push(JSON.parse(body.subarray(0, metadataSize).toString('utf8')));
			res.writeHead(204);
			res.end();
		});
	});
	await new Promise<void>((r) => queue.listen(0, '127.0.0.1', r));
	callbackOrigin = `http://127.0.0.1:${(queue.address() as AddressInfo).port}`;
});

after(async () => {
	await new Promise<void>((r) => origin.close(() => r()));
	await new Promise<void>((r) => queue.close(() => r()));
});

const configure = (prefetch: { enabled: boolean; depth?: number; timeoutMs?: number }) =>
	resolveSettings({ harper: {}, config: { documentReuse: { prefetch } } }, { requireHarper: false });

// A browser that hands out inert pages, as in variantRender.test.ts.
const stubBrowser = () => ({
	jobRefs: 0,
	activePages: 0,
	totalOpenedPages: 0,
	closing: false,
	getPage: async () => ({ isClosed: () => false }),
	closePage: async () => {},
	close: async () => {},
});

type Event = { id: string; event: 'render-start' | 'render-end'; at: number; hadDoc?: boolean; waitedMs?: number };

// A renderer that asks for the job's document the way the real one does (`replayFor`), records when
// it started and ended and whether the document was in hand, and takes `renderMs` of "CPU".
const makeWorker = (renderMs: number, events: Event[], maxConcurrency = 1) => {
	const worker = new RenderWorker({
		maxConcurrency,
		rps: 1000,
		renderer: (async (_page: unknown, job: RenderJob) => {
			const t0 = Date.now();
			const doc = await job.documentCache?.replayFor(job.deviceType);
			events.push({ id: job.id, event: 'render-start', at: t0, hadDoc: !!doc, waitedMs: Date.now() - t0 });
			await sleep(renderMs);
			job.httpResponse = { statusCode: doc?.status ?? 200, headers: {} };
			job.isIndexable = true;
			if (doc) job.documentPrefetched = doc.source === 'prefetch';
			events.push({ id: job.id, event: 'render-end', at: Date.now() });
			return `<html>${job.id}</html>`;
		}) as never,
	});
	worker.browser = stubBrowser() as never;
	return worker;
};

const legacyJob = (n: number, expiresInMs = 60_000) =>
	new RenderJob({
		id: `${base}/page/${n}|desktop`,
		url: `${base}/page/${n}`,
		expiresAt: Date.now() + expiresInMs,
		deviceType: 'desktop',
		callbackOrigin,
		isFromSitemap: false,
	});

async function* jobsOf(list: RenderJob[]) {
	for (const job of list) yield job;
}

const at = (events: Event[], id: string, event: Event['event']) =>
	events.find((e) => e.id === id && e.event === event)!.at;
const docRequestAt = (n: number) => documentRequests.find((r) => r.path === `/page/${n}`)!.at;

const reset = () => {
	documentRequests.length = 0;
	posted.length = 0;
};

test('the next jobs’ documents are fetched WHILE the current job renders, and each render finds its document in hand', async () => {
	configure({ enabled: true, depth: 2 });
	reset();
	const events: Event[] = [];
	const worker = makeWorker(300, events);
	const jobs = [1, 2, 3, 4].map((n) => legacyJob(n));
	try {
		await worker.run(jobsOf(jobs));
		await Promise.allSettled([...worker.inflight]);
	} finally {
		await worker.destroy();
	}

	assert.equal(documentRequests.length, 4, 'one document fetch per job, by the worker');
	assert.equal(posted.length, 4, 'every job posted a result');
	assert.ok(posted.every((p) => p.statusCode === 200 && p.documentPrefetched === true));

	// Pipelining: with one slot and depth 2, jobs 2 and 3 are fetched during job 1's render, and
	// job 4 during job 2's — never before there is room for it (depth is exact: the render loop
	// takes a pooled job only once a slot is free, so nothing is held beyond the pool).
	const end1 = at(events, jobs[0].id, 'render-end');
	const end2 = at(events, jobs[1].id, 'render-end');
	assert.ok(docRequestAt(2) < end1, 'job 2 was fetched before job 1 finished rendering');
	assert.ok(docRequestAt(3) < end1, 'job 3 was fetched before job 1 finished rendering');
	assert.ok(docRequestAt(4) >= end1, 'job 4 was NOT fetched until a pool slot freed (depth 2)');
	assert.ok(docRequestAt(4) < end2, 'job 4 was fetched before job 2 finished rendering');

	// Every render found its document already fetched.
	const starts = events.filter((e) => e.event === 'render-start');
	assert.deepEqual(
		starts.map((e) => e.id),
		jobs.map((j) => j.id),
		'rendered in claim order'
	);
	assert.ok(
		starts.every((e) => e.hadDoc),
		'every render had a document'
	);
	assert.ok(
		starts.slice(1).every((e) => (e.waitedMs ?? 0) < 100),
		`renders after the first did not wait for their prefetch: ${JSON.stringify(starts.map((e) => e.waitedMs))}`
	);
});

test('a pooled job never waits for a SUCCESSOR: a single job from an idle queue renders at once', async () => {
	configure({ enabled: true, depth: 3 });
	reset();
	const events: Event[] = [];
	const worker = makeWorker(50, events);
	let release!: () => void;
	const gate = new Promise<void>((r) => (release = r));
	const job = legacyJob(10);
	// Yields one job, then hangs like an empty queue would, until released.
	async function* trickle() {
		yield job;
		await gate;
	}
	try {
		const running = worker.run(trickle());
		// The job must render without a second job ever arriving.
		const deadline = Date.now() + 2000;
		while (posted.length === 0 && Date.now() < deadline) await sleep(20);
		assert.equal(posted.length, 1, 'the lone job rendered and posted while the queue stayed idle');
		release();
		await running;
	} finally {
		await worker.destroy();
	}
});

test('a job whose lease ran short while pooled is skipped at take time, its prefetch cancelled', async () => {
	configure({ enabled: true, depth: 2 });
	reset();
	const events: Event[] = [];
	const worker = makeWorker(400, events);
	// Admitted with 30.2s of lease; by the time job 1's 400ms render frees the slot it is under the
	// 30s floor and must not be started.
	const jobs = [legacyJob(21), legacyJob(22, 30_200), legacyJob(23)];
	try {
		await worker.run(jobsOf(jobs));
		await Promise.allSettled([...worker.inflight]);
	} finally {
		await worker.destroy();
	}
	assert.deepEqual(
		posted.map((p) => p.id),
		[jobs[0].id, jobs[2].id],
		'the short-lease job was skipped; the others rendered'
	);
	assert.ok(
		documentRequests.some((r) => r.path === '/page/22'),
		'its prefetch had started (it was pooled)'
	);
});

test('shutdown drops what is still pooled: no render, no post, the lease is left to expire', async () => {
	configure({ enabled: true, depth: 2 });
	reset();
	const events: Event[] = [];
	const worker = makeWorker(600, events);
	const signal = (worker as unknown as { consumerAbort: AbortController }).consumerAbort.signal;
	const jobs = [legacyJob(31), legacyJob(32), legacyJob(33), legacyJob(34)];
	// A source that ends when the worker's consumer is aborted, as the queue consumer does.
	async function* untilAborted() {
		for (const job of jobs) {
			if (signal.aborted) return;
			yield job;
		}
		if (!signal.aborted) await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
	}
	try {
		const running = worker.run(untilAborted());
		await sleep(150); // job 31 rendering; 32 taken and waiting for the slot; 33, 34 pooled
		await worker.shutdown(50);
		await running;
		await Promise.allSettled([...worker.inflight]);
	} finally {
		await worker.destroy();
	}
	assert.deepEqual(
		posted.map((p) => p.id),
		[jobs[0].id],
		'the in-flight render finished and posted; the slot-waiter and the pooled jobs were dropped, not rendered into a destroyed browser'
	);
	assert.ok(
		documentRequests.some((r) => r.path === '/page/33'),
		'the pooled jobs had been prefetched (the pool was doing its job up to the shutdown)'
	);
});

test('with prefetch off, run() renders claims as before — no fetch by the worker, no document cache', async () => {
	configure({ enabled: false });
	reset();
	const events: Event[] = [];
	const worker = makeWorker(20, events);
	const jobs = [legacyJob(41), legacyJob(42)];
	try {
		await worker.run(jobsOf(jobs));
		await Promise.allSettled([...worker.inflight]);
	} finally {
		await worker.destroy();
	}
	assert.equal(documentRequests.length, 0, 'the worker fetched nothing (Chrome would have, in a real render)');
	assert.equal(posted.length, 2);
	assert.ok(events.filter((e) => e.event === 'render-start').every((e) => e.hadDoc === false));
});

// ── the queue the pipeline is built on ──

test('BoundedAsyncQueue: FIFO, blocks producers at capacity, drains after close', async () => {
	const q = new BoundedAsyncQueue<number>(2);
	assert.equal(await q.put(1), true);
	assert.equal(await q.put(2), true);
	let thirdQueued = false;
	const third = q.put(3).then((ok) => {
		thirdQueued = ok;
	});
	await sleep(10);
	assert.equal(thirdQueued, false, 'a full queue holds the producer');
	assert.equal(await q.take(), 1);
	await third;
	assert.equal(thirdQueued, true, 'room from a take lets the producer through');
	assert.equal(q.size, 2);
	q.close();
	assert.equal(await q.put(4), false, 'a closed queue refuses new items');
	assert.equal(await q.take(), 2);
	assert.equal(await q.take(), 3, 'queued items remain takeable after close');
	assert.equal(await q.take(), undefined, 'then undefined');
	assert.throws(() => new BoundedAsyncQueue(0), /positive integer/);
});

test('BoundedAsyncQueue: a waiting consumer is woken by a put, and by close', async () => {
	const q = new BoundedAsyncQueue<string>(1);
	const taken = q.take();
	await q.put('a');
	assert.equal(await taken, 'a');
	const waiting = q.take();
	q.close();
	assert.equal(await waiting, undefined);
	await q.waitForRoom(); // resolves at once on a closed queue
});
