/**
 * The Overview's discovered-target purge card.
 *
 * This is the console's second corpus-DELETING action, and it has one interlock the first does
 * not: gating the route has to happen BEFORE the purge, or crawlers re-mint exactly what was
 * removed and the pass becomes a rate-limited way to delete corpus and change nothing. The plugin
 * refuses that order with a 400; what this card owes the operator is that the refusal is never the
 * first they hear of it.
 *
 * The other thing under test is the never-run state. A node that has never purged answers
 * `{ running: false }` and nothing else — no counters at all — and rendering that as a row of
 * zeroes would read as a completed, clean census on a node whose discovered targets are all still
 * rendering.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installDom, find } from './domShim.js';

installDom();

const { el } = await import('../src/admin/ui.js');
const { load, render } = await import('../src/admin/views/overview.js');

const OVERVIEW = {
	generatedAt: Date.now(),
	node: 'a.example.com:9926',
	workerIndex: 0,
	localQueueStatus: 'queued',
	control: { cluster: null, knownScopes: [] },
	nodes: [],
	counts: null,
	countsAsOf: null,
	backlog: { enabled: true, interval: 60_000, running: false, lastRun: null },
	intervals: { statusSyncInterval: 1000, jobLeaseTime: 120_000, defaultRenderInterval: 21_600_000 },
	claimFloor: { floorMinute: 0, lagMs: null, oldestLeaseAgeMs: null },
	reconcile: { enabled: true, interval: 60_000, running: false, lastRun: null },
	orphanSweep: { dryRunDefault: true, maxDeletes: 1000, running: false, lastRun: null },
};

const ANALYTICS = { available: true, scope: 'node', node: 'a.example.com:9926', rangeMs: 3_600_000, series: [] };

const CENSUS = {
	node: 'a.example.com:9926',
	running: false,
	urlPrefix: 'https://www.example.com/catalog/',
	dryRun: true,
	ratePerSecond: 200,
	startedAt: 1000,
	finishedAt: 5000,
	error: null,
	examined: 100_000,
	owned: 25_000,
	discovered: 9000,
	leaseSkipped: 12,
	deleted: 9000,
	canceled: false,
};

function makeCtx({ overview = OVERVIEW, purge = { running: false } } = {}) {
	const views = {};
	const scratch = (id) => (views[id] ??= {});
	const calls = { posts: [] };
	return {
		calls,
		scratch,
		busy: false,
		get data() {
			return scratch('overview');
		},
		async get(route) {
			if (route === 'overview') return { ok: true, body: overview };
			if (route === 'analytics') return { ok: true, body: ANALYTICS };
			if (route === 'discovery-purge') return { ok: true, body: purge };
			return { ok: true, body: null };
		},
		async post(route, data) {
			calls.posts.push({ route, data });
			return { ok: true, body: {} };
		},
		async run(fn) {
			return fn();
		},
		render() {},
		reload() {},
		go() {},
	};
}

const draw = (ctx) => el('div', null, render(ctx));
const cardTitled = (ctx, title) =>
	find(draw(ctx), (n) => n.attributes?.class === 'card' && n.textContent.startsWith(title));
const button = (node, text) => find(node, (n) => n.tagName === 'BUTTON' && n.textContent === text);

const ready = async (options) => {
	const ctx = makeCtx(options);
	await load(ctx);
	return ctx;
};

test('a node that has never purged says so, instead of showing a clean census of zeroes', async () => {
	const ctx = await ready();
	const card = cardTitled(ctx, 'Discovered targets');
	assert.ok(card, 'expected a Discovered targets card');
	assert.match(card.textContent, /No purge has run on this node since startup/);
	assert.doesNotMatch(card.textContent, /Rows examined/);
});

test('the purge button is inert until a census has counted what it would delete', async () => {
	const before = await ready();
	assert.equal(button(cardTitled(before, 'Discovered targets'), 'Purge discovered').attributes.disabled, '');

	const after = await ready({ purge: CENSUS });
	const enabled = button(cardTitled(after, 'Discovered targets'), 'Purge discovered');
	assert.equal(enabled.attributes.disabled, undefined);
	assert.match(cardTitled(after, 'Discovered targets').textContent, /9,000/);
});

test('a census that already deleted does not offer to delete again', async () => {
	// `dryRun: false` means the last pass WAS the purge. Offering the danger button again would
	// invite a second full walk of a prefix that has already been cleared.
	const ctx = await ready({ purge: { ...CENSUS, dryRun: false } });
	assert.equal(button(cardTitled(ctx, 'Discovered targets'), 'Purge discovered').attributes.disabled, '');
});

test('the census posts a dry run and the purge does not, both carrying the typed prefix', async () => {
	const ctx = await ready();
	const card = cardTitled(ctx, 'Discovered targets');
	const input = find(card, (n) => n.tagName === 'INPUT');
	input.value = ' https://www.example.com/catalog/ ';
	button(card, 'Dry-run census').listeners.click[0]();
	assert.deepEqual(ctx.calls.posts.at(-1), {
		route: 'discovery-purge',
		data: { urlPrefix: 'https://www.example.com/catalog/', dryRun: true },
	});
});

test('an empty prefix does nothing at all — a bare origin is refused upstream anyway', async () => {
	const ctx = await ready();
	const card = cardTitled(ctx, 'Discovered targets');
	button(card, 'Dry-run census').listeners.click[0]();
	assert.equal(ctx.calls.posts.length, 0);
});

test('the gate-first interlock is stated on the card, not left to the plugin’s 400', async () => {
	const ctx = await ready();
	const text = cardTitled(ctx, 'Discovered targets').textContent;
	assert.match(text, /discoverTargets: false/);
	assert.match(text, /crawlers re-mint what this removes/);
	// And the population's boundary: a sitemap-declared URL is corpus by the operator's own
	// statement, whatever its traffic looks like.
	assert.match(text, /sitemap-declared URL is never/);
});

test('a running pass can be stopped, and says which node is running it', async () => {
	const ctx = await ready({
		purge: {
			...CENSUS,
			running: true,
			finishedAt: null,
			runningOn: ['b.example.com:9926'],
			sources: { mode: 'merged', answered: 2, configured: 2, complete: true, nodes: [] },
		},
	});
	const card = cardTitled(ctx, 'Discovered targets');
	assert.match(card.textContent, /running on b.example.com:9926/);
	assert.ok(button(card, 'Stop'), 'a paced pass that outlives the request needs a way to end it');
});

test('under cluster scope the pass refuses and names the keyspace problem', async () => {
	const ctx = await ready({
		overview: { ...OVERVIEW, sources: { mode: 'merged', answered: 4, configured: 4, complete: true, nodes: [] } },
	});
	const card = cardTitled(ctx, 'Discovered targets');
	const census = button(card, 'Census (pick a node)');
	assert.ok(census);
	assert.equal(census.attributes.disabled, '');
	assert.match(census.attributes.title, /run every node to cover the keyspace/);
});

test('a node nobody has purged is named — its discovered targets are still rendering', async () => {
	const ctx = await ready({
		purge: {
			...CENSUS,
			ranNodes: 1,
			unrunNodes: ['b.example.com:9926'],
			totals: { examined: 100_000, owned: 25_000, discovered: 9000, leaseSkipped: 12, deleted: 9000 },
			sources: { mode: 'merged', answered: 2, configured: 2, complete: true, nodes: [] },
		},
	});
	assert.match(cardTitled(ctx, 'Discovered targets').textContent, /Never run on b.example.com:9926/);
});

test('two nodes on different prefixes are not presented as one total', async () => {
	const ctx = await ready({
		purge: {
			...CENSUS,
			urlPrefix: null,
			urlPrefixes: ['https://www.example.com/catalog/', 'https://www.example.com/deals/'],
			ranNodes: 2,
			totals: { examined: 200_000, owned: 50_000, discovered: 18_000, leaseSkipped: 24, deleted: 18_000 },
			sources: { mode: 'merged', answered: 2, configured: 2, complete: true, nodes: [] },
		},
	});
	assert.match(cardTitled(ctx, 'Discovered targets').textContent, /add up two populations/);
});

test('a pass stopped early reports what it never reached, rather than reading as complete', async () => {
	const ctx = await ready({
		purge: { ...CENSUS, canceled: true, dryRun: false, discovered: 9000, deleted: 3000, leaseSkipped: 0 },
	});
	const text = cardTitled(ctx, 'Discovered targets').textContent;
	assert.match(text, /stopped early/);
	assert.match(text, /~6,000 left under this prefix/);
});
