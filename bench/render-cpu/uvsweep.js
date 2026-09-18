/**
 * `UV_THREADPOOL_SIZE` sweep — the one lever that cannot be measured inside a single process.
 *
 * libuv sizes its threadpool once, at the first threadpool submission, from the environment. So a
 * sweep has to be one CHILD PROCESS per setting, and the interleaving that keeps thermal drift off
 * a single variant has to happen at the process level: rep 1 of every setting, then rep 2.
 *
 * WHY IT MIGHT MATTER. Every resource-cache hit is an `fs.readFile` on that pool, and it happens
 * while the request is PAUSED in Chrome — dead time inside a render, N renders deep. With the pool
 * at its default 4 and a concurrency of 16, twelve paused requests can be queued behind four reads.
 *
 * The cache must be WARM and SHARED across the children for the read path to be the thing under
 * test, which is why the fixture is pinned to a fixed port (the cache key is the URL).
 *
 *   node bench/render-cpu/uvsweep.js --concurrency 8,16 --reps 3 --sizes 4,16,32
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { median } from './instrument.js';

const args = process.argv.slice(2);
const flag = (n, d) => {
	const i = args.indexOf(`--${n}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const LEVELS = flag('concurrency', '8,16').split(',').map(Number);
const SIZES = flag('sizes', '4,16,32').split(',').map(Number);
const REPS = Number(flag('reps', 3));
const VARIANT = flag('variant', 'resource-cache-on');
const PORT = Number(flag('port', 58123));
const CACHE = '/tmp/prerender-bench-uvcache';
const OUT = '/tmp/claude-502/uv';

rmSync(CACHE, { recursive: true, force: true });
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const rows = [];
for (let rep = 0; rep < REPS; rep++) {
	for (const concurrency of LEVELS) {
		for (const size of SIZES) {
			const json = `${OUT}/uv${size}-c${concurrency}-r${rep}.json`;
			const res = spawnSync(
				process.execPath,
				[
					new URL('./load.js', import.meta.url).pathname,
					'--concurrency',
					String(concurrency),
					'--reps',
					'1',
					'--warmups',
					'1',
					'--port',
					String(PORT),
					'--only',
					VARIANT,
					'--label',
					`uv${size}`,
					'--json',
					json,
				],
				{
					cwd: new URL('../../', import.meta.url).pathname,
					env: { ...process.env, UV_THREADPOOL_SIZE: String(size), BENCH_CACHE_DIR: CACHE },
					encoding: 'utf8',
				}
			);
			if (res.status !== 0) {
				console.error(res.stdout?.slice(-2000), res.stderr?.slice(-2000));
				throw new Error(`child failed (uv=${size} c=${concurrency})`);
			}
			const parsed = JSON.parse(readFileSync(json, 'utf8')).results[0];
			rows.push({ rep, concurrency, size, ...parsed });
			console.log(
				`rep${rep + 1} c=${String(concurrency).padStart(2)} UV=${String(size).padStart(2)}  ` +
					`batch ${String(parsed.batchMs).padStart(6)}ms  per-render ${String(parsed.perRenderWall).padStart(6)}ms  ` +
					`cpu/r ${String(parsed.cpuMsPerRender).padStart(5)}ms  ${String(parsed.rendersPerSec).padStart(5)}/s  ` +
					`req/r ${parsed.requestsPerRender}`
			);
		}
	}
	console.log('');
}

console.log('\n## UV_THREADPOOL_SIZE (median of reps)\n');
const head = ['conc', 'UV', 'batch', 'per-render', 'cpu/render', 'renders/s', 'vs UV=4', 'req/r', 'rssMb', 'reps'];
const out = [];
for (const concurrency of LEVELS) {
	for (const size of SIZES) {
		const list = rows.filter((r) => r.concurrency === concurrency && r.size === size);
		out.push({
			concurrency,
			size,
			batchMs: median(list.map((r) => r.batchMs)),
			perRenderWall: median(list.map((r) => r.perRenderWall)),
			cpuMsPerRender: median(list.map((r) => r.cpuMsPerRender)),
			requestsPerRender: median(list.map((r) => r.requestsPerRender)),
			rssMb: median(list.map((r) => r.rssMb)),
			reps: list.length,
			all: list.map((r) => r.batchMs),
		});
	}
}
const cells = out.map((r) => {
	const base = out.find((x) => x.concurrency === r.concurrency && x.size === SIZES[0]);
	const rps = (r.concurrency / (r.batchMs / 1000)).toFixed(2);
	const baseRps = base.concurrency / (base.batchMs / 1000);
	return [
		String(r.concurrency),
		String(r.size),
		`${r.batchMs}ms`,
		`${r.perRenderWall}ms`,
		`${r.cpuMsPerRender}ms`,
		rps,
		`${(Number(rps) / baseRps).toFixed(2)}x`,
		String(r.requestsPerRender),
		String(r.rssMb),
		String(r.reps),
	];
});
const widths = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
const line = (c) => c.map((x, i) => x.padEnd(widths[i])).join('  ');
console.log(line(head));
console.log(widths.map((w) => '-'.repeat(w)).join('  '));
for (const c of cells) console.log(line(c));
console.log('\nspread (batch ms per rep):');
for (const r of out) console.log(`  c=${r.concurrency} UV=${r.size}  ${JSON.stringify(r.all)}`);
