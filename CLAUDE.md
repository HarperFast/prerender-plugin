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
cd packages/browser && node --test                        # 42 tests; run from the package dir
npm run lint && npm run format:check                      # root, all workspaces
```

## Commit convention

`type(scope): summary; vX.Y.Z` — scope is `browser` or `plugin`; append the new package version on
the bump commit. e.g. `fix(browser): claim over https (queue port is TLS); v1.5.1`.

## Contributing flow

1. Branch off `main` (**never commit directly to `main`**).
2. Bump the version: `npm version <ver> --workspace <pkg> --no-git-tag-version` (updates the
   package's `package.json` + the root lockfile; does **not** create a git tag).
3. Commit, `git push -u origin <branch>`, `gh pr create --base main`, then `gh pr merge --merge`.

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
  [`RenderQueue.js`](packages/plugin/src/resources/RenderQueue.js).
