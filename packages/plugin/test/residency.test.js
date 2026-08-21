import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Residency is the shard map for the whole RenderSchedule keyspace, and a wrong answer is
 * silent: the row is stored on a node that does not own it, the owner never gets it, and
 * nothing deletes it. The properties pinned here are therefore about WHERE the node list comes
 * from — an empty `server.nodes` must never read as "this node owns everything" — plus the
 * mapping itself, so no refactor can re-shard a live cluster.
 */

const A = 'node-a.example.com';
const B = 'node-b.example.com';
const C = 'node-c.example.com';
const SELF = 'node-d.example.com';
const ALL = [A, B, C, SELF].sort();

let warnings;
let freshCounter = 0;

const setServer = (hostname, peerNames) => {
	globalThis.server = { hostname, nodes: peerNames === null ? undefined : peerNames.map((name) => ({ name })) };
};

// Each test gets its own module instance so "never seen a peer" and the warn-once latch are
// testable; every OTHER test proves the module needs no reload to pick a change up.
const freshResidency = () => import(`../src/util/residency.js?fresh=${freshCounter++}`);

beforeEach(() => {
	warnings = [];
	globalThis.logger = { warn: (m) => warnings.push(String(m)), error: () => {}, trace: () => {}, debug: () => {} };
});

afterEach(() => {
	delete globalThis.server;
	delete globalThis.logger;
});

test('a peer list that appears AFTER module load is picked up without a reload', async () => {
	setServer(SELF, []);
	const { getResidencyByUrl, getNodes } = await freshResidency();

	// The load-time snapshot bug: with no peers, self owns everything.
	assert.equal(getResidencyByUrl('https://example.com/a'), SELF);
	assert.deepEqual(getNodes(), [SELF]);

	globalThis.server.nodes = [A, B, C].map((name) => ({ name }));

	assert.deepEqual(getNodes(), ALL);
});

test('every node computes the SAME owner from the same membership', async () => {
	const url = 'https://example.com/catalog?page=2';
	const verdicts = [];
	for (const self of ALL) {
		setServer(
			self,
			ALL.filter((h) => h !== self)
		);
		const { getResidencyByUrl } = await freshResidency();
		verdicts.push(getResidencyByUrl(url));
	}
	assert.equal(new Set(verdicts).size, 1, 'nodes disagreed on the owner');
});

test('the keyspace mapping is unchanged', async () => {
	// A CHANGE-DETECTOR ON PURPOSE. These pairs are computed by the current FNV-1a + HRW pair,
	// and one key is pinned per node so the assertion also proves the ring still spreads rather
	// than collapsing onto self. Any edit that moves one of them re-shards every RenderSchedule
	// row on every running cluster — the hazard util/hash.js already warns about for the mixing
	// constant. If one of these fails, that is the finding; do not update the expectation.
	setServer(SELF, [A, B, C]);
	const { getResidencyByUrl } = await freshResidency();
	assert.equal(getResidencyByUrl('https://example.com/catalog?page=0'), A);
	assert.equal(getResidencyByUrl('https://example.com/catalog?page=2'), B);
	assert.equal(getResidencyByUrl('https://example.com/catalog?page=8'), C);
	assert.equal(getResidencyByUrl('https://example.com/catalog?page=3'), SELF);
});

test('self appearing in server.nodes does not re-shard the keyspace', async () => {
	// server.nodes is meant to hold PEERS only, but self has leaked into it before
	// (harper-pro#489). Deduplicating must not move a single key: HRW takes the max score over
	// the NAMES present, so a repeated name cannot change which name wins.
	setServer(SELF, [A, B, C]);
	const clean = await freshResidency();
	setServer(SELF, [A, B, C, SELF]);
	const withSelf = await freshResidency();

	assert.deepEqual(withSelf.getNodes(), clean.getNodes());
	for (let i = 0; i < 500; i++) {
		const url = `https://example.com/p/${i}`;
		assert.equal(withSelf.getResidencyByUrl(url), clean.getResidencyByUrl(url), url);
	}
});

test('a transient empty peer list does not move ownership', async () => {
	setServer(SELF, [A, B, C]);
	const { getResidencyByUrl, getNodes } = await freshResidency();
	const url = 'https://example.com/catalog?page=2';
	assert.equal(getResidencyByUrl(url), B);

	// knownNodes.ts assigns a fresh empty array while rebuilding from hdb_nodes.
	globalThis.server.nodes = [];
	assert.equal(getResidencyByUrl(url), B, 'ownership moved to self during a rebuild window');
	assert.deepEqual(getNodes(), ALL);

	globalThis.server.nodes = undefined;
	assert.equal(getResidencyByUrl(url), B, 'ownership moved to self when server.nodes went away');
});

