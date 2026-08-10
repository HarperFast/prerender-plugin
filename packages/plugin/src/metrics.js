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
 * HOW `recordAnalytics` BEHAVES (harper-pro `core/resources/analytics/write.ts`), because every
 * reading of these numbers depends on it:
 *
 *   - A BOOLEAN value is a counter: `total` counts the `true`s, `count` counts the calls. Every
 *     counter here passes `true`, so `total === count` and either reads as "how many".
 *   - A NUMBER value is a distribution: Harper keeps the samples and reports
 *     `total`/`count`/`mean`/`median`/`p95`/`p99`. Samples land in a `Float32Array`, so a
 *     millisecond age is precise to ~7 significant digits — fine for a duration, not a counter
 *     substitute.
 *   - Calls AGGREGATE per (metric, path, method, type) into a Map and flush on Harper's own
 *     analytics timer (`analytics.aggregatePeriod`). One call is a Map lookup and an add: no
 *     storage touch, no await, nothing added to response latency. That is what makes the
 *     per-request metrics below affordable on the bot read path.
 *   - Aggregation is PER THREAD and PER NODE, and rows are node-local. Every query is a fan-out
 *     and every reading is a SUM across nodes and threads; a per-node number is a quarter of the
 *     cluster's answer on a 4-node cluster. Means/medians must be recombined count-weighted, and
 *     a p95 of p95s is an approximation.
 *   - An unused dimension slot is left as the emit site had it (absent, or an explicit null).
 *     Read every empty slot as "not a dimension of this metric" — never group by it.
 *
 * COST DISCIPLINE. Dimension values must have SMALL, BOUNDED cardinality: each distinct
 * combination is a row per node per flush, forever, in `system.hdb_analytics`. Bot names come
 * from the registry, device types are sanitized, route labels are the configured route paths,
 * cache statuses and outcomes are closed sets. A URL, a cache key, or an un-bucketed path must
 * never become a dimension value — see `util/unrouted.js` for what to do instead when the value
 * space is genuinely unbounded.
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

	page_age_negative: metric('page_age_negative', {
		kind: 'counter',
		emittedBy: 'http_handlers/bot_request.js',
		cadence: 'per cache-served bot request whose page claims to have rendered in this node’s future',
		summary:
			'Served pages discarded from page_age because their age computed negative — `lastCached` ahead of ' +
			'this node’s clock, i.e. cross-node clock skew on a page another node just wrote. The sample is ' +
			'dropped so it cannot poison the mean, and counted here so the fact is not silently discarded.',
		usefulFor:
			'The only evidence anywhere of cluster clock skew on the serve path. Expect zero. Anything sustained ' +
			'means NTP drift, and it also means invalidation.pad is covering a larger quantity than its default assumes.',
		gatedBy: 'analytics.enabled',
		dimensions: {
			path: { name: 'botName', description: 'As bot_request.method.' },
			method: { name: 'deviceType', values: DEVICE_TYPES, description: 'Sanitized device type.' },
			type: { name: null, description: 'Unused (emitted as null).' },
		},
	}),

	render_time: metric('render_time', {
		kind: 'value',
		unit: 'ms',
		emittedBy: 'resources/RenderQueue.js',
		cadence: 'once per render result posted back by a browser worker (whenever the worker reported a renderTime)',
		summary: 'How long the render fleet took to produce one result, as measured by the worker.',
		usefulFor:
			'Fleet capacity: renders/hour/pod is concurrency ÷ render_time, so this is the input to every sizing ' +
			'estimate, and its p95 is what a settle-tuning change has to move. Split by status code to keep ' +
			'error-path renders from flattering the distribution.',
		dimensions: {
			path: {
				name: 'statusCode',
				description:
					'HTTP status the render observed — a NUMBER at the emit site, so it arrives as a numeric-looking ' +
					'label. For a redirect bail this is the FIRST hop’s 3xx.',
			},
			method: {
				name: 'candidacy',
				values: ['candidate', 'non-candidate', 'unknown', 'redirect'],
				description:
					'Whether the result was indexable/storable: `candidate` was cached, `non-candidate` was a ' +
					'suppression verdict, `unknown` means the worker reported no isIndexable, `redirect` is a ' +
					'redirect result (its own path, so redirect bails do not read as fast renders).',
			},
			type: { name: null, description: 'Unused.' },
		},
	}),

	queue_health: metric('queue_health', {
		kind: 'value',
		emittedBy: 'util/backlogSnapshot.js',
		cadence: 'once per backlog snapshot per node (worker 0, management.backlogSnapshotInterval)',
		summary: 'Alertable gauges off the periodic backlog scan: is the queue keeping up, and can it still be claimed.',
		usefulFor:
			'The queue’s only alertable surface. Before these existed, "a row sits below the claim floor" and "the ' +
			'floor has been pinned for hours" — both silent, both terminal for the affected URLs — were visible ' +
			'only to someone looking at the admin console.',
		caveats:
			'A GAUGE ON A SLOW CADENCE, not a rate: chart the latest value, never a sum, and remember one row per ' +
			'node (sum `overdue` across nodes for a cluster backlog; each node scans its own residency slice). ' +
			'Values come from a capped scan — a backlog past management.scanCap reports the cap, not the truth.',
		dimensions: {
			path: {
				name: 'gauge',
				values: ['overdue', 'lease_occupancy', 'below_floor', 'below_floor_age_ms', 'floor_pin_age_ms'],
				description:
					'overdue = schedule rows already due, INCLUDING in-flight renders (so its healthy floor is the ' +
					'in-flight count, not zero — not comparable with pre-0.34.0 numbers). ' +
					'lease_occupancy = live claim leases on this node right now. ' +
					'below_floor = rows filed BELOW the claim floor, which nothing will ever claim: expect 0, and ' +
					'treat any sustained non-zero as lost renders. ' +
					'below_floor_age_ms = age of the oldest such row (absent when there are none). ' +
					'floor_pin_age_ms = how long the claim floor has been stuck at one value; a floor pinned for ' +
					'hours means one failing key is holding the whole queue’s scan position.',
			},
			method: { name: null, description: 'Unused (emitted as null).' },
			type: { name: null, description: 'Unused (emitted as null).' },
		},
	}),

	demand_ladder: metric('demand_ladder', {
		kind: 'value',
		emittedBy: 'util/demandLadder.js',
		cadence: 'once per stats interval per worker that made decisions (render.demand.statsInterval)',
		summary: 'The demand ladder’s decision histogram, plus the sizing signal for the filter behind it.',
		usefulFor:
			'The ladder’s only guardrail: whether "promote the hot pages" is quietly turning into "halve every ' +
			'interval" and doubling render demand. Recorded during a dry run too, which is the point — the ' +
			'histogram is how a dry-run week is judged.',
		caveats:
			'Counters here (promoted/demoted/held/skipped_cold) SUM correctly across workers and nodes; ' +
			'fast_fraction and fill are per-worker gauges and must be averaged, not summed. The per-level ' +
			'histogram exists only in the log line — see METRICS.md.',
		dimensions: {
			path: {
				name: 'series',
				values: ['promoted', 'demoted', 'held', 'skipped_cold', 'fast_fraction', 'fill'],
				description:
					'promoted/demoted/held = decisions that moved a target up a rung, down a rung, or left it. ' +
					'skipped_cold = decisions declined because the visit filter was not warm yet (expected after a ' +
					'restart; sustained means it never warms). ' +
					'fast_fraction = share of decisions landing on a fast rung, against render.demand.maxFastFraction. ' +
					'fill = set-bit fraction of the newest visit-filter slot: the false-positive early warning, since ' +
					'a k=7 probe false-positives at ~fill^7 (0.5 ≈ 0.8%, 0.88 ≈ 40%) and false positives promote ' +
					'pages nobody visited. Watch this before trusting the histogram.',
			},
			method: { name: null, description: 'Unused (emitted as null).' },
			type: { name: null, description: 'Unused (emitted as null).' },
		},
	}),

	invalidation_error: metric('invalidation_error', {
		kind: 'counter',
		emittedBy: 'util/invalidation.js',
		cadence: 'per failed epoch resolution on the serve path',
		summary: 'The invalidation epoch could not be read or made sense of.',
		usefulFor:
			'Whether an active invalidation is actually being enforced. The serve path falls back to a per-worker ' +
			'last-known-good, so these failures are INVISIBLE in the serve metrics — a page can keep being served ' +
			'while the epoch that should have demoted it is unreadable. Expect zero; alert on any rate.',
		dimensions: {
			path: {
				name: 'kind',
				values: ['read-error', 'lkg-expired', 'invalid-row', 'unknown-mode'],
				description:
					'read-error = the row read threw; either a live last-known-good answered, or this worker had no ' +
					'memory of the scope at all and the request failed OPEN (served as if nothing were invalidated). ' +
					'lkg-expired = it threw and the remembered value is older than invalidation.lkgMaxAge, so a ' +
					'known-stale memory was discarded and the request failed open — the serious one. ' +
					'invalid-row = a row exists but its shape is unusable. ' +
					'unknown-mode = a mode this version does not implement (treated as hard).',
			},
			method: { name: null, description: 'Unused (emitted as null).' },
			type: { name: null, description: 'Unused (emitted as null).' },
		},
	}),

	invalidation_reenqueue: metric('invalidation_reenqueue', {
		kind: 'counter',
		emittedBy: 'util/invalidationReenqueue.js',
		cadence: 'per demand-driven heal attempt (only when an invalidation is what cost a request its cache serve)',
		summary: 'Outcome of every attempt to pull an invalidated URL’s render forward.',
		usefulFor:
			'How fast an invalidation actually heals, and why it is not healing when it is not: `lowered` is work ' +
			'accepted, everything else is a refusal WITH ITS REASON. `throttled` says the rate limit is the ' +
			'binding constraint; `unhealable` says those URLs need a human. Off by default — no rows means the ' +
			'feature is disabled, not that nothing happened.',
		dimensions: {
			path: {
				name: 'outcome',
				values: [
					'lowered',
					'not-owner',
					'paused',
					'leased',
					'no-schedule',
					'no-target',
					'unhealable',
					'not-sooner',
					'throttled',
					'error',
				],
				description:
					'lowered = the due time was pulled forward (the success case). not-owner/paused/leased = correctly ' +
					'declined (another node owns the row, the queue is paused, a render is already in flight). ' +
					'no-schedule/no-target = nothing to accelerate, and no-schedule on a live URL is the terminal ' +
					'schedule-gap state util/reconcile.js repairs. unhealable = strikes exhausted or already rendered ' +
					'after the epoch. not-sooner = already due sooner than we would have asked. throttled = this node’s ' +
					'per-interval budget is spent. error = the write failed.',
			},
			method: {
				name: 'scope',
				description: 'The invalidation scope literal that triggered the heal (cluster scope, or a route path).',
			},
			type: { name: null, description: 'Unused (emitted as null).' },
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

	/** A served page whose age computed negative (clock skew) and was therefore not sampled. */
	pageAgeNegative: (botName, deviceType) =>
		server.recordAnalytics(true, 'page_age_negative', botName, deviceType, null),

	/** One render's duration, as reported by the browser worker. */
	renderTime: (renderTimeMs, statusCode, candidacy) =>
		server.recordAnalytics(renderTimeMs, 'render_time', statusCode, candidacy),

	/** One queue-health gauge from the periodic backlog snapshot. */
	queueHealth: (value, gauge) => server.recordAnalytics(value, 'queue_health', gauge, null, null),

	/** One series of the demand ladder's decision histogram. */
	demandLadder: (value, series) => server.recordAnalytics(value, 'demand_ladder', series, null, null),

	/** A failed invalidation-epoch resolution. */
	invalidationError: (kind) => server.recordAnalytics(true, 'invalidation_error', kind, null, null),

	/** The outcome of one demand-driven heal attempt. */
	invalidationReenqueue: (outcome, scope) =>
		server.recordAnalytics(true, 'invalidation_reenqueue', outcome, scope ?? null, null),
});
