import { test } from 'node:test';
import assert from 'node:assert/strict';
import ManagedBrowser from '../dist/ManagedBrowser.js';
import { resolveSettings, workerLaunchOptions, defaultLaunchOptions } from '../dist/settings.js';
import { markRenderPhase, renderPhaseOf } from '../dist/util/renderPhase.js';

// Puppeteer installs its OWN SIGTERM/SIGINT/SIGHUP listeners that close Chrome the instant the
// signal lands, which races the worker's graceful drain: in-flight renders die mid-evaluate
// ("Attempted to use detached Frame" / "Target closed") and their results are lost. The worker
// owns Chrome's lifecycle, so it launches with those handlers off — that's what these cover.

test('workerLaunchOptions disables puppeteer signal handlers when the worker owns signals', () => {
	resolveSettings({}, { requireHarper: false });
	const owned = workerLaunchOptions(true);
	assert.equal(owned.handleSIGTERM, false);
	assert.equal(owned.handleSIGINT, false);
	assert.equal(owned.handleSIGHUP, false);
	// ...while keeping everything else the launch defaults provide
	assert.equal(owned.headless, defaultLaunchOptions().headless);
	assert.equal(owned.protocolTimeout, defaultLaunchOptions().protocolTimeout);
});

test('workerLaunchOptions leaves puppeteer signal handlers alone when the app owns signals', () => {
	resolveSettings({}, { requireHarper: false });
	const notOwned = workerLaunchOptions(false);
	assert.equal(notOwned.handleSIGTERM, undefined);
	assert.equal(notOwned.handleSIGINT, undefined);
	assert.equal(notOwned.handleSIGHUP, undefined);
});

test('a consumer cannot reinstate the signal-handler race through browserLaunchOptions', () => {
	resolveSettings(
		{ browserLaunchOptions: { headless: 'shell', handleSIGTERM: true, handleSIGINT: true } },
		{ requireHarper: false }
	);
	const owned = workerLaunchOptions(true);
	assert.equal(owned.handleSIGTERM, false);
	assert.equal(owned.handleSIGINT, false);
	// the consumer's other options still win
	assert.equal(owned.headless, 'shell');
	resolveSettings({}, { requireHarper: false });
});

test('render phase tags survive on the error and default to undefined', () => {
	const err = markRenderPhase(new Error('Navigation timeout of 20000 ms exceeded'), 'navigation');
	assert.equal(renderPhaseOf(err), 'navigation');
	assert.equal(renderPhaseOf(new Error('boom')), undefined);
	assert.equal(renderPhaseOf(undefined), undefined);
	assert.equal(renderPhaseOf('not an error'), undefined);
});

// The behavioral half: prove the launch options actually keep Chrome alive across a SIGTERM, so an
// in-flight render can finish (what RenderWorker.shutdown's drain depends on). Uses a real browser
// like renderOnce.test.ts does.
test('an in-flight page evaluate survives SIGTERM under the worker launch options', async () => {
	resolveSettings({}, { requireHarper: false });
	// Keep the default "terminate the process" action away from the test runner while we self-signal.
	const keepAlive = () => {};
	process.on('SIGTERM', keepAlive);

	const managed = await ManagedBrowser.launch({ puppeteerLaunchOptions: workerLaunchOptions(true) });
	try {
		const page = await managed.getPage();
		await page.goto('about:blank');

		// Stand-in for a render in flight when the signal lands.
		const inflight = page.evaluate(
			() => new Promise<number>((resolve) => setTimeout(() => resolve(document.querySelectorAll('*').length), 1000))
		);
		process.kill(process.pid, 'SIGTERM');

		assert.ok((await inflight) > 0, 'in-flight evaluate should complete after SIGTERM');
		assert.equal(managed.browser.connected, true, 'browser should still be connected after SIGTERM');
		await managed.closePage(page);
	} finally {
		process.off('SIGTERM', keepAlive);
		await managed.close();
	}
});
