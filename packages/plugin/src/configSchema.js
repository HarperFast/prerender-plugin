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
			eventLoopLagInterval: option(
				60_000,
				'How often each worker reports its own event-loop delay, in ms. `0` disables it.\n\n' +
					'Reported PER WORKER on purpose. Analytics rows are per-thread, so one worker standing out ' +
					'against its peers localises a stall to whatever only that worker does — for this plugin the ' +
					'ready-set sweep, the queue-status sync and the reconciler, all pinned to `workerIndex 0`. A ' +
					'single cluster-wide number averages exactly that signal away.\n\n' +
					'Cheap: the histogram samples in libuv at 20ms and the reporter is one timer per worker. It ' +
					'emits two `prerender_ops` `event_loop_lag` rows per worker per window (p99 and max), so the ' +
					'cost of shortening it is analytics rows, not runtime.',
				{ min: 0, max: 2147483647 }
			),
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
					maxPerMinute: option(
						10,
						'Per-node ceiling on accelerated REQUESTS per minute, shared across every worker on the node ' +
							'(one minute-bucketed counter in a shared buffer). One accelerated request writes at most one ' +
							'schedule row PER DEVICE ROW THE URL HAS — `deviceTypes.default` (two on this deployment), ' +
							'plus the served device when that one is merely `supported` — so the write ceiling is this ' +
							'number times those rows.\n\n' +
							'Sized so its CEILING is defensible, not just its typical. 10/min/node is 14,400 ' +
							'requests/node/day ≈ 28,800 schedule writes ≈ 2.3MB of audit/node/day, about 7% of measured ' +
							'spare fleet render capacity (~792,700 renders/day spare against a 1,710,936/day ceiling and ' +
							'~918,000/day of baseline cadence demand) — against a measured demand of roughly 1,000 ' +
							'owner-node candidate requests/day CLUSTER-WIDE, i.e. ~14x headroom. Raising it toward 120 ' +
							'would authorise ~87% of all spare fleet capacity, which is why it is not the default.',
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
					'everything else in the response is ignored. An extraction where every path yields null is a ' +
					'FAILED probe, never a new signature, so an endpoint shape change cannot mass-trigger.\n' +
					'  invalidateScope  optional invalidation scope ("all" or "route:<match>:<path>") the canary ' +
					'records on a mass change. Empty = the canary detects and logs only.\n' +
					'  label            optional name for logs and the admin surface.',
				{ itemType: 'object' }
			),
			sweepInterval: option(DAY, 'How often each node walks its slice of the registry probing every matched URL.', {
				unit: 'ms',
				min: MINUTE,
				// setInterval stores its delay as a signed 32-bit int; past this it fires immediately
				// and the sweep hot-loops (the page.blobReadBudgetMs lesson).
				max: 2147483647,
			}),
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
			chunkSize: option(
				2000,
				'Registry rows collected per read transaction during a sweep. Each chunk’s cursor opens, ' +
					'fills, and closes BEFORE any probe or write runs — a paced pass takes hours and no read ' +
					'transaction may live anywhere near that long (see the scan group).',
				{ min: 10 }
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
		}
	),

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
						'false positives. False positives promote a page nobody asked for — wasted renders, ' +
						'never staleness — and there are no false negatives.',
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
				yieldBudget: option(
					2,
					'Milliseconds the sweep may hold the event loop before yielding, in ms.\n\n' +
						'THE SWEEP RUNS ON A WORKER THAT ALSO SERVES BOT TRAFFIC, so this is the knob that decides ' +
						'how long a crawler request can sit behind it. It replaced a fixed "yield every 200 rows", ' +
						'which was chosen when `bench/queue-index` measured a row at ~2.4us — 200 rows was ~0.5ms ' +
						'of held loop, invisible beside a ~1.6ms cache hit. On the production corpus a row costs ' +
						'~55us, so those same 200 rows held the loop ~11ms and every request landing in that slice ' +
						'waited for it. A row count cannot express "do not stall a request"; a time budget can, and ' +
						'it stays correct when the per-row cost moves.\n\n' +
						'The default is set just above a cache hit (~1.6ms served), so a request delayed by the ' +
						'sweep is delayed by about the time it would take to serve. Raising it trades crawler ' +
						'latency for slightly fewer yields, which buys almost nothing: yielding measured free ' +
						'(2.375 vs 2.387us/row at 20,000 rows). Lower it if `event_loop_lag` on the sweeping ' +
						'worker is worse than the p99 you want for `duration` (`path: p`).\n\n' +
						'Granularity is bounded by an internal 32-row check interval, so the actual slice lands ' +
						'between this and roughly this plus 2ms on the current corpus.',
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
