/**
 * WHAT THE RENDER QUEUE'S STORAGE ACTUALLY COSTS.
 *
 * Every scheduling decision in this package is justified by a number, and the numbers that matter
 * most were produced by throwaway scripts that are not in the repository — prerender-plugin#80 cites
 * `20-lanesim.mjs` and `21-duerank.mjs`, neither of which exists here. So the two figures the queue
 * design rests on cannot be reproduced, and they disagree with each other by 80x:
 *
 *   `util/renderSchedule.js`  — the claim scan returns 20 keys in 0.43 ms, i.e. ~21 us/row.
 *   `util/backlogSnapshot.js` — "Measured cost to calibrate against: ~3.5s per 2,000 rows",
 *                               i.e. ~1.75 ms/row.
 *
 * Both are in the tree today, both describe a one-sided ascending range read over the same index on
 * the same table, and which one is right decides the architecture. At 21 us/row you can afford to
 * stream the whole due set through a bounded heap once a minute and order it exactly. At 1.75 ms/row
 * a 500k-row due set takes 15 minutes to walk and any design that reads it is dead on arrival.
 *
 * The likely explanation is that they measure different things — `backlogSnapshot` yields to the
 * event loop every 200 rows BESIDE BOT TRAFFIC and seeks the absolute index minimum, while the claim
 * scan seeks a floor and never yields — but "likely" is not a basis for a schema change. So this
 * harness measures both, separately, with the yielding as an explicit variable.
 *
 * ── WHAT IT ANSWERS, IN THE ORDER THE DESIGN NEEDS IT ───────────────────────────────────────────
 *
 *   Q1  Per-row cost of the claim-shaped read (one-sided, ascending, projected) at limits from 20 to
 *       20,000. Decides whether ANY "buffer everything due now" design is viable.
 *   Q2  How much of Q1 is the yielding, not the storage engine. Isolates the 80x.
 *   Q3  K small per-lane seeks vs one large seek for the same number of granted rows — the cost of
 *       the interleaved-lane design in #116.
 *   Q4  `put` (whole record) vs a single-attribute update, on the reschedule path. Decides whether a
 *       lane change is cheap and whether splitting the column changes write cost.
 *   Q5  One indexed attribute vs two, on the write path. Tests #80's claim that a second index
 *       roughly doubles the hot write — which is the entire argument against a per-lane table.
 *   Q6  Two-sided range vs one-sided, with a limit that can fill and a limit that cannot. Tests the
 *       1,128-2,977 ms figure in `claimSchedules` that keeps the `<= now` half in application code.
 *   Q7  Whether the seek point degrades as rows churn away from it (the 0.36 -> 6.25 ms finding that
 *       the claim floor exists to fix), and whether a floored seek is immune.
 *
 * ── HOW TO RUN IT ──────────────────────────────────────────────────────────────────────────────
 *
 *   ROWS=200000 harper run bench/queue-index
 *
 * Against an ISOLATED Harper root, on its own ports — never a root that another instance is using,
 * and never one holding real data. It writes hundreds of thousands of rows and drops its databases
 * on the way in. `bench/queue-index/run.sh` sets that up.
 *
 * ROWS defaults to 200,000, matching #80 so the numbers are comparable. The production corpus is
 * 1,619,000 keys (814,200 targets x 2 device types); per-row costs are what transfer, not totals.
 */

const ROWS = Math.max(1_000, Number(process.env.ROWS) || 200_000);
const REPEATS = Math.max(1, Number(process.env.REPEATS) || 5);
const MINUTE = 60_000;

// Realistic key shape and length: the index stores these, so a short synthetic key would understate
// every read. Mirrors the production cache key (`url|deviceType`) on the route that dominates the
// corpus.
const keyFor = (i) => `https://www.kohls.com/product/prd-${i}/some-reasonably-long-product-slug|desktop`;

// The lane encoding under test — 2^42 ms per lane, lane 0 identity. Kept local so this harness has
// no dependency on the branch that introduces it.
const LANE_STRIDE = 2 ** 42;

const now = Date.now();
// Due times spread over a 24h window ending now, so most rows are overdue and the shape matches a
// node that is behind — the state ordering actually matters in.
const dueFor = (i) => now - Math.floor((i / ROWS) * 24 * 60) * MINUTE;

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];

/** Run `fn` REPEATS times and report min/median — min is the least noisy comparison. */
const time = async (label, fn) => {
	const samples = [];
	let result;
	for (let r = 0; r < REPEATS; r++) {
		const started = performance.now();
		result = await fn();
		samples.push(performance.now() - started);
	}
	samples.sort((a, b) => a - b);
	return { label, minMs: samples[0], medianMs: pct(samples, 0.5), rows: result ?? null };
};

