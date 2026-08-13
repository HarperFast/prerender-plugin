/**
 * Management API, exported at `/prerender_admin`.
 *
 * API-ONLY SINCE v0.47.0: the console UI lives in `@harperfast/prerender-console`
 * (packages/console), a separate Harper component that serves the same UI these routes
 * used to ship and proxies to them — deployable on this cluster, another cluster, or a
 * laptop. The route contract below is exactly what that console consumes, and its test
 * suite pins itself against this file's dispatch, so the two cannot drift silently.
 *
 * Authentication is Harper's own: `POST /prerender_admin/login` calls `context.login()`,
 * which authenticates against Harper users and sets the `hdb-session` cookie, and every
 * data/action route then requires `role.permission.super_user`. `login`/`session`/`logout`
 * stay here — the console forwards the operator's sign-in to THIS endpoint per node and
 * re-homes each node's session cookie, so this resource remains the sole authenticator.
 *
 * That super-user check is written out explicitly on every route rather than left to
 * Harper's `allowRead`/`allowCreate` hooks, because this resource — like the others in this
 * plugin — sets `loadAsInstance = false`, and Harper only runs the allow* checks when
 * `loadAsInstance !== false` (see `resources/Resource.ts`). Inheriting the default gate
 * here would look secure and enforce nothing.
 *
 * Routes (all responses are JSON and `no-store`, except page-content's text/plain):
 *   GET  /prerender_admin[/]         API index (name + route list)  public (contains no data)
 *   GET  /prerender_admin/session    who am I                       public
 *   POST /prerender_admin/login      { username, password }         public
 *   POST /prerender_admin/logout     end the session                session required
 *   GET  /prerender_admin/overview   nodes, counts, backlog shape   super_user
 *   GET  /prerender_admin/config     effective config + warnings    super_user
 *   GET  /prerender_admin/sitemaps   root sitemaps + refresh state  super_user
 *   GET  /prerender_admin/pages      ?prefix&cursor&limit           super_user
 *   GET  /prerender_admin/page-content ?cacheKey (text/plain)       super_user
 *   GET  /prerender_admin/unrouted   this worker's unrouted tally   super_user
 *   GET  /prerender_admin/analytics  ?range (ms) — bucketed series  super_user
 *   GET  /prerender_admin/crawl-breadth ?days (default 7, max 31)   super_user
 *   POST /prerender_admin/explain    { url, deviceType }            super_user
 *   POST /prerender_admin/schedule   { cacheKey } -> local row      super_user
 *   POST /prerender_admin/queue      { scope, paused } |            super_user
 *                                    { action: 'reset-claim-floor' }
 *   POST /prerender_admin/revalidate { url, deviceType }            super_user
 *   POST /prerender_admin/reconcile  start a repair sweep           super_user
 *   POST /prerender_admin/sweep-orphans { dryRun?, maxDeletes? }    super_user
 *   POST /prerender_admin/backlog    recompute the backlog snapshot super_user
 *   POST /prerender_admin/sitemap    { url, offset, limit } detail  super_user
 *   POST /prerender_admin/sitemap-refresh { url? }                  super_user
 *
 * QUERY-COST RULES for every route here (this console shares the server with bot traffic):
 *   - Nothing walks `RenderSchedule.nextRenderTime` on page load — `claim` reads that index
 *     from every worker every few seconds. The backlog histogram is a cached snapshot
 *     (util/backlogSnapshot.js); recomputing it is an explicit POST. The claim-floor and
 *     lease numbers are the exception, and only because they are atomic loads on a
 *     node-local shared buffer: no database work at all.
 *   - `PrerenderedPage.content` is never selected in a list; a row can be megabytes. The one
 *     route that returns it (`page-content`) streams a single row as text/plain.
 *   - `Sitemap.entries` is never selected in a list query; one row can hold tens of
 *     thousands of entries. The detail route reads ONE row and slices server-side.
 *   - Reads that can cross nodes pass `replicateFrom: false` and go through readWithTimeout,
 *     reporting `degraded`/null instead of hanging (an unowned point read on a
 *     residency-pinned table takes Harper's replication fetch, which has no timeout).
 *   - Capped scans report scanned/cap/truncated; a short count is never presented as a total.
 *
 * `schedule` exists for cross-node explains: RenderSchedule rows are residency-pinned, and a
 * point read for a row owned by another node would take Harper's replication fetch, which has
 * no timeout. So `explain` reads locally and, when it isn't the owner, asks the owner through
 * this route instead — a bounded HTTPS call forwarding only the caller's own credentials. The
 * route is a leaf: it never proxies onward, so no residency disagreement can cause a loop.
 */

import { setTimeout as sleep, setImmediate as yieldNow } from 'node:timers/promises';
import { config, collectConfigWarnings, pendingRestartChanges } from '../config.js';
import { describeConfigSchema } from '../configSchema.js';
import { describeMetrics } from '../metrics.js';
import { redactConfig } from '../util/redact.js';
import { explainCacheKey } from '../util/explain.js';
import { CacheKey } from '../util/cacheKey.js';
import { resolveServeStatus } from '../util/pageFreshness.js';
import {
	listInvalidations,
	epochFromActiveSet,
	isScopeResolvable,
	checkScopeResolvability,
	recordInvalidation,
	clearInvalidation,
	scopeCoverage,
	HARD,
	MAX_REASON_LENGTH,
	CLUSTER_SCOPE as CLUSTER_INVALIDATION,
} from '../util/invalidation.js';
import { routeScopes, routeScopeForUrl } from '../util/routeClass.js';
import { CLUSTER_SCOPE } from '../util/queueControl.js';
import { getResidencyByUrl } from '../util/residency.js';
import { fetchScheduleFromPeer } from '../util/peer.js';
import { getLastReconcile, isReconcileRunning, runReconcileOnce } from '../util/reconcile.js';
import { getLastOrphanSweep, isOrphanSweepRunning, runOrphanSweepOnce } from '../util/orphanSweep.js';
import { getBacklogSnapshotState, runBacklogSnapshotOnce } from '../util/backlogSnapshot.js';
import { peekUnroutedReport } from '../util/unrouted.js';
import { floorState, leaseInfo, minuteOf, writeSchedule } from '../util/renderSchedule.js';
import { mergeBreadthRow, finalizeBreadth } from '../util/crawlStats.js';
import { clampRange, readAnalyticsWindow } from '../util/analyticsRead.js';
import { decode } from '../util/contentEncoding.js';
import { RenderQueue } from './RenderQueue.js';
import { QueueState } from './QueueState.js';
import { startSitemapRefreshInBackground } from './Sitemap.js';
import { currentMinuteMs, numberOf } from '../util/time.js';

const {
	render_schedule: { RenderSchedule },
	render_service: { Target, QueueStatus, QueueControl },
	page_cache: { PrerenderedPage },
	sitemaps: { Sitemap, SitemapRefresh },
} = databases;

// How long after a node's last status report we call its row stale. Two sync intervals,
// so a single missed tick doesn't flap the UI.
//
// This depends on the periodic sync REWRITING the row every interval even when nothing
// changed (QueueState.reportStatus's `heartbeat`). If that ever reverts to writing only on a
// status change, this check silently inverts: every healthy node goes stale within two
// intervals and stays there, and the node that actually stopped reporting is the one thing it
// can no longer distinguish.
const nodeStaleAfter = () => config.queue.statusSyncInterval * 2;

// Delay applied to a rejected login. Not real rate limiting (there is no cross-worker
// state here) — just enough to make a serial password walk unproductive. Harper's own
// auth audit log is the actual detection surface.
const FAILED_LOGIN_DELAY_MS = 300;

// Ceiling on any single row read behind the URL explainer. A status view must never hang on
// a slow or unreachable peer; a missing field with `degraded` set is a far better answer than
// a request that never returns.
const READ_TIMEOUT_MS = 3000;

/**
 * Run a read with a deadline. On timeout the field comes back null and `label` is recorded in
 * `timedOut`, so the response can say which parts are unreliable rather than silently
 * presenting an absent row as a confirmed absence.
 */
