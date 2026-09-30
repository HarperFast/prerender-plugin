import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { publishDueRows } from './support/keeperStandIn.js';

/**
 * THE RENDER CHECK (changeProbe.renderCheck, review item M4(b)): a render that lands disagreeing with the
 * probe's last observation of the origin is hard-expired and re-filed — through the real result path, so
 * the ORDER is pinned: the expiry and the re-file land after the page writes and the reschedule that would
 * otherwise overwrite them. Plus the two guards that keep it from doing harm: it trusts the stored
 * observation only when the probe is known to have seen the URL since the origin last moved, and it
 * re-files at most once per stored observation.
 */

const A = 'https://site.example.com/product/a';
const key = (url, device) => `${url}|${device}`;
const DEVICES = ['desktop', 'mobile'];
const HOUR = 60 * 60 * 1000;

const stores = {
	target: new Map(),
	renderSchedule: new Map(),
	prerenderedPage: new Map(),
	renderExpectation: new Map(),
	probeState: new Map(),
	invalidation: new Map(),
};
let analytics = [];
let sharedRows = new Map();

const table = (rows) =>
	class FakeTable {
		constructor(id) {
			this.__id = id;
		}
		static async get(query) {
			const id = typeof query === 'object' ? query.id : query;
			const row = rows.get(id);
			if (!row) return null;
			const select = typeof query === 'object' ? query.select : undefined;
			if (Array.isArray(select)) return Object.fromEntries(select.map((name) => [name, row[name]]));
			return { ...row };
		}
		static async put(id, data) {
			rows.set(id, { ...data });
		}
		static async patch(id, data) {
			if (rows.has(id)) rows.set(id, { ...rows.get(id), ...data });
		}
		static async delete(id) {
			return rows.delete(id);
		}
		static async *search(query = {}) {
			const [condition] = query.conditions ?? [];
			const floor = condition ? Number(condition.value) : Number.NEGATIVE_INFINITY;
			const matching = [...rows.entries()]
				.map(([cacheKey, row]) => ({ cacheKey, ...row }))
				.filter((row) => Number(row.nextRenderTime) >= floor)
				.sort((a, b) => Number(a.nextRenderTime) - Number(b.nextRenderTime))
				.slice(0, query.limit ?? Infinity);
			for (const row of matching) yield row;
		}
	};

let RenderQueue, config, applyOptions, funnel, changeProbe;
const sabs = new Map();

before(async () => {
	globalThis.Resource = class {};
	globalThis.server = {
		hostname: 'test-node',
		nodes: [],
		workerIndex: 0,
		config: { http: { port: 9926 } },
		recordAnalytics: (...args) => analytics.push(args),
	};
	globalThis.logger = { debug() {}, info() {}, warn() {}, error() {}, notify() {} };
	globalThis.createBlob = (buf) => buf;
	class SharedBuffer {
		static primaryStore = {
			getUserSharedBuffer: (k, buf) => {
				if (!sabs.has(k)) sabs.set(k, buf);
				return sabs.get(k);
			},
			tryLock: () => true,
			unlock() {},
		};
		static async get(k) {
			return sharedRows.get(k);
		}
		static async put(k, v) {
			sharedRows.set(k, v);
		}
	}
	globalThis.databases = {
		probe_state: { ProbeState: table(stores.probeState), RenderExpectation: table(stores.renderExpectation) },
		coordination: { SharedBuffer },
		render_service: {
			Target: table(stores.target),
			QueueControl: table(new Map()),
			QueueStatus: table(new Map()),
		},
		render_schedule: { RenderSchedule: table(stores.renderSchedule) },
		page_cache: { PrerenderedPage: table(stores.prerenderedPage) },
		invalidation: { Invalidation: table(stores.invalidation) },
		verification: { PageVerification: table(new Map()) },
	};
	({ config, applyOptions } = await import('../src/config.js'));
	({ RenderQueue } = await import('../src/resources/RenderQueue.js'));
	funnel = await import('../src/util/renderSchedule.js');
	changeProbe = await import('../src/util/changeProbe.js');
});

