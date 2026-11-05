/**
 * BROAD RENDER FAILURE: is this failure the page's, or everybody's?
 *
 * `render.failureRetry` counts every failed render as a strike against its target, and strikes are what
 * push a failing page's retry out: two retries on the lease, then the page's cadence, then ×2 per strike
 * up to `maxBackoff`. That is right when ONE page is broken. It is wrong when the origin is: during an
 * origin outage every page that comes due fails, each one takes strikes it did nothing to earn, and once the
 * origin is back those pages sit out a full cadence (48h on a product page) or longer before anything
 * re-renders them, long after their stored copies stopped serving at `expiresAt + page.swrTtl`.
 *
 * So the plugin judges each failure against what every render of the same ROUTE on this node is doing.
 * When at least `minResults` results landed in the last `window` and at least `failureShare` of them failed,
 * failures on that route are BROAD: no strike is counted, and the page retries after a flat `retryAfter`
 * (never later than its own cadence). The plugin owns the strikes and sees every result for the rows it
 * owns, from every renderer of every version, so it needs nothing from the fleet to decide this.
 *
 * WHY PER ROUTE. An origin is rarely down everywhere at once: one backend failing takes out one kind of
 * page (category listings, say) while product pages render fine. Judged across the whole node, a failing
 * route that is a small share of renders never reaches the threshold, and its pages take strikes for its
 * backend's outage. Everything that matched no prerender route shares the `other` slot, which in a
 * deployment without routes is the whole node.
 *
 * WHY A TIME CAP (`maxDuration`). Broad mode retries failing pages every `retryAfter` instead of backing
 * them off, so pages that are PERMANENTLY broken come back far more often than healthy ones on their
 * cadence, and can by themselves hold a route's failure share above the threshold: a self-sustaining
 * verdict. After `maxDuration` of continuous broad failure the route is capped: strikes count again, so
 * broken pages back off and drop out of the window, until the failure share falls below the threshold and
 * the route starts clean. An outage longer than the cap is treated as before this existed.
 *
 * THE COUNTS. One shared buffer per node (`getSab`), so every worker's results land in the same window:
 * per route, a ring of one-minute buckets of [minute, results, failed among them], plus [brokeAt, capped]. Adds are
 * atomic. A bucket is recycled by whichever worker first moves its minute stamp forward; a result another
 * worker adds between that stamp and the zeroing beside it is lost. That is a sample or two in a share
 * over dozens, and not worth a lock on the result path.
 */

import { createHash } from 'node:crypto';
import { config, getLogger, onConfigApplied } from '../config.js';
import { getSab, heldSabKeys, releaseSabs } from './coordination.js';
import { classifyUrl, prerenderRoutePaths } from './routeClass.js';

const KEY_PREFIX = 'prerender_broad_failure_v1/';
const MINUTE_MS = 60_000;

/** The route slot for every URL no prerender route claims. */
export const OTHER_ROUTE = 'other';

// The window may be at most an hour (configSchema), so the ring holds one bucket more than that: the
// current minute is still filling while a full window behind it is read.
const BUCKETS = 61;
const BUCKET_CELLS = 3; // [minute, results, failed]
const STATE_CELLS = 2; // [brokeAt minute, capped 0|1]
const SLOT_CELLS = BUCKETS * BUCKET_CELLS + STATE_CELLS;
const MAX_ROUTES = 32;

let layout = null;

const buildLayout = () => {
	const paths = prerenderRoutePaths().slice(0, MAX_ROUTES);
	const names = [...paths, OTHER_ROUTE];
	const fingerprint = createHash('sha256').update(JSON.stringify(names)).digest('hex').slice(0, 16);
	const key = `${KEY_PREFIX}${fingerprint}`;
	const view = new Int32Array(getSab(key, names.length * SLOT_CELLS * Int32Array.BYTES_PER_ELEMENT));
	// A route table that changed starts a fresh window: a share is only as good as its denominator, and
	// folding the old routes' counts into new slots would judge one route by another's renders.
	releaseSabs((held) => held.startsWith(KEY_PREFIX) && held !== key);
	return { names, slots: new Map(paths.map((path, slot) => [path, slot])), view };
};

const currentLayout = () => (layout ??= buildLayout());

onConfigApplied(() => {
	layout = null;
});

/** The route label a URL is judged under: its prerender route's path, else `other`. */
export const routeOfUrl = (url) => {
	const entry = classifyUrl(url).entry;
	return entry && entry.mode === 'prerender' ? entry.path : OTHER_ROUTE;
};

const slotOf = ({ slots, names }, route) => slots.get(route) ?? names.length - 1;
const slotBase = (slot) => slot * SLOT_CELLS;
const stateBase = (slot) => slotBase(slot) + BUCKETS * BUCKET_CELLS;

const minuteOf = (nowMs) => Math.floor(nowMs / MINUTE_MS);

/** Add to the current minute's bucket of `route`: cell 1 counts results, cell 2 the failed ones among them. */
const add = (route, cell, nowMs) => {
	const current = currentLayout();
	const { view } = current;
	const minute = minuteOf(nowMs);
	const bucket = slotBase(slotOf(current, route)) + (minute % BUCKETS) * BUCKET_CELLS;
	const stamp = Atomics.load(view, bucket);
	if (stamp !== minute && Atomics.compareExchange(view, bucket, stamp, minute) === stamp) {
		Atomics.store(view, bucket + 1, 0);
		Atomics.store(view, bucket + 2, 0);
	}
	Atomics.add(view, bucket + cell, 1);
};

/**
 * Count one processed render result for its URL's route, whatever it decided. Called once per result, as it
 * is processed; a failure among them is ALSO counted, by `recordRenderFailure` from the retry lanes.
 */
