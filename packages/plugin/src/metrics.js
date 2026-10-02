/**
 * THE METRIC CATALOG — every number this plugin emits through `server.recordAnalytics`, its
 * dimensions, and what a dashboard is supposed to do with it, in one place.
 *
 * WHY A CATALOG AND NOT JUST CALL SITES. `recordAnalytics(value, metric, path, method, type)`
 * has exactly three dimension slots and they are POSITIONAL: `bot_serve`'s `path` is the serve
 * source while `route_serve`'s `path` is the route label. That order is the contract every
 * dashboard query keys on, and it used to exist only as an argument list buried in whichever
 * module happened to emit it, with the semantics in a comment above it. Anyone building a panel
 * had to grep for `recordAnalytics(` across six modules and reverse-engineer the slots. So the
 * names and the slot order are declared ONCE here, next to their descriptions, and every emit
 * site goes through the small functions at the bottom of this file. `METRICS` is what
 * `GET /prerender_admin/metrics` serves and what `METRICS.md` documents, which is why a
 * running node can describe its own metric surface instead of a reader guessing at the
 * plugin version's.
 *
 * The same shape as `configSchema.js`, and for the same reason: a machine-readable contract
 * beats prose that drifts.
 *
 * WHAT HARPER ANALYTICS ACTUALLY DOES with an emit (harper-pro
 * `core/resources/analytics/write.ts` + `read.ts` — every cost statement below is read off that
 * pipeline, not assumed):
 *
 * THE WRITE PATH, stage by stage:
 *
 *   1. `recordAnalytics(value, metric, path, method, type)` appends into a PER-THREAD Map keyed
 *      by the full combo string `metric-path-method-type`. A boolean (counter) is two integer
 *      adds; a number (value/distribution) is a `Float32Array` append (~7 significant digits).
 *      No storage touch, no await — this is what makes per-request emits affordable.
 *   2. ~1 SECOND later (`analyticsDelay`, armed by the first emit) the thread flushes: each
 *      value-combo's samples are SORTED and compressed to a ~10-point percentile distribution,
 *      with an event-loop yield between combos because the sorts are the expensive part. This is
 *      the real cost a per-request VALUE metric adds to a traffic-serving worker — a counter
 *      skips it entirely. Value metrics on hot paths must earn the distribution; a counter that
 *      would do the job should be a counter.
 *   3. The whole thread report — every combo, one message — lands on the main thread as ONE row
 *      in `hdb_raw_analytics` (retention: 1 hour). Raw row COUNT is per thread-second and does
 *      not depend on how many metric NAMES exist; row SIZE is the active combo count.
 *   4. Every `analytics.aggregatePeriod` (default 60 s) the MAIN thread re-merges raw rows by
 *      the same combo key — count-weighted means, distribution merges, another sort per
 *      value-combo — and writes ONE `hdb_analytics` row PER ACTIVE COMBO PER PERIOD. Default
 *      retention is ONE YEAR (`analytics.aggregateRetentionMs`, Harper ≥ 5.2.0) — far longer
 *      than anything here gets charted; deployments should set it to ~90 days (see METRICS.md).
 *      Aggregation happens on the main thread, so combo cardinality is main-thread CPU every
 *      half-period, for as long as the rows are retained.
 *
 *   So the durable write cost of a signal is its ACTIVE COMBO COUNT (rows/period/node + that
 *   main-thread merge), and the hot-path cost is counter-vs-value. The metric NAME is free on
 *   the write side: merging or splitting names moves the same combos around.
 *
 * THE READ PATH — where names are NOT free:
 *
 *   `hdb_analytics` deliberately indexes nothing but its primary key (the writes go through
 *   `primaryStore.put`, which bypasses `updateIndices` — a `metric` index would stay permanently
 *   empty). `get_analytics(metric, start_time)` therefore scans the PK time window across ALL
 *   metrics' rows and filters by name: a dashboard sweeping N names re-reads the same window N
 *   times, while every combo of ONE name comes back in a single scan. A METRIC NAME IS A SCAN;
 *   A SERIES IS A ROW.
 *
 *   Rows are per node (fan out and SUM; a per-node number is a quarter of a 4-node cluster's
 *   answer; recombine means count-weighted, treat merged p95s as approximate) and per thread
 *   before aggregation. An unused dimension slot is absent-or-null — never group by it.
 *
 * NAMING RULE that falls out of the two paths: PREFER A SERIES ON AN EXISTING NAME over a new
 * name for any low-volume signal (`queue_health` and `prerender_ops` are the two umbrellas);
 * spend a new name only on a metric that needs its own dimension slots and earns its scan
 * (`bot_serve`, `render_outcome`, `origin_fetch`). Adding a series to a released name is
 * non-breaking; renaming a released name breaks every consumer.
 *
 * COST DISCIPLINE. Dimension values must have SMALL, BOUNDED cardinality: each distinct
 * combination is an `hdb_analytics` row per node per period for a year, plus main-thread merge
 * work. Bot names come from the registry, device types are sanitized, route labels are the
 * configured route paths, cache statuses and outcomes are closed sets. A URL, a cache key, or
 * an un-bucketed path must never become a dimension value — see `util/unrouted.js` for what to
 * do instead when the value space is genuinely unbounded.
 */

/**
 * One catalog entry. `dimensions` is keyed by the recordAnalytics slot it occupies, so the
 * positional contract is legible without reading the emitter.
 */
const metric = (name, spec) => Object.freeze({ name, ...spec });

const CACHE_STATUSES = Object.freeze([
	'hit', // within the page's renderInterval
	'swr', // inside the stale-while-revalidate window (still a cache serve)
	'stale', // past the SWR window — not served, we went elsewhere
	'invalidated', // a bulk invalidation cost us a serve we would otherwise have made
	'miss', // nothing cached under this key
	'skip', // the cache was deliberately not consulted (renderNow / Cache-Control)
	'bypass', // not a cacheable request at all (non-GET/HEAD, or a URL too long to be a table key)
	// A stored ORIGIN document answered it (`render.raw`). A cache serve, and it counts toward
	// offload — but NOT a prerendered one: no browser ran on it. Its own value so that "cache
	// served" and "rendered coverage" stay different questions, and so `page_age` can exclude it.
	'raw',
	// A servable record whose blob body could not be read, so we served origin instead. Its own
	// status rather than folding into 'miss': the key IS cached and correctly scheduled, and the
	// two have different fixes — 'miss' means coverage, this means blob integrity (harper#2134).
	// Should sit at ~0; a rising share is dangling blob references, not a caching problem.
	'blob-missing',
	// The body was still being READ when `page.blobReadBudgetMs` ran out, so we served origin rather
	// than let the crawler wait. Split from 'blob-missing' because the cause and the fix differ: the
	// bytes are arriving (a base copy is streaming that blob — harper-pro#683), just not in time.
	// A rising share tracks replication churn, not dangling references.
	'blob-timeout',
	// A local blob failure ANSWERED FROM THE RESIDENCY OWNER'S COPY (peerRescue) — still a cache
	// serve (source stays 'cache', so offload accounting is right), but its own status rather than
	// the freshness verdict, because the rescue rate is what an operator trends against replication
	// churn and it must not inflate 'hit'. The local fault is counted separately by `serve_error`
	// (blob-timeout / blob-unreadable), which fires whether or not the rescue lands; blob-timeout /
	// blob-missing here now mean the rescue ALSO missed and the request went to origin.
	'peer-rescue',
	// A page that an invalidation WOULD have refused, served because the change probe proved its
	// claims still match the origin (`util/pageVerification.js`). Its own status, never folded into
	// 'hit': this is the number that answers "what is per-page verification buying", and it must be
	// separable from an ordinary hit both ways round — an operator has to be able to see, at a
	// glance, how much content is being served on evidence rather than on age.
	'verified',
	// The origin's own STORED 404/410 answered it (`render.negative`), inside its fresh window: the origin
	// was not asked. Source `negative`, so offload counts it as spared — and not a hit: nothing was
	// cached that anyone could render, and it must never read as coverage.
	'negative',
	// A stored 404/410 answered it AT ONCE while THIS request's background re-check went to the origin.
	// Source `origin`, deliberately: the crawler did not wait, but the origin did the work, and offload
	// is about the origin. One per `origin_fetch` reason `revalidate`.
	'negative-revalidate',
	// A true miss answered from ANOTHER URL's render: the cached page of the entity's canonical, served at a
	// spelling with no page or target of its own (`ingress.routes[].entityServe`, util/entityServe.js).
	// Source `entity`. A cache serve of a rendered snapshot, so it counts toward offload and `page_age` —
	// but its own value, never 'hit': it is coverage by inference (one render answering many URLs), and how
	// much of a route's traffic is answered that way must stay readable on its own.
	'entity',
]);

const SERVE_SOURCES = Object.freeze([
	'cache', // a stored snapshot answered it
	'rendered', // an on-demand render landed inside the renderNow timeout
	'origin', // proxied live to the origin — the request the offload number counts against
	'raw', // a stored origin document (render.raw) — saved the round trip, but nothing rendered it
	'negative', // the origin's stored 404/410 (render.negative), inside its fresh window — the origin was not asked
	'entity', // the cached render of the entity's canonical, served at another spelling (ingress.routes[].entityServe)
]);

const DEVICE_TYPES = Object.freeze(['desktop', 'mobile', 'tablet']);

// WHY a bot request missed (bot_miss.path). Exactly one per request bot_serve counts as origin|miss.
const MISS_CAUSES = Object.freeze([
	'passthrough', // the route is not prerendered here, by configuration — never cached
	'not-found', // the origin answered 404 or 410: there is no page to render
	'not-modified', // the origin answered 304 to the crawler's conditional GET: real page, we hold none
	'redirect', // the origin answered 3xx (other than 304)
	'client-error', // any other 4xx
	'origin-error', // 5xx, or no status at all (a fetch that failed outright throws before this and is counted by neither)
	'uncacheable', // a 2xx that is not a prerender candidate (non-200, or its headers said not to cache)
	'gated-route', // a 200 on a route that does not add targets from traffic (ingress.routes[].discoverTargets)
	'gated-bot', // a 200 from a bot not allowed to add targets (ingress.discoveryBots)
	'gated-entity', // a 200 with no target, whose entity already has one in rotation (ingress.entityGate)
	'new', // a 200 with no target: this request minted one, first render jittered across the interval
	'render-timeout', // an on-demand render (renderNow) did not land in time; the fallback answered
	'unrendered', // a target in rotation with no page for this device yet — waiting for its render
	'device', // a target in rotation, but this device is not one it renders by default (deviceTypes.default) — config, not capacity
	'suppressed', // a target the render verdict suppressed (noindex, canonical elsewhere, error)
	'error', // the Target read or the mint failed
]);

