/**
 * The fetch layer's in-flight sharing.
 *
 * Views overlap in what they read, and the shell drops a superseded load's response without being
 * able to cancel its request — so identical GETs in flight share one request. The hazard is a read
 * that crosses a WRITE: the reload after an action, or the session check after sign-out, must never
 * ride a request issued before the POST.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from './domShim.js';

installDom();

// Every fetch is held until the test releases it, and counted.
const pending = [];
globalThis.fetch = (url, options) =>
	new Promise((resolve) => {
		pending.push({
			url: String(url),
			method: options?.method ?? 'GET',
			release: (body) => resolve({ ok: true, status: 200, json: async () => body }),
		});
	});

const { get, post } = await import('../src/admin/api.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('identical GETs in flight share one request', async () => {
	pending.length = 0;
	const a = get('overview');
	const b = get('overview');
	assert.equal(pending.length, 1, 'the second caller rides the first');
	pending[0].release({ n: 1 });
	assert.deepEqual((await a).body, { n: 1 });
	assert.deepEqual((await b).body, { n: 1 });
});

test('a finished request is never reused — Refresh always reaches the server', async () => {
	pending.length = 0;
	const first = get('overview');
	pending[0].release({ n: 1 });
	await first;
	await flush();
	get('overview');
	assert.equal(pending.length, 2);
	pending[1].release({ n: 2 });
});

test('a GET issued after a POST never rides one issued before it', async () => {
	pending.length = 0;
	const before = get('change-probe');
	const write = post('change-probe', { action: 'start' });
	const after = get('change-probe');
	const gets = pending.filter((p) => p.method === 'GET');
	assert.equal(gets.length, 2, 'the post-write read is its own request');

	gets[0].release({ running: false });
	gets[1].release({ running: true });
	pending.find((p) => p.method === 'POST').release({ ok: true });
	assert.equal((await before).body.running, false);
	assert.equal((await after).body.running, true, 'the reload after "Start" sees the started probe');
	await write;
});

test('a pre-POST request finishing late does not evict the post-POST one from sharing', async () => {
	pending.length = 0;
	get('overview');
	post('queue', {});
	const newer = get('overview');
	const gets = pending.filter((p) => p.method === 'GET');
	gets[0].release({ n: 'old' });
	await flush();
	// Still in flight, so a third identical read must share the newer request, not start a fourth.
	get('overview');
	assert.equal(pending.filter((p) => p.method === 'GET').length, 2);
	gets[1].release({ n: 'new' });
	assert.equal((await newer).body.n, 'new');
});
