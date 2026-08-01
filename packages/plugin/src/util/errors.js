/**
 * A one-line description of a thrown value, following its `cause` chain.
 *
 * `undici` — and therefore every `fetch` in this plugin — reports all network-level failures as
 * the single opaque word "fetch failed", putting the actual reason on `cause`: ECONNREFUSED,
 * ECONNRESET, UND_ERR_SOCKET "other side closed", a DNS ENOTFOUND, a TLS error. Logging only
 * `.message` throws the entire diagnosis away.
 *
 * That is worst exactly where it matters most here: a `failed[]` entry is the only record an
 * operator gets for a sitemap child that did not load, and "fetch failed" tells them nothing
 * about whether the origin refused the connection, hung up mid-body, or was never resolvable.
 *
 * Also unwraps `AggregateError.errors`, which is how a dual-stack connection failure arrives
 * (one ECONNREFUSED per address family) — the outer message there is empty.
 */
export const describeError = (error, { maxDepth = 5 } = {}) => {
	const parts = [];
	let current = error;

	for (let depth = 0; current !== null && current !== undefined && depth < maxDepth; depth++) {
		// `String(symbol)` is safe; `${symbol}` is what throws, so never interpolate directly.
		const message = typeof current === 'object' ? (current.message ?? String(current)) : String(current);
		const code = current.code ? ` (${current.code})` : '';
		const part = `${message}${code}`.trim();

		// Skip empties (an AggregateError often has none) and don't repeat an identical link.
		if (part && parts.at(-1) !== part) parts.push(part);

		current = current.cause ?? (Array.isArray(current.errors) ? current.errors[0] : undefined);
	}

	return parts.length ? parts.join(': ') : String(error);
};
