/**
 * An override row holds a WHOLE option, and a list is one option: one route edited from the console
 * stores a copy of every route, and from then on a config.yaml edit to any route deploys and is
 * merged away with nothing to say so. So each row records a hash of the file's value when it is
 * written (`fileHash`), and the layers view reports per row:
 *
 *   masking    the override is in effect and the file has changed since it was written
 *              (null: the row predates the record, so it is unknown)
 *   redundant  the override equals the file now, so clearing it changes nothing
 *
 * A masking row is also logged on every apply and served as a warning.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
	applyOptions,
	collectOverrideWarnings,
	describeConfigLayers,
	fileLayerHashes,
	hashConfigValue,
} from '../src/config.js';
import {
	fingerprintOverrides,
	readOverrides,
	resetOverrideWatchForTests,
	startOverrideWatch,
	writeOverrides,
} from '../src/util/configOverride.js';

const logged = [];
globalThis.logger = { debug() {}, info() {}, warn: (message) => logged.push(String(message)), error() {} };

const layerFor = (path) => describeConfigLayers().find((row) => row.path === path);

const ROUTES_A = [
	{ match: 'prefix', path: '/catalog/' },
	{ match: 'prefix', path: '/product/' },
];
// The deploy nobody saw: a route added to config.yaml after the override was written.
const ROUTES_B = [...ROUTES_A, { match: 'prefix', path: '/store/' }];
// The console edit: one route's interval changed, which stored a copy of the whole list.
const OVERRIDE = [{ match: 'prefix', path: '/catalog/', renderInterval: 3_600_000 }, ROUTES_A[1]];

const fileWith = (routes) => ({ ingress: { mode: 'forwarded', routes } });

beforeEach(() => {
	applyOptions({});
	logged.length = 0;
});

afterEach(() => {
	resetOverrideWatchForTests();
	delete globalThis.databases;
});

test('hashConfigValue is stable across key order and tells different values apart', () => {
	assert.equal(hashConfigValue({ a: 1, b: [1, { c: 2, d: 3 }] }), hashConfigValue({ b: [1, { d: 3, c: 2 }], a: 1 }));
	assert.notEqual(hashConfigValue(ROUTES_A), hashConfigValue(ROUTES_B));
	assert.notEqual(hashConfigValue([1, 2]), hashConfigValue([2, 1]), 'list order is meaning, not formatting');
	assert.equal(hashConfigValue(undefined), hashConfigValue(null));
});

test('an override written against the current file is not masking, and not redundant while it differs', () => {
	applyOptions(fileWith(ROUTES_A), { 'ingress.routes': OVERRIDE }, { 'ingress.routes': hashConfigValue(ROUTES_A) });
	const row = layerFor('ingress.routes');
	assert.equal(row.source, 'override');
	assert.equal(row.masking, false);
	assert.equal(row.redundant, false);
	assert.deepEqual(collectOverrideWarnings(), []);
	assert.ok(!logged.some((line) => line.includes('masking')), logged.join('\n'));
});

test('a config.yaml change under an override is reported as masking, logged, and served as a warning', () => {
	const recorded = { 'ingress.routes': hashConfigValue(ROUTES_A) };
	applyOptions(fileWith(ROUTES_B), { 'ingress.routes': OVERRIDE }, recorded);

	const row = layerFor('ingress.routes');
	assert.equal(row.source, 'override', 'the override still wins');
	assert.equal(row.masking, true);
	assert.equal(row.redundant, false);
	assert.deepEqual(row.file, ROUTES_B, 'the layers view shows the file value being masked');

	const findings = collectOverrideWarnings();
	assert.equal(findings.length, 1);
	assert.equal(findings[0].severity, 'warn');
	assert.equal(findings[0].key, 'ingress.routes');
	assert.match(findings[0].message, /masking a config\.yaml change/);
	assert.ok(
		logged.some((line) => line.includes('ingress.routes') && line.includes('masking a config.yaml change')),
		`the apply must log it: ${logged.join('\n')}`
	);
});

test('an override the file has caught up with is redundant, not masking, and reported as safe to clear', () => {
	applyOptions(fileWith(OVERRIDE), { 'ingress.routes': OVERRIDE }, { 'ingress.routes': hashConfigValue(ROUTES_A) });
	const row = layerFor('ingress.routes');
	assert.equal(row.redundant, true);
	assert.equal(row.masking, false, 'nothing is hidden when the two say the same thing');
	const [finding] = collectOverrideWarnings();
	assert.equal(finding.severity, 'info');
	assert.match(finding.message, /clearing it changes nothing/);
	assert.ok(!logged.some((line) => line.includes('masking')), logged.join('\n'));
});

test('a row written before the record existed is masking: null — unknown, never guessed', () => {
	applyOptions(fileWith(ROUTES_B), { 'ingress.routes': OVERRIDE }, { 'ingress.routes': null });
	assert.equal(layerFor('ingress.routes').masking, null);
	assert.equal(layerFor('ingress.routes').redundant, false);
	// No record at all (a caller that passes none) is the same answer.
	applyOptions(fileWith(ROUTES_B), { 'ingress.routes': OVERRIDE });
	assert.equal(layerFor('ingress.routes').masking, null);
	assert.deepEqual(collectOverrideWarnings(), []);
});

test('an override that is not in effect is not masking: the file value is what runs', () => {
	applyOptions({ page: { ttl: 5000 } }, { 'page.ttl': 'lots' }, { 'page.ttl': hashConfigValue(1) });
	const row = layerFor('page.ttl');
	assert.equal(row.source, 'override-rejected');
	assert.equal(row.masking, false);
});

test('an option nobody overrode carries neither flag', () => {
	applyOptions(fileWith(ROUTES_A), {});
	const row = layerFor('ingress.routes');
	assert.equal(row.masking, undefined);
	assert.equal(row.redundant, undefined);
});

test('a stored override under a moved path is judged against the record kept under its old path', () => {
	// `movedFrom` aliases remap a legacy row onto its current path; the record has to follow it.
	applyOptions(
		{ cacheKey: { queryParams: ['a'] } },
		{ 'url.queryParams': ['b'] },
		{ 'url.queryParams': hashConfigValue(['z']) }
	);
	assert.equal(layerFor('cacheKey.queryParams').source, 'override');
	assert.equal(layerFor('cacheKey.queryParams').masking, true);
});

test('writeOverrides records the file layer’s value hash on each row it writes', async () => {
	applyOptions(fileWith(ROUTES_A));
	const puts = [];
	globalThis.databases = {
		config: { ConfigOverride: { put: (path, row) => puts.push([path, row]), delete() {} } },
	};

	await writeOverrides({
		set: [
			{ path: 'ingress.routes', value: OVERRIDE },
			{ path: 'page.ttl', value: 7000 },
		],
	});

	assert.deepEqual(fileLayerHashes(['ingress.routes']), { 'ingress.routes': hashConfigValue(ROUTES_A) });
	assert.equal(puts[0][1].fileHash, hashConfigValue(ROUTES_A));
	// The file never set page.ttl, so its file-layer value is the schema default.
	assert.equal(puts[1][1].fileHash, hashConfigValue(24 * 60 * 60 * 1000));
});

test('readOverrides hands back each row’s recorded hash, null where a row has none', async () => {
	globalThis.databases = {
		config: {
			ConfigOverride: {
				search: (query) => {
					assert.ok(query.select.includes('fileHash'), 'the read must select the record');
					return (async function* () {
						yield { path: 'ingress.routes', value: OVERRIDE, fileHash: 'abc' };
						yield { path: 'page.ttl', value: 7000 };
					})();
				},
			},
		},
	};
	const read = await readOverrides();
	assert.deepEqual(read.recorded, { 'ingress.routes': 'abc', 'page.ttl': null });
});

test('re-saving the same value against a newer file is a change every worker must pick up', () => {
	const overrides = { 'ingress.routes': OVERRIDE };
	assert.notEqual(
		fingerprintOverrides(overrides, { 'ingress.routes': hashConfigValue(ROUTES_A) }),
		fingerprintOverrides(overrides, { 'ingress.routes': hashConfigValue(ROUTES_B) }),
		'otherwise every other worker keeps reporting a row the operator just re-confirmed as masking'
	);
	assert.equal(fingerprintOverrides(overrides), fingerprintOverrides(overrides, {}));
});

test('the watcher hands the recorded hashes to its apply', async () => {
	globalThis.databases = {
		config: {
			ConfigOverride: {
				subscribe: async () => {},
				search: () =>
					(async function* () {
						yield { path: 'ingress.routes', value: OVERRIDE, fileHash: 'abc' };
					})(),
			},
		},
	};
	const applies = [];
	await startOverrideWatch((overrides, recorded) => applies.push({ overrides, recorded }), {
		enabled: true,
		subscribe: false,
		syncInterval: 5,
	});
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.ok(applies.length >= 1);
	assert.deepEqual(applies[0].recorded, { 'ingress.routes': 'abc' });
});
