/**
 * DOCUMENT FACTS: the page-facts contract (`PageFacts`, @harperfast/prerender-browser pageFacts.ts)
 * read straight off a document's bytes — no DOM, no whole-document string, and nothing read past the
 * end of `<head>`.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────
 *
 * The plugin already holds documents: a stored raw document (util/rawCache.js), a cached snapshot it
 * is about to serve, an origin response passing through. Reading the facts a cached page is compared on
 * (canonical, title, meta description, the Product, BreadcrumbList and ItemList JSON-LD) out of those
 * bytes lets a page be checked against the origin without a render and without a DOM.
 *
 * ── WHY IT IS SHAPED LIKE THIS (measured: sitemap pages from one production origin, Node 24) ─
 *
 *   - Every fact this reads sits in `<head>`: on product pages title at 0.0%, meta description 0.1%,
 *     canonical 0.5%, Product JSON-LD 3.7%, BreadcrumbList 4.3% of the document, `</head>` at 8.0%
 *     (~20 KB of ~240 KB). The scan stops as soon as the facts it was asked for (`want`) are in hand:
 *     ~10 KB in, ~4 KB of the gzip. `<h1>` lives in the body and is never read (no claim); measured, it
 *     repeats the Product name or the title.
 *   - Decoding the whole document to a string is the expensive way, and the cost lands on everything
 *     else on the thread: those documents decode to TWO-BYTE strings, so a 280 KB body is ~560 KB of
 *     heap before a regex runs — 23 ms of GC per 1,000 documents with pauses to 7 ms, against 0.6-1.7 ms
 *     here. Only the fact slices — a few KB — are ever decoded.
 *   - Tags are found with `Buffer#indexOf` (memchr) and compared byte-wise, case-folded with `| 0x20`.
 *     A quoted attribute value is skipped with one `indexOf` for its closing quote. 12-19 µs p50 per
 *     uncompressed product page, vs 90 µs for decode + regex and 1.6 ms for htmlparser2.
 *   - A compressed body is inflated only as far as the scan needs: a PREFIX of the compressed bytes
 *     (`finishFlush: Z_SYNC_FLUSH` returns everything a truncated input decodes to), doubled until done.
 *   - SYNCHRONOUS, ON PURPOSE. Measured, a zlib stream (threadpool) or a DecompressionStream spent 67-79
 *     µs of main-thread time per document on callbacks and plumbing, more than the whole synchronous
 *     scan, and the zlib stream also takes a threadpool slot from blob reads. A caller in a loop should
 *     yield between documents.
 *
 * ── THE EXACTNESS RULE, AND WHY THE SCAN IS THE HEAD ──────────────────────────────────────────
 *
 * A fact this reports is EXACTLY what the renderer's `extractPageClaims` reads from the same bytes in
 * Chrome, or it is null. Never a near miss: a stored page record is compared with these facts, and a
 * systematic near miss disagrees on every comparison, which means re-rendering that page forever.
 *
 * The renderer's selectors pick the FIRST matching element in tree order. In the head, tree order is
 * document order, and the head precedes everything else — so the scan models the HTML parser's
 * "in head" insertion mode and stops at the first token that ends the head there: `</head>`, `<body>`,
 * `</body>`, `</html>`, `</br>`, any start tag the head does not allow (which is also every way into
 * foreign content, tables, `<plaintext>` and the rest of tree construction this does not model), or
 * non-whitespace text. A fact the head did not state is null, never "not on the page" (a later one may
 * exist). Inside `<template>` (including declarative shadow roots) nothing counts; the nesting is
 * tracked, and foreign content or `<plaintext>` inside one ends the scan.
 *
 * Everything else that cannot be read exactly is null too:
 *
 *   - CHARACTER REFERENCES are decoded exactly where that is possible without the full HTML table: every
 *     numeric form (the windows-1252 remap and the U+FFFD replacements included) and every one of the
 *     106 legacy names, with or without `;`, under the attribute rule. A named reference outside that set
 *     followed by `;` is refused (it might be in the full table).
 *   - THE CHARSET is decided the way Chrome decides it: a byte-order mark, then the response header,
 *     then a `<meta>` in the head inside Chrome's meta-charset search window. Text is decoded fully only
 *     under UTF-8; under any other ASCII-compatible charset, or none, only pure-ASCII text is read, and a
 *     non-ASCII slice is null. A JSON-LD block that cannot be decoded makes every later block unknowable,
 *     so a later block's product is never reported in its place.
 *   - THE CANONICAL is reported only when its resolution cannot depend on the base URL (a `<base>` may
 *     sit anywhere, even after the head) and it uses only characters Chrome's URL serializer and Node's
 *     agree on.
 *
 * What it does NOT see is JavaScript: the renderer reads a settled, hydrated DOM, this reads the
 * server's HTML. They agree exactly when the facts are server-rendered and hydration leaves them
 * alone, which is a property of the site, not of this code — measure it before relying on it.
 *
 * DEPENDENCY-FREE apart from node:zlib and the pure page-record helpers, and a pure function of its input.
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

const isSpace = (b) => b === 0x20 || b === 0x0a || b === 0x09 || b === 0x0c || b === 0x0d;
const isAlpha = (b) => (b | 0x20) >= 0x61 && (b | 0x20) <= 0x7a;
const endsName = (b) => isSpace(b) || b === SLASH || b === GT;

/** Do the bytes at [s, e) spell `lower` (an ASCII-lowercase literal), ASCII case-insensitively? */
const bytesEqualLower = (buf, s, e, lower) => {
	if (e - s !== lower.length) return false;
	for (let i = 0; i < lower.length; i++) {
		const b = buf[s + i];
		if ((isAlpha(b) ? b | 0x20 : b) !== lower.charCodeAt(i)) return false;
	}
	return true;
};

