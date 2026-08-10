import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { applyOptions, config } from '../src/config.js';
import { defaultConfig } from '../src/configSchema.js';
import { decideInterval, rungIndexOf, rungs, drainStats, resetDemandStats } from '../src/util/demandLadder.js';

// The module logs through the ambient Harper `logger` global; give the test env one.
globalThis.logger ??= { info() {}, warn() {}, error() {} };

const H = 60 * 60 * 1000;

/** A probe with an explicit visit history, so the ladder's logic is tested on its own. */
const probeOf = ({ ready = true, visited = () => false, each = () => false } = {}) => ({
	ready: () => ready,
	warm: () => {},
	within: (url, windowMs, now) => visited(url, windowMs, now),
	eachWindow: (url, windowMs, count, now) => each(url, windowMs, count, now),
});

const never = probeOf();
const always = probeOf({ visited: () => true, each: () => true });

// applyOptions merges into DEFAULTS, not cumulatively — a second call inside a test would
// silently reset `enabled` back to its default. So every override goes through here.
const setDemand = (overrides = {}) =>
	applyOptions({
		render: {
			demand: {
				enabled: true,
				dryRun: false,
				ladder: [6 * H, 12 * H, 24 * H, 48 * H],
				promoteWindows: 2,
				maxFastInterval: 12 * H,
				maxFastFraction: 0.05,
				...overrides,
			},
		},
	});

beforeEach(() => {
	resetDemandStats();
	setDemand();
});

test('disabled ladder returns the base interval untouched', () => {
	setDemand({ enabled: false });
	const r = decideInterval('u', 48 * H, 48 * H, Date.now(), always);
	assert.equal(r.interval, 48 * H);
	assert.equal(r.action, 'off');
});

test('a cold filter holds rather than demoting the whole corpus', () => {
	// The failure this guards: a cold union reads as "nobody visited anything", which without
	// the guard would demote every target on the first pass after a restart.
	const r = decideInterval('u', 24 * H, 6 * H, Date.now(), probeOf({ ready: false }));
	assert.equal(r.action, 'cold');
	assert.equal(r.interval, 24 * H);
	assert.equal(drainStats().skippedCold, 1);
});

test('an unvisited target demotes one rung per cycle, stopping at the base ceiling', () => {
	let cur = 6 * H;
	for (const expected of [12 * H, 24 * H, 48 * H]) {
		cur = decideInterval('u', 48 * H, cur, Date.now(), never).level;
		assert.equal(cur, expected);
	}
	// At the ceiling there is nowhere slower to go.
	assert.equal(decideInterval('u', 48 * H, cur, Date.now(), never).level, 48 * H);
});

test('a visited target promotes one rung per cycle down to the fastest', () => {
	let cur = 48 * H;
	for (const expected of [24 * H, 12 * H, 6 * H]) {
		cur = decideInterval('u', 48 * H, cur, Date.now(), always).level;
		assert.equal(cur, expected);
	}
	assert.equal(decideInterval('u', 48 * H, cur, Date.now(), always).level, 6 * H);
});

test('promotion uses the CANDIDATE interval, not the current one', () => {
	// The distinction that keeps equilibrium at ~one render per visit instead of two.
	const seen = [];
	const probe = probeOf({
		each: (_u, windowMs, count) => {
			seen.push({ windowMs, count });
			return true;
		},
	});
	decideInterval('u', 48 * H, 24 * H, Date.now(), probe);
	assert.deepEqual(seen, [{ windowMs: 12 * H, count: 2 }]);
});

test('the route interval is a ceiling — the ladder never schedules slower than the route', () => {
	// A route granting 6h has nowhere to demote to, even with zero traffic.
	const r = decideInterval('u', 6 * H, 6 * H, Date.now(), never);
	assert.equal(r.level, 6 * H);
	assert.equal(r.action, 'held');
});

