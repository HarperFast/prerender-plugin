/**
 * `bench/render-cpu` — what a render actually costs, and what each candidate change does to it.
 *
 * Method, and why it is this way:
 *
 *  - ONE fixture, served from 127.0.0.1, deterministic (see fixture.js). No origin, no network
 *    jitter, no CDN. The numbers are about our in-page code, not about a site.
 *  - Variants are INTERLEAVED, not run in blocks: rep 1 of every variant, then rep 2, and so on. A
 *    laptop's clock speed drifts with thermals over minutes, and a block layout hands the whole
 *    drift to whichever variant ran last. Interleaving spreads it across all of them.
 *  - MEDIAN, not mean, over reps: one GC pause or one OS scheduling hiccup moves a mean and does
 *    not move a median.
 *  - Every variant renders the same URL with the same device profile, through the real
 *    `renderOnce` -> `defaultRenderer` path, so a variant cannot accidentally measure a different
 *    code path than production runs.
 *  - FIDELITY IS MEASURED ALONGSIDE COST, on every run. A cheaper render that loses the review
 *    widget is not a win, and the only way that stays honest is for the same table to carry both.
 *    `reviews`, `revealed`, `lazyTiles`, `imgGated` and `offers` are the fixture's content markers;
 *    a variant that changes any of them against baseline is flagged.
 *
 * Usage:
 *   node bench/render-cpu/bench.js                          # all variants, mobile, 5 reps
 *   node bench/render-cpu/bench.js --device desktop --reps 7
 *   node bench/render-cpu/bench.js --only baseline,monitor
 *   node bench/render-cpu/bench.js --json results/mobile.json
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { renderOnce } from '../../packages/browser/dist/index.js';
import ManagedBrowser from '../../packages/browser/dist/ManagedBrowser.js';
import { experiments, resetExperiments, splits } from '../../packages/browser/dist/experiments.js';
import { defaultLaunchOptions } from '../../packages/browser/dist/settings.js';
import { startFixture } from './fixture.js';
import { cdpCounter, processTreeCpu, pageMetrics, readMetrics, median } from './instrument.js';
import { VARIANTS, BASE_CONFIG, merge } from './variants.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const DEVICE = flag('device', 'mobile');
const REPS = Number(flag('reps', 5));
const ONLY = flag('only', '')
	.split(',')
	.filter(Boolean);
const JSON_OUT = flag('json', '');
const WARMUP = Number(flag('warmup', 1));

/** Content markers in the returned HTML — the fidelity half of every row. */
const fidelity = (html) => {
	const count = (needle) => (html ? html.split(needle).length - 1 : 0);
	return {
		bytes: html?.length ?? 0,
		reviews: count('rv-item'),
		lazyTiles: count('data-tile="lz-'),
		revealed: count('id="reviewWrap" class="transition-all opacity-100"') > 0 ? 1 : 0,
		imgGated: count('id="onloadOk"'),
		scrollGated: count('id="scrollGatedOk"'),
		shadowFlattened: count('data-sh='),
		propsStripped: count(' props=') === 0 ? 1 : 0,
	};
};

