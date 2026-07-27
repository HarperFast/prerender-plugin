// Prerender-audit HTML report (spec §4.3c). PURE string building — no puppeteer, no I/O, no in-page code.
// Consumes AuditResult[] (see the DATA SHAPES contract in ./util.mjs) and returns ONE self-contained,
// theme-aware HTML document (inline <style>, no external refs, zero JavaScript required to view).
//
// The only import-worthy fact from the contract used here is the *shape* of AuditResult / Finding; this
// module reads those fields defensively (every access is guarded) so a partially-populated cell never
// throws while building the page.

import type { AuditResult, BucketDrop, Diff1, Finding, Frequency, SelfJaccard, SuggestedConfig } from './util.js';

// ---------------------------------------------------------------------------------------------------
// Small, self-contained helpers
// ---------------------------------------------------------------------------------------------------

/** Escape the 5 HTML-significant chars for safe interpolation into text OR double/single-quoted attrs. */
function esc(s: unknown): string {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/** Base64-encode a Uint8Array PNG for a data: URI (Buffer handles Uint8Array directly). '' on failure. */
function u8ToBase64(u8?: Uint8Array): string {
	try {
		if (!u8) return '';
		return Buffer.from(u8).toString('base64');
	} catch {
		return '';
	}
}

/** Render a number to 2dp, or an em-dash sentinel when it isn't a finite number. */
function fmt2(x: unknown): string {
	return typeof x === 'number' && Number.isFinite(x) ? x.toFixed(2) : '—';
}

/** "k/n" from a Finding.frequency {k,n}; '' when either side is missing. */
function freqStr(freq?: Frequency): string {
	if (!freq || typeof freq !== 'object') return '';
	const { k, n } = freq;
	if (k == null || n == null) return '';
	return `${k}/${n}`;
}

/** Best-effort short label for a heterogeneous diff item (string, jsonld {type,key}, bucketDrop, Finding). */
function labelValue(v: unknown): string {
	if (v == null) return '';
	if (typeof v === 'string' || typeof v === 'number') return String(v);
	if ((v as LabelItem).type != null && (v as LabelItem).key != null)
		return `${(v as LabelItem).type}:${(v as LabelItem).key}`;
	if ((v as LabelItem).type != null) return String((v as LabelItem).type);
	// bucketDrops entries carry `name` (not `bucket`); support both. (review L2)
	if ((v as LabelItem).bucket != null || (v as LabelItem).name != null) {
		const a = (v as LabelItem).medA != null ? ` A=${(v as LabelItem).medA}` : '';
		const b = (v as LabelItem).medB != null ? ` B=${(v as LabelItem).medB}` : '';
		return `${(v as LabelItem).bucket ?? (v as LabelItem).name}${a}${b}`;
	}
	if ((v as LabelItem).sampleText) return String((v as LabelItem).sampleText);
	try {
		return JSON.stringify(v);
	} catch {
		return String(v);
	}
}

/** Duck-typed view of the heterogeneous items labelValue accepts (jsonld / bucketDrop / Finding). */
interface LabelItem {
	type?: string | number | null;
	key?: string | number | null;
	bucket?: string | number | null;
	name?: string | number | null;
	medA?: string | number | null;
	medB?: string | number | null;
	sampleText?: string | number | null;
}

// Matrix columns, in display order, and how each maps onto the AuditResult shape. Must stay in sync
// with the detector symptom set and the CLI dashboard (review M6): HIDDEN column added; OCCLUDED
// covers all overlay variants.
const COLS = ['MISSING', 'FLAKY', 'HIDDEN', 'OCCLUDED', 'FROZEN', 'BROKEN-IMG'] as const;

// Severity weights so the "top fix" per row/section surfaces the most actionable finding first.
const SEVERITY: Record<string, number> = {
	'missing': 100,
	'occluded': 90,
	'modal': 90,
	'banner': 88,
	'dimming-scrim': 86,
	'frozen-content-lost': 85,
	'frozen-dead-spinner': 80,
	'broken-src': 70,
	'load-failed': 65,
	'flaky-b': 60,
	'hidden-text': 55,
	'dropped-in-serialization': 50,
	'stale': 40,
};
const sevOf = (f: Finding | undefined): number => SEVERITY[(f && f.symptom) || ''] ?? 10;

/** Count the 5 matrix buckets for one cell from its diff1 arrays + diff2 findings. */
function cellCounts(cell: AuditResult) {
	const d1 = cell.diff1 || ({} as Diff1);
	const findings = (cell.diff2 && cell.diff2.findings) || [];
	const bySym = (pred: (s: string) => boolean) => findings.filter((f) => pred((f && f.symptom) || '')).length;
	return {
		'MISSING': (d1.missing || []).length,
		'FLAKY': (d1.flakyB || []).length,
		'HIDDEN': bySym((s) => s === 'hidden-text' || s === 'dropped-in-serialization'),
		'OCCLUDED': bySym((s) => s === 'occluded' || s === 'modal' || s === 'banner' || s === 'dimming-scrim'),
		'FROZEN': bySym((s) => s.startsWith('frozen')),
		'BROKEN-IMG': bySym((s) => s === 'broken-src' || s === 'load-failed'),
	};
}

/** All findings across both diffs for a cell (used for ranking the top fix). */
function allFindings(cell: AuditResult): Finding[] {
	const d1 = cell.diff1 || ({} as Diff1);
	const d2 = (cell.diff2 && cell.diff2.findings) || [];
	return [...(d1.missing || []), ...(d1.flakyB || []), ...(d1.stale || []), ...d2];
}

/** Human "top fix" label for a finding: fixType + (string patch | selectorPath). '' when no fix. */
function fixLabel(f?: Finding): string {
	if (!f) return '';
	const type = f.fixType || '';
	let detail = '';
	if (typeof f.fixPatch === 'string') detail = f.fixPatch;
	else if (f.selectorPath) detail = f.selectorPath;
	return [type, detail].filter(Boolean).join(' ');
}

/** Highest-severity fixable finding across a list → its fixLabel (''when none). */
function topFix(findings: Finding[]): string {
	const ranked = findings.filter((f) => f && (f.fixType || f.fixPatch != null)).sort((a, b) => sevOf(b) - sevOf(a));
	return ranked.length ? fixLabel(ranked[0]) : '';
}

/** Copy-paste fix snippet for a Diff-2 card: JSON for object patches, a labeled line for string patches. */
function fixSnippet(f?: Finding): string {
	if (!f || f.fixPatch == null) return '';
	if (typeof f.fixPatch === 'string') return `${f.fixType || 'fix'}: ${f.fixPatch}`;
	try {
		return JSON.stringify(f.fixPatch, null, 2);
	} catch {
		return String(f.fixPatch);
	}
}

/** Pretty <pre> block for the aggregated suggestedConfig; '' when empty/absent. */
function configBlock(cfg?: SuggestedConfig): string {
	if (!cfg || typeof cfg !== 'object' || Object.keys(cfg).length === 0) return '';
	let s: string;
	try {
		s = JSON.stringify(cfg, null, 2);
	} catch {
		s = String(cfg);
	}
	return `<pre class="code-block">${esc(s)}</pre>`;
}

// ---------------------------------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------------------------------

/** A/B/C screenshot figure; PNG Uint8Array may be undefined → placeholder tile. */
function figure(u8: Uint8Array | undefined, tag: string, caption: string): string {
	const cap = `${esc(tag)} · ${esc(caption)}`;
	if (!u8) {
		return `<figure class="shot empty"><div class="noshot">no screenshot</div><figcaption>${cap}</figcaption></figure>`;
	}
	const b64 = u8ToBase64(u8);
	if (!b64) {
		return `<figure class="shot empty"><div class="noshot">unreadable</div><figcaption>${cap}</figcaption></figure>`;
	}
	// base64 is [A-Za-z0-9+/=] only → safe inside a double-quoted attribute without escaping.
	return `<figure class="shot"><img alt="${cap} screenshot" src="data:image/png;base64,${b64}"><figcaption>${cap}</figcaption></figure>`;
}

/** The self-Jaccard / aStabilized confidence banner for a cell. */
function confidenceBanner(cell: AuditResult): string {
	const sj = cell.selfJaccard || ({} as SelfJaccard);
	const aStab = !!cell.aStabilized;
	const lowA = typeof sj.A === 'number' && sj.A < 0.85;
	const outcomeBad = cell.outcomeA && cell.outcomeA !== 'ok';
	const lowConf = !aStab || lowA || outcomeBad;
	const cls = lowConf ? 'banner warn' : 'banner ok';
	let msg: string;
	if (outcomeBad) msg = `State A outcome was "${esc(cell.outcomeA)}" — ground truth unreliable; do not trust findings.`;
	else if (!aStab) msg = 'Low confidence — state A did not converge; MISSING findings are demoted to FLAKY.';
	else if (lowA) msg = 'Low confidence — weak run-to-run self-similarity in A.';
	else msg = 'High confidence — A converged and is self-consistent.';
	const meta = [
		`A stabilized ${aStab ? '✓' : '✗'}`,
		`self-Jaccard A ${fmt2(sj.A)} · B ${fmt2(sj.B)}`,
		`outcome A ${esc(cell.outcomeA || '?')} · B ${esc(cell.outcomeB || '?')}`,
	];
	return `<div class="${cls}"><strong>${esc(msg)}</strong><span class="banner-meta">${meta.join(' &nbsp;·&nbsp; ')}</span></div>`;
}

/** One Diff-1 list group (missing | flakyB | stale): sampleText + freq per line. */
function diff1Group(label: string, arr?: Finding[]): string {
	if (!arr || !arr.length) return '';
	const items = arr
		.map((f) => {
			const sample = esc((f && f.sampleText) || '');
			const freq = freqStr(f && f.frequency);
			const sel = f && f.selectorPath ? `<code>${esc(f.selectorPath)}</code> ` : '';
			const reason = f && f.computedReason ? `<span class="reason">${esc(f.computedReason)}</span>` : '';
			return `<li>${sel}<span class="sample">${sample || '<em>(no text)</em>'}</span>${
				freq ? ` <span class="freq">${esc(freq)}</span>` : ''
			}${reason}</li>`;
		})
		.join('\n');
	return `<div class="d1group"><h5>${esc(label)} <span class="count">${arr.length}</span></h5><ul class="d1list">${items}</ul></div>`;
}

/** Compact chip row for jsonldMissing / bucketDrops (heterogeneous items). */
function chipRow(label: string, arr?: (string | BucketDrop)[]): string {
	if (!arr || !arr.length) return '';
	const chips = arr.map((v) => `<span class="chip">${esc(labelValue(v))}</span>`).join(' ');
	return `<div class="chiprow"><span class="chip-label">${esc(label)}</span>${chips}</div>`;
}

/** The whole Diff-1 (SEO completeness) block for a cell. */
function diff1Section(cell: AuditResult): string {
	const d1 = cell.diff1 || ({} as Diff1);
	const groups =
		diff1Group('Missing', d1.missing) +
		diff1Group('Flaky in B', d1.flakyB) +
		diff1Group('Stale / prerender-only', d1.stale);
	const chips = chipRow('JSON-LD missing', d1.jsonldMissing) + chipRow('Bucket drops', d1.bucketDrops);
	if (!groups && !chips) {
		return `<div class="diff diff1"><h4>Diff 1 · SEO completeness (A − B)</h4><p class="empty-note">No completeness gaps.</p></div>`;
	}
	return `<div class="diff diff1"><h4>Diff 1 · SEO completeness (A − B)</h4>${groups}${chips}</div>`;
}

/** One Diff-2 (served fidelity) finding card. */
function findingCard(f: Finding | undefined): string {
	const symptom = esc((f && f.symptom) || 'finding');
	const freq = freqStr(f && f.frequency);
	const conf = f && f.confidence ? esc(f.confidence) : '';
	const sel =
		f && f.selectorPath
			? `<div class="card-row"><span class="k">selector</span> <code>${esc(f.selectorPath)}</code></div>`
			: '';
	const reason =
		f && f.computedReason ? `<div class="card-row"><span class="k">why</span> ${esc(f.computedReason)}</div>` : '';
	const sample =
		f && f.sampleText
			? `<div class="card-row"><span class="k">sample</span> <span class="sample">${esc(f.sampleText)}</span></div>`
			: '';
	const snip = fixSnippet(f);
	const fix = snip
		? `<div class="card-row"><span class="k">fix</span></div><pre class="code-block small">${esc(snip)}</pre>`
		: '';
	const badges =
		`<span class="badge sym-${symptom}">${symptom}</span>` +
		(conf ? `<span class="badge conf">${conf}</span>` : '') +
		(freq ? `<span class="badge freq">${esc(freq)}</span>` : '');
	return `<div class="card"><div class="card-head">${badges}</div>${sel}${reason}${sample}${fix}</div>`;
}

/** The whole Diff-2 block for a cell, incl. the aggregated suggestedConfig patch. */
function diff2Section(cell: AuditResult): string {
	const findings = (cell.diff2 && cell.diff2.findings) || [];
	const cards = findings.map(findingCard).join('\n');
	const body = findings.length ? `<div class="cards">${cards}</div>` : `<p class="empty-note">No fidelity defects.</p>`;
	const cfg = configBlock(cell.suggestedConfig);
	const cfgBlock = cfg ? `<div class="suggested"><h5>Suggested config patch</h5>${cfg}</div>` : '';
	return `<div class="diff diff2"><h4>Diff 2 · Served fidelity (B − C)</h4>${body}${cfgBlock}</div>`;
}

/** One full cell section. */
function renderCell(cell: AuditResult): string {
	const device = esc(cell.device || '?');
	const url = esc(cell.url || '');
	const triptych =
		`<div class="triptych">` +
		figure(cell.screenshots && cell.screenshots.A, 'A', 'full render (ground truth)') +
		figure(cell.screenshots && cell.screenshots.B, 'B', 'served snapshot bytes') +
		figure(cell.screenshots && cell.screenshots.C, 'C', 'rendered snapshot') +
		`</div>`;
	return `<section class="cell">
    <h3 class="cell-title"><span class="dev">${device}</span> <a class="url" href="${url}">${url}</a></h3>
    ${confidenceBanner(cell)}
    ${diff1Section(cell)}
    ${diff2Section(cell)}
    <div class="shots"><h4>Screenshots · A / B / C</h4>${triptych}</div>
  </section>`;
}

/** Aggregated summary-matrix row per (pageType, device). */
interface MatrixRow {
	pageType: string;
	device: string;
	counts: Record<string, number>;
	findings: Finding[];
	aStab: boolean;
}

/** Aggregate cells into one summary-matrix row per (pageType, device). */
function matrixRows(cells: AuditResult[]): MatrixRow[] {
	const rows = new Map<string, MatrixRow>();
	for (const c of cells) {
		const pageType = c.pageType || '(untyped)';
		const device = c.device || '?';
		const key = `${pageType}␟${device}`;
		if (!rows.has(key)) {
			rows.set(key, {
				pageType,
				device,
				counts: Object.fromEntries(COLS.map((k) => [k, 0])),
				findings: [],
				aStab: true,
			});
		}
		const r = rows.get(key) as MatrixRow;
		const cc = cellCounts(c);
		for (const k of COLS) r.counts[k] += cc[k];
		r.findings.push(...allFindings(c));
		if (!c.aStabilized) r.aStab = false;
	}
	return [...rows.values()];
}

/** The summary matrix table. */
function summaryMatrix(cells: AuditResult[]): string {
	const rows = matrixRows(cells);
	const head =
		`<tr><th>page type</th><th>device</th>` +
		COLS.map((c) => `<th class="num">${esc(c)}</th>`).join('') +
		`<th></th><th>top suggested fix</th></tr>`;
	const body = rows
		.map((r) => {
			const total = COLS.reduce((s, k) => s + r.counts[k], 0);
			const mark = total === 0 ? '<span class="ok">✓</span>' : '<span class="warn">⚠</span>';
			const nums = COLS.map((k) => {
				const v = r.counts[k];
				return `<td class="num${v > 0 ? ' hit' : ''}">${v}</td>`;
			}).join('');
			const fix = esc(topFix(r.findings));
			const unstable = r.aStab ? '' : ' <span class="tag">A unstable</span>';
			return `<tr><td class="pt">${esc(r.pageType)}</td><td>${esc(r.device)}</td>${nums}<td class="mark">${mark}</td><td class="fix">${
				fix || ''
			}${unstable}</td></tr>`;
		})
		.join('\n');
	return `<table class="matrix"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

// ---------------------------------------------------------------------------------------------------
// Stylesheet (theme-aware via prefers-color-scheme; no external refs, no JS)
// ---------------------------------------------------------------------------------------------------

const STYLE = `
  :root {
    --bg:#ffffff; --fg:#1a1d21; --muted:#5b6470; --border:#e3e6ea; --card:#f7f8fa;
    --code-bg:#f0f1f4; --accent:#0969da; --ok:#1a7f37; --warn:#9a6700; --bad:#cf222e;
    --warn-bg:#fff5e0; --warn-bd:#e5c07b; --ok-bg:#eaf6ec; --ok-bd:#a6d8b0; --hit:#cf222e;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#0d1117; --fg:#e6edf3; --muted:#9198a1; --border:#2a2f37; --card:#161b22;
      --code-bg:#1b2027; --accent:#58a6ff; --ok:#3fb950; --warn:#d29922; --bad:#f85149;
      --warn-bg:#2a2011; --warn-bd:#6a5321; --ok-bg:#122117; --ok-bd:#2a5c39; --hit:#f85149;
    }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
    font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .wrap { max-width:1100px; margin:0 auto; padding:32px 20px 80px; }
  a { color:var(--accent); }
  code, pre { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  code { background:var(--code-bg); padding:1px 5px; border-radius:4px; font-size:.88em; word-break:break-all; }
  .code-block { background:var(--code-bg); border:1px solid var(--border); border-radius:8px;
    padding:12px 14px; overflow-x:auto; font-size:12.5px; line-height:1.45; margin:8px 0 0; }
  .code-block.small { font-size:12px; margin-top:6px; }

  header.top { border-bottom:1px solid var(--border); padding-bottom:16px; margin-bottom:24px; }
  header.top h1 { margin:0 0 6px; font-size:26px; }
  .run-meta { color:var(--muted); font-size:14px; display:flex; gap:16px; flex-wrap:wrap; }
  .run-meta b { color:var(--fg); font-weight:600; }

  h2.group { margin:36px 0 4px; font-size:20px; border-bottom:1px solid var(--border); padding-bottom:6px; }

  /* summary matrix */
  .matrix-wrap { overflow-x:auto; margin:8px 0 12px; }
  table.matrix { border-collapse:collapse; width:100%; font-size:14px; }
  table.matrix th, table.matrix td { padding:8px 10px; border-bottom:1px solid var(--border); text-align:left; }
  table.matrix th { color:var(--muted); font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:.03em; }
  table.matrix td.num, table.matrix th.num { text-align:right; font-variant-numeric:tabular-nums; }
  table.matrix td.num.hit { color:var(--hit); font-weight:700; }
  table.matrix td.pt { font-weight:600; }
  table.matrix td.mark { text-align:center; }
  table.matrix td.fix { color:var(--muted); }
  .ok { color:var(--ok); font-weight:700; }
  .warn { color:var(--warn); font-weight:700; }
  .tag { font-size:11px; color:var(--warn); border:1px solid var(--warn-bd); border-radius:4px; padding:0 5px; }

  /* cells */
  section.cell { border:1px solid var(--border); border-radius:12px; padding:18px 18px 20px;
    margin:16px 0; background:var(--bg); }
  .cell-title { margin:0 0 12px; font-size:16px; display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }
  .cell-title .dev { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:#fff;
    background:var(--accent); border-radius:5px; padding:2px 8px; }
  .cell-title .url { font-weight:500; word-break:break-all; }

  .banner { border-radius:8px; padding:10px 14px; margin:0 0 14px; font-size:13.5px;
    display:flex; flex-direction:column; gap:3px; }
  .banner.ok { background:var(--ok-bg); border:1px solid var(--ok-bd); }
  .banner.warn { background:var(--warn-bg); border:1px solid var(--warn-bd); }
  .banner-meta { color:var(--muted); font-size:12.5px; }

  .diff { margin:14px 0; }
  .diff h4 { margin:0 0 8px; font-size:15px; }
  .empty-note { color:var(--muted); font-style:italic; margin:4px 0; }
  .d1group { margin:0 0 10px; }
  .d1group h5 { margin:0 0 4px; font-size:13px; color:var(--muted); text-transform:uppercase; letter-spacing:.03em; }
  .d1group .count { color:var(--bad); font-weight:700; }
  ul.d1list { margin:0; padding-left:18px; }
  ul.d1list li { margin:3px 0; }
  .sample { }
  .freq { color:var(--muted); font-size:12px; font-variant-numeric:tabular-nums; }
  .reason { color:var(--muted); font-size:12.5px; display:block; }

  .chiprow { margin:8px 0; font-size:13px; display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
  .chip-label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.03em; }
  .chip { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:2px 9px; font-size:12.5px; }

  .cards { display:grid; gap:12px; }
  .card { border:1px solid var(--border); border-radius:10px; padding:12px 14px; background:var(--card); }
  .card-head { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:6px; }
  .badge { font-size:11px; border-radius:5px; padding:2px 8px; font-weight:600; letter-spacing:.02em;
    background:var(--code-bg); border:1px solid var(--border); }
  .badge.conf { color:var(--muted); }
  .badge.freq { color:var(--muted); font-variant-numeric:tabular-nums; }
  .card-row { margin:3px 0; font-size:13.5px; }
  .card-row .k { display:inline-block; min-width:64px; color:var(--muted); font-size:12px;
    text-transform:uppercase; letter-spacing:.03em; }

  .suggested { margin-top:14px; }
  .suggested h5 { margin:0 0 4px; font-size:13px; color:var(--muted);
    text-transform:uppercase; letter-spacing:.03em; }

  .shots h4 { margin:16px 0 8px; font-size:15px; }
  .triptych { display:grid; grid-template-columns:repeat(3,1fr); gap:12px; }
  @media (max-width:720px) { .triptych { grid-template-columns:1fr; } }
  figure.shot { margin:0; border:1px solid var(--border); border-radius:8px; overflow:hidden; background:var(--card); }
  figure.shot img { display:block; width:100%; height:auto; }
  figure.shot figcaption { font-size:12px; color:var(--muted); padding:6px 8px; border-top:1px solid var(--border); }
  figure.shot.empty .noshot { display:flex; align-items:center; justify-content:center;
    min-height:120px; color:var(--muted); font-size:13px; font-style:italic; }
`;

// ---------------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------------

/**
 * Build a complete, self-contained HTML report from AuditResult[] cells.
 * @param {Array<object>} cells   AuditResult[] (see ./util.mjs contract)
 * @param {{title?: string}} opts
 * @returns {string} full HTML document
 */
export function renderHtmlReport(cells: AuditResult[], { title = 'Prerender audit' }: { title?: string } = {}): string {
	const list = Array.isArray(cells) ? cells : [];
	const total = list.length;
	const stabilized = list.filter((c) => c && c.aStabilized).length;

	// Summary matrix (aggregated pageType × device).
	const matrix = total
		? `<div class="matrix-wrap">${summaryMatrix(list)}</div>`
		: '<p class="empty-note">No cells to report.</p>';

	// Per-cell sections, grouped pageType → device (first-seen order within each group).
	const byType = new Map<string, AuditResult[]>();
	for (const c of list) {
		const t = (c && c.pageType) || '(untyped)';
		if (!byType.has(t)) byType.set(t, []);
		(byType.get(t) as AuditResult[]).push(c);
	}
	const groups = [...byType.entries()]
		.map(([type, group]) => {
			const sorted = [...group].sort((a, b) => String(a.device || '').localeCompare(String(b.device || '')));
			return `<h2 class="group">${esc(type)}</h2>\n${sorted.map(renderCell).join('\n')}`;
		})
		.join('\n');

	const head = `<header class="top">
    <h1>${esc(title)}</h1>
    <div class="run-meta">
      <span><b>${total}</b> cell${total === 1 ? '' : 's'}</span>
      <span>A stabilized <b>${stabilized}/${total}</b></span>
    </div>
  </header>`;

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
${head}
<section class="summary"><h2 class="group">Summary</h2>${matrix}</section>
${groups}
</div>
</body>
</html>`;
}
