import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config, applyOptions, collectConfigWarnings, onConfigApplied, pendingRestartChanges } from '../src/config.js';
import {
	configSchema,
	defaultConfig,
	describeConfigSchema,
	secretPaths,
	restartPaths,
	aliasPaths,
	isOption,
	isGroup,
} from '../src/configSchema.js';

const findingKeys = () => collectConfigWarnings().map((finding) => finding.key);

test('applyOptions overrides scalars and replaces arrays', () => {
	applyOptions({ ingress: { botPathPrefix: '/bot/' }, domains: ['a.com', 'b.com'] });
	assert.equal(config.ingress.botPathPrefix, '/bot/');
	assert.deepEqual(config.domains, ['a.com', 'b.com']);
});

test('applyOptions deep-merges nested objects', () => {
	applyOptions({ page: { ttl: 1000 }, origin: { securityToken: { value: 'secret' } } });
	assert.equal(config.page.ttl, 1000);
	// untouched nested keys keep defaults
	assert.equal(config.page.swrTtl, 3 * 60 * 60 * 1000);
	assert.equal(config.origin.securityToken.header, 'x-harper-renderer-bypass');
	assert.equal(config.origin.securityToken.value, 'secret');
});

test('applyOptions resets to defaults on each call (removed keys revert)', () => {
	applyOptions({ ingress: { botPathPrefix: '/x/' } });
	assert.equal(config.ingress.botPathPrefix, '/x/');
	applyOptions({});
	assert.equal(config.ingress.botPathPrefix, '/p/');
});

test('applyOptions rejects type-mismatched values and keeps defaults', () => {
	applyOptions({ ingress: { botPathPrefix: 123 }, domains: 'not-an-array', page: 'nope' });
	assert.equal(config.ingress.botPathPrefix, '/p/');
	assert.deepEqual(config.domains, []);
	assert.equal(config.page.ttl, 24 * 60 * 60 * 1000);
});

test('sitemap.userAgent defaults to the Harper sitemap crawler UA and is overridable', () => {
	applyOptions({});
	assert.equal(config.sitemap.userAgent, 'HarperSitemapCrawler/1.0');
	applyOptions({ sitemap: { userAgent: 'AcmeBot/2.0' } });
	assert.equal(config.sitemap.userAgent, 'AcmeBot/2.0');
});

test('proxy device UAs carry the HarperProxy product token', () => {
	applyOptions({});
	for (const ua of Object.values(config.origin.userAgents)) {
		assert.match(ua, /HarperProxy\/1\.0$/);
	}
});

test('applyOptions exposes analytics + cacheKey defaults', () => {
	applyOptions({});
	assert.equal(config.analytics.enabled, true);
	assert.equal(config.analytics.recordUnmatched, true);
	assert.ok(Array.isArray(config.analytics.bots) && config.analytics.bots.length > 0);
	assert.deepEqual(config.cacheKey.queryParams, ['page']);
});

test('applyOptions replaces the bots registry wholesale', () => {
	applyOptions({ analytics: { bots: [{ name: 'OnlyBot', match: 'onlybot' }] } });
	assert.deepEqual(config.analytics.bots, [{ name: 'OnlyBot', match: 'onlybot' }]);
	// scalar siblings keep their defaults
	assert.equal(config.analytics.enabled, true);
});

test('applyOptions ignores null/undefined overrides', () => {
	applyOptions({ ingress: { botPathPrefix: null } });
	assert.equal(config.ingress.botPathPrefix, '/p/');
});

test('applyOptions tolerates non-object input', () => {
	applyOptions(undefined);
	assert.equal(config.ingress.botPathPrefix, '/p/');
	applyOptions(null);
	assert.equal(config.ingress.botPathPrefix, '/p/');
});

test('applyOptions exposes ingress defaults', () => {
	applyOptions({});
	assert.equal(config.ingress.mode, 'prefix');
	assert.equal(config.ingress.deviceTypeSource, 'header');
	assert.equal(config.ingress.deviceTypeHeader, 'x-device-type');
	assert.equal(config.ingress.forwardedHostHeader, 'x-forwarded-host');
	assert.deepEqual(config.ingress.routes, []);
});

