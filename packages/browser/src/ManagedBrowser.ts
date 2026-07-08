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
						logger.error({ err }, 'Failed to close context.');
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

		setTimeout(() => {
			this.kill().catch((err) => logger.error({ err }, 'failed to kill process'));
		}, 5000);
	}

	async kill() {
		const process = this.browser.process();

		if (!process) {
			return;
		}

		const timeout = setTimeout(() => {
			process?.kill('SIGKILL');
		}, 5000);

		try {
			await this.browser.close();
			clearTimeout(timeout);
		} catch (e) {
			// ignore
		}
	}
}
