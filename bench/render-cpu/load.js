/**
 * `bench/render-cpu/load.js` — the same variants, measured with the browser UNDER LOAD.
 *
 * WHY A SECOND RUNNER. [bench.js](bench.js) renders one page at a time on an idle machine, which is
 * the wrong frame for a render fleet: a worker runs `CONCURRENCY` renders at once, all day. On an
 * idle machine a change that only removes WAITING looks enormous (nothing else wanted the core) and
 * a change that only removes CPU looks like nothing (there was spare CPU). Under saturation the
 * ranking inverts: CPU is the shared resource, and a render that waits is not holding a core — it is
 * holding a SLOT and its memory.
 *
 * So both runners exist, and they answer different questions:
 *   bench.js  — latency of one render, and where its wall-clock goes.
 *   load.js   — renders/second and CPU-seconds/render at a given concurrency, which is what decides
 *               how much fleet a given traffic level needs.
 *
 * `renderOnce` is single-flight by contract (it mutates the process-global `settings`), so this
 * runner drives `defaultRenderer` directly: settings are resolved ONCE, then N renders run in
 * parallel against one browser, exactly as a worker does it.
 *
 * ## The unit of measurement, and why it is shaped like this
 *
 * One UNIT = (concurrency, variant, rep). A unit launches its own browser, runs `--warmups` batches
 * of `concurrency` renders and throws them away, runs ONE measured batch, then closes the browser.
 * Units are INTERLEAVED — rep 1 of every variant, then rep 2 of every variant — because a laptop
 * drifts thermally over a long sweep and a block layout hands the whole drift to whichever variant
 * ran last. Reported as medians over reps.
 *
 * A browser per unit rather than per variant is what makes the cache candidates honest: every
 * variant, cached or not, starts from a cold Chrome and gets exactly `--warmups` batches to warm
 * whatever it is able to warm. A variant that cannot warm anything simply does not benefit.
 *
 * Usage:
 *   node bench/render-cpu/load.js --concurrency 8 --reps 3
 *   node bench/render-cpu/load.js --concurrency 1,4,8,16 --only baseline,context-pool
 *   node bench/render-cpu/load.js --only context-pool --trace --batches 6   # warm-up curve
 */

