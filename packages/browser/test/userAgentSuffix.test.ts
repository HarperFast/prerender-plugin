import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { renderOnce } from '../dist/renderOnce.js';
import { defaultConfig } from '../dist/config.js';

// `userAgentSuffix` end to end in a real Chrome: the navigation, a subresource and the page's own
// `navigator.userAgent` all carry it, for a profile with a `userAgent` and for one without (Chrome's own).
const PAGE = `<!doctype html><html><head><title>ua</title><script src="/sub.js"></script></head><body>
<div id="ua"></div><script>document.getElementById('ua').textContent = navigator.userAgent;</script>
</body></html>`;

const seen: { path: string; ua: string }[] = [];
let server: http.Server;
let base = '';

before(async () => {
	server = http.createServer((req, res) => {
		seen.push({ path: req.url ?? '', ua: req.headers['user-agent'] ?? '' });
		if (req.url?.startsWith('/sub.js')) {
			res.setHeader('content-type', 'text/javascript');
			return res.end('window.sub = 1;');
		}
		res.setHeader('content-type', 'text/html; charset=utf-8');
		res.end(PAGE);
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server?.close());

const NO_SCROLL = { scroll: { enabled: false } } as const;
const uaIn = (html: string) => html.match(/<div id="ua">([^<]*)<\/div>/)?.[1] ?? null;

test('the suffix rides on the navigation, the subresources and navigator.userAgent', async () => {
	for (const device of ['mobile', 'desktop'] as const) {
		seen.length = 0;
		const r = await renderOnce({
			url: `${base}/page-${device}`,
			device,
			config: { ...NO_SCROLL, userAgentSuffix: 'HarperRender/1.0' },
		});
		const nav = seen.find((s) => s.path === `/page-${device}`);
		const sub = seen.find((s) => s.path === '/sub.js');
		assert.ok(nav && sub, `${device}: both requests reached the server`);
		assert.match(nav.ua, / HarperRender\/1\.0$/, `${device}: navigation`);
		assert.equal(sub.ua, nav.ua, `${device}: a subresource sends the same UA`);
		assert.equal(uaIn(r.html ?? ''), nav.ua, `${device}: navigator.userAgent`);
		if (device === 'mobile') {
			assert.equal(
				nav.ua,
				`${defaultConfig().devices.mobile.userAgent} HarperRender/1.0`,
				'the profile UA is the base'
			);
		} else {
			assert.match(nav.ua, /Chrome\/[\d.]+ Safari\/537\.36 HarperRender\/1\.0$/, "Chrome's own UA is the base");
		}
	}
});

test('with no suffix nothing changes: the profile UA, or Chrome’s own untouched', async () => {
	seen.length = 0;
	await renderOnce({ url: `${base}/plain-mobile`, device: 'mobile', config: NO_SCROLL });
	assert.equal(seen.find((s) => s.path === '/plain-mobile')?.ua, defaultConfig().devices.mobile.userAgent);
	seen.length = 0;
	await renderOnce({ url: `${base}/plain-desktop`, device: 'desktop', config: NO_SCROLL });
	assert.doesNotMatch(seen.find((s) => s.path === '/plain-desktop')?.ua ?? '', /Harper/);
});
