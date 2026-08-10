# Metrics & observability — `@harperfast/prerender`

Everything this plugin makes observable, in one place: the metrics it emits, the metrics Harper
emits for its traffic, the API and log surfaces that carry signals no metric has, and what to
alert on. Written for whoever is building the next dashboard, monitor, or alert — §5 is the
alerting entry point; §6 lists what is _not_ yet observable so nothing gets built on the
assumption that it is.

**Source of truth.** The metric names, their dimension slots and their descriptions are declared in
[`src/metrics.js`](src/metrics.js) and served, live, by
`GET /prerender_admin/metrics` — ask a running node what it emits rather than matching this file
against a deployed version:

```sh
curl -sk https://<node>:9926/prerender_admin/metrics -u <super-user> | jq '.metrics.plugin[] | {name, kind, dimensions}'
```

Every emission goes through the small emitter functions at the bottom of `src/metrics.js`; a test
fails if any module calls `server.recordAnalytics` directly, so the catalog cannot drift from what
is emitted. **Adding a metric = a catalog entry + an emitter + a row in the table below.**

---

## 1. How to read any of them

Metrics go into Harper's own analytics store (`system.hdb_analytics`) via
`server.recordAnalytics(value, metric, path, method, type)`. Six facts govern every query:

1. **Three positional dimension slots**, named `path`, `method`, `type` — and their meaning is
   per-metric. `bot_serve`'s `path` is the serve source; `route_serve`'s `path` is the route. Always
   check the table below before grouping.
2. **Counters vs. distributions.** A boolean value is a counter (`total` counts the `true`s,
   `count` the calls — identical here, since every counter passes `true`). A numeric value is a
   distribution: `total`, `count`, `mean`, `median`, `p95`, `p99`.
3. **Per node, per thread.** Rows are node-local and aggregated per worker thread. Every reading is
   a **sum across nodes**; means and medians must be recombined count-weighted, and a p95 of p95s is
   an approximation. A single node's number is roughly a quarter of the answer on a 4-node cluster.
4. **Buffered, then flushed** on Harper's `analytics.aggregatePeriod` timer. Nothing here touches
   storage on the request path, and nothing is visible instantly.
5. **An empty dimension slot is not a dimension.** Depending on the emitter it is absent or an
   explicit `null`; either way, never group by it.
6. **Cardinality is a permanent cost.** Each distinct `(metric, path, method, type)` is a row per
   node per flush. Bot names, device types, route labels, statuses and outcomes are closed sets by
   construction — never put a URL, cache key or raw path into a dimension.

### Querying

```sh
# values for one metric, from one node (this is a per-node operation — fan out and sum).
# start_time is epoch MILLISECONDS.
harper get_analytics metric=bot_serve start_time=<epoch-ms> \
  get_attributes='["id","metric","path","method","type","count","total","mean","median","p95"]'

# which metrics exist right now (response_* names are dynamic — never hardcode them)
harper list_metrics metric_types='["custom"]' custom_metrics_window=3600000
```

Two hazards worth knowing before pointing anything at a production cluster:

- **Never pass `replicated: true` to `get_analytics`.** It fans the read out across the cluster
  from inside the read, and on a busy prerender node that is real load. Query each node yourself.
- **Never run `sql` against a production prerender cluster.** Full scans stall the claim path. Use
  `get_analytics`, `/prerender_admin/*` and `describe_table` instead.
- `page_age` and `bot_serve` are the highest-cardinality metrics here; on a large fleet they are
  also the most expensive to sweep. If a collector gets slow, exclude them from the fast loop
  rather than lengthening every interval.

### The four questions dashboards actually ask

| Question                                 | Read this                                                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Are we taking load off the origin?       | `bot_serve` — share of rows with `path != 'origin'`, over all rows. Denominator sanity-check: `bot_request`.                                                              |
| Is the cache being hit, and is it fresh? | `bot_serve` grouped by `method`: cache-served is `hit + swr`; `hit` alone is "is the configured TTL being met". Then `page_age` p95 against the route's `renderInterval`. |
| Is the render queue keeping up?          | `queue_health` (`overdue`, `lease_occupancy`) plus `render_time` p95 — and `below_floor` / `floor_pin_age_ms` for the silent failures.                                    |
| Which route should change its cadence?   | `route_serve` (swr/stale share = cadence not delivered, miss share = corpus not covered) and `route_page_age` p95 per route.                                              |

