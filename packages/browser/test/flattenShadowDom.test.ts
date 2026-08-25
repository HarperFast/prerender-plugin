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

const NO_SCROLL = { scroll: { enabled: false } } as const;

let server: http.Server;
let base = '';

before(async () => {
	server = http.createServer((_req, res) => {
		res.setHeader('content-type', 'text/html; charset=utf-8');
		res.end(SHADOW_FIXTURE);
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
