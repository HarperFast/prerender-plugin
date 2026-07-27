// Self-check: the audit's own correctness tests. Runs the PURE diff classifier on synthetic
// fingerprints and the browser detectors against self-contained golden fixtures (no network, no origin —
// setContent) to assert (a) no false positives on a clean control / A-vs-A null, and (b) each detector
// fires on its planted defect. A regression that reintroduces cry-wolf or drops a detector fails here.
//
// Uses puppeteer directly (this is a TEST harness) so it needs no origin. `runSelfCheckResults()` returns
// the structured results (driven by the package's node --test suite); `runSelfCheck()` logs them and
// returns a 0/1 exit code (the shape a CLI `--self-check` flag consumes).

import puppeteer from 'puppeteer';
import type { Browser } from 'puppeteer';
import { auditServed } from './detectors.js';
import { diffContent } from './diff.js';
import type { Fingerprint, Finding } from './util.js';

/** One self-check assertion result. */
export interface SelfCheckResult {
	name: string;
	pass: boolean;
	detail: string;
}

type AuditServedOpts = Parameters<typeof auditServed>[1];

const fp = (text: string[], extra: Partial<Fingerprint> = {}): Fingerprint =>
	({
		text,
		headings: [],
		links: [],
		images: [],
		jsonld: [],
		meta: { title: '', metaDescription: '', canonical: '', robots: '', h1Count: 0 },
		buckets: {},
		...extra,
	}) as Fingerprint;

// Self-contained fixtures (inline styles; no external assets needed for the structural/geometry checks).
const PAGE = (body: string): string =>
	`<!doctype html><html><head><meta charset="utf-8"><title>fixture</title></head><body>${body}</body></html>`;
const FILLER =
	'<main><h1>Product name here</h1><p>' +
	'Real visible product copy that gives the page substantial text content. '.repeat(6) +
	'</p></main>';

interface Fixture {
	html: string;
	want: (f: Finding[]) => boolean;
	opts: AuditServedOpts;
	invert?: boolean;
}

const FIXTURES: Record<string, Fixture> = {
	overlay: {
		html: PAGE(
			FILLER +
				'<div id="scrim" style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:9999"></div>'
		),
		want: (f) => f.some((x) => ['occluded', 'modal', 'dimming-scrim', 'banner'].includes(x.symptom)),
		opts: {},
	},
	frozen: {
		html: PAGE('<div class="content-loading-spinner" style="width:240px;height:240px;background:#eee"></div>'),
		want: (f) => f.some((x) => x.symptom.startsWith('frozen')),
		opts: {},
	},
	brokenSrc: {
		html: PAGE(FILLER + '<img data-src="https://cdn.example.com/real.jpg" src="" alt="hero">'),
		want: (f) => f.some((x) => x.symptom === 'broken-src'),
		opts: {},
	},
	hiddenText: {
		html: PAGE('<main><h1>Visible heading</h1><div style="display:none">secret lost content phrase</div></main>'),
		want: (f) => f.some((x) => x.symptom === 'hidden-text'),
		opts: { bStructuralText: ['secret lost content phrase'], aHadContentKeys: ['secret lost content phrase'] },
	},
	// A collapsed NAV menu with the same hidden text must NOT fire (nav-chrome exclusion / cry-wolf guard).
	navChromeControl: {
		html: PAGE('<nav><ul><li style="display:none"><a href="/x">Shoes</a></li></ul></nav>' + FILLER),
		want: (f) => !f.some((x) => x.symptom === 'hidden-text'),
		opts: { bStructuralText: ['shoes'], aHadContentKeys: ['shoes'] },
		invert: true, // "want" is the ABSENCE of the finding
	},
	clean: {
		html: PAGE(FILLER),
		want: (f) => f.length === 0,
		opts: {},
	},
};

