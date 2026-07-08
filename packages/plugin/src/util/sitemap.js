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
 * truthiness (`data.urlset` is falsy for an empty sitemap).
 */
export function parseSitemap(xml) {
	const data = parser.parse(xml);

	if (data && 'urlset' in data) {
		return { isIndex: false, entries: Array.isArray(data.urlset?.url) ? data.urlset.url : [] };
	}
	if (data && 'sitemapindex' in data) {
		return { isIndex: true, entries: Array.isArray(data.sitemapindex?.sitemap) ? data.sitemapindex.sitemap : [] };
	}

	const rootTags = Object.keys(data ?? {}).filter((key) => key !== '?xml');
	throw new Error(
		`expected a <urlset> or <sitemapindex> root, got ${rootTags.length ? `<${rootTags.join('>, <')}>` : 'an empty document'}`
	);
}
