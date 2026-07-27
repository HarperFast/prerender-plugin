import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
	isArray: (tagName) => tagName === 'sitemap' || tagName === 'url',
});

/**
 * Parse sitemap XML into `{ isIndex, entries }`.
 *
 * Throws if the document is neither a `<urlset>` nor a `<sitemapindex>` — e.g. an HTML
 * error/challenge page (a 403 "Access Denied" from the CDN, a login wall, a 404 page). The
 * old code silently treated any such body as an empty sitemap, so a blocked fetch looked
 * like a successful no-op refresh (`created: 0, updated: 0, …`). Failing loudly here surfaces
 * the real problem to the caller.
 *
 * A valid but empty `<urlset/>` / `<sitemapindex/>` parses to `entries: []` WITHOUT throwing:
 * fast-xml-parser renders an empty element as `''`, so presence is checked with `in`, not
 * truthiness (`data.urlset` is falsy for an empty sitemap). The `typeof data === 'object'`
 * guard keeps `in` off a non-object result — fast-xml-parser v5 always returns an object
 * (plain text parses to `{}`), but this stays safe if that ever changes.
 */
export function parseSitemap(xml) {
	const data = parser.parse(xml);

	if (data && typeof data === 'object') {
		if ('urlset' in data) {
			return { isIndex: false, entries: Array.isArray(data.urlset?.url) ? data.urlset.url : [] };
		}
		if ('sitemapindex' in data) {
			return { isIndex: true, entries: Array.isArray(data.sitemapindex?.sitemap) ? data.sitemapindex.sitemap : [] };
		}
	}

	const rootTags = data && typeof data === 'object' ? Object.keys(data).filter((key) => key !== '?xml') : [];
	throw new Error(
		`expected a <urlset> or <sitemapindex> root, got ${rootTags.length ? `<${rootTags.join('>, <')}>` : 'a non-XML or empty document'}`
	);
}

/**
 * Does an already-known target need re-putting for `sitemapUrl`?
 *
 * `existingTarget` must be the RECORD an array select returns. Handed the bare scalar that a
 * STRING select returns, `.sitemapUrl` is `undefined` and this is unconditionally true — which
 * is precisely what went wrong: every known target was re-put on every refresh, and because
 * `RenderTarget.put` recomputes `getInitialRenderTime` (now + jitter), each refresh pushed the
 * next render FORWARD. Any target whose interval exceeded the refresh period (changefreq
 * weekly, monthly, yearly) was pushed back before it ever came due, and so never re-rendered.
 *
 * Lives here rather than in `resources/Sitemap.js` so it stays unit-testable: that module
 * subclasses `databases.sitemaps.Sitemap` at import time and cannot be loaded without a live
 * Harper.
 */
export const sitemapTargetNeedsUpdate = (existingTarget, sitemapUrl) => existingTarget?.sitemapUrl !== sitemapUrl;
