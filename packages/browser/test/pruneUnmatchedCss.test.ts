import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { renderOnce } from '../dist/renderOnce.js';
import { mergeConfig } from '../dist/config.js';

// One element on the page (`.present`), and a spread of rules that must be judged against it.
// The `.absent*` rules are the ones that should go; everything else states a way the probe is
// required to fail safe and KEEP a rule.
const CSS_FIXTURE = `<!doctype html><html><head><title>prune</title>
<style>
  .present { color: rgb(1, 2, 3); }
  .absent-plain { color: rgb(9, 9, 9); }
  .absent-a, .absent-b { color: rgb(8, 8, 8); }
  .present:hover { color: rgb(4, 5, 6); }
  .absent-hover:hover { color: rgb(7, 7, 7); }
  .present::after { content: "x"; }
  ::selection { color: rgb(2, 2, 2); }
  [data-note="absent{;}:v"] { color: rgb(6, 6, 6); }
  li:not(.absent-x) { color: rgb(3, 3, 3); }
  .absent-list, .present { outline-color: rgb(5, 5, 5); }
  @media (min-width: 1px) { .present { padding-top: 4px; } .absent-media { padding-top: 9px; } }
  @media (min-width: 2px) { .absent-only { padding-top: 8px; } }
  @keyframes pulse { from { opacity: 0 } to { opacity: 1 } }
  .present { animation: pulse 1s paused; } /* paused: a running animation makes computed opacity time-dependent */
  @font-face { font-family: nope; src: url("/nope.woff2"); }
</style>
</head><body>
<div class="present">kept</div>
<ul><li>list item</li></ul>
</body></html>`;

const NO_SCROLL = { scroll: { enabled: false } } as const;
const PRUNE = { ...NO_SCROLL, postProcess: { pruneUnmatchedCss: true } } as const;

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

test('pruneUnmatchedCss defaults to off and is a no-op', async () => {
	assert.equal(mergeConfig().postProcess.pruneUnmatchedCss, false);
	const off = await renderOnce({ url: `${base}/`, config: NO_SCROLL });
	const explicit = await renderOnce({
		url: `${base}/`,
		config: { ...NO_SCROLL, postProcess: { pruneUnmatchedCss: false } },
	});
	assert.equal(explicit.html, off.html, 'off must serialize byte-identically');
	assert.match(styleTextOf(off.html), /absent-plain/, 'baseline keeps the unmatched rules');
});

test('it requires stripScripts, because that is what freezes the DOM', () => {
	assert.throws(
		() => mergeConfig({ postProcess: { pruneUnmatchedCss: true, stripScripts: false } }),
		/pruneUnmatchedCss requires postProcess\.stripScripts/
	);
	// The supported combination validates.
	mergeConfig({ postProcess: { pruneUnmatchedCss: true } });
});

test('drops only the rules that can never match', async () => {
	const off = await renderOnce({ url: `${base}/`, config: NO_SCROLL });
	const on = await renderOnce({ url: `${base}/`, config: PRUNE });
	const css = styleTextOf(on.html);

	assert.ok(on.htmlBytes < off.htmlBytes, 'the document should shrink');

	// Gone: nothing on this page can ever match these.
	assert.ok(!css.includes('absent-plain'), 'a plain unmatched selector goes');
	assert.ok(!css.includes('absent-a'), 'a selector list with no matching part goes');
	assert.ok(!css.includes('absent-hover'), 'an unmatched base with a state pseudo goes');
	assert.ok(!css.includes('absent-media'), 'an unmatched rule inside @media goes');
	assert.ok(!css.includes('absent-only'), 'the last rule in an @media goes');

	// Kept: each of these is a distinct way the probe must fail safe.
	assert.match(css, /\.present \{/, 'a matching rule stays');
	assert.match(css, /\.present:hover/, 'state pseudo-classes are stripped before probing, not judged');
	assert.match(css, /\.present::after/, 'a pseudo-element on a matching base stays');
	assert.match(css, /::selection/, 'a selector that is ONLY a pseudo-element is kept untested');
	assert.match(css, /data-note/, 'a quoted attribute value is never rewritten, so it is kept');
	assert.match(css, /li:not\(\.absent-x\)/, 'a matching base with :not() stays');
	assert.match(css, /absent-list/, 'a selector list keeps ALL parts when any one part matches');

	// At-rules the prune must not touch.
	assert.match(css, /@keyframes pulse/, '@keyframes survives');
	assert.match(css, /opacity: 0/, "…and so do its keyframes' declarations");
	assert.match(css, /@font-face/, '@font-face survives');
	assert.match(css, /@media \(min-width: 2px\)/, 'an emptied @media keeps its position in the cascade');
});

test('the pruned CSS still computes to the same styles', async () => {
	// The claim that matters: the served page renders the same. A rule that matched nothing
	// contributed nothing, so every computed value must be identical with it gone.
	const computed = async (prune: boolean) => {
		const r = await renderOnce({
			url: `${base}/`,
			config: { ...NO_SCROLL, postProcess: { pruneUnmatchedCss: prune } },
			probes: {
				styles: ({ page }) =>
					page.evaluate(() =>
						[...document.querySelectorAll('*')]
							.filter((el) => el.tagName !== 'STYLE')
							.map((el) => {
								const cs = getComputedStyle(el);
								let all = `${el.tagName}|`;
								for (let i = 0; i < cs.length; i++) all += `${cs[i]}:${cs.getPropertyValue(cs[i])};`;
								const r = el.getBoundingClientRect();
								return `${all}|${r.x},${r.y},${r.width},${r.height}|${getComputedStyle(el, '::after').content}`;
							})
					),
			},
		});
		return r.probes.styles;
	};
	assert.deepEqual(await computed(true), await computed(false));
});

test('pruning is deterministic and idempotent', async () => {
	const once = await renderOnce({ url: `${base}/`, config: PRUNE });
	const twice = await renderOnce({ url: `${base}/`, config: PRUNE });
	assert.equal(once.html, twice.html, 'a second pass has nothing left to drop');
});