---

## 2. Metrics this plugin emits

One-line summaries; `src/metrics.js` carries the full description of every dimension value and the
reasoning behind it.

| Metric                   | Kind    | `path`     | `method`    | `type`     | What it's for                                                                               |
| ------------------------ | ------- | ---------- | ----------- | ---------- | ------------------------------------------------------------------------------------------- |
| `bot_request`            | counter | host       | botName     | deviceType | Raw crawl volume and mix at ingress. The denominator for every serve-side ratio.            |
| `bot_serve`              | counter | source     | cacheStatus | botName    | **Origin offload** and **cache hit rate** — the two rollout numbers.                        |
| `route_serve`            | counter | route      | cacheStatus | deviceType | The same outcome per route: which route's `renderInterval` needs to move.                   |
| `page_age`               | ms      | botName    | deviceType  | —          | Freshness as delivered: ms since the served snapshot rendered (cache serves only).          |
| `route_page_age`         | ms      | route      | cacheStatus | deviceType | Served age per route, split by freshness state — the "should this TTL move" number.         |
| `page_age_negative`      | counter | botName    | deviceType  | —          | Cross-node clock skew on the serve path. Expect zero.                                       |
| `render_time`            | ms      | statusCode | candidacy   | —          | Fleet capacity (renders/hour = concurrency ÷ render_time) and settle-tuning results.        |
| `queue_health`           | gauge   | gauge name | —           | —          | `overdue`, `lease_occupancy`, `below_floor`, `below_floor_age_ms`, `floor_pin_age_ms`.      |
| `demand_ladder`          | gauge   | series     | —           | —          | Ladder decisions (`promoted`/`demoted`/`held`/`skipped_cold`) plus `fast_fraction`, `fill`. |
| `invalidation_error`     | counter | kind       | —           | —          | An invalidation that cannot be read is being silently not enforced. Expect zero.            |
| `invalidation_reenqueue` | counter | outcome    | scope       | —          | Whether an invalidation is actually healing, and why not when it isn't.                     |

Notes that bite:

- **`bot_request`, `bot_serve`, `route_serve`, `page_age*` are gated** on `analytics.enabled` (and
  `analytics.recordUnmatched` for requests whose UA yields no name). No rows ≠ no traffic.
- **`queue_health` and `demand_ladder` are gauges on a slow cadence**, one set per node
  (`management.backlogSnapshotInterval`, `render.demand.statsInterval`). Chart the latest value;
  never sum a gauge over time. `overdue` sums across nodes, `fast_fraction` and `fill` average.
- **`queue_health.overdue` includes in-flight renders** (a leased row keeps its past due time), so
  its healthy floor is the in-flight count, not zero — and it is not comparable with numbers from
  before v0.34.0. The scan is capped by `management.scanCap`: a backlog past the cap reports the cap.
- **`queue_health` needs `management.snapshotTableCounts` only for the table counts**; the gauges
  themselves survive with it off (that flag exists to dodge a `getRecordCount` stall).
- **`invalidation_reenqueue` is off by default.** No rows means the feature is disabled.
- **`render_time`'s `path` is a number** at the emit site, so it arrives as a numeric-looking label.

---

## 3. Metrics Harper emits for this plugin's traffic

Not emitted here, but a prerender dashboard is incomplete without them. The bot handler stamps
`request.handlerPath = 'p'`, so **`path: 'p'` isolates crawler traffic** from admin-console and
render-result requests in the same rows. (These are also in the live catalog, under `builtIn`.)

| Metric            | Kind    | Useful for                                                                                                                                                                                                            |
| ----------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `duration`        | ms      | Latency the crawler experienced (`path: 'p'`). Its `type` carries Harper's own `cache-hit`/`cache-miss` verdict — an independent read on the same hit rate `bot_serve` reports, and a cross-check when they disagree. |
| `success`         | counter | Error rate as one series (status < 400) without enumerating status codes.                                                                                                                                             |
| `response_<code>` | counter | The status mix served to crawlers. **Dynamic names** — discover with `list_metrics`.                                                                                                                                  |
| `bytes-sent`      | bytes   | Snapshot size trend; a sudden drop is the signature of un-hydrated output. Streamed responses only, so it is a distribution, not a total.                                                                             |
| `memory`          | value   | Per-thread memory on nodes that also serve bot traffic — context for swap-pressure incidents.                                                                                                                         |