async function readWithTimeout(label, timedOut, read) {
	let timer;
	try {
		return await Promise.race([
			read(),
			new Promise((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} read timed out`)), READ_TIMEOUT_MS);
				timer.unref?.();
			}),
		]);
	} catch (e) {
		logger.warn?.(`[prerender] admin explain: ${label} read failed or timed out: ${e.message}`);
		timedOut.push(label);
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * This node's claim-floor state, for the two routes that answer about a key THIS node owns.
 *
 * Never render a row's `belowClaimFloor` against the floor of a node that does not own the row:
 * the floor is node-local state about this node's slice of a residency-pinned table, so the
 * querying node's copy is meaningless for somebody else's key. `explain` hedges with the existing
 * `scheduleAuthoritative` machinery exactly as it already does for the row itself, and consumes
 * the owner's copy verbatim when it proxies.
 */
const localClaimFloor = (now) => {
	const state = floorState(now);
	return {
		enabled: state.enabled,
		floorMinute: state.floorMinute,
		rawFloorMinute: state.rawFloorMinute,
		guardMinutes: state.guardMinutes,
		floorMs: state.floorMinute > 0 ? state.floorMinute * 60_000 : null,
	};
};

/**
 * One schedule row as the console shows it, including the two node-local questions only the
 * owner can answer: is this key currently leased to a renderer, and is its due time BELOW the
 * claim floor (i.e. filed where no claim will ever look again).
 */
const describeScheduleRow = (row, now) => {
	// `numberOf`, not `Number`: `Number(null)` is 0, so a row with no due time would be shown as due
	// since 1970 — overdue AND below the claim floor — which is a false accusation against a specific
	// URL in the one view an operator uses to decide whether to repair or delete it. A row with no due
	// time reports `null` for every derived field instead of an answer it does not have.
	const at = numberOf(row.nextRenderTime);
	const due = Number.isFinite(at);
	const floor = localClaimFloor(now);
	const lease = leaseInfo(row.cacheKey);
	return {
		...row,
		nextRenderTime: due ? at : null,
		dueInMs: due ? at - now : null,
		// True for EVERY in-flight render now, since a leased row keeps its past due time until the
		// result lands. On its own it no longer means "the queue is behind on this key" — pair it
		// with `leased` before concluding anything.
		overdue: due && at <= now,
		leased: !!lease,
		leaseExpiresAt: lease?.leaseExpiresAtMs ?? null,
		// The floor comparator is inclusive, so a row AT the floor is claimable.
		belowClaimFloor: due && floor.floorMinute > 0 && minuteOf(at) < floor.floorMinute,
	};
};

const noStore = (extra = {}) => ({ 'cache-control': 'no-store', ...extra });

const json = (data, status = 200) =>
	new Response(JSON.stringify(data), {
		status,
		headers: noStore({ 'content-type': 'application/json; charset=utf-8' }),
	});

// Harper's RequestTarget leaves `id` undefined for `/prerender_admin` but sets it to `null`
// for `/prerender_admin/` (a trailing slash marks a collection). Both mean "the root", so
// normalize to '' rather than treating one of them as an unknown route.
const routeOf = (target) => {
	const id = target?.id;
	return id === null || id === undefined ? '' : String(id);
};

/**
 * One-slot per-worker cache of the last sitemap row read for the detail view.
 *
 * The `entries` array lives inside the sitemap row, so paging through a large sitemap
 * re-reads and re-deserializes the whole thing — potentially tens of thousands of entries —
 * on every "next page" click. One slot keyed by (url, lastRefreshed) turns a browse across N
 * pages into one row read; a refresh bumps `lastRefreshed`, which invalidates it naturally.
 * Deliberately a single slot, not an LRU: the browsing pattern is one sitemap at a time, and
 * a bounded wrong-guess costs exactly one extra read.
 */
let sitemapRowCache = null;

async function readSitemapRow(url) {
	// A cheap point read of the metadata decides cache validity without touching `entries`.
	const head = await Sitemap.get({ id: url, select: ['url', 'lastRefreshed'] });
	if (!head) {
		sitemapRowCache = null;
		return null;
	}
	const stamp = head.lastRefreshed ? new Date(head.lastRefreshed).getTime() : 0;
	if (sitemapRowCache && sitemapRowCache.url === url && sitemapRowCache.stamp === stamp) {
		return sitemapRowCache.row;
	}
	const row = await Sitemap.get(url);
	if (row) sitemapRowCache = { url, stamp, row };
	return row;
}

const isSuperUser = (user) => !!user?.role?.permission?.super_user;

const usernameOf = (user) => user?.username ?? user?.getId?.() ?? null;

// Returns null when authorized, otherwise the response to send. 401 vs 403 is the useful
// distinction for the UI: 401 means "show the login form", 403 means "signed in, wrong role".
/**
 * The scope literals an invalidation may name right now, for a 400 body. Returned rather than
 * described, because "unknown scope" without the valid set is exactly the message that sends an
 * operator to guess — and a guessed scope is a row that looks applied and matches nothing.
 */
const knownInvalidationScopes = () => [CLUSTER_INVALIDATION, ...routeScopes()];

const denyUnlessSuperUser = (user) => {
	if (!user) return json({ error: 'Authentication required', authenticated: false }, 401);
	if (!isSuperUser(user)) {
		return json({ error: 'This account is not a super_user', authenticated: true, superUser: false }, 403);
	}
	return null;
};

// Rows walked between event-loop yields in the capped scans below, matching
// util/reconcile.js: an admin scan on a worker that also serves bot traffic must never
// monopolize the loop between rows.
const YIELD_EVERY = 200;

/**
 * Per-worker ceiling on CONCURRENT expensive console reads (sitemap detail, page-cache
 * browse, page-content). Each is individually bounded, but they share the event loop with
 * bot traffic, and nothing else stops several operators (or one impatient one, or a script
 * with credentials) from stacking them. Beyond the cap the route answers 429 immediately —
 * on a high-traffic server, refusing an operator beats delaying a crawler.
 */
const MAX_CONCURRENT_HEAVY = 2;
let heavyInFlight = 0;

async function withHeavySlot(fn) {
	if (heavyInFlight >= MAX_CONCURRENT_HEAVY) {
		return json(
			{ error: `Too many console queries in flight on this worker (max ${MAX_CONCURRENT_HEAVY}) — retry shortly` },
			429
		);
	}
	heavyInFlight++;
	try {
		return await fn();
	} finally {
		heavyInFlight--;
	}
}

async function buildNodeList(now) {
	const [statuses, controls] = await Promise.all([
		Array.fromAsync(QueueStatus.search({})),
		Array.fromAsync(QueueControl.search({})),
	]);

	const controlByScope = new Map(controls.map((row) => [row.scope, row]));
	const staleAfter = nodeStaleAfter();

	const nodes = statuses.map((row) => {
		const updatedMs = row.updatedTime ? new Date(row.updatedTime).getTime() : NaN;
		const control = controlByScope.get(row.hostname);

		return {
			hostname: row.hostname,
			status: row.status ?? null,
			updatedTime: Number.isFinite(updatedMs) ? updatedMs : null,
			// A node that has stopped reporting is the interesting case: its `status` is
			// whatever it last said, which may be nothing like reality.
			stale: Number.isFinite(updatedMs) ? now - updatedMs > staleAfter : true,
			isThisNode: row.hostname === server.hostname,
			override:
				control && typeof control.paused === 'boolean'
					? { paused: control.paused, updatedBy: control.updatedBy ?? null, updatedTime: control.updatedTime ?? null }
					: null,
		};
	});

	nodes.sort((a, b) => String(a.hostname).localeCompare(String(b.hostname)));

	const clusterRow = controlByScope.get(CLUSTER_SCOPE);

	return {
		nodes,
		cluster:
			clusterRow && typeof clusterRow.paused === 'boolean'
				? {
						paused: clusterRow.paused,
						updatedBy: clusterRow.updatedBy ?? null,
						updatedTime: clusterRow.updatedTime ?? null,
					}
				: null,
		// Scopes a control write is allowed to name, so a typo can't create a row that
		// silently never applies to anything.
		// CLUSTER_SCOPE goes INSIDE the Set: a cluster control row also appears in
		// controlByScope, so prepending it outside listed "all" twice.
		knownScopes: [...new Set([CLUSTER_SCOPE, ...statuses.map((r) => r.hostname), ...controlByScope.keys()])].filter(
			Boolean
		),
	};
}

export class PrerenderAdmin extends Resource {
	static loadAsInstance = false;

	async get(target) {
		if (!config.management.enabled) return json({ error: 'Management API is disabled' }, 404);

		const route = routeOf(target);
		const context = this.getContext();
		const user = context?.user;

		if (route === '') {
			// API-only: no shell, no assets. Answer with what this IS and where the UI went —
			// an operator hitting this URL in a browser is following a pre-v0.47.0 habit, and a
			// bare 404 would read as "the management surface is gone".
			return json({
				name: '@harperfast/prerender management API',
				ui: 'The console UI is the @harperfast/prerender-console component — deploy it pointing at this node.',
				node: server.hostname,
			});
		}

		if (route === 'session') {
			return json({
				authenticated: !!user,
				username: usernameOf(user),
				superUser: isSuperUser(user),
				sessionsEnabled: typeof context?.login === 'function',
				node: server.hostname,
			});
		}

		const denied = denyUnlessSuperUser(user);
		if (denied) return denied;

		switch (route) {
			case 'overview':
				return json(await PrerenderAdmin.overview());
			case 'config':
				// `schema` is the full option catalog (descriptions, types, defaults, live-vs-restart
				// scope, validation hints) — the contract a config editor renders from.
				// `pendingRestart` lists restart-scoped options changed since boot: the new value is
				// in `config` but the running behavior still reflects the boot value.
				return json({
					config: redactConfig(config),
					schema: describeConfigSchema(),
					warnings: collectConfigWarnings(),
					pendingRestart: pendingRestartChanges(),
					node: server.hostname,
					workerIndex: server.workerIndex,
				});
			case 'invalidations':
				return PrerenderAdmin.listInvalidationsRoute();
			case 'sitemaps':
				return json(await PrerenderAdmin.sitemapList());
			case 'pages':
				return PrerenderAdmin.listPages(target);
			case 'page-content':
				return PrerenderAdmin.pageContent(target);
			case 'unrouted':
				// A non-destructive peek: draining here would steal the tally from the periodic
				// log flush. Counters are per-worker in-process state, so the response names
				// which worker's slice this is.
				return json({
					node: server.hostname,
					workerIndex: server.workerIndex,
					perWorker: true,
					interval: config.ingress.report.interval,
					report: peekUnroutedReport(),
				});
			case 'analytics':
				return PrerenderAdmin.analytics(target);
			case 'crawl-breadth':
				return PrerenderAdmin.crawlBreadth(target);
			case 'metrics':
				// The metric CATALOG, not metric values: names, dimension slots, units, and what each
				// number is for (`src/metrics.js`). Values come from Harper's own `get_analytics`
				// operation, per node — see METRICS.md. Served for the same reason `config` serves its
				// schema: a dashboard (or an agent writing one) should read the contract off the running
				// version rather than guess which release a doc describes. Static, so it costs nothing
				// and cannot be a load surface.
				return json({ metrics: describeMetrics(), node: server.hostname });
			default:
				return json({ error: `Unknown route: ${route}` }, 404);
		}
	}

	async post(target, data) {
		if (!config.management.enabled) return json({ error: 'Management API is disabled' }, 404);

		const route = routeOf(target);
		const context = this.getContext();

		// Login and logout act on the session, so they precede the super-user gate.
		if (route === 'login') return PrerenderAdmin.login(context, data);
		if (route === 'logout') return PrerenderAdmin.logout(context);

		const denied = denyUnlessSuperUser(context?.user);
		if (denied) return denied;

		switch (route) {
			case 'explain':
				return PrerenderAdmin.explain(data, context);
			case 'schedule':
				return PrerenderAdmin.scheduleRow(data);
			case 'queue':
				return PrerenderAdmin.setQueuePause(data, context);
			case 'invalidate':
				return PrerenderAdmin.invalidate(data, context);
			case 'revalidate':
				return PrerenderAdmin.revalidateUrl(data);
			case 'reconcile':
				return PrerenderAdmin.reconcile();
			case 'sweep-orphans':
				return PrerenderAdmin.sweepOrphans(data);
			case 'backlog':
				return PrerenderAdmin.backlog();
			case 'sitemap':
				return PrerenderAdmin.sitemapDetail(data);
			case 'sitemap-refresh':
				return PrerenderAdmin.sitemapRefresh(data);
			default:
				return json({ error: `Unknown route: ${route}` }, 404);
		}
	}

	/**
	 * Record, preview, or clear a bulk invalidation.
	 *
	 *   { scope, reason }                 record
	 *   { scope, reason, dryRun: true }   preview — writes nothing, returns the same body
	 *   { scope, mode: null }             clear (delete the row)
	 *
	 * HOME IS HERE, not `RenderQueue.post`, and not a bare `@export` on the table. This resource is
	 * the only one in the plugin that actually authenticates (`loadAsInstance = false` plus the
	 * hand-written super-user gate above). One request here takes the whole corpus off the serve path;
	 * an unauthenticated version of that is strictly worse than an unauthenticated fleet pause, which
	 * `RenderQueue` already keeps node-scoped for the same reason.
	 *
	 * THE RESPONSE IS THE PRIMARY CORRECTNESS SURFACE. Everything an operator needs to know that the
	 * invalidation did what they meant is computed server-side and returned: what the scope covers,
	 * which other active scopes also apply (so the `max(at)` precedence is visible rather than
	 * inferred), and the two things the plugin cannot do. `dryRun` returns exactly the same body
	 * without the write, so "what would this do" and "what did this do" cannot drift apart.
	 */
	static async invalidate(data, context) {
		const rawScope = String(data?.scope ?? '').trim();
		const clearing = data?.mode === null;
		const dryRun = data?.dryRun === true;

		if (!rawScope) {
			return json({ error: 'scope is required', knownScopes: knownInvalidationScopes() }, 400);
		}

		// Clearing runs BEFORE the closed-set check, deliberately. The row that most needs clearing is
		// one whose scope has STOPPED resolving — a route renamed or removed by a live config edit, the
		// exact state checkScopeResolvability warns about on every boot and config apply. Validating
		// first made that row undeletable through the only authenticated door, so the documented
		// remediation ("either re-enable it or clear the rows") answered 400. Clearing an unknown scope
		// is always safe — the 404 below still refuses scopes that were never recorded, and the
		// closed-set check protects the RECORD path, which stays behind it.
		if (clearing) {
			const before = (await listInvalidations()).rows.find((row) => row.scope === rawScope) ?? null;
			if (!before) {
				return json({ error: `Nothing is invalidated for scope "${rawScope}".`, scope: rawScope }, 404);
			}
			// Computed from what we just did, NEVER by re-reading: a row deleted earlier in a request is
			// still visible to a read in that request (util/queueControl.js:57-63 documents the trap), so
			// re-reading would make the one operation whose entire value is confirmation report the exact
			// opposite of what happened.
			const cleared = await clearInvalidation(rawScope);
			logger.warn(
				`[prerender] invalidation CLEARED for scope "${rawScope}" by ${context?.user?.username ?? 'unknown'} ` +
					`(was invalidated at ${before.invalidatedAt}).`
			);
			return json({
				...cleared,
				wasInvalidatedAt: before.invalidatedAt ?? null,
				effect:
					'Effective on THIS node on the next request — resolution is per request, so no worker has to be ' +
					'told. Other nodes serve from their own replica of the invalidation table and pick the clear up ' +
					'on their next request after the delete replicates (normally sub-second; unbounded if ' +
					'replication is degraded — verify on a peer before declaring the incident over).',
				warning:
					'UN-INVALIDATION IS PARTIAL BY CONSTRUCTION. Every page still inside its own expiry/stale-while-' +
					'revalidate window serves from cache again immediately. Every page whose own window elapsed while ' +
					'the invalidation was active CANNOT come back — its lifetime expired on its own terms, and nothing ' +
					'here rewrote lastCached. If the invalidation ran longer than page.ttl + page.swrTtl, clearing it ' +
					'restores almost nothing and those pages wait for their next render.',
			});
		}

		// A CLOSED SET, checked here — record path only (clearing, above, is exempt). An unvalidatable
		// scope records a row that reports as applied and matches nothing — the worst failure this
		// feature has, because the operator's mitigation appears to have worked. 400 with the valid
		// literals beats a green no-op.
		if (!isScopeResolvable(rawScope)) {
			return json(
				{
					error:
						`Unknown scope "${rawScope}". A scope is 'all' or one configured prerender route. ` +
						`For a narrower blast radius, declare a narrower route rather than inventing a scope.`,
					knownScopes: knownInvalidationScopes(),
				},
				400
			);
		}

		if (data?.mode !== undefined && data?.mode !== null && data.mode !== HARD) {
			return json({ error: `mode must be "${HARD}" or null (to clear). Got "${data.mode}".`, validModes: [HARD] }, 400);
		}

		// REJECTED, not ignored. An operator who believes they backdated an invalidation and did not has
		// a corpus they think is invalidated and isn't.
		if (data?.invalidatedAt !== undefined) {
			return json(
				{
					error:
						'invalidatedAt is stamped by the server and cannot be supplied — it is the epoch pages compare against.',
				},
				400
			);
		}

		const reason = String(data?.reason ?? '').trim();
		if (!reason) {
			return json({ error: 'reason is required — it is the only record of intent that outlives the incident.' }, 400);
		}
		if (reason.length > MAX_REASON_LENGTH) {
			return json({ error: `reason must be ${MAX_REASON_LENGTH} characters or fewer (got ${reason.length}).` }, 400);
		}

		// 409, not a silent write: recording a row the serve path never reads is the definition of
		// silent, and it is the state a half-finished rollback leaves behind.
		if (!config.invalidation.enabled) {
			return json(
				{
					error:
						'invalidation.enabled is false, so a recorded row would never be consulted. Enable it first, or ' +
						'this would look applied and do nothing.',
				},
				409
			);
		}

		const active = (await listInvalidations()).rows;
		const replacing = active.some((row) => row.scope === rawScope);
		if (!replacing && active.length >= config.invalidation.maxScopes) {
			return json(
				{
					error: `Already at invalidation.maxScopes (${config.invalidation.maxScopes}) active scopes. Clear one first.`,
					active: active.map((row) => row.scope),
				},
				409
			);
		}

		const coverage = scopeCoverage(rawScope);
		// Every OTHER active scope that also applies to this one's pages, so the max(at) precedence is
		// stated rather than inferred. A leftover rehearsal row that is NEWER than this write is the case
		// that matters: it wins, and without this the operator would have no way to know.
		const overlaps = active
			.filter(
				(row) => row.scope !== rawScope && (row.scope === CLUSTER_INVALIDATION || rawScope === CLUSTER_INVALIDATION)
			)
			.map((row) => ({ scope: row.scope, invalidatedAt: row.invalidatedAt ?? null }));

		const body = {
			scope: rawScope,
			mode: HARD,
			reason,
			dryRun,
			coverage,
			overlaps,
			precedence:
				overlaps.length > 0
					? 'The LATEST invalidatedAt among all applicable scopes wins (max, not most-specific) — a newer ' +
						'overlapping scope listed above will keep pages unservable even after this one is cleared.'
					: 'No other active scope applies to these pages.',
			effect:
				'Any cached page in this scope rendered before the recorded instant stops being served on the NEXT ' +
				'request on THIS node, and on other nodes on their next request after the row replicates ' +
				'(normally sub-second — but each node reads its own replica, so degraded replication delays the ' +
				'other three; verify on a peer when it matters). Bots get the origin until the page re-renders on ' +
				'its normal cadence. Nothing is rewritten, so undo is instant for pages still inside their own ' +
				'expiry/SWR window.',
			limits: [
				'The CDN edge is NOT invalidated and keeps its own TTL. Neither is a copy a crawler already holds.',
				'Origin markup carries correct price, availability, canonical, title and meta description — but not ' +
					'reviews or most images. An invalidated page therefore serves a thinner document than a rendered one.',
				`Healing is by normal render cadence. invalidation.reenqueue is ${
					config.invalidation.reenqueue.enabled ? 'ON' : 'OFF'
				}, so crawled pages ${config.invalidation.reenqueue.enabled ? 'are' : 'are NOT'} pulled forward.`,
			],
			padMs: config.invalidation.pad,
		};

		if (dryRun) return json({ ...body, wrote: false });

		const written = await recordInvalidation({ scope: rawScope, reason, updatedBy: context?.user?.username ?? null });
		logger.warn(
			`[prerender] INVALIDATED scope "${rawScope}" at ${written.invalidatedAt} by ` +
				`${context?.user?.username ?? 'unknown'}: ${reason}`
		);
		return json({ ...body, ...written, dryRun: false, wrote: true, replaced: replacing });
	}

	/** Every active invalidation, plus whether each one still names a configured route. */
	static async listInvalidationsRoute() {
		const { rows, truncated } = await listInvalidations();
		const resolvability = await checkScopeResolvability();
		return json({
			node: server.hostname,
			enabled: config.invalidation.enabled,
			padMs: config.invalidation.pad,
			maxScopes: config.invalidation.maxScopes,
			reenqueueEnabled: config.invalidation.reenqueue.enabled,
			knownScopes: resolvability.knownScopes,
			truncated,
			// The pill in the console derives from RESOLVABILITY, not from row presence: a row whose scope
			// no longer names a route is worse than no row, because it looks applied.
			unresolvable: resolvability.unresolvable,
			killSwitchHidingRows: !config.invalidation.enabled && rows.length > 0,
			invalidations: rows.map((row) => ({
				scope: row.scope,
				invalidatedAt: row.invalidatedAt ?? null,
				mode: row.mode ?? null,
				reason: row.reason ?? null,
				updatedBy: row.updatedBy ?? null,
				updatedTime: row.updatedTime ?? null,
				resolvable: !resolvability.unresolvable.includes(row.scope),
				coverage: scopeCoverage(row.scope),
			})),
		});
	}

	/**
	 * Make ONE url due for render now (one device — this writes exactly one schedule row).
	 *
	 * Deliberately not `Target.revalidate`, which takes a search target: pointed at the
	 * whole collection that revalidates the entire registry, and at 1M+ targets an accidental
	 * full revalidate is a self-inflicted render herd.
	 *
	 * Requires an existing Target. A schedule row without one is a one-off that
	 * `processJobResult` drops after a single render — that is the render-now feature, not
	 * this, and quietly creating one here would look like it joined the rotation when it
	 * hadn't.
	 */
	static async revalidateUrl(data) {
		let explanation;
		try {
			explanation = explainCacheKey(String(data?.url ?? '').trim(), data?.deviceType);
		} catch (e) {
			return json({ error: `Not a valid absolute URL: ${e?.message ?? String(e)}` }, 400);
		}

		const { cacheKey, canonicalUrl } = explanation.resolved;

		const timedOutReads = [];
		const target = await readWithTimeout('renderTarget', timedOutReads, () =>
			Target.get({ id: canonicalUrl, select: ['url', 'sitemapUrl'] })
		);
		if (timedOutReads.length) return json({ error: 'target read timed out' }, 504);

		if (!target) {
			return json(
				{
					error:
						'No Target for this URL, so there is no recurring rotation to rejoin. A schedule row on its own would render once and be dropped.',
					cacheKey,
				},
				409
			);
		}

		const nextRenderTime = currentMinuteMs();
		// The write is residency-routed, so this reaches the owning node from any node — and it
		// goes through the funnel, which lowers this node's claim floor to cover it.
		await writeSchedule(cacheKey, { nextRenderTime, fromSitemap: !!target.sitemapUrl });

		// `claim` reads a node-local flag, so waking consumers only helps on the node that owns
		// the row. When another node owns it, what makes the row claimable there is the CLAIM
		// FLOOR'S GUARD BAND, not a status tick: every node holds its floor at least
		// `queue.claimFloor.guard` behind the current minute, and this row is due at the current
		// minute, so it lands above the owner's floor by construction. The owner then picks it up
		// on its next claim — sooner than its status sync, not because of it.
		const owner = getResidencyByUrl(canonicalUrl);
		if (owner === server.hostname) await QueueState.reportStatus('queued');

		return json({
			cacheKey,
			canonicalUrl,
			nextRenderTime,
			scheduleOwnedBy: owner,
			wokeLocalConsumers: owner === server.hostname,
			node: server.hostname,
		});
	}

	/**
	 * Start a schedule-repair sweep on THIS node.
	 *
	 * Detached on purpose: the sweep walks the whole target registry, which at scale takes far
	 * longer than a request should stay open. The previous run's summary comes back with the
	 * acknowledgement, so the UI can show what the last pass actually did.
	 *
	 * Node-scoped, because a node can only authoritatively check the keys it owns — see
	 * util/reconcile.js. Every node runs the periodic sweep for its own slice.
	 */
	static reconcile() {
		const lastRun = getLastReconcile();
		const payload = {
			node: server.hostname,
			ownerScopeNote: 'Repairs only the keys this node owns; every node sweeps its own slice.',
			lastRun,
		};

		// Checked up front so a double-click reports honestly rather than implying a second
		// pass began. `runReconcileOnce` holds the authoritative guard either way, so the
		// microtask-wide race between these two only affects the wording, never the work.
		if (isReconcileRunning()) {
			return json({ ...payload, started: false, alreadyRunning: true });
		}

		// Detached: the sweep outlives this request, so a rejection has to be handled here or
		// it surfaces as an unhandled rejection.
		runReconcileOnce().catch((e) => logger.error(e));

		return json({ ...payload, started: true, alreadyRunning: false });
	}

	/**
	 * Start a key-rule orphan sweep on THIS node.
	 *
	 * Detached and node-scoped for the same reasons as `reconcile`: it walks the whole target
	 * registry, and it can only answer "is this key in flight" for the keys this node owns, so
	 * every node has to be swept to cover the keyspace.
	 *
	 * `dryRun` defaults to the configured value (itself `true`), so an operator who POSTs this
	 * without arguments gets a census rather than a deletion. Pass `{ dryRun: false }` to act.
	 */
	static sweepOrphans(data) {
		const lastRun = getLastOrphanSweep();
		const dryRun = typeof data?.dryRun === 'boolean' ? data.dryRun : config.render.orphanSweep.dryRun;
		const maxDeletes = Number.isFinite(Number(data?.maxDeletes))
			? Math.max(1, Math.floor(Number(data.maxDeletes)))
			: config.render.orphanSweep.maxDeletes;

		const payload = {
			node: server.hostname,
			dryRun,
			maxDeletes,
			ownerScopeNote: 'Sweeps only the keys this node owns; every node must be swept to cover the keyspace.',
			lastRun,
		};

		if (isOrphanSweepRunning()) {
			return json({ ...payload, started: false, alreadyRunning: true });
		}

		// Detached: the sweep outlives this request, so a rejection has to be handled here or it
		// surfaces as an unhandled rejection.
		runOrphanSweepOnce({ dryRun, maxDeletes }).catch((e) => logger.error(e));

		return json({ ...payload, started: true, alreadyRunning: false });
	}

	/**
	 * This node's local RenderSchedule row for a cache key. Exists so a peer running `explain`
	 * can get an authoritative answer for a row it doesn't own.
	 *
	 * Deliberately a LEAF: it reads node-locally and never proxies onward, so no residency
	 * disagreement between nodes can produce a request loop. It is the same super-user-gated
	 * surface as everything else — the caller's credentials are re-authenticated here, so
	 * proxying grants no authority the original caller lacked.
	 */
	static async scheduleRow(data) {
		const cacheKey = data?.cacheKey;
		if (typeof cacheKey !== 'string' || !cacheKey) {
			return json({ error: 'cacheKey is required' }, 400);
		}

		const timedOutReads = [];
		const row = await readWithTimeout('renderSchedule', timedOutReads, () =>
			RenderSchedule.get(
				{ id: cacheKey, select: ['cacheKey', 'nextRenderTime', 'fromSitemap'] },
				{ replicateFrom: false }
			)
		);

		if (timedOutReads.length) return json({ error: 'local schedule read timed out' }, 504);

		const now = Date.now();
		return json({
			node: server.hostname,
			renderSchedule: row ? describeScheduleRow(row, now) : null,
			// The lease table and the claim floor are node-local, so THIS leaf — which is only ever
			// asked about keys it owns — is the only place either question can be answered. A
			// querying node must never compare a row against its OWN floor.
			claimFloor: localClaimFloor(now),
			checkedAt: now,
		});
	}

	static async login(context, data) {
		// `context.login` is installed by Harper's auth middleware only when sessions are
		// enabled. Say so plainly instead of failing with a confusing TypeError.
		if (typeof context?.login !== 'function') {
			return json(
				{
					error:
						'Cookie sessions are disabled on this instance — set `authentication.enableSessions: true` in the Harper config to use the management UI.',
				},
				501
			);
		}

		const username = data?.username;
		const password = data?.password;

		if (typeof username !== 'string' || !username || typeof password !== 'string' || !password) {
			return json({ error: 'username and password are required' }, 400);
		}

		try {
			await context.login(username, password);
		} catch {
			await sleep(FAILED_LOGIN_DELAY_MS);
			// Deliberately does not distinguish unknown user from wrong password.
			return json({ error: 'Invalid credentials' }, 403);
		}

		const user = context.user;

		if (!isSuperUser(user)) {
			// Authenticated, but not permitted. The session cookie is already set; that is
			// harmless (every gated route re-checks the role), and clearing it here would
			// also log the user out of anything else they were using this session for.
			return json({ error: 'This account is not a super_user', authenticated: true, superUser: false }, 403);
		}

		return json({ authenticated: true, username: usernameOf(user), superUser: true });
	}

	static async logout(context) {
		if (!context?.session?.update) return json({ error: 'No active session' }, 401);
		await context.session.update({ user: null });
		return json({ authenticated: false });
	}

	static async overview() {
		const now = Date.now();

		// Deliberately NOTHING here scans or counts: two walks of node-sized tables
		// (QueueStatus/QueueControl, one row per node) and one node-local point read. The
		// histogram AND the table counts come from the background snapshot — this endpoint is
		// hit on every dashboard view and after every action, on workers shared with bot
		// traffic, so its cost has to stay flat no matter how large the deployment is.
		const [{ nodes, cluster, knownScopes }, backlogState] = await Promise.all([
			buildNodeList(now),
			getBacklogSnapshotState(),
		]);

		const lastRun = backlogState.lastRun;

		return {
			generatedAt: now,
			node: server.hostname,
			workerIndex: server.workerIndex,
			// The flag `claim` actually reads on THIS node — the observed state, as opposed to
			// the replicated intent below.
			localQueueStatus: QueueState.status,
			control: { cluster, knownScopes },
			nodes,
			// From the snapshot, so they age with it. Null until the first pass has run.
			counts: lastRun?.counts ?? null,
			countsAsOf: lastRun?.counts ? (lastRun.finishedAt ?? null) : null,
			// The overdue count and next-24h histogram, from the cached snapshot — NOT computed
			// here. The scan walks the index `claim` reads from, so it runs on a background
			// cadence (util/backlogSnapshot.js) and POST /backlog recomputes it on demand. The
			// snapshot row lives in the node-local coordination database, so any worker sees it.
			backlog: {
				enabled: config.management.backlogSnapshotInterval > 0,
				interval: config.management.backlogSnapshotInterval,
				running: backlogState.running,
				lastRun,
			},
			intervals: {
				statusSyncInterval: config.queue.statusSyncInterval,
				jobLeaseTime: config.queue.jobLeaseTime,
				defaultRenderInterval: config.render.defaultInterval,
			},
			// LIVE and O(1) — atomic loads on the node-local shared buffer, not part of the aged
			// snapshot above. `lagMs` is how far behind the current minute the claim scan is
			// starting, which is the one number that says whether a wedged render is pinning the
			// queue: it cannot advance past the oldest in-flight lease.
			claimFloor: (() => {
				const state = floorState(now);
				return {
					...state,
					lagMs: state.floorMinute > 0 ? now - state.floorMinute * 60_000 : null,
					oldestLeaseAgeMs: state.oldestLeaseExpiresAt
						? now - (state.oldestLeaseExpiresAt - config.queue.jobLeaseTime)
						: null,
				};
			})(),
			// This node's last schedule-repair sweep. Node-scoped like the sweep itself: it
			// covers only the keys this node owns.
			reconcile: {
				enabled: config.render.reconcile.enabled,
				interval: config.render.reconcile.interval,
				running: isReconcileRunning(),
				lastRun: getLastReconcile(),
			},
			// Ditto for the key-rule orphan sweep — same node scope, but MANUAL: there is no timer,
			// so `lastRun` is null until someone runs it and there is no cadence to report. It is
			// surfaced here anyway because its result is what an operator needs after a `cacheKey`
			// rule change, and a sweep whose outcome lives only in the response to its own POST is
			// one nobody sees twice.
			orphanSweep: {
				dryRunDefault: config.render.orphanSweep.dryRun,
				maxDeletes: config.render.orphanSweep.maxDeletes,
				running: isOrphanSweepRunning(),
				lastRun: getLastOrphanSweep(),
			},
		};
	}

	static async explain(data, context) {
		const rawUrl = data?.url;
		if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
			return json({ error: 'url is required' }, 400);
		}

		let explanation;
		try {
			explanation = explainCacheKey(rawUrl.trim(), data?.deviceType);
		} catch (e) {
			return json({ error: `Not a valid absolute URL: ${e?.message ?? String(e)}` }, 400);
		}

		const { cacheKey, canonicalUrl } = explanation.resolved;

		// RenderSchedule is residency-pinned (`setResidencyById`), so a plain `get` for a row
		// owned by another node performs a REMOTE fetch (`sourceLoad`) — see Harper's
		// `Table.ts` loadLocalRecord, gated on `context.replicateFrom !== false`. With
		// rendezvous hashing across N nodes, roughly (N-1)/N of all URLs are owned elsewhere,
		// so on a real cluster that made this endpoint hang for almost every URL. Every other
		// RenderSchedule read in this plugin already passes `replicateFrom: false` for the same
		// reason; this one did not.
		//
		// Reading node-locally means the row may simply be absent here rather than missing, so
		// the response reports which node owns it and whether this read was authoritative —
		// otherwise "not scheduled" would be indistinguishable from "not scheduled HERE".
		const scheduleOwnedBy = getResidencyByUrl(canonicalUrl);
		const scheduleReadIsAuthoritative = scheduleOwnedBy === server.hostname;

		// Nothing in a status view justifies hanging the request. Any read that stalls is
		// reported as degraded instead, so a slow or unreachable peer costs a field rather than
		// the whole page.
		const timedOutReads = [];

		// Read every row that decides this URL's fate. The page body is deliberately NOT
		// selected — this is a status view, and a cached page can be megabytes. The target row
		// is keyed by URL and carries the suppression verdict, so one read answers both "is it
		// in rotation" and "did a render suppress it".
		const [target, schedule, page, invalidations] = await Promise.all([
			readWithTimeout('renderTarget', timedOutReads, () =>
				Target.get({
					id: canonicalUrl,
					select: [
						'url',
						'sitemapUrl',
						'schedulerNode',
						'renderInterval',
						'state',
						'suppressedReason',
						'suppressedAt',
						'strikes',
					],
				})
			),
			readWithTimeout('renderSchedule', timedOutReads, () =>
				RenderSchedule.get(
					{ id: cacheKey, select: ['cacheKey', 'nextRenderTime', 'fromSitemap'] },
					{ replicateFrom: false }
				)
			),
			readWithTimeout('prerenderedPage', timedOutReads, () =>
				PrerenderedPage.get({
					id: cacheKey,
					select: ['cacheKey', 'statusCode', 'lastCached', 'expiresAt', 'isIndexable'],
				})
			),
			// The active invalidation set, ONCE per request. Wrapped in readWithTimeout like every
			// other read here, so a slow one degrades this view instead of hanging it.
			readWithTimeout('invalidations', timedOutReads, async () => (await listInvalidations()).rows),
		]);

		const activeInvalidations = invalidations ?? [];
		const suppressed = target?.state === 'suppressed';

		const now = Date.now();
		const expiresAtMs = page?.expiresAt ? new Date(page.expiresAt).getTime() : NaN;
		const lastCachedMs = page?.lastCached ? new Date(page.lastCached).getTime() : NaN;
		// THE freshness rule the serving path applies (same function, not a copy), so this cannot
		// disagree with what a bot would actually get — INCLUDING the invalidation epoch. Reporting
		// `cached` for a page bots are being sent to the origin for is the specific divergence the
		// `resolveServeStatus` rename exists to make impossible, and this view is where an operator
		// looks first when asking why a URL is not being served.
		const invalidationEpoch = epochFromActiveSet(activeInvalidations, routeScopeForUrl(canonicalUrl));
		const serve = resolveServeStatus({
			expiresAtMs,
			lastCachedMs,
			swrTtl: config.page.swrTtl,
			now,
			epoch: invalidationEpoch,
		});
		const fresh = serve.servable;

		// The local schedule read was node-local. If another node owns this row, ask it — a
		// bounded HTTPS call we control, rather than the unbounded replication fetch a plain
		// cross-node `get` would have done. Only attempted when the local read didn't already
		// find the row (a row present locally is authoritative regardless of residency).
		let scheduleRow = schedule ? describeScheduleRow(schedule, now) : null;
		// The claim floor this row is judged against. Local only while this node is the owner —
		// the floor is node-local state about this node's slice of a residency-pinned table, so
		// comparing somebody else's key against it would be a confident wrong answer.
		let claimFloor = scheduleReadIsAuthoritative ? localClaimFloor(now) : null;
		let scheduleSource = scheduleReadIsAuthoritative ? 'local (owner)' : 'local (not owner)';
		let peerError = null;

		if (!scheduleReadIsAuthoritative && !schedule && config.management.proxyToOwner) {
			const peer = await fetchScheduleFromPeer({
				hostname: scheduleOwnedBy,
				cacheKey,
				headers: context?.headers,
			});
			if (peer.ok) {
				// Consumed verbatim: the owner already computed `leased`, `leaseExpiresAt` and
				// `belowClaimFloor` against ITS lease table and ITS floor, which is the only
				// authoritative answer to either question.
				scheduleRow = peer.row;
				claimFloor = peer.claimFloor;
				scheduleSource = `owner ${scheduleOwnedBy}`;
			} else {
				peerError = peer.reason;
			}
		}

		// True when the row shown is the owner's answer — either we ARE the owner, or the owner
		// told us. Drives the UI's "inconclusive" wording.
		const scheduleAuthoritative = scheduleReadIsAuthoritative || scheduleSource.startsWith('owner ');

		return json({
			...explanation,
			rows: {
				renderTarget: target ?? null,
				// Already described (locally or by the owner) — see above.
				renderSchedule: scheduleRow,
				prerenderedPage: page
					? {
							cacheKey: page.cacheKey,
							statusCode: page.statusCode,
							lastCached: page.lastCached ? new Date(page.lastCached).getTime() : null,
							expiresAt: Number.isFinite(expiresAtMs) ? expiresAtMs : null,
							isIndexable: page.isIndexable ?? null,
							fresh,
							// Between expiresAt and expiresAt + swrTtl the page is still served
							// while a re-render lands. Distinguishing this from a real miss matters:
							// it is the normal steady state, not a fault.
							inStaleWhileRevalidate: !fresh ? false : Number.isFinite(expiresAtMs) && expiresAtMs <= now,
							swrTtl: config.page.swrTtl,
						}
					: null,
				suppression: suppressed
					? {
							reason: target.suppressedReason ?? null,
							suppressedAt: target.suppressedAt ? new Date(target.suppressedAt).getTime() : null,
							strikes: target.strikes ?? null,
							maxStrikes: config.render.suppression.maxStrikes,
							recheckInterval: config.render.suppression.recheckInterval,
						}
					: null,
			},
			verdict: {
				// Every field here is derived from rows that may have failed to read, so it is
				// only trustworthy when `reliable` is true. A timed-out read yields a null row,
				// which would otherwise be indistinguishable from a genuinely absent one and turn
				// a degraded response into a confident false negative.
				reliable: timedOutReads.length === 0,
				// What a bot request for this URL would get right now.
				wouldServe: fresh ? 'cache' : 'origin-or-render',
				// Only meaningful when `residency.scheduleAuthoritative` is true.
				scheduled: !!scheduleRow,
				recurring: !!target && !suppressed,
				// A suppressed target blocks re-discovery and re-checks itself on its own
				// schedule; the row above says why and since when.
				suppressed,
			},
			residency: {
				queriedNode: server.hostname,
				// RenderSchedule rows are pinned to the node that owns the URL. This node reads
				// locally (a cross-node point read would await Harper's untimed replication
				// fetch), then asks the owner directly over HTTPS when it isn't the owner.
				scheduleOwnedBy,
				// Was the LOCAL read the owner's own copy?
				scheduleReadIsAuthoritative,
				// Is the row actually shown authoritative — local-as-owner, or fetched from the
				// owner? Only when this is false does "not scheduled" mean "not scheduled here".
				scheduleAuthoritative,
				scheduleSource,
				// Why the owner could not be consulted, when it couldn't.
				peerError,
			},
			// The floor the row above is judged against, or null when nobody authoritative answered.
			// `rows.renderSchedule.belowClaimFloor` is only meaningful when this is present.
			claimFloor,
			degraded: timedOutReads.length ? { timedOutReads } : null,
			checkedAt: now,
		});
	}

	static async setQueuePause(data, context) {
		// The operator escape hatch for a due time written below the claim floor by something
		// outside the plugin (the operations API, or a PUT to the exported RenderSchedule
		// endpoint — neither runs any plugin code). Waiting out
		// `queue.claimFloor.resetInterval` is the automatic recovery; during an incident, this
		// turns a five-minute wait into an immediate one. Node-scoped, like the floor itself.
		if (data?.action === 'reset-claim-floor') {
			return json(await RenderQueue.resetClaimFloor());
		}

		const scope = data?.scope ?? server.hostname;
		const paused = data?.paused;

		if (typeof scope !== 'string' || !scope) {
			return json({ error: 'scope must be a hostname or "all"' }, 400);
		}
		if (paused !== true && paused !== false && paused !== null) {
			return json({ error: 'paused must be true (pause), false (force run), or null (inherit)' }, 400);
		}

		// Reject a scope that names nothing. A row under a mistyped hostname would sit there
		// looking like an applied setting while every node ignores it.
		const { knownScopes } = await buildNodeList(Date.now());
		if (!knownScopes.includes(scope)) {
			return json({ error: `Unknown scope "${scope}"`, knownScopes }, 400);
		}
		if (scope === CLUSTER_SCOPE && paused === null) {
			// There is nothing above 'all' to inherit from; deleting it and setting false are
			// equivalent, and keeping the row preserves who resumed and when.
			return json({ error: 'Use paused: false to resume the cluster (null is only meaningful per node)' }, 400);
		}

		const result = await RenderQueue.setPause({
			scope,
			paused,
			updatedBy: usernameOf(context?.user) ?? 'prerender_admin',
		});

		return json({
			...result,
			// A remote node applies this on its next status sync, not instantly.
			appliesRemotelyWithinMs: config.queue.statusSyncInterval,
		});
	}

	/**
	 * Recompute the backlog snapshot NOW. Same shape as `reconcile`: the scan is detached (it
	 * can take a while against a large backlog and nothing is gained holding the request open),
	 * and a scan already in flight reports itself rather than implying a second one started.
	 */
	static async backlog() {
		const { running, lastRun } = await getBacklogSnapshotState();
		const payload = { node: server.hostname, lastRun };

		if (running) return json({ ...payload, started: false, alreadyRunning: true });

		runBacklogSnapshotOnce().catch((e) => logger.error(e));
		return json({ ...payload, started: true, alreadyRunning: false });
	}

	/**
	 * Root sitemaps with their refresh state. `entries` is deliberately never selected — one
	 * row can hold tens of thousands of them; the counts are what the list needs. Children are
	 * omitted for the same reason `rootSitemapUrls` walks roots only: an index reaches its own
	 * children, and the per-root SitemapRefresh row already aggregates the walk.
	 */
	static async sitemapList() {
		const roots = [];
		for await (const row of Sitemap.search({ select: ['url', 'parentUrl', 'entryCount', 'lastRefreshed'] })) {
			if (!row.parentUrl) roots.push(row);
		}
		roots.sort((a, b) => String(a.url).localeCompare(String(b.url)));

		// The whole SitemapRefresh table is one row per root plus the 'all' marker — small by
		// construction.
		const refreshRows = await Array.fromAsync(SitemapRefresh.search({}));
		const refreshById = new Map(refreshRows.map((row) => [row.id, row]));

		return {
			node: server.hostname,
			sitemaps: roots.map((row) => ({
				url: row.url,
				entryCount: row.entryCount ?? null,
				lastRefreshed: row.lastRefreshed ?? null,
				refresh: refreshById.get(row.url) ?? null,
			})),
			lastFullPass: refreshById.get('all')?.lastRefreshed ?? null,
		};
	}

	/**
	 * One sitemap's detail: its refresh row, a capped count of the targets attributed to it,
	 * and ONE page of entries with per-entry state.
	 *
	 * Costs, deliberately bounded to an explicit click:
	 *   - one point read of the sitemap row (`entries` included — that is where they live);
	 *   - a capped walk of the `sitemapUrl` index (select of the key only) for the target count;
	 *   - ≤ pageSize point reads each on Target / PrerenderedPage for the
	 *     page of entries shown. RenderSchedule is deliberately NOT read per entry: it is
	 *     residency-pinned, so most rows are unreadable without a cross-node fetch — the
	 *     explainer is the tool for one URL's schedule, with the peer fetch and the wording
	 *     that distinguishes "absent" from "absent here".
	 */
	static sitemapDetail(data) {
		return withHeavySlot(() => this.sitemapDetailInner(data));
	}

	static async sitemapDetailInner(data) {
		const url = data?.url;
		if (typeof url !== 'string' || !url) return json({ error: 'url is required' }, 400);

		const pageSize = Math.max(1, config.management.pageSize | 0);
		const limit = Math.min(Math.max(1, data?.limit | 0 || pageSize), pageSize);
		const offset = Math.max(0, data?.offset | 0);

		const timedOutReads = [];
		const sitemap = await readWithTimeout('sitemap', timedOutReads, () => readSitemapRow(url));
		if (timedOutReads.length) return json({ error: 'sitemap read timed out' }, 504);
		if (!sitemap) return json({ error: `No sitemap stored under ${url}` }, 404);

		const refresh = await readWithTimeout('sitemapRefresh', timedOutReads, () => SitemapRefresh.get(url));

		const allEntries = Array.isArray(sitemap.entries) ? sitemap.entries : [];
		const pageOfEntries = allEntries.slice(offset, offset + limit);

		// ONE read for the whole page of entries, derived per row synchronously. A per-row epoch read
		// would double this view's cost — it is already a fan-out inside a heavy slot — and the path
		// of least resistance would have been to pass only the cluster epoch and silently miss every
		// route scope.
		const activeInvalidations =
			(await readWithTimeout('invalidations', timedOutReads, () => listInvalidations()))?.rows ?? [];

		const [targetCount, entries] = await Promise.all([
			this.countTargetsFor(url),
			Promise.all(pageOfEntries.map((entry) => this.entryState(entry, activeInvalidations))),
		]);

		return json({
			node: server.hostname,
			sitemap: {
				url: sitemap.url,
				isIndex: !!sitemap.isIndex,
				entryCount: sitemap.entryCount ?? allEntries.length,
				lastRefreshed: sitemap.lastRefreshed ?? null,
				parentUrl: sitemap.parentUrl ?? null,
			},
			refresh: refresh ?? null,
			targetCount,
			entries,
			offset,
			limit,
			degraded: timedOutReads.length ? { timedOutReads } : null,
		});
	}

	/**
	 * Capped count of Targets attributed to one sitemap — an indexed equality walk
	 * selecting only the key, counted without buffering. Null when it timed out (unknown, not
	 * zero).
	 */
	static async countTargetsFor(sitemapUrl) {
		const cap = Math.max(1, config.management.scanCap | 0);
		const timedOut = [];
		const counted = await readWithTimeout('targetCount', timedOut, async () => {
			let count = 0;
			// Yields between batches (shared worker); the `cap` bound is what limits how long
			// the walk's read snapshot lives (a `snapshot` query option is not consumed by
			// Harper's search path).
			// eslint-disable-next-line no-unused-vars
			for await (const row of Target.search({
				conditions: [{ attribute: 'sitemapUrl', value: sitemapUrl }],
				select: ['url'],
				limit: cap,
			})) {
				count++;
				if (count % YIELD_EVERY === 0) await yieldNow();
			}
			return count;
		});
		if (counted === null) return null;
		return { count: counted, cap, truncated: counted >= cap };
	}

	/**
	 * The console-facing state of one sitemap entry, from bounded point reads.
	 *
	 * A `filtered` entry needs NO reads: the same classifier the serving path uses says the
	 * path is not a prerender route, so nothing about it is stored anywhere. A read that times
	 * out yields `state: null` — unknown, which the UI must render as such rather than as
	 * "not cached".
	 */
	static async entryState(entry, activeInvalidations = []) {
		const loc = entry?.loc;
		const base = {
			loc: loc ?? null,
			changefreq: entry?.changefreq ?? null,
			priority: entry?.priority ?? null,
		};

		let explanation;
		try {
			explanation = explainCacheKey(String(loc));
		} catch {
			return { ...base, state: 'invalid', stateDetail: 'not an absolute URL' };
		}

		if (!explanation.eligibility.prerendered) {
			return { ...base, state: 'filtered', stateDetail: `${explanation.ingress.routeClass} route` };
		}

		const { cacheKey, canonicalUrl } = explanation.resolved;
		const timedOut = [];

		const [target, page] = await Promise.all([
			readWithTimeout('renderTarget', timedOut, () => Target.get({ id: canonicalUrl, select: ['url', 'state'] })),
			readWithTimeout('prerenderedPage', timedOut, () =>
				PrerenderedPage.get({ id: cacheKey, select: ['cacheKey', 'expiresAt', 'lastCached'] })
			),
		]);

		if (timedOut.length) return { ...base, cacheKey, state: null };

		if (target?.state === 'suppressed') return { ...base, cacheKey, state: 'non-indexable' };

		if (page) {
			const expiresAtMs = page.expiresAt ? new Date(page.expiresAt).getTime() : NaN;
			const lastCachedMs = page.lastCached ? new Date(page.lastCached).getTime() : NaN;
			// `lastCached` was added to this select for the epoch comparison. Without it this view
			// reported `cached` while bots got the origin — and it is fanned across a whole page of
			// sitemap entries, so it was the widest-reach instance of that divergence.
			const serve = resolveServeStatus({
				expiresAtMs,
				lastCachedMs,
				swrTtl: config.page.swrTtl,
				now: Date.now(),
				epoch: epochFromActiveSet(activeInvalidations, routeScopeForUrl(canonicalUrl)),
			});
			return {
				...base,
				cacheKey,
				state: serve.servable ? 'cached' : serve.status === 'invalidated' ? 'invalidated' : 'stale',
			};
		}

		return target
			? { ...base, cacheKey, state: 'scheduled', stateDetail: 'target, not yet cached' }
			: { ...base, cacheKey, state: 'no target' };
	}

	/**
	 * Kick off a background sitemap refresh — one root when `url` is given, else every root.
	 * Same claim/skip semantics as POSTing the sitemaps resource itself; this exists so the
	 * console talks only to this one gated surface.
	 */
	static async sitemapRefresh(data) {
		const url = data?.url;
		if (url !== undefined && (typeof url !== 'string' || !url)) {
			return json({ error: 'url must be a sitemap URL, or omitted to refresh every root' }, 400);
		}
		return json(await startSitemapRefreshInBackground(url));
	}

	/**
	 * A page of `PrerenderedPage` rows by cache-key prefix, cursor-paged.
	 *
	 * This is a primary-key RANGE — the only cheap shape this table offers (its only index is
	 * the key). No freshness/status/indexable conditions exist server-side, on purpose: they
	 * would be unindexed table filters, and the client filters the fetched page instead,
	 * labelled as exactly that. `content` is never selected.
	 */
	// Crawl breadth: distinct URLs crawled per bot per UTC day, from the merged CrawlSketch
	// node rows (util/crawlStats.js). Query cost: one day-indexed range read of
	// days × bots-with-traffic × nodes 16 KB rows (a week on a 4-node cluster is a few
	// hundred rows), capped below and reported truncated rather than presented as complete.
	// Never touches the render queue or the page cache.
	/**
	 * Bucketed analytics series for the console's charts — this node (or the cluster, when the
	 * deployment replicates `hdb_analytics`; the payload says which).
	 *
	 * ONE bounded primary-key scan per refresh for EVERY metric the console charts, never one
	 * per metric name (`util/analyticsRead.js` has the arithmetic), answered from a per-worker
	 * cache inside `management.analytics.cacheTtl`. It still takes a heavy slot: a cache miss
	 * is a real scan, and two operators refreshing distinct ranges is two of them.
	 */
	static analytics(target) {
		return withHeavySlot(() => this.analyticsInner(target));
	}

	static async analyticsInner(target) {
		const opts = config.management.analytics;
		if (!opts.enabled) return json({ error: 'management.analytics.enabled is false' }, 404);

		const rangeMs = clampRange(target?.get?.('range'), opts.maxRange);

		try {
			const window = await readAnalyticsWindow(rangeMs);
			return json({
				node: server.hostname,
				workerIndex: server.workerIndex,
				rangeMs,
				// Reference bands for the charts: what "healthy" sits under, so the lines carry
				// their own yardstick instead of the operator recalling config values.
				intervals: {
					defaultRenderInterval: config.render.defaultInterval,
					jobLeaseTime: config.queue.jobLeaseTime,
				},
				...window,
			});
		} catch (e) {
			logger.warn?.(`[prerender] admin analytics scan failed: ${e?.message ?? String(e)}`);
			return json({ error: `Analytics scan failed: ${e?.message ?? String(e)}` }, 500);
		}
	}

	static crawlBreadth(target) {
		return withHeavySlot(() => this.crawlBreadthInner(target));
	}

	static async crawlBreadthInner(target) {
		const days = Math.min(Math.max(1, Number(target?.get?.('days')) || 7), 31);
		const since = new Date(Date.now() - (days - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
		const cap = 4096;
		const results = databases.crawl_stats.CrawlSketch.search({
			conditions: [{ attribute: 'day', comparator: 'greater_than_equal', value: since }],
			select: ['day', 'bot', 'registers'],
			limit: cap + 1, // one extra row = "truncated", never merged
		});

		// Stream the cursor instead of buffering it: each 16 KB row merges into the
		// accumulator and is released, so the resident set is one sketch per (day, bot) —
		// not up to cap × 16 KB of raw rows. Yield the event loop periodically; this worker
		// also serves bot traffic.
		const byDay = new Map();
		let shardsMerged = 0;
		let truncated = false;
		for await (const row of results) {
			if (shardsMerged === cap) {
				truncated = true;
				break;
			}
			mergeBreadthRow(byDay, row);
			if (++shardsMerged % 200 === 0) await yieldNow();
		}

		return json({
			node: server.hostname,
			days,
			since,
			shardsMerged,
			truncated,
			breadth: finalizeBreadth(byDay),
		});
	}

	static listPages(target) {
		return withHeavySlot(() => this.listPagesInner(target));
	}

	static async listPagesInner(target) {
		const prefix = String(target?.get?.('prefix') ?? '').trim();
		const cursor = String(target?.get?.('cursor') ?? '');
		const pageSize = Math.max(1, config.management.pageSize | 0);
		const limit = Math.min(Math.max(1, Number(target?.get?.('limit')) || pageSize), pageSize);

		// `￿` sorts after every code unit that can appear in a key, so [prefix, prefix+
		// '￿') is the prefix range. The cursor (last key of the previous page) narrows the
		// lower bound; `greater_than` both excludes it and gives the no-prefix case a full-table
		// ascending walk bounded by `limit`.
		const conditions = [{ attribute: 'cacheKey', comparator: 'greater_than', value: cursor || prefix || '' }];
		if (prefix) {
			conditions.push({ attribute: 'cacheKey', comparator: 'less_than', value: `${prefix}￿` });
		}

		const timedOut = [];
		const rows = await readWithTimeout('pages', timedOut, () =>
			Array.fromAsync(
				PrerenderedPage.search({
					conditions,
					sort: { attribute: 'cacheKey' },
					select: ['cacheKey', 'statusCode', 'lastCached', 'expiresAt', 'isIndexable'],
					limit: limit + 1, // one extra row = "there is a next page", never shown
				})
			)
		);
		if (timedOut.length) return json({ error: 'page-cache read timed out' }, 504);

		// ONE read for the whole page, derived per row synchronously below.
		const activeInvalidations =
			(await readWithTimeout('invalidations', timedOut, () => listInvalidations()))?.rows ?? [];

		// The table total comes from the background snapshot, aged like the overview's counts —
		// a browse click must not trigger a count scan.
		const { lastRun } = await getBacklogSnapshotState();
		const total = lastRun?.counts?.pages ?? null;
		const now = Date.now();
		const pageRows = rows.slice(0, limit).map((row) => {
			const expiresAtMs = row.expiresAt ? new Date(row.expiresAt).getTime() : NaN;
			// The URL-half of a cache key is `canonicalizeUrl` output, which is a full URL
			// (scheme included; see util/url.js — `new URL(half).href === half` by contract).
			const urlHalf = CacheKey.extractUrl(row.cacheKey);
			const { deviceType } = CacheKey.parse(row.cacheKey);
			return {
				cacheKey: row.cacheKey,
				statusCode: row.statusCode,
				lastCached: row.lastCached ? new Date(row.lastCached).getTime() : null,
				expiresAt: Number.isFinite(expiresAtMs) ? expiresAtMs : null,
				isIndexable: row.isIndexable ?? null,
				// THE freshness rule the serving path applies (same function, not a copy), epoch
				// included. Derived synchronously off the one active-set read above — this map is
				// synchronous by design and a per-row read would make it a fan-out.
				fresh: resolveServeStatus({
					expiresAtMs,
					lastCachedMs: row.lastCached ? new Date(row.lastCached).getTime() : NaN,
					swrTtl: config.page.swrTtl,
					now,
					epoch: epochFromActiveSet(activeInvalidations, routeScopeForUrl(urlHalf)),
				}).servable,
				url: urlHalf || null,
				deviceType: deviceType ?? null,
			};
		});

		return json({
			node: server.hostname,
			prefix,
			pages: pageRows,
			truncated: rows.length > limit,
			nextCursor: rows.length > limit ? pageRows[pageRows.length - 1].cacheKey : null,
			total,
		});
	}

	/**
	 * Stream ONE stored page's HTML.
	 *
	 * Served as text/plain with nosniff, NEVER text/html: the stored markup is origin-
	 * influenced content, and serving it as HTML from this origin would execute it against the
	 * operator's super-user session. The stored body may carry a content-encoding from the
	 * render; it is decoded here so the response is the bytes a person can actually read.
	 */
	static pageContent(target) {
		return withHeavySlot(() => this.pageContentInner(target));
	}

	static async pageContentInner(target) {
		const cacheKey = String(target?.get?.('cacheKey') ?? '');
		if (!cacheKey) return json({ error: 'cacheKey is required' }, 400);

		const timedOut = [];
		const page = await readWithTimeout('pageContent', timedOut, () =>
			PrerenderedPage.get({ id: cacheKey, select: ['cacheKey', 'content', 'headers'] })
		);
		if (timedOut.length) return json({ error: 'page read timed out' }, 504);
		if (!page?.content) return json({ error: `No cached page under this key`, cacheKey }, 404);

		let body;
		try {
			// Buffer the one row rather than plumbing a stream: cached pages are sub-few-MB by
			// construction, this is an explicit per-row click, and decoding needs the bytes anyway.
			body = Buffer.from(await page.content.arrayBuffer());
			const storedHeaders = page.headers ? JSON.parse(page.headers) : {};
			const encoding = storedHeaders['content-encoding'];
			if (encoding) body = decode(body, encoding);
		} catch (e) {
			return json({ error: `Could not read the stored content: ${e?.message ?? String(e)}` }, 500);
		}

		return new Response(body, {
			status: 200,
			headers: noStore({
				'content-type': 'text/plain; charset=utf-8',
				'x-content-type-options': 'nosniff',
				'content-disposition': 'inline',
			}),
		});
	}
}
