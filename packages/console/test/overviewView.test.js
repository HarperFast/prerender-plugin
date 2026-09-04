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

function makeCtx({ overview = OVERVIEW, purge = { running: false }, analytics = ANALYTICS } = {}) {
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
			if (route === 'analytics') return { ok: true, body: analytics };
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
	const input = find(card, (n) => n.tagName === 'INPUT' && n.attributes.type === 'text');
	input.value = ' https://www.example.com/catalog/ ';
	button(card, 'Dry-run census').listeners.click[0]();
	assert.deepEqual(ctx.calls.posts.at(-1), {
		route: 'discovery-purge',
		// skipVisited rides on the CENSUS too, and that is the point of sending it explicitly: a
		// census run under a different predicate from the purge that follows counts a population
		// nobody is going to delete.
		data: { urlPrefix: 'https://www.example.com/catalog/', dryRun: true, skipVisited: true },
	});
});

// A census that spares bot-visited targets and a purge that does not would delete rows the census
// never counted — the operator approves one number and a different one happens. The flag is sent
// on both calls from the same piece of state, so the census is always a preview of the purge.
test('sparing bot-visited targets is the default, and the census previews the same predicate', async () => {
	const ctx = await ready();
	const card = cardTitled(ctx, 'Discovered targets');
	const box = find(card, (n) => n.tagName === 'INPUT' && n.attributes.type === 'checkbox');
	assert.equal(box.attributes.checked, '', 'the safe predicate is the default');

	const input = find(card, (n) => n.tagName === 'INPUT' && n.attributes.type === 'text');
	input.value = 'https://www.example.com/catalog/';

	box.listeners.change[0]({ target: { checked: false } });
	button(card, 'Dry-run census').listeners.click[0]();
	assert.equal(ctx.calls.posts.at(-1).data.skipVisited, false, 'unticking it reaches the census');

	box.listeners.change[0]({ target: { checked: true } });
	button(card, 'Dry-run census').listeners.click[0]();
	assert.equal(ctx.calls.posts.at(-1).data.skipVisited, true);
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

// THE "NOT REACHED" FIGURE IS A SUBTRACTION, and every way a discovered row survived the pass has
// to be a term in it. A purge that spared 3,000 bot-visited rows on purpose and deferred 12 as
// in-flight has 3,012 rows it deliberately kept — counting only the deferred ones reports the rest
// as keyspace the pass never got to, which is a completed pass rendered as an interrupted one.
test('rows spared on purpose are accounted for, not reported as keyspace the pass never reached', async () => {
	const spared = {
		...CENSUS,
		skipVisited: true,
		canceled: true,
		discovered: 9000,
		deleted: 5988,
		leaseSkipped: 12,
		visitedSkipped: 3000,
		errors: 0,
	};
	const card = cardTitled(await ready({ purge: spared }), 'Discovered targets');
	assert.match(card.textContent, /Spared as bot-visited/);
	assert.match(card.textContent, /3,000/);
	assert.doesNotMatch(card.textContent, /Not reached/);
});

// The counterpart: once the terms DO leave a remainder, the card has to say so — a stopped pass
// that left 1,000 rows under the prefix has not cleared it, whatever the deleted count looks like.
test('a genuine remainder is still called out after the new terms are subtracted', async () => {
	const stopped = {
		...CENSUS,
		skipVisited: true,
		canceled: true,
		discovered: 9000,
		deleted: 5000,
		leaseSkipped: 0,
		visitedSkipped: 3000,
		errors: 0,
	};
	assert.match(cardTitled(await ready({ purge: stopped }), 'Discovered targets').textContent, /~1,000 left/);
});

// "Spared 0" and "did not check" are different findings and only one of them says the prefix has
// no live crawler demand on it. At zero the row still has to appear, or an operator reads a purge
// that checked and found nothing as one that never applied the predicate.
test('a sparing pass that spared nothing says so, rather than dropping the row', async () => {
	const none = { ...CENSUS, skipVisited: true, visitedSkipped: 0 };
	assert.match(cardTitled(await ready({ purge: none }), 'Discovered targets').textContent, /Spared as bot-visited/);

	const off = { ...CENSUS, skipVisited: false, visitedSkipped: 0 };
	assert.doesNotMatch(
		cardTitled(await ready({ purge: off }), 'Discovered targets').textContent,
		/Spared as bot-visited/
	);
});

// A delete that failed is a row STILL IN THE CORPUS and still being re-rendered on cadence — it
// appears in no render metric, no serve metric and no other console surface. If the card does not
// name it, nothing does.
test('delete failures are surfaced with their samples, not folded into the deleted count', async () => {
	const failed = {
		...CENSUS,
		dryRun: false,
		errors: 25,
		abortedOnErrors: true,
		errorSamples: [{ url: 'https://www.example.com/catalog/x', error: 'transaction timeout' }],
	};
	const text = cardTitled(await ready({ purge: failed }), 'Discovered targets').textContent;
	assert.match(text, /Failed — left for the next pass/);
	assert.match(text, /STOPPED ITSELF/);
	assert.match(text, /transaction timeout/);
});

// Under cluster scope the nodes can have run DIFFERENT predicates over the same prefix, and a
// single total silently sums both. The rows the non-sparing nodes deleted are gone; re-running the
// sparing ones does not bring them back, so the divergence has to be said out loud.
test('a cluster where only some nodes spared bot-visited targets is called out', async () => {
	const mixed = {
		...CENSUS,
		scope: 'cluster',
		ranNodes: 3,
		skipVisited: false,
		skipVisitedOn: ['a.example.com:9926'],
		totals: { examined: 100_000, owned: 25_000, discovered: 9000, leaseSkipped: 0, visitedSkipped: 40, deleted: 8960 },
	};
	const text = cardTitled(await ready({ purge: mixed }), 'Discovered targets').textContent;
	assert.match(text, /Only a\.example\.com:9926 spared bot-visited targets/);
	assert.match(text, /sum two different predicates/);
});

// ---- the serve strip's offload tile -----------------------------------------------

/** One analytics combo, in the shape `util/analyticsRead.js` emits (four buckets, flat). */
const combo = (metric, path, method, type, count, value) => ({
	metric,
	path,
	method,
	type,
	count,
	total: 0,
	counts: [count / 4, count / 4, count / 4, count / 4],
	...(value === undefined ? {} : { mean: value, median: value, p95: value, means: [value, value, value, value] }),
});

test('the offload tile shows the gross figure with the net one underneath, from the same arithmetic as Traffic', async () => {
	// 900 of 1,000 serves from cache (90% gross); 500 renders and a 100-probe pass mean the origin
	// answered 700 of 1,000 crawler requests — 30% net. The headline alone would be the flattering
	// number; the subtitle is what stops it being quoted on its own.
	const analytics = {
		...ANALYTICS,
		startMs: 0,
		endMs: 3_600_000,
		bucketMs: 900_000,
		bucketCount: 4,
		series: [
			combo('bot_serve', 'cache', 'hit', 'googlebot', 900),
			combo('bot_serve', 'origin', 'miss', 'googlebot', 100),
			combo('bot_request', 'www.example.com', 'googlebot', 'desktop', 1000),
			combo('render', 'outcome', 'rendered', null, 500),
			combo('prerender_ops', 'probe_probed', null, null, 1, 100),
		],
	};
	const ctx = await ready({ analytics });
	const tile = find(
		draw(ctx),
		(n) => n.attributes?.class === 'stat' && n.children[0]?.textContent === 'Origin offload'
	);
	assert.ok(tile, 'expected an Origin offload tile');
	assert.match(tile.textContent, /90%/);
	assert.match(tile.textContent, /30% net of renders \+ probes/);
	assert.match(tile.textContent, /before crawler follow-up requests/);
	// Below half on the net figure warns even though the gross one is fine.
	assert.ok(
		find(tile, (n) => n.attributes?.class === 'value warn'),
		'a 30% net offload should warn'
	);
});

test('with script calls measured the offload subtitle says so, instead of the documents-only caveat', async () => {
	const analytics = {
		...ANALYTICS,
		startMs: 0,
		endMs: 3_600_000,
		bucketMs: 900_000,
		bucketCount: 4,
		series: [
			combo('bot_serve', 'cache', 'hit', 'googlebot', 900),
			combo('bot_serve', 'origin', 'miss', 'googlebot', 100),
			combo('bot_request', 'www.example.com', 'googlebot', 'desktop', 1000),
			combo('render', 'outcome', 'rendered', null, 100),
			// 900 script-stripped snapshots to Googlebot at k=4: 3,600 calls spared on the baseline.
			combo('hydration_calls', 'saved', 'googlebot', 'cache', 900, 4),
		],
	};
	const ctx = await ready({ analytics });
	const tile = find(
		draw(ctx),
		(n) => n.attributes?.class === 'stat' && n.children[0]?.textContent === 'Origin offload'
	);
	// (4,600 − 200) ÷ 4,600 = 96% — the saving the documents-only figure (80%) could not credit.
	assert.match(tile.textContent, /96% net of renders \+ probes · script calls counted/);
	assert.doesNotMatch(tile.textContent, /before crawler follow-up requests/);
});
