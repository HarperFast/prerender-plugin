import { CacheKey } from '../util/cacheKey.js';
import { getResidencyByUrl } from '../util/residency.js';

// Co-locate each schedule record on the node that owns its URL. Rows are keyed by URL (one per
// URL, every device rendered in one job); a pre-0.66.0 per-device row keys by cacheKey and hashes
// to the SAME owner through its URL half, so ownership never moves as rows convert.
databases.render_schedule.RenderSchedule.setResidencyById((key) => [getResidencyByUrl(CacheKey.urlOf(key))]);
