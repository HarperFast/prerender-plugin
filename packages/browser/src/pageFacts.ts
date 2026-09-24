/**
 * What the rendered page itself CLAIMS — its schema.org offers (`structuredOffers`) and its SEO facts
 * (canonical, title, meta description, first heading, product JSON-LD and breadcrumb trail) — read off
 * the settled DOM and posted with each variant.
 *
 * WHY THE RENDERER. The consumer compares these against its own sources of truth to decide whether a
 * cached page is wrong (and only then re-render it). It deliberately never parses HTML on its hot
 * write path, so every fact it compares has to arrive already extracted. Here it is one
 * `page.evaluate` against a DOM that is already parsed and already settled.
 *
 * BOUNDS ARE REFUSALS, NEVER TRUNCATIONS. A truncated value would disagree with the consumer's source
 * of truth on every comparison, and a systematic disagreement means the consumer expires and
 * re-renders that page forever. So a value past its bound is reported as no claim at all (`null`),
 * which degrades to exactly what "the page does not say" does: nothing to compare. (`structuredOffers`
 * predates this rule for its fields: it refuses past its offer cap but slices an over-long field to 64
 * characters. Changing that would change every value the consumer already stores, so it stays.)
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

// Refusal threshold, not a sample size: a variant-heavy PDP legitimately carries dozens of offer
// triples, but past this the page posts NO claim rather than a truncated one (see
// `extractPageClaims` — a deterministic sample can systematically disagree with the consumer's
// endpoint).
export const STRUCTURED_OFFER_CAP = 200;

/**
 * Both claims, as one in-page extraction returns them. Each is `null` when its reader found nothing to
 * claim or threw — independently: a throw in one reader never costs the other its value.
 */
export type PageClaims = {
	/** See `RenderJob.structuredOffers`: sorted `[price, currency, availability]` triples, flattened. */
	structuredOffers: Array<string | null> | null;
	pageFacts: PageFacts | null;
};

/**
 * Read both of the page's claims off the live DOM in ONE `page.evaluate`. Runs IN THE PAGE, so it is
 * fully self-contained: no imports, no closure over module scope, every helper declared inside.
 *
 * ONE ROUND TRIP, ONE PARSE. The two readers search the same `<script type="application/ld+json">`
 * blocks, in document order, reading a top-level array or an `@graph` as a list of nodes. Each block is
 * queried once and parsed at most once — on the first reader's demand, never past the furthest block
 * either reader needs — and a block that does not parse is skipped without costing the others. The
 * parsed values are shared, which is invisible to both: neither reader writes to a parsed node, and each
 * builds its output from fresh arrays and primitives.
 *
 * INDEPENDENT. Each reader runs in its own try/catch, so a throw in one reports THAT claim as null and
 * costs the other nothing — what two separate evaluates gave. A failure of the evaluate itself (a
 * destroyed context, an unserializable result) is past any in-page catch; the caller posts null for
 * both, never a failed render.
 *
 * `structuredOffers`: every schema.org Product's offers, flattened to [price, currency, availability]
 * triples and sorted so the sequence is stable across renders of unchanged content. null when the page
 * declares no Product offers, so "no structured data" stays distinguishable from "no offers". A page
 * carrying MORE offers than `offerCap` is null too — no claim, never a truncated one. A deterministic
 * sample that happens to omit the offer the consumer's endpoint reports would disagree with it on every
 * comparison, and a systematic disagreement means the consumer expires and re-renders that page
 * forever. "Too many offers to read confidently" degrades to exactly what "no offers" does: nothing.
 *
 * `pageFacts`: see {@link PageFacts}. When no top-level node matches, one level under a page node
 * (WebPage or a subtype) is searched too: its `mainEntity` / `mainEntityOfPage` for the product, its
 * `breadcrumb` for the trail.
 */
