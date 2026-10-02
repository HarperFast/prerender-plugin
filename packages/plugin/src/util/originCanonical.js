/**
 * THE CANONICAL OF A PROXIED ORIGIN DOCUMENT, into the entity registry (util/entity.js).
 *
 * On a route that sets `entityServe`, every spelling of an entity is one document (the README's experiment
 * is what a route asserts by setting it), and that document declares the entity's canonical in its head. So
 * every miss that reaches the origin on such a route is a fresh observation of where the product lives now —
 * measured on one deployment, ~11k a day from one crawler on old spellings alone — and the cheapest one this
 * plugin has: the document is already being fetched, for the crawler. This reads its canonical off the head
 * as the crawler's bytes stream by and hands it to `resolveCanonical`, which records it and adopts a
 * canonical no target holds. A re-slug of a product nobody probes or renders today is then seen by the next
 * crawler to ask for any of its spellings.
 *
 * ── WHAT IT COSTS ──────────────────────────────────────────────────────────────────────────────
 *
 * The body is TEED: the crawler's branch is untouched, and this branch reads only until the canonical (an
 * identity body is scanned as it arrives and the read stops at the `<link rel=canonical>`, ~0.5% into a
 * product page), or `TAP_MAX_BYTES`. A compressed body is collected to that bound and its prefix inflated.
 * Then this branch is cancelled — not awaited: a tee branch's cancel settles only when both branches do
 * (util/rawCache.js `collectBody`). Until it is cancelled the tee keeps for the crawler's branch whatever
 * this one read ahead of it, so a tap holds at most ~2x `TAP_MAX_BYTES`, and at most `TAP_MAX_IN_FLIGHT`
 * run at once per worker; past that a document is simply not read. Nothing here is awaited by the response.
 *
 * Only a GET answered 200 with an HTML content type, on an `entityServe` route, with the registry on.
 */

import { entitiesOn, resolveCanonical } from './entity.js';
import { charsetOfContentType, createDocumentFactsScanner, documentFactsOf } from './documentFacts.js';
import { discardStream } from './rawCache.js';

/** How far into a document a tap reads. The canonical is in the head: measured, `</head>` at ~8% of a product page. */
export const TAP_MAX_BYTES = 128 * 1024;

/** Simultaneous taps per worker. Past it a document goes by unread: the next miss for the entity reads one. */
export const TAP_MAX_IN_FLIGHT = 32;

let inFlight = 0;
/** Tests: how many taps are reading. */
export const tapsInFlight = () => inFlight;

const HTML = /^\s*text\/html\b/i;
const IDENTITY = new Set(['', 'identity']);

/** Does a proxied response for `route` and `method` get tapped at all? No I/O. */
export const tapsOriginCanonical = (route, method) =>
	method === 'GET' && route?.entityServe === true && route.entityPrefix instanceof RegExp && entitiesOn();

/**
 * Tap `resource` (a `fetchOriginResource` result) for the canonical its document declares, observed for the
 * entity `url` belongs to. Returns the resource the response should send: the same one when there is nothing
 * to read, otherwise one whose body is the crawler's branch of the tee. Never throws; the read and the registry
 * write are detached.
 */
export const tapOriginCanonical = (resource, { url, resolve = resolveCanonical }) => {
	if (resource?.statusCode !== 200 || typeof resource.content?.tee !== 'function') return resource;
	const headers = resource.headers ?? {};
	if (!HTML.test(headers['content-type'] ?? '')) return resource;
	if (inFlight >= TAP_MAX_IN_FLIGHT) return resource;
	let downstream;
	let branch;
	try {
		[downstream, branch] = resource.content.tee();
	} catch {
		return resource;
	}
	inFlight++;
	readCanonical(branch, headers)
		.then((canonical) => (canonical ? resolve({ url, value: canonical, from: 'origin' }) : null))
		.catch((e) => logger.warn?.(`[prerender] origin canonical not read for ${url}: ${e?.message ?? String(e)}`))
		// ALWAYS: a slot not returned is a permanent loss of taps on this worker.
		.finally(() => {
			inFlight--;
		});
	// `releaseBody` replaced, as the raw cache's capture does: an unsent response drains its branch instead of
	// destroying the source out from under the tap.
	return { ...resource, content: downstream, releaseBody: () => discardStream(downstream) };
};

/** The absolute canonical a document's head declares, or null. Reads at most `TAP_MAX_BYTES`. */
export const readCanonical = async (stream, headers) => {
	const contentEncoding = String(headers['content-encoding'] ?? '')
		.trim()
		.toLowerCase();
	const contentType = headers['content-type'] ?? null;
	const scanner = IDENTITY.has(contentEncoding)
		? createDocumentFactsScanner({
				maxBytes: TAP_MAX_BYTES,
				charset: charsetOfContentType(contentType),
				want: ['canonical'],
			})
		: null;
	const reader = stream.getReader();
	const chunks = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
			size += chunk.length;
			if (scanner) {
				if (!scanner.push(chunk) || size >= TAP_MAX_BYTES) break;
			} else {
				chunks.push(chunk);
				if (size >= TAP_MAX_BYTES) break;
			}
		}
	} finally {
		// NOT AWAITED (see the module header): the cancel takes effect; only the wait would be wrong.
		reader.cancel().catch(() => {});
	}
	const result = scanner
		? scanner.finish()
		: documentFactsOf(Buffer.concat(chunks, size), {
				contentEncoding,
				contentType,
				maxBytes: TAP_MAX_BYTES,
				want: ['canonical'],
			});
	const canonical = result?.facts?.canonical;
	return typeof canonical === 'string' && canonical !== '' ? canonical : null;
};
