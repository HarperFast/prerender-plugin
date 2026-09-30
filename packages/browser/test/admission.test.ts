import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import RenderWorker from '../dist/Worker.js';
import RenderJob from '../dist/RenderJob.js';
import { resolveSettings } from '../dist/settings.js';
import { nextAdmissionLimit } from '../dist/admission.js';
import { parseCpuStallUs, pressureBetween, readCpuStallUs } from '../dist/util/cpu.js';

const LIMITS = { min: 2, max: 10, lowPressure: 15, highPressure: 30 };

test('the limit rises only under low pressure WITH work waiting', () => {
	assert.equal(nextAdmissionLimit(5, 10, true, LIMITS), 6);
	assert.equal(nextAdmissionLimit(5, 10, false, LIMITS), 5, 'no demand: raising would only set up an overshoot');
	assert.equal(nextAdmissionLimit(5, 20, true, LIMITS), 5, 'inside the dead band');
	assert.equal(nextAdmissionLimit(10, 0, true, LIMITS), 10, 'clamped at max');
});

test('the limit falls by one under high pressure, by a quarter when badly overloaded', () => {
	assert.equal(nextAdmissionLimit(8, 31, true, LIMITS), 7);
	assert.equal(nextAdmissionLimit(8, 31, false, LIMITS), 7, 'falls whatever the demand');
	assert.equal(nextAdmissionLimit(8, 61, true, LIMITS), 6, 'above 2 x high: floor(8 * 0.75)');
	assert.equal(nextAdmissionLimit(2, 90, true, LIMITS), 2, 'clamped at min');
});

test('no pressure reading holds the limit', () => {
	assert.equal(nextAdmissionLimit(5, null, true, LIMITS), 5);
});

test('parseCpuStallUs reads the `some total=` stall counter from a PSI file', () => {
	const psi =
		'some avg10=58.50 avg60=40.61 avg300=26.83 total=92392590852\nfull avg10=8.94 avg60=5.21 avg300=2.92 total=12979403604\n';
	assert.equal(parseCpuStallUs(psi), 92392590852);
	assert.equal(parseCpuStallUs('full avg10=8.94 avg60=5.21 avg300=2.92 total=5\n'), null, 'no `some` line');
	assert.equal(parseCpuStallUs(''), null);
});

test('readCpuStallUs is null when the file is missing and reads it when present', () => {
	assert.equal(readCpuStallUs('/nonexistent/cpu.pressure'), null);
	const dir = mkdtempSync(join(tmpdir(), 'psi-'));
	const file = join(dir, 'cpu.pressure');
	writeFileSync(file, 'some avg10=12.25 avg60=1.00 avg300=0.50 total=1234\n');
	assert.equal(readCpuStallUs(file), 1234);
});

test('pressureBetween is the stalled share of the interval, as a percent', () => {
	assert.equal(pressureBetween({ stallUs: 1_000_000, atMs: 0 }, { stallUs: 2_500_000, atMs: 5000 }), 30);
	assert.equal(pressureBetween({ stallUs: 0, atMs: 0 }, { stallUs: 9_000_000, atMs: 5000 }), 100, 'capped at 100');
	assert.equal(pressureBetween({ stallUs: 5, atMs: 1000 }, { stallUs: 9, atMs: 1000 }), null, 'no elapsed time');
	assert.equal(pressureBetween({ stallUs: 9, atMs: 0 }, { stallUs: 5, atMs: 1000 }), null, 'counter went backwards');
});

test('fixed admission (the default) keeps claiming `concurrency` jobs per batch', () => {
	const s = resolveSettings({ harper: {}, concurrency: 5 }, { requireHarper: false });
	assert.equal(s.admission.mode, 'fixed');
	assert.equal(s.jobClaimLimit, 5);
});

test('pressure admission brakes by default: max is concurrency, and the largest claim is max', () => {
	const s = resolveSettings({ harper: {}, concurrency: 5, admission: { mode: 'pressure' } }, { requireHarper: false });
	assert.equal(s.jobClaimLimit, 5);
	assert.deepEqual(
		{ min: s.admission.min, max: s.admission.max, low: s.admission.lowPressure, high: s.admission.highPressure },
		{ min: 2, max: 5, low: 15, high: 30 }
	);
	const raised = resolveSettings(
		{ harper: {}, concurrency: 5, admission: { mode: 'pressure', max: 8 } },
		{ requireHarper: false }
	);
	assert.equal(raised.jobClaimLimit, 8, 'an explicit max raises the claim ceiling with it');
	const low = resolveSettings(
		{ harper: {}, concurrency: 10, admission: { mode: 'pressure', max: 3 } },
		{ requireHarper: false }
	);
	assert.equal(low.admission.min, 3, 'a max below the default min pulls the default min down to it');
	const explicit = resolveSettings(
		{ harper: {}, concurrency: 5, jobClaimLimit: 3, admission: { mode: 'pressure' } },
		{ requireHarper: false }
	);
	assert.equal(explicit.jobClaimLimit, 3, 'an explicit jobClaimLimit still wins');
});

