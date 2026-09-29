import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * `util/goneReopen.js` — a gone-suppressed target seen answering 200 at the origin gets its recheck filed
 * due now, instead of waiting out `gone.recheckInterval`.
 *
 * Pinned:
 *   - GONE VERDICTS ONLY. A noindex or canonical-mismatch page answers 200 by definition; reopening one
 *     would loop render → suppress → the next bot request → render.
 *   - IT FILES, IT DOES NOT FLIP. The row goes due now with a change mark; the target's state is left to
 *     the render's verdict.
 *   - BOUNDED. A crawler asking hourly files one render per dedupe window, and a mass relisting reaches
 *     the queue at `maxPerMinute`.
 *   - Dry run by default: counted, nothing filed.
 */

let reopen;
let config;
let applyOptions;
const targets = new Map();
const scheduleRows = new Map();
const ops = [];
let targetReads = 0;
let failRead = false;
let failWrite = false;

class TargetBase {
	static async get({ id, select }) {
		targetReads++;
		if (failRead) throw new Error('read failed');
		TargetBase.lastSelect = select;
		return targets.get(id) ?? null;
	}
	static search() {
		return (async function* () {})();
	}
}

const URL_A = 'https://www.example.com/product/prd-7/back-again.jsp';
const NOW = Date.UTC(2026, 8, 29, 12, 0, 0);
const gone = (over = {}) => ({
	url: URL_A,
	state: 'suppressed',
	suppressedReason: 'http-gone',
	sitemapUrl: 'https://www.example.com/sitemap_product_1.xml',
	renderInterval: null,
	demandInterval: null,
	...over,
});

before(async () => {
	globalThis.server = {
		hostname: 'test-node',
		nodes: [],
		config: { http: { port: 9926 } },
		recordAnalytics: (value, metric, path, method, type) => ops.push({ metric, path, method, type }),
	};
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {}, trace() {} };
	globalThis.Resource = class {};
	globalThis.databases = {
		coordination: {
			SharedBuffer: { primaryStore: { getUserSharedBuffer: (_key, buf) => buf, tryLock: () => true, unlock() {} } },
		},
		render_service: { Target: TargetBase, QueueControl: class {}, QueueStatus: { put: async () => {} } },
		render_schedule: {
			RenderSchedule: {
				get: async ({ id }) => scheduleRows.get(id) ?? null,
				put: async (id, data) => {
					if (failWrite) throw new Error('write failed');
					scheduleRows.set(id, { ...data });
				},
			},
		},
		page_cache: { PrerenderedPage: class {} },
		probe_state: { ProbeState: class {}, RenderExpectation: class {} },
	};
	({ config, applyOptions } = await import('../src/config.js'));
	reopen = await import('../src/util/goneReopen.js');
});

beforeEach(() => {
	targets.clear();
	scheduleRows.clear();
	ops.length = 0;
	targetReads = 0;
	failRead = false;
	failWrite = false;
	reopen.resetReopenState();
	applyOptions({ render: { suppression: { gone: { reopen: { enabled: true, dryRun: false } } } } });
});

const reopenOps = () => ops.filter((o) => o.path === 'gone_reopen').map((o) => `${o.method}/${o.type}`);

test('the defaults are on and dry: the effect is counted before anything is filed', () => {
	applyOptions({});
	assert.equal(config.render.suppression.gone.reopen.enabled, true);
	assert.equal(config.render.suppression.gone.reopen.dryRun, true);
});

test('a gone-suppressed target is filed due now, with a change mark and its sitemap flag', async () => {
	targets.set(URL_A, gone());
	const outcome = await reopen.maybeReopenGone({ url: URL_A, via: 'traffic', nowMs: NOW });
	assert.equal(outcome, 'filed');
	const row = scheduleRows.get(URL_A);
	assert.ok(row, 'the URL row was written');
	assert.equal(row.changedAt, NOW, 'a page that came back is a page that changed');
	assert.equal(row.fromSitemap, true);
	assert.ok(row.nextRenderTime <= Date.now(), 'due now');
	assert.deepEqual(reopenOps(), ['filed/traffic']);
	assert.deepEqual(TargetBase.lastSelect, [...reopen.REOPEN_SELECT], 'one read carries everything a reopen needs');
});

test('it never touches the target itself — the render verdict flips it', async () => {
	targets.set(URL_A, gone());
	await reopen.maybeReopenGone({ url: URL_A, via: 'traffic', nowMs: NOW });
	assert.equal(targets.get(URL_A).state, 'suppressed');
});

