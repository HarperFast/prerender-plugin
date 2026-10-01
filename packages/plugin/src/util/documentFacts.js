/**
 * DOCUMENT FACTS: the page-facts contract (`PageFacts`, @harperfast/prerender-browser pageFacts.ts)
 * read straight off an ORIGIN document's bytes — no DOM, no whole-document string, and in the
 * default `head` scope nothing read past `</head>`.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────
 *
 * Every origin-proxied request already carries the origin's answer for that URL, right now, through
 * this process. Reading the facts a cached page is compared on (canonical, title, meta description,
 * the Product and BreadcrumbList JSON-LD) out of THAT document makes the request a change probe the
 * origin has already paid for. The same applies to a stored raw document (util/rawCache.js), which a
 * background reader can scan without asking the origin anything.
 *
 * ── WHY IT IS SHAPED LIKE THIS (measured: 24 sitemap PDPs from one production origin, Node 24) ─
 *
 *   - Every fact this reads sits in `<head>`: title at 0.0%, meta description 0.1%, canonical 0.5%,
 *     Product JSON-LD 3.7%, BreadcrumbList 4.3% of the document; `</head>` at 8.0% (~20 KB of a
 *     ~240 KB document). The first `<h1>` is at 62% — behind ~290 KB of island hydration props — and
 *     on that origin it is byte-for-byte the Product name, which the head already carries. So the
 *     default scope stops at the head and reports `h1: null` (no claim). It stops EARLIER still, as
 *     soon as all five head facts are in hand: ~10 KB in, ~4 KB of the gzip.
 *   - Decoding the whole document to a string is the expensive way, and the cost lands on everything
 *     else on the thread: those documents decode to TWO-BYTE strings (one non-Latin-1 character
 *     anywhere does it), so a 280 KB body is ~560 KB of heap before a regex runs — 23 ms of GC per
 *     1,000 documents with pauses to 7 ms, against 0.6-1.7 ms and 0.1-1.4 ms here. Only the fact
 *     slices — a few KB — are ever decoded.
 *   - Tags are found with `Buffer#indexOf` (memchr) and compared byte-wise, case-folded with `| 0x20`.
 *     A quoted attribute value is skipped with one `indexOf` for its closing quote, so a huge one
 *     costs a memchr, not a JS loop. No regex runs over the document. 12 µs p50 / 33 µs p99 per
 *     identity document, vs 90 / 431 µs for decode + regex and 1.6 / 3.3 ms for htmlparser2.
 *   - A compressed body is inflated only as far as the scan needs: a PREFIX of the compressed bytes
 *     (`finishFlush: Z_SYNC_FLUSH` makes zlib return everything a truncated input decodes to),
 *     doubled until the scan is done. Re-inflating from the start each round bounds the waste at 2x
 *     of the ideal. 35-40 µs p50 / <82 µs p99 with the first round at 6-8 KB, vs 170 µs to gunzip
 *     the whole document before reading a byte of it.
 *   - SYNCHRONOUS, ON PURPOSE. The async alternatives were measured and do not spare the event loop:
 *     a zlib stream (threadpool) or a DecompressionStream spent 67-79 µs of main-thread time per
 *     document on callbacks and stream plumbing — more than the whole synchronous scan — and the zlib
 *     one also takes a threadpool slot from the blob reads the serve path makes on the same pool. A
 *     ~40 µs slice is the least intrusive shape there is; a background caller should run one document
 *     per macrotask (yield with `setImmediate` between documents) and pace itself, not batch.
 *
 * ── THE EXACTNESS RULE ───────────────────────────────────────────────────────────────────────
 *
 * A fact this reports is EXACTLY what the renderer's `extractPageClaims` would read from the same
 * bytes, or it is null. Never a near miss: a stored page record is compared with these facts, and a
 * systematic near miss disagrees on every comparison, which means re-rendering that page forever.
 * So everything that cannot be read exactly is null:
 *
 *   - a character reference this decoder does not know (it knows the numeric forms and the handful
 *     of named ones real heads use — an unknown one is never guessed at);
 *   - non-ASCII text when the document's charset is unknown, or any text when it is not UTF-8;
 *   - in `head` scope, the "first" of something that was not found before the scan stopped (a later
 *     one might exist), and the renderer's ONE-LEVEL-DOWN JSON-LD fallbacks (a page node's
 *     `mainEntity` / `breadcrumb`), which it uses only when NO block in the whole document has a
 *     top-level match — unknowable without reading the whole document;
 *   - a relative canonical when the head was not read to its end (a `<base>` could still change it).
 *
 * What it does NOT see is JavaScript: the renderer reads a settled, hydrated DOM, this reads the
 * server's HTML. They agree exactly when the facts are server-rendered and hydration leaves them
 * alone, which is a property of the site, not of this code — measure it before relying on it.
 *
 * DEPENDENCY-FREE apart from node:zlib, and a pure function of its input.
 */

import zlib from 'node:zlib';
import { canonicalPageFacts, PAGE_FACTS_MAX_BYTES } from './changeProbeSpec.js';

/**
 * Bounds — MUST equal the renderer's `PAGE_FACT_BOUNDS` (packages/browser/src/pageFacts.ts), or a
 * value one side refuses the other reports, and the two never compare equal.
 */
export const DOCUMENT_FACT_BOUNDS = Object.freeze({
	maxString: 2048,
	maxOffers: 200,
	maxBreadcrumbs: 30,
	maxOfferField: 64,
});

/** Decoded bytes a scan will read before giving up (`outcome: 'truncated'`). */
export const DEFAULT_MAX_SCAN_BYTES = 512 * 1024;

/**
 * Compressed bytes the first inflate round is given; each further round doubles it. Measured, every
 * head fact was reached within 3.75-4.2 KB of a level-6 gzip: 8 KB is one round for those with room
 * for a heavier head, while 16 KB cost twice as much (it inflates ~56 KB to use ~10 KB).
 */
