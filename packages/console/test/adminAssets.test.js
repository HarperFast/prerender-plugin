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
	// Every other route the plugin dispatches is reachable. Note the bar is
	// REACHABLE, not "has a button" — `schedule` is a leaf for peer `explain` calls that the UI
	// never invokes, but it is proxied, so a deliberate node-named call works and it belongs in
	// the allowlist rather than here.
	const DELIBERATELY_NOT_EXPOSED = new Set([
		// Plugin v0.84.0's page orphan sweep ships API-first: its first runs are a deliberate,
		// per-node, dry-run-then-delete operation driven against each node directly. The console
		// panel (proxy + an Overview control beside discovery-purge) is a follow-up console release;
		// remove this entry when it lands.
		'sweep-orphan-pages',
	]);
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
		'queue-state',
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
		// `bot_miss`'s path slot is the miss CAUSE, a closed set (metrics.js MISS_CAUSES) — a dimension, and
		// guarded by name in the bot_miss test below, so a new cause cannot ship without a label on Traffic.
		'botMiss',
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
		// `demand_${series}` (named `demandLadder` before plugin v0.95.0): the ladder's decision counters and
		// the tracker's two sizing gauges. Guarded by name in the demand test below — the gauges are read by
		// the Health view, and each ladder series is waived there with the reason.
		'demand',
		'invalidationError',
		'invalidationReenqueue',
		// `render_size` (plugin v0.97.0): its path slot is the route label, a dimension like route_serve's.
		// No view reads it yet — a page-size panel beside the Traffic view's route table is the follow-up.
		'renderSize',
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
		// Readiness contracts (plugin v0.79.0) are rolling out in report-only mode and are read raw from
		// the analytics endpoint during that window; the Readiness panel is issue #189. Waived, not
		// forgotten — this guard is what said the console was blind to it.
		['render_readiness.verdict', 'report-only window; read raw from /prerender_admin/analytics — panel is #189'],
		['render_readiness.unmet', 'report-only window; read raw from /prerender_admin/analytics — panel is #189'],
		['render_readiness.shortfall', 'report-only window; read raw from /prerender_admin/analytics — panel is #189'],
		['render_readiness.rebaseline', 'report-only window; read raw from /prerender_admin/analytics — panel is #189'],
		['render_readiness.satisfied_ms', 'report-only window; read raw from /prerender_admin/analytics — panel is #189'],
		// The entity discovery gate (plugin v0.90.0) ships in dry run. Its evaluation census is read raw
		// from the analytics endpoint during that window; the refusals that matter once it is ARMED are
		// also emitted as `discovery_gated` with the gate name `entity`, which the Discovery gate panel
		// already totals — so no console release is needed to see the armed gate's effect. A tile for
		// the census (would-gate / suppressed-only / no-siblings / no-prefix) is the follow-up.
		[
			'prerender_ops.entity_gate',
			'dry-run census; read raw from /prerender_admin/analytics — armed refusals land in discovery_gated',
		],
		// plugin v0.97.0: how often an off-owner "render this now" filing reached its owner. A health signal
		// with an expected steady state (forwarded, or nothing when the peer token is unset); a tile on the
		// Queue view is the console follow-up.
		// plugin v0.97.0: trigger-to-cache for a detected change, per route. Read raw from the analytics
		// endpoint until the Change probe view charts it beside the pass counters it is the outcome of.
		[
			'render.change_lag_ms',
			'plugin v0.97.0; read raw from /prerender_admin/analytics — a Change probe panel is the follow-up',
		],
		[
			'prerender_ops.due_now_forward',
			'plugin v0.97.0; read raw from /prerender_admin/analytics until the Queue view charts it',
		],
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
 * The other families on `DYNAMIC_SERIES_SLOT` that name a SERIES at the call site — `sitemap_*`,
 * `queue_health` and `demand_*` — each have their own test below, and so does `bot_miss`'s cause, a
 * dimension whose values the Traffic view labels.
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

	const NOT_CHARTED = new Map([
		// Added by plugin v0.97.0; the pass record on GET /change-probe carries them. Console panel later.
		['probe_errors', 'plugin 0.97.0: actions that threw — read via /change-probe (errors/unacted); panel later'],
		['probe_caught_up', 'plugin 0.97.0: read via /change-probe (caughtUp); panel later'],
		['probe_ignored', 'plugin 0.97.0: read via /change-probe (ignored); panel later'],
		['probe_anchor', 'plugin 0.97.0: anchored-pass outcomes (detail); logged on the node; panel later'],
		['probe_detection_lag', 'plugin 0.97.0: a duration (percentiles, per rule); panel later'],
		['probe_render_mismatch', 'plugin 0.97.0: render-check outcomes (detail); panel later'],
	]);

	for (const name of series) {
		if (NOT_CHARTED.has(name)) continue;
		assert.ok(
			isRead(name),
			`the plugin emits prerender_ops.${name} and no console view reads it — chart it on the Change ` +
				"probe view, or add it to this test's NOT_CHARTED with the reason"
		);
	}
});

