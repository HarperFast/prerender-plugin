import { test, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The schedule write contract (`util/renderSchedule.js`). `put` REPLACES the record, so a writer that
 * omits `fromSitemap` or `effectiveInterval` does not leave the old value alone — it erases it. Both
 * are therefore required arguments; `null` is a legal explicit answer, `undefined` is not.
 */

const rows = new Map();
let funnel;

before(async () => {
	globalThis.server = { hostname: 'test-node', nodes: [], config: { http: { port: 9926 } } };
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {} };
	globalThis.databases = {
		render_schedule: {
			RenderSchedule: {
				put: async (id, data) => rows.set(id, { ...data }),
				delete: async (id) => rows.delete(id),
				get: async ({ id }) => rows.get(id) ?? null,
			},
		},
	};
	funnel = await import('../src/util/renderSchedule.js');
});

const T0 = Date.UTC(2026, 0, 1);

test('writeSchedule refuses a write with no explicit fromSitemap (put REPLACES the record)', async () => {
	await assert.rejects(() => funnel.writeSchedule('a|desktop', { nextRenderTime: T0 }), /fromSitemap/);
	await assert.rejects(() => funnel.writeSchedules([{ cacheKey: 'a|desktop', nextRenderTime: T0 }]), /fromSitemap/);
});

test('writeSchedule refuses a write with no explicit effectiveInterval (same hazard)', async () => {
	// A writer that omits the cadence strips it off a row that had one, and the keeper then ranks that
	// page by its route ceiling instead of its demand-ladder rung. `null` is a legal answer — a
	// render-now one-off has no cadence — so the guard is on `undefined` alone.
	await assert.rejects(
		() => funnel.writeSchedule('a|desktop', { nextRenderTime: T0, fromSitemap: false }),
		/effectiveInterval/
	);
	await assert.rejects(
		() => funnel.writeSchedules([{ cacheKey: 'a|desktop', nextRenderTime: T0, fromSitemap: false }]),
		/effectiveInterval/
	);
	await funnel.writeSchedule('a|desktop', { nextRenderTime: T0, fromSitemap: false, effectiveInterval: null });
	await funnel.writeSchedules([
		{ cacheKey: 'b|desktop', nextRenderTime: T0, fromSitemap: false, effectiveInterval: null },
	]);
	assert.deepEqual([...rows.keys()].sort(), ['a|desktop', 'b|desktop']);
});

test('fileDueNow files a row due now WITHOUT DEMOTING it: an earlier due time and a change mark survive', async () => {
	// Every "render this now" writer goes through it (the change probe, revalidate, render-now, admin
	// rejoin). Filing a page that is already waiting at "now" would move it back in the queue, and
	// dropping its `changedAt` would strip the head start of a page known wrong.
	const minute = Math.floor(Date.now() / 60_000) * 60_000;
	rows.clear();
	await funnel.fileDueNow('https://example.com/new', { fromSitemap: true, effectiveInterval: null });
	assert.equal(rows.get('https://example.com/new').nextRenderTime, minute, 'no row: filed at the current minute');
	assert.equal(rows.get('https://example.com/new').changedAt, undefined, 'and not marked unless asked');

	const earlier = minute - 3 * 3_600_000;
	rows.set('https://example.com/waiting', { nextRenderTime: earlier, fromSitemap: true, changedAt: earlier });
	await funnel.fileDueNow('https://example.com/waiting', { fromSitemap: true, effectiveInterval: null });
	assert.equal(
		rows.get('https://example.com/waiting').nextRenderTime,
		earlier,
		'an already-due row keeps its due time'
	);
	assert.equal(rows.get('https://example.com/waiting').changedAt, earlier, 'and its mark');

	rows.set('https://example.com/later', { nextRenderTime: minute + 48 * 3_600_000, fromSitemap: false });
	await funnel.fileDueNow('https://example.com/later', {
		fromSitemap: false,
		effectiveInterval: null,
		changedAt: minute,
	});
	assert.equal(rows.get('https://example.com/later').nextRenderTime, minute, 'a future row is pulled to now');
	assert.equal(rows.get('https://example.com/later').changedAt, minute, 'and marked when asked');
});

test('demandPeriod rides with the change mark and only with it', async () => {
	// It says how urgent a CHANGE is (queue.ready.changedDemand), so a row with no mark never carries
	// one — the render's reschedule clears both by omission.
	rows.clear();
	await funnel.writeSchedule('https://example.com/a', {
		nextRenderTime: T0,
		fromSitemap: true,
		effectiveInterval: null,
		changedAt: T0,
		demandPeriod: 6 * 3_600_000,
	});
	assert.equal(rows.get('https://example.com/a').demandPeriod, 6 * 3_600_000);
	await funnel.writeSchedule('https://example.com/b', {
		nextRenderTime: T0,
		fromSitemap: true,
		effectiveInterval: null,
		demandPeriod: 6 * 3_600_000,
	});
	assert.equal('demandPeriod' in rows.get('https://example.com/b'), false, 'no mark, no demand');
	for (const unusable of [0, -1, NaN, null, undefined]) {
		await funnel.writeSchedule('https://example.com/c', {
			nextRenderTime: T0,
			fromSitemap: true,
			effectiveInterval: null,
			changedAt: T0,
			demandPeriod: unusable,
		});
		assert.equal('demandPeriod' in rows.get('https://example.com/c'), false, `unusable ${unusable} is not written`);
	}
});

test('fileDueNow: a marked row keeps its demand, and takes the given one only if it had none', async () => {
	const minute = Math.floor(Date.now() / 60_000) * 60_000;
	const earlier = minute - 3_600_000;
	rows.clear();
	rows.set('https://example.com/kept', {
		nextRenderTime: earlier,
		fromSitemap: true,
		changedAt: earlier,
		demandPeriod: 6e6,
	});
	await funnel.fileDueNow('https://example.com/kept', {
		fromSitemap: true,
		effectiveInterval: null,
		changedAt: minute,
		demandPeriod: 9e6,
	});
	assert.equal(rows.get('https://example.com/kept').demandPeriod, 6e6, 'the first estimate stays with the first mark');

	// A revalidate or render-now passes no demand at all: the mark and its demand both survive.
	await funnel.fileDueNow('https://example.com/kept', { fromSitemap: true, effectiveInterval: null });
	assert.equal(rows.get('https://example.com/kept').changedAt, earlier);
	assert.equal(rows.get('https://example.com/kept').demandPeriod, 6e6);

	rows.set('https://example.com/unknown', { nextRenderTime: earlier, fromSitemap: true, changedAt: earlier });
	await funnel.fileDueNow('https://example.com/unknown', {
		fromSitemap: true,
		effectiveInterval: null,
		changedAt: minute,
		demandPeriod: 9e6,
	});
	assert.equal(rows.get('https://example.com/unknown').demandPeriod, 9e6, 'marked with no estimate: takes the new one');
});
