/**
 * The app shell, executed — the things about it an operator feels on every click: where the page
 * is scrolled, what shows while a view is loading, and which answer wins when two loads race.
 *
 * Rendering replaces the whole tree, so without deliberate restoration the scroll position resets
 * on every state change: a filter chip, a table page, the busy render an action does before its
 * result lands. On the long views that made the lower panels effectively unusable — act on one and
 * you have to find your place again. It is invisible to every other kind of test, which is why the
 * shim now models a persistent `#app` and a `scrollTop` that survives it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installDom, find } from './domShim.js';

installDom();

const OVERVIEW = {
	generatedAt: Date.now(),
	node: 'node-a',
	workerIndex: 0,
	localQueueStatus: 'active',
	control: { cluster: null, knownScopes: [] },
	nodes: [],
	counts: null,
	countsAsOf: null,
	backlog: { enabled: true, interval: 60_000, running: false, lastRun: null },
	intervals: { statusSyncInterval: 1000, jobLeaseTime: 120_000, defaultRenderInterval: 21_600_000 },
	claimFloor: { floorMinute: 0, lagMs: null, oldestLeaseAgeMs: null },
	reconcile: { enabled: true, interval: 1, running: false, lastRun: null },
	orphanSweep: { dryRunDefault: true, maxDeletes: 1, running: false, lastRun: null },
};

// The first view load is held until the skeleton test has looked at the page.
let releaseFirst;
const firstLoad = new Promise((resolve) => (releaseFirst = resolve));

// An analytics window whose serve count IS its range in minutes, so which answer is on screen can be
// read straight off the Bot serves tile. `held` parks a response by range until the test releases it,
// so a race is staged by ORDER, never by sleeping and hoping.
const held = new Map();
const hold = (range) => {
	let release;
	held.set(range, new Promise((resolve) => (release = resolve)));
	return () => {
		held.delete(range);
		release();
	};
};
const analyticsFor = (rangeMs) => {
	const minutes = rangeMs / 60_000;
	return {
		available: true,
		rangeMs,
		startMs: 0,
		endMs: rangeMs,
		bucketMs: rangeMs,
		bucketCount: 1,
		scan: {},
		series: [
			{
				metric: 'bot_serve',
				path: 'cache',
				method: 'hit',
				type: 'googlebot',
				count: minutes,
				total: 0,
				counts: [minutes],
			},
		],
	};
};

globalThis.fetch = async (url) => {
	const route = String(url);
	if (!route.includes('session')) await firstLoad;
	const range = Number(new URL(route, 'http://x').searchParams.get('range'));
	if (route.includes('analytics') && held.has(range)) await held.get(range);
	return {
		ok: true,
		status: 200,
		json: async () => {
			if (route.includes('session')) return { authenticated: true, superUser: true, nodes: [], scope: 'cluster' };
			if (route.includes('overview')) return OVERVIEW;
			if (route.includes('analytics')) return analyticsFor(range || 3_600_000);
			return {};
		},
	};
};

// Importing the shell starts it: it loads the session and renders, exactly as the page does.
await import('../src/admin/app.js');

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const app = () => document.getElementById('app');
const main = () => app().querySelector('.main');
const navButton = (label) => find(app(), (n) => n.tagName === 'BUTTON' && n.textContent.includes(label));
// The top bar's range picker is the only control labelled like this.
const rangeButton = (label) => find(app(), (n) => n.tagName === 'BUTTON' && n.textContent === label);

await settle();

// A view whose data has not arrived must say "loading", never "no data" — which is a claim about the
// cluster, not about the fetch. The old shell rendered the view immediately, and Sitemaps printed a
// red "No sitemap data." for as long as its first request took.
test('before a view’s first load lands, the shell shows a skeleton — not the view’s empty state', async () => {
	assert.ok(
		find(app(), (n) => n.attributes?.class === 'skeleton'),
		'expected the loading skeleton'
	);
	assert.doesNotMatch(app().textContent, /Could not load|No .* data/);
	releaseFirst();
	await settle();
	assert.equal(
		find(app(), (n) => n.attributes?.class === 'skeleton'),
		null,
		'the skeleton goes once data lands'
	);
});

test('the shell rendered, and its scroll container is findable', () => {
	assert.ok(main(), 'expected a .main scroll container');
});

test('re-rendering the same view KEEPS the operator where they were', async () => {
	main().scrollTop = 640;

	// Any state change rebuilds the tree; navigating to the view already open is the cheapest one
	// to drive from here, and takes the same code path as a filter click or a table page.
	navButton('Health').fire('click');
	await settle();

	assert.equal(main().scrollTop, 640, 'a rebuild of the same view must not scroll back to the top');
});

test('a scroll position survives several rebuilds, not just the first', async () => {
	main().scrollTop = 210;
	for (let i = 0; i < 3; i++) {
		navButton('Health').fire('click');
		await settle();
	}
	assert.equal(main().scrollTop, 210);
});

test('switching views starts at the top — arriving halfway down a new page is its own confusion', async () => {
	main().scrollTop = 900;

	navButton('Traffic').fire('click');
	await settle();

	assert.equal(main().scrollTop, 0);
});

test('and coming back does not resurrect the other view’s position', async () => {
	main().scrollTop = 300; // on Traffic
	navButton('Health').fire('click');
	await settle();
	assert.equal(main().scrollTop, 0, 'Health is a different page than the one that was scrolled');
});

// THE RACE THE OPERATOR SAW: pick 24h, then 15m before the 24h scan returns. The slower answer lands
// last, and without sequencing it overwrote the 15m data under a picker reading "15m".
test('a superseded range load cannot overwrite the newer one, however late it lands', async () => {
	navButton('Health').fire('click');
	await settle();
	const release24h = hold(86_400_000);
	rangeButton('24h').fire('click');
	await settle();
	rangeButton('15m').fire('click');
	await settle();
	// The 15m answer is on screen; NOW the stale 24h answer lands.
	release24h();
	await settle();

	const tile = find(
		app(),
		(n) => (n.attributes?.class ?? '').startsWith('vital') && n.textContent.includes('Bot serves')
	);
	assert.ok(tile, 'expected the Bot serves check');
	assert.match(tile.textContent, /15 in range/, 'the 15m answer must be the one on screen');
	assert.doesNotMatch(tile.textContent, /1,440 in range/);
	assert.equal(rangeButton('15m').attributes.class, 'on');
});
