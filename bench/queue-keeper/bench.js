/**
 * WHAT AN IN-MEMORY QUEUE KEEPER WOULD COST (queue-state design C).
 *
 * Design C keeps each node's queue in memory on one thread, fed by a subscription on the schedule table,
 * so the table stops being the thing claims and queue-state reads walk. Two things decide whether that is
 * affordable, and this harness measures both on a real Harper storage engine:
 *
 *   Q1  The write tax. A Harper subscription attaches to the DATABASE's audit log, so every commit in it
 *       schedules a notify pass. Measured as writer-thread put latency and whole-process CPU per write,
 *       with no subscription vs a subscription vs a subscription doing the keeper's work.
 *   Q2  The subscriber's cost and correctness. The keeper thread's busy time per write, delivery lag, and
 *       whether a subscription on worker 0 sees every commit made on worker 1 (production writes from
 *       every thread). After the last keeper arm the in-memory copy is compared row-for-row with the table.
 *   Q3  Memory. Heap bytes per queued row for the key strings and for the keeper's structures, at
 *       100k..1M rows, and the rebuild time from a primary-key scan (the startup path once the
 *       `nextRenderTime` index is gone).
 *   Q4  The claim side. Time to produce the best K due rows from per-class due-ordered buckets, which is
 *       what would replace the 5-minute ready-set sweep.
 *
 * Roles: worker 0 seeds, runs the memory tests, owns the subscription and orchestrates; worker 1 is the
 * writer. They coordinate through a named shared buffer. Arms are interleaved round-robin with the order
 * rotated each round, because the storage engine's background work drifts over a run.
 *
 * ABSOLUTE NUMBERS ARE FLOORS (see bench/queue-index/README.md): this is a fresh corpus. Production reads
 * run 20-30x slower per row on a churned LSM. Ratios between arms are what transfer.
 */
import v8 from 'node:v8';
import vm from 'node:vm';
import { MINUTE, keyFor, recordFor, prng, pct, round, sleep, yieldNow, classOf, Keeper } from './shared.js';

const env = (name, fallback) => {
	const n = Number(process.env[name]);
	return Number.isFinite(n) && n >= 0 && process.env[name] !== '' ? n : fallback;
};
const ROWS = Math.max(1_000, env('ROWS', 250_000));
const WRITES = Math.max(100, env('WRITES', 20_000));
const ROUNDS = Math.max(1, env('ROUNDS', 3));
const RATE = env('RATE', 0); // writes/s for the paced arms; 0 = as fast as the writer can go
const BATCH = env('BATCH', 500); // rows per transaction in the batch arm; 0 skips it
const MEM_SIZES = (process.env.MEM_SIZES || '100000,250000,500000,1000000')
	.split(',')
	.map(Number)
	.filter((n) => n > 0);
const TOPK = 5_000;

const log = (...args) => console.log('[bench]', ...args);

// ---- shared control block --------------------------------------------------------------------------------
const I_READY = 0;
const I_CMD = 1;
const I_SEQ = 2;
const I_DONE = 3;
const I_WRITES = 4;
const I_ERR = 5;
const F_ELAPSED = 0;
const F_P50 = 1;
const F_P99 = 2;
const F_P999 = 3;
const F_MAX = 4;
const F_ELU_ACTIVE = 5;
const F_ELU_UTIL = 6;
const CMD_SINGLE = 1;
const CMD_BATCH = 2;
const CMD_STOP = 9;

const control = () => {
	const buffer = databases.bench_ctl.Ctl.primaryStore.getUserSharedBuffer('keeper-bench', new ArrayBuffer(2048));
	return { I: new Int32Array(buffer, 0, 64), F: new Float64Array(buffer, 512, 64) };
};

const tablesReady = async () => {
	for (let i = 0; i < 100; i++) {
		if (databases?.bench_sched?.Sched && databases?.bench_ctl?.Ctl) return true;
		await sleep(200);
	}
	return false;
};