export const FIRST_INFLATE_PREFIX = 8 * 1024;

const LT = 0x3c;
const GT = 0x3e;
const SLASH = 0x2f;
const BANG = 0x21;
const QMARK = 0x3f;
const DASH = 0x2d;
const EQ = 0x3d;
const DQ = 0x22;
const SQ = 0x27;

const COMMENT_END = Buffer.from('-->');
const END_TAG_OPEN = Buffer.from('</');

const isSpace = (b) => b === 0x20 || b === 0x0a || b === 0x09 || b === 0x0c || b === 0x0d;
const isAlpha = (b) => (b | 0x20) >= 0x61 && (b | 0x20) <= 0x7a;

/** Do the bytes at [s, e) spell `lower` (an ASCII-lowercase literal), ASCII case-insensitively? */
const bytesEqualLower = (buf, s, e, lower) => {
	if (e - s !== lower.length) return false;
	for (let i = 0; i < lower.length; i++) {
		const b = buf[s + i];
		if ((isAlpha(b) ? b | 0x20 : b) !== lower.charCodeAt(i)) return false;
	}
	return true;
};

// Tag kinds the scanner acts on. Everything else is skipped by its start tag alone.
const K_OTHER = 0;
const K_TITLE = 1;
const K_LINK = 2;
const K_META = 3;
const K_SCRIPT = 4;
const K_BASE = 5;
const K_BODY = 6;
const K_HEAD = 7;
const K_RAWTEXT = 8; // contents are not markup: style, noscript (scripting on), template, textarea, …
const K_FOREIGN = 9; // svg, math: their <title> and <style> are foreign elements, not the HTML ones

/** The tag kind for the name at [s, e). Switch on length first: most names are rejected on it. */
const kindOf = (buf, s, e) => {
	switch (e - s) {
		case 3:
			if (bytesEqualLower(buf, s, e, 'xmp')) return K_RAWTEXT;
			if (bytesEqualLower(buf, s, e, 'svg')) return K_FOREIGN;
			return K_OTHER;
		case 4:
			if (bytesEqualLower(buf, s, e, 'link')) return K_LINK;
			if (bytesEqualLower(buf, s, e, 'math')) return K_FOREIGN;
			if (bytesEqualLower(buf, s, e, 'meta')) return K_META;
			if (bytesEqualLower(buf, s, e, 'base')) return K_BASE;
			if (bytesEqualLower(buf, s, e, 'body')) return K_BODY;
			if (bytesEqualLower(buf, s, e, 'head')) return K_HEAD;
			return K_OTHER;
		case 5:
			if (bytesEqualLower(buf, s, e, 'title')) return K_TITLE;
			if (bytesEqualLower(buf, s, e, 'style')) return K_RAWTEXT;
			return K_OTHER;
		case 6:
			if (bytesEqualLower(buf, s, e, 'script')) return K_SCRIPT;
			if (bytesEqualLower(buf, s, e, 'iframe')) return K_RAWTEXT;
			return K_OTHER;
		case 7:
			return bytesEqualLower(buf, s, e, 'noembed') ? K_RAWTEXT : K_OTHER;
		case 8:
			// noscript is raw text because the renderer runs with scripting ON; template contents are
			// not in the document tree, so the renderer's selectors never see inside one either.
			return bytesEqualLower(buf, s, e, 'noscript') ||
				bytesEqualLower(buf, s, e, 'template') ||
				bytesEqualLower(buf, s, e, 'textarea') ||
				bytesEqualLower(buf, s, e, 'noframes')
				? K_RAWTEXT
				: K_OTHER;
		default:
			return K_OTHER;
	}
};

/** One start tag's attributes of interest, as byte ranges. Reused across tags: no allocation per tag. */
const attrs = {
	relS: -1,
	relE: -1,
	hrefS: -1,
	hrefE: -1,
	nameS: -1,
	nameE: -1,
	contentS: -1,
	contentE: -1,
	typeS: -1,
	typeE: -1,
	charsetS: -1,
	charsetE: -1,
	httpEquivS: -1,
	httpEquivE: -1,
};
const resetAttrs = () => {
	attrs.relS = attrs.hrefS = attrs.nameS = attrs.contentS = attrs.typeS = attrs.charsetS = attrs.httpEquivS = -1;
};

/** Record [vs, ve) as the value of the attribute named [ns, ne) — FIRST occurrence wins, as in HTML. */
const noteAttr = (buf, ns, ne, vs, ve) => {
	switch (ne - ns) {
		case 3:
			if (attrs.relS < 0 && bytesEqualLower(buf, ns, ne, 'rel')) ((attrs.relS = vs), (attrs.relE = ve));
			return;
		case 4:
			if (attrs.hrefS < 0 && bytesEqualLower(buf, ns, ne, 'href')) ((attrs.hrefS = vs), (attrs.hrefE = ve));
			else if (attrs.nameS < 0 && bytesEqualLower(buf, ns, ne, 'name')) ((attrs.nameS = vs), (attrs.nameE = ve));
			else if (attrs.typeS < 0 && bytesEqualLower(buf, ns, ne, 'type')) ((attrs.typeS = vs), (attrs.typeE = ve));
			return;
		case 7:
			if (attrs.contentS < 0 && bytesEqualLower(buf, ns, ne, 'content')) ((attrs.contentS = vs), (attrs.contentE = ve));
			else if (attrs.charsetS < 0 && bytesEqualLower(buf, ns, ne, 'charset'))
				((attrs.charsetS = vs), (attrs.charsetE = ve));
			return;
		case 10:
			if (attrs.httpEquivS < 0 && bytesEqualLower(buf, ns, ne, 'http-equiv'))
				((attrs.httpEquivS = vs), (attrs.httpEquivE = ve));
	}
};

