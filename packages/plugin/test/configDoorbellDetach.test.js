/**
 * The config-override doorbell and the `onConfigApplied` dispatch run outside the async context that
 * triggered them (util/detach.js).
 *
 * Harper carries a request's transaction in the async context. The override subscription's listener
 * may run in the context of the request whose write rang it, and every `onConfigApplied` listener
 * re-arms scheduler timers, which capture the context they are armed in. Left inline, a console edit
 * would run the re-read, the apply and every re-armed timer on a transaction Harper closes after the
 * response ("Database closed during transaction get").
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { applyOptions, onConfigApplied } from '../src/config.js';
import { resetOverrideWatchForTests, startOverrideWatch } from '../src/util/configOverride.js';

globalThis.logger = { debug() {}, info() {}, warn() {}, error() {} };

const requestContext = new AsyncLocalStorage();
const REQUEST = { transaction: 'the request’s' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
	resetOverrideWatchForTests();
	delete globalThis.databases;
	applyOptions({});
});

test('an onConfigApplied listener, and a timer it arms, run outside the context of the apply’s caller', async () => {
	const seen = {};
	let timer = null;
	onConfigApplied(() => {
		seen.listener = requestContext.getStore();
		clearTimeout(timer);
		timer = setTimeout(() => {
			seen.timer = requestContext.getStore();
		}, 1);
	});

	requestContext.run(REQUEST, () => {
		assert.equal(requestContext.getStore(), REQUEST);
		applyOptions({ page: { ttl: 4242 } });
	});
	await sleep(10);

	assert.equal(seen.listener, undefined, 'the listener ran in the request’s context');
	assert.equal(seen.timer, undefined, 'the timer the listener armed inherited the request’s context');
});

test('a throwing listener still throws into the apply’s own guard, which logs it and carries on', () => {
	let ran = false;
	onConfigApplied(() => {
		throw new Error('boom');
	});
	onConfigApplied(() => {
		ran = true;
	});
	requestContext.run(REQUEST, () => applyOptions({ page: { ttl: 4343 } }));
	assert.equal(ran, true);
});

test('a doorbell rung inside a request re-reads and applies outside it', async () => {
	let listener = null;
	const seen = { reads: [], applies: [] };
	globalThis.databases = {
		config: {
			ConfigOverride: {
				subscribe: async (options) => {
					listener = options.listener;
				},
				search: () => {
					seen.reads.push(requestContext.getStore());
					return (async function* () {
						yield { path: 'page.ttl', value: 7000 };
					})();
				},
			},
		},
	};

	await startOverrideWatch(
		(overrides) => {
			seen.applies.push({ store: requestContext.getStore(), overrides });
		},
		{ enabled: true, subscribe: true, syncInterval: 0 }
	);
	assert.equal(typeof listener, 'function', 'the watcher subscribed');

	requestContext.run(REQUEST, () => listener({ id: 'page.ttl' }));
	await sleep(400); // past the doorbell's debounce

	assert.deepEqual(seen.reads, [undefined], 'the re-read ran on the request’s transaction');
	assert.equal(seen.applies.length, 1);
	assert.equal(seen.applies[0].store, undefined, 'the apply ran in the request’s context');
	assert.deepEqual(seen.applies[0].overrides, { 'page.ttl': 7000 });
});
