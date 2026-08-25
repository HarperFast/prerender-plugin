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
`server.recordAnalytics(value, metric, path, method, type)`. What Harper actually does with an
emit — read off `core/resources/analytics/write.ts`/`read.ts`, not assumed — governs every cost
decision here:

**The write path:** an emit appends into a per-thread Map keyed by the full
`(metric, path, method, type)` combo — a boolean (counter) is two integer adds, a number is a
`Float32Array` sample append; no storage touch, no await. ~1 s later the thread flushes: each
value-combo's samples are **sorted** into a ~10-point percentile distribution (the expensive
part — a counter skips it), and the whole thread report lands as **one row in
`hdb_raw_analytics`** (1 h retention). Every `analytics.aggregatePeriod` (default 60 s) the main
thread re-merges raw rows by combo and writes **one `hdb_analytics` row per active combo per
period**. So:

1. **Write cost is combos, not names.** The durable cost of a signal is its active combo count —
   rows per period per node, plus main-thread merge CPU. Merging or splitting metric _names_
   moves the same combos around.
2. **Counters are near-free on hot paths; values pay for their percentiles.** A per-request value
   metric buys its distribution with a sample buffer and a sort every flush on a traffic-serving
   worker. If a counter would answer the question, use a counter.

**The read path:** `hdb_analytics` deliberately indexes nothing but its primary key (the flush
writes bypass index maintenance), so `get_analytics(metric, start_time)` **scans the time window
across ALL metrics** and filters by name. So:

3. **A metric name is a scan; a series is a row.** A sweep querying N names re-reads the same
   window N times; every dimension combo of one name comes back in a single scan. This is why
   the low-volume signals live as series under two umbrella names (`queue_health`,
   `prerender_ops`) instead of as nine names.
4. **Three positional dimension slots** (`path`, `method`, `type`), meaning per-metric —
   `bot_serve`'s `path` is the serve source, `route_serve`'s is the route. Check the table
   before grouping. An empty slot is absent-or-null; never group by it.
5. **Per node, per thread.** Rows are node-local: every reading is a **sum across nodes**,
   recombine means count-weighted, treat merged p95s as approximate.
6. **Counters vs. distributions.** Boolean → `total` = `count` = how many. Number → `total`,
   `count`, `mean`, `median`, `p95`, `p99` (from the merged distribution).
7. **Cardinality is a year-long cost** (fact 1's row count) — bot names, routes, statuses and
   outcomes are closed sets; never put a URL, cache key or raw path in a dimension.

### Retention — set it, the default is a year

Aggregated rows default to **one year** of retention (`analytics.aggregateRetentionMs`,
available since Harper 5.2.0; raw rows default to 1 hour via `analytics.rawRetentionMs`, which
is fine). Nothing in this catalog gets charted past a quarter, and every retained combo-period
row is storage plus cleanup work forever — **set `analytics.aggregateRetentionMs` to ~90 days**
(`7776000000`) in the Harper instance config. Windowed queries don't get faster (the PK range
bounds them either way), but an accidental un-windowed `get_analytics` scans a quarter instead
of a year, and the table stops growing past what anyone reads. This is instance config on the
nodes, not plugin config — it rides a Harper config change, not a component deploy.

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

