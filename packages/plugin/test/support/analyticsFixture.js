/**
 * A deterministic `system.hdb_analytics` fixture for the analytics fold: plugin counters and value
 * metrics across several dimension combos, Harper's bot-path request metrics, Harper's own system
 * rows for two nodes, and the rows a scan must ignore (outside the window, unparseable ids, junk
 * columns). Seeded, so the same call always yields the same rows in the same order.
 *
 * `baseMs` places the window: rows fall in [baseMs - rangeMs, baseMs), plus some just outside it.
 */
const mulberry32 = (seed) => () => {
	seed = (seed + 0x6d2b79f5) | 0;
	let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export const FIXTURE_RANGE_MS = 10 * 60_000;

export function analyticsFixture({ baseMs = 1_000_000_000_000, count = 1500, seed = 7 } = {}) {
	const random = mulberry32(seed);
	const pick = (list) => list[Math.floor(random() * list.length)];
	const startMs = baseMs - FIXTURE_RANGE_MS;
	const at = () => startMs + Math.floor(random() * FIXTURE_RANGE_MS);
	const rows = [];

	for (let i = 0; i < count; i++) {
		const kind = random();
		const ts = at();
		if (kind < 0.35) {
			rows.push({
				id: [ts, pick([1, 2])],
				metric: pick(['bot_serve', 'route_serve']),
				path: pick(['cache', '/catalog/']),
				method: pick(['hit', null]),
				type: pick(['Googlebot', 'bingbot']),
				count: 1 + Math.floor(random() * 20),
				total: 1 + Math.floor(random() * 20),
			});
		} else if (kind < 0.65) {
			const counted = random() < 0.9;
			rows.push({
				id: [ts, pick([1, 2])],
				metric: pick(['page_age', 'render', 'origin_fetch']),
				path: pick(['Googlebot', 'desktop']),
				method: pick(['ok', null]),
				type: null,
				count: counted ? 1 + Math.floor(random() * 9) : 0,
				total: 0,
				// A row without stats still counts toward `count` and must not drag the means.
				mean: random() < 0.1 ? null : random() * 5000,
				median: random() < 0.1 ? undefined : random() * 4000,
				p95: random() * 9000,
			});
		} else if (kind < 0.75) {
			rows.push({
				id: [ts, 1],
				metric: pick(['duration', 'success', 'bytes-sent', 'response_200', 'response_404']),
				path: 'p',
				method: 'GET',
				type: null,
				count: 1 + Math.floor(random() * 50),
				total: 1 + Math.floor(random() * 50),
				mean: random() * 300,
				median: random() * 200,
				p95: random() * 900,
			});
		} else if (kind < 0.93) {
			const node = pick([111, 222]);
			const metric = pick(['resource-usage', 'main-thread-utilization', 'utilization', 'storage-volume']);
			const row = { id: [ts, node], metric };
			if (metric === 'resource-usage') {
				row.cpuUtilization = Math.round(random() * 300) / 100;
				if (random() < 0.8) row.majorPageFault = Math.floor(random() * 5);
			} else if (metric === 'main-thread-utilization') {
				row.active = random() * 60_000;
				row.idle = random() * 60_000;
				row.rss = Math.floor(random() * 2 ** 32);
				row.heapUsed = Math.floor(random() * 2 ** 30);
				if (random() < 0.7) row.taskQueueLatency = random() * 5;
			} else if (metric === 'utilization') {
				row.active = random() * 1000;
				row.idle = random() * 1000;
				if (random() < 0.5) row.count = 1 + Math.floor(random() * 16);
			} else {
				row.available = Math.floor(random() * 1e12);
				row.size = random() < 0.05 ? 0 : 1e12;
			}
			rows.push(row);
		} else {
			// Rows the fold must drop: outside the window on either side, an unparseable id.
			const edge = pick(['before', 'after', 'junk']);
			const id =
				edge === 'before' ? [startMs - 1 - Math.floor(random() * 1000), 1] : edge === 'after' ? [baseMs, 1] : ['x', 1];
			rows.push({
				id,
				metric: pick(['bot_serve', 'resource-usage', 'page_age']),
				path: 'cache',
				count: 3,
				cpuUtilization: 1,
				mean: 5,
			});
		}
	}
	return { rows, startMs, endMs: baseMs };
}
