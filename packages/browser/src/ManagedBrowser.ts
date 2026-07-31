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

export default class ManagedBrowser {
	maxActivePages: number;

	browser: Browser;

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
						// A context dies with its browser, so a disconnected browser here means the
						// context is already gone — expected during teardown (the page 'close' event
						// that got us here IS the browser closing). Only a live-browser failure is a
						// real leak worth an error.
						if (this.browser.connected) {
							logger.error({ err }, 'Failed to close context.');
						} else {
							logger.debug({ err }, 'context already gone with its browser');
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
		try {
			this.browser.process()?.kill('SIGKILL');
		} catch {
			// Already exited, or we can't signal it — nothing left to do on the way out.
		}
	}

	async kill() {
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
