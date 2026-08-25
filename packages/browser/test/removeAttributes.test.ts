import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { renderOnce } from '../dist/renderOnce.js';
import { mergeConfig } from '../dist/config.js';

// A hydration-island shape in miniature: a custom element whose attributes carry the client
// runtime's rehydration payload, WRAPPING the server-rendered content. The content inside is
// what the snapshot exists for, so the test's real job is to prove the wrapper's attributes go
// and everything it contains stays.
const ISLAND_FIXTURE = `<!doctype html><html><head><title>island</title>
<link rel="canonical" href="https://example.com/p/1">
<script type="application/ld+json">{"@type":"Product","name":"Test Product"}</script>
</head><body>
<x-island uid="a1" props="{&quot;sku&quot;:&quot;123&quot;,&quot;price&quot;:[0,19.99]}"
          component-url="/_astro/index.js" data-aue-prop="title" data-aue-label="Title"
          data-keep="yes" class="island" id="main-island">
  <h1 class="title">Test Product</h1>
  <p>A description that must survive.</p>
  <a href="/related/1">Related item</a>
  <img src="/img/1.jpg" alt="Test Product">
</x-island>
<div data-aue-type="component" data-keep="yes">outside the island</div>
<script>window.__hydrate = true;</script>
</body></html>`;

const NO_SCROLL = { scroll: { enabled: false } } as const;

let server: http.Server;
let base = '';

