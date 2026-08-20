/**
 * The app shell, executed — specifically the one thing about it an operator feels on every click.
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

globalThis.fetch = async (url) => ({
	ok: true,
	status: 200,
	json: async () => {
		const route = String(url);
		if (route.includes('session')) return { authenticated: true, superUser: true, nodes: [], scope: 'cluster' };
		if (route.includes('overview')) return OVERVIEW;
		if (route.includes('analytics'))
			return { available: true, series: [], bucketCount: 1, startMs: 0, endMs: 1, bucketMs: 1, scan: {} };
		return {};
	},
});

// Importing the shell starts it: it loads the session and renders, exactly as the page does.
await import('../src/admin/app.js');

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const app = () => document.getElementById('app');
const main = () => app().querySelector('.main');
const navButton = (label) => find(app(), (n) => n.tagName === 'BUTTON' && n.textContent.includes(label));

await settle();

test('the shell rendered, and its scroll container is findable', () => {
	assert.ok(main(), 'expected a .main scroll container');
});

test('re-rendering the same view KEEPS the operator where they were', async () => {
	main().scrollTop = 640;

	// Any state change rebuilds the tree; navigating to the view already open is the cheapest one
	// to drive from here, and takes the same code path as a filter click or a table page.
	navButton('Overview').fire('click');
	await settle();

	assert.equal(main().scrollTop, 640, 'a rebuild of the same view must not scroll back to the top');
});

test('a scroll position survives several rebuilds, not just the first', async () => {
	main().scrollTop = 210;
	for (let i = 0; i < 3; i++) {
		navButton('Overview').fire('click');
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
	navButton('Overview').fire('click');
	await settle();
	assert.equal(main().scrollTop, 0, 'Overview is a different page than the one that was scrolled');
});
