/**
 * PROCESS SHAPE — one worker with N slots, or N workers with fewer slots each?
 *
 * The deployed fleet forks several worker PROCESSES with a handful of render slots each, precisely
 * so that no single event loop drives every concurrent render. A single-process concurrency ladder
 * cannot tell you whether that shape is buying anything: it only ever measures the 1 x N corner.
 *
 * This runner puts the two corners side by side at EQUAL TOTAL SLOTS. Each shape gets the same
 * external fixture (its own process — see fixture-server.js) and the same total number of renders in
 * flight; the only difference is how many Node event loops and how many Chrome browsers they are
 * spread across.
 *
 * Throughput is summed per child over that child's own measured batches, so a child that starts a
 * few hundred ms late is not charged for the gap — the children overlap for the whole of the
 * measured window, which is where the contention this is about actually happens.
 *
 *   node bench/render-cpu/fleet.js --shapes 1x12,2x6,3x4,4x3 --reps 3
 */
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { median } from './instrument.js';

const args = process.argv.slice(2);
const flag = (n, d) => {
	const i = args.indexOf(`--${n}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const SHAPES = flag('shapes', '1x12,3x4')
	.split(',')
	.map((s) => {
		const [procs, slots] = s.split('x').map(Number);
		return { procs, slots, name: s };
	});
const REPS = Number(flag('reps', 3));
const VARIANT = flag('variant', 'baseline');
const FIXTURE = flag('fixture', 'http://127.0.0.1:58200/product/prd-bench');
const BATCHES = Number(flag('batches', 2));
const OUT = '/tmp/claude-502/fleet';

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const runChild = (shape, child, rep) =>
	new Promise((resolve, reject) => {
		const json = `${OUT}/${shape.name}-c${child}-r${rep}.json`;
		const proc = spawn(
			process.execPath,
			[
				new URL('./load.js', import.meta.url).pathname,
				'--concurrency',
				String(shape.slots),
				'--reps',
				'1',
				'--warmups',
				'1',
				'--batches',
				String(BATCHES),
				'--fixture',
				FIXTURE,
				'--only',
				VARIANT,
				'--label',
				`${shape.name}-child${child}`,
				'--json',
				json,
			],
			{ cwd: new URL('../../', import.meta.url).pathname, stdio: ['ignore', 'ignore', 'pipe'] }
		);
		let err = '';
		proc.stderr.on('data', (d) => (err += d));
		proc.on('exit', (code) =>
			code === 0
				? resolve(JSON.parse(readFileSync(json, 'utf8')).results[0])
				: reject(new Error(`child ${code}: ${err.slice(-1500)}`))
		);
	});

const rows = [];
for (let rep = 0; rep < REPS; rep++) {
	for (const shape of SHAPES) {
		const children = await Promise.all(Array.from({ length: shape.procs }, (_, c) => runChild(shape, c, rep)));
		// Per child: its own renders over its own measured wall. Summed, that is fleet throughput at
		// this shape — and it is not inflated by children that did not overlap, because each child's
		// denominator is only its own busy time.
		const perChild = children.map((c) => {
			const busyMs = c.windows.reduce((a, [s, e]) => a + (e - s), 0);
			return { renders: shape.slots * c.batchCount, busyMs, rps: (shape.slots * c.batchCount) / (busyMs / 1000) };
		});
		const totalRps = perChild.reduce((a, c) => a + c.rps, 0);
		const row = {
			rep,
			shape: shape.name,
			totalSlots: shape.procs * shape.slots,
			rendersPerSec: Number(totalRps.toFixed(2)),
			perRenderWall: median(children.map((c) => c.perRenderWall)),
			maxWall: Math.max(...children.map((c) => c.maxWall)),
			cpuMsPerRender: median(children.map((c) => c.cpuMsPerRender)),
			nodeCpuMsPerRender: median(children.map((c) => c.nodeCpuMsPerRender)),
			nodeBusyPct: Math.max(...children.map((c) => c.nodeBusyPct)),
			loopP99Ms: Math.max(...children.map((c) => c.loopP99Ms)),
			rssMb: children.reduce((a, c) => a + c.rssMb, 0),
			processes: children.reduce((a, c) => a + c.processes, 0),
			reviews: median(children.map((c) => c.reviews)),
		};
		rows.push(row);
		console.log(
			`rep${rep + 1} ${shape.name.padEnd(6)} (${row.totalSlots} slots)  ${String(row.rendersPerSec).padStart(5)}/s  ` +
				`per-render ${String(row.perRenderWall).padStart(6)}ms  cpu/r ${String(row.cpuMsPerRender).padStart(5)}ms  ` +
				`node/r ${String(row.nodeCpuMsPerRender).padStart(4)}ms  node% ${String(row.nodeBusyPct).padStart(3)}  ` +
				`loop-p99 ${String(row.loopP99Ms).padStart(6)}ms  rss ${String(row.rssMb).padStart(5)}MB  rv ${row.reviews}`
		);
	}
	console.log('');
}

console.log('\n## process shape at equal total slots (median of reps)\n');
const head = [
	'shape',
	'slots',
	'renders/s',
	'vs first',
	'per-render',
	'max-wall',
	'cpu/render',
	'node/render',
	'node% max',
	'loop-p99',
	'rssMb',
	'procs',
	'reviews',
];
const out = SHAPES.map((shape) => {
	const list = rows.filter((r) => r.shape === shape.name);
	const pick = (fn) => median(list.map(fn));
	return {
		shape: shape.name,
		totalSlots: shape.procs * shape.slots,
		rendersPerSec: pick((r) => Math.round(r.rendersPerSec * 100)) / 100,
		perRenderWall: pick((r) => r.perRenderWall),
		maxWall: pick((r) => r.maxWall),
		cpuMsPerRender: pick((r) => r.cpuMsPerRender),
		nodeCpuMsPerRender: pick((r) => r.nodeCpuMsPerRender),
		nodeBusyPct: pick((r) => r.nodeBusyPct),
		loopP99Ms: pick((r) => r.loopP99Ms),
		rssMb: pick((r) => r.rssMb),
		processes: pick((r) => r.processes),
		reviews: pick((r) => r.reviews),
		all: list.map((r) => r.rendersPerSec),
	};
});
const cells = out.map((r) => [
	r.shape,
	String(r.totalSlots),
	String(r.rendersPerSec),
	`${(r.rendersPerSec / out[0].rendersPerSec).toFixed(2)}x`,
	`${r.perRenderWall}ms`,
	`${r.maxWall}ms`,
	`${r.cpuMsPerRender}ms`,
	`${r.nodeCpuMsPerRender}ms`,
	`${r.nodeBusyPct}%`,
	`${r.loopP99Ms}ms`,
	String(r.rssMb),
	String(r.processes),
	String(r.reviews),
]);
const widths = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
const line = (c) => c.map((x, i) => x.padEnd(widths[i])).join('  ');
console.log(line(head));
console.log(widths.map((w) => '-'.repeat(w)).join('  '));
for (const c of cells) console.log(line(c));
console.log('\nspread (renders/s per rep):');
for (const r of out) console.log(`  ${r.shape}  ${JSON.stringify(r.all)}`);
