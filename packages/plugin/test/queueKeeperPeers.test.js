import { test, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The queue keeper waits for the cluster's node list before it loads.
 *
 * Its own file because it needs a process whose `util/residency.js` has NEVER seen a peer: that
 * module latches the last non-empty list, so no test that runs after one with peers could see this.
 *
 * Why it matters: ownership decides what the keeper holds, and until the first `hdb_nodes` scan every
 * URL maps to this node. A keeper that loaded then would hold residency ghosts (stale rows another
 * node owns, which the index never surfaced) and rank them at the head of the queue.
 */

let service;
const sabs = new Map();
let listeners = 0;

before(async () => {
	globalThis.server = { hostname: 'node-a', workerIndex: 0, nodes: [], recordAnalytics() {} };
	globalThis.logger = { info() {}, warn() {}, error() {}, notify() {}, debug() {}, trace() {} };
	const primaryStore = {
		getUserSharedBuffer: (key, buffer) => {
			if (!sabs.has(key)) sabs.set(key, buffer);
			return sabs.get(key);
		},
		tryLock: () => true,
		unlock() {},
	};
	const RenderSchedule = {
		put: async () => {},
		delete: async () => {},
		search: () => (async function* () {})(),
		subscribe: async () => {
			listeners++;
			return { end: () => listeners-- };
		},
	};
	globalThis.databases = {
		render_schedule: { RenderSchedule },
		coordination: { SharedBuffer: { primaryStore } },
	};
	service = await import('../src/util/queueKeeperService.js');
});

test('with no peer visible it waits, and loads once one appears', async () => {
	const s = service.createKeeperService({ log: null, peerGraceMs: 60_000 });
	const loading = s.start();
	await new Promise((resolve) => setTimeout(resolve, 50));
	assert.equal(s.phase, 'waiting-for-peers');
	assert.equal(listeners, 0, 'nothing subscribed or loaded yet');
	server.nodes = [{ name: 'node-a' }, { name: 'node-b' }];
	await loading;
	assert.equal(s.phase, 'live');
	s.stop();
});
