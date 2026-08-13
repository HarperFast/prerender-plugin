/**
 * Cleanup for targets orphaned by a CACHE-KEY RULE CHANGE.
 *
 * A target's stored `url` IS the url-half of its cache key: `Target.put` derives the schedule
 * rows from it verbatim (`cacheKeysOf(url)`), and `processJobResult` writes the rendered page
 * under the schedule row's own key (`PrerenderedPage.put(result.id, …)`). Nothing in either
 * path re-canonicalizes. So when a `cacheKey.*` option changes what `canonicalizeUrl` returns,
 * every target whose stored url is no longer what that url canonicalizes TO becomes an orphan:
 *
 *   - requests for it now key to the NEW spelling, so nothing ever reads its page;
 *   - its schedule rows are untouched and stay due on the normal cadence, so it keeps taking
 *     claim slots and render capacity forever;
 *   - a sitemap refresh does NOT remove it. The refresh creates the target under the new key
 *     and merely UNLINKS the old one (`sitemapUrl -> null`), which changes nothing about its
 *     schedule;
 *   - and it cannot retire itself: with the rule applied on both sides, the renderer's
 *     canonical comparison folds the job url and the declared canonical alike, so the verdict
 *     is `self` and the suppression path never fires.
 *
 * Measured after enabling `cacheKey.plusIsSpace` on a ~38k-url catalog corpus: ~20,200 urls
 * re-keyed, i.e. ~40,400 schedule rows still rendering every 6h into keys no request can
 * produce — about 9.5% of the fleet's measured throughput ceiling, indefinitely.
 *
 * THE PREDICATE IS THE FIXED-POINT TEST, NOT "unlinked". A target is orphaned iff
 * `canonicalizeUrl(url, queryAllowlistFor(url))` differs from its stored `url` — that is the
 * general statement of "no request can produce this key", and it is what makes this sweep
 * correct after ANY cache-key rule change rather than a one-off for one option. Two predicates
 * that look equivalent and are not:
 *
 *   - `sitemapUrl === null` also matches every legitimately DISCOVERED target, and would
 *     delete live corpus.
 *   - a `%20` (or any other) regex encodes one rule change, silently misses the next one, and
 *     cannot distinguish a re-keyed url from one that merely contains that character in a
 *     position the rule doesn't touch.
 *
 * The allowlist argument is load-bearing: the key was built with the matched route's
 * `queryParams`, so the test has to be run with the same allowlist or a prerender route that
 * drops query params would judge every url carrying one to be an orphan.
 *
 * WHY PER-NODE AND OWNER-SCOPED, like `util/reconcile.js`: this sweep must not delete a target
 * whose render is in flight (see below), and a lease is node-local state — it lives in THIS
 * node's shared lease buffer, so only the owner can answer "is this key currently leased".
 * Each node therefore sweeps exactly the keys rendezvous hashing assigns to it, where its
 * local answer is authoritative. Every node running the same sweep covers the whole keyspace
 * with no coordination and no cross-node reads.
 */

import { setImmediate } from 'node:timers/promises';
import { config } from '../config.js';
import { CacheKey } from './cacheKey.js';
import { canonicalizeUrl } from './url.js';
import { queryAllowlistFor } from './routeClass.js';
import { getResidencyByUrl } from './residency.js';
import { leaseInfo } from './renderSchedule.js';

// Rows scanned between event-loop yields, so a sweep over a large registry stays background
// work rather than monopolizing the thread. Same value, and the same reason, as reconcile.
const YIELD_EVERY = 200;

/**
 * Is this stored url a fixed point of the CURRENT canonicalization?
 *
 * A url that throws here is not an orphan and must not be treated as one: `canonicalizeUrl`
 * parses, so a malformed stored url (they exist — see the junk-discovery class) would throw on
 * every pass. Deleting on a parse failure would turn "I can't tell" into "delete it", which is
 * the wrong direction for a destructive sweep.
 */
export const isOrphanedByKeyRule = (url) => {
	try {
		return canonicalizeUrl(url, queryAllowlistFor(url)) !== url;
	} catch {
		return false;
	}
};

/**
 * ONE pass: find the orphaned targets this node owns, then delete them after the scan closes.
 * All I/O is injected, so the traversal, the ownership filter, the in-flight skip and the cap
 * are testable without a live database.
 *
 * Cursor-free and order-indifferent, for the reason spelled out in `reconcileSchedules`: paging
 * by primary key makes correctness depend on the storage engine returning rows in key order,
 * and a cursor that silently skips rows is the worst failure mode a destructive tool can have.
 *
 * Two phases, so the transaction rule is structural rather than remembered: no delete is issued
 * while the scan's cursor is open. Interleaving would hold the read transaction across the
 * writes and pin the log against reclamation — the same reason `claim` drains before leasing.
 *
 * The cap bounds DELETES, not scanning: the scan always runs to completion, so `orphaned` is
 * the true size of the population even when only `maxDeletes` of it was removed this pass.
 */