/**
 * Read a start tag's attributes from `i` (just past its name) to its `>`. Returns the index after
 * the `>`, or -1 when the tag does not end inside [i, end). Attribute syntax per the HTML tokenizer:
 * a quote only opens a value right after `=`, and a quoted value is skipped with one `indexOf`.
 * With `collect` false the attributes are skipped without being recorded.
 */
const readStartTag = (buf, i, end, collect) => {
	if (collect) resetAttrs();
	while (i < end) {
		let b = buf[i];
		if (isSpace(b) || b === SLASH) {
			i++;
			continue;
		}
		if (b === GT) return i + 1;
		// An attribute name: up to whitespace, '/', '>' or '='. (A name may start with '='.)
		const ns = i;
		i++;
		while (i < end && !isSpace((b = buf[i])) && b !== SLASH && b !== GT && b !== EQ) i++;
		const ne = i;
		while (i < end && isSpace(buf[i])) i++;
		if (i >= end) return -1;
		if (buf[i] !== EQ) {
			if (collect) noteAttr(buf, ns, ne, ne, ne); // a valueless attribute: present, empty
			continue;
		}
		i++;
		while (i < end && isSpace(buf[i])) i++;
		if (i >= end) return -1;
		b = buf[i];
		let vs;
		let ve;
		if (b === DQ || b === SQ) {
			vs = i + 1;
			ve = buf.indexOf(b, vs);
			if (ve < 0 || ve >= end) return -1;
			i = ve + 1;
		} else {
			vs = i;
			while (i < end && !isSpace((b = buf[i])) && b !== GT) i++;
			if (i >= end) return -1;
			ve = i;
		}
		if (collect) noteAttr(buf, ns, ne, vs, ve);
	}
	return -1;
};

/**
 * Index of the `</name` that ends a raw-text / RCDATA element whose contents start at `i`, or -1
 * when it is not inside [i, end). The end tag's name must be followed by whitespace, `/` or `>`
 * (`</scripts` does not end a script). Known gap, failing safe: the script-data "escaped" states
 * (`<!--` + `<script` inside a script) are not modelled, so such a script ends early — its JSON then
 * fails to parse and the block claims nothing.
 */
const findEndTag = (buf, i, end, lower) => {
	for (;;) {
		const k = buf.indexOf(END_TAG_OPEN, i);
		if (k < 0 || k + 2 + lower.length >= end) return -1;
		const after = buf[k + 2 + lower.length];
		if (
			bytesEqualLower(buf, k + 2, k + 2 + lower.length, lower) &&
			(isSpace(after) || after === SLASH || after === GT)
		) {
			return k;
		}
		i = k + 2;
	}
};

const isAsciiRange = (buf, s, e) => {
	for (let i = s; i < e; i++) if (buf[i] > 0x7f) return false;
	return true;
};

// Named character references this decoder is EXACT for. Anything else named is refused (null).
const NAMED = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	copy: '©',
	reg: '®',
	trade: '™',
	hellip: '…',
	mdash: '—',
	ndash: '–',
	rsquo: '’',
	lsquo: '‘',
	rdquo: '”',
	ldquo: '“',
};
// The legacy names HTML also decodes WITHOUT a semicolon, and ones it would match by prefix. An
// `&` followed by one of these but no `;` is ambiguous here (it depends on context), so it refuses.
const LEGACY_PREFIX =
	/^(amp|lt|gt|quot|nbsp|copy|reg|[a-z]{2,8}acute|[a-z]{2,8}grave|[a-z]{2,8}uml|[a-z]{2,8}circ|[a-z]{2,8}tilde|[a-z]{2,8}cedil|[a-z]{2,8}ring|[a-z]{2,8}slash|shy|deg|micro|middot|para|sect|times|divide|frac\d\d|sup\d|ordf|ordm|pound|yen|cent|curren|brvbar|laquo|raquo|not|macr|plusmn|acute|iexcl|iquest|aelig|eth|thorn|szlig)/i;

/**
 * HTML character references in `s` decoded, or null when one cannot be decoded EXACTLY. Numeric
 * references follow the spec's replacements for 0, surrogates and out-of-range values only as far
 * as returning null for them; the windows-1252 remap of &#128;-&#159; is likewise refused.
 */
const decodeReferences = (s) => {
	if (s.indexOf('&') < 0) return s;
	let out = '';
	let last = 0;
	for (let i = s.indexOf('&'); i >= 0; i = s.indexOf('&', i + 1)) {
		const semi = s.indexOf(';', i + 1);
		const body = semi > i + 1 && semi - i <= 33 ? s.slice(i + 1, semi) : null;
		let ch = null;
		// A numeric reference without its semicolon is still decoded by HTML: ambiguous here, refused.
		if (body === null && s.charCodeAt(i + 1) === 0x23) return null;
		if (body !== null && body.charCodeAt(0) === 0x23) {
			const hex = body.charCodeAt(1) === 0x78 || body.charCodeAt(1) === 0x58;
			const digits = body.slice(hex ? 2 : 1);
			if (!(hex ? /^[0-9a-fA-F]{1,6}$/ : /^[0-9]{1,7}$/).test(digits)) return null;
			const cp = parseInt(digits, hex ? 16 : 10);
			if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) || (cp >= 0x80 && cp <= 0x9f)) return null;
			ch = String.fromCodePoint(cp);
		} else if (body !== null && /^[a-zA-Z][a-zA-Z0-9]*$/.test(body)) {
			ch = Object.hasOwn(NAMED, body) ? NAMED[body] : null;
			if (ch === null) return null;
		} else {
			// No well-formed reference here: '&' is literal unless what follows could be a legacy name.
			if (LEGACY_PREFIX.test(s.slice(i + 1, i + 9))) return null;
			continue;
		}
		out += s.slice(last, i) + ch;
		last = semi + 1;
		i = semi;
	}
	return out + s.slice(last);
};

