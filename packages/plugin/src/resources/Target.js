import { config } from '../config.js';
import { CacheKey } from '../util/cacheKey.js';
import { resolveRenderInterval } from '../util/routeClass.js';
import { getResidencyByUrl } from '../util/residency.js';
import { currentMinuteMs, getInitialRenderTime } from '../util/time.js';
import { applyInBatches, collectFromScan } from '../util/scan.js';
import { deleteSchedule, writeSchedules } from '../util/renderSchedule.js';

const {
	page_cache: { PrerenderedPage },
} = databases;

// `RenderSchedule` is deliberately not destructured here: every write goes through
// `util/renderSchedule.js`, which lowers the claim floor with the write. A raw put from this file
// would file a row behind the floor and end that URL's rendering silently — see that module's
// comment, and `test/queueFunnel.test.js`, which fails the build on one.

// The raw table class. Suppression writes go through this on purpose: `Target.put` (the
// override below) is a REACTIVATION — it clears suppression fields and fans out fresh
// jittered schedules — which is exactly what writing the suppression row must not do.
const TargetTable = databases.render_service.Target;

/**
 * A target's stored strike count, read defensively: coerce BEFORE the finite check, because
 * Harper numeric columns can surface as BigInt (which `Number.isFinite` rejects outright —
 * the same trap `resolveRenderInterval` guards for renderInterval), and `Number(null)` is 0,
 * so an absent count correctly reads as zero rather than NaN.
 */
export const countedStrikes = (value) => {
	const count = Number(value);
	return Number.isFinite(count) && count > 0 ? count : 0;
};

/**
 * The URL registry — ONE row per URL (see schema.graphql). Device variants are not stored:
 * the devices a URL renders for are `config.deviceTypes.default` at write time, and `put`
 * fans out one RenderSchedule row per device. RenderSchedule and PrerenderedPage stay
 * cacheKey-keyed — the queue and the content are genuinely per-device.
 *
 * WRITES TO A RESIDENCY-PINNED KEY DO NOT BLOCK ON THE OWNING NODE. Reads do. The asymmetry
 * is not obvious and v0.15.0 got it wrong, so it is written down here.
 *
 * `RenderSchedule` is pinned with `setResidencyById`, so most of its keys belong to some other
 * node. It is tempting to assume — as v0.15.0 did — that writing one forwards to the owner and
 * therefore inherits the same unbounded wait that a cross-node READ does, and to wrap it in a
 * deadline. It does not, and the deadline was removed.
 *
 * What Harper actually does (`resources/Table.ts`, the residency block in the store path): it
 * computes the residency list, sees this node is not in it, sets `omitLocalRecord`, drops the
 * local record entirely for a `getResidencyById` table, commits the local transaction, and lets
 * the replication layer ship it. There is no forward, no acknowledgement, and nothing to wait
 * for. Measured against a live Harper with residency pinned to a node that does not exist:
 * 500 writes in 10.7ms, mean 0.021ms, max 0.63ms — i.e. an unreachable owner costs nothing.
 *
 * The read side is the genuinely dangerous one, and `util/reconcile.js` explains it: an unowned
 * point read takes Harper's replication fetch, which has no timeout. That is why reads pass
 * `replicateFrom: false` and writes need no such guard.
 */

/** The device variants a URL renders for — config at call time, never stored per-URL, so a
 *  config change applies to every URL on its next write/sweep instead of never. */
const deviceTypes = () => config.deviceTypes.default;

/** Every cacheKey a URL's row implies (one per configured device). */
export const cacheKeysOf = (url) => deviceTypes().map((deviceType) => CacheKey.toCacheKey({ url, deviceType }));

