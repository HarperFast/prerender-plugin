/**
 * Management API + UI, exported at `/prerender_admin`.
 *
 * Authentication is Harper's own: `POST /prerender_admin/login` calls `context.login()`,
 * which authenticates against Harper users and sets the `hdb-session` cookie, and every
 * data/action route then requires `role.permission.super_user`.
 *
 * That super-user check is written out explicitly on every route rather than left to
 * Harper's `allowRead`/`allowCreate` hooks, because this resource — like the others in this
 * plugin — sets `loadAsInstance = false`, and Harper only runs the allow* checks when
 * `loadAsInstance !== false` (see `resources/Resource.ts`). Inheriting the default gate
 * here would look secure and enforce nothing.
 *
 * Routes (data responses are `no-store`; static assets carry cache headers of their own):
 *   GET  /prerender_admin/           the UI shell                   public (contains no data)
 *   GET  /prerender_admin            308 → ./prerender_admin/       public
 *   GET  /prerender_admin/<asset>    app.css/app.js/views/fonts     public (contain no data)
 *   GET  /prerender_admin/session    who am I                       public
 *   POST /prerender_admin/login      { username, password }         public
 *   POST /prerender_admin/logout     end the session                session required
 *   GET  /prerender_admin/overview   nodes, counts, backlog shape   super_user
 *   GET  /prerender_admin/config     effective config + warnings    super_user
 *   GET  /prerender_admin/sitemaps   root sitemaps + refresh state  super_user
 *   GET  /prerender_admin/pages      ?prefix&cursor&limit           super_user
 *   GET  /prerender_admin/page-content ?cacheKey (text/plain)       super_user
 *   GET  /prerender_admin/unrouted   this worker's unrouted tally   super_user
 *   POST /prerender_admin/explain    { url, deviceType }            super_user
 *   POST /prerender_admin/schedule   { cacheKey } -> local row      super_user
 *   POST /prerender_admin/queue      { scope, paused }              super_user
 *   POST /prerender_admin/revalidate { url, deviceType }            super_user
 *   POST /prerender_admin/reconcile  start a repair sweep           super_user
 *   POST /prerender_admin/migrate-targets  one-shot v0.19 registry migration  super_user
 *   POST /prerender_admin/backlog    recompute the backlog snapshot super_user
 *   POST /prerender_admin/sitemap    { url, offset, limit } detail  super_user
 *   POST /prerender_admin/sitemap-refresh { url? }                  super_user
 *
 * QUERY-COST RULES for every route here (this console shares the server with bot traffic):
 *   - Nothing walks `RenderSchedule.nextRenderTime` on page load — `claim` reads that index
 *     from every worker every few seconds. The backlog histogram is a cached snapshot
 *     (util/backlogSnapshot.js); recomputing it is an explicit POST.
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
import { config, collectConfigWarnings } from '../config.js';
import { redactConfig } from '../util/redact.js';
import { explainCacheKey } from '../util/explain.js';
import { CacheKey } from '../util/cacheKey.js';
import { CLUSTER_SCOPE } from '../util/queueControl.js';
import { getResidencyByUrl } from '../util/residency.js';
import { fetchScheduleFromPeer } from '../util/peer.js';
import { getLastReconcile, isReconcileRunning, runReconcileOnce } from '../util/reconcile.js';
import { getMigrationStatus, runTargetMigration } from '../util/migrateTargets.js';
import { getBacklogSnapshotState, runBacklogSnapshotOnce } from '../util/backlogSnapshot.js';
import { peekUnroutedReport } from '../util/unrouted.js';
import { decode } from '../util/contentEncoding.js';
import { RenderQueue } from './RenderQueue.js';
import { QueueState } from './QueueState.js';
import { startSitemapRefreshInBackground } from './Sitemap.js';
import { currentMinuteMs } from '../util/time.js';
import { getAdminAsset, renderAdminPage } from '../admin/index.js';

const {
	render_schedule: { RenderSchedule },
	render_service: { Target, QueueStatus, QueueControl },
	page_cache: { PrerenderedPage },
	sitemaps: { Sitemap, SitemapRefresh },
} = databases;

// How long after a node's last status report we call its row stale. Two sync intervals,
// so a single missed tick doesn't flap the UI.
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

const noStore = (extra = {}) => ({ 'cache-control': 'no-store', ...extra });

const json = (data, status = 200) =>
	new Response(JSON.stringify(data), {
		status,
		headers: noStore({ 'content-type': 'application/json; charset=utf-8' }),
	});

const html = (body) =>
	new Response(body, {
		status: 200,
		headers: noStore({
			'content-type': 'text/html; charset=utf-8',
			'x-content-type-options': 'nosniff',
			'referrer-policy': 'no-referrer',
			// The console is fully self-contained: its stylesheet, scripts and fonts are served
			// from this same resource, and everything else is same-origin fetch. No inline
			// script or style anywhere, so no 'unsafe-inline'.
			'content-security-policy':
				"default-src 'none'; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; img-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
		}),
	});

/**
 * One static asset. Public like the shell itself — these files ship in the package and carry
 * no data. Code assets are `no-cache` (always revalidated, answered 304 via ETag), fonts are
 * immutable (their bytes are pinned to their filename; a changed font gets a new name).
 */
