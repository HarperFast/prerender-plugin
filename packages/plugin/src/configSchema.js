/**
 * The configuration schema: the single source of truth for every option the plugin
 * understands. Each option declares its default, a description, and how a change takes
 * effect — everything `config.js` (defaults, merge validation, redaction, restart
 * warnings) and the management API (a machine-readable schema for the admin UI) derive
 * from.
 *
 * Field reference for `option(default, description, extra)`:
 *   scope     'live' (default) — a change via the host's options `change` event takes
 *             effect without a restart (per request, per timer tick, or on the next
 *             scheduled cycle). 'restart' — the value is consumed once at worker boot;
 *             a live change is reported as pending-restart and otherwise ignored.
 *             Groups may set a scope their children inherit.
 *   secret    true — the value is redacted to a presence marker wherever config is
 *             read back (management API, logs).
 *   enum      Allowed values; anything else is rejected at apply time (default kept).
 *   unit      Display/documentation hint ('ms', 'percent'). No behavioral effect.
 *   min/max   Numeric bounds enforced at apply time (violation keeps the default).
 *   nonEmpty  true — an empty string/array is rejected at apply time (default kept).
 *             Reserved for values where empty is catastrophic rather than unwise.
 *   itemType  Display hint for array options ('string' | 'object').
 *   movedFrom Dotted path this option (or group) lived at before the v0.25.0
 *             reorganization. The old path still applies with a deprecation warning.
 *
 * Descriptions are user-facing documentation: they are served by the management API and
 * will back the admin UI's config editor. Write them for an operator, not a code reader.
 */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const OPTION = Symbol('option');
const GROUP = Symbol('group');

const option = (defaultValue, description, extra = {}) => ({
	[OPTION]: true,
	default: defaultValue,
	description,
	...extra,
});

const group = (description, children, extra = {}) => ({
	[GROUP]: true,
	description,
	children,
	...extra,
});

export const isOption = (node) => !!node?.[OPTION];
export const isGroup = (node) => !!node?.[GROUP];

