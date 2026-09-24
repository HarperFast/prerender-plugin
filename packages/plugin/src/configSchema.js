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
 *   uiEditable
 *             false — the console must refuse to write this option, and says so instead of
 *             offering a control. Inherited by a group's children, like `scope`. Reserved for
 *             options whose own edit would remove the ability to edit (`management.enabled`
 *             locks the console out; the `management.overrides` group is the machinery the
 *             console writes THROUGH). `secret: true` implies it — a secret comes from its
 *             environment variable, so there is nothing for a form to set.
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
					'queryParams?: string[], renderInterval?: number, discoverTargets?: boolean, demandFloor?: number, ' +
					'rawCache?: boolean }.\n\n' +
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
					'the other drift.\n\n' +
					'`demandFloor` (ms, prerender routes only) — the FASTEST cadence the demand ladder ' +
					"(`render.demand`) may grant this route's pages: rungs faster than the floor are unreachable " +
					'for them. This is how a deployment keeps fast global rungs for a corpus that earns them ' +
					'(listing pages that churn intraday) without a breadth-sweeping crawler promoting a much ' +
					'larger corpus onto the same rungs — a crawler that recrawls EVERYTHING daily makes ' +
					'"visited" true everywhere, and without a floor the ladder would grant the whole route the ' +
					'fast cadence at corpus scale. A floor at or above the granted cadence leaves the route ' +
					'resting at that cadence (single-rung). Stored rungs below a newly-raised floor read as the ' +
					'floor immediately and re-stamp on their next ladder decision. Live, like renderInterval.\n\n' +
					"`departureAction` (default 'none', prerender routes only) — what happens when a URL on " +
					'this route LEAVES the sitemap that listed it. A refresh unlinks such a target ' +
					'(`sitemapUrl -> null`) and leaves it rendering on its own cadence, which is the right ' +
					'default for a URL that merely stopped being declared. On a retail catalog it is not: a ' +
					'product that sells out or is withdrawn leaves the product sitemap the same day, while its ' +
					'page keeps serving the snapshot taken when it was still available.\n' +
					'  none    — the pre-0.68.0 behaviour. Unlink and nothing else.\n' +
					'  expire  — hard-expire the cached pages (past `page.swrTtl`, so they stop serving rather ' +
					'than serving stale) and let the URL re-render on its own cadence. Bots fall through to the ' +
					'origin in the meantime, which is correct but is origin load.\n' +
					'  render  — hard-expire AND file the URL to render at the current minute, so one render ' +
					'restores a correct page. This is the usual choice.\n' +
					'Departure is a statement about the DECLARATION, not the page: the origin typically still ' +
					'serves the URL with out-of-stock markup, so this is a RE-CHECK and the render’s own verdict ' +
					'decides what follows — a page that is merely unavailable re-renders and stays, and one the ' +
					'origin has actually retired answers 404/410 and is retired by the suppression path. Set it ' +
					'only on routes where departure carries that meaning: a product URL leaving a product ' +
					'sitemap says something about that product, while a listing URL leaving a paginated sitemap ' +
					'usually means the catalog was re-bucketed, and acting on it would expire current pages. ' +
					'Bounded and observable by `sitemap.departure`.\n\n' +
					'`discoverTargets` (default true, prerender routes only) — whether a bot visiting an UNKNOWN ' +
					'URL on this route creates a target for it. Set false on routes whose URL space is ' +
					'combinatorial (faceted navigation, filter/sort permutations): crawlers walking those links ' +
					'mint every novel combination into permanent render load, and the corpus grows without bound. ' +
					'Gated URLs are still served (origin proxy on a miss) — they just never enter the render ' +
					'rotation; the sitemap pipeline is unaffected, so declared URLs on the route still schedule. ' +
					'NOTE: flipping this false stops NEW targets only. Existing discovered targets keep rendering ' +
					'until deleted — see the discovery-purge admin action, and gate BEFORE purging or crawlers ' +
					're-mint what the purge removes.\n\n' +
					'`rawCache` (default false, prerender routes only, requires `render.raw.enabled`) — whether a ' +
					'MISS on this route stores the origin document it just fetched, so the next crawler asking ' +
					'for that URL is a cache hit instead of another origin round trip. It replaces an origin ' +
					'proxy, never a render: a stale or invalidated snapshot still proxies live. Pair it with ' +
					'`discoverTargets: false` — gated URLs are exactly the population this is for, and gating ' +
					'without it leaves them missing on every request forever. Enable it only on a route whose ' +
					'server-rendered document already carries its SEO surface; see `render.raw`.',
				{ itemType: 'object' }
			),
			discoveryBots: option(
				['*'],
				'Bots whose visits may create NEW targets (traffic discovery), by the bot name the analytics ' +
					"registry resolves (analytics.bots / derived names / the literal 'other'), compared " +
					"case-insensitively. ['*'] (default) trusts every bot; [] disables traffic discovery " +
					'site-wide (sitemap-only corpus); a list trusts exactly those names. Third-party crawlers ' +
					'with broken link extractors invent malformed URLs from rendered markup and re-request them ' +
					'forever — restricting minting to the search engines that matter ends that class at the ' +
					'source. Creation-only: serving, the demand ladder, invalidation reenqueue, and sitemap ' +
					'ingestion are all unaffected.',
				{ itemType: 'string' }
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
		default: option(
			['desktop', 'mobile'],
			'Device types every render job renders (one job per URL renders all of them). Empty is refused at ' +
				'apply time and the default kept: a job naming no device is one the browser cannot act on, and the ' +
				'schedule code would otherwise have to guess.',
			{ itemType: 'string', nonEmpty: true }
		),
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
			decodeReserved: option(
				[':', ',', '@'],
				'RESERVED characters to decode when they appear percent-encoded, so one logical URL ' +
					'spelled two ways is one cache key. The UNRESERVED set (letters, digits, `- . _ ~`) is ' +
					'always decoded — RFC 3986 says those escapes denote the same character, so it holds for ' +
					'every site. These do not: whether `%3A` and `:` name the same page is a fact about how ' +
					'your origin parses URLs.\n' +
					'  [":", ",", "@"] — the characters WHATWG `new URL()` and Chrome emit literally in a ' +
					'query, so a sitemap loc, a CDN-forwarded request and a Chrome redirect target agree (default)\n' +
					'  [] — decode nothing beyond the unreserved set (what a CDN does)\n' +
					'Structural characters are refused: decoding `&` `=` `+` `#` `/` `%` or `|` would reparse ' +
					'the URL into a different shape. Beware list-valued params — an API that reads `?ids=1,2,3` ' +
					'as three values and `%2C` as a literal comma inside one is a site where `,` must be removed ' +
					'from this list.',
				{ itemType: 'string', itemEnum: [':', ',', '@', ';', '$', "'", '(', ')', '!', '*'] }
			),
			trailingSlash: option(
				'strip',
				'Whether `/a/` and `/a` are one cache key.\n' +
					'  strip — drop a trailing slash on a non-root path, so they collapse (default)\n' +
					'  preserve — keep them apart, and answer each with what the origin says about it\n' +
					'No standard makes them one resource, and it can differ per ROUTE on one site: an origin ' +
					'that 404s or 403s the slashed form is giving a different answer, and stripping has us ' +
					'reply on its behalf with a page it refused. Check before choosing — request both ' +
					'spellings of a path on each route shape you serve.',
				{ enum: ['strip', 'preserve'] }
			),
			plusIsSpace: option(
				false,
				'Treat `%20` and `+` in the QUERY as one spelling of a space (folded to `+`), so a ' +
					'crawler-invented re-encoding is the same cache key as the URL your sitemap declares — ' +
					'not a second target rendering the same page forever.\n' +
					'Only enable it for an origin that FORM-DECODES its query, where `+` means space and the ' +
					'two spellings cannot name different resources. One request per allowlisted parameter ' +
					'settles that for every URL on the site: ask for a value containing a literal plus ' +
					'(`?f=A%2BB`), then the same value with a raw `+` (`?f=A+B`). If the second resolves as a ' +
					'SPACE (its canonical comes back `A%20B`), the origin form-decodes. If the two return ' +
					'different pages, leave this off — folding would serve one page under the other’s URL.\n' +
					'`%2B` is never folded: a literal plus inside a value is a different value.\n' +
					'MIRROR THIS IN THE RENDERER (`@harperfast/prerender-browser` `cacheKey.plusIsSpace`). It ' +
					'changes which URLs are the same key, so a renderer left unfolded reads every folded URL ' +
					'as canonicalizing elsewhere and retires it.\n' +
					'Enabling re-keys every affected URL: their cached pages are orphaned and re-render.'
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
						'changing which variable is read does not.',
					// FILE-ONLY, exactly like the secret it selects. Writing this from the console would set the
					// token by proxy: point it at an environment variable whose value you already know and the
					// secret becomes that value. That is the bypass `secret: true` exists to prevent, so the
					// pointer has to be as unwritable as the target.
					{ uiEditable: false }
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
					'precedence over `token`. Same boot-time caveat as `origin.securityToken.valueEnv`.',
				// File-only for the same reason as `origin.securityToken.valueEnv`: it sets the token by proxy.
				{ uiEditable: false }
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

	peerRescue: group(
		'Cluster peer rescue for the serve path. A cache serve reads the stored body before committing ' +
			'a status; when that LOCAL read fails — the blob file is gone (a dangling reference), or the ' +
			'read outlived `page.blobReadBudgetMs` (a base copy is streaming that blob) — the bytes are ' +
			'fetched from the URL’s residency owner over the cluster’s own HTTPS instead of proxying the ' +
			'origin. The owner granted every render claim for its keys, so its blob is a written original, ' +
			'never a received replica: it is the node most likely to hold complete bytes, a few ' +
			'milliseconds away, and the rescued response is the real prerendered snapshot rather than raw ' +
			'un-prerendered origin markup. The origin remains the backstop whenever the rescue misses ' +
			'(the owner is this node, unreachable, past `timeoutMs`, or its own read fails).\n\n' +
			'Enabling also serves the endpoint peers call (`GET /prerender_peer/page`), gated on `token`. ' +
			'Set the SAME token on every node: a node with a different or empty token answers 403/404 and ' +
			'its peers simply fall back to the origin, so a staggered rollout degrades softly rather than ' +
			'breaking serves.',
		{
			enabled: option(
				false,
				'Enable the rescue (and the endpoint that serves peers). Necessary but not sufficient — a ' +
					'non-empty `token` (or a `valueEnv` that resolves to one) is also required, so this cannot ' +
					'open an unauthenticated endpoint on its own.'
			),
			header: option('x-harper-peer-token', 'Request header carrying the shared token on peer calls.', {
				nonEmpty: true,
			}),
			token: option(
				'',
				'The shared cluster secret, identical on every node. **Required** — there is no ' +
					'unauthenticated mode: an empty token leaves the feature DISABLED (no rescues attempted, the ' +
					'endpoint answers 404) rather than serving cached pages to anyone who finds the path. ' +
					'Compared timing-safely. Prefer `valueEnv` so the secret stays out of config.yaml, and never ' +
					'commit a guessable placeholder.',
				{ secret: true }
			),
			valueEnv: option(
				'',
				'If set, the token is sourced from this environment variable at config-apply time and takes ' +
					'precedence over `token`. Same boot-time caveat as `origin.securityToken.valueEnv`.',
				// File-only for the same reason as `origin.securityToken.valueEnv`: it sets the token by proxy.
				{ uiEditable: false }
			),
			timeoutMs: option(
				500,
				'Deadline for the whole peer fetch (connect through body). A healthy rescue is a few ' +
					'milliseconds of intra-cluster round trip plus the owner’s sub-millisecond blob read, so ' +
					'this only trips when the owner is down, saturated, or mid-copy itself — at which point the ' +
					'origin fallback proceeds exactly as it would have without the rescue. Keep it in the same ' +
					'order as `page.blobReadBudgetMs`: the two are additive on the worst-case path ' +
					'(budget + rescue timeout + origin).',
				{ unit: 'ms', min: 1 }
			),
		}
	),

	management: group(
		'Management API, served at the fixed path `/prerender_admin` (resource endpoint names are ' +
			'fixed, like the database/table names). Gated on Harper’s own authentication: every endpoint ' +
			'except the login/session/index routes requires a `super_user`. The console UI consuming this ' +
			'API is the separate `@harperfast/prerender-console` component.',
		{
			enabled: option(
				true,
				'Serve the management API (and therefore anything the console can show).',
				// Not editable from the console for the obvious reason: one click would take the console
				// away, and getting it back needs a config-file edit. It stays live-reloadable from the
				// file, which is the right place for a switch whose off position is unreachable.
				{ uiEditable: false }
			),
			overrides: group(
				'Operator-set config overrides — the layer between the deployed `config.yaml` and the ' +
					'running config, stored one row per option path in `config.ConfigOverride` and ' +
					'written from the console.\n\n' +
					'Precedence is `schema defaults < config.yaml < these rows`. A deployed file change still ' +
					'takes effect for every option nobody has overridden, clearing an override reverts that one ' +
					'option to the deployed value, and clearing all of them returns the cluster to exactly its ' +
					'deployed state. The rows replicate, so the console writes once on whichever node it ' +
					'reached and every node converges.\n\n' +
					'This whole group is file-only: it is the machinery the console writes through, and ' +
					'editing the mechanism with the mechanism is how you end up locked out of both.',
				{
					enabled: option(
						true,
						'Honor stored overrides. FALSE IS THE KILL SWITCH: the rows are left in place but ' +
							'ignored, so the cluster runs exactly its deployed `config.yaml` again. This is the ' +
							'recovery path for an override that broke something, and the reason it has to live in ' +
							'the file — an override you need to undo is a poor thing to undo through the override ' +
							'layer.'
					),
					subscribe: option(
						true,
						'Watch the override table so a console edit converges in about a second instead of ' +
							'waiting out `syncInterval`. Subscribing requires the table’s audit log (Harper turns ' +
							'it on when you subscribe) and attaches its commit listener to the whole DATABASE’s ' +
							'audit store, which is why this table lives alone in `config`: every commit in a ' +
							'subscribed table’s database schedules a pass over the transaction log, so a ' +
							'subscription sharing a database with the hot target/schedule tables would tax every ' +
							'write to them. False leaves the backstop poll as the only path, which is correct ' +
							'behavior, just slower.'
					),
					syncInterval: option(
						30 * SECOND,
						'Backstop re-read cadence for the override table, run on EVERY worker rather than one per ' +
							'node: each worker holds its own config object, and the failure this covers — that ' +
							'worker\u2019s subscription is gone — is per-worker by definition. The live path ' +
							'is the subscription above; this exists so a subscription that was never established, ' +
							'or a worker whose boot read failed, still converges — the layer gets a bound on how ' +
							'stale it can be that does not depend on a callback firing. A re-read whose result is ' +
							'unchanged does not re-apply, so the steady-state cost is one bounded scan of a table ' +
							'with at most a few dozen rows. 0 disables the backstop, and the ceiling is node’s own ' +
							'timer limit of 2^31-1 ms (~24.8 days) — past it a timer fires every millisecond ' +
							'rather than never.',
						{ unit: 'ms', min: 0, max: 2147483647 }
					),
				},
				{ uiEditable: false }
			),
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
			snapshotTableCounts: option(
				true,
				'Include the four table counts (targets, pages, sitemaps, suppressed) in each backlog ' +
					'snapshot. The counts go through Harper’s getRecordCount, which on RocksDB tables past ' +
					'the sampling budget issues ONE synchronous native full-key iteration — measured 2.47s ' +
					'on a ~2.2M-key table, during which every request routed to that worker waits ' +
					'(harper-pro#664). False keeps the snapshot itself (the capped backlog/histogram walk and ' +
					'the queue_health gauges, which never take that walk) while the console shows the counts ' +
					'as unavailable — the setting for a deployment that disabled the whole snapshot to dodge ' +
					'#664 and thereby lost its below-floor detector.',
				{}
			),
			pageSize: option(
				50,
				'Rows per page for the console’s sitemap-entry and page-cache tables. Also bounds the ' +
					'per-entry state lookups a sitemap detail performs (point reads, one per row).',
				{ min: 1 }
			),
			analytics: group(
				'The console’s Traffic/queue-health charts: ONE bounded primary-key scan of this node’s ' +
					'`system.hdb_analytics` per refresh (never one scan per metric name — the table is ' +
					'indexed only by time, so a name is a scan and a series is a row), bucketed ' +
					'server-side and cached per worker. The console never polls; a scan happens only when ' +
					'an operator loads a view whose cached window has expired.',
				{
					enabled: option(true, 'Serve GET /prerender_admin/analytics and the console panels that read it.'),
					maxRange: option(
						DAY,
						'Ceiling on the window one analytics request may ask for. The scan cost scales ' +
							'directly with the window (rows = active metric combos × aggregate periods), so ' +
							'this is the knob that bounds the worst read an operator can trigger.',
						{ unit: 'ms', min: MINUTE }
					),
					cacheTtl: option(
						MINUTE,
						'How long a scanned window is served from the per-worker cache before a refresh ' +
							're-scans. Matches Harper’s default analytics aggregation period — refreshing ' +
							'faster cannot surface new rows, only repeat the scan.',
						{ unit: 'ms', min: 0 }
					),
					scanCap: option(
						150000,
						'Ceiling on rows one analytics scan walks. The walk runs NEWEST-FIRST, so past the ' +
							'cap it is the oldest end of the window that is shed, and the response reports ' +
							'the window it actually covered rather than presenting a partial range as the ' +
							'full one.',
						{ min: 1000 }
					),
				}
			),
		}
	),

	page: group('Cached-page lifetimes.', {
		ttl: option(DAY, 'Default cached-page TTL.', { unit: 'ms', min: 1 }),
		minTtl: option(6 * HOUR, 'Floor for sitemap-derived TTLs.', { unit: 'ms', min: 1 }),
		swrTtl: option(3 * HOUR, 'Stale-while-revalidate window.', { unit: 'ms', min: 0 }),
		blobReadBudgetMs: option(
			500,
			'How long a cache serve may spend reading the stored body before giving up and proxying to ' +
				'the origin instead.\n\n' +
				'The body is read to completion before the response commits a status, so that a record whose ' +
				'blob file is gone becomes an origin serve rather than a truncated 200. Without a budget that ' +
				'read inherits Harper’s own retry window (`storage_blobReadTimeout`, default 20s): a blob ' +
				'whose bytes are still arriving — which any base copy produces in quantity — puts the reader ' +
				'into an incomplete-content retry loop, and the crawler waits it out. Measured on a 4-node ' +
				'production cluster mid-copy: a cohort of cache hits averaging 13.6s, p95 17.5s, ~13% of hits ' +
				'on the worst node, while the same node’s median hit was 2.3ms.\n\n' +
				'A healthy read is nowhere near this: p50 0.75ms and p99 0.94ms for a ~223KB body on cold ' +
				'NVMe, so 500ms is ~500x the p99 and only a blob that is genuinely stuck can trip it. Keep it ' +
				'BELOW typical origin latency (~500-600ms here) so falling back is faster than waiting; ' +
				'raising it past `storage_blobReadTimeout` disables it entirely. 0 disables the budget and ' +
				'restores the unbounded wait.\n\n' +
				'Capped at 2147483647 because `setTimeout` stores its delay as a signed 32-bit int: a larger ' +
				'value does not mean "effectively never", it makes Node warn and fire the callback after 1ms — ' +
				'so a fat-fingered budget would time out EVERY cache hit and send all traffic to the origin. ' +
				'The cap turns that into a rejected value that keeps the default.',
			{ unit: 'ms', min: 0, max: 2147483647 }
		),
	}),

	invalidation: group(
		'Bulk cache invalidation. An invalidation records ONE ROW naming a scope and an instant; from then ' +
			'on, any cached page in that scope rendered before that instant stops being served and bots get ' +
			'the origin instead, until the page re-renders on its normal cadence.\n\n' +
			'Nothing is rewritten — not the cached pages, not the render schedule — so recording one costs a ' +
			'single 102-byte write instead of the ~61.8MB of audit per node a corpus rewrite costs, and UNDO ' +
			'IS INSTANT: delete the row and every page still inside its own expiry/stale-while-revalidate ' +
			'window serves again on the next request. Pages already past that window cannot come back, ' +
			'because their own lifetime expired while the invalidation was active; that asymmetry is inherent ' +
			'to not rewriting anything.\n\n' +
			'A scope is `all` or one prerender route from ingress.routes, written `route:<match>:<path>`. ' +
			'There are deliberately no free-text prefix scopes: a prefix cannot be checked against a closed ' +
			'set, so a typo would record a row that reports as applied and matches nothing — the worst ' +
			'failure available, because the mitigation appears to have worked. For a narrower blast radius, ' +
			'declare a narrower route.\n\n' +
			'TWO THINGS THIS CANNOT DO, both worth knowing before you rely on it. THE CDN EDGE IS NOT ' +
			'INVALIDATED and keeps its own TTL, and neither is a copy a crawler already holds. And origin ' +
			'markup carries correct price, availability, canonical, title and meta description, but not ' +
			'reviews or most images — so an invalidated page serves a thinner document than a rendered one.',
		{
			enabled: option(
				true,
				'Consult invalidation rows when serving, and allow the API to record them.\n\n' +
					'FALSE IS A KILL SWITCH, not a feature flag: every active invalidation stops applying at once ' +
					'and the whole corpus serves pre-invalidation bytes again. It exists because at 3am you want a ' +
					'way to take a new mechanism out of the serve path — but while any row exists it is reported as ' +
					'a config warning, a log line and a console banner, because silently serving content somebody ' +
					'deliberately invalidated is the one outcome this feature must never produce.'
			),
			pad: option(
				10 * MINUTE,
				'Added to `invalidatedAt` before comparing, so the comparison errs toward invalidating.\n\n' +
					'It covers two things. Cross-node clock skew: a page’s `lastCached` is stamped by whichever ' +
					'node rendered it and the epoch by whichever node recorded it. And — the certain one — renders ' +
					'ALREADY IN FLIGHT: a job claimed a moment before you invalidate fetched pre-change content but ' +
					'stamps `lastCached` at completion, so with no pad that page outlives the invalidation for a ' +
					'full render interval. That window is legitimately as long as `queue.jobLeaseTime` (a job may ' +
					'post back any time inside its lease, and does under backlog — exactly the state incidents ' +
					'create), so keep this at or above jobLeaseTime; a smaller value is reported as a config ' +
					'warning. The cost of over-including a page is one extra render of it.',
				{ unit: 'ms', min: 0 }
			),
			lkgMaxAge: option(
				5 * MINUTE,
				'How long a worker may reuse its last successful resolution when a read fails.\n\n' +
					'Past this, resolution fails OPEN — serving from cache as though nothing were invalidated — ' +
					'rather than trusting a stale answer. Both halves matter: without a bound, one transient read ' +
					'error after a clear would pin a worker on a deleted epoch for the rest of its life, with the ' +
					'console showing nothing active and offload quietly sagging. Failing open is the right default ' +
					'because this table’s normal state is EMPTY, so "unknown" almost certainly means "nothing is ' +
					'invalidated", and failing closed would turn a cosmetic storage fault into a total offload ' +
					'outage. Set 0 to fail open on the first read error.',
				{ unit: 'ms', min: 0 }
			),
			maxScopes: option(
				16,
				'Ceiling on simultaneously active scopes. Bounds the console walk and the operator surface — NOT ' +
					'the serve-path read, which is at most two point reads by known key (`all` plus the one route ' +
					'the request matched) however many rows exist.',
				{ min: 1 }
			),
			verification: group(
				'PER-PAGE EXEMPTION. Let a page an invalidation would refuse be served anyway when the change ' +
					'probe has PROVED it is still current — `pageCheck` compared the cached page\u2019s own claims against ' +
					'the origin after the epoch and they agreed.\n\n' +
					'WHY THIS EXISTS. A bulk invalidation refuses everything in scope rendered before the epoch because ' +
					'it cannot tell what actually changed. Measured during a route-wide trip on a four-node deployment, ' +
					'only 22-29% of the scope had genuinely moved; the rest were origin-proxied for up to a full render ' +
					'interval while being byte-for-byte correct. This turns "predates the epoch" into "lacks evidence", ' +
					'which is the question the invalidation was always asking.\n\n' +
					'WHAT IT ASSERTS, EXACTLY: the fields the probe rule watches still match. Nothing more. A promo flip ' +
					'also moves badges, banners and copy no probe looks at, so a verified page is "price and availability ' +
					'confirmed", never "fresh". Judge whether that is the right bar for what you invalidate FOR.\n\n' +
					'REQUIRES `changeProbe.pageCheck` on the rule whose `invalidateScope` recorded the invalidation. A ' +
					'signature match alone is NOT sufficient and is deliberately not accepted: it says the origin has not ' +
					'moved since the last probe, which says nothing about whether the cached page was ever right.',
				{
					enabled: option(
						false,
						'Off by default, like `invalidation.reenqueue.enabled` and `render.reconcile.enabled` \u2014 enable it ' +
							'after one rehearsal, not on the deploy that introduces it. While off, nothing is written and ' +
							'nothing is read: every page is refused on the epoch comparison alone, exactly as before.\n\n' +
							'EVERY FAILURE FAILS CLOSED. Absent row, unprobed URL, failed probe, read error, unreadable ' +
							'timestamp \u2014 all mean NOT VERIFIED, and the page keeps being proxied. That is the opposite of ' +
							'`invalidation.lkgMaxAge`, which fails OPEN, and the asymmetry is the point: an unknown epoch ' +
							'almost certainly means "nothing is invalidated", while unknown evidence means "I cannot prove ' +
							'this page is current".'
					),
				}
			),
			reenqueue: group(
				'DEMAND-DRIVEN HEAL. When an invalidation is what made a request non-servable, lower that URL’s ' +
					'due time so the pages bots actually crawl heal first instead of waiting out their cadence in ' +
					'crawl order. The request itself is the trigger — no timer, no table scan, no cursor — and only ' +
					'the node that OWNS the key by residency acts, because the claim floor a lowered due time has to ' +
					'move is a node-local shared buffer that a write from another node cannot reach.\n\n' +
					'THERE IS DELIBERATELY NO CORPUS-WIDE SWEEP, and there will not be one. At a measured fleet ' +
					'ceiling of 71,289 renders/hr the 1,530,046-key long-tail corpus floors a full re-render at 21.5h ' +
					'at 100% utilisation — against the 48h those pages wait anyway, with measured utilisation already ' +
					'98% and a 3.05h standing backlog — while rewriting the corpus costs ~61.8MB of audit per node ' +
					'that pacing provably does not reduce (batching kept 162 B/write, took 8.9x longer and made ' +
					'claim’s max latency WORSE). Cadence-heal plus this accelerator is the whole mechanism.\n\n' +
					'Scale, so the ceilings below read as the small numbers they are: ~4,000 bot requests/day ' +
					'cluster-wide against 1.6M cache keys, of which crawlers request about 0.25%.',
				{
					enabled: option(
						false,
						'Off by default, like `render.reconcile.enabled`: enable it after one rehearsal, not on the ' +
							'same deploy that introduces it. While off, an invalidation adds NOTHING to the queue — zero ' +
							'schedule writes, zero audit, zero claim-scan work — and every page heals on its own cadence.'
					),
					spreadWindow: option(
						15 * MINUTE,
						'Jitter window a lowered due time lands in: `now + hash(url) % spreadWindow`, seeded off the ' +
							'URL half of the cache key so a page’s device variants land on the SAME minute (see ' +
							'util/time.js — de-aligned variants show a content change on one device and not the other, ' +
							'permanently, cycle over cycle).\n\n' +
							'NEVER "now". Collapsing due times onto one instant piles rows exactly where the claim scan ' +
							'seeks: measured, that takes the claim scan from 0.36ms to 11.59ms (32x), and the scar clears ' +
							'only on the next compaction of that store, which needs write pressure.\n\n' +
							'MUST BE >= `queue.jobLeaseTime`, and a smaller value is reported as a config warning and ' +
							'then clamped up to it — because a narrow window is a smaller version of the same pile, not ' +
							'because the two quantities are coupled. `queue.jobLeaseTime` is floored at 2 minutes, which ' +
							'makes it the smallest spread this system already trusts. (Overwriting a render in flight is a ' +
							'DIFFERENT hazard and is closed elsewhere, exactly: the accelerator refuses outright when any ' +
							'device key of the URL holds a live claim lease.)',
						{ unit: 'ms', min: 0 }
					),
					crossNode: group(
						'FORWARD A HEAL TO THE KEY\u2019S OWNER instead of discarding it. Without this, a heal is refused ' +
							'outright whenever the crawler landed on a node that does not own the key by residency \u2014 measured ' +
							'at 84-85% of all attempts on a four-node deployment, because bot traffic lands where the CDN\u2019s ' +
							'geo-routing sends it while residency is hashed over the key, and the two are independent. The ' +
							'module\u2019s "crawlers revisit" fallback assumes those two distributions match; where traffic is ' +
							'concentrated on one node they do not, and a quarter of the corpus never heals on demand at all.\n\n' +
							'THE OWNER DECIDES, this only carries the request. Three of the accelerator\u2019s guards \u2014 the live-lease ' +
							'check, the authoritative schedule read, and therefore "never raise a due time" \u2014 can only be ' +
							'evaluated on the owner, so writing from the receiving node instead would trade coverage for ' +
							'delayed renders. (The floor objection people reach for first is void: `claim` seeks from a floor ' +
							'clamped to `now - claimFloor.guard`, so any due time at or after the current minute is claimable ' +
							'on any node.)\n\n' +
							'COST IS BOUNDED BY `maxPerMinute`, NOT BY TRAFFIC: the slot is reserved before the call, so this ' +
							'is at most that many requests per node per minute however much bot traffic arrives.\n\n' +
							'REQUIRES `peerRescue.token` and `peerRescue.header`, reusing that shared cluster secret rather ' +
							'than minting a second one \u2014 same trust boundary (node-to-node, on the serve path, with no user ' +
							'credential available to forward), and one secret to rotate instead of two. With either unset this ' +
							'is inert and the endpoint answers 404.',
						{
							enabled: option(
								false,
								'Off by default, like the accelerator itself. While off, a heal for a key this node does not own ' +
									'is refused as `not-owner` exactly as before, and the `/prerender_peer/heal` endpoint does not ' +
									'exist.'
							),
							timeoutMs: option(
								2000,
								'Deadline for one forwarded heal. Generous is pointless here: the request that triggered it has ' +
									'already been answered, this is a repair running detached, and a peer that cannot answer in ' +
									'seconds will not heal anything useful. A timeout is counted as `forward-failed`.\n\n' +
									'Capped at the 32-bit signed maximum because this value reaches `setTimeout`: past that Node ' +
									'emits TimeoutOverflowWarning and fires the timer IMMEDIATELY, so a fat-fingered value would ' +
									'abort every forwarded heal on the spot rather than allowing a long one. The cap turns that ' +
									'into a rejected value that keeps the default.',
								{ unit: 'ms', min: 1, max: 2147483647 }
							),
						}
					),
					maxPerMinute: option(
						10,
						'Per-node ceiling on accelerated REQUESTS per minute, shared across every worker on the node ' +
							'(one minute-bucketed counter in a shared buffer). One accelerated request writes at most one ' +
							'schedule row per schedule row the URL has — normally just its URL row; plus any pre-0.66.0 ' +
							'per-device row that has not yet converted, and a per-device row for the served device when ' +
							'that one is merely `supported` — so the write ceiling is this number times those rows.\n\n' +
							'Sized so its CEILING is defensible, not just its typical. 10/min/node is 14,400 ' +
							'requests/node/day ≈ 14,400 schedule writes ≈ 1.2MB of audit/node/day once the corpus holds one ' +
							'row per URL (it was ~28,800 writes / 2.3MB at one row per device), and each write is a job that ' +
							'renders every device — about 7% of measured spare fleet render capacity (~792,700 renders/day ' +
							'spare against a 1,710,936/day ceiling and ~918,000/day of baseline cadence demand) — against a ' +
							'measured demand of roughly 1,000 owner-node candidate requests/day CLUSTER-WIDE, i.e. ~14x ' +
							'headroom. Raising it toward 120 would authorise ~87% of all spare fleet capacity, which is why ' +
							'it is not the default.',
						{ min: 1 }
					),
				}
			),
		}
	),

	changeProbe: group(
		'CHANGE-DRIVEN RE-RENDERING. Instead of guessing how often a page changes with an interval, ask ' +
			'the origin — cheaply — whether the fields bots care about actually changed, and re-render only ' +
			'then. A probe is one small HTTP request per URL: either an endpoint the page itself consults ' +
			'(`source: request` — e.g. a product price/availability API, typically thousands of times ' +
			'cheaper than a render), or the page document’s own schema.org JSON-LD Product offers ' +
			'(`source: document` — nothing site-specific to configure). The extracted fields are reduced to ' +
			'a signature stored on the target; a later probe that observes a different signature expires the ' +
			'cached pages and files the URL due now.\n\n' +
			'TWO CADENCES FOR TWO KINDS OF CHANGE. The rolling SWEEP (sweepInterval) walks the whole ' +
			'registry and catches continuous, per-URL drift — availability sell-through, item-level price ' +
			'moves. The CANARY (canary.*) probes a small fixed cohort every few minutes, because commerce ' +
			'price does not drift — it STEPS at promotional events, most of a catalog at once, which a ' +
			'sample of hundreds sees within minutes while a full sweep is still hours away. On a canary ' +
			'trip the rule’s `invalidateScope` records a bulk invalidation: pre-change snapshots stop ' +
			'serving immediately (bots get origin content, which is correct by definition) while ' +
			're-renders refill on their own machinery. Detection and response are different mechanisms on ' +
			'purpose — re-rendering a large corpus takes the fleet hours; invalidating it takes one row.\n\n' +
			'A PROBE FAILURE CHANGES NOTHING, by design: fetch errors, non-2xx, unparseable bodies and ' +
			'extractions that yield no values leave the stored signature untouched and trigger nothing. ' +
			'The probe is an accelerator on top of the baseline render cadence, never a gate on it — the ' +
			'failure mode to survive is the origin replatforming under a rule, which surfaces as a high ' +
			'probe_failed share and a loud log line, not as schedule churn. Probes run owner-scoped on ' +
			'worker 0 of every node (each node probes the URLs it owns), carry the same User-Agent and ' +
			'security token as every other origin fetch, and are rate-capped per node — AGREE THE RATE ' +
			'WITH WHOEVER RUNS THE ORIGIN before enabling a sweep over a large corpus: probe endpoints ' +
			'are typically uncached, so every request is origin backend work.',
		{
			enabled: option(false, 'Master switch. Off = no probes, no timers, nothing stored.'),
			dryRun: option(
				true,
				'Probe, count and log every decision — but re-render nothing and invalidate nothing. ' +
					'Signatures ARE written in dry run (the demand-ladder precedent), so each pass reports fresh ' +
					'changes and a measured week converges on the true change rate instead of re-reporting the ' +
					'same delta. Default ON: enabling `enabled` alone changes no schedule until this is turned off.'
			),
			rules: option(
				[],
				'What to probe and how — an array of rule objects; the FIRST rule whose pathPattern matches a ' +
					'target’s URL path claims it (order most-specific first). Invalid rules are dropped ' +
					'individually with a warning, like ingress.routes entries.\n\n' +
					'Rule shape:\n' +
					'  pathPattern      (required) regular expression matched against the URL path; capture ' +
					'groups feed the template.\n' +
					'  source           "document" (default): GET the page itself and extract its JSON-LD ' +
					'Product offers (price, currency, availability) — generic, works for any site with ' +
					'standard product markup. "request": probe a configured endpoint instead.\n' +
					'  request.urlTemplate  (request mode, required) absolute URL with $1..$9 replaced by ' +
					'pathPattern’s capture groups, URI-component-encoded. The origin security token and the ' +
					'staging-IP pin are attached ONLY when this endpoint shares the probed page’s origin — a ' +
					'third-party host gets a plain fetch, never the bypass secret. Redirects are not followed ' +
					'(a redirecting endpoint is a failed probe, and the failure metrics say so).\n' +
					'  request.method   GET (default) | POST.\n' +
					'  request.headers  extra request headers, e.g. { accept: "application/json" } — many JSON ' +
					'endpoints require an explicit accept and fail with a 200-shaped error without it.\n' +
					'  request.body     request body string (e.g. "{}").\n' +
					'  extract          (request mode, required) value paths into the JSON response, e.g. ' +
					'"payload.products[0].prices[0].salePrice" — the extracted values ARE the watched content; ' +
					'everything else in the response is ignored. A path may end at an object or array, which is ' +
					'signed whole, and `[*]` projects the rest of the path over every element of an array ' +
					'("payload.products[0].variants[*].availability" -> one value per variant) — the way to watch ' +
					'per-variant state without signing fields that move on their own ' +
					'(inventory counters, store data). A trailing tuple, `[*].{a,b.c}`, projects each element to ' +
					'`[a, b.c]` (dotted inner paths, no brackets) so per-variant fields stay attached to their key — ' +
					'e.g. "payload.products[0].variants[*].{sku,availability,price.value}" for a `skus` page check. ' +
					'Projections (tuples included) are sorted, so a reordered array is not a change. An extraction where every path yields null is a ' +
					'FAILED probe, never a new signature, so an endpoint shape change cannot mass-trigger.\n' +
					'  EDITING A RULE. The rule’s observation (endpoint, method, headers, body, extract, ' +
					'statusSignals) is fingerprinted and stored beside every baseline. Change any of it and each ' +
					'matched URL is RE-BASELINED on its next probe — new observation stored, nothing compared, ' +
					'nothing triggered, not counted by the canary — instead of the new signature shape reading as ' +
					'100% of the corpus changing at once. A rule edit therefore costs one pass without detection ' +
					'for that rule and needs no dry-run cycle. APPENDING paths to the end of `extract` is the ' +
					'exception and costs no blind pass: a baseline taken before the append is still compared on ' +
					'the slots it has — changes trigger, pageCheck applies, the canary counts it — and the same ' +
					'write upgrades it to the full observation (counted as `extended` in the pass record). The ' +
					'appended path has no baseline until that write, so a change in it alone is detected from ' +
					'the following pass. Removing, reordering or editing an existing path, or appending while ' +
					'changing anything else above, is a full re-baseline. Label, pathPattern, invalidateScope ' +
					'and pageCheck are not part of the fingerprint: they change what is matched or done, not ' +
					'what is observed.\n' +
					'  statusSignals    optional [{ status, signature, contains? }] — statuses this endpoint uses ' +
					'to SAY something rather than to fail, mapped to a fixed signature. An endpoint that answers ' +
					'a legitimate state with an error status (most usefully "no longer available" as a 4xx with ' +
					'a code in the body) is otherwise read as a failed probe, which leaves the signature ' +
					'untouched and triggers nothing — so the one transition that most needs detecting, ' +
					'available -> unavailable, is exactly the one the probe cannot see. The signature is an ' +
					'opaque literal compared for equality like any other, so the transition is detected in BOTH ' +
					'directions. `contains` guards on a body substring (match the endpoint’s error CODE, not its ' +
					'prose, which gets reworded). Only non-2xx statuses may carry a signal; a 2xx is extracted ' +
					'normally. A declared signal outranks the origin-pushback classification, so do not declare ' +
					'one for 429/503 unless that status really is a state on this endpoint rather than an ' +
					'overloaded origin. CAUTION: if the endpoint starts answering the signaled status for ' +
					'EVERYTHING, every matched URL flips to the same signature at once — bounded by ' +
					'`maxTriggersPerSweep`, and the canary treats it as the mass change it looks like.\n' +
					'\n\nPAGE CHECK (`pageCheck`). The comparison above asks "did the origin change since I last ' +
					'looked", which is structurally blind to a value that changes and changes BACK between two ' +
					'passes — and if a render landed inside that window, the cached page keeps the transient value ' +
					'until its interval expires (measured at ~2.7% of served product pages on one deployment, all ' +
					'of them a page reading OutOfStock for something the origin says is available). Set ' +
					'`pageCheck: { enabled: true, priceFrom: <i>, availableFrom: <i> }` and the render path records ' +
					'what each page CLAIMS, so the pass can also ask "does the page still agree with the origin". ' +
					'The two indices are positions in this rule\u2019s own `extract` array — site-specific by ' +
					'nature, since only the operator knows which field is the price their page prints — and the ' +
					'block is dropped whole if either is out of bounds, because a half-applied mapping compares the ' +
					'wrong column. REQUIRES @harperfast/prerender-browser >= 1.20.0, which posts the page\u2019s offers ' +
					'with the render result: there is deliberately NO fallback to parsing the stored HTML (a regex scan ' +
					'and JSON parse of a ~1MB document on the hottest write path, to recover what the browser already ' +
					'had structured), so against an older renderer pageCheck records nothing and detects nothing \u2014 ' +
					'logged hourly rather than failing silently. `source: request` only: in document mode the stored signature already IS the ' +
					'page\u2019s offers. A page yielding no Product offers records nothing, exactly as a failed ' +
					'probe changes nothing, so a markup change cannot make every page look like a disagreement \u2014 ' +
					'and each dimension compares only when BOTH sides make a readable claim (availability must ' +
					'reduce to a recognized schema.org verdict on the page, and at the endpoint to a boolean, an ' +
					'availability word, or a `[*]` list of per-variant words; price must parse as a number on the ' +
					'page), so an unrecognized vocabulary or price format degrades to detecting nothing rather ' +
					'than expiring everything. Availability words are matched after dropping case and separators ' +
					'(InStock, IN_STOCK, "In Stock" and https://schema.org/InStock are one word); the built-in ' +
					'vocabulary is Google’s (InStock, InStoreOnly, OnlineOnly, LimitedAvailability, Available / ' +
					'OutOfStock, SoldOut, Discontinued, Unavailable), and `pageCheck.availableValues` / ' +
					'`pageCheck.unavailableValues` (arrays of words) extend or override it per rule for an endpoint ' +
					'with its own vocabulary. A per-variant list reads in stock when ANY variant is, exactly as the ' +
					'page’s offers are read. ' +
					'Detection is one extra node-local write per render and no extra origin traffic.\n' +
					'\n\nTHE PAGE RECORD (`pageCheck.fields`). The claim pair above generalizes to every field a page ' +
					'visibly states. With @harperfast/prerender-browser >= 1.37.0 each render also posts `pageFacts` ' +
					'(canonical, title, metaDescription, h1, product.name, product.brand, product.image, ' +
					'product.rating.value, product.rating.count, product.offers, breadcrumbs), and a rule that maps ' +
					'fields stores them per URL and compares each mapped field on every probe. That does three things: ' +
					'(1) a page that DISAGREES with the origin on any mapped field is re-rendered, like a claim-pair ' +
					'disagreement; (2) an origin CHANGE that the cached page already shows (a cadence render landed after ' +
					'it) is NOT re-rendered — every changed slot must be a mapped slot whose record agrees with the new ' +
					'value, and the baseline simply moves (counted `caughtUp`); (3) with `ignoreChanges`, changes to ' +
					'fields the page cannot show stop re-rendering at all. Shape: `pageCheck: { enabled: true, ' +
					'fields: [{ slot: <i>, fact: "<fact>", compare: "<comparator>" }, ...], ignoreChanges: [<i>, ...] }` ' +
					'(both, like the claim pair, apply only while `enabled` is true), where `slot` indexes ' +
					'`extract`. The comparators are a closed set, each applying to certain facts: ' +
					'"text" (exact after Unicode NFC, whitespace collapse and trim — no case folding and NO HTML ' +
					'stripping: an endpoint’s description may carry markup the page’s meta tag repeats verbatim), ' +
					'"path" (URL path only — origin, query and fragment ignored, a relative value resolved against the ' +
					'page URL; for canonical and product.image, whose URLs typically differ by size parameters alone), ' +
					'"number" (numeric equality, "4.0" = 4; optional `tolerance`), "priceSet" (the endpoint’s price, or ' +
					'a list of them, against the SET of prices the page’s offers print — set equality, so use "skus" ' +
					'when the page lists fewer offers than the endpoint has variants), "names" (an ordered list of ' +
					'strings, or of objects carrying `nameKey`, default "name", matched against the TAIL of the page’s ' +
					'breadcrumbs — a leading home crumb needs no configuration; extract the list itself, not a `[*]` ' +
					'projection, since projections are sorted) and "skus" (per-variant tuples from a `[*].{…}` projection ' +
					'against the page’s offers keyed by SKU, over the SKUs both list; `tuple` names each tuple ' +
					'position, default ["sku", "availability", "price"]). EVERY COMPARATOR FAILS TOWARD NO CLAIM: null, ' +
					'absent or unparseable on either side is not compared, never a disagreement, and never evidence ' +
					'that a page caught up. A bad entry is dropped alone with a warning. A mapping that is wrong anyway ' +
					'is caught by `changeProbe.mappingGuard`. The record is stored only for a rule that maps fields, ' +
					'from the first device variant, and only when the render stored every default device (otherwise ' +
					'null — a partial render cannot vouch for the device page it did not replace); records over 16 KB ' +
					'are refused, not truncated. `pageCheck` may carry `fields` and/or `ignoreChanges` without ' +
					'priceFrom/availableFrom. Like the rest of pageCheck, none of this is in the rule fingerprint: ' +
					'adding or editing a mapping re-baselines nothing.\n' +
					'  pageCheck.ignoreChanges  extract indices whose origin changes never trigger a re-render — ' +
					'fields the page cannot show (an inventory counter the endpoint returns beside the price). A change ' +
					'confined to them writes the new baseline and triggers nothing (counted `ignored`), and the canary ' +
					'does not count it as a change, so a site-wide edit of such a field cannot trip a bulk ' +
					'invalidation. A status-signal literal is a state, not slots, and is never ignored.\n' +
					'  PER-SLOT STATS. Pass records decompose `changed` by slot (`slotChanges`) and page mismatches by ' +
					'mapped field (`fieldMismatch`), in `GET /prerender_admin/change-probe` and the pass log line.\n' +
					'  invalidateScope  optional invalidation scope ("all" or "route:<match>:<path>") the canary ' +
					'records on a mass change. Empty = the canary detects and logs only.\n' +
					'  label            optional name for logs and the admin surface.',
				{ itemType: 'object' }
			),
			mode: option(
				'interval',
				'How the sweep is scheduled.\n\n' +
					'"interval" (default) fires a discrete pass every `sweepInterval`. That model asks the ' +
					'operator to solve `sliceSize / effectiveRate <= sweepInterval` BY HAND, and to re-solve ' +
					'it every time the corpus grows or the origin has a bad week — because when the answer ' +
					'stops holding, the overrunning pass is simply skipped (`sweepRunning` is still set) and ' +
					'the cadence silently doubles with nothing in metrics saying so. It also idles: a slice ' +
					'that takes 9h of a 12h interval leaves 3h in which nothing is probed at all, so ' +
					'detection latency is bimodal rather than uniform.\n\n' +
					'"continuous" never stops walking and never re-solves anything: it derives its rate each ' +
					'batch from remaining rows over remaining budget (`cycleTarget`), so corpus growth and ' +
					'time lost to backoff are absorbed as they happen. `ratePerSecond` stays a hard ceiling. ' +
					'A target that cannot be met at the ceiling is reported (`probe_cycle_behind`) rather ' +
					'than silently missed — which is the whole point of the mode.\n\n' +
					'"anchored" runs ONE full pass a day, starting at `anchorTime` in `anchorTimezone` and ' +
					'paced to `anchorWindow` (0 = as fast as `ratePerSecond` allows). For an origin whose content ' +
					'moves on a schedule — a retailer whose prices change only at its own midnight — this puts ' +
					'the walk right after the change instead of spreading it over the day, so detection latency ' +
					'is the pass length rather than up to a cycle, and the corpus is current for the day by the ' +
					'time the pass ends. No pass runs at boot in this mode (baselines persist; a restart waits ' +
					'for the anchor). The canary keeps its own cadence, so an off-schedule mass change is still ' +
					'caught; only the full walk is anchored.\n\n' +
					'Switching is safe in every direction and takes effect on the next config apply; a pass ' +
					'in flight finishes under the rules it started with.',
				{ enum: ['interval', 'continuous', 'anchored'] }
			),
			anchorTime: option(
				'00:15',
				'ANCHORED MODE ONLY: local time of day ("HH:MM") the daily pass starts, interpreted in ' +
					'`anchorTimezone`. Put it just AFTER the origin’s scheduled change lands (a few minutes ' +
					'after its midnight, not at it) so the first probes see the new state rather than the ' +
					'tail of the old one.',
				{ nonEmpty: true }
			),
			anchorTimezone: option('UTC', 'ANCHORED MODE ONLY: IANA timezone `anchorTime` is interpreted in.', {
				nonEmpty: true,
			}),
			anchorWindow: option(
				0,
				'ANCHORED MODE ONLY: wall-clock budget the daily pass paces itself to, like `cycleTarget` ' +
					'for one pass. 0 (default) runs at the `ratePerSecond` ceiling and finishes as early as the ' +
					'agreed rate allows; set it to spread the pass deliberately (e.g. 6h) when the origin would ' +
					'rather see a lower steady rate than a short burst.',
				{ unit: 'ms', min: 0 }
			),
			sweepInterval: option(
				DAY,
				'How often each node walks its slice of the registry probing every matched URL. ' +
					'INTERVAL MODE ONLY — ignored when `mode` is "continuous", where `cycleTarget` sets the ' +
					'cadence and there is no gap between passes to schedule.',
				{
					unit: 'ms',
					min: MINUTE,
					// setInterval stores its delay as a signed 32-bit int; past this it fires immediately
					// and the sweep hot-loops (the page.blobReadBudgetMs lesson).
					max: 2147483647,
				}
			),
			cycleTarget: option(
				DAY,
				'CONTINUOUS MODE ONLY: the wall-clock budget for covering every owned, matched URL once — ' +
					'i.e. the worst-case detection latency you are asking for. The pass paces itself to land ' +
					'on it: remaining rows over remaining budget, recomputed every batch.\n\n' +
					'This is a TARGET, never a licence. `ratePerSecond` is the ceiling agreed with whoever ' +
					'runs the origin and is never exceeded to hit a target, so an unreachable one is missed ' +
					'openly — every batch that wants more than the ceiling counts a `probe_cycle_behind`, and ' +
					'a sustained count means the corpus has outgrown its agreed rate and wants a longer ' +
					'target or a conversation about the ceiling.\n\n' +
					'THE FIRST CYCLE AFTER A RESTART RUNS AT THE CEILING. Pacing needs a denominator and the ' +
					'slice size is only known once a cycle has finished counting it; a cycle target cannot be ' +
					'honoured against an unknown corpus, and guessing one would pace to a fiction. So the ' +
					'first cycle measures, and every cycle after it paces.',
				{ unit: 'ms', min: MINUTE }
			),
			ratePerSecond: option(
				10,
				'Sustained probe-request ceiling per node. THE ORIGIN-PROTECTION KNOB: probe endpoints are ' +
					'typically no-store, so every probe is backend work for the origin — size this with the ' +
					'origin’s operator, not from what the fleet can send. Also what sizes a sweep: a 200k-URL ' +
					'node slice at 10/s is ~5.6h per pass.',
				{ min: 1 }
			),
			concurrency: option(
				4,
				'Probe requests in flight at once per node. Bounds burstiness within the rate cap — the pacing ' +
					'holds the sustained rate to ratePerSecond whatever origin latency does.',
				{ min: 1 }
			),
			reprobeAfter: option(
				12 * HOUR,
				'Skip a URL whose stored baseline is younger than this. What makes a sweep RESUMABLE: the ' +
					'walk position is in memory, so a restart mid-pass otherwise re-probes every URL the pass ' +
					'had already covered — hours of origin requests that can only confirm what is already ' +
					'stored. With this set, a restarted pass skips that ground in seconds and reaches new work ' +
					'immediately. Keep it comfortably BELOW `sweepInterval` (half is the default) or the skip ' +
					'starts eating real passes: a URL probed at the very end of one pass would be skipped by ' +
					'the next one, and its cadence would silently stretch. 0 disables skipping. The canary ' +
					'never skips (its whole job is the fast cadence), and a canary-triggered RESEED never ' +
					'skips (every baseline is known-stale after a mass change).',
				{ unit: 'ms', min: 0 }
			),
			backoffMax: option(
				64,
				'How far the pacing window may stretch when the origin pushes back, as a multiple of the ' +
					'normal window. `ratePerSecond` is sized with the origin’s operator for a HEALTHY origin ' +
					'and says nothing about one having a bad afternoon; a sweep that holds its configured rate ' +
					'through 429s and 503s adds load to something already failing. On any batch containing a ' +
					'pushback response (429/502/503/504, connect or read timeouts) the window doubles; on a ' +
					'clean batch it halves back toward normal — immediate response, gradual recovery. An ' +
					'explicit `Retry-After` outranks the computed wait. At the default the probe can slow ' +
					'itself to ~1/64th of its configured rate before giving up. 1 disables backoff.',
				{ min: 1 }
			),
			load: group(
				'The LOCAL-load governor: slow the probe when the node it runs ON is struggling, not just ' +
					'when the origin it probes is.\n\n' +
					'The origin backoff cannot see this class of trouble at all. A node losing its event loop ' +
					'to the serve path returns no 429s and no timeouts, so the probe reads a perfectly healthy ' +
					'origin and holds its configured rate straight through the congestion it is adding to. ' +
					'That is survivable for a bounded pass that ends; it is not for a continuous one that ' +
					'never does, which is why this exists and why it belongs with `mode: continuous`.\n\n' +
					'OFF BY DEFAULT, AND DELIBERATELY SO IN INTERVAL MODE. In interval mode a governor that ' +
					'slows the pass can push it past `sweepInterval`, where it is silently skipped and the ' +
					'cadence halves — so a safety feature would degrade the cadence invisibly. Continuous ' +
					'mode has no window to overrun: a slowdown just shows up as `probe_cycle_behind`. Turn ' +
					'this on there.',
				{
					enabled: option(false, 'Master switch for the local governor. Off = the lag is never read.'),
					lagThreshold: option(
						50,
						'p95 event-loop delay ABOVE the sampling floor, over one batch, past which the pacing ' +
							'window widens (and under which it recovers). The floor is subtracted for you — the ' +
							'raw histogram reads back at roughly its own resolution on a completely idle loop, so ' +
							'a threshold compared against the raw number would be resolution-dependent and trip on ' +
							'an idle node (see util/loopLag.js). Measured for calibration: an idle worker reads ' +
							'~1ms of excess; one held in 40ms synchronous blocks reads ~41ms. The default sits ' +
							'well clear of idle noise and well under the multi-second native stalls that actually ' +
							'hurt the serve path.\n\n' +
							'p95 rather than mean ON PURPOSE: what costs a served request is the tail — one long ' +
							'synchronous call — and a mean over one batch dilutes exactly that into nothing.',
						{ unit: 'ms', min: 1 }
					),
					backoffMax: option(
						8,
						'How far local pressure alone may stretch the pacing window, as a multiple. Lower than ' +
							'the origin `backoffMax` (64) because the failure modes are not comparable: an origin ' +
							'shedding load wants to be left alone almost entirely, whereas a busy node still has ' +
							'to make progress on the corpus — a probe that stalls out completely stops bounding ' +
							'staleness, which is a different way to serve wrong prices. 1 disables the governor ' +
							'while still reading the lag (useful for sizing the threshold before arming it).',
						{ min: 1 }
					),
					resolution: option(
						10,
						'Sampling resolution of the event-loop histogram. Also its noise floor, which is why it ' +
							'is subtracted from every reading. Finer resolution samples more often for a slightly ' +
							'tighter floor; there is little reason to move it.',
						{ unit: 'ms', min: 1, max: 1000, scope: 'restart' }
					),
				}
			),
			abortAfterDistress: option(
				50,
				'Consecutive pushback/timeout responses that end the pass. An origin refusing this many in a ' +
					'row is down rather than busy, and backing off further only crawls a doomed pass into the ' +
					'next one’s window while holding the sweep lock. The next scheduled pass is the retry and ' +
					'it starts clean. 0 disables the circuit breaker.',
				{ min: 0 }
			),
			chunkSize: option(
				2000,
				'Registry rows collected per read transaction during a sweep. Each chunk’s cursor opens, ' +
					'fills, and closes BEFORE any probe or write runs — a paced pass takes hours and no read ' +
					'transaction may live anywhere near that long (see the scan group).',
				{ min: 10 }
			),
			trigger: group(
				'How detected changes are turned into re-renders. Submitted to a bounded queue that drains ' +
					'BESIDE the walk rather than inside it, so a pass runs at its probe-rate floor whatever the ' +
					'change rate.\n\n' +
					'WHY THAT MATTERS. Triggering is six database operations, and when it ran in-line in the row ' +
					'handler it shared the pass\u2019s concurrency with probing \u2014 so trigger volume set PASS ' +
					'DURATION, and pass duration is detection latency, because the gap between two probes of one ' +
					'URL is one pass. That closes a loop: more change \u2192 more triggers \u2192 longer pass ' +
					'\u2192 a longer window in which each URL can change \u2192 more change. Measured on one ' +
					'deployment, arming the probe took a pass from 9.2h to a projected ~21h with bot traffic flat ' +
					'across both windows, and every knob traded deferrals against latency instead of escaping the ' +
					'loop. Submitting makes pass duration max(probe time, drain time) rather than the sum, and ' +
					'makes the meaningful limit triggers per SECOND \u2014 what the render fleet experiences.\n\n' +
					'A full queue is reported as `deferred`, exactly like exhausting `maxTriggersPerSweep`: the ' +
					'signature is left stale and the next pass re-detects. Nothing is lost by dropping the queue, ' +
					'which is why it is in memory and why an aborted pass simply abandons it.',
				{
					ratePerSecond: option(
						5,
						'Triggers started per second. This is the rate the RENDER QUEUE sees, not the origin: a ' +
							'trigger writes, it does not fetch. Size it against SPARE RENDER CAPACITY and the claim ' +
							'floor \u2014 not against the origin ceiling that `changeProbe.ratePerSecond` respects, ' +
							'and not against how fast the queue could go.\n\n' +
							'HOW TO SIZE IT. Aim for a drain that finishes INSIDE the pass: past that, the queue ' +
							'backs up and changes defer for want of queue rather than of budget. Take ' +
							'`maxTriggersPerSweep` over the pass length you expect \u2014 90,000 triggers across a ' +
							'9h pass is ~2.8/s, so the default leaves headroom without being able to outrun a ' +
							'fleet.\n\n' +
							'GOING MUCH HIGHER IS THE ONE WAY THIS CHANGE CAN HURT, because it is something the ' +
							'old in-line path could never do: at 20/s a 90,000-trigger budget drains in ~1.25h, ' +
							'which on a four-node cluster injects renders several times faster than the fleet can ' +
							'claim them \u2014 deepening the ready set and starving its lowest-priority class. ' +
							'Raise it only against a measured render rate that sits below the fleet ceiling. ' +
							'0 or less drains unpaced.',
						{ min: 0 }
					),
					concurrency: option(4, 'Triggers in flight at once.', { min: 1 }),
					maxPending: option(
						5000,
						'Queue depth before submissions are refused and counted as `deferred`. Bounds memory ' +
							'across a pass that can detect hundreds of thousands of changes; it is NOT the ' +
							'per-pass budget, which stays `maxTriggersPerSweep`.',
						{ min: 1 }
					),
				}
			),
			maxTriggersPerSweep: option(
				5000,
				'Ceiling on re-renders one sweep pass may file (per node). Changes past it stay detected but ' +
					'DEFERRED — the signature is left stale so the next pass retries — bounding how much queue ' +
					'injection a widespread change can cause. A genuinely mass change is the canary’s job, where ' +
					'one invalidation row replaces thousands of due-now writes.',
				{ min: 1 }
			),
			requestTimeout: option(10 * SECOND, 'Per-probe timeout, headers and body both.', {
				unit: 'ms',
				min: SECOND,
			}),
			maxResponseBytes: option(
				5 * 1024 * 1024,
				'Largest probe response read before the probe is failed. Bounds document-mode reads; API-mode ' +
					'responses are typically a few KB.',
				{ min: 1024 }
			),
			startDelay: option(5 * MINUTE, 'Grace after boot before the first sweep.', {
				unit: 'ms',
				min: 0,
				// Bounded so startDelay + startJitter can never exceed setTimeout's signed-32-bit delay.
				max: DAY,
				scope: 'restart',
			}),
			startJitter: option(
				5 * MINUTE,
				'Per-node spread on the first sweep, so a rolling restart doesn’t sync every node’s registry ' +
					'walk and origin probes.',
				{ unit: 'ms', min: 0, max: DAY, scope: 'restart' }
			),
			canary: group(
				'The mass-change detector: a fixed per-node cohort probed on a fast cadence, tripping when a ' +
					'large fraction changed in one pass. Cohort membership is deterministic — the `count` matched ' +
					'URLs with the smallest hashes, a keyspace-uniform sample rebuilt by every sweep. (The ' +
					'bootstrap build after a restart uses a cheaper key-order sample until the first sweep ' +
					'replaces it.)',
				{
					interval: option(30 * MINUTE, 'How often the cohort is probed. 0 disables the canary.', {
						unit: 'ms',
						min: 0,
						max: 2147483647, // setInterval's signed-32-bit delay cap — see sweepInterval
					}),
					count: option(
						500,
						'Cohort size per rule per node. At the default threshold this resolves a mass change with ' +
							'comfortable margin while costing ~count probes per interval.',
						{ min: 10 }
					),
					threshold: option(
						0.1,
						'Changed fraction of compared canaries (changed / (changed + unchanged)) at or above which ' +
							'the pass counts as a mass change. Measured promotional events reprice most of a catalog at ' +
							'once, so the default has a wide gap to per-URL drift noise.',
						{ min: 0, max: 1 }
					),
					minSample: option(
						50,
						'Fewest COMPARED canaries (seeds and failures excluded) a pass needs before the threshold ' +
							'is consulted at all — below it a handful of changes would read as a mass event.',
						{ min: 1 }
					),
					holdoff: option(
						6 * HOUR,
						'How long after recording a scope’s invalidation the canary will not re-record it. ' +
							'Re-stamping is NOT idempotent: it would re-invalidate every page rendered since the trip — ' +
							'exactly the pages that just healed. A genuine second event inside the holdoff still heals ' +
							'per-URL via the sweep; past it, a still-tripping canary re-records.',
						{ unit: 'ms', min: 0 }
					),
				}
			),
			mappingGuard: group(
				'The MAPPING-DEFECT GUARD for `pageCheck.fields`. A field mapped to the wrong slot, or compared the ' +
					'wrong way, disagrees with nearly every page — and every disagreement is a re-render, so one bad ' +
					'mapping would otherwise re-render its whole corpus on every pass. A correct mapping disagrees only ' +
					'when the page really is wrong, and on a WITNESSED page (rendered after the stored baseline was ' +
					'taken, the origin unchanged since) that takes a genuine round trip — the value changed and changed ' +
					'back between two probes with a render in between, measured well under 1%.\n\n' +
					'So each node counts, per mapped field, witnessed comparisons and witnessed disagreements, and ' +
					'DISARMS the field when its disagreement rate reaches `threshold` over at least `minWitnessed` ' +
					'comparisons: it stops triggering re-renders (and stops vouching for caught-up changes and ' +
					'verifications), a warning names the rule and slot, and its mismatches are still counted ' +
					'(`fieldMismatch` in the pass record; the guard’s own counts are `fieldGuard`). It stays disarmed ' +
					'until that field’s mapping is edited or the process restarts. It never suppresses an individual ' +
					'disagreement — a single one is exactly the round trip the page check exists to catch. Disarming ' +
					'never hides an ORIGIN change: those trigger on the signature as always; a disarmed field only stops ' +
					'correcting pages that are wrong while the origin is unchanged.\n\n' +
					'The rate is RECENT, not lifetime: both counts halve each time the sample reaches ten times ' +
					'`minWitnessed`, so a mapping that was right for a week and then broke (the site changed its page ' +
					'template) is disarmed within a few thousand comparisons instead of after outweighing the week.\n\n' +
					'In dry run the guard counts and disarms too, which is the point of a dry-run week: a broken ' +
					'mapping announces itself before anything is armed.',
				{
					threshold: option(
						0.2,
						'Witnessed disagreement rate at or above which a mapped field is disarmed. The default sits ' +
							'far from both ends: a wrong mapping disagrees on nearly every comparison, a correct one on ' +
							'the rare round trip (a correct mapping would need twenty times the measured round-trip ' +
							'rate to reach it).',
						{ min: 0, max: 1 }
					),
					minWitnessed: option(
						200,
						'Fewest witnessed comparisons of a field before `threshold` is consulted. Large enough that a ' +
							'correct mapping cannot reach the threshold by chance (at a 1% true rate, 20% of 200 is ~40 ' +
							'disagreements where ~2 are expected); small enough that a broken mapping is disarmed after ' +
							'about this many spurious re-renders per node rather than a corpus of them.',
						{ min: 1 }
					),
				}
			),
		}
	),

	render: group('Render scheduling: cadence, failure handling, schedule repair, and raw-document caching.', {
		raw: group(
			'RAW-DOCUMENT CACHING. Cache the origin document a miss already fetched, for URLs that are not ' +
				'in the render rotation — no browser, no render capacity, no second origin request.\n\n' +
				'THE PROBLEM IT SOLVES. On a large catalog the crawlable URL space is far bigger than the ' +
				'corpus worth rendering: facet and parameter combinations a bot invents by following links own ' +
				'no target, are never scheduled, and therefore MISS ON EVERY REQUEST. Measured on one ' +
				'deployment, 89.8% of requests to the listing route were exactly that — each one an origin ' +
				'fetch for a document the origin had already served, minutes earlier, to a different crawler. ' +
				'Caching it turns those misses into hits at the cost of one write.\n\n' +
				'WHEN IT IS THE RIGHT ANSWER: a route whose SERVER-RENDERED document already carries its whole ' +
				'SEO surface — title, meta description, canonical, JSON-LD offers, the product grid — so the ' +
				'render adds only interactive chrome. Verify that for a route before enabling it on that route; ' +
				'a raw document is NOT a rendered snapshot and this setting will not tell you the difference.\n\n' +
				'IT ONLY EVER REPLACES AN ORIGIN PROXY, never a render and never a cached snapshot. A raw page ' +
				'is read only when `PrerenderedPage` held nothing at all — a true miss. A stale or invalidated ' +
				'snapshot means a render is coming and the LIVE origin is the better answer, so those keep ' +
				'proxying exactly as before. Raw serves are reported under their own cache status, so ' +
				'`bot_serve` and `page_age` keep meaning what they meant.\n\n' +
				'Off by default, and off for every route until a route opts in with `rawCache: true`.',
			{
				enabled: option(false, 'Master switch. Off = nothing is stored, nothing is read, no extra reads.'),
				maxBytes: option(
					1048576,
					'Largest document to store, in bytes AS THE ORIGIN SENT IT — which is compressed (the ' +
						'origin is asked for gzip), so this bounds memory and storage rather than the decompressed ' +
						'size a search engine sees. Over the cap the document is served and NOT stored, and the ' +
						'capture is abandoned so nothing further is buffered for it.\n\n' +
						'BUDGET ~2x THIS PER IN-FLIGHT CAPTURE, not 1x. A capture holds one copy of the bytes, and ' +
						'the `tee()` retains a second for the branch the crawler has not read yet — measured with a ' +
						'stalled reader, a 768 KB document held 1.5 MB. The total is bounded by ' +
						'`maxConcurrentCaptures`, so the worst case is roughly `2 x maxBytes x maxConcurrentCaptures` ' +
						'per worker.',
					{ unit: 'bytes', min: 1 }
				),
				maxConcurrentCaptures: option(
					16,
					'How many responses may be captured at once, per worker. Past it a response is served ' +
						'without being stored.\n\n' +
						'THIS EXISTS BECAUSE CAPTURING REMOVES BACKPRESSURE. Without a capture a slow client costs ' +
						'socket buffers — the reader stops, the TCP window closes, and the ORIGIN holds the data. ' +
						'The capture reads in a tight loop, so it drains the origin at full speed however slowly ' +
						'the client reads, and this worker’s heap becomes the buffer instead. On a route that is ' +
						'mostly misses, a client opening many connections and reading slowly would otherwise have a ' +
						'heap lever it controls. Degrading to "this one is not stored" costs nothing — the next ' +
						'request stores it — while degrading to heap pressure takes the serve path down with it.',
					{ min: 1 }
				),
				expiry: option(
					'midnight',
					'When a stored document goes stale: `midnight` (the next local midnight in ' +
						'`expiryTimezone`) or `interval` (use `expiryMs`).\n\n' +
						'`midnight` EXISTS FOR STEP-CHANGE ORIGINS. Where a catalog reprices at a fixed hour rather ' +
						'than drifting continuously, an interval is the wrong shape: a document fetched at 23:00 ' +
						'with a 6h TTL serves post-change prices for five hours, while one fetched at 01:00 expires ' +
						'long before anything about it has changed. Aligning expiry to the change boundary makes ' +
						'every stored document correct for exactly as long as it is correct, and no longer.\n\n' +
						'There is no herd to spread: raw pages refill on demand, one request at a time, so expiring ' +
						'a whole route at once produces misses at the rate crawlers actually arrive.',
					{ enum: ['midnight', 'interval'] }
				),
				expiryMs: option(
					21600000,
					'Lifetime of a stored document when `expiry` is `interval`. Ignored under `midnight`.\n\n' +
						'SEPARATE FROM `expiry` ON PURPOSE. The two used to be one option accepting either the ' +
						'string `midnight` or a number of milliseconds — which the config merge cannot express: it ' +
						'type-checks every value against its default, so a numeric override of a string-defaulted ' +
						'option was REJECTED with one log line and the default silently kept. The documented ' +
						'setting did nothing.',
					{ unit: 'ms', min: 1 }
				),
				expiryTimezone: option('UTC', 'IANA timezone `expiry: midnight` is resolved in.', { nonEmpty: true }),
				contentTypes: option(
					['text/html'],
					'Content types eligible for storage, matched against the leading type of the response ' +
						'`content-type` (parameters ignored). Anything else is served and not stored.'
				),
				assumeShared: option(
					false,
					'Store a document even when the origin marks it as NOT a shared artifact — a `Set-Cookie` ' +
						'on the response, or `Cache-Control: private`.\n\n' +
						'WHY THIS IS A SWITCH AND NOT A DEFAULT. Both signals are heuristics for one question: is ' +
						'this response the same for every crawler? A `Set-Cookie` usually means the body was ' +
						'personalized, and storing one then replays somebody’s session to everybody — so the ' +
						'default refuses, and must keep refusing for an origin nobody has checked.\n\n' +
						'BUT AN ORIGIN CAN BE WRONG ABOUT ITSELF. Where a CDN in front already serves ONE cached ' +
						'copy of these documents to every visitor, with none of the session cookies in its cache ' +
						'key, the origin’s `private` and `Set-Cookie` are about session BOOTSTRAP and say nothing ' +
						'about the body — and refusing on them stores nothing at all. Measured on one deployment: ' +
						'`Set-Cookie` on 8 of 8 listing responses and `private` on 4 of 8, so an enabled route ' +
						'filled ZERO documents against 33,572 misses an hour, every one of them refused.\n\n' +
						'VERIFY BEFORE SETTING IT: fetch the same URL as two DIFFERENT visitors and diff the ' +
						'bodies. If the only differences are per-request telemetry — a bot-manager sensor payload, ' +
						'a request id, a nonce — the document is shared and this is safe. If any CONTENT differs, ' +
						'it is not, and no CDN behaviour makes it so.\n\n' +
						'“DIFFERENT VISITORS” MEANS DIFFERENT IP AND LOCALE, NOT JUST A FRESH COOKIE JAR. Two cold ' +
						'fetches from one machine share their source address, `accept-language` and `referer`, and ' +
						'the origin fetch forwards all of those (only `cookie`, `authorization`, `host`, ' +
						'`user-agent`, `accept-encoding` and `origin.ignoredHeaders` are stripped) while the cache ' +
						'key is url + device alone. So that pair of fetches is blind BY CONSTRUCTION to ' +
						'geo-, IP- and locale-driven variance — store selection, currency, translated copy — which ' +
						'is the personalization a retail origin is most likely to have. Vary the vantage point.\n\n' +
						'Nothing reads `Vary`. An origin naming a request header there is declaring the response ' +
						'varies on something this cache key does not contain, and with `Set-Cookie` and `private` ' +
						'both suppressed it is the last standard statement left; check it by hand before enabling.\n\n' +
						'A literal `no-store` is still refused. That is the origin instructing caches not to keep ' +
						'the response at all, which is a different statement from “not for shared caches”.\n\n' +
						'WHAT THE METRIC CAN AND CANNOT TELL YOU. A document stored under this setting is counted ' +
						'as `stored-unshared` rather than `stored`, so the share of a route the origin calls ' +
						'personal stays visible. Read it as a CENSUS, not an alarm: on an origin that sets a ' +
						'cookie on every response it is 100% from the first minute and cannot rise, so no ' +
						'threshold on it detects anything. Re-running the body diff above is the detector.\n\n' +
						'A STORED `private` IS RELAYED ON EVERY RAW HIT, because the stored headers are the ' +
						'origin’s own and `cache-control` is relayed from storage exactly as the origin proxy ' +
						'already relays it on a miss. So this is not a change for those URLs — but a downstream ' +
						'shared cache that honours `private` will not cache the hit, so do not expect edge offload ' +
						'on it.'
				),
				deviceIndependent: option(
					false,
					'Store ONE document per URL and serve it to every device, instead of one per URL per device.\n\n' +
						'WHY THE DEFAULT IS PER-DEVICE. The origin fetch is made with a per-device User-Agent ' +
						'(`origin.userAgents`), and an ADAPTIVE origin answers those with different HTML. Keyed by ' +
						'URL alone, whichever device missed first would decide what every other device is served — ' +
						'a desktop page to a smartphone crawler, under a 200, with nothing reporting it.\n\n' +
						'RAW DOCUMENTS ONLY, AND THAT IS WHY THIS CAN BE SAFE. A rendered snapshot has its device’s ' +
						'layout baked in, so rendered pages stay per device regardless. A raw document is served ' +
						'UNRENDERED: the crawler lays it out at its own viewport, so what matters is not whether the ' +
						'two devices’ HTML differs but whether each device’s HTML RENDERS correctly at the other ' +
						'device’s viewport.\n\n' +
						'WHEN TO TURN IT ON: an origin whose documents render the same page at a given viewport ' +
						'whichever device’s document it is — responsive, or adaptive only in hints the page ' +
						'recomputes at render time. There the per-device key makes each device miss on its own — ' +
						'a desktop crawler’s fetch never answers the smartphone crawler asking for the same URL ' +
						'minutes later.\n\n' +
						'VERIFY BY RENDERING, NOT BY DIFFING MARKUP. For a few URLs, capture each device’s document ' +
						'(cache-busted — see below), load EACH document at EACH device profile (viewport, UA, touch) ' +
						'with the navigation answered from the captured document, and compare what renders — layout ' +
						'(column count, element widths, horizontal overflow), visible text, loaded images — against ' +
						'a same-document repeat as the noise floor. Measured on one deployment whose SSR differed by ' +
						'UA in three places (a component flag, eager-vs-lazy image hints, an extra facet entry in ' +
						'hydration data): every rendered measure followed the viewport and none followed the ' +
						'document, so it was enabled. A markup diff would have called that origin unsafe.\n\n' +
						'THE CACHE-BUSTER IS NOT OPTIONAL. A CDN whose document cache key has no device in it hands ' +
						'every UA whichever copy was filled first, so an un-busted comparison can read an adaptive ' +
						'origin as byte-identical — measured on one deployment, un-busted fetches with the mobile UA ' +
						'returned the desktop document 5 times in 6.\n\n' +
						'PER-DEVICE ROWS ARE NOT RELIABLY PER-DEVICE ANYWAY where the proxy’s origin fetch goes ' +
						'through a device-blind document cache: a row takes the other device’s document whenever that ' +
						'device filled the edge object within its TTL. Measured on the deployment above, 1 row in 9 ' +
						'written by real crawler traffic held the other device’s markup.\n\n' +
						'SIZE THE GAIN BEFORE PAYING FOR IT. The extra hits are exactly the first request of the ' +
						'second device for a URL both devices ask for while the row lives, so the gain is bounded by ' +
						'the smaller device’s share of distinct URLs. And where the CDN caches the bot-path response ' +
						'itself, most repeats never reach this cache at all.\n\n' +
						'THE ORIGIN CAN STILL VETO IT. A response whose `Vary` names `User-Agent`, any `Sec-CH-*` ' +
						'client hint, `DPR`/`Viewport-Width`/`Width`/`Device-Memory`, `ingress.deviceTypeHeader`, or ' +
						'`*` is the origin declaring the body depends on the device, and it is refused ' +
						'and counted as `vary-device` rather than shared. That catches an origin that turns adaptive ' +
						'AND says so. Many adaptive origins sniff the UA without declaring it, and those pass this ' +
						'check silently; only re-running the cross-device render comparison catches a change there.\n\n' +
						'Flipping it in either direction needs no migration: the other key shape’s rows are simply ' +
						'never read again and expire on their own. That relies on the two shapes not colliding, which ' +
						'holds for the default `cacheKey.delimiter` (`|` never survives into a canonical URL) but not ' +
						'for one that can occur in a URL: with `/`, a URL ending `/<device>` reads as its parent’s ' +
						'per-device key for one expiry window after the flip.'
				),
			}
		),
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
						'budget — before you pay for it. Default ON: enabling `enabled` alone changes no ' +
						'SCHEDULE until this is turned off.\n\n' +
						'One write does happen in dry-run, deliberately: a rung move persists to ' +
						'`Target.demandInterval` (only on an actual move, never on hold). That persistence is ' +
						'what makes the dry-run histogram converge to the steady-state distribution instead ' +
						'of reporting first-step decisions forever — and it means the measured week is not ' +
						'free of replicated Target writes (~one per target that moves, per rung walked, plus ' +
						'boundary pages that flap). Turning the ladder fully off leaves `demandInterval` in ' +
						'place, ignored; a later re-enable resumes from the stored rung rather than from base.'
				),
				ladder: option(
					[6 * HOUR, 12 * HOUR, 24 * HOUR, 48 * HOUR],
					'Render intervals a target may occupy, ascending. The route/stored interval is the ' +
						'CEILING — the ladder reallocates within the cadence the route already grants and never ' +
						'schedules slower than it. An interval that is not itself a rung participates as its ' +
						'own top rung: it rests at its granted cadence and may only move through the rungs ' +
						'FASTER than it — never snapped to a rung in either direction (a 1h route parked at ' +
						'6h, or a weekly sitemap route pulled to 48h at 3.5x its granted render budget). ' +
						'Bottoming out at 6h rather than 1h is deliberate: 1h buys ' +
						'~0.04% availability error against 6h\u2019s ~0.24% for six times the render cost, and the ' +
						'fast rungs are where a runaway hot set becomes unaffordable. A route can bound how much ' +
						'of this ladder its pages may use with `ingress.routes[].demandFloor` \u2014 rungs faster than ' +
						'a route\u2019s floor are unreachable for that route.',
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
					'Budget backstop: the share of LADDER decisions allowed to land on a fast rung. ' +
						'Exceeding it is logged as a warning — the hot set has grown past what the ladder was ' +
						'sized for.\n\n' +
						'The denominator is the `graded` count in the histogram — promoted + demoted + held — ' +
						'not every reschedule. Decisions where the ladder had no choice are excluded: a route ' +
						'whose granted cadence is at or below the fastest rung has a one-entry effective ladder ' +
						'(`singleRung`), and a cold visit filter holds without deciding (`skippedCold`). ' +
						'Counting those made the number a readout of the ROUTE MIX — a deployment with any ' +
						'route below `maxFastInterval` had a structural floor it could never get under, so the ' +
						'warning fired continuously with zero promotions.\n\n' +
						'Within the graded set it is decision-weighted, which is what a budget cap wants: ' +
						'decisions are renders, so a target on the 6h rung contributes 8x one at 48h and the ' +
						'fraction reads as the share of the eligible render BUDGET spent on fast rungs. At the ' +
						'0.05 default with the default ladder, that is roughly 0.65% of eligible targets fully ' +
						'promoted to 6h — near the ~0.5% hot fraction the split was sized for. Beside it, ' +
						'`promotedFast` counts promotions ONTO a fast rung: the budget being reallocated right ' +
						'now, and zero once the distribution settles.\n\n' +
						'ALERT ON THE POOLED RATIO, not on any single emitted number: ' +
						'`sum(demand_fast) / sum(demand_graded)` across workers and nodes. The counters are ' +
						'per worker per interval and worker volumes are very unequal (production has had ' +
						'graded 3 on one worker and 50 on a sibling in the same interval), so averaging ' +
						'per-worker ratios overstates the result — 1/3 and 1/50 average to 0.175 against a ' +
						'pooled 0.038. The per-worker `fastFraction` in the log line is a diagnostic for that ' +
						'worker; its warning is suppressed below `1 / maxFastFraction` graded decisions, where ' +
						'a single fast decision would exceed the limit on its own and the ratio therefore says ' +
						'nothing.',
					{ min: 0, max: 1 }
				),
				bots: option(
					['*'],
					'Bots whose visits count as demand, by the bot name the analytics registry resolves ' +
						"(analytics.bots / derived names / the literal 'other'), compared case-insensitively. " +
						"['*'] (default) counts every bot; [] counts none, so every target rests at its route " +
						'cadence; a list counts exactly those. Same shape and matching rules as ' +
						'`ingress.discoveryBots`, and worth setting for a related reason: cadence is render ' +
						'budget, so whoever this counts decides where that budget goes, and a third-party ' +
						'crawler walking the corpus breadth-first promotes pages no search engine asked for. ' +
						'It is also the first lever on ring saturation — see `bitsPerSlice`.',
					{ itemType: 'string' }
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
					'Bloom filter bits per ring slice, rounded UP to a power of two at use (byte sizing and ' +
						'probe spread both require it). ~1M bits holds ~100k distinct URLs per slice at ~1% ' +
						'false positives. There are no false negatives, so a visited page is never demoted for ' +
						'lack of evidence.\n\n' +
						'SIZE THIS AGAINST THE DISTINCT-URL RATE, and treat overshoot as a correctness problem ' +
						'rather than a cost one. A slice holding n distinct URLs fills to `1 - e^(-kn/m)`, and ' +
						'the false-positive rate is `fill^k` — so it degrades not gradually but off a cliff: at ' +
						'the default k=7 and m=1M, 100k URLs fills to 0.49 (~0.7% false), 320k to 0.88 (~41%), ' +
						'640k to 0.986 (~91%). Past that the ring answers "visited" for essentially everything, ' +
						'the ladder promotes the whole corpus to its floor, and nothing about the failure is ' +
						'loud — the cadence just stops being demand-driven. Watch `demand_fill` at its PEAK, ' +
						'not its mean (it is a sawtooth that resets each slice).\n\n' +
						'Raising this is the last lever, not the first: the row is `bitsPerSlice / 8` bytes and ' +
						'REPLICATES on every flush, which is how the per-worker version of this write produced ' +
						'a transaction log two orders of magnitude larger than the state it carried. Cut what ' +
						'goes in first — `bots` above, and the rotation gate in `recordDemand` — since a URL ' +
						'the ladder can never act on is pure fill.',
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
				'rechecks before deletion — and, when no sitemap lists the URL, deletion on the FIRST verdict ' +
				'(`gone.maxStrikesUnlisted`), because a 404 at the origin is itself what stops discovery ' +
				're-creating the target.\n' +
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
					maxStrikes: option(2, 'Consecutive gone verdicts before a SITEMAP-LISTED target is deleted.', { min: 1 }),
					maxStrikesUnlisted: option(
						1,
						'Consecutive gone verdicts before a target NO SITEMAP LISTS is deleted. Separate from ' +
							'`maxStrikes` because the two are not symmetric, and the asymmetry runs the opposite way to ' +
							'the intuition.\n\n' +
							'A suppressed row is the verdict memory that stops a URL being re-created, so deleting one ' +
							'hands that job back to whatever created the target. For an unlisted target that is ' +
							'discovery, and discovery mints only on a 200 from the origin — a URL the origin answers ' +
							'404/410 for cannot be re-minted by a crawler hit, so retiring it is terminal and the row, ' +
							'its schedule row and every recheck render it would have cost are pure waste. Hence a ' +
							'default of 1: retire on the first verdict.\n\n' +
							'For a SITEMAP-LISTED target the refresh re-creates it on the very next pass (an absent ' +
							'target is a CREATE; a suppressed one is skipped), so deleting trades one recheck per ' +
							'`recheckInterval` for a full render per `sitemap.refreshInterval` — at a 6h refresh ' +
							'against a 14d recheck that is ~28x MORE render work. Those keep counting `maxStrikes`.\n\n' +
							'Scoped to gone verdicts on purpose: noindex and canonical-mismatch verdicts come from ' +
							'pages the origin serves 200 for, so discovery re-mints them on the next bot request ' +
							'(a `<meta>` noindex is not even visible to the header check) and retiring those on sight ' +
							'would loop the same way. Set equal to `maxStrikes` to restore the pre-0.67.0 behaviour.',
						{ min: 1 }
					),
				}),
			}
		),
		failureRetry: group(
			'Retry shape for the HTTP failures that never suppress (401/403 auth-shaped, 408/429/5xx ' +
				'transient), and for a render that simply failed (crash, timeout, settle error). The first ' +
				'`fastRetries` consecutive failures DELIBERATELY DO NOT RELEASE the job’s claim lease, so the ' +
				'retry comes on lease expiry (`queue.jobLeaseTime`) — an origin blip recovers fast, and the ' +
				'cached page’s stale-while-revalidate window covers bots throughout. From the next strike on, ' +
				'the retry drops to the target’s normal cadence and then backs off from there ' +
				'(`backoffFactor`, `maxBackoff`, `nonSitemapPenalty`): a persistently failing page must not ' +
				'hot-loop 100+ renders a day. Past `page.swrTtl` the kept page stops serving and bots fall through to ' +
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
				backoffFactor: option(
					2,
					'Multiplier applied per strike once the fast lane is exhausted. The first escalation waits ' +
						'exactly one normal interval; each strike after that multiplies by this. 1 disables ' +
						'backoff and restores the flat pre-0.37.0 cadence.',
					{ min: 1 }
				),
				maxBackoff: option(
					7 * DAY,
					'Ceiling on the backed-off wait. Never shortens a retry below the target’s own cadence — a ' +
						'ceiling under the interval (a 48h page against a 24h ceiling) would otherwise make a ' +
						'FAILING page come due more often than a healthy one.',
					{ unit: 'ms', min: 1 }
				),
				nonSitemapPenalty: option(
					4,
					'Extra wait multiplier for a failing target with no sitemap source, applied from the SECOND ' +
						'escalation on — every target gets one honest retry at its normal cadence first, so a ' +
						'single failure never deprioritizes a URL. Sitemap URLs are the corpus we promised to ' +
						'keep fresh, so they stay on the base curve while discovered URLs back off harder. ' +
						'Priority is expressed purely as a due time — `claim` orders by nextRenderTime alone — ' +
						'so this needs no priority field and no second index. 1 treats both alike.',
					{ min: 1 }
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
		targetMissing: group(
			'What a render result does when its URL has NO Target on the node processing it, for a row that ' +
				'is part of a recurring rotation (it carries a cadence). A render-now one-off is targetless by ' +
				'construction and is unaffected: it stores its page and its row is dropped.\n\n' +
				'A recurring row can meet a missing target because the target has not replicated to this node yet: ' +
				'`Target` and `RenderSchedule` are separate databases, so a newly created target can arrive after ' +
				'its schedule row, and a replica can lose a target outright. Dropping the row then is TERMINAL and ' +
				'silent — nothing re-creates a schedule for a target that exists. Measured on a four-node ' +
				'deployment: 734 live targets, most of them sitemap-declared, lost their rows this way during ' +
				'three days of write overload and went unrendered for five weeks.\n\n' +
				'So the row is DEFERRED instead: re-filed `deferMs` out without storing the page, and dropped only ' +
				'once its target has been missing for `graceMs`. A target that arrives in the meantime is rendered ' +
				'and rescheduled normally on the next pass. A truly orphaned row costs at most graceMs / deferMs ' +
				'extra renders before it is dropped, with a warning.',
			{
				deferMs: option(6 * HOUR, 'How far out a deferred row is re-filed while its target is missing.', {
					unit: 'ms',
					min: MINUTE,
				}),
				graceMs: option(
					24 * HOUR,
					'How long a recurring row may find its target missing before it is dropped. Size it above the ' +
						'longest replication lag you expect `render_service` to recover from.',
					{ unit: 'ms', min: 0 }
				),
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

		pageOrphanSweep: group(
			'Deletion of cached PAGES that no Target owns (POST /prerender_admin/sweep-orphan-pages) — the ' +
				'population every other sweep is blind to, since they all walk the Target table. A page is only ' +
				'ever removed by the target delete cascade, so a target that disappears without it (a raw-table ' +
				'delete, a render result that lands after its target was retired) strands its pages: never ' +
				're-rendered, never reclaimed, and replicated in full to every node. Measured on one deployment: ' +
				'14% of all pages, ~19 GB per node.\n\n' +
				'A page is deleted only when this node owns its URL, it was cached at least `minAge` ago, it is no ' +
				'longer servable (past expiresAt + page.swrTtl), no Target owns its URL and no render of it is in ' +
				'flight — re-checked inside the delete transaction. So a deletion never changes what a crawler is ' +
				'served beyond `stale` -> `miss`.\n\n' +
				'MANUAL ONLY and dry-run by default, like the other destructive sweeps. Node-scoped: each node ' +
				'sweeps the pages whose URL it owns, so run it on every node. Deletes replicate.',
			{
				minAge: option(
					21 * DAY,
					'How long ago a page must have been cached to be a candidate. Keep it well above the longest ' +
						'render cadence plus swrTtl, so a page a live rotation maintains can never qualify.',
					{ unit: 'ms', min: DAY }
				),
				maxDeletes: option(
					100000,
					'Ceiling on pages DELETED per pass. The walk still runs to the end, so `orphaned` is the true ' +
						'population; re-run until `truncated` is false.',
					{ min: 1 }
				),
				batchSize: option(
					100,
					'Pages deleted per transaction. The binding cost of a bulk delete is the number of commits on ' +
						'page_cache, so a batch is one commit — and, with confirmReplication, one confirmation round.',
					{ min: 1, max: 1000 }
				),
				ratePerSecond: option(100, 'Ceiling on pages deleted per second.', { min: 1 }),
				confirmReplication: option(
					true,
					'Hold each batch until every peer has confirmed it. This is the backpressure: a peer that ' +
						'cannot keep up stalls the sweep instead of letting it run ahead of replication.'
				),
				dryRun: option(true, 'Count and report without deleting anything. Defaults ON, so a bare start is a census.'),
			}
		),

		orphanSweep: group(
			'Deletion of targets orphaned by a CACHE-KEY RULE CHANGE — targets whose stored url is no ' +
				'longer what that url canonicalizes to, so no request can produce their key.\n\n' +
				'They are invisible to every other repair path: a sitemap refresh creates the target under ' +
				'the new key and only UNLINKS the old one (`sitemapUrl -> null`), which leaves its schedule ' +
				'rows due on the normal cadence; and the canonical verdict cannot retire them, because with ' +
				'the rule applied on both sides the renderer folds the job url and the declared canonical ' +
				'alike and calls it `self`. So they render forever into keys nothing reads. Measured after ' +
				'enabling `cacheKey.plusIsSpace` on a ~38k-url catalog corpus: ~20,200 urls re-keyed, ' +
				'~40,400 schedule rows. Sizing that needs care: `nextRenderTime` is stamped at COMPLETION, ' +
				'so a row rendered `L` behind its due time next renders `interval` after that — the realized ' +
				'cycle is `interval + L`, not `interval`. At the 8.2h lag observed there, those orphans ran a ' +
				'~14h cycle (~2,900 renders/hr, ~4% of the throughput ceiling) — but ~8% of the work the ' +
				'fleet was actually completing, which is the number that matters while it is saturated.\n\n' +
				'MANUAL ONLY, BY DESIGN — there is no timer. This deletes corpus, and the population it ' +
				'targets is created by an operator changing a `cacheKey` option, so it should run when ' +
				'someone decides to run it (POST /prerender_admin/sweep-orphans) rather than on a schedule ' +
				'that could act on a config change nobody meant to make permanent. Run it with `dryRun` ' +
				'first and reconcile the count against what you expect the rule change to have re-keyed.\n\n' +
				'Node-scoped: each node sweeps only the keys it owns, because the in-flight check reads ' +
				'this node’s lease buffer. Every node must be swept to cover the keyspace.',
			{
				maxDeletes: option(
					5000,
					'Ceiling on targets DELETED per sweep. The scan always runs to completion, so the reported ' +
						'`orphaned` count is the true size of the population even when only this many were removed ' +
						'— a rule change can orphan a large slice of the keyspace at once, and deleting millions of ' +
						'rows in one pass would be its own outage. Re-run until `truncated` is false.',
					{ min: 1 }
				),
				dryRun: option(
					true,
					'Count and report without deleting anything. Defaults ON: the safe direction for a ' +
						'destructive sweep is that an operator who triggers it without reading this gets a census, ' +
						'not a deletion. A run always reports which mode it was in.'
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

	sitemap: group('Sitemap ingestion: the refresh schedule, filtering, and crawler identity.', {
		refreshTime: option(
			'12:00',
			'Local time-of-day ("HH:MM") the refresh grid is anchored on. With the default 24h ' +
				'`refreshInterval` this is simply the daily refresh time; at any shorter interval it is the ' +
				'slot the others are spaced around.',
			{ nonEmpty: true }
		),
		timezone: option('America/New_York', 'IANA timezone `refreshTime` is interpreted in.', { nonEmpty: true }),
		refreshInterval: option(
			24 * HOUR,
			'How often the scheduled refresh runs, as slots spaced this far apart and phase-anchored on ' +
				'`refreshTime` (6h with a 12:00 anchor runs at 00:00/06:00/12:00/18:00 local). The default of ' +
				'24h leaves exactly one slot a day, on the anchor.\n\n' +
				'WHAT A SHORTER INTERVAL BUYS: the sitemap is the only source that attributes a URL to a ' +
				'sitemap, gives it a `changefreq`-derived render interval, and puts it in the sitemap lane ' +
				'that `queue.priority.sitemapBoost` ranks above discovered rows. Until a refresh sees it, a ' +
				'newly-published URL either does not exist here or exists only as a request-path discovery. ' +
				'Halving the interval halves that worst-case wait.\n\n' +
				'WHAT IT COSTS, AND WHY IT IS LESS THAN IT LOOKS: a pass re-fetches every child sitemap and ' +
				'scans the `sitemapUrl` index once per child, but it WRITES ONLY THE DIFF — on a real ~830k ' +
				'entry corpus 99% of entries resolve to `skipped` with no write, and the created/reattached/' +
				'removed counts are catalog churn, so a shorter interval splits the same daily total into ' +
				'smaller passes rather than repeating it. Measured there, a full walk of 31 sitemaps takes ' +
				'~2 minutes of one worker.\n\n' +
				'The real reason not to set this very low is the prune scan\u2019s read cursor: scan-seconds ' +
				'scale linearly with frequency, and long-held snapshots are what retain dead versions. The ' +
				'returns flatten long before the cost does \u2014 a few passes a day is the useful range.\n\n' +
				'Passes CANNOT overlap regardless of what is set here: the pinned worker refuses a second ' +
				'concurrent run, and each root is claimed for the length of its walk (see `staleRunMs`). An ' +
				'interval shorter than a walk therefore skips a slot and logs it rather than running two ' +
				'walks at once.',
			{ unit: 'ms', min: 1 * MINUTE }
		),
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
		newTargets: group(
			'How soon a URL the sitemap has just DECLARED gets its first render.\n\n' +
				'Without this, a newly created target takes `getInitialRenderTime`, which jitters the first ' +
				'render across the target’s WHOLE render interval — `hash(url) % interval`. That jitter ' +
				'exists for a real reason (the first ingest of a large sitemap must not stampede the queue), ' +
				'but it is sized for bulk population and applies just as hard to the handful of genuinely new ' +
				'URLs a mature corpus gains each day: on a 48h cadence a product published this morning can ' +
				'wait two days to be rendered once, while the sitemap has been telling us about it the whole ' +
				'time. A declaration is the strongest signal a site gives that a URL matters.\n\n' +
				'So the first render is jittered across `window` instead of the interval, and only for the ' +
				'first `maxPerRun` creates in a walk. The cap is what keeps the bulk case safe: a first ' +
				'ingest creating hundreds of thousands of targets exceeds it immediately and everything past ' +
				'it falls back to full-interval jitter, which is exactly the old behaviour. Steady-state ' +
				'churn (tens to hundreds a day on a real corpus) never comes close to the cap.\n\n' +
				'Only the FIRST render moves. The target’s cadence is untouched — `effectiveInterval` is ' +
				'still the route/stored interval, so every render after this one is on the normal schedule.',
			{
				window: option(
					15 * MINUTE,
					'Jitter window for a newly declared target’s first render. Small values approximate ' +
						'"immediately" while still spreading a batch across minutes rather than firing it into ' +
						'one. `0` disables the fast path entirely and restores full-interval jitter.\n\n' +
						'BELOW ~2 MINUTES IT STOPS SPREADING. `getInitialRenderTime` floors to the minute, so a ' +
						'window under 60,000ms collapses every create in a walk onto ONE minute — the stampede ' +
						'this is jittered to avoid, arrived at by asking for less jitter. Capped at 2147483647 ' +
						'for the same reason `sweepInterval` is: a larger delay is not "effectively never", it ' +
						'overflows the signed 32-bit timer and fires immediately.\n\n' +
						'A window WIDER than the route’s own `renderInterval` is ignored — the fast path would be ' +
						'slower than the jitter it replaces — and does not count as `createdSoon`.',
					{ unit: 'ms', min: 0, max: 2147483647 }
				),
				maxPerRun: option(
					5000,
					'Creates per walk that may take the fast path. Past this, new targets fall back to ' +
						'full-interval jitter — the bulk-population guard.',
					{ min: 0 }
				),
			}
		),
		conditional: group(
			'Conditional sitemap fetching: send `If-Modified-Since` and skip the whole reconcile for a ' +
				'document the origin answers 304 to.\n\n' +
				'WHAT IT BUYS. A pass re-fetches every child and scans the `sitemapUrl` index once per ' +
				'child, and it is that prune scan — a held read cursor, whose seconds scale linearly with ' +
				'refresh frequency — that sets the real cost of refreshing often. A 304 skips the body, the ' +
				'parse, the scan and every write, so an unchanged pass costs one request per document and ' +
				'no database work at all. That is what makes polling for a change affordable instead of ' +
				'merely possible: a deployment whose sitemaps rebuild once a night can check every few ' +
				'minutes and pay for the walk only on the pass that finds the rebuild.\n\n' +
				'USE `Last-Modified`, NOT `ETag`, AND DO NOT ASSUME EITHER. Measured on one production ' +
				'edge: `If-Modified-Since` returned a clean 304, while `If-None-Match` sent back the exact ' +
				'ETag the same edge had just served and got 200 with the full multi-megabyte body. An ' +
				'origin that advertises a validator is not promising to honour it, which is why the ' +
				'`not_modified` counter is worth watching — a steady zero here means every pass is doing ' +
				'full work and the frequency should come back down.\n\n' +
				'AN INDEX IS STILL DESCENDED on a 304: that only says the CHILD LIST is unchanged, not the ' +
				'children, and on a real corpus the children rebuild on a different schedule from the index ' +
				'that lists them. Each child then makes its own conditional decision.',
			{
				enabled: option(true, 'Send `If-Modified-Since` when a stored validator is available.'),
				fullPassInterval: option(
					24 * HOUR,
					'Force an UNCONDITIONAL fetch of a document whose entries have not been ingested in this ' +
						'long. This is the repair net and it is why the feature is safe to leave on: a 304 skips ' +
						'the reconcile, and the reconcile is also what re-CREATES targets lost to anything else — ' +
						'a bad purge, a half-applied delete, a botched migration. Without a periodic full pass a ' +
						'corpus could drift for as long as the origin left its sitemaps untouched and nothing ' +
						'would notice. Set it to 0 to make every fetch unconditional (the pre-0.69.0 behaviour).',
					{ unit: 'ms', min: 0 }
				),
			}
		),
		departure: group(
			'What a refresh does about URLs that LEAVE a sitemap, beyond unlinking them. The action is ' +
				'declared PER ROUTE (`ingress.routes[].departureAction`); this group bounds and observes it, ' +
				'and nothing here does anything until at least one route opts in.\n\n' +
				'THE CHECK RUNS AFTER THE WHOLE WALK, not at prune time, and that is not an optimisation. A ' +
				'paginated corpus shears across child boundaries: children are walked in order, so a URL that ' +
				'moves to an EARLIER child is re-attached before the child it left is pruned and never looks ' +
				'departed — but one that moves to a LATER child is pruned first and looks departed until the ' +
				'child that now claims it is reached. Acting at prune time would fire on every URL that shifted ' +
				'forward, which on a fixed-size paginated sitemap is every URL after an insertion. Candidates ' +
				'are re-read once the walk ends and anything that picked up an attribution is dropped.',
			{
				enabled: option(
					true,
					'Master switch for the post-walk departure check. Routes still have to opt in, so leaving ' +
						'this on costs nothing until one does; it exists so an operator can stop the behaviour ' +
						'during an incident without editing the route list.'
				),
				dryRun: option(
					true,
					'Decide and report, write nothing. The default, because the useful thing to know first is ' +
						'HOW MANY URLs a real walk would act on — a number no deployment has until it has ' +
						'looked, and one that decides whether `maxActions` is a ceiling or a no-op. The result ' +
						'and the progress row carry the outcome tally either way.'
				),
				maxActions: option(
					5000,
					'Ceiling on departed URLs ACTED ON in one walk. Skipped candidates (re-attached, ' +
						'suppressed, route opted out) do not count against it. The cap is the guard against a ' +
						'pathological walk: a child sitemap that fetches truncated but still parses as valid XML ' +
						'presents every URL it no longer lists as departed, and without a ceiling one bad fetch ' +
						'would expire a large slice of the cache. Overflow is counted as `capped` and left for ' +
						'the next walk rather than silently dropped.',
					{ min: 0 }
				),
				maxCandidates: option(
					50000,
					'Ceiling on departed URLs HELD for the post-walk check. Separate from `maxActions` because ' +
						'this one bounds memory: it is a list of URLs retained across a walk that can prune ' +
						'millions. A capped list is reported as such, so a short list is never presented as ' +
						'"few departed".',
					{ min: 0 }
				),
			}
		),
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
		ready: group(
			'THE READY SET — which of the due rows the next leases go to, decided by a background sweep ' +
				'instead of by the order the index happens to be in.\n\n' +
				'WHY: `claim` takes the first rows it finds from the claim floor, so the queue serves ' +
				'whatever is oldest-due. Two production measurements say that is the wrong order under ' +
				'scarcity (prerender-plugin#80): ~46% of a 521,929-row overdue queue was bot-discovered ' +
				'rather than sitemap-submitted, and absolute due time treats a 1h-TTL homepage 3h overdue ' +
				'exactly like a 48h-TTL product page 3h overdue — 300% stale against 6%. Simulated over ' +
				'the real corpus the 1h route sits at 4.78x its own TTL even at FULL capacity.\n\n' +
				'It could not be fixed by re-sorting the claim window, because the window is ANCHORED AT ' +
				'THE OLDEST DUE TIME: under a backlog every row in it is ancient, so the homepage is never ' +
				'read at all and a wider window is just more ancient rows. So a sweep scores the WHOLE due ' +
				'set and keeps the best few thousand in shared memory; claims pop from that and touch no ' +
				'index. Affordable because the read is projected, one-sided and write-free — though HOW affordable ' +
				'depends on the corpus, not just the query: ~2.4us/row on a fresh 200k-row bench corpus, but ' +
				'~55us/row over production 1.3M churned rows, where a ~300k due set is a ~27s sweep (measured ' +
				'live 2026-08-21).\n\n' +
				'ORDERING ONLY. Total render volume cannot change: every row it reorders is already due. ' +
				'And it is a CACHE in front of the old path — cold, exhausted or disabled, claims fall back ' +
				'to the index scan, so every failure mode here is the previous behaviour rather than a ' +
				'stalled queue.',
			{
				enabled: option(
					true,
					'Kill switch. `false` claims straight from the index scan, exactly as before v0.50.0. The ' +
						'sweep also stops, so nothing is spent maintaining a set nothing reads.'
				),
				capacity: option(
					5000,
					'Entries the ready set holds. Sized to cover several sweep intervals of claims so the set ' +
						'does not run dry between sweeps: at the recorded fleet throughput a node grants roughly ' +
						'5 jobs a second (observed live: ~70-75 claims a minute), so 5,000 entries is about 16 ' +
						'minutes of work — three sweep intervals at the default.\n\n' +
						'DO NOT RAISE THIS CASUALLY. The reference cluster runs with 4.6GB of swap in use and 5.2GB ' +
						'free of 33.6GB, so shared memory on these nodes is not free. A larger set does not improve ' +
						'the ordering either — the sweep already scores every due row and keeps the best of them, so ' +
						'this only buys time between sweeps. What makes the sweep safe on a swapping node is that ' +
						'its own memory is a function of THIS number and not of the due set: it streams rows through ' +
						'a bounded heap and retains only the best `capacity`.\n\n' +
						'Costs `capacity x ~276 x 2` bytes of shared memory — two slots, so ~2.8MB at the default. ' +
						'Raising it does ' +
						'NOT make the ordering better — the sweep already scores every due row and keeps the best ' +
						'of them — it only makes the set last longer between sweeps.\n\n' +
						'Restart-scoped: a named shared buffer is sized by its first allocation, so a live change ' +
						'would give workers in one generation differently-sized views of the same buffer. A ' +
						'mismatch is logged and the smaller size honoured.',
					{ min: 0, scope: 'restart' }
				),
				sweepInterval: option(
					5 * MINUTE,
					'How often worker 0 re-scores the due set and republishes.\n\n' +
						'This is the ORDERING STALENESS: a row that becomes due just after a sweep waits up to one ' +
						'interval before it can be ranked. Five minutes against cadences of an hour and up is a ' +
						'rounding error, and `capacity` covers roughly three of these intervals of claims, so the ' +
						'set does not run dry between sweeps.\n\n' +
						'FIVE MINUTES RATHER THAN ONE, on production evidence. A synthetic benchmark puts a ' +
						'projected one-sided read at ~2.4us/row on a FRESH corpus, which would make a sweep sub-second — but ' +
						'cluster reports `claim_scan_ms` at a 5-6ms median over a window of roughly 205 rows ' +
						'(grantLimit + in-flight + grantLimit, at an observed lease occupancy of 75-155), and ' +
						'`empty` passes at a 25ms mean with 47ms observed, which are seek-dominated. So the real ' +
						'marginal per-row cost sits somewhere between 2.4us and ~25us — an order of magnitude of ' +
						'uncertainty — and the sweep shares a worker with bot traffic. At the wide end a ' +
						'one-minute interval would spend a noticeable fraction of a core continuously, for no ' +
						'benefit: the ordering does not go stale that fast.\n\n' +
						'WATCH `ready_sweep_ms` AND TIGHTEN FROM THERE. It reports the real number for your corpus, ' +
						'which is the only way to know it — the backlog snapshot cannot tell you the due-set size ' +
						'either, because `overdue` saturates at `management.scanCap` (observed pinned at 2,000).\n\n' +
						'`0` disables the sweep, which leaves the set to go stale and then empty; claims fall back ' +
						'to the index scan as they always do. The ceiling is node\u2019s own timer limit of 2^31-1 ms ' +
						'(~24.8 days) \u2014 past it a timer fires every millisecond rather than never, which would ' +
						'turn the sweep into a hot loop over the due set.',
					{ unit: 'ms', min: 0, max: 2147483647 }
				),
				sweepCap: option(
					500_000,
					'Ceiling on rows one sweep reads. The due set cannot exceed the corpus, so this is a ' +
						'guard against a runaway rather than a tuning knob — though at the ~55us/row a churned corpus costs, ' +
						'reading.\n\n' +
						'If a sweep hits the cap WITHOUT reaching a not-yet-due row it is ordering over a prefix ' +
						'of the backlog, which is reported and warned about: the rows past the cap are the ' +
						'youngest, so the effect is that recently-due pages go unranked — exactly the pages this ' +
						'exists to protect.',
					{ min: 1 }
				),
				sitemapBoost: option(
					2,
					'How much a sitemap-sourced row outranks a discovered one at the same overdue ratio. `1` ' +
						'disables the preference and orders on overdue ratio alone.\n\n' +
						'A MULTIPLIER, not a tier, so it cannot starve discovered URLs: an unserved row\u2019s ' +
						'lateness grows without bound while the boost stays constant, so a discovered row wins as ' +
						'soon as its ratio passes `sitemapBoost x` the highest sitemap ratio in the set. With ' +
						'sitemap pages held ~1.2 cadences late, a discovered page is served within ~2.4 cadences ' +
						'of its own interval at the default.',
					{ min: 1 }
				),
			}
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
			precision: option(
				14,
				'HyperLogLog precision `p`. Sets both the accuracy and the SIZE of every sketch row: the ' +
					'sketch is 2^p registers of one byte, so p = 14 is 16 KB with a standard error of ' +
					'~1.04/sqrt(2^p) ≈ 0.8%, p = 12 is 4 KB at ~1.6%, and p = 10 is 1 KB at ~3.3%.\n\n' +
					'This is the lever for the WRITE side, not just for memory. Rows are replicated and ' +
					'rewritten on every flush, so halving p halves the transaction-log volume this table ' +
					'generates — and crawl breadth is a reporting number where a couple of percent of ' +
					'error is immaterial, which makes a lower p unusually cheap. Weigh it against what the ' +
					'estimate is used for before moving it.\n\n' +
					'CHANGING IT RESHAPES EVERY SKETCH. A row written at a different p describes a ' +
					'different register space and cannot be merged with one written at this p, so ' +
					'mismatched rows are ignored rather than merged: expect that day to undercount for ' +
					'the bots involved (and, during a staggered rollout, to ignore shards from nodes ' +
					'still on the old value) until the next UTC day rollover starts every sketch fresh. ' +
					'Nothing is corrupted and nothing needs migrating; one day of breadth numbers is ' +
					'soft. Prefer changing it at a day boundary. The crawl-breadth response reports the ' +
					'shards it had to ignore as `mismatchedShards`, so that undercount is a number an ' +
					'operator can see rather than a smaller-looking day.',
				{ min: 8, max: 16 }
			),
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
/**
 * Visit every option in the schema as `(dottedPath, node, scope)`, depth-first in declaration
 * order. Public because config.js walks it to build the per-option layer/provenance view.
 */
export const walkOptions = (visit) => {
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
	const describe = (node, inheritedScope, inheritedEditable) => {
		const scope = node.scope ?? inheritedScope;
		// `uiEditable` inherits downward exactly like `scope`, so marking a group file-only covers
		// every option inside it without repeating the marker (and without a later addition to that
		// group silently becoming editable).
		const groupEditable = node.uiEditable ?? inheritedEditable;
		if (isOption(node)) {
			const out = { kind: 'option', type: typeOf(node.default), description: node.description, scope };
			out.default = clone(node.default);
			for (const key of ['enum', 'itemEnum', 'unit', 'min', 'max', 'nonEmpty', 'itemType', 'secret', 'movedFrom']) {
				if (node[key] !== undefined) out[key] = node[key];
			}
			// Resolved rather than raw: the console renders a control from this, so it must not have to
			// re-derive the secret rule or walk back up for an ancestor's marker.
			out.uiEditable = groupEditable !== false && !node.secret;
			return out;
		}
		const children = {};
		for (const [key, child] of Object.entries(node.children)) {
			children[key] = describe(child, scope, groupEditable);
		}
		const out = { kind: 'group', description: node.description, children };
		if (node.scope) out.scope = node.scope;
		if (node.uiEditable === false) out.uiEditable = false;
		if (node.movedFrom) out.movedFrom = node.movedFrom;
		return out;
	};
	return describe(configSchema, 'live', true);
};

/**
 * May the console write this path, and if not, why not?
 *
 * The refusal reason is returned rather than logged because it is shown to the operator who tried:
 * "that is a secret, set the environment variable" and "that option is deliberately file-only" are
 * different problems with different fixes, and both are different from a typo'd path.
 *
 * @param {string} path dotted option path
 * @returns {{ ok: true, node: object } | { ok: false, reason: string }}
 */
export const checkUiEditable = (path) => {
	let node = configSchema;
	let editable = configSchema.uiEditable ?? true;
	for (const segment of String(path ?? '').split('.')) {
		// Own-key check for the same reason as `schemaNodeAt`: `children['constructor']` is truthy and
		// is not an option, and answering a refusal is only correct if the walk cannot be fooled.
		if (!isGroup(node) || !Object.hasOwn(node.children, segment)) {
			return { ok: false, reason: `${path} is not a configuration option` };
		}
		node = node.children[segment];
		if (!node) return { ok: false, reason: `${path} is not a configuration option` };
		if (node.uiEditable === false) editable = false;
	}
	if (!isOption(node)) {
		return { ok: false, reason: `${path} is a group of options, not a single option` };
	}
	if (node.secret) {
		return {
			ok: false,
			reason: `${path} is a secret — set it through its environment variable, not from the console`,
		};
	}
	if (!editable) {
		return { ok: false, reason: `${path} is deliberately not editable from the console` };
	}
	return { ok: true, node };
};

/** Look up the schema node (option or group) at a dotted path, or undefined. */
export const schemaNodeAt = (path) => {
	// Coerced and own-key-checked because callers feed this paths that came from a database row. A
	// bare `children[segment]` lookup answers `__proto__` and `constructor` from the prototype chain
	// — truthy values that are not schema nodes — and a non-string path would throw on `.split`.
	// Anything that is not an actual declared node is simply not an option.
	let node = configSchema;
	for (const segment of String(path ?? '').split('.')) {
		if (!isGroup(node) || !Object.hasOwn(node.children, segment)) return undefined;
		node = node.children[segment];
		if (!node) return undefined;
	}
	return node;
};

export { SECOND, MINUTE, HOUR, DAY };