**Sweeping many names? Scan the window once, not once per name.** Fact 3 cuts both ways: since
`get_analytics` re-walks the same PK window for every name, a collector reading N names pays N
scans of identical rows. One `search_by_conditions` over the `id` (time) range — with the name
filter riding as a second condition or applied client-side — returns the identical row set for
every name in a single walk (verified row-identical against per-name `get_analytics`; ~6× faster
for a dozen names, and dynamic `response_*` names come along free). This is exactly what the
console's `GET /prerender_admin/analytics` does in-process (`src/util/analyticsRead.js`); an
external collector can do the same over the operations API. Bound the range on BOTH ends so the
PK drives the scan (an open range can make the planner walk a metric's entire history — harper#1796).

### The four questions dashboards actually ask

| Question                                 | Read this                                                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Are we taking load off the origin?       | `bot_serve` — share of rows with `path != 'origin'`, over all rows. Denominator sanity-check: `bot_request`.                                                              |
| Is the cache being hit, and is it fresh? | `bot_serve` grouped by `method`: cache-served is `hit + swr`; `hit` alone is "is the configured TTL being met". Then `page_age` p95 against the route's `renderInterval`. |
| Is the render queue keeping up?          | `queue_health` (`overdue`, `lease_occupancy`, `claim_scan_ms`) plus `render` `time_ms` p95 — and `below_floor` / `floor_pin_age_ms` for the silent failures.              |
| Which route should change its cadence?   | `route_serve` (swr/stale share = cadence not delivered, miss share = corpus not covered) and `route_page_age` p95 per route.                                              |

---

## 2. Metrics this plugin emits

One-line summaries; `src/metrics.js` carries the full description of every dimension value and the
reasoning behind it.

| Metric           | Kind    | `path`     | `method`    | `type`     | What it's for                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------- | ------- | ---------- | ----------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bot_request`    | counter | host       | botName     | deviceType | Raw crawl volume and mix at ingress. The denominator for every serve-side ratio.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `bot_serve`      | counter | source     | cacheStatus | botName    | **Origin offload** and **cache hit rate** — the two rollout numbers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `route_serve`    | counter | route      | cacheStatus | deviceType | The same outcome per route: which route's `renderInterval` needs to move.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `page_age`       | ms      | botName    | deviceType  | —          | Freshness as delivered: ms since the served snapshot rendered (cache serves only).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `route_page_age` | ms      | route      | cacheStatus | deviceType | Served age per route, split by freshness state — the "should this TTL move" number.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `render`         | value   | series     | per-series  | per-series | The render fleet in one scan: `time_ms` (duration by statusCode × candidacy — renders/hour = concurrency ÷ time_ms) and `outcome` (counter by outcome × detail, exactly one per posted result — the render-failure alert).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `origin_fetch`   | ms      | statusCode | reason      | —          | Cost of every non-cache serve: origin latency + status, by why the cache didn't answer (miss/stale/skip/invalidated/bypass/blob-missing/blob-timeout/render-timeout).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `prerender_ops`  | value   | series     | detail      | context    | Every low-volume ops signal in one scan: `unrouted` (class, bucket), `sitemap_*`, `serve_error`, `config_warnings`, `page_age_negative` (bot, device), `demand_*` (ladder decisions + `fast_fraction`/`fill`), `invalidation_error` (kind), `invalidation_reenqueue` (outcome, scope), `probe_*` (change-probe pass counters: probed/seeded/changed/triggered/deferred/failed per pass, plus `probe_canary_trip` and `probe_invalidated`; `probe_changed`/`probe_probed` is the measured change rate, a rising `probe_failed` share is the endpoint-changed-shape alarm), `discovery_gated` (gate, bot: cacheable misses the discovery gate held out of target creation — the corpus growth being prevented, not denied mints), `probe_fresh` (probes skipped because a baseline was younger than `reprobeAfter` — the work a restarted sweep skipped), `probe_throttled` (probes the origin refused with pushback — **alert on this**: it is the only signal that the probe is loading an origin that cannot take it), `probe_unreadable` (registry rows whose key failed to decode, skipped by the sweep's walk — a nonzero count means the table holds rows the application layer cannot address; escalate to the database layer), `probe_page_mismatch` (cached pages that disagreed with the origin — the round-trip-blindness class `pageCheck` catches; a rising share means renders are landing on transient states, and each one is a served page carrying wrong price/availability until it re-renders). |
| `queue_health`   | value   | series     | result      | —          | Every queue signal in one scan: the snapshot gauges (`overdue`, `lease_occupancy`, `below_floor`, `below_floor_age_ms`, `floor_pin_age_ms`, `paused`), `claim_scan_ms` (per pass, method = granted/empty/capped), `claim_granted` (per claim, method = ready/index), `ready_sweep_ms` (per sweep, method = complete/capped), `ready_published`, `ready_cadence` (per sweep, method = carried/resolved), `reconcile_restored`/`reconcile_missing` (per sweep).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

