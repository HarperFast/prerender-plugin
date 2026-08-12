import { config } from '../config.js';

/**
 * Read a cached page's body up front so the caller can still choose another answer (the peer
 * rescue, the origin proxy) if it is unreadable. Shared by the two readers of stored bodies:
 * the bot serve path (http_handlers/bot_request.js) and the peer-rescue endpoint
 * (http_handlers/peer_page.js) — both must discover a bad blob BEFORE committing a status.
 *
 * Returns `{ ok: true, body }` with the bytes in hand — `body` is `undefined` for HEAD, which
 * sends none, and for a page with no content at all — or `{ ok: false, reason, error? }` when
 * the blob could not be read: reason 'unreadable' (the read failed — a dangling reference,
 * harper#2134) or 'timeout' (the read outlived `budgetMs` — in practice a base copy is
 * streaming that blob right now, harper-pro#683). A non-Blob body needs no read and cannot
 * fail mid-stream, so it passes straight through (this is what keeps the unit tests'
 * plain-string fixtures working).
 *
 * Deliberately NOT deleting the record on failure: `PrerenderedPage` replicates, so a delete
 * evicts the page on every node — including peers holding a readable blob — and schedules no
 * repair, leaving the key on origin until its next scheduled render. See response.js.
 */
export async function materializeCachedBody(page, method, budgetMs = config.page.blobReadBudgetMs) {
	if (method === 'HEAD') return { ok: true, body: undefined };
	const content = page?.content;
	if (!content || typeof content.bytes !== 'function') return { ok: true, body: content ?? undefined };

	// Start the read inside the guard too: a synchronous throw here (bad internal state, a TypeError)
	// would otherwise escape every catch below and reject, turning a recoverable dangling blob into a
	// 500 for a crawler — the exact outcome the rest of this function exists to avoid.
	let read;
	try {
		read = content.bytes();
	} catch (error) {
		return { ok: false, reason: 'unreadable', error };
	}

	if (!(budgetMs > 0)) {
		try {
			return { ok: true, body: await read };
		} catch (error) {
			return { ok: false, reason: 'unreadable', error };
		}
	}

	// Bound the read. Without this the request inherits Harper's own retry window
	// (`storage_blobReadTimeout`, 20s): a blob whose bytes are still arriving puts the reader into an
	// incomplete-content retry loop and the crawler waits it out. Losing the race does NOT cancel the
	// read — `bytes()` is `readFile`-based and has no cancellation seam — but `readFile` owns and
	// closes its own descriptor, so the abandoned read finishes or times out on its own and its buffer
	// is collected. It costs a background read, never a leaked fd.
	let timer;
	const expired = Symbol('blob-read-budget');
	try {
		const result = await Promise.race([
			read,
			new Promise((resolve) => {
				timer = setTimeout(() => resolve(expired), budgetMs);
			}),
		]);
		if (result === expired) return { ok: false, reason: 'timeout' };
		return { ok: true, body: result };
	} catch (error) {
		return { ok: false, reason: 'unreadable', error };
	} finally {
		// Always clear it: an uncleared timer holds a handle for the whole budget on every served
		// request, and at serve volume that is a lot of live timers for no reason.
		clearTimeout(timer);
		// The loser of the race is still in flight on the timeout path; swallow its eventual rejection
		// so an unreadable blob cannot surface as an unhandled rejection after we already answered.
		read.catch(() => {});
	}
}
