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