/**
 * The catalog, keyed by metric name. Ordered as an operator reads them: what arrived, what we
 * served it from, how fresh it was, then the machinery behind that.
 */
export const METRICS = Object.freeze({
	bot_request: metric('bot_request', {
		kind: 'counter',
		emittedBy: 'http_handlers/bot_request.js',
		cadence: 'once per bot request, at ingress',
		summary: 'Raw bot traffic arriving at the plugin, before anything is resolved.',
		usefulFor:
			'Crawl volume and its mix: which bots, which device types, which host. The DENOMINATOR ' +
			'for every serve-side ratio — pair it with bot_serve rather than reading either alone.',
		gatedBy: 'analytics.enabled (and analytics.recordUnmatched for UA-less requests, recorded as bot “other”)',
		dimensions: {
			path: { name: 'host', description: 'Request hostname (the forwarded host in forwarded mode).' },
			method: {
				name: 'botName',
				description:
					"Registry display name, a derived name for a self-identifying unregistered crawler, else 'other' " +
					'(see analytics.bots / analytics.deriveUnknownBots).',
			},
			type: { name: 'deviceType', values: DEVICE_TYPES, description: 'Sanitized device type from the ingress header.' },
		},
	}),

	bot_serve: metric('bot_serve', {
		kind: 'counter',
		emittedBy: 'http_handlers/bot_request.js',
		cadence: 'once per bot request, after the request resolved to a resource',
		summary: 'What actually answered the request: from where, in what freshness state, for which bot.',
		usefulFor:
			'The two rollout numbers. ORIGIN OFFLOAD = share of rows where path !== "origin" (requests the ' +
			'origin never saw). CACHE HIT RATE = share by method: cache-served is hit + swr, while hit alone ' +
			'is the freshness signal ("is the configured TTL being met"). A rising "miss" share is a coverage ' +
			'problem; a rising "swr" share is a cadence problem.',
		gatedBy: 'analytics.enabled (same gate as bot_request)',
		dimensions: {
			path: { name: 'source', values: SERVE_SOURCES, description: 'Where the served bytes came from.' },
			method: { name: 'cacheStatus', values: CACHE_STATUSES, description: 'Freshness verdict for the cache key.' },
			type: { name: 'botName', description: 'As bot_request.method — so offload can be read per bot.' },
		},
	}),

	route_serve: metric('route_serve', {
		kind: 'counter',
		emittedBy: 'http_handlers/bot_request.js',
		cadence: 'once per bot request, beside bot_serve',
		summary: 'The same serve outcome, split by matched route instead of by bot.',
		usefulFor:
			"Tuning one route's renderInterval without touching the others: the swr/stale share per route says " +
			'whether that cadence is being DELIVERED, and the miss share says whether the route’s corpus is even ' +
			'covered. Exists as its own metric only because bot_serve has no fourth slot to carry the route.',
		gatedBy: 'analytics.enabled',
		dimensions: {
			path: {
				name: 'route',
				description:
					"Matched route's configured path ('/', '/catalog/', '/product/prd-'), else the route class for a " +
					"passthrough/unclassified request, else 'unrouted'. Small, stable cardinality by construction.",
			},
			method: { name: 'cacheStatus', values: CACHE_STATUSES, description: 'As bot_serve.method.' },
			type: { name: 'deviceType', values: DEVICE_TYPES, description: 'Sanitized device type.' },
		},
	}),

	bot_miss: metric('bot_miss', {
		kind: 'counter',
		emittedBy: 'http_handlers/bot_request.js',
		cadence:
			'once per bot request that bot_serve counts as origin|miss — at resolve time for most causes, after ' +
			'the detached Target read for new / unrendered / device / suppressed / gated-entity / error',
		summary: 'Why a request that missed the cache missed: the reason, the route, the bot.',
		usefulFor:
			'Sizing COVERAGE — which misses are dead URLs (not-found; not-modified is a real page the crawler already ' +
			'holds), which are held out by a rule or setting you ' +
			'chose (gated-route, gated-bot, gated-entity, passthrough, and device: a device outside ' +
			'deviceTypes.default, which the rotation never renders), and which are pages the rotation owns and has ' +
			'not rendered yet (new, unrendered, render-timeout). Only the last group is render capacity or order; ' +
			'the rest are decisions a render cannot change. Pair a cause with its distinct-URL count ' +
			'(GET /prerender_admin/crawl-breadth, `misses` per day and `missUnion` across the range): requests ' +
			'per distinct URL is how often a missed URL is asked for again, which is what a render of it would ' +
			'serve — a class of misses made of one-off URLs is not worth covering at any capacity.',
		gatedBy: 'analytics.enabled (same gate as bot_serve)',
		caveats:
			'Sums to bot_serve origin|miss for the same window, less the few whose detached read had not landed ' +
			'when the window closed. discovery_gated (prerender_ops) overlaps gated-route/gated-bot by design and ' +
			'predates this. A render-now that landed in time is not a miss (bot_serve source rendered); one that ' +
			'timed out and fell back to the origin is.',
		dimensions: {
			path: { name: 'cause', values: MISS_CAUSES, description: 'Why the cache had nothing to serve.' },
			method: { name: 'route', description: 'As route_serve.path.' },
			type: { name: 'botName', description: 'As bot_request.method.' },
		},
	}),

	page_age: metric('page_age', {
		kind: 'value',
		unit: 'ms',
		emittedBy: 'http_handlers/bot_request.js',
		cadence: 'per CACHE-SERVED bot request only',
		summary: 'Age of the snapshot a crawler was served — milliseconds since it rendered.',
		usefulFor:
			'Freshness as delivered, which is the number to compare against renderInterval (p95 above the ' +
			'interval means the fleet is not keeping up). Deliberately cache-serves only, so a render-now or ' +
			'origin proxy cannot drag the distribution toward zero and hide staleness.',
		gatedBy: 'analytics.enabled',
		dimensions: {
			path: { name: 'botName', description: 'As bot_request.method.' },
			method: { name: 'deviceType', values: DEVICE_TYPES, description: 'Sanitized device type.' },
			type: { name: null, description: 'Unused.' },
		},
	}),

	route_page_age: metric('route_page_age', {
		kind: 'value',
		unit: 'ms',
		emittedBy: 'http_handlers/bot_request.js',
		cadence: 'per cache-served bot request, beside page_age',
		summary: 'Served age split by route and freshness state.',
		usefulFor:
			"Per-route served age against that route's own renderInterval — the “should this TTL move” number. " +
			'Split by cacheStatus so hit-age and swr-age are separable: a healthy route has swr rows only in the tail.',
		gatedBy: 'analytics.enabled',
		dimensions: {
			path: { name: 'route', description: 'As route_serve.path.' },
			method: { name: 'cacheStatus', values: CACHE_STATUSES, description: 'As bot_serve.method.' },
			type: { name: 'deviceType', values: DEVICE_TYPES, description: 'Sanitized device type.' },
		},
	}),

	render: metric('render', {
		kind: 'value',
		emittedBy: 'resources/RenderQueue.js',
		cadence:
			'per render result posted back by a browser worker: one `outcome` row always (a result is one URL — ' +
			'every device variant in it — since v0.66.0), one `time_ms` sample per device variant the worker ' +
			'timed, and one `change_lag_ms` sample per URL whose render landed while its row carried a change mark',
		summary: 'The render fleet, in one scan: how long each render took, and what became of it.',
		usefulFor:
			'`time_ms` is fleet capacity (renders/hour/pod = concurrency ÷ time_ms) and what a settle-tuning ' +
			'change has to move. `outcome` is the render-failure alert — "renders are failing", "the corpus is ' +
			'being mass-suppressed", and "the renderer credential broke" were log-grep-only before it. One ' +
			'`outcome` emit per posted result, so outcomes sum to results processed and any share reads as a ' +
			'fraction of render throughput.',
		caveats:
			'auth-failure is special-cased on purpose: 401/403 never suppresses (it is almost never a statement ' +
			'about the page), so a spike there with a steady `suppressed` is the signature of a broken bypass ' +
			'token or an origin bot-mitigation change. `redirect` counts every redirect-shaped result; its type ' +
			'slot says how each was resolved. A source retired after repeated redirects appears as its final ' +
			'`temporary`/`unrouted-destination` emit — the retirement itself is in the log and the Target table.',
		dimensions: {
			path: {
				name: 'series',
				values: ['time_ms', 'outcome', 'change_lag_ms'],
				description:
					'time_ms = duration distribution (ms). outcome = counter of what became of the result. ' +
					'change_lag_ms (plugin v0.97.0) = TRIGGER TO CACHE: ms from the instant the origin was found ' +
					'changed (`changedAt` — the change probe, a gone reopen, a sitemap departure or rejoin) to the ' +
					'render that replaced the page landing, one sample per URL, emitted where that render clears the ' +
					'mark. Every millisecond of it the page was hard-expired and bots were served the origin; its p95 ' +
					'per route against the probe cadence is how fresh a detected change actually gets. A render that ' +
					'did not land (a failure, a render granted before the mark) emits nothing, so the lag keeps ' +
					'growing until one does.',
			},
			method: {
				name: 'statusCode (time_ms) / outcome (outcome) / route (change_lag_ms)',
				description:
					'time_ms: HTTP status the render observed — a NUMBER at the emit site (for a redirect bail, ' +
					'the FIRST hop’s 3xx). outcome: rendered | suppressed | auth-failure | transient | failed | ' +
					'redirect | superseded — rendered = usable result, suppressed = genuine non-indexable verdict ' +
					'(target moves to its recheck cadence), auth-failure = 401/403 kept and retried, transient = ' +
					'408/429/5xx kept and retried, failed = the render itself broke, redirect = the page moved or ' +
					'bounced, superseded = the result was dropped whole because a newer fact outranks it (plugin ' +
					'v0.97.0; see its detail). change_lag_ms: the route label, as route_serve.path (the matched ' +
					"route's path, else 'unrouted').",
			},
			type: {
				name: 'candidacy (time_ms) / detail (outcome) / unused (change_lag_ms)',
				values: [
					'candidate',
					'non-candidate',
					'unknown',
					'redirect',
					'stored',
					'discarded',
					'refiled',
					'no-content',
					'target-missing',
					'noindex',
					'canonical-mismatch',
					'http-error',
					'redirect-loop',
					'unspecified',
					'landed-auth',
					'landed-transient',
					'unrouted-destination',
					'unkeyable-destination',
					'non-indexable-destination',
					'temporary',
					'permanent',
					'navigation',
					'not-attempted',
					'unkeyable',
					'newer-lease',
					'changed-during-render',
				],
				description:
					'time_ms: candidate (was cached) | non-candidate (suppression verdict) | unknown (worker posted ' +
					'no isIndexable) | redirect (its own lane, so redirect bails do not read as fast renders). ' +
					'outcome: per-outcome refinement — rendered: stored / discarded (landed on a class we never ' +
					'serve, or on a URL too long to key) / refiled (client-side redirect onto another prerender ' +
					'key) / no-content (a legacy worker posted an indexable verdict with nothing to store) / ' +
					'target-missing (a recurring row whose ' +
					'URL has no Target on this node — page not stored, row deferred, see render.targetMissing); ' +
					'suppressed: the browser’s ' +
					'reason (noindex/canonical-mismatch/http-error/redirect-loop, else unspecified); auth-failure/' +
					'transient: the status code; failed: the error phase (navigation = the document never arrived; ' +
					'not-attempted = the worker was asked for this device and never started it — its lease ran short ' +
					'or it began draining — so the URL retries; unknown = pre-v1.16.0 worker posted no detail; unkeyable = ' +
					'plugin v0.97.3: the URL fits Harper\u2019s key limit but its page keys do not, so nothing can be ' +
					'stored and the target is retired — only a Target created before the bound was checked at entry); ' +
					'redirect: landed-auth/landed-transient ' +
					'(destination answered 401/403 / 5xx-shaped), unrouted-destination (route list has no home for ' +
					'it — a render is wasted every interval until fixed), unkeyable-destination (plugin v0.97.3: a ' +
					'permanent move to a URL too long to be a cache key — source retired, nothing adopted), ' +
					'non-indexable-destination (source retired, destination suppressed), temporary (kept, strike ' +
					'counted), permanent (source retired ' +
					'in favor of the destination); superseded: newer-lease (the render began before the key was ' +
					'leased to another renderer — a result that outlived its lease; nothing stored, and the newer ' +
					'lease is not released) / changed-during-render (its lease predates the row’s change mark, so ' +
					'it may show the content from before the change; nothing stored, the row stays due and marked ' +
					'and renders again at once).',
			},
		},
	}),

	render_size: metric('render_size', {
		kind: 'value',
		unit: 'bytes',
		emittedBy: 'resources/RenderQueue.js',
		cadence: 'one sample per device page a render result stored',
		summary: 'How big each stored page is DECODED — the HTML a crawler parses, not the bytes on the wire.',
		usefulFor:
			'Crawler size limits are on the decoded document (Bing’s soft limit is 1 MB), and a page’s size ' +
			'swings with its content (a product page with thousands of reviews is several times one with none). ' +
			'`count` per band over the route’s total is the exact share of its renders over each threshold — ' +
			'"share of product-page renders over 1 MB" is the rows with band 1m-2m or 2m-plus — and the values ' +
			'inside a band are its distribution.',
		caveats:
			'Measured for a gzip body (its trailer states the decoded length, so it costs nothing) and an ' +
			'unencoded one — the render fleet’s default and only configured encoding. A page stored in any ' +
			'other encoding emits NO sample rather than paying a decompression per render on the result path. ' +
			'Pages stored, not pages served: a page is counted once per render, however often it is served.',
		dimensions: {
			path: { name: 'route', description: 'As route_serve.path.' },
			method: { name: 'deviceType', values: DEVICE_TYPES, description: 'The stored page’s device.' },
			type: {
				name: 'band',
				values: ['under-500k', '500k-1m', '1m-2m', '2m-plus'],
				description:
					'Decoded size band, decimal units (1m = 1,000,000 bytes, the stricter reading of a "1 MB" limit): ' +
					'the three edges are the ones a size budget is judged against.',
			},
		},
	}),

	origin_fetch: metric('origin_fetch', {
		kind: 'value',
		unit: 'ms',
		emittedBy: 'util/upstream.js',
		cadence: 'once per origin proxy on the bot serve path (time to response headers; the body streams after)',
		summary: 'What a non-cache serve costs: origin latency and status, by why the origin was consulted.',
		usefulFor:
			'The cost of a miss, which offload alone hides: bot_serve says how often the origin answered, this ' +
			'says how slowly and with what. A rising `error`/5xx share here is origin trouble bots are feeling ' +
			'directly; `render-timeout` rows are renderNow falling back, i.e. the fleet not keeping up with ' +
			'on-demand requests.',
		dimensions: {
			path: {
				name: 'statusCode',
				description:
					'HTTP status the origin answered — a NUMBER at the emit site, like render_time. 0 = the fetch ' +
					'itself failed (connect/TLS/reset) before any status arrived.',
			},
			method: {
				name: 'reason',
				values: [
					'miss',
					'stale',
					'skip',
					'invalidated',
					'bypass',
					'key-too-long',
					'blob-missing',
					'blob-timeout',
					'render-timeout',
					'revalidate',
					'other',
				],
				description:
					'Why the origin was consulted: the cache status that led here (miss/stale/skip/invalidated), ' +
					'bypass (non-GET/HEAD), key-too-long (plugin v0.97.3: a URL whose cache key would exceed ' +
					'Harper’s primary-key limit, proxied uncached — bot_serve counts it as bypass), render-timeout ' +
					'(a renderNow render did not land in time and the origin was the fallback), or revalidate (a ' +
					'background re-check of a stored 404/410 past its ' +
					'fresh window, render.negative — one per bot_serve cacheStatus negative-revalidate). ' +
					"'other' is the emitter's default for a caller that passed no " +
					'reason — its presence is a bug in the caller, not a traffic category.',
			},
			type: { name: null, description: 'Unused (emitted as null).' },
		},
	}),

	render_readiness: metric('render_readiness', {
		kind: 'value',
		emittedBy: 'resources/RenderQueue.js',
		cadence: 'per device variant of a posted result that a readiness contract governed; nothing when none did',
		summary: 'What each page type\u2019s completeness contract said about the renders it governed.',
		usefulFor:
			'THE POINT OF CONTRACTS IS THAT AN INCOMPLETE RENDER BECOMES VISIBLE, and this is where it becomes ' +
			'visible. `verdict` is the share of renders that finished complete — a rising `unsatisfied` share is ' +
			'the fleet telling you it is storing pages that are missing something, which no other signal here ' +
			'can say (those renders are 200, non-empty and indexable). `unmet` names the CLAUSE, so a contract ' +
			'that has rotted against a template change shows up as one clause failing across every render of ' +
			'its page type instead of as a silent slowdown. `satisfied_ms` is how `timeoutMs` should be tuned: ' +
			'if its p95 approaches the configured timeout the contract is being abandoned under load and the ' +
			'optimisation is quietly gone.',
		caveats:
			'`unmet` emits once per failing clause, so it does NOT sum to renders — read it against the ' +
			'`unsatisfied` count in `verdict`. A clause that a guard decided did not apply is not unmet and is ' +
			'not counted; that distinction is the difference between "checked and failed" and "nothing to ' +
			'check". `shortfall` is a comparison against what this PAGE (URL + device) last produced, so it ' +
			'is silent on a first render and after a rebaseline, and a desktop and a mobile render of one URL ' +
			'never compare against each other.',
		gatedBy: 'a readiness contract matching the rendered URL (config.readiness)',
		dimensions: {
			path: {
				name: 'series',
				values: ['verdict', 'unmet', 'shortfall', 'rebaseline', 'satisfied_ms'],
				description:
					'verdict = counter of how the contract ended, EXACTLY ONE PER GOVERNED DEVICE VARIANT — a ' +
					'two-device job emits two — so shares read as fractions of rendered devices (`render.time_ms`), ' +
					'NOT of posted results (`render.outcome`). unmet = counter, one per clause that did not hold. ' +
					'shortfall = counter, one per observation that fell far below this URL\u2019s history. ' +
					'rebaseline = counter, one per page (URL + device) whose expectation was re-learned after ' +
					'repeated shortfalls — kept OUT of verdict so that series keeps summing to one per variant. ' +
					'satisfied_ms = distribution of how long the contract took to first hold.',
			},
			method: {
				name: 'contract',
				description: 'The contract\u2019s configured name — i.e. the page type, as the config defines it.',
			},
			type: {
				name: 'verdict (verdict) / clause (unmet) / observation (shortfall)',
				values: ['satisfied', 'unsatisfied'],
				description:
					'verdict: satisfied | unsatisfied. unmet/shortfall: the configured clause or observation ' +
					'name, so the enumeration above applies to the verdict series only. Null on rebaseline ' +
					'and satisfied_ms.',
			},
		},
	}),

	queue_health: metric('queue_health', {
		kind: 'value',
		emittedBy:
			'util/backlogSnapshot.js (snapshot gauges), util/reconcile.js (reconcile_*), ' +
			'util/queueKeeperService.js (keeper_*), resources/RenderQueue.js (claim_granted, claim_stale)',
		cadence:
			'snapshot gauges once per backlog snapshot per node (worker 0, management.backlogSnapshotInterval); ' +
			'reconcile_* once per sweep per node; keeper_load_ms once per keeper load, keeper_publish_ms once per ' +
			'keeper publish (worker 0, queue.keeper.publishInterval), keeper_verify_ms, keeper_repaired and ' +
			'keeper_unschedulable once per verification walk; claim_granted / claim_stale / claim_wedged per claim that had any',
		summary: 'Every queue signal under one name: backlog gauges, the queue keeper, schedule-gap repairs.',
		usefulFor:
			'The queue’s alertable surface, readable in ONE get_analytics scan (a metric name is a scan — see the ' +
			'module header). Backlog gauges say whether the queue is keeping up; keeper_repaired > 0 means the ' +
			'queue keeper missed writes; reconcile_restored > 0 means URLs were silently un-renderable until the ' +
			'sweep repaired them.',
		caveats:
			'MIXED CADENCES under one name: the snapshot series are slow gauges (chart the latest value, never a ' +
			'sum; one row per node — sum `overdue` across nodes), keeper_*_ms are per-event durations, ' +
			'reconcile_* are per-sweep totals, claim_* are per-claim counts.',
		dimensions: {
			path: {
				name: 'series',
				values: [
					'overdue',
					'lease_occupancy',
					'paused',
					'keeper_live',
					'claim_granted',
					'reconcile_restored',
					'reconcile_missing',
					'keeper_load_ms',
					'keeper_publish_ms',
					'keeper_repaired',
					'keeper_verify_ms',
					'keeper_unschedulable',
					'claim_stale',
					'claim_wedged',
				],
				description:
					'overdue = schedule rows already due, INCLUDING in-flight renders (so its healthy floor is the ' +
					'in-flight count, not zero), from the queue keeper; absent while it is not live. ' +
					'lease_occupancy = live claim leases on this node right now. ' +
					'paused = 1 when this node’s queue is paused at snapshot time, else 0 — makes "paused for hours" ' +
					'alertable without polling the REST surface. ' +
					'keeper_live = 1 when this node\u2019s queue keeper is live at snapshot time, else 0 — a node ' +
					'whose keeper is not live grants no claims. ' +
					'claim_granted = jobs granted per claim. ' +
					'reconcile_restored / reconcile_missing = schedule gaps repaired / found per sweep (they differ ' +
					'when the per-sweep restore cap truncates the pass); expect zero — a steady rate means ' +
					'something is CREATING gaps, and the reconcile log line names the URLs. ' +
					'keeper_load_ms = how long the queue keeper took to load this node\u2019s rows from the table ' +
					'(once per start or rebuild); the node grants no claims for that long. ' +
					'keeper_publish_ms = one ready-set publish from the keeper; expect single-digit ms, and a ' +
					'rising trend means the due set or the class count is growing. ' +
					'keeper_repaired = rows the keeper\u2019s verification walk found it held differently from the table ' +
					'(missing, wrong minute or class, or deleted) and repaired; expect 0, and treat a steady count as ' +
					'its subscription losing writes. ' +
					'keeper_verify_ms = one verification walk of the whole table (queue.keeper.verifyInterval). ' +
					'keeper_unschedulable = rows this node owns whose nextRenderTime is null or negative, found by a ' +
					'verification walk (emitted only when non-zero): the keeper cannot hold them and no claim can grant ' +
					'them, so those URLs never render until something re-files them. Not a repair, and not counted in ' +
					'keeper_repaired. ' +
					'claim_stale = ready-set entries a claim skipped because the durable row was no longer due ' +
					'(rendered, rescheduled or deleted after the keeper published it): renders the check saved. A ' +
					'steady trickle is normal; a large, sustained count means the keeper is seeing writes late. ' +
					'claim_wedged = keys a claim held back instead of granting (an exponential hold in the lease table, ' +
					'capped at the cadence) because their last leases all ended without moving the row — expired with no ' +
					'result, or (since v0.97.0) released by a result whose commit then failed: a renderer crashing on ' +
					'the URL, or, when many appear at once, results not reaching this node. The log names them.',
			},
			method: {
				name: 'source (claim_granted)',
				values: ['ready'],
				description:
					'claim_granted emits `ready` (every claim is served from the ready set). Every other series ' +
					'emits null here.',
			},
			type: { name: null, description: 'Unused (emitted as null).' },
		},
	}),

	prerender_ops: metric('prerender_ops', {
		kind: 'value',
		emittedBy:
			'util/unrouted.js, resources/Sitemap.js, http_handlers/response.js, util/backlogSnapshot.js, ' +
			'util/demandLadder.js, util/visitFilter.js, util/invalidation.js, util/invalidationReenqueue.js, http_handlers/bot_request.js, ' +
			'util/changeProbe.js, util/entityGate.js, util/entity.js, util/entityServe.js, util/negativeCache.js, util/goneReopen.js, resources/RenderQueue.js, ' +
			'util/renderSchedule.js (due_now_forward), util/serveCheck.js and util/pageCheck.js (serve_check)',
		cadence:
			'per report flush (unrouted), per finished sitemap run (sitemap_*), per delivery failure ' +
			'(serve_error, page_age_negative), per snapshot (config_warnings), per stats interval (the ladder\u2019s ' +
			'demand_*), per visit-ring re-union (demand_fill, demand_false_positive), ' +
			'per failed epoch read (invalidation_error), per heal attempt (invalidation_reenqueue), ' +
			'per probed batch of a probe pass (the probe_* pass counters, cycle_behind included — increments since ' +
			'the previous batch; before v0.97.0, once per finished pass), per gated cacheable miss (discovery_gated), ' +
			'per raw-document store attempt (raw_cache), per entity-gate evaluation (entity_gate), per entity-serve ' +
			'evaluation of a true miss (entity_serve), per observation of an entity\u2019s canonical (entity_canonical), ' +
			'per adoption decision (canonical_adopt), per ' +
			'negative-cache store, guard, re-check or dry-run verdict (negative_cache), per request that found a ' +
			'stored 404 (negative_gap), per reopen decision (gone_reopen), per suppressed target rendered (suppression_lifted ' +
			'or suppression_held), per "render this now" filing on a node that does not own the row (due_now_forward), ' +
			'per serve-time check decision (serve_check)',
		summary: 'Every low-volume operational signal, under one name so a sweep pays one scan for all of them.',
		usefulFor:
			'unrouted = requests served without prerendering, per path bucket: CDN over-forwarding vs. the ' +
			'coverage backlog (read `total`; the log line keeps the sample paths). sitemap_* = corpus churn and ' +
			'walk health; failed > 0 was log-only before. serve_error = a response that failed AFTER the 200 and ' +
			'the cache-hit row were committed — truncated bytes reaching a crawler while every serve metric says ' +
			'success; expect zero. config_warnings = current finding count; alert on change, not level (the ' +
			'findings are on GET /prerender_admin/config). page_age_negative = served pages discarded from ' +
			'page_age because their age computed negative (cross-node clock skew — the only evidence of it on ' +
			'the serve path; it also quietly undermines invalidation.pad’s sizing); expect zero. demand_* = the ' +
			'demand ladder’s guardrail: whether "promote the hot pages" is quietly becoming "halve every ' +
			'interval"; recorded during dry runs too — the histogram is how a dry-run week is judged. ' +
			'The guardrail is the POOLED ratio demand_fast / demand_graded, summed across workers and ' +
			'nodes and divided at query time — never a per-emitter ratio (see caveats). demand_graded ' +
			'counts only decisions the ladder actually made (promoted + demoted + held); routes with no ' +
			'rung faster than their own cadence (demand_single_rung) and cold-filter holds ' +
			'(demand_skipped_cold) are not ladder outcomes and would otherwise make it a readout of the ' +
			'route mix. demand_promoted_fast is the movement counter — budget being reallocated onto fast ' +
			'rungs right now, zero once the distribution settles. demand_fill and demand_false_positive are the ' +
			'demand TRACKER\u2019s sizing gauges (demand.*), emitted whenever the ring is re-unioned: ' +
			'demand_false_positive is the worst full slot\u2019s fill^k, the number demand.maxFalsePositive ' +
			'holds the newer consumers to. ' +
			'invalidation_error = an active invalidation is NOT being enforced on the requests that failed ' +
			'(the serve path falls back per-worker, so these are invisible in serve metrics); expect zero, ' +
			'`lkg-expired` is the serious kind. invalidation_reenqueue = every demand-driven heal attempt with ' +
			'its outcome — `lowered` is work accepted, everything else is a refusal with its reason; the feature ' +
			'is off by default, so no rows means disabled. ' +
			'probe_* = the change probe, sweep and canary alike, emitted per probed batch as increments (so a ' +
			'pass that throws or is cut short has reported everything up to its last batch, and a long pass is ' +
			'not one row a lost analytics window can drop whole): probed = attempts, of which ' +
			'seeded (first observation stored) + changed + failed, the remainder unchanged; triggered = changes ' +
			'acted on (page hard-expired, render filed ahead of rotation): every change the page has not ' +
			'caught up with, and every page mismatch on an unchanged signature, is acted on unless the pass is a ' +
			'dry run — nothing is deferred; errors = actions that threw (each is retried once when the walk ends — ' +
			'the pass record has retried/recovered/unacted — and a change still unacted is found again on its next ' +
			'probe; expect zero); caught_up = changes the cached page already showed (a mapped pageCheck field ' +
			'agreed with the new value, or every page of it was re-rendered after an active invalidation\u2019s trip and ' +
			'shows the change), baseline moved, nothing triggered — they overlay changed; covered = changes an active ' +
			'invalidation already answers (every page refused, or served on a page verification): not counted ' +
			'changed, not acted on, baseline kept, re-counted each pass until the page re-renders; ignored = changes ' +
			'confined to pageCheck.ignoreChanges slots, not counted as changed; probe_anchor = one emit per ' +
			'anchor in anchored mode, detail = what became of it: on_time, interrupted (a dry-run or reseed pass ' +
			'was asked to stand down first), chained (it waited for a pass that acts), caught_up (the process was ' +
			'down when it came; run at boot), skipped (served by a later anchor’s pass, or abandoned by a ' +
			're-arm) — anything but on_time is logged, and a skipped is a night whose pass started late; ' +
			'probe_detection_lag = a duration (ms) per origin change a SWEEP detects, two upper bounds on how long ' +
			'the change went unseen (no per-URL "last seen unchanged" is stored, so the lag itself cannot be ' +
			'measured): detail pass = since the start of the pass that found it (for an anchored pass, since the ' +
			'anchor — the lag itself for a change that landed on schedule), detail previous_pass = since the ' +
			'start of the pass before (a true bound when that pass covered the URL); context = the rule label. ' +
			'Read percentiles, never the total; probe_render_mismatch = the render check (changeProbe.renderCheck): ' +
			'a render that landed disagreeing with the probe’s last observation of the origin, detail = rechecked ' +
			'(one confirming origin request made — count these as origin calls), then confirmed (the origin still ' +
			'disagreed with the page: hard-expired and re-filed as a change), cleared (the origin had moved and ' +
			'the page shows it: baseline updated, nothing expired), recheck_failed or recheck_inconclusive; or, with ' +
			'no request, bounded (already confirmed once against that observation — a page that disagrees every ' +
			'time; left to the pass), untrusted (the origin is known to have moved since the probe last looked, so ' +
			'the render may just be newer — left to the pass), shed (no slot within a minute in the budget a running sweep leaves), ' +
			'dry_run, error. confirmed is stale renders caught before they served a pass-length; a steady bounded ' +
			'is pages the endpoint and the page genuinely disagree on; ' +
			'probe_changed / probe_probed is the measured change rate a dry-run week reports, and a rising ' +
			'probe_failed share is the endpoint-changed-shape alarm. probe_canary_trip counts mass-change ' +
			'verdicts; probe_invalidated counts the bulk invalidations the canary actually recorded (a trip ' +
			'without a matching invalidated emit was dry-run, holdoff, or a mis-configured scope — the log ' +
			'line says which). ' +
			'discovery_gated = cacheable misses whose target creation the discovery gate refused, split by ' +
			'which gate (route flag vs bot allowlist) and by bot. This is gated MISSES, not denied mints — ' +
			'a miss on an already-known target counts too, and so does a stale page\u2019s origin refetch (the gate ' +
			'sees the origin 200, not the cache verdict; bot_miss counts true misses only) — so read it as "traffic on URLs held out of the ' +
			'render rotation", the corpus growth the gate is preventing. The `entity` gate is the exception ' +
			'in scope, not in meaning: it is evaluated only for a URL with NO target row, so its count is ' +
			'refused mints, and it is emitted only when the gate is ARMED (a dry run records would-gate on ' +
			'entity_gate instead, never here). ' +
			'entity_gate = one emit per evaluation of the entity discovery gate (ingress.entityGate, per-route ' +
			'entityPrefix), split by outcome: gated (a sibling URL of the same entity is in rotation; not minted — ' +
			'also counted as discovery_gated/entity), would-gate (the same verdict under dryRun; minted anyway), ' +
			'suppressed-only (every sibling is suppressed; minted — a re-slug\u2019s new URL), no-siblings (a new ' +
			'entity; minted), no-prefix (the route has an entityPrefix and this URL produced no usable match; ' +
			'minted), error (the sibling read threw; minted). The outcomes sum to the mints the gate looked at. ' +
			'THE DRY-RUN NUMBER is would-gate: the renders (and origin document fetches) arming the gate would ' +
			'save, to read against render/outcome suppressed/canonical-mismatch. A route whose evaluations are ' +
			'nearly all no-prefix has a pattern that does not match its URLs. ' +
			'entity_serve = one emit per true miss on a route with ingress.routes[].entityServe, split by what ' +
			'the entity serve decided (util/entityServe.js): served (answered from the canonical’s render — ' +
			'also bot_serve source entity), would-serve (every guard passed under ingress.entityServe.dryRun; the ' +
			'miss path answered it — THE DRY-RUN NUMBER), or the guard that fell through: has-query (the spelling ' +
			'carries a query string), has-target (the spelling has a row of its own that the render path keeps — in ' +
			'rotation, or suppressed for a reason about the URL itself; one suppressed as a canonical verdict is ' +
			'answered — with the entity gate in dry run, every spelling a minting crawler asks for again lands ' +
			'here), no-sibling, no-page, not-indexable, stale, invalidated, ambiguous (two servable pages the ' +
			'registry does not choose between, or more rows than the read covers), unconfirmed (the canonical was ' +
			'neither rendered nor checked-and-agreed since the anchor — the probe and the serve-time check fill ' +
			'this in; a route stuck here has no rule that maps `canonical`), moved (the entity registry heard the ' +
			'origin name another canonical after the page was last confirmed: a re-slug it predates), ' +
			'not-self-canonical, unreadable, no-prefix, error. ' +
			'served_wrong = one emit per cached copy found to differ from the origin while it was being served ' +
			'(a 200 page, a raw document or a stored 404), at the moment a detector found it — never per serve, so ' +
			'it costs nothing on the request path. The value is an UPPER BOUND on how long that copy was served ' +
			'wrong: ms since it was last known right (its render, or the last check that agreed with this very ' +
			'copy; for a 404 its last confirmation). detail = the detector: check / check-raw (a serve-time check), ' +
			'sweep (the nightly pass; not the canary), render-check (a render that landed wrong), negative-recheck / ' +
			'negative-fetch (a stored 404 the origin answers 200 for); context = what disagreed: the pageCheck field ' +
			'label, claim (the price/availability pair), or 404. The count is how many wrong copies were found; the ' +
			'percentiles are how long they were out there. How many serves each one made is not counted: that needs ' +
			'a per-key serve counter, which the plugin deliberately does not keep. ' +
			'entity_serve_ms = milliseconds one entity-serve evaluation took, every outcome: what an opted-in ' +
			'route adds to a miss before the miss path runs. ' +
			'entity_canonical = one emit per observation of an entity\u2019s canonical (entities.enabled, ' +
			'util/entity.js), by what it did to the registry: new (the entity\u2019s first row), moved (the canonical ' +
			'changed — a re-slug, or one observation correcting another), same (nothing written), older (a ' +
			'disagreeing observation made before the stored one, ignored), foreign (a canonical under another ' +
			'entity\u2019s prefix, or carrying a query string, ignored), untracked (a crawler\u2019s proxied miss of an ' +
			'entity with no row: no row is created from crawler traffic), unreadable, error; context = the observer: ' +
			'probe (the change probe\u2019s ' +
			'mapped canonical), render (a stored page\u2019s canonical, or the one a canonical verdict declared), ' +
			'check (a serve-time check\u2019s endpoint or document) or origin (a proxied origin document on an ' +
			'entityServe route). moved per day is the re-slug rate; which observer moves it first says how fast a ' +
			're-slug is seen. A steady stream of moved alternating between probe and render means the endpoint ' +
			'and the page disagree about the canonical. ' +
			'canonical_adopt = one emit per adoption decision (entities.adopt), made only when an observation names ' +
			'a canonical that is ANOTHER URL than the one observed: adopted (a target ' +
			'filed due now), reactivated (a canonical-verdict suppression lifted, due now), would-adopt (either, in ' +
			'a dry run — THE DRY-RUN NUMBER), exists (the canonical has a target in rotation — every duplicate ' +
			'spelling, nightly), suppressed (its target is suppressed for a reason the origin\u2019s word does not overturn), ' +
			'recent (the entity was adopted, or in a dry run would have been, within retryAfter), capped (past maxPerHour ' +
			'on this node), refused (unkeyable, off the domain allowlist, or not on a prerender route), error; context = ' +
			'the observer that named it. ' +
			'raw_cache = one emit per raw-document store attempt, split by outcome: `stored`, `stored-unshared`, ' +
			'or the reason it was refused (not-200, staging, has-cookie, content-type, no-store, no-body, ' +
			'oversize, capture-failed, write-failed, vary-device). READ THE REFUSALS, not the successes — a route that is ' +
			'enabled and filling nothing is indistinguishable from one that is switched off unless the reason is ' +
			'recorded. oversize climbing means render.raw.maxBytes is below the route’s real document size; ' +
			'has-cookie climbing means the origin is personalizing a route that was assumed to be shared, which ' +
			'is the one outcome worth an alert. Under render.raw.assumeShared those documents are STORED and ' +
			'counted as stored-unshared instead, and that series is a CENSUS, not an alarm: on an origin that ' +
			'sets a cookie on every response it is pinned at 100% from the first minute and cannot rise, so no ' +
			'threshold on it detects anything. What still detects personalization is re-running the body diff ' +
			'the option documents. Read stored + stored-unshared as the store rate. vary-device is refused only ' +
			'under render.raw.deviceIndependent: the origin named User-Agent or a client hint in Vary, i.e. ' +
			'declared the document adaptive — any count means that option is wrong for this origin. ' +
			'negative_cache = the negative cache (render.negative), one emit per event. Stores read like raw_cache ' +
			'(stored + stored-unshared is the store rate; the refusals say why a route fills nothing). On read, ' +
			'guarded-listed / guarded-target are stored 404s a Target overruled (the entry is dropped), bot-excluded ' +
			'are requests from render.negative.excludeBots that found one. The re-checks are the recovery signal: ' +
			'recheck-live counts stored 404s the origin now answers 200 for — each one dropped and its gone target ' +
			'reopened — and recheck-busy is the per-worker cap shedding checks. IN A DRY RUN, would-serve is exactly ' +
			'the origin requests arming would save, and would-serve-live is the risk: requests an armed cache would ' +
			'have answered with a 404 while the origin, asked anyway, answered 200. Expect it near zero before arming. ' +
			'negative_gap = milliseconds since the origin last confirmed a stored 404, sampled on every request that ' +
			'found one: its distribution is the curve to choose render.negative.freshMs from (savings step at the ' +
			"crawlers' re-ask period). gone_reopen = a proxied origin 200 for a gone-suppressed target: filed (its " +
			'recheck due now), would-file (dry run), deduped, capped; the render verdict then decides, and ' +
			'suppression_lifted is where a reopen that worked shows up. suppression_lifted = one emit per suppression ' +
			'a render lifted, with the reason and how long it had held — the only measure of how often a verdict ' +
			'turns out to have been temporary. suppression_held = the other half: a suppressed target rendered and ' +
			'the verdict stood (re-suppressed with another strike, or deleted at the ceiling). Read the two ' +
			'together by age: a gone target’s own recheck lands in 14d+ (render.suppression.gone.recheckInterval), ' +
			'so http-gone in the younger buckets is an EARLY recheck — a reopen, an arrival or an operator ' +
			'revalidate — and lifted / (lifted + held) there is how often the evidence that filed it was right. ' +
			'probe_fresh = probes SKIPPED because the URL’s baseline was written since the pass (or the pass it ' +
			'resumes) began, i.e. this pass already probed it — the overlap a resume re-walks; from v0.97.0 it ' +
			'is near zero in a settled pass (before, it skipped any baseline younger than reprobeAfter, which ' +
			'meant every recent CHANGE). probe_throttled = probes the origin refused ' +
			'with pushback (429/502/503/504/timeout), which is what drives the sweep to halve its rate: ' +
			'ALERT ON THIS — it is the only signal that the probe is loading an origin that cannot take it. ' +
			'due_now_forward = a render-now, revalidate, rejoin or probe filing made on a node that does not own the ' +
			'row (queue.dueNowForward): forwarded (the owner filed it, keeping an earlier due time and a change ' +
			'mark), fell-back (the owner could not be asked or refused, so it was filed here as before 0.97.0 — ' +
			'which can demote the owner’s row), timed-out (the owner did not answer in time and the ask carried ' +
			'no change mark: left to the owner, not written here — see queue.dueNowForward), skipped (that owner ' +
			'failed within the last 30s; filed here). A ' +
			'sustained fell-back share is a peer the forward cannot reach; no rows means the peer token is unset. ' +
			'serve_check = the serve-time check (changeProbe.serveCheck): would-check (dry run: a page served from ' +
			'cache that is due a check; counted once per URL per 5 minutes per worker, so an UPPER BOUND on the ' +
			'requests armed checks would make — the distinct URLs are `would-check` in /prerender_admin/crawl-breadth), ' +
			'queued, then the verdict — agree (recorded in PageCheck), mismatch (the ' +
			'page disagreed with the origin and was expired and re-filed: THE NUMBER TO WATCH, by hour, since it is ' +
			'what a page served from cache between two checks gets wrong), raw-mismatch (a stored raw document ' +
			'disagreed and was deleted), held (the same field disagreed again on a page rendered after the last ' +
			'mismatch: a systematic difference between page and origin, not a change, so not acted on — a sustained ' +
			'count names a mapping or a page type to look at), inconclusive (nothing comparable), failed (the origin ' +
			'request failed; recorded, so asked again next window), throttled (the origin pushed back: out-of-pass ' +
			'requests on the node pause); or ' +
			'why nothing was asked — busy (queue full), shed (no budget slot in time, or paused by pushback), deduped ' +
			'(checked by another worker or node meanwhile), superseded (the served copy was re-rendered, re-captured ' +
			'or removed while the check waited), dropped (checks were switched off or to dry run while it waited), ' +
			'no-facts (the served page states nothing comparable), no-target (a page with no Target disagreed: ' +
			'expired, nothing filed), suppressed (a suppressed Target\u2019s page disagreed: left to the suppression ' +
			'path), read-error, write-error, error.',
		caveats:
			'Value semantics per series: unrouted, sitemap_*, the probe_* pass counters and the demand_* decision counters ' +
			'(promoted/demoted/held/skipped_cold/single_rung/promoted_fast/fast/graded) are per-interval/per-run counts whose `total` is the meaningful ' +
			'sum (`count` is flushes/runs); serve_error, page_age_negative, invalidation_error, ' +
			'invalidation_reenqueue, probe_canary_trip, probe_invalidated, discovery_gated, entity_gate, raw_cache, negative_cache, ' +
			'gone_reopen, suppression_lifted, suppression_held, due_now_forward and serve_check are counters; negative_gap, probe_detection_lag, entity_serve_ms and served_wrong are durations (ms — read their percentiles, not their total; served_wrong\u2019s count is the number of wrong copies found); ' +
			'config_warnings is a slow gauge (latest value); ' +
			'demand_fill is a per-node gauge (one worker refreshes the node\u2019s union) — never sum it, and READ ITS PEAK, NOT ITS MEAN. It is the ' +
			'set-bit fraction of the newest visit-filter slot, which resets to ~0 at every slice rollover ' +
			'and climbs until the next one, so it is a sawtooth: averaging over a window reports the middle ' +
			'of the ramp while the decisions that matter are made at the top of it. A k=7 probe ' +
			'false-positives at ~fill^7, so a mean of 0.75 (13%) and a peak of 0.986 (91%) are the same slice ' +
			'and only the second one is the answer — take max/p95 across buckets. False positives promote ' +
			'pages nobody visited, and a saturated ring promotes the whole corpus to its floor without ' +
			'raising any other alarm: watch this before trusting the histogram, and see ' +
			'`demand.bitsPerSlice` for what to do when it is high. demand_false_positive is a gauge too, but ' +
			'over FULL slots only, so it has no sawtooth: its level is the answer. ' +
			'unrouted’s bucket slot is bounded by ingress.report.maxBuckets per class. The per-level ladder ' +
			'histogram exists only in the demand-ladder log line.',
		dimensions: {
			path: {
				name: 'series',
				values: [
					'unrouted',
					'sitemap_sitemaps',
					'sitemap_created',
					'sitemap_updated',
					'sitemap_skipped',
					'sitemap_removed',
					'sitemap_failed',
					'serve_error',
					'config_warnings',
					'page_age_negative',
					'demand_promoted',
					'demand_demoted',
					'demand_held',
					'demand_skipped_cold',
					'demand_single_rung',
					'demand_promoted_fast',
					'demand_fast',
					'demand_graded',
					'demand_fill',
					'demand_false_positive',
					'invalidation_error',
					'invalidation_reenqueue',
					'probe_probed',
					'probe_seeded',
					'probe_rebaselined',
					'probe_changed',
					'probe_triggered',
					'probe_failed',
					'probe_canary_trip',
					'probe_invalidated',
					'probe_fresh',
					'probe_throttled',
					'probe_unreadable',
					'probe_page_mismatch',
					'probe_cycle_behind',
					'probe_errors',
					'probe_caught_up',
					'probe_ignored',
					'probe_covered',
					'probe_anchor',
					'probe_detection_lag',
					'probe_render_mismatch',
					'discovery_gated',
					'entity_gate',
					'entity_serve',
					'entity_serve_ms',
					'entity_canonical',
					'canonical_adopt',
					'served_wrong',
					'raw_cache',
					'negative_cache',
					'negative_gap',
					'gone_reopen',
					'suppression_lifted',
					'suppression_held',
					'due_now_forward',
					'serve_check',
				],
				description:
					'unrouted = non-prerendered serve counts (see method/type). sitemap_* = per finished run: ' +
					'sitemaps processed, targets created / re-attributed / unchanged / unlinked, sitemaps failed ' +
					'and skipped. serve_error = committed-then-failed deliveries. config_warnings = finding count. ' +
					'page_age_negative = negative-age samples discarded from page_age. demand_* = ladder decisions ' +
					'(promoted/demoted/held are the graded ones and sum to demand_graded; skipped_cold and ' +
					'single_rung are the two paths where no decision was possible), fast/graded = the ' +
					'guardrail ratio\u2019s two halves, promoted_fast = promotions onto a fast rung, plus the ' +
					'tracker\u2019s fill and false_positive sizing gauges. ' +
					'invalidation_error = failed epoch resolutions. invalidation_reenqueue = heal-attempt outcomes. ' +
					'probe_* = change-probe pass counters (see usefulFor). discovery_gated = gated cacheable misses. ' +
					'entity_gate = entity discovery gate evaluations, by outcome. entity_serve = entity-serve ' +
					'evaluations of true misses, by outcome. entity_serve_ms = how long each took. entity_canonical = ' +
					'observations of an entity\u2019s canonical (entities.enabled). canonical_adopt = adoption ' +
					'decisions (entities.adopt). raw_cache = raw-document store ' +
					'attempts. negative_cache = the negative cache (render.negative): stores, refusals, re-checks and ' +
					'dry-run verdicts. negative_gap = age of a stored 404 when a request for it arrived. gone_reopen = ' +
					'gone-suppressed targets reopened on an origin 200. suppression_lifted = suppressions a render ' +
					'lifted, by reason and age. suppression_held = suppressions a render re-proved, by reason and age. ' +
					'due_now_forward = off-owner "render this now" filings, by outcome. serve_check = serve-time ' +
					'checks against the origin, by outcome.',
			},
			method: {
				name: 'detail',
				description:
					"unrouted: the route class ('unclassified' — the CDN forwarded a path nobody declared — or " +
					"'passthrough' — declared, deliberately not prerendered), or 'overflow' — requests dropped from " +
					'the per-bucket breakdown past ingress.report.maxBuckets, counted here so the metric’s volume ' +
					'is never a lie (their class is unknown by construction). serve_error: the kind ' +
					"('blob-stream' = a cached page’s stored body errored while streaming out; 'bad-header' = a " +
					'stored or origin header value no response may carry, dropped from the response). page_age_negative: ' +
					'the bot name. invalidation_error: the kind — read-error (the row read threw; a live ' +
					'last-known-good answered, or the request failed OPEN), lkg-expired (it threw and the memory ' +
					'was older than invalidation.lkgMaxAge — the serious one), invalid-row (row exists, shape ' +
					'unusable), unknown-mode (treated as hard) — those two once per view load, not per request — ' +
					'view-read-error / view-subscribe-error (the worker’s in-memory view could not be read, or its ' +
					'subscription could not be armed or closed: that worker resolves per request until the ' +
					'invalidation.syncInterval backstop recovers it; correct, only dearer). invalidation_reenqueue: the outcome — lowered ' +
					'(accepted), not-owner/paused/leased (correctly declined), no-schedule/no-target (nothing to ' +
					'accelerate; no-schedule on a live URL is the terminal gap reconcile repairs), unhealable, ' +
					"not-sooner, throttled, error. discovery_gated: which gate refused ('route' = the matched " +
					"route's discoverTargets, 'bot' = ingress.discoveryBots, 'entity' = the route's entityPrefix " +
					'found a sibling URL of the same entity in rotation, armed gate only). entity_gate: the outcome ' +
					'(gated, would-gate, suppressed-only, no-siblings, no-prefix, error). entity_serve: the outcome ' +
					'(served, would-serve, no-prefix, has-query, has-target, no-sibling, no-page, not-indexable, stale, ' +
					'invalidated, ambiguous, unconfirmed, moved, not-self-canonical, unreadable, error). entity_canonical: the outcome ' +
					'(new, moved, same, older, foreign, untracked, unreadable, error). canonical_adopt: the outcome (adopted, ' +
					'reactivated, would-adopt, exists, suppressed, recent, capped, refused, error). raw_cache: THE OUTCOME — stored, ' +
					'stored-unshared, or the refusal name; this is the slot the console reads that panel from. ' +
					'negative_cache: the outcome — stored/stored-unshared; a refusal (has-cookie, private, no-store, ' +
					'staging, no-body, empty, oversize, capture-failed, capture-busy, write-failed, skipped-listed, ' +
					'skipped-target); a guard on read (guarded-listed, guarded-target, guard-error, invalidated, ' +
					'bot-excluded, read-blob-failed); a background re-check (recheck-gone, recheck-live, recheck-moved, ' +
					'recheck-error, recheck-busy, recheck-joined); or a dry-run verdict (would-serve, would-revalidate, ' +
					'would-serve-live). gone_reopen: the outcome (filed, would-file, deduped, capped, error). ' +
					'suppression_lifted and suppression_held: the suppressedReason the render lifted or re-proved ' +
					'(http-gone, noindex, canonical-mismatch, ...). due_now_forward: the outcome (forwarded, ' +
					'fell-back, timed-out, skipped). probe_anchor: the outcome (on_time, interrupted, ' +
					'chained, caught_up, skipped). probe_detection_lag: the bound (pass, previous_pass). probe_render_mismatch: the outcome (rechecked, confirmed, cleared, recheck_failed, recheck_inconclusive, bounded, untrusted, shed, dry_run, error). ' +
					'serve_check: the outcome (would-check, queued, agree, mismatch, raw-mismatch, inconclusive, failed, ' +
					'busy, shed, deduped, no-facts, read-error, write-error, error). Other series: null.',
			},
			type: {
				name: 'context',
				description:
					'unrouted: first path segment (`/blog/*`), `/` for root (null for the overflow row). ' +
					'page_age_negative: the device type. invalidation_reenqueue: the invalidation scope literal ' +
					'that triggered the heal. discovery_gated, entity_gate and entity_serve: the bot name. entity_canonical and ' +
					"canonical_adopt: the observer, 'probe', 'render', 'check' or 'origin'. gone_reopen: what saw the " +
					"200 — 'traffic' (a proxied bot request) or 'recheck' (a negative-cache re-check). " +
					'suppression_lifted and suppression_held: how long the target had been suppressed (since its last ' +
					'verdict) — <1h, <6h, <1d, <3d, <14d, 14d+, or unknown. probe_detection_lag: the rule label. ' +
					"serve_check: the check's source — 'api' (the rule's endpoint), 'document' (the origin document, " +
					"documentCheck routes) or 'raw' (a stored raw document against the endpoint); null for read/write errors. " +
					'Other series: null.',
			},
		},
	}),
});