/** Run all self-checks and return the structured results (no console output, no process exit). */
export async function runSelfCheckResults(): Promise<SelfCheckResult[]> {
	const results: SelfCheckResult[] = [];
	const check = (name: string, pass: boolean, detail = ''): void => {
		results.push({ name, pass, detail });
	};

	// ---- pure diff classifier tests (no browser) ----
	const base = fp(['alpha beta gamma', 'shared retail line', 'even heat distribution ceramic']);
	const bMissing = fp(['alpha beta gamma', 'shared retail line']); // drops the "even heat distribution" phrase
	const dNull = diffContent([base, base], [base, base], 2);
	check(
		'A-vs-A null → 0 missing, 0 stale',
		dNull.missing.length === 0 && dNull.stale.length === 0,
		`missing=${dNull.missing.length} stale=${dNull.stale.length}`
	);
	const dMiss = diffContent([base, base], [bMissing, bMissing], 2);
	check(
		'MISSING detects a dropped phrase',
		dMiss.missing.some((f) => /even heat distribution/.test(f.sampleText)),
		`missing=[${dMiss.missing.map((f) => f.sampleText).join('|')}]`
	);
	// fragmentation guard (H5): a phrase RE-CHUNKED contiguously across B lines → suppressed (B has it,
	// just split differently); a phrase whose words are merely SCATTERED (non-adjacent) → NOT suppressed
	// (genuinely missing as a contiguous phrase). Both directions asserted.
	const bReChunked = fp(['alpha beta gamma', 'even heat', 'distribution ceramic shared retail line']);
	const dReChunk = diffContent([base, base], [bReChunked, bReChunked], 2);
	check(
		'fragmentation guard suppresses a contiguous re-chunk',
		!dReChunk.missing.some((f) => /even heat distribution/.test(f.sampleText)),
		`missing=[${dReChunk.missing.map((f) => f.sampleText).join('|')}]`
	);
	const bScattered = fp(['even the price', 'heat wave sale', 'distribution center hours']);
	const dScatter = diffContent([base, base], [bScattered, bScattered], 2);
	check(
		'scattered (non-adjacent) tokens are NOT suppressed → reported missing',
		dScatter.missing.some((f) => /even heat distribution/.test(f.sampleText)),
		`missing=[${dScatter.missing.map((f) => f.sampleText).join('|')}]`
	);

	// ---- browser fixture tests ----
	let browser: Browser | undefined;
	try {
		browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
	} catch (e) {
		check('launch headless browser', false, (e as Error)?.message);
		return results;
	}
	try {
		for (const [name, fx] of Object.entries(FIXTURES)) {
			const page = await browser.newPage();
			try {
				await page.setViewport({ width: 390, height: 800 });
				await page.setContent(fx.html, { waitUntil: 'load' });
				const { findings } = await auditServed(page, fx.opts || {});
				check(`fixture: ${name}`, fx.want(findings), `symptoms=[${findings.map((f) => f.symptom).join(',')}]`);
			} catch (e) {
				check(`fixture: ${name}`, false, `threw: ${(e as Error)?.message}`);
			} finally {
				await page.close().catch(() => {});
			}
		}
		// C-determinism: the same fixture audited twice yields the same finding set.
		const p1 = await browser.newPage();
		const p2 = await browser.newPage();
		try {
			await p1.setContent(FIXTURES.overlay.html, { waitUntil: 'load' });
			await p2.setContent(FIXTURES.overlay.html, { waitUntil: 'load' });
			const a = (await auditServed(p1, {})).findings.map((f) => f.symptom + '|' + f.selectorPath).sort();
			const b = (await auditServed(p2, {})).findings.map((f) => f.symptom + '|' + f.selectorPath).sort();
			check(
				'C-determinism (same bytes → same findings)',
				JSON.stringify(a) === JSON.stringify(b),
				`${a.length} vs ${b.length}`
			);
		} finally {
			await p1.close().catch(() => {});
			await p2.close().catch(() => {});
		}
	} finally {
		await browser.close().catch(() => {});
	}
	return results;
}

/** Run the self-check, log a PASS/FAIL line per assertion, and return a 0/1 exit code. */
export async function runSelfCheck(): Promise<number> {
	const results = await runSelfCheckResults();
	console.log('\n── self-check ──');
	for (const r of results)
		console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : '  (' + r.detail + ')'}`);
	const passed = results.filter((r) => r.pass).length;
	console.log(`\nself-check: ${passed}/${results.length} passed`);
	return passed === results.length ? 0 : 1;
}

export default runSelfCheck;
