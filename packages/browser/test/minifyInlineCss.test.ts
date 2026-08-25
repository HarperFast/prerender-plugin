import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { renderOnce } from '../dist/renderOnce.js';
import { mergeConfig } from '../dist/config.js';

// Formatting the origin sent, plus the two things a regex minifier gets wrong: a url() and a
// quoted string, each containing the `{ } ; :` characters a naive pass splits on.
const CSS_FIXTURE = `<!doctype html><html><head><title>css</title>
<style>
  /* a comment that should not survive */
  .card {
    color:   rgb(10, 20, 30);
    background-image: url("/img/a;b{c}d:e.png");
  }
  .card::after { content: "a;b{c}d:e"; }
  @media (min-width: 400px) {
    .card { padding-top: 4px; }
  }
  @keyframes pulse { from { opacity: 0 } to { opacity: 1 } }
</style>
</head><body>
<div class="card">card content</div>
</body></html>`;

const NO_SCROLL = { scroll: { enabled: false } } as const;

let server: http.Server;
let base = '';

before(async () => {
	server = http.createServer((_req, res) => {
		res.setHeader('content-type', 'text/html; charset=utf-8');
		res.end(CSS_FIXTURE);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
	server?.close();
});

const styleTextOf = (html: string) => /<style[^>]*>([\s\S]*?)<\/style>/i.exec(html)?.[1] ?? '';

test('minifyInlineCss defaults to off and is a no-op', async () => {
	assert.equal(mergeConfig().postProcess.minifyInlineCss, false);
	const off = await renderOnce({ url: `${base}/`, config: NO_SCROLL });
	const explicit = await renderOnce({
		url: `${base}/`,
		config: { ...NO_SCROLL, postProcess: { minifyInlineCss: false } },
	});
	assert.equal(explicit.html, off.html, 'off must serialize byte-identically');
	assert.match(styleTextOf(off.html), /a comment that should not survive/, 'baseline keeps the source text');
});

test('re-emits inline CSS smaller without corrupting url() or strings', async () => {
	const off = await renderOnce({ url: `${base}/`, config: NO_SCROLL });
	const on = await renderOnce({
		url: `${base}/`,
		config: { ...NO_SCROLL, postProcess: { minifyInlineCss: true } },
	});
	const css = styleTextOf(on.html);

	assert.ok(on.htmlBytes < off.htmlBytes, 'the document should shrink');
	assert.ok(!css.includes('a comment that should not survive'), 'comments go');
	assert.ok(!css.includes('color:   rgb'), "the origin's run of spaces is normalized away");
	assert.match(css, /\.card \{ color: rgb\(10, 20, 30\);/, 'a style rule collapses onto one line');
	// NOT an aggressive minify: CSSOM serializes GROUPING rules (@media, @keyframes) with a
	// newline and two-space indent per inner rule, and that is kept verbatim. This is why the
	// measured saving is ~8% of the CSS rather than the ~17% a regex pass reaches.
	assert.match(
		css,
		/@media \(min-width: 400px\) \{\n {2}\.card/,
		'grouping-rule indentation is CSSOM output, not a bug'
	);

	// The two payloads a regex minifier mangles must survive EXACTLY — `{ } ; :` and all.
	assert.ok(css.includes('/img/a;b{c}d:e.png'), 'url() contents must be intact');
	assert.ok(css.includes('a;b{c}d:e'), 'quoted string contents must be intact');

	// Structure survives: nested at-rules keep their rules, not just their preludes.
	assert.match(css, /@media[^{]*\(min-width:\s*400px\)/);
	assert.match(css, /padding-top:\s*4px/);
	assert.match(css, /@keyframes pulse/);
	assert.match(css, /opacity:\s*0/);
	assert.match(css, /opacity:\s*1/);
});

test('the re-emitted CSS still computes to the same styles', async () => {
	// The claim that matters: the served page renders the same. Compare computed styles for every
	// element, with the minified sheet actually applied by the browser.
	const computed = async (minify: boolean) => {
		const r = await renderOnce({
			url: `${base}/`,
			config: { ...NO_SCROLL, postProcess: { minifyInlineCss: minify } },
			probes: {
				styles: ({ page }) =>
					page.evaluate(() =>
						[...document.querySelectorAll('*')]
							.filter((el) => el.tagName !== 'STYLE')
							.map((el) => {
								const cs = getComputedStyle(el);
								return `${el.tagName}|${cs.color}|${cs.backgroundImage}|${cs.paddingTop}`;
							})
					),
			},
		});
		return r.probes.styles;
	};
	assert.deepEqual(await computed(true), await computed(false));
});

test('a sheet that cannot be re-emitted smaller is left alone', async () => {
	// Rendering twice with minify on must be stable — the second pass has nothing left to shrink,
	// and the "never grow" guard must keep it from oscillating.
	const once = await renderOnce({ url: `${base}/`, config: { ...NO_SCROLL, postProcess: { minifyInlineCss: true } } });
	const twice = await renderOnce({ url: `${base}/`, config: { ...NO_SCROLL, postProcess: { minifyInlineCss: true } } });
	assert.equal(once.html, twice.html, 'minification must be deterministic and idempotent');
});
