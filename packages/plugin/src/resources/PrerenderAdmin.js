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
 * Routes (all responses are `no-store`):
 *   GET  /prerender_admin           the UI page                     public (contains no data)
 *   GET  /prerender_admin/session   who am I                        public
 *   POST /prerender_admin/login     { username, password }          public
 *   POST /prerender_admin/logout    end the session                 session required
 *   GET  /prerender_admin/overview  nodes, counts, backlog shape    super_user
 *   GET  /prerender_admin/config    effective config + warnings     super_user
 *   POST /prerender_admin/explain   { url, deviceType }             super_user
 *   POST /prerender_admin/queue     { scope, paused }               super_user
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { config, collectConfigWarnings } from '../config.js';
import { redactConfig } from '../util/redact.js';
import { explainCacheKey } from '../util/explain.js';
import { CLUSTER_SCOPE } from '../util/queueControl.js';
import { getResidencyByUrl } from '../util/residency.js';
import { RenderQueue } from './RenderQueue.js';
import { QueueState } from './QueueState.js';
import { HOUR } from '../util/time.js';
import { renderAdminPage } from '../admin/page.js';

const {
	render_schedule: { RenderSchedule },
	render_service: { RenderTarget, QueueStatus, QueueControl },
	page_cache: { PrerenderedPage },
	sitemaps: { Sitemap },
	signals: { NonIndexable },
} = databases;

// How long after a node's last status report we call its row stale. Two sync intervals,
// so a single missed tick doesn't flap the UI.
const nodeStaleAfter = () => config.queue.statusSyncInterval * 2;

// Delay applied to a rejected login. Not real rate limiting (there is no cross-worker
// state here) — just enough to make a serial password walk unproductive. Harper's own
// auth audit log is the actual detection surface.
const FAILED_LOGIN_DELAY_MS = 300;

const HISTOGRAM_HOURS = 24;

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
			// The page is fully self-contained: inline style/script, same-origin fetches, no
			// external loads of any kind. Nothing here needs to reach the network.
			'content-security-policy':
				"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
		}),
	});

// Harper's RequestTarget leaves `id` undefined for `/prerender_admin` but sets it to `null`
// for `/prerender_admin/` (a trailing slash marks a collection). Both mean "the root", so
// normalize to '' rather than treating one of them as an unknown route.
const routeOf = (target) => {
	const id = target?.id;
	return id === null || id === undefined ? '' : String(id);
};

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

/**
 * One capped, index-ordered walk of `RenderSchedule` over everything due within the next
 * `HISTOGRAM_HOURS`, bucketed by hour (plus an `overdue` bucket for anything already due).
 *
 * A single ascending scan gives both the backlog count and the upcoming shape. Because it
 * is ascending, a backlog larger than the cap consumes the whole budget and the histogram
 * comes back empty — which is the correct signal, not a defect: when you are that far
 * behind, the next-24h distribution is not the problem.
 *
 * Counting is capped because there is no cheap exact count for a range in the underlying
 * store; `truncated` says so explicitly rather than presenting a short count as the total.
 */
async function scanUpcoming(now, cap) {
	const horizon = now + HISTOGRAM_HOURS * HOUR;

	const rows = await Array.fromAsync(
		RenderSchedule.search(
			{
				conditions: [{ attribute: 'nextRenderTime', comparator: 'less_than_equal', value: horizon }],
				sort: { attribute: 'nextRenderTime' },
				select: ['nextRenderTime'],
				limit: cap,
			},
			{ replicateFrom: false }
		)
	);

	const buckets = Array.from({ length: HISTOGRAM_HOURS }, (_, hour) => ({
		hour,
		startMs: now + hour * HOUR,
		count: 0,
	}));

	let overdue = 0;

	for (const row of rows) {
		const at = Number(row.nextRenderTime);
		if (!Number.isFinite(at)) continue;
		if (at <= now) {
			overdue++;
			continue;
		}
		const hour = Math.floor((at - now) / HOUR);
		if (hour >= 0 && hour < HISTOGRAM_HOURS) buckets[hour].count++;
	}

	return {
		overdue,
		buckets,
		scanned: rows.length,
		cap,
		truncated: rows.length >= cap,
		horizonMs: horizon,
	};
}