/**
 * A scanner over a document's DECODED bytes. Feed it with `push(chunk)` (returns true while it wants
 * more) and read the result with `finish()`. Chunks may split anything — a tag, a quoted value, a
 * JSON-LD block — at any byte; bytes are accumulated in one geometrically grown buffer, so each input
 * byte is copied at most ~twice, and a single `push` of a whole document copies nothing at all.
 *
 * Options: `url` (the document's URL, for resolving the canonical — required for a relative one),
 * `scope` ('head' | 'document'), `maxBytes` (decoded bytes to read before giving up), `charset` (from
 * the response's content-type, if it named one), `want` (see below).
 *
 * `want` — THE FACTS THE CALLER WILL COMPARE, and the scan's stopping rule: it stops as soon as every
 * wanted fact has been found, and reports every other fact as null. It is what makes a page type
 * without some of the facts cheap: measured, a template with no JSON-LD at all and ~750 KB of inline CSS
 * in its head states title, canonical and description in its first ~1 KB of gzip — but a scan that
 * keeps looking for a Product reads through all of that CSS (~360 KB of gzip, ~1.9 ms) to `</head>`.
 * Default: every head fact. Leaving `product` and `breadcrumbs` out also skips every JSON parse.
 */
export const createDocumentFactsScanner = ({
	url = null,
	scope = 'head',
	maxBytes = DEFAULT_MAX_SCAN_BYTES,
	charset = null,
	want = HEAD_FACTS,
} = {}) => {
	const headOnly = scope !== 'document';
	const wanted = wantedFacts(want);
	let acc = null; // the accumulated bytes, when input arrived in more than one chunk
	let accLen = 0;
	let pos = 0; // first byte not yet consumed by the tokenizer
	let total = 0;
	let consumed = 0; // bytes the tokenizer read before it stopped (or all of them)
	let done = false;
	let outcome = null;
	let reachedHeadEnd = false;

	let charsetKnown = charsetLabel(charset);
	let title = null;
	let titleSeen = false;
	let canonicalRaw = null;
	let canonicalSeen = false;
	let baseRaw = null;
	let description = null;
	let descriptionSeen = false;
	let productNode = null;
	let breadcrumbNode = null;
	let itemListNode = null;
	let nestedProduct = null;
	let nestedBreadcrumb = null;
	let blocks = 0;
	// Open <svg>/<math> elements. Inside one, nothing is read: an SVG <title> is not the document's.
	let foreignDepth = 0;

	// A slice as a string, or null when its bytes cannot be decoded exactly (see the exactness rule).
	// CR and CRLF become LF, as the HTML input stream does before the tokenizer sees anything.
	const text = (buf, s, e) => {
		let out;
		if (charsetKnown === 'utf-8') out = buf.toString('utf8', s, e);
		else if (charsetKnown === null && isAsciiRange(buf, s, e)) out = buf.latin1Slice(s, e);
		else return null;
		return out.indexOf('\r') < 0 ? out : out.replace(/\r\n?/g, '\n');
	};

	const jsonBlock = (buf, s, e) => {
		blocks++;
		const raw = text(buf, s, e);
		if (raw === null) return;
		let data;
		try {
			data = JSON.parse(raw);
		} catch {
			return; // one malformed block must not cost the others
		}
		const graph = isObject(data) ? data['@graph'] : undefined;
		const nodes = Array.isArray(data) ? data : Array.isArray(graph) ? graph : [data];
		for (const node of nodes) {
			if (!isObject(node)) continue;
			if (!productNode && hasType(node, PRODUCT_TYPES)) productNode = node;
			if (!breadcrumbNode && hasType(node, BREADCRUMB_TYPES)) breadcrumbNode = node;
			if (wanted.itemList && !itemListNode) itemListNode = itemListIn(node);
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
			if (!nestedBreadcrumb && isObject(crumb) && hasType(crumb, BREADCRUMB_TYPES)) nestedBreadcrumb = crumb;
		}
	};

	// Every wanted fact has been found: stop without reading to `</head>`.
	const satisfied = () =>
		(!wanted.title || titleSeen) &&
		(!wanted.canonical || canonicalSeen) &&
		(!wanted.metaDescription || descriptionSeen) &&
		jsonSatisfied();
	// The JSON-LD the caller wants is in hand — the renderer stops reading blocks at the same point.
	const jsonSatisfied = () =>
		(!wanted.itemList || itemListNode !== null) &&
		(!wanted.product || productNode !== null) &&
		(!wanted.breadcrumbs || breadcrumbNode !== null);

	/**
	 * Tokenize [pos, end). Returns false to stop (done), true when it consumed everything it could;
	 * `pos` is left at the first byte of an incomplete construct.
	 */
	const scan = (buf, end) => {
		let i = pos;
		for (;;) {
			const lt = buf.indexOf(LT, i);
			if (lt < 0 || lt >= end) {
				pos = end;
				return true;
			}
			pos = lt; // from here, anything incomplete resumes at this '<'
			if (lt + 1 >= end) return true;
			const b = buf[lt + 1];
			if (b === BANG) {
				if (lt + 3 >= end) return true;
				if (buf[lt + 2] === DASH && buf[lt + 3] === DASH) {
					// `<!-->` and `<!--->` close at once; otherwise at the first `-->`.
					if (lt + 5 >= end) return true;
					if (buf[lt + 4] === GT) i = lt + 5;
					else if (buf[lt + 4] === DASH && buf[lt + 5] === GT) i = lt + 6;
					else {
						const c = buf.indexOf(COMMENT_END, lt + 4);
						if (c < 0 || c + 3 > end) return true;
						i = c + 3;
					}
				} else {
					const g = buf.indexOf(GT, lt + 2);
					if (g < 0 || g >= end) return true;
					i = g + 1;
				}
				continue;
			}
			if (b === QMARK) {
				const g = buf.indexOf(GT, lt + 2);
				if (g < 0 || g >= end) return true;
				i = g + 1;
				continue;
			}
			if (b === SLASH) {
				if (lt + 2 >= end) return true;
				if (!isAlpha(buf[lt + 2])) {
					// `</>` is dropped; `</` + non-letter is a bogus comment to the next '>'.
					const g = buf.indexOf(GT, lt + 2);
					if (g < 0 || g >= end) return true;
					i = g + 1;
					continue;
				}
				let n = lt + 3;
				while (n < end && !isSpace(buf[n]) && buf[n] !== SLASH && buf[n] !== GT) n++;
				if (n >= end) return true;
				const endKind = kindOf(buf, lt + 2, n);
				if (headOnly && endKind === K_HEAD) {
					reachedHeadEnd = true;
					return false;
				}
				if (endKind === K_FOREIGN && foreignDepth > 0) foreignDepth--;
				const g = buf.indexOf(GT, n);
				if (g < 0 || g >= end) return true;
				i = g + 1;
				continue;
			}
			if (!isAlpha(b)) {
				i = lt + 1; // a literal '<' in text
				continue;
			}
			let n = lt + 2;
			while (n < end && !isSpace(buf[n]) && buf[n] !== SLASH && buf[n] !== GT) n++;
			if (n >= end) return true;
			const kind = kindOf(buf, lt + 1, n);
			if (kind === K_BODY && headOnly) {
				reachedHeadEnd = true; // a body start tag closes the head
				return false;
			}
			const collect =
				foreignDepth === 0 && (kind === K_LINK || kind === K_META || kind === K_SCRIPT || kind === K_BASE);
			const after = readStartTag(buf, n, end, collect);
			if (after < 0) return true;
			if (kind === K_FOREIGN || foreignDepth > 0) {
				// Foreign content is markup all the way down (no raw text), so only the nesting is tracked.
				// An HTML element that would break out of it (`<p>`, `<div>`, …) is not modelled, so a
				// <title> met in here makes the title UNKNOWABLE rather than skipping to a later one.
				if (kind === K_FOREIGN && buf[after - 2] !== SLASH) foreignDepth++;
				else if (kind === K_TITLE && !titleSeen) titleSeen = true; // title stays null
				i = after;
				pos = i;
				continue;
			}
			if (kind === K_TITLE || kind === K_SCRIPT || kind === K_RAWTEXT) {
				const name = kind === K_TITLE ? 'title' : kind === K_SCRIPT ? 'script' : null;
				const close = findEndTag(buf, after, end, name ?? lowerName(buf, lt + 1, n));
				if (close < 0) return true;
				if (kind === K_TITLE && !titleSeen) {
					titleSeen = true;
					title = text(buf, after, close);
				} else if (kind === K_SCRIPT && attrs.typeS >= 0 && isLdJson(buf, attrs.typeS, attrs.typeE)) {
					if (!jsonSatisfied()) jsonBlock(buf, after, close);
				}
				i = close + 2;
			} else {
				if (
					kind === K_LINK &&
					!canonicalSeen &&
					attrs.relS >= 0 &&
					bytesEqualLower(buf, attrs.relS, attrs.relE, 'canonical')
				) {
					canonicalSeen = true;
					// No href attribute: the DOM's `.href` is the empty string, which the renderer reports as null.
					canonicalRaw = attrs.hrefS >= 0 ? text(buf, attrs.hrefS, attrs.hrefE) : null;
				} else if (kind === K_META) {
					if (!descriptionSeen && attrs.nameS >= 0 && bytesEqualLower(buf, attrs.nameS, attrs.nameE, 'description')) {
						descriptionSeen = true;
						description = attrs.contentS >= 0 ? text(buf, attrs.contentS, attrs.contentE) : null;
					}
					if (charsetKnown === null) charsetKnown = metaCharset(buf);
				} else if (kind === K_BASE && baseRaw === null && attrs.hrefS >= 0) {
					baseRaw = text(buf, attrs.hrefS, attrs.hrefE);
				}
				i = after;
			}
			pos = i;
			if (headOnly && satisfied()) return false;
		}
	};

	// The unfinished tail of a chunk that was scanned in place, waiting for the next chunk.
	let carry = null;

	const push = (chunk) => {
		if (done) return false;
		const len = chunk.length;
		total += len;
		let buf;
		if (acc === null && carry === null) {
			// Nothing pending: scan the chunk in place. Copied only if it leaves an unfinished construct.
			buf = chunk;
			pos = 0;
		} else {
			if (acc === null) {
				acc = Buffer.allocUnsafe(Math.max(64 * 1024, 2 * (carry.length + len)));
				accLen = 0;
				pos = 0;
			} else if (pos > 0 && pos >= accLen >> 1) {
				// Compact: everything before `pos` is consumed. Keeps a document-scope scan's memory at
				// the size of its largest unfinished construct, not of the document.
				acc.copyWithin(0, pos, accLen);
				accLen -= pos;
				pos = 0;
			}
			if (carry !== null) {
				acc = ensure(acc, accLen, carry.length);
				carry.copy(acc, accLen);
				accLen += carry.length;
				carry = null;
			}
			acc = ensure(acc, accLen, len);
			chunk.copy(acc, accLen);
			accLen += len;
			// A view ending at the data, so no search can wander into the unwritten capacity.
			buf = acc.subarray(0, accLen);
		}
		const more = scan(buf, buf.length);
		if (!more) {
			done = true;
			outcome = 'ok';
			consumed = total - (buf.length - pos);
			return false;
		}
		if (buf === chunk && pos < len) carry = chunk.subarray(pos); // a view: no copy until the next push
		if (total >= maxBytes) {
			done = true;
			outcome = 'truncated';
			return false;
		}
		return true;
	};

	const finish = () => {
		if (!done) {
			done = true;
			consumed = total;
			// The whole document was read. In document scope that is completion; in head scope a
			// document with no `</head>` and no `<body>` was read entirely too, which is just as complete.
			outcome = 'ok';
			reachedHeadEnd = true;
		}
		const complete = outcome === 'ok' && (!headOnly || reachedHeadEnd);
		const wholeDocument = !headOnly && outcome === 'ok';
		if (charsetKnown !== null && charsetKnown !== 'utf-8') {
			return { facts: null, outcome: 'charset', scannedBytes: consumed || total, blocks };
		}
		const facts = assemble({
			title,
			canonicalRaw,
			baseRaw,
			description,
			productNode: productNode ?? (wholeDocument ? nestedProduct : null),
			breadcrumbNode: breadcrumbNode ?? (wholeDocument ? nestedBreadcrumb : null),
			itemListNode,
			url,
			headComplete: complete,
			wanted,
		});
		return { facts, outcome, scannedBytes: outcome === 'truncated' ? total : consumed, blocks, reachedHeadEnd };
	};

	return { push, finish };
};