export const recordRenderResult = (url, nowMs = Date.now()) => {
	if (!config.render.failureRetry.broadFailure.enabled) return;
	try {
		add(routeOfUrl(url), 1, nowMs);
	} catch {
		// Never costs a render result its processing.
	}
};

/** Count a result that went to the retry lanes (it was already counted by `recordRenderResult`). */
export const recordRenderFailure = (url, nowMs = Date.now()) => {
	if (!config.render.failureRetry.broadFailure.enabled) return;
	try {
		add(routeOfUrl(url), 2, nowMs);
	} catch {
		// As above.
	}
};

/** Results and failures in `route`'s window ending at `nowMs`. */
const windowOf = (current, slot, nowMs) => {
	const { view } = current;
	const minute = minuteOf(nowMs);
	const span = Math.max(1, Math.round(config.render.failureRetry.broadFailure.window / MINUTE_MS));
	let results = 0;
	let failed = 0;
	const base = slotBase(slot);
	for (let i = 0; i < BUCKETS; i++) {
		const bucket = base + i * BUCKET_CELLS;
		const stamp = Atomics.load(view, bucket);
		if (stamp > minute - span && stamp <= minute) {
			results += Atomics.load(view, bucket + 1);
			failed += Atomics.load(view, bucket + 2);
		}
	}
	return { results, failed };
};

/**
 * Judge `route` now, moving its state and logging each change: is a failure on it BROAD (no strike)?
 *
 * @returns {{ broad: boolean, capped: boolean, results: number, failed: number, route: string }}
 */
const judge = (current, slot, nowMs) => {
	const { view, names } = current;
	const route = names[slot];
	const { window: windowMs, minResults, failureShare, maxDuration } = config.render.failureRetry.broadFailure;
	const { results, failed } = windowOf(current, slot, nowMs);
	const over = results >= minResults && failed >= failureShare * results;
	const state = stateBase(slot);
	const minute = minuteOf(nowMs);
	const brokeAt = Atomics.load(view, state);
	const summary = `${failed} of ${results} render result(s) on route ${route} failed in the last ${Math.round(windowMs / MINUTE_MS)} min`;

	if (!over) {
		// Whoever clears the mark reports the end; a route that was only capped ends quietly (its cap was logged).
		if (brokeAt !== 0 && Atomics.compareExchange(view, state, brokeAt, 0) === brokeAt) {
			const capped = Atomics.exchange(view, state + 1, 0) === 1;
			if (!capped) {
				getLogger().notify?.(
					`[prerender] broad render failure over on route ${route} (${summary}); failures count strikes again`
				);
			}
		}
		return { broad: false, capped: false, results, failed, route };
	}

	if (brokeAt === 0) {
		if (Atomics.compareExchange(view, state, 0, minute) === 0) {
			getLogger().warn?.(
				`[prerender] broad render failure on route ${route}: ${summary}. Failed renders on it count no strike ` +
					`and retry after render.failureRetry.broadFailure.retryAfter until the share falls below ` +
					`${failureShare} or it has lasted render.failureRetry.broadFailure.maxDuration.`
			);
		}
		return { broad: true, capped: false, results, failed, route };
	}

	if (Atomics.load(view, state + 1) === 1) return { broad: false, capped: true, results, failed, route };
	if ((minute - brokeAt) * MINUTE_MS >= maxDuration) {
		if (Atomics.compareExchange(view, state + 1, 0, 1) === 0) {
			getLogger().warn?.(
				`[prerender] broad render failure on route ${route} has lasted ${minute - brokeAt} min, past ` +
					`render.failureRetry.broadFailure.maxDuration: failures count strikes again (${summary}). Either the ` +
					`origin outage is that long, or pages that are broken for good keep the share up.`
			);
		}
		return { broad: false, capped: true, results, failed, route };
	}
	return { broad: true, capped: false, results, failed, route };
};

/**
 * Is a render failure of `url`, counted just now, broad? True while its route's failure share is over the
 * threshold and has been for less than `maxDuration`. False whenever the feature is off.
 */
export const isBroadFailure = (url, nowMs = Date.now()) => {
	if (!config.render.failureRetry.broadFailure.enabled) return false;
	try {
		const current = currentLayout();
		return judge(current, slotOf(current, routeOfUrl(url)), nowMs).broad;
	} catch {
		// A judgment that cannot be made is not broad: the strike path is the one that existed before.
		return false;
	}
};

/**
 * The health line's `failures` section (util/health.js): render results in the window on this node, which
 * routes are broad now, which are capped, and the counts of every route with a failure in its window. Null
 * while the feature is off. Judging every route here is also what notices a broad spell has ENDED on a route
 * that has stopped failing altogether (nothing else asks then).
 */
export const broadFailureHealth = (nowMs = Date.now()) => {
	if (!config.render.failureRetry.broadFailure.enabled) return null;
	const current = currentLayout();
	const section = { results: 0, failed: 0, broad: [], capped: [], routes: {} };
	current.names.forEach((_, slot) => {
		const verdict = judge(current, slot, nowMs);
		section.results += verdict.results;
		section.failed += verdict.failed;
		if (verdict.broad) section.broad.push(verdict.route);
		if (verdict.capped) section.capped.push(verdict.route);
		if (verdict.failed > 0) section.routes[verdict.route] = { results: verdict.results, failed: verdict.failed };
	});
	return section;
};

/** Tests (and `resetRenderQueueState`): zero every count and state, as a new process would start. */
export const resetBroadFailure = () => {
	layout = null;
	for (const key of heldSabKeys()) if (key.startsWith(KEY_PREFIX)) new Int32Array(getSab(key, 0)).fill(0);
};
