# Harper Prerender

A configurable prerendering system for [Harper](https://www.harpersystems.dev/) that serves
crawler/bot traffic with prerendered, cacheable HTML. This is a monorepo with two packages:

| Package                                             | What it is                                                                                                                                                                                 |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`@harperfast/prerender`](packages/plugin)          | The Harper **plugin**: bot HTTP handler, render queue/scheduler, sitemap ingestion, and page cache. Fully configurable via the host app's `config.yaml`.                                   |
| [`@harperfast/prerender-browser`](packages/browser) | The render **browser**: a Puppeteer-based service that claims jobs from the plugin's queue, renders pages in headless Chrome, and posts the HTML back. Per-site rendering is configurable. |

The plugin runs inside Harper; the render browser runs as one or more separate worker processes that
connect to it over HTTP/MQTT.

## Layout

```
packages/
  plugin/    @harperfast/prerender          (Harper plugin — JavaScript)
  browser/   @harperfast/prerender-browser  (render service — TypeScript)
```

## Getting started

This repo uses npm workspaces.

```sh
npm install                 # install both packages
npm run lint                # lint everything
npm test --workspaces       # run package tests
```

See each package's README for configuration and usage:

- [Plugin configuration & API](packages/plugin/README.md)
- [Render service setup](packages/browser/README.md)

The plugin's `securityToken` and the client's `RENDERER_BYPASS_*` settings must match for the origin
to authenticate the renderer.

## Releasing

Both packages live in monorepo subdirectories, and npm can't install a subdirectory from a plain git
URL — so they are distributed as **GitHub Release tarballs** and consumers reference the asset URLs.

### Update + cut a release

1. On a branch, make changes and verify:

   ```sh
   npm run lint
   npm run format:check
   npm test --workspaces
   ```

2. Bump the version of the package(s) you changed (`packages/plugin/package.json` and/or
   `packages/browser/package.json`) following semver.
3. Merge to `main` and push.
4. Tag and create the release (use the bumped version):

   ```sh
   git tag -a v0.1.0 -m "v0.1.0"
   git push origin v0.1.0
   gh release create v0.1.0 --generate-notes
   ```

   Publishing the release triggers [`.github/workflows/release.yml`](.github/workflows/release.yml),
   which builds and attaches `harperfast-prerender-<version>.tgz` and
   `harperfast-prerender-browser-<version>.tgz` as release assets.

### Reference a release from a consumer

Point the dependency at the release asset URL:

```jsonc
"dependencies": {
  "@harperfast/prerender": "https://github.com/HarperFast/prerender-plugin/releases/download/v0.1.0/harperfast-prerender-0.1.0.tgz"
}
```

The render service references `harperfast-prerender-browser-<version>.tgz` the same way. Anonymous
`npm install` of these URLs requires the repo to be **public** (a private/internal repo's release
assets need an authenticated download).

## License

Apache-2.0