// Tag kinds. In the head only the ones before K_OTHER may appear; anything else ends it.
const K_TITLE = 1; // RCDATA
const K_LINK = 2;
const K_META = 3;
const K_SCRIPT = 4; // script data
const K_RAWTEXT = 5; // style, noframes, noscript (the renderer runs with scripting ON)
const K_TEMPLATE = 6; // contents are markup, inert: nothing inside counts
const K_HEAD_OTHER = 7; // base, basefont, bgsound, html, head: allowed, nothing to read
const K_OTHER = 8; // not allowed in the head
const K_RAWTEXT_BODY = 9; // xmp, iframe, noembed, textarea: raw text, but they end the head
const K_FOREIGN = 10; // svg, math
const K_PLAINTEXT = 11;
const K_BODY = 12;

/** The tag kind for the name at [s, e). Switch on length first: most names are rejected on it. */
const kindOf = (buf, s, e) => {
	switch (e - s) {
		case 3:
			if (bytesEqualLower(buf, s, e, 'xmp')) return K_RAWTEXT_BODY;
			if (bytesEqualLower(buf, s, e, 'svg')) return K_FOREIGN;
			return K_OTHER;
		case 4:
			if (bytesEqualLower(buf, s, e, 'link')) return K_LINK;
			if (bytesEqualLower(buf, s, e, 'meta')) return K_META;
			if (
				bytesEqualLower(buf, s, e, 'base') ||
				bytesEqualLower(buf, s, e, 'html') ||
				bytesEqualLower(buf, s, e, 'head')
			)
				return K_HEAD_OTHER;
			if (bytesEqualLower(buf, s, e, 'body')) return K_BODY;
			if (bytesEqualLower(buf, s, e, 'math')) return K_FOREIGN;
			return K_OTHER;
		case 5:
			if (bytesEqualLower(buf, s, e, 'title')) return K_TITLE;
			if (bytesEqualLower(buf, s, e, 'style')) return K_RAWTEXT;
			return K_OTHER;
		case 6:
			if (bytesEqualLower(buf, s, e, 'script')) return K_SCRIPT;
			if (bytesEqualLower(buf, s, e, 'iframe')) return K_RAWTEXT_BODY;
			return K_OTHER;
		case 7:
			if (bytesEqualLower(buf, s, e, 'bgsound')) return K_HEAD_OTHER;
			if (bytesEqualLower(buf, s, e, 'noembed')) return K_RAWTEXT_BODY;
			return K_OTHER;
		case 8:
			if (bytesEqualLower(buf, s, e, 'noscript') || bytesEqualLower(buf, s, e, 'noframes')) return K_RAWTEXT;
			if (bytesEqualLower(buf, s, e, 'template')) return K_TEMPLATE;
			if (bytesEqualLower(buf, s, e, 'basefont')) return K_HEAD_OTHER;
			if (bytesEqualLower(buf, s, e, 'textarea')) return K_RAWTEXT_BODY;
			return K_OTHER;
		case 9:
			return bytesEqualLower(buf, s, e, 'plaintext') ? K_PLAINTEXT : K_OTHER;
		default:
			return K_OTHER;
	}
};

/**
 * Start tags Chrome's meta-charset search treats as still "in the head" (html_meta_charset_parser.cc):
 * once any other tag has been seen AND 1024 bytes are behind it, Chrome stops looking for a charset.
 */
const CHARSET_SEARCH_TAGS = new Set(['script', 'noscript', 'style', 'link', 'meta', 'object', 'title', 'base']);

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
 * Read a tag's attributes from `i` (just past its name) to its `>`. Returns the index after the `>`,
 * or -1 when the tag does not end inside [i, end). Attribute syntax per the HTML tokenizer: a quote
 * only opens a value right after `=`, and a quoted value is skipped with one `indexOf`. End tags are
 * read the same way (their attributes are dropped, but a `>` inside a quoted one does not end them).
 * With `collect` false the attributes are skipped without being recorded.
 */