/** The facts a head-scoped scan can read, in the order a document usually states them. */
export const HEAD_FACTS = Object.freeze(['title', 'metaDescription', 'canonical', 'product', 'breadcrumbs']);

/**
 * Every fact `want` may name: the head facts, plus `itemList` — NOT part of the renderer's contract, so
 * opt-in only and never in the default. See `readItemList`.
 */
export const DOCUMENT_FACTS = Object.freeze([...HEAD_FACTS, 'itemList']);

/** `want` as flags. An unknown name throws: a misspelt fact would otherwise be silently never read. */
const wantedFacts = (want) => {
	const flags = {
		title: false,
		metaDescription: false,
		canonical: false,
		product: false,
		breadcrumbs: false,
		itemList: false,
	};
	if (!Array.isArray(want) || want.length === 0)
		throw new TypeError('documentFacts: want must be a non-empty array of fact names');
	for (const name of want) {
		if (!Object.hasOwn(flags, name))
			throw new TypeError(`documentFacts: unknown fact "${name}" (one of ${DOCUMENT_FACTS.join(', ')})`);
		flags[name] = true;
	}
	return flags;
};

/** `acc` with room for `extra` more bytes after `used`, grown by doubling (contents kept). */
const ensure = (acc, used, extra) => {
	if (used + extra <= acc.length) return acc;
	const grown = Buffer.allocUnsafe(Math.max(acc.length * 2, used + extra));
	acc.copy(grown, 0, 0, used);
	return grown;
};

