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

## License

Apache-2.0