test('applyOptions accepts forwarded ingress overrides and replaces routes wholesale', () => {
	applyOptions({
		ingress: {
			mode: 'forwarded',
			deviceTypeSource: 'path',
			routes: [{ match: 'prefix', path: '/catalog/', queryParams: ['CN'] }],
		},
	});
	assert.equal(config.ingress.mode, 'forwarded');
	assert.equal(config.ingress.deviceTypeSource, 'path');
	// untouched nested keys keep defaults
	assert.equal(config.ingress.forwardedHostHeader, 'x-forwarded-host');
	assert.deepEqual(config.ingress.routes, [{ match: 'prefix', path: '/catalog/', queryParams: ['CN'] }]);
});

test('applyOptions exposes the unrouted-path report defaults', () => {
	applyOptions({});
	assert.equal(config.ingress.report.enabled, true);
	assert.equal(config.ingress.report.maxBuckets, 200);
	applyOptions({ ingress: { report: { maxBuckets: 5 } } });
	assert.equal(config.ingress.report.maxBuckets, 5);
	assert.equal(config.ingress.report.enabled, true); // untouched nested keys keep defaults
});

test('forwarded mode with no valid prerender route is reported as a finding', () => {
	// Nothing is prerendered in this state and nothing used to say so. It is also what a single
	// typo produces, since invalid entries are dropped one by one.
	applyOptions({ ingress: { mode: 'forwarded', routes: [{ match: 'typo', path: '/catalog/' }] } });
	assert.ok(findingKeys().includes('ingress.routes'));

	applyOptions({ ingress: { mode: 'forwarded', routes: [{ match: 'prefix', path: '/catalog/', queryParams: [] }] } });
	assert.equal(findingKeys().includes('ingress.routes'), false);
});

test('a passthrough-only route list still counts as having no prerender routes', () => {
	applyOptions({
		ingress: { mode: 'forwarded', routes: [{ match: 'prefix', path: '/orders/', mode: 'passthrough' }] },
	});
	assert.ok(findingKeys().includes('ingress.routes'));
});

test('prefix mode is not held to the prerender-route requirement', () => {
	// There is no route list to gate ingress in prefix mode — every request to botPathPrefix is
	// a prerender request by construction.
	applyOptions({});
	assert.equal(findingKeys().includes('ingress.routes'), false);
});

test('renderNow enabled without a token reports the feature as disabled', () => {
	// The warning is the operator's only signal that a feature they switched on is not actually
	// running, so it has to mirror the runtime gate: say DISABLED, not "DoS risk". The old wording
	// would send someone hunting an exposure that no longer exists, and anything that reads as
	// "enabled" would hide the fact that nothing is on.
	applyOptions({ renderNow: { enabled: true } });
	const finding = collectConfigWarnings().find((f) => f.key === 'renderNow.token');
	assert.ok(finding, 'expected a renderNow.token finding');
	assert.match(finding.message, /DISABLED/);
	assert.match(finding.message, /fail closed/);
});

test('an unresolved renderNow valueEnv is named in the warning', () => {
	// Naming the variable is the difference between a five-second fix and a hunt: config.js only
	// assigns from the environment when the variable is set, so a typo silently leaves token empty.
	delete process.env.__TEST_RENDER_NOW_ABSENT;
	applyOptions({ renderNow: { enabled: true, valueEnv: '__TEST_RENDER_NOW_ABSENT' } });
	const finding = collectConfigWarnings().find((f) => f.key === 'renderNow.token');
	assert.ok(finding, 'expected a renderNow.token finding');
	assert.match(finding.message, /__TEST_RENDER_NOW_ABSENT/);
	assert.match(finding.message, /DISABLED/);
});

