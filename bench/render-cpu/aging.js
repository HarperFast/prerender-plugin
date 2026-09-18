/**
 * `bench/render-cpu/aging.js` — DOES AN AGED BROWSER ACTUALLY GET SLOWER?
 *
 * The fleet retires a browser after `browserExpirationThreshold` (200) opened pages. The reason on
 * record is a general "prevent memory leaks" recommendation plus an operator impression that aged
 * browsers felt slower. Nobody has measured it — and it now decides a policy question, because
 * retiring every ~13 minutes is exactly what throws away the warm persistent profile behind the
 * V8-code-cache candidate. If aging is not real, retirement costs us that cache for nothing.
 *
 * ## Why this file is not a variant of load.js
 *
 * load.js measures a STEADY STATE: a browser per unit, warm up, take one batch, throw the browser
 * away. Aging is the opposite question — what a browser's 200th page costs relative to its 1st — so
 * the browser has to live for the whole run and every render has to be recorded in order.
 *
 * ## The confound this is built around: thermal drift looks exactly like aging
 *
 * A curve that takes eight minutes of continuous rendering to draw will drift with the laptop's
 * temperature, and a monotone slowdown over eight minutes is indistinguishable from "the browser got
 * slower" if the arm is run as one block. So the arms are INTERLEAVED at batch granularity against
 * SIMULTANEOUSLY LIVE browsers: all arms are launched up front, and one batch is taken from each in
 * round-robin. Every arm then sees the same thermal history, while each arm's own browser still sees
 * its pages strictly in order. Drift that is a property of time hits every arm; drift that is a
 * property of browser age does not.
 *
 * ## The arms
 *
 * - `fresh-incognito`  — today's production shape: a fresh incognito context per render. The control.
 * - `pooled-incognito` — one long-lived incognito context per slot, wiped between renders.
 * - `pooled-recycle`   — `pooled-incognito`, but its contexts are disposed and recreated halfway
 *                        through WITHOUT closing the browser. This is the attribution arm: if drift
 *                        exists and resets at the recycle point, the unit that ages is the CONTEXT
 *                        and the fix is to retire contexts; if it continues through, the unit is the
 *                        browser or the profile.
 * - `persist-default`  — the code-cache candidate: the default (non-incognito) context on a
 *                        persistent `--user-data-dir`, wiped between renders.
 *
 *   node bench/render-cpu/fixture-server.js --port 58200 &
 *   node bench/render-cpu/aging.js --batches 50 --concurrency 4
 *   node bench/render-cpu/aging.js --arms wipe-0,wipe-25,wipe-125 --batches 8   # the wipe's price
 */

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import ManagedBrowser from '../../packages/browser/dist/ManagedBrowser.js';
import RenderJob from '../../packages/browser/dist/RenderJob.js';
import defaultRenderer from '../../packages/browser/dist/renderer.js';
import { resolveSettings, settings, defaultLaunchOptions } from '../../packages/browser/dist/settings.js';
import { initResourceCache } from '../../packages/browser/dist/ResourceCache.js';
import { resetExperiments } from '../../packages/browser/dist/experiments.js';
import { resetForNextVariant } from '../../packages/browser/dist/variantContext.js';
import { BASE_CONFIG } from './variants.js';
import { median, processTreeCpu, readMetrics, pageMetrics } from './instrument.js';