test('a genuine membership change IS adopted', async () => {
	setServer(SELF, [A, B, C]);
	const { getNodes } = await freshResidency();
	getNodes();

	// One node retired: still a non-empty list, so it must take effect.
	globalThis.server.nodes = [B, C].map((name) => ({ name }));
	assert.deepEqual(getNodes(), [B, C, SELF].sort());
	assert.ok(!getNodes().includes(A));
});

test('a push onto the existing array is seen (same identity, new length)', async () => {
	setServer(SELF, [A]);
	const { getNodes } = await freshResidency();
	assert.deepEqual(getNodes(), [SELF, A].sort());

	// knownNodes.ts pushes onto server.nodes rather than reassigning it.
	globalThis.server.nodes.push({ name: C });
	assert.deepEqual(getNodes(), [A, C, SELF].sort());
});

test('a nameless node descriptor is never returned as an owner', async () => {
	// knownNodes.ts can push a reconstructed descriptor with no name. Left in the ring it wins
	// the hash for some keys, and returning undefined makes Harper store the row nowhere.
	setServer(SELF, [A, B, C]);
	globalThis.server.nodes.push({ name: undefined }, {}, null);
	const { getResidencyByUrl, getNodes } = await freshResidency();

	assert.deepEqual(getNodes(), ALL);
	for (let i = 0; i < 300; i++) {
		const owner = getResidencyByUrl(`https://example.com/p/${i}`);
		assert.ok(getNodes().includes(owner), `key ${i} resolved to ${owner}`);
	}
});

test('a populated peer list with no usable names is treated as peerless', async () => {
	// A decode miss can put descriptors in server.nodes that carry no name. A list of nothing
	// but those is "not known yet", not "this node is alone" — it must warn, and it must not
	// overwrite a good list with a self-only one.
	setServer(SELF, []);
	globalThis.server.nodes = [{ name: undefined }, {}, null];
	const { getResidencyByUrl, getNodes } = await freshResidency();

	assert.deepEqual(getNodes(), [SELF]);
	assert.equal(warnings.filter((w) => w.includes('never seen a peer')).length, 1);

	globalThis.server.nodes = [A, B, C].map((name) => ({ name }));
	const url = 'https://example.com/catalog?page=2';
	assert.equal(getResidencyByUrl(url), B);

	// ...and a later all-nameless list must not clobber the good one.
	globalThis.server.nodes = [{ name: undefined }, {}];
	assert.equal(getResidencyByUrl(url), B);
	assert.deepEqual(getNodes(), ALL);
});

test('a peerless residency decision warns exactly once', async () => {
	setServer(SELF, []);
	const { getResidencyByUrl } = await freshResidency();
	for (let i = 0; i < 5; i++) getResidencyByUrl(`https://example.com/${i}`);

	const peerless = warnings.filter((w) => w.includes('never seen a peer'));
	assert.equal(peerless.length, 1);
	assert.match(peerless[0], /stored locally instead of on their owner/);
});

test('a single-node deployment resolves to itself without repeated warnings', async () => {
	setServer(SELF, null);
	const { getResidencyByUrl, getNodes } = await freshResidency();
	assert.equal(getResidencyByUrl('https://example.com/a'), SELF);
	assert.deepEqual(getNodes(), [SELF]);
	assert.equal(warnings.filter((w) => w.includes('never seen a peer')).length, 1);
	// This branch is taken on EVERY call here, so it must not allocate either.
	assert.equal(getNodes(), getNodes());
});

test('an unchanged peer list is not rebuilt per call', async () => {
	// The reconcile and orphan sweeps call this once per row across the whole corpus, so the
	// steady-state path must not allocate.
	setServer(SELF, [A, B, C]);
	const { getNodes } = await freshResidency();
	assert.equal(getNodes(), getNodes(), 'the node list was rebuilt for an unchanged peer list');
});

test('isKnownNode accepts a peer that joined after module load', async () => {
	// The same stale snapshot made peer.js reject legitimate peers, breaking the explainer's
	// cross-node fetch. It reads through the same accessor, so it heals with it.
	globalThis.server = { hostname: SELF, nodes: [], config: { http: { port: 9925, securePort: 9926 } } };
	const peer = await import(`../src/util/peer.js?fresh=${freshCounter++}`);
	assert.equal(peer.isKnownNode(C), false);

	globalThis.server.nodes = [{ name: C }];
	assert.equal(peer.isKnownNode(C), true);
	assert.equal(peer.isKnownNode('evil.example.com'), false);
});
