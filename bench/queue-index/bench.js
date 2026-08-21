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

export async function handleApplication() {
	const { BenchA, BenchB, BenchC } = databases.bench;
	const out = { rows: ROWS, repeats: REPEATS, harper: server?.version ?? 'unknown', phases: {} };
	const log = (...args) => console.log(...args);

	log(`[bench] seeding ${ROWS.toLocaleString()} rows x 3 shapes...`);

	// ---- Q5 / write cost: seeding IS the write benchmark ------------------------------------------
	const seedA = await seed(BenchA, 'A');
	const seedB = await seed(BenchB, 'B');
	const seedC = await seed(BenchC, 'C');
	out.phases.write = {
		note: 'Q5 — per-row put cost. A and B have ONE indexed attribute, C has two. If C is materially '
			+ 'slower than B, a second index really does cost what #80 says and a per-lane table is expensive; '
			+ 'if A and B match, splitting the deadline out of the queue key is free.',
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
		note: 'Q1/Q2 — per-row cost of the claim-shaped read, plain vs yielding every 200 rows. The tree '
			+ 'holds two figures for this that differ 80x (21us/row in renderSchedule.js, 1.75ms/row in '
			+ 'backlogSnapshot.js). If the plain number is the small one and yielding explains the rest, then '
			+ 'a background sweep of the due set is affordable and a ready-set design is on the table.',
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
		note: 'Q3 — the interleaved-lane design pays one seek per lane. #80 measured 0.29-0.32ms per lane '
			+ 'and claimed interleaving is free; this is that claim against one seek for the same row count.',
		threeLaneSeeks_ms: perLane.minMs,
		oneSeekSameRows_ms: oneBig.minMs,
	};
	log('[bench] lanes:', JSON.stringify(out.phases.lanes, null, 2));

	// ---- Q6: two-sided range, fillable and not ---------------------------------------------------
	const fillable = await time('twoSided, limit fills', () => drain(twoSided(BenchA, floor, now, 20)));
	// A window with almost nothing in it, so the limit can never fill — the "nothing is due" steady
	// state, which is where the 480x regression was measured.
	const empty = await time('twoSided, limit cannot fill', () =>
		drain(twoSided(BenchA, now + 10 * MINUTE, now + 11 * MINUTE, 20))
	);
	const emptyOneSided = await time('oneSided, same empty window', () =>
		drain(oneSided(BenchA, now + 10 * MINUTE, 20))
	);
	out.phases.twoSided = {
		note: 'Q6 — `claimSchedules` keeps the `<= now` half in application code because a two-sided range '
			+ 'measured 1,128-2,977ms when the limit cannot fill (only the first condition becomes the index '
			+ 'range; the second is a post-filter). This is that comparison.',
		fillable_ms: fillable.minMs,
		cannotFill_ms: empty.minMs,
		cannotFill_oneSided_ms: emptyOneSided.minMs,
	};
	log('[bench] twoSided:', JSON.stringify(out.phases.twoSided, null, 2));

	// ---- Q4 / Q7: reschedule churn, and whether the seek point degrades --------------------------
	// The reschedule pattern: read the head, move those rows into the future, repeat. This is what
	// leaves dead index entries AT the seek point, and it is the measurement the claim floor exists
    // to answer (0.36 -> 6.25ms over 40,000 reschedules, permanent).
	const churn = Math.min(ROWS, Number(process.env.CHURN) || 40_000);
	const headSeekBefore = await time('unfloored head seek, before churn', () =>
		drain(oneSided(BenchA, 0, 20))
	);
	let moved = 0;
	const churnStarted = performance.now();
	for (let i = 0; i < churn; i++) {
		// Single-attribute update, not a whole-record put: Q4. If this is materially cheaper than the
		// seed's per-row put, then an in-place lane change is cheap and the encoding is a good deal.
		await BenchA.patch(keyFor(i), { nextRenderTime: now + (i % (24 * 60)) * MINUTE });
		moved++;
		if (i % 2_000 === 0) await new Promise((resolve) => setImmediate(resolve));
	}
	const churnMs = performance.now() - churnStarted;
	const headSeekAfter = await time('unfloored head seek, after churn', () => drain(oneSided(BenchA, 0, 20)));
	const flooredSeekAfter = await time('FLOORED seek, after churn', () =>
		drain(oneSided(BenchA, now - 60 * MINUTE, 20))
	);
	out.phases.churn = {
		note: 'Q4/Q7 — per-row single-attribute patch cost (vs the whole-record put above), and whether the '
			+ 'seek point degrades as rows churn away from it. A floored seek should be immune; an unfloored '
			+ 'one should not.',
		reschedules: moved,
		patch_usPerRow: (churnMs * 1000) / Math.max(1, moved),
		unflooredSeekBefore_ms: headSeekBefore.minMs,
		unflooredSeekAfter_ms: headSeekAfter.minMs,
		flooredSeekAfter_ms: flooredSeekAfter.minMs,
	};
	log('[bench] churn:', JSON.stringify(out.phases.churn, null, 2));

	log('\n[bench] RESULT\n' + JSON.stringify(out, null, 2));
	// Exit rather than leave a server up: this is a one-shot measurement, and the numbers above are
	// only valid while nothing else is touching the tables.
	process.exit(0);
}
