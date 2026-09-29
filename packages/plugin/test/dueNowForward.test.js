import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

/**
 * `fileDueNow` off the row's owner (util/renderSchedule.js, util/peerHeal.js `forwardDueNow`,
 * http_handlers/peer_heal.js `handlePeerDueNowRequest`).
 *
 * The bug: `fileDueNow` keeps an earlier due time and a change mark by READING the row first, and that
 * read is node-local — authoritative only on the row's residency owner. Everywhere else (about three calls
 * in four on four nodes) it saw nothing, and the whole-row `put` that replicated to the owner REPLACED the
 * owner's row: an overdue row pushed back to the current minute, its `changedAt` and `demandPeriod` gone.
 *
 * The fake table below models exactly that: a point read with `replicateFrom: false` answers only on the
 * key's owner, while a put lands on the one shared copy (replication). Two nodes run in one process by
 * swapping `server.hostname` inside the fake peer fetch, which hands a request shaped like the one
 * Harper's raw `server.http` chain passes — a Readable body — to the real handler (the seam
 * `peer-handler-body-trap` was lost in).
 */

const ORIGIN = 'https://www.example.com';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const TOKEN = { header: 'x-harper-peer-token', value: 'shared-secret' };

const table = new Map();
const analytics = [];
let fetches = [];
let peerFetch = null;
let config, funnel, forward, handler, residency;

before(async () => {
	globalThis.Resource = class {};
	globalThis.server = {
		hostname: 'node-a',
		nodes: [{ name: 'node-a' }, { name: 'node-b' }],
		recordAnalytics: (...args) => analytics.push(args),
		config: { http: { securePort: 9926 } },
	};
	globalThis.logger = { info() {}, warn() {}, error() {}, debug() {} };
	const emptyTable = () =>
		class FakeTable {
			static async get() {
				return null;
			}
			static async put() {}
			static async patch() {}
			static async delete() {}
			static async *search() {}
		};
	const sabs = new Map();
	globalThis.databases = {
		page_cache: { PrerenderedPage: emptyTable() },
		render_service: { Target: emptyTable(), QueueStatus: emptyTable(), QueueControl: emptyTable() },
		render_schedule: {
			RenderSchedule: {
				get: async ({ id, select }, options) => {
					assert.equal(options?.replicateFrom, false, 'every read of this table is local');
					// node-local: only the owner stores the row
					if (residency.getResidencyByUrl(id.split('|')[0]) !== server.hostname) return null;
					const row = table.get(id);
					return row ? Object.fromEntries(select.map((name) => [name, row[name]])) : null;
				},
				put: async (id, row) => table.set(id, { ...row }),
				delete: async (id) => table.delete(id),
			},
		},
		invalidation: { Invalidation: emptyTable() },
		verification: { PageVerification: emptyTable() },
		probe_state: { ProbeState: emptyTable(), RenderExpectation: emptyTable() },
		coordination: {
			SharedBuffer: {
				primaryStore: {
					getUserSharedBuffer: (key, buffer) => {
						if (!sabs.has(key)) sabs.set(key, buffer);
						return sabs.get(key);
					},
				},
			},
		},
	};
	globalThis.fetch = async (url, init) => {
		fetches.push({ url, init });
		return peerFetch(url, init);
	};

	({ config } = await import('../src/config.js'));
	residency = await import('../src/util/residency.js');
	funnel = await import('../src/util/renderSchedule.js');
	forward = await import('../src/util/peerHeal.js');
	handler = (await import('../src/http_handlers/peer_heal.js')).handlePeerDueNowRequest;
});

/** The first product URL `node` owns. */
const ownedBy = (node, from = 0) => {
	for (let i = from; ; i++) {
		const url = `${ORIGIN}/product/${i}`;
		if (residency.getResidencyByUrl(url) === node) return url;
	}
};