const readTag = (buf, i, end, collect) => {
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

const END_TAG_OPEN = Buffer.from('</');

/** Is there an end tag `</lower` (followed by whitespace, `/` or `>`) at `k`? Null when it runs past `end`. */
const endTagAt = (buf, k, end, lower) => {
	if (k + 2 + lower.length >= end) return null;
	return bytesEqualLower(buf, k + 2, k + 2 + lower.length, lower) && endsName(buf[k + 2 + lower.length]);
};

/**
 * Index of the `</name` that ends a raw-text / RCDATA element whose contents start at `i`, or -1 when
 * it is not inside [i, end). `</names` does not end a `name`.
 */
const findEndTag = (buf, i, end, lower) => {
	for (;;) {
		const k = buf.indexOf(END_TAG_OPEN, i);
		if (k < 0 || k >= end) return -1;
		const at = endTagAt(buf, k, end, lower);
		if (at === null) return -1;
		if (at) return k;
		i = k + 2;
	}
};

/**
 * Index of the `</script` that ends a script whose contents start at `i`, or -1 when it is not inside
 * [i, end) — with the tokenizer's ESCAPED states: after `<!--` in a script, a `<script>` enters the
 * double-escaped state, where `</script>` does NOT end the script, until `-->` or a `</script>` leaves
 * it. The common case (no `<!--`) is one `indexOf` per `<`; the escaped states walk bytes, and are rare.
 */
const findScriptEnd = (buf, i, end) => {
	let state = 0; // 0 data, 1 escaped, 2 double escaped
	let dashes = 0;
	let p = i;
	while (p < end) {
		if (state === 0) {
			const lt = buf.indexOf(LT, p);
			if (lt < 0 || lt >= end) return -1;
			if (lt + 3 >= end) return -1;
			if (buf[lt + 1] === SLASH) {
				const at = endTagAt(buf, lt, end, 'script');
				if (at === null) return -1;
				if (at) return lt;
			} else if (buf[lt + 1] === BANG && buf[lt + 2] === DASH && buf[lt + 3] === DASH) {
				state = 1;
				dashes = 2; // "script data escaped dash dash": `<!-->` closes at once
				p = lt + 4;
				continue;
			}
			p = lt + 1;
			continue;
		}
		const b = buf[p];
		if (b === DASH) {
			dashes++;
			p++;
			continue;
		}
		if (b === GT && dashes >= 2) {
			state = 0;
			dashes = 0;
			p++;
			continue;
		}
		dashes = 0;
		if (b === LT) {
			if (p + 8 >= end) return -1;
			if (buf[p + 1] === SLASH) {
				const at = endTagAt(buf, p, end, 'script');
				if (at === null) return -1;
				if (at && state === 1) return p;
				if (at && state === 2) {
					state = 1;
					p += 8;
					continue;
				}
			} else if (state === 1 && bytesEqualLower(buf, p + 1, p + 7, 'script') && endsName(buf[p + 7])) {
				state = 2;
				p += 7;
				continue;
			}
		}
		p++;
	}
	return -1;
};

/** Every byte ASCII and not ESC (0x1B, which stateful encodings use to switch planes). */
const isPlainAscii = (buf, s, e) => {
	for (let i = s; i < e; i++) {
		const b = buf[i];
		if (b > 0x7f || b === 0x1b) return false;
	}
	return true;
};

// ---- character references ---------------------------------------------------------------------

/**
 * The 106 LEGACY named references: the only ones HTML decodes without a terminating `;` (the Latin-1
 * block U+00A0-U+00FF, plus amp/lt/gt/quot and the upper-case AMP/LT/GT/QUOT/COPY/REG). Being the
 * complete set is what makes a reference WITHOUT `;` exactly decodable here.
 */
const LATIN1_NAMES = [
	'nbsp',
	'iexcl',
	'cent',
	'pound',
	'curren',
	'yen',
	'brvbar',
	'sect',
	'uml',
	'copy',
	'ordf',
	'laquo',
	'not',
	'shy',
	'reg',
	'macr',
	'deg',
	'plusmn',
	'sup2',
	'sup3',
	'acute',
	'micro',
	'para',
	'middot',
	'cedil',
	'sup1',
	'ordm',
	'raquo',
	'frac14',
	'frac12',
	'frac34',
	'iquest',
	'Agrave',
	'Aacute',
	'Acirc',
	'Atilde',
	'Auml',
	'Aring',
	'AElig',
	'Ccedil',
	'Egrave',
	'Eacute',
	'Ecirc',
	'Euml',
	'Igrave',
	'Iacute',
	'Icirc',
	'Iuml',
	'ETH',
	'Ntilde',
	'Ograve',
	'Oacute',
	'Ocirc',
	'Otilde',
	'Ouml',
	'times',
	'Oslash',
	'Ugrave',
	'Uacute',
	'Ucirc',
	'Uuml',
	'Yacute',
	'THORN',
	'szlig',
	'agrave',
	'aacute',
	'acirc',
	'atilde',
	'auml',
	'aring',
	'aelig',
	'ccedil',
	'egrave',
	'eacute',
	'ecirc',
	'euml',
	'igrave',
	'iacute',
	'icirc',
	'iuml',
	'eth',
	'ntilde',
	'ograve',
	'oacute',
	'ocirc',
	'otilde',
	'ouml',
	'divide',
	'oslash',
	'ugrave',
	'uacute',
	'ucirc',
	'uuml',
	'yacute',
	'thorn',
	'yuml',
];
const LEGACY = new Map(LATIN1_NAMES.map((name, i) => [name, String.fromCharCode(0xa0 + i)]));
for (const [name, ch] of [
	['amp', '&'],
	['AMP', '&'],
	['lt', '<'],
	['LT', '<'],
	['gt', '>'],
	['GT', '>'],
	['quot', '"'],
	['QUOT', '"'],
	['COPY', '©'],
	['REG', '®'],
])
	LEGACY.set(name, ch);
const LEGACY_MAX = Math.max(...[...LEGACY.keys()].map((name) => name.length));

/** Named references decoded only WITH `;` — common in titles; anything else named with `;` is refused. */
const WITH_SEMICOLON = new Map([
	...LEGACY,
	['apos', "'"],
	['trade', '™'],
	['hellip', '…'],
	['mdash', '—'],
	['ndash', '–'],
	['lsquo', '‘'],
	['rsquo', '’'],
	['sbquo', '‚'],
	['ldquo', '“'],
	['rdquo', '”'],
	['bdquo', '„'],
	['bull', '•'],
	['euro', '€'],
	['dagger', '†'],
	['Dagger', '‡'],
	['permil', '‰'],
	['lsaquo', '‹'],
	['rsaquo', '›'],
	['prime', '′'],
	['Prime', '″'],
	['ensp', ' '],
	['emsp', ' '],
	['thinsp', ' '],
	['zwnj', '‌'],
	['zwj', '‍'],
]);

/** The windows-1252 remap HTML applies to a NUMERIC reference in 0x80-0x9F. */
const C1_REMAP = new Map([
	[0x80, 0x20ac],
	[0x82, 0x201a],
	[0x83, 0x0192],
	[0x84, 0x201e],
	[0x85, 0x2026],
	[0x86, 0x2020],
	[0x87, 0x2021],
	[0x88, 0x02c6],
	[0x89, 0x2030],
	[0x8a, 0x0160],
	[0x8b, 0x2039],
	[0x8c, 0x0152],
	[0x8e, 0x017d],
	[0x91, 0x2018],
	[0x92, 0x2019],
	[0x93, 0x201c],
	[0x94, 0x201d],
	[0x95, 0x2022],
	[0x96, 0x2013],
	[0x97, 0x2014],
	[0x98, 0x02dc],
	[0x99, 0x2122],
	[0x9a, 0x0161],
	[0x9b, 0x203a],
	[0x9c, 0x0153],
	[0x9e, 0x017e],
	[0x9f, 0x0178],
]);

const isAlnumCode = (c) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isHexCode = (c) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);