test('pressure admission rejects bounds it cannot step between', () => {
	const resolve = (admission: object) =>
		resolveSettings(
			{ harper: {}, concurrency: 5, admission: { mode: 'pressure', ...admission } },
			{ requireHarper: false }
		);
	assert.throws(() => resolve({ min: 0 }), /admission\.min/);
	assert.throws(() => resolve({ min: 6, max: 4 }), /admission\.max/);
	assert.throws(() => resolve({ lowPressure: 40, highPressure: 30 }), /lowPressure < highPressure/);
	assert.throws(() => resolve({ highPressure: 100 }), /highPressure < 100/);
	assert.throws(() => resolve({ intervalMs: 100 }), /intervalMs/);
	assert.throws(() => resolve({ intervalMs: 2 ** 31 }), /intervalMs/, 'past the timer ceiling Node fires every 1ms');
	assert.throws(
		() => resolveSettings({ harper: {}, admission: { mode: 'bogus' as never } }, { requireHarper: false }),
		/admission\.mode/
	);
});

// ── slot gating on a real worker, stub browser, renders that finish only when told to ─────────────

// A fake queue endpoint that accepts every result POST, so a finished render releases its slot.
let queue: http.Server;
let callbackOrigin = '';

before(async () => {
	queue = http.createServer((req, res) => {
		req.resume();
		req.on('end', () => {
			res.writeHead(204);
			res.end();
		});
	});
	await new Promise<void>((r) => queue.listen(0, '127.0.0.1', r));
	callbackOrigin = `http://127.0.0.1:${(queue.address() as AddressInfo).port}`;
});

after(async () => {
	queue.closeAllConnections();
	await new Promise<void>((r) => queue.close(() => r()));
});

const stubBrowser = () => ({
	jobRefs: 0,
	activePages: 0,
	totalOpenedPages: 0,
	closing: false,
	getPage: async () => ({ isClosed: () => false }),
	closePage: async () => {},
	close: async () => {},
});

const deferred = () => {
	let resolve = () => {};
	const promise = new Promise<void>((r) => (resolve = r));
	return { promise, resolve };
};

// For asserting something does NOT happen: long enough for a render to have started if it could.
const settle = () => new Promise((r) => setTimeout(r, 30));

