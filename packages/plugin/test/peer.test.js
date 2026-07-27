import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Peer-call construction for the explainer's cross-node schedule fetch.
 *
 * The point of this module is to replace Harper's UNBOUNDED cross-node record fetch with a
 * bounded HTTPS call, so the properties worth pinning are the safety ones: TLS for a peer,
 * only-credential header forwarding, and refusing a destination that isn't a known cluster
 * node (so a residency bug can't turn this into an arbitrary-host request).
 */

const setServer = (hostname, http) => {
	globalThis.server = { hostname, config: { http }, nodes: [] };
};

let peer;

beforeEach(async () => {
	// residency.js reads `server` at module load to build the node list, so the global must
	// exist before the import graph is evaluated.
	setServer('node-a.example.com', { port: 9925, securePort: 9926 });
	peer = await import('../src/util/peer.js');
});

afterEach(() => {
	delete globalThis.server;
});

test('a peer is addressed over https on the secure port', () => {
	// The Harper HTTP port serves TLS in every real deployment; speaking http to it gets the
	// connection closed with zero bytes.
	assert.equal(peer.peerOrigin('node-b.example.com'), 'https://node-b.example.com:9926');
});

test('only a localhost origin uses plain http', () => {
	assert.equal(peer.peerOrigin('localhost'), 'http://localhost:9925');
	assert.equal(peer.peerOrigin('127.0.0.1'), 'http://127.0.0.1:9925');
});

test('only credential headers are forwarded', () => {
	const headers = new Headers({
		'authorization': 'Basic abc',
		'cookie': 'hdb-session=xyz',
		'x-forwarded-host': 'evil.example.com',
		'user-agent': 'curl/8',
		'content-length': '99',
	});

	assert.deepEqual(peer.credentialHeaders(headers), {
		authorization: 'Basic abc',
		cookie: 'hdb-session=xyz',
	});
});

test('absent credentials yield an empty set rather than undefined entries', () => {
	assert.deepEqual(peer.credentialHeaders(new Headers({})), {});
	assert.deepEqual(peer.credentialHeaders(undefined), {});
});

test('the destination must be a known cluster node', async () => {
	// `nodes` is [server.hostname, ...server.nodes] — so only node-a here.
	assert.equal(peer.isKnownNode('node-a.example.com'), true);
	assert.equal(peer.isKnownNode('evil.example.com'), false);
	assert.equal(peer.isKnownNode(undefined), false);

	// And the fetch refuses an unknown host before issuing any request. If this regressed, the
	// owner value (which comes from a hash function, not user input) could still be steered by
	// a residency or config bug into an arbitrary-host call.
	const result = await peer.fetchScheduleFromPeer({
		hostname: 'evil.example.com',
		cacheKey: 'https://x/|desktop',
		headers: new Headers({ authorization: 'Basic abc' }),
	});
	assert.equal(result.ok, false);
	assert.match(result.reason, /unknown node/);
});

test('no forwardable credentials short-circuits instead of calling the peer unauthenticated', async () => {
	const result = await peer.fetchScheduleFromPeer({
		hostname: 'node-a.example.com',
		cacheKey: 'https://x/|desktop',
		headers: new Headers({}),
	});
	assert.equal(result.ok, false);
	assert.match(result.reason, /no forwardable credentials/);
});

/**
 * Robustness cases raised in review on PR #36.
 */

test('an IPv6 peer literal is bracketed so the URL parses', () => {
	// Unbracketed, `https://2001:db8::1:9926` is not a parseable URL and fetch would reject.
	assert.equal(peer.peerOrigin('2001:db8::1'), 'https://[2001:db8::1]:9926');
	// Already-bracketed input is left alone rather than double-wrapped.
	assert.equal(peer.peerOrigin('[2001:db8::1]'), 'https://[2001:db8::1]:9926');
	// And the loopback literal this module already special-cases stays valid.
	assert.equal(peer.peerOrigin('::1'), 'http://[::1]:9925');
	// Every form must survive URL parsing.
	for (const host of ['2001:db8::1', '[2001:db8::1]', '::1', 'node-b.example.com']) {
		assert.doesNotThrow(() => new URL(peer.peerOrigin(host)), `unparseable origin for ${host}`);
	}
});

test('known-node matching is case-insensitive, as hostnames are', () => {
	assert.equal(peer.isKnownNode('NODE-A.example.com'), true);
	assert.equal(peer.isKnownNode('node-a.EXAMPLE.COM'), true);
	// ...but membership in the known set is still required.
	assert.equal(peer.isKnownNode('node-a.example.com.evil.test'), false);
});

test('a non-Error rejection is reported, not re-thrown', async () => {
	const realFetch = globalThis.fetch;
	try {
		// Anything can be thrown; `null` in particular would make a direct `.name` access throw
		// and turn a degraded field into a 500.
		for (const thrown of [null, undefined, 'a string', 42]) {
			globalThis.fetch = () => Promise.reject(thrown);
			const result = await peer.fetchScheduleFromPeer({
				hostname: 'node-a.example.com',
				cacheKey: 'https://x/|desktop',
				headers: new Headers({ authorization: 'Basic abc' }),
			});
			assert.equal(result.ok, false);
			assert.match(result.reason, /peer fetch failed/);
		}
	} finally {
		globalThis.fetch = realFetch;
	}
});

test('an aborted fetch is classified as a timeout, not a generic failure', async () => {
	const realFetch = globalThis.fetch;
	try {
		// A DOMException-shaped abort: the distinction matters because "peer timed out" tells the
		// operator something different from "peer fetch failed".
		globalThis.fetch = () => {
			const error = new Error('This operation was aborted');
			error.name = 'AbortError';
			return Promise.reject(error);
		};
		const result = await peer.fetchScheduleFromPeer({
			hostname: 'node-a.example.com',
			cacheKey: 'https://x/|desktop',
			headers: new Headers({ authorization: 'Basic abc' }),
		});
		assert.equal(result.ok, false);
		assert.equal(result.reason, 'peer timed out');
	} finally {
		globalThis.fetch = realFetch;
	}
});
