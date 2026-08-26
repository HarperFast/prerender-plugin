import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { renderOnce } from '../dist/renderOnce.js';

// A shadow root whose CSS is written UNSCOPED — a bare `button` rule and a `:host` rule — which is
// normal inside a shadow boundary and catastrophic once flattened into the light DOM. There is also
// a light-DOM button outside the widget that must keep its own styling.
const SHADOW_FIXTURE = `<!doctype html><html><head><title>shadow</title>
<style>button { color: rgb(0, 0, 255); }</style>
</head><body>
<button id="outside">outside the widget</button>
<div id="widget"></div>
<script>
  const host = document.createElement('div');
  host.id = 'host';
  const sr = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = ':host { display: block; padding: 7px; } button { color: rgb(255, 0, 0); }';
  sr.appendChild(style);
  const b = document.createElement('button');
  b.id = 'inside';
  b.textContent = 'inside the widget';
  sr.appendChild(b);
  document.getElementById('widget').appendChild(host);
</script>
</body></html>`;

// The INBOUND direction: a page-level reset that could never reach shadow content while the
// boundary existed, plus slotted content that the page legitimately styles and must keep styling.
const INBOUND_FIXTURE = `<!doctype html><html><head><title>inbound</title>
<style>
  svg { display: block; }                 /* a Preflight-style reset — the canonical leak */
  .page-tint { color: rgb(0, 128, 0); }   /* page styling for SLOTTED content */
  p { margin-left: 40px; }                /* element-level page rule */
</style>
</head><body>
<div id="widget"><span class="page-tint" id="slotted">slotted text</span></div>
<script>
  const host = document.getElementById('widget');
  const sr = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = 'p { margin-left: 7px; } .inner { letter-spacing: 3px; }';
  sr.appendChild(style);
  sr.innerHTML += '<span id="stars">' +
    '<svg id="s1" width="10" height="10" viewBox="0 0 10 10"><path id="p1" d="M0 0 H10 V10 Z"></path></svg>' +
    '<svg id="s2" width="10" height="10" viewBox="0 0 10 10"><path d="M0 0 H10 V10 Z"></path></svg>' +
    '<svg id="s3" width="10" height="10" viewBox="0 0 10 10"><path d="M0 0 H10 V10 Z"></path></svg></span>' +
    '<p id="para">shadow paragraph</p><div class="inner" id="inner">inner</div><slot></slot>';
</script>
</body></html>`;

const NO_SCROLL = { scroll: { enabled: false } } as const;

let server: http.Server;
let base = '';

