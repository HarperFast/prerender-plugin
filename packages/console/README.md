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

**List nodes, not a load-balanced name.** Sessions are per Harper instance, and the
node-local views (analytics, queue health, the unrouted tally) are per node — a GTM/LB name
that rotates per connection would silently mix nodes across refreshes. The first entry is
the default node; the topbar picker switches between them.

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
  cannot steer the proxy at an arbitrary host.

## What it shows

The view-by-view tour lives in the plugin README's
[Management API](../plugin/README.md#management-api-prerender_admin) section alongside the
API contract; the short version: **Overview** (scale, serve health, backlog shape, claim
floor, schedule repair), **Traffic** (offload/hit-rate/freshness charts from one bounded
node-local analytics scan), **Sitemaps**, **Page cache**, **Queue & nodes** (pause controls
plus render/claim health), **Invalidations** (preview-first record/clear), **URL explainer**,
**Metrics** (the live catalog), **Config**.

## Development

```bash
cd packages/console && node --test
```

No build step; the client is plain ES modules served from disk. The client modules must
never build DOM from HTML strings and never hardcode the mount path — both are enforced by
`test/adminAssets.test.js`.
