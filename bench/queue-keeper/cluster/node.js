/**
 * THE TWO-NODE QUEUE KEEPER: what replication does to a subscription-fed in-memory queue.
 *
 * Runs on every node of a two-container harper-pro cluster (see run.sh). The schedule table is pinned
 * the way production pins RenderSchedule: `setResidencyById(key => [owner])`, with the owner chosen by
 * rendezvous hashing over the node names. So each node stores only the rows it owns, and every node
 * writes rows of both owners, as production's claim, result, sitemap and probe paths do.
 *
 *   Q1  Does the owner's subscription see a write made on the OTHER node, and how late?
 *   Q2  What does a writer's subscription see for a row it writes but does not own?
 *   Q3  What does joining the cluster (a base copy each way) deliver to a live keeper, and at what cost?
 *   Q4  After all of it, is each node's keeper exactly its own table, and is every row on its owner?
 *
 * Roles per node: worker 0 keeps the queue and runs commands; worker 1 writes. A host-side driver
 * (driver.mjs) sequences both nodes through a mailbox row in a non-replicated control table: it PUTs
 * `Ctl/cmd` and polls `Ctl/res`. Worker 0 and worker 1 coordinate through a named shared buffer.
 *
 * Every write's `nextRenderTime` is shifted by under N ms so that `nextRenderTime % N` is the index of
 * the node that wrote it. The keeper buckets by minute, so the tag changes nothing it computes, and it
 * lets a listener tell a local write from a replicated one without adding a field to the row.
 */
import { threadId } from 'node:worker_threads';
import { keyFor, recordFor, prng, pct, round, sleep, yieldNow, classOf, Keeper, MINUTE } from './shared.js';

const env = (name, fallback) => {
	const n = Number(process.env[name]);
	return Number.isFinite(n) && n >= 0 && process.env[name] !== '' ? n : fallback;
};
const NODES = (process.env.BENCH_NODES || 'node-a,node-b').split(',').sort();
const ROWS = Math.max(1_000, env('ROWS', 250_000)); // rows per node
const KEYSPACE = ROWS * NODES.length;
const RATE = env('RATE', 0); // writes/s per node; 0 = as fast as the writer can go

const log = (...args) => console.log('[bench]', server.hostname, ...args);

// production's hash (packages/plugin/src/util/hash.js) and its rendezvous pick (util/residency.js)
const fnv1a32 = (s) => {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
	}
	return h >>> 0;
};
const ownerIndexOf = (key) => {
	let best = 0;
	let bestScore = -1;
	for (let i = 0; i < NODES.length; i++) {
		const score = fnv1a32(`${key}|${NODES[i]}`);
		if (score > bestScore) {
			bestScore = score;
			best = i;
		}
	}
	return best;
};

// the row a node writes: due time tagged with the writer's index (see the header)
const tagged = (record, writerIndex) => {
	const t = record.nextRenderTime;
	record.nextRenderTime = t - (t % NODES.length) + writerIndex;
	return record;
};
const writerOf = (value) => Number(value.nextRenderTime) % NODES.length;

// ---- shared control block (worker 0 <-> worker 1) ---------------------------------------------------
const I_SEQ = 0;
const I_CMD = 1;
const I_DONE = 2;
const I_N = 3;
const I_ERR = 4;
const I_WROTE = 5; // [owned, remote]
const I_TO = 8; // writes per owner index, up to 8 nodes
const F_ELAPSED = 0;
const F_LAT = 8; // [owned p50, p99, p999, max, remote p50, p99, p999, max]
const CMD_WRITE = 1;
const CMD_STOP = 9;

const control = () => {
	const buffer = databases.bench_ctl.Ctl.primaryStore.getUserSharedBuffer('keeper-cluster', new ArrayBuffer(4096));
	return { I: new Int32Array(buffer, 0, 128), F: new Float64Array(buffer, 1024, 64) };
};
// Every row index the writer wrote in its last command, in order: the driver's coverage check.
const MAX_LOGGED = 1_000_000;
const keyLog = () =>
	new Int32Array(
		databases.bench_ctl.Ctl.primaryStore.getUserSharedBuffer('keeper-cluster-keys', new ArrayBuffer(4 * MAX_LOGGED))
	);
