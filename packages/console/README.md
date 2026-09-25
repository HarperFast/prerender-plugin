# `@harperfast/prerender-console`

The prerender management console, as its own Harper component: it serves the console UI and
proxies every API call to a prerender deployment's `/prerender_admin` endpoints
([`@harperfast/prerender`](../plugin), v0.47.0+, which is API-only). Deploy it on the
prerender cluster itself, on a separate ops cluster, or on a laptop — the UI is identical
everywhere; only the `nodes` list changes.

Open `https://<host>:<port>/prerender_console` and sign in with a super_user of the
**prerender** cluster.

## Install

Reference the release tarball (the package lives in a monorepo subdirectory, which npm can't
install from a plain git URL):

```
https://github.com/HarperFast/prerender-plugin/releases/download/prerender-console-vX.Y.Z/harperfast-prerender-console-X.Y.Z.tgz
```

## Configuration

Options are supplied by the host app under this component's key in its `config.yaml`:

```yaml
'@harperfast/prerender-console':
  package: '<tarball url>'
  nodes: # the prerender nodes this console may talk to — see below
    - 'https://node-a.internal.example.com:9926'
    - 'https://node-b.internal.example.com:9926'
  requestTimeout: 30000 # ms deadline per proxied request
  rejectUnauthorized: true # verify upstream TLS; false hands operator credentials to whatever answers
```

**List nodes, not a load-balanced name.** Sessions are per Harper instance, and the underlying
data (analytics, the backlog snapshot, queue health, the unrouted tally) is per node — a GTM/LB
name that rotates per connection would silently mix nodes across refreshes, and would make the
cluster aggregation below impossible. List every node: the console reads all of them by default.

## Cluster scope

**The console shows the whole cluster by default, and one node on demand.** The topbar picker's
first entry is _all nodes_; the rest are the configured nodes, for drilling in.

This matters because almost nothing in a prerender deployment is cluster-wide at the source.
`hdb_analytics` rows are written per node. The backlog snapshot covers only the residency-pinned
`RenderSchedule` keys _that_ node owns. The claim floor is a node-local shared buffer. So a
per-node console showed one Nth of an N-node cluster, and the cluster's real numbers — total
serve rate, total render backlog — had to be assembled by hand across N browser tabs.

Under cluster scope the proxy fans each read out to every signed-in node and merges the answers
server-side ([`src/util/aggregate.js`](src/util/aggregate.js)). Three classes, and the class is
part of the contract:

| Class      | Routes                                                                           | What happens                                                     |
| ---------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **merged** | `overview`, `analytics`, `unrouted`, `config`, `change-probe`, `discovery-purge` | fanned out and summed (or, for config, compared)                 |
| **shared** | `pages`, `page-content`, `sitemaps`, `invalidations`, `crawl-breadth`, `metrics` | replicated data — **one** node answers, and the payload names it |
| **single** | every POST                                                                       | writes are never fanned out                                      |

The last two merged routes are owner-scoped passes rather than sums: a probe pass and a purge pass
each cover the keys one node owns, so what the merge produces is every node's own slice side by
side plus the running tally, and the nodes that have not run are named. One node's "deleted
240,118" answered under a cluster label would read as done when three quarters of the keyspace has
not been touched.

A test pins every proxied GET to a class, so adding a route without deciding how it aggregates
fails CI rather than silently answering from one node under an "all nodes" label.

Three properties worth knowing:

- **A partial answer is labelled, never silently short.** A sum missing a node is not a smaller
  number, it is a wrong one, and it looks exactly like a traffic drop. Every merged payload
  carries a `sources` block (who answered, who didn't, why), and the UI banners the whole view
  when it is incomplete.
- **Sums are only applied where things add.** Node-local counters add; replicated table counts
  do not (they are compared instead, and a disagreement is flagged as a possible replication
  gap); a cluster p95 is a count-weighted approximation and is always written `≈`. If
  `analytics_replicate` is on, the merge detects it and reads one node rather than multiplying
  the cluster by N.
- **Actions are never fanned out.** A write under cluster scope lands on one node, which is
  correct for the replicated tables they touch. The routes that act on a single node's own state
  — `reconcile`, `backlog`, `schedule`, `sweep-orphans`, `change-probe`, `discovery-purge` — refuse
  and ask for a node instead. A probe pass refuses for a second reason on top of residency: its
  rate cap is a promise made to whoever runs the origin, **per node**, and fanning the pass out
  would spend it N times over. A write whose result
  is read back moments later by a panel that alarms on nodes disagreeing (today: `config-override`)
  additionally carries an envelope naming the node that accepted it and saying the rows replicate,
  so the console's own write path does not read as the failure that panel exists to raise.

Cost: one bounded, per-worker-cached read per node per refresh, off the crawler serve path. The
`analytics` cache TTL (`management.analytics.cacheTtl` on the prerender side) absorbs view
switches and second operators, and the fan-out is capped at 6 concurrent upstream requests.

## Editing configuration

The console writes the plugin's config. Values resolve in three layers — schema defaults, the
deployed `config.yaml`, then override rows the console writes — and the console shows all three per
option, so "what is this cluster running, and who decided that" is answerable without a git
checkout on another machine.

**Preview is the default path**, as it is for invalidations. Edits stage locally; the primary
button is a dry run that the _plugin_ computes by resolving a prospective config through the same
merge and the same schema constraints a real apply uses. That is what lets the preview report the
three things a client-side diff cannot:

- a value that would be **rejected** and stored without taking effect,
- a change that is a **no-op** (an override merely restating the deployed value),
- **routes that would be silently dropped** — an invalid `ingress.routes` entry is discarded rather
  than refused, so without this the preview would confirm a route about to vanish.

Applying is a second, explicit click from inside that answer.

**One write, not a fan-out.** The rows replicate, so the edit goes to a single node and every node
converges — in about a second via each worker's table subscription, or within
`management.overrides.syncInterval` if a node's subscription is not live. During that window nodes
genuinely disagree, which is why config divergences now carry `overridden`: a divergence at an
overridden path is the layer converging, not the deploy failure the un-tagged kind still means.

**What the console refuses to edit**, and says so rather than offering a dead control: the three
secret options (the API only ever returns `<set: N chars>`, so a form round-trip would store the
redaction marker as the token), `management.enabled` (one click would remove the console), and the
`management.overrides` group itself (the machinery these writes go through, including its own kill
switch — `management.overrides.enabled: false` in the config file makes the whole layer inert).

Restart-scoped options can be set, but the write **stages**: the console shows them as pending a
restart rather than letting a value that is not running look applied.

## How it works

```
browser ── same-origin (cookies, CSP 'self') ──▶ prerender-console component
                                                     │  validated, allowlisted proxy
                                                     ▼
                                     https://<picked node>/prerender_admin/*
```

- **Server-side proxy, not CORS.** The UI keeps the embedded console's security model —
  cookie session, `default-src 'none'` CSP, no cross-origin anything in the browser. The
  cross-cluster hop is a bounded server-to-server request.
- **Sign-in forwards the operator.** Login fans out to every configured node; each node
  authenticates against its own Harper users and issues its own session. The console stores
  no credentials — what persists is one HttpOnly, SameSite=Strict cookie holding the
  upstream session tokens per node. Every action lands upstream as the operator who
  clicked it. Partial success is success: nodes that failed are labelled "(signed out)" in
  the picker, and picking one lands on the sign-in form.
- **The proxy is an allowlist twice over.** Only the fixed route set the UI calls is
  forwarded (a test pins it against the plugin's dispatch, cross-package), and the `node`
  parameter is matched against the configured list — it never becomes a URL, so the browser
  cannot steer the proxy at an arbitrary host. The `cluster` sentinel is a literal and never
  reaches that matcher, so the SSRF gate is untouched by it.

## What it shows

| View              | What it answers                                                                                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Health**        | Is anything wrong? Every tile is a check with a verdict (ok / watch / bad), and anything not ok is listed in the banner. The landing page.                                                      |
| **Traffic**       | What crawlers got: offload (gross and net), freshness relative to each route's cadence, the non-hit verdicts by fix, **traffic by instance**, origin load, crawlers, routes, gate, raw cache.   |
| **Queue**         | Is the render machinery keeping up: cluster pause, backlog and time to clear, claim floor, the **node table** (status, intent, per-node throughput, pause controls), outcomes, renders by node. |
| **Sitemaps**      | Per-root ingest and check state, entries, and 24h walk counters.                                                                                                                                |
| **Corpus**        | Corpus counts, and the three manual per-node passes: schedule repair, discovered-target purge, key-rule orphan sweep.                                                                           |
| **Invalidations** | Active scopes, preview-first record/clear, and what the active rows are doing (refused vs rescued).                                                                                             |
| **Change probe**  | What the probe is doing now, per node, with health flags; last pass; canary; finished-pass counters.                                                                                            |
| **Inspect**       | One URL end to end: resolved key, stored rows, cadence resolution, revalidate, the page cache table.                                                                                            |
| **Config**        | The searchable index of every option: layers, overrides, divergence between nodes, pending restarts.                                                                                            |
| **Metrics**       | The live metric catalog.                                                                                                                                                                        |

The API contract behind each view is in the plugin README's
[Management API](../plugin/README.md#management-api-prerender_admin) section.

### The shell

- **One time range** (15m–24h, capped by `management.analytics.maxRange`) in the top bar, shared by every
  view that charts analytics, so every view reads the same cached window and shows the same range.
- **Loads are sequenced.** A response for a load that has been superseded (a newer range, a view switch) is
  dropped before it is written, and a load writes only into the view that started it. Identical in-flight
  GETs share one request.
- **Loading is a skeleton, never "no data"** — an empty state is a claim about the cluster, not the fetch.
- **Charts hover by crosshair**: the whole plot is the target, the pointer snaps to the nearest bucket, and
  the tooltip shows every series (with its share, on stacked bars).
- **Explanations sit behind each card's `?`**, settings behind a collapsed **Settings** section, and long
  option descriptions behind "more". Warnings stay on the page, one sentence each.
- The view is in the URL hash, so a reload or a bookmark keeps it.

### Health checks

Thresholds are judgement calls set where a number stops being tail noise for a healthy deployment; they live
in one place (`views/health.js`). A system tile shows the **worst node**, never an average.

| Group       | Checks                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Serving     | bot serves/min, net offload (< 50% watch, < 0 bad), cache-served, coverage miss, staleness (median age ÷ cadence), 5xx share, cache-hit p95, origin failures |
| Rendering   | renders/h, failure share, render time, claim scan p95, prioritised claims, backlog **time to clear** (> 2h watch, > 8h bad), claim floor lag                 |
| Cluster     | nodes responding, queue paused, replication, config agreement, pending restart, override watch, plugin version skew, analytics scan truncation               |
| System      | CPU (share of cores), memory available, swap-in (major faults/min), worker event loop, task latency, disk free, uptime — **needs plugin v0.92.0**            |
| Maintenance | rows below the claim floor, schedule repair, active invalidations                                                                                            |

System vitals come from Harper's own per-minute resource rows, which the plugin's analytics scan now keeps
(same scan, no second walk), plus a point-in-time host block on `overview`. Against an older plugin the
section says so once instead of showing zeroes.

### Reading the numbers

- **Offload is stated gross and net.** Gross is crawler requests not proxied live; net also subtracts every
  origin request this system makes (renders, probes, sitemap fetches): `1 − (proxied + renders + probes +
sitemap fetches) ÷ crawler requests arrived`. Both sides are documents only — the XHR/fetch calls a
  rendering crawler's page makes never pass through the plugin — so where snapshots are served without
  scripts the true net is higher than shown. Probe and sitemap counts land where a pass finished; quote 24h.
- **Freshness is relative**: served age ÷ that route's render interval, so 1.0 means "due" on every route.
  The median leads; an evenly refreshed corpus sits at 0.50× median and ~0.95× p95 by construction.
- **Not every non-hit is a miss.** Verdicts are grouped by fix (coverage, cadence, integrity, invalidation,
  raw, not-cacheable). Coverage is net of URLs the origin answered 404/410 — those can never be cached.
  `verified` and `raw` are cache serves; `raw` is never a hit and never a freshness number.
- **By instance** compares nodes from per-node buckets in the cluster merge. A share far from an even split
  is load-balancer weighting or a node out of rotation; a low cache-served share is a cold cache.
- **The raw-document cache reports what it refused** — an enabled route filling nothing looks exactly like
  one nobody enabled. `has-cookie` (a route assumed shared is personalized) and `oversize` are called out.
- **Ingested is not checked.** A `304` writes nothing, so a sitemap's ingest time is hours old by design;
  when it was last looked at is on the run row. `not modified` is the only evidence conditional fetching
  works.
- **Discovered-target purge** (Corpus) defaults to sparing bot-visited targets, and the census runs the same
  predicate as the purge. Gate the route first, or crawlers re-mint what a purge removes.
- **Change probe** judges change rate against the probes that had a baseline, beside the failure share —
  a probe whose endpoint changed shape reports zero changes and looks like a quiet catalogue.

Each domain view owns the options that govern the data it shows — `sitemap.*` under Sitemaps,
`queue`/`render`/`scan` under Queue, `page`/`cacheKey` under Inspect, `analytics`/`crawlStats` under Traffic,
`invalidation` under Invalidations, `changeProbe` under Change probe — while Config remains exhaustive, so a
setting can be found either by where it acts or by name.

## Development

```bash
cd packages/console && node --test
```

No build step; the client is plain ES modules served from disk. The client modules must
never build DOM from HTML strings and never hardcode the mount path — both are enforced by
`test/adminAssets.test.js`.
