/**
 * Host-side driver for the two-node queue-keeper benchmark (see node.js for what is measured and
 * run.sh for the containers). Sequences both nodes through the phases below via each node's mailbox
 * (`PUT Ctl/cmd`, poll `GET Ctl/res`), joins them with the operations API, and prints one RESULT line.
 *
 *   1. seed    each node, still unclustered, writes the rows it owns; keepers rebuild from a PK scan;
 *              then an idle window, the per-second baseline with no writes
 *   2. join    keepers live on both nodes, then add_node: a base copy each way (Q3)
 *   3. arms    `none` / `keeper`, interleaved and rotated per round; both writers run at once (Q1, Q2)
 *   4. verify  rebuild, one more keeper arm, then each keeper against its own table (Q4)
 */
import { writeFileSync } from 'node:fs';

const env = (name, fallback) => {
	const n = Number(process.env[name]);
	return Number.isFinite(n) && n >= 0 && process.env[name] ? n : fallback;
};
const WRITES = env('WRITES', 20_000); // per node per arm
const ROUNDS = env('ROUNDS', 3);
// 0 opens the join's keepers without their kick commit (see node.js openArm)
const JOIN_KICK = env('JOIN_KICK', 1);
// 1 leaves a deleted row in each node's table before the join, so the base copy carries one row
const JOIN_TOMBSTONE = env('JOIN_TOMBSTONE', 0);
const USER = process.env.BENCH_USER ?? 'bench_admin';
const PASS = process.env.BENCH_PASS;
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
const NODES = [
	{ name: 'node-a', http: env('A_HTTP', 9961), ops: env('A_OPS', 9965) },
	{ name: 'node-b', http: env('B_HTTP', 9971), ops: env('B_OPS', 9975) },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log('[driver]', ...args);
const round = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : n);