before(async () => {
	server = http.createServer((req, res) => {
		res.setHeader('content-type', 'text/html; charset=utf-8');
		res.end(req.url?.startsWith('/inbound') ? INBOUND_FIXTURE : SHADOW_FIXTURE);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
	server?.close();
});

test('flattened shadow CSS stays scoped to its host and does not leak', async () => {
	const r = await renderOnce({
		url: `${base}/`,
		config: { ...NO_SCROLL, postProcess: { flattenShadowDom: true } },
	});

	// The host carries the private scoping token, and the rules are prefixed with it.
	assert.match(r.html, /<div[^>]*\sdata-sh="s\d+"/, 'the host is stamped with the scoping token');
	assert.match(r.html, /\[data-sh=s\d+\] button\s*\{/, 'a bare shadow selector is scoped to the host');
	assert.match(r.html, /\[data-sh=s\d+\]\s*\{/, ':host is retargeted to the host selector');

	// The invariant that matters: re-render the SERIALIZED output and check the two buttons
	// actually compute to different colors. If scoping broke, the widget's red `button` rule
	// would repaint the outside button too.
	const serialized = r.html;
	const replay = http.createServer((_q, res) => {
		res.setHeader('content-type', 'text/html; charset=utf-8');
		res.end(serialized);
	});
	await new Promise<void>((resolve) => replay.listen(0, '127.0.0.1', resolve));
	const replayBase = `http://127.0.0.1:${(replay.address() as AddressInfo).port}`;
	try {
		const check = await renderOnce({
			url: `${replayBase}/`,
			config: NO_SCROLL,
			probes: {
				colors: ({ page }) =>
					page.evaluate(() => ({
						outside: getComputedStyle(document.getElementById('outside')!).color,
						inside: getComputedStyle(document.getElementById('inside')!).color,
						hostPadding: getComputedStyle(document.getElementById('host')!).paddingTop,
					})),
			},
		});
		const colors = check.probes.colors as Record<string, string>;
		assert.equal(colors.inside, 'rgb(255, 0, 0)', "the widget's own button keeps the shadow rule");
		assert.equal(colors.outside, 'rgb(0, 0, 255)', 'the page button must NOT be repainted by leaked shadow CSS');
		assert.equal(colors.hostPadding, '7px', ':host styling survives the flatten');
	} finally {
		replay.close();
	}
});

test('the scoping token is minted per host and is compact', async () => {
	const r = await renderOnce({
		url: `${base}/`,
		config: { ...NO_SCROLL, postProcess: { flattenShadowDom: true } },
	});
	// The token is repeated once per SELECTOR across every flattened root, so its spelling is
	// multiplied by the rule count of the whole page — it is deliberately short, and never quoted.
	assert.ok(!r.html.includes('data-shadow-host'), 'the long legacy spelling must not come back');
	assert.ok(!/\[data-sh="/.test(r.html), 'the selector form stays unquoted');
});

test('page CSS does not reach flattened shadow content, but still styles slotted content', async () => {
	const r = await renderOnce({
		url: `${base}/inbound`,
		config: { ...NO_SCROLL, postProcess: { flattenShadowDom: true } },
	});
	assert.match(
		r.html,
		/\[data-sh=s\d+\] \*:where\(:not\(\[data-sl\],\[data-sl\] \*,svg,svg \*\)\)\{all:revert\}/,
		'the scoped reset is emitted, and excludes SVG subtrees'
	);
	assert.match(
		r.html,
		/\[data-sh=s\d+\] svg:where\(:not\(\[data-sl\] \*\)\)\{display:revert/,
		'…with the svg leak closed by reverting display rather than everything'
	);

	// Re-render the serialized output and check what actually computes.
	const replay = http.createServer((_q, res) => {
		res.setHeader('content-type', 'text/html; charset=utf-8');
		res.end(r.html);
	});
	await new Promise<void>((resolve) => replay.listen(0, '127.0.0.1', resolve));
	try {
		const check = await renderOnce({
			url: `http://127.0.0.1:${(replay.address() as AddressInfo).port}/`,
			config: NO_SCROLL,
			probes: {
				computed: ({ page }) =>
					page.evaluate(() => {
						const cs = (id: string) => getComputedStyle(document.getElementById(id)!);
						const svgs = ['s1', 's2', 's3'].map((id) => document.getElementById(id)!.getBoundingClientRect().top);
						const pathBox = document.getElementById('p1')!.getBoundingClientRect();
						return {
							pathWidth: Math.round(pathBox.width),
							pathHeight: Math.round(pathBox.height),
							svgDisplay: cs('s1').display,
							starsHorizontal: new Set(svgs.map(Math.round)).size === 1,
							paraMargin: cs('para').marginLeft,
							innerSpacing: cs('inner').letterSpacing,
							slottedColor: cs('slotted').color,
						};
					}),
			},
		});
		const c = check.probes.computed as Record<string, unknown>;

		// 1. The page's `svg{display:block}` must NOT reach the flattened widget.
		assert.equal(c.svgDisplay, 'inline', "the page's svg reset must not reach flattened content");
		assert.equal(c.starsHorizontal, true, 'the three svgs stay on one line');

		// 2. SVG GEOMETRY must survive. `d` is a CSS property in Chrome and a presentation attribute
		// supplies it from the author origin, so a blanket `all: revert` throws it away and every
		// flattened path collapses to zero size — which is what shipped in v1.19.0.
		assert.ok((c.pathWidth as number) > 0, 'the path keeps its width — `d` must survive the reset');
		assert.ok((c.pathHeight as number) > 0, 'the path keeps its height — `d` must survive the reset');

		// 3. The shadow root's OWN rules must still beat the reset — both element and class form.
		assert.equal(c.paraMargin, '7px', "the shadow's own `p` rule must beat both the page rule and the reset");
		assert.equal(c.innerSpacing, '3px', "the shadow's own class rule must survive the reset");

		// 4. Slotted content was always light DOM — the page must still style it.
		assert.equal(c.slottedColor, 'rgb(0, 128, 0)', 'slotted content keeps its page styling');
	} finally {
		replay.close();
	}
});
