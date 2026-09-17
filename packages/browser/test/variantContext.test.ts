import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import RenderWorker from '../dist/Worker.js';
import RenderJob from '../dist/RenderJob.js';
import { resolveSettings, settings } from '../dist/settings.js';
import { defaultConfig, mergeConfig } from '../dist/config.js';
import { CLEARED_STORAGE_TYPES, resetForNextVariant } from '../dist/variantContext.js';

// One browser context for a job's device variants (config.variantContext.shared): what is shared is
// Chrome's HTTP cache, and the cookies/storage are wiped between variants so nothing else is. Driven
// with a stub browser — what is under test is the context lifecycle and the fallbacks, not Chrome.

let server: http.Server;
let callbackOrigin = '';

before(async () => {
	resolveSettings({ harper: {} }, { requireHarper: false });
	server = http.createServer((req, res) => {
		req.resume();
		req.on('end', () => {
			res.writeHead(204);
			res.end();
		});
	});
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	callbackOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
	await new Promise<void>((r) => server.close(() => r()));
});

type StubCookie = { name: string; value: string };
type StubContext = {
	id: number;
	closed: boolean;
	jar: StubCookie[];
	cookies: () => Promise<StubCookie[]>;
	deleteCookie: (...cookies: StubCookie[]) => Promise<void>;
};

/**
 * A browser that hands out inert pages and records which context each came from, so a test can say
 * "both variants rendered in the same context" without a real browser.
 */
const stubBrowser = (id = 1) => {
	let nextContext = 0;
	const browser = {
		id,
		jobRefs: 0,
		closing: false,
		contexts: [] as StubContext[],
		/** The context each page was opened in, in order; null = a context of the page's own. */
		pagesIn: [] as Array<number | null>,
		closedPages: 0,
		/** Origins whose storage a variant cleared, in order — the other half of the wipe. */
		cleared: [] as string[],
		createContext: async () => {
			const context: StubContext = {
				id: ++nextContext,
				closed: false,
				// A jar the first variant filled: one pinned name and two that must not cross.
				jar: [
					{ name: 'shopnext-pdp', value: 'test' },
					{ name: 'X-SESSIONID', value: 'abc' },
					{ name: 'visitor', value: 'xyz' },
				],
				cookies: async () => context.jar,
				deleteCookie: async (...cookies: StubCookie[]) => {
					const gone = new Set(cookies.map((c) => c.name));
					context.jar = context.jar.filter((c) => !gone.has(c.name));
				},
			};
			browser.contexts.push(context);
			return context;
		},
		disposeContext: async (context: StubContext) => {
			context.closed = true;
		},
		getPage: async (context?: StubContext | null) => {
			browser.pagesIn.push(context ? context.id : null);
			return {
				isClosed: () => false,
				createCDPSession: async () => ({
					send: async (_method: string, params: { origin: string }) => {
						browser.cleared.push(params.origin);
					},
					detach: async () => {},
				}),
			};
		},
		closePage: async () => {
			browser.closedPages++;
		},
		close: async () => {},
	};
	return browser;
};

const makeWorker = (
	renderer: (page: unknown, job: RenderJob) => Promise<string | undefined>,
	browser = stubBrowser()
) => {
	const worker = new RenderWorker({ renderer: renderer as never, maxConcurrency: 1 });
	worker.browser = browser as never;
	return { worker, browser };
};

const okRenderer = async (_page: unknown, job: RenderJob) => {
	job.httpResponse = { statusCode: 200, headers: {} };
	job.isIndexable = true;
	return `<html>${job.deviceType}</html>`;
};

const urlJob = (deviceTypes = ['desktop', 'mobile']) =>
	new RenderJob({
		id: 'https://site.example.com/product/x',
		url: 'https://site.example.com/product/x',
		expiresAt: Date.now() + 600_000,
		deviceType: deviceTypes[0],
		deviceTypes,
		callbackOrigin,
		isFromSitemap: false,
	});

/** Run `fn` with the config patch applied, then put the resolved config back. */
const withConfig = async (patch: Record<string, unknown>, fn: () => Promise<void>) => {
	const previous = settings.config;
	settings.config = mergeConfig(patch as never);
	try {
		await fn();
	} finally {
		settings.config = previous;
	}
};