/**
 * HARPER'S OWN METRICS, as they behave for this plugin's traffic. Not emitted here — Harper records
 * them for every HTTP request — but a prerender dashboard is incomplete without them, and their
 * `path` dimension is the one thing that makes them readable per subsystem: the bot handler stamps
 * `request.handlerPath = 'p'`, so `path: 'p'` isolates bot traffic from admin-console and
 * queue/render-result requests in exactly the same rows.
 *
 * Listed here so the catalog answers "what can I chart" rather than "what does the plugin emit".
 */
export const BUILT_IN_METRICS = Object.freeze({
	'duration': Object.freeze({
		name: 'duration',
		kind: 'value',
		unit: 'ms',
		summary: 'Server-side execution time per HTTP request.',
		usefulFor:
			'Latency the crawler experienced, filtered to `path: "p"`. Its `type` slot carries ' +
			"Harper's own cache-hit/cache-miss verdict (from the response's wasCacheMiss), which for bot " +
			'traffic means "did the plugin serve a stored snapshot" — a second, independently-derived read on ' +
			'the same hit rate bot_serve reports, and a useful cross-check when the two disagree.',
		dimensions: {
			path: { name: 'handlerPath', description: "'p' for bot requests; the resource path otherwise." },
			method: { name: 'httpMethod', description: 'GET/HEAD/POST…' },
			type: { name: 'cacheVerdict', values: ['cache-hit', 'cache-miss', null], description: 'Absent when unknown.' },
		},
	}),
	'success': Object.freeze({
		name: 'success',
		kind: 'counter',
		summary: 'Requests that ended below status 400.',
		usefulFor: 'Error rate as a single series, without enumerating response_* metrics.',
		dimensions: {
			path: { name: 'handlerPath', description: "'p' for bot requests." },
			method: { name: 'httpMethod', description: 'GET/HEAD/POST…' },
			type: { name: null, description: 'Unused.' },
		},
	}),
	'response_<code>': Object.freeze({
		name: 'response_<code>',
		kind: 'counter',
		summary: 'One metric per observed status code (response_200, response_404, response_500…).',
		usefulFor:
			'The status mix as served to crawlers. DYNAMIC metric names: discover them with the ' +
			'`list_metrics` operation (metric_types: ["custom"]) rather than hardcoding a list, since a code ' +
			'that has not occurred in the window has no metric at all.',
		dimensions: {
			path: { name: 'handlerPath', description: "'p' for bot requests." },
			method: { name: 'httpMethod', description: 'GET/HEAD/POST…' },
			type: { name: null, description: 'Unused.' },
		},
	}),
	'bytes-sent': Object.freeze({
		name: 'bytes-sent',
		kind: 'value',
		unit: 'bytes',
		summary: 'Response body size, recorded for STREAMED bodies only.',
		usefulFor:
			'Snapshot size trend — a sudden drop is the signature of un-hydrated or script-stripped output. ' +
			'Incomplete by construction (buffered responses are not sampled), so read it as a distribution, ' +
			'never as a total.',
		dimensions: {
			path: { name: 'handlerPath', description: "'p' for bot requests." },
			method: { name: 'httpMethod', description: 'GET/HEAD/POST…' },
			type: { name: null, description: 'Unused.' },
		},
	}),
	'memory': Object.freeze({
		name: 'memory',
		kind: 'value',
		summary: 'Per-thread process.memoryUsage(), reported by thread rather than aggregated.',
		usefulFor:
			'Worker memory growth on nodes that also serve bot traffic — the context for swap pressure ' +
			'incidents, where cheap operations answer while scans time out.',
		dimensions: {
			path: { name: null, description: 'Unused; rows carry threadId instead.' },
			method: { name: null, description: 'Unused.' },
			type: { name: null, description: 'Unused.' },
		},
	}),
});

