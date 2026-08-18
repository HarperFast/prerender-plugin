/**
 * The three-layer config merge: schema defaults < the deployed `config.yaml` (host options) <
 * the stored overrides written from the console.
 *
 * These pin the two things an operator's rollback rests on — clearing one override reverts that
 * ONE option to the DEPLOYED value rather than to the schema default, and an override that fails
 * validation leaves the lower layer running — plus the `override-rejected` provenance that is the
 * whole reason `describeConfigLayers` exists: without it, "the console lists my setting and the
 * cluster is not honouring it" is indistinguishable from "the cluster is honouring it".
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
	activeOverrides,
	applyOptions,
	collectConfigWarnings,
	config,
	describeConfigLayers,
	hostOptions,
	resolveConfig,
} from '../src/config.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * 60 * 1000;

// Harper's `logger` does not exist out here and config.js falls back to `console`, which would
// print a line for every deliberately-rejected value below. Capturing it is also what makes
// "resolveConfig returns its warnings instead of logging them" assertable at all.
const logged = [];
globalThis.logger = { debug() {}, info() {}, warn: (message) => logged.push(String(message)), error() {} };

const layerFor = (path) => describeConfigLayers().find((row) => row.path === path);

beforeEach(() => {
	applyOptions({});
	logged.length = 0;
});

test('an override beats the file layer, and the file layer beats the schema default', () => {
	applyOptions({}, {});
	assert.equal(config.page.ttl, DAY);

	applyOptions({ page: { ttl: 5000 } }, {});
	assert.equal(config.page.ttl, 5000);

	applyOptions({ page: { ttl: 5000 } }, { 'page.ttl': 7000 });
	assert.equal(config.page.ttl, 7000);
	assert.equal(layerFor('page.ttl').source, 'override');
});

test('overrides are a set of deltas: an option nobody overrode still follows the deployed file', () => {
	applyOptions({ page: { ttl: 5000, swrTtl: 60_000 } }, { 'page.ttl': 7000 });
	assert.equal(config.page.ttl, 7000);
	assert.equal(config.page.swrTtl, 60_000, 'a file value nobody pinned must still take effect');

	// A later deploy moves the file value of the un-overridden option; the pinned one stays pinned.
	applyOptions({ page: { ttl: 5000, swrTtl: 90_000 } }, { 'page.ttl': 7000 });
	assert.equal(config.page.swrTtl, 90_000);
	assert.equal(config.page.ttl, 7000);
});

test('clearing an override reverts that option to the deployed file value, not to the default', () => {
	const file = { page: { ttl: 5000, swrTtl: 60_000 } };

	applyOptions(file, { 'page.ttl': 7000, 'page.swrTtl': 90_000 });
	assert.equal(config.page.ttl, 7000);
	assert.equal(config.page.swrTtl, 90_000);

	// Clearing ONE row leaves the other in force.
	applyOptions(file, { 'page.swrTtl': 90_000 });
	assert.equal(config.page.ttl, 5000, 'a cleared override reverts to the deployed value');
	assert.equal(config.page.swrTtl, 90_000);
	assert.equal(layerFor('page.ttl').source, 'file');

	// Clearing all of them returns the cluster to exactly its deployed state.
	applyOptions(file, {});
	assert.equal(config.page.ttl, 5000);
	assert.equal(config.page.swrTtl, 60_000);
	assert.deepEqual(activeOverrides(), {});
});

test('clearing an override reverts to the schema default when the file never set that option', () => {
	applyOptions({}, { 'page.ttl': 7000 });
	assert.equal(config.page.ttl, 7000);

	applyOptions({}, {});
	assert.equal(config.page.ttl, DAY);
	assert.equal(layerFor('page.ttl').source, 'default');
});

test('an override of the wrong type is rejected and the file value keeps running', () => {
	applyOptions({ page: { ttl: 5000 } }, { 'page.ttl': 'lots' });

	assert.equal(config.page.ttl, 5000, 'a rejected override must not unset the deployed value');

	const row = layerFor('page.ttl');
	assert.equal(row.source, 'override-rejected');
	assert.equal(row.overridden, true, 'the row is still listed — it exists, it just is not in effect');
	assert.equal(row.override, 'lots');
	assert.equal(row.file, 5000);
	assert.equal(row.effective, 5000);
});

test('an override violating enum, min, max, nonEmpty or itemEnum is rejected and reported as override-rejected', () => {
	const cases = [
		{ path: 'ingress.mode', file: { ingress: { mode: 'forwarded' } }, bad: 'sideways' },
		{ path: 'queue.jobLeaseTime', file: { queue: { jobLeaseTime: 15 * MINUTE } }, bad: 1 },
		{ path: 'sitemap.filteredWarnPercent', file: { sitemap: { filteredWarnPercent: 80 } }, bad: 1000 },
		{ path: 'cacheKey.delimiter', file: { cacheKey: { delimiter: '#' } }, bad: '' },
		{ path: 'cacheKey.decodeReserved', file: { cacheKey: { decodeReserved: [':'] } }, bad: [':', '&'] },
	];

	for (const { path, file, bad } of cases) {
		applyOptions(file, { [path]: bad });
		const row = layerFor(path);

		assert.equal(row.source, 'override-rejected', `${path}: a value the schema refuses must report as rejected`);
		assert.notDeepEqual(row.effective, bad, `${path}: the refused value must not be running`);
		// A refused override falls back to THE LAYER BELOW IT, not to the schema default. The two
		// rejection paths therefore agree: a type mismatch never reaches the merged config, and a
		// constraint violation is restored from the file layer that was validated before the
		// overrides were merged on top. The distinction is not academic — reverting to the default
		// here would mean one typo'd override silently discarding a value config.yaml sets
		// deliberately, leaving the operator with neither their new value nor the one that was
		// running, and nothing to say the deployed setting was collateral damage.
		assert.deepEqual(row.effective, row.file, `${path}: a refused constraint keeps the configured value`);
		assert.notDeepEqual(row.file, row.default, `${path}: the case is only meaningful if the file moved it`);
	}
});

test('a backstop interval past node’s timer ceiling is refused rather than armed', () => {
	// Over 2^31-1 ms, `setInterval` does not fire late or never — node warns and fires the callback
	// after ONE MILLISECOND. So the value that reads as "poll about once a month" arms a hot loop
	// re-reading the override table on every worker of every node. Refusing it in the schema is the
	// loud half of the fix; `MAX_TIMER_MS` in configOverride.js clamps whatever still reaches a timer.
	const { config: resolved, warnings } = resolveConfig({ management: { overrides: { syncInterval: 3e9 } } }, null);

	assert.equal(
		resolved.management.overrides.syncInterval,
		30_000,
		'an interval node cannot express must fall back to one it can'
	);
	assert.ok(
		warnings.some((w) => w.includes('management.overrides.syncInterval')),
		'and the operator has to be told, because the configured value is not the running one'
	);
});

test('describeConfigLayers names the layer that actually won for each option', () => {
	applyOptions({ page: { ttl: 5000 } }, { 'queue.jobLeaseTime': 15 * MINUTE, 'domains': 'not-an-array' });

	assert.equal(layerFor('page.swrTtl').source, 'default', 'nobody touched it');
	assert.equal(layerFor('page.ttl').source, 'file');
	assert.equal(layerFor('queue.jobLeaseTime').source, 'override');
	assert.equal(layerFor('domains').source, 'override-rejected');

	assert.equal(layerFor('page.ttl').fileDiffersFromDefault, true);
	assert.equal(layerFor('page.swrTtl').fileDiffersFromDefault, false);
	assert.equal(layerFor('queue.jobLeaseTime').effective, 15 * MINUTE);
	assert.deepEqual(layerFor('domains').effective, [], 'the refused array left the default in place');

	// Those four are the whole vocabulary — a fifth value would be a source the console cannot render.
	const sources = new Set(describeConfigLayers().map((row) => row.source));
	assert.deepEqual([...sources].sort(), ['default', 'file', 'override', 'override-rejected']);
});

test('secret options are reported as presence markers in every layer, never by value', () => {
	const FILE_TOKEN = 'file-origin-token-value';
	const OVERRIDE_TOKEN = 'override-peer-rescue-token';

	applyOptions({ origin: { securityToken: { value: FILE_TOKEN } } }, { 'peerRescue.token': OVERRIDE_TOKEN });

	const token = layerFor('origin.securityToken.value');
	assert.equal(token.secret, true);
	assert.equal(token.default, '<empty>', 'an unset secret must read as empty, not as configured');
	assert.equal(token.file, `<set: ${FILE_TOKEN.length} chars>`);
	assert.equal(token.effective, `<set: ${FILE_TOKEN.length} chars>`);

	// A stored row for a secret is REFUSED BY THE MERGE, not merely by the API. The management API
	// cannot create one, but the table is also reachable through the operations API, and a row that
	// arrived that way used to be applied — which would let anyone with table access set the origin
	// token. The row is ignored, the option keeps the value its layers give it, and the refusal is
	// reported rather than silent.
	const peer = layerFor('peerRescue.token');
	assert.equal(peer.secret, true);
	assert.equal(peer.effective, '<empty>', 'a secret set by a stored row must not take effect');
	assert.equal(peer.override, `<set: ${OVERRIDE_TOKEN.length} chars>`, 'and is still rendered without disclosure');
	assert.equal(peer.source, 'override-rejected', 'the row exists and is not honoured — exactly that state');
});

test('a stored row cannot set an option the console is forbidden to write, whatever route it arrived by', () => {
	// The write door refuses these; the merge has to as well, because the table is reachable through
	// the operations API. `management.enabled: false` is the sharpest case — it disables the
	// management API cluster-wide, and undoing it would have to go through the API it just switched
	// off. `*.valueEnv` is the subtlest: it sets a secret BY PROXY, by naming an environment variable
	// whose value the writer already knows.
	process.env.CONFIG_LAYERS_PROBE = 'a-value-the-writer-knows';

	const refused = {
		'management.enabled': false,
		'management.overrides.enabled': false,
		'renderNow.valueEnv': 'CONFIG_LAYERS_PROBE',
		'origin.securityToken.value': 'set-by-a-row',
	};

	for (const [path, value] of Object.entries(refused)) {
		const { config: resolved, warnings } = resolveConfig({}, { [path]: value });
		const effective = path.split('.').reduce((node, segment) => node?.[segment], resolved);
		assert.notDeepEqual(effective, value, `${path} must not be settable by a stored row`);
		assert.ok(
			warnings.some((warning) => warning.includes(path)),
			`${path} must be reported as refused, not dropped in silence`
		);
	}

	// And the proxy attack specifically: the token must not become the named variable's value.
	const viaEnv = resolveConfig({}, { 'renderNow.valueEnv': 'CONFIG_LAYERS_PROBE' });
	assert.equal(viaEnv.config.renderNow.token, '', 'a refused valueEnv must not source the token');

	delete process.env.CONFIG_LAYERS_PROBE;
});

test('a configured secret appears nowhere by value in the serialized layers view', () => {
	const secrets = {
		'origin.securityToken.value': 'origin-token-3f9a2b7c',
		'renderNow.token': 'render-now-token-88c1d4',
		'peerRescue.token': 'peer-rescue-token-4d20ef',
	};

	applyOptions(
		{
			origin: { securityToken: { value: secrets['origin.securityToken.value'] } },
			renderNow: { enabled: true, token: secrets['renderNow.token'] },
			peerRescue: { enabled: true, token: secrets['peerRescue.token'] },
		},
		{ 'renderNow.token': 'override-render-now-token' }
	);

	const serialized = JSON.stringify(describeConfigLayers());
	for (const [path, value] of Object.entries(secrets)) {
		assert.equal(layerFor(path).secret, true, `${path} must be marked secret`);
		assert.equal(serialized.includes(value), false, `${path} disclosed its value in the layers view`);
	}
	assert.equal(serialized.includes('override-render-now-token'), false, 'an overridden secret leaked');

	// Not vacuous: the markers themselves ARE in the output, so the absence above is redaction
	// rather than a row that failed to render.
	assert.ok(
		serialized.includes(`<set: ${secrets['origin.securityToken.value'].length} chars>`),
		serialized.slice(0, 200)
	);
});

test('a stored override keyed by a legacy path is remapped onto the option it moved to', () => {
	// `origin.staging` carries movedFrom: 'staging', so the whole subtree relocates by PREFIX;
	// `sitemap.userAgent` carries movedFrom: 'sitemapUserAgent', a single-option move.
	applyOptions({}, { 'staging.header': 'x-legacy-staging', 'sitemapUserAgent': 'LegacyBot/1.0' });
	assert.equal(config.origin.staging.header, 'x-legacy-staging');
	assert.equal(config.sitemap.userAgent, 'LegacyBot/1.0');

	// Remapped loudly, not silently: an operator has to be told the row needs rewriting.
	const { warnings } = resolveConfig({}, { 'staging.header': 'x-legacy-staging', 'sitemapUserAgent': 'LegacyBot/1.0' });
	assert.ok(
		warnings.some((line) => line.includes('staging.header moved to origin.staging.header')),
		warnings.join('\n')
	);
	assert.ok(
		warnings.some((line) => line.includes('sitemapUserAgent moved to sitemap.userAgent')),
		warnings.join('\n')
	);
});

test('an override path that is not an option in this release is dropped with a warning, not in silence', () => {
	// The nested case is the one that matters: `mergeInto` only reports an unknown key at the TOP
	// level, so `queue.somethingRenamed` would otherwise vanish without a word while the row stays
	// in the table and the console keeps listing it.
	const { warnings } = resolveConfig({}, { 'queue.somethingRenamed': 1, 'notAGroup.atAll': 2 });

	for (const path of ['queue.somethingRenamed', 'notAGroup.atAll']) {
		assert.ok(
			warnings.some((line) => line.includes(`Ignoring stored override ${path}`) && line.includes('not an option')),
			`${path} was dropped silently: ${warnings.join('\n')}`
		);
	}

	// It is dropped, not merged in as a junk key.
	applyOptions({}, { 'queue.somethingRenamed': 1 });
	assert.equal('somethingRenamed' in config.queue, false);
});

test('resolveConfig is pure: it returns a prospective config and its warnings without touching the live one', () => {
	applyOptions({ page: { ttl: 5000 } }, {});
	// applyOptions DOES log its warnings, which is what makes the empty log below meaningful
	// rather than a sink nothing is wired to.
	assert.ok(logged.length > 0, 'the log sink must be live for the assertion below to mean anything');
	logged.length = 0;

	const { config: prospective, warnings } = resolveConfig(
		{ page: { ttl: 9999 }, nonsenseKey: true },
		{ 'page.ttl': 'lots' }
	);

	assert.equal(prospective.page.ttl, 9999, 'the rejected override leaves the previewed file value');
	assert.equal(config.page.ttl, 5000, 'the live config must not move during a dry run');
	assert.deepEqual(activeOverrides(), {}, 'a dry run must not become the applied override layer');
	assert.notEqual(prospective, config, 'a dry run must not hand back the live object');

	// A preview that wrote "Ignoring prerender.page.ttl" into the log for a value nobody applied is
	// worse than no preview at all.
	assert.deepEqual(logged, [], `a dry run must not log: ${logged.join('\n')}`);
	assert.ok(
		warnings.some((line) => line.includes('Unknown configuration key: prerender.nonsenseKey')),
		warnings.join('\n')
	);
	assert.ok(
		warnings.some((line) => line.includes('Ignoring prerender.page.ttl')),
		warnings.join('\n')
	);
});

test('applyOptions with no override argument behaves exactly as it did before the layer existed', () => {
	applyOptions({ page: { ttl: 5000 } }, { 'page.ttl': 7000 });
	assert.equal(config.page.ttl, 7000);

	// Every pre-existing caller passes one argument. That must resolve the file layer alone —
	// dropping the override layer rather than silently carrying the last one forward.
	applyOptions({ page: { ttl: 5000 } });
	assert.equal(config.page.ttl, 5000);
	assert.deepEqual(activeOverrides(), {});
	assert.equal(layerFor('page.ttl').source, 'file');

	applyOptions({});
	assert.equal(config.page.ttl, DAY);
	assert.equal(layerFor('page.ttl').source, 'default');
});

test('the override layer accepts the Map a table read produces as well as a plain object', () => {
	applyOptions({}, new Map([['page.ttl', 7000]]));
	assert.equal(config.page.ttl, 7000);
	assert.deepEqual(activeOverrides(), { 'page.ttl': 7000 });
	assert.equal(layerFor('page.ttl').source, 'override');
});

test('collectConfigWarnings evaluates the config it is handed, not the live one', () => {
	applyOptions({ domains: ['example.com'], origin: { securityToken: { value: 'file-token' } } });
	assert.deepEqual(
		collectConfigWarnings().map((finding) => finding.key),
		[]
	);

	const prospective = resolveConfig(
		{ domains: [], origin: { securityToken: { value: 'file-token' } }, ingress: { mode: 'forwarded' } },
		{}
	).config;

	assert.deepEqual(
		collectConfigWarnings(prospective, { prerenderRoutes: 0 })
			.map((finding) => finding.key)
			.sort(),
		['domains', 'ingress.routes']
	);
	// The route count has to come from the CALLER: the compiled route list is memoized off the LIVE
	// config, so reading it here would answer a previewed `ingress.routes` edit with the count that
	// is currently running.
	assert.deepEqual(
		collectConfigWarnings(prospective, { prerenderRoutes: 2 }).map((finding) => finding.key),
		['domains']
	);

	// And the live config is still the clean one it was.
	assert.deepEqual(
		collectConfigWarnings().map((finding) => finding.key),
		[]
	);
});

test('activeOverrides and hostOptions hand back copies, not the live layers', () => {
	applyOptions({ domains: ['example.com'] }, { 'page.ttl': 7000 });

	assert.deepEqual(hostOptions(), { domains: ['example.com'] });
	assert.deepEqual(activeOverrides(), { 'page.ttl': 7000 });

	hostOptions().domains.push('evil.example');
	activeOverrides()['page.ttl'] = 1;

	assert.deepEqual(hostOptions(), { domains: ['example.com'] });
	assert.deepEqual(activeOverrides(), { 'page.ttl': 7000 });
	assert.equal(config.page.ttl, 7000);
});

// ---- hostile override rows ---------------------------------------------------------------------
//
// These rows cannot be created through the management API — `checkUiEditable` refuses them — so they
// arrive only from a direct table write (the operations-socket escape hatch) or from a future code
// path. They are pinned anyway because the failure they used to cause was not a bad value, it was a
// THROW out of applyOptions, out of handleApplication, and into `lifecycle.failed` on every worker
// of every node. A replicated table plus a fatal parse is a cluster-wide outage from one row.

test('a prototype-chain key stored as an override path is ignored, not fatal, and leaves the file value running', () => {
	for (const path of ['__proto__', 'constructor', 'queue.__proto__.injected', 'constructor.prototype.x']) {
		const overrides = {};
		Object.defineProperty(overrides, path, { value: 'PWNED', enumerable: true, configurable: true });

		assert.doesNotThrow(
			() => applyOptions({ queue: { jobLeaseTime: 15 * MINUTE } }, overrides),
			`an override row keyed "${path}" must never throw — a throw here fails component load`
		);
		assert.equal(config.queue.jobLeaseTime, 15 * MINUTE, `"${path}" must leave the deployed configuration untouched`);
	}
});

test('Object.prototype is never mutated by an override path or value', () => {
	const probe = () => ({}).injected;
	assert.equal(probe(), undefined, 'precondition: nothing is polluted yet');

	applyOptions({}, { '__proto__.injected': 'PWNED', 'constructor.prototype.injected': 'PWNED' });
	assert.equal(probe(), undefined, 'an override path must not reach Object.prototype');

	// A VALUE carrying the key is the other half: `clone['__proto__'] = x` reassigns the clone's
	// prototype rather than adding a key, so the entry would inherit fields it does not own.
	applyOptions(
		{},
		{ 'ingress.routes': [JSON.parse('{"__proto__":{"mode":"passthrough"},"match":"prefix","path":"/x"}')] }
	);
	assert.equal(probe(), undefined, 'an override value must not reach Object.prototype');
	assert.equal(
		config.ingress.routes[0].mode,
		undefined,
		'a route entry must not inherit `mode` from an injected prototype — it would silently stop being prerendered'
	);
	assert.deepEqual(Object.keys(config.ingress.routes[0]).sort(), ['match', 'path']);
});

test('an alias lookup cannot be answered by the prototype chain', async () => {
	// `aliases['__proto__']` used to return Object.prototype — truthy, and not a string — so the
	// remapped "path" was an object and the schema walk threw on `.split`.
	const { resolveConfig: resolve } = await import('../src/config.js');
	const overrides = {};
	Object.defineProperty(overrides, '__proto__', { value: 'x', enumerable: true, configurable: true });
	const result = resolve({}, overrides);
	assert.ok(result.config, 'resolution must complete');
	assert.ok(
		result.warnings.some((warning) => warning.includes('__proto__')),
		'and must say the row was ignored rather than failing silently'
	);
});