import { monitorEventLoopDelay } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import ManagedBrowser from '../../packages/browser/dist/ManagedBrowser.js';
import RenderJob from '../../packages/browser/dist/RenderJob.js';
import defaultRenderer from '../../packages/browser/dist/renderer.js';
import { resolveSettings, settings, defaultLaunchOptions } from '../../packages/browser/dist/settings.js';
import { initResourceCache } from '../../packages/browser/dist/ResourceCache.js';
import { experiments, resetExperiments } from '../../packages/browser/dist/experiments.js';
import { resetForNextVariant } from '../../packages/browser/dist/variantContext.js';
import { startFixture } from './fixture.js';
import { VARIANTS, BASE_CONFIG, merge } from './variants.js';
import { median, processTreeCpu, readMetrics, pageMetrics } from './instrument.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);
const DEVICE = flag('device', 'mobile');
const REPS = Number(flag('reps', 3));
const WARMUPS = Number(flag('warmups', 2));
const BATCHES = Number(flag('batches', 1));
const TRACE = has('trace');
const LEVELS = flag('concurrency', '8').split(',').map(Number);
const ONLY = flag('only', '').split(',').filter(Boolean);
const JSON_OUT = flag('json', '');
const LABEL = flag('label', '');
// A FIXED fixture port matters whenever the on-disk resource cache has to stay warm across
// PROCESSES (the UV_THREADPOOL_SIZE sweep spawns one process per setting): the cache key is the
// URL, so an ephemeral port gives every process a cache that can only miss.
const PORT = Number(flag('port', 0));
// An EXTERNAL fixture (bench/render-cpu/fixture-server.js). Without it the HTTP origin shares this
// process's event loop with CDP traffic, every interception callback and the serialized documents —
// which at high concurrency is the thing being measured rather than the renderer. Production's
// origin is a different machine, so anything above ~c=8 should be run against an external fixture.
const FIXTURE_URL = flag('fixture', '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Take the "before" CPU sample only once the process tree has stopped shrinking.
 *
 * The delta `after - before` is only a CPU measurement while every process alive at `before` is
 * still alive at `after`. A batch that just closed its pages leaves renderer processes exiting
 * asynchronously; sampled too early they are counted in `before`, gone by `after`, and the variant
 * that tears down the most processes reports the LEAST CPU. Waiting for a stable process count
 * removes that, and it is the difference between baseline (a context per render, N teardowns per
 * batch) and the pooled variants (none) — i.e. exactly the comparison this file exists for.
 */
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

/**
 * A fixture running in another process, read over its `/__stats` endpoint. Same surface as
 * `startFixture` except that `requests` is refreshed by `sync()` rather than being live — every
 * caller below snapshots it around a batch anyway.
 */
async function attachFixture(url) {
	const origin = new URL(url).origin;
	const requests = new Map();
	const sync = async () => {
		const res = await fetch(`${origin}/__stats`);
		const json = await res.json();
		requests.clear();
		for (const [k, v] of Object.entries(json)) requests.set(k, v);
		return requests;
	};
	await sync();
	return { url, requests, sync, close: async () => {} };
}

/** Total requests the fixture has served, per path and overall. */
const requestTotals = (map) => {
	let total = 0;
	for (const n of map.values()) total += n;
	return total;
};
const requestSnapshot = (map) => Object.fromEntries(map);
const requestDelta = (before, after) => {
	const out = {};
	for (const [k, v] of Object.entries(after)) {
		const d = v - (before[k] ?? 0);
		if (d) out[k] = d;
	}
	return out;
};

async function main() {
	const selected = VARIANTS.filter((v) => (ONLY.length ? ONLY.includes(v.name) : true)).filter(
		(v) => !v.devices || v.devices.includes(DEVICE)
	);
	if (ONLY.length) {
		// Ordering follows the --only list, so the first name given is the baseline every ratio is
		// read against. Silently reordering it (VARIANTS order) has flipped a comparison before.
		selected.sort((a, b) => ONLY.indexOf(a.name) - ONLY.indexOf(b.name));
	}
	const fixture = FIXTURE_URL ? await attachFixture(FIXTURE_URL) : await startFixture({ port: PORT });
	console.log(
		`fixture: ${fixture.url}${FIXTURE_URL ? ' (external process)' : ' (IN-PROCESS — shares this event loop)'}`
	);
	console.log(
		`device: ${DEVICE}  reps: ${REPS}  warmups: ${WARMUPS}  batches/unit: ${BATCHES}  concurrency: ${LEVELS.join(',')}`
	);
	console.log(
		`uvThreadpool: ${process.env.UV_THREADPOOL_SIZE ?? '(unset → 4)'}  cores: ${(await import('node:os')).cpus().length}`
	);
	console.log(`variants: ${selected.map((v) => v.name).join(', ')}\n`);

	/** unit results keyed `${concurrency}|${variant}`, one entry per rep. */
	const units = new Map();

	for (let rep = 0; rep < REPS; rep++) {
		for (const concurrency of LEVELS) {
			for (const variant of selected) {
				const unit = await runUnit({ variant, concurrency, fixture, rep });
				const key = `${concurrency}|${variant.name}`;
				if (!units.has(key)) units.set(key, []);
				units.get(key).push(unit);
				console.log(
					`rep${rep + 1} c=${String(concurrency).padStart(2)} ${variant.name.padEnd(26)} ` +
						`batch ${String(unit.batchMs).padStart(6)}ms  per-render ${String(unit.perRenderWall).padStart(6)}ms  ` +
						`cpu/r ${String(unit.cpuMsPerRender).padStart(5)}ms  ${String(unit.rendersPerSec.toFixed(2)).padStart(5)}/s  ` +
						`v8c ${String(unit.v8CompileMs).padStart(4)}ms  script ${String(unit.scriptMs).padStart(4)}ms  ` +
						`req/r ${String(unit.requestsPerRender.toFixed(1)).padStart(5)}  node ${String(unit.nodeCpuMsPerRender).padStart(4)}ms/${String(unit.nodeBusyPct).padStart(3)}%  ` +
						`loop-p99 ${String(unit.loopP99Ms).padStart(6)}ms  rss ${String(unit.rssMb).padStart(5)}MB  ` +
						`rv ${unit.reviews}`
				);
			}
		}
		console.log('');
	}

	await fixture.close();

	const results = [...units.entries()].map(([key, list]) => {
		const [concurrency, name] = key.split('|');
		const pick = (fn) => median(list.map(fn));
		return {
			concurrency: Number(concurrency),
			variant: name,
			reps: list.length,
			batchMs: pick((u) => u.batchMs),
			perRenderWall: pick((u) => u.perRenderWall),
			maxWall: pick((u) => u.maxWall),
			cpuMsPerRender: pick((u) => u.cpuMsPerRender),
			rendersPerSec: Number((Number(concurrency) / (pick((u) => u.batchMs) / 1000)).toFixed(2)),
			v8CompileMs: pick((u) => u.v8CompileMs),
			scriptMs: pick((u) => u.scriptMs),
			taskMs: pick((u) => u.taskMs),
			devtoolsMs: pick((u) => u.devtoolsMs),
			requestsPerRender: Number((pick((u) => Math.round(u.requestsPerRender * 10)) / 10).toFixed(1)),
			jsRequestsPerRender: Number((pick((u) => Math.round(u.jsRequestsPerRender * 10)) / 10).toFixed(1)),
			nodeCpuMsPerRender: pick((u) => u.nodeCpuMsPerRender),
			nodeBusyPct: pick((u) => u.nodeBusyPct),
			loopMeanMs: pick((u) => u.loopMeanMs),
			loopP99Ms: pick((u) => u.loopP99Ms),
			rssMb: pick((u) => u.rssMb),
			processes: pick((u) => u.processes),
			reviews: pick((u) => u.reviews),
			bytes: pick((u) => u.bytes),
			poolResetFailures: list.reduce((a, u) => a + u.poolResetFailures, 0),
			cpuByType: list[list.length - 1].cpuByType,
			windows: list.flatMap((u) => u.windows),
			batchCount: list.reduce((a, u) => a + u.batchCount, 0),
			allCpu: list.map((u) => u.cpuMsPerRender),
			allBatch: list.map((u) => u.batchMs),
		};
	});

	report(results);
	if (JSON_OUT) {
		const path = resolvePath(process.cwd(), JSON_OUT);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify(
				{
					label: LABEL,
					device: DEVICE,
					reps: REPS,
					warmups: WARMUPS,
					levels: LEVELS,
					uv: process.env.UV_THREADPOOL_SIZE ?? null,
					results,
				},
				null,
				2
			)
		);
		console.log(`\nwrote ${path}`);
	}
}

