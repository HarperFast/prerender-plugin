import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { reuseParityCheck, formatReuseParity } from '../dist/audit/reuseParity.js';
import type { Renderer } from '../dist/Worker.js';

// The PRE-DEPLOY check for document reuse, against a real headless Chrome and an origin that behaves
// the way the risky ones do: it routes its API by a cookie the document sets. Rendering with reuse on
// means the sibling has no cookie, so its price call is answered by the wrong backend — and the whole
// point of this harness is that the difference shows up HERE, before anything is enabled, rather than
// in a production sample after the affected pages have been served.

let origin: http.Server;
let base = '';

before(async () => {
	origin = http.createServer((req, res) => {
		const path = req.url ?? '';
		const cookie = req.headers.cookie ?? '';
		if (path.startsWith('/price')) {
			// The routing cookie decides which backend answers. Without it, the legacy one does.
			const price = cookie.includes('bucket=b7') ? '19.99' : '0.00';
			res.writeHead(200, { 'content-type': 'application/json' });
			return res.end(JSON.stringify({ price }));
		}
		if (path.startsWith('/page')) {
			res.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				'set-cookie': ['bucket=b7; Path=/', 'SESSIONID=s1; Path=/'],
			});
			// The offers are written from the price call, exactly as a client-rendered PDP does it.
			return res.end(
				`<!doctype html><html><head><title>p</title></head><body><div id="o"></div>
				<div id="vp">?</div>
				<script>document.getElementById('vp').textContent =
					innerWidth + (matchMedia('(max-width: 600px)').matches ? ' narrow' : ' wide');</script>
				<script>fetch('/price').then(r=>r.json()).then(d=>{
					const s=document.createElement('script');s.type='application/ld+json';
					s.textContent=JSON.stringify({"@context":"https://schema.org","@type":"Product","name":"X",
						offers:{"@type":"Offer",price:d.price,priceCurrency:"USD",availability:"https://schema.org/InStock"}});
					document.head.appendChild(s);document.getElementById('o').textContent=d.price;});</script>
				</body></html>`
			);
		}
		res.writeHead(404);
		res.end();
	});
	await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
	base = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
});

after(async () => {
	await new Promise<void>((r) => origin.close(() => r()));
});

const config = {
	devices: {
		desktop: { viewport: { width: 1280, height: 900 } },
		mobile: {
			userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
			viewport: { width: 390, height: 844 },
		},
	},
	defaultDevice: 'desktop',
	navigation: { waitUntil: 'networkidle2' as const, renderBudgetMs: 10000, networkIdleTimeoutMs: 1500, domStableMs: 0 },
	scroll: { enabled: false },
	block: { resourceTypes: [] as string[], urlPatterns: [] as string[] },
	postProcess: { stripScripts: true },
};

test('the check FAILS a site whose sibling loses the routing cookie — before anything is deployed', async () => {
	const [result] = await reuseParityCheck({
		urls: [`${base}/page`],
		devices: ['desktop', 'mobile'],
		config,
	});

	assert.equal(result.pass, false, 'the run must not pass');
	const [desktop, mobile] = result.devices;
	assert.equal(desktop.pass, true, 'the device that fetched the document is unaffected');
	assert.equal(desktop.offersMatch, true);
	assert.equal(mobile.pass, false, 'the replayed device rendered a different page');
	assert.equal(mobile.offersMatch, false, 'and it is the OFFERS that differ — the thing that matters');
	assert.equal(mobile.reused.documentReused, true, 'it really did replay the sibling document');
	// The report names the failure rather than burying it in a ratio.
	const text = formatReuseParity([result]);
	assert.match(text, /FAIL/);
	assert.match(text, /offers=DIFFERENT/);
	assert.match(text, /do NOT enable documentReuse/);
});

test('pinning the routing cookie makes the same site pass', async () => {
	const [result] = await reuseParityCheck({
		urls: [`${base}/page`],
		devices: ['desktop', 'mobile'],
		pin: ['bucket'],
		config,
	});

	assert.equal(result.pass, true, `expected a pass, got:\n${formatReuseParity([result])}`);
	assert.equal(result.devices[1].offersMatch, true, 'the sibling now reaches the same backend');
	assert.equal(result.devices[1].reused.documentReused, true, 'still replaying — the saving is intact');
	assert.match(formatReuseParity([result]), /All 1 URLs match per device/);
});

test('a replayed variant still renders as ITS OWN device — the regression everyone actually fears', async () => {
	// The page writes its own viewport into the DOM, so desktop and mobile produce genuinely different
	// markup. Reuse hands the mobile variant the DESKTOP document; the viewport and user agent are
	// still mobile's own, so the mobile render must still come out mobile — measured as being much
	// closer to its own control than to its sibling's.
	const [result] = await reuseParityCheck({
		urls: [`${base}/page`],
		devices: ['desktop', 'mobile'],
		pin: ['bucket'],
		config,
	});

	assert.equal(result.pass, true, `expected a pass, got:\n${formatReuseParity([result])}`);
	for (const d of result.devices) {
		assert.ok(
			(d.identity.controlsRatio ?? 0) > 0.02,
			`${d.deviceType}: the two devices must render distinguishably for this to mean anything`
		);
		assert.ok(
			(d.identity.relative ?? 1) <= 0.5,
			`${d.deviceType} stayed itself: own ${d.identity.ownRatio} vs sibling ${d.identity.crossRatio}`
		);
		assert.equal(d.identityHeld, true);
	}
	assert.equal(result.devices[1].reused.documentReused, true, 'and mobile really was replayed');
});

test('the check CATCHES a replayed variant that came back as its sibling', async () => {
	// The failure the check exists for, simulated at the only place it can be: a renderer that hands a
	// replayed variant the first device's page. Nothing about the offers or the outcome differs — this
	// is exactly the regression the per-device comparisons cannot see.
	const asDesktop = `<html><body><div id="vp">1280 wide</div><div id="only-desktop">rail</div></body></html>`;
	const asMobile = `<html><body><div id="vp">390 narrow</div><div id="only-mobile">drawer</div></body></html>`;
	const leaky: Renderer = async (_page, job) =>
		job.documentCache && job.deviceType !== 'desktop' ? asDesktop : job.deviceType === 'desktop' ? asDesktop : asMobile;

	const [result] = await reuseParityCheck({
		urls: [`${base}/page`],
		devices: ['desktop', 'mobile'],
		config,
		renderer: leaky,
	});

	const [desktop, mobile] = result.devices;
	assert.equal(desktop.identityHeld, true, 'the device that fetched the document is unaffected');
	assert.equal(mobile.identityHeld, false, 'mobile came back as desktop and the check says so');
	assert.equal(mobile.identity.crossRatio, 0, "it is byte-for-byte the other device's page");
	assert.equal(mobile.offersMatch, true, 'while offers and outcome agree — which is why this check exists');
	assert.equal(mobile.outcomeMatch, true);
	assert.equal(mobile.pass, false);
	assert.equal(result.pass, false);
	const text = formatReuseParity([result]);
	assert.match(text, /NOT ITSELF/);
	assert.match(text, /reuse did not preserve mobile/);
});