const lowerName = (buf, s, e) => buf.latin1Slice(s, e).toLowerCase();

const LD_JSON = 'application/ld+json';
/**
 * `type` EXACTLY application/ld+json, ASCII case-insensitive — the renderer's
 * `script[type="application/ld+json"]`. Not trimmed: the selector does not trim, so a padded value is
 * a block the renderer never reads.
 */
const isLdJson = (buf, s, e) => bytesEqualLower(buf, s, e, LD_JSON);

/** A charset label normalized to what this scanner distinguishes: 'utf-8', another label, or null. */
const charsetLabel = (label) => {
	if (typeof label !== 'string' || label.trim() === '') return null;
	const l = label.trim().toLowerCase();
	return l === 'utf-8' || l === 'utf8' || l === 'unicode-1-1-utf-8' ? 'utf-8' : l;
};

/** The charset a `<meta>` (in `attrs`) declares, or null. */
const metaCharset = (buf) => {
	if (attrs.charsetS >= 0) return charsetLabel(buf.latin1Slice(attrs.charsetS, attrs.charsetE));
	if (
		attrs.httpEquivS >= 0 &&
		attrs.contentS >= 0 &&
		bytesEqualLower(buf, attrs.httpEquivS, attrs.httpEquivE, 'content-type')
	) {
		const m = /charset\s*=\s*["']?([^"';\s]+)/i.exec(buf.latin1Slice(attrs.contentS, attrs.contentE));
		return m ? charsetLabel(m[1]) : null;
	}
	return null;
};

// ---- the JSON-LD reduction: a faithful port of the renderer's readPageFacts --------------------
// Keep in lockstep with packages/browser/src/pageFacts.ts. The parity test runs both on the same
// documents; a divergence here is a perpetual disagreement on every page it touches.

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
const BREADCRUMB_TYPES = ['BreadcrumbList'];

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const hasType = (node, wanted) => {
	const type = node['@type'];
	return Array.isArray(type) ? type.some((t) => wanted.includes(t)) : wanted.includes(type);
};
const listOf = (value) => (Array.isArray(value) ? value : value ? [value] : []);
const boundTo = (max) => (value) => (typeof value !== 'string' || value === '' || value.length > max ? null : value);
const str = boundTo(DOCUMENT_FACT_BOUNDS.maxString);
const offerField = boundTo(DOCUMENT_FACT_BOUNDS.maxOfferField);
const num = (value) => {
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > DOCUMENT_FACT_BOUNDS.maxOfferField) return null;
	const n = Number(trimmed);
	return Number.isFinite(n) ? n : null;
};
const asString = (value) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : value);
const absent = (value) => value === undefined || value === null || value === '';
const nonEmpty = (value) => (typeof value === 'string' && value !== '' ? value : undefined);

const offersOf = (raw) => {
	const found = [];
	for (const entry of listOf(raw)) {
		const list = isObject(entry) && hasType(entry, ['AggregateOffer']) ? listOf(entry.offers) : [entry];
		for (const offer of list) {
			if (!isObject(offer)) continue;
			if (found.length >= DOCUMENT_FACT_BOUNDS.maxOffers) return null;
			found.push(offer);
		}
	}
	return found;
};
/** The last non-empty path segment, so a trailing slash (https://schema.org/InStock/) still reads. */
const availabilityOf = (offer) =>
	typeof offer.availability === 'string' ? (offer.availability.split('/').filter(Boolean).pop() ?? '') : null;