before(async () => {
	server = http.createServer((_req, res) => {
		res.setHeader('content-type', 'text/html; charset=utf-8');
		res.end(ISLAND_FIXTURE);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
	server?.close();
});

test('removeAttributes defaults to a no-op', async () => {
	const before = await renderOnce({ url: `${base}/`, config: NO_SCROLL });
	const after = await renderOnce({
		url: `${base}/`,
		config: { ...NO_SCROLL, postProcess: { removeAttributes: [] } },
	});
	assert.equal(after.html, before.html, 'an empty rule list must serialize byte-identically');
	assert.match(before.html, /props=/, 'baseline still carries the hydration payload');
});

test('strips named and prefix-matched attributes without losing content', async () => {
	const baseline = await renderOnce({ url: `${base}/`, config: NO_SCROLL });
	const result = await renderOnce({
		url: `${base}/`,
		config: {
			...NO_SCROLL,
			postProcess: {
				removeAttributes: [
					{ selector: 'x-island', attributes: ['props', 'uid', 'component-url'] },
					{ selector: '*', attributes: ['data-aue-*'] },
				],
			},
		},
	});
	const html = result.html;

	// The dead attributes are gone — everywhere, not just on the island.
	for (const gone of ['props=', 'uid=', 'component-url=', 'data-aue-prop', 'data-aue-label', 'data-aue-type']) {
		assert.ok(!html.includes(gone), `${gone} should have been stripped`);
	}

	// NOTHING else moved. Content, structure, and the attributes that carry meaning all stay.
	for (const kept of [
		'<h1 class="title">Test Product</h1>',
		'A description that must survive.',
		'href="/related/1"',
		'src="/img/1.jpg"',
		'alt="Test Product"',
		'class="island"',
		'id="main-island"',
		'data-keep="yes"',
		'rel="canonical"',
		'"@type":"Product"',
		'outside the island',
	]) {
		assert.ok(html.includes(kept), `${kept} must survive`);
	}
	// The island element itself survives — only its attributes were the target.
	assert.match(html, /<x-island[^>]*>/);
	assert.equal((html.match(/<x-island/g) ?? []).length, 1);

	// Same visible text as the untouched render: an attribute strip must not change what a
	// crawler reads. (Tags out, whitespace collapsed — compares text content, not markup.)
	const textOf = (h: string) =>
		h
			.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
			.replace(/<[^>]+>/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
	assert.equal(textOf(html), textOf(baseline.html));
	assert.ok(result.htmlBytes < baseline.htmlBytes, 'the strip should shrink the document');
});

test('exact names and prefixes in one rule remove exactly the same set', async () => {
	// The loop now handles exact names without reading the element's attribute list, and prefixes
	// with it. Splitting those paths must not change WHAT is removed — only how it is found.
	const oneRule = await renderOnce({
		url: `${base}/`,
		config: {
			...NO_SCROLL,
			postProcess: { removeAttributes: [{ selector: '*', attributes: ['uid', 'props', 'data-aue-*'] }] },
		},
	});
	const twoRules = await renderOnce({
		url: `${base}/`,
		config: {
			...NO_SCROLL,
			postProcess: {
				removeAttributes: [
					{ selector: '*', attributes: ['uid', 'props'] },
					{ selector: '*', attributes: ['data-aue-*'] },
				],
			},
		},
	});
	assert.equal(oneRule.html, twoRules.html, 'a mixed rule must equal the same rules split apart');
	for (const gone of ['uid=', 'props=', 'data-aue-prop', 'data-aue-label']) {
		assert.ok(!oneRule.html.includes(gone), `${gone} should be gone`);
	}
	assert.ok(oneRule.html.includes('data-keep="yes"'), 'unrelated data-* attributes stay');
	assert.ok(oneRule.html.includes('component-url='), 'unnamed attributes stay');
});

test('camelCase attributes are removed from SVG, where names are case-sensitive', async () => {
	// `removeAttribute` lowercases only for HTML-namespace elements. On SVG, `viewBox` and
	// `viewbox` are different names — so a fast path that asks for the lowercased spelling
	// silently leaves the attribute in place. Both spellings in config must work, on both
	// namespaces, because the rule documents case-insensitive matching.
	const svgServer = http.createServer((_q, res) => {
		res.setHeader('content-type', 'text/html; charset=utf-8');
		res.end(
			`<!doctype html><html><head><title>svg</title></head><body>` +
				`<svg id="chart" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid" width="50" height="50" data-keep="y">` +
				`<path d="M0 0 L10 10"></path></svg>` +
				`<div id="html" viewBox="not-really" data-keep="y">html</div></body></html>`
		);
	});
	await new Promise<void>((resolve) => svgServer.listen(0, '127.0.0.1', resolve));
	const svgBase = `http://127.0.0.1:${(svgServer.address() as AddressInfo).port}`;
	try {
		for (const attributes of [
			['viewBox', 'preserveAspectRatio'],
			['viewbox', 'preserveaspectratio'],
		]) {
			const r = await renderOnce({
				url: `${svgBase}/`,
				config: { ...NO_SCROLL, postProcess: { removeAttributes: [{ selector: '*', attributes }] } },
			});
			const svg = /<svg[^>]*>/.exec(r.html)![0];
			assert.ok(!/viewBox/i.test(svg), `viewBox must go from SVG (configured as ${attributes[0]})`);
			assert.ok(!/preserveAspectRatio/i.test(svg), `preserveAspectRatio must go (configured as ${attributes[0]})`);
			assert.match(svg, /width="50"/, 'unnamed SVG attributes stay');
			assert.match(svg, /data-keep="y"/, 'unnamed SVG attributes stay');
			assert.ok(!/viewBox/i.test(/<div[^>]*>/.exec(r.html)![0]), 'and the HTML element loses its too');
		}
	} finally {
		svgServer.close();
	}
});

test('a bare "*" attribute entry is ignored rather than stripping everything', async () => {
	const result = await renderOnce({
		url: `${base}/`,
		config: { ...NO_SCROLL, postProcess: { removeAttributes: [{ selector: 'x-island', attributes: ['*'] }] } },
	});
	assert.ok(result.html.includes('class="island"'), 'a bare * must not strip class');
	assert.ok(result.html.includes('props='), 'a bare * must not strip anything at all');
});

test('a malformed selector skips its rule instead of failing the render', async () => {
	const result = await renderOnce({
		url: `${base}/`,
		config: {
			...NO_SCROLL,
			postProcess: {
				removeAttributes: [
					{ selector: 'x-island::[[bad', attributes: ['props'] },
					{ selector: 'x-island', attributes: ['uid'] },
				],
			},
		},
	});
	assert.equal(result.outcome, 'ok');
	assert.ok(result.html.includes('props='), 'the bad rule is skipped, so props stays');
	assert.ok(!result.html.includes('uid='), 'the following good rule still applies');
});

test('config validation rejects malformed removeAttributes rules', () => {
	assert.deepEqual(mergeConfig().postProcess.removeAttributes, []);
	assert.throws(
		() => mergeConfig({ postProcess: { removeAttributes: [{ selector: '', attributes: ['props'] }] } }),
		/removeAttributes\[0\]\.selector must be a non-empty string/
	);
	assert.throws(
		() => mergeConfig({ postProcess: { removeAttributes: [{ selector: 'x-island', attributes: [] }] } }),
		/removeAttributes\[0\]\.attributes must be a non-empty array/
	);
	assert.throws(
		() => mergeConfig({ postProcess: { removeAttributes: [{ selector: 'x-island', attributes: [''] }] } }),
		/removeAttributes\[0\]\.attributes must be a non-empty array/
	);
	// A bare string where a list belongs is the likeliest hand-authored mistake, and it is caught
	// HERE — which is why the in-page loop's matching guard is defence in depth, not the real check.
	assert.throws(
		() => mergeConfig({ postProcess: { removeAttributes: [{ selector: 'x-island', attributes: 'props' }] } } as never),
		/removeAttributes\[0\]\.attributes must be a non-empty array/
	);
	assert.throws(
		() => mergeConfig({ postProcess: { removeAttributes: 'nope' } } as never),
		/removeAttributes must be an array of rules/
	);
});

// `deepMerge` REPLACES a non-plain-object rather than merging into it, so a JSON config can null a
// whole block out and it reaches validate() intact. That must read as a config error, not as a
// TypeError from whichever check touched the block first.
test('a nulled-out config block is a named error, not a TypeError', () => {
	for (const name of ['devices', 'navigation', 'scroll', 'block', 'postProcess', 'canonical']) {
		assert.throws(
			() => mergeConfig({ [name]: null } as never),
			new RegExp(`prerender config: \`${name}\` must be an object`),
			`${name}: null should be a named config error`
		);
		assert.throws(() => mergeConfig({ [name]: [] } as never), new RegExp(`\`${name}\` must be an object`));
	}
});