Notes that bite:

- **`bot_request`, `bot_serve`, `route_serve`, `page_age*` are gated** on `analytics.enabled` (and
  `analytics.recordUnmatched` for requests whose UA yields no name). No rows ≠ no traffic.
- **`queue_health`'s snapshot series and `prerender_ops`' `demand_*` are gauges on a slow cadence**, one set per node
  (`management.backlogSnapshotInterval`, `render.demand.statsInterval`). Chart the latest value;
  never sum a gauge over time. `overdue` sums across nodes and `fill` averages. The ladder's
  decision counters are NOT gauges — they are per-interval counts and must be summed.
- **`queue_health.overdue` includes in-flight renders** (a leased row keeps its past due time), so
  its healthy floor is the in-flight count, not zero — and it is not comparable with numbers from
  before v0.34.0. The scan is capped by `management.scanCap`: a backlog past the cap reports the cap.
- **`queue_health` needs `management.snapshotTableCounts` only for the table counts**; the gauges
  themselves survive with it off (that flag exists to dodge a `getRecordCount` stall).
- **The demand-ladder guardrail is `sum(demand_fast) / sum(demand_graded)`** — pool the counters
  across workers and nodes, divide at query time. Do **not** alert on a per-emitter ratio. The
  counters are per worker per interval and worker volumes are very unequal (production has shown
  `graded: 3` on one worker against `50` on a sibling in the same interval), so averaging per-worker
  ratios weights the least-evidenced workers equally with the best: 1/3 and 1/50 average to 0.175
  against a pooled truth of 2/53 = 0.038, a 4.6x overstatement. `demand_fast_fraction` was such a
  gauge and **was removed in v0.44.0**; chart the two counters instead.
- **`demand_graded` counts only decisions the ladder actually made** — `demand_promoted +
demand_demoted + demand_held`. The other two decision counters are the paths where the ladder had
  no choice and are excluded from both halves of the ratio: `demand_single_rung` (the route's own
  cadence is at or below the fastest rung, so its effective ladder has one entry) and
  `demand_skipped_cold` (the visit filter was not warm). Including them — the behaviour before
  v0.43.0 — made the number a readout of the route mix: any route configured below
  `maxFastInterval` put a floor under it that no amount of correct ladder behaviour could get under,
  and `maxFastFraction` warned continuously against zero promotions. Numbers do not span either
  deploy. `demand_promoted_fast` is the companion movement counter (promotions onto a fast rung);
  it settles to zero while the pooled ratio holds at whatever the ladder bought.
- **The `demand ladder` WARN line is per-worker and deliberately conservative.** It is suppressed
  below `1 / maxFastFraction` graded decisions (20 at the default), because under that a single fast
  decision exceeds the limit on its own and the ratio reports an event rather than a trend. It is a
  heads-up; the pooled counters are the alert.
- **`invalidation_reenqueue` (a `prerender_ops` series) is off by default.** No rows means the feature is disabled.
- **`render` `time_ms` carries a numeric statusCode** in its method slot, so it arrives as a
  numeric-looking label (`origin_fetch`'s path too; its `0` means the fetch itself failed before
  any status arrived).
- **`render` `outcome` emits exactly once per posted result**, so its outcomes sum to results
  processed and any single outcome reads as a share of render throughput.
- **Renamed in 0.39.0** (this plugin owns its only metric consumers, so the break was taken
  deliberately): `render_time` → `render`/`time_ms`; `demand_ladder` → `prerender_ops`/`demand_*`;
  `invalidation_error`, `invalidation_reenqueue`, `page_age_negative` → `prerender_ops` series of
  the same name. Rows under old names linger until analytics retention expires them — a chart
  spanning the deploy reads both.