export function extractPageClaims(offerCap: number, bounds: PageFactBounds): PageClaims {
	// The page's JSON-LD blocks, queried on first use and each parsed at most once. Both readers walk
	// them in order from the first, so the cache only ever grows at its end.
	const MALFORMED = {};
	let scripts: NodeListOf<Element> | null = null;
	const parsed: unknown[] = [];
	const blockCount = (): number => {
		if (!scripts) scripts = document.querySelectorAll('script[type="application/ld+json"]');
		return scripts.length;
	};
	/** Block `i`'s JSON, or MALFORMED. Only called below `blockCount()`. */
	const block = (i: number): unknown => {
		while (parsed.length <= i) {
			let data: unknown;
			try {
				data = JSON.parse((scripts as NodeListOf<Element>)[parsed.length].textContent || '');
			} catch {
				data = MALFORMED; // one malformed block must not cost the page its other blocks
			}
			parsed.push(data);
		}
		return parsed[i];
	};

	const readStructuredOffers = (cap: number): Array<string | null> | null => {
		const triples: Array<Array<string | null>> = [];
		let overflowed = false;
		// Field-level byte bound: the cap bounds triple COUNT, so without this a single pathological
		// field (a megabyte "price" string) would still inflate every posted result for the page. No
		// legitimate price, currency code, or availability token approaches 64 characters.
		const bound = (value: string): string | null => (value === '' ? null : value.slice(0, 64));
		const collect = (node: unknown) => {
			if (overflowed || !node || typeof node !== 'object') return;
			const record = node as Record<string, unknown>;
			const type = record['@type'];
			const isProduct = type === 'Product' || (Array.isArray(type) && type.includes('Product'));
			if (!isProduct) return;
			const raw = record.offers;
			const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
			for (const entry of list) {
				if (!entry || typeof entry !== 'object') continue;
				if (triples.length >= cap) {
					overflowed = true;
					return;
				}
				const offer = entry as Record<string, unknown>;
				// filter(Boolean) before pop: a trailing slash (https://schema.org/InStock/) would
				// otherwise pop the empty segment and read as no availability at all.
				const availability =
					typeof offer.availability === 'string'
						? bound(offer.availability.split('/').filter(Boolean).pop() ?? '')
						: null;
				const price = offer.price === undefined || offer.price === null ? null : bound(String(offer.price));
				const currency = typeof offer.priceCurrency === 'string' ? bound(offer.priceCurrency) : null;
				triples.push([price, currency, availability]);
			}
		};
		for (let i = 0; i < blockCount() && !overflowed; i++) {
			const data = block(i);
			if (data === MALFORMED) continue;
			const graph = (data as Record<string, unknown>)?.['@graph'];
			const nodes = Array.isArray(data) ? data : Array.isArray(graph) ? graph : [data];
			for (const node of nodes) {
				if (overflowed) break;
				collect(node);
			}
		}
		if (overflowed || !triples.length) return null;
		// Field-wise, not JSON.stringify per comparison: sorting is O(n log n) COMPARISONS, so
		// stringifying inside the comparator serialises every triple many times over. Code-unit
		// comparison, not localeCompare: the whole point of the sort is a sequence that is identical
		// across renders, and collation varies with the browser's locale/ICU.
		triples.sort((a, b) => {
			for (let i = 0; i < 3; i++) {
				const x = a[i];
				const y = b[i];
				if (x === y) continue;
				if (x === null) return -1;
				if (y === null) return 1;
				return x < y ? -1 : 1;
			}
			return 0;
		});
		return triples.flat();
	};

	const readPageFacts = (): PageFacts => {
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
		for (let i = 0; i < blockCount() && !(productNode && breadcrumbNode); i++) {
			const data = block(i);
			if (data === MALFORMED) continue;
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
			// Reduced exactly as readStructuredOffers reduces it: the last non-empty path segment, so a
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
	};

	let structuredOffers: Array<string | null> | null = null;
	try {
		structuredOffers = readStructuredOffers(offerCap);
	} catch {
		// This reader alone reports no claim; the other still runs.
	}
	let pageFacts: PageFacts | null = null;
	try {
		pageFacts = readPageFacts();
	} catch {
		// Likewise.
	}
	return { structuredOffers, pageFacts };
}