test('renderNow with a token reports nothing', () => {
	applyOptions({ renderNow: { enabled: true, token: 'a-real-secret' } });
	assert.equal(findingKeys().includes('renderNow.token'), false);
});

test('peerRescue enabled without a token reports the feature as disabled', () => {
	// Same contract as the renderNow finding: mirror the runtime gate (both the rescue client and
	// the /prerender_peer/page endpoint fail closed), so the operator learns the feature is OFF
	// rather than hunting a nonexistent exposure.
	applyOptions({ peerRescue: { enabled: true } });
	const finding = collectConfigWarnings().find((f) => f.key === 'peerRescue.token');
	assert.ok(finding, 'expected a peerRescue.token finding');
	assert.match(finding.message, /DISABLED/);
	assert.match(finding.message, /fails closed/);
});

test('an unresolved peerRescue valueEnv is named in the warning', () => {
	delete process.env.__TEST_PEER_RESCUE_ABSENT;
	applyOptions({ peerRescue: { enabled: true, valueEnv: '__TEST_PEER_RESCUE_ABSENT' } });
	const finding = collectConfigWarnings().find((f) => f.key === 'peerRescue.token');
	assert.ok(finding, 'expected a peerRescue.token finding');
	assert.match(finding.message, /__TEST_PEER_RESCUE_ABSENT/);
	assert.match(finding.message, /DISABLED/);
});

test('peerRescue with a token reports nothing, and valueEnv overrides the literal', () => {
	process.env.__TEST_PEER_RESCUE_TOKEN = 'env-cluster-secret';
	try {
		applyOptions({ peerRescue: { enabled: true, token: 'literal', valueEnv: '__TEST_PEER_RESCUE_TOKEN' } });
		assert.equal(findingKeys().includes('peerRescue.token'), false);
		assert.equal(config.peerRescue.token, 'env-cluster-secret');
	} finally {
		delete process.env.__TEST_PEER_RESCUE_TOKEN;
	}
});

test('applyOptions sources the security token from valueEnv (overriding the literal)', () => {
	process.env.__TEST_PR_TOKEN = 'env-secret';
	try {
		applyOptions({ origin: { securityToken: { value: 'literal', valueEnv: '__TEST_PR_TOKEN' } } });
		assert.equal(config.origin.securityToken.value, 'env-secret');
	} finally {
		delete process.env.__TEST_PR_TOKEN;
	}
});

test('applyOptions keeps the literal token when valueEnv is unset or missing', () => {
	applyOptions({ origin: { securityToken: { value: 'literal', valueEnv: '__MISSING_ENV__' } } });
	assert.equal(config.origin.securityToken.value, 'literal');
});

/*
 * An empty cacheKey.delimiter passes mergeInto's typeof check (it IS a string) but cannot be
 * honored: `toCacheKey` would concatenate with no separator, `parse` would split on '' into
 * individual characters, and every jitter seed would become '' — collapsing the whole render
 * schedule onto one minute. The schema marks it `nonEmpty`, so it is rejected outright rather
 * than merely warned about.
 */
test('applyOptions rejects an empty cacheKey.delimiter and keeps the default', () => {
	applyOptions({ cacheKey: { delimiter: '' } });
	assert.equal(config.cacheKey.delimiter, '|');
});

test('applyOptions still honors a non-empty cacheKey.delimiter override', () => {
	applyOptions({ cacheKey: { delimiter: '::' } });
	assert.equal(config.cacheKey.delimiter, '::');
});

// ---------------------------------------------------------------------------
// Schema-driven behavior
// ---------------------------------------------------------------------------

test('every option in the schema has a description, and every group too', () => {
	const walk = (node, path) => {
		assert.ok(
			typeof node.description === 'string' && node.description.length > 0,
			`missing description at ${path || '<root>'}`
		);
		if (isGroup(node)) {
			for (const [key, child] of Object.entries(node.children)) walk(child, path ? `${path}.${key}` : key);
		} else {
			assert.ok(isOption(node), `node at ${path} is neither option nor group`);
			assert.ok(['live', 'restart', undefined].includes(node.scope), `bad scope at ${path}`);
		}
	};
	walk(configSchema, '');
});