const drain = async (iterable) => {
	let n = 0;
	let last = -Infinity;
	let outOfOrder = 0;
	for await (const row of iterable) {
		// ASSERTED, not assumed. A read that silently stops being index-ordered would make every
		// number here meaningless while still looking fast — the exact failure the query-shape comment
		// in `claimSchedules` warns about.
		const v = Number(row.queueKey ?? row.nextRenderTime);
		if (v < last) outOfOrder++;
		last = v;
		n++;
	}
	return { n, outOfOrder };
};

/** The same drain, yielding to the event loop every `every` rows — backlogSnapshot's shape. */
const drainYielding = async (iterable, every = 200) => {
	let n = 0;
	for await (const _row of iterable) {
		if (++n % every === 0) await new Promise((resolve) => setImmediate(resolve));
	}
	return { n, outOfOrder: 0 };
};

const oneSided = (table, from, limit, attr = 'nextRenderTime') =>
	table.search(
		{
			conditions: [{ attribute: attr, comparator: 'greater_than_equal', value: from }],
			sort: { attribute: attr },
			select: ['cacheKey', attr, 'fromSitemap'],
			limit,
		},
		{ replicateFrom: false }
	);

const twoSided = (table, from, to, limit, attr = 'nextRenderTime') =>
	table.search(
		{
			conditions: [
				{ attribute: attr, comparator: 'greater_than_equal', value: from },
				{ attribute: attr, comparator: 'less_than_equal', value: to },
			],
			sort: { attribute: attr },
			select: ['cacheKey', attr, 'fromSitemap'],
			limit,
		},
		{ replicateFrom: false }
	);

const seed = async (table, shape) => {
	const started = performance.now();
	for (let i = 0; i < ROWS; i++) {
		const dueAt = dueFor(i);
		if (shape === 'A') {
			await table.put(keyFor(i), { nextRenderTime: dueAt, fromSitemap: i % 2 === 0 });
		} else {
			// Lanes spread across the corpus the way the taxonomy would: a small fast band, a large
			// slow one, and a discovered tail. The distribution matters for the per-lane seek test.
			const lane = i % 100 === 0 ? 1 : i % 3 === 0 ? 2 : 4;
			await table.put(keyFor(i), {
				queueKey: lane * LANE_STRIDE + dueAt,
				dueAt,
				fromSitemap: i % 2 === 0,
			});
		}
		// Yield periodically or the seed monopolizes the loop and the storage engine never gets to
		// flush; this is the seed, not a measurement, so the yield cost is not being attributed to
		// anything.
		if (i % 2_000 === 0) await new Promise((resolve) => setImmediate(resolve));
	}
	return performance.now() - started;
};

