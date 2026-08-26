import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { paintParity, diffPaint } from '../dist/audit/paintParity.js';
import type { PaintItem } from '../dist/audit/paintParity.js';

// A shadow widget whose SVG carries its geometry in a `d` PRESENTATION ATTRIBUTE — the exact shape
// a blanket `all: revert` destroys, because `d` is a CSS property in Chrome fed from the author
// origin. The page also ships the Preflight-style `svg{display:block}` reset the flatten has to
// keep out, so both halves of the fix are exercised at once.
const FIXTURE = `<!doctype html><html><head><title>paint</title>
<style>svg { display: block; }</style>
</head><body>
<div id="widget"></div>
<p id="page-text">page text</p>
<script>
  const host = document.getElementById('widget');
  const sr = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = '.mark { fill: rgb(200, 0, 0); }';
  sr.appendChild(style);
  sr.innerHTML += '<span id="stars">' +
    '<svg width="12" height="12" viewBox="0 0 12 12"><path class="mark" d="M0 0 H12 V12 Z"></path></svg>' +
    '<svg width="12" height="12" viewBox="0 0 12 12"><path class="mark" d="M1 1 H11 V11 Z"></path></svg>' +
    '</span><span id="label">shadow label</span>';
</script>
</body></html>`;

let server: http.Server;
let base = '';

before(async () => {
	server = http.createServer((_req, res) => {
		res.setHeader('content-type', 'text/html; charset=utf-8');
		res.end(FIXTURE);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
	server?.close();
});

test('diffPaint reports lost ink, and never fails a key only one side has', () => {
	const origin: PaintItem[] = [
		{ key: 'geo:M0 0 H12 V12 Z', width: 12, height: 12, area: 144 },
		{ key: 'txt:kept', width: 40, height: 10, area: 400 },
		{ key: 'txt:origin only', width: 30, height: 10, area: 300 },
		{ key: 'geo:hairline', width: 10, height: 0.2, area: 2 },
	];
	const served: PaintItem[] = [
		{ key: 'geo:M0 0 H12 V12 Z', width: 0, height: 0, area: 0 }, // present, but paints nothing
		{ key: 'txt:kept', width: 40, height: 10, area: 400 },
		{ key: 'txt:served only', width: 30, height: 10, area: 300 },
		{ key: 'geo:hairline', width: 0, height: 0, area: 0 }, // below minArea at origin — not a finding
	];
	const r = diffPaint(origin, served);
	assert.equal(r.lost.length, 1, 'only the mark that painted at origin and vanished counts');
	assert.equal(r.lost[0].key, 'geo:M0 0 H12 V12 Z');
	assert.equal(r.lost[0].kind, 'geo');
	assert.deepEqual(r.lostByKind, { geo: 1 });
	assert.equal(r.shared, 3, 'shared keys are the only ones that can produce a verdict');
	assert.equal(r.originOnly, 1, 'content drift is counted, not failed');
	assert.equal(r.servedOnly, 1);
});

test('a mark that stops painting is caught even though the DOM is intact', async () => {
	// The honest end-to-end: flatten the widget (which is what perturbs the SVG) and confirm no ink
	// is lost relative to the un-prerendered page.
	const report = await paintParity({
		url: `${base}/`,
		base: { scroll: { enabled: false }, postProcess: { flattenShadowDom: true, stripScripts: true } },
		sweepDeadlineMs: 3000,
	});
	assert.ok(report.shared > 0, 'the two sides must share paint keys, or the audit proves nothing');
	assert.deepEqual(report.lost, [], 'flattening must not cost a single mark');
	// The SVG geometry specifically survived: its key is present and painting on both sides.
	assert.equal(report.lostByKind.geo, undefined, 'no SVG geometry lost');
});