/**
 * `s` with its character references decoded exactly as the HTML tokenizer decodes them, or null when one
 * cannot be decoded without the full named-reference table. `inAttribute` applies the attribute rule: a
 * legacy reference without `;` followed by `=` or an alphanumeric stays literal.
 */
const decodeReferences = (s, inAttribute) => {
	let amp = s.indexOf('&');
	if (amp < 0) return s;
	let out = '';
	let last = 0;
	while (amp >= 0) {
		const c = s.charCodeAt(amp + 1);
		if (c === 0x23) {
			// numeric: &#123 / &#x1F, `;` optional
			const hex = s.charCodeAt(amp + 2) === 0x78 || s.charCodeAt(amp + 2) === 0x58;
			let p = amp + (hex ? 3 : 2);
			const start = p;
			let n = 0;
			while (p < s.length && (hex ? isHexCode(s.charCodeAt(p)) : s.charCodeAt(p) >= 0x30 && s.charCodeAt(p) <= 0x39)) {
				n = n * (hex ? 16 : 10) + parseInt(s[p], 16);
				if (n > 0x10ffff) n = 0x110000; // saturate: past the range is all one answer
				p++;
			}
			if (p === start) {
				amp = s.indexOf('&', amp + 1); // `&#` with no digits is literal
				continue;
			}
			if (s.charCodeAt(p) === 0x3b) p++;
			const cp = n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff) ? 0xfffd : (C1_REMAP.get(n) ?? n);
			out += s.slice(last, amp) + String.fromCodePoint(cp);
			last = p;
			amp = s.indexOf('&', p);
			continue;
		}
		if (!isAlnumCode(c)) {
			amp = s.indexOf('&', amp + 1); // a bare `&` is literal
			continue;
		}
		let p = amp + 1;
		while (p < s.length && isAlnumCode(s.charCodeAt(p))) p++;
		const name = s.slice(amp + 1, p);
		if (s.charCodeAt(p) === 0x3b) {
			// `&name;`: exact when the name is one this decoder knows, else unknowable (the full table may have it)
			const ch = WITH_SEMICOLON.get(name);
			if (ch === undefined) return null;
			out += s.slice(last, amp) + ch;
			last = p + 1;
			amp = s.indexOf('&', last);
			continue;
		}
		// No `;` after the run: only a LEGACY name can match, as the longest prefix of the run.
		let match = null;
		for (let k = Math.min(name.length, LEGACY_MAX); k > 0; k--) {
			if (LEGACY.has(name.slice(0, k))) {
				match = name.slice(0, k);
				break;
			}
		}
		if (match === null) {
			amp = s.indexOf('&', amp + 1); // no reference here: literal
			continue;
		}
		const next = s.charCodeAt(amp + 1 + match.length);
		if (inAttribute && (next === 0x3d || isAlnumCode(next))) {
			amp = s.indexOf('&', amp + 1); // the attribute rule: left literal
			continue;
		}
		out += s.slice(last, amp) + LEGACY.get(match);
		last = amp + 1 + match.length;
		amp = s.indexOf('&', last);
	}
	return out + s.slice(last);
};

// ---- charsets -------------------------------------------------------------------------------------

const UTF8_LABELS = new Set([
	'unicode-1-1-utf-8',
	'unicode11utf8',
	'unicode20utf8',
	'utf-8',
	'utf8',
	'x-unicode20utf8',
]);
const UTF16_LABELS = new Set([
	'csunicode',
	'iso-10646-ucs-2',
	'ucs-2',
	'unicode',
	'unicodefeff',
	'utf-16',
	'utf-16le',
	'unicodefffe',
	'utf-16be',
]);
// Encodings that are not ASCII-compatible: no slice of them can be read as ASCII.
const NOT_ASCII_COMPATIBLE = new Set([
	...UTF16_LABELS,
	'csiso2022jp',
	'iso-2022-jp',
	'csiso2022kr',
	'hz-gb-2312',
	'iso-2022-cn',
	'iso-2022-cn-ext',
	'iso-2022-kr',
	'replacement',
]);

/**
 * How text decodes under a charset label: 'utf-8' (fully), 'ascii' (an ASCII-compatible charset: pure
 * ASCII only), 'refuse' (nothing readable), or null for no label. `fromMeta` applies the meta rule: a
 * `<meta>` naming UTF-16 means UTF-8.
 */
const encodingOfLabel = (label, fromMeta) => {
	if (typeof label !== 'string') return null;
	const l = label.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '').toLowerCase();
	if (l === '') return null;
	if (UTF8_LABELS.has(l) || (fromMeta && UTF16_LABELS.has(l))) return 'utf-8';
	if (NOT_ASCII_COMPATIBLE.has(l)) return 'refuse';
	return 'ascii';
};

