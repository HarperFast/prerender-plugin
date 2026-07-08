import { config } from '../config.js';
import { CacheKey } from '../util/cacheKey.js';
import { getResidencyByUrl } from '../util/residency.js';
import { currentMinuteMs, getNextRenderTime } from '../util/time.js';
import { setImmediate } from 'node:timers/promises';

const {
	render_schedule: { RenderSchedule },
	page_cache: { PrerenderedPage },
} = databases;

// RenderTarget is keyed by URL (one row per URL) while RenderSchedule and
// PrerenderedPage stay keyed by the full `url|deviceType` cacheKey (rendered HTML
// and render cadence are per-device). Every lifecycle method below therefore fans
// out over the target's `deviceTypes` to maintain the N schedule/page rows a single
// target owns.
export class RenderTarget extends databases.render_service.RenderTarget {
	async put(data, target) {
		const url = this.getId();

		let nextRenderTime = data.nextRenderTime;
		delete data.nextRenderTime;

		// `put` replaces a target's device set wholesale; callers pass the full set they
		// want tracked (sitemap refresh / auto-discovery both use the configured default).
		const deviceTypes =
			Array.isArray(data.deviceTypes) && data.deviceTypes.length ? data.deviceTypes : config.deviceTypes.default;
		data.deviceTypes = deviceTypes;

		if (!data.schedulerNode) {
			data.schedulerNode = getResidencyByUrl(url);
		}

		// Write the target first, then the schedules. RenderTarget and RenderSchedule
		// live in separate databases (the schedule is isolated as the hot queue), so
		// these are independent commits rather than one atomic write. Ordering
		// target-first keeps the invariant "a schedule always references an existing
		// target" (which `claim` relies on); the reverse gap — a target with no
		// schedule — is benign and self-heals on the next sitemap refresh / revalidate.
		const result = await super.put({ url, ...data }, target);

		const scheduleTime = typeof nextRenderTime === 'number' ? nextRenderTime : getNextRenderTime();
		const fromSitemap = !!data.sitemapUrl;

		await Promise.all(
			deviceTypes.map((deviceType) =>
				RenderSchedule.put(CacheKey.toCacheKey({ url, deviceType }), {
					nextRenderTime: scheduleTime,
					fromSitemap,
				})
			)
		);

		return result;
	}

	async delete() {
		const url = this.getId();

		// Drop every per-device schedule and cached page this URL owns. Read the row's
		// own device set so we clean up exactly what was written (falling back to the
		// configured default if the row is missing/partial).
		const existing = await RenderTarget.get({ id: url, select: ['deviceTypes'] });
		const deviceTypes = existing?.deviceTypes?.length ? existing.deviceTypes : config.deviceTypes.default;

		await Promise.all(
			deviceTypes.flatMap((deviceType) => {
				const cacheKey = CacheKey.toCacheKey({ url, deviceType });
				return [RenderSchedule.delete(cacheKey), PrerenderedPage.delete(cacheKey)];
			})
		);

		return super.delete(...arguments);
	}

	static async getRenderInterval(url) {
		const renderInterval = await RenderTarget.get({ id: url, select: 'renderInterval' });
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
			const deviceTypes = target.deviceTypes?.length ? target.deviceTypes : config.deviceTypes.default;

			for (const deviceType of deviceTypes) {
				count++;
				const cacheKey = CacheKey.toCacheKey({ url: target.url, deviceType });
				const existingPage = await PrerenderedPage.get({ id: cacheKey, select: ['cacheKey', 'expiresAt'] });

				if (existingPage) {
					batch.push(PrerenderedPage.patch(cacheKey, { expiresAt: Date.now() }));
				}

				batch.push(RenderSchedule.put(cacheKey, { nextRenderTime }));

				if (batch.length >= 100) {
					await Promise.all(batch);
					batch = [];
					await setImmediate();
				}
			}
		}

		await Promise.all(batch);

		return { revalidating: count };
	}
}
