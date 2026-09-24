/**
 * What the rendered page itself CLAIMS — its canonical, title, meta description, first heading,
 * product JSON-LD and breadcrumb trail — read off the settled DOM and posted with each variant.
 *
 * WHY THE RENDERER. The consumer compares these against its own sources of truth to decide whether a
 * cached page is wrong (and only then re-render it). It deliberately never parses HTML on its hot
 * write path, so every fact it compares has to arrive already extracted. Here it is one
 * `page.evaluate` against a DOM that is already parsed and already settled.
 *
 * BOUNDS ARE REFUSALS, NEVER TRUNCATIONS. A truncated value would disagree with the consumer's source
 * of truth on every comparison, and a systematic disagreement means the consumer expires and
 * re-renders that page forever. So a value past its bound is reported as no claim at all (`null`),
 * which degrades to exactly what "the page does not say" does: nothing to compare.
 *
 * Standard HTML and schema.org only — nothing here may know about a particular site.
 */

/** One offer as the page states it: `[sku, price, currency, availability]`, all strings or null. */
export type PageFactOffer = [
	sku: string | null,
	price: string | null,
	currency: string | null,
	availability: string | null,
];

/**
 * The first Product / ProductGroup JSON-LD node on the page. For a ProductGroup, a field the group
 * does not state is taken from its first `hasVariant`.
 */
export type PageFactsProduct = {
	name: string | null;
	/** `brand.name` when the brand is an object, else a string brand. */
	brand: string | null;
	/** The first image: a string, the first array element, or an ImageObject's `url`. Not resolved. */
	image: string | null;
	/** `aggregateRating` as `[ratingValue, ratingCount ?? reviewCount]`; null when neither is numeric. */
	rating: [value: number | null, count: number | null] | null;
	/**
	 * The product's offers in document order (an AggregateOffer contributes its `offers` list). A lone
	 * sku-less offer takes the product's `sku`; a ProductGroup with no offers of its own reports its
	 * variants' offers, each sku-less offer taking its variant's `sku`.
	 */
	offers: PageFactOffer[] | null;
};

/**
 * The page's own SEO facts. Every string field is `null` when the page does not state it, states it
 * empty, or states it longer than {@link PAGE_FACT_BOUNDS}.`maxString`.
 */
export type PageFacts = {
	/** `.href` of the first `<link rel="canonical">` — absolute, resolved against the document. */
	canonical: string | null;
	/** `document.title`, trimmed. */
	title: string | null;
	/** `content` of the first `<meta name="description">`, verbatim. */
	metaDescription: string | null;
	/** `textContent` of the first `<h1>`, runs of whitespace collapsed to one space, trimmed. */
	h1: string | null;
	product: PageFactsProduct | null;
	/** Names from the first BreadcrumbList, ordered by `position`. */
	breadcrumbs: string[] | null;
};

export type PageFactBounds = {
	/** A string field longer than this is null. */
	maxString: number;
	/** More offers than this makes `product.offers` null. */
	maxOffers: number;
	/** More breadcrumb names than this makes `breadcrumbs` null. */
	maxBreadcrumbs: number;
	/** An offer field longer than this is null (the same 64 that bounds `structuredOffers` fields). */
	maxOfferField: number;
};

export const PAGE_FACT_BOUNDS: PageFactBounds = {
	maxString: 2048,
	maxOffers: 200,
	maxBreadcrumbs: 30,
	maxOfferField: 64,
};

/**
 * Read the page's facts off the live DOM. Runs IN THE PAGE (passed to `page.evaluate`), so it is fully
 * self-contained: no imports, no closure over module scope, every helper declared inside.
 *
 * JSON-LD is searched the way `extractStructuredOffers` searches it — each
 * `<script type="application/ld+json">` in document order, reading a top-level array or an `@graph`
 * as a list of nodes — and a block that does not parse is skipped without costing the others. When no
 * top-level node matches, one level under a page node (WebPage or a subtype) is searched too: its
 * `mainEntity` / `mainEntityOfPage` for the product, its `breadcrumb` for the trail.
 */