- **Changed in 0.43.0 / 0.44.0**: 0.43.0 added `demand_single_rung` and `demand_promoted_fast` and
  narrowed `demand_fast_fraction`'s denominator to graded decisions; 0.44.0 replaced that gauge
  with the `demand_fast` and `demand_graded` counters. Three releases, three different numbers
  under the guardrail — do not chart across them; the current one is the pooled ratio.
- **Value semantics vary per series inside the umbrellas** — `prerender_ops`' `unrouted`/`sitemap_*`
  and `queue_health`'s `reconcile_*` are per-interval/per-run counts whose `total` is the
  meaningful sum (`count` is flushes/runs); `config_warnings` and the snapshot gauges are
  latest-value gauges; `claim_scan_ms` and `origin_fetch` are ordinary duration distributions.
- **`queue_health` mixes cadences on purpose** (slow snapshot gauges beside per-pass
  `claim_scan_ms`): one name = one `get_analytics` scan for the whole queue panel.

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
[Management API](README.md#management-api-prerender_admin) section for the full contract; the
console UI consuming these routes is the separate `@harperfast/prerender-console` component.

| Endpoint                          | What it adds over metrics                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET overview`                    | The last backlog snapshot: overdue count, in-flight leases, below-floor rows, claim-floor state, a **next-24h render histogram** (nowhere in metrics), and table counts (targets / pages / sitemaps / suppressed). Computed on a timer — the endpoint is a point read of the stored result, with its timestamp.                                                                                                                                                                                                                                                                                                 |
| `GET config`                      | Effective config (redacted), the full option schema, config **warnings**, and restart-pending changes. The warnings list is the cheapest misconfiguration check there is.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `GET metrics`                     | This catalog, from the running version.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `GET analytics?range=<ms>`        | **The console's own read of this table**: every catalog metric (plus `duration`/`success`/`response_*` at `path: 'p'`) in ONE bounded PK scan, bucketed server-side, per-worker cached (`management.analytics.*`). Node-local by construction; the payload carries the scan cost and the covered window. Each value series carries per-bucket `means`, `medians` and `p95s` (v0.51.0 added the medians — before it a dashboard could put a median in a tile but only a mean or a p95 in a trend). `total` is counter-only: distribution rows leave it 0, so the sum a value metric recorded is Σ(mean × count). |
| `GET unrouted`                    | Paths served without prerendering, bucketed by first path segment: CDN over-forwarding vs. missing routes. **Per-worker in-process counters** — the response says which worker's slice it is, so a cluster view must fan out over nodes _and_ workers.                                                                                                                                                                                                                                                                                                                                                          |
| `GET crawl-breadth?days=7`        | **Distinct URLs crawled per bot per day** (HyperLogLog). Crawl breadth is not derivable from `bot_request`, which counts requests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET invalidations`               | Active invalidation rows with scope, instant and reason. Pair with `prerender_ops` series `invalidation_error`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `GET sitemaps` / `POST sitemap`   | Per-sitemap URL counts and the last refresh run's outcome.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET pages`, `GET page-content`   | The actual cached snapshot — the only way to check hydration or a stray iframe.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `POST explain`                    | **Per-URL diagnosis**: cache key, route match, freshness verdict, schedule row, residency owner, suppression state. The first call to make about one URL; the metrics can't name a URL by construction.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `POST queue`                      | Queue pause: desired (replicated intent) vs. observed per node.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `POST backlog` / `POST reconcile` | Force a snapshot / a schedule-gap repair sweep. Both are **scans** — operator actions, not dashboard polls.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `GET change-probe`                | The change probe's node-local state: compiled rules, the last sweep/canary pass records (with failure samples the `probe_*` counters cannot carry), canary cohort sizes, and armed intervals. `POST change-probe` forces a pass — a **paced origin-fetch sweep**, an operator action, never a dashboard poll.                                                                                                                                                                                                                                                                                                   |

### 4b. Log lines that carry numbers no metric has

Grep-able, `[prerender]`-prefixed, and each is the richer record of something the metrics summarize:

- **`demand ladder {…}`** — the per-rung decision histogram (`levels`), which the `demand_*` series cannot
  carry: the metric has one series dimension, the log line has the whole distribution.
- **`<class>: N request(s) served without prerendering across …`** — the periodic unrouted report
  (`ingress.report.interval`), with the top buckets and a sample path per bucket.
- **`schedule reconcile: restored N of M missing schedule row(s) …`** — repairs of the terminal
  "target with no schedule row" state. Any non-zero `restored` is worth an alert; nothing else
  reports it.
- **`Sitemap refresh for <url> finished: …`** — sitemaps processed, targets created/removed, duration.
- **Render verdicts per URL** — `Suppressing prerendered url …`, `Prerender failed for … (reason)`,
  `Retrying … (failure strike N)`, `redirected to … which is <class>`. The aggregate is
  the `render` metric's `outcome` series; these lines carry the URL. Most are `info`/`debug` now (they are normal
  verdicts — turn the level up when investigating a specific URL); the ones that stay `warn`/`error`
  are the actionable ones: `Prerender failed`, auth-shaped results, and a redirect landing on a
  route class the config can't serve.

