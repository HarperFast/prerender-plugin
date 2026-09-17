import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { paintParity, diffPaint, paintParityVerdict } from '../dist/audit/paintParity.js';
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

// A reveal-on-hydrate widget: the server ships it COLLAPSED and a script flips it to revealed. This
// is the shape that shipped a whole reviews section invisible — the snapshot caught the wrapper
// before the flip, scripts were stripped, and it stayed collapsed forever. `hideWith` picks which
// mechanism collapses it, because the two halves behave completely differently under measurement:
// `display:none` zeroes the descendants' boxes (the old own-style check caught it), while
// `opacity:0` leaves every descendant computing `opacity: 1` at full size (it did not).
const revealFixture = (hideWith: 'opacity' | 'display' | 'clip', hydrated: boolean) => `<!doctype html>
<html><head><title>reveal</title><style>
  #wrap.collapsed-opacity { max-height: 0; opacity: 0; }
  #wrap.collapsed-display { display: none; }
  #wrap.collapsed-clip    { max-height: 0; overflow: hidden; }
  #wrap.revealed { opacity: 1; }
  /* A normal-sized clipping container with content scrolled out of view — the carousel shape that
     must NOT be mistaken for a collapsed wrapper. */
  #carousel { width: 40px; height: 20px; overflow: hidden; }
  #carousel .slide { width: 400px; }
</style></head><body>
<p id="always">always visible text</p>
<div id="carousel"><div class="slide">offscreen carousel slide</div></div>
<div id="wrap" class="collapsed-${hideWith}">
  <p id="review">five stars would buy again</p>
</div>
${hydrated ? `<script>document.getElementById('wrap').className = 'revealed';</script>` : ''}
</body></html>`;

let server: http.Server;
let base = '';
/** Same-origin stylesheet the served bytes reference; the server 404s it when this is true. */
let breakStylesheet = false;

before(async () => {
	server = http.createServer((req, res) => {
		const path = (req.url ?? '/').split('?')[0];
		if (path === '/site.css') {
			if (breakStylesheet) {
				res.statusCode = 404;
				return res.end('not found');
			}
			res.setHeader('content-type', 'text/css');
			return res.end('#review { color: rgb(0, 0, 0); }');
		}
		res.setHeader('content-type', 'text/html; charset=utf-8');
		// `/reveal-<mechanism>` serves the ORIGIN page: collapsed markup plus the hydration script.
		const m = /^\/reveal-(opacity|display|clip)$/.exec(path);
		if (m) return res.end(revealFixture(m[1] as 'opacity' | 'display' | 'clip', true));
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

// ── the reveal-race regression: content present in the DOM, invisible on screen ────────────────

// The snapshot half: the same markup the origin ships, with the hydration script stripped, so the
// wrapper stays in whatever pre-reveal state it was serialized in. Passing it as `html` skips the
// candidate render, which is what makes this test hermetic and fast.
const collapsedSnapshot = (hideWith: 'opacity' | 'display' | 'clip') => revealFixture(hideWith, false);

for (const hideWith of ['opacity', 'display', 'clip'] as const) {
	test(`a subtree hidden by ${hideWith} is LOST INK, not a clean pass`, async () => {
		const report = await paintParity({
			url: `${base}/reveal-${hideWith}`,
			base: { scroll: { enabled: false } },
			html: collapsedSnapshot(hideWith),
			sweepDeadlineMs: 3000,
		});
		const lostText = report.lost.filter((l) => l.kind === 'txt').map((l) => l.key);
		assert.ok(
			lostText.includes('txt:five stars would buy again'),
			`the hidden review text must be reported lost, got ${JSON.stringify(report.lost)}`
		);
		assert.equal(paintParityVerdict(report), 'lost-ink', 'the run must report lost ink');
	});
}

test('content merely scrolled out of a normal-sized clipping container is not a finding', async () => {
	// Identical on both sides, so the ONLY way this appears in `lost` is the clip test over-reaching
	// from collapsed wrappers to every carousel on the page.
	const report = await paintParity({
		url: `${base}/reveal-opacity`,
		base: { scroll: { enabled: false } },
		html: collapsedSnapshot('opacity'),
		sweepDeadlineMs: 3000,
	});
	assert.ok(
		!report.lost.some((l) => l.key === 'txt:offscreen carousel slide'),
		'an off-screen carousel slide is ordinary content, not lost ink'
	);
	assert.ok(
		!report.lost.some((l) => l.key === 'txt:always visible text'),
		'content visible on both sides must never be reported lost'
	);
});

test('a same-origin stylesheet that fails to load invalidates the run instead of passing it', async () => {
	// Served bytes that reference the site's own CSS. With the stylesheet 404ing, nothing hides
	// anything, so the naive verdict is a clean pass — which is exactly the trap.
	const withCss = collapsedSnapshot('opacity').replace('</head>', '<link rel="stylesheet" href="/site.css"></head>');
	breakStylesheet = true;
	try {
		const report = await paintParity({
			url: `${base}/reveal-opacity`,
			base: { scroll: { enabled: false } },
			html: withCss,
			sweepDeadlineMs: 3000,
		});
		assert.equal(
			report.stylesheetFailures.length,
			1,
			'the dead same-origin stylesheet must be reported: ' + JSON.stringify(report.stylesheetFailures)
		);
		assert.match(report.stylesheetFailures[0].reason, /404/);
		assert.equal(report.stylesheetFailures[0].type, 'stylesheet');
		assert.equal(
			paintParityVerdict(report),
			'invalid',
			'a run that lost its own CSS is neither a pass nor a content finding'
		);
	} finally {
		breakStylesheet = false;
	}
});