// ---- worker 1: the writer --------------------------------------------------------------------------------
async function writer() {
	const { I, F } = control();
	const { Sched } = databases.bench_sched;
	const { transaction } = await import('harper').catch(() => ({ transaction: globalThis.transaction }));
	while (Atomics.load(I, I_READY) !== 1) await sleep(50);
	let seen = 0;
	let arm = 0;
	for (;;) {
		const seq = Atomics.load(I, I_SEQ);
		if (seq === seen) {
			await sleep(10);
			continue;
		}
		seen = seq;
		const cmd = Atomics.load(I, I_CMD);
		if (cmd === CMD_STOP) return;
		Atomics.store(I, I_ERR, 0);
		const next = prng(0xc0ffee + ++arm * 7919);
		const lat = new Float64Array(WRITES);
		const elu0 = performance.eventLoopUtilization();
		const started = performance.now();
		const gap = RATE > 0 ? 1000 / RATE : 0;
		let written = 0;
		try {
			if (cmd === CMD_BATCH) {
				// Never fall back to single writes under the batch label: that would report the wrong arm.
				if (typeof transaction !== 'function') throw new Error('batch arm requested, but transaction() is unavailable');
				for (let b = 0; written < WRITES; b++) {
					const n = Math.min(BATCH, WRITES - written);
					const t0 = performance.now();
					await transaction(async () => {
						for (let j = 0; j < n; j++) {
							const i = Math.floor(next() * ROWS);
							await Sched.put(keyFor(i), recordFor(i, Date.now(), next()));
						}
					});
					const per = (performance.now() - t0) / n;
					for (let j = 0; j < n; j++) lat[written++] = per;
				}
			} else {
				for (let w = 0; w < WRITES; w++) {
					const i = Math.floor(next() * ROWS);
					const t0 = performance.now();
					await Sched.put(keyFor(i), recordFor(i, Date.now(), next()));
					lat[w] = performance.now() - t0;
					written++;
					if (gap) {
						const wait = started + (w + 1) * gap - performance.now();
						if (wait > 1) await sleep(wait);
					} else if (w % 200 === 0) {
						await yieldNow();
					}
				}
			}
		} catch (e) {
			Atomics.store(I, I_ERR, 1);
			console.error('[bench] writer failed', e);
		}
		const elu = performance.eventLoopUtilization(elu0);
		const done = lat.subarray(0, written);
		F[F_ELAPSED] = performance.now() - started;
		F[F_P50] = pct(done, 0.5);
		F[F_P99] = pct(done, 0.99);
		F[F_P999] = pct(done, 0.999);
		F[F_MAX] = pct(done, 1);
		F[F_ELU_ACTIVE] = elu.active;
		F[F_ELU_UTIL] = elu.utilization;
		Atomics.store(I, I_WRITES, written);
		Atomics.store(I, I_DONE, seq);
	}
}

// ---- worker 0: seed, memory, subscription arms -----------------------------------------------------------
const gc = (() => {
	try {
		v8.setFlagsFromString('--expose_gc');
		return vm.runInNewContext('gc');
	} catch {
		return null;
	}
})();
const heapUsed = async () => {
	if (gc) {
		gc();
		await yieldNow();
		gc();
	}
	return process.memoryUsage().heapUsed;
};
// A fresh flat string, as a key decoded from storage would be (not a slice or a cons of the template).
const flat = (s) => JSON.parse(JSON.stringify(s));

async function seed(Sched, transaction) {
	const started = performance.now();
	const now = Date.now();
	for (let i = 0; i < ROWS; i += 1_000) {
		await transaction(async () => {
			for (let j = i; j < Math.min(ROWS, i + 1_000); j++) await Sched.put(keyFor(j), recordFor(j, now));
		});
		if (i % 50_000 === 0) log(`seeded ${i.toLocaleString()}`);
	}
	return performance.now() - started;
}

async function memoryPhase() {
	const out = [];
	const now = Date.now();
	for (const n of MEM_SIZES) {
		const h0 = await heapUsed();
		let keys = new Array(n);
		for (let i = 0; i < n; i++) keys[i] = flat(keyFor(i));
		const h1 = await heapUsed();
		let keeper = new Keeper();
		for (let i = 0; i < n; i++) keeper.apply(keys[i], recordFor(i, now));
		const h2 = await heapUsed();

		// Moving a row between buckets is the per-event work once the keeper is built.
		const moves = Math.min(n, 200_000);
		const next = prng(424242);
		const t0 = performance.now();
		for (let j = 0; j < moves; j++) {
			const i = Math.floor(next() * n);
			keeper.apply(keys[i], recordFor(i, now, next()));
		}
		const applyUs = ((performance.now() - t0) * 1000) / moves;

		const topSamples = [];
		let lastSize = 0;
		for (let r = 0; r < 20; r++) {
			const t = performance.now();
			lastSize = keeper.topK(TOPK, now).length;
			topSamples.push(performance.now() - t);
		}
		const tc = performance.now();
		const counts = keeper.counts(now);
		const countsMs = performance.now() - tc;

		const row = {
			rows: n,
			avgKeyChars: Math.round(keys.reduce((s, k) => s + k.length, 0) / n),
			keyStringsBytesPerRow: Math.round((h1 - h0) / n),
			keeperBytesPerRow: Math.round((h2 - h1) / n),
			totalMB: round((h2 - h0) / 2 ** 20, 1),
			applyUsPerMove: round(applyUs, 3),
			topK: {
				k: TOPK,
				returned: lastSize,
				medianMs: round(pct(topSamples, 0.5), 2),
				maxMs: round(pct(topSamples, 1), 2),
			},
			countsMs: round(countsMs, 2),
			counts,
		};
		log('memory', JSON.stringify(row));
		out.push(row);
		keys = null;
		keeper = null;
		await heapUsed();
	}
	return out;
}