/**
 * The catalog as plain JSON, safe to serve: what `GET /prerender_admin/metrics` returns, so a
 * dashboard author (or an agent) can ask a RUNNING node what it emits instead of matching a doc
 * against a deployed version.
 */
const describeOne = (m) => ({
	...m,
	dimensions: Object.fromEntries(Object.entries(m.dimensions).map(([slot, d]) => [slot, { ...d }])),
});

export const describeMetrics = () => ({
	plugin: Object.values(METRICS).map(describeOne),
	builtIn: Object.values(BUILT_IN_METRICS).map(describeOne),
});

// ---------------------------------------------------------------------- emitters
//
/** `render_size`'s band for a decoded byte count — decimal edges, see its catalog entry. */
export const renderSizeBand = (bytes) =>
	bytes < 500_000 ? 'under-500k' : bytes < 1_000_000 ? '500k-1m' : bytes < 2_000_000 ? '1m-2m' : '2m-plus';

// The ONLY places `server.recordAnalytics` is called. Each one fixes its metric's slot order to
// what the catalog above documents, so a dashboard contract cannot be changed by editing an
// argument list in an unrelated module. Value metrics take the value first, exactly as
// recordAnalytics does.
//
// Deliberately thin: no validation, no normalization, no try/catch. The per-request emitters sit
// on the bot read path where the whole point is that one call is a Map lookup and an add, and the
// low-frequency emitters are already wrapped in try/catch by callers that must not lose their real
// work (the backlog snapshot, the ladder's log line) — swallowing errors here would hide a broken
// analytics subsystem from all of them instead.

