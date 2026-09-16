import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { reuseParityCheck, formatReuseParity } from '../dist/audit/reuseParity.js';

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
