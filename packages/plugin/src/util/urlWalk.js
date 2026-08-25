/**
 * A cursor-chunked walk over a URL-keyed table that survives UNREADABLE rows.
 *
 * Found in production: rows whose key attribute fails to decode. Depending on the read path, the
 * store either yields such a row with `url` missing, or silently ENDS the projected iterator at
 * it. Under the naive walk (`chunk.length < chunkSize` = end of range) that second behavior makes
 * a purge, census, or probe sweep report "finished" after covering an arbitrary fraction of the
 * range — measured stopping at 13,529 of 1.4M rows, with the operator told the walk completed.
 * Three rules repair that:
 *
 *   1. A row without a string `url` is SKIPPED and counted (`onUnreadable`), never compared or
 *      yielded — it cannot be probed, purged, or used as a cursor, but it must not end the walk
 *      when the iterator tolerates it.
 *   2. A short chunk is VERIFIED before being believed: a forward probe past the last readable
 *      key (projection-free — the tolerant read path), and if that is empty, a descending probe
 *      from the top of the range, which can prove rows remain without crossing the row the
 *      forward read chokes on.
 *   3. When rows provably remain but no readable cursor can advance the walk, it THROWS — partial
 *      coverage must surface as an error the caller records, never as a clean finish.
 *
 * `endBound` (exclusive) keeps the verification probes inside the caller's range so a row from
 * the next keyspace region can neither resume nor fail a prefix-scoped walk. Residual
 * (documented, not fixable from this layer): a range whose LAST key is itself unreadable can
 * still end a walk early when every probe path aborts on it; escalate such rows to the database
 * layer.
 */
export async function* walkUrlRange(table, { startAt, select, chunkSize, onUnreadable, endBound }) {
	let cursor = null;
	let inclusiveStart = startAt;
	let lastResume = null;

	const probeSearch = async (descending) => {
		const conditions = [{ attribute: 'url', comparator: 'greater_than', value: cursor ?? '' }];
		if (endBound) conditions.push({ attribute: 'url', comparator: 'less_than', value: endBound });
		const out = [];
		try {
			for await (const row of table.search({
				conditions,
				sort: descending ? { attribute: 'url', descending: true } : { attribute: 'url' },
				limit: 1,
			})) {
				out.push(row);
				break;
			}
		} catch {
			return null; // this probe shape is unsupported here — inconclusive, not empty
		}
		return out;
	};

	while (true) {
		const chunk = [];
		for await (const row of table.search({
			conditions: [
				{
					attribute: 'url',
					comparator: inclusiveStart !== null ? 'greater_than_equal' : 'greater_than',
					value: inclusiveStart !== null ? inclusiveStart : cursor,
				},
			],
			sort: { attribute: 'url' },
			...(select ? { select } : {}),
			limit: chunkSize,
		})) {
			chunk.push(row);
		}
		inclusiveStart = null;

		let lastReadable = null;
		for (const row of chunk) {
			if (typeof row?.url !== 'string') {
				onUnreadable?.();
				continue;
			}
			lastReadable = row.url;
			yield row;
		}
		if (lastReadable !== null) cursor = lastReadable;

		if (chunk.length >= chunkSize) continue;

		// Short chunk: either the range is exhausted, or the projected iterator gave up at a row
		// it could not read. Ask once, projection-free, from the last key we can address.
		const probe = await probeSearch(false);
		if (probe && probe.length && typeof probe[0]?.url === 'string' && probe[0].url !== cursor) {
			// The projected walk stopped early but the range continues at a readable key — resume
			// from it inclusively (if only the row's PROJECTED read breaks, resuming at it yields
			// it and nothing is lost). A repeat of the same resume key means the projected read
			// can never hand the row over: skip it exclusively, counting it, and keep walking.
			if (probe[0].url === lastResume) {
				cursor = probe[0].url;
				lastResume = null;
				onUnreadable?.();
				continue;
			}
			lastResume = probe[0].url;
			inclusiveStart = probe[0].url;
			continue;
		}
		if (probe && probe.length) break; // a row exists but its key is unreadable — provably not the end

		// Forward probe empty or unsupported. If the probe path itself aborts on the unreadable
		// row, emptiness proves nothing — read the range from the TOP: a readable key above the
		// cursor proves rows remain without touching the row the forward read chokes on.
		const top = await probeSearch(true);
		if (top && top.length && typeof top[0]?.url === 'string' && top[0].url !== cursor) break;
		return;
	}
	throw new Error(
		`url walk cannot advance past an unreadable row after ${JSON.stringify(cursor)} — ` +
			`the range was NOT fully covered; treat this pass as partial and escalate the row to the database layer`
	);
}
