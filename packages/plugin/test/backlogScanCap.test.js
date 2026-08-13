import { test, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The backlog snapshot's row cap: configured for the SCHEDULED walk, overridable per run.
 *
 * Why the override exists. `management.scanCap` has to be sized for a scan that repeats every
 * interval beside bot traffic, and that budget is routinely smaller than the backlog itself.
 * When it is, the ascending walk is spent entirely on overdue rows: `overdue` reports the cap
 * rather than a count, and the 24-hour histogram comes back empty because the scan never
 * reached a not-yet-due row. Measured in the field at `scanCap: 2000` — every node reporting
 * "2000+ overdue" with 24 empty hour buckets, and no way to learn the real figure short of
 * deploying a config change, reading it, and deploying it back.
 *
 * The one that matters most below is `null`. `Number(null)` is `0` and `0` is finite, so a
 * naive finite-check accepts it, clamps it up to the floor of 1, and runs a ONE-ROW scan
 * reporting `overdue: 1, truncated: true` — a completely plausible answer, which is what makes
 * it dangerous. Same trap as the analytics range floor in v0.47.1.
 */

let resolveScanCap;

before(async () => {
	globalThis.Resource = class {};
	globalThis.server = { hostname: 'node-a', workerIndex: 0 };
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {} };
	globalThis.databases = { coordination: { SharedBuffer: {} }, render_schedule: { RenderSchedule: {} } };
	({ resolveScanCap } = await import('../src/util/backlogSnapshot.js'));
});

test('an absent override falls back to the configured cap — never to 1', () => {
	// Every one of these is a way "no cap was given" actually arrives: an omitted JSON field, an
	// explicit null from a client that always sends the key, an empty form input.
	for (const absent of [undefined, null, '']) {
		assert.equal(resolveScanCap(absent, 2000), 2000, `${JSON.stringify(absent)} must mean "use the configured cap"`);
	}
});

test('junk falls back too, rather than scanning one row', () => {
	for (const junk of ['abc', NaN, {}, [], -5, 0, 0.4]) {
		assert.equal(resolveScanCap(junk, 2000), 2000, `${JSON.stringify(junk)} must fall back`);
	}
});

test('a usable override wins, floored to an integer', () => {
	assert.equal(resolveScanCap(50_000, 2000), 50_000);
	assert.equal(resolveScanCap('50000', 2000), 50_000, 'a string from a JSON body still counts');
	assert.equal(resolveScanCap(1, 2000), 1, 'a deliberate 1 is allowed — it is only the ACCIDENTAL 1 that is the bug');
	assert.equal(resolveScanCap(2500.9, 2000), 2500);
});

test('the override is clamped, so a mistyped request cannot walk the whole index', () => {
	assert.equal(resolveScanCap(10_000_000, 2000), 100_000);
	assert.equal(resolveScanCap(Infinity, 2000), 2000, 'Infinity is not finite-usable; fall back rather than clamp');
});

test('a nonsense configured cap still yields a scan of at least one row', () => {
	assert.equal(resolveScanCap(undefined, 0), 1);
	assert.equal(resolveScanCap(undefined, -10), 1);
});