const statsOf = (worker: RenderWorker) => (worker as unknown as { stats: Record<string, number> }).stats;

test('by default every variant still renders in a context of its own', async () => {
	const { worker, browser } = makeWorker(okRenderer);
	try {
		await worker.render(urlJob());
	} finally {
		await worker.destroy();
	}
	assert.equal(defaultConfig().variantContext.shared, false, 'the default is unchanged behaviour');
	assert.deepEqual(browser.pagesIn, [null, null], 'no context was passed to getPage');
	assert.equal(browser.contexts.length, 0, 'none was created');
});

test('with sharing on, a job opens ONE context, renders both variants in it, and disposes it', async () => {
	await withConfig(
		{ variantContext: { shared: true }, documentReuse: { cookies: { pin: ['shopnext-pdp'] } } },
		async () => {
			const { worker, browser } = makeWorker(okRenderer);
			try {
				await worker.render(urlJob());
			} finally {
				await worker.destroy();
			}
			assert.equal(browser.contexts.length, 1, 'one context for the whole job');
			assert.deepEqual(browser.pagesIn, [1, 1], 'both variants rendered in it');
			assert.equal(browser.contexts[0].closed, true, 'and it was disposed with the job');
			assert.equal(statsOf(worker).variantContextsShared, 1, 'the second variant counted as shared');
			assert.deepEqual(
				browser.contexts[0].jar.map((c) => c.name),
				['shopnext-pdp'],
				'the wipe kept the pinned cookie and dropped the session and visitor ones'
			);
			assert.deepEqual(browser.cleared, ['https://site.example.com'], "and cleared the navigation origin's storage");
		}
	);
});

test('with no pinned names the shared context hands on NOTHING', async () => {
	await withConfig({ variantContext: { shared: true } }, async () => {
		const { worker, browser } = makeWorker(okRenderer);
		try {
			await worker.render(urlJob());
		} finally {
			await worker.destroy();
		}
		assert.deepEqual(browser.pagesIn, [1, 1]);
		assert.deepEqual(browser.contexts[0].jar, [], 'the default pin list is empty, so every cookie goes');
	});
});

test('the shared context is disposed even when a variant throws out of the loop', async () => {
	await withConfig({ variantContext: { shared: true } }, async () => {
		const browser = stubBrowser();
		// getPage fails for the SECOND variant, which rejects out of renderVariant (it is outside the
		// render-failure handling) and ends the loop.
		const realGetPage = browser.getPage;
		let calls = 0;
		browser.getPage = async (context?: StubContext | null) => {
			if (++calls === 2) throw new Error('no page');
			return realGetPage(context);
		};
		const { worker } = makeWorker(okRenderer, browser);
		try {
			await worker.render(urlJob());
		} finally {
			await worker.destroy();
		}
		assert.equal(browser.contexts.length, 1);
		assert.equal(browser.contexts[0].closed, true, 'no context survives its job');
	});
});

test('a single-device job never opens a shared context', async () => {
	await withConfig({ variantContext: { shared: true } }, async () => {
		const { worker, browser } = makeWorker(okRenderer);
		try {
			await worker.render(urlJob(['desktop']));
		} finally {
			await worker.destroy();
		}
		assert.equal(browser.contexts.length, 0, 'nothing to share with');
		assert.deepEqual(browser.pagesIn, [null]);
	});
});

test('a SAMPLE job never shares a context — its later variants must fetch cold', async () => {
	// sampleEvery 1 makes every job a sample; reuse must be on for a sample to mean anything.
	await withConfig(
		{
			variantContext: { shared: true },
			documentReuse: { enabled: true, sampleEvery: 1 },
		},
		async () => {
			const { worker, browser } = makeWorker(okRenderer);
			try {
				await worker.render(urlJob());
			} finally {
				await worker.destroy();
			}
			assert.equal(browser.contexts.length, 0, 'a sample job renders each variant in isolation');
			assert.deepEqual(browser.pagesIn, [null, null]);
		}
	);
});

