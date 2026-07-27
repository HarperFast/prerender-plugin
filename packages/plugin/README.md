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
  botPathPrefix: /p/ # requests under this prefix are treated as bot requests
  domains: [] # indexable-host allowlist; empty = allow all hosts

  ingress: # how incoming bot requests are parsed (see "Ingress modes" below)
    mode: prefix # 'prefix' (native /p/<absolute-url>) or 'forwarded' (reverse proxy/CDN)
    deviceTypeSource: header # 'header' (deviceTypeHeader) or 'path' (first path segment)
    deviceTypeHeader: x-device-type
    forwardedHostHeader: x-forwarded-host # forwarded mode: original public host
    forwardedProtoHeader: x-forwarded-proto
    defaultProtocol: https
    routes: [] # forwarded mode: [{ match: exact|prefix, path, queryParams: [...] }]

  deviceTypes:
    supported: [desktop, mobile, tablet]
    default: [desktop, mobile] # device types scheduled for auto-discovered pages

  cacheKey:
    delimiter: '|'
    attributes: [url, deviceType]

  url:
    queryParams: [page] # query params kept in the cache key; ['*'] = keep all, [] = drop all

  securityToken: # shared secret sent to the origin; must match the render client
    header: x-harper-renderer-bypass
    value: '' # SET THIS per deployment (or use valueEnv to keep it out of config.yaml)
    valueEnv: '' # if set, the token is read from this env var and overrides `value`

  debugHeader: # when this request header is present, debug response headers are added
    key: x-harper-prerender-debug
    value: 'true'

  ignoredHeaders: [] # extra request header names not forwarded to the origin, on top of the
  #                    always-ignored set (hop-by-hop headers plus host, user-agent,
  #                    accept-encoding, cookie, authorization, and the securityToken/debugHeader
  #                    names); matched case-insensitively

  staging: # origin staging passthrough (see "Staging passthrough" below)
    ip: '' # staging edge IP; empty = disabled. When set, a cache-MISS fetch that carries
    #        the `header` request header connects here instead of the public origin.
    header: x-harper-staging # request header whose presence toggles staging passthrough

  page:
    ttl: 86400000 # 24h — default cached-page TTL
    minTtl: 21600000 # 6h  — floor for sitemap-derived TTLs
    swrTtl: 10800000 # 3h  — stale-while-revalidate window

  render:
    defaultInterval: 86400000 # 24h — how often a target is re-rendered (relative to completion)

  sitemap:
    refreshTime: '12:00' # local time-of-day for the daily sitemap refresh
    timezone: America/New_York
    node: '' # pin the scheduled refresh to this node ('' disables it)
    workerIndex: 0 # ...and this worker

  queue:
    jobLeaseTime: 600000 # 10m — how long a claimed job is leased
    statusSyncInterval: 60000 # 1m  — how often queue status is recomputed/broadcast

  management: # the admin API + UI at /prerender_admin
    enabled: true # false makes every management route 404
    scanCap: 20000 # ceiling on rows an overview scan walks (see "Management UI")

  userAgents: # per-device User-Agent strings sent to the origin
    desktop: 'Mozilla/5.0 ... HarperPrerender/1.0'
    mobile: 'Mozilla/5.0 ... HarperPrerender/1.0'
    tablet: 'Mozilla/5.0 ... HarperPrerender/1.0'

  excludePathPatterns: ['/search/'] # URLs containing these are never auto-scheduled

  analytics:
    enabled: true # record bot_request analytics at all
    recordUnmatched: true # also record UAs that matched no configured bot (as 'other')
    bots: # registry: which crawlers are tracked by name. { name, match } — match is a
      - { name: Googlebot, match: googlebot } # case-insensitive UA substring; longer matches win.
      - { name: Bingbot, match: bingbot } # Remove an entry to stop tracking that bot.
      - { name: GPTBot, match: gptbot }
      # ... (see config.js for the full default list)
```

Most options are **live-reloaded** when you edit `config.yaml` — no restart needed.

### Ingress modes

How bot requests reach the plugin is configurable via `ingress.mode`:

- **`prefix`** (default) — the native model. A request is a bot request when its path
  starts with `botPathPrefix` (`/p/`), and the remainder of the path **is** the absolute
  target URL (`GET /p/https://example.com/page`). The device type comes from the
  `deviceTypeHeader` (`x-device-type`).

- **`forwarded`** — for sitting behind a reverse proxy / CDN (e.g. Akamai) that routes a
  restricted set of paths to the plugin. Here the incoming request carries a **relative**
  path, the original public host in a forwarded header, and (optionally) the device type as
  the **first path segment**:
  - `ingress.routes` is an ordered list of `{ match, path, queryParams }`. `match` is
    `exact` or `prefix`. A request is a prerender request only if its device-stripped path
    matches a route — so the plugin's own resource endpoints (`/render_queue`,
    `/queue_status`, …) fall through to REST **as long as no route matches them**. `prefix` is
    a raw string prefix, so keep routes specific (e.g. `/catalog/`, not `/c`) — an overly broad
    prefix like `/` would shadow those resource endpoints. The matched route's `queryParams` is
    the cache-key / origin-fetch query allowlist (same semantics as `url.queryParams`), so
    different routes can keep different params.
  - With `deviceTypeSource: path`, a leading `desktop`/`mobile`/`tablet` segment is consumed
    as the device type and stripped before the URL is rebuilt; if absent, the first supported
    device type is used and the path is left unchanged.
  - The absolute target URL is rebuilt as
    `${forwardedProtoHeader || defaultProtocol}://${forwardedHostHeader}${path}${query}`. A
    forwarded host that isn't a bare `hostname[:port]` is rejected (host-injection guard).

  Example: `GET /mobile/catalog/x.jsp?CN=...&utm=...` with `X-Forwarded-Host: www.example.com`
  → device `mobile`, target `https://www.example.com/catalog/x.jsp?CN=...` (a catalog route
  keeping only `CN`).

