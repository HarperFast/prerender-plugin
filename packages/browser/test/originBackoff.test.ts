import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import RenderWorker from '../dist/Worker.js';
import RenderJob from '../dist/RenderJob.js';
import { resolveSettings, settings } from '../dist/settings.js';
import { OriginBackoff, originVerdict, resetOriginBackoff, getOriginBackoff } from '../dist/OriginBackoff.js';
import { markRenderPhase } from '../dist/util/renderPhase.js';
import logger from '../dist/util/Logger.js';

/**
 * OriginBackoff.ts: a worker renders on fewer slots while the origin fails most of its navigations, and
 * ramps back once it answers. Pinned here: what counts as a failed navigation, the curve (halve, hold on a
 * thin failing sample, recover by steps, never under one slot), that the claim size follows the slots, the
 * settings validation, and that a real worker run actually starts fewer renders at once.
 */

const WINDOW = 60_000;

const configure = (originBackoff: Record<string, unknown> = {}) =>
	resolveSettings({ harper: {}, originBackoff }, { requireHarper: false });

beforeEach(() => configure());

/** A backoff on a clock the test moves by hand. */
const clocked = () => {
	let now = 1_000_000;
	const backoff = new OriginBackoff(() => now);
	return { backoff, advance: (ms: number) => (now += ms) };
};

const navigations = (backoff: OriginBackoff, { answered = 0, failed = 0 }) => {
	for (let i = 0; i < answered; i++) backoff.record('answered');
	for (let i = 0; i < failed; i++) backoff.record('failed');
};

test('a failed navigation is one the document never arrived for, or arrived 408, 429 or 5xx', () => {
	const timeout = markRenderPhase(new Error('Navigation timeout of 12000 ms exceeded'), 'navigation');
	const refused = markRenderPhase(new Error('net::ERR_CONNECTION_REFUSED at https://www.example.com/'), 'navigation');
	const loop = markRenderPhase(new Error('net::ERR_TOO_MANY_REDIRECTS at https://www.example.com/'), 'navigation');
	assert.equal(originVerdict(timeout, undefined), 'failed');
	assert.equal(originVerdict(refused, undefined), 'failed');
	assert.equal(originVerdict(loop, undefined), 'answered', 'a redirect loop is the origin answering');
	for (const status of [500, 502, 503, 504, 408, 429]) assert.equal(originVerdict(undefined, status), 'failed');
	for (const status of [200, 301, 404, 410, 403]) assert.equal(originVerdict(undefined, status), 'answered');
	// A settle-phase timeout on a page whose document arrived 200: the origin answered.
	assert.equal(originVerdict(new Error('Waiting failed: 8000ms exceeded'), 200), 'answered');
	// No navigation result at all (no page, a protocol fault): nothing to say about the origin.
	assert.equal(originVerdict(new Error('Target closed'), undefined), null);
});

test('a failing window halves the slots, down to one, and a healthy one adds a quarter back', () => {
	const { backoff, advance } = clocked();
	assert.equal(backoff.slots(8), 8);

	const shares: number[] = [];
	for (let w = 0; w < 5; w++) {
		navigations(backoff, { failed: 12 });
		advance(WINDOW);
		shares.push(backoff.slots(8));
	}
	assert.deepEqual(shares, [4, 2, 1, 1, 1], 'halved each failing window, never under one slot');
	assert.equal(backoff.claimLimit(8), 1, 'and the claim size follows');

	const recovery: number[] = [];
	for (let w = 0; w < 5; w++) {
		navigations(backoff, { answered: 3 });
		advance(WINDOW);
		recovery.push(backoff.slots(8));
	}
	assert.deepEqual(recovery, [2, 4, 6, 8, 8], 'a quarter of the concurrency back per healthy window');
});

test('a thin sample that is still failing HOLDS, and too few failures among answers never cut', () => {
	const { backoff, advance } = clocked();
	navigations(backoff, { failed: 12 });
	advance(WINDOW);
	assert.equal(backoff.slots(8), 4);
	// Down to fewer slots, the worker sees fewer navigations: 4 of 4 failing is under minNavigations (10)
	// but is no reason to ramp back up.
	navigations(backoff, { failed: 4 });
	advance(WINDOW);
	assert.equal(backoff.slots(8), 4, 'held');

	const fresh = clocked();
	navigations(fresh.backoff, { answered: 60, failed: 40 });
	fresh.advance(WINDOW);
	assert.equal(fresh.backoff.slots(8), 8, '40% failing is a few broken pages, not an origin in distress');
});

test('windows that pass with nothing in them count as healthy, so an idle worker recovers', () => {
	const { backoff, advance } = clocked();
	navigations(backoff, { failed: 12 });
	advance(WINDOW);
	navigations(backoff, { failed: 12 });
	advance(WINDOW);
	assert.equal(backoff.slots(8), 2);
	advance(3 * WINDOW);
	assert.equal(backoff.slots(8), 8, 'two quiet windows after the last judged one');
});

