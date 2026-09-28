/**
 * The cluster fan-out, through the real resource: `PrerenderConsole.clusterGet` → `fanOut` → the merge.
 *
 * What this pins is the plumbing that makes a 503 an ANSWER. A node whose queue keeper is loading
 * answers `queue-state` 503 with its reason and stats; `fanOut` must hand that body to the merge (as
 * `errorBody`, apart from the `body` every merger treats as usable), or the loading node reads as down
 * and its reason is lost. The merge tests feed hand-built results and cannot see that seam.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

// The resource extends Harper's global `Resource`; nothing else of Harper is touched on this path.
globalThis.Resource ??= class {};
const { PrerenderConsole } = await import('../src/resources/PrerenderConsole.js');
const { config } = await import('../src/config.js');

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/plugin-0.93.0-${name}.json`, import.meta.url)));

/** A stand-in prerender node: answers every admin route with `status` and `body`, and records cookies. */
async function node(status, body) {
	const seen = [];
	const server = createServer((req, res) => {
		seen.push({ url: req.url, cookie: req.headers.cookie ?? null });
		res.writeHead(status, { 'content-type': 'application/json' });
		res.end(JSON.stringify(body));
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const origin = `http://127.0.0.1:${server.address().port}`;
	return { origin, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('a node answering queue-state 503 reaches the merge as an answer, with its reason and stats', async (t) => {
	const loading = await node(503, fixture('queue-state-503-loading'));
	const live = await node(200, fixture('queue-state-live'));
	const saved = config.nodes;
	config.nodes = [loading.origin, live.origin];
	t.after(async () => {
		config.nodes = saved;
		await Promise.all([loading.close(), live.close()]);
	});

	const tokens = { [loading.origin]: 'hdb-session=one', [live.origin]: 'hdb-session=two' };
	const res = await PrerenderConsole.clusterGet('queue-state', '', tokens);
	assert.equal(res.status, 200);
	const body = await res.json();

	const loadingRow = body.nodes.find((row) => row.origin === loading.origin);
	assert.equal(loadingRow.answered, true, 'the 503 body must reach the merge — fanOut keeps it as errorBody');
	assert.equal(loadingRow.httpStatus, 503);
	assert.equal(loadingRow.error, 'the queue keeper is loading');
	assert.equal(loadingRow.trust.phase, 'loading');
	assert.equal(loadingRow.now.status, 'queued');

	assert.equal(body.nodes.find((row) => row.origin === live.origin).live, true);
	assert.equal(body.cluster, null, 'one node cannot vouch, so the total is withheld');
	assert.equal(body.sources.complete, true, 'a loading node is not a down node');

	// Each node got the operator's own session for that node, and only the admin route.
	assert.deepEqual(loading.seen, [{ url: '/prerender_admin/queue-state', cookie: 'hdb-session=one' }]);
	assert.deepEqual(live.seen, [{ url: '/prerender_admin/queue-state', cookie: 'hdb-session=two' }]);
});

test('a node on a plugin before v0.93.0 reaches the merge as a node without a keeper', async (t) => {
	const old = await node(404, { error: 'Unknown route: queue-state' });
	const saved = config.nodes;
	config.nodes = [old.origin];
	t.after(async () => {
		config.nodes = saved;
		await old.close();
	});
	const res = await PrerenderConsole.clusterGet('queue-state', '', { [old.origin]: 'hdb-session=x' });
	assert.equal(res.status, 200);
	const [row] = (await res.json()).nodes;
	assert.equal(row.noKeeper, true);
});

test('an error body never becomes a usable body for any other merger', async (t) => {
	// The overview merger reads `body` for every OK result; a 503 overview must stay a failed source.
	const broken = await node(503, { error: 'overloaded', nodes: [{ hostname: 'ghost', status: 'queued' }] });
	const saved = config.nodes;
	config.nodes = [broken.origin];
	t.after(async () => {
		config.nodes = saved;
		await broken.close();
	});
	const res = await PrerenderConsole.clusterGet('overview', '', { [broken.origin]: 'hdb-session=x' });
	assert.equal(res.status, 502);
	const body = await res.json();
	assert.equal(body.sources.answered, 0);
	assert.equal(body.sources.nodes[0].error, 'overloaded');
});