/**
 * The other direction, which the test above cannot see: a probe series the console reads that the
 * plugin no longer declares. Plugin v0.94.0 removed `probe_deferred` and `probe_trigger_queue_depth`
 * with the trigger queue, and console 0.18.0 read both — a legend entry and a tile that would have drawn
 * nothing forever, with every test green. The probe view names a series by its SUFFIX in two places,
 * the `OUTCOMES` chart list and `totalOf('…')`, so both are read here and checked against the catalog.
 * And no client module may name the removed fields or settings at all.
 */
test('every probe series the console reads is one the plugin declares, and nothing reads what v0.94.0 removed', async () => {
	const { METRICS } = await import('../../plugin/src/metrics.js');
	const declared = new Set(METRICS.prerender_ops?.dimensions?.path?.values ?? []);
	const source = clientSources.get('views/probe.js');
	assert.ok(source, 'expected views/probe.js among the client assets');
	const outcomes = source.match(/const OUTCOMES = \[([\s\S]*?)\n\];/);
	assert.ok(outcomes, 'expected the OUTCOMES chart list in views/probe.js');
	const read = new Set([
		...[...outcomes[1].matchAll(/\[\s*'([a-z_]+)'/g)].map((m) => m[1]),
		...[...source.matchAll(/totalOf\('([a-z_]+)'\)/g)].map((m) => m[1]),
	]);
	assert.ok(read.size > 8, 'expected to find the probe series the view reads');
	for (const suffix of read) {
		assert.ok(
			declared.has(`probe_${suffix}`),
			`the Change probe view reads prerender_ops.probe_${suffix}, which the plugin no longer declares — remove the read`
		);
	}

	const REMOVED_IN_0_94 = [
		/\bprobe_deferred\b/,
		/\btrigger_queue_depth\b/,
		/\btriggerQueueDepth\b/,
		/\bmaxTriggersPerSweep\b/,
		/\bmaxPending\b/,
		/trigger\.ratePerSecond/,
	];
	for (const [id, text] of clientSources) {
		for (const pattern of REMOVED_IN_0_94) {
			assert.doesNotMatch(text, pattern, `${id} still names ${pattern.source}, which plugin v0.94.0 removed`);
		}
	}
	for (const name of ['probe_deferred', 'probe_trigger_queue_depth']) {
		assert.equal(declared.has(name), false, `${name} is back in the catalog — revisit this test`);
	}
});

/**
 * The same contract again, for the `sitemap_*` family — and this one reads the EMIT SITES, not the
 * catalog.
 *
 * `metrics.sitemapRun` is on `DYNAMIC_SERIES_SLOT`, so the literal scan above cannot see any of
 * these, and that exemption cost exactly what the probe one did: plugin v0.69.0 added
 * `sitemap_not_modified` and v0.74.0 `sitemap_created_soon`, the console read neither, and every
 * test on both sides stayed green. `sitemap_not_modified` is the ONLY evidence anywhere that
 * conditional sitemap fetching is working — a walk that re-parses everything succeeds exactly like
 * one that skipped.
 *
 * GROUND TRUTH IS `resources/Sitemap.js`, deliberately NOT the catalog's `values` list as the probe
 * test uses. The two have drifted here and the drift is the point: at the time of writing the
 * catalog enumerates six `sitemap_*` names and the plugin emits fifteen, so a catalog-based guard
 * would pass while blind to the two series this test exists for. The emit site is what makes a
 * series real.
 */
test('every sitemap series the plugin emits is read by the console, or waived with a reason', () => {
	const source = readFileSync(fileURLToPath(new URL('../../plugin/src/resources/Sitemap.js', import.meta.url)), 'utf8');
	// To the END of the statement, not to the first `)`: the departure emitter's own argument
	// contains parentheses, and a lazier match would hand this test a truncated string it could
	// neither recognize nor report usefully. Every call site is one line.
	const calls = [...source.matchAll(/metrics\.sitemapRun\([^,]+,\s*(.+)\);$/gm)];
	assert.ok(calls.length > 5, 'expected to find the sitemap emit sites at all — has Sitemap.js been restructured?');

	// A series name built at the call site cannot be read from here, exactly as with the emitters
	// the test above exempts — so each one is named, with what it is, rather than passing silently.
	const BUILT_AT_THE_CALL_SITE = new Map([
		[
			"`departure_${name.replace(/-/g, '_')}`",
			'the post-walk sitemap-departure family (departure_render / _expire / _reattached / …) — ten ' +
				'series with dry-run-vs-armed semantics of their own, plus the walk corrections _relinked and ' +
				'_listed_unchanged (plugin v0.97.0), which need that same panel. No console panel reads them: the ' +
				'Sitemaps view charts walk OUTCOMES, and departures are a separate decision surface that ' +
				'needs its own panel rather than seven more tiles on this one. Tracked, not forgotten.',
		],
	]);

	const emitted = [];
	for (const [, arg] of calls) {
		const literal = arg.trim().match(/^(['"])([a-z_0-9]+)\1$/);
		if (literal) {
			emitted.push(`sitemap_${literal[2]}`);
			continue;
		}
		assert.ok(
			BUILT_AT_THE_CALL_SITE.has(arg.trim()),
			`metrics.sitemapRun is called with a series name this test cannot read (\`${arg.trim()}\`). Name it in ` +
				'BUILT_AT_THE_CALL_SITE with what it is and whether the console reads it, or pass a literal'
		);
	}
	assert.ok(emitted.length > 5, 'expected literal sitemap series names');

	// The walk panel holds the SUFFIX — `totalOf('not_modified')` builds `sitemap_not_modified` —
	// so the full name never appears in the client. Both spellings count, as in the probe test.
	const client = [...clientSources.values()].join('\n');
	const isRead = (name) => client.includes(`'${name}'`) || client.includes(`'${name.slice('sitemap_'.length)}'`);

	const NOT_CHARTED = new Map([
		[
			'sitemap_shrink_refused',
			'documents sitemap.shrinkGuard refused as much shorter than the last accepted (plugin v0.97.0); each is ' +
				'also a failed child, which sitemap_failed already charts — a dedicated tile waits for the panel ' +
				'the departure family needs',
		],
		[
			'sitemap_shrink_accepted',
			'identical shorter documents accepted after shrinkGuard.acceptAfter refusals (plugin v0.97.0) — rare and ' +
				'logged at error; waits for the same panel',
		],
	]);

	for (const name of new Set(emitted)) {
		if (NOT_CHARTED.has(name)) continue;
		assert.ok(
			isRead(name),
			`the plugin emits prerender_ops.${name} and no console view reads it — chart it on the Sitemaps ` +
				"view, or add it to this test's NOT_CHARTED with the reason"
		);
	}
});

/**
 * The `queue_health` family, both ways — the one the literal scan above exempts (`queueHealth(value,
 * gauge)` names its series at the call site) and the one plugin v0.93.0 rewrote: it REMOVED seven
 * series (`claim_scan_ms`, `ready_sweep_ms`, `ready_published`, `ready_cadence`, `below_floor`,
 * `below_floor_age_ms`, `floor_pin_age_ms`) that console 0.17.0 read, and added seven it did not. Both
 * directions failed silently: the removed ones drew as `—`, the new ones were invisible.
 *
 * The console names every series it reads in ONE place, `QUEUE_HEALTH` in views/queue.js, so:
 *   - every name there must be one the catalog declares — a read of a series that no longer exists
 *     fails here instead of drawing an empty tile;
 *   - every series the catalog declares must be read, or waived below with the reason.
 * And no client module may carry a removed name at all, in case a read bypasses the constants.
 */
test('every queue_health series is read or waived, and the console reads none the plugin dropped', async () => {
	const { METRICS } = await import('../../plugin/src/metrics.js');
	const declared = METRICS.queue_health?.dimensions?.path?.values ?? [];
	assert.ok(declared.length > 5, 'expected the queue_health series to be enumerated in the catalog');

	const { installDom } = await import('./domShim.js');
	installDom();
	const { QUEUE_HEALTH } = await import('../src/admin/views/queue.js');
	const read = new Set(Object.values(QUEUE_HEALTH));

	for (const name of read) {
		assert.ok(
			declared.includes(name),
			`the console reads queue_health.${name}, which the plugin no longer declares — remove the read`
		);
	}

	const NOT_CHARTED = new Map([
		['overdue', 'the due-now count is read live from queue-state, or from the overview snapshot'],
		['lease_occupancy', 'in flight is read live from overview.leases (an exact slot walk)'],
		['paused', 'pause state is read from the overview (QueueControl intent and QueueStatus observed)'],
		['reconcile_restored', 'the Corpus view reads the repair sweep result from overview.reconcile'],
		['reconcile_missing', 'the Corpus view reads the repair sweep result from overview.reconcile'],
		[
			'keeper_unschedulable',
			'plugin v0.97.0: emitted only when a verification walk finds owned rows with no due time (expect none); ' +
				'the count is also in queue-state keeper.verify.unschedulable — a Queue tile is a console follow-up',
		],
	]);
	for (const name of declared) {
		if (NOT_CHARTED.has(name)) continue;
		assert.ok(
			read.has(name),
			`the plugin declares queue_health.${name} and no console view reads it — add it to QUEUE_HEALTH and ` +
				"chart it, or add it to this test's NOT_CHARTED with the reason"
		);
	}
	for (const name of NOT_CHARTED.keys()) {
		assert.ok(declared.includes(name), `NOT_CHARTED waives queue_health.${name}, which the plugin no longer declares`);
	}

	const REMOVED_IN_0_93 = [
		'claim_scan_ms',
		'ready_sweep_ms',
		'ready_published',
		'ready_cadence',
		'below_floor',
		'below_floor_age_ms',
		'floor_pin_age_ms',
	];
	const client = [...clientSources.values()].join('\n');
	for (const name of REMOVED_IN_0_93) {
		assert.equal(declared.includes(name), false, `${name} is back in the catalog — revisit this list`);
		assert.equal(client.includes(`'${name}'`), false, `a client module still reads the removed series ${name}`);
	}
});

/**
 * The `demand_*` family, both ways. `metrics.demand` names its series at the call site
 * (`demand_${series}`), so the literal scan above cannot see any of them. Plugin v0.95.0 split the
 * demand TRACKER out of the cadence ladder and added `demand_false_positive` — the number
 * `demand.maxFalsePositive` is held against, and the only signal that changed-page order has quietly
 * stopped using demand. The Health view reads it and `demand_fill`; the ladder's decision counters have
 * no panel, and each is waived below with the reason. And no client module may name a tracker option on
 * its pre-0.95 path: those moved to `demand.*` without an alias, so a read there reads nothing.
 */
test('every demand series is read or waived, the console reads none the plugin does not declare, and no moved key', async () => {
	const { METRICS } = await import('../../plugin/src/metrics.js');
	const declared = (METRICS.prerender_ops?.dimensions?.path?.values ?? []).filter(
		(value) => typeof value === 'string' && value.startsWith('demand_')
	);
	assert.ok(declared.length > 5, 'expected the demand series to be enumerated in the catalog');

	const LADDER =
		'the cadence ladder’s decision counters (render.demand) — no panel yet: the ladder logs its per-level ' +
		'histogram, and Corpus spares promoted targets by their stored demandInterval';
	const NOT_CHARTED = new Map(
		[
			'demand_promoted',
			'demand_demoted',
			'demand_held',
			'demand_skipped_cold',
			'demand_single_rung',
			'demand_promoted_fast',
			'demand_fast',
			'demand_graded',
		].map((name) => [name, LADDER])
	);

	const client = [...clientSources.values()].join('\n');
	for (const name of declared) {
		if (NOT_CHARTED.has(name)) continue;
		assert.ok(
			client.includes(`'${name}'`),
			`the plugin declares prerender_ops.${name} and no console view reads it — chart it, or add it to this ` +
				"test's NOT_CHARTED with the reason"
		);
	}
	for (const name of NOT_CHARTED.keys()) {
		assert.ok(declared.includes(name), `NOT_CHARTED waives prerender_ops.${name}, which the plugin no longer declares`);
	}
	for (const [id, text] of clientSources) {
		for (const [, name] of text.matchAll(/'(demand_[a-z_]+)'/g)) {
			assert.ok(declared.includes(name), `${id} reads prerender_ops.${name}, which the plugin does not declare`);
		}
		assert.doesNotMatch(
			text,
			/render\.demand\.(bots|sliceMs|slices|bitsPerSlice|hashes|flushInterval|mergeInterval)\b/,
			`${id} names a tracker option on its pre-0.95 path — it is demand.* now`
		);
	}
});

/**
 * `bot_miss`'s causes (plugin v0.95.0), both ways. The emitter is on `DYNAMIC_SERIES_SLOT` because its
 * path slot is the cause — a dimension — so nothing above would notice a new one. The Traffic view's miss
 * panel labels every cause with its FAMILY, and the family is the verdict: a cause that arrived unlabelled
 * would fall into "other" and stop saying whether it is render capacity or a rule. So every cause the
 * catalog declares must be in `MISS_CAUSES`, and nothing may be there that the plugin no longer sends.
 */
test('every bot_miss cause the plugin declares is labelled on Traffic, and the console labels none it does not', async () => {
	const { METRICS } = await import('../../plugin/src/metrics.js');
	const declared = METRICS.bot_miss?.dimensions?.path?.values ?? [];
	assert.ok(declared.length > 5, 'expected the bot_miss causes to be enumerated in the catalog');

	const { installDom } = await import('./domShim.js');
	installDom();
	const { MISS_CAUSES, MISS_FAMILIES } = await import('../src/admin/views/traffic.js');
	const families = new Set(MISS_FAMILIES.map((family) => family.key));

	for (const cause of declared) {
		assert.ok(
			Object.hasOwn(MISS_CAUSES, cause),
			`the plugin declares bot_miss cause "${cause}" and the Traffic miss panel has no label for it — add it ` +
				'to MISS_CAUSES in views/traffic.js with its family'
		);
	}
	for (const [cause, [family, means]] of Object.entries(MISS_CAUSES)) {
		assert.ok(declared.includes(cause), `MISS_CAUSES labels "${cause}", which the plugin no longer declares`);
		assert.ok(families.has(family), `"${cause}" is filed under "${family}", which MISS_FAMILIES does not define`);
		assert.ok(typeof means === 'string' && means.length > 10, `"${cause}" says nothing about what it means`);
	}
	// The one family that is render capacity is exactly the rotation's own unrendered pages — the plugin
	// README's grouping ("Why a request missed"), and the one the panel's verdict text rests on. `device` is
	// NOT in it: a device outside deviceTypes.default is never rendered by the rotation — config, not capacity.
	assert.deepEqual(
		Object.entries(MISS_CAUSES)
			.filter(([, [family]]) => family === 'waiting')
			.map(([cause]) => cause)
			.sort(),
		['new', 'render-timeout', 'unrendered']
	);
	assert.equal(MISS_CAUSES.device[0], 'rule');
	assert.equal(MISS_CAUSES['not-modified'][0], 'origin', 'a 304 is the origin answering, not a redirect');
});
