/**
 * Aggregated reporting for paths we serve but never prerender.
 *
 * Two things an operator needs to know, and neither was visible before:
 *
 *   unclassified — the CDN forwarded a path nobody declared. Either it is over-forwarding
 *                  (wasted proxy latency and origin load) or the route list is incomplete
 *                  (lost SEO coverage). Someone fixes the CDN or adds a route.
 *   passthrough  — a declared path we deliberately don't prerender. This is the coverage
 *                  backlog: "we proxy this much bot traffic live, on purpose." Someone
 *                  decides whether it's worth prerendering.
 *
 * WHY AGGREGATED. The old code logged one warning per unmatched request. At crawler volume
 * that is a flood dominated by whichever path is most popular, it can't be summed, and it
 * tells you nothing about the shape of the problem.
 *
 * WHY BUCKETED BY FIRST PATH SEGMENT. "Unclassified" means the shape is unknown by
 * definition, so a per-URL counter is unbounded — a faceted URL space or one hostile crawler
 * would grow it without limit, on the read path. Bucketing by first segment is bounded by the
 * site's top-level namespace (tens of rows), and it is also exactly the granularity a CDN-
 * config fix needs: you change a rule for `/blog/*`, not for one URL. Past `maxBuckets` the
 * counting continues into a single overflow bucket rather than evicting, so the reported
 * volume is never a lie even when the breakdown is truncated.
 *
 * WHY PER-WORKER, UNLIKE THE OTHER SCHEDULERS. Counters live in whichever worker served the
 * request, so this cannot be pinned to worker 0 the way the reconciler and the status sync
 * are — every worker keeps and flushes its own tally. Each line therefore carries node and
 * worker, and a reader sums across them.
 */

import { config, getLogger, onConfigApplied } from '../config.js';
import { PASSTHROUGH, UNCLASSIFIED } from './routeClass.js';

// class -> bucket -> { count, firstMs, lastMs, samplePath }
const buckets = new Map([
	[UNCLASSIFIED, new Map()],
	[PASSTHROUGH, new Map()],
]);
let overflowed = 0;

/**
 * The reporting bucket for a path: its first path segment, with `/*` appended when the path
 * went deeper. Hand-rolled rather than `split('/')` so a read-path call allocates nothing
 * beyond the returned string.
 */
export const bucketOf = (path) => {
	// The typeof guard is for this module's own exported surface, not for today's callers (both
	// pass a string). Reporting must never be able to throw into the read path it observes.
	if (typeof path !== 'string' || path === '' || path === '/') return '/';
	const next = path.indexOf('/', path[0] === '/' ? 1 : 0);
	return next === -1 ? path : `${path.slice(0, next)}/*`;
};

/**
 * Count one request we served without prerendering. Only `passthrough` and `unclassified`
 * are tracked — a prerender path is not a finding.
 *
 * `source` records where the classification came from ('cdn' for a forwarded request,
 * 'redirect' for a render whose final URL landed outside the prerender routes), so one line
 * distinguishes "the CDN sends us this" from "our own renders walk into this".
 */
export const recordUnroutedPath = (routeClass, path, source) => {
	if (!config.ingress.report.enabled) return;

	const forClass = buckets.get(routeClass);
	if (!forClass) return; // prerender, or an unknown class — nothing to report

	const key = source === 'cdn' ? bucketOf(path) : `${bucketOf(path)} (${source})`;
	const existing = forClass.get(key);

	if (existing) {
		existing.count++;
		existing.lastMs = Date.now();
		return;
	}

	if (forClass.size >= config.ingress.report.maxBuckets) {
		overflowed++;
		return;
	}

	const now = Date.now();
	forClass.set(key, { count: 1, firstMs: now, lastMs: now, samplePath: path });
};

/**
 * Take and clear the current tally: `{ unclassified: [...], passthrough: [...], overflowed }`,
 * each list sorted by count descending. Resetting on read makes each report a rate for the
 * interval rather than an ever-growing total.
 *
 * Separate from the logging below so the management API can surface the same numbers, and so
 * tests can assert on data instead of parsing log lines.
 */
