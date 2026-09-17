import type { BrowserContext, Page } from 'puppeteer';
import type ManagedBrowser from './ManagedBrowser.js';
import logger from './util/Logger.js';

/**
 * ONE BROWSER CONTEXT FOR A JOB'S DEVICE VARIANTS — and the wipe that makes it safe.
 *
 * A job renders every device of one URL in turn (see Worker.render), and each variant has always
 * had a browser context of its own: its own cookie jar, its own origin storage, and its own copy of
 * Chrome's HTTP cache. The last of those is pure waste. Both variants load the same page seconds
 * apart, so the second one re-fetches every script, stylesheet and API response the first already
 * pulled, from an origin that has not changed in between.
 *
 * Sharing the context fixes that — Chrome serves the second variant from the cache the first
 * filled. Measured on a production storefront, second variant, with the on-disk resource cache
 * already on and warm: SAME-ORIGIN network responses fell from 103 to 22 on a product page and from
 * 99 to 16 on a catalog page, and total network fetches from ~337 to ~139. The on-disk cache is not
 * cannibalised (70 hits before, 66 after): it holds what is safe to share between UNRELATED renders
 * — GET script/stylesheet responses, no cookies either way — while Chrome's per-context cache can
 * hold everything else precisely because it belongs to one job and is thrown away with it.
 *
 * WHAT DOES NOT COME WITH IT. Sharing a context shares the cookie jar and origin storage too, and
 * that is a different proposition entirely: measured on the same page, an unwiped second variant
 * inherited 125 cookies instead of the 6 pinned ones, and the two devices ended up on ONE
 * `X-SESSIONID`, one visitor id and one bot-manager token, where rendering them apart gives each
 * its own. Two devices sharing an identity is the thing `documentReuse.cookies.pin` exists to
 * prevent (see documentReuse.ts): it is how a snapshot stops being the page a cold visitor is
 * served, and nothing downstream would notice.
 *
 * So the context is shared and the state is not. Between variants every cookie is deleted but the
 * pinned names — the same list, and the only list, that decides what crosses a variant boundary —
 * and the navigation origin's storage is cleared. What a variant inherits is then exactly what it
 * inherits without this feature, which is what makes it a cache optimisation rather than a change
 * of rendering semantics. Measured: with the wipe, the second variant inherits the 6 pinned cookies
 * and nothing else, keeps the whole saving (22 same-origin fetches), and its snapshot sits at its
 * own page-churn distance from the control on product, catalog and home pages alike.
 *
 * A WIPE THAT FAILS TAKES THE SHARING WITH IT. If either half cannot be applied the variant does
 * NOT render here — `resetForNextVariant` returns false and the caller gives that variant a context
 * of its own. The saving is worth having only while it costs nothing, so the fallback is always the
 * behaviour that needs no argument.
 *
 * The HTTP cache is deliberately NOT among the cleared types: it is the entire point. `cache_storage`
 * in the list below is the service-worker Cache API, which is page state, not the HTTP cache.
 */

/**
 * Storage cleared for the navigation origin between variants. Service workers and their Cache API
 * are in here because a worker registered by one variant would otherwise be active for the next and
 * could answer its requests from a cache this code does not control — the one way a shared context
 * could still change what a variant renders after the cookies are gone.
 *
 * Only the NAVIGATION origin is cleared. A third-party iframe's own storage survives, which is the
 * known limit of the CDP call; it is also state no same-origin script can read, and blocked
 * resource types mean few such frames load at all.
 */
export const CLEARED_STORAGE_TYPES = 'local_storage,indexeddb,service_workers,cache_storage';

/**
 * The context a job's variants render in, with the browser it belongs to. `served` counts variants
 * that have rendered in it, so a fresh context is used as-is and every later variant is wiped first.
 */
export type VariantSession = {
	browser: ManagedBrowser | null;
	context: BrowserContext | null;
	served: number;
};

export const newVariantSession = (): VariantSession => ({ browser: null, context: null, served: 0 });

/**
 * Give the next variant the previous one's context with none of its state: every cookie gone but
 * the pinned names, and the navigation origin's storage cleared.
 *
 * Returns false when that could not be guaranteed — the caller must then render the variant in a
 * context of its own rather than in one that may still be carrying a sibling's session.
 */
export const resetForNextVariant = async (
	context: BrowserContext,
	page: Page,
	url: string,
	pin: string[]
): Promise<boolean> => {
	let origin: string;
	try {
		origin = new URL(url).origin;
	} catch {
		// A job whose URL will not parse has worse problems than an unshared context, but this must
		// not be the thing that throws out of the render loop.
		return false;
	}
	try {
		const stale = (await context.cookies()).filter((cookie) => !pin.includes(cookie.name));
		if (stale.length) await context.deleteCookie(...stale);
	} catch (err) {
		logger.warn({ err, url }, 'could not clear cookies between variants — rendering in a fresh context instead');
		return false;
	}
	let cdp;
	try {
		cdp = await page.createCDPSession();
	} catch (err) {
		logger.warn({ err, url }, 'could not open a CDP session to clear storage between variants');
		return false;
	}
	try {
		await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes: CLEARED_STORAGE_TYPES });
		return true;
	} catch (err) {
		logger.warn(
			{ err, url, origin },
			'could not clear storage between variants — rendering in a fresh context instead'
		);
		return false;
	} finally {
		try {
			await cdp.detach();
		} catch {
			// The session dies with its page, and the page is closed right after this either way — a
			// detach that fails has nothing left to leak. Swallowed here so it cannot mask the verdict
			// this function returns, which is what decides whether the variant renders in this context.
		}
	}
};

/**
 * Dispose the shared context, if there is one, and reset the session so the next variant opens a
 * fresh one. Safe to call on every exit path, including one where the browser has already gone.
 */
export const closeVariantSession = async (session: VariantSession): Promise<void> => {
	const { browser, context } = session;
	session.browser = null;
	session.context = null;
	session.served = 0;
	if (browser && context) await browser.disposeContext(context);
};
