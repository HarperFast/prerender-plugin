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

	// AND THE OTHER DIRECTION. Checking only that the console's routes exist upstream leaves the
	// failure this test was written to prevent wide open in the opposite sense: the plugin adds a
	// route, the console — a separately versioned package — never learns about it, and the
	// capability ships unreachable with nothing failing. That is how `sweep-orphans` arrived in
	// plugin v0.48.0 and sat unreachable from console v0.2.x: no client call, no proxy entry, no
	// panel, and a green suite.
	//
	// A new plugin route therefore has to be wired here or named below, with the reason.
	//
	// Currently empty: every route the plugin dispatches is reachable. Note the bar is
	// REACHABLE, not "has a button" — `schedule` is a leaf for peer `explain` calls that the UI
	// never invokes, but it is proxied, so a deliberate node-named call works and it belongs in
	// the allowlist rather than here.
	const DELIBERATELY_NOT_EXPOSED = new Set([]);
	for (const route of pluginServes) {
		if (DELIBERATELY_NOT_EXPOSED.has(route)) continue;
		assert.ok(
			served.includes(route),
			`PrerenderAdmin dispatches "${route}" but the console cannot reach it — add it to PROXIED_GET/PROXIED_POST ` +
				'(and give it a UI), or name it in DELIBERATELY_NOT_EXPOSED with the reason'
		);
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

test('a metric the plugin emits is charted by the console, or waived with a reason', () => {
	// THE SAME FAILURE AS THE ROUTE CONTRACT ABOVE, one layer down. The plugin adds a metric, the
	// console — a separately versioned package — never learns about it, and the signal ships
	// invisible with a green suite on both sides. It has already happened: v0.50.0 added four
	// `queue_health` series, one of which (`claim_granted`) the catalog itself describes as the
	// ONLY way to see whether render prioritisation is engaging, because the ready set reorders a
	// fixed amount of work and moves no total. Nothing failed when no panel read it.
	//
	// Ground truth is the EMIT SITES, not the catalog's `values` list: a series is real once
	// something records it, and the two can drift (they did — the prose and METRICS.md carried the
	// new series while the machine-readable `values` array did not).
	const metricsSource = readFileSync(fileURLToPath(new URL('../../plugin/src/metrics.js', import.meta.url)), 'utf8');
	// EVERY emit site is accounted for, not just the ones a regex happens to match. A scanner that
	// silently skips what it cannot parse is worse than no scanner: it reports "all covered" while
	// covering less each time someone writes an emitter in a new shape.
	//
	// So each `recordAnalytics(value, metric, series, …)` is classified by its THIRD slot. A quoted
	// literal is a series name this console should be charting. Anything else is either a metric
	// whose path slot carries a dimension rather than a series (`bot_serve`'s source, `page_age`'s
	// bot) or a series named at the call site (`queueHealth(value, gauge)`, the
	// `sitemap_${series}` templates) — legitimate, but it has to be a NAMED exception below, so a
	// new one shows up here as a failing test rather than as silence.
	const DYNAMIC_SERIES_SLOT = new Set([
		'botRequest',
		'botServe',
		'routeServe',
		'pageAge',
		'routePageAge',
		'pageAgeNegative',
		'renderTime',
		'renderOutcome',
		'originFetch',
		'serveError',
		'unrouted',
		'sitemapRun',
		'reconcile',
		'queueHealth',
		'demandLadder',
		'invalidationError',
		'invalidationReenqueue',
		// `probe_${series}` — one emit per finished pass, per counter. Charted on the Change probe
		// view, and guarded by name in the test BELOW: being on this list exempts an emitter from
		// the scan above, which is how three probe series once shipped with no panel and a green
		// suite on both sides.
		'changeProbe',
	]);

	const emitted = [];
	const calls = [...metricsSource.matchAll(/server\.recordAnalytics\(\s*[^,]+,\s*(['"])([a-z_]+)\1,\s*([^,]+),/g)];
	assert.ok(calls.length > 5, 'expected to find the emit sites at all — has metrics.js been restructured?');

	for (const call of calls) {
		const [, , metric, third] = call;
		const literal = third.match(/^(['"])([a-z_0-9]+)\1$/);
		if (literal) {
			emitted.push(`${metric}.${literal[2]}`);
			continue;
		}
		// Name the emitter this call belongs to: the nearest `name: (` above it.
		const preceding = metricsSource.slice(0, call.index);
		const owner = [...preceding.matchAll(/\n\t([a-zA-Z]+): \(/g)].pop()?.[1];
		assert.ok(
			DYNAMIC_SERIES_SLOT.has(owner),
			`metrics.${owner} names its series dynamically (\`${third.trim()}\`). If that slot is a dimension ` +
				'rather than a series, add it to DYNAMIC_SERIES_SLOT; if it is a series, this test cannot see ' +
				'it and the console needs checking by hand'
		);
	}
	assert.ok(emitted.length > 0, 'expected to find literal metric emit sites');

	// A series may legitimately have no panel — but it has to be a decision, written down here,
	// not an oversight nobody noticed.
	// `invalidation_error` and `invalidation_reenqueue` were waived here until console v0.12.0 — the
	// Invalidations view now reads both, beside `page_verification` and the `verified` serve status
	// they belong with. This test is what said the console was blind to `page_verification`.
	const NOT_CHARTED = new Map([
		['prerender_ops.serve_error', 'blob-fault counter; the serve-side view of it is bot_serve blob-* on Traffic'],
		['prerender_ops.unrouted', 'has its own endpoint and panel (the unrouted report), not the analytics window'],
		['prerender_ops.config_warnings', 'the Config view reads the warnings themselves, which say more than a count'],
	]);

	const client = [...clientSources.values()].join('\n');
	for (const series of new Set(emitted)) {
		const [, name] = series.split('.');
		if (NOT_CHARTED.has(series)) continue;
		assert.ok(
			client.includes(`'${name}'`),
			`the plugin emits ${series} and no console view reads it — chart it, or add it to NOT_CHARTED with the reason`
		);
	}
});

/**
 * The same contract as the test above, for the ONE emitter family the scan above cannot see.
 *
 * `DYNAMIC_SERIES_SLOT` exempts an emitter from the literal scan because its series name is built
 * at the call site — and an exemption is a hole. `metrics.changeProbe` emits `probe_${series}`,
 * so v0.56.0 and v0.57.0 added `probe_fresh`, `probe_throttled` and `probe_unreadable`, the
 * console read none of them, and every test on both sides stayed green. `probe_throttled` is the
 * one the catalog says to ALERT on: it is the only signal that the probe is loading an origin that
 * cannot take it.
 *
 * It has since earned its keep: plugin v0.58.0's pageCheck added `probe_page_mismatch`, and this
 * test — not a reader, not a review — is what said the console was blind to it.
 *
 * Ground truth here is the catalog's machine-readable `values` list rather than the emit sites,
 * because the emit sites are exactly what the regex cannot read. The two can drift — the test
 * above says so and it has happened — which is why this checks the family the OTHER test is blind
 * to instead of replacing it. Between them, a new probe series has to be charted or waived.
 *
 * WHAT THIS STILL DOES NOT COVER: the other dynamic families (`sitemap_*`, `demand_*`,
 * `queue_health`'s gauges, `invalidation_*`). Those are legitimately unread from analytics — the
 * queue gauges are read from the overview endpoint instead, and the demand series have no panel —
 * so guarding them means a waiver list stating a decision per series, which belongs with whoever
 * makes those decisions rather than in a catch-up change.
 */
test('every probe series the catalog declares is read by the console, or waived with a reason', async () => {
	const { METRICS } = await import('../../plugin/src/metrics.js');
	const series = (METRICS.prerender_ops?.dimensions?.path?.values ?? []).filter(
		(value) => typeof value === 'string' && value.startsWith('probe_')
	);
	assert.ok(series.length > 5, 'expected the probe series to be enumerated in the catalog');

	// The probe view holds the SUFFIX — `totalOf('fresh')` builds `probe_fresh` — so a bare
	// `probe_fresh` literal will not appear anywhere in the client. Both spellings count.
	const client = [...clientSources.values()].join('\n');
	const isRead = (name) => client.includes(`'${name}'`) || client.includes(`'${name.slice('probe_'.length)}'`);

	const NOT_CHARTED = new Map();

	for (const name of series) {
		if (NOT_CHARTED.has(name)) continue;
		assert.ok(
			isRead(name),
			`the plugin emits prerender_ops.${name} and no console view reads it — chart it on the Change ` +
				"probe view, or add it to this test's NOT_CHARTED with the reason"
		);
	}
});
