/**
 * SELF-REFERENCES IN A SNAPSHOT, MADE FRAGMENT-ONLY: `url(<this page's URL>#id)` becomes `url(#id)`.
 *
 * WHY. Scripts build some references from `location`. A reviews widget fills its rating stars with
 * `fill="url(<page URL>#rating_star_filled)"`, a gradient defined in the same document but named through
 * the page's absolute URL. That is a same-document reference only while the snapshot is served AT that
 * URL. Served anywhere else — a query-string variant on a route whose key drops the query (`queryParams:
 * []` answers every one of them with one snapshot), or another spelling of the same entity (the plugin's
 * entity serve) — the URL names a different document, the reference becomes external, and an external
 * paint server is not loaded: the shape gets its fallback paint, or none.
 *
 * WHY IT IS ALWAYS CORRECT, AND SO NOT A SETTING. A fragment-only `url(#id)` refers to the element in the
 * CURRENT document, whatever that document's URL and whatever `<base>` says (CSS Values 4, fragment-only
 * URLs). At the page's own URL that is exactly what the absolute spelling named, so the rewrite changes
 * nothing there and repairs the reference everywhere else.
 *
 * WHAT IS REWRITTEN. A CSS `url(` — any case, optional whitespace, an optional `"` or `'` quote, or
 * `&quot;`, which is how the serializer writes a double quote inside an attribute value — followed by
 * this page's URL (absolute, scheme-relative or path-absolute) and then `#`. The URL is matched exactly,
 * query included, in its raw spelling and in its attribute-serialized one (`&` as `&amp;`). Nothing else
 * is touched: a reference to another URL, this URL without a fragment, and every `href` — which resolves
 * against `<base>`, so a fragment-only href is NOT the same reference — stay as they are.
 *
 * COST. Two `includes` over the serialized document for a page with no such reference, which is almost
 * every page; the replace runs only on a page that has one.
 */

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

export const fragmentOnlySelfReferences = (html: string, pageUrl: string): string => {
	if (typeof html !== 'string' || html === '') return html;
	let page: URL;
	try {
		page = new URL(pageUrl);
	} catch {
		return html;
	}
	// Every spelling ends in the path, the query and the `#`, so their absence proves there is nothing to do.
	const raw = `${page.pathname}${page.search}#`;
	const serialized = raw.replace(/&/g, '&amp;');
	if (!html.includes(raw) && (serialized === raw || !html.includes(serialized))) return html;

	const host = escapeRegExp(`//${page.host}`);
	const origin = `(?:${escapeRegExp(page.protocol)}${host}|${host})?`;
	const local = [...new Set([raw, serialized])].map(escapeRegExp).join('|');
	const reference = new RegExp(`([uU][rR][lL]\\(\\s*(?:["']|&quot;)?)${origin}(?:${local})`, 'g');
	return html.replace(reference, '$1#');
};