const assetResponse = (asset, requestHeaders) => {
	const headers = {
		'content-type': asset.contentType,
		'etag': asset.etag,
		'cache-control': asset.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
		'x-content-type-options': 'nosniff',
	};
	if (requestHeaders?.get?.('if-none-match') === asset.etag) {
		return new Response(null, { status: 304, headers });
	}
	return new Response(asset.body, { status: 200, headers });
};

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
			// The shell's asset URLs are relative, so it must be served under the trailing-slash
			// URL. `isCollection` is how RequestTarget distinguishes `/prerender_admin/` from
			// `/prerender_admin`; the Location is relative (resolved by the browser against the
			// request URL), so a deployment base-URL prefix is preserved without knowing it here.
			if (!target?.isCollection) {
				return new Response(null, { status: 308, headers: noStore({ location: 'prerender_admin/' }) });
			}
			// The page itself carries no data — it renders a login form and fetches everything
			// through the gated routes below.
			return html(renderAdminPage());
		}

		// Static assets, public like the shell: they ship in the package and carry no data.
		// getAdminAsset resolves ONLY allowlisted ids — the id arrives percent-decoded, so a
		// traversal attempt is just an unknown id and falls through to the 404 below.
		const asset = getAdminAsset(route);
		if (asset) return assetResponse(asset, context?.headers);

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
				return json({
					config: redactConfig(config),
					warnings: collectConfigWarnings(),
					node: server.hostname,
					workerIndex: server.workerIndex,
				});
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
			case 'revalidate':
				return PrerenderAdmin.revalidateUrl(data);
			case 'reconcile':
				return PrerenderAdmin.reconcile();
			case 'migrate-targets':
				return PrerenderAdmin.migrateTargets();
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
		// The write is residency-routed, so this reaches the owning node from any node.
		await RenderSchedule.put(cacheKey, { nextRenderTime, fromSitemap: !!target.sitemapUrl });

		// `claim` reads a node-local flag, so waking consumers only helps on the node that owns
		// the row — anywhere else the owner picks it up on its own status-sync tick instead.
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
	/**
	 * Start (or poll) the one-shot legacy-registry migration on THIS node — see
	 * util/migrateTargets.js for the deploy sequence. Detached like `reconcile`: the sweep
	 * walks ~1.6M legacy rows, far past any HTTP timeout, so the POST starts it and returns;
	 * re-POSTing reports live progress and, once finished, the run summary.
	 */
	static migrateTargets() {
		const status = getMigrationStatus();
		if (status.running) {
			return json({ ...status, started: false, alreadyRunning: true });
		}

		// Detached: the sweep outlives this request, so a rejection has to be handled here or
		// it surfaces as an unhandled rejection. The failure lands in lastRun for the next poll.
		runTargetMigration().catch((e) => logger.error(e, '[prerender] target migration failed'));

		return json({ ...status, started: true, alreadyRunning: false });
	}

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
			renderSchedule: row
				? {
						...row,
						nextRenderTime: Number(row.nextRenderTime),
						dueInMs: Number(row.nextRenderTime) - now,
						overdue: Number(row.nextRenderTime) <= now,
					}
				: null,
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
			// This node's last schedule-repair sweep. Node-scoped like the sweep itself: it
			// covers only the keys this node owns.
			reconcile: {
				enabled: config.render.reconcile.enabled,
				interval: config.render.reconcile.interval,
				running: isReconcileRunning(),
				lastRun: getLastReconcile(),
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
		const [target, schedule, page] = await Promise.all([
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
		]);

		const suppressed = target?.state === 'suppressed';

		const now = Date.now();
		const expiresAtMs = page?.expiresAt ? new Date(page.expiresAt).getTime() : NaN;
		// Same freshness rule the serving path applies, so this cannot disagree with what a
		// bot would actually get.
		const fresh = !isNaN(expiresAtMs) && expiresAtMs + config.page.swrTtl > now;

		// The local schedule read was node-local. If another node owns this row, ask it — a
		// bounded HTTPS call we control, rather than the unbounded replication fetch a plain
		// cross-node `get` would have done. Only attempted when the local read didn't already
		// find the row (a row present locally is authoritative regardless of residency).
		let scheduleRow = schedule;
		let scheduleSource = scheduleReadIsAuthoritative ? 'local (owner)' : 'local (not owner)';
		let peerError = null;

		if (!scheduleReadIsAuthoritative && !schedule && config.management.proxyToOwner) {
			const peer = await fetchScheduleFromPeer({
				hostname: scheduleOwnedBy,
				cacheKey,
				headers: context?.headers,
			});
			if (peer.ok) {
				scheduleRow = peer.row;
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
				renderSchedule: scheduleRow
					? {
							...scheduleRow,
							nextRenderTime: Number(scheduleRow.nextRenderTime),
							dueInMs: Number(scheduleRow.nextRenderTime) - now,
							overdue: Number(scheduleRow.nextRenderTime) <= now,
						}
					: null,
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
			degraded: timedOutReads.length ? { timedOutReads } : null,
			checkedAt: now,
		});
	}

	static async setQueuePause(data, context) {
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

		const [targetCount, entries] = await Promise.all([
			this.countTargetsFor(url),
			Promise.all(pageOfEntries.map((entry) => this.entryState(entry))),
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
			// Yields between batches (shared worker) and holds no read snapshot open for the
			// walk's duration.
			// eslint-disable-next-line no-unused-vars
			for await (const row of Target.search({
				conditions: [{ attribute: 'sitemapUrl', value: sitemapUrl }],
				select: ['url'],
				limit: cap,
				snapshot: false,
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
	static async entryState(entry) {
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
				PrerenderedPage.get({ id: cacheKey, select: ['cacheKey', 'expiresAt'] })
			),
		]);

		if (timedOut.length) return { ...base, cacheKey, state: null };

		if (target?.state === 'suppressed') return { ...base, cacheKey, state: 'non-indexable' };

		if (page) {
			const expiresAtMs = page.expiresAt ? new Date(page.expiresAt).getTime() : NaN;
			const fresh = !isNaN(expiresAtMs) && expiresAtMs + config.page.swrTtl > Date.now();
			return { ...base, cacheKey, state: fresh ? 'cached' : 'stale' };
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
				// Same freshness rule the serving path applies.
				fresh: !isNaN(expiresAtMs) && expiresAtMs + config.page.swrTtl > now,
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
