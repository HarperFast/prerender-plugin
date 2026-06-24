import { config } from '../config.js';
import { CacheKey } from '../util/cacheKey.js';
import { getResidencyByUrl } from '../util/residency.js';
import { currentMinuteMs, getNextRenderTime } from '../util/time.js';
import { setImmediate } from 'node:timers/promises';

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
		// target" (which `claim` relies on); the reverse gap — a target with no
		// schedule — is benign and self-heals on the next sitemap refresh / revalidate.
		const result = await super.put({ ...CacheKey.parse(cacheKey), ...data }, target);

		await RenderSchedule.put(cacheKey, {
			nextRenderTime: typeof nextRenderTime === 'number' ? nextRenderTime : getNextRenderTime(),
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

	static async revalidate(requestTarget) {
		const nextRenderTime = currentMinuteMs();
		let batch = [];
		let count = 0;

		for await (const target of this.search(requestTarget)) {
			count++;
			const existingPage = await PrerenderedPage.get({ id: target.cacheKey, select: ['cacheKey', 'expiresAt'] });

			if (existingPage) {
				batch.push(PrerenderedPage.patch(target.cacheKey, { expiresAt: Date.now() }));
			}

			batch.push(RenderSchedule.put(target.cacheKey, { nextRenderTime }));

			if (batch.length >= 100) {
				await Promise.all(batch);
				batch = [];
				await setImmediate();
			}
		}

		await Promise.all(batch);

		return { revalidating: count };
	}
}
