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

The view-by-view tour lives in the plugin README's
[Management API](../plugin/README.md#management-api-prerender_admin) section alongside the
API contract; the short version: **Overview** (scale, serve health, backlog shape, claim
floor, schedule repair, and the discovered-target purge), **Traffic** (offload/hit-rate charts from
one bounded analytics scan per node, freshness reported relative to each route's own render cadence,
the non-hit verdicts broken out by what would fix them — coverage stated net of URLs the origin does
not have — the discovery gate, and a client-side bot filter), **Sitemaps**, **Page cache**,
**Queue** (render/claim health and the backlog), **Nodes**, **Invalidations** (preview-first
record/clear), **Change probe**, **URL explainer**, **Metrics** (the live catalog), **Config**.

**Change probe is new** (plugin v0.53.0+), and it is the one freshness surface that does not measure
pages against a cadence. It reads what the probe is actually detecting — the change rate against the
probes that HAD a baseline, not against every probe, because a pass that is mostly seeding has
compared nothing — beside the failure share, because those two numbers are only meaningful
together: a probe whose endpoint has changed shape reports zero changes, triggers nothing, and is
indistinguishable from a catalogue that is not moving. The canary's verdict is reported per node,
since a trip is a threshold crossed against one node's own cohort, and a trip that recorded no
invalidation says which of the three reasons it was.

The same view carries the one alarm here that is not about the probe at all. Plugin v0.56.0 gave
the sweep an origin backoff, and `probe_throttled` — 429/502/503/504 and connect/read timeouts — is
the only signal that the probe is loading an origin that cannot take it. The sweep answers pushback
by halving its own rate, so it covers less of the corpus per pass while the change rate, the failure
share and the trigger count all keep exactly the shape they had; nothing else surfaces it. Two
companions sit beside it: rows skipped because a baseline was still fresh (v0.56.0's resumable
sweeps — counted against the rows a pass _considered_, since a skipped URL was never probed, and
flagged when a settled deployment skips most of them, which means `reprobeAfter` sits too close to
`sweepInterval`), and registry rows that could not be decoded, which is a storage-layer escalation
rather than anything a setting here reaches.

**The discovery gate** is split across the two views that own its halves: how much crawl traffic
the gate is holding out of the render rotation is on Traffic (it carries a bot, so the bot filter
applies), while the purge that removes what got in before the gate went on sits on Overview beside
the key-rule orphan sweep — the console's other corpus-deleting action. The card states the
gate-first interlock rather than leaving it to the plugin's 400: with the route still discovering,
crawlers re-mint exactly what a purge removes.

That card defaults to **sparing bot-visited targets** (plugin v0.57.0's `skipVisited`), even though
the plugin's own default is off — a plugin default that changed behaviour for existing callers
would be the wrong kind of change, while a console default is a suggestion to a human. A stored
demand rung is durable evidence that a crawler came back to a page no sitemap declares, and
deleting one buys a delete plus a re-render to arrive back where we started. The flag rides on the
census as well as the purge, so the number an operator approves is the number that happens. Every
way a row survived a pass — deferred, spared, unreadable, failed — is subtracted before the card
reports what the pass never reached; a missing term there turns "we spared 40% on purpose" into
"~40% was never reached".

Two more changed shape when configuration became editable:

- **Nodes is new**, and it exists because "is this node healthy" had four homes: liveness and the
  replication gap on Overview, observed status and pause intent on Queue, config divergence on
  Config, and the topbar picker. The tell was that Queue imported the overview's own node-cell
  helpers to draw a second node table. It now owns all of it, plus the two per-node questions the
  override layer adds — did my edit reach this node, and is this node's override subscription
  still live. A node whose subscription has died silently stops honouring every edit made from
  this console, so that is the headline of the panel rather than a footnote.
- **Config** stopped being a JSON dump and became the searchable index of all 156 options: every
  option's default, deployed and override values, which layer won, and a filter for the questions
  operators actually arrive with (what is overridden, what differs from the repo, what is pending
  a restart). Divergence stays first, and stays the alarm it always was — a divergence at a path
  nobody overrides is still a deploy that skipped a node.

Each domain view owns the options that govern the data it shows — `sitemap.*` under Sitemaps,
`queue`/`render`/`scan` under Queue, `page`/`cacheKey` under Page cache, `analytics`/`crawlStats`
under Traffic, `invalidation` under Invalidations, `changeProbe` under Change probe — while Config
remains exhaustive, so a setting can be found either by where it acts or by name.

## Development

```bash
cd packages/console && node --test
```

No build step; the client is plain ES modules served from disk. The client modules must
never build DOM from HTML strings and never hardcode the mount path — both are enforced by
`test/adminAssets.test.js`.