export class Target extends TargetTable {
	async put(data, target) {
		const url = this.getId();

		let nextRenderTime = data.nextRenderTime;
		delete data.nextRenderTime;

		if (!data.schedulerNode) {
			data.schedulerNode = getResidencyByUrl(url);
		}

		// A put is a (re)activation: it replaces the whole row, so suppression fields not
		// present in `data` are cleared by construction. That is what makes a sitemap attach
		// or a fresh discovery naturally lift a suppression — the site re-claimed the URL.
		//
		// Write the target first, then the schedules. Target and RenderSchedule live in
		// separate databases (the schedule is isolated as the hot queue), so these are
		// independent commits rather than one atomic write. Ordering target-first keeps the
		// invariant "a schedule always references an existing target" (which `claim` relies
		// on). The reverse gap — a target with a missing schedule row — is NOT self-healing:
		// `util/reconcile.js` is what repairs it, per device.
		const result = await super.put({ url, ...data }, target);

		// Absent a valid explicit time, jitter the first render across the interval — keyed
		// off the URL, so bulk-created targets don't all come due at once and a URL's device
		// variants share one slot. The jitter window is the same cadence the reschedule loop
		// will resolve (route > stored > default), so the initial spread matches the recurring
		// one. Target is API-exposed and resolveRenderInterval validates the stored number
		// (rejects negatives / NaN / non-numbers) rather than trusting the payload.
		const interval = resolveRenderInterval(url, data.renderInterval);
		const fromSitemap = !!data.sitemapUrl;
		// One floor lowering for the whole device fan-out. The explicit `nextRenderTime` branch is
		// validated no further than `> 0`, and it is the funnel for redirect adoption, sitemap
		// `revalidate: true`, and any external `PUT /render_targets` — i.e. exactly the "due now"
		// and "due in the past" writes a claim floor would otherwise strand. That is why it must
		// not be a bare table put.
		await writeSchedules(
			cacheKeysOf(url).map((cacheKey) => ({
				cacheKey,
				nextRenderTime:
					Number.isFinite(nextRenderTime) && nextRenderTime > 0
						? nextRenderTime
						: getInitialRenderTime(cacheKey, interval),
				fromSitemap,
			}))
		);

		return result;
	}

	async delete() {
		const url = this.getId();

		// Unguarded for the reason in the module comment: the schedule deletes are
		// residency-routed but do not wait on the owner. A rejection still propagates, which
		// matters here — `claim` builds jobs from the schedule row alone and never checks that
		// the target still exists, so an orphaned schedule row would be claimed and re-rendered
		// until its own result drops it. Deletes are idempotent; a visible failure the caller
		// can retry is the right outcome.
		await Promise.all(
			cacheKeysOf(url).flatMap((cacheKey) => [deleteSchedule(cacheKey), PrerenderedPage.delete(cacheKey)])
		);

		return super.delete(...arguments);
	}

	async post(body, target) {
		switch (body.action) {
			case 'revalidate':
				return Target.revalidate(target);
			default:
				throw new Error('invalid action');
		}
	}

	/**
	 * A render proved this URL non-indexable (`reason` says how). The row is the verdict
	 * memory that used to live in the NonIndexable table: it blocks re-discovery, and its
	 * schedule at `render.suppression.recheckInterval` re-proves (or heals) the verdict on
	 * cadence — the schedule IS the TTL. `maxStrikes` consecutive verdicts delete the target
	 * outright; crawler re-discovery restarts the cycle at bounded cost.
	 *
	 * `statusCode` (when the verdict came from an HTTP error page) picks the knob set:
	 * 404/410 use `render.suppression.gone` — fewer, further-apart rechecks, because "gone"
	 * is the origin's most permanent verdict — and are stored as `http-gone` so the registry
	 * distinguishes "page vanished" from "page errored". Callers must NOT route 401/403 here
	 * (see RenderQueue.processJobResult); auth-shaped errors are a renderer/origin problem,
	 * not a page verdict.
	 *
	 * Creates the row when absent (a render-now one-off or a redirect destination can be
	 * proven non-indexable before anything targeted it). Deletes the cached pages either
	 * way — stale content of a page that said "don't index me" must not keep serving.
	 */
	static async suppress(url, { reason, statusCode } = {}) {
		// Only an http-error verdict classifies by status: a noindex/canonical verdict came
		// from a document that rendered, so its status is not the statement being made.
		const gone = reason === 'http-error' && (statusCode === 404 || statusCode === 410);
		const knobs = gone ? config.render.suppression.gone : config.render.suppression;
		const storedReason = gone ? 'http-gone' : (reason ?? null);

		const existing = await Target.get({
			id: url,
			select: ['strikes', 'renderInterval', 'sitemapUrl', 'schedulerNode'],
		});
		const strikes = countedStrikes(existing?.strikes) + 1;

		const maxStrikes = knobs.maxStrikes;
		if (existing && Number.isFinite(maxStrikes) && maxStrikes > 0 && strikes >= maxStrikes) {
			logger.warn(
				`Prerender target ${url} non-indexable ${strikes} consecutive times (${storedReason ?? 'no reason'}) — deleting it`
			);
			await Target.delete(url); // drops schedules + pages too
			return { deleted: true, strikes };
		}

		await TargetTable.put(url, {
			url,
			sitemapUrl: existing?.sitemapUrl ?? null,
			schedulerNode: existing?.schedulerNode ?? getResidencyByUrl(url),
			renderInterval: existing?.renderInterval ?? null,
			state: 'suppressed',
			suppressedReason: storedReason,
			suppressedAt: Date.now(),
			strikes,
		});

		const recheckAt = currentMinuteMs() + knobs.recheckInterval;
		// Safe by arithmetic (a recheck is always in the future, so it never lowers the claim
		// floor), routed through the funnel anyway so the first "recheck this immediately" path
		// anyone adds here inherits the lowering instead of silently stranding the URL.
		await Promise.all([
			writeSchedules(
				cacheKeysOf(url).map((cacheKey) => ({
					cacheKey,
					nextRenderTime: recheckAt,
					fromSitemap: !!existing?.sitemapUrl,
				}))
			),
			...cacheKeysOf(url).map((cacheKey) => PrerenderedPage.delete(cacheKey)),
		]);
		return { deleted: false, strikes };
	}