/** The peer call, delivered to the real handler as `node` — a Readable body, as core passes it. */
const deliverTo =
	(node) =>
	async (url, { method, headers, body }) => {
		const request = {
			method,
			url: new URL(url).pathname,
			headers: { get: (name) => headers[name] ?? headers[String(name).toLowerCase()] ?? null },
			body: Readable.from([Buffer.from(body, 'utf8')]),
		};
		const self = server.hostname;
		server.hostname = node;
		try {
			const answer = await handler(request);
			return {
				ok: answer.status >= 200 && answer.status < 300,
				status: answer.status,
				json: async () => JSON.parse(answer.body),
			};
		} finally {
			server.hostname = self;
		}
	};

const forwardOutcomes = () =>
	analytics.filter((a) => a[1] === 'prerender_ops' && a[2] === 'due_now_forward').map((a) => a[3]);

beforeEach(() => {
	table.clear();
	analytics.length = 0;
	fetches = [];
	peerFetch = deliverTo('node-b');
	server.hostname = 'node-a';
	config.queue.dueNowForward.enabled = true;
	config.queue.dueNowForward.timeoutMs = 1000;
	config.peerRescue.token = TOKEN.value;
	config.peerRescue.header = TOKEN.header;
	config.domains = [];
	forward.resetDueNowForward();
});

test('off the owner, a filing is forwarded: the owner keeps its earlier due time, change mark and demand', async () => {
	const url = ownedBy('node-b');
	const earlier = Math.floor(Date.now() / MINUTE) * MINUTE - 3 * HOUR;
	const changedAt = earlier;
	table.set(url, {
		nextRenderTime: earlier,
		fromSitemap: true,
		effectiveInterval: 48 * HOUR,
		changedAt,
		demandPeriod: 6 * HOUR,
	});

	// a render-now on node-a, which does not own the row
	const due = await funnel.fileDueNow(url, { fromSitemap: true, effectiveInterval: 48 * HOUR });

	assert.equal(fetches.length, 1);
	assert.equal(fetches[0].url, `https://node-b:9926/prerender_peer/due-now`);
	assert.equal(fetches[0].init.headers[TOKEN.header], TOKEN.value);
	const row = table.get(url);
	assert.equal(row.nextRenderTime, earlier, 'not pushed back to the current minute');
	assert.equal(row.changedAt, changedAt, 'the mark survives');
	assert.equal(row.demandPeriod, 6 * HOUR);
	assert.equal(due, earlier, 'and the caller is told the due time the owner wrote');
	assert.deepEqual(forwardOutcomes(), ['forwarded']);
});

test('on the owner, nothing is forwarded', async () => {
	const url = ownedBy('node-a');
	await funnel.fileDueNow(url, { fromSitemap: false, effectiveInterval: null });
	assert.equal(fetches.length, 0);
	assert.ok(table.has(url));
	assert.deepEqual(forwardOutcomes(), []);
});

test('an owner that cannot be reached: filed here as before, and that owner is not asked again for a while', async () => {
	const url = ownedBy('node-b');
	peerFetch = async () => {
		throw new Error('connect ECONNREFUSED');
	};
	const minute = Math.floor(Date.now() / MINUTE) * MINUTE;
	assert.equal(await funnel.fileDueNow(url, { fromSitemap: true, effectiveInterval: null }), minute);
	assert.equal(table.get(url).nextRenderTime, minute, 'the pre-forwarding behaviour — never worse than it');
	await funnel.fileDueNow(ownedBy('node-b', 1_000), { fromSitemap: true, effectiveInterval: null });
	assert.equal(fetches.length, 1, 'the second filing does not wait out another failure');
	assert.deepEqual(forwardOutcomes(), ['fell-back', 'skipped']);
});

test('an owner that refuses (not-owner, mid-topology-change) is not cooled down, and the row is filed here', async () => {
	const url = ownedBy('node-b');
	peerFetch = deliverTo('node-c'); // a node whose view says it is not the owner
	await funnel.fileDueNow(url, { fromSitemap: true, effectiveInterval: null });
	assert.ok(table.has(url), 'filed locally');
	peerFetch = deliverTo('node-b');
	await funnel.fileDueNow(url, { fromSitemap: true, effectiveInterval: null });
	assert.equal(fetches.length, 2, 'asked again: a refusal is the owner working, not a fault');
	assert.deepEqual(forwardOutcomes(), ['fell-back', 'forwarded']);
});

