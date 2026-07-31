import { test } from 'node:test';
import assert from 'node:assert/strict';
import RenderWorker from '../dist/Worker.js';
import { contextAlreadyGone } from '../dist/ManagedBrowser.js';

// A render drops its job ref only after its result POST and page close, and the reaper waits for
// BOTH counters — otherwise a retired browser gets closed out from under open pages, which surfaces
// as "Failed to close context" from their close handlers.

type StubBrowser = {
	activePages: number;
	jobRefs: number;
	closing: boolean;
	closed: boolean;
	close: () => Promise<void>;
};

const stubBrowser = (activePages: number, jobRefs: number): StubBrowser => {
	const browser: StubBrowser = {
		activePages,
		jobRefs,
		closing: false,
		closed: false,
		close: async () => {
			browser.closing = true;
			browser.closed = true;
		},
	};
	return browser;
};

// A worker with no browser of its own: closeRetiredBrowsers only reads the retired map.
const stubWorker = () => new RenderWorker({ renderer: async () => undefined });

const retire = (worker: RenderWorker, browser: StubBrowser, retiredAt: number) => {
	worker.retiredBrowsers.set(browser as never, retiredAt);
};

test('a retired browser with open pages is not closed, even at zero job refs', async () => {
	const worker = stubWorker();
	try {
		// The result-POST window: the render released its ref, its page is still open.
		const browser = stubBrowser(1, 0);
		retire(worker, browser, Date.now());

		worker.closeRetiredBrowsers();
		await Promise.resolve();

		assert.equal(browser.closed, false, 'must not close a browser that still has an open page');
		assert.equal(worker.retiredBrowsers.size, 1);
	} finally {
		await worker.destroy();
	}
});

test('a retired browser with job refs but no open pages is not closed either', async () => {
	const worker = stubWorker();
	try {
		// A claimed job that hasn't opened its page yet.
		const browser = stubBrowser(0, 1);
		retire(worker, browser, Date.now());

		worker.closeRetiredBrowsers();
		await Promise.resolve();

		assert.equal(browser.closed, false);
	} finally {
		await worker.destroy();
	}
});

test('a retired browser is reaped once both counters reach zero', async () => {
	const worker = stubWorker();
	try {
		const browser = stubBrowser(0, 0);
		retire(worker, browser, Date.now());

		worker.closeRetiredBrowsers();
		await Promise.resolve();

		assert.equal(browser.closed, true);
		assert.equal(worker.retiredBrowsers.size, 0, 'reaped browsers leave the retired map');
	} finally {
		await worker.destroy();
	}
});

test('a browser whose counters never drain is force-closed after the retirement deadline', async () => {
	const worker = stubWorker();
	try {
		// Stuck bookkeeping (a page whose 'close' never fired) — a leaked Chrome process is worse
		// than a hard close, so the deadline wins.
		const browser = stubBrowser(2, 1);
		retire(worker, browser, Date.now() - 10 * 60 * 1000);

		worker.closeRetiredBrowsers();
		await Promise.resolve();

		assert.equal(browser.closed, true);
	} finally {
		await worker.destroy();
	}
});

test('a browser already being reaped is not closed again on the next tick', async () => {
	const worker = stubWorker();
	try {
		const browser = stubBrowser(0, 0);
		browser.closing = true;
		retire(worker, browser, Date.now());

		worker.closeRetiredBrowsers();
		await Promise.resolve();

		assert.equal(browser.closed, false, 'an in-flight close must not be re-entered');
	} finally {
		await worker.destroy();
	}
});

test('context-close failures that mean "already gone" are told from real ones', () => {
	// The shapes seen in production, from both teardown paths.
	assert.equal(
		contextAlreadyGone(
			new Error('Protocol error (Target.disposeBrowserContext): Failed to find context with id 9E2964…')
		),
		true
	);
	assert.equal(contextAlreadyGone(new Error('Protocol error (Target.disposeBrowserContext): Target closed')), true);
	assert.equal(contextAlreadyGone(new Error('Connection closed.')), true);
	assert.equal(contextAlreadyGone(new Error('Session closed. Most likely the page has been closed.')), true);
	// A live browser that won't dispose an existing context is a genuine leak — keep it loud.
	assert.equal(contextAlreadyGone(new Error('Runtime.callFunctionOn timed out')), false);
	assert.equal(contextAlreadyGone(undefined), false);
});
