import { config } from '../config.js';
import { CacheKey } from '../util/cacheKey.js';
import { getResidencyByUrl } from '../util/residency.js';
import { currentMinuteMs, getInitialRenderTime } from '../util/time.js';
import { applyInBatches, collectFromScan } from '../util/scan.js';

const {
	render_schedule: { RenderSchedule },
	page_cache: { PrerenderedPage },
} = databases;

export class RenderTarget extends databases.render_service.RenderTarget {
	async put(data, target) {
		const cacheKey = this.getId();

		let nextRenderTime = data.nextRenderTime;
		delete data.nextRenderTime;

		if (!data.schedulerNode) {
			data.schedulerNode = getResidencyByUrl(CacheKey.extractUrl(cacheKey));
		}

		// Write the target first, then the schedule. RenderTarget and RenderSchedule
		// now live in separate databases (the schedule is isolated as the hot queue),
		// so these are two independent commits rather than one atomic write. Ordering
		// target-first keeps the invariant "a schedule always references an existing
		// target" (which `claim` relies on).
		//
		// The reverse gap — a target with no schedule — is NOT self-healing, despite what
		// this comment used to claim. For a URL in a sitemap the next refresh re-puts it,
		// but a traffic-discovered URL is never revisited: `handlePageScheduling` is gated
		// on the target not existing, and `processJobResult` only reschedules after a
		// render that can no longer be claimed. Such a URL goes dark permanently and
		// silently. `util/reconcile.js` is what actually repairs it.
		const result = await super.put({ ...CacheKey.parse(cacheKey), ...data }, target);

		// Absent a valid explicit time, jitter the first render across the interval (keyed off
		// the URL half of the cacheKey, so a URL's device variants share one slot) so
		// bulk-created targets don't all come due at once. RenderTarget is API-exposed, so
		// validate the numbers (reject negatives / NaN / non-numbers) rather than trust the
		// payload.
		const interval =
			Number.isFinite(data.renderInterval) && data.renderInterval > 0
				? data.renderInterval
				: config.render.defaultInterval;

		await RenderSchedule.put(cacheKey, {
			nextRenderTime:
				Number.isFinite(nextRenderTime) && nextRenderTime > 0
					? nextRenderTime
					: getInitialRenderTime(cacheKey, interval),
			fromSitemap: !!data.sitemapUrl,
		});

		return result;
	}

	async delete() {
		const cacheKey = this.getId();

		await Promise.all([RenderSchedule.delete(cacheKey), PrerenderedPage.delete(cacheKey)]);

		return super.delete(...arguments);
	}

	static async getRenderInterval(cacheKey) {
		const renderInterval = await RenderTarget.get({ id: cacheKey, select: 'renderInterval' });
		return renderInterval ?? config.render.defaultInterval;
	}

	async post(body, target) {
		switch (body.action) {
			case 'revalidate':
				return RenderTarget.revalidate(target);
			default:
				throw new Error('invalid action');
		}
	}

	/**
	 * Bring every matching target due now.
	 *
	 * Two-phase on purpose: the old version issued its writes from inside the open search cursor,
	 * so on a large match set the long-transaction monitor could fire while writes were pending
	 * and ABORT the transaction (HTTP 422) with part of the batch already applied. Collecting the
	 * keys first and writing after the cursor closes means no write is ever pending while the
	 * cursor is open — see util/scan.js.
	 */
	static async revalidate(requestTarget) {
		const nextRenderTime = currentMinuteMs();

		// Phase 1 — read only. Just the keys; the page lookup moves to phase 2 so this walk stays
		// as short as possible.
		const {
			items: cacheKeys,
			examined,
			truncated,
		} = await collectFromScan({
			scan: () => this.search(requestTarget),
			pick: (target) => target.cacheKey,
		});

		// Phase 2 — writes, cursor now closed. Each batch is awaited before the next starts, so
		// pending writes never span a monitor tick.
		await applyInBatches({
			items: cacheKeys,
			apply: async (cacheKey) => {
				const existingPage = await PrerenderedPage.get({ id: cacheKey, select: ['cacheKey', 'expiresAt'] });
				if (existingPage) {
					await PrerenderedPage.patch(cacheKey, { expiresAt: Date.now() });
				}
				await RenderSchedule.put(cacheKey, { nextRenderTime });
			},
		});

		// `examined` is the true match count even when the collection was capped; `truncated` says
		// the caller is looking at a partial pass rather than silently under-reporting it.
		return { revalidating: cacheKeys.length, examined, truncated };
	}
}