// Database/table names are fixed (defined statically in src/schemas/schema.graphql).
// Tables are split across databases by write-transaction coupling so the hot queue
// (render_schedule) is isolated from target, page-cache, and sitemap writes.
export const configSchema = group('Prerender plugin configuration.', {
	domains: option(
		[],
		'Allowlist of hostnames considered indexable. Pages on other hosts are rendered but ' +
			'never marked indexable/cached. Empty = allow all.',
		{ itemType: 'string' }
	),

	ingress: group(
		'Request-ingestion model: how incoming bot requests are recognized, which paths are ' +
			'prerendered, and how the target URL and device type are derived.\n\n' +
			"mode 'prefix' — native model: bot requests arrive at `${botPathPrefix}<absolute-url>` " +
			'and the device type comes from a header (`deviceTypeHeader`).\n' +
			"mode 'forwarded' — reverse-proxy / CDN model: the proxy routes a restricted set of " +
			'paths to the plugin. The device type is the first path segment, the target URL is ' +
			'reconstructed from the forwarded host/proto headers, and `routes` both identifies ' +
			"which requests are prerender requests and sets each route's query-param allowlist.",
		{
			mode: option('prefix', "Request-ingestion model: 'prefix' (native) or 'forwarded' (reverse-proxy / CDN).", {
				enum: ['prefix', 'forwarded'],
			}),
			botPathPrefix: option(
				'/p/',
				'Requests whose path starts with this prefix are treated as bot prerender requests ' +
					'(e.g. `/p/<absolute-url>`). Prefix mode only.',
				{ movedFrom: 'botPathPrefix', nonEmpty: true }
			),
			deviceTypeSource: option(
				'header',
				"Where the device type comes from in forwarded mode: 'path' (first path segment, " +
					"consumed when it is a supported device type) or 'header'.",
				{ enum: ['path', 'header'] }
			),
			deviceTypeHeader: option('x-device-type', 'Request header carrying the device type.'),
			forwardedHostHeader: option('x-forwarded-host', 'Header carrying the original public host (forwarded mode).'),
			forwardedProtoHeader: option('x-forwarded-proto', 'Header carrying the original public scheme (forwarded mode).'),
			defaultProtocol: option('https', 'Scheme assumed when the forwarded-proto header is absent.', {
				enum: ['https', 'http'],
			}),
			routes: option(
				[],
				'Ordered route list (forwarded mode). Each entry is ' +
					"{ match: 'exact' | 'prefix' | 'contains', path: string, mode?: 'prerender' | 'passthrough', " +
					'queryParams?: string[], renderInterval?: number }.\n\n' +
					'FIRST MATCH WINS, so order most-specific first. That ordering is what lets a passthrough ' +
					'carve-out sit inside a prerendered prefix (`/products/clearance/` above `/products/`) ' +
					'without a second list and a precedence rule.\n\n' +
					"`mode` (default 'prerender') decides the class:\n" +
					'  prerender — cache it, schedule it, serve it from cache. `queryParams` is its cache-key / ' +
					"origin-fetch query allowlist (same semantics as `cacheKey.queryParams`: ['*'] keeps all, " +
					'[] drops all).\n' +
					'  passthrough — proxy it live, never cache or schedule it, and don’t report it. A declaration ' +
					'that the CDN forwards this path and we have chosen not to prerender it. `queryParams` is ' +
					'REJECTED here: with no cache there is no key for it to shape, so it could only strip params ' +
					'off the proxied origin fetch and hand the visitor the wrong page.\n\n' +
					"A path matching NOTHING is 'unclassified': still proxied (never blocked), never cached, and " +
					'counted for reporting so the gap can be fixed at the CDN or here.\n\n' +
					'`renderInterval` (ms, prerender routes only) sets the render cadence for every URL the route ' +
					"matches. Precedence: route > the target's stored interval (sitemap `<changefreq>` or an " +
					'explicit API write) > `render.defaultInterval` — resolved at schedule time on every cycle, so ' +
					"changing it here takes effect on each URL's next render with no data migration. A per-URL " +
					'exception is an `exact` route ordered above its class (e.g. the homepage `exact /` at 2h above ' +
					'a 6h section prefix); a route that should defer to sitemap changefreq simply doesn’t set one.\n\n' +
					"OPERATIONAL NOTE: if the CDN edge-caches a route's responses with a fixed TTL from its own " +
					"property settings (not from our response headers), that TTL and the route's renderInterval " +
					'must be kept aligned BY HAND — rendering much faster than the edge TTL burns renders the edge ' +
					'never serves, and much slower means the edge re-fetches stale content. Neither side can see ' +
					'the other drift.',
				{ itemType: 'object' }
			),
			excludePathPatterns: option(
				['/search/'],
				'Paths never auto-scheduled for rendering. Compiled into `routes` as ' +
					"{ match: 'contains', mode: 'passthrough' } entries, PREPENDED so an exclude still beats any " +
					'prerender route it overlaps. Matched against the PATH only (never the query string). ' +
					'Prefer declaring a `contains`/`passthrough` route directly.',
				{ movedFrom: 'excludePathPatterns', itemType: 'string' }
			),
			report: group(
				'Periodic aggregated report of paths served without prerendering, bucketed by first path ' +
					'segment. Replaces a per-request warning that was unusable at crawler volume. Runs on EVERY ' +
					'worker (the counters are in-process), so each line carries node + worker and a reader sums ' +
					'across them.',
				{
					enabled: option(true, 'Emit the periodic unrouted-path report.'),
					interval: option(5 * MINUTE, 'How often each worker flushes its tally.', { unit: 'ms', min: SECOND }),
					maxBuckets: option(200, 'Distinct buckets tracked per class before overflow counting.', { min: 1 }),
					topN: option(20, 'Buckets listed per log line, highest count first.', { min: 1 }),
				}
			),
		}
	),

	deviceTypes: group('Device variants the service renders and serves.', {
		supported: option(
			['desktop', 'mobile', 'tablet'],
			'Device types the service understands; unrecognized values fall back to the first entry.',
			{ itemType: 'string', nonEmpty: true }
		),
		default: option(['desktop', 'mobile'], 'Device types scheduled for rendering when a page is auto-discovered.', {
			itemType: 'string',
		}),
	}),

	cacheKey: group(
		'How a request URL becomes a cache identity. Changing any of these reshapes every key: ' +
			'existing cached pages and schedules are orphaned (not migrated), so treat a live change ' +
			'as a full cache rebuild.',
		{
			delimiter: option('|', 'Separator joining the key attributes.', { nonEmpty: true }),
			attributes: option(['url', 'deviceType'], 'Attributes joined (in order) to form the key.', {
				itemType: 'string',
				nonEmpty: true,
			}),
			queryParams: option(
				['page'],
				'URL normalization used to build the cache key: an allowlist of query parameters to retain ' +
					'(others are dropped; the remaining ones are sorted for a stable key).\n' +
					"  ['page'] — keep only `?page=` (default)\n" +
					"  ['*'] — keep all query params\n" +
					'  [] — drop all query params\n' +
					'In forwarded mode a matched route’s own `queryParams` takes precedence.',
				{ movedFrom: 'url.queryParams', itemType: 'string' }
			),
		}
	),

	origin: group('How Harper fetches from the origin: identification, staging routing, and header hygiene.', {
		securityToken: group(
			'Shared secret sent to the origin so it can distinguish the prerender service (and bypass ' +
				'bot mitigation). Set the value per deployment — preferably via `valueEnv` so the secret ' +
				'stays out of config.yaml.',
			{
				header: option('x-harper-renderer-bypass', 'Header name carrying the token.', { nonEmpty: true }),
				value: option('', 'The token itself. Prefer `valueEnv`.', { secret: true }),
				valueEnv: option(
					'',
					'If set, the token is sourced from this environment variable at config-apply time and takes ' +
						'precedence over `value` (keeps the secret out of config.yaml). The environment itself is ' +
						'loaded once at boot (loadEnv), so changing the variable’s VALUE still needs a restart; ' +
						'changing which variable is read does not.'
				),
			},
			{ movedFrom: 'securityToken' }
		),
		staging: group(
			'Staging passthrough — for verifying an origin against a staging edge (e.g. the CDN’s staging ' +
				'network). When `ip` is set, a cache-MISS origin fetch that carries the `header` request header ' +
				'is connected to `ip` instead of the public origin. The Host header and TLS SNI stay the real ' +
				'origin host (only the TCP address is pinned), so the staging edge serves the right property and ' +
				'presents a valid certificate.\n\n' +
				'The header is only a toggle: the connect address is always the configured `ip`, never a value ' +
				'from the request, so a request can’t repoint the fetch at an arbitrary host. The cache key does ' +
				'not include the header, so cache HITS always return the normal cached page regardless of it. ' +
				'Empty `ip` disables the feature — production is unaffected unless a staging IP is explicitly ' +
				'configured.\n\n' +
				'The sitemap refresh reuses this `ip` too, but unconditionally (no toggle header — it has no ' +
				'incoming request): whenever `ip` is set, every sitemap fetch is pinned to it, so all ' +
				'Harper→origin traffic hits the same edge. The security token often only authenticates against ' +
				'the staging edge, so a direct prod sitemap fetch is bounced with a 403.\n\n' +
				'Toggling staging↔prod contaminates the URL-keyed page cache; wipe it when switching.',
			{
				ip: option('', 'Staging edge IP. Empty disables staging passthrough entirely.'),
				header: option('x-harper-staging', 'Request header that toggles the staging connect on a miss fetch.'),
			},
			{ movedFrom: 'staging' }
		),
		userAgents: group(
			'Per-device-type User-Agent strings sent to the origin on the proxy (cache-miss passthrough) ' +
				'fetch. Each carries a `HarperProxy/1.0` product token so Harper’s proxy traffic is identifiable ' +
				'in origin/CDN logs while still presenting a real, device-appropriate browser UA (the origin ' +
				'serves device-specific HTML off it).',
			{
				mobile: option(
					'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/W.X.Y.Z Mobile Safari/537.36 HarperProxy/1.0',
					'UA for mobile proxy fetches.'
				),
				tablet: option(
					'Mozilla/5.0 (Linux; Android 7.0; Pixel C Build/NRD90M; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/52.0.2743.98 Safari/537.36 HarperProxy/1.0',
					'UA for tablet proxy fetches.'
				),
				desktop: option(
					'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/W.X.Y.Z Safari/537.36 HarperProxy/1.0',
					'UA for desktop proxy fetches.'
				),
			},
			{ movedFrom: 'userAgents' }
		),
		ignoredHeaders: option(
			[],
			'Additional downstream request header names never forwarded to the origin, on top of the ' +
				'always-ignored set (hop-by-hop headers plus host, user-agent, accept-encoding, cookie, ' +
				'authorization, and the security-token/debug header names). Matched case-insensitively.',
			{ movedFrom: 'ignoredHeaders', itemType: 'string' }
		),
		maxResponseHeaderBytes: option(
			64 * 1024,
			'Largest response head Harper will accept from the origin, summed across every header name ' +
				'and value in the response (not per header).\n\n' +
				'Undici defaults this to Node’s `http.maxHeaderSize` (16 KiB), which is a header-flood ' +
				'mitigation for servers accepting untrusted requests — too strict for a reverse proxy reading ' +
				'its own origin. A real origin can exceed 16 KiB on a single page (several Set-Cookie plus ' +
				'CSP, Link rel=preload, NEL, Report-To), and undici responds by destroying the connection ' +
				'with UND_ERR_HEADERS_OVERFLOW, so the crawler gets a 500 for a page browsers and the CDN ' +
				'load normally. It fails deterministically for those URLs, since it is a property of the ' +
				'origin’s response rather than a transient. Hence a default well above Node’s, matching what ' +
				'a CDN in front of the same origin already tolerates.\n\n' +
				'Raising it raises the worst-case memory held per connection while a response head is ' +
				'parsed, which is why it is bounded at both ends. The 1 MiB ceiling is far above any ' +
				'legitimate response head — it exists to catch a typo (a stray factor of a thousand) ' +
				'before it becomes an out-of-memory risk multiplied across concurrent connections.\n\n' +
				'Restart-scoped: undici fixes `maxHeaderSize` when the dispatcher is constructed and offers ' +
				'no way to change it afterwards, so a live edit is reported as pending-restart and the ' +
				'running dispatchers keep the value they were built with.',
			{ unit: 'bytes', min: 16 * 1024, max: 1024 * 1024, scope: 'restart' }
		),
	}),

	debugHeader: group('Debug response headers, emitted when the request carries this header (any value).', {
		key: option('x-harper-prerender-debug', 'Request header name that turns on debug response headers.', {
			nonEmpty: true,
		}),
	}),

	renderNow: group(
		'On-demand render control. When enabled, an authorized GET bot request gets two orthogonal ' +
			'levers (both ignored for unauthorized requests, so real crawler traffic is unaffected):\n' +
			'  1. Cache freshness — a request `Cache-Control: no-cache`/`no-store` SKIPS the served cache ' +
			'(forces a miss).\n' +
			'  2. Miss behavior — the `missHeader` value picks what to do on a miss/skip: ‘prerender’ ' +
			'(force an immediate one-off render and long-poll for the fresh result) or ‘origin’ (proxy ' +
			'the origin, same as a normal miss). Absent → `defaultMissMode`.\n' +
			'So `defaultMissMode: prerender` + no Cache-Control = "serve cache, else render now" ' +
			'(warm-on-demand); adding `Cache-Control: no-cache` = "always render fresh now".',
		{
			enabled: option(
				false,
				'Enable the on-demand render levers. Enabling is necessary but not sufficient — a non-empty ' +
					'`token` (or a `valueEnv` that resolves to one) is also required, so this cannot open the ' +
					'levers on its own.'
			),
			header: option(
				'x-harper-render-now',
				'Request header that authorizes the on-demand levers. The header VALUE must equal the ' +
					'configured `token`; presence alone never authorizes.'
			),
			token: option(
				'',
				'Expected value of `header`. **Required** — there is no unauthenticated mode: an empty token ' +
					'leaves renderNow DISABLED (the levers stay off even when `enabled` is true) rather than ' +
					'authorizing anyone who sends the header, and is reported at config-apply time.\n\n' +
					'This fails CLOSED deliberately. The levers let a caller bypass the served cache and force ' +
					'a synchronous render that occupies the request for up to `timeoutMs`, so on a path that ' +
					'takes public crawler traffic an absent or unresolved token must not degrade to "authorize ' +
					'everyone". Prefer `valueEnv` so the secret stays out of config.yaml, and never commit a ' +
					'guessable placeholder — a value like "true" is not meaningfully better than none.',
				{ secret: true }
			),
			valueEnv: option(
				'',
				'If set, the token is sourced from this environment variable at config-apply time and takes ' +
					'precedence over `token`. Same boot-time caveat as `origin.securityToken.valueEnv`.'
			),
			missHeader: option('x-harper-render-miss', "Request header picking miss behavior: 'prerender' | 'origin'."),
			defaultMissMode: option('prerender', 'Miss behavior when `missHeader` is absent.', {
				enum: ['prerender', 'origin'],
			}),
			timeoutMs: option(30 * SECOND, 'Give up waiting for the fresh render after this long.', {
				unit: 'ms',
				min: 1,
			}),
			pollIntervalMs: option(250, 'How often to re-check the cache for the fresh render.', {
				unit: 'ms',
				min: 10,
			}),
			fallback: option(
				'origin',
				'What to serve when a prerender doesn’t land before `timeoutMs`:\n' +
					"  'origin' — proxy the origin (same as a normal cache miss)\n" +
					"  'stale' — serve the existing cached page if any, else fall back to origin\n" +
					"  'error' — respond 504",
				{ enum: ['origin', 'stale', 'error'] }
			),
		}
	),

	management: group(
		'Management API + UI, served at the fixed path `/prerender_admin` (resource endpoint names are ' +
			'fixed, like the database/table names). Gated on Harper’s own authentication: every endpoint ' +
			'except the login/session/page routes requires a `super_user`.',
		{
			enabled: option(true, 'Serve the management API and console.'),
			proxyToOwner: option(
				true,
				'The URL explainer reads node-locally (a cross-node point read on the residency-pinned ' +
					'schedule table awaits Harper’s replication fetch, which has no timeout). When the row is ' +
					'owned by another node, ask that node over HTTPS instead — a bounded request, forwarding only ' +
					'the caller’s own credentials, which the peer re-authorizes. Set false to keep every read ' +
					'strictly node-local and accept an inconclusive schedule row.'
			),
			peerTimeoutMs: option(2500, 'Timeout for the peer-node explainer request.', { unit: 'ms', min: 1 }),
			scanCap: option(
				20000,
				'Ceiling on rows touched by an overview scan (due-count, next-24h histogram, below-floor ' +
					'detection). Counting is a capped index walk — at 1M+ targets an uncapped count is not a ' +
					'page-load query — so results past this are reported as truncated rather than silently ' +
					'undercounted. Note the due-count is no longer the headline capacity number: it now includes ' +
					'every in-flight render, so its healthy floor is the in-flight count rather than zero.',
				{ min: 1 }
			),
			backlogSnapshotInterval: option(
				15 * MINUTE,
				'How often the backlog/histogram snapshot recomputes (worker 0 of each node). Since v0.34.0 ' +
					'this is the ONLY scan that still seeks the absolute minimum of the nextRenderTime index — ' +
					'`claim` starts from queue.claimFloor instead — and it is kept that way deliberately, because ' +
					'it is therefore the only reader that can see a row filed BELOW the floor and report it. It ' +
					'runs on this cadence, never on dashboard page load. Its `overdue` count now includes ' +
					'in-flight jobs (their rows keep their past due time until the render lands). 0 disables the ' +
					'timer; the console’s Recompute button still triggers a one-off pass.',
				{ unit: 'ms', min: 0 }
			),
			pageSize: option(
				50,
				'Rows per page for the console’s sitemap-entry and page-cache tables. Also bounds the ' +
					'per-entry state lookups a sitemap detail performs (point reads, one per row).',
				{ min: 1 }
			),
		}
	),

	page: group('Cached-page lifetimes.', {
		ttl: option(DAY, 'Default cached-page TTL.', { unit: 'ms', min: 1 }),
		minTtl: option(6 * HOUR, 'Floor for sitemap-derived TTLs.', { unit: 'ms', min: 1 }),
		swrTtl: option(3 * HOUR, 'Stale-while-revalidate window.', { unit: 'ms', min: 0 }),
	}),

	render: group('Render scheduling: cadence, failure handling, and schedule repair.', {
		defaultInterval: option(
			DAY,
			'How often a target is re-rendered when nothing more specific applies. Cadence is relative to ' +
				'each render’s completion (not a fixed time-of-day), and a target’s first render is jittered ' +
				'across its interval — so the fleet renders as a smooth stream rather than a daily herd. Full ' +
				'precedence, resolved at schedule time: matched route `renderInterval` (ingress.routes) > the ' +
				'target’s stored interval (sitemap `changefreq` / explicit API write) > this default.',
			{ unit: 'ms', min: 1 }
		),
		demand: group(
			'Demand-driven cadence: move a target UP or DOWN a fixed ladder of render intervals based ' +
				'on whether bots actually visit it, inside the same total render budget. Hot pages get a ' +
				'tighter freshness bound; pages nothing crawls get a looser one.\n\n' +
				'A render interval only bounds staleness for content that drifts with TIME. On this corpus ' +
				'that is AVAILABILITY (~0.04%/hour, continuous, and directionally in-stock -> out-of-stock, ' +
				'i.e. the cache claims stock for sold-through items), so each rung is really an ' +
				'availability-error budget: 6h ~ 0.24%, 12h ~ 0.5%, 24h ~ 1%, 48h ~ 2%. Price does NOT ' +
				'drift that way — it steps at promotional events, most of the catalog at once — so no ' +
				'affordable interval bounds it and this does not try.\n\n' +
				'COST IS NOT SELF-LIMITING. It scales with the fraction of the corpus bots touch, which ' +
				'grows as search-engine traffic ramps. `maxFastFraction` is the backstop and the level ' +
				'histogram logged every `statsInterval` is the early warning — watch it before trusting it.',
			{
				enabled: option(false, 'Master switch. Off = `resolveRenderInterval` is used unchanged.'),
				dryRun: option(
					true,
					'Compute and LOG every ladder decision but schedule with the unchanged base interval. ' +
						'A week of this reports the steady-state level distribution — and therefore the render ' +
						'budget — before you pay for it. Default ON: enabling `enabled` alone changes nothing ' +
						'until this is turned off.'
				),
				ladder: option(
					[6 * HOUR, 12 * HOUR, 24 * HOUR, 48 * HOUR],
					'Render intervals a target may occupy, ascending. The route/stored interval is the ' +
						'CEILING — the ladder reallocates within the cadence the route already grants and never ' +
						'schedules slower than it. Bottoming out at 6h rather than 1h is deliberate: 1h buys ' +
						'~0.04% availability error against 6h\u2019s ~0.24% for six times the render cost, and the ' +
						'fast rungs are where a runaway hot set becomes unaffordable.',
					{ unit: 'ms' }
				),
				promoteWindows: option(
					2,
					'How many consecutive windows of the CANDIDATE (faster) interval must each contain a ' +
						'visit before a target is promoted. 1 promotes on "visited at all this interval", which ' +
						'settles at rendering twice per visit; 2 asks whether a render at the faster rung would ' +
						'actually have been seen, and settles near once per visit.',
					{ min: 1 }
				),
				maxFastInterval: option(
					12 * HOUR,
					'Rungs strictly below this count as "fast" for `maxFastFraction` and the logged ' + '`fastFraction`.',
					{ unit: 'ms', min: 1 }
				),
				maxFastFraction: option(
					0.05,
					'Budget backstop: the share of decisions allowed to land on a fast rung. Exceeding it is ' +
						'logged as a warning — the hot set has grown past what the ladder was sized for.',
					{ min: 0, max: 1 }
				),
				sliceMs: option(
					6 * HOUR,
					'Time resolution of the visit ring. Cannot be coarser than the fastest rung or that rung ' +
						'can never be evaluated.',
					{ unit: 'ms', min: 1 }
				),
				slices: option(
					16,
					'Ring length. Must cover promoteWindows x the slowest rung, so the promotion test for the ' +
						'top rung can see far enough back.',
					{ min: 2 }
				),
				bitsPerSlice: option(
					1 << 20,
					'Bloom filter bits per ring slice (power of two). ~1M bits holds ~100k distinct URLs per ' +
						'slice at ~1% false positives. False positives promote a page nobody asked for — wasted ' +
						'renders, never staleness — and there are no false negatives.',
					{ min: 1024 }
				),
				hashes: option(7, 'Bloom hash count (k).', { min: 1, max: 32 }),
				flushInterval: option(
					5 * MINUTE,
					'How often a worker merges its in-memory ring slices into this node\u2019s replicated row.',
					{ unit: 'ms', min: SECOND }
				),
				mergeInterval: option(
					5 * MINUTE,
					'How often the read side re-unions every node\u2019s rows. The reschedule path runs ~20x/s ' +
						'and cannot pay a multi-row read per job result, so it reads a cached union this stale.',
					{ unit: 'ms', min: SECOND }
				),
				statsInterval: option(15 * MINUTE, 'How often the level histogram + promote/demote counters are logged.', {
					unit: 'ms',
					min: SECOND,
				}),
			}
		),
		suppression: group(
			'What happens when a render proves a URL non-indexable (noindex, canonical mismatch, redirect ' +
				'loop, HTTP error page). The target is not deleted — it is marked `state: suppressed` and ' +
				'rescheduled at `recheckInterval`, so the verdict re-proves (or heals) itself on cadence, and ' +
				'discovery stops re-creating it. `maxStrikes` consecutive non-indexable verdicts delete the ' +
				'target outright; crawler re-discovery restarts the cycle at bounded cost.\n\n' +
				'Verdicts are not all equally permanent, so the knobs split by HTTP status:\n' +
				'  - 404/410 (`gone`): the origin’s strongest statement that the page no longer exists. ' +
				'Rechecking it on the default cadence is almost pure waste, so it gets fewer, further-apart ' +
				'rechecks before deletion.\n' +
				'  - 401/403 never suppress at all: an auth-shaped error is far more likely a broken renderer ' +
				'credential or an origin rule change than a page verdict, and striking on it would mass-delete ' +
				'healthy targets during an outage.\n' +
				'  - 408/429/5xx never suppress either: the origin failed to serve the page, it didn’t disavow ' +
				'it — the target and its cached page both survive and the render retries under `failureRetry`.',
			{
				recheckInterval: option(7 * DAY, 'Re-render cadence for a suppressed target.', { unit: 'ms', min: 1 }),
				maxStrikes: option(4, 'Consecutive non-indexable verdicts before the target is deleted.', { min: 1 }),
				gone: group('Tighter knobs for 404/410 verdicts.', {
					recheckInterval: option(14 * DAY, 'Re-render cadence for a gone (404/410) target.', {
						unit: 'ms',
						min: 1,
					}),
					maxStrikes: option(2, 'Consecutive gone verdicts before the target is deleted.', { min: 1 }),
				}),
			}
		),
		failureRetry: group(
			'Retry shape for the HTTP failures that never suppress (401/403 auth-shaped, 408/429/5xx ' +
				'transient), and for a render that simply failed (crash, timeout, settle error). The first ' +
				'`fastRetries` consecutive failures DELIBERATELY DO NOT RELEASE the job’s claim lease, so the ' +
				'retry comes on lease expiry (`queue.jobLeaseTime`) — an origin blip recovers fast, and the ' +
				'cached page’s stale-while-revalidate window covers bots throughout. From the next strike on, ' +
				'the retry drops to the target’s normal cadence: a persistently failing page must not hot-loop ' +
				'100+ renders a day. Past `page.swrTtl` the kept page stops serving and bots fall through to ' +
				'the origin on purpose — its answer (a live page for auth-shaped failures, an honest 5xx for ' +
				'transient ones) is the truth, and serving arbitrarily old snapshots while users get errors ' +
				'would break bot/user parity. Strikes are the target’s one shared counter; any successful ' +
				'render clears it.\n\n' +
				'Two consequences of the lease being node-local shared-buffer state rather than a stored due ' +
				'time: a worker restart collapses the fast-lane wait to zero (the job is simply re-granted), ' +
				'and a held lease HOLDS THE CLAIM FLOOR for its duration — see queue.jobLeaseTime. During a ' +
				'broad origin failure every job takes this lane, so no lease is released at all for that ' +
				'window and the claim scan degrades back toward its pre-floor cost.',
			{
				fastRetries: option(
					2,
					'Consecutive failures retried on lease expiry before dropping to the target’s cadence. Each ' +
						'such retry holds the claim floor for a full queue.jobLeaseTime — read that option’s latency ' +
						'note before raising this.',
					{
						min: 0,
					}
				),
			}
		),
		redirects: group(
			'A redirect that proves nothing permanent (302/303/307, a client-side redirect’s 200, or any ' +
				'redirect onto a route class we don’t serve) keeps the source target on the theory the page is ' +
				'coming back. A source that answers that way EVERY interval is de facto permanent, so each such ' +
				'result counts a strike (the same shared counter suppression uses; any successful render clears ' +
				'it) and `maxStrikes` consecutive ones retire the source outright. Retiring is safe, not ' +
				'destructive: bot traffic for the URL is proxied to the origin — which serves the redirect ' +
				'itself — and on-demand discovery re-creates whatever the origin actually serves.',
			{
				maxStrikes: option(4, 'Consecutive impermanent-redirect results before the source is retired.', {
					min: 1,
				}),
			}
		),
		reconcile: group(
			'Periodic repair of targets whose RenderSchedule row is missing. A target and its schedule are ' +
				'two commits in two databases (the schedule routed to the node owning the URL), so the pair can ' +
				'end up half-written — and for a URL that is not in a sitemap, NOTHING otherwise re-creates the ' +
				'schedule: the URL stops rendering silently and permanently. Runs on worker 0 of every node, ' +
				'each covering only the keys it owns.\n\n' +
				'The repair write goes through the schedule funnel, so a restored row lowers the claim floor. ' +
				'That matters: a restored row filed BEHIND the floor would be precisely the silent gap this ' +
				'sweep exists to close. Note also that this sweep tests row EXISTENCE only, so it can never ' +
				'detect a row that exists but sits below the floor — queue.claimFloor.resetInterval is what ' +
				'recovers that.',
			{
				enabled: option(true, 'Run the periodic schedule-repair sweep.'),
				interval: option(6 * HOUR, 'How often each node sweeps its own slice of the keyspace.', {
					unit: 'ms',
					min: SECOND,
				}),
				startDelay: option(5 * MINUTE, 'Grace after boot before the first sweep.', {
					unit: 'ms',
					min: 0,
					scope: 'restart',
				}),
				startJitter: option(
					5 * MINUTE,
					'Per-node spread on the first sweep, so a rolling restart doesn’t sync the sweeps.',
					{ unit: 'ms', min: 0, scope: 'restart' }
				),
				maxRestores: option(
					5000,
					'Ceiling on rows RESTORED per sweep. The scan always runs to completion, so a truncated sweep ' +
						'still reports the true size of the gap — the cap bounds only how much is repaired at once, ' +
						'since a membership change can strand a large slice of the keyspace and rewriting millions of ' +
						'rows in one pass would be its own outage.',
					{ min: 1 }
				),
			}
		),
	}),

	scan: group(
		'Bounded registry walks. Harper ends a transaction that stays open too long: with writes pending ' +
			'it is ABORTED and poisoned (422 "split long-running work into smaller transactions"), and ' +
			'read-only it is committed and its clock reset. So every walk over a large table collects while ' +
			'reading and writes only after the cursor closes, in drained batches.',
		{
			collectCap: option(
				100000,
				'Max rows buffered from one scan; the scan still completes and reports the true count.',
				{ min: 1 }
			),
			batchSize: option(100, 'Writes issued (and fully awaited) per batch once the cursor is closed.', {
				min: 1,
			}),
			yieldEvery: option(200, 'Rows scanned between event-loop yields.', { min: 1 }),
		}
	),

	sitemap: group('Sitemap ingestion: the daily refresh, filtering, and crawler identity.', {
		refreshTime: option('12:00', 'Local time-of-day ("HH:MM") for the daily sitemap refresh.', { nonEmpty: true }),
		timezone: option('America/New_York', 'IANA timezone `refreshTime` is interpreted in.', { nonEmpty: true }),
		filteredWarnPercent: option(
			50,
			'A sitemap lists every indexable URL on the site, which is routinely a superset of the paths ' +
				'the CDN forwards here — so entries that are not a prerender route are counted and dropped ' +
				'rather than scheduled. Past this share of one sitemap, that is reported as an ERROR instead of ' +
				'an info line: filtering most of a sitemap is far more likely to mean `ingress.routes` is ' +
				'incomplete than that the sitemap is wrong, and a silent filter looks exactly like a healthy ' +
				'refresh.',
			{ unit: 'percent', min: 0, max: 100 }
		),
		node: option(
			'',
			'Pin the periodic sitemap refresh to this node (hostname). Empty disables the scheduled ' +
				'refresh entirely (manual refresh still works).'
		),
		workerIndex: option(0, 'Worker index (on `node`) that runs the scheduled refresh.', { min: 0 }),
		background: option(
			true,
			'Run `POST /Sitemap/<url>` as a background walk and answer immediately with a handle, instead ' +
				'of holding the request open for the whole traversal. A sitemap index is not an ' +
				'HTTP-request-sized unit of work — a real one fans out to tens of children and over a million ' +
				'target writes, so the client (or any proxy between it and Harper) times out long before the ' +
				'walk finishes, leaving the operator with no result, no error, and no way to tell whether ' +
				'anything was written. Progress is persisted to `SitemapRefresh` under the root URL; ' +
				'`GET /SitemapRefresh/<root-url>` reports it. `POST ... {"background": false}` restores the ' +
				'blocking behaviour for a small sitemap or a test.'
		),
		staleRunMs: option(
			10 * MINUTE,
			'How long a progress row may go un-updated before a new refresh treats the run that wrote it ' +
				'as dead and starts over. Guards against a worker restart mid-walk leaving a `running` row that ' +
				'blocks every later refresh of that root.',
			{ unit: 'ms', min: 1 }
		),
		removedSampleCap: option(
			20,
			'Max unlinked-target samples carried back in a refresh result (counts stay exact; only the ' +
				'samples are capped).',
			{ min: 0 }
		),
		failedCap: option(100, 'Max failed-entry samples carried back in a refresh result.', { min: 0 }),
		userAgent: option(
			'HarperSitemapCrawler/1.0',
			'User-Agent for Harper’s sitemap crawler fetch. Unlike the proxy fetch UAs, a sitemap fetch ' +
				'isn’t a device render, so it sends a single self-identifying UA rather than a spoofed browser ' +
				'one — makes Harper’s sitemap traffic obvious in origin/CDN logs and separable from the proxy ' +
				'traffic.',
			{ movedFrom: 'sitemapUserAgent' }
		),
	}),

	queue: group('Render-queue mechanics between the plugin and the render fleet.', {
		jobLeaseTime: option(
			10 * MINUTE,
			'How long a claimed job is leased before the queue will grant it to another renderer.\n\n' +
				'The lease is NOT stored in the schedule row — it lives in a node-local shared buffer, so it is ' +
				'lost when a worker generation is replaced. That is correct, not a bug: the schedule row was ' +
				'never moved, so a lost lease simply means the job is granted again (which does mean a restart ' +
				'produces a short duplicate-render burst for whatever was in flight).\n\n' +
				'THIS IS A LATENCY KNOB, NOT ONLY A RETRY KNOB. The claim scan starts from a floor that cannot ' +
				'advance past the oldest DUE ROW (see queue.claimFloor), and everything behind that row waits. ' +
				'`render.failureRetry` multiplies this lease: the fast-retry lane deliberately holds it, so ' +
				'`fastRetries: 2` pins the floor for 2 leases before the slow lane writes the row forward, and ' +
				'during a broad origin 5xx event every job takes that lane at once.\n\n' +
				'A LEASE EXPIRING DOES NOT LIFT THE PIN, so “one wedged render costs one lease” is not true. ' +
				'Claiming writes nothing to the schedule row, so a render that never posts a result leaves the ' +
				'row due at the same minute and every later pass derives the same floor from it — indefinitely. ' +
				'The periodic reset cannot recover it either, because that row is the oldest due row it would ' +
				'then re-derive from. Only writing the row forward or deleting it lifts the pin, and the ' +
				'generic-failure path (a renderer crash, navigation timeout or settle failure on a URL that ' +
				'still has a target) holds the lease and writes no row. Watch “Claim floor lag” on the overview ' +
				'— it names the row holding the floor — and repair or delete that URL.\n\n' +
				'The minimum is two minutes because the render fleet DISCARDS any granted job with under 30 ' +
				'seconds of lease left. Below roughly 90s the fleet skips 100% of granted jobs and the queue ' +
				'live-locks: claims keep succeeding, nothing ever renders, and the plugin sees only healthy ' +
				'claims.',
			{
				unit: 'ms',
				min: 2 * MINUTE,
			}
		),
		statusSyncInterval: option(
			MINUTE,
			'How often each node re-resolves queue state on worker 0. The recompute no longer scans anything ' +
				'— empty/queued is derived from the claim floor plus the last claim outcome, at zero database ' +
				'cost. This interval governs how fast a replicated pause/resume intent (QueueControl) converges ' +
				'onto a node, how often the QueueStatus row is broadcast, and how often the claim floor is reset.',
			{
				unit: 'ms',
				min: SECOND,
			}
		),
		maxClaimLimit: option(
			25,
			'Hard ceiling on jobs granted per claim, regardless of what a consumer asks for. Recording a lease ' +
				'is an atomic store rather than a database write now, so this is about fair share and mutex hold ' +
				'time: the whole pass runs under the node’s claim mutex, and one greedy or misconfigured ' +
				'worker must not be able to hold it while hoarding a burst other renderers should share.',
			{ min: 1 }
		),
		claimFloor: group(
			'The lower bound the claim scan seeks from — a single `nextRenderTime >= floor` condition instead ' +
				'of a scan that starts at the absolute minimum of that index.\n\n' +
				'WHY IT EXISTS: every completed render moves a key from the head of the nextRenderTime index ' +
				'into the future and leaves a dead index entry AT THE SEEK POINT. Measured, the claim scan ' +
				'degraded from 0.36ms to 6.25ms over 40,000 reschedules — linear, position-dependent (churn away ' +
				'from the seek point was free), and it did not recover after the churn stopped. With the floor, ' +
				'the identical 20 keys come back in 0.43ms.\n\n' +
				'WHAT IT COSTS: the floor cannot advance past the oldest DUE ROW, and only that row’s own result ' +
				'moves it — a lease expiring does not, because claiming writes nothing to the row. So a render ' +
				'that never posts a result pins the floor at its minute until the row is written forward or ' +
				'deleted (see queue.jobLeaseTime), and everything behind it waits. A due time written BELOW ' +
				'the floor would never be read again, which is why every schedule write inside the plugin goes ' +
				'through one funnel that lowers the floor with the write, why the floor is held a guard band ' +
				'behind the current minute, and why it is periodically reset.',
			{
				enabled: option(
					true,
					'Kill switch. `false` forces the floor to 0, so the scan seeks from the absolute index ' +
						'minimum exactly as it did before v0.34.0 — and changes nothing else (leases still live in ' +
						'the shared buffer either way). It exists, and is live-reloadable, because a floor that is ' +
						'wrong strands rows SILENTLY: such a URL stops rendering and reports nothing.'
				),
				guard: option(
					5 * MINUTE,
					'The floor is always held at least this far behind the current minute.\n\n' +
						'This is what makes a "render this URL now" write safe from ANY node without cross-node ' +
						'coordination: schedule rows are residency-pinned, so most such writes are issued by a node ' +
						'that cannot lower the owner’s floor — but they are written at the current minute, and ' +
						'every node holds its floor behind that by construction. Lowering this toward zero re-opens ' +
						'that hazard for every write routed to another node. Raising it costs one extra re-walk of ' +
						'the index entries inside the window (roughly guard × render rate × 0.15µs, so ' +
						'~0.15ms at 5 minutes and 200 renders/min) and is self-limiting because the window slides.',
					{ unit: 'ms', min: 0 }
				),
				resetInterval: option(
					5 * MINUTE,
					'How often worker 0 resets the floor to 0 so the next claim re-derives it from the index.\n\n' +
						'This is the ONLY recovery for a due time written below the floor by something outside the ' +
						'plugin: the Harper operations API and the exported RenderSchedule REST surface both write ' +
						'the table with no plugin code in the path, so nothing in-process can observe them. The ' +
						'reset bounds that from permanent to at most one interval, and costs one seek from the ' +
						'absolute index minimum per interval per node (~6.25ms on an aged node — strictly cheaper ' +
						'than the periodic status scan this release deletes).\n\n' +
						'`0` disables it, which makes such a write strand its URL permanently and silently. Do not ' +
						'set 0 without reading the module comment in src/util/reconcile.js on how undiagnosable ' +
						'that state is.',
					{ unit: 'ms', min: 0 }
				),
				unpinAfter: option(
					HOUR,
					'How long one row may hold the floor before the claim path writes it forward by ' +
						'render.defaultInterval itself, so the queue can advance past it.\n\n' +
						'This is the bound on the cost described above. The floor cannot pass the oldest DUE row, and ' +
						'only that row’s own result moves it — but the highest-volume failure path (a renderer crash, ' +
						'navigation timeout or settle failure on a URL that still has a target) deliberately holds its ' +
						'lease and writes NO row, so it never moves. One such URL would pin the floor forever while ' +
						'dead index entries pile up above it at the full render rate: measured ~43ms per claim after a ' +
						'day, which is worse than the 6.25ms unfloored scan the floor exists to replace.\n\n' +
						'It is self-limiting and does not need a rate limit: it fires on the row HOLDING the floor, and ' +
						'unpinning one promotes the next, which must then hold for a full interval of its own. So the ' +
						'ceiling is one write per interval per node — 24 a day at the default — even during an outage ' +
						'in which every render fails. It is a fix for index degradation, not a way to keep throughput ' +
						'up.\n\n' +
						'No strike is counted and no retry semantics change: `strikes` is the target’s one shared ' +
						'counter that suppression and redirect verdicts DELETE targets on, so routing the failure path ' +
						'through it would walk the corpus toward deletion during a broad origin outage. The pushed URL ' +
						'is named in a warning, and a warning also fires earlier, once the pin outlives what ' +
						'render.failureRetry can account for.\n\n' +
						'Set it above `render.failureRetry.fastRetries × queue.jobLeaseTime` (the pin that lane holds ' +
						'legitimately) or healthy retries get pushed out. `0` disables the push entirely and restores ' +
						'the unbounded pin — the queue then waits on that row until it is repaired or deleted by hand.',
					{ unit: 'ms', min: 0 }
				),
			}
		),
		maxLeases: option(
			4096,
			'Lease slots in the node-local shared buffer that records which keys are currently being ' +
				'rendered.\n\n' +
				'Sizing: a 10-minute lease at 12,000 renders/hour is about 2,000 leases in flight fleet-wide, ' +
				'so ~500 per node on four nodes; 4,096 slots × 16 bytes is 64KB. A claim that cannot record ' +
				'a lease does NOT grant the job (a granted-but-unrecorded job is a double render and an ' +
				'untracked hold on the claim floor), so an undersized table shows up as claims granting fewer ' +
				'jobs than asked, with a warning naming the occupancy.\n\n' +
				'Restart-scoped: the buffer is sized once by the first allocation in the process, so a live ' +
				'change would give workers within one generation differently-sized views of the same named ' +
				'buffer. It is read at FIRST USE (the first claim or lease operation) rather than at module ' +
				'load, which is what makes a restart actually honour it: read at load it preceded the host’s ' +
				'options being applied, so this option had no effect at all and the size mismatch it warns ' +
				'about could not be detected.',
			{ min: 1, scope: 'restart' }
		),
		claimScanCap: option(
			1000,
			'Ceiling on schedule rows read per claim pass. A leased row keeps its overdue position in the ' +
				'nextRenderTime index now, so the pass reads past the in-flight pile ' +
				'(grantLimit + in-flight + grantLimit) to find grantable rows; this caps that read. If ' +
				'in-flight work exceeds the cap the pass can grant zero while work exists — it then reports ' +
				'`queued` (never `empty`, which would tell the whole fleet to go idle) and logs the occupancy.',
			{ min: 1 }
		),
	}),

	analytics: group(
		'Bot-request analytics. `bots` is the registry that gives crawlers a stable display name — ' +
			'remove an entry to stop tracking that bot under it. A UA the registry misses is not necessarily ' +
			"'other': with `deriveUnknownBots` on, a self-identifying crawler UA is labeled with the name it " +
			'declares, so a crawler the CDN starts forwarding before it’s registered still shows up in ' +
			'analytics under a usable name — promote recurring derived names into the registry to pin their ' +
			'display name. Only a UA that doesn’t self-identify at all becomes ‘other’, and ' +
			'`recordUnmatched` governs whether those are recorded.',
		{
			enabled: option(true, 'Record bot_request analytics at all.'),
			recordUnmatched: option(true, "Record requests whose UA yielded no name at all (as 'other')."),
			deriveUnknownBots: option(true, 'Label unregistered crawlers with the name their UA declares.'),
			bots: option(
				[
					// Entries must match the HTTP *request* User-Agent, not a robots.txt token.
					// Some crawler names exist only in robots.txt and never appear in a request UA
					// (Googlebot-News, Google-Extended, Applebot-Extended…) — an entry for one of
					// those never matches anything and just misleads readers of this list.
					//
					// Search engines
					{ name: 'Googlebot-Image', match: 'googlebot-image' },
					{ name: 'Googlebot-Video', match: 'googlebot-video' },
					{ name: 'Google InspectionTool', match: 'google-inspectiontool' },
					// the -Image/-Video variants need their own entries: the matcher requires a
					// boundary after the match, so bare `googleother` can't cross the hyphen
					{ name: 'GoogleOther-Image', match: 'googleother-image' },
					{ name: 'GoogleOther-Video', match: 'googleother-video' },
					{ name: 'GoogleOther', match: 'googleother' },
					{ name: 'Storebot-Google', match: 'storebot-google' },
					{ name: 'AdsBot-Google', match: 'adsbot-google' },
					{ name: 'Googlebot', match: 'googlebot' },
					{ name: 'Bingbot', match: 'bingbot' },
					{ name: 'DuckDuckBot', match: 'duckduckbot-https' },
					{ name: 'DuckDuckBot', match: 'duckduckbot' },
					{ name: 'Applebot', match: 'applebot' },
					{ name: 'YandexBot', match: 'yandexbot' },
					{ name: 'Baidu Spider', match: 'baiduspider' },
					{ name: 'SeznamBot', match: 'seznambot' },
					{ name: 'Naver Yeti', match: 'yeti' },
					{ name: 'Sogou Spider', match: 'sogou' },
					{ name: 'PetalBot', match: 'petalbot' },
					// AI crawlers & assistants
					{ name: 'GPTBot', match: 'gptbot' },
					{ name: 'OAI-SearchBot', match: 'oai-searchbot' },
					{ name: 'ChatGPT-User', match: 'chatgpt-user' },
					{ name: 'ClaudeBot', match: 'claudebot' },
					{ name: 'Claude-User', match: 'claude-user' },
					{ name: 'Claude-SearchBot', match: 'claude-searchbot' },
					{ name: 'PerplexityBot', match: 'perplexitybot' },
					{ name: 'Google-CloudVertexBot', match: 'google-cloudvertexbot' },
					{ name: 'Perplexity-User', match: 'perplexity-user' },
					{ name: 'CCBot', match: 'ccbot' },
					{ name: 'Bytespider', match: 'bytespider' },
					{ name: 'Meta-ExternalAgent', match: 'meta-externalagent' },
					{ name: 'Meta-ExternalFetcher', match: 'meta-externalfetcher' },
					{ name: 'FacebookBot', match: 'facebookbot' },
					{ name: 'Amazonbot', match: 'amazonbot' },
					{ name: 'DuckAssistBot', match: 'duckassistbot' },
					{ name: 'MistralAI-User', match: 'mistralai-user' },
					// SEO / site-audit tools
					{ name: 'AhrefsBot', match: 'ahrefsbot' },
					{ name: 'SemrushBot', match: 'semrushbot' },
					{ name: 'MJ12bot', match: 'mj12bot' },
					{ name: 'Rogerbot', match: 'rogerbot' },
					{ name: 'DotBot', match: 'dotbot' },
					{ name: 'Screaming Frog', match: 'screaming frog seo spider' },
					{ name: 'Botify', match: 'botify' },
					{ name: 'Deepcrawl', match: 'deepcrawl' },
					{ name: 'OnCrawl', match: 'oncrawl' },
					{ name: 'Sitebulb', match: 'sitebulb' },
				],
				'Crawler registry: { name, match } entries, where `match` is a case-insensitive substring of ' +
					'the User-Agent; longer matches win over shorter ones (e.g. `googlebot-image` before ' +
					'`googlebot`).',
				{ itemType: 'object' }
			),
		}
	),

	crawlStats: group(
		'Crawl breadth: distinct URLs crawled per bot per UTC day, via per-thread HyperLogLog ' +
			'sketches flushed to crawl_stats.CrawlSketch. Read merged through ' +
			'GET /prerender_admin/crawl-breadth. Recording is additionally gated by the analytics ' +
			'gate (no bot name → nothing to attribute a sketch to).',
		{
			enabled: option(true, 'Record crawl-breadth sketches at all.'),
			flushInterval: option(
				5 * MINUTE,
				'Per-thread sketch persistence cadence — the maximum sketch data lost on a crash.',
				{ unit: 'ms', min: SECOND }
			),
			retentionDays: option(90, 'Sketch rows older than this are swept at day rollover.', { min: 1 }),
			maxBotsPerThread: option(
				64,
				'Sketches are 16 KB each; this caps a UA-derivation flood from minting unbounded per-thread ' +
					"sketches. Overflow bots share one '~overflow' bucket for the day.",
				{ min: 1 }
			),
		}
	),
});