export const metrics = Object.freeze({
	/** Bot traffic at ingress. */
	botRequest: (host, botName, deviceType) => server.recordAnalytics(true, 'bot_request', host, botName, deviceType),

	/** What answered the request. */
	botServe: (source, cacheStatus, botName) => server.recordAnalytics(true, 'bot_serve', source, cacheStatus, botName),
	botMiss: (cause, route, botName) => server.recordAnalytics(true, 'bot_miss', cause, route, botName),

	/** The same outcome, per route. */
	routeServe: (route, cacheStatus, deviceType) =>
		server.recordAnalytics(true, 'route_serve', route, cacheStatus, deviceType),

	/** Age of a cache-served snapshot. */
	pageAge: (ageMs, botName, deviceType) => server.recordAnalytics(ageMs, 'page_age', botName, deviceType),

	/** Age of a cache-served snapshot, per route. */
	routePageAge: (ageMs, route, cacheStatus, deviceType) =>
		server.recordAnalytics(ageMs, 'route_page_age', route, cacheStatus, deviceType),

	/** A served page whose age computed negative (clock skew), not sampled — a prerender_ops series. */
	pageAgeNegative: (botName, deviceType) =>
		server.recordAnalytics(true, 'prerender_ops', 'page_age_negative', botName, deviceType),

	/** One render's duration, as reported by the browser worker — the `render` time_ms series. */
	renderTime: (renderTimeMs, statusCode, candidacy) =>
		server.recordAnalytics(renderTimeMs, 'render', 'time_ms', statusCode, candidacy),

	/** What became of one posted render result — exactly one call per result; the `render` outcome series. */
	renderOutcome: (outcome, detail) => server.recordAnalytics(true, 'render', 'outcome', outcome, detail ?? null),
	// trigger-to-cache: ms from the change mark to the render that cleared it, per route
	renderChangeLag: (lagMs, route) => server.recordAnalytics(lagMs, 'render', 'change_lag_ms', route, null),
	// a stored page's decoded size, per route and device, banded so a share over a threshold is a count
	renderSize: (bytes, route, deviceType) =>
		server.recordAnalytics(bytes, 'render_size', route, deviceType, renderSizeBand(bytes)),

	/** How one render's readiness contract ended — one call per governed variant. */
	renderReadiness: (contract, verdict) =>
		server.recordAnalytics(true, 'render_readiness', 'verdict', contract, verdict),

	/** One clause that did not hold. Emitted per clause, so it does not sum to renders. */
	renderReadinessUnmet: (contract, clause) =>
		server.recordAnalytics(true, 'render_readiness', 'unmet', contract, clause),

	/** One page whose expectation was re-learned. Its own series, so `verdict` stays one per variant. */
	renderReadinessRebaseline: (contract) =>
		server.recordAnalytics(true, 'render_readiness', 'rebaseline', contract, null),

	/** One observation that fell far below what this page last produced. */
	renderReadinessShortfall: (contract, observation) =>
		server.recordAnalytics(true, 'render_readiness', 'shortfall', contract, observation),

	/** How long the contract took to first hold — what `timeoutMs` should be tuned from. */
	renderReadinessMs: (ms, contract) => server.recordAnalytics(ms, 'render_readiness', 'satisfied_ms', contract, null),

	/** Jobs granted by one claim. */
	claimGranted: (count) => server.recordAnalytics(count, 'queue_health', 'claim_granted', 'ready', null),

	/** One origin proxy on the serve path: time to response headers, status, and why. */
	originFetch: (durationMs, statusCode, reason) =>
		server.recordAnalytics(durationMs, 'origin_fetch', statusCode, reason, null),

	/** A committed response whose body failed on the way out — a prerender_ops series. */
	serveError: (kind) => server.recordAnalytics(true, 'prerender_ops', 'serve_error', kind, null),

	/** One flush-interval's count for one unrouted bucket (read `total` for the request sum). */
	unrouted: (count, routeClass, bucket) =>
		server.recordAnalytics(count, 'prerender_ops', 'unrouted', routeClass, bucket),

	/** A cacheable miss the discovery gate held out of target creation — a prerender_ops series. */
	discoveryGated: (reason, botName) =>
		server.recordAnalytics(true, 'prerender_ops', 'discovery_gated', reason, botName ?? null),

	/**
	 * One evaluation of the entity discovery gate (util/entityGate.js) and its outcome — a
	 * prerender_ops series. Exactly one per evaluation, so the outcomes sum to the mints it looked at.
	 */
	entityGate: (outcome, botName) =>
		server.recordAnalytics(true, 'prerender_ops', 'entity_gate', outcome, botName ?? null),

	/**
	 * One entity-serve evaluation of a true miss (util/entityServe.js) and what it decided — a prerender_ops
	 * series. `outcome` is `served`, `would-serve` (dry run), or the guard that fell through; one per
	 * evaluation, so the series sums to the true misses on entity-serve routes.
	 */
	entityServe: (outcome, botName) =>
		server.recordAnalytics(true, 'prerender_ops', 'entity_serve', outcome, botName ?? null),
	/** How long one entity-serve evaluation took, every outcome (ms) — what it adds to a miss. */
	entityServeMs: (ms) => server.recordAnalytics(ms, 'prerender_ops', 'entity_serve_ms', null, null),

	/**
	 * One observation of an entity's canonical (util/entity.js) — a prerender_ops series. `outcome` is what it
	 * did to the registry (new, moved, same, older, foreign, untracked, unreadable, error); `from` is the observer: 'probe',
	 * 'render', 'check' or 'origin'.
	 */
	entityCanonical: (outcome, from) =>
		server.recordAnalytics(true, 'prerender_ops', 'entity_canonical', outcome, from ?? null),

	/** One adoption decision (util/entity.js `resolveCanonical`) — a prerender_ops series. */
	canonicalAdopt: (outcome, from) =>
		server.recordAnalytics(true, 'prerender_ops', 'canonical_adopt', outcome, from ?? null),

	/**
	 * One raw-document store attempt and what became of it — a prerender_ops series.
	 *
	 * `outcome` is `stored` or the reason it was not: `not-200`, `staging`, `has-cookie`,
	 * `content-type`, `no-store`, `no-body`, `oversize`, `capture-failed`, `write-failed`. Counting
	 * the refusals is the point, not the successes: a route that is enabled and filling nothing looks
	 * identical to one that is disabled unless the reason is recorded. `oversize` climbing is the
	 * signal to revisit `render.raw.maxBytes`; `has-cookie` climbing means the origin is personalizing
	 * a route that was assumed shared.
	 */
	rawCache: (outcome) => server.recordAnalytics(true, 'prerender_ops', 'raw_cache', outcome, null),
	/** One negative-cache event (render.negative): a store, a refusal, a read guard, a re-check, or a dry-run verdict. */
	negativeCache: (outcome) => server.recordAnalytics(true, 'prerender_ops', 'negative_cache', outcome, null),
	/** Milliseconds since the origin last confirmed a stored 404, per request that found one — the freshMs curve. */
	negativeGap: (ms) => server.recordAnalytics(ms, 'prerender_ops', 'negative_gap', null, null),
	/** A gone-suppressed target seen answering 200 at the origin, and what was done about it. `via` = traffic | recheck. */
	goneReopen: (outcome, via) => server.recordAnalytics(true, 'prerender_ops', 'gone_reopen', outcome, via),
	/** A suppression a render lifted: the reason it had been suppressed for, and how long it held (a bucket). */
	suppressionLifted: (reason, ageBucket) =>
		server.recordAnalytics(true, 'prerender_ops', 'suppression_lifted', reason, ageBucket),
	/** A suppressed target rendered and still non-indexable: the reason it was suppressed for, and how long it had held. */
	suppressionHeld: (reason, ageBucket) =>
		server.recordAnalytics(true, 'prerender_ops', 'suppression_held', reason, ageBucket),

	/**
	 * One result posted in the single-device shape for a job that asked for several — a renderer
	 * older than browser 1.23.0. Non-zero means some pod missed the fleet upgrade and the devices it
	 * is not rendering are silently falling out of cache.
	 */
	legacyRenderer: (deviceType) =>
		server.recordAnalytics(true, 'prerender_ops', 'legacy_renderer', deviceType ?? null, null),

	/** One series of a finished sitemap refresh run — prerender_ops `sitemap_<series>`. */
	sitemapRun: (value, series) => server.recordAnalytics(value, 'prerender_ops', `sitemap_${series}`, null, null),

	/** One series of a finished reconcile sweep — queue_health `reconcile_<series>`. */
	reconcile: (value, series) => server.recordAnalytics(value, 'queue_health', `reconcile_${series}`, null, null),

	/** The current config-warning count, from the snapshot pass — a prerender_ops series. */
	configWarnings: (count) => server.recordAnalytics(count, 'prerender_ops', 'config_warnings', null, null),

	/** One queue-health gauge from the periodic backlog snapshot. */
	queueHealth: (value, gauge) => server.recordAnalytics(value, 'queue_health', gauge, null, null),

	/** One series of the demand ladder's decision histogram — prerender_ops `demand_<series>`. */
	demand: (value, series) => server.recordAnalytics(value, 'prerender_ops', `demand_${series}`, null, null),

	/** A failed invalidation-epoch resolution — a prerender_ops series. */
	invalidationError: (kind) => server.recordAnalytics(true, 'prerender_ops', 'invalidation_error', kind, null),
	// a "render this now" filing on a node that does not own the row: forwarded to the owner, or filed here
	dueNowForward: (outcome) => server.recordAnalytics(true, 'prerender_ops', 'due_now_forward', outcome, null),

	/** The outcome of one demand-driven heal attempt — a prerender_ops series. */
	// outcome: 'written' | 'read-error' | 'write-error'. A skip is not counted here — the serve path's
	// `verified` cacheStatus is what measures exemptions actually granted, and counting "row absent"
	// would swamp both with the normal case.
	pageVerification: (outcome) => server.recordAnalytics(true, 'prerender_ops', 'page_verification', outcome, null),
	serveCheck: (outcome, source) =>
		server.recordAnalytics(true, 'prerender_ops', 'serve_check', outcome, source ?? null),
	/**
	 * A cached copy that was being SERVED, found to differ from the origin — one emit per detection, never per
	 * serve. The value is an UPPER BOUND on how long it was served that way: ms since it was last known right
	 * (its render, or the last check that agreed with this very copy; a 404's last confirmation). `detector`:
	 * check | check-raw | sweep | render-check | negative-recheck | negative-fetch. `what`: the field that
	 * disagreed (a pageCheck field label, `claim` for the price/availability pair), or `404`.
	 */
	servedWrong: (ms, detector, what) =>
		server.recordAnalytics(Math.max(0, ms), 'prerender_ops', 'served_wrong', detector, what ?? null),
	invalidationReenqueue: (outcome, scope) =>
		server.recordAnalytics(true, 'prerender_ops', 'invalidation_reenqueue', outcome, scope ?? null),

	/**
	 * One change-probe series — prerender_ops `probe_<series>`. The pass counters pass neither label;
	 * `probe_anchor` names its outcome, `probe_detection_lag` its bound and rule, `probe_render_mismatch`
	 * its outcome.
	 */
	changeProbe: (value, series, detail = null, context = null) =>
		server.recordAnalytics(value, 'prerender_ops', `probe_${series}`, detail, context),
});