const tuple = (offer, sku) => {
	const availability = availabilityOf(offer);
	return [
		offerField(asString(sku)),
		offerField(asString(offer.price)),
		offerField(offer.priceCurrency),
		offerField(availability),
	];
};
const readOffers = (node, variants) => {
	const own = offersOf(node.offers);
	if (own === null) return null;
	if (own.length) {
		const inherit = own.length === 1 && absent(own[0].sku);
		return own.map((offer) => tuple(offer, inherit ? node.sku : offer.sku));
	}
	const out = [];
	for (const variant of variants) {
		const offers = offersOf(variant.offers);
		if (offers === null) return null;
		for (const offer of offers) {
			if (out.length >= DOCUMENT_FACT_BOUNDS.maxOffers) return null;
			out.push(tuple(offer, absent(offer.sku) ? variant.sku : offer.sku));
		}
	}
	return out.length ? out : null;
};
const pickBrand = (n) => nonEmpty(isObject(n.brand) ? n.brand.name : n.brand);
const pickImage = (n) => {
	const image = Array.isArray(n.image) ? n.image[0] : n.image;
	return nonEmpty(isObject(image) ? image.url : image);
};
const pickRating = (n) => {
	const r = n.aggregateRating;
	if (!isObject(r)) return undefined;
	const pair = [num(r.ratingValue), num(r.ratingCount ?? r.reviewCount)];
	return pair[0] !== null || pair[1] !== null ? pair : undefined;
};
const readProduct = (node) => {
	const variants = hasType(node, ['ProductGroup']) ? listOf(node.hasVariant).filter(isObject) : [];
	const pick = (from) => from(node) ?? (variants.length ? from(variants[0]) : undefined);
	return {
		name: str(pick((n) => nonEmpty(n.name))),
		brand: str(pick(pickBrand)),
		image: str(pick(pickImage)),
		rating: pick(pickRating) ?? null,
		offers: readOffers(node, variants),
	};
};
// ---- itemList: a listing page's products (NOT in the renderer contract) -------------------------

const ITEM_LIST_TYPES = ['ItemList'];

/** The ItemList a node IS, or the one a page node names as its `mainEntity` — one level, as above. */
const itemListIn = (node) => {
	if (hasType(node, ITEM_LIST_TYPES)) return node;
	if (!hasType(node, PAGE_TYPES)) return null;
	for (const entity of listOf(node.mainEntity)) if (isObject(entity) && hasType(entity, ITEM_LIST_TYPES)) return entity;
	return null;
};

/**
 * A listing's products as `[url, price, currency, availability]`, ordered by `position` (document order
 * breaking ties and placing unpositioned entries last, as for breadcrumbs). An entry is a ListItem's
 * `item`, or the element itself. Its offer is read only when there is EXACTLY ONE (an AggregateOffer
 * contributes its list) — a product listing several offers states no single price, so its price slots
 * are null rather than an arbitrary pick. More than `maxOffers` entries refuses the list (null).
 *
 * WHY IT EXISTS, AND WHY IT IS NOT A PAGE FACT. A listing page's structured data carries one merchant
 * listing per product — measured, 3-15 per catalog page, each with a price and an availability — and
 * the renderer's contract reads none of them (`product` is a top-level Product only). So this is for
 * comparing two DOCUMENTS read by this same function (an origin document against a stored one), until
 * the renderer states the same fact. Measured on one origin over 7-22 h: listing membership re-ranked
 * heavily (45 of 196 entries left the lists) while prices on the products still listed moved ~1 in 150
 * and availability not at all — so a caller should compare the KEYED intersection, not the list.
 */
const readItemList = (node) => {
	const elements = listOf(node.itemListElement);
	if (elements.length > DOCUMENT_FACT_BOUNDS.maxOffers) return null;
	const entries = [];
	for (let order = 0; order < elements.length; order++) {
		const el = elements[order];
		if (!isObject(el)) continue;
		const item = isObject(el.item) ? el.item : el;
		const offers = offersOf(item.offers);
		const offer = offers?.length === 1 ? offers[0] : null;
		entries.push({
			value: [
				str(nonEmpty(item.url) ?? nonEmpty(item['@id']) ?? null),
				offer ? offerField(asString(offer.price)) : null,
				offer ? offerField(offer.priceCurrency) : null,
				offer ? offerField(availabilityOf(offer)) : null,
			],
			position: num(el.position),
			order,
		});
	}
	entries.sort((a, b) =>
		a.position === b.position
			? a.order - b.order
			: a.position === null
				? 1
				: b.position === null
					? -1
					: a.position - b.position
	);
	return entries.length ? entries.map((e) => e.value) : null;
};