const clone = (value) => {
	if (Array.isArray(value)) return value.map(clone);
	if (value && typeof value === 'object') {
		const out = {};
		for (const [key, inner] of Object.entries(value)) out[key] = clone(inner);
		return out;
	}
	return value;
};

/** Fresh defaults derived from the schema (deep-cloned, safe to mutate). */
export const defaultConfig = () => {
	const build = (node) => {
		if (isOption(node)) return clone(node.default);
		const out = {};
		for (const [key, child] of Object.entries(node.children)) out[key] = build(child);
		return out;
	};
	return build(configSchema);
};

/**
 * Walk every option in the schema, calling `visit(path, node, inheritedScope)` with the
 * dotted path (no `prerender.` prefix) and the option's effective scope.
 */
const walkOptions = (visit) => {
	const walk = (node, path, inheritedScope) => {
		const scope = node.scope ?? inheritedScope;
		if (isOption(node)) return visit(path, node, scope);
		for (const [key, child] of Object.entries(node.children)) {
			walk(child, path ? `${path}.${key}` : key, scope);
		}
	};
	walk(configSchema, '', 'live');
};

/** Dotted paths of secret options (drives redaction). */
export const secretPaths = () => {
	const paths = [];
	walkOptions((path, node) => {
		if (node.secret) paths.push(path);
	});
	return paths;
};

