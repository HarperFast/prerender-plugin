import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { adminAssetIds, getAdminAsset, renderAdminPage } from '../src/admin/index.js';
import { PROXIED_GET, PROXIED_POST } from '../src/util/proxy.js';

const adminDir = fileURLToPath(new URL('../src/admin/', import.meta.url));

const jsAssetIds = adminAssetIds().filter((id) => id.endsWith('.js'));
const clientSources = new Map(jsAssetIds.map((id) => [id, getAdminAsset(id).body.toString('utf8')]));
const page = renderAdminPage();

test('every registry id resolves to a non-empty asset with a type and an ETag', () => {
	for (const id of adminAssetIds()) {
		const asset = getAdminAsset(id);
		assert.ok(asset, `asset ${id} did not resolve`);
		assert.ok(asset.body.length > 0, `asset ${id} is empty`);
		assert.ok(asset.contentType, `asset ${id} has no content type`);
		assert.match(asset.etag, /^"[A-Za-z0-9_-]+"$/, `asset ${id} has no usable ETag`);
	}
});

test('asset lookup is an allowlist — traversal and absolute paths resolve to nothing', () => {
	// The id arrives percent-DECODED from RequestTarget, so these are the literal strings an
	// attacker's URL would produce.
	for (const id of [
		'../config.js',
		'../../package.json',
		'..%2Fconfig.js',
		'fonts/../../config.js',
		'/etc/passwd',
		'app.css/',
		'APP.CSS',
		'',
	]) {
		assert.equal(getAdminAsset(id), null, `"${id}" must not resolve to an asset`);
	}
});

test('the registry covers every file on disk, so nothing ships unreferenced or 404s', () => {
	const onDisk = readdirSync(adminDir, { recursive: true })
		.map(String)
		.map((path) => path.replaceAll('\\', '/'))
		.filter((path) => /\.(js|css|woff2)$/.test(path))
		.filter((path) => path !== 'index.js'); // the server-side registry itself, never served
	const registered = new Set([...adminAssetIds()]);
	for (const file of onDisk) {
		assert.ok(registered.has(file), `${file} exists in src/admin/ but is not in the asset registry`);
	}
	for (const id of registered) {
		assert.ok(onDisk.includes(id), `${id} is registered but missing from src/admin/`);
	}
});

test('every client module parses (node --check, ESM via the package type)', () => {
	for (const id of jsAssetIds) {
		const result = spawnSync(process.execPath, ['--check', `${adminDir}${id}`], { encoding: 'utf8' });
		assert.equal(result.status, 0, `${id} failed to parse:\n${result.stderr}`);
	}
});

test('values are rendered via textContent, never innerHTML', () => {
	// The console displays operator- and origin-supplied URLs, cache keys and config values.
	// Building the DOM through el()/textContent is what makes it injection-safe by
	// construction; this pins that convention across every client module.
	for (const [id, source] of clientSources) {
		for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
			assert.equal(source.includes(banned), false, `${id} uses ${banned}`);
		}
	}
});

test('the console is fully self-contained — no external resource loads anywhere', () => {
	// The CSP (default-src 'none' plus 'self' allowances) blocks external fetches anyway; this
	// asserts nothing even tries, so the CSP stays a backstop rather than the thing holding the
	// console together. The SVG namespace constant is a string handed to createElementNS, not a
	// network fetch.
	const texts = [['page.html', page], ['app.css', getAdminAsset('app.css').body.toString('utf8')], ...clientSources];
	for (const [id, text] of texts) {
		// The SVG namespace and the documentation-reserved example.com placeholder are strings,
		// not loads.
		const stripped = text.replaceAll('http://www.w3.org/2000/svg', '').replaceAll('https://www.example.com', '');
		assert.equal(/https?:\/\//.test(stripped), false, `${id} references an external URL`);
	}
});

test('the shell carries no inline script or style, so the CSP needs no unsafe-inline', () => {
	assert.equal(/<script(?![^>]*\ssrc=)/i.test(page), false, 'page.html has an inline <script>');
	assert.equal(/<style[\s>]/i.test(page), false, 'page.html has an inline <style>');
	assert.equal(/\sstyle="/i.test(page), false, 'page.html uses a style attribute');
});

test('the shell uses relative asset URLs, so a deployment base-URL prefix survives', () => {
	for (const [, url] of page.matchAll(/(?:href|src)="([^"]+)"/g)) {
		assert.equal(url.startsWith('/'), false, `${url} is absolute — it would escape the mount path`);
		assert.equal(url.includes('//'), false, `${url} is protocol-relative`);
	}
});

test('the API base is derived from the page location, not hardcoded', () => {
	const api = clientSources.get('api.js');
	assert.match(api, /location\.pathname/);
	for (const source of clientSources.values()) {
		assert.equal(source.includes("'/prerender_admin"), false, 'a client module hardcodes the mount path');
	}
});

test('client → proxy → plugin: every layer speaks a route the next one dispatches', () => {
	// The route names are the contract across THREE files in TWO packages: the client's
	// fetches, this component's proxy allowlists (util/proxy.js), and PrerenderAdmin's
	// dispatch over in packages/plugin. A typo anywhere fails only in a browser, so pin all
	// three against each other — the monorepo is what makes the cross-package read cheap.
	const served = [...PROXIED_GET, ...PROXIED_POST, 'login', 'logout'];

	// The plugin's dispatch, extracted from its source: the `case '<route>':` labels of the
	// two switches plus the specially-dispatched auth/index routes.
	const adminSource = readFileSync(
		fileURLToPath(new URL('../../plugin/src/resources/PrerenderAdmin.js', import.meta.url)),
		'utf8'
	);
	const pluginServes = new Set(['session', 'login', 'logout']);
	for (const [, route] of adminSource.matchAll(/^\t\t\tcase '([a-z-]+)':/gm)) pluginServes.add(route);

	for (const route of served) {
		assert.ok(pluginServes.has(route), `the proxy forwards "${route}" but PrerenderAdmin does not dispatch it`);
	}

	const called = [];
	for (const source of clientSources.values()) {
		for (const [, route] of source.matchAll(/\b(?:get|post)\(\s*'([a-z-]+)'/g)) called.push(route);
		for (const [, route] of source.matchAll(/BASE \+ '\/([a-z-]+)/g)) called.push(route);
		for (const [, route] of source.matchAll(/\$\{BASE\}\/([a-z-]+)/g)) called.push(route);
	}

	assert.ok(called.length > 0, 'expected the client to call at least one route');
	for (const route of called) {
		assert.ok(served.includes(route), `client calls route "${route}" that the proxy does not forward`);
	}
	// The actions this console exists for must actually be wired up.
	for (const required of [
		'revalidate',
		'reconcile',
		'backlog',
		'sitemap',
		'pages',
		'page-content',
		'analytics',
		'invalidate',
	]) {
		assert.ok(called.includes(required), `no client module calls "${required}"`);
	}
});

test('font licenses ship beside the vendored fonts', () => {
	// This repo is public and Apache-2.0; Ubuntu (UFL) and Fira Code (OFL) require their
	// licenses to accompany the font files.
	for (const license of ['LICENSE-ubuntu.txt', 'LICENSE-fira-code.txt']) {
		const text = readFileSync(`${adminDir}fonts/${license}`, 'utf8');
		assert.ok(text.length > 500, `${license} is missing or empty`);
	}
});
