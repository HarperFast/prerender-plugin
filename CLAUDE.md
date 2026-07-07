# prerender-plugin — agent guide

Monorepo (`@harperfast/prerender-monorepo`, npm **workspaces** under `packages/*`) for Harper's
prerender system. Two published packages, both consumed by downstream services from **GitHub
Release tarball URLs** (npm can't install a package that lives in a monorepo subdirectory from a
plain git URL — hence the tarball).

## Packages

| Path | Package | Release tag | Build |
|---|---|---|---|
| `packages/browser` | `@harperfast/prerender-browser` | `vX.Y.Z` | TypeScript → `tsc` |
| `packages/plugin`  | `@harperfast/prerender` | `prerender-vX.Y.Z` | plain JS, no build |

`packages/browser` is the headless-Chrome render library that **render-service** embeds and drives
(claims jobs from the queue, renders, posts HTML back). `packages/plugin` is the Harper component
(REST resources + schema) that runs *inside* Harper and serves the render queue.

- **`dist/` is gitignored — never commit build output.** CI builds it at release time.
- Node 24 in use (`engines: >=20`; the `.ts` tests need ≥ 22 for type-stripping).

## Build, test, lint

```bash
npm run build --workspace @harperfast/prerender-browser   # tsc
cd packages/browser && node --test                        # run tests from the package dir
npm run lint && npm run format:check                      # root, all workspaces
```

## Commit convention

`type(scope): summary; vX.Y.Z` — scope is `browser` or `plugin`; append the new package version on
the bump commit. e.g. `fix(browser): claim over https (queue port is TLS); v1.5.1`.

## Contributing flow

1. Branch off `main` (**never commit directly to `main`**).
2. Bump the version: `npm version <ver> --workspace <pkg> --no-git-tag-version` (updates the
   package's `package.json` + the root lockfile; does **not** create a git tag).
3. Commit, `git push -u origin <branch>`, `gh pr create --base main`. **Do not merge** — see
   "PRs & review" below. A human merges after review.

## Releasing (this is what produces the tarball consumers install)

Publishing a **GitHub Release** triggers [`.github/workflows/release.yml`](.github/workflows/release.yml)
(`on: release: published`), which runs `npm ci`, builds the browser package, `npm pack`s **both**
packages, and uploads the `.tgz` assets to that release tag.

1. Merge the version-bump PR to `main`.
2. `gh release create vX.Y.Z --target main --title "vX.Y.Z — @harperfast/prerender-browser" --notes "…"`
   (plugin releases use the tag `prerender-vX.Y.Z`).
3. Wait for the *Release tarballs* run, then confirm the asset:
   `gh release view vX.Y.Z --json assets --jq '.assets[].name'`
4. Consumers reference
   `https://github.com/HarperFast/prerender-plugin/releases/download/vX.Y.Z/harperfast-prerender-browser-X.Y.Z.tgz`.

The workflow packs both packages, so a browser release also (harmlessly) re-attaches the current
plugin tarball to that release, and vice-versa.

## Hard-won lessons

- **Always `https`, never `http`, except a `localhost` origin.** The Harper queue API port
  (default `9926`) serves **TLS** in every real deployment. Speaking `http://` to it gets the
  connection closed with zero bytes → undici `UND_ERR_SOCKET: other side closed`, which the
  consumer mislabels as an unreachable host and circuit-breaks. Build queue URLs as
  `localhost`/`127.0.0.1` → `http`, else `https` — see the claim path in
  [`RenderQueueConsumer.ts`](packages/browser/src/RenderQueueConsumer.ts) and `callbackOrigin` in
  [`RenderQueue.js`](packages/plugin/src/resources/RenderQueue.js) (which currently checks only
  `localhost`, not `127.0.0.1`).

<!-- SHARED:system-overview — keep in sync across prerender-plugin, kohls-pr, render-service -->
## System overview (all three repos)

Freshly-spun-up agents: the three repos are coupled through release tarballs. Know the whole picture
before touching versions.

```
Akamai ──bot/crawler traffic──▶  kohls-pr  (Harper component + @harperfast/prerender plugin)
                                    │  enqueues render jobs, serves cached HTML
                                    ▼
                        render-service@<customer>  (fleet of @harperfast/prerender-browser workers)
                                    │  headless Chrome renders the page
                                    └──────────── posts rendered HTML back to the component ─────────▶
```

| Repo | Role | Branch model | Dep on this monorepo |
| --- | --- | --- | --- |
| **prerender-plugin** | source monorepo (this) | PRs → `main` | — |
| **kohls-pr** | Harper component, serves bot traffic behind Akamai | PRs → `main` | `@harperfast/prerender` tarball (`prerender-v*`) |
| **render-service** | headless-browser render fleet, one branch per customer (`kohls`, `stbhb`, `mcy`…) | version bumps commit **directly** to the customer branch; feature work via `feat/*` PR | `@harperfast/prerender-browser` tarball (`v*`) |

A downstream repo cannot bump until the upstream tarball asset already exists at its release URL —
**cut the release here first, then bump the consumer.**

<!-- SHARED:concurrency — keep in sync across all three repos -->
## Concurrent work (multiple agents/people)

- **One git worktree per agent/task — never two agents in one clone.** A clone shares its working
  tree, checked-out branch, and `node_modules`; two agents in it corrupt each other's state.
  `git worktree add /private/tmp/<repo>/<task> -b <fix-or-feat>/<task> origin/<base>` — put
  worktrees under `/private/tmp/`, remove with `git worktree remove`.
- **Keep `main` / customer branches clean.** No uncommitted work on a shared branch; branch first.
- **Sequence the release trains** and **reserve the next version number** in the issue/PR before you
  start, so two people don't both claim `v1.6.1` / `prerender-v0.3.5`.
- **Isolate shared runtime/test state:** distinct `WORKER_ID`, cache dirs, MQTT origins per run;
  don't share the Akamai staging pipeline across simultaneous sessions (its cache is keyed by URL
  only and cross-contaminates; toggling staging↔prod requires wiping the resource cache).

<!-- SHARED:pr-review — keep in sync across all three repos -->
## PRs & review (multi-agent)

PRs here are reviewed by **other agents and humans** who leave comments. "PR opened" ≠ "done".

- **Never auto-merge. A human performs every merge, approve, and deploy.** Agents drive a PR to a
  reviewable state; that's the finish line.
- **Before considering a PR finished, read and address *every* open review thread from *any*
  reviewer** — not just findings handed to you. Inline and PR-level comments both count:
  ```sh
  gh pr view <PR#> --comments
  gh api repos/HarperFast/<repo>/pulls/<PR#>/comments --jq '.[] | {path, line, user: .user.login, body}'
  ```
- For each comment: **fix it and push to the same branch**, or **reply explaining the dismissal**.
  Don't silently ignore feedback. After pushing fixes, leave a short summary comment so reviewers can
  re-check; don't resolve others' threads on their behalf.