And error lines that are the _only_ evidence of their failure mode — each is alert-worthy on any
sustained rate (see §5):

- **`cached blob unreadable for … ; serving origin instead`** — a cached record whose blob file is
  gone (cause: harper#2134, where the invalidate path unlinks blobs live records still reference;
  replication also lands records whose bytes never arrived). The body is read to completion BEFORE
  the response commits a status, so this is now an ordinary origin serve rather than a truncated
  200 — correct bytes to the crawler, and visible: counted as `prerender_ops` series `serve_error`
  (`blob-unreadable`) **and** as `bot_serve`/`origin_fetch` with cacheStatus/reason
  `blob-missing`. That last one is the number to trend: it isolates blob integrity from coverage,
  which a `miss` cannot. The record is deliberately NOT deleted — `PrerenderedPage` replicates, so
  a delete evicted the page on every node (peers included, whose blob was often readable) and
  scheduled no repair, leaving the key on origin until its next scheduled render, up to 48h later.
  The scheduled re-render restores the blob either way.
- **`cached blob read exceeded …ms`** — the body was still being READ when `page.blobReadBudgetMs`
  ran out, so the request stopped waiting rather than making the crawler wait. Counted as
  `serve_error` (`blob-timeout`); as cacheStatus/reason `blob-timeout` when it then went to
  origin, or as cacheStatus `peer-rescue` when the residency owner's copy answered instead (see
  below). Split from `blob-missing` because the cause differs: the bytes ARE arriving — a base
  copy is streaming that blob (harper-pro#683) — just not in time. Without the budget these
  inherit Harper's `storage_blobReadTimeout` (20s): measured mid-copy on production, a cohort of
  88 cache hits averaging **13.6s** (p95 17.5s) on one node whose median hit was 2.3ms. A rising
  share here tracks replication churn; a rising `blob-missing` share tracks dangling references.
- **`cached blob … for … ; served the owner's copy (…)`** — the same two local failures, rescued:
  with `peerRescue` configured, the bytes came from the URL's residency owner over the cluster's
  own HTTPS (the owner wrote every render for its keys, so its blob is an original, never a
  received replica). Counted as `bot_serve` source `cache` / cacheStatus `peer-rescue` — still a
  cache serve for offload, but its own status so the rescue rate is trendable — alongside the
  same `serve_error`, which counts the LOCAL fault either way. `blob-timeout`/`blob-missing` on
  `bot_serve`/`origin_fetch` therefore now mean the rescue ALSO missed (owner is this node, owner
  unreachable, or the owner's own read failed) and the request fell back to origin.
- **`blob delivery error`** — the residual mid-stream failure, now reachable only for a cached body
  that arrived unmaterialized (the render-now timeout fallback). Still counted as `serve_error`
  (`blob-stream`); a non-zero rate here means a path is bypassing the up-front read.
- **`invalidation read failed for scope …`** — the storage fault behind the `invalidation_error` series; the
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

| Condition                                                                                           | Meaning                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queue_health` `below_floor` > 0 across consecutive snapshots                                       | Rows filed where no claim will ever look: **silently lost renders**. The gauge is the only automatic evidence.                                                                                                                                                                                                  |
| `prerender_ops` `invalidation_error` any rate, especially kind `lkg-expired`                        | An active invalidation is not being enforced on the requests that failed — content someone deliberately invalidated may still be serving.                                                                                                                                                                       |
| log `blob delivery error`                                                                           | Truncated 200s recorded as cache hits — invisible to every metric.                                                                                                                                                                                                                                              |
| log `schedule reconcile: restored N` with N > 0                                                     | Terminal schedule gaps existed and were repaired; find what created them.                                                                                                                                                                                                                                       |
| log `Sitemap … failed and was skipped` / `… aborted`                                                | Lost sitemap coverage (also `prerender_ops` series `sitemap_failed`).                                                                                                                                                                                                                                           |
| `render` outcome `auth-failure` any rate                                                            | The renderer's origin-bypass credential broke, or an origin bot-mitigation rule changed — hits everything at once, and never suppresses by design.                                                                                                                                                              |
| `prerender_ops` series `serve_error` = `blob-timeout`, or `bot_serve` cacheStatus `blob-timeout`    | Cache reads timing out against `page.blobReadBudgetMs` — a base copy is streaming those blobs. Served correctly (from the residency owner's copy when `peerRescue` is on — cacheStatus `peer-rescue` — else from origin); the signal is replication churn, and the alternative was a multi-second crawler wait. |
| `prerender_ops` series `serve_error` = `blob-unreadable`, or `bot_serve` cacheStatus `blob-missing` | Dangling blob references (harper#2134): cached records whose body is gone. Served correctly (owner's copy or origin, as above); with a rescue it isn't even lost offload — but it stays a blob-integrity signal, not a caching one.                                                                             |
| `prerender_ops` series `serve_error` = `blob-stream` any rate                                       | A truncated 200 DID reach a crawler — a cached body bypassed the up-front read.                                                                                                                                                                                                                                 |
| `queue_health` series `reconcile_restored` > 0                                                      | URLs were silently un-renderable until the sweep repaired them; find what created the gaps.                                                                                                                                                                                                                     |

**Thresholds — warn, then investigate:**

| Condition                                                                            | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queue_health` `overdue` − `lease_occupancy` growing snapshot-over-snapshot          | The fleet is falling behind demand (remember: `overdue`'s healthy floor IS the in-flight count).                                                                                                                                                                                                                                                                                                                                   |
| `queue_health` `floor_pin_age_ms` > ~1 h                                             | One key is holding the claim scan's seek position — the whole node's queue ages behind it.                                                                                                                                                                                                                                                                                                                                         |
| `bot_serve` swr share rising / `route_page_age` p95 > that route's `renderInterval`  | The cadence is configured but not delivered — a capacity or scheduling problem, not a config one.                                                                                                                                                                                                                                                                                                                                  |
| `bot_serve` miss share rising                                                        | Coverage: new URLs the corpus doesn't have, or the CDN forwarding paths it shouldn't (check `unrouted`).                                                                                                                                                                                                                                                                                                                           |
| `duration` p95 (`path: 'p'`) or `success` ratio degrading                            | The crawler-facing SLO, independent of any plugin-level explanation.                                                                                                                                                                                                                                                                                                                                                               |
| `queue_status` report timestamp stale, or intent ≠ observed > one sync interval      | A node stopped reporting (and likely claiming), or pause propagation is stuck.                                                                                                                                                                                                                                                                                                                                                     |
| `render` outcome `suppressed` or `failed` share rising                               | Mass suppression (an origin change disavowing pages) or a failing fleet — shares are readable directly because outcomes sum to results.                                                                                                                                                                                                                                                                                            |
| `queue_health` `claim_scan_ms` p95 trending up                                       | The scan is degrading (dead index entries at the seek point) before any backlog shows. Watch the trend, not the absolute number.                                                                                                                                                                                                                                                                                                   |
| `queue_health` `claim_granted` all `index`, none `ready`                             | Prioritisation is not engaging: the sweep is failing, the ready buffer could not be sized, or the set is always dry. The queue looks healthy in every other series because the ready set reorders a fixed amount of work and moves no total.                                                                                                                                                                                       |
| `queue_health` `ready_sweep_ms` method `capped`                                      | The sweep hit `queue.ready.sweepCap` without reaching a not-yet-due row, so it is ordering the oldest part of the backlog only — the rows it skipped are the youngest, i.e. exactly the recently-due pages the ordering exists to protect.                                                                                                                                                                                         |
| `queue_health` `ready_published` at 0 with a non-empty backlog                       | The sweep is running and finding nothing to publish. Check `queue.ready.capacity` was sizeable at boot (it is restart-scoped) and that the claim floor has not advanced past the due set.                                                                                                                                                                                                                                          |
| `queue_health` `ready_cadence` still mostly `resolved` after a full cadence          | Rows are being filed without an `effectiveInterval`, so the sweep is scoring them against their ROUTE ceiling rather than their demand-ladder rung — a promoted page reads as up to 4x less overdue than it is. Expected to be all `resolved` on the first sweep after an upgrade and to cross over as rows re-render; if it does not, a writer is passing `null` or the corpus is not re-rendering.                               |
| `origin_fetch` p95 or 5xx/`0` share rising                                           | Origin trouble that bots feel directly on every miss; a rising `render-timeout` share is renderNow falling back.                                                                                                                                                                                                                                                                                                                   |
| `queue_health` `paused` = 1 beyond the expected window                               | A node's queue is paused longer than whoever paused it intended.                                                                                                                                                                                                                                                                                                                                                                   |
| `prerender_ops` series `config_warnings` changed after a deploy                      | The deploy introduced a finding; `GET /prerender_admin/config` names it.                                                                                                                                                                                                                                                                                                                                                           |
| `prerender_ops` `probe_failed` share of `probe_probed` rising (change probe enabled) | The probed endpoint or markup changed shape under the rule — every failed probe is a page silently back on interval-only freshness. Failures deliberately change no schedule; fix the rule (`GET /prerender_admin/change-probe` carries failure samples). A `probe_canary_trip` without a matching `probe_invalidated` means the bulk response was skipped — dry-run, holdoff, or a mis-configured scope; the log line says which. |

**Absence is a signal — alert when a series stops:**

| Condition                                                 | Meaning                                                                                                                            |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| No `bot_request` rows at all                              | Ingress broken, the CDN stopped forwarding, or `analytics.enabled` was turned off — all three look identical from the dashboard.   |
| No `queue_health` rows for > 2× `backlogSnapshotInterval` | The snapshotter died or `management.enabled`/the interval was zeroed — the queue is now unmonitored, which is itself the incident. |
| No `render` rows while `overdue` is non-zero              | Workers are not posting results: fleet down, or claim/callback path broken.                                                        |

---

## 6. Known gaps — worth having, not observable yet

Signals that _should_ exist and don't, listed so nothing gets built on the assumption they exist.
(Everything cheap enough to be a buffered emit on an existing path has been implemented — these two
need real lift.)

1. **Crawl breadth as a daily gauge.** A per-node emit would be misleading — HLL sketches union,
   they don't sum, so the honest number needs the cluster-wide merge that only the `crawl-breadth`
   endpoint does today. Emitting it would mean electing one node to read every node's sketch rows
   on a daily timer. Until then: the endpoint.
2. **Hydration health.** A snapshot can be `200`, non-empty and indexable while missing everything
   the client renders. The framework's own hydration marker is the only reliable signal, and
   detecting it belongs in the render fleet (the browser package), not this plugin — a
   cross-package change. The failure mode stays silent by construction until then.