// getRecordCount is time-bounded and falls back to sampling on a large table, so it
// reports `estimatedRange` when the number is an estimate. Surfaced as-is: an estimate
// labelled as one beats an exact number nobody can afford to compute.
async function countTable(table) {
	try {
		const { recordCount, estimatedRange } = await table.getRecordCount();
		return { recordCount, estimatedRange: estimatedRange ?? null };
	} catch (e) {
		logger.error(e);
		return { recordCount: null, error: 'unavailable' };
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

		// The page itself carries no data — it renders a login form and fetches everything
		// through the gated routes below.
		if (route === '') return html(renderAdminPage());

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
				return PrerenderAdmin.explain(data);
			case 'queue':
				return PrerenderAdmin.setQueuePause(data, context);
			default:
				return json({ error: `Unknown route: ${route}` }, 404);
		}
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
		const cap = Math.max(1, config.management.scanCap | 0);

		const [{ nodes, cluster, knownScopes }, upcoming, targets, pages, sitemaps, nonIndexable] = await Promise.all([
			buildNodeList(now),
			scanUpcoming(now, cap),
			countTable(RenderTarget),
			countTable(PrerenderedPage),
			countTable(Sitemap),
			countTable(NonIndexable),
		]);

		return {
			generatedAt: now,
			node: server.hostname,
			workerIndex: server.workerIndex,
			// The flag `claim` actually reads on THIS node — the observed state, as opposed to
			// the replicated intent below.
			localQueueStatus: QueueState.status,
			control: { cluster, knownScopes },
			nodes,
			counts: { targets, pages, sitemaps, nonIndexable },
			backlog: {
				overdue: upcoming.overdue,
				truncated: upcoming.truncated,
				cap: upcoming.cap,
				scanned: upcoming.scanned,
			},
			histogram: {
				buckets: upcoming.buckets,
				horizonMs: upcoming.horizonMs,
				truncated: upcoming.truncated,
			},
			intervals: {
				statusSyncInterval: config.queue.statusSyncInterval,
				jobLeaseTime: config.queue.jobLeaseTime,
				defaultRenderInterval: config.render.defaultInterval,
			},
		};
	}

	static async explain(data) {
		const rawUrl = data?.url;
		if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
			return json({ error: 'url is required' }, 400);
		}

		let explanation;
		try {
			explanation = explainCacheKey(rawUrl.trim(), data?.deviceType);
		} catch (e) {
			return json({ error: `Not a valid absolute URL: ${e.message}` }, 400);
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
		// selected — this is a status view, and a cached page can be megabytes.
		const [target, schedule, page, suppressed] = await Promise.all([
			readWithTimeout('renderTarget', timedOutReads, () =>
				RenderTarget.get({
					id: cacheKey,
					select: ['cacheKey', 'url', 'deviceType', 'sitemapUrl', 'schedulerNode', 'renderInterval'],
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
			// Array select, like the three above: a string select would return the bare url
			// string instead of a record. Only existence matters here, so a scalar would still
			// have worked — but keeping the projection uniform avoids the next reader assuming
			// a record and reaching for `.url` on a string.
			readWithTimeout('nonIndexable', timedOutReads, () => NonIndexable.get({ id: canonicalUrl, select: ['url'] })),
		]);

		const now = Date.now();
		const expiresAtMs = page?.expiresAt ? new Date(page.expiresAt).getTime() : NaN;
		// Same freshness rule the serving path applies, so this cannot disagree with what a
		// bot would actually get.
		const fresh = !isNaN(expiresAtMs) && expiresAtMs + config.page.swrTtl > now;

		return json({
			...explanation,
			rows: {
				renderTarget: target ?? null,
				renderSchedule: schedule
					? {
							...schedule,
							nextRenderTime: Number(schedule.nextRenderTime),
							dueInMs: Number(schedule.nextRenderTime) - now,
							overdue: Number(schedule.nextRenderTime) <= now,
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
				nonIndexable: suppressed ? { url: suppressed.url ?? explanation.resolved.canonicalUrl } : null,
			},
			verdict: {
				// What a bot request for this URL would get right now.
				wouldServe: fresh ? 'cache' : 'origin-or-render',
				// Only meaningful when the schedule read was authoritative — see `residency`.
				scheduled: !!schedule,
				recurring: !!target,
				// A NonIndexable row blocks re-discovery for the table's expiration window, so
				// a URL can be absent from rotation with no target and no obvious reason why.
				suppressedByNonIndexable: !!suppressed,
			},
			residency: {
				queriedNode: server.hostname,
				// RenderSchedule rows are pinned to the node that owns the URL, and this endpoint
				// reads node-locally to avoid a cross-node fetch. On any other node the row is
				// expected to be absent, so `scheduled: false` there means "not scheduled HERE",
				// not "not scheduled".
				scheduleOwnedBy,
				scheduleReadIsAuthoritative,
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
}