async function main() {
	const selected = VARIANTS.filter((v) => (ONLY.length ? ONLY.includes(v.name) : true)).filter(
		(v) => !v.devices || v.devices.includes(DEVICE)
	);
	if (!selected.length) throw new Error(`no variants selected for device=${DEVICE}`);

	const fixture = await startFixture();
	console.log(`fixture: ${fixture.url}`);
	console.log(`device: ${DEVICE}   reps: ${REPS}   variants: ${selected.map((v) => v.name).join(', ')}\n`);

	// One browser per distinct launch-args set, all launched up front so a variant never pays a
	// cold-launch cost another variant does not. Renders stay single-flight regardless.
	const browsers = new Map();
	const launchKeyOf = (v) => JSON.stringify(v.launch ?? null);
	for (const variant of selected) {
		const key = launchKeyOf(variant);
		if (browsers.has(key)) continue;
		const base = defaultLaunchOptions();
		const options = variant.launch?.chromeArgs
			? { ...base, args: [...(base.args ?? []), ...variant.launch.chromeArgs] }
			: base;
		browsers.set(key, await ManagedBrowser.launch({ maxActivePages: 1, puppeteerLaunchOptions: options }));
	}

	const runs = new Map(selected.map((v) => [v.name, []]));

	const runOnce = async (variant) => {
		resetExperiments();
		Object.assign(experiments, variant.experiments ?? {});
		// Always on: the split is four Date.now() deltas per settle step, and without it the biggest
		// line in the results ("settle") is a single undifferentiated number.
		experiments.instrument = true;
		const managed = browsers.get(launchKeyOf(variant));
		const pid = managed.pid;
		const cpuBefore = processTreeCpu(pid);
		const counter = cdpCounter();
		const started = Date.now();
		let result;
		let cdp;
		try {
			result = await renderOnce({
				url: variant.urlQuery ? `${fixture.url}?${variant.urlQuery}` : fixture.url,
				device: DEVICE,
				browser: managed,
				config: merge(BASE_CONFIG, variant.config),
				captureNonIndexable: variant.captureNonIndexable ?? true,
				...(variant.browserOptions ?? {}),
				probes: {
					// Both sampled from the LIVE page, before teardown: the renderer process that did
					// this render exits with its context and takes its CPU accounting with it.
					metrics: async ({ page }) => pageMetrics(await readMetrics(page)),
					cpu: () => processTreeCpu(pid),
					passes: ({ page }) => page.evaluate(() => window.__passes ?? 0),
					// Fixture geometry, reported so a run can be checked against PDP scale rather than
					// assumed to be at it: page height drives the scroll-pass count, element count
					// drives every walk.
					shape: ({ page }) =>
						page.evaluate(() => ({
							height: document.body.scrollHeight,
							elements: document.getElementsByTagName('*').length,
							// The viewport Chrome actually gave us. An override can be clamped, and a
							// variant that thinks it asked for 24,000px and got less would otherwise
							// publish a conclusion about a height that never existed.
							innerHeight: window.innerHeight,
						})),
				},
			});
		} finally {
			cdp = counter.stop();
		}
		const wallMs = Date.now() - started;
		const cpuAfter = result.probes?.cpu;
		return {
			wallMs,
			renderMs: result.renderTimeMs ?? null,
			...result.timings,
			cpuMs:
				cpuBefore && cpuAfter ? Math.round((cpuAfter.cpuSeconds - cpuBefore.cpuSeconds) * 1000) : null,
			...(result.probes?.metrics ?? {}),
			cdpSent: cdp.sent,
			cdpEvents: cdp.events,
			cdpBytesInMb: Math.round(cdp.bytesIn / (1 << 20)),
			evaluates: cdp.bySent['Runtime.callFunctionOn'] ?? 0,
			fetchContinue: cdp.bySent['Fetch.continueRequest'] ?? 0,
			fetchFulfill: cdp.bySent['Fetch.fulfillRequest'] ?? 0,
			fetchFail: cdp.bySent['Fetch.failRequest'] ?? 0,
			getResponseBody: cdp.bySent['Network.getResponseBody'] ?? 0,
			outcome: result.outcome,
			scrollMs: splits.scrollMs,
			idleMs: splits.idleMs,
			countMs: splits.countMs,
			gateMs: splits.gateMs,
			gateTicks: splits.gateTicks,
			scrollPasses: result.probes?.passes ?? null,
			pageHeight: result.probes?.shape?.height ?? null,
			lightElements: result.probes?.shape?.elements ?? null,
			innerHeight: result.probes?.shape?.innerHeight ?? null,
			waitForMs: (result.waitForResults ?? []).reduce((a, r) => a + r.waitedMs, 0),
			offers: result.job?.structuredOffers?.length ?? 0,
			...fidelity(result.html),
			_bySent: cdp.bySent,
		};
	};

	// Warm-up reps, discarded: the first render in a fresh Chrome pays one-time costs (V8 code cache
	// for our in-page functions, the fixture's first compile, OS page faults) that no steady-state
	// render pays, and they land entirely on whichever variant happens to go first.
	for (let w = 0; w < WARMUP; w++) {
		for (const variant of selected) await runOnce(variant);
	}

	for (let rep = 0; rep < REPS; rep++) {
		for (const variant of selected) {
			const run = await runOnce(variant);
			runs.get(variant.name).push(run);
			process.stdout.write(
				`rep ${rep + 1}/${REPS} ${variant.name.padEnd(22)} ` +
					`wall ${String(run.wallMs).padStart(6)}ms  cpu ${String(run.cpuMs).padStart(6)}ms  ` +
					`task ${String(run.taskMs).padStart(5)}ms  eval ${String(run.evaluates).padStart(3)}  ` +
					`cdp ${String(run.cdpSent).padStart(4)}  reviews ${run.reviews}\n`
			);
		}
	}

	await fixture.close();
	for (const managed of browsers.values()) await managed.close().catch(() => {});

	report(selected, runs);
	if (JSON_OUT) {
		const path = resolvePath(process.cwd(), JSON_OUT);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify(
				{
					device: DEVICE,
					reps: REPS,
					node: process.version,
					platform: `${process.platform}-${process.arch}`,
					when: new Date().toISOString(),
					runs: Object.fromEntries(runs),
				},
				null,
				2
			)
		);
		console.log(`\nwrote ${path}`);
	}
}

