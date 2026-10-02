# `@harperfast/prerender`

A configurable [Harper](https://www.harpersystems.dev/) plugin that prerenders pages for bots and
crawlers. It provides:

- A bot HTTP entry point (`/p/<absolute-url>` by default) that serves cached prerendered HTML or
  fetches from the origin, with content-encoding negotiation and conditional-request (304) handling.
- A render queue + scheduler (`render_queue`, `RenderTarget`, `RenderSchedule`) that an external
  render service (see [`@harperfast/prerender-browser`](../browser)) claims jobs from and posts results
  back to.
- Sitemap ingestion (`Sitemap`) that discovers URLs and schedules them for rendering.
- A prerendered-page cache (`PrerenderedPage`); non-indexable verdicts live on the target
  itself (`Target.state: suppressed`).
- A management API at `/prerender_admin` (see [Management API](#management-api-prerender_admin)),
  authenticated with Harper users and restricted to `super_user`. The console UI consuming it is
  the separate [`@harperfast/prerender-console`](../console) component.

Everything that used to be hardcoded — domains, security token, device types, render/refresh
schedules, user-agent strings, TTLs — is supplied per deployment through the host application's
`config.yaml`.

## Installation

```sh
npm install @harperfast/prerender
```

Add it to your Harper application's `config.yaml`:

```yaml
rest: true # required for the @export-ed table REST endpoints

'@harperfast/prerender':
  package: '@harperfast/prerender'
  files: '/'

  # --- options (all optional; defaults shown) ---
  domains: [] # indexable-host allowlist; empty = allow all hosts

  ingress: # how incoming bot requests are parsed (see "Ingress modes" below)
    mode: prefix # 'prefix' (native /p/<absolute-url>) or 'forwarded' (reverse proxy/CDN)
    botPathPrefix: /p/ # prefix mode: requests under this prefix are treated as bot requests
    deviceTypeSource: header # 'header' (deviceTypeHeader) or 'path' (first path segment)
    deviceTypeHeader: x-device-type
    forwardedHostHeader: x-forwarded-host # forwarded mode: original public host
    forwardedProtoHeader: x-forwarded-proto
    defaultProtocol: https
    # ordered, first match wins — see "Route classes"
    routes: [] # [{ match: exact|prefix|contains, path, mode: prerender|passthrough, queryParams: [...] }]
    # compiled into `routes` as prepended passthrough entries; matched against the PATH
    excludePathPatterns: ['/search/'] # paths containing these are never auto-scheduled
    report: # periodic tally of paths served without prerendering
      enabled: true
      interval: 300000 # ms between flushes, per worker
      maxBuckets: 200 # distinct path buckets per class before overflow counting
      topN: 20 # buckets listed per log line

  deviceTypes:
    supported: [desktop, mobile, tablet]
    default: [desktop, mobile] # device types scheduled for auto-discovered pages

  cacheKey: # how a URL becomes a cache identity — changing these orphans every cached page
    delimiter: '|'
    attributes: [url, deviceType]
    queryParams: [page] # query params kept in the cache key; ['*'] = keep all, [] = drop all
    trailingSlash: strip # strip|preserve — whether /a/ and /a are one key (no standard says they are)
    plusIsSpace: false # fold %20 to + in the QUERY — only for an origin that form-decodes; MIRROR
    # in the renderer's cacheKey.plusIsSpace, and note that enabling it re-keys every affected URL
    decodeReserved: [':', ',', '@'] # RESERVED chars decoded so one URL spelled two ways is one key
    # (unreserved escapes — letters, digits, `- . _ ~` — are ALWAYS decoded: RFC 3986 says those
    #  escapes denote the same character, so it holds for every site. These do not, so they are
    #  config: [] decodes nothing beyond unreserved, which is what a CDN does.)

  origin: # how Harper fetches from the origin
    securityToken: # shared secret sent to the origin; must match the render client
      header: x-harper-renderer-bypass
      value: '' # SET THIS per deployment (or use valueEnv to keep it out of config.yaml)
      valueEnv: '' # if set, the token is read from this env var and overrides `value`
    staging: # origin staging passthrough (see "Staging passthrough" below)
      ip: '' # staging edge IP; empty = disabled. When set, a cache-MISS fetch that carries
      #        the `header` request header connects here instead of the public origin.
      header: x-harper-staging # request header whose presence toggles staging passthrough
    userAgents: # per-device User-Agent strings sent to the origin on the miss-proxy fetch
      desktop: 'Mozilla/5.0 ... HarperProxy/1.0'
      mobile: 'Mozilla/5.0 ... HarperProxy/1.0'
      tablet: 'Mozilla/5.0 ... HarperProxy/1.0'
    ignoredHeaders: [] # extra request header names not forwarded to the origin, on top of the
    #                    always-ignored set (hop-by-hop headers plus host, user-agent,
    #                    accept-encoding, cookie, authorization, and the securityToken/debugHeader
    #                    names); matched case-insensitively

  debugHeader: # when this request header is present (any value), debug response headers are added
    key: x-harper-prerender-debug

  page:
    ttl: 86400000 # 24h — default cached-page TTL
    minTtl: 21600000 # 6h  — floor for sitemap-derived TTLs. Also floors the RENDER INTERVAL a
    #                        sitemap's `changefreq` produces, and therefore the width of the
    #                        initial-render jitter: `changefreq: hourly` becomes a 6h cadence
    #                        spread over 6h, i.e. 4x the sustained render load of `daily`.
    #                        Raise this to slow a fleet down; it trades page freshness for load.
    swrTtl: 10800000 # 3h  — stale-while-revalidate window

  render:
    defaultInterval: 86400000 # 24h — how often a target is re-rendered (relative to completion)
    reconcile: # repairs targets whose schedule row went missing (see "Schedule repair")
      enabled: true
      interval: 21600000 # 6h — how often each node sweeps its own slice of the keyspace
      startDelay: 300000 # 5m — grace after boot before the first sweep
      startJitter: 300000 # 5m — per-node spread, so a rolling restart doesn't sync the sweeps
      maxRestores:
        5000 # ceiling on rows RESTORED per sweep; the scan always completes, so a
        # truncated sweep still reports the full size of the gap

  sitemap:
    refreshTime: '12:00' # local time-of-day the refresh grid is anchored on
    timezone: America/New_York
    refreshInterval:
      86400000 # 24h — spacing of the refresh slots, phase-anchored on refreshTime.
      # 21600000 (6h) with a 12:00 anchor runs at 00:00/06:00/12:00/18:00 local.
      # Passes never overlap: a slot that arrives mid-walk is skipped and logged.
    filteredWarnPercent: 50 # filtered share of one sitemap that is reported as an ERROR
    node: '' # pin the scheduled refresh to this node ('' disables it)
    workerIndex: 0 # ...and this worker
    background: true # POST returns a handle immediately; the walk runs in the background
    staleRunMs: 600000 # 10m — un-updated progress after which a run is treated as dead
    removedSampleCap: 20 # sample size of unlinked keys in the result (the COUNT is exact)
    failedCap: 100 # per-child failures retained in the result (the overflow is counted)
    userAgent: HarperSitemapCrawler/1.0 # self-identifying UA for the sitemap crawler fetch

  queue:
    jobLeaseTime: 600000 # 10m — how long a claimed job is leased (also the fast-retry pacing)
    statusSyncInterval: 60000 # 1m  — pause convergence, status broadcast, lease-gauge reconcile
    maxLeases: 4096 # lease slots in the node-local shared buffer (restart-scoped)
    ready:
      capacity: 5000 # entries in the ready set (restart-scoped)
      sitemapBoost: 2 # a sitemap-sourced row outranks a discovered one at the same lateness
    keeper: # the in-memory queue (see "The render queue")
      publishInterval: 1000 # 1s — ready-set republish; the longest a newly-due row waits
      verifyInterval: 3600000 # 1h — full check of the keeper against the table; 0 disables
      stateInterval: 5000 # 5s — queue-state recompute

  management: # the management API at /prerender_admin
    enabled: true # false makes every management route 404
    scanCap: 20000 # ceiling on rows an overview scan walks (see "Management API")
    proxyToOwner: true # ask the owning node for a residency-pinned schedule row (see below)
    peerTimeoutMs: 2500 # deadline on that peer call
    backlogSnapshotInterval: 900000 # 15m — backlog/histogram recompute cadence; 0 = manual only
    pageSize: 50 # rows per page in the console's sitemap-entry and page-cache tables
    analytics: # the console's Traffic / queue-health charts (GET /prerender_admin/analytics)
      enabled: true # one bounded PK scan of this node's hdb_analytics per refresh, cached per worker
      maxRange: 86400000 # 24h — ceiling on the window one request may ask for (scan cost scales with it)
      cacheTtl: 60000 # 1m — how long a scanned window answers from the per-worker cache
      scanCap: 150000 # rows one scan may walk; newest-first, so overflow sheds the oldest end

  analytics:
    enabled: true # record bot analytics at all: bot_request, bot_serve, route_serve, page_age,
    # route_page_age. What each one means, its dimensions, and what to chart it against are in
    # METRICS.md (and served live by GET /prerender_admin/metrics).

  crawlStats: # crawl breadth: distinct URLs crawled per bot per UTC day (HyperLogLog, ~0.8% error)
    enabled: true # also gated by analytics.enabled above; read via GET /prerender_admin/crawl-breadth?days=7
    flushInterval: 300000 # ms between sketch persists (max observation loss if a worker dies)
    retentionDays: 90 # sketch rows older than this are swept at day rollover
    maxBotsPerThread: 64 # cap on per-thread sketches; overflow bots share one '~overflow' bucket
    recordUnmatched: true # also record UAs that matched no configured bot (as 'other')
    bots: # registry: which crawlers are tracked by name. { name, match } — match is a
      - { name: Googlebot, match: googlebot } # case-insensitive UA substring; longer matches win.
      - { name: Bingbot, match: bingbot } # Remove an entry to stop tracking that bot.
      - { name: GPTBot, match: gptbot }
      # ... (see configSchema.js for the full default list)
```

Every option is declared in [`src/configSchema.js`](src/configSchema.js) — the single source
of truth for defaults, descriptions, validation (enums, numeric bounds, non-empty), and
whether a change applies live. Almost every option is **live-reloaded** when you edit
`config.yaml` — including the background schedulers (sitemap refresh pinning, schedule
repair, queue status sync), which re-arm themselves on a config change. The only
restart-scoped options are the boot-stagger knobs (`render.reconcile.startDelay`/`startJitter`);
changing one live logs a warning and is listed under `pendingRestart` on
`GET /prerender_admin/config`, which also serves the machine-readable schema
(`schema`) alongside the redacted effective config.

Options that moved in v0.25.0 (`botPathPrefix`, `excludePathPatterns` → `ingress.*`;
`securityToken`, `staging`, `userAgents`, `ignoredHeaders` → `origin.*`;
`url.queryParams` → `cacheKey.queryParams`; `sitemapUserAgent` → `sitemap.userAgent`)
still apply from their old paths, with a deprecation warning at startup.

### Ingress modes

How bot requests reach the plugin is configurable via `ingress.mode`:

- **`prefix`** (default) — the native model. A request is a bot request when its path
  starts with `ingress.botPathPrefix` (`/p/`), and the remainder of the path **is** the absolute
  target URL (`GET /p/https://example.com/page`). The device type comes from the
  `deviceTypeHeader` (`x-device-type`).

- **`forwarded`** — for sitting behind a reverse proxy / CDN that routes a
  restricted set of paths to the plugin. Here the incoming request carries a **relative**
  path, the original public host in a forwarded header, and (optionally) the device type as
  the **first path segment**:
  - `ingress.routes` is the ordered route list — see **Route classes** below. `prefix` is a raw
    string prefix, so keep routes specific (e.g. `/products/`, not `/pr`) — an overly broad prefix
    like `/` would shadow the plugin's own resource endpoints (`/render_queue`, `/queue_status`, …).
  - With `deviceTypeSource: path`, a leading `desktop`/`mobile`/`tablet` segment is consumed
    as the device type and stripped before the URL is rebuilt; if absent, the first supported
    device type is used and the path is left unchanged.
  - The absolute target URL is rebuilt as
    `${forwardedProtoHeader || defaultProtocol}://${forwardedHostHeader}${path}${query}`. A
    forwarded host that isn't a bare `hostname[:port]` is rejected (host-injection guard).

  Example: `GET /mobile/catalog/x.jsp?CN=...&utm=...` with `X-Forwarded-Host: www.example.com`
  → device `mobile`, target `https://www.example.com/catalog/x.jsp?CN=...` (a catalog route
  keeping only `CN`).

### Route classes

Every path resolves to exactly one class (`util/routeClass.js`). **No class blocks a request** —
the difference is what gets cached and what gets reported:

| class          | cached? | scheduled? | reported? | when                                                 |
| -------------- | ------- | ---------- | --------- | ---------------------------------------------------- |
| `prerender`    | yes     | yes        | no        | matched a route with `mode: prerender` (the default) |
| `passthrough`  | no      | no         | no        | matched a route with `mode: passthrough`             |
| `unclassified` | no      | no         | **yes**   | matched nothing                                      |

```yaml
ingress:
  routes:
    - { match: prefix, path: '/products/clearance/', mode: passthrough } # carve-out, ordered first
    - { match: prefix, path: '/products/', queryParams: ['category'] } # mode defaults to prerender
    - { match: exact, path: '/', queryParams: [] }
```

**First match wins**, so order most-specific first. That ordering is what lets a passthrough
carve-out sit inside a prerendered prefix without a second list and a precedence rule.

`passthrough` is a declaration that the CDN forwards a path and you have deliberately chosen not
to prerender it. It differs from `unclassified` in two ways: it is not reported (no alarm), and in
`deviceTypeSource: header` mode it is the **only** way to proxy a non-prerendered path at all —
there, an unclassified path has to fall through to the plugin's own REST endpoints, because a
route match is the only thing distinguishing bot traffic from an API call.

`queryParams` is **rejected on a passthrough route**. The allowlist produces the canonical URL
that serves as both the cache key _and_ the URL fetched from the origin. On a prerender route that
coupling is required — the fetch must retrieve exactly what the key represents. A passthrough route
has no cache and so no key, leaving an allowlist nothing to do but silently strip params from the
proxied request and hand the visitor the wrong page.

`excludePathPatterns` compiles into this list as `{ match: contains, mode: passthrough }` entries,
**prepended** so an exclude still beats any prerender route it overlaps. Note that these are now
matched against the **path** only (they used to match the whole URL string); a pattern aimed at a
query param is warned about at config-apply time.

Unclassified and passthrough traffic is counted per first path segment and flushed to the log every
`ingress.report.interval`, one line per class. Unclassified is the CDN-config report ("the CDN is
forwarding `/blog/*`"); passthrough is the coverage backlog ("we proxy this much bot traffic live,
on purpose"). The tally is in-process, so **every worker** flushes its own line — each carries
`node=` and `worker=`, and a reader sums across them.

### Discovery: one target per entity (`entityPrefix`)

Traffic discovery mints a target for any unknown URL a bot gets a cacheable 200 for. `Target` is
keyed by URL, so two spellings of one product are two unrelated rows — and crawlers keep asking for
old or invented slugs of products whose correct URL is already tracked. Each one is minted, renders,
finds its canonical pointing elsewhere, is suppressed as `canonical-mismatch`, re-renders on the
suppression recheck until `maxStrikes` deletes it, and is minted again by the next crawler hit.
Measured on one deployment: `canonical-mismatch` was 8.2% of all render outcomes, and 150 of 150
sampled suppressed targets had another target for the same product id under the correct slug.

A route that declares `entityPrefix` stops that at discovery:

```yaml
ingress:
  routes:
    - { match: prefix, path: '/product/prd-', queryParams: [], entityPrefix: '^/product/prd-[^/]+/' }
  entityGate:
    dryRun: true # the default: evaluate and count, mint anyway
```

- **The prefix.** The regex is anchored at the start of the URL path; its match plus the URL's origin
  is the entity prefix (`https://www.example.com/product/prd-123/`). Every target whose URL starts
  with it is a **sibling**.
- **The match must end on `/`.** `…/prd-123` is a string prefix of `…/prd-1234/…`, so a prefix that
  stops mid-segment would let product 1234 gate product 123 forever. A match that does not end in
  `/` is ignored for that URL (it is discovered as before, counted `no-prefix`), and a pattern whose
  source does not end in `/` is warned about at config time.
- **The decision.** A sibling **in rotation** (not suppressed) means the entity already has a target
  that will render, so the URL is not minted — it is still served (a miss proxies the origin). If
  there are no siblings, or every sibling is **suppressed**, the URL is minted. Suppressed siblings
  never block, which is what makes a genuine slug change a bounded delay rather than a permanent
  block: the new slug is gated until the old slug's next render suppresses it (one render cycle of
  the old target), then minted on its next crawl. `sitemapUrl` plays no part — a sitemap that lists
  a non-canonical URL holds a listed-but-suppressed row, and the canonical URL must still be
  discoverable.
- **Discovery only.** Sitemap ingestion, redirect adoption and the REST API create targets without
  consulting the gate; the declared corpus is always created.
- **The read.** One one-sided primary-key range over `Target` (at most 3 rows, projecting `url` and
  `state`, stopping at the first sibling in rotation), only for a URL with no target row, inside the
  detached discovery step — never on the response path. `Target` is not residency-pinned, so the read
  is node-local. Any failure mints. The 3 is fixed: measured on a production catalog, the first
  sibling in rotation was within the first 3 keys for 150/150 sampled entities; past it the gate
  mints, never refuses.

Every URL under one prefix is the same entity, query variants the route keeps included — don't set
`entityPrefix` on a route where several URLs per entity are distinct pages. The pattern runs against
crawler-supplied paths, so keep it linear: a literal prefix plus `[^/]+` segments, no nested
quantifiers.

**Rollout.** Deploy with `dryRun: true` (the default), read `prerender_ops` / `entity_gate` outcome
`would-gate` against `render` outcome `suppressed`/`canonical-mismatch`, then set `dryRun: false`.
Existing suppressed rows are untouched: they age out through `maxStrikes` as before, and once the gate
is armed they are not re-minted. Armed refusals are also counted on `discovery_gated` with the gate
name `entity`.

### Serving one render at every spelling of an entity (`entityServe`)

The gate stops crawler-invented spellings from becoming targets, but the crawlers still ask for them,
and each ask is a miss that goes to the origin. Measured on one production origin, 93% of the product
documents the raw cache stored were spellings other than their own canonical. In every case it was
the same product. The origin served one document for every spelling (68 of 70 identical on every
fact; the other 2 had changed between fetches), and the canonical's render was cached, fresh and
indexable for 199 of 200 sampled spellings. `entityServe` answers those misses from that render:

```yaml
ingress:
  routes:
    - { match: prefix, path: '/product/prd-', queryParams: [], entityPrefix: '^/product/prd-[^/]+/', entityServe: true }
  entityGate:
    dryRun: false # arm the gate too: see below
  entityServe:
    dryRun: true # the default: evaluate and count, answer every miss as before
```

On a **true miss** (no page for this key) the targets under the URL's entity prefix are read: one
bounded primary-key range, at most 8 rows, node-local. The miss is answered from another target's page
only when all of these hold. Otherwise it falls through to the raw cache, the negative cache and the
origin, exactly as before:

- **No query string** (`has-query`). A route that keys a query param says it can change the document.
- **The spelling has no target the render path keeps.** A spelling with no row of its own is answered,
  and so is one whose own target was suppressed as a canonical verdict (`canonical-mismatch`,
  `canonical-variant`): its own render found that the page names its canonical elsewhere. Measured on
  one deployment, one crawler made ~11k such misses a day. Such a spelling is answered only with the page
  its own verdict named (`Target.suppressedCanonical`, browser ≥ 1.40.0), or with a page confirmed after
  that verdict; otherwise it is `moved`. A row in rotation (a new canonical arriving from the sitemap) or
  one suppressed about the URL itself (a 404, a noindex) is `has-target`.
- **One candidate.** One target of the entity in rotation has a page for this device that is a 200,
  indexable, inside its own expiry (not SWR), and not covered by an invalidation it predates. When more
  than one does, the [entity registry](#the-entity-registry-and-adopting-the-canonical-the-origin-names-entities)
  decides if it names one of them (a re-slug whose new canonical has rendered while the old spelling has
  not yet been suppressed); otherwise it is `ambiguous`, as is more rows than the read covers. The choice
  is never guessed.
- **Its canonical was confirmed since the anchor.** The page was either rendered at or after the last
  anchor, or checked against the origin since then by a check that compared its canonical and found it
  the same (`PageCheck.canonicalAgreed`). Both the serve-time check and the probe sweep write that
  flag. An `agree` alone does not count, because it only means nothing compared disagreed. The
  reason is slug re-spells. Until the old page re-renders, it names its old slug while the origin
  already declares the new one, and serving it at every spelling would spread that contradiction. So
  **map `canonical` in the probe rule's `pageCheck.fields`**, and keep its slot out of
  `ignoreChanges` so a re-spell is a change the sweep acts on. An unconfirmed page is offered to the
  serve-time check, under that check's own switches and budget, in a dry run too. A `held` check (a
  systematic disagreement on another field, served at its own URL anyway) confirms; a `mismatch` does
  not. Outside anchored mode there is no anchor: set `ingress.entityServe.maxConfirmAge`, or nothing is
  ever confirmed.
- **The registry has not heard otherwise since** (`moved`; the registry is on by default). The registry holds the
  canonical the origin named most recently, from whichever fetch saw it first: the nightly probe, a render
  (including the canonical a canonical verdict declares), a serve-time check, or a miss proxied to the
  origin. When it names another document, first heard after the page was last confirmed, the page
  predates a re-slug and is not handed to other spellings. That closes the window between a daytime
  re-slug and the next check of the old page: the first origin fetch to see the re-slug vetoes, and the
  same observation adopted the new canonical (filed due now), which is served once it renders.
- **It names itself.** The served bytes' own `<link rel=canonical>`, read off the head, must
  canonicalize to that target's URL. `isIndexable` alone cannot say this, because a page with no
  canonical is indexable too.

It is served with the canonical's own stored headers and validators, as `bot_serve` source and status
`entity`, and debug requests get `x-harper-entity: <the key that answered>`. Each evaluation's duration
is `prerender_ops` / `entity_serve_ms`, what it adds to a miss it does not answer. It stores nothing, so it
replicates nothing. It answers the first request for a spelling, where a raw cache only answers
repeats, and it serves the rendered page instead of the unrendered document. A serve-time check of it
checks the canonical's key. Snapshots rendered with `@harperfast/prerender-browser` ≥ 1.40.0 also make
script-built `url(<page URL>#id)` references fragment-only, so a reviews widget's star fills still
resolve at the spelling's URL.

**Only for a site that answers every spelling of an entity with the same document.** To settle it,
fetch two spellings of one product from the origin and compare everything except per-response noise.
The canonical, title, description, offers and breadcrumbs must be identical, and both must name the
same canonical URL.

**Arm the entity gate with it.** A spelling this does not answer (every one, in a dry run) goes to the
origin, and a minting crawler's miss mints it. From then on it is never entity-served (`has-target`).
Armed, the gate never mints such a spelling. A served spelling is never minted either, because it was
not a miss. So with the gate in dry run, `would-serve` counts only each spelling's first request: arm
the gate first, or read `would-serve` as a floor.

**Arm adoption with it** (`entities.adopt.dryRun: false`; the registry itself is on by default). With the gate armed, a
re-slugged product's new canonical is not minted while its old spelling is in rotation, and an
out-of-stock product's is never in the sitemap. So until the old spelling's re-render suppresses it,
adoption is what files the new canonical, and the registry is what tells the entity serve the old page
has moved.

**Rollout.** Deploy with `dryRun: true`. Read `prerender_ops` / `entity_serve`: `would-serve` is what
arming would answer, and the other outcomes say why the rest fall through. Then set `dryRun: false`.

### The entity registry, and adopting the canonical the origin names (`entities`)

`Target` is keyed by URL, so two spellings of one product are two unrelated rows, and nothing records
which of them the origin calls canonical. The registry keeps one `Entity` row per entity a route
declares with `entityPrefix`, keyed by the entity prefix (`https://www.example.com/product/prd-123/`),
holding the entity's current canonical URL ([#166](https://github.com/HarperFast/prerender-plugin/issues/166)).

```yaml
entities:
  enabled: true # the default: a route opts in by declaring entityPrefix
  adopt:
    dryRun: true # the default: count would-adopt, file nothing
```

On by default, because the route's `entityPrefix` is already the opt-in. A deployment with no such route
has no entities and the registry does nothing. Alone it changes nothing a crawler sees: adoption files
nothing until `adopt.dryRun: false`, and the entity serve needs its own `entityServe`.

- **Written by observations of the origin only**: every fetch that says which URL is the entity's
  canonical. On a site whose every spelling of a product is one document, each is the origin's own
  answer for the product id, so a crawler-invented spelling cannot make it invent a canonical.
  - `probe`: the change probe's mapped `canonical` slot, every night for every product.
  - `render`: a stored render's `pageFacts.canonical`, and the canonical a canonical verdict declares
    (`@harperfast/prerender-browser` ≥ 1.40.0). After a re-slug, the render of the old spelling is often
    the first fetch to see it.
  - `check`: a serve-time check, from the endpoint's canonical slot or the origin document's canonical.
  - `origin`: a miss proxied to the origin on an `entityServe` route. Its canonical is read off the head
    as the crawler's bytes stream by (at most 128 KiB, and at most 32 at once per worker), so it costs no
    second request and nothing the response waits on. It moves a row the registry already holds and never
    creates one (`untracked`), so a crawler asking for invented product ids cannot create rows; a URL with a
    query string is not read, and the tap stops with `ingress.entityServe.enabled`.
  - When two observations disagree, the newer wins. A render's instant is when it read the origin
    (store time less the sum of its renders), so a render claimed before a re-slug can't undo the probe
    that saw it.
  - An unchanged observation writes nothing, and neither does the same canonical spelled otherwise
    (`%27` for an apostrophe). That is one document, as the probe's own `path` comparator already
    treats it.
  - A canonical under another entity's prefix is ignored, and so is one with a query string, and a relative
    path (only an absolute URL or a `/`-rooted path counts).
- **Adoption.** When any observer names a canonical that is another URL of the same entity than the one
  it observed, and no target holds it in rotation, its target is filed due now and urgent, as redirect
  adoption does.
  - A target suppressed as a canonical verdict (`canonical-mismatch`, `canonical-variant`) is reactivated
    the same way. One suppressed for any other reason (a 404, a noindex) is left alone.
  - Bounded by `maxPerHour` per node, shared by every worker thread and every observer; by `retryAfter`
    per entity, whichever canonical (a canonical that did not take is filed once per window, not nightly,
    so it costs one render a week for as long as the origin names it, and two spellings naming each other
    cannot reactivate each other in turn); and by both dry runs. A probe pass run as a dry run, including
    an operator's measure-only sweep, files nothing.
  - In a dry run, what arming would file is `would-adopt` plus `capped`. A dry run remembers each entity
    it would have adopted (`wouldAdoptAt`), so a repeat inside `retryAfter` reads `recent` as it would
    armed, and it spends its own lane of the hourly budget, never an armed node's real slots.
- **Why.** Measured on one deployment, products re-slug ~100 times a day and the product sitemap
  changes once a day. An out-of-stock product is not in the sitemap at all, so its new canonical
  arrived only by traffic discovery, with its first render jittered across the route's 96h interval.
  Every spelling missed for one to four days.
- **Needs a rule that maps `canonical`**, e.g. `{ slot: 6, fact: canonical, compare: path }`, with the
  slot kept out of `ignoreChanges` so a re-slug is also a change the sweep acts on.
- **Cost.** Replicated and not residency-pinned. The first probe pass with the registry on writes one row
  per probed entity, paced by the probe, and renders fill in the rest. After that it writes only when a
  canonical moves.
- **Read by the entity serve** (above): a page whose canonical the registry has since heard move is not
  handed to other spellings (`moved`), and a tie between two servable spellings goes to the one it names.
- **Inspect it:** `GET /prerender_admin/explain?url=…` reports `rows.entity` (the canonical, who named it,
  when, and the last adoption). Outcomes: `prerender_ops` / `entity_canonical` and `canonical_adopt`,
  both with the observer as context. The console's Traffic view charts them.

Still to come ([#166](https://github.com/HarperFast/prerender-plugin/issues/166) phase 2): the probe walks
entities rather than every target, through a host-supplied entity source
([#242](https://github.com/HarperFast/prerender-plugin/issues/242)), and the entity gate does a point read.

### Sitemaps are filtered to prerender routes

A sitemap is written for search engines: it lists every indexable URL on the site, which is routinely
a superset of the paths the CDN forwards here. Entries that are not a `prerender` route are counted
and **not scheduled** — creating a target for one would render and store a page no read ever looks
up, which is render load and cache growth for no served output.

`Sitemap.refresh` reports what it dropped:

```json
{
	"created": 1200,
	"updated": 0,
	"skipped": 40,
	"duplicates": 0,
	"removed": 0,
	"removedSample": [],
	"filtered": { "passthrough": 3, "unclassified": 812 },
	"deferred": 0,
	"sitemapsProcessed": 31,
	"sitemapsDiscovered": 31,
	"failed": [],
	"failedOverflow": 0,
	"truncatedScans": []
}
```

`removed` is a count with a capped `removedSample`, not the full record list it used to be — one
walk over a large index can unlink more rows than belong in an HTTP response.

A large `filtered` share is far more likely to mean `ingress.routes` is incomplete than that the
sitemap is wrong, so past `sitemap.filteredWarnPercent` (default 50%) it is logged as an **error**
rather than an info line — a silent filter otherwise looks exactly like a healthy refresh while
removing most of the render coverage.

`deferred` counts existing targets whose URL no longer classifies as `prerender`. Those are
deliberately left untouched: the refresh **unlinks** a target that genuinely left the sitemap
(`sitemapUrl: null`) but must not do that to a filtered URL, because unlinking leaves the
`RenderSchedule` row intact — the target would keep rendering forever with nothing tracking it.
Retiring them needs guardrails that belong to the schedule-repair sweep, not to an ingest pass.

A forwarded-mode config that compiles to **zero** prerender routes is reported as a warning
(`/prerender_admin` surfaces it): nothing is prerendered in that state, and it is what a single
typo produces, since invalid entries are dropped one at a time.

### A sitemap index is not an HTTP-request-sized unit of work

A real index fans out to tens of children and over a million target writes. `POST /sitemaps/<url>`
therefore answers immediately with a handle and walks in the background:

```json
{
	"background": true,
	"sitemaps": [
		{ "url": "https://www.example.com/sitemap.xml", "started": true, "progress": "/sitemap_refresh/https%3A%2F%2F…" }
	]
}
```

Poll `GET /sitemap_refresh/<root-url>` for `state` (`running` / `completed` / `failed`),
`sitemapsProcessed` of `sitemapsDiscovered`, the running counts, and `updatedAt` — which is bumped
after every child, so a stalled walk is distinguishable from a slow one. `POST` with
`{"background": false}` blocks instead, which is what a small sitemap or a test wants.

Four properties matter at index scale:

- **One bad child no longer loses the rest.** A child that 503s, returns an HTML error page, or
  fails to parse is recorded in `failed[]` and the walk continues. Only a failing **root**
  propagates, because that means the request itself was invalid and nothing was accomplished.
- **A second refresh of the same root is refused** while one is running, so re-POSTing a slow index
  does not start a competing walk. A run whose progress goes stale past `sitemap.staleRunMs` is
  treated as dead and taken over — otherwise a worker restart mid-walk would block that root
  forever. The guard is advisory, not a lock; the walk is idempotent.
- **Refresh-all visits roots only.** Every document reached during a walk gets its own `Sitemap`
  row, children included, so a "refresh everything" pass used to walk each child **twice** — once
  by descending the index, then again as a top-level row. `parentUrl` records who listed whom.
  Rows written before this field existed read as roots and are re-stamped on the first pass.
- **A URL listed by two sitemaps is owned by the first one that claims it.** Overlapping children
  are normal — a catalog spanning facets will list the same page under several — and previously
  each walk handed the URL back and forth between them. Nothing converged: `updated` never reached
  zero (so it was useless as a "did anything change" signal), the stored `renderInterval`
  oscillated between whatever the two declared, and which sitemap owned the URL — and therefore
  what a `DELETE` would take with it — depended on index ordering. A walk now leaves a target
  alone when it is already owned by a sitemap that same walk has visited, and reports the count as
  `duplicates`. A sitemap that _failed_ this walk still counts as an owner: a bad fetch is not a
  reason to reassign its URLs.

- **Re-attributing a URL no longer resets its render clock.** A URL listed in two sitemaps, or moved
  between fixed-size paginated product sitemaps, changes `sitemapUrl` without changing the page.
  That now `patch`es attribution instead of re-`put`ting the target, because a `put` recomputes
  `getInitialRenderTime` and pushes the next render forward by a fresh jitter on every pass.

### Residency: reads block on the owner, writes do not

`RenderSchedule` is pinned with `setResidencyById`, so on a multi-node cluster most of its keys
belong to some other node. The two directions behave very differently, and the asymmetry is easy to
get backwards — v0.15.0 did, and shipped a deadline around a write that never needed one.

A **read** of a key this node does not own takes Harper's replication fetch, which has **no
timeout**: it can hang the caller indefinitely. Every such read in this plugin therefore passes
`replicateFrom: false` and accepts a node-local answer, and `util/reconcile.js` is built entirely
around that constraint — each node repairs only the keys it owns, because only there is its local
read authoritative.

A **write** does not forward at all. Harper computes the residency list, sees this node is not in
it, omits the local record, commits, and lets replication ship it asynchronously — there is no
acknowledgement to wait for. Measured against a live instance with residency pinned to a node that
does not exist: 500 writes in 10.7ms (mean 0.021ms). An unreachable owner costs the writer nothing,
so no deadline is needed and none is applied.

### How bulk sitemap population is staggered

Populating a large sitemap must not queue every URL at once. A new target's first render is
therefore `now + (hash(url) % renderInterval)`, floored to the minute — a uniform spread over the
interval, so the fleet sees a flat stream rather than a herd. Because `processJobResult`
reschedules from **render completion** (`currentMinuteMs() + interval`) rather than a fixed
time-of-day, that spread is preserved cycle over cycle and self-paces to fleet throughput.

Three properties are worth knowing before a bulk upload:

- **The stagger window is the target's own `renderInterval`, not a fixed 24h.** For a sitemap
  target that comes from `changefreq`, floored at `page.minTtl` — so `always`/`hourly` spread over
  `minTtl` (6h by default) and re-render that often, i.e. 4× the sustained load of `daily`. A
  sitemap's `changefreq` is the single biggest determinant of steady-state render load, and it
  comes from the sitemap XML, not from this config. Check it before uploading.
- **A URL's device variants share one slot.** The offset is seeded off the URL half of the cache
  key, so `…|desktop` and `…|mobile` come due together, sort adjacently in claim order, and get
  rendered back-to-back by one worker off a warm origin. It also keeps the cached copies of one
  page the same age — seeded off the full key they drifted up to a whole interval apart, so a
  content change could appear on one device and not the other for hours.
- **`revalidate: true` bypasses the stagger entirely**, setting every entry due in the same
  minute. That is its purpose (forcing a backfill), but it is not how to warm a large sitemap for
  the first time — omit it and let the jitter place the URLs.

There is no separate "warm-up" pacing knob, and none is needed: the initial spread is exactly the
steady-state cadence, so a fleet that can sustain the ongoing load can absorb the warm.

### Staging passthrough

To verify an origin against a staging edge (e.g. a CDN's staging network) _through_ the
plugin, set `origin.staging.ip` to the staging edge IP. Then any **cache-miss** bot request that carries
the `origin.staging.header` request header (`x-harper-staging` by default) has its origin fetch connected
to that IP instead of the public origin. Only the TCP address is pinned — the `Host` header and TLS
SNI stay the real origin host — so the staging edge serves the right property and presents a valid
certificate (the server-side equivalent of a `host-resolver-rules` / `/etc/hosts` override).

- **Cache hits are unaffected.** The header is not part of the cache key, so a cached page is always
  returned as-is; only the live origin fetch on a miss is redirected.
- **The header is a toggle, not a target.** The connect address is always the configured
  `origin.staging.ip`, never a value from the request — so a request can't repoint the fetch at an
  arbitrary host. Leave `origin.staging.ip` empty (the default) to disable the feature entirely; production
  is unaffected unless a staging IP is explicitly configured.
- With the `debugHeader` also present, a staging-served response is tagged with the
  `x-harper-origin: staging` response header so you can confirm it.

### Database topology

Database/table names are fixed. Tables are split across databases by write-transaction coupling —
Harper serializes writes per database and commits each database independently, so the hot, high-write
queue table is isolated and bursty/heavy writes don't serialize against it:

| Database          | Tables                                  | Notes                                                             |
| ----------------- | --------------------------------------- | ----------------------------------------------------------------- |
| `render_schedule` | `RenderSchedule`                        | the hot render queue — isolated                                   |
| `render_service`  | `Target`, `QueueStatus`, `QueueControl` | target registry, observed status, desired status                  |
| `page_cache`      | `PrerenderedPage`                       | rendered-HTML cache (heavy blob writes)                           |
| `sitemaps`        | `Sitemap`, `SitemapRefresh`             | sitemap data + per-root refresh progress                          |
| `invalidation`    | `Invalidation`                          | bulk-invalidation epochs (one row per scope)                      |
| `crawl_stats`     | `CrawlSketch`, `VisitFilter`            | crawl-breadth and miss-cause sketches, demand-tracker visit bloom |
| `coordination`    | `SharedBuffer`                          | node-local cross-worker SAB (never replicated)                    |
| `config`          | `ConfigOverride`                        | operator-set config overrides — isolated because it is SUBSCRIBED |

`config` is alone in its database for a reason that is not write volume — the table is written a few
times a week. **A subscription is a per-database cost.** Harper's audit log spans every table in a
database (each reader filters on `auditRecord.tableId`), so `addSubscription` attaches its `committed`
listener to the _database's_ audit store, and every commit there schedules a pass that iterates the
transaction log. Living in `render_service` would have made every `Target` and `QueueStatus` write pay
for a subscription to a table nobody writes — on every worker, since every worker subscribes — which is
the same rocksdb txn-log iteration that has pegged worker threads in this deployment before. Write
serialization says the same thing from the other side: a config write would otherwise queue behind the
URL registry, and vice versa, for two tables that never need to be atomic with each other.

Because `RenderTarget` and `RenderSchedule` now live in separate databases, a target and its schedule
are written as two independent commits (target first). The brief window where a target exists without a
schedule is benign and self-heals on the next sitemap refresh / `revalidate`.

See [`src/schemas/schema.graphql`](src/schemas/schema.graphql).

#### The render queue: the queue keeper (v0.93.0)

Worker 0 on each node holds every `RenderSchedule` row that node owns in memory, kept current by a
subscription on the table. **The keeper is the queue, and `RenderSchedule` is its durable side**: the
table is read by primary key only, and `nextRenderTime` carries no index
([#215](https://github.com/HarperFast/prerender-plugin/issues/215)).

- **Claims.** Every `queue.keeper.publishInterval` (1 s) the keeper publishes the best of the due set,
  in claim order, into a shared buffer (the ready set). A claim, on whichever worker the poll landed,
  takes entries in order, point-reads each one's row locally, skips any that is no longer due
  (`queue_health` `claim_stale`), and leases the rest. The lease grant is exclusive, so claims need no
  mutex and a key published in two consecutive sets is still granted once
  ([#218](https://github.com/HarperFast/prerender-plugin/issues/218)). A short claim is short: the
  keeper republishes within a second.
- **Order.** Relative lateness: `max(0, now − dueAt) / effectiveInterval`, times
  `queue.ready.sitemapBoost` for a sitemap-sourced row. Absolute due time treats a 1 h-TTL homepage 3 h
  overdue like a 48 h-TTL product page 3 h overdue — 300% stale against 6%
  ([#80](https://github.com/HarperFast/prerender-plugin/issues/80)). Lateness rather than age, because
  `dueAt − interval` is not when the page last rendered for every row (suppression rechecks file 7
  days out, `backoffWait` up to `maxBackoff`). The cadence is the row's own `effectiveInterval` — rung
  > route > stored > default, so a page `render.demand` promoted to 6 h is not ranked as if it were on
  > its route's 24 h ceiling. `sitemapBoost` is a multiplier, never a tier, so a discovered page is
  > served within roughly `sitemapBoost ×` the worst sitemap ratio. Rows are grouped by class (route ×
  > cadence × sitemap flag × change or urgent mark × demand estimate), within which due time already orders them,
  > so the best K is a merge over class heads, not a scan.
- **Changed pages first, most-asked-for first.** A row the change probe filed (`changedAt`) starts
  `queue.ready.changedHeadStart` cadences ahead. With `queue.ready.changedDemand` (default on) its wait
  is counted in the page's visit periods instead of its cadence — the demand tracker's estimate, stamped
  on the row as `demandPeriod` when the change was acted on — so the score is the bot visits the wait has
  sent to the origin, and a change wave renders the pages bots ask for first. A row with no estimate
  (tracker off, cold or saturated) orders by cadence.
- **A single ask to render now starts ahead too, but behind a change.** A row filed due now by a
  render-now, an admin revalidate or rejoin of one URL, an adopted redirect destination or a first
  sitemap listing (`urgentAt`) starts `queue.ready.urgentHeadStart` (0.5) cadences ahead; filed at the
  current minute it would otherwise rank behind every overdue row. Half the change's head start, so a
  page found changed — answered from the origin while it waits — outranks an equally late ask. Bulk
  re-files (a revalidate over a collection, a sitemap walk with `revalidate: true`) are not asks. Both
  head starts are in boosted units — multiplied by `sitemapBoost`, as sitemap lateness is — so a fresh
  marked row outranks every routine row less than that many cadences late, sitemap-listed or not.
- **It repairs itself from the table.** Each publish re-reads the head of what it published and fixes
  what it holds wrongly. A verification walk (`queue.keeper.verifyInterval`, 1 h) checks every row it
  owns and every row it holds against the table and repairs the difference (`keeper_repaired`,
  expected 0), which bounds a missed write to one interval. A repair never overwrites a newer write: it
  applies the read only if the keeper's entry did not change during it.
- **Ownership.** It holds only rows this node owns by residency, so a stale row left by an earlier
  ownership (a "residency ghost") is never rendered. A node with configured peers (`system.hdb_nodes`
  names another node) waits to see one before loading, up to two minutes; a single node loads at once.
  A row stored here but owned elsewhere is not held; the verification walk counts them
  (`trust.keeper.verify.unowned`).
- **It serves while it loads, and never reloads once live.** The ready set is published from the first
  chunk of the load (every grant is checked against its row, so a partial queue is safe; only its order
  is incomplete for the first seconds). After that nothing reloads: a route or default-interval change
  reclassifies every held row in memory; a membership change drops the rows this node no longer owns
  in memory and runs the verification walk to add the ones it gained; a closed subscription is reopened
  and walked. Claims are served throughout.
- **Until its first publish, this node grants no claims** and reports the queue status `unready` (a
  render fleet that predates it reads an unknown status as `empty` and polls at its idle interval).
  `queue-state` answers 503 until the load finishes. Each change of status is reported by the keeper at
  once, so the fleet is woken by it rather than finding out on its next idle poll.
- **An unreadable row does not hide the rows past it.** When the load's walk cannot get past a key that
  did not decode, the rest of the table is read from the top down to it. Only if that stops short too is
  the queue partial (`exact: false`, logged).
- **A render that never reports is bounded.** A key whose last `render.failureRetry.fastRetries + 2`
  leases all expired with no result (a renderer crashing on the URL, or results not reaching this
  node) is held back in the lease table instead of granted again: two leases, then four, eight, …
  capped at its cadence. Nothing durable is written and no strike is counted; the first result that
  arrives for the key clears it, so a node-wide delivery outage delays rows by a few leases, not by a
  cadence. Named in a warning and counted (`queue_health` `claim_wedged`).
- **A stalled worker 0 degrades, it does not stop claims.** Its last published set is still granted from,
  each entry checked against its row, until it drains; only then does the node report `unready`.

Measured before it was built ([#215](https://github.com/HarperFast/prerender-plugin/issues/215);
harnesses in [#216](https://github.com/HarperFast/prerender-plugin/pull/216) and
[#217](https://github.com/HarperFast/prerender-plugin/pull/217)):

- A node's subscription gets a `put` for every write to a row it owns, from any node, and a no-op
  `delete` for each write it makes to a row it does not own. On two nodes every distinct row written
  to an owner reached its keeper, and each keeper matched its own table row for row.
- A replication base copy that carries any row of the table re-sends the whole table to live
  subscribers; the keeper absorbs it (applying a row's current value twice changes nothing).
- About 200 B of heap per row (about 50 MB at 250k rows). A primary-key load at start: about 1 s per
  250k rows on a fresh store, expected tens of seconds on a churned one. `topK(5000)` over 250k rows:
  0.14–0.27 ms.

**Leases** are node-local shared-buffer state (`coordination.SharedBuffer`, never replicated): a fixed
array of slots keyed by a 64-bit hash of the schedule key, at zero database operations. Losing them on
a restart is correct — a lease is not a record of work, the row is, and it was never moved — so a job
whose lease vanished is granted again; the cost is a duplicate-render burst for whatever was in flight.
Lease state is per node, so only the owner can answer "is this key being rendered right now"; the URL
explainer asks the owner.

`GET /prerender_admin/queue-state` (node-local; sum nodes for the cluster):

| Group      | Fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `now`      | `due` (`dueSitemap`, `dueDiscovered`), `dueChanged` (due rows the change probe marked: pages expired as known-wrong, served from the origin until they re-render), `oldestChangedAt` (the oldest such row's due minute — its filing minute, or the earlier due time it already had) and `changedByDemand` (the same rows by demand estimate: `periodMs` between bot visits, `null` for unknown, with `due` and `oldestDueAt`), `inFlight` (live leases), `unclaimed` (`due − inFlight`, an estimate), `paused`, `status` |
| `coming`   | `next15m`, `next60m`, `next24h`, `byHour[24]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `lateness` | due rows binned by lateness in their own cadences (`edges` 0.25/1/2/4), `sitemap` / `discovered`, `byRoute`, and per class (route × cadence × sitemap flag) the oldest due row; `listsTruncated` when either list was cut to 200                                                                                                                                                                                                                                                                                         |
| `flow`     | per minute for the last hour: `cameDue`, `added`, `triggered`, `rescheduled`, `removed`                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `trust`    | `live`, `phase`, `exact` (false if the load skipped unreadable rows or the last verification repaired any), `stateAt`, `stateAgeMs`, the keeper's load, publish and verification stats                                                                                                                                                                                                                                                                                                                                   |

Counts are of rows this node owns. It answers **503** (with `trust` and the live `now` fields, and no
counts) whenever the keeper cannot vouch for its numbers: waiting, loading, failed, or state older than
three state intervals.

**Removed in v0.93.0**, with the index they existed for: the claim floor and its unpin hatch, the
ready-set sweep, the index claim scan, the `reset-claim-floor` queue action, and the config keys
`queue.claimFloor.*`, `queue.claimScanCap`, `queue.ready.enabled`, `queue.ready.sweepInterval`,
`queue.ready.sweepCap` and `queue.keeper.enabled`. A deployment that still sets any of them gets an
"Unknown configuration key" warning and nothing else; delete them.

## HTTP & resource API

| Method & path                                | Purpose                                                             |
| -------------------------------------------- | ------------------------------------------------------------------- |
| `GET /p/<absolute-url>`                      | Serve prerendered/cached HTML for a bot (cache hit or origin fetch) |
| `POST /render_queue/pause`                   | Pause **this node's** queue                                         |
| `POST /render_queue/resume`                  | Clear this node's pause override                                    |
| `POST /render_queue/claim`                   | Claim due render jobs (`{ "limit": N }`) — one job per URL          |
| `POST /render_queue/job_result`              | Submit a render result (binary; `x-metadata-size` header)           |
| `GET/PUT/DELETE /RenderTarget/...`           | Manage render targets                                               |
| `POST /RenderTarget` `{action:"revalidate"}` | Force re-render of matching targets                                 |
| `GET/POST/DELETE /sitemaps/<url>`            | Ingest / list / remove sitemaps                                     |
| `GET /sitemap_refresh/<root-url>`            | Progress + outcome of a background sitemap walk                     |
| `GET /queue_status`                          | Read per-node queue status (**observed**)                           |
| `GET /queue_control`                         | Read the desired pause state (**intent**)                           |
| `GET /prerender_admin`                       | Management API — see below (UI: @harperfast/prerender-console)      |
| `GET /prerender_admin/metrics`               | The metric catalog — see [METRICS.md](METRICS.md)                   |

## Management API (`/prerender_admin`)

The JSON management surface. **API-only since v0.47.0**: the console UI that consumes it is
the separate [`@harperfast/prerender-console`](../console) component, deployable on this
cluster, another cluster, or a laptop — it forwards the operator's sign-in to these routes
per node and proxies every call, so this resource stays the sole authenticator and the
route table below stays the whole contract.

**Authentication is Harper's own.** `POST /prerender_admin/login` calls Harper's
`context.login()`, which authenticates against Harper users and sets the `hdb-session`
cookie; every data and action route then requires `role.permission.super_user`. There is no
separate password to configure. Two consequences worth knowing:

- The instance needs `authentication.enableSessions: true` (Harper's default). The UI says so
  explicitly if sessions are off rather than failing obscurely.
- With `authentication.authorizeLocal: true` (also the default) requests from `127.0.0.1` are
  auto-authorized as super-user — so on a local instance the UI opens without a login. Set it
  to `false` if that matters to you.

The super-user check is written out on every route rather than relying on Harper's
`allowRead`/`allowCreate` hooks, because those only run when `loadAsInstance !== false` — and
this plugin's resources all set `loadAsInstance = false`.

| Method & path                              | Purpose                                                                                                                                   | Gate         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `GET /prerender_admin[/]`                  | API index: what this is, where the UI lives                                                                                               | public       |
| `GET /prerender_admin/session`             | who am I                                                                                                                                  | public       |
| `POST /prerender_admin/login`              | `{ username, password }`                                                                                                                  | public       |
| `POST /prerender_admin/logout`             | end the session                                                                                                                           | session      |
| `GET /prerender_admin/overview`            | nodes, counts, backlog snapshot, host facts                                                                                               | `super_user` |
| `GET /prerender_admin/queue-state`         | this node's queue from the keeper; 503 if unsure                                                                                          | `super_user` |
| `GET /prerender_admin/config`              | effective config, layers, overrides, warnings                                                                                             | `super_user` |
| `GET /prerender_admin/sitemaps`            | root sitemaps + refresh state (never `entries`)                                                                                           | `super_user` |
| `GET /prerender_admin/pages`               | `?prefix&cursor&limit` — page-cache browse                                                                                                | `super_user` |
| `GET /prerender_admin/page-content`        | `?cacheKey` — one stored page, as `text/plain`                                                                                            | `super_user` |
| `GET /prerender_admin/unrouted`            | this worker's unrouted-path tally (peek)                                                                                                  | `super_user` |
| `GET /prerender_admin/analytics`           | `?range` (ms) — series + per-node system health                                                                                           | `super_user` |
| `GET /prerender_admin/invalidations`       | active bulk-invalidation rows                                                                                                             | `super_user` |
| `GET /prerender_admin/crawl-breadth`       | `?days` — distinct URLs crawled per bot per day, and distinct MISSED URLs per miss cause (`misses` per day, `missUnion` across the range) | `super_user` |
| `GET /prerender_admin/metrics`             | the metric catalog (see METRICS.md)                                                                                                       | `super_user` |
| `POST /prerender_admin/explain`            | `{ url, deviceType }` → cache-key trace                                                                                                   | `super_user` |
| `POST /prerender_admin/schedule`           | `{ url \| cacheKey }` → this node's schedule row                                                                                          | `super_user` |
| `POST /prerender_admin/queue`              | `{ scope, paused }` → pause control                                                                                                       | `super_user` |
| `POST /prerender_admin/revalidate`         | `{ url, deviceType }` → make one URL due now                                                                                              | `super_user` |
| `POST /prerender_admin/reconcile`          | start a schedule-repair sweep on this node                                                                                                | `super_user` |
| `POST /prerender_admin/sweep-orphans`      | `{ dryRun?, maxDeletes? }` → key-rule orphans                                                                                             | `super_user` |
| `GET /prerender_admin/sweep-orphan-pages`  | this node's page orphan sweep (live or last)                                                                                              | `super_user` |
| `POST /prerender_admin/sweep-orphan-pages` | `{ dryRun?, minAgeDays?, maxDeletes?,                                                                                                     | `super_user` |
|                                            | ratePerSecond? }` → targetless pages, or stop                                                                                             |              |
| `POST /prerender_admin/backlog`            | recompute the backlog/histogram snapshot now                                                                                              | `super_user` |
| `POST /prerender_admin/sitemap`            | `{ url, offset, limit }` → one sitemap's detail                                                                                           | `super_user` |
| `POST /prerender_admin/sitemap-refresh`    | `{ url? }` → background walk of one/all roots                                                                                             | `super_user` |
| `GET /prerender_admin/change-probe`        | running pass, next run, last passes (this node)                                                                                           | `super_user` |
| `POST /prerender_admin/change-probe`       | `{ action?: "sweep"\|"canary", dryRun? }` → run                                                                                           | `super_user` |

**Node health** comes in two node-scoped pieces, neither of which adds a scan:

- `overview.host` — point-in-time facts from the answering worker's `os`/`process` and
  `/proc/meminfo`: `hostname`, `cpus`, `totalMemory`, `availableMemory` with
  `availableMemorySource` (`'meminfo'` is the kernel's `MemAvailable`, which counts reclaimable
  page cache; `'freemem'` is the off-Linux fallback, which does not), `swapUsed`/`swapTotal`
  (null without `/proc/meminfo`), `loadavg`, `uptimeSec` (the Harper process — it resets on a
  restart), `pluginVersion`, `harperVersion` (null when it cannot be determined) and
  `nodeVersion`. Memory and load are the host kernel's figures; where the process runs under a cgroup
  memory limit below host RAM, `memoryLimit` and `memoryLimitAvailable` (Node 22+'s
  `process.constrainedMemory()` / `availableMemory()`) carry the container's own ceiling and what is
  free under it — null when there is no real limit.
- analytics `system.nodes[]` — Harper's own per-node rows (`resource-usage`,
  `main-thread-utilization`, `utilization`, `storage-volume`; a handful per node per aggregation
  pass), kept from the same walk as the series and bucketed identically: `cpu` (fraction of ONE
  core, so it can exceed 1), `majorFaults` (summed per bucket), `rss`, `heapUsed` (the main
  thread's heap only), `elu` and `workerElu` (main-thread and worker event-loop utilization, as
  Σactive ÷ Σ(active + idle)), `taskQueueLatency` (ms), and `latest` — each field's newest value
  plus `diskAvailable`/`diskSize` for the fullest volume in the newest pass. A null is a bucket
  with no sample, never a zero. One entry per node id in the table (several when `hdb_analytics`
  replicates), named from `system.hdb_analytics_hostname`.

The console is fully self-contained: its stylesheet, scripts and fonts are served from the
same resource (the Ubuntu and Fira Code subsets are vendored with their licenses in
`src/admin/fonts/`), the CSP is `default-src 'none'` with `'self'` allowances and **no**
`unsafe-inline`, and nothing on the page loads from a third party. Static assets are public
like the shell — they ship in the package and carry no data; every data route re-checks
`super_user`. `page-content` is served as `text/plain` with `nosniff`, never `text/html`:
stored markup is origin-influenced content, and serving it as HTML from this origin would
execute it against the operator's super-user session.

### What the console shows

(The views live in `@harperfast/prerender-console`; they are documented here because every
panel is a reading of THIS package's data model, and the concepts below — snapshots, leases,
schedule repair — are plugin behavior.)

- **Health** — the landing page: every number worth checking, each with a verdict (ok / watch /
  bad) and the view that explains it. Its system section reads the per-node vitals this package
  serves since v0.92.0 — `analytics` → `system.nodes[]` (Harper's own per-minute resource rows,
  folded in the same scan) and `overview` → `host` (a point-in-time host block) — see "Node health".

- **Queue** — per-node queue status, intent and throughput, the due-now backlog and its time to
  clear at the observed render rate, the in-flight count, and a next-24h histogram of
  `nextRenderTime` (these backlog panels were on the retired Overview). That histogram is the
  quickest way to tell a healthy jittered spread from a render herd: a flat distribution means the
  initial-render jitter is working, a single tall bar means everything comes due at once. Since
  v0.93.0 the counts come from the queue keeper and are exact.

  **The due-now backlog is still the capacity signal, but its healthy floor is no longer zero.**
  A claimed job's schedule row keeps its past due time until its result lands, so "due now"
  includes every in-flight render. Jitter flattens the arrival curve but cannot lower it, so a
  backlog that climbs and never returns to _roughly the in-flight count_ means sustained demand
  (`Σ targets ÷ renderInterval`) exceeds fleet throughput. The two numbers are shown side by side
  and never subtracted: one is a snapshot that may be fifteen minutes old, the other a gauge read
  at request time. Hour 0 of the histogram no longer holds the in-flight population for the same
  reason.

  **In flight** is a live read of the node-local lease buffer, and is labelled as such.

  The backlog/histogram is a **cached snapshot**, not a page-load query. It recomputes on
  `management.backlogSnapshotInterval` (worker 0 of each node, result in the node-local
  coordination database) and the page shows it with its age. _Recompute_ triggers a one-off
  pass; a dashboard refresh never touches the table. For the live queue, read
  `GET /prerender_admin/queue-state`.

- **Traffic** — the delivery half of [METRICS.md](METRICS.md)'s catalog, charted: origin
  offload, cache-served and fresh-hit rates, serves by freshness state over time, the per-bot,
  per-device and status-code mix, origin-fetch cost and reasons, a per-route cadence table, and
  on-demand crawl breadth. Freshness is reported **relative to the cadence each route is
  configured for** (`page_age` ÷ that route's `renderInterval`, since a page expires one interval
  after it is stored), so 1.0 means "exactly due" on every route and a 2h-cadence route is
  directly comparable to a 24h one; absolute age is one click away. The non-hit verdicts are
  broken out by **what would fix them** — coverage (`miss`), cadence (`swr`/`stale`), blob
  integrity (`blob-*`, `peer-rescue`), invalidation, and requests that were never cacheable —
  each with the origin latency it cost, because "miss rate" folds five different problems into
  one number. The coverage figures are stated **net of URLs the origin does not have**: a miss
  whose origin fetch came back 404/410 is not a gap in the corpus (and can never close, since only
  a 200 is ever scheduled), so it is carved out and shown beside the number rather than inflating
  it — the netting is exact, and is switched off with a label under a bot filter, where
  `origin_fetch` carries no bot name. A **bot filter** narrows every panel whose metric carries a bot name
  (`bot_request`, `bot_serve`, `page_age`, the crawl sketches) purely client-side, never a
  refetch; the panels whose metrics have no bot dimension say "all bots" on their face.

  **The statistic follows the question, per panel.** `hdb_analytics` carries mean, median and p95;
  they answer different things and the console picks deliberately. Capacity uses the **mean**
  (renders/hour is concurrency ÷ mean render time, never ÷ p95 — and the mean is also the only
  statistic that merges exactly across combos, buckets and nodes). "What does a crawler normally
  get" uses the **median** — serve time, origin cost, served age. **p95** is kept for the tail
  alone, where a pathology hides behind a healthy middle (a cohort of cache hits at 13.6s while
  the median stayed at 2.3ms). The render-time tile carries a second figure for the same reason:
  since browser v1.18.0 a non-indexable page can bail without settling, so the pooled mean falls as
  the BAIL RATE rises — a real throughput gain, but not a faster settle — and the mean of the
  renders that actually produced a stored page is shown beside it. Two further consequences worth
  knowing: serve time is reported per cache
  verdict rather than pooled, because a single figure over a 2ms population and a 400ms one tracks
  the hit rate rather than any latency; and staleness is judged on the median, because a page's
  age walks from zero to its interval, so an evenly refreshed corpus sits at 0.50× with its p95
  already at ~0.95× — a p95 threshold would flag a healthy fleet.
  **Everything is this node's slice**
  (analytics rows are node-local): ratios are representative of the cluster, totals are 1/N.
  All of it comes from ONE bounded, row-capped primary-key scan of `hdb_analytics` per
  refresh — never one scan per metric name — answered from a per-worker cache for
  `management.analytics.cacheTtl`, and the page footer states what the refresh actually cost.
  The Overview's serve strip and the Queue view's render panels read the same cached window,
  so opening all three costs one scan, not three.

- **Sitemaps** — the root list with per-root refresh state (running / failed, with the child
  failures), a capped count of targets attributed to the selected sitemap, and a paged entry
  table with per-entry state (`cached` / `stale` / `scheduled` / `filtered` /
  `non-indexable`). A sitemap **index** is presented as what it is: its entries are child
  sitemaps, so they get a drill-in rather than the page columns (`changefreq`, `priority`, cache
  state and the cache-key explainer are all meaningless for an XML document that is never
  prerendered), and its target count is omitted rather than reported as zero — a walk attributes
  every Target to the child that listed the URL, never to the index. A child opens in place with
  a link back to its parent, which is the only way to reach one: the list is roots only. A `filtered` verdict costs no reads — it comes from the same route
  classifier the serving path uses. Alongside it, the unrouted-path tally: bot traffic served
  without prerendering, bucketed by first path segment, labelled with the worker whose slice
  it is.
- **Page cache** — browse `PrerenderedPage` by cache-key prefix (a primary-key range; the
  table's only index) with cursor paging. Freshness/indexable dropdowns filter the fetched
  page only and say so — those fields have no index, and the console never pretends
  otherwise. _view HTML_ streams the stored bytes as `text/plain`; _explain_ hands the row to
  the URL explainer.
- **Queue & nodes** — cluster/per-node pause controls (intent vs. observed, see "Queue
  control"), the queue keeper per node (console v0.18.0+: phase, repairs, wedged and stale claims,
  lease slots, lateness, flow, from `queue-state`) — plus this node's supply side from the shared analytics window: render
  outcomes over time (the "renders are failing" shape as it develops, with the auth-failure-vs-
  suppressed signature called out), render time trends, and a ranked outcome-detail list.
- **Invalidations** — the active bulk-invalidation rows (an unresolvable scope — one that no
  longer names a configured route — is flagged as loudly as it deserves), and the record flow
  with **preview-first UX**: the primary button is a `dryRun` that shows coverage, overlapping
  scopes, precedence and the operation's limits; the actual write is a second, explicit click
  from inside the preview. Clearing surfaces the server's partial-undo warning.
- **URL explainer** — paste a URL and see the ingress route that matched, the query allowlist
  it selected, the canonical URL, the resulting cache key, and the live
  `Target`/`RenderSchedule`/`PrerenderedPage` rows under it (including the target's
  suppression state, which otherwise removes a URL from rotation silently). It also
  reports the key the URL would get under the global `cacheKey.queryParams`, and flags a
  difference — that divergence is the usual fingerprint of a permanent cache miss caused by a
  missing or misordered route.
- **Config** — the effective merge of defaults and host overrides, with secrets shown only as
  whether they are set, alongside the risky-config warnings that previously existed only as
  startup log lines (empty security token, staging passthrough enabled, `renderNow` without a
  token).

The explainer also offers **Render this URL now**, which makes that one URL due immediately —
every device, in one job. It writes a single `RenderSchedule` row on purpose: the collection-level
`RenderTarget.revalidate` takes a search target, and aimed at the whole registry it queues
every target at once — at a million targets that is a self-inflicted render herd.

**This is also the supported way to force one URL to the front of the queue.** A write straight to
the table through the operations socket reaches the queue too (the keeper sees every commit), but a
raw `put` replaces the record and drops `fromSitemap` and `effectiveInterval`, which the renderer and
the ranking both read. Use `POST /prerender_admin/revalidate` — or the button — which writes through
the funnel.

### Where residency comes from

Ownership is rendezvous-hashed over the cluster's node names, read from `server.nodes` on every
call. It is read per call, and never snapshotted, because `server.nodes` is not a stable list:
Harper initialises it empty and fills it asynchronously from `hdb_nodes`, replaces it while
rebuilding after a subscription restart, and briefly drops a node while applying an update to it.

**An empty peer list is treated as "not known yet", never as "this node is alone."** With no
peers, rendezvous hashing makes the local node the owner of every URL — so every schedule row
would be stored locally rather than routed, where nothing claims it correctly and nothing removes
it. The last non-empty list therefore wins over an empty one, while any non-empty list is adopted
at once so a real membership change still takes effect. A node that has never seen a peer logs a
warning and owns everything, which is correct for a single-node deployment and a misconfiguration
on a cluster.

### Schedule repair: the half-written target

A `RenderTarget` and its `RenderSchedule` row live in **separate databases**, so creating a
target is two independent commits — and the schedule half is residency-routed to whichever node
owns the URL. If that second write is lost (a crash between them, or a routed write to a node
whose replication link is unhealthy), or if cluster membership changes and moves a key's owner,
the target survives with no schedule row.

Nothing then renders that URL, and **nothing re-creates the row**:

- the bot-traffic path (`handlePageScheduling`) is gated on the target _not_ existing, so it
  skips the URL from then on;
- the sitemap refresh only visits URLs present in a sitemap, so a traffic-discovered URL — a
  site's home page being the obvious one — is never revisited;
- `processJobResult` reschedules, but only after a render, which needs a claim, which needs the
  very row that is missing.

The commonest way in is replication order. `Target` and `RenderSchedule` are separate databases,
so a newly created target can reach the node that owns its row AFTER the row does, and that node
renders a URL it has no target for. Result handling used to drop the row there, treating it like a
render-now one-off, and the target then arrived to nothing. Since v0.84.0 a row that carries a
cadence is **deferred** instead (`render.targetMissing`): re-filed `deferMs` out without storing a
page, and dropped with a warning only once its target has been missing for `graceMs`.

The state is therefore terminal _and_ silent: the cached page expires, every later bot request
falls through to the origin, and there is no error and no metric to notice it by. The only
symptom is a page whose `lastCached` keeps receding.

`render.reconcile` is the repair. Each node makes **one pass** over the target registry and, **for
the keys it owns**, checks node-locally whether the schedule row exists, collecting the gaps and
restoring them once the scan has finished.

The pass walks the registry in chunks with the unreadable-row-safe walk (`util/urlWalk.js`). It
used to stream one unconstrained search, and that was the bug: the projected iterator silently
ENDS in front of a row whose key does not decode, so on a replica holding such rows the pass
covered an arbitrary prefix of the registry and reported "no gaps" for the rest. Measured on a
four-node deployment, the first such row sat about 500k rows into a 1.68M-row registry on three
nodes, and 734 live targets past it went unscheduled for five weeks. The walk now skips and
counts unreadable rows (`unreadable` in the pass summary — a non-zero count is a database-layer
problem to escalate), and a pass it cannot prove covered the range is recorded as a FAILURE, never
as a clean one. Restoring only after the scan closes keeps the transaction rule structural: no
write is ever issued while the scan's cursor is open. Owner-scoped is a safety requirement, not an optimization: a point read of a
residency-pinned row this node does not own takes Harper's untimed replication fetch, so a
single such read could hang the sweep forever. Every node sweeping its own slice covers the
whole keyspace with no coordination and no cross-node reads.

Restores use the **jittered** initial render time rather than "now" — a sweep can repair a great
many rows at once, and queueing them all immediately would trade a silent outage for a render
herd. `maxRestores` caps writes per sweep and a truncated sweep says so in the log, so a short
count is never mistaken for "all clear".

### Cache-key orphans

The mirror-image problem, and the one **changing a `cacheKey.*` option creates**. A target's
stored `url` _is_ its schedule key and the url-half of every page key — `Target.put` writes the
schedule row under it verbatim, and a render is stored under `<url>|<device>`. Nothing
re-canonicalizes. So after a key-rule change, every target whose stored url is no longer what that
url canonicalizes to keeps its schedule row and **renders forever into keys no request can produce**.

Nothing else cleans them up. A sitemap refresh creates the target under the new key and merely
_unlinks_ the old one (`sitemapUrl → null`), which does not touch its schedule. And the canonical
verdict cannot retire them either: with the rule applied on both sides, the renderer folds the job
url and the declared canonical alike and calls it `self`. Measured after enabling
`cacheKey.plusIsSpace` on a ~38k-url catalog corpus: ~20,200 urls re-keyed (~40,400 schedule rows at
the time, when the table held one per device; one per URL since v0.66.0).

Sizing that cost needs care, because the nominal interval is **not** the rate. `nextRenderTime` is
stamped at _completion_, so a row rendered `L` behind its due time has its next render set `interval`
after that: the realized cycle is `interval + L`, and the lag is carried into every subsequent cycle
rather than caught up. With the queue ~8.2h behind and catalog on a 6h interval, those orphans run a
~14h cycle, not 6h — ~2,900 renders/hr, about **4% of the measured throughput ceiling**. But the
ceiling is the wrong denominator while the fleet is saturated: against the work it is actually
completing (every class stretched by the same `interval + L`) the orphans are ~**8%**. Deleting them
also shortens `L` for everything else, which shortens every class's realized cycle in turn.

`POST /prerender_admin/sweep-orphans` is the cleanup. The predicate is the **fixed-point test** —
`canonicalizeUrl(url, queryAllowlistFor(url)) !== url` — which is the general statement of "no
request can produce this key", so it is correct after _any_ key-rule change rather than a one-off
for one option. Two tempting alternatives are wrong: `sitemapUrl === null` also matches every
legitimately _discovered_ target and would delete live corpus, and a per-character regex encodes
one rule change and silently misses the next.

It is **manual only, and dry-run by default** — it deletes corpus, and the population it targets
is created by an operator changing a config option, so it should run when someone decides to run
it. Same structure as the repair sweep: node-scoped, cursor-free, deletes only after the scan
closes, and `maxDeletes` bounds deletion while the scan still reports the true population. It also
**defers any target with a device key currently leased**, so a delete does not land mid-render —
though correctness does not rest on that: a result whose target has gone stores no page, and its
row is deferred and then dropped once the target has been missing for `render.targetMissing.graceMs`.

The Overview panel shows the last sweep's result on that node and can start one on demand.

### Page orphans

A cached page is only ever removed by `Target.delete`'s cascade, so any target that disappears
without it strands its pages: nothing re-renders them, nothing reclaims them (`PrerenderedPage` has
no expiration), and — since `page_cache` is not residency-pinned — every one, blob included, sits
on every node. Every other sweep walks the Target table, so none of them can see these. Measured on
a four-node deployment: **394,783 of 2.73M pages (14.4%, ~19 GB per node) owned no target on any
node**, all cached 4+ weeks earlier — 98% left by a key-rule sweep that deleted targets through the
raw table before v0.54.0, the rest by render results that landed after their target was retired.
They cost more than disk: every `page_cache` full copy walks them, and a stale orphan row turns a
crawler's request into a `stale` serve instead of a `miss`, which keeps the raw-document cache
from ever answering it.

`POST /prerender_admin/sweep-orphan-pages` is the cleanup (`render.pageOrphanSweep`). A page is
deleted only when this node owns its URL, it was cached at least `minAge` ago (21 days by default —
far past any render cadence), it is **no longer servable** (past `expiresAt + page.swrTtl`), no
Target owns its URL, and no render of it is in flight. So a deletion can change nothing a crawler
is served beyond `stale → miss`. Each batch is **one transaction** that re-checks every key
immediately before deleting it — Harper queues a deleted record's blob for unlinking when the
delete is staged, so deleting a key something is concurrently writing could strand a live
record's blob — and, with `confirmReplication`, is held until every peer confirms it, which is
the backpressure: a peer that cannot keep up stalls the sweep rather than letting it run ahead of
replication.

There is no node-local shortcut: an eviction leaves no tombstone, so the next full copy from any
peer that still holds the row would restore it. A replicated delete ships a few hundred bytes per
key per peer and no blob, so what binds is the number of commits on `page_cache` — hence batching.
Like the other destructive sweeps it is **manual only, dry-run by default, and node-scoped**: run it
on every node; `GET /prerender_admin/sweep-orphan-pages` reports the live pass, and
`{ action: "stop" }` ends it at the next row.

Two leaks that fed this population are closed in the same release: `Target.delete` now removes
pages for every **supported** device (a one-off rendered for a non-default device used to outlive
its target), and a render result whose URL has no target no longer stores its page.

### Residency: why the schedule row is fetched from another node

`RenderSchedule` is residency-pinned (`setResidencyById`), so each row lives on the node that
owns its URL. **A point `get` for a row owned by another node takes Harper's cross-node
`sourceLoad` path, which awaits a replication `getRecord` with no timeout — an unanswered peer
hangs the request indefinitely.** Every schedule read in this plugin therefore passes
`{ replicateFrom: false }` and stays node-local (`claim`, `refreshQueueStatus`, and the admin
overview scan always did; the explainer's point read was fixed in v0.8.3).

Node-local reads alone would make the explainer useless for most URLs, though: rendezvous
hashing spreads ownership evenly, so on an N-node cluster **(N−1)/N of URLs are owned
elsewhere** — about 75% on a 4-node cluster. So when this node isn't the owner and has no local
row, the explainer asks the owner over HTTPS via `POST /prerender_admin/schedule` — a bounded
request, in place of an unbounded one.

- The destination is always a hostname from the cluster's own node list, never a value derived
  from the request.
- Only the caller's `authorization` / `cookie` headers are forwarded, and the peer re-runs its
  own `super_user` check — the proxy grants no authority the caller didn't have. (Both work
  cluster-wide: Harper users are replicated, and the session cookie is issued for the shared
  parent domain per `authentication.cookie.domains`.)
- Bounded by `management.peerTimeoutMs`; a slow peer costs that one field, not the page.
- `/prerender_admin/schedule` is a leaf — it never proxies onward, so no residency
  disagreement between nodes can cause a request loop.

The response reports `residency.scheduleOwnedBy`, `scheduleSource`, and
`scheduleAuthoritative`. Only when `scheduleAuthoritative` is false does an absent row mean
"not scheduled **on this node**" rather than "not scheduled" — and the UI says so, including
why the owner couldn't be reached. Set `proxyToOwner: false` to keep all reads strictly
node-local and accept the inconclusive answer.

### Counting is capped — and never happens on page load

Table totals come from Harper's `getRecordCount()`, which is time-bounded and switches to
sampling on a large table — it is reported with its `estimatedRange` rather than as an exact
figure. The backlog counts and histogram come from the queue keeper and are exact (`truncated`
only when the keeper's load skipped unreadable rows or its last verification had to repair any).
At 1M+ targets an exact table count is not a page-load query, so the UI labels an estimate as an
estimate instead of presenting a short count as the total.

Both live in the background snapshot: a dashboard load is two walks of node-sized tables plus
one node-local point read, regardless of deployment size. The console never polls — data
refreshes on explicit clicks only — and the three routes that do bounded real work per click
(sitemap detail, page-cache browse, page-content) yield to the event loop between batches,
hold no read snapshot open (`snapshot: false`), and are capped at 2 concurrent per worker
(further requests get `429`): this UI shares its workers with bot traffic, and refusing an
operator beats delaying a crawler.

### Queue control: intent vs. observed

`claim` reads a **node-local**, non-replicated flag (a `SharedBuffer` SAB), which is why
pausing used to mean calling `POST /render_queue/pause` on every node in turn. The
`QueueControl` table now holds the _desired_ state and **is** replicated:

| Scope        | Meaning                                                 |
| ------------ | ------------------------------------------------------- |
| `all`        | cluster-wide default                                    |
| `<hostname>` | per-node override — wins over `all`, in both directions |

`paused: true` pauses, `paused: false` explicitly keeps a node running _through_ a
cluster-wide pause, and deleting a node's row (`paused: null`) returns it to inheriting `all`.
Each node resolves the intent on its own `queue.statusSyncInterval` tick, so **a change
reaches a remote node within one interval (default 1m), not instantly** — the UI states this.
`QueueStatus` remains what each node last _observed_; the UI shows both, and marks a node
stale when it stops reporting.

The rest of that observed status is **derived, not scanned**, from the queue keeper at zero database
cost: `queued` when it holds due rows, `empty` when it holds none, `unready` while it is not serving
claims. Due rows that are all in flight still report `queued`, never `empty` — reporting `empty` there
would tell the whole fleet to go idle while a large backlog is being rendered.

`POST /render_queue/pause` stays deliberately node-scoped: that endpoint sets
`loadAsInstance = false` and therefore enforces no authentication of its own, so it must not
be able to stop the whole fleet. Cluster-scoped control is only reachable through the
super-user-gated admin route.

### Editable configuration: the override layer

Configuration resolves in three layers, lowest precedence first:

```
schema defaults  <  config.yaml (deployed from git)  <  ConfigOverride rows (set from the console)
```

The console writes the third layer. Each row is **one option path holding one value** — a delta,
never a snapshot of the whole config. That distinction is the entire design:

- A `config.yaml` change still takes effect for **every option nobody has overridden**. Ship a
  corrected default or a fixed route and it lands. A stored snapshot would shadow it silently, and
  the deploy would appear to do nothing with nothing to say why.
- Clearing one row reverts **one option** to the deployed value. Clearing every row returns the
  cluster to exactly its deployed state — which is the rollback story, and it is one delete.

**But a list is one option.** An edit to one route stores a copy of the whole `ingress.routes` list
(and one probe rule, all of `changeProbe.rules`). From then on, a `config.yaml` edit to _any_ route
deploys and is merged away by that copy. So since v0.97.0 each row records a hash of the file's value
at its path when it is written (`fileHash`), and `GET /prerender_admin/config` reports on each
overridden option in `layers`:

- `masking: true` means the override is in effect and the file's value has changed since the row
  was written. A deploy is being overridden. This is also a `warn` finding in `warnings`, and is
  logged on every apply.
- `redundant: true` means the override now equals the file's value, so clearing it is a no-op that
  un-pins the option. This is also an `info` finding.
- `masking: null` means the row was written before v0.97.0 and recorded no hash, so it is unknown
  whether the file moved. Saving the row again records one.

The rows live in `config.ConfigOverride` — alone in that database, because a subscription is a
per-database cost — and **replicate**, so the console writes once, on
whichever node it reached, and every node converges — including a node that was down when the write
happened and a node added to the cluster next month. The alternative, a console fanning a write out
to N nodes, has no convergence at all: a node mid-restart for one write diverges permanently, and
config divergence between nodes is precisely what this system treats as a failed deploy rather than
a preference.

**A change propagates in about a second.** Each worker subscribes to the table and treats an event
as a _doorbell_: any event triggers a re-read of the whole (tiny) table, which is then re-merged.
The event's own payload is deliberately ignored — Harper subscriptions do not dedupe and may deliver
out of order, whereas a full re-read is idempotent. A backstop poll
(`management.overrides.syncInterval`, default 30s) covers a subscription that was never established
or a worker whose boot read failed, so staleness has a bound that does not depend on a callback
firing. A re-read that finds nothing changed does **not** re-apply, so it never re-arms the
schedulers.

Every worker subscribes and polls, unlike the schedulers in this plugin which pin to one node and
worker. Each worker holds its own `config`, so each has to learn about a change itself.

**Boot ordering is guaranteed, not hoped for.** `handleApplication` awaits the override read before
the first `applyOptions` and before any scheduler starts, and a worker does not receive requests
until component load resolves — so no request and no timer ever observes a pre-override config. The
read is bounded (5s deadline, 500-row cap) and **fails open**: component load is raced against a
hard timeout, and overrunning it fails the component rather than delaying it, so a read that cannot
complete leaves the cluster running its deployed `config.yaml` and reports the degradation.

#### What cannot be edited from the console

| Refused                    | Why                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------- |
| the three `secret` options | they come from environment variables; the API only ever reports whether one is set  |
| `management.enabled`       | one click would take the console away, and getting it back needs a config-file edit |
| `management.overrides.*`   | it is the machinery the console writes _through_ — including its own kill switch    |

`management.overrides.enabled: false` in `config.yaml` is the **kill switch**: rows are left in
place but ignored, and the cluster runs exactly its deployed configuration again. It lives in the
file because an override you need to undo is a poor thing to undo through the override layer.

Restart-scoped options (`scope: 'restart'` in the schema) can be overridden, but the write **stages**
rather than applies — the new value is in `config` while the running behavior stays at boot. Those
are reported through `pendingRestartChanges()` and the console shows them as pending rather than
letting the write look like it took effect.

#### Previewing a change

`dryRun` returns exactly the body the real call would, minus the write — the same contract as
invalidation:

```sh
POST /prerender_admin/config-override
{"set":[{"path":"page.swrTtl","value":21600000}],"dryRun":true}
```

The preview is computed by resolving a **prospective** config through the same merge and the same
schema constraints the real apply uses, so it reports three things an echo of the submitted value
could not:

- **`rejected`** — a value that would not survive validation. Without this the row lands, the console
  lists it, and the cluster does not honour it; `describeConfigLayers()` calls that state
  `override-rejected`, and it is far better prevented than diagnosed. A rejected override falls back
  to **the layer below it**, not to the schema default: a value `config.yaml` sets deliberately
  survives a typo'd override of the same option, which is what stops one bad edit from taking a
  deployed setting down with it.
- **`noop`** — a change whose prospective effective value equals the current one, e.g. an override
  that merely restates what the file already says.
- **dropped entries** — an `ingress.routes` or `changeProbe.rules` value is compiled during the
  preview (`inspectRoutes()` / `inspectProbeRules()`). The compiler _drops_ an invalid entry rather
  than rejecting it, so from the outside the entry is indistinguishable from one nobody wrote: the
  config lists it, the plugin starts, and the paths it covered quietly stop being prerendered (or
  probed). Since v0.97.0 such a value is listed in `rejected` with its `dropped` count and the
  compiler's reasons, and the apply refuses it (409) like any other value that would not be honoured.

### Bulk cache invalidation

"Everything of this kind is wrong as of now; stop serving it." One row records a **scope** and an
**instant**; from then on any cached page in that scope rendered before that instant stops being
served, and bots get the origin until the page re-renders on its normal cadence.

```sh
# preview — writes nothing, returns exactly the body the real call would
POST /prerender_admin/invalidate  {"scope":"all","reason":"price flip","dryRun":true}
POST /prerender_admin/invalidate  {"scope":"route:prefix:/catalog/","reason":"price flip"}
GET  /prerender_admin/invalidations
POST /prerender_admin/invalidate  {"scope":"all","mode":null}      # clear
```

**Nothing is rewritten.** That is the whole design, and it is a measured choice, not an aesthetic
one. Rewriting the corpus — which `Target.revalidate`'s collection form does — costs **15.7 s and
61.8 MB of audit per node per invalidation** at 400k rows, and pacing does not reduce it (same
162 B/write, 8.9× longer, claim's max latency _worse_). (While claims walked the `nextRenderTime`
index, collapsing due times to "now" also slowed the claim scan 32×.) Recording an epoch costs **0.18 ms and 102 bytes** — ~606,000× less audit — and it is what makes undo instant.

There is deliberately **no corpus sweep, and never will be**: 1.53M PDP keys against a measured
fleet ceiling of 71,289 renders/hr is a **21.5 h floor at 100% utilisation**, against the 48 h such a
page waits anyway, while utilisation is already 98%. Healing is by normal cadence. Set
`invalidation.reenqueue.enabled: true` to additionally pull forward the pages bots actually crawl
(off by default — enable it after one rehearsal, not on the deploy that introduces it).

**Scopes are a closed set:** `all`, or one prerender route written `route:<match>:<path>` exactly as
`ingress.routes` declares it. `GET /prerender_admin/invalidations` lists the valid literals, and an
unknown scope is a 400. There are no free-text prefix scopes on purpose — a prefix cannot be checked
against anything, so a typo would record a row that reports as applied and matches nothing, which is
the worst failure available because the operator's mitigation _appears_ to have worked. For a
narrower blast radius, declare a narrower route.

Precedence between overlapping scopes is **the latest `invalidatedAt` wins** — not most-specific —
so a leftover rehearsal row cannot hide a fresh `all`. The write response names every other
applicable scope so this is visible rather than inferred.

**What it cannot do**, both worth knowing before relying on it:

- **The CDN edge is not invalidated** and keeps its own TTL, and neither is a copy a crawler already
  holds. A conditional request cannot defeat it, though: on an invalidated verdict the validators are
  stripped from the origin fetch and the local 304 path is skipped, because otherwise the origin
  answers `304` to validators this plugin handed out off the pre-invalidation snapshot and the
  crawler keeps the old bytes while every signal reports success.
- **Origin markup is thinner than a render.** It carries correct price, availability, canonical,
  title and meta description — but not reviews or most images.

**Undo is asymmetric, by construction.** Clearing the row restores service on the next request for
every page still inside its own expiry/SWR window. A page whose window elapsed _while_ the
invalidation was active cannot come back — its lifetime ended on its own terms and nothing here
rewrote `lastCached`. So a long-running invalidation cannot be fully undone; the clear response says
so with the numbers attached.

`invalidation.enabled: false` is a kill switch, and while any row exists it is reported as a log line
on boot and on every config apply, plus a flag on `GET /invalidations` — silently serving content
somebody deliberately invalidated is the one outcome this feature must never produce.

### Change-driven re-rendering: the change probe

A render interval bounds staleness blind: it pays a full render per page per interval whether or
not anything changed, and it still misses every change that lands mid-interval. For the fields that
actually invalidate a snapshot — price and availability on a commerce page are the canonical case —
the origin can answer "did it change?" thousands of times cheaper than a render can. `changeProbe`
(default **off**, and **dry-run** even when on) asks exactly that and re-renders only on change.

A **rule** (`changeProbe.rules`) says what to watch for the URLs its `pathPattern` matches:

- `source: document` (the generic mode) fetches the page itself and extracts its schema.org
  **JSON-LD `Product` offers** — price, currency, availability — with nothing site-specific to
  configure.
- `source: request` probes an endpoint the page's own client-side code consults (`urlTemplate`,
  with `$1`..`$9` from the pattern's capture groups), extracting configured value paths from the
  JSON response. Typically a few KB against a render's seconds of CPU — but such endpoints are
  usually uncached and undocumented, so **agree the probe rate with whoever runs the origin**
  (`ratePerSecond` is the knob) and expect the endpoint to change shape someday. The origin
  security token (and the staging-IP pin) ride along **only when the endpoint shares the probed
  page's origin** — a rule naming a third-party host gets a plain fetch, never the bypass secret.
  Redirects are not followed; a redirecting endpoint counts as a failed probe.

The extracted values are reduced to a **signature** stored in the node-local `ProbeState` table
(`replicate: false` — the sweep is owner-scoped, so a URL's baseline is only ever read and written
by its owner node, and replicating it would ship every baseline to nodes that never consult it; a
lost baseline just re-seeds). A probe that observes a different signature **acts on it when it finds
it** (since v0.94.0): the URL's cached pages are hard-expired and its render is filed at the current
minute, marked on the schedule row (`changedAt`, with the page's demand estimate as `demandPeriod`) so
the render queue ranks it `queue.ready.changedHeadStart` cadences ahead of routine rotation, and among
changed pages by how often bots ask for them (a page known wrong is being served from the origin until
it re-renders). Nothing detected is deferred and there is no per-pass budget —
the render queue orders the work. Actions run beside the walk, at most `trigger.concurrency` at once
(the pass waits for a free slot rather than dropping a change), and the new baseline is written only
after its action succeeds, so a failure or a restart leaves the change detectable; an action that
throws is retried once when the walk ends. A restart that cuts an anchored pass short resumes it on boot
from the walk cursor its heartbeat published (held back to any action still in flight), with the
interrupted pass's own dry-run and reseed settings; a restart that spanned the anchor runs that
anchor's pass at boot instead (v0.97.0), and an anchor that fires while another sweep holds the node
stands a dry run, a reseed or a pass for an older anchor down, or waits for any other pass and runs
after it — each outcome is a `probe_anchor` emit, never a silent skip; an anchored pass that throws is
resumed from its cursor. A pass skips only URLs it (or the pass it resumes) has already probed, and a
storage fault on one row skips that row, not the pass. With `renderCheck` (default on) each render of a
claim-pair `pageCheck` URL is compared with the probe's last observation of the origin as it lands; one
that disagrees gets ONE confirming probe, and is expired and re-filed only if the origin still
disagrees with it — claimed before a probe found a change, or rendered from a stale CDN copy — while an
origin that moved and a render that shows it just update the baseline (`probe_render_mismatch`). While
an invalidation is active, no pass acts on a page it already refuses, or on one re-rendered after the
trip that agrees with the origin. Two cadences cover the two ways content actually changes:

- The **sweep** walks each node's owned slice of the registry, paced (`ratePerSecond`,
  `concurrency`), catching continuous per-URL drift — availability sell-through, item-level price
  moves. It runs in one of two modes (`mode`):
  - **`interval`** (default) fires a discrete pass every `sweepInterval`. This asks you to solve
    `sliceSize / effectiveRate <= sweepInterval` by hand and re-solve it whenever the corpus grows
    or the origin has a bad week — and when the answer stops holding, the overrunning pass is
    skipped and the cadence silently doubles. It also idles: a slice taking 9h of a 12h interval
    leaves 3h probing nothing, so detection latency is bimodal.
  - **`continuous`** never stops walking and never re-solves anything. It derives its rate every
    batch from remaining rows over remaining budget (`cycleTarget`, the worst-case detection
    latency you are asking for), so corpus growth and time lost to backoff are absorbed as they
    happen. `ratePerSecond` stays a hard ceiling — a target that cannot be met at it is reported as
    `probe_cycle_behind` rather than silently missed. The first cycle after a restart runs at the
    ceiling because pacing needs a slice size and only a completed cycle knows it.

  Both modes back off when the **origin** pushes back (`backoffMax`, `Retry-After`,
  `abortAfterDistress`). `load.*` adds a second, independent governor for when the **node itself**
  is struggling — event-loop delay past `load.lagThreshold` widens the same pacing window. It is
  off by default and belongs with `continuous`: in interval mode a governor that slows the pass can
  push it past `sweepInterval`, where it is silently skipped, so a safety feature would degrade the
  cadence invisibly. Continuous mode has no window to overrun.

- The **canary** (`canary.*`) probes a small fixed cohort every few minutes, because commerce price
  does not drift — it **steps at promotional events**, most of a catalog at once, which a sample of
  hundreds sees within minutes. On a trip, the rule's `invalidateScope` records a **bulk
  invalidation** (above): pre-change snapshots stop serving immediately — bots get origin content,
  which is correct by definition — while re-renders refill on their own machinery. Detection and
  response are different mechanisms on purpose: re-rendering a large corpus takes a render fleet
  hours; invalidating it takes one row. The trip's **reseed** re-probes the whole slice and acts on
  every change the invalidation does not already cover (a page re-rendered after the trip), leaving
  pages that predate it to the invalidation so that clearing a false trip still restores them.
  `canary.schedule` (optional) replaces the all-day `canary.interval` with time-of-day windows in
  `anchorTimezone`, dense where a scheduled change is expected and sparse elsewhere.

**A probe failure changes nothing** — no signature write, no trigger. The probe is an accelerator
on top of the baseline cadence, never a gate on it: an endpoint that breaks (or replatforms) shows
up as a `probe_failed` share and a loud log line, not as schedule churn. An extraction where every
path yields null is a failure too, so a shape change cannot flip every signature at once and
mass-trigger. Suppressed targets are skipped — suppression owns its own recheck cadence.

**Scope** (`scope`, default `all`). `listed` probes only targets a sitemap lists now, plus those a walk
unlinked within `unlistedGrace` (48h by default, measured from `Target.unlistedAt`), and skips targets
discovered from traffic and products long gone from the sitemap — counted per pass as `outOfScope`, the
origin requests saved. It is only safe where the sitemap **is** the availability feed and the
sitemap-departure check is armed (`ingress.routes[].departureAction: render`,
`sitemap.departure.dryRun: false`), which already re-renders a product's page the day it leaves the
sitemap; a config warning says so otherwise. Its pair is `arrivalAction: render` on the same route
(`sitemap.arrival`, dry-run by default), which re-renders a product the day it **rejoins** its
sitemap instead of leaving its out-of-stock snapshot serving until the next cadence render.

Once a probe rule covers a route's volatile fields, that route's `renderInterval` can usually be
raised substantially — the interval then only bounds what the probe cannot see (client-side
content: reviews, image sets), and the render budget freed is what pays for the burst of
re-renders a mass change triggers. Status and manual runs: `GET`/`POST /prerender_admin/change-probe`.

### Demand: the tracker, and what reads it

`demand.*` (v0.95.0; default **off**) records which URLs the crawlers you name (`demand.bots`) actually
ask for: a ring of Bloom slices (`slices` × `sliceMs`, 4 days of 6 h at the defaults), one merged row per
node per slice, replicated so any node can answer. It measures and never acts. A URL's **demand** is
how many slices saw a visit, 0 to 16, and its estimated visit period is the window over that count
(`util/demand.js`).

Consumers decide what demand is worth, each with its own settings:

- the **cadence ladder** (`render.demand`) moves a target between render intervals. It predates the
  tracker and its decisions did not change when the tracker was split out of it; it needs
  `demand.enabled` too, and a config finding says so if it is on without it;
- **changed-page order** (`queue.ready.changedDemand`, above) ranks the pages the change probe found
  changed by the origin visits their wait costs.

What it cannot see: presence is per slice, so a page asked for every minute and one asked for once in
six hours read the same. False positives only ever ADD demand, and they rise off a cliff with fill
(`fill^k`): a ring sized for 100k URLs per slice that is asked to hold 350k answers "visited" about half
the time. `demand_false_positive` (the worst full slice's `fill^k`) is the number to watch; past
`demand.maxFalsePositive` the tracker reports demand as **unknown** and the changed-page order falls back
to cadence. The ladder does not consult it. Size `demand.bitsPerSlice` from the measured peak distinct
URLs per slice (`n ≈ −(m/k) ln(1 − fill)`), with room: bits `≈ k·n / −ln(1 − f)` for a fill f, and
f = 0.652 holds the 5% limit at k = 7.

What a larger ring costs, since v0.95.1 once per node rather than once per worker:

| Cost              | Scales with                                                                                                                   | Notes                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Replicated writes | one row (`bitsPerSlice / 8`) per node per `flushInterval`                                                                     | Only the current slice changes; the lever is `flushInterval`.                                  |
| Memory            | `slices` rows per node (the union), plus about two live slices                                                                | Shared by every worker on the node.                                                            |
| Reads             | one version scan of the ring, and the rows that changed, per `mergeInterval`; one local read of this node's own row per store | One worker refreshes; in steady traffic the changed rows are the current slice from each node. |

Every worker sets its bits in the node's shared slice, and whichever worker holds the interval's turn
stores it, so no visit waits on a particular worker. Changing `bitsPerSlice`, `hashes` or `sliceMs`
reshapes the ring, and the ladder then rests targets at base for one slowest rung while new history
accumulates.

**Moved in v0.95.0, without an alias:** `render.demand.{bots, sliceMs, slices, bitsPerSlice, hashes,
flushInterval, mergeInterval}` are `demand.*`. From v0.95.0 an unknown key is reported at any depth
(it used to be reported only at the top level), so an old path left in `config.yaml` or a stored
override logs "Unknown configuration key" and is not applied.

### Why a request missed: `bot_miss`

Every request `bot_serve` counts as `origin|miss` also gets one **cause** (`bot_miss`, by route and bot):
`not-found` / `not-modified` / `redirect` / `client-error` / `origin-error` (the origin status decided it; `not-modified` is a crawler's conditional GET the origin answered 304), `passthrough`,
`uncacheable`, `gated-route` / `gated-bot` / `gated-entity` / `device` (a rule or setting you chose —
`device` is a device outside `deviceTypes.default`, which the rotation never renders), `new` /
`unrendered` / `render-timeout` (a page the rotation owns and has not rendered yet, or an on-demand
render that did not land in time — the only group render capacity or order can move), `suppressed`, `error`. Each missed URL also goes into a per-cause distinct-URL sketch, so
`GET /prerender_admin/crawl-breadth` can say how many distinct URLs each cause is made of (`misses` per
day, `missUnion` across the range). Requests per distinct URL is how many times a missed URL is asked
for, which is what a render of it would serve; the days' distinct counts against the range's union say
whether the same URLs come back tomorrow. A class of misses made of one-off URLs is not worth covering
at any capacity.

## Metrics & observability

**[METRICS.md](METRICS.md) is the one place to start when building a dashboard or an alert.** It
covers every metric this plugin emits (names, dimension slots, units, and what each number is
actually for), the Harper built-ins worth charting beside them, the management-API and log-only
signals that carry numbers no metric has, and the known gaps.

The machine-readable version of that catalog is [`src/metrics.js`](src/metrics.js), served live by
`GET /prerender_admin/metrics` — so a dashboard (or an agent writing one) can read the contract off
the running version instead of guessing which release a doc describes. Every emission goes through
the emitters in that module, and a test fails if any other module calls `server.recordAnalytics`
directly.

## How it fits together

```
bot ──GET /p/<url>──▶ plugin ──cache hit?──▶ serve PrerenderedPage
                          │ miss
                          └─▶ fetch origin, serve, and (if indexable) schedule a RenderTarget

render client ──claim──▶ render_queue ──jobs──▶ [headless render] ──job_result──▶ PrerenderedPage
```

The render service is a separate process; see [`@harperfast/prerender-browser`](../browser). Its
`RENDERER_BYPASS_*` settings must match this plugin's `origin.securityToken`.

**A job is one URL** (v0.66.0). `RenderSchedule` holds one row per URL, a claim hands the renderer one
job naming every device in `deviceTypes.default`, and the renderer (browser >= 1.23.0) renders them in
turn and posts one result — `{ id, url, deviceTypes, variants: [...] }` with the variants' bodies
concatenated behind the JSON. Pages are still stored per device (`PrerenderedPage` stays keyed by
`<url>|<device>`); the schedule is written once, which is what keeps a URL's devices aligned instead
of drifting apart through every per-device path (the retry lanes, render-now, reconcile). One result
also means one `strikes` increment per failed cycle, and one page claim for the change probe. The
precedence across a result's variants — a redirect on any device decides the URL, a genuine
non-indexable verdict on any device suppresses it, rendered pages are stored and a failed device puts
the URL in the retry lanes — is spelled out on `processDecodedJobResult` in
[`src/resources/RenderQueue.js`](src/resources/RenderQueue.js).

**Upgrading from a per-device schedule.** Rows written before v0.66.0 are keyed `<url>|<device>` and
are **not migrated by a sweep**: each converts the first time it renders — its job renders exactly the
device its key names, its result writes the URL row and deletes the device row — so two siblings fold
into one URL row within a render cycle at no extra renders, and the table holds both shapes meanwhile
(every reader tolerates both). The one carve-out: a writer that files the URL row **before** a URL's
device rows have converted — a registry-wide `revalidate`, a sitemap ingest with `revalidate: true`,
`POST /prerender_admin/revalidate`, or a render-now — renders that URL once more per leftover device
row (each row still renders its device and rewrites the URL row), so a bulk revalidate in the first
cycle after the upgrade costs up to one extra render per URL. Wait a cycle, or accept it. The `cacheKey` column name stays: Harper refuses to rename the primary
key of a populated table, so read it as "the schedule key". **Deploy the render fleet (browser >=
1.23.0) before this plugin version**: an older renderer handed a URL job renders only its first device.
`renderNow` for a device outside `deviceTypes.default` still writes a per-device row — a one-off
render of that device beside the rotation, stored and retired without touching the URL row. For a
default device it pulls the URL row forward, so the render it waits on renders **every** default
device before the result posts: size `renderNow.timeoutMs` for that, not for one render.

## Development

```sh
npm test          # unit tests (node --test)
npm run lint      # from the repo root
```