async function rebuildFromTable(Sched) {
	const h0 = await heapUsed();
	const keeper = new Keeper();
	const started = performance.now();
	let n = 0;
	// No conditions: a primary-key walk, the only scan left once the `nextRenderTime` index is dropped.
	for await (const row of Sched.search(
		{ select: ['cacheKey', 'nextRenderTime', 'fromSitemap', 'effectiveInterval'] },
		{ replicateFrom: false }
	)) {
		keeper.apply(row.cacheKey, row);
		if (++n % 1_000 === 0) await yieldNow();
	}
	const ms = performance.now() - started;
	const h1 = await heapUsed();
	const out = {
		rows: n,
		ms: round(ms, 0),
		usPerRow: round((ms * 1000) / Math.max(1, n), 2),
		heapMB: round((h1 - h0) / 2 ** 20, 1),
	};
	log('rebuild', JSON.stringify(out));
	return { keeper, out };
}

// Every listener ever registered bumps this, so an arm can tell whether an EARLIER arm's subscription is
// still delivering (i.e. ending it did not unregister it) — which would silently tax the 'none' arm.
let allEvents = 0;

async function runArm(ctx, arm, cmd) {
	const { I, F, Sched } = ctx;
	const allAtStart = allEvents;
	let events = 0;
	let applyMs = 0;
	const lags = [];
	let firstEvent = null;
	const byType = {};
	// Duplicate = the same (id, version) delivered twice. Harper does not dedupe; a keeper must not care,
	// but duplicates are extra delivery cost and worth counting.
	const seenVersions = new Set();
	let duplicates = 0;
	// Events whose commit predates this arm's writes: writes made before the subscription existed, which
	// Harper can still deliver (seen after batch commits). Harmless to a keeper (the value is current),
	// but they are not this arm's writes, so they are counted apart from its per-write figures.
	let replayed = 0;
	let armStartEpoch = Infinity;
	let sub = null;
	if (arm !== 'none') {
		sub = await Sched.subscribe({
			omitCurrent: true,
			listener: (e) => {
				allEvents++;
				events++;
				byType[e.type] = (byType[e.type] ?? 0) + 1;
				if (seenVersions.size < 500_000) {
					const tag = `${e.id}|${e.version}`;
					if (seenVersions.has(tag)) duplicates++;
					else seenVersions.add(tag);
				}
				if (!firstEvent)
					firstEvent = {
						keys: Object.keys(e),
						type: e.type,
						localTime: e.localTime,
						hasValue: e.value !== null && e.value !== undefined,
					};
				const lt = Number(e.localTime);
				if (lt < armStartEpoch) replayed++;
				else if (lags.length < 50_000 && Number.isFinite(lt)) lags.push(Date.now() - lt);
				if (arm === 'keeper') {
					const t = performance.now();
					ctx.keeper.apply(e.id, e.type === 'delete' ? null : e.value);
					applyMs += performance.now() - t;
				}
			},
		});
	}
	await sleep(300);
	const cpu0 = process.cpuUsage();
	const elu0 = performance.eventLoopUtilization();
	const started = performance.now();
	const seq = Atomics.load(I, I_SEQ) + 1;
	armStartEpoch = Date.now();
	Atomics.store(I, I_CMD, cmd);
	Atomics.store(I, I_SEQ, seq);
	while (Atomics.load(I, I_DONE) !== seq) await sleep(20);
	const writerDoneMs = performance.now() - started;
	// Drain: the subscription is asynchronous, so wait until events stop arriving.
	let last = -1;
	let quiet = 0;
	while (quiet < 3) {
		await sleep(150);
		if (events === last) quiet++;
		else {
			quiet = 0;
			last = events;
		}
	}
	const elu = performance.eventLoopUtilization(elu0);
	const cpu = process.cpuUsage(cpu0);
	const wallMs = performance.now() - started;
	const writes = Atomics.load(I, I_WRITES);
	const writerFailed = Atomics.load(I, I_ERR) === 1;
	if (sub) {
		try {
			(sub.end ?? sub.return)?.call(sub);
		} catch (e) {
			log('could not end subscription', e?.message);
		}
	}
	return {
		arm,
		mode: cmd === CMD_BATCH ? `batch${BATCH}` : RATE ? `paced${RATE}/s` : 'single',
		writes,
		writerFailed,
		writer: {
			writesPerSec: round((writes * 1000) / F[F_ELAPSED], 0),
			putUs: {
				p50: round(F[F_P50] * 1000, 1),
				p99: round(F[F_P99] * 1000, 1),
				p999: round(F[F_P999] * 1000, 1),
				max: round(F[F_MAX] * 1000, 0),
			},
			eluUtil: round(F[F_ELU_UTIL], 3),
		},
		processCpuUsPerWrite: round((cpu.user + cpu.system) / Math.max(1, writes), 1),
		subscriber: {
			events,
			eventsPerWrite: round(events / Math.max(1, writes), 3),
			busyUsPerWrite: round((elu.active * 1000) / Math.max(1, writes), 1),
			applyUsPerEvent: arm === 'keeper' ? round((applyMs * 1000) / Math.max(1, events), 2) : null,
			lagMs: { p50: round(pct(lags, 0.5), 1), p99: round(pct(lags, 0.99), 1), max: round(pct(lags, 1), 1) },
			drainAfterWriterMs: round(wallMs - writerDoneMs, 0),
			lingeringEventsFromEarlierArms: allEvents - allAtStart - events,
			byType,
			duplicates,
			replayedFromBeforeArm: replayed,
			firstEvent,
		},
	};
}

