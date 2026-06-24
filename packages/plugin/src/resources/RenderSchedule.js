import { CacheKey } from '../util/cacheKey.js';
import { getResidencyByUrl } from '../util/residency.js';

// Co-locate each schedule record on the node that owns its URL.
databases.render_schedule.RenderSchedule.setResidencyById((cacheKey) => {
	const url = CacheKey.extractUrl(cacheKey);
	return [getResidencyByUrl(url)];
});
