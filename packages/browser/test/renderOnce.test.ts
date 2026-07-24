import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { renderOnce, renderMatrix, selectorCountProbe, htmlContainsProbe } from '../dist/renderOnce.js';
import { resolveSettings, applySettings } from '../dist/settings.js';

// A page whose review widget lazy-loads via IntersectionObserver into SHADOW DOM once its container
// enters the viewport. The container sits below a 2000px spacer: within the tall desktop viewport
// (height 5000) at load, but below the fold on the short mobile viewport (height 844). This is the
// mobile-reviews-missing shape in miniature — and the shadow DOM exercises the shadow-aware walks.
const LAZY_FIXTURE = `<!doctype html><html><head><title>fixture</title></head><body>
<div style="height:2000px">spacer</div>
<div id="reviews"></div>
<script>
  const target = document.getElementById('reviews');
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const host = document.createElement('div');
      host.className = 'review-host';
      const sr = host.attachShadow({ mode: 'open' });
      for (let i = 0; i < 5; i++) {
        const r = document.createElement('div');
        r.className = 'rev-item';
        r.textContent = 'Verified Buyer review ' + i;
        sr.appendChild(r);
      }
      target.appendChild(host);
      io.disconnect();
    }
  });
  io.observe(target);
</script>
</body></html>`;

const NOINDEX_FIXTURE = `<!doctype html><html><head><title>noindex</title>
<meta name="robots" content="noindex"></head><body><h1>secret</h1><p>not for the index</p></body></html>`;

// Scroll disabled so the ONLY thing that brings the widget into view is the viewport height (or a
// waitFor rule) — isolates the mechanism from the settle-scroll, making the assertions deterministic.
const NO_SCROLL = { scroll: { enabled: false } } as const;

let server: http.Server;
let base = '';

