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
