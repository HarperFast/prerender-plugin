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
	'bypass', // not a cacheable request at all (non-GET/HEAD)
]);

const SERVE_SOURCES = Object.freeze([
	'cache', // a stored snapshot answered it
	'rendered', // an on-demand render landed inside the renderNow timeout
	'origin', // proxied live to the origin — the request the offload number counts against
]);

const DEVICE_TYPES = Object.freeze(['desktop', 'mobile', 'tablet']);

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
			'per render result posted back by a browser worker: one `outcome` row always, one `time_ms` sample ' +
			'when the worker reported a duration',
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
				values: ['time_ms', 'outcome'],
				description: 'time_ms = duration distribution (ms). outcome = counter of what became of the result.',
			},
			method: {
				name: 'statusCode (time_ms) / outcome (outcome)',
				description:
					'time_ms: HTTP status the render observed — a NUMBER at the emit site (for a redirect bail, ' +
					'the FIRST hop’s 3xx). outcome: rendered | suppressed | auth-failure | transient | failed | ' +
					'redirect — rendered = usable result, suppressed = genuine non-indexable verdict (target moves ' +
					'to its recheck cadence), auth-failure = 401/403 kept and retried, transient = 408/429/5xx kept ' +
					'and retried, failed = the render itself broke, redirect = the page moved or bounced.',
			},
			type: {
				name: 'candidacy (time_ms) / detail (outcome)',
				values: [
					'candidate',
					'non-candidate',
					'unknown',
					'redirect',
					'stored',
					'discarded',
					'refiled',
					'no-content',
					'noindex',
					'canonical-mismatch',
					'http-error',
					'redirect-loop',
					'unspecified',
					'landed-auth',
					'landed-transient',
					'unrouted-destination',
					'non-indexable-destination',
					'temporary',
					'permanent',
					'navigation',
				],
				description:
					'time_ms: candidate (was cached) | non-candidate (suppression verdict) | unknown (worker posted ' +
					'no isIndexable) | redirect (its own lane, so redirect bails do not read as fast renders). ' +
					'outcome: per-outcome refinement — rendered: stored / discarded (landed on a class we never ' +
					'serve) / refiled (client-side redirect onto another prerender key) / no-content (a legacy ' +
					'worker posted an indexable verdict with nothing to store); suppressed: the browser’s ' +
					'reason (noindex/canonical-mismatch/http-error/redirect-loop, else unspecified); auth-failure/' +
					'transient: the status code; failed: the error phase (navigation = the document never arrived; ' +
					'unknown = pre-v1.16.0 worker posted no detail); redirect: landed-auth/landed-transient ' +
					'(destination answered 401/403 / 5xx-shaped), unrouted-destination (route list has no home for ' +
					'it — a render is wasted every interval until fixed), non-indexable-destination (source ' +
					'retired, destination suppressed), temporary (kept, strike counted), permanent (source retired ' +
					'in favor of the destination).',
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
				values: ['miss', 'stale', 'skip', 'invalidated', 'bypass', 'render-timeout', 'other'],
				description:
					'Why the origin was consulted: the cache status that led here (miss/stale/skip/invalidated), ' +
					'bypass (non-GET/HEAD), or render-timeout (a renderNow render did not land in time and the ' +
					"origin was the fallback). 'other' is the emitter's default for a caller that passed no " +
					'reason — its presence is a bug in the caller, not a traffic category.',
			},
			type: { name: null, description: 'Unused (emitted as null).' },
		},
	}),

	queue_health: metric('queue_health', {
		kind: 'value',
		emittedBy:
			'util/backlogSnapshot.js (snapshot gauges), resources/RenderQueue.js (claim_scan_ms), util/reconcile.js (reconcile_*)',
		cadence:
			'snapshot gauges once per backlog snapshot per node (worker 0, management.backlogSnapshotInterval); ' +
			'claim_scan_ms once per claim pass; reconcile_* once per sweep per node',
		summary: 'Every queue signal under one name: backlog gauges, claim-scan health, schedule-gap repairs.',
		usefulFor:
			'The queue’s alertable surface, readable in ONE get_analytics scan (a metric name is a scan — see the ' +
			'module header). Backlog gauges say whether the queue is keeping up; claim_scan_ms is the leading ' +
			'indicator (the scan degrades — measured 17× once — before any backlog shows); reconcile_restored > 0 ' +
			'means URLs were silently un-renderable until the sweep repaired them.',
		caveats:
			'MIXED CADENCES under one name: the snapshot series are slow gauges (chart the latest value, never a ' +
			'sum; one row per node — sum `overdue` across nodes), claim_scan_ms is a per-pass duration ' +
			'distribution, reconcile_* are per-sweep totals. Snapshot values come from a capped scan — a backlog ' +
			'past management.scanCap reports the cap, not the truth.',
		dimensions: {
			path: {
				name: 'series',
				values: [
					'overdue',
					'lease_occupancy',
					'below_floor',
					'below_floor_age_ms',
					'floor_pin_age_ms',
					'paused',
					'claim_scan_ms',
					'reconcile_restored',
					'reconcile_missing',
				],
				description:
					'overdue = schedule rows already due, INCLUDING in-flight renders (so its healthy floor is the ' +
					'in-flight count, not zero — not comparable with pre-0.34.0 numbers). ' +
					'lease_occupancy = live claim leases on this node right now. ' +
					'below_floor = rows filed BELOW the claim floor, which nothing will ever claim: expect 0, and ' +
					'treat any sustained non-zero as lost renders. ' +
					'below_floor_age_ms = age of the oldest such row (absent when there are none). ' +
					'floor_pin_age_ms = how long the claim floor has been stuck at one value; a floor pinned for ' +
					'hours means one failing key is holding the whole queue’s scan position. ' +
					'paused = 1 when this node’s queue is paused at snapshot time, else 0 — makes "paused for hours" ' +
					'alertable without polling the REST surface. ' +
					'claim_scan_ms = claim-pass duration; watch the p95 trend, not the level. ' +
					'reconcile_restored / reconcile_missing = schedule gaps repaired / found per sweep (they differ ' +
					'when the per-sweep restore cap truncates the pass); expect zero — a steady rate means ' +
					'something is CREATING gaps, and the reconcile log line names the URLs.',
			},
			method: {
				name: 'result (claim_scan_ms only)',
				values: ['granted', 'empty', 'capped'],
				description:
					'Only claim_scan_ms uses this slot: granted = jobs handed out, empty = nothing due, capped = the ' +
					'scan hit queue.claimScanCap without reaching a not-yet-due row (in-flight work is filling the ' +
					'window). Every other series emits null here.',
			},
			type: { name: null, description: 'Unused (emitted as null).' },
		},
	}),

	prerender_ops: metric('prerender_ops', {
		kind: 'value',
		emittedBy:
			'util/unrouted.js, resources/Sitemap.js, http_handlers/response.js, util/backlogSnapshot.js, ' +
			'util/demandLadder.js, util/invalidation.js, util/invalidationReenqueue.js, http_handlers/bot_request.js',
		cadence:
			'per report flush (unrouted), per finished sitemap run (sitemap_*), per delivery failure ' +
			'(serve_error, page_age_negative), per snapshot (config_warnings), per stats interval (demand_*), ' +
			'per failed epoch read (invalidation_error), per heal attempt (invalidation_reenqueue)',
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
			'invalidation_error = an active invalidation is NOT being enforced on the requests that failed ' +
			'(the serve path falls back per-worker, so these are invisible in serve metrics); expect zero, ' +
			'`lkg-expired` is the serious kind. invalidation_reenqueue = every demand-driven heal attempt with ' +
			'its outcome — `lowered` is work accepted, everything else is a refusal with its reason; the feature ' +
			'is off by default, so no rows means disabled.',
		caveats:
			'Value semantics per series: unrouted, sitemap_* and the demand_* decision counters ' +
			'(promoted/demoted/held/skipped_cold) are per-interval/per-run counts whose `total` is the meaningful ' +
			'sum (`count` is flushes/runs); serve_error, page_age_negative, invalidation_error and ' +
			'invalidation_reenqueue are counters; config_warnings is a slow gauge (latest value); ' +
			'demand_fast_fraction and demand_fill are per-worker gauges — average them, never sum ' +
			'(fill = set-bit fraction of the newest visit-filter slot; a k=7 probe false-positives at ~fill^7, ' +
			'and false positives promote pages nobody visited — watch it before trusting the histogram). ' +
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
					'demand_fast_fraction',
					'demand_fill',
					'invalidation_error',
					'invalidation_reenqueue',
				],
				description:
					'unrouted = non-prerendered serve counts (see method/type). sitemap_* = per finished run: ' +
					'sitemaps processed, targets created / re-attributed / unchanged / unlinked, sitemaps failed ' +
					'and skipped. serve_error = committed-then-failed deliveries. config_warnings = finding count. ' +
					'page_age_negative = negative-age samples discarded from page_age. demand_* = ladder decisions ' +
					'(promoted/demoted/held/skipped_cold) and its two sizing gauges (fast_fraction, fill). ' +
					'invalidation_error = failed epoch resolutions. invalidation_reenqueue = heal-attempt outcomes.',
			},
			method: {
				name: 'detail',
				description:
					"unrouted: the route class ('unclassified' — the CDN forwarded a path nobody declared — or " +
					"'passthrough' — declared, deliberately not prerendered), or 'overflow' — requests dropped from " +
					'the per-bucket breakdown past ingress.report.maxBuckets, counted here so the metric’s volume ' +
					'is never a lie (their class is unknown by construction). serve_error: the kind ' +
					"('blob-stream' = a cached page’s stored body errored while streaming out). page_age_negative: " +
					'the bot name. invalidation_error: the kind — read-error (the row read threw; a live ' +
					'last-known-good answered, or the request failed OPEN), lkg-expired (it threw and the memory ' +
					'was older than invalidation.lkgMaxAge — the serious one), invalid-row (row exists, shape ' +
					'unusable), unknown-mode (treated as hard). invalidation_reenqueue: the outcome — lowered ' +
					'(accepted), not-owner/paused/leased (correctly declined), no-schedule/no-target (nothing to ' +
					'accelerate; no-schedule on a live URL is the terminal gap reconcile repairs), unhealable, ' +
					'not-sooner, throttled, error. Other series: null.',
			},
			type: {
				name: 'context',
				description:
					'unrouted: first path segment (`/blog/*`), `/` for root (null for the overflow row). ' +
					'page_age_negative: the device type. invalidation_reenqueue: the invalidation scope literal ' +
					'that triggered the heal. Other series: null.',
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

	/** One claim pass's duration and how it ended — a queue_health series, so the queue reads in one scan. */
	claimScan: (durationMs, result) => server.recordAnalytics(durationMs, 'queue_health', 'claim_scan_ms', result, null),

	/** One origin proxy on the serve path: time to response headers, status, and why. */
	originFetch: (durationMs, statusCode, reason) =>
		server.recordAnalytics(durationMs, 'origin_fetch', statusCode, reason, null),

	/** A committed response whose body failed on the way out — a prerender_ops series. */
	serveError: (kind) => server.recordAnalytics(true, 'prerender_ops', 'serve_error', kind, null),

	/** One flush-interval's count for one unrouted bucket (read `total` for the request sum). */
	unrouted: (count, routeClass, bucket) =>
		server.recordAnalytics(count, 'prerender_ops', 'unrouted', routeClass, bucket),

	/** One series of a finished sitemap refresh run — prerender_ops `sitemap_<series>`. */
	sitemapRun: (value, series) => server.recordAnalytics(value, 'prerender_ops', `sitemap_${series}`, null, null),

	/** One series of a finished reconcile sweep — queue_health `reconcile_<series>`. */
	reconcile: (value, series) => server.recordAnalytics(value, 'queue_health', `reconcile_${series}`, null, null),

	/** The current config-warning count, from the snapshot pass — a prerender_ops series. */
	configWarnings: (count) => server.recordAnalytics(count, 'prerender_ops', 'config_warnings', null, null),

	/** One queue-health gauge from the periodic backlog snapshot. */
	queueHealth: (value, gauge) => server.recordAnalytics(value, 'queue_health', gauge, null, null),

	/** One series of the demand ladder's decision histogram — prerender_ops `demand_<series>`. */
	demandLadder: (value, series) => server.recordAnalytics(value, 'prerender_ops', `demand_${series}`, null, null),

	/** A failed invalidation-epoch resolution — a prerender_ops series. */
	invalidationError: (kind) => server.recordAnalytics(true, 'prerender_ops', 'invalidation_error', kind, null),

	/** The outcome of one demand-driven heal attempt — a prerender_ops series. */
	invalidationReenqueue: (outcome, scope) =>
		server.recordAnalytics(true, 'prerender_ops', 'invalidation_reenqueue', outcome, scope ?? null),
});