---

## 4. Beyond metrics: what else is observable

Metrics answer "how much, how fast, how fresh". These answer "which URL, and why" — and several
carry numbers that have no metric at all.

### 4a. Management API (`/prerender_admin/*`, super-user)

Point reads, safe to poll at dashboard cadence unless noted. See the README's
[Management UI](README.md#management-ui-prerender_admin) section for the full contract.

| Endpoint                          | What it adds over metrics                                                                                                                                                                                                                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET overview`                    | The last backlog snapshot: overdue count, in-flight leases, below-floor rows, claim-floor state, a **next-24h render histogram** (nowhere in metrics), and table counts (targets / pages / sitemaps / suppressed). Computed on a timer — the endpoint is a point read of the stored result, with its timestamp. |
| `GET config`                      | Effective config (redacted), the full option schema, config **warnings**, and restart-pending changes. The warnings list is the cheapest misconfiguration check there is.                                                                                                                                       |
| `GET metrics`                     | This catalog, from the running version.                                                                                                                                                                                                                                                                         |
| `GET unrouted`                    | Paths served without prerendering, bucketed by first path segment: CDN over-forwarding vs. missing routes. **Per-worker in-process counters** — the response says which worker's slice it is, so a cluster view must fan out over nodes _and_ workers.                                                          |
| `GET crawl-breadth?days=7`        | **Distinct URLs crawled per bot per day** (HyperLogLog). Crawl breadth is not derivable from `bot_request`, which counts requests.                                                                                                                                                                              |
| `GET invalidations`               | Active invalidation rows with scope, instant and reason. Pair with `invalidation_error`.                                                                                                                                                                                                                        |
| `GET sitemaps` / `POST sitemap`   | Per-sitemap URL counts and the last refresh run's outcome.                                                                                                                                                                                                                                                      |
| `GET pages`, `GET page-content`   | The actual cached snapshot — the only way to check hydration or a stray iframe.                                                                                                                                                                                                                                 |
| `POST explain`                    | **Per-URL diagnosis**: cache key, route match, freshness verdict, schedule row, residency owner, suppression state. The first call to make about one URL; the metrics can't name a URL by construction.                                                                                                         |
| `POST queue`                      | Queue pause: desired (replicated intent) vs. observed per node.                                                                                                                                                                                                                                                 |
| `POST backlog` / `POST reconcile` | Force a snapshot / a schedule-gap repair sweep. Both are **scans** — operator actions, not dashboard polls.                                                                                                                                                                                                     |

### 4b. Log lines that carry numbers no metric has

Grep-able, `[prerender]`-prefixed, and each is the richer record of something the metrics summarize:

- **`demand ladder {…}`** — the per-rung decision histogram (`levels`), which `demand_ladder` cannot
  carry: the metric has one series dimension, the log line has the whole distribution.
- **`<class>: N request(s) served without prerendering across …`** — the periodic unrouted report
  (`ingress.report.interval`), with the top buckets and a sample path per bucket.
- **`schedule reconcile: restored N of M missing schedule row(s) …`** — repairs of the terminal
  "target with no schedule row" state. Any non-zero `restored` is worth an alert; nothing else
  reports it.
- **`Sitemap refresh for <url> finished: …`** — sitemaps processed, targets created/removed, duration.
- **Render verdicts per URL** — `Suppressing prerendered url …`, `Prerender failed for … (reason)`,
  `Retrying … (failure strike N)`, `redirected to … which is <class>`. The **only** place a render
  outcome is recorded per URL today (see the gaps below).

And error lines that are the _only_ evidence of their failure mode — each is alert-worthy on any
sustained rate (see §5):

- **`blob delivery error`** — a cached page whose stored body failed to stream **after the 200 was
  committed**: the crawler got a truncated response while every metric records a cache hit. The
  entry self-evicts (the next request heals it), but the serve that triggered it is already wrong,
  and this line is the only record. Log-only today — see the gaps.
- **`invalidation read failed for scope …`** — the storage fault behind `invalidation_error`; the
  metric says how often, the line says which scope and what threw.
- **`could not accelerate … after an invalidation`** — the demand-driven heal path failing
  unexpectedly (the metric's `error` outcome, with the exception attached).
- **`job_result rejected: x-metadata-size …`** — a render worker posting malformed results; the
  render is lost and re-granted when its lease expires, so a burst means fleet-version skew or a
  broken worker, not queue trouble.
- **`render-lease buffer is N bytes but queue.maxLeases=M wants …`** — a `queue.maxLeases` config
  change reached a running node; the node runs at the OLD size until restarted (the option is
  restart-scoped for this reason).
- **`Sitemap <url> failed and was skipped` / `Sitemap refresh for <url> aborted`** — a sitemap walk
  losing coverage; nothing else reports a failed walk.

### 4c. Tables you can query directly

Read-only, and mind the caveats: **no `sql` on production**, and a point read of a
residency-pinned row you don't own can block indefinitely — pass `replicateFrom: false`.

| Table                            | Carries                                                                                                                                                                          |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `render_service.Target`          | The corpus: one row per URL, with `state` (active/suppressed), `strikes`, `renderInterval`, `demandInterval`, `sitemapUrl`. Suppression and strike distributions live only here. |
| `render_schedule.RenderSchedule` | Due times per cache key — the queue itself. Shard counts must sum to the Target count (a divergence is a replication fault).                                                     |
| `page_cache.PrerenderedPage`     | The snapshots: `lastCached`, `expiresAt`, body blob.                                                                                                                             |
| `invalidation.Invalidation`      | Active invalidation epochs. **Verify a row on a peer node** — replication faults make an invalidation silently inert on nodes that never received it.                            |
| `crawl_stats.CrawlSketch`        | The raw HLL sketches behind crawl-breadth (`day\|bot\|node`).                                                                                                                    |
| `coordination.SharedBuffer`      | Node-local: the stored backlog snapshot, sitemap-run claims, advisory markers.                                                                                                   |

### 4d. Public REST surfaces (outside `/prerender_admin`)

Same-instance HTTP, documented in the README's endpoint table; these are what an external monitor
that cannot hold a super-user session can still watch.

| Endpoint                      | Signal                                                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /queue_status`           | Per-node **observed** queue state (`empty`/`queued`/`paused`) with its `updatedTime` — the staleness of that timestamp is itself a signal (a node not reporting is a node not claiming).          |
| `GET /queue_control`          | The **desired** pause state (replicated intent). Intent ≠ observed for longer than one `statusSyncInterval` means a node is not converging — that comparison is the pause-machinery health check. |
| `GET /sitemap_refresh/<root>` | Progress and outcome of a background sitemap walk: which node holds the claim, cursor position, counts so far. The way to tell "slow but moving" from "stalled".                                  |
| `GET /RenderTarget/<url>`     | One target's stored state (`state`, `strikes`, intervals) — the minimal per-URL probe when the admin API's `explain` isn't available.                                                             |

### 4e. Config warnings are a monitorable surface

`GET /prerender_admin/config` returns `warnings` — the plugin's own findings about risky or
inert settings (empty security token, empty domains allowlist, rejected route entries, a
reenqueue window clamped up to the lease time, an invalidation row present while
`invalidation.enabled` is false…). Each has a `severity` and a stable `key`. **A non-empty
warnings list after a deploy is the cheapest misconfiguration alert there is** — poll it once per
config change, not on a cadence.

---

## 5. Alerting: what to watch

The catalog above is reference; this is the short list. "Sum across nodes" is implied everywhere
(§1.3). Thresholds are starting points, not doctrine — tune against a week of your own traffic.

**Expect zero — page on any sustained non-zero:**

| Condition                                                     | Meaning                                                                                                                                   |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `queue_health` `below_floor` > 0 across consecutive snapshots | Rows filed where no claim will ever look: **silently lost renders**. The gauge is the only automatic evidence.                            |
| `invalidation_error` any rate, especially kind `lkg-expired`  | An active invalidation is not being enforced on the requests that failed — content someone deliberately invalidated may still be serving. |
| `page_age_negative` sustained                                 | Cross-node clock skew on the serve path; also quietly undermines `invalidation.pad`'s sizing.                                             |
| log `blob delivery error`                                     | Truncated 200s recorded as cache hits — invisible to every metric.                                                                        |
| log `schedule reconcile: restored N` with N > 0               | Terminal schedule gaps existed and were repaired; find what created them.                                                                 |
| log `Sitemap … failed and was skipped` / `… aborted`          | Lost sitemap coverage.                                                                                                                    |

**Thresholds — warn, then investigate:**

| Condition                                                                           | Meaning                                                                                                         |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `queue_health` `overdue` − `lease_occupancy` growing snapshot-over-snapshot         | The fleet is falling behind demand (remember: `overdue`'s healthy floor IS the in-flight count).                |
| `queue_health` `floor_pin_age_ms` > ~1 h                                            | One key is holding the claim scan's seek position — the whole node's queue ages behind it.                      |
| `bot_serve` swr share rising / `route_page_age` p95 > that route's `renderInterval` | The cadence is configured but not delivered — a capacity or scheduling problem, not a config one.               |
| `bot_serve` miss share rising                                                       | Coverage: new URLs the corpus doesn't have, or the CDN forwarding paths it shouldn't (check `unrouted`).        |
| `duration` p95 (`path: 'p'`) or `success` ratio degrading                           | The crawler-facing SLO, independent of any plugin-level explanation.                                            |
| `demand_ladder` `fill` > ~0.5, or `fast_fraction` near `maxFastFraction`            | The visit filter is saturating (false positives promote unvisited pages) / the ladder is at its budget ceiling. |
| `queue_status` report timestamp stale, or intent ≠ observed > one sync interval     | A node stopped reporting (and likely claiming), or pause propagation is stuck.                                  |

**Absence is a signal — alert when a series stops:**

| Condition                                                 | Meaning                                                                                                                            |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| No `bot_request` rows at all                              | Ingress broken, the CDN stopped forwarding, or `analytics.enabled` was turned off — all three look identical from the dashboard.   |
| No `queue_health` rows for > 2× `backlogSnapshotInterval` | The snapshotter died or `management.enabled`/the interval was zeroed — the queue is now unmonitored, which is itself the incident. |
| No `render_time` rows while `overdue` is non-zero         | Workers are not posting results: fleet down, or claim/callback path broken.                                                        |

---

## 6. Known gaps — worth emitting, not emitted yet

Listed with the shape they'd take, so a dashboard doesn't get built on the assumption they exist.
None of these are decided; all are cheap (a counter bump on a path that already runs).

1. **Render outcomes.** `render_time` records how long a render took, never **what happened to it**.
   Suppressions, failures, strikes, transient statuses and redirect verdicts exist only as per-URL
   log lines, so "renders are failing" is not chartable and not alertable. This is the largest gap.
   Shape: `render_outcome` counter, `path` = outcome (`rendered`/`failed`/`suppressed`/
   `redirect`/`transient`/`unroutable`), `method` = status code.
2. **Claim-path health.** The claim scan's duration is the queue's leading indicator — a measured
   17× degradation from dead index entries at the seek point was invisible to metrics. Shape:
   `claim_scan` value (ms), `path` = outcome (`claimed`/`empty`/`paused`).
3. **Origin proxy cost.** Every non-cache serve proxies to the origin, and neither its latency nor
   its status mix is recorded — so the cost of a miss is invisible while offload looks fine. Shape:
   `origin_fetch` value (ms), `path` = status code, `method` = reason (`miss`/`bypass`/`renderNow-fallback`).
4. **Sitemap and reconcile runs as counters** (targets created/removed, rows restored) — today
   log-only, so neither can be alerted on.
5. **Unrouted volume as a metric.** The buckets are already bounded and reporting-safe; a counter
   would remove the per-worker fan-out from the read path.
6. **Crawl breadth as a daily gauge**, so distinct-URL coverage sits beside request volume instead of
   needing its own endpoint.
7. **Hydration health.** A snapshot can be `200`, non-empty and indexable while missing everything
   the client renders. The framework's own hydration marker is the only reliable signal, and nothing
   counts it — the failure mode is silent by construction.
8. **Serve-path blob failures as a counter.** `blob delivery error` (§4b) is the worst kind of
   silent: the response was already committed as a 200 cache hit when the body died, so the
   _metrics say success_. A counter would make truncated serves alertable without log scraping.
   Shape: `serve_error` counter, `path` = kind (`blob-stream`/…).
9. **Queue pause as a gauge.** Whether a node's queue is paused (and for how long) lives only in
   `GET /queue_status` — an alert on "paused > N hours" needs a poller today. One `queue_health`
   series (`paused`, 0/1) from the snapshot pass would make it a metric like the rest.
10. **Config warnings as a gauge.** The warnings list (§4e) is pull-only; a `config_warnings` count
    emitted on config apply would page on a bad deploy instead of waiting for someone to open the
    console.
