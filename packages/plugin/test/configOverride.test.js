/**
 * The stored-override layer's door and its change detector.
 *
 * `validateOverride` is that door: `resolveConfig` would catch a bad value anyway, but only after
 * the row has landed and the console is listing a setting the cluster is not honouring, so the
 * same rules are enforced here and the write is refused with a reason an operator can act on.
 * `fingerprintOverrides` is what keeps the backstop poll from re-arming every scheduler on a
 * re-read that found nothing new, and `inspectRoutes` is what stops a config preview from
 * confirming a route the compiler is about to drop.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyOptions } from '../src/config.js';
import {
	fingerprintOverrides,
	overridesEnabledFor,
	readOverrides,
	validateOverride,
	writeOverrides,
} from '../src/util/configOverride.js';
import { inspectRoutes } from '../src/util/routeClass.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * 60 * 1000;

// Harper's `logger` is absent out here and both modules fall back to `console`; capturing it keeps
// the deliberate failures quiet AND makes "reports without logging" assertable.
const logged = [];
globalThis.logger = { debug() {}, info() {}, warn: (message) => logged.push(String(message)), error() {} };

const reasonFor = (path, value) => {
	const verdict = validateOverride(path, value);
	assert.equal(verdict.ok, false, `${path} should have been refused`);
	return verdict.reason;
};

beforeEach(() => {
	applyOptions({});
	logged.length = 0;
	delete globalThis.databases;
});

// ---- validateOverride: what may be written -----------------------------------------------------

test('validateOverride accepts a well-formed value and hands back the schema node behind it', () => {
	const verdict = validateOverride('page.ttl', 7000);
	assert.equal(verdict.ok, true);
	assert.equal(verdict.value, 7000);
	assert.equal(verdict.node.default, DAY);

	assert.equal(validateOverride('domains', ['example.com']).ok, true);
	assert.equal(validateOverride('ingress.mode', 'forwarded').ok, true);
	assert.equal(validateOverride('management.proxyToOwner', false).ok, true);
});

test('validateOverride refuses a path the schema does not have', () => {
	assert.match(reasonFor('nope.not.a.path', 1), /nope\.not\.a\.path is not a configuration option/);
	// A stale row under a valid group is the realistic case: the option was renamed a release ago.
	assert.match(reasonFor('queue.somethingRenamed', 1), /queue\.somethingRenamed is not a configuration option/);
});

test('validateOverride refuses a group path rather than writing a subtree through one row', () => {
	assert.match(reasonFor('page', {}), /page is a group of options, not a single option/);
	assert.match(reasonFor('origin.securityToken', {}), /is a group of options/);
});

test('validateOverride refuses a secret and points at the environment variable instead', () => {
	const reason = reasonFor('origin.securityToken.value', 'a-token');
	assert.match(reason, /origin\.securityToken\.value is a secret/);
	assert.match(reason, /environment variable/);

	for (const path of ['renderNow.token', 'peerRescue.token']) {
		assert.match(reasonFor(path, 'a-token'), /is a secret/);
	}
});

test('validateOverride refuses management.enabled — one click must not take the console away', () => {
	assert.match(reasonFor('management.enabled', false), /management\.enabled is deliberately not editable/);
});

test('validateOverride refuses everything under management.overrides — the console cannot edit its own machinery', () => {
	// The kill switch especially: an override you need to undo is a poor thing to undo through the
	// override layer.
	assert.match(
		reasonFor('management.overrides.enabled', false),
		/management\.overrides\.enabled is deliberately not editable/
	);
	assert.match(reasonFor('management.overrides.subscribe', false), /is deliberately not editable/);
	assert.match(reasonFor('management.overrides.syncInterval', 0), /is deliberately not editable/);
});

test('each refusal reason is distinct and names the path an operator has to fix', () => {
	const refusals = [
		['nope.not.a.path', 1],
		['page', {}],
		['origin.securityToken.value', 'a-token'],
		['management.enabled', false],
		['management.overrides.enabled', false],
	];

	const reasons = refusals.map(([path, value]) => reasonFor(path, value));
	for (const [index, [path]] of refusals.entries()) {
		assert.ok(reasons[index].startsWith(path), `${path}: the reason must name the path — got "${reasons[index]}"`);
	}
	assert.equal(new Set(reasons).size, refusals.length, `each refusal needs its own reason: ${reasons.join(' | ')}`);
});

// ---- validateOverride: what the value itself may be ---------------------------------------------

test('validateOverride refuses a value of the wrong type', () => {
	assert.match(reasonFor('page.ttl', 'lots'), /page\.ttl: expected number, got string/);
	assert.match(reasonFor('domains', 'example.com'), /domains: expected array, got string/);
	assert.match(reasonFor('ingress.mode', 42), /ingress\.mode: expected string, got number/);
	assert.match(reasonFor('management.proxyToOwner', 'yes'), /expected boolean, got string/);
});

test('validateOverride refuses out-of-range and non-finite numbers', () => {
	assert.match(reasonFor('queue.jobLeaseTime', 1), /queue\.jobLeaseTime: must be >= 120000/);
	assert.match(reasonFor('sitemap.filteredWarnPercent', 1000), /sitemap\.filteredWarnPercent: must be <= 100/);
	assert.match(reasonFor('queue.jobLeaseTime', Number.POSITIVE_INFINITY), /must be a finite number/);
	assert.match(reasonFor('queue.jobLeaseTime', Number.NaN), /must be a finite number/);
});

test('validateOverride refuses a bad enum value and a bad itemEnum entry, naming what is allowed', () => {
	assert.match(reasonFor('ingress.mode', 'sideways'), /ingress\.mode: must be one of 'prefix' \| 'forwarded'/);
	// Whole-list rejection: a rogue entry here decodes a separator into every cache key.
	assert.match(reasonFor('cacheKey.decodeReserved', [':', '&']), /cacheKey\.decodeReserved: '&' not allowed here/);
});

test('validateOverride refuses an empty value for an option marked nonEmpty', () => {
	assert.match(reasonFor('cacheKey.delimiter', ''), /cacheKey\.delimiter: must not be empty/);
	assert.match(reasonFor('cacheKey.attributes', []), /cacheKey\.attributes: must not be empty/);
	// An option without the marker may legitimately be emptied.
	assert.equal(validateOverride('domains', []).ok, true);
});

test('validateOverride refuses null and undefined, and says to clear the row instead', () => {
	// Storing them would be a row that exists, lists in the console, and does nothing.
	assert.match(reasonFor('page.ttl', undefined), /no value — to remove an override, clear it instead/);
	assert.match(reasonFor('page.ttl', null), /no value — to remove an override, clear it instead/);
});

// ---- change detection ---------------------------------------------------------------------------

test('fingerprintOverrides is stable regardless of key insertion order', () => {
	const first = fingerprintOverrides({ 'queue.jobLeaseTime': 15 * MINUTE, 'page.ttl': 7000 });
	const second = fingerprintOverrides({ 'page.ttl': 7000, 'queue.jobLeaseTime': 15 * MINUTE });
	assert.equal(first, second, 'row order out of a table read must not look like a change');
	assert.equal(fingerprintOverrides({}), fingerprintOverrides(null));
	assert.equal(fingerprintOverrides(undefined), fingerprintOverrides({}));
});

test('fingerprintOverrides changes whenever a value, a path or the set itself changes', () => {
	const base = fingerprintOverrides({ 'page.ttl': 7000 });

	assert.notEqual(base, fingerprintOverrides({ 'page.ttl': 7001 }), 'a changed value must be seen');
	assert.notEqual(base, fingerprintOverrides({ 'page.swrTtl': 7000 }), 'a moved path must be seen');
	assert.notEqual(base, fingerprintOverrides({ 'page.ttl': 7000, 'domains': ['a'] }), 'an added row must be seen');
	assert.notEqual(base, fingerprintOverrides({}), 'a cleared row must be seen');
	assert.notEqual(
		fingerprintOverrides({ 'ingress.routes': [{ match: 'prefix', path: '/a/' }] }),
		fingerprintOverrides({ 'ingress.routes': [{ match: 'prefix', path: '/b/' }] }),
		'a change inside a structured value must be seen'
	);
});

test('overridesEnabledFor reads the kill switch from the file layer, where an override cannot reach it', () => {
	assert.equal(overridesEnabledFor({}), true);
	assert.equal(overridesEnabledFor({ management: { overrides: { enabled: false } } }), false);

	// A row for the switch is refused at the door...
	assert.equal(validateOverride('management.overrides.enabled', false).ok, false);
	// ...and the decision is resolved from the file layer alone, so even a row that got in some
	// other way cannot switch off the thing that would be needed to switch it back on.
	applyOptions({}, { 'management.overrides.enabled': false });
	assert.equal(overridesEnabledFor({}), true);
	assert.equal(overridesEnabledFor({ management: { overrides: { enabled: false } } }), false);
});

// ---- route preview -------------------------------------------------------------------------------

test('inspectRoutes counts prerender and passthrough entries and reports invalid ones as dropped', () => {
	const result = inspectRoutes(
		[
			{ match: 'prefix', path: '/ok/' },
			{ match: 'prefix', path: '/pass/', mode: 'passthrough' },
			{ match: 'nope', path: '/bad/' }, // invalid match
			{ match: 'exact', path: 'no-slash' }, // exact/prefix must be rooted
			{ match: 'prefix', path: '/bad-mode/', mode: 'sometimes' }, // invalid mode
			{ match: 'prefix' }, // no path
		],
		['/search/']
	);

	assert.equal(result.dropped, 4, 'an entry the compiler refuses must be reported, not silently absent');
	assert.equal(result.prerender, 1);
	assert.equal(result.passthrough, 2, 'the exclude pattern folds in as a passthrough entry');
	assert.equal(result.total, 3);
	assert.ok(
		result.warnings.some((line) => line.includes('Ignoring 4 invalid ingress route(s)')),
		result.warnings.join('\n')
	);
});

test('inspectRoutes reports through its return value and logs nothing', () => {
	// A preview must not write into the http log: nothing is being applied.
	const result = inspectRoutes([{ match: 'nope', path: '/bad/' }], ['?utm=']);

	assert.equal(result.dropped, 1);
	assert.ok(
		result.warnings.some((line) => line.includes('never match')),
		result.warnings.join('\n')
	);
	assert.deepEqual(logged, [], `inspectRoutes logged instead of returning: ${logged.join('\n')}`);
});

test('inspectRoutes counts a blank exclude pattern as absent rather than as a drop', () => {
	// The compiler skips blanks before ever trying to compile them, so counting them as drops would
	// report a problem that does not exist.
	const result = inspectRoutes([], ['', null, '/search/']);
	assert.equal(result.dropped, 0);
	assert.equal(result.passthrough, 1);
	assert.deepEqual(result.warnings, []);
});

// ---- the table-backed paths (Harper `databases` global stubbed) -----------------------------------

test('readOverrides maps rows to a path -> value set, skipping a row that carries no value', async () => {
	const calls = [];
	globalThis.databases = {
		render_service: {
			ConfigOverride: {
				search: (...args) => {
					calls.push(args);
					return (async function* () {
						yield { path: 'page.ttl', value: 7000 };
						yield { path: 'queue.jobLeaseTime', value: 15 * MINUTE };
						yield { path: 'page.swrTtl' }; // a row that says nothing
						yield { value: 'no path at all' };
					})();
				},
			},
		},
	};

	const read = await readOverrides();

	assert.deepEqual(read.overrides, { 'page.ttl': 7000, 'queue.jobLeaseTime': 15 * MINUTE });
	assert.equal(read.degraded, false);
	assert.equal(read.truncated, false);
	assert.equal(read.error, null);
	// The read must never take Harper's replication fetch, which has no timeout at all.
	assert.ok(
		calls.flat().some((argument) => argument && argument.replicateFrom === false),
		`replicateFrom: false was not passed: ${JSON.stringify(calls)}`
	);
});

test('readOverrides fails open: a table that throws leaves the deployed config running', async () => {
	globalThis.databases = {
		render_service: {
			ConfigOverride: {
				search: () => {
					throw new Error('store closed');
				},
			},
		},
	};

	const read = await readOverrides();

	// Boot's choice is between running config.yaml and not loading the component at all.
	assert.deepEqual(read.overrides, {});
	assert.equal(read.degraded, true, 'the caller has to be able to say the layer is not being honoured');
	assert.equal(read.error, 'store closed');
	assert.ok(
		logged.some((line) => line.includes('Could not read stored config overrides')),
		logged.join('\n')
	);
});

test('writeOverrides validates the whole batch before writing any of it', async () => {
	const puts = [];
	const deletes = [];
	globalThis.databases = {
		render_service: {
			ConfigOverride: {
				put: (path, row) => puts.push([path, row]),
				delete: (path) => deletes.push(path),
			},
		},
	};

	await assert.rejects(
		writeOverrides({
			set: [
				{ path: 'page.ttl', value: 7000 },
				{ path: 'ingress.mode', value: 'sideways' },
			],
			clear: ['page.swrTtl'],
		}),
		/ingress\.mode: must be one of/
	);
	// A half-applied batch is a config that is neither the old one nor the requested one, and
	// nobody would know which half landed.
	assert.deepEqual(puts, [], 'nothing may be written when any entry is invalid');
	assert.deepEqual(deletes, [], 'nothing may be cleared when any entry is invalid');

	const result = await writeOverrides({
		set: [{ path: 'page.ttl', value: 7000 }],
		clear: ['page.swrTtl'],
		updatedBy: 'operator',
	});

	assert.deepEqual(result, { written: ['page.ttl'], cleared: ['page.swrTtl'] });
	assert.deepEqual(deletes, ['page.swrTtl']);
	assert.equal(puts.length, 1);
	assert.equal(puts[0][0], 'page.ttl');
	assert.equal(puts[0][1].value, 7000);
	assert.equal(puts[0][1].updatedBy, 'operator');
});