const RULE = {
	label: 'pdp',
	pathPattern: '^/product/([^/]+)',
	source: 'request',
	request: { urlTemplate: 'https://api.example.com/p/$1' },
	extract: ['price', 'available'],
	pageCheck: { enabled: true, priceFrom: 0, availableFrom: 1 },
};
const configure = (changeProbeOptions = {}) =>
	applyOptions({ changeProbe: { enabled: true, dryRun: false, rules: [RULE], ...changeProbeOptions } });

beforeEach(() => {
	for (const rows of Object.values(stores)) rows.clear();
	sharedRows = new Map();
	analytics = [];
	funnel.resetRenderQueueState();
	changeProbe.resetChangeProbeState();
	configure();
});

afterEach(() => {
	applyOptions({ changeProbe: { enabled: false } });
	changeProbe.resetChangeProbeState();
});

const post = async (url, offers) => {
	const variants = DEVICES.map((deviceType) => ({
		deviceType,
		statusCode: 200,
		outcome: 'rendered',
		isIndexable: true,
		headers: {},
		renderTime: 100,
		structuredOffers: offers,
		content: `<html>${deviceType}</html>`,
	}));
	const bodies = [];
	const wire = variants.map(({ content, ...metadata }) => {
		bodies.push(Buffer.from(content));
		return { ...metadata, contentLength: Buffer.byteLength(content) };
	});
	const meta = Buffer.from(JSON.stringify({ id: url, url, deviceTypes: DEVICES, variants: wire }), 'utf8');
	const ctx = { headers: new Map([['x-metadata-size', String(meta.byteLength)]]) };
	return RenderQueue.processJobResult(Buffer.concat([meta, ...bodies]), ctx);
};

const seed = ({ signature = JSON.stringify([35.99, true]), probedAt = Date.now() - HOUR, renderRefiledAt } = {}) => {
	stores.target.set(A, { url: A, renderInterval: 24 * HOUR, sitemapUrl: 'https://site.example.com/s.xml' });
	stores.renderSchedule.set(A, { nextRenderTime: 1, fromSitemap: true, effectiveInterval: 24 * HOUR });
	stores.probeState.set(A, {
		url: A,
		signature,
		probedAt: new Date(probedAt),
		ruleFingerprint: changeProbe.probeRules()[0].fingerprint,
		pageSignature: null,
		...(renderRefiledAt ? { renderRefiledAt: new Date(renderRefiledAt) } : {}),
	});
};
const claimAndPost = async (offers) => {
	publishDueRows(funnel, stores.renderSchedule);
	await RenderQueue.claim({ limit: 10 });
	await post(A, offers);
};
const outcomes = () =>
	analytics.filter((a) => a[1] === 'prerender_ops' && a[2] === 'probe_render_mismatch').map((a) => a[3]);
const hardExpired = () =>
	DEVICES.every((d) => stores.prerenderedPage.get(key(A, d)).expiresAt <= Date.now() - config.page.swrTtl);

test('M4(b): a render that DISAGREES with the stored observation is hard-expired and re-filed — after the reschedule', async () => {
	seed(); // the endpoint said 35.99; the render captured 39.99 (a stale CDN copy)
	await claimAndPost(['39.99', 'USD', 'InStock']);
	assert.ok(hardExpired(), 'every device page stopped serving, though the result just wrote them with a fresh expiry');
	const schedule = stores.renderSchedule.get(A);
	assert.ok(schedule.nextRenderTime <= Date.now(), 'the reschedule one interval out was overridden: due now');
	assert.ok(schedule.changedAt > 0, 'ranked as a change');
	assert.ok(stores.probeState.get(A).renderRefiledAt, 'the bound is recorded in the claim write');
	assert.equal(stores.probeState.get(A).pageSignature, JSON.stringify([['39.99'], true]), 'the claim is still stored');
	assert.deepEqual(outcomes(), ['refiled']);
});