export function extractPageFacts(bounds: PageFactBounds): PageFacts {
	type Json = Record<string, unknown>;
	const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
	const boundTo =
		(max: number) =>
		(value: unknown): string | null =>
			typeof value !== 'string' || value === '' || value.length > max ? null : value;
	const str = boundTo(bounds.maxString);
	const offerField = boundTo(bounds.maxOfferField);
	const hasType = (node: Json, wanted: string[]) => {
		const type = node['@type'];
		return Array.isArray(type) ? type.some((t) => wanted.includes(t as string)) : wanted.includes(type as string);
	};
	// A schema.org number may be written as a JSON number or a numeric string ("4.5"). Anything else —
	// including null, which Number() would silently read as 0 — is no claim.
	const num = (value: unknown): number | null => {
		if (typeof value === 'number') return Number.isFinite(value) ? value : null;
		if (typeof value !== 'string') return null;
		const trimmed = value.trim();
		if (!trimmed || trimmed.length > bounds.maxOfferField) return null;
		const n = Number(trimmed);
		return Number.isFinite(n) ? n : null;
	};
	const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : value ? [value] : []);

	const canonicalEl = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
	const descriptionEl = document.querySelector('meta[name="description" i]');
	const h1El = document.querySelector('h1');

	// schema.org WebPage and its subtypes: the nodes whose `mainEntity` / `breadcrumb` are searched.
	const PAGE_TYPES = [
		'WebPage',
		'ItemPage',
		'CollectionPage',
		'SearchResultsPage',
		'ProfilePage',
		'AboutPage',
		'ContactPage',
		'FAQPage',
		'QAPage',
		'CheckoutPage',
		'MedicalWebPage',
		'RealEstateListing',
		'MediaGallery',
		'ImageGallery',
		'VideoGallery',
	];
	const PRODUCT_TYPES = ['Product', 'ProductGroup'];

	// A node at the top of a block (or of its @graph) always wins; one found a single level down — a
	// page node's `mainEntity` / `mainEntityOfPage` / `breadcrumb` — is used only when no top-level node
	// matched. One level only: this reads what a page states about itself, it does not crawl a graph.
	let productNode: Json | null = null;
	let breadcrumbNode: Json | null = null;
	let nestedProduct: Json | null = null;
	let nestedBreadcrumb: Json | null = null;
	const blocks = document.querySelectorAll('script[type="application/ld+json"]');
	for (let i = 0; i < blocks.length && !(productNode && breadcrumbNode); i++) {
		let data: unknown;
		try {
			data = JSON.parse(blocks[i].textContent || '');
		} catch {
			continue; // one malformed block must not cost the page its other blocks
		}
		const graph = isObject(data) ? data['@graph'] : undefined;
		const nodes = Array.isArray(data) ? data : Array.isArray(graph) ? graph : [data];
		for (const node of nodes) {
			if (!isObject(node)) continue;
			if (!productNode && hasType(node, PRODUCT_TYPES)) productNode = node;
			if (!breadcrumbNode && hasType(node, ['BreadcrumbList'])) breadcrumbNode = node;
			if (!hasType(node, PAGE_TYPES)) continue;
			if (!nestedProduct) {
				for (const entity of listOf(node.mainEntity)) {
					if (isObject(entity) && hasType(entity, PRODUCT_TYPES)) {
						nestedProduct = entity;
						break;
					}
				}
			}
			const ofPage = node.mainEntityOfPage;
			if (!nestedProduct && isObject(ofPage) && hasType(ofPage, PRODUCT_TYPES)) nestedProduct = ofPage;
			const crumb = node.breadcrumb;
			if (!nestedBreadcrumb && isObject(crumb) && hasType(crumb, ['BreadcrumbList'])) nestedBreadcrumb = crumb;
		}
	}
	productNode = productNode ?? nestedProduct;
	breadcrumbNode = breadcrumbNode ?? nestedBreadcrumb;

	// A JSON number is stated as its string form ("35.99", "12345"), as structuredOffers states a price.
	const asString = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : value);
	const absent = (value: unknown) => value === undefined || value === null || value === '';
	const nonEmpty = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);

	// The offer objects a node states, in document order — an AggregateOffer summarises
	// (lowPrice/highPrice), so only the offers it lists are offers. null when past the bound.
	const offersOf = (raw: unknown): Json[] | null => {
		const found: Json[] = [];
		for (const entry of listOf(raw)) {
			const list = isObject(entry) && hasType(entry, ['AggregateOffer']) ? listOf(entry.offers) : [entry];
			for (const offer of list) {
				if (!isObject(offer)) continue;
				if (found.length >= bounds.maxOffers) return null;
				found.push(offer);
			}
		}
		return found;
	};
	const tuple = (offer: Json, sku: unknown): PageFactOffer => {
		// Reduced exactly as extractStructuredOffers reduces it: the last non-empty path segment, so a
		// trailing slash (https://schema.org/InStock/) still yields the verdict.
		const availability =
			typeof offer.availability === 'string' ? (offer.availability.split('/').filter(Boolean).pop() ?? '') : null;
		return [
			offerField(asString(sku)),
			offerField(asString(offer.price)),
			offerField(offer.priceCurrency),
			offerField(availability),
		];
	};

	const readOffers = (node: Json, variants: Json[]): PageFactOffer[] | null => {
		const own = offersOf(node.offers);
		if (own === null) return null; // refused — never fall through to the variants
		if (own.length) {
			// A product selling ONE offer often names the SKU on itself rather than on the offer. Only
			// then: with several offers, the product's SKU names none of them.
			const inherit = own.length === 1 && absent(own[0].sku);
			return own.map((offer) => tuple(offer, inherit ? node.sku : offer.sku));
		}
		// A ProductGroup usually sells through its variants (`hasVariant`, each a Product with its own
		// offers and SKU) — read those when the group itself states no offers.
		const out: PageFactOffer[] = [];
		for (const variant of variants) {
			const offers = offersOf(variant.offers);
			if (offers === null) return null;
			for (const offer of offers) {
				if (out.length >= bounds.maxOffers) return null;
				out.push(tuple(offer, absent(offer.sku) ? variant.sku : offer.sku));
			}
		}
		return out.length ? out : null;
	};

	// Each field is PICKED raw — from the node, else (for a ProductGroup) its first variant — and only
	// then bounded, so a value the group states too long is refused rather than swapped for a variant's.
	const pickBrand = (n: Json) => nonEmpty(isObject(n.brand) ? n.brand.name : n.brand);
	const pickImage = (n: Json) => {
		const image = Array.isArray(n.image) ? n.image[0] : n.image;
		return nonEmpty(isObject(image) ? image.url : image);
	};
	const pickRating = (n: Json): [number | null, number | null] | undefined => {
		const r = n.aggregateRating;
		if (!isObject(r)) return undefined;
		const pair: [number | null, number | null] = [num(r.ratingValue), num(r.ratingCount ?? r.reviewCount)];
		return pair[0] !== null || pair[1] !== null ? pair : undefined;
	};

	const readProduct = (node: Json): PageFactsProduct => {
		const variants = hasType(node, ['ProductGroup']) ? listOf(node.hasVariant).filter(isObject) : [];
		const pick = <T>(from: (n: Json) => T | undefined): T | undefined =>
			from(node) ?? (variants.length ? from(variants[0]) : undefined);
		return {
			name: str(pick((n) => nonEmpty(n.name))),
			brand: str(pick(pickBrand)),
			image: str(pick(pickImage)),
			rating: pick(pickRating) ?? null,
			offers: readOffers(node, variants),
		};
	};

	const readBreadcrumbs = (node: Json): string[] | null => {
		const crumbs: Array<{ name: string; position: number | null; order: number }> = [];
		const elements = listOf(node.itemListElement);
		for (let order = 0; order < elements.length; order++) {
			const el = elements[order];
			if (!isObject(el)) continue;
			const itemName = isObject(el.item) ? el.item.name : undefined;
			const raw = typeof itemName === 'string' && itemName !== '' ? itemName : el.name;
			if (typeof raw !== 'string' || raw === '') continue; // an unnamed crumb claims nothing
			// A name past the bound refuses the whole trail: a trail with a hole in it would disagree.
			if (raw.length > bounds.maxString) return null;
			if (crumbs.length >= bounds.maxBreadcrumbs) return null;
			crumbs.push({ name: raw, position: num(el.position), order });
		}
		// Ordered by position; a crumb without one keeps its document order after the positioned ones.
		crumbs.sort((a, b) =>
			a.position === b.position
				? a.order - b.order
				: a.position === null
					? 1
					: b.position === null
						? -1
						: a.position - b.position
		);
		return crumbs.length ? crumbs.map((c) => c.name) : null;
	};

	return {
		canonical: canonicalEl ? str(canonicalEl.href) : null,
		title: str((document.title || '').trim()),
		metaDescription: descriptionEl ? str(descriptionEl.getAttribute('content')) : null,
		h1: h1El ? str((h1El.textContent || '').replace(/\s+/g, ' ').trim()) : null,
		product: productNode ? readProduct(productNode) : null,
		breadcrumbs: breadcrumbNode ? readBreadcrumbs(breadcrumbNode) : null,
	};
}