test('off: the configured concurrency and claim size, whatever the origin does', () => {
	configure({ enabled: false });
	const { backoff, advance } = clocked();
	navigations(backoff, { failed: 50 });
	advance(WINDOW);
	assert.equal(backoff.slots(8), 8);
	assert.equal(backoff.claimLimit(8), 8);
});

test('settings: defaults, overrides, and a value that would misbehave refused at startup', () => {
	assert.deepEqual(settings.originBackoff, {
		enabled: true,
		windowMs: 60_000,
		minNavigations: 10,
		failureShare: 0.5,
		recoverStep: 0.25,
	});
	configure({ failureShare: 0.8 });
	assert.equal(settings.originBackoff.failureShare, 0.8);
	assert.equal(settings.originBackoff.windowMs, 60_000, 'the rest keep their defaults');
	assert.throws(() => configure({ failureShare: 0 }), /failureShare/);
	assert.throws(() => configure({ recoverStep: 1.5 }), /recoverStep/);
	assert.throws(() => configure({ windowMs: 10 }), /windowMs/);
	assert.throws(() => configure({ minNavigations: 0 }), /minNavigations/);
});

// ── a real worker run ────────────────────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const stubBrowser = () => ({
	jobRefs: 0,
	activePages: 0,
	totalOpenedPages: 0,
	closing: false,
	getPage: async () => ({ isClosed: () => false }),
	closePage: async () => {},
	close: async () => {},
});

async function* jobsOf(list: RenderJob[]) {
	for (const job of list) yield job;
}

test('a worker whose navigations are failing starts fewer renders at once, then ramps back as they answer', async (t) => {
	// A short window, so the run is quick: each render takes 40 ms, a window is 100 ms.
	configure({ windowMs: 1000, minNavigations: 4 });
	let now = 0;
	const backoff = resetOriginBackoff(() => now);
	t.after(() => resetOriginBackoff());
	// Every failed render logs an error and every cut a warning; the assertions are about slots.
	t.mock.method(logger, 'error', () => {});
	t.mock.method(logger, 'warn', () => {});

	let inFlight = 0;
	const peaks: number[] = [];
	let failing = true;
	const worker = new RenderWorker({
		maxConcurrency: 4,
		rps: 10_000,
		renderer: (async (_page: unknown, job: RenderJob) => {
			inFlight++;
			peaks.push(inFlight);
			await sleep(40);
			inFlight--;
			if (failing) throw markRenderPhase(new Error('Navigation timeout of 12000 ms exceeded'), 'navigation');
			job.httpResponse = { statusCode: 200, headers: {} };
			return '<html>ok</html>';
		}) as never,
	});
	worker.browser = stubBrowser() as never;
	// Where the results are posted: a queue that takes them and says nothing.
	const queue = http.createServer((req, res) => {
		req.resume();
		req.on('end', () => {
			res.writeHead(204);
			res.end();
		});
	});
	await new Promise<void>((r) => queue.listen(0, '127.0.0.1', r));
	t.after(() => new Promise<void>((r) => queue.close(() => r())));
	const callbackOrigin = `http://127.0.0.1:${(queue.address() as AddressInfo).port}`;

	const job = (n: number) =>
		new RenderJob({
			id: `https://www.example.com/p/${n}|desktop`,
			url: `https://www.example.com/p/${n}`,
			expiresAt: Date.now() + 600_000,
			deviceType: 'desktop',
			callbackOrigin,
			isFromSitemap: false,
		});

	try {
		// Full concurrency, all failing: the first window's 8 failures cut the slots to 2 of 4.
		await worker.run(jobsOf(Array.from({ length: 8 }, (_, i) => job(i))));
		await Promise.allSettled([...worker.inflight]);
		assert.equal(Math.max(...peaks), 4, 'started at the configured concurrency');
		now += 1000;
		assert.equal(backoff.slots(4), 2);

		peaks.length = 0;
		await worker.run(jobsOf(Array.from({ length: 8 }, (_, i) => job(100 + i))));
		await Promise.allSettled([...worker.inflight]);
		assert.equal(Math.max(...peaks), 2, 'never more than the cut-down slots at once');

		now += 1000;
		assert.equal(backoff.slots(4), 1, 'a second failing window halves again');

		// The origin answers again: one slot while the healthy window runs, then a quarter of 4 back.
		failing = false;
		peaks.length = 0;
		await worker.run(jobsOf(Array.from({ length: 8 }, (_, i) => job(200 + i))));
		await Promise.allSettled([...worker.inflight]);
		assert.equal(Math.max(...peaks), 1);
		now += 1000;
		assert.equal(backoff.slots(4), 2, 'ramping back, not snapping back');
		assert.equal(getOriginBackoff(), backoff, 'the one the claim loop reads too');
	} finally {
		await worker.destroy();
	}
});