### Staging passthrough

To verify an origin against a staging edge (e.g. the Akamai staging network) _through_ the
plugin, set `staging.ip` to the staging edge IP. Then any **cache-miss** bot request that carries
the `staging.header` request header (`x-harper-staging` by default) has its origin fetch connected
to that IP instead of the public origin. Only the TCP address is pinned — the `Host` header and TLS
SNI stay the real origin host — so the staging edge serves the right property and presents a valid
certificate (the server-side equivalent of a `host-resolver-rules` / `/etc/hosts` override).

- **Cache hits are unaffected.** The header is not part of the cache key, so a cached page is always
  returned as-is; only the live origin fetch on a miss is redirected.
- **The header is a toggle, not a target.** The connect address is always the configured
  `staging.ip`, never a value from the request — so a request can't repoint the fetch at an
  arbitrary host. Leave `staging.ip` empty (the default) to disable the feature entirely; production
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
| `sitemaps`        | `Sitemap`, `SitemapRefresh`                   | sitemap data + refresh marker                    |
| `signals`         | `NonIndexable`                                | indexability signals                             |
| `coordination`    | `SharedBuffer`                                | node-local cross-worker SAB (never replicated)   |

Because `RenderTarget` and `RenderSchedule` now live in separate databases, a target and its schedule
are written as two independent commits (target first). The brief window where a target exists without a
schedule is benign and self-heals on the next sitemap refresh / `revalidate`.

See [`src/schemas/schema.graphql`](src/schemas/schema.graphql).

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

| Method & path                   | Purpose                                 | Gate         |
| ------------------------------- | --------------------------------------- | ------------ |
| `GET /prerender_admin`          | the UI page (contains no data)          | public       |
| `GET /prerender_admin/session`  | who am I                                | public       |
| `POST /prerender_admin/login`   | `{ username, password }`                | public       |
| `POST /prerender_admin/logout`  | end the session                         | session      |
| `GET /prerender_admin/overview` | nodes, counts, backlog shape            | `super_user` |
| `GET /prerender_admin/config`   | effective config + warnings             | `super_user` |
| `POST /prerender_admin/explain` | `{ url, deviceType }` → cache-key trace | `super_user` |
| `POST /prerender_admin/queue`   | `{ scope, paused }` → pause control     | `super_user` |

### What it shows

- **Overview** — per-node queue status with staleness, table counts, the due-now backlog, and
  a next-24h histogram of `nextRenderTime`. That histogram is the quickest way to tell a
  healthy jittered spread from a render herd: a flat distribution means the initial-render
  jitter is working, a single tall bar means everything comes due at once.
- **URL explainer** — paste a URL and see the ingress route that matched, the query allowlist
  it selected, the canonical URL, the resulting cache key, and the live
  `RenderTarget`/`RenderSchedule`/`PrerenderedPage`/`NonIndexable` rows under it. It also
  reports the key the URL would get under the global `url.queryParams`, and flags a
  difference — that divergence is the usual fingerprint of a permanent cache miss caused by a
  missing or misordered route. It surfaces a `NonIndexable` suppression too, which otherwise
  removes a URL from rotation silently.
- **Config** — the effective merge of defaults and host overrides, with secrets shown only as
  whether they are set, alongside the risky-config warnings that previously existed only as
  startup log lines (empty security token, staging passthrough enabled, `renderNow` without a
  token).

### Counting is capped, on purpose

Table totals come from Harper's `getRecordCount()`, which is time-bounded and switches to
sampling on a large table — it is reported with its `estimatedRange` rather than as an exact
figure. The backlog/histogram scan walks at most `management.scanCap` rows (default 20 000)
and marks the result `truncated` when it hits that ceiling. At 1M+ targets an exact range
count is not a page-load query, so the UI labels an estimate as an estimate instead of
presenting a short count as the total.

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

`POST /render_queue/pause` stays deliberately node-scoped: that endpoint sets
`loadAsInstance = false` and therefore enforces no authentication of its own, so it must not
be able to stop the whole fleet. Cluster-scoped control is only reachable through the
super-user-gated admin route.

## How it fits together

```
bot ──GET /p/<url>──▶ plugin ──cache hit?──▶ serve PrerenderedPage
                          │ miss
                          └─▶ fetch origin, serve, and (if indexable) schedule a RenderTarget

render client ──claim──▶ render_queue ──jobs──▶ [headless render] ──job_result──▶ PrerenderedPage
```

The render service is a separate process; see [`@harperfast/prerender-browser`](../browser). Its
`RENDERER_BYPASS_*` settings must match this plugin's `securityToken`.

## Development

```sh
npm test          # unit tests (node --test)
npm run lint      # from the repo root
```