before(async () => {
	server = http.createServer((req, res) => {
		res.setHeader('content-type', 'text/html; charset=utf-8');
		res.end(req.url?.startsWith('/noindex') ? NOINDEX_FIXTURE : LAZY_FIXTURE);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
	server?.close();
});

test('resolveSettings allows a missing harper block; applySettings still requires it', () => {
	assert.throws(() => applySettings({} as never), /harper/);
	assert.doesNotThrow(() => resolveSettings({}, { requireHarper: false }));
});

test('renders off-queue with populated signals + timings and no harper connection', async () => {
	const r = await renderOnce({ url: base, device: 'desktop', config: NO_SCROLL });
	assert.equal(r.outcome, 'ok');
	assert.equal(r.statusCode, 200);
	assert.equal(r.isIndexable, true);
	assert.ok(r.html && r.html.includes('<html'), 'html serialized');
	assert.ok(r.htmlBytes > 0);
	assert.equal(typeof r.timings.navTotal, 'number');
	assert.equal(typeof r.renderTimeMs, 'number');
	assert.equal(r.error, undefined);
});

test('selectorCountProbe finds the lazy shadow-DOM widget on the tall viewport, not the short one', async () => {
	const results = await renderMatrix(base, ['desktop', 'mobile'], {
		config: NO_SCROLL,
		probes: { rev: selectorCountProbe(['.rev-item']) },
	});
	const byDevice = Object.fromEntries(results.map((r) => [r.device, r]));
	assert.equal((byDevice.desktop.probes.rev as Record<string, number>)['.rev-item'], 5, 'desktop: reviews loaded');
	assert.equal((byDevice.mobile.probes.rev as Record<string, number>)['.rev-item'], 0, 'mobile: below the fold');
});

test('a config.waitFor rule makes the below-the-fold widget appear on the short viewport', async () => {
	const r = await renderOnce({
		url: base,
		device: 'mobile',
		config: {
			...NO_SCROLL,
			waitFor: [{ selector: '#reviews', waitForSelector: '.rev-item', minCount: 1 }],
		},
		probes: { rev: selectorCountProbe(['.rev-item']) },
	});
	assert.equal((r.probes.rev as Record<string, number>)['.rev-item'], 5, 'waitFor scrolled it into view');
});

test('selector count (live DOM, shadow-aware) vs html substring (serialized) separate load from serialization', async () => {
	// flattenShadowDom OFF (default): the widget is in the live DOM (selector count = 5) but its
	// shadow content is NOT in the serialized HTML (substring count = 0).
	const off = await renderOnce({
		url: base,
		device: 'desktop',
		config: NO_SCROLL,
		probes: { sel: selectorCountProbe(['.rev-item']), html: htmlContainsProbe(['Verified Buyer']) },
	});
	assert.equal((off.probes.sel as Record<string, number>)['.rev-item'], 5);
	assert.equal(
		(off.probes.html as Record<string, number>)['Verified Buyer'],
		0,
		'shadow not serialized when flatten off'
	);

	// flattenShadowDom ON: the review text now survives into the serialized HTML.
	const on = await renderOnce({
		url: base,
		device: 'desktop',
		config: { ...NO_SCROLL, postProcess: { flattenShadowDom: true } },
		probes: { html: htmlContainsProbe(['Verified Buyer']) },
	});
	assert.ok((on.probes.html as Record<string, number>)['Verified Buyer'] >= 5, 'flattened shadow serialized');
});

test('a malformed waitFor selector times out best-effort instead of aborting the render', async () => {
	const r = await renderOnce({
		url: base,
		device: 'desktop',
		config: {
			...NO_SCROLL,
			waitFor: [{ selector: ':::not-a-selector:::', waitForSelector: ':::bad:::', minCount: 1, timeoutMs: 500 }],
		},
	});
	assert.equal(r.outcome, 'ok');
	assert.ok(r.html && r.html.includes('<html'), 'render completed despite a bad waitFor selector');
});

test('waitFor device scoping: a rule only runs for its listed devices', async () => {
	const rule = (devices: string[]) => ({
		selector: '#reviews',
		waitForSelector: '.rev-item',
		minCount: 1,
		timeoutMs: 3000,
		devices,
	});
	const count = async (devices: string[]) => {
		const r = await renderOnce({
			url: base,
			device: 'mobile',
			config: { ...NO_SCROLL, waitFor: [rule(devices)] },
			probes: { rev: selectorCountProbe(['.rev-item']) },
		});
		return (r.probes.rev as Record<string, number>)['.rev-item'];
	};
	assert.equal(await count(['desktop']), 0, 'desktop-scoped rule is skipped on mobile');
	assert.equal(await count(['mobile']), 5, 'mobile-scoped rule runs on mobile');
});

test('waitFor path scoping: a rule only runs when the URL path matches pathPattern', async () => {
	const rule = (pathPattern: string) => ({
		selector: '#reviews',
		waitForSelector: '.rev-item',
		minCount: 1,
		timeoutMs: 3000,
		pathPattern,
	});
	const count = async (pathPattern: string) => {
		const r = await renderOnce({
			url: base, // path is '/'
			device: 'mobile',
			config: { ...NO_SCROLL, waitFor: [rule(pathPattern)] },
			probes: { rev: selectorCountProbe(['.rev-item']) },
		});
		return (r.probes.rev as Record<string, number>)['.rev-item'];
	};
	assert.equal(await count('^/product/'), 0, 'rule skipped when path does not match');
	assert.equal(await count('^/'), 5, 'rule runs when path matches');
});

test('captureNonIndexable returns HTML for a noindex page (and marks it non-indexable)', async () => {
	const r = await renderOnce({ url: `${base}/noindex`, device: 'desktop', config: NO_SCROLL });
	assert.equal(r.isIndexable, false);
	assert.ok(r.html && r.html.includes('not for the index'), 'html captured despite noindex');

	// With captureNonIndexable:false the renderer serializes nothing → outcome reflects the gate.
	const gated = await renderOnce({
		url: `${base}/noindex`,
		device: 'desktop',
		config: NO_SCROLL,
		captureNonIndexable: false,
	});
	assert.equal(gated.html, undefined);
	assert.equal(gated.outcome, 'non-indexable');
});