// Runs on load. `jsResource` modules are imported after the schema is applied, so `databases.bench`
// is populated by the time this executes; the retry below exists only so a load-order change in
// Harper reports itself as a wait rather than as a TypeError on `databases.bench`.
const tablesReady = async () => {
	for (let i = 0; i < 50; i++) {
		if (databases?.bench?.BenchA) return true;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	return false;
};

async function main() {
	if (!(await tablesReady())) {
		console.error('[bench] databases.bench never appeared — the schema did not load');
		// SIGTERM, not `process.exit`: Harper intercepts exit, so this path would print and then hang as
		// a running server. Same reason as the success path at the end of `main`.
		process.kill(process.pid, 'SIGTERM');
		return;
	}
	const { BenchA, BenchB, BenchC } = databases.bench;
	const out = { rows: ROWS, repeats: REPEATS, harper: server?.version ?? 'unknown', phases: {} };
	const log = (...args) => console.log(...args);

	log(`[bench] seeding ${ROWS.toLocaleString()} rows x 3 shapes...`);

	// ---- Q5 / write cost: seeding IS the write benchmark ------------------------------------------
	const seedA = await seed(BenchA, 'A');
	const seedB = await seed(BenchB, 'B');
	const seedC = await seed(BenchC, 'C');
	out.phases.write = {
		note:
			'Q5 — per-row put cost. A and B have ONE indexed attribute, C has two. If C is materially ' +
			'slower than B, a second index really does cost what #80 says and a per-lane table is expensive; ' +
			'if A and B match, splitting the deadline out of the queue key is free.',
		A_oneIndex_usPerRow: (seedA * 1000) / ROWS,
		B_oneIndex_split_usPerRow: (seedB * 1000) / ROWS,
		C_twoIndexes_usPerRow: (seedC * 1000) / ROWS,
	};
	log('[bench] write:', JSON.stringify(out.phases.write, null, 2));

	// ---- Q1 / Q2: the claim-shaped read, and how much of it is the yielding -----------------------
	const floor = now - 24 * 60 * MINUTE;
	const reads = [];
	for (const limit of [20, 200, 2_000, 20_000]) {
		const plain = await time(`oneSided limit=${limit}`, () => drain(oneSided(BenchA, floor, limit)));
		const yielded = await time(`oneSided limit=${limit} yielding/200`, () =>
			drainYielding(oneSided(BenchA, floor, limit))
		);
		reads.push({
			limit,
			rowsRead: plain.rows.n,
			outOfOrder: plain.rows.outOfOrder,
			plain_usPerRow: (plain.minMs * 1000) / Math.max(1, plain.rows.n),
			plain_totalMs: plain.minMs,
			yielding_usPerRow: (yielded.minMs * 1000) / Math.max(1, yielded.rows.n),
			yielding_totalMs: yielded.minMs,
		});
	}
	out.phases.read = {
		note:
			'Q1/Q2 — per-row cost of the claim-shaped read, plain vs yielding every 200 rows. The tree ' +
			'holds two figures for this that differ 80x (21us/row in renderSchedule.js, 1.75ms/row in ' +
			'backlogSnapshot.js). If the plain number is the small one and yielding explains the rest, then ' +
			'a background sweep of the due set is affordable and a ready-set design is on the table.',
		samples: reads,
	};
	log('[bench] read:', JSON.stringify(out.phases.read, null, 2));

	// ---- Q3: K per-lane seeks vs one large seek ---------------------------------------------------
	const lanes = [1, 2, 4];
	const perLane = await time('3 lane seeks, limit 20 each', async () => {
		let total = 0;
		for (const lane of lanes) {
			const from = lane * LANE_STRIDE + floor;
			total += (await drain(oneSided(BenchB, from, 20, 'queueKey'))).n;
		}
		return { n: total, outOfOrder: 0 };
	});
	const oneBig = await time('1 seek, limit 60', () => drain(oneSided(BenchB, floor, 60, 'queueKey')));
	out.phases.lanes = {
		note:
			'Q3 — the interleaved-lane design pays one seek per lane. #80 measured 0.29-0.32ms per lane ' +
			'and claimed interleaving is free; this is that claim against one seek for the same row count.',
		threeLaneSeeks_ms: perLane.minMs,
		oneSeekSameRows_ms: oneBig.minMs,
	};
	log('[bench] lanes:', JSON.stringify(out.phases.lanes, null, 2));

	// ---- Q6: two-sided range, and it has to be set up correctly to mean anything -----------------
	//
	// THE FIRST VERSION OF THIS TEST WAS WORTHLESS and it is worth saying why, because it looked like
	// a refutation. It used a window ABOVE every seeded row (`now+10min .. now+11min`), so there were
	// no rows above the lower bound at all — and the described failure mode is precisely
	// "O(rows above the lower bound)". It measured an empty seek and reported it as cheap.
	//
	// To exercise the post-filter the window must be LOW (so almost the whole table sits above the
	// lower bound) and NARROW (so the matching rows run out), with a limit LARGER than the number of
	// matches — then the engine keeps walking past the window hunting for matches that do not exist.
	// Due times here are minute-floored across 1,440 distinct minutes, so one minute holds about
	// ROWS/1440 rows; a limit well above that cannot fill.
	const oldest = dueFor(ROWS - 1);
	const perMinute = Math.ceil(ROWS / 1440);
	const cannotFillLimit = perMinute * 10;
	const narrowTwoSided = await time(`twoSided, low+narrow window, limit ${cannotFillLimit} cannot fill`, () =>
		drain(twoSided(BenchA, oldest, oldest + MINUTE, cannotFillLimit))
	);
	const sameOneSided = await time(`oneSided, same lower bound, limit ${cannotFillLimit}`, () =>
		drain(oneSided(BenchA, oldest, cannotFillLimit))
	);
	const fillable = await time('twoSided, wide window, limit fills', () => drain(twoSided(BenchA, floor, now, 20)));
	out.phases.twoSided = {
		note:
			'Q6 — `claimSchedules` keeps the `<= now` half in application code because a two-sided range ' +
			'measured 1,128-2,977ms when the limit cannot fill (only the first condition becomes the index ' +
			'range, the second is a post-filter, so the cost is O(rows above the lower bound)). The window ' +
			'must be low and narrow with an unfillable limit or the test does not touch that path.',
		rowsAboveLowerBound: ROWS,
		matchesInWindow: perMinute,
		limitThatCannotFill: cannotFillLimit,
		twoSided_cannotFill_ms: narrowTwoSided.minMs,
		twoSided_cannotFill_rowsReturned: narrowTwoSided.rows.n,
		oneSided_sameLowerBound_ms: sameOneSided.minMs,
		oneSided_rowsReturned: sameOneSided.rows.n,
		twoSided_fillable_ms: fillable.minMs,
	};
	log('[bench] twoSided:', JSON.stringify(out.phases.twoSided, null, 2));

	// ---- Q4 / Q7: reschedule churn, and whether the seek point degrades --------------------------
	// The reschedule pattern: read the head, move those rows into the future, repeat. This is what
	// leaves dead index entries AT the seek point, and it is the measurement the claim floor exists
	// to answer (0.36 -> 6.25ms over 40,000 reschedules, permanent).
	// PRODUCTION-SHAPED CHURN, which the first version of this was not. It patched keys 0..N in key
	// order; production repeatedly CLAIMS THE HEAD of the index and writes those rows into the future,
	// so the dead entries accumulate at the seek point rather than being spread over a key range. The
	// difference matters exactly for the effect being measured, so this reads the head, moves what it
	// read, and repeats — and samples the seek cost as it goes, so a trend is visible rather than only
	// a before/after pair that one cold page can dominate.
	//
	// The floored seek is also fixed. Pinning it at `now - 60min` put it in the region the churn had
	// just rewritten, which is why it measured SLOWER than the unfloored seek; production's floor
	// tracks the oldest row still due, so that is what is tracked here.
	const churn = Math.min(ROWS, Number(process.env.CHURN) || 40_000);
	const batch = 20;
	const trend = [];
	let moved = 0;
	let churnMs = 0;
	let floorValue = 0;

	const sampleSeek = async () => ({
		unfloored: (await time('unfloored', () => drain(oneSided(BenchA, 0, batch)))).minMs,
		floored: (await time('floored', () => drain(oneSided(BenchA, floorValue, batch)))).minMs,
	});
	trend.push({ reschedules: 0, ...(await sampleSeek()) });

	while (moved < churn) {
		// Read the head the way `claim` does...
		const head = [];
		for await (const row of oneSided(BenchA, floorValue, batch)) head.push(row);
		if (head.length === 0) break;
		// ...and let the floor follow the first row observed, which is the production rule.
		floorValue = Number(head[0].nextRenderTime);

		const started = performance.now();
		for (const row of head) {
			// Whole-record put, matching `processJobResult`: one write per completed render, moving the
			// row a full interval into the future.
			await BenchA.put(row.cacheKey, {
				nextRenderTime: now + 24 * 60 * MINUTE + moved * MINUTE,
				fromSitemap: row.fromSitemap,
			});
			moved++;
		}
		churnMs += performance.now() - started;
		if (moved % 2_000 < batch) {
			await new Promise((resolve) => setImmediate(resolve));
			trend.push({ reschedules: moved, ...(await sampleSeek()) });
		}
	}
	trend.push({ reschedules: moved, ...(await sampleSeek()) });

	out.phases.churn = {
		note:
			'Q7 — does the seek point degrade as rows churn away from it (the 0.36 -> 6.25ms finding the ' +
			'claim floor exists to fix), and is a floored seek immune? Head-claim-then-reschedule, the ' +
			'production shape, sampling both seeks as it goes. Also Q4: per-row put on the reschedule path.',
		reschedules: moved,
		put_usPerRow: (churnMs * 1000) / Math.max(1, moved),
		trend,
	};
	log('[bench] churn:', JSON.stringify(out.phases.churn, null, 2));

	log('\n[bench] RESULT\n' + JSON.stringify(out, null, 2));
	// Harper INTERCEPTS `process.exit`, so a one-shot harness cannot end itself that way — it printed
	// its results and then sat there as a running server. Signal the process instead.
	console.log('[bench] done');
	process.kill(process.pid, 'SIGTERM');
}

main().catch((e) => {
	console.error('[bench] failed', e);
	// SIGTERM for the same reason: an intercepted `process.exit` leaves a failed run hanging, which
	// looks exactly like a slow one.
	process.kill(process.pid, 'SIGTERM');
});
