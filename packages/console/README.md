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
| **merged** | `overview`, `analytics`, `unrouted`, `config`                                    | fanned out and summed (or, for config, compared)                 |
| **shared** | `pages`, `page-content`, `sitemaps`, `invalidations`, `crawl-breadth`, `metrics` | replicated data — **one** node answers, and the payload names it |
| **single** | every POST                                                                       | writes are never fanned out                                      |

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
  — `reconcile`, `backlog`, `schedule` — refuse and ask for a node instead.

Cost: one bounded, per-worker-cached read per node per refresh, off the crawler serve path. The
`analytics` cache TTL (`management.analytics.cacheTtl` on the prerender side) absorbs view
switches and second operators, and the fan-out is capped at 6 concurrent upstream requests.

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

The view-by-view tour lives in the plugin README's
[Management API](../plugin/README.md#management-api-prerender_admin) section alongside the
API contract; the short version: **Overview** (scale, serve health, backlog shape, claim
floor, schedule repair), **Traffic** (offload/hit-rate/freshness charts from one bounded
analytics scan per node), **Sitemaps**, **Page cache**, **Queue & nodes** (pause controls plus
render/claim health, with per-node throughput), **Invalidations** (preview-first record/clear),
**URL explainer**, **Metrics** (the live catalog), **Config** (including cross-node divergence —
the only place a deploy that skipped a node is visible).

## Development

```bash
cd packages/console && node --test
```

No build step; the client is plain ES modules served from disk. The client modules must
never build DOM from HTML strings and never hardcode the mount path — both are enforced by
`test/adminAssets.test.js`.