export const sweepOrphanedTargets = async ({
	streamTargets,
	isLeased,
	deleteTarget,
	ownerOf,
	hostname,
	deviceTypes,
	maxDeletes,
	dryRun = false,
	onYield = () => {},
} = {}) => {
	const stats = { examined: 0, owned: 0, orphaned: 0, leaseSkipped: 0, deleted: 0, truncated: false, dryRun };
	const toDelete = [];

	// Phase 1 — read only.
	for await (const target of streamTargets()) {
		stats.examined++;
		if (stats.examined % YIELD_EVERY === 0) await onYield();

		// Residency is keyed off the URL exactly as RenderSchedule's own `setResidencyById`
		// computes it, so this agrees with where the schedule rows actually live — and therefore
		// with which node's lease buffer can answer for them.
		if (ownerOf(target.url) !== hostname) continue;
		stats.owned++;

		if (!isOrphanedByKeyRule(target.url)) continue;
		stats.orphaned++;

		// SKIP ANYTHING CURRENTLY IN FLIGHT, so a delete does not land mid-render.
		//
		// CORRECTNESS DOES NOT DEPEND ON THIS. `processJobResult` already reschedules only under
		// `if (renderTarget)`, and its `else` branch DELETES the schedule row precisely because
		// "no target owns this schedule" means nothing sets a recurring cadence. So a result
		// arriving after its target was swept retires its own row instead of resurrecting it —
		// the race resolves correctly on its own.
		//
		// What this check buys is waste, not safety: it avoids spending a render on a target
		// that is about to disappear, and it avoids the one write on that path that is NOT
		// target-guarded — the `PrerenderedPage.put`, which would otherwise leave a page record
		// under a key whose target and schedule we just removed.
		//
		// Checked per DEVICE, and any one lease defers the whole target: the delete is per-url
		// and takes every device key with it, so it is unsafe while ANY of them is out. A
		// deferred target is simply swept on the next pass.
		if (deviceTypes.some((deviceType) => isLeased(CacheKey.toCacheKey({ url: target.url, deviceType })))) {
			stats.leaseSkipped++;
			continue;
		}

		// Past the cap we keep counting but stop collecting, so the population is measured in
		// full while the deletion stays bounded — a rule change can orphan a large slice of the
		// keyspace at once, and deleting millions of rows in one pass would be its own outage.
		if (toDelete.length < maxDeletes) toDelete.push(target.url);
	}

	// Phase 2 — deletes, with the scan's cursor now closed.
	for (const url of toDelete) {
		if (!dryRun) await deleteTarget(url);
		stats.deleted++;
	}

	stats.truncated = stats.orphaned - stats.leaseSkipped > stats.deleted;

	return stats;
};

/** `sweepOrphanedTargets` bound to the live tables. */
export const sweepKeyRuleOrphans = async ({
	maxDeletes = config.render.orphanSweep.maxDeletes,
	dryRun = config.render.orphanSweep.dryRun,
} = {}) => {
	const {
		render_service: { Target },
	} = databases;

	return sweepOrphanedTargets({
		// One unconstrained streamed scan, for the reasons spelled out on `reconcileScheduleGaps`:
		// no `sort` (a sort on the un-indexed primary key is rejected), no conditions (Harper
		// injects the full-scan condition itself), no `limit` (the caller streams and never
		// resumes). `url` is the only column the predicate needs.
		streamTargets: () => Target.search({ select: ['url'] }),
		// Node-local shared-buffer lookup, which is exactly why this sweep is owner-scoped.
		isLeased: (cacheKey) => Boolean(leaseInfo(cacheKey)),
		// `Target.delete` fans out to `deleteSchedule` + `PrerenderedPage.delete` for every device
		// key, so the schedule rows and the unreadable page go with the target in one call. It
		// derives those keys from the target's OWN stored url, so it can only ever remove the
		// orphaned spelling — the live folded key belongs to a different target and is untouched.
		deleteTarget: (url) => Target.delete(url),
		ownerOf: getResidencyByUrl,
		hostname: server.hostname,
		// Config at sweep time, matching Target.put's fan-out, so the lease check covers exactly
		// the device keys that exist.
		deviceTypes: config.deviceTypes.default,
		maxDeletes,
		dryRun,
		onYield: () => setImmediate(),
	});
};

let running = false;
let lastRun = null;

/** Summary of the most recent sweep on this node, for the management API. */
export const getLastOrphanSweep = () => lastRun;

/** Whether a sweep is in flight, so the admin action can say so instead of implying a new one. */
export const isOrphanSweepRunning = () => running;

/**
 * Run one sweep, guarded against overlap. Returns the run summary, or `{ skipped: true }` when
 * one is already in flight.
 */
export const runOrphanSweepOnce = async (options) => {
	if (running) return { skipped: true, reason: 'an orphan sweep is already running', lastRun };
	running = true;

	const startedAt = Date.now();
	try {
		const stats = await sweepKeyRuleOrphans(options);
		lastRun = { ...stats, node: server.hostname, startedAt, finishedAt: Date.now(), error: null };

		// Deleting corpus is never routine, so every pass that removed anything says so at WARN
		// with the numbers an operator would want to reconcile against their own expectation.
		if (stats.deleted || stats.truncated) {
			logger.warn(
				`[prerender] orphan sweep${stats.dryRun ? ' (DRY RUN, nothing deleted)' : ''}: ` +
					`${stats.deleted} of ${stats.orphaned} key-rule orphan(s) across ${stats.owned} owned target(s) ` +
					`(${stats.examined} examined, ${stats.leaseSkipped} deferred as in-flight)` +
					(stats.truncated ? ` — the rest left for the next sweep by the ${maxDeletesOf(options)}-delete cap` : '')
			);
		} else {
			logger.info(
				`[prerender] orphan sweep: no key-rule orphans among ${stats.owned} owned target(s) (${stats.examined} examined)`
			);
		}

		return lastRun;
	} catch (e) {
		lastRun = { node: server.hostname, startedAt, finishedAt: Date.now(), error: e?.message ?? String(e) };
		throw e;
	} finally {
		running = false;
	}
};

const maxDeletesOf = (options) => options?.maxDeletes ?? config.render.orphanSweep.maxDeletes;

/** Test seam: forget the previous run so cases don't leak state into each other. */
export const resetOrphanSweepState = () => {
	running = false;
	lastRun = null;
};