export const drainUnroutedReport = () => {
	const report = { overflowed };

	for (const [routeClass, forClass] of buckets) {
		const rows = new Array(forClass.size);
		let index = 0;
		for (const [bucket, stats] of forClass) rows[index++] = { bucket, ...stats };
		rows.sort((a, b) => b.count - a.count);
		report[routeClass] = rows;
		forClass.clear();
	}

	overflowed = 0;
	return report;
};

/**
 * Read the current tally WITHOUT clearing it, for the management API. Draining belongs to the
 * periodic log flush alone — an admin page reading through `drainUnroutedReport` would steal
 * the counts from the next log line and make the report under-count for everyone else.
 *
 * Same shape as the drained report. Remember the scope: these counters are per-worker and
 * reset on every flush interval, so this is "what this worker has seen since its last flush",
 * not a node-wide or cluster-wide total — the caller labels it as such.
 */
export const peekUnroutedReport = () => {
	const report = { overflowed };

	for (const [routeClass, forClass] of buckets) {
		const rows = new Array(forClass.size);
		let index = 0;
		for (const [bucket, stats] of forClass) rows[index++] = { bucket, ...stats };
		rows.sort((a, b) => b.count - a.count);
		report[routeClass] = rows;
	}

	return report;
};

const formatRow = ({ bucket, count, samplePath }) => `${bucket} ×${count} (e.g. ${samplePath})`;

/** Flush the tally to the log as at most one line per class. Silent when nothing was seen. */
export const logUnroutedReport = () => {
	const { topN } = config.ingress.report;
	const report = drainUnroutedReport();
	const log = getLogger();
	const where = `node=${server.hostname} worker=${server.workerIndex}`;

	for (const routeClass of [UNCLASSIFIED, PASSTHROUGH]) {
		const rows = report[routeClass];
		if (rows.length === 0) continue;

		let total = 0;
		for (const row of rows) total += row.count;
		const shown = rows.slice(0, topN).map(formatRow).join(', ');
		const truncated = rows.length > topN ? `, +${rows.length - topN} more bucket(s)` : '';

		log.warn?.(
			`[prerender] ${routeClass}: ${total} request(s) served without prerendering across ` +
				`${rows.length} path bucket(s) [${where}] — ${shown}${truncated}`
		);
	}

	if (report.overflowed > 0) {
		log.warn?.(
			`[prerender] unrouted-path report dropped ${report.overflowed} request(s) from the breakdown ` +
				`(more than ingress.report.maxBuckets=${config.ingress.report.maxBuckets} distinct buckets) [${where}]`
		);
	}
};

let reporterStarted = false;
let reporterTimer = null;
let reporterArmed = null; // the interval the timer was armed with, or null when disabled

const flushSafely = () => {
	try {
		logUnroutedReport();
	} catch (e) {
		getLogger().error?.(e);
	}
};

// (Re)arm the flush timer to match config: `ingress.report.enabled`/`interval` are live.
// Counters keep accumulating while disabled (bounded by maxBuckets), so re-enabling
// flushes what built up on the next tick.
const syncReporterTimer = () => {
	const desired = config.ingress.report.enabled ? config.ingress.report.interval : null;
	if (desired === reporterArmed) return;

	if (reporterTimer) clearInterval(reporterTimer);
	reporterTimer = null;
	reporterArmed = desired;
	if (desired === null) return;

	reporterTimer = setInterval(flushSafely, desired);
	reporterTimer.unref?.();
};

// Introspection for tests and the management API: what the timer is currently armed with
// (`armedInterval: null` = disabled).
export const unroutedReporterState = () => ({ started: reporterStarted, armedInterval: reporterArmed });

/**
 * Start the periodic flush on EVERY worker of every node — see the per-worker note above.
 * Idempotent, and unref'd so it never holds the process open. The timer follows config
 * changes (enable/disable, interval) without a restart.
 */
export const startUnroutedReporter = () => {
	if (reporterStarted) return;
	reporterStarted = true;

	syncReporterTimer();
	onConfigApplied(syncReporterTimer);
};