test('dry run reports the level it would pick but schedules the base', () => {
	setDemand({ dryRun: true });
	const r = decideInterval('u', 48 * H, 48 * H, Date.now(), always);
	assert.equal(r.level, 24 * H, 'reports the counterfactual');
	assert.equal(r.interval, 48 * H, 'but schedules unchanged');
	assert.equal(drainStats().promoted, 1, 'and still counts the decision');
});

test('an off-ladder STORED interval snaps to the nearest rung', () => {
	// This pins `rungIndexOf` for `current` only — a stored rung from an old ladder config.
	// Bases never snap; they participate as their own top rung (next tests).
	assert.equal(rungIndexOf(23 * H), 2); // nearest 24h
	assert.equal(rungIndexOf(0), rungs().length - 1); // invalid -> slowest
	assert.equal(rungIndexOf(undefined), rungs().length - 1);
});

test('an off-ladder BASE is never snapped to a rung — it rests at its own cadence', () => {
	// Below the fastest rung: a 1h route must not be parked at the 6h rung — that schedules
	// it 6x slower than the route granted, with no traffic input at all.
	const fast = decideInterval('u', 1 * H, undefined, Date.now(), always);
	assert.equal(fast.interval, 1 * H);
	assert.equal(fast.level, 1 * H);
	assert.equal(fast.action, 'held');

	// Above the slowest rung: an UNVISITED weekly (168h) route must not be pulled to the 48h
	// rung — a 3.5x render-cost multiplier `maxFastFraction` cannot see, because 48h is not
	// "fast".
	const slow = decideInterval('u', 168 * H, undefined, Date.now(), never);
	assert.equal(slow.level, 168 * H);
	assert.equal(slow.action, 'held');

	// Between rungs: an 18h route rests at 18h and promotes only through rungs faster than it.
	assert.equal(decideInterval('u', 18 * H, undefined, Date.now(), never).level, 18 * H);
	assert.equal(decideInterval('u', 18 * H, 18 * H, Date.now(), always).level, 12 * H);
});

test('a hot off-ladder base promotes through the faster rungs and walks back to its own grant', () => {
	let cur = 168 * H;
	for (const expected of [48 * H, 24 * H, 12 * H, 6 * H]) {
		cur = decideInterval('u', 168 * H, cur, Date.now(), always).level;
		assert.equal(cur, expected);
	}
	// Gone cold, it demotes back up — topping out at 168h, its own grant, not the 48h rung.
	for (const expected of [12 * H, 24 * H, 48 * H, 168 * H, 168 * H]) {
		cur = decideInterval('u', 168 * H, cur, Date.now(), never).level;
		assert.equal(cur, expected);
	}
});

test('fastFraction counts rungs below maxFastInterval', () => {
	decideInterval('a', 48 * H, 6 * H, Date.now(), always); // stays 6h -> fast
	decideInterval('b', 48 * H, 48 * H, Date.now(), never); // stays 48h -> not fast
	const s = drainStats();
	assert.equal(s.total, 2);
	assert.equal(s.fastFraction, 0.5);
});

test('ladder config is normalized: unsorted, duplicated and invalid rungs', () => {
	setDemand({ ladder: [24 * H, 6 * H, 24 * H, 0, -5, 12 * H] });
	assert.deepEqual(rungs(), [6 * H, 12 * H, 24 * H]);
});

test('an empty ladder disables the ladder rather than throwing', () => {
	setDemand({ ladder: [] });
	const r = decideInterval('u', 48 * H, 48 * H, Date.now(), always);
	assert.equal(r.action, 'off');
	assert.equal(r.interval, 48 * H);
});

test('config defaults ship inert: enabled off and dryRun on', () => {
	// Both matter. `enabled` off means no behaviour change at all; `dryRun` on means that even
	// turning `enabled` on only starts MEASURING — you have to opt in twice to change scheduling.
	const d = defaultConfig();
	assert.equal(d.render.demand.enabled, false);
	assert.equal(d.render.demand.dryRun, true);
	assert.equal(config.render.demand.enabled, true, 'test override applied on top of defaults');
});