test('with forwarding off, or no peer token, every filing is local — and wipes the owner’s mark, as it did', async () => {
	const url = ownedBy('node-b');
	const earlier = Math.floor(Date.now() / MINUTE) * MINUTE - 3 * HOUR;
	table.set(url, { nextRenderTime: earlier, fromSitemap: true, effectiveInterval: null, changedAt: earlier });
	config.queue.dueNowForward.enabled = false;
	await funnel.fileDueNow(url, { fromSitemap: true, effectiveInterval: null });
	// the hazard the forward exists for, pinned so the contrast with the first test is explicit
	assert.equal(table.get(url).changedAt, undefined, 'the local read saw nothing, so the put replaced the row');
	assert.ok(table.get(url).nextRenderTime > earlier, 'and pushed an overdue row back to the current minute');
	config.queue.dueNowForward.enabled = true;
	config.peerRescue.token = '';
	await funnel.fileDueNow(url, { fromSitemap: true, effectiveInterval: null });
	assert.equal(fetches.length, 0);
	assert.ok(table.has(url));
});

// ---- the endpoint, through a realistic request -----------------------------------------------------

const request = ({ body, headers = { [TOKEN.header]: TOKEN.value }, method = 'POST' } = {}) => ({
	method,
	url: '/prerender_peer/due-now',
	headers: { get: (name) => headers[name] ?? null },
	body: body === undefined ? undefined : Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]),
});

test('the endpoint is 404 when off and 403 on a wrong token — existence is not disclosed first', async () => {
	config.queue.dueNowForward.enabled = false;
	assert.equal((await handler(request({ body: {} }))).status, 404);
	config.queue.dueNowForward.enabled = true;
	assert.equal((await handler(request({ body: {}, headers: { [TOKEN.header]: 'nope' } }))).status, 403);
	assert.equal((await handler(request({ method: 'GET' }))).status, 405);
});

test('the endpoint refuses a malformed filing rather than writing a row it cannot vouch for', async () => {
	const cacheKey = ownedBy('node-a');
	for (const body of [
		{ cacheKey, effectiveInterval: null },
		{ cacheKey, fromSitemap: true },
		{ cacheKey, fromSitemap: true, effectiveInterval: -1 },
		{ cacheKey, fromSitemap: true, effectiveInterval: null, changedAt: 'soon' },
		{ cacheKey: 'not a url', fromSitemap: true, effectiveInterval: null },
	]) {
		assert.equal((await handler(request({ body }))).status, 400, JSON.stringify(body));
	}
	assert.equal(table.size, 0);
});

test('the endpoint files only rows it owns, for hosts the allowlist admits', async () => {
	const theirs = ownedBy('node-b');
	const answer = await handler(request({ body: { cacheKey: theirs, fromSitemap: true, effectiveInterval: null } }));
	assert.equal(JSON.parse(answer.body).outcome, 'not-owner');
	config.domains = ['elsewhere.example.com'];
	const mine = ownedBy('node-a');
	const refused = await handler(request({ body: { cacheKey: mine, fromSitemap: true, effectiveInterval: null } }));
	assert.equal(JSON.parse(refused.body).outcome, 'not-allowed');
	assert.equal(table.size, 0);
});

test('the endpoint files a change mark it is forwarded, with its demand', async () => {
	const cacheKey = ownedBy('node-a');
	const changedAt = Date.now();
	const answer = await handler(
		request({ body: { cacheKey, fromSitemap: true, effectiveInterval: 48 * HOUR, changedAt, demandPeriod: 6 * HOUR } })
	);
	assert.equal(answer.status, 200);
	assert.equal(JSON.parse(answer.body).outcome, 'filed');
	assert.equal(table.get(cacheKey).changedAt, changedAt);
	assert.equal(table.get(cacheKey).demandPeriod, 6 * HOUR);
});