/** Dotted paths of restart-scoped options (drives pending-restart detection). */
export const restartPaths = () => {
	const paths = [];
	walkOptions((path, node, scope) => {
		if (scope === 'restart') paths.push(path);
	});
	return paths;
};

/**
 * Map of legacy dotted path -> current dotted path, from `movedFrom` markers (a marker
 * on a group covers its whole subtree).
 */
export const aliasPaths = () => {
	const aliases = {};
	const walk = (node, path) => {
		if (node.movedFrom) aliases[node.movedFrom] = path;
		if (isGroup(node)) {
			for (const [key, child] of Object.entries(node.children)) walk(child, path ? `${path}.${key}` : key);
		}
	};
	walk(configSchema, '');
	return aliases;
};

const typeOf = (defaultValue) => (Array.isArray(defaultValue) ? 'array' : typeof defaultValue);

/**
 * JSON-serializable schema description for the management API / admin UI. Groups become
 * { kind: 'group', description, scope?, children }; options become
 * { kind: 'option', type, description, scope, default, ...validation/display hints }.
 * Secret defaults are all empty strings, so defaults are safe to serve as-is.
 */
export const describeConfigSchema = () => {
	const describe = (node, inheritedScope) => {
		const scope = node.scope ?? inheritedScope;
		if (isOption(node)) {
			const out = { kind: 'option', type: typeOf(node.default), description: node.description, scope };
			out.default = clone(node.default);
			for (const key of ['enum', 'unit', 'min', 'max', 'nonEmpty', 'itemType', 'secret', 'movedFrom']) {
				if (node[key] !== undefined) out[key] = node[key];
			}
			return out;
		}
		const children = {};
		for (const [key, child] of Object.entries(node.children)) children[key] = describe(child, scope);
		const out = { kind: 'group', description: node.description, children };
		if (node.scope) out.scope = node.scope;
		if (node.movedFrom) out.movedFrom = node.movedFrom;
		return out;
	};
	return describe(configSchema, 'live');
};

/** Look up the schema node (option or group) at a dotted path, or undefined. */
export const schemaNodeAt = (path) => {
	let node = configSchema;
	for (const segment of path.split('.')) {
		if (!isGroup(node)) return undefined;
		node = node.children[segment];
		if (!node) return undefined;
	}
	return node;
};

export { SECOND, MINUTE, HOUR, DAY };