/** `charset` from a content-type header, or null. */
export const charsetOfContentType = (contentType) => {
	const m = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(String(contentType ?? ''));
	return m ? m[1] : null;
};

// ---- the scanner ----------------------------------------------------------------------------------

const UNSEEN = Symbol('unseen');

/**
 * A scanner over a document's DECODED bytes. Feed it with `push(chunk)` (returns true while it wants
 * more) and read the result with `finish()`. Chunks may split anything — a tag, a quoted value, a
 * JSON-LD block — at any byte; bytes are accumulated in one geometrically grown buffer, so each input
 * byte is copied at most ~twice, and a single `push` of a whole document copies nothing at all.
 *
 * Options: `url` (the document's URL; unused for resolution, which never depends on it — kept for
 * diagnostics), `maxBytes` (decoded bytes to read before giving up), `charset` (the response
 * content-type's, if it named one), `want` (below).
 *
 * `want` — THE FACTS THE CALLER WILL COMPARE, and the scan's stopping rule: it stops as soon as every
 * wanted fact is settled, and reports every other fact as null. It is what makes a page type without
 * some of the facts cheap: measured, a template with no JSON-LD and ~750 KB of inline CSS in its head
 * states title, canonical and description in its first ~1 KB of gzip — but a scan that keeps looking
 * for a Product reads through all of that CSS to `</head>`. Default: every head fact. Leaving
 * `product`, `breadcrumbs` and `itemList` out also skips every JSON parse.
 */