const COST_COLUMNS = [
	['wallMs', 'wall'],
	['cpuMs', 'cpu(tree)'],
	['taskMs', 'task'],
	['taskOtherMs', 'task-other'],
	['processTimeMs', 'proc-cpu'],
	['scriptMs', 'script'],
	['v8CompileMs', 'v8compile'],
	['devtoolsMs', 'devtools'],
	['layoutMs', 'layout'],
	['recalcStyleMs', 'style'],
	['settle', 'settle'],
	['scrollMs', 'scroll'],
	['idleMs', 'idle'],
	['countMs', 'count'],
	['gateMs', 'gate'],
	['postProcess', 'postProc'],
	['evaluates', 'evals'],
	['cdpSent', 'cdp-sent'],
	['scrollPasses', 'passes'],
	['pageHeight', 'height'],
	['lightElements', 'elements'],
	['innerHeight', 'innerH'],
];

const FIDELITY_COLUMNS = [
	['reviews', 'reviews'],
	['revealed', 'revealed'],
	['lazyTiles', 'lazyTiles'],
	['imgGated', 'imgGated'],
	['scrollGated', 'scrollGated'],
	['offers', 'offers'],
	['shadowFlattened', 'shadow'],
	['bytes', 'bytes'],
];

function report(selected, runs) {
	const med = (name, key) => median(runs.get(name).map((r) => r[key]));
	const baseName = selected[0].name;

	const table = (columns, title, withDelta) => {
		console.log(`\n## ${title}\n`);
		const head = ['variant', ...columns.map(([, label]) => label)];
		const rows = selected.map((v) => {
			const cells = columns.map(([key]) => {
				const value = med(v.name, key);
				if (value === null) return '-';
				if (!withDelta || v.name === baseName) return String(value);
				const base = med(baseName, key);
				if (base === null || base === 0) return String(value);
				const pct = Math.round(((value - base) / base) * 100);
				return `${value} (${pct > 0 ? '+' : ''}${pct}%)`;
			});
			return [v.name, ...cells];
		});
		const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
		const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
		console.log(line(head));
		console.log(widths.map((w) => '-'.repeat(w)).join('  '));
		for (const row of rows) console.log(line(row));
	};

	table(COST_COLUMNS, `cost — median of ${REPS} reps (delta vs ${baseName})`, true);
	table(FIDELITY_COLUMNS, 'fidelity — must match baseline, or the cost win is not a win', false);

	// Flag any variant whose content markers diverge: the single most important line of output.
	console.log('');
	for (const v of selected.slice(1)) {
		const diffs = FIDELITY_COLUMNS.filter(([key]) => key !== 'bytes')
			.map(([key, label]) => [label, med(baseName, key), med(v.name, key)])
			.filter(([, base, got]) => base !== got);
		if (diffs.length) {
			console.log(
				`FIDELITY DIVERGENCE  ${v.name}: ` + diffs.map(([label, base, got]) => `${label} ${base} -> ${got}`).join(', ')
			);
		}
	}

	// The CDP method breakdown for baseline: where the message count actually is.
	const baseRun = runs.get(baseName)[0];
	console.log(`\n## baseline CDP methods sent (one representative run, ${baseRun.cdpSent} total)\n`);
	for (const [method, count] of Object.entries(baseRun._bySent).slice(0, 14)) {
		console.log(`${String(count).padStart(5)}  ${method}`);
	}
}

await main();