test('noindex and canonical-mismatch suppressions are NOT reopened — a 200 proves nothing about them', async () => {
	for (const suppressedReason of ['noindex', 'canonical-mismatch', 'redirect-loop', null]) {
		targets.set(URL_A, gone({ suppressedReason }));
		assert.equal(
			await reopen.maybeReopenGone({ url: URL_A, via: 'traffic', nowMs: NOW }),
			'not-gone',
			String(suppressedReason)
		);
	}
	targets.set(URL_A, gone({ state: null, suppressedReason: null }));
	assert.equal(await reopen.maybeReopenGone({ url: URL_A, via: 'traffic', nowMs: NOW }), 'not-gone');
	targets.delete(URL_A);
	assert.equal(await reopen.maybeReopenGone({ url: URL_A, via: 'traffic', nowMs: NOW }), 'not-gone');
	assert.equal(scheduleRows.size, 0);
	assert.deepEqual(reopenOps(), [], 'the common, uninteresting outcomes are not counted');
});

test('a caller holding the row is not charged a second read', async () => {
	await reopen.maybeReopenGone({ url: URL_A, target: gone(), via: 'traffic', nowMs: NOW });
	assert.equal(targetReads, 0);
	assert.ok(scheduleRows.has(URL_A));
});

test('a dry run counts would-file and writes nothing', async () => {
	applyOptions({ render: { suppression: { gone: { reopen: { enabled: true, dryRun: true } } } } });
	targets.set(URL_A, gone());
	assert.equal(await reopen.maybeReopenGone({ url: URL_A, via: 'recheck', nowMs: NOW }), 'would-file');
	assert.equal(scheduleRows.size, 0);
	assert.deepEqual(reopenOps(), ['would-file/recheck']);
});

test('disabled means no read and no count', async () => {
	applyOptions({ render: { suppression: { gone: { reopen: { enabled: false } } } } });
	targets.set(URL_A, gone());
	assert.equal(await reopen.maybeReopenGone({ url: URL_A, via: 'traffic', nowMs: NOW }), 'disabled');
	assert.equal(targetReads, 0);
	assert.deepEqual(reopenOps(), []);
});

test('an hourly crawler files ONE reopen per dedupe window', async () => {
	targets.set(URL_A, gone());
	assert.equal(await reopen.maybeReopenGone({ url: URL_A, via: 'traffic', nowMs: NOW }), 'filed');
	assert.equal(await reopen.maybeReopenGone({ url: URL_A, via: 'traffic', nowMs: NOW + 3_600_000 }), 'deduped');
	const after = NOW + config.render.suppression.gone.reopen.dedupeMs;
	assert.equal(await reopen.maybeReopenGone({ url: URL_A, via: 'traffic', nowMs: after }), 'filed');
	assert.deepEqual(reopenOps(), ['filed/traffic', 'deduped/traffic', 'filed/traffic']);
});

test('a mass relisting reaches the queue at maxPerMinute, and the window resets', async () => {
	applyOptions({ render: { suppression: { gone: { reopen: { enabled: true, dryRun: false, maxPerMinute: 2 } } } } });
	const urls = [1, 2, 3].map((n) => `https://www.example.com/product/prd-${n}/x.jsp`);
	for (const url of urls) targets.set(url, gone({ url }));
	const outcomes = [];
	for (const url of urls) outcomes.push(await reopen.maybeReopenGone({ url, via: 'traffic', nowMs: NOW }));
	assert.deepEqual(outcomes, ['filed', 'filed', 'capped']);
	assert.equal(await reopen.maybeReopenGone({ url: urls[2], via: 'traffic', nowMs: NOW + 60_000 }), 'filed');
});

test('a failed read is counted and swallowed', async () => {
	failRead = true;
	assert.equal(await reopen.maybeReopenGone({ url: URL_A, via: 'traffic', nowMs: NOW }), 'error');
	assert.deepEqual(reopenOps(), ['error/traffic']);
});

test('a filing that failed is not deduped: the next 200 retries it', async () => {
	targets.set(URL_A, gone());
	failWrite = true;
	assert.equal(await reopen.maybeReopenGone({ url: URL_A, via: 'traffic', nowMs: NOW }), 'error');
	failWrite = false;
	assert.equal(await reopen.maybeReopenGone({ url: URL_A, via: 'traffic', nowMs: NOW + 60_000 }), 'filed');
	assert.ok(scheduleRows.has(URL_A));
});