test('a variant that lands on a DIFFERENT browser leaves the old context behind and opens its own', async () => {
	await withConfig({ variantContext: { shared: true } }, async () => {
		const first = stubBrowser(1);
		const second = stubBrowser(2);
		const { worker } = makeWorker(okRenderer, first);
		// The browser is replaced between variants, as a retirement does.
		let served = 0;
		(worker as unknown as { getBrowser: () => Promise<unknown> }).getBrowser = async () =>
			++served === 1 ? first : second;
		try {
			await worker.render(urlJob());
		} finally {
			await worker.destroy();
		}
		assert.equal(first.contexts.length, 1);
		assert.equal(first.contexts[0].closed, true, "the first browser's context is disposed, not leaked");
		assert.equal(second.contexts.length, 1, 'the second variant starts a context on its own browser');
		assert.deepEqual(second.pagesIn, [1]);
		assert.equal(statsOf(worker).variantContextsShared, 0, 'nothing was actually shared');
	});
});

test('resetForNextVariant keeps the pinned cookies, drops the rest, and clears origin storage', async () => {
	const deleted: Array<{ name: string }> = [];
	const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
	let detached = false;
	const context = {
		cookies: async () => [
			{ name: 'shopnext-pdp', value: 'test' },
			{ name: 'X-SESSIONID', value: 'abc' },
			{ name: 'visitor', value: 'xyz' },
		],
		deleteCookie: async (...cookies: Array<{ name: string }>) => deleted.push(...cookies),
	};
	const page = {
		createCDPSession: async () => ({
			send: async (method: string, params: Record<string, unknown>) => {
				sent.push({ method, params });
			},
			detach: async () => {
				detached = true;
			},
		}),
	};

	const clean = await resetForNextVariant(context as never, page as never, 'https://site.example.com/product/x?a=1', [
		'shopnext-pdp',
	]);

	assert.equal(clean, true);
	assert.deepEqual(
		deleted.map((c) => c.name),
		['X-SESSIONID', 'visitor'],
		'only the pinned name survives'
	);
	assert.deepEqual(sent, [
		{
			method: 'Storage.clearDataForOrigin',
			params: { origin: 'https://site.example.com', storageTypes: CLEARED_STORAGE_TYPES },
		},
	]);
	assert.ok(detached, 'the CDP session is not left attached');
});

test('resetForNextVariant reports failure rather than handing on a dirty context', async () => {
	const base = {
		cookies: async () => [{ name: 'a', value: '1' }],
		deleteCookie: async () => {},
	};
	const failingStorage = {
		createCDPSession: async () => ({
			send: async () => {
				throw new Error('Storage.clearDataForOrigin not available');
			},
			detach: async () => {},
		}),
	};
	assert.equal(
		await resetForNextVariant(base as never, failingStorage as never, 'https://site.example.com/x', []),
		false,
		'a storage wipe that fails is not a clean context'
	);

	const failingCookies = {
		cookies: async () => {
			throw new Error('Target closed');
		},
		deleteCookie: async () => {},
	};
	assert.equal(
		await resetForNextVariant(failingCookies as never, failingStorage as never, 'https://site.example.com/x', []),
		false,
		'nor is a jar that could not be read'
	);

	assert.equal(
		await resetForNextVariant(base as never, failingStorage as never, 'not a url', []),
		false,
		'nor a job URL with no origin to clear'
	);
});

test('a wipe that fails costs the sharing, not the render', async () => {
	await withConfig({ variantContext: { shared: true } }, async () => {
		const browser = stubBrowser();
		// A context whose jar cannot be read: resetForNextVariant returns false for the second variant.
		const realCreate = browser.createContext;
		browser.createContext = async () => {
			const context = await realCreate();
			context.cookies = async () => {
				throw new Error('Target closed');
			};
			return context;
		};
		const { worker } = makeWorker(okRenderer, browser);
		try {
			await worker.render(urlJob());
		} finally {
			await worker.destroy();
		}
		assert.deepEqual(browser.pagesIn, [1, 1, null], 'the second variant re-opened in a context of its own');
		assert.equal(browser.contexts[0].closed, true, 'the shared context was dropped');
		assert.equal(statsOf(worker).variantContextResetFailures, 1);
		assert.equal(statsOf(worker).variantContextsShared, 0);
		assert.equal(statsOf(worker).completed, 2, 'both variants still rendered');
	});
});