test('M4(b): a render that AGREES costs nothing — rescheduled one interval out, as always', async () => {
	seed();
	await claimAndPost(['35.99', 'USD', 'InStock']);
	assert.equal(hardExpired(), false);
	assert.ok(stores.renderSchedule.get(A).nextRenderTime > Date.now() + HOUR);
	assert.deepEqual(outcomes(), []);
});

test('M4(b): ONE re-file per stored observation — a page that disagrees every time does not loop', async () => {
	seed({ probedAt: Date.now() - HOUR, renderRefiledAt: Date.now() - 30 * 60_000 });
	await claimAndPost(['39.99', 'USD', 'InStock']);
	assert.equal(hardExpired(), false, 'already re-filed once against this baseline: left to the pass');
	assert.deepEqual(outcomes(), ['bounded']);
});

test('M4(b): a baseline older than the last anchor, on a URL no pass has covered since, is NOT trusted', async () => {
	// Anchored at 00:05 UTC. The baseline is from yesterday and the running pass has not reached this URL —
	// the render may simply be newer than the probe's view (the reprice the pass has yet to see).
	configure({ mode: 'anchored', anchorTime: new Date(Date.now() - 2 * HOUR).toISOString().slice(11, 16) });
	seed({ probedAt: Date.now() - 20 * HOUR });
	sharedRows.set('change_probe', {
		sweep: {
			running: true,
			startedAt: Date.now() - HOUR,
			originStartedAt: Date.now() - HOUR,
			heartbeatAt: Date.now(),
			progress: { cursor: 'https://site.example.com/product/' }, // not yet past /product/a
			lastRun: { startedAt: Date.now() - 25 * HOUR },
		},
	});
	await claimAndPost(['39.99', 'USD', 'InStock']);
	assert.equal(hardExpired(), false);
	assert.deepEqual(outcomes(), ['untrusted']);
});

test('M4(b): the same baseline IS trusted once the running pass has walked past the URL since the anchor', async () => {
	configure({ mode: 'anchored', anchorTime: new Date(Date.now() - 2 * HOUR).toISOString().slice(11, 16) });
	seed({ probedAt: Date.now() - 20 * HOUR });
	sharedRows.set('change_probe', {
		sweep: {
			running: true,
			startedAt: Date.now() - HOUR,
			originStartedAt: Date.now() - HOUR,
			heartbeatAt: Date.now(),
			progress: { cursor: 'https://site.example.com/product/z' },
		},
	});
	await claimAndPost(['39.99', 'USD', 'InStock']);
	assert.ok(hardExpired());
	assert.deepEqual(outcomes(), ['refiled']);
});

test('M4(b): dry run counts and does nothing; renderCheck: false does not even compare', async () => {
	configure({ dryRun: true });
	seed();
	await claimAndPost(['39.99', 'USD', 'InStock']);
	assert.equal(hardExpired(), false);
	assert.deepEqual(outcomes(), ['dry_run']);

	analytics = [];
	configure({ renderCheck: false });
	seed();
	await claimAndPost(['39.99', 'USD', 'InStock']);
	assert.equal(hardExpired(), false);
	assert.deepEqual(outcomes(), []);
});

test('change_lag_ms is counted for a render that lands the change, never for one the render check finds stale', async () => {
	// A stale render does not carry the change's content: it is re-filed, and its trigger-to-cache lag is
	// the next render's to report. Counted here too it would be counted twice, and too early.
	const lag = () => analytics.filter((a) => a[1] === 'render' && a[2] === 'change_lag_ms');
	seed();
	stores.renderSchedule.set(A, { ...stores.renderSchedule.get(A), changedAt: Date.now() - HOUR });
	await claimAndPost(['39.99', 'USD', 'InStock']); // disagrees with the observed 35.99
	assert.deepEqual(outcomes(), ['refiled']);
	assert.equal(lag().length, 0, 'stale: no sample');

	for (const rows of Object.values(stores)) rows.clear();
	funnel.resetRenderQueueState();
	seed();
	stores.renderSchedule.set(A, { ...stores.renderSchedule.get(A), changedAt: Date.now() - HOUR });
	await claimAndPost(['35.99', 'USD', 'InStock']);
	assert.equal(lag().length, 1, 'agrees: one sample');
});