const readBreadcrumbs = (node) => {
	const crumbs = [];
	const elements = listOf(node.itemListElement);
	for (let order = 0; order < elements.length; order++) {
		const el = elements[order];
		if (!isObject(el)) continue;
		const itemName = isObject(el.item) ? el.item.name : undefined;
		const raw = typeof itemName === 'string' && itemName !== '' ? itemName : el.name;
		if (typeof raw !== 'string' || raw === '') continue;
		if (raw.length > DOCUMENT_FACT_BOUNDS.maxString) return null;
		if (crumbs.length >= DOCUMENT_FACT_BOUNDS.maxBreadcrumbs) return null;
		crumbs.push({ name: raw, position: num(el.position), order });
	}
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

/** `document.title`: ASCII whitespace stripped and collapsed — then the renderer's own `.trim()`. */
const titleOf = (raw) => {
	if (raw === null) return null;
	const decoded = decodeReferences(raw);
	return decoded === null ? null : str(decoded.replace(/[\t\n\f\r ]+/g, ' ').trim());
};

/**
 * `link.href`: the attribute resolved against the document's base URL; the raw value when it does
 * not parse (what the DOM does). Null when that resolution is not knowable exactly — see the module
 * header (a relative href, before the head was read to its end or without the document URL).
 */
const canonicalOf = (raw, baseRaw, url, headComplete) => {
	if (raw === null) return null;
	const href = decodeReferences(raw);
	if (href === null) return null;
	const absolute = URL.parse(href.trim());
	if (absolute) return str(absolute.href);
	if (!headComplete || !url) return null;
	const docUrl = URL.parse(url);
	if (!docUrl) return null;
	const base = baseRaw === null ? docUrl : (URL.parse(decodeReferences(baseRaw)?.trim() ?? '', docUrl) ?? docUrl);
	const resolved = URL.parse(href.trim(), base);
	return str(resolved ? resolved.href : href);
};

const assemble = ({
	title,
	canonicalRaw,
	baseRaw,
	description,
	productNode,
	breadcrumbNode,
	itemListNode,
	url,
	headComplete,
	wanted,
}) => {
	// An unwanted fact is null whether or not the scan happened to pass it, so the result depends only on
	// `want` and the document — never on where the scan stopped.
	const facts = {
		canonical: wanted.canonical ? canonicalOf(canonicalRaw, baseRaw, url, headComplete) : null,
		title: wanted.title ? titleOf(title) : null,
		metaDescription: wanted.metaDescription && description !== null ? str(decodeReferences(description)) : null,
		h1: null, // never read: see the module header
		product: wanted.product && productNode ? readProduct(productNode) : null,
		breadcrumbs: wanted.breadcrumbs && breadcrumbNode ? readBreadcrumbs(breadcrumbNode) : null,
	};
	// Present only when asked for, so a default result keeps exactly the renderer contract's shape.
	if (wanted.itemList) facts.itemList = itemListNode ? readItemList(itemListNode) : null;
	return Object.values(facts).some((v) => v !== null) ? facts : null;
};

// ---- bytes in hand, any encoding ---------------------------------------------------------------

/** Lowercased `content-encoding`, '' for identity. */
const encodingOf = (value) => {
	const e = String(value ?? '')
		.trim()
		.toLowerCase();
	return e === 'identity' ? '' : e;
};

/** `charset` from a content-type header, or null. */
export const charsetOfContentType = (contentType) => {
	const m = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(String(contentType ?? ''));
	return m ? m[1] : null;
};

const inflatePrefix = (encoding, input) => {
	switch (encoding) {
		case 'gzip':
		case 'x-gzip':
			return zlib.gunzipSync(input, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
		case 'deflate':
			return zlib.inflateSync(input, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
		case 'br':
			return zlib.brotliDecompressSync(input, { finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH });
		default:
			return null;
	}
};

/**
 * The facts of a WHOLE body in hand (a stored raw document, a capture): `{ facts, outcome,
 * scannedBytes, inflatedBytes, compressedBytesRead }`. Outcomes: 'ok', 'truncated' (maxBytes reached
 * first), 'charset' (not UTF-8), 'encoding' (an encoding this cannot inflate), 'corrupt' (the
 * compressed bytes did not inflate).
 *
 * Identity bodies are scanned in place. A compressed body is inflated in growing prefixes (see the
 * module header), each round's NEW output fed to the same scanner, so the scan itself never repeats.
 */
export const documentFactsOf = (
	bytes,
	{
		url = null,
		contentEncoding = null,
		contentType = null,
		scope = 'head',
		maxBytes = DEFAULT_MAX_SCAN_BYTES,
		firstInflateBytes = FIRST_INFLATE_PREFIX,
		want = HEAD_FACTS,
	} = {}
) => {
	const scanner = createDocumentFactsScanner({
		url,
		scope,
		maxBytes,
		charset: charsetOfContentType(contentType),
		want,
	});
	const encoding = encodingOf(contentEncoding);
	if (encoding === '') {
		scanner.push(bytes);
		return { ...scanner.finish(), inflatedBytes: 0, compressedBytesRead: 0 };
	}
	if (!INFLATABLE.has(encoding)) {
		return { facts: null, outcome: 'encoding', scannedBytes: 0, inflatedBytes: 0, compressedBytesRead: 0 };
	}
	let fed = 0;
	let prefix = scope === 'document' ? bytes.length : Math.min(bytes.length, Math.max(1024, firstInflateBytes));
	let inflated = 0;
	for (;;) {
		let out;
		try {
			out = inflatePrefix(encoding, prefix === bytes.length ? bytes : bytes.subarray(0, prefix));
		} catch {
			return {
				facts: null,
				outcome: 'corrupt',
				scannedBytes: fed,
				inflatedBytes: inflated,
				compressedBytesRead: prefix,
			};
		}
		inflated += out.length;
		const more = out.length > fed ? scanner.push(out.subarray(fed)) : true;
		fed = out.length;
		if (!more || prefix === bytes.length) {
			return { ...scanner.finish(), inflatedBytes: inflated, compressedBytesRead: prefix };
		}
		prefix = Math.min(bytes.length, prefix * 2);
	}
};
const INFLATABLE = new Set(['gzip', 'x-gzip', 'deflate', 'br']);

const factOrNull = (value) => (typeof value === 'string' && value !== '' ? value : null);

/**
 * Facts as STORED: `{ json, bytes, refused }`, the same contract and the same 16 KB refusal as the page
 * record `ProbeState.pageFacts` (`serializePageFacts`), so a stored document's facts and a rendered
 * page's facts are one canonical shape — equal facts store equal bytes, and the same comparators read
 * both. `itemList`, which that shape does not have, is appended in a fixed position when present.
 * `json` is null when there is nothing to store or the record is refused.
 */
export const serializeDocumentFacts = (facts) => {
	const canonical = canonicalPageFacts(facts);
	const itemList = Array.isArray(facts?.itemList)
		? facts.itemList.map((entry) =>
				Array.isArray(entry) ? [0, 1, 2, 3].map((i) => factOrNull(entry[i])) : [null, null, null, null]
			)
		: null;
	if (!canonical && !itemList) return { json: null, bytes: 0, refused: false };
	const record = itemList ? { ...(canonical ?? {}), itemList } : canonical;
	const json = JSON.stringify(record);
	const bytes = Buffer.byteLength(json, 'utf8');
	return bytes > PAGE_FACTS_MAX_BYTES ? { json: null, bytes, refused: true } : { json, bytes, refused: false };
};
