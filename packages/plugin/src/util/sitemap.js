import { XMLParser } from 'fast-xml-parser';
import { canonicalizeUrl } from './url.js';
import { classifyPath, PASSTHROUGH, PRERENDER, UNCLASSIFIED } from './routeClass.js';

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
 * Split a sitemap's `<url>` entries into the ones worth prerendering and the ones that aren't.
 *
 * A sitemap is written for search engines, not for us: it lists every indexable URL on the site,
 * which is routinely a superset of the paths the CDN forwards here. Creating a RenderTarget for
 * a URL outside the prerender routes renders and stores a page that no read will ever look up —
 * pure render load and cache growth for no served output. At 1M+ URLs that is the difference
 * between the fleet working on pages bots actually receive and working on nothing.
 *
 * Returns `{ incoming, filtered, invalid }`:
 *   - `incoming` — Map of canonical URL-half -> entry, for prerender-class URLs only. Keyed the
 *     same way the bot read keys it, so the prune diff and the target keys built from it match
 *     what a request will look up.
 *   - `filtered`  — per-class counts of entries deliberately left out.
 *   - `invalid`   — `{ loc, message }` for entries whose URL won't parse, so one bad `<loc>`
 *     reports itself instead of aborting a refresh over millions of good ones.
 *
 * Pure and dependency-free (both helpers it uses are pure), so it is unit-testable — unlike
 * `Sitemap.refresh`, which cannot be loaded without a live Harper.
 */
export const partitionSitemapEntries = (entries) => {
	const incoming = new Map();
	const filtered = { [PASSTHROUGH]: 0, [UNCLASSIFIED]: 0 };
	const invalid = [];

	for (const entry of Array.isArray(entries) ? entries : []) {
		try {
			// Parse ONCE, and check parseability HERE rather than leaning on `classifyUrl`'s
			// unparseable fallback. That fallback reports UNCLASSIFIED, which would file a
			// malformed `<loc>` as a routing gap — "the route list is incomplete" — when it is
			// really a broken sitemap entry. Those have opposite fixes, and a sitemap full of
			// typos would otherwise trip the filtered-share alarm with the wrong diagnosis.
			const parsed = URL.parse(entry?.loc);
			if (parsed === null) {
				invalid.push({ loc: entry?.loc, message: 'not a valid absolute URL' });
				continue;
			}

			// One classification serves both the decision and the key; deriving them from separate
			// calls would let the class and the allowlist disagree about the same URL.
			const { routeClass, queryParams } = classifyPath(parsed.pathname);
			if (routeClass !== PRERENDER) {
				filtered[routeClass]++;
				continue;
			}
			incoming.set(canonicalizeUrl(entry.loc, queryParams), entry);
		} catch (e) {
			invalid.push({ loc: entry?.loc, message: e?.message ?? String(e) });
		}
	}

	return { incoming, filtered, invalid };
};
