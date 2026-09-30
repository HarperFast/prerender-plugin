/**
 * Schema limits that exist because the value would otherwise do harm rather than nothing. Each is
 * checked at both doors: the apply-time constraint pass (`resolveConfig`, which serves config.yaml
 * and the stored overrides alike) and the override write path (`validateOverride`), which must
 * refuse the same values or it stores rows the merge then ignores.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../src/config.js';
import { validateOverride } from '../src/util/configOverride.js';

globalThis.logger = { debug() {}, info() {}, warn() {}, error() {} };

const DAY = 24 * 60 * 60 * 1000;
const TIMER_CEILING = 2147483647;

const nest = (path, value) => {
	const out = {};
	let node = out;
	const segments = path.split('.');
	for (const segment of segments.slice(0, -1)) node = node[segment] = {};
	node[segments.at(-1)] = value;
	return out;
};
const valueAt = (obj, path) => path.split('.').reduce((node, key) => node?.[key], obj);

/** The value `resolveConfig` keeps for `path` when the file sets `value`, and what it said about it. */
const resolveOne = (path, value) => {
	const { config, warnings } = resolveConfig(nest(path, value), null);
	return { kept: valueAt(config, path), warnings: warnings.filter((w) => w.includes(path)) };
};

const defaultOf = (path) => valueAt(resolveConfig({}, null).config, path);

test('the four timer intervals refuse a value past node’s timer ceiling, at both doors', async () => {
	// Past 2^31-1 ms a timer does not fire late or never: node warns and fires it after 1ms. So "30 days,
	// effectively off" arms a loop that fires continuously. Measured here first, so the premise is pinned
	// rather than assumed.
	let fires = 0;
	const originalEmit = process.emitWarning;
	process.emitWarning = () => {};
	const loop = setInterval(() => fires++, 30 * DAY);
	await new Promise((resolve) => setTimeout(resolve, 50));
	clearInterval(loop);
	process.emitWarning = originalEmit;
	assert.ok(fires > 5, `an over-ceiling interval fired ${fires} times in 50ms`);

	for (const path of [
		'ingress.report.interval',
		'management.backlogSnapshotInterval',
		'render.reconcile.interval',
		'queue.statusSyncInterval',
	]) {
		const { kept, warnings } = resolveOne(path, 30 * DAY);
		assert.equal(kept, defaultOf(path), `${path}: an over-ceiling value must not be armed`);
		assert.ok(
			warnings.some((w) => w.includes(`must be <= ${TIMER_CEILING}`)),
			`${path}: ${warnings.join('\n')}`
		);
		assert.equal(resolveOne(path, TIMER_CEILING).kept, TIMER_CEILING, `${path}: the ceiling itself is fine`);

		const verdict = validateOverride(path, 30 * DAY);
		assert.equal(verdict.ok, false, `${path}: the override door must refuse it too`);
		assert.match(verdict.reason, new RegExp(`must be <= ${TIMER_CEILING}`));
	}
});

test('render.negative.statuses takes only integer 4xx statuses other than 429, whole list or nothing', () => {
	const path = 'render.negative.statuses';
	assert.deepEqual(resolveOne(path, [404, 410]).kept, [404, 410]);
	assert.deepEqual(resolveOne(path, [400, 404, 451, 499]).kept, [400, 404, 451, 499]);

	for (const bad of [
		[404, 410, 500], // would store and replay an origin outage
		[404, 429], // rate limiting is the origin failing to answer
		['404'], // a string never equals a status, so it stores nothing
		[404.5],
		[399],
		[200],
	]) {
		const { kept, warnings } = resolveOne(path, bad);
		assert.deepEqual(kept, [404, 410], `${JSON.stringify(bad)}: the whole list is refused, the default kept`);
		assert.ok(
			warnings.some((w) => w.includes('an integer from 400 to 499 other than 429')),
			`${JSON.stringify(bad)}: ${warnings.join('\n')}`
		);

		const verdict = validateOverride(path, bad);
		assert.equal(verdict.ok, false, `${JSON.stringify(bad)}: the override door must refuse it`);
		assert.match(verdict.reason, /not allowed here — each entry must be an integer from 400 to 499 other than 429/);
	}
	assert.equal(validateOverride(path, [404, 410, 451]).ok, true);
});

test('the admin read limits carry a ceiling above the deployed values, at both doors', () => {
	const cases = [
		// [path, a value a deployment runs today or plausibly will, the ceiling]
		['management.analytics.scanCap', 1_000_000, 3_000_000],
		['management.analytics.maxRange', 3 * DAY, 7 * DAY],
		['management.scanCap', 100_000, 1_000_000],
		['management.pageSize', 200, 500],
	];
	for (const [path, plausible, ceiling] of cases) {
		assert.equal(resolveOne(path, plausible).kept, plausible, `${path}: ${plausible} must stay allowed`);
		assert.equal(resolveOne(path, ceiling).kept, ceiling);
		const { kept, warnings } = resolveOne(path, ceiling + 1);
		assert.equal(kept, defaultOf(path), `${path}: past the ceiling the default is kept`);
		assert.ok(
			warnings.some((w) => w.includes(`must be <= ${ceiling}`)),
			`${path}: ${warnings.join('\n')}`
		);
		assert.equal(validateOverride(path, ceiling + 1).ok, false, `${path}: the override door refuses it too`);
	}
	// The main deployment's analytics scan cap today.
	assert.equal(resolveOne('management.analytics.scanCap', 300_000).kept, 300_000);
});