	/** A render found a suppressed URL indexable again — put it back in normal rotation.
	 *  The caller reschedules the device that just rendered; the sibling devices' schedules
	 *  already exist (suppress set them) and will re-render at their recheck time. */
	static async reactivate(url) {
		await Target.patch(url, { state: null, suppressedReason: null, suppressedAt: null, strikes: 0 });
	}

	/**
	 * Bring every matching target due now (clears nothing else — a suppressed target
	 * re-checks immediately and its verdict decides).
	 *
	 * Two-phase on purpose: the old version issued its writes from inside the open search
	 * cursor, so on a large match set the long-transaction monitor could fire while writes
	 * were pending and ABORT the transaction (HTTP 422) with part of the batch already
	 * applied. Collecting the keys first and writing after the cursor closes means no write
	 * is ever pending while the cursor is open — see util/scan.js.
	 */
	static async revalidate(requestTarget) {
		// Phase 1 — read only. Just the keys; the page lookup moves to phase 2 so this walk
		// stays as short as possible. `sitemapUrl` rides along because phase 2 needs it and a
		// second point read per URL would double the cost of the whole sweep — see below for what
		// happens when it is missing.
		const {
			items: urls,
			examined,
			truncated,
		} = await collectFromScan({
			scan: () => this.search(requestTarget),
			// A row with no `url` is SKIPPED, which needs saying because `pick` returning an object
			// made it stop being automatic: `collectFromScan` skips on `undefined`/`null`, and
			// `{ url: undefined }` is neither. Such a row would reach phase 2 and build cache keys
			// for the string "undefined" — schedule rows and a floor lowering for a URL that does
			// not exist.
			pick: (target) => (target.url ? { url: target.url, sitemapUrl: target.sitemapUrl ?? null } : undefined),
		});

		// Phase 2 — writes, cursor now closed. Each batch is awaited before the next starts,
		// so pending writes never span a monitor tick; within one URL the device variants are
		// independent rows, so they proceed in parallel.
		await applyInBatches({
			items: urls,
			apply: async ({ url, sitemapUrl }) => {
				// THE CURRENT MINUTE, PER URL — never captured once for the whole sweep. Phase 2 writes
				// up to `scan.collectCap` × devices rows with a `PrerenderedPage.get` per key, which at
				// scale takes tens of minutes. Rows are residency-routed, so ~75% land on nodes whose
				// claim floor this process cannot lower and which hold it at
				// `nowMinute − queue.claimFloor.guard`: every row filed with a minute more than the guard
				// band old lands BELOW the owner's floor and is never claimed again — silently, from a
				// fully funnel-routed in-plugin write, and permanently where `resetInterval: 0`.
				// `Sitemap.js` already computes it per entry for the same reason.
				const nextRenderTime = currentMinuteMs();
				await Promise.all(
					cacheKeysOf(url).map(async (cacheKey) => {
						const existingPage = await PrerenderedPage.get({ id: cacheKey, select: ['cacheKey', 'expiresAt'] });
						if (existingPage) {
							await PrerenderedPage.patch(cacheKey, { expiresAt: Date.now() });
						}
					})
				);
				// `fromSitemap` is now explicit, which FIXES A PRE-EXISTING BUG: `put` replaces the
				// record, so this call omitting the field silently cleared it on every revalidated
				// key. `claim` then reported `isFromSitemap: false`, and the renderer skips serializing
				// a non-indexable page unless it is sitemap-listed — so a revalidate quietly stopped
				// those pages being cached at all.
				//
				// One lowering per URL rather than one for the whole batch: every row here gets the
				// same `currentMinuteMs()`, so after the first the CAS-min is a single atomic load
				// that changes nothing. Hoisting the lowering out of the loop would mean carrying the
				// batch's rows in memory to no measurable end.
				await writeSchedules(
					cacheKeysOf(url).map((cacheKey) => ({ cacheKey, nextRenderTime, fromSitemap: !!sitemapUrl }))
				);
			},
		});

		// `examined` is the true match count even when the collection was capped; `truncated`
		// says the caller is looking at a partial pass rather than silently under-reporting it.
		return { revalidating: urls.length, examined, truncated };
	}
}