// For asserting something DOES happen: a render start waits on a real result POST to the local
// queue, which under a loaded test run can take well past any fixed sleep.
async function until(condition: () => boolean, timeoutMs = 2000) {
	const deadline = Date.now() + timeoutMs;
	while (!condition() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
}

function gatedWorker(concurrency: number) {
	const started: string[] = [];
	const release = new Map<string, () => void>();
	let draining = false;
	const worker = new RenderWorker({
		maxConcurrency: concurrency,
		rps: 1000,
		renderer: (async (_page: unknown, job: RenderJob) => {
			started.push(job.id);
			const gate = deferred();
			release.set(job.id, gate.resolve);
			if (!draining) await gate.promise;
			job.httpResponse = { statusCode: 200, headers: {} };
			job.isIndexable = true;
			return '<html></html>';
		}) as never,
	});
	worker.browser = stubBrowser() as never;
	// No real pressure steps mid-test: on a Linux runner with PSI the timer would read the host.
	clearTimeout((worker as unknown as { admissionTimer: NodeJS.Timeout | null }).admissionTimer ?? undefined);
	// Teardown: finish every started render, and any the worker starts after this.
	const drain = () => {
		draining = true;
		for (const resolve of release.values()) resolve();
	};
	return { worker, started, release, drain };
}

const job = (n: number) =>
	new RenderJob({
		id: `job-${n}`,
		url: `http://127.0.0.1:9/page/${n}`,
		expiresAt: Date.now() + 60_000,
		deviceType: 'desktop',
		callbackOrigin,
		isFromSitemap: false,
	});

async function* jobsOf(list: RenderJob[]) {
	for (const j of list) yield j;
}

test('under pressure admission a raised limit starts a waiting render without waiting for one to finish', async () => {
	resolveSettings(
		{ harper: {}, concurrency: 2, admission: { mode: 'pressure', min: 1, max: 4, intervalMs: 60_000 } },
		{ requireHarper: false }
	);
	const { worker, started, release, drain } = gatedWorker(2);
	const w = worker as unknown as { applyAdmissionLimit(n: number): void; admissionLimit: number };
	const running = worker.run(jobsOf([1, 2, 3, 4, 5].map(job)));
	try {
		await until(() => started.length >= 2);
		await settle();
		assert.equal(started.length, 2, 'starts at `concurrency`');
		w.applyAdmissionLimit(3);
		await until(() => started.length >= 3);
		assert.equal(started.length, 3, 'the raise alone admitted a third render');
		w.applyAdmissionLimit(1);
		release.get('job-1')!();
		await settle();
		assert.equal(started.length, 3, 'lowered to 1 with 2 still running: nothing new starts');
		release.get('job-2')!();
		release.get('job-3')!();
		await until(() => started.length >= 4);
		await settle();
		assert.equal(started.length, 4, 'below the lowered limit again: one more starts');
	} finally {
		drain();
		await running.catch(() => {});
		await Promise.allSettled([...worker.inflight]);
		await worker.destroy();
	}
});

test('under fixed admission the worker still runs exactly `concurrency` renders at once', async () => {
	resolveSettings({ harper: {}, concurrency: 2 }, { requireHarper: false });
	const { worker, started, release, drain } = gatedWorker(2);
	const running = worker.run(jobsOf([1, 2, 3].map(job)));
	try {
		await until(() => started.length >= 2);
		await settle();
		assert.equal(started.length, 2);
		release.get('job-1')!();
		await until(() => started.length >= 3);
		assert.equal(started.length, 3);
	} finally {
		drain();
		await running.catch(() => {});
		await Promise.allSettled([...worker.inflight]);
		await worker.destroy();
	}
});

test('a pressure step raises the limit only when a job waited for a slot', () => {
	resolveSettings(
		{ harper: {}, concurrency: 2, admission: { mode: 'pressure', min: 1, max: 4, intervalMs: 60_000 } },
		{ requireHarper: false }
	);
	const { worker } = gatedWorker(2);
	const w = worker as unknown as {
		stepAdmission(a: object, p: number | null): void;
		admissionLimit: number;
		demandSinceStep: boolean;
		waitingForSlot: boolean;
		pool: { size: number } | null;
	};
	const admission = { min: 1, max: 4, lowPressure: 15, highPressure: 30 };
	try {
		w.stepAdmission(admission, 5);
		assert.equal(w.admissionLimit, 2, 'low pressure but nothing waiting');
		w.demandSinceStep = true;
		w.stepAdmission(admission, 5);
		assert.equal(w.admissionLimit, 3, 'low pressure and a job waited');
		assert.equal(w.demandSinceStep, false, 'the step consumes the demand flag');
		w.stepAdmission(admission, 45);
		assert.equal(w.admissionLimit, 2, 'high pressure steps down');
		w.stepAdmission(admission, 20);
		w.waitingForSlot = true;
		w.stepAdmission(admission, 5);
		assert.equal(w.admissionLimit, 3, 'a job still waiting from before the last step is still demand');
		w.waitingForSlot = false;
		w.pool = { size: 2 };
		w.stepAdmission(admission, 5);
		assert.equal(w.admissionLimit, 3, 'pooled jobs with slots free are prefetching ahead, not held back');
		w.pool = null;
	} finally {
		void worker.destroy();
	}
});

test('with a prefetch pool, full slots are demand only while the pool holds a job', async () => {
	resolveSettings(
		{ harper: {}, concurrency: 1, admission: { mode: 'pressure', min: 1, max: 4, intervalMs: 60_000 } },
		{ requireHarper: false }
	);
	const { worker } = gatedWorker(1);
	const w = worker as unknown as {
		awaitSlot(): Promise<void>;
		pool: { size: number } | null;
		demandSinceStep: boolean;
	};
	const busy = deferred();
	worker.inflight.add(busy.promise);
	try {
		w.pool = { size: 0 };
		const emptyWait = w.awaitSlot();
		await settle();
		assert.equal(w.demandSinceStep, false, 'slots full, pool empty: nothing is held back');

		w.pool = { size: 1 };
		const pooledWait = w.awaitSlot();
		await settle();
		assert.equal(w.demandSinceStep, true, 'slots full, a pooled job waiting: demand');

		worker.inflight.clear();
		busy.resolve();
		await Promise.all([emptyWait, pooledWait]);
	} finally {
		w.pool = null;
		await worker.destroy();
	}
});

test('under pressure admission a claim is sized to what can start soon', async () => {
	resolveSettings(
		{ harper: {}, concurrency: 2, admission: { mode: 'pressure', min: 1, max: 6, intervalMs: 60_000 } },
		{ requireHarper: false }
	);
	const { worker } = gatedWorker(2);
	const w = worker as unknown as {
		claimSize(): number;
		applyAdmissionLimit(n: number): void;
		pool: { size: number; capacity: number } | null;
	};
	try {
		w.applyAdmissionLimit(4);
		assert.equal(w.claimSize(), 4, 'nothing running: every slot');
		worker.inflight.add(new Promise(() => {}));
		assert.equal(w.claimSize(), 3, 'one running: the free slots');
		w.applyAdmissionLimit(1);
		assert.equal(w.claimSize(), 1, 'no free slot: still one, to have the next job in hand');
		w.pool = { size: 1, capacity: 8 };
		assert.equal(w.claimSize(), 6, 'prefetching: the free pool room, capped by jobClaimLimit (max)');
		w.pool = { size: 7, capacity: 8 };
		assert.equal(w.claimSize(), 1);
	} finally {
		w.pool = null;
		worker.inflight.clear();
		await worker.destroy();
	}
});

test('under fixed admission a claim is always jobClaimLimit', async () => {
	resolveSettings({ harper: {}, concurrency: 3 }, { requireHarper: false });
	const { worker } = gatedWorker(3);
	try {
		worker.inflight.add(new Promise(() => {}));
		assert.equal((worker as unknown as { claimSize(): number }).claimSize(), 3);
	} finally {
		worker.inflight.clear();
		await worker.destroy();
	}
});