/** One (concurrency, variant, rep): its own browser, its own warm-up, one measured batch. */
async function runUnit({ variant, concurrency, fixture, rep }) {
	// Settings are resolved per variant, ONCE, before any render — the reason this runner cannot use
	// renderOnce (which resolves them per call, mutating process state under any render already in
	// flight).
	resolveSettings(
		{
			config: merge(BASE_CONFIG, variant.config),
			// An AXIS, not a constant. Hard-disabling it here is what made every caching and compile-cost
			// candidate unmeasurable — including the "shared context" result that went into the README as
			// a dead end.
			resourceCache: variant.resourceCache ?? { enabled: false },
			harper: {},
			...(variant.browserOptions ?? {}),
		},
		{ requireHarper: false }
	);
	await initResourceCache(settings.resourceCache);
	resetExperiments();
	Object.assign(experiments, variant.experiments ?? {});

	const base = defaultLaunchOptions();
	const launchOptions = {
		...base,
		...(variant.launch?.chromeArgs ? { args: [...(base.args ?? []), ...variant.launch.chromeArgs] } : {}),
		// A persistent profile is the ONLY way Chrome's own disk cache (and the V8 code cache that
		// lives inside it) survives a browser restart. It does nothing for an incognito context,
		// whose cache is in-memory by construction — which is the point of measuring it.
		...(variant.launch?.userDataDir ? { userDataDir: variant.launch.userDataDir } : {}),
	};
	const managed = await ManagedBrowser.launch({
		maxActivePages: concurrency + 1,
		puppeteerLaunchOptions: launchOptions,
	});

	const url = variant.urlQuery ? `${fixture.url}?${variant.urlQuery}` : fixture.url;

	// SLOT-SCOPED CONTEXTS. Today every render gets a fresh incognito context, whose HTTP cache is
	// in-memory and dies with it — so Chrome never carries a compiled-script (V8 code) cache from one
	// render to the next, and the disk-cache flag has never applied to a single render. This leases a
	// long-lived context per slot and wipes it between renders with the SAME routine production
	// already uses between a job's device variants, which fails closed: if the wipe cannot be
	// guaranteed the render takes a fresh context instead.
	//
	// The pool lives for the whole UNIT (warm-ups included). Disposing it between batches — which is
	// what the first version of this file did — threw away the only thing the candidate is about.
	const pool = [];
	let poolResetFailures = 0;
	const acquireContext = async () => {
		if (!variant.contextPool) return null;
		return pool.pop() ?? (await managed.createContext());
	};

	// Renders the page and hands it back STILL OPEN: the caller closes it after sampling CPU.
	const renderOne = async (i, keep) => {
		const started = Date.now();
		let context = await acquireContext();
		let page = await managed.getPage(context);
		if (context && !variant.skipWipe) {
			const wiped = await resetForNextVariant(context, page, url, []);
			if (!wiped) {
				// Fail closed, exactly as production does: a context that cannot be proven clean is not
				// reused — it is DISPOSED, not returned to the pool, and the render takes a fresh one.
				// Counted so a silent fallback cannot flatter the result.
				poolResetFailures++;
				await managed.closePage(page);
				await managed.disposeContext(context).catch(() => {});
				context = null;
				page = await managed.getPage(null);
			}
		}
		const job = new RenderJob({
			id: `load-${i}`,
			url,
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
			if (keep) keep.push(page);
			else await managed.closePage(page);
			if (context) pool.push(context);
		}
		return {
			wallMs: Date.now() - started,
			bytes: html?.length ?? 0,
			reviews: (html ?? '').split('rv-item').length - 1,
		};
	};

	for (let w = 0; w < WARMUPS; w++) {
		const t0 = Date.now();
		const r0 = requestTotals(fixture.sync ? await fixture.sync() : fixture.requests);
		await Promise.all(Array.from({ length: concurrency }, (_, i) => renderOne(i)));
		if (TRACE) {
			console.log(
				`    [warm ${w + 1}] ${Date.now() - t0}ms  req ${((requestTotals(fixture.sync ? await fixture.sync() : fixture.requests) - r0) / concurrency).toFixed(1)}/render`
			);
		}
	}

	const batches = [];
	for (let b = 0; b < BATCHES; b++) {
		const before = await quiescedCpu(managed.pid);
		const reqBefore = requestSnapshot(fixture.sync ? await fixture.sync() : fixture.requests);
		// THE DRIVER IS A PROCESS TOO. Chrome's tree is not the whole cost of a render: this process
		// runs the request-interception handler for every sub-resource, every resource-cache read and
		// write, and receives the multi-megabyte serialized document at the end — all on ONE thread. If
		// throughput stops scaling while Chrome's CPU per render stays flat, this is where to look, and
		// `UV_THREADPOOL_SIZE` is a lever on exactly this thread's waiting.
		//
		// Loop delay is read as a DELTA of its own idle floor, not raw: monitorEventLoopDelay reports
		// absolute lateness, so an idle process already reads about its own resolution.
		const nodeCpuBefore = process.cpuUsage();
		const loop = monitorEventLoopDelay({ resolution: 10 });
		loop.enable();
		const open = [];
		const started = Date.now();
		const runs = await Promise.all(Array.from({ length: concurrency }, (_, i) => renderOne(i, open)));
		const batchMs = Date.now() - started;
		loop.disable();
		const nodeCpu = process.cpuUsage(nodeCpuBefore);
		const after = processTreeCpu(managed.pid);
		const reqAfter = requestSnapshot(fixture.sync ? await fixture.sync() : fixture.requests);
		// Sampled while every page is still OPEN — a closed page's renderer takes its CPU accounting
		// with it. This is also why the pages are kept and closed below rather than in renderOne.
		const metrics = [];
		for (const page of open) {
			try {
				const raw = await readMetrics(page);
				if (TRACE && !metrics.length) {
					console.log(
						`    [raw metrics] ${JSON.stringify(Object.fromEntries(Object.entries(raw).filter(([, v]) => v)))}`
					);
				}
				metrics.push(pageMetrics(raw));
			} catch {
				// A page that will not answer Performance.getMetrics still counted for wall and CPU.
			}
		}
		for (const page of open) await managed.closePage(page);

		const reqDelta = requestDelta(reqBefore, reqAfter);
		const reqTotal = Object.values(reqDelta).reduce((a, b) => a + b, 0);
		const jsTotal = Object.entries(reqDelta)
			.filter(([k]) => k.endsWith('.js'))
			.reduce((a, [, v]) => a + v, 0);
		const m = (fn) => median(metrics.map(fn)) ?? 0;
		batches.push({
			window: [started, started + batchMs],
			batchMs,
			cpuSeconds: (after?.cpuSeconds ?? 0) - (before?.cpuSeconds ?? 0),
			cpuByType: diffByType(before?.byType, after?.byType),
			processes: after?.processes ?? null,
			rssMb: after?.rssMb ?? null,
			perRenderWall: median(runs.map((r) => r.wallMs)),
			maxWall: Math.max(...runs.map((r) => r.wallMs)),
			reviews: median(runs.map((r) => r.reviews)),
			bytes: median(runs.map((r) => r.bytes)),
			v8CompileMs: m((x) => x.v8CompileMs),
			scriptMs: m((x) => x.scriptMs),
			taskMs: m((x) => x.taskMs),
			devtoolsMs: m((x) => x.devtoolsMs),
			requestsPerRender: reqTotal / concurrency,
			jsRequestsPerRender: jsTotal / concurrency,
			nodeCpuMs: Math.round((nodeCpu.user + nodeCpu.system) / 1000),
			nodeBusyPct: Math.round(((nodeCpu.user + nodeCpu.system) / 1000 / batchMs) * 100),
			loopMeanMs: Number((loop.mean / 1e6).toFixed(1)),
			loopP99Ms: Number((loop.percentile(99) / 1e6).toFixed(1)),
			reqDelta,
		});
		if (TRACE) {
			const last = batches[batches.length - 1];
			console.log(
				`    [batch ${b + 1}] ${last.batchMs}ms  cpu/r ${Math.round((last.cpuSeconds * 1000) / concurrency)}ms  ` +
					`v8c ${last.v8CompileMs}ms  script ${last.scriptMs}ms  req ${last.requestsPerRender.toFixed(1)}/render ` +
					`(js ${last.jsRequestsPerRender.toFixed(1)})  ${JSON.stringify(last.reqDelta)}`
			);
		}
	}

	for (const context of pool.splice(0)) await managed.disposeContext(context).catch(() => {});
	await managed.close().catch(() => {});

	const pick = (fn) => median(batches.map(fn));
	return {
		rep,
		windows: batches.map((b) => b.window),
		batchCount: batches.length,
		batchMs: pick((b) => b.batchMs),
		perRenderWall: pick((b) => b.perRenderWall),
		maxWall: pick((b) => b.maxWall),
		cpuMsPerRender: Math.round((pick((b) => Math.round(b.cpuSeconds * 1000)) ?? 0) / concurrency),
		cpuByType: perRenderByType(batches[batches.length - 1].cpuByType, concurrency),
		rendersPerSec: concurrency / (pick((b) => b.batchMs) / 1000),
		v8CompileMs: pick((b) => b.v8CompileMs),
		scriptMs: pick((b) => b.scriptMs),
		taskMs: pick((b) => b.taskMs),
		devtoolsMs: pick((b) => b.devtoolsMs),
		requestsPerRender: pick((b) => Math.round(b.requestsPerRender * 10)) / 10,
		jsRequestsPerRender: pick((b) => Math.round(b.jsRequestsPerRender * 10)) / 10,
		nodeCpuMsPerRender: Math.round((pick((b) => b.nodeCpuMs) ?? 0) / concurrency),
		nodeBusyPct: pick((b) => b.nodeBusyPct),
		loopMeanMs: pick((b) => b.loopMeanMs),
		loopP99Ms: pick((b) => b.loopP99Ms),
		rssMb: pick((b) => b.rssMb),
		processes: pick((b) => b.processes),
		reviews: pick((b) => b.reviews),
		bytes: pick((b) => b.bytes),
		poolResetFailures,
	};
}

/** CPU seconds per Chrome process type over a batch. Types that appeared mid-batch count from 0. */
function diffByType(before, after) {
	if (!after) return null;
	const out = {};
	for (const [type, stats] of Object.entries(after)) {
		const was = before?.[type]?.cpuSeconds ?? 0;
		out[type] = {
			cpuSeconds: Number((stats.cpuSeconds - was).toFixed(2)),
			rssMb: stats.rssMb,
			processes: stats.processes,
		};
	}
	return out;
}

function perRenderByType(byType, concurrency) {
	if (!byType) return null;
	return Object.fromEntries(
		Object.entries(byType)
			.sort((a, b) => b[1].cpuSeconds - a[1].cpuSeconds)
			.map(([k, v]) => [k, { cpuMs: Math.round((v.cpuSeconds * 1000) / concurrency), rssMb: v.rssMb, n: v.processes }])
	);
}

function report(results) {
	console.log('\n## throughput under load (median of reps)\n');
	const head = [
		'conc',
		'variant',
		'batch',
		'per-render',
		'max-wall',
		'cpu/render',
		'renders/s',
		'vs base /s',
		'vs base cpu',
		'v8compile',
		'script',
		'devtools',
		'req/r',
		'js/r',
		'node/r',
		'node%',
		'loop-p99',
		'procs',
		'rssMb',
		'reviews',
	];
	const firstVariant = results[0]?.variant;
	const rows = results.map((r) => {
		const base = results.find((x) => x.concurrency === r.concurrency && x.variant === firstVariant);
		const ratio = base && base.rendersPerSec ? `${(r.rendersPerSec / base.rendersPerSec).toFixed(2)}x` : '-';
		const cpuRatio = base && base.cpuMsPerRender ? `${(r.cpuMsPerRender / base.cpuMsPerRender).toFixed(2)}x` : '-';
		return [
			String(r.concurrency),
			r.variant,
			`${r.batchMs}ms`,
			`${r.perRenderWall}ms`,
			`${r.maxWall}ms`,
			`${r.cpuMsPerRender}ms`,
			String(r.rendersPerSec),
			ratio,
			cpuRatio,
			`${r.v8CompileMs}ms`,
			`${r.scriptMs}ms`,
			`${r.devtoolsMs}ms`,
			String(r.requestsPerRender),
			String(r.jsRequestsPerRender),
			`${r.nodeCpuMsPerRender}ms`,
			`${r.nodeBusyPct}%`,
			`${r.loopP99Ms}ms`,
			String(r.processes),
			String(r.rssMb),
			String(r.reviews),
		];
	});
	const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
	const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
	console.log(line(head));
	console.log(widths.map((w) => '-'.repeat(w)).join('  '));
	for (const row of rows) console.log(line(row));

	console.log('\n## per-render CPU by Chrome process type (last rep)\n');
	for (const r of results) {
		if (!r.cpuByType) continue;
		const parts = Object.entries(r.cpuByType).map(([k, v]) => `${k} ${v.cpuMs}ms/${v.n}p/${v.rssMb}MB`);
		console.log(`c=${String(r.concurrency).padStart(2)} ${r.variant.padEnd(26)} ${parts.join('  ')}`);
	}

	console.log('\n## spread across reps (cpu/render, batch ms) — read a difference inside this as noise\n');
	for (const r of results) {
		console.log(
			`c=${String(r.concurrency).padStart(2)} ${r.variant.padEnd(26)} cpu ${JSON.stringify(r.allCpu)}  batch ${JSON.stringify(r.allBatch)}` +
				(r.poolResetFailures ? `  POOL-RESET-FAILURES ${r.poolResetFailures}` : '')
		);
	}
}

await main();
