# `@harperfast/prerender`

A configurable [Harper](https://www.harpersystems.dev/) plugin that prerenders pages for bots and
crawlers. It provides:

- A bot HTTP entry point (`/p/<absolute-url>` by default) that serves cached prerendered HTML or
  fetches from the origin, with content-encoding negotiation and conditional-request (304) handling.
- A render queue + scheduler (`render_queue`, `RenderTarget`, `RenderSchedule`) that an external
  render service (see [`@harperfast/prerender-browser`](../browser)) claims jobs from and posts results
  back to.
- Sitemap ingestion (`Sitemap`) that discovers URLs and schedules them for rendering.
- A prerendered-page cache (`PrerenderedPage`) and indexability signals (`NonIndexable`).
- A management API + UI at `/prerender_admin` (see [Management UI](#management-ui-prerender_admin)),
  authenticated with Harper users and restricted to `super_user`.

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
    refreshTime: '12:00' # local time-of-day for the daily sitemap refresh
    timezone: America/New_York
    filteredWarnPercent: 50 # filtered share of one sitemap that is reported as an ERROR
    node: '' # pin the scheduled refresh to this node ('' disables it)
    workerIndex: 0 # ...and this worker
    background: true # POST returns a handle immediately; the walk runs in the background
    staleRunMs: 600000 # 10m — un-updated progress after which a run is treated as dead
    removedSampleCap: 20 # sample size of unlinked keys in the result (the COUNT is exact)
    failedCap: 100 # per-child failures retained in the result (the overflow is counted)
    userAgent: HarperSitemapCrawler/1.0 # self-identifying UA for the sitemap crawler fetch

  queue:
    jobLeaseTime: 600000 # 10m — how long a claimed job is leased (also a LATENCY knob, see below)
    statusSyncInterval: 60000 # 1m  — pause convergence, status broadcast, claim-floor reset
    maxLeases: 4096 # lease slots in the node-local shared buffer (restart-scoped)
    claimScanCap: 1000 # ceiling on schedule rows read per claim pass
    claimFloor: # the lower bound the claim scan seeks from (see "The claim floor")
      enabled: true # false = seek the absolute index minimum, as before v0.34.0
      guard: 300000 # 5m — the floor is always held at least this far behind now
      resetInterval: 300000 # 5m — how often the floor is reset and re-derived from the index
      unpinAfter: 3600000 # 1h — a row holding the floor this long is written forward (0 = never)

  management: # the admin API + UI at /prerender_admin
    enabled: true # false makes every management route 404
    scanCap: 20000 # ceiling on rows an overview scan walks (see "Management UI")
    proxyToOwner: true # ask the owning node for a residency-pinned schedule row (see below)
    peerTimeoutMs: 2500 # deadline on that peer call
    backlogSnapshotInterval: 900000 # 15m — backlog/histogram recompute cadence; 0 = manual only
    pageSize: 50 # rows per page in the console's sitemap-entry and page-cache tables

  analytics:
    enabled: true # record bot analytics at all: bot_request (ingress volume by host/bot/device),
    # bot_serve (outcome by source/cache-status/bot — origin offload + cache hit rate),
    # page_age (ms since the served page rendered — freshness at serve, cache-served only),
    # route_serve (outcome by route/cache-status/device — per-route delivery, for tuning each
    # route's renderInterval), and route_page_age (served age by route/cache-status/device).
    # cache-status distinguishes 'hit' (within the page's renderInterval) from 'swr' (served
    # from the stale-while-revalidate window because the re-render is late/in flight) — both
    # are cache serves; 'hit' alone is the "is the TTL being met" signal.

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
  the first time — omit it and let the jitter place the URLs. It is safe with respect to the claim
  floor because it writes through the schedule funnel (which lowers the floor with the rows) and
  because the guard band keeps the current minute above every node's floor — see "The claim floor".

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

| Database          | Tables                                        | Notes                                            |
| ----------------- | --------------------------------------------- | ------------------------------------------------ |
| `render_schedule` | `RenderSchedule`                              | the hot render queue — isolated                  |
| `render_service`  | `RenderTarget`, `QueueStatus`, `QueueControl` | target registry, observed status, desired status |
| `page_cache`      | `PrerenderedPage`                             | rendered-HTML cache (heavy blob writes)          |
| `sitemaps`        | `Sitemap`, `SitemapRefresh`                   | sitemap data + per-root refresh progress         |
| `signals`         | `NonIndexable`                                | indexability signals                             |
| `coordination`    | `SharedBuffer`                                | node-local cross-worker SAB (never replicated)   |

Because `RenderTarget` and `RenderSchedule` now live in separate databases, a target and its schedule
are written as two independent commits (target first). The brief window where a target exists without a
schedule is benign and self-heals on the next sitemap refresh / `revalidate`.

See [`src/schemas/schema.graphql`](src/schemas/schema.graphql).

#### Where the claim floor and the job leases live

Neither is a table. Both are **node-local shared-buffer state**, in one named cross-worker buffer
(`coordination.SharedBuffer`, never replicated): a fixed array of lease slots keyed by a 64-bit hash
of the cache key, plus the claim floor as a single integer. A lease costs zero database operations.

**Losing them on a restart is correct, not a fault.** A lease is not a record of work — the schedule
row is, and it was never moved — so a job whose lease vanished is simply granted again. The visible
cost is a duplicate-render burst for whatever was in flight (~500 per node at 12k renders/hour), and
both results are accepted, with the later `PrerenderedPage.put` winning. The floor zeroing on restart
is a _feature_: `0` means "seek the absolute index minimum", i.e. exactly the pre-v0.34.0 behaviour,
so a restart cannot help but re-derive the truth from the index. Persisting the floor would make a
bad value durable, which is why it is deliberately not persisted.

Consequences worth knowing before you read a dashboard: lease state is **per node**, so only the node
that owns a URL (residency) can answer "is this key being rendered right now" or "is this row below
the floor" — the URL explainer asks that node and shows its answer, and never compares a row against
the querying node's floor. And every one of these numbers is gone after a deploy.

#### The claim floor

`claim` reads `nextRenderTime >= floor` (one condition, sorted, limited) instead of scanning from the
absolute minimum of that index. It has to: every completed render moves a key off the head of the
index and leaves a dead entry **at the seek point**, and the scan measurably degraded 0.36 ms →
6.25 ms over 40,000 reschedules — linearly, and permanently (it did not recover when the churn
stopped). With the floor the same 20 keys come back in 0.43 ms.

The floor advances to **the first due row a pass observed**, which is the same thing as
`min(last granted, oldest in-flight lease)`. So:

- **`queue.jobLeaseTime` is now a latency knob.** The floor cannot advance past the oldest _due row_,
  so everything behind that row waits for it. The fast-retry lane
  (`render.failureRetry.fastRetries`) deliberately holds its lease, which multiplies that — and
  during a broad origin 5xx event _every_ job takes that lane, so no lease is released at all for the
  duration and the claim scan degrades back toward its old cost. Watch **Claim floor lag** on the
  overview; it names the row holding the floor.
- **A lease expiring does _not_ lift the pin.** Claiming writes nothing to the schedule row, so a
  render that never posts a result leaves the row due at the same minute, and every later pass
  derives the same floor from it — until something writes that row forward or deletes it. The
  periodic floor reset cannot recover it either: that row _is_ the oldest due row the reset would
  re-derive from. The generic-failure path (renderer crash, navigation timeout, settle failure on a
  URL that still has a target) has exactly this shape — it holds the lease and writes no row — so one
  permanently failing URL would pin the floor indefinitely while dead index entries accumulate above
  it at the full render rate (~43 ms/pass after a day, i.e. worse than the unfloored scan the floor
  replaces).

  So `queue.claimFloor.unpinAfter` bounds it: a row that has held the floor for longer than that is
  written forward one `render.defaultInterval` by the claim path itself, and named in a warning. A
  warning also fires earlier, as soon as the pin outlives what `render.failureRetry` can account for
  (`fastRetries × jobLeaseTime`) — that one is the signal to act on, because the automatic push
  unblocks the _queue_ without fixing the _URL_. Repair or delete it (deleting is safe — bots proxy
  to the origin and discovery re-creates whatever it serves), and watch **Claim floor lag** on the
  overview, which names the row and shows how long it has held on.

  The push is self-limiting at one write per interval per node, because unpinning one row promotes
  the next, which must then hold for a full interval of its own. It counts **no strike** and changes
  no retry semantics, deliberately: `strikes` is the target's one shared counter that suppression and
  redirect verdicts _delete_ targets on, so routing the highest-volume failure path through it would
  walk the corpus toward deletion during a broad origin outage. Set `unpinAfter: 0` to restore the
  unbounded pin.

- **A due time written below the floor is never claimed again.** Every schedule write inside the
  plugin goes through one funnel ([`src/util/renderSchedule.js`](src/util/renderSchedule.js)) that
  lowers the floor with the write, and the floor is held `queue.claimFloor.guard` behind the current
  minute so a "due now" write from _any_ node lands above it without coordination. What is _not_
  covered is a write with no plugin code in its path — the Harper operations API, or a `PUT` to the
  exported `RenderSchedule` endpoint. Those are recovered by the periodic floor reset
  (`queue.claimFloor.resetInterval`), or immediately by `POST /prerender_admin/queue`
  `{"action":"reset-claim-floor"}`. The backlog snapshot counts such rows (`belowFloor`) and both the
  overview and the URL explainer call them out — that is the only automatic evidence you get, because
  the schedule-repair sweep tests row _existence_ and such a row exists.

Set `queue.claimFloor.enabled: false` to roll the floor back to the old full seek. It changes nothing
else; leases stay where they are either way.

## HTTP & resource API

| Method & path                                | Purpose                                                             |
| -------------------------------------------- | ------------------------------------------------------------------- |
| `GET /p/<absolute-url>`                      | Serve prerendered/cached HTML for a bot (cache hit or origin fetch) |
| `POST /render_queue/pause`                   | Pause **this node's** queue                                         |
| `POST /render_queue/resume`                  | Clear this node's pause override                                    |
| `POST /render_queue/claim`                   | Claim due render jobs (`{ "limit": N }`)                            |
| `POST /render_queue/job_result`              | Submit a render result (binary; `x-metadata-size` header)           |
| `GET/PUT/DELETE /RenderTarget/...`           | Manage render targets                                               |
| `POST /RenderTarget` `{action:"revalidate"}` | Force re-render of matching targets                                 |
| `GET/POST/DELETE /sitemaps/<url>`            | Ingest / list / remove sitemaps                                     |
| `GET /sitemap_refresh/<root-url>`            | Progress + outcome of a background sitemap walk                     |
| `GET /queue_status`                          | Read per-node queue status (**observed**)                           |
| `GET /queue_control`                         | Read the desired pause state (**intent**)                           |
| `GET /prerender_admin`                       | Management UI + API — see below                                     |

## Management UI (`/prerender_admin`)

A single self-contained page (no build step, no external requests) plus the JSON API behind
it. Open `https://<host>:<port>/prerender_admin` and sign in with a Harper username and
password.

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

| Method & path                           | Purpose                                          | Gate         |
| --------------------------------------- | ------------------------------------------------ | ------------ |
| `GET /prerender_admin/`                 | the console shell (contains no data)             | public       |
| `GET /prerender_admin`                  | `308` → `prerender_admin/` (relative asset URLs) | public       |
| `GET /prerender_admin/<asset>`          | `app.css`, `app.js`, `views/*.js`, `fonts/*`     | public       |
| `GET /prerender_admin/session`          | who am I                                         | public       |
| `POST /prerender_admin/login`           | `{ username, password }`                         | public       |
| `POST /prerender_admin/logout`          | end the session                                  | session      |
| `GET /prerender_admin/overview`         | nodes, counts, backlog snapshot                  | `super_user` |
| `GET /prerender_admin/config`           | effective config + warnings                      | `super_user` |
| `GET /prerender_admin/sitemaps`         | root sitemaps + refresh state (never `entries`)  | `super_user` |
| `GET /prerender_admin/pages`            | `?prefix&cursor&limit` — page-cache browse       | `super_user` |
| `GET /prerender_admin/page-content`     | `?cacheKey` — one stored page, as `text/plain`   | `super_user` |
| `GET /prerender_admin/unrouted`         | this worker's unrouted-path tally (peek)         | `super_user` |
| `POST /prerender_admin/explain`         | `{ url, deviceType }` → cache-key trace          | `super_user` |
| `POST /prerender_admin/schedule`        | `{ cacheKey }` → this node's local schedule row  | `super_user` |
| `POST /prerender_admin/queue`           | `{ scope, paused }` → pause control, or          | `super_user` |
|                                         | `{ action: "reset-claim-floor" }` (this node)    |              |
| `POST /prerender_admin/revalidate`      | `{ url, deviceType }` → make one key due now     | `super_user` |
| `POST /prerender_admin/reconcile`       | start a schedule-repair sweep on this node       | `super_user` |
| `POST /prerender_admin/backlog`         | recompute the backlog/histogram snapshot now     | `super_user` |
| `POST /prerender_admin/sitemap`         | `{ url, offset, limit }` → one sitemap's detail  | `super_user` |
| `POST /prerender_admin/sitemap-refresh` | `{ url? }` → background walk of one/all roots    | `super_user` |

The console is fully self-contained: its stylesheet, scripts and fonts are served from the
same resource (the Ubuntu and Fira Code subsets are vendored with their licenses in
`src/admin/fonts/`), the CSP is `default-src 'none'` with `'self'` allowances and **no**
`unsafe-inline`, and nothing on the page loads from a third party. Static assets are public
like the shell — they ship in the package and carry no data; every data route re-checks
`super_user`. `page-content` is served as `text/plain` with `nosniff`, never `text/html`:
stored markup is origin-influenced content, and serving it as HTML from this origin would
execute it against the operator's super-user session.

### What it shows

- **Overview** — per-node queue status with staleness, table counts, the due-now backlog, the
  in-flight count, the claim-floor lag, and a next-24h histogram of `nextRenderTime`. That
  histogram is the quickest way to tell a healthy jittered spread from a render herd: a flat
  distribution means the initial-render jitter is working, a single tall bar means everything
  comes due at once. Note the histogram is capped at `management.scanCap` rows and reports
  `truncated` — at a large registry read the shape, not the counts.

  **The due-now backlog is still the capacity signal, but its healthy floor is no longer zero.**
  A claimed job's schedule row keeps its past due time until its result lands, so "due now"
  includes every in-flight render. Jitter flattens the arrival curve but cannot lower it, so a
  backlog that climbs and never returns to _roughly the in-flight count_ means sustained demand
  (`Σ targets ÷ renderInterval`) exceeds fleet throughput. The two numbers are shown side by side
  and never subtracted: one is a scan that may be fifteen minutes old, the other a gauge read at
  request time. Hour 0 of the histogram no longer holds the in-flight population for the same
  reason.

  **Claim floor lag** and **In flight** are live O(1) reads of the node-local shared buffer, and
  are labelled as such. A lag well past one `queue.jobLeaseTime` means a render is pinning the floor
  and everything behind it is waiting; the lag's subtitle names the row (as last observed by the
  worker serving the page — the claim pass is the only thing that sees it). A **Below claim floor** alarm means rows have been
  filed where no claim will look — see "The claim floor".

  The backlog/histogram is a **cached snapshot**, not a page-load query. Since v0.34.0 it is also
  the only scan left that seeks the absolute minimum of the `nextRenderTime` index, kept that way
  deliberately: that makes it the only detector of a below-floor row. It recomputes on
  `management.backlogSnapshotInterval` (worker 0 of each node, result in the node-local
  coordination database) and the page shows it with its age. _Recompute_ triggers a one-off
  pass; a dashboard refresh never touches the index.

- **Sitemaps** — the root list with per-root refresh state (running / failed, with the child
  failures), a capped count of targets attributed to the selected sitemap, and a paged entry
  table with per-entry state (`cached` / `stale` / `scheduled` / `filtered` /
  `non-indexable`). A `filtered` verdict costs no reads — it comes from the same route
  classifier the serving path uses. Alongside it, the unrouted-path tally: bot traffic served
  without prerendering, bucketed by first path segment, labelled with the worker whose slice
  it is.
- **Page cache** — browse `PrerenderedPage` by cache-key prefix (a primary-key range; the
  table's only index) with cursor paging. Freshness/indexable dropdowns filter the fetched
  page only and say so — those fields have no index, and the console never pretends
  otherwise. _view HTML_ streams the stored bytes as `text/plain`; _explain_ hands the row to
  the URL explainer.
- **URL explainer** — paste a URL and see the ingress route that matched, the query allowlist
  it selected, the canonical URL, the resulting cache key, and the live
  `RenderTarget`/`RenderSchedule`/`PrerenderedPage`/`NonIndexable` rows under it. It also
  reports the key the URL would get under the global `cacheKey.queryParams`, and flags a
  difference — that divergence is the usual fingerprint of a permanent cache miss caused by a
  missing or misordered route. It surfaces a `NonIndexable` suppression too, which otherwise
  removes a URL from rotation silently.
- **Config** — the effective merge of defaults and host overrides, with secrets shown only as
  whether they are set, alongside the risky-config warnings that previously existed only as
  startup log lines (empty security token, staging passthrough enabled, `renderNow` without a
  token).

The explainer also offers **Render this URL now**, which makes that one key due immediately.
It writes a single `RenderSchedule` row on purpose: the collection-level
`RenderTarget.revalidate` takes a search target, and aimed at the whole registry it queues
every target at once — at a million targets that is a self-inflicted render herd.

**This is also the supported way to force one URL to the front of the queue.** Writing
`nextRenderTime = 1` straight to the table through the operations socket used to work and no longer
reliably does: no plugin code runs in that path, so nothing lowers the claim floor, and the row can
land where no claim will look. Such a row is recovered only on the next floor reset
(`queue.claimFloor.resetInterval`), and until then the URL silently does not render. Use
`POST /prerender_admin/revalidate` — or the button — which writes through the funnel.

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

The state is therefore terminal _and_ silent: the cached page expires, every later bot request
falls through to the origin, and there is no error and no metric to notice it by. The only
symptom is a page whose `lastCached` keeps receding.

`render.reconcile` is the repair. Each node makes **one pass** over the target registry and, **for
the keys it owns**, checks node-locally whether the schedule row exists, collecting the gaps and
restoring them once the scan has finished.

The pass is deliberately cursor-free, so nothing depends on the order rows arrive in. Paging by
primary key and resuming from the last key seen would make correctness rest on the storage engine
returning rows in key order — and if that ever stopped holding, the cursor would skip rows
silently, which is the worst failure mode available to a repair tool. Restoring only after the
scan closes also makes the transaction rule structural rather than a convention: no write is ever
issued while the scan's cursor is open. Owner-scoped is a safety requirement, not an optimization: a point read of a
residency-pinned row this node does not own takes Harper's untimed replication fetch, so a
single such read could hang the sweep forever. Every node sweeping its own slice covers the
whole keyspace with no coordination and no cross-node reads.

Restores use the **jittered** initial render time rather than "now" — a sweep can repair a great
many rows at once, and queueing them all immediately would trade a silent outage for a render
herd. `maxRestores` caps writes per sweep and a truncated sweep says so in the log, so a short
count is never mistaken for "all clear".

The Overview panel shows the last sweep's result on that node and can start one on demand.

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
figure. The backlog/histogram scan walks at most `management.scanCap` rows (default 20 000)
and marks the result `truncated` when it hits that ceiling. At 1M+ targets an exact range
count is not a page-load query, so the UI labels an estimate as an estimate instead of
presenting a short count as the total.

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

The `empty`/`queued` half of that observed status is **derived, not scanned**. It used to be a
second head-seeking query against the render index on every tick; it is now computed from the claim
floor plus the last claim outcome, at zero database cost. It is deliberately tri-state at the
source: a pass that saw due rows but granted none (because they are all in flight) reports
`queued`, never `empty` — reporting `empty` there would tell the whole fleet to go idle while a
large backlog is being rendered. The `statusSyncInterval` convergence promise above is unchanged;
that interval now also carries the periodic claim-floor reset.

`POST /render_queue/pause` stays deliberately node-scoped: that endpoint sets
`loadAsInstance = false` and therefore enforces no authentication of its own, so it must not
be able to stop the whole fleet. Cluster-scoped control is only reachable through the
super-user-gated admin route.

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
162 B/write, 8.9× longer, claim's max latency _worse_). Collapsing due times to "now" is worse still:
the rows land exactly where the claim scan seeks, taking it **0.36 ms → 11.59 ms**. Recording an
epoch costs **0.18 ms and 102 bytes** — ~606,000× less audit — and it is what makes undo instant.

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

## How it fits together

```
bot ──GET /p/<url>──▶ plugin ──cache hit?──▶ serve PrerenderedPage
                          │ miss
                          └─▶ fetch origin, serve, and (if indexable) schedule a RenderTarget

render client ──claim──▶ render_queue ──jobs──▶ [headless render] ──job_result──▶ PrerenderedPage
```

The render service is a separate process; see [`@harperfast/prerender-browser`](../browser). Its
`RENDERER_BYPASS_*` settings must match this plugin's `origin.securityToken`.

## Development

```sh
npm test          # unit tests (node --test)
npm run lint      # from the repo root
```