export const createDocumentFactsScanner = ({
	maxBytes = DEFAULT_MAX_SCAN_BYTES,
	charset = null,
	want = HEAD_FACTS,
} = {}) => {
	const wanted = wantedFacts(want);
	const wantJson = wanted.product || wanted.breadcrumbs || wanted.itemList;
	let acc = null; // the accumulated bytes, when input arrived in more than one chunk
	let accLen = 0;
	let pos = 0; // first byte not yet consumed by the tokenizer
	let base = 0; // document offset of buf[0] (for Chrome's 1024-byte charset window)
	let total = 0;
	let consumed = 0;
	let done = false;
	let outcome = null;
	let reachedHeadEnd = false;
	let started = false;

	// Encoding: BOM > header > meta in the head. `null` = undetermined (pure ASCII only, like 'ascii').
	let encoding = encodingOfLabel(charset, false);
	let charsetSearchOpen = encoding === null;
	let charsetHeadSection = true;

	// Facts: UNSEEN, null (seen but unknowable or absent), or a value.
	let title = UNSEEN;
	let canonical = UNSEEN;
	let description = UNSEEN;
	let productNode = UNSEEN;
	let breadcrumbNode = UNSEEN;
	let itemListNode = UNSEEN;
	let jsonPoisoned = false;
	let blocks = 0;
	let templateDepth = 0;

	// A slice as a string, or null when its bytes cannot be decoded exactly. CR/CRLF become LF and NUL
	// becomes U+FFFD, as the input stream and the tokenizer do before anything reads them.
	const text = (buf, s, e) => {
		let out;
		if (encoding === 'utf-8') out = buf.toString('utf8', s, e);
		else if (encoding !== 'refuse' && isPlainAscii(buf, s, e)) out = buf.latin1Slice(s, e);
		else return null;
		if (out.indexOf('\r') >= 0) out = out.replace(/\r\n?/g, '\n');
		if (out.indexOf('\0') >= 0) out = out.replace(/\0/g, '�');
		return out;
	};
	/** An attribute value, references decoded: a string, '' for a valueless one, or null when unknowable. */
	const attrText = (buf, s, e) => {
		const raw = text(buf, s, e);
		return raw === null ? null : decodeReferences(raw, true);
	};
	/** An attribute value compared, ASCII case-insensitively, with `lower`: true, false, or null (unknowable). */
	const attrIs = (buf, s, e, lower) => {
		if (bytesEqualLower(buf, s, e, lower)) return true;
		const amp = buf.indexOf(0x26, s);
		// No reference in it: the bytes decide, and they did not match (nor can NUL or CR make them: neither
		// appears in the literals compared here).
		if (amp < 0 || amp >= e) return false;
		const value = attrText(buf, s, e);
		if (value === null) return null;
		return value.replace(/[A-Z]/g, (ch) => ch.toLowerCase()) === lower;
	};

	const jsonSettled = () =>
		(!wanted.product || productNode !== UNSEEN) &&
		(!wanted.breadcrumbs || breadcrumbNode !== UNSEEN) &&
		(!wanted.itemList || itemListNode !== UNSEEN);
	const satisfied = () =>
		(!wanted.title || title !== UNSEEN) &&
		(!wanted.canonical || canonical !== UNSEEN) &&
		(!wanted.metaDescription || description !== UNSEEN) &&
		jsonSettled();

	/** A JSON-LD block, in document order. Undecodable: every JSON-LD fact not yet found is unknowable. */
	const jsonBlock = (buf, s, e) => {
		blocks++;
		const raw = text(buf, s, e);
		if (raw === null) {
			jsonPoisoned = true;
			if (productNode === UNSEEN) productNode = null;
			if (breadcrumbNode === UNSEEN) breadcrumbNode = null;
			if (itemListNode === UNSEEN) itemListNode = null;
			return;
		}
		let data;
		try {
			data = JSON.parse(raw);
		} catch {
			return; // one malformed block must not cost the others — the renderer skips it too
		}
		const graph = isObject(data) ? data['@graph'] : undefined;
		const nodes = Array.isArray(data) ? data : Array.isArray(graph) ? graph : [data];
		for (const node of nodes) {
			if (!isObject(node)) continue;
			if (productNode === UNSEEN && hasType(node, PRODUCT_TYPES)) productNode = node;
			if (breadcrumbNode === UNSEEN && hasType(node, BREADCRUMB_TYPES)) breadcrumbNode = node;
			if (itemListNode === UNSEEN) {
				const list = itemListIn(node);
				if (list) itemListNode = list;
			}
		}
	};

	/** A `<meta>` in Chrome's charset window: the charset it declares, if this is the first one that does. */
	const meta = (buf) => {
		if (!charsetSearchOpen) return;
		let label = null;
		if (attrs.charsetS >= 0) label = buf.latin1Slice(attrs.charsetS, attrs.charsetE);
		else if (
			attrs.httpEquivS >= 0 &&
			attrs.contentS >= 0 &&
			bytesEqualLower(buf, attrs.httpEquivS, attrs.httpEquivE, 'content-type')
		) {
			const m = /charset\s*=\s*["']?([^"';\s]+)/i.exec(buf.latin1Slice(attrs.contentS, attrs.contentE));
			label = m ? m[1] : null;
		}
		const found = encodingOfLabel(label, true);
		if (found === null) return; // no charset, or not a label: keep looking, as Chrome does
		encoding = found;
		charsetSearchOpen = false;
	};
	/** After each tag: does Chrome's meta-charset search close here? (`name` lower-case, `afterOffset` in the document.) */
	const charsetWindow = (name, isEnd, afterOffset) => {
		if (!CHARSET_SEARCH_TAGS.has(name) && (isEnd || (name !== 'html' && name !== 'head'))) charsetHeadSection = false;
		if (!charsetHeadSection && afterOffset >= 1024) charsetSearchOpen = false;
	};

	const endHead = () => {
		reachedHeadEnd = true;
		return false;
	};
	const stopScan = () => false;

	/**
	 * Tokenize [pos, end) in the "in head" insertion mode. Returns false to stop, true when it consumed
	 * everything it could; `pos` is left at the first byte of an incomplete construct.
	 */
	const scan = (buf, end) => {
		let i = pos;
		for (;;) {
			const lt = buf.indexOf(LT, i);
			const textEnd = lt < 0 || lt >= end ? end : lt;
			// Text between tags: whitespace is allowed in the head; anything else ends it (outside a template).
			if (templateDepth === 0) {
				for (let k = i; k < textEnd; k++) {
					if (!isSpace(buf[k])) {
						pos = k;
						return endHead();
					}
				}
			}
			if (textEnd === end) {
				pos = end;
				return true;
			}
			pos = lt; // from here, anything incomplete resumes at this '<'
			// Chrome's meta-charset search ends at the first token past 1024 bytes once a tag outside its
			// head-tag set has been seen — checked per TOKEN (a long comment counts), before the token is read.
			if (charsetSearchOpen && !charsetHeadSection && base + lt >= 1024) charsetSearchOpen = false;
			if (lt + 1 >= end) return true;
			const b = buf[lt + 1];
			if (b === BANG) {
				if (lt + 3 >= end) return true;
				if (buf[lt + 2] === DASH && buf[lt + 3] === DASH) {
					// A comment: `<!-->` and `<!--->` close at once; otherwise at `-->` or `--!>`.
					if (lt + 5 >= end) return true;
					let close = -1;
					if (buf[lt + 4] === GT) close = lt + 5;
					else if (buf[lt + 4] === DASH && buf[lt + 5] === GT) close = lt + 6;
					else {
						for (let k = buf.indexOf(DASH_DASH, lt + 4); k >= 0 && k < end; k = buf.indexOf(DASH_DASH, k + 1)) {
							if (k + 3 >= end) return true;
							if (buf[k + 2] === GT) {
								close = k + 3;
								break;
							}
							if (buf[k + 2] === BANG && buf[k + 3] === GT) {
								close = k + 4;
								break;
							}
						}
					}
					if (close < 0) return true;
					i = close;
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
				while (n < end && !endsName(buf[n])) n++;
				if (n >= end) return true;
				const after = readTag(buf, n, end, false);
				if (after < 0) return true;
				const kind = kindOf(buf, lt + 2, n);
				if (charsetSearchOpen) charsetWindow(buf.latin1Slice(lt + 2, n).toLowerCase(), true, base + after);
				if (templateDepth > 0) {
					if (kind === K_TEMPLATE) templateDepth--;
				} else if (
					kind === K_BODY ||
					bytesEqualLower(buf, lt + 2, n, 'head') ||
					bytesEqualLower(buf, lt + 2, n, 'html') ||
					bytesEqualLower(buf, lt + 2, n, 'br')
				) {
					// `</head>`, and the end tags that act as "anything else": body, html, br.
					pos = lt;
					return endHead();
				}
				i = after;
				pos = i;
				continue;
			}
			if (!isAlpha(b)) {
				// A literal '<' in text: in the head that is non-whitespace text, which ends it.
				if (templateDepth === 0) return endHead();
				i = lt + 1;
				continue;
			}
			let n = lt + 2;
			while (n < end && !endsName(buf[n])) n++;
			if (n >= end) return true;
			const kind = kindOf(buf, lt + 1, n);
			const inTemplate = templateDepth > 0;
			if (
				!inTemplate &&
				(kind === K_OTHER || kind === K_BODY || kind === K_RAWTEXT_BODY || kind === K_FOREIGN || kind === K_PLAINTEXT)
			) {
				return endHead(); // a start tag the head does not allow ends it
			}
			if (inTemplate && (kind === K_FOREIGN || kind === K_PLAINTEXT)) return stopScan(); // not modelled
			const collect = !inTemplate ? kind === K_LINK || kind === K_META || kind === K_SCRIPT : kind === K_META;
			const after = readTag(buf, n, end, collect);
			if (after < 0) return true;
			if (kind === K_TEMPLATE) {
				templateDepth++;
				i = after;
			} else if (kind === K_SCRIPT) {
				const close = findScriptEnd(buf, after, end);
				if (close < 0) return true;
				if (!inTemplate && wantJson && !jsonPoisoned && !jsonSettled() && attrs.typeS >= 0) {
					const ld = attrIs(buf, attrs.typeS, attrs.typeE, LD_JSON);
					if (ld === null) {
						// A script whose type cannot be read: it may be a JSON-LD block the renderer reads.
						jsonPoisoned = true;
						if (productNode === UNSEEN) productNode = null;
						if (breadcrumbNode === UNSEEN) breadcrumbNode = null;
						if (itemListNode === UNSEEN) itemListNode = null;
					} else if (ld) jsonBlock(buf, after, close);
				}
				// Past the WHOLE end tag (it may carry attributes): what follows is head-level text again.
				const closed = readTag(buf, close + 8, end, false);
				if (closed < 0) return true;
				i = closed;
			} else if (kind === K_TITLE || kind === K_RAWTEXT || kind === K_RAWTEXT_BODY) {
				const name = buf.latin1Slice(lt + 1, n).toLowerCase();
				// Chrome's charset search may read markup inside a <noscript> that the renderer's DOM (scripting
				// on) holds as text, so a charset still undetermined here stays undetermined: ASCII only.
				if (name === 'noscript') charsetSearchOpen = false;
				const close = findEndTag(buf, after, end, name);
				if (close < 0) return true;
				if (kind === K_TITLE && !inTemplate && title === UNSEEN) {
					const raw = text(buf, after, close);
					title = raw === null ? null : decodeReferences(raw, false);
				}
				const closed = readTag(buf, close + 2 + name.length, end, false);
				if (closed < 0) return true;
				i = closed;
			} else {
				if (kind === K_META) meta(buf);
				if (!inTemplate && kind === K_LINK && canonical === UNSEEN && attrs.relS >= 0) {
					const isCanonical = attrIs(buf, attrs.relS, attrs.relE, 'canonical');
					if (isCanonical === null)
						canonical = null; // this link might be the first canonical
					else if (isCanonical)
						canonical = attrs.hrefS >= 0 ? canonicalHref(attrText(buf, attrs.hrefS, attrs.hrefE)) : null;
				} else if (!inTemplate && kind === K_META && description === UNSEEN && attrs.nameS >= 0) {
					const isDescription = attrIs(buf, attrs.nameS, attrs.nameE, 'description');
					if (isDescription === null) description = null;
					else if (isDescription)
						description = attrs.contentS >= 0 ? attrText(buf, attrs.contentS, attrs.contentE) : null;
				}
				i = after;
			}
			if (charsetSearchOpen) charsetWindow(buf.latin1Slice(lt + 1, n).toLowerCase(), false, base + i);
			pos = i;
			if (satisfied()) return stopScan();
		}
	};

	// The unfinished tail of a chunk that was scanned in place, waiting for the next chunk.
	let carry = null;

	const push = (input) => {
		if (done) return false;
		let chunk = input;
		// THE BOUND IS ON WHAT IS READ, inside a push too: a single push of a huge body reads at most `maxBytes`.
		const room = maxBytes - total;
		const capped = chunk.length > room;
		if (capped) chunk = chunk.subarray(0, Math.max(0, room));
		if (!started) {
			started = true;
			// A byte-order mark decides the encoding before anything else, and is not text.
			if (chunk.length >= 3 && chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf) {
				encoding = 'utf-8';
				charsetSearchOpen = false;
				chunk = chunk.subarray(3);
				base = 3;
			} else if (
				chunk.length >= 2 &&
				((chunk[0] === 0xfe && chunk[1] === 0xff) || (chunk[0] === 0xff && chunk[1] === 0xfe))
			) {
				encoding = 'refuse';
			}
		}
		const len = chunk.length;
		total += input.length > room ? Math.max(0, room) : input.length;
		let buf;
		if (acc === null && carry === null) {
			buf = chunk;
			pos = 0;
		} else {
			if (acc === null) {
				acc = Buffer.allocUnsafe(Math.max(64 * 1024, 2 * (carry.length + len)));
				accLen = 0;
				pos = 0;
			} else if (pos > 0 && pos >= accLen >> 1) {
				acc.copyWithin(0, pos, accLen);
				accLen -= pos;
				base += pos;
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
			buf = acc.subarray(0, accLen);
		}
		if (encoding === 'refuse') {
			done = true;
			outcome = 'charset';
			return false;
		}
		const more = scan(buf, buf.length);
		if (!more) {
			done = true;
			outcome = 'ok';
			consumed = Math.min(total, base + pos);
			return false;
		}
		if (buf === chunk && pos < len) {
			carry = chunk.subarray(pos);
			base += pos;
		} else if (buf === chunk) base += len;
		if (capped || total >= maxBytes) {
			done = true;
			outcome = 'truncated';
			return false;
		}
		return true;
	};

	/** Stop reading: the caller cannot supply the rest (an inflate that would exceed its bound). */
	const truncate = () => {
		if (done) return;
		done = true;
		outcome = 'truncated';
	};

	const finish = () => {
		if (!done) {
			// The input ended inside the head (or with no `</head>` at all): everything was read.
			done = true;
			outcome = 'ok';
			reachedHeadEnd = true;
			consumed = total;
		}
		if (outcome === 'charset' || encoding === 'refuse') {
			return { facts: null, outcome: 'charset', scannedBytes: total, blocks, reachedHeadEnd };
		}
		const settle = (value) => (value === UNSEEN ? null : value);
		const facts = assemble({
			title: settle(title),
			canonical: settle(canonical),
			description: settle(description),
			productNode: settle(productNode),
			breadcrumbNode: settle(breadcrumbNode),
			itemListNode: settle(itemListNode),
			wanted,
		});
		return { facts, outcome, scannedBytes: outcome === 'truncated' ? total : consumed, blocks, reachedHeadEnd };
	};

	return { push, finish, truncate };
};

const DASH_DASH = Buffer.from('--');

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

/**
 * `script[type="application/ld+json"]`: the type EXACTLY, ASCII case-insensitive. Not trimmed: the
 * selector does not trim, so a padded value is a block the renderer never reads.
 */
const LD_JSON = 'application/ld+json';

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
const titleOf = (raw) => (raw === null ? null : str(raw.replace(/[\t\n\f\r ]+/g, ' ').trim()));

// Characters whose URL serialization Chrome and Node agree on. Deliberately narrow: `|`, `^`, braces,
// backticks, quotes, brackets, backslashes, spaces and anything non-ASCII serialize differently (or
// depend on the document's charset), and the price of a refusal is only a canonical left uncompared.
const SAFE_URL = /^[A-Za-z0-9\-._~:/?#@!$&()*+,;=%]+$/;
const STRAY_PERCENT = /%(?![0-9A-Fa-f]{2})/;

/**
 * `link.href` for the canonical, or null. Only an href whose resolution cannot depend on the base URL
 * is reported — the document's `<base>` may sit anywhere, even after the head this scan stops at — so
 * it is resolved against two unrelated bases and kept only when both agree, and only as http(s).
 */
const canonicalHref = (href) => {
	if (href === null || href === '' || !SAFE_URL.test(href) || STRAY_PERCENT.test(href)) return null;
	const a = URL.parse(href, 'https://a.invalid/x/y?q#f');
	const b = URL.parse(href, 'http://b.invalid/');
	if (!a || !b || a.href !== b.href || !/^https?:\/\//.test(a.href)) return null;
	return str(a.href);
};

const assemble = ({ title, canonical, description, productNode, breadcrumbNode, itemListNode, wanted }) => {
	// An unwanted fact is null whether or not the scan happened to pass it, so the result depends only on
	// `want` and the document — never on where the scan stopped.
	const facts = {
		canonical: wanted.canonical ? canonical : null,
		title: wanted.title ? titleOf(title) : null,
		metaDescription: wanted.metaDescription && description !== null ? str(description) : null,
		h1: null, // in the body: never read
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

/** Everything the first `input.length` compressed bytes decode to, at most `maxOutput` bytes (else it throws). */
const inflatePrefix = (encoding, input, maxOutput) => {
	const maxOutputLength = Math.max(1, maxOutput);
	switch (encoding) {
		case 'gzip':
		case 'x-gzip':
			return zlib.gunzipSync(input, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength });
		case 'deflate':
			return zlib.inflateSync(input, { finishFlush: zlib.constants.Z_SYNC_FLUSH, maxOutputLength });
		case 'br':
			return zlib.brotliDecompressSync(input, { finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH, maxOutputLength });
		default:
			return null;
	}
};

/**
 * The facts of a WHOLE body in hand (a stored raw document, a capture, a cached snapshot): `{ facts,
 * outcome, scannedBytes, inflatedBytes, compressedBytesRead }`. Outcomes: 'ok', 'truncated' (maxBytes
 * reached first, including by an inflate that would have exceeded it), 'charset' (no text readable),
 * 'encoding' (an encoding this cannot inflate), 'corrupt' (the compressed bytes did not inflate).
 *
 * Identity bodies are scanned in place. A compressed body is inflated in growing prefixes (see the
 * module header), each round's NEW output fed to the same scanner, so the scan itself never repeats.
 */
export const documentFactsOf = (
	bytes,
	{
		contentEncoding = null,
		contentType = null,
		maxBytes = DEFAULT_MAX_SCAN_BYTES,
		firstInflateBytes = FIRST_INFLATE_PREFIX,
		want = HEAD_FACTS,
	} = {}
) => {
	const scanner = createDocumentFactsScanner({ maxBytes, charset: charsetOfContentType(contentType), want });
	const encoding = encodingOf(contentEncoding);
	if (encoding === '') {
		scanner.push(bytes);
		return { ...scanner.finish(), inflatedBytes: 0, compressedBytesRead: 0 };
	}
	if (!INFLATABLE.has(encoding)) {
		return { facts: null, outcome: 'encoding', scannedBytes: 0, inflatedBytes: 0, compressedBytesRead: 0 };
	}
	let fed = 0;
	let prefix = Math.min(bytes.length, Math.max(1024, firstInflateBytes));
	let inflated = 0;
	for (;;) {
		let out;
		try {
			out = inflatePrefix(encoding, prefix === bytes.length ? bytes : bytes.subarray(0, prefix), maxBytes);
		} catch (e) {
			if (e?.code === 'ERR_BUFFER_TOO_LARGE') {
				// More than `maxBytes` behind this prefix: what the earlier rounds fed is all that is read.
				scanner.truncate();
				return { ...scanner.finish(), inflatedBytes: inflated, compressedBytesRead: prefix };
			}
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