test('defaultConfig returns fresh deep copies (no shared references)', () => {
	const a = defaultConfig();
	const b = defaultConfig();
	assert.notEqual(a.analytics.bots, b.analytics.bots);
	a.analytics.bots.push({ name: 'X', match: 'x' });
	assert.notEqual(a.analytics.bots.length, b.analytics.bots.length);
});

test('secret and restart paths are what the schema declares', () => {
	assert.deepEqual(secretPaths().sort(), ['origin.securityToken.value', 'peerRescue.token', 'renderNow.token']);
	assert.deepEqual(restartPaths().sort(), [
		// Boot-shaped like the reconciler's: they only shape the probe scheduler's first arming.
		'changeProbe.startDelay',
		'changeProbe.startJitter',
		'origin.maxResponseHeaderBytes',
		// The render-lease shared buffer is sized by the first allocation in the process, so a live
		// change would give workers in one generation differently-sized views of the same buffer.
		'queue.maxLeases',
		// Same reason, same mechanism: the ready set is a named shared buffer too.
		'queue.ready.capacity',
		'render.reconcile.startDelay',
		'render.reconcile.startJitter',
	]);
});

test('describeConfigSchema is JSON-serializable and carries the editor contract', () => {
	const described = JSON.parse(JSON.stringify(describeConfigSchema()));
	assert.equal(described.kind, 'group');
	const mode = described.children.ingress.children.mode;
	assert.equal(mode.kind, 'option');
	assert.equal(mode.type, 'string');
	assert.deepEqual(mode.enum, ['prefix', 'forwarded']);
	assert.equal(mode.scope, 'live');
	assert.equal(described.children.origin.children.securityToken.children.value.secret, true);
	assert.equal(described.children.render.children.reconcile.children.startDelay.scope, 'restart');
	assert.equal(described.children.page.children.ttl.unit, 'ms');
	assert.equal(described.children.sitemap.children.userAgent.movedFrom, 'sitemapUserAgent');
});

test('enum violations are rejected and keep the default', () => {
	applyOptions({ ingress: { mode: 'sideways' }, renderNow: { fallback: 'explode' } });
	assert.equal(config.ingress.mode, 'prefix');
	assert.equal(config.renderNow.fallback, 'origin');
});

test('numeric bounds are enforced', () => {
	applyOptions({ sitemap: { filteredWarnPercent: 200 }, queue: { maxClaimLimit: 0 } });
	assert.equal(config.sitemap.filteredWarnPercent, 50);
	assert.equal(config.queue.maxClaimLimit, 25);
});

test('empty strings are rejected for nonEmpty header names and refresh time/zone', () => {
	applyOptions({
		origin: { securityToken: { header: '' } },
		debugHeader: { key: '' },
		sitemap: { refreshTime: '', timezone: '' },
	});
	assert.equal(config.origin.securityToken.header, 'x-harper-renderer-bypass');
	assert.equal(config.debugHeader.key, 'x-harper-prerender-debug');
	assert.equal(config.sitemap.refreshTime, '12:00');
	assert.equal(config.sitemap.timezone, 'America/New_York');
});

test('an empty deviceTypes.supported is rejected (the fallback device is its first entry)', () => {
	applyOptions({ deviceTypes: { supported: [] } });
	assert.deepEqual(config.deviceTypes.supported, ['desktop', 'mobile', 'tablet']);
});

// ---------------------------------------------------------------------------
// Legacy path aliases (pre-v0.25.0 layout)
// ---------------------------------------------------------------------------

test('the alias map covers the v0.25.0 reorganization', () => {
	assert.deepEqual(aliasPaths(), {
		'botPathPrefix': 'ingress.botPathPrefix',
		'excludePathPatterns': 'ingress.excludePathPatterns',
		'url.queryParams': 'cacheKey.queryParams',
		'securityToken': 'origin.securityToken',
		'staging': 'origin.staging',
		'userAgents': 'origin.userAgents',
		'ignoredHeaders': 'origin.ignoredHeaders',
		'sitemapUserAgent': 'sitemap.userAgent',
	});
});

