import puppeteer, { Browser, LaunchOptions, Page } from 'puppeteer';
import logger from './util/Logger.js';
import { setTimeout } from 'timers';
import { settings } from './settings.js';
import { noop } from './util/noop.js';

type ManagedBrowserOptions = {
	maxActivePages?: number;
};
type ManagedBrowserConfig = ManagedBrowserOptions & {
	puppeteerLaunchOptions?: LaunchOptions;
};

/**
 * All of these mean the browser context is ALREADY gone (its browser is closing, its target died,
 * or the connection is down) — so a failed dispose leaked nothing and isn't worth an error. The
 * case that IS worth one: a live browser refusing to dispose a context that still exists, since
 * that context then survives until the browser exits.
 */
export const contextAlreadyGone = (err: unknown): boolean => {
	const message = err instanceof Error ? err.message : String(err);
	return (
		message.includes('Failed to find context') ||
		message.includes('Target closed') ||
		message.includes('Session closed') ||
		message.includes('Connection closed')
	);
};

export default class ManagedBrowser {
	maxActivePages: number;

	browser: Browser;

	/**
	 * Set once teardown starts (close/kill), so page-close handlers can tell "the browser is going
	 * away under me" from a genuine failure. Also stops a caller from re-entering close() while the
	 * first one is still in flight.
	 */
	closing = false;

	/**
	 * Renders currently using this browser — incremented when a job starts on it and decremented
	 * only once that job's page is closed and its result posted, so `jobRefs === 0` really means
	 * "nothing is touching this browser" (what the retirement cleanup keys on).
	 */
	jobRefs: number = 0;

	activePages: number = 0;

	totalOpenedPages: number = 0;

	protected constructor(browser: Browser, options?: ManagedBrowserOptions) {
		this.browser = browser;
		this.maxActivePages = options?.maxActivePages ?? 5;
	}

	static async launch(config?: ManagedBrowserConfig) {
		const browser = await puppeteer.launch(config?.puppeteerLaunchOptions);

		browser.on('targetcreated', async (target) => {
			try {
				const type = target.type();
				if (type === 'background_page' || type === 'webview') {
					const page = await target.page();
					if (page) {
						page.on('error', () => {
							page.close().catch(noop);
						});
					}
				}
			} catch (e) {
				logger.error(e);
			}
		});

		const managed = new ManagedBrowser(browser, { maxActivePages: config?.maxActivePages });

		return managed;
	}

	get freeSlots() {
		return this.maxActivePages - this.activePages;
	}

	/**
	 * PID of the launched Chrome process, or undefined if it never started / already exited.
	 * The renderer processes Chrome spawns are descendants of this PID, so it's the root for
	 * per-worker CPU accounting (the cgroup only sees the whole container, which holds every
	 * worker's browser).
	 */
	get pid(): number | undefined {
		return this.browser.process()?.pid;
	}

	async getPage() {
		this.activePages++;
		this.totalOpenedPages++;

		let page;
		try {
			const context = await (!settings.incognitoPages
				? this.browser.defaultBrowserContext()
				: this.browser.createBrowserContext({ downloadBehavior: { policy: 'deny' } }));
			page = await context.newPage();
			page.once('close', async () => {
				if (settings.incognitoPages) {
					try {
						await context.close();
					} catch (err: any) {
						// A context dies with its browser, so teardown makes this expected: the page
						// 'close' event that got us here can BE the browser closing (worker shutdown, or
						// a retired browser being reaped). Only a live browser failing to dispose a
						// context that still exists is a real leak.
						if (this.closing || !this.browser.connected || contextAlreadyGone(err)) {
							logger.debug({ err }, 'browser context already gone at page close');
						} else {
							logger.error({ err }, 'Failed to close context.');
						}
					}
				}
				this.activePages--;
			});
		} catch (e) {
			this.activePages--;
			throw e;
		}

		return page;
	}

	closePage(page: Page) {
		return page.close().catch(noop);
	}

	async close() {
		this.closing = true;
		try {
			await this.browser.close();
		} catch (err) {
			logger.error({ err }, 'failed to close browser');
		}

		const fallback = setTimeout(() => {
			this.kill().catch((err) => logger.error({ err }, 'failed to kill process'));
		}, 5000);
		// Don't let this fallback timer hold the event loop open on its own — a finished one-shot
		// (renderOnce) process should exit promptly. In the long-lived worker the loop stays alive
		// via other refs, so kill() still fires there.
		fallback.unref();
	}

	/**
	 * SIGKILL Chrome without awaiting anything, for use immediately before `process.exit()`
	 * (see RenderWorker.killBrowsersSync). `close()`/`kill()` are the graceful paths; this one
	 * only guarantees the process isn't left behind.
	 */
	killSync() {
		this.closing = true;
		try {
			this.browser.process()?.kill('SIGKILL');
		} catch {
			// Already exited, or we can't signal it — nothing left to do on the way out.
		}
	}

	async kill() {
		this.closing = true;
		const process = this.browser.process();

		if (!process) {
			return;
		}

		const timeout = setTimeout(() => {
			process?.kill('SIGKILL');
		}, 5000);
		// Same rationale as close(): don't independently keep a finished one-shot process alive.
		timeout.unref();

		try {
			await this.browser.close();
			clearTimeout(timeout);
		} catch (e) {
			// ignore
		}
	}
}