async function verifyKeeper(Sched, keeper) {
	let rows = 0;
	let mismatched = 0;
	let missing = 0;
	for await (const row of Sched.search(
		{ select: ['cacheKey', 'nextRenderTime', 'fromSitemap', 'effectiveInterval'] },
		{ replicateFrom: false }
	)) {
		rows++;
		const packed = keeper.due.get(row.cacheKey);
		if (packed === undefined) missing++;
		else {
			const expected =
				Math.floor(Number(row.nextRenderTime) / MINUTE) * 16 +
				classOf(Number(row.effectiveInterval), !!row.fromSitemap);
			if (packed !== expected) mismatched++;
		}
		if (rows % 1_000 === 0) await yieldNow();
	}
	return { tableRows: rows, keeperRows: keeper.due.size, missing, mismatched };
}

async function orchestrate() {
	const { I, F } = control();
	const { Sched } = databases.bench_sched;
	const { transaction } = await import('harper').catch(() => ({ transaction: globalThis.transaction }));
	const out = {
		harper: server?.version ?? 'unknown',
		config: { ROWS, WRITES, ROUNDS, RATE, BATCH, MEM_SIZES },
		gcForced: !!gc,
	};
	log('config', JSON.stringify(out));

	const seedMs = await seed(Sched, transaction);
	out.seed = { rows: ROWS, ms: round(seedMs, 0), usPerRow: round((seedMs * 1000) / ROWS, 1) };
	log('seed', JSON.stringify(out.seed));

	out.memory = await memoryPhase();
	const rebuilt = await rebuildFromTable(Sched);
	out.rebuild = rebuilt.out;

	Atomics.store(I, I_READY, 1);
	const ctx = { I, F, Sched, keeper: rebuilt.keeper };
	const arms = ['none', 'count', 'keeper'];
	out.arms = [];
	for (let r = 0; r < ROUNDS; r++) {
		for (let a = 0; a < arms.length; a++) {
			const arm = arms[(a + r) % arms.length];
			const result = await runArm(ctx, arm, CMD_SINGLE);
			result.round = r + 1;
			log('arm', JSON.stringify(result));
			out.arms.push(result);
		}
	}
	if (BATCH > 0) {
		for (const arm of ['none', 'keeper']) {
			const result = await runArm(ctx, arm, CMD_BATCH);
			log('arm', JSON.stringify(result));
			out.arms.push(result);
		}
	}
	// The keeper arms left the in-memory copy current only while subscribed; re-subscribe for a last
	// keeper pass so the comparison covers a copy that saw every write since its last rebuild.
	const fresh = await rebuildFromTable(Sched);
	ctx.keeper = fresh.keeper;
	const finalArm = await runArm(ctx, 'keeper', CMD_SINGLE);
	finalArm.round = 'verify';
	log('arm', JSON.stringify(finalArm));
	out.arms.push(finalArm);
	out.verify = await verifyKeeper(Sched, ctx.keeper);
	log('verify', JSON.stringify(out.verify));

	Atomics.store(I, I_CMD, CMD_STOP);
	Atomics.store(I, I_SEQ, Atomics.load(I, I_SEQ) + 1);
	log('RESULT ' + JSON.stringify(out));
	log('done');
	// Let stdout flush first: the RESULT line is long, and a signal sent at once can cut it off.
	await sleep(1_000);
	process.kill(process.pid, 'SIGTERM');
}

async function main() {
	if (!(await tablesReady())) {
		console.error('[bench] tables never appeared — the schema did not load');
		process.kill(process.pid, 'SIGTERM');
		return;
	}
	const index = server?.workerIndex;
	if (index === 0) return orchestrate();
	if (index === 1) return writer();
}

main().catch((e) => {
	console.error('[bench] failed', e);
	process.kill(process.pid, 'SIGTERM');
});