test('legacy option paths still apply (with the new location winning when both are set)', () => {
	applyOptions({
		botPathPrefix: '/legacy/',
		url: { queryParams: ['*'] },
		securityToken: { value: 'legacy-secret' },
		staging: { ip: '192.0.2.9' },
		ignoredHeaders: ['x-old'],
		sitemapUserAgent: 'LegacyBot/1.0',
		excludePathPatterns: ['/old-search/'],
	});
	assert.equal(config.ingress.botPathPrefix, '/legacy/');
	assert.deepEqual(config.cacheKey.queryParams, ['*']);
	assert.equal(config.origin.securityToken.value, 'legacy-secret');
	assert.equal(config.origin.staging.ip, '192.0.2.9');
	assert.deepEqual(config.origin.ignoredHeaders, ['x-old']);
	assert.equal(config.sitemap.userAgent, 'LegacyBot/1.0');
	assert.deepEqual(config.ingress.excludePathPatterns, ['/old-search/']);

	// When both old and new paths are set, the new path wins.
	applyOptions({ botPathPrefix: '/legacy/', ingress: { botPathPrefix: '/new/' } });
	assert.equal(config.ingress.botPathPrefix, '/new/');
});

test('a legacy group emptied by remapping does not warn as an unknown key', () => {
	const warnings = [];
	const original = console.warn;
	console.warn = (msg) => warnings.push(String(msg));
	try {
		applyOptions({ url: { queryParams: ['page'] } });
	} finally {
		console.warn = original;
	}
	assert.equal(
		warnings.some((w) => w.includes('Unknown configuration key')),
		false,
		warnings.join('\n')
	);
	assert.ok(warnings.some((w) => w.includes('prerender.url.queryParams moved to prerender.cacheKey.queryParams')));
});

// ---------------------------------------------------------------------------
// Restart-scoped change tracking + change listeners
// ---------------------------------------------------------------------------

test('a live re-apply of a restart-scoped option is reported as pending-restart', () => {
	applyOptions({});
	assert.deepEqual(pendingRestartChanges(), []);

	applyOptions({ render: { reconcile: { startDelay: 1234 } } });
	const pending = pendingRestartChanges();
	assert.equal(pending.length, 1);
	assert.equal(pending[0].key, 'render.reconcile.startDelay');
	assert.equal(pending[0].value, 1234);
	// The live config carries the new value; only the running behavior lags.
	assert.equal(config.render.reconcile.startDelay, 1234);

	// Reverting to the boot value clears the pending entry.
	applyOptions({});
	assert.deepEqual(pendingRestartChanges(), []);
});

test('live-scoped changes are never reported as pending-restart', () => {
	applyOptions({ render: { reconcile: { interval: 60000 } }, queue: { statusSyncInterval: 5000 } });
	assert.deepEqual(pendingRestartChanges(), []);
	applyOptions({});
});

test('onConfigApplied listeners fire on every apply with (config, previous)', () => {
	const calls = [];
	onConfigApplied((live, previous) => calls.push({ live, previous }));

	applyOptions({ page: { ttl: 777 } });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].live, config); // same live reference
	assert.equal(calls[0].live.page.ttl, 777);
	assert.notEqual(calls[0].previous.page.ttl, 777); // snapshot of the state before

	applyOptions({});
	assert.equal(calls.length, 2);
	assert.equal(calls[1].previous.page.ttl, 777);
});

test('a throwing listener does not break the apply or other listeners', () => {
	let ran = false;
	onConfigApplied(() => {
		throw new Error('boom');
	});
	onConfigApplied(() => {
		ran = true;
	});
	applyOptions({ page: { ttl: 888 } });
	assert.equal(config.page.ttl, 888);
	assert.equal(ran, true);
	applyOptions({});
});