const args = process.argv.slice(2);
const flag = (n, d) => {
	const i = args.indexOf(`--${n}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const DEVICE = flag('device', 'mobile');
const CONCURRENCY = Number(flag('concurrency', 4));
const BATCHES = Number(flag('batches', 50));
const FIXTURE = flag('fixture', 'http://127.0.0.1:58200/product/prd-bench');
const JSON_OUT = flag('json', '');
const ONLY = flag('arms', '').split(',').filter(Boolean);
const UDD_ROOT = flag('udd', '/tmp/prerender-bench-aging');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * An arm is a browser plus a context policy. `cookies` is the fixture's `?cookies=N`, which prices
 * the wipe: `resetForNextVariant` deletes the jar one `Network.deleteCookies` per cookie.
 */
const ARMS = [
	{ name: 'fresh-incognito', incognito: true, mode: 'fresh', udd: false, cookies: 0 },
	{ name: 'pooled-incognito', incognito: true, mode: 'pool', udd: false, cookies: 0 },
	// The attribution arm (item 4). It has to be a POOLED arm, because the default context is the one
	// context a browser cannot be made to let go of — so "dispose the context, keep the browser" is
	// only an experiment you can run on contexts you created.
	{ name: 'pooled-recycle', incognito: true, mode: 'pool', udd: false, cookies: 0, recycleAtBatch: 0.5 },
	{ name: 'persist-default', incognito: false, mode: 'shared', udd: true, cookies: 0 },
	// The wipe-cost sweep: same context policy, three jar sizes. Run with a small --batches, and at
	// --concurrency 1, because on a shared default context N concurrent wipes delete each other's
	// cookies and the timing stops being one wipe's cost.
	{ name: 'wipe-0', incognito: false, mode: 'shared', udd: true, cookies: 0 },
	{ name: 'wipe-25', incognito: false, mode: 'shared', udd: true, cookies: 25 },
	{ name: 'wipe-125', incognito: false, mode: 'shared', udd: true, cookies: 125 },
];

async function main() {
	const selected = ARMS.filter((a) => (ONLY.length ? ONLY.includes(a.name) : a.name.startsWith('wipe-') === false));
	console.log(`fixture: ${FIXTURE}`);
	console.log(
		`device: ${DEVICE}  concurrency: ${CONCURRENCY}  batches/arm: ${BATCHES}  renders/arm: ${BATCHES * CONCURRENCY}`
	);
	console.log(
		`arms (interleaved batch-by-batch against simultaneously live browsers): ${selected.map((a) => a.name).join(', ')}\n`
	);

	// Settings are process-global and the arms disagree about `incognitoPages`, so each arm re-resolves
	// them immediately before its own batch. Safe only because exactly one arm renders at a time —
	// which is also what makes the interleaving thermally fair.
	resetExperiments();

	for (const arm of selected) {
		if (arm.udd) {
			arm.uddPath = `${UDD_ROOT}-${arm.name}`;
			rmSync(arm.uddPath, { recursive: true, force: true });
		}
		applySettings(arm);
		await initResourceCache(settings.resourceCache);
		arm.browser = await ManagedBrowser.launch({
			maxActivePages: CONCURRENCY + 1,
			puppeteerLaunchOptions: {
				...defaultLaunchOptions(),
				...(arm.uddPath ? { userDataDir: arm.uddPath } : {}),
			},
		});
		arm.pool = arm.mode === 'pool' ? [] : null;
		// The default context is not something `createContext()` will hand back (it returns null when
		// `incognitoPages` is off), and without a handle to it `resetForNextVariant` never runs — which
		// would quietly measure the persistent-profile arm WITHOUT the wipe that makes it shippable.
		arm.sharedContext = arm.mode === 'shared' ? arm.browser.browser.defaultBrowserContext() : null;
		arm.renders = [];
		arm.batchRows = [];
		arm.url = arm.cookies ? `${FIXTURE}?cookies=${arm.cookies}` : FIXTURE;
		arm.recycleAt = arm.recycleAtBatch ? Math.floor(BATCHES * arm.recycleAtBatch) : null;
	}

	const started = Date.now();
	for (let batch = 0; batch < BATCHES; batch++) {
		for (const arm of selected) {
			if (arm.recycleAt === batch && arm.pool) {
				// Dispose the contexts, keep the browser. Item 4's attribution question.
				for (const context of arm.pool.splice(0)) await arm.browser.disposeContext(context).catch(() => {});
				console.log(`    [${arm.name}] contexts recycled before batch ${batch + 1} (browser kept)`);
			}
			await runBatch(arm, batch);
		}
		if (batch % 5 === 4 || batch === BATCHES - 1) {
			const line = selected
				.map((a) => {
					const r = a.batchRows[a.batchRows.length - 1];
					return `${a.name} ${String(r.perRenderWall).padStart(5)}ms/${String(r.cpuMsPerRender).padStart(4)}cpu/${String(r.rssMb).padStart(4)}MB`;
				})
				.join('  |  ');
			console.log(
				`batch ${String(batch + 1).padStart(3)}/${BATCHES} (page ${String((batch + 1) * CONCURRENCY).padStart(4)}, ` +
					`${Math.round((Date.now() - started) / 1000)}s)  ${line}`
			);
		}
	}

	for (const arm of selected) {
		for (const context of arm.pool?.splice(0) ?? []) await arm.browser.disposeContext(context).catch(() => {});
		await arm.browser.close().catch(() => {});
	}

	report(selected);
	if (JSON_OUT) {
		const path = resolvePath(process.cwd(), JSON_OUT);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify(
				{
					device: DEVICE,
					concurrency: CONCURRENCY,
					batches: BATCHES,
					arms: selected.map((a) => ({
						name: a.name,
						cookies: a.cookies,
						recycleAt: a.recycleAt,
						renders: a.renders,
						batches: a.batchRows,
					})),
				},
				null,
				2
			)
		);
		console.log(`\nwrote ${path}`);
	}
}

function applySettings(arm) {
	resolveSettings(
		{
			config: BASE_CONFIG,
			resourceCache: { enabled: false },
			harper: {},
			incognitoPages: arm.incognito,
		},
		{ requireHarper: false }
	);
}

async function runBatch(arm, batch) {
	applySettings(arm);
	const before = await quiescedCpu(arm.browser.pid);
	const open = [];
	const startedAt = Date.now();
	const runs = await Promise.all(Array.from({ length: CONCURRENCY }, (_, slot) => renderOne(arm, batch, slot, open)));
	const batchMs = Date.now() - startedAt;
	const after = processTreeCpu(arm.browser.pid);

	const metrics = [];
	for (const page of open) {
		try {
			metrics.push(pageMetrics(await readMetrics(page)));
		} catch {
			// A page that will not answer Performance.getMetrics still counted for wall and CPU.
		}
	}
	for (const page of open) await arm.browser.closePage(page);

	const m = (fn) => median(metrics.map(fn)) ?? 0;
	for (let i = 0; i < runs.length; i++) {
		arm.renders.push({
			page: batch * CONCURRENCY + i + 1,
			batch: batch + 1,
			wallMs: runs[i].wallMs,
			wipeMs: runs[i].wipeMs,
			jar: runs[i].jar,
			reviews: runs[i].reviews,
			bytes: runs[i].bytes,
			scriptMs: metrics[i]?.scriptMs ?? null,
			taskMs: metrics[i]?.taskMs ?? null,
			jsHeapMb: metrics[i]?.jsHeapMb ?? null,
		});
	}
	arm.batchRows.push({
		batch: batch + 1,
		pagesBefore: batch * CONCURRENCY,
		batchMs,
		perRenderWall: median(runs.map((r) => r.wallMs)),
		cpuMsPerRender: Math.round((((after?.cpuSeconds ?? 0) - (before?.cpuSeconds ?? 0)) * 1000) / CONCURRENCY),
		rssMb: after?.rssMb ?? null,
		processes: after?.processes ?? null,
		byType: after?.byType ?? null,
		scriptMs: m((x) => x.scriptMs),
		taskMs: m((x) => x.taskMs),
		jsHeapMb: m((x) => x.jsHeapMb),
		wipeMs: median(runs.map((r) => r.wipeMs)),
		jar: median(runs.map((r) => r.jar).filter((j) => j !== null)),
		totalOpenedPages: arm.browser.totalOpenedPages,
	});
}

async function renderOne(arm, batch, slot, keep) {
	const t0 = Date.now();
	let context = arm.pool ? (arm.pool.pop() ?? (await arm.browser.createContext())) : arm.sharedContext;
	let page = await arm.browser.getPage(context);
	let wipeMs = null;
	let jar = null;
	if (context) {
		// Jar size on a sample of renders only: `context.cookies()` is itself a CDP round trip, and
		// paying it on every render would put it inside the very number this is trying to price.
		if (batch % 5 === 0 && slot === 0) {
			try {
				jar = (await context.cookies()).length;
			} catch {
				/* a jar we cannot read is not a measurement we need */
			}
		}
		const w0 = Date.now();
		const wiped = await resetForNextVariant(context, page, arm.url, []);
		wipeMs = Date.now() - w0;
		if (!wiped && arm.pool) {
			// Fail closed, as production does — but only for contexts we own. The default context
			// cannot be replaced, so a failed wipe there is recorded and nothing else (it never
			// happened in any run; if it starts, the shared-context arm is the one to distrust).
			await arm.browser.closePage(page);
			await arm.browser.disposeContext(context).catch(() => {});
			context = null;
			page = await arm.browser.getPage(null);
		} else if (!wiped) {
			arm.wipeFailures = (arm.wipeFailures ?? 0) + 1;
		}
	}
	const job = new RenderJob({
		id: `aging-${arm.name}-${batch}-${slot}`,
		url: arm.url,
		expiresAt: Date.now() + 3600_000,
		deviceType: DEVICE,
		callbackOrigin: 'http://localhost',
		isFromSitemap: true,
	});
	job.attemptStarted();
	let html;
	try {
		html = await defaultRenderer(page, job);
	} finally {
		job.attemptEnded(undefined, html);
		keep.push(page);
		if (context && arm.pool) arm.pool.push(context);
	}
	return {
		wallMs: Date.now() - t0,
		wipeMs,
		jar,
		bytes: html?.length ?? 0,
		reviews: (html ?? '').split('rv-item').length - 1,
	};
}

/** See load.js: `after − before` is only a CPU measurement while the process set is not shrinking. */
async function quiescedCpu(pid) {
	let previous = processTreeCpu(pid);
	for (let i = 0; i < 20; i++) {
		await sleep(120);
		const next = processTreeCpu(pid);
		if (next && previous && next.processes === previous.processes) return next;
		previous = next;
	}
	return previous;
}

// ---------------------------------------------------------------------------- reporting

/** Least-squares slope of y against batch index, reported per 100 pages. */
function trendPer100Pages(rows, key, concurrency) {
	const points = rows.map((r, i) => [i * concurrency, r[key]]).filter(([, y]) => typeof y === 'number');
	if (points.length < 4) return null;
	const n = points.length;
	const mx = points.reduce((a, [x]) => a + x, 0) / n;
	const my = points.reduce((a, [, y]) => a + y, 0) / n;
	let num = 0;
	let den = 0;
	for (const [x, y] of points) {
		num += (x - mx) * (y - my);
		den += (x - mx) ** 2;
	}
	return den ? Number(((num / den) * 100).toFixed(1)) : null;
}

function report(arms) {
	const FIRST = 20;
	console.log('\n## aging: first 20 renders vs last 20 (medians), and the trend across the whole run\n');
	const head = [
		'arm',
		'pages',
		'wall 1st20',
		'wall last20',
		'Δ',
		'cpu 1st20',
		'cpu last20',
		'Δ',
		'script 1st',
		'script last',
		'rss 1st',
		'rss last',
		'wall /100pg',
		'cpu /100pg',
		'rss /100pg',
	];
	const rows = arms.map((arm) => {
		const r = arm.renders;
		const b = arm.batchRows;
		const firstR = r.slice(0, FIRST);
		const lastR = r.slice(-FIRST);
		const nb = Math.max(1, Math.round(FIRST / CONCURRENCY));
		const firstB = b.slice(0, nb);
		const lastB = b.slice(-nb);
		const w1 = median(firstR.map((x) => x.wallMs));
		const w2 = median(lastR.map((x) => x.wallMs));
		const c1 = median(firstB.map((x) => x.cpuMsPerRender));
		const c2 = median(lastB.map((x) => x.cpuMsPerRender));
		const s1 = median(firstR.map((x) => x.scriptMs));
		const s2 = median(lastR.map((x) => x.scriptMs));
		const m1 = median(firstB.map((x) => x.rssMb));
		const m2 = median(lastB.map((x) => x.rssMb));
		const pct = (a, z) => (a ? `${z >= a ? '+' : ''}${(((z - a) / a) * 100).toFixed(1)}%` : '-');
		return [
			arm.name,
			String(r.length),
			`${w1}ms`,
			`${w2}ms`,
			pct(w1, w2),
			`${c1}ms`,
			`${c2}ms`,
			pct(c1, c2),
			`${s1}ms`,
			`${s2}ms`,
			`${m1}`,
			`${m2}`,
			String(trendPer100Pages(b, 'perRenderWall', CONCURRENCY)),
			String(trendPer100Pages(b, 'cpuMsPerRender', CONCURRENCY)),
			String(trendPer100Pages(b, 'rssMb', CONCURRENCY)),
		];
	});
	printTable(head, rows);

	console.log('\n## the series — per-batch medians in decile bands (so a cliff cannot hide in a mean)\n');
	for (const arm of arms) {
		const bands = 10;
		const size = Math.ceil(arm.batchRows.length / bands);
		const cells = [];
		for (let i = 0; i < arm.batchRows.length; i += size) {
			const slice = arm.batchRows.slice(i, i + size);
			cells.push(
				`${String(i * CONCURRENCY + 1).padStart(3)}-${String(Math.min(arm.batchRows.length, i + size) * CONCURRENCY).padStart(3)}: ` +
					`${String(median(slice.map((x) => x.perRenderWall))).padStart(5)}ms ` +
					`${String(median(slice.map((x) => x.cpuMsPerRender))).padStart(4)}cpu ` +
					`${String(median(slice.map((x) => x.rssMb))).padStart(4)}MB`
			);
		}
		console.log(`${arm.name}${arm.recycleAt ? ` (contexts recycled at page ${arm.recycleAt * CONCURRENCY})` : ''}`);
		for (const c of cells) console.log(`  ${c}`);
		console.log('');
	}

	console.log('## batch-to-batch spread, so a first-vs-last delta can be read against it\n');
	for (const arm of arms) {
		const walls = arm.batchRows.map((x) => x.perRenderWall).sort((a, b) => a - b);
		const cpus = arm.batchRows.map((x) => x.cpuMsPerRender).sort((a, b) => a - b);
		const q = (list, p) => list[Math.min(list.length - 1, Math.floor(list.length * p))];
		console.log(
			`${arm.name.padEnd(18)} wall p10-p50-p90 ${q(walls, 0.1)}-${q(walls, 0.5)}-${q(walls, 0.9)}ms  ` +
				`cpu p10-p50-p90 ${q(cpus, 0.1)}-${q(cpus, 0.5)}-${q(cpus, 0.9)}ms  ` +
				`fidelity (reviews) ${median(arm.renders.map((r) => r.reviews))}` +
				(arm.wipeFailures ? `  WIPE-FAILURES ${arm.wipeFailures}` : '')
		);
	}

	const wiping = arms.filter((a) => a.renders.some((r) => r.wipeMs !== null));
	if (wiping.length) {
		console.log('\n## what the wipe costs (resetForNextVariant, pin=[])\n');
		const h = ['arm', 'jar', 'wipe p50', 'wipe p90', 'wipe max', 'render wall', 'wipe as % of render'];
		const rs = wiping.map((arm) => {
			const w = arm.renders
				.map((r) => r.wipeMs)
				.filter((x) => x !== null)
				.sort((a, b) => a - b);
			const q = (p) => w[Math.min(w.length - 1, Math.floor(w.length * p))];
			const wall = median(arm.renders.map((r) => r.wallMs));
			const jars = arm.renders.map((r) => r.jar).filter((j) => j !== null);
			return [
				arm.name,
				jars.length ? `${Math.min(...jars)}-${Math.max(...jars)}` : '?',
				`${q(0.5)}ms`,
				`${q(0.9)}ms`,
				`${w[w.length - 1]}ms`,
				`${wall}ms`,
				`${((q(0.5) / wall) * 100).toFixed(2)}%`,
			];
		});
		printTable(h, rs);
	}
}

function printTable(head, rows) {
	const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
	const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
	console.log(line(head));
	console.log(widths.map((w) => '-'.repeat(w)).join('  '));
	for (const row of rows) console.log(line(row));
}

await main();