async function request(url, method, body) {
	const res = await fetch(url, {
		method,
		headers: { 'authorization': AUTH, 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 300)}`);
	return text ? JSON.parse(text) : null;
}
const op = (node, body) => request(`http://127.0.0.1:${node.ops}/`, 'POST', body);

let nextSeq = Date.now();
// The mailbox holds ONE command, so calls to a node are serialized: a second PUT before the first
// command is picked up would overwrite it, and the first caller would wait out its whole timeout.
function call(node, name, args = {}, timeoutMs = 600_000) {
	const run = (node.chain ?? Promise.resolve()).then(() => callNow(node, name, args, timeoutMs));
	node.chain = run.catch(() => {});
	return run;
}
async function callNow(node, name, args, timeoutMs) {
	const seq = ++nextSeq;
	await request(`http://127.0.0.1:${node.http}/Ctl/cmd`, 'PUT', { id: 'cmd', seq, name, args });
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await sleep(name === 'status' ? 20 : 100);
		const res = await request(`http://127.0.0.1:${node.http}/Ctl/res`, 'GET').catch(() => null);
		if (res?.seq !== seq) continue;
		if (!res.ok) throw new Error(`${node.name} ${name} failed: ${res.error}`);
		return res.result;
	}
	throw new Error(`${node.name} ${name} timed out after ${timeoutMs} ms`);
}
const both = (fn) => Promise.all(NODES.map(fn));

async function waitReady(node) {
	const deadline = Date.now() + 180_000;
	for (;;) {
		try {
			return await call(node, 'hello', {}, 5_000);
		} catch (e) {
			if (Date.now() > deadline) throw new Error(`${node.name}: component never answered (${e.message})`);
			await sleep(1_000);
		}
	}
}

const connectedBoth = async () => {
	const states = await both(async (node) => {
		const status = await op(node, { operation: 'cluster_status' });
		const sockets = (status.connections ?? []).flatMap((c) => c.database_sockets ?? []);
		return sockets.some((s) => s.database === 'bench_sched' && s.connected);
	});
	return states.every(Boolean);
};

/**
 * Watch a join from add_node until replication is connected both ways and no node's event count has
 * moved for `stableMs` (and at least `minMs` has passed). The timeline is [ms since add_node, events
 * per node], one row per change.
 */
async function watchJoin(t0, { stableMs = 5_000, minMs = 15_000 } = {}) {
	const timeline = [];
	let last = null;
	let lastChange = Date.now();
	let connectedAfterMs = null;
	for (;;) {
		const counts = (await both((node) => call(node, 'status'))).map((s) => s.events);
		const now = Date.now();
		if (counts.join() !== last) {
			last = counts.join();
			lastChange = now;
			timeline.push([now - t0, ...counts]);
		}
		if (connectedAfterMs === null && (await connectedBoth())) connectedAfterMs = Date.now() - t0;
		if (connectedAfterMs !== null && now - lastChange >= stableMs && now - t0 >= minMs) {
			return { timeline, connectedAfterMs, lastEventAfterMs: lastChange - t0 };
		}
		if (now - t0 > 900_000) throw new Error(`join never settled (connected: ${connectedAfterMs !== null})`);
		await sleep(200);
	}
}

/** Poll until no node's event count has moved for `stableMs` (and at least `minMs` has passed). */
async function waitQuiet({ stableMs = 1_500, minMs = 0 } = {}) {
	const started = Date.now();
	let last = null;
	let lastChange = Date.now();
	let writersDone = false;
	let statuses;
	for (;;) {
		statuses = await both((node) => call(node, 'status'));
		const counts = statuses.map((s) => s.events).join(',');
		if (counts !== last) {
			last = counts;
			lastChange = Date.now();
		}
		const writing = statuses.some((s) => !s.writer.done);
		// The quiet period starts no earlier than the writers finishing, so a window with no events (the
		// `none` arm) runs the same tail as one whose events stop with the writes.
		if (!writing && !writersDone) {
			writersDone = true;
			lastChange = Math.max(lastChange, Date.now());
		}
		if (!writing && Date.now() - lastChange >= stableMs && Date.now() - started >= minMs) break;
		if (Date.now() - started > 900_000) throw new Error('events never went quiet');
		await sleep(250);
	}
	return { statuses, lastEventAfterMs: lastChange - started };
}

/** Per-write ratios from the raw per-node totals. */
function summarize(label, closed, writers) {
	const clusterWrites = writers.reduce((s, w) => s + w.putUsOwned.n + w.putUsRemote.n, 0);
	return {
		label,
		clusterWrites,
		nodes: NODES.map((node, i) => {
			const c = closed[i];
			const w = writers[i];
			const expectedPuts = writers.reduce((s, x) => s + (x.writesTo?.[node.name] ?? 0), 0);
			const observedPuts = Object.values(c.putsByWriter).reduce((s, n) => s + n, 0);
			return {
				node: node.name,
				mode: c.mode,
				wallMs: c.wallMs,
				processCpuMs: c.processCpuMs,
				worker0BusyMs: c.worker0BusyMs,
				processCpuUsPerClusterWrite: clusterWrites ? round((c.processCpuMs * 1000) / clusterWrites) : null,
				worker0BusyUsPerClusterWrite: clusterWrites ? round((c.worker0BusyMs * 1000) / clusterWrites) : null,
				writer: {
					putUsOwned: w.putUsOwned,
					putUsRemote: w.putUsRemote,
					writesPerSec: round(((w.putUsOwned.n + w.putUsRemote.n) * 1000) / Math.max(1, w.elapsedMs), 0),
					error: w.error,
				},
				subscriber:
					c.mode === 'keeper'
						? {
								settle: c.settle,
								events: c.events,
								byType: c.byType,
								// puts this node should have seen: every write, from either node, to a row it owns
								expectedPuts,
								observedPuts,
								putsByWriter: c.putsByWriter,
								// one per write this node made to a row the other node owns
								deletes: c.deletes,
								expectedDeletes: w.putUsRemote.n,
								putsNotOwned: c.putsNotOwned,
								preWindow: c.preWindow,
								lagLocalMs: c.lagLocalMs,
								lagReplicatedMs: c.lagReplicatedMs,
								keeperApplyUsPerEvent: round((c.keeperApplyMs * 1000) / Math.max(1, c.events), 2),
								// deletes are no-ops, so this is closer to the cost of the work that matters
								keeperApplyUsPerPut: round((c.keeperApplyMs * 1000) / Math.max(1, observedPuts), 2),
							}
						: null,
			};
		}),
	};
}

const IDLE_WRITER = {
	putUsOwned: { n: 0 },
	putUsRemote: { n: 0 },
	writesTo: {},
	elapsedMs: 0,
	error: false,
};

/**
 * For each node: every distinct row written to it in the window, by either node, must have been
 * delivered to its keeper as a put. `writtenMoreThanOnce` is how many writes a put could have been
 * superseded by: Harper delivers only the current version of a row.
 */
async function coverage() {
	const keys = await both((node) => call(node, 'keys'));
	return NODES.map((node, i) => {
		const expected = new Set(keys.flatMap((k) => k.writtenTo[node.name]));
		const received = new Set(keys[i].received);
		let missing = 0;
		for (const row of expected) if (!received.has(row)) missing++;
		return { node: node.name, distinctRowsWritten: expected.size, delivered: received.size, missing };
	});
}

async function arm(mode) {
	await both((node) => call(node, 'open', { mode }));
	await both((node) => call(node, 'write', { n: WRITES }));
	const { statuses } = await waitQuiet();
	const closed = await both((node) => call(node, 'close'));
	const writers = statuses.map((s) => s.writer);
	const result = summarize(mode, closed, writers);
	if (mode === 'keeper') {
		const cov = await coverage();
		result.nodes.forEach((n, i) => {
			const writes = writers.reduce((s, w) => s + (w.writesTo?.[n.node] ?? 0), 0);
			n.subscriber.coverage = { ...cov[i], writtenMoreThanOnce: writes - cov[i].distinctRowsWritten };
		});
	}
	return result;
}

async function main() {
	if (!PASS) throw new Error('BENCH_PASS is required');
	const out = { config: { WRITES, ROUNDS, JOIN_KICK, JOIN_TOMBSTONE } };
	out.hello = await both(waitReady);
	log('hello', JSON.stringify(out.hello));

	out.seed = await both((node) => call(node, 'seed'));
	log('seed', JSON.stringify(out.seed));
	out.rebuild = await both((node) => call(node, 'rebuild'));
	log('rebuild', JSON.stringify(out.rebuild));
	// idle baseline: what a window costs with no writes and no subscription
	await both((node) => call(node, 'open', { mode: 'none' }));
	await sleep(10_000);
	out.idle = (await both((node) => call(node, 'close'))).map((c, i) => ({
		node: NODES[i].name,
		processCpuMsPerSec: round((c.processCpuMs * 1000) / c.wallMs, 1),
		worker0BusyMsPerSec: round((c.worker0BusyMs * 1000) / c.wallMs, 1),
	}));
	log('idle', JSON.stringify(out.idle));
	if (JOIN_TOMBSTONE) out.tombstones = await both((node) => call(node, 'tombstone'));
	out.countsBeforeJoin = await both(async (node) => {
		const d = await op(node, { operation: 'describe_table', database: 'bench_sched', table: 'Sched' });
		return d.record_count;
	});

	// 2. join: keepers live, then a base copy each way
	await both((node) => call(node, 'open', { mode: 'keeper', kick: JOIN_KICK !== 0 }));
	const t0 = Date.now();
	await op(NODES[1], {
		operation: 'add_node',
		hostname: NODES[0].name,
		url: `wss://${NODES[0].name}:9933`,
		rejectUnauthorized: false,
		authorization: { username: USER, password: PASS },
	});
	const watched = await watchJoin(t0);
	const joinClosed = await both((node) => call(node, 'close'));
	out.join = {
		kick: JOIN_KICK !== 0,
		tombstone: JOIN_TOMBSTONE !== 0,
		...watched,
		...summarize('join', joinClosed, [IDLE_WRITER, IDLE_WRITER]),
	};
	out.join.verify = await both((node) => call(node, 'verify'));
	// which thread holds the bench_sched replication socket, beside worker 0's threadId from hello
	out.replicationThreads = await both(async (node) => {
		const status = await op(node, { operation: 'cluster_status' });
		const sockets = (status.connections ?? []).flatMap((c) => c.database_sockets ?? []);
		return sockets.filter((s) => s.database === 'bench_sched').map((s) => s.threadId);
	});
	out.countsAfterJoin = await both(async (node) => {
		const d = await op(node, { operation: 'describe_table', database: 'bench_sched', table: 'Sched' });
		return d.record_count;
	});
	log('join', JSON.stringify(out.join));

	// 3. interleaved arms
	out.arms = [];
	const modes = ['none', 'keeper'];
	for (let r = 0; r < ROUNDS; r++) {
		for (let a = 0; a < modes.length; a++) {
			const result = await arm(modes[(a + r) % modes.length]);
			result.round = r + 1;
			log('arm', JSON.stringify(result));
			out.arms.push(result);
		}
	}

	// 4. verify: a keeper rebuilt now and kept by one more arm must equal its own table, row for row
	await both((node) => call(node, 'rebuild'));
	const final = await arm('keeper');
	final.round = 'verify';
	out.arms.push(final);
	log('arm', JSON.stringify(final));
	out.verify = await both((node) => call(node, 'verify'));
	log('verify', JSON.stringify(out.verify));
	const totalRows = out.verify.reduce((s, v) => s + v.tableRows, 0);
	out.verifyCluster = {
		keyspace: out.hello[0].keyspace,
		rowsAcrossNodes: totalRows,
		allRowsPresent: totalRows === out.hello[0].keyspace,
		everyRowOnItsOwner: out.verify.every((v) => v.notOwned === 0),
		keepersExact: out.verify.every((v) => v.missing === 0 && v.mismatched === 0 && v.extra === 0),
	};
	log('verifyCluster', JSON.stringify(out.verifyCluster));

	await both((node) => call(node, 'stop'));
	log('RESULT ' + JSON.stringify(out));
	if (process.env.BENCH_OUT) writeFileSync(process.env.BENCH_OUT, JSON.stringify(out, null, 2));
}

main().catch((e) => {
	console.error('[driver] failed', e);
	process.exitCode = 1;
});
