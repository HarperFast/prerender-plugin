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
 * Usage:
 *   node bench/render-cpu/load.js --concurrency 8 --reps 3
 *   node bench/render-cpu/load.js --concurrency 1,4,8,16 --only baseline,best-of
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
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
import { median, processTreeCpu } from './instrument.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const DEVICE = flag('device', 'mobile');
const REPS = Number(flag('reps', 3));
const LEVELS = flag('concurrency', '8')
	.split(',')
	.map(Number);
const ONLY = flag('only', '')
	.split(',')
	.filter(Boolean);
const JSON_OUT = flag('json', '');

async function main() {
	const selected = VARIANTS.filter((v) => (ONLY.length ? ONLY.includes(v.name) : true)).filter(
		(v) => !v.devices || v.devices.includes(DEVICE)
	);
	const fixture = await startFixture();
	console.log(`fixture: ${fixture.url}`);
	console.log(`device: ${DEVICE}  reps: ${REPS}  concurrency: ${LEVELS.join(',')}`);
	console.log(`cores: ${(await import('node:os')).cpus().length}\n`);

	const results = [];

	for (const concurrency of LEVELS) {
		for (const variant of selected) {
			// Settings are resolved per variant, ONCE, before any render — the reason this runner
			// cannot use renderOnce (which resolves them per call, mutating process state under any
			// render already in flight).
			resolveSettings(
				{
					config: merge(BASE_CONFIG, variant.config),
					// An AXIS, not a constant. Hard-disabling it here is what made every caching and
					// compile-cost candidate unmeasurable — including the "shared context" result that
					// went into the README as a dead end.
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
			const launchOptions = variant.launch?.chromeArgs
				? { ...base, args: [...(base.args ?? []), ...variant.launch.chromeArgs] }
				: base;
			const managed = await ManagedBrowser.launch({
				maxActivePages: concurrency + 1,
				puppeteerLaunchOptions: launchOptions,
			});

			const url = variant.urlQuery ? `${fixture.url}?${variant.urlQuery}` : fixture.url;

			// SLOT-SCOPED CONTEXTS. Today every render gets a fresh incognito context, whose HTTP cache
			// is in-memory and dies with it — so Chrome never carries a compiled-script (V8 code) cache
			// from one render to the next, and the disk-cache flag has never applied to a single render.
			// This leases a long-lived context per slot and wipes it between renders with the SAME
			// routine production already uses between a job's device variants, which fails closed: if
			// the wipe cannot be guaranteed the render takes a fresh context instead.
			const pool = [];
			let poolResetFailures = 0;
			const acquireContext = async () => {
				if (!variant.contextPool) return null;
				return pool.pop() ?? (await managed.createContext());
			};

			// Renders the page and hands it back STILL OPEN: the caller closes it after sampling CPU.
			const renderOne = async (i, keep) => {
				const started = Date.now();
				const context = await acquireContext();
				const page = await managed.getPage(context);
				if (context) {
					const wiped = await resetForNextVariant(context, page, url, []);
					if (!wiped) {
						// Fail closed, exactly as production does: a context that cannot be proven clean is
						// not reused. Counted so a silent fallback cannot flatter the result.
						poolResetFailures++;
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

			// One discarded warm-up batch, then the measured reps.
			await Promise.all(Array.from({ length: concurrency }, (_, i) => renderOne(i)));

			const batches = [];
			for (let rep = 0; rep < REPS; rep++) {
				const before = processTreeCpu(managed.pid);
				const open = [];
				const started = Date.now();
				const runs = await Promise.all(Array.from({ length: concurrency }, (_, i) => renderOne(i, open)));
				const batchMs = Date.now() - started;
				const after = processTreeCpu(managed.pid);
				const cpu = { cpuSeconds: (after?.cpuSeconds ?? 0) - (before?.cpuSeconds ?? 0) };
				for (const page of open) await managed.closePage(page);
			for (const context of pool.splice(0)) await managed.disposeContext(context).catch(() => {});
				batches.push({
					batchMs,
					cpuSeconds: cpu.cpuSeconds,
					processes: after?.processes ?? null,
					rssMb: after?.rssMb ?? null,
					perRenderWall: median(runs.map((r) => r.wallMs)),
					maxWall: Math.max(...runs.map((r) => r.wallMs)),
					reviews: median(runs.map((r) => r.reviews)),
					bytes: median(runs.map((r) => r.bytes)),
				});
			}
			await managed.close().catch(() => {});

			const row = {
				concurrency,
				variant: variant.name,
				batchMs: median(batches.map((b) => b.batchMs)),
				perRenderWall: median(batches.map((b) => b.perRenderWall)),
				maxWall: median(batches.map((b) => b.maxWall)),
				cpuMsPerRender: Math.round((median(batches.map((b) => Math.round(b.cpuSeconds * 1000))) ?? 0) / concurrency),
				rendersPerSec: Number((concurrency / (median(batches.map((b) => b.batchMs)) / 1000)).toFixed(2)),
				reviews: median(batches.map((b) => b.reviews)),
				bytes: median(batches.map((b) => b.bytes)),
				processes: median(batches.map((b) => b.processes)),
				rssMb: median(batches.map((b) => b.rssMb)),
				poolResetFailures,
			};
			results.push(row);
			console.log(
				`c=${String(concurrency).padStart(2)} ${variant.name.padEnd(24)} ` +
					`batch ${String(row.batchMs).padStart(6)}ms  per-render ${String(row.perRenderWall).padStart(6)}ms  ` +
					`cpu/render ${String(row.cpuMsPerRender).padStart(5)}ms  ${String(row.rendersPerSec).padStart(5)}/s  reviews ${row.reviews}`
			);
		}
		console.log('');
	}

	await fixture.close();
	report(results);
	if (JSON_OUT) {
		const path = resolvePath(process.cwd(), JSON_OUT);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify({ device: DEVICE, reps: REPS, levels: LEVELS, results }, null, 2));
		console.log(`\nwrote ${path}`);
	}
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
		'procs',
		'rssMb',
		'reviews',
	];
	const rows = results.map((r) => {
		const base = results.find((x) => x.concurrency === r.concurrency && x.variant === results[0].variant);
		const ratio = base && base.rendersPerSec ? `${(r.rendersPerSec / base.rendersPerSec).toFixed(2)}x` : '-';
		return [
			String(r.concurrency),
			r.variant,
			`${r.batchMs}ms`,
			`${r.perRenderWall}ms`,
			`${r.maxWall}ms`,
			`${r.cpuMsPerRender}ms`,
			String(r.rendersPerSec),
			ratio,
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
}

await main();