const indexOfKey = (key) => Number(/\/prd-(\d+)\//.exec(key)?.[1]) - 1_000_000;

// ---- worker 1: the writer ----------------------------------------------------------------------------
async function writer(self) {
	const { I, F } = control();
	const logged = keyLog();
	const { Sched } = databases.bench_sched;
	let seen = 0;
	for (;;) {
		const seq = Atomics.load(I, I_SEQ);
		if (seq === seen) {
			await sleep(10);
			continue;
		}
		seen = seq;
		if (Atomics.load(I, I_CMD) === CMD_STOP) return;
		const n = Atomics.load(I, I_N);
		const next = prng(0xc0ffee + seq * 7919 + self * 104729);
		const lat = [new Float64Array(n), new Float64Array(n)];
		const wrote = [0, 0];
		const to = new Array(NODES.length).fill(0);
		const gap = RATE > 0 ? 1000 / RATE : 0;
		const started = performance.now();
		try {
			for (let w = 0; w < n; w++) {
				const i = Math.floor(next() * KEYSPACE);
				const key = keyFor(i);
				const owner = ownerIndexOf(key);
				const record = tagged(recordFor(i, Date.now(), next()), self);
				const t0 = performance.now();
				await Sched.put(key, record);
				const k = owner === self ? 0 : 1;
				lat[k][wrote[k]++] = performance.now() - t0;
				to[owner]++;
				if (w < MAX_LOGGED) logged[w] = i;
				if (gap) {
					const wait = started + (w + 1) * gap - performance.now();
					if (wait > 1) await sleep(wait);
				} else if (w % 200 === 0) await yieldNow();
			}
		} catch (e) {
			Atomics.store(I, I_ERR, 1);
			console.error('[bench] writer failed', e);
		}
		F[F_ELAPSED] = performance.now() - started;
		for (let k = 0; k < 2; k++) {
			const done = lat[k].subarray(0, wrote[k]);
			F[F_LAT + k * 4] = pct(done, 0.5) ?? NaN;
			F[F_LAT + k * 4 + 1] = pct(done, 0.99) ?? NaN;
			F[F_LAT + k * 4 + 2] = pct(done, 0.999) ?? NaN;
			F[F_LAT + k * 4 + 3] = pct(done, 1) ?? NaN;
			I[I_WROTE + k] = wrote[k];
		}
		for (let o = 0; o < NODES.length; o++) I[I_TO + o] = to[o];
		Atomics.store(I, I_DONE, seq);
	}
}

// ---- worker 0: keeper, commands ----------------------------------------------------------------------
const SELECT = ['cacheKey', 'nextRenderTime', 'fromSitemap', 'effectiveInterval'];

async function seed(Sched, transaction, self) {
	const started = performance.now();
	const now = Date.now();
	let rows = 0;
	for (let i = 0; i < KEYSPACE; i += 1_000) {
		await transaction(async () => {
			for (let j = i; j < Math.min(KEYSPACE, i + 1_000); j++) {
				const key = keyFor(j);
				if (ownerIndexOf(key) !== self) continue;
				await Sched.put(key, tagged(recordFor(j, now), self));
				rows++;
			}
		});
	}
	const ms = performance.now() - started;
	return { rows, ms: round(ms, 0), usPerRow: round((ms * 1000) / Math.max(1, rows), 1) };
}

async function rebuild(Sched) {
	const keeper = new Keeper();
	const started = performance.now();
	let n = 0;
	for await (const row of Sched.search({ select: SELECT }, { replicateFrom: false })) {
		keeper.apply(row.cacheKey, row);
		if (++n % 1_000 === 0) await yieldNow();
	}
	const ms = performance.now() - started;
	return { keeper, out: { rows: n, ms: round(ms, 0), usPerRow: round((ms * 1000) / Math.max(1, n), 2) } };
}

async function verify(Sched, keeper, self) {
	let rows = 0;
	let missing = 0;
	let mismatched = 0;
	let notOwned = 0;
	for await (const row of Sched.search({ select: SELECT }, { replicateFrom: false })) {
		rows++;
		if (ownerIndexOf(row.cacheKey) !== self) notOwned++;
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
	// keeper rows the table does not have: a keeper that kept a row it should have dropped
	const extra = keeper.due.size - (rows - missing);
	return { tableRows: rows, keeperRows: keeper.due.size, missing, mismatched, extra, notOwned };
}

// A row this node owns, outside the keyspace. Written and deleted by the `tombstone` command, which
// leaves a deleted entry in this node's table: the one kind of row a base copy carries to a peer here.
const sentinelFor = (self) => {
	for (let n = 0; ; n++) {
		const key = `https://www.example.com/bench-sentinel/${n}`;
		if (ownerIndexOf(key) === self) return key;
	}
};

/**
 * One measurement window. `mode` is 'none' (no subscription) or 'keeper' (the listener maintains the
 * in-memory queue).
 *
 * A new subscription can be handed every row written while this thread had none: each thread walks the
 * audit log with one iterator per database, the walk is skipped while the thread has no subscriber, and
 * the next commit resumes it from where it stopped (core/resources/transactionBroadcast.ts). So the
 * keeper arm `kick`s: it rewrites one row it owns (one commit, no tombstone), and opens the window only
 * after that replay has gone quiet. The replay is reported as `settle`, apart from the window.
 */
async function openArm(ctx, mode, self, kick = true) {
	const st = {
		mode,
		settle: { events: 0, ms: 0 },
		events: 0,
		byType: {},
		// events whose version predates the window: re-delivered rows (a reload), not this window's writes
		preWindow: 0,
		putsByWriter: new Array(NODES.length).fill(0),
		deletes: 0,
		putsNotOwned: 0,
		received: new Set(), // row indices this window delivered a put for: the driver's coverage check
		lags: [[], []], // [local, replicated], ms from the writer's commit to this listener
		applyMs: 0,
		windowStartEpoch: Infinity,
		sub: null,
	};
	if (mode === 'keeper') {
		st.sub = await ctx.Sched.subscribe({
			omitCurrent: true,
			listener: (e) => {
				st.events++;
				st.byType[e.type] = (st.byType[e.type] ?? 0) + 1;
				const version = Number(e.version);
				if (version < st.windowStartEpoch) st.preWindow++;
				else if (e.type === 'delete') st.deletes++;
				else if (e.value) {
					const w = writerOf(e.value);
					st.putsByWriter[w]++;
					st.received.add(indexOfKey(e.id));
					const lags = st.lags[w === self ? 0 : 1];
					if (lags.length < 50_000) lags.push(Date.now() - version);
				}
				if (e.value && ownerIndexOf(e.id) !== self) st.putsNotOwned++;
				const t = performance.now();
				ctx.keeper.apply(e.id, e.type === 'delete' ? null : e.value);
				st.applyMs += performance.now() - t;
			},
		});
		const t0 = performance.now();
		if (kick) await ctx.Sched.put(keyFor(ctx.kickIndex), tagged(recordFor(ctx.kickIndex, Date.now()), self));
		let last = -1;
		let quiet = 0;
		while (quiet < 4) {
			await sleep(125);
			if (st.events === last) quiet++;
			else {
				quiet = 0;
				last = st.events;
			}
		}
		st.settle = { events: st.events, byType: st.byType, ms: round(performance.now() - t0, 0) };
		st.events = 0;
		st.byType = {};
		st.preWindow = 0;
		st.deletes = 0;
		st.putsNotOwned = 0;
		st.putsByWriter.fill(0);
		st.received = new Set();
		st.lags = [[], []];
		st.applyMs = 0;
	}
	st.cpu0 = process.cpuUsage();
	st.elu0 = performance.eventLoopUtilization();
	st.t0 = performance.now();
	st.windowStartEpoch = Date.now();
	ctx.arm = st;
	return { mode, settle: st.settle };
}

function closeArm(ctx) {
	const st = ctx.arm;
	if (!st) throw new Error('no open arm');
	const cpu = process.cpuUsage(st.cpu0);
	const elu = performance.eventLoopUtilization(st.elu0);
	const wallMs = performance.now() - st.t0;
	if (st.sub) {
		try {
			(st.sub.end ?? st.sub.return)?.call(st.sub);
		} catch (e) {
			log('could not end subscription', e?.message);
		}
	}
	ctx.arm = null;
	ctx.lastReceived = st.received;
	const lag = (a) => ({
		n: a.length,
		p50: round(pct(a, 0.5), 1),
		p99: round(pct(a, 0.99), 1),
		max: round(pct(a, 1), 1),
	});
	return {
		mode: st.mode,
		wallMs: round(wallMs, 0),
		processCpuMs: round((cpu.user + cpu.system) / 1000, 1),
		worker0BusyMs: round(elu.active, 1),
		settle: st.settle,
		events: st.events,
		byType: st.byType,
		preWindow: st.preWindow,
		putsByWriter: Object.fromEntries(NODES.map((n, i) => [n, st.putsByWriter[i]])),
		deletes: st.deletes,
		putsNotOwned: st.putsNotOwned,
		lagLocalMs: lag(st.lags[0]),
		lagReplicatedMs: lag(st.lags[1]),
		keeperApplyMs: round(st.applyMs, 1),
	};
}

function writerResult(I, F) {
	const lat = (k) => ({
		n: I[I_WROTE + k],
		p50: round(F[F_LAT + k * 4] * 1000, 1),
		p99: round(F[F_LAT + k * 4 + 1] * 1000, 1),
		p999: round(F[F_LAT + k * 4 + 2] * 1000, 1),
		max: round(F[F_LAT + k * 4 + 3] * 1000, 0),
	});
	return {
		done: true,
		error: I[I_ERR] === 1,
		elapsedMs: round(F[F_ELAPSED], 0),
		putUsOwned: lat(0),
		putUsRemote: lat(1),
		writesTo: Object.fromEntries(NODES.map((n, i) => [n, I[I_TO + i]])),
	};
}

async function worker0(self) {
	const { I, F } = control();
	const { Sched } = databases.bench_sched;
	const { Ctl } = databases.bench_ctl;
	const { transaction } = await import('harper').catch(() => ({ transaction: globalThis.transaction }));
	const ctx = { Sched, keeper: new Keeper(), arm: null, lastReceived: new Set() };
	// the kick's row: the first row of the keyspace this node owns
	for (ctx.kickIndex = 0; ownerIndexOf(keyFor(ctx.kickIndex)) !== self; ctx.kickIndex++);
	const commands = {
		hello: () => ({ node: server.hostname, self, threadId, nodes: NODES, rows: ROWS, keyspace: KEYSPACE, rate: RATE }),
		seed: () => seed(Sched, transaction, self),
		rebuild: async () => {
			const { keeper, out } = await rebuild(Sched);
			ctx.keeper = keeper;
			return out;
		},
		open: ({ mode, kick }) => openArm(ctx, mode, self, kick !== false),
		close: () => closeArm(ctx),
		write: ({ n }) => {
			Atomics.store(I, I_ERR, 0);
			Atomics.store(I, I_N, n);
			Atomics.store(I, I_CMD, CMD_WRITE);
			Atomics.store(I, I_SEQ, Atomics.load(I, I_SEQ) + 1);
			return { seq: Atomics.load(I, I_SEQ) };
		},
		// the driver polls this: whether the writer finished, and how many events have arrived so far
		status: () => {
			const writing = Atomics.load(I, I_DONE) !== Atomics.load(I, I_SEQ);
			return {
				writer: writing ? { done: false } : writerResult(I, F),
				events: ctx.arm ? ctx.arm.events + ctx.arm.settle.events : 0,
			};
		},
		verify: () => verify(Sched, ctx.keeper, self),
		// leave a deleted row in this node's table (see sentinelFor); no subscription is involved
		tombstone: async () => {
			const key = sentinelFor(self);
			await Sched.put(key, { nextRenderTime: Date.now(), fromSitemap: false, effectiveInterval: 0 });
			await Sched.delete(key);
			return { key };
		},
		// for the driver's coverage check: the distinct rows the writer last wrote, by owner, and the
		// distinct rows the last closed keeper window delivered a put for
		keys: () => {
			const logged = keyLog();
			const n = Math.min(Atomics.load(I, I_N), MAX_LOGGED);
			const writtenTo = NODES.map(() => new Set());
			for (let w = 0; w < n; w++) writtenTo[ownerIndexOf(keyFor(logged[w]))].add(logged[w]);
			return {
				writtenTo: Object.fromEntries(NODES.map((name, o) => [name, [...writtenTo[o]]])),
				received: [...ctx.lastReceived],
			};
		},
		stop: () => {
			Atomics.store(I, I_CMD, CMD_STOP);
			Atomics.store(I, I_SEQ, Atomics.load(I, I_SEQ) + 1);
			return { stopped: true };
		},
	};
	log('ready', JSON.stringify(commands.hello()));
	let lastSeq = 0;
	for (;;) {
		await sleep(25);
		const cmd = await Ctl.get('cmd');
		if (!cmd || !(cmd.seq > lastSeq)) continue;
		lastSeq = cmd.seq;
		let res;
		try {
			const handler = commands[cmd.name];
			if (!handler) throw new Error(`unknown command ${cmd.name}`);
			res = { seq: cmd.seq, ok: true, result: await handler(cmd.args ?? {}) };
		} catch (e) {
			res = { seq: cmd.seq, ok: false, error: String(e?.stack ?? e) };
		}
		await Ctl.put('res', res);
		if (cmd.name !== 'status') log(cmd.name, JSON.stringify(res).slice(0, 2_000));
	}
}

async function main() {
	for (let i = 0; i < 100 && !(databases?.bench_sched?.Sched && databases?.bench_ctl?.Ctl); i++) await sleep(200);
	const { Sched } = databases.bench_sched ?? {};
	if (!Sched || !databases?.bench_ctl?.Ctl) {
		console.error('[bench] tables never appeared — the schema did not load');
		return;
	}
	const self = NODES.indexOf(server.hostname);
	if (self < 0) {
		console.error(`[bench] this node (${server.hostname}) is not in BENCH_NODES (${NODES.join(',')})`);
		return;
	}
	// Every thread, like production's RenderSchedule module: the residency function is per-thread state.
	Sched.setResidencyById((key) => [NODES[ownerIndexOf(key)]]);
	if (server.workerIndex === 0) return worker0(self);
	if (server.workerIndex === 1) return writer(self);
}

main().catch((e) => console.error('[bench] failed', e));
